import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { get } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
    const origin = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${origin}/api/sessions`)).status, 401, 'reachability must not authorize API access');
    assert.deepEqual(await fetch(`${origin}/api/config`).then((r) => r.json()), { auth: { required: true, kind: 'local' } });
    for (const [path, method] of [['/api/launch', 'GET'], ['/api/launch/propose', 'POST'], ['/api/launch/cancel', 'POST']]) {
      assert.equal((await fetch(`${origin}${path}`, { method })).status, 401, 'launcher routes must use unchanged authentication');
    }
    const headers = {authorization:`Bearer ${readFileSync(join(home, 'local-api-token'), 'utf8').trim()}`};
    const login = await fetch(`${origin}/api/auth/local`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:headers.authorization.slice(7)})});
    assert.equal(login.status,200);
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await fetch(`${origin}/api/host`, {headers:{cookie:login.headers.get('set-cookie').split(';')[0]}})).status,200);
    assert.equal((await fetch(`${origin}/api/sessions`, {headers:{authorization:'Bearer wrong'}})).status,401);
    assert.equal((await fetch(`${origin}/api/sessions`, {method:'POST',body:JSON.stringify({permission_mode:'bypass'})})).status,401);
    assert.equal((await fetch(`${origin}/api/host`, {headers}).then((r) => r.json())).online, true);
    assert.equal((await fetch(`${origin}/api/sessions`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
    const wrongHostStatus = await new Promise((resolve, reject) => {
      get(`${origin}/api/sessions`, { headers: { Host: 'attacker.example' } }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(wrongHostStatus, 403);
    assert.equal((await fetch(`${origin}/api/sessions`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Origin: origin }, body: '[]' })).status, 400);
    // Epic #157 D7: the launcher routes are gone (authenticated requests are not served either).
    const requestId = '11111111-1111-4111-8111-111111111111';
    assert.equal((await fetch(`${origin}/api/launch/cancel`, { method: 'POST', headers, body: JSON.stringify({ id: requestId }) })).status, 404);
    assert.equal((await fetch(`${origin}/api/launch/propose`, { method: 'POST', headers, body: JSON.stringify({ id: requestId, brief: 'Do not run' }) })).status, 404);
    assert.deepEqual(await fetch(`${origin}/api/sessions`, { headers }).then((r) => r.json()), []);
    const events = await fetch(`http://127.0.0.1:${port}/api/events`, {headers});
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
