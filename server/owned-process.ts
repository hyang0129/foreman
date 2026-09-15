import { fork, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** Pipe-compatible provider process whose watchdog owns descendant cleanup.
 * Its exit means cleanup has finished (a nonzero exit may indicate failure).
 * Detached shell groups are tracked separately from the provider's own group.
 */
export function spawnOwnedProcess(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Owned provider process cleanup requires macOS or Linux');
  const child = fork(new URL('./process-supervisor.ts', import.meta.url), [], {
    execArgv: ['--experimental-strip-types'], detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  }) as ChildProcessWithoutNullStreams;
  child.send!({ command, args, cwd: options.cwd, env: options.env ?? process.env });
  return child;
}
