// Portable PM state contracts (epic #26), shared by the local host (server/, Node with
// --experimental-strip-types) and the relay Durable Object (cloud/, Workers). Pure and
// dependency-free apart from sibling shared modules: no I/O, no `node:` imports, no TS
// enums/namespaces/parameter properties, synchronous everywhere.
//
// Frames ride the same host socket as #43's `notify` frames and follow shared/notify.ts's
// validation style: strict key sets, bounded strings, serialized-size bounds measured in UTF-8
// bytes, and validators that never throw and return a fresh copy on success.
//
// Invariant: no PM message text and no provider error text is ever carried to or stored by the
// relay. Turn records hold ids, timestamps, machine and epoch only; any reason/message string is
// bounded and redacted (`boundedReason`).

import { isIsoTimestamp, utf8Length } from './notify.ts';
import { redactSecrets } from './redact.ts';

// ---------------------------------------------------------------------------------------------
// Limits (sections B and C)
// ---------------------------------------------------------------------------------------------

/** Serialized (UTF-8 JSON) bound for host→DO PM frames: `hello` v2 and every `pm_rpc` except `memory.import`. */
export const MAX_PM_FRAME = 64 * 1024;
/**
 * `memory.import` carries the whole `projects` doc plus up to 2000 log entries, which cannot fit
 * in 64 KiB. It gets its own bound; the importing host drops the oldest log lines until the frame
 * fits (the import is one-time and never merged).
 */
export const MAX_PM_IMPORT_FRAME = 2 * 1024 * 1024;
/** DO→host bound for `pm_rpc_result` / `pm_assignment` (a `memory.get` result exceeds 64 KiB). */
export const MAX_PM_RESULT_FRAME = 1024 * 1024;

export const PM_DOC_NAMES = ['projects', 'preferences'] as const;
export type PmDocName = typeof PM_DOC_NAMES[number];
/** Doc content bounds in UTF-8 bytes. */
export const PM_DOC_LIMITS: Readonly<Record<PmDocName, number>> = { projects: 32 * 1024, preferences: 8 * 1024 };
export const MAX_PROJECTS_DOC = PM_DOC_LIMITS.projects;
export const MAX_PREFERENCES_DOC = PM_DOC_LIMITS.preferences;

export const MIN_LOG_ENTRY = 3;
export const MAX_LOG_ENTRY = 500;
/** The DO keeps the newest 2000 log entries. */
export const MAX_LOG_KEPT = 2000;
/** `memory.get` returns at most the newest 200 log entries. */
export const MAX_LOG_READ = 200;
export const MAX_OPEN_TURNS = 64;
export const MAX_TURN_ID = 100;
export const MAX_RPC_ID = 100;
export const MAX_MACHINES = 16;
export const MAX_MACHINE_NAME = 80;
export const MAX_PLATFORM = 32;
export const MAX_MODEL = 200;
/** Error messages in `pm_rpc_result` and any reason string the DO stores: bounded and redacted. */
export const MAX_PM_ERROR_MESSAGE = 300;
export const MAX_REASON = MAX_PM_ERROR_MESSAGE;
/** `/api/pm/history` returns the current conversation only, at most this many entries. */
export const MAX_PM_HISTORY = 200;

export const PM_MEMORY_TOOLS = ['mcp__fleet__memory_read', 'mcp__fleet__memory_write', 'mcp__fleet__memory_edit', 'mcp__fleet__log_note'] as const;
export type PmMemoryTool = typeof PM_MEMORY_TOOLS[number];
/** #62: no provider output for this long with an input outstanding ⇒ the next send treats the PM as hung. `FOREMAN_PM_HUNG_MS` overrides it. */
export const PM_HUNG_DEFAULT_MS = 300_000;

// ---------------------------------------------------------------------------------------------
// Shared validator plumbing
// ---------------------------------------------------------------------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ID_PATTERN = /^[A-Za-z0-9:_-]{1,100}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLATFORM_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
// Same shape as server/models.ts normalizeModel.
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) return key;
  return null;
}

function fail<T>(error: string): Parsed<T> { return { ok: false, error }; }

function serializedBytes(value: unknown): number {
  return utf8Length(JSON.stringify(value));
}

/** Frame/record ids and `turn_id`s: `[A-Za-z0-9:_-]{1,100}`. */
export function isPmId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** A UUID v4 (either case; `normalizeMachineId` lowercases it). */
export function isMachineId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function normalizeMachineId(value: string): string {
  return value.toLowerCase();
}

