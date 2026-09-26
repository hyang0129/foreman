// #155: which Claude Code binary Foreman runs. Every Claude use (model discovery, managed sessions,
// the launcher, fleet discovery, the PM) goes through the one choice made here, exported from
// paths.ts as CLAUDE_BIN, so the model picker and the sessions it launches see the same CLI.
//
// Order: FOREMAN_CLAUDE_BIN, then the installed `claude` on the process's own PATH, then the binary
// bundled with the Agent SDK. The PATH searched is this process's environment, never a login shell's:
// under the service that is the explicit search path scripts/service.mjs writes into the plist.
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export type ClaudeBinSource = 'override' | 'installed' | 'bundled' | 'unresolved';
export interface ClaudeBinChoice { path: string; source: ClaudeBinSource }

function isExecutableFile(path: string): boolean {
  try { return statSync(path).isFile() && (accessSync(path, constants.X_OK), true); } catch { return false; }
}

/** The first executable `claude` in `pathEnv`, skipping relative entries (they depend on the cwd). */
export function findInstalledClaude(pathEnv: string | undefined, isExecutable = isExecutableFile): string | null {
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'claude');
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export function resolveClaudeBin({ env = process.env, bundled, isExecutable = isExecutableFile, bundledExists = existsSync }: {
  env?: NodeJS.ProcessEnv; bundled: string; isExecutable?: (path: string) => boolean; bundledExists?: (path: string) => boolean;
}): ClaudeBinChoice {
  if (env.FOREMAN_CLAUDE_BIN) return { path: env.FOREMAN_CLAUDE_BIN, source: 'override' };
  const installed = findInstalledClaude(env.PATH, isExecutable);
  if (installed) return { path: installed, source: 'installed' };
  if (bundledExists(bundled)) return { path: bundled, source: 'bundled' };
  // Nothing found: leave it to the OS lookup at spawn time, which reports a clear ENOENT.
  return { path: 'claude', source: 'unresolved' };
}

const SOURCE_TEXT: Record<ClaudeBinSource, string> = {
  override: 'FOREMAN_CLAUDE_BIN',
  installed: 'installed, found on PATH',
  bundled: 'bundled with the Agent SDK; no installed claude on PATH',
  unresolved: 'not found on PATH and no bundled binary',
};
export function describeClaudeSource(source: ClaudeBinSource): string { return SOURCE_TEXT[source]; }

/** `<bin> --version` (e.g. "2.1.280 (Claude Code)"), or null when it cannot be run. Starts no model turn. */
export function claudeVersion(path: string, timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: timeoutMs, env: process.env, maxBuffer: 64_000 }, (error, stdout) => {
      const line = String(stdout ?? '').trim().split('\n')[0]?.trim();
      resolve(error || !line ? null : line.slice(0, 200));
    });
  });
}
