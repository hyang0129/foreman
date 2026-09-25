// Integrated dev lifecycle coverage (#32): actual startup, lock contention and
// crash recovery, remote partial success, cleanup publication failure, and
// teardown. Every test uses a temporary HOME / dev home and a temporary git
// source. Remote boundaries (Wrangler deployer, relay status, Cloudflare auth
// and delete, provider auth) are injected; global fetch refuses every
// non-loopback URL so nothing here can reach Cloudflare. Daemons listen only on
// an injected free port. Every process is a disposable script this test spawned
// and is cleaned up through its own handle or its proven identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, realpathSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { deploy, start, stop, status, destroy, deleteDevWorker, acquireLock, running, openHome, processIdentity, TARGET } from '../scripts/dev-environment.mjs';

const scriptPath = realpathSync('scripts/dev-environment.mjs');
const scriptUrl = pathToFileURL(scriptPath).href;

// No test in this file may reach a remote host: only loopback health checks pass.
const realFetch = globalThis.fetch;
const remoteAttempts = [];
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname !== '127.0.0.1') { remoteAttempts.push(url.href); return Promise.reject(new Error(`test refused remote fetch ${url.href}`)); }
  return realFetch(input, init);
};
// Reset per test so one offender cannot cascade into later tests.
test.afterEach(() => assert.deepEqual(remoteAttempts.splice(0), [], 'no remote fetch was attempted'));

// Stand-in for server/main.ts in the deployed snapshot. It serves only
// /api/health on the injected FOREMAN_PORT (unless built silent), records its
// PID and the environment start gave it, and reports a graceful SIGTERM.
const fixtureMain = (serve) => `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.FOREMAN_HOME;
process.on('SIGTERM', () => { writeFileSync(join(home, 'fixture-sigterm'), String(process.pid)); process.exit(0); });
writeFileSync(join(home, 'fixture-env.json'), JSON.stringify({ port: process.env.FOREMAN_PORT, home, claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME, relay: process.env.FOREMAN_RELAY_URL }));
writeFileSync(join(home, 'fixture-pid'), String(process.pid));
${serve ? `createServer((request, response) => {
  if (request.url !== '/api/health') { response.statusCode = 404; response.end(); return; }
  response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ pid: process.pid }));
}).listen(Number(process.env.FOREMAN_PORT), '127.0.0.1');` : 'setInterval(() => {}, 1000);'}
`;

