import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// #119: a relay-mode daemon's local UI (localhost) cannot answer GET /api/pm/host honestly (only
// the relay knows every machine, whether it is online, and when the PM was assigned), so it keeps
// answering 404. Its body carries this machine's own view, including its identity, which the PM
// view shows as one line. The relay here is unreachable, so the daemon stays disconnected.
async function relayDaemon(t) {
  const home = mkdtempSync(join(tmpdir(), 'foreman-pm-host-view-'));
  // A closed local port: every connection attempt fails, nothing leaves the machine.
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const deadPort = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/main.ts'], {
    env: { ...process.env, HOME: home, FOREMAN_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude'), FOREMAN_PORT: String(port), FOREMAN_PM_DISABLED: '1',
      FOREMAN_CLAUDE_BIN: process.execPath, FOREMAN_RELAY_URL: `https://127.0.0.1:${deadPort}`, FOREMAN_HOST_TOKEN: 'test-relay-token-0123456789abcdefghij', FOREMAN_MACHINE_NAME: 'view-test-box' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume(); child.stderr.resume();
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
  const machine = JSON.parse(readFileSync(join(home, 'machine.json'), 'utf8'));
  return { origin, headers, machine };
}

test('relay mode: the local GET /api/pm/host answers 404 with this machine\'s own view and identity', { timeout: 20000 }, async (t) => {
  const { origin, headers, machine } = await relayDaemon(t);
  let response, body;
  // The store is attached just after the HTTP server starts listening.
  for (let attempts = 0; attempts < 50; attempts++) {
    response = await fetch(`${origin}/api/pm/host`, { headers });
    body = await response.json();
    if (body.view) break;
    await delay(100);
  }
  assert.equal(response.status, 404, 'never a PmHostResponse: the relay alone knows the machines');
  assert.match(body.error, /hosted app/);
  assert.deepEqual(body.view, {
    mode: 'relay', connected: false, this_machine_active: false, epoch: null, active_machine: null,
    this_machine: { machine_id: machine.machine_id, name: 'view-test-box' },
  });
  assert.equal('machines' in body, false);
  assert.equal('active' in body, false);

  // POST is unchanged: the relay moves the PM.
  const move = await fetch(`${origin}/api/pm/host`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ machine_id: machine.machine_id, expected_epoch: 1 }) });
  assert.equal(move.status, 400);
  assert.deepEqual(await move.json(), { error: 'Move the Coordinator from the hosted app; the cloud relay makes that change.' });
});
