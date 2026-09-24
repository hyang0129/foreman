import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { allowedRequest } from '../shared/relay.ts';

test('relay allowlist admits the PM status summary query', () => {
  assert.equal(allowedRequest('GET', '/api/pm/history?summary=1'), true);
});

test('GET /api/pm/history?summary=1 returns only error and busy; the plain request keeps history', { timeout:15000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'foreman-pm-status-'));
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/main.ts'], {
    env:{ ...process.env, FOREMAN_HOME:home, CLAUDE_CONFIG_DIR:join(home, 'claude'), FOREMAN_PORT:String(port), FOREMAN_PM_DISABLED:'1', FOREMAN_CLAUDE_BIN:process.execPath },
    stdio:['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume(); child.stderr.resume();
  const exited = once(child, 'exit');
  try {
    const origin = `http://127.0.0.1:${port}`;
    let health;
    for (let attempts = 0; attempts < 80; attempts++) {
      health = await fetch(`${origin}/api/health`).then((r) => r.json()).catch(() => null);
      if (health) break;
      await delay(100);
    }
    assert.equal(health?.ok, true);
    const headers = { authorization:`Bearer ${readFileSync(join(home, 'local-api-token'), 'utf8').trim()}` };

    assert.equal((await fetch(`${origin}/api/pm/history?summary=1`)).status, 401, 'summary must stay behind auth');

    const fullRes = await fetch(`${origin}/api/pm/history`, { headers });
    assert.equal(fullRes.status, 200);
    const full = await fullRes.json();
    assert.ok(Array.isArray(full.history), 'plain request must still carry the history array');
    assert.deepEqual(Object.keys(full).sort(), ['busy', 'error', 'history', 'model', 'session_id']);

    const summaryRes = await fetch(`${origin}/api/pm/history?summary=1`, { headers });
    assert.equal(summaryRes.status, 200);
    const summary = await summaryRes.json();
    assert.deepEqual(Object.keys(summary).sort(), ['busy', 'error']);
    assert.equal('history' in summary, false);
    assert.equal(summary.error, full.error);
    assert.equal(summary.busy, full.busy);
    assert.equal(typeof summary.busy, 'boolean');
    assert.ok(summary.error === null || typeof summary.error === 'string');
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([exited, delay(5000, undefined, { ref:false })]); }
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(home, { recursive:true, force:true });
  }
});
