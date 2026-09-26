// Pin FOREMAN_HOME to a temp dir before any server module loads (story #121 guard).
import './fixtures/temp-foreman-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionService, claudeToolSummary } from '../server/session-service.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
class FakeClaude extends EventEmitter {
  sent: any[] = []; pending: any[] = []; interrupted = 0; closed = false;
  send(text: string, id: string) { this.sent.push({ text, id }); return { id, status: 'running' }; }
  pendingApprovals() { return this.pending; }
  respondApproval(id: string, decision: string, updatedInput?: any) {
    const index = this.pending.findIndex((p) => p.id === id); if (index < 0) return false;
    this.pending.splice(index, 1); this.emit('answer', { id, decision, updatedInput }); return true;
  }
  async interrupt() { this.interrupted++; this.emit('receipt', { id: this.sent.at(-1).id, status: 'failed', error: 'interrupted' }); }
  close() { this.closed = true; this.pending = []; this.emit('state', 'closed'); }
  complete() { this.emit('message', { type: 'assistant', uuid: `reply-${this.sent.length}`, session_id: 'native-claude', message: { content: [{ type: 'text', text: 'Finished work' }] } }); this.emit('receipt', { id: this.sent.at(-1).id, status: 'completed' }); }
}
class FakeCodex extends EventEmitter {
  sent: any[] = []; pending: any[] = []; responses: any[] = []; turns = 0; closed = false;
  async connect() { return this; }
  async start() { return { id: 'native-codex' }; }
  async send(threadId: string, text: string) { const id = `turn-${++this.turns}`; this.sent.push({ threadId, text, id }); this.emit('notification', { method: 'turn/started', params: { threadId, turn: { id } } }); return { turn: { id } }; }
  pendingRequests() { return this.pending; }
  respond(id: string, result: any) { const index = this.pending.findIndex((p) => p.id === id); if (index < 0) throw new Error('stale'); this.pending.splice(index, 1); this.responses.push({ id, result }); }
  close() { this.closed = true; this.pending = []; this.emit('disconnect', new Error('closed')); }
  complete() { const turn = this.sent.at(-1); this.emit('notification', { method: 'item/completed', params: { threadId: turn.threadId, item: { id: turn.id, type: 'agentMessage', text: 'Codex answer' } } }); this.emit('notification', { method: 'turn/completed', params: { threadId: turn.threadId, turn: { id: turn.id, status: 'completed' } } }); }
  async interrupt() { const turn = this.sent.at(-1); this.emit('notification', { method: 'turn/completed', params: { threadId: turn.threadId, turn: { id: turn.id, status: 'interrupted' } } }); }
}
function fixture(t: test.TestContext, extra: Record<string, any> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'foreman-service-test-')); const claude = new FakeClaude(), codex = new FakeCodex();
  const service = new SessionService({ home, claudeFactory: () => claude as any, codexFactory: () => codex as any, ...extra });
  t.after(() => { service.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, service, claude, codex, input: { id: 'creation-1', provider: 'claude' as const, cwd: home, name: 'Project', text: 'First task' } };
}

test('creation and sends are durable, idempotent, serialized and preserve source identity', async (t) => {
  const { home, service, claude, input } = fixture(t);
  const [first, second] = await Promise.all([service.create(input), service.create(input)]);
  assert.equal(first.session_key, second.session_key); await tick();
  assert.equal(claude.sent.length, 1);
  const key = first.session_key;
  service.send(key, 'Follow up', 'follow-1'); service.send(key, 'Follow up', 'follow-1');
  assert.equal(claude.sent.length, 1); assert.equal(service.receipt(key, 'follow-1').status, 'queued');
  const persisted = JSON.parse(readFileSync(join(home, 'managed', readdirSync(join(home, 'managed')).find((name) => name.endsWith('.json'))!), 'utf8'));
  assert.equal(persisted.receipts[1].status, 'queued');
  assert.throws(() => service.send(key, 'Different', 'follow-1'), /different input/);
  await assert.rejects(service.create({ ...input, name: 'Different' }), /different input/);
  claude.complete(); await tick();
  assert.equal(claude.sent.length, 2); assert.equal(service.receipt(key, input.id).status, 'completed');
  claude.complete();
  const source = { sender: 'fm:peer', chain: ['fm:peer'] };
  service.send(key, 'Peer task', 'peer-1', source);
  assert.deepEqual(service.activeSource(key), source); assert.match(claude.sent[2].text, /Message from Foreman session fm:peer/);
  assert.equal(service.detail(key).history.filter((entry) => entry.id === 'follow-1').length, 1);
});

