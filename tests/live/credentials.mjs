import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The caller supplies only its owned temporary config directory. Never consult ~/.claude.
export function bootstrapClaudeCredentials(configDir, {
  enabled = process.env.FOREMAN_LIVE_CLAUDE_KEYCHAIN,
  platform = process.platform,
  run = spawnSync,
} = {}) {
  if (enabled !== '1') throw new Error('Claude live authentication requires explicit FOREMAN_LIVE_CLAUDE_KEYCHAIN=1 opt-in; no provider was launched. The real ~/.claude directory is never read or copied.');
  if (platform !== 'darwin') throw new Error('Claude Keychain bootstrap requires macOS.');
  const result = run('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  // Do not include stdout/stderr or parse errors: either could contain a secret.
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    throw new Error('Claude Keychain bootstrap failed: Claude Code-credentials is missing, unreadable, or the Keychain is locked. No provider was launched.');
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (!parsed.claudeAiOauth?.accessToken || !parsed.claudeAiOauth?.refreshToken) throw new Error();
  } catch {
    throw new Error('Claude Keychain bootstrap failed: Claude Code-credentials is not valid OAuth credential JSON. No provider was launched.');
  }
  const path = join(configDir, '.credentials.json');
  writeFileSync(path, result.stdout, { mode: 0o600, flag: 'wx' });
  return path;
}