/** A display name: 1–80 chars, not blank, no control characters. */
export function isMachineName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_MACHINE_NAME && value.trim().length > 0 && !CONTROL.test(value);
}

export function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPmModel(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && MODEL_PATTERN.test(value));
}

/** Log text: at most 500 chars, at least 3 non-blank chars. */
export function isLogText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_LOG_ENTRY && value.trim().length >= MIN_LOG_ENTRY;
}

function isTurnIdList(value: unknown, min: number): value is string[] {
  return Array.isArray(value) && value.length >= min && value.length <= MAX_OPEN_TURNS
    && value.every(isPmId) && new Set(value).size === value.length;
}

/** Redact then bound a reason/error string before it is sent to or stored by the relay. */
export function boundedReason(text: string): string {
  const redacted = redactSecrets(typeof text === 'string' ? text : '');
  return Array.from(redacted).length <= MAX_REASON ? redacted : Array.from(redacted).slice(0, MAX_REASON - 1).join('') + '…';
}

// ---------------------------------------------------------------------------------------------
// A. Machine identity and hello v2
// ---------------------------------------------------------------------------------------------

/** `<FOREMAN_HOME>/machine.json`, mode 0600, created once. `name` defaults to HOST, env `FOREMAN_MACHINE_NAME`. */
export interface MachineIdentity { machine_id: string; name: string }

export interface HelloV2 {
  type: 'hello';
  protocol: 2;
  machine_id: string;
  host: string;
  platform: string;
  pm_open_turns: string[];
}

/** Legacy hosts send `{ type: 'hello', host }`. They are never recorded as PM host. */
export interface LegacyHello { type: 'hello'; protocol?: undefined; host: string | null }

export type Hello = HelloV2 | LegacyHello;

export function parseMachineIdentity(raw: unknown): Parsed<MachineIdentity> {
  try {
    if (!isPlainObject(raw)) return fail('machine identity must be an object');
    const extra = onlyKeys(raw, ['machine_id', 'name']);
    if (extra) return fail(`unexpected key ${extra}`);
    if (!isMachineId(raw.machine_id)) return fail('machine_id must be a UUID v4');
    if (!isMachineName(raw.name)) return fail(`name must be 1-${MAX_MACHINE_NAME} printable characters`);
    return { ok: true, value: { machine_id: normalizeMachineId(raw.machine_id), name: raw.name } };
  } catch { return fail('invalid machine identity'); }
}

/**
 * Validates a host→DO `hello`. A frame with `protocol: 2` is validated strictly as `HelloV2`
 * (machine_id lowercased). A frame without `protocol` is a legacy hello: accepted leniently as
 * today (extra keys ignored; `host` is its string value truncated to 100 chars, or null).
 */
export function parseHello(raw: unknown): Parsed<Hello> {
  try {
    if (!isPlainObject(raw) || raw.type !== 'hello') return fail('not a hello frame');
    if (!('protocol' in raw) || raw.protocol === undefined) {
      return { ok: true, value: { type: 'hello', host: typeof raw.host === 'string' ? raw.host.slice(0, 100) : null } };
    }
    if (raw.protocol !== 2) return fail('unsupported hello protocol');
    const extra = onlyKeys(raw, ['type', 'protocol', 'machine_id', 'host', 'platform', 'pm_open_turns']);
    if (extra) return fail(`unexpected key ${extra}`);
    const { machine_id, host, platform, pm_open_turns } = raw;
    if (!isMachineId(machine_id)) return fail('machine_id must be a UUID v4');
    if (!isMachineName(host)) return fail(`host must be 1-${MAX_MACHINE_NAME} printable characters`);
    if (typeof platform !== 'string' || !PLATFORM_PATTERN.test(platform)) return fail('invalid platform');
    if (!isTurnIdList(pm_open_turns, 0)) return fail(`pm_open_turns must be at most ${MAX_OPEN_TURNS} unique turn ids`);
    if (serializedBytes(raw) > MAX_PM_FRAME) return fail('frame too large');
    return { ok: true, value: { type: 'hello', protocol: 2, machine_id: normalizeMachineId(machine_id), host, platform, pm_open_turns: [...pm_open_turns] } };
  } catch { return fail('invalid hello'); }
}

export function isHelloV2(hello: Hello): hello is HelloV2 {
  return hello.protocol === 2;
}

// ---------------------------------------------------------------------------------------------
// B. PM state frames
// ---------------------------------------------------------------------------------------------

export const PM_OPS = ['memory.get', 'memory.put', 'memory.edit', 'memory.log', 'memory.import', 'settings.put', 'turn.begin', 'turn.end', 'turn.ack_uncertain'] as const;
export type PmOp = typeof PM_OPS[number];

