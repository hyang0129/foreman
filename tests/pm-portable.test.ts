// Two-machine evidence at the PM level (epic #26, PMM-05). Two temp FOREMAN_HOMEs, each with a real
// HostBridge + RelayPmStore + ProjectManager, share one fake relay with the DO's semantics (copied
// from tests/pm-store.test.ts: assignment + epoch fencing, import once, turn records, restarted /
// reassigned / host_lost reconciliation). Only the provider is scripted: it answers from the
// memory block the PM injected into its system prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isHelloV2, parseHello, parsePmRpc, pmRpcError, pmRpcOk, type LogEntry } from '../shared/pm-state.ts';

// server/paths.ts reads FOREMAN_HOME at import: pin it to a temp dir before loading any server module.
const root = mkdtempSync(join(tmpdir(), 'foreman-pm-portable-'));
process.env.FOREMAN_HOME = join(root, 'process-home');
test.after(() => rmSync(root, { recursive: true, force: true }));
const { HostBridge } = await import('../server/host-bridge.ts');
const { loadMachineIdentity } = await import('../server/machine.ts');
const { LocalPmStore, RelayPmStore } = await import('../server/pm-store.ts');
const { ProjectManager, choosePmStore } = await import('../server/pm.ts');

const TOKEN = 'synthetic-test-host-credential'.repeat(2);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(check: () => boolean, label = 'condition') { for (let i = 0; i < 400 && !check(); i++) await tick(); assert.ok(check(), `${label} not reached`); }

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: any[] = [];
  open() { this.readyState = 1; this.emit('open'); }
  send(raw: string) { const value = JSON.parse(raw); this.sent.push(value); this.emit('sent', value); }
  receive(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}

type Turn = { machine_id: string; epoch: number; accepted_at: string; state: 'open' | 'uncertain'; reason: 'restarted' | 'reassigned' | 'host_lost' | null };

/** The fake relay DO of tests/pm-store.test.ts (same semantics), trimmed to what these tests drive. */
class FakeRelay {
  assignment: { machine_id: string; epoch: number } | null = null;
  machines = new Map<string, { name: string; socket: FakeSocket | null }>();
  memory = { initialized: false, projects: { content: '', version: 0, updated_at: '' }, preferences: { content: '', version: 0, updated_at: '' }, log: [] as LogEntry[], seq: 0, model: null as string | null };
  turns = new Map<string, Turn>();
  frames: { machine_id: string | null; frame: any }[] = [];
  imports: any[] = [];
  /** Frames lost in transit: recorded as sent, never applied or answered. */
  swallow: ((frame: any) => boolean) | null = null;

  attach(socket: FakeSocket) { socket.on('sent', (frame) => this.receive(socket, frame)); }
  machineOf(socket: FakeSocket) { for (const [id, m] of this.machines) if (m.socket === socket) return id; return null; }
  private send(socket: FakeSocket, frame: unknown) { queueMicrotask(() => { if (socket.readyState === 1) socket.receive(frame); }); }
  hellos(machineId: string) { return this.frames.filter((f) => f.frame.type === 'hello' && f.frame.machine_id === machineId).map((f) => f.frame); }
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
    if (!parsed.ok) { if (parsed.id) this.send(socket, pmRpcError(parsed.id, parsed.code, parsed.error)); return; }
    const rpc = parsed.value;
    const machine = this.machineOf(socket)!;
    let result;
    if (!this.assignment || rpc.epoch !== this.assignment.epoch) result = pmRpcError(rpc.id, 'stale_epoch', `epoch ${rpc.epoch} is not current`);
    else if (machine !== this.assignment.machine_id) result = pmRpcError(rpc.id, 'not_active', 'not the active PM host');
    else result = this.apply(rpc, machine);
    this.send(socket, result);
  }
  private apply(rpc: any, machine: string) {
    const m = this.memory, now = new Date().toISOString(), a = rpc.args;
    switch (rpc.op) {
      case 'memory.get': return pmRpcOk(rpc.id, rpc.op, { initialized: m.initialized, docs: { projects: { ...m.projects }, preferences: { ...m.preferences } }, log: m.log.slice(-200), settings: { model: m.model } });
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
        const existing = this.turns.get(a.turn_id);
        if (existing) return existing.state === 'open' && existing.machine_id === machine ? pmRpcOk(rpc.id, rpc.op, {}) : pmRpcError(rpc.id, 'invalid', 'turn_id is already recorded');
        this.turns.set(a.turn_id, { machine_id: machine, epoch: rpc.epoch, accepted_at: a.accepted_at, state: 'open', reason: null });
        return pmRpcOk(rpc.id, rpc.op, {});
      }
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
  /** Developer reassignment (POST /api/pm/host). */
  reassign(machineId: string) {
    const old = this.assignment!;
    const oldOnline = Boolean(this.machines.get(old.machine_id)?.socket);
    for (const turn of this.turns.values()) if (turn.state === 'open') { turn.state = 'uncertain'; turn.reason = oldOnline ? 'reassigned' : 'host_lost'; }
    this.assignment = { machine_id: machineId, epoch: old.epoch + 1 };
    for (const [, m] of this.machines) if (m.socket) this.send(m.socket, this.assignmentFor([...this.machines].find(([, x]) => x === m)![0]));
  }
}

