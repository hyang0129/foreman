// The isolated dev Codex login is optional for dev:start; the Claude login is
// still required (#69). Every daemon here is a disposable stand-in for
// server/main.ts in a temporary dev home, served on an ephemeral port, and is
// stopped through the real dev:stop path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { openHome, start, stop, running, dependencyIdentity, codexLoginNotice, TARGET } from '../scripts/dev-environment.mjs';

const commit = 'd'.repeat(40);
// Stand-in daemon: answers /api/health with its PID and records the provider
// homes it was given, so the test can prove start really completed.
const fakeMain = `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.FOREMAN_HOME;
writeFileSync(join(home, 'daemon-env.json'), JSON.stringify({ pid: process.pid, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }));
process.on('SIGTERM', () => process.exit(0));
createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ pid: process.pid })); })
  .listen(Number(process.env.FOREMAN_PORT), '127.0.0.1');
`;
const emptyIdentity = await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-dev-empty-'));
  try { return await dependencyIdentity(dir); } finally { rmSync(dir, { recursive: true }); }
})();
function writeJson(path, value) { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-dev-codex-optional-')));
  const home = openHome(dir), release = 'release-fixture';
  t.after(async () => {
    // Never leave a daemon behind: stop only through the identity-checked path.
    try { if (running(home)) await quiet(() => stop(home)); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  mkdirSync(join(home, release, 'server'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, release, 'server/main.ts'), fakeMain);
  const modules = join(dir, 'node_modules'); mkdirSync(modules); symlinkSync(modules, join(home, release, 'node_modules'));
  writeJson(join(home, 'deployment.json'), { release, commit, dependencies: { realpath: modules, identity: emptyIdentity } });
  writeJson(join(home, 'dev-pairing.json'), { environment: 'foreman-dev-v1', url: TARGET.url, token: 'a'.repeat(64) });
  return { dir, home };
}
async function freeTestPort() {
  const server = createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address(); await new Promise((r) => server.close(r));
  assert.notEqual(port, TARGET.port); return port;
}
async function quiet(fn) {
  const log = console.log; console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
}
// Captures everything start prints on stderr (console.warn / console.error).
async function captureWarnings(fn) {
  const lines = [], warn = console.warn, error = console.error;
  console.warn = (...args) => lines.push(args.join(' ')); console.error = console.warn;
  try { return { result: await quiet(fn).catch((e) => ({ rejected: e })), lines }; } finally { console.warn = warn; console.error = error; }
}
// Provider CLI stand-ins. `claude` is the SDK binary path; `codex` is the bare name.
const isCodex = (bin, args) => bin === 'codex' && args[0] === 'login';
function providers({ claude, codex }) {
  const calls = [];
  const execute = (bin, args, options) => {
    calls.push({ bin, args, env: options?.env });
    if (isCodex(bin, args)) {
      if (codex === 'signed-in') return 'Logged in using ChatGPT';
      if (codex === 'missing-binary') throw Object.assign(new Error('spawnSync codex ENOENT'), { code: 'ENOENT' });
      throw new Error('Not logged in secret-provider-output');
    }
    if (claude === 'signed-in') return '{"loggedIn":true}';
    return '{"loggedIn":false}';
  };
  return { execute, calls };
}
async function startWith(f, execute) {
  // The relay reports offline before spawn and online once the daemon is up.
  let spawned = false;
  const port = await freeTestPort();
  const options = {
    execute, port, checkPort: async () => {}, readyInterval: 50, readyAttempts: 200,
    relayStatus: async () => ({ commit, relay: { online: spawned } }),
    saveRecord: (path, value) => { writeJson(path, value); if (value.state === 'running') spawned = true; },
  };
  return captureWarnings(() => start(f.home, options));
}
const noticePattern = /Codex sessions are unavailable in DEV/;

test('with the dev Codex login, dev:start completes and prints no Codex notice', async (t) => {
  const f = fixture(t), { execute, calls } = providers({ claude: 'signed-in', codex: 'signed-in' });
  const { result, lines } = await startWith(f, execute);
  assert.equal(result?.rejected, undefined, String(result?.rejected?.stack));
  // The real start path ran to completion: the daemon is recorded, alive and healthy.
  const daemon = running(f.home); assert.ok(daemon, 'daemon is running');
  const env = JSON.parse(readFileSync(join(f.home, 'daemon-env.json'), 'utf8'));
  assert.equal(env.pid, daemon.pid);
  assert.equal(env.CODEX_HOME, join(f.home, 'codex')); assert.equal(env.CLAUDE_CONFIG_DIR, join(f.home, 'claude'));
  // Codex login was actually checked against the isolated home, and was quiet.
  const codex = calls.filter((c) => isCodex(c.bin, c.args));
  assert.equal(codex.length, 1); assert.deepEqual(codex[0].args, ['login', 'status']); assert.equal(codex[0].env.CODEX_HOME, join(f.home, 'codex'));
  assert.deepEqual(lines.filter((l) => noticePattern.test(l)), []);
  assert.deepEqual(lines, []);
});

for (const codex of ['signed-out', 'missing-binary']) {
  test(`without the dev Codex login (${codex}), dev:start still completes and prints exactly one notice line`, async (t) => {
    const f = fixture(t), { execute, calls } = providers({ claude: 'signed-in', codex });
    const { result, lines } = await startWith(f, execute);
    assert.equal(result?.rejected, undefined, String(result?.rejected?.stack));
    const daemon = running(f.home); assert.ok(daemon, 'daemon is running');
    assert.equal(JSON.parse(readFileSync(join(f.home, 'daemon-env.json'), 'utf8')).pid, daemon.pid);
    assert.equal(calls.filter((c) => isCodex(c.bin, c.args)).length, 1, 'Codex login status was consulted');
    // Exactly one line, naming the isolated CODEX_HOME login command and a restart.
    assert.equal(lines.length, 1, lines.join('\n'));
    const [notice] = lines;
    assert.match(notice, noticePattern);
    assert.ok(notice.includes(`CODEX_HOME="${join(f.home, 'codex')}" codex login`), notice);
    assert.match(notice, /restart dev/);
    assert.doesNotMatch(notice, /\n/);
    assert.ok(!notice.includes('secret-provider-output'), 'provider output is never echoed');
    // No production credential was copied into the isolated Codex home.
    assert.deepEqual(readdirSync(join(f.home, 'codex')), []);
  });
}

test('the dev Claude login stays required, with or without Codex, and nothing is spawned', async (t) => {
  for (const codex of ['signed-in', 'signed-out']) {
    const f = fixture(t), { execute } = providers({ claude: 'signed-out', codex });
    const { result, lines } = await startWith(f, execute);
    assert.match(result?.rejected?.message ?? '', /DEV Claude is not signed in\. Run CLAUDE_CONFIG_DIR=.* auth login/);
    assert.equal(existsSync(join(f.home, 'daemon.json')), false, 'no startup record');
    assert.equal(existsSync(join(f.home, 'daemon-env.json')), false, 'no daemon ran');
    assert.equal(running(f.home), null);
    assert.deepEqual(lines, [], 'the Claude refusal is not preceded by a Codex notice');
  }
});

test('codexLoginNotice is null when signed in and a single redacted line otherwise', () => {
  assert.equal(codexLoginNotice('codex', '/dev/codex', {}, () => 'Logged in'), null);
  const notice = codexLoginNotice('codex', '/dev/codex', {}, () => { throw new Error('secret provider output'); });
  assert.equal(notice, 'Notice: DEV Codex is not signed in, so Codex sessions are unavailable in DEV. To enable them run CODEX_HOME="/dev/codex" codex login, then restart dev (npm run dev:stop && npm run dev:start).');
});
