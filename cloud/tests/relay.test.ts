import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { allowedRequest, MAX_BODY } from '../../shared/relay.ts';
import { UNNAMED_HOST } from '../worker.ts';

const sockets: WebSocket[] = [];
afterEach(() => { for (const socket of sockets.splice(0)) { try { socket.close(1000, 'Test complete'); } catch {} } });
function relay() { return env.RELAY.get(env.RELAY.idFromName(crypto.randomUUID())); }
async function connect(stub: ReturnType<typeof relay>) {
  const response = await stub.fetch('https://foreman.test/api/host/connect', { headers: { upgrade: 'websocket', authorization: `Bearer ${env.HOST_TOKEN}` } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept(); sockets.push(socket);
  return socket;
}
function nextMessage(socket: WebSocket): Promise<any> {
  return new Promise((resolve) => socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data))), { once: true }));
}
async function request(stub: ReturnType<typeof relay>, socket: WebSocket, path = '/api/sessions') {
  const incoming = nextMessage(socket);
  const response = stub.fetch(`https://foreman.test${path}`);
  const message = await incoming;
  return { response, message };
}

describe('public Worker boundary', () => {
  it('exposes public Firebase configuration without exposing the host secret', async () => {
    const response = await exports.default.fetch('https://foreman.test/api/config');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body).auth.required).toBe(true);
    expect(body).not.toContain(env.HOST_TOKEN);
  });
  it('rejects unauthenticated APIs and malformed identity tokens', async () => {
    expect((await exports.default.fetch('https://foreman.test/api/sessions')).status).toBe(401);
    expect((await exports.default.fetch('https://foreman.test/api/sessions', { headers: { authorization: 'Bearer invalid' } })).status).toBe(403);
  });
  it('requires both websocket upgrade and the host secret', async () => {
    expect((await exports.default.fetch('https://foreman.test/api/host/connect')).status).toBe(400);
    expect((await exports.default.fetch('https://foreman.test/api/host/connect', { headers: { upgrade: 'websocket' } })).status).toBe(401);
    expect((await exports.default.fetch('https://foreman.test/api/host/connect', { headers: { upgrade: 'websocket', authorization: 'Bearer wrong-secret' } })).status).toBe(401);
  });
});

describe('Durable Object host relay with real WebSocket pairs', () => {
  it('reports offline and refuses mutations while disconnected', async () => {
    const stub = relay();
    expect(await (await stub.fetch('https://foreman.test/api/host')).json()).toMatchObject({ online: false });
    const response = await stub.fetch('https://foreman.test/api/session/message', { method: 'POST', body: '{}' });
    expect(response.status).toBe(503);
    expect(await response.json()).toHaveProperty('error');
  });
  it('checks the host secret inside the DO too', async () => {
    expect((await relay().fetch('https://foreman.test/api/host/connect', { headers: { upgrade: 'websocket' } })).status).toBe(401);
  });
  it('forwards an allowlisted request and correlates its response', async () => {
    const stub = relay(), socket = await connect(stub);
    const pong = nextMessage(socket); socket.send(JSON.stringify({ type: 'hello', host: 'Test Mac' }));
    expect((await pong).type).toBe('pong');
    expect(await (await stub.fetch('https://foreman.test/api/host')).json()).toMatchObject({ online: true, host: 'Test Mac' });
    const { message, response } = await request(stub, socket, '/api/session?id=fm%3A123');
    expect(message).toMatchObject({ type: 'request', method: 'GET', path: '/api/session?id=fm%3A123', body: '' });
    socket.send(JSON.stringify({ type: 'response', id: message.id, status: 200, body: '{"session":{"name":"test"}}' }));
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ session: { name: 'test' } });
    expect(result.headers.get('cache-control')).toBe('no-store');
  });
  it('replacing the host fails in-flight delivery and routes new requests to the replacement', async () => {
    // #26: sockets are keyed by machine_id, so a replacement is a reconnect from the same machine.
    const machine_id = crypto.randomUUID();
    const hello = async (socket: WebSocket) => {
      const pong = new Promise<void>((resolve) => socket.addEventListener('message', (event) => { if (JSON.parse(String(event.data)).type === 'pong') resolve(); }));
      socket.send(JSON.stringify({ type: 'hello', protocol: 2, machine_id, host: 'Test Mac', platform: 'darwin', pm_open_turns: [] }));
      await pong;
    };
    const stub = relay(), original = await connect(stub);
    await hello(original);
    const first = await request(stub, original);
    const replacement = await connect(stub);
    await hello(replacement);
    expect((await first.response).status).toBe(503);
    const second = await request(stub, replacement);
    replacement.send(JSON.stringify({ type: 'response', id: second.message.id, status: 200, body: '[]' }));
    expect((await second.response).status).toBe(200);
  });
  it('host disconnect fails pending requests explicitly', async () => {
    const stub = relay(), socket = await connect(stub);
    const pending = await request(stub, socket);
    socket.close(1000, 'Network lost');
    expect((await pending.response).status).toBe(503);
  });
  it('malformed frames fail pending requests instead of throwing', async () => {
    const stub = relay(), socket = await connect(stub);
    const pending = await request(stub, socket);
    socket.send('null');
    expect((await pending.response).status).toBe(503);
  });
  it('invalid response statuses produce a 502 and null-body statuses complete safely', async () => {
    const stub = relay(), socket = await connect(stub);
    const invalid = await request(stub, socket);
    socket.send(JSON.stringify({ type: 'response', id: invalid.message.id, status: 999, body: '{}' }));
    expect((await invalid.response).status).toBe(502);
    const empty = await request(stub, socket);
    socket.send(JSON.stringify({ type: 'response', id: empty.message.id, status: 204, body: 'ignored' }));
    const response = await empty.response;
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });
  it('rejects invalid routes and oversized requests before forwarding', async () => {
    const stub = relay(); await connect(stub);
    expect((await stub.fetch('https://foreman.test/api/exec', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await stub.fetch('https://foreman.test/api/session/message', { method: 'POST', body: 'x'.repeat(MAX_BODY + 1) })).status).toBe(413);
  });
  it(`#144: a host socket that has not said hello yet is named "${UNNAMED_HOST}", not "Mac"`, async () => {
    const stub = relay(); await connect(stub);
    const status = await (await stub.fetch('https://foreman.test/api/host')).json();
    expect(status).toMatchObject({ online: true, host: UNNAMED_HOST });
    expect(JSON.stringify(status)).not.toContain('Mac');
  });
  it('stale host heartbeat reports offline', async () => {
    const stub = relay(); await connect(stub);
    await runInDurableObject(stub, (_instance, state) => {
      for (const socket of state.getWebSockets('host')) socket.serializeAttachment({ host: 'stale', lastSeen: Date.now() - 120_000 });
    });
    expect(await (await stub.fetch('https://foreman.test/api/host')).json()).toMatchObject({ online: false });
  });
});

