import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// server/paths.ts reads FOREMAN_HOME at import: pin it to a temp dir before loading any server module.
const home = mkdtempSync(join(tmpdir(), 'foreman-pm-failure-'));
process.env.FOREMAN_HOME = home;
delete process.env.FOREMAN_PM_MODEL;
const { ProjectManager } = await import('../server/pm.ts');
const { LocalPmStore } = await import('../server/pm-store.ts');
const { ensureDirs } = await import('../server/paths.ts');
ensureDirs();
test.after(() => rmSync(home, { recursive: true, force: true }));

const IDENTITY = { machine_id: '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', name: 'test-mac' };
// Every PM runs against its own real LocalPmStore (pm/state.json in its own temp home).
function storeHome() { const dir = mkdtempSync(join(home, 'store-')); mkdirSync(join(dir, 'pm'), { recursive: true }); return dir; }
function localStore(dir = storeHome()) { return new LocalPmStore({ identity: IDENTITY, home: dir, log: () => {} }); }
function newPm(store: any = localStore(), options: any = {}) {
  const pm = new ProjectManager({} as any, { machineName: IDENTITY.name, ...options });
  pm.attach(store, { autoStart: false });
  return pm;
}
// The installed CLI echoes each input's uuid on the result of the turn that consumed it
// (`user_message_uuids`). The fakes do the same for every result that does not set it itself.
function withEcho(messages: any[], uuids: string[]) {
  return messages.map((m) => m?.type === 'result' && !('user_message_uuids' in m) && !('user_message_uuid' in m) ? { ...m, user_message_uuids: uuids } : m);
}

function fixture(t: any, response: any[], ending: 'wait' | 'throw' | 'eof' = 'wait') {
  const pm = newPm();
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
      for (const message of withEcho(response, [input.value.uuid])) yield message;
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

test('authentication failure without deltas is recorded, emits a diagnostic and settles the dispatched turn', async (t) => {
  const f = fixture(t, [
    { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'OAuth session expired and could not be refreshed' }] } },
    { type: 'result', is_error: true, subtype: 'success', result: 'OAuth session expired', total_cost_usd: 0 },
  ]);
  await f.pm.send('Which computer?');
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.consumed.length, 1); assert.equal(f.consumed[0].message.content, 'Which computer?');
  assert.equal(f.pm.modelBusy, false);
  assert.match(f.pm.lastError!, /OAuth session expired/);
  assert.match(f.pm.history()[1]!.text!, /OAuth session expired/);
  assert.equal(f.pm.history()[1]!.error, true);
  assert.equal(f.pm.history().filter((e) => e.role === 'assistant').length, 0);
  assert.equal(f.diagnostics.length, 1);
  assert.match(JSON.stringify(f.diagnostics), /test-session/);
  assert.equal(f.events.find((e) => e.type === 'turn_end').is_error, true);
});

for (const response of [
  { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['Provider unavailable'] },
  { type: 'result', is_error: true, subtype: 'success' },
]) test(`error result is loud without an assistant message: ${response.subtype}`, async (t) => {
  const f = fixture(t, [response]); await f.pm.send('Hello');
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.consumed.length, 1);
  assert.equal(f.pm.history()[1]!.error, true); assert.equal(f.diagnostics.length, 1);
  assert.match(f.pm.lastError!, /Provider/);
});

for (const ending of ['throw', 'eof'] as const) test(`${ending} fails accepted input visibly and rejects sends after close`, async (t) => {
  const f = fixture(t, [], ending); await f.pm.send('Hello'); await f.running;
  assert.equal(f.consumed.length, 1); assert.equal(f.pm.modelBusy, false);
  assert.match(f.pm.history()[1]!.text!, /Provider/); assert.equal(f.diagnostics.length, 1);
  f.pm.close();
  await assert.rejects(f.pm.send('Another'), /unavailable/);
});

test('synchronous query startup failure is logged and reported', async (t) => {
  const pm = newPm(), logs: any[] = [];
  t.mock.method(console, 'error', (...args: any[]) => logs.push(args));
  (pm as any).queryFactory = () => { throw new Error('spawn ENOENT'); };
  await pm.start();
  assert.equal(logs.length, 1); assert.match(pm.history()[0]!.text!, /spawn ENOENT/);
  assert.equal(pm.modelBusy, false);
});

test('nonstreamed assistant text is recorded and a successful result clears the current error', async (t) => {
  const f = fixture(t, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Actual answer' }] } },
    { type: 'result', is_error: false, subtype: 'success', result: 'Actual answer' },
  ]);
  f.pm.lastError = 'Old failure'; await f.pm.send('Hello');
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.consumed.length, 1); assert.equal(f.pm.history()[1]!.text, 'Actual answer');
  assert.equal(f.pm.lastError, null); assert.equal(f.diagnostics.length, 0);
});

test('streamed and complete assistant messages are not duplicated', async (t) => {
  const f = fixture(t, [
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Answer' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Answer' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Answer' },
  ]);
  await f.pm.send('Hello'); await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.pm.history()[1]!.text, 'Answer');
});

// A scripted provider: every launch runs `script` with its own close/interrupt signals, and the
// harness records each launch's options plus exactly which inputs the provider consumed.
type Launch = { resume?: string; hasResume: boolean; closed: boolean; interrupts: number; consumed: string[]; options: any };
type Ctx = { launch: number; next: () => Promise<string | undefined>; closed: Promise<void>; interrupted: Promise<void> };
function scripted(t: any, script: (ctx: Ctx) => AsyncGenerator<any>, store: any = localStore(), pmOptions: any = {}) {
  const pm = newPm(store, pmOptions);
  const events: any[] = [], diagnostics: any[] = [], consumed: string[] = [], launches: Launch[] = [];
  pm.on('event', (event) => events.push(event));
  t.mock.method(console, 'error', (...args: any[]) => diagnostics.push(args));
  (pm as any).queryFactory = ({ prompt, options }: any) => {
    const launch: Launch = { resume: options.resume, hasResume: 'resume' in options, closed: false, interrupts: 0, consumed: [], options };
    const index = launches.push(launch) - 1;
    let close!: () => void, interrupt!: () => void;
    const closed = new Promise<void>((r) => { close = r; }), interrupted = new Promise<void>((r) => { interrupt = r; });
    const taken: string[] = []; // uuids consumed since the last result, echoed on the next one
    const next = async () => {
      const input = await prompt.next();
      if (input.done) return undefined;
      consumed.push(input.value.message.content); launch.consumed.push(input.value.message.content);
      taken.push(input.value.uuid);
      return input.value.message.content;
    };
    async function* echoing() {
      for await (const m of script({ launch: index, next, closed, interrupted })) {
        if (m?.type === 'result') { const uuids = taken.splice(0); yield ('user_message_uuids' in m || 'user_message_uuid' in m || !uuids.length) ? m : { ...m, user_message_uuids: uuids }; }
        else yield m;
      }
    }
    return {
      close: () => { launch.closed = true; close(); },
      interrupt: async () => { launch.interrupts++; interrupt(); },
      [Symbol.asyncIterator]: () => echoing(),
    };
  };
  t.after(() => pm.close());
  return { pm, events, diagnostics, consumed, launches, store };
}
const quiet = () => new Promise((resolve) => setTimeout(resolve, 30));
const stoppedEntries = (pm: any) => pm.history().filter((e: any) => /stopped at your request/.test(e.text ?? ''));
const gate = () => { let open!: () => void; const opened = new Promise<void>((r) => { open = r; }); return { open, opened }; };

