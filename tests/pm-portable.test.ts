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
const { ProjectManager } = await import('../server/pm.ts');

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
function daemon(t: any, relay: FakeRelay, dir: string, name: string, options: { rpcTimeoutMs?: number } = {}) {
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
  pm.attach(store, { bridge });
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
