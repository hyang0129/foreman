// Pin FOREMAN_HOME to a temp dir before any server module loads (story #121 guard).
import './fixtures/temp-foreman-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostBridge, LEAD_RPC_MAX_PENDING, LeadRpcError, PmRpcError } from '../server/host-bridge.ts';
import { MAX_BODY, MAX_RESPONSE, MAX_REQUEST_FRAME, MAX_RESPONSE_FRAME } from '../shared/relay.ts';
import { notifyId, type NotifyFrame } from '../shared/notify.ts';
import { MAX_PM_RESULT_FRAME, isHelloV2, parseHello, type PmAssignment } from '../shared/pm-state.ts';
import { MAX_LEAD_RESULT_FRAME, defaultDevSettings, parseLeadRpc, type LeadRecord } from '../shared/roles.ts';

const TOKEN = 'synthetic-test-host-credential'.repeat(2);
class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: any[] = [];
  closed?: { code: number; reason: string };
  terminated = false;
  open() { this.readyState = 1; this.emit('open'); }
  send(raw: string) { const value = JSON.parse(raw); this.sent.push(value); this.emit('sent', value); }
  receive(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; this.closed = { code, reason }; this.emit('close'); }
  terminate() { this.terminated = true; this.close(); }
}

function bridge(t: test.TestContext, port = 4177, localToken?: string) {
  t.mock.method(console, 'log', () => {});
  const sockets: FakeSocket[] = [];
  const options: any[] = [];
  const urls: URL[] = [];
  const instance = new HostBridge(port, { url: 'https://foreman.example', token: TOKEN }, {
    localToken, socketFactory: (url, opts) => { const socket = new FakeSocket(); urls.push(url); options.push(opts); sockets.push(socket); return socket as any; },
  });
  t.after(() => instance.close());
  instance.start();
  return { instance, sockets, options, urls };
}

async function local(t: test.TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return (server.address() as { port: number }).port;
}

function response(socket: FakeSocket, id: string) {
  return new Promise<any>((resolve) => {
    const handler = (value: any) => { if (value.type === 'response' && value.id === id) { socket.off('sent', handler); resolve(value); } };
    socket.on('sent', handler);
  });
}

test('bridge proxies only loopback API, preserves JSON, and does not forward the host credential', async (t) => {
  let observed: any;
  const port = await local(t, async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    observed = { method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
    res.writeHead(202, { 'content-type': 'application/json' }); res.end('{"status":"queued"}');
  });
  const f = bridge(t, port), socket = f.sockets[0]!; socket.open();
  assert.equal(f.urls[0]!.href, 'wss://foreman.example/api/host/connect');
  assert.equal(f.options[0].headers.authorization, `Bearer ${TOKEN}`);
  const body = JSON.stringify({ id: 'fm:one', message_id: 'id', text: 'quoted "text"\nnext line' });
  const reply = response(socket, 'one');
  socket.receive({ type: 'request', id: 'one', method: 'POST', path: '/api/session/message', body });
  assert.equal((await reply).status, 202);
  assert.equal(observed.body, body);
  assert.equal(observed.path, '/api/session/message');
  assert.equal(observed.method, 'POST');
  assert.equal(observed.headers.origin, `http://127.0.0.1:${port}`);
  assert.equal(observed.headers.authorization, undefined);
  assert.ok(!JSON.stringify(observed).includes(TOKEN));
});

test('invalid routes, methods, and oversized bodies fail before touching local HTTP', async (t) => {
  let requests = 0;
  const port = await local(t, (_req, res) => { requests++; res.end('{}'); });
  const f = bridge(t, port), socket = f.sockets[0]!; socket.open();
  const cases = [
    { method: 'POST', path: '/api/exec', body: '{}' },
    { method: 'GET', path: '//attacker.invalid/api/sessions' },
    { method: 'DELETE', path: '/api/sessions' },
    { method: 'POST', path: '/api/session/message', body: {} },
    { method: 'POST', path: '/api/session/message', body: 'x'.repeat(MAX_BODY + 1) },
    { method: 'POST', path: '/api/session/message', body: '🙂'.repeat(MAX_BODY / 2) },
  ];
  for (const [index, value] of cases.entries()) {
    const id = `bad-${index}`, reply = response(socket, id);
    socket.receive({ type: 'request', id, ...value });
    assert.equal((await reply).status, 400);
  }
  assert.equal(requests, 0);
});

test('redirects cannot make the authenticated relay fetch another local route', async (t) => {
  let redirected = false;
  const port = await local(t, (req, res) => {
    if (req.url === '/api/sessions') { res.writeHead(302, { location: '/private' }); res.end(); }
    else { redirected = true; res.end('private'); }
  });
  const f = bridge(t, port), socket = f.sockets[0]!; socket.open();
  const reply = response(socket, 'redirect');
  socket.receive({ type: 'request', id: 'redirect', method: 'GET', path: '/api/sessions' });
  assert.equal((await reply).status, 502);
  assert.equal(redirected, false);
});

test('oversized local responses fail with an explicit delivery-uncertainty response', async (t) => {
  const port = await local(t, (_req, res) => res.end('x'.repeat(MAX_RESPONSE + 1)));
  const f = bridge(t, port), socket = f.sockets[0]!; socket.open();
  const reply = response(socket, 'large');
  socket.receive({ type: 'request', id: 'large', method: 'GET', path: '/api/sessions' });
  const value = await reply;
  assert.equal(value.status, 502);
  assert.match(JSON.parse(value.body).error, /whether work was accepted/);
});

