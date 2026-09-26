// Host Lead stores (epic #157, story CL-03): `RelayLeadStore` keeps the Lead registry and handoffs
// in the relay Durable Object (over the host bridge's `lead_rpc`), and `LocalLeadStore` serves the
// same interface from this machine's files in local-only mode. Both implement `LeadStore` (and so
// `GrantSource`) from shared/roles.ts.
//
// On this machine (both stores), every handoff is appended to `<home>/leads/<uuid>.jsonl` (dir
// 0700, files 0600): a Lead's state stays on its machine. Each Lead's `seq` is host-assigned and
// monotonic across restarts (the next seq is one past the highest valid seq in that file).
//
// Relay store only:
// - Outbox. A handoff is also queued in `<home>/leads/outbox.json` (0600, atomic write) and
//   `appendHandoff` resolves after the local writes, never after the DO ack. The outbox is flushed
//   in order (per Lead): a `{ stored: false }` answer (duplicate `(lead, seq)`) counts as delivered;
//   a transient failure (disconnected, timeout, unavailable, invalid result) keeps the entry for the
//   next hello or resync tick; `not_found` (the Lead's row is not in the DO yet) holds that Lead's
//   entries until a `lead.upsert` / `lead.sync` carrying its row succeeds (which triggers a flush at
//   once) or the next hello or tick, and drops an entry held that way once it is older than
//   `LEAD_OUTBOX_MAX_AGE_MS` (logged); `forbidden` / `invalid` / `too_large` drop the entry with a logged
//   diagnostic, so nothing is ever retried in a loop.
// - Registry. `upsert` sends a row at once and coalesces further edges for the same Lead into one
//   send per 30 s (latest row wins). `track(source)` registers this machine's rows; all of them are
//   resynced with `lead.sync` (chunked to fit `MAX_LEAD_FRAME` and `MAX_SYNC_RECORDS`) on every
//   hello and every 4 min while connected, before the outbox is flushed.
// - Reads (`list` / `get` / `latestHandoff`) go to the DO. When it cannot answer (disconnected,
//   timeout, …) they fall back to this machine's own rows and handoff files, marked `local: true`,
//   and never throw a network error to a tool.
// - `devSettings` asks the DO on every call (no cache, so a revoked grant applies at once) and
//   resolves null on timeout, disconnect or any failure.
//
// Nothing here carries a filesystem path to the relay: records and handoffs are validated with the
// shared contract before they are stored or sent.

import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { LEADS_DIR } from './paths.ts';
import { LeadRpcError, type HostBridge, type LeadRpcFailure } from './host-bridge.ts';
import { utf8Length } from '../shared/notify.ts';
import { MAX_RPC_ID, type MachineIdentity } from '../shared/pm-state.ts';
import {
  GRANT_TIMEOUT_MS, MAX_HANDOFF_READ, MAX_HANDOFFS_KEPT, MAX_LEAD_FRAME, MAX_LEAD_LIST, MAX_LEAD_WORKERS, MAX_SYNC_RECORDS,
  isLeadKey, isSessionKey, isSessionName, isSessionState, normalizeLeadKey, parseLeadHandoff, parseLeadRecord,
  type DevSettingsView, type HandoffWorker, type LeadHandoff, type LeadListEntry, type LeadRecord, type LeadStore,
} from '../shared/roles.ts';

type Logger = (line: string) => void;
const defaultLog: Logger = (line) => console.log(line);

/** Registry edges for one Lead are sent at most once per this window (the latest row wins). */
export const LEAD_UPSERT_DEBOUNCE_MS = 30_000;
/** Full resync period while connected (keeps the DO's `reported_at` within 5 min). */
export const LEAD_RESYNC_INTERVAL_MS = 4 * 60_000;
export const LEAD_OUTBOX_FILE = 'outbox.json';
/** Outbox bounds: the DO keeps only the newest 20 handoffs per Lead, so older queued ones are dropped first. */
export const MAX_OUTBOX_PER_LEAD = MAX_HANDOFFS_KEPT;
export const MAX_OUTBOX_TOTAL = 400;
/** A handoff still refused `not_found` (its Lead's row never reached the DO) after this long is dropped from the outbox. */
export const LEAD_OUTBOX_MAX_AGE_MS = 24 * 60 * 60_000;

