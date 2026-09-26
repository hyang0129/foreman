import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// #122: daemon-level diagnostics. Each daemon runs on a temp FOREMAN_HOME with FOREMAN_PM_DISABLED
// (the provider launch is deferred to the first message, so no provider ever runs here), and any
// relay it is given is invalid or unreachable, so nothing leaves the machine.
const TOKEN = 'synthetic-test-host-credential'.repeat(2);

async function daemon(t, { env = {}, prepare = () => {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'foreman-pm-diagnostics-'));
  prepare(home);
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/main.ts'], {
    env: { ...process.env, HOME: home, FOREMAN_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude'), FOREMAN_PORT: String(port), FOREMAN_PM_DISABLED: '1',
      FOREMAN_CLAUDE_BIN: process.execPath, FOREMAN_RELAY_URL: '', FOREMAN_HOST_TOKEN: '', FOREMAN_PM_MODEL: '', FOREMAN_MACHINE_NAME: 'diagnostics-box', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([exited, delay(5000, undefined, { ref: false })]); }
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  let health;
  for (let attempts = 0; attempts < 80; attempts++) {
    health = await fetch(`${origin}/api/health`).then((r) => r.json()).catch(() => null);
    if (health) break;
    await delay(100);
  }
  assert.equal(health?.ok, true);
  const headers = { authorization: `Bearer ${readFileSync(join(home, 'local-api-token'), 'utf8').trim()}` };
  return { home, origin, headers, output: () => output };
}

// The PM store is chosen just after the HTTP server starts listening: poll until it has settled.
async function moveError(origin, headers) {
  let body;
  for (let attempts = 0; attempts < 50; attempts++) {
    const response = await fetch(`${origin}/api/pm/host`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ machine_id: '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', expected_epoch: 1 }) });
    assert.equal(response.status, 400);
    body = await response.json();
    if (body.error !== 'Reassignment needs the cloud relay') break;
    await delay(100);
  }
  return body.error;
}

test('#122: POST /api/pm/host on a machine whose relay env is invalid names the invalid configuration, never the token', { timeout: 20000 }, async (t) => {
  const { origin, headers, output } = await daemon(t, { env: { FOREMAN_RELAY_URL: 'http://127.0.0.1:9', FOREMAN_HOST_TOKEN: TOKEN } });
  const error = await moveError(origin, headers);
  assert.equal(error, 'Reassignment needs the cloud relay, which this machine cannot use: the relay configuration (FOREMAN_RELAY_URL/FOREMAN_HOST_TOKEN) is invalid (Relay URL must be an HTTPS origin); the Coordinator is unavailable on this machine');
  assert.ok(!error.includes(TOKEN));
  assert.ok(!output().includes(TOKEN), 'the token is never logged');
});

test('#122: POST /api/pm/host names an invalid cloud.json', { timeout: 20000 }, async (t) => {
  const { origin, headers } = await daemon(t, { prepare: (home) => writeFileSync(join(home, 'cloud.json'), JSON.stringify({ url: 'https://relay.invalid', token: TOKEN }), { mode: 0o644 }) });
  const error = await moveError(origin, headers);
  assert.equal(error, 'Reassignment needs the cloud relay, which this machine cannot use: cloud.json is invalid (cloud.json must be an owned regular file with mode 0600); the Coordinator is unavailable on this machine');
});

test('#122: GET /api/pm/history reports the stored model before the first PM start', { timeout: 20000 }, async (t) => {
  // A pre-#26 home: its pm/settings.json model is imported into the local store once.
  const { origin, headers } = await daemon(t, { prepare: (home) => { mkdirSync(join(home, 'pm'), { recursive: true }); writeFileSync(join(home, 'pm', 'settings.json'), JSON.stringify({ model: 'claude-sonnet-4-5' })); } });
  let history;
  for (let attempts = 0; attempts < 50; attempts++) {
    history = await fetch(`${origin}/api/pm/history`, { headers }).then((r) => r.json());
    if (history.model) break;
    await delay(100);
  }
  assert.equal(history.model, 'claude-sonnet-4-5');
  assert.equal(history.session_id, null, 'no provider was started to answer it');
  assert.deepEqual(Object.keys(history).sort(), ['busy', 'error', 'history', 'model', 'session_id']);
});

test('#122: GET /api/pm/history reports the configured default model when none is stored', { timeout: 20000 }, async (t) => {
  const { origin, headers } = await daemon(t, { env: { FOREMAN_PM_MODEL: 'claude-default-model' } });
  let history;
  for (let attempts = 0; attempts < 50; attempts++) {
    history = await fetch(`${origin}/api/pm/history`, { headers }).then((r) => r.json());
    if (history.model) break;
    await delay(100);
  }
  assert.equal(history.model, 'claude-default-model');
  assert.equal(history.session_id, null);
});