export const PM_ERROR_CODES = ['stale_epoch', 'not_active', 'version_conflict', 'too_large', 'invalid', 'already_initialized', 'unavailable'] as const;
export type PmErrorCode = typeof PM_ERROR_CODES[number];

export const TURN_OUTCOMES = ['completed', 'failed', 'cancelled', 'uncertain'] as const;
export type TurnOutcome = typeof TURN_OUTCOMES[number];

/** Uncertain reasons the DO records and reports in `pm_assignment`. */
export const UNCERTAIN_REASONS = ['restarted', 'reassigned', 'host_lost'] as const;
export type UncertainReason = typeof UNCERTAIN_REASONS[number];
/** Host-side only: `hung` (#62) is decided locally by the host and never stored in the DO. */
export const HOST_UNCERTAIN_REASONS = [...UNCERTAIN_REASONS, 'hung'] as const;
export type HostUncertainReason = typeof HOST_UNCERTAIN_REASONS[number];

export type Doc = { content: string; version: number; updated_at: string };
export type LogEntry = { seq: number; at: string; text: string };

export interface PmOpArgs {
  'memory.get': Record<string, never>;
  'memory.put': { doc: PmDocName; content: string; expected_version: number };
  'memory.edit': { doc: PmDocName; old_text: string; new_text: string; expected_version: number };
  'memory.log': { text: string };
  'memory.import': { projects: string; log: string[]; model: string | null; source_machine: string };
  'settings.put': { model: string | null };
  'turn.begin': { turn_id: string; accepted_at: string };
  'turn.end': { turn_id: string; outcome: TurnOutcome };
  'turn.ack_uncertain': { turn_ids: string[] };
}

export interface MemoryGetResult {
  initialized: boolean;
  docs: { projects: Doc; preferences: Doc };
  /** Newest ≤200, oldest first. */
  log: LogEntry[];
  settings: { model: string | null };
}

export interface PmOpResults {
  'memory.get': MemoryGetResult;
  'memory.put': { version: number };
  'memory.edit': { version: number };
  'memory.log': { seq: number };
  'memory.import': { imported: true };
  'settings.put': Record<string, never>;
  'turn.begin': Record<string, never>;
  'turn.end': Record<string, never>;
  'turn.ack_uncertain': Record<string, never>;
}

/** host → DO (contract shape). */
export interface PmRpc { type: 'pm_rpc'; id: string; epoch: number; op: PmOp; args: unknown }
/** A validated `pm_rpc`, narrowed per op. Assignable to `PmRpc`. */
export type PmRpcFor<O extends PmOp> = { type: 'pm_rpc'; id: string; epoch: number; op: O; args: PmOpArgs[O] };
export type TypedPmRpc = { [O in PmOp]: PmRpcFor<O> }[PmOp];

/** DO → host. */
export type PmRpcResult =
  | { type: 'pm_rpc_result'; id: string; ok: true; result: unknown }
  | { type: 'pm_rpc_result'; id: string; ok: false; code: PmErrorCode; message: string };

export interface UncertainTurn { turn_id: string; accepted_at: string; host: string; reason: UncertainReason }

/** DO → host, after every v2 hello and on reassignment. `uncertain_turns` is only ever non-empty for the active host. */
export interface PmAssignment {
  type: 'pm_assignment';
  active: boolean;
  epoch: number;
  active_machine: { machine_id: string; host: string } | null;
  uncertain_turns: UncertainTurn[];
}

export function isPmOp(value: unknown): value is PmOp {
  return typeof value === 'string' && (PM_OPS as readonly string[]).includes(value);
}

export function isPmErrorCode(value: unknown): value is PmErrorCode {
  return typeof value === 'string' && (PM_ERROR_CODES as readonly string[]).includes(value);
}

function isDocName(value: unknown): value is PmDocName {
  return typeof value === 'string' && (PM_DOC_NAMES as readonly string[]).includes(value);
}

/** Per-op argument failure: `too_large` for a content bound, `invalid` for everything else. */
export type ArgsParsed<O extends PmOp> = { ok: true; value: PmOpArgs[O] } | { ok: false; code: 'invalid' | 'too_large'; error: string };

function bad(error: string): { ok: false; code: 'invalid'; error: string } { return { ok: false, code: 'invalid', error }; }
function big(error: string): { ok: false; code: 'too_large'; error: string } { return { ok: false, code: 'too_large', error }; }

function docTooLarge(doc: PmDocName, content: string): boolean {
  return utf8Length(content) > PM_DOC_LIMITS[doc];
}

