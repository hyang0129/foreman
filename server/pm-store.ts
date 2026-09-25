// Host PM state stores (epic #26, contract E): `RelayPmStore` keeps PM memory, settings and the
// in-flight turn records in the relay Durable Object (over the host bridge's `pm_rpc`), and
// `LocalPmStore` keeps the same things in `<FOREMAN_HOME>/pm/state.json` for local-only mode.
// Both perform the one-time import of this machine's memory: the relay store imports pm/state.json
// (what the PM learned in local-only mode) when it is valid, else the pre-#26 file memory; the local
// store imports the pre-#26 file memory (#117).
//
// Invariants: no PM message text is stored or sent (turn records are ids and timestamps); a turn
// is begun write-ahead (`beginTurn` resolves only on a durable record); nothing is replayed; the
// import never modifies or deletes a source file and never reads pm/history.jsonl, pm/session or
// pm/session.quarantine.jsonl.

import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FOREMAN_HOME } from './paths.ts';
import { PmRpcError, type HostBridge, type PmRpcFailure } from './host-bridge.ts';
import { utf8Length } from '../shared/notify.ts';
import {
  MAX_LOG_ENTRY, MAX_LOG_KEPT, MAX_LOG_READ, MAX_OPEN_TURNS, MAX_PM_IMPORT_FRAME, MAX_PREFERENCES_DOC, MAX_PROJECTS_DOC, MAX_RPC_ID, MIN_LOG_ENTRY,
  PM_DOC_NAMES, TURN_OUTCOMES, isLogText, isPmId, isPmModel, parsePmOpArgs,
  type Doc, type LogEntry, type MachineIdentity, type PmAssignment, type PmDocName, type PmOp, type PmOpArgs, type PmOpResults,
  type PmStateStore, type TurnOutcome, type UncertainTurn,
} from '../shared/pm-state.ts';

export type PmAssignmentState = ReturnType<PmStateStore['assignment']>;
export type PmAssignmentListener = Parameters<PmStateStore['onAssignment']>[0];
export type PmImportTarget = 'relay' | 'local';
/** `imported`: this machine's files were imported now. `already_initialized`: the store already had memory; nothing imported. */
export type PmImportOutcome = 'imported' | 'already_initialized';

/** A store failure. `code` is a DO error code or `disconnected`/`timeout`/`invalid_result`; `message` is safe to show. */
export class PmStoreError extends Error {
  readonly code: PmRpcFailure;
  constructor(code: PmRpcFailure, message: string) { super(message); this.name = 'PmStoreError'; this.code = code; }
}

/** What PMM-05 needs beyond the contract interface. */
export interface HostPmStore extends PmStateStore {
  /** Turns begun and not yet durably ended: pass as the bridge's `pmOpenTurns` provider. */
  openTurnIds(): string[];
  /** Uncertain turns reported to this host and not yet acknowledged. */
  uncertainTurns(): UncertainTurn[];
  /** Runs (or joins) the one-time import; resolves once memory is known to be initialized. */
  ensureImported(): Promise<PmImportOutcome>;
  close(): void;
}

type Logger = (line: string) => void;
const defaultLog: Logger = (line) => console.log(line);

export const ALREADY_INITIALIZED_MESSAGE = 'relay memory already initialized; local memory not imported';
export const IMPORT_MARKER_FILE = '.imported.json';
/** #117: `<home>/memory/.pm-mode.json`, `{ version: 1, mode: 'relay', machine_id, at }`: this machine has used relay PM memory. */
export const PM_MODE_FILE = '.pm-mode.json';
/** #117: logged on every local-only start of a machine that has used relay PM memory. */
export const RELAY_MEMORY_NOT_MERGED_NOTICE = 'this machine has used PM memory held in the cloud relay; that memory is not available in local-only mode and is not merged into pm/state.json. The local PM uses pm/state.json only. Pair this machine with the relay again (cloud.json) to use the relay memory; delete memory/.pm-mode.json to silence this notice.';

// ---------------------------------------------------------------------------------------------
// One-time import
// ---------------------------------------------------------------------------------------------

export interface PmImportPayload { projects: string; log: string[]; model: string | null; source_machine: string }

function readOptional(path: string): string | null {
  try { return existsSync(path) ? readFileSync(path, 'utf8') : null; } catch { return null; }
}

/** Longest prefix of `text` within `maxBytes` UTF-8 bytes, cut after a newline when there is one. */
export function truncateAtLine(text: string, maxBytes: number): { content: string; truncated: boolean } {
  if (utf8Length(text) <= maxBytes) return { content: text, truncated: false };
  let bytes = 0, index = 0, lastBreak = -1;
  for (const ch of text) {
    const size = utf8Length(ch);
    if (bytes + size > maxBytes) break;
    bytes += size; index += ch.length;
    if (ch === '\n') lastBreak = index;
  }
  return { content: text.slice(0, lastBreak > 0 ? lastBreak : index), truncated: true };
}

function truncateChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) { if (out.length + ch.length > max) break; out += ch; }
  return out;
}

/** LOG.md → log entries: one per `- ` line (prefix removed), 3–500 chars, newest 2000. */
export function parseLogLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('- ')) continue;
    const entry = truncateChars(line.slice(2).trim(), MAX_LOG_ENTRY).trim();
    if (entry.length < MIN_LOG_ENTRY || !isLogText(entry)) continue;
    lines.push(entry);
  }
  return lines.slice(-MAX_LOG_KEPT);
}

/** Serialized size of the `memory.import` frame for `payload`, with a worst-case id and epoch. */
export function importFrameBytes(payload: PmImportPayload): number {
  return utf8Length(JSON.stringify({ type: 'pm_rpc', id: 'x'.repeat(MAX_RPC_ID), epoch: Number.MAX_SAFE_INTEGER, op: 'memory.import', args: payload }));
}

