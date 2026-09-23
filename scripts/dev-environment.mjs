#!/usr/bin/env node
// Only this file chooses deployment targets. Preview source/config cannot retarget them.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync, lstatSync, realpathSync, renameSync, symlinkSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TARGET = Object.freeze({ worker: 'foreman-dev', url: 'https://foreman-dev.hooong-yang.workers.dev', account: 'b107d26298de0cc01f30edf0db8e92b1', port: 4178 });
const marker = 'foreman-dev-v1';
export function argumentsFor(args) {
  const [command, ...rest] = args;
  if (!['deploy', 'start', 'status', 'stop', 'destroy'].includes(command)) throw new Error('Use dev:deploy, dev:start, dev:status, dev:stop or dev:destroy');
  const options = { command, source: root, ref: 'HEAD' };
  while (rest.length) {
    const flag = rest.shift();
    if (command !== 'deploy' || !['--source', '--ref'].includes(flag) || !rest[0] || rest[0].startsWith('-')) throw new Error(`Refusing unsupported argument: ${flag}`);
    options[flag.slice(2)] = rest.shift();
  }
  return options;
}
export function guardEnvironment(env) {
  for (const key of Object.keys(env)) {
    if (key.startsWith('FOREMAN_') || ['CLOUDFLARE_ENV', 'CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID', 'WRANGLER_ENV', 'WRANGLER_CONFIG', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].includes(key)) {
      if (env[key]) throw new Error(`Unset ${key}: dev commands use a fixed isolated target`);
    }
  }
}
export function owned(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || stat.uid !== process.getuid() || (stat.mode & 0o077) || (!directory && stat.nlink !== 1)) throw new Error(`Refusing unsafe dev path: ${path}`);
}
export function openHome(parent = homedir(), create = true) {
  const home = join(realpathSync(parent), '.foreman-dev');
  if (!existsSync(home)) {
    if (!create) return home;
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, 'owner'), marker, { mode: 0o600, flag: 'wx' });
  }
  owned(home, true); owned(join(home, 'owner'));
  if (readFileSync(join(home, 'owner'), 'utf8') !== marker) throw new Error('Unrecognized dev home');
  return home;
}
function save(path, value) {
  if (existsSync(path)) owned(path);
  const temp = `${path}.${randomUUID()}`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}
