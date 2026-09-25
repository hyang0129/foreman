import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { allowedRequest, MAX_BODY } from '../../shared/relay.ts';

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

// The launcher adds only these authenticated, narrowly allowlisted routes.
it('permits launcher proposal/status/cancel but no arbitrary launch endpoints', () => {
  expect(allowedRequest('GET', '/api/launch?id=123')).toBe(true);
  expect(allowedRequest('POST', '/api/launch/propose')).toBe(true);
  expect(allowedRequest('POST', '/api/launch/cancel')).toBe(true);
  expect(allowedRequest('POST', '/api/launch')).toBe(false);
  expect(allowedRequest('GET', '/api/launch/propose')).toBe(false);
  expect(allowedRequest('POST', '/api/launch/execute')).toBe(false);
});