/** The input of `appendHandoff` (the host assigns `v`, `seq`, `at` and `workers`). */
export type LeadHandoffInput = Parameters<LeadStore['appendHandoff']>[0];
/** A row served from this machine's data because the DO could not answer (or local-only mode). */
export type LocalLeadListEntry = LeadListEntry & { local: true };
export type LeadGetResult = { lead: LeadListEntry; handoffs: LeadHandoff[]; local?: true };

/** A failed `appendHandoff`: `invalid` / `too_large` (the handoff fails the contract) or `io` (the local write failed). */
export class LeadStoreError extends Error {
  readonly code: 'invalid' | 'too_large' | 'closed' | 'io';
  constructor(code: LeadStoreError['code'], message: string) { super(message); this.name = 'LeadStoreError'; this.code = code; }
}

export interface LeadStoreOptions {
  identity: MachineIdentity;
  /** FOREMAN_HOME holding `leads/` (default the process's). */
  home?: string;
  /** The Lead's current workers, filled into every handoff (the model never writes them). */
  workersOf?: (lead: string) => readonly HandoffWorker[] | Promise<readonly HandoffWorker[]>;
  log?: Logger;
  now?: () => Date;
  /** Test hooks. */
  upsertDebounceMs?: number;
  resyncIntervalMs?: number;
}

/** The part of HostBridge a RelayLeadStore uses. */
export type LeadBridge = Pick<HostBridge, 'leadRpc' | 'onConnection' | 'connected'>;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function leadUuid(lead: string): string { return normalizeLeadKey(lead).slice('fm:'.length); }

function isEnded(record: LeadRecord): boolean {
  return record.state === 'ended' || record.state === 'dead' || record.superseded_by !== undefined;
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
  renameSync(tmp, path);
}

/** Serialized bytes of a `lead.sync` frame carrying `records`, with a worst-case id. */
export function syncFrameBytes(records: readonly LeadRecord[]): number {
  return utf8Length(JSON.stringify({ type: 'lead_rpc', id: 'x'.repeat(MAX_RPC_ID), op: 'lead.sync', args: { records } }));
}

/**
 * Splits rows into `lead.sync` chunks, in order, each at most `maxRecords` rows and at most
 * `maxFrame` bytes serialized (worst-case id). A row is at most 16 KiB, so every row fits a chunk.
 */
export function chunkSyncRecords(records: readonly LeadRecord[], maxFrame = MAX_LEAD_FRAME, maxRecords = MAX_SYNC_RECORDS): LeadRecord[][] {
  const base = syncFrameBytes([]);
  const chunks: LeadRecord[][] = [];
  let chunk: LeadRecord[] = [], bytes = base;
  for (const record of records) {
    const size = utf8Length(JSON.stringify(record));
    // `+ 1`: the comma before every row but the first.
    if (chunk.length && (chunk.length >= maxRecords || bytes + 1 + size > maxFrame)) {
      chunks.push(chunk); chunk = []; bytes = base;
    }
    bytes += size + (chunk.length ? 1 : 0);
    chunk.push(record);
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function cleanWorkers(raw: unknown): HandoffWorker[] {
  if (!Array.isArray(raw)) return [];
  const out: HandoffWorker[] = [];
  for (const w of raw) {
    if (out.length >= MAX_LEAD_WORKERS) break;
    if (!isObject(w) || !isSessionKey(w.session_key) || !isSessionName(w.name) || !isSessionState(w.state)) continue;
    out.push({ session_key: w.session_key, name: w.name, state: w.state });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Local files: `<home>/leads/<uuid>.jsonl`
// ---------------------------------------------------------------------------------------------

/** This machine's handoff logs. Synchronous, so a seq is assigned and written in one step. */
export class LeadFiles {
  readonly dir: string;
  private lastSeqs = new Map<string, number>();
  constructor(dir: string) { this.dir = dir; }

  /** Creates the directory (0700) or tightens an existing one; refuses a symlink or non-directory. */
  ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new LeadStoreError('io', 'The leads directory must be a real directory');
    if ((stat.mode & 0o077) !== 0) chmodSync(this.dir, 0o700);
  }
  fileOf(lead: string): string { return join(this.dir, `${leadUuid(lead)}.jsonl`); }

  /** Valid handoffs of `lead` in file order (invalid or foreign lines are skipped). */
  read(lead: string): LeadHandoff[] {
    const key = normalizeLeadKey(lead);
    const file = this.fileOf(key);
    let text: string;
    try {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) return [];
      text = readFileSync(file, 'utf8');
    } catch { return []; }
    const out: LeadHandoff[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { continue; }
      const parsed = parseLeadHandoff(raw);
      if (parsed.ok && parsed.value.lead === key) out.push(parsed.value);
    }
    return out;
  }
  /** Newest first (by seq), at most `count`. */
  newest(lead: string, count: number): LeadHandoff[] {
    return this.read(lead).sort((a, b) => b.seq - a.seq).slice(0, count);
  }
  lastSeq(lead: string): number {
    const key = normalizeLeadKey(lead);
    let seq = this.lastSeqs.get(key);
    if (seq === undefined) {
      seq = 0;
      for (const handoff of this.read(key)) if (handoff.seq > seq) seq = handoff.seq;
      this.lastSeqs.set(key, seq);
    }
    return seq;
  }
  /** Appends one line (0600). A torn last line from a crash is terminated first, never joined. */
  append(handoff: LeadHandoff): void {
    this.ensureDir();
    const file = this.fileOf(handoff.lead);
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new LeadStoreError('io', 'A Lead handoff log must be a regular file');
    }
    const fd = openSync(file, 'a+', 0o600);
    try {
      const stat = fstatSync(fd);
      if ((stat.mode & 0o077) !== 0) chmodSync(file, 0o600);
      let prefix = '';
      if (stat.size > 0) {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, stat.size - 1);
        if (last[0] !== 0x0a) prefix = '\n';
      }
      writeSync(fd, prefix + JSON.stringify(handoff) + '\n');
    } finally { closeSync(fd); }
    this.lastSeqs.set(handoff.lead, Math.max(handoff.seq, this.lastSeqs.get(handoff.lead) ?? 0));
  }
}

