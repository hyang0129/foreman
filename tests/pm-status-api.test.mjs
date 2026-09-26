import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { allowedRequest } from '../shared/relay.ts';

test('relay allowlist admits the PM status summary query', () => {
  assert.equal(allowedRequest('GET', '/api/pm/history?summary=1'), true);
});

// A local-only daemon (no cloud.json, no relay env) on a temp FOREMAN_HOME. FOREMAN_PM_DISABLED=1
// only defers the PM provider launch to the first POST /api/pm/message (server/main.ts). Since
// #146 that first send launches the provider BEFORE it records the turn (#115), so a send can
// start the CLI even when recording then fails. FOREMAN_CLAUDE_BIN defaults to node itself, which
// rejects the CLI's flags and exits, so only tests that never send may rely on it (#191).
async function daemon(t, prepare = () => {}, env = {}) {
  const home = mkdtempSync(join(tmpdir(), 'foreman-pm-status-'));
  prepare(home);
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/main.ts'], {
    env:{ ...process.env, FOREMAN_HOME:home, CLAUDE_CONFIG_DIR:join(home, 'claude'), FOREMAN_PORT:String(port), FOREMAN_PM_DISABLED:'1', FOREMAN_CLAUDE_BIN:process.execPath, FOREMAN_RELAY_URL:'', FOREMAN_HOST_TOKEN:'', FOREMAN_MACHINE_NAME:'status-test-mac', ...env },
    stdio:['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.resume(); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([exited, delay(5000, undefined, { ref:false })]); }
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(home, { recursive:true, force:true });
  });
  const origin = `http://127.0.0.1:${port}`;
  let health;
  for (let attempts = 0; attempts < 80; attempts++) {
    health = await fetch(`${origin}/api/health`).then((r) => r.json()).catch(() => null);
    if (health) break;
    await delay(100);
  }
  assert.equal(health?.ok, true);
  const headers = { authorization:`Bearer ${readFileSync(join(home, 'local-api-token'), 'utf8').trim()}` };
  return { home, origin, headers, stderr: () => stderr };
}

test('GET /api/pm/history?summary=1 returns only error and busy; the plain request keeps history', { timeout:15000 }, async (t) => {
  const { origin, headers } = await daemon(t);

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
});

test('local-only daemon: store-backed memory, a single-machine PM host, an empty conversation, and no transcript or seeded files', { timeout:15000 }, async (t) => {
  const { home, origin, headers } = await daemon(t, (dir) => {
    mkdirSync(join(dir, 'memory'), { recursive:true });
    writeFileSync(join(dir, 'memory', 'PROJECTS.md'), '# Projects\n\n## zebra-project\nStatus: blocked on review\n');
  });
  const history = await fetch(`${origin}/api/pm/history`, { headers }).then((r) => r.json());
  assert.deepEqual(history.history, [], 'a fresh daemon starts with an empty conversation');
  assert.equal(history.error, null);

  const memoryRes = await fetch(`${origin}/api/memory`, { headers });
  assert.equal(memoryRes.status, 200);
  const memory = await memoryRes.json();
  assert.deepEqual(Object.keys(memory).sort(), ['log', 'preferences', 'projects']);
  assert.equal(memory.projects, '# Projects\n\n## zebra-project\nStatus: blocked on review\n', 'imported once into the store');
  assert.equal(memory.log, '');
  assert.equal(memory.preferences, '');

  const hostRes = await fetch(`${origin}/api/pm/host`, { headers });
  assert.equal(hostRes.status, 200);
  const host = await hostRes.json();
  assert.equal(host.mode, 'local');
  assert.equal(host.machines.length, 1);
  assert.equal(host.active.name, 'status-test-mac');
  assert.equal(host.active.online, true);
  assert.equal(host.active.machine_id, host.machines[0].machine_id);
  assert.equal(host.machines[0].active, true);
  assert.deepEqual(Object.keys(host).sort(), ['active', 'machines', 'mode', 'open_turns', 'uncertain_turns']);
  assert.equal(host.open_turns, 0); assert.equal(host.uncertain_turns, 0);
  const move = await fetch(`${origin}/api/pm/host`, { method:'POST', headers:{ ...headers, 'content-type':'application/json' }, body:JSON.stringify({ machine_id:host.active.machine_id, expected_epoch:1 }) });
  assert.equal(move.status, 400);
  assert.deepEqual(await move.json(), { error:'Reassignment needs the cloud relay' });

  // No seeding, no transcript, no session file: pm/ holds only the store's state.json.
  assert.equal(existsSync(join(home, 'memory', 'LOG.md')), false, 'LOG.md is no longer seeded');
  assert.deepEqual(readdirSync(join(home, 'pm')), ['state.json']);
  assert.ok(existsSync(join(home, 'machine.json')));
  assert.equal(statSync(join(home, 'machine.json')).mode & 0o777, 0o600);
  assert.ok(existsSync(join(home, 'memory', '.imported.json')));
});

