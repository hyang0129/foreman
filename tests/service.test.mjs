import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { config, renderPlist, assertOwnedPlist, assertPortAvailable, LABEL } from '../scripts/service.mjs';
import * as service from '../scripts/service.mjs';
import { isMachineName, MAX_MACHINE_NAME } from '../shared/pm-state.ts';

const options = { repo: '/tmp/foreman & <checkout>', home: '/tmp/test user', node: '/opt/node/bin/node', env: {} };

test('plist roundtrips paths as arguments, keeps credentials out, and sets restart/log policy', { skip: process.platform !== 'darwin' }, () => {
  const conf = config({ ...options, env: { ANTHROPIC_API_KEY: 'secret', FOREMAN_PORT: '4180' } });
  const xml = renderPlist(conf.plist);
  const parsed = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: xml, encoding: 'utf8' }));
  assert.deepEqual(parsed, conf.plist);
  assert.deepEqual(parsed.ProgramArguments, ['/opt/node/bin/node', '--experimental-strip-types', '/tmp/foreman & <checkout>/server/main.ts']);
  assert.equal(parsed.EnvironmentVariables.FOREMAN_PORT, '4180');
  assert.equal(parsed.KeepAlive, true);
  assert.equal(parsed.RunAtLoad, true);
  assert.equal(parsed.ThrottleInterval, 10);
  assert.ok(parsed.StandardErrorPath.endsWith('logs/service.stderr.log'));
  assert.ok(!xml.includes('secret'));
});

test('ownership guard refuses foreign jobs and another checkout', () => {
  const { plist } = config(options);
  assert.doesNotThrow(() => assertOwnedPlist(plist, options.repo));
  assert.throws(() => assertOwnedPlist({ ...plist, Label: 'some.other.job' }, options.repo), /not owned/);
  assert.throws(() => assertOwnedPlist({ ...plist, ForemanManagedBy: undefined }, options.repo), /not owned/);
  assert.throws(() => assertOwnedPlist(plist, '/some/other/foreman'), /not owned/);
  assert.equal(plist.Label, LABEL);
});

test('keep awake is opt-in and scoped to AC power through caffeinate', () => {
  assert.equal(config(options).plist.ProgramArguments[0], options.node);
  const args = config({ ...options, keepAwake: true }).plist.ProgramArguments;
  assert.deepEqual(args.slice(0, 3), ['/usr/bin/caffeinate', '-s', options.node]);
});

test('rejects invalid ports, relative executable paths, and XML control characters', () => {
  for (const port of ['NaN', '-1', '0', '70000', '123.5']) assert.throws(() => config({ ...options, env: { FOREMAN_PORT: port } }), /FOREMAN_PORT/);
  assert.throws(() => config({ ...options, env: { FOREMAN_CLAUDE_BIN: 'claude' } }), /absolute path/);
  assert.throws(() => renderPlist({ Invalid: '\u0000' }), /control character/);
});

test('occupied port guard refuses to launch without disturbing its listener', async () => {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  try {
    await assert.rejects(assertPortAvailable(port), /stop the existing server first/);
    assert.ok(listener.listening);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
  await assert.doesNotReject(assertPortAvailable(port));
});

test('#118: FOREMAN_MACHINE_NAME and FOREMAN_PM_HUNG_MS set at install time reach the service environment', () => {
  const conf = config({ ...options, env: { FOREMAN_MACHINE_NAME: '  Studio Mac & <home>  ', FOREMAN_PM_HUNG_MS: '120000' } });
  assert.equal(conf.plist.EnvironmentVariables.FOREMAN_MACHINE_NAME, 'Studio Mac & <home>');
  assert.equal(conf.plist.EnvironmentVariables.FOREMAN_PM_HUNG_MS, '120000');
  if (process.platform === 'darwin') {
    const xml = renderPlist(conf.plist);
    const parsed = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: xml, encoding: 'utf8' }));
    assert.equal(parsed.EnvironmentVariables.FOREMAN_MACHINE_NAME, 'Studio Mac & <home>');
    assert.equal(parsed.EnvironmentVariables.FOREMAN_PM_HUNG_MS, '120000');
  }
});

