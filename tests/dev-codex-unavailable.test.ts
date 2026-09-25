// A daemon whose isolated CODEX_HOME has no login (DEV without the optional
// Codex login, #69) must report Codex as unavailable, not start a session that
// only fails on its first turn. The app-server here is a disposable stand-in
// that answers like the real `codex app-server` does for a signed-out home:
// it initializes, lists models and starts threads, and account/read returns
// { account: null, requiresOpenaiAuth: true }.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'foreman-dev-codex-unavailable-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
// Model discovery runs the app-server with cwd FOREMAN_HOME: keep it in the temp dir.
process.env.FOREMAN_HOME = dir;
const fakeBin = join(dir, 'fake-codex');
writeFileSync(fakeBin, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const mode = process.env.FAKE_CODEX_MODE, log = process.env.FAKE_CODEX_LOG;
let buffer = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk; let i;
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!line) continue;
    const msg = JSON.parse(line); if (msg.id === undefined) continue;
    appendFileSync(log, msg.method + '\\n');
    const reply = (result) => send({ id: msg.id, result });
    if (msg.method === 'initialize') reply({});
    else if (msg.method === 'account/read') {
      if (mode === 'signed-out') reply({ account: null, requiresOpenaiAuth: true });
      else if (mode === 'signed-in') reply({ account: { type: 'chatgpt', email: 'dev@example.com', planType: 'plus' }, requiresOpenaiAuth: true });
      else send({ id: msg.id, error: { code: -32601, message: 'method not found' } });
    }
    else if (msg.method === 'model/list') reply({ data: [{ model: 'gpt-fixture', displayName: 'Fixture' }], nextCursor: null });
    else if (msg.method === 'thread/start') reply({ thread: { id: 'thread-1', createdAt: 1, updatedAt: 1, status: { type: 'idle' } },
      approvalPolicy: msg.params.approvalPolicy, sandbox: { type: msg.params.sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'workspaceWrite', networkAccess: false } });
    else reply({});
  }
});
`);
chmodSync(fakeBin, 0o755);

const { CodexControl } = await import('../server/codex-control.ts');
const { SessionService } = await import('../server/session-service.ts');
const { ModelCatalog } = await import('../server/models.ts');

let run = 0;
function provider(mode: string) {
  const log = join(dir, `calls-${++run}.log`);
  const env = { ...process.env, FAKE_CODEX_MODE: mode, FAKE_CODEX_LOG: log };
  return { log, env, calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
}
// Each test spawns real stub processes (via the process supervisor), which can
// take seconds on a loaded machine. Budgets derive from the test's own timeout
// instead of fixed ones: every wait still fails, but only once the test's
// deadline has passed. Codex requests get a smaller share than the polling wait
// (the remaining budget minus twice the margin, #106), so a stuck request fails
// with its own Codex error while a wait is still polling, and the wait's failure
// reports that error instead of only "Timed out waiting for ...".
const TEST_TIMEOUT = 30_000;
const MARGIN = 3_000;
function budget(t: { signal: AbortSignal }) {
  const deadline = Date.now() + TEST_TIMEOUT;
  return {
    codexTimeoutMs: () => Math.max(1, deadline - Date.now() - 2 * MARGIN),
    async until(check: () => boolean, what: string, detail?: () => string | null | undefined) {
      while (!check()) {
        if (t.signal.aborted || Date.now() > deadline - MARGIN) assert.fail(`Timed out waiting for ${what}${detail?.() ? ` (${detail!()})` : ''}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

test('requireSignedIn refuses only an explicit signed-out answer', { timeout: TEST_TIMEOUT }, async (t) => {
  const b = budget(t);
  for (const [mode, refused] of [['signed-out', true], ['signed-in', false], ['no-account-method', false]] as const) {
    const p = provider(mode);
    const control = new CodexControl({ bin: fakeBin, cwd: dir, env: p.env, timeoutMs: b.codexTimeoutMs() });
    t.after(() => control.close());
    await control.connect();
    if (refused) await assert.rejects(control.requireSignedIn(), /Codex is not signed in on this host, so Codex sessions are unavailable/);
    else await control.requireSignedIn();
    assert.deepEqual(p.calls(), ['initialize', 'account/read']);
    await control.close();
  }
});