test('restart retains history and receipts while refusing automatic replay or false liveness', async (t) => {
  const { home, service, claude, input } = fixture(t);
  const session = await service.create(input); await tick(); service.send(session.session_key, 'Queued', 'queued');
  assert.throws(() => new SessionService({ home }), /Another Foreman process/);
  service.close();
  const loaded = new SessionService({ home, claudeFactory: () => { throw new Error('must not launch'); } });
  t.after(() => loaded.close());
  const detail = loaded.detail(session.session_key);
  assert.equal(detail.session.capabilities.message, false); assert.equal(detail.session.state, 'unknown');
  assert.deepEqual(detail.receipts.map((r) => r.status), ['uncertain', 'uncertain']);
  assert.equal(detail.history[0].text, 'First task'); assert.equal(claude.sent.length, 1);
  assert.equal(loaded.send(session.session_key, 'Queued', 'queued').status, 'uncertain');
  assert.throws(() => loaded.send(session.session_key, 'New', 'new'), /restarted/);
});

test('Claude approval and questions are exact, stale-safe and disappear on close', async (t) => {
  const { service, claude, input } = fixture(t); const session = await service.create(input); await tick();
  claude.pending.push({ id: 'permission', tool: 'Bash', input: { command: 'pwd' } });
  claude.pending.push({ id: 'question', tool: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] } });
  assert.deepEqual(service.detail(session.session_key).approvals.map((r) => r.kind), ['permission', 'question']);
  await assert.rejects(service.approve(session.session_key, 'question', 'allow'), /Answer/);
  let answer: any; claude.on('answer', (value) => { answer = value; });
  await service.approve(session.session_key, 'question', 'allow', { 'Which?': 'A' });
  assert.deepEqual(answer.updatedInput.answers, { 'Which?': 'A' });
  await assert.rejects(service.approve(session.session_key, 'question', 'allow', { 'Which?': 'A' }), /no longer pending/);
  await service.approve(session.session_key, 'permission', 'deny'); assert.equal(answer.decision, 'deny');
  service.close(); assert.equal(service.detail(session.session_key).approvals.length, 0);
});

test('#126: approvals(id) matches detail().approvals as copies, and is [] for unknown, observed or closed sessions', async (t) => {
  const { service, claude, codex, input } = fixture(t);
  assert.deepEqual(service.approvals('fm:00000000-0000-0000-0000-000000000000'), []);
  assert.deepEqual(service.approvals('claude:observed'), []);
  const session = await service.create(input); await tick();
  assert.deepEqual(service.approvals(session.session_key), []);
  claude.pending.push({ id: 'permission', tool: 'Bash', input: { command: 'pwd' } });
  claude.pending.push({ id: 'question', tool: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] } });
  const approvals = service.approvals(session.session_key);
  assert.deepEqual(approvals, service.detail(session.session_key).approvals);
  assert.deepEqual(approvals.map((r) => [r.id, r.kind]), [['permission', 'permission'], ['question', 'question']]);
  approvals[0]!.input.command = 'mutated';
  assert.equal(claude.pending[0].input.command, 'pwd', 'callers get copies');
  const other = await service.create({ ...input, id: 'creation-2', provider: 'codex' }); await tick();
  codex.pending.push({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'native-codex', command: 'ls' } });
  codex.pending.push({ id: 8, method: 'item/tool/call', params: { threadId: 'native-codex' } });
  assert.deepEqual(service.approvals(other.session_key).map((r) => [r.id, r.kind]), [['7', 'permission']]);
  service.close();
  assert.deepEqual(service.approvals(session.session_key), []);
});

