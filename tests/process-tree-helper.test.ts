// #104: the macOS process identity helper is compiled once per source hash into
// a private cache, and a timeout is never reported as missing Xcode tools.
// Every test uses its own temp cache dir; nothing touches ~/.foreman.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProcessHelper, ProcessHelperError, type HelperRunner } from '../server/process-tree.ts';

const root = mkdtempSync(join(tmpdir(), 'foreman-helper-test-'));
test.after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function setup() {
  const dir = join(root, String(n++));
  mkdirSync(dir, { recursive: true });
  const source = join(dir, 'helper.c');
  writeFileSync(source, 'int main(void) { return 0; }\n');
  return { dir, source, cacheDir: join(dir, 'cache') };
}

/** A shell-script "compiler": records each call, optionally sleeps, writes a script binary to -o. */
function fakeCompiler(dir: string, { sleep = 0, binary = '#!/bin/sh\nexit 0\n', fail = '' } = {}) {
  const path = join(dir, 'fake-cc');
  const calls = join(dir, 'compile-calls');
  const body = join(dir, 'binary-body');
  writeFileSync(body, binary);
  writeFileSync(path, `#!/bin/sh
echo "$$" >> '${calls}'
${sleep ? `sleep ${sleep}` : ''}
${fail ? `echo '${fail}' >&2; exit 1` : ''}
while [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done
cat '${body}' > "$out"
`);
  chmodSync(path, 0o755);
  return { path, count: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0 };
}
const errno = (code: string) => Object.assign(new Error(`spawnSync x ${code}`), { code });
const exited = (status: number, stderr = '') => Object.assign(new Error('Command failed'), { status, stderr: Buffer.from(stderr) });
/** Injected runner: the compiler step and the check step fail as told. */
function runner(compileError?: Error, checkError?: Error): HelperRunner {
  return (file, args) => {
    if (args.includes('-o')) {
      if (compileError) throw compileError;
      const out = args[args.indexOf('-o') + 1];
      writeFileSync(out, '#!/bin/sh\nexit 0\n'); chmodSync(out, 0o755);
    } else if (checkError) throw checkError;
  };
}
function failure(fn: () => unknown): ProcessHelperError {
  try { fn(); } catch (error) { assert.ok(error instanceof ProcessHelperError, String(error)); return error; }
  assert.fail('expected a ProcessHelperError');
}
const XCODE = /Xcode Command Line Tools/;

test('a compile timeout reports a timeout with the step and budget, not missing Xcode tools', () => {
  const s = setup();
  const error = failure(() => buildProcessHelper({ cacheDir: s.cacheDir, source: s.source, compiler: '/usr/bin/cc', compileTimeoutMs: 45_000, run: runner(errno('ETIMEDOUT')) }));
  assert.equal(error.kind, 'timeout'); assert.equal(error.step, 'compile');
  assert.match(error.message, /Compiling .* timed out after 45s/);
  assert.doesNotMatch(error.message, XCODE);
});

test('a check timeout reports a timeout with the step and budget, not missing Xcode tools', () => {
  const s = setup();
  const error = failure(() => buildProcessHelper({ cacheDir: s.cacheDir, source: s.source, checkTimeoutMs: 7_500, run: runner(undefined, errno('ETIMEDOUT')) }));
  assert.equal(error.kind, 'timeout'); assert.equal(error.step, 'check');
  assert.match(error.message, /check timed out after 7\.5s/);
  assert.doesNotMatch(error.message, XCODE);
});

test('only a missing toolchain reports Xcode Command Line Tools, with the toolchain message', () => {
  const s = setup();
  const missing = failure(() => buildProcessHelper({ cacheDir: s.cacheDir, source: s.source, compiler: '/nope/cc', run: runner(errno('ENOENT')) }));
  assert.equal(missing.kind, 'toolchain'); assert.match(missing.message, XCODE); assert.match(missing.message, /\/nope\/cc/);
  const shim = failure(() => buildProcessHelper({ cacheDir: s.cacheDir, source: s.source,
    run: runner(exited(1, 'xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun')) }));
  assert.equal(shim.kind, 'toolchain'); assert.match(shim.message, XCODE); assert.match(shim.message, /invalid active developer path/);
});

