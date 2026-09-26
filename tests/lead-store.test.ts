// Pin FOREMAN_HOME to a temp dir before any server module loads (story #121 guard).
import './fixtures/temp-foreman-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostBridge, LeadRpcError } from '../server/host-bridge.ts';
import {
  LEAD_RESYNC_INTERVAL_MS, LEAD_UPSERT_DEBOUNCE_MS, LeadStoreError, LocalLeadStore, RelayLeadStore, chunkSyncRecords, createLeadStore,
} from '../server/lead-store.ts';
import { utf8Length } from '../shared/notify.ts';
import {
  MAX_LEAD_FRAME, MAX_SYNC_RECORDS, defaultDevSettings, leadRpcError, leadRpcOk, parseLeadRpc,
  type DevSettingsView, type LeadHandoff, type LeadListEntry, type LeadOp, type LeadRecord,
} from '../shared/roles.ts';

const TOKEN = 'synthetic-test-host-credential'.repeat(2);
const MACHINE = { machine_id: '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', name: 'machine-a' };
const OTHER_MACHINE = 'a9b8c7d6-1234-4abc-8def-0123456789ab';
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
const newLead = () => `fm:${randomUUID()}`;

function home(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-lead-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function input(lead: string, over: Record<string, unknown> = {}) {
  return { lead, kind: 'checkpoint' as const, project: 'foreman', workstream: 'lead-store', goal: 'Ship the Lead store', status: 'in_progress' as const,
    summary: 'Working on it', decisions: ['keep an outbox'], open_questions: [], next_steps: ['write tests'], links: [{ label: 'issue', url: 'https://github.com/hyang0129/foreman/issues/168' }], ...over };
}

function record(lead: string, over: Partial<LeadRecord> = {}): LeadRecord {
  return { v: 1, lead, machine_id: MACHINE.machine_id, machine_name: MACHINE.name, name: 'lead-store', project: 'foreman', workstream: 'lead-store',
    goal: 'Ship the Lead store', model: 'opus[1m]', effort: 'medium', permission_mode: 'bypass', launched_by: 'coordinator', state: 'working', alive: true,
    created_at: 1_000, updated_at: 2_000, pending_approvals: 0, workers: [], ...over };
}

const view = (allow = true): DevSettingsView => ({
  settings: { ...defaultDevSettings(), bypass_grants: [{ role: 'lead', project: '*', allow }] },
  versions: { roles: 0, bypass_grants: allow ? 1 : 2, bypass_ask: 0 }, updated_at: 5_000,
});

type Responder = (op: LeadOp, args: any) => any;

/**
 * A fake bridge: every call is checked against the shared frame contract (as the real bridge and
 * the DO would), recorded, and answered by `respond` (a thrown LeadRpcError is the DO's error).
 */
class FakeBridge {
  connected = false;
  calls: { op: LeadOp; args: any; timeoutMs?: number }[] = [];
  listeners = new Set<(connected: boolean) => void>();
  handoffs = new Map<string, LeadHandoff>();
  rows = new Map<string, LeadRecord>();
  respond: Responder = (op, args) => this.fakeDo(op, args);
  onConnection(listener: (connected: boolean) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  setConnected(value: boolean) { this.connected = value; for (const l of [...this.listeners]) l(value); }
  leadRpc(op: LeadOp, args: any, options: { timeoutMs?: number } = {}): Promise<any> {
    if (!this.connected) return Promise.reject(new LeadRpcError('disconnected', op, 'The cloud relay is not connected.'));
    const frame = { type: 'lead_rpc', id: 'lead-test-1', op, args };
    const parsed = parseLeadRpc(frame);
    assert.ok(parsed.ok, `frame must satisfy the contract: ${!parsed.ok && parsed.error}`);
    assert.ok(utf8Length(JSON.stringify(frame)) <= MAX_LEAD_FRAME);
    this.calls.push({ op, args: structuredClone(args), timeoutMs: options.timeoutMs });
    return Promise.resolve().then(() => this.respond(op, args));
  }
  ops(op?: LeadOp) { return this.calls.filter((c) => !op || c.op === op); }
  fakeDo(op: LeadOp, args: any): any {
    switch (op) {
      case 'lead.upsert': this.rows.set(args.record.lead, args.record); return {};
      case 'lead.sync': for (const r of args.records) this.rows.set(r.lead, r); return {};
      case 'lead.handoff': {
        const key = `${args.handoff.lead}#${args.handoff.seq}`;
        if (this.handoffs.has(key)) return { stored: false };
        this.handoffs.set(key, args.handoff); return { stored: true };
      }
      case 'lead.list': return { leads: [...this.rows.values()].map((r) => this.entry(r)) };
      case 'lead.get': {
        const row = this.rows.get(args.lead);
        if (!row) throw new LeadRpcError('not_found', op, 'unknown Lead');
        const hs = [...this.handoffs.values()].filter((h) => h.lead === args.lead).sort((a, b) => b.seq - a.seq).slice(0, args.handoffs ?? 0);
        return { lead: this.entry(row), handoffs: hs };
      }
      case 'settings.get': return view();
    }
  }
  entry(r: LeadRecord): LeadListEntry { return { ...r, machine_online: true, reported_at: 9_000, ended: false }; }
}

function relay(t: test.TestContext, options: { home?: string; bridge?: FakeBridge; workersOf?: any; logs?: string[] } = {}) {
  const bridge = options.bridge ?? new FakeBridge();
  const logs = options.logs ?? [];
  const store = new RelayLeadStore(bridge as any, { identity: MACHINE, home: options.home ?? home(t), log: (line) => logs.push(line), workersOf: options.workersOf });
  t.after(() => store.close());
  return { bridge, store, logs };
}

// ---------------------------------------------------------------------------------------------
// Local files
// ---------------------------------------------------------------------------------------------

test('seq is per Lead, monotonic, and survives a restart (a new store on the same home)', async (t) => {
  const dir = home(t);
  const a = newLead(), b = newLead();
  const first = new LocalLeadStore({ identity: MACHINE, home: dir, log: () => {} });
  assert.equal((await first.appendHandoff(input(a))).seq, 1);
  assert.equal((await first.appendHandoff(input(a))).seq, 2);
  assert.equal((await first.appendHandoff(input(b))).seq, 1, 'each Lead has its own sequence');
  first.close();
  // A crash left a torn last line: it is skipped for seq and never joined with the next line.
  appendFileSync(join(dir, 'leads', `${a.slice(3)}.jsonl`), '{"v":1,"lead":"torn');
  const second = relay(t, { home: dir }).store;
  const third = await second.appendHandoff(input(a));
  assert.equal(third.seq, 3);
  const lines = readFileSync(join(dir, 'leads', `${a.slice(3)}.jsonl`), 'utf8').trim().split('\n');
  assert.deepEqual(lines.map((line) => { try { return JSON.parse(line).seq; } catch { return 'torn'; } }), [1, 2, 'torn', 3]);
  const fourth = await second.appendHandoff(input(a.toUpperCase().replace('FM:', 'fm:')));
  assert.equal(fourth.seq, 4, 'an upper-case key is the same Lead');
  assert.equal(fourth.lead, a);
});

test('the handoff log and the outbox are written 0600 in a 0700 directory; the handoff is host-completed', async (t) => {
  const dir = home(t);
  const lead = newLead();
  const { store } = relay(t, { home: dir, workersOf: (l: string) => [
    { session_key: 'fm:worker-1', name: `worker for ${l.slice(0, 5)}`, state: 'working' },
    { session_key: 'bad key with spaces', name: 'x', state: 'working' },
  ] });
  const before = Date.now();
  const stored = await store.appendHandoff({ ...input(lead), workers: [{ session_key: 'fm:model-made', name: 'fake', state: 'idle' }], seq: 99, v: 7 } as any);
  assert.equal(stored.v, 1); assert.equal(stored.seq, 1);
  assert.ok(Date.parse(stored.at) >= before - 1000);
  assert.deepEqual(stored.workers, [{ session_key: 'fm:worker-1', name: `worker for ${lead.slice(0, 5)}`, state: 'working' }], 'workers come from the provider (per Lead), invalid ones are dropped');
  const leads = join(dir, 'leads');
  assert.equal(statSync(leads).mode & 0o777, 0o700);
  assert.equal(statSync(join(leads, `${lead.slice(3)}.jsonl`)).mode & 0o777, 0o600);
  assert.equal(statSync(join(leads, 'outbox.json')).mode & 0o777, 0o600);
  const outbox = JSON.parse(readFileSync(join(leads, 'outbox.json'), 'utf8'));
  assert.equal(outbox.version, 1);
  assert.deepEqual(outbox.handoffs, [stored]);
});

test('appendHandoff rejects invalid or oversized handoffs and writes nothing', async (t) => {
  const dir = home(t);
  const { store } = relay(t, { home: dir });
  const lead = newLead();
  await assert.rejects(store.appendHandoff(input('fm:not-a-uuid')), (e: any) => e instanceof LeadStoreError && e.code === 'invalid');
  await assert.rejects(store.appendHandoff(input(lead, { project: '/Users/hong/code/foreman' })), (e: any) => e.code === 'invalid');
  await assert.rejects(store.appendHandoff(input(lead, { decisions: Array.from({ length: 30 }, () => '🙂'.repeat(250)), open_questions: Array.from({ length: 20 }, () => '🙂'.repeat(250)) })), (e: any) => e.code === 'too_large');
  assert.equal(existsSync(join(dir, 'leads', `${lead.slice(3)}.jsonl`)), false);
  assert.equal(existsSync(join(dir, 'leads', 'outbox.json')), false);
  assert.equal((await store.appendHandoff(input(lead))).seq, 1, 'a rejected handoff consumes no seq');
});

// ---------------------------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------------------------

test('appendHandoff resolves after the local write, before any DO ack', async (t) => {
  const { bridge, store } = relay(t);
  bridge.setConnected(true); await settle();
  let release!: () => void;
  bridge.respond = (op, args) => op === 'lead.handoff' ? new Promise((resolve) => { release = () => resolve({ stored: true }); }) : bridge.fakeDo(op, args);
  const stored = await store.appendHandoff(input(newLead()));
  assert.equal(bridge.ops('lead.handoff').length, 1, 'sent at once while connected');
  assert.deepEqual(store.pendingHandoffs(), [stored], 'still queued: the DO has not answered');
  release(); await settle();
  assert.deepEqual(store.pendingHandoffs(), []);
});

test('offline: handoffs queue, survive a restart, and flush in order on reconnect, after the rows', async (t) => {
  const dir = home(t);
  const a = newLead(), b = newLead();
  const bridge = new FakeBridge();
  const first = relay(t, { home: dir, bridge }).store;
  await first.appendHandoff(input(a));
  await first.appendHandoff(input(b));
  await first.appendHandoff(input(a, { kind: 'final', status: 'done' }));
  assert.equal(bridge.calls.length, 0, 'nothing is sent while disconnected');
  first.close();
  const { store } = relay(t, { home: dir, bridge });
  store.track(() => [record(a), record(b)]);
  assert.deepEqual(store.pendingHandoffs().map((h) => [h.lead, h.seq]), [[a, 1], [b, 1], [a, 2]], 'the outbox is read back after a restart');
  bridge.setConnected(true); await settle();
  assert.deepEqual(bridge.calls.map((c) => c.op), ['lead.sync', 'lead.handoff', 'lead.handoff', 'lead.handoff'], 'rows first, then the outbox');
  assert.deepEqual(bridge.ops('lead.handoff').map((c) => [c.args.handoff.lead, c.args.handoff.seq]), [[a, 1], [b, 1], [a, 2]]);
  assert.deepEqual(store.pendingHandoffs(), []);
  assert.equal(existsSync(join(dir, 'leads', 'outbox.json')), false, 'an empty outbox leaves no file');
});

test('a duplicate answer (stored: false) counts as delivered', async (t) => {
  const { bridge, store } = relay(t);
  const lead = newLead();
  bridge.setConnected(true); await settle();
  bridge.respond = (op, args) => op === 'lead.handoff' ? { stored: false } : bridge.fakeDo(op, args);
  await store.appendHandoff(input(lead)); await settle();
  assert.equal(bridge.ops('lead.handoff').length, 1);
  assert.deepEqual(store.pendingHandoffs(), []);
});

test('a transient failure keeps the entry for the next hello or tick; forbidden/invalid drop it once, logged', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const { bridge, store, logs } = relay(t);
  const a = newLead(), b = newLead();
  let mode: 'timeout' | 'ok' = 'timeout';
  bridge.respond = (op, args) => {
    if (op !== 'lead.handoff') return bridge.fakeDo(op, args);
    if (args.handoff.lead === b) throw new LeadRpcError('forbidden', op, 'not your Lead');
    if (mode === 'timeout') throw new LeadRpcError('timeout', op, 'no answer');
    return bridge.fakeDo(op, args);
  };
  bridge.setConnected(true); await settle();
  await store.appendHandoff(input(a)); await settle();
  await store.appendHandoff(input(a)); await settle();
  // Each timeout stops the pass: the head is kept, nothing behind it is skipped past.
  assert.deepEqual(bridge.ops('lead.handoff').map((c) => c.args.handoff.seq), [1, 1]);
  assert.equal(store.pendingHandoffs().length, 2);
  mode = 'ok';
  await store.appendHandoff(input(b)); await settle();
  assert.deepEqual(store.pendingHandoffs().map((h) => [h.lead, h.seq]), [], 'a flushed; b refused and dropped');
  assert.deepEqual(bridge.ops('lead.handoff').slice(2).map((c) => [c.args.handoff.lead, c.args.handoff.seq]), [[a, 1], [a, 2], [b, 1]]);
  assert.ok(logs.some((line) => /refused handoff 1 of fm:.* \(forbidden\); dropped/.test(line)));
  // Never retried: later ticks send no more handoffs.
  const sent = bridge.ops('lead.handoff').length;
  t.mock.timers.tick(LEAD_RESYNC_INTERVAL_MS * 2); await settle();
  assert.equal(bridge.ops('lead.handoff').length, sent);
});

test('the next resync tick retries a transiently failed handoff without a reconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const { bridge, store } = relay(t);
  let fail = true;
  bridge.respond = (op, args) => { if (op === 'lead.handoff' && fail) throw new LeadRpcError('unavailable', op, 'busy'); return bridge.fakeDo(op, args); };
  bridge.setConnected(true); await settle();
  await store.appendHandoff(input(newLead())); await settle();
  assert.equal(store.pendingHandoffs().length, 1);
  fail = false;
  t.mock.timers.tick(LEAD_RESYNC_INTERVAL_MS - 1); await settle();
  assert.equal(store.pendingHandoffs().length, 1);
  t.mock.timers.tick(1); await settle();
  assert.equal(store.pendingHandoffs().length, 0);
});

