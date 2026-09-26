import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { CodexControl } from '../server/codex-control.ts';

// How the fixture answers account/read; set per test and reset after it.
let accountRead: 'ok' | 'hang' | 'error' | 'signed-out' = 'ok';
const TIMEOUT_MS = 1000;
async function fixture(t: test.TestContext, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-rpc-test-'));
  const socket = join(dir, 'rpc.sock');
  const server = createServer();
  const ws = new WebSocketServer({ server, perMessageDeflate:false });
  const sent: any[] = [];
  const arrivals = new EventEmitter();
  // Resolves once the fixture server has received a request for `method`: the real event a test
  // waits on, instead of assuming a fixed time is enough for delivery.
  const received = (method: string) => new Promise<void>((resolve) => {
    const check = () => { if (sent.some((m) => m.method === method)) { arrivals.off('message', check); resolve(); } };
    arrivals.on('message', check); check();
  });
  ws.on('connection', (peer, request) => {
    assert.equal(request.headers['sec-websocket-extensions'], undefined);
    let initialized = false;
    peer.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()); sent.push(msg); arrivals.emit('message');
      if (!msg.method) return;
      const reply = (result: unknown) => peer.send(JSON.stringify({ id:msg.id, result }));
      if (msg.method === 'initialize') { initialized = true; reply({}); return; }
      assert.equal(initialized, true);
      if (msg.method === 'initialized' || msg.method === 'fixture/hang') return;
      if (msg.method === 'account/read' && accountRead !== 'ok') {
        if (accountRead === 'error') peer.send(JSON.stringify({ id:msg.id, error:{ code:-32603, message:'account store unavailable' } }));
        else if (accountRead === 'signed-out') reply({ account:null, requiresOpenaiAuth:true });
        return;
      }
      const thread = { id: msg.params.threadId ?? 'live', cwd:dir, createdAt:1, updatedAt:1,
        status:{ type:msg.params.threadId === 'stored' ? 'notLoaded' : 'idle' }, canAcceptDirectInput:true, turns:[] };
      if (msg.method === 'thread/start') reply({ thread, approvalPolicy: msg.params.approvalPolicy, sandbox: {
        type: msg.params.sandbox === 'read-only' ? 'readOnly' : msg.params.sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'workspaceWrite',
        networkAccess: msg.params.config?.['sandbox_workspace_write.network_access'] ?? false,
      } });
      else if (msg.method === 'thread/read' || msg.method === 'thread/resume') reply({ thread });
      else if (msg.method === 'turn/start') {
        peer.send(JSON.stringify({ method:'turn/started', params:{ threadId:msg.params.threadId, turn:{ id:'turn-1' } } }));
        reply({ turn:{ id:'turn-1' } });
      } else if (msg.method === 'fixture/approval') {
        peer.send(JSON.stringify({ id:'approval-1', method:'item/commandExecution/requestApproval', params:{ threadId:'live', command:'test' } }));
        reply({});
      } else if (msg.method === 'fixture/resolve') {
        peer.send(JSON.stringify({ method:'serverRequest/resolved', params:{ threadId:'live', requestId:'approval-1' } })); reply({});
      } else if (msg.method === 'fixture/newer-approval') {
        peer.send(JSON.stringify({ method:'turn/started', params:{ threadId:'live', turn:{ id:'turn-2' } } }));
        peer.send(JSON.stringify({ id:'approval-2', method:'item/commandExecution/requestApproval', params:{ threadId:'live', turnId:'turn-2', command:'test' } }));
        reply({});
      } else if (msg.method === 'fixture/complete') {
        peer.send(JSON.stringify({ method:'turn/completed', params:{ threadId:'live', turn:{ id:msg.params.turnId } } })); reply({});
      } else if (msg.method === 'fixture/closed') {
        peer.send(JSON.stringify({ method:'thread/closed', params:{ threadId:'live' } })); reply({});
      } else if (msg.method === 'fixture/disconnect') peer.terminate();
      else reply({});
    });
  });
  server.listen(socket); await once(server, 'listening');
  const client = new CodexControl({ socket, timeoutMs:TIMEOUT_MS, ...options });
  t.after(async () => {
    client.close(); for (const peer of ws.clients) peer.terminate();
    ws.close(); await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive:true, force:true });
  });
  await client.connect();
  return { client, sent, dir, received };
}

// A request timeout is a timer, so tests of it drive that timer instead of shrinking the client's
// timeoutMs: the client uses the same budget for the WebSocket handshake and initialize, which a
// loaded machine can miss (#184). Enable only after connect(), so the connection is real.
async function timeOut(t: test.TestContext, received: Promise<void>, pending: Promise<unknown>) {
  await received; // the request reached the server before its timer fires
  t.mock.timers.tick(TIMEOUT_MS);
  t.mock.timers.reset();
  return pending;
}

