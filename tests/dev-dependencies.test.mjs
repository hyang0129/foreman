// Installed dependency identity for dev previews (#29). Every test uses a
// temporary dev home and a temporary git source; relay, port, auth and the
// daemon record writer are injected, and no daemon is ever spawned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, symlinkSync, cpSync, chmodSync, unlinkSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { deploy, start, openHome, dependencyIdentity, verifyDependencies } from '../scripts/dev-environment.mjs';

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-dev-deps-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = openHome(dir), source = join(dir, 'source'), modules = join(source, 'node_modules');
  mkdirSync(source);
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.email', 'fixture@example.com'); git('config', 'user.name', 'Fixture');
  mkdirSync(join(source, 'web'));
  writeFileSync(join(source, '.gitignore'), 'node_modules\n');
  writeFileSync(join(source, 'package-lock.json'), '{}');
  writeFileSync(join(source, 'web/index.html'), '<title>Test</title><body></body>');
  writeFileSync(join(source, 'wrangler.jsonc'), '{ "vars": {"FIREBASE_CONFIG":"public-config"}, "durable_objects": {"bindings": [{"name": "RELAY", "class_name": "HostRelay"}]}, "migrations": [{"tag": "v1", "new_sqlite_classes": ["HostRelay"]}], "assets": {"directory": "./web", "binding": "ASSETS"} }');
  // A small installed tree: nested package files and an in-tree .bin symlink.
  mkdirSync(join(modules, 'pkg/lib'), { recursive: true }); mkdirSync(join(modules, '.bin'));
  writeFileSync(join(modules, 'pkg/package.json'), '{"name":"pkg","version":"1.0.0"}');
  writeFileSync(join(modules, 'pkg/lib/index.js'), 'module.exports = 1;\n');
  writeFileSync(join(modules, 'pkg/cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  symlinkSync('../pkg/cli.js', join(modules, '.bin/pkg'));
  git('add', '.'); git('commit', '-m', 'fixture');
  return { dir, home, source, modules, commit: git('rev-parse', 'HEAD') };
}
async function deployed(t) {
  const f = fixture(t);
  let uploads = 0;
  await deploy(f.home, { source: f.source, ref: f.commit }, async () => { uploads++; });
  assert.equal(uploads, 2);
  const deployment = JSON.parse(readFileSync(join(f.home, 'deployment.json'), 'utf8'));
  return { ...f, deployment, snapshot: join(f.home, deployment.release) };
}
// Every stage after dependency verification is injected and observed. The
// relay status is the first stage after it; saveRecord runs just before spawn.
function probe(f) {
  const calls = { relay: 0, save: 0 };
  const options = {
    relayStatus: async () => { calls.relay++; throw new Error('reached relay stage'); },
    checkPort: async () => { throw new Error('port check must not run'); },
    execute: () => { throw new Error('auth preflight must not run'); },
    saveRecord: () => { calls.save++; throw new Error('daemon record must not be written'); },
    port: 1,
  };
  const neverSpawned = () => {
    assert.equal(calls.relay, 0); assert.equal(calls.save, 0);
    assert.equal(existsSync(join(f.home, 'daemon.json')), false);
    assert.equal(existsSync(join(f.home, 'run.mjs')), false);
    assert.equal(existsSync(join(f.home, 'daemon.log')), false);
  };
  return { calls, options, neverSpawned };
}
const changed = /Installed dependencies changed since deploy .*reinstall matching dependencies and run npm run dev:deploy again/;

test('deploy records the resolved node_modules realpath and installed-tree identity', async (t) => {
  const f = await deployed(t);
  assert.equal(f.deployment.dependencies.realpath, realpathSync(f.modules));
  assert.match(f.deployment.dependencies.identity, /^sha256:[a-f0-9]{64}$/);
  assert.equal(f.deployment.dependencies.identity, await dependencyIdentity(realpathSync(f.modules)));
  assert.equal(realpathSync(join(f.snapshot, 'node_modules')), f.deployment.dependencies.realpath);
});

test('positive control: an unchanged installed tree passes verification and reaches the relay stage', async (t) => {
  const f = await deployed(t), p = probe(f);
  await assert.rejects(start(f.home, p.options), /reached relay stage/);
  assert.equal(p.calls.relay, 1); assert.equal(p.calls.save, 0);
  assert.equal(existsSync(join(f.home, 'daemon.json')), false);
});

const mutations = {
  'editing a file': (m) => writeFileSync(join(m, 'pkg/lib/index.js'), 'module.exports = 2;\n'),
  'adding a file': (m) => writeFileSync(join(m, 'pkg/lib/extra.js'), ''),
  'removing a file': (m) => rmSync(join(m, 'pkg/package.json')),
  'adding an empty directory': (m) => mkdirSync(join(m, 'pkg/empty')),
  'changing an executable bit': (m) => chmodSync(join(m, 'pkg/cli.js'), 0o644),
  'retargeting an in-tree symlink': (m) => { unlinkSync(join(m, '.bin/pkg')); symlinkSync('../pkg/lib/index.js', join(m, '.bin/pkg')); },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`start refuses before spawning after ${name} in source node_modules`, async (t) => {
    const f = await deployed(t), p = probe(f);
    mutate(f.modules);
    await assert.rejects(start(f.home, p.options), changed);
    p.neverSpawned();
  });
}