test('not_found (row not in the DO yet) holds only that Lead; others still flush', async (t) => {
  const { bridge, store } = relay(t);
  const a = newLead(), b = newLead();
  bridge.respond = (op, args) => {
    if (op === 'lead.handoff' && args.handoff.lead === a && !bridge.rows.has(a)) throw new LeadRpcError('not_found', op, 'unknown Lead');
    return bridge.fakeDo(op, args);
  };
  await store.appendHandoff(input(a)); await store.appendHandoff(input(b)); await store.appendHandoff(input(a));
  bridge.setConnected(true); await settle();
  assert.deepEqual(bridge.ops('lead.handoff').map((c) => [c.args.handoff.lead, c.args.handoff.seq]), [[a, 1], [b, 1]], 'a#2 is not sent ahead of a#1');
  assert.deepEqual(store.pendingHandoffs().map((h) => [h.lead, h.seq]), [[a, 1], [a, 2]]);
  store.upsert(record(a)); await settle();
  bridge.setConnected(false); bridge.setConnected(true); await settle();
  assert.deepEqual(store.pendingHandoffs(), []);
  assert.deepEqual([...bridge.handoffs.keys()], [`${b}#1`, `${a}#1`, `${a}#2`]);
});

// ---------------------------------------------------------------------------------------------
// Registry: debounce, resync, chunking
// ---------------------------------------------------------------------------------------------

