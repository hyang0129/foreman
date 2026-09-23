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