type Launch = { closed: boolean; consumed: string[]; prompt: string; options: any };

/**
 * One daemon on one FOREMAN_HOME: bridge, relay store and PM, wired as server/main.ts wires them.
 * The provider answers "what is <project> blocked on?" from the memory block in its system prompt,
 * and holds any input containing HOLD until `release()` (or until it is closed).
 */
function daemon(t: any, relay: FakeRelay, dir: string, name: string, options: { rpcTimeoutMs?: number; autoStart?: boolean } = {}) {
  const identity = loadMachineIdentity({ home: dir, env: { FOREMAN_MACHINE_NAME: name } });
  const sockets: FakeSocket[] = [];
  let store: InstanceType<typeof RelayPmStore> | undefined;
  const bridge = new HostBridge(4177, { url: 'https://foreman.example', token: TOKEN }, {
    identity, platform: 'darwin', rpcTimeoutMs: options.rpcTimeoutMs,
    pmOpenTurns: () => store?.openTurnIds() ?? [],
    socketFactory: () => { const socket = new FakeSocket(); relay.attach(socket); sockets.push(socket); return socket as any; },
  });
  store = new RelayPmStore(bridge, { identity, home: dir, log: () => {} });
  const pm = new ProjectManager({} as any, { machineName: name });
  const launches: Launch[] = [];
  let releaseHeld: (() => void) | null = null;
  (pm as any).queryFactory = ({ prompt, options }: any) => {
    const launch: Launch = { closed: false, consumed: [], prompt: options.systemPrompt.append, options };
    launches.push(launch);
    let close!: () => void; const closed = new Promise<void>((r) => { close = r; });
    return {
      close: () => { launch.closed = true; close(); },
      interrupt: async () => {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: `${name}-session-${launches.length}`, tools: [] };
        while (true) {
          const input = await Promise.race([prompt.next(), closed.then(() => null)]);
          if (!input || input.done) return;
          const text: string = input.value.message.content;
          launch.consumed.push(text);
          if (text.includes('HOLD')) {
            const released = await Promise.race([new Promise<boolean>((r) => { releaseHeld = () => r(true); }), closed.then(() => false)]);
            if (!released) return;
          }
          const project = /what is ([\w-]+) blocked on/i.exec(text)?.[1];
          const section = project ? new RegExp(`## ${project}\\n([^\\n]*)`).exec(launch.prompt)?.[1] : undefined;
          const answer = project ? `From memory: ${section ?? 'nothing recorded'}` : `done: ${text}`;
          yield { type: 'assistant', message: { content: [{ type: 'text', text: answer }] } };
          yield { type: 'result', is_error: false, subtype: 'success', result: answer, user_message_uuids: [input.value.uuid] };
        }
      },
    };
  };
  pm.attach(store, { bridge, autoStart: options.autoStart });
  bridge.start();
  const h = {
    name, identity, bridge, store, pm, sockets, launches,
    release() { releaseHeld?.(); },
    async connect() { sockets.at(-1)!.open(); await tick(); },
    drop() { sockets.at(-1)!.close(); clearTimeout((bridge as any).reconnect); },
    async reconnect() { (bridge as any).connect(); sockets.at(-1)!.open(); await tick(); },
    /** The daemon process dies: nothing is flushed or ended. */
    kill() { pm.close(); store!.close(); bridge.close(); },
    answers() { return pm.history().filter((e) => e.role === 'assistant').map((e) => e.text); },
    uncertain() { return pm.history().filter((e) => e.error && /could not be confirmed/.test(e.text ?? '')).map((e) => e.text); },
    tool(name: string) { return (launches.at(-1)!.options.mcpServers.fleet.instance as any)._registeredTools[name].handler; },
  };
  t.after(() => h.kill());
  return h;
}

function home(name: string, projects?: string) {
  const dir = mkdtempSync(join(root, `${name}-`));
  mkdirSync(join(dir, 'memory'), { recursive: true }); mkdirSync(join(dir, 'pm'), { recursive: true });
  if (projects !== undefined) writeFileSync(join(dir, 'memory/PROJECTS.md'), projects);
  return dir;
}

