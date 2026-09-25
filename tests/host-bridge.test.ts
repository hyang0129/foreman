import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostBridge } from '../server/host-bridge.ts';
import { MAX_BODY, MAX_RESPONSE, MAX_REQUEST_FRAME, MAX_RESPONSE_FRAME } from '../shared/relay.ts';
import { notifyId, type NotifyFrame } from '../shared/notify.ts';

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

test('notify while disconnected queues and flushes once on the next open, without replay', (t) => {
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
  assert.deepEqual(second.sent.map((entry) => entry.type), ['hello', 'notify', 'notify']);
  assert.deepEqual(notifies(second).map((entry) => entry.session_name), ['session 2', 'session 3']);
  second.close(); t.mock.timers.tick(2000);
  const third = f.sockets[2]!; third.open();
  assert.equal(notifies(third).length, 0, 'flushed frames are not re-sent on later connections');
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
  const code = `import {startHostBridge} from ${JSON.stringify(moduleUrl)}; const b = startHostBridge(1, 'local'); console.log(typeof b.close, typeof b.notify); b.close(); process.exit(0);`;
  const env: NodeJS.ProcessEnv = { ...process.env, FOREMAN_HOME: home };
  delete env.FOREMAN_RELAY_URL; delete env.FOREMAN_HOST_TOKEN;
  const run = (overrides = {}) => execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { env: { ...env, ...overrides }, encoding: 'utf8' }).trim().split('\n').at(-1);
  assert.equal(run(), 'function undefined', 'local-only mode: no notify, so no notifier is wired');
  assert.equal(run({ FOREMAN_RELAY_URL: 'https://foreman.invalid', FOREMAN_HOST_TOKEN: TOKEN }), 'function function');
});
