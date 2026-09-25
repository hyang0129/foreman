import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// server/paths.ts reads FOREMAN_HOME at import: pin it to a temp dir before loading any server
// module, so no test here can touch the developer's real ~/.foreman.
const foremanHome = mkdtempSync(join(tmpdir(), 'foreman-models-home-'));
process.env.FOREMAN_HOME = foremanHome;
test.after(() => rmSync(foremanHome, { recursive: true, force: true }));
const { ModelCatalog, normalizeModel } = await import('../server/models.ts');
const { ProjectManager } = await import('../server/pm.ts');
const { LocalPmStore } = await import('../server/pm-store.ts');

test('model identifiers preserve provider aliases and reject malformed or oversized input', () => {
  for (const value of ['opus[1m]', 'sonnet', 'gpt-6-astra', 'vendor/model:1']) assert.equal(normalizeModel(value), value);
  for (const value of ['', null, undefined]) assert.equal(normalizeModel(value), undefined);
  for (const value of [' --model x', 'a\nb', 'a'.repeat(201), {}, 4]) assert.throws(() => normalizeModel(value), /Invalid model/);
});

test('catalog shares concurrent discovery, separates providers and retries failures', async () => {
  let calls = 0;
  const catalog = new ModelCatalog(async (provider) => {
    calls++;
    if (calls === 1) throw new Error('temporarily unavailable');
    return [{ value: provider + '-model', displayName: provider }];
  });
  await assert.rejects(catalog.list('other'), /Unsupported/);
  await assert.rejects(catalog.list('claude'), /temporarily/);
  const [first, second] = await Promise.all([catalog.list('claude'), catalog.list('claude')]);
  assert.deepEqual(first, second); assert.equal(calls, 2);
  assert.equal((await catalog.list('codex'))[0].value, 'codex-model'); assert.equal(calls, 3);
});

test('PM model changes are durable in the PM state store, isolated from pending turns, and preserve selection on provider failure', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'foreman-model-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const identity = { machine_id: '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', name: 'test-mac' };
  const store = new LocalPmStore({ identity, home, log: () => {} });
  const saved = async () => (await new LocalPmStore({ identity, home, log: () => {} }).read()).model;
  const pm = new ProjectManager({} as any);
  pm.attach(store, { autoStart: false });
  const internal = pm as any;
  const changes: (string | undefined)[] = [];
  internal.running = true;
  internal.q = { setModel: async (model: string | undefined) => { changes.push(model); if (model === 'unavailable') throw new Error('Unavailable model'); } };
  await pm.setModel('haiku');
  assert.equal(await saved(), 'haiku');
  internal.outstanding = [{ turnId: 'pending', acceptedAt: new Date().toISOString(), dispatchedAt: Date.now(), taken: true }];
  await assert.rejects(pm.setModel('sonnet'), /finish/);
  internal.outstanding = [];
  await assert.rejects(pm.setModel('unavailable'), /Unavailable/);
  assert.equal(pm.model, 'haiku');
  assert.equal(await saved(), 'haiku');
  let finish!: () => void;
  internal.q.setModel = () => new Promise<void>((resolve) => { finish = resolve; });
  const pending = pm.setModel(null);
  await assert.rejects(pm.send('A racing message'), /in progress/);
  await assert.rejects(pm.setModel('sonnet'), /finish/);
  finish(); await pending;
  assert.equal(pm.model, undefined);
  assert.equal(await saved(), null);
  pm.close();
});
