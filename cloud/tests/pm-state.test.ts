// Portable PM state in the relay Durable Object (#26, PMM-02 #80), exercised through the real
// Worker and HostRelay with real WebSocket pairs. Most tests connect TWO protocol-2 hosts at once
// ("machine-a" and "machine-b") so they stand in for the two-machine manual checkpoint: routing to
// the active host only, epoch fencing, reassignment, and the uncertain-turn reconciliation.
import { env, exports } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { MAX_PM_HOST_BODY, OFFLINE_AFTER, type HostRelay } from '../worker.ts';
import { MAX_UNCERTAIN_TURNS } from '../pm-state.ts';
import { allowedRequest } from '../../shared/relay.ts';
import {
  MAX_LOG_KEPT, MAX_LOG_READ, MAX_OPEN_TURNS, parsePmAssignment, parsePmOpResult, parsePmRpcResult, pmHostOfflineMessage,
  type PmAssignment, type PmHostResponse, type PmOp,
} from '../../shared/pm-state.ts';
import { decryptPush, newReceiver, type Receiver } from './push-helpers.ts';

const ORIGIN = 'https://foreman.test';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

// ---- identity (real bearer verification against a locally generated JWKS) -------------------
let signingKey: CryptoKey, jwks: unknown;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  jwks = { keys: [{ ...await exportJWK(pair.publicKey), kid: 'pm-test', alg: 'RS256', use: 'sig' }] };
});
async function idToken(email: string = env.ALLOWED_EMAIL) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, email_verified: true, firebase: { sign_in_provider: 'google.com' }, auth_time: now - 20 })
    .setProtectedHeader({ alg: 'RS256', kid: 'pm-test' }).setIssuer(`https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`)
    .setAudience(env.FIREBASE_PROJECT_ID).setSubject('owner-uid').setIssuedAt(now - 10).setExpirationTime(now + 3600).sign(signingKey);
}

