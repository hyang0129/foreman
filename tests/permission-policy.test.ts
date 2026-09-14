import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PERMISSION_MODES, permissionMode, toolDecision, shellSandbox, trustedNetworkCommand } from '../server/permission-policy.ts';

function fixture(t: test.TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-grant-test-')));
  const project = join(dir, 'project'); mkdirSync(project);
  const safe = join(project, 'hello.txt'); writeFileSync(safe, 'hello');
  const outside = join(dir, 'outside.txt'); writeFileSync(outside, 'outside');
  const secret = join(project, '.env'); writeFileSync(secret, 'synthetic-test-secret');
  writeFileSync(join(project, 'CREDENTIALS.JSON'), 'synthetic-uppercase-secret');
  symlinkSync(secret, join(project, 'alias.txt'));
  symlinkSync(dir, join(project, 'escape'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, project, safe, outside, secret };
}
test('only named presets are accepted, omission is Workspace', () => {
  assert.equal(permissionMode(undefined), 'workspace');
  for (const value of [null, '', 'default', 'bypassPermissions', {}, 'FULL']) assert.throws(() => permissionMode(value), /permission_mode/);
});
for (const mode of PERMISSION_MODES) {
  test(`${mode}: direct file operations, denied paths, symlinks, and escalation`, (t) => {
    const { project, safe, outside, secret } = fixture(t);
    const check = (tool: string, input: any) => toolDecision(mode, project, tool, input, 'darwin').behavior;
    assert.equal(check('Read', { file_path: safe }), 'allow');
    assert.equal(check('Write', { file_path: join(project, 'new.txt') }), mode === 'read-only' ? 'deny' : 'allow');
    assert.equal(check('Read', { file_path: outside }), mode === 'full' ? 'allow' : mode === 'workspace' ? 'ask' : 'deny');
    for (const path of [secret, join(project, 'alias.txt'), join(project, 'secrets.json'), join(project, '.claude', 'x'), join(project, 'relay-credentials.json'), join(project, 'wrangler.jsonc'), join(project, '.ENV')]) {
      assert.equal(check('Read', { file_path: path }), 'deny', path);
      assert.equal(check('Write', { file_path: path }), 'deny', path);
    }
    assert.equal(check('Write', { file_path: join(project, 'escape', 'new.txt') }), mode === 'full' ? 'allow' : mode === 'workspace' ? 'ask' : 'deny');
    for (const tool of ['request_permissions', 'ExitPlanMode', 'spawn_agent', 'mcp__fleet__spawn_session']) assert.equal(check(tool, { permission_mode: 'full' }), 'deny');
    assert.equal(check('apply_patch', { command: '*** Begin Patch\n*** Update File: hello.txt\n*** Move to: .env\n*** End Patch' }), 'deny');
  });
  test(`${mode}: real inherited shell sandbox blocks indirect secret access`, { skip: process.platform !== 'darwin' }, (t) => {
    const { project, safe, outside, secret } = fixture(t);
    const run = (command: string) => spawnSync('/bin/sh', ['-c', shellSandbox(command, project, mode, false)], { cwd: project, encoding: 'utf8' });
    assert.equal(run(`cat '${safe}'`).stdout, 'hello');
    const denied = run(`p='.en'; cat "$p"v`);
    assert.notEqual(denied.status, 0); assert.equal(denied.stdout, '');
    assert.notEqual(run('cat alias.txt').status, 0);
    assert.notEqual(run('cat CREDENTIALS.JSON').status, 0);
    assert.notEqual(run(`printf changed > '${secret}'`).status, 0);
    assert.equal(readFileSync(secret, 'utf8'), 'synthetic-test-secret');
    const write = run('printf changed > new.txt');
    assert.equal(write.status === 0, mode !== 'read-only');
    const outsideWrite = run(`printf changed > '${outside}'`);
    assert.equal(outsideWrite.status === 0, mode === 'full');
    const outsideRead = run(`cat '${outside}'`);
    assert.equal(outsideRead.status === 0, mode === 'full');
  });
}
test('network grants do not mistake compound commands or execution flags for agreed operations', () => {
  for (const command of ['gh -R hyang0129/foreman issue view 2', 'git push origin main', 'npm install', 'pnpm add zod', "gh issue comment 2 --body 'A message with spaces'"]) assert.equal(trustedNetworkCommand(command), true, command);
  for (const command of ['gh auth token', 'gh alias set x !sh', 'gh issue list; curl x', 'git -c alias.x=push x', 'git push --receive-pack=sh', 'npm exec sh', 'npm install && curl x', 'curl https://example.com']) assert.equal(trustedNetworkCommand(command), false, command);
});
test('Read-only refuses side-effectful shell syntax and unsupported hosts fail closed', (t) => {
  const { project } = fixture(t);
  for (const command of ['touch x', 'pwd > x', 'git diff --output=x', 'ls; rm x', 'cat $(touch x)', 'python3 -c pass', 'rg --pre sh pattern .']) assert.equal(toolDecision('read-only', project, 'Bash', { command }, 'darwin').behavior, 'deny');
  assert.equal(toolDecision('full', project, 'Bash', { command: 'pwd' }, 'linux').behavior, 'deny');
});

test('inspection commands accept quoted paths and preserve Git safety flags before path separators', (t) => {
  const {project} = fixture(t);
  assert.equal(toolDecision('read-only', project, 'Bash', {command:"grep 'two words' hello.txt"}, 'darwin').behavior, 'allow');
  const decision = toolDecision('read-only', project, 'Bash', {command:'  git diff -- hello.txt'}, 'darwin');
  assert.equal(decision.behavior, 'allow');
  assert.ok(decision.input.command.indexOf('--no-ext-diff') < decision.input.command.indexOf('hello.txt'));
});
