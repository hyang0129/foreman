// #155: Foreman runs the installed `claude` (FOREMAN_CLAUDE_BIN still overrides) and falls back to the
// SDK-bundled binary only when no installed one is on PATH. Every case below uses real files in temp
// directories, and each fixture binary is distinct, so a result can only match the path it names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';

// server/paths.ts reads FOREMAN_HOME at import: pin it to a temp dir before loading any server module.
const root = mkdtempSync(join(tmpdir(), 'foreman-claude-bin-'));
process.env.FOREMAN_HOME = join(root, 'home');
// The PM test below checks the PM passes exactly this path; it is never executed.
const PM_FAKE_BIN = join(root, 'override-for-pm', 'claude');
process.env.FOREMAN_CLAUDE_BIN = PM_FAKE_BIN;
delete process.env.FOREMAN_PM_MODEL;
const { resolveClaudeBin, findInstalledClaude, claudeVersion } = await import('../server/claude-bin.ts');
const { ProjectManager } = await import('../server/pm.ts');
const { LocalPmStore } = await import('../server/pm-store.ts');
const { ensureDirs, CLAUDE_BIN, BUNDLED_CLAUDE_BIN } = await import('../server/paths.ts');
ensureDirs();
test.after(() => rmSync(root, { recursive: true, force: true }));

function fakeClaude(dir: string, version = '9.9.9', mode = 0o755) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'claude');
  writeFileSync(path, `#!/bin/sh\necho "${version} (Claude Code)"\n`);
  chmodSync(path, mode);
  return path;
}

test('FOREMAN_CLAUDE_BIN wins over an installed claude and the bundled binary', () => {
  const installed = fakeClaude(join(root, 'o-installed'));
  const bundled = fakeClaude(join(root, 'o-bundled'));
  const choice = resolveClaudeBin({ env: { FOREMAN_CLAUDE_BIN: '/opt/custom/claude', PATH: dirname(installed) }, bundled });
  assert.deepEqual(choice, { path: '/opt/custom/claude', source: 'override' });
});

test('an installed claude on PATH wins over the bundled binary', () => {
  const installed = fakeClaude(join(root, 'i-installed'));
  const bundled = fakeClaude(join(root, 'i-bundled'));
  const choice = resolveClaudeBin({ env: { PATH: ['/nonexistent-155', dirname(installed)].join(delimiter) }, bundled });
  assert.deepEqual(choice, { path: installed, source: 'installed' });
});

test('the bundled binary is used only when no installed claude is on PATH', () => {
  const bundled = fakeClaude(join(root, 'b-bundled'));
  const emptyDir = join(root, 'b-empty'); mkdirSync(emptyDir);
  assert.deepEqual(resolveClaudeBin({ env: { PATH: emptyDir }, bundled }), { path: bundled, source: 'bundled' });
  assert.deepEqual(resolveClaudeBin({ env: {}, bundled }), { path: bundled, source: 'bundled' });
  // Neither installed nor bundled: the bare name, marked unresolved rather than claimed as found.
  assert.deepEqual(resolveClaudeBin({ env: { PATH: emptyDir }, bundled: join(root, 'b-missing', 'claude') }), { path: 'claude', source: 'unresolved' });
});

test('PATH search takes the first executable claude and skips non-executable files and relative entries', () => {
  const notExecutable = fakeClaude(join(root, 'p-noexec'), '1.0.0', 0o644);
  const first = fakeClaude(join(root, 'p-first'));
  const second = fakeClaude(join(root, 'p-second'));
  mkdirSync(join(root, 'p-dir', 'claude'), { recursive: true }); // a directory named claude is not a binary
  const path = [dirname(notExecutable), 'relative/bin', join(root, 'p-dir'), dirname(first), dirname(second)].join(delimiter);
  assert.equal(findInstalledClaude(path), first);
  assert.equal(findInstalledClaude(''), null);
  assert.equal(findInstalledClaude(undefined), null);
});

test('claudeVersion reports the binary\'s own --version output, or null when it cannot run', async () => {
  assert.equal(await claudeVersion(fakeClaude(join(root, 'v-ok'), '2.1.280')), '2.1.280 (Claude Code)');
  assert.equal(await claudeVersion(join(root, 'v-missing', 'claude')), null);
});

// paths.ts computes CLAUDE_BIN at import from the process environment. Import it in a child process
// with a controlled PATH (FOREMAN_CLAUDE_BIN unset) to show the daemon's real wiring picks each source.
async function childChoice(env: NodeJS.ProcessEnv) {
  const script = "const p = await import('./server/paths.ts'); console.log(JSON.stringify({ bin: p.CLAUDE_BIN, choice: p.CLAUDE_BIN_CHOICE, bundled: p.BUNDLED_CLAUDE_BIN }));";
  const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    cwd: join(import.meta.dirname, '..'), env: { HOME: root, FOREMAN_HOME: join(root, 'child-home'), ...env }, timeout: 15_000,
  });
  return JSON.parse(stdout);
}

