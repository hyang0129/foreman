// Pin FOREMAN_HOME to a temp dir before any server module loads (story #121 guard).
import './fixtures/temp-foreman-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Launcher, DEFAULT_LAUNCHER_MODEL } from '../server/launcher.ts';
import { ProjectRegistry } from '../server/projects.ts';

function setup(t: any) {
  const home = mkdtempSync(join(tmpdir(), 'foreman-launch-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'project'); mkdirSync(path);
  const projects = new ProjectRegistry(home), project = projects.register({ name: 'personal', path });
  const value = { project: project.id, provider: 'codex', model: 'codex-model', name: 'fix-sign-in', text: 'Repair sign-in and verify tests.', reason: 'Suited to implementation.' };
  const catalog = { list: async (provider: string) => [{ value: `${provider}-model`, displayName: provider }] };
  return { home, path, project, projects, value, catalog };
}
async function settled(launcher: Launcher, id: string) {
  for (let i = 0; i < 100; i++) { const job = launcher.get(id); if (job.status !== 'working') return job; await delay(5); }
  throw new Error('Launcher never settled');
}
const stream = (value: unknown) => Object.assign((async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: typeof value === 'string' ? value : JSON.stringify(value) } as any; })(), { close() {} });
test('launcher runs exact default with no capabilities and validates canonical proposal without creating work', async (t) => {
  const f = setup(t); let calls = 0, cwd = '';
  const launcher = new Launcher(f.projects, { catalog: f.catalog, query: ({ options, prompt }) => {
    calls++; cwd = options.cwd!;
    assert.equal(options.model, DEFAULT_LAUNCHER_MODEL); assert.equal(options.model, 'claude-sonnet-5');
    assert.deepEqual(options.tools, []); assert.deepEqual(options.mcpServers, {}); assert.equal(options.strictMcpConfig, true);
    assert.deepEqual(options.settingSources, []); assert.deepEqual(options.skills, []); assert.deepEqual(options.plugins, []);
    assert.equal(options.persistSession, false); assert.equal(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.equal(options.canUseTool, undefined); assert.equal(options.hooks, undefined); assert.equal(options.permissionMode, undefined);
    assert.notEqual(cwd, f.path); assert.ok(existsSync(cwd));
    assert.equal(JSON.parse(prompt).projects[0].id, f.project.id);
    return stream(f.value);
  } });
  const id = randomUUID(), request = { id, brief: 'Fix sign-in in personal' };
  launcher.start(request); launcher.start(request);
  const result = await settled(launcher, id);
  assert.equal(result.status, 'ready'); assert.equal(result.proposal?.cwd, f.projects.require('personal').path);
  assert.equal(result.proposal?.model, 'codex-model'); assert.equal(result.proposal?.project, 'personal'); assert.equal(calls, 1);
  assert.equal(existsSync(cwd), false); assert.equal(existsSync(join(f.home, 'sessions')), false);
  assert.throws(() => launcher.start({ ...request, brief: 'different' }), /different brief/);
  launcher.close();
});
for (const [label, change, match] of [
  ['policy injection', { permission_mode: 'bypass' }, /unsupported/],
  ['tool injection', { command: 'touch marker' }, /unsupported/],
  ['unregistered path', { project: '/tmp' }, /registered project/],
  ['unknown model', { model: 'invented' }, /unavailable provider or model/],
  ['unknown provider', { provider: 'invented' }, /unavailable provider or model/],
  ['invalid name', { name: 'Not Kebab' }, /kebab-case/],
  ['empty task', { text: '' }, /first task/],
] as const) test(`launcher rejects ${label}`, async (t) => {
  const f = setup(t), launcher = new Launcher(f.projects, { catalog: f.catalog, query: () => stream({ ...f.value, ...change }) });
  const { id } = launcher.start({ id: randomUUID(), brief: 'fixture' });
  const result = await settled(launcher, id); assert.equal(result.status, 'failed'); assert.match(result.error!, match); assert.equal(result.proposal, undefined); launcher.close();
});
for (const [text, message] of [['not json', /unusable/], [JSON.stringify({ question: 'Which personal project do you mean?' }), /Which personal/], ['x'.repeat(100_001), /too much/]] as const) test(`launcher recovers from ${message}`, async (t) => {
  const f = setup(t), launcher = new Launcher(f.projects, { catalog: f.catalog, query: () => stream(text) });
  const result = await settled(launcher, launcher.start({ id: randomUUID(), brief: 'fixture' }).id);
  assert.equal(result.status, 'failed'); assert.match(result.error!, message); launcher.close();
});
test('explicit model changes only launcher query and unavailable default never silently substitutes', async (t) => {
  const f = setup(t), models: string[] = [];
  const launcher = new Launcher(f.projects, { catalog: f.catalog, query: ({ options }) => {
    models.push(options.model!);
    return options.model === DEFAULT_LAUNCHER_MODEL ? Object.assign((async function* () { yield { type: 'result', subtype: 'error_during_execution', is_error: true } as any; })(), { close() {} }) : stream(f.value);
  } });
  let result = await settled(launcher, launcher.start({ id: randomUUID(), brief: 'fixture' }).id);
  assert.equal(result.status, 'failed'); assert.match(result.error!, /claude-sonnet-5/);
  result = await settled(launcher, launcher.start({ id: randomUUID(), brief: 'fixture', model: 'claude-model' }).id);
  assert.equal(result.status, 'ready'); assert.deepEqual(models, ['claude-sonnet-5', 'claude-model']); assert.equal(result.proposal?.model, 'codex-model'); launcher.close();
});
test('cancellation overtakes POST, during catalog wait and in-flight SDK; delayed results never win', async (t) => {
  const f = setup(t); let calls = 0, closed = 0, release!: () => void;
  const pending = new Promise<void>((r) => { release = r; });
  const launcher = new Launcher(f.projects, { catalog: f.catalog, query: () => {
    calls++; return Object.assign((async function* () { await pending; yield { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(f.value) } as any; })(), { close() { closed++; } });
  } });
  const early = randomUUID(); launcher.cancel(early); assert.equal(launcher.start({ id: early, brief: 'fixture' }).status, 'cancelled');
  const beforeCatalog = launcher.start({ id: randomUUID(), brief: 'fixture' }).id; launcher.cancel(beforeCatalog); await delay(5); assert.equal(calls, 0);
  const during = launcher.start({ id: randomUUID(), brief: 'fixture' }).id; await delay(5); assert.equal(calls, 1);
  launcher.cancel(during); assert.equal(closed, 1); release(); await delay(10);
  assert.equal(launcher.get(during).status, 'cancelled'); assert.equal(launcher.get(during).proposal, undefined); launcher.close();
});
for (const method of ['timeout', 'close'] as const) test(`${method} aborts the actual active stream`, async (t) => {
  const f = setup(t); let started = false, stopped = false;
  const launcher = new Launcher(f.projects, { catalog: f.catalog, timeoutMs: 30, query: ({ options }) => {
    started = true; return Object.assign((async function* () { await new Promise<void>((resolve) => options.abortController!.signal.addEventListener('abort', () => { stopped = true; resolve(); }, { once: true })); })(), { close() {} });
  } });
  const id = launcher.start({ id: randomUUID(), brief: 'fixture' }).id; await delay(5); assert.equal(started, true);
  if (method === 'close') launcher.close();
  const result = await settled(launcher, id); assert.equal(stopped, true); assert.equal(result.status, method === 'close' ? 'cancelled' : 'failed');
  assert.equal(result.proposal, undefined); launcher.close();
});
test('project deletion and symlink retarget while proposing fail before publishing', async (t) => {
  const f = setup(t), target = join(f.home, 'target'); mkdirSync(target); const link = join(f.home, 'link'); symlinkSync(f.path, link);
  f.projects.register({ name: 'link', path: link });
  for (const change of [() => { rmSync(link); symlinkSync(target, link); }, () => f.projects.remove(f.project.id)]) {
    const launcher = new Launcher(f.projects, { catalog: f.catalog, query: () => { change(); return stream(f.value); } });
    const result = await settled(launcher, launcher.start({ id: randomUUID(), brief: 'fixture' }).id);
    assert.equal(result.status, 'failed'); assert.match(result.error!, /symlink target|Project changed/); launcher.close();
  }
});
test('missing registry/catalog and tool-use output fail explicitly', async (t) => {
  const f = setup(t); let calls = 0;
  const launcher = new Launcher(f.projects, { catalog: { list: async () => { throw new Error('offline'); } }, query: () => { calls++; return stream(f.value); } });
  let result = await settled(launcher, launcher.start({ id: randomUUID(), brief: 'fixture' }).id);
  assert.match(result.error!, /catalogs are unavailable/); assert.equal(calls, 0); launcher.close();
  const tools = new Launcher(f.projects, { catalog: f.catalog, query: () => Object.assign((async function* () { yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } } as any; })(), { close() {} }) });
  result = await settled(tools, tools.start({ id: randomUUID(), brief: 'fixture' }).id);
  assert.match(result.error!, /unsupported tool/); tools.close();
  f.projects.remove(f.project.id);
  const empty = new Launcher(f.projects, { catalog: f.catalog, query: () => { calls++; return stream(f.value); } });
  result = await settled(empty, empty.start({ id: randomUUID(), brief: 'fixture' }).id); assert.match(result.error!, /No registered/); assert.equal(calls, 0); empty.close();
});

