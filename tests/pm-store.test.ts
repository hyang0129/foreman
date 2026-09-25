// Pin FOREMAN_HOME to a temp dir before any server module loads (story #121 guard).
import './fixtures/temp-foreman-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostBridge } from '../server/host-bridge.ts';
import { loadMachineIdentity } from '../server/machine.ts';
import {
  ALREADY_INITIALIZED_MESSAGE, LocalPmStore, PmStoreError, RELAY_MEMORY_NOT_MERGED_NOTICE, RelayPmStore, createPmStore, fitImportFrame, importFrameBytes,
  parseLogLines, readImportPayload, truncateAtLine,
} from '../server/pm-store.ts';
import { utf8Length } from '../shared/notify.ts';
import {
  MAX_LOG_KEPT, MAX_PM_IMPORT_FRAME, MAX_PROJECTS_DOC, isHelloV2, parseHello, parsePmRpc, pmRpcError, pmRpcOk,
  type LogEntry, type PmStateStore, type UncertainTurn,
} from '../shared/pm-state.ts';

const TOKEN = 'synthetic-test-host-credential'.repeat(2);
const AT = '2026-09-24T12:00:00.000Z';
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: any[] = [];
  closed?: { code: number; reason: string };
  open() { this.readyState = 1; this.emit('open'); }
  send(raw: string) { const value = JSON.parse(raw); this.sent.push(value); this.emit('sent', value); }
  receive(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; this.closed = { code, reason }; this.emit('close'); }
  terminate() { this.close(); }
}

type Turn = { machine_id: string; epoch: number; accepted_at: string; state: 'open' | 'uncertain'; reason: 'restarted' | 'reassigned' | 'host_lost' | null };

/** A fake relay DO with the minimal semantics of contract sections B/C: assignment + epoch fencing, import-once, turns. */
class FakeRelay {
  assignment: { machine_id: string; epoch: number } | null = null;
  machines = new Map<string, { name: string; socket: FakeSocket | null }>();
  memory = { initialized: false, projects: { content: '', version: 0, updated_at: '' }, preferences: { content: '', version: 0, updated_at: '' }, log: [] as LogEntry[], seq: 0, model: null as string | null };
  turns = new Map<string, Turn>();
  frames: { machine_id: string | null; frame: any }[] = [];
  imports: any[] = [];
  hold: ((frame: any) => boolean) | null = null;
  held: (() => void)[] = [];
  /** Frames lost in transit: recorded as sent, never applied or answered. */
  swallow: ((frame: any) => boolean) | null = null;
  reportUninitialized = false;

  attach(socket: FakeSocket) { socket.on('sent', (frame) => this.receive(socket, frame)); }
  machineOf(socket: FakeSocket) { for (const [id, m] of this.machines) if (m.socket === socket) return id; return null; }
  private send(socket: FakeSocket, frame: unknown) { queueMicrotask(() => { if (socket.readyState === 1) socket.receive(frame); }); }
  rpcs(machineId?: string) { return this.frames.filter((f) => f.frame.type === 'pm_rpc' && (!machineId || f.machine_id === machineId)).map((f) => f.frame); }
  hellos() { return this.frames.filter((f) => f.frame.type === 'hello').map((f) => f.frame); }
  receive(socket: FakeSocket, frame: any) {
    this.frames.push({ machine_id: this.machineOf(socket), frame });
    if (frame.type === 'hello') {
      const parsed = parseHello(frame);
      assert.ok(parsed.ok && isHelloV2(parsed.value), 'hosts send a valid v2 hello');
      const hello = parsed.value as any;
      this.machines.set(hello.machine_id, { name: hello.host, socket });
      socket.once('close', () => { const m = this.machines.get(hello.machine_id); if (m?.socket === socket) m.socket = null; });
      if (!this.assignment) this.assignment = { machine_id: hello.machine_id, epoch: 1 };
      if (this.assignment.machine_id === hello.machine_id) {
        for (const [id, turn] of this.turns) if (turn.state === 'open' && !hello.pm_open_turns.includes(id)) { turn.state = 'uncertain'; turn.reason = 'restarted'; }
      }
      this.send(socket, this.assignmentFor(hello.machine_id));
      return;
    }
    if (frame.type !== 'pm_rpc') return;
    if (this.swallow?.(frame)) return;
    const parsed = parsePmRpc(frame);
    if (!parsed.ok) { if (parsed.id) this.reply(socket, frame, pmRpcError(parsed.id, parsed.code, parsed.error)); return; }
    const rpc = parsed.value;
    const machine = this.machineOf(socket)!;
    let result;
    if (!this.assignment || rpc.epoch !== this.assignment.epoch) result = pmRpcError(rpc.id, 'stale_epoch', `epoch ${rpc.epoch} is not current`);
    else if (machine !== this.assignment.machine_id) result = pmRpcError(rpc.id, 'not_active', 'not the active PM host');
    else result = this.apply(rpc, machine);
    this.reply(socket, frame, result);
  }
  private reply(socket: FakeSocket, frame: any, result: unknown) {
    if (this.hold?.(frame)) { this.held.push(() => this.send(socket, result)); return; }
    this.send(socket, result);
  }
  private apply(rpc: any, machine: string) {
    const m = this.memory, now = new Date().toISOString(), a = rpc.args;
    switch (rpc.op) {
      case 'memory.get': return pmRpcOk(rpc.id, rpc.op, { initialized: this.reportUninitialized ? false : m.initialized, docs: { projects: { ...m.projects }, preferences: { ...m.preferences } }, log: m.log.slice(-200), settings: { model: m.model } });
      case 'memory.import':
        if (m.initialized) return pmRpcError(rpc.id, 'already_initialized', 'memory already initialized');
        this.imports.push(a); m.initialized = true;
        if (a.projects) m.projects = { content: a.projects, version: 1, updated_at: now };
        m.log = a.log.map((text: string) => ({ seq: ++m.seq, at: now, text })); m.model = a.model;
        return pmRpcOk(rpc.id, rpc.op, { imported: true });
      case 'memory.put': {
        const doc = m[a.doc as 'projects' | 'preferences'];
        if (doc.version !== a.expected_version) return pmRpcError(rpc.id, 'version_conflict', 'version changed');
        m[a.doc as 'projects' | 'preferences'] = { content: a.content, version: doc.version + 1, updated_at: now }; m.initialized = true;
        return pmRpcOk(rpc.id, rpc.op, { version: doc.version + 1 });
      }
      case 'memory.log': m.log.push({ seq: ++m.seq, at: now, text: a.text }); m.initialized = true; return pmRpcOk(rpc.id, rpc.op, { seq: m.seq });
      case 'settings.put': m.model = a.model; return pmRpcOk(rpc.id, rpc.op, {});
      case 'turn.begin': {
        // As the DO (cloud/pm-state.ts): a repeated begin of the same open turn is acked again,
        // any other existing id is invalid, and a 65th open turn is unavailable.
        const existing = this.turns.get(a.turn_id);
        if (existing) return existing.state === 'open' && existing.machine_id === machine ? pmRpcOk(rpc.id, rpc.op, {}) : pmRpcError(rpc.id, 'invalid', 'turn_id is already recorded');
        if ([...this.turns.values()].filter((turn) => turn.state === 'open').length >= 64) return pmRpcError(rpc.id, 'unavailable', 'At most 64 PM turns can be open');
        this.turns.set(a.turn_id, { machine_id: machine, epoch: rpc.epoch, accepted_at: a.accepted_at, state: 'open', reason: null });
        return pmRpcOk(rpc.id, rpc.op, {});
      }
      // Only the open row: an uncertain row stays until turn.ack_uncertain.
      case 'turn.end': if (this.turns.get(a.turn_id)?.state === 'open') this.turns.delete(a.turn_id); return pmRpcOk(rpc.id, rpc.op, {});
      case 'turn.ack_uncertain': for (const id of a.turn_ids) if (this.turns.get(id)?.state === 'uncertain') this.turns.delete(id); return pmRpcOk(rpc.id, rpc.op, {});
      default: return pmRpcError(rpc.id, 'invalid', 'unsupported in the fake');
    }
  }
  assignmentFor(machineId: string) {
    const a = this.assignment!, active = a.machine_id === machineId;
    const uncertain = [...this.turns].filter(([, t]) => t.state === 'uncertain').map(([turn_id, t]) => ({ turn_id, accepted_at: t.accepted_at, host: this.machines.get(t.machine_id)!.name, reason: t.reason }));
    return { type: 'pm_assignment', active, epoch: a.epoch, active_machine: { machine_id: a.machine_id, host: this.machines.get(a.machine_id)!.name }, uncertain_turns: active ? uncertain : [] };
  }
  /** Developer reassignment. `lostFor` simulates a machine that never receives the new assignment frame. */
  reassign(machineId: string, lostFor?: string) {
    const old = this.assignment!;
    const oldOnline = Boolean(this.machines.get(old.machine_id)?.socket);
    for (const turn of this.turns.values()) if (turn.state === 'open') { turn.state = 'uncertain'; turn.reason = oldOnline ? 'reassigned' : 'host_lost'; }
    this.assignment = { machine_id: machineId, epoch: old.epoch + 1 };
    for (const [id, m] of this.machines) if (m.socket && id !== lostFor) this.send(m.socket, this.assignmentFor(id));
  }
}