test('attaches to live sessions but never implicitly resumes a disk-only thread', async (t) => {
  const { client, sent } = await fixture(t);
  await assert.rejects(client.attach('stored'), /not running/);
  assert.equal(sent.some((m) => m.method === 'thread/resume'), false);
  await assert.rejects(client.send('live', 'hello'), /Attach/);
  await client.attach('live'); await client.send('live', 'first');
  await assert.rejects(client.send('live', 'second'), /busy/);
  await client.send('live', 'steer', 'steer');
  assert.equal(sent.find((m) => m.method === 'turn/steer').params.expectedTurnId, 'turn-1');
  assert.deepEqual(sent.find((m) => m.method === 'thread/resume').params, { threadId:'live' });
  await client.request('fixture/closed');
  await assert.rejects(client.send('live', 'after close'), /Attach/);
  await client.attach('live');
  await client.send('live', 'new turn');
});

test('approval requires explicit matching one-time response and stale requests are rejected', async (t) => {
  const { client, sent } = await fixture(t);
  await client.request('fixture/approval');
  assert.equal(client.pendingRequests().length, 1);
  assert.equal(sent.some((m) => m.id === 'approval-1'), false);
  assert.throws(() => client.respond('approval-1', { decision:'acceptForSession' }), /one-time/);
  client.respond('approval-1', { decision:'decline' });
  await client.request('fixture/approval');
  assert.deepEqual(sent.find((m) => m.id === 'approval-1').result, { decision:'decline' });
  await client.request('fixture/resolve');
  assert.throws(() => client.respond('approval-1', { decision:'accept' }), /no longer pending/);
});

// Real-time bound: with setTimeout mocked, a request that never reaches the server would otherwise hang.
test('timeouts expose uncertain delivery without retrying mutations', { timeout:10_000 }, async (t) => {
  const { client, sent, received } = await fixture(t);
  t.mock.timers.enable({ apis:['setTimeout'] });
  await assert.rejects(timeOut(t, received('fixture/hang'), client.request('fixture/hang')), /delivery is unknown/);
  assert.equal(sent.filter((m) => m.method === 'fixture/hang').length, 1);
});

// #106: a timeout or error from account/read keeps its old behavior (the
// check passes and the launch continues) but leaves a diagnostic on stderr.
test('requireSignedIn logs a diagnostic when account/read times out or errors, and still continues', { timeout:10_000 }, async (t) => {
  t.after(() => { accountRead = 'ok'; });
  const errors = t.mock.method(console, 'error', () => {});
  for (const [mode, detail] of [['hang', /Codex account\/read timed out/], ['error', /Codex: account store unavailable/]] as const) {
    accountRead = mode; errors.mock.resetCalls();
    const { client, sent, received } = await fixture(t);
    // Mocked from here, the request timer fires only when a test ticks it, so an error reply
    // cannot lose a race with it and a hang times out exactly once.
    t.mock.timers.enable({ apis:['setTimeout'] });
    if (mode === 'hang') await timeOut(t, received('account/read'), client.requireSignedIn());
    else { await client.requireSignedIn(); t.mock.timers.reset(); }
    assert.equal(sent.filter((m) => m.method === 'account/read').length, 1);
    assert.equal(errors.mock.callCount(), 1);
    const [prefix, message] = errors.mock.calls[0].arguments;
    assert.equal(prefix, 'foreman: Codex account/read failed; continuing without the sign-in check:');
    assert.match(message, detail);
    client.close();
  }
});

test('requireSignedIn logs nothing when account/read answers', async (t) => {
  t.after(() => { accountRead = 'ok'; });
  const errors = t.mock.method(console, 'error', () => {});
  accountRead = 'ok';
  await (await fixture(t)).client.requireSignedIn();
  accountRead = 'signed-out';
  await assert.rejects((await fixture(t)).client.requireSignedIn(), /Codex is not signed in/);
  assert.equal(errors.mock.callCount(), 0);
});

test('delayed turn completion preserves a newer turn approval', async (t) => {
  const { client } = await fixture(t);
  await client.attach('live');
  await client.send('live', 'first');
  await client.request('fixture/newer-approval');
  await client.request('fixture/complete', { turnId:'turn-1' });
  assert.deepEqual(client.pendingRequests().map((request) => request.id), ['approval-2']);
  await client.request('fixture/complete', { turnId:'turn-2' });
  assert.equal(client.pendingRequests().length, 0);
  assert.throws(() => client.respond('approval-2', { decision:'accept' }), /no longer pending/);
});

test('disconnect rejects pending work and clears permission requests', async (t) => {
  const { client } = await fixture(t);
  await client.request('fixture/approval');
  await assert.rejects(client.request('fixture/disconnect'), /disconnected/);
  assert.equal(client.pendingRequests().length, 0);
  await assert.rejects(client.read('live'), /not initialized/);
});

