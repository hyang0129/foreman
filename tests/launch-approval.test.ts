// CL-04 (#169, core of #158): agent-initiated launches through SessionService.launchAgent — roles,
// host-enforced limits, the Bypass/Auto/held policy resolved from the developer's GrantSource, the
// held-launch approval card, and its approve/deny/restart outcomes.
// Pin FOREMAN_HOME to a temp dir before any server module loads (story #121 guard).
import './fixtures/temp-foreman-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionService, LAUNCH_DECISION_EVENT, type LaunchDecisionEvent } from '../server/session-service.ts';
import { ClaudeControl } from '../server/claude-control.ts';
import { Notifier } from '../server/notifier.ts';
import { ProjectRegistry } from '../server/projects.ts';
import {
  effectiveDevSettings, parseLaunchApprovalInput, AGENT_NATIVE_REFUSED, HELD_LAUNCH_REASON, LAUNCH_APPROVAL_TOOL, LAUNCH_DENIED, LAUNCH_EXPIRED, MAX_FIRST_TASK,
  type AgentLaunchRequest, type AgentSessionService, type DevSettings, type DevSettingsView, type GrantSource,
} from '../shared/roles.ts';
import type { NotifyFrame } from '../shared/notify.ts';

// Type-level assertion: SessionService structurally implements the CL-01 AgentSessionService contract.
type Implements<T, U extends T> = U;
type _SessionServiceIsAgentSessionService = Implements<AgentSessionService, SessionService>;
const _asContract: AgentSessionService = null as unknown as SessionService;
void _asContract;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
class FakeClaude extends EventEmitter {
  sent: any[] = []; pending: any[] = []; interrupted = 0; closed = false;
  send(text: string, id: string) { this.sent.push({ text, id }); return { id, status: 'running' }; }
  pendingApprovals() { return this.pending; }
  respondApproval(id: string) { const i = this.pending.findIndex((p) => p.id === id); if (i < 0) return false; this.pending.splice(i, 1); return true; }
  async interrupt() { this.interrupted++; this.emit('receipt', { id: this.sent.at(-1).id, status: 'failed', error: 'interrupted' }); }
  close() { this.closed = true; this.pending = []; this.emit('state', 'closed'); }
  complete() { this.emit('receipt', { id: this.sent.at(-1).id, status: 'completed' }); }
}

function view(stored: Partial<DevSettings> = {}): DevSettingsView {
  return { settings: effectiveDevSettings(stored), versions: { roles: 0, bypass_grants: 0, bypass_ask: 0 }, updated_at: null };
}
class FakeGrants implements GrantSource {
  calls: (number | undefined)[] = [];
  next: () => Promise<DevSettingsView | null> | DevSettingsView | null;
  constructor(next: () => Promise<DevSettingsView | null> | DevSettingsView | null) { this.next = next; }
  async devSettings(timeoutMs?: number) { this.calls.push(timeoutMs); return this.next(); }
}

function fixture(t: test.TestContext, extra: Record<string, any> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'foreman-launch-test-'));
  const launches: any[] = []; const claudes: FakeClaude[] = [];
  const claudeFactory = (options: any) => { launches.push(options); const c = new FakeClaude(); claudes.push(c); return c; };
  const service = new SessionService({ home, claudeFactory: claudeFactory as any, codexFactory: () => { throw new Error('codex must not launch'); }, env: {}, ...extra });
  const decisions: LaunchDecisionEvent[] = [];
  service.on(LAUNCH_DECISION_EVENT, (event) => decisions.push(event));
  mkdirSync(join(home, 'project')); const project = realpathSync(join(home, 'project'));
  t.after(() => { service.close(); rmSync(home, { recursive: true, force: true }); });
  const lead = (overrides: Partial<AgentLaunchRequest> = {}): AgentLaunchRequest => ({
    id: randomUUID(), name: 'lead-triage', cwd: project, text: 'Triage the open bugs', provider: 'claude', model: 'opus[1m]', effort: 'medium',
    role: 'lead', requester_role: 'coordinator', launched_by: 'coordinator', workstream: 'triage', ...overrides,
  });
  const worker = (parent: string, overrides: Partial<AgentLaunchRequest> = {}): AgentLaunchRequest => ({
    id: randomUUID(), name: 'worker-fix', cwd: project, text: 'Fix the login bug', provider: 'claude', role: 'worker', requester_role: 'lead',
    launched_by: parent, parent, ...overrides,
  });
  return { home, project, service, launches, claudes, decisions, lead, worker };
}
function notifier(service: SessionService) {
  const frames: NotifyFrame[] = [];
  const n = new Notifier({ sessions: service, send: (frame) => frames.push(frame), host: 'test-host' }).start();
  return { frames, close: () => n.close(), kinds: () => frames.map((f) => f.kind) };
}
const managedFiles = (home: string) => readdirSync(join(home, 'managed')).filter((f) => f.endsWith('.json'));

