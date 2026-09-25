import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNotifyFrame, MAX_DISPLAY_NAME, type NotifyFrame } from '../shared/notify.ts';

// server/paths.ts reads FOREMAN_HOME at import, so isolate it before loading any server module.
const pmHome = mkdtempSync(join(tmpdir(), 'foreman-notifier-pm-'));
process.env.FOREMAN_HOME = pmHome;
test.after(() => rmSync(pmHome, { recursive: true, force: true }));
const { SessionService } = await import('../server/session-service.ts');
const { Notifier } = await import('../server/notifier.ts');
const { ProjectManager } = await import('../server/pm.ts');
const { ensureDirs } = await import('../server/paths.ts');
const { LocalPmStore } = await import('../server/pm-store.ts');
ensureDirs();

// Sensitive markers the fakes carry; none may ever appear in a serialized frame.
const SECRETS = ['rm -rf /Users/hong/private', 'Bash', 'AskUserQuestion', '/Users/hong/secret-project', 'transcript text SECRET', 'ENOENT stack trace', 'item/commandExecution/requestApproval', 'Which database password?'];

interface FakeApproval { id: string; kind: 'permission' | 'question' | 'unsupported'; tool: string; input: Record<string, any>; reason?: string }
interface FakeRow { session_key: string; name: string; state: string; managed: boolean; cwd: string; last_error: string | null; last_message: string | null; transcript_path: string | null }

class FakeSessions extends EventEmitter {
  rows = new Map<string, FakeRow>();
  pending = new Map<string, FakeApproval[]>();
  detailCalls = 0;
  approvalCalls = 0;
  add(key: string, managed = true, overrides: Partial<FakeRow> = {}) {
    this.rows.set(key, { session_key: key, name: 'fix login', state: 'idle', managed, cwd: '/Users/hong/secret-project', last_error: null, last_message: 'transcript text SECRET', transcript_path: '/Users/hong/secret-project/t.jsonl', ...overrides });
    this.pending.set(key, []);
  }
  list() { return [...this.rows.values()].map((row) => ({ ...row })); }
  approvals(id: string) {
    this.approvalCalls++;
    const session = this.rows.get(id);
    return session?.managed ? structuredClone(this.pending.get(id) ?? []) : [];
  }
  // Present so a regression back to detail() is visible: the notifier must never call it.
  detail(id: string) {
    this.detailCalls++;
    const session = this.rows.get(id); if (!session) throw new Error('No such session');
    return { session: { ...session }, history: [{ id: 'h', role: 'assistant', text: 'transcript text SECRET', at: new Date().toISOString() }], receipts: [], approvals: session.managed ? structuredClone(this.pending.get(id) ?? []) : [] };
  }
  // Mirrors SessionService.changed(): per-session event, then the list.
  changed(key: string) { this.emit('session', { id: key }); this.emit('change', this.list()); }
  set(key: string, patch: Partial<FakeRow>) { Object.assign(this.rows.get(key)!, patch); this.changed(key); }
  request(key: string, approval: FakeApproval) { this.pending.get(key)!.push(approval); this.changed(key); }
  resolve(key: string, id: string) { this.pending.set(key, this.pending.get(key)!.filter((a) => a.id !== id)); this.changed(key); }
}

class FakePm extends EventEmitter {
  lastError: string | null = null;
  fail(text = 'Project manager failed: ENOENT stack trace /Users/hong/secret-project') { this.lastError = text; this.emit('event', { type: 'status', text }); }
  succeed() { this.lastError = null; this.emit('event', { type: 'turn_end', ts: new Date().toISOString(), cost_usd: 0, is_error: false, subtype: 'success' }); }
  chatter() { this.emit('event', { type: 'delta', text: 'transcript text SECRET' }); }
}

