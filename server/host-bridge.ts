import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { FOREMAN_HOME, HOST } from './paths.ts';
import { allowedRequest, MAX_BODY, MAX_RESPONSE, MAX_REQUEST_FRAME, type RelayRequest } from '../shared/relay.ts';
import { parseNotifyFrame, utf8Length, type NotifyFrame } from '../shared/notify.ts';
import {
  MAX_OPEN_TURNS, MAX_PM_FRAME, MAX_PM_IMPORT_FRAME, MAX_PM_RESULT_FRAME,
  isPmId, parseHello, parsePmAssignment, parsePmOpArgs, parsePmOpResult, parsePmRpcResult,
  type HelloV2, type MachineIdentity, type PmAssignment, type PmErrorCode, type PmOp, type PmOpArgs, type PmOpResults,
} from '../shared/pm-state.ts';
import { redactSecrets } from '../shared/redact.ts';

// Frames held while the relay socket is down: at most this many, none older than this. The relay
// de-duplicates by frame id, so flushing a frame that also went out before a drop is harmless.
export const NOTIFY_QUEUE_LIMIT = 20;
export const NOTIFY_QUEUE_MAX_AGE_MS = 5 * 60_000;

/** Default per-call timeout for `rpc` (epic #26). */
export const PM_RPC_TIMEOUT_MS = 10_000;
/** At most this many PM rpcs outstanding at once. */
export const PM_RPC_MAX_PENDING = 256;

/**
 * Why a PM rpc failed: a DO error code, or a host-side cause. `disconnected` = no relay socket (or
 * it closed before the reply); `timeout` = no reply within the per-call timeout; `invalid_result` =
 * the DO's reply failed the shared contract. After `disconnected` or `timeout` the DO may or may not
 * have applied the op.
 */
export type PmRpcFailure = PmErrorCode | 'disconnected' | 'timeout' | 'invalid_result';

export class PmRpcError extends Error {
  readonly code: PmRpcFailure;
  readonly op: PmOp;
  readonly epoch: number;
  constructor(code: PmRpcFailure, op: PmOp, epoch: number, message: string) {
    super(message); this.name = 'PmRpcError'; this.code = code; this.op = op; this.epoch = epoch;
  }
}

export interface PmRpcOptions { epoch?: number; timeoutMs?: number }

/** Bridge options. All optional: without `identity` the bridge sends today's legacy hello and has no PM rpc. */
export interface HostBridgeOptions {
  localToken?: string;
  socketFactory?: (url: URL, options: WebSocket.ClientOptions) => WebSocket;
  /** This FOREMAN_HOME's machine identity (server/machine.ts). Present ⇒ protocol-v2 hello. */
  identity?: MachineIdentity;
  /** Turn ids this host's PM still holds, sent as `pm_open_turns` in every v2 hello (called on each connect). */
  pmOpenTurns?: () => readonly string[];
  /** Default per-call timeout for `rpc` (10 s). */
  rpcTimeoutMs?: number;
  /** Defaults to process.platform. */
  platform?: string;
}

interface PendingRpc {
  op: PmOp; epoch: number; socket: WebSocket; timer: NodeJS.Timeout;
  resolve: (value: any) => void; reject: (error: PmRpcError) => void;
}