test('standing grant (the default) launches Bypass with bypass_grant, role fields, model and effort', async (t) => {
  const grants = new FakeGrants(() => view());
  const f = fixture(t, { grants });
  const result = await f.service.launchAgent(f.lead());
  assert.deepEqual({ ...result, session_key: undefined }, { session_key: undefined, name: 'lead-triage', status: 'started', permission_mode: 'bypass', bypass_grant: 'standing:coordinator/*', policy_reason: 'standing_grant' });
  await tick();
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].permission_mode, 'bypass'); assert.equal(f.launches[0].effort, 'medium'); assert.equal(f.launches[0].model, 'opus[1m]');
  assert.deepEqual(grants.calls, [5000], 'reads devSettings(5000) once for the launch');
  const row = f.service.detail(result.session_key).session;
  assert.equal(row.role, 'lead'); assert.equal(row.launched_by, 'coordinator'); assert.equal(row.workstream, 'triage');
  assert.equal(row.effort, 'medium'); assert.equal(row.permission_mode, 'bypass');
  assert.equal(row.bypass_grant, 'standing:coordinator/*'); assert.equal(row.policy_reason, 'standing_grant');
  assert.equal(row.state, 'working'); assert.equal(f.claudes[0].sent[0].text, 'Triage the open bugs');
});

test('grants are read on every launch (no cache): turning the grant off falls back to Auto at once', async (t) => {
  let settings: Partial<DevSettings> = {};
  const grants = new FakeGrants(() => view(settings));
  const f = fixture(t, { grants });
  assert.equal((await f.service.launchAgent(f.lead())).permission_mode, 'bypass');
  settings = { bypass_grants: [] };
  const off = await f.service.launchAgent(f.lead());
  assert.deepEqual([off.status, off.permission_mode, off.policy_reason, off.bypass_grant], ['started', 'auto', 'grant_off', undefined]);
  assert.equal(grants.calls.length, 2);
  await tick();
  assert.deepEqual(f.launches.map((o) => o.permission_mode), ['bypass', 'auto']);
  const row = f.service.detail(off.session_key).session;
  assert.equal(row.permission_mode, 'auto'); assert.equal(row.policy_reason, 'grant_off'); assert.equal(row.bypass_grant, undefined);
});

test('grant scope: a project entry beats the wildcard, matched by registered project name; workers use the lead role', async (t) => {
  const registry = new ProjectRegistry(mkdtempSync(join(tmpdir(), 'foreman-launch-registry-')));
  const grants = new FakeGrants(() => view({ bypass_grants: [{ role: 'coordinator', project: '*', allow: true }, { role: 'coordinator', project: 'Foreman', allow: false }, { role: 'lead', project: 'foreman', allow: true }] }));
  const f = fixture(t, { grants, projects: registry });
  registry.register({ name: 'foreman', path: f.project });
  const other = join(f.home, 'other'); mkdirSync(other);
  const inProject = await f.service.launchAgent(f.lead({ cwd: 'foreman' }));
  assert.deepEqual([inProject.permission_mode, inProject.policy_reason], ['auto', 'grant_off']);
  const elsewhere = await f.service.launchAgent(f.lead({ cwd: other }));
  assert.deepEqual([elsewhere.permission_mode, elsewhere.bypass_grant], ['bypass', 'standing:coordinator/*']);
  const w = await f.service.launchAgent(f.worker(elsewhere.session_key, { cwd: f.project }));
  assert.deepEqual([w.permission_mode, w.bypass_grant, w.policy_reason], ['bypass', 'standing:lead/foreman', 'standing_grant']);
  const w2 = await f.service.launchAgent(f.worker(elsewhere.session_key, { cwd: other }));
  assert.deepEqual([w2.permission_mode, w2.policy_reason], ['auto', 'grant_off'], 'no lead wildcard grant in these settings');
});

