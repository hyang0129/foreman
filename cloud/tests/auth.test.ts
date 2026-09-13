import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { verifyUser, validHostToken } from '../auth.ts';

const project = 'test-firebase-project';
const email = 'owner@example.com';
let privateKey: CryptoKey, impostorKey: CryptoKey, keys: JWTVerifyGetKey;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  impostorKey = (await generateKeyPair('RS256')).privateKey;
  keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' }] });
});

async function token(overrides: Record<string, unknown> = {}, omit: string[] = [], key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { iss: `https://securetoken.google.com/${project}`, aud: project,
    sub: 'firebase-user-id', iat: now - 10, auth_time: now - 20, exp: now + 3600,
    email, email_verified: true, firebase: { sign_in_provider: 'google.com' }, ...overrides };
  for (const field of omit) delete payload[field];
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(key);
}

describe('Firebase identity verification with locally generated signing keys', () => {
  it('accepts only the expected signed, verified Google identity', async () => {
    await expect(verifyUser(await token(), project, email, keys)).resolves.toBe('firebase-user-id');
  });
  it.each([
    ['wrong audience', { aud: 'another-project' }],
    ['wrong issuer', { iss: 'https://attacker.invalid/' }],
    ['expired token', { exp: 1 }],
    ['future issue time', { iat: 9_999_999_999 }],
    ['future authentication time', { auth_time: 9_999_999_999 }],
    ['wrong owner', { email: 'attacker@example.com' }],
    ['unverified email', { email_verified: false }],
    ['string verification flag', { email_verified: 'true' }],
    ['password provider', { firebase: { sign_in_provider: 'password' } }],
    ['missing provider', { firebase: {} }],
    ['empty subject', { sub: '' }],
    ['oversized subject', { sub: 'x'.repeat(129) }],
  ])('rejects %s', async (_name, overrides) => {
    await expect(verifyUser(await token(overrides as Record<string, unknown>), project, email, keys)).rejects.toThrow();
  });
  it.each(['exp', 'iat', 'auth_time', 'sub', 'email', 'email_verified', 'firebase'])('requires %s', async (claim) => {
    await expect(verifyUser(await token({}, [claim]), project, email, keys)).rejects.toThrow();
  });
  it('rejects a valid-looking token signed by an untrusted key', async () => {
    await expect(verifyUser(await token({}, [], impostorKey), project, email, keys)).rejects.toThrow();
  });
  it('rejects unsigned or malformed tokens', async () => {
    await expect(verifyUser('eyJhbGciOiJub25lIn0.e30.', project, email, keys)).rejects.toThrow();
    await expect(verifyUser('not-a-token', project, email, keys)).rejects.toThrow();
  });
});

it('host credentials require a configured strong secret and exact match', async () => {
  const secret = 'test-only'.repeat(8);
  await expect(validHostToken(secret, secret)).resolves.toBe(true);
  await expect(validHostToken(`${secret}x`, secret)).resolves.toBe(false);
  await expect(validHostToken('', secret)).resolves.toBe(false);
  await expect(validHostToken('short', 'short')).resolves.toBe(false);
  await expect(validHostToken('anything', '')).resolves.toBe(false);
  await expect(validHostToken('x'.repeat(513), secret)).resolves.toBe(false);
});