function read(path) { owned(path); return JSON.parse(readFileSync(path, 'utf8')); }
export function validatePairing(pair) {
  if (pair?.environment !== marker || pair.url !== TARGET.url || !/^[a-f0-9]{64}$/.test(pair.token)) throw new Error('Refusing non-dev pairing');
  return pair;
}
export function workerConfig(base) {
  // Deliberately construct, never spread a branch's Wrangler config: no routes,
  // external DO namespaces, build hooks, environments, or production secrets.
  return {
    name: TARGET.worker, account_id: TARGET.account, main: './dev-worker.ts', compatibility_date: '2026-09-21',
    workers_dev: true, preview_urls: false, secrets: { required: ['HOST_TOKEN'] },
    assets: { directory: './web', binding: 'ASSETS', run_worker_first: ['/api/*'] },
    durable_objects: { bindings: [{ name: 'RELAY', class_name: 'HostRelay' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['HostRelay'] }],
    vars: { FIREBASE_PROJECT_ID: 'foreman-hong-2026', ALLOWED_EMAIL: 'hooong.yang@gmail.com', FIREBASE_CONFIG: base.vars.FIREBASE_CONFIG },
    observability: { enabled: true, logs: { enabled: true, invocation_logs: true }, traces: { enabled: true } },
  };
}
export function devEntry(commit) {
  return `import worker, { HostRelay } from './cloud/worker.ts';
import { validHostToken } from './cloud/auth.ts';
export { HostRelay };
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/dev/status') {
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (request.method !== 'GET' || !await validHostToken(token, env.HOST_TOKEN)) return new Response('Unauthorized', { status: 401 });
      const response = await env.RELAY.get(env.RELAY.idFromName(env.ALLOWED_EMAIL)).fetch(new Request(new URL('/api/host', url)));
      return Response.json({ environment: 'dev', commit: '${commit}', relay: await response.json() }, { headers: { 'cache-control': 'no-store' } });
    }
    return worker.fetch(request, env, ctx);
  }
};\n`;
}
function run(bin, args, options = {}) { return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }); }
async function wrangler(home, config, args) {
  const child = spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args, '--config', config], {
    cwd: home, stdio: 'inherit', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' },
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error(`Dev Wrangler command failed (${code}); local pairing retained`);
}
export async function freePort(port = TARGET.port) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', () => reject(new Error(`Port ${port} is occupied; refusing to disturb its listener`))); server.listen(port, '127.0.0.1', resolve); });
  await new Promise((resolve) => server.close(resolve));
}
function releasePath(home, deployment) {
  if (!/^release-[a-zA-Z0-9]+$/.test(deployment?.release) || !/^[a-f0-9]{40}$/.test(deployment?.commit)) throw new Error('Invalid dev deployment record');
  const path = join(home, deployment.release); owned(path, true); return path;
}
export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('Invalid daemon PID');
  try {
    const row = run('ps', ['-p', String(pid), '-o', 'stat=,lstart=,command=']).trim();
    const match = row.match(/^(\S+)\s+(.*)$/);
    // A terminated child may briefly remain as a zombie before its parent reaps it.
    return !match || match[1].startsWith('Z') ? '' : match[2];
  }
  catch (error) { if (error.status === 1) return ''; throw error; }
}
export function running(home) {
  const file = join(home, 'daemon.json');
  if (!existsSync(file)) return null;
  const record = read(file);
  const identity = processIdentity(record.pid);
  if (!identity) return null;
  if (!/^[a-f0-9-]{36}$/.test(record.id) || !identity.includes(`${join(home, 'run.mjs')} ${record.id}`) || identity !== record.identity) throw new Error(`Daemon PID identity changed; refusing to signal an unrelated process. Remove only ${file} to discard the stale record, then retry.`);
  return record;
}
async function remote(pair) {
  const response = await fetch(`${TARGET.url}/api/dev/status`, { headers: { authorization: `Bearer ${pair.token}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Dev relay status returned ${response.status}`);
  const data = await response.json();
  if (data.environment !== 'dev') throw new Error('Wrong relay environment');
  return data;
}
export async function status(home) {
  let daemon = null, error;
  try { daemon = running(home); } catch (e) { error = e.message; }
  const deployment = existsSync(join(home, 'deployment.json')) ? read(join(home, 'deployment.json')) : null;
  let relay = null;
  try { if (existsSync(join(home, 'dev-pairing.json'))) relay = await remote(validatePairing(read(join(home, 'dev-pairing.json')))); }
  catch (e) { error = [error, e.message].filter(Boolean).join('; '); }
  const result = { environment: 'DEV', url: TARGET.url, home, port: TARGET.port, pid: daemon?.pid ?? null, commit: deployment?.commit ?? null, relay, ...(error ? { error } : {}), log: join(home, 'daemon.log') };
  console.log(JSON.stringify(result, null, 2));
  return result;
}
export async function stop(home) {
  const daemon = running(home);
  if (!daemon) { console.log('DEV daemon is stopped'); return; }
  process.kill(daemon.pid, 'SIGTERM');
  for (let i = 0; i < 100; i++) {
    // After signalling, macOS may hide argv while the process is exiting.
    // Only observe disappearance here; never signal again on a changed identity.
    if (!processIdentity(daemon.pid)) { rmSync(join(home, 'daemon.json')); console.log('DEV daemon stopped'); return; }
    await delay(100);
  }
  throw new Error('DEV daemon did not stop in 10 seconds; refusing forced termination or teardown');
}
export async function deploy(home, options, deployWorker = wrangler) {
  if (running(home)) throw new Error('Run npm run dev:stop before deploying; UI and daemon must use the same snapshot');
  const source = realpathSync(resolve(options.source));
  const commit = run('git', ['-C', source, 'rev-parse', '--verify', `${options.ref}^{commit}`]).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid source commit');
  if (options.ref === 'HEAD' && run('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no']).trim()) throw new Error('Commit tracked source changes before previewing HEAD');
  const tree = run('git', ['-C', source, 'ls-tree', '-r', commit]);
  if (/^120000 /m.test(tree)) throw new Error('Preview commits containing symlinks are not supported');
  const snapshot = mkdtempSync(join(home, 'release-'));
  let committed = false;
  try {
    const archive = join(home, `archive-${randomUUID()}.tar`);
    try {
      run('git', ['-C', source, 'archive', '--format=tar', '--output', archive, commit]);
      run('tar', ['-xf', archive, '-C', snapshot]);
    } finally { rmSync(archive, { force: true }); }
    // Use dependencies installed for the selected checkout, only with its exact lockfile.
    if (!readFileSync(join(snapshot, 'package-lock.json')).equals(readFileSync(join(source, 'package-lock.json')))) throw new Error('Install matching dependencies in a worktree for that ref first');
    symlinkSync(realpathSync(join(source, 'node_modules')), join(snapshot, 'node_modules'));
    const index = join(snapshot, 'web/index.html');
    const html = readFileSync(index, 'utf8');
    if (!html.includes('<body') || !html.includes('<title>')) throw new Error('Preview UI must have a body and title');
    writeFileSync(index, html.replace('<title>', '<title>[DEV] ').replace(/<body([^>]*)>/, `<body$1><div role="note" style="position:fixed;bottom:0;right:0;z-index:2147483647;background:#713f12;color:#fff;padding:3px 8px;font:12px system-ui;pointer-events:none">DEV · ${commit.slice(0, 8)} · :4178</div>`));
    writeFileSync(join(snapshot, 'dev-worker.ts'), devEntry(commit));
    const config = join(snapshot, 'wrangler.dev.json');
    const { experimental_readRawConfig } = await import('wrangler');
    const { rawConfig } = experimental_readRawConfig({ config: join(snapshot, 'wrangler.jsonc') });
    writeFileSync(config, JSON.stringify(workerConfig(rawConfig), null, 2));
    const pairFile = join(home, 'dev-pairing.json');
    const pair = existsSync(pairFile) ? validatePairing(read(pairFile)) : { environment: marker, url: TARGET.url, token: randomBytes(32).toString('hex') };
    // Persist before upload so a partial/failed deployment can reuse its credential.
    save(pairFile, pair);
    const secret = join(home, `secrets-${randomUUID()}.json`);
    writeFileSync(secret, JSON.stringify({ HOST_TOKEN: pair.token }), { mode: 0o600, flag: 'wx' });
    try {
      await deployWorker(home, config, ['deploy', '--dry-run', '--secrets-file', secret]);
      await deployWorker(home, config, ['deploy', '--secrets-file', secret]);
    } finally { rmSync(secret, { force: true }); }
    save(join(home, 'deployment.json'), { release: snapshot.slice(home.length + 1), commit, source });
    committed = true;
    // Only prune after the replacement record has been atomically published.
    for (const name of readdirSync(home)) {
      if (!/^release-[a-zA-Z0-9]+$/.test(name) || join(home, name) === snapshot) continue;
      const path = join(home, name); owned(path, true);
      rmSync(path, { recursive: true });
    }
  } finally { if (!committed) rmSync(snapshot, { recursive: true, force: true }); }
  console.log(`DEV deployed ${commit}\n${TARGET.url}\nNext: npm run dev:start`);
}
// A copied rotating OAuth refresh token is not an independent login: one
// installation can invalidate the other's copy. Authenticate dev separately.
export function requireClaudeAuth(binary, configDir, env = process.env, execute = run) {
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) return;
  try {
    const status = JSON.parse(execute(binary, ['auth', 'status', '--json'], {
      env: { ...env, CLAUDE_CONFIG_DIR: configDir },
    }));
    if (status.loggedIn === true) return;
  } catch { /* Never include provider output: it may contain credentials. */ }
  throw new Error(`DEV Claude is not signed in. Run CLAUDE_CONFIG_DIR="${configDir}" "${binary}" auth login, then run npm run dev:start. Dev requires its own login; production OAuth credentials are never copied.`);
}
export function requireCodexAuth(binary, configDir, env = process.env, execute = run) {
  try {
    // login status is local credential inspection, never an inference/refresh call.
    execute(binary, ['login', 'status'], { env: { ...env, CODEX_HOME: configDir } });
    return;
  } catch { /* Never include provider output: it may contain credentials. */ }
  throw new Error(`DEV Codex is not signed in. Run CODEX_HOME="${configDir}" "${binary}" login, then run npm run dev:start. Dev requires its own login; production OAuth credentials are never copied.`);
}
export async function start(home, { relayStatus = remote, checkPort = freePort, execute = run } = {}) {
  if (running(home)) throw new Error('DEV daemon already running; use dev:status or dev:stop');
  const deployment = read(join(home, 'deployment.json'));
  const snapshot = releasePath(home, deployment);
  const pair = validatePairing(read(join(home, 'dev-pairing.json')));
  const relay = await relayStatus(pair);
  if (relay.commit !== deployment.commit) throw new Error('Deployed Worker does not match the local snapshot; redeploy before starting');
  if (relay.relay.online) throw new Error('Another dev host is connected; refusing to replace it');
  await checkPort();
  for (const dir of ['claude', 'codex']) {
    const path = join(home, dir);
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
    owned(path, true);
  }
  requireCodexAuth('codex', join(home, 'codex'), process.env, execute);
  requireClaudeAuth(join(snapshot, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude'), join(home, 'claude'), process.env, execute);
  const entry = join(home, 'run.mjs');
  if (existsSync(entry)) owned(entry);
  writeFileSync(entry, `console.log('FOREMAN DEV ${deployment.commit}');\nawait import(${JSON.stringify(pathToFileURL(join(snapshot, 'server/main.ts')).href)});\n`, { mode: 0o600 });
  const logPath = join(home, 'daemon.log');
  if (existsSync(logPath)) owned(logPath);
  const log = openSync(logPath, 'w', 0o600), id = randomUUID();
  const child = spawn(process.execPath, ['--experimental-strip-types', entry, id], {
    cwd: snapshot, detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, FOREMAN_HOME: home, FOREMAN_PORT: String(TARGET.port), FOREMAN_RELAY_URL: TARGET.url, FOREMAN_HOST_TOKEN: pair.token,
      CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex') },
  });
  closeSync(log);
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  save(join(home, 'daemon.json'), { pid: child.pid, id, identity: processIdentity(child.pid) });
  child.unref();
  try {
    for (let i = 0; i < 60; i++) {
      if (!running(home)) throw new Error(`DEV daemon exited; see ${logPath}`);
      let health;
      try { health = await (await fetch(`http://127.0.0.1:${TARGET.port}/api/health`, { signal: AbortSignal.timeout(1000) })).json(); } catch {}
      if (health?.pid === child.pid && (await remote(pair)).relay.online) { await status(home); return; }
      await delay(500);
    }
    throw new Error(`DEV daemon/relay did not become ready; see ${logPath}`);
  } catch (error) { await stop(home); throw error; }
}
export async function deleteDevWorker(headers, fetcher = fetch) {
  // Wrangler delete auto-confirms even dependency-breaking deletion under CI.
  // Use the API's explicit force=false so the server refuses that operation.
  const url = `https://api.cloudflare.com/client/v4/accounts/${TARGET.account}/workers/scripts/${TARGET.worker}?force=false`;
  const response = await fetcher(url, { method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (response.ok && result.success) return;
  if (result.errors?.some((error) => error.code === 10007)) return; // already absent
  throw new Error(`Dev Worker deletion refused (${response.status}); local state retained`);
}
async function destroy(home) {
  await stop(home);
  let auth;
  try { auth = JSON.parse(run(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'auth', 'token', '--json'], { cwd: home })); }
  catch { throw new Error('Cannot retrieve Cloudflare authentication; run npx wrangler login'); }
  const headers = auth.type === 'api_key' ? { 'X-Auth-Key': auth.key, 'X-Auth-Email': auth.email } : { authorization: `Bearer ${auth.token}` };
  await deleteDevWorker(headers);
  rmSync(home, { recursive: true });
  console.log('DEV Worker and local dev state removed. Firebase authorized domain retained for reuse.');
}
export function acquireLock(home) {
  const lock = join(home, 'operation.lock');
  // Publish a complete owner record atomically, avoiding a crash between mkdir
  // and writing the PID. A nonempty lock directory cannot be replaced by rename.
  const candidate = mkdtempSync(join(home, 'operation-owner-'));
  save(join(candidate, 'owner.json'), { pid: process.pid, identity: processIdentity(process.pid), startedAt: new Date().toISOString() });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (existsSync(lock)) {
        owned(lock, true);
        const ownerFile = join(lock, 'owner.json');
        if (!existsSync(ownerFile)) throw new Error(`Legacy dev lock has no owner. Check for active dev commands, then remove only ${lock}. Status remains available.`);
        const owner = read(ownerFile);
        if (processIdentity(owner.pid) === owner.identity) throw new Error(`Another dev operation is active (PID ${owner.pid})`);
        // Serialize stale-lock recovery too: contenders must not remove a newly
        // acquired lock after another process has already recovered it.
        const recovery = join(lock, 'recovery');
        const claim = mkdtempSync(join(home, 'operation-recovery-'));
        save(join(claim, 'owner.json'), { pid: process.pid, identity: processIdentity(process.pid) });
        try {
          if (existsSync(recovery)) {
            const recovering = read(join(recovery, 'owner.json'));
            if (processIdentity(recovering.pid) === recovering.identity) throw new Error('Dev lock recovery in progress; retry');
            rmSync(recovery, { recursive: true });
          }
          try { renameSync(claim, recovery); }
          catch { throw new Error('Dev lock recovery in progress; retry'); }
          const current = read(ownerFile);
          if (current.pid !== owner.pid || current.identity !== owner.identity) {
            rmSync(recovery, { recursive: true });
            throw new Error('Dev lock owner changed; retry');
          }
        } finally { rmSync(claim, { recursive: true, force: true }); }
        rmSync(lock, { recursive: true });
      }
      try { renameSync(candidate, lock); return () => rmSync(lock, { recursive: true, force: true }); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    }
    throw new Error('Another dev operation is active; retry');
  } finally { rmSync(candidate, { recursive: true, force: true }); }
}
export async function main(args = process.argv.slice(2)) {
  const options = argumentsFor(args); guardEnvironment(process.env);
  const home = openHome(homedir(), !['status', 'stop'].includes(options.command));
  if (!existsSync(home)) {
    if (options.command === 'status') await status(home);
    else console.log('DEV daemon is stopped');
    return;
  }
  if (options.command === 'status') return status(home);
  const releaseLock = acquireLock(home);
  try {
    if (options.command === 'deploy') await deploy(home, options);
    if (options.command === 'start') await start(home);
    if (options.command === 'status') await status(home);
    if (options.command === 'stop') await stop(home);
    if (options.command === 'destroy') await destroy(home);
  } finally { releaseLock(); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
