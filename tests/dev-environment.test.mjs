import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync, linkSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { argumentsFor, guardEnvironment, owned, openHome, validatePairing, workerConfig, devEntry, freePort, deleteDevWorker, processIdentity, running, stop, TARGET, requireClaudeAuth, SUPPORTED_WORKER_CONTRACT } from '../scripts/dev-environment.mjs';
const conforming = structuredClone(SUPPORTED_WORKER_CONTRACT);

function temporary(t) { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-dev-test-'))); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
test('dev CLI rejects target and lifecycle overrides before side effects', () => {
  for (const args of [['deploy','--name','foreman'],['deploy','--config','wrangler.jsonc'],['deploy','--env','production'],['start','--source','somewhere'],['destroy','foreman'],['deploy','--ref'],['deploy','--ref','--all'],['restart']]) assert.throws(() => argumentsFor(args));
  assert.deepEqual(argumentsFor(['deploy','--source','/tmp/sprint','--ref','epic/1-ux-polish']), {command:'deploy',source:'/tmp/sprint',ref:'epic/1-ux-polish'});
});
test('inherited production pairing, port, config and account overrides are refused', () => {
  for (const key of ['FOREMAN_HOME','FOREMAN_PORT','FOREMAN_HOST_TOKEN','FOREMAN_RELAY_URL','CLOUDFLARE_ENV','CLOUDFLARE_ACCOUNT_ID','CF_ACCOUNT_ID','WRANGLER_CONFIG','NODE_OPTIONS','CLAUDE_CONFIG_DIR']) assert.throws(() => guardEnvironment({[key]:'production'}), new RegExp(key));
  assert.doesNotThrow(() => guardEnvironment({PATH:'/usr/bin',CLOUDFLARE_API_TOKEN:'authentication-only'}));
});
test('dev home is private, marked, and never adopts an existing unrelated directory', (t) => {
  const dir=temporary(t), home=openHome(dir); assert.equal(home,join(dir,'.foreman-dev')); assert.equal(openHome(dir),home);
  writeFileSync(join(home,'owner'),'unrelated'); assert.throws(() => openHome(dir), /Unrecognized/);
});
test('dev home refuses a symlink to production without changing its sentinel', (t) => {
  const dir=temporary(t), prod=join(dir,'.foreman'); mkdirSync(prod); writeFileSync(join(prod,'sentinel'),'unchanged');
  symlinkSync(prod,join(dir,'.foreman-dev')); assert.throws(() => openHome(dir), /unsafe/); assert.equal(readFileSync(join(prod,'sentinel'),'utf8'),'unchanged');
});
test('private state rejects symlinks, hardlinks and permissive files', (t) => {
  const dir=temporary(t), file=join(dir,'pair'); writeFileSync(file,'credential',{mode:0o600}); owned(file);
  symlinkSync(file,join(dir,'link')); assert.throws(() => owned(join(dir,'link')), /unsafe/);
  chmodSync(file,0o644); assert.throws(() => owned(file), /unsafe/); chmodSync(file,0o600);
  linkSync(file,join(dir,'hardlink')); assert.throws(() => owned(file), /unsafe/);
});
test('pairing cannot select production or inject malformed credentials', () => {
  const pair={environment:'foreman-dev-v1',url:TARGET.url,token:'a'.repeat(64)}; assert.equal(validatePairing(pair),pair);
  for(const override of [{url:'https://foreman.hooong-yang.workers.dev'},{environment:'production'},{token:'x'},{token:'a'.repeat(64)+'\n'}]) assert.throws(()=>validatePairing({...pair,...override}),/non-dev/);
});
test('generated Worker config owns its namespace and ignores dangerous source configuration', () => {
  // The external-namespace binding (script_name) is now refused outright
  // instead of being silently replaced (#31); every guard assertion below
  // still runs, on the same dangerous input with conforming bindings.
  const dangerous={name:'foreman',account_id:'production-account',build:{command:'production-deploy'},routes:['production/*'],env:{production:{name:'foreman'}},vars:{FIREBASE_CONFIG:'public',ALLOWED_EMAIL:'attacker'}};
  assert.throws(()=>workerConfig({...dangerous,durable_objects:{bindings:[{script_name:'foreman'}]}}),/external Durable Object binding.*script_name/);
  const config=workerConfig({...dangerous,...conforming});
  assert.equal(config.name,'foreman-dev'); assert.equal(config.account_id,TARGET.account);
  assert.deepEqual(config.durable_objects.bindings,[{name:'RELAY',class_name:'HostRelay'}]);
  assert.equal(config.vars.ALLOWED_EMAIL,'hooong.yang@gmail.com'); assert.equal(config.vars.FIREBASE_PROJECT_ID,'foreman-hong-2026');
  for(const key of ['routes','build','env']) assert.equal(config[key],undefined);
});
test('occupied port guard leaves the existing listener alive', async () => {
  const server=createServer(); await new Promise(r=>server.listen(0,'127.0.0.1',r)); const port=server.address().port;
  try { await assert.rejects(freePort(port),/occupied/); assert.equal(server.listening,true); }
  finally { await new Promise(r=>server.close(r)); }
  await freePort(port);
});
test('dev relay status authenticates before consulting DO and delegates normal application requests', async (t) => {
  const dir=temporary(t); mkdirSync(join(dir,'cloud'));
  writeFileSync(join(dir,'cloud/worker.mjs'),`export class HostRelay {}\nexport default {fetch:()=>new Response('sprint application')};`);
  writeFileSync(join(dir,'cloud/auth.mjs'),`export async function validHostToken(a,b) {return a === b;}`);
  const entry=devEntry('a'.repeat(40)).replaceAll('.ts\'', '.mjs\''); writeFileSync(join(dir,'entry.mjs'),entry);
  const {default:worker}=await import(pathToFileURL(join(dir,'entry.mjs')));
  let reads=0; const env={HOST_TOKEN:'dev-credential',ALLOWED_EMAIL:'owner',RELAY:{idFromName:n=>n,get:n=>({fetch:async request=>{reads++; assert.equal(n,'owner'); assert.equal(new URL(request.url).pathname,'/api/host');return Response.json({online:true,host:'Mac'});}})}};
  const url=TARGET.url+'/api/dev/status';
  assert.equal((await worker.fetch(new Request(url),env)).status,401); assert.equal(reads,0);
  assert.equal((await worker.fetch(new Request(url,{method:'POST',headers:{authorization:'Bearer dev-credential'}}),env)).status,401); assert.equal(reads,0);
  const response=await worker.fetch(new Request(url,{headers:{authorization:'Bearer dev-credential'}}),env);
  assert.equal(reads,1); assert.deepEqual(await response.json(),{environment:'dev',commit:'a'.repeat(40),relay:{online:true,host:'Mac'}});
  assert.equal(await (await worker.fetch(new Request(TARGET.url+'/api/sessions'),env)).text(),'sprint application');
});

test('teardown sends only the dev target with force=false and retains failure', async () => {
  let calls=0;
  await deleteDevWorker({authorization:'Bearer test'},async (url,options)=>{
    calls++; assert.equal(url,`https://api.cloudflare.com/client/v4/accounts/${TARGET.account}/workers/scripts/foreman-dev?force=false`);
    assert.equal(options.method,'DELETE'); assert.equal(options.redirect,'error');
    return Response.json({success:true});
  });
  assert.equal(calls,1);
  await assert.rejects(deleteDevWorker({},async()=>Response.json({success:false,errors:[{code:10000}]},{status:403})),/local state retained/);
  await assert.rejects(deleteDevWorker({},async()=>Response.json({success:false},{status:409})),/refused/);
  await deleteDevWorker({},async()=>Response.json({success:false,errors:[{code:10007}]},{status:404}));
});

test('read-only commands do not recreate a missing dev home', (t) => {
  const dir=temporary(t), home=openHome(dir,false); assert.equal(existsSync(home),false);
});
test('stop refuses a live unrelated PID even with a forged recorded identity', async (t) => {
  const home=openHome(temporary(t));
  writeFileSync(join(home,'daemon.json'),JSON.stringify({pid:process.pid,id:randomUUID(),identity:processIdentity(process.pid)}),{mode:0o600});
  assert.throws(()=>running(home),/identity changed/);
  await assert.rejects(stop(home),/unrelated process/);
});
test('stop signals the owned daemon and observes its actual graceful exit', async (t) => {
  const home=openHome(temporary(t)), entry=join(home,'run.mjs'), id=randomUUID();
  const stopped=join(home,'stopped');
  writeFileSync(entry,`import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(stopped)},'graceful');process.exit(0);});setInterval(()=>{},1000);console.log('ready');`,{mode:0o600});
  const child=spawn(process.execPath,[entry,id],{stdio:['ignore','pipe','ignore']});
  t.after(()=>{if(child.exitCode===null) child.kill();});
  await once(child.stdout,'data');
  writeFileSync(join(home,'daemon.json'),JSON.stringify({pid:child.pid,id,identity:processIdentity(child.pid)}),{mode:0o600});
  assert.equal(running(home).pid,child.pid);
  const exited=once(child,'exit');
  await stop(home);
  await exited;
  assert.equal(readFileSync(stopped,'utf8'),'graceful'); assert.equal(child.exitCode,0);
  assert.equal(processIdentity(child.pid),''); assert.equal(existsSync(join(home,'daemon.json')),false);
});


test('Claude dev authentication checks isolated login and never clones production refresh tokens', () => {
  let calls = 0;
  requireClaudeAuth('/sdk/claude', '/owned/dev/claude', { PATH: '/bin' }, (binary, args, options) => {
    calls++; assert.equal(binary, '/sdk/claude'); assert.deepEqual(args, ['auth', 'status', '--json']);
    assert.equal(options.env.CLAUDE_CONFIG_DIR, '/owned/dev/claude');
    return JSON.stringify({ loggedIn: true });
  });
  assert.equal(calls, 1);
  for (const result of ['{}', '{"loggedIn":false}', 'bad-json-secret']) {
    assert.throws(() => requireClaudeAuth('/sdk/claude', '/owned/dev/claude', {}, () => result), (error) => {
      assert.match(error.message, /DEV Claude is not signed in/);
      assert.match(error.message, /CLAUDE_CONFIG_DIR="\/owned\/dev\/claude"/);
      assert.ok(!error.message.includes('bad-json-secret')); return true;
    });
  }
  assert.throws(() => requireClaudeAuth('/sdk/claude', '/owned/dev/claude', {}, () => { throw new Error('secret-output'); }), (error) => !error.message.includes('secret-output'));
});
test('explicit Claude API key or token bypasses credential discovery', () => {
  for (const env of [{ ANTHROPIC_API_KEY: 'test' }, { CLAUDE_CODE_OAUTH_TOKEN: 'test' }])
    requireClaudeAuth('/sdk/claude', '/owned/dev/claude', env, () => { assert.fail('Must not consult stored credentials'); });
});

test('Codex status uses isolated CODEX_HOME and redacts failed provider output', async () => {
  const {requireCodexAuth}=await import('../scripts/dev-environment.mjs');let calls=0;
  requireCodexAuth('codex','/dev/codex',{PATH:'/bin'},(binary,args,options)=>{calls++;assert.equal(binary,'codex');assert.deepEqual(args,['login','status']);assert.equal(options.env.CODEX_HOME,'/dev/codex');});
  assert.equal(calls,1);
  assert.throws(()=>requireCodexAuth('codex','/dev/codex',{},()=>{throw Error('secret provider output');}),error=>{assert.match(error.message,/CODEX_HOME="\/dev\/codex" "codex" login/);assert.ok(!error.message.includes('secret provider output'));return true;});
});
