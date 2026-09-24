import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

for (const ending of ['throw', 'eof'] as const) test(`${ending} fails accepted input visibly and rejects sends after close`, async (t) => {
  const f = fixture(t, [], ending); f.pm.send('Hello'); await f.running;
  assert.equal(f.consumed.length, 1); assert.equal(f.pm.modelBusy, false);
  assert.match(f.pm.history()[1].text, /Provider/); assert.equal(f.diagnostics.length, 1);
  f.pm.close();
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

test('a send restarts an exited auth-failed PM and dispatches only new input', async t => {
  const f=fixture(t,[{type:'result',is_error:true,subtype:'error_during_execution',errors:['Login expired']}],'eof');
  f.pm.send('failed input'); f.pm.send('queued old input'); await f.running;
  let calls=0; const consumed: string[]=[];let finish!:()=>void;
  const done=new Promise<void>(r=>finish=r);
  (f.pm as any).queryFactory=({prompt}:any)=>{calls++;return {close:finish,async *[Symbol.asyncIterator](){
    const input=await prompt.next();consumed.push(input.value.message.content);
    yield {type:'result',is_error:false,subtype:'success',result:'Recovered answer'};await done;
  }};};
  t.after(()=>f.pm.close());
  f.pm.send('explicit retry after login repair');
  await settle(()=>f.pm.history().some(e=>e.text==='Recovered answer'));
  assert.equal(calls,1);assert.deepEqual(consumed,['explicit retry after login repair']);assert.equal(f.pm.lastError,null);
});
test('rejected sends persist each user message without duplicate failure entries',async t=>{
  const f=fixture(t,[],'eof');f.pm.send('first');await f.running;f.pm.close();
  const before=f.pm.history().filter(e=>e.error).length;
  for(const text of ['retry one','retry two']) assert.throws(()=>f.pm.send(text),/unavailable|closed/i);
  assert.deepEqual(f.pm.history().filter(e=>e.role==='user').map(e=>e.text),['first','retry one','retry two']);
  assert.equal(f.pm.history().filter(e=>e.error).length,before);
});
test('Stop cancellation settles without a provider failure or diagnostic',async t=>{
  const f=fixture(t,[{type:'result',is_error:true,subtype:'error_during_execution',terminal_reason:'aborted_streaming',errors:['aborted']}]);
  let interrupted=0;(f.pm as any).q.interrupt=async()=>{interrupted++;};
  f.pm.send('stop this');await f.pm.interrupt();
  await settle(()=>f.events.some(e=>e.type==='turn_end'));
  assert.equal(interrupted,1);assert.equal(f.consumed.length,1);assert.equal(f.pm.lastError,null);assert.equal(f.diagnostics.length,0);
  assert.equal(f.pm.history().filter(e=>e.error).length,0);assert.match(f.pm.history().at(-1).text,/stopped|cancel/i);
});
for(const code of ['rate_limit','overloaded'])test(`SDK-recovered ${code} does not persist a failure`,async t=>{
  const f=fixture(t,[{type:'assistant',error:code,message:{content:[{type:'text',text:'Temporary capacity error'}]}},{type:'result',is_error:false,subtype:'success',result:'Recovered in SDK'}]);
  f.pm.send('hello');await settle(()=>f.events.some(e=>e.type==='turn_end'));
  assert.equal(f.consumed.length,1);assert.equal(f.pm.lastError,null);assert.equal(f.diagnostics.length,0);
  assert.equal(f.pm.history().filter(e=>e.error).length,0);assert.equal(f.pm.history().at(-1).text,'Recovered in SDK');
});
test('restart reconciles an unanswered user entry, once, without replaying it',async t=>{
  const f=fixture(t,[],'eof');f.pm.send('fixture turn');await f.running;f.pm.close();
  writeFileSync(PM_HISTORY_FILE,JSON.stringify({role:'user',text:'delivery unknown'})+'\n'+JSON.stringify({role:'tool',name:'Read'})+'\n');
  for(let i=0;i<2;i++){
    const pm=new ProjectManager({} as any);let finish!:()=>void;const done=new Promise<void>(r=>finish=r);let received=0;
    (pm as any).queryFactory=({prompt}:any)=>({close:finish,async *[Symbol.asyncIterator](){void prompt.next().then(()=>received++);await done;}});
    const running=pm.start();
    try {assert.equal(pm.history().filter(e=>/Foreman restarted; delivery cannot be confirmed. Message was not replayed./.test(e.text)).length,1);assert.equal(received,0);}
    finally {pm.close();await running;}
  }
});
test('truncated output is persisted before the failure explanation',async t=>{
  const f=fixture(t,[{type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Partial answer'}}},{type:'result',is_error:true,subtype:'error_during_execution',errors:['Connection lost']}]);
  f.pm.send('hello');await settle(()=>f.events.some(e=>e.type==='turn_end'));
  const history=f.pm.history();assert.equal(history[1].text,'Partial answer');assert.equal(history.at(-1).error,true);
});


test('repeated synchronous startup rejection retains input without duplicate failure lines', async t => {
  writeFileSync(PM_HISTORY_FILE, ''); writeFileSync(PM_SESSION_FILE, '');
  const pm = new ProjectManager({} as any);
  t.mock.method(console, 'error', () => {});
  (pm as any).queryFactory = () => { throw new Error('spawn ENOENT'); };
  await pm.start();
  for (const text of ['retry one', 'retry two']) {
    pm.send(text); // start() settles asynchronously, as it does for provider launch failure.
    await settle(() => !(pm as any).running);
  }
  assert.deepEqual(pm.history().filter(e => e.role === 'user').map(e => e.text), ['retry one', 'retry two']);
  assert.equal(pm.history().filter(e => e.error).length, 1);
  pm.close();
});

// A scripted provider: every launch runs `script` with its own close/interrupt signals, and the
// harness records each launch's resume id plus exactly which inputs the provider consumed.
type Launch = { resume?: string; closed: boolean; interrupts: number };
type Ctx = { launch: number; resume?: string; next: () => Promise<string | undefined>; closed: Promise<void>; interrupted: Promise<void> };
function scripted(t: any, script: (ctx: Ctx) => AsyncGenerator<any>, sessionFile = '') {
  writeFileSync(PM_HISTORY_FILE, ''); writeFileSync(PM_SESSION_FILE, sessionFile);
  const pm = new ProjectManager({} as any);
  const events: any[] = [], diagnostics: any[] = [], consumed: string[] = [], launches: Launch[] = [];
  pm.on('event', (event) => events.push(event));
  t.mock.method(console, 'error', (...args: any[]) => diagnostics.push(args));
  (pm as any).queryFactory = ({ prompt, options }: any) => {
    const launch: Launch = { resume: options.resume, closed: false, interrupts: 0 };
    const index = launches.push(launch) - 1;
    let close!: () => void, interrupt!: () => void;
    const closed = new Promise<void>((r) => { close = r; }), interrupted = new Promise<void>((r) => { interrupt = r; });
    const next = async () => {
      const input = await prompt.next();
      if (input.done) return undefined;
      consumed.push(input.value.message.content); return input.value.message.content;
    };
    return {
      close: () => { launch.closed = true; close(); },
      interrupt: async () => { launch.interrupts++; interrupt(); },
      [Symbol.asyncIterator]: () => script({ launch: index, resume: options.resume, next, closed, interrupted }),
    };
  };
  t.after(() => pm.close());
  return { pm, events, diagnostics, consumed, launches };
}
const quiet = () => new Promise((resolve) => setTimeout(resolve, 30));
const stoppedEntries = (pm: any) => pm.history().filter((e: any) => /stopped at your request/.test(e.text ?? ''));

test('an interrupt whose turn produced no result does not relabel the next turn\'s provider failure as a Stop', async (t) => {
  const f = scripted(t, async function* ({ next, closed }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next(); // the interrupted turn: the provider never answers it
    await next();
    yield { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['Provider unavailable'] };
    await closed;
  });
  const running = f.pm.start(); t.after(() => running);
  f.pm.send('first'); await settle(() => f.consumed.length === 1);
  await f.pm.interrupt(); assert.equal(f.launches[0].interrupts, 1);
  f.pm.send('second'); await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.deepEqual(f.consumed, ['first', 'second']);
  assert.match(f.pm.lastError!, /Provider unavailable/);
  assert.equal(f.events.find((e) => e.type === 'turn_end').is_error, true);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
  assert.equal(stoppedEntries(f.pm).length, 0);
  assert.equal(f.diagnostics.length, 1);
});

test('aborted_tools is an SDK abort and settles as a Stop without a failure', async (t) => {
  const f = fixture(t, [{ type: 'result', is_error: true, subtype: 'error_during_execution', terminal_reason: 'aborted_tools', errors: ['aborted'] }]);
  f.pm.lastError = 'Old failure';
  f.pm.send('stop during a tool round'); // no local interrupt: the terminal_reason alone decides
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.consumed.length, 1); assert.equal(f.pm.lastError, null); assert.equal(f.diagnostics.length, 0);
  assert.equal(f.pm.history().filter((e) => e.error).length, 0);
  assert.equal(stoppedEntries(f.pm).length, 1);
  assert.equal(f.events.find((e) => e.type === 'turn_end').is_error, false);
});

test('a non-abort terminal_reason is a failure even when an interrupt was raised for the turn', async (t) => {
  const f = scripted(t, async function* ({ next, interrupted, closed }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next(); await interrupted;
    yield { type: 'result', is_error: true, subtype: 'error_during_execution', terminal_reason: 'api_error', errors: ['API Error: 500 upstream'] };
    await closed;
  });
  const running = f.pm.start(); t.after(() => running);
  f.pm.send('hello'); await settle(() => f.consumed.length === 1);
  await f.pm.interrupt();
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.launches[0].interrupts, 1);
  assert.match(f.pm.lastError!, /API Error: 500 upstream/);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
  assert.equal(stoppedEntries(f.pm).length, 0);
  assert.equal(f.events.find((e) => e.type === 'turn_end').is_error, true);
});

test('an interrupted turn whose result carries no terminal_reason still settles as a Stop', async (t) => {
  const f = scripted(t, async function* ({ next, interrupted, closed }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next(); await interrupted;
    yield { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['aborted'] };
    await closed;
  });
  const running = f.pm.start(); t.after(() => running);
  f.pm.send('stop this'); await settle(() => f.consumed.length === 1);
  await f.pm.interrupt();
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.launches[0].interrupts, 1);
  assert.equal(f.pm.lastError, null); assert.equal(f.diagnostics.length, 0);
  assert.equal(stoppedEntries(f.pm).length, 1);
});

test('a send-triggered restart whose resume is rejected as missing clears the session and answers the new input in a fresh session', async (t) => {
  const f = scripted(t, async function* ({ launch, next, closed }) {
    if (launch === 0) return; // the PM's provider exits; the saved session is left behind
    if (launch === 1) throw new Error('No conversation found with session ID: stale-session');
    yield { type: 'system', subtype: 'init', session_id: 'fresh-session', tools: [] };
    await next();
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Fresh answer' }] } };
    yield { type: 'result', is_error: false, subtype: 'success', result: 'Fresh answer' };
    await closed;
  }, 'stale-session');
  await f.pm.start();
  assert.equal(f.launches.length, 1); assert.equal((f.pm as any).running, false);
  f.pm.send('new input');
  await settle(() => f.pm.history().some((e) => e.role === 'assistant' && e.text === 'Fresh answer'));
  await quiet();
  assert.deepEqual(f.launches.map((l) => l.resume), ['stale-session', 'stale-session', undefined]);
  assert.equal(f.launches[1].closed, true);
  assert.deepEqual(f.consumed, ['new input']); // delivered once, to the fresh session only
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), 'fresh-session');
  assert.equal(f.pm.lastError, null);
});

