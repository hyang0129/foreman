import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelCatalog, normalizeModel } from '../server/models.ts';
import { ProjectManager } from '../server/pm.ts';

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

test('PM model changes are durable, isolated from pending turns, and preserve selection on provider failure', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'foreman-model-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'settings.json');
  const pm = new ProjectManager({} as any, undefined, path);
  const internal = pm as any;
  const changes: (string | undefined)[] = [];
  internal.running = true;
  internal.q = { setModel: async (model: string | undefined) => { changes.push(model); if (model === 'unavailable') throw new Error('Unavailable model'); } };
  await pm.setModel('haiku');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).model, 'haiku');
  assert.equal(new ProjectManager({} as any, undefined, path).model, 'haiku');
  internal.pendingTurns = 1;
  await assert.rejects(pm.setModel('sonnet'), /finish/);
  internal.pendingTurns = 0;
  await assert.rejects(pm.setModel('unavailable'), /Unavailable/);
  assert.equal(pm.model, 'haiku');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).model, 'haiku');
  let finish!: () => void;
  internal.q.setModel = () => new Promise<void>((resolve) => { finish = resolve; });
  const pending = pm.setModel(null);
  assert.throws(() => pm.send('A racing message'), /in progress/);
  await assert.rejects(pm.setModel('sonnet'), /finish/);
  finish(); await pending;
  assert.equal(pm.model, undefined);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).model, null);
  assert.equal(new ProjectManager({} as any, undefined, path).model, undefined);
});