/** Validates `args` for one op. Never throws; returns a fresh copy on success. */
export function parsePmOpArgs<O extends PmOp>(op: O, args: unknown): ArgsParsed<O> {
  try {
    if (!isPlainObject(args)) return bad('args must be an object');
    const a = args;
    const keys = (allowed: readonly string[]) => onlyKeys(a, allowed);
    let extra: string | null;
    switch (op as PmOp) {
      case 'memory.get':
        if ((extra = keys([]))) return bad(`unexpected key ${extra}`);
        return { ok: true, value: {} as PmOpArgs[O] };
      case 'memory.put': {
        if ((extra = keys(['doc', 'content', 'expected_version']))) return bad(`unexpected key ${extra}`);
        if (!isDocName(a.doc)) return bad('doc must be projects or preferences');
        if (typeof a.content !== 'string') return bad('content must be a string');
        if (!isVersion(a.expected_version)) return bad('expected_version must be a non-negative integer');
        if (docTooLarge(a.doc, a.content)) return big(`${a.doc} exceeds ${PM_DOC_LIMITS[a.doc]} bytes`);
        return { ok: true, value: { doc: a.doc, content: a.content, expected_version: a.expected_version } as PmOpArgs[O] };
      }
      case 'memory.edit': {
        if ((extra = keys(['doc', 'old_text', 'new_text', 'expected_version']))) return bad(`unexpected key ${extra}`);
        if (!isDocName(a.doc)) return bad('doc must be projects or preferences');
        if (typeof a.old_text !== 'string' || a.old_text.length === 0) return bad('old_text must be a non-empty string');
        if (typeof a.new_text !== 'string') return bad('new_text must be a string');
        if (!isVersion(a.expected_version)) return bad('expected_version must be a non-negative integer');
        if (docTooLarge(a.doc, a.old_text) || docTooLarge(a.doc, a.new_text)) return big(`edit text exceeds ${PM_DOC_LIMITS[a.doc]} bytes`);
        return { ok: true, value: { doc: a.doc, old_text: a.old_text, new_text: a.new_text, expected_version: a.expected_version } as PmOpArgs[O] };
      }
      case 'memory.log':
        if ((extra = keys(['text']))) return bad(`unexpected key ${extra}`);
        if (typeof a.text === 'string' && a.text.length > MAX_LOG_ENTRY) return big(`log entry exceeds ${MAX_LOG_ENTRY} characters`);
        if (!isLogText(a.text)) return bad(`log text must be ${MIN_LOG_ENTRY}-${MAX_LOG_ENTRY} characters`);
        return { ok: true, value: { text: a.text } as PmOpArgs[O] };
      case 'memory.import': {
        if ((extra = keys(['projects', 'log', 'model', 'source_machine']))) return bad(`unexpected key ${extra}`);
        if (typeof a.projects !== 'string') return bad('projects must be a string');
        if (!Array.isArray(a.log)) return bad('log must be an array of strings');
        if (!isPmModel(a.model)) return bad('invalid model');
        if (!isMachineId(a.source_machine)) return bad('source_machine must be the importing machine_id');
        if (docTooLarge('projects', a.projects)) return big(`projects exceeds ${MAX_PROJECTS_DOC} bytes`);
        if (a.log.length > MAX_LOG_KEPT) return big(`log exceeds ${MAX_LOG_KEPT} entries`);
        for (const line of a.log) {
          if (typeof line === 'string' && line.length > MAX_LOG_ENTRY) return big(`log entry exceeds ${MAX_LOG_ENTRY} characters`);
          if (!isLogText(line)) return bad(`log entries must be ${MIN_LOG_ENTRY}-${MAX_LOG_ENTRY} characters`);
        }
        return { ok: true, value: { projects: a.projects, log: [...(a.log as string[])], model: a.model, source_machine: normalizeMachineId(a.source_machine) } as PmOpArgs[O] };
      }
      case 'settings.put':
        if ((extra = keys(['model']))) return bad(`unexpected key ${extra}`);
        if (!('model' in a) || !isPmModel(a.model)) return bad('model must be a model id or null');
        return { ok: true, value: { model: a.model } as PmOpArgs[O] };
      case 'turn.begin':
        if ((extra = keys(['turn_id', 'accepted_at']))) return bad(`unexpected key ${extra}`);
        if (!isPmId(a.turn_id)) return bad('invalid turn_id');
        if (!isIsoTimestamp(a.accepted_at)) return bad('accepted_at must be an ISO timestamp');
        return { ok: true, value: { turn_id: a.turn_id, accepted_at: a.accepted_at } as PmOpArgs[O] };
      case 'turn.end':
        if ((extra = keys(['turn_id', 'outcome']))) return bad(`unexpected key ${extra}`);
        if (!isPmId(a.turn_id)) return bad('invalid turn_id');
        if (typeof a.outcome !== 'string' || !(TURN_OUTCOMES as readonly string[]).includes(a.outcome)) return bad('invalid outcome');
        return { ok: true, value: { turn_id: a.turn_id, outcome: a.outcome as TurnOutcome } as PmOpArgs[O] };
      case 'turn.ack_uncertain':
        if ((extra = keys(['turn_ids']))) return bad(`unexpected key ${extra}`);
        if (!isTurnIdList(a.turn_ids, 1)) return bad(`turn_ids must be 1-${MAX_OPEN_TURNS} unique turn ids`);
        return { ok: true, value: { turn_ids: [...a.turn_ids] } as PmOpArgs[O] };
      default:
        return bad('unknown op');
    }
  } catch { return bad('invalid args'); }
}

