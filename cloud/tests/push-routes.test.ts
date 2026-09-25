// Push routes, subscription storage, notify frames and the Mac-offline alarm, exercised through
// the real Worker and HostRelay Durable Object. Outbound fetches are intercepted: the Firebase
// JWKS URL serves a locally generated key (so real bearer verification runs), and allowlisted
// push-service URLs are recorded and answered by a fake push service that decrypts every body.
import { env, exports } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker, { HostRelay, MAX_SUBSCRIPTIONS, OFFLINE_AFTER, RATE_LIMIT } from '../worker.ts';
import { buildPushPayload, type NotifyFrame } from '../../shared/notify.ts';
import { loadVapidKeys } from '../push.ts';
import { decryptPush, newReceiver, verifyVapid, type Receiver } from './push-helpers.ts';

const ORIGIN = 'https://foreman.test';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const CONTRACT_B = ['v', 'kind', 'host', 'session_key', 'session_name', 'at', 'tag', 'title', 'body', 'url'];

let signingKey: CryptoKey, jwks: unknown;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  jwks = { keys: [{ ...await exportJWK(pair.publicKey), kid: 'push-test', alg: 'RS256', use: 'sig' }] };
});
async function idToken(email: string = env.ALLOWED_EMAIL) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, email_verified: true, firebase: { sign_in_provider: 'google.com' }, auth_time: now - 20 })
    .setProtectedHeader({ alg: 'RS256', kid: 'push-test' }).setIssuer(`https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`)
    .setAudience(env.FIREBASE_PROJECT_ID).setSubject('owner-uid').setIssuedAt(now - 10).setExpirationTime(now + 3600).sign(signingKey);
}

// ---- fake push service -----------------------------------------------------------------------
type Push = { endpoint: string; headers: Headers; body: Uint8Array; payload: any };
let pushes: Push[] = [];
let receivers = new Map<string, Receiver>();
let pushStatus = 201;
let otherFetches: string[] = [];
beforeEach(() => {
  pushes = []; receivers = new Map(); pushStatus = 201; otherFetches = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === JWKS_URL) return Response.json(jwks);
    const receiver = receivers.get(request.url);
    if (receiver) {
      const body = new Uint8Array(await request.arrayBuffer());
      pushes.push({ endpoint: request.url, headers: request.headers, body, payload: body.length ? JSON.parse(await decryptPush(body, receiver)) : null });
      return new Response(null, { status: pushStatus });
    }
    otherFetches.push(new URL(request.url).hostname);
    return realFetch(input, init);
  });
});
const sockets: WebSocket[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) { try { socket.close(1000, 'Test complete'); } catch {} }
  // Nothing but the JWKS and the fake push service may be contacted.
  expect(otherFetches).toEqual([]);
});

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 3000) {
  for (let waited = 0; waited < ms; waited += 10) { if (await check()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`Timed out waiting for ${what}`);
}

let endpointCounter = 0;
async function newSubscription(host = 'fcm.googleapis.com') {
  const receiver = await newReceiver();
  const endpoint = `https://${host}/fcm/send/device-${++endpointCounter}-${crypto.randomUUID()}`;
  receivers.set(endpoint, receiver);
  return { endpoint, receiver, json: { endpoint, expirationTime: null, keys: { p256dh: receiver.p256dh, auth: receiver.auth } } };
}

// ---- Worker-level helpers ------------------------------------------------------------------
async function api(path: string, body?: unknown, { token, origin, method = 'POST' }: { token?: string | null; origin?: string; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const bearer = token === undefined ? await idToken() : token;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (origin) headers.origin = origin;
  return exports.default.fetch(`${ORIGIN}${path}`, { method, headers, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body ?? {})) : undefined });
}
const ownerRelay = () => env.RELAY.get(env.RELAY.idFromName(env.ALLOWED_EMAIL));
// Worker routes all share the owner's Durable Object; start each test from empty push state.
beforeEach(() => runInDurableObject(ownerRelay(), async (_instance: HostRelay, ctx) => {
  ctx.storage.sql.exec('DELETE FROM push_subscriptions; DELETE FROM push_log; DELETE FROM push_state;');
  await ctx.storage.deleteAlarm();
}));

