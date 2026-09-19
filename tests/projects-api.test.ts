import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

test('host project APIs authenticate owner, resolve only known references, persist management and reject missing launch', { timeout: 15000 }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-project-api-'))), project = join(home, 'project'); mkdirSync(project);
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = (reservation.address() as any).port; await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, FOREMAN_HOME: join(home, 'state'), CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), FOREMAN_PORT: String(port), FOREMAN_PM_DISABLED: '1', FOREMAN_CLAUDE_BIN: process.execPath };
  delete env.FOREMAN_RELAY_URL; delete env.FOREMAN_HOST_TOKEN;
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/main.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', (chunk) => { logs += chunk; }); child.stderr.on('data', (chunk) => { logs += chunk; }); const exited = once(child, 'exit');
  const origin = `http://127.0.0.1:${port}`;
  try {
    let health: any;
    for (let n = 0; n < 80; n++) { health = await fetch(origin + '/api/health').then((r) => r.json()).catch(() => null); if (health) break; if (child.exitCode !== null) throw new Error(`Isolated project host exited: ${logs}`); await delay(100); }
    assert.equal(health?.pid, child.pid);
    const headers = { authorization: `Bearer ${readFileSync(join(env.FOREMAN_HOME!, 'local-api-token'), 'utf8').trim()}`, 'content-type': 'application/json' };
    const post = (path: string, body: any) => fetch(origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
    for (const action of ['resolve', 'register', 'update', 'remove']) assert.equal((await fetch(origin + '/api/projects/' + action, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(origin + '/api/projects')).status, 401);
    const registered = await (await post('/api/projects/register', { name: 'test repo', path: project, aliases: ['personal repo'] })).json() as any;
    assert.equal(registered.path, project);
    assert.equal((await (await post('/api/projects/resolve', { reference: 'the personal repo' })).json() as any).path, project);
    assert.equal((await (await post('/api/projects/resolve', { reference: 'imaginary' })).json() as any).status, 'not_found');
    assert.equal((await post('/api/projects/update', { id: registered.id, name: 'renamed' })).status, 200);
    assert.equal((await fetch(origin + '/api/projects/list-directory?path=/', { headers })).status, 404);
    const missing = await post('/api/sessions', { id: 'must-not-launch', provider: 'claude', cwd: join(home, 'missing'), name: 'missing', text: 'Must not execute' });
    assert.equal(missing.status, 400);
    assert.deepEqual(await (await fetch(origin + '/api/sessions', { headers })).json(), []);
    assert.equal((await post('/api/projects/remove', { id: registered.id })).status, 200);
    assert.deepEqual((await (await fetch(origin + '/api/projects', { headers })).json() as any).projects, []);
    child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null]);
  } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await exited; } rmSync(home, { recursive: true, force: true }); }
});