test('no GrantSource, a failing source, a null result or a timeout all mean Auto (grant_unavailable), never Bypass or a card', async (t) => {
  const none = fixture(t);
  const r0 = await none.service.launchAgent(none.lead());
  assert.deepEqual([r0.permission_mode, r0.policy_reason], ['auto', 'grant_unavailable']);
  for (const next of [() => { throw new Error('DO unreachable'); }, () => null, () => new Promise<null>(() => {})] as const) {
    const grants = new FakeGrants(next as any);
    const f = fixture(t, { grants, grantTimeoutMs: 20 });
    const r = await f.service.launchAgent(f.lead());
    assert.deepEqual([r.status, r.permission_mode, r.policy_reason, r.bypass_grant], ['started', 'auto', 'grant_unavailable', undefined]);
    assert.equal(grants.calls.length, 1); assert.deepEqual(f.service.approvals(r.session_key), []);
  }
  // setGrantSource attaches a source after construction (main.ts attaches the Lead store later), and null detaches it.
  const late = fixture(t);
  late.service.setGrantSource(new FakeGrants(() => view()));
  assert.equal((await late.service.launchAgent(late.lead())).permission_mode, 'bypass');
  late.service.setGrantSource(null);
  assert.equal((await late.service.launchAgent(late.lead())).policy_reason, 'grant_unavailable');
});

test('a malformed or partial settings view is unavailable (Auto), never widened to the default Bypass grant', async (t) => {
  const views = [
    { settings: { roles: {}, bypass_grants: 'everything', bypass_ask: 'no' }, versions: {}, updated_at: null },
    { settings: {} },
    { settings: { bypass_ask: false } },
    { settings: view().settings },
    { settings: view().settings, versions: { roles: 0, bypass_grants: 0 }, updated_at: null },
    'bypass',
  ];
  for (const raw of views) {
    const f = fixture(t, { grants: new FakeGrants(() => raw as any) });
    const r = await f.service.launchAgent(f.lead());
    assert.deepEqual([r.status, r.permission_mode, r.policy_reason, r.bypass_grant], ['started', 'auto', 'grant_unavailable', undefined], JSON.stringify(raw));
  }
  // A valid full view (the DO fills every key) still applies its defaults: the standing grant → Bypass.
  const ok = fixture(t, { grants: new FakeGrants(() => view()) });
  assert.equal((await ok.service.launchAgent(ok.lead())).permission_mode, 'bypass');
});

test('requested auto launches Auto without reading grants; native and codex are refused before anything is saved', async (t) => {
  const grants = new FakeGrants(() => view());
  const f = fixture(t, { grants });
  const auto = await f.service.launchAgent(f.lead({ requested_mode: 'auto' }));
  assert.deepEqual([auto.permission_mode, auto.policy_reason], ['auto', 'requested_auto']);
  assert.equal(grants.calls.length, 0);
  await assert.rejects(f.service.launchAgent(f.lead({ requested_mode: 'native' as any })), new RegExp(AGENT_NATIVE_REFUSED.slice(0, 40)));
  await assert.rejects(f.service.launchAgent(f.lead({ requested_mode: 'bypassPermissions' as any })), /bypass or auto/);
  await assert.rejects(f.service.launchAgent(f.lead({ provider: 'codex' as any })), /Claude only/);
  await assert.rejects(f.service.launchAgent(f.lead({ effort: 'extreme' as any })), /effort/);
  await tick();
  assert.equal(f.launches.length, 1); assert.equal(f.service.list().length, 1); assert.equal(managedFiles(f.home).length, 1);
});

test('agent-supplied input cannot set bypass_grant or policy_reason, nor turn a grant-off or held launch into Bypass', async (t) => {
  let settings: Partial<DevSettings> = { bypass_grants: [] };
  const f = fixture(t, { grants: new FakeGrants(() => view(settings)) });
  const forged = { ...f.lead(), bypass_grant: 'standing:coordinator/*', policy_reason: 'standing_grant', permission_mode: 'bypass', hold: undefined, agent: { policy_reason: 'approved' } } as any;
  const r = await f.service.launchAgent(forged);
  assert.deepEqual([r.permission_mode, r.policy_reason, r.bypass_grant], ['auto', 'grant_off', undefined]);
  await tick();
  assert.equal(f.launches[0].permission_mode, 'auto');
  const row = f.service.detail(r.session_key).session;
  assert.equal(row.bypass_grant, undefined); assert.equal(row.policy_reason, 'grant_off');
  const file = JSON.parse(readFileSync(join(f.home, 'managed', `${r.session_key.slice(3)}.json`), 'utf8'));
  assert.equal(JSON.stringify(file).includes('standing:coordinator'), false, 'the forged grant is never stored');
  settings = { bypass_ask: true };
  const held = await f.service.launchAgent({ ...forged, id: randomUUID() });
  assert.deepEqual([held.status, held.permission_mode, held.policy_reason], ['awaiting_developer_approval', null, 'ask_before_bypass']);
  // The developer's create() route cannot be used to set role fields either.
  const dev = await f.service.create({ id: 'dev-1', provider: 'claude', cwd: f.project, text: 'Hi', ...{ role: 'lead', launched_by: 'coordinator', bypass_grant: 'standing:coordinator/*' } } as any);
  assert.deepEqual([dev.role, dev.launched_by, dev.bypass_grant, dev.policy_reason], ['session', 'developer', undefined, undefined]);
});

