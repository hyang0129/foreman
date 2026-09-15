import test from 'node:test';
import assert from 'node:assert/strict';

if (process.env.FOREMAN_LIVE !== '1') {
  test('Trusted Git TLS regression (set FOREMAN_LIVE=1)', { skip: 'explicit provider opt-in required' }, () => {});
} else {
  const { Harness, assertSuccess, assertShellExit, commandResults, claudeResults, claudeOutput,
    existsSync, readFileSync, join, spawnSync } = await import('./harness.mjs');
  test('Trusted Git TLS regression on real providers', { timeout: 300_000 }, async (t) => {
    const h = new Harness(); t.after(() => h.close());
    assert.equal(process.platform, 'darwin');
    await h.start();
    for (const provider of ['claude', 'codex']) await t.test(`${provider}/trusted`, async (t) => {
      const f = h.fixture();
      const setup = spawnSync('git', ['init', f.project], { encoding: 'utf8' });
      assert.equal(setup.status, 0, setup.stderr);
      // Pull only README so checkout cannot collide with the harness's copied
      // controller sources and synthetic package.json.
      const sparse = spawnSync('git', ['sparse-checkout', 'set', '--no-cone', '/README.md'], { cwd: f.project, encoding: 'utf8' });
      assert.equal(sparse.status, 0, sparse.stderr);
      const row = await h.create(provider, 'trusted', f);
      await t.test('requested preset and provider initialization', async () => { await h.idle(row); await h.reported(row); });
      const probe = async (command, token) => {
        // Give the actual operation time to finish; a running process isn't a pass.
        const prompt = provider === 'codex'
          ? `Call foreman_exec with ${JSON.stringify({ command, yield_ms: 30000 })}.`
          : h.shell(row, command);
        const result = await h.probe(row, prompt);
        assert.equal(result.approvals.length, 0);
        assertShellExit(result, command, 0);
        assertSuccess(result, command, token);
        const output = [...commandResults(result, command).map((r) => r.output), ...claudeResults(result, command).map(claudeOutput)].join('\n');
        assert.doesNotMatch(output, /couldn't create cache file|error setting certificate verify locations/);
      };
      await t.test('git fetch exits zero and writes FETCH_HEAD', async () => {
        await probe('git fetch --depth=1 https://github.com/hyang0129/foreman.git main');
        assert.match(readFileSync(join(f.project, '.git/FETCH_HEAD'), 'utf8'), /^[a-f0-9]{40}\s/);
        assert.equal(existsSync(join(f.project, '.foreman-tmp')), false, 'command caches must be cleaned after fetch');
      });
      await t.test('git pull exits zero over TLS', async () => {
        await probe('git pull --ff-only https://github.com/hyang0129/foreman.git main');
        const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: f.project, encoding: 'utf8' });
        assert.equal(head.status, 0, head.stderr);
        assert.match(head.stdout, /^[a-f0-9]{40}\n$/);
      });
      await t.test('agreed gh issue view exits zero', async () => {
        await probe('gh issue view 2 --repo hyang0129/foreman --json number', '"number":2');
      });
    });
  });
}