/** Drops the oldest log lines until the `memory.import` frame fits MAX_PM_IMPORT_FRAME. `projects` is never trimmed. */
export function fitImportFrame(payload: PmImportPayload, limit = MAX_PM_IMPORT_FRAME): { payload: PmImportPayload; dropped: number } {
  const base = importFrameBytes({ ...payload, log: [] });
  const costs = payload.log.map((line) => utf8Length(JSON.stringify(line)) + 1);
  let total = base + costs.reduce((a, b) => a + b, 0) - (costs.length ? 1 : 0);
  let start = 0;
  while (start < costs.length && total > limit) { total -= costs[start]!; start++; }
  let log = payload.log.slice(start);
  while (log.length && importFrameBytes({ ...payload, log }) > limit) log = log.slice(1);
  return { payload: { ...payload, log }, dropped: payload.log.length - log.length };
}

/**
 * Reads the pre-#26 memory of `home`: memory/PROJECTS.md, memory/LOG.md and pm/settings.json's
 * `model`. Reads nothing else and writes nothing. Missing files import as empty.
 */
export function readImportPayload(home: string, machineId: string, log: Logger = defaultLog): PmImportPayload {
  const projectsText = readOptional(join(home, 'memory', 'PROJECTS.md')) ?? '';
  const projects = truncateAtLine(projectsText, MAX_PROJECTS_DOC);
  if (projects.truncated) log(`foreman: memory import: PROJECTS.md is ${utf8Length(projectsText)} bytes, over the ${MAX_PROJECTS_DOC}-byte limit; importing the first ${utf8Length(projects.content)} bytes, cut at a line boundary`);
  const lines = parseLogLines(readOptional(join(home, 'memory', 'LOG.md')) ?? '');
  let model: string | null = null;
  const settings = readOptional(join(home, 'pm', 'settings.json'));
  if (settings !== null) {
    try { const value = JSON.parse(settings)?.model; if (value !== undefined && isPmModel(value)) model = value; } catch { /* no model */ }
  }
  const fitted = fitImportFrame({ projects: projects.content, log: lines, model, source_machine: machineId });
  if (fitted.dropped) log(`foreman: memory import: dropped the ${fitted.dropped} oldest LOG.md lines to fit the import frame`);
  return fitted.payload;
}

/** What the relay import sends: the `memory.import` payload plus, from pm/state.json only, the `preferences` doc. */
export interface PmImportSource { payload: PmImportPayload; preferences: string; source: 'state' | 'legacy' }

/**
 * #117: reads `<home>/pm/state.json` for the relay import. Returns null (logging why, unless the
 * file is simply absent or was never initialized) when it is missing, a symlink or not a regular
 * file, owned by another user, unparseable, fails LocalPmStore's validation (`parseLocalState`), or
 * was never initialized. Writes nothing.
 */
export function readLocalStateForImport(home: string, log: Logger = defaultLog): LocalState | null {
  const file = join(home, 'pm', 'state.json');
  let why: string;
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) why = 'not a regular file';
    else if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) why = 'owned by another user';
    else {
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { raw = undefined; }
      const state = raw === undefined ? null : parseLocalState(raw);
      if (!state) why = 'invalid';
      else return state.initialized ? state : null;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    why = 'unreadable';
  }
  log(`foreman: memory import: pm/state.json is ${why}; not importing it, importing memory/PROJECTS.md and memory/LOG.md instead (the file is left untouched)`);
  return null;
}

/** #117: the `memory.import` payload (and preferences) from a valid local-only pm/state.json, within the same limits as the legacy import. */
export function importFromLocalState(state: LocalState, machineId: string, log: Logger = defaultLog): PmImportSource {
  const text = state.docs.projects.content;
  const projects = truncateAtLine(text, MAX_PROJECTS_DOC);
  if (projects.truncated) log(`foreman: memory import: the projects doc in pm/state.json is ${utf8Length(text)} bytes, over the ${MAX_PROJECTS_DOC}-byte limit; importing the first ${utf8Length(projects.content)} bytes, cut at a line boundary`);
  const prefsText = state.docs.preferences.content;
  const preferences = truncateAtLine(prefsText, MAX_PREFERENCES_DOC);
  if (preferences.truncated) log(`foreman: memory import: the preferences doc in pm/state.json is ${utf8Length(prefsText)} bytes, over the ${MAX_PREFERENCES_DOC}-byte limit; importing the first ${utf8Length(preferences.content)} bytes, cut at a line boundary`);
  const lines = state.log
    .map((entry) => truncateChars(entry.text.trim(), MAX_LOG_ENTRY).trim())
    .filter((entry) => entry.length >= MIN_LOG_ENTRY && isLogText(entry))
    .slice(-MAX_LOG_KEPT);
  const model = isPmModel(state.model) ? state.model : null;
  const fitted = fitImportFrame({ projects: projects.content, log: lines, model, source_machine: machineId });
  if (fitted.dropped) log(`foreman: memory import: dropped the ${fitted.dropped} oldest pm/state.json log entries to fit the import frame`);
  return { payload: fitted.payload, preferences: preferences.content, source: 'state' };
}

/**
 * #117: this machine's memory for the relay import: pm/state.json when it is a valid, initialized,
 * owned regular file (what the PM learned in local-only mode), else the pre-#26 files, as
 * `readImportPayload`. Reads only; never modifies, renames or deletes a file.
 */
