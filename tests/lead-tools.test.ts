// Pin FOREMAN_HOME to a temp dir before any server module loads (story #121 guard).
import './fixtures/temp-foreman-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry } from '../server/projects.ts';
import { buildLeadRecords, containsFilesystemPath, RESTARTED_END_REASON, makeLeadTools, OTHER_MACHINE_REFUSED, LEAD_TOOL_NAMES, retireSupersededOnApproval, ROLE_CONFIG_TIMEOUT_MS } from '../server/lead-tools.ts';
import {
  AGENT_NATIVE_REFUSED, HELD_LAUNCH_REASON, ROLE_DEFAULTS, defaultDevSettings, parseLeadHandoff,
  type AgentLaunchRequest, type AgentLaunchResult, type AgentSessionService, type DevSettingsView, type LeadHandoff, type LeadListEntry, type LeadStore,
} from '../shared/roles.ts';

const leadKey = () => `fm:${randomUUID()}`;
const iso = (ms = Date.now()) => new Date(ms).toISOString();

class FakeSessions implements AgentSessionService {
  rows: any[] = [];
  launches: AgentLaunchRequest[] = [];
  retired: { id: string; reason: string; options?: { force?: boolean } }[] = [];
  history = new Map<string, any[]>();
  approvalsBy = new Map<string, number>();
  launchError: Error | null = null;
  result: Partial<AgentLaunchResult> = {};
  async launchAgent(req: AgentLaunchRequest): Promise<AgentLaunchResult> {
    if (this.launchError) throw this.launchError;
    this.launches.push(structuredClone(req));
    const key = leadKey();
    const held = this.result.status === 'awaiting_developer_approval';
    this.rows.push({ session_key: key, name: req.name, provider: 'claude', role: req.role, launched_by: req.launched_by, parent: req.parent, workstream: req.workstream, supersedes: req.supersedes, cwd: req.cwd, state: held ? 'needs_input' : 'working', reason: held ? HELD_LAUNCH_REASON : 'starting', updated_at: iso(), started_at: iso() });
    return { session_key: key, name: req.name, status: 'started', permission_mode: 'bypass', bypass_grant: 'standing:coordinator/*', policy_reason: 'standing_grant', ...this.result };
  }
  async retire(id: string, reason: string, options?: { force?: boolean }) {
    const row = this.rows.find((r) => r.session_key === id);
    if (!row) throw new Error('No such session');
    if (row.state === 'working' && !options?.force) throw new Error('Session is working');
    this.retired.push({ id, reason, ...(options ? { options } : {}) });
    row.state = 'ended'; row.end_reason = reason;
  }
  list() { return this.rows; }
  detail(id: string) {
    const session = this.rows.find((r) => r.session_key === id);
    if (!session) throw new Error('No such session');
    return { session, history: this.history.get(id) ?? [], receipts: [], approvals: Array.from({ length: this.approvalsBy.get(id) ?? 0 }, (_, i) => ({ id: String(i) })) };
  }
}

class FakeStore implements LeadStore {
  readonly mode = 'relay' as const;
  handoffs = new Map<string, LeadHandoff[]>();
  entries: LeadListEntry[] = [];
  settings: DevSettingsView | null = null;
  listCalls: any[] = [];
  devSettingsCalls: (number | undefined)[] = [];
  async devSettings(timeoutMs?: number) { this.devSettingsCalls.push(timeoutMs); return this.settings; }
  async appendHandoff(input: Omit<LeadHandoff, 'v' | 'seq' | 'at' | 'workers'>): Promise<LeadHandoff> {
    const list = this.handoffs.get(input.lead) ?? [];
    const parsed = parseLeadHandoff({ ...input, v: 1, seq: list.length + 1, at: iso(), workers: [] });
    if (!parsed.ok) throw new Error(parsed.error);
    list.push(parsed.value); this.handoffs.set(input.lead, list);
    return parsed.value;
  }
  upsert() {}
  track() {}
  async list(opts?: { include_ended?: boolean }) { this.listCalls.push(opts); return this.entries.filter((e) => opts?.include_ended || !e.ended); }
  async get(lead: string, count = 0) {
    const entry = this.entries.find((e) => e.lead === lead);
    if (!entry) return null;
    return { lead: entry, handoffs: [...(this.handoffs.get(lead) ?? [])].reverse().slice(0, count) };
  }
  async latestHandoff(lead: string) { return this.handoffs.get(lead)?.at(-1) ?? null; }
  close() {}
}

function view(roles: any = {}): DevSettingsView {
  return { settings: { ...defaultDevSettings(), roles }, versions: { roles: 1, bypass_grants: 0, bypass_ask: 0 }, updated_at: Date.now() };
}