test('Codex serializes turns, persists assistant output, and answers provider questions', async (t) => {
  const { service, codex, input } = fixture(t); const session = await service.create({ ...input, provider: 'codex' }); await tick();
  service.send(session.session_key, 'Second task', 'second'); assert.equal(codex.sent.length, 1);
  codex.complete(); await tick(); assert.equal(codex.sent.length, 2);
  assert.equal(service.detail(session.session_key).history.some((r) => r.text === 'Codex answer'), true);
  codex.pending.push({ id: 'q1', method: 'item/tool/requestUserInput', params: { threadId: 'native-codex', questions: [{ id: 'choice', question: 'Choose', options: [{ label: 'Yes' }] }] } });
  await service.approve(session.session_key, 'q1', 'allow', { choice: 'Yes' });
  assert.deepEqual(codex.responses[0].result, { answers: { choice: { answers: ['Yes'] } } });
  codex.emit('disconnect', new Error('lost'));
  assert.equal(service.receipt(session.session_key, 'second').status, 'uncertain');
  assert.equal(service.detail(session.session_key).session.capabilities.message, false);
});

test('interrupt cancels queued followups and does not dispatch them after active completion', async (t) => {
  const { service, claude, input } = fixture(t); const session = await service.create(input); await tick();
  service.send(session.session_key, 'Do this next', 'next');
  await service.interrupt(session.session_key); await tick();
  assert.equal(claude.interrupted, 1); assert.equal(claude.sent.length, 1);
  assert.equal(service.receipt(session.session_key, 'next').status, 'failed');
});

test('invalid project and oversized messages never launch a provider', async (t) => {
  const { service, claude, input } = fixture(t);
  await assert.rejects(service.create({ ...input, cwd: 'relative' }), /absolute/);
  await assert.rejects(service.create({ ...input, text: 'x'.repeat(65537) }), /65536/);
  assert.equal(claude.sent.length, 0); assert.equal(service.list().length, 0);
});

test('provider startup errors are surfaced durably and creation retries cannot duplicate work', async (t) => {
  const { service, input } = fixture(t, { claudeFactory: () => { throw new Error('binary unavailable'); } });
  const session = await service.create(input); await tick();
  const detail = service.detail(session.session_key);
  assert.equal(detail.receipts[0].status, 'failed'); assert.match(detail.session.control_reason!, /binary unavailable/);
  assert.equal((await service.create(input)).session_key, session.session_key);
});

test('Codex completion before the send response cannot revive an old turn or double-send queued work', async (t) => {
  class ImmediateCodex extends FakeCodex {
    async send(threadId: string, text: string) {
      const result = await super.send(threadId, text);
      this.complete();
      return result;
    }
  }
  const codex = new ImmediateCodex();
  const { service, input } = fixture(t, { codexFactory: () => codex as any });
  const row = await service.create({ ...input, provider: 'codex' }); await tick();
  assert.equal(service.receipt(row.session_key, input.id).status, 'completed');
  service.send(row.session_key, 'Second', 'second'); service.send(row.session_key, 'Third', 'third'); await tick();
  assert.deepEqual(service.detail(row.session_key).receipts.map((r) => r.status), ['completed', 'completed', 'completed']);
  assert.equal(codex.sent.length, 3);
  // A late duplicate completion from turn one cannot acknowledge a new task.
  const ordinary = new FakeCodex();
  const other = fixture(t, { codexFactory: () => ordinary as any });
  const secondRow = await other.service.create({ ...other.input, provider: 'codex' }); await tick();
  ordinary.complete(); await tick(); other.service.send(secondRow.session_key, 'Active second', 'active'); await tick();
  ordinary.emit('notification', { method: 'turn/completed', params: { threadId: 'native-codex', turn: { id: 'turn-1', status: 'completed' } } });
  assert.equal(other.service.receipt(secondRow.session_key, 'active').status, 'running');
});

