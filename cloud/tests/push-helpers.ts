// Test-side Web Push receiver: the user-agent half of RFC 8291, written independently of
// cloud/push.ts (HMAC-based HKDF as the RFC spells it) so a round trip is real evidence.
import { b64u, fromB64u } from '../push.ts';

type Bytes = Uint8Array<ArrayBuffer>;
const utf8 = (text: string): Bytes => new Uint8Array(new TextEncoder().encode(text));
const join = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, data));
}

export interface Receiver { privateKey: CryptoKey; p256dh: string; auth: string }

export async function newReceiver(): Promise<Receiver> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer);
  return { privateKey: pair.privateKey, p256dh: b64u(raw), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
}

// Imports a raw P-256 private scalar plus its uncompressed public point as an ECDH key.
export async function ecdhPrivateKey(d: string, publicKey: string): Promise<CryptoKey> {
  const point = fromB64u(publicKey)!;
  return crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d, x: b64u(point.slice(1, 33)), y: b64u(point.slice(33, 65)) }, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

export async function decryptPush(body: Uint8Array, receiver: Receiver): Promise<string> {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idLength = body[20]!;
  const asPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  if (recordSize !== 4096 || idLength !== 65 || ciphertext.length > recordSize) throw new Error('unexpected header');
  const uaPublic = fromB64u(receiver.p256dh)!, authSecret = fromB64u(receiver.auth)!;
  const sender = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: sender } as unknown as SubtleCryptoDeriveKeyAlgorithm, receiver.privateKey, 256));
  const prkKey = await hmac(authSecret, ecdhSecret);
  const ikm = await hmac(prkKey, join(utf8('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, join(utf8('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, join(utf8('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error('missing last-record padding delimiter');
  return new TextDecoder().decode(padded.slice(0, end));
}

export function decodeJwt(jwt: string) {
  const [header, claims, signature] = jwt.split('.');
  const text = (part: string) => new TextDecoder().decode(fromB64u(part)!);
  return { header: JSON.parse(text(header!)), claims: JSON.parse(text(claims!)), signature: fromB64u(signature!)!, input: `${header}.${claims}` };
}

export async function verifyVapid(authorization: string) {
  const match = /^vapid t=([A-Za-z0-9_.-]+), k=([A-Za-z0-9_-]+)$/.exec(authorization);
  if (!match) throw new Error(`malformed VAPID header: ${authorization}`);
  const jwt = decodeJwt(match[1]!);
  const publicKey = await crypto.subtle.importKey('raw', fromB64u(match[2]!)!, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, jwt.signature, utf8(jwt.input));
  return { ...jwt, publicKey: match[2]!, valid };
}
