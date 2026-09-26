// Web Push VAPID key provisioning (AND-03) for production (scripts/deploy-cloud.mjs) and dev
// (scripts/dev-environment.mjs). Nothing here reaches Cloudflare: the production script runs
// from a temporary copy whose node_modules/wrangler is a recording fake, and dev deploys use an
// injected deployer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, statSync, chmodSync, realpathSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { deploy, openHome, devVapidKey } from '../scripts/dev-environment.mjs';

async function assertUsableKey(jwk) {
  assert.deepEqual(Object.keys(jwk).sort(), ['crv', 'd', 'kty', 'x', 'y']);
  assert.equal(jwk.kty, 'EC'); assert.equal(jwk.crv, 'P-256');
  const key = await webcrypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const { d, ...publicJwk } = jwk;
  const verifier = await webcrypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const data = new TextEncoder().encode('vapid');
  const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, signature, data), true);
}
const mode = (path) => statSync(path).mode & 0o777;

// ---- production: scripts/deploy-cloud.mjs ------------------------------------------------------
const fakeWrangler = `import { readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const file = args[args.indexOf('--secrets-file') + 1];
appendFileSync(process.env.FAKE_WRANGLER_LOG, JSON.stringify({ args, secrets: JSON.parse(readFileSync(file, 'utf8')) }) + '\\n');
console.log('Deployed foreman to https://foreman-test.example.workers.dev');
`;
function productionFixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-vapid-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo'), state = join(dir, 'state'), log = join(dir, 'wrangler.log');
  mkdirSync(join(root, 'scripts'), { recursive: true }); mkdirSync(join(root, 'server'), { recursive: true }); mkdirSync(join(root, 'node_modules/wrangler/bin'), { recursive: true });
  copyFileSync('scripts/deploy-cloud.mjs', join(root, 'scripts/deploy-cloud.mjs'));
  copyFileSync('server/home-guard.mjs', join(root, 'server/home-guard.mjs'));
  writeFileSync(join(root, 'node_modules/wrangler/bin/wrangler.js'), fakeWrangler);
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const run = (extra = {}) => {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) if (!/^(FOREMAN_|CLOUDFLARE_|CF_|WRANGLER_|NODE_OPTIONS$|NODE_TEST_CONTEXT$)/.test(key)) env[key] = value;
    const result = spawnSync(process.execPath, [join(root, 'scripts/deploy-cloud.mjs')], { env: { ...env, FOREMAN_HOME: state, FAKE_WRANGLER_LOG: log, ...extra }, encoding: 'utf8' });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
    return { ...result, calls };
  };
  return { dir, state, run };
}

test('deploy-cloud generates a 0600 VAPID key once, reuses it, and passes it only through the secrets file', async (t) => {
  const f = productionFixture(t);
  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  const vapidPath = join(f.state, 'vapid.json');
  assert.equal(mode(vapidPath), 0o600);
  const vapid = JSON.parse(readFileSync(vapidPath, 'utf8'));
  await assertUsableKey(vapid);
  const cloud = JSON.parse(readFileSync(join(f.state, 'cloud.json'), 'utf8'));
  // cloud.json format unchanged: exactly the pairing.
  assert.deepEqual(Object.keys(cloud).sort(), ['token', 'url']);
  assert.equal(first.calls.length, 1);
  assert.deepEqual(first.calls[0].secrets, { HOST_TOKEN: cloud.token, VAPID_PRIVATE_KEY: JSON.stringify(vapid) });
  // The private key is never in argv or in the script's output.
  for (const text of [JSON.stringify(first.calls[0].args), first.stdout, first.stderr]) {
    assert.ok(!text.includes(vapid.d)); assert.ok(!text.includes(cloud.token));
  }
  assert.deepEqual(first.calls[0].args.slice(0, 2), ['deploy', '--secrets-file']);

  const second = f.run();
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(readFileSync(vapidPath, 'utf8')), vapid);
  assert.deepEqual(second.calls[1].secrets, { HOST_TOKEN: cloud.token, VAPID_PRIVATE_KEY: JSON.stringify(vapid) });
});

test('deploy-cloud refuses an unsafe or invalid vapid.json before deploying', (t) => {
  const f = productionFixture(t);
  mkdirSync(f.state, { recursive: true, mode: 0o700 });
  const vapidPath = join(f.state, 'vapid.json');
  writeFileSync(vapidPath, JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'a'.repeat(43), y: 'b'.repeat(43), d: 'c'.repeat(43) }), { mode: 0o644 });
  chmodSync(vapidPath, 0o644);
  let result = f.run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /vapid\.json must be an owned regular file with mode 0600/);
  writeFileSync(vapidPath, '{"kty":"RSA"}'); chmodSync(vapidPath, 0o600);
  result = f.run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Invalid vapid\.json/);
  assert.equal(result.calls.length, 0);
  assert.equal(existsSync(join(f.state, 'cloud.json')), false);
});