test('model choice reaches both providers, survives restart, and participates in creation idempotency', async (t) => {
  const claude = new FakeClaude(), codex = new FakeCodex();
  let claudeOptions: any, codexOptions: any;
  (codex as any).start = async (_cwd: string, options: any) => { codexOptions = options; return { id: 'native-codex' }; };
  const { home, service, input } = fixture(t, {
    claudeFactory: (options: any) => { claudeOptions = options; return claude; },
    codexFactory: () => codex,
  });
  const session = await service.create({ ...input, model: 'haiku' }); await tick();
  assert.equal(claudeOptions.model, 'haiku');
  assert.equal(service.detail(session.session_key).session.model, 'haiku');
  await assert.rejects(service.create({ ...input, model: 'sonnet' }), /different input/);
  await service.create({ ...input, id: 'codex-model', provider: 'codex', model: 'gpt-6-astra' }); await tick();
  assert.equal(codexOptions.model, 'gpt-6-astra');
  service.close();
  const restored = new SessionService({ home });
  t.after(() => restored.close());
  assert.equal(restored.detail(session.session_key).session.model, 'haiku');
});

for (const provider of ['claude', 'codex'] as const) {
  test(`${provider}: launch policy reaches the controller, is reported, immutable, and durable`, async (t) => {
    let received: any;
    class PolicyCodex extends FakeCodex {
      async start(...args: any[]) { received = args[2]; return { id: 'native-codex' }; }
    }
    const { service, input, home } = fixture(t, {
      claudeFactory: (options: any) => { received = options.permission_mode; return new FakeClaude(); },
      codexFactory: () => new PolicyCodex(),
    });
    for (const mode of ['native', 'bypass'] as const) {
      const launch = { ...input, provider, id: mode, permission_mode: mode };
      const row = await service.create(launch); await tick();
      assert.equal(received, mode); assert.equal(row.permission_mode, mode);
      row.permission_mode = 'bypass';
      assert.equal(service.detail(row.session_key).session.permission_mode, mode);
      await assert.rejects(service.create({ ...launch, permission_mode: mode === 'bypass' ? 'native' : 'bypass' }), /different input/);
    }
    const omitted = await service.create({ ...input, provider, id: 'omitted' }); await tick();
    assert.equal(received, 'native'); assert.equal(omitted.permission_mode, 'native');
    assert.equal((await service.create({ ...input, provider, id: 'omitted', permission_mode: 'native' })).session_key, omitted.session_key);
    await assert.rejects(service.create({ ...input, provider, id: 'bad', permission_mode: 'bypassPermissions' as any }), /permission_mode/);
    service.close();
    const loaded = new SessionService({ home });
    try { assert.deepEqual(loaded.list().map((s) => s.permission_mode).sort(), ['bypass','native','native']); }
    finally { loaded.close(); }
  });
}

test('legacy presets remain historical and cannot be relaunched or silently widened', async (t) => {
  const { home, service, input } = fixture(t);
  const row = await service.create(input); await tick(); service.close();
  const { writeFileSync } = await import('node:fs');
  const file = join(home, 'managed', `${row.session_key.slice(3)}.json`);
  const data = JSON.parse(readFileSync(file, 'utf8')); data.session.permission_mode = 'trusted'; data.creation.permission_mode = 'trusted';
  writeFileSync(file, JSON.stringify(data));
  const loaded = new SessionService({ home, claudeFactory: () => { throw new Error('must not launch'); } });
  t.after(() => loaded.close());
  assert.equal(loaded.detail(row.session_key).session.permission_mode, 'trusted');
  assert.equal(loaded.detail(row.session_key).session.alive, false);
  assert.equal(loaded.detail(row.session_key).session.capabilities.message, false);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).session.permission_mode, 'trusted');
  await assert.rejects(loaded.create(input), /different input/);
  await assert.rejects(loaded.create({...input, permission_mode:'trusted' as any}), /permission_mode/);
});

test('a message arriving during Stop cannot race terminal cleanup or make the session unavailable', async (t) => {
  const {service,codex,input} = fixture(t);
  const row = await service.create({...input,provider:'codex'}); await tick();
  let release!: () => void;
  const native = codex.interrupt.bind(codex);
  codex.interrupt = async () => { await native(); await new Promise<void>((resolve) => { release = resolve; }); };
  const stopping = service.interrupt(row.session_key); await tick();
  assert.throws(() => service.send(row.session_key,'next','next'),/still cleaning up/);
  release(); await stopping;
  service.send(row.session_key,'next','next'); await tick();
  assert.equal(codex.sent.length,2); assert.equal(codex.closed,false);
});

