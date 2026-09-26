import { DurableObject } from 'cloudflare:workers';
import { verifyUser, validHostToken } from './auth.ts';
import { allowedRequest, MAX_BODY, MAX_RESPONSE, MAX_RESPONSE_FRAME, type RelayResponse } from '../shared/relay.ts';
import { buildPushPayload, cleanDisplayName, DEFAULT_PUSH_KINDS, isPushPreferenceKind, parseNotifyFrame, PUSH_KINDS, UNNAMED_HOST, utf8Length, type PushEvent, type PushKind } from '../shared/notify.ts';
import { fromB64u, loadVapidKeys, pushEndpointAllowed, sendPush, topicFor, validReceiverKeys, type PushTarget } from './push.ts';
import { isHelloV2, isPmId, parseHello, parsePmHostMoveRequest, parsePmRpc, pmHostOfflineMessage, pmRpcError, type HelloV2, type HostStatusResponse, type PmAssignment, type PmHostMoveResponse, type PmRpcResult } from '../shared/pm-state.ts';
import { PmState } from './pm-state.ts';
import { LeadState } from './leads.ts';
import {
  LEADS_ROUTE, MAX_LEAD_FRAME, MAX_LEAD_LIST, MAX_LEAD_RESULT_FRAME, SETTINGS_ROUTE, leadRpcError, parseLeadRpc, parseSettingsPost,
  type LeadRpcResult, type LeadsResponse, type SettingsPostResponse, type SettingsResponse,
} from '../shared/roles.ts';

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

export const PUSH_ROUTES: readonly string[] = ['/api/push/subscribe', '/api/push/unsubscribe', '/api/push/test'];
export const MAX_PUSH_BODY = 4096;
export const MAX_SUBSCRIPTIONS = 20;
export const MAX_DEVICE_LABEL = 60;
export const DEDUPE_WINDOW = 60 * 60_000;
export const RATE_WINDOW = 10 * 60_000;
export const RATE_LIMIT = 20;
export const TEST_LIMIT = 5;
export const OFFLINE_AFTER = 5 * 60_000;
export const CHECK_INTERVAL = 60_000;
const HOST_FRESH = 65_000;
/** 503 text while no PM host is assigned and no legacy host is connected (#122: platform-neutral). */
export const HOST_OFFLINE_MESSAGE = 'The execution host is offline. Open Foreman on it and reconnect.';
/** #144: the name of a host socket that has not said hello yet (machine-neutral; was 'Mac'). Defined in shared/notify.ts. */
export { UNNAMED_HOST };

function pushRoute(method: string, url: URL) {
  return method === 'POST' && !url.search && PUSH_ROUTES.includes(url.pathname);
}

/** Worker/DO-terminated (#26): never part of the host relay allowlist, never relayed to a host. */
export const PM_HOST_ROUTE = '/api/pm/host';
export const MAX_PM_HOST_BODY = 1024;
function pmHostRoute(method: string, url: URL) {
  return (method === 'GET' || method === 'POST') && !url.search && url.pathname === PM_HOST_ROUTE;
}

/**
 * Worker/DO-terminated (#157 CL-02, H2): the Lead registry (GET only) and the developer settings
 * (GET, and POST, the only writer of settings anywhere, including the #158 Bypass grants). Never on
 * the host relay allowlist, never relayed to a host, and answered while every host is offline.
 */
export const MAX_SETTINGS_BODY = 64 * 1024;
function leadsRoute(method: string, url: URL) {
  return method === 'GET' && !url.search && url.pathname === LEADS_ROUTE;
}
function settingsRoute(method: string, url: URL) {
  return (method === 'GET' || method === 'POST') && !url.search && url.pathname === SETTINGS_ROUTE;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/config' && request.method === 'GET') {
      const vapid = await loadVapidKeys(env.VAPID_PRIVATE_KEY);
      return json({ auth: { required: true, firebase: JSON.parse(env.FIREBASE_CONFIG) }, push: vapid ? { vapid_public_key: vapid.publicKeyB64 } : null });
    }
    if (!url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405);
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      response.headers.set('x-content-type-options', 'nosniff');
      response.headers.set('referrer-policy', 'same-origin');
      response.headers.set('content-security-policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
      return response;
    }
    const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1] ?? '';
    if (url.pathname === '/api/host/connect') {
      if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 400);
      if (!await validHostToken(token, env.HOST_TOKEN)) return json({ error: 'Unauthorized host' }, 401);
    } else {
      if (!token) return json({ error: 'Sign in with Google' }, 401);
      try { await verifyUser(token, env.FIREBASE_PROJECT_ID, env.ALLOWED_EMAIL); }
      catch { return json({ error: 'Sign in with the allowed Google account' }, 403); }
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return json({ error: 'Origin not allowed' }, 403);
      // Push routes terminate in the Durable Object: they are never part of the host relay contract.
      if (url.pathname.startsWith('/api/push/')) {
        if (!pushRoute(request.method, url)) return json({ error: 'Unknown API route' }, 404);
        if (!await loadVapidKeys(env.VAPID_PRIVATE_KEY)) return json({ error: 'Push notifications are not configured' }, 503);
      } else if (url.pathname === PM_HOST_ROUTE) {
        // The PM host record terminates in the Durable Object too, after the same identity and origin checks.
        if (!pmHostRoute(request.method, url)) return json({ error: 'Unknown API route' }, 404);
      } else if (url.pathname === LEADS_ROUTE) {
        // The Lead registry and developer settings terminate in the Durable Object too, after the
        // same identity (Firebase bearer, allowed email) and same-origin checks as every hosted route.
        if (!leadsRoute(request.method, url)) return json({ error: 'Unknown API route' }, 404);
      } else if (url.pathname === SETTINGS_ROUTE) {
        if (!settingsRoute(request.method, url)) return json({ error: 'Unknown API route' }, 404);
      } else if (!allowedRequest(request.method, url.pathname + url.search)) return json({ error: 'Unknown API route' }, 404);
    }
    // One explicitly allowlisted owner, one Durable Object (its machines are told apart inside it).
    return env.RELAY.get(env.RELAY.idFromName(env.ALLOWED_EMAIL)).fetch(request);
  },
} satisfies ExportedHandler<Env>;

