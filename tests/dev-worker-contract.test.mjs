// Snapshot binding/migration contract for dev previews (#31). Every deploy
// test uses a temporary dev home and a temporary git source with an injected
// deployer; nothing reaches Cloudflare.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { experimental_readRawConfig } from 'wrangler';
import { deploy, openHome, workerConfig, contractDivergences, SUPPORTED_WORKER_CONTRACT, SUPPORTED_DEV_VARS, SUPPORTED_DEV_SECRETS, UNSUPPORTED_BINDING_KEYS, TARGET } from '../scripts/dev-environment.mjs';
// Resolve repository files against this test, not the working directory (#53).
const repo = fileURLToPath(new URL('..', import.meta.url));

const conforming = () => ({ vars: { FIREBASE_CONFIG: 'public' }, assets: { directory: './web', binding: 'ASSETS' }, ...structuredClone({ durable_objects: SUPPORTED_WORKER_CONTRACT.durable_objects, migrations: SUPPORTED_WORKER_CONTRACT.migrations }) });
const relay = { name: 'RELAY', class_name: 'HostRelay' }, v1 = { tag: 'v1', new_sqlite_classes: ['HostRelay'] };

test('supported contract is the real RELAY/HostRelay/v1 contract and is immutable', () => {
  assert.deepEqual(SUPPORTED_WORKER_CONTRACT, { durable_objects: { bindings: [relay] }, migrations: [v1], assets: { binding: 'ASSETS' } });
  assert.throws(() => { SUPPORTED_WORKER_CONTRACT.migrations.push({ tag: 'v2' }); }, TypeError);
  assert.throws(() => { SUPPORTED_WORKER_CONTRACT.durable_objects.bindings[0].class_name = 'Other'; }, TypeError);
});

test('a conforming snapshot yields exactly the contract bindings and migrations', () => {
  assert.deepEqual(contractDivergences(conforming()), []);
  const config = workerConfig(conforming());
  assert.deepEqual(config.durable_objects, SUPPORTED_WORKER_CONTRACT.durable_objects);
  assert.deepEqual(config.migrations, SUPPORTED_WORKER_CONTRACT.migrations);
  assert.equal(config.assets.binding, 'ASSETS');
  // The emitted config is a copy: mutating it cannot change the contract.
  config.migrations.push({ tag: 'v2' }); assert.equal(SUPPORTED_WORKER_CONTRACT.migrations.length, 1);
});

test('non-binding fields remain ignored by construction, not refused', () => {
  const base = { ...conforming(), name: 'foreman', account_id: 'production', main: 'other.ts', routes: ['production/*'], route: 'x/*', triggers: { crons: ['* * * * *'] },
    build: { command: 'production-deploy' }, env: { production: { name: 'foreman', kv_namespaces: [{ binding: 'KV', id: 'x' }] } }, secrets: { required: ['HOST_TOKEN'] },
    compatibility_flags: ['nodejs_compat'], vars: { FIREBASE_CONFIG: 'public' } };
  assert.deepEqual(contractDivergences(base), []);
  const config = workerConfig(base);
  assert.equal(config.name, TARGET.worker); assert.equal(config.account_id, TARGET.account); assert.equal(config.main, './dev-worker.ts');
  for (const key of ['routes', 'route', 'triggers', 'build', 'env', 'compatibility_flags']) assert.equal(config[key], undefined);
  assert.equal(config.vars.ALLOWED_EMAIL, 'hooong.yang@gmail.com'); assert.deepEqual(config.secrets, { required: ['HOST_TOKEN'] });
});

