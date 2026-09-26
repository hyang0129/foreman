// Startup transaction and orphan recovery for the dev daemon (#30).
// Every process here is a disposable script spawned by the test itself, in a
// temporary dev home, and is cleaned up by the PID the test learned from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openHome, start, stop, status, running, findOrphans, processIdentity, dependencyIdentity, TARGET } from '../scripts/dev-environment.mjs';

const script = pathToFileURL(realpathSync('scripts/dev-environment.mjs')).href;
const commit = 'c'.repeat(40);
const idle = 'setInterval(() => {}, 1000); console.log("ready");\n';
// Harmless stand-in for server/main.ts: records its PID, reports a graceful
// SIGTERM, and otherwise idles. It never listens on any port.
// Each marker is written to a temporary file and renamed into place, so a
// marker that exists is complete: a reader never sees it created but still
// empty (#149).
const fakeMain = `import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.FOREMAN_HOME;
function publish(name, text) {
  const temp = join(home, \`.\${name}.\${process.pid}.tmp\`);
  writeFileSync(temp, text);
  renameSync(temp, join(home, name));
}
process.on('SIGTERM', () => { publish('daemon-sigterm', String(process.pid)); process.exit(0); });
publish('daemon-ready', String(process.pid));
setInterval(() => {}, 1000);
`;

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('FOREMAN_') || ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT'].includes(key)) delete env[key];
  return env;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function until(check, what, ms = 10000) {
  for (let waited = 0; waited < ms; waited += 50) { if (check()) return; await delay(50); }
  assert.fail(`Timed out waiting for ${what}`);
}
// Kill a leftover only if it is still the exact disposable process this test created.
function reap(t, pid, argvTail) {
  t.after(() => { if (processIdentity(pid).endsWith(argvTail)) process.kill(pid, 'SIGKILL'); });
}
async function injectedPort() {
  const server = createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address(); await new Promise((r) => server.close(r));
  assert.notEqual(port, TARGET.port); return port;
}
const emptyIdentity = await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-dev-empty-'));
  try { return await dependencyIdentity(dir); } finally { rmSync(dir, { recursive: true }); }
})();
function fixture(t, { pairing = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-dev-start-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = openHome(dir), release = 'release-fixture';
  mkdirSync(join(home, release, 'server'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, release, 'server/main.ts'), fakeMain);
  // A valid (empty) installed-dependency tree linked into the snapshot (#29).
  const modules = join(dir, 'node_modules'); mkdirSync(modules); symlinkSync(modules, join(home, release, 'node_modules'));
  writeJson(join(home, 'deployment.json'), { release, commit, dependencies: { realpath: modules, identity: emptyIdentity } });
  if (pairing) writeJson(join(home, 'dev-pairing.json'), { environment: 'foreman-dev-v1', url: TARGET.url, token: 'a'.repeat(64) });
  return { dir, home, daemonFile: join(home, 'daemon.json'), entry: join(home, 'run.mjs') };
}
function writeJson(path, value) { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
const mocks = (port) => ({ relayStatus: async () => ({ commit, relay: { online: false } }), checkPort: async () => {}, execute: () => '{"loggedIn":true}', port });
async function captureLog(fn) {
  const lines = [], original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { const result = await fn(); return { result, output: lines.join('\n') }; } finally { console.log = original; }
}
function spawnIdle(t, file, args) {
  writeFileSync(file, idle, { mode: 0o600 });
  const child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'ignore'], env: cleanEnv() });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return child;
}

test('failed PID record promotion after a real spawn terminates the child and proves it exited', async (t) => {
  const f = fixture(t);
  let seen;
  const saveRecord = (path, value) => {
    if (value.state === 'running') {
      const intent = JSON.parse(readFileSync(path, 'utf8'));
      reap(t, value.pid, ` ${f.entry} ${value.id}`);
      seen = { pid: value.pid, id: value.id, intent, alive: alive(value.pid), identity: processIdentity(value.pid) };
      throw new Error('injected promotion failure');
    }
    writeJson(path, value);
  };
  await assert.rejects(start(f.home, { ...mocks(await injectedPort()), saveRecord }), /injected promotion failure/);
  // The mechanism ran: intent was published and the child was really alive.
  assert.ok(seen, 'promotion was attempted');
  assert.deepEqual(Object.keys(seen.intent).sort(), ['id', 'startedAt', 'state']);
  assert.equal(seen.intent.state, 'starting'); assert.equal(seen.intent.id, seen.id);
  assert.equal(seen.alive, true);
  assert.ok(seen.identity.endsWith(` ${f.entry} ${seen.id}`), seen.identity);
  // ...and afterwards it is gone, with no record left behind.
  assert.equal(alive(seen.pid), false);
  assert.equal(processIdentity(seen.pid), '');
  assert.equal(existsSync(f.daemonFile), false);
  assert.equal(running(f.home), null);
  const { output } = await captureLog(() => stop(f.home));
  assert.equal(output, 'DEV daemon is stopped');
});