test('ask before each Bypass launch: held launch saves without launching and raises exactly one approval card and one push', async (t) => {
  const f = fixture(t, { grants: new FakeGrants(() => view({ bypass_ask: true })) });
  const n = notifier(f.service); t.after(n.close);
  const longTask = 'Investigate '.repeat(500);
  const held = await f.service.launchAgent(f.lead({ text: longTask }));
  await tick();
  assert.deepEqual([held.status, held.permission_mode, held.policy_reason, held.bypass_grant], ['awaiting_developer_approval', null, 'ask_before_bypass', undefined]);
  assert.equal(f.launches.length, 0, 'a held launch never starts a provider');
  const row = f.service.detail(held.session_key).session;
  assert.deepEqual([row.state, row.reason, row.permission_mode, row.alive, row.capabilities.message], ['needs_input', HELD_LAUNCH_REASON, null, false, false]);
  const approvals = f.service.approvals(held.session_key);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].kind, 'permission'); assert.equal(approvals[0].tool, LAUNCH_APPROVAL_TOOL);
  const input = parseLaunchApprovalInput(approvals[0].input);
  assert.ok(input.ok, JSON.stringify(input));
  assert.equal(input.value.first_task.length, MAX_FIRST_TASK); assert.ok(input.value.first_task.endsWith('…'));
  assert.deepEqual([input.value.name, input.value.cwd, input.value.provider, input.value.model, input.value.effort, input.value.role, input.value.requested_by, input.value.project],
    ['lead-triage', f.project, 'claude', 'opus[1m]', 'medium', 'lead', 'coordinator', null]);
  assert.deepEqual(f.service.detail(held.session_key).approvals, approvals);
  assert.throws(() => f.service.send(held.session_key, 'more', 'm1'), /approve a Bypass launch/);
  // Unrelated changes on the same session never re-notify.
  (f.service as any).changed((f.service as any).records.get(held.session_key)); await tick();
  assert.deepEqual(n.kinds(), ['approval_requested']);
  assert.equal(n.frames[0].session_key, held.session_key);
  await assert.rejects(f.service.approve(held.session_key, 'not-the-card', 'allow'), /no longer pending/);
  assert.equal(f.launches.length, 0);
});

test('approving a held launch launches with Bypass (approved:<id>) and the real Claude init verification', async (t) => {
  let reported = 'bypassPermissions';
  const sdk: any[] = [];
  const fakeQuery = (params: any) => {
    sdk.push(params.options);
    let closed = false; let wake: (() => void) | undefined; let sentInit = false;
    return { async *[Symbol.asyncIterator]() {
      if (!sentInit) { sentInit = true; yield { type: 'system', subtype: 'init', session_id: `native-${sdk.length}`, permissionMode: reported }; }
      while (!closed) await new Promise<void>((resolve) => { wake = resolve; });
    }, close() { closed = true; wake?.(); }, async interrupt() {} };
  };
  const controls: ClaudeControl[] = []; const states: string[][] = [];
  const f = fixture(t, { grants: new FakeGrants(() => view({ bypass_ask: true })), claudeFactory: (options: any) => { const c = new ClaudeControl(options, fakeQuery as any); const seen: string[] = []; states.push(seen); c.on('state', (state: string) => seen.push(state)); controls.push(c); return c; } });
  const n = notifier(f.service); t.after(n.close);
  const held = await f.service.launchAgent(f.lead());
  const [card] = f.service.approvals(held.session_key);
  await f.service.approve(held.session_key, card.id, 'allow');
  await until(() => controls[0]?.sessionId === 'native-1');
  assert.equal(sdk.length, 1); assert.equal(controls[0].permission_mode, 'bypass');
  assert.equal(f.service.detail(held.session_key).session.alive, true);
  assert.equal(sdk[0].permissionMode, 'bypassPermissions'); assert.equal(sdk[0].allowDangerouslySkipPermissions, true); assert.deepEqual(sdk[0].sandbox, { enabled: false });
  assert.equal(sdk[0].effort, 'medium');
  const row = f.service.detail(held.session_key).session;
  assert.deepEqual([row.permission_mode, row.bypass_grant, row.policy_reason], ['bypass', `approved:${card.id}`, 'approved']);
  assert.deepEqual(f.service.approvals(held.session_key), []);
  assert.deepEqual(f.decisions.map((d) => [d.decision, d.session_key, d.requested_by, d.approval_id, d.bypass_grant]), [['approved', held.session_key, 'coordinator', card.id, `approved:${card.id}`]]);
  // A retry of the same creation id reports the approved outcome and never launches again.
  const again = await f.service.launchAgent({ ...f.lead(), id: (f.service as any).records.get(held.session_key).creation.id });
  assert.deepEqual([again.session_key, again.status, again.permission_mode, again.bypass_grant], [held.session_key, 'started', 'bypass', `approved:${card.id}`]);
  assert.equal(sdk.length, 1);
  await assert.rejects(f.service.approve(held.session_key, card.id, 'allow'), /no longer pending/);
  // Verification is not weakened: if the provider does not report bypassPermissions, the approved launch fails.
  reported = 'default';
  const second = await f.service.launchAgent(f.lead({ name: 'lead-second' }));
  const [secondCard] = f.service.approvals(second.session_key);
  await f.service.approve(second.session_key, secondCard.id, 'allow');
  await until(() => f.service.detail(second.session_key).session.state === 'unknown');
  assert.equal(states[1].find((state) => ['failed', 'closed'].includes(state)), 'failed', 'the controller failed on init before any close');
  assert.equal(controls[1].sessionId, null, 'init was rejected, not accepted');
  assert.equal(states[0].includes('failed'), false);
  assert.equal(f.service.detail(second.session_key).session.alive, false);
  assert.deepEqual(n.kinds(), ['approval_requested', 'approval_requested', 'session_failed']);
});