test('a missing-conversation rejection after input was consumed clears the session, fails loudly and never re-sends', async (t) => {
  const f = scripted(t, async function* ({ launch, next, closed }) {
    if (launch === 0) {
      await next();
      throw new Error('No conversation found with session ID: stale-session');
    }
    yield { type: 'system', subtype: 'init', session_id: 'fresh-session', tools: [] };
    await next();
    yield { type: 'result', is_error: false, subtype: 'success', result: 'Fresh answer' };
    await closed;
  }, 'stale-session');
  f.pm.send('consumed by the rejected attempt');
  await settle(() => !(f.pm as any).running);
  await quiet();
  assert.equal(f.launches.length, 1); // no fallback run: the consumed input is not replayed
  assert.deepEqual(f.consumed, ['consumed by the rejected attempt']);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), '');
  assert.match(f.pm.lastError!, /No conversation found/);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
  // The next explicit send starts fresh instead of re-resuming the unusable session.
  f.pm.send('explicit retry');
  await settle(() => f.pm.history().some((e) => e.role === 'assistant' && e.text === 'Fresh answer'));
  assert.deepEqual(f.launches.map((l) => l.resume), ['stale-session', undefined]);
  assert.deepEqual(f.consumed, ['consumed by the rejected attempt', 'explicit retry']);
});