test('JSON envelope caps allow escaping of otherwise valid near-limit bodies', async (t) => {
  const requestBody = JSON.stringify({ text: '\u0000"\\'.repeat(12_000) });
  assert.ok(Buffer.byteLength(requestBody) <= MAX_BODY);
  const request = { type: 'request', id: 'escaped', method: 'POST', path: '/api/session/message', body: requestBody };
  const responseBody = JSON.stringify({ text: '"\\'.repeat(700_000) });
  assert.ok(Buffer.byteLength(responseBody) <= MAX_RESPONSE);
  const port = await local(t, (_req, res) => res.end(responseBody));
  const f = bridge(t, port), socket = f.sockets[0]!; socket.open();
  const frameBytes = Buffer.byteLength(JSON.stringify(request));
  assert.ok(frameBytes > MAX_BODY + 16_384, 'fixture must exceed former incorrect request frame cap');
  assert.ok(frameBytes < f.options[0].maxPayload);
  assert.equal(f.options[0].maxPayload, MAX_REQUEST_FRAME);
  const reply = response(socket, 'escaped'); socket.receive(request);
  const received = await reply;
  assert.equal(received.status, 200);
  assert.equal(received.body, responseBody);
  assert.ok(Buffer.byteLength(JSON.stringify(received)) > MAX_RESPONSE + 65_536, 'fixture must exceed former incorrect response frame cap');
  assert.ok(Buffer.byteLength(JSON.stringify(received)) <= MAX_RESPONSE_FRAME);
});

test('start is idempotent, disconnect reconnects once, and close prevents reconnection', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  t.mock.method(Math, 'random', () => 0);
  const f = bridge(t), first = f.sockets[0]!;
  f.instance.start(); assert.equal(f.sockets.length, 1);
  first.open(); first.close();
  t.mock.timers.tick(1000); assert.equal(f.sockets.length, 2);
  const second = f.sockets[1]!; second.open();
  assert.equal(second.sent[0].type, 'hello');
  assert.equal(second.sent.filter((entry) => entry.type === 'response').length, 0, 'reconnect must not replay previous requests');
  f.instance.close(); t.mock.timers.tick(120_000);
  assert.equal(f.sockets.length, 2);
});

test('an accepted request is never replayed onto the replacement connection', async (t) => {
  let finish: (() => void) | undefined;
  let accepted!: () => void;
  const received = new Promise<void>((resolve) => { accepted = resolve; });
  let requests = 0;
  const port = await local(t, (_req, res) => { requests++; finish = () => res.end('{"accepted":true}'); accepted(); });
  const f = bridge(t, port), first = f.sockets[0]!; first.open();
  const pending = (f.instance as any).handle({ type: 'request', id: 'uncertain', method: 'POST', path: '/api/session/message', body: '{}' }, first);
  await received;
  first.close();
  // Exercise a new connection while the former connection's local fetch finishes.
  // Timer/backoff scheduling itself is covered by the separate fake-timer test.
  (f.instance as any).connect();
  const replacement = f.sockets[1]!; replacement.open();
  finish!(); await pending;
  assert.equal(requests, 1);
  assert.equal(first.sent.filter((entry) => entry.type === 'response').length, 0);
  assert.equal(replacement.sent.filter((entry) => entry.type === 'response').length, 0);
});

test('missing pong terminates a stale socket; a recent pong keeps it alive', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const f = bridge(t), socket = f.sockets[0]!; socket.open();
  t.mock.timers.tick(40_000); socket.receive({ type: 'pong' });
  t.mock.timers.tick(40_000); assert.equal(socket.terminated, false);
  t.mock.timers.tick(40_000); assert.equal(socket.terminated, true);
});

test('malformed or binary relay frames close the socket instead of reaching HTTP', (t) => {
  const f = bridge(t), socket = f.sockets[0]!; socket.open();
  socket.receive(null);
  assert.equal(socket.closed?.code, 1003);
  const g = bridge(t), binary = g.sockets[0]!; binary.open();
  binary.emit('message', Buffer.from('{}'), true);
  assert.equal(binary.closed?.code, 1003);
});

test('relay constructor rejects insecure or credential-bearing origins', () => {
  for (const url of ['http://foreman.test', 'https://user:pass@foreman.test', 'https://foreman.test/path', 'https://foreman.test?token=x', 'https://foreman.test/#x']) {
    assert.throws(() => new HostBridge(4177, { url, token: TOKEN }), /HTTPS origin/);
  }
  assert.throws(() => new HostBridge(4177, { url: 'https://foreman.test', token: 'short' }), /token/i);
});

test('disk pairing requires an owned private regular file and malformed content never prints credentials', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'foreman-bridge-config-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'cloud.json');
  const moduleUrl = new URL('../server/host-bridge.ts', import.meta.url).href;
  const code = `import {readBridgeConfig} from ${JSON.stringify(moduleUrl)}; try { const result=readBridgeConfig(); console.log(result ? 'configured' : 'absent'); } catch(error) { console.log(error.message); }`;
  const env: NodeJS.ProcessEnv = { ...process.env, FOREMAN_HOME: home };
  delete env.FOREMAN_RELAY_URL; delete env.FOREMAN_HOST_TOKEN;
  const read = (overrides = {}) => execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { env: { ...env, ...overrides }, encoding: 'utf8' }).trim();
  assert.equal(read(), 'absent');
  writeFileSync(path, JSON.stringify({ url: 'https://foreman.test', token: TOKEN }), { mode: 0o600 });
  assert.equal(read(), 'configured');
  chmodSync(path, 0o644); assert.match(read(), /0600/);
  chmodSync(path, 0o600); writeFileSync(path, `{"token":"${TOKEN}" BROKEN`);
  const error = read(); assert.match(error, /Invalid cloud.json/); assert.ok(!error.includes(TOKEN));
  rmSync(path); const target = join(home, 'target.json');
  writeFileSync(target, JSON.stringify({ url: 'https://foreman.test', token: TOKEN }), { mode: 0o600 });
  symlinkSync(target, path); assert.match(read(), /regular file/);
  assert.match(read({ FOREMAN_RELAY_URL: 'https://foreman.test' }), /together|both|partial/i);
});