test('two machines: A answers from imported memory, a move closes A (sends name B), B starts fresh with one uncertain entry and A\'s memory', { timeout: 20_000 }, async (t) => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const relay = new FakeRelay();
  const homeA = home('machine-a', '# Projects\n\n## zebra-project\nStatus: blocked on CANARY_IMPORTED_ON_A\n');
  const homeB = home('machine-b', '# Projects\n\n## zebra-project\nStatus: B-LOCAL-FILES-MUST-NOT-WIN\n');
  const A = daemon(t, relay, homeA, 'machine-a');
  await A.connect();
  await until(() => A.launches.length === 1, 'A started its PM');
  assert.equal(relay.imports.length, 1, 'A imported its file memory once');

  // A is active and answers from memory.
  await A.pm.send('What is zebra-project blocked on?');
  await until(() => A.answers().length === 1);
  assert.equal(A.answers()[0], 'From memory: Status: blocked on CANARY_IMPORTED_ON_A');

  // The PM on A records a learning through its memory tool (the handoff).
  const read = JSON.parse((await A.tool('memory_read')({})).content[0].text);
  const written = await A.tool('memory_write')({ doc: 'projects', content: '## zebra-project\nStatus: blocked on CANARY_WRITTEN_ON_A\n', expected_version: read.projects.version });
  assert.equal(written.isError, undefined, JSON.stringify(written));

  // B connects as a standby: its PM does not run and refuses sends, naming A.
  const B = daemon(t, relay, homeB, 'machine-b');
  await B.connect();
  await tick();
  assert.equal(B.launches.length, 0);
  await assert.rejects(B.pm.send('hello?'), /^Error: The PM runs on machine-a\.$/);

  // A has a turn in flight when the developer moves the PM.
  await A.pm.send('HOLD: a long request');
  await until(() => A.launches[0]!.consumed.length === 2);
  const inFlight = A.pm.outstandingTurnIds()[0]!;
  assert.equal(relay.turns.get(inFlight)?.state, 'open');
  relay.reassign(B.identity.machine_id);
  await until(() => A.launches[0]!.closed, 'A closed its PM');
  await until(() => B.launches.length === 1, 'B started a fresh PM');

  // A: the PM is closed, sends are refused naming B, and the in-flight turn is not reported here.
  await assert.rejects(A.pm.send('still here?'), /The PM runs on machine-b\./);
  A.release(); await tick();
  assert.equal(A.uncertain().length, 0);
  assert.equal(A.answers().length, 1, 'the closed provider reports nothing after the move');
  assert.match(A.pm.history().at(-1)!.text!, /now runs on machine-b/);

  // B: an empty conversation plus exactly one uncertain entry, acknowledged.
  await until(() => !relay.turns.has(inFlight), 'B acknowledged the uncertain turn');
  const history = B.pm.history();
  assert.equal(history.length, 1);
  assert.match(history[0]!.text!, /^Your message sent at \d{4}-\d\d-\d\d \d\d:\d\d UTC to the PM on machine-a could not be confirmed \(the PM was moved\)\. It was not replayed\.$/);
  assert.equal(history[0]!.error, true);
  assert.equal(B.pm.lastError, history[0]!.text);
  assert.deepEqual(B.launches[0]!.consumed, [], 'nothing is replayed on B');
  assert.equal('resume' in B.launches[0]!.options, false);

  // B's fresh session was given the memory written on A (not B's own files, which are never imported now).
  assert.match(B.launches[0]!.prompt, /Status: blocked on CANARY_WRITTEN_ON_A/);
  assert.doesNotMatch(B.launches[0]!.prompt, /B-LOCAL-FILES-MUST-NOT-WIN/);
  assert.equal(relay.imports.length, 1);
  await B.pm.send('What is zebra-project blocked on?');
  await until(() => B.answers().length === 1);
  assert.equal(B.answers()[0], 'From memory: Status: blocked on CANARY_WRITTEN_ON_A');
  assert.equal(B.pm.lastError, null);

  // A later assignment re-delivery on B does not show the entry again.
  B.drop(); await B.reconnect();
  await tick();
  assert.equal(B.uncertain().length, 1);

  // Moving the PM back to A starts A with an empty conversation and a fresh session again.
  assert.ok(A.pm.history().length > 0);
  relay.reassign(A.identity.machine_id);
  await until(() => A.launches.length === 2, 'A started a fresh PM');
  await until(() => B.launches[0]!.closed, 'B closed its PM');
  assert.deepEqual(A.pm.history(), [], 'nothing was in flight on B, so A starts empty');
  assert.equal(A.pm.lastError, null);
  assert.match(A.launches[1]!.prompt, /CANARY_WRITTEN_ON_A/);
  await assert.rejects(B.pm.send('still B?'), /The PM runs on machine-a\./);

  // Neither home got a transcript or a session file.
  for (const dir of [homeA, homeB]) assert.deepEqual(readdirSync(join(dir, 'pm')).filter((f) => f !== 'settings.json'), []);
});