test('named project starts in pinned canonical cwd and retries survive rename/removal without relaunch', async (t) => {
  const { ProjectRegistry } = await import('../server/projects.ts');
  const { mkdirSync, realpathSync, symlinkSync } = await import('node:fs');
  const f = fixture(t), parent = join(f.home, 'real'); mkdirSync(parent);
  const project = join(parent, 'project'); mkdirSync(project);
  const linkedParent = join(f.home, 'code'); symlinkSync(parent, linkedParent);
  const registry = new ProjectRegistry(f.home); const entry = registry.register({ name: 'personal', path: join(linkedParent, 'project') });
  (f.service as any).options.projects = registry;
  let launches = 0, launchCwd = '';
  (f.service as any).options.claudeFactory = (options: any) => { launches++; launchCwd = options.cwd; return f.claude; };
  const input = { ...f.input, cwd: 'personal' };
  const row = await f.service.create(input); await tick();
  assert.equal(launchCwd, realpathSync(project)); assert.equal(row.project_name, 'personal');
  registry.update(entry.id, 'renamed'); assert.equal((await f.service.create(input)).session_key, row.session_key);
  registry.remove(entry.id); assert.equal((await f.service.create(input)).session_key, row.session_key);
  assert.equal(launches, 1); assert.equal(f.claude.sent.length, 1);
});
test('retargeted project parent or final symlink rejects named and absolute launches before provider factory', async (t) => {
  const { ProjectRegistry } = await import('../server/projects.ts');
  const { mkdirSync, symlinkSync } = await import('node:fs');
  const f = fixture(t), one = join(f.home, 'one'), two = join(f.home, 'two');
  mkdirSync(join(one, 'repo'), { recursive: true }); mkdirSync(join(two, 'repo'), { recursive: true });
  const parent = join(f.home, 'code'), final = join(f.home, 'final'); symlinkSync(one, parent); symlinkSync(join(one, 'repo'), final);
  const registry = new ProjectRegistry(f.home);
  registry.register({ name: 'parent', path: join(parent, 'repo') }); registry.register({ name: 'final', path: final });
  (f.service as any).options.projects = registry;
  let launches = 0; (f.service as any).options.claudeFactory = () => { launches++; return f.claude; };
  rmSync(parent); symlinkSync(two, parent); rmSync(final); symlinkSync(join(two, 'repo'), final);
  for (const cwd of ['parent', 'final', join(parent, 'repo'), final, join(one, 'repo')]) await assert.rejects(f.service.create({ ...f.input, cwd }), /changed its symlink target/);
  assert.equal(launches, 0); assert.equal(f.service.list().length, 0); assert.equal(f.claude.sent.length, 0);
});


test('a retargeted canonical-equivalent seeded session path cannot launch a provider', async (t) => {
  const { ProjectRegistry } = await import('../server/projects.ts');
  const { mkdirSync, realpathSync, symlinkSync } = await import('node:fs');
  const f = fixture(t), one = join(f.home, 'one'), two = join(f.home, 'two'), link = join(f.home, 'recent-link');
  mkdirSync(one); mkdirSync(two); symlinkSync(one, link);
  const registry = new ProjectRegistry(f.home); registry.seed([{ cwd: realpathSync(one) }, { cwd: link }]);
  rmSync(link); symlinkSync(two, link);
  const restored = new ProjectRegistry(f.home); restored.seed([{ cwd: link }]); (f.service as any).options.projects = restored;
  let launches = 0; (f.service as any).options.claudeFactory = () => { launches++; return f.claude; };
  for (const cwd of [link, 'recent-link', one]) await assert.rejects(f.service.create({ ...f.input, cwd }), /changed its symlink target/);
  assert.equal(launches, 0); assert.equal(f.service.list().length, 0); assert.equal(restored.list().length, 1);
});

