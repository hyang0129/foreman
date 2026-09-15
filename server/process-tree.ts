// Lifecycle bookkeeping, not a sandbox. Remember process groups after their
// original parent exits; never select processes by executable name or cwd.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let helper: string | undefined;
export function processHelper() {
  if (process.platform !== 'darwin') return undefined;
  if (helper) return helper;
  const dir = mkdtempSync(join(tmpdir(), 'foreman-process-helper-'));
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'process-table');
  try {
    execFileSync('/usr/bin/cc', ['-O2', '-Wall', '-Werror', fileURLToPath(new URL('./process-table-darwin.c', import.meta.url)), '-o', target], {timeout:30000,stdio:'pipe'});
    execFileSync(target, [], {timeout:2000,stdio:'pipe'});
  } catch { throw new Error('macOS process ownership requires working Xcode Command Line Tools and the process identity API'); }
  helper = target;
  return helper;
}

export interface ProcessEntry { pid: number; ppid: number; pgid: number; started: string; stat: string; parentIdentity?: string }
export function processTable(): ProcessEntry[] {
  const native = processHelper();
  if (native) {
    const output = execFileSync(native, [], {encoding:'utf8',timeout:2000,maxBuffer:8_000_000});
    return output.trim().split('\n').map((line) => {
      const [pid,ppid,pgid,stat,identity,parentIdentity] = line.split(' ');
      if (!parentIdentity) throw new Error('Invalid macOS process identity row');
      return {pid:Number(pid),ppid:Number(ppid),pgid:Number(pgid),stat,started:`id:${identity}`,parentIdentity:`id:${parentIdentity}`};
    });
  }
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 8_000_000, env: { ...process.env, LC_ALL: 'C' },
  });
  return output.trim().split('\n').flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 9) return [];
    return [{ pid: Number(fields[0]), ppid: Number(fields[1]), pgid: Number(fields[2]), stat: fields[3], started: fields.slice(4).join(' ') }];
  });
}
export class ProcessTree {
  private known = new Map<number, string>();
  private identities = new Set<string>();
  private root: number;
  constructor(root: number) { this.root = root; }
  sample(rows = processTable()) {
    const selected = new Set<number>();
    for (const row of rows) {
      if ((row.pid === this.root && !this.known.has(this.root)) || this.known.get(row.pid) === row.started) selected.add(row.pid);
    }
    // A live, previously observed member establishes ownership of its group,
    // even if the leader has exited. Discard stale PIDs before following groups.
    let changed = true;
    while (changed) {
      changed = false;
      const groups = new Set(rows.filter((row) => selected.has(row.pid)).map((row) => row.pgid));
      const identities = new Set([...this.identities, ...rows.filter((row) => selected.has(row.pid)).map((row) => row.started)]);
      for (const row of rows) if (!selected.has(row.pid) && (selected.has(row.ppid) || groups.has(row.pgid) ||
          (row.parentIdentity && identities.has(row.parentIdentity)))) {
        selected.add(row.pid); identities.add(row.started); changed = true;
      }
    }
    for (const row of rows) if (selected.has(row.pid)) { this.known.set(row.pid, row.started); this.identities.add(row.started); }
    return rows.filter((row) => selected.has(row.pid));
  }
  signal(signal: NodeJS.Signals) {
    const rows = this.sample();
    const groups = new Set(rows.map((row) => row.pgid));
    for (const group of groups) {
      // The root is launched detached; neither Foreman nor this watchdog is in
      // an owned group. Refuse a malformed table rather than signal ourselves.
      if (group <= 1 || rows.some((row) => row.pid === process.pid)) throw new Error('Invalid owned process group');
      try { process.kill(-group, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    return rows.filter((row) => !row.stat.startsWith('Z'));
  }
}