test('a machine lost mid-turn: the move reports host_lost once on the new host', { timeout: 20_000 }, async (t) => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const relay = new FakeRelay();
  const A = daemon(t, relay, home('machine-a', '## p\nx\n'), 'machine-a');
  await A.connect(); await until(() => A.launches.length === 1);
  const B = daemon(t, relay, home('machine-b'), 'machine-b');
  await B.connect();
  await A.pm.send('HOLD: work'); await until(() => A.launches[0]!.consumed.length === 1);
  A.kill(); // kill -9: the socket closes, nothing is ended
  relay.reassign(B.identity.machine_id);
  await until(() => B.launches.length === 1);
  await until(() => relay.turns.size === 0);
  assert.equal(B.uncertain().length, 1);
  assert.match(B.uncertain()[0]!, /to the PM on machine-a could not be confirmed \(machine went offline\)\. It was not replayed\./);
});

test('a restart of B with an open turn: one "Foreman restarted" entry after the restart, and no replay', { timeout: 20_000 }, async (t) => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const relay = new FakeRelay();
  const dirB = home('machine-b', '## p\nx\n');
  const B = daemon(t, relay, dirB, 'machine-b');
  await B.connect(); await until(() => B.launches.length === 1);
  await B.pm.send('HOLD: long request'); await until(() => B.launches[0]!.consumed.length === 1);
  const turn = B.pm.outstandingTurnIds()[0]!;
  B.kill(); // the daemon restarts: same FOREMAN_HOME, so the same machine_id
  const B2 = daemon(t, relay, dirB, 'machine-b');
  assert.equal(B2.identity.machine_id, B.identity.machine_id);
  await B2.connect();
  await until(() => B2.launches.length === 1);
  await until(() => !relay.turns.has(turn), 'acknowledged');
  assert.deepEqual(B2.uncertain(), [B2.pm.history()[0]!.text]);
  assert.match(B2.uncertain()[0]!, /to the PM on machine-b could not be confirmed \(Foreman restarted\)\. It was not replayed\./);
  await tick(); await tick();
  assert.deepEqual(B2.launches[0]!.consumed, [], 'not replayed');
  // A second restart shows nothing: the entry was acknowledged.
  B2.kill();
  const B3 = daemon(t, relay, dirB, 'machine-b');
  await B3.connect(); await until(() => B3.launches.length === 1);
  assert.equal(B3.uncertain().length, 0);
});

test('a socket blip on B mid-turn: sends are refused while disconnected, the turn finishes, and nothing is uncertain', { timeout: 20_000 }, async (t) => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const relay = new FakeRelay();
  const B = daemon(t, relay, home('machine-b', '## p\nx\n'), 'machine-b');
  await B.connect(); await until(() => B.launches.length === 1);
  await B.pm.send('HOLD: long request'); await until(() => B.launches[0]!.consumed.length === 1);
  const turn = B.pm.outstandingTurnIds()[0]!;
  B.drop();
  await tick();
  await assert.rejects(B.pm.send('while offline'), /^Error: The cloud relay is unreachable; the PM is unavailable on this machine\.$/);
  // The running turn finishes while the socket is down; its end is queued.
  B.release();
  await until(() => B.answers().length === 1);
  assert.equal(relay.turns.get(turn)?.state, 'open');
  await B.reconnect();
  const hello = relay.hellos(B.identity.machine_id).at(-1);
  assert.deepEqual(hello.pm_open_turns, [turn], 'the reconnect hello lists the turn still owed an end');
  await until(() => !relay.turns.has(turn), 'the queued end flushed');
  assert.equal(B.uncertain().length, 0);
  assert.equal(B.launches.length, 1, 'the PM kept running through the blip');
  assert.equal(B.launches[0]!.closed, false);
  assert.equal(B.pm.history().filter((e) => e.role === 'user').length, 1, 'the conversation was kept');
  await B.pm.send('after the blip'); await until(() => B.answers().length === 2);
});

test('a duplicate delivery of an uncertain turn (its ack lost) is shown once and acknowledged again', { timeout: 20_000 }, async (t) => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const relay = new FakeRelay();
  const dirB = home('machine-b', '## p\nx\n');
  const B = daemon(t, relay, dirB, 'machine-b');
  await B.connect(); await until(() => B.launches.length === 1);
  await B.pm.send('HOLD: work'); await until(() => B.launches[0]!.consumed.length === 1);
  const turn = B.pm.outstandingTurnIds()[0]!;
  B.kill();
  relay.swallow = (frame) => frame.op === 'turn.ack_uncertain'; // the first ack is lost in transit
  const B2 = daemon(t, relay, dirB, 'machine-b', { rpcTimeoutMs: 100 });
  await B2.connect(); await until(() => B2.uncertain().length === 1);
  await until(() => relay.frames.some((f) => f.frame.op === 'turn.ack_uncertain'));
  assert.equal(relay.turns.get(turn)?.state, 'uncertain');
  relay.swallow = null;
  B2.drop(); await B2.reconnect(); // the relay re-sends the unacknowledged turn
  await until(() => !relay.turns.has(turn), 'acknowledged on the second delivery');
  assert.equal(B2.uncertain().length, 1, 'shown once');
  assert.ok(relay.frames.filter((f) => f.frame.op === 'turn.ack_uncertain').length >= 2);
});

