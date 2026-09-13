import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('PM pre-tool hook enforces docs and memory even for auto-approved tools, shell escapes, and symlinks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'foreman-pm-boundary-'));
  const previous = process.env.FOREMAN_HOME;
  process.env.FOREMAN_HOME = join(root, 'foreman');
  const memory = join(process.env.FOREMAN_HOME, 'memory'), project = join(root, 'project');
  mkdirSync(memory, { recursive: true }); mkdirSync(project);
  const secret = join(process.env.FOREMAN_HOME, 'cloud.json'), document = join(project, 'README.md');
  writeFileSync(secret, '{"token":"private"}'); writeFileSync(document, '# Project');
  writeFileSync(join(memory, 'PROJECTS.md'), '# Memory'); writeFileSync(join(project, 'index.ts'), 'code');
  symlinkSync(secret, join(project, 'misleading.md')); symlinkSync(project, join(memory, 'escape'));
  symlinkSync(secret, join(memory, 'secret.md'));
  try {
    const { ProjectManager } = await import('../server/pm.ts');
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
    await deny('Glob', { pattern: '**/*' }); await deny('Grep', { pattern: 'token', path: process.env.FOREMAN_HOME });
    await deny('Write', { file_path: join(memory, 'escape', 'new.md') });
    await deny('Edit', { file_path: join(memory, 'secret.md') });
    assert.equal((await guard('Read', { file_path: document })).behavior, 'allow');
    assert.equal((await guard('Read', { file_path: join(memory, 'PROJECTS.md') })).behavior, 'allow');
    assert.equal((await guard('Write', { file_path: join(memory, 'NEW.md') })).behavior, 'allow');
    assert.equal((await guard('Write', { file_path: 'memory/NEW.md' })).behavior, 'allow');
    assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: document } }), {});
    assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__peers__session_state', tool_input: {} }), {});
  } finally { if (previous === undefined) delete process.env.FOREMAN_HOME; else process.env.FOREMAN_HOME = previous; rmSync(root, { recursive: true, force: true }); }
});
