import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

test('local daemon shuts down on SIGTERM with an open SSE client and no provider turn', { timeout:15000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'foreman-lifecycle-'));
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/main.ts'], {
    env:{ ...process.env, FOREMAN_HOME:home, CLAUDE_CONFIG_DIR:join(home, 'claude'), FOREMAN_PORT:String(port), FOREMAN_PM_DISABLED:'1', FOREMAN_CLAUDE_BIN:process.execPath },
    stdio:['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume(); child.stderr.resume();
  const exited = once(child, 'exit');
  let reader;
  try {
    let health;
    for (let attempts = 0; attempts < 80; attempts++) {
      health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()).catch(() => null);
      if (health) break;
      await delay(100);
    }
    assert.equal(health?.ok, true);
    assert.equal(health?.pm_enabled, false);
    const events = await fetch(`http://127.0.0.1:${port}/api/events`);
    reader = events.body.getReader(); await reader.read();
    child.kill('SIGTERM');
    const [code, signal] = await exited;
    assert.equal(code, 0); assert.equal(signal, null);
  } finally {
    await reader?.cancel().catch(() => {});
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(home, { recursive:true, force:true });
  }
});