test('developer create(): auto launches Claude in Auto; Codex + auto is refused before anything is saved or launched', async (t) => {
  let received: any;
  const { service, input, home } = fixture(t, {
    claudeFactory: (options: any) => { received = options; return new FakeClaude(); },
    codexFactory: () => { throw new Error('codex must not launch'); },
  });
  const row = await service.create({ ...input, permission_mode: 'auto' }); await tick();
  assert.equal(received.permission_mode, 'auto'); assert.equal(row.permission_mode, 'auto');
  assert.equal('effort' in received, false, 'developer launches pass no effort');
  assert.deepEqual([row.role, row.launched_by, row.policy_reason, row.bypass_grant], ['session', 'developer', undefined, undefined]);
  await assert.rejects(service.create({ ...input, id: 'codex-auto', provider: 'codex', permission_mode: 'auto' }), /Auto is not supported for Codex/);
  assert.equal(service.list().length, 1); assert.equal(readdirSync(join(home, 'managed')).filter((f) => f.endsWith('.json')).length, 1);
});

async function retireFixture(t: test.TestContext) {
  const { Notifier } = await import('../server/notifier.ts');
  const f = fixture(t);
  const frames: any[] = [];
  const notifier = new Notifier({ sessions: f.service, send: (frame) => frames.push(frame), host: 'test-host' }).start();
  t.after(() => notifier.close());
  const row = await f.service.create(f.input); await tick();
  return { ...f, row, frames, kinds: () => frames.map((frame) => frame.kind) };
}

test('retire: an idle session closes its provider and ends (not unknown) with no session_failed push, and stays ended on restart', async (t) => {
  const f = await retireFixture(t);
  f.claude.complete(); await tick();
  assert.equal(f.service.detail(f.row.session_key).session.state, 'turn_finished');
  const successor = 'fm:0B6D3F1E-2C4A-4E8B-9F10-112233445566';
  await f.service.retire(f.row.session_key, `superseded by ${successor}`);
  const detail = f.service.detail(f.row.session_key);
  assert.deepEqual([detail.session.state, detail.session.alive, detail.session.end_reason, detail.session.superseded_by, detail.session.capabilities.message],
    ['ended', false, `superseded by ${successor}`, successor.toLowerCase(), false]);
  assert.equal(f.claude.closed, true);
  assert.deepEqual(detail.receipts.map((r) => r.status), ['completed']);
  assert.deepEqual(f.kinds(), [], 'no session_failed for a deliberate retirement');
  assert.throws(() => f.service.send(f.row.session_key, 'more', 'more'), /superseded by/);
  await f.service.retire(f.row.session_key, 'again'); // no-op
  assert.equal(f.service.detail(f.row.session_key).session.end_reason, `superseded by ${successor}`);
  await assert.rejects(f.service.retire('fm:00000000-0000-4000-8000-000000000000', 'x'), /No such managed session/);
  f.service.close();
  const loaded = new SessionService({ home: f.home }); t.after(() => loaded.close());
  const restored = loaded.detail(f.row.session_key).session;
  assert.deepEqual([restored.state, restored.end_reason, restored.superseded_by], ['ended', `superseded by ${successor}`, successor.toLowerCase()]);
});

test('retire: an explicit superseded_by wins, and a restored (unknown) session can be retired without a push', async (t) => {
  const f = await retireFixture(t);
  f.claude.complete(); await tick();
  await f.service.retire(f.row.session_key, 'replaced', { superseded_by: 'fm:11111111-2222-4333-8444-555555555555' });
  assert.equal(f.service.detail(f.row.session_key).session.superseded_by, 'fm:11111111-2222-4333-8444-555555555555');
  await assert.rejects(f.service.retire(f.row.session_key, 'x', { superseded_by: 'not a key' }), /superseded_by/);
  const other = await f.service.create({ ...f.input, id: 'other' }); await tick();
  f.service.close();
  const { Notifier } = await import('../server/notifier.ts');
  const loaded = new SessionService({ home: f.home }); t.after(() => loaded.close());
  const frames: any[] = []; const n = new Notifier({ sessions: loaded, send: (frame) => frames.push(frame), host: 'h' }).start(); t.after(() => n.close());
  assert.equal(loaded.detail(other.session_key).session.state, 'unknown');
  await loaded.retire(other.session_key, 'restarted');
  assert.deepEqual([loaded.detail(other.session_key).session.state, loaded.detail(other.session_key).session.end_reason], ['ended', 'restarted']);
  assert.deepEqual(frames, []);
});

