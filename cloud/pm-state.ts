// Portable PM state inside the HostRelay Durable Object (epic #26, contract section C).
//
// This module owns the SQLite tables (created lazily, no wrangler migration: HostRelay is already
// a SQLite class) and every storage operation on them. It knows nothing about sockets: the caller
// (cloud/worker.ts) says which machine sent a frame and whether a machine is online.
//
// Invariants kept here:
// - `pm_assignment` is the only authority on which machine is the PM host. Every `pm_rpc` is fenced
//   by its epoch (stale_epoch) and by the sending machine (not_active) before anything is read or
//   written.
// - No PM message text and no provider error text is stored. Turn rows hold ids, timestamps,
//   machine and epoch only; the uncertain reason is one of a fixed set. Error messages sent back to
//   the host go through `pmRpcError` (redacted, bounded) and are never stored.

import {
  MAX_LOG_KEPT, MAX_LOG_READ, MAX_MACHINES, MAX_OPEN_TURNS, PM_DO_SCHEMA, PM_DOC_LIMITS,
  PM_META_MEMORY_INITIALIZED, isMachineName, pmRpcError, pmRpcOk,
  type AssignedBy, type Doc, type LogEntry, type MachineRecord, type MemoryGetResult, type PmAssignmentRecord,
  type PmDocName, type PmHostActive, type PmHostResponse, type PmMemoryInitialized, type PmRpcResult, type TypedPmRpc,
  type UncertainReason, type UncertainTurn,
} from '../shared/pm-state.ts';
import { utf8Length } from '../shared/notify.ts';

type Row = Record<string, SqlStorageValue>;
const iso = (ms: number) => new Date(ms).toISOString();
const UNKNOWN_MACHINE_NAME = 'unknown machine';
/**
 * #116: at most this many `uncertain` rows are kept. Rows become uncertain only on reassignment or
 * a restart reconciliation (each marks at most MAX_OPEN_TURNS open rows); beyond the cap the oldest
 * (by accepted_at, then turn_id) are dropped, so a host that never acknowledges cannot grow the table.
 */
export const MAX_UNCERTAIN_TURNS = 256;