test('denying a held launch ends it with nothing run, tells the requester, and sends no session_failed', async (t) => {
  const f = fixture(t, { grants: new FakeGrants(() => view({ bypass_ask: true })) });
  const n = notifier(f.service); t.after(n.close);
  const held = await f.service.launchAgent(f.lead());
  const [card] = f.service.approvals(held.session_key);
  await f.service.approve(held.session_key, card.id, 'deny');
  await tick();
  const detail = f.service.detail(held.session_key);
  assert.deepEqual([detail.session.state, detail.session.end_reason, detail.session.alive], ['ended', LAUNCH_DENIED, false]);
  assert.deepEqual(detail.receipts.map((r) => [r.status, r.error]), [['failed', LAUNCH_DENIED]]);
  assert.deepEqual(detail.approvals, []); assert.equal(f.launches.length, 0);
  assert.deepEqual(f.decisions.map((d) => [d.decision, d.requested_by, d.reason]), [['denied', 'coordinator', LAUNCH_DENIED]]);
  assert.deepEqual(n.kinds(), ['approval_requested']);
  await assert.rejects(f.service.launchAgent({ ...f.lead(), id: (f.service as any).records.get(held.session_key).creation.id }), new RegExp(LAUNCH_DENIED.slice(0, 20)));
  assert.equal(f.launches.length, 0);
});

test('a Lead requester is named in the decision for its held worker', async (t) => {
  let ask = false;
  const f = fixture(t, { grants: new FakeGrants(() => view({ bypass_ask: ask })) });
  const lead = await f.service.launchAgent(f.lead()); await tick();
  ask = true;
  const held = await f.service.launchAgent(f.worker(lead.session_key));
  const [card] = f.service.approvals(held.session_key);
  assert.equal(card.input.requested_by, lead.session_key); assert.equal(card.input.role, 'worker');
  await f.service.approve(held.session_key, card.id, 'deny');
  assert.deepEqual(f.decisions.map((d) => [d.decision, d.requested_by, d.parent, d.role]), [['denied', lead.session_key, lead.session_key, 'worker']]);
});

test('restart while held: the launch expires (ended, not unknown), nothing runs, and no session_failed is sent', async (t) => {
  const f = fixture(t, { grants: new FakeGrants(() => view({ bypass_ask: true })) });
  const held = await f.service.launchAgent(f.lead());
  const running = await f.service.launchAgent(f.lead({ requested_mode: 'auto', name: 'lead-auto' })); await tick();
  f.service.close();
  let launched = 0;
  const loaded = new SessionService({ home: f.home, claudeFactory: () => { launched++; throw new Error('must not launch'); } });
  const decisions: LaunchDecisionEvent[] = []; loaded.on(LAUNCH_DECISION_EVENT, (e) => decisions.push(e));
  const n = notifier(loaded);
  t.after(() => { n.close(); loaded.close(); });
  const detail = loaded.detail(held.session_key);
  assert.deepEqual([detail.session.state, detail.session.end_reason, detail.session.alive], ['ended', LAUNCH_EXPIRED, false]);
  assert.deepEqual(detail.receipts.map((r) => r.status), ['failed'], 'never uncertain: the held task was never delivered');
  assert.deepEqual(detail.approvals, []);
  assert.equal(loaded.detail(running.session_key).session.state, 'unknown', 'launched sessions keep the restart semantics');
  await tick();
  assert.deepEqual(decisions.map((d) => [d.decision, d.session_key]), [['expired', held.session_key]]);
  assert.equal(launched, 0); assert.deepEqual(n.kinds(), []);
  await assert.rejects(loaded.approve(held.session_key, 'anything', 'allow'), /no longer pending/);
  assert.equal(launched, 0);
});

