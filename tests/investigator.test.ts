// Epic #157 (CL-06, acceptance 3): the Coordinator's investigators are read-only SDK subagents.
// Every tool call a subagent makes carries `agent_id` in the PreToolUse hook (SDK 0.3.270
// sdk.d.ts: present only for subagent calls) and gets the investigator rules; at most 3 run at
// once; they run in the foreground, with no isolation, with model and effort from the role config.
// Pin FOREMAN_HOME to a temp dir before any server module loads (story #121 guard).
import './fixtures/temp-foreman-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const {
  ProjectManager, InvestigatorSlots, investigatorAgents, investigatorBashCheck, investigatorDecision: decide, investigatorPathDenial: pathDenial,
  INVESTIGATOR_TOOLS, INVESTIGATOR_MAX_TURNS, MAX_INVESTIGATORS, GIT_FORCED_GLOBALS, GREP_ENV_EXCLUSION, PROTECTED_HOME_ENTRIES,
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
// A stand-in home directory with the credential layout (the real home is never read by these tests).
// The policy protects it through its `home` test seam, in addition to the real home.
const home = join(root, 'home');
for (const dir of ['.ssh', '.claude', '.codex', '.config/gh', '.aws']) mkdirSync(join(home, dir), { recursive: true });
writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY'); writeFileSync(join(home, '.claude', 'settings.json'), '{}');
writeFileSync(join(home, '.codex', 'auth.json'), '{}'); writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'token');
for (const file of ['.claude.json', '.claude.json.backup', '.netrc', '.npmrc', '.pypirc', '.git-credentials']) writeFileSync(join(home, file), 'secret');
mkdirSync(join(home, '.claude', '.git')); // a protected directory that is also a git checkout
writeFileSync(join(home, 'notes.md'), '# not protected'); // a plain file in the home directory
const ctx = { home };
const investigatorDecision = (name: string, input: Record<string, any>) => decide(name, input, ctx);
const investigatorPathDenial = (raw: unknown, kind: 'file' | 'any') => pathDenial(raw, kind, ctx);
const investigatorBashDenial = (command: unknown) => { const check = investigatorBashCheck(command, ctx); return 'denial' in check ? check.denial : null; };
const rewritten = (command: string) => { const check = investigatorBashCheck(command, ctx); assert.ok('command' in check, `${command}: ${JSON.stringify(check)}`); return (check as { command: string }).command; };
// macOS and Windows volumes are case-insensitive by default; the capitalisation tests need one.
const upper = (p: string) => p.toUpperCase();
const caseInsensitiveFs = existsSync(upper(join(project, 'README.md')));

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
  // Existing credential files, so the denial is the protection and not "the path must exist".
  for (const file of ['.ssh/id_ed25519', '.claude/settings.json', '.codex/auth.json', '.config/gh/hosts.yml']) {
    assert.match(investigatorPathDenial(join(home, file), 'file')!, /credential/, file);
  }
  denied('Read', { file_path: '~/.ssh/id_ed25519' });
  allowed('Read', { file_path: join(home, 'notes.md') }); // the home directory itself is not off limits
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
    denied(name, { pattern: 'token', path: home }); // contains ~/.ssh, ~/.claude
    denied(name, { pattern: 'token', path: join(home, '.ssh') });
    denied(name, { pattern: 'x', path: project, glob: '*.ts .env*' }); // a second whitespace-separated glob
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
    'git -C relative/dir log', `git -C ${TEMP_FOREMAN_HOME} log`, `git -C ${notRepo} log`, `git -C ${join(home, '.claude')} log`,
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
  assert.equal(slots.inUse, 3);
  // The first finishes: its SubagentStop alone frees the slot (even if the Agent call's PostToolUse never comes).
  await fire('SubagentStop', { agent_id: '1', agent_type: 'investigator' });
  assert.equal(slots.inUse, 2);
  assert.equal((await launch('d')).hookSpecificOutput.permissionDecision, 'allow');
  // The late PostToolUse for a changes nothing; the fourth is still counted.
  await fire('PostToolUse', { tool_name: 'Agent', tool_use_id: 'a' });
  assert.equal(slots.inUse, 3);
  // A failed launch releases its reservation, and the Agent call's end alone frees its subagent's slot too.
  await fire('PostToolUseFailure', { tool_name: 'Agent', tool_use_id: 'b' });
  assert.equal(slots.inUse, 2, 'subagent 2 is released with its Agent call b');
  await fire('SubagentStop', { agent_id: '2' }); // late: no effect
  await fire('PostToolUse', { tool_name: 'Agent', tool_use_id: 'c' }); await fire('PostToolUse', { tool_name: 'Agent', tool_use_id: 'd' });
  assert.equal(slots.inUse, 0);
  // A subagent's own tool calls never release a Coordinator Agent reservation.
  assert.equal((await launch('e')).hookSpecificOutput.permissionDecision, 'allow');
  await fire('PostToolUse', { tool_name: 'Agent', tool_use_id: 'e', agent_id: 'nested' });
  assert.equal(slots.inUse, 1);
});

