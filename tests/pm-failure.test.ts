import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const home = mkdtempSync(join(tmpdir(), 'foreman-pm-failure-'));
process.env.FOREMAN_HOME = home;
const { ProjectManager } = await import('../server/pm.ts');
const { ensureDirs, PM_HISTORY_FILE, PM_SESSION_FILE } = await import('../server/paths.ts');
ensureDirs();
test.after(() => rmSync(home, { recursive: true, force: true }));

function fixture(t: any, response: any[], ending: 'wait' | 'throw' | 'eof' = 'wait') {
  writeFileSync(PM_HISTORY_FILE, ''); writeFileSync(PM_SESSION_FILE, '');
  const pm = new ProjectManager({} as any);
  const events: any[] = [], diagnostics: any[] = [], consumed: any[] = [];
  pm.on('event', (event) => events.push(event));
  t.mock.method(console, 'error', (...args: any[]) => diagnostics.push(args));
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => { stop = resolve; });
  (pm as any).queryFactory = ({ prompt }: any) => ({
    close: stop,
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
      const input = await prompt.next(); consumed.push(input.value);
      for (const message of response) yield message;
      if (ending === 'throw') throw new Error('Provider process failed to start');
      if (ending === 'wait') await stopped;
    },
  });
  const running = pm.start();
  t.after(async () => { pm.close(); await running; });
  return { pm, events, diagnostics, consumed, running };
}
async function settle(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Expected provider evidence did not arrive');
}

test('authentication failure without deltas survives history, emits a diagnostic and settles the dispatched turn', async (t) => {
  const f = fixture(t, [
    { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'OAuth session expired and could not be refreshed' }] } },
    { type: 'result', is_error: true, subtype: 'success', result: 'OAuth session expired', total_cost_usd: 0 },
  ]);
  f.pm.send('Which computer?');
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.consumed.length, 1); assert.equal(f.consumed[0].message.content, 'Which computer?');
  assert.equal(f.pm.modelBusy, false);
  assert.match(f.pm.lastError!, /OAuth session expired/);
  assert.match(f.pm.history()[1].text, /OAuth session expired/);
  assert.equal(f.pm.history()[1].error, true);
  assert.equal(f.pm.history().filter((e) => e.role === 'assistant').length, 0);
  assert.equal(f.diagnostics.length, 1);
  assert.match(JSON.stringify(f.diagnostics), /test-session/);
  assert.equal(f.events.find((e) => e.type === 'turn_end').is_error, true);
  assert.match(new ProjectManager({} as any).history()[1].text, /OAuth session expired/);
});

for (const response of [
  { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['Provider unavailable'] },
  { type: 'result', is_error: true, subtype: 'success' },
]) test(`error result is loud without an assistant message: ${response.subtype}`, async (t) => {
  const f = fixture(t, [response]); f.pm.send('Hello');
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.consumed.length, 1);
  assert.equal(f.pm.history()[1].error, true); assert.equal(f.diagnostics.length, 1);
  assert.match(f.pm.lastError!, /Provider/);
});

for (const ending of ['throw', 'eof'] as const) test(`${ending} fails accepted input visibly and rejects further sends`, async (t) => {
  const f = fixture(t, [], ending); f.pm.send('Hello'); await f.running;
  assert.equal(f.consumed.length, 1); assert.equal(f.pm.modelBusy, false);
  assert.match(f.pm.history()[1].text, /Provider/); assert.equal(f.diagnostics.length, 1);
  assert.throws(() => f.pm.send('Another'), /unavailable/);
});

test('synchronous query startup failure is logged and persisted', async (t) => {
  writeFileSync(PM_HISTORY_FILE, '');
  const pm = new ProjectManager({} as any), logs: any[] = [];
  t.mock.method(console, 'error', (...args: any[]) => logs.push(args));
  (pm as any).queryFactory = () => { throw new Error('spawn ENOENT'); };
  await pm.start();
  assert.equal(logs.length, 1); assert.match(pm.history()[0].text, /spawn ENOENT/);
  assert.equal(pm.modelBusy, false);
});

test('nonstreamed assistant text persists and a successful result clears the current error', async (t) => {
  const f = fixture(t, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Actual answer' }] } },
    { type: 'result', is_error: false, subtype: 'success', result: 'Actual answer' },
  ]);
  f.pm.lastError = 'Old failure'; f.pm.send('Hello');
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.consumed.length, 1); assert.equal(f.pm.history()[1].text, 'Actual answer');
  assert.equal(f.pm.lastError, null); assert.equal(f.diagnostics.length, 0);
});

test('streamed and complete assistant messages are not duplicated', async (t) => {
  const f = fixture(t, [
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Answer' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Answer' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Answer' },
  ]);
  f.pm.send('Hello'); await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.pm.history()[1].text, 'Answer');
});
