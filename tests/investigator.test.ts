// Epic #157 (CL-06, acceptance 3): the Coordinator's investigators are read-only SDK subagents.
// Every tool call a subagent makes carries `agent_id` in the PreToolUse hook (SDK 0.3.270
// sdk.d.ts: present only for subagent calls) and gets the investigator rules; at most 3 run at
// once; they run in the foreground, with no isolation, with model and effort from the role config.
// Pin FOREMAN_HOME to a temp dir before any server module loads (story #121 guard).
import './fixtures/temp-foreman-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  ProjectManager, InvestigatorSlots, investigatorAgents, investigatorBashDenial, investigatorDecision, investigatorPathDenial,
  INVESTIGATOR_TOOLS, INVESTIGATOR_MAX_TURNS, MAX_INVESTIGATORS,
} = await import('../server/pm.ts');
const { LocalPmStore } = await import('../server/pm-store.ts');
const { effectiveDevSettings, resolveRoleConfig, ROLE_DEFAULTS } = await import('../shared/roles.ts');

const TEMP_FOREMAN_HOME = process.env.FOREMAN_HOME!;
const root = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-investigator-')));
test.after(() => rmSync(root, { recursive: true, force: true }));
// A project checkout (a `.git` directory marks the work tree), a nested .env, and Foreman's state.
const project = join(root, 'project');
mkdirSync(join(project, '.git'), { recursive: true }); mkdirSync(join(project, 'src'));
writeFileSync(join(project, 'README.md'), '# Project'); writeFileSync(join(project, 'src', 'index.ts'), 'export {}');
writeFileSync(join(project, '.env'), 'SECRET=1'); writeFileSync(join(project, '.env.local'), 'SECRET=2');
const notRepo = join(root, 'plain'); mkdirSync(notRepo);
writeFileSync(join(TEMP_FOREMAN_HOME, 'cloud.json'), '{"token":"private"}');
mkdirSync(join(TEMP_FOREMAN_HOME, 'pm'), { recursive: true }); writeFileSync(join(TEMP_FOREMAN_HOME, 'pm', 'state.json'), '{}');
symlinkSync(join(TEMP_FOREMAN_HOME, 'cloud.json'), join(project, 'config.json'));
symlinkSync(join(project, '.env'), join(project, 'settings.txt'));

const behavior = (name: string, input: Record<string, unknown>) => investigatorDecision(name, input).behavior;
const denied = (name: string, input: Record<string, unknown>) => assert.equal(behavior(name, input), 'deny', `${name} ${JSON.stringify(input)} must be denied`);
const allowed = (name: string, input: Record<string, unknown>) => assert.equal(behavior(name, input), 'allow', `${name} ${JSON.stringify(input)} must be allowed: ${JSON.stringify(investigatorDecision(name, input))}`);

test('Read: project files are readable; FOREMAN_HOME, credential directories, .env files and symlinks into them are not', () => {
  allowed('Read', { file_path: join(project, 'README.md') });
  allowed('Read', { file_path: join(project, 'src', 'index.ts') }); // source code is fine for investigators
  denied('Read', { file_path: join(TEMP_FOREMAN_HOME, 'cloud.json') });
  denied('Read', { file_path: 'cloud.json' }); // relative to the Coordinator's cwd, FOREMAN_HOME
  denied('Read', { file_path: 'pm/state.json' });
  denied('Read', { file_path: join(project, 'config.json') }); // symlink into FOREMAN_HOME
  denied('Read', { file_path: join(project, '.env') });
  denied('Read', { file_path: join(project, '.env.local') });
  denied('Read', { file_path: join(project, 'settings.txt') }); // symlink to a .env file
  for (const dir of ['.ssh', '.claude', '.codex', '.config/gh']) denied('Read', { file_path: join(homedir(), dir, 'anything') });
  denied('Read', { file_path: '~/.ssh/id_ed25519' });
  denied('Read', { file_path: join(project, 'missing.md') });
  denied('Read', { file_path: project }); // a directory is not a file
  denied('Read', {});
  assert.match((investigatorDecision('Read', { file_path: join(TEMP_FOREMAN_HOME, 'cloud.json') }) as any).message, /investigators/i);
});

