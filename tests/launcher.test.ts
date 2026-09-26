// Pin FOREMAN_HOME to a temp dir before any server module loads (story #121 guard).
import './fixtures/temp-foreman-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Launcher, relayLaunchDecision, launchDecisionMessageId, FOREMAN_SENDER } from '../server/launcher.ts';
import { SessionService, LAUNCH_DECISION_EVENT, type LaunchDecisionEvent } from '../server/session-service.ts';
import { effectiveDevSettings } from '../shared/roles.ts';

// Epic #157 D7: the propose flow is gone. What remains keeps the old launcher's native session
// identities hidden from the fleet (launcher-sessions.json), across restarts.

test('launcher-sessions.json keeps old launcher-owned native Claude rows hidden; nothing else is owned', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'foreman-launch-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const identityFile = join(home, 'launcher-sessions.json');
  const owned = randomUUID(), other = randomUUID();
  writeFileSync(identityFile, JSON.stringify([owned]), { mode: 0o600 });
  const launcher = new Launcher({ identityFile });
  assert.equal(launcher.ownsSession({ provider: 'claude', session_id: owned }), true);
  assert.equal(launcher.ownsSession({ provider: 'codex', session_id: owned }), false);
  assert.equal(launcher.ownsSession({ provider: 'claude', session_id: other }), false);
  // The file is only read, never rewritten.
  assert.equal(readFileSync(identityFile, 'utf8'), JSON.stringify([owned]));
});

test('no identity file owns nothing; a malformed one is refused (as before) rather than ignored', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'foreman-launch-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const missing = new Launcher({ identityFile: join(home, 'launcher-sessions.json') });
  assert.equal(missing.ownsSession({ provider: 'claude', session_id: randomUUID() }), false);
  assert.equal(new Launcher().ownsSession({ provider: 'claude', session_id: randomUUID() }), false);
  const bad = join(home, 'bad.json');
  writeFileSync(bad, JSON.stringify(['not-a-uuid']));
  assert.throws(() => new Launcher({ identityFile: bad }), /Invalid launcher session identities/);
});

test('the launcher has no propose, get or cancel API left', () => {
  const launcher: any = new Launcher();
  for (const method of ['start', 'get', 'cancel', 'close']) assert.equal(typeof launcher[method], 'undefined', method);
});

// --- launch_decision → a Foreman message to the Lead requester, and retire-on-approval ---------------

class FakeClaude extends EventEmitter {
  sent: { text: string; id: string }[] = [];
  send(text: string, id: string) { this.sent.push({ text, id }); return { id, status: 'running' }; }
  pendingApprovals() { return []; }
  complete() { this.emit('receipt', { id: this.sent.at(-1)!.id, status: 'completed' }); }
  close() {}
}
const until = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 5)); }
  assert.fail(label);
};

function decisionFixture(t: any) {
  const home = mkdtempSync(join(tmpdir(), 'foreman-decision-test-'));
  mkdirSync(join(home, 'project')); const project = realpathSync(join(home, 'project'));
  const claudes = new Map<string, FakeClaude>(); let launching: FakeClaude[] = [];
  const settings: any = { bypass_ask: true };
  const service = new SessionService({ home, env: { FOREMAN_MAX_LEADS: '10' }, claudeFactory: (() => { const c = new FakeClaude(); launching.push(c); return c; }) as any, codexFactory: () => { throw new Error('codex'); } });
  service.setGrantSource({ devSettings: async () => ({ settings: effectiveDevSettings(settings), versions: { roles: 0, bypass_grants: 0, bypass_ask: 0 }, updated_at: null }) });
  const logs: unknown[][] = []; const relayed: Promise<void>[] = []; const events: LaunchDecisionEvent[] = [];
  service.on(LAUNCH_DECISION_EVENT, (event: LaunchDecisionEvent) => { events.push(event); relayed.push(relayLaunchDecision(service, event, (...args) => logs.push(args))); });
  t.after(() => { service.close(); rmSync(home, { recursive: true, force: true }); });
  const startLead = async (name: string) => {
    launching = [];
    const result = await service.launchAgent({ id: randomUUID(), name, cwd: project, text: 'Lead the work', provider: 'claude', role: 'lead', requester_role: 'coordinator', launched_by: 'coordinator', workstream: name.replace(/^lead-/, ''), requested_mode: 'auto' });
    assert.equal(result.status, 'started');
    await until(() => service.detail(result.session_key).session.capabilities.message && launching.length === 1 && launching[0]!.sent.length === 1, `${name} ready`);
    const claude = launching[0]!; claudes.set(result.session_key, claude);
    claude.complete(); await until(() => service.detail(result.session_key).session.state === 'turn_finished', `${name} idle`);
    return result;
  };
  const holdWorker = (lead: string, name: string) => service.launchAgent({ id: randomUUID(), name, cwd: project, text: 'Implement the fix', provider: 'claude', role: 'worker', requester_role: 'lead', launched_by: lead, parent: lead });
  const holdLead = (supersedes: string) => service.launchAgent({ id: randomUUID(), name: 'lead-docs', cwd: project, text: 'Continue the docs work', provider: 'claude', role: 'lead', requester_role: 'coordinator', launched_by: 'coordinator', workstream: 'docs', supersedes });
  return { service, project, claudes, logs, relayed, events, startLead, holdWorker, holdLead };
}