const MEMORY_FILES = ['memory/PROJECTS.md', 'memory/LOG.md', 'pm/settings.json', 'pm/history.jsonl', 'pm/session', 'pm/session.quarantine.jsonl'];

function tempHome(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-pm-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seed(dir: string, files: { projects?: string; log?: string; settings?: string } = {}) {
  mkdirSync(join(dir, 'memory'), { recursive: true }); mkdirSync(join(dir, 'pm'), { recursive: true });
  if (files.projects !== undefined) writeFileSync(join(dir, 'memory/PROJECTS.md'), files.projects);
  if (files.log !== undefined) writeFileSync(join(dir, 'memory/LOG.md'), files.log);
  if (files.settings !== undefined) writeFileSync(join(dir, 'pm/settings.json'), files.settings);
  writeFileSync(join(dir, 'pm/history.jsonl'), '{"role":"user","text":"TRANSCRIPT-MUST-NOT-MOVE"}\n');
  writeFileSync(join(dir, 'pm/session'), 'session-id-123');
  writeFileSync(join(dir, 'pm/session.quarantine.jsonl'), '{"quarantined":true}\n');
}

function snapshot(dir: string) {
  return MEMORY_FILES.filter((f) => existsSync(join(dir, f))).map((f) => {
    const s = statSync(join(dir, f));
    return { f, bytes: readFileSync(join(dir, f)).toString('base64'), mtime: s.mtimeMs, mode: s.mode };
  });
}

function relayHost(t: test.TestContext, relay: FakeRelay, dir: string, name: string, options: { rpcTimeoutMs?: number; retryBaseMs?: number } = {}) {
  t.mock.method(console, 'log', () => {});
  const identity = loadMachineIdentity({ home: dir, env: { FOREMAN_MACHINE_NAME: name } });
  const logs: string[] = [];
  const sockets: FakeSocket[] = [];
  let store: RelayPmStore | undefined;
  const bridge = new HostBridge(4177, { url: 'https://foreman.example', token: TOKEN }, {
    identity, platform: 'darwin', rpcTimeoutMs: options.rpcTimeoutMs,
    pmOpenTurns: () => store?.openTurnIds() ?? [],
    socketFactory: () => { const socket = new FakeSocket(); relay.attach(socket); sockets.push(socket); return socket as any; },
  });
  store = new RelayPmStore(bridge, { identity, home: dir, log: (line) => logs.push(line), retryBaseMs: options.retryBaseMs });
  bridge.start();
  t.after(() => { store!.close(); bridge.close(); });
  return {
    identity, bridge, store, sockets, logs,
    async connect() { sockets.at(-1)!.open(); await settle(); },
    drop() { sockets.at(-1)!.close(1006, 'network'); clearTimeout((bridge as any).reconnect); },
    async reconnect() { (bridge as any).connect(); sockets.at(-1)!.open(); await settle(); },
  };
}

const code = (expected: string) => (error: unknown) => error instanceof PmStoreError && error.code === expected;

// ---------------------------------------------------------------------------------------------
// Import helpers
// ---------------------------------------------------------------------------------------------

test('PROJECTS.md over 32 KiB is truncated at a line boundary and the importer says so', (t) => {
  const dir = tempHome(t);
  const line = '## project ' + 'é'.repeat(40) + '\n';
  const projects = line.repeat(Math.ceil((MAX_PROJECTS_DOC * 1.5) / utf8Length(line)));
  seed(dir, { projects });
  const logs: string[] = [];
  const payload = readImportPayload(dir, '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', (l) => logs.push(l));
  assert.ok(utf8Length(payload.projects) <= MAX_PROJECTS_DOC);
  assert.ok(payload.projects.endsWith('\n'), 'cut after a complete line');
  assert.ok(projects.startsWith(payload.projects));
  assert.ok(utf8Length(payload.projects) > MAX_PROJECTS_DOC - utf8Length(line));
  assert.match(logs.join('\n'), /PROJECTS\.md is \d+ bytes.*line boundary/);
  assert.deepEqual(truncateAtLine('short\n', 100), { content: 'short\n', truncated: false });
  assert.equal(truncateAtLine('x'.repeat(10), 4).content, 'xxxx', 'no newline at all: cut at a character boundary');
});

test('LOG.md: one entry per "- " line, short lines dropped, long lines cut to 500, newest 2000 kept', () => {
  const text = ['# Log', '- ok', '-  a ', '- ' + 'y'.repeat(700), 'not a bullet', '- 2026-09-24 10:00 — shipped', '', '-no space'].join('\n');
  const lines = parseLogLines(text);
  assert.deepEqual(lines.map((l) => l.length), [500, 26]);
  assert.equal(lines[1], '2026-09-24 10:00 — shipped');
  const many = Array.from({ length: 2500 }, (_, i) => `- entry ${i}`).join('\n');
  const kept = parseLogLines(many);
  assert.equal(kept.length, MAX_LOG_KEPT);
  assert.equal(kept[0], 'entry 500'); assert.equal(kept.at(-1), 'entry 2499');
});

test('the oldest log lines are dropped until the memory.import frame fits 1 MiB; projects is never trimmed', (t) => {
  const dir = tempHome(t);
  // 2000 × 500 chars of 3-byte characters with JSON-escaped quotes ≈ 3 MB: far over the frame.
  const long = (i: number) => `- ${String(i).padStart(4, '0')} ` + '"€'.repeat(247);
  const projects = '# Projects\n' + 'p'.repeat(MAX_PROJECTS_DOC - 20) + '\n';
  seed(dir, { projects, log: Array.from({ length: 2200 }, (_, i) => long(i)).join('\n') });
  const logs: string[] = [];
  const payload = readImportPayload(dir, '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', (l) => logs.push(l));
  assert.equal(payload.projects, projects);
  assert.ok(importFrameBytes(payload) <= MAX_PM_IMPORT_FRAME);
  assert.ok(importFrameBytes({ ...payload, log: [long(0).slice(2), ...payload.log] }) > MAX_PM_IMPORT_FRAME, 'dropping stops as soon as it fits');
  assert.ok(payload.log.length < MAX_LOG_KEPT && payload.log.length > 100);
  assert.ok(payload.log.at(-1)!.startsWith('2199 '), 'the newest line is kept');
  assert.match(logs.join('\n'), /dropped the \d+ oldest LOG\.md lines/);
  const small = fitImportFrame({ projects: '', log: ['abc'], model: null, source_machine: '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21' });
  assert.equal(small.dropped, 0);
});

test('missing memory files import as empty; an invalid settings model imports as null', (t) => {
  const dir = tempHome(t);
  const payload = readImportPayload(dir, '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', () => {});
  assert.deepEqual(payload, { projects: '', log: [], model: null, source_machine: '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21' });
  seed(dir, { settings: '{"model":"bad model id!"}' });
  assert.equal(readImportPayload(dir, '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', () => {}).model, null);
  writeFileSync(join(dir, 'pm/settings.json'), '{"model":"claude-opus-4-5"}');
  assert.equal(readImportPayload(dir, '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', () => {}).model, 'claude-opus-4-5');
});

// ---------------------------------------------------------------------------------------------
// RelayPmStore
// ---------------------------------------------------------------------------------------------

test('relay import: first activation imports projects, log lines and model once; sources stay byte-identical', async (t) => {
  const dir = tempHome(t);
  seed(dir, { projects: '# Projects\n\n## foreman\nGoal: portable PM\n', log: '# Log\n- 2026-09-01 10:00 — decided X\n- 2026-09-02 11:00 — shipped Y\n', settings: '{"model":"claude-opus-4-5"}' });
  const before = snapshot(dir);
  const relay = new FakeRelay();
  const h = relayHost(t, relay, dir, 'machine-a');
  await h.connect();
  assert.equal(await h.store.ensureImported(), 'imported');
  assert.equal(relay.imports.length, 1);
  assert.deepEqual(relay.imports[0], { projects: '# Projects\n\n## foreman\nGoal: portable PM\n', log: ['2026-09-01 10:00 — decided X', '2026-09-02 11:00 — shipped Y'], model: 'claude-opus-4-5', source_machine: h.identity.machine_id });
  const marker = JSON.parse(readFileSync(join(dir, 'memory/.imported.json'), 'utf8'));
  assert.equal(marker.machine_id, h.identity.machine_id); assert.equal(marker.target, 'relay'); assert.ok(!Number.isNaN(Date.parse(marker.at)));
  assert.equal(statSync(join(dir, 'memory/.imported.json')).mode & 0o777, 0o600);
  const memory = await h.store.read();
  assert.equal(memory.initialized, true); assert.equal(memory.model, 'claude-opus-4-5');
  assert.equal(memory.preferences.content, '', 'preferences start empty');
  assert.deepEqual(memory.log.map((e) => e.text), ['2026-09-01 10:00 — decided X', '2026-09-02 11:00 — shipped Y']);
  assert.deepEqual(snapshot(dir), before, 'PROJECTS.md, LOG.md, settings.json, history.jsonl, session, quarantine untouched');
  assert.ok(!JSON.stringify(relay.frames).includes('TRANSCRIPT-MUST-NOT-MOVE'), 'history.jsonl is never sent');

  // Once only: a reconnect and re-activation do not import again.
  h.drop(); await h.reconnect();
  assert.equal(h.store.assignment().active, true);
  assert.equal(relay.rpcs().filter((f) => f.op === 'memory.import').length, 1);
  assert.equal(await h.store.ensureImported(), 'imported');
});

test('relay import: already_initialized is logged and is not an error; no marker is written', async (t) => {
  const dir = tempHome(t);
  seed(dir, { projects: '# Mine\n' });
  const relay = new FakeRelay();
  relay.memory.initialized = true; relay.memory.projects = { content: '# Theirs\n', version: 4, updated_at: AT };
  relay.reportUninitialized = true; // another machine initialized it between memory.get and memory.import
  const h = relayHost(t, relay, dir, 'machine-a');
  await h.connect();
  assert.equal(await h.store.ensureImported(), 'already_initialized');
  assert.ok(h.logs.some((l) => l.includes(ALREADY_INITIALIZED_MESSAGE)), h.logs.join('\n'));
  assert.equal(relay.rpcs().filter((f) => f.op === 'memory.import').length, 1);
  assert.equal(existsSync(join(dir, 'memory/.imported.json')), false);
  assert.equal(relay.memory.projects.content, '# Theirs\n', 'nothing merged');
  assert.equal(h.store.assignment().active, true, 'the store stays usable');
});

test('beginTurn is write-ahead: it resolves only when the DO acknowledges the record', async (t) => {
  const relay = new FakeRelay();
  const h = relayHost(t, relay, tempHome(t), 'machine-a');
  await h.connect();
  relay.hold = (frame) => frame.op === 'turn.begin';
  let resolved = false;
  const begun = h.store.beginTurn('turn-1', AT).then(() => { resolved = true; });
  await settle();
  assert.equal(resolved, false, 'no ack yet, so the caller must not dispatch');
  assert.equal(relay.turns.get('turn-1')?.state, 'open');
  relay.held.shift()!(); await begun;
  assert.equal(resolved, true);
  const begin = relay.rpcs().find((f) => f.op === 'turn.begin');
  assert.deepEqual(begin.args, { turn_id: 'turn-1', accepted_at: AT });
  assert.equal(begin.epoch, 1);
  assert.deepEqual(h.store.openTurnIds(), ['turn-1']);
});

test('beginTurn fails closed: disconnected, not active, or timed out', async (t) => {
  const relay = new FakeRelay();
  const a = relayHost(t, relay, tempHome(t), 'machine-a', { rpcTimeoutMs: 30 });
  const b = relayHost(t, relay, tempHome(t), 'machine-b');
  await assert.rejects(a.store.beginTurn('turn-0', AT), code('disconnected'));
  await a.connect(); await b.connect();
  await assert.rejects(b.store.beginTurn('turn-b', AT), (e: any) => e.code === 'not_active' && /machine-a/.test(e.message));
  assert.equal(relay.rpcs(b.identity.machine_id).length, 0, 'an inactive host sends nothing');
  relay.hold = (frame) => frame.op === 'turn.begin';
  await assert.rejects(a.store.beginTurn('turn-1', AT), code('timeout'));
  // The DO may hold the record: it stays listed as open and is ended as failed, never left to surface as uncertain.
  relay.hold = null; await settle();
  assert.deepEqual(relay.rpcs().filter((f) => f.op === 'turn.end').map((f) => f.args), [{ turn_id: 'turn-1', outcome: 'failed' }]);
  assert.equal(relay.turns.size, 0);
  assert.deepEqual(a.store.openTurnIds(), []);
  a.drop();
  await assert.rejects(a.store.beginTurn('turn-2', AT), code('disconnected'));
  assert.equal(a.store.assignment().connected, false);
  assert.equal(a.store.assignment().active, false);
});

test('endTurn/ackUncertain queue while disconnected and flush in order on reconnect, with no false uncertain', async (t) => {
  const relay = new FakeRelay();
  const dir = tempHome(t);
  const h = relayHost(t, relay, dir, 'machine-a');
  // A turn left open by a previous daemon process on this machine.
  relay.assignment = { machine_id: h.identity.machine_id, epoch: 1 };
  relay.machines.set(h.identity.machine_id, { name: 'machine-a', socket: null });
  relay.turns.set('turn-old', { machine_id: h.identity.machine_id, epoch: 1, accepted_at: AT, state: 'open', reason: null });
  const seen: { active: boolean; uncertain: UncertainTurn[] }[] = [];
  h.store.onAssignment((a, uncertain) => seen.push({ active: a.active, uncertain }));
  await h.connect();
  assert.deepEqual(h.store.uncertainTurns().map((u) => [u.turn_id, u.reason]), [['turn-old', 'restarted']]);
  assert.ok(seen.some((s) => s.active && s.uncertain.length === 1));
  await h.store.beginTurn('turn-1', AT);
  await h.store.beginTurn('turn-2', AT);
  h.drop();
  const sentBefore = relay.rpcs().length;
  await h.store.endTurn('turn-1', 'completed'); // resolves once queued
  await h.store.ackUncertain(['turn-old']);
  await h.store.endTurn('turn-2', 'cancelled');
  assert.equal(relay.rpcs().length, sentBefore, 'nothing is sent while disconnected');
  await h.reconnect();
  const hello = relay.hellos().at(-1);
  assert.deepEqual(hello.pm_open_turns.sort(), ['turn-1', 'turn-2'], 'the PM survived the blip, so its turns are still open');
  const helloAt = relay.frames.findIndex((f) => f.frame === hello);
  const firstFlushAt = relay.frames.findIndex((f, i) => i > helloAt && f.frame.type === 'pm_rpc');
  assert.ok(helloAt >= 0 && firstFlushAt > helloAt, 'the hello (with the still-open turns) goes out before the queued ends flush');
  const flushed = relay.rpcs().slice(sentBefore);
  assert.deepEqual(flushed.map((f) => [f.op, f.args.turn_id ?? f.args.turn_ids]), [['turn.end', 'turn-1'], ['turn.ack_uncertain', ['turn-old']], ['turn.end', 'turn-2']]);
  // turn.end deletes only open rows, so an empty table proves turn-1/turn-2 were still open (not
  // marked restarted) when their ends arrived.
  assert.equal(relay.turns.size, 0);
  assert.deepEqual(h.store.openTurnIds(), []);
  assert.deepEqual(h.store.uncertainTurns(), []);
  assert.ok(![...relay.turns.values()].some((turn) => turn.state === 'uncertain'), 'no false uncertain for turn-1/turn-2');
});

test('a timed-out beginTurn stays in pm_open_turns until its failed end is acked, across a reconnect', async (t) => {
  const relay = new FakeRelay();
  const h = relayHost(t, relay, tempHome(t), 'machine-a', { rpcTimeoutMs: 30 });
  await h.connect();
  // The DO records the turn but its ack never arrives; the follow-up failed end is lost in transit.
  relay.hold = (frame) => frame.op === 'turn.begin';
  relay.swallow = (frame) => frame.op === 'turn.end';
  await assert.rejects(h.store.beginTurn('turn-t', AT), code('timeout'));
  assert.equal(relay.turns.get('turn-t')?.state, 'open', 'the DO did record it');
  assert.deepEqual(h.store.openTurnIds(), ['turn-t'], 'still listed: the failed end is not acked');
  await new Promise((resolve) => setTimeout(resolve, 60)); await settle(); // the end times out too
  assert.equal(relay.rpcs().filter((f) => f.op === 'turn.end').length, 1);
  assert.deepEqual(h.store.openTurnIds(), ['turn-t'], 'still listed after the end timed out');
  h.drop();
  assert.deepEqual(h.store.openTurnIds(), ['turn-t'], 'still listed while disconnected');
  relay.hold = null; relay.held = []; relay.swallow = null;
  await h.reconnect();
  assert.deepEqual(relay.hellos().at(-1).pm_open_turns, ['turn-t'], 'the reconnect hello lists it, so the DO does not mark it restarted');
  assert.deepEqual(relay.rpcs().filter((f) => f.op === 'turn.end').map((f) => f.args), [{ turn_id: 'turn-t', outcome: 'failed' }, { turn_id: 'turn-t', outcome: 'failed' }]);
  assert.equal(relay.turns.size, 0, 'removed by the flushed end, never surfaced as uncertain');
  assert.deepEqual(h.store.openTurnIds(), []);
  assert.deepEqual(h.store.uncertainTurns(), []);
});

// ---- #116: uncertain reporting across restarts ------------------------------------------------

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The daemon process dies: nothing more is flushed. */
const kill = (h: { store: RelayPmStore; bridge: HostBridge }) => { h.store.close(); h.bridge.close(); };

test('#116: an uncertain turn whose ack was lost is not reported again after a restart, and is acked then', async (t) => {
  const relay = new FakeRelay();
  const dir = tempHome(t);
  const first = relayHost(t, relay, dir, 'machine-a', { rpcTimeoutMs: 30 });
  relay.assignment = { machine_id: first.identity.machine_id, epoch: 1 };
  relay.machines.set(first.identity.machine_id, { name: 'machine-a', socket: null });
  relay.turns.set('turn-u', { machine_id: first.identity.machine_id, epoch: 1, accepted_at: AT, state: 'uncertain', reason: 'restarted' });
  await first.connect();
  assert.deepEqual(first.store.uncertainTurns().map((u) => u.turn_id), ['turn-u'], 'reported to this process');
  relay.swallow = (frame) => frame.op === 'turn.ack_uncertain'; // the ack is lost in transit
  await first.store.ackUncertain(['turn-u']);
  await settle();
  assert.equal(relay.turns.get('turn-u')?.state, 'uncertain', 'the DO never got the ack');
  kill(first); // restart before the ack is retried
  relay.swallow = null;
  const before = relay.rpcs().length;
  const second = relayHost(t, relay, dir, 'machine-a');
  const heard: UncertainTurn[][] = [];
  second.store.onAssignment((a, uncertain) => { if (a.active) heard.push(uncertain); });
  await second.connect();
  assert.equal(second.identity.machine_id, first.identity.machine_id);
  assert.deepEqual(second.store.uncertainTurns(), [], 'not reported again after the restart');
  assert.ok(heard.length > 0 && heard.every((list) => list.length === 0), 'no listener hears it');
  assert.equal(relay.turns.has('turn-u'), false, 'acknowledged on activation');
  assert.deepEqual(relay.rpcs().slice(before).filter((f) => f.op === 'turn.ack_uncertain').map((f) => f.args.turn_ids), [['turn-u']]);
  // Once confirmed, the record is forgotten: a third run neither lists nor acks it.
  kill(second);
  const third = relayHost(t, relay, dir, 'machine-a');
  await third.connect();
  assert.equal(relay.rpcs().filter((f) => f.op === 'turn.ack_uncertain').length, 2);
});

test('#116: a begin that failed (never dispatched) and a restart before its failed end flushes yields no uncertain entry', async (t) => {
  const relay = new FakeRelay();
  const dir = tempHome(t);
  const first = relayHost(t, relay, dir, 'machine-a', { rpcTimeoutMs: 30 });
  await first.connect();
  // The DO records the turn but its ack never arrives; the failed end is lost in transit too.
  relay.hold = (frame) => frame.op === 'turn.begin';
  relay.swallow = (frame) => frame.op === 'turn.end';
  await assert.rejects(first.store.beginTurn('turn-t', AT), code('timeout'));
  assert.equal(relay.turns.get('turn-t')?.state, 'open', 'the DO did record it');
  kill(first); // restart before the failed end is confirmed
  relay.hold = null; relay.held = []; relay.swallow = null;
  const before = relay.rpcs().length;
  const second = relayHost(t, relay, dir, 'machine-a');
  await second.connect();
  assert.deepEqual(relay.hellos().at(-1).pm_open_turns, ['turn-t'], 'the restarted host still lists it, so the DO does not mark it restarted');
  assert.deepEqual(second.store.uncertainTurns(), []);
  assert.equal(relay.turns.size, 0, 'removed by the failed end flushed on activation');
  assert.deepEqual(relay.rpcs().slice(before).filter((f) => f.op === 'turn.end').map((f) => f.args), [{ turn_id: 'turn-t', outcome: 'failed' }]);
  assert.deepEqual(second.store.openTurnIds(), []);
});

test('#116: a turn with a recorded outcome that the DO already marked uncertain is acknowledged, not reported', async (t) => {
  const relay = new FakeRelay();
  const dir = tempHome(t);
  const first = relayHost(t, relay, dir, 'machine-a', { rpcTimeoutMs: 30 });
  await first.connect();
  relay.hold = (frame) => frame.op === 'turn.begin';
  relay.swallow = (frame) => frame.op === 'turn.end';
  await assert.rejects(first.store.beginTurn('turn-t', AT), code('timeout'));
  kill(first);
  relay.hold = null; relay.held = []; relay.swallow = null;
  // Meanwhile the DO reconciled it (e.g. a hello from an older build of this daemon): uncertain.
  const turn = relay.turns.get('turn-t')!; turn.state = 'uncertain'; turn.reason = 'restarted';
  const before = relay.rpcs().length;
  const second = relayHost(t, relay, dir, 'machine-a');
  await second.connect();
  assert.deepEqual(second.store.uncertainTurns(), [], 'never dispatched, so never reported');
  assert.equal(relay.turns.size, 0, 'acknowledged instead');
  assert.deepEqual(relay.rpcs().slice(before).filter((f) => f.op === 'turn.ack_uncertain').map((f) => f.args.turn_ids), [['turn-t']]);
});

test('#116: a turn.end that times out while still connected is retried with backoff, not left until the next item', async (t) => {
  const relay = new FakeRelay();
  const h = relayHost(t, relay, tempHome(t), 'machine-a', { rpcTimeoutMs: 30, retryBaseMs: 20 });
  await h.connect();
  await h.store.beginTurn('turn-1', AT);
  let lost = 1;
  relay.swallow = (frame) => frame.op === 'turn.end' && lost-- > 0; // only the first end is lost
  await h.store.endTurn('turn-1', 'completed');
  for (let i = 0; i < 100 && relay.turns.size; i++) await wait(10);
  assert.equal(relay.turns.size, 0, 'the DO row was closed by the retry, while still connected');
  assert.equal(h.store.assignment().connected, true);
  assert.deepEqual(relay.rpcs().filter((f) => f.op === 'turn.end').map((f) => f.args.turn_id), ['turn-1', 'turn-1']);
  assert.deepEqual(h.store.openTurnIds(), []);
  await wait(100);
  assert.equal(relay.rpcs().filter((f) => f.op === 'turn.end').length, 2, 'nothing more once confirmed');
});

test('#116: retries back off (no hot loop) and stop on disconnect and on close', async (t) => {
  const relay = new FakeRelay();
  const h = relayHost(t, relay, tempHome(t), 'machine-a', { rpcTimeoutMs: 20, retryBaseMs: 20 });
  await h.connect();
  await h.store.beginTurn('turn-1', AT);
  relay.swallow = (frame) => frame.op === 'turn.ack_uncertain' || frame.op === 'turn.end'; // every update is lost
  await h.store.endTurn('turn-1', 'completed');
  await wait(400);
  const ends = () => relay.rpcs().filter((f) => f.op === 'turn.end').length;
  // Sends at ~0, 40, 100, 200, 380 ms (20 ms timeout + 20/40/80/160 ms backoff); a hot loop would be ~20.
  assert.ok(ends() >= 2 && ends() <= 6, `retried with backoff (${ends()} sends)`);
  h.drop();
  const atDrop = ends();
  await wait(200);
  assert.equal(ends(), atDrop, 'no retries while disconnected');
  await h.reconnect();
  assert.equal(ends(), atDrop + 1, 'the reconnect flushes it once');
  await wait(30);
  h.store.close();
  const atClose = ends();
  await wait(300);
  assert.equal(ends(), atClose, 'no retries after close');
});

test('turn.begin: a repeated begin of an open turn is acked again; a 65th open turn is unavailable (as the DO)', async (t) => {
  const relay = new FakeRelay();
  const h = relayHost(t, relay, tempHome(t), 'machine-a');
  await h.connect();
  for (let i = 0; i < 64; i++) await h.store.beginTurn(`turn-${i}`, AT);
  await h.store.beginTurn('turn-0', AT);
  await assert.rejects(h.store.beginTurn('turn-64', AT), code('unavailable'));
  assert.equal(h.store.openTurnIds().includes('turn-64'), false, 'a refused begin is not listed as open');
  assert.equal(h.store.openTurnIds().length, 64);
});

test('stale_epoch drops the queued outcomes and surfaces not_active', async (t) => {
  const relay = new FakeRelay();
  const a = relayHost(t, relay, tempHome(t), 'machine-a');
  const b = relayHost(t, relay, tempHome(t), 'machine-b');
  await a.connect(); await b.connect();
  await a.store.beginTurn('turn-1', AT); await a.store.beginTurn('turn-2', AT);
  const states: boolean[] = []; a.store.onAssignment((s) => states.push(s.active)); await settle();
  relay.reassign(b.identity.machine_id, a.identity.machine_id); // A never hears about it
  await settle();
  assert.equal(a.store.assignment().active, true, 'A has not been told yet');
  const ends = [a.store.endTurn('turn-1', 'completed'), a.store.endTurn('turn-2', 'completed')];
  await Promise.all(ends); await settle();
  assert.deepEqual(relay.rpcs(a.identity.machine_id).filter((f) => f.op === 'turn.end').map((f) => f.args.turn_id), ['turn-1'], 'the queue behind the stale reply is dropped');
  assert.equal(a.store.assignment().active, false);
  assert.equal(states.at(-1), false, 'listeners hear that A is no longer active');
  assert.deepEqual(a.store.openTurnIds(), []);
  assert.ok(a.logs.some((l) => /dropped 2 queued PM turn updates/.test(l)), a.logs.join('\n'));
  await assert.rejects(a.store.log('after the move'), code('not_active'));
  const logCount = relay.memory.log.length;
  // Direct write with the old epoch: the DO fences it.
  await assert.rejects(a.bridge.rpc('memory.log', { text: 'split brain' }, { epoch: 1 }), (e: any) => e.code === 'stale_epoch');
  assert.equal(relay.memory.log.length, logCount);
  // B was told and reports turn-1/turn-2 as reassigned (turn-1's end arrived after the move and was fenced).
  assert.deepEqual(b.store.uncertainTurns().map((u) => [u.turn_id, u.reason, u.host]).sort(), [['turn-1', 'reassigned', 'machine-a'], ['turn-2', 'reassigned', 'machine-a']]);
});

test('assignment() and onAssignment report active, connected, epoch and the active host', async (t) => {
  const relay = new FakeRelay();
  const a = relayHost(t, relay, tempHome(t), 'machine-a');
  const b = relayHost(t, relay, tempHome(t), 'machine-b');
  assert.deepEqual(a.store.assignment(), { active: false, connected: false, epoch: 0, activeHost: null });
  const events: ReturnType<PmStateStore['assignment']>[] = [];
  b.store.onAssignment((s) => events.push(s));
  await a.connect(); await b.connect();
  assert.deepEqual(a.store.assignment(), { active: true, connected: true, epoch: 1, activeHost: 'machine-a' });
  assert.deepEqual(b.store.assignment(), { active: false, connected: true, epoch: 1, activeHost: 'machine-a' });
  relay.reassign(b.identity.machine_id); await settle();
  assert.deepEqual(a.store.assignment(), { active: false, connected: true, epoch: 2, activeHost: 'machine-b' });
  assert.deepEqual(b.store.assignment(), { active: true, connected: true, epoch: 2, activeHost: 'machine-b' });
  assert.deepEqual(events.at(-1), { active: true, connected: true, epoch: 2, activeHost: 'machine-b' });
  b.drop(); await settle();
  assert.deepEqual(events.at(-1), { active: false, connected: false, epoch: 2, activeHost: 'machine-b' });
  await assert.rejects(b.store.read(), code('disconnected'));
});

test('two FOREMAN_HOMEs against one relay: distinct machines, import once, reassignment fences the old host', async (t) => {
  const homeA = tempHome(t), homeB = tempHome(t);
  seed(homeA, { projects: '# Projects\n\n## alpha\nState: from machine A\n', log: '# Log\n- A decided alpha\n', settings: '{"model":"claude-opus-4-5"}' });
  seed(homeB, { projects: '# Projects\n\n## beta\nState: from machine B\n', log: '# Log\n- B decided beta\n', settings: '{"model":"gpt-5"}' });
  const beforeA = snapshot(homeA), beforeB = snapshot(homeB);
  const relay = new FakeRelay();
  const a = relayHost(t, relay, homeA, 'machine-a');
  const b = relayHost(t, relay, homeB, 'machine-b');
  await a.connect(); await b.connect();

  const hellos = relay.hellos();
  assert.equal(hellos.length, 2);
  assert.notEqual(hellos[0].machine_id, hellos[1].machine_id);
  assert.deepEqual(hellos.map((h) => [h.machine_id, h.host]), [[a.identity.machine_id, 'machine-a'], [b.identity.machine_id, 'machine-b']]);

  // First home imports; the standby does not touch memory.
  assert.equal(await a.store.ensureImported(), 'imported');
  assert.equal(relay.imports.length, 1);
  assert.equal(relay.imports[0].source_machine, a.identity.machine_id);
  assert.equal(relay.rpcs(b.identity.machine_id).length, 0);
  assert.ok(existsSync(join(homeA, 'memory/.imported.json')));
  await a.store.beginTurn('turn-a1', AT);

  // Move the PM to B while A is live: A misses the frame and discovers the move through fencing.
  relay.reassign(b.identity.machine_id, a.identity.machine_id); await settle();
  assert.equal(await b.store.ensureImported(), 'already_initialized');
  assert.ok(b.logs.some((l) => l.includes(ALREADY_INITIALIZED_MESSAGE)));
  assert.equal(relay.imports.length, 1, "B's import is a no-op");
  assert.equal(existsSync(join(homeB, 'memory/.imported.json')), false);
  const memory = await b.store.read();
  assert.match(memory.projects.content, /from machine A/, 'B answers from the same memory');
  assert.doesNotMatch(memory.projects.content, /from machine B/);
  assert.equal(memory.model, 'claude-opus-4-5');
  assert.deepEqual(b.store.uncertainTurns().map((u) => [u.turn_id, u.reason]), [['turn-a1', 'reassigned']]);

  await assert.rejects(a.store.write('projects', '# overwritten by A', memory.projects.version), code('not_active'));
  assert.equal(a.store.assignment().active, false);
  const aRpcs = relay.frames.filter((f) => f.machine_id === a.identity.machine_id && f.frame.op === 'memory.put');
  assert.equal(aRpcs.length, 1, 'the write reached the DO once and was fenced there (stale_epoch)');
  await assert.rejects(a.store.log('another'), code('not_active'));
  assert.equal(relay.memory.projects.content, memory.projects.content, 'fenced writes change nothing');

  // B writes normally.
  const { version } = await b.store.write('projects', memory.projects.content + '\n## beta\nnow on B\n', memory.projects.version);
  assert.equal(version, memory.projects.version + 1);

  assert.deepEqual(snapshot(homeA), beforeA, 'home A sources byte-identical');
  assert.deepEqual(snapshot(homeB), beforeB, 'home B sources byte-identical');
});

// ---------------------------------------------------------------------------------------------
// LocalPmStore
// ---------------------------------------------------------------------------------------------

const IDENTITY = { machine_id: '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', name: 'laptop' };

test('local store: first open imports once into pm/state.json (0600); always active at epoch 1', async (t) => {
  const dir = tempHome(t);
  seed(dir, { projects: '# P\n## one\n', log: '- first line\n- second line\n', settings: '{"model":"claude-opus-4-5"}' });
  const before = snapshot(dir);
  const logs: string[] = [];
  const store = new LocalPmStore({ identity: IDENTITY, home: dir, log: (l) => logs.push(l) });
  assert.equal(store.mode, 'local');
  assert.deepEqual(store.assignment(), { active: true, connected: true, epoch: 1, activeHost: 'laptop' });
  assert.equal(await store.ensureImported(), 'imported');
  const memory = await store.read();
  assert.equal(memory.initialized, true);
  assert.equal(memory.projects.content, '# P\n## one\n'); assert.equal(memory.projects.version, 1);
  assert.deepEqual(memory.log.map((e) => [e.seq, e.text]), [[1, 'first line'], [2, 'second line']]);
  assert.equal(memory.model, 'claude-opus-4-5');
  assert.deepEqual(memory.preferences, { content: '', version: 0, updated_at: '' });
  const file = join(dir, 'pm/state.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(dir, 'memory/.imported.json'), 'utf8')).target, 'local');
  assert.deepEqual(snapshot(dir), before);
  assert.ok(!readFileSync(file, 'utf8').includes('TRANSCRIPT-MUST-NOT-MOVE'));

  // Once only: edits to the source file after the import are not re-imported.
  writeFileSync(join(dir, 'memory/PROJECTS.md'), '# changed later\n');
  const reopened = new LocalPmStore({ identity: IDENTITY, home: dir, log: () => {} });
  assert.equal(await reopened.ensureImported(), 'already_initialized');
  assert.equal((await reopened.read()).projects.content, '# P\n## one\n');
});

test('local store: version CAS, edit-exactly-once, limits, and log trim match the DO semantics', async (t) => {
  const dir = tempHome(t);
  const store = new LocalPmStore({ identity: IDENTITY, home: dir, log: () => {} });
  const { version } = await store.write('preferences', 'terse answers', 0);
  assert.equal(version, 1);
  await assert.rejects(store.write('preferences', 'stale', 0), code('version_conflict'));
  await assert.rejects(store.write('preferences', 'x'.repeat(8 * 1024 + 1), 1), code('too_large'));
  assert.equal((await store.edit('preferences', 'terse', 'short', 1)).version, 2);
  await store.write('projects', 'a b a', 0);
  await assert.rejects(store.edit('projects', 'a', 'c', 1), code('invalid'), 'old_text occurring twice');
  await assert.rejects(store.edit('projects', 'zzz', 'c', 1), code('invalid'), 'old_text missing');
  await assert.rejects(store.log('hi'), code('invalid'));
  await assert.rejects(store.log('x'.repeat(501)), code('too_large'));
  await store.setModel('claude-sonnet-4-5');
  await assert.rejects(store.setModel('bad model!'), code('invalid'));
  const reopened = new LocalPmStore({ identity: IDENTITY, home: dir, log: () => {} });
  const memory = await reopened.read();
  assert.equal(memory.preferences.content, 'short answers'); assert.equal(memory.model, 'claude-sonnet-4-5');

  // Newest 2000 kept; read returns the newest 200.
  const state = JSON.parse(readFileSync(join(dir, 'pm/state.json'), 'utf8'));
  state.log = Array.from({ length: 2000 }, (_, i) => ({ seq: i + 1, at: AT, text: `entry ${i + 1}` })); state.next_seq = 2001;
  writeFileSync(join(dir, 'pm/state.json'), JSON.stringify(state));
  const full = new LocalPmStore({ identity: IDENTITY, home: dir, log: () => {} });
  await full.log('entry 2001'); await full.log('entry 2002');
  const kept = JSON.parse(readFileSync(join(dir, 'pm/state.json'), 'utf8')).log;
  assert.equal(kept.length, 2000); assert.equal(kept[0].seq, 3); assert.equal(kept.at(-1).text, 'entry 2002');
  const read = await full.read();
  assert.equal(read.log.length, 200); assert.equal(read.log[0]!.seq, 1803);
});

test('local store: open turns persist and return once as uncertain (restarted) after a restart', async (t) => {
  const dir = tempHome(t);
  const first = new LocalPmStore({ identity: IDENTITY, home: dir, log: () => {} });
  await first.beginTurn('turn-1', AT);
  await first.beginTurn('turn-2', AT);
  await first.endTurn('turn-2', 'completed');
  await first.endTurn('unknown-turn', 'failed'); // unknown id is fine
  assert.deepEqual(first.openTurnIds(), ['turn-1']);
  await first.beginTurn('turn-1', AT); // a repeated begin of an open turn is acknowledged again (as the DO)
  assert.deepEqual(first.openTurnIds(), ['turn-1']);
  await assert.rejects(first.beginTurn('bad id', AT), code('invalid'));
  assert.deepEqual(first.uncertainTurns(), []);
  // Simulated daemon restart: a new store over the same file.
  const second = new LocalPmStore({ identity: IDENTITY, home: dir, log: () => {} });
  assert.deepEqual(second.openTurnIds(), []);
  assert.deepEqual(second.uncertainTurns(), [{ turn_id: 'turn-1', accepted_at: AT, host: 'laptop', reason: 'restarted' }]);
  const heard = await new Promise<UncertainTurn[]>((resolve) => second.onAssignment((_a, uncertain) => resolve(uncertain)));
  assert.deepEqual(heard.map((u) => u.turn_id), ['turn-1']);
  await assert.rejects(second.beginTurn('turn-1', AT), code('invalid'), 'an id already reported uncertain');
  await second.endTurn('turn-1', 'completed');
  assert.deepEqual(second.uncertainTurns().map((u) => u.turn_id), ['turn-1'], 'turn.end deletes only open rows');
  await second.ackUncertain(['turn-1']);
  const third = new LocalPmStore({ identity: IDENTITY, home: dir, log: () => {} });
  assert.deepEqual(third.uncertainTurns(), [], 'reported exactly once');
});

test('local store: a 65th open turn is unavailable (as the DO)', async (t) => {
  const store = new LocalPmStore({ identity: IDENTITY, home: tempHome(t), log: () => {} });
  for (let i = 0; i < 64; i++) await store.beginTurn(`turn-${i}`, AT);
  await assert.rejects(store.beginTurn('turn-64', AT), code('unavailable'));
  assert.equal(store.openTurnIds().length, 64);
  await store.endTurn('turn-0', 'completed');
  await store.beginTurn('turn-64', AT);
});

test('createPmStore: local without a bridge; a corrupt pm/state.json fails closed and is left alone', (t) => {
  const dir = tempHome(t);
  const store = createPmStore({ identity: IDENTITY, home: dir, log: () => {} });
  assert.ok(store instanceof LocalPmStore);
  writeFileSync(join(dir, 'pm/state.json'), '{"version":1, broken');
  assert.throws(() => new LocalPmStore({ identity: IDENTITY, home: dir, log: () => {} }), /Invalid pm\/state.json/);
  assert.equal(readFileSync(join(dir, 'pm/state.json'), 'utf8'), '{"version":1, broken');
});

// ---------------------------------------------------------------------------------------------
// #117: local-only ↔ relay transitions
// ---------------------------------------------------------------------------------------------

const LEGACY = { projects: '# Legacy projects\n', log: '- legacy line one\n', settings: '{"model":"claude-opus-4-5"}' };

/** A home that ran local-only: legacy files imported into pm/state.json, then the PM learned more there. */
async function localOnlyHome(t: test.TestContext, name = 'machine-a') {
  const dir = tempHome(t);
  seed(dir, LEGACY);
  const identity = loadMachineIdentity({ home: dir, env: { FOREMAN_MACHINE_NAME: name } });
  const local = new LocalPmStore({ identity, home: dir, log: () => {} });
  await local.write('projects', '# Projects learned locally\n## foreman\n', 1);
  await local.write('preferences', 'terse answers', 0);
  await local.log('decided locally');
  await local.setModel('claude-sonnet-4-5');
  local.close();
  return { dir, identity };
}

const stateFile = (dir: string) => join(dir, 'pm/state.json');
const fileState = (path: string) => ({ bytes: readFileSync(path).toString('base64'), mtime: statSync(path).mtimeMs, mode: statSync(path).mode });

test('#117 local-only → relay: an empty relay imports pm/state.json (projects, preferences, log, model), not the legacy files', async (t) => {
  const { dir } = await localOnlyHome(t);
  const before = fileState(stateFile(dir));
  const legacyBefore = snapshot(dir);
  const relay = new FakeRelay();
  const h = relayHost(t, relay, dir, 'machine-a');
  await h.connect();
  assert.equal(await h.store.ensureImported(), 'imported');
  assert.equal(relay.imports.length, 1);
  assert.deepEqual(relay.imports[0], {
    projects: '# Projects learned locally\n## foreman\n', log: ['legacy line one', 'decided locally'], model: 'claude-sonnet-4-5', source_machine: h.identity.machine_id,
  });
  const memory = await h.store.read();
  assert.equal(memory.preferences.content, 'terse answers', 'preferences follow as the first write of the empty doc');
  assert.equal(memory.projects.content, '# Projects learned locally\n## foreman\n');
  assert.ok(h.logs.some((l) => l.includes('from pm/state.json')), h.logs.join('\n'));
  assert.deepEqual(fileState(stateFile(dir)), before, 'pm/state.json is only read');
  assert.deepEqual(snapshot(dir), legacyBefore, 'legacy files untouched');
  assert.equal(JSON.parse(readFileSync(join(dir, 'memory/.imported.json'), 'utf8')).target, 'relay');
  const mode = JSON.parse(readFileSync(join(dir, 'memory/.pm-mode.json'), 'utf8'));
  assert.equal(mode.mode, 'relay'); assert.equal(mode.machine_id, h.identity.machine_id);
  assert.equal(statSync(join(dir, 'memory/.pm-mode.json')).mode & 0o777, 0o600);
});

test('#117 local-only → relay: a relay that already has memory wins; pm/state.json stays byte-identical', async (t) => {
  const { dir } = await localOnlyHome(t);
  const before = fileState(stateFile(dir));
  const relay = new FakeRelay();
  relay.memory.initialized = true; relay.memory.projects = { content: '# Theirs\n', version: 4, updated_at: AT };
  const h = relayHost(t, relay, dir, 'machine-a');
  await h.connect();
  assert.equal(await h.store.ensureImported(), 'already_initialized');
  assert.equal(relay.rpcs().filter((f) => f.op === 'memory.import' || f.op === 'memory.put').length, 0, 'nothing sent, nothing merged');
  assert.equal(relay.memory.projects.content, '# Theirs\n');
  assert.deepEqual(fileState(stateFile(dir)), before, 'never modified, renamed or deleted');
  assert.equal(JSON.parse(readFileSync(join(dir, 'memory/.imported.json'), 'utf8')).target, 'local', 'the earlier local import marker is kept as is');
  assert.equal(JSON.parse(readFileSync(join(dir, 'memory/.pm-mode.json'), 'utf8')).mode, 'relay', 'this machine now uses relay memory');
});

test('#117 local-only → relay: without pm/state.json the legacy import is unchanged', async (t) => {
  const dir = tempHome(t);
  seed(dir, LEGACY);
  const relay = new FakeRelay();
  const h = relayHost(t, relay, dir, 'machine-a');
  await h.connect();
  assert.equal(await h.store.ensureImported(), 'imported');
  assert.deepEqual(relay.imports[0], readImportPayload(dir, h.identity.machine_id, () => {}));
  assert.deepEqual(relay.imports[0].log, ['legacy line one']);
  assert.equal(relay.rpcs().filter((f) => f.op === 'memory.put').length, 0);
  assert.equal(existsSync(stateFile(dir)), false, 'relay mode creates no pm/state.json');
  assert.ok(h.logs.some((l) => l.includes('from memory/PROJECTS.md and memory/LOG.md')), h.logs.join('\n'));
  assert.equal(JSON.parse(readFileSync(join(dir, 'memory/.pm-mode.json'), 'utf8')).mode, 'relay');
});

test('#117 local-only → relay: a corrupt, invalid or symlinked pm/state.json is not imported; legacy files are, with a notice', async (t) => {
  for (const kind of ['corrupt', 'invalid', 'symlink'] as const) {
    const dir = tempHome(t);
    seed(dir, LEGACY);
    let expected: string;
    if (kind === 'corrupt') { expected = '{"version":1, broken'; writeFileSync(stateFile(dir), expected); }
    else if (kind === 'invalid') { expected = JSON.stringify({ version: 1, initialized: true, docs: {}, log: [], next_seq: 1, model: null, turns: [] }); writeFileSync(stateFile(dir), expected); }
    else {
      // A valid local state elsewhere, reached through a symlink: never followed.
      const { dir: other } = await localOnlyHome(t, 'machine-z');
      symlinkSync(stateFile(other), stateFile(dir));
      expected = readFileSync(stateFile(other), 'utf8');
    }
    const relay = new FakeRelay();
    const h = relayHost(t, relay, dir, 'machine-a');
    await h.connect();
    assert.equal(await h.store.ensureImported(), 'imported', kind);
    assert.equal(relay.imports[0].projects, '# Legacy projects\n', kind);
    assert.deepEqual(relay.imports[0].log, ['legacy line one'], kind);
    assert.equal(relay.imports[0].model, 'claude-opus-4-5', kind);
    assert.equal(relay.memory.preferences.content, '', kind);
    assert.ok(h.logs.some((l) => /pm\/state\.json is (invalid|not a regular file); not importing it/.test(l)), `${kind}: ${h.logs.join('\n')}`);
    assert.equal(readFileSync(stateFile(dir), 'utf8'), expected, `${kind}: left untouched`);
    if (kind === 'symlink') assert.ok(lstatSync(stateFile(dir)).isSymbolicLink(), 'the symlink is left in place');
    h.store.close(); h.bridge.close();
  }
});

test('#117 relay → local-only: the local store keeps pm/state.json and logs that relay memory is not merged', async (t) => {
  const { dir, identity } = await localOnlyHome(t);
  // This machine then ran in relay mode (the relay already had memory: nothing imported).
  const relay = new FakeRelay();
  relay.memory.initialized = true; relay.memory.projects = { content: '# Relay memory\n', version: 7, updated_at: AT };
  const h = relayHost(t, relay, dir, 'machine-a');
  await h.connect();
  assert.equal(await h.store.ensureImported(), 'already_initialized');
  h.store.close(); h.bridge.close();
  const before = readFileSync(stateFile(dir), 'utf8');

  // Back to local-only (no relay configured): every start says so, and memory is the local file's.
  for (let start = 0; start < 2; start++) {
    const logs: string[] = [];
    const local = createPmStore({ identity, home: dir, log: (l) => logs.push(l) });
    assert.ok(local instanceof LocalPmStore);
    assert.ok(logs.some((l) => l.includes(RELAY_MEMORY_NOT_MERGED_NOTICE)), logs.join('\n'));
    const memory = await local.read();
    assert.equal(memory.projects.content, '# Projects learned locally\n## foreman\n', 'local memory, not the relay memory');
    assert.equal(memory.preferences.content, 'terse answers');
    assert.equal(await local.ensureImported(), 'already_initialized', 'nothing re-imported');
    local.close();
  }
  assert.equal(readFileSync(stateFile(dir), 'utf8'), before);
  assert.equal(relay.memory.projects.content, '# Relay memory\n', 'the relay is not touched either');
});

test('#117 relay → local-only without pm/state.json: legacy files are imported once as today, with the notice', async (t) => {
  const dir = tempHome(t);
  seed(dir, LEGACY);
  const relay = new FakeRelay();
  relay.memory.initialized = true;
  const h = relayHost(t, relay, dir, 'machine-a');
  await h.connect();
  assert.equal(await h.store.ensureImported(), 'already_initialized');
  h.store.close(); h.bridge.close();
  const logs: string[] = [];
  const local = new LocalPmStore({ identity: h.identity, home: dir, log: (l) => logs.push(l) });
  assert.equal(await local.ensureImported(), 'imported');
  assert.equal((await local.read()).projects.content, '# Legacy projects\n');
  assert.ok(logs.some((l) => l.includes(RELAY_MEMORY_NOT_MERGED_NOTICE)), logs.join('\n'));
});

test('#117 a machine that never used relay memory logs no relay notice in local-only mode', (t) => {
  const dir = tempHome(t);
  const logs: string[] = [];
  new LocalPmStore({ identity: IDENTITY, home: dir, log: (l) => logs.push(l) }).close();
  new LocalPmStore({ identity: IDENTITY, home: dir, log: (l) => logs.push(l) }).close();
  assert.ok(!logs.some((l) => l.includes('cloud relay')), logs.join('\n'));
});