type Pending = { socket: WebSocket; resolve: (response: Response) => void; timer: ReturnType<typeof setTimeout> };
// `machine_id` is set by a protocol-2 hello. A socket without it is legacy (or has not said hello
// yet): it is relayed to only while no PM host is assigned and is never recorded as the PM host.
type Attachment = { host: string; lastSeen: number; machine_id?: string };

type Subscription = PushTarget & { id: string; kinds: string[] };
type SubscriptionRow = { id: string; endpoint: string; p256dh: string; auth: string; kinds: string };
type Delivery = { sent: number; failed: number };

// Push delivery counters (#127), reported additively as `push` on GET /api/host. They are kept in
// the existing `push_state` key/value table (created with CREATE TABLE IF NOT EXISTS on a class
// that is already SQLite-backed, so no storage migration), not in memory: the relay DO hibernates
// between host frames, and in-memory counts would reset every time it is evicted. Counts are
// cumulative since the table was created. They carry no endpoints, keys or payloads — only
// integers, and for the most recent failure its HTTP status (null when no response arrived) and time.
const PUSH_COUNTERS = {
  sent: 'push_sent',                     // 2xx from the push service
  failed: 'push_failed',                 // non-2xx or no response (includes expired_removed)
  expired_removed: 'push_expired',       // 404/410: the subscription was deleted
  payloadless: 'push_payloadless',       // sent without an encrypted payload (fallback)
  invalid_notify: 'invalid_notify',      // host notify frames that failed validation
} as const;
const LAST_FAILURE = 'push_last_failure';
export interface PushCounters {
  sent: number; failed: number; expired_removed: number; payloadless: number; invalid_notify: number;
  last_failure: { status: number | null; at: string } | null;
}
export type HostStatusWithPush = HostStatusResponse & { push: PushCounters };

const SUBSCRIBE_KEYS = new Set(['subscription', 'device_label', 'kinds']);
const SUBSCRIPTION_KEYS = new Set(['endpoint', 'expirationTime', 'keys']);
const SELECT_KEYS = new Set(['id', 'endpoint']);

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, allowed: Set<string>) {
  return Object.keys(value).every((key) => allowed.has(key));
}
const badRequest = (error: string) => json({ error }, 400);

// Bounded JSON body: at most `limit` bytes, a single JSON object (an empty body reads as {}).
async function readJsonBody(request: Request, limit: number): Promise<Record<string, unknown> | Response> {
  if (Number(request.headers.get('content-length') ?? 0) > limit) return json({ error: 'Request too large' }, 413);
  let text = '';
  if (request.body) {
    const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) { await reader.cancel(); return json({ error: 'Request too large' }, 413); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); } catch { return badRequest('Invalid JSON body'); }
  }
  if (!text.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(text); } catch { return badRequest('Invalid JSON body'); }
  return plainObject(value) ? value : badRequest('Invalid JSON body');
}

export class HostRelay extends DurableObject<Env> {
  private pending = new Map<string, Pending>();
  private pm: PmState;
  private leads: LeadState;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.pm = new PmState(ctx.storage);
    this.leads = new LeadState(ctx.storage);
    // HostRelay is already a SQLite-backed class (migration v1), so these tables need no migration.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
        device_label TEXT NOT NULL, kinds TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS push_log (source TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, sent INTEGER NOT NULL, PRIMARY KEY (source, id));
      CREATE TABLE IF NOT EXISTS push_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  // ---- Host sockets ------------------------------------------------------------------------------
  // Every host socket carries the 'host' tag. Machines are told apart by the attachment's
  // `machine_id`: different machines coexist, and a machine's new hello replaces only its own
  // older socket. Relayed traffic and the offline alarm follow the *target* socket: the active PM
  // host's socket when an assignment exists, else the newest legacy socket.

