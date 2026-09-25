import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, looksLikeCredential, REDACTED } from '../shared/redact.ts';

// [label, input, expected output]
const REDACTS: [string, string, string][] = [
  // Cases the server/pm.ts rule (pre-#26) covers, including tests/pm-failure.test.ts fixtures.
  ['anthropic oauth token', 'Request rejected for sk-ant-oat01-AbCdEf_0123456789-ZyXwVu', 'Request rejected for sk-ant-[REDACTED]'],
  ['anthropic api key', 'key sk-ant-api03-SECRETSECRET invalid', 'key sk-ant-[REDACTED] invalid'],
  ['x-api-key header', 'x-api-key: sk-ant-oat01-AbCdEf_0123456789-ZyXwVu', 'x-api-key: [REDACTED]'],
  ['bearer jwt', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payloadpart.signaturepart', 'Authorization: Bearer [REDACTED]'],
  ['bearer anthropic key (process exit stderr)', 'stderr: 401 Authorization: Bearer sk-ant-api03-SECRETSECRET', 'stderr: 401 Authorization: Bearer [REDACTED]'],
  ['lowercase bearer', 'authorization: bearer abc123def456ghi', 'authorization: bearer [REDACTED]'],
  ['refresh_token query', 'refresh_token=ya29a0AfH6SMBx9secretvalue', 'refresh_token=[REDACTED]'],
  ['access_token json', '{"access_token": "ya29.a0AfH6SMBx9secret"}', '{"access_token": "[REDACTED]"}'],
  ['id-token', 'id-token: 0123456789abcdef', 'id-token: [REDACTED]'],
  ['session_token', 'session_token=Zm9vYmFyYmF6cXV4', 'session_token=[REDACTED]'],
  ['oauth_token', 'oauth_token: ghu_1234567890', 'oauth_token: [REDACTED]'],
  ['bare token', 'token=a1b2c3d4e5f6', 'token=[REDACTED]'],
  ['api_key', 'api_key=AKIAIOSFODNN7EXAMPLE', 'api_key=[REDACTED]'],
  ['apikey', "apikey: 'Qx7-99zz-ABCD'", "apikey: '[REDACTED]'"],
  ['client_secret', 'client_secret=s3cr3t-v4lue-xyz', 'client_secret=[REDACTED]'],
  ['secret', 'secret: hunter2hunter2', 'secret: [REDACTED]'],
  ['password', 'password=P@ssw0rd!2024', 'password=[REDACTED]'],
  ['authorization raw value', 'Authorization: 9f8e7d6c5b4a3210', 'Authorization: [REDACTED]'],
  ['query string stops at &', 'url?access_token=abc123def456&x=1', 'url?access_token=[REDACTED]&x=1'],
  ['long lowercase passphrase', 'password=correcthorsebatterystaple', 'password=[REDACTED]'],
  ['mixed-case letters only', 'password=HunterTwoSecret', 'password=[REDACTED]'],
  // #63: Authorization: Basic <base64>.
  ['basic auth', 'Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic [REDACTED]'],
  ['basic auth with padding', 'Authorization: Basic YWRtaW46c2VjcmV0MTIz==', 'Authorization: Basic [REDACTED]'],
  ['short basic credential', 'Authorization: Basic dTpw', 'Authorization: Basic [REDACTED]'],
  ['basic in json header', '{"Authorization":"Basic YWxhZGRpbjpvcGVuc2VzYW1l"}', '{"Authorization":"Basic [REDACTED]"}'],
  ['proxy-authorization basic', 'Proxy-Authorization: Basic Zm9vOmJhcg==', 'Proxy-Authorization: Basic [REDACTED]'],
  // Other provider credential shapes.
  ['openai key', 'Incorrect API key provided: sk-proj-abcdEFGH1234ijklMNOP5678', 'Incorrect API key provided: sk-[REDACTED]'],
  ['github token', 'using ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'using ghp_[REDACTED]'],
  ['github fine-grained pat', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', 'github_pat_[REDACTED]'],
  ['several in one line', 'x-api-key: sk-ant-a1; Authorization: Bearer eyJ.a.b; refresh_token=ya29a0AfH6SMBx9secretvalue',
    'x-api-key: [REDACTED]; Authorization: Bearer [REDACTED]; refresh_token=[REDACTED]'],
];

// Ordinary prose that must pass through unchanged (#63 false redactions).
const KEEPS: [string, string][] = [
  ['#63 authorization required', 'Authorization: required'],
  ['#63 invalid bearer token', 'Invalid bearer token'],
  ['Invalid Bearer token (capitalised)', 'Invalid Bearer token'],
  ['bearer token missing', 'Bearer token missing or expired'],
  ['Authorization: Required', 'Authorization: Required'],
  ['Authorization: REQUIRED', 'Authorization: REQUIRED'],
  ['authorization failed', 'authorization: rejected.'],
  ['token expired sentence', 'The session token: expired. Log in again.'],
  ['password hyphenated words', 'password: not-provided'],
  ['basic authentication prose', 'Basic authentication is not supported'],
  ['basic auth prose', 'Authorization: Basic auth required'],
  ['www-authenticate realm', 'WWW-Authenticate: Basic realm="api"'],
  ['bare scheme', 'Authorization: Basic'],
  ['short value', 'token=abc'],
  ['sk-learn prose', 'uses sk-learn for models'],
  ['plain sentence', 'API Error: rate limited'],
  ['empty', ''],
];

test('redactSecrets redacts every credential shape', () => {
  for (const [label, input, expected] of REDACTS) assert.equal(redactSecrets(input), expected, label);
});

test('redactSecrets leaves ordinary words after credential keywords unchanged', () => {
  for (const [label, input] of KEEPS) assert.equal(redactSecrets(input), input, label);
});

test('redacted output leaks none of the secret material', () => {
  const secrets = ['AbCdEf_0123456789', 'SECRETSECRET', 'eyJhbGciOiJIUzI1NiJ9', 'ya29a0AfH6SMBx9secretvalue', 'dXNlcjpwYXNz', 'YWRtaW46c2VjcmV0MTIz'];
  const joined = REDACTS.map(([, input]) => redactSecrets(input)).join('\n');
  for (const s of secrets) assert.ok(!joined.includes(s), s);
});

test('redactSecrets is idempotent and total', () => {
  for (const [, input] of [...REDACTS.map(([l, i]) => [l, i] as [string, string]), ...KEEPS]) {
    const once = redactSecrets(input);
    assert.equal(redactSecrets(once), once, input);
  }
  assert.equal(redactSecrets(undefined as unknown as string), '');
  assert.equal(REDACTED, '[REDACTED]');
});

test('looksLikeCredential separates words from opaque values', () => {
  assert.equal(looksLikeCredential('required', 8), false);
  assert.equal(looksLikeCredential('token', 6), false);
  assert.equal(looksLikeCredential('Required', 8), false);
  assert.equal(looksLikeCredential('abc123de', 8), true);
  assert.equal(looksLikeCredential('dTpw', 4), true);
  assert.equal(looksLikeCredential('abc12', 8), false);
  assert.equal(looksLikeCredential('correcthorsebatterystaple', 8), true);
});