test('a send restarts an exited auth-failed PM and dispatches only new input', { timeout: 10_000 }, async (t) => {
  const release = gate();
  let calls = 0;
  const f = scripted(t, async function* ({ launch, next, closed }) {
    if (launch === 0) {
      yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
      await next(); await release.opened;
      yield { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['Login expired'] };
      return; // eof: the provider exits with 'queued old input' never read
    }
    calls++;
    await next();
    yield { type: 'result', is_error: false, subtype: 'success', result: 'Recovered answer' };
    await closed;
  });
  const running = f.pm.start();
  await f.pm.send('failed input'); await f.pm.send('queued old input');
  release.open(); await running;
  await f.pm.send('explicit retry after login repair');
  await settle(() => f.pm.history().some((e) => e.text === 'Recovered answer'));
  assert.equal(calls, 1); assert.deepEqual(f.launches[1]!.consumed, ['explicit retry after login repair']); assert.equal(f.pm.lastError, null);
  // The input queued behind the failed provider got its own entry and was never replayed.
  assert.equal(f.pm.history().filter((e) => /was not delivered/.test(e.text ?? '')).length, 1);
  assert.deepEqual(f.consumed, ['failed input', 'explicit retry after login repair']);
});
test('rejected sends are refused with the cause, add no conversation entries and no duplicate failure entries', async (t) => {
  const f = fixture(t, [], 'eof'); await f.pm.send('first'); await f.running; f.pm.close();
  const before = f.pm.history().filter((e) => e.error).length;
  for (const text of ['retry one', 'retry two']) await assert.rejects(f.pm.send(text), /unavailable|closed/i);
  assert.deepEqual(f.pm.history().filter((e) => e.role === 'user').map((e) => e.text), ['first']);
  assert.equal(f.pm.history().filter((e) => e.error).length, before);
});
test('Stop cancellation settles without a provider failure or diagnostic', async (t) => {
  const f = fixture(t, [{ type: 'result', is_error: true, subtype: 'error_during_execution', terminal_reason: 'aborted_streaming', errors: ['aborted'] }]);
  let interrupted = 0;
  await f.pm.send('stop this'); (f.pm as any).q.interrupt = async () => { interrupted++; }; await f.pm.interrupt();
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(interrupted, 1); assert.equal(f.consumed.length, 1); assert.equal(f.pm.lastError, null); assert.equal(f.diagnostics.length, 0);
  assert.equal(f.pm.history().filter((e) => e.error).length, 0); assert.match(f.pm.history().at(-1)!.text!, /stopped|cancel/i);
});
for (const code of ['rate_limit', 'overloaded']) test(`SDK-recovered ${code} does not record a failure`, async (t) => {
  const f = fixture(t, [{ type: 'assistant', error: code, message: { content: [{ type: 'text', text: 'Temporary capacity error' }] } }, { type: 'result', is_error: false, subtype: 'success', result: 'Recovered in SDK' }]);
  await f.pm.send('hello'); await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.consumed.length, 1); assert.equal(f.pm.lastError, null); assert.equal(f.diagnostics.length, 0);
  assert.equal(f.pm.history().filter((e) => e.error).length, 0); assert.equal(f.pm.history().at(-1)!.text, 'Recovered in SDK');
});
test('a restart reports a turn left open by the previous daemon once, as uncertain, without replaying it', async (t) => {
  t.mock.method(console, 'error', () => {});
  const dir = storeHome();
  const first = localStore(dir);
  await first.beginTurn('11111111-1111-4111-8111-111111111111', '2026-09-24T12:00:00.000Z'); // the daemon stops mid-turn
  for (let i = 0; i < 2; i++) {
    const pm = newPm(localStore(dir)); let received = 0;
    let finish!: () => void; const done = new Promise<void>((r) => { finish = r; });
    (pm as any).queryFactory = ({ prompt }: any) => ({ close: finish, async *[Symbol.asyncIterator]() { void prompt.next().then(() => received++); await done; } });
    const running = pm.start();
    try {
      const entries = pm.history().filter((e) => /could not be confirmed \(Foreman restarted\)\. It was not replayed\./.test(e.text ?? ''));
      assert.equal(entries.length, i === 0 ? 1 : 0, `restart ${i}`);
      if (i === 0) {
        assert.equal(entries[0]!.text, 'Your message sent at 2026-09-24 12:00 UTC to the PM on test-mac could not be confirmed (Foreman restarted). It was not replayed.');
        assert.equal(entries[0]!.error, true); assert.equal(pm.lastError, entries[0]!.text);
      }
      await quiet(); assert.equal(received, 0);
    } finally { pm.close(); await running; }
  }
});
test('truncated output is recorded before the failure explanation', async (t) => {
  const f = fixture(t, [{ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial answer' } } }, { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['Connection lost'] }]);
  await f.pm.send('hello'); await settle(() => f.events.some((e) => e.type === 'turn_end'));
  const history = f.pm.history(); assert.equal(history[1]!.text, 'Partial answer'); assert.equal(history.at(-1)!.error, true);
});

test('repeated synchronous startup rejection is refused with the cause, without duplicate failure lines', async (t) => {
  const store = localStore();
  const pm = newPm(store);
  t.mock.method(console, 'error', () => {});
  (pm as any).queryFactory = () => { throw new Error('spawn ENOENT'); };
  await pm.start();
  for (const text of ['retry one', 'retry two']) {
    // The launch throws, so the send is rejected with that specific cause (#33) and nothing is dispatched.
    await assert.rejects(pm.send(text), /spawn ENOENT/);
    await settle(() => !(pm as any).running);
  }
  assert.deepEqual(pm.history().filter((e) => e.role === 'user').map((e) => e.text), []);
  assert.equal(pm.history().filter((e) => e.error).length, 1);
  assert.deepEqual(store.openTurnIds(), [], 'each refused send ended its turn record');
  pm.close();
});

test('an interrupt whose turn produced no result does not relabel the next turn\'s provider failure as a Stop', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ next, closed }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next(); // the interrupted turn: the provider never answers it
    await next();
    yield { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['Provider unavailable'] };
    await closed;
  });
  const running = f.pm.start(); t.after(() => running);
  await f.pm.send('first'); await settle(() => f.consumed.length === 1);
  await f.pm.interrupt(); assert.equal(f.launches[0]!.interrupts, 1);
  await f.pm.send('second'); await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.deepEqual(f.consumed, ['first', 'second']);
  assert.match(f.pm.lastError!, /Provider unavailable/);
  assert.equal(f.events.find((e) => e.type === 'turn_end').is_error, true);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
  assert.equal(stoppedEntries(f.pm).length, 0);
  assert.equal(f.diagnostics.length, 1);
});

