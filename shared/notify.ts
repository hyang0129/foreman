// Android MVP notification contracts shared by the local host (server/, Node with
// --experimental-strip-types) and the relay (cloud/, Workers). Pure and dependency-free:
// no I/O, no TS enums/namespaces/parameter properties, synchronous everywhere.
//
// Invariant: a push payload never carries session content. `buildPushPayload` is the single
// renderer and copies only whitelisted fields (kind, host, session key, cleaned session name,
// timestamp); everything else on its input is ignored.

export const NOTIFY_KINDS = ['approval_requested', 'question_asked', 'session_failed', 'pm_failed'] as const;
export type NotifyKind = typeof NOTIFY_KINDS[number];

export const PUSH_KINDS = [...NOTIFY_KINDS, 'host_offline'] as const;
// Every preference-controlled kind is on by default.
export const DEFAULT_PUSH_KINDS: readonly (typeof PUSH_KINDS[number])[] = [...PUSH_KINDS];
// 'test' is always delivered and is never a stored preference.
export type PushKind = typeof PUSH_KINDS[number] | 'test';

export interface NotifyFrame {
  type: 'notify';
  id: string;
  kind: NotifyKind;
  host: string;
  session_key?: string;
  session_name?: string;
  at: string;
}

// Bytes of the serialized (UTF-8 JSON) frame.
export const MAX_NOTIFY_FRAME = 2048;
// One RFC 8291 record is 4096 bytes including the 86-byte header, 16-byte tag and padding
// delimiter; 3000 leaves ample room.
export const MAX_PUSH_PAYLOAD = 3000;

export const MAX_ID = 100;
export const MAX_HOST = 100;
export const MAX_SESSION_KEY = 300;
export const MAX_DISPLAY_NAME = 80;

const FRAME_KEYS = new Set(['type', 'id', 'kind', 'host', 'session_key', 'session_name', 'at']);
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,100}$/;
// Session keys are ASCII (`fm:<uuid>`, `<provider>:<session id>`): printable, no spaces.
const SESSION_KEY_PATTERN = /^[\x21-\x7e]{1,300}$/;
const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/;

export function isNotifyKind(value: unknown): value is NotifyKind {
  return typeof value === 'string' && (NOTIFY_KINDS as readonly string[]).includes(value);
}

export function isPushPreferenceKind(value: unknown): value is typeof PUSH_KINDS[number] {
  return typeof value === 'string' && (PUSH_KINDS as readonly string[]).includes(value);
}

function isSessionKind(kind: NotifyKind): boolean {
  return kind !== 'pm_failed';
}