test('limits: a 4th Lead is refused, held launches count, retiring frees a slot, and env overrides apply', async (t) => {
  let ask = false;
  const f = fixture(t, { grants: new FakeGrants(() => view({ bypass_ask: ask })) });
  const a = await f.service.launchAgent(f.lead({ name: 'lead-a' }));
  await f.service.launchAgent(f.lead({ name: 'lead-b' }));
  ask = true;
  const held = await f.service.launchAgent(f.lead({ name: 'lead-c' }));
  assert.equal(held.status, 'awaiting_developer_approval');
  await assert.rejects(f.service.launchAgent(f.lead({ name: 'lead-d' })), /Lead limit reached: 3 active Leads, at most 3 \(FOREMAN_MAX_LEADS/);
  await tick(); f.claudes[0].complete(); await tick();
  await f.service.retire(a.session_key, 'no longer needed');
  const d = await f.service.launchAgent(f.lead({ name: 'lead-d' }));
  assert.equal(d.status, 'awaiting_developer_approval');
  const one = fixture(t, { env: { FOREMAN_MAX_LEADS: '1' } });
  await one.service.launchAgent(one.lead());
  await assert.rejects(one.service.launchAgent(one.lead()), /at most 1/);
});

test('limits: a 5th worker per Lead is refused (held counts), other Leads are unaffected', async (t) => {
  let ask = false;
  const f = fixture(t, { grants: new FakeGrants(() => view({ bypass_ask: ask })) });
  const lead = await f.service.launchAgent(f.lead({ name: 'lead-a' }));
  const other = await f.service.launchAgent(f.lead({ name: 'lead-b' }));
  for (let i = 0; i < 3; i++) await f.service.launchAgent(f.worker(lead.session_key, { name: `w-${i}` }));
  ask = true;
  assert.equal((await f.service.launchAgent(f.worker(lead.session_key, { name: 'w-held' }))).status, 'awaiting_developer_approval');
  await assert.rejects(f.service.launchAgent(f.worker(lead.session_key, { name: 'w-5' })), new RegExp(`Worker limit reached: Lead ${lead.session_key} has 4 active workers, at most 4`));
  assert.equal((await f.service.launchAgent(f.worker(other.session_key))).status, 'awaiting_developer_approval');
  const two = fixture(t, { env: { FOREMAN_MAX_WORKERS_PER_LEAD: '2' } });
  const l2 = await two.service.launchAgent(two.lead());
  await two.service.launchAgent(two.worker(l2.session_key)); await two.service.launchAgent(two.worker(l2.session_key));
  await assert.rejects(two.service.launchAgent(two.worker(l2.session_key)), /at most 2/);
});

test('roles: a Lead cannot start a Lead; workers need an existing, active parent Lead; only the Coordinator starts Leads here', async (t) => {
  const f = fixture(t);
  const lead = await f.service.launchAgent(f.lead());
  await assert.rejects(f.service.launchAgent(f.lead({ launched_by: 'developer' })), /developer launches use create\(\)/);
  await assert.rejects(f.service.launchAgent(f.lead({ launched_by: lead.session_key })), /a Lead cannot start a Lead/);
  await assert.rejects(f.service.launchAgent(f.lead({ requester_role: 'lead' })), /Coordinator role/);
  await assert.rejects(f.service.launchAgent(f.lead({ parent: lead.session_key })), /no parent/);
  await assert.rejects(f.service.launchAgent(f.worker(`fm:${randomUUID()}`)), /No such Lead/);
  await assert.rejects(f.service.launchAgent(f.worker(lead.session_key, { launched_by: 'coordinator' })), /started by its Lead/);
  await assert.rejects(f.service.launchAgent(f.worker(lead.session_key, { parent: undefined })), /parent must be the Lead/);
  const worker = await f.service.launchAgent(f.worker(lead.session_key));
  await assert.rejects(f.service.launchAgent(f.worker(worker.session_key)), /No such Lead/, 'a worker cannot start sessions');
  const dev = await f.service.create({ id: 'dev', provider: 'claude', cwd: f.project, text: 'hello' });
  await assert.rejects(f.service.launchAgent(f.worker(dev.session_key)), /No such Lead/);
  await tick(); f.claudes[0].complete(); await tick();
  await f.service.retire(lead.session_key, 'done');
  await assert.rejects(f.service.launchAgent(f.worker(lead.session_key)), /no longer active/);
  const row = f.service.detail(worker.session_key).session;
  assert.deepEqual([row.role, row.launched_by, row.parent], ['worker', lead.session_key, lead.session_key]);
});

test('creation ids are idempotent: a retry returns the same session without a second grant read or launch', async (t) => {
  const grants = new FakeGrants(() => view());
  const f = fixture(t, { grants });
  const req = f.lead();
  const [one, two] = await Promise.all([f.service.launchAgent(req), f.service.launchAgent(req)]);
  assert.equal(one.session_key, two.session_key);
  const three = await f.service.launchAgent({ ...req });
  assert.equal(three.session_key, one.session_key);
  await tick();
  assert.equal(f.launches.length, 1); assert.equal(f.service.list().length, 1);
  await assert.rejects(f.service.launchAgent({ ...req, text: 'Different' }), /different input/);
  await assert.rejects(f.service.create({ id: req.id, provider: 'claude', cwd: f.project, text: req.text }), /different input/);
});

test('role fields and effort round-trip through restart; legacy records read as session/developer', async (t) => {
  const f = fixture(t, { grants: new FakeGrants(() => view()) });
  const lead = await f.service.launchAgent(f.lead({ supersedes: `fm:${randomUUID().toUpperCase()}` }));
  const dev = await f.service.create({ id: 'dev', provider: 'claude', cwd: f.project, text: 'hello' }); await tick();
  f.service.close();
  // A record written before this epic: strip every role field from disk.
  const file = join(f.home, 'managed', `${dev.session_key.slice(3)}.json`);
  const legacy = JSON.parse(readFileSync(file, 'utf8'));
  for (const key of ['role', 'launched_by', 'parent', 'supersedes', 'superseded_by', 'workstream', 'effort', 'bypass_grant', 'policy_reason']) delete legacy.session[key];
  (await import('node:fs')).writeFileSync(file, JSON.stringify(legacy));
  const loaded = new SessionService({ home: f.home }); t.after(() => loaded.close());
  const row = loaded.detail(lead.session_key).session;
  assert.deepEqual([row.role, row.launched_by, row.workstream, row.effort, row.model, row.permission_mode, row.bypass_grant, row.policy_reason],
    ['lead', 'coordinator', 'triage', 'medium', 'opus[1m]', 'bypass', 'standing:coordinator/*', 'standing_grant']);
  assert.match(row.supersedes!, /^fm:[0-9a-f-]+$/, 'Lead keys are stored lowercased');
  const old = loaded.detail(dev.session_key).session;
  assert.deepEqual([old.role, old.launched_by, old.permission_mode], ['session', 'developer', 'native']);
  assert.deepEqual(loaded.list().map((r) => r.role).sort(), ['lead', 'session']);
});

test('retiring a held launch ends it with nothing launched and frees its slot', async (t) => {
  const f = fixture(t, { grants: new FakeGrants(() => view({ bypass_ask: true })), env: { FOREMAN_MAX_LEADS: '1' } });
  const n = notifier(f.service); t.after(n.close);
  const held = await f.service.launchAgent(f.lead());
  await f.service.retire(held.session_key, 'not needed');
  const detail = f.service.detail(held.session_key);
  assert.deepEqual([detail.session.state, detail.session.end_reason], ['ended', 'not needed']);
  assert.deepEqual(detail.approvals, []); assert.equal(f.launches.length, 0);
  assert.deepEqual(f.decisions.map((d) => d.decision), ['retired']);
  assert.equal((await f.service.launchAgent(f.lead())).status, 'awaiting_developer_approval');
  assert.deepEqual(n.kinds(), ['approval_requested', 'approval_requested']);
});

async function until(check: () => unknown, timeout = 2000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error('timed out');
}

test('launched_by developer is refused for every outcome (it cannot form a valid approval card); nothing is saved', async (t) => {
  for (const settings of [{}, { bypass_ask: true }, { bypass_grants: [] }] as Partial<DevSettings>[]) {
    const f = fixture(t, { grants: new FakeGrants(() => view(settings)) });
    await assert.rejects(f.service.launchAgent(f.lead({ launched_by: 'developer' })), /developer launches use create\(\)/);
    await assert.rejects(f.service.launchAgent(f.lead({ launched_by: 'developer', requested_mode: 'auto' })), /developer launches use create\(\)/);
    await tick();
    assert.equal(f.launches.length, 0); assert.equal(managedFiles(f.home).length, 0);
  }
});

test('a held launch whose approval card would not parse is refused before anything is saved', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'foreman-launch-card-'));
  mkdirSync(join(home, 'project')); const project = realpathSync(join(home, 'project'));
  // A project source reporting a name the approval contract rejects (path-like).
  const projects = { require: () => ({ path: project }), forPath: () => ({ name: '~/weird' }), used() {} };
  const f = fixture(t, { grants: new FakeGrants(() => view({ bypass_ask: true })), projects });
  await assert.rejects(f.service.launchAgent(f.lead({ cwd: project })), /approval card is invalid \(project must be/);
  assert.equal(f.launches.length, 0); assert.equal(managedFiles(f.home).length, 0); assert.deepEqual(f.decisions, []);
  rmSync(home, { recursive: true, force: true });
});

