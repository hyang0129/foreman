// #62: a provider that is alive but silent while it owes input. Only the next explicit send acts:
// every outstanding input is reported uncertain (one entry each), the provider is retired, a fresh
// session starts and only the new input is dispatched. Driven with an injected clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const home = mkdtempSync(join(tmpdir(), 'foreman-pm-hung-'));
process.env.FOREMAN_HOME = home;
test.after(() => rmSync(home, { recursive: true, force: true }));
const { ProjectManager } = await import('../server/pm.ts');
const { LocalPmStore } = await import('../server/pm-store.ts');
const { PM_HUNG_DEFAULT_MS } = await import('../shared/pm-state.ts');

const HUNG = 60_000;
const START = Date.parse('2026-09-24T12:00:00.000Z');
const IDENTITY = { machine_id: '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', name: 'machine-b' };

type Launch = { closed: boolean; consumed: string[]; interrupts: number };
// A provider per launch: launch 0 takes input and never answers (hung, but alive); later launches
// answer each input with a result that echoes its uuid.
function harness(t: any, options: { frameWhileHung?: boolean } = {}) {
  const clock = { now: START };
  const store = new LocalPmStore({ identity: IDENTITY, home: mkdtempSync(join(home, 'store-')), log: () => {} });
  const ends: [string, string][] = [];
  const end = store.endTurn.bind(store);
  store.endTurn = (id: string, outcome: any) => { ends.push([id, outcome]); return end(id, outcome); };
  const pm = new ProjectManager({} as any, { machineName: IDENTITY.name, now: () => clock.now, hungMs: HUNG });
  pm.attach(store, { autoStart: false });
  const events: any[] = [];
  pm.on('event', (e) => events.push(e));
  t.mock.method(console, 'error', () => {});
  const launches: Launch[] = [];
  let poke: (() => void) | null = null;
  (pm as any).queryFactory = ({ prompt }: any) => {
    const launch: Launch = { closed: false, consumed: [], interrupts: 0 };
    const index = launches.push(launch) - 1;
    let close!: () => void; const closed = new Promise<void>((r) => { close = r; });
    return {
      close: () => { launch.closed = true; close(); },
      interrupt: async () => { launch.interrupts++; },
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: `session-${index}`, tools: [] };
        while (true) {
          const input = await Promise.race([prompt.next(), closed.then(() => null)]);
          if (!input || input.done) return;
          launch.consumed.push(input.value.message.content);
          if (index === 0) {
            if (options.frameWhileHung && launch.consumed.length === 1) {
              const poked = await Promise.race([new Promise<boolean>((r) => { poke = () => r(true); }), closed.then(() => false)]);
              if (!poked) return;
              yield { type: 'stream_event', event: { type: 'message_start' } };
            }
            continue; // never answers
          }
          yield { type: 'result', is_error: false, subtype: 'success', result: `answer: ${input.value.message.content}`, user_message_uuids: [input.value.uuid] };
        }
      },
    };
  };
  const running = pm.start();
  t.after(async () => { pm.close(); await running; });
  return { pm, store, clock, ends, events, launches, poke: () => poke?.() };
}
const tick = () => new Promise((r) => setTimeout(r, 10));
async function until(check: () => boolean) { for (let i = 0; i < 200 && !check(); i++) await tick(); assert.ok(check(), 'condition not reached'); }
const hungEntries = (pm: any) => pm.history().filter((e: any) => /could not be confirmed \(the PM stopped responding\)/.test(e.text ?? ''));

test('before the threshold (threshold − 1 ms) a send queues behind the silent provider', async (t) => {
  const h = harness(t);
  await h.pm.send('A'); await until(() => h.launches[0]!.consumed.length === 1);
  h.clock.now = START + HUNG - 1;
  await h.pm.send('B');
  await tick();
  assert.equal(h.launches.length, 1);
  assert.equal(h.launches[0]!.closed, false);
  assert.equal(hungEntries(h.pm).length, 0);
  assert.equal(h.pm.outstandingTurnIds().length, 2);
  assert.deepEqual(h.ends, []);
  assert.equal(h.pm.modelBusy, true);
});