test('bridge authenticates to the local API with a separate local token', async (t) => {
  let authorization: string | undefined;
  const port=await local(t,(req,res)=>{authorization=req.headers.authorization;res.end('{}');});
  const f=bridge(t,port,'synthetic-local-token'),socket=f.sockets[0];socket.open();
  const replied=response(socket,'local-auth');
  socket.receive({type:'request',id:'local-auth',method:'GET',path:'/api/sessions'});
  assert.equal((await replied).status,200);
  assert.equal(authorization,'Bearer synthetic-local-token');
  assert.equal(f.options[0].headers.authorization,`Bearer ${TOKEN}`);
});

test('project routes cross the authenticated bridge with only explicit methods', async (t) => {
  const seen: { method?: string; path?: string; token?: string }[] = [];
  const port = await local(t, (req, res) => { seen.push({ method: req.method, path: req.url, token: req.headers.authorization }); res.end('{}'); });
  const f = bridge(t, port, 'synthetic-local-token'), socket = f.sockets[0]; socket.open();
  const routes = [['GET', '/api/projects'], ...['resolve', 'register', 'update', 'remove'].map((action) => ['POST', `/api/projects/${action}`])];
  for (const [method, path] of routes) {
    const reply = response(socket, path); socket.receive({ type: 'request', id: path, method, path, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal((await reply).status, 200);
  }
  assert.equal(seen.length, 5); assert.ok(seen.every((entry) => entry.token === 'Bearer synthetic-local-token'));
  for (const [method, path] of [['GET', '/api/projects/register'], ['POST', '/api/projects'], ['GET', '/api/projects/list-directory']]) {
    const reply = response(socket, path); socket.receive({ type: 'request', id: path, method, path, body: '{}' }); assert.equal((await reply).status, 400);
  }
  assert.equal(seen.length, 5);
});

const frame = (n: number, overrides: Record<string, unknown> = {}): NotifyFrame => ({ type: 'notify', id: notifyId('approval_requested', 'fm:a', String(n)), kind: 'approval_requested', host: 'test-mac', session_key: 'fm:a', session_name: `session ${n}`, at: new Date().toISOString(), ...overrides } as NotifyFrame);
const notifies = (socket: FakeSocket) => socket.sent.filter((entry) => entry.type === 'notify');

test('notify on an open relay sends the validated frame after hello', (t) => {
  const f = bridge(t), socket = f.sockets[0]!; socket.open();
  f.instance.notify(frame(1));
  assert.equal(socket.sent[0].type, 'hello');
  assert.deepEqual(notifies(socket), [frame(1, { at: notifies(socket)[0].at })]);
});

test('notify while disconnected queues and flushes on the next open; later opens re-send only recent frames', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  t.mock.method(Math, 'random', () => 0);
  const f = bridge(t), first = f.sockets[0]!;
  f.instance.notify(frame(1));
  assert.equal(first.sent.length, 0, 'nothing is sent before the socket opens');
  first.open();
  assert.deepEqual(first.sent.map((entry) => entry.type), ['hello', 'notify']);
  first.close();
  f.instance.notify(frame(2)); f.instance.notify(frame(3));
  t.mock.timers.tick(1000);
  const second = f.sockets[1]!; second.open();
  // #126: frame 1 (sent on the first socket) is re-sent first, then the queue flushes.
  assert.deepEqual(second.sent.map((entry) => entry.type), ['hello', 'notify', 'notify', 'notify']);
  assert.deepEqual(notifies(second).map((entry) => entry.session_name), ['session 1', 'session 2', 'session 3']);
  second.close(); t.mock.timers.tick(2000);
  const third = f.sockets[2]!; third.open();
  // #126: every recently sent frame goes out again (same ids; the relay de-duplicates), once each.
  assert.deepEqual(notifies(third).map((entry) => entry.session_name), ['session 1', 'session 2', 'session 3']);
  assert.deepEqual(notifies(third).map((entry) => entry.id), notifies(second).map((entry) => entry.id));
});

test('#126: a frame sent into an open-but-dead socket is re-sent on the next connection, before queued ones', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  t.mock.method(Math, 'random', () => 0);
  const f = bridge(t), first = f.sockets[0]!; first.open();
  f.instance.notify(frame(1));
  assert.equal(notifies(first).length, 1, 'written into the socket, which reported open');
  // The socket was dead all along: the heartbeat finds no pong and terminates it.
  t.mock.timers.tick(80_000);
  assert.equal(first.terminated, true);
  f.instance.notify(frame(2));
  t.mock.timers.tick(1000);
  const second = f.sockets[1]!; second.open();
  assert.deepEqual(second.sent.map((entry) => entry.type), ['hello', 'notify', 'notify']);
  assert.deepEqual(notifies(second).map((entry) => entry.session_name), ['session 1', 'session 2']);
  assert.equal(notifies(second)[0].id, notifies(first)[0].id, 'the same id, so the relay drops it if it did arrive');
  f.instance.notify(frame(3));
  assert.deepEqual(notifies(second).map((entry) => entry.session_name), ['session 1', 'session 2', 'session 3'], 'nothing is sent twice on one connection');
});

test('#126: re-sent frames are bounded to the newest 20 and to five minutes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  t.mock.method(Math, 'random', () => 0);
  const f = bridge(t), first = f.sockets[0]!; first.open();
  for (let n = 1; n <= 25; n++) f.instance.notify(frame(n));
  assert.equal(notifies(first).length, 25);
  first.close(); t.mock.timers.tick(1000);
  const second = f.sockets[1]!; second.open();
  assert.deepEqual(notifies(second).map((entry) => entry.session_name), Array.from({ length: 20 }, (_, i) => `session ${i + 6}`));
  // Sockets are left unopened while time passes, so no heartbeat runs.
  second.close(); t.mock.timers.tick(4 * 60_000);
  const third = f.sockets.at(-1)!; assert.notEqual(third, second); third.open();
  assert.equal(notifies(third).length, 20, 'still under five minutes old');
  third.close(); t.mock.timers.tick(60_000);
  const fourth = f.sockets.at(-1)!; assert.notEqual(fourth, third); fourth.open();
  assert.equal(notifies(fourth).length, 0, 'frames older than five minutes are not re-sent');
});

