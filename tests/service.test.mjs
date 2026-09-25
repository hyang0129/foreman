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