test('launching a Codex session on a signed-out host fails clearly before any thread starts', { timeout: TEST_TIMEOUT }, async (t) => {
  const b = budget(t);
  const home = mkdtempSync(join(dir, 'service-'));
  const p = provider('signed-out');
  const service = new SessionService({ home, codexFactory: (options) => new CodexControl({ ...options, bin: fakeBin, env: p.env, timeoutMs: b.codexTimeoutMs() }) });
  t.after(() => service.close());
  const row = await service.create({ id: 'codex-1', provider: 'codex', cwd: home, name: 'Codex', text: 'Hello' });
  await b.until(() => service.detail(row.session_key).session.state === 'unknown', 'launch failure', () => service.detail(row.session_key).session.last_error);
  const { session, receipts } = service.detail(row.session_key);
  assert.equal(session.alive, false);
  assert.match(session.last_error ?? '', /^Could not start provider: Error: Codex is not signed in on this host, so Codex sessions are unavailable/);
  assert.equal(receipts[0].status, 'failed');
  assert.throws(() => service.send(row.session_key, 'More', 'more-1'), /Codex is not signed in/);
  // The reason is neutral: no DEV-specific path or command leaks into production.
  assert.doesNotMatch(session.last_error ?? '', /foreman-dev|DEV/);
  assert.match(session.last_error ?? '', /codex login` using the CODEX_HOME this Foreman uses/);
  // The account check happened, and no thread or turn was ever requested.
  assert.deepEqual(p.calls(), ['initialize', 'account/read']);
});

test('launching a Codex session on a signed-in host is unchanged', { timeout: TEST_TIMEOUT }, async (t) => {
  const b = budget(t);
  const home = mkdtempSync(join(dir, 'service-'));
  const p = provider('signed-in');
  const service = new SessionService({ home, codexFactory: (options) => new CodexControl({ ...options, bin: fakeBin, env: p.env, timeoutMs: b.codexTimeoutMs() }) });
  t.after(() => service.close());
  const row = await service.create({ id: 'codex-2', provider: 'codex', cwd: home, name: 'Codex', text: 'Hello' });
  await b.until(() => p.calls().includes('turn/start'), 'first turn dispatch', () => service.detail(row.session_key).session.last_error);
  const { session } = service.detail(row.session_key);
  assert.equal(session.session_id, 'thread-1'); assert.equal(session.last_error, null);
  assert.deepEqual(p.calls(), ['initialize', 'account/read', 'thread/start', 'turn/start']);
});

// Discovery uses the production 15s Codex timeout (server/models.ts), twice in sequence.
test('the Codex model catalog is unavailable on a signed-out host and retries after sign-in', { timeout: 2 * 15_000 + TEST_TIMEOUT }, async () => {
  const catalog = new ModelCatalog();
  const out = provider('signed-out');
  process.env.FOREMAN_CODEX_BIN = fakeBin;
  Object.assign(process.env, { FAKE_CODEX_MODE: 'signed-out', FAKE_CODEX_LOG: out.log });
  try {
    await assert.rejects(catalog.list('codex'), /Codex is not signed in on this host/);
    assert.deepEqual(out.calls(), ['initialize', 'account/read']);
    // A failure is not cached: once signed in, the same catalog lists models.
    const signedIn = provider('signed-in');
    Object.assign(process.env, { FAKE_CODEX_MODE: 'signed-in', FAKE_CODEX_LOG: signedIn.log });
    assert.deepEqual(await catalog.list('codex'), [{ value: 'gpt-fixture', displayName: 'Fixture', description: undefined }]);
  } finally { for (const key of ['FOREMAN_CODEX_BIN', 'FAKE_CODEX_MODE', 'FAKE_CODEX_LOG']) delete process.env[key]; }
});
