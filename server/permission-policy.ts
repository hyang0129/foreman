import { realpathSync, lstatSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

export const PERMISSION_MODES = ['read-only', 'workspace', 'trusted', 'full'] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];
export function permissionMode(value: unknown): PermissionMode {
  if (value == null) return 'workspace';
  if (!PERMISSION_MODES.includes(value as PermissionMode)) throw new Error('permission_mode must be read-only, workspace, trusted, or full');
  return value as PermissionMode;
}
export const under = (path: string, root: string) => path === root || path.startsWith(root + sep);
// Resolve existing ancestors, including dangling symlinks (which fail closed).
export function canonical(path: string): string {
  try { lstatSync(path); return realpathSync(path); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    try { lstatSync(path); throw new Error('Dangling symlink'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonical(parent), basename(path));
  }
}
// PEM is still a private-key family everywhere except these OS trust anchors.
// Keep other credential names (even secrets.pem) protected inside the CA tree.
const SECRET_NON_PEM_COMPONENT = /^(?:foreman-policy-[^/]+|\.claude|\.codex|\.git-credentials|\.npmrc|\.netrc|\.ssh|\.aws|\.gnupg|\.env(?:\..*)?|.*\.env|secrets?(?:\..*)?|\.?credentials?(?:\..*)?|.*\.(?:key|p12|pfx)|(?:.*[-_])?relay[-_](?:credentials?|tokens?)(?:\..*)?|wrangler\.jsonc?|cloud\.json)$/i;
export const SECRET_COMPONENT = new RegExp(`(?:${SECRET_NON_PEM_COMPONENT.source}|^.*\\.pem$)`, 'i');
const SYSTEM_CA_FILES = ['/etc/ssl/cert.pem', '/private/etc/ssl/cert.pem'];
const SYSTEM_CA_DIRS = ['/etc/ssl/certs', '/private/etc/ssl/certs'];
function systemTrustAnchor(path: string) {
  return resolve(path) === path && (SYSTEM_CA_FILES.includes(path) || SYSTEM_CA_DIRS.some((root) => under(path, root)));
}
export function protectedPath(path: string, home = homedir(), foreman = process.env.FOREMAN_HOME ?? join(home, '.foreman')) {
  const component = systemTrustAnchor(path) ? SECRET_NON_PEM_COMPONENT : SECRET_COMPONENT;
  return [join(home, '.docker/config.json'), join(home, '.kube/config')].some((root) => under(path, root)) || path.split(sep).some((part) => component.test(part)) || under(path, foreman) || under(path, join(home, '.config/gh')) || under(path, join(home, 'Library/Keychains'));
}
export const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const sb = (value: string) => JSON.stringify(value);

// This is an inherited OS boundary, not a shell-text secret scanner. Nested
// interpreters, scripts, substitutions, redirections, and symlinks stay confined.
// Tool execution is supported on the product's macOS execution host. Other OSes
// fail closed rather than pretending a regex is a sandbox.
export function shellSandbox(command: string, cwd: string, mode: PermissionMode, network: boolean, home = homedir(), foreman = process.env.FOREMAN_HOME ?? join(home, '.foreman'), oneTimeAccess = false): string {
  const insensitive = (pattern: string) => pattern.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
  const secretRegex = insensitive('(^|/)(foreman-policy-[^/]+|[.]claude|[.]codex|[.]git-credentials|[.]npmrc|[.]netrc|[.]ssh|[.]aws|[.]gnupg|[.]env([.][^/]*)?|[^/]*[.]env|secrets?([.][^/]*)?|[.]?credentials?([.][^/]*)?|[^/]*[.](key|p12|pfx)|([^/]*[-_])?relay[-_](credentials?|tokens?)([.][^/]*)?|wrangler[.]jsonc?|cloud[.]json)(/|$)');
  const pemRegex = insensitive('(^|/)[^/]*[.]pem(/|$)');
  const trustPaths = [...SYSTEM_CA_FILES.map((p) => `(literal ${sb(p)})`), ...SYSTEM_CA_DIRS.map((p) => `(subpath ${sb(p)})`)];
  const rules = ['(version 1)', '(allow default)',
    `(deny file-read* file-write* (regex #${sb(secretRegex)}) (subpath ${sb(foreman)}))`,
    // Narrow only the PEM read denial; never override the other deny families.
    `(deny file-read* (require-all (regex #${sb(pemRegex)}) (require-not (require-any ${trustPaths.join(' ')}))))`,
    `(deny file-write* (regex #${sb(pemRegex)}) ${trustPaths.join(' ')})`,
  ];
  rules.push(`(deny file-read* file-write* (subpath ${sb(join(home, '.config/gh'))}) (subpath ${sb(join(home, 'Library/Keychains'))}))`);
  rules.push(`(deny file-read* file-write* (subpath ${sb(join(home, '.docker/config.json'))}) (subpath ${sb(join(home, '.kube/config'))}))`);
  // Never let a guarded child reach local control planes, including Foreman.
  rules.push('(deny network-outbound (remote ip "localhost:*"))');
  if (!network) rules.push('(deny network*)');
  if (mode === 'read-only') rules.push('(deny file-write*)');
  if ((mode === 'trusted' || mode === 'workspace') && !oneTimeAccess) rules.push(`(deny file-write* (require-not (subpath ${sb(cwd)})))`);
  rules.push('(allow file-write* (literal "/dev/null"))');
  if ((mode === 'trusted' || mode === 'read-only' || mode === 'workspace') && !oneTimeAccess) {
    // Runtime binaries and shared libraries are readable; arbitrary user data
    // outside the project is not. These roots confer no write access.
    const readable = [cwd, '/System', '/Library', '/usr', '/bin', '/sbin', '/opt', '/dev', '/private/var/db', '/private/var/run', '/private/etc', '/private/preboot'];
    const words = shellWords(command);
    if (words?.[0] === 'git') readable.push(join(home, '.gitconfig'), join(home, '.config/git'));
    rules.push(`(deny file-read-data (require-all (require-not (literal "/")) ${readable.map((p) => `(require-not (subpath ${sb(p)}))`).join(' ')}))`);
  }
  if (mode === 'trusted') {
    // Apple's xcrun uses its own cache override and ignores TMPDIR on this host.
    const temp = join(cwd, '.foreman-tmp');
    command = `mkdir -p ${quote(temp)} && foreman_command_tmp=$(/usr/bin/mktemp -d ${quote(join(temp, 'run-XXXXXX'))}) || exit 1; /usr/bin/printf '*\\n' > "$foreman_command_tmp/.gitignore"; foreman_command_root=${quote(temp)}; trap '/bin/rm -rf "$foreman_command_tmp"; /bin/rmdir "$foreman_command_root" 2>/dev/null || true' EXIT; export TMPDIR="$foreman_command_tmp/" xcrun_db="$foreman_command_tmp/xcrun_db" npm_config_cache="$foreman_command_tmp/npm-cache" YARN_CACHE_FOLDER="$foreman_command_tmp/yarn-cache"; ${command}`;
  }
  if (mode === 'read-only') {
    const words = shellWords(command);
    if (words?.[0] === 'git') {
      const args = [...(['diff', 'log', 'show'].includes(words[1]) ? ['--no-ext-diff', '--no-textconv'] : []), ...words.slice(2)];
      command = `GIT_OPTIONAL_LOCKS=0 GIT_PAGER=cat /usr/bin/git --no-pager -c core.fsmonitor=false ${quote(words[1])} ${args.map(quote).join(' ')}`;
    } else if (words && readOnlyCommand(command)) {
      const binaries: Record<string, string> = { pwd:'/bin/pwd', ls:'/bin/ls', cat:'/bin/cat', head:'/usr/bin/head', tail:'/usr/bin/tail', wc:'/usr/bin/wc', grep:'/usr/bin/grep', rg:'/opt/homebrew/bin/rg' };
      command = [binaries[words[0]], ...words.slice(1)].map(quote).join(' ');
    }
  }
  const scrub = ['BASH_ENV', 'ENV', ...Object.keys(process.env).filter((name) => /FOREMAN_|SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY/i.test(name))].flatMap((name) => ['-u', name]).map(quote).join(' ');
  return `/usr/bin/env ${scrub} /usr/bin/sandbox-exec -p ${quote(rules.join('\n'))} /bin/sh -c ${quote(command)}`;
}
export type Decision = { behavior: 'allow' | 'deny' | 'ask'; message: string; input: Record<string, any> };
const READ_TOOLS = ['Read', 'view_image'];
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch'];
const LOCAL_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'update_plan'];
const PEER_READ = ['list_sessions', 'session_state', 'session_tail', 'message_status'];
const PEER_WRITE = ['send_message', 'request_update'];