test('investigator slots never leak: an untrackable launch is refused, and every slot is freed when the run is retired or ends', async (t) => {
  const pm = new ProjectManager({} as any);
  const hook = (pm as any).enforceToolBoundary;
  const input = { subagent_type: 'investigator', description: 'x', prompt: 'x' };
  // No tool_use_id: the launch could never be released, so it is refused (no random fallback id).
  const untracked = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: input });
  assert.equal(untracked.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((pm as any).slots.inUse, 0);
  for (const id of ['a', 'b', 'c']) assert.equal((await hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: input, tool_use_id: id })).hookSpecificOutput.permissionDecision, 'allow');
  const slots: InstanceType<typeof InvestigatorSlots> = (pm as any).slots;
  slots.started('x1');
  assert.equal(slots.inUse, 3);
  (pm as any).retire(); // e.g. a hung Coordinator retired by the next send, or a move to another machine
  assert.equal(slots.inUse, 0, 'retire clears every slot');

  // A run that ends (the provider stream closes) clears its slots too.
  const storeHome = mkdtempSync(join(root, 'slots-'));
  const store = new LocalPmStore({ identity: { machine_id: '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', name: 'test-machine' }, home: storeHome, log: () => {} });
  const pm2 = new ProjectManager({} as any, { machineName: 'test-machine', env: {} });
  pm2.attach(store, { autoStart: false });
  let started = false; let finish!: () => void; const done = new Promise<void>((r) => { finish = r; });
  (pm2 as any).queryFactory = () => { started = true; return { close: () => {}, async *[Symbol.asyncIterator]() { await done; } }; };
  const running = pm2.start();
  t.after(() => pm2.close());
  for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(started);
  const hook2 = (pm2 as any).enforceToolBoundary;
  for (const id of ['a', 'b']) await hook2({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: input, tool_use_id: id });
  const runSlots: InstanceType<typeof InvestigatorSlots> = (pm2 as any).slots;
  assert.equal(runSlots.inUse, 2);
  finish(); await running;
  assert.equal(runSlots.inUse, 0, 'the run ended: its slots are cleared');
});

test('capitalised spellings on a case-insensitive file system never reach FOREMAN_HOME or a credential directory', { skip: !caseInsensitiveFs && 'needs a case-insensitive file system' }, async () => {
  const foremanUpper = upper(join(TEMP_FOREMAN_HOME, 'cloud.json'));
  assert.ok(existsSync(foremanUpper), 'the capitalised spelling names the same file');
  denied('Read', { file_path: foremanUpper });
  denied('Read', { file_path: join(TEMP_FOREMAN_HOME, 'CLOUD.JSON') });
  denied('Read', { file_path: join(home, '.SSH', 'ID_ED25519') });
  denied('Read', { file_path: join(home, '.Claude', 'settings.json') });
  denied('Read', { file_path: join(home, '.CLAUDE.JSON') });
  denied('Read', { file_path: join(home, '.NetRC') });
  denied('Read', { file_path: upper(join(home, '.codex', 'auth.json')) });
  denied('Read', { file_path: '~/.SSH/id_ed25519' });
  denied('Read', { file_path: join(project, '.ENV') });
  for (const name of ['Grep', 'Glob']) {
    denied(name, { pattern: '.ssh/*', path: upper(home) }); // a capitalised parent of the credential directories
    denied(name, { pattern: 'token', path: join(home, '.SSH') });
    denied(name, { pattern: 'token', path: upper(TEMP_FOREMAN_HOME) });
    denied(name, { pattern: 'token', path: upper(join(TEMP_FOREMAN_HOME, '..')) }); // contains FOREMAN_HOME
  }
  assert.notEqual(investigatorBashDenial(`git -C ${upper(join(home, '.claude'))} log`), null);
  assert.notEqual(investigatorBashDenial(`git -C ${join(home, '.Claude')} status`), null);
  assert.notEqual(investigatorBashDenial(`git -C ${upper(TEMP_FOREMAN_HOME)} log`), null);
  // A capitalised project path is still the same, allowed project.
  allowed('Read', { file_path: upper(join(project, 'README.md')) });
  assert.equal(investigatorBashDenial(`git -C ${upper(project)} log`), null);

  // The Coordinator's own (main-thread) Read check: a document under FOREMAN_HOME stays refused however it is spelled.
  writeFileSync(join(TEMP_FOREMAN_HOME, 'notes.md'), '# private');
  const pm = new ProjectManager({} as any);
  const guard = (pm as any).canUseTool;
  assert.equal((await guard('Read', { file_path: join(TEMP_FOREMAN_HOME, 'notes.md') })).behavior, 'deny');
  assert.equal((await guard('Read', { file_path: upper(join(TEMP_FOREMAN_HOME, 'notes.md')) })).behavior, 'deny');
  assert.equal((await guard('Read', { file_path: upper(join(project, 'README.md')) })).behavior, 'allow');
});