test('upsert sends the first edge at once and coalesces later edges into one send per 30 s per Lead', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const { bridge, store, logs } = relay(t);
  bridge.setConnected(true); await settle();
  const a = newLead(), b = newLead();
  store.upsert(record(a, { state: 'working', updated_at: 1 }));
  store.upsert(record(a, { state: 'needs_input', updated_at: 2 }));
  store.upsert(record(b, { updated_at: 3 }));
  t.mock.timers.tick(10_000);
  store.upsert(record(a, { state: 'turn_finished', updated_at: 4 }));
  await settle();
  assert.deepEqual(bridge.ops('lead.upsert').map((c) => [c.args.record.lead, c.args.record.updated_at]), [[a, 1], [b, 3]]);
  t.mock.timers.tick(LEAD_UPSERT_DEBOUNCE_MS - 10_000 - 1); await settle();
  assert.equal(bridge.ops('lead.upsert').length, 2);
  t.mock.timers.tick(1); await settle();
  assert.deepEqual(bridge.ops('lead.upsert').map((c) => [c.args.record.lead, c.args.record.state]), [[a, 'working'], [b, 'working'], [a, 'turn_finished']], 'only the latest row is sent');
  // A row that is not this machine's, or is invalid, is never sent.
  t.mock.timers.tick(LEAD_UPSERT_DEBOUNCE_MS);
  store.upsert(record(newLead(), { machine_id: OTHER_MACHINE }));
  store.upsert({ ...record(newLead()), cwd: '/Users/hong' } as any); // unknown field dropped, still valid
  store.upsert(record(newLead(), { project: '/Users/hong/code' }));
  await settle();
  assert.equal(bridge.ops('lead.upsert').length, 4);
  assert.ok(!JSON.stringify(bridge.calls).includes('/Users/hong'), 'no path reaches the relay');
  assert.equal(logs.filter((l) => /dropped/.test(l)).length, 2);
});

