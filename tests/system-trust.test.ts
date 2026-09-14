import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PERMISSION_MODES, protectedPath, quote, shellSandbox, toolDecision } from '../server/permission-policy.ts';

function fixture(t: test.TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-trust-test-')));
  const project = join(dir, 'project'); mkdirSync(project);
  const roots = [project, join(project, '.foreman-tmp'), join(dir, 'temporary'), join(dir, 'home', 'owner')];
  const paths: string[] = [];
  for (const root of roots) {
    mkdirSync(root, { recursive: true });
    // Include lookalike system paths: a suffix match must never confer a grant.
    for (const name of ['private.pem', 'private.key', 'PRIVATE.PEM', 'private.p12', 'private.pfx', '.credentials.json', 'etc/ssl/cert.pem', 'etc/ssl/certs/public.pem']) {
      const path = join(root, name); mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, 'synthetic-private-material'); paths.push(path);
    }
  }
  symlinkSync(paths[0], join(project, 'key-alias')); paths.push(join(project, 'key-alias'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { project, paths };
}

for (const mode of PERMISSION_MODES) {
  test(`${mode}: private material stays denied in project, temp, and home fixtures`, (t) => {
    const { project, paths } = fixture(t);
    for (const path of paths) for (const tool of ['Read', 'Write']) {
      assert.equal(toolDecision(mode, project, tool, { file_path: path }, 'darwin').behavior, 'deny', `${tool} ${path}`);
    }
  });
  test(`${mode}: Seatbelt preserves private material denial including approved Workspace`, { skip: process.platform !== 'darwin' }, (t) => {
    const { project, paths } = fixture(t);
    const run = (command: string) => spawnSync('/bin/sh', ['-c', shellSandbox(command, project, mode, false, undefined, undefined, mode === 'workspace')], { cwd: project, encoding: 'utf8' });
    for (const path of paths) {
      for (const command of [`cat ${quote(path)}`, `printf changed > ${quote(path)}`]) {
        const result = run(command);
        assert.equal(result.signal, null, command);
        assert.notEqual(result.status, 0, command);
        assert.match(result.stderr, /Operation not permitted|Permission denied/, command);
        assert.equal(result.stdout, '', command);
      }
      assert.equal(readFileSync(path, 'utf8'), 'synthetic-private-material');
    }
  });
  test(`${mode}: native system trust anchors are readable and never writable`, { skip: process.platform !== 'darwin' }, (t) => {
    const { project } = fixture(t);
    for (const path of ['/etc/ssl/cert.pem', '/private/etc/ssl/cert.pem', '/etc/ssl/certs', '/private/etc/ssl/certs']) {
      assert.equal(toolDecision(mode, project, 'Read', { file_path: path }, 'darwin').behavior, 'allow', path);
      for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
        assert.equal(toolDecision(mode, project, tool, { file_path: path }, 'darwin').behavior, 'deny', `${tool} ${path}`);
      }
      assert.equal(toolDecision(mode, project, 'apply_patch', { patch: `*** Update File: ${path}` }, 'darwin').behavior, 'deny');
    }
    symlinkSync('/etc/ssl/cert.pem', join(project, 'public-ca'));
    assert.equal(toolDecision(mode, project, 'Read', { file_path: join(project, 'public-ca') }, 'darwin').behavior, 'allow');
    assert.equal(toolDecision(mode, project, 'Write', { file_path: join(project, 'public-ca') }, 'darwin').behavior, 'deny');
  });
  test(`${mode}: actual sandbox reads system CA and denies write permission`, { skip: process.platform !== 'darwin' }, (t) => {
    const { project } = fixture(t);
    const run = (command: string) => spawnSync('/bin/sh', ['-c', shellSandbox(command, project, mode, false, undefined, undefined, mode === 'workspace')], { cwd: project, encoding: 'utf8' });
    for (const path of ['/etc/ssl/cert.pem', '/private/etc/ssl/cert.pem']) {
      const result = run(`cat ${quote(path)}`);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, readFileSync(path, 'utf8'));
    }
    // Ask the kernel about this process's sandbox permission, independently of
    // root ownership/mode bits. Never open OS trust data for writing or mutate it.
    const helper = join(project, 'sandbox-check'); copyFileSync(sandboxCheck(), helper);
    for (const path of ['/etc/ssl/cert.pem', '/private/etc/ssl/cert.pem', '/etc/ssl/certs', '/private/etc/ssl/certs']) {
      // sandbox_check is exercised by a small compiled helper supplied below.
      const unsandboxed = spawnSync(helper, [path, '0'], { encoding: 'utf8' });
      assert.equal(unsandboxed.status, 0, 'Control: OS ownership alone must not report a sandbox denial');
      const result = run(`${quote(helper)} ${quote(path)} 1`);
      assert.equal(result.status, 0, `${path}: ${result.stdout}${result.stderr}`);
    }
    writeFileSync(join(project, 'ordinary.txt'), 'public fixture');
    const control = run(`${quote(helper)} ${quote(join(project, 'ordinary.txt'))} ${mode === 'read-only' ? 1 : 0}`);
    assert.equal(control.status, 0, control.stderr);
    for (const path of ['/etc/ssl/certs', '/private/etc/ssl/certs']) {
      const listing = run(`ls ${quote(path)}`); assert.equal(listing.status, 0, listing.stderr);
    }
  });
}

let checkBinary: string;
function sandboxCheck() {
  if (checkBinary) return checkBinary;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-sandbox-check-')));
  // /tmp isn't readable at restricted presets; compile once, then copy into
  // each project below instead of granting a runtime root to the helper.
  const source = join(dir, 'check.c');
  writeFileSync(source, '#include <unistd.h>\nextern int sandbox_check(int, const char *, int, ...);\nint main(int argc, char **argv) { if (argc != 3) return 2; int result = sandbox_check(getpid(), "file-write-data", 1, argv[1]); return argv[2][0] == 49 ? result <= 0 : result != 0; }\n');
  const result = spawnSync('/usr/bin/cc', [source, '-o', join(dir, 'check')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  checkBinary = join(dir, 'check');
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return checkBinary;
}

test('system PEM exception is anchored and preserves other protected families', () => {
  for (const path of ['/etc/ssl/other.pem', '/etc/ssl/certs-evil/a.pem', '/tmp/etc/ssl/cert.pem', '/etc/ssl/certs/../private.pem', '/etc/ssl/certs/.env', '/etc/ssl/certs/private.key', '/etc/ssl/certs/secrets.pem', '/etc/ssl/certs/.credentials.json', '/etc/ssl/certs/.ssh/public.pem']) {
    assert.equal(protectedPath(path), true, path);
  }
  assert.equal(protectedPath('/etc/ssl/certs/public.pem'), false);
  assert.equal(protectedPath('/private/etc/ssl/certs/public.pem'), false);
});