// Child processes never inherit a credential or a route to a stored login:
// every Cloudflare/Wrangler/provider credential variable is removed, and HOME
// and XDG_CONFIG_HOME (where Wrangler keeps its OAuth login) point into the
// test's temporary directory.
const credential = /^(CLOUDFLARE_|CF_|WRANGLER_|FOREMAN_|ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_)|^(NODE_OPTIONS|NODE_TEST_CONTEXT|XDG_CONFIG_HOME|GH_TOKEN|GITHUB_TOKEN)$/;
function cleanEnv(dir, base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) if (!credential.test(key)) env[key] = value;
  return { ...env, HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') };
}
// Loaded into CLI children with --import: any non-loopback fetch fails there too.
function fetchGuard(dir) {
  const file = join(dir, 'fetch-guard.mjs');
  if (!existsSync(file)) writeFileSync(file, `const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname !== '127.0.0.1') return Promise.reject(new Error('test child refused remote fetch ' + url.href));
  return real(input, init);
};
`);
  return file;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function until(check, what, ms = 10000) {
  for (let waited = 0; waited < ms; waited += 50) { if (check()) return; await delay(50); }
  assert.fail(`Timed out waiting for ${what}`);
}
async function injectedPort() {
  const server = createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address(); await new Promise((r) => server.close(r));
  assert.notEqual(port, TARGET.port); return port;
}
async function captureLog(fn) {
  const lines = [], warnings = [], original = console.log, originalWarn = console.warn;
  console.log = (...args) => lines.push(args.join(' '));
  console.warn = (...args) => warnings.push(args.join(' '));
  try { const result = await fn(); return { result, output: lines.join('\n'), warnings: warnings.join('\n') }; } finally { console.log = original; console.warn = originalWarn; }
}
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
const releases = (home) => readdirSync(home).filter((name) => name.startsWith('release-')).sort();
const leftovers = (home) => readdirSync(home).filter((name) => /^(archive-|secrets-|operation-owner-|operation-recovery-)|\.json\./.test(name));

// A temporary HOME holding a dev home and a committed git source with an
// installed (gitignored) node_modules tree.
function fixture(t, { serve = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-dev-lifecycle-')));
  const home = openHome(dir), source = join(dir, 'source');
  // Before removing the directory, kill a daemon left behind by a failing test,
  // but only if it is still the process this dev home launched.
  t.after(() => {
    const pidFile = join(home, 'fixture-pid');
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (processIdentity(pid).includes(`${join(home, 'run.mjs')} `)) process.kill(pid, 'SIGKILL');
    }
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(join(source, 'web'), { recursive: true }); mkdirSync(join(source, 'server')); mkdirSync(join(source, 'node_modules/pkg'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.email', 'fixture@example.com'); git('config', 'user.name', 'Fixture');
  writeFileSync(join(source, '.gitignore'), 'node_modules\n');
  writeFileSync(join(source, 'node_modules/pkg/index.js'), 'module.exports = 1;\n');
  writeFileSync(join(source, 'package-lock.json'), '{}');
  writeFileSync(join(source, 'web/index.html'), '<title>Test</title><body></body>');
  writeFileSync(join(source, 'wrangler.jsonc'), '{ "vars": {"FIREBASE_CONFIG":"public-config"}, "durable_objects": {"bindings": [{"name": "RELAY", "class_name": "HostRelay"}]}, "migrations": [{"tag": "v1", "new_sqlite_classes": ["HostRelay"]}], "assets": {"directory": "./web", "binding": "ASSETS"} }');
  writeFileSync(join(source, 'server/main.ts'), fixtureMain(serve));
  const commit = (message = 'fixture') => { writeFileSync(join(source, 'revision'), message); git('add', '.'); git('commit', '-m', message); return git('rev-parse', 'HEAD'); };
  return { dir, home, source, commit, daemonFile: join(home, 'daemon.json'), deploymentFile: join(home, 'deployment.json'), pairFile: join(home, 'dev-pairing.json') };
}
// Mocked Wrangler: records every call and the HOST_TOKEN each secrets file carried.
function deployer(behavior = () => {}) {
  const calls = [];
  const fn = async (home, config, args) => {
    const secrets = args[args.indexOf('--secrets-file') + 1];
    calls.push({ dryRun: args.includes('--dry-run'), token: json(secrets).HOST_TOKEN, config: json(config) });
    await behavior(calls.length, home);
  };
  return { fn, calls };
}
async function deployed(f, ref) {
  const d = deployer();
  await captureLog(() => deploy(f.home, { source: f.source, ref }, d.fn));
  assert.equal(d.calls.length, 2);
  return json(f.deploymentFile);
}
function relayMock(commit, onlineFrom) {
  const relay = { calls: 0, tokens: [] };
  relay.fn = async (pair) => { relay.calls++; relay.tokens.push(pair.token); return { environment: 'dev', commit, relay: { online: relay.calls >= onlineFrom } }; };
  return relay;
}
function authMock() {
  const auth = { calls: [] };
  auth.fn = (binary, args, options) => { auth.calls.push({ binary, args, env: options.env }); return '{"loggedIn":true}'; };
  return auth;
}

// 1. Actual startup ------------------------------------------------------------

test('actual startup: a real deploy then start runs a real daemon to health and relay readiness, status reflects it, and stop proves exit', async (t) => {
  const f = fixture(t), commit = f.commit(), port = await injectedPort();
  const deployment = await deployed(f, commit);
  assert.equal(deployment.commit, commit);
  const pair = json(f.pairFile);
  // Relay offline at preflight and on the first healthy poll; online from the third call.
  const relay = relayMock(commit, 3), auth = authMock();
  const { output } = await captureLog(() => start(f.home, { relayStatus: relay.fn, execute: auth.fn, port }));

  // start resolved only after the daemon answered health and the relay reported
  // online: calls 2 and 3 happen only once health matched the child PID, and the
  // 4th is the final status report.
  assert.equal(relay.calls, 4);
  assert.deepEqual(relay.tokens, Array(4).fill(pair.token));
  assert.deepEqual(auth.calls.map((c) => c.args), [['login', 'status'], ['auth', 'status', '--json']]);
  assert.equal(auth.calls[0].env.CODEX_HOME, join(f.home, 'codex'));
  assert.equal(auth.calls[1].env.CLAUDE_CONFIG_DIR, join(f.home, 'claude'));

  const pid = Number(readFileSync(join(f.home, 'fixture-pid'), 'utf8'));
  assert.equal(alive(pid), true);
  const record = json(f.daemonFile);
  assert.equal(record.state, 'running'); assert.equal(record.pid, pid);
  assert.ok(record.identity.endsWith(` ${join(f.home, 'run.mjs')} ${record.id}`), record.identity);
  assert.equal(record.identity, processIdentity(pid));
  assert.deepEqual(json(join(f.home, 'fixture-env.json')), { port: String(port), home: f.home, claude: join(f.home, 'claude'), codex: join(f.home, 'codex'), relay: TARGET.url });
  const reported = JSON.parse(output.slice(output.indexOf('{')));
  assert.equal(reported.pid, pid); assert.equal(reported.commit, commit); assert.equal(reported.error, undefined);

  // The daemon really answers health on the injected port.
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(), { pid });
  const { result } = await captureLog(() => status(f.home, { relayStatus: relay.fn }));
  assert.equal(result.pid, pid); assert.equal(result.commit, commit); assert.equal(result.relay.relay.online, true); assert.equal(result.error, undefined);
  assert.deepEqual(json(f.daemonFile), record, 'status does not mutate');

  const stopped = await captureLog(() => stop(f.home));
  assert.equal(stopped.output, 'DEV daemon stopped');
  assert.equal(Number(readFileSync(join(f.home, 'fixture-sigterm'), 'utf8')), pid, 'daemon received SIGTERM');
  await until(() => !alive(pid), 'daemon exit');
  assert.equal(processIdentity(pid), '');
  assert.equal(existsSync(f.daemonFile), false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }));
});

for (const [name, serve, pattern] of [
  ['the daemon never becomes healthy', false, 1],
  ['the relay never comes online', true, 2],
]) test(`startup readiness failure stops the real daemon and rethrows: ${name}`, async (t) => {
  const f = fixture(t, { serve }), commit = f.commit(), port = await injectedPort();
  await deployed(f, commit);
  const relay = relayMock(commit, Infinity);
  let error;
  const { output } = await captureLog(() => start(f.home, { relayStatus: relay.fn, execute: authMock().fn, port, readyAttempts: 40, readyInterval: 100 }).catch((e) => { error = e; }));
  assert.ok(error, 'start rejected');
  assert.match(error.message, /DEV daemon\/relay did not become ready; see .*daemon\.log/);
  // A silent daemon never passes health, so only the preflight relay call ran;
  // a healthy daemon was polled on the relay at least once more.
  if (pattern === 1) assert.equal(relay.calls, 1); else assert.ok(relay.calls >= 2, `relay polled after health (${relay.calls})`);
  const pid = Number(readFileSync(join(f.home, 'fixture-pid'), 'utf8'));
  assert.equal(Number(readFileSync(join(f.home, 'fixture-sigterm'), 'utf8')), pid, 'start stopped the daemon it launched');
  await until(() => !alive(pid), 'daemon exit');
  assert.equal(processIdentity(pid), '');
  assert.equal(existsSync(f.daemonFile), false);
  assert.equal(running(f.home), null);
  assert.match(output, /DEV daemon stopped/);
});

// 2. Lock contention and crash -------------------------------------------------

function lockHolder(t, home) {
  const driver = join(home, '..', `lock-holder-${randomUUID()}.mjs`);
  writeFileSync(driver, `const [url, home] = process.argv.slice(2);
const { acquireLock } = await import(url);
acquireLock(home); console.log('locked'); setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [driver, scriptUrl, home], { stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv(dirname(home)) });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return child;
}
function idleProcess(t, dir) {
  const file = join(dir, `idle-${randomUUID()}.mjs`);
  writeFileSync(file, 'console.log("ready"); setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'ignore'], env: cleanEnv(dir) });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return child;
}
const cliArgs = (f, ...args) => ['--import', pathToFileURL(fetchGuard(f.dir)).href, ...args];
function cli(f, command) {
  return execFileSync(process.execPath, cliArgs(f, scriptPath, command), { env: cleanEnv(f.dir), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
async function crash(child) {
  const exited = once(child, 'exit');
  child.kill('SIGKILL'); await exited;
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(processIdentity(child.pid), '');
}

test('a live lock owner process makes acquire and mutating CLI commands refuse; after it crashes the next acquire recovers', async (t) => {
  const f = fixture(t), lock = join(f.home, 'operation.lock');
  const holder = lockHolder(t, f.home);
  await once(holder.stdout, 'data');
  const owner = json(join(lock, 'owner.json'));
  assert.equal(owner.pid, holder.pid); assert.equal(owner.identity, processIdentity(holder.pid));

  assert.throws(() => acquireLock(f.home), new RegExp(`Another dev operation is active \\(PID ${holder.pid}\\)`));
  // The CLI children below run with exactly this environment and preload: prove
  // it carries no credential, no reachable stored login, and no remote fetch.
  const polluted = { ...process.env, CLOUDFLARE_API_TOKEN: 'sentinel', CLOUDFLARE_API_KEY: 'sentinel', CF_API_TOKEN: 'sentinel', WRANGLER_OAUTH_TOKEN: 'sentinel', CLOUDFLARE_EMAIL: 'sentinel', XDG_CONFIG_HOME: '/Users/elsewhere/.config' };
  const probe = JSON.parse(execFileSync(process.execPath, cliArgs(f, '--input-type=module', '-e', `
    let remote; try { await fetch('https://api.cloudflare.com/client/v4/accounts'); remote = 'reached'; } catch (error) { remote = error.message; }
    console.log(JSON.stringify({ env: process.env, remote }));`), { env: cleanEnv(f.dir, polluted), encoding: 'utf8' }));
  assert.deepEqual(Object.keys(probe.env).filter((key) => credential.test(key) && key !== 'XDG_CONFIG_HOME'), []);
  assert.ok(!Object.values(probe.env).includes('sentinel'));
  assert.equal(probe.env.HOME, f.dir); assert.equal(probe.env.XDG_CONFIG_HOME, join(f.dir, '.config'));
  assert.equal(probe.remote, 'test child refused remote fetch https://api.cloudflare.com/client/v4/accounts');
  assert.deepEqual(Object.keys(cleanEnv(f.dir)).filter((key) => /^(CLOUDFLARE_|CF_|WRANGLER_)/.test(key)), []);
  for (const command of ['stop', 'start', 'destroy']) assert.throws(() => cli(f, command), (error) => {
    assert.match(error.stderr, new RegExp(`Another dev operation is active \\(PID ${holder.pid}\\)`)); return true;
  });
  // Contention neither disturbed the owner nor left partial claims behind.
  assert.equal(alive(holder.pid), true); assert.equal(holder.exitCode, null);
  assert.deepEqual(json(join(lock, 'owner.json')), owner);
  assert.deepEqual(leftovers(f.home), []);

  await crash(holder);
  const release = acquireLock(f.home);
  const recovered = json(join(lock, 'owner.json'));
  assert.equal(recovered.pid, process.pid); assert.equal(recovered.identity, processIdentity(process.pid));
  assert.equal(existsSync(join(lock, 'recovery')), false);
  release();
  assert.equal(existsSync(lock), false);
  assert.deepEqual(leftovers(f.home), []);
});

test('stale-lock recovery refuses while another live recoverer holds the claim, and proceeds once that recoverer crashes', async (t) => {
  const f = fixture(t), lock = join(f.home, 'operation.lock');
  const holder = lockHolder(t, f.home);
  await once(holder.stdout, 'data');
  await crash(holder);
  const staleOwner = json(join(lock, 'owner.json'));
  assert.equal(staleOwner.pid, holder.pid);
  // A live process has claimed recovery of the stale lock (the record a
  // contender publishes by renaming its claim into operation.lock/recovery).
  const recoverer = idleProcess(t, f.dir);
  await once(recoverer.stdout, 'data');
  mkdirSync(join(lock, 'recovery'), { mode: 0o700 });
  const claim = { pid: recoverer.pid, identity: processIdentity(recoverer.pid) };
  writeJson(join(lock, 'recovery/owner.json'), claim);

  assert.throws(() => acquireLock(f.home), /Dev lock recovery in progress; retry/);
  assert.deepEqual(json(join(lock, 'owner.json')), staleOwner, 'stale lock left for the live recoverer');
  assert.deepEqual(json(join(lock, 'recovery/owner.json')), claim);
  assert.equal(alive(recoverer.pid), true);
  assert.deepEqual(leftovers(f.home), []);

  await crash(recoverer);
  const release = acquireLock(f.home);
  assert.equal(json(join(lock, 'owner.json')).pid, process.pid);
  assert.equal(existsSync(join(lock, 'recovery')), false);
  release();
  assert.equal(existsSync(lock), false);
  assert.deepEqual(leftovers(f.home), []);
});

// 3. Remote partial success ----------------------------------------------------

test('dry-run succeeds but upload fails: previous deployment kept, snapshot removed, pairing retained and reused by the next deploy', async (t) => {
  const f = fixture(t);
  const first = await deployed(f, f.commit('first'));
  const pair = json(f.pairFile);
  const second = f.commit('second');
  const failing = deployer((call) => { if (call === 2) throw new Error('injected upload failure'); });
  await assert.rejects(deploy(f.home, { source: f.source, ref: second }, failing.fn), /injected upload failure/);
  assert.deepEqual(failing.calls.map((c) => c.dryRun), [true, false]);
  assert.deepEqual(failing.calls.map((c) => c.token), [pair.token, pair.token]);
  assert.deepEqual(json(f.deploymentFile), first);
  assert.deepEqual(releases(f.home), [first.release]);
  assert.deepEqual(json(f.pairFile), pair, 'pairing retained for reuse');
  assert.deepEqual(leftovers(f.home), []);

  const retry = deployer();
  await captureLog(() => deploy(f.home, { source: f.source, ref: second }, retry.fn));
  assert.deepEqual(retry.calls.map((c) => c.token), [pair.token, pair.token], 'the retained credential is reused');
  assert.deepEqual(json(f.pairFile), pair);
  const current = json(f.deploymentFile);
  assert.equal(current.commit, second); assert.notEqual(current.release, first.release);
  assert.deepEqual(releases(f.home), [current.release]);
});

test('upload succeeds but deployment record publication fails: no new record, snapshot cleaned, error surfaced, next deploy works', async (t) => {
  const f = fixture(t);
  const first = await deployed(f, f.commit('first'));
  const second = f.commit('second');
  // After the upload succeeds, the published record becomes unsafe to replace,
  // so the atomic save of the new deployment.json refuses.
  const uploaded = deployer((call) => { if (call === 2) chmodSync(f.deploymentFile, 0o644); });
  await assert.rejects(deploy(f.home, { source: f.source, ref: second }, uploaded.fn), (error) => {
    assert.equal(error.message, `Refusing unsafe dev path: ${f.deploymentFile}`); return true;
  });
  assert.deepEqual(uploaded.calls.map((c) => c.dryRun), [true, false], 'the upload itself succeeded');
  assert.deepEqual(json(f.deploymentFile), first, 'no new record was published');
  assert.deepEqual(releases(f.home), [first.release], 'the new snapshot was removed');
  assert.deepEqual(leftovers(f.home), []);

  chmodSync(f.deploymentFile, 0o600);
  const retry = deployer();
  await captureLog(() => deploy(f.home, { source: f.source, ref: second }, retry.fn));
  assert.equal(retry.calls.length, 2);
  const current = json(f.deploymentFile);
  assert.equal(current.commit, second);
  assert.deepEqual(releases(f.home), [current.release]);
});

// 4. Cleanup publication failure -----------------------------------------------

// #56: once the new deployment record is published the deploy has committed, so
// pruning superseded releases is best-effort. A refused release is reported with
// how to remove it, pruning continues past it, and deploy resolves (CLI exit 0).
test('pruning failure after the new record is published (#56): deploy still succeeds, reports DEV deployed, and warns naming the unsafe old release, which remains', async (t) => {
  const f = fixture(t);
  const first = await deployed(f, f.commit('first'));
  const second = f.commit('second');
  // The superseded release is no longer owner-only, so owned() refuses to prune it.
  const oldRelease = join(f.home, first.release);
  chmodSync(oldRelease, 0o755);
  const d = deployer();
  // The deploy has committed, so pruning is best-effort: deploy resolves.
  const { output, warnings } = await captureLog(() => deploy(f.home, { source: f.source, ref: second }, d.fn));
  assert.equal(d.calls.length, 2);
  assert.match(output, new RegExp(`^DEV deployed ${second}$`, 'm'));
  assert.match(warnings, /Warning: DEV deployed, but 1 superseded release directory was not pruned/);
  assert.ok(warnings.includes(`${oldRelease} (Refusing unsafe dev path: ${oldRelease})`), warnings);
  assert.ok(warnings.includes(`rm -rf ${JSON.stringify(oldRelease)}`), warnings);
  const current = json(f.deploymentFile);
  assert.equal(current.commit, second);
  assert.notEqual(current.release, first.release);
  assert.ok(statSync(join(f.home, current.release)).isDirectory(), 'the new release stands');
  assert.ok(existsSync(join(f.home, current.release, 'dev-worker.ts')));
  assert.ok(!warnings.includes(current.release), 'the new release is never named as unpruned');
  assert.deepEqual(releases(f.home), [first.release, current.release].sort());
  assert.equal(statSync(oldRelease).mode & 0o777, 0o755, 'the refused release is untouched');
  assert.deepEqual(leftovers(f.home), []);
});

test('pruning continues past a refused release (#56): with two superseded releases, the later one is still pruned and only the refused one is reported', async (t) => {
  const f = fixture(t);
  const first = await deployed(f, f.commit('first'));
  // A second superseded release that is not owner-only. Its name sorts before
  // every mkdtemp release name, so on a sorted directory listing (APFS) the
  // prune loop visits it first and must continue past it.
  const refused = join(f.home, 'release-000');
  mkdirSync(refused); writeFileSync(join(refused, 'marker'), 'old'); chmodSync(refused, 0o755);
  assert.deepEqual(releases(f.home), ['release-000', first.release]);
  const second = f.commit('second');
  const d = deployer();
  const { output, warnings } = await captureLog(() => deploy(f.home, { source: f.source, ref: second }, d.fn));
  assert.equal(d.calls.length, 2);
  assert.match(output, new RegExp(`^DEV deployed ${second}$`, 'm'));
  const current = json(f.deploymentFile);
  assert.equal(current.commit, second);
  // The superseded first release, visited after the refused one, was pruned.
  assert.equal(existsSync(join(f.home, first.release)), false, 'the later superseded release was pruned');
  assert.deepEqual(releases(f.home), ['release-000', current.release].sort());
  assert.match(warnings, /1 superseded release directory was not pruned/);
  assert.ok(warnings.includes(`${refused} (Refusing unsafe dev path: ${refused})`), warnings);
  assert.ok(warnings.includes(`rm -rf ${JSON.stringify(refused)}`), warnings);
  assert.ok(!warnings.includes(first.release) && !warnings.includes(current.release), warnings);
  assert.equal(statSync(refused).mode & 0o777, 0o755, 'the refused release is untouched');
  assert.equal(readFileSync(join(refused, 'marker'), 'utf8'), 'old');
  assert.deepEqual(leftovers(f.home), []);
});

test('a clean prune prints no warning', async (t) => {
  const f = fixture(t);
  await deployed(f, f.commit('first'));
  const second = f.commit('second');
  const { output, warnings } = await captureLog(() => deploy(f.home, { source: f.source, ref: second }, deployer().fn));
  assert.match(output, new RegExp(`^DEV deployed ${second}$`, 'm'));
  assert.equal(warnings, '');
  assert.deepEqual(releases(f.home), [json(f.deploymentFile).release]);
});

// 5. Teardown ------------------------------------------------------------------

// A real disposable daemon recorded as running in this dev home.
async function recordedDaemon(t, home) {
  const entry = join(home, 'run.mjs'), id = randomUUID();
  writeFileSync(entry, `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(join(home, '..', 'daemon-sigterm'))}, String(process.pid)); process.exit(0); });