// Only simple, audited inspection commands are eligible at Read-only. Shell
// syntax/interpreters, git aliases/config/hooks, find -exec, etc. aren't inferred safe.
export function readOnlyCommand(command: string) {
  const words = shellWords(command);
  if (!words) return false;
  if (['pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg'].includes(words[0]))
    return !words.some((w) => /^(--pre|--hostname-bin)/.test(w));
  return words[0] === 'git' && ['status', 'diff', 'log', 'show', 'ls-files'].includes(words[1]) &&
    !words.some((w) => /^(--ext-diff|--textconv|--output|--open-files-in-pager)/.test(w));
}
/** Parse a single command, never shell programs. Quoted arguments are data. */
export function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word = '', started = false, quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = undefined; else word += c;
    } else if (c === '\\') {
      if (++i === command.length || command[i] === '\n') return null;
      word += command[i]; started = true;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === '$' || c === '`') return null;
      else word += c;
    } else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (';|&<>()$`\n\r'.includes(c)) return null;
    else if (/\s/.test(c)) { if (started) words.push(word); word = ''; started = false; }
    else { if ('*?[]{}~'.includes(c)) return null; word += c; started = true; }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words.length ? words : null;
}
export function trustedNetworkCommand(command: string) {
  const words = shellWords(command);
  if (!words) return false;
  if (words[0] === 'gh') {
    let rest = words.slice(1);
    if (rest[0] === '-R' || rest[0] === '--repo') rest = rest.slice(2);
    const verbs: Record<string, string[]> = {
      issue: ['list', 'view', 'create', 'edit', 'comment', 'close', 'reopen', 'delete', 'pin', 'unpin', 'transfer', 'lock', 'unlock'],
      pr: ['list', 'view', 'create', 'edit', 'comment', 'review', 'merge', 'close', 'reopen', 'checks', 'diff', 'ready'],
      repo: ['view', 'list'], run: ['list', 'view', 'watch', 'rerun', 'cancel'],
      workflow: ['list', 'view', 'run', 'enable', 'disable'], release: ['list', 'view', 'create', 'edit', 'delete', 'upload', 'download'],
    };
    return !!verbs[rest[0]]?.includes(rest[1]) && !rest.some((w) => w === '--web' || w === '-w' || w.startsWith('--browser'));
  }
  if (words[0] === 'git') return ['push', 'fetch', 'pull'].includes(words[1]) && !words.some((w) => /^(--exec|--upload-pack|--receive-pack|--config-env)/.test(w));
  return false; // Package lifecycle scripts are arbitrary code; no automatic egress.
}