test('resync of every row on each hello and every 4 min while connected; none while disconnected', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const { bridge, store } = relay(t);
  const a = newLead(), b = newLead();
  let rows = [record(a), record(b, { state: 'ended', alive: false })];
  store.track(() => rows);
  assert.equal(bridge.calls.length, 0);
  bridge.setConnected(true); await settle();
  assert.deepEqual(bridge.ops('lead.sync').map((c) => c.args.records.map((r: LeadRecord) => r.lead)), [[a, b]], 'on hello, ended rows included');
  t.mock.timers.tick(LEAD_RESYNC_INTERVAL_MS - 1); await settle();
  assert.equal(bridge.ops('lead.sync').length, 1);
  rows = [record(a, { state: 'idle', updated_at: 3_000 })];
  t.mock.timers.tick(1); await settle();
  assert.equal(bridge.ops('lead.sync').length, 2);
  assert.equal(bridge.ops('lead.sync')[1]!.args.records[0].state, 'idle', 'the source is read on every tick');
  bridge.setConnected(false);
  t.mock.timers.tick(LEAD_RESYNC_INTERVAL_MS * 3); await settle();
  assert.equal(bridge.ops('lead.sync').length, 2, 'no ticks while disconnected');
  bridge.setConnected(true); await settle();
  assert.equal(bridge.ops('lead.sync').length, 3, 'resync on the next hello');
  t.mock.timers.tick(LEAD_RESYNC_INTERVAL_MS); await settle();
  assert.equal(bridge.ops('lead.sync').length, 4, 'one interval per connection (not stacked)');
});