test('the notify queue keeps only the newest 20 frames', (t) => {
  const f = bridge(t), socket = f.sockets[0]!;
  for (let n = 1; n <= 25; n++) f.instance.notify(frame(n));
  socket.open();
  assert.deepEqual(notifies(socket).map((entry) => entry.session_name), Array.from({ length: 20 }, (_, i) => `session ${i + 6}`));
});

test('queued frames older than five minutes are dropped', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const f = bridge(t), socket = f.sockets[0]!;
  f.instance.notify(frame(1));
  t.mock.timers.tick(4 * 60_000);
  f.instance.notify(frame(2));
  t.mock.timers.tick(60_000 + 1);
  socket.open();
  assert.deepEqual(notifies(socket).map((entry) => entry.session_name), ['session 2']);
});

test('invalid notify frames are dropped, never sent or queued, and never logged with content', (t) => {
  const errors: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args.map(String).join(' ')));
  const f = bridge(t), socket = f.sockets[0]!;
  const invalid = [
    frame(1, { input: { command: 'SECRET-COMMAND' } }),
    frame(2, { kind: 'turn_finished' }),
    frame(3, { at: '2026-09-24T00:00:00.123456Z' }),
    frame(4, { session_key: undefined }),
    frame(5, { id: 'has spaces SECRET-ID' }),
    null as any,
  ];
  for (const value of invalid) assert.doesNotThrow(() => f.instance.notify(value));
  socket.open();
  for (const value of invalid) assert.doesNotThrow(() => f.instance.notify(value));
  assert.equal(notifies(socket).length, 0);
  assert.ok(errors.length > 0);
  assert.ok(!errors.join('\n').includes('SECRET'));
});

test('a send that throws never throws into the caller, and the frame is retried on the next open', (t) => {
  t.mock.method(console, 'error', () => {});
  const f = bridge(t), socket = f.sockets[0]!; socket.open();
  const original = socket.send.bind(socket);
  socket.send = () => { throw new Error('socket exploded'); };
  assert.doesNotThrow(() => f.instance.notify(frame(1)));
  socket.send = original;
  socket.close(1000, 'test'); t.mock.timers.enable({ apis: ['setTimeout'] });
  (f.instance as any).connect();
  const replacement = f.sockets[1]!; replacement.open();
  assert.deepEqual(notifies(replacement).map((entry) => entry.session_name), ['session 1']);
});

test('notify after close is a no-op', (t) => {
  const f = bridge(t), socket = f.sockets[0]!; socket.open();
  f.instance.close();
  assert.doesNotThrow(() => f.instance.notify(frame(1)));
  assert.equal(notifies(socket).length, 0);
});

test('startHostBridge keeps its shape and exposes notify only when a relay is configured', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'foreman-bridge-start-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const moduleUrl = new URL('../server/host-bridge.ts', import.meta.url).href;
  // #126: a fake socket factory, so the relay case never opens a real WebSocket to foreman.invalid.
  const code = `import {startHostBridge} from ${JSON.stringify(moduleUrl)}; import {EventEmitter} from 'node:events'; const opened = []; const fake = (url) => { opened.push(url.href); const s = new EventEmitter(); s.readyState = 0; s.close = () => { s.readyState = 3; }; s.terminate = s.close; return s; }; const b = startHostBridge(1, 'local', { socketFactory: fake }); console.log(typeof b.close, typeof b.notify, JSON.stringify(opened)); b.close(); process.exit(0);`;
  const env: NodeJS.ProcessEnv = { ...process.env, FOREMAN_HOME: home };
  delete env.FOREMAN_RELAY_URL; delete env.FOREMAN_HOST_TOKEN;
  const run = (overrides = {}) => execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { env: { ...env, ...overrides }, encoding: 'utf8' }).trim().split('\n').at(-1);
  assert.equal(run(), 'function undefined []', 'local-only mode: no notify, so no notifier is wired');
  assert.equal(run({ FOREMAN_RELAY_URL: 'https://foreman.invalid', FOREMAN_HOST_TOKEN: TOKEN }), 'function function ["wss://foreman.invalid/api/host/connect"]', 'the only socket is the injected fake');
});

// ---------------------------------------------------------------------------------------------
// Epic #26 (PMM-03): hello v2, pm_rpc correlation/timeout, pm_assignment, disconnect.
// ---------------------------------------------------------------------------------------------

const MACHINE = { machine_id: '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', name: 'machine-a' };
const OTHER = { machine_id: 'a9b8c7d6-1234-4abc-8def-0123456789ab', name: 'machine-b' };
const assignmentFrame = (overrides: Record<string, unknown> = {}) => ({ type: 'pm_assignment', active: true, epoch: 3, active_machine: { machine_id: MACHINE.machine_id, host: MACHINE.name }, uncertain_turns: [], ...overrides });
const rpcs = (socket: FakeSocket) => socket.sent.filter((entry) => entry.type === 'pm_rpc');

function v2(t: test.TestContext, settings: { openTurns?: () => readonly string[]; rpcTimeoutMs?: number } = {}) {
  t.mock.method(console, 'log', () => {});
  const sockets: FakeSocket[] = [];
  const options: any[] = [];
  const instance = new HostBridge(4177, { url: 'https://foreman.example', token: TOKEN }, {
    identity: MACHINE, platform: 'darwin', pmOpenTurns: settings.openTurns, rpcTimeoutMs: settings.rpcTimeoutMs,
    socketFactory: (_url, opts) => { const socket = new FakeSocket(); options.push(opts); sockets.push(socket); return socket as any; },
  });
  t.after(() => instance.close());
  instance.start();
  return { instance, sockets, options };
}