test('session names are validated: path-like names and control characters are refused', async (t) => {
  const f = fixture(t);
  for (const name of ['/etc/passwd', '~/x', '~', 'C:\\temp', '\\\\server\\share', 'bad\nname', 'tab\there', 'bell\u0007', '', '   ', 'x'.repeat(201), 42 as any]) {
    await assert.rejects(f.service.launchAgent(f.lead({ name })), /name must be/, JSON.stringify(name));
  }
  assert.equal(managedFiles(f.home).length, 0);
  assert.equal((await f.service.launchAgent(f.lead({ name: 'lead: triage (v2) ✓' }))).name, 'lead: triage (v2) ✓');
});

test('limits: superseding an active Lead works with every Lead slot in use', async (t) => {
  const f = fixture(t, { grants: new FakeGrants(() => view()) });
  const leads = [];
  for (const name of ['lead-a', 'lead-b', 'lead-c']) leads.push(await f.service.launchAgent(f.lead({ name })));
  await assert.rejects(f.service.launchAgent(f.lead({ name: 'lead-d' })), /Lead limit reached: 3 active Leads/);
  // Superseding a key that is not an active Lead does not free a slot.
  await assert.rejects(f.service.launchAgent(f.lead({ name: 'lead-d', supersedes: `fm:${randomUUID()}` })), /Lead limit reached: 3 active Leads/);
  const successor = await f.service.launchAgent(f.lead({ name: 'lead-a2', supersedes: leads[0].session_key.toUpperCase() }));
  assert.equal(successor.status, 'started');
  assert.equal(f.service.detail(successor.session_key).session.supersedes, leads[0].session_key);
  // Now 4 active until the old Lead retires; a further non-superseding Lead is still refused.
  await assert.rejects(f.service.launchAgent(f.lead({ name: 'lead-e' })), /Lead limit reached: 4 active Leads/);
  await tick(); f.claudes[0].complete(); await tick();
  await f.service.retire(leads[0].session_key, `superseded by ${successor.session_key}`);
  assert.equal(f.service.detail(leads[0].session_key).session.superseded_by, successor.session_key);
});

