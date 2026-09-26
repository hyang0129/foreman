// Pin FOREMAN_HOME to a temp dir before any server module loads (story #121 guard).
import './fixtures/temp-foreman-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPeerTools, leadSystemPrompt, makeSessionPrep, peerMessageId, PEER_ALLOWED_TOOLS, PEER_INSTRUCTIONS, preparePeerTools, prepareSessionTools, type PeerService, type PeerSource } from '../server/peer-tools.ts';
import { LEAD_ALLOWED_TOOLS } from '../server/lead-tools.ts';
import { ProjectManager } from '../server/pm.ts';
import { SessionService } from '../server/session-service.ts';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture() {
  const sent: any[] = [];
  let source: PeerSource = 'user';
  const rows = ['a', 'b', 'c', 'external'].map((id) => ({ session_key: id, provider: 'claude', managed: id !== 'external', capabilities: { message: id !== 'external' }, state: 'idle', transcript_path: '/private/transcript', name: id }));
  const service: PeerService = {
    list: () => rows,
    detail: (id) => {
      const row = rows.find((row) => row.session_key === id);
      if (!row) throw new Error('No such session');
      return { session: row, history: [{ id: 'old', role: 'user', text: 'old'.repeat(100), at: 'now' }, { id: 'secret', role: 'tool', text: 'TOOL SECRET' }, { id: 'latest', role: 'assistant', text: 'latest'.repeat(100), at: 'now' }], receipts: [], approvals: [] };
    },
    send: (id, text, messageId, sender) => {
      const prior = sent.find((r) => r.target === id && r.id === messageId);
      if (prior) { if (prior.text !== text) throw new Error('Message id conflict'); return prior; }
      const receipt = { id: messageId, target: id, text, source: sender, status: 'queued', at: 'now' };
      sent.push(receipt); return receipt;
    },
    receipt: (id, messageId) => sent.find((r) => r.target === id && r.id === messageId),
    activeSource: () => source,
  };
  return { service, sent, setSource: (value: PeerSource) => { source = value; } };
}

test('sender is host-bound; ids are sender-scoped and retries use the same durable receipt', async () => {
  const { service, sent } = fixture();
  const peer = bindPeerTools(service, 'a');
  const input = { session: 'b', message_id: 'one', text: 'Hello' };
  await assert.rejects(peer.call('send_message', { ...input, sender: 'c' }));
  const receipt = await peer.call('send_message', input);
  const retry = await peer.call('send_message', input);
  assert.equal(receipt.id, retry.id);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].source, { sender: 'a', chain: ['a'] });
  assert.equal(sent[0].id, peerMessageId('a', 'one'));
  assert.equal((await peer.call('message_status', { session: 'b', message_id: 'one' })).status, 'queued');
  await assert.rejects(bindPeerTools(service, 'c').call('message_status', { session: 'b', message_id: 'one' }), /No matching/);
  await assert.rejects(peer.call('send_message', { ...input, text: 'Changed' }), /conflict/);
});

test('self, ancestor, excessive chain, and monitor-only sends are rejected without side effects', async () => {
  const f = fixture(), peer = bindPeerTools(f.service, 'a');
  const send = (session: string) => peer.call('send_message', { session, message_id: 'id', text: 'Hello' });
  await assert.rejects(send('a'), /itself/);
  await assert.rejects(send('external'), /monitor-only/);
  f.setSource({ sender: 'b', chain: ['b'] });
  await assert.rejects(send('b'), /ancestor/);
  f.setSource({ sender: 'c', chain: ['x', 'y', 'c'] });
  await assert.rejects(send('b'), /chain limit/);
  assert.equal(f.sent.length, 0);
});

test('transcripts have a total character bound and exclude tool payloads/private paths', async () => {
  const { service } = fixture(), peer = bindPeerTools(service, 'a');
  const tail = await peer.call('session_tail', { session: 'b', max_chars: 100 });
  assert.equal(tail.history.reduce((sum: number, entry: any) => sum + entry.text.length, 0), 100);
  assert.equal(tail.history[0].id, 'latest');
  assert.equal(tail.truncated, true);
  assert.ok(!JSON.stringify(tail).includes('TOOL SECRET'));
  const list = await peer.call('list_sessions', { limit: 2 });
  assert.equal(list.sessions.length, 2);
  assert.equal(list.next_offset, 2);
  assert.ok(!JSON.stringify(list).includes('/private/transcript'));
  await assert.rejects(peer.call('session_tail', { session: 'b', max_chars: 1_000_000 }));
});

