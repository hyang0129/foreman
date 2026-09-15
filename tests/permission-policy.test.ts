import test from 'node:test';
import assert from 'node:assert/strict';
import { permissionMode } from '../server/permission-policy.ts';

test('only native and bypass launch modes are accepted; omission and null mean native', () => {
  for (const value of [undefined, null, 'native']) assert.equal(permissionMode(value), 'native');
  assert.equal(permissionMode('bypass'), 'bypass');
  for (const value of ['', 'default', 'workspace', 'read-only', 'trusted', 'full', 'bypassPermissions', {}])
    assert.throws(() => permissionMode(value), /permission_mode/);
});
