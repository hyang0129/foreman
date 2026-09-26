// Story #121: no test may write the developer's real ~/.foreman. server/paths.ts refuses the
// default (or an explicitly real) FOREMAN_HOME under node --test, and the hooks and scripts that
// compute a home on their own refuse it too.
//
// Every subprocess here runs with HOME at a fresh temp dir and every FOREMAN_* / CODEX_HOME /
// CLAUDE_CONFIG_DIR variable removed, so even a broken guard can only touch the temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertTestHome, isRealHome, underNodeTest } from '../server/home-guard.mjs';

const root = new URL('..', import.meta.url);
const file = (path) => new URL(path, root);
const PATHS_URL = file('server/paths.ts').href;

function sandbox(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-home-guard-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

// A child environment that cannot reach the real home: HOME is the sandbox and nothing names a
// Foreman, Codex or Claude home unless the case sets it.
function childEnv(home, extra = {}, { underTest = true } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('FOREMAN_') || ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS'].includes(key)) delete env[key];
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config') }, extra);
  // What node --test sets in every test-file process (and its children inherit).
  if (underTest) env.NODE_TEST_CONTEXT = 'child-v8';
  return env;
}

function importPaths(env) {
  const code = `const m = await import(${JSON.stringify(PATHS_URL)}); console.log(JSON.stringify({ home: m.FOREMAN_HOME }));`;
  return spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 30_000 });
}

const REFUSED = /Refusing to use the real home .* under node --test: set FOREMAN_HOME to a temp dir/;

test('this suite really runs under node --test, which the guard detects', () => {
  assert.equal(underNodeTest(), true);
  assert.equal(underNodeTest({ NODE_TEST_CONTEXT: 'child-v8' }, []), true, 'test-file child processes');
  assert.equal(underNodeTest({}, ['--test', '--test-isolation=none']), true, 'in-process (--test-isolation=none) test files');
  assert.equal(underNodeTest({}, ['--experimental-strip-types', '--test-isolation=process']), false, '--test-* options alone are not --test');
  assert.equal(underNodeTest({}, []), false);
});

test('importing server/paths.ts under node --test with no FOREMAN_HOME throws', (t) => {
  const home = sandbox(t);
  const result = importPaths(childEnv(home));
  assert.notEqual(result.status, 0, `import must fail; stdout: ${result.stdout}`);
  assert.match(result.stderr, REFUSED);
  assert.equal(existsSync(join(home, '.foreman')), false);
});

test('an explicit FOREMAN_HOME of <HOME>/.foreman is refused too', (t) => {
  const home = sandbox(t);
  const result = importPaths(childEnv(home, { FOREMAN_HOME: join(home, '.foreman') }));
  assert.notEqual(result.status, 0, `import must fail; stdout: ${result.stdout}`);
  assert.match(result.stderr, REFUSED);
});

test('a FOREMAN_HOME that reaches <HOME>/.foreman through a symlink or a subdirectory is refused', (t) => {
  const home = sandbox(t);
  mkdirSync(join(home, '.foreman'));
  symlinkSync(join(home, '.foreman'), join(home, 'alias'));
  for (const target of [join(home, 'alias'), join(home, '.foreman', 'nested'), `${home}/x/../.foreman`]) {
    const result = importPaths(childEnv(home, { FOREMAN_HOME: target }));
    assert.notEqual(result.status, 0, `${target} must be refused; stdout: ${result.stdout}`);
    assert.match(result.stderr, REFUSED);
  }
});

test("the account's real ~/.foreman and ~/.foreman-dev are refused even when HOME points elsewhere", (t) => {
  // Import only (paths.ts writes nothing at import), with HOME at the sandbox.
  const home = sandbox(t), account = userInfo().homedir;
  for (const target of [join(account, '.foreman'), join(account, '.foreman-dev')]) {
    const result = importPaths(childEnv(home, { FOREMAN_HOME: target }));
    assert.notEqual(result.status, 0, `${target} must be refused; stdout: ${result.stdout}`);
    assert.match(result.stderr, REFUSED);
    assert.equal(isRealHome(target), true);
  }
});