test('aliased paths (symlinked parents, hard links, macOS firmlink and /.nofollow prefixes) are matched by file identity', async (t) => {
  // A second path to the parent of the stand-in home and FOREMAN_HOME, through a symlink.
  const aliasRoot = join(mkdtempSync(join(tmpdir(), 'foreman-alias-')), 'root');
  t.after(() => rmSync(dirname(aliasRoot), { recursive: true, force: true }));
  symlinkSync(root, aliasRoot);
  const aliasHome = join(aliasRoot, 'home');
  denied('Read', { file_path: join(aliasHome, '.ssh', 'id_ed25519') });
  denied('Read', { file_path: join(aliasHome, '.claude.json') });
  for (const name of ['Grep', 'Glob']) {
    denied(name, { pattern: 'token', path: aliasHome });
    denied(name, { pattern: 'token', path: join(aliasHome, '.claude') });
  }
  allowed('Read', { file_path: join(aliasRoot, 'project', 'README.md') }); // the alias of a project is still that project
  // A hard link to a protected file has its own path but the same identity: only the identity check can catch it.
  const hardLink = join(project, 'claude-copy.json');
  linkSync(join(home, '.claude.json'), hardLink);
  t.after(() => rmSync(hardLink, { force: true }));
  assert.match(investigatorPathDenial(hardLink, 'file')!, /credential/);
  denied('Grep', { pattern: 'x', path: hardLink, output_mode: 'content' });

  // Alias prefixes are refused outright, whatever they point at.
  for (const p of ['/System/Volumes/Data/private/tmp', '/system/volumes/data', '/.nofollow/private/tmp', '/.resolve/1/2', '/.NoFollow']) {
    assert.match(investigatorPathDenial(p, 'any') ?? '', /alias/, p);
  }
  // The literal macOS forms of the stand-in home and FOREMAN_HOME, where this machine resolves them.
  const aliased = [
    ['/System/Volumes/Data', join(home, '.ssh', 'id_ed25519')], ['/System/Volumes/Data', join(home, '.claude.json')],
    ['/.nofollow', join(home, '.claude.json')], ['/System/Volumes/Data', join(realpathSync(TEMP_FOREMAN_HOME), 'cloud.json')], ['/.nofollow', join(realpathSync(TEMP_FOREMAN_HOME), 'cloud.json')],
  ].map(([prefix, p]) => prefix + p);
  const aliasedDirs = ['/System/Volumes/Data' + home, '/.nofollow' + home, '/System/Volumes/Data' + join(home, '.claude')];
  const bootVolume = '/Volumes/Macintosh HD';
  const present = [...aliased, ...aliasedDirs].filter((p) => existsSync(p));
  if (process.platform === 'darwin') {
    if (present.length < aliased.length + aliasedDirs.length) t.diagnostic(`skipped (no such path on this machine): ${[...aliased, ...aliasedDirs].filter((p) => !existsSync(p)).join(', ')}`);
    for (const p of aliased.filter((q) => existsSync(q))) denied('Read', { file_path: p });
    for (const p of aliasedDirs.filter((q) => existsSync(q))) {
      denied('Grep', { pattern: 'token', path: p });
      denied('Grep', { pattern: 'token', path: p, output_mode: 'count' });
      denied('Glob', { pattern: '**', path: p });
      assert.notEqual(investigatorBashDenial(`git -C ${p} log`), null, p);
    }
    // `/Volumes/<boot volume>` is a symlink to `/`: the same files, caught after realpath and by identity.
    if (existsSync(bootVolume + home)) {
      denied('Read', { file_path: bootVolume + join(home, '.claude.json') });
      denied('Grep', { pattern: 'token', path: bootVolume + home });
      allowed('Read', { file_path: bootVolume + join(project, 'README.md') });
    }
    // The Coordinator's own Read check refuses the aliased FOREMAN_HOME document too.
    writeFileSync(join(TEMP_FOREMAN_HOME, 'alias-notes.md'), '# private');
    const guard = (new ProjectManager({} as any) as any).canUseTool;
    for (const prefix of ['/System/Volumes/Data', '/.nofollow']) {
      const p = prefix + join(realpathSync(TEMP_FOREMAN_HOME), 'alias-notes.md');
      if (existsSync(p)) assert.equal((await guard('Read', { file_path: p })).behavior, 'deny', p);
    }
    const viaSymlink = join(aliasRoot, '..', 'fh');
    symlinkSync(dirname(TEMP_FOREMAN_HOME), viaSymlink);
    assert.equal((await guard('Read', { file_path: join(viaSymlink, basename(TEMP_FOREMAN_HOME), 'alias-notes.md') })).behavior, 'deny');
    assert.equal((await guard('Read', { file_path: join(aliasRoot, 'project', 'README.md') })).behavior, 'allow');
  }
});