/**
 * Validates a host→DO `pm_rpc`. On failure, `id` is the frame's id when it was valid (so the DO
 * can answer with a `pm_rpc_result` carrying `code`), else null (drop the frame).
 */
export type PmRpcParsed = { ok: true; value: TypedPmRpc } | { ok: false; id: string | null; code: 'invalid' | 'too_large'; error: string };

export function parsePmRpc(raw: unknown): PmRpcParsed {
  let id: string | null = null;
  try {
    if (!isPlainObject(raw) || raw.type !== 'pm_rpc') return { ok: false, id, code: 'invalid', error: 'not a pm_rpc frame' };
    if (isPmId(raw.id)) id = raw.id;
    const extra = onlyKeys(raw, ['type', 'id', 'epoch', 'op', 'args']);
    if (extra) return { ok: false, id, code: 'invalid', error: `unexpected key ${extra}` };
    if (id === null) return { ok: false, id, code: 'invalid', error: 'invalid id' };
    if (!isPmOp(raw.op)) return { ok: false, id, code: 'invalid', error: 'unknown op' };
    const limit = raw.op === 'memory.import' ? MAX_PM_IMPORT_FRAME : MAX_PM_FRAME;
    if (serializedBytes(raw) > limit) return { ok: false, id, code: 'too_large', error: 'frame too large' };
    if (!isEpoch(raw.epoch)) return { ok: false, id, code: 'invalid', error: 'epoch must be a non-negative integer' };
    const args = parsePmOpArgs(raw.op, raw.args);
    if (!args.ok) return { ok: false, id, code: args.code, error: args.error };
    return { ok: true, value: { type: 'pm_rpc', id, epoch: raw.epoch, op: raw.op, args: args.value } as TypedPmRpc };
  } catch { return { ok: false, id, code: 'invalid', error: 'invalid pm_rpc' }; }
}

/** Builds a failed `pm_rpc_result`; the message is redacted and bounded to 300 chars. */
export function pmRpcError(id: string, code: PmErrorCode, message: string): PmRpcResult {
  return { type: 'pm_rpc_result', id, ok: false, code, message: boundedReason(message) };
}

export function pmRpcOk<O extends PmOp>(id: string, _op: O, result: PmOpResults[O]): PmRpcResult {
  return { type: 'pm_rpc_result', id, ok: true, result };
}

/** Validates a DO→host `pm_rpc_result` envelope (the `result` payload is checked with `parsePmOpResult`). */
export function parsePmRpcResult(raw: unknown): Parsed<PmRpcResult> {
  try {
    if (!isPlainObject(raw) || raw.type !== 'pm_rpc_result') return fail('not a pm_rpc_result frame');
    if (!isPmId(raw.id)) return fail('invalid id');
    if (serializedBytes(raw) > MAX_PM_RESULT_FRAME) return fail('frame too large');
    if (raw.ok === true) {
      const extra = onlyKeys(raw, ['type', 'id', 'ok', 'result']);
      if (extra) return fail(`unexpected key ${extra}`);
      if (!('result' in raw)) return fail('missing result');
      return { ok: true, value: { type: 'pm_rpc_result', id: raw.id, ok: true, result: raw.result } };
    }
    if (raw.ok === false) {
      const extra = onlyKeys(raw, ['type', 'id', 'ok', 'code', 'message']);
      if (extra) return fail(`unexpected key ${extra}`);
      if (!isPmErrorCode(raw.code)) return fail('unknown error code');
      if (typeof raw.message !== 'string' || raw.message.length > MAX_PM_ERROR_MESSAGE) return fail(`message must be a string of at most ${MAX_PM_ERROR_MESSAGE} characters`);
      return { ok: true, value: { type: 'pm_rpc_result', id: raw.id, ok: false, code: raw.code, message: raw.message } };
    }
    return fail('ok must be a boolean');
  } catch { return fail('invalid pm_rpc_result'); }
}

