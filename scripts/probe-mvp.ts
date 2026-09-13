// Disposable developer journey through the actual shared service and peer tools.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { SessionService } from '../server/session-service.ts';
import { ClaudeControl } from '../server/claude-control.ts';
import { CodexControl } from '../server/codex-control.ts';
import { preparePeerTools } from '../server/peer-tools.ts';

if (!process.argv.includes('--live')) throw new Error('Pass --live for disposable Claude/Codex turns using existing provider logins.');
const directory = mkdtempSync(join(tmpdir(), 'foreman-mvp-'));
const codexControls: CodexControl[] = [];
const calls: string[] = [];
const service = new SessionService({ home: directory,
  claudeFactory: (options) => new ClaudeControl({ ...options, model: 'haiku', maxBudgetUsd: 1, maxTurns: 12, settingSources: [], tools: ['Bash'], settings: { permissions: { ask: ['Bash'] } } }),
  codexFactory: (options) => { const control = new CodexControl(options); codexControls.push(control); return control; },
});
service.setPrepare((session) => {
  const prepared = preparePeerTools(service, session);
  if (prepared.codexTools) {
    const call = prepared.codexTools.call;
    prepared.codexTools.call = async (name, args) => { calls.push(name); return call(name, args); };
  }
  return prepared;
});
async function until(check: () => boolean, label: string, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error(`${label} timed out`); await delay(100); }
}
async function completed(id: string, messageId: string) {
  await until(() => !['running', 'queued'].includes(service.receipt(id, messageId).status), messageId);
  assert.equal(service.receipt(id, messageId).status, 'completed', JSON.stringify(service.receipt(id, messageId)));
}
let approvals = 0;
service.on('session', ({ id }) => {
  for (const approval of service.detail(id).approvals) {
    if (approval.tool !== 'Bash') continue;
    approvals++;
    void service.approve(id, approval.id, 'deny').catch(() => {});
  }
});
try {
  const [claude, codex] = await Promise.all(['claude', 'codex'].map((provider) => service.create({
    id: `${provider}-seed`, provider: provider as 'claude' | 'codex', name: `MVP probe ${provider}`, cwd: directory,
    text: `Remember the token ${provider.toUpperCase()}_MVP_CONTEXT. Do not use tools. Reply READY.`,
  })));
  for (const session of [claude!, codex!]) {
    await until(() => service.detail(session.session_key).session.capabilities.message, `${session.provider} startup`, 30_000);
    service.send(session.session_key, 'Without tools, repeat the token from the preceding message.', `${session.provider}-followup`);
  }
  await Promise.all([claude!, codex!].map(async (session) => {
    await completed(session.session_key, `${session.provider}-followup`);
    assert.match(JSON.stringify(service.detail(session.session_key).history.filter((h) => h.role === 'assistant')), new RegExp(`${session.provider.toUpperCase()}_MVP_CONTEXT`));
  }));
  console.log('PASS: both providers, queued followups, context and durable receipts');
  service.send(claude!.session_key, `Use the Foreman peer tools to read session_tail for ${codex!.session_key}, then request_update for that session with message_id "mvp-update" and question "Reply with one concise current status sentence. Do not use tools or send peer messages." Do not call other tools. Then reply PEER_REQUEST_SENT.`, 'claude-peer');
  await completed(claude!.session_key, 'claude-peer');
  const peer = service.detail(codex!.session_key).receipts.find((r) => r.source !== 'user' && r.source.sender === claude!.session_key);
  assert.ok(peer, 'Claude must actually deliver a peer request through MCP');
  await completed(codex!.session_key, peer.id);
  console.log('PASS: Claude MCP → Codex peer request, attributed receipt and response');
  service.send(codex!.session_key, `Call the Foreman dynamic tools session_state and session_tail for session ${claude!.session_key}. Do not use filesystem tools or send messages. Then reply PEER_CONTEXT_READ.`, 'codex-peer');
  await completed(codex!.session_key, 'codex-peer');
  assert.ok(calls.includes('session_state') && calls.includes('session_tail'), 'Codex must actually invoke both dynamic tools');
  console.log('PASS: Codex dynamic tools read Claude state and conversation');
  service.send(claude!.session_key, 'Call Bash exactly once with command: printf FOREMAN_MVP_APPROVAL. This test will deny it. If denied, do not retry and reply DENIED.', 'claude-approval');
  await completed(claude!.session_key, 'claude-approval'); assert.ok(approvals > 0);
  console.log('PASS: one-time tool approval denial through session service');
  service.close();
  const restored = new SessionService({ home: directory });
  assert.equal(restored.receipt(claude!.session_key, 'claude-peer').status, 'completed');
  assert.ok(restored.detail(codex!.session_key).history.length > 2);
  assert.equal(restored.detail(claude!.session_key).session.capabilities.message, false);
  restored.close();
  console.log('PASS: restart retains receipts/history without replaying work');
} finally { service.close(); for (const control of codexControls) control.close(); await delay(500); rmSync(directory, { recursive: true, force: true }); }