setInterval(() => {}, 1000); console.log('ready');
`, { mode: 0o600 });
  const child = spawn(process.execPath, [entry, id], { stdio: ['ignore', 'pipe', 'ignore'], env: cleanEnv(dirname(home)) });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data');
  writeJson(join(home, 'daemon.json'), { id, pid: child.pid, identity: processIdentity(child.pid), state: 'running' });
  assert.equal(running(home).pid, child.pid);
  return child;
}
function devState(f) {
  writeJson(f.deploymentFile, { release: 'release-fixture', commit: 'a'.repeat(40) });
  writeJson(f.pairFile, { environment: 'foreman-dev-v1', url: TARGET.url, token: 'b'.repeat(64) });
}
const deleteUrl = `https://api.cloudflare.com/client/v4/accounts/${TARGET.account}/workers/scripts/${TARGET.worker}?force=false`;
function cloudflare(response) {
  const api = { requests: [] };
  api.deleter = (headers) => deleteDevWorker(headers, async (url, options) => { api.requests.push({ url, ...options }); return response(); });
  return api;
}

test('destroy stops the real daemon, deletes only the dev Worker with force=false, then removes the dev home', async (t) => {
  const f = fixture(t); devState(f);
  const daemon = await recordedDaemon(t, f.home);
  const exited = once(daemon, 'exit');
  let reads = 0;
  const api = cloudflare(() => Response.json({ success: true }));
  const { output } = await captureLog(() => destroy(f.home, {
    readAuth: (home) => { reads++; assert.equal(home, f.home); assert.equal(processIdentity(daemon.pid), '', 'daemon stopped before auth'); return { type: 'oauth', token: 'fake-oauth' }; },
    deleter: api.deleter,
  }));
  await exited;
  assert.equal(Number(readFileSync(join(f.dir, 'daemon-sigterm'), 'utf8')), daemon.pid);
  assert.equal(reads, 1);
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].url, deleteUrl); assert.equal(api.requests[0].method, 'DELETE');
  assert.deepEqual(api.requests[0].headers, { authorization: 'Bearer fake-oauth' });
  assert.equal(existsSync(f.home), false, 'dev home removed');
  assert.equal(existsSync(f.dir), true);
  assert.match(output, /DEV daemon stopped[\s\S]*DEV Worker and local dev state removed/);
});