export function toolDecision(mode: PermissionMode, cwd: string, tool: string, original: Record<string, any>, platform = process.platform, approvedAccess = false): Decision {
  const input = { ...original };
  const result = (behavior: Decision['behavior'], message = ''): Decision => ({ behavior, message, input });
  const deny = (message: string) => result('deny', message);
  try {
  const root = canonical(resolve(cwd));
  const pathDecision = (value: string) => {
    const expanded = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
    const lexical = resolve(root, expanded);
    const write = WRITE_TOOLS.includes(tool);
    if (protectedPath(lexical) || (write && systemTrustAnchor(lexical))) return 'deny';
    const actual = canonical(lexical);
    if (protectedPath(actual) || (write && systemTrustAnchor(actual))) return 'deny';
    if (!write && READ_TOOLS.includes(tool) && systemTrustAnchor(actual)) return 'allow';
    if (!under(actual, root)) return mode === 'full' ? 'allow' : mode === 'workspace' ? 'ask' : 'deny';
    return 'allow';
  };
    if (['request_permissions', 'ExitPlanMode', 'EnterWorktree', 'Agent', 'spawn_agent'].includes(tool)) return deny('The launch policy is immutable; start a new session through the developer.');
    if (tool === 'AskUserQuestion' || tool === 'request_user_input') return result('ask');
    if (['foreman_exec', 'foreman_process'].includes(tool)) return result('allow');
    if (LOCAL_TOOLS.includes(tool)) return result('allow');
    const peer = tool.replace(/^mcp__peers__/, '');
    if (PEER_READ.includes(peer) || PEER_WRITE.includes(peer)) return result('allow');
    if (['Glob', 'Grep'].includes(tool)) return deny('Use a sandboxed shell search so denied descendants remain protected.');
    if (READ_TOOLS.includes(tool) || WRITE_TOOLS.includes(tool)) {
      if (mode === 'read-only' && WRITE_TOOLS.includes(tool)) return deny('Read-only sessions cannot write files.');
      let paths: string[];
      if (tool === 'apply_patch') {
        paths = [...String(input.command ?? input.patch ?? '').matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((m) => m[1]);
        if (!paths.length) return deny('Patch paths could not be verified.');
      } else paths = [input.file_path ?? input.notebook_path ?? input.path ?? ''];
      let ask = false;
      for (const path of paths) {
        if (typeof path !== 'string' || !path) return deny('An explicit file path is required.');
        const decision = pathDecision(path);
        if (decision === 'deny') return deny('Path is outside the launch grant or on the deny list.');
        ask ||= decision === 'ask';
      }
      return result(ask ? 'ask' : 'allow');
    }
    if (tool === 'Bash' || tool === 'exec_command' || tool === 'shell_command') {
      if (input.run_in_background) return deny('Background Bash is unsupported; use a foreground command and interrupt to stop it.');
      const command = input.command ?? input.cmd;
      if (typeof command !== 'string' || !command.trim()) return deny('A shell command is required.');
      if (platform !== 'darwin') return deny('The mandatory Foreman command sandbox requires macOS.');
      if (mode === 'read-only' && !readOnlyCommand(command)) return deny('Read-only permits only simple inspection commands; no network or side effects.');
      const words = shellWords(command);
      if (words && ['git', 'gh'].includes(words[0]) && trustedNetworkCommand(command)) {
        for (const word of words.slice(1)) {
          const candidate = word.includes('=') ? word.slice(word.indexOf('=') + 1) : word;
          if ((candidate.includes('/') || SECRET_COMPONENT.test(candidate)) && protectedPath(canonical(resolve(root, candidate)))) return deny('Credentials cannot be supplied as command data.');
        }
      }
      if (input.cwd || input.workdir) {
        if (pathDecision(input.cwd ?? input.workdir) === 'deny') return deny('Command directory is outside its grant.');
      }
      // The provider may approve an outer sandbox escape, but this inner
      // inherited boundary remains part of the exact command being approved.
      const wrapped = shellSandbox(command, root, mode, mode === 'full' || approvedAccess || (mode === 'trusted' && trustedNetworkCommand(command)), undefined, undefined, approvedAccess);
      input.command = wrapped;
      if ('cmd' in input) input.cmd = wrapped;
      return result(mode === 'workspace' ? 'ask' : 'allow', mode === 'workspace' ? (original.dangerouslyDisableSandbox === true ? 'One-time outside-project read/write and external network access for this exact command. Credential and local API denials remain enforced. No interactive stdin grant.' : 'Run this exact guarded command with project-only data access and writes, and no network. To request outside access, explicitly set dangerouslyDisableSandbox:true.') : '');
    }
    if (tool === 'WebFetch' || tool === 'WebSearch') return mode === 'full' ? result('allow') : mode === 'workspace' ? result('ask') : deny('Network tool is outside the launch grant.');
    return deny(`Tool ${tool} is outside the launch grant.`);
  } catch { return deny('Could not verify the tool paths safely.'); }
}

export function codexPolicy(mode: PermissionMode) {
  return {
    sandbox: mode === 'read-only' ? 'read-only' : mode === 'full' ? 'danger-full-access' : 'workspace-write',
    approvalPolicy: mode === 'workspace' ? 'on-request' : 'never',
  } as const;
}