test('launch() refuses an agent record without a Bypass or Auto policy (never Native)', async (t) => {
  const f = fixture(t, { grants: new FakeGrants(() => view()) });
  const r = await f.service.launchAgent(f.lead()); await tick();
  assert.equal(f.launches.length, 1);
  const service = f.service as any;
  const data = service.records.get(r.session_key);
  for (const mode of ['native', undefined]) {
    const copy = structuredClone(data); copy.creation.permission_mode = mode;
    const runtime = { ready: false, dispatching: false };
    await service.launch(copy, runtime);
    assert.equal(f.launches.length, 1, `no provider started for ${mode}`);
    assert.equal(copy.session.state, 'unknown');
    assert.match(copy.session.last_error, /An agent launch without an approved policy cannot start/);
    assert.equal(runtime.ready, false);
  }
});

test('an Auto launch the provider does not apply fails with the requested and reported modes in last_error', async (t) => {
  const fakeQuery = (params: any) => {
    let closed = false; let wake: (() => void) | undefined;
    return { async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'native-haiku', permissionMode: 'default' };
      while (!closed) await new Promise<void>((resolve) => { wake = resolve; });
    }, close() { closed = true; wake?.(); }, async interrupt() {}, params };
  };
  const f = fixture(t, { claudeFactory: (options: any) => new ClaudeControl(options, fakeQuery as any) });
  const n = notifier(f.service); t.after(n.close);
  const r = await f.service.launchAgent(f.lead({ model: 'haiku', requested_mode: 'auto' }));
  await until(() => f.service.detail(r.session_key).session.state === 'unknown');
  const row = f.service.detail(r.session_key).session;
  const expected = 'Claude did not apply the requested launch policy: requested auto, provider reported default; this model may not support Auto';
  assert.equal(row.last_error, expected); assert.equal(row.control_reason, expected);
  assert.equal(row.alive, false);
  assert.deepEqual(f.service.detail(r.session_key).receipts.map((x) => [x.status, x.error]), [['uncertain', expected]]);
});