test('an explicit send restarts an alive-but-rejecting PM and dispatches only the new input', async (t) => {
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
  f.pm.send('failed input');
  await settle(() => !!f.pm.lastError);
  await quiet();
  assert.equal((f.pm as any).running, true); assert.equal(f.launches.length, 1);
  f.pm.send('explicit retry after login repair');
  await settle(() => f.pm.history().some((e) => e.text === 'Recovered answer'));
  await quiet();
  assert.equal(f.launches.length, 2); // exactly one new launch, no automatic retries
  assert.equal(f.launches[0].closed, true);
  assert.equal(f.launches[1].resume, 'test-session');
  assert.deepEqual(f.consumed, ['failed input', 'explicit retry after login repair']);
  assert.equal(f.pm.lastError, null);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
});

test('a PM that failed with turns still pending is not restarted, so accepted input is not dropped', async (t) => {
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
  f.pm.send('first'); f.pm.send('second'); f.pm.send('third');
  await settle(() => f.pm.history().some((e) => e.text === 'Third answer'));
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.consumed, ['first', 'second', 'third']);
  assert.equal(f.pm.lastError, null);
});

test('a non-provider error such as the restart notice does not restart a running PM', async (t) => {
  const f = scripted(t, async function* ({ next, closed }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next();
    yield { type: 'result', is_error: false, subtype: 'success', result: 'Answer' };
    await closed;
  });
  writeFileSync(PM_HISTORY_FILE, JSON.stringify({ role: 'user', text: 'delivery unknown' }) + '\n');
  const running = f.pm.start(); t.after(() => running);
  assert.match(f.pm.lastError!, /Foreman restarted/);
  f.pm.send('next message');
  await settle(() => f.pm.history().some((e) => e.text === 'Answer'));
  assert.equal(f.launches.length, 1); assert.deepEqual(f.consumed, ['next message']);
});

test('a retired provider cannot write into the PM after an explicit restart', async (t) => {
  let releaseLate!: () => void;
  const late = new Promise<void>((r) => { releaseLate = r; });
  const f = scripted(t, async function* ({ launch, next, closed }) {
    yield { type: 'system', subtype: 'init', session_id: `session-${launch}`, tools: [] };
    await next();
    if (launch === 0) {
      yield { type: 'result', is_error: true, subtype: 'success', result: 'Invalid bearer token' };
      await late; // a straggling frame from the old process after it was retired
      yield { type: 'result', is_error: true, subtype: 'success', result: 'Late stale failure' };
      return;
    }
    yield { type: 'result', is_error: false, subtype: 'success', result: 'Recovered answer' };
    await closed;
  });
  const running = f.pm.start(); t.after(() => running);
  f.pm.send('failed input'); await settle(() => !!f.pm.lastError);
  f.pm.send('retry'); await settle(() => f.pm.history().some((e) => e.text === 'Recovered answer'));
  releaseLate(); await running; await quiet();
  assert.equal(f.pm.lastError, null);
  assert.equal(f.pm.history().some((e) => /Late stale failure/.test(e.text ?? '')), false);
  assert.equal((f.pm as any).running, true);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), 'session-1');
});
