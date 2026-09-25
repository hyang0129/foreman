// Pin FOREMAN_HOME to a temp dir before any server module loads (story #121 guard).
import './fixtures/temp-foreman-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredMachineName, defaultMachineName, loadMachineIdentity, machineFilePath } from '../server/machine.ts';
import { isMachineId, parseMachineIdentity } from '../shared/pm-state.ts';

function home(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-machine-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('first load creates machine.json with a UUID v4 and the hostname, mode 0600', (t) => {
  const dir = home(t);
  const identity = loadMachineIdentity({ home: dir, env: {}, host: 'studio-mac' });
  assert.ok(isMachineId(identity.machine_id));
  assert.equal(identity.name, 'studio-mac');
  const path = machineFilePath(dir);
  assert.equal(path, join(dir, 'machine.json'));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(stored, identity);
  assert.ok(parseMachineIdentity(stored).ok);
});

test('later loads reuse the same machine_id; a second FOREMAN_HOME is a different machine', (t) => {
  const a = home(t), b = home(t);
  const first = loadMachineIdentity({ home: a, env: {}, host: 'mac' });
  const again = loadMachineIdentity({ home: a, env: {}, host: 'renamed-host' });
  assert.deepEqual(again, first, 'the stored name is kept without an explicit override');
  const other = loadMachineIdentity({ home: b, env: {}, host: 'mac' });
  assert.notEqual(other.machine_id, first.machine_id);
});

test('FOREMAN_MACHINE_NAME overrides the name, is persisted, and keeps the machine_id', (t) => {
  const dir = home(t);
  const first = loadMachineIdentity({ home: dir, env: {}, host: 'mac' });
  const named = loadMachineIdentity({ home: dir, env: { FOREMAN_MACHINE_NAME: 'machine-b' }, host: 'mac' });
  assert.equal(named.name, 'machine-b');
  assert.equal(named.machine_id, first.machine_id);
  assert.equal(JSON.parse(readFileSync(machineFilePath(dir), 'utf8')).name, 'machine-b');
  assert.equal(statSync(machineFilePath(dir)).mode & 0o777, 0o600);
  const fresh = home(t);
  assert.equal(loadMachineIdentity({ home: fresh, env: { FOREMAN_MACHINE_NAME: 'machine-c' }, host: 'mac' }).name, 'machine-c');
  assert.throws(() => loadMachineIdentity({ home: fresh, env: { FOREMAN_MACHINE_NAME: 'x'.repeat(81) } }), /FOREMAN_MACHINE_NAME/);
  assert.throws(() => configuredMachineName({ FOREMAN_MACHINE_NAME: 'bad\u0007name' }), /FOREMAN_MACHINE_NAME/);
});

test('a loose mode is tightened to 0600; a malformed or symlinked file is an error, never a new identity', (t) => {
  const dir = home(t);
  const identity = loadMachineIdentity({ home: dir, env: {}, host: 'mac' });
  const path = machineFilePath(dir);
  chmodSync(path, 0o644);
  assert.deepEqual(loadMachineIdentity({ home: dir, env: {}, host: 'mac' }), identity);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  writeFileSync(path, '{"machine_id":"not-a-uuid","name":"mac"}');
  assert.throws(() => loadMachineIdentity({ home: dir, env: {} }), /Invalid machine.json/);
  writeFileSync(path, '{broken');
  assert.throws(() => loadMachineIdentity({ home: dir, env: {} }), /Invalid machine.json/);
  assert.equal(readFileSync(path, 'utf8'), '{broken', 'the bad file is left for the developer, not replaced');
  rmSync(path);
  const target = join(dir, 'elsewhere.json');
  writeFileSync(target, JSON.stringify(identity), { mode: 0o600 });
  symlinkSync(target, path);
  assert.throws(() => loadMachineIdentity({ home: dir, env: {} }), /regular file/);
});

test('the default name is a valid display name even for odd hostnames', () => {
  assert.equal(defaultMachineName('mac'), 'mac');
  assert.equal(defaultMachineName('x'.repeat(200)).length, 80);
  assert.equal(defaultMachineName(''), 'foreman-host');
  assert.equal(defaultMachineName('\u0001\u0002'), 'foreman-host');
  assert.equal(configuredMachineName({}, 'studio'), 'studio');
});