test('start refuses a snapshot link re-pointed at a different directory with identical contents', async (t) => {
  const f = await deployed(t), p = probe(f), copy = join(f.dir, 'copied_modules');
  cpSync(f.modules, copy, { recursive: true, verbatimSymlinks: true });
  // Same contents, so only the realpath check can refuse it.
  assert.equal(await dependencyIdentity(copy), f.deployment.dependencies.identity);
  unlinkSync(join(f.snapshot, 'node_modules')); symlinkSync(copy, join(f.snapshot, 'node_modules'));
  await assert.rejects(start(f.home, p.options), new RegExp(`node_modules resolves to ${copy}, not the deployed ${f.deployment.dependencies.realpath}; reinstall matching dependencies and run npm run dev:deploy again`));
  p.neverSpawned();
});

test('start refuses a snapshot whose node_modules link is missing', async (t) => {
  const f = await deployed(t), p = probe(f);
  unlinkSync(join(f.snapshot, 'node_modules'));
  await assert.rejects(start(f.home, p.options), /node_modules resolves to nothing, not the deployed/);
  p.neverSpawned();
});

test('start refuses a deployment record without dependencies and asks for a redeploy', async (t) => {
  const f = await deployed(t), p = probe(f);
  const { dependencies, ...legacy } = f.deployment;
  assert.ok(dependencies);
  writeFileSync(join(f.home, 'deployment.json'), JSON.stringify(legacy), { mode: 0o600 });
  await assert.rejects(start(f.home, p.options), /no installed-dependency record .*run npm run dev:deploy again/);
  p.neverSpawned();
});

test('identity is deterministic, reads symlink targets without following them, and never opens special files', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-dev-identity-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tree = join(dir, 'tree'), outside = join(dir, 'outside.txt');
  mkdirSync(join(tree, 'a'), { recursive: true });
  writeFileSync(join(tree, 'a/one'), '1'); writeFileSync(outside, 'before');
  symlinkSync(outside, join(tree, 'escape'));
  execFileSync('mkfifo', [join(tree, 'pipe')]);
  const first = await dependencyIdentity(tree);
  assert.equal(await dependencyIdentity(tree, { concurrency: 1 }), first);
  // Content outside the tree reached through a symlink is not part of the identity.
  writeFileSync(outside, 'after');
  assert.equal(await dependencyIdentity(tree), first);
  // Renaming an entry changes the identity even with identical content.
  execFileSync('mv', [join(tree, 'a/one'), join(tree, 'a/two')]);
  assert.notEqual(await dependencyIdentity(tree), first);
});

test('identity frames every variable-length field, so crafted symlink targets and paths cannot forge other entries', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-dev-framing-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tree = (name) => { const path = join(dir, name); mkdirSync(path); return path; };
  // A: one symlink whose target text embeds a fake directory entry.
  // B: symlink x -> t plus a real empty directory y.
  const a = tree('A'), b = tree('B');
  symlinkSync('t\n"y" d', join(a, 'x'));
  symlinkSync('t', join(b, 'x')); mkdirSync(join(b, 'y'));
  assert.notEqual(await dependencyIdentity(a), await dependencyIdentity(b));
  // Paths containing a newline or quote must not forge a second entry either.
  const c = tree('C'), d = tree('D');
  mkdirSync(join(c, 'p d\n"q"'));
  mkdirSync(join(d, 'p')); mkdirSync(join(d, 'q'));
  assert.notEqual(await dependencyIdentity(c), await dependencyIdentity(d));
  // A symlink target with a newline vs. a symlink plus a sibling whose path continues it.
  const e = tree('E'), g = tree('G');
  symlinkSync('t\n"z" l u', join(e, 'x'));
  symlinkSync('t', join(g, 'x')); symlinkSync('u', join(g, 'z'));
  assert.notEqual(await dependencyIdentity(e), await dependencyIdentity(g));
});