test('rows upserted while disconnected reach the DO in the next hello resync; track() after hello syncs at once', async (t) => {
  const { bridge, store } = relay(t);
  const a = newLead(), b = newLead();
  store.upsert(record(a, { updated_at: 10 }));
  assert.equal(bridge.calls.length, 0);
  bridge.setConnected(true); await settle();
  assert.deepEqual(bridge.ops('lead.sync').map((c) => c.args.records.map((r: LeadRecord) => r.lead)), [[a]]);
  store.track(() => [record(a, { updated_at: 5 }), record(b)]);
  await settle();
  const last = bridge.ops('lead.sync').at(-1)!.args.records;
  assert.deepEqual(last.map((r: LeadRecord) => [r.lead, r.updated_at]), [[a, 10], [b, 2_000]], 'the newer upserted row wins over an older tracked one');
});

test('lead.sync is chunked to fit MAX_LEAD_FRAME and MAX_SYNC_RECORDS', async (t) => {
  const big = (i: number) => record(newLead(), { goal: `${i} `.padEnd(1000, 'g'), workers: Array.from({ length: 20 }, (_, w) => ({ session_key: `fm:worker-${i}-${w}`, name: 'w'.repeat(200), state: 'working' as const, permission_mode: 'bypass' as const, needs_attention: false })) });
  const bigRows = Array.from({ length: 30 }, (_, i) => big(i));
  const small = Array.from({ length: 120 }, () => record(newLead()));
  for (const rows of [bigRows, small]) {
    const chunks = chunkSyncRecords(rows);
    assert.deepEqual(chunks.flat().map((r) => r.lead), rows.map((r) => r.lead), 'every row, in order, once');
    for (const chunk of chunks) {
      assert.ok(chunk.length <= MAX_SYNC_RECORDS);
      const frame = { type: 'lead_rpc', id: 'x'.repeat(100), op: 'lead.sync', args: { records: chunk } };
      assert.ok(utf8Length(JSON.stringify(frame)) <= MAX_LEAD_FRAME);
      assert.ok(parseLeadRpc(frame).ok);
    }
    assert.ok(chunks.length > 1);
  }
  assert.ok(chunkSyncRecords(bigRows).every((c) => c.length < MAX_SYNC_RECORDS), 'big rows are split by bytes, not count');
  assert.deepEqual(chunkSyncRecords(small).map((c) => c.length), [50, 50, 20]);
  const { bridge, store } = relay(t);
  store.track(() => bigRows);
  bridge.setConnected(true); await settle();
  assert.equal(bridge.ops('lead.sync').length, chunkSyncRecords(bigRows).length);
  assert.equal(bridge.rows.size, 30);
});