test('aborted_tools is an SDK abort and settles as a Stop without a failure', { timeout: 10_000 }, async (t) => {
  const f = fixture(t, [{ type: 'result', is_error: true, subtype: 'error_during_execution', terminal_reason: 'aborted_tools', errors: ['aborted'] }]);
  f.pm.lastError = 'Old failure';
  await f.pm.send('stop during a tool round'); // no local interrupt: the terminal_reason alone decides
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.consumed.length, 1); assert.equal(f.pm.lastError, null); assert.equal(f.diagnostics.length, 0);
  assert.equal(f.pm.history().filter((e) => e.error).length, 0);
  assert.equal(stoppedEntries(f.pm).length, 1);
  assert.equal(f.events.find((e) => e.type === 'turn_end').is_error, false);
});

test('a non-abort terminal_reason is a failure even when an interrupt was raised for the turn', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ next, interrupted, closed }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next(); await interrupted;
    yield { type: 'result', is_error: true, subtype: 'error_during_execution', terminal_reason: 'api_error', errors: ['API Error: 500 upstream'] };
    await closed;
  });
  const running = f.pm.start(); t.after(() => running);
  await f.pm.send('hello'); await settle(() => f.consumed.length === 1);
  await f.pm.interrupt();
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.launches[0]!.interrupts, 1);
  assert.match(f.pm.lastError!, /API Error: 500 upstream/);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
  assert.equal(stoppedEntries(f.pm).length, 0);
  assert.equal(f.events.find((e) => e.type === 'turn_end').is_error, true);
});

test('an interrupted turn whose result carries no terminal_reason still settles as a Stop', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ next, interrupted, closed }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next(); await interrupted;
    yield { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['aborted'] };
    await closed;
  });
  const running = f.pm.start(); t.after(() => running);
  await f.pm.send('stop this'); await settle(() => f.consumed.length === 1);
  await f.pm.interrupt();
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.launches[0]!.interrupts, 1);
  assert.equal(f.pm.lastError, null); assert.equal(f.diagnostics.length, 0);
  assert.equal(stoppedEntries(f.pm).length, 1);
});

test('an explicit send restarts an alive-but-rejecting PM as a fresh session and dispatches only the new input', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ launch, next, closed }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next();
    if (launch === 0) {
      yield { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Invalid bearer token' }] } };
      yield { type: 'result', is_error: true, subtype: 'success', result: 'Invalid bearer token' };
    } else yield { type: 'result', is_error: false, subtype: 'success', result: 'Recovered answer' };
    await closed; // the provider process stays alive after rejecting
  });
  const running = f.pm.start(); t.after(() => running);
  await f.pm.send('failed input');
  await settle(() => !!f.pm.lastError);
  await quiet();
  assert.equal((f.pm as any).running, true); assert.equal(f.launches.length, 1);
  await f.pm.send('explicit retry after login repair');
  await settle(() => f.pm.history().some((e) => e.text === 'Recovered answer'));
  await quiet();
  assert.equal(f.launches.length, 2); // exactly one new launch, no automatic retries
  assert.equal(f.launches[0]!.closed, true);
  assert.deepEqual(f.launches.map((l) => l.hasResume), [false, false]); // a fresh session, never a resume
  assert.deepEqual(f.consumed, ['failed input', 'explicit retry after login repair']);
  assert.equal(f.pm.lastError, null);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
  // The conversation is kept across the in-process restart, with one neutral notice.
  const texts = f.pm.history().map((e) => e.text);
  const notice = texts.indexOf('Started a fresh PM session. It answers from memory, not from the messages above.');
  assert.ok(notice > 0 && notice < texts.indexOf('explicit retry after login repair'), JSON.stringify(texts));
  assert.equal(f.pm.history()[notice]!.error, undefined);
});

test('a PM that failed with turns still pending is not restarted, so accepted input is not dropped', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ next, closed }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next();
    yield { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['Login expired'] };
    await next();
    yield { type: 'result', is_error: false, subtype: 'success', result: 'Second answer' };
    await next();
    yield { type: 'result', is_error: false, subtype: 'success', result: 'Third answer' };
    await closed;
  });
  const running = f.pm.start(); t.after(() => running);
  await Promise.all([f.pm.send('first'), f.pm.send('second'), f.pm.send('third')]);
  await settle(() => f.pm.history().some((e) => e.text === 'Third answer'));
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.consumed, ['first', 'second', 'third']);
  assert.equal(f.pm.lastError, null);
});

test('a non-provider error such as the restart notice does not restart a running PM', { timeout: 10_000 }, async (t) => {
  const dir = storeHome();
  await localStore(dir).beginTurn('22222222-2222-4222-8222-222222222222', '2026-09-24T12:00:00.000Z');
  const f = scripted(t, async function* ({ next, closed }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next();
    yield { type: 'result', is_error: false, subtype: 'success', result: 'Answer' };
    await closed;
  }, localStore(dir));
  const running = f.pm.start(); t.after(() => running);
  assert.match(f.pm.lastError!, /Foreman restarted/);
  await f.pm.send('next message');
  await settle(() => f.pm.history().some((e) => e.text === 'Answer'));
  assert.equal(f.launches.length, 1); assert.deepEqual(f.consumed, ['next message']);
});

test('a retired provider cannot write into the PM after an explicit restart', { timeout: 10_000 }, async (t) => {
  let releaseLate!: () => void;
  const late = new Promise<void>((r) => { releaseLate = r; });
  const f = scripted(t, async function* ({ launch, next, closed }) {
    yield { type: 'system', subtype: 'init', session_id: `session-${launch}`, tools: [] };
    await next();
    if (launch === 0) {
      yield { type: 'result', is_error: true, subtype: 'success', result: 'Invalid bearer token' };
      await late; // straggling frames from the old process after it was retired
      yield { type: 'system', subtype: 'init', session_id: 'late-stale-session', tools: [] };
      yield { type: 'result', is_error: true, subtype: 'success', result: 'Late stale failure' };
      return;
    }
    yield { type: 'result', is_error: false, subtype: 'success', result: 'Recovered answer' };
    await closed;
  });
  const running = f.pm.start(); t.after(() => running);
  await f.pm.send('failed input'); await settle(() => !!f.pm.lastError);
  await f.pm.send('retry'); await settle(() => f.pm.history().some((e) => e.text === 'Recovered answer'));
  releaseLate(); await running; await quiet();
  assert.equal(f.pm.lastError, null);
  assert.equal(f.pm.history().some((e) => /Late stale failure/.test(e.text ?? '')), false);
  assert.equal((f.pm as any).running, true);
  assert.equal(f.pm.sessionId, 'session-1');
  assert.equal(f.events.some((e) => e.type === 'status' && /late-sta/.test(e.text)), false);
});

test('a peer-triggered turn invalidates a pending interrupt, so its genuine failure is not a Stop', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ next, interrupted, closed }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next(); await interrupted; // the interrupted turn: the provider never answers it
    // A peer message then starts a turn of its own, which genuinely fails without a terminal_reason.
    yield { type: 'user', message: { role: 'user', content: '<cross-session-message from="worker">Build finished</cross-session-message>' } };
    yield { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['Provider unavailable'] };
    await closed;
  });
  const running = f.pm.start(); t.after(() => running);
  await f.pm.send('first'); await settle(() => f.consumed.length === 1);
  await f.pm.interrupt(); assert.equal(f.launches[0]!.interrupts, 1);
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.pm.history().filter((e) => e.role === 'peer').length, 1);
  assert.match(f.pm.lastError!, /Provider unavailable/);
  assert.equal(f.events.find((e) => e.type === 'turn_end').is_error, true);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
  assert.equal(stoppedEntries(f.pm).length, 0);
});

