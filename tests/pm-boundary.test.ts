import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// server/paths.ts reads FOREMAN_HOME at import: pin it to a temp dir before loading any server module.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-pm-boundary-')));
process.env.FOREMAN_HOME = join(root, 'foreman');
test.after(() => rmSync(root, { recursive: true, force: true }));
const { ProjectManager, DISALLOWED_TOOLS, COORDINATOR_SENDER, COORDINATOR_PROMPT_FILE } = await import('../server/pm.ts');
const { LocalPmStore } = await import('../server/pm-store.ts');
const { LocalLeadStore } = await import('../server/lead-store.ts');
const { SessionService } = await import('../server/session-service.ts');
const { ProjectRegistry } = await import('../server/projects.ts');
const { makeLeadTools } = await import('../server/lead-tools.ts');
const { PM_MEMORY_TOOLS } = await import('../shared/pm-state.ts');
const { effectiveDevSettings, LAUNCH_APPROVAL_TOOL, ROLE_DEFAULTS } = await import('../shared/roles.ts');

const MACHINE = { machine_id: '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', name: 'test-machine' };

test('Coordinator main thread: docs-only Read, no writes, no Bash/Grep/Glob, no spawn_session, even for auto-approved tools, shell escapes and symlinks', async () => {
  const foremanHome = process.env.FOREMAN_HOME!;
  const memory = join(foremanHome, 'memory'), project = join(root, 'project');
  mkdirSync(memory, { recursive: true }); mkdirSync(project);
  const secret = join(foremanHome, 'cloud.json'), document = join(project, 'README.md');
  writeFileSync(secret, '{"token":"private"}'); writeFileSync(document, '# Project');
  writeFileSync(join(memory, 'PROJECTS.md'), '# Memory'); writeFileSync(join(project, 'index.ts'), 'code');
  symlinkSync(secret, join(project, 'misleading.md')); symlinkSync(project, join(memory, 'escape'));
  symlinkSync(secret, join(memory, 'secret.md'));
  const pm = new ProjectManager({} as any);
  const guard = (pm as any).canUseTool;
  const hook = (pm as any).enforceToolBoundary;
  const deny = async (name: string, input: any) => {
    assert.equal((await guard(name, input)).behavior, 'deny', `${name} ${JSON.stringify(input)}`);
    const result = await hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: randomUUID() });
    assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny', `hook ${name} ${JSON.stringify(input)}`);
  };
  const defer = async (name: string, input: any) => {
    assert.equal((await guard(name, input)).behavior, 'allow', `${name} ${JSON.stringify(input)}`);
    assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: randomUUID() }), {}, name);
  };
  // Read-only shell commands too: the main thread has no Bash at all (acceptance 2).
  for (const command of ['pwd', 'pwd > index.ts', 'pwd\nrm file', 'git branch -D main', 'git remote set-url origin x', 'ls || touch file', 'gh pr view 1', 'git -C /tmp log']) await deny('Bash', { command });
  await deny('Read', { file_path: secret });
  await deny('Read', { file_path: 'cloud.json' });
  await deny('Read', { file_path: join(project, 'misleading.md') });
  await deny('Read', { file_path: join(memory, 'secret.md') });
  await deny('Read', { file_path: join(project, 'index.ts') });
  await deny('Glob', { pattern: '**/*', path: project }); await deny('Grep', { pattern: 'token', path: foremanHome }); await deny('Grep', { pattern: 'x', path: project });
  await deny('Write', { file_path: join(memory, 'escape', 'new.md') });
  await deny('Edit', { file_path: join(memory, 'secret.md') });
  await deny('Read', { file_path: join(memory, 'PROJECTS.md') });
  await deny('Read', { file_path: 'memory/PROJECTS.md' });
  for (const name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    await deny(name, { file_path: join(memory, 'NEW.md') });
    await deny(name, { file_path: join(project, 'NOTES.md') });
  }
  assert.match((await guard('Write', { file_path: join(memory, 'NEW.md') })).message, /memory_write/);
  await defer('Read', { file_path: document });
  await defer('mcp__peers__session_state', {});
  for (const tool of PM_MEMORY_TOOLS) await defer(tool, { doc: 'projects' });
  // The Lead tools are the Coordinator's way to get work done, and the fleet reads stay.
  for (const tool of ['mcp__leads__start_lead', 'mcp__leads__retire_lead', 'mcp__leads__list_leads', 'mcp__leads__read_handoff', 'mcp__fleet__list_projects', 'mcp__fleet__resolve_project', 'mcp__fleet__register_project', 'mcp__fleet__list_models']) await defer(tool, {});
  // spawn_session is gone in every mode, not only Bypass: the Coordinator starts Leads, never sessions.
  for (const permission_mode of [undefined, 'native', 'auto', 'bypass', 'bypassPermissions']) await deny('mcp__fleet__spawn_session', { name: 'x', cwd: project, prompt: 'do the work please', permission_mode });
  // Agent: only a foreground investigator.
  await deny('Agent', { prompt: 'x' });
  await deny('Agent', { subagent_type: 'general-purpose', prompt: 'x', description: 'x' });
  await deny('Agent', { subagent_type: 'investigator', prompt: 'x', description: 'x', run_in_background: true });
  await deny('Agent', { subagent_type: 'investigator', prompt: 'x', description: 'x', isolation: 'worktree' });
  const agent = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'investigator', prompt: 'x', description: 'x' }, tool_use_id: 'agent-1' });
  assert.equal(agent.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(agent.hookSpecificOutput.updatedInput.run_in_background, false);
  await deny('mcp__unknown__tool', {});
});

