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
    let initialized = false, toolSeq = 0;
    peer.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()); sent.push(msg);
      if (!msg.method) return;
      const reply = (result: unknown) => peer.send(JSON.stringify({ id:msg.id, result }));
      if (msg.method === 'initialize') { initialized = true; reply({}); return; }
      assert.equal(initialized, true);
      if (msg.method === 'initialized' || msg.method === 'fixture/hang') return;
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
      } else if (msg.method === 'fixture/tool') {
        const id = `dynamic-${++toolSeq}`;
        peer.send(JSON.stringify({ id, method: 'item/tool/call', params: { threadId: 'live', tool: 'foreman_exec', arguments: msg.params } }));
        reply({ id });
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
  return { client, sent, dir };
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

for (const policy of ['read-only', 'workspace', 'trusted', 'full'] as const) {
  test(`Codex ${policy} maps the launch policy and snapshots an executable deny guard`, async (t) => {
    const { client, sent } = await fixture(t);
    await client.start('/tmp', {}, policy);
    const launch = sent.find((m) => m.method === 'thread/start').params;
    assert.equal(launch.sandbox, policy === 'full' ? 'danger-full-access' : policy === 'read-only' ? 'read-only' : 'workspace-write');
    assert.equal(launch.approvalPolicy, policy === 'workspace' ? 'on-request' : 'never');
    assert.equal(launch.config['sandbox_workspace_write.network_access'], policy === 'trusted');
    const { spawnSync } = await import('node:child_process');
    const hook = launch.config['hooks.PreToolUse'][0].hooks[0].command;
    const check = (tool_name: string, tool_input: any) => {
      const result = spawnSync('/bin/sh', ['-c', hook], { input: JSON.stringify({ tool_name, tool_input }), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout).hookSpecificOutput;
    };
    assert.equal(check('Read', { file_path: '/tmp/ordinary.txt' }).permissionDecision, 'allow');
    assert.equal(check('Read', { file_path: '/tmp/.claude/settings.json' }).permissionDecision, 'deny');
    assert.equal(check('request_permissions', { permissions: { network: true } }).permissionDecision, 'deny');
    const command = check('Bash', { command: 'pwd' });
    assert.equal(command.permissionDecision, 'deny');
    assert.equal(launch.config['features.shell_tool'], false);
    assert.equal(check('foreman_exec', { command: 'pwd' }).permissionDecision, 'allow');
    if (policy === 'read-only') assert.equal(check('Write', { file_path: '/tmp/new.txt' }).permissionDecision, 'deny');
    await assert.rejects(client.start('/tmp', { approvalPolicy: 'never' }, 'workspace'), /overrides/);
  });
}
test('Codex omitted policy preserves Workspace defaults', async (t) => {
  const { client, sent } = await fixture(t);
  await client.start('/tmp');
  const params = sent.find((m) => m.method === 'thread/start').params;
  assert.equal(params.sandbox, 'workspace-write'); assert.equal(params.approvalPolicy, 'on-request');
});

test('Codex host commands use exact one-time approvals and retain the deny list after approval', async (t) => {
  const { client, sent, dir } = await fixture(t);
  await client.start(dir, {}, 'workspace');
  const pending = await client.request<{id:string}>('fixture/tool', {command:'pwd', request_access:true, yield_ms:1000});
  const approval = client.pendingRequests().find((r) => String(r.id).startsWith('foreman-command:'))!;
  assert.ok(approval);
  assert.equal(approval.params.command, 'pwd');
  assert.throws(() => client.respond(approval.id, {decision:'acceptForSession'}), /one-time/);
  client.respond(approval.id, {decision:'accept'});
  assert.throws(() => client.respond(approval.id, {decision:'accept'}), /no longer pending/);
  for (let i=0; i<100 && !sent.some((m) => m.id === pending.id && m.result); i++) await new Promise((resolve) => setTimeout(resolve,20));
  const response = sent.find((m) => m.id === pending.id && m.result)?.result;
  assert.equal(response?.success, true);
  assert.equal(JSON.parse(response.contentItems[0].text).exit_code, 0);
  assert.equal(sent.some((m) => m.id === approval.id && m.result), false, 'host approval must not be sent to the native app-server');
  const second = await client.request<{id:string}>('fixture/tool', {command:'pwd', request_access:true});
  assert.ok(client.pendingRequests().some((r) => String(r.id).startsWith('foreman-command:')));
  client.close();
  assert.equal(client.pendingRequests().length, 0);
});