// ---------------------------------------------------------------------------------------------
// Reads and grants
// ---------------------------------------------------------------------------------------------

test('devSettings asks the DO on every call (no cache) and is null on timeout, error or disconnect', async (t) => {
  const { bridge, store } = relay(t);
  assert.equal(await store.devSettings(), null, 'disconnected');
  bridge.setConnected(true); await settle();
  let allow = true;
  bridge.respond = (op, args) => op === 'settings.get' ? view(allow) : bridge.fakeDo(op, args);
  assert.equal((await store.devSettings())?.settings.bypass_grants[0]!.allow, true);
  allow = false;
  assert.equal((await store.devSettings())?.settings.bypass_grants[0]!.allow, false, 'a revocation applies on the very next call');
  assert.deepEqual(bridge.ops('settings.get').map((c) => c.timeoutMs), [5_000, 5_000], 'default timeout is 5 s');
  await store.devSettings(1234);
  assert.equal(bridge.ops('settings.get').at(-1)!.timeoutMs, 1234);
  bridge.respond = (op) => { throw new LeadRpcError(op === 'settings.get' ? 'timeout' : 'unavailable', op, 'x'); };
  assert.equal(await store.devSettings(), null, 'timeout');
  bridge.respond = (op) => { throw new LeadRpcError('invalid_result', op, 'x'); };
  assert.equal(await store.devSettings(), null);
  bridge.respond = (op, args) => bridge.fakeDo(op, args);
  bridge.setConnected(false);
  const before = bridge.calls.length;
  assert.equal(await store.devSettings(), null);
  assert.equal(bridge.calls.length, before, 'nothing sent while disconnected');
});

