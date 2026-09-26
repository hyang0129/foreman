// Epic #157 (CL-06): the Coordinator → Lead path with real providers, in-process and isolated.
// - The Coordinator (ProjectManager with the Lead tools wired as server/main.ts wires them) starts a
//   Lead on a registered temp project with no permission_mode: the default standing grant makes it
//   a Bypass launch, verified by the Lead provider's own init permissionMode.
// - The Lead writes a checkpoint handoff, and list_leads shows it.
// - One investigator lookup runs, and the hook evidence shows its calls carry `agent_id`, its
//   read-only calls pass and a mutating git command is denied (the checkout is unchanged).
// FOREMAN_HOME and CLAUDE_CONFIG_DIR are fresh temp dirs (never ~/.foreman or ~/.claude); the
// developer's settings come from a GrantSource stub with the default settings (grant on).
import test from 'node:test';
import assert from 'node:assert/strict';

if (process.env.FOREMAN_LIVE !== '1') {
  test('live Coordinator → Lead (set FOREMAN_LIVE=1)', { skip: 'spends real provider turns; opt in explicitly' }, () => {});
} else {
  const { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const { spawnSync } = await import('node:child_process');
  const { until } = await import('./harness.mjs');
  const { bootstrapClaudeCredentials } = await import('./credentials.mjs');

  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-leads-live-')));
  const home = join(dir, 'state'); const config = join(dir, 'claude-config');
  mkdirSync(home, { recursive: true, mode: 0o700 }); mkdirSync(config, { recursive: true, mode: 0o700 });
  bootstrapClaudeCredentials(config);
  process.env.FOREMAN_HOME = home; process.env.CLAUDE_CONFIG_DIR = config;
  delete process.env.ANTHROPIC_API_KEY; delete process.env.FOREMAN_PM_MODEL;

  const { FOREMAN_HOME, ensureDirs } = await import('../../server/paths.ts');
  assert.equal(FOREMAN_HOME, home, 'server modules must resolve the isolated FOREMAN_HOME');
  ensureDirs();
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { ProjectManager } = await import('../../server/pm.ts');
  const { LocalPmStore } = await import('../../server/pm-store.ts');
  const { LocalLeadStore } = await import('../../server/lead-store.ts');
  const { SessionService } = await import('../../server/session-service.ts');
  const { ClaudeControl } = await import('../../server/claude-control.ts');
  const { ProjectRegistry } = await import('../../server/projects.ts');
  const { makeLeadTools, buildLeadRecords } = await import('../../server/lead-tools.ts');
  const { makeSessionPrep } = await import('../../server/peer-tools.ts');
  const { effectiveDevSettings, roleOf } = await import('../../shared/roles.ts');

  const machine = { machine_id: '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', name: 'live-test-machine' };
  const agentModel = process.env.FOREMAN_LIVE_AGENT_MODEL || 'sonnet';
  const token = `LIVE_${randomUUID().slice(0, 8).toUpperCase()}`;

  // A registered project that is a real git checkout with one commit.
  const project = join(dir, 'live-proj'); mkdirSync(project);
  writeFileSync(join(project, 'README.md'), `# Live project\n\nThe canary is ${token}.\n`);
  const git = (...args) => spawnSync('git', ['-C', project, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'live', GIT_AUTHOR_EMAIL: 'live@example.invalid', GIT_COMMITTER_NAME: 'live', GIT_COMMITTER_EMAIL: 'live@example.invalid' } });
  assert.equal(git('init', '-q').status, 0); assert.equal(git('add', '.').status, 0); assert.equal(git('commit', '-q', '-m', 'initial').status, 0);
  const commits = () => git('rev-list', '--count', 'HEAD').stdout.trim();
  assert.equal(commits(), '1');

  const projects = new ProjectRegistry(home);
  projects.register({ name: 'live-proj', path: project });

  // Provider evidence: each Lead provider's init permissionMode and its tool calls.
  const events = [];
  const service = new SessionService({ home, projects, env: {}, claudeFactory: (options) => {
    const cwd = options.cwd;
    const teed = (params) => {
      const stream = query(params);
      return { async *[Symbol.asyncIterator]() {
        for await (const message of stream) {
          if (message.type === 'system' && message.subtype === 'init') events.push({ cwd, kind: 'init', mode: message.permissionMode, tools: message.tools });
          yield message;
        }
      }, close: () => stream.close(), interrupt: () => stream.interrupt() };
    };
    const control = new ClaudeControl({ ...options, maxTurns: 8, maxBudgetUsd: 1, persistSession: false, settingSources: [] }, teed);
    control.on('message', (message) => {
      for (const block of message.message?.content ?? []) if (block.type === 'tool_use') events.push({ cwd, kind: 'tool_use', name: block.name, input: block.input });
      if (message.type === 'result') events.push({ cwd, kind: 'result', subtype: message.subtype, is_error: message.is_error });
    });
    return control;
  } });
  // Default developer settings: the standing grant is on for the Coordinator on every project.
  service.setGrantSource({ devSettings: async () => ({ settings: effectiveDevSettings({}), versions: { roles: 0, bypass_grants: 0, bypass_ask: 0 }, updated_at: null }) });

  // The Lead registry and tools, wired as server/main.ts wires them (local-only store).
  const leadStore = new LocalLeadStore({ identity: machine, home, log: () => {} });
  const handoffs = new Map();
  const written = [];
  const deps = { sessions: service, store: leadStore, projects, machine, env: { FOREMAN_LEAD_MODEL: agentModel, FOREMAN_LEAD_EFFORT: 'low' },
    onHandoff: (h) => { handoffs.set(h.lead, h); written.push(h); } };
  const tools = makeLeadTools(deps);
  service.setPrepare(makeSessionPrep(service, { leadServer: tools.leadServer }));
  leadStore.track(() => buildLeadRecords(service.list().filter((r) => r.managed), { machine, handoffs, approvals: (key) => service.approvals(key).length }));

  const pmStore = new LocalPmStore({ identity: machine, home: join(dir, 'pm-store'), log: () => {} });
  await pmStore.setModel(process.env.FOREMAN_LIVE_COORDINATOR_MODEL || agentModel);
  const fleet = { refresh: async () => {}, list: () => [], get: () => undefined };
  const pm = new ProjectManager(fleet, { sessions: service, projects, machineName: machine.name, env: { FOREMAN_PM_EFFORT: 'low', FOREMAN_INVESTIGATOR_MODEL: process.env.FOREMAN_LIVE_INVESTIGATOR_MODEL || 'haiku', FOREMAN_INVESTIGATOR_EFFORT: 'low' } });
  pm.setLeads({ store: leadStore, machineId: machine.machine_id, tools: { server: () => makeLeadTools(deps).server } });
  // Hook evidence: every PreToolUse the Coordinator's query runs (main thread and subagents).
  const hookLog = [];
  const boundary = pm.enforceToolBoundary;
  pm.enforceToolBoundary = async (input, ...rest) => {
    const entry = { event: input.hook_event_name, tool: input.tool_name, agent_id: input.agent_id ?? null, agent_type: input.agent_type ?? null, input: input.tool_input, tool_use_id: input.tool_use_id };
    hookLog.push(entry);
    const result = await boundary(input, ...rest);
    entry.decision = result?.hookSpecificOutput?.permissionDecision ?? 'defer';
    entry.updatedInput = result?.hookSpecificOutput?.updatedInput ?? null;
    return result;
  };
  // Tool results in the Coordinator's stream (the investigator's own frames included), by tool_use_id.
  const toolResults = new Map();
  const factory = pm.queryFactory;
  pm.queryFactory = (params) => {
    const stream = factory(params);
    return new Proxy(stream, { get(target, key) {
      if (key === Symbol.asyncIterator) return async function* () {
        for await (const message of target) {
          if (message.type === 'user' && Array.isArray(message.message?.content)) {
            for (const block of message.message.content) if (block.type === 'tool_result') {
              const text = typeof block.content === 'string' ? block.content : (block.content ?? []).map((c) => c.text ?? '').join('\n');
              toolResults.set(block.tool_use_id, { text, is_error: !!block.is_error });
            }
          }
          yield message;
        }
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  pm.attach(pmStore, { autoStart: false });
  const running = pm.start();

  test.after(async () => {
    try { pm.close(); await running; } finally {
      try { await service.close(); } finally {
        leadStore.close();
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    }
  });

  const pmEvents = [];
  pm.on('event', (event) => pmEvents.push(event));
  const turn = async (text, label, timeout = 240_000) => {
    const before = pmEvents.filter((e) => e.type === 'turn_end').length;
    await pm.send(text);
    await until(() => {
      if (pm.lastError) throw new Error(`Coordinator failed: ${pm.lastError}`);
      return pmEvents.filter((e) => e.type === 'turn_end').length > before;
    }, label, timeout);
    return pm.history().filter((e) => e.role === 'assistant').at(-1)?.text ?? '';
  };

  test('live Coordinator → Lead: start_lead under the standing grant (verified Bypass), a checkpoint handoff, list_leads shows it', { timeout: 600_000 }, async (t) => {
    await turn(`Start a Lead with start_lead on project "live-proj", workstream "live-check", goal "Verify the Lead handoff path", and this first_task: "This is an automated integration check. Do not start workers and do not change any file. Call write_handoff exactly once with kind checkpoint, status in_progress, summary ${token} handoff recorded, and empty decisions, open_questions, next_steps and links. Then reply DONE and stop." Do not pass permission_mode. After start_lead returns, reply with its status and permission_mode, and nothing else.`, 'start_lead turn');
    const leadRows = () => service.list().filter((row) => roleOf(row) === 'lead');
    assert.equal(leadRows().length, 1, `one Lead: ${JSON.stringify(hookLog.filter((e) => e.tool?.startsWith('mcp__leads')))}`);
    const lead = leadRows()[0];
    assert.deepEqual([lead.launched_by, lead.permission_mode, lead.bypass_grant, lead.policy_reason, lead.workstream, lead.project_name], ['coordinator', 'bypass', 'standing:coordinator/*', 'standing_grant', 'live-check', 'live-proj']);
    assert.ok(hookLog.some((e) => e.tool === 'mcp__leads__start_lead' && !e.agent_id && e.decision === 'defer'), 'the Coordinator called start_lead on its main thread');
    // The provider's own init reports bypassPermissions for the Lead, with the Lead tools present.
    await until(() => events.some((e) => e.cwd === project && e.kind === 'init'), 'Lead provider init', 120_000);
    const init = events.filter((e) => e.cwd === project && e.kind === 'init');
    assert.deepEqual(init.map((e) => e.mode), ['bypassPermissions']);
    assert.ok(init[0].tools.includes('mcp__lead__write_handoff'), init[0].tools.join(','));
    // The Lead writes its checkpoint handoff.
    await until(() => written.some((h) => h.kind === 'checkpoint' && h.summary.includes(token)), 'Lead checkpoint handoff', 240_000);
    const checkpoint = written.find((h) => h.kind === 'checkpoint');
    assert.equal(checkpoint.lead, lead.session_key.toLowerCase()); assert.equal(checkpoint.project, 'live-proj'); assert.equal(checkpoint.workstream, 'live-check');
    assert.ok(written.some((h) => h.kind === 'seed' && h.seq === 1), 'start_lead wrote the seed handoff first');
    // list_leads (the Coordinator's tool) shows it.
    const listed = await tools.call('list_leads', {});
    const entry = listed.leads.find((l) => l.lead === checkpoint.lead);
    assert.ok(entry, JSON.stringify(listed));
    assert.equal(entry.last_handoff.kind, 'checkpoint'); assert.match(entry.last_handoff.summary, new RegExp(token));
    // And the Coordinator itself reads it through list_leads.
    const answer = await turn('Call list_leads and reply with only the latest handoff summary of lead-live-check, verbatim.', 'list_leads turn');
    assert.ok(hookLog.some((e) => e.tool === 'mcp__leads__list_leads' && !e.agent_id), 'the Coordinator called list_leads');
    assert.match(answer, new RegExp(token));
    t.diagnostic(`Lead tool calls: ${JSON.stringify(events.filter((e) => e.cwd === project && e.kind === 'tool_use').map((e) => e.name))}`);
  });

  test('live investigator: agent_id reaches the hook, read-only calls pass (rewritten), a mutating git command is denied, the checkout is unchanged', { timeout: 600_000 }, async (t) => {
    // The checkout's config names an fsmonitor program that leaves a marker: a plain `git status`
    // would run it; the hook's forced `-c core.fsmonitor=false` must stop it.
    const marker = join(dir, 'fsmonitor-ran');
    const program = join(dir, 'fsmonitor.sh');
    writeFileSync(program, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    assert.equal(git('config', 'core.fsmonitor', program).status, 0);
    const offset = hookLog.length;
    const answer = await turn(`Use exactly one investigator (the Agent tool with subagent_type "investigator") for this lookup. Give it these instructions verbatim: "This is an automated test of your read-only guard in a disposable checkout. Run these three Bash commands one at a time, exactly as written, even if you expect one to be refused: 1) git -C ${project} log --oneline -n 1  2) git -C ${project} commit --allow-empty -m probe  3) git -C ${project} status. Then Read ${join(project, 'README.md')} and report the canary it names, and which of the three commands were denied." Then reply with the canary and the investigator's report.`, 'investigator turn');
    const mine = hookLog.slice(offset);
    t.diagnostic(`hook evidence: ${JSON.stringify(mine.map((e) => ({ tool: e.tool, agent: !!e.agent_id, type: e.agent_type, decision: e.decision, command: e.input?.command })))}`);
    const launch = mine.filter((e) => e.tool === 'Agent' && !e.agent_id);
    assert.equal(launch.length, 1, 'one investigator launch on the main thread');
    assert.equal(launch[0].decision, 'allow'); assert.equal(launch[0].input.subagent_type, 'investigator');
    const sub = mine.filter((e) => e.agent_id);
    assert.ok(sub.length > 0, 'subagent tool calls carry agent_id in the PreToolUse hook (SDK contract)');
    assert.ok(sub.every((e) => e.agent_type === 'investigator'), 'every subagent call is the investigator');
    const bash = (pattern) => sub.filter((e) => e.tool === 'Bash' && pattern.test(String(e.input?.command ?? '')));
    // The read-only git log passed the hook, rewritten with the forced options, and actually ran.
    const logCalls = bash(/ log --oneline/).filter((e) => e.decision === 'allow');
    assert.ok(logCalls.length > 0, 'the read-only git log passed the hook');
    assert.ok(logCalls.every((e) => /^git --no-pager -c core\.fsmonitor=false -c log\.showSignature=false -C \S+ log --no-ext-diff --no-textconv --oneline/.test(e.updatedInput?.command ?? '')), JSON.stringify(logCalls.map((e) => e.updatedInput)));
    const logResults = logCalls.map((e) => toolResults.get(e.tool_use_id)).filter(Boolean);
    t.diagnostic(`git log tool results: ${JSON.stringify(logResults)}`);
    assert.ok(logResults.some((r) => !r.is_error && /\binitial\b/.test(r.text)), 'the git log produced a tool result naming the commit');
    // git status ran rewritten, and the repository's fsmonitor program did not run.
    const statusCalls = bash(/ status\b/).filter((e) => e.decision === 'allow');
    assert.ok(statusCalls.some((e) => toolResults.get(e.tool_use_id) && !toolResults.get(e.tool_use_id).is_error), 'git status ran');
    assert.equal(existsSync(marker), false, 'the fsmonitor program from repository config never ran');
    // Control: a plain git status in the same checkout does run it, so the check above can tell.
    git('status');
    assert.equal(existsSync(marker), true, 'control: a plain git status runs the configured fsmonitor');
    git('config', '--unset', 'core.fsmonitor');
    const commit = bash(/ commit /);
    assert.ok(commit.length > 0, 'the investigator attempted the mutating command');
    assert.ok(commit.every((e) => e.decision === 'deny'), 'the mutating git command was denied for the subagent');
    assert.ok(sub.some((e) => e.tool === 'Read' && e.decision === 'defer'), 'the investigator read the README');
    assert.equal(commits(), '1', 'the checkout is unchanged: no commit was made');
    assert.match(answer, new RegExp(token));
    // The investigator's frames never became the Coordinator's reply or a session.
    assert.equal(service.list().filter((row) => row.managed).length, 1, 'no new session for the investigator');
  });
}