test('retire: a working session is refused without force; force interrupts, then retires with no session_failed', async (t) => {
  const f = await retireFixture(t);
  assert.equal(f.service.detail(f.row.session_key).session.state, 'working');
  f.service.send(f.row.session_key, 'queued follow-up', 'follow');
  await assert.rejects(f.service.retire(f.row.session_key, 'superseded'), /working.*force/);
  assert.equal(f.claude.closed, false); assert.equal(f.service.detail(f.row.session_key).session.state, 'working');
  await f.service.retire(f.row.session_key, 'superseded', { force: true });
  assert.equal(f.claude.interrupted, 1); assert.equal(f.claude.closed, true);
  const detail = f.service.detail(f.row.session_key);
  assert.deepEqual([detail.session.state, detail.session.end_reason], ['ended', 'superseded']);
  assert.deepEqual(detail.receipts.map((r) => r.status), ['failed', 'failed'], 'the interrupted turn failed; the queued follow-up never ran');
  assert.equal(f.claude.sent.length, 1, 'nothing is dispatched after retirement');
  assert.deepEqual(f.kinds(), []);
});

test('retire: a session still starting is refused without force, and with force never becomes ready', async (t) => {
  let release!: (value: any) => void;
  const { Notifier } = await import('../server/notifier.ts');
  const f = fixture(t, { prepare: () => new Promise((resolve) => { release = resolve; }) });
  const frames: any[] = []; const n = new Notifier({ sessions: f.service, send: (frame) => frames.push(frame), host: 'h' }).start(); t.after(() => n.close());
  const row = await f.service.create(f.input); await tick();
  await assert.rejects(f.service.retire(row.session_key, 'cancel'), /force/);
  await f.service.retire(row.session_key, 'cancel', { force: true });
  let cleaned = 0; release({ cleanup: () => { cleaned++; } }); await tick(); await tick();
  const detail = f.service.detail(row.session_key);
  assert.deepEqual([detail.session.state, detail.session.alive, detail.session.capabilities.message], ['ended', false, false]);
  assert.deepEqual(detail.receipts.map((r) => r.status), ['failed']);
  assert.equal(f.claude.sent.length, 0); assert.equal(cleaned, 1); assert.deepEqual(frames, []);
});