const permission = (id: string): FakeApproval => ({ id, kind: 'permission', tool: 'Bash', input: { command: 'rm -rf /Users/hong/private' }, reason: 'ENOENT stack trace' });
const question = (id: string): FakeApproval => ({ id, kind: 'question', tool: 'AskUserQuestion', input: { questions: [{ question: 'Which database password?' }] } });

function setup(t: test.TestContext, prepare?: (sessions: FakeSessions, pm: FakePm) => void) {
  const sessions = new FakeSessions(), pm = new FakePm(), frames: NotifyFrame[] = [], serialized: string[] = [];
  sessions.add('fm:managed');
  prepare?.(sessions, pm);
  const notifier = new Notifier({ sessions, pm, host: 'test-mac', send: (frame) => { frames.push(frame); serialized.push(JSON.stringify(frame)); } }).start();
  t.after(() => notifier.close());
  t.after(() => {
    for (const raw of serialized) {
      for (const secret of SECRETS) assert.ok(!raw.includes(secret), `frame leaked ${secret}: ${raw}`);
      assert.deepEqual(parseNotifyFrame(JSON.parse(raw)), JSON.parse(raw), 'every frame satisfies the shared contract');
    }
  });
  return { sessions, pm, frames, serialized, notifier };
}

test('a new permission approval sends one approval_requested; re-observing it sends nothing', (t) => {
  const { sessions, frames } = setup(t);
  sessions.request('fm:managed', permission('tool-1'));
  assert.equal(frames.length, 1);
  const [frame] = frames;
  assert.equal(frame!.kind, 'approval_requested');
  assert.equal(frame!.type, 'notify');
  assert.equal(frame!.host, 'test-mac');
  assert.equal(frame!.session_key, 'fm:managed');
  assert.equal(frame!.session_name, 'fix login');
  assert.match(frame!.id, /^approval_requested:/);
  assert.ok(!Number.isNaN(Date.parse(frame!.at)));
  sessions.changed('fm:managed');
  sessions.set('fm:managed', { state: 'needs_input' });
  sessions.set('fm:managed', { state: 'working' });
  assert.equal(frames.length, 1, 'a still-pending approval never fires twice');
});

test('a burst of approvals yields one frame per approval with distinct deterministic ids', (t) => {
  const { sessions, frames } = setup(t);
  sessions.request('fm:managed', permission('a'));
  sessions.request('fm:managed', permission('b'));
  sessions.request('fm:managed', { ...permission('c'), kind: 'unsupported', tool: 'item/commandExecution/requestApproval' });
  assert.deepEqual(frames.map((f) => f.kind), ['approval_requested', 'approval_requested', 'approval_requested']);
  assert.equal(new Set(frames.map((f) => f.id)).size, 3);
  // Determinism: the same session key and approval id produce the same id in a fresh notifier.
  const again = setup(t);
  again.sessions.request('fm:managed', permission('a'));
  assert.equal(again.frames[0]!.id, frames[0]!.id);
});

test('a question sends question_asked', (t) => {
  const { sessions, frames } = setup(t);
  sessions.request('fm:managed', question('q-1'));
  assert.deepEqual(frames.map((f) => f.kind), ['question_asked']);
});

test('approvals already pending at start-up never fire, but later ones do', (t) => {
  const { sessions, frames } = setup(t, (sessions) => { sessions.pending.get('fm:managed')!.push(permission('before'), question('before-q')); });
  sessions.changed('fm:managed');
  assert.equal(frames.length, 0);
  sessions.request('fm:managed', permission('after'));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.kind, 'approval_requested');
});

test('#126: session events read approvals() and the emitted row list, never detail()', (t) => {
  const { sessions, frames } = setup(t);
  sessions.request('fm:managed', permission('a'));
  sessions.set('fm:managed', { state: 'unknown' });
  assert.deepEqual(frames.map((f) => f.kind), ['approval_requested', 'session_failed']);
  assert.equal(sessions.detailCalls, 0, 'detail() copies history and receipts; the notifier must not call it');
  assert.ok(sessions.approvalCalls >= 2);
});