test('#118: unset or empty settings are not written, so the daemon keeps its defaults', () => {
  for (const env of [{}, { FOREMAN_MACHINE_NAME: '', FOREMAN_PM_HUNG_MS: '' }]) {
    const vars = config({ ...options, env }).plist.EnvironmentVariables;
    assert.ok(!('FOREMAN_MACHINE_NAME' in vars));
    assert.ok(!('FOREMAN_PM_HUNG_MS' in vars));
  }
});

test('#118: invalid values refuse the install instead of producing a service that misbehaves', () => {
  for (const hung of ['0', '-5', '1.5', '1e3', 'abc', ' 100', '99999999999999999999']) {
    assert.throws(() => config({ ...options, env: { FOREMAN_PM_HUNG_MS: hung } }), /FOREMAN_PM_HUNG_MS must be a positive integer/, hung);
  }
  for (const name of ['   ', 'x'.repeat(MAX_MACHINE_NAME + 1), 'bad\u0007name', 'tab\there', 'del\u007f']) {
    assert.throws(() => config({ ...options, env: { FOREMAN_MACHINE_NAME: name } }), /FOREMAN_MACHINE_NAME must be 1-80 printable characters/, JSON.stringify(name));
  }
});

test('#118: the installer name rule agrees with shared/pm-state.ts isMachineName after trimming', () => {
  assert.equal(service.MAX_MACHINE_NAME, MAX_MACHINE_NAME);
  const samples = ['a', 'Mac mini', ' padded ', 'x'.repeat(80), 'x'.repeat(81), '   ', 'a\nb', 'a\u0085b', 'caf\u00e9', '\u{1F600} host'];
  for (const name of samples) {
    let accepted = true;
    try { service.passThroughSettings({ FOREMAN_MACHINE_NAME: name }); } catch { accepted = false; }
    assert.equal(accepted, isMachineName(name.trim()), JSON.stringify(name));
  }
});

// #197: the role and limit variables the daemon reads reach the installed service.
const ROLE_LIMIT_VARS = {
  FOREMAN_MAX_LEADS: '5', FOREMAN_MAX_WORKERS_PER_LEAD: '2', FOREMAN_PM_EFFORT: 'high',
  FOREMAN_LEAD_MODEL: 'sonnet', FOREMAN_LEAD_EFFORT: 'low', FOREMAN_INVESTIGATOR_MODEL: 'claude-haiku-4-5', FOREMAN_INVESTIGATOR_EFFORT: 'medium',
};

test('#197: role and limit variables set at install time reach the service environment', () => {
  const vars = config({ ...options, env: { ...ROLE_LIMIT_VARS, FOREMAN_LEAD_MODEL: ' opus[1m] ', FOREMAN_MAX_LEADS: ' 07 ' } }).plist.EnvironmentVariables;
  assert.deepEqual(Object.fromEntries(Object.keys(ROLE_LIMIT_VARS).map((key) => [key, vars[key]])),
    { ...ROLE_LIMIT_VARS, FOREMAN_LEAD_MODEL: 'opus[1m]', FOREMAN_MAX_LEADS: '7' });
  if (process.platform === 'darwin') {
    const parsed = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: renderPlist(config({ ...options, env: ROLE_LIMIT_VARS }).plist), encoding: 'utf8' }));
    for (const [key, value] of Object.entries(ROLE_LIMIT_VARS)) assert.equal(parsed.EnvironmentVariables[key], value, key);
  }
  const empty = config({ ...options, env: Object.fromEntries(Object.keys(ROLE_LIMIT_VARS).map((key) => [key, ''])) }).plist.EnvironmentVariables;
  for (const key of Object.keys(ROLE_LIMIT_VARS)) assert.ok(!(key in empty), `${key} empty keeps the daemon default`);
  const unset = config(options).plist.EnvironmentVariables;
  for (const key of Object.keys(ROLE_LIMIT_VARS)) assert.ok(!(key in unset), `${key} unset keeps the daemon default`);
});

