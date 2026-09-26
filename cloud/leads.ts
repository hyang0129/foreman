// Lead registry, Lead handoffs and developer settings inside the HostRelay Durable Object
// (epic #157, story CL-02 / #167; the storage half of #158).
//
// This module owns three SQLite tables (created lazily; HostRelay is already a SQLite-backed class,
// so no wrangler migration) and every storage operation on them. Like cloud/pm-state.ts it knows
// nothing about sockets: the caller (cloud/worker.ts) says which machine sent a frame and whether a
// machine is online.
//
// Invariants kept here:
// - `lead_rpc` is NOT epoch-fenced: any identified (hello v2) machine may use it. A machine may
//   write only Lead rows whose `record.machine_id` is itself, and never a row another machine owns.
// - No op here writes developer settings. `settings.get` is read-only; settings are written only by
//   `writeSetting`, which only the Worker-terminated `POST /api/settings` route calls (after the
//   Firebase bearer, allowed-email and same-origin checks).
// - What is stored is the validated, normalized view from shared/roles.ts (`parseLeadRecord` /
//   `parseLeadHandoff`: `v: 1`, unknown fields dropped, no paths), with `end_reason` passed
//   through `boundedReason` (redacted, ≤ 300 chars) before it is stored.
// - Stored rows are re-validated on read; a row that no longer parses is skipped, never served.

import { utf8Length } from '../shared/notify.ts';
import { boundedReason } from '../shared/pm-state.ts';
import {
  DEV_SETTING_KEYS, MAX_HANDOFFS_KEPT, MAX_LEAD_LIST, MAX_LEAD_ROWS, effectiveDevSettings, leadRpcError, leadRpcOk,
  parseLeadHandoff, parseLeadRecord,
  type DevSettingKey, type DevSettings, type DevSettingsView, type LeadHandoff, type LeadListEntry, type LeadRecord,
  type LeadRpcResult, type TypedLeadRpc,
} from '../shared/roles.ts';

type Row = Record<string, SqlStorageValue>;

/** Verbatim from the CL-02 story (#167); `dev_settings` has no CHECK on `key` (H1: keys are validated in code). */
export const LEAD_DO_SCHEMA: readonly string[] = [
  'CREATE TABLE IF NOT EXISTS leads (lead TEXT PRIMARY KEY, machine_id TEXT NOT NULL, record TEXT NOT NULL, reported_at INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS lead_handoffs (lead TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (lead, seq))',
  'CREATE TABLE IF NOT EXISTS dev_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
];

/** A Lead has ended when its state is `ended`/`dead` or a successor superseded it. */
export function recordEnded(record: LeadRecord): boolean {
  return record.state === 'ended' || record.state === 'dead' || record.superseded_by !== undefined;
}

/**
 * Keeps the longest prefix of `entries` whose JSON array fits in `budget` bytes. Callers order
 * entries non-ended first, newest first, so what is cut is the oldest ended rows.
 */
export function fitEntries<T>(entries: readonly T[], budget: number): T[] {
  const out: T[] = [];
  let used = 2; // "[]"
  for (const entry of entries) {
    const size = utf8Length(JSON.stringify(entry)) + (out.length ? 1 : 0);
    if (used + size > budget) break;
    used += size; out.push(entry);
  }
  return out;
}

/** Thrown inside a write transaction to refuse the whole frame with a lead_rpc error code. */
class Refusal extends Error {
  readonly code: 'forbidden' | 'too_large' | 'not_found';
  constructor(code: 'forbidden' | 'too_large' | 'not_found', message: string) { super(message); this.code = code; }
}

export type SettingWrite =
  | { ok: true; view: DevSettingsView }
  | { ok: false; conflict: true; current: number };