// A Coordinator start with an injected provider: returns the options it would launch with.
async function startCoordinator(t: any, setup: { leads?: any; env?: Record<string, string>; sessions?: any } = {}) {
  const home = mkdtempSync(join(root, 'store-'));
  const store = new LocalPmStore({ identity: MACHINE, home, log: () => {} });
  const pm = new ProjectManager({} as any, { machineName: MACHINE.name, env: setup.env ?? {}, sessions: setup.sessions });
  if (setup.leads) pm.setLeads(setup.leads);
  pm.attach(store, { autoStart: false });
  let options: any;
  let finish!: () => void; const done = new Promise<void>((r) => { finish = r; });
  (pm as any).queryFactory = (args: any) => { options = args.options; return { close: finish, async *[Symbol.asyncIterator]() { await done; } }; };
  const running = pm.start();
  t.after(async () => { pm.close(); await running; });
  for (let i = 0; i < 100 && !options; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(options, 'the Coordinator must start a provider');
  return { options, pm, store };
}

test('the Coordinator session: memory tools, Lead tools, no spawn_session, code tools disallowed, investigators, native name kept, sender coordinator', async (t) => {
  const { options } = await startCoordinator(t, { leads: { store: null, tools: { server: () => makeLeadTools({ sessions: {} as any, store: {} as any, projects: { list: () => [], require: () => { throw new Error('x'); } }, machine: MACHINE }).server } } });
  for (const tool of PM_MEMORY_TOOLS) assert.ok(options.allowedTools.includes(tool), tool);
  assert.equal(options.allowedTools.filter((tool: string) => tool === 'mcp__fleet__log_note').length, 1);
  assert.ok(options.allowedTools.includes('mcp__leads__list_leads') && options.allowedTools.includes('mcp__leads__read_handoff'));
  assert.ok(!options.allowedTools.some((tool: string) => /spawn_session|^(Bash|Grep|Glob|Write|Edit|MultiEdit|NotebookEdit|Agent)$/.test(tool)), options.allowedTools.join(','));
  assert.deepEqual(options.disallowedTools, ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
  assert.deepEqual([...DISALLOWED_TOOLS], options.disallowedTools);
  assert.equal('resume' in options, false);
  assert.equal(options.extraArgs.name, 'foreman-pm', 'the native session name stays foreman-pm (web filters on it)');
  assert.equal(options.permissionMode, 'default');
  assert.equal(typeof options.canUseTool, 'function');
  const fleetTools = Object.keys((options.mcpServers.fleet.instance as any)._registeredTools);
  for (const name of ['memory_read', 'memory_write', 'memory_edit', 'log_note', 'list_projects', 'resolve_project', 'register_project', 'list_models', 'list_sessions']) assert.ok(fleetTools.includes(name), name);
  assert.ok(!fleetTools.includes('spawn_session'), 'the Coordinator fleet server has no spawn_session');
  const leadTools = Object.keys((options.mcpServers.leads.instance as any)._registeredTools).sort();
  assert.deepEqual(leadTools, ['list_leads', 'read_handoff', 'retire_lead', 'start_lead']);
  assert.deepEqual(Object.keys(options.agents), ['investigator']);
  assert.equal(options.agents.investigator.background, false);
  assert.match(options.systemPrompt.append, /You are the Coordinator/);
  assert.equal(COORDINATOR_PROMPT_FILE, 'coordinator-system-prompt.md');
  assert.ok(options.systemPrompt.append.includes(readFileSync(join(import.meta.dirname, '..', 'agents', COORDINATOR_PROMPT_FILE), 'utf8').slice(0, 200)));
  assert.equal(COORDINATOR_SENDER, 'coordinator');
});

test('#233: every Coordinator MCP tool is always loaded (ToolSearch is denied) and every allowed mcp__ name is a registered tool', async (t) => {
  const service: any = { list: () => [], detail: () => { throw new Error('none'); }, receipt: () => { throw new Error('none'); }, activeSource: () => 'user', send: () => { throw new Error('no'); }, create: () => { throw new Error('no'); }, interrupt: () => {} };
  const { options, pm } = await startCoordinator(t, { sessions: service, leads: { store: null, tools: { server: () => makeLeadTools({ sessions: {} as any, store: {} as any, projects: { list: () => [], require: () => { throw new Error('x'); } }, machine: MACHINE }).server } } });
  // The CLI defers MCP tools behind ToolSearch, which the Coordinator may not call.
  assert.equal((await (pm as any).canUseTool('ToolSearch', { query: 'select:mcp__fleet__memory_read' })).behavior, 'deny');
  const registered = new Set<string>();
  assert.deepEqual(Object.keys(options.mcpServers).sort(), ['fleet', 'leads', 'peers']);
  for (const [server, config] of Object.entries<any>(options.mcpServers)) {
    for (const [name, tool] of Object.entries<any>(config.instance._registeredTools)) {
      assert.equal(tool._meta?.['anthropic/alwaysLoad'], true, `mcp__${server}__${name} must not be deferred`);
      registered.add(`mcp__${server}__${name}`);
    }
  }
  const allowed = options.allowedTools.filter((name: string) => name.startsWith('mcp__'));
  for (const name of [...allowed, ...PM_MEMORY_TOOLS]) assert.ok(registered.has(name), `${name} is allowed but not registered`);
});

test('the peer sender is coordinator (was foreman-pm)', async (t) => {
  const sent: any[] = [];
  const target = { session_key: 'fm:00000000-0000-4000-8000-000000000001', managed: true, capabilities: { message: true }, name: 'lead-x', state: 'idle' };
  const service: any = { list: () => [target], detail: () => ({ session: target, history: [], receipts: [], approvals: [] }), receipt: () => { throw new Error('none'); }, activeSource: () => 'user',
    send: (id: string, text: string, messageId: string, source: any) => { sent.push({ id, text, source }); return { id: messageId, status: 'queued', at: '', source }; }, create: () => { throw new Error('no'); }, interrupt: () => {} };
  const { options } = await startCoordinator(t, { sessions: service });
  const peers = (options.mcpServers.peers.instance as any)._registeredTools;
  await peers.send_message.handler({ session: target.session_key, message_id: 'm1', text: 'status?' });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].source, { sender: 'coordinator', chain: ['coordinator'] });
  assert.match(sent[0].text, /from coordinator/);
});