export class PmState {
  private readonly storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    for (const statement of PM_DO_SCHEMA) storage.sql.exec(statement);
  }
  private get sql() { return this.storage.sql; }
  private rows<T extends Row>(query: string, ...bindings: unknown[]): T[] {
    return this.sql.exec<T>(query, ...bindings).toArray();
  }

  // ---- machines and assignment -----------------------------------------------------------------

  assignment(): PmAssignmentRecord | null {
    return this.rows<PmAssignmentRecord & Row>('SELECT singleton, machine_id, epoch, assigned_at, assigned_by FROM pm_assignment WHERE singleton = 1')[0] ?? null;
  }
  machine(machineId: string): MachineRecord | null {
    return this.rows<MachineRecord & Row>('SELECT machine_id, name, platform, first_seen, last_seen FROM machines WHERE machine_id = ?', machineId)[0] ?? null;
  }
  machines(): MachineRecord[] {
    return this.rows<MachineRecord & Row>('SELECT machine_id, name, platform, first_seen, last_seen FROM machines ORDER BY first_seen, machine_id');
  }
  machineName(machineId: string): string {
    const name = this.machine(machineId)?.name;
    return name && isMachineName(name) ? name : UNKNOWN_MACHINE_NAME;
  }

  /**
   * Records a v2 hello's machine. A new machine beyond MAX_MACHINES evicts the least recently seen
   * machine that is neither the active PM host nor online; if every slot is taken by such a
   * machine, the hello is refused (false).
   */
  upsertMachine(machineId: string, name: string, platform: string, now: number, isOnline: (id: string) => boolean): boolean {
    return this.storage.transactionSync(() => {
      if (!this.machine(machineId)) {
        const active = this.assignment()?.machine_id;
        const others = this.machines();
        if (others.length >= MAX_MACHINES) {
          const evictable = others.filter((m) => m.machine_id !== active && !isOnline(m.machine_id)).sort((a, b) => a.last_seen - b.last_seen);
          const excess = others.length - MAX_MACHINES + 1;
          if (evictable.length < excess) return false;
          for (const m of evictable.slice(0, excess)) this.sql.exec('DELETE FROM machines WHERE machine_id = ?', m.machine_id);
        }
      }
      this.sql.exec(`INSERT INTO machines (machine_id, name, platform, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (machine_id) DO UPDATE SET name = excluded.name, platform = excluded.platform, last_seen = excluded.last_seen`,
      machineId, name, platform, now, now);
      return true;
    });
  }
  touch(machineId: string, now: number) {
    this.sql.exec('UPDATE machines SET last_seen = ? WHERE machine_id = ?', now, machineId);
  }

  /** No assignment yet: the first protocol-v2 machine becomes the PM host at epoch 1. */
  bootstrapIfUnassigned(machineId: string, now: number): boolean {
    if (this.assignment()) return false;
    this.sql.exec("INSERT INTO pm_assignment (singleton, machine_id, epoch, assigned_at, assigned_by) VALUES (1, ?, 1, ?, 'bootstrap')", machineId, now);
    return true;
  }

  /**
   * The developer's reassignment (the only way to change the PM host after bootstrap). Every
   * `open` turn becomes `uncertain`: `host_lost` if its machine is offline now, else `reassigned`.
   * The caller has already checked the target, the epoch and online state.
   */
  reassign(target: string, now: number, isOnline: (id: string) => boolean): PmAssignmentRecord {
    return this.storage.transactionSync(() => {
      const epoch = (this.assignment()?.epoch ?? 0) + 1;
      for (const turn of this.rows<{ turn_id: string; machine_id: string }>("SELECT turn_id, machine_id FROM pm_turns WHERE state = 'open'")) {
        const reason: UncertainReason = isOnline(turn.machine_id) ? 'reassigned' : 'host_lost';
        this.sql.exec("UPDATE pm_turns SET state = 'uncertain', reason = ? WHERE turn_id = ?", reason, turn.turn_id);
      }
      this.sql.exec(`INSERT INTO pm_assignment (singleton, machine_id, epoch, assigned_at, assigned_by) VALUES (1, ?, ?, ?, 'developer')
        ON CONFLICT (singleton) DO UPDATE SET machine_id = excluded.machine_id, epoch = excluded.epoch, assigned_at = excluded.assigned_at, assigned_by = excluded.assigned_by`,
      target, epoch, now);
      this.capUncertain();
      return this.assignment()!;
    });
  }

  /**
   * A v2 hello from the active machine: its `open` turns that its PM no longer holds (absent from
   * `pm_open_turns`) were lost to a host restart. Returns how many were marked.
   */
  reconcileRestart(machineId: string, openTurns: readonly string[]): number {
    const held = new Set(openTurns);
    let marked = 0;
    this.storage.transactionSync(() => {
      for (const turn of this.rows<{ turn_id: string }>("SELECT turn_id FROM pm_turns WHERE state = 'open' AND machine_id = ?", machineId)) {
        if (held.has(turn.turn_id)) continue;
        this.sql.exec("UPDATE pm_turns SET state = 'uncertain', reason = 'restarted' WHERE turn_id = ?", turn.turn_id);
        marked++;
      }
      if (marked) this.capUncertain();
    });
    return marked;
  }

  /** Drops the oldest uncertain rows beyond MAX_UNCERTAIN_TURNS (deterministic order). Returns how many. */
  private capUncertain(): number {
    return this.sql.exec(`DELETE FROM pm_turns WHERE state = 'uncertain' AND turn_id NOT IN
      (SELECT turn_id FROM pm_turns WHERE state = 'uncertain' ORDER BY accepted_at DESC, turn_id DESC LIMIT ?)`, MAX_UNCERTAIN_TURNS).rowsWritten;
  }

  /** Oldest first, at most MAX_OPEN_TURNS (the frame bound); the rest follow once these are acked. */
  uncertainTurns(): UncertainTurn[] {
    return this.rows<{ turn_id: string; machine_id: string; accepted_at: number; reason: UncertainReason }>(
      "SELECT turn_id, machine_id, accepted_at, reason FROM pm_turns WHERE state = 'uncertain' ORDER BY accepted_at, turn_id LIMIT ?", MAX_OPEN_TURNS,
    ).map((row) => ({ turn_id: row.turn_id, accepted_at: iso(row.accepted_at), host: this.machineName(row.machine_id), reason: row.reason }));
  }
  turnCounts(): { open: number; uncertain: number } {
    const counts = { open: 0, uncertain: 0 };
    for (const row of this.rows<{ state: 'open' | 'uncertain'; count: number }>('SELECT state, COUNT(*) AS count FROM pm_turns GROUP BY state')) counts[row.state] = row.count;
    return counts;
  }

  hostActive(isOnline: (id: string) => boolean): PmHostActive | null {
    const assignment = this.assignment();
    if (!assignment) return null;
    return {
      machine_id: assignment.machine_id, name: this.machineName(assignment.machine_id), online: isOnline(assignment.machine_id),
      epoch: assignment.epoch, assigned_at: assignment.assigned_at, assigned_by: assignment.assigned_by as AssignedBy,
    };
  }
  hostResponse(isOnline: (id: string) => boolean): PmHostResponse {
    const active = this.hostActive(isOnline);
    const counts = this.turnCounts();
    return {
      active,
      machines: this.machines().map((m) => ({ machine_id: m.machine_id, name: m.name, platform: m.platform, online: isOnline(m.machine_id), last_seen: m.last_seen, active: m.machine_id === active?.machine_id })),
      open_turns: counts.open, uncertain_turns: counts.uncertain, mode: 'relay',
    };
  }

  // ---- memory ----------------------------------------------------------------------------------

  private doc(name: PmDocName): Doc {
    const row = this.rows<{ content: string; version: number; updated_at: number }>('SELECT content, version, updated_at FROM pm_docs WHERE name = ?', name)[0];
    return row ? { content: row.content, version: row.version, updated_at: iso(row.updated_at) } : { content: '', version: 0, updated_at: '' };
  }
  private writeDoc(name: PmDocName, content: string, version: number, now: number, epoch: number) {
    this.sql.exec(`INSERT INTO pm_docs (name, content, version, updated_at, updated_epoch) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET content = excluded.content, version = excluded.version, updated_at = excluded.updated_at, updated_epoch = excluded.updated_epoch`,
    name, content, version, now, epoch);
  }
  initialized(): boolean {
    return this.rows('SELECT 1 FROM pm_meta WHERE key = ?', PM_META_MEMORY_INITIALIZED).length > 0;
  }
  private markInitialized(now: number, sourceMachine: string, imported: boolean) {
    const value: PmMemoryInitialized = { at: iso(now), source_machine: sourceMachine, imported };
    this.sql.exec('INSERT INTO pm_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', PM_META_MEMORY_INITIALIZED, JSON.stringify(value));
  }
  private appendLog(text: string, now: number, epoch: number): number {
    const seq = this.sql.exec<{ seq: number }>('INSERT INTO pm_log (at, text, epoch) VALUES (?, ?, ?) RETURNING seq', now, text, epoch).one().seq;
    return seq;
  }
  private trimLog() {
    this.sql.exec('DELETE FROM pm_log WHERE seq NOT IN (SELECT seq FROM pm_log ORDER BY seq DESC LIMIT ?)', MAX_LOG_KEPT);
  }
  private model(): string | null {
    return this.rows<{ value: string | null }>("SELECT value FROM pm_settings WHERE key = 'model'")[0]?.value ?? null;
  }
  private setModel(model: string | null, now: number) {
    this.sql.exec("INSERT INTO pm_settings (key, value, updated_at) VALUES ('model', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", model, now);
  }
  memory(): MemoryGetResult {
    const log: LogEntry[] = this.rows<{ seq: number; at: number; text: string }>('SELECT seq, at, text FROM pm_log ORDER BY seq DESC LIMIT ?', MAX_LOG_READ)
      .reverse().map((row) => ({ seq: row.seq, at: iso(row.at), text: row.text }));
    return { initialized: this.initialized(), docs: { projects: this.doc('projects'), preferences: this.doc('preferences') }, log, settings: { model: this.model() } };
  }

  // ---- pm_rpc ----------------------------------------------------------------------------------

  /**
   * Executes one validated `pm_rpc` from `machineId`. Fencing comes first: an epoch other than the
   * current one is `stale_epoch` (so a machine moved away from gets `stale_epoch` for every later
   * write), and the current epoch from a machine that is not the PM host is `not_active`. A
   * rejected op reads and writes nothing.
   */
  execute(machineId: string, rpc: TypedPmRpc, now: number): PmRpcResult {
    const assignment = this.assignment();
    if (!assignment) return pmRpcError(rpc.id, 'not_active', 'No machine is the PM host yet');
    if (rpc.epoch !== assignment.epoch) return pmRpcError(rpc.id, 'stale_epoch', `Epoch ${rpc.epoch} is stale; the current PM epoch is ${assignment.epoch}`);
    if (assignment.machine_id !== machineId) return pmRpcError(rpc.id, 'not_active', `This machine is not the PM host; the PM runs on ${this.machineName(assignment.machine_id)}`);
    const epoch = assignment.epoch;
    return this.storage.transactionSync((): PmRpcResult => {
      switch (rpc.op) {
        case 'memory.get':
          return pmRpcOk(rpc.id, rpc.op, this.memory());
        case 'memory.put': {
          const { doc, content, expected_version } = rpc.args;
          const current = this.doc(doc);
          if (current.version !== expected_version) return pmRpcError(rpc.id, 'version_conflict', `${doc} is at version ${current.version}, not ${expected_version}`);
          this.writeDoc(doc, content, current.version + 1, now, epoch);
          this.markInitialized(now, machineId, false);
          return pmRpcOk(rpc.id, rpc.op, { version: current.version + 1 });
        }
        case 'memory.edit': {
          const { doc, old_text, new_text, expected_version } = rpc.args;
          const current = this.doc(doc);
          if (current.version !== expected_version) return pmRpcError(rpc.id, 'version_conflict', `${doc} is at version ${current.version}, not ${expected_version}`);
          const at = current.content.indexOf(old_text);
          if (at < 0) return pmRpcError(rpc.id, 'invalid', `old_text does not occur in ${doc}`);
          if (current.content.indexOf(old_text, at + 1) >= 0) return pmRpcError(rpc.id, 'invalid', `old_text occurs more than once in ${doc}`);
          const content = current.content.slice(0, at) + new_text + current.content.slice(at + old_text.length);
          if (utf8Length(content) > PM_DOC_LIMITS[doc]) return pmRpcError(rpc.id, 'too_large', `${doc} would exceed ${PM_DOC_LIMITS[doc]} bytes`);
          this.writeDoc(doc, content, current.version + 1, now, epoch);
          this.markInitialized(now, machineId, false);
          return pmRpcOk(rpc.id, rpc.op, { version: current.version + 1 });
        }
        case 'memory.log': {
          const seq = this.appendLog(rpc.args.text, now, epoch);
          this.trimLog();
          this.markInitialized(now, machineId, false);
          return pmRpcOk(rpc.id, rpc.op, { seq });
        }
        case 'memory.import': {
          const { projects, log, model, source_machine } = rpc.args;
          if (this.initialized()) return pmRpcError(rpc.id, 'already_initialized', 'PM memory is already initialized; nothing was imported');
          if (source_machine !== machineId) return pmRpcError(rpc.id, 'invalid', 'source_machine must be the importing machine');
          if (projects) this.writeDoc('projects', projects, this.doc('projects').version + 1, now, epoch);
          for (const line of log) this.appendLog(line, now, epoch);
          this.trimLog();
          if (model !== null) this.setModel(model, now);
          this.markInitialized(now, machineId, true);
          return pmRpcOk(rpc.id, rpc.op, { imported: true });
        }
        case 'settings.put':
          this.setModel(rpc.args.model, now);
          return pmRpcOk(rpc.id, rpc.op, {});
        case 'turn.begin': {
          const { turn_id, accepted_at } = rpc.args;
          const existing = this.rows<{ machine_id: string; state: string }>('SELECT machine_id, state FROM pm_turns WHERE turn_id = ?', turn_id)[0];
          // A retried begin for the same still-open turn is acknowledged again.
          if (existing) {
            return existing.state === 'open' && existing.machine_id === machineId
              ? pmRpcOk(rpc.id, rpc.op, {})
              : pmRpcError(rpc.id, 'invalid', 'turn_id is already recorded');
          }
          if (this.turnCounts().open >= MAX_OPEN_TURNS) return pmRpcError(rpc.id, 'unavailable', `At most ${MAX_OPEN_TURNS} PM turns can be open`);
          this.sql.exec("INSERT INTO pm_turns (turn_id, machine_id, epoch, accepted_at, state, reason) VALUES (?, ?, ?, ?, 'open', NULL)", turn_id, machineId, epoch, Date.parse(accepted_at));
          return pmRpcOk(rpc.id, rpc.op, {});
        }
        case 'turn.end':
          // Only the open row: an uncertain row stays until the active host acknowledges it.
          this.sql.exec("DELETE FROM pm_turns WHERE turn_id = ? AND state = 'open'", rpc.args.turn_id);
          return pmRpcOk(rpc.id, rpc.op, {});
        case 'turn.ack_uncertain':
          for (const turnId of rpc.args.turn_ids) this.sql.exec("DELETE FROM pm_turns WHERE turn_id = ? AND state = 'uncertain'", turnId);
          return pmRpcOk(rpc.id, rpc.op, {});
      }
    });
  }
}