// A stand-in Claude CLI that stays up and records every stdin line, so "nothing was dispatched" is
// measured at the provider's own input instead of inferred from a history that a dying CLI also
// writes to (#191). It answers control requests like the real CLI and never produces a turn.
// Any other invocation (fleet discovery's `agents --json`, `--version`) fails like the old node stand-in.
function recordingCli(dir) {
  const path = join(dir, 'recording-claude.mjs'), log = join(dir, 'cli-stdin.jsonl');
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (!process.argv.includes('stream-json')) process.exit(1);
const record = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + '\\n');
record({ launched: process.pid });
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  record({ line });
  const m = JSON.parse(line);
  if (m.type === 'control_request') process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }) + '\\n');
}
`, { mode:0o755 });
  const entries = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { path, entries, lines: () => entries().filter((e) => 'line' in e).map((e) => JSON.parse(e.line)) };
}

test('POST /api/pm/message answers 503 with the cause and dispatches nothing when the turn cannot be recorded', { timeout:15000 }, async (t) => {
  const cliDir = mkdtempSync(join(tmpdir(), 'foreman-pm-status-cli-'));
  t.after(() => rmSync(cliDir, { recursive:true, force:true }));
  const cli = recordingCli(cliDir);
  const { home, origin, headers } = await daemon(t, undefined, { FOREMAN_CLAUDE_BIN:cli.path });
  const pmDir = join(home, 'pm');
  chmodSync(pmDir, 0o500); // pm/state.json can no longer be written
  t.after(() => { try { chmodSync(pmDir, 0o700); } catch { /* already removed */ } });
  const res = await fetch(`${origin}/api/pm/message`, { method:'POST', headers:{ ...headers, 'content-type':'application/json' }, body:JSON.stringify({ text:'not recorded' }) });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /could not record your message, so it was not sent: Could not save pm\/state\.json/);
  chmodSync(pmDir, 0o700);
  // The send launched the CLI before recording failed (#115). Wait for the real event that shows
  // its stdin is being recorded (the SDK's initialize request reached it) rather than for a fixed
  // time, then check that nothing but control requests ever reached it.
  while (!cli.lines().some((m) => m.type === 'control_request' && m.request?.subtype === 'initialize')) {
    if (t.signal.aborted) throw new Error('the CLI never received initialize');
    await delay(20);
  }
  const history = await fetch(`${origin}/api/pm/history`, { headers }).then((r) => r.json());
  assert.deepEqual(cli.lines().filter((m) => m.type !== 'control_request'), [], 'no input reached the CLI');
  assert.equal(cli.entries().filter((e) => 'launched' in e).length, 1, 'the send launched the CLI once');
  assert.deepEqual(history.history, [], 'nothing was dispatched, recorded or failed');
  assert.equal(history.busy, false);
  const host = await fetch(`${origin}/api/pm/host`, { headers }).then((r) => r.json());
  assert.equal(host.open_turns, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(pmDir, 'state.json'), 'utf8')).turns, [], 'no turn is open');
  assert.equal((await fetch(`${origin}/api/pm/message`, { method:'POST', headers:{ ...headers, 'content-type':'application/json' }, body:'{}' })).status, 400, 'a missing text is still a 400');
});

test('an invalid machine.json is logged and the daemon runs without a PM, whose error names the cause', { timeout:15000 }, async (t) => {
  const { home, origin, headers, stderr } = await daemon(t, (dir) => { writeFileSync(join(dir, 'machine.json'), 'not json', { mode:0o600 }); });
  const history = await fetch(`${origin}/api/pm/history?summary=1`, { headers }).then((r) => r.json());
  assert.match(history.error, /machine\.json is invalid \(Invalid machine\.json\)/);
  const res = await fetch(`${origin}/api/pm/message`, { method:'POST', headers:{ ...headers, 'content-type':'application/json' }, body:JSON.stringify({ text:'hello' }) });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /machine\.json is invalid/);
  assert.equal((await fetch(`${origin}/api/memory`, { headers })).status, 503);
  assert.equal(readFileSync(join(home, 'machine.json'), 'utf8'), 'not json', 'the bad file is never replaced');
  assert.equal((await fetch(`${origin}/api/sessions`, { headers })).status, 200, 'the rest of the daemon keeps working');
  assert.match(stderr(), /machine identity error: Invalid machine\.json/);
});

// Never two PMs: a present-but-invalid cloud.json means a relay IS configured (and holds the PM),
// so this machine runs no PM at all, rather than a local one built from its own files.
test('an invalid cloud.json runs no PM: sends answer 503 naming the cause, and no local store is created', { timeout:15000 }, async (t) => {
  const { home, origin, headers, stderr } = await daemon(t, (dir) => {
    writeFileSync(join(dir, 'cloud.json'), 'not json', { mode:0o600 });
    mkdirSync(join(dir, 'memory'), { recursive:true });
    writeFileSync(join(dir, 'memory', 'PROJECTS.md'), '# Projects\n\n## zebra-project\n');
  });
  const cause = /cloud\.json is invalid \(Invalid cloud\.json\); the Coordinator is unavailable on this machine/;
  const history = await fetch(`${origin}/api/pm/history?summary=1`, { headers }).then((r) => r.json());
  assert.match(history.error, cause);
  const res = await fetch(`${origin}/api/pm/message`, { method:'POST', headers:{ ...headers, 'content-type':'application/json' }, body:JSON.stringify({ text:'hello' }) });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, cause);
  assert.equal((await fetch(`${origin}/api/memory`, { headers })).status, 503, 'no store, so no memory');
  assert.equal(existsSync(join(home, 'pm', 'state.json')), false, 'no local PM store was created');
  assert.equal(existsSync(join(home, 'memory', '.imported.json')), false, 'nothing was imported locally');
  assert.equal(readFileSync(join(home, 'cloud.json'), 'utf8'), 'not json', 'the bad file is left alone');
  assert.equal((await fetch(`${origin}/api/sessions`, { headers })).status, 200, 'the rest of the daemon keeps working');
  assert.match(stderr(), /cloud bridge configuration error: Invalid cloud\.json/);
});
