import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
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
// `next` is input the provider processed; `pull` is input the SDK read off the prompt iterable
// (it reads eagerly, like streamInput) that the provider never processed.
type Launch = { resume?: string; closed: boolean; interrupts: number; consumed: string[]; pulled: string[] };
type Ctx = { launch: number; resume?: string; next: () => Promise<string | undefined>; pull: () => Promise<string | undefined>; closed: Promise<void>; interrupted: Promise<void> };
function scripted(t: any, script: (ctx: Ctx) => AsyncGenerator<any>, sessionFile = '') {
  writeFileSync(PM_HISTORY_FILE, ''); writeFileSync(PM_SESSION_FILE, sessionFile);
  const pm = new ProjectManager({} as any);
  const events: any[] = [], diagnostics: any[] = [], consumed: string[] = [], launches: Launch[] = [];
  pm.on('event', (event) => events.push(event));
  t.mock.method(console, 'error', (...args: any[]) => diagnostics.push(args));
  (pm as any).queryFactory = ({ prompt, options }: any) => {
    const launch: Launch = { resume: options.resume, closed: false, interrupts: 0, consumed: [], pulled: [] };
    const index = launches.push(launch) - 1;
    let close!: () => void, interrupt!: () => void;
    const closed = new Promise<void>((r) => { close = r; }), interrupted = new Promise<void>((r) => { interrupt = r; });
    const next = async () => {
      const input = await prompt.next();
      if (input.done) return undefined;
      consumed.push(input.value.message.content); launch.consumed.push(input.value.message.content);
      return input.value.message.content;
    };
    const pull = async () => {
      const input = await prompt.next();
      if (input.done) return undefined;
      launch.pulled.push(input.value.message.content); return input.value.message.content;
    };
    return {
      close: () => { launch.closed = true; close(); },
      interrupt: async () => { launch.interrupts++; interrupt(); },
      [Symbol.asyncIterator]: () => script({ launch: index, resume: options.resume, next, pull, closed, interrupted }),
    };
  };
  t.after(() => pm.close());
  return { pm, events, diagnostics, consumed, launches };
}
const quiet = () => new Promise((resolve) => setTimeout(resolve, 30));
const stoppedEntries = (pm: any) => pm.history().filter((e: any) => /stopped at your request/.test(e.text ?? ''));

test('an interrupt whose turn produced no result does not relabel the next turn\'s provider failure as a Stop', { timeout: 10_000 }, async (t) => {
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

test('aborted_tools is an SDK abort and settles as a Stop without a failure', { timeout: 10_000 }, async (t) => {
  const f = fixture(t, [{ type: 'result', is_error: true, subtype: 'error_during_execution', terminal_reason: 'aborted_tools', errors: ['aborted'] }]);
  f.pm.lastError = 'Old failure';
  f.pm.send('stop during a tool round'); // no local interrupt: the terminal_reason alone decides
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
  f.pm.send('hello'); await settle(() => f.consumed.length === 1);
  await f.pm.interrupt();
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.launches[0].interrupts, 1);
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
  f.pm.send('stop this'); await settle(() => f.consumed.length === 1);
  await f.pm.interrupt();
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.launches[0].interrupts, 1);
  assert.equal(f.pm.lastError, null); assert.equal(f.diagnostics.length, 0);
  assert.equal(stoppedEntries(f.pm).length, 1);
});

test('a send-triggered restart whose resume is rejected as missing clears the session and answers the new input in a fresh session', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ launch, next, pull, closed }) {
    if (launch === 0) return; // the PM's provider exits; the saved session is left behind
    if (launch === 1) {
      await pull(); // the SDK reads the input eagerly; the CLI then rejects --resume with no frame
      throw new Error('No conversation found with session ID: stale-session');
    }
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
  assert.deepEqual(f.launches[1].pulled, ['new input']); // the rejected attempt did read it
  assert.deepEqual(f.launches[2].consumed, ['new input']);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), 'fresh-session');
  assert.equal(f.pm.lastError, null);
  // Only the original PM's exit is an error; the rejected resume is not reported as a failure.
  assert.equal(f.pm.history().filter((e) => e.error && /No conversation found/.test(e.text)).length, 0);
});

for (const [kind, frame] of [
  ['system/init', { type: 'system', subtype: 'init', session_id: 'stale-session', tools: [] }],
  ['stream_event', { type: 'stream_event', event: { type: 'message_start' } }],
] as const) test(`a missing-conversation rejection after a provider frame (${kind}) clears the session, fails loudly and never re-sends`, { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ launch, next, closed }) {
    if (launch === 0) {
      yield frame; // the provider did something, so the input may have been processed
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
  assert.equal(f.pm.history().filter((e) => e.role === 'assistant').length, 0);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), '');
  assert.match(f.pm.lastError!, /No conversation found/);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
  // The next explicit send starts fresh instead of re-resuming the unusable session.
  f.pm.send('explicit retry');
  await settle(() => f.pm.history().some((e) => e.role === 'assistant' && e.text === 'Fresh answer'));
  assert.deepEqual(f.launches.map((l) => l.resume), ['stale-session', undefined]);
  assert.deepEqual(f.consumed, ['consumed by the rejected attempt', 'explicit retry']);
});

