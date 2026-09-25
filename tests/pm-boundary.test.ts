import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// server/paths.ts reads FOREMAN_HOME at import: pin it to a temp dir before loading any server module.
const root = mkdtempSync(join(tmpdir(), 'foreman-pm-boundary-'));
process.env.FOREMAN_HOME = join(root, 'foreman');
test.after(() => rmSync(root, { recursive: true, force: true }));
const { ProjectManager } = await import('../server/pm.ts');
const { LocalPmStore } = await import('../server/pm-store.ts');
const { PM_MEMORY_TOOLS } = await import('../shared/pm-state.ts');

test('PM pre-tool hook enforces docs only, denies every write and PM memory files, even for auto-approved tools, shell escapes, and symlinks', async () => {
  const foremanHome = process.env.FOREMAN_HOME!;
  const memory = join(foremanHome, 'memory'), project = join(root, 'project');
  mkdirSync(memory, { recursive: true }); mkdirSync(project);
  const secret = join(foremanHome, 'cloud.json'), document = join(project, 'README.md');
  writeFileSync(secret, '{"token":"private"}'); writeFileSync(document, '# Project');
  writeFileSync(join(memory, 'PROJECTS.md'), '# Memory'); writeFileSync(join(project, 'index.ts'), 'code');
  symlinkSync(secret, join(project, 'misleading.md')); symlinkSync(project, join(memory, 'escape'));
  symlinkSync(secret, join(memory, 'secret.md'));
  const pm = new ProjectManager({} as any);
  const guard = (pm as any).canUseTool;
  const hook = (pm as any).enforceToolBoundary;
  const deny = async (name: string, input: any) => {
    assert.equal((await guard(name, input)).behavior, 'deny', `${name} ${JSON.stringify(input)}`);
    const result = await hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input });
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  };
  for (const command of ['pwd', 'pwd > index.ts', 'pwd\nrm file', 'git branch -D main', 'git remote set-url origin x', 'ls || touch file']) await deny('Bash', { command });
  await deny('Read', { file_path: secret });
  await deny('Read', { file_path: 'cloud.json' });
  await deny('Read', { file_path: join(project, 'misleading.md') });
  await deny('Read', { file_path: join(memory, 'secret.md') });
  await deny('Read', { file_path: join(project, 'index.ts') });
  await deny('Glob', { pattern: '**/*' }); await deny('Grep', { pattern: 'token', path: foremanHome });
  await deny('Write', { file_path: join(memory, 'escape', 'new.md') });
  await deny('Edit', { file_path: join(memory, 'secret.md') });
  // Epic #26: PM memory is reachable only through the memory tools. The memory directory is
  // part of FOREMAN_HOME (denied to Read), and writes are denied everywhere.
  await deny('Read', { file_path: join(memory, 'PROJECTS.md') });
  await deny('Read', { file_path: 'memory/PROJECTS.md' });
  for (const name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    await deny(name, { file_path: join(memory, 'NEW.md') });
    await deny(name, { file_path: 'memory/NEW.md' });
    await deny(name, { file_path: join(memory, 'PROJECTS.md') });
    await deny(name, { file_path: join(project, 'NOTES.md') });
  }
  const writeDenial = (await guard('Write', { file_path: join(memory, 'NEW.md') })).message;
  assert.match(writeDenial, /memory_write/);
  assert.equal((await guard('Read', { file_path: document })).behavior, 'allow');
  assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: document } }), {});
  assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__peers__session_state', tool_input: {} }), {});
  for (const tool of PM_MEMORY_TOOLS) {
    assert.equal((await guard(tool, { doc: 'projects' })).behavior, 'allow', tool);
    assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {} }), {});
  }
  // The bypass-launch denial is unchanged.
  await deny('mcp__fleet__spawn_session', { permission_mode: 'bypass' });
  await deny('Agent', { prompt: 'x' });
});

test('the PM session allows the four memory tools, keeps code tools disallowed, and serves memory through the fleet server', async (t) => {
  const home = mkdtempSync(join(root, 'store-'));
  const store = new LocalPmStore({ identity: { machine_id: '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', name: 'test-mac' }, home, log: () => {} });
  const pm = new ProjectManager({} as any, { machineName: 'test-mac' });
  pm.attach(store, { autoStart: false });
  let options: any;
  let finish!: () => void; const done = new Promise<void>((r) => { finish = r; });
  (pm as any).queryFactory = (args: any) => { options = args.options; return { close: finish, async *[Symbol.asyncIterator]() { await done; } }; };
  const running = pm.start();
  t.after(async () => { pm.close(); await running; });
  for (let i = 0; i < 50 && !options; i++) await new Promise((r) => setTimeout(r, 5));
  for (const tool of PM_MEMORY_TOOLS) assert.ok(options.allowedTools.includes(tool), tool);
  assert.equal(options.allowedTools.filter((tool: string) => tool === 'mcp__fleet__log_note').length, 1);
  assert.deepEqual(options.disallowedTools, ['Agent', 'Bash', 'Glob', 'Grep']);
  assert.equal('resume' in options, false);
  const tools = Object.keys((options.mcpServers.fleet.instance as any)._registeredTools);
  for (const name of ['memory_read', 'memory_write', 'memory_edit', 'log_note']) assert.ok(tools.includes(name), name);
});