const divergences = {
  'extra Durable Object binding': [b => { b.durable_objects.bindings.push({ name: 'CACHE', class_name: 'Cache' }); }, /extra or renamed Durable Object binding \{"name":"CACHE","class_name":"Cache"\}/],
  'renamed binding': [b => { b.durable_objects.bindings[0].name = 'HOST_RELAY'; }, /extra or renamed Durable Object binding \{"name":"HOST_RELAY".*Durable Object binding RELAY -> HostRelay is missing/],
  'missing binding': [b => { b.durable_objects.bindings = []; }, /Durable Object binding RELAY -> HostRelay is missing/],
  'missing durable_objects': [b => { delete b.durable_objects; }, /durable_objects\.bindings is nothing, not a list/],
  'duplicated binding': [b => { b.durable_objects.bindings.push({ ...relay }); }, /Durable Object binding RELAY -> HostRelay is duplicated/],
  'class mismatch': [b => { b.durable_objects.bindings[0].class_name = 'HostRelayV2'; }, /Durable Object binding RELAY uses class "HostRelayV2", not "HostRelay"/],
  'external script_name binding': [b => { b.durable_objects.bindings[0].script_name = 'foreman'; }, /external Durable Object binding .*"script_name":"foreman".*script_name is not supported/],
  'extra binding fields': [b => { b.durable_objects.bindings[0].environment = 'production'; }, /Durable Object binding RELAY declares unsupported fields .*"environment":"production"/],
  'extra durable_objects keys': [b => { b.durable_objects.other = true; }, /unsupported durable_objects keys \["other"\]/],
  'extra v2 migration': [b => { b.migrations.push({ tag: 'v2', new_sqlite_classes: ['Cache'] }); }, /extra or different migration \{"tag":"v2","new_sqlite_classes":\["Cache"\]\}/],
  'different migration tag': [b => { b.migrations[0].tag = 'v0'; }, /extra or different migration \{"tag":"v0".*migration v1 .* is missing/],
  'different migration kind': [b => { b.migrations[0] = { tag: 'v1', new_classes: ['HostRelay'] }; }, /migration v1 is \{"tag":"v1","new_classes":\["HostRelay"\]\}, not \{"tag":"v1","new_sqlite_classes":\["HostRelay"\]\}/],
  'additional migration step in v1': [b => { b.migrations[0].renamed_classes = [{ from: 'HostRelay', to: 'Relay' }]; }, /migration v1 is .*renamed_classes/],
  'different migrated class': [b => { b.migrations[0].new_sqlite_classes = ['Relay']; }, /migration v1 is .*"Relay"/],
  'missing migrations': [b => { delete b.migrations; }, /migrations is nothing, not a list/],
  'empty migrations': [b => { b.migrations = []; }, /migration v1 .* is missing/],
  'duplicated migration': [b => { b.migrations.push({ ...v1 }); }, /migration v1 .* is duplicated/],
  'renamed assets binding': [b => { b.assets.binding = 'STATIC'; }, /assets binding is "STATIC", not "ASSETS"/],
  'missing assets binding': [b => { delete b.assets; }, /assets binding is nothing, not "ASSETS"/],
  'extra var': [b => { b.vars.FEATURE_FLAG = 'on'; }, /unsupported vars \["FEATURE_FLAG"\] \(the dev Worker would not define them\)/],
  'retargeted pinned var': [b => { b.vars.ALLOWED_EMAIL = 'attacker'; }, /var ALLOWED_EMAIL is "attacker", not "hooong\.yang@gmail\.com"/],
  'missing FIREBASE_CONFIG': [b => { delete b.vars.FIREBASE_CONFIG; }, /var FIREBASE_CONFIG is nothing, not a string/],
  'missing vars': [b => { delete b.vars; }, /vars is nothing, not an object/],
  'extra required secret': [b => { b.secrets = { required: ['HOST_TOKEN', 'STRIPE_KEY'] }; }, /unsupported required secrets \["STRIPE_KEY"\] \(the dev Worker would not be given them\)/],
  'required secrets not a list': [b => { b.secrets = { required: 'HOST_TOKEN' }; }, /secrets\.required is "HOST_TOKEN", not a list/],
  'extra secrets keys': [b => { b.secrets = { required: ['HOST_TOKEN'], optional: ['X'] }; }, /unsupported secrets keys \["optional"\]/],
};
for (const [name, [mutate, message]] of Object.entries(divergences)) test(`refuses a snapshot with a divergent contract: ${name}`, () => {
  const base = conforming(); mutate(base);
  assert.throws(() => workerConfig(base), error => {
    assert.match(error.message, /^Refusing preview: the snapshot's wrangler\.jsonc diverges/);
    assert.match(error.message, message);
    assert.match(error.message, /Dev supports exactly durable_objects\.bindings \[\{"name":"RELAY","class_name":"HostRelay"\}\], migrations \[\{"tag":"v1","new_sqlite_classes":\["HostRelay"\]\}\]/);
    assert.match(error.message, /vars \["FIREBASE_PROJECT_ID","ALLOWED_EMAIL","FIREBASE_CONFIG"\] with FIREBASE_PROJECT_ID "foreman-hong-2026" and ALLOWED_EMAIL "hooong\.yang@gmail\.com" fixed; and required secrets \["HOST_TOKEN"\]\. Preview a ref that matches, or extend .*SUPPORTED_DEV_VARS or SUPPORTED_DEV_SECRETS/);
    return true;
  });
});

test('refuses every binding kind the dev config would silently drop', () => {
  assert.ok(UNSUPPORTED_BINDING_KEYS.length > 30);
  for (const key of UNSUPPORTED_BINDING_KEYS) {
    const base = { ...conforming(), [key]: [{ binding: 'EXTRA' }] };
    assert.deepEqual(contractDivergences(base), [`unsupported binding kind ${key} [{"binding":"EXTRA"}]`], key);
    assert.throws(() => workerConfig(base), new RegExp(`unsupported binding kind ${key} `), key);
  }
});

// Guards a Wrangler upgrade: every top-level key its config schema knows must
// be classified as contract, refused binding kind, or deliberately ignored.
test('every Wrangler top-level config key is classified', () => {
  const schema = JSON.parse(readFileSync(realpathSync(join(repo, 'node_modules/wrangler/config-schema.json')), 'utf8'));
  const keys = Object.keys(schema.definitions.RawConfig.properties);
  const ignored = ['$schema', 'env', 'name', 'account_id', 'compatibility_date', 'compatibility_flags', 'main', 'find_additional_modules', 'preserve_file_names',
    'base_dir', 'workers_dev', 'preview_urls', 'routes', 'route', 'tsconfig', 'jsx_factory', 'jsx_fragment', 'triggers', 'limits', 'rules', 'build', 'no_bundle',
    'minify', 'keep_names', 'first_party_worker', 'logpush', 'upload_source_maps', 'placement', 'observability', 'access', 'cache', 'compliance_region',
    'python_modules', 'previews', 'define', 'pages_build_output_dir', 'send_metrics', 'dependencies_instrumentation', 'dev', 'site', 'alias',
    'keep_vars', 'addresses'];
  const contract = [...Object.keys(SUPPORTED_WORKER_CONTRACT), 'vars', 'secrets'];
  const unclassified = keys.filter(key => !contract.includes(key) && !UNSUPPORTED_BINDING_KEYS.includes(key) && !ignored.includes(key));
  assert.deepEqual(unclassified, []);
  for (const key of UNSUPPORTED_BINDING_KEYS) assert.ok(keys.includes(key), `${key} is a real Wrangler key`);
});

test('the real repository wrangler.jsonc conforms and yields the same bindings and migrations', () => {
  const { rawConfig } = experimental_readRawConfig({ config: realpathSync(join(repo, 'wrangler.jsonc')) });
  assert.deepEqual(contractDivergences(rawConfig), []);
  const config = workerConfig(rawConfig);
  assert.deepEqual(config.durable_objects.bindings, rawConfig.durable_objects.bindings);
  assert.deepEqual(config.migrations, rawConfig.migrations);
  assert.equal(config.assets.binding, rawConfig.assets.binding);
  assert.equal(config.vars.FIREBASE_CONFIG, rawConfig.vars.FIREBASE_CONFIG);
  // Every var and required secret the repository declares reaches the dev config.
  assert.deepEqual(config.vars, rawConfig.vars);
  assert.deepEqual(config.secrets, rawConfig.secrets);
});

test('the supported dev vars and secrets are immutable', () => {
  assert.throws(() => { SUPPORTED_DEV_VARS.pinned.ALLOWED_EMAIL = 'attacker'; }, TypeError);
  assert.throws(() => { SUPPORTED_DEV_VARS.fromSnapshot.push('OTHER'); }, TypeError);
  assert.throws(() => { SUPPORTED_DEV_SECRETS.push('OTHER'); }, TypeError);
});

test('a snapshot may omit the pinned vars and required secrets; dev supplies them', () => {
  const base = conforming(); delete base.secrets;
  assert.deepEqual(contractDivergences(base), []);
  const config = workerConfig(base);
  assert.deepEqual(config.vars, { FIREBASE_PROJECT_ID: 'foreman-hong-2026', ALLOWED_EMAIL: 'hooong.yang@gmail.com', FIREBASE_CONFIG: 'public' });
  assert.deepEqual(config.secrets, { required: ['HOST_TOKEN'] });
});

function fixture(t, wrangler) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-dev-contract-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = openHome(dir), source = join(dir, 'source'); mkdirSync(source);
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.email', 'fixture@example.com'); git('config', 'user.name', 'Fixture');
  mkdirSync(join(source, 'web')); mkdirSync(join(source, 'node_modules'));
  writeFileSync(join(source, '.gitignore'), 'node_modules\n');
  writeFileSync(join(source, 'package-lock.json'), '{}'); writeFileSync(join(source, 'web/index.html'), '<title>Test</title><body></body>');
  writeFileSync(join(source, 'node_modules/installed.js'), 'installed');
  writeFileSync(join(source, 'wrangler.jsonc'), `{ // snapshot under test\n${JSON.stringify(wrangler).slice(1, -1)},\n}`);
  git('add', '.'); git('commit', '-m', 'fixture');
  // A previous successful deployment that a refused deploy must leave intact.
  const old = 'release-previous'; mkdirSync(join(home, old), { mode: 0o700 });
  const previous = { release: old, commit: 'b'.repeat(40) };
  writeFileSync(join(home, 'deployment.json'), JSON.stringify(previous), { mode: 0o600 });
  return { home, source, commit: git('rev-parse', 'HEAD'), old, previous };
}
const deployCases = {
  'conforming (positive control)': base => base,
  'extra Durable Object binding': base => { base.durable_objects.bindings.push({ name: 'CACHE', class_name: 'Cache' }); return base; },
  'v2 migration': base => { base.migrations.push({ tag: 'v2', new_sqlite_classes: ['Cache'] }); return base; },
  'extra var': base => { base.vars.FEATURE_FLAG = 'on'; return base; },
  'extra required secret': base => { base.secrets = { required: ['HOST_TOKEN', 'STRIPE_KEY'] }; return base; },
};
const deployRefusals = {
  'extra Durable Object binding': /Refusing preview.*extra or renamed Durable Object binding \{"name":"CACHE"/,
  'v2 migration': /Refusing preview.*extra or different migration \{"tag":"v2"/,
  'extra var': /Refusing preview.*unsupported vars \["FEATURE_FLAG"\]/,
  'extra required secret': /Refusing preview.*unsupported required secrets \["STRIPE_KEY"\]/,
};
for (const [name, build] of Object.entries(deployCases)) test(`deploy checks the snapshot contract before any deployer call: ${name}`, async t => {
  const f = fixture(t, build(conforming()));
  let calls = 0;
  const deployer = async (_home, config) => { calls++; assert.deepEqual(JSON.parse(readFileSync(config)).migrations, [v1]); };
  if (name.startsWith('conforming')) {
    await deploy(f.home, { source: f.source, ref: f.commit }, deployer);
    assert.equal(calls, 2);
    assert.equal(JSON.parse(readFileSync(join(f.home, 'deployment.json'))).commit, f.commit);
    return;
  }
  await assert.rejects(deploy(f.home, { source: f.source, ref: f.commit }, deployer), deployRefusals[name]);
  assert.equal(calls, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(f.home, 'deployment.json'))), f.previous);
  assert.deepEqual(readdirSync(f.home).filter(n => n.startsWith('release-')), [f.old]);
  assert.equal(readdirSync(f.home).some(n => /^(archive-|secrets-)/.test(n)), false);
  // Refused before the pairing credential is minted or any upload is staged.
  assert.equal(existsSync(join(f.home, 'dev-pairing.json')), false);
});