test('v2 hello carries machine_id, name, platform, protocol 2 and pm_open_turns from the provider on every connect', (t) => {
  let turns: string[] = ['turn-1', 'turn-2'];
  const f = v2(t, { openTurns: () => turns });
  const first = f.sockets[0]!; first.open();
  const hello = first.sent[0];
  assert.deepEqual(hello, { type: 'hello', protocol: 2, machine_id: MACHINE.machine_id, host: 'machine-a', platform: 'darwin', pm_open_turns: ['turn-1', 'turn-2'] });
  const parsed = parseHello(hello); assert.ok(parsed.ok && isHelloV2(parsed.value));
  assert.ok(!JSON.stringify(hello).includes(TOKEN));
  assert.equal(f.instance.protocol, 2);
  first.close(); clearTimeout((f.instance as any).reconnect);
  turns = ['turn-2', 'bad id with spaces', 'turn-2', 'turn-3'];
  t.mock.method(console, 'error', () => {});
  (f.instance as any).connect();
  const second = f.sockets[1]!; second.open();
  assert.deepEqual(second.sent[0].pm_open_turns, ['turn-2', 'turn-3'], 'called again on reconnect; invalid and duplicate ids dropped');
  assert.equal(f.options[0].maxPayload, MAX_PM_RESULT_FRAME, 'a v2 socket accepts DO result frames up to 1 MiB');
});

test('the legacy bridge (no identity) still sends the pre-#26 hello and has no PM rpc', async (t) => {
  const f = bridge(t), socket = f.sockets[0]!; socket.open();
  assert.deepEqual(Object.keys(socket.sent[0]).sort(), ['host', 'type']);
  assert.equal(f.instance.protocol, 1);
  assert.equal(f.options[0].maxPayload, MAX_REQUEST_FRAME);
  await assert.rejects(f.instance.rpc('memory.get', {}), (error: any) => error instanceof PmRpcError && error.code === 'unavailable');
  assert.equal(socket.sent.filter((entry) => entry.type === 'pm_rpc').length, 0);
});

test('on a v2 socket a relayed request frame over MAX_REQUEST_FRAME still closes the socket', (t) => {
  const f = v2(t), socket = f.sockets[0]!; socket.open();
  socket.receive({ type: 'request', id: 'huge', method: 'POST', path: '/api/session/message', body: 'x'.repeat(MAX_REQUEST_FRAME) });
  assert.equal(socket.closed?.code, 1009);
});

test('rpc correlates replies by id, carries the assignment epoch, and validates results per op', async (t) => {
  const f = v2(t), socket = f.sockets[0]!; socket.open();
  socket.receive(assignmentFrame());
  const a = f.instance.rpc('memory.log', { text: 'first note' });
  const b = f.instance.rpc('memory.put', { doc: 'projects', content: '# P', expected_version: 0 });
  const [ra, rb] = rpcs(socket);
  assert.equal(ra.epoch, 3); assert.equal(rb.epoch, 3);
  assert.notEqual(ra.id, rb.id);
  assert.deepEqual(ra.args, { text: 'first note' });
  socket.receive({ type: 'pm_rpc_result', id: rb.id, ok: true, result: { version: 1 } });
  socket.receive({ type: 'pm_rpc_result', id: ra.id, ok: true, result: { seq: 7 } });
  assert.deepEqual(await a, { seq: 7 });
  assert.deepEqual(await b, { version: 1 });
  const c = f.instance.rpc('memory.put', { doc: 'projects', content: 'x', expected_version: 1 }, { epoch: 9 });
  const rc = rpcs(socket)[2]; assert.equal(rc.epoch, 9, 'an explicit epoch wins');
  socket.receive({ type: 'pm_rpc_result', id: rc.id, ok: false, code: 'stale_epoch', message: 'epoch 9 is not current' });
  await assert.rejects(c, (error: any) => error instanceof PmRpcError && error.code === 'stale_epoch' && error.epoch === 9);
  const d = f.instance.rpc('memory.log', { text: 'bad result' });
  socket.receive({ type: 'pm_rpc_result', id: rpcs(socket)[3].id, ok: true, result: { version: 1 } });
  await assert.rejects(d, (error: any) => error.code === 'invalid_result');
  // A DO error message is redacted again on the host before it can reach the user.
  const e = f.instance.rpc('memory.log', { text: 'leaky error' });
  socket.receive({ type: 'pm_rpc_result', id: rpcs(socket)[4].id, ok: false, code: 'unavailable', message: `upstream said Authorization: Bearer ${TOKEN}` });
  await assert.rejects(e, (error: any) => error.code === 'unavailable' && !error.message.includes(TOKEN) && error.message.includes('[REDACTED]'));
});

test('invalid args fail locally with the contract code and nothing is sent', async (t) => {
  const f = v2(t), socket = f.sockets[0]!; socket.open(); socket.receive(assignmentFrame());
  await assert.rejects(f.instance.rpc('memory.log', { text: 'x'.repeat(501) }), (error: any) => error.code === 'too_large');
  await assert.rejects(f.instance.rpc('turn.begin', { turn_id: 'has space', accepted_at: new Date().toISOString() }), (error: any) => error.code === 'invalid');
  assert.equal(rpcs(socket).length, 0);
});

test('rpc times out after the per-call timeout (default 10 s) and a stale reply afterwards is ignored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const f = v2(t), socket = f.sockets[0]!; socket.open(); socket.receive(assignmentFrame());
  const call = f.instance.rpc('turn.begin', { turn_id: 'turn-1', accepted_at: '2026-09-24T00:00:00.000Z' });
  let settled = false; call.then(() => { settled = true; }, () => { settled = true; });
  t.mock.timers.tick(9_999); await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await assert.rejects(call, (error: any) => error instanceof PmRpcError && error.code === 'timeout' && error.op === 'turn.begin');
  const stale = rpcs(socket)[0];
  assert.doesNotThrow(() => socket.receive({ type: 'pm_rpc_result', id: stale.id, ok: true, result: {} }));
  assert.equal(socket.closed, undefined, 'a stale reply does not close the socket');
  const next = f.instance.rpc('memory.log', { text: 'after stale' }, { timeoutMs: 50 });
  socket.receive({ type: 'pm_rpc_result', id: rpcs(socket)[1].id, ok: true, result: { seq: 1 } });
  assert.deepEqual(await next, { seq: 1 });
});