// ---------------------------------------------------------------------------------------------
// Shared local behavior
// ---------------------------------------------------------------------------------------------

abstract class BaseLeadStore implements LeadStore {
  abstract readonly mode: 'relay' | 'local';
  protected identity: MachineIdentity;
  protected files: LeadFiles;
  protected logger: Logger;
  protected now: () => Date;
  protected workersOf?: LeadStoreOptions['workersOf'];
  protected source: (() => LeadRecord[]) | null = null;
  /** The latest row passed to `upsert`, per Lead. */
  protected latest = new Map<string, LeadRecord>();
  protected closed = false;

  constructor(options: LeadStoreOptions) {
    this.identity = options.identity;
    this.logger = options.log ?? defaultLog;
    this.now = options.now ?? (() => new Date());
    this.workersOf = options.workersOf;
    this.files = new LeadFiles(options.home ? join(options.home, 'leads') : LEADS_DIR);
  }

  abstract devSettings(timeoutMs?: number): Promise<DevSettingsView | null>;
  abstract list(opts?: { include_ended?: boolean; limit?: number }): Promise<LeadListEntry[]>;
  abstract get(lead: string, handoffs?: number): Promise<LeadGetResult | null>;

  appendHandoff(input: LeadHandoffInput): Promise<LeadHandoff> { return this.storeHandoff(input); }

  /** Validates and stores the row for local reads (and, in the relay store, sends it). */
  upsert(record: LeadRecord): void { this.accept(record); }
  track(records: () => LeadRecord[]): void { this.source = records; }

  async latestHandoff(lead: string): Promise<LeadHandoff | null> {
    if (!isLeadKey(lead)) return null;
    const got = await this.get(lead, 1);
    const remote = got?.handoffs[0] ?? null;
    const local = this.files.newest(lead, 1)[0] ?? null;
    if (!remote) return local;
    return local && local.seq > remote.seq ? local : remote;
  }

  close(): void { this.closed = true; }

  protected accept(record: LeadRecord): LeadRecord | null {
    if (this.closed) return null;
    const parsed = parseLeadRecord(record);
    if (!parsed.ok) { this.logger(`foreman: dropped an invalid Lead row (${parsed.error})`); return null; }
    if (parsed.value.machine_id !== this.identity.machine_id) { this.logger('foreman: dropped a Lead row that belongs to another machine'); return null; }
    this.latest.set(parsed.value.lead, parsed.value);
    return parsed.value;
  }