test('request_update queues a bounded request to write status locally, without auto reply', async () => {
  const { service, sent } = fixture();
  await bindPeerTools(service, 'a').call('request_update', { session: 'b', message_id: 'update' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Do not send a peer reply/);
});

test('Codex dynamic tools return the installed app-server wire shape on success and failure', async () => {
  const { service } = fixture();
  const prepared = preparePeerTools(service, { session_key: 'a', provider: 'codex' });
  const tools = prepared.codexTools!;
  assert.equal(tools.dynamicTools[0].type, 'function');
  assert.equal(tools.dynamicTools[0].inputSchema.type, 'object');
  const success = await tools.call('session_state', { session: 'b' });
  assert.equal(success.success, true);
  assert.equal(success.contentItems[0].type, 'inputText');
  const failure = await tools.call('send_message', { session: 'a', message_id: 'id', text: 'Hi' });
  assert.equal(failure.success, false);
  assert.match(failure.contentItems[0].text, /itself/);
});

test('adding peer tools preserves PM denial of code edits, execution, and subagents', async () => {
  const pm = new ProjectManager({} as any);
  const check = (pm as any).canUseTool;
  assert.equal((await check('mcp__peers__send_message', {})).behavior, 'allow');
  assert.equal((await check('mcp__peers__execute_code', {})).behavior, 'deny');
  assert.equal((await check('Write', { file_path: '/tmp/project/index.ts' })).behavior, 'deny');
  assert.equal((await check('Bash', { command: 'npm test' })).behavior, 'deny');
  assert.equal((await check('Read', { file_path: '/tmp/project/index.ts' })).behavior, 'deny');
  assert.equal((await check('Agent', { prompt: 'write code' })).behavior, 'deny');
});

test('peer receipts survive service restart without replay or changed sender identity', async () => {
  class FakeClaude extends EventEmitter {
    send() { return { status: 'running' }; }
    pendingApprovals() { return []; }
    close() {}
  }
  const home = mkdtempSync(join(tmpdir(), 'foreman-peer-test-'));
  let launches = 0;
  const service = new SessionService({ home, claudeFactory: () => { launches++; return new FakeClaude() as any; } });
  let restored: SessionService | undefined;
  try {
    const row = await service.create({ id: 'creation', provider: 'claude', name: 'recipient', cwd: home, text: 'Initial task' });
    await new Promise((resolve) => setImmediate(resolve));
    const input = { session: row.session_key, message_id: 'persisted', text: 'Progress please' };
    const first = await bindPeerTools(service, 'foreman-pm').call('send_message', input);
    assert.equal(first.status, 'queued');
    service.close();
    restored = new SessionService({ home, claudeFactory: () => { launches++; return new FakeClaude() as any; } });
    const retry = await bindPeerTools(restored, 'foreman-pm').call('send_message', input);
    assert.equal(retry.id, first.id);
    assert.equal(retry.status, 'uncertain');
    assert.equal(launches, 1);
    assert.deepEqual(retry.source, { sender: 'foreman-pm', chain: ['foreman-pm'] });
    assert.equal(restored.detail(row.session_key).receipts.length, 2);
  } finally { restored?.close(); rmSync(home, { recursive: true, force: true }); }
});

test('peer summaries distinguish managed presets from observed provider modes', async () => {
  const {service}=fixture();
  (service.list()[0] as any).permission_mode='bypass';
  (service.list()[3] as any).permission_mode='bypassPermissions';
  const result=await bindPeerTools(service,'a').call('list_sessions',{});
  assert.equal(result.sessions[0].permission_mode,'bypass');
  assert.equal(result.sessions[3].permission_mode,undefined);
  assert.equal(result.sessions[3].provider_permission_mode,'bypassPermissions');
});

test('prepareSessionTools: a Lead gets peer tools, its bound lead server and the Lead prompt; workers and sessions get peer tools only', async () => {
  const { service } = fixture();
  const bound: string[] = [];
  const leadServer = (key: string) => { bound.push(key); return { type: 'sdk', name: 'lead', instance: {} } as any; };
  const lead = prepareSessionTools(service, { session_key: 'a', provider: 'claude', role: 'lead' }, { leadServer });
  assert.deepEqual(Object.keys(lead.claude!.mcpServers!).sort(), ['lead', 'peers']);
  assert.deepEqual(bound, ['a']);
  assert.deepEqual(lead.claude!.allowedTools, [...PEER_ALLOWED_TOOLS, ...LEAD_ALLOWED_TOOLS]);
  const append = (lead.claude!.systemPrompt as any).append as string;
  assert.ok(append.startsWith(PEER_INSTRUCTIONS));
  assert.ok(append.includes(leadSystemPrompt().trim()));
  assert.match(leadSystemPrompt(), /write_handoff/);
  assert.match(leadSystemPrompt(), /Never put a filesystem path in a handoff/);
  for (const role of ['worker', 'session', undefined]) {
    const prepared = prepareSessionTools(service, { session_key: 'b', provider: 'claude', role }, { leadServer });
    assert.deepEqual(Object.keys(prepared.claude!.mcpServers!), ['peers']);
    assert.deepEqual(prepared.claude!.allowedTools, PEER_ALLOWED_TOOLS);
    assert.equal((prepared.claude!.systemPrompt as any).append, PEER_INSTRUCTIONS);
    assert.ok(!JSON.stringify(prepared.claude!.allowedTools).includes('spawn'));
  }
  assert.deepEqual(bound, ['a']);
  // Codex workers keep the dynamic peer tools unchanged; no spawn tool is ever offered.
  const codex = prepareSessionTools(service, { session_key: 'b', provider: 'codex', role: 'worker' }, { leadServer });
  assert.deepEqual(codex.codexTools!.dynamicTools.map((t: any) => t.name), PEER_ALLOWED_TOOLS.map((n) => n.replace('mcp__peers__', '')));
  // A Lead needs its tools and Claude; the legacy alias never grants Lead tools.
  assert.throws(() => prepareSessionTools(service, { session_key: 'a', provider: 'claude', role: 'lead' }), /Lead tools are unavailable/);
  assert.throws(() => preparePeerTools(service, { session_key: 'a', provider: 'claude', role: 'lead' }), /Lead tools are unavailable/);
  assert.throws(() => prepareSessionTools(service, { session_key: 'a', provider: 'codex', role: 'lead' }, { leadServer }), /Claude only/);
  assert.deepEqual(Object.keys(makeSessionPrep(service, { leadServer })({ session_key: 'c', provider: 'claude', role: 'lead' }).claude!.mcpServers!).sort(), ['lead', 'peers']);
});