test('Grep and Glob: an explicit project path; never FOREMAN_HOME, a directory containing it or a credential directory, never .env globs', () => {
  allowed('Grep', { pattern: 'export', path: project });
  allowed('Grep', { pattern: 'export', path: join(project, 'src'), glob: '*.ts' });
  allowed('Glob', { pattern: '**/*.ts', path: project });
  allowed('Grep', { pattern: 'export', path: join(project, 'src', 'index.ts'), output_mode: 'content' });
  for (const name of ['Grep', 'Glob']) {
    denied(name, { pattern: 'token' }); // no path: the cwd is FOREMAN_HOME
    denied(name, { pattern: 'token', path: TEMP_FOREMAN_HOME });
    denied(name, { pattern: 'token', path: '.' });
    denied(name, { pattern: 'token', path: root.split('/').slice(0, -1).join('/') }); // contains FOREMAN_HOME
    denied(name, { pattern: 'token', path: homedir() }); // contains ~/.ssh, ~/.claude
    denied(name, { pattern: 'token', path: join(homedir(), '.ssh') });
    denied(name, { pattern: 'x', path: project, glob: '.env*' });
    denied(name, { pattern: 'x', path: project, glob: '../*' });
    denied(name, { pattern: 'x', path: project, glob: '/etc/*' });
  }
  denied('Glob', { pattern: '../../**', path: project });
  denied('Glob', { pattern: '/Users/*/.ssh/*', path: project });
  // Content output from a directory search could print a nested .env: it needs a single readable file.
  denied('Grep', { pattern: 'SECRET', path: project, output_mode: 'content' });
  denied('Grep', { pattern: 'SECRET', path: join(project, '.env'), output_mode: 'content' });
});

test('Bash: only the exact read-only gh and git prefixes', () => {
  for (const command of [
    'gh issue view 12 -R owner/repo', 'gh issue list -R owner/repo --state open', 'gh pr view 156 -R owner/repo --comments',
    'gh pr list -R owner/repo', 'gh pr diff 156 -R owner/repo', 'gh pr checks 156 -R owner/repo', 'gh run view 99 -R owner/repo --log',
    'gh run list -R owner/repo --limit 5', `git -C ${project} log --oneline -n 20`, `git -C ${project} show HEAD`,
    `git -C ${project} status`, `git -C ${project} diff main..HEAD --stat`, `git -C ${project} diff HEAD -- src/index.ts`,
    `git -C ${project} branch -a`, `git -C ${project} branch --list feature`, `git -C ${project} log --format=%H,%an`,
    `git -C ${join(project, 'src')} log`,
  ]) assert.equal(investigatorBashDenial(command), null, command);
  for (const command of [
    'gh api repos/owner/repo', 'gh api -X DELETE repos/x', 'gh pr merge 1', 'gh pr create', 'gh issue create', 'gh issue close 1', 'gh pr comment 1 -b x',
    'gh run rerun 1', 'gh repo clone owner/repo', 'gh pr view 1 --web', 'gh pr checks 1 --watch', 'gh -R owner/repo pr view 1', 'gh auth token',
    'git log', 'git status', // no -C: the cwd is FOREMAN_HOME
    'git -C relative/dir log', `git -C ${TEMP_FOREMAN_HOME} log`, `git -C ${notRepo} log`, `git -C ${join(homedir(), '.claude')} log`,
    `git -C ${project} push`, `git -C ${project} commit -m x`, `git -C ${project} checkout main`, `git -C ${project} reset --hard`,
    `git -C ${project} branch -D main`, `git -C ${project} branch new-branch`, `git -C ${project} branch -m a b`, `git -C ${project} branch --set-upstream-to=x`,
    `git -C ${project} diff --output=/tmp/x`, `git -C ${project} log --output=out.txt`, `git -C ${project} diff --no-index a b`,
    `git -C ${project} diff --ext-diff`, `git -C ${project} diff /etc/hosts src/index.ts`, `git -C ${project} diff ../other/file src/index.ts`,
    `git -C ${project} -c core.pager=x log`, `git --git-dir=${project}/.git log`, `git -C ${project} config user.name`,
    'rm -rf /', 'cat README.md', 'ls', 'npm test', 'curl https://example.com', 'env', 'FOO=bar gh pr view 1', '=gh pr view 1',
    '', '   ',
  ]) assert.notEqual(investigatorBashDenial(command), null, command);
});

