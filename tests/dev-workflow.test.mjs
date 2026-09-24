import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { deploy, start, status, openHome, TARGET, guardEnvironment, processIdentity, dependencyIdentity } from '../scripts/dev-environment.mjs';
const script = realpathSync('scripts/dev-environment.mjs');
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-workflow-')));
  t.after(() => rmSync(dir, {recursive:true,force:true}));
  const home = openHome(dir), source = join(dir, 'source'); mkdirSync(source);
  const git = (...args) => execFileSync('git', ['-C', source, ...args], {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init'); git('config','user.email','fixture@example.com'); git('config','user.name','Fixture');
  mkdirSync(join(source,'web')); mkdirSync(join(source,'node_modules'));
  writeFileSync(join(source,'package-lock.json'),'{}'); writeFileSync(join(source,'web/index.html'),'<title>Test</title><body></body>');
  writeFileSync(join(source,'wrangler.jsonc'),'{ // selected snapshot\n "vars": {"FIREBASE_CONFIG":"snapshot-public-config",},\n "durable_objects": {"bindings": [{"name": "RELAY", "class_name": "HostRelay"}]}, "migrations": [{"tag": "v1", "new_sqlite_classes": ["HostRelay"]}], "assets": {"directory": "./web", "binding": "ASSETS"},\n}');
  const commit = () => {git('add','.'); git('commit','-m','fixture'); return git('rev-parse','HEAD');};
  return {dir,home,source,git,commit};
}
const releases = home => readdirSync(home).filter(n=>n.startsWith('release-'));
const save = (path, value) => writeFileSync(path,JSON.stringify(value),{mode:0o600});
test('startup never copies a production Codex rotating credential and requires an isolated login', async t => {
  const f=fixture(t), release='release-fixture', commit='a'.repeat(40);
  mkdirSync(join(f.home,release),{mode:0o700});
  symlinkSync(join(f.source,'node_modules'),join(f.home,release,'node_modules'));
  save(join(f.home,'deployment.json'),{release,commit,dependencies:{realpath:join(f.source,'node_modules'),identity:await dependencyIdentity(join(f.source,'node_modules'))}});
  save(join(f.home,'dev-pairing.json'),{environment:'foreman-dev-v1',url:TARGET.url,token:'a'.repeat(64)});
  const prod=join(f.dir,'production-codex'); mkdirSync(prod);
  const credential='{"tokens":{"refresh_token":"fake-rotating-production-token"},"last_refresh":"now"}';
  writeFileSync(join(prod,'auth.json'),credential);
  const prev=process.env.CODEX_HOME; process.env.CODEX_HOME=prod;
  t.after(()=>{if(prev===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=prev;});
  let rejected;
  try { await start(f.home,{relayStatus:async()=>({commit,relay:{online:false}}),checkPort:async()=>{},execute:()=>{throw Error('not logged in');}}); } catch(error) { rejected=error; }
  assert.equal(readdirSync(join(f.home,'codex')).includes('auth.json'),false);
  assert.equal(readFileSync(join(prod,'auth.json'),'utf8'),credential);
  assert.match(rejected?.message ?? '', /DEV Codex is not signed in.*CODEX_HOME=.*login/);
});
test('CODEX_HOME cannot retarget dev credential discovery',()=>assert.throws(()=>guardEnvironment({CODEX_HOME:'/production'}),/Unset CODEX_HOME/));
for(const failure of ['lockfile','html','dry-run','upload']) test(`failed deploy cleans snapshot and preserves previous deployment: ${failure}`, async t=>{
  const f=fixture(t);
  if(failure==='html')writeFileSync(join(f.source,'web/index.html'),'bad html');
  const commit=f.commit();
  if(failure==='lockfile')writeFileSync(join(f.source,'package-lock.json'),'{"different":true}');
  const old='release-previous'; mkdirSync(join(f.home,old),{mode:0o700});
  const previous={release:old,commit:'b'.repeat(40)};save(join(f.home,'deployment.json'),previous);
  let calls=0;
  await assert.rejects(deploy(f.home,{source:f.source,ref:commit},async()=>{calls++;if(failure==='dry-run'||calls===2)throw Error('injected deploy failure');}),/matching dependencies|body and title|injected deploy failure/);
  assert.equal(calls,failure==='upload'?2:failure==='dry-run'?1:0);
  assert.deepEqual(releases(f.home),[old]);
  assert.deepEqual(JSON.parse(readFileSync(join(f.home,'deployment.json'))),previous);
  assert.equal(readdirSync(f.home).some(n=>/^(archive-|secrets-)/.test(n)),false);
});
test('successful deploy prunes old releases only after committing new deployment',async t=>{
  const f=fixture(t);const commit=f.commit();
  for(const name of ['release-previous','release-leaked'])mkdirSync(join(f.home,name),{mode:0o700});
  save(join(f.home,'deployment.json'),{release:'release-previous',commit:'b'.repeat(40)});
  let calls=0;
  await deploy(f.home,{source:f.source,ref:commit},async()=>{calls++;assert.ok(releases(f.home).includes('release-previous'));});
  assert.equal(calls,2);
  const current=JSON.parse(readFileSync(join(f.home,'deployment.json')));
  assert.deepEqual(releases(f.home),[current.release]);assert.equal(current.commit,commit);
});
test('deploy reads JSONC Firebase config from selected snapshot',async t=>{
  const f=fixture(t);const commit=f.commit();let calls=0;
  await deploy(f.home,{source:f.source,ref:commit},async(_home,config)=>{calls++;assert.equal(JSON.parse(readFileSync(config)).vars.FIREBASE_CONFIG,'snapshot-public-config');});
  assert.equal(calls,2);
});
function cli(f,command) {
  const env={...process.env,HOME:f.dir};
  for(const key of Object.keys(env))if(key.startsWith('FOREMAN_')||['CODEX_HOME','CLAUDE_CONFIG_DIR','NODE_OPTIONS'].includes(key))delete env[key];
  return execFileSync(process.execPath,[script,command],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
}
test('status works while another operation owns the lock',t=>{
  const f=fixture(t);const lock=join(f.home,'operation.lock');mkdirSync(lock,{mode:0o700});
  save(join(lock,'owner.json'),{pid:process.pid,identity:processIdentity(process.pid)});
  assert.equal(JSON.parse(cli(f,'status')).environment,'DEV');
  assert.throws(()=>cli(f,'stop'),/operation.*active/i);
});
test('stop recovers a lock left by a dead owner',t=>{
  const f=fixture(t);const lock=join(f.home,'operation.lock');mkdirSync(lock,{mode:0o700});
  save(join(lock,'owner.json'),{pid:2147483647,identity:'dead owner'});
  assert.match(cli(f,'stop'),/stopped/);
});
test('status reports reused PID and names the recovery file without signalling',async t=>{
  const f=fixture(t);const file=join(f.home,'daemon.json');save(file,{pid:process.pid,id:'wrong',identity:processIdentity(process.pid)});
  const result=await status(f.home);assert.equal(result.pid,null);assert.match(result.error,/identity changed/);assert.ok(result.error.includes(file));
});