for (const mode of ['native', 'bypass'] as const) {
  test(`Codex ${mode} uses the native shell and checks the reported mode`, async (t) => {
    const { client, sent } = await fixture(t);
    await client.start('/tmp', {}, mode);
    const params = sent.find((m) => m.method === 'thread/start').params;
    assert.equal(params.sandbox, mode === 'bypass' ? 'danger-full-access' : 'workspace-write');
    assert.equal(params.approvalPolicy, mode === 'bypass' ? 'never' : 'on-request');
    assert.equal(params.approvalsReviewer, 'user');
    assert.equal(params.dynamicTools, undefined);
    assert.deepEqual(params.config, mode === 'native' ? { 'sandbox_workspace_write.network_access': false } : undefined);
    assert.equal(sent.some((m) => ['config/read', 'hooks/list'].includes(m.method)), false);
    await client.send('live', 'Run a native command');
    await assert.rejects(client.start('/tmp', { approvalPolicy: 'never' }, 'native'), /overrides/);
  });
}

test('Codex omitted mode uses native workspace and interactive approvals', async (t) => {
  const { client, sent } = await fixture(t);
  await client.start('/tmp');
  const params = sent.find((m) => m.method === 'thread/start').params;
  assert.equal(params.sandbox, 'workspace-write'); assert.equal(params.approvalPolicy, 'on-request');
});

for (const mismatch of [
  { approvalPolicy: 'never' },
  { sandbox: { type: 'dangerFullAccess' } },
  { sandbox: { type: 'workspaceWrite', networkAccess: true } },
  { sandbox: { type: 'workspaceWrite' } },
]) test(`Codex does not activate a mismatched native mode: ${JSON.stringify(mismatch)}`, async (t) => {
  const { client, sent } = await fixture(t);
  const request = client.request.bind(client);
  client.request = (async (method: string, params: any) => {
    const result: any = await request(method, params);
    return method === 'thread/start' ? { ...result, ...mismatch } : result;
  }) as typeof client.request;
  await assert.rejects(client.start('/tmp'), /did not apply the requested native mode/);
  await assert.rejects(client.send('live', 'must never reach provider'), /Attach/);
  assert.equal(sent.some((m) => m.method === 'turn/start'), false);
});

test('native permission requests cannot silently persist a wider grant', async (t) => {
  const {client, sent} = await fixture(t);
  await client.start('/tmp');
  (client as any).receive(JSON.stringify({id:'permissions',method:'item/permissions/requestApproval',params:{threadId:'live',permissions:{network:true},scope:'session'}})+'\n');
  await client.request('fixture/approval');
  assert.deepEqual(sent.find((m) => m.id === 'permissions').result, {permissions:{},scope:'turn'});
});

test('native approval forwards only the decision and interruption invalidates pending approvals', async (t) => {
  const { client, sent } = await fixture(t);
  await client.start('/tmp'); await client.send('live', 'work');
  await client.request('fixture/approval');
  client.respond('approval-1', {decision:'accept', permissions:{network:true}, execPolicyAmendment:['sh']});
  await client.request('fixture/approval');
  assert.deepEqual(sent.find((m) => m.id === 'approval-1').result, {decision:'accept'});
  await client.interrupt('live');
  assert.equal(client.pendingRequests().length, 0);
  assert.throws(() => client.respond('approval-1', {decision:'accept'}), /no longer pending/);
});

test('a command announced after interrupted completion is terminated by its exact process id', async (t) => {
  const {client,sent} = await fixture(t);
  await client.start('/tmp'); await client.send('live','first');
  await client.interrupt('live');
  await client.request('fixture/complete',{turnId:'turn-1'});
  await client.request('fixture/newer-approval');
  (client as any).receive(JSON.stringify({method:'item/started',params:{threadId:'live',turnId:'turn-1',item:{type:'commandExecution',processId:'late-old-command'}}})+'\n');
  await client.request('fixture/approval');
  assert.deepEqual(sent.filter((m) => m.method === 'thread/backgroundTerminals/terminate').map((m) => m.params),
    [{threadId:'live',processId:'late-old-command'}]);
  assert.equal(sent.filter((m) => m.method === 'thread/backgroundTerminals/clean').length,1);
  assert.ok(client.pendingRequests().some((request) => request.id === 'approval-2'));
});

for (const event of [
  {method:'thread/archived',params:{threadId:'live'}},
  {method:'thread/status/changed',params:{threadId:'live',status:{type:'notLoaded'}}},
]) test(`${event.method} detaches a terminal thread and invalidates pending approvals`, async (t) => {
  const {client} = await fixture(t);
  await client.start('/tmp'); await client.send('live','work');
  await client.request('fixture/approval');
  (client as any).receive(JSON.stringify(event)+'\n');
  assert.equal(client.pendingRequests().length,0);
  await assert.rejects(client.send('live','after unload'),/Attach/);
  // A socket client has no authority to kill the shared external server.
  await client.request('fixture/approval');
});

test('an interrupted late command without a native process handle retires the controller', async (t) => {
  const {client} = await fixture(t);
  await client.start('/tmp'); await client.send('live','work'); await client.interrupt('live');
  (client as any).receive(JSON.stringify({method:'item/started',params:{threadId:'live',turnId:'turn-1',item:{type:'commandExecution',processId:null}}})+'\n');
  await assert.rejects(client.read('live'),/not initialized/);
});