test('destroy retains local state when the deleter refuses, after the daemon was already stopped', async (t) => {
  const f = fixture(t); devState(f);
  const daemon = await recordedDaemon(t, f.home);
  const exited = once(daemon, 'exit');
  const before = { deployment: readFileSync(f.deploymentFile, 'utf8'), pair: readFileSync(f.pairFile, 'utf8') };
  const api = cloudflare(() => Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 }));
  await assert.rejects(captureLog(() => destroy(f.home, { readAuth: () => ({ type: 'api_key', key: 'fake-key', email: 'fake@example.com' }), deleter: api.deleter })),
    /Dev Worker deletion refused \(403\); local state retained/);
  await exited;
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].url, deleteUrl);
  assert.deepEqual(api.requests[0].headers, { 'X-Auth-Key': 'fake-key', 'X-Auth-Email': 'fake@example.com' });
  assert.equal(processIdentity(daemon.pid), ''); assert.equal(existsSync(f.daemonFile), false);
  assert.equal(readFileSync(f.deploymentFile, 'utf8'), before.deployment);
  assert.equal(readFileSync(f.pairFile, 'utf8'), before.pair);
  assert.equal(readFileSync(join(f.home, 'owner'), 'utf8'), 'foreman-dev-v1');
});

test('destroy retains local state and names the login step when the auth token cannot be read', async (t) => {
  const f = fixture(t); devState(f);
  const daemon = await recordedDaemon(t, f.home);
  const exited = once(daemon, 'exit');
  let deletes = 0;
  await assert.rejects(captureLog(() => destroy(f.home, { readAuth: () => { throw new Error('secret-auth-output'); }, deleter: async () => { deletes++; } })), (error) => {
    assert.equal(error.message, 'Cannot retrieve Cloudflare authentication; run npx wrangler login'); return true;
  });
  await exited;
  assert.equal(deletes, 0);
  assert.equal(processIdentity(daemon.pid), ''); assert.equal(existsSync(f.daemonFile), false);
  assert.ok(existsSync(f.deploymentFile)); assert.ok(existsSync(f.pairFile)); assert.ok(existsSync(f.home));
});