test('a temp FOREMAN_HOME loads', (t) => {
  const home = sandbox(t), state = join(home, 'state');
  const result = importPaths(childEnv(home, { FOREMAN_HOME: state }));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { home: state });
  // A disposable dev home under a temp HOME (how the dev-environment tests sandbox) is allowed.
  const dev = importPaths(childEnv(home, { FOREMAN_HOME: join(home, '.foreman-dev') }));
  assert.equal(dev.status, 0, dev.stderr);
});

test('outside node --test the default home is unchanged', (t) => {
  const home = sandbox(t);
  const result = importPaths(childEnv(home, {}, { underTest: false }));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { home: join(home, '.foreman') });
});

test('assertTestHome refuses a default or real home and accepts an explicit temp one', (t) => {
  const home = sandbox(t);
  assert.throws(() => assertTestHome(join(home, 'anything'), { explicit: false, variable: 'X_HOME' }), /set X_HOME to a temp dir/);
  assert.throws(() => assertTestHome(join(userInfo().homedir, '.foreman')), /Refusing to use the real home/);
  assert.doesNotThrow(() => assertTestHome(join(home, 'state')));
});

test('the Codex hook, run under node --test with no home set, records nothing', (t) => {
  const home = sandbox(t);
  const event = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'thr_guard', cwd: home });
  const result = spawnSync(process.execPath, [file('hooks/codex-hook.mjs').pathname], { input: event, env: childEnv(home), encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, 'a hook never fails its session');
  assert.match(result.stderr, /could not record this event/);
  assert.equal(existsSync(join(home, '.foreman')), false, 'nothing written to the default home');
});

test('the Claude hook, run under node --test with no FOREMAN_HOME, records nothing', (t) => {
  const home = sandbox(t);
  const event = JSON.stringify({ session_id: 'sid-guard', cwd: home, source: 'startup' });
  const result = spawnSync(file('hooks/foreman-hook').pathname, ['session-start'], { input: event, env: childEnv(home), encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0);
  assert.equal(existsSync(join(home, '.foreman')), false, 'nothing written to the default home');
});

test('#145: the Claude hook, run under node --test with FOREMAN_HOME set to a real home, records nothing', (t) => {
  const home = sandbox(t), real = join(home, '.foreman');
  mkdirSync(real);
  symlinkSync(real, join(home, 'alias'));
  mkdirSync(join(home, 'sub'));
  const hook = (env, cwd = home) => spawnSync(file('hooks/foreman-hook').pathname, ['session-start'], {
    input: JSON.stringify({ session_id: 'sid-guard', cwd: home, source: 'startup' }), env, cwd, encoding: 'utf8', timeout: 30_000 });
  // <HOME>/.foreman itself, inside it, through a symlink, through `..`, and relative to the cwd.
  for (const [target, cwd] of [[real, home], [join(real, 'nested', 'deeper'), home], [join(home, 'alias'), home], [`${home}/x/../.foreman`, home], ['../.foreman', join(home, 'sub')], ['.foreman/', home]]) {
    const result = hook(childEnv(home, { FOREMAN_HOME: target }), cwd);
    assert.equal(result.status, 0, 'a hook never fails its session');
    assert.deepEqual(readdirSync(real), [], `${target} (cwd ${cwd}): nothing written to the real home`);
  }
  // Control: an explicit temp home under node --test records, so the cases above prove the guard.
  const state = join(home, 'state');
  const ok = hook(childEnv(home, { FOREMAN_HOME: state }));
  assert.equal(ok.status, 0);
  assert.equal(existsSync(join(state, 'sessions', 'sid-guard.json')), true, 'the hook records into a temp home');
  // Outside node --test the guard does not apply: <HOME>/.foreman is the normal default.
  const prod = hook(childEnv(home, { FOREMAN_HOME: real }, { underTest: false }));
  assert.equal(prod.status, 0);
  assert.equal(existsSync(join(real, 'sessions', 'sid-guard.json')), true);
});

test('installing Codex hooks under node --test needs explicit, non-real homes', (t) => {
  const home = sandbox(t);
  const code = `const { install } = await import(${JSON.stringify(pathToFileURL(file('scripts/install-codex-hooks.mjs').pathname).href)});
    try { await install(); console.log('installed'); } catch (error) { console.error(error.message); process.exitCode = 3; }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: childEnv(home), encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 3, result.stdout);
  assert.match(result.stderr, /set CODEX_HOME to a temp dir/);
  assert.equal(existsSync(join(home, '.codex')), false, 'the default Codex home is untouched');
});
