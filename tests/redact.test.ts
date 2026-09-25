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
  // Former positives that a pure "looks opaque" heuristic would miss: short, letters-only,
  // single-case, capitalised and hyphenated values.
  ['short bearer token', 'Bearer abc12', 'Bearer [REDACTED]'],
  ['one-char bearer token', 'Authorization: Bearer x', 'Authorization: Bearer [REDACTED]'],
  ['lower-case letters-only bearer', 'Bearer abcdefghijklmnop', 'Bearer [REDACTED]'],
  ['upper-case letters-only bearer', 'Bearer ABCDEFGHIJKLMNOP', 'Bearer [REDACTED]'],
  ['bearer jwt with dots', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', 'Bearer [REDACTED]'],
  ['lower-case letters-only token', 'token=abcdefghijklmnop', 'token=[REDACTED]'],
  ['upper-case letters-only token', 'token=ABCDEFGHIJKLMNOP', 'token=[REDACTED]'],
  ['token with trailing dot', 'token=abcdefgh.', 'token=[REDACTED]'],
  ['dictionary-word password', 'password=dragonfly', 'password=[REDACTED]'],
  ['lower-case passphrase under 20', 'password=sunshinesunshine', 'password=[REDACTED]'],
  ['hyphenated password', 'password=my-secret-pass', 'password=[REDACTED]'],
  ['x-api-key letters only', 'x-api-key: abcdefghijklmnopq', 'x-api-key: [REDACTED]'],
  ['x-api-key upper case', 'x-api-key: ABCDEFGHIJKLMNOPQRS', 'x-api-key: [REDACTED]'],
  ['capitalised api key', 'api_key=Abcdefghijk', 'api_key=[REDACTED]'],
  ['capitalised secret', 'secret=Supersecret', 'secret=[REDACTED]'],
  ['basic lower-case base64', 'Authorization: Basic abcd', 'Authorization: Basic [REDACTED]'],
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

// #122: short values of chosen-credential keys (password, secret, api key) are redacted at any
// length; token/authorization values keep the 8-character minimum. A short plain word in a
// continuing sentence passes only when it cannot be secret-shaped.
const REDACTS_122: [string, string, string][] = [
  ['short password', 'password=abc12', 'password=[REDACTED]'],
  ['short letters-only password', 'password: hunter', 'password: [REDACTED]'],
  ['short secret', 'secret=pa55', 'secret=[REDACTED]'],
  ['short api key', 'api_key=Ab1', 'api_key=[REDACTED]'],
  ['short client secret in json', '{"client_secret": "x9"}', '{"client_secret": "[REDACTED]"}'],
  ['passwd key', 'passwd=abc', 'passwd=[REDACTED]'],
  ['one-char password', 'password=x', 'password=[REDACTED]'],
  // Secret-shaped values stay redacted even inside a sentence.
  ['digits in a sentence', 'password: hunter2 was rejected', 'password: [REDACTED] was rejected'],
  ['mixed case in a sentence', 'password: HuNter was rejected', 'password: [REDACTED] was rejected'],
  ['all caps in a sentence', 'Bearer ABCDEF was rejected', 'Bearer [REDACTED] was rejected'],
  ['eight letters in a sentence', 'Bearer dragonfly and more', 'Bearer [REDACTED] and more'],
  ['symbols in a sentence', 'secret: p@ss is wrong', 'secret: [REDACTED] is wrong'],
  ['short word at end of text', 'Bearer abcdefg', 'Bearer [REDACTED]'],
  ['short word before punctuation only', 'Authorization: Basic abcd.', 'Authorization: Basic [REDACTED].'],
  ['sentence end followed by a lower-case word', 'password: hunter. again', 'password: [REDACTED] again'],
];

// #122: prose after a credential keyword that the fixed word list alone used to redact.
const KEEPS_122: [string, string][] = [
  ['unlisted word, sentence continues', 'Expected Bearer but got Basic'],
  ['bearer prefix prose', 'Send the Bearer prefix with each request'],
  ['basic login failed', 'Basic login failed'],
  ['password changed sentence', 'password: changed. Log in again.'],
  ['token was refreshed', 'token was refreshed'],
  ['password is required', 'password is required'],
  ['password: is required', 'password: is required'],
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

test('#122: short chosen-credential values and secret-shaped words in sentences are redacted', () => {
  for (const [label, input, expected] of REDACTS_122) assert.equal(redactSecrets(input), expected, label);
  for (const [label, input] of REDACTS_122.map(([l, i]) => [l, i])) assert.equal(redactSecrets(redactSecrets(input)), redactSecrets(input), `idempotent: ${label}`);
  // token/authorization values keep the 8-character minimum.
  assert.equal(redactSecrets('token=abc'), 'token=abc');
});

test('#122: an unlisted short plain word in a continuing sentence is not redacted', () => {
  for (const [label, input] of KEEPS_122) assert.equal(redactSecrets(input), input, label);
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

test('looksLikeCredential passes only prose words and short values', () => {
  assert.equal(looksLikeCredential('required', 8), false);
  assert.equal(looksLikeCredential('token', 6), false);
  assert.equal(looksLikeCredential('Required', 8), false);
  assert.equal(looksLikeCredential('REQUIRED.', 8), false);
  assert.equal(looksLikeCredential('not-provided', 8), false);
  assert.equal(looksLikeCredential('abc123de', 8), true);
  assert.equal(looksLikeCredential('dTpw', 4), true);
  assert.equal(looksLikeCredential('abc12', 8), false);
  assert.equal(looksLikeCredential('dragonfly', 8), true);
  assert.equal(looksLikeCredential('my-secret-pass', 8), true);
  assert.equal(looksLikeCredential('correcthorsebatterystaple', 8), true);
});

// The pre-#26 server/pm.ts rule, verbatim, as the regression baseline.
const preStoryRedact = (text: string): string => text
  .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[REDACTED]')
  .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
  .replace(/\b((?:access|refresh|id|auth|session|oauth)?[_-]?token|api[_-]?key|x-api-key|client[_-]?secret|secret|password|authorization)(["']?\s*[=:]\s*["']?)[^\s"',;&]{8,}/gi, '$1$2[REDACTED]');

test('every string the pre-#26 rule redacted is still redacted (except the listed prose)', () => {
  // A generated corpus of key/scheme × value shapes, plus the table above.
  const keys = ['token=', 'access_token: ', 'api_key=', 'x-api-key: ', 'client_secret=', 'secret: ', 'password=', 'Authorization: ', 'Bearer ', 'bearer ', 'Authorization: Bearer '];
  const values = ['x', 'abc12', 'abcdefgh', 'abcdefghijklmnop', 'ABCDEFGHIJKLMNOP', 'Abcdefghijk', 'dragonfly', 'my-secret-pass', 'a1b2c3d4e5', 'eyJ.a.b', 'ya29.a0Af', 'Zm9vOmJhcg==', 'hunter2', 's3cr3t!', 'sk-ant-abc'];
  const corpus = [...REDACTS.map(([, input]) => input), ...keys.flatMap((k) => values.map((v) => `${k}${v}`))];
  const prose = new Set(KEEPS.map(([, input]) => input));
  let checked = 0;
  for (const input of corpus) {
    if (prose.has(input) || preStoryRedact(input) === input) continue;
    checked++;
    assert.ok(redactSecrets(input).includes(REDACTED), `regression: ${input} -> ${redactSecrets(input)}`);
  }
  assert.ok(checked > 100, String(checked));
  // And the #63 prose cases are exactly the ones the old rule over-redacted.
  assert.notEqual(preStoryRedact('Authorization: required'), 'Authorization: required');
  assert.notEqual(preStoryRedact('Invalid bearer token'), 'Invalid bearer token');
});