test('#116: an uncertain entry whose ack was lost is not shown again after a restart', { timeout: 20_000 }, async (t) => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const relay = new FakeRelay();
  const dirB = home('machine-b', '## p\nx\n');
  const B = daemon(t, relay, dirB, 'machine-b');
  await B.connect(); await until(() => B.launches.length === 1);
  await B.pm.send('HOLD: work'); await until(() => B.launches[0]!.consumed.length === 1);
  const turn = B.pm.outstandingTurnIds()[0]!;
  B.kill();
  relay.swallow = (frame) => frame.op === 'turn.ack_uncertain'; // the ack is lost in transit
  const B2 = daemon(t, relay, dirB, 'machine-b', { rpcTimeoutMs: 100 });
  await B2.connect(); await until(() => B2.uncertain().length === 1, 'shown after the first restart');
  await until(() => relay.frames.some((f) => f.frame.op === 'turn.ack_uncertain'));
  B2.kill(); // restarts again before the ack is retried
  relay.swallow = null;
  assert.equal(relay.turns.get(turn)?.state, 'uncertain', 'the relay still holds it');
  const B3 = daemon(t, relay, dirB, 'machine-b');
  await B3.connect(); await until(() => B3.launches.length === 1);
  await until(() => !relay.turns.has(turn), 'acknowledged by the next run');
  assert.equal(B3.uncertain().length, 0, 'not shown a second time');
});

test('#116: a send whose begin failed (503, never dispatched) leaves no uncertain entry after a restart', { timeout: 20_000 }, async (t) => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const relay = new FakeRelay();
  const dirB = home('machine-b', '## p\nx\n');
  const B = daemon(t, relay, dirB, 'machine-b', { rpcTimeoutMs: 100 });
  await B.connect(); await until(() => B.launches.length === 1);
  // The relay records the turn but its ack never arrives; the failed end is lost too.
  let turnId = '';
  relay.swallow = (frame) => {
    if (frame.op === 'turn.end') return true;
    if (frame.op !== 'turn.begin') return false;
    const parsed = parsePmRpc(frame);
    assert.ok(parsed.ok);
    turnId = frame.args.turn_id;
    (relay as any).apply(parsed.value, B.identity.machine_id);
    return true;
  };
  await assert.rejects(B.pm.send('never dispatched'), /could not record your message, so it was not sent/);
  assert.equal(relay.turns.get(turnId)?.state, 'open');
  assert.deepEqual(B.launches[0]!.consumed, [], 'not dispatched');
  B.kill(); // restart before the failed end reaches the relay
  relay.swallow = null;
  const B2 = daemon(t, relay, dirB, 'machine-b');
  await B2.connect(); await until(() => B2.launches.length === 1);
  await until(() => !relay.turns.has(turnId), 'the failed end flushed after the restart');
  await tick(); await tick();
  assert.equal(B2.uncertain().length, 0, 'no "could not be confirmed" entry for a message that was never dispatched');
});

test('local-only mode: a restart mid-turn reports one uncertain entry, with no replay', { timeout: 20_000 }, async (t) => {
  t.mock.method(console, 'error', () => {});
  const dir = home('local', '## p\nx\n');
  const identity = loadMachineIdentity({ home: dir, env: { FOREMAN_MACHINE_NAME: 'laptop' } });
  const run = (store: any) => {
    const pm = new ProjectManager({} as any, { machineName: 'laptop' });
    const consumed: string[] = [];
    let close!: () => void; const closed = new Promise<void>((r) => { close = r; });
    (pm as any).queryFactory = ({ prompt }: any) => ({ close, async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'local', tools: [] };
      while (true) { const input = await Promise.race([prompt.next(), closed.then(() => null)]); if (!input || input.done) return; consumed.push(input.value.message.content); }
    } });
    pm.attach(store);
    t.after(() => pm.close());
    return { pm, consumed };
  };
  const first = run(new LocalPmStore({ identity, home: dir, log: () => {} }));
  await first.pm.send('long request'); await until(() => first.consumed.length === 1);
  first.pm.close(); // the daemon stops mid-turn
  const store = new LocalPmStore({ identity, home: dir, log: () => {} });
  const second = run(store);
  const uncertain = second.pm.history().filter((e) => e.error);
  assert.equal(uncertain.length, 1);
  assert.match(uncertain[0]!.text!, /to the PM on laptop could not be confirmed \(Foreman restarted\)\. It was not replayed\./);
  await tick(); await tick();
  assert.deepEqual(second.consumed, []);
  assert.deepEqual(store.uncertainTurns(), [], 'acknowledged');
  const third = run(new LocalPmStore({ identity, home: dir, log: () => {} }));
  assert.equal(third.pm.history().length, 0, 'shown once');
});

// ---- #115: move races around send dispatch --------------------------------------------------

