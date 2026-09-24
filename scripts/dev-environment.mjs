#!/usr/bin/env node
// Only this file chooses deployment targets. Preview source/config cannot retarget them.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync, lstatSync, realpathSync, renameSync, symlinkSync, openSync, closeSync, createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
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
// The only bindings and migrations the generated dev Worker supports. It is
// both what workerConfig emits and what a snapshot's own wrangler.jsonc must
// declare exactly: a divergent snapshot is refused rather than deployed with
// bindings or migrations it did not ask for, or without ones it did.
export const SUPPORTED_WORKER_CONTRACT = deepFreeze({
  durable_objects: { bindings: [{ name: 'RELAY', class_name: 'HostRelay' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['HostRelay'] }],
  assets: { binding: 'ASSETS' },
});
// Every other binding-bearing top-level Wrangler key. The dev config never
// emits these, so a snapshot declaring any of them would lose them silently.
// `exports` declares Durable Objects without migrations; `containers` and
// `cloudchamber` attach to Durable Object classes. Non-binding keys (name,
// account_id, main, routes, route, triggers, build, env, vars, secrets, ...)
// stay ignored by construction.
export const UNSUPPORTED_BINDING_KEYS = Object.freeze(['kv_namespaces', 'r2_buckets', 'd1_databases', 'services', 'queues', 'workflows',
  'vectorize', 'hyperdrive', 'analytics_engine_datasets', 'ai', 'ai_search', 'ai_search_namespaces', 'agent_memory', 'websearch', 'browser',
  'images', 'media', 'stream', 'version_metadata', 'send_email', 'mtls_certificates', 'dispatch_namespaces', 'pipelines', 'secrets_store_secrets',
  'artifacts', 'flagship', 'ratelimits', 'worker_loaders', 'vpc_services', 'vpc_networks', 'connect', 'tail_consumers', 'streaming_tail_consumers',
  'logfwdr', 'unsafe', 'unsafe_hello_world', 'wasm_modules', 'text_blobs', 'data_blobs', 'containers', 'cloudchamber', 'exports']);
function deepFreeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}
const show = value => JSON.stringify(value) ?? 'nothing';
// Order-insensitive for object keys, order-sensitive for arrays.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return show(value);
}
const same = (a, b) => canonical(a) === canonical(b);
// Names every way a snapshot's raw Wrangler config diverges from the contract.
export function contractDivergences(base) {
  const problems = [], contract = SUPPORTED_WORKER_CONTRACT;
  const objects = base?.durable_objects;
  const extra = Object.keys(objects ?? {}).filter(key => key !== 'bindings');
  if (extra.length) problems.push(`unsupported durable_objects keys ${show(extra)}`);
  const bindings = objects?.bindings;
  if (!Array.isArray(bindings)) problems.push(`durable_objects.bindings is ${show(bindings)}, not a list`);
  else {
    for (const binding of bindings) {
      const expected = contract.durable_objects.bindings.find(entry => entry.name === binding?.name);
      if (binding?.script_name !== undefined) problems.push(`external Durable Object binding ${show(binding)} (script_name is not supported)`);
      else if (!expected) problems.push(`extra or renamed Durable Object binding ${show(binding)}`);
      else if (binding.class_name !== expected.class_name) problems.push(`Durable Object binding ${expected.name} uses class ${show(binding.class_name)}, not ${show(expected.class_name)}`);
      else if (!same(binding, expected)) problems.push(`Durable Object binding ${expected.name} declares unsupported fields ${show(binding)}`);
    }
    for (const expected of contract.durable_objects.bindings) {
      const count = bindings.filter(binding => binding?.name === expected.name).length;
      if (count !== 1) problems.push(`Durable Object binding ${expected.name} -> ${expected.class_name} is ${count ? 'duplicated' : 'missing'}`);
    }
  }
  const migrations = base?.migrations;
  if (!Array.isArray(migrations)) problems.push(`migrations is ${show(migrations)}, not a list`);
  else if (!same(migrations, contract.migrations)) {
    for (const migration of migrations) {
      const expected = contract.migrations.find(entry => entry.tag === migration?.tag);
      if (!expected) problems.push(`extra or different migration ${show(migration)}`);
      else if (!same(migration, expected)) problems.push(`migration ${expected.tag} is ${show(migration)}, not ${show(expected)}`);
    }
    for (const expected of contract.migrations) {
      const count = migrations.filter(migration => migration?.tag === expected.tag).length;
      if (count !== 1) problems.push(`migration ${expected.tag} ${show(expected)} is ${count ? 'duplicated' : 'missing'}`);
    }
    if (!problems.some(problem => problem.includes('migration'))) problems.push(`migrations are ordered ${show(migrations.map(entry => entry.tag))}, not ${show(contract.migrations.map(entry => entry.tag))}`);
  }
  if (base?.assets?.binding !== contract.assets.binding) problems.push(`assets binding is ${show(base?.assets?.binding)}, not ${show(contract.assets.binding)}`);
  for (const key of UNSUPPORTED_BINDING_KEYS) if (base?.[key] !== undefined) problems.push(`unsupported binding kind ${key} ${show(base[key])}`);
  return problems;
}
export function workerConfig(base) {
  const problems = contractDivergences(base);
  if (problems.length) throw new Error(`Refusing preview: the snapshot's wrangler.jsonc diverges from the bindings the dev Worker supports, so they would be silently dropped or changed. Divergence: ${problems.join('; ')}. Dev supports exactly durable_objects.bindings ${show(SUPPORTED_WORKER_CONTRACT.durable_objects.bindings)}, migrations ${show(SUPPORTED_WORKER_CONTRACT.migrations)} and assets binding ${show(SUPPORTED_WORKER_CONTRACT.assets.binding)}, and no other binding kinds. Preview a ref that matches, or extend SUPPORTED_WORKER_CONTRACT in scripts/dev-environment.mjs first.`);
  // Deliberately construct, never spread a branch's Wrangler config: no routes,
  // external DO namespaces, build hooks, environments, or production secrets.
  // Bindings and migrations come only from the supported contract.
  const contract = structuredClone(SUPPORTED_WORKER_CONTRACT);
  return {
    name: TARGET.worker, account_id: TARGET.account, main: './dev-worker.ts', compatibility_date: '2026-09-21',
    workers_dev: true, preview_urls: false, secrets: { required: ['HOST_TOKEN'] },
    assets: { directory: './web', binding: contract.assets.binding, run_worker_first: ['/api/*'] },
    durable_objects: contract.durable_objects,
    migrations: contract.migrations,
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
// Content-derived identity of an installed dependency tree. Lockfile equality
// says what should be installed, not what is; this hashes what is. Walks `dir`
// (already resolved) without following symlinks: each entry contributes its
// sorted relative path and type; files add their executable bit and a SHA-256
// of their contents; symlinks add their target text only, so nothing outside
// the tree is read. Other special files (FIFOs, sockets, devices) contribute
// their type only and are never opened, since reading one could block or have
// side effects. Each entry is hashed as one JSON-framed record. The result
// does not depend on listing or hashing order.
export async function dependencyIdentity(dir, { concurrency = 32 } = {}) {
  const entries = [];
  async function walk(relative) {
    for (const name of (await readdir(join(dir, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = await lstat(join(dir, path));
      if (stat.isDirectory()) { entries.push({ path, fields: ['d'] }); await walk(path); }
      else if (stat.isSymbolicLink()) entries.push({ path, fields: ['l', await readlink(join(dir, path))] });
      else if (stat.isFile()) entries.push({ path, fields: null, exec: (stat.mode & 0o111) ? 'x' : '-' });
      else entries.push({ path, fields: ['o', stat.isFIFO() ? 'fifo' : stat.isSocket() ? 'socket' : stat.isCharacterDevice() ? 'char' : stat.isBlockDevice() ? 'block' : 'other'] });
    }
  }
  await walk('');
  const files = entries.filter((entry) => entry.fields === null);
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const entry = files[next++], hash = createHash('sha256');
      await pipeline(createReadStream(join(dir, entry.path)), hash);
      entry.fields = ['f', entry.exec, hash.digest('hex')];
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  const total = createHash('sha256');
  // One JSON array per entry: every string (path, symlink target) is quoted and
  // escaped, so no path or target text can forge or merge another entry.
  for (const entry of entries) total.update(`${JSON.stringify([entry.path, ...entry.fields])}\n`);
  return `sha256:${total.digest('hex')}`;
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
// Locate a daemon whose PID was never recorded (start interrupted between
// spawn and record promotion). Match ONLY the unique `<home>/run.mjs <id>`
// argv of a live process owned by this user; a PID alone never matches.
export function findOrphans(home, id, list = () => run('ps', ['-A', '-ww', '-o', 'pid=,uid=,stat=,command='])) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid daemon id');
  const argv = ` ${join(home, 'run.mjs')} ${id}`, uid = process.getuid(), found = [];
  for (const line of list().split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match || Number(match[2]) !== uid || match[3].startsWith('Z') || !match[4].endsWith(argv)) continue;
    const pid = Number(match[1]);
    // Re-read through the same identity probe used for recorded daemons.
    const identity = processIdentity(pid);
    if (identity.endsWith(argv)) found.push({ pid, identity });
  }
  return found;
}
function inspect(home) {
  const file = join(home, 'daemon.json');
  if (!existsSync(file)) return { file, record: null, daemon: null };
  const record = read(file);
  if (record.state === 'starting') {
    if (!/^[a-f0-9-]{36}$/.test(record.id)) throw new Error(`Unrecognized dev daemon record. Check for a running dev daemon, then remove only ${file} and retry.`);
    const orphans = findOrphans(home, record.id);
    if (orphans.length > 1) throw new Error(`Multiple processes match the interrupted dev start ${record.id}; refusing to signal. Stop them manually, then remove only ${file}.`);
    return { file, record, daemon: orphans.length ? { id: record.id, pid: orphans[0].pid, identity: orphans[0].identity, state: 'starting' } : null };
  }
  if (record.state !== undefined && record.state !== 'running') throw new Error(`Unrecognized dev daemon record state. Check for a running dev daemon, then remove only ${file} and retry.`);
  const identity = processIdentity(record.pid);
  if (!identity) return { file, record, daemon: null };
  if (!/^[a-f0-9-]{36}$/.test(record.id) || !identity.includes(`${join(home, 'run.mjs')} ${record.id}`) || identity !== record.identity) throw new Error(`Daemon PID identity changed; refusing to signal an unrelated process. Remove only ${file} to discard the stale record, then retry.`);
  return { file, record, daemon: record };
}
// A `starting` record returns the orphaned daemon found by its unique argv
// (state 'starting'), or null when no such process exists.
export function running(home) { return inspect(home).daemon; }
async function remote(pair) {
  const response = await fetch(`${TARGET.url}/api/dev/status`, { headers: { authorization: `Bearer ${pair.token}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Dev relay status returned ${response.status}`);
  const data = await response.json();
  if (data.environment !== 'dev') throw new Error('Wrong relay environment');
  return data;
}
export async function status(home, { relayStatus = remote } = {}) {
  let daemon = null, record = null, error;
  try { ({ daemon, record } = inspect(home)); } catch (e) { error = e.message; }
  if (daemon?.state === 'starting') error = `DEV daemon PID ${daemon.pid} was left by an interrupted start and has no confirmed record; run npm run dev:stop`;
  else if (!daemon && record?.state === 'starting') error = 'An interrupted dev start left no daemon; dev:start or dev:stop will discard its record';
  const deployment = existsSync(join(home, 'deployment.json')) ? read(join(home, 'deployment.json')) : null;
  let relay = null;
  try { if (existsSync(join(home, 'dev-pairing.json'))) relay = await relayStatus(validatePairing(read(join(home, 'dev-pairing.json')))); }
  catch (e) { error = [error, e.message].filter(Boolean).join('; '); }
  const result = { environment: 'DEV', url: TARGET.url, home, port: TARGET.port, pid: daemon?.pid ?? null, commit: deployment?.commit ?? null, relay, ...(error ? { error } : {}), log: join(home, 'daemon.log') };
  console.log(JSON.stringify(result, null, 2));
  return result;
}
export async function stop(home) {
  const { file, record, daemon } = inspect(home);
  if (!daemon) {
    if (record?.state === 'starting') { rmSync(file); console.log('DEV daemon is stopped; discarded the record of an interrupted start'); return; }
    console.log('DEV daemon is stopped'); return;
  }
  // Re-prove identity immediately before signalling.
  if (processIdentity(daemon.pid) !== daemon.identity) throw new Error(`Daemon PID identity changed; refusing to signal an unrelated process. Remove only ${file} to discard the stale record, then retry.`);
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
    // Use dependencies installed for the selected checkout, only with its exact
    // lockfile. Lockfile equality is a precondition, not proof of what is
    // installed: record the installed tree's identity so start can re-verify it.
    if (!readFileSync(join(snapshot, 'package-lock.json')).equals(readFileSync(join(source, 'package-lock.json')))) throw new Error('Install matching dependencies in a worktree for that ref first');
    const modules = realpathSync(join(source, 'node_modules'));
    const dependencies = { realpath: modules, identity: await dependencyIdentity(modules) };
    symlinkSync(modules, join(snapshot, 'node_modules'));
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
    save(join(home, 'deployment.json'), { release: snapshot.slice(home.length + 1), commit, source, dependencies });
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
// Terminate a child this process spawned (and still holds the handle to) and
// prove it exited. Used only for a daemon whose record was never promoted.
async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise((resolve) => child.once('exit', () => resolve(true)));
  const within = (ms) => Promise.race([exit, delay(ms, false, { ref: false })]);
  child.kill('SIGTERM');
  if (await within(10000)) return;
  child.kill('SIGKILL');
  if (await within(5000)) return;
  throw new Error(`DEV daemon PID ${child.pid} did not exit after a failed start; its startup record is kept for npm run dev:stop`);
}
const redeploy = 'reinstall matching dependencies and run npm run dev:deploy again';
export async function verifyDependencies(snapshot, deployment) {
  const recorded = deployment.dependencies;
  if (typeof recorded?.realpath !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(recorded?.identity ?? '')) throw new Error('Dev deployment has no installed-dependency record (deployed by an older workflow); run npm run dev:deploy again');
  let linked;
  try { linked = realpathSync(join(snapshot, 'node_modules')); } catch { linked = null; }
  if (linked !== recorded.realpath) throw new Error(`Snapshot node_modules resolves to ${linked ?? 'nothing'}, not the deployed ${recorded.realpath}; ${redeploy}`);
  const identity = await dependencyIdentity(linked);
  if (identity !== recorded.identity) throw new Error(`Installed dependencies changed since deploy (${linked}: ${identity} != deployed ${recorded.identity}); ${redeploy}`);
}
export async function start(home, { relayStatus = remote, checkPort, execute = run, port = TARGET.port, saveRecord = save, readyAttempts = 60, readyInterval = 500 } = {}) {
  const current = inspect(home);
  if (current.daemon?.state === 'starting') throw new Error(`DEV daemon PID ${current.daemon.pid} was left by an interrupted start; run npm run dev:stop first`);
  if (current.daemon) throw new Error('DEV daemon already running; use dev:status or dev:stop');
  // An interrupted start whose daemon no longer exists: discard its record.
  if (current.record?.state === 'starting') rmSync(current.file);
  const deployment = read(join(home, 'deployment.json'));
  const snapshot = releasePath(home, deployment);
  // Before any spawn: the snapshot must still run against the exact installed tree deployed.
  await verifyDependencies(snapshot, deployment);
  const pair = validatePairing(read(join(home, 'dev-pairing.json')));
  const relay = await relayStatus(pair);
  if (relay.commit !== deployment.commit) throw new Error('Deployed Worker does not match the local snapshot; redeploy before starting');
  if (relay.relay.online) throw new Error('Another dev host is connected; refusing to replace it');
  await (checkPort ?? (() => freePort(port)))();
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
  const daemonFile = join(home, 'daemon.json'), id = randomUUID();
  // Publish intent before spawning: if this process dies before promotion, the
  // unique `run.mjs <id>` argv lets stop/start locate the orphan safely.
  saveRecord(daemonFile, { id, state: 'starting', startedAt: new Date().toISOString() });
  let child;
  try {
    const log = openSync(logPath, 'w', 0o600);
    try {
      child = spawn(process.execPath, ['--experimental-strip-types', entry, id], {
        cwd: snapshot, detached: true, stdio: ['ignore', log, log],
        env: { ...process.env, FOREMAN_HOME: home, FOREMAN_PORT: String(port), FOREMAN_RELAY_URL: TARGET.url, FOREMAN_HOST_TOKEN: pair.token,
          CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex') },
      });
    } finally { closeSync(log); }
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  } catch (error) {
    // No process was created: the intent record is safe to discard.
    rmSync(daemonFile, { force: true });
    throw error;
  }
  try {
    saveRecord(daemonFile, { id, pid: child.pid, identity: processIdentity(child.pid), state: 'running' });
  } catch (error) {
    // Never leave an untracked daemon: stop the child we hold, prove its exit,
    // and only then discard the intent record.
    await terminateChild(child);
    rmSync(daemonFile, { force: true });
    throw error;
  }
  child.unref();
  try {
    for (let i = 0; i < readyAttempts; i++) {
      if (!running(home)) throw new Error(`DEV daemon exited; see ${logPath}`);
      let health;
      try { health = await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).json(); } catch {}
      if (health?.pid === child.pid && (await relayStatus(pair)).relay.online) { await status(home, { relayStatus }); return; }
      await delay(readyInterval);
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
function wranglerAuth(home) { return JSON.parse(run(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'auth', 'token', '--json'], { cwd: home })); }
export async function destroy(home, { readAuth = wranglerAuth, deleter = deleteDevWorker } = {}) {
  await stop(home);
  let auth;
  try { auth = await readAuth(home); }
  catch { throw new Error('Cannot retrieve Cloudflare authentication; run npx wrangler login'); }
  const headers = auth.type === 'api_key' ? { 'X-Auth-Key': auth.key, 'X-Auth-Email': auth.email } : { authorization: `Bearer ${auth.token}` };
  await deleter(headers);
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