export function readRelayImportSource(home: string, machineId: string, log: Logger = defaultLog): PmImportSource {
  const state = readLocalStateForImport(home, log);
  if (state) return importFromLocalState(state, machineId, log);
  return { payload: readImportPayload(home, machineId, log), preferences: '', source: 'legacy' };
}

/** #117: records in `<home>/memory/.pm-mode.json` that this machine's PM memory is in the relay (mode 0600). */
export function writeRelayModeMarker(home: string, machineId: string, at: string): void {
  atomicWrite(join(home, 'memory', PM_MODE_FILE), JSON.stringify({ version: 1, mode: 'relay', machine_id: machineId, at }) + '\n');
}

/** #117: the `at` of a valid relay marker in `<home>/memory/.pm-mode.json` (an owned regular file), else null. */
export function readRelayModeMarker(home: string): { at: string } | null {
  const file = join(home, 'memory', PM_MODE_FILE);
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!isObject(raw) || raw.version !== 1 || raw.mode !== 'relay' || typeof raw.at !== 'string') return null;
    return { at: raw.at };
  } catch { return null; }
}

/** Records the import in `<home>/memory/.imported.json` as `{ machine_id, at, target }` (mode 0600). */
export function writeImportMarker(home: string, machineId: string, target: PmImportTarget, at: string): void {
  atomicWrite(join(home, 'memory', IMPORT_MARKER_FILE), JSON.stringify({ machine_id: machineId, at, target }) + '\n');
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
  renameSync(tmp, path);
}

const DISCONNECTED_MESSAGE = 'The cloud relay is unreachable, so this machine cannot confirm it is the PM host.';

// ---------------------------------------------------------------------------------------------
// RelayPmStore
// ---------------------------------------------------------------------------------------------

/** The part of HostBridge a RelayPmStore uses. */
export type PmBridge = Pick<HostBridge, 'rpc' | 'onAssignment' | 'onConnection' | 'currentAssignment' | 'connected'>;

export interface RelayPmStoreOptions {
  identity: MachineIdentity;
  /** FOREMAN_HOME to import from, and home of `pm/turn-outbox.json` (default the process's). */
  home?: string;
  log?: Logger;
  now?: () => Date;
  /** Import automatically on activation (default true). */
  autoImport?: boolean;
  /** #116: first retry delay after a turn.end/ack times out while connected (default 1 s), doubling up to `retryMaxMs` (default 30 s). */
  retryBaseMs?: number;
  retryMaxMs?: number;
}

/** #116: the host's durable record of turn updates the relay has not yet confirmed. */
export const TURN_OUTBOX_FILE = 'turn-outbox.json';
// Bounds of the outbox: the DO holds at most MAX_OPEN_TURNS open rows (so at most that many ends
// matter) and caps its uncertain rows at 256 (cloud/pm-state.ts MAX_UNCERTAIN_TURNS).
const MAX_OUTBOX_ENDS = MAX_OPEN_TURNS;
const MAX_OUTBOX_ACKS = 256;

interface TurnOutbox { ends: Map<string, TurnOutcome>; acks: Set<string> }

function readTurnOutbox(file: string, log: Logger): TurnOutbox {
  const outbox: TurnOutbox = { ends: new Map(), acks: new Set() };
  if (!existsSync(file)) return outbox;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.ends) || !Array.isArray(raw.acks)) throw new Error('shape');
    for (const end of raw.ends) if (isObject(end) && isPmId(end.turn_id) && (TURN_OUTCOMES as readonly unknown[]).includes(end.outcome)) outbox.ends.set(end.turn_id, end.outcome);
    for (const id of raw.acks) if (isPmId(id)) outbox.acks.add(id);
  } catch {
    log('foreman: pm/turn-outbox.json is invalid; ignoring it (queued PM turn updates from a previous run are lost)');
  }
  return outbox;
}

type QueueItem =
  | { kind: 'end'; epoch: number; turnId: string; outcome: TurnOutcome; settled: boolean; resolve: () => void }
  | { kind: 'ack'; epoch: number; turnIds: string[]; settled: boolean; resolve: () => void };

/**
 * `PmStateStore` over the relay DO. Usable only while the bridge is connected and the latest
 * `pm_assignment` names this machine active; every op carries the current epoch. `endTurn` and
 * `ackUncertain` queue while disconnected and flush in order once this machine is active again; a
 * `stale_epoch`/`not_active` reply, or an inactive assignment, drops the queue and the store reports
 * not active.
 *
 * #116: every queued end and every acknowledged uncertain turn is also written to
 * `<home>/pm/turn-outbox.json` until the relay confirms it, so a daemon restart neither reports a
 * turn it already reported, nor turns a pending end (e.g. the `failed` end of a begin that never
 * dispatched) into a `restarted` uncertain entry: pending ends are listed as still open in the next
 * hello and flushed on activation, and an uncertain turn this host already knows the outcome of, or
 * already reported, is acknowledged without being reported again. A turn.end/ack that times out
 * while connected is retried with capped exponential backoff.
 */
export class RelayPmStore implements HostPmStore {
  readonly mode = 'relay' as const;
  private bridge: PmBridge;
  private identity: MachineIdentity;
  private home: string;
  private logger: Logger;
  private now: () => Date;
  private autoImport: boolean;
  private connected: boolean;
  private assigned = false; // an assignment frame arrived on the current connection
  private active = false;
  private fenced = false;
  private epoch = 0;
  private activeHost: string | null = null;
  private uncertain: UncertainTurn[] = [];
  private open = new Set<string>();
  private queue: QueueItem[] = [];
  private flushing = false;
  private importRun: Promise<PmImportOutcome> | null = null;
  private importOutcome: PmImportOutcome | null = null;
  private listeners = new Set<PmAssignmentListener>();
  private unsubscribe: (() => void)[] = [];
  private closed = false;
  private outboxFile: string;
  private outbox: TurnOutbox;
  private retryBaseMs: number;
  private retryMaxMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempts = 0;