// ---- outbound fetches: the JWKS and a fake push service, nothing else ------------------------
type Push = { endpoint: string; payload: any };
let pushes: Push[] = [];
let receivers = new Map<string, Receiver>();
let otherFetches: string[] = [];
const sockets: WebSocket[] = [];
beforeEach(() => {
  pushes = []; receivers = new Map(); otherFetches = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === JWKS_URL) return Response.json(jwks);
    const receiver = receivers.get(request.url);
    if (receiver) {
      const body = new Uint8Array(await request.arrayBuffer());
      pushes.push({ endpoint: request.url, payload: JSON.parse(await decryptPush(body, receiver)) });
      return new Response(null, { status: 201 });
    }
    otherFetches.push(new URL(request.url).hostname);
    return new Response(null, { status: 599 });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) { try { socket.close(1000, 'Test complete'); } catch {} }
  expect(otherFetches).toEqual([]);
});

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 3000) {
  for (let waited = 0; waited < ms; waited += 10) { if (await check()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`Timed out waiting for ${what}`);
}

// ---- hosts ---------------------------------------------------------------------------------
function relay() { return env.RELAY.get(env.RELAY.idFromName(crypto.randomUUID())); }
type Stub = ReturnType<typeof relay>;
const ownerRelay = () => env.RELAY.get(env.RELAY.idFromName(env.ALLOWED_EMAIL));

type Host = { socket: WebSocket; frames: any[]; machine_id: string; name: string; closed: Promise<void> };

async function open(stub: Stub) {
  const response = await stub.fetch(`${ORIGIN}/api/host/connect`, { headers: { upgrade: 'websocket', authorization: `Bearer ${env.HOST_TOKEN}` } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept(); sockets.push(socket);
  const frames: any[] = [];
  socket.addEventListener('message', (event) => { frames.push(JSON.parse(String(event.data))); });
  const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve()));
  return { socket, frames, closed };
}
const pongs = (host: { frames: any[] }) => host.frames.filter((frame) => frame.type === 'pong').length;
async function hello(host: Host, pmOpenTurns: string[] = []) {
  const before = pongs(host);
  host.socket.send(JSON.stringify({ type: 'hello', protocol: 2, machine_id: host.machine_id, host: host.name, platform: 'darwin', pm_open_turns: pmOpenTurns }));
  await until(() => pongs(host) > before, `${host.name} hello pong`);
}
/** Connects a protocol-2 host and waits for its hello to be answered. */
async function machine(stub: Stub, name: string, { machine_id = crypto.randomUUID(), openTurns = [] as string[] } = {}): Promise<Host> {
  const host = { ...await open(stub), machine_id, name };
  await hello(host, openTurns);
  return host;
}
/** A legacy (pre-#26) host: `{ type: 'hello', host }`. */
async function legacy(stub: Stub, name = 'Legacy Mac') {
  const host = await open(stub);
  host.socket.send(JSON.stringify({ type: 'hello', host: name }));
  await until(() => pongs(host) > 0, 'legacy hello pong');
  return host;
}
// A ping round trip proves the DO has processed every frame sent before it.
async function flush(host: { socket: WebSocket; frames: any[] }) {
  const before = pongs(host);
  host.socket.send(JSON.stringify({ type: 'ping' }));
  await until(() => pongs(host) > before, 'ping pong');
}
const assignments = (host: { frames: any[] }): PmAssignment[] => host.frames.filter((frame) => frame.type === 'pm_assignment');
const lastAssignment = (host: { frames: any[] }) => assignments(host).at(-1)!;
const requests = (host: { frames: any[] }) => host.frames.filter((frame) => frame.type === 'request');

async function rpc(host: Host, op: PmOp, args: unknown, epoch: number) {
  const id = crypto.randomUUID();
  host.socket.send(JSON.stringify({ type: 'pm_rpc', id, epoch, op, args }));
  await until(() => host.frames.some((frame) => frame.type === 'pm_rpc_result' && frame.id === id), `${op} result`);
  const result = host.frames.find((frame) => frame.type === 'pm_rpc_result' && frame.id === id);
  // Every answer is a valid contract frame.
  expect(parsePmRpcResult(result).ok).toBe(true);
  return result;
}
async function ok(host: Host, op: PmOp, args: unknown, epoch: number) {
  const result = await rpc(host, op, args, epoch);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  expect(parsePmOpResult(op, result.result).ok).toBe(true);
  return result.result;
}

async function disconnect(stub: Stub, host: Host) {
  host.socket.close(1000, 'Network lost');
  await until(async () => (await pmHost(stub)).machines.find((m) => m.machine_id === host.machine_id)?.online === false, `${host.name} offline`);
}

// ---- DO access -----------------------------------------------------------------------------
const pmHost = async (stub: Stub) => (await (await stub.fetch(`${ORIGIN}/api/pm/host`)).json()) as PmHostResponse;
const move = (stub: Stub, body: unknown) => stub.fetch(`${ORIGIN}/api/pm/host`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
// /api/host also carries the push counters (#127), covered in push-routes.test.ts; the PM fields are compared here.
const withoutPush = ({ push, ...status }: any) => { expect(push).toBeTypeOf('object'); return status; };
const hostStatus = async (stub: Stub) => withoutPush(await (await stub.fetch(`${ORIGIN}/api/host`)).json());
const sql = <T extends Record<string, SqlStorageValue>>(stub: Stub, query: string, ...bindings: unknown[]) =>
  runInDurableObject(stub, (_instance: HostRelay, ctx) => ctx.storage.sql.exec<T>(query, ...bindings).toArray());
const turns = (stub: Stub) => sql<{ turn_id: string; machine_id: string; epoch: number; state: string; reason: string | null }>(stub, 'SELECT turn_id, machine_id, epoch, state, reason FROM pm_turns ORDER BY accepted_at, turn_id');
const pushState = async (stub: Stub, key: string) => (await sql<{ value: string }>(stub, 'SELECT value FROM push_state WHERE key = ?', key))[0]?.value ?? null;
const at = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

// Two machines, A active by bootstrap (it said hello first) and B standby.
async function pair(stub: Stub = relay()) {
  const a = await machine(stub, 'machine-a');
  const b = await machine(stub, 'machine-b');
  return { stub, a, b };
}

// =============================================================================================

describe('two machines connected at once', () => {
  it('neither evicts the other; a reconnect from the same machine_id replaces only its own socket', async () => {
    const { stub, a, b } = await pair();
    await flush(a); await flush(b);
    expect(a.socket.readyState).toBe(1);
    expect(b.socket.readyState).toBe(1);
    expect((await pmHost(stub)).machines.map((m) => [m.name, m.online])).toEqual([['machine-a', true], ['machine-b', true]]);
    // In-flight delivery to A fails with 503 when A itself reconnects, exactly as a replaced host did before.
    const inFlight = stub.fetch(`${ORIGIN}/api/sessions`);
    await until(() => requests(a).length === 1, 'request reaches A');
    const a2 = await machine(stub, 'machine-a', { machine_id: a.machine_id });
    await a.closed;
    expect((await inFlight).status).toBe(503);
    await flush(b);
    expect(b.socket.readyState).toBe(1);
    // The replacement serves A's traffic; B is untouched.
    const next = stub.fetch(`${ORIGIN}/api/sessions`);
    await until(() => requests(a2).length === 1, 'request reaches the replacement');
    a2.socket.send(JSON.stringify({ type: 'response', id: requests(a2)[0].id, status: 200, body: '[]' }));
    expect((await next).status).toBe(200);
    expect(requests(b)).toEqual([]);
    expect((await pmHost(stub)).machines.map((m) => m.online)).toEqual([true, true]);
  });

  it('bootstrap: the first protocol-2 hello becomes the active PM host at epoch 1, sent before the pong', async () => {
    const stub = relay();
    const a = await machine(stub, 'machine-a');
    expect(a.frames.map((frame) => frame.type)).toEqual(['pm_assignment', 'pong']);
    expect(parsePmAssignment(a.frames[0]).ok).toBe(true);
    expect(a.frames[0]).toEqual({ type: 'pm_assignment', active: true, epoch: 1, active_machine: { machine_id: a.machine_id, host: 'machine-a' }, uncertain_turns: [] });
    const b = await machine(stub, 'machine-b');
    expect(b.frames[0]).toEqual({ type: 'pm_assignment', active: false, epoch: 1, active_machine: { machine_id: a.machine_id, host: 'machine-a' }, uncertain_turns: [] });
    // Later hellos (B again, A again) never change the assignment.
    await hello(b); await hello(a);
    expect(lastAssignment(b)).toMatchObject({ active: false, epoch: 1 });
    expect(lastAssignment(a)).toMatchObject({ active: true, epoch: 1 });
    expect(await sql(stub, 'SELECT singleton, machine_id, epoch, assigned_by FROM pm_assignment')).toEqual([{ singleton: 1, machine_id: a.machine_id, epoch: 1, assigned_by: 'bootstrap' }]);
    const view = await pmHost(stub);
    expect(view).toMatchObject({ active: { machine_id: a.machine_id, name: 'machine-a', online: true, epoch: 1, assigned_by: 'bootstrap' }, open_turns: 0, uncertain_turns: 0, mode: 'relay' });
    expect(typeof view.active!.assigned_at).toBe('number');
    expect(view.machines).toEqual([
      { machine_id: a.machine_id, name: 'machine-a', platform: 'darwin', online: true, last_seen: expect.any(Number), active: true },
      { machine_id: b.machine_id, name: 'machine-b', platform: 'darwin', online: true, last_seen: expect.any(Number), active: false },
    ]);
  });

  it('machine ids are compared in lower case', async () => {
    const stub = relay(), id = crypto.randomUUID();
    const a = await machine(stub, 'machine-a', { machine_id: id.toUpperCase() });
    expect(lastAssignment(a).active_machine!.machine_id).toBe(id);
    const again = await machine(stub, 'machine-a', { machine_id: id });
    await a.closed;
    expect(lastAssignment(again).active).toBe(true);
    expect((await pmHost(stub)).machines).toHaveLength(1);
  });

  it('an invalid protocol-2 hello closes the socket and records nothing', async () => {
    const stub = relay(), host = await open(stub);
    host.socket.send(JSON.stringify({ type: 'hello', protocol: 2, machine_id: 'not-a-uuid', host: 'x', platform: 'darwin', pm_open_turns: [] }));
    await host.closed;
    expect(await sql(stub, 'SELECT * FROM machines')).toEqual([]);
    expect(await sql(stub, 'SELECT * FROM pm_assignment')).toEqual([]);
  });
});

describe('routing to the active PM host only', () => {
  it('active-host routing: every relayed request reaches only the active host; the standby receives nothing', async () => {
    const { stub, a, b } = await pair();
    const calls: [string, string, string?][] = [['GET', '/api/sessions'], ['GET', '/api/pm/history'], ['POST', '/api/pm/message', '{"text":"hi"}'], ['GET', '/api/projects'], ['POST', '/api/session/message', '{}'], ['GET', '/api/memory'], ['POST', '/api/session/interrupt', '{}']];
    for (const [method, path, body] of calls) {
      const before = requests(a).length;
      const response = stub.fetch(`${ORIGIN}${path}`, { method, body });
      await until(() => requests(a).length > before, `${path} reaches A`);
      const frame = requests(a).at(-1);
      expect(frame).toMatchObject({ method, path });
      a.socket.send(JSON.stringify({ type: 'response', id: frame.id, status: 200, body: '{}' }));
      expect((await response).status).toBe(200);
    }
    expect(requests(a)).toHaveLength(calls.length);
    await flush(b);
    expect(requests(b)).toEqual([]);
    expect(await hostStatus(stub)).toEqual({ online: true, host: 'machine-a', machine_id: a.machine_id, standby_online: true });
    // The active host goes down: relayed requests are refused with its name; the standby still gets nothing.
    await disconnect(stub, a);
    const offline = await stub.fetch(`${ORIGIN}/api/sessions`);
    expect(offline.status).toBe(503);
    expect(await offline.json()).toEqual({ error: pmHostOfflineMessage('machine-a') });
    expect((await stub.fetch(`${ORIGIN}/api/pm/message`, { method: 'POST', body: '{}' })).status).toBe(503);
    await flush(b);
    expect(requests(b)).toEqual([]);
    expect(await hostStatus(stub)).toEqual({ online: false, host: 'machine-a', machine_id: a.machine_id, standby_online: true });
    await disconnect(stub, b);
    expect((await hostStatus(stub)).standby_online).toBe(false);
  });

  it('legacy hello: relayed to only while no assignment exists, replace-all among legacy hosts, never recorded as PM host', async () => {
    const stub = relay();
    const old = await legacy(stub, 'Old Mac');
    expect(assignments(old)).toEqual([]);
    expect(await hostStatus(stub)).toEqual({ online: true, host: 'Old Mac', machine_id: null, standby_online: false });
    const first = stub.fetch(`${ORIGIN}/api/sessions`);
    await until(() => requests(old).length === 1, 'legacy host relayed to');
    // A second legacy host replaces the first (today's behavior) and fails its in-flight request.
    const replacement = await legacy(stub, 'Old Mac');
    await old.closed;
    expect((await first).status).toBe(503);
    expect(await sql(stub, 'SELECT * FROM machines')).toEqual([]);
    expect(await sql(stub, 'SELECT * FROM pm_assignment')).toEqual([]);
    // The first protocol-2 machine bootstraps; from then on the legacy host gets nothing.
    const a = await machine(stub, 'machine-a');
    expect(lastAssignment(a)).toMatchObject({ active: true, epoch: 1 });
    const next = stub.fetch(`${ORIGIN}/api/sessions`);
    await until(() => requests(a).length === 1, 'request reaches A');
    a.socket.send(JSON.stringify({ type: 'response', id: requests(a)[0].id, status: 200, body: '[]' }));
    expect((await next).status).toBe(200);
    await flush(replacement);
    expect(requests(replacement)).toEqual([]);
    // A legacy hello never evicts a protocol-2 machine, and never becomes the PM host.
    const another = await legacy(stub, 'Old Mac');
    await replacement.closed;
    await flush(a);
    expect(a.socket.readyState).toBe(1);
    expect((await pmHost(stub)).machines.map((m) => m.name)).toEqual(['machine-a']);
    // With the PM host offline, a connected legacy host is still not relayed to.
    await disconnect(stub, a);
    const refused = await stub.fetch(`${ORIGIN}/api/sessions`);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: pmHostOfflineMessage('machine-a') });
    await flush(another);
    expect(requests(another)).toEqual([]);
    // A legacy socket cannot use PM state.
    another.socket.send(JSON.stringify({ type: 'pm_rpc', id: 'r1', epoch: 1, op: 'memory.get', args: {} }));
    await until(() => another.frames.some((frame) => frame.id === 'r1'), 'legacy pm_rpc answer');
    expect(another.frames.find((frame) => frame.id === 'r1')).toMatchObject({ ok: false, code: 'not_active' });
  });
});

