// The dev Codex login is optional for dev:start; the Claude login is still
// required (#69). Both apply to the default host logins and to the opt-in
// isolated logins (dev:start --isolated-logins). Every daemon here is a
// disposable stand-in for server/main.ts in a temporary dev home, served on an
// ephemeral port, and is stopped through the real dev:stop path.
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
writeFileSync(join(home, 'daemon-env.json'), JSON.stringify({ pid: process.pid, CODEX_HOME: process.env.CODEX_HOME ?? null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null }));
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
async function startWith(f, execute, isolatedLogins) {
  // The relay reports offline before spawn and online once the daemon is up.
  let spawned = false;
  const port = await freeTestPort();
  const options = {
    execute, port, checkPort: async () => {}, readyInterval: 50, readyAttempts: 200,
    relayStatus: async () => ({ commit, relay: { online: spawned } }),
    saveRecord: (path, value) => { writeJson(path, value); if (value.state === 'running') spawned = true; },
    ...(isolatedLogins ? { isolatedLogins: true } : {}),
  };
  return captureWarnings(() => start(f.home, options));
}
const noticePattern = /Codex sessions are unavailable in DEV/;
const modes = [['host logins', false], ['isolated logins', true]];
// The provider directory each mode checks and gives the daemon: none (the host default) or the dev home's own.
const dirs = (f, isolated) => ({ claude: isolated ? join(f.home, 'claude') : null, codex: isolated ? join(f.home, 'codex') : null });

for (const [mode, isolated] of modes) {
  test(`${mode}: with the Codex login, dev:start completes and prints no Codex notice`, async (t) => {
    const f = fixture(t), { execute, calls } = providers({ claude: 'signed-in', codex: 'signed-in' }), want = dirs(f, isolated);
    const { result, lines } = await startWith(f, execute, isolated);
    assert.equal(result?.rejected, undefined, String(result?.rejected?.stack));
    // The real start path ran to completion: the daemon is recorded, alive and healthy.
    const daemon = running(f.home); assert.ok(daemon, 'daemon is running');
    const env = JSON.parse(readFileSync(join(f.home, 'daemon-env.json'), 'utf8'));
    assert.equal(env.pid, daemon.pid);
    assert.equal(env.CODEX_HOME, want.codex); assert.equal(env.CLAUDE_CONFIG_DIR, want.claude);
    // Both logins were actually checked against the mode's directories, and were quiet.
    const claude = calls.filter((c) => !isCodex(c.bin, c.args));
    assert.equal(claude.length, 1); assert.deepEqual(claude[0].args, ['auth', 'status', '--json']); assert.equal(claude[0].env.CLAUDE_CONFIG_DIR ?? null, want.claude);
    const codex = calls.filter((c) => isCodex(c.bin, c.args));
    assert.equal(codex.length, 1); assert.deepEqual(codex[0].args, ['login', 'status']); assert.equal(codex[0].env.CODEX_HOME ?? null, want.codex);
    assert.deepEqual(lines.filter((l) => noticePattern.test(l)), []);
    assert.deepEqual(lines, []);
  });

  for (const codex of ['signed-out', 'missing-binary']) {
    test(`${mode}: without the Codex login (${codex}), dev:start still completes and prints exactly one notice line`, async (t) => {
      const f = fixture(t), { execute, calls } = providers({ claude: 'signed-in', codex });
      const { result, lines } = await startWith(f, execute, isolated);
      assert.equal(result?.rejected, undefined, String(result?.rejected?.stack));
      const daemon = running(f.home); assert.ok(daemon, 'daemon is running');
      assert.equal(JSON.parse(readFileSync(join(f.home, 'daemon-env.json'), 'utf8')).pid, daemon.pid);
      assert.equal(calls.filter((c) => isCodex(c.bin, c.args)).length, 1, 'Codex login status was consulted');
      // Exactly one line, naming the mode's login command and a restart in the same mode.
      assert.equal(lines.length, 1, lines.join('\n'));
      const [notice] = lines;
      assert.match(notice, noticePattern);
      if (isolated) {
        assert.ok(notice.includes(`CODEX_HOME="${join(f.home, 'codex')}" codex login`), notice);
        assert.ok(notice.includes('npm run dev:start -- --isolated-logins'), notice);
      } else {
        assert.doesNotMatch(notice, /CODEX_HOME|isolated/);
        assert.match(notice, / run codex login, /);
      }
      assert.match(notice, /restart dev/);
      // The two causes are distinguished: a missing CLI must be installed first.
      if (codex === 'missing-binary') { assert.match(notice, /the Codex CLI \(codex\) is not installed/); assert.match(notice, /install the Codex CLI, run /); assert.doesNotMatch(notice, /not signed in/); }
      else { assert.match(notice, /not signed in/); assert.doesNotMatch(notice, /install/); }
      assert.doesNotMatch(notice, /\n/);
      assert.ok(!notice.includes('secret-provider-output'), 'provider output is never echoed');
      // No credential was copied into the dev home: the isolated Codex home is
      // empty, and host logins create no provider directory there at all.
      if (isolated) assert.deepEqual(readdirSync(join(f.home, 'codex')), []);
      else { assert.equal(existsSync(join(f.home, 'codex')), false); assert.equal(existsSync(join(f.home, 'claude')), false); }
    });
  }

  test(`${mode}: the Claude login stays required, with or without Codex, and nothing is spawned`, async (t) => {
    for (const codex of ['signed-in', 'signed-out']) {
      const f = fixture(t), { execute } = providers({ claude: 'signed-out', codex });
      const { result, lines } = await startWith(f, execute, isolated);
      if (isolated) assert.match(result?.rejected?.message ?? '', /DEV Claude is not signed in\. Run CLAUDE_CONFIG_DIR=.* auth login, then run npm run dev:start -- --isolated-logins/);
      else {
        assert.match(result?.rejected?.message ?? '', /DEV Claude is not signed in: this Mac has no normal Claude CLI login\. Run claude auth login/);
        assert.doesNotMatch(result?.rejected?.message ?? '', /CLAUDE_CONFIG_DIR/);
      }
      assert.equal(existsSync(join(f.home, 'daemon.json')), false, 'no startup record');
      assert.equal(existsSync(join(f.home, 'daemon-env.json')), false, 'no daemon ran');
      assert.equal(running(f.home), null);
      assert.deepEqual(lines, [], 'the Claude refusal is not preceded by a Codex notice');
    }
  });
}