  protected async storeHandoff(input: LeadHandoffInput): Promise<LeadHandoff> {
    if (this.closed) throw new LeadStoreError('closed', 'The Lead store is closed.');
    const rawLead = isObject(input) ? input.lead : undefined;
    if (!isLeadKey(rawLead)) throw new LeadStoreError('invalid', 'lead must be a Lead session key fm:<uuid>');
    const lead = normalizeLeadKey(rawLead);
    let workers: HandoffWorker[] = [];
    if (this.workersOf) {
      try { workers = cleanWorkers(await this.workersOf(lead)); }
      catch { this.logger('foreman: the Lead workers provider failed; the handoff lists no workers'); }
    }
    // Synchronous from here: the seq is read and written with no await in between.
    const seq = this.files.lastSeq(lead) + 1;
    const parsed = parseLeadHandoff({ ...input, v: 1, lead, seq, at: this.now().toISOString(), workers });
    if (!parsed.ok) throw new LeadStoreError(/exceeds/.test(parsed.error) ? 'too_large' : 'invalid', parsed.error);
    try { this.files.append(parsed.value); }
    catch (error) {
      if (error instanceof LeadStoreError) throw error;
      throw new LeadStoreError('io', 'The handoff could not be written on this machine.');
    }
    this.stored(parsed.value);
    return parsed.value;
  }
  /** Called after a handoff is on disk. */
  protected stored(_handoff: LeadHandoff): void {}

  /** This machine's rows: the tracked source, overlaid by newer upserted rows. Validated, own machine only. */
  protected records(): LeadRecord[] {
    const out = new Map<string, LeadRecord>();
    let provided: unknown[] = [];
    try { provided = this.source ? [...this.source()] : []; }
    catch { this.logger('foreman: the Lead registry source failed; using the last upserted rows'); }
    for (const raw of provided) {
      const parsed = parseLeadRecord(raw);
      if (!parsed.ok || parsed.value.machine_id !== this.identity.machine_id) continue;
      out.set(parsed.value.lead, parsed.value);
    }
    for (const record of this.latest.values()) {
      const known = out.get(record.lead);
      if (!known || record.updated_at > known.updated_at) out.set(record.lead, record);
    }
    return [...out.values()];
  }