test('list/get/latestHandoff read the DO; disconnected they serve this machine\'s own data marked local', async (t) => {
  const { bridge, store } = relay(t);
  const mine = newLead(), ended = newLead(), remote = newLead();
  store.track(() => [record(mine, { updated_at: 3_000 }), record(ended, { state: 'ended', alive: false })]);
  await store.appendHandoff(input(mine));
  await store.appendHandoff(input(mine, { summary: 'second' }));
  // Offline.
  const offline = await store.list();
  assert.deepEqual(offline.map((e) => [e.lead, (e as any).local, e.ended]), [[mine, true, false]], 'ended excluded by default');
  assert.deepEqual((await store.list({ include_ended: true })).map((e) => e.lead), [mine, ended]);
  const got = await store.get(mine, 5);
  assert.equal((got as any).local, true);
  assert.deepEqual(got!.handoffs.map((h) => h.seq), [2, 1], 'newest first');
  assert.equal((await store.latestHandoff(mine))?.summary, 'second');
  assert.equal(await store.get(remote), null);
  assert.equal(await store.get('not a key'), null);
  // Online: the DO answers (including rows of other machines).
  bridge.setConnected(true); await settle();
  bridge.rows.set(remote, record(remote, { machine_id: OTHER_MACHINE, machine_name: 'machine-b' }));
  const online = await store.list({ include_ended: true, limit: 500 });
  assert.equal(bridge.ops('lead.list').at(-1)!.args.limit, 200, 'limit clamped to the contract');
  assert.ok(online.some((e) => e.lead === remote));
  assert.ok(online.every((e) => (e as any).local === undefined));
  const remoteGet = await store.get(remote, 2);
  assert.equal(remoteGet?.lead.machine_id, OTHER_MACHINE);
  // DO failure while connected: fall back, never throw.
  bridge.respond = (op) => { throw new LeadRpcError('timeout', op, 'no answer'); };
  assert.deepEqual((await store.list()).map((e) => [e.lead, (e as any).local]), [[mine, true]]);
  assert.equal((await store.latestHandoff(mine))?.seq, 2);
});

test('latestHandoff prefers this machine\'s newer handoff not yet delivered to the DO', async (t) => {
  const { bridge, store } = relay(t);
  const lead = newLead();
  store.track(() => [record(lead)]);
  bridge.setConnected(true); await settle();
  await store.appendHandoff(input(lead)); await settle();
  bridge.respond = (op, args) => { if (op === 'lead.handoff') throw new LeadRpcError('timeout', op, 'x'); return bridge.fakeDo(op, args); };
  await store.appendHandoff(input(lead, { summary: 'newer' })); await settle();
  assert.equal(store.pendingHandoffs().length, 1);
  assert.equal((await store.latestHandoff(lead))?.seq, 2);
  assert.deepEqual((await store.get(lead, 5))!.handoffs.map((h) => h.seq), [2, 1]);
});

test('LocalLeadStore: same local files, local reads, no grants, no outbox', async (t) => {
  const dir = home(t);
  const store = new LocalLeadStore({ identity: MACHINE, home: dir, log: () => {} });
  t.after(() => store.close());
  assert.equal(store.mode, 'local');
  assert.equal(await store.devSettings(), null);
  const lead = newLead();
  store.upsert(record(lead));
  const h = await store.appendHandoff(input(lead));
  assert.equal(statSync(join(dir, 'leads', `${lead.slice(3)}.jsonl`)).mode & 0o777, 0o600);
  assert.equal(existsSync(join(dir, 'leads', 'outbox.json')), false);
  assert.deepEqual((await store.list()).map((e) => [e.lead, (e as any).local, e.machine_online]), [[lead, true, true]]);
  assert.deepEqual((await store.get(lead, 3))!.handoffs, [h]);
  assert.deepEqual(await store.latestHandoff(lead), h);
});

test('createLeadStore picks the relay store with a bridge and the local store without', (t) => {
  const dir = home(t);
  const local = createLeadStore({ identity: MACHINE, home: dir, bridge: null, log: () => {} });
  const remote = createLeadStore({ identity: MACHINE, home: dir, bridge: new FakeBridge() as any, log: () => {} });
  t.after(() => { local.close(); remote.close(); });
  assert.ok(local instanceof LocalLeadStore); assert.equal(local.mode, 'local');
  assert.ok(remote instanceof RelayLeadStore); assert.equal(remote.mode, 'relay');
});

