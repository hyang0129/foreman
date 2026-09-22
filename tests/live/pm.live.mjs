import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

if (process.env.FOREMAN_LIVE !== '1') {
  test('live PM success and authentication failure', { skip: 'spends real provider turns' }, () => {});
} else {
  assert.equal(process.env.FOREMAN_LIVE_CLAUDE_KEYCHAIN, '1', 'Explicit read-only Keychain opt-in required');
  const home = mkdtempSync(join(tmpdir(), 'foreman-pm-live-'));
  process.env.FOREMAN_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, 'claude');
  mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  // Read the current access token only. Never clone or rotate the owner's refresh token.
  const credentials = JSON.parse(execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  process.env.CLAUDE_CODE_OAUTH_TOKEN = credentials.claudeAiOauth.accessToken;
  assert.ok(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  delete process.env.ANTHROPIC_API_KEY;
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { ProjectManager } = await import('../../server/pm.ts');
  const { ensureDirs, PM_HISTORY_FILE, PM_SESSION_FILE } = await import('../../server/paths.ts');
  ensureDirs();
  test.after(() => rmSync(home, { recursive: true, force: true }));
  for (const badAuth of [true, false]) test(`live PM ${badAuth ? 'authentication rejection is durable and logged' : 'actually answers a dispatched message'}`, { timeout: 90000 }, async (t) => {
    writeFileSync(PM_HISTORY_FILE, ''); writeFileSync(PM_SESSION_FILE, '');
    const pm = new ProjectManager({} /* fleet tools are forbidden by the prompt */);
    pm.model = 'haiku';
    if (badAuth) pm.queryFactory = ({ prompt, options }) => query({ prompt, options: { ...options, env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'invalid-live-test-token' } } });
    const events = [], logs = [];
    t.mock.method(console, 'error', (...args) => logs.push(args));
    pm.on('event', (event) => events.push(event));
    const running = pm.start();
    try {
      pm.send('Reply with exactly FOREMAN_PM_LIVE_OK. Do not call tools or change anything.');
      const until = Date.now() + 75000;
      while (!events.some((e) => e.type === 'turn_end') && !pm.lastError && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
      if (badAuth) {
        assert.match(pm.lastError || '', /auth|token|401|login/i);
        assert.ok(pm.history().some((entry) => entry.error)); assert.ok(logs.length);
      } else {
        assert.equal(pm.lastError, null);
        assert.ok(events.some((event) => event.type === 'turn_end' && !event.is_error), 'A real successful result is required');
        assert.ok(pm.history().some((entry) => entry.role === 'assistant' && entry.text.includes('FOREMAN_PM_LIVE_OK')), 'An actual persisted answer is required');
      }
    } finally { pm.close(); await running; }
  });
}
