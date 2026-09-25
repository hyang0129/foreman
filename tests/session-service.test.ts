// Pin FOREMAN_HOME to a temp dir before any server module loads (story #121 guard).
import './fixtures/temp-foreman-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionService } from '../server/session-service.ts';

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