test('Bash: every shell metacharacter, quote, backslash, newline and non-ASCII character is refused', () => {
  const base = 'gh pr view 1 -R owner/repo';
  assert.equal(investigatorBashDenial(base), null);
  for (const ch of [';', '|', '&', '$', '`', '<', '>', '(', ')', '{', '}', '*', '?', '[', ']', '~', '!', '#', "'", '"', '\\', '\n', '\r', '\t', '\u0000', '^', ' ', 'é', ' ']) {
    assert.notEqual(investigatorBashDenial(`${base}${ch}`), null, JSON.stringify(ch));
    assert.notEqual(investigatorBashDenial(`${base} ${ch}x`), null, JSON.stringify(ch));
  }
  for (const command of [`${base}; rm -rf /`, `${base} && touch x`, `${base} || touch x`, `${base} | sh`, `${base} > out`, `${base} $(touch x)`,
    `${base} \`touch x\``, `${base}\ntouch x`, `git -C ${project} log; touch x`, `git -C ${project} log > ${project}/x`, 'gh pr view $PR', 'gh pr view ${PR}']) {
    assert.notEqual(investigatorBashDenial(command), null, command);
  }
});

test('writes, Agent, fleet, Lead, peer and memory tools, and anything else are denied to investigators', () => {
  for (const name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'TodoWrite', 'SendMessage', 'mcp__fleet__spawn_session',
    'mcp__fleet__list_sessions', 'mcp__fleet__memory_write', 'mcp__fleet__memory_read', 'mcp__fleet__log_note', 'mcp__leads__start_lead',
    'mcp__leads__list_leads', 'mcp__peers__send_message', 'mcp__peers__session_tail', 'KillShell', 'Skill']) {
    denied(name, { file_path: join(project, 'README.md'), command: 'gh pr view 1', subagent_type: 'investigator', prompt: 'x' });
  }
  allowed('WebFetch', { url: 'https://example.com', prompt: 'x' });
  allowed('WebSearch', { query: 'x' });
});

test('investigatorPathDenial canonicalizes and refuses directories that contain a protected location', () => {
  assert.equal(investigatorPathDenial(project, 'any'), null);
  assert.match(investigatorPathDenial('/', 'any')!, /contains/);
  assert.match(investigatorPathDenial(TEMP_FOREMAN_HOME, 'any')!, /credential|state/);
  assert.match(investigatorPathDenial(join(project, 'config.json'), 'file')!, /state|credential/);
});

test('the hook applies the investigator rules to every subagent call (agent_id) and the Coordinator rules to the main thread', async () => {
  const pm = new ProjectManager({} as any);
  const hook = (pm as any).enforceToolBoundary;
  const run = (tool_name: string, tool_input: any, agent_id?: string) => hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: `t-${Math.random()}`, ...(agent_id ? { agent_id, agent_type: 'investigator' } : {}) });
  const decision = (r: any) => r.hookSpecificOutput?.permissionDecision ?? 'defer';
  // Subagent: read-only rules.
  assert.equal(decision(await run('Read', { file_path: join(project, 'src', 'index.ts') }, 'agent-1')), 'defer');
  assert.equal(decision(await run('Bash', { command: 'gh pr view 1 -R o/r' }, 'agent-1')), 'defer');
  assert.equal(decision(await run('Bash', { command: 'git -C . log' }, 'agent-1')), 'deny');
  assert.equal(decision(await run('Bash', { command: 'gh api repos/o/r' }, 'agent-1')), 'deny');
  assert.equal(decision(await run('Write', { file_path: join(project, 'x.md'), content: 'x' }, 'agent-1')), 'deny');
  assert.equal(decision(await run('Read', { file_path: join(TEMP_FOREMAN_HOME, 'cloud.json') }, 'agent-1')), 'deny');
  assert.equal(decision(await run('mcp__fleet__memory_write', { doc: 'projects', content: 'x' }, 'agent-1')), 'deny');
  assert.equal(decision(await run('mcp__leads__start_lead', {}, 'agent-1')), 'deny');
  // Main thread: the same calls keep the Coordinator rules (source Read and every Bash denied).
  assert.equal(decision(await run('Read', { file_path: join(project, 'src', 'index.ts') })), 'deny');
  assert.equal(decision(await run('Bash', { command: 'gh pr view 1 -R o/r' })), 'deny');
  assert.equal(decision(await run('Read', { file_path: join(project, 'README.md') })), 'defer');
  // canUseTool takes the same split from `agentID`.
  const guard = (pm as any).canUseTool;
  assert.equal((await guard('Bash', { command: 'gh pr view 1 -R o/r' }, { agentID: 'agent-1' })).behavior, 'allow');
  assert.equal((await guard('Bash', { command: 'gh pr view 1 -R o/r' })).behavior, 'deny');
  assert.equal((await guard('Bash', { command: 'gh pr view 1; rm -rf ~' }, { agentID: 'agent-1' })).behavior, 'deny');
});