// UTF-8 byte length without relying on TextEncoder. Lone surrogates count as U+FFFD (3 bytes),
// matching what TextEncoder would emit.
export function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_PATTERN.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  if (m[9] !== undefined && (Number(m[9]) > 23 || Number(m[10]) > 59)) return false;
  return !Number.isNaN(Date.parse(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Strict host\u2192relay frame validation. Returns null (never throws) on anything unexpected.
export function parseNotifyFrame(raw: unknown): NotifyFrame | null {
  try {
    if (!isPlainObject(raw)) return null;
    for (const key of Object.keys(raw)) if (!FRAME_KEYS.has(key)) return null;
    const { type, id, kind, host, session_key, session_name, at } = raw;
    if (type !== 'notify') return null;
    if (!isNotifyKind(kind)) return null;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
    if (typeof host !== 'string' || host.length < 1 || host.length > MAX_HOST) return null;
    if (isSessionKind(kind)) {
      if (typeof session_key !== 'string' || !SESSION_KEY_PATTERN.test(session_key)) return null;
    } else if (session_key !== undefined) return null;
    if (session_name !== undefined && typeof session_name !== 'string') return null;
    if (!isIsoTimestamp(at)) return null;
    if (utf8Length(JSON.stringify(raw)) > MAX_NOTIFY_FRAME) return null;
    const frame: NotifyFrame = { type: 'notify', id, kind, host, at };
    if (typeof session_key === 'string') frame.session_key = session_key;
    if (typeof session_name === 'string') frame.session_name = session_name;
    return frame;
  } catch {
    return null;
  }
}

// C0/C1 controls, bidi embeddings/overrides/isolates and marks, zero-width and BOM characters.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

// Single-line, display-safe name: whitespace (including newlines and line/paragraph separators)
// collapses to one space, invisible/control characters are removed, and the result is truncated
// to `max` code points with a trailing ellipsis.
export function cleanDisplayName(s: string, max: number = MAX_DISPLAY_NAME): string {
  if (typeof s !== 'string') return '';
  const cleaned = s
    .replace(LONE_SURROGATE, '')
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]/g, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(cleaned);
  const limit = Math.max(1, Math.floor(max));
  if (points.length <= limit) return cleaned;
  return points.slice(0, limit - 1).join('').trimEnd() + '\u2026';
}

// cyrb53: a small, fast, synchronous 53-bit string hash (not cryptographic).
function cyrb53(input: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Deterministic notify id: `<kind>:<hash>`. The hash is two seeded cyrb53 rounds (~106 bits)
// over the JSON-encoded parts, so ('a','bc') and ('ab','c') differ. It is not cryptographic;
// ids are only used to de-duplicate, so a collision can at worst cause one notification to be
// dropped as a duplicate of another.
export function notifyId(kind: NotifyKind, ...parts: string[]): string {
  const input = JSON.stringify(parts);
  return `${kind}:${cyrb53(input, 0).toString(36)}${cyrb53(input, 0x9e3779b9).toString(36)}`.slice(0, MAX_ID);
}

export interface PushPayload {
  v: 1;
  kind: PushKind;
  host: string;
  session_key?: string;
  session_name?: string;
  at: string;
  tag: string;
  title: string;
  body: string;
  url: string;
}

export type PushEvent = NotifyFrame | { kind: 'host_offline' | 'test'; host: string; at: string };

export function sessionUrl(key: string): string {
  return `/?session=${encodeURIComponent(key)}`;
}

export const PM_URL = '/?view=pm';

function render(kind: PushKind, host: string, key: string | undefined, name: string | undefined, at: string): PushPayload {
  const who = name || 'A session';
  const session = key === undefined ? {} : { session_key: key };
  const named = name ? { session_name: name } : {};
  const sessionTarget = { tag: key === undefined ? 'session' : `session:${key}`, url: key === undefined ? '/' : sessionUrl(key) };
  switch (kind) {
    case 'approval_requested':
      return { v: 1, kind, host, ...session, ...named, at, ...sessionTarget, title: 'Approval needed', body: `${who} is waiting for your approval` };
    case 'question_asked':
      return { v: 1, kind, host, ...session, ...named, at, ...sessionTarget, title: `Question from ${who}`, body: `${who} has a question for you` };
    case 'session_failed':
      return { v: 1, kind, host, ...session, ...named, at, ...sessionTarget, title: 'Session failed', body: `${who} stopped with an error. Open Foreman for details.` };
    case 'pm_failed':
      return { v: 1, kind, host, at, tag: 'pm', url: PM_URL, title: 'PM needs attention', body: 'The project manager hit an error. Open Foreman for details.' };
    case 'host_offline':
      return { v: 1, kind, host, at, tag: 'host', url: '/', title: 'Mac offline', body: `${host || 'Your Mac'} has been disconnected for over 5 minutes.` };
    case 'test':
    default:
      return { v: 1, kind: 'test', host, at, tag: 'test', url: '/', title: 'Foreman notifications are on', body: 'You will be notified when a session needs you.' };
  }
}

export function pushPayloadSize(payload: PushPayload): number {
  return utf8Length(JSON.stringify(payload));
}

// The single push renderer. Reads only kind, host, session_key, session_name and at from the
// event, cleans each, and builds every other field from fixed templates. The serialized result
// is guaranteed to be at most MAX_PUSH_PAYLOAD bytes.
export function buildPushPayload(event: PushEvent): PushPayload {
  const input = (isPlainObject(event) ? event : {}) as Record<string, unknown>;
  const kind: PushKind = isNotifyKind(input.kind) || input.kind === 'host_offline' ? input.kind : 'test';
  const at = isIsoTimestamp(input.at) ? input.at : new Date().toISOString();
  let host = typeof input.host === 'string' ? cleanDisplayName(input.host, MAX_HOST) : '';
  const sessionKind = kind === 'approval_requested' || kind === 'question_asked' || kind === 'session_failed';
  let key = sessionKind && typeof input.session_key === 'string' && SESSION_KEY_PATTERN.test(input.session_key) ? input.session_key : undefined;
  let name = sessionKind && typeof input.session_name === 'string' ? cleanDisplayName(input.session_name, MAX_DISPLAY_NAME) : undefined;

  let payload = render(kind, host, key, name, at);
  // Worst-case inputs (multi-byte names and hosts, quote-heavy keys) can exceed the budget;
  // shed detail until they fit. Ordinary events never reach this loop.
  const fallbacks: (() => void)[] = [
    () => { name = name === undefined ? undefined : cleanDisplayName(name, 24); },
    () => { host = cleanDisplayName(host, 24); },
    () => { key = undefined; },
    () => { name = undefined; host = ''; },
  ];
  for (const shrink of fallbacks) {
    if (pushPayloadSize(payload) <= MAX_PUSH_PAYLOAD) break;
    shrink();
    payload = render(kind, host, key, name, at);
  }
  return payload;
}

// Relative, same-origin only: starts with a single '/', no backslash, no whitespace or control
// characters (so no scheme or protocol-relative tricks after browser normalization).
export function pushUrlIsSafe(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return false;
  if (url[0] !== '/' || url[1] === '/') return false;
  if (url.includes('\\')) return false;
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(url)) return false;
  return true;
}

export type DeepLink = { session: string } | { view: 'pm' };

// Parses a location.search (with or without the leading '?'). A valid `session` wins over
// `view=pm`; anything else is null.
export function parseDeepLink(search: string): DeepLink | null {
  if (typeof search !== 'string' || search.length > 4096) return null;
  let params: URLSearchParams;
  try { params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search); } catch { return null; }
  const session = params.get('session');
  if (session !== null && SESSION_KEY_PATTERN.test(session)) return { session };
  if (params.get('view') === 'pm') return { view: 'pm' };
  return null;
}
