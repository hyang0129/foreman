import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const run = promisify(execFile);

// Runs `npm run status`'s entry point with an explicit env; resolves with the exit code instead of throwing.
async function status(env) {
  try {
    const { stdout, stderr } = await run(process.execPath, ['--experimental-strip-types', 'server/cli-status.ts'], { env:{ ...process.env, ...env }, timeout:15000 });
    return { code:0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code:error.code, stdout:error.stdout, stderr:error.stderr };
  }
}

test('npm run status authenticates with the local API token against a real daemon', { timeout:30000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'foreman-cli-status-'));
  const emptyHome = mkdtempSync(join(tmpdir(), 'foreman-cli-status-empty-'));
  const wrongHome = mkdtempSync(join(tmpdir(), 'foreman-cli-status-wrong-'));
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
    assert.equal((await fetch(`${origin}/api/sessions`)).status, 401, 'the sessions API must require auth, or this test proves nothing');

    const ok = await status({ FOREMAN_HOME:home, CLAUDE_CONFIG_DIR:join(home, 'claude'), FOREMAN_PORT:String(port) });
    assert.equal(ok.code, 0, `status must succeed against a healthy daemon; stderr: ${ok.stderr}`);
    assert.equal(ok.stderr, '');
    assert.match(ok.stdout, /\(index\)/, 'status must print the sessions table');

    const missing = await status({ FOREMAN_HOME:emptyHome, CLAUDE_CONFIG_DIR:join(emptyHome, 'claude'), FOREMAN_PORT:String(port) });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /local API token not found at .*local-api-token/);
    assert.equal(existsSync(join(emptyHome, 'local-api-token')), false, 'the CLI must never create a token');

    writeFileSync(join(wrongHome, 'local-api-token'), 'a'.repeat(64) + '\n', { mode:0o600 });
    assert.notEqual(readFileSync(join(home, 'local-api-token'), 'utf8').trim(), 'a'.repeat(64));
    const rejected = await status({ FOREMAN_HOME:wrongHome, CLAUDE_CONFIG_DIR:join(wrongHome, 'claude'), FOREMAN_PORT:String(port) });
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /rejected the local API token .*HTTP 401/);
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([exited, delay(5000, undefined, { ref:false })]); }
    if (child.exitCode === null) child.kill('SIGKILL');
    for (const dir of [home, emptyHome, wrongHome]) rmSync(dir, { recursive:true, force:true });
  }
});