// Read errors during verification (#50): refuse before spawning with the
// recovery step, keeping the original code and path as detail and cause.
const unreadable = (code, path) => new RegExp(`Could not read installed dependencies at .*\\(${code} ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\); reinstall matching dependencies and run npm run dev:deploy again$`);

test('start refuses before spawning with an actionable message when an installed file is unreadable', { skip: process.getuid?.() === 0 && 'root ignores file permissions' }, async (t) => {
  const f = await deployed(t), p = probe(f), file = join(f.modules, 'pkg/lib/index.js');
  // Restored in finally: the fixture's cleanup hook runs first and needs access.
  chmodSync(file, 0o000);
  let error;
  try { error = await start(f.home, p.options).then(() => assert.fail('start resolved'), (e) => e); }
  finally { chmodSync(file, 0o644); }
  assert.match(error.message, unreadable('EACCES', file));
  assert.equal(error.code, 'EACCES'); assert.equal(error.path, file);
  assert.equal(error.cause?.code, 'EACCES');
  p.neverSpawned();
});

test('start refuses before spawning with an actionable message when an installed directory is unreadable', { skip: process.getuid?.() === 0 && 'root ignores file permissions' }, async (t) => {
  const f = await deployed(t), p = probe(f), directory = join(f.modules, 'pkg/lib');
  chmodSync(directory, 0o000);
  try { await assert.rejects(start(f.home, p.options), unreadable('EACCES', directory)); }
  finally { chmodSync(directory, 0o755); }
  p.neverSpawned();
});

test('start refuses before spawning with an actionable message when node_modules resolves to a regular file', async (t) => {
  const f = await deployed(t), p = probe(f);
  // Same realpath as deployed, so only the identity read can refuse it.
  rmSync(f.modules, { recursive: true }); writeFileSync(f.modules, 'not a directory');
  assert.equal(realpathSync(join(f.snapshot, 'node_modules')), f.deployment.dependencies.realpath);
  const error = await start(f.home, p.options).then(() => assert.fail('start resolved'), (e) => e);
  assert.match(error.message, unreadable('ENOTDIR', f.modules));
  assert.equal(error.cause?.code, 'ENOTDIR');
  p.neverSpawned();
});

test('start refuses before spawning with an actionable message when a file is removed mid-walk', async (t) => {
  const f = await deployed(t), p = probe(f), removed = join(f.modules, 'pkg/package.json');
  let opened = 0;
  // Sequential hashing; the first file opened removes a later one after the walk listed it.
  const identify = (dir) => dependencyIdentity(dir, { concurrency: 1, openFile: (path) => { if (opened++ === 0) rmSync(removed); return createReadStream(path); } });
  await assert.rejects(start(f.home, { ...p.options, identify }), unreadable('ENOENT', removed));
  assert.equal(existsSync(removed), false);
  p.neverSpawned();
});

test('verifyDependencies rethrows an error without code or path using its message', async (t) => {
  const f = await deployed(t);
  await assert.rejects(verifyDependencies(f.snapshot, f.deployment, async () => { throw new Error('boom'); }),
    /^Error: Could not read installed dependencies at .* \(boom\); reinstall matching dependencies and run npm run dev:deploy again$/);
});

test('a failed read aborts the other in-flight reads and reports the first error', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-dev-abort-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'a'), ''); writeFileSync(join(dir, 'b'), ''); writeFileSync(join(dir, 'c'), '');
  const opened = [];
  // `a` never ends on its own; `b` fails; `c` must never be opened.
  const endless = new Readable({ read() {} });
  const openFile = (path) => {
    opened.push(path.slice(dir.length + 1));
    if (path.endsWith('/a')) return endless;
    return Readable.from((async function* () { throw Object.assign(new Error('gone'), { code: 'ENOENT', path }); })());
  };
  const hung = new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('in-flight read was not aborted')), 2000); t.after(() => clearTimeout(timer)); });
  await assert.rejects(Promise.race([dependencyIdentity(dir, { concurrency: 2, openFile }), hung]), { code: 'ENOENT', path: join(dir, 'b') });
  assert.equal(endless.destroyed, true);
  assert.deepEqual(opened, ['a', 'b']);
});