export class LeadState {
  private readonly storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    for (const statement of LEAD_DO_SCHEMA) storage.sql.exec(statement);
  }
  private get sql() { return this.storage.sql; }
  private rows<T extends Row>(query: string, ...bindings: unknown[]): T[] {
    return this.sql.exec<T>(query, ...bindings).toArray();
  }

  // ---- lead_rpc --------------------------------------------------------------------------------

  /**
   * Executes one validated `lead_rpc` from `machineId` (a hello-v2 machine). `resultBudget` is the
   * largest serialized `lead_rpc_result` the caller may send; `lead.list` is trimmed to fit it.
   * Storage errors propagate (the caller answers `unavailable`).
   */
  execute(machineId: string, rpc: TypedLeadRpc, now: number, isOnline: (machineId: string) => boolean, resultBudget: number): LeadRpcResult {
    try {
      switch (rpc.op) {
        case 'lead.upsert':
          this.writeRecords(machineId, [rpc.args.record], now);
          return leadRpcOk(rpc.id, 'lead.upsert', {});
        case 'lead.sync':
          this.writeRecords(machineId, rpc.args.records, now);
          return leadRpcOk(rpc.id, 'lead.sync', {});
        case 'lead.handoff':
          return leadRpcOk(rpc.id, 'lead.handoff', { stored: this.storeHandoff(machineId, rpc.args.handoff) });
        case 'lead.list': {
          const envelope = utf8Length(JSON.stringify(leadRpcOk(rpc.id, 'lead.list', { leads: [] }))) - 2;
          const leads = this.list({ include_ended: rpc.args.include_ended ?? false, limit: rpc.args.limit ?? MAX_LEAD_LIST }, isOnline, resultBudget - envelope);
          return leadRpcOk(rpc.id, 'lead.list', { leads });
        }
        case 'lead.get': {
          const lead = this.entry(rpc.args.lead, isOnline);
          if (!lead) return leadRpcError(rpc.id, 'not_found', 'Unknown Lead');
          return leadRpcOk(rpc.id, 'lead.get', { lead, handoffs: this.handoffs(rpc.args.lead, rpc.args.handoffs ?? 0) });
        }
        case 'settings.get':
          return leadRpcOk(rpc.id, 'settings.get', this.settingsView());
      }
    } catch (error) {
      if (error instanceof Refusal) return leadRpcError(rpc.id, error.code, error.message);
      throw error;
    }
    return leadRpcError((rpc as { id: string }).id, 'invalid', 'unknown op');
  }

  /**
   * Upserts `records` for `machineId`, all or nothing. Every record must name `machineId`, and no
   * existing row may belong to another machine (`forbidden`). New rows beyond MAX_LEAD_ROWS first
   * prune the oldest ended rows (and their handoffs); if that is not enough, `too_large`.
   */
  private writeRecords(machineId: string, records: readonly LeadRecord[], now: number) {
    this.storage.transactionSync(() => {
      const leads = new Set(records.map((r) => r.lead));
      let fresh = 0;
      for (const record of records) {
        if (record.machine_id !== machineId) throw new Refusal('forbidden', 'A machine may write only its own Lead rows');
        const owner = this.rows<{ machine_id: string }>('SELECT machine_id FROM leads WHERE lead = ?', record.lead)[0];
        if (owner && owner.machine_id !== machineId) throw new Refusal('forbidden', 'That Lead belongs to another machine');
        if (!owner) fresh++;
      }
      if (fresh) {
        const count = this.rows<{ n: number }>('SELECT COUNT(*) AS n FROM leads')[0]!.n;
        const excess = count + fresh - MAX_LEAD_ROWS;
        if (excess > 0) {
          const prunable = this.rows<{ lead: string }>('SELECT lead FROM leads WHERE ended = 1 ORDER BY reported_at ASC, lead ASC')
            .filter((row) => !leads.has(row.lead)).slice(0, excess);
          if (prunable.length < excess) throw new Refusal('too_large', `The relay keeps at most ${MAX_LEAD_ROWS} Leads`);
          for (const { lead } of prunable) {
            this.sql.exec('DELETE FROM leads WHERE lead = ?', lead);
            this.sql.exec('DELETE FROM lead_handoffs WHERE lead = ?', lead);
          }
        }
      }
      for (const record of records) {
        const stored: LeadRecord = { ...record };
        if (stored.end_reason !== undefined) stored.end_reason = boundedReason(stored.end_reason);
        this.sql.exec(`INSERT INTO leads (lead, machine_id, record, reported_at, ended) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (lead) DO UPDATE SET machine_id = excluded.machine_id, record = excluded.record, reported_at = excluded.reported_at, ended = excluded.ended`,
        stored.lead, machineId, JSON.stringify(stored), now, recordEnded(stored) ? 1 : 0);
      }
    });
  }

  /**
   * Stores a handoff for a Lead row `machineId` owns. A duplicate `(lead, seq)` returns false, as
   * does a seq older than every one of the MAX_HANDOFFS_KEPT retained (it would be pruned at once:
   * a replay of an already-dropped handoff). Keeps the newest MAX_HANDOFFS_KEPT per Lead.
   */
  private storeHandoff(machineId: string, handoff: LeadHandoff): boolean {
    return this.storage.transactionSync(() => {
      const owner = this.rows<{ machine_id: string }>('SELECT machine_id FROM leads WHERE lead = ?', handoff.lead)[0];
      if (!owner) throw new Refusal('not_found', 'Unknown Lead: upsert its record before its handoffs');
      if (owner.machine_id !== machineId) throw new Refusal('forbidden', 'That Lead belongs to another machine');
      const kept = this.rows<{ n: number; lowest: number | null }>('SELECT COUNT(*) AS n, MIN(seq) AS lowest FROM lead_handoffs WHERE lead = ?', handoff.lead)[0]!;
      if (kept.n >= MAX_HANDOFFS_KEPT && kept.lowest !== null && handoff.seq < kept.lowest) return false;
      const at = Date.parse(handoff.at);
      const inserted = this.sql.exec('INSERT INTO lead_handoffs (lead, seq, at, body) VALUES (?, ?, ?, ?) ON CONFLICT (lead, seq) DO NOTHING RETURNING seq',
        handoff.lead, handoff.seq, Number.isFinite(at) ? at : 0, JSON.stringify(handoff)).toArray().length > 0;
      if (inserted) {
        this.sql.exec('DELETE FROM lead_handoffs WHERE lead = ? AND seq NOT IN (SELECT seq FROM lead_handoffs WHERE lead = ? ORDER BY seq DESC LIMIT ?)',
          handoff.lead, handoff.lead, MAX_HANDOFFS_KEPT);
      }
      return inserted;
    });
  }

  // ---- reads -----------------------------------------------------------------------------------

  private toEntry(row: { record: string; machine_id: string; reported_at: number; ended: number }, isOnline: (machineId: string) => boolean): LeadListEntry | null {
    let raw: unknown;
    try { raw = JSON.parse(row.record); } catch { return null; }
    const parsed = parseLeadRecord(raw);
    if (!parsed.ok || parsed.value.machine_id !== row.machine_id) return null;
    return { ...parsed.value, machine_online: isOnline(row.machine_id), reported_at: row.reported_at, ended: row.ended === 1 };
  }

  /** One Lead row with DO-computed liveness, or null. */
  entry(lead: string, isOnline: (machineId: string) => boolean): LeadListEntry | null {
    const row = this.rows<{ record: string; machine_id: string; reported_at: number; ended: number }>('SELECT record, machine_id, reported_at, ended FROM leads WHERE lead = ?', lead)[0];
    return row ? this.toEntry(row, isOnline) : null;
  }

  /**
   * Lead rows, non-ended first and newest (`reported_at`) first, at most `limit`, trimmed so the
   * JSON array fits in `budget` bytes. `machine_online` is computed now from `isOnline`.
   */
  list(opts: { include_ended: boolean; limit: number }, isOnline: (machineId: string) => boolean, budget: number): LeadListEntry[] {
    const rows = this.rows<{ record: string; machine_id: string; reported_at: number; ended: number }>(
      `SELECT record, machine_id, reported_at, ended FROM leads ${opts.include_ended ? '' : 'WHERE ended = 0 '}ORDER BY ended ASC, reported_at DESC, lead ASC`);
    const entries: LeadListEntry[] = [];
    for (const row of rows) {
      if (entries.length >= opts.limit) break;
      const entry = this.toEntry(row, isOnline);
      if (entry) entries.push(entry);
    }
    return fitEntries(entries, budget);
  }

  /** The newest `count` handoffs of `lead`, newest first. */
  handoffs(lead: string, count: number): LeadHandoff[] {
    if (count <= 0) return [];
    const out: LeadHandoff[] = [];
    for (const row of this.rows<{ body: string }>('SELECT body FROM lead_handoffs WHERE lead = ? ORDER BY seq DESC LIMIT ?', lead, count)) {
      let raw: unknown;
      try { raw = JSON.parse(row.body); } catch { continue; }
      const parsed = parseLeadHandoff(raw);
      if (parsed.ok) out.push(parsed.value);
    }
    return out;
  }

  // ---- developer settings ----------------------------------------------------------------------

  /**
   * The effective settings: defaults for keys never written (grant on for coordinator and lead,
   * `bypass_ask` off), lower privilege for a stored value that no longer validates, per-key
   * versions (0 = never written) and the last write time. Unknown stored keys are ignored.
   */
  settingsView(): DevSettingsView {
    const stored: Partial<Record<DevSettingKey, unknown>> = {};
    const versions = Object.fromEntries(DEV_SETTING_KEYS.map((key) => [key, 0])) as Record<DevSettingKey, number>;
    let updated_at: number | null = null;
    for (const row of this.rows<{ key: string; value: string; version: number; updated_at: number }>('SELECT key, value, version, updated_at FROM dev_settings')) {
      if (!(DEV_SETTING_KEYS as readonly string[]).includes(row.key)) continue;
      const key = row.key as DevSettingKey;
      // A value that is not JSON reads as null, which fails validation → lower privilege.
      try { stored[key] = JSON.parse(row.value); } catch { stored[key] = null; }
      versions[key] = Number.isSafeInteger(row.version) && row.version >= 0 ? row.version : 0;
      if (Number.isSafeInteger(row.updated_at) && row.updated_at >= 0) updated_at = Math.max(updated_at ?? 0, row.updated_at);
    }
    return { settings: effectiveDevSettings(stored), versions, updated_at };
  }

  /**
   * Writes one already-validated setting (only `POST /api/settings` calls this). With `version`,
   * the write happens only when it equals the key's current version (else a conflict).
   */
  writeSetting<K extends DevSettingKey>(key: K, value: DevSettings[K], version: number | undefined, now: number): SettingWrite {
    return this.storage.transactionSync((): SettingWrite => {
      const current = this.rows<{ version: number }>('SELECT version FROM dev_settings WHERE key = ?', key)[0]?.version ?? 0;
      if (version !== undefined && version !== current) return { ok: false, conflict: true, current };
      this.sql.exec(`INSERT INTO dev_settings (key, value, version, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, version = excluded.version, updated_at = excluded.updated_at`,
      key, JSON.stringify(value), current + 1, now);
      return { ok: true, view: this.settingsView() };
    });
  }
}
