import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapClaudeCredentials } from './live/credentials.mjs';
import { Harness } from './live/harness.mjs';

const synthetic = JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' } });
function config(t) {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-bootstrap-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('credential bootstrap requires separate opt-in before reading Keychain', (t) => {
  const dir = config(t);
  for (const enabled of ['', '0', 'true']) assert.throws(() => bootstrapClaudeCredentials(dir, {
    enabled, run: () => assert.fail('Must not read Keychain without opt-in'),
  }), /FOREMAN_LIVE_CLAUDE_KEYCHAIN=1/);
  assert.equal(existsSync(join(dir, '.credentials.json')), false);
});

test('credential bootstrap writes exclusively with mode 0600 and reports failures without secrets', (t) => {
  const dir = config(t);
  const options = { enabled: '1', platform: 'darwin', run: (binary, args) => {
    assert.equal(binary, '/usr/bin/security');
    assert.deepEqual(args, ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
    return { status: 0, stdout: synthetic };
  } };
  const path = bootstrapClaudeCredentials(dir, options);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, 'utf8'), synthetic);
  assert.throws(() => bootstrapClaudeCredentials(dir, options), { code: 'EEXIST' });
  rmSync(path);
  for (const result of [
    { status: 44, stdout: synthetic, stderr: synthetic },
    { status: null, error: new Error(synthetic) },
    { status: 0, stdout: '' },
    { status: 0, stdout: 'synthetic-invalid-secret' },
    { status: 0, stdout: '{}' },
  ]) {
    assert.throws(() => bootstrapClaudeCredentials(dir, { ...options, run: () => result }), (error) => {
      assert.match(error.message, /Claude Keychain bootstrap failed/);
      assert.doesNotMatch(error.message, /synthetic/);
      return true;
    });
    assert.equal(existsSync(path), false);
  }
});

test('harness removes credentials even when shutdown or setup fails', async (t) => {
  for (const failure of ['stop', 'browser', 'setup']) {
    const h = new Harness();
    h.dir = config(t);
    const dir = join(h.dir, 'claude-config'); mkdirSync(dir);
    h.credentialsPath = bootstrapClaudeCredentials(dir, { enabled: '1', platform: 'darwin', run: () => ({ status: 0, stdout: synthetic }) });
    const path = h.credentialsPath;
    if (failure === 'stop') h.stop = async () => { throw new Error('stop failure'); };
    if (failure === 'browser') h.browser = { close: async () => { throw new Error('browser failure'); } };
    if (failure === 'setup') h.startIsolated = async () => { throw new Error('setup failure'); };
    await assert.rejects(failure === 'setup' ? h.start() : h.close(), new RegExp(`${failure} failure`));
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(h.dir), false);
  }
});