function parseDoc(raw: unknown, name: PmDocName): Doc | null {
  if (!isPlainObject(raw) || onlyKeys(raw, ['content', 'version', 'updated_at'])) return null;
  if (typeof raw.content !== 'string' || docTooLarge(name, raw.content)) return null;
  if (!isVersion(raw.version)) return null;
  // A never-written doc reports version 0 and an empty updated_at.
  if (!(raw.updated_at === '' && raw.version === 0) && !isIsoTimestamp(raw.updated_at)) return null;
  return { content: raw.content, version: raw.version, updated_at: raw.updated_at as string };
}

function parseLogEntry(raw: unknown): LogEntry | null {
  if (!isPlainObject(raw) || onlyKeys(raw, ['seq', 'at', 'text'])) return null;
  if (!isVersion(raw.seq) || !isIsoTimestamp(raw.at) || !isLogText(raw.text)) return null;
  return { seq: raw.seq, at: raw.at, text: raw.text };
}

function isEmptyObject(raw: unknown): boolean {
  return isPlainObject(raw) && Object.keys(raw).length === 0;
}

/** Validates the `result` of a successful `pm_rpc_result` for the op the host sent. */
export function parsePmOpResult<O extends PmOp>(op: O, raw: unknown): Parsed<PmOpResults[O]> {
  try {
    switch (op as PmOp) {
      case 'memory.get': {
        if (!isPlainObject(raw) || onlyKeys(raw, ['initialized', 'docs', 'log', 'settings'])) return fail('invalid memory.get result');
        if (typeof raw.initialized !== 'boolean') return fail('initialized must be a boolean');
        if (!isPlainObject(raw.docs) || onlyKeys(raw.docs, PM_DOC_NAMES)) return fail('invalid docs');
        const projects = parseDoc(raw.docs.projects, 'projects');
        const preferences = parseDoc(raw.docs.preferences, 'preferences');
        if (!projects || !preferences) return fail('invalid doc');
        if (!Array.isArray(raw.log) || raw.log.length > MAX_LOG_READ) return fail(`log must be at most ${MAX_LOG_READ} entries`);
        const log: LogEntry[] = [];
        for (const item of raw.log) { const entry = parseLogEntry(item); if (!entry) return fail('invalid log entry'); log.push(entry); }
        if (!isPlainObject(raw.settings) || onlyKeys(raw.settings, ['model']) || !isPmModel(raw.settings.model)) return fail('invalid settings');
        return { ok: true, value: { initialized: raw.initialized, docs: { projects, preferences }, log, settings: { model: raw.settings.model } } as PmOpResults[O] };
      }
      case 'memory.put':
      case 'memory.edit':
        if (!isPlainObject(raw) || onlyKeys(raw, ['version']) || !isVersion(raw.version)) return fail('invalid version result');
        return { ok: true, value: { version: raw.version } as PmOpResults[O] };
      case 'memory.log':
        if (!isPlainObject(raw) || onlyKeys(raw, ['seq']) || !isVersion(raw.seq)) return fail('invalid seq result');
        return { ok: true, value: { seq: raw.seq } as PmOpResults[O] };
      case 'memory.import':
        if (!isPlainObject(raw) || onlyKeys(raw, ['imported']) || raw.imported !== true) return fail('invalid import result');
        return { ok: true, value: { imported: true } as PmOpResults[O] };
      case 'settings.put':
      case 'turn.begin':
      case 'turn.end':
      case 'turn.ack_uncertain':
        if (!isEmptyObject(raw)) return fail('expected an empty result');
        return { ok: true, value: {} as PmOpResults[O] };
      default:
        return fail('unknown op');
    }
  } catch { return fail('invalid result'); }
}

