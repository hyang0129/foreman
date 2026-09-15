// Independent watchdog for ONE owned provider. IPC EOF survives Foreman being
// killed; provider exit survives the provider being killed. No command rewriting.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessTree, processHelper } from './process-tree.ts';

let child: ChildProcessWithoutNullStreams | undefined;
let tree: ProcessTree | undefined;
let timer: NodeJS.Timeout | undefined;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true; clearInterval(timer);
  try {
    child?.stdin.end();
    tree?.signal('SIGTERM');
    const deadline = Date.now() + 3000;
    while (tree?.sample().some((row) => !row.stat.startsWith('Z'))) {
      await delay(100);
      tree.signal('SIGKILL');
      if (Date.now() > deadline) throw new Error('Owned provider processes did not exit');
    }
  } catch (error) { process.stderr.write(`Foreman process cleanup failed: ${String(error)}\n`); code = 1; }
  process.exit(code);
}
process.on('disconnect', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
process.stdin.on('end', () => { void stop(); });
process.stdout.on('error', () => { void stop(); });
process.stderr.on('error', () => { void stop(); });
function watch(active: boolean) {
  clearInterval(timer);
  timer = setInterval(() => { try { tree!.sample(); } catch { void stop(1); } }, active ? 50 : 1000);
}
process.on('message', (message: { type?: string; active?: boolean; command: string; args: string[]; cwd?: string; env: NodeJS.ProcessEnv }) => {
  if (message.type === 'active') { if (tree && !stopping) watch(!!message.active); return; }
  if (child || stopping) return;
  // Build and validate BEFORE launching anything. The native startup gate
  // prevents a fast provider from exiting before its birth identity is known.
  let helper: string | undefined;
  try { helper = processHelper(); }
  catch (error) { process.stderr.write(`${String(error)}\n`); void stop(2); return; }
  child = spawn(helper ?? message.command, helper ? ['--exec', message.command, ...message.args] : message.args,
    { cwd: message.cwd, env: message.env, detached: true, stdio: ['pipe','pipe','pipe','pipe'] }) as ChildProcessWithoutNullStreams;
  if (child.pid) {
    tree = new ProcessTree(child.pid);
    // Keep ownership while the parent relationship still exists. The final
    // sample on exit also picks up descendants created since the last tick.
    watch(true);
    if (!tree.sample().some((entry) => entry.pid === child!.pid)) {
      process.stderr.write('Could not record provider process ownership\n');
      void stop(2); return;
    }
    if (helper) (child.stdio[3] as import('node:stream').Writable).end('1');
  }
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr, { end: false });
  child.stdin.on('error', () => { void stop(); });
  child.on('error', (error) => { process.stderr.write(`Provider launch failed: ${error.message}\n`); void stop(2); });
  child.on('exit', (code, signal) => { void stop(signal || code ? 2 : 0); });
});