test('#126: only the session named by the event is read, not every session on each change', (t) => {
  const { sessions } = setup(t, (sessions) => { for (let i = 0; i < 5; i++) sessions.add(`fm:other-${i}`); });
  const before = sessions.approvalCalls;
  sessions.request('fm:managed', permission('a'));
  assert.equal(sessions.approvalCalls - before, 1);
});

test('#126: approval memory never evicts a still-pending id, however many are pending', (t) => {
  const { sessions, frames } = setup(t);
  const ids = Array.from({ length: 1005 }, (_, i) => `tool-${i}`);
  sessions.pending.get('fm:managed')!.push(...ids.map(permission));
  sessions.changed('fm:managed');
  assert.equal(frames.length, 1005);
  sessions.changed('fm:managed');
  sessions.set('fm:managed', { state: 'working' });
  assert.equal(frames.length, 1005, 'no still-pending approval fires twice, even past 1,000');
});

test('#126: approval memory forgets exactly the ids no longer pending', (t) => {
  const { sessions, frames, notifier } = setup(t);
  sessions.request('fm:managed', permission('a'));
  sessions.request('fm:managed', permission('b'));
  const memory = () => [...((notifier as any).seen.get('fm:managed') as Set<string>)].sort();
  assert.deepEqual(memory(), ['a', 'b']);
  sessions.resolve('fm:managed', 'a');
  assert.deepEqual(memory(), ['b'], 'a resolved id is dropped; the pending one stays');
  sessions.changed('fm:managed');
  assert.equal(frames.length, 2, 'b is still remembered, so it never re-fires');
});

test('#126: a failing approvals() read still lets the failure edge fire and keeps the memory', (t) => {
  t.mock.method(console, 'error', () => {});
  const { sessions, frames } = setup(t);
  sessions.request('fm:managed', permission('a'));
  const original = sessions.approvals.bind(sessions);
  sessions.approvals = () => { throw new Error('approvals exploded'); };
  sessions.set('fm:managed', { state: 'working' });
  sessions.approvals = original;
  sessions.changed('fm:managed');
  assert.equal(frames.length, 1, 'a is still remembered after the failed read');
  sessions.approvals = () => { throw new Error('approvals exploded'); };
  sessions.set('fm:managed', { state: 'unknown' });
  assert.deepEqual(frames.map((f) => f.kind), ['approval_requested', 'session_failed']);
});

test('observed (unmanaged) sessions never notify', (t) => {
  const { sessions, frames } = setup(t, (sessions) => sessions.add('claude:observed', false));
  sessions.pending.get('claude:observed')!.push(permission('x'));
  sessions.set('claude:observed', { state: 'needs_input' });
  sessions.set('claude:observed', { state: 'unknown' });
  assert.equal(frames.length, 0);
});

test('a managed session becoming unavailable sends one session_failed; staying failed sends none', (t) => {
  const { sessions, frames } = setup(t);
  sessions.set('fm:managed', { state: 'working' });
  sessions.set('fm:managed', { state: 'unknown', last_error: 'Claude process ended: ENOENT stack trace' });
  assert.deepEqual(frames.map((f) => f.kind), ['session_failed']);
  assert.equal(frames[0]!.session_key, 'fm:managed');
  sessions.changed('fm:managed');
  sessions.set('fm:managed', { last_error: 'still ENOENT stack trace' });
  assert.equal(frames.length, 1);
});

test('a session created after start that fails to launch sends session_failed', (t) => {
  const { sessions, frames } = setup(t);
  sessions.add('fm:new', true, { state: 'working' });
  sessions.changed('fm:new');
  sessions.set('fm:new', { state: 'unknown' });
  assert.deepEqual(frames.map((f) => [f.kind, f.session_key]), [['session_failed', 'fm:new']]);
});