it('the shared route contract refuses arbitrary paths and unsupported methods', () => {
  expect(allowedRequest('POST', '/api/session/message')).toBe(true);
  for (const [method, path] of [['GET', '//attacker.invalid/api/sessions'], ['GET', '/api/../admin'], ['GET', '/api/exec'], ['DELETE', '/api/sessions'], ['GET', '/api/sessions#fragment']]) {
    expect(allowedRequest(method!, path!)).toBe(false);
  }
});

describe('project registry relay contract', () => {
  it('requires identity on every project route and allowlists only explicit methods', async () => {
    const routes = [['GET', '/api/projects'], ...['resolve', 'register', 'update', 'remove'].map((action) => ['POST', `/api/projects/${action}`])];
    for (const [method, path] of routes) {
      expect(allowedRequest(method, path)).toBe(true);
      expect((await exports.default.fetch(`https://foreman.test${path}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) })).status).toBe(401);
    }
    expect(allowedRequest('GET', '/api/projects/register')).toBe(false);
    expect(allowedRequest('POST', '/api/projects')).toBe(false);
    expect(allowedRequest('GET', '/api/projects/list-directory')).toBe(false);
  });
});

// #157 D7: the launcher is removed, so no /api/launch* route is relayed.
it('relays no launcher routes', () => {
  expect(allowedRequest('GET', '/api/launch?id=123')).toBe(false);
  expect(allowedRequest('GET', '/api/launch')).toBe(false);
  expect(allowedRequest('POST', '/api/launch/propose')).toBe(false);
  expect(allowedRequest('POST', '/api/launch/cancel')).toBe(false);
  expect(allowedRequest('POST', '/api/launch')).toBe(false);
  expect(allowedRequest('GET', '/api/launch/propose')).toBe(false);
  expect(allowedRequest('POST', '/api/launch/execute')).toBe(false);
});

// #115: a relayed request picks its target only after its body is read, so a PM move during the
// read sends it to the machine that is the PM host now, never to the one that just became standby.
describe('PM move during a relayed request body read', () => {
  type Host = { socket: WebSocket; frames: any[]; machine_id: string };
  async function until(check: () => boolean, what: string) {
    for (let waited = 0; waited < 3000 && !check(); waited += 10) await new Promise((r) => setTimeout(r, 10));
    expect(check(), what).toBe(true);
  }
  async function host(stub: ReturnType<typeof relay>, name: string): Promise<Host> {
    const socket = await connect(stub);
    const frames: any[] = [];
    socket.addEventListener('message', (event) => { frames.push(JSON.parse(String(event.data))); });
    const machine_id = crypto.randomUUID();
    socket.send(JSON.stringify({ type: 'hello', protocol: 2, machine_id, host: name, platform: 'darwin', pm_open_turns: [] }));
    await until(() => frames.some((frame) => frame.type === 'pong'), `${name} hello`);
    return { socket, frames, machine_id };
  }
  const requests = (h: Host) => h.frames.filter((frame) => frame.type === 'request');
  // A ping round trip proves the DO processed every frame sent before it.
  async function flush(h: Host) {
    const pongs = () => h.frames.filter((frame) => frame.type === 'pong').length;
    const before = pongs();
    h.socket.send(JSON.stringify({ type: 'ping' }));
    await until(() => pongs() > before, 'ping pong');
  }

  it('POST /api/sessions whose body finishes after a move reaches the new PM host only', async () => {
    const stub = relay();
    const a = await host(stub, 'machine-a'); // bootstrap: A is the PM host at epoch 1
    const b = await host(stub, 'machine-b');
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull() { pulled = true; } });
    const response = stub.fetch('https://foreman.test/api/sessions', { method: 'POST', body, duplex: 'half' } as RequestInit);
    // The DO has the request and is waiting on its body.
    await until(() => pulled, 'the body read started');
    await new Promise((r) => setTimeout(r, 50));
    const moved = await stub.fetch('https://foreman.test/api/pm/host', { method: 'POST', body: JSON.stringify({ machine_id: b.machine_id, expected_epoch: 1 }) });
    expect(moved.status).toBe(200);
    controller.enqueue(new TextEncoder().encode('{"name":"after-the-move"}'));
    controller.close();
    await until(() => requests(b).length === 1, 'the request reaches B');
    expect(requests(b)[0]).toMatchObject({ method: 'POST', path: '/api/sessions', body: '{"name":"after-the-move"}' });
    b.socket.send(JSON.stringify({ type: 'response', id: requests(b)[0].id, status: 201, body: '{}' }));
    expect((await response).status).toBe(201);
    await flush(a);
    expect(requests(a)).toEqual([]);
  });

  // #143: the host re-picked after the body read can itself be offline by then.
  it('POST whose body finishes after a move to a host that then went offline gets 503 (that host is offline), never the old host', async () => {
    const stub = relay();
    const a = await host(stub, 'machine-a');
    const b = await host(stub, 'machine-b');
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull() { pulled = true; } });
    const response = stub.fetch('https://foreman.test/api/sessions', { method: 'POST', body, duplex: 'half' } as RequestInit);
    await until(() => pulled, 'the body read started');
    await new Promise((r) => setTimeout(r, 50));
    const moved = await stub.fetch('https://foreman.test/api/pm/host', { method: 'POST', body: JSON.stringify({ machine_id: b.machine_id, expected_epoch: 1 }) });
    expect(moved.status).toBe(200);
    b.socket.close(1000, 'Network lost');
    let offline = false;
    for (let waited = 0; waited < 3000 && !offline; waited += 10) {
      const status = await (await stub.fetch('https://foreman.test/api/pm/host')).json() as any;
      offline = status.machines.find((m: any) => m.machine_id === b.machine_id)?.online === false;
      if (!offline) await new Promise((r) => setTimeout(r, 10));
    }
    expect(offline, 'machine-b offline').toBe(true);
    controller.enqueue(new TextEncoder().encode('{"name":"after-the-move"}'));
    controller.close();
    const answer = await response;
    expect(answer.status).toBe(503);
    expect(((await answer.json()) as any).error).toContain('machine-b');
    await flush(a);
    expect(requests(a)).toEqual([]);
  });

  // #143: the 64-pending busy check runs again once the body is read.
  it('a POST whose body finishes after the pending table filled up gets 429 and is not sent', async () => {
    const stub = relay();
    const a = await host(stub, 'machine-a');
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull() { pulled = true; } });
    const response = stub.fetch('https://foreman.test/api/sessions', { method: 'POST', body, duplex: 'half' } as RequestInit);
    await until(() => pulled, 'the body read started');
    await new Promise((r) => setTimeout(r, 50));
    // 64 other requests reach the host and stay pending (the host never answers them).
    const others = Array.from({ length: 64 }, () => stub.fetch('https://foreman.test/api/sessions'));
    await until(() => requests(a).length === 64, '64 pending requests');
    controller.enqueue(new TextEncoder().encode('{"name":"late-body"}'));
    controller.close();
    const answer = await response;
    expect(answer.status).toBe(429);
    await flush(a);
    expect(requests(a).length).toBe(64);
    expect(requests(a).some((r) => r.method === 'POST')).toBe(false);
    // Answer the pending ones so nothing waits on the 45 s timeout.
    for (const r of requests(a)) a.socket.send(JSON.stringify({ type: 'response', id: r.id, status: 200, body: '[]' }));
    for (const other of await Promise.all(others)) expect(other.status).toBe(200);
  });
});
