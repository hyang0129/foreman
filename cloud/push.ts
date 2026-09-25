// Web Push for the relay, hand-rolled on WebCrypto (no dependencies):
//   - VAPID (RFC 8292): an ES256 JWT identifying this application server.
//   - Message encryption (RFC 8291) using the aes128gcm content coding (RFC 8188), one record.
// Subscription endpoints are capability URLs: treat them as secrets and never log them.

type Bytes = Uint8Array<ArrayBuffer>;
const encoder = new TextEncoder();
const utf8 = (text: string): Bytes => new Uint8Array(encoder.encode(text));

export const RECORD_SIZE = 4096;
export const PUSH_TTL = 3600;
// RFC 8292 caps `exp` at 24 hours; stay well inside it.
export const VAPID_LIFETIME = 12 * 60 * 60;

export function b64u(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]!);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Strict base64url (no padding, no whitespace). Returns null on anything else.
export function fromB64u(text: unknown): Bytes | null {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch { return null; }
}

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

// ---------------------------------------------------------------------------------------------
// VAPID keys. The Worker secret VAPID_PRIVATE_KEY is a P-256 private JWK; it also carries the
// public x/y coordinates, so the public key is derived from it rather than configured.

export interface VapidKeys { privateKey: CryptoKey; publicKey: Bytes; publicKeyB64: string }

const vapidCache = new Map<string, Promise<VapidKeys | null>>();

async function importVapid(secret: string): Promise<VapidKeys | null> {
  try {
    const jwk = JSON.parse(secret) as JsonWebKey;
    if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string') return null;
    const x = fromB64u(jwk.x), y = fromB64u(jwk.y), d = fromB64u(jwk.d);
    if (x?.length !== 32 || y?.length !== 32 || d?.length !== 32) return null;
    const privateKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const publicKey = concat(new Uint8Array([4]), x, y);
    // Importing the public half proves x/y is a point on the curve.
    await crypto.subtle.importKey('raw', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return { privateKey, publicKey, publicKeyB64: b64u(publicKey) };
  } catch { return null; }
}

// Null when the secret is absent or unusable: push is then disabled, never half-working.
export function loadVapidKeys(secret: string | undefined): Promise<VapidKeys | null> {
  if (typeof secret !== 'string' || !secret) return Promise.resolve(null);
  let keys = vapidCache.get(secret);
  if (!keys) { keys = importVapid(secret); vapidCache.set(secret, keys); }
  return keys;
}

export async function vapidJwt(endpoint: string, subject: string, keys: VapidKeys, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = b64u(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(encoder.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: now + VAPID_LIFETIME, sub: subject })));
  const input = `${header}.${claims}`;
  // WebCrypto ECDSA emits the IEEE P1363 r||s form, which is exactly what JWS ES256 uses.
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, utf8(input)));
  return `${input}.${b64u(signature)}`;
}

export async function vapidAuthorization(endpoint: string, subject: string, keys: VapidKeys, now?: number): Promise<string> {
  return `vapid t=${await vapidJwt(endpoint, subject, keys, now)}, k=${keys.publicKeyB64}`;
}

// ---------------------------------------------------------------------------------------------
// RFC 8291 encryption.

export interface SenderKeys { privateKey: CryptoKey; publicKey: Bytes }

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

export async function generateSenderKeys(): Promise<SenderKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer) };
}

export function validReceiverKeys(p256dh: unknown, auth: unknown): boolean {
  const key = fromB64u(p256dh), secret = fromB64u(auth);
  return key?.length === 65 && key[0] === 4 && secret?.length === 16;
}

// Encrypts `plaintext` for one subscription as a single aes128gcm record. `salt` and `sender`
// are random per message; they are parameters only so tests can reproduce RFC 8291 Appendix A.
export async function encryptPayload(plaintext: Uint8Array, p256dh: string, auth: string, options: { salt?: Bytes; sender?: SenderKeys } = {}): Promise<Bytes> {
  const uaPublic = fromB64u(p256dh), authSecret = fromB64u(auth);
  if (uaPublic?.length !== 65 || authSecret?.length !== 16) throw new Error('Invalid subscription keys');
  // Header (86) + delimiter (1) + tag (16) must fit one record.
  if (plaintext.length + 1 + 16 > RECORD_SIZE) throw new Error('Push payload too large');
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error('Invalid salt');
  const sender = options.sender ?? await generateSenderKeys();
  const receiver = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: receiver } as unknown as SubtleCryptoDeriveKeyAlgorithm, sender.privateKey, 256));
  // key_info = "WebPush: info" || 0x00 || ua_public || as_public
  const keyInfo = concat(encoder.encode('WebPush: info\0'), uaPublic, sender.publicKey);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // Last (and only) record: padding delimiter 0x02, no further padding.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = sender.publicKey.length;
  return concat(header, sender.publicKey, ciphertext);
}

// ---------------------------------------------------------------------------------------------
// Endpoint allowlist (SSRF guard): the relay only ever POSTs to known push services.

const EXACT_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
const HOST_SUFFIXES = ['.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com'];
export const MAX_ENDPOINT = 2048;

export function pushEndpointAllowed(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT) return false;
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
  const host = url.hostname;
  return EXACT_HOSTS.has(host) || HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length && /^[a-z0-9.-]+$/.test(host));
}

// Collapse key for undelivered messages: RFC 8030 Topic, at most 32 base64url characters.
export async function topicFor(tag: string): Promise<string> {
  return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(tag)))).slice(0, 32);
}

export interface PushTarget { endpoint: string; p256dh: string; auth: string }
export interface SendOptions {
  vapid: VapidKeys; subject: string; topic?: string; fetcher?: typeof fetch;
  // Test hooks for deterministic output; production always uses fresh randomness.
  salt?: Bytes; sender?: SenderKeys;
}

// Sends one push. `payload === null` is the payload-less fallback: VAPID only, empty body, which
// the service worker shows as generic text. Returns the push service's HTTP status.
export async function sendPush(target: PushTarget, payload: Uint8Array | null, options: SendOptions): Promise<number> {
  if (!pushEndpointAllowed(target.endpoint)) throw new Error('Push endpoint not allowed');
  const headers: Record<string, string> = {
    authorization: await vapidAuthorization(target.endpoint, options.subject, options.vapid),
    ttl: String(PUSH_TTL), urgency: 'high',
  };
  if (options.topic) headers.topic = options.topic;
  let body: Bytes | null = null;
  if (payload) {
    // If encryption itself fails (it should not: keys are validated on subscribe), degrade to
    // the payload-less push rather than dropping the notification.
    try { body = await encryptPayload(payload, target.p256dh, target.auth, { salt: options.salt, sender: options.sender }); } catch { body = null; }
  }
  if (body) {
    headers['content-encoding'] = 'aes128gcm';
    headers['content-type'] = 'application/octet-stream';
  } else headers['content-length'] = '0';
  const response = await (options.fetcher ?? fetch)(target.endpoint, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  await response.body?.cancel();
  return response.status;
}