test('single observed JSON fence is accepted but prose, multiple fences and fenced policy fields still fail', async (t) => {
  const f = setup(t);
  for (const [text, expected] of [
    ['```json\n' + JSON.stringify(f.value) + '\n```', 'ready'],
    ['Before the proposal\n```json\n' + JSON.stringify(f.value) + '\n```', 'failed'],
    ['```json\n' + JSON.stringify(f.value) + '\n```\n```json\n{}\n```', 'failed'],
    ['```json\n' + JSON.stringify({ ...f.value, permission_mode: 'bypass' }) + '\n```', 'failed'],
  ]) {
    const launcher = new Launcher(f.projects, { catalog: f.catalog, query: () => stream(text) });
    const result = await settled(launcher, launcher.start({ id: randomUUID(), brief: 'fixture' }).id);
    assert.equal(result.status, expected); launcher.close();
  }
});

test('host-generated native IDs are reserved before query and remain excluded after completion, cancellation and restart', async (t) => {
  const f = setup(t), identityFile = join(f.home, 'launcher-sessions.json'); let nativeId = '', launcher: Launcher;
  const id = randomUUID();
  launcher = new Launcher(f.projects, { identityFile, catalog: f.catalog, query: ({ options }) => {
    nativeId = options.sessionId!; assert.ok(nativeId); assert.notEqual(nativeId, id);
    assert.equal(launcher.ownsSession({ provider: 'claude', session_id: nativeId }), true);
    const restarted = new Launcher(f.projects, { identityFile });
    assert.equal(restarted.ownsSession({ provider: 'claude', session_id: nativeId }), true); restarted.close();
    return stream(f.value);
  } });
  assert.equal((await settled(launcher, launcher.start({ id, brief: 'fixture' }).id)).status, 'ready');
  launcher.cancel(id); launcher.close();
  const restarted = new Launcher(f.projects, { identityFile });
  assert.equal(restarted.ownsSession({ provider: 'claude', session_id: nativeId }), true);
  assert.equal(restarted.ownsSession({ provider: 'codex', session_id: nativeId }), false);
  assert.equal(restarted.ownsSession({ provider: 'claude', session_id: id }), false);
  restarted.close();
});