test('#197: invalid role and limit values refuse the install', () => {
  const bad = { FOREMAN_MAX_LEADS: ['0', '-1', '1.5', 'three', '1234567'], FOREMAN_MAX_WORKERS_PER_LEAD: ['0', 'x'],
    FOREMAN_PM_EFFORT: ['extreme', 'Low'], FOREMAN_LEAD_EFFORT: ['none'], FOREMAN_INVESTIGATOR_EFFORT: ['1'],
    FOREMAN_LEAD_MODEL: ['bad model', '-opus', 'x'.repeat(201)], FOREMAN_INVESTIGATOR_MODEL: ['a;b'] };
  for (const [key, values] of Object.entries(bad)) for (const value of values) {
    assert.throws(() => config({ ...options, env: { [key]: value } }), new RegExp(key), `${key}=${value}`);
  }
});

test('#197: the installer accepts exactly the role and limit values shared/roles.ts would use', async () => {
  const { resolveRoleConfig, leadLimits, ROLE_ENV, LEAD_LIMIT_ENV, ROLE_DEFAULTS, LEAD_LIMITS, EFFORTS } = await import('../shared/roles.ts');
  assert.deepEqual(service.EFFORTS, [...EFFORTS]);
  const roleVars = Object.values(ROLE_ENV).flatMap((r) => [r.model, r.effort]).filter(Boolean).sort();
  assert.deepEqual([...service.MODEL_ENV, ...service.EFFORT_ENV].sort(), roleVars);
  assert.deepEqual([...service.LIMIT_ENV].sort(), Object.values(LEAD_LIMIT_ENV).sort());
  // The installed value, or undefined when the installer refuses it.
  const installed = (key, value) => { try { return service.passThroughSettings({ [key]: value })[key]; } catch { return undefined; } };
  // The daemon uses a value when it resolves to something other than the default, or to the
  // default because the value names it; anything else is ignored (falls back to the default).
  const check = (key, value, daemon, fallback, same) => {
    const used = daemon !== fallback || same;
    assert.equal(installed(key, value) !== undefined, used, `${key}=${JSON.stringify(value)}`);
    if (used) assert.equal(installed(key, value), String(daemon), `${key}=${JSON.stringify(value)}`);
  };
  const models = ['sonnet', 'opus[1m]', ' haiku ', 'claude-sonnet-4-5', 'a/b:c.d_e', 'bad model', '-x', '[x]', 'x'.repeat(200), 'x'.repeat(201), 'été'];
  const efforts = [...EFFORTS, ' high ', 'HIGH', 'extreme', '0'];
  const limits = ['1', '3', ' 12 ', '007', '999999', '1000000', '0', '-2', '1.0', '1e2', 'x'];
  for (const [role, names] of Object.entries(ROLE_ENV)) {
    if (names.model) for (const value of models) {
      check(names.model, value, resolveRoleConfig(role, { env: { [names.model]: value } }).model, ROLE_DEFAULTS[role].model, value.trim() === ROLE_DEFAULTS[role].model);
    }
    for (const value of efforts) {
      check(names.effort, value, resolveRoleConfig(role, { env: { [names.effort]: value } }).effort, ROLE_DEFAULTS[role].effort, value.trim() === ROLE_DEFAULTS[role].effort);
    }
  }
  for (const [field, name] of Object.entries(LEAD_LIMIT_ENV)) for (const value of limits) {
    check(name, value, leadLimits({ [name]: value })[field], LEAD_LIMITS[field], /^\s*[0-9]+\s*$/.test(value) && Number(value) === LEAD_LIMITS[field]);
  }
});

test('#145: status, uninstall and restart ignore pass-through settings; install and plist still refuse bad ones', () => {
  const env = { FOREMAN_MACHINE_NAME: 'bad\u0007name', FOREMAN_PM_HUNG_MS: 'abc', FOREMAN_MAX_LEADS: 'x' };
  for (const command of ['status', 'uninstall', 'restart']) {
    const conf = config({ ...options, env, ...service.commandOptions(command, []) });
    assert.ok(conf.path.endsWith(`${LABEL}.plist`), command);
    for (const key of Object.keys(env)) assert.ok(!(key in conf.plist.EnvironmentVariables), `${command}: ${key}`);
  }
  for (const command of ['install', 'plist']) {
    assert.throws(() => config({ ...options, env, ...service.commandOptions(command, []) }), /must be/, command);
    assert.equal(service.commandOptions(command, ['--keep-awake']).keepAwake, true);
  }
});