test('completion, a failed or interrupted turn that leaves the session usable, and restored sessions never send session_failed', (t) => {
  const { sessions, frames } = setup(t, (sessions) => sessions.add('fm:restored', true, { state: 'unknown' }));
  sessions.changed('fm:restored');
  sessions.set('fm:managed', { state: 'working' });
  sessions.set('fm:managed', { state: 'turn_finished' });
  sessions.set('fm:managed', { state: 'working' });
  sessions.set('fm:managed', { state: 'idle' }); // interrupt or failed turn: SessionService returns to idle
  sessions.set('fm:managed', { state: 'needs_input' });
  sessions.set('fm:managed', { state: 'idle' });
  assert.equal(frames.length, 0);
});

test('PM failure edge sends one pm_failed; staying failed sends none; recover then fail sends a second', (t) => {
  const { pm, frames } = setup(t);
  pm.chatter();
  assert.equal(frames.length, 0);
  pm.fail();
  assert.deepEqual(frames.map((f) => f.kind), ['pm_failed']);
  assert.equal(frames[0]!.session_key, undefined);
  assert.equal(frames[0]!.session_name, undefined);
  pm.fail('Project manager failed: another ENOENT stack trace');
  pm.chatter();
  assert.equal(frames.length, 1, 'no repeat while still failed');
  pm.succeed();
  assert.equal(frames.length, 1, 'recovery does not notify');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 1000 });
  pm.fail();
  assert.deepEqual(frames.map((f) => f.kind), ['pm_failed', 'pm_failed']);
  assert.notEqual(frames[0]!.id, frames[1]!.id, 'each failure edge has its own id');
});

test('a PM already failed at start does not fire until it recovers and fails again', (t) => {
  const { pm, frames } = setup(t, (_sessions, pm) => { pm.lastError = 'Project manager failed: before'; });
  pm.fail();
  assert.equal(frames.length, 0);
  pm.succeed(); pm.fail();
  assert.equal(frames.length, 1);
});

test('frames never carry approval input, tool names, text, paths or errors', (t) => {
  const { sessions, pm, serialized } = setup(t);
  sessions.request('fm:managed', permission('p'));
  sessions.request('fm:managed', question('q'));
  sessions.set('fm:managed', { state: 'unknown', last_error: 'ENOENT stack trace' });
  pm.fail();
  assert.equal(serialized.length, 4);
  for (const raw of serialized) {
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), raw.includes('session_key') ? ['at', 'host', 'id', 'kind', 'session_key', 'session_name', 'type'] : ['at', 'host', 'id', 'kind', 'type']);
    for (const secret of SECRETS) assert.ok(!raw.includes(secret), `leaked ${secret}`);
  }
});

test('long or control-laden managed names are cleaned to the display limit', (t) => {
  const { sessions, frames } = setup(t, (sessions) => sessions.add('fm:long', true, { name: 'line one\nline‮ two\u0007 ' + 'x'.repeat(200) }));
  sessions.request('fm:long', permission('p'));
  const name = frames[0]!.session_name!;
  assert.ok(Array.from(name).length <= MAX_DISPLAY_NAME);
  assert.ok(name.startsWith('line one line two x'));
  assert.ok(!/[\n\u0007‮]/.test(name));
});

test('a throwing sender or service never throws into the emitter, and later edges still fire', (t) => {
  t.mock.method(console, 'error', () => {});
  const sessions = new FakeSessions(); sessions.add('fm:managed');
  const pm = new FakePm();
  let calls = 0;
  const notifier = new Notifier({ sessions, pm, host: 'test-mac', send: () => { calls++; throw new Error('socket exploded'); } }).start();
  t.after(() => notifier.close());
  assert.doesNotThrow(() => sessions.request('fm:managed', permission('a')));
  assert.doesNotThrow(() => pm.fail());
  const original = sessions.approvals.bind(sessions);
  sessions.approvals = () => { throw new Error('approvals exploded'); };
  assert.doesNotThrow(() => sessions.changed('fm:managed'));
  sessions.approvals = original;
  assert.doesNotThrow(() => sessions.request('fm:managed', permission('b')));
  assert.equal(calls, 3);
});