describe('reassignment (POST /api/pm/host)', () => {
  it('reassignment with epoch CAS: 409 on stale epoch or offline target, 404 unknown, 400 already active, then 200', async () => {
    const { stub, a, b } = await pair();
    const c = await machine(stub, 'machine-c');
    await disconnect(stub, c);
    const statusOf = async (body: unknown) => { const response = await move(stub, body); return [response.status, ((await response.json()) as any)] as const; };
    expect((await statusOf({ machine_id: b.machine_id, expected_epoch: 0 }))[0]).toBe(409);
    expect((await statusOf({ machine_id: b.machine_id, expected_epoch: 2 }))[0]).toBe(409);
    expect(await statusOf({ machine_id: crypto.randomUUID(), expected_epoch: 1 })).toEqual([404, { error: 'Unknown machine' }]);
    expect(await statusOf({ machine_id: a.machine_id, expected_epoch: 1 })).toEqual([400, { error: 'The Coordinator already runs on machine-a.' }]);
    const [offlineStatus, offlineBody] = await statusOf({ machine_id: c.machine_id, expected_epoch: 1 });
    expect(offlineStatus).toBe(409);
    expect(offlineBody.error).toContain('machine-c is offline');
    for (const bad of [{}, { machine_id: b.machine_id }, { machine_id: 'nope', expected_epoch: 1 }, { machine_id: b.machine_id, expected_epoch: -1 }, { machine_id: b.machine_id, expected_epoch: 1, force: true }, '[1]', '{bad']) {
      expect((await move(stub, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await move(stub, 'x'.repeat(MAX_PM_HOST_BODY + 1))).status).toBe(413);
    // Nothing above changed the assignment or told any machine anything.
    expect(await sql(stub, 'SELECT machine_id, epoch FROM pm_assignment')).toEqual([{ machine_id: a.machine_id, epoch: 1 }]);
    expect(assignments(a)).toHaveLength(1);
    expect(assignments(b)).toHaveLength(1);

    const response = await move(stub, { machine_id: b.machine_id, expected_epoch: 1 });
    expect(response.status).toBe(200);
    const moved = await response.json() as any;
    expect(moved).toEqual({ active: { machine_id: b.machine_id, name: 'machine-b', online: true, epoch: 2, assigned_at: expect.any(Number), assigned_by: 'developer' }, epoch: 2 });
    // Both machines are told, each with its own `active`.
    await until(() => assignments(a).length === 2 && assignments(b).length === 2, 'assignment frames after the move');
    expect(lastAssignment(a)).toEqual({ type: 'pm_assignment', active: false, epoch: 2, active_machine: { machine_id: b.machine_id, host: 'machine-b' }, uncertain_turns: [] });
    expect(lastAssignment(b)).toEqual({ type: 'pm_assignment', active: true, epoch: 2, active_machine: { machine_id: b.machine_id, host: 'machine-b' }, uncertain_turns: [] });
    // The same (now stale) request cannot be replayed, and traffic follows the move.
    expect((await move(stub, { machine_id: a.machine_id, expected_epoch: 1 })).status).toBe(409);
    const relayed = stub.fetch(`${ORIGIN}/api/sessions`);
    await until(() => requests(b).length === 1, 'request reaches B');
    b.socket.send(JSON.stringify({ type: 'response', id: requests(b)[0].id, status: 200, body: '[]' }));
    expect((await relayed).status).toBe(200);
    await flush(a);
    expect(requests(a)).toEqual([]);
    expect(await hostStatus(stub)).toEqual({ online: true, host: 'machine-b', machine_id: b.machine_id, standby_online: true });
    // A later hello from the old host does not take the PM back.
    await hello(a);
    expect(lastAssignment(a)).toMatchObject({ active: false, epoch: 2 });
    expect(await sql(stub, 'SELECT machine_id, epoch, assigned_by FROM pm_assignment')).toEqual([{ machine_id: b.machine_id, epoch: 2, assigned_by: 'developer' }]);
  });

  it('fencing by epoch after reassignment: the old host\'s writes get stale_epoch and change nothing', async () => {
    const { stub, a, b } = await pair();
    await ok(a, 'memory.put', { doc: 'projects', content: '## Foreman\nstate: building', expected_version: 0 }, 1);
    await ok(a, 'memory.log', { text: 'first note' }, 1);
    await ok(a, 'settings.put', { model: 'opus' }, 1);
    expect((await move(stub, { machine_id: b.machine_id, expected_epoch: 1 })).status).toBe(200);
    const snapshot = async () => ({
      docs: await sql(stub, 'SELECT name, content, version, updated_epoch FROM pm_docs'),
      log: await sql(stub, 'SELECT seq, text, epoch FROM pm_log'),
      settings: await sql(stub, 'SELECT key, value FROM pm_settings'),
      turns: await turns(stub),
      meta: await sql(stub, 'SELECT key, value FROM pm_meta'),
    });
    const before = await snapshot();
    const staleWrites: [PmOp, unknown][] = [
      ['memory.put', { doc: 'projects', content: 'overwritten by the old host', expected_version: 1 }],
      ['memory.edit', { doc: 'projects', old_text: 'building', new_text: 'hijacked', expected_version: 1 }],
      ['memory.log', { text: 'stale note' }],
      ['memory.import', { projects: 'x', log: [], model: null, source_machine: a.machine_id }],
      ['settings.put', { model: 'haiku' }],
      ['turn.begin', { turn_id: 'stale-turn', accepted_at: at() }],
      ['turn.end', { turn_id: 'stale-turn', outcome: 'completed' }],
      ['turn.ack_uncertain', { turn_ids: ['stale-turn'] }],
      ['memory.get', {}],
    ];
    for (const [op, args] of staleWrites) {
      expect(await rpc(a, op, args, 1), op).toMatchObject({ ok: false, code: 'stale_epoch' });
      // Knowing the new epoch does not help a machine that is not the PM host.
      expect(await rpc(a, op, args, 2), op).toMatchObject({ ok: false, code: 'not_active' });
    }
    expect(await snapshot()).toEqual(before);
    // The new host is fenced the same way on the old epoch, and works on the current one.
    expect(await rpc(b, 'memory.log', { text: 'b note' }, 1)).toMatchObject({ ok: false, code: 'stale_epoch' });
    expect(await ok(b, 'memory.put', { doc: 'projects', content: '## Foreman\nstate: moved', expected_version: 1 }, 2)).toEqual({ version: 2 });
    expect(await sql(stub, 'SELECT content, version, updated_epoch FROM pm_docs WHERE name = ?', 'projects')).toEqual([{ content: '## Foreman\nstate: moved', version: 2, updated_epoch: 2 }]);
  });
});

describe('PM memory', () => {
  it('memory CRUD round trip: get, put, edit, log, import, settings', async () => {
    const { a } = await pair();
    const empty = await ok(a, 'memory.get', {}, 1);
    expect(empty).toEqual({ initialized: false, docs: { projects: { content: '', version: 0, updated_at: '' }, preferences: { content: '', version: 0, updated_at: '' } }, log: [], settings: { model: null } });
    expect(await ok(a, 'memory.import', { projects: '## Foreman\nstate: importing', log: ['imported one', 'imported two'], model: 'claude-opus-4-1', source_machine: a.machine_id }, 1)).toEqual({ imported: true });
    const imported = await ok(a, 'memory.get', {}, 1);
    expect(imported.initialized).toBe(true);
    expect(imported.docs.projects).toMatchObject({ content: '## Foreman\nstate: importing', version: 1 });
    expect(imported.log.map((entry: any) => entry.text)).toEqual(['imported one', 'imported two']);
    expect(imported.settings).toEqual({ model: 'claude-opus-4-1' });
    expect(await ok(a, 'memory.put', { doc: 'projects', content: '## Foreman\nstate: building\nblocker: none', expected_version: 1 }, 1)).toEqual({ version: 2 });
    expect(await ok(a, 'memory.edit', { doc: 'projects', old_text: 'blocker: none', new_text: 'blocker: review', expected_version: 2 }, 1)).toEqual({ version: 3 });
    expect(await rpc(a, 'memory.edit', { doc: 'projects', old_text: 'absent text', new_text: 'x', expected_version: 3 }, 1)).toMatchObject({ ok: false, code: 'invalid' });
    await ok(a, 'memory.put', { doc: 'preferences', content: 'short answers; short answers', expected_version: 0 }, 1);
    expect(await rpc(a, 'memory.edit', { doc: 'preferences', old_text: 'short answers', new_text: 'x', expected_version: 1 }, 1)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await rpc(a, 'memory.edit', { doc: 'preferences', old_text: 'short answers;', new_text: 'y'.repeat(9000), expected_version: 1 }, 1)).toMatchObject({ ok: false, code: 'too_large' });
    const { seq } = await ok(a, 'memory.log', { text: 'decided: ship Friday' }, 1);
    expect(await ok(a, 'settings.put', { model: null }, 1)).toEqual({});
    const read = await ok(a, 'memory.get', {}, 1);
    expect(read.docs.projects).toMatchObject({ content: '## Foreman\nstate: building\nblocker: review', version: 3 });
    expect(read.docs.preferences).toMatchObject({ content: 'short answers; short answers', version: 1 });
    expect(read.docs.projects.updated_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(read.log.at(-1)).toEqual({ seq, at: expect.any(String), text: 'decided: ship Friday' });
    expect(read.settings).toEqual({ model: null });
  });

  it('version_conflict: memory.put and memory.edit compare-and-set on the doc version', async () => {
    const { stub, a } = await pair();
    await ok(a, 'memory.put', { doc: 'projects', content: 'v1 content', expected_version: 0 }, 1);
    expect(await rpc(a, 'memory.put', { doc: 'projects', content: 'lost update', expected_version: 0 }, 1)).toMatchObject({ ok: false, code: 'version_conflict' });
    expect(await rpc(a, 'memory.put', { doc: 'projects', content: 'future', expected_version: 5 }, 1)).toMatchObject({ ok: false, code: 'version_conflict' });
    expect(await rpc(a, 'memory.edit', { doc: 'projects', old_text: 'v1', new_text: 'v2', expected_version: 0 }, 1)).toMatchObject({ ok: false, code: 'version_conflict' });
    expect(await sql(stub, 'SELECT content, version FROM pm_docs')).toEqual([{ content: 'v1 content', version: 1 }]);
  });

  it('import once: memory.import succeeds only while memory is uninitialized', async () => {
    const { stub, a, b } = await pair();
    // Only the importing machine may name itself, and only the active host may import.
    expect(await rpc(a, 'memory.import', { projects: 'x', log: [], model: null, source_machine: b.machine_id }, 1)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await rpc(b, 'memory.import', { projects: 'from b', log: [], model: null, source_machine: b.machine_id }, 1)).toMatchObject({ ok: false, code: 'not_active' });
    await ok(a, 'memory.import', { projects: 'from a', log: ['line one'], model: 'sonnet', source_machine: a.machine_id }, 1);
    expect(await rpc(a, 'memory.import', { projects: 'again', log: ['line two'], model: 'haiku', source_machine: a.machine_id }, 1)).toMatchObject({ ok: false, code: 'already_initialized' });
    expect(await sql(stub, 'SELECT content, version FROM pm_docs')).toEqual([{ content: 'from a', version: 1 }]);
    expect(await sql(stub, 'SELECT text FROM pm_log')).toEqual([{ text: 'line one' }]);
    expect(await sql(stub, 'SELECT value FROM pm_settings')).toEqual([{ value: 'sonnet' }]);
    const meta = JSON.parse((await sql<{ value: string }>(stub, 'SELECT value FROM pm_meta WHERE key = ?', 'memory_initialized'))[0]!.value);
    expect(meta).toEqual({ at: expect.any(String), source_machine: a.machine_id, imported: true });
    // A host with nothing to import initializes memory by its first write; an import after that is refused.
    const fresh = await pair();
    await ok(fresh.a, 'memory.log', { text: 'first thing learned' }, 1);
    expect(await rpc(fresh.a, 'memory.import', { projects: 'late', log: [], model: null, source_machine: fresh.a.machine_id }, 1)).toMatchObject({ ok: false, code: 'already_initialized' });
    expect(await sql(fresh.stub, 'SELECT * FROM pm_docs')).toEqual([]);
    const other = await pair();
    await ok(other.a, 'memory.put', { doc: 'preferences', content: 'terse', expected_version: 0 }, 1);
    expect((await ok(other.a, 'memory.get', {}, 1)).initialized).toBe(true);
    expect(await rpc(other.a, 'memory.import', { projects: 'late', log: [], model: null, source_machine: other.a.machine_id }, 1)).toMatchObject({ ok: false, code: 'already_initialized' });
  });

  it(`log trim: memory.log keeps the newest ${MAX_LOG_KEPT} entries and memory.get returns the newest ${MAX_LOG_READ}`, async () => {
    const { stub, a } = await pair();
    const lines = Array.from({ length: MAX_LOG_KEPT }, (_, i) => `imported ${i}`);
    await ok(a, 'memory.import', { projects: '', log: lines, model: null, source_machine: a.machine_id }, 1);
    for (let i = 0; i < 5; i++) await ok(a, 'memory.log', { text: `new ${i}` }, 1);
    const [{ count, oldest }] = await sql<{ count: number; oldest: string }>(stub, 'SELECT COUNT(*) AS count, (SELECT text FROM pm_log ORDER BY seq LIMIT 1) AS oldest FROM pm_log');
    expect(count).toBe(MAX_LOG_KEPT);
    expect(oldest).toBe('imported 5');
    const read = await ok(a, 'memory.get', {}, 1);
    expect(read.log).toHaveLength(MAX_LOG_READ);
    expect(read.log.at(-1).text).toBe('new 4');
    expect(read.log[0].text).toBe(`imported ${MAX_LOG_KEPT - MAX_LOG_READ + 5}`);
    // An empty projects string imports no doc.
    expect(read.docs.projects).toEqual({ content: '', version: 0, updated_at: '' });
  });

  it('invalid pm_rpc frames get invalid / too_large; frames without a usable id are dropped', async () => {
    const { a } = await pair();
    expect(await rpc(a, 'memory.put', { doc: 'notes', content: 'x', expected_version: 0 }, 1)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await rpc(a, 'memory.put', { doc: 'projects', content: 'x'.repeat(33 * 1024), expected_version: 0 }, 1)).toMatchObject({ ok: false, code: 'too_large' });
    expect(await rpc(a, 'memory.log', { text: 'x' }, 1)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await rpc(a, 'turn.begin', { turn_id: 'has spaces', accepted_at: at() }, 1)).toMatchObject({ ok: false, code: 'invalid' });
    const before = a.frames.length;
    a.socket.send(JSON.stringify({ type: 'pm_rpc', id: 'bad id!', epoch: 1, op: 'memory.get', args: {} }));
    await flush(a);
    expect(a.frames.slice(before).map((frame) => frame.type)).toEqual(['pong']);
    expect(a.socket.readyState).toBe(1);
  });
});

describe('in-flight turns and uncertainty', () => {
  it('turn begin/end/ack: begin records an open row, end deletes it, an unknown end is ok, at most 64 open', async () => {
    const { stub, a } = await pair();
    await ok(a, 'turn.begin', { turn_id: 'turn-1', accepted_at: at() }, 1);
    // A retried begin for the same open turn is acknowledged again.
    await ok(a, 'turn.begin', { turn_id: 'turn-1', accepted_at: at() }, 1);
    expect(await turns(stub)).toEqual([{ turn_id: 'turn-1', machine_id: a.machine_id, epoch: 1, state: 'open', reason: null }]);
    expect((await pmHost(stub)).open_turns).toBe(1);
    await ok(a, 'turn.end', { turn_id: 'turn-1', outcome: 'completed' }, 1);
    await ok(a, 'turn.end', { turn_id: 'never-begun', outcome: 'failed' }, 1);
    expect(await turns(stub)).toEqual([]);
    for (let i = 0; i < MAX_OPEN_TURNS; i++) await ok(a, 'turn.begin', { turn_id: `t${i}`, accepted_at: at() }, 1);
    expect(await rpc(a, 'turn.begin', { turn_id: 'one-too-many', accepted_at: at() }, 1)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(await turns(stub)).toHaveLength(MAX_OPEN_TURNS);
    // ack_uncertain touches only uncertain rows.
    await ok(a, 'turn.ack_uncertain', { turn_ids: ['t0'] }, 1);
    expect(await turns(stub)).toHaveLength(MAX_OPEN_TURNS);
  });

  it('restart: a hello from the active host without the turn in pm_open_turns marks it restarted', async () => {
    const { stub, a, b } = await pair();
    const acceptedAt = at(-5000);
    await ok(a, 'turn.begin', { turn_id: 'lost-turn', accepted_at: acceptedAt }, 1);
    await ok(a, 'turn.begin', { turn_id: 'held-turn', accepted_at: at() }, 1);
    await disconnect(stub, a);
    const restarted = await machine(stub, 'machine-a', { machine_id: a.machine_id, openTurns: ['held-turn'] });
    const frame = lastAssignment(restarted);
    expect(parsePmAssignment(frame).ok).toBe(true);
    expect(frame).toEqual({ type: 'pm_assignment', active: true, epoch: 1, active_machine: { machine_id: a.machine_id, host: 'machine-a' }, uncertain_turns: [{ turn_id: 'lost-turn', accepted_at: acceptedAt, host: 'machine-a', reason: 'restarted' }] });
    expect(await turns(stub)).toEqual([
      { turn_id: 'lost-turn', machine_id: a.machine_id, epoch: 1, state: 'uncertain', reason: 'restarted' },
      { turn_id: 'held-turn', machine_id: a.machine_id, epoch: 1, state: 'open', reason: null },
    ]);
    // A standby's hello never reconciles the active host's turns, and never receives them.
    await hello(b, []);
    expect(lastAssignment(b).uncertain_turns).toEqual([]);
    expect((await turns(stub)).find((t) => t.turn_id === 'held-turn')!.state).toBe('open');
  });

  it('socket blip: a close alone marks nothing, and a reconnect listing the turn yields no uncertain entry', async () => {
    const { stub, a } = await pair();
    await ok(a, 'turn.begin', { turn_id: 'live-turn', accepted_at: at() }, 1);
    await disconnect(stub, a);
    expect(await turns(stub)).toEqual([{ turn_id: 'live-turn', machine_id: a.machine_id, epoch: 1, state: 'open', reason: null }]);
    expect((await pmHost(stub)).uncertain_turns).toBe(0);
    const back = await machine(stub, 'machine-a', { machine_id: a.machine_id, openTurns: ['live-turn'] });
    expect(lastAssignment(back)).toMatchObject({ active: true, epoch: 1, uncertain_turns: [] });
    expect((await turns(stub))[0]!.state).toBe('open');
    // The reply arrives normally and the turn ends.
    await ok(back, 'turn.end', { turn_id: 'live-turn', outcome: 'completed' }, 1);
    expect(await turns(stub)).toEqual([]);
  });

  it('in-flight turn on move while the old host is online: reassigned, delivered only to the new host', async () => {
    const { stub, a, b } = await pair();
    const acceptedAt = at(-1000);
    await ok(a, 'turn.begin', { turn_id: 'moving-turn', accepted_at: acceptedAt }, 1);
    expect((await move(stub, { machine_id: b.machine_id, expected_epoch: 1 })).status).toBe(200);
    await until(() => assignments(b).length === 2 && assignments(a).length === 2, 'assignment frames');
    expect(lastAssignment(b).uncertain_turns).toEqual([{ turn_id: 'moving-turn', accepted_at: acceptedAt, host: 'machine-a', reason: 'reassigned' }]);
    expect(lastAssignment(a)).toMatchObject({ active: false, uncertain_turns: [] });
    expect(await turns(stub)).toEqual([{ turn_id: 'moving-turn', machine_id: a.machine_id, epoch: 1, state: 'uncertain', reason: 'reassigned' }]);
    // The old host's late turn.end is fenced and cannot erase the uncertain record.
    expect(await rpc(a, 'turn.end', { turn_id: 'moving-turn', outcome: 'completed' }, 1)).toMatchObject({ ok: false, code: 'stale_epoch' });
    expect(await turns(stub)).toHaveLength(1);
  });

  it('in-flight turn on move off a lost host: host_lost', async () => {
    const { stub, a, b } = await pair();
    await ok(a, 'turn.begin', { turn_id: 'orphan-turn', accepted_at: at() }, 1);
    await disconnect(stub, a);
    expect(await turns(stub)).toMatchObject([{ state: 'open' }]);
    expect((await move(stub, { machine_id: b.machine_id, expected_epoch: 1 })).status).toBe(200);
    await until(() => assignments(b).length === 2, 'assignment frame to B');
    expect(lastAssignment(b).uncertain_turns).toEqual([{ turn_id: 'orphan-turn', accepted_at: expect.any(String), host: 'machine-a', reason: 'host_lost' }]);
    expect(await turns(stub)).toMatchObject([{ turn_id: 'orphan-turn', state: 'uncertain', reason: 'host_lost' }]);
    // When the lost machine returns it is a standby and hears nothing about the turn.
    const back = await machine(stub, 'machine-a', { machine_id: a.machine_id, openTurns: ['orphan-turn'] });
    expect(lastAssignment(back)).toMatchObject({ active: false, epoch: 2, uncertain_turns: [] });
    expect(await turns(stub)).toMatchObject([{ state: 'uncertain', reason: 'host_lost' }]);
  });

  // #116: uncertain rows are capped overall, dropping the oldest (accepted_at, then turn_id).
  const seedUncertain = (stub: Stub, machineId: string, count: number) => runInDurableObject(stub, (_instance: HostRelay, ctx) => {
    for (let i = 0; i < count; i++) {
      ctx.storage.sql.exec("INSERT INTO pm_turns (turn_id, machine_id, epoch, accepted_at, state, reason) VALUES (?, ?, 1, ?, 'uncertain', 'restarted')",
        `old-${String(i).padStart(4, '0')}`, machineId, Date.parse('2026-01-01T00:00:00.000Z') + Math.floor(i / 2) * 1000);
    }
  });
  it(`uncertain rows are capped at ${MAX_UNCERTAIN_TURNS} on reassignment, dropping the oldest deterministically`, async () => {
    const { stub, a, b } = await pair();
    await seedUncertain(stub, a.machine_id, MAX_UNCERTAIN_TURNS - 1);
    await ok(a, 'turn.begin', { turn_id: 'new-1', accepted_at: at(-2000) }, 1);
    await ok(a, 'turn.begin', { turn_id: 'new-2', accepted_at: at(-1000) }, 1);
    await ok(a, 'turn.begin', { turn_id: 'new-3', accepted_at: at() }, 1);
    expect((await move(stub, { machine_id: b.machine_id, expected_epoch: 1 })).status).toBe(200);
    const rows = (await turns(stub)).filter((t) => t.state === 'uncertain');
    expect(rows).toHaveLength(MAX_UNCERTAIN_TURNS);
    expect((await pmHost(stub)).uncertain_turns).toBe(MAX_UNCERTAIN_TURNS);
    // old-0000 and old-0001 share the oldest accepted_at: both go (the tie is broken by turn_id).
    const ids = rows.map((t) => t.turn_id);
    expect(ids.slice(0, 2)).toEqual(['old-0002', 'old-0003']);
    expect(ids.slice(-3)).toEqual(['new-1', 'new-2', 'new-3']);
    await until(() => assignments(b).length === 2, 'assignment frame to B');
    expect(lastAssignment(b).uncertain_turns.map((t) => t.turn_id)[0]).toBe('old-0002');
  });

  it(`uncertain rows are capped at ${MAX_UNCERTAIN_TURNS} on a restart reconciliation too`, async () => {
    const { stub, a } = await pair();
    await seedUncertain(stub, a.machine_id, MAX_UNCERTAIN_TURNS);
    await ok(a, 'turn.begin', { turn_id: 'lost-turn', accepted_at: at() }, 1);
    await disconnect(stub, a);
    await machine(stub, 'machine-a', { machine_id: a.machine_id, openTurns: [] });
    const rows = (await turns(stub)).filter((t) => t.state === 'uncertain');
    expect(rows).toHaveLength(MAX_UNCERTAIN_TURNS);
    expect(rows[0]!.turn_id).toBe('old-0001');
    expect(rows.at(-1)!.turn_id).toBe('lost-turn');
  });

  it('uncertain turns are delivered to the active host until acked, then never again', async () => {
    const { stub, a, b } = await pair();
    await ok(a, 'turn.begin', { turn_id: 'u1', accepted_at: at(-2000) }, 1);
    await ok(a, 'turn.begin', { turn_id: 'u2', accepted_at: at(-1000) }, 1);
    expect((await move(stub, { machine_id: b.machine_id, expected_epoch: 1 })).status).toBe(200);
    await until(() => assignments(b).length === 2, 'assignment frame to B');
    expect(lastAssignment(b).uncertain_turns.map((t) => t.turn_id)).toEqual(['u1', 'u2']);
    expect((await pmHost(stub)).uncertain_turns).toBe(2);
    // Not acked yet (say B restarted before showing them): the next hello carries them again.
    await hello(b);
    expect(lastAssignment(b).uncertain_turns.map((t) => t.turn_id)).toEqual(['u1', 'u2']);
    // turn.end never clears an uncertain record; only the ack does.
    await ok(b, 'turn.end', { turn_id: 'u1', outcome: 'completed' }, 2);
    expect((await turns(stub)).map((t) => [t.turn_id, t.state])).toEqual([['u1', 'uncertain'], ['u2', 'uncertain']]);
    await ok(b, 'turn.ack_uncertain', { turn_ids: ['u1', 'u2'] }, 2);
    expect(await turns(stub)).toEqual([]);
    await hello(b);
    expect(lastAssignment(b).uncertain_turns).toEqual([]);
    expect((await pmHost(stub)).uncertain_turns).toBe(0);
    // The standby never saw them at all.
    expect(assignments(a).every((frame) => frame.uncertain_turns.length === 0)).toBe(true);
  });
});

describe('/api/pm/host through the Worker', () => {
  const api = async (method: string, path: string, { token, origin, body }: { token?: string | null; origin?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const bearer = token === undefined ? await idToken() : token;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (origin) headers.origin = origin;
    return exports.default.fetch(`${ORIGIN}${path}`, { method, headers, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
  };
  const resetOwner = () => runInDurableObject(ownerRelay(), (_instance: HostRelay, ctx) => {
    ctx.storage.sql.exec('DELETE FROM machines; DELETE FROM pm_assignment; DELETE FROM pm_docs; DELETE FROM pm_log; DELETE FROM pm_settings; DELETE FROM pm_meta; DELETE FROM pm_turns;');
  });
  beforeEach(resetOwner);
  afterEach(resetOwner);

  it('/api/pm/host auth: 401 without a bearer, 403 for another account or an invalid token, 403 cross-origin', async () => {
    for (const method of ['GET', 'POST']) {
      expect((await api(method, '/api/pm/host', { token: null })).status).toBe(401);
      expect((await api(method, '/api/pm/host', { token: 'invalid' })).status).toBe(403);
      expect((await api(method, '/api/pm/host', { token: await idToken('intruder@example.com') })).status).toBe(403);
      expect((await api(method, '/api/pm/host', { origin: 'https://attacker.invalid' })).status).toBe(403);
    }
    // The host token is not a user credential.
    expect((await exports.default.fetch(`${ORIGIN}/api/pm/host`, { headers: { authorization: `Bearer ${env.HOST_TOKEN}` } })).status).toBe(403);
  });

  it('is Worker/DO-terminated: never on the relay allowlist and never relayed to a host', async () => {
    expect(allowedRequest('GET', '/api/pm/host')).toBe(false);
    expect(allowedRequest('POST', '/api/pm/host')).toBe(false);
    const { a, b } = await pair(ownerRelay());
    const view = await api('GET', '/api/pm/host', { origin: ORIGIN });
    expect(view.status).toBe(200);
    expect(await view.json()).toMatchObject({ active: { machine_id: a.machine_id, name: 'machine-a', online: true, epoch: 1 }, mode: 'relay', open_turns: 0, uncertain_turns: 0 });
    expect((await api('GET', '/api/pm/host?x=1')).status).toBe(404);
    expect((await api('PUT', '/api/pm/host')).status).toBe(404);
    expect((await api('POST', '/api/pm/host', { body: { machine_id: b.machine_id, expected_epoch: 0 } })).status).toBe(409);
    const moved = await api('POST', '/api/pm/host', { body: { machine_id: b.machine_id, expected_epoch: 1 } });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ active: { machine_id: b.machine_id, name: 'machine-b', epoch: 2, assigned_by: 'developer' }, epoch: 2 });
    // /api/host (still relayed contract-wise, answered by the DO) reports the new PM host.
    expect(withoutPush(await (await api('GET', '/api/host')).json())).toEqual({ online: true, host: 'machine-b', machine_id: b.machine_id, standby_online: true });
    await flush(a); await flush(b);
    expect(requests(a)).toEqual([]);
    expect(requests(b)).toEqual([]);
  });
});

describe('stored text', () => {
  it('no message text in storage: the DO keeps no PM message or provider error text', async () => {
    const MESSAGE = 'PLEASE-DO-NOT-STORE-this-user-message';
    const PROVIDER_ERROR = 'provider exploded: Authorization: Basic dXNlcjpwYXNzd29yZA==';
    const { stub, a } = await pair();
    // A PM message relayed to the host, and the host's failure answer, pass through untouched.
    const send = stub.fetch(`${ORIGIN}/api/pm/message`, { method: 'POST', body: JSON.stringify({ text: MESSAGE }) });
    await until(() => requests(a).length === 1, 'PM message relayed');
    expect(requests(a)[0].body).toContain(MESSAGE);
    await ok(a, 'turn.begin', { turn_id: 'turn-with-text', accepted_at: at() }, 1);
    a.socket.send(JSON.stringify({ type: 'response', id: requests(a)[0].id, status: 502, body: JSON.stringify({ error: PROVIDER_ERROR }) }));
    expect((await send).status).toBe(502);
    await ok(a, 'turn.end', { turn_id: 'turn-with-text', outcome: 'failed' }, 1);
    await ok(a, 'turn.begin', { turn_id: 'turn-2', accepted_at: at() }, 1);
    // Rejected ops whose arguments carry text store none of it, and error messages are redacted.
    const conflict = await rpc(a, 'memory.edit', { doc: 'projects', old_text: MESSAGE, new_text: PROVIDER_ERROR, expected_version: 0 }, 1);
    expect(conflict).toMatchObject({ ok: false, code: 'invalid' });
    expect(JSON.stringify(conflict)).not.toContain(MESSAGE);
    expect(await rpc(a, 'memory.put', { doc: 'projects', content: PROVIDER_ERROR, expected_version: 9 }, 1)).toMatchObject({ ok: false, code: 'version_conflict' });
    await disconnect(stub, a);
    await machine(stub, 'machine-a', { machine_id: a.machine_id });
    // Dump every table the DO has.
    const tables = await sql<{ name: string }>(stub, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'");
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['machines', 'pm_assignment', 'pm_docs', 'pm_log', 'pm_settings', 'pm_meta', 'pm_turns']));
    let dump = '';
    for (const { name } of tables) dump += JSON.stringify(await sql(stub, `SELECT * FROM "${name}"`));
    expect(dump).not.toContain(MESSAGE);
    expect(dump).not.toContain('provider exploded');
    expect(dump).not.toContain('dXNlcjpwYXNzd29yZA');
    // Turn rows hold ids, times, machine, epoch, state and a fixed reason only.
    expect((await sql<{ name: string }>(stub, "SELECT name FROM pragma_table_info('pm_turns')")).map((c) => c.name)).toEqual(['turn_id', 'machine_id', 'epoch', 'accepted_at', 'state', 'reason']);
    expect(await turns(stub)).toEqual([{ turn_id: 'turn-2', machine_id: a.machine_id, epoch: 1, state: 'uncertain', reason: 'restarted' }]);
  });
});

describe('#43 host-offline alarm follows the active PM host', () => {
  async function subscribe(stub: Stub) {
    const receiver = await newReceiver();
    const endpoint = `https://fcm.googleapis.com/fcm/send/pm-${crypto.randomUUID()}`;
    receivers.set(endpoint, receiver);
    const response = await stub.fetch(`${ORIGIN}/api/push/subscribe`, { method: 'POST', body: JSON.stringify({ subscription: { endpoint, expirationTime: null, keys: { p256dh: receiver.p256dh, auth: receiver.auth } } }) });
    expect(response.status).toBe(200);
  }
  const backdate = (stub: Stub) => runInDurableObject(stub, (_i: HostRelay, ctx) => {
    ctx.storage.sql.exec("INSERT OR REPLACE INTO push_state (key, value) VALUES ('outage_since', ?)", String(Date.now() - OFFLINE_AFTER - 60_000));
  });

  it('a standby going away is no outage; the active host going away is, named after it; a move ends it', async () => {
    const { stub, a, b } = await pair();
    await subscribe(stub);
    // Standby B drops: nothing is recorded, the periodic check sees the active host and stays quiet.
    await disconnect(stub, b);
    await flush(a);
    expect(await pushState(stub, 'outage_since')).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(pushes).toEqual([]);
    // B returns; active A drops: that is the outage.
    const b2 = await machine(stub, 'machine-b', { machine_id: b.machine_id });
    await disconnect(stub, a);
    await until(async () => (await pushState(stub, 'outage_since')) !== null, 'outage recorded');
    // A heartbeat from the standby does not end the PM host's outage.
    await flush(b2);
    expect(await pushState(stub, 'outage_since')).not.toBeNull();
    await backdate(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.payload).toMatchObject({ kind: 'host_offline', host: 'machine-a' });
    await flush(b2);
    expect(await pushState(stub, 'offline_notified')).toBe('1');
    // Moving the PM to the online standby ends the outage; the periodic check resumes on B.
    expect((await move(stub, { machine_id: b.machine_id, expected_epoch: 1 })).status).toBe(200);
    expect(await pushState(stub, 'outage_since')).toBeNull();
    expect(await pushState(stub, 'offline_notified')).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(pushes).toHaveLength(1);
    // Now B is the PM host: B dropping is the next outage, and it is named after B.
    await disconnect(stub, b2);
    await until(async () => (await pushState(stub, 'outage_since')) !== null, 'second outage recorded');
    await backdate(stub);
    await runDurableObjectAlarm(stub);
    expect(pushes).toHaveLength(2);
    expect(pushes[1]!.payload).toMatchObject({ kind: 'host_offline', host: 'machine-b' });
  });
});

describe('#122 heartbeat and offline diagnostics', () => {
  const lastSeen = async (stub: Stub, machineId: string) => (await sql<{ last_seen: number }>(stub, 'SELECT last_seen FROM machines WHERE machine_id = ?', machineId))[0]!.last_seen;
  const setLastSeen = (stub: Stub, machineId: string, value: number) => sql(stub, 'UPDATE machines SET last_seen = ? WHERE machine_id = ?', value, machineId);

  it('a pm_rpc frame refreshes its socket\'s heartbeat, so an active host that only sends rpcs stays online', async () => {
    const stub = relay();
    const a = await machine(stub, 'machine-a');
    await runInDurableObject(stub, (_instance: HostRelay, ctx) => {
      for (const socket of ctx.getWebSockets('host')) socket.serializeAttachment({ ...socket.deserializeAttachment(), lastSeen: Date.now() - 120_000 });
    });
    expect((await hostStatus(stub)).online).toBe(false);
    await ok(a, 'memory.get', {}, 1);
    expect((await hostStatus(stub)).online).toBe(true);
    expect((await pmHost(stub)).machines.find((m) => m.machine_id === a.machine_id)?.online).toBe(true);
  });

  it('machines.last_seen is written at most once a minute per machine by heartbeats (pings and pm_rpc)', async () => {
    const stub = relay();
    const a = await machine(stub, 'machine-a');
    // Seen 30 s ago: a ping and an rpc within the interval write nothing.
    const recent = Date.now() - 30_000;
    await setLastSeen(stub, a.machine_id, recent);
    await flush(a);
    await ok(a, 'memory.get', {}, 1);
    expect(await lastSeen(stub, a.machine_id)).toBe(recent);
    // Seen over a minute ago: the next heartbeat writes it.
    const old = Date.now() - 61_000;
    await setLastSeen(stub, a.machine_id, old);
    await flush(a);
    expect(await lastSeen(stub, a.machine_id)).toBeGreaterThan(old + 60_000);
    // Online is the socket's own freshness, never the stored value.
    await setLastSeen(stub, a.machine_id, Date.now() - 30 * 60_000);
    expect((await pmHost(stub)).machines[0]).toMatchObject({ online: true });
    // A hello always writes it.
    await hello(a);
    expect(await lastSeen(stub, a.machine_id)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('with no host at all, the offline answer is platform-neutral', async () => {
    const stub = relay();
    const response = await stub.fetch(`${ORIGIN}/api/session/message`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'The execution host is offline. Open Foreman on it and reconnect.' });
    expect(await hostStatus(stub)).toEqual({ online: false, host: null, machine_id: null, standby_online: false });
  });
});
