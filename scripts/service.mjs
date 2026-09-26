#!/usr/bin/env node
// User-scoped macOS service. Importing this module has no side effects.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, lstatSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LABEL = 'com.foreman.daemon';
const OWNER = 'foreman/scripts/service.mjs/v1';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Mirrors isMachineName/MAX_MACHINE_NAME in shared/pm-state.ts and the trimming in
// server/machine.ts configuredMachineName(). Not imported: `npm run service:*` runs plain `node`,
// which cannot load .ts on every supported Node version. tests/service.test.mjs checks the two agree.
export const MAX_MACHINE_NAME = 80;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// #197: the role and limit variables the daemon reads (shared/roles.ts ROLE_ENV, LEAD_LIMIT_ENV).
// Mirrors isModel (MODEL_PATTERN), EFFORTS and leadLimits() there, for the same reason as above;
// tests/service.test.mjs checks that the installer accepts exactly what the daemon would use.
export const MODEL_ENV = ['FOREMAN_LEAD_MODEL', 'FOREMAN_INVESTIGATOR_MODEL'];
export const EFFORT_ENV = ['FOREMAN_PM_EFFORT', 'FOREMAN_LEAD_EFFORT', 'FOREMAN_INVESTIGATOR_EFFORT'];
export const LIMIT_ENV = ['FOREMAN_MAX_LEADS', 'FOREMAN_MAX_WORKERS_PER_LEAD'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/;
const LIMIT_PATTERN = /^\s*[0-9]{1,6}\s*$/;

/**
 * Settings the daemon reads at startup that the service carries over from the install-time
 * environment when set. Invalid values refuse the install instead of installing a service that
 * would start without a PM (bad name) or silently ignore the setting (bad threshold).
 */
export function passThroughSettings(env) {
  const out = {};
  const name = env.FOREMAN_MACHINE_NAME;
  if (name !== undefined && name !== '') {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > MAX_MACHINE_NAME || CONTROL.test(trimmed)) {
      throw new Error(`FOREMAN_MACHINE_NAME must be 1-${MAX_MACHINE_NAME} printable characters`);
    }
    out.FOREMAN_MACHINE_NAME = trimmed;
  }
  const hung = env.FOREMAN_PM_HUNG_MS;
  if (hung !== undefined && hung !== '') {
    if (!/^[0-9]+$/.test(hung) || !Number.isSafeInteger(Number(hung)) || Number(hung) < 1) {
      throw new Error('FOREMAN_PM_HUNG_MS must be a positive integer number of milliseconds');
    }
    out.FOREMAN_PM_HUNG_MS = String(Number(hung));
  }
  for (const key of MODEL_ENV) {
    const value = env[key];
    if (value === undefined || value === '') continue;
    if (!MODEL_PATTERN.test(value.trim())) throw new Error(`${key} must be a model id (letters, digits and . _ : / [ ] -, at most 200 characters)`);
    out[key] = value.trim();
  }
  for (const key of EFFORT_ENV) {
    const value = env[key];
    if (value === undefined || value === '') continue;
    if (!EFFORTS.includes(value.trim())) throw new Error(`${key} must be one of ${EFFORTS.join(', ')}`);
    out[key] = value.trim();
  }
  for (const key of LIMIT_ENV) {
    const value = env[key];
    if (value === undefined || value === '') continue;
    if (!LIMIT_PATTERN.test(value) || Number(value.trim()) < 1) throw new Error(`${key} must be a positive integer (at most 6 digits)`);
    out[key] = String(Number(value.trim()));
  }
  return out;
}

/**
 * `settings: false` skips the pass-through settings (and their validation): only `install` and
 * `plist` write them, so a bad value there never blocks `status`, `uninstall` or `restart` (#145).
 */
export function config({ repo = ROOT, home = homedir(), node = process.execPath,
  env = process.env, keepAwake = false, settings = true } = {}) {
  const port = Number(env.FOREMAN_PORT || 4177);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('FOREMAN_PORT must be an integer from 1 to 65535');
  for (const [name, value] of Object.entries({ repo, home, node })) {
    if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  }
  const state = resolve(env.FOREMAN_HOME || join(home, '.foreman'));
  const environment = {
    HOME: home,
    PATH: [...new Set([dirname(node), join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':'),
    FOREMAN_HOME: state,
    FOREMAN_PORT: String(port),
  };
  // Deliberately do not serialize the shell environment or provider credentials.
  for (const key of ['FOREMAN_CLAUDE_BIN', 'FOREMAN_CODEX_BIN', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'FOREMAN_WARP_SPAWN']) {
    if (env[key]) {
      if (!isAbsolute(env[key])) throw new Error(`${key} must be an absolute path for launchd`);
      environment[key] = env[key];
    }
  }
  // FOREMAN_MACHINE_NAME is persisted to <FOREMAN_HOME>/machine.json by the daemon, so passing it
  // renames this machine on the service's next start; omitting it later keeps the stored name.
  if (settings) Object.assign(environment, passThroughSettings(env));
  const args = [node, '--experimental-strip-types', join(repo, 'server/main.ts')];
  return {
    repo, home, port, state,
    path: join(home, 'Library/LaunchAgents', `${LABEL}.plist`),
    plist: {
      Label: LABEL,
      ForemanManagedBy: OWNER,
      ProgramArguments: keepAwake ? ['/usr/bin/caffeinate', '-s', ...args] : args,
      WorkingDirectory: repo,
      EnvironmentVariables: environment,
      RunAtLoad: true,
      KeepAlive: true,
      ThrottleInterval: 10,
      ExitTimeOut: 20,
      StandardOutPath: join(state, 'logs/service.stdout.log'),
      StandardErrorPath: join(state, 'logs/service.stderr.log'),
    },
  };
}

function xmlEscape(value) {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error('Invalid control character in plist value');
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function plistValue(value) {
  if (typeof value === 'string') return `<string>${xmlEscape(value)}</string>`;
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (typeof value === 'number') return `<integer>${value}</integer>`;
  if (Array.isArray(value)) return `<array>${value.map(plistValue).join('\n')}</array>`;
  return `<dict>${Object.entries(value).map(([key, val]) => `<key>${xmlEscape(key)}</key>${plistValue(val)}`).join('\n')}</dict>`;
}

export function renderPlist(value) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${plistValue(value)}</plist>\n`;
}

export function assertOwnedPlist(plist, repo) {
  if (plist.Label !== LABEL || plist.ForemanManagedBy !== OWNER || plist.WorkingDirectory !== repo) {
    throw new Error('Refusing to modify a service not owned by this Foreman checkout');
  }
}

function readOwned(conf) {
  let stat;
  try { stat = lstatSync(conf.path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('Refusing non-owned or non-regular service plist');
  const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', conf.path], { encoding: 'utf8' }));
  assertOwnedPlist(plist, conf.repo);
  return plist;
}

export async function assertPortAvailable(port) {
  await new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.once('error', (error) => reject(new Error(`Cannot start Foreman on 127.0.0.1:${port} (${error.code}); stop the existing server first. No process was stopped.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolvePromise));
  });
}

