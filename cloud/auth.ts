import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

const firebaseKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));
export async function verifyUser(token: string, project: string, email: string, keys: JWTVerifyGetKey = firebaseKeys) {
  const { payload } = await jwtVerify(token, keys, {
    algorithms: ['RS256'], issuer: `https://securetoken.google.com/${project}`, audience: project,
    requiredClaims: ['exp', 'iat', 'auth_time', 'sub', 'email', 'email_verified', 'firebase'],
  });
  const now = Math.floor(Date.now() / 1000);
  if (!payload.sub || payload.sub.length > 128 || typeof payload.iat !== 'number' || payload.iat > now ||
      typeof payload.auth_time !== 'number' || payload.auth_time > now || payload.email !== email || payload.email_verified !== true ||
      (payload.firebase as { sign_in_provider?: string })?.sign_in_provider !== 'google.com') throw new Error('This Google account is not allowed');
  return payload.sub;
}
export async function validHostToken(actual: string, expected: string) {
  if (!expected || expected.length < 32 || !actual || actual.length > 512) return false;
  const hash = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const [a, b] = await Promise.all([hash(actual), hash(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