test('git: -O in a short-option cluster, signature format placeholders and .env paths or revisions are refused', () => {
  for (const arg of ['-pO/etc/passwd', '-RO/x', '-pOx', '-O', '-nO5']) {
    assert.notEqual(investigatorBashDenial(`git -C ${project} log ${arg}`), null, arg);
    assert.notEqual(investigatorBashDenial(`git -C ${project} diff ${arg}`), null, arg);
  }
  for (const arg of ['--format=%GS', '--format=%GK', '--pretty=format:%GG', '--pretty=tformat:%H%GF', '--forma=%GP', '--format=%GT']) {
    assert.match(investigatorBashDenial(`git -C ${project} log ${arg}`) ?? '', /gpg/, arg);
    assert.notEqual(investigatorBashDenial(`git -C ${project} show ${arg}`), null, arg);
  }
  for (const command of [`show HEAD:.env`, `show HEAD:config/.ENV.local`, `show main:.Env`, `log -- .env`, `diff HEAD -- sub/.env.production`, `log -p -- .envrc`, `branch --list .env`]) {
    assert.match(investigatorBashDenial(`git -C ${project} ${command}`) ?? '', /\.env/, command);
  }
  // Controls: ordinary clusters, formats and paths still pass.
  for (const command of ['log -pn5', 'diff -R HEAD', 'log --format=%H,%an,%gd', 'log --pretty=oneline', 'show HEAD:README.md', 'log -- src/index.ts']) {
    assert.equal(investigatorBashDenial(`git -C ${project} ${command}`), null, command);
  }
});