test('disconnected: rpc rejects without sending, a close fails pending calls, and the bridge reports disconnected', async (t) => {
  const f = v2(t), socket = f.sockets[0]!;
  const events: boolean[] = []; f.instance.onConnection((connected) => events.push(connected));
  await assert.rejects(f.instance.rpc('memory.get', {}), (error: any) => error.code === 'disconnected');
  socket.open(); socket.receive(assignmentFrame());
  assert.equal(f.instance.connected, true);
  assert.equal(f.instance.currentAssignment()?.epoch, 3);
  const pending = f.instance.rpc('turn.begin', { turn_id: 'turn-1', accepted_at: '2026-09-24T00:00:00.000Z' });
  socket.close(1006, 'gone');
  await assert.rejects(pending, (error: any) => error.code === 'disconnected');
  assert.equal(f.instance.connected, false);
  assert.equal(f.instance.currentAssignment(), null, 'a host that cannot see the DO holds no assignment');
  assert.deepEqual(events, [true, false]);
  await assert.rejects(f.instance.rpc('memory.get', {}), (error: any) => error.code === 'disconnected');
  assert.equal(rpcs(socket).length, 1);
});

test('pm_assignment frames are validated and emitted; invalid ones are dropped', (t) => {
  t.mock.method(console, 'error', () => {});
  const f = v2(t), socket = f.sockets[0]!; socket.open();
  const seen: PmAssignment[] = []; const off = f.instance.onAssignment((a) => seen.push(a));
  socket.receive(assignmentFrame({ uncertain_turns: [{ turn_id: 'turn-9', accepted_at: '2026-09-24T00:00:00.000Z', host: 'machine-a', reason: 'restarted' }] }));
  socket.receive(assignmentFrame({ active: false, epoch: 4, active_machine: { machine_id: OTHER.machine_id, host: OTHER.name } }));
  socket.receive(assignmentFrame({ active: false, uncertain_turns: [{ turn_id: 'x', accepted_at: '2026-09-24T00:00:00.000Z', host: 'a', reason: 'restarted' }] }));
  socket.receive({ type: 'pm_assignment', active: true });
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.uncertain_turns[0]!.turn_id, 'turn-9');
  assert.deepEqual(seen[1]!.active_machine, { machine_id: OTHER.machine_id, host: 'machine-b' });
  assert.equal(f.instance.currentAssignment()?.epoch, 4);
  off(); socket.receive(assignmentFrame({ epoch: 5 }));
  assert.equal(seen.length, 2);
});

test('#43 notify sending is intact on a v2 bridge', (t) => {
  const f = v2(t), socket = f.sockets[0]!;
  f.instance.notify(frame(1)); socket.open();
  assert.deepEqual(socket.sent.map((entry) => entry.type), ['hello', 'notify']);
  f.instance.notify(frame(2));
  assert.deepEqual(notifies(socket).map((entry) => entry.session_name), ['session 1', 'session 2']);
});

test('#126: notify re-sending also works on a v2 bridge', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  t.mock.method(Math, 'random', () => 0);
  const f = v2(t), first = f.sockets[0]!; first.open();
  f.instance.notify(frame(1));
  first.close(); t.mock.timers.tick(1000);
  const second = f.sockets[1]!; second.open();
  assert.equal(second.sent[0].type, 'hello');
  assert.deepEqual(notifies(second).map((entry) => entry.session_name), ['session 1']);
});

test('startHostBridge with an identity starts a v2 bridge and exposes it', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'foreman-bridge-v2-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const moduleUrl = new URL('../server/host-bridge.ts', import.meta.url).href;
  const code = `import {startHostBridge, HostBridge} from ${JSON.stringify(moduleUrl)}; import {EventEmitter} from 'node:events'; const opened = []; const fake = (url) => { opened.push(url.href); const s = new EventEmitter(); s.readyState = 0; s.close = () => { s.readyState = 3; }; s.terminate = s.close; return s; }; const b = startHostBridge(1, 'local', { identity: ${JSON.stringify(MACHINE)}, pmOpenTurns: () => [], socketFactory: fake }); console.log(b.bridge instanceof HostBridge, b.bridge?.protocol, JSON.stringify(opened)); b.close(); process.exit(0);`;
  const env: NodeJS.ProcessEnv = { ...process.env, FOREMAN_HOME: home, FOREMAN_RELAY_URL: 'https://foreman.invalid', FOREMAN_HOST_TOKEN: TOKEN };
  const out = execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { env, encoding: 'utf8' }).trim().split('\n').at(-1);
  assert.equal(out, 'true 2 ["wss://foreman.invalid/api/host/connect"]', 'the only socket is the injected fake');
});