test('a failed compile and a failed check report their own causes', () => {
  const s = setup();
  const compile = failure(() => buildProcessHelper({ cacheDir: s.cacheDir, source: s.source, run: runner(exited(1, "helper.c:3:5: error: use of undeclared identifier 'x'")) }));
  assert.equal(compile.kind, 'compile'); assert.match(compile.message, /undeclared identifier/); assert.doesNotMatch(compile.message, XCODE);
  const check = failure(() => buildProcessHelper({ cacheDir: s.cacheDir, source: s.source, run: runner(undefined, exited(1)) }));
  assert.equal(check.kind, 'check'); assert.match(check.message, /process identity API check failed: exit 1/); assert.doesNotMatch(check.message, XCODE);
});

test('real subprocess timeouts are classified as timeouts (compile and check)', { timeout: 20_000 }, () => {
  const s = setup();
  const slowCc = fakeCompiler(s.dir, { sleep: 5 });
  const compile = failure(() => buildProcessHelper({ cacheDir: s.cacheDir, source: s.source, compiler: slowCc.path, compileTimeoutMs: 300 }));
  assert.equal(compile.kind, 'timeout'); assert.equal(compile.step, 'compile'); assert.match(compile.message, /0\.3s/);
  assert.deepEqual(readdirSync(s.cacheDir), [], 'no partial binary, temp file, or lock is left');

  const t = setup();
  const slowBinary = fakeCompiler(t.dir, { binary: '#!/bin/sh\nsleep 5\n' });
  const check = failure(() => buildProcessHelper({ cacheDir: t.cacheDir, source: t.source, compiler: slowBinary.path, checkTimeoutMs: 300 }));
  assert.equal(check.kind, 'timeout'); assert.equal(check.step, 'check'); assert.match(check.message, /0\.3s/);

  const u = setup();
  const noClt = fakeCompiler(u.dir, { fail: 'xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)' });
  const tools = failure(() => buildProcessHelper({ cacheDir: u.cacheDir, source: u.source, compiler: noClt.path }));
  assert.equal(tools.kind, 'toolchain'); assert.match(tools.message, XCODE);
  const gone = failure(() => buildProcessHelper({ cacheDir: u.cacheDir, source: u.source, compiler: join(u.dir, 'missing-cc') }));
  assert.equal(gone.kind, 'toolchain'); assert.match(gone.message, XCODE);
});

test('the helper is compiled once per source hash into a private cache and reused', () => {
  const s = setup();
  const cc = fakeCompiler(s.dir);
  const first = buildProcessHelper({ cacheDir: s.cacheDir, source: s.source, compiler: cc.path });
  const second = buildProcessHelper({ cacheDir: s.cacheDir, source: s.source, compiler: cc.path });
  assert.equal(second, first);
  assert.equal(cc.count(), 1, 'second call reuses the cached binary');
  assert.equal(statSync(s.cacheDir).mode & 0o777, 0o700);
  assert.equal(statSync(first).mode & 0o022, 0, 'cached binary is not group/world writable');

  writeFileSync(s.source, 'int main(void) { return 1 - 1; }\n');
  const changed = buildProcessHelper({ cacheDir: s.cacheDir, source: s.source, compiler: cc.path });
  assert.notEqual(changed, first); assert.equal(cc.count(), 2, 'a new source hash compiles again');
});

test('a damaged cached binary is rebuilt instead of reported', () => {
  const s = setup();
  const cc = fakeCompiler(s.dir);
  const first = buildProcessHelper({ cacheDir: s.cacheDir, source: s.source, compiler: cc.path });
  writeFileSync(first, '#!/bin/sh\nexit 3\n');
  assert.equal(buildProcessHelper({ cacheDir: s.cacheDir, source: s.source, compiler: cc.path }), first);
  assert.equal(cc.count(), 2);
  assert.equal(readFileSync(first, 'utf8'), '#!/bin/sh\nexit 0\n');
});

