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

function bridge(t: test.TestContext, port = 4177) {
  t.mock.method(console, 'log', () => {});
  const sockets: FakeSocket[] = [];
  const options: any[] = [];
  const urls: URL[] = [];
  const instance = new HostBridge(port, { url: 'https://foreman.example', token: TOKEN }, {
    socketFactory: (url, opts) => { const socket = new FakeSocket(); urls.push(url); options.push(opts); sockets.push(socket); return socket as any; },
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