test('a start killed between spawn and promotion leaves a starting record that stop resolves to exactly its daemon', async (t) => {
  const f = fixture(t), port = await injectedPort(), pidFile = join(f.dir, 'orphan-pid');
  const driver = join(f.dir, 'driver.mjs');
  writeFileSync(driver, `import { writeFileSync } from 'node:fs';
const [scriptUrl, home, commit, port, pidFile] = process.argv.slice(2);
const { start } = await import(scriptUrl);
await start(home, {
  relayStatus: async () => ({ commit, relay: { online: false } }), checkPort: async () => {}, execute: () => '{"loggedIn":true}', port: Number(port),
  saveRecord: (path, value) => {
    if (value.state === 'running') { writeFileSync(pidFile, String(value.pid)); process.kill(process.pid, 'SIGKILL'); }
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  },
});
`);
  const starter = spawn(process.execPath, [driver, script, f.home, commit, String(port), pidFile], { stdio: ['ignore', 'ignore', 'pipe'], env: cleanEnv() });
  t.after(() => { if (starter.exitCode === null && starter.signalCode === null) starter.kill('SIGKILL'); });
  let stderr = ''; starter.stderr.on('data', (d) => { stderr += d; });
  await once(starter, 'exit');
  assert.equal(starter.signalCode, 'SIGKILL', stderr);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const record = JSON.parse(readFileSync(f.daemonFile, 'utf8'));
  const argvTail = ` ${f.entry} ${record.id}`;
  reap(t, pid, argvTail);

  assert.equal(record.state, 'starting'); assert.equal(record.pid, undefined);
  await until(() => existsSync(join(f.home, 'daemon-ready')), 'orphan daemon readiness');
  assert.equal(Number(readFileSync(join(f.home, 'daemon-ready'), 'utf8')), pid);
  assert.equal(alive(pid), true);
  assert.deepEqual(running(f.home), { id: record.id, pid, identity: processIdentity(pid), state: 'starting' });

  // start refuses while the orphan lives, and leaves it and its record alone.
  await assert.rejects(start(f.home, mocks(port)), new RegExp(`PID ${pid} was left by an interrupted start`));
  assert.equal(alive(pid), true); assert.deepEqual(JSON.parse(readFileSync(f.daemonFile, 'utf8')), record);

  // status reports it without mutating (pairing removed so status stays offline).
  rmSync(join(f.home, 'dev-pairing.json'));
  const { result } = await captureLog(() => status(f.home));
  assert.equal(result.pid, pid); assert.match(result.error, /interrupted start/);
  assert.equal(alive(pid), true); assert.deepEqual(JSON.parse(readFileSync(f.daemonFile, 'utf8')), record);

  const { output } = await captureLog(() => stop(f.home));
  assert.equal(output, 'DEV daemon stopped');
  assert.equal(Number(readFileSync(join(f.home, 'daemon-sigterm'), 'utf8')), pid, 'orphan received SIGTERM from stop');
  await until(() => !alive(pid), 'orphan exit');
  assert.equal(processIdentity(pid), '');
  assert.equal(existsSync(f.daemonFile), false);
});

test('a starting record never matches a live unrelated process, and stop/start discard it without signalling', async (t) => {
  const f = fixture(t, { pairing: false }), id = randomUUID(), otherHome = join(f.dir, 'other');
  mkdirSync(otherHome, { mode: 0o700 });
  const children = [
    spawnIdle(t, f.entry, [randomUUID()]), // same home, different id
    spawnIdle(t, join(otherHome, 'run.mjs'), [id]), // same id, different home
    spawnIdle(t, join(f.dir, 'run.mjs'), [id, 'extra']), // trailing argument
  ];
  // Same home and same id but an extra argument after it.
  children.push(spawn(process.execPath, [f.entry, id, 'extra'], { stdio: ['ignore', 'pipe', 'ignore'], env: cleanEnv() }));
  t.after(() => { const c = children[3]; if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); });
  await Promise.all(children.map((c) => once(c.stdout, 'data')));
  for (const child of children) assert.equal(alive(child.pid), true);

  const intent = { id, state: 'starting', startedAt: new Date().toISOString() };
  writeJson(f.daemonFile, intent);
  assert.deepEqual(findOrphans(f.home, id), []);
  assert.equal(running(f.home), null);

  const { result } = await captureLog(() => status(f.home));
  assert.equal(result.pid, null); assert.match(result.error, /interrupted dev start left no daemon/);
  assert.deepEqual(JSON.parse(readFileSync(f.daemonFile, 'utf8')), intent, 'status does not mutate');

  const { output } = await captureLog(() => stop(f.home));
  assert.match(output, /stopped; discarded the record of an interrupted start/);
  assert.equal(existsSync(f.daemonFile), false);

  // start also discards a stale starting record before its own preflights.
  writeJson(f.daemonFile, intent);
  writeJson(join(f.home, 'dev-pairing.json'), { environment: 'foreman-dev-v1', url: TARGET.url, token: 'a'.repeat(64) });
  await assert.rejects(start(f.home, { relayStatus: async () => { throw new Error('injected relay refusal'); } }), /injected relay refusal/);
  assert.equal(existsSync(f.daemonFile), false);

  for (const child of children) { assert.equal(child.exitCode, null); assert.equal(child.signalCode, null); assert.equal(alive(child.pid), true); }
});