  private static attachment(socket: WebSocket): Attachment | null {
    return (socket.deserializeAttachment() as Attachment | null) ?? null;
  }
  private liveSockets(except?: WebSocket, match: (state: Attachment) => boolean = () => true) {
    return this.ctx.getWebSockets('host').filter((socket) => {
      const state = HostRelay.attachment(socket);
      return socket !== except && socket.readyState === 1 && state !== null && Date.now() - state.lastSeen < HOST_FRESH && match(state);
    });
  }
  private machineSocket(machineId: string, except?: WebSocket) {
    return this.liveSockets(except, (state) => state.machine_id === machineId).at(-1);
  }
  private legacySocket(except?: WebSocket) {
    return this.liveSockets(except, (state) => !state.machine_id).at(-1);
  }
  private online(machineId: string) { return Boolean(this.machineSocket(machineId)); }
  /** The one socket relayed requests go to. */
  private hostSocket(except?: WebSocket) {
    const assignment = this.pm.assignment();
    return assignment ? this.machineSocket(assignment.machine_id, except) : this.legacySocket(except);
  }
  /** Whether `socket` belongs to the relay target (active PM host, or legacy while unassigned), regardless of freshness. */
  private isTarget(socket: WebSocket) {
    const machineId = HostRelay.attachment(socket)?.machine_id;
    const assignment = this.pm.assignment();
    return assignment ? machineId === assignment.machine_id : !machineId;
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/host/connect') {
      // Defense in depth: bindings are private, but authentication is checked here too.
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (!await validHostToken(token, this.env.HOST_TOKEN)) return json({ error: 'Unauthorized host' }, 401);
      // Nothing is replaced yet: the machine is unknown until its hello. A protocol-2 hello replaces
      // only that machine's older socket; a legacy hello keeps the old replace-all behavior.
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server!, ['host']);
      server!.serializeAttachment({ host: UNNAMED_HOST, lastSeen: Date.now() } satisfies Attachment);
      // With no PM host assigned, a (re)connected host ends any outage; the next outage may notify
      // again. Once a PM host is assigned, only that machine's hello ends its outage.
      if (!this.pm.assignment()) { this.setState('outage_since', null); this.setState('offline_notified', null); }
      await this.armOfflineCheck();
      return new Response(null, { status: 101, webSocket: client });
    }
    // Push routes are answered here, never relayed to the Mac, and work while it is offline.
    if (url.pathname.startsWith('/api/push/')) return this.pushRequest(request, url);
    // The PM host record is answered here, never relayed, and works while every host is offline.
    if (url.pathname === PM_HOST_ROUTE) return this.pmHostRequest(request, url);
    // The Lead registry and developer settings likewise (#157 CL-02).
    if (url.pathname === LEADS_ROUTE) return this.leadsRequest(request, url);
    if (url.pathname === SETTINGS_ROUTE) return this.settingsRequest(request, url);
    const offline = () => {
      const assignment = this.pm.assignment();
      return json({ error: assignment ? pmHostOfflineMessage(this.pm.machineName(assignment.machine_id)) : HOST_OFFLINE_MESSAGE }, 503);
    };
    let socket = this.hostSocket();
    if (url.pathname === '/api/host') return json({ ...this.hostStatus(socket), push: this.pushCounters() } satisfies HostStatusWithPush);
    if (!socket) return offline();
    if (this.pending.size >= 64) return json({ error: 'Host is busy; try again shortly' }, 429);
    if (!allowedRequest(request.method, url.pathname + url.search)) return json({ error: 'Unknown API route' }, 404);
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return json({ error: 'Request too large' }, 413);
    let body = '';
    if (request.body) {
      const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      while (true) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength;
        if (length > MAX_BODY) { await reader.cancel(); return json({ error: 'Request too large' }, 413); }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      body = new TextDecoder().decode(bytes);
      // #115: the PM may have moved while the body was read; route to the host that is the target now.
      socket = this.hostSocket();
      if (!socket) return offline();
      // #143: other requests may have filled the pending table while this body was read.
      if (this.pending.size >= 64) return json({ error: 'Host is busy; try again shortly' }, 429);
    }
    const id = crypto.randomUUID();
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(json({ error: 'Host response timed out; delivery is uncertain. Refresh to check the receipt before retrying.' }, 504));
      }, 45_000);
      this.pending.set(id, { socket, resolve, timer });
      try { socket.send(JSON.stringify({ type: 'request', id, method: request.method, path: url.pathname + url.search, body })); }
      catch { clearTimeout(timer); this.pending.delete(id); resolve(json({ error: 'Host disconnected; refresh before retrying' }, 503)); }
    });
  }
  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > MAX_RESPONSE_FRAME) { socket.close(1009, 'Invalid frame'); this.failPending(socket); return; }
    // An oversized lead_rpc is refused on its raw length before it is parsed.
    if (this.refuseOversizedLeadRpc(socket, raw)) return;
    let message: any;
    try { message = JSON.parse(raw); } catch { socket.close(1003, 'Invalid JSON'); this.failPending(socket); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.close(1003, 'Invalid message'); this.failPending(socket); return; }
    if (message.type === 'ping' || message.type === 'hello') {
      const previous = HostRelay.attachment(socket) ?? { host: UNNAMED_HOST, lastSeen: 0 };
      const hello = message.type === 'hello' ? parseHello(message) : null;
      if (hello && !hello.ok) { socket.close(1008, 'Invalid hello'); this.failPending(socket); return; }
      if (hello?.ok && isHelloV2(hello.value)) {
        if (!this.acceptHelloV2(socket, hello.value)) return;
      } else if (previous.machine_id) {
        // A heartbeat from an identified machine. It cannot rename or un-identify the socket.
        socket.serializeAttachment({ ...previous, lastSeen: Date.now() } satisfies Attachment);
        this.pm.touch(previous.machine_id, Date.now());
      } else {
        const host = typeof message.host === 'string' ? message.host.slice(0, 100) : previous.host;
        socket.serializeAttachment({ host, lastSeen: Date.now() } satisfies Attachment);
        if (hello) {
          this.setState('host_name', host);
          // Legacy hello: today's replace-all among legacy sockets. Identified machines stay.
          for (const other of this.ctx.getWebSockets('host')) {
            if (other === socket || HostRelay.attachment(other)?.machine_id) continue;
            this.failPending(other); other.close(1000, 'Host reconnected');
          }
        }
      }
      // A heartbeat on the relay target's socket that had gone stale ends that outage just like a
      // reconnect does, so the next outage notifies again and the periodic check resumes.
      if (this.hostSocket() === socket && (this.getState('outage_since') !== null || this.getState('offline_notified') !== null)) {
        this.setState('outage_since', null); this.setState('offline_notified', null);
        await this.armOfflineCheck();
      }
      socket.send(JSON.stringify({ type: 'pong' })); return;
    }
    if (message.type === 'notify') { try { this.acceptNotify(message); } catch {} return; }
    if (message.type === 'pm_rpc') { this.refreshHeartbeat(socket); this.acceptPmRpc(socket, message); return; }
    if (message.type === 'lead_rpc') { this.refreshHeartbeat(socket); this.acceptLeadRpc(socket, message, raw); return; }
    if (message.type !== 'response') return;
    const reply = message as RelayResponse;
    const pending = this.pending.get(reply.id);
    if (!pending || pending.socket !== socket) return;
    this.pending.delete(reply.id); clearTimeout(pending.timer);
    if (!Number.isInteger(reply.status) || reply.status < 200 || reply.status > 599 || typeof reply.body !== 'string' || new TextEncoder().encode(reply.body).byteLength > MAX_RESPONSE) {
      pending.resolve(json({ error: 'Invalid host response' }, 502)); return;
    }
    pending.resolve(new Response([204, 205, 304].includes(reply.status) ? null : reply.body, { status: reply.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }));
  }
  private failPending(socket: WebSocket) {
    for (const [id, item] of this.pending) if (item.socket === socket) {
      clearTimeout(item.timer); this.pending.delete(id);
      item.resolve(json({ error: 'Host disconnected; delivery may be uncertain. Refresh before retrying.' }, 503));
    }
  }
  async webSocketClose(socket: WebSocket) { this.failPending(socket); socket.close(); await this.hostLost(socket); }
  async webSocketError(socket: WebSocket) { this.failPending(socket); socket.close(1011, 'Connection failed'); await this.hostLost(socket); }

  // ---- Portable PM state (#26) -------------------------------------------------------------------

  private hostStatus(socket: WebSocket | undefined): HostStatusResponse {
    const assignment = this.pm.assignment();
    // #122: no host connected and no PM host assigned: no name (the app shows a platform-neutral one).
    if (!assignment) return { online: Boolean(socket), host: (socket && HostRelay.attachment(socket)?.host) ?? null, machine_id: null, standby_online: false };
    return {
      online: Boolean(socket), host: this.pm.machineName(assignment.machine_id), machine_id: assignment.machine_id,
      standby_online: this.pm.machines().some((m) => m.machine_id !== assignment.machine_id && this.online(m.machine_id)),
    };
  }

  // A protocol-2 hello: record the machine, replace only its own older socket, bootstrap the first
  // PM host, reconcile the active host's open turns, then answer with its `pm_assignment` (sent
  // before the hello's pong). False when the socket was refused and closed.
  private acceptHelloV2(socket: WebSocket, hello: HelloV2): boolean {
    const now = Date.now(), id = hello.machine_id;
    if (!this.pm.upsertMachine(id, hello.host, hello.platform, now, (machineId) => this.online(machineId))) {
      socket.close(1008, 'Too many machines'); this.failPending(socket); return false;
    }
    socket.serializeAttachment({ host: hello.host, lastSeen: now, machine_id: id } satisfies Attachment);
    for (const other of this.ctx.getWebSockets('host')) {
      if (other === socket || HostRelay.attachment(other)?.machine_id !== id) continue;
      this.failPending(other); other.close(1000, 'Host reconnected');
    }
    this.pm.bootstrapIfUnassigned(id, now);
    if (this.pm.assignment()!.machine_id === id) this.pm.reconcileRestart(id, hello.pm_open_turns);
    this.sendAssignment(socket, id);
    return true;
  }

  private assignmentFrame(machineId: string): PmAssignment {
    const assignment = this.pm.assignment();
    const active = assignment?.machine_id === machineId;
    return {
      type: 'pm_assignment', active, epoch: assignment?.epoch ?? 0,
      active_machine: assignment ? { machine_id: assignment.machine_id, host: this.pm.machineName(assignment.machine_id) } : null,
      uncertain_turns: active ? this.pm.uncertainTurns() : [],
    };
  }
  private sendAssignment(socket: WebSocket, machineId: string) {
    try { socket.send(JSON.stringify(this.assignmentFrame(machineId))); } catch {}
  }

  // #122: a pm_rpc frame proves its identified socket is alive just as a ping does: it keeps the
  // socket fresh (HOST_FRESH) and its machine's last_seen (a throttled write, see PmState.touch).
  private refreshHeartbeat(socket: WebSocket) {
    const state = HostRelay.attachment(socket);
    if (!state?.machine_id) return;
    const now = Date.now();
    socket.serializeAttachment({ ...state, lastSeen: now } satisfies Attachment);
    this.pm.touch(state.machine_id, now);
  }

  private acceptPmRpc(socket: WebSocket, message: unknown) {
    const parsed = parsePmRpc(message);
    let result: PmRpcResult | null;
    if (!parsed.ok) result = parsed.id === null ? null : pmRpcError(parsed.id, parsed.code, parsed.error);
    else {
      const machineId = HostRelay.attachment(socket)?.machine_id;
      try {
        result = machineId ? this.pm.execute(machineId, parsed.value, Date.now()) : pmRpcError(parsed.value.id, 'not_active', 'Send a protocol 2 hello before Coordinator state requests');
      } catch { result = pmRpcError(parsed.value.id, 'unavailable', 'Coordinator state storage failed'); }
    }
    if (result) try { socket.send(JSON.stringify(result)); } catch {}
  }

  // ---- Leads and developer settings (#157 CL-02) --------------------------------------------------

  /**
   * A `lead_rpc` whose raw text is over MAX_LEAD_FRAME is answered `too_large` without being
   * parsed. Recognized here: frames that open the way hosts serialize them
   * (`{"type":"lead_rpc","id":"…"`); an oversized lead_rpc with any other key order is still refused
   * on its raw byte length in acceptLeadRpc, before its arguments are validated. One that opens with
   * `"type":"lead_rpc"` but carries its `id` later (#196) goes that way too when it parses, so it is
   * answered rather than dropped; only an unparseable one with no leading id is dropped unanswered.
   */
  private refuseOversizedLeadRpc(socket: WebSocket, raw: string): boolean {
    if (raw.length <= MAX_LEAD_FRAME) return false; // UTF-16 length <= UTF-8 length: a cheap first test
    const head = /^\s*\{\s*"type"\s*:\s*"lead_rpc"\s*(?:,\s*"id"\s*:\s*"([^"\\]{1,128})")?/.exec(raw.slice(0, 256));
    if (!head || utf8Length(raw) <= MAX_LEAD_FRAME) return false;
    const id = head[1];
    if (id === undefined) {
      // The id is not the second key: parse (bounded by MAX_RESPONSE_FRAME) so acceptLeadRpc can
      // answer it. Unparseable, it has no id to answer: drop it without closing the socket.
      try { JSON.parse(raw); return false; } catch { this.refreshHeartbeat(socket); return true; }
    }
    this.refreshHeartbeat(socket);
    if (isPmId(id)) try { socket.send(JSON.stringify(leadRpcError(id, 'too_large', 'frame too large'))); } catch {}
    return true;
  }

  // Accepted from any socket that sent a protocol-2 hello (not epoch-fenced like pm_rpc); a socket
  // without one is refused `forbidden`. Answers are bounded by MAX_LEAD_RESULT_FRAME.
  private acceptLeadRpc(socket: WebSocket, message: Record<string, unknown>, raw: string) {
    const id = isPmId(message.id) ? message.id : null;
    let result: LeadRpcResult | null;
    if (utf8Length(raw) > MAX_LEAD_FRAME) result = id === null ? null : leadRpcError(id, 'too_large', 'frame too large');
    else {
      const parsed = parseLeadRpc(message);
      if (!parsed.ok) result = parsed.id === null ? null : leadRpcError(parsed.id, parsed.code, parsed.error);
      else {
        const machineId = HostRelay.attachment(socket)?.machine_id;
        try {
          result = machineId
            ? this.leads.execute(machineId, parsed.value, Date.now(), (m) => this.online(m), MAX_LEAD_RESULT_FRAME)
            : leadRpcError(parsed.value.id, 'forbidden', 'Send a protocol 2 hello before Lead requests');
        } catch { result = leadRpcError(parsed.value.id, 'unavailable', 'Lead storage failed'); }
      }
    }
    if (result) try { socket.send(JSON.stringify(result)); } catch {}
  }

  private leadsRequest(request: Request, url: URL): Response {
    if (!leadsRoute(request.method, url)) return json({ error: 'Unknown API route' }, 404);
    // Ended Leads are included (the app's Archived group). Non-ended and newest come first, so the
    // rows cut when the list would exceed MAX_LEAD_RESULT_FRAME are the oldest ended ones.
    const envelope = utf8Length(JSON.stringify({ leads: [], mode: 'relay' } satisfies LeadsResponse)) - 2;
    const leads = this.leads.list({ include_ended: true, limit: MAX_LEAD_LIST }, (m) => this.online(m), MAX_LEAD_RESULT_FRAME - envelope);
    return json({ leads, mode: 'relay' } satisfies LeadsResponse);
  }

  private async settingsRequest(request: Request, url: URL): Promise<Response> {
    if (!settingsRoute(request.method, url)) return json({ error: 'Unknown API route' }, 404);
    if (request.method === 'GET') return json({ ...this.leads.settingsView(), writable: true } satisfies SettingsResponse);
    const body = await readJsonBody(request, MAX_SETTINGS_BODY);
    if (body instanceof Response) return body;
    const parsed = parseSettingsPost(body);
    if (!parsed.ok) return badRequest(`Invalid request: ${parsed.error}`);
    const written = this.leads.writeSetting(parsed.value.key, parsed.value.value, parsed.value.version, Date.now());
    if (!written.ok) return json({ error: 'This setting changed since the page loaded. Refresh and try again.', version: written.current }, 409);
    return json({ ...written.view, writable: true } satisfies SettingsPostResponse);
  }

  private async pmHostRequest(request: Request, url: URL): Promise<Response> {
    if (!pmHostRoute(request.method, url)) return json({ error: 'Unknown API route' }, 404);
    const isOnline = (machineId: string) => this.online(machineId);
    if (request.method === 'GET') return json(this.pm.hostResponse(isOnline));
    const body = await readJsonBody(request, MAX_PM_HOST_BODY);
    if (body instanceof Response) return body;
    const parsed = parsePmHostMoveRequest(body);
    if (!parsed.ok) return badRequest(`Invalid request: ${parsed.error}`);
    const { machine_id: target, expected_epoch } = parsed.value;
    if (!this.pm.machine(target)) return json({ error: 'Unknown machine' }, 404);
    const current = this.pm.assignment();
    const name = this.pm.machineName(target);
    if ((current?.epoch ?? 0) !== expected_epoch) return json({ error: 'The Coordinator host changed since this page loaded. Refresh and try again.' }, 409);
    if (current?.machine_id === target) return badRequest(`The Coordinator already runs on ${name}.`);
    if (!isOnline(target)) return json({ error: `${name} is offline. The Coordinator can move only to an online machine.` }, 409);
    const assignment = this.pm.reassign(target, Date.now(), isOnline);
    // Every connected machine learns the new assignment; only the new host gets the uncertain turns.
    for (const socket of this.ctx.getWebSockets('host')) {
      const machineId = HostRelay.attachment(socket)?.machine_id;
      if (machineId && socket.readyState === 1) this.sendAssignment(socket, machineId);
    }
    // The new PM host is online: any outage of the old one no longer concerns the developer.
    this.setState('outage_since', null); this.setState('offline_notified', null);
    await this.armOfflineCheck();
    return json({ active: this.pm.hostActive(isOnline)!, epoch: assignment.epoch } satisfies PmHostMoveResponse);
  }

  // ---- Web Push ------------------------------------------------------------------------------

  private getState(key: string): string | null {
    return this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM push_state WHERE key = ?', key).toArray()[0]?.value ?? null;
  }
  private setState(key: string, value: string | null) {
    if (value === null) this.ctx.storage.sql.exec('DELETE FROM push_state WHERE key = ?', key);
    else this.ctx.storage.sql.exec('INSERT INTO push_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }
  // Synchronous read-then-write: nothing else runs in the DO between the two storage calls.
  private count(key: string) {
    const current = Number(this.getState(key) ?? 0);
    this.setState(key, String((Number.isSafeInteger(current) && current > 0 ? current : 0) + 1));
  }
  private pushCounters(): PushCounters {
    const read = (key: string) => { const value = Number(this.getState(key) ?? 0); return Number.isSafeInteger(value) && value > 0 ? value : 0; };
    let last_failure: PushCounters['last_failure'] = null;
    try {
      const parsed = JSON.parse(this.getState(LAST_FAILURE) ?? 'null');
      if (parsed && (parsed.status === null || Number.isInteger(parsed.status)) && typeof parsed.at === 'string') last_failure = { status: parsed.status, at: parsed.at };
    } catch {}
    return {
      sent: read(PUSH_COUNTERS.sent), failed: read(PUSH_COUNTERS.failed), expired_removed: read(PUSH_COUNTERS.expired_removed),
      payloadless: read(PUSH_COUNTERS.payloadless), invalid_notify: read(PUSH_COUNTERS.invalid_notify), last_failure,
    };
  }
  private subscriptions(): Subscription[] {
    return this.ctx.storage.sql.exec<SubscriptionRow>('SELECT id, endpoint, p256dh, auth, kinds FROM push_subscriptions ORDER BY created_at, rowid').toArray().map((row) => {
      let kinds: string[] = [];
      try { const parsed = JSON.parse(row.kinds); if (Array.isArray(parsed)) kinds = parsed.filter((kind) => typeof kind === 'string'); } catch {}
      return { id: row.id, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth, kinds };
    });
  }
  private hasOfflineSubscribers() {
    return this.subscriptions().some((subscription) => subscription.kinds.includes('host_offline'));
  }

  private async pushRequest(request: Request, url: URL): Promise<Response> {
    if (!pushRoute(request.method, url)) return json({ error: 'Unknown API route' }, 404);
    if (!await loadVapidKeys(this.env.VAPID_PRIVATE_KEY)) return json({ error: 'Push notifications are not configured' }, 503);
    const body = await readJsonBody(request, MAX_PUSH_BODY);
    if (body instanceof Response) return body;
    if (url.pathname === '/api/push/subscribe') return this.subscribe(body);
    if (url.pathname === '/api/push/unsubscribe') {
      const selected = this.select(body);
      if (selected instanceof Response) return selected;
      if (!selected) return badRequest('Provide the subscription endpoint or id');
      if (selected.match) this.ctx.storage.sql.exec('DELETE FROM push_subscriptions WHERE id = ?', selected.match.id);
      return json({ ok: true, removed: Boolean(selected.match) });
    }
    return this.sendTest(body);
  }

  // Resolves `{ id }` or `{ endpoint }` to the stored subscription it names (if any). Null when
  // the body names neither; a 400 response when it is malformed.
  private select(body: Record<string, unknown>): { match: Subscription | undefined } | null | Response {
    if (!onlyKeys(body, SELECT_KEYS) || (body.id !== undefined && body.endpoint !== undefined)) return badRequest('Unexpected fields');
    if (body.id === undefined && body.endpoint === undefined) return null;
    if (body.id !== undefined && (typeof body.id !== 'string' || body.id.length > 64)) return badRequest('Invalid subscription id');
    if (body.endpoint !== undefined && !pushEndpointAllowed(body.endpoint)) return badRequest('Unsupported push endpoint');
    return { match: this.subscriptions().find((subscription) => body.id !== undefined ? subscription.id === body.id : subscription.endpoint === body.endpoint) };
  }

  private async subscribe(body: Record<string, unknown>): Promise<Response> {
    if (!onlyKeys(body, SUBSCRIBE_KEYS)) return badRequest('Unexpected fields');
    const subscription = body.subscription;
    if (!plainObject(subscription) || !onlyKeys(subscription, SUBSCRIPTION_KEYS)) return badRequest('Invalid push subscription');
    if (subscription.expirationTime !== undefined && subscription.expirationTime !== null && typeof subscription.expirationTime !== 'number') return badRequest('Invalid push subscription');
    const { endpoint, keys } = subscription;
    if (!pushEndpointAllowed(endpoint)) return badRequest('Unsupported push endpoint');
    if (!plainObject(keys) || !onlyKeys(keys, new Set(['p256dh', 'auth'])) || !validReceiverKeys(keys.p256dh, keys.auth)) return badRequest('Invalid subscription keys');
    const p256dh = keys.p256dh as string, auth = keys.auth as string;
    // The receiver key must be a real P-256 point, or every later encryption would fail.
    try { await crypto.subtle.importKey('raw', fromB64u(p256dh)!, { name: 'ECDH', namedCurve: 'P-256' }, false, []); }
    catch { return badRequest('Invalid subscription keys'); }
    if (body.device_label !== undefined && (typeof body.device_label !== 'string' || body.device_label.length > 500)) return badRequest('Invalid device label');
    const label = cleanDisplayName(typeof body.device_label === 'string' ? body.device_label : '', MAX_DEVICE_LABEL);
    let kinds: string[] = [...DEFAULT_PUSH_KINDS];
    if (body.kinds !== undefined) {
      if (!Array.isArray(body.kinds) || body.kinds.length > PUSH_KINDS.length || !body.kinds.every(isPushPreferenceKind)) return badRequest('Invalid notification kinds');
      kinds = PUSH_KINDS.filter((kind) => (body.kinds as string[]).includes(kind));
    }
    const sql = this.ctx.storage.sql;
    const existing = sql.exec<{ id: string }>('SELECT id FROM push_subscriptions WHERE endpoint = ?', endpoint).toArray()[0];
    const id = existing?.id ?? crypto.randomUUID();
    if (existing) sql.exec('UPDATE push_subscriptions SET p256dh = ?, auth = ?, device_label = ?, kinds = ? WHERE id = ?', p256dh, auth, label, JSON.stringify(kinds), id);
    else {
      sql.exec('INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, device_label, kinds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, endpoint, p256dh, auth, label, JSON.stringify(kinds), Date.now());
      // Oldest subscriptions are evicted beyond the per-owner cap.
      sql.exec('DELETE FROM push_subscriptions WHERE id NOT IN (SELECT id FROM push_subscriptions ORDER BY created_at DESC, rowid DESC LIMIT ?)', MAX_SUBSCRIPTIONS);
    }
    await this.armOfflineCheck();
    return json({ ok: true, id });
  }

  private async sendTest(body: Record<string, unknown>): Promise<Response> {
    const selected = this.select(body);
    if (selected instanceof Response) return selected;
    if (selected && !selected.match) return json({ error: 'Push subscription not found' }, 404);
    const targets = selected?.match ? [selected.match] : this.subscriptions();
    if (!targets.length) return json({ error: 'No push subscription' }, 404);
    const now = Date.now();
    this.ctx.storage.sql.exec('DELETE FROM push_log WHERE at < ?', now - DEDUPE_WINDOW);
    const recent = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM push_log WHERE source = 'test' AND at > ?", now - RATE_WINDOW).one().count;
    if (recent >= TEST_LIMIT) return json({ error: 'Too many test notifications; try again later' }, 429);
    this.ctx.storage.sql.exec("INSERT INTO push_log (source, id, at, sent) VALUES ('test', ?, ?, 1)", crypto.randomUUID(), now);
    const result = await this.deliver({ kind: 'test', host: this.hostName(), at: new Date(now).toISOString() }, 'test', targets);
    return json({ ok: true, ...result });
  }

  private hostName() {
    const assignment = this.pm.assignment();
    if (assignment) return this.pm.machineName(assignment.machine_id);
    return (this.hostSocket()?.deserializeAttachment() as Attachment | undefined)?.host ?? this.getState('host_name') ?? UNNAMED_HOST;
  }

  // Host -> relay notify frame. Validation, de-duplication and rate limiting are synchronous
  // storage operations; delivery runs in the background so the relay loop is never blocked and
  // push failures can never affect request relaying.
  private acceptNotify(message: unknown) {
    const frame = parseNotifyFrame(message);
    if (!frame) { this.count(PUSH_COUNTERS.invalid_notify); return; }
    const sql = this.ctx.storage.sql, now = Date.now();
    sql.exec('DELETE FROM push_log WHERE at < ?', now - DEDUPE_WINDOW);
    if (sql.exec("SELECT 1 FROM push_log WHERE source = 'notify' AND id = ?", frame.id).toArray().length) return;
    const recent = sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM push_log WHERE source = 'notify' AND sent = 1 AND at > ?", now - RATE_WINDOW).one().count;
    const allowed = recent < RATE_LIMIT;
    // Idempotent: if the id is already logged, nothing is inserted and nothing is sent.
    const inserted = sql.exec("INSERT INTO push_log (source, id, at, sent) VALUES ('notify', ?, ?, ?) ON CONFLICT (source, id) DO NOTHING RETURNING id", frame.id, now, allowed ? 1 : 0).toArray().length;
    if (inserted && allowed) this.ctx.waitUntil(this.deliver(frame, frame.kind).catch(() => {}));
  }

  // Renders once with the shared renderer, then encrypts and sends per subscription. A 404/410
  // from the push service means the subscription is gone: delete it.
  private async deliver(event: PushEvent, kind: PushKind, targets?: Subscription[]): Promise<Delivery> {
    const vapid = await loadVapidKeys(this.env.VAPID_PRIVATE_KEY);
    if (!vapid) return { sent: 0, failed: 0 };
    const payload = buildPushPayload(event);
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const topic = await topicFor(payload.tag);
    const recipients = targets ?? this.subscriptions().filter((subscription) => kind === 'test' || subscription.kinds.includes(kind));
    const outcomes = await Promise.all(recipients.map(async (subscription) => {
      let status: number | null = null;
      try {
        const result = await sendPush(subscription, bytes, { vapid, subject: `mailto:${this.env.ALLOWED_EMAIL}`, topic });
        status = result.status;
        if (result.payloadless) this.count(PUSH_COUNTERS.payloadless);
        if (status === 404 || status === 410) {
          this.ctx.storage.sql.exec('DELETE FROM push_subscriptions WHERE id = ?', subscription.id);
          this.count(PUSH_COUNTERS.expired_removed);
        }
      } catch {}
      const ok = status !== null && status >= 200 && status < 300;
      if (ok) this.count(PUSH_COUNTERS.sent);
      else {
        this.count(PUSH_COUNTERS.failed);
        this.setState(LAST_FAILURE, JSON.stringify({ status, at: new Date().toISOString() }));
      }
      return ok;
    }));
    const sent = outcomes.filter(Boolean).length;
    return { sent, failed: outcomes.length - sent };
  }

  // ---- Mac offline -----------------------------------------------------------------------------
  // Keyed on the relay target (#26): the active PM host's socket, or the legacy socket while no PM
  // host is assigned. Standby machines never start or end an outage.
  // State: `outage_since` (ms) while no live host socket exists, `offline_notified` once the one
  // notification for that outage went out. The alarm only runs while someone wants host_offline:
  // every CHECK_INTERVAL while a host is connected (catching a silently stale socket), then once
  // at the 5-minute mark of an outage. It stops after notifying until a host reconnects or a stale
  // socket heartbeats again.

  private async scheduleAt(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  private async armOfflineCheck() {
    if (!this.hasOfflineSubscribers()) return;
    const now = Date.now();
    if (this.hostSocket()) return this.scheduleAt(now + CHECK_INTERVAL);
    if (this.getState('offline_notified')) return;
    const recorded = Number(this.getState('outage_since') ?? NaN);
    const since = Number.isFinite(recorded) ? recorded : this.silentSince(now);
    this.setState('outage_since', String(since));
    return this.scheduleAt(since + OFFLINE_AFTER);
  }

  // When an outage has no recorded start, it began at the relay target's last heartbeat (a socket
  // that went silent without closing), not "now": otherwise subscribing while the host socket is
  // stale-but-open would push the offline alert back by up to the staleness window (~65 s). With
  // no such socket at all, nothing better than `now` is known.
  private silentSince(now: number) {
    const seen = this.ctx.getWebSockets('host').filter((socket) => this.isTarget(socket)).map((socket) => HostRelay.attachment(socket)?.lastSeen ?? 0);
    return Math.min(now, Math.max(0, ...seen) || now);
  }

  // Only the relay target's socket matters: a standby machine going away is not an outage.
  private async hostLost(socket: WebSocket) {
    if (!this.isTarget(socket) || this.hostSocket(socket)) return;
    if (!this.getState('outage_since')) this.setState('outage_since', String(Date.now()));
    await this.armOfflineCheck();
  }

  async alarm() {
    if (!this.hasOfflineSubscribers()) return;
    const now = Date.now();
    if (this.hostSocket()) {
      this.setState('outage_since', null); this.setState('offline_notified', null);
      await this.ctx.storage.setAlarm(now + CHECK_INTERVAL);
      return;
    }
    if (this.getState('offline_notified')) return;
    let since = Number(this.getState('outage_since') ?? NaN);
    if (!Number.isFinite(since)) {
      since = this.silentSince(now);
      this.setState('outage_since', String(since));
    }
    if (now - since < OFFLINE_AFTER) { await this.ctx.storage.setAlarm(since + OFFLINE_AFTER); return; }
    this.setState('offline_notified', '1');
    await this.deliver({ kind: 'host_offline', host: this.hostName(), at: new Date(now).toISOString() }, 'host_offline');
  }
}