  constructor(bridge: PmBridge, options: RelayPmStoreOptions) {
    this.bridge = bridge; this.identity = options.identity;
    this.home = options.home ?? FOREMAN_HOME; this.logger = options.log ?? defaultLog;
    this.now = options.now ?? (() => new Date()); this.autoImport = options.autoImport ?? true;
    this.retryBaseMs = options.retryBaseMs ?? 1000; this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? 30_000);
    this.outboxFile = join(this.home, 'pm', TURN_OUTBOX_FILE);
    this.outbox = readTurnOutbox(this.outboxFile, this.logger);
    // Ends a previous run could not deliver: still open as far as this host knows, so the next
    // hello lists them (the DO does not mark them restarted) and activation flushes them.
    for (const turnId of this.outbox.ends.keys()) this.open.add(turnId);
    this.connected = bridge.connected;
    this.unsubscribe.push(bridge.onConnection((connected) => this.connectionChanged(connected)));
    this.unsubscribe.push(bridge.onAssignment((assignment) => this.assignmentChanged(assignment)));
    const current = bridge.currentAssignment();
    if (current && this.connected) this.assignmentChanged(current);
  }

  assignment(): PmAssignmentState {
    return { active: this.usable(), connected: this.connected, epoch: this.epoch, activeHost: this.activeHost };
  }
  /** Replays the current state to the new listener on the next microtask, then reports every change. */
  onAssignment(listener: PmAssignmentListener): () => void {
    this.listeners.add(listener);
    queueMicrotask(() => { if (this.listeners.has(listener)) this.call(listener); });
    return () => { this.listeners.delete(listener); };
  }
  openTurnIds(): string[] { return [...this.open]; }
  uncertainTurns(): UncertainTurn[] { return this.uncertain.map((turn) => ({ ...turn })); }
  close(): void { this.closed = true; this.clearRetry(); for (const off of this.unsubscribe.splice(0)) off(); this.listeners.clear(); }

  async read() {
    await this.importSettled();
    const got = await this.request('memory.get', {});
    return { initialized: got.initialized, projects: got.docs.projects, preferences: got.docs.preferences, log: got.log, model: got.settings.model };
  }
  async write(doc: PmDocName, content: string, expectedVersion: number) {
    await this.importSettled();
    return this.request('memory.put', { doc, content, expected_version: expectedVersion });
  }
  async edit(doc: PmDocName, oldText: string, newText: string, expectedVersion: number) {
    await this.importSettled();
    return this.request('memory.edit', { doc, old_text: oldText, new_text: newText, expected_version: expectedVersion });
  }
  async log(text: string): Promise<void> {
    await this.importSettled();
    await this.request('memory.log', { text });
  }
  async setModel(model: string | null): Promise<void> {
    await this.importSettled();
    await this.request('settings.put', { model });
  }

  /** Write-ahead: resolves only when the DO acknowledged the turn record. */
  async beginTurn(turnId: string, acceptedAt: string): Promise<void> {
    this.guard();
    this.open.add(turnId);
    try {
      await this.request('turn.begin', { turn_id: turnId, accepted_at: acceptedAt });
    } catch (error) {
      const code = (error as PmStoreError).code;
      if (code === 'disconnected' || code === 'timeout' || code === 'invalid_result') {
        // The DO may have recorded it: keep it listed as open and end it as failed when possible,
        // so the record is removed without ever surfacing as uncertain.
        void this.queueEnd(turnId, 'failed');
      } else this.open.delete(turnId);
      throw error;
    }
  }
  /** Sends the outcome now, or queues it while disconnected (resolving once queued). Never rejects. */
  endTurn(turnId: string, outcome: TurnOutcome): Promise<void> {
    return this.queueEnd(turnId, outcome);
  }
  /** Records the acknowledgement durably (synchronously, before it is sent), so a reported turn is never reported again. */
  ackUncertain(turnIds: string[]): Promise<void> {
    const ids = [...new Set(turnIds)];
    if (ids.length === 0) return Promise.resolve();
    for (const id of ids) this.outbox.acks.add(id);
    this.saveOutbox();
    return this.queueAcks(ids);
  }
  private queueEnd(turnId: string, outcome: TurnOutcome): Promise<void> {
    this.outbox.ends.set(turnId, outcome);
    this.saveOutbox();
    return this.enqueue({ kind: 'end', epoch: this.epoch, turnId, outcome, settled: false, resolve: () => {} });
  }
  private queueAcks(ids: string[]): Promise<void> {
    const batches: Promise<void>[] = [];
    for (let i = 0; i < ids.length; i += MAX_OPEN_TURNS) batches.push(this.enqueue({ kind: 'ack', epoch: this.epoch, turnIds: ids.slice(i, i + MAX_OPEN_TURNS), settled: false, resolve: () => {} }));
    return Promise.all(batches).then(() => {});
  }
  // The relay confirmed (or finally refused) this update: forget it.
  private confirmed(item: QueueItem) {
    const changed = item.kind === 'end' ? this.outbox.ends.delete(item.turnId) : item.turnIds.map((id) => this.outbox.acks.delete(id)).some(Boolean);
    if (changed) this.saveOutbox();
  }
  // Best effort: a failed write keeps the in-memory outbox (per-process dedup still holds).
  private saveOutbox() {
    const ends = [...this.outbox.ends].slice(-MAX_OUTBOX_ENDS);
    const acks = [...this.outbox.acks].slice(-MAX_OUTBOX_ACKS);
    if (ends.length < this.outbox.ends.size) this.outbox.ends = new Map(ends);
    if (acks.length < this.outbox.acks.size) this.outbox.acks = new Set(acks);
    try {
      // Nothing pending: no file (so an idle host's pm/ holds nothing new).
      if (!ends.length && !acks.length) { rmSync(this.outboxFile, { force: true }); return; }
      atomicWrite(this.outboxFile, JSON.stringify({ version: 1, ends: ends.map(([turn_id, outcome]) => ({ turn_id, outcome })), acks }) + '\n');
    } catch {
      this.logger('foreman: could not save pm/turn-outbox.json; pending PM turn updates are kept in memory only');
    }
  }
  // Activation: queue every recorded update not yet queued for the current epoch (after a restart,
  // after a move dropped the queue, or when an item queued at an older epoch will be refused).
  private requeueOutbox() {
    const queuedEnds = new Set<string>(), queuedAcks = new Set<string>();
    for (const item of this.queue) {
      if (item.epoch !== this.epoch) continue;
      if (item.kind === 'end') queuedEnds.add(item.turnId); else for (const id of item.turnIds) queuedAcks.add(id);
    }
    for (const [turnId, outcome] of this.outbox.ends) {
      if (queuedEnds.has(turnId)) continue;
      this.open.add(turnId);
      void this.enqueue({ kind: 'end', epoch: this.epoch, turnId, outcome, settled: false, resolve: () => {} });
    }
    const acks = [...this.outbox.acks].filter((id) => !queuedAcks.has(id));
    if (acks.length) void this.queueAcks(acks);
  }
  private clearRetry() {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }
  // A timed-out update while still connected: retry with capped exponential backoff (one timer).
  private scheduleRetry() {
    if (this.closed || this.retryTimer || !this.usable()) return;
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(this.retryAttempts, 16));
    this.retryAttempts++;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.flush(); }, delay);
    this.retryTimer.unref?.();
  }

  /** Imports this machine's file memory if the DO's memory is uninitialized. Once per store. */
  ensureImported(): Promise<PmImportOutcome> {
    if (this.importOutcome) return Promise.resolve(this.importOutcome);
    if (!this.importRun) {
      this.importRun = this.runImport()
        .then((outcome) => { this.importOutcome = outcome; return outcome; })
        .finally(() => { this.importRun = null; });
    }
    return this.importRun;
  }

  // #117: the relay wins when it already has memory (local files are left untouched); otherwise
  // pm/state.json is imported when valid, else the pre-#26 files.
  private async runImport(): Promise<PmImportOutcome> {
    const memory = await this.request('memory.get', {});
    if (memory.initialized) { this.logger(`foreman: ${ALREADY_INITIALIZED_MESSAGE}`); this.markRelayMode(); return 'already_initialized'; }
    const { payload, preferences, source } = readRelayImportSource(this.home, this.identity.machine_id, this.logger);
    try {
      await this.request('memory.import', payload);
    } catch (error) {
      if ((error as PmStoreError).code === 'already_initialized') { this.logger(`foreman: ${ALREADY_INITIALIZED_MESSAGE}`); this.markRelayMode(); return 'already_initialized'; }
      throw error;
    }
    // memory.import carries no preferences doc: a non-empty one from pm/state.json follows as the
    // first write of the fresh doc (expected version 0). Best effort: a failure is logged.
    let prefs = '';
    if (preferences) {
      try { await this.request('memory.put', { doc: 'preferences', content: preferences, expected_version: 0 }); prefs = `, ${utf8Length(preferences)} bytes of preferences`; }
      catch (error) { this.logger(`foreman: memory import: the preferences doc from pm/state.json was not imported (${(error as PmStoreError).code ?? 'error'})`); }
    }
    writeImportMarker(this.home, this.identity.machine_id, 'relay', this.now().toISOString());
    this.markRelayMode();
    const from = source === 'state' ? 'pm/state.json (local-only PM memory)' : 'memory/PROJECTS.md and memory/LOG.md';
    this.logger(`foreman: imported local PM memory into the relay from ${from} (${utf8Length(payload.projects)} bytes of projects, ${payload.log.length} log entries${prefs})`);
    return 'imported';
  }
  // #117: remember that this machine's PM memory is in the relay, for a later local-only start.
  private markRelayMode() {
    try { writeRelayModeMarker(this.home, this.identity.machine_id, this.now().toISOString()); }
    catch { this.logger('foreman: could not save memory/.pm-mode.json'); }
  }
  private async importSettled() {
    if (this.importRun) await this.importRun.catch(() => {});
  }

  private notActiveMessage(): string {
    // After a fence the last known active host may still be this machine's own name: say nothing more.
    const other = this.activeHost && this.activeHost !== this.identity.name ? this.activeHost : null;
    return other ? `The PM runs on ${other}.` : 'This machine is not the PM host.';
  }
  private usable(): boolean { return !this.closed && this.connected && this.assigned && this.active && !this.fenced; }
  private guard() {
    if (this.closed || !this.connected) throw new PmStoreError('disconnected', DISCONNECTED_MESSAGE);
    if (!this.usable()) throw new PmStoreError('not_active', this.notActiveMessage());
  }
  private async request<O extends PmOp>(op: O, args: PmOpArgs[O]): Promise<PmOpResults[O]> {
    this.guard();
    const epoch = this.epoch;
    try {
      return await this.bridge.rpc(op, args, { epoch });
    } catch (error) {
      throw this.failure(error, epoch);
    }
  }
  // Maps an rpc failure to a store error; a stale epoch (or not_active) for the current epoch fences
  // this store and drops the queued outcomes.
  private failure(error: unknown, epoch: number): PmStoreError {
    if (!(error instanceof PmRpcError)) return new PmStoreError('unavailable', 'The PM state store failed.');
    if (error.code === 'stale_epoch' || error.code === 'not_active') {
      if (epoch === this.epoch) this.fence();
      return new PmStoreError('not_active', this.notActiveMessage());
    }
    if (error.code === 'disconnected') return new PmStoreError('disconnected', DISCONNECTED_MESSAGE);
    return new PmStoreError(error.code, error.message);
  }
  private fence() {
    if (this.fenced) return;
    this.fenced = true;
    this.dropQueue('this machine is no longer the PM host');
    this.emit();
  }
  private dropQueue(why: string) {
    if (!this.queue.length) return;
    const dropped = this.queue.splice(0);
    for (const item of dropped) { if (item.kind === 'end') this.open.delete(item.turnId); this.settle(item); }
    this.logger(`foreman: dropped ${dropped.length} queued PM turn update${dropped.length === 1 ? '' : 's'}: ${why}`);
  }
  private settle(item: QueueItem) { if (!item.settled) { item.settled = true; item.resolve(); } }
  private enqueue(item: QueueItem): Promise<void> {
    const done = new Promise<void>((resolve) => { item.resolve = resolve; });
    if (this.closed) { this.settle(item); return done; }
    this.queue.push(item);
    if (!this.usable()) this.settle(item); // held for the next activation
    void this.flush();
    return done;
  }
  private async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length && this.usable()) {
        const item = this.queue[0]!;
        try {
          if (item.kind === 'end') await this.bridge.rpc('turn.end', { turn_id: item.turnId, outcome: item.outcome }, { epoch: item.epoch });
          else await this.bridge.rpc('turn.ack_uncertain', { turn_ids: item.turnIds }, { epoch: item.epoch });
        } catch (error) {
          const code = error instanceof PmRpcError ? error.code : 'unavailable';
          if (code === 'disconnected' || code === 'timeout') {
            // Held at the head (turn.end/ack are idempotent in the DO): retried with backoff while
            // still connected, else on the next connection.
            for (const held of this.queue) this.settle(held);
            this.scheduleRetry();
            return;
          }
          if (code === 'stale_epoch' || code === 'not_active') {
            if (item.epoch === this.epoch) { this.fence(); return; }
            // Older than the current assignment: that turn was already reconciled by the DO. The
            // outbox keeps it, so the next activation resends it with the current epoch.
            this.queue.shift(); if (item.kind === 'end') this.open.delete(item.turnId); this.settle(item);
            continue;
          }
          this.queue.shift(); if (item.kind === 'end') this.open.delete(item.turnId); this.settle(item);
          this.confirmed(item);
          this.logger(`foreman: PM turn update rejected by the relay (${code})`);
          continue;
        }
        this.retryAttempts = 0;
        this.queue.shift();
        if (item.kind === 'end') this.open.delete(item.turnId);
        else this.uncertain = this.uncertain.filter((turn) => !item.turnIds.includes(turn.turn_id));
        this.confirmed(item);
        this.settle(item);
      }
    } finally { this.flushing = false; }
  }
  private connectionChanged(connected: boolean) {
    if (this.closed) return;
    this.clearRetry(); this.retryAttempts = 0; // the next connection flushes the queue
    this.connected = connected;
    this.assigned = false; this.active = false;
    if (!connected) this.uncertain = [];
    this.emit();
  }
  private assignmentChanged(assignment: PmAssignment) {
    if (this.closed) return;
    const wasActive = this.usable();
    this.connected = true; this.assigned = true;
    this.epoch = assignment.epoch; this.active = assignment.active; this.fenced = false;
    this.activeHost = assignment.active_machine?.host ?? null;
    this.uncertain = assignment.active ? this.unreported(assignment.uncertain_turns) : [];
    if (!assignment.active) {
      this.dropQueue(`the PM runs on ${this.activeHost ?? 'no machine'}`);
      // Turns this machine held were reconciled by the DO on reassignment.
      this.open.clear();
    }
    this.emit();
    if (this.usable()) {
      this.requeueOutbox();
      void this.flush();
      if (this.autoImport && !wasActive && !this.importOutcome) {
        this.ensureImported().catch((error) => this.logger(`foreman: memory import did not complete (${(error as PmStoreError).code ?? 'error'}); it will be retried on the next activation`));
      }
    }
  }
  // #116: an uncertain turn this host already reported (ack recorded) or already knows the outcome
  // of (end recorded, e.g. a begin that failed so nothing was dispatched) is not reported again: it
  // is only acknowledged, on activation.
  private unreported(turns: readonly UncertainTurn[]): UncertainTurn[] {
    let changed = false;
    const fresh: UncertainTurn[] = [];
    for (const turn of turns) {
      if (this.outbox.ends.has(turn.turn_id)) {
        // turn.end removes only open rows: this one needs the ack instead.
        this.outbox.ends.delete(turn.turn_id); this.outbox.acks.add(turn.turn_id); changed = true;
        // A queued end for it is left in place: it removes nothing now and is harmless.
        this.open.delete(turn.turn_id);
      }
      if (this.outbox.acks.has(turn.turn_id)) continue;
      fresh.push({ ...turn });
    }
    if (changed) this.saveOutbox();
    return fresh;
  }
  private call(listener: PmAssignmentListener) {
    try { listener(this.assignment(), this.uncertainTurns()); } catch { console.error('foreman: PM assignment listener failed'); }
  }
  private emit() { for (const listener of [...this.listeners]) this.call(listener); }
}