test('orphan lookup ignores other users and rows whose live identity does not match', async (t) => {
  const f = fixture(t, { pairing: false }), id = randomUUID(), argv = `${process.execPath} ${f.entry} ${id}`;
  const uid = process.getuid();
  // A real disposable process whose argv is exactly `<home>/run.mjs <id>`, so
  // only the uid / zombie filters can reject the rows that point at it.
  const child = spawnIdle(t, f.entry, [id]);
  await once(child.stdout, 'data');
  assert.ok(processIdentity(child.pid).endsWith(` ${f.entry} ${id}`));
  const row = (owner, stat) => () => `${child.pid} ${owner} ${stat} ${argv}\n`;
  // Positive control: the same row with our uid and a live state is found.
  assert.deepEqual(findOrphans(f.home, id, row(uid, 'S')).map((o) => o.pid), [child.pid]);
  // Exact argv and a real matching process, but a foreign uid: never a candidate.
  assert.deepEqual(findOrphans(f.home, id, row(uid + 1, 'S')), []);
  // Exact argv and a real matching process, but reported as a zombie: never a candidate.
  assert.deepEqual(findOrphans(f.home, id, row(uid, 'Z')), []);
  // A row claiming the runner's PID with the exact argv is rejected by the live identity re-check.
  assert.deepEqual(findOrphans(f.home, id, () => `${process.pid} ${uid} S ${argv}\n`), []);
  assert.throws(() => findOrphans(f.home, 'not-a-uuid'), /Invalid daemon id/);
  assert.equal(alive(child.pid), true);
});

test('a start whose unconfirmed child survives SIGKILL reports the error and exits instead of hanging (#47)', async (t) => {
  const f = fixture(t), port = await injectedPort(), pidFile = join(f.dir, 'stuck-pid');
  const driver = join(f.dir, 'stuck-driver.mjs');
  // The child is real but its kill() is a no-op, simulating a process that
  // never exits after SIGTERM or SIGKILL. The driver never calls process.exit:
  // it can only terminate once nothing holds its event loop open.
  writeFileSync(driver, `import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [scriptUrl, home, commit, port, pidFile] = process.argv.slice(2);
const { start } = await import(scriptUrl);
const signals = [];
try {
  await start(home, {
    relayStatus: async () => ({ commit, relay: { online: false } }), checkPort: async () => {}, execute: () => '{"loggedIn":true}', port: Number(port),
    exitGrace: { term: 50, kill: 50 },
    spawnChild: (...args) => { const child = spawn(...args); child.kill = (signal) => { signals.push(signal); return true; }; return child; },
    saveRecord: (path, value) => {
      if (value.state === 'running') { writeFileSync(pidFile, JSON.stringify({ pid: value.pid, id: value.id })); throw new Error('injected promotion failure'); }
      writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    },
  });
} catch (error) { console.error('START FAILED: ' + error.message + ' signals=' + signals.join(',')); }
`);
  const starter = spawn(process.execPath, [driver, script, f.home, commit, String(port), pidFile], { stdio: ['ignore', 'ignore', 'pipe'], env: cleanEnv() });
  t.after(() => { if (starter.exitCode === null && starter.signalCode === null) starter.kill('SIGKILL'); });
  let stderr = ''; starter.stderr.on('data', (d) => { stderr += d; });
  let timer;
  const exited = await Promise.race([once(starter, 'exit').then(() => true), new Promise((resolve) => { timer = setTimeout(resolve, 8000, false); })]);
  clearTimeout(timer);
  // Register cleanup as soon as the PID is known, before reading daemon.json,
  // so a regression that deletes the record cannot leak the stuck child (#106).
  const { pid, id } = JSON.parse(readFileSync(pidFile, 'utf8'));
  reap(t, pid, ` ${f.entry} ${id}`);
  const record = JSON.parse(readFileSync(f.daemonFile, 'utf8'));
  assert.equal(record.id, id);
  // The mechanism ran: both signals were attempted and the child really outlived them.
  assert.match(stderr, new RegExp(`START FAILED: DEV daemon PID ${pid} did not exit after a failed start; .* signals=SIGTERM,SIGKILL`));
  assert.equal(alive(pid), true);
  assert.equal(exited, true, `start hung holding the child handle after reporting: ${stderr}`);
  assert.equal(starter.exitCode, 0, stderr);
  // The startup record is kept for dev:stop, which still finds and stops the daemon.
  assert.equal(record.state, 'starting');
  await until(() => existsSync(join(f.home, 'daemon-ready')), 'daemon readiness');
  const { output } = await captureLog(() => stop(f.home));
  assert.equal(output, 'DEV daemon stopped');
  await until(() => !alive(pid), 'daemon exit');
});