test('an explicit send restarts an alive-but-rejecting PM and dispatches only the new input', { timeout: 10_000 }, async (t) => {
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
  f.pm.send('first'); f.pm.send('second'); f.pm.send('third');
  await settle(() => f.pm.history().some((e) => e.text === 'Third answer'));
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.consumed, ['first', 'second', 'third']);
  assert.equal(f.pm.lastError, null);
});

test('a non-provider error such as the restart notice does not restart a running PM', { timeout: 10_000 }, async (t) => {
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
  f.pm.send('failed input'); await settle(() => !!f.pm.lastError);
  f.pm.send('retry'); await settle(() => f.pm.history().some((e) => e.text === 'Recovered answer'));
  releaseLate(); await running; await quiet();
  assert.equal(f.pm.lastError, null);
  assert.equal(f.pm.history().some((e) => /Late stale failure/.test(e.text ?? '')), false);
  assert.equal((f.pm as any).running, true);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), 'session-1');
  assert.equal(f.pm.sessionId, 'session-1');
  assert.equal(f.events.some((e) => e.type === 'status' && /late-sta/.test(e.text)), false);
});

test('a rejected resume whose fresh session also fails is not requeued again', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ launch, pull }) {
    await pull();
    throw new Error(`No conversation found with session ID: ${launch === 0 ? 'stale-session' : 'fresh'}`);
  }, 'stale-session');
  f.pm.send('new input');
  await settle(() => !(f.pm as any).running);
  await quiet();
  assert.deepEqual(f.launches.map((l) => l.resume), ['stale-session', undefined]); // one fallback only
  assert.deepEqual(f.launches.map((l) => l.pulled), [['new input'], ['new input']]);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), '');
  assert.match(f.pm.lastError!, /No conversation found/);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
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
  f.pm.send('first'); await settle(() => f.consumed.length === 1);
  await f.pm.interrupt(); assert.equal(f.launches[0].interrupts, 1);
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
  f.pm.send('failed input'); await settle(() => !!f.pm.lastError);
  f.pm.send('retry'); await settle(() => f.pm.history().some((e) => e.text === 'Recovered answer'));
  await settle(() => released); // the retired stream completed instead of leaking a stuck reader
  assert.deepEqual(f.launches[0].consumed, ['failed input']);
  assert.deepEqual(f.launches[1].consumed, ['retry']);
  stderr[0]('error: late output from the retired process');
  assert.equal(f.events.some((e) => e.type === 'status' && /retired process/.test(e.text)), false);
  stderr[1]('error: output from the live process');
  assert.equal(f.events.some((e) => e.type === 'status' && /live process/.test(e.text)), true);
});