test('an existing cache dir with loose permissions is tightened to 0700', () => {
  const s = setup();
  mkdirSync(s.cacheDir, { recursive: true }); chmodSync(s.cacheDir, 0o777);
  buildProcessHelper({ cacheDir: s.cacheDir, source: s.source, run: runner() });
  assert.equal(statSync(s.cacheDir).mode & 0o777, 0o700);
});

test('many processes starting at once compile the helper exactly once', { timeout: 60_000 }, async () => {
  const s = setup();
  const cc = fakeCompiler(s.dir, { sleep: 0.5 });
  const module = new URL('../server/process-tree.ts', import.meta.url).href;
  const script = `import { buildProcessHelper } from ${JSON.stringify(module)};
    process.stdout.write(buildProcessHelper({ cacheDir: ${JSON.stringify(s.cacheDir)}, source: ${JSON.stringify(s.source)}, compiler: ${JSON.stringify(cc.path)} }));`;
  const runs = Array.from({ length: 12 }, async () => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    const [code] = await once(child, 'exit');
    return { code, out, err };
  });
  const results = await Promise.all(runs);
  for (const r of results) assert.equal(r.code, 0, r.err);
  assert.equal(new Set(results.map((r) => r.out)).size, 1, 'every process uses the same cached binary');
  assert.equal(cc.count(), 1, 'the compiler ran once for 12 concurrent first uses');
  assert.deepEqual(readdirSync(s.cacheDir).filter((f) => f.startsWith('.') || f.endsWith('.lock')), [], 'no temp files or locks left behind');
});

test('a lock left by a dead compiler is broken at once and every waiter gets the helper', { timeout: 60_000 }, async () => {
  const s = setup();
  const cc = fakeCompiler(s.dir, { sleep: 1 });
  // Learn the cache key's file name from a throwaway cache, then plant a lock whose holder is dead.
  const name = buildProcessHelper({ cacheDir: join(s.dir, 'probe'), source: s.source, compiler: cc.path }).split('/').pop()!;
  const dead = spawn(process.execPath, ['-e', '']); await once(dead, 'exit');
  mkdirSync(s.cacheDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(s.cacheDir, `${name}.lock`), String(dead.pid));
  const module = new URL('../server/process-tree.ts', import.meta.url).href;
  const script = `import { buildProcessHelper } from ${JSON.stringify(module)};
    process.stdout.write(buildProcessHelper({ cacheDir: ${JSON.stringify(s.cacheDir)}, source: ${JSON.stringify(s.source)}, compiler: ${JSON.stringify(cc.path)}, compileTimeoutMs: 20_000 }));`;
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 6 }, async () => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    const [code] = await once(child, 'exit');
    return { code, out, err };
  }));
  for (const r of results) assert.equal(r.code, 0, r.err);
  assert.equal(new Set(results.map((r) => r.out)).size, 1);
  assert.ok(Date.now() - started < 20_000, 'did not wait out the stale-lock age');
  assert.deepEqual(readdirSync(s.cacheDir).filter((f) => f.endsWith('.lock')), []);
});

test('a non-directory squatting the cache path falls back to a private build', () => {
  const s = setup();
  writeFileSync(s.cacheDir, 'not a directory');
  const helper = buildProcessHelper({ cacheDir: s.cacheDir, source: s.source, run: runner() });
  assert.ok(!helper.startsWith(s.cacheDir), helper);
  assert.equal(readFileSync(s.cacheDir, 'utf8'), 'not a directory');
});

test('macOS: the real helper compiles with cc once and the cached binary is reused', { skip: process.platform !== 'darwin', timeout: 120_000 }, () => {
  const s = setup();
  const source = new URL('../server/process-table-darwin.c', import.meta.url).pathname;
  const first = buildProcessHelper({ cacheDir: s.cacheDir, source });
  const before = statSync(first);
  const second = buildProcessHelper({ cacheDir: s.cacheDir, source });
  assert.equal(second, first);
  assert.equal(statSync(second).ino, before.ino, 'not recompiled');
  assert.equal(statSync(second).mtimeMs, before.mtimeMs);
});