test('an invalid frame (host outside the contract) is dropped instead of sent', (t) => {
  t.mock.method(console, 'error', () => {});
  const sessions = new FakeSessions(); sessions.add('fm:managed');
  const sent: NotifyFrame[] = [];
  const notifier = new Notifier({ sessions, host: 'h'.repeat(101), send: (frame) => sent.push(frame) }).start();
  t.after(() => notifier.close());
  sessions.request('fm:managed', permission('a'));
  assert.equal(sent.length, 0);
});

test('close removes every listener and stops notifying', (t) => {
  const { sessions, pm, frames, notifier } = setup(t);
  assert.equal(sessions.listenerCount('session'), 1);
  assert.equal(sessions.listenerCount('change'), 1);
  assert.equal(pm.listenerCount('event'), 1);
  notifier.close();
  assert.equal(sessions.listenerCount('session'), 0);
  assert.equal(sessions.listenerCount('change'), 0);
  assert.equal(pm.listenerCount('event'), 0);
  sessions.request('fm:managed', permission('late'));
  sessions.set('fm:managed', { state: 'unknown' });
  pm.fail();
  assert.equal(frames.length, 0);
});

// The same edges through the real SessionService (fake provider), so the notifier is proven
// against the events and approvals() shape SessionService actually exposes.
class FakeClaude extends EventEmitter {
  sent: any[] = []; pending: any[] = [];
  send(text: string, id: string) { this.sent.push({ text, id }); return { id, status: 'running' }; }
  pendingApprovals() { return this.pending; }
  respondApproval() { return false; }
  async interrupt() { this.emit('receipt', { id: this.sent.at(-1).id, status: 'failed', error: 'Interrupted by user' }); }
  close() { this.pending = []; this.emit('state', 'closed'); }
  ask(approval: any) { this.pending.push(approval); this.emit('state', 'input-needed'); this.emit('approval', approval); }
  complete() { this.emit('receipt', { id: this.sent.at(-1).id, status: 'completed' }); }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function realService(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'foreman-notifier-test-'));
  const claude = new FakeClaude();
  const service = new SessionService({ home, claudeFactory: () => claude as any });
  const frames: NotifyFrame[] = [];
  const notifier = new Notifier({ sessions: service, host: 'test-mac', send: (frame) => frames.push(frame) }).start();
  t.after(async () => { notifier.close(); await service.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, claude, service, frames, notifier };
}

test('with the real SessionService: approval, question, interrupt, completion and provider exit', async (t) => {
  const { home, claude, service, frames } = realService(t);
  const row = await service.create({ id: 'creation-1', provider: 'claude', cwd: home, name: 'Real session', text: 'SECRET first task' });
  await tick();
  assert.equal(claude.sent.length, 1);
  claude.ask({ id: 'tool-use-1', tool: 'Bash', input: { command: 'rm -rf /Users/hong/private' }, reason: 'ENOENT stack trace' });
  claude.ask({ id: 'tool-use-2', tool: 'AskUserQuestion', input: { questions: [{ question: 'Which database password?' }] } });
  claude.emit('message', { type: 'assistant', uuid: 'u1', message: { content: [{ type: 'text', text: 'transcript text SECRET' }] } });
  assert.deepEqual(frames.map((f) => [f.kind, f.session_key, f.session_name]), [['approval_requested', row.session_key, 'Real session'], ['question_asked', row.session_key, 'Real session']]);
  claude.pending = [];
  await service.interrupt(row.session_key); await tick();
  assert.equal(service.detail(row.session_key).session.state, 'idle');
  service.send(row.session_key, 'next', 'msg-2'); await tick();
  claude.complete(); await tick();
  assert.equal(service.detail(row.session_key).session.state, 'turn_finished');
  assert.equal(frames.length, 2, 'interrupt and completion never notify');
  claude.emit('state', 'failed');
  claude.emit('state', 'closed');
  assert.deepEqual(frames.map((f) => f.kind), ['approval_requested', 'question_asked', 'session_failed']);
  for (const frame of frames) {
    const raw = JSON.stringify(frame);
    for (const secret of [...SECRETS, home, 'SECRET']) assert.ok(!raw.includes(secret), `leaked ${secret}`);
  }
});