test('retiring a provider ends its parked input reader and ignores its stderr', { timeout: 10_000 }, async (t) => {
  let released = false;
  const f = scripted(t, async function* ({ launch, next, closed }) {
    yield { type: 'system', subtype: 'init', session_id: `session-${launch}`, tools: [] };
    await next();
    if (launch === 0) {
      yield { type: 'result', is_error: true, subtype: 'success', result: 'Invalid bearer token' };
      // Like the SDK's streamInput, keep reading the prompt after the turn.
      if (await next() === undefined) released = true;
      return;
    }
    yield { type: 'result', is_error: false, subtype: 'success', result: 'Recovered answer' };
    await closed;
  });
  const stderr: ((chunk: string) => void)[] = [];
  const factory = (f.pm as any).queryFactory;
  (f.pm as any).queryFactory = (args: any) => { stderr.push(args.options.stderr); return factory(args); };
  void f.pm.start();
  await f.pm.send('failed input'); await settle(() => !!f.pm.lastError);
  await f.pm.send('retry'); await settle(() => f.pm.history().some((e) => e.text === 'Recovered answer'));
  await settle(() => released); // the retired stream completed instead of leaking a stuck reader
  assert.deepEqual(f.launches[0]!.consumed, ['failed input']);
  assert.deepEqual(f.launches[1]!.consumed, ['retry']);
  stderr[0]!('error: late output from the retired process');
  assert.equal(f.events.some((e) => e.type === 'status' && /retired process/.test(e.text)), false);
  stderr[1]!('error: output from the live process');
  assert.equal(f.events.some((e) => e.type === 'status' && /live process/.test(e.text)), true);
});

// The SDK's exit echo carries resultDiagnostic(m) (errors[] for an error subtype, `result` for an
// is_error success). When the failure already recorded for that result is different text, the
// echo is the only carrier of the result's own diagnostic: it must surface, never be suppressed.
const errorResult = (diagnostic: string) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, total_cost_usd: 0, errors: [diagnostic] });
const errorEntries = (pm: any): string[] => pm.history().filter((e: any) => e.error).map((e: any) => e.text);

test('a result whose errors[] differ from a preceding assistant API error keeps both diagnostics', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ next }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next();
    yield { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'API Error: overloaded' }] } };
    yield errorResult('DISTINCT: tool runner crashed');
    throw new Error('Claude Code returned an error result: DISTINCT: tool runner crashed');
  });
  await f.pm.send('input');
  await settle(() => !(f.pm as any).running);
  await quiet();
  const entries = errorEntries(f.pm);
  assert.ok(entries.some((e) => /API Error: overloaded/.test(e)), 'the assistant API error is recorded');
  assert.ok(entries.some((e) => /DISTINCT: tool runner crashed/.test(e)), 'the result errors[] diagnostic is recorded');
  assert.match(f.pm.lastError!, /DISTINCT: tool runner crashed/);
  assert.ok(f.diagnostics.some((d) => /DISTINCT: tool runner crashed/.test(String(d[1]))), 'the result errors[] diagnostic is logged');
});

test('an is_error success result whose errors[] differ from its result text keeps both diagnostics', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ next }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next();
    yield { type: 'result', subtype: 'success', is_error: true, num_turns: 1, total_cost_usd: 0, result: 'DISTINCT: API Error 529 overloaded', errors: ['hook runner failed'] };
    throw new Error('Claude Code returned an error result: DISTINCT: API Error 529 overloaded');
  });
  await f.pm.send('input');
  await settle(() => !(f.pm as any).running);
  await quiet();
  const entries = errorEntries(f.pm);
  assert.ok(entries.some((e) => /hook runner failed/.test(e)), 'the errors[] diagnostic is recorded');
  assert.ok(entries.some((e) => /DISTINCT: API Error 529 overloaded/.test(e)), 'the result text the SDK echoes is recorded');
  assert.match(f.pm.lastError!, /DISTINCT: API Error 529 overloaded/);
  assert.ok(f.diagnostics.some((d) => /DISTINCT: API Error 529 overloaded/.test(String(d[1]))), 'the echoed result text is logged');
});

// Reporting failures (#35). A throwing 'event' listener must never replace the provider cause,
// skip lifecycle cleanup, or block the next explicit send.
const providerDiagnostics = (diagnostics: any[]) => diagnostics.filter((d) => d[0] === 'foreman: pm failure');
const reportingFailures = (diagnostics: any[]) => diagnostics.filter((d) => d[0] === 'foreman: pm reporting failed');
const recovered = async function* ({ next, closed }: Ctx) {
  yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
  await next();
  yield { type: 'result', is_error: false, subtype: 'success', result: 'Recovered answer' };
  await closed;
};

test('a throwing event listener during a provider failure keeps the provider cause and settles lifecycle state', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* (ctx) {
    if (ctx.launch > 0) return yield* recovered(ctx);
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await ctx.next();
    yield { type: 'stream_event', event: { type: 'message_start' } };
    yield errorResult('Original provider failure');
    throw new Error('Claude Code returned an error result: Original provider failure');
  });
  f.pm.on('event', () => { throw new Error('listener exploded'); });
  const running = f.pm.start();
  await f.pm.send('first input');
  await running;
  assert.deepEqual(f.consumed, ['first input']);
  assert.match(f.pm.lastError!, /Original provider failure/);
  assert.doesNotMatch(f.pm.lastError!, /listener exploded/);
  assert.deepEqual((f.pm as any).outstanding, []);
  assert.equal(f.pm.busy, false);
  assert.equal(f.pm.modelBusy, false);
  assert.equal((f.pm as any).running, false);
  const provider = providerDiagnostics(f.diagnostics);
  assert.equal(provider.length, 1);
  assert.match(provider[0][1], /Original provider failure/);
  // Within fail(), the provider diagnostic precedes the failed status emission's report.
  const at = f.diagnostics.indexOf(provider[0]);
  assert.equal(f.diagnostics[at + 1][0], 'foreman: pm reporting failed');
  assert.match(f.diagnostics[at + 1][1], /"kind":"event","detail":"status".*listener exploded/);
  // Earlier listeners still saw every event, and the failure was recorded once.
  assert.deepEqual(f.events.filter((e) => e.type === 'turn_end').map((e) => e.is_error), [true]);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
  await f.pm.send('explicit retry');
  await settle(() => f.pm.history().some((e) => e.role === 'assistant' && e.text === 'Recovered answer'));
  assert.deepEqual(f.launches.map((l) => l.consumed), [['first input'], ['explicit retry']]);
  assert.equal(f.pm.lastError, null);
});