/** Validates a DO→host `pm_assignment`. An inactive assignment must carry no uncertain turns. */
export function parsePmAssignment(raw: unknown): Parsed<PmAssignment> {
  try {
    if (!isPlainObject(raw) || raw.type !== 'pm_assignment') return fail('not a pm_assignment frame');
    const extra = onlyKeys(raw, ['type', 'active', 'epoch', 'active_machine', 'uncertain_turns']);
    if (extra) return fail(`unexpected key ${extra}`);
    if (serializedBytes(raw) > MAX_PM_RESULT_FRAME) return fail('frame too large');
    if (typeof raw.active !== 'boolean') return fail('active must be a boolean');
    if (!isEpoch(raw.epoch)) return fail('epoch must be a non-negative integer');
    let active_machine: PmAssignment['active_machine'] = null;
    if (raw.active_machine !== null) {
      const m = raw.active_machine;
      if (!isPlainObject(m) || onlyKeys(m, ['machine_id', 'host']) || !isMachineId(m.machine_id) || !isMachineName(m.host)) return fail('invalid active_machine');
      active_machine = { machine_id: normalizeMachineId(m.machine_id), host: m.host };
    }
    if (raw.active && active_machine === null) return fail('an active assignment names its machine');
    if (!Array.isArray(raw.uncertain_turns) || raw.uncertain_turns.length > MAX_OPEN_TURNS) return fail(`uncertain_turns must be at most ${MAX_OPEN_TURNS} entries`);
    if (!raw.active && raw.uncertain_turns.length > 0) return fail('uncertain turns go only to the active host');
    const uncertain_turns: UncertainTurn[] = [];
    for (const t of raw.uncertain_turns) {
      if (!isPlainObject(t) || onlyKeys(t, ['turn_id', 'accepted_at', 'host', 'reason'])) return fail('invalid uncertain turn');
      if (!isPmId(t.turn_id) || !isIsoTimestamp(t.accepted_at) || !isMachineName(t.host)) return fail('invalid uncertain turn');
      if (typeof t.reason !== 'string' || !(UNCERTAIN_REASONS as readonly string[]).includes(t.reason)) return fail('invalid uncertain reason');
      uncertain_turns.push({ turn_id: t.turn_id, accepted_at: t.accepted_at, host: t.host, reason: t.reason as UncertainReason });
    }
    return { ok: true, value: { type: 'pm_assignment', active: raw.active, epoch: raw.epoch, active_machine, uncertain_turns } };
  } catch { return fail('invalid pm_assignment'); }
}

// ---------------------------------------------------------------------------------------------
// C. DO records (timestamps are epoch milliseconds, as stored). The SQL text is owned by PMM-02
// (cloud/pm-state.ts); `PM_DO_SCHEMA` is the plan's text for it to use verbatim.
// ---------------------------------------------------------------------------------------------

export const ASSIGNED_BY = ['bootstrap', 'developer'] as const;
export type AssignedBy = typeof ASSIGNED_BY[number];
export const TURN_STATES = ['open', 'uncertain'] as const;
export type TurnState = typeof TURN_STATES[number];

export interface MachineRecord { machine_id: string; name: string; platform: string; first_seen: number; last_seen: number }
export interface PmAssignmentRecord { singleton: 1; machine_id: string; epoch: number; assigned_at: number; assigned_by: AssignedBy }
export interface PmDocRecord { name: PmDocName; content: string; version: number; updated_at: number; updated_epoch: number }
export interface PmLogRecord { seq: number; at: number; text: string; epoch: number }
export interface PmSettingRecord { key: 'model'; value: string | null; updated_at: number }
export interface PmMetaRecord { key: string; value: string }
/** `pm_meta['memory_initialized']` value (JSON). */
export interface PmMemoryInitialized { at: string; source_machine: string; imported: boolean }
export const PM_META_MEMORY_INITIALIZED = 'memory_initialized';
export interface PmTurnRecord { turn_id: string; machine_id: string; epoch: number; accepted_at: number; state: TurnState; reason: UncertainReason | null }

export const PM_DO_SCHEMA: readonly string[] = [
  'CREATE TABLE IF NOT EXISTS machines (machine_id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL)',
  "CREATE TABLE IF NOT EXISTS pm_assignment (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), machine_id TEXT NOT NULL, epoch INTEGER NOT NULL, assigned_at INTEGER NOT NULL, assigned_by TEXT NOT NULL CHECK (assigned_by IN ('bootstrap','developer')))",
  "CREATE TABLE IF NOT EXISTS pm_docs (name TEXT PRIMARY KEY CHECK (name IN ('projects','preferences')), content TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_epoch INTEGER NOT NULL)",
  'CREATE TABLE IF NOT EXISTS pm_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, text TEXT NOT NULL, epoch INTEGER NOT NULL)',
  "CREATE TABLE IF NOT EXISTS pm_settings (key TEXT PRIMARY KEY CHECK (key IN ('model')), value TEXT, updated_at INTEGER NOT NULL)",
  'CREATE TABLE IF NOT EXISTS pm_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  "CREATE TABLE IF NOT EXISTS pm_turns (turn_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, epoch INTEGER NOT NULL, accepted_at INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('open','uncertain')), reason TEXT CHECK (reason IN ('restarted','reassigned','host_lost')))",
];