test('processIdentity asks ps for an untruncated command line (-ww), like findOrphans (#47)', () => {
  const calls = [];
  const identity = processIdentity(process.pid, (bin, args) => { calls.push([bin, args]); return 'S    Thu Sep 24 10:00:00 2026 /usr/bin/node run.mjs\n'; });
  assert.equal(identity, 'Thu Sep 24 10:00:00 2026 /usr/bin/node run.mjs');
  assert.deepEqual(calls, [['ps', ['-p', String(process.pid), '-ww', '-o', 'stat=,lstart=,command=']]]);
  // The real ps with -ww still yields this process's identity.
  assert.ok(processIdentity(process.pid).includes(process.execPath));
});

// #149: the tests above treat an existing marker as complete. Run the stand-in
// daemon with a preload that records every file write and rename it makes, and
// prove each marker only ever appears by a rename of a fully written file. A
// control run of the old in-place version must be caught by the same check.
async function markerWrites(t, source) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-dev-marker-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home'), log = join(dir, 'fs-log.json'), main = join(dir, 'main.mjs'), preload = join(dir, 'trace.mjs');
  mkdirSync(home);
  writeFileSync(main, source);
  writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const { writeFileSync, renameSync, readFileSync } = fs;
// Kept in memory and saved once at exit: fs's own helpers call fs.writeFileSync.
const entries = [], record = (entry) => entries.push(entry);
process.on('exit', () => writeFileSync(${JSON.stringify(log)}, JSON.stringify(entries)));
fs.writeFileSync = (path, ...rest) => { record({ op: 'write', path: String(path) }); return writeFileSync(path, ...rest); };
fs.renameSync = (from, to) => { record({ op: 'rename', from: String(from), to: String(to), content: readFileSync(from, 'utf8') }); return renameSync(from, to); };
syncBuiltinESMExports();
`);
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, main], { stdio: 'ignore', env: { ...cleanEnv(), FOREMAN_HOME: home } });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await until(() => existsSync(join(home, 'daemon-ready')), 'traced daemon readiness');
  child.kill('SIGTERM');
  await once(child, 'exit');
  assert.equal(child.exitCode, 0);
  const ops = JSON.parse(readFileSync(log, 'utf8'));
  return { pid: child.pid, home, ops };
}
function nonAtomicMarkers({ pid, home, ops }) {
  const problems = [];
  for (const name of ['daemon-ready', 'daemon-sigterm']) {
    const path = join(home, name);
    if (ops.some((op) => op.op === 'write' && op.path === path)) problems.push(`${name} written in place`);
    const renames = ops.filter((op) => op.op === 'rename' && op.to === path);
    if (renames.length !== 1 || renames[0].content !== String(pid)) problems.push(`${name} not renamed into place with its full content`);
  }
  return problems;
}

test('the stand-in daemon publishes its readiness and SIGTERM markers atomically (#149)', async (t) => {
  const traced = await markerWrites(t, fakeMain);
  // The mechanism ran: the tracer saw the daemon's writes and renames.
  assert.equal(traced.ops.filter((op) => op.op === 'write').length, 2, JSON.stringify(traced.ops));
  assert.deepEqual(nonAtomicMarkers(traced), []);
  assert.equal(readFileSync(join(traced.home, 'daemon-ready'), 'utf8'), String(traced.pid));
  assert.equal(readFileSync(join(traced.home, 'daemon-sigterm'), 'utf8'), String(traced.pid));

  // Control: the pre-#149 stand-in, which wrote each marker in place, is caught.
  const direct = fakeMain.replace(/publish\('([a-z-]+)', /g, "writeFileSync(join(home, '$1'), ");
  assert.notEqual(direct, fakeMain);
  assert.deepEqual(nonAtomicMarkers(await markerWrites(t, direct)), [
    'daemon-ready written in place', 'daemon-ready not renamed into place with its full content',
    'daemon-sigterm written in place', 'daemon-sigterm not renamed into place with its full content',
  ]);
});
