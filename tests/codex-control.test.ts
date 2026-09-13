import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { CodexControl } from '../server/codex-control.ts';

async function fixture(t: test.TestContext, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-rpc-test-'));
  const socket = join(dir, 'rpc.sock');
  const server = createServer();
  const ws = new WebSocketServer({ server, perMessageDeflate:false });
  const sent: any[] = [];
  ws.on('connection', (peer, request) => {
    assert.equal(request.headers['sec-websocket-extensions'], undefined);
    let initialized = false;
    peer.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()); sent.push(msg);
      if (!msg.method) return;
      const reply = (result: unknown) => peer.send(JSON.stringify({ id:msg.id, result }));
      if (msg.method === 'initialize') { initialized = true; reply({}); return; }
      assert.equal(initialized, true);
      if (msg.method === 'initialized' || msg.method === 'fixture/hang') return;
      const thread = { id: msg.params.threadId ?? 'live', cwd:dir, createdAt:1, updatedAt:1,
        status:{ type:msg.params.threadId === 'stored' ? 'notLoaded' : 'idle' }, canAcceptDirectInput:true, turns:[] };
      if (msg.method === 'thread/read' || msg.method === 'thread/resume' || msg.method === 'thread/start') reply({ thread });
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
  const client = new CodexControl({ socket, timeoutMs:1000, ...options });
  t.after(async () => {
    client.close(); for (const peer of ws.clients) peer.terminate();
    ws.close(); await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive:true, force:true });
  });
  await client.connect();
  return { client, sent };
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

test('timeouts expose uncertain delivery without retrying mutations', async (t) => {
  const { client, sent } = await fixture(t, { timeoutMs:100 });
  await assert.rejects(client.request('fixture/hang'), /delivery is unknown/);
  assert.equal(sent.filter((m) => m.method === 'fixture/hang').length, 1);
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
