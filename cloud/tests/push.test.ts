import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { b64u, encryptPayload, fromB64u, loadVapidKeys, pushEndpointAllowed, sendPush, topicFor, validReceiverKeys, vapidJwt, VAPID_LIFETIME } from '../push.ts';
import { decodeJwt, decryptPush, ecdhPrivateKey, newReceiver, verifyVapid } from './push-helpers.ts';

// RFC 8291 Section 5 / Appendix A, verbatim (whitespace from the RFC's line wrapping removed).
const strip = (text: string) => text.replace(/\s+/g, '');
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: strip('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'),
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: strip('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: strip('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8'),
  ciphertext: strip('8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ'),
  body: strip(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
    mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
    pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`),
};
const utf8 = (text: string) => new Uint8Array(new TextEncoder().encode(text));

describe('RFC 8291 aes128gcm encryption', () => {
  it('reproduces the RFC 8291 Appendix A message byte-for-byte', async () => {
    const sender = { privateKey: await ecdhPrivateKey(RFC.asPrivate, RFC.asPublic), publicKey: fromB64u(RFC.asPublic)! };
    const body = await encryptPayload(utf8(RFC.plaintext), RFC.uaPublic, RFC.authSecret, { salt: fromB64u(RFC.salt)!, sender });
    // The two published halves and the published whole agree with each other...
    expect(RFC.body).toBe(b64u(new Uint8Array([...fromB64u(RFC.header)!, ...fromB64u(RFC.ciphertext)!])));
    // 86-byte header + 41-byte plaintext + delimiter + 16-byte tag. (The RFC's example request
    // says Content-Length: 145, but its own published body decodes to 144 bytes.)
    expect(fromB64u(RFC.body)!.length).toBe(144);
    expect(body.length).toBe(144);
    // ...and with every byte we produce.
    expect(b64u(body.slice(0, 86))).toBe(RFC.header);
    expect(b64u(body.slice(86))).toBe(RFC.ciphertext);
    expect(b64u(body)).toBe(RFC.body);
    expect(Array.from(body)).toEqual(Array.from(fromB64u(RFC.body)!));
  });
  it('the RFC receiver decrypts the RFC message with its private key', async () => {
    const receiver = { privateKey: await ecdhPrivateKey(RFC.uaPrivate, RFC.uaPublic), p256dh: RFC.uaPublic, auth: RFC.authSecret };
    expect(await decryptPush(fromB64u(RFC.body)!, receiver)).toBe(RFC.plaintext);
  });
  it('round-trips with fresh randomness and never repeats a ciphertext', async () => {
    const receiver = await newReceiver();
    const message = JSON.stringify({ v: 1, title: 'Approval needed', body: 'naïve ✓ 🎉' });
    const first = await encryptPayload(utf8(message), receiver.p256dh, receiver.auth);
    const second = await encryptPayload(utf8(message), receiver.p256dh, receiver.auth);
    expect(b64u(first)).not.toBe(b64u(second));
    expect(await decryptPush(first, receiver)).toBe(message);
    expect(await decryptPush(second, receiver)).toBe(message);
    const other = await newReceiver();
    await expect(decryptPush(first, { ...other, auth: receiver.auth })).rejects.toThrow();
  });
  it('refuses bad keys and payloads that exceed one record', async () => {
    const receiver = await newReceiver();
    await expect(encryptPayload(utf8('x'), 'not-a-key', receiver.auth)).rejects.toThrow();
    await expect(encryptPayload(utf8('x'), receiver.p256dh, b64u(new Uint8Array(15)))).rejects.toThrow();
    await expect(encryptPayload(new Uint8Array(4096 - 16), receiver.p256dh, receiver.auth)).rejects.toThrow(/too large/);
    expect(validReceiverKeys(receiver.p256dh, receiver.auth)).toBe(true);
    expect(validReceiverKeys(receiver.p256dh.slice(0, -2), receiver.auth)).toBe(false);
    expect(validReceiverKeys(receiver.p256dh, receiver.auth + '=')).toBe(false);
  });
});

describe('VAPID (RFC 8292)', () => {
  it('derives the public key from the configured JWK and rejects unusable secrets', async () => {
    const keys = await loadVapidKeys(env.VAPID_PRIVATE_KEY);
    const jwk = JSON.parse(env.VAPID_PRIVATE_KEY!);
    expect(keys?.publicKeyB64).toBe(b64u(new Uint8Array([4, ...fromB64u(jwk.x)!, ...fromB64u(jwk.y)!])));
    for (const bad of [undefined, '', 'not json', '{}', JSON.stringify({ ...jwk, crv: 'P-384' }), JSON.stringify({ ...jwk, d: undefined }), JSON.stringify({ ...jwk, y: jwk.x })]) {
      expect(await loadVapidKeys(bad)).toBeNull();
    }
  });
  it('signs an ES256 JWT for the endpoint origin that verifies with the advertised key', async () => {
    const keys = (await loadVapidKeys(env.VAPID_PRIVATE_KEY))!;
    const now = Math.floor(Date.now() / 1000);
    const jwt = await vapidJwt('https://fcm.googleapis.com/fcm/send/abc:def?x=1', 'mailto:owner@example.com', keys, now);
    const decoded = decodeJwt(jwt);
    expect(decoded.header).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(decoded.claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: now + VAPID_LIFETIME, sub: 'mailto:owner@example.com' });
    expect(decoded.claims.exp - now).toBeLessThanOrEqual(24 * 60 * 60);
    expect(decoded.claims.exp).toBeGreaterThan(now);
    expect(decoded.signature.length).toBe(64); // raw r||s, not DER
    const verified = await verifyVapid(`vapid t=${jwt}, k=${keys.publicKeyB64}`);
    expect(verified.valid).toBe(true);
    // A tampered claim no longer verifies.
    const [h, , s] = jwt.split('.');
    const forged = `${h}.${b64u(utf8(JSON.stringify({ ...decoded.claims, aud: 'https://attacker.invalid' })))}.${s}`;
    expect((await verifyVapid(`vapid t=${forged}, k=${keys.publicKeyB64}`)).valid).toBe(false);
  });
});

describe('push endpoint allowlist (SSRF guard)', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://eu-west.push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-by3p.notify.windows.com/w/?token=abc',
    'https://web.push.apple.com/QGxkc',
    'https://api.push.apple.com/3/device/abc',
  ])('allows %s', (endpoint) => expect(pushEndpointAllowed(endpoint)).toBe(true));
  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com.attacker.invalid/x',
    'https://attacker.invalid/fcm.googleapis.com',
    'https://evilpush.services.mozilla.com/x',
    'https://push.services.mozilla.com/x',
    'https://notify.windows.com/x',
    'https://user:pass@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'https://127.0.0.1/x',
    'https://localhost/x',
    'not a url',
    `https://fcm.googleapis.com/${'a'.repeat(2048)}`,
  ])('refuses %s', (endpoint) => expect(pushEndpointAllowed(endpoint)).toBe(false));
});