test('at the threshold the next send marks every outstanding input uncertain, restarts, and dispatches only the new input', async (t) => {
  const h = harness(t);
  await h.pm.send('A'); await until(() => h.launches[0]!.consumed.length === 1);
  h.clock.now = START + 10_000;
  await h.pm.send('B'); // queued: still before the threshold measured from A's dispatch
  await until(() => h.launches[0]!.consumed.length === 2);
  const owed = h.pm.outstandingTurnIds();
  h.clock.now = START + HUNG; // ≥ threshold since A was dispatched and no provider frame since
  await h.pm.send('C');
  await until(() => h.pm.history().some((e) => e.text === 'answer: C'));
  const entries = hungEntries(h.pm);
  assert.equal(entries.length, 2, 'one entry per outstanding input');
  assert.match(entries[0].text, /^Your message sent at 2026-09-24 12:00 UTC to the PM on machine-b could not be confirmed \(the PM stopped responding\)\. It was not replayed\.$/);
  assert.match(entries[1].text, /sent at 2026-09-24 12:00 UTC/);
  assert.ok(entries.every((e: any) => e.error === true));
  assert.deepEqual(h.ends.slice(0, 2), [[owed[0], 'uncertain'], [owed[1], 'uncertain']]);
  assert.equal(h.launches.length, 2);
  assert.equal(h.launches[0]!.closed, true, 'the hung provider is retired');
  assert.deepEqual(h.launches[1]!.consumed, ['C'], 'only the new input is dispatched; nothing is replayed');
  assert.deepEqual(h.store.openTurnIds(), []);
  // The conversation is kept, with the hung entries, the fresh-session notice, then the new exchange.
  const texts = h.pm.history().map((e) => e.text);
  assert.deepEqual(texts.slice(0, 2), ['A', 'B']);
  assert.ok(texts.indexOf('Started a fresh PM session. It answers from memory, not from the messages above.') < texts.indexOf('C'));
  assert.equal(h.pm.lastError, null, 'the fresh session answered');
});

test('without a send nothing happens, however long the provider is silent', async (t) => {
  const h = harness(t);
  await h.pm.send('A'); await until(() => h.launches[0]!.consumed.length === 1);
  h.clock.now = START + HUNG * 100;
  await tick(); await tick();
  assert.equal(h.launches.length, 1);
  assert.equal(h.launches[0]!.closed, false);
  assert.equal(hungEntries(h.pm).length, 0);
  assert.equal(h.pm.outstandingTurnIds().length, 1);
  assert.deepEqual(h.ends, []);
  assert.equal(h.pm.lastError, null);
  // Stop keeps working on the silent provider.
  await h.pm.interrupt();
  assert.equal(h.launches[0]!.interrupts, 1);
});

test('a provider frame restarts the silence window', async (t) => {
  const h = harness(t, { frameWhileHung: true });
  await h.pm.send('A'); await until(() => h.launches[0]!.consumed.length === 1);
  h.clock.now = START + HUNG - 5;
  h.poke(); // a frame arrives just before the threshold
  await until(() => h.pm.busy);
  h.clock.now = START + HUNG + 10; // past the threshold from A's dispatch, but not from the frame
  await h.pm.send('B');
  await tick();
  assert.equal(h.launches.length, 1);
  assert.equal(hungEntries(h.pm).length, 0);
  h.clock.now = START + 2 * HUNG; // silent for ≥ threshold since that frame
  await h.pm.send('C');
  await until(() => h.pm.history().some((e) => e.text === 'answer: C'));
  assert.equal(hungEntries(h.pm).length, 2);
  assert.deepEqual(h.launches[1]!.consumed, ['C']);
});

test('the threshold defaults to PM_HUNG_DEFAULT_MS and FOREMAN_PM_HUNG_MS overrides it', () => {
  const previous = process.env.FOREMAN_PM_HUNG_MS;
  try {
    delete process.env.FOREMAN_PM_HUNG_MS;
    assert.equal((new ProjectManager({} as any) as any).hungMs, PM_HUNG_DEFAULT_MS);
    assert.equal(PM_HUNG_DEFAULT_MS, 300_000);
    process.env.FOREMAN_PM_HUNG_MS = '60000';
    assert.equal((new ProjectManager({} as any) as any).hungMs, 60_000);
    process.env.FOREMAN_PM_HUNG_MS = 'nonsense';
    assert.equal((new ProjectManager({} as any) as any).hungMs, PM_HUNG_DEFAULT_MS);
  } finally { if (previous === undefined) delete process.env.FOREMAN_PM_HUNG_MS; else process.env.FOREMAN_PM_HUNG_MS = previous; }
});