test('the protected list covers agent and package-manager credential files in the home directory', () => {
  for (const entry of ['.claude.json', '.claude.json.backup', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.codex', '.ssh', '.claude', '.config/gh', '.aws', '.gnupg', '.docker']) {
    assert.ok((PROTECTED_HOME_ENTRIES as readonly string[]).includes(entry), entry);
  }
  for (const file of ['.claude.json', '.claude.json.backup', '.netrc', '.npmrc', '.pypirc', '.git-credentials']) {
    assert.match(investigatorPathDenial(join(home, file), 'file')!, /credential/, file);
    denied('Read', { file_path: `~/${file}` });
  }
});

test('gh: browser-opening and watch options are refused in every spelling', () => {
  for (const arg of ['--web', '--web=true', '--web=1', '-w', '-w=true', '-cw', '-wc', '--watch', '--watch=true', '--watcher', '--webx']) {
    assert.notEqual(investigatorBashDenial(`gh pr view 1 -R owner/repo ${arg}`), null, arg);
    assert.notEqual(investigatorBashDenial(`gh pr checks 1 ${arg}`), null, arg);
    assert.notEqual(investigatorBashDenial(`gh run view 1 ${arg}`), null, arg);
  }
  for (const command of ['gh pr view 1 -R owner/repo -c', 'gh run view 99 -R owner/repo --log', 'gh pr list -R owner/w', 'gh issue list -L 5']) {
    assert.equal(investigatorBashDenial(command), null, command);
  }
});

test('git: blocked options are refused in abbreviated and --opt=value spellings, and option values may not name outside paths', () => {
  for (const arg of ['--orderfile=x', '--orderfile=/etc/passwd', '-O/etc/passwd', '-Ox', '--order=x', '--orderf=/etc/passwd',
    '--output=x', '--outpu=/tmp/x', '--outp=x', '--no-inde', '--no-index', '--no-i', '--ext-diff', '--ext-d', '--ext', '--textconv', '--textc',
    '--open-files', '--show-signature', '--show-sig', '--exec=x', '--upload-pack=x', '--config-env=x', '--no']) {
    assert.notEqual(investigatorBashDenial(`git -C ${project} log ${arg}`), null, arg);
    assert.notEqual(investigatorBashDenial(`git -C ${project} diff ${arg}`), null, arg);
  }
  for (const arg of ['--format=/etc/x', '--since=~/x', '--author=../x', '--grep=/abs', '-S/abs', '--relative=../up']) {
    if (arg.includes('=')) assert.notEqual(investigatorBashDenial(`git -C ${project} log ${arg}`), null, arg);
  }
  for (const arg of ['--oneline', '--stat', '--text', '--no-ext-diff', '--no-textconv', '--format=%H,%an', '--since=2.weeks', '--relative=src', '-n5', '--name-only', '--exit-code']) {
    assert.equal(investigatorBashDenial(`git -C ${project} diff ${arg}`), null, arg);
  }
});

test('git: every allowed command runs with the forced read-only options, added by the hook (never taken from input)', async () => {
  const forced = GIT_FORCED_GLOBALS.join(' ');
  assert.equal(forced, '--no-pager -c core.fsmonitor=false -c log.showSignature=false');
  assert.equal(rewritten(`git -C ${project} log --oneline -n 5`), `git ${forced} -C ${project} log --no-ext-diff --no-textconv --oneline -n 5`);
  assert.equal(rewritten(`git -C ${project} show HEAD`), `git ${forced} -C ${project} show --no-ext-diff --no-textconv HEAD`);
  assert.equal(rewritten(`git -C ${project} diff --no-ext-diff HEAD`), `git ${forced} -C ${project} diff --no-textconv --no-ext-diff HEAD`);
  assert.equal(rewritten(`git -C ${project} status`), `git ${forced} -C ${project} status`);
  assert.equal(rewritten(`git -C ${project} branch -a`), `git ${forced} -C ${project} branch -a`);
  // Idempotent: the rewritten command passes the check unchanged (canUseTool may see it after the hook).
  const once = rewritten(`git -C ${project} log`);
  assert.equal(rewritten(once), once);
  // Other -c overrides, or the forced prefix in another order or with other values, are not accepted from input.
  for (const command of [`git -c core.fsmonitor=false -C ${project} log`, `git --no-pager -C ${project} log`, `git -c core.fsmonitor=/tmp/x -C ${project} status`,
    `git --no-pager -c core.fsmonitor=true -c log.showSignature=false -C ${project} status`, `git -C ${project} -c core.pager=x log`, `git -c core.fsmonitor=false -c log.showSignature=false --no-pager -C ${project} log`]) {
    assert.notEqual(investigatorBashDenial(command), null, command);
  }
  // The hook hands the rewritten command to the SDK for a subagent call; gh passes unchanged (defer).
  const pm = new ProjectManager({} as any);
  const hook = (pm as any).enforceToolBoundary;
  const r = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `git -C ${project} log -n 1`, description: 'x' }, tool_use_id: 't1', agent_id: 'agent-1', agent_type: 'investigator' });
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(r.hookSpecificOutput.updatedInput, { command: `git ${forced} -C ${project} log --no-ext-diff --no-textconv -n 1`, description: 'x' });
  assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr view 1 -R o/r' }, tool_use_id: 't2', agent_id: 'agent-1' }), {});
  const viaGuard = await (pm as any).canUseTool('Bash', { command: `git -C ${project} status` }, { agentID: 'agent-1' });
  assert.equal(viaGuard.updatedInput.command, `git ${forced} -C ${project} status`);
});