function spyEnds(h: ReturnType<typeof daemon>) {
  const ends: [string, string][] = [];
  const end = h.store.endTurn.bind(h.store);
  h.store.endTurn = (id: string, outcome: any) => { ends.push([id, outcome]); return end(id, outcome); };
  return ends;
}

test('#115: a send whose epoch changes across beginTurn (A→B→A) is not dispatched, and the relay\'s "moved" entry stands', { timeout: 20_000 }, async (t) => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const relay = new FakeRelay();
  const A = daemon(t, relay, home('machine-a', '## p\nx\n'), 'machine-a');
  await A.connect(); await until(() => A.launches.length === 1, 'A started its PM');
  const B = daemon(t, relay, home('machine-b'), 'machine-b');
  await B.connect();
  const ends = spyEnds(A);
  // The DO records the turn at epoch 1; the PM then moves to B and back to A (epoch 3) before
  // A receives the ack.
  let turnId = '';
  relay.swallow = (frame) => {
    if (frame.op !== 'turn.begin') return false;
    relay.swallow = null;
    turnId = frame.args.turn_id;
    const parsed = parsePmRpc(frame);
    assert.ok(parsed.ok);
    const ack = (relay as any).apply(parsed.value, A.identity.machine_id);
    relay.reassign(B.identity.machine_id);
    relay.reassign(A.identity.machine_id);
    setTimeout(() => A.sockets.at(-1)!.receive(ack), 50);
    return true;
  };
  await assert.rejects(A.pm.send('must not be dispatched'), /^Error: The PM was moved while your message was being sent\. It was not delivered; send it again\.$/);
  await until(() => A.launches.length === 2, 'A restarted its PM at epoch 3');
  await tick(); await tick();
  for (const launch of A.launches) assert.ok(!launch.consumed.includes('must not be dispatched'), 'never dispatched');
  assert.deepEqual(A.pm.outstandingTurnIds(), []);
  assert.equal(A.pm.history().some((e) => e.role === 'user'), false, 'not recorded as sent');
  // The relay reported it as reassigned; A shows exactly that entry, and never ends it as completed.
  assert.equal(A.uncertain().length, 1);
  assert.match(A.uncertain()[0]!, /could not be confirmed \(the PM was moved\)\. It was not replayed\./);
  assert.equal(ends.some(([id, outcome]) => id === turnId && outcome === 'completed'), false);
  await until(() => !relay.turns.has(turnId), 'A acknowledged the uncertain turn');
  // The PM keeps working at the new epoch.
  await A.pm.send('after the round trip');
  await until(() => A.answers().length === 1);
  assert.deepEqual(A.launches[1]!.consumed, ['after the round trip']);
});

test('#115: a move while the provider is being launched for a send: nothing is recorded or dispatched, the developer is told, and the new host shows no entry', { timeout: 20_000 }, async (t) => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const relay = new FakeRelay();
  // A is the PM host but its provider is not running yet: the next send launches it.
  const A = daemon(t, relay, home('machine-a', '## p\nx\n'), 'machine-a', { autoStart: false });
  await A.connect();
  await until(() => relay.imports.length === 1, 'A imported its memory');
  await tick();
  const B = daemon(t, relay, home('machine-b'), 'machine-b');
  await B.connect();
  assert.equal(A.launches.length, 0);
  // The developer moves the PM to B while A reads memory to launch the provider for this send.
  let armed = true;
  relay.swallow = (frame) => {
    if (armed && frame.op === 'memory.get') { armed = false; relay.reassign(B.identity.machine_id); }
    return false;
  };
  await assert.rejects(A.pm.send('sent during the move'), /^Error: The PM was moved to machine-b while your message was being sent\. It was not delivered; send it again there\.$/);
  assert.equal(armed, false, 'the move happened during the launch');
  await until(() => B.launches.length === 1, 'B started its PM');
  await tick(); await tick();
  assert.equal(relay.frames.some((f) => f.frame.op === 'turn.begin'), false, 'no turn was recorded for it');
  assert.equal(relay.turns.size, 0);
  assert.deepEqual(B.uncertain(), [], 'B shows no "could not be confirmed" entry for a message that was never dispatched');
  assert.deepEqual(B.pm.history(), []);
  assert.equal(A.launches.length, 0);
  assert.equal(A.pm.history().some((e) => e.role === 'user'), false);
});