  protected localEntry(record: LeadRecord): LocalLeadListEntry {
    // This machine is running, so its own Leads' machine is online; `reported_at` is the row's own time.
    return { ...record, machine_online: true, reported_at: record.updated_at, ended: isEnded(record), local: true };
  }
  protected localList(opts: { include_ended?: boolean; limit?: number } = {}): LocalLeadListEntry[] {
    const limit = clampInt(opts.limit, 1, MAX_LEAD_LIST, MAX_LEAD_LIST);
    return this.records()
      .map((record) => this.localEntry(record))
      .filter((entry) => opts.include_ended === true || !entry.ended)
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, limit);
  }
  protected localGet(lead: string, handoffs: number): LeadGetResult | null {
    const key = normalizeLeadKey(lead);
    const record = this.records().find((r) => r.lead === key);
    if (!record) return null;
    return { lead: this.localEntry(record), handoffs: this.files.newest(key, handoffs), local: true };
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

// ---------------------------------------------------------------------------------------------
// LocalLeadStore (no relay configured)
// ---------------------------------------------------------------------------------------------

/**
 * Local-only mode: the same handoff logs, reads from this machine's data (marked `local: true`),
 * and no grants at all (`devSettings()` → null, so agent launches fall back to Auto).
 */
export class LocalLeadStore extends BaseLeadStore {
  readonly mode = 'local' as const;
  async devSettings(_timeoutMs?: number): Promise<DevSettingsView | null> { return null; }
  async list(opts?: { include_ended?: boolean; limit?: number }): Promise<LeadListEntry[]> { return this.localList(opts); }
  async get(lead: string, handoffs = 0): Promise<LeadGetResult | null> {
    if (!isLeadKey(lead)) return null;
    return this.localGet(lead, clampInt(handoffs, 0, MAX_HANDOFF_READ, 0));
  }
}

// ---------------------------------------------------------------------------------------------
// RelayLeadStore
// ---------------------------------------------------------------------------------------------

const TRANSIENT: ReadonlySet<LeadRpcFailure> = new Set(['disconnected', 'timeout', 'unavailable', 'invalid_result']);
function failureCode(error: unknown): LeadRpcFailure { return error instanceof LeadRpcError ? error.code : 'unavailable'; }

export class RelayLeadStore extends BaseLeadStore {
  readonly mode = 'relay' as const;
  private bridge: LeadBridge;
  private connected: boolean;
  private outboxFile: string;
  private outbox: LeadHandoff[];
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  /** Leads whose handoffs were last refused `not_found`: a successful upsert/sync of their row flushes at once. */
  private awaitingRow = new Set<string>();
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  private resyncTimer: ReturnType<typeof setInterval> | null = null;
  private upsertTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private upsertPending = new Map<string, LeadRecord>();
  private upsertSentAt = new Map<string, number>();
  private debounceMs: number;
  private resyncMs: number;
  private unsubscribe: (() => void)[] = [];

  constructor(bridge: LeadBridge, options: LeadStoreOptions) {
    super(options);
    this.bridge = bridge;
    this.debounceMs = options.upsertDebounceMs ?? LEAD_UPSERT_DEBOUNCE_MS;
    this.resyncMs = options.resyncIntervalMs ?? LEAD_RESYNC_INTERVAL_MS;
    this.outboxFile = join(this.files.dir, LEAD_OUTBOX_FILE);
    this.outbox = this.readOutbox();
    this.connected = false;
    this.unsubscribe.push(bridge.onConnection((connected) => this.connectionChanged(connected)));
    if (bridge.connected) this.connectionChanged(true);
  }

  /** Handoffs not yet confirmed by the DO, oldest first. */
  pendingHandoffs(): LeadHandoff[] { return this.outbox.map((h) => ({ ...h })); }

  override track(records: () => LeadRecord[]): void {
    super.track(records);
    if (this.connected) void this.resync();
  }

  override upsert(record: LeadRecord): void {
    const row = this.accept(record);
    if (!row) return;
    const lead = row.lead;
    if (this.upsertTimers.has(lead)) { this.upsertPending.set(lead, row); return; }
    const last = this.upsertSentAt.get(lead);
    const now = Date.now();
    if (last === undefined || now - last >= this.debounceMs) { this.sendUpsert(row); return; }
    this.upsertPending.set(lead, row);
    const timer = setTimeout(() => {
      this.upsertTimers.delete(lead);
      const pending = this.upsertPending.get(lead);
      this.upsertPending.delete(lead);
      if (pending && !this.closed) this.sendUpsert(pending);
    }, last + this.debounceMs - now);
    timer.unref?.();
    this.upsertTimers.set(lead, timer);
  }

  async devSettings(timeoutMs: number = GRANT_TIMEOUT_MS): Promise<DevSettingsView | null> {
    if (this.closed || !this.connected || !this.bridge.connected) return null;
    try { return await this.bridge.leadRpc('settings.get', {}, { timeoutMs }); }
    catch { return null; }
  }

  async list(opts: { include_ended?: boolean; limit?: number } = {}): Promise<LeadListEntry[]> {
    const args: { include_ended?: boolean; limit?: number } = {};
    if (typeof opts.include_ended === 'boolean') args.include_ended = opts.include_ended;
    if (opts.limit !== undefined) args.limit = clampInt(opts.limit, 1, MAX_LEAD_LIST, MAX_LEAD_LIST);
    if (this.readable()) {
      try { return (await this.bridge.leadRpc('lead.list', args)).leads; }
      catch (error) { this.logger(`foreman: lead.list failed (${failureCode(error)}); serving this machine's own Leads`); }
    }
    return this.localList(args);
  }

  async get(lead: string, handoffs = 0): Promise<LeadGetResult | null> {
    if (!isLeadKey(lead)) return null;
    const key = normalizeLeadKey(lead);
    const count = clampInt(handoffs, 0, MAX_HANDOFF_READ, 0);
    if (this.readable()) {
      try {
        const got = await this.bridge.leadRpc('lead.get', { lead: key, handoffs: count });
        return { lead: got.lead, handoffs: this.withLocal(key, got.handoffs, count) };
      } catch (error) {
        const code = failureCode(error);
        if (code !== 'not_found') this.logger(`foreman: lead.get failed (${code}); serving this machine's own data`);
      }
    }
    return this.localGet(key, count);
  }

  override close(): void {
    super.close();
    if (this.resyncTimer) { clearInterval(this.resyncTimer); this.resyncTimer = null; }
    for (const timer of this.upsertTimers.values()) clearTimeout(timer);
    this.upsertTimers.clear(); this.upsertPending.clear();
    for (const off of this.unsubscribe.splice(0)) off();
  }

  /** Resyncs every row of this machine (chunked). Joins a run in progress (and runs once more after it). */
  resync(): Promise<void> {
    if (this.syncing) { this.syncAgain = true; return this.syncing; }
    this.syncing = (async () => {
      try {
        do { this.syncAgain = false; await this.syncOnce(); } while (this.syncAgain && this.readable());
      } finally { this.syncing = null; }
    })();
    return this.syncing;
  }

  /** Flushes the outbox in order. Joins a run in progress (and runs once more after it). */
  flush(): Promise<void> {
    if (this.flushing) { this.flushAgain = true; return this.flushing; }
    this.flushing = (async () => {
      try {
        do { this.flushAgain = false; await this.flushOnce(); } while (this.flushAgain && this.readable());
      } finally { this.flushing = null; }
    })();
    return this.flushing;
  }

  // --- internals -----------------------------------------------------------------------------

  private readable(): boolean { return !this.closed && this.connected && this.bridge.connected; }

  /** DO handoffs plus this machine's newer ones not yet delivered, newest first. */
  private withLocal(lead: string, remote: LeadHandoff[], count: number): LeadHandoff[] {
    if (count === 0) return remote;
    const bySeq = new Map<number, LeadHandoff>();
    for (const h of this.files.newest(lead, count)) bySeq.set(h.seq, h);
    for (const h of remote) bySeq.set(h.seq, h);
    return [...bySeq.values()].sort((a, b) => b.seq - a.seq).slice(0, count);
  }

  protected override stored(handoff: LeadHandoff): void {
    this.outbox.push(handoff);
    this.boundOutbox();
    this.saveOutbox();
    if (this.readable()) void this.flush();
  }

  private sendUpsert(row: LeadRecord): void {
    this.upsertSentAt.set(row.lead, Date.now());
    // Disconnected: the next hello's resync carries it.
    if (!this.readable()) return;
    this.bridge.leadRpc('lead.upsert', { record: row }).then(() => this.rowDelivered([row.lead]), (error) => {
      const code = failureCode(error);
      if (!TRANSIENT.has(code)) this.logger(`foreman: the relay refused a Lead row (${code}); not retried`);
      // Transient: the next resync carries the row.
    });
  }

  private async syncOnce(): Promise<void> {
    if (!this.readable()) return;
    const records = this.records();
    for (const chunk of chunkSyncRecords(records)) {
      if (!this.readable()) return;
      try {
        await this.bridge.leadRpc('lead.sync', { records: chunk });
        this.rowDelivered(chunk.map((r) => r.lead));
      } catch (error) {
        const code = failureCode(error);
        if (TRANSIENT.has(code)) return; // retried on the next hello or tick
        this.logger(`foreman: the relay refused a Lead resync chunk of ${chunk.length} row${chunk.length === 1 ? '' : 's'} (${code}); not retried`);
      }
    }
  }

  /**
   * Rows now in the DO: flush once (coalesced with a pass in progress) when one of these Leads has
   * handoffs held `not_found`, or queued while a pass is running (its answer may still be in flight).
   */
  private rowDelivered(leads: readonly string[]): void {
    if (!this.readable()) return;
    let due = false;
    for (const lead of leads) {
      if (this.awaitingRow.delete(lead)) due = true;
      else if (this.flushing && this.outbox.some((h) => h.lead === lead)) due = true;
    }
    if (due) void this.flush();
  }

  private queued(handoff: LeadHandoff): boolean {
    return this.outbox.some((h) => h.lead === handoff.lead && h.seq === handoff.seq);
  }

  private async flushOnce(): Promise<void> {
    const held = new Set<string>();
    // A snapshot, in order: `boundOutbox()` may drop entries at the front of the live outbox while
    // an RPC is in flight, so walking it by index could skip one. Dropped entries are skipped here;
    // entries appended during the pass are picked up by the next pass (`stored` → `flush`).
    for (const handoff of [...this.outbox]) {
      if (!this.readable()) return;
      if (held.has(handoff.lead) || !this.queued(handoff)) continue;
      try {
        await this.bridge.leadRpc('lead.handoff', { handoff });
        // `stored: false` is a duplicate (lead, seq): the DO already has it, so it is delivered too.
        this.remove(handoff);
        this.awaitingRow.delete(handoff.lead);
      } catch (error) {
        const code = failureCode(error);
        if (TRANSIENT.has(code)) return; // kept at the head: retried on the next hello or tick
        if (code === 'not_found') {
          const age = this.now().getTime() - Date.parse(handoff.at);
          if (age > LEAD_OUTBOX_MAX_AGE_MS) {
            this.remove(handoff);
            this.logger(`foreman: handoff ${handoff.seq} of ${handoff.lead} waited over 24 h for its Lead row to reach the relay; dropped from the outbox, kept in the local log`);
            continue;
          }
          // The Lead's row has not reached the DO yet: hold this Lead's handoffs (in order) until it does.
          held.add(handoff.lead); this.awaitingRow.add(handoff.lead); continue;
        }
        this.remove(handoff);
        this.logger(`foreman: the relay refused handoff ${handoff.seq} of ${handoff.lead} (${code}); dropped from the outbox, kept in the local log`);
      }
    }
  }

  private remove(handoff: LeadHandoff): void {
    const at = this.outbox.findIndex((h) => h.lead === handoff.lead && h.seq === handoff.seq);
    if (at < 0) return;
    this.outbox.splice(at, 1);
    this.saveOutbox();
  }

  private boundOutbox(): void {
    const counts = new Map<string, number>();
    for (const h of this.outbox) counts.set(h.lead, (counts.get(h.lead) ?? 0) + 1);
    let dropped = 0;
    this.outbox = this.outbox.filter((h) => {
      const n = counts.get(h.lead)!;
      if (n > MAX_OUTBOX_PER_LEAD) { counts.set(h.lead, n - 1); dropped++; return false; }
      return true;
    });
    if (this.outbox.length > MAX_OUTBOX_TOTAL) { dropped += this.outbox.length - MAX_OUTBOX_TOTAL; this.outbox.splice(0, this.outbox.length - MAX_OUTBOX_TOTAL); }
    if (dropped) this.logger(`foreman: dropped the ${dropped} oldest undelivered handoff${dropped === 1 ? '' : 's'} from the outbox (kept in the local logs)`);
  }

  private readOutbox(): LeadHandoff[] {
    if (!existsSync(this.outboxFile)) return [];
    try {
      const stat = lstatSync(this.outboxFile);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('not a file');
      const raw = JSON.parse(readFileSync(this.outboxFile, 'utf8'));
      if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.handoffs)) throw new Error('shape');
      const out: LeadHandoff[] = [];
      for (const item of raw.handoffs) {
        const parsed = parseLeadHandoff(item);
        if (parsed.ok && !out.some((h) => h.lead === parsed.value.lead && h.seq === parsed.value.seq)) out.push(parsed.value);
      }
      return out;
    } catch {
      this.logger('foreman: leads/outbox.json is invalid; ignoring it (the handoffs stay in the local logs)');
      return [];
    }
  }

  // Best effort: a failed write keeps the in-memory outbox.
  private saveOutbox(): void {
    try {
      if (!this.outbox.length) { rmSync(this.outboxFile, { force: true }); return; }
      this.files.ensureDir();
      atomicWrite(this.outboxFile, JSON.stringify({ version: 1, handoffs: this.outbox }) + '\n');
    } catch {
      this.logger('foreman: could not save leads/outbox.json; undelivered handoffs are kept in memory only');
    }
  }

  private connectionChanged(connected: boolean): void {
    if (this.closed) return;
    this.connected = connected;
    if (this.resyncTimer) { clearInterval(this.resyncTimer); this.resyncTimer = null; }
    if (!connected) return;
    this.resyncTimer = setInterval(() => { void this.tick(); }, this.resyncMs);
    this.resyncTimer.unref?.();
    void this.tick();
  }

  /** On every hello and resync tick: rows first (so the DO knows each Lead), then the outbox. */
  private async tick(): Promise<void> {
    await this.resync();
    await this.flush();
  }
}

/** Relay store when a v2 bridge is configured, else the local-only store. */
export function createLeadStore(options: LeadStoreOptions & { bridge?: LeadBridge | null }): LeadStore {
  if (options.bridge) return new RelayLeadStore(options.bridge, options);
  return new LocalLeadStore(options);
}