// ---- DO-level helpers ------------------------------------------------------------------------
function relay() { return env.RELAY.get(env.RELAY.idFromName(crypto.randomUUID())); }
type Stub = ReturnType<typeof relay>;
async function connect(stub: Stub, host = 'Test Mac') {
  const response = await stub.fetch(`${ORIGIN}/api/host/connect`, { headers: { upgrade: 'websocket', authorization: `Bearer ${env.HOST_TOKEN}` } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept(); sockets.push(socket);
  const frames: any[] = [];
  socket.addEventListener('message', (event) => { frames.push(JSON.parse(String(event.data))); });
  socket.send(JSON.stringify({ type: 'hello', host }));
  await until(() => frames.some((frame) => frame.type === 'pong'), 'hello pong');
  return { socket, frames };
}
// A ping round trip proves the DO has processed every frame sent before it.
async function flush(host: Awaited<ReturnType<typeof connect>>) {
  const count = host.frames.filter((frame) => frame.type === 'pong').length;
  host.socket.send(JSON.stringify({ type: 'ping' }));
  await until(() => host.frames.filter((frame) => frame.type === 'pong').length > count, 'ping pong');
}
async function subscribe(stub: Stub, kinds?: string[]) {
  const subscription = await newSubscription();
  const response = await stub.fetch(`${ORIGIN}/api/push/subscribe`, { method: 'POST', body: JSON.stringify({ subscription: subscription.json, device_label: 'Pixel', ...(kinds ? { kinds } : {}) }) });
  expect(response.status).toBe(200);
  return { ...subscription, id: ((await response.json()) as { id: string }).id };
}
const state = (stub: Stub, key: string) => runInDurableObject(stub, (_instance: HostRelay, ctx) => ctx.storage.sql.exec<{ value: string }>('SELECT value FROM push_state WHERE key = ?', key).toArray()[0]?.value ?? null);
const setState = (stub: Stub, key: string, value: string) => runInDurableObject(stub, (_instance: HostRelay, ctx) => { ctx.storage.sql.exec('INSERT OR REPLACE INTO push_state (key, value) VALUES (?, ?)', key, value); });
const storedEndpoints = (stub: Stub) => runInDurableObject(stub, (_instance: HostRelay, ctx) => ctx.storage.sql.exec<{ endpoint: string }>('SELECT endpoint FROM push_subscriptions ORDER BY created_at, rowid').toArray().map((row) => row.endpoint));
function frame(overrides: Partial<NotifyFrame> = {}): NotifyFrame {
  return { type: 'notify', id: `approval_requested:${crypto.randomUUID().slice(0, 12)}`, kind: 'approval_requested', host: 'Test Mac', session_key: 'fm:1234', session_name: 'Fix the build', at: '2026-09-24T12:00:00.000Z', ...overrides };
}

describe('GET /api/config push key', () => {
  it('publishes the VAPID public key derived from the secret', async () => {
    const body = await (await exports.default.fetch(`${ORIGIN}/api/config`)).json() as any;
    expect(body.push).toEqual({ vapid_public_key: (await loadVapidKeys(env.VAPID_PRIVATE_KEY))!.publicKeyB64 });
    expect(JSON.stringify(body)).not.toContain(JSON.parse(env.VAPID_PRIVATE_KEY!).d);
  });
  it('is null without the secret, and push routes answer 503', async () => {
    const without = { ...env, VAPID_PRIVATE_KEY: undefined } as Env;
    const config = await worker.fetch(new Request(`${ORIGIN}/api/config`), without);
    expect((await config.json() as any).push).toBeNull();
    const test = await worker.fetch(new Request(`${ORIGIN}/api/push/test`, { method: 'POST', headers: { authorization: `Bearer ${await idToken()}` }, body: '{}' }), without);
    expect(test.status).toBe(503);
    const subscribe = await worker.fetch(new Request(`${ORIGIN}/api/push/subscribe`, { method: 'POST', headers: { authorization: `Bearer ${await idToken()}` }, body: '{}' }), without);
    expect(subscribe.status).toBe(503);
  });
});

describe('push route boundary', () => {
  const routes = ['/api/push/subscribe', '/api/push/unsubscribe', '/api/push/test'];
  it('requires a bearer token (401) for the allowed account (403) from the same origin (403)', async () => {
    for (const route of routes) {
      expect((await api(route, {}, { token: null })).status).toBe(401);
      expect((await api(route, {}, { token: 'invalid' })).status).toBe(403);
      expect((await api(route, {}, { token: await idToken('intruder@example.com') })).status).toBe(403);
      expect((await api(route, {}, { origin: 'https://attacker.invalid' })).status).toBe(403);
    }
  });
  it('terminates in the Worker/DO: unknown push routes 404, and nothing reaches the host', async () => {
    const host = await connect(ownerRelay());
    const before = host.frames.length;
    expect((await api('/api/push/other', {})).status).toBe(404);
    expect((await api('/api/push/subscribe', undefined, { method: 'GET' })).status).toBe(404);
    expect((await api('/api/push/test?x=1', {})).status).toBe(404);
    const { json } = await newSubscription();
    expect((await api('/api/push/subscribe', { subscription: json })).status).toBe(200);
    expect((await api('/api/push/test', {})).status).toBe(200);
    expect((await api('/api/push/unsubscribe', { endpoint: json.endpoint })).status).toBe(200);
    await flush(host);
    expect(host.frames.slice(before).filter((f) => f.type !== 'pong')).toEqual([]);
  });
  it('subscribe then test sends one encrypted, VAPID-signed push with only contract B fields', async () => {
    const { json, endpoint } = await newSubscription();
    const response = await api('/api/push/subscribe', { subscription: json, device_label: 'Pixel 9', kinds: ['approval_requested'] });
    expect(response.status).toBe(200);
    const created = await response.json() as any;
    expect(Object.keys(created).sort()).toEqual(['id', 'ok']);
    expect(JSON.stringify(created)).not.toContain(endpoint);
    const test = await api('/api/push/test', { id: created.id });
    expect(test.status).toBe(200);
    expect(await test.json()).toEqual({ ok: true, sent: 1, failed: 0 });
    expect(pushes).toHaveLength(1);
    const push = pushes[0]!;
    expect(push.endpoint).toBe(endpoint);
    expect(push.headers.get('content-encoding')).toBe('aes128gcm');
    expect(push.headers.get('ttl')).toBe('3600');
    expect(push.headers.get('urgency')).toBe('high');
    expect(push.headers.get('topic')).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    const vapid = await verifyVapid(push.headers.get('authorization')!);
    expect(vapid.valid).toBe(true);
    expect(vapid.publicKey).toBe((await loadVapidKeys(env.VAPID_PRIVATE_KEY))!.publicKeyB64);
    expect(vapid.claims).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: `mailto:${env.ALLOWED_EMAIL}` });
    expect(push.payload).toMatchObject({ v: 1, kind: 'test', tag: 'test', url: '/', title: 'Foreman notifications are on' });
    for (const key of Object.keys(push.payload)) expect(CONTRACT_B).toContain(key);
  });
  it('validates subscribe bodies strictly', async () => {
    const { json } = await newSubscription();
    const offCurve = 'B' + 'A'.repeat(86);
    const cases: [unknown, number][] = [
      [{ subscription: { ...json, endpoint: 'https://attacker.invalid/push' } }, 400],
      [{ subscription: { ...json, endpoint: json.endpoint.replace('https:', 'http:') } }, 400],
      [{ subscription: { ...json, endpoint: 'https://127.0.0.1/push' } }, 400],
      [{ subscription: { ...json, keys: { p256dh: json.keys.p256dh.slice(0, 40), auth: json.keys.auth } } }, 400],
      [{ subscription: { ...json, keys: { p256dh: offCurve, auth: json.keys.auth } } }, 400],
      [{ subscription: { ...json, keys: { p256dh: json.keys.p256dh, auth: 'short' } } }, 400],
      [{ subscription: { ...json, keys: { ...json.keys, extra: 'x' } } }, 400],
      [{ subscription: { ...json, extra: true } }, 400],
      [{ subscription: json, admin: true }, 400],
      [{ subscription: json, kinds: ['turn_finished'] }, 400],
      [{ subscription: json, kinds: 'approval_requested' }, 400],
      [{ subscription: json, device_label: 42 }, 400],
      [{}, 400],
      ['[1,2]', 400],
      ['{not json', 400],
      [{ subscription: json, device_label: 'x'.repeat(5000) }, 413],
    ];
    for (const [body, status] of cases) expect((await api('/api/push/subscribe', body)).status, JSON.stringify(body).slice(0, 120)).toBe(status);
    expect(await storedEndpoints(ownerRelay())).toEqual([]);
  });
  it('stores a cleaned label and default kinds; re-subscribing the same endpoint updates in place', async () => {
    const { json } = await newSubscription();
    const first = await (await api('/api/push/subscribe', { subscription: json, device_label: '  Pixel\n‮9 ' + 'x'.repeat(100) })).json() as any;
    const second = await (await api('/api/push/subscribe', { subscription: json, kinds: ['pm_failed', 'pm_failed'] })).json() as any;
    expect(second.id).toBe(first.id);
    const rows = await runInDurableObject(ownerRelay(), (_i: HostRelay, ctx) => ctx.storage.sql.exec<{ device_label: string; kinds: string }>('SELECT device_label, kinds FROM push_subscriptions').toArray());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kinds).toBe('["pm_failed"]');
    expect(rows[0]!.device_label).toBe('');
    const other = await newSubscription();
    await api('/api/push/subscribe', { subscription: other.json, device_label: '  Pixel\n‮9 ' + 'x'.repeat(100) });
    const labels = await runInDurableObject(ownerRelay(), (_i: HostRelay, ctx) => ctx.storage.sql.exec<{ device_label: string; kinds: string }>('SELECT device_label, kinds FROM push_subscriptions ORDER BY rowid').toArray());
    expect(Array.from(labels[1]!.device_label).length).toBeLessThanOrEqual(60);
    expect(labels[1]!.device_label.startsWith('Pixel 9 x')).toBe(true);
    expect(JSON.parse(labels[1]!.kinds)).toEqual(['approval_requested', 'question_asked', 'session_failed', 'pm_failed', 'host_offline']);
  });
  it('unsubscribe removes the subscription; test then has nobody to notify', async () => {
    const { json } = await newSubscription();
    await api('/api/push/subscribe', { subscription: json });
    expect(await (await api('/api/push/unsubscribe', { endpoint: json.endpoint })).json()).toEqual({ ok: true, removed: true });
    expect(await (await api('/api/push/unsubscribe', { endpoint: json.endpoint })).json()).toEqual({ ok: true, removed: false });
    expect((await api('/api/push/unsubscribe', {})).status).toBe(400);
    expect((await api('/api/push/test', {})).status).toBe(404);
    expect(pushes).toEqual([]);
  });
  it('a 410 (or 404) from the push service deletes the subscription', async () => {
    const gone = await newSubscription(), kept = await newSubscription();
    await api('/api/push/subscribe', { subscription: gone.json });
    const keptId = (await (await api('/api/push/subscribe', { subscription: kept.json })).json() as any).id;
    pushStatus = 410;
    expect(await (await api('/api/push/test', { endpoint: gone.json.endpoint })).json()).toEqual({ ok: true, sent: 0, failed: 1 });
    expect(await storedEndpoints(ownerRelay())).toEqual([kept.endpoint]);
    pushStatus = 404;
    await api('/api/push/test', { id: keptId });
    expect(await storedEndpoints(ownerRelay())).toEqual([]);
    expect(pushes).toHaveLength(2);
  });
  it('rate-limits test pushes and keeps at most 20 subscriptions, evicting the oldest', async () => {
    const endpoints: string[] = [];
    for (let i = 0; i < MAX_SUBSCRIPTIONS + 2; i++) {
      const { json } = await newSubscription();
      endpoints.push(json.endpoint);
      expect((await api('/api/push/subscribe', { subscription: json })).status).toBe(200);
    }
    expect(await storedEndpoints(ownerRelay())).toEqual(endpoints.slice(2));
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await api('/api/push/test', { endpoint: endpoints.at(-1) })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe('notify frames from the host', () => {
  it('a valid frame produces exactly one push, rendered by the shared renderer', async () => {
    const stub = relay(), host = await connect(stub), subscription = await subscribe(stub);
    const notify = frame();
    host.socket.send(JSON.stringify(notify));
    await until(() => pushes.length === 1, 'one push');
    await flush(host);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.endpoint).toBe(subscription.endpoint);
    expect(pushes[0]!.payload).toEqual(buildPushPayload(notify));
    expect(pushes[0]!.payload).toMatchObject({ kind: 'approval_requested', url: '/?session=fm%3A1234', tag: 'session:fm:1234', session_name: 'Fix the build' });
    for (const key of Object.keys(pushes[0]!.payload)) expect(CONTRACT_B).toContain(key);
    expect(pushes[0]!.headers.get('topic')).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  });
  it('de-duplicates on id', async () => {
    const stub = relay(), host = await connect(stub); await subscribe(stub);
    const first = frame(), second = frame({ kind: 'pm_failed', session_key: undefined, session_name: undefined });
    delete second.session_key; delete second.session_name;
    host.socket.send(JSON.stringify(first)); host.socket.send(JSON.stringify(first)); host.socket.send(JSON.stringify(second));
    await until(() => pushes.length >= 2, 'two pushes');
    await flush(host); await new Promise((r) => setTimeout(r, 100));
    expect(pushes.map((push) => push.payload.kind).sort()).toEqual(['approval_requested', 'pm_failed']);
  });
  it('sends only to subscriptions whose kinds include the frame kind', async () => {
    const stub = relay(), host = await connect(stub);
    const approvals = await subscribe(stub, ['approval_requested']);
    const pm = await subscribe(stub, ['pm_failed']);
    host.socket.send(JSON.stringify(frame()));
    const pmFrame = frame({ id: 'pm_failed:abc' }); pmFrame.kind = 'pm_failed'; delete pmFrame.session_key; delete pmFrame.session_name;
    host.socket.send(JSON.stringify(pmFrame));
    await until(() => pushes.length >= 2, 'two pushes');
    await flush(host); await new Promise((r) => setTimeout(r, 100));
    expect(pushes.map((push) => [push.endpoint, push.payload.kind]).sort()).toEqual([[approvals.endpoint, 'approval_requested'], [pm.endpoint, 'pm_failed']].sort());
  });
  it(`drops notifications beyond ${RATE_LIMIT} per 10 minutes`, async () => {
    const stub = relay(), host = await connect(stub); await subscribe(stub);
    for (let i = 0; i < RATE_LIMIT + 5; i++) host.socket.send(JSON.stringify(frame({ id: `approval_requested:n${i}` })));
    await until(() => pushes.length >= RATE_LIMIT, `${RATE_LIMIT} pushes`);
    await flush(host); await new Promise((r) => setTimeout(r, 150));
    expect(pushes).toHaveLength(RATE_LIMIT);
  });
  it('ignores and counts invalid notify frames without closing the socket; relaying still works', async () => {
    const stub = relay(), host = await connect(stub); await subscribe(stub);
    const invalid = [
      { ...frame(), extra: 'transcript text' },
      { ...frame(), kind: 'turn_finished' },
      { ...frame(), at: 'yesterday' },
      { ...frame(), id: 'has spaces' },
      { ...frame(), session_name: 'x'.repeat(3000) },
    ];
    for (const item of invalid) host.socket.send(JSON.stringify(item));
    await flush(host);
    expect(await state(stub, 'invalid_notify')).toBe(String(invalid.length));
    const incoming = new Promise<any>((resolve) => host.socket.addEventListener('message', (event) => { const m = JSON.parse(String(event.data)); if (m.type === 'request') resolve(m); }));
    const response = stub.fetch(`${ORIGIN}/api/sessions`);
    const request = await incoming;
    host.socket.send(JSON.stringify({ type: 'response', id: request.id, status: 200, body: '[]' }));
    expect((await response).status).toBe(200);
    expect(pushes).toEqual([]);
  });
  it('degrades to no push when the VAPID secret is absent', async () => {
    const stub = relay(), host = await connect(stub); await subscribe(stub);
    await runInDurableObject(stub, (instance: HostRelay) => { Object.defineProperty(instance, 'env', { value: { ...env, VAPID_PRIVATE_KEY: undefined } }); });
    host.socket.send(JSON.stringify(frame()));
    await flush(host); await new Promise((r) => setTimeout(r, 100));
    expect(pushes).toEqual([]);
    expect((await stub.fetch(`${ORIGIN}/api/push/test`, { method: 'POST', body: '{}' })).status).toBe(503);
  });
});

describe('Mac offline alarm', () => {
  async function disconnect(stub: Stub, host: Awaited<ReturnType<typeof connect>>) {
    host.socket.close(1000, 'Network lost');
    await until(async () => (await state(stub, 'outage_since')) !== null, 'outage recorded');
  }
  const backdate = (stub: Stub) => setState(stub, 'outage_since', String(Date.now() - OFFLINE_AFTER - 60_000));

  it('sends one host_offline push after more than 5 minutes down, and not again in that outage', async () => {
    const stub = relay(), host = await connect(stub, 'Studio Mac'); await subscribe(stub);
    await disconnect(stub, host);
    // Before the 5-minute mark the alarm only reschedules.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(pushes).toEqual([]);
    await backdate(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.payload).toMatchObject({ kind: 'host_offline', host: 'Studio Mac', tag: 'host', url: '/', title: 'Mac offline' });
    // Notified: the alarm stops, and even a forced run sends nothing more.
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    await runInDurableObject(stub, (_i: HostRelay, ctx) => ctx.storage.setAlarm(Date.now() + 1000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(pushes).toHaveLength(1);
    // A reconnect ends the outage; the next one can notify again.
    const again = await connect(stub);
    expect(await state(stub, 'offline_notified')).toBeNull();
    await disconnect(stub, again); await backdate(stub);
    await runDurableObjectAlarm(stub);
    expect(pushes).toHaveLength(2);
  });
  it('sends nothing when the host reconnects within 5 minutes', async () => {
    const stub = relay(), host = await connect(stub); await subscribe(stub);
    await disconnect(stub, host);
    await connect(stub);
    expect(await state(stub, 'outage_since')).toBeNull();
    // The periodic check sees a live host and keeps quiet.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(pushes).toEqual([]);
    expect(await runInDurableObject(stub, (_i: HostRelay, ctx) => ctx.storage.getAlarm())).not.toBeNull();
  });
  it('catches a silently stale host socket through the periodic check', async () => {
    const stub = relay(), host = await connect(stub); await subscribe(stub);
    expect(await runInDurableObject(stub, (_i: HostRelay, ctx) => ctx.storage.getAlarm())).not.toBeNull();
    await runInDurableObject(stub, (_instance: HostRelay, ctx) => {
      for (const socket of ctx.getWebSockets('host')) socket.serializeAttachment({ host: 'Test Mac', lastSeen: Date.now() - OFFLINE_AFTER - 70_000 });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.payload.kind).toBe('host_offline');
    expect(host.socket.readyState).toBe(1);
  });
  it('does not arm the alarm for nobody, or for subscriptions that opted out of host_offline', async () => {
    const stub = relay(), host = await connect(stub);
    await disconnect(stub, host).catch(() => {});
    expect(await runInDurableObject(stub, (_i: HostRelay, ctx) => ctx.storage.getAlarm())).toBeNull();
    await subscribe(stub, ['approval_requested']);
    const again = await connect(stub);
    again.socket.close(1000, 'gone');
    await new Promise((r) => setTimeout(r, 100));
    expect(await runInDurableObject(stub, (_i: HostRelay, ctx) => ctx.storage.getAlarm())).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    expect(pushes).toEqual([]);
  });
});