test('#115: deactivation never ends an in-flight input as completed; the relay reconciles it and the new host reports it', { timeout: 20_000 }, async (t) => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const relay = new FakeRelay();
  const A = daemon(t, relay, home('machine-a', '## p\nx\n'), 'machine-a');
  await A.connect(); await until(() => A.launches.length === 1);
  const B = daemon(t, relay, home('machine-b'), 'machine-b');
  await B.connect();
  const ends = spyEnds(A);
  await A.pm.send('HOLD: in flight'); await until(() => A.launches[0]!.consumed.length === 1);
  const inFlight = A.pm.outstandingTurnIds()[0]!;
  relay.reassign(B.identity.machine_id);
  await until(() => A.launches[0]!.closed, 'A closed its PM');
  A.release(); await tick(); await tick();
  assert.deepEqual(ends, [], 'A sends no outcome for the in-flight input');
  assert.equal(relay.frames.some((f) => f.machine_id === A.identity.machine_id && f.frame.op === 'turn.end'), false);
  assert.deepEqual(A.pm.outstandingTurnIds(), []);
  await until(() => B.uncertain().length === 1, 'B reports the reassigned turn');
  assert.match(B.uncertain()[0]!, /could not be confirmed \(the PM was moved\)/);
  await until(() => !relay.turns.has(inFlight), 'B acknowledged it');
});

// Never two PMs (plan default 5): local-only mode only when no relay is configured at all. A
// present-but-invalid cloud.json (or relay env) means the relay holds the PM, so no PM runs here.
// server/main.ts uses choosePmStore; tests/pm-status-api.test.mjs drives the daemon end to end.
test('store selection: absent relay config is local; configured-but-invalid is no PM, and sends are refused with the cause', async (t) => {
  const noEnv = {};
  assert.deepEqual(choosePmStore(() => null, false, noEnv), { mode: 'local' }, 'no cloud.json: local store');
  assert.deepEqual(choosePmStore(() => ({ url: 'wss://relay', token: TOKEN }), true, noEnv), { mode: 'relay' });
  const invalid = choosePmStore(() => { throw new Error('Invalid cloud.json'); }, false, noEnv);
  assert.deepEqual(invalid, { mode: 'unavailable', reason: 'cloud.json is invalid (Invalid cloud.json); the PM is unavailable on this machine' });
  const badMode = choosePmStore(() => { throw new Error('cloud.json must be an owned regular file with mode 0600'); }, false, noEnv);
  assert.equal(badMode.mode, 'unavailable');
  const badEnv = choosePmStore(() => { throw new Error('Set both FOREMAN_RELAY_URL and FOREMAN_HOST_TOKEN'); }, false, { FOREMAN_RELAY_URL: 'wss://relay' });
  assert.match((badEnv as any).reason, /^the relay configuration \(FOREMAN_RELAY_URL\/FOREMAN_HOST_TOKEN\) is invalid \(Set both/);
  const noBridge = choosePmStore(() => ({ url: 'wss://relay', token: TOKEN }), false, noEnv);
  assert.equal(noBridge.mode, 'unavailable', 'a valid relay config whose bridge did not start never falls back to local');
  const leaked = choosePmStore(() => { throw new Error(`bad token ${'sk-ant-api03-' + 'x'.repeat(40)}`); }, false, noEnv);
  assert.ok(!(leaked as any).reason.includes('sk-ant-api03-'), 'the cause is redacted');

  // The daemon's path for an unavailable choice: a PM with no store, whose error names the cause.
  t.mock.method(console, 'error', () => {});
  const pm = new ProjectManager({} as any, { machineName: 'laptop' });
  t.after(() => pm.close());
  pm.failUnavailable((invalid as { reason: string }).reason);
  await assert.rejects(pm.send('hello'), /cloud\.json is invalid \(Invalid cloud\.json\); the PM is unavailable on this machine/);
  assert.match(pm.lastError!, /cloud\.json is invalid/);
  assert.equal(pm.history().filter((e) => e.role === 'user').length, 0, 'nothing was accepted');
});

// ---------------------------------------------------------------------------------------------
// #122 diagnostics
// ---------------------------------------------------------------------------------------------

test('#122: a failed one-time import is reported as an import failure, not as "memory could not be read"', { timeout: 20_000 }, async (t) => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const relay = new FakeRelay();
  const A = daemon(t, relay, home('machine-a', '## p\nx\n'), 'machine-a');
  // The relay refuses the import (as the DO does for an oversized frame).
  relay.swallow = (frame) => {
    if (frame.op !== 'memory.import') return false;
    queueMicrotask(() => A.sockets.at(-1)!.receive(pmRpcError(frame.id, 'too_large', 'memory.import frame is too large')));
    return true;
  };
  await A.connect();
  await until(() => A.pm.lastError !== null, 'the launch failure is reported');
  assert.match(A.pm.lastError!, /the one-time import of this machine's PM memory into the cloud relay failed, so the PM did not start \(it is retried at the next start\): memory\.import frame is too large/);
  assert.doesNotMatch(A.pm.lastError!, /could not be read/);
  assert.equal(A.launches.length, 0, 'no provider started');
  // A send retries the import and rejects with the same specific cause; nothing is dispatched.
  await assert.rejects(A.pm.send('hello'), /one-time import of this machine's PM memory into the cloud relay failed/);
  assert.equal(A.launches.length, 0);
  // Once the relay accepts it, the next send imports and starts the PM.
  relay.swallow = null;
  await A.pm.send('hello again');
  await until(() => A.answers().length === 1);
  assert.equal(relay.imports.length, 1);
});

test('#122: a memory read failure after a good import keeps its own wording', { timeout: 20_000 }, async (t) => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const relay = new FakeRelay();
  relay.memory.initialized = true;
  const A = daemon(t, relay, home('machine-a'), 'machine-a');
  let gets = 0;
  // The import's memory.get succeeds; the read that follows it is refused.
  relay.swallow = (frame) => {
    if (frame.op !== 'memory.get' || ++gets < 2) return false;
    queueMicrotask(() => A.sockets.at(-1)!.receive(pmRpcError(frame.id, 'unavailable', 'PM state storage failed')));
    return true;
  };
  await A.connect();
  await until(() => A.pm.lastError !== null, 'the launch failure is reported');
  assert.match(A.pm.lastError!, /PM memory could not be read, so the PM did not start: PM state storage failed/);
  assert.doesNotMatch(A.pm.lastError!, /import/);
});

test('#122: the model is known before the first PM start, read from the store without starting a provider', { timeout: 20_000 }, async (t) => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const previous = process.env.FOREMAN_PM_MODEL;
  t.after(() => { if (previous === undefined) delete process.env.FOREMAN_PM_MODEL; else process.env.FOREMAN_PM_MODEL = previous; });
  process.env.FOREMAN_PM_MODEL = 'claude-default-from-env';
  const relay = new FakeRelay();
  relay.memory.initialized = true; relay.memory.model = 'claude-sonnet-4-5';
  const A = daemon(t, relay, home('machine-a'), 'machine-a', { autoStart: false });
  // Not the PM host yet (never connected): the configured default.
  assert.equal(await A.pm.displayModel(), 'claude-default-from-env');
  await A.connect();
  assert.equal(A.pm.model, undefined, 'no provider start has set it');
  assert.equal(await A.pm.displayModel(), 'claude-sonnet-4-5');
  assert.equal(A.launches.length, 0, 'reading the model starts no provider');
  // Cached: a second read sends no second memory.get.
  const gets = () => relay.frames.filter((f) => f.frame.op === 'memory.get').length;
  const before = gets();
  assert.equal(await A.pm.displayModel(), 'claude-sonnet-4-5');
  assert.equal(gets(), before);
  // With no saved model, the configured default (as the next start would pick it).
  relay.memory.model = null;
  const B = daemon(t, relay, home('machine-b'), 'machine-b', { autoStart: false });
  relay.assignment = null; // B bootstraps as the PM host of a fresh relay record
  await B.connect();
  assert.equal(await B.pm.displayModel(), 'claude-default-from-env');
  // After a start, the live selection.
  await B.pm.send('hello');
  await until(() => B.answers().length === 1);
  assert.equal(await B.pm.displayModel(), 'claude-default-from-env');
  assert.equal(B.launches[0]!.options.model, 'claude-default-from-env');
});