test('#145: under node --test, deploy-cloud refuses the default home and an explicit real one', (t) => {
  const f = productionFixture(t);
  // HOME is the fixture dir, so <dir>/.foreman is "the real home" for this child.
  const real = join(f.dir, '.foreman');
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, join(f.dir, 'alias'));
  const underTest = { HOME: f.dir, NODE_TEST_CONTEXT: 'child-v8' };
  for (const target of ['', real, join(real, 'nested'), join(f.dir, 'alias'), `${f.dir}/x/../.foreman`]) {
    const result = f.run({ ...underTest, FOREMAN_HOME: target });
    assert.notEqual(result.status, 0, `${JSON.stringify(target)} must be refused`);
    assert.match(result.stderr, /Refusing to use the real home .* under node --test: set FOREMAN_HOME to a temp dir/);
    assert.equal(result.calls.length, 0, 'nothing deployed');
  }
  assert.deepEqual(readdirSync(real), [], 'nothing written to the real home');
  // A temp FOREMAN_HOME under node --test still deploys (the fake Wrangler records it).
  const ok = f.run(underTest);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.calls.length, 1);
});

// ---- dev: scripts/dev-environment.mjs ----------------------------------------------------------
function devFixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-dev-vapid-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = openHome(dir), source = join(dir, 'source'); mkdirSync(source);
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.email', 'fixture@example.com'); git('config', 'user.name', 'Fixture');
  mkdirSync(join(source, 'web')); mkdirSync(join(source, 'node_modules'));
  writeFileSync(join(source, '.gitignore'), 'node_modules\n');
  writeFileSync(join(source, 'package-lock.json'), '{}'); writeFileSync(join(source, 'web/index.html'), '<title>Test</title><body></body>');
  writeFileSync(join(source, 'node_modules/installed.js'), 'installed');
  writeFileSync(join(source, 'wrangler.jsonc'), '{ "vars": {"FIREBASE_CONFIG":"public-config"}, "durable_objects": {"bindings": [{"name": "RELAY", "class_name": "HostRelay"}]}, "migrations": [{"tag": "v1", "new_sqlite_classes": ["HostRelay"]}], "assets": {"directory": "./web", "binding": "ASSETS"} }');
  git('add', '.'); git('commit', '-m', 'fixture');
  return { home, source, commit: git('rev-parse', 'HEAD') };
}

test('dev deploy uploads its own VAPID key through the secrets file and reuses it', async (t) => {
  const f = devFixture(t), calls = [];
  const deployer = async (_home, config, args) => {
    calls.push({ args, secrets: JSON.parse(readFileSync(args[args.indexOf('--secrets-file') + 1], 'utf8')), config: JSON.parse(readFileSync(config, 'utf8')) });
  };
  const quiet = console.log; console.log = () => {};
  try {
    await deploy(f.home, { source: f.source, ref: f.commit }, deployer);
    await deploy(f.home, { source: f.source, ref: f.commit }, deployer);
  } finally { console.log = quiet; }
  const vapidPath = join(f.home, 'vapid.json');
  assert.equal(mode(vapidPath), 0o600);
  const vapid = JSON.parse(readFileSync(vapidPath, 'utf8'));
  await assertUsableKey(vapid);
  const pair = JSON.parse(readFileSync(join(f.home, 'dev-pairing.json'), 'utf8'));
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.deepEqual(call.secrets, { HOST_TOKEN: pair.token, VAPID_PRIVATE_KEY: JSON.stringify(vapid) });
    assert.ok(!JSON.stringify(call.args).includes(vapid.d));
    // Push is optional in the Worker: the secret is not made required, and nothing else changes.
    assert.deepEqual(call.config.secrets, { required: ['HOST_TOKEN'] });
    assert.ok(!JSON.stringify(call.config).includes(vapid.d));
  }
  assert.equal(await devVapidKey(f.home).then((key) => key.d), vapid.d);
});

test('dev refuses an unsafe or invalid vapid.json', async (t) => {
  const f = devFixture(t), path = join(f.home, 'vapid.json');
  writeFileSync(path, JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'a'.repeat(43), y: 'b'.repeat(43), d: 'c'.repeat(43) }), { mode: 0o644 });
  chmodSync(path, 0o644);
  await assert.rejects(devVapidKey(f.home), /Refusing unsafe dev path/);
  chmodSync(path, 0o600); writeFileSync(path, '{"kty":"EC","crv":"P-384"}');
  await assert.rejects(devVapidKey(f.home), /Refusing invalid dev vapid\.json/);
});