// #122: a policy close (1008, e.g. "Too many machines") is logged with its reason, exposed by
// refusal(), and retried only after a strong, growing backoff; an accepted hello clears it.
test('a 1008 policy refusal is surfaced and retried with a strong backoff, never in a tight loop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  t.mock.method(Math, 'random', () => 0);
  const errors: string[] = [], logs: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.join(' ')); });
  const f = v2(t);
  t.mock.method(console, 'log', (...args: unknown[]) => { logs.push(args.join(' ')); });
  const refuse = (socket: FakeSocket, reason: string) => { socket.readyState = 3; socket.emit('close', 1008, Buffer.from(reason)); };
  const first = f.sockets[0]!; first.open();
  assert.equal(f.instance.refusal(), null);
  refuse(first, 'Too many machines');
  assert.deepEqual(f.instance.refusal(), { code: 1008, reason: 'Too many machines', at: 100_000, retry_at: 160_000 });
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /cloud relay refused this machine \(1008 Too many machines\)\. The relay keeps at most 16 machines.*Retrying in 1 min/);
  // Not the ordinary 1 s reconnect.
  t.mock.timers.tick(59_000); assert.equal(f.sockets.length, 1);
  t.mock.timers.tick(1_000); assert.equal(f.sockets.length, 2);
  // Refused again: the wait doubles.
  const second = f.sockets[1]!; second.open(); refuse(second, 'Too many machines');
  assert.equal(f.instance.refusal()?.retry_at, 160_000 + 120_000);
  t.mock.timers.tick(119_000); assert.equal(f.sockets.length, 2);
  t.mock.timers.tick(1_000); assert.equal(f.sockets.length, 3);
  // Accepted: the refusal clears, and a later ordinary drop reconnects on the ordinary schedule.
  const third = f.sockets[2]!; third.open();
  third.receive(assignmentFrame());
  assert.equal(f.instance.refusal(), null);
  assert.ok(logs.some((line) => line.includes('accepted this machine again')));
  third.close();
  t.mock.timers.tick(1_000); assert.equal(f.sockets.length, 4);
  // The reason is redacted and bounded; the credential never reaches the log.
  const fourth = f.sockets[3]!; fourth.open(); refuse(fourth, `Invalid hello token=${TOKEN}`);
  assert.equal(f.instance.refusal()?.reason, 'Invalid hello token=[REDACTED]');
  assert.ok(!errors.join('\n').includes(TOKEN));
  assert.doesNotMatch(errors.at(-1)!, /16 machines/);
});

test('startHostBridge names why a configured relay could not start, without the credential', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'foreman-bridge-error-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const moduleUrl = new URL('../server/host-bridge.ts', import.meta.url).href;
  const code = `import {startHostBridge} from ${JSON.stringify(moduleUrl)}; const b = startHostBridge(1, 'local'); console.log(JSON.stringify({ error: b.error ?? null, bridge: Boolean(b.bridge) })); b.close(); process.exit(0);`;
  const env: NodeJS.ProcessEnv = { ...process.env, FOREMAN_HOME: home };
  delete env.FOREMAN_RELAY_URL; delete env.FOREMAN_HOST_TOKEN;
  const run = (overrides = {}) => JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { env: { ...env, ...overrides }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').at(-1)!);
  assert.deepEqual(run(), { error: null, bridge: false });
  assert.deepEqual(run({ FOREMAN_RELAY_URL: 'http://foreman.invalid', FOREMAN_HOST_TOKEN: TOKEN }), { error: 'Relay URL must be an HTTPS origin', bridge: false });
  assert.deepEqual(run({ FOREMAN_RELAY_URL: 'https://foreman.invalid', FOREMAN_HOST_TOKEN: 'short' }), { error: 'Invalid host token', bridge: false });
  assert.deepEqual(run({ FOREMAN_RELAY_URL: 'https://foreman.invalid' }), { error: 'Set both FOREMAN_RELAY_URL and FOREMAN_HOST_TOKEN', bridge: false });
});

// ---------------------------------------------------------------------------------------------
// Epic #157 (CL-03): lead_rpc on any hello-v2 connection, not epoch-fenced.
// ---------------------------------------------------------------------------------------------

const leadRpcs = (socket: FakeSocket) => socket.sent.filter((entry) => entry.type === 'lead_rpc');
const LEAD = 'fm:0b6f1f0e-3c7d-4a51-9e0b-1f2a3b4c5d6e';
const leadRecord = (over: Partial<LeadRecord> = {}): LeadRecord => ({
  v: 1, lead: LEAD, machine_id: MACHINE.machine_id, machine_name: MACHINE.name, name: 'lead-x', project: 'foreman', workstream: 'x', goal: 'Ship it',
  model: 'opus[1m]', effort: 'medium', permission_mode: 'bypass', launched_by: 'coordinator', state: 'working', alive: true,
  created_at: 1, updated_at: 2, pending_approvals: 0, workers: [], ...over,
});
const settingsView = () => ({ settings: defaultDevSettings(), versions: { roles: 0, bypass_grants: 0, bypass_ask: 0 }, updated_at: null });

test('leadRpc correlates lead_rpc_result by id, validates results per op, and carries no epoch', async (t) => {
  const f = v2(t), socket = f.sockets[0]!; socket.open(); socket.receive(assignmentFrame());
  const a = f.instance.leadRpc('lead.upsert', { record: leadRecord() });
  const b = f.instance.leadRpc('settings.get', {});
  const [ra, rb] = leadRpcs(socket);
  assert.ok(parseLeadRpc(ra).ok && parseLeadRpc(rb).ok, 'frames satisfy the shared contract');
  assert.equal('epoch' in ra, false);
  assert.notEqual(ra.id, rb.id);
  socket.receive({ type: 'lead_rpc_result', id: rb.id, ok: true, result: settingsView() });
  socket.receive({ type: 'lead_rpc_result', id: ra.id, ok: true, result: {} });
  assert.deepEqual(await a, {});
  assert.deepEqual((await b).settings, defaultDevSettings());
  // Invalid args fail locally with the contract code; nothing is sent.
  const sent = leadRpcs(socket).length;
  await assert.rejects(f.instance.leadRpc('lead.handoff', { handoff: { bogus: true } } as any), (error: any) => error instanceof LeadRpcError && error.code === 'invalid');
  assert.equal(leadRpcs(socket).length, sent);
  // A lead_rpc_result never settles a pm_rpc with the same id: separate pending maps.
  const pm = f.instance.rpc('memory.log', { text: 'pm note' });
  const pmId = rpcs(socket).at(-1).id;
  socket.receive({ type: 'lead_rpc_result', id: pmId, ok: true, result: {} });
  socket.receive({ type: 'pm_rpc_result', id: pmId, ok: true, result: { seq: 3 } });
  assert.deepEqual(await pm, { seq: 3 });
  // Wrong result shape for the op → invalid_result; a DO error is redacted again.
  const c = f.instance.leadRpc('lead.sync', { records: [leadRecord()] });
  socket.receive({ type: 'lead_rpc_result', id: leadRpcs(socket).at(-1).id, ok: true, result: { stored: true } });
  await assert.rejects(c, (error: any) => error.code === 'invalid_result' && error.op === 'lead.sync');
  const d = f.instance.leadRpc('lead.get', { lead: LEAD, handoffs: 1 });
  socket.receive({ type: 'lead_rpc_result', id: leadRpcs(socket).at(-1).id, ok: false, code: 'forbidden', message: `nope Authorization: Bearer ${TOKEN}` });
  await assert.rejects(d, (error: any) => error instanceof LeadRpcError && error.code === 'forbidden' && !error.message.includes(TOKEN));
  assert.ok(f.options[0].maxPayload >= MAX_LEAD_RESULT_FRAME, 'a v2 socket accepts 1 MiB lead results');
});

