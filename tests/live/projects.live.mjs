import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, rmSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { bootstrapClaudeCredentials } from './credentials.mjs';
import { Harness, assertSuccess, join, randomUUID, delay } from './harness.mjs';

test('live registered project launch uses its pinned symlink-parent cwd and rejects retargeting after restart', { skip: process.env.FOREMAN_LIVE !== '1', timeout: 240_000 }, async () => {
  const h = new Harness();
  const oldHome = process.env.HOME, oldCodex = process.env.CODEX_HOME;
  try {
    // The existing harness obtains only the explicit Keychain token and Codex auth.
    // Its Foreman/Claude/Codex state and provider commands stay in disposable roots.
    process.env.CODEX_HOME ||= join(homedir(), '.codex');
    h.dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-conformance-')));
    h.claudeConfig = join(h.dir, 'claude-config'); mkdirSync(h.claudeConfig, { mode: 0o700 });
    h.credentialsPath = bootstrapClaudeCredentials(h.claudeConfig);
    process.env.HOME = join(h.dir, 'home'); mkdirSync(process.env.HOME);
    await h.start();
    const f = h.fixture(), parent = join(h.dir, 'code');
    symlinkSync(f.dir, parent);
    const path = join(parent, 'project');
    await h.api('/api/projects/register', { name: 'personal-repo', path, aliases: ['the personal repo'] });
    assert.equal((await h.api('/api/projects/resolve', { reference: 'the personal repo' })).path, f.project);
    for (const provider of ['claude', 'codex']) {
      const row = await h.create(provider, 'native', { ...f, project: 'personal-repo' });
      assert.equal(row.cwd, f.project); assert.equal(row.project_name, 'personal-repo');
      const command = 'pwd && cat readable.txt';
      const probe = await h.probe(row, h.shell(row, command), 'allow');
      assertSuccess(probe, command, f.token); assertSuccess(probe, command, f.project);
      await h.reported(row);
    }
    await h.stop();
    const replacement = join(h.dir, 'replacement'); mkdirSync(join(replacement, 'project'), { recursive: true });
    rmSync(parent); symlinkSync(replacement, parent);
    await h.start();
    const before = (await h.api('/api/sessions')).length, events = h.events.length;
    for (const cwd of ['personal-repo', path, f.project]) {
      await h.api('/api/sessions', { id: randomUUID(), provider: 'claude', name: 'must-not-launch', cwd, text: 'Must not reach the provider' }, 400);
    }
    await delay(500);
    assert.equal((await h.api('/api/sessions')).length, before);
    assert.equal(h.events.length, events, 'rejected directories must produce no provider events');
    assert.equal((await h.api('/api/projects')).projects[0].canonicalPath, f.project);
  } finally {
    await h.close();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
  }
});
