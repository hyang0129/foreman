// Conservative credential redaction for provider text that is logged, emitted or stored (host
// diagnostics, stderr status events, the relay's bounded reason strings). Shared by the local
// host (Node) and the relay (Workers): pure, synchronous, no imports.
//
// Fail closed: every value the pre-#26 `server/pm.ts` rule redacted is still redacted, except
// ordinary prose that follows a credential keyword in error text:
// - a word from a short list of status/prose words ("Authorization: required", "Invalid bearer
//   token", "Basic authentication is not supported"), and
// - #122: a short plain word that a sentence visibly continues after ("token: pending approval",
//   "password: changed. Log in again."). Only a value that cannot be secret-shaped qualifies: 2-7
//   letters, lower case (one leading capital allowed), no digits or symbols; see `proseInContext`.
// Any other value after a credential keyword (digits, symbols, mixed case, all caps, or plain
// lower-case letters such as a dictionary-word password) is replaced with `[REDACTED]`.
// #122: a value after `password`/`secret`/`api_key`-style keys (credentials people choose, which can
// be short) is redacted at any length (`password=abc12`); `token`/`authorization` values keep the
// pre-#26 8-character minimum.

export const REDACTED = '[REDACTED]';

// A plain word, optionally hyphenated or with an apostrophe, optionally followed by sentence
// punctuation: "required", "Required", "REQUIRED", "not-provided", "expired.", "missing)".
const WORDISH = /^[A-Za-z]+(?:[-'][A-Za-z]+)*[.,:;!?)\]]*$/;
const TRAILING_PUNCTUATION = /[.,:;!?)\]]+$/;

// Ordinary words that follow `Bearer`, `Basic`, `token:`, `Authorization:` … in provider error
// prose. Only these (case-insensitive; every part of a hyphenated compound) pass unchanged.
const PROSE_WORDS: ReadonlySet<string> = new Set([
  // status words
  'required', 'require', 'requires', 'missing', 'invalid', 'expired', 'expire', 'expires', 'revoked', 'denied',
  'failed', 'failure', 'fails', 'error', 'rejected', 'incorrect', 'malformed', 'provided', 'present', 'absent',
  'empty', 'none', 'null', 'undefined', 'unknown', 'unauthorized', 'unauthenticated', 'forbidden', 'mismatch',
  'needed', 'supported', 'unsupported', 'allowed', 'disabled', 'enabled', 'refused', 'accepted', 'ok',
  // scheme and header vocabulary
  'token', 'tokens', 'bearer', 'basic', 'digest', 'negotiate', 'auth', 'authentication', 'authorization',
  'credential', 'credentials', 'header', 'headers', 'scheme', 'realm', 'value', 'format', 'http', 'https',
  // connectives
  'not', 'no', 'is', 'was', 'are', 'were', 'be', 'has', 'have', 'had', 'must', 'should', 'the', 'a', 'an',
  'and', 'or', 'for', 'in', 'on', 'of', 'to', 'with', 'from',
]);

/** True for an ordinary prose word from `PROSE_WORDS` (possibly hyphenated, with trailing punctuation). */
export function isProseWord(value: string): boolean {
  if (typeof value !== 'string' || !WORDISH.test(value)) return false;
  return value.replace(TRAILING_PUNCTUATION, '').toLowerCase().split(/[-']/).every((part) => PROSE_WORDS.has(part));
}

/** A value after a credential keyword is a credential unless it is shorter than `minLength` or an ordinary prose word. */
export function looksLikeCredential(value: string, minLength: number): boolean {
  if (typeof value !== 'string' || value.length < minLength) return false;
  return !isProseWord(value);
}

/**
 * #122: true when `value` (a match that starts at `offset` in `text` and is `length` characters
 * long) is a short plain word in a sentence that visibly continues: followed by whitespace and a
 * lower-case word, or ending in `.`/`!`/`?` followed by whitespace and a capitalised word. Never true
 * for anything secret-shaped: digits, symbols, mixed case beyond one leading capital, or 8+ letters.
 */
export function proseInContext(value: string, text: string, end: number): boolean {
  if (typeof value !== 'string' || !SHORT_PLAIN_WORD.test(value)) return false;
  const rest = text.slice(end, end + 64);
  if (/[.!?]$/.test(value)) return /^\s+[A-Z][a-z]*\b/.test(rest);
  return /[A-Za-z]$/.test(value) && /^\s+[a-z]+\b/.test(rest);
}
// 2-7 letters, lower case or one leading capital, optionally one trailing sentence punctuation mark.
const SHORT_PLAIN_WORD = /^[A-Za-z][a-z]{1,6}[.,;:!?]?$/;

// Keys whose `=`/`:` value is a credential. `authorization` is included so a bare header value is
// covered; `Authorization: Bearer x` / `Basic x` are handled by the scheme rules below (the scheme
// word itself is prose, so the key/value rule leaves it alone). The pre-#26 key set, plus `passwd`.
// Values of token/authorization keys keep the pre-#26 8-character minimum; the others (credentials
// people choose) are redacted at any length (#122).
const KEY_VALUE = /\b((?:access|refresh|id|auth|session|oauth)?[_-]?token|api[_-]?key|x-api-key|client[_-]?secret|secret|passw(?:or)?d|authorization)(["']?\s*[=:]\s*["']?)([^\s"',;&]+)/gi;
const LONG_VALUE_KEY = /^(?:(?:access|refresh|id|auth|session|oauth)?[_-]?token|authorization)$/i;
// Any non-prose value after `Bearer`, of any length (as the pre-#26 rule).
const BEARER = /\b(Bearer)(\s+)([^\s"',;]+)/gi;
// Base64 (standard or URL-safe) with optional padding, not followed by more token characters.
const BASIC = /\b(Basic)(\s+)([A-Za-z0-9+/_-]+)(={0,2})(?![A-Za-z0-9+/=_-])/gi;

export function redactSecrets(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    // Anthropic API keys and OAuth tokens.
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, `sk-ant-${REDACTED}`)
    // OpenAI-style secret keys (sk-..., sk-proj-...), long enough not to hit prose like "sk-learn".
    .replace(/\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g, `sk-${REDACTED}`)
    // GitHub tokens.
    .replace(/\b(gh[pousr]_)[A-Za-z0-9]{30,}/g, `$1${REDACTED}`)
    .replace(/\bgithub_pat_[A-Za-z0-9_]{30,}/g, `github_pat_${REDACTED}`)
    .replace(BEARER, (all: string, scheme: string, space: string, value: string, offset: number, whole: string) =>
      looksLikeCredential(value, 1) && !proseInContext(value, whole, offset + all.length) ? `${scheme}${space}${REDACTED}` : all)
    .replace(BASIC, (all: string, scheme: string, space: string, value: string, padding: string, offset: number, whole: string) =>
      looksLikeCredential(value, 1) && !proseInContext(value + padding, whole, offset + all.length) ? `${scheme}${space}${REDACTED}` : all)
    .replace(KEY_VALUE, (all: string, key: string, sep: string, value: string, offset: number, whole: string) =>
      looksLikeCredential(value, LONG_VALUE_KEY.test(key) ? 8 : 1) && !proseInContext(value, whole, offset + all.length) ? `${key}${sep}${REDACTED}` : all);
}