// ---------------------------------------------------------------------------------------------
// LocalPmStore
// ---------------------------------------------------------------------------------------------

interface LocalTurn { turn_id: string; accepted_at: string; state: 'open' | 'uncertain'; reason: 'restarted' | null }
export interface LocalState {
  version: 1;
  initialized: boolean;
  docs: Record<PmDocName, Doc>;
  log: LogEntry[];
  next_seq: number;
  model: string | null;
  turns: LocalTurn[];
}

const emptyDoc = (): Doc => ({ content: '', version: 0, updated_at: '' });
const freshState = (): LocalState => ({ version: 1, initialized: false, docs: { projects: emptyDoc(), preferences: emptyDoc() }, log: [], next_seq: 1, model: null, turns: [] });

function isObject(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function parseLocalState(raw: unknown): LocalState | null {
  if (!isObject(raw) || raw.version !== 1 || typeof raw.initialized !== 'boolean' || !isObject(raw.docs)) return null;
  for (const name of PM_DOC_NAMES) {
    const doc = raw.docs[name];
    if (!isObject(doc) || typeof doc.content !== 'string' || !Number.isSafeInteger(doc.version) || typeof doc.updated_at !== 'string') return null;
  }
  if (!Array.isArray(raw.log) || !raw.log.every((e: any) => isObject(e) && Number.isSafeInteger(e.seq) && typeof e.at === 'string' && typeof e.text === 'string')) return null;
  if (!Number.isSafeInteger(raw.next_seq) || !isPmModel(raw.model)) return null;
  if (!Array.isArray(raw.turns) || !raw.turns.every((t: any) => isObject(t) && isPmId(t.turn_id) && typeof t.accepted_at === 'string' && (t.state === 'open' || t.state === 'uncertain'))) return null;
  return {
    version: 1, initialized: raw.initialized,
    docs: { projects: { ...raw.docs.projects }, preferences: { ...raw.docs.preferences } },
    log: raw.log.map((e: LogEntry) => ({ seq: e.seq, at: e.at, text: e.text })), next_seq: raw.next_seq, model: raw.model,
    turns: raw.turns.map((t: LocalTurn) => ({ turn_id: t.turn_id, accepted_at: t.accepted_at, state: t.state, reason: t.state === 'uncertain' ? 'restarted' : null })),
  };
}

export interface LocalPmStoreOptions {
  identity: MachineIdentity;
  home?: string;
  /** Default `<home>/pm/state.json`. */
  file?: string;
  log?: Logger;
  now?: () => Date;
}

/**
 * `PmStateStore` in one JSON file (atomic temp + rename, mode 0600), for local-only mode. Always
 * active at epoch 1. Open turn records persist, so a turn still open when the daemon stopped comes
 * back as uncertain (`restarted`) on the next open. Imports the file memory on first open.
 */
export class LocalPmStore implements HostPmStore {
  readonly mode = 'local' as const;
  private identity: MachineIdentity;
  private home: string;
  private file: string;
  private log_: Logger;
  private now: () => Date;
  private state: LocalState;
  private listeners = new Set<PmAssignmentListener>();
  private importOutcome: PmImportOutcome;

  constructor(options: LocalPmStoreOptions) {
    this.identity = options.identity; this.home = options.home ?? FOREMAN_HOME;
    this.file = options.file ?? join(this.home, 'pm', 'state.json');
    this.log_ = options.log ?? defaultLog; this.now = options.now ?? (() => new Date());
    // #117: relay → local-only never merges; say so on every local-only start while the marker applies.
    const relayMarker = readRelayModeMarker(this.home);
    if (relayMarker) this.log_(`foreman: PM memory: ${RELAY_MEMORY_NOT_MERGED_NOTICE} (relay mode last used ${relayMarker.at})`);
    let state = freshState();
    if (existsSync(this.file)) {
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(this.file, 'utf8')); } catch { throw new Error('Invalid pm/state.json'); }
      const parsed = parseLocalState(raw);
      if (!parsed) throw new Error('Invalid pm/state.json');
      state = parsed;
    }
    // A turn still open from a previous daemon cannot be confirmed: report it once as uncertain.
    let changed = !existsSync(this.file);
    for (const turn of state.turns) if (turn.state === 'open') { turn.state = 'uncertain'; turn.reason = 'restarted'; changed = true; }
    this.importOutcome = 'already_initialized';
    if (!state.initialized) {
      const payload = readImportPayload(this.home, this.identity.machine_id, this.log_);
      const at = this.now().toISOString();
      if (payload.projects) state.docs.projects = { content: payload.projects, version: 1, updated_at: at };
      for (const text of payload.log) state.log.push({ seq: state.next_seq++, at, text });
      state.log = state.log.slice(-MAX_LOG_KEPT);
      state.model = payload.model;
      state.initialized = true;
      changed = true;
      this.importOutcome = 'imported';
    }
    if (changed) this.persist(state);
    this.state = state;
    if (this.importOutcome === 'imported') {
      writeImportMarker(this.home, this.identity.machine_id, 'local', this.now().toISOString());
      this.log_(`foreman: imported local PM memory into pm/state.json (${utf8Length(state.docs.projects.content)} bytes of projects, ${state.log.length} log entries)`);
    }
  }

  assignment(): PmAssignmentState { return { active: true, connected: true, epoch: 1, activeHost: this.identity.name }; }
  onAssignment(listener: PmAssignmentListener): () => void {
    this.listeners.add(listener);
    queueMicrotask(() => {
      if (!this.listeners.has(listener)) return;
      try { listener(this.assignment(), this.uncertainTurns()); } catch { console.error('foreman: PM assignment listener failed'); }
    });
    return () => { this.listeners.delete(listener); };
  }
  openTurnIds(): string[] { return this.state.turns.filter((t) => t.state === 'open').map((t) => t.turn_id); }
  uncertainTurns(): UncertainTurn[] {
    return this.state.turns.filter((t) => t.state === 'uncertain').map((t) => ({ turn_id: t.turn_id, accepted_at: t.accepted_at, host: this.identity.name, reason: 'restarted' as const }));
  }
  ensureImported(): Promise<PmImportOutcome> { return Promise.resolve(this.importOutcome); }
  close(): void { this.listeners.clear(); }

  async read() {
    const s = this.state;
    return { initialized: s.initialized, projects: { ...s.docs.projects }, preferences: { ...s.docs.preferences }, log: s.log.slice(-MAX_LOG_READ).map((e) => ({ ...e })), model: s.model };
  }
  async write(doc: PmDocName, content: string, expectedVersion: number) {
    const args = this.check('memory.put', { doc, content, expected_version: expectedVersion });
    const current = this.state.docs[args.doc];
    if (current.version !== args.expected_version) throw new PmStoreError('version_conflict', `${args.doc} changed (version ${current.version}); read it again before writing`);
    const version = current.version + 1;
    this.mutate((s) => { s.docs[args.doc] = { content: args.content, version, updated_at: this.now().toISOString() }; s.initialized = true; });
    return { version };
  }
  async edit(doc: PmDocName, oldText: string, newText: string, expectedVersion: number) {
    const args = this.check('memory.edit', { doc, old_text: oldText, new_text: newText, expected_version: expectedVersion });
    const current = this.state.docs[args.doc];
    if (current.version !== args.expected_version) throw new PmStoreError('version_conflict', `${args.doc} changed (version ${current.version}); read it again before editing`);
    const first = current.content.indexOf(args.old_text);
    if (first < 0 || current.content.indexOf(args.old_text, first + 1) >= 0) throw new PmStoreError('invalid', 'old_text must occur exactly once');
    const content = current.content.slice(0, first) + args.new_text + current.content.slice(first + args.old_text.length);
    this.check('memory.put', { doc: args.doc, content, expected_version: args.expected_version });
    const version = current.version + 1;
    this.mutate((s) => { s.docs[args.doc] = { content, version, updated_at: this.now().toISOString() }; s.initialized = true; });
    return { version };
  }
  async log(text: string): Promise<void> {
    const args = this.check('memory.log', { text });
    this.mutate((s) => { s.log.push({ seq: s.next_seq++, at: this.now().toISOString(), text: args.text }); s.log = s.log.slice(-MAX_LOG_KEPT); s.initialized = true; });
  }
  async setModel(model: string | null): Promise<void> {
    const args = this.check('settings.put', { model });
    this.mutate((s) => { s.model = args.model; });
  }
  /** Write-ahead: resolves only after the record is on disk. */
  async beginTurn(turnId: string, acceptedAt: string): Promise<void> {
    const args = this.check('turn.begin', { turn_id: turnId, accepted_at: acceptedAt });
    // Same semantics as the relay DO: a repeated begin of a still-open turn is acknowledged again,
    // an id already reported uncertain is invalid, and a 65th open turn is unavailable.
    const existing = this.state.turns.find((t) => t.turn_id === args.turn_id);
    if (existing) {
      if (existing.state === 'open') return;
      throw new PmStoreError('invalid', 'turn_id is already recorded');
    }
    if (this.state.turns.filter((t) => t.state === 'open').length >= MAX_OPEN_TURNS) throw new PmStoreError('unavailable', `At most ${MAX_OPEN_TURNS} PM turns can be open`);
    this.mutate((s) => { s.turns.push({ turn_id: args.turn_id, accepted_at: args.accepted_at, state: 'open', reason: null }); });
  }
  async endTurn(turnId: string, outcome: TurnOutcome): Promise<void> {
    const args = this.check('turn.end', { turn_id: turnId, outcome });
    if (!this.state.turns.some((t) => t.turn_id === args.turn_id && t.state === 'open')) return;
    this.mutate((s) => { s.turns = s.turns.filter((t) => !(t.turn_id === args.turn_id && t.state === 'open')); });
  }
  async ackUncertain(turnIds: string[]): Promise<void> {
    const ids = new Set(turnIds);
    if (!this.state.turns.some((t) => t.state === 'uncertain' && ids.has(t.turn_id))) return;
    this.mutate((s) => { s.turns = s.turns.filter((t) => !(t.state === 'uncertain' && ids.has(t.turn_id))); });
  }

  private check<O extends PmOp>(op: O, args: PmOpArgs[O]): PmOpArgs[O] {
    const parsed = parsePmOpArgs(op, args);
    if (!parsed.ok) throw new PmStoreError(parsed.code, parsed.error);
    return parsed.value;
  }
  private mutate(change: (state: LocalState) => void) {
    const next: LocalState = structuredClone(this.state);
    change(next);
    try { this.persist(next); }
    catch { throw new PmStoreError('unavailable', 'Could not save pm/state.json'); }
    this.state = next;
  }
  private persist(state: LocalState) { atomicWrite(this.file, JSON.stringify(state)); }
}

// ---------------------------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------------------------

/**
 * The store for this daemon: `RelayPmStore` when a v2 bridge is given (relay configured), else
 * `LocalPmStore`. Wire the bridge's `pmOpenTurns` to `store.openTurnIds()`.
 */
export function createPmStore(options: { identity: MachineIdentity; home?: string; bridge?: PmBridge | null; log?: Logger; now?: () => Date }): HostPmStore {
  if (options.bridge) return new RelayPmStore(options.bridge, options);
  return new LocalPmStore(options);
}
