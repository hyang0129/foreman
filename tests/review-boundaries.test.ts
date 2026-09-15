import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { shellSandbox, toolDecision, protectedPath, permissionMode } from '../server/permission-policy.ts';
import { PolicyCommands } from '../server/policy-commands.ts';
function fixture(t: test.TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-review-')));
  const project = join(dir, 'project'), home = join(dir, 'home');
  mkdirSync(project); mkdirSync(home);
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  return {dir, project, home};
}
test('enforcement coverage requires a macOS host', () => {
  assert.equal(process.platform, 'darwin', 'MANDATORY ENFORCEMENT COVERAGE MISSING: run npm test on macOS; skipped Seatbelt checks are not proof');
});
test('git repository sshCommand cannot consume credential stores or inherited tokens', (t) => {
  const {project, home} = fixture(t);
  mkdirSync(join(home, '.config/gh'), {recursive:true});
  writeFileSync(join(home, '.config/gh/hosts.yml'), 'SYNTHETIC_GH_SECRET');
  const git = (...args: string[]) => assert.equal(spawnSync('/usr/bin/git', args, {cwd:project}).status, 0);
  git('init');
  git('config', 'core.sshCommand', `sh -c 'cat ${home}/.config/gh/hosts.yml > STOLEN; printf "%s" "$GH_TOKEN" >> STOLEN; exit 1'`);
  git('remote', 'add', 'origin', 'ssh://git@github.com/x/y.git');
  const old = process.env.GH_TOKEN; process.env.GH_TOKEN = 'SYNTHETIC_ENV_SECRET';
  try {
    const attempted = spawnSync('/bin/sh', ['-c', shellSandbox('git fetch origin', project, 'trusted', true, home)], {cwd:project, encoding:'utf8', env:{...process.env,HOME:home,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'}});
    assert.ok(existsSync(join(project, 'STOLEN')), attempted.stderr);
    assert.doesNotMatch(readFileSync(join(project, 'STOLEN'), 'utf8'), /SYNTHETIC_.*SECRET/);
  } finally { if (old === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = old; }
});
test('package lifecycle cannot inherit an automatic network grant', {timeout:15000}, async (t) => {
  const {project} = fixture(t);
  let hits = 0; const server = createServer((_req,res) => {hits++;res.end('ok');});
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  writeFileSync(join(project, 'package.json'), JSON.stringify({name:'fixture',version:'1.0.0',scripts:{preinstall:`curl --max-time 2 http://127.0.0.1:${(server.address() as any).port}`}}));
  const runner = new PolicyCommands('trusted', project, async () => false); t.after(() => runner.close());
  const result = await runner.call('foreman_exec', {command:'npm install --no-audit --no-fund',yield_ms:10000});
  assert.equal(hits, 0, JSON.stringify(result));
  assert.notEqual(result.exit_code, 0);
});
test('Workspace stdin cannot extend a one-time interpreter approval', async (t) => {
  const {dir, project} = fixture(t);
  const outside = join(dir, 'outside'); writeFileSync(outside, 'OUTSIDE_TOKEN');
  let approvals = 0; const runner = new PolicyCommands('workspace', project, async () => {approvals++;return true;});
  t.after(() => runner.close());
  const shell = await runner.call('foreman_exec', {command:'sh',request_access:true,yield_ms:0});
  await assert.rejects(runner.call('foreman_process', {process_id:shell.process_id, chars:`cat ${outside}\n`,yield_ms:100}), /stdin.*one-time/i);
  assert.equal(approvals, 1);
});
test('Workspace approval denial prevents execution', async (t) => {
  const {project} = fixture(t); let approvals = 0;
  const runner = new PolicyCommands('workspace', project, async () => {approvals++;return false;}); t.after(() => runner.close());
  await assert.rejects(runner.call('foreman_exec', {command:'touch executed',request_access:true,yield_ms:500}), /denied by the developer/);
  assert.equal(approvals, 1); assert.equal(existsSync(join(project, 'executed')), false);
});
test('Workspace Bash approval preserves confinement unless access is explicitly requested', (t) => {
  const {dir, project} = fixture(t);
  const target = join(dir, 'outside');
  const decision = toolDecision('workspace', project, 'Bash', {command:`touch ${target}`});
  assert.equal(decision.behavior, 'ask');
  const result = spawnSync('/bin/sh', ['-c', decision.input.command], {cwd:project});
  assert.notEqual(result.status, 0); assert.equal(existsSync(target), false);
});
test('standard credential stores are protected at native and kernel boundaries', (t) => {
  const {project, home} = fixture(t);
  for (const name of ['.codex/auth.json','.git-credentials','.npmrc','.netrc','.docker/config.json','.kube/config']) {
    const path = join(home, name); mkdirSync(join(path, '..'), {recursive:true}); writeFileSync(path, 'SYNTHETIC_SECRET');
    assert.equal(protectedPath(path, home), true, name);
    const result = spawnSync('/bin/sh', ['-c', shellSandbox(`cat '${path}'`, project, 'full', true, home)], {encoding:'utf8'});
    assert.notEqual(result.status, 0, name); assert.equal(result.stdout, '', name);
  }
});
test('background Bash is explicitly refused and null defaults to Workspace', (t) => {
  const {project} = fixture(t);
  const result = toolDecision('trusted', project, 'Bash', {command:'sleep 1',run_in_background:true});
  assert.equal(result.behavior, 'deny'); assert.match(result.message, /background/i);
  assert.equal(permissionMode(null), 'workspace');
});

test('completed processes do not exhaust the lifetime command cap', async (t) => {
  const {project} = fixture(t); const runner = new PolicyCommands('trusted', project, async () => false); t.after(() => runner.close());
  for (let i=0;i<100;i++) (runner as any).processes.set(String(i), {done:true,output:'uncollected',code:0});
  assert.equal((await runner.call('foreman_exec', {command:'pwd',yield_ms:1000})).exit_code, 0);
});
test('Trusted temporary caches do not leave project pollution', async (t) => {
  const {project} = fixture(t); const runner = new PolicyCommands('trusted', project, async () => false); t.after(() => runner.close());
  const result = await runner.call('foreman_exec', {command:'printf cache > "$TMPDIR/probe"; test -f "$TMPDIR/probe"',yield_ms:1000});
  assert.equal(result.exit_code, 0);
  assert.equal(existsSync(join(project,'.foreman-tmp')), false);
});

test('local control planes remain unreachable even with a Full network grant', async (t) => {
  const {project} = fixture(t); let hits = 0;
  const server = createServer((_req,res) => {hits++;res.end('CONTROL_PLANE');});
  server.listen(0, '127.0.0.1'); await once(server,'listening'); t.after(() => server.close());
  const runner = new PolicyCommands('full',project,async () => false); t.after(() => runner.close());
  const result = await runner.call('foreman_exec',{command:`curl --max-time 2 http://127.0.0.1:${(server.address() as any).port}`,yield_ms:1000});
  assert.equal(hits,0); assert.notEqual(result.exit_code,0); assert.doesNotMatch(result.output,/CONTROL_PLANE/);
});

test('hard-killed command cache cannot appear in git add -A', async (t) => {
  const {project} = fixture(t);assert.equal(spawnSync('git',['init'],{cwd:project}).status,0);
  const runner=new PolicyCommands('trusted',project,async()=>false);t.after(()=>runner.close());
  const started=await runner.call('foreman_exec',{command:'printf data > "$TMPDIR/cache"; echo ready; sleep 30',yield_ms:100});
  assert.match(started.output,/ready/);
  await runner.call('foreman_process',{process_id:started.process_id,terminate:true,yield_ms:1000});
  assert.equal(spawnSync('git',['status','--porcelain'],{cwd:project,encoding:'utf8'}).stdout,'');
});
