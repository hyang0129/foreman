// Conservative credential redaction for provider text that is logged, emitted or stored (host
// diagnostics, stderr status events, the relay's bounded reason strings). Shared by the local
// host (Node) and the relay (Workers): pure, synchronous, no imports.
//
// A value is redacted only when it looks like a credential. Ordinary words after a credential
// keyword ("Authorization: required", "Invalid bearer token", "Basic authentication") pass
// through unchanged; opaque values (digits, symbols, mixed case, or a very long run of letters)
// are replaced with `[REDACTED]`.

export const REDACTED = '[REDACTED]';

// A plain word, optionally hyphenated or with an apostrophe, optionally followed by sentence
// punctuation: "required", "Required", "REQUIRED", "not-provided", "expired.", "missing)".
const WORDISH = /^(?:[A-Z]?[a-z]+|[A-Z]+)(?:[-'][a-z]+)*[.,:;!?)\]]*$/;
// A run of letters this long is treated as opaque even if it reads like a word (passphrases).
const LONG_WORD = 20;

export function looksLikeCredential(value: string, minLength: number): boolean {
  if (typeof value !== 'string' || value.length < minLength) return false;
  if (WORDISH.test(value)) return value.replace(/[^A-Za-z]/g, '').length >= LONG_WORD;
  return true;
}

// Keys whose `=`/`:` value is a credential. `authorization` is included so a bare header value is
// covered; `Authorization: Bearer x` / `Basic x` are handled by the scheme rules below (the scheme
// word itself is not credential-like, so the key/value rule leaves it alone).
const KEY_VALUE = /\b((?:access|refresh|id|auth|session|oauth)?[_-]?token|api[_-]?key|x-api-key|client[_-]?secret|secret|password|authorization)(["']?\s*[=:]\s*["']?)([^\s"',;&]{8,})/gi;
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
    .replace(BEARER, (all, scheme: string, space: string, value: string) => looksLikeCredential(value, 6) ? `${scheme}${space}${REDACTED}` : all)
    .replace(BASIC, (all, scheme: string, space: string, value: string) => looksLikeCredential(value, 4) ? `${scheme}${space}${REDACTED}` : all)
    .replace(KEY_VALUE, (all, key: string, sep: string, value: string) => looksLikeCredential(value, 8) ? `${key}${sep}${REDACTED}` : all);
}