test('closing the notifier before SessionService.close() keeps shutdown silent', async (t) => {
  const { home, service, frames, notifier } = realService(t);
  await service.create({ id: 'c', provider: 'claude', cwd: home, text: 'task' });
  await tick();
  notifier.close();
  await service.close();
  assert.equal(frames.length, 0);
});

test('control: without closing the notifier first, shutdown would read as a session failure', async (t) => {
  const { home, service, frames } = realService(t);
  await service.create({ id: 'c', provider: 'claude', cwd: home, text: 'task' });
  await tick();
  await service.close();
  assert.deepEqual(frames.map((f) => f.kind), ['session_failed']);
});

// pm_failed through the real ProjectManager (scripted provider): its lastError/event surface.
test('with the real ProjectManager: failed turn -> one pm_failed; success re-arms; next failure -> second', async (t) => {
  t.mock.method(console, 'error', () => {});
  const pm = new ProjectManager({} as any);
  pm.attach(new LocalPmStore({ identity: { machine_id: '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', name: 'test-mac' }, home: mkdtempSync(join(pmHome, 'store-')), log: () => {} }), { autoStart: false });
  const results = [
    { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['ENOENT stack trace /Users/hong/secret-project'] },
    { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['second ENOENT stack trace'] },
    { type: 'result', is_error: false, subtype: 'success', result: 'transcript text SECRET' },
    { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['third ENOENT stack trace'] },
  ];
  // A failed turn makes the PM restart its provider on the next send, so the script cursor is
  // shared across provider runs.
  let next = 0;
  (pm as any).queryFactory = ({ prompt }: any) => {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => { stop = resolve; });
    return {
      close: stop,
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'notifier-session', tools: [] };
        while (next < results.length) {
          const input = await Promise.race([prompt.next(), stopped.then(() => null)]);
          if (!input || input.done) return;
          // Like the installed CLI, the result names the input it answers.
          yield { ...results[next++], total_cost_usd: 0, user_message_uuids: [input.value.uuid] };
        }
        await stopped;
      },
    };
  };
  const frames: NotifyFrame[] = [];
  const sessions = new EventEmitter() as any; sessions.list = () => []; sessions.approvals = () => { throw new Error('none'); };
  const notifier = new Notifier({ sessions, pm, host: 'test-mac', send: (frame) => frames.push(frame) }).start();
  const running = pm.start();
  t.after(async () => { notifier.close(); pm.close(); await running; });
  let turns = 0;
  pm.on('event', (event: any) => { if (event.type === 'turn_end') turns++; });
  const settle = async (count: number) => { for (let i = 0; i < 200 && turns < count; i++) await new Promise((r) => setTimeout(r, 5)); assert.equal(turns, count); };
  await pm.send('first'); await settle(1);
  assert.deepEqual(frames.map((f) => f.kind), ['pm_failed']);
  await pm.send('second'); await settle(2);
  assert.equal(frames.length, 1, 'still failed: no repeat');
  await pm.send('third'); await settle(3);
  assert.equal(pm.lastError, null);
  assert.equal(frames.length, 1);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 1000 });
  await pm.send('fourth'); await settle(4);
  assert.deepEqual(frames.map((f) => f.kind), ['pm_failed', 'pm_failed']);
  assert.notEqual(frames[0]!.id, frames[1]!.id);
  for (const frame of frames) { const raw = JSON.stringify(frame); for (const secret of [...SECRETS, 'notifier-session']) assert.ok(!raw.includes(secret), `leaked ${secret}`); }
});