test('a decided held worker launch sends one Foreman message into the requesting Lead (denied and approved), never a duplicate', async (t) => {
  const f = decisionFixture(t);
  const lead = await f.startLead('lead-triage');
  const denied = await f.holdWorker(lead.session_key, 'worker-a');
  assert.equal(denied.status, 'awaiting_developer_approval');
  const approval = f.service.approvals(denied.session_key)[0]!;
  await f.service.approve(denied.session_key, approval.id, 'deny');
  await Promise.all(f.relayed);
  const receipts = () => f.service.detail(lead.session_key).receipts;
  const deniedId = `foreman-launch:${approval.id}:denied`;
  let receipt: any = receipts().find((r: any) => r.id === deniedId);
  assert.ok(receipt, 'the Lead got a Foreman message for the denial');
  assert.deepEqual(receipt.source, FOREMAN_SENDER);
  assert.match(receipt.text, /denied the Bypass launch of your worker worker-a .*Nothing ran/);
  assert.equal(launchDecisionMessageId(f.events[0]!), deniedId);
  // The same event again (e.g. a duplicate listener call) is the same receipt, not a second message.
  await relayLaunchDecision(f.service, f.events[0]!, () => {});
  assert.equal(receipts().filter((r: any) => r.id === deniedId).length, 1);
  // It reached the Lead's provider as a Foreman message, not as the developer.
  const claude = f.claudes.get(lead.session_key)!;
  await until(() => claude.sent.some((m) => m.id === deniedId), 'dispatched to the Lead');
  assert.match(claude.sent.find((m) => m.id === deniedId)!.text, /^\[Message from Foreman session foreman\./);
  claude.complete();

  const approved = await f.holdWorker(lead.session_key, 'worker-b');
  const second = f.service.approvals(approved.session_key)[0]!;
  await f.service.approve(approved.session_key, second.id, 'allow');
  await Promise.all(f.relayed);
  receipt = receipts().find((r: any) => r.id === `foreman-launch:${second.id}:approved`);
  assert.ok(receipt); assert.match(receipt.text, /approved the Bypass launch of your worker worker-b\b.*starting with Bypass/);
  assert.deepEqual(f.logs, []);
});

test('an approved held Lead retires the Lead it supersedes; a denied one leaves it running; the Coordinator gets no session message', async (t) => {
  const f = decisionFixture(t);
  const old = await f.startLead('lead-docs');
  const successor = await f.holdLead(old.session_key);
  assert.equal(successor.status, 'awaiting_developer_approval');
  const denied = await f.holdLead(old.session_key);
  await f.service.approve(denied.session_key, f.service.approvals(denied.session_key)[0]!.id, 'deny');
  await Promise.all(f.relayed);
  assert.notEqual(f.service.detail(old.session_key).session.state, 'ended', 'a denied successor retires nothing');
  await f.service.approve(successor.session_key, f.service.approvals(successor.session_key)[0]!.id, 'allow');
  await Promise.all(f.relayed);
  const retired = f.service.detail(old.session_key).session;
  assert.equal(retired.state, 'ended');
  assert.equal(retired.superseded_by, successor.session_key);
  assert.match(String(retired.end_reason), /superseded by/);
  assert.equal(f.service.detail(old.session_key).receipts.filter((r: any) => String(r.id).startsWith('foreman-launch:')).length, 0);
});

test('a decision for a Lead that cannot take messages is logged, not thrown, and never retried', async (t) => {
  const f = decisionFixture(t);
  const logs: unknown[][] = [];
  const event: LaunchDecisionEvent = { session_key: `fm:${randomUUID()}`, name: 'worker-x', role: 'worker', requested_by: `fm:${randomUUID()}`, decision: 'expired', approval_id: 'launch-1', at: new Date().toISOString() };
  await relayLaunchDecision(f.service, event, (...args) => logs.push(args));
  assert.equal(logs.length, 1);
  assert.match(String(logs[0]![0]), /could not tell the Lead/);
});