test('a throwing event listener during a successful turn does not abort the turn state update', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ next, closed }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    for (let input = await next(); input !== undefined; input = await next()) {
      yield { type: 'stream_event', event: { type: 'message_start' } };
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `answer to ${input}` } } };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: `answer to ${input}` }, { type: 'tool_use', name: 'mcp__fleet__list_sessions', input: {} }] } };
      yield { type: 'result', is_error: false, subtype: 'success', result: `answer to ${input}` };
    }
    await closed;
  });
  f.pm.on('event', () => { throw new Error('listener exploded'); });
  const running = f.pm.start();
  f.pm.lastError = 'Old failure';
  await f.pm.send('first');
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.pm.lastError, null);
  assert.deepEqual((f.pm as any).outstanding, []);
  assert.equal(f.pm.busy, false);
  assert.equal(f.pm.modelBusy, false);
  assert.equal((f.pm as any).running, true);
  assert.deepEqual(f.pm.history().filter((e) => e.role === 'assistant').map((e) => e.text), ['answer to first']);
  assert.equal(f.pm.history().filter((e) => e.role === 'tool').length, 1);
  assert.equal(providerDiagnostics(f.diagnostics).length, 0);
  const reported = reportingFailures(f.diagnostics).map((d) => JSON.parse(d[1]).detail);
  for (const type of ['status', 'turn_start', 'delta', 'tool', 'assistant_text', 'turn_end']) assert.ok(reported.includes(type), `${type} failure logged`);
  assert.deepEqual(f.events.filter((e) => e.type === 'assistant_text').map((e) => e.text), ['answer to first']);
  // The same provider keeps serving explicit input.
  await f.pm.send('second');
  await settle(() => f.events.filter((e) => e.type === 'turn_end').length === 2);
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.consumed, ['first', 'second']);
  assert.equal(f.pm.modelBusy, false);
  assert.deepEqual(f.pm.history().filter((e) => e.role === 'assistant').map((e) => e.text), ['answer to first', 'answer to second']);
  assert.equal(f.pm.lastError, null);
  void running;
});

// Diagnostic preservation (#33). When a retry or restart cannot be dispatched, or a later
// generic error follows a specific provider failure, the specific cause stays in lastError, in
// the failure entry, and in what send()/setModel() reject with.

test('a stream that ends with turns pending after a turn failure keeps the specific failure as the cause', { timeout: 10_000 }, async (t) => {
  const release = gate();
  const f = scripted(t, async function* ({ next }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next(); await release.opened;
    yield { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['OAuth token revoked by the organization'] };
    // The stream ends while 'second' is still accepted and pending.
  });
  const running = f.pm.start();
  await f.pm.send('first'); await f.pm.send('second');
  release.open();
  await running;
  assert.deepEqual(f.consumed, ['first']);
  assert.match(f.pm.lastError!, /Provider stream ended unexpectedly/);
  assert.match(f.pm.lastError!, /OAuth token revoked by the organization/);
  assert.match(errorEntries(f.pm).at(-1)!, /Provider stream ended unexpectedly.*OAuth token revoked by the organization/);
  assert.equal(f.pm.modelBusy, false);
});

test('a process exit error after a reported turn failure keeps the specific failure as the cause', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ next }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next();
    yield { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['Login expired for account'] };
    throw new Error('Claude Code process exited with code 1');
  });
  const running = f.pm.start();
  await f.pm.send('first');
  await running;
  assert.match(f.pm.lastError!, /Claude Code process exited with code 1/);
  assert.match(f.pm.lastError!, /Login expired for account/);
  assert.match(errorEntries(f.pm).at(-1)!, /exited with code 1.*Login expired for account/);
  assert.equal(f.pm.lastError!.match(/Login expired for account/g)!.length, 1);
});

test('a send whose restart launch throws synchronously (spawn ENOENT) rejects with that cause and keeps it in lastError', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ next }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next();
    yield { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['Login expired'] };
  });
  const running = f.pm.start();
  await f.pm.send('failed input');
  await running;
  assert.match(f.pm.lastError!, /Login expired/);
  let launches = 0;
  (f.pm as any).queryFactory = () => { launches++; throw new Error('spawn /usr/local/bin/claude ENOENT'); };
  await assert.rejects(f.pm.send('explicit retry'), (error: any) => /spawn \/usr\/local\/bin\/claude ENOENT/.test(error.message) && !/unavailable/i.test(error.message));
  assert.equal(launches, 1);
  await settle(() => !(f.pm as any).running);
  assert.match(f.pm.lastError!, /spawn \/usr\/local\/bin\/claude ENOENT/);
  assert.match(errorEntries(f.pm).at(-1)!, /spawn \/usr\/local\/bin\/claude ENOENT/);
  // The refused input was never dispatched: it is not in the conversation and its turn record is ended.
  assert.equal(f.pm.history().some((e) => e.role === 'user' && e.text === 'explicit retry'), false);
  assert.deepEqual(f.store.openTurnIds(), []);
  assert.equal(f.pm.modelBusy, false);
});

test('setModel on a PM that exited after a provider failure rejects with the specific cause', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ next }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next();
    yield { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['Credit balance is too low'] };
  });
  const running = f.pm.start();
  await f.pm.send('failed input');
  await running;
  assert.equal((f.pm as any).running, false);
  await assert.rejects(f.pm.setModel('claude-sonnet-4-5'), /unavailable.*Credit balance is too low/);
  assert.match(f.pm.lastError!, /Credit balance is too low/);
});

test('a model change whose save and restore both fail closes the PM and keeps both causes for later rejections', { timeout: 10_000 }, async (t) => {
  const diagnostics: any[] = [];
  t.mock.method(console, 'error', (...args: any[]) => diagnostics.push(args));
  // Saving the setting fails in the store.
  const store = localStore();
  store.setModel = async () => { throw new Error('ENOENT: the PM state store could not save the model'); };
  const pm = newPm(store);
  let finish!: () => void; const done = new Promise<void>((r) => { finish = r; });
  const models: (string | undefined)[] = [];
  (pm as any).queryFactory = () => ({
    close: finish,
    setModel: async (model: string | undefined) => { models.push(model); if (models.length > 1) throw new Error('control channel closed while restoring'); },
    async *[Symbol.asyncIterator]() { yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] }; await done; },
  });
  const running = pm.start(); t.after(async () => { pm.close(); await running; });
  await settle(() => pm.sessionId === 'test-session');
  await assert.rejects(pm.setModel('claude-sonnet-4-5'), (error: any) => /ENOENT/.test(error.message) && /control channel closed while restoring/.test(error.message));
  assert.deepEqual(models, ['claude-sonnet-4-5', undefined]);
  assert.match(pm.lastError!, /control channel closed while restoring/);
  assert.match(pm.lastError!, /ENOENT/);
  assert.match(errorEntries(pm).at(-1)!, /control channel closed while restoring/);
  assert.ok(diagnostics.some((d) => d[0] === 'foreman: pm failure' && /control channel closed while restoring/.test(d[1])));
  // Every later send is rejected with the cause, not only "(closed)".
  await assert.rejects(pm.send('after the failed model change'), /\(closed\).*control channel closed while restoring/);
});

// Provider error codes (#36). The SDK's typed assistant error code (e.g. authentication_failed)
// is kept alongside the human prose in lastError, the conversation and the console diagnostic,
// and nothing that looks like a credential is logged, emitted or stored.
const failureLogs = (diagnostics: any[]) => diagnostics.filter((d) => d[0] === 'foreman: pm failure').map((d) => JSON.parse(d[1]));
function codedTurn(t: any, messages: any[]) {
  return scripted(t, async function* ({ next, closed }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next();
    for (const m of messages) yield m;
    await closed;
  });
}