describe('sending', () => {
  it('posts an encrypted message with VAPID, TTL, urgency and a collapsing topic', async () => {
    const receiver = await newReceiver(), keys = (await loadVapidKeys(env.VAPID_PRIVATE_KEY))!;
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(null, { status: 201 }); }) as unknown as typeof fetch;
    const topic = await topicFor('session:fm:123');
    const status = await sendPush({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', ...receiver }, utf8('{"v":1}'), { vapid: keys, subject: 'mailto:owner@example.com', topic, fetcher });
    expect(status).toBe(201);
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe('https://fcm.googleapis.com/fcm/send/abc');
    expect(calls[0]!.init.method).toBe('POST');
    expect(headers).toMatchObject({ ttl: '3600', urgency: 'high', topic, 'content-encoding': 'aes128gcm' });
    expect(topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(await topicFor('session:fm:123')).toBe(topic);
    expect(await topicFor('session:fm:124')).not.toBe(topic);
    expect((await verifyVapid(headers.authorization!)).valid).toBe(true);
    expect(await decryptPush(calls[0]!.init.body as Uint8Array, receiver)).toBe('{"v":1}');
  });
  it('has a payload-less fallback (VAPID only, empty body) and refuses non-allowlisted endpoints', async () => {
    const receiver = await newReceiver(), keys = (await loadVapidKeys(env.VAPID_PRIVATE_KEY))!;
    const calls: RequestInit[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => { calls.push(init); return new Response(null, { status: 201 }); }) as unknown as typeof fetch;
    await sendPush({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', ...receiver }, null, { vapid: keys, subject: 'mailto:owner@example.com', fetcher });
    const headers = calls[0]!.headers as Record<string, string>;
    expect(calls[0]!.body).toBeNull();
    expect(headers['content-encoding']).toBeUndefined();
    expect(headers['content-length']).toBe('0');
    expect((await verifyVapid(headers.authorization!)).valid).toBe(true);
    await expect(sendPush({ endpoint: 'https://attacker.invalid/x', ...receiver }, null, { vapid: keys, subject: 'mailto:x@example.com', fetcher })).rejects.toThrow(/not allowed/);
    expect(calls).toHaveLength(1);
  });
});