test('an invalid outbox.json is ignored with a log line, never thrown', async (t) => {
  const dir = home(t);
  const logs: string[] = [];
  const first = relay(t, { home: dir, logs }).store;
  await first.appendHandoff(input(newLead()));
  first.close();
  writeFileSync(join(dir, 'leads', 'outbox.json'), '{not json');
  const { store } = relay(t, { home: dir, logs });
  assert.deepEqual(store.pendingHandoffs(), []);
  assert.ok(logs.some((l) => /outbox\.json is invalid/.test(l)));
});

// ---------------------------------------------------------------------------------------------
// End to end over the real HostBridge and a fake DO socket
// ---------------------------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: any[] = [];
  open() { this.readyState = 1; this.emit('open'); }
  send(raw: string) { const value = JSON.parse(raw); this.sent.push(value); this.emit('sent', value); }
  receive(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', code, reason); }
  terminate() { this.close(); }
}

test('end to end: offline handoffs flush in order over lead_rpc once a standby host reconnects', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = home(t);
  const sockets: FakeSocket[] = [];
  const stored = new Set<string>();
  const bridge = new HostBridge(4177, { url: 'https://foreman.example', token: TOKEN }, {
    identity: MACHINE, platform: 'darwin',
    socketFactory: () => {
      const socket = new FakeSocket(); sockets.push(socket);
      // The fake DO: validates each lead_rpc with the shared contract and answers asynchronously.
      socket.on('sent', (frame: any) => {
        if (frame.type === 'hello') { queueMicrotask(() => socket.receive({ type: 'pm_assignment', active: false, epoch: 7, active_machine: { machine_id: OTHER_MACHINE, host: 'machine-b' }, uncertain_turns: [] })); return; }
        if (frame.type !== 'lead_rpc') return;
        const parsed = parseLeadRpc(frame);
        if (!parsed.ok) { queueMicrotask(() => socket.receive(leadRpcError(frame.id, parsed.code, parsed.error))); return; }
        const rpc = parsed.value;
        let reply;
        if (rpc.op === 'lead.handoff') {
          const key = `${rpc.args.handoff.lead}#${rpc.args.handoff.seq}`;
          reply = leadRpcOk(rpc.id, rpc.op, { stored: !stored.has(key) }); stored.add(key);
        } else if (rpc.op === 'lead.sync') reply = leadRpcOk(rpc.id, rpc.op, {});
        else reply = leadRpcError(rpc.id, 'unavailable', 'not in this fake');
        queueMicrotask(() => socket.receive(reply));
      });
      return socket as any;
    },
  });
  const store = createLeadStore({ identity: MACHINE, home: dir, bridge, log: () => {} });
  t.after(() => { store.close(); bridge.close(); });
  bridge.start();
  const a = newLead(), b = newLead();
  store.track(() => [record(a), record(b)]);
  await store.appendHandoff(input(a));
  await store.appendHandoff(input(b));
  await store.appendHandoff(input(a));
  sockets[0]!.open(); await settle();
  const leadFrames = sockets[0]!.sent.filter((f) => f.type === 'lead_rpc');
  assert.deepEqual(leadFrames.map((f) => f.op), ['lead.sync', 'lead.handoff', 'lead.handoff', 'lead.handoff']);
  assert.deepEqual(leadFrames.slice(1).map((f) => [f.args.handoff.lead, f.args.handoff.seq]), [[a, 1], [b, 1], [a, 2]]);
  assert.ok(leadFrames.every((f) => !('epoch' in f)), 'lead_rpc is not epoch-fenced');
  assert.equal(bridge.currentAssignment()?.active, false, 'this host is a standby, and still syncs its Leads');
  assert.deepEqual((store as RelayLeadStore).pendingHandoffs(), []);
  assert.equal(existsSync(join(dir, 'leads', 'outbox.json')), false);
});