test('an assistant error with a code and prose keeps both in lastError, the conversation and the console diagnostic', { timeout: 10_000 }, async (t) => {
  const f = codedTurn(t, [
    { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'OAuth session expired and could not be refreshed' }] } },
    { type: 'result', is_error: true, subtype: 'success', result: 'OAuth session expired' },
  ]);
  await f.pm.send('hello');
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.deepEqual(f.consumed, ['hello']);
  assert.match(f.pm.lastError!, /^Project manager failed: authentication_failed: OAuth session expired and could not be refreshed\. /);
  const entries = errorEntries(f.pm);
  assert.equal(entries.length, 1);
  assert.equal(entries[0], f.pm.lastError);
  const logs = failureLogs(f.diagnostics);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].code, 'authentication_failed');
  assert.equal(logs[0].subtype, 'success');
  assert.match(logs[0].error, /authentication_failed: OAuth session expired and could not be refreshed/);
});

test('prose that already names the code does not repeat it', { timeout: 10_000 }, async (t) => {
  const f = codedTurn(t, [
    { type: 'assistant', error: 'billing_error', message: { content: [{ type: 'text', text: 'billing_error: credit balance too low' }] } },
    { type: 'result', is_error: true, subtype: 'success', result: 'credit balance too low' },
  ]);
  await f.pm.send('hello');
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.pm.lastError!.match(/billing_error/g)!.length, 1);
  assert.equal(failureLogs(f.diagnostics)[0].code, 'billing_error');
});

test('an assistant error with a code but no prose reports the code', { timeout: 10_000 }, async (t) => {
  const f = codedTurn(t, [
    { type: 'assistant', error: 'account_on_hold', message: { content: [] } },
    { type: 'result', is_error: true, subtype: 'error_during_execution', errors: [] },
  ]);
  await f.pm.send('hello');
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.match(f.pm.lastError!, /^Project manager failed: account_on_hold: provider returned no message\. /);
  assert.match(errorEntries(f.pm)[0]!, /account_on_hold/);
  const logs = failureLogs(f.diagnostics);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].code, 'account_on_hold');
});

test('a failure with no code and no diagnostic keeps the fallback and logs code null', { timeout: 10_000 }, async (t) => {
  const f = codedTurn(t, [{ type: 'result', is_error: true, subtype: 'error_during_execution', errors: [] }]);
  await f.pm.send('hello');
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.match(f.pm.lastError!, /^Project manager failed: Provider returned error_during_execution without a diagnostic\. /);
  const logs = failureLogs(f.diagnostics);
  assert.equal(logs.length, 1);
  assert.ok('code' in logs[0], 'the diagnostic always carries a code field');
  assert.equal(logs[0].code, null);
  assert.equal(logs[0].subtype, 'error_during_execution');
});

test('an SDK-recovered coded assistant error followed by a success result records no failure', { timeout: 10_000 }, async (t) => {
  const f = codedTurn(t, [
    { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'API Error: rate limited' }] } },
    { type: 'result', is_error: false, subtype: 'success', result: 'Recovered answer' },
  ]);
  await f.pm.send('hello');
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.pm.lastError, null);
  assert.equal(errorEntries(f.pm).length, 0);
  assert.equal(failureLogs(f.diagnostics).length, 0);
});

test('credentials in provider text never reach lastError, the conversation, the store, events or the console', { timeout: 10_000 }, async (t) => {
  const key = 'sk-ant-oat01-AbCdEf_0123456789-ZyXwVu', bearer = 'eyJhbGciOiJIUzI1NiJ9.payloadpart.signaturepart', token = 'ya29a0AfH6SMBx9secretvalue';
  const f = codedTurn(t, [
    { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: `Request rejected for ${key}; x-api-key: ${key}; Authorization: Bearer ${bearer}; refresh_token=${token}` }] } },
    { type: 'result', is_error: true, subtype: 'error_during_execution', errors: [`key ${key} invalid`] },
  ]);
  await f.pm.send('hello');
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  await quiet();
  const surfaces = [f.pm.lastError!, JSON.stringify(f.pm.history()), JSON.stringify(await f.store.read()), JSON.stringify(f.events), JSON.stringify(f.diagnostics)];
  for (const surface of surfaces) {
    for (const secret of [key, 'AbCdEf_0123456789', bearer, token]) assert.ok(!surface.includes(secret), `a credential leaked: ${surface}`);
  }
  // The failure stays specific and coded, with the credentials marked as redacted.
  assert.match(f.pm.lastError!, /authentication_failed: Request rejected/);
  assert.match(f.pm.lastError!, /sk-ant-\[REDACTED\]/);
  assert.match(f.pm.lastError!, /Bearer \[REDACTED\]/);
  assert.match(f.pm.lastError!, /refresh_token=\[REDACTED\]/);
  assert.equal(failureLogs(f.diagnostics)[0].code, 'authentication_failed');
});

test('a credential in an SDK process exit error is redacted too', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ next }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next();
    throw new Error('Claude Code process exited with code 1. stderr: 401 Authorization: Bearer sk-ant-api03-SECRETSECRET');
  });
  await f.pm.send('hello');
  await settle(() => !(f.pm as any).running);
  await quiet();
  for (const surface of [f.pm.lastError!, JSON.stringify(f.pm.history()), JSON.stringify(f.events), JSON.stringify(f.diagnostics)]) assert.ok(!surface.includes('SECRETSECRET'), surface);
  assert.match(f.pm.lastError!, /exited with code 1/);
  assert.equal(failureLogs(f.diagnostics)[0].code, null);
});

test('with a coded failure, the SDK exit echo of the result is still suppressed to exactly one entry', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ next }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next();
    yield { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'OAuth session expired and could not be refreshed' }] } };
    yield { type: 'result', is_error: true, subtype: 'success', result: 'OAuth session expired' };
    throw new Error('Claude Code returned an error result: OAuth session expired');
  });
  await f.pm.send('hello');
  await settle(() => !(f.pm as any).running);
  await quiet();
  const entries = errorEntries(f.pm);
  assert.equal(entries.length, 1, JSON.stringify(entries));
  assert.match(entries[0]!, /authentication_failed: OAuth session expired and could not be refreshed/);
  assert.equal(f.pm.lastError, entries[0]);
  const logs = failureLogs(f.diagnostics);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].code, 'authentication_failed');
});

// ---------------------------------------------------------------------------------------------
// PMM-05 (#83): disposable session, write-ahead turn record, per-input settlement, redaction.
// ---------------------------------------------------------------------------------------------