export interface BridgeConfig { url: string; token: string }
export function readBridgeConfig(): BridgeConfig | null {
  if (Boolean(process.env.FOREMAN_RELAY_URL) !== Boolean(process.env.FOREMAN_HOST_TOKEN)) throw new Error('Set both FOREMAN_RELAY_URL and FOREMAN_HOST_TOKEN');
  if (process.env.FOREMAN_RELAY_URL && process.env.FOREMAN_HOST_TOKEN) return { url: process.env.FOREMAN_RELAY_URL, token: process.env.FOREMAN_HOST_TOKEN };
  const path = join(FOREMAN_HOME, 'cloud.json');
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('cloud.json must be an owned regular file with mode 0600');
  let config;
  try { config = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Invalid cloud.json'); }
  if (!config || typeof config.url !== 'string' || typeof config.token !== 'string') throw new Error('Invalid cloud.json');
  return config;
}

export class HostBridge {
  private socket?: WebSocket;
  private reconnect?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private stopped = false;
  private started = false;
  private attempts = 0;
  private lastPong = 0;
  private inFlight = 0;
  private notifyQueue: { raw: string; kind: string; queuedAt: number }[] = [];
  private port: number;
  private config: BridgeConfig;
  private localToken?: string;
  private socketFactory: (url: URL, options: WebSocket.ClientOptions) => WebSocket;
  private identity?: MachineIdentity;
  private platform: string;
  private pmOpenTurns?: () => readonly string[];
  private rpcTimeoutMs: number;
  private pending = new Map<string, PendingRpc>();
  private rpcSeq = 0;
  private helloSocket?: WebSocket;
  private assignment: PmAssignment | null = null;
  private assignmentListeners = new Set<(assignment: PmAssignment) => void>();
  private connectionListeners = new Set<(connected: boolean) => void>();
  constructor(port: number, config: BridgeConfig, options: HostBridgeOptions = {}) {
    this.port = port; this.config = config; this.localToken = options.localToken;
    this.socketFactory = options.socketFactory ?? ((url, options) => new WebSocket(url, options));
    this.identity = options.identity; this.pmOpenTurns = options.pmOpenTurns;
    this.platform = options.platform ?? process.platform;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? PM_RPC_TIMEOUT_MS;
    const url = new URL(config.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Relay URL must be an HTTPS origin');
    if (typeof config.token !== 'string' || config.token.length < 32 || config.token.length > 512 || /\s/.test(config.token)) throw new Error('Invalid host token');
  }
  /** 2 when this bridge speaks the portable-PM protocol (an identity was given), else 1 (legacy hello). */
  get protocol(): 1 | 2 { return this.identity ? 2 : 1; }
  /** The relay socket is open and this bridge's hello went out on it. */
  get connected(): boolean { return this.helloSocket !== undefined && this.helloSocket === this.socket && this.socket.readyState === WebSocket.OPEN; }
  /** The latest valid `pm_assignment` on the current connection, or null (disconnected, or none received yet). */
  currentAssignment(): PmAssignment | null { return this.assignment; }
  /** Every valid `pm_assignment` frame (the DO sends one after each v2 hello and on reassignment). Returns an unsubscribe. */
  onAssignment(listener: (assignment: PmAssignment) => void): () => void {
    this.assignmentListeners.add(listener); return () => { this.assignmentListeners.delete(listener); };
  }
  /** `true` after each open + hello, `false` when that socket closes. Returns an unsubscribe. */
  onConnection(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener); return () => { this.connectionListeners.delete(listener); };
  }
  start() { if (!this.started && !this.stopped) { this.started = true; this.connect(); } return this; }
  private connect() {
    if (this.stopped) return;
    const url = new URL('/api/host/connect', this.config.url); url.protocol = 'wss:';
    // A v2 socket also carries DO→host PM results (≤ MAX_PM_RESULT_FRAME, above MAX_REQUEST_FRAME).
    // Relayed request frames keep MAX_REQUEST_FRAME, enforced in the message handler.
    const maxPayload = this.identity ? Math.max(MAX_REQUEST_FRAME, MAX_PM_RESULT_FRAME) : MAX_REQUEST_FRAME;
    const socket = this.socket = this.socketFactory(url, { headers: { authorization: `Bearer ${this.config.token}` }, maxPayload, handshakeTimeout: 15_000 });
    socket.on('open', () => {
      this.attempts = 0; this.lastPong = Date.now();
      console.log('foreman: cloud relay connected');
      socket.send(JSON.stringify(this.hello()));
      this.helloSocket = socket; this.assignment = null;
      this.flushNotify(socket);
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastPong > 60_000) { socket.terminate(); return; }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
      }, 20_000);
      this.emitConnection(true);
    });
    socket.on('message', (raw, binary) => {
      if (binary) { socket.close(1003, 'Text required'); return; }
      const text = raw.toString();
      let message: any;
      try { message = JSON.parse(text); } catch { socket.close(1003, 'Invalid JSON'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.close(1003, 'Invalid message'); return; }
      if (message.type === 'pong') { this.lastPong = Date.now(); return; }
      if (message.type === 'request') {
        if (Buffer.byteLength(text) > MAX_REQUEST_FRAME) { socket.close(1009, 'Frame too large'); return; }
        void this.handle(message, socket).catch(() => socket.close(1011, 'Relay failed'));
        return;
      }
      if (message.type === 'pm_rpc_result') { this.handleRpcResult(message); return; }
      if (message.type === 'pm_assignment' && socket === this.helloSocket) this.handleAssignment(message);
    });
    socket.on('error', () => { /* close schedules reconnect; never log credentials/handshake headers */ });
    socket.on('close', () => {
      clearInterval(this.heartbeat);
      this.dropSocket(socket);
      if (this.stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5)) + Math.random() * 1000;
      this.reconnect = setTimeout(() => this.connect(), delay);
    });
  }
  private async handle(message: RelayRequest, socket: WebSocket) {
    const reply = (status: number, body: string) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'response', id: message.id, status, body }));
    };
    if (typeof message.id !== 'string' || message.id.length > 100) { socket.close(1003, 'Invalid request'); return; }
    if (!allowedRequest(message.method, message.path) || (message.body !== undefined && typeof message.body !== 'string') ||
        Buffer.byteLength(message.body ?? '') > MAX_BODY) { reply(400, JSON.stringify({ error: 'Invalid relay request' })); return; }
    if (this.inFlight >= 64) { reply(429, JSON.stringify({ error: 'Host is busy' })); return; }
    this.inFlight++;
    try {
      const origin = `http://127.0.0.1:${this.port}`;
      const response = await fetch(origin + message.path, {
        method: message.method,
        headers: { 'content-type': 'application/json', origin, ...(this.localToken ? { authorization: `Bearer ${this.localToken}` } : {}) },
        ...(message.method === 'POST' ? { body: message.body || '{}' } : {}),
        redirect: 'error', signal: AbortSignal.timeout(40_000),
      });
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (reader) while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error('Response too large'); }
        chunks.push(value);
      }
      reply(response.status, Buffer.concat(chunks).toString('utf8'));
    } catch { reply(502, JSON.stringify({ error: 'Local host request failed; refresh to check whether work was accepted before retrying.' })); }
    finally { this.inFlight--; }
  }
  // Send one notify frame to the relay, or hold it until the next open. Validated with the shared
  // contract first; an invalid frame is dropped. Never throws, and never logs more than the kind.
  notify(frame: NotifyFrame): void {
    try {
      if (this.stopped) return;
      const valid = parseNotifyFrame(frame);
      if (!valid) { console.error('foreman: dropped invalid notify frame'); return; }
      const entry = { raw: JSON.stringify(valid), kind: valid.kind, queuedAt: Date.now() };
      const socket = this.socket;
      if (socket && socket.readyState === WebSocket.OPEN && this.sendNotify(socket, entry)) return;
      this.pruneNotify();
      this.notifyQueue.push(entry);
      if (this.notifyQueue.length > NOTIFY_QUEUE_LIMIT) this.notifyQueue.splice(0, this.notifyQueue.length - NOTIFY_QUEUE_LIMIT);
    } catch {
      console.error('foreman: notify failed');
    }
  }
  private sendNotify(socket: WebSocket, entry: { raw: string; kind: string }): boolean {
    try { socket.send(entry.raw); return true; }
    catch { console.error('foreman: notify send failed', JSON.stringify({ kind: entry.kind })); return false; }
  }
  private pruneNotify() {
    const cutoff = Date.now() - NOTIFY_QUEUE_MAX_AGE_MS;
    this.notifyQueue = this.notifyQueue.filter((entry) => entry.queuedAt >= cutoff);
  }
  private flushNotify(socket: WebSocket) {
    this.pruneNotify();
    while (this.notifyQueue.length && socket.readyState === WebSocket.OPEN) {
      if (!this.sendNotify(socket, this.notifyQueue[0]!)) return;
      this.notifyQueue.shift();
    }
  }

  // --- Portable PM (epic #26): hello v2, pm_rpc, pm_assignment ---------------------------------

  private hello(): HelloV2 | { type: 'hello'; host: string } {
    if (!this.identity) return { type: 'hello', host: HOST };
    let turns: string[] = [];
    try {
      const provided = [...(this.pmOpenTurns?.() ?? [])];
      turns = [...new Set(provided.filter((id) => isPmId(id)))].slice(0, MAX_OPEN_TURNS);
      if (turns.length !== provided.length) console.error('foreman: pm_open_turns trimmed to valid unique ids', JSON.stringify({ provided: provided.length, sent: turns.length }));
    } catch { console.error('foreman: pm_open_turns provider failed; sending none'); }
    const parsed = parseHello({ type: 'hello', protocol: 2, machine_id: this.identity.machine_id, host: this.identity.name, platform: this.platform, pm_open_turns: turns });
    if (!parsed.ok) throw new Error(`Invalid hello: ${parsed.error}`);
    return parsed.value as HelloV2;
  }
  private emitConnection(connected: boolean) {
    for (const listener of [...this.connectionListeners]) {
      try { listener(connected); } catch { console.error('foreman: relay connection listener failed'); }
    }
  }
  // A closed socket fails its outstanding rpcs (`disconnected`) and, if it was the live one, marks
  // the bridge disconnected and forgets the assignment: a host that cannot see the DO is not the PM.
  private dropSocket(socket: WebSocket) {
    for (const [id, call] of this.pending) {
      if (call.socket !== socket) continue;
      this.pending.delete(id); clearTimeout(call.timer);
      call.reject(new PmRpcError('disconnected', call.op, call.epoch, 'The cloud relay connection closed before the PM state store answered.'));
    }
    if (this.helloSocket !== socket) return;
    this.helloSocket = undefined; this.assignment = null;
    this.emitConnection(false);
  }
  private handleAssignment(raw: unknown) {
    const parsed = parsePmAssignment(raw);
    if (!parsed.ok) { console.error('foreman: dropped invalid pm_assignment frame'); return; }
    this.assignment = parsed.value;
    for (const listener of [...this.assignmentListeners]) {
      try { listener(parsed.value); } catch { console.error('foreman: pm_assignment listener failed'); }
    }
  }
  private handleRpcResult(raw: { id?: unknown }) {
    const id = typeof raw.id === 'string' ? raw.id : undefined;
    const call = id === undefined ? undefined : this.pending.get(id);
    // A reply whose id is not pending (it timed out, or belongs to another socket) is ignored.
    if (!call || id === undefined) return;
    this.pending.delete(id); clearTimeout(call.timer);
    const invalid = () => new PmRpcError('invalid_result', call.op, call.epoch, `The relay's reply to ${call.op} was invalid.`);
    const parsed = parsePmRpcResult(raw);
    if (!parsed.ok) { call.reject(invalid()); return; }
    const result = parsed.value;
    // The DO already redacts its messages; redact again here since the text can reach the user.
    if (!result.ok) { call.reject(new PmRpcError(result.code, call.op, call.epoch, redactSecrets(result.message))); return; }
    const value = parsePmOpResult(call.op, result.result);
    if (!value.ok) { call.reject(invalid()); return; }
    call.resolve(value.value);
  }
  /**
   * Sends one `pm_rpc` and resolves with the op's validated result. Rejects with a `PmRpcError`:
   * the DO's error code; `disconnected` (no open socket, or it closed first); `timeout` (no reply in
   * `timeoutMs`, default 10 s); `invalid`/`too_large` (args or frame fail the shared contract, and
   * nothing is sent); `invalid_result`. `epoch` defaults to the current assignment's epoch.
   * Never retried here: the caller decides.
   */
  rpc<O extends PmOp>(op: O, args: PmOpArgs[O], options: PmRpcOptions = {}): Promise<PmOpResults[O]> {
    const epoch = options.epoch ?? this.assignment?.epoch ?? 0;
    const fail = (code: PmRpcFailure, message: string) => Promise.reject(new PmRpcError(code, op, epoch, message));
    if (!this.identity) return fail('unavailable', 'This host bridge was started without a machine identity.');
    const checked = parsePmOpArgs(op, args);
    if (!checked.ok) return fail(checked.code, checked.error);
    const socket = this.socket;
    if (this.stopped || !socket || !this.connected) return fail('disconnected', 'The cloud relay is not connected.');
    if (this.pending.size >= PM_RPC_MAX_PENDING) return fail('unavailable', 'Too many PM state requests are outstanding.');
    const id = `rpc-${Date.now().toString(36)}-${(++this.rpcSeq).toString(36)}`;
    const raw = JSON.stringify({ type: 'pm_rpc', id, epoch, op, args: checked.value });
    if (utf8Length(raw) > (op === 'memory.import' ? MAX_PM_IMPORT_FRAME : MAX_PM_FRAME)) return fail('too_large', `${op} frame is too large`);
    const timeoutMs = options.timeoutMs ?? this.rpcTimeoutMs;
    return new Promise<PmOpResults[O]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new PmRpcError('timeout', op, epoch, `The PM state store did not answer ${op} within ${Math.ceil(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.pending.set(id, { op, epoch, socket, timer, resolve, reject });
      try { socket.send(raw); }
      catch {
        this.pending.delete(id); clearTimeout(timer);
        reject(new PmRpcError('disconnected', op, epoch, 'Sending to the cloud relay failed.'));
      }
    });
  }
  close() {
    this.stopped = true; this.notifyQueue = []; clearTimeout(this.reconnect); clearInterval(this.heartbeat);
    const socket = this.socket;
    socket?.close(1000, 'Host stopping');
    if (socket) this.dropSocket(socket);
  }
}

// Existing callers keep `{ close() }`; `notify` is present only when a relay is configured, so its
// presence is how callers tell cloud mode from local-only mode. Passing `options` with an
// `identity` (PMM-05) makes the bridge speak protocol v2; `bridge` is then the HostBridge a
// RelayPmStore is built on. Without options the behavior is exactly the pre-#26 one.
export function startHostBridge(port: number, localToken?: string, options: Omit<HostBridgeOptions, 'localToken' | 'socketFactory'> = {}): { close(): void; notify?: (frame: NotifyFrame) => void; bridge?: HostBridge } {
  try {
    const config = readBridgeConfig();
    if (!config) return { close() {} };
    const bridge = new HostBridge(port, config, { ...options, localToken }).start();
    return { close: () => bridge.close(), notify: (frame: NotifyFrame) => bridge.notify(frame), bridge };
  }
  catch (error) { console.error('foreman: cloud bridge configuration error:', (error as Error).message); return { close() {} }; }
}