// The real SDK reads prompt input eagerly (query() starts streamInput at once). Drive the real
// query() against a stub CLI so the fallback is proven against that behavior, with no model spend.
// The `-result` modes mirror the installed CLI (0.3.270) in SDK (stream-json) mode: on a rejected
// --resume it writes the diagnostic to stderr AND prints an `error_during_execution` result whose
// `errors` is [diagnostic] to stdout, before any system/init and without reading stdin, then exits 1.
function stubCli(mode: 'reject' | 'init-then-reject' | 'invalid-handle' | 'reject-result' | 'invalid-handle-result' | 'init-then-reject-result') {
  const dir = mkdtempSync(join(home, 'stub-cli-'));
  const path = join(dir, 'claude.mjs'), log = join(dir, 'log.jsonl');
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + '\\n');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const resume = process.argv.slice(2).find((a) => a.startsWith('--resume'));
log({ resume: resume ? resume.split('=')[1] : null });
const mode = ${JSON.stringify(mode)};
if (resume) {
  if (mode.startsWith('init-then-reject')) out({ type: 'system', subtype: 'init', session_id: 'stale-session', tools: [] });
  const diagnostic = (mode.startsWith('invalid-handle') ? 'Invalid resume handle: ' : 'No conversation found with session ID: ') + resume.split('=')[1];
  process.stderr.write(diagnostic + '\\n');
  if (mode.endsWith('-result')) {
    const result = { type: 'result', subtype: 'error_during_execution', duration_ms: 0, duration_api_ms: 0, is_error: true, num_turns: 0, stop_reason: null, session_id: '00000000-0000-4000-8000-000000000000', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, modelUsage: {}, permission_denials: [], uuid: '00000000-0000-4000-8000-000000000001', errors: [diagnostic], result_index: 0 };
    await new Promise((flushed) => process.stdout.write(JSON.stringify(result) + '\\n', flushed));
  }
  process.exit(1);
}
let inited = false;
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const m = JSON.parse(line);
  if (m.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); continue; }
  if (m.type !== 'user') continue;
  log({ input: m.message.content });
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: 'fresh-session', tools: [] }); }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'echo: ' + m.message.content }] }, session_id: 'fresh-session' });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'echo: ' + m.message.content, session_id: 'fresh-session', total_cost_usd: 0 });
}
`, { mode: 0o755 });
  return { path, entries: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}
function realSdkPm(t: any, cli: string) {
  writeFileSync(PM_HISTORY_FILE, ''); writeFileSync(PM_SESSION_FILE, 'stale-session');
  const pm = new ProjectManager({} as any);
  const diagnostics: any[] = [], resumes: (string | undefined)[] = [];
  t.mock.method(console, 'error', (...args: any[]) => diagnostics.push(args));
  t.mock.method(process, 'emitWarning', () => {});
  (pm as any).queryFactory = (args: any) => {
    resumes.push(args.options.resume);
    return query({ ...args, options: { ...args.options, pathToClaudeCodeExecutable: cli } });
  };
  t.after(() => pm.close());
  return { pm, diagnostics, resumes };
}

test('real SDK: a send-triggered resume rejected before any frame is answered once by a fresh session', { timeout: 10_000 }, async (t) => {
  const cli = stubCli('reject');
  const f = realSdkPm(t, cli.path);
  f.pm.send('new input');
  await settle(() => f.pm.history().some((e) => e.role === 'assistant'));
  await quiet();
  assert.deepEqual(f.resumes, ['stale-session', undefined]);
  assert.deepEqual(cli.entries(), [{ resume: 'stale-session' }, { resume: null }, { input: 'new input' }]);
  assert.equal(f.pm.history().find((e) => e.role === 'assistant').text, 'echo: new input');
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), 'fresh-session');
  assert.equal(f.pm.lastError, null);
  assert.equal(f.diagnostics.length, 0);
});

test('real SDK: a resume rejected after a provider frame fails loudly without a second launch', { timeout: 10_000 }, async (t) => {
  const cli = stubCli('init-then-reject');
  const f = realSdkPm(t, cli.path);
  f.pm.send('new input');
  await settle(() => !(f.pm as any).running);
  await quiet();
  assert.deepEqual(f.resumes, ['stale-session']);
  assert.deepEqual(cli.entries(), [{ resume: 'stale-session' }]);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), '');
  assert.match(f.pm.lastError!, /No conversation found/);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
});

// Session quarantine (#34). The record lives next to the session file, one JSON line per
// abandoned session id: { ts, session_id, reason }.
const QUARANTINE_FILE = `${PM_SESSION_FILE}.quarantine.jsonl`;
const quarantined = () => (existsSync(QUARANTINE_FILE) ? readFileSync(QUARANTINE_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const freshAnswer = async function* ({ next, closed }: Ctx) {
  yield { type: 'system', subtype: 'init', session_id: 'fresh-session', tools: [] };
  await next();
  yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Fresh answer' }] } };
  yield { type: 'result', is_error: false, subtype: 'success', result: 'Fresh answer' };
  await closed;
};

test('an invalid resume handle quarantines the saved session, fails loudly, replays nothing, and the next send starts fresh', { timeout: 10_000 }, async (t) => {
  rmSync(QUARANTINE_FILE, { force: true });
  const f = scripted(t, async function* (ctx) {
    if (ctx.resume === 'stale-session') {
      await ctx.pull(); // the SDK reads the input eagerly; the CLI rejects the handle with no frame
      throw new Error('Claude Code process exited with code 1. stderr: Invalid resume handle: stale-session');
    }
    yield* freshAnswer(ctx);
  }, 'stale-session');
  f.pm.send('failed input');
  await settle(() => !(f.pm as any).running);
  await quiet();
  // Loud failure, no automatic fallback run and no replay.
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.launches[0].pulled, ['failed input']);
  assert.deepEqual(f.consumed, []);
  assert.match(f.pm.lastError!, /Invalid resume handle/);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
  assert.match(f.pm.history().find((e) => e.error).text, /Invalid resume handle/);
  assert.equal(f.diagnostics.length, 1);
  // Quarantined, not deleted: the id and diagnostic are on record and the active file is cleared.
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), '');
  const records = quarantined();
  assert.equal(records.length, 1);
  assert.equal(records[0].session_id, 'stale-session');
  assert.match(records[0].reason, /Invalid resume handle: stale-session/);
  assert.ok(!Number.isNaN(Date.parse(records[0].ts)));
  assert.equal(statSync(QUARANTINE_FILE).mode & 0o777, 0o600);
  // The next explicit send launches without the stale id and delivers only the new input.
  f.pm.send('explicit retry');
  await settle(() => f.pm.history().some((e) => e.role === 'assistant' && e.text === 'Fresh answer'));
  await quiet();
  assert.deepEqual(f.launches.map((l) => l.resume), ['stale-session', undefined]);
  assert.deepEqual(f.launches.map((l) => l.consumed), [[], ['explicit retry']]);
  assert.deepEqual(f.launches.map((l) => l.pulled), [['failed input'], []]);
  assert.deepEqual(f.consumed, ['explicit retry']);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), 'fresh-session');
  assert.equal(f.pm.lastError, null);
  assert.equal(quarantined().length, 1);
});

test('the missing-conversation fallback records the quarantine and still answers the input once', { timeout: 10_000 }, async (t) => {
  rmSync(QUARANTINE_FILE, { force: true });
  const f = scripted(t, async function* (ctx) {
    if (ctx.resume === 'stale-session') {
      await ctx.pull();
      throw new Error('Claude Code process exited with code 1. stderr: No conversation found with session ID: stale-session');
    }
    yield* freshAnswer(ctx);
  }, 'stale-session');
  f.pm.send('new input');
  await settle(() => f.pm.history().some((e) => e.role === 'assistant' && e.text === 'Fresh answer'));
  await quiet();
  assert.deepEqual(f.launches.map((l) => l.resume), ['stale-session', undefined]);
  assert.deepEqual(f.launches.map((l) => l.pulled), [['new input'], []]);
  assert.deepEqual(f.consumed, ['new input']);
  assert.equal(f.pm.history().filter((e) => e.role === 'assistant').length, 1);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), 'fresh-session');
  assert.equal(f.pm.lastError, null);
  const records = quarantined();
  assert.equal(records.length, 1);
  assert.equal(records[0].session_id, 'stale-session');
  assert.match(records[0].reason, /No conversation found with session ID: stale-session/);
});

for (const [kind, message] of [
  ['authentication', 'Claude Code process exited with code 1. stderr: authentication_failed: Invalid API key · Please run /login'],
  ['network', 'Claude Code process exited with code 1. stderr: API Error: Connection error. (fetch failed: ECONNRESET)'],
  ['MCP transport "Session not found"', 'Claude Code process exited with code 1. stderr: MCP server "fleet": Session not found'],
] as const) test(`a pre-init ${kind} failure does not quarantine the saved session`, { timeout: 10_000 }, async (t) => {
  rmSync(QUARANTINE_FILE, { force: true });
  const f = scripted(t, async function* ({ pull }) {
    await pull();
    throw new Error(message);
  }, 'saved-session');
  f.pm.send('hello');
  await settle(() => !(f.pm as any).running);
  await quiet();
  assert.equal(f.launches.length, 1); // no fallback run
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), 'saved-session');
  assert.equal(existsSync(QUARANTINE_FILE), false);
  assert.equal(f.pm.lastError!.includes(message), true);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
  // The saved session is still the one the next start resumes.
  f.pm.send('retry');
  await settle(() => f.launches.length === 2);
  assert.deepEqual(f.launches.map((l) => l.resume), ['saved-session', 'saved-session']);
});

test('a spawn ENOENT failure does not quarantine the saved session', { timeout: 10_000 }, async (t) => {
  rmSync(QUARANTINE_FILE, { force: true });
  writeFileSync(PM_HISTORY_FILE, ''); writeFileSync(PM_SESSION_FILE, 'saved-session');
  const pm = new ProjectManager({} as any), resumes: (string | undefined)[] = [];
  t.mock.method(console, 'error', () => {});
  (pm as any).queryFactory = ({ options }: any) => { resumes.push(options.resume); throw new Error('spawn /usr/local/bin/claude ENOENT'); };
  t.after(() => pm.close());
  await pm.start();
  assert.deepEqual(resumes, ['saved-session']);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), 'saved-session');
  assert.equal(existsSync(QUARANTINE_FILE), false);
  assert.match(pm.lastError!, /ENOENT/);
});

for (const [kind, message] of [
  ['an invalid-handle diagnostic', 'Invalid resume handle: saved-session'],
  ['a provider crash', 'Claude Code process exited with code 1'],
] as const) test(`a failure after init (${kind}) does not quarantine the saved session`, { timeout: 10_000 }, async (t) => {
  rmSync(QUARANTINE_FILE, { force: true });
  const f = scripted(t, async function* ({ next }) {
    yield { type: 'system', subtype: 'init', session_id: 'saved-session', tools: [] };
    await next();
    throw new Error(message);
  }, 'saved-session');
  f.pm.send('hello');
  await settle(() => !(f.pm as any).running);
  await quiet();
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.consumed, ['hello']);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), 'saved-session');
  assert.equal(existsSync(QUARANTINE_FILE), false);
  assert.equal(f.pm.lastError!.includes(message), true);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
});

test('real SDK: an invalid resume handle before any frame quarantines, fails loudly, and the next send starts fresh', { timeout: 10_000 }, async (t) => {
  rmSync(QUARANTINE_FILE, { force: true });
  const cli = stubCli('invalid-handle');
  const f = realSdkPm(t, cli.path);
  f.pm.send('failed input');
  await settle(() => !(f.pm as any).running);
  await quiet();
  assert.deepEqual(f.resumes, ['stale-session']);
  assert.deepEqual(cli.entries(), [{ resume: 'stale-session' }]); // the rejected CLI never read stdin
  assert.match(f.pm.lastError!, /Invalid resume handle/);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), '');
  assert.deepEqual(quarantined().map((r) => r.session_id), ['stale-session']);
  assert.match(quarantined()[0].reason, /Invalid resume handle: stale-session/);
  f.pm.send('explicit retry');
  await settle(() => f.pm.history().some((e) => e.role === 'assistant'));
  await quiet();
  assert.deepEqual(f.resumes, ['stale-session', undefined]);
  assert.deepEqual(cli.entries(), [{ resume: 'stale-session' }, { resume: null }, { input: 'explicit retry' }]);
  assert.equal(f.pm.history().find((e) => e.role === 'assistant').text, 'echo: explicit retry');
  assert.equal(f.pm.lastError, null);
});

// The installed CLI reports a rejected --resume as an error result frame before any system/init
// (see stubCli). That frame is the resume rejection itself, not a processed turn.
const errorResult = (diagnostic: string) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, total_cost_usd: 0, errors: [diagnostic] });

test('real SDK: a send-triggered restart whose resume the CLI rejects with a pre-init error result is answered once by a fresh session', { timeout: 10_000 }, async (t) => {
  rmSync(QUARANTINE_FILE, { force: true });
  const cli = stubCli('reject-result');
  const f = realSdkPm(t, cli.path);
  f.pm.send('new input');
  await settle(() => f.pm.history().some((e) => e.role === 'assistant'));
  await quiet();
  assert.deepEqual(f.resumes, ['stale-session', undefined]);
  // Only the fresh process read the input; the rejected one never read stdin.
  assert.deepEqual(cli.entries(), [{ resume: 'stale-session' }, { resume: null }, { input: 'new input' }]);
  assert.deepEqual(f.pm.history().filter((e) => e.role === 'assistant').map((e) => e.text), ['echo: new input']);
  assert.equal(f.pm.history().filter((e) => e.error).length, 0);
  assert.equal(f.pm.lastError, null);
  assert.equal(f.diagnostics.length, 0);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), 'fresh-session');
  assert.deepEqual(quarantined().map((r) => r.session_id), ['stale-session']);
  assert.match(quarantined()[0].reason, /No conversation found with session ID: stale-session/);
});

test('real SDK: an invalid resume handle reported as a pre-init error result quarantines with exactly one failure', { timeout: 10_000 }, async (t) => {
  rmSync(QUARANTINE_FILE, { force: true });
  const cli = stubCli('invalid-handle-result');
  const f = realSdkPm(t, cli.path);
  f.pm.send('failed input');
  await settle(() => !(f.pm as any).running);
  await quiet();
  assert.deepEqual(f.resumes, ['stale-session']); // no automatic fresh run
  assert.deepEqual(cli.entries(), [{ resume: 'stale-session' }]);
  assert.match(f.pm.lastError!, /Invalid resume handle: stale-session/);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
  assert.equal(f.diagnostics.length, 1);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), '');
  assert.deepEqual(quarantined().map((r) => r.session_id), ['stale-session']);
  f.pm.send('explicit retry');
  await settle(() => f.pm.history().some((e) => e.role === 'assistant'));
  await quiet();
  assert.deepEqual(f.resumes, ['stale-session', undefined]);
  assert.deepEqual(cli.entries(), [{ resume: 'stale-session' }, { resume: null }, { input: 'explicit retry' }]);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
  assert.equal(f.pm.lastError, null);
});

test('real SDK: a missing-conversation error result after system/init fails loudly once and is not requeued', { timeout: 10_000 }, async (t) => {
  rmSync(QUARANTINE_FILE, { force: true });
  const cli = stubCli('init-then-reject-result');
  const f = realSdkPm(t, cli.path);
  f.pm.send('new input');
  await settle(() => !(f.pm as any).running);
  await quiet();
  assert.deepEqual(f.resumes, ['stale-session']);
  assert.deepEqual(cli.entries(), [{ resume: 'stale-session' }]);
  assert.match(f.pm.lastError!, /No conversation found with session ID: stale-session/);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
  assert.equal(f.pm.history().filter((e) => e.role === 'assistant').length, 0);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), '');
  assert.deepEqual(quarantined().map((r) => r.session_id), ['stale-session']);
});

test('a pre-init missing-conversation error result on a send-triggered restart is a resume rejection: requeued once, no failure', { timeout: 10_000 }, async (t) => {
  rmSync(QUARANTINE_FILE, { force: true });
  const f = scripted(t, async function* (ctx) {
    if (ctx.launch === 0) return; // the PM's provider exits; the stale saved session is left behind
    if (ctx.resume === 'stale-session') {
      await ctx.pull(); // the SDK reads the input eagerly; the CLI never processes it
      yield errorResult('No conversation found with session ID: stale-session');
      throw new Error('Claude Code returned an error result: No conversation found with session ID: stale-session');
    }
    yield* freshAnswer(ctx);
  }, 'stale-session');
  await f.pm.start();
  const failuresBefore = f.pm.history().filter((e) => e.error).length; // the original PM's exit
  f.pm.send('new input');
  await settle(() => f.pm.history().some((e) => e.role === 'assistant' && e.text === 'Fresh answer'));
  await quiet();
  assert.deepEqual(f.launches.map((l) => l.resume), ['stale-session', 'stale-session', undefined]);
  assert.deepEqual(f.launches.map((l) => l.pulled), [[], ['new input'], []]);
  assert.deepEqual(f.consumed, ['new input']); // delivered once, to the fresh session only
  assert.equal(f.launches[1].closed, true);
  assert.equal(f.pm.history().filter((e) => e.role === 'assistant').length, 1);
  assert.equal(f.pm.history().filter((e) => e.error).length, failuresBefore);
  assert.equal(f.pm.history().filter((e) => e.error && /No conversation found/.test(e.text)).length, 0);
  // The rejection settled no turn: only the fresh answer ended one.
  assert.deepEqual(f.events.filter((e) => e.type === 'turn_end').map((e) => e.is_error), [false]);
  assert.equal(f.pm.lastError, null);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), 'fresh-session');
  assert.deepEqual(quarantined().map((r) => r.session_id), ['stale-session']);
});

test('a pre-init invalid-handle error result quarantines with one loud failure and no replay', { timeout: 10_000 }, async (t) => {
  rmSync(QUARANTINE_FILE, { force: true });
  const f = scripted(t, async function* (ctx) {
    if (ctx.resume === 'stale-session') {
      await ctx.pull();
      yield errorResult('Invalid resume handle: stale-session');
      throw new Error('Claude Code returned an error result: Invalid resume handle: stale-session');
    }
    yield* freshAnswer(ctx);
  }, 'stale-session');
  f.pm.send('failed input');
  await settle(() => !(f.pm as any).running);
  await quiet();
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.consumed, []);
  assert.match(f.pm.lastError!, /Invalid resume handle: stale-session/);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
  assert.equal(f.diagnostics.length, 1);
  assert.equal(f.events.filter((e) => e.type === 'turn_end').length, 0);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), '');
  assert.deepEqual(quarantined().map((r) => r.session_id), ['stale-session']);
  f.pm.send('explicit retry');
  await settle(() => f.pm.history().some((e) => e.role === 'assistant' && e.text === 'Fresh answer'));
  assert.deepEqual(f.launches.map((l) => l.resume), ['stale-session', undefined]);
  assert.deepEqual(f.consumed, ['explicit retry']);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
});

test('a missing-conversation error result after system/init fails loudly exactly once and is not requeued', { timeout: 10_000 }, async (t) => {
  rmSync(QUARANTINE_FILE, { force: true });
  const f = scripted(t, async function* (ctx) {
    if (ctx.resume === 'stale-session') {
      yield { type: 'system', subtype: 'init', session_id: 'stale-session', tools: [] };
      await ctx.next(); // after init the input may have been processed
      yield errorResult('No conversation found with session ID: stale-session');
      throw new Error('Claude Code returned an error result: No conversation found with session ID: stale-session');
    }
    yield* freshAnswer(ctx);
  }, 'stale-session');
  f.pm.send('consumed input');
  await settle(() => !(f.pm as any).running);
  await quiet();
  assert.equal(f.launches.length, 1); // no requeue, no fallback run
  assert.deepEqual(f.consumed, ['consumed input']);
  assert.match(f.pm.lastError!, /No conversation found with session ID: stale-session/);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
  assert.equal(f.diagnostics.length, 1);
  assert.equal(f.pm.history().filter((e) => e.role === 'assistant').length, 0);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), '');
  assert.deepEqual(quarantined().map((r) => r.session_id), ['stale-session']);
  f.pm.send('explicit retry');
  await settle(() => f.pm.history().some((e) => e.role === 'assistant' && e.text === 'Fresh answer'));
  assert.deepEqual(f.launches.map((l) => l.resume), ['stale-session', undefined]);
  assert.deepEqual(f.consumed, ['consumed input', 'explicit retry']);
});

// The SDK's exit echo carries resultDiagnostic(m) (errors[] for an error subtype, `result` for an
// is_error success). When the failure already recorded for that result is different text, the
// echo is the only carrier of the result's own diagnostic: it must surface, never be suppressed.
const errorEntries = (pm: any): string[] => pm.history().filter((e: any) => e.error).map((e: any) => e.text);

test('a result whose errors[] differ from a preceding assistant API error keeps both diagnostics', { timeout: 10_000 }, async (t) => {
  const f = scripted(t, async function* ({ next }) {
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await next();
    yield { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'API Error: overloaded' }] } };
    yield errorResult('DISTINCT: tool runner crashed');
    throw new Error('Claude Code returned an error result: DISTINCT: tool runner crashed');
  });
  f.pm.send('input');
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
  f.pm.send('input');
  await settle(() => !(f.pm as any).running);
  await quiet();
  const entries = errorEntries(f.pm);
  assert.ok(entries.some((e) => /hook runner failed/.test(e)), 'the errors[] diagnostic is recorded');
  assert.ok(entries.some((e) => /DISTINCT: API Error 529 overloaded/.test(e)), 'the result text the SDK echoes is recorded');
  assert.match(f.pm.lastError!, /DISTINCT: API Error 529 overloaded/);
  assert.ok(f.diagnostics.some((d) => /DISTINCT: API Error 529 overloaded/.test(String(d[1]))), 'the echoed result text is logged');
});

// Reporting failures (#35). A history append or a throwing 'event' listener must never replace
// the provider cause, skip lifecycle cleanup, or block the next explicit send.
const providerDiagnostics = (diagnostics: any[]) => diagnostics.filter((d) => d[0] === 'foreman: pm failure');
const reportingFailures = (diagnostics: any[]) => diagnostics.filter((d) => d[0] === 'foreman: pm reporting failed');
// Replace a file with a directory so any write to it fails with EISDIR; restore returns a file.
function asDirectory(t: any, path: string) {
  rmSync(path, { recursive: true, force: true }); mkdirSync(path);
  const restore = () => { rmSync(path, { recursive: true, force: true }); writeFileSync(path, ''); };
  t.after(restore);
  return restore;
}
const recovered = async function* ({ next, closed }: Ctx) {
  yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
  await next();
  yield { type: 'result', is_error: false, subtype: 'success', result: 'Recovered answer' };
  await closed;
};

for (const ending of ['error result', 'thrown error'] as const)
test(`a history append failure (EISDIR) during a provider failure (${ending}) keeps the provider cause, settles start(), and a later send dispatches`, { timeout: 10_000 }, async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const f = scripted(t, async function* (ctx) {
    if (ctx.launch > 0) return yield* recovered(ctx);
    yield { type: 'system', subtype: 'init', session_id: 'test-session', tools: [] };
    await ctx.next();
    await gate;
    if (ending === 'error result') {
      yield errorResult('Original provider failure');
      throw new Error('Claude Code returned an error result: Original provider failure');
    }
    throw new Error('Original provider failure');
  });
  const running = f.pm.start();
  f.pm.send('first input');
  await settle(() => f.consumed.length === 1);
  const restore = asDirectory(t, PM_HISTORY_FILE);
  release();
  await running; // resolves: the filesystem error neither rejects start() nor skips its cleanup
  assert.match(f.pm.lastError!, /Original provider failure/);
  assert.doesNotMatch(f.pm.lastError!, /EISDIR/);
  assert.equal(f.pm.modelBusy, false);
  assert.equal((f.pm as any).running, false);
  // The provider diagnostic is logged first and exactly once; the append failure is logged apart.
  assert.equal(f.diagnostics[0][0], 'foreman: pm failure');
  assert.equal(providerDiagnostics(f.diagnostics).length, 1);
  assert.match(f.diagnostics[0][1], /Original provider failure/);
  assert.ok(reportingFailures(f.diagnostics).some((d) => /"kind":"history"/.test(d[1]) && /EISDIR/.test(d[1])));
  assert.ok(f.events.some((e) => e.type === 'status' && /Original provider failure/.test(e.text)));
  restore();
  f.pm.send('explicit retry');
  await settle(() => f.pm.history().some((e) => e.role === 'assistant' && e.text === 'Recovered answer'));
  assert.deepEqual(f.launches.map((l) => l.consumed), [['first input'], ['explicit retry']]);
  assert.equal(f.pm.lastError, null);
});

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
  f.pm.send('first input');
  await running;
  assert.deepEqual(f.consumed, ['first input']);
  assert.match(f.pm.lastError!, /Original provider failure/);
  assert.doesNotMatch(f.pm.lastError!, /listener exploded/);
  assert.equal((f.pm as any).pendingTurns, 0);
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
  // Earlier listeners still saw every event, and history still recorded the failure once.
  assert.deepEqual(f.events.filter((e) => e.type === 'turn_end').map((e) => e.is_error), [true]);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
  f.pm.send('explicit retry');
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
  f.pm.send('first');
  await settle(() => f.events.some((e) => e.type === 'turn_end'));
  assert.equal(f.pm.lastError, null);
  assert.equal((f.pm as any).pendingTurns, 0);
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
  f.pm.send('second');
  await settle(() => f.events.filter((e) => e.type === 'turn_end').length === 2);
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.consumed, ['first', 'second']);
  assert.equal(f.pm.modelBusy, false);
  assert.deepEqual(f.pm.history().filter((e) => e.role === 'assistant').map((e) => e.text), ['answer to first', 'answer to second']);
  assert.equal(f.pm.lastError, null);
  void running;
});

test('a quarantine whose session-file clear throws keeps the provider cause and the next send still starts fresh', { timeout: 10_000 }, async (t) => {
  rmSync(QUARANTINE_FILE, { force: true });
  let restore!: () => void;
  const f = scripted(t, async function* (ctx) {
    if (ctx.resume === 'stale-session') {
      await ctx.pull();
      restore = asDirectory(t, PM_SESSION_FILE); // clearing the active session file now fails
      throw new Error('Claude Code process exited with code 1. stderr: Invalid resume handle: stale-session');
    }
    yield* freshAnswer(ctx);
  }, 'stale-session');
  const running = f.pm.start();
  f.pm.send('failed input');
  await running;
  assert.match(f.pm.lastError!, /Invalid resume handle: stale-session/);
  assert.doesNotMatch(f.pm.lastError!, /EISDIR/);
  assert.equal(f.pm.modelBusy, false);
  assert.equal(f.pm.sessionId, null);
  assert.deepEqual(quarantined().map((r) => r.session_id), ['stale-session']);
  const cleared = f.diagnostics.filter((d) => d[0] === 'foreman: pm session quarantine clear failed');
  assert.equal(cleared.length, 1);
  assert.match(cleared[0][1], /stale-session/);
  assert.match(cleared[0][1], /EISDIR/);
  const provider = providerDiagnostics(f.diagnostics);
  assert.equal(provider.length, 1);
  assert.match(provider[0][1], /Invalid resume handle/);
  assert.equal(f.pm.history().filter((e) => e.error).length, 1);
  restore();
  f.pm.send('explicit retry');
  await settle(() => f.pm.history().some((e) => e.role === 'assistant' && e.text === 'Fresh answer'));
  assert.deepEqual(f.launches.map((l) => l.resume), ['stale-session', undefined]);
  assert.deepEqual(f.consumed, ['explicit retry']);
});

test('a failed quarantine record logs the session id and diagnostic, and the session is still cleared', { timeout: 10_000 }, async (t) => {
  t.after(() => rmSync(QUARANTINE_FILE, { recursive: true, force: true }));
  rmSync(QUARANTINE_FILE, { recursive: true, force: true }); mkdirSync(QUARANTINE_FILE); // appends fail
  const f = scripted(t, async function* (ctx) {
    if (ctx.resume === 'stale-session') {
      await ctx.pull();
      throw new Error('Claude Code process exited with code 1. stderr: Invalid resume handle: stale-session');
    }
    yield* freshAnswer(ctx);
  }, 'stale-session');
  const running = f.pm.start();
  f.pm.send('failed input');
  await running;
  assert.match(f.pm.lastError!, /Invalid resume handle: stale-session/);
  assert.doesNotMatch(f.pm.lastError!, /EISDIR/);
  assert.equal(readFileSync(PM_SESSION_FILE, 'utf8'), '');
  const failed = f.diagnostics.filter((d) => d[0] === 'foreman: pm session quarantine record failed');
  assert.equal(failed.length, 1);
  const logged = JSON.parse(failed[0][1]);
  assert.equal(logged.session_id, 'stale-session');
  assert.match(logged.reason, /Invalid resume handle: stale-session/);
  assert.match(logged.error, /EISDIR/);
  assert.equal(providerDiagnostics(f.diagnostics).length, 1);
  f.pm.send('explicit retry');
  await settle(() => f.pm.history().some((e) => e.role === 'assistant' && e.text === 'Fresh answer'));
  assert.deepEqual(f.launches.map((l) => l.resume), ['stale-session', undefined]);
  assert.deepEqual(f.consumed, ['explicit retry']);
});