test('every start is a fresh provider session: no resume option, memory injected from the store', { timeout: 10_000 }, async (t) => {
  const store = localStore();
  await store.write('projects', '## zebra-project\nStatus: blocked on FOREMAN_TEST_CANARY', 0);
  await store.log('decided to ship on Friday');
  const f = scripted(t, async function* ({ launch, next, closed }) {
    yield { type: 'system', subtype: 'init', session_id: `session-${launch}`, tools: [] };
    await next();
    yield launch === 0 ? errorResult('Login expired') : { type: 'result', is_error: false, subtype: 'success', result: 'ok' };
    await closed;
  }, store);
  void f.pm.start();
  await f.pm.send('one'); await settle(() => !!f.pm.lastError);
  await store.write('projects', '## zebra-project\nStatus: unblocked FOREMAN_SECOND_CANARY', 1);
  await f.pm.send('two'); await settle(() => f.pm.history().some((e) => e.text === 'ok'));
  assert.equal(f.launches.length, 2);
  for (const launch of f.launches) assert.equal(launch.hasResume, false, 'resume is never passed to the query factory');
  const prompts = f.launches.map((l) => l.options.systemPrompt.append as string);
  assert.match(prompts[0]!, /## zebra-project\nStatus: blocked on FOREMAN_TEST_CANARY/);
  assert.match(prompts[0]!, /decided to ship on Friday/);
  assert.match(prompts[1]!, /FOREMAN_SECOND_CANARY/, 'memory is re-read at each fresh start');
  assert.doesNotMatch(prompts[1]!, /FOREMAN_TEST_CANARY/);
  for (const tool of ['mcp__fleet__memory_read', 'mcp__fleet__memory_write', 'mcp__fleet__memory_edit', 'mcp__fleet__log_note']) assert.ok(f.launches[0]!.options.allowedTools.includes(tool), tool);
});

test('nothing is written under pm/ except by the store: no history.jsonl, no session file', { timeout: 10_000 }, async (t) => {
  const dir = storeHome();
  const f = scripted(t, async function* ({ next, closed }) {
    yield { type: 'system', subtype: 'init', session_id: 'written-nowhere', tools: [] };
    await next();
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] } };
    yield { type: 'result', is_error: false, subtype: 'success', result: 'reply' };
    await closed;
  }, localStore(dir));
  void f.pm.start();
  await f.pm.send('hello'); await settle(() => f.pm.history().some((e) => e.text === 'reply'));
  assert.deepEqual(readdirSync(join(dir, 'pm')), ['state.json']);
  const state = readFileSync(join(dir, 'pm', 'state.json'), 'utf8');
  assert.ok(!state.includes('hello') && !state.includes('reply') && !state.includes('written-nowhere'), 'no message text or session id is stored');
  for (const legacy of ['history.jsonl', 'session', 'session.quarantine.jsonl']) assert.equal(existsSync(join(home, 'pm', legacy)), false, legacy);
});

test('a beginTurn failure rejects the send with its cause and dispatches nothing', { timeout: 10_000 }, async (t) => {
  const store = localStore();
  store.beginTurn = async () => { throw Object.assign(new Error('Could not save pm/state.json'), { code: 'unavailable' }); };
  const f = scripted(t, async function* ({ next, closed }) {
    yield { type: 'system', subtype: 'init', session_id: 's', tools: [] };
    await next();
    yield { type: 'result', is_error: false, subtype: 'success', result: 'must not happen' };
    await closed;
  }, store);
  void f.pm.start();
  await assert.rejects(f.pm.send('not recorded'), /could not record your message.*Could not save pm\/state\.json/);
  await quiet();
  assert.deepEqual(f.consumed, []);
  assert.equal(f.pm.history().some((e) => e.role === 'user'), false);
  assert.deepEqual((f.pm as any).outstanding, []);
});

test('each input is settled by the result that names it; a peer turn and an extra result settle nothing', { timeout: 10_000 }, async (t) => {
  const ends: [string, string][] = [];
  const store = localStore();
  const end = store.endTurn.bind(store);
  store.endTurn = (id: string, outcome: any) => { ends.push([id, outcome]); return end(id, outcome); };
  let uuids: string[] = [];
  const step = gate(), afterPeer = gate();
  const f = scripted(t, async function* ({ next, closed }) {
    yield { type: 'system', subtype: 'init', session_id: 's', tools: [] };
    await next(); await next(); await step.opened;
    // A peer message starts its own turn; its result names no input of ours.
    yield { type: 'user', message: { role: 'user', content: '<cross-session-message from="worker">done</cross-session-message>' } };
    yield { type: 'result', is_error: false, subtype: 'success', result: 'peer handled', user_message_uuids: undefined };
    await afterPeer.opened;
    yield { type: 'result', is_error: false, subtype: 'success', result: 'answer A', user_message_uuids: [uuids[0]] };
    // An extra result frame for an input that is already settled changes nothing.
    yield { type: 'result', is_error: false, subtype: 'success', result: 'duplicate A', user_message_uuids: [uuids[0]] };
    yield { type: 'result', is_error: false, subtype: 'success', result: 'answer B', user_message_uuids: [uuids[1]] };
    await closed;
  }, store);
  void f.pm.start();
  await f.pm.send('A'); await f.pm.send('B');
  uuids = f.pm.outstandingTurnIds();
  assert.equal(uuids.length, 2);
  await settle(() => f.consumed.length === 2);
  step.open();
  await settle(() => f.pm.history().some((e) => e.text === 'peer handled'));
  assert.deepEqual(f.pm.outstandingTurnIds(), uuids, 'the peer turn settled no input');
  assert.deepEqual(ends, []);
  afterPeer.open();
  await settle(() => f.pm.history().some((e) => e.text === 'answer B'));
  assert.deepEqual(ends, [[uuids[0], 'completed'], [uuids[1], 'completed']]);
  assert.deepEqual(store.openTurnIds(), []);
  assert.equal(errorEntries(f.pm).length, 0);
});

test('a result that names no input outside a peer turn resolves the oldest taken input as uncertain, never completed', { timeout: 10_000 }, async (t) => {
  const ends: [string, string][] = [];
  const store = localStore();
  const end = store.endTurn.bind(store);
  store.endTurn = (id: string, outcome: any) => { ends.push([id, outcome]); return end(id, outcome); };
  const f = scripted(t, async function* ({ next, closed }) {
    yield { type: 'system', subtype: 'init', session_id: 's', tools: [] };
    await next();
    yield { type: 'result', is_error: false, subtype: 'success', result: 'unattributed answer', user_message_uuids: [] };
    await closed;
  }, store);
  void f.pm.start();
  await f.pm.send('ambiguous');
  await settle(() => ends.length === 1);
  assert.equal(ends[0]![1], 'uncertain');
  assert.match(errorEntries(f.pm)[0]!, /could not be confirmed \(the reply could not be matched to your message\)\. It was not replayed\./);
  assert.match(f.pm.lastError!, /could not be confirmed/);
});