function setup(env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'foreman-lead-tools-'));
  const dir = join(home, 'checkout'); mkdirSync(dir);
  const projects = new ProjectRegistry(join(home, 'fh'));
  projects.register({ name: 'Foreman', path: dir, aliases: ['fm-app'] });
  const sessions = new FakeSessions();
  const store = new FakeStore();
  const machine = { machine_id: randomUUID(), name: 'mac' };
  const seen: LeadHandoff[] = [];
  const tools = makeLeadTools({ sessions, store, projects, machine, env, onHandoff: (h) => seen.push(h) });
  return { home, dir: realpathSync(dir), projects, sessions, store, machine, tools, seen, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const start = { project: 'foreman', workstream: 'triage-bugs', goal: 'Triage open bugs', first_task: 'List the open bugs and propose an order.' };

function entry(over: Partial<LeadListEntry> & { lead: string; machine_id: string }): LeadListEntry {
  return {
    v: 1, machine_name: 'other', name: 'lead-x', project: 'Foreman', workstream: 'triage-bugs', goal: 'g', model: 'opus[1m]', effort: 'medium',
    permission_mode: 'bypass', launched_by: 'coordinator', state: 'idle', alive: true, created_at: 1, updated_at: 2, pending_approvals: 0, workers: [],
    machine_online: true, reported_at: Date.now(), ended: false, ...over,
  };
}

test('start_lead launches a Claude Lead in the registered checkout with role, requester and role-config model', async () => {
  const f = setup();
  try {
    const out = await f.tools.call('start_lead', start);
    assert.equal(f.sessions.launches.length, 1);
    const req = f.sessions.launches[0];
    assert.equal(req.role, 'lead');
    assert.equal(req.requester_role, 'coordinator');
    assert.equal(req.launched_by, 'coordinator');
    assert.equal(req.provider, 'claude');
    assert.equal(req.cwd, f.dir);
    assert.equal(req.name, 'lead-triage-bugs');
    assert.equal(req.workstream, 'triage-bugs');
    assert.equal(req.model, ROLE_DEFAULTS.lead.model);
    assert.equal(req.effort, ROLE_DEFAULTS.lead.effort);
    assert.equal(req.requested_mode, undefined);
    assert.equal(req.supersedes, undefined);
    assert.match(req.text, /Goal: Triage open bugs/);
    assert.match(req.text, /List the open bugs/);
    assert.equal(out.lead, f.sessions.rows[0].session_key);
    assert.equal(out.status, 'started');
    assert.equal(out.permission_mode, 'bypass');
    assert.equal(out.policy_reason, 'standing_grant');
    assert.equal(out.bypass_grant, 'standing:coordinator/*');
    assert.equal(out.project, 'Foreman');
    // Seed handoff: goal, registered name, never the first task text or a path.
    const seed = f.store.handoffs.get(out.lead)!;
    assert.equal(seed.length, 1);
    assert.equal(seed[0].kind, 'seed');
    assert.equal(seed[0].project, 'Foreman');
    assert.equal(seed[0].goal, 'Triage open bugs');
    assert.equal(out.own_seed_seq, 1);
    assert.equal(out.seeded_from, null, 'no predecessor: seeded from no handoff');
    assert.equal(out.seed_handoff, undefined);
    assert.ok(!JSON.stringify(seed).includes('List the open bugs'));
    assert.ok(!JSON.stringify(seed).includes(f.home));
    assert.equal(f.seen.length, 1);
    // The alias resolves to the same project; case-insensitive.
    await f.tools.call('start_lead', { ...start, project: 'FM-APP', workstream: 'other-work' });
    assert.equal(f.sessions.launches[1].cwd, f.dir);
  } finally { f.cleanup(); }
});

test('start_lead model/effort: arguments win, then developer settings, then env, then defaults', async () => {
  const f = setup({ FOREMAN_LEAD_MODEL: 'claude-sonnet-5', FOREMAN_LEAD_EFFORT: 'high' });
  try {
    await f.tools.call('start_lead', start);
    assert.deepEqual([f.sessions.launches[0].model, f.sessions.launches[0].effort], ['claude-sonnet-5', 'high']);
    f.store.settings = view({ lead: { model: 'opus', effort: 'low' } });
    await f.tools.call('start_lead', { ...start, workstream: 'b' });
    assert.deepEqual([f.sessions.launches[1].model, f.sessions.launches[1].effort], ['opus', 'low']);
    await f.tools.call('start_lead', { ...start, workstream: 'c', model: 'claude-haiku-5', effort: 'max' });
    assert.deepEqual([f.sessions.launches[2].model, f.sessions.launches[2].effort], ['claude-haiku-5', 'max']);
    await assert.rejects(f.tools.call('start_lead', { ...start, workstream: 'd', effort: 'extreme' }), /effort/);
    assert.equal(f.sessions.launches.length, 3);
    // Settings are read only when model or effort is missing, and with a short timeout.
    assert.deepEqual(f.store.devSettingsCalls, [ROLE_CONFIG_TIMEOUT_MS, ROLE_CONFIG_TIMEOUT_MS]);
    assert.ok(ROLE_CONFIG_TIMEOUT_MS <= 2_000);
  } finally { f.cleanup(); }
});

test('start_lead refuses unregistered projects, paths, other machines, native and bad workstreams without launching', async () => {
  const f = setup();
  try {
    await assert.rejects(f.tools.call('start_lead', { ...start, project: 'nope' }), (e: Error) => e.message.startsWith("`nope` isn't registered on `mac`"));
    await assert.rejects(f.tools.call('start_lead', { ...start, project: f.dir }), /isn't registered on `mac`.*not a path/);
    await assert.rejects(f.tools.call('start_lead', { ...start, machine: 'other-box' }), (e: Error) => e.message === OTHER_MACHINE_REFUSED);
    await assert.rejects(f.tools.call('start_lead', { ...start, machine: randomUUID() }), (e: Error) => e.message === OTHER_MACHINE_REFUSED);
    await assert.rejects(f.tools.call('start_lead', { ...start, permission_mode: 'native' }), (e: Error) => e.message === AGENT_NATIVE_REFUSED);
    await assert.rejects(f.tools.call('start_lead', { ...start, permission_mode: 'bypassPermissions' }), /bypass or auto/);
    await assert.rejects(f.tools.call('start_lead', { ...start, workstream: 'Triage Bugs' }), /kebab/);
    await assert.rejects(f.tools.call('start_lead', { ...start, goal: 'x'.repeat(1001) }), /goal/);
    await assert.rejects(f.tools.call('start_lead', { ...start, cwd: '/tmp' }), /Unrecognized key/);
    assert.equal(f.sessions.launches.length, 0);
    // This machine, by name or id, is accepted; auto is passed through.
    await f.tools.call('start_lead', { ...start, machine: 'MAC', permission_mode: 'auto' });
    await f.tools.call('start_lead', { ...start, workstream: 'z', machine: f.machine.machine_id.toUpperCase() });
    assert.equal(f.sessions.launches.length, 2);
    assert.equal(f.sessions.launches[0].requested_mode, 'auto');
  } finally { f.cleanup(); }
});

test('limits and policy come from the service: a refused launch surfaces its message; a held launch tells the developer to approve', async () => {
  const f = setup();
  try {
    f.sessions.launchError = new Error('Lead limit reached: at most 3 active Leads (FOREMAN_MAX_LEADS)');
    const handler = (f.tools.server.instance as any)._registeredTools.start_lead.handler;
    const refused = await handler(start);
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /Lead limit reached: at most 3 active Leads/);
    assert.equal(f.store.handoffs.size, 0);
    f.sessions.launchError = null;
    f.sessions.result = { status: 'awaiting_developer_approval', permission_mode: null, policy_reason: 'ask_before_bypass', bypass_grant: undefined };
    const held = await f.tools.call('start_lead', start);
    assert.equal(held.status, 'awaiting_developer_approval');
    assert.equal(held.permission_mode, null);
    assert.equal(held.bypass_grant, undefined);
    assert.match(held.message, /developer.*approve.*phone/);
  } finally { f.cleanup(); }
});

function oldLead(f: ReturnType<typeof setup>, over: any = {}) {
  const key = leadKey();
  f.sessions.rows.push({ session_key: key, name: 'lead-triage-bugs', provider: 'claude', role: 'lead', launched_by: 'coordinator', workstream: 'triage-bugs', project_name: 'Foreman', cwd: f.dir, state: 'idle', updated_at: iso(Date.now() - 1000), started_at: iso(Date.now() - 5000), ...over });
  return key;
}
const checkpoint = (lead: string, kind: 'checkpoint' | 'final' = 'checkpoint') => ({
  lead, kind, project: 'Foreman', workstream: 'triage-bugs', goal: 'Triage open bugs', status: 'in_progress' as const,
  summary: 'Half the bugs are triaged; PR 12 is open.', decisions: ['Close stale bugs'], open_questions: [], next_steps: ['Review PR 12'], links: [{ label: 'PR 12', url: 'https://github.com/x/y/pull/12' }],
});

test('supersede: an idle Lead on the same workstream is seeded (handoff, live workers, tail + warning without a final) and retired', async () => {
  const f = setup();
  try {
    const old = oldLead(f);
    const worker = `fm:${randomUUID()}`;
    f.sessions.rows.push({ session_key: worker, name: 'fix-login', role: 'worker', parent: old, state: 'working', updated_at: iso() });
    f.sessions.rows.push({ session_key: `fm:${randomUUID()}`, name: 'done-worker', role: 'worker', parent: old, state: 'ended', updated_at: iso() });
    await f.store.appendHandoff(checkpoint(old));
    f.sessions.history.set(old, Array.from({ length: 14 }, (_, i) => ({ id: String(i), role: i % 3 === 2 ? 'tool' : i % 2 ? 'assistant' : 'user', text: `message-${i}`, at: iso() })));
    const out = await f.tools.call('start_lead', start);
    const req = f.sessions.launches[0];
    assert.equal(req.supersedes, old);
    assert.match(req.text, new RegExp(`You supersede lead-triage-bugs \\(${old}\\)`));
    assert.match(req.text, /Half the bugs are triaged/);
    assert.match(req.text, /fix-login/);
    assert.ok(!req.text.includes('done-worker'));
    assert.match(req.text, /did not write a final handoff.*branches, open PRs/s);
    assert.match(req.text, /message-13/);
    assert.ok(!req.text.includes('message-11'), 'tool entries are not in the tail');
    assert.ok(req.text.includes('[user] message-0'), 'the tail is the last 10 user/assistant messages, not the last 10 entries');
    const tail = req.text.slice(req.text.indexOf('Its last'));
    assert.equal((tail.match(/\[(user|assistant)\] /g) ?? []).length, 10);
    assert.deepEqual(f.sessions.retired, [{ id: old, reason: `superseded by ${out.lead}` }]);
    assert.equal(out.superseded.retired, true);
    // The seed handoff carries the predecessor's handoff content but no transcript text.
    const seed = f.store.handoffs.get(out.lead)![0];
    assert.deepEqual(seed.next_steps, ['Review PR 12']);
    assert.match(seed.summary, /Supersedes lead-triage-bugs/);
    assert.ok(!JSON.stringify(seed).includes('message-13'));
  } finally { f.cleanup(); }
});

test('supersede with a final handoff adds no tail or warning; explicit supersedes works across workstreams', async () => {
  const f = setup();
  try {
    const old = oldLead(f, { workstream: 'something-else', state: 'turn_finished' });
    await f.store.appendHandoff({ ...checkpoint(old, 'final'), workstream: 'something-else' });
    f.sessions.history.set(old, [{ id: '1', role: 'assistant', text: 'secret-tail', at: iso() }]);
    const out = await f.tools.call('start_lead', { ...start, supersedes: old.toUpperCase().replace('FM:', 'fm:') });
    const req = f.sessions.launches[0];
    assert.equal(req.supersedes, old);
    assert.ok(!req.text.includes('did not write a final handoff'));
    assert.ok(!req.text.includes('secret-tail'));
    assert.equal(f.sessions.retired[0].id, old);
    assert.equal(out.superseded.latest_handoff.kind, 'final');
    await assert.rejects(f.tools.call('start_lead', { ...start, workstream: 'q', supersedes: leadKey() }), /No Lead/);
  } finally { f.cleanup(); }
});

test('supersede: a working Lead is refused unless force, which retires it with force', async () => {
  const f = setup();
  try {
    const old = oldLead(f, { state: 'working' });
    await assert.rejects(f.tools.call('start_lead', start), /is working.*final handoff.*force: true/s);
    assert.equal(f.sessions.launches.length, 0);
    assert.equal(f.sessions.retired.length, 0);
    const out = await f.tools.call('start_lead', { ...start, force: true });
    assert.deepEqual(f.sessions.retired, [{ id: old, reason: `superseded by ${out.lead}`, options: { force: true } }]);
    // needs_input on a real approval is busy too; a held launch is not.
    const g = setup();
    try {
      oldLead(g, { state: 'needs_input', reason: 'permission' });
      await assert.rejects(g.tools.call('start_lead', start), /is working/);
      g.sessions.rows[0].reason = HELD_LAUNCH_REASON;
      await g.tools.call('start_lead', start);
      assert.equal(g.sessions.retired.length, 1);
    } finally { g.cleanup(); }
  } finally { f.cleanup(); }
});

test('supersede: a dead Lead is retired; an already ended one is not retired again; a remote Lead is seeded but not retired', async () => {
  const f = setup();
  try {
    const dead = oldLead(f, { state: 'unknown', alive: false });
    await f.tools.call('start_lead', start);
    assert.equal(f.sessions.retired[0].id, dead);
    const d = setup();
    try {
      const gone = oldLead(d, { state: 'dead', alive: false });
      const out = await d.tools.call('start_lead', start);
      assert.deepEqual(d.sessions.retired, [{ id: gone, reason: `superseded by ${out.lead}` }]);
      assert.equal(out.superseded.retired, true);
    } finally { d.cleanup(); }
    const g = setup();
    try {
      oldLead(g, { state: 'ended' });
      const out = await g.tools.call('start_lead', start);
      assert.equal(g.sessions.retired.length, 0);
      assert.equal(out.superseded.retired, 'already ended');
    } finally { g.cleanup(); }
    const h = setup();
    try {
      const remote = leadKey();
      h.store.entries.push(entry({ lead: remote, machine_id: randomUUID(), machine_name: 'linux-box', name: 'lead-triage-bugs', workers: [{ session_key: 'fm:w', name: 'far-worker', state: 'working', permission_mode: 'bypass', needs_attention: false }] }));
      await h.store.appendHandoff(checkpoint(remote, 'final'));
      const out = await h.tools.call('start_lead', start);
      assert.equal(h.sessions.launches[0].supersedes, remote);
      assert.match(h.sessions.launches[0].text, /on machine linux-box/);
      assert.match(h.sessions.launches[0].text, /far-worker/);
      assert.equal(h.sessions.retired.length, 0);
      assert.match(out.superseded.note, /linux-box, not reachable from here/);
    } finally { h.cleanup(); }
  } finally { f.cleanup(); }
});

test('retire_lead, list_leads and read_handoff', async () => {
  const f = setup();
  try {
    const local = oldLead(f);
    await assert.rejects(f.tools.call('retire_lead', { lead: leadKey() }), /No Lead matches/);
    const remote = leadKey();
    f.store.entries.push(entry({ lead: local, machine_id: f.machine.machine_id, machine_name: 'mac', name: 'lead-triage-bugs', pending_approvals: 2 }));
    f.store.entries.push(entry({ lead: remote, machine_id: randomUUID(), machine_name: 'linux-box', name: 'lead-remote', machine_online: false, reported_at: 0 }));
    await assert.rejects(f.tools.call('retire_lead', { lead: remote }), /lead-remote is on linux-box, not reachable from here/);
    const listed = await f.tools.call('list_leads', {});
    assert.equal(listed.leads.length, 2);
    assert.equal(listed.leads[0].pending_approvals, 2);
    assert.equal(listed.leads[0].note, undefined);
    assert.match(listed.leads[1].note, /on linux-box, not reachable from here/);
    assert.match(listed.leads[1].note, /last known state at 1970-01-01T00:00:00.000Z; machine offline/);
    assert.equal(listed.leads[1].machine_online, false);
    // The default view reads ended rows too (restarted Leads awaiting a successor) and filters.
    assert.deepEqual(f.store.listCalls.at(-1), { include_ended: true });
    await f.tools.call('list_leads', { include_ended: true });
    assert.deepEqual(f.store.listCalls.at(-1), { include_ended: true });
    await f.store.appendHandoff(checkpoint(local));
    await f.store.appendHandoff(checkpoint(local, 'final'));
    const read = await f.tools.call('read_handoff', { lead: 'lead-triage-bugs', count: 5 });
    assert.deepEqual(read.handoffs.map((h: LeadHandoff) => h.seq), [2, 1]);
    await assert.rejects(f.tools.call('read_handoff', { lead: local, count: 6 }));
    assert.deepEqual((await f.tools.call('retire_lead', { lead: local })), { lead: local, name: 'lead-triage-bugs', retired: true });
    assert.deepEqual(f.sessions.retired, [{ id: local, reason: 'retired by the Coordinator' }]);
  } finally { f.cleanup(); }
});

test('write_handoff: identity and project come from the host; paths and oversize fields are rejected', async () => {
  const f = setup();
  try {
    const lead = oldLead(f);
    await f.store.appendHandoff({ ...checkpoint(lead), kind: 'checkpoint' });
    const bound = f.tools.bindLead(lead);
    const base = { kind: 'checkpoint', status: 'in_progress', summary: 'PR 14 merged.', decisions: [], open_questions: [], next_steps: ['Start the next bug'], links: [{ label: 'PR 14', url: 'https://github.com/x/y/pull/14' }, { label: 'branch', url: 'branch:agent/14-fix' }] };
    const out = await bound.call('write_handoff', base);
    assert.equal(out.seq, 2);
    const stored = f.store.handoffs.get(lead)!.at(-1)!;
    assert.equal(stored.lead, lead);
    assert.equal(stored.project, 'Foreman');
    assert.equal(stored.workstream, 'triage-bugs');
    assert.equal(stored.goal, 'Triage open bugs');
    assert.equal(f.seen.at(-1)!.seq, 2);
    await assert.rejects(bound.call('write_handoff', { ...base, lead: leadKey() }), /Unrecognized key/);
    await assert.rejects(bound.call('write_handoff', { ...base, project: 'Other' }), /Unrecognized key/);
    await assert.rejects(bound.call('write_handoff', { ...base, kind: 'seed' }), /kind/);
    await assert.rejects(bound.call('write_handoff', { ...base, summary: `Edited ${f.dir}/server/main.ts` }), /filesystem paths/);
    await assert.rejects(bound.call('write_handoff', { ...base, decisions: ['Use ~/notes for scratch'] }), /filesystem paths/);
    await assert.rejects(bound.call('write_handoff', { ...base, links: [{ label: '/Users/hong/x', url: 'https://a.b' }] }), /path/);
    await assert.rejects(bound.call('write_handoff', { ...base, links: [{ label: 'x', url: 'file:///etc/passwd' }] }), /link url/);
    await assert.rejects(bound.call('write_handoff', { ...base, summary: 'x'.repeat(4001) }), /summary/);
    await assert.rejects(bound.call('write_handoff', { ...base, decisions: Array(31).fill('d') }), /decisions/);
    await assert.rejects(bound.call('write_handoff', { ...base, workstream: 'Not Kebab' }), /workstream/);
    assert.equal(f.store.handoffs.get(lead)!.length, 2);
    // Route-like text is not a filesystem path.
    await bound.call('write_handoff', { ...base, kind: 'final', status: 'done', summary: 'GET /api/leads now returns machine_online.' });
    assert.equal(f.store.handoffs.get(lead)!.at(-1)!.kind, 'final');
    assert.throws(() => f.tools.bindLead('coordinator'), /Lead session key/);
  } finally { f.cleanup(); }
});

test('containsFilesystemPath catches home and system paths but not routes or URLs', () => {
  for (const text of ['/Users/hong/code', 'see ~/work', 'in C:\\repo', 'path=/home/x/y', '(/tmp/scratch)']) assert.equal(containsFilesystemPath(text), true, text);
  for (const text of ['/api/leads', 'https://github.com/home/x', 'branch agent/170-lead-tools', 'input/output', 'a ~ b']) assert.equal(containsFilesystemPath(text), false, text);
});

test('Lead spawn_session launches a Claude worker stamped with the Lead as parent; native and codex are refused', async () => {
  const f = setup();
  try {
    const lead = oldLead(f);
    const bound = f.tools.bindLead(lead);
    const brief = { name: 'fix-login', prompt: 'Fix the login bug on a new worktree and open a PR.' };
    const out = await bound.call('spawn_session', brief);
    const req = f.sessions.launches[0];
    assert.equal(req.role, 'worker');
    assert.equal(req.parent, lead);
    assert.equal(req.launched_by, lead);
    assert.equal(req.requester_role, 'lead');
    assert.equal(req.provider, 'claude');
    assert.equal(req.cwd, f.dir);
    assert.equal(out.status, 'started');
    await bound.call('spawn_session', { ...brief, name: 'other', cwd: 'Foreman', permission_mode: 'auto', model: 'claude-sonnet-5', effort: 'low' });
    assert.deepEqual([f.sessions.launches[1].cwd, f.sessions.launches[1].requested_mode, f.sessions.launches[1].model, f.sessions.launches[1].effort], [f.dir, 'auto', 'claude-sonnet-5', 'low']);
    await assert.rejects(bound.call('spawn_session', { ...brief, permission_mode: 'native' }), (e: Error) => e.message === AGENT_NATIVE_REFUSED);
    await assert.rejects(bound.call('spawn_session', { ...brief, provider: 'codex' }), /Unrecognized key/);
    await assert.rejects(bound.call('spawn_session', { ...brief, parent: leadKey() }), /Unrecognized key/);
    await assert.rejects(bound.call('spawn_session', { ...brief, mode: 'bg' }), /Unrecognized key/);
    await assert.rejects(bound.call('spawn_session', { ...brief, cwd: 'unknown-project' }), /No project matches/);
    assert.equal(f.sessions.launches.length, 2);
    f.sessions.launchError = new Error('Worker limit reached: at most 4 active workers per Lead');
    await assert.rejects(bound.call('spawn_session', brief), /Worker limit reached/);
    // list_workers shows only this Lead's workers.
    f.sessions.rows.push({ session_key: 'fm:foreign', name: 'foreign', role: 'worker', parent: leadKey(), state: 'idle' });
    const w = f.sessions.rows.find((r) => r.name === 'fix-login');
    w.state = 'idle'; f.sessions.approvalsBy.set(w.session_key, 1);
    const listed = await bound.call('list_workers', {});
    assert.deepEqual(listed.workers.map((x: any) => x.name).sort(), ['fix-login', 'other']);
    assert.equal(listed.workers.find((x: any) => x.name === 'fix-login').needs_attention, true);
  } finally { f.cleanup(); }
});

test('MCP servers: the Coordinator gets leads tools; a Lead server has exactly write_handoff, spawn_session, list_workers', async () => {
  const f = setup();
  try {
    assert.deepEqual(Object.keys((f.tools.server.instance as any)._registeredTools).sort(), ['list_leads', 'read_handoff', 'retire_lead', 'start_lead']);
    const lead = oldLead(f);
    const server = f.tools.leadServer(lead);
    const registered = (server.instance as any)._registeredTools;
    assert.deepEqual(Object.keys(registered).sort(), [...LEAD_TOOL_NAMES].sort());
    const input = { kind: 'checkpoint', status: 'blocked', summary: 'Waiting on the developer.', decisions: [], open_questions: ['Which branch?'], next_steps: [], links: [] };
    const missingGoal = await registered.write_handoff.handler(input);
    assert.equal(missingGoal.isError, true);
    assert.match(missingGoal.content[0].text, /goal is required/);
    const result = await registered.write_handoff.handler({ ...input, goal: 'Answer the branch question' });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(f.store.handoffs.get(lead)!.at(-1)!.lead, lead);
  } finally { f.cleanup(); }
});

test('buildLeadRecords maps Lead rows and workers to valid LeadRecords with no path fields', () => {
  const machine = { machine_id: randomUUID(), name: 'mac' };
  const lead = leadKey(), held = leadKey(), w1 = leadKey(), w2 = leadKey();
  const rows = [
    { session_key: lead, name: 'lead-triage', role: 'lead', launched_by: 'coordinator', workstream: 'triage', project_name: 'Foreman', cwd: '/Users/hong/code/foreman', transcript_path: '/Users/hong/.claude/x.jsonl', model: 'opus[1m]', effort: 'medium', permission_mode: 'bypass', bypass_grant: 'standing:coordinator/*', policy_reason: 'standing_grant', state: 'idle', alive: true, started_at: iso(1000), updated_at: iso(2000), supersedes: leadKey() },
    { session_key: w1, name: 'fix-a', role: 'worker', parent: lead, launched_by: lead, cwd: '/Users/hong/code/foreman', state: 'needs_input', permission_mode: 'auto', updated_at: iso(3000) },
    { session_key: w2, name: 'fix-b', role: 'worker', parent: lead, launched_by: lead, cwd: '/Users/hong/code/foreman', state: 'working', permission_mode: 'bypass', updated_at: iso(2500) },
    { session_key: held, name: 'lead-held', role: 'lead', launched_by: 'coordinator', workstream: 'held', project_name: 'Foreman', cwd: '/x', state: 'needs_input', reason: HELD_LAUNCH_REASON, permission_mode: 'bypass', started_at: iso(), updated_at: iso() },
    { session_key: leadKey(), name: 'dev-session', role: 'session', project_name: 'Foreman', state: 'idle' },
    { session_key: leadKey(), name: 'no-project', role: 'lead', launched_by: 'coordinator', workstream: 'nope', state: 'idle' },
    { session_key: leadKey(), name: 'lead-by-lead', role: 'lead', launched_by: lead, workstream: 'x', project_name: 'Foreman', state: 'idle' },
  ];
  const handoff = parseLeadHandoff({ ...checkpoint(lead), workstream: 'triage', v: 1, seq: 3, at: iso(), workers: [] });
  assert.ok(handoff.ok);
  const approvals: Record<string, number> = { [lead]: 1, [w1]: 2 };
  const records = buildLeadRecords(rows, { machine, handoffs: new Map([[lead, handoff.value]]), approvals: (key) => approvals[key] ?? 0 });
  assert.deepEqual(records.map((r) => r.name), ['lead-triage', 'lead-held']);
  const [r, h] = records;
  assert.equal(r.v, 1);
  assert.equal(r.machine_id, machine.machine_id);
  assert.equal(r.pending_approvals, 3);
  assert.equal(r.goal, 'Triage open bugs');
  assert.equal(r.last_handoff?.seq, 3);
  assert.equal(r.created_at, 1000);
  assert.equal(r.updated_at, 2000);
  assert.deepEqual(r.workers.map((w) => [w.name, w.needs_attention, w.permission_mode]), [['fix-a', true, 'auto'], ['fix-b', false, 'bypass']]);
  assert.equal(h.permission_mode, null);
  assert.equal(h.pending_approvals, 0);
  const serialized = JSON.stringify(records);
  for (const forbidden of ['cwd', 'transcript_path', '/Users/', '/x"']) assert.ok(!serialized.includes(forbidden), forbidden);
  // Without an approvals function a row's own pending_approvals count is used.
  const [fallback] = buildLeadRecords([{ ...rows[0], pending_approvals: 4 }], { machine });
  assert.equal(fallback.pending_approvals, 4);
  assert.equal(fallback.goal, 'Lead for triage');
  assert.equal(fallback.last_handoff, undefined);
});

test('supersede held for approval: the predecessor is not retired until approval; a denial leaves it running', async () => {
  const held = { status: 'awaiting_developer_approval' as const, permission_mode: null, policy_reason: 'ask_before_bypass' as const, bypass_grant: undefined };
  const f = setup();
  try {
    const old = oldLead(f);
    f.sessions.result = held;
    const out = await f.tools.call('start_lead', start);
    assert.equal(f.sessions.launches[0].supersedes, old);
    assert.equal(f.sessions.retired.length, 0);
    assert.equal(out.superseded.lead, old);
    assert.equal(out.superseded.retired, 'on approval');
    assert.match(out.message, /not retired yet.*approves.*keeps running if they deny/);
    const approved = await retireSupersededOnApproval(f.sessions, { session_key: out.lead, decision: 'approved' });
    assert.deepEqual(f.sessions.retired, [{ id: old, reason: `superseded by ${out.lead}` }]);
    assert.deepEqual(approved, { lead: out.lead, superseded: old, retired: true });
  } finally { f.cleanup(); }

  const g = setup();
  try {
    const old = oldLead(g);
    g.sessions.result = held;
    const out = await g.tools.call('start_lead', start);
    const denied = await retireSupersededOnApproval(g.sessions, { session_key: out.lead, decision: 'denied' });
    assert.equal(denied.retired, 'not needed');
    assert.equal(g.sessions.retired.length, 0);
    assert.equal(g.sessions.rows.find((r) => r.session_key === old).state, 'idle');
  } finally { g.cleanup(); }
});

test('retire on approval: force interrupts a working predecessor; without force a working one is left and reported', async () => {
  const held = { status: 'awaiting_developer_approval' as const, permission_mode: null, policy_reason: 'ask_before_bypass' as const, bypass_grant: undefined };
  const f = setup();
  try {
    const old = oldLead(f, { state: 'working' });
    f.sessions.result = held;
    const out = await f.tools.call('start_lead', { ...start, force: true });
    assert.equal(f.sessions.retired.length, 0, 'a held launch interrupts nothing, even with force');
    assert.equal(f.sessions.rows.find((r) => r.session_key === old).state, 'working');
    const approved = await retireSupersededOnApproval(f.sessions, { session_key: out.lead, decision: 'approved' });
    assert.deepEqual(f.sessions.retired, [{ id: old, reason: `superseded by ${out.lead}`, options: { force: true } }]);
    assert.equal(approved.retired, true);
  } finally { f.cleanup(); }

  const g = setup();
  try {
    const old = oldLead(g);
    g.sessions.result = held;
    const out = await g.tools.call('start_lead', start);
    g.sessions.rows.find((r) => r.session_key === old).state = 'working'; // it picked up work while the launch was held
    const approved = await retireSupersededOnApproval(g.sessions, { session_key: out.lead, decision: 'approved' });
    assert.equal(approved.retired, false);
    assert.match(approved.reason!, /is working.*no force.*left running/);
    assert.equal(g.sessions.retired.length, 0);
    // A dead predecessor at approval time is still retired.
    const dead = oldLead(g, { workstream: 'other-ws', state: 'dead' });
    g.sessions.result = held;
    const out2 = await g.tools.call('start_lead', { ...start, workstream: 'other-ws' });
    await retireSupersededOnApproval(g.sessions, { session_key: out2.lead, decision: 'approved' });
    assert.deepEqual(g.sessions.retired, [{ id: dead, reason: `superseded by ${out2.lead}` }]);
    // A Lead that supersedes nothing needs nothing.
    const out3 = await g.tools.call('start_lead', { ...start, workstream: 'fresh-ws' });
    assert.equal((await retireSupersededOnApproval(g.sessions, { session_key: out3.lead, decision: 'approved' })).retired, 'not needed');
  } finally { g.cleanup(); }
});

const RESTART_REASON = 'Foreman restarted. History is retained; start a new session to continue safely.';

test('buildLeadRecords: a Lead and workers left unknown by a Foreman restart are reported dead (end_reason restarted), path-free', () => {
  const machine = { machine_id: randomUUID(), name: 'mac' };
  const lead = leadKey(), other = leadKey(), pathy = leadKey(), live = leadKey(), w1 = leadKey(), w2 = leadKey();
  const base = { role: 'lead', launched_by: 'coordinator', project_name: 'Foreman', cwd: '/Users/hong/code/foreman', started_at: iso(1000), updated_at: iso(2000) };
  const rows = [
    { ...base, session_key: lead, name: 'lead-restarted', workstream: 'restarted', state: 'unknown', alive: false, control_reason: RESTART_REASON },
    { ...base, session_key: other, name: 'lead-codex-gone', workstream: 'gone', state: 'unknown', alive: false, control_reason: 'Codex thread closed' },
    { ...base, session_key: pathy, name: 'lead-pathy', workstream: 'pathy', state: 'unknown', alive: false, control_reason: 'spawn /Users/hong/bin/claude ENOENT' },
    { ...base, session_key: live, name: 'lead-live', workstream: 'live', state: 'idle', alive: true },
    { session_key: w1, name: 'fix-restarted', role: 'worker', parent: live, state: 'unknown', alive: false, control_reason: RESTART_REASON, updated_at: iso(9000) },
    { session_key: w2, name: 'fix-running', role: 'worker', parent: live, state: 'working', alive: true, updated_at: iso(1000) },
  ];
  const records = buildLeadRecords(rows, { machine });
  const by = new Map(records.map((r) => [r.name, r]));
  const restarted = by.get('lead-restarted')!;
  assert.equal(restarted.state, 'dead');
  assert.equal(restarted.alive, false);
  assert.equal(restarted.end_reason, RESTARTED_END_REASON);
  assert.equal(by.get('lead-codex-gone')!.state, 'dead');
  assert.equal(by.get('lead-codex-gone')!.end_reason, 'Codex thread closed');
  assert.equal(by.get('lead-pathy')!.state, 'dead');
  assert.equal(by.get('lead-pathy')!.end_reason, 'unavailable');
  const liveRecord = by.get('lead-live')!;
  assert.equal(liveRecord.state, 'idle');
  assert.equal(liveRecord.end_reason, undefined);
  // The restarted worker is dead and sorts after the running one despite being newer.
  assert.deepEqual(liveRecord.workers.map((w) => [w.name, w.state]), [['fix-running', 'working'], ['fix-restarted', 'dead']]);
  assert.ok(!JSON.stringify(records).includes('/Users/'));
});

test('supersede a restarted Lead: seeded from its last handoff (seeded_from) and retired as superseded; own_seed_seq is the new seed', async () => {
  const f = setup();
  try {
    const old = oldLead(f, { state: 'unknown', alive: false, control_reason: RESTART_REASON });
    f.sessions.rows.push({ session_key: leadKey(), name: 'fix-restarted', role: 'worker', parent: old, state: 'unknown', alive: false, control_reason: RESTART_REASON, updated_at: iso() });
    await f.store.appendHandoff(checkpoint(old));
    await f.store.appendHandoff(checkpoint(old));
    const out = await f.tools.call('start_lead', start);
    const text = f.sessions.launches[0].text;
    assert.equal(f.sessions.launches[0].supersedes, old);
    assert.match(text, /Half the bugs are triaged/);
    assert.match(text, /Handoff seq 2 \(checkpoint/);
    assert.ok(!text.includes('fix-restarted'), 'a restarted worker is not listed as live');
    assert.deepEqual(out.seeded_from, { lead: old, seq: 2, kind: 'checkpoint' });
    assert.equal(out.own_seed_seq, 1);
    assert.equal(out.seed_handoff, undefined);
    assert.deepEqual(f.sessions.retired, [{ id: old, reason: `superseded by ${out.lead}` }]);
    assert.equal(out.superseded.retired, true);
    assert.equal(out.superseded.live_workers, 0);
    const seed = f.store.handoffs.get(out.lead)!;
    assert.equal(seed[0].seq, 1);
    assert.match(seed[0].summary, /Predecessor handoff seq 2/);
    // A predecessor without any handoff: seeded_from is null.
    const g = setup();
    try {
      oldLead(g, { state: 'unknown', alive: false, control_reason: RESTART_REASON });
      const next = await g.tools.call('start_lead', start);
      assert.equal(next.seeded_from, null);
      assert.equal(next.own_seed_seq, 1);
      assert.equal(g.sessions.retired.length, 1);
    } finally { g.cleanup(); }
  } finally { f.cleanup(); }
});

test('list_leads reports a stale unknown, not-alive registry row as ended; list_workers shows restarted workers as dead', async () => {
  const f = setup();
  try {
    const stale = leadKey(), fine = leadKey();
    f.store.entries.push(entry({ lead: stale, machine_id: f.machine.machine_id, machine_name: 'mac', name: 'lead-stale', state: 'unknown', alive: false }));
    f.store.entries.push(entry({ lead: fine, machine_id: f.machine.machine_id, machine_name: 'mac', name: 'lead-fine' }));
    const active = await f.tools.call('list_leads', {});
    assert.deepEqual(active.leads.map((l: any) => l.name), ['lead-fine']);
    const all = await f.tools.call('list_leads', { include_ended: true });
    const row = all.leads.find((l: any) => l.name === 'lead-stale');
    assert.equal(row.state, 'dead');
    assert.equal(row.ended, true);
    assert.equal(row.end_reason, 'unavailable');

    const lead = oldLead(f);
    const bound = f.tools.bindLead(lead);
    f.sessions.rows.push({ session_key: leadKey(), name: 'fix-restarted', role: 'worker', parent: lead, state: 'unknown', alive: false, control_reason: RESTART_REASON, updated_at: iso() });
    f.sessions.rows.push({ session_key: leadKey(), name: 'fix-running', role: 'worker', parent: lead, state: 'working', alive: true, updated_at: iso() });
    const current = await bound.call('list_workers', {});
    assert.deepEqual(current.workers.map((w: any) => w.name), ['fix-running']);
    const every = await bound.call('list_workers', { include_ended: true });
    const dead = every.workers.find((w: any) => w.name === 'fix-restarted');
    assert.equal(dead.state, 'dead');
    assert.equal(dead.end_reason, RESTARTED_END_REASON);
  } finally { f.cleanup(); }
});

test('list_leads shows a restarted, not-yet-superseded Lead by default (ended, with a successor hint); other ended Leads stay hidden', async () => {
  const f = setup();
  try {
    const restarted = leadKey(), replaced = leadKey(), retired = leadKey(), live = leadKey();
    f.store.entries.push(entry({ lead: restarted, machine_id: f.machine.machine_id, machine_name: 'mac', name: 'lead-restarted', state: 'dead', alive: false, ended: true, end_reason: RESTARTED_END_REASON,
      last_handoff: { seq: 3, at: iso(), kind: 'checkpoint', status: 'in_progress', summary: 'PR 12 open' } }));
    f.store.entries.push(entry({ lead: replaced, machine_id: f.machine.machine_id, machine_name: 'mac', name: 'lead-replaced', state: 'ended', alive: false, ended: true, end_reason: RESTARTED_END_REASON, superseded_by: live }));
    f.store.entries.push(entry({ lead: retired, machine_id: f.machine.machine_id, machine_name: 'mac', name: 'lead-retired', state: 'ended', alive: false, ended: true, end_reason: 'retired by the Coordinator' }));
    f.store.entries.push(entry({ lead: live, machine_id: f.machine.machine_id, machine_name: 'mac', name: 'lead-live' }));
    const active = await f.tools.call('list_leads', {});
    assert.deepEqual(active.leads.map((l: any) => l.name).sort(), ['lead-live', 'lead-restarted']);
    const row = active.leads.find((l: any) => l.name === 'lead-restarted');
    assert.equal(row.ended, true);
    assert.equal(row.state, 'dead');
    assert.equal(row.end_reason, RESTARTED_END_REASON);
    assert.match(row.hint, /restarted; start a successor with start_lead to continue from its last handoff/);
    assert.equal(row.last_handoff.seq, 3);
    assert.equal(active.leads.find((l: any) => l.name === 'lead-live').hint, undefined);
    const all = await f.tools.call('list_leads', { include_ended: true });
    assert.deepEqual(all.leads.map((l: any) => l.name).sort(), ['lead-live', 'lead-replaced', 'lead-restarted', 'lead-retired']);
    assert.equal(all.leads.find((l: any) => l.name === 'lead-replaced').hint, undefined);
  } finally { f.cleanup(); }
});

test('superseding a Lead on another machine seeds only its live workers: an unknown worker counts as dead', async () => {
  const f = setup();
  try {
    const remote = leadKey();
    f.store.entries.push(entry({ lead: remote, machine_id: randomUUID(), machine_name: 'linux-box', name: 'lead-remote', workers: [
      { session_key: leadKey(), name: 'fix-unknown', state: 'unknown', permission_mode: 'bypass', needs_attention: false },
      { session_key: leadKey(), name: 'fix-dead', state: 'dead', permission_mode: 'bypass', needs_attention: false },
      { session_key: leadKey(), name: 'fix-working', state: 'working', permission_mode: 'bypass', needs_attention: false },
    ] }));
    const out = await f.tools.call('start_lead', { ...start, supersedes: remote });
    const text = f.sessions.launches[0].text;
    assert.ok(text.includes('fix-working'));
    assert.ok(!text.includes('fix-unknown'), 'an unknown remote worker is not seeded as live');
    assert.ok(!text.includes('fix-dead'));
    assert.equal(out.superseded.live_workers, 1);
  } finally { f.cleanup(); }
});

test('list_workers needs_attention follows the reported state: needs_input yes, a restarted (unknown) worker no', async () => {
  const f = setup();
  try {
    const lead = oldLead(f);
    const bound = f.tools.bindLead(lead);
    f.sessions.rows.push({ session_key: leadKey(), name: 'fix-asking', role: 'worker', parent: lead, state: 'needs_input', alive: true, updated_at: iso() });
    f.sessions.rows.push({ session_key: leadKey(), name: 'fix-restarted', role: 'worker', parent: lead, state: 'unknown', alive: false, control_reason: RESTART_REASON, updated_at: iso() });
    const every = await bound.call('list_workers', { include_ended: true });
    const by = new Map(every.workers.map((w: any) => [w.name, w]));
    assert.equal((by.get('fix-asking') as any).needs_attention, true);
    assert.equal((by.get('fix-restarted') as any).needs_attention, false);
    assert.equal((by.get('fix-restarted') as any).state, 'dead');
  } finally { f.cleanup(); }
});

test('#196 start_lead auto-picks a Lead ended by a restart on another machine (not yet superseded) as the predecessor; a live one wins', async () => {
  const f = setup();
  try {
    const restarted = leadKey();
    f.store.entries.push(entry({ lead: restarted, machine_id: randomUUID(), machine_name: 'linux-box', state: 'dead', alive: false, ended: true, end_reason: RESTARTED_END_REASON, updated_at: 50 }));
    // Ended for good (retired) or already superseded: never auto-picked.
    f.store.entries.push(entry({ lead: leadKey(), machine_id: randomUUID(), state: 'ended', alive: false, ended: true, end_reason: 'retired by the Coordinator', updated_at: 90 }));
    f.store.entries.push(entry({ lead: leadKey(), machine_id: randomUUID(), state: 'dead', alive: false, ended: true, end_reason: RESTARTED_END_REASON, superseded_by: leadKey(), updated_at: 95 }));
    await f.store.appendHandoff(checkpoint(restarted));
    const out = await f.tools.call('start_lead', start);
    assert.equal(f.sessions.launches[0].supersedes, restarted);
    assert.deepEqual(out.seeded_from, { lead: restarted, seq: 1, kind: 'checkpoint' });
    assert.match(f.sessions.launches[0].text, /on machine linux-box/);
    assert.equal(f.sessions.retired.length, 0, 'a Lead on another machine is not retired from here');
  } finally { f.cleanup(); }
  const g = setup();
  try {
    const live = leadKey();
    g.store.entries.push(entry({ lead: leadKey(), machine_id: randomUUID(), state: 'dead', alive: false, ended: true, end_reason: RESTARTED_END_REASON, updated_at: 500 }));
    g.store.entries.push(entry({ lead: live, machine_id: randomUUID(), state: 'idle', updated_at: 10 }));
    await g.tools.call('start_lead', start);
    assert.equal(g.sessions.launches[0].supersedes, live, 'a live Lead is preferred over a newer restarted one');
  } finally { g.cleanup(); }
});

test('#196 write_handoff keeps a Lead\'s handoffs on its own workstream: a different workstream is refused, the same one or a first one is accepted', async () => {
  const f = setup();
  try {
    const lead = oldLead(f);
    const bound = f.tools.bindLead(lead);
    const base = { kind: 'checkpoint', status: 'in_progress', summary: 'Working.', decisions: [], open_questions: [], next_steps: [], links: [], goal: 'Triage open bugs' };
    await assert.rejects(bound.call('write_handoff', { ...base, workstream: 'somewhere-else' }), /workstream is fixed to your own \(triage-bugs\)/);
    assert.equal(f.store.handoffs.get(lead), undefined, 'nothing stored');
    assert.equal((await bound.call('write_handoff', { ...base, workstream: 'triage-bugs' })).seq, 1);
    assert.equal(f.store.handoffs.get(lead)!.at(-1)!.workstream, 'triage-bugs');
    // A Lead row without a workstream and no handoff yet: the argument fills it in, then it is fixed.
    const bare = oldLead(f, { workstream: undefined });
    const other = f.tools.bindLead(bare);
    assert.equal((await other.call('write_handoff', { ...base, workstream: 'docs-pass' })).seq, 1);
    assert.equal(f.store.handoffs.get(bare)!.at(-1)!.workstream, 'docs-pass');
    await assert.rejects(other.call('write_handoff', { ...base, workstream: 'another-pass' }), /fixed to your own \(docs-pass\)/);
  } finally { f.cleanup(); }
});

test('#196 a held supersede needs no force after a restart: the held launch expires, so nothing is retired', async () => {
  const held = { status: 'awaiting_developer_approval' as const, permission_mode: null, policy_reason: 'ask_before_bypass' as const, bypass_grant: undefined };
  const f = setup();
  try {
    const old = oldLead(f, { state: 'working' });
    f.sessions.result = held;
    const out = await f.tools.call('start_lead', { ...start, force: true });
    // SessionService expires every held launch when Foreman restarts and emits `expired`.
    const outcome = await retireSupersededOnApproval(f.sessions, { session_key: out.lead, decision: 'expired' });
    assert.equal(outcome.retired, 'not needed');
    assert.equal(f.sessions.retired.length, 0);
    assert.equal(f.sessions.rows.find((r) => r.session_key === old).state, 'working');
  } finally { f.cleanup(); }
});