test('git: the rewritten commands do not run programs from repository config (fsmonitor, external diff, textconv)', () => {
  // A real checkout whose config names a program for each hook point; the program leaves a marker.
  const repo = join(root, 'hostile');
  mkdirSync(repo);
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env });
  assert.equal(git('init', '-q').status, 0);
  writeFileSync(join(repo, 'a.txt'), 'one\n'); writeFileSync(join(repo, '.gitattributes'), 'a.txt diff=conv\n');
  git('add', '.'); assert.equal(git('commit', '-qm', 'one').status, 0);
  writeFileSync(join(repo, 'a.txt'), 'two\n'); git('add', '.'); assert.equal(git('commit', '-qm', 'two').status, 0);
  const marker = join(root, 'hostile-ran');
  const program = join(root, 'hostile.sh');
  writeFileSync(program, `#!/bin/sh\ntouch ${marker}\ncat "$1" 2>/dev/null\n`); chmodSync(program, 0o755);
  for (const [key, value] of [['core.fsmonitor', program], ['diff.external', program], ['diff.conv.textconv', program]]) assert.equal(git('config', key, value).status, 0);
  const ran = (command: string) => { rmSync(marker, { force: true }); const r = spawnSync('sh', ['-c', command], { encoding: 'utf8', env }); return { ran: existsSync(marker), status: r.status }; };
  // Controls: the plain commands do run the configured program, so the check below can tell.
  assert.equal(ran(`git -C ${repo} status`).ran, true, 'control: fsmonitor runs for a plain git status');
  assert.equal(ran(`git -C ${repo} diff HEAD~1 HEAD`).ran, true, 'control: diff.external runs for a plain git diff');
  assert.equal(ran(`git -C ${repo} show HEAD`).ran, true, 'control: textconv runs for a plain git show');
  const [first, second] = git('rev-list', '--reverse', 'HEAD').stdout.trim().split('\n');
  for (const command of [`git -C ${repo} status`, `git -C ${repo} diff ${first} ${second}`, `git -C ${repo} show HEAD`, `git -C ${repo} log -p`, `git -C ${repo} diff`]) {
    const result = ran(rewritten(command));
    assert.deepEqual(result, { ran: false, status: 0 }, command);
  }
});

test('Grep over a directory always excludes .env files (the rewrite adds a trailing negated glob); a single file is unchanged', async () => {
  const dirGrep = investigatorDecision('Grep', { pattern: 'SECRET', path: project }) as any;
  assert.equal(dirGrep.behavior, 'allow');
  assert.equal(dirGrep.updatedInput.glob, GREP_ENV_EXCLUSION);
  assert.equal(GREP_ENV_EXCLUSION, '!.[eE][nN][vV]*');
  const withGlob = investigatorDecision('Grep', { pattern: 'SECRET', path: project, glob: '*.{ts,tsx}', output_mode: 'count' }) as any;
  assert.equal(withGlob.updatedInput.glob, `*.{ts,tsx} ${GREP_ENV_EXCLUSION}`);
  assert.equal(withGlob.updatedInput.output_mode, 'count');
  // Idempotent: an already-excluded glob is left alone.
  assert.equal((investigatorDecision('Grep', withGlob.updatedInput) as any).updatedInput, undefined);
  // A single file needs no rewrite (a .env file is refused by the path check).
  assert.equal((investigatorDecision('Grep', { pattern: 'x', path: join(project, 'README.md') }) as any).updatedInput, undefined);
  // Through the hook: a subagent Grep over a directory runs rewritten.
  const pm = new ProjectManager({} as any);
  const r = await (pm as any).enforceToolBoundary({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'SECRET', path: project, output_mode: 'files_with_matches' }, tool_use_id: 'g1', agent_id: 'agent-1' });
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(r.hookSpecificOutput.updatedInput.glob, GREP_ENV_EXCLUSION);
  // The exclusion does what it claims under ripgrep's glob rules, when rg is on PATH.
  const rg = spawnSync('rg', ['--version']);
  if (rg.status === 0) {
    mkdirSync(join(project, 'nested'), { recursive: true }); writeFileSync(join(project, 'nested', '.ENV.production'), 'SECRET=3'); writeFileSync(join(project, 'nested', 'ok.ts'), 'SECRET_NAME');
    const out = spawnSync('rg', ['--hidden', '-l', '--glob', '*', '--glob', GREP_ENV_EXCLUSION, 'SECRET', project], { encoding: 'utf8' }).stdout;
    assert.match(out, /ok\.ts/);
    assert.doesNotMatch(out, /\.env/i, out);
  }
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
