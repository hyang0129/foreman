// Conservative credential redaction for provider text that is logged, emitted or stored (host
// diagnostics, stderr status events, the relay's bounded reason strings). Shared by the local
// host (Node) and the relay (Workers): pure, synchronous, no imports.
//
// Fail closed: every value the pre-#26 `server/pm.ts` rule redacted is still redacted, except a
// short list of ordinary status/prose words that follow a credential keyword in error text
// ("Authorization: required", "Invalid bearer token", "Basic authentication is not supported").
// Any other value after a credential keyword (digits, symbols, mixed case, all caps, or plain
// lower-case letters such as a dictionary-word password) is replaced with `[REDACTED]`.

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

// Keys whose `=`/`:` value is a credential. `authorization` is included so a bare header value is
// covered; `Authorization: Bearer x` / `Basic x` are handled by the scheme rules below (the scheme
// word itself is prose, so the key/value rule leaves it alone). Same key set and 8-char minimum as
// the pre-#26 rule.
const KEY_VALUE = /\b((?:access|refresh|id|auth|session|oauth)?[_-]?token|api[_-]?key|x-api-key|client[_-]?secret|secret|password|authorization)(["']?\s*[=:]\s*["']?)([^\s"',;&]{8,})/gi;
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
    .replace(BEARER, (all, scheme: string, space: string, value: string) => looksLikeCredential(value, 1) ? `${scheme}${space}${REDACTED}` : all)
    .replace(BASIC, (all, scheme: string, space: string, value: string) => looksLikeCredential(value, 1) ? `${scheme}${space}${REDACTED}` : all)
    .replace(KEY_VALUE, (all, key: string, sep: string, value: string) => looksLikeCredential(value, 8) ? `${key}${sep}${REDACTED}` : all);
}
