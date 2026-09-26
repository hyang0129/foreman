import test from 'node:test';
import assert from 'node:assert/strict';
import { permissionMode, claudePolicy, codexPolicy, PERMISSION_MODES, CODEX_AUTO_UNSUPPORTED } from '../server/permission-policy.ts';

test('only native, bypass and auto launch modes are accepted; omission and null mean native', () => {
  assert.deepEqual([...PERMISSION_MODES], ['native', 'bypass', 'auto']);
  for (const value of [undefined, null, 'native']) assert.equal(permissionMode(value), 'native');
  assert.equal(permissionMode('bypass'), 'bypass');
  assert.equal(permissionMode('auto'), 'auto');
  for (const value of ['', 'default', 'workspace', 'read-only', 'trusted', 'full', 'bypassPermissions', 'Auto', 'dontAsk', 'acceptEdits', {}])
    assert.throws(() => permissionMode(value), /permission_mode/);
});

test('Claude maps each mode to its SDK permissionMode; auto is the SDK auto mode', () => {
  assert.equal(claudePolicy('native'), 'default');
  assert.equal(claudePolicy('bypass'), 'bypassPermissions');
  assert.equal(claudePolicy('auto'), 'auto');
});

test('Codex keeps its native and bypass mappings and refuses auto (D6)', () => {
  assert.deepEqual(codexPolicy('native'), { sandbox: 'workspace-write', approvalPolicy: 'on-request' });
  assert.deepEqual(codexPolicy('bypass'), { sandbox: 'danger-full-access', approvalPolicy: 'never' });
  assert.throws(() => codexPolicy('auto'), new RegExp(CODEX_AUTO_UNSUPPORTED));
  assert.equal(CODEX_AUTO_UNSUPPORTED, 'Auto is not supported for Codex');
});
