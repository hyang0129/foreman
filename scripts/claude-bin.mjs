// #164: plain-JS twin of server/claude-bin.ts `resolveClaudeBin` for scripts that run under plain
// `node` (scripts/dev-environment.mjs), which cannot import .ts on every supported Node version.
// Same order: FOREMAN_CLAUDE_BIN, then the first executable `claude` on the process's own PATH
// (absolute entries only), then the given bundled binary, else the bare name `claude`.
// tests/claude-bin.test.ts checks that the two agree.
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

function isExecutableFile(path) {
  try { return statSync(path).isFile() && (accessSync(path, constants.X_OK), true); } catch { return false; }
}

/** The first executable `claude` in `pathEnv`, skipping relative entries (they depend on the cwd). */
export function findInstalledClaude(pathEnv, isExecutable = isExecutableFile) {
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'claude');
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** `{ path, source }` with source `override`, `installed`, `bundled` or `unresolved`. */
export function resolveClaudeBin({ env = process.env, bundled, isExecutable = isExecutableFile, bundledExists = existsSync }) {
  if (env.FOREMAN_CLAUDE_BIN) return { path: env.FOREMAN_CLAUDE_BIN, source: 'override' };
  const installed = findInstalledClaude(env.PATH, isExecutable);
  if (installed) return { path: installed, source: 'installed' };
  if (bundledExists(bundled)) return { path: bundled, source: 'bundled' };
  return { path: 'claude', source: 'unresolved' };
}