// ---------------------------------------------------------------------------------------------
// D. HTTP shapes
// ---------------------------------------------------------------------------------------------

export type PmMode = 'relay' | 'local';

/** The active PM host as reported over HTTP. Times (`assigned_at`, `last_seen`) are epoch milliseconds. */
export interface PmHostActive { machine_id: string; name: string; online: boolean; epoch: number; assigned_at: number; assigned_by: AssignedBy }

/** GET /api/pm/host (Worker/DO-terminated; the host answers a single-machine version in local-only mode). */
export interface PmHostResponse {
  active: PmHostActive | null;
  machines: { machine_id: string; name: string; platform: string; online: boolean; last_seen: number; active: boolean }[];
  open_turns: number;
  uncertain_turns: number;
  mode: PmMode;
}

/** POST /api/pm/host request body. */
export interface PmHostMoveRequest { machine_id: string; expected_epoch: number }
/** POST /api/pm/host 200 body: the new active host (same shape as GET's `active`) and the new epoch. */
export interface PmHostMoveResponse { active: PmHostActive; epoch: number }
/** Error bodies for every non-200 answer: 400 already active / local-only, 404 unknown machine, 409 epoch changed or target offline. */
export interface PmHostErrorResponse { error: string }

export const PM_HOST_LOCAL_ONLY_ERROR = 'Reassignment needs the cloud relay';

/** 503 body text for a relayed request while the active PM host is offline. */
export function pmHostOfflineMessage(name: string): string {
  return `Your PM's machine (${name}) is offline.`;
}

export function parsePmHostMoveRequest(raw: unknown): Parsed<PmHostMoveRequest> {
  try {
    if (!isPlainObject(raw)) return fail('body must be an object');
    const extra = onlyKeys(raw, ['machine_id', 'expected_epoch']);
    if (extra) return fail(`unexpected key ${extra}`);
    if (!isMachineId(raw.machine_id)) return fail('machine_id must be a UUID v4');
    if (!isEpoch(raw.expected_epoch)) return fail('expected_epoch must be a non-negative integer');
    return { ok: true, value: { machine_id: normalizeMachineId(raw.machine_id), expected_epoch: raw.expected_epoch } };
  } catch { return fail('invalid body'); }
}

/** GET /api/host: `online`/`host` now describe the active PM host. */
export interface HostStatusResponse { online: boolean; host: string | null; machine_id: string | null; standby_online: boolean }

/** GET /api/pm/history key set (unchanged); `history` is the current conversation only (≤200). */
export const PM_HISTORY_KEYS = ['history', 'error', 'busy', 'model', 'session_id'] as const;
/** GET /api/pm/history?summary=1 key set (unchanged). */
export const PM_HISTORY_SUMMARY_KEYS = ['error', 'busy'] as const;
/** GET /api/memory key set: `log` is text lines. */
export const MEMORY_KEYS = ['projects', 'log', 'preferences'] as const;
export interface MemoryResponse { projects: string; log: string; preferences: string }

// ---------------------------------------------------------------------------------------------
// E. Host store interface (types only)
// ---------------------------------------------------------------------------------------------

export interface PmMemory {
  read(): Promise<{ initialized: boolean; projects: Doc; preferences: Doc; log: LogEntry[]; model: string | null }>;
  write(doc: 'projects' | 'preferences', content: string, expectedVersion: number): Promise<{ version: number }>;
  edit(doc: 'projects' | 'preferences', oldText: string, newText: string, expectedVersion: number): Promise<{ version: number }>;
  log(text: string): Promise<void>;
}

export interface PmStateStore extends PmMemory {
  readonly mode: 'relay' | 'local';
  assignment(): { active: boolean; connected: boolean; epoch: number; activeHost: string | null };
  onAssignment(listener: (a: ReturnType<PmStateStore['assignment']>, uncertain: PmAssignment['uncertain_turns']) => void): () => void;
  setModel(model: string | null): Promise<void>;
  /** Resolves only on durable ack; rejects otherwise. */
  beginTurn(turnId: string, acceptedAt: string): Promise<void>;
  /** Queued while disconnected. */
  endTurn(turnId: string, outcome: 'completed' | 'failed' | 'cancelled' | 'uncertain'): Promise<void>;
  ackUncertain(turnIds: string[]): Promise<void>;
}