test('a standby host (not the active PM, or before any assignment) can still send lead_rpc', async (t) => {
  const f = v2(t), socket = f.sockets[0]!; socket.open();
  const early = f.instance.leadRpc('settings.get', {});
  socket.receive({ type: 'lead_rpc_result', id: leadRpcs(socket)[0].id, ok: true, result: settingsView() });
  assert.ok(await early, 'no assignment yet');
  socket.receive(assignmentFrame({ active: false, epoch: 4, active_machine: { machine_id: OTHER.machine_id, host: OTHER.name } }));
  const standby = f.instance.leadRpc('lead.handoff', { handoff: {
    v: 1, lead: LEAD, seq: 1, at: '2026-09-25T00:00:00.000Z', kind: 'seed', project: 'foreman', workstream: 'x', goal: 'Ship it', status: 'in_progress',
    summary: '', decisions: [], open_questions: [], next_steps: [], links: [], workers: [],
  } });
  socket.receive({ type: 'lead_rpc_result', id: leadRpcs(socket)[1].id, ok: true, result: { stored: false } });
  assert.deepEqual(await standby, { stored: false });
  // pm_rpc is unchanged: still sent with the (inactive) assignment's epoch for the DO to fence.
  const pm = f.instance.rpc('memory.get', {});
  assert.equal(rpcs(socket)[0].epoch, 4);
  socket.receive({ type: 'pm_rpc_result', id: rpcs(socket)[0].id, ok: false, code: 'not_active', message: 'not the active PM host' });
  await assert.rejects(pm, (error: any) => error instanceof PmRpcError && error.code === 'not_active');
});

test('leadRpc: timeout, disconnect, legacy bridge, oversized frames, and the pending bound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const f = v2(t), socket = f.sockets[0]!;
  await assert.rejects(f.instance.leadRpc('settings.get', {}), (error: any) => error.code === 'disconnected', 'before open');
  socket.open();
  const slow = f.instance.leadRpc('settings.get', {}, { timeoutMs: 5_000 });
  let settled = false; slow.then(() => { settled = true; }, () => { settled = true; });
  t.mock.timers.tick(4_999); await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await assert.rejects(slow, (error: any) => error instanceof LeadRpcError && error.code === 'timeout' && error.op === 'settings.get');
  assert.doesNotThrow(() => socket.receive({ type: 'lead_rpc_result', id: leadRpcs(socket)[0].id, ok: true, result: settingsView() }));
  assert.equal(socket.closed, undefined, 'a stale reply is ignored');
  const byDefault = f.instance.leadRpc('settings.get', {});
  let defaultSettled = false; byDefault.then(() => { defaultSettled = true; }, () => { defaultSettled = true; });
  t.mock.timers.tick(9_999); await Promise.resolve();
  assert.equal(defaultSettled, false);
  t.mock.timers.tick(1);
  await assert.rejects(byDefault, (error: any) => error.code === 'timeout', 'default timeout is the bridge rpc timeout (10 s)');
  // Oversized: ten near-max rows exceed the 64 KiB frame → too_large, nothing sent.
  const big = Array.from({ length: 10 }, (_, i) => leadRecord({ lead: `fm:0b6f1f0e-3c7d-4a51-9e0b-1f2a3b4c5d${String(i).padStart(2, '0')}`, goal: 'g'.repeat(1000),
    workers: Array.from({ length: 20 }, (_, w) => ({ session_key: `fm:w-${i}-${w}`, name: 'w'.repeat(200), state: 'working' as const, permission_mode: 'bypass' as const, needs_attention: false })) }));
  const sentBefore = leadRpcs(socket).length;
  await assert.rejects(f.instance.leadRpc('lead.sync', { records: big }), (error: any) => error.code === 'too_large');
  assert.equal(leadRpcs(socket).length, sentBefore);
  // Bounded pending.
  const pending = Array.from({ length: LEAD_RPC_MAX_PENDING }, () => f.instance.leadRpc('settings.get', {}, { timeoutMs: 60_000 }));
  for (const p of pending) p.catch(() => {});
  await assert.rejects(f.instance.leadRpc('settings.get', {}), (error: any) => error.code === 'unavailable');
  // A close fails every pending lead rpc with `disconnected`.
  socket.close(1006, 'gone');
  const results = await Promise.allSettled(pending);
  assert.ok(results.every((r) => r.status === 'rejected' && (r.reason as LeadRpcError).code === 'disconnected'));
  await assert.rejects(f.instance.leadRpc('settings.get', {}), (error: any) => error.code === 'disconnected');
  // The legacy bridge (no identity) has no lead_rpc.
  const legacy = bridge(t), legacySocket = legacy.sockets[0]!; legacySocket.open();
  await assert.rejects(legacy.instance.leadRpc('settings.get', {}), (error: any) => error instanceof LeadRpcError && error.code === 'unavailable');
  assert.equal(leadRpcs(legacySocket).length, 0);
});
