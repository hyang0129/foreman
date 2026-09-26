// Epic #157 (CL-06): the host-local Lead routes on a local-only daemon, the settings routes, and the
// retired launcher routes. The daemon wires the Lead store (LocalLeadStore here) and feeds it this
// machine's Lead rows (buildLeadRecords over the managed sessions) plus each Lead's latest handoff.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// A local-only daemon (no cloud.json, no relay env) on a temp FOREMAN_HOME. No provider runs.
async function daemon(t, prepare = () => {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-leads-api-')));
  prepare(home);
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/main.ts'], {
    env: { ...process.env, FOREMAN_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude'), FOREMAN_PORT: String(port), FOREMAN_PM_DISABLED: '1', FOREMAN_CLAUDE_BIN: process.execPath, FOREMAN_RELAY_URL: '', FOREMAN_HOST_TOKEN: '', FOREMAN_MACHINE_NAME: 'leads-test-machine' },
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
  for (let attempts = 0; attempts < 100 && !health; attempts++) {
    health = await fetch(`${origin}/api/health`).then((r) => r.json()).catch(() => null);
    if (!health) await delay(100);
  }
  assert.equal(health?.ok, true, output);
  const headers = { authorization: `Bearer ${readFileSync(join(home, 'local-api-token'), 'utf8').trim()}` };
  return { home, origin, headers, output: () => output };
}

test('local-only: GET /api/leads serves this machine\'s Lead rows (with the latest handoff) in local mode; settings are read-only and unavailable', { timeout: 20000 }, async (t) => {
  const uuid = randomUUID(), lead = `fm:${uuid}`;
  const { home: daemonHome, origin, headers, output } = await daemon(t, (home) => {
    // A Lead the previous daemon ran (it is restored as not running), and its handoff on this machine.
    mkdirSync(join(home, 'foreman'));
    mkdirSync(join(home, 'managed'), { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    writeFileSync(join(home, 'managed', `${uuid}.json`), JSON.stringify({
      version: 1,
      creation: { id: randomUUID(), provider: 'claude', name: 'lead-triage', cwd: join(home, 'foreman'), text: 'Lead the triage', model: 'opus[1m]', effort: 'medium', permission_mode: 'bypass' },
      session: { session_key: lead, session_id: 'native-1', provider: 'claude', name: 'lead-triage', cwd: join(home, 'foreman'), model: 'opus[1m]', state: 'idle', reason: null, kind: 'sdk', entrypoint: 'foreman',
        pid: null, alive: true, tracked: true, current_tool: null, active_subagents: 0, last_message: null, last_error: null, started_at: now, updated_at: now, ended_at: null, end_reason: null,
        permission_mode: 'bypass', bg_id: null, bg_state: null, bg_waiting_for: null, host: 'x', transcript_path: null, managed: true, capabilities: { message: false, interrupt: false, approvals: false },
        role: 'lead', launched_by: 'coordinator', workstream: 'triage', effort: 'medium', bypass_grant: 'standing:coordinator/*', policy_reason: 'standing_grant' },
      history: [], receipts: [],
    }), { mode: 0o600 });
    mkdirSync(join(home, 'leads'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'leads', `${uuid}.jsonl`), JSON.stringify({ v: 1, lead, seq: 4, at: now, kind: 'checkpoint', project: 'foreman', workstream: 'triage', goal: 'Triage the open bugs',
      status: 'blocked', summary: 'Waiting on review of PR 12', decisions: [], open_questions: [], next_steps: [], links: [], workers: [] }) + '\n', { mode: 0o600 });
  });

  assert.equal((await fetch(`${origin}/api/leads`)).status, 401, '/api/leads stays behind local auth');
  let body;
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${origin}/api/leads`, { headers });
    assert.equal(res.status, 200);
    body = await res.json();
    if (body.leads.length && body.leads[0].last_handoff) break;
    await delay(100);
  }
  assert.equal(body.mode, 'local');
  assert.equal(body.leads.length, 1, JSON.stringify(body));
  const entry = body.leads[0];
  assert.equal(entry.lead, lead); assert.equal(entry.name, 'lead-triage'); assert.equal(entry.project, 'foreman'); assert.equal(entry.workstream, 'triage');
  assert.equal(entry.machine_name, 'leads-test-machine'); assert.equal(entry.machine_online, true);
  assert.equal(entry.state, 'dead', 'a restart ends the Lead (#170): nothing respawns it');
  assert.equal(entry.end_reason, 'restarted'); assert.equal(entry.alive, false); assert.equal(entry.ended, true);
  assert.equal(entry.goal, 'Triage the open bugs');
  assert.deepEqual([entry.last_handoff.seq, entry.last_handoff.status, entry.last_handoff.summary], [4, 'blocked', 'Waiting on review of PR 12']);
  assert.ok(!JSON.stringify(entry).includes(daemonHome) && !/cwd|transcript/.test(JSON.stringify(entry)), 'no filesystem path in a registry row');

  const settings = await fetch(`${origin}/api/settings`, { headers });
  assert.equal(settings.status, 503);
  assert.match((await settings.json()).error, /local-only mode has no developer settings; agent launches use Auto/);
  const post = await fetch(`${origin}/api/settings`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'bypass_ask', value: false }) });
  assert.equal(post.status, 400);
  assert.deepEqual(await post.json(), { error: 'Change settings from the hosted app' });
  assert.doesNotMatch(output(), /Lead store error/);
});

test('the launcher routes are gone: /api/launch, /api/launch/propose and /api/launch/cancel are not served', { timeout: 20000 }, async (t) => {
  const { origin, headers } = await daemon(t);
  const propose = await fetch(`${origin}/api/launch/propose`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), brief: 'Fix sign-in' }) });
  assert.equal(propose.status, 404);
  assert.equal((await fetch(`${origin}/api/launch?id=${randomUUID()}`, { headers })).status, 404);
  const cancel = await fetch(`${origin}/api/launch/cancel`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ id: randomUUID() }) });
  assert.equal(cancel.status, 404);
  // The Lead registry answers, empty, on a fresh machine.
  const leads = await fetch(`${origin}/api/leads`, { headers });
  assert.equal(leads.status, 200);
  assert.deepEqual(await leads.json(), { leads: [], mode: 'local' });
});