test('investigators run in the foreground, with no isolation, only as subagent_type investigator', async () => {
  const pm = new ProjectManager({} as any);
  const guard = (pm as any).canUseTool, hook = (pm as any).enforceToolBoundary;
  const input = { subagent_type: 'investigator', description: 'PR 156', prompt: 'What happened on PR 156?' };
  const allowedCall = await guard('Agent', input);
  assert.equal(allowedCall.behavior, 'allow');
  assert.equal(allowedCall.updatedInput.run_in_background, false, 'an omitted run_in_background (the SDK default is background) is forced to false');
  const viaHook = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { ...input, run_in_background: false }, tool_use_id: 'agent-call-1' });
  assert.equal(viaHook.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(viaHook.hookSpecificOutput.updatedInput.run_in_background, false);
  for (const bad of [{ ...input, run_in_background: true }, { ...input, isolation: 'worktree' }, { ...input, isolation: 'remote' }, { ...input, mode: 'bypassPermissions' },
    { ...input, subagent_type: 'general-purpose' }, { ...input, subagent_type: undefined }, { ...input, subagent_type: 'Explore' }, { ...input, subagent_type: 'fork' }]) {
    assert.equal((await guard('Agent', bad)).behavior, 'deny', JSON.stringify(bad));
    const r = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: bad, tool_use_id: `bad-${Math.random()}` });
    assert.equal(r.hookSpecificOutput.permissionDecision, 'deny', JSON.stringify(bad));
  }
  // The model may be chosen per investigator (the Agent tool's own `model` input).
  assert.equal((await guard('Agent', { ...input, model: 'sonnet' })).behavior, 'allow');
});

test('at most 3 investigators at once, counted with SubagentStart/SubagentStop (and released when the Agent call ends)', async () => {
  const pm = new ProjectManager({} as any);
  const hook = (pm as any).enforceToolBoundary;
  const slots: InstanceType<typeof InvestigatorSlots> = (pm as any).slots;
  const hooks = slots.hooks();
  const fire = (event: string, input: any) => (hooks as any)[event][0].hooks[0]({ hook_event_name: event, ...input });
  const launch = (id: string) => hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'investigator', description: 'x', prompt: 'x' }, tool_use_id: id });
  assert.equal(MAX_INVESTIGATORS, 3);
  for (const id of ['a', 'b', 'c']) assert.equal((await launch(id)).hookSpecificOutput.permissionDecision, 'allow', id);
  const fourth = await launch('d');
  assert.equal(fourth.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(fourth.hookSpecificOutput.permissionDecisionReason, /at most 3 investigators/);
  for (const id of ['1', '2', '3']) await fire('SubagentStart', { agent_id: id, agent_type: 'investigator' });
  // The first finishes: its subagent stops and its Agent call returns.
  await fire('SubagentStop', { agent_id: '1', agent_type: 'investigator' });
  assert.equal((await launch('d')).hookSpecificOutput.permissionDecision, 'deny', 'the Agent call a is still in flight');
  await fire('PostToolUse', { tool_name: 'Agent', tool_use_id: 'a' });
  assert.equal((await launch('d')).hookSpecificOutput.permissionDecision, 'allow');
  // A failed launch releases its reservation too; a subagent that has not stopped keeps its slot.
  await fire('PostToolUseFailure', { tool_name: 'Agent', tool_use_id: 'b' });
  await fire('PostToolUse', { tool_name: 'Agent', tool_use_id: 'c' });
  assert.equal(slots.inUse, 2, 'subagents 2 and 3 are still running');
  await fire('SubagentStop', { agent_id: '2' }); await fire('SubagentStop', { agent_id: '3' }); await fire('PostToolUse', { tool_name: 'Agent', tool_use_id: 'd' });
  assert.equal(slots.inUse, 0);
  // A subagent's own tool calls never release a Coordinator Agent reservation.
  assert.equal((await launch('e')).hookSpecificOutput.permissionDecision, 'allow');
  await fire('PostToolUse', { tool_name: 'Agent', tool_use_id: 'e', agent_id: 'nested' });
  assert.equal(slots.inUse, 1);
});