test('role config (acceptance 13): model pm_settings → FOREMAN_PM_MODEL → Opus 5.5; effort DO roles → FOREMAN_PM_EFFORT → medium', async (t) => {
  const settings = (roles: any) => ({ settings: effectiveDevSettings(roles ? { roles } : {}), versions: { roles: 1, bypass_grants: 0, bypass_ask: 0 }, updated_at: 1 });
  const leadStore = (roles: any) => ({ mode: 'relay', devSettings: async () => settings(roles), list: async () => [] });
  const saved = process.env.FOREMAN_PM_MODEL;
  t.after(() => { if (saved === undefined) delete process.env.FOREMAN_PM_MODEL; else process.env.FOREMAN_PM_MODEL = saved; });
  delete process.env.FOREMAN_PM_MODEL;
  let r = await startCoordinator(t, {});
  assert.equal(r.options.model, ROLE_DEFAULTS.coordinator.model); assert.equal(r.options.model, 'opus[1m]');
  assert.equal(r.options.effort, 'medium');
  process.env.FOREMAN_PM_MODEL = 'claude-from-env';
  r = await startCoordinator(t, { env: { FOREMAN_PM_EFFORT: 'high' } });
  assert.equal(r.options.model, 'claude-from-env'); assert.equal(r.options.effort, 'high');
  r = await startCoordinator(t, { env: { FOREMAN_PM_EFFORT: 'high' }, leads: { store: leadStore({ coordinator: { effort: 'low' } }) } });
  assert.equal(r.options.effort, 'low', 'the developer setting (DO) wins over env');
  r = await startCoordinator(t, { env: { FOREMAN_PM_EFFORT: 'nonsense' }, leads: { store: leadStore(null) } });
  assert.equal(r.options.effort, 'medium', 'an invalid env value falls through to the default');
  // pm_settings.model wins over env.
  const home = mkdtempSync(join(root, 'store-'));
  const store = new LocalPmStore({ identity: MACHINE, home, log: () => {} });
  await store.setModel('claude-saved');
  const pm = new ProjectManager({} as any, { machineName: MACHINE.name, env: {} });
  pm.attach(store, { autoStart: false });
  let options: any; let finish!: () => void; const done = new Promise<void>((res) => { finish = res; });
  (pm as any).queryFactory = (args: any) => { options = args.options; return { close: finish, async *[Symbol.asyncIterator]() { await done; } }; };
  const running = pm.start(); t.after(async () => { pm.close(); await running; });
  for (let i = 0; i < 100 && !options; i++) await new Promise((res) => setTimeout(res, 5));
  assert.equal(options.model, 'claude-saved');
  // A slow or failing settings read never blocks the start: env/defaults apply.
  delete process.env.FOREMAN_PM_MODEL;
  r = await startCoordinator(t, { env: { FOREMAN_PM_EFFORT: 'xhigh' }, leads: { store: { mode: 'relay', devSettings: async () => { throw new Error('down'); }, list: async () => { throw new Error('down'); } } } });
  assert.equal(r.options.effort, 'xhigh');
  assert.match(r.options.systemPrompt.append, /## leads\n\(The Lead registry could not be read/);
});

test('memory block lists the Leads from the registry: status, latest handoff, machine and online flag; other machines are not reachable', async (t) => {
  const entry = (over: any) => ({
    v: 1, lead: `fm:${randomUUID()}`, machine_id: MACHINE.machine_id, machine_name: MACHINE.name, name: 'lead-triage', project: 'foreman', workstream: 'triage',
    goal: 'Triage the open bugs', model: 'opus[1m]', effort: 'medium', permission_mode: 'bypass', launched_by: 'coordinator', state: 'idle', alive: true,
    created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000, pending_approvals: 0, workers: [], machine_online: true, reported_at: 1_700_000_000_000, ended: false, ...over,
  });
  const leads = [
    entry({ name: 'lead-triage', pending_approvals: 2, last_handoff: { seq: 3, at: '2026-09-25T10:00:00.000Z', kind: 'checkpoint', status: 'blocked', summary: 'PR #12 waits on review CANARY_SUMMARY_42' } }),
    entry({ name: 'lead-remote', machine_id: '11111111-2222-4333-8444-555555555555', machine_name: 'machine-b', machine_online: false, workstream: 'docs', updated_at: 1_700_000_000_500 }),
    entry({ name: 'lead-old', ended: true, state: 'ended' }),
    entry({ name: 'lead-superseded', superseded_by: `fm:${randomUUID()}` }),
    ...Array.from({ length: 25 }, (_, i) => entry({ name: `lead-many-${i}`, workstream: `w${i}`, updated_at: 1_600_000_000_000 + i })),
  ];
  const lists: any[] = [];
  const store = { mode: 'relay', devSettings: async () => null, list: async (opts: any) => { lists.push(opts); return leads; } };
  const { options } = await startCoordinator(t, { leads: { store, machineId: MACHINE.machine_id } });
  const prompt: string = options.systemPrompt.append;
  const section = prompt.slice(prompt.indexOf('## leads'));
  assert.ok(prompt.indexOf('## leads') > prompt.indexOf('## log'), 'the leads section is part of the memory block');
  assert.match(section, /- lead-triage \(fm:[0-9a-f-]+\): project foreman, workstream triage, idle, Bypass, on this machine \(test-machine\), machine online, 2 pending approvals/);
  assert.match(section, /latest handoff: seq 3 checkpoint, blocked, 2026-09-25T10:00:00.000Z: PR #12 waits on review CANARY_SUMMARY_42/);
  assert.match(section, /- lead-remote .*on machine-b, not reachable from here, machine offline, last known state at /);
  assert.doesNotMatch(section, /lead-old|lead-superseded/, 'archived Leads are omitted');
  assert.equal((section.match(/^- lead-/gm) ?? []).length, 20, 'capped at 20');
  assert.match(section, /\(7 more; use list_leads\)/);
  assert.deepEqual(lists, [{ include_ended: true }]);
  assert.doesNotMatch(section, /\/Users\/|\/home\/|\/tmp\//, 'no filesystem paths');
});

test('memory block lists restarted, not-yet-superseded Leads separately so the Coordinator offers successors; the cap stays 20', async (t) => {
  const entry = (over: any) => ({
    v: 1, lead: `fm:${randomUUID()}`, machine_id: MACHINE.machine_id, machine_name: MACHINE.name, name: 'lead-x', project: 'foreman', workstream: 'triage',
    goal: 'g', model: 'opus[1m]', effort: 'medium', permission_mode: 'bypass', launched_by: 'coordinator', state: 'idle', alive: true,
    created_at: 1, updated_at: 1_700_000_000_000, pending_approvals: 0, workers: [], machine_online: true, reported_at: 1_700_000_000_000, ended: false, ...over,
  });
  const restartedLead = (over: any) => entry({ state: 'dead', alive: false, ended: true, end_reason: 'restarted', ...over });
  const leads = [
    restartedLead({ name: 'lead-restarted', workstream: 'docs', last_handoff: { seq: 4, at: '2026-09-25T10:00:00.000Z', kind: 'checkpoint', status: 'in_progress', summary: 'PR #30 is open CANARY_RESTART' } }),
    restartedLead({ name: 'lead-restarted-replaced', superseded_by: `fm:${randomUUID()}` }),
    entry({ name: 'lead-retired', state: 'ended', alive: false, ended: true, end_reason: 'retired by the Coordinator' }),
    entry({ name: 'lead-dead-crash', state: 'dead', alive: false, ended: true, end_reason: 'provider exited' }),
    ...Array.from({ length: 6 }, (_, i) => restartedLead({ name: `lead-rs-${i}`, workstream: `r${i}`, updated_at: 1_600_000_000_000 + i })),
    ...Array.from({ length: 25 }, (_, i) => entry({ name: `lead-many-${i}`, workstream: `w${i}`, updated_at: 1_600_000_000_000 + i })),
  ];
  const lists: any[] = [];
  const store = { mode: 'relay', devSettings: async () => null, list: async (opts: any) => { lists.push(opts); return opts?.include_ended ? leads : leads.filter((l) => !l.ended); } };
  const { options } = await startCoordinator(t, { leads: { store, machineId: MACHINE.machine_id } });
  const section: string = options.systemPrompt.append.slice(options.systemPrompt.append.indexOf('## leads'));
  assert.deepEqual(lists, [{ include_ended: true }]);
  const restartedAt = section.indexOf('Restarted Leads (offer successors');
  assert.ok(restartedAt > 0, 'a separate restarted sub-list');
  const restartedPart = section.slice(restartedAt);
  assert.match(restartedPart, /- lead-restarted \(fm:[0-9a-f-]+\): project foreman, workstream docs, ended \(restarted\), on this machine/);
  assert.match(restartedPart, /latest handoff: seq 4 checkpoint, in_progress, 2026-09-25T10:00:00.000Z: PR #30 is open CANARY_RESTART/);
  assert.doesNotMatch(section, /lead-restarted-replaced|lead-retired|lead-dead-crash/, 'superseded and other ended Leads stay hidden');
  assert.equal((section.match(/^- lead-/gm) ?? []).length, 20, 'capped at 20 in total');
  assert.equal((restartedPart.match(/^- lead-/gm) ?? []).length, 5, 'at most 5 restarted');
  assert.match(restartedPart, /\(2 more restarted; use list_leads\)/);
  assert.match(section.slice(0, restartedAt), /\(10 more; use list_leads\)/);
});

test('memory block with only restarted Leads still offers successors', async (t) => {
  const lead = { v: 1, lead: `fm:${randomUUID()}`, machine_id: MACHINE.machine_id, machine_name: MACHINE.name, name: 'lead-only', project: 'foreman', workstream: 'solo',
    goal: 'g', model: 'opus[1m]', effort: 'medium', permission_mode: 'bypass', launched_by: 'coordinator', state: 'dead', alive: false, created_at: 1, updated_at: 2,
    pending_approvals: 0, workers: [], machine_online: true, reported_at: 2, ended: true, end_reason: 'restarted' };
  const store = { mode: 'relay', devSettings: async () => null, list: async () => [lead] };
  const { options } = await startCoordinator(t, { leads: { store, machineId: MACHINE.machine_id } });
  const section: string = options.systemPrompt.append.slice(options.systemPrompt.append.indexOf('## leads'));
  assert.match(section, /\(no active Leads\)\nRestarted Leads \(offer successors[^\n]*\n- lead-only .*ended \(restarted\)/);
  assert.match(section, /latest handoff: none/);
});

test('a Coordinator on machine B lists the same Leads from the shared registry (acceptance 9)', async (t) => {
  const leads = [{ v: 1, lead: `fm:${randomUUID()}`, machine_id: MACHINE.machine_id, machine_name: 'machine-a', name: 'lead-shared', project: 'foreman', workstream: 'shared',
    goal: 'g', model: 'opus[1m]', effort: 'medium', permission_mode: 'auto', launched_by: 'coordinator', state: 'working', alive: true, created_at: 1, updated_at: 2,
    pending_approvals: 0, workers: [], machine_online: true, reported_at: 2, ended: false }];
  const store = { mode: 'relay', devSettings: async () => null, list: async () => leads };
  const a = await startCoordinator(t, { leads: { store, machineId: MACHINE.machine_id } });
  const b = await startCoordinator(t, { leads: { store, machineId: '11111111-2222-4333-8444-555555555555' } });
  assert.match(a.options.systemPrompt.append, /lead-shared .*on this machine \(machine-a\)/);
  assert.match(b.options.systemPrompt.append, /lead-shared .*on machine-a, not reachable from here/);
});

class FakeClaude extends EventEmitter {
  sent: any[] = [];
  send(text: string, id: string) { this.sent.push({ text, id }); return { id, status: 'running' }; }
  pendingApprovals() { return []; }
  close() {}
}

test('acceptance 12: a Coordinator Bypass request goes through start_lead → launchAgent: a standing-grant launch, an Auto fallback or a held launch, never a direct create()', async (t) => {
  const home = mkdtempSync(join(root, 'svc-'));
  mkdirSync(join(home, 'foreman'), { recursive: true }); mkdirSync(join(home, 'project'));
  const projectPath = realpathSync(join(home, 'project'));
  const projects = new ProjectRegistry(join(home, 'foreman'));
  projects.register({ name: 'foreman', path: projectPath });
  const launches: any[] = [];
  let grants: any = null;
  const service = new SessionService({ home: join(home, 'foreman'), projects, env: { FOREMAN_MAX_LEADS: '10' }, claudeFactory: ((options: any) => { launches.push(options); return new FakeClaude(); }) as any, codexFactory: () => { throw new Error('codex'); } });
  service.setGrantSource({ devSettings: async () => grants });
  let creates = 0;
  const create = service.create.bind(service);
  (service as any).create = (...args: any[]) => { creates++; return (create as any)(...args); };
  const leadStore = new LocalLeadStore({ identity: MACHINE, home: join(home, 'foreman'), log: () => {} });
  t.after(() => { leadStore.close(); service.close(); });
  const { options, pm } = await startCoordinator(t, { leads: { store: leadStore, machineId: MACHINE.machine_id, tools: { server: () => makeLeadTools({ sessions: service, store: leadStore, projects, machine: MACHINE }).server } } });
  const startLead = (options.mcpServers.leads.instance as any)._registeredTools.start_lead;
  const guard = (pm as any).canUseTool, hook = (pm as any).enforceToolBoundary;
  const view = (stored: any) => ({ settings: effectiveDevSettings(stored), versions: { roles: 0, bypass_grants: 0, bypass_ask: 0 }, updated_at: null });
  const request = (workstream: string) => ({ project: 'foreman', workstream, goal: 'Triage the open bugs', first_task: 'List the open bugs and propose an order.', permission_mode: 'bypass' });
  const call = async (workstream: string) => {
    const input = request(workstream);
    // The tool call itself is allowed (by the boundary): the launch policy is not the model's to grant.
    assert.equal((await guard('mcp__leads__start_lead', input)).behavior, 'allow');
    assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__leads__start_lead', tool_input: input, tool_use_id: randomUUID() }), {});
    const result = await startLead.handler(input);
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  const rowOf = (key: string) => service.list().find((row: any) => row.session_key === key);

  // Standing grant (the default): Bypass, recorded as a standing grant.
  grants = view({});
  let out = await call('standing');
  assert.equal(out.status, 'started'); assert.equal(out.permission_mode, 'bypass'); assert.equal(out.bypass_grant, 'standing:coordinator/*'); assert.equal(out.policy_reason, 'standing_grant');
  assert.equal(launches.at(-1).permission_mode, 'bypass');
  assert.equal(rowOf(out.lead)!.role, 'lead'); assert.equal(rowOf(out.lead)!.launched_by, 'coordinator');

  // Grant off: Auto, never Bypass.
  grants = view({ bypass_grants: [{ role: 'coordinator', project: '*', allow: false }] });
  const before = launches.length;
  out = await call('grant-off');
  assert.equal(out.status, 'started'); assert.equal(out.permission_mode, 'auto'); assert.equal(out.policy_reason, 'grant_off'); assert.equal(out.bypass_grant, undefined);
  assert.equal(launches.length, before + 1); assert.equal(launches.at(-1).permission_mode, 'auto');

  // Settings unavailable: Auto.
  grants = null;
  out = await call('unavailable');
  assert.equal(out.permission_mode, 'auto'); assert.equal(out.policy_reason, 'grant_unavailable');

  // "Ask me before each Bypass launch": held, nothing launched, one approval card.
  grants = view({ bypass_ask: true });
  const held = launches.length;
  out = await call('held');
  assert.equal(out.status, 'awaiting_developer_approval'); assert.equal(out.permission_mode, null);
  assert.equal(launches.length, held, 'a held launch starts nothing');
  const approvals = service.approvals(out.lead);
  assert.equal(approvals.length, 1); assert.equal(approvals[0]!.tool, LAUNCH_APPROVAL_TOOL); assert.equal(approvals[0]!.input.requested_by, 'coordinator');

  assert.equal(creates, 0, 'the Coordinator never launches through the developer create() path');
  assert.ok(launches.every((l) => l.permission_mode === 'bypass' || l.permission_mode === 'auto'), 'never Native');
});