test('#122: while the relay refuses this machine by policy, sends name the refusal and when it retries', { timeout: 20_000 }, async (t) => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const relay = new FakeRelay();
  const A = daemon(t, relay, home('machine-a'), 'machine-a');
  const socket = A.sockets.at(-1)!;
  socket.readyState = 3; socket.emit('close', 1008, Buffer.from('Too many machines'));
  const retryAt = A.bridge.refusal()!.retry_at;
  clearTimeout((A.bridge as any).reconnect);
  const expected = new Date(retryAt).toISOString().slice(0, 16).replace('T', ' ');
  await assert.rejects(A.pm.send('hello'), (error: Error) => {
    assert.equal(error.message, `The cloud relay is unreachable; the PM is unavailable on this machine. The relay refused this machine: Too many machines. It retries at ${expected} UTC.`);
    return true;
  });
  // An ordinary outage keeps the ordinary message.
  const B = daemon(t, relay, home('machine-b'), 'machine-b');
  await assert.rejects(B.pm.send('hello'), /^Error: The cloud relay is unreachable; the PM is unavailable on this machine\.$/);
});

test('#122: store selection names the bridge\'s own reason for a configured relay that did not start', () => {
  const config = () => ({ url: 'http://relay', token: TOKEN });
  assert.deepEqual(choosePmStore(config, false, {}, 'Relay URL must be an HTTPS origin'),
    { mode: 'unavailable', reason: 'cloud.json is invalid (Relay URL must be an HTTPS origin); the PM is unavailable on this machine' });
  assert.deepEqual(choosePmStore(config, false, { FOREMAN_RELAY_URL: 'http://relay', FOREMAN_HOST_TOKEN: 'short' }, 'Invalid host token'),
    { mode: 'unavailable', reason: 'the relay configuration (FOREMAN_RELAY_URL/FOREMAN_HOST_TOKEN) is invalid (Invalid host token); the PM is unavailable on this machine' });
  assert.equal(choosePmStore(config, true, {}, 'ignored').mode, 'relay');
});