test('the daemon (paths.ts) runs the installed claude from its PATH, and the bundled one without it', async () => {
  const installed = fakeClaude(join(root, 'd-installed'));
  const withInstalled = await childChoice({ PATH: [dirname(installed), dirname(process.execPath)].join(delimiter) });
  assert.equal(withInstalled.bin, installed);
  assert.equal(withInstalled.choice.source, 'installed');

  const emptyDir = join(root, 'd-empty'); mkdirSync(emptyDir);
  const withoutInstalled = await childChoice({ PATH: emptyDir });
  assert.equal(withoutInstalled.bin, withoutInstalled.bundled);
  assert.equal(withoutInstalled.choice.source, 'bundled');
  assert.notEqual(withoutInstalled.bin, installed);

  const overridden = await childChoice({ PATH: dirname(installed), FOREMAN_CLAUDE_BIN: '/opt/override/claude' });
  assert.deepEqual(overridden.choice, { path: '/opt/override/claude', source: 'override' });
});

test('the PM passes the chosen Claude binary to the SDK', async (t) => {
  assert.equal(CLAUDE_BIN, PM_FAKE_BIN, 'this file sets FOREMAN_CLAUDE_BIN before importing paths.ts');
  assert.notEqual(CLAUDE_BIN, BUNDLED_CLAUDE_BIN);
  const dir = mkdtempSync(join(root, 'pm-store-')); mkdirSync(join(dir, 'pm'), { recursive: true });
  const store = new LocalPmStore({ identity: { machine_id: '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21', name: 'test-mac' }, home: dir, log: () => {} });
  const pm = new ProjectManager({} as any, { machineName: 'test-mac' });
  pm.attach(store, { autoStart: false });
  let options: any;
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => { stop = resolve; });
  (pm as any).queryFactory = (args: any) => {
    options = args.options;
    return { close: stop, async *[Symbol.asyncIterator]() { yield { type: 'system', subtype: 'init', session_id: 'bin-test', tools: [] }; await stopped; } };
  };
  const running = pm.start();
  t.after(async () => { pm.close(); await running; });
  for (let i = 0; i < 200 && !options; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(options, 'the PM must start a provider');
  assert.equal(options.pathToClaudeCodeExecutable, PM_FAKE_BIN);
});

// #164: scripts/claude-bin.mjs is the plain-JS twin used by scripts/dev-environment.mjs. It must
// choose exactly what server/claude-bin.ts chooses, for every source, on real fixture files.
test('#164: the .mjs twin resolves the Claude binary exactly as server/claude-bin.ts does', async () => {
  const twin = await import('../scripts/claude-bin.mjs');
  const installed = fakeClaude(join(root, 't-installed'));
  const later = fakeClaude(join(root, 't-later'));
  const notExecutable = fakeClaude(join(root, 't-noexec'), '1.0.0', 0o644);
  const bundled = fakeClaude(join(root, 't-bundled'));
  const missing = join(root, 't-missing', 'claude');
  const emptyDir = join(root, 't-empty'); mkdirSync(emptyDir);
  mkdirSync(join(root, 't-dir', 'claude'), { recursive: true });
  const paths = [undefined, '', emptyDir, dirname(installed), [dirname(later), dirname(installed)].join(delimiter),
    [dirname(notExecutable), 'relative/bin', join(root, 't-dir'), dirname(installed)].join(delimiter), [emptyDir, dirname(notExecutable)].join(delimiter)];
  let cases = 0;
  for (const PATH of paths) for (const override of [undefined, '', '/opt/custom/claude']) for (const b of [bundled, missing]) {
    const env: NodeJS.ProcessEnv = { ...(PATH === undefined ? {} : { PATH }), ...(override === undefined ? {} : { FOREMAN_CLAUDE_BIN: override }) };
    assert.deepEqual(twin.resolveClaudeBin({ env, bundled: b }), resolveClaudeBin({ env, bundled: b }), JSON.stringify({ env, b }));
    cases++;
  }
  for (const PATH of paths) assert.equal(twin.findInstalledClaude(PATH), findInstalledClaude(PATH), String(PATH));
  // Every source is reached, so agreement is not vacuous.
  const sources = new Set(paths.flatMap((PATH) => [bundled, missing].map((b) => twin.resolveClaudeBin({ env: PATH === undefined ? {} : { PATH }, bundled: b }).source)));
  assert.deepEqual([...sources].sort(), ['bundled', 'installed', 'unresolved']);
  assert.equal(twin.resolveClaudeBin({ env: { FOREMAN_CLAUDE_BIN: '/x/claude' }, bundled }).source, 'override');
  assert.equal(cases, paths.length * 6);
});

test('#164: the dev auth preflight binary follows the daemon order (installed on PATH, then the snapshot bundle)', async () => {
  // Untyped plain-JS module: imported through a string so the typecheck treats it as `any`.
  const devEnvironment: string = '../scripts/dev-environment.mjs';
  const { devClaudeBinary } = await import(devEnvironment);
  const snapshot = join(root, 'dev-snapshot');
  const bundled = fakeClaude(join(snapshot, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`));
  const installed = fakeClaude(join(root, 'dev-installed'));
  const emptyDir = join(root, 'dev-empty'); mkdirSync(emptyDir);
  assert.equal(devClaudeBinary(snapshot, { PATH: [emptyDir, dirname(installed)].join(delimiter) }), installed);
  assert.equal(devClaudeBinary(snapshot, { PATH: emptyDir }), bundled);
  assert.equal(devClaudeBinary(snapshot, { PATH: dirname(installed), FOREMAN_CLAUDE_BIN: '/opt/custom/claude' }), '/opt/custom/claude');
  assert.equal(devClaudeBinary(join(root, 'dev-no-snapshot'), { PATH: emptyDir }), 'claude');
});