test('codexLoginNotice is null when signed in and otherwise a single redacted line that distinguishes a missing CLI', () => {
  assert.equal(codexLoginNotice('codex', '/dev/codex', {}, () => 'Logged in'), null);
  const notice = codexLoginNotice('codex', '/dev/codex', {}, () => { throw new Error('secret provider output'); });
  assert.equal(notice, 'Notice: DEV Codex is not signed in, so Codex sessions are unavailable in DEV. To enable them run CODEX_HOME="/dev/codex" codex login, then restart dev (npm run dev:stop && npm run dev:start -- --isolated-logins).');
  const missing = codexLoginNotice('codex', '/dev/codex', {}, () => { throw Object.assign(new Error('spawnSync codex ENOENT'), { code: 'ENOENT' }); });
  assert.equal(missing, 'Notice: the Codex CLI (codex) is not installed, so Codex sessions are unavailable in DEV. To enable them install the Codex CLI, run CODEX_HOME="/dev/codex" codex login, then restart dev (npm run dev:stop && npm run dev:start -- --isolated-logins).');
  assert.doesNotMatch(missing, /\n/);
});

test('codexLoginNotice for the host login checks the default CODEX_HOME and names the plain login command', () => {
  const seen = [];
  // An inherited CODEX_HOME is removed so the host default (~/.codex) is what gets checked.
  assert.equal(codexLoginNotice('codex', null, { CODEX_HOME: '/stray/codex', PATH: '/bin' }, (bin, args, options) => { seen.push(options.env); return 'Logged in'; }), null);
  assert.equal(seen.length, 1); assert.equal(Object.hasOwn(seen[0], 'CODEX_HOME'), false); assert.equal(seen[0].PATH, '/bin');
  const notice = codexLoginNotice('codex', null, {}, () => { throw new Error('secret provider output'); });
  assert.equal(notice, 'Notice: Codex is not signed in on this Mac, so Codex sessions are unavailable in DEV. To enable them run codex login, then restart dev (npm run dev:stop && npm run dev:start).');
  const missing = codexLoginNotice('codex', null, {}, () => { throw Object.assign(new Error('spawnSync codex ENOENT'), { code: 'ENOENT' }); });
  assert.equal(missing, 'Notice: the Codex CLI (codex) is not installed, so Codex sessions are unavailable in DEV. To enable them install the Codex CLI, run codex login, then restart dev (npm run dev:stop && npm run dev:start).');
});