// #221: managed Claude sessions expose tool activity in the shape the web reads for the Coordinator.
const toolUse = (uuid: string, blocks: any[], extra: Record<string, any> = {}) => ({ type: 'assistant', uuid, session_id: 'native-claude', parent_tool_use_id: null, message: { content: blocks }, ...extra });
const toolResult = (id: string) => ({ type: 'user', session_id: 'native-claude', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

test('a managed Claude session records its tool calls as short redacted tool entries and sets then clears current_tool', async (t) => {
  const { service, claude, input } = fixture(t); const session = await service.create(input); await tick();
  const key = session.session_key;
  const prompt = `Fix the login bug. Use token=${'a'.repeat(40)} and write a very long brief ${'x'.repeat(5000)}`;
  claude.emit('message', toolUse('m1', [{ type: 'text', text: 'Starting a worker.' }, { type: 'tool_use', id: 'tu-spawn', name: 'mcp__lead__spawn_session', input: { name: 'fix-login', prompt, cwd: '/work/app' } }]));
  let detail = service.detail(key);
  assert.equal(detail.session.current_tool, 'mcp__lead__spawn_session');
  assert.equal(service.list().find((s) => s.session_key === key)!.current_tool, 'mcp__lead__spawn_session');
  const spawn = detail.history.find((entry) => entry.role === 'tool')!;
  assert.deepEqual({ role: spawn.role, name: spawn.name, summary: spawn.summary, text: spawn.text }, { role: 'tool', name: 'mcp__lead__spawn_session', summary: 'fix-login', text: 'fix-login' });
  assert.equal(JSON.stringify(detail.history).includes('Fix the login bug'), false, 'the worker prompt is not recorded');
  // The result ends that call; a redelivered assistant message does not record it twice.
  claude.emit('message', toolResult('tu-spawn'));
  assert.equal(service.detail(key).session.current_tool, null);
  claude.emit('message', toolUse('m1', [{ type: 'tool_use', id: 'tu-spawn', name: 'mcp__lead__spawn_session', input: { name: 'fix-login', prompt } }]));
  claude.emit('message', toolResult('tu-spawn'));
  assert.equal(service.detail(key).history.filter((entry) => entry.id === 'claude-tool:tu-spawn').length, 1);
  // Commands are redacted and bounded; a subagent's own tool calls are not recorded.
  claude.emit('message', toolUse('m2', [{ type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: `curl -H "Authorization: Bearer ${'s3cr3t'.repeat(8)}" https://api.example.com/${'p'.repeat(400)}` } }]));
  claude.emit('message', toolUse('m3', [{ type: 'tool_use', id: 'tu-sub', name: 'Read', input: { file_path: '/inside/subagent.ts' } }], { parent_tool_use_id: 'tu-bash' }));
  detail = service.detail(key);
  assert.equal(detail.session.current_tool, 'Bash');
  const bash = detail.history.find((entry) => entry.id === 'claude-tool:tu-bash')!;
  assert.equal(bash.name, 'Bash'); assert.match(bash.summary!, /^curl -H "Authorization: Bearer \[REDACTED\]"/); assert.ok(bash.summary!.length <= 160);
  assert.equal(detail.history.some((entry) => entry.id === 'claude-tool:tu-sub'), false);
  assert.equal(JSON.stringify(detail.history).includes('s3cr3t'), false);
  // The turn ends while the call never returned: current_tool is cleared.
  claude.complete(); await tick();
  detail = service.detail(key);
  assert.equal(detail.session.current_tool, null); assert.equal(detail.session.state, 'turn_finished');
  assert.deepEqual(detail.history.map((entry) => entry.role), ['user', 'assistant', 'tool', 'tool', 'assistant']);
});

test('Claude tool summaries name the target, never the payload, in the Coordinator shape', () => {
  const secret = `password=${'hunter2'.repeat(3)}`;
  assert.equal(claudeToolSummary('Write', { file_path: '/work/app/.env', content: secret }), '/work/app/.env');
  assert.equal(claudeToolSummary('Edit', { file_path: '/work/app/a.ts', old_string: secret, new_string: 'x' }), '/work/app/a.ts');
  assert.equal(claudeToolSummary('Agent', { subagent_type: 'investigator', description: 'Check PR #156', prompt: secret }), 'investigator: Check PR #156');
  assert.equal(claudeToolSummary('SendMessage', { to: 'fm:abc', message: secret }), '→ fm:abc');
  assert.equal(claudeToolSummary('mcp__lead__write_handoff', { kind: 'final', status: 'done', summary: secret }), 'final · done');
  assert.equal(claudeToolSummary('TodoWrite', { todos: [{ content: secret }] }), '');
  assert.equal(claudeToolSummary('ToolSearch', { query: 'select:mcp__lead__spawn_session' }), '{"query":"select:mcp__lead__spawn_session"}');
  const other = claudeToolSummary('mcp__custom__tool', { token: 'a'.repeat(50), data: 'y'.repeat(1000) });
  assert.match(other, /"token":"\[REDACTED\]"/); assert.equal(other.length, 160);
});

test('tool entries never push the conversation out of a managed session snapshot', async (t) => {
  const { service, claude, input } = fixture(t); const session = await service.create(input); await tick();
  const key = session.session_key;
  for (let i = 0; i < 450; i++) claude.emit('message', toolUse(`m${i}`, [{ type: 'tool_use', id: `tu-${i}`, name: 'Read', input: { file_path: `/work/app/file-${i}.ts` } }]));
  claude.complete(); await tick();
  const history = service.detail(key).history;
  assert.equal(history[0].text, 'First task'); assert.equal(history.at(-1)!.text, 'Finished work');
  const tools = history.filter((entry) => entry.role === 'tool');
  assert.equal(tools.length, 200); assert.equal(tools.at(-1)!.id, 'claude-tool:tu-449');
});