test('the investigator definition: read-only tools, 15 turns, foreground, model and effort from the role config (DO → env → default)', async (t) => {
  const defaults = investigatorAgents(resolveRoleConfig('investigator'));
  assert.deepEqual(Object.keys(defaults), ['investigator']);
  assert.deepEqual(defaults.investigator.tools, [...INVESTIGATOR_TOOLS]);
  assert.deepEqual([...INVESTIGATOR_TOOLS].sort(), ['Bash', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch']);
  assert.equal(defaults.investigator.maxTurns, INVESTIGATOR_MAX_TURNS); assert.equal(INVESTIGATOR_MAX_TURNS, 15);
  assert.equal(defaults.investigator.background, false);
  assert.equal(defaults.investigator.model, ROLE_DEFAULTS.investigator.model); assert.equal(defaults.investigator.model, 'opus');
  assert.equal(defaults.investigator.effort, 'low');

  // Through a real Coordinator start: the query gets the investigator agent from the role config.
  const start = async (env: Record<string, string>, roles: any) => {
    const home = mkdtempSync(join(root, 'store-'));
    const store = new LocalPmStore({ identity: { machine_id: '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', name: 'test-machine' }, home, log: () => {} });
    const pm = new ProjectManager({} as any, { machineName: 'test-machine', env });
    const settings = { settings: effectiveDevSettings(roles ? { roles } : {}), versions: { roles: 1, bypass_grants: 0, bypass_ask: 0 }, updated_at: 1 };
    const leadStore: any = { mode: 'relay', devSettings: async () => settings, list: async () => [] };
    pm.setLeads({ store: leadStore, machineId: '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21' });
    pm.attach(store, { autoStart: false });
    let options: any; let finish!: () => void; const done = new Promise<void>((r) => { finish = r; });
    (pm as any).queryFactory = (args: any) => { options = args.options; return { close: finish, async *[Symbol.asyncIterator]() { await done; } }; };
    const running = pm.start();
    t.after(async () => { pm.close(); await running; });
    for (let i = 0; i < 100 && !options; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(options, 'the Coordinator must start a provider');
    return options;
  };
  let options = await start({}, null);
  assert.deepEqual([options.agents.investigator.model, options.agents.investigator.effort], ['opus', 'low']);
  options = await start({ FOREMAN_INVESTIGATOR_MODEL: 'sonnet', FOREMAN_INVESTIGATOR_EFFORT: 'medium' }, null);
  assert.deepEqual([options.agents.investigator.model, options.agents.investigator.effort], ['sonnet', 'medium']);
  options = await start({ FOREMAN_INVESTIGATOR_MODEL: 'sonnet', FOREMAN_INVESTIGATOR_EFFORT: 'medium' }, { investigator: { model: 'haiku', effort: 'high' } });
  assert.deepEqual([options.agents.investigator.model, options.agents.investigator.effort], ['haiku', 'high']);
  // The hooks that count investigators are registered with the query.
  for (const event of ['PreToolUse', 'SubagentStart', 'SubagentStop', 'PostToolUse', 'PostToolUseFailure']) assert.ok(options.hooks[event]?.length, event);
});
