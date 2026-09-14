import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PolicyCommands } from '../server/policy-commands.ts';

for (const mode of ['read-only','workspace','trusted','full'] as const) {
  test(`Codex command execution at ${mode} proceeds or refuses without silently widening`, { skip: process.platform !== 'darwin' }, async (t) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-command-test-')));
    const project = join(dir, 'project'); mkdirSync(project);
    const outside = join(dir, 'outside.txt'); writeFileSync(outside, 'outside');
    writeFileSync(join(project, '.env'), 'synthetic-secret'); writeFileSync(join(project, 'hello.txt'), 'hello');
    let approvals = 0;
    const runner = new PolicyCommands(mode, project, async () => { approvals++; return true; });
    t.after(() => { runner.close(); rmSync(dir, { recursive: true, force: true }); });
    const exec = (command: string, extra: any = {}) => runner.call('foreman_exec', { command, yield_ms: 5000, ...extra });
    assert.equal((await exec('cat hello.txt')).output, 'hello');
    assert.equal(approvals, 0);
    if (mode === 'read-only') await assert.rejects(exec('printf changed > new.txt'), /Read-only/);
    else assert.equal((await exec('printf changed > new.txt')).exit_code, 0);
    const secret = await exec('cat .env'); assert.notEqual(secret.exit_code, 0); assert.doesNotMatch(secret.output, /synthetic-secret/);
    if (mode !== 'read-only') {
      const indirect = await exec('p=.en; cat "$p"v'); assert.notEqual(indirect.exit_code, 0); assert.doesNotMatch(indirect.output, /synthetic-secret/);
    }
    await assert.rejects(exec('pwd', { permission_mode: 'full' }), /cannot be changed/);
    if (mode === 'read-only' || mode === 'trusted') await assert.rejects(exec('pwd', { request_access: true }), /refuses/);
    if (mode === 'workspace') {
      assert.notEqual((await exec(`cat ${outside}`)).exit_code, 0);
      assert.equal((await exec(`cat ${outside}`, { request_access: true })).output, 'outside');
      assert.equal(approvals, 1);
      assert.notEqual((await exec(`cat ${outside}`)).exit_code, 0);
      const denied = await exec('cat .env', { request_access: true }); assert.notEqual(denied.exit_code, 0); assert.doesNotMatch(denied.output, /synthetic-secret/);
    }
    assert.equal(readFileSync(join(project, '.env'), 'utf8'), 'synthetic-secret');
  });
}
test('Trusted installs work in the project without altering the repo dependencies', { skip: process.platform !== 'darwin' }, async (t) => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-install-test-')));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({name:'fixture', version:'1.0.0', private:true}));
  const runner = new PolicyCommands('trusted', cwd, async () => { throw new Error('Must not prompt'); });
  t.after(() => { runner.close(); rmSync(cwd, { recursive:true, force:true }); });
  const result = await runner.call('foreman_exec', {command:'npm install --ignore-scripts --no-audit --no-fund',yield_ms:10000});
  assert.equal(result.exit_code, 0, result.output);
});
test('command network access and long-running process ownership remain bounded', { skip: process.platform !== 'darwin' }, async (t) => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-network-test-')));
  const server = createServer((_req, res) => res.end('fixture-response'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as any).port;
  const full = new PolicyCommands('full', cwd, async () => { throw new Error('No prompt at Full'); });
  const trusted = new PolicyCommands('trusted', cwd, async () => { throw new Error('No prompt at Trusted'); });
  t.after(() => { full.close(); trusted.close(); server.close(); rmSync(cwd, {recursive:true,force:true}); });
  const command = `curl --max-time 2 http://127.0.0.1:${port}`;
  assert.match((await full.call('foreman_exec', {command,yield_ms:5000})).output, /fixture-response/);
  assert.doesNotMatch((await trusted.call('foreman_exec', {command,yield_ms:5000})).output, /fixture-response/);
  const long = await full.call('foreman_exec', {command:'sleep 30',yield_ms:0});
  assert.ok(long.process_id);
  await assert.rejects(trusted.call('foreman_process',{process_id:long.process_id}), /No such process/);
  await full.call('foreman_process',{process_id:long.process_id,terminate:true,yield_ms:1000});
});