function launchctl(args, required = true) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (required && result.status !== 0) throw new Error(`launchctl ${args[0]} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  return result;
}

function jobStatus(target) {
  const result = launchctl(['print', target], false);
  return {
    loaded: result.status === 0,
    // Never print launchctl's complete output: it can include inherited credentials.
    state: result.stdout?.match(/^\s*state = (.+)$/m)?.[1] || null,
    pid: Number(result.stdout?.match(/^\s*pid = (\d+)$/m)?.[1]) || null,
    lastExitCode: result.stdout?.match(/^\s*last exit code = (.+)$/m)?.[1] || null,
  };
}

/** The `config()` options for one command: only `install` and `plist` read the pass-through settings. */
export function commandOptions(command, args = []) {
  return { keepAwake: args.includes('--keep-awake'), settings: command === 'install' || command === 'plist' };
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0] || 'status';
  if (!['install', 'uninstall', 'status', 'restart', 'plist'].includes(command) || args.slice(1).some((arg) => arg !== '--keep-awake') || (args.includes('--keep-awake') && !['install', 'plist'].includes(command))) {
    throw new Error('Usage: node scripts/service.mjs [status|install [--keep-awake]|uninstall|restart|plist [--keep-awake]]');
  }
  const conf = config(commandOptions(command, args));
  if (command === 'plist') { process.stdout.write(renderPlist(conf.plist)); return; }
  if (process.platform !== 'darwin') throw new Error('Service management currently supports macOS launchd only');
  if (process.getuid() === 0) throw new Error('Run as your normal logged-in user, without sudo');
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/${LABEL}`;
  const installed = readOwned(conf);
  const status = jobStatus(target);
  if (command === 'status') {
    console.log(JSON.stringify({ installed: Boolean(installed), ...status, plist: conf.path,
      logs: installed ? [installed.StandardOutPath, installed.StandardErrorPath] : [],
      keepAwakeOnAC: installed?.ProgramArguments?.[0] === '/usr/bin/caffeinate',
      availability: 'Requires this Mac to be powered on, awake, network-connected, and this user logged in.' }, null, 2));
    return;
  }
  if (status.loaded && !installed) throw new Error('A job with this label is already loaded without an owned plist; refusing to modify it');
  if (command === 'uninstall') {
    if (status.loaded) launchctl(['bootout', target]);
    if (installed) unlinkSync(conf.path);
    console.log('Foreman service removed. Sessions, credentials, and logs are retained.');
    return;
  }
  if (command === 'restart') {
    if (!installed) throw new Error('Foreman service is not installed');
    if (status.loaded) launchctl(['kickstart', '-k', target]);
    else {
      await assertPortAvailable(Number(installed.EnvironmentVariables.FOREMAN_PORT));
      launchctl(['bootstrap', domain, conf.path]);
    }
    console.log('Foreman service restart requested. Run status to inspect it.');
    return;
  }
  if (status.loaded) throw new Error('Foreman service is already loaded. Use restart, or uninstall then install to change configuration.');
  if (!existsSync(join(conf.repo, 'server/main.ts')) || !existsSync(join(conf.repo, 'node_modules/@anthropic-ai/claude-agent-sdk'))) {
    throw new Error('Run npm install in the Foreman checkout before installing its service');
  }
  await assertPortAvailable(conf.port);
  const previous = installed ? readFileSync(conf.path) : null;
  mkdirSync(dirname(conf.path), { recursive: true });
  mkdirSync(join(conf.state, 'logs'), { recursive: true, mode: 0o700 });
  writeFileSync(conf.path, renderPlist(conf.plist), { mode: 0o600 });
  try {
    execFileSync('/usr/bin/plutil', ['-lint', conf.path], { stdio: 'pipe' });
    launchctl(['bootstrap', domain, conf.path]);
  } catch (error) {
    if (previous) writeFileSync(conf.path, previous); else unlinkSync(conf.path);
    throw error;
  }
  console.log(`Foreman service installed and launch requested. Logs: ${join(conf.state, 'logs')}. Run status to inspect startup.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