test('inputs queued behind a provider that stops get one entry each, and none is replayed', { timeout: 10_000 }, async (t) => {
  const ends: [string, string][] = [];
  const store = localStore();
  const end = store.endTurn.bind(store);
  store.endTurn = (id: string, outcome: any) => { ends.push([id, outcome]); return end(id, outcome); };
  const release = gate();
  const f = scripted(t, async function* ({ launch, next, closed }) {
    yield { type: 'system', subtype: 'init', session_id: 's', tools: [] };
    await next();
    if (launch > 0) { yield { type: 'result', is_error: false, subtype: 'success', result: 'fresh answer' }; await closed; return; }
    await release.opened;
    throw new Error('Claude Code process exited with code 1');
  }, store);
  const running = f.pm.start();
  await f.pm.send('taken'); await f.pm.send('queued one'); await f.pm.send('queued two');
  await settle(() => f.consumed.length === 1);
  release.open(); await running;
  const entries = errorEntries(f.pm);
  assert.equal(entries.filter((e) => /could not be confirmed \(the PM stopped: Claude Code process exited with code 1\)/.test(e)).length, 1);
  assert.equal(entries.filter((e) => /was not delivered \(the PM stopped: Claude Code process exited with code 1\)/.test(e)).length, 2);
  assert.match(entries.at(-1)!, /^Project manager failed: Claude Code process exited with code 1/);
  assert.deepEqual(ends.map(([, outcome]) => outcome).sort(), ['failed', 'failed', 'uncertain']);
  assert.deepEqual(store.openTurnIds(), []);
  await f.pm.send('new'); await settle(() => f.pm.history().some((e) => e.text === 'fresh answer'));
  assert.deepEqual(f.launches[1]!.consumed, ['new']);
});

test('stderr status events are redacted', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ closed }) {
    yield { type: 'system', subtype: 'init', session_id: 's', tools: [] };
    await closed;
  });
  let stderr!: (chunk: string) => void;
  const factory = (f.pm as any).queryFactory;
  (f.pm as any).queryFactory = (args: any) => { stderr = args.options.stderr; return factory(args); };
  void f.pm.start();
  await settle(() => !!stderr);
  stderr('error: 401 Authorization: Basic dXNlcjpwYXNzd29yZA== token=abcdEFGH1234secret sk-ant-api03-LEAKLEAKLEAK; Authorization: required');
  const status = f.events.filter((e) => e.type === 'status' && /401/.test(e.text));
  assert.equal(status.length, 1);
  for (const secret of ['dXNlcjpwYXNzd29yZA', 'abcdEFGH1234secret', 'LEAKLEAKLEAK']) assert.ok(!status[0].text.includes(secret), status[0].text);
  assert.match(status[0].text, /Basic \[REDACTED\]/);
  assert.match(status[0].text, /Authorization: required/);
});

test('uncertain turns are shown once, at the top of the conversation, and acknowledged, even when delivered again', async () => {
  const listeners: any[] = [];
  const acks: string[][] = [];
  const turn = { turn_id: 'aaaaaaaa-1111-4111-8111-111111111111', accepted_at: '2026-09-24T09:30:00.000Z', host: 'machine-a', reason: 'reassigned' as const };
  const lost = { turn_id: 'bbbbbbbb-1111-4111-8111-111111111111', accepted_at: '2026-09-24T09:31:00.000Z', host: 'machine-a', reason: 'host_lost' as const };
  const fake: any = {
    mode: 'relay', assignment: () => ({ active: true, connected: true, epoch: 2, activeHost: 'machine-b' }),
    uncertainTurns: () => [turn, lost], onAssignment: (listener: any) => { listeners.push(listener); return () => {}; },
    ackUncertain: async (ids: string[]) => { acks.push(ids); }, openTurnIds: () => [],
  };
  const pm = new ProjectManager({} as any, { machineName: 'machine-b' });
  const events: any[] = []; pm.on('event', (e) => events.push(e));
  pm.attach(fake, { autoStart: false, bridge: { currentAssignment: () => ({ type: 'pm_assignment', active: true, epoch: 2, active_machine: { machine_id: 'x', host: 'machine-b' }, uncertain_turns: [] }) } });
  for (let i = 0; i < 3; i++) listeners[0]({ active: true, connected: true, epoch: 2, activeHost: 'machine-b' }, [turn, lost]); // duplicate deliveries
  const history = pm.history();
  assert.deepEqual(history.map((e) => e.text), [
    'Your message sent at 2026-09-24 09:30 UTC to the PM on machine-a could not be confirmed (the PM was moved). It was not replayed.',
    'Your message sent at 2026-09-24 09:31 UTC to the PM on machine-a could not be confirmed (machine went offline). It was not replayed.',
  ]);
  assert.ok(history.every((e) => e.error === true && e.role === 'system'));
  assert.equal(pm.lastError, history[1]!.text);
  assert.equal(events.filter((e) => e.type === 'status' && /could not be confirmed/.test(e.text)).length, 2);
  assert.ok(acks.length >= 1 && acks.every((ids) => ids.includes(turn.turn_id) && ids.includes(lost.turn_id)));
  pm.close();
});

test('the hung-turn reason and the restart reason read as plain words', async () => {
  const { UNCERTAIN_REASON_TEXT, uncertainText } = await import('../server/pm.ts');
  assert.deepEqual(UNCERTAIN_REASON_TEXT, { restarted: 'Foreman restarted', reassigned: 'the PM was moved', host_lost: 'machine went offline', hung: 'the PM stopped responding' });
  assert.equal(uncertainText('not a date', 'm', 'x'), 'Your message sent at not a date to the PM on m could not be confirmed (x). It was not replayed.');
});

// The real SDK reads prompt input eagerly and forwards each input's uuid; the installed CLI echoes
// it as `user_message_uuids` on the turn's result. Drive the real query() against a stub CLI that
// does the same (no model spend) to prove the uuid reaches the CLI and settles that input.
function echoCli() {
  const dir = mkdtempSync(join(home, 'stub-cli-'));
  const path = join(dir, 'claude.mjs'), log = join(dir, 'log.jsonl');
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + '\\n');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
log({ argv: process.argv.slice(2).filter((a) => a.startsWith('--resume')) });
let inited = false;
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const m = JSON.parse(line);
  if (m.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); continue; }
  if (m.type !== 'user') continue;
  log({ input: m.message.content, uuid: m.uuid });
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: 'fresh-session', tools: [] }); }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'echo: ' + m.message.content }] }, session_id: 'fresh-session' });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'echo: ' + m.message.content, session_id: 'fresh-session', total_cost_usd: 0, user_message_uuid: m.uuid, user_message_uuids: [m.uuid] });
}
`, { mode: 0o755 });
  return { path, entries: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

test('real SDK: the input uuid reaches the CLI and the echoed result settles that input as completed', { timeout: 10_000 }, async (t) => {
  const cli = echoCli();
  const store = localStore();
  const ends: [string, string][] = [];
  const end = store.endTurn.bind(store);
  store.endTurn = (id: string, outcome: any) => { ends.push([id, outcome]); return end(id, outcome); };
  const pm = newPm(store);
  t.mock.method(process, 'emitWarning', () => {});
  const diagnostics: any[] = []; t.mock.method(console, 'error', (...args: any[]) => diagnostics.push(args));
  (pm as any).queryFactory = (args: any) => query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: cli.path } });
  const running = pm.start();
  t.after(async () => { pm.close(); await running; });
  await pm.send('new input');
  const [turnId] = pm.outstandingTurnIds();
  await settle(() => pm.history().some((e) => e.role === 'assistant'));
  await settle(() => ends.length === 1);
  assert.deepEqual(cli.entries(), [{ argv: [] }, { input: 'new input', uuid: turnId }]);
  assert.deepEqual(ends, [[turnId, 'completed']]);
  assert.equal(pm.history().find((e) => e.role === 'assistant')!.text, 'echo: new input');
  assert.equal(pm.lastError, null);
  assert.deepEqual(store.openTurnIds(), []);
  assert.equal(diagnostics.length, 0);
});
