// Lifecycle bookkeeping, not a sandbox. Remember process groups after their
// original parent exits; never select processes by executable name or cwd.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Budgets are failure detectors, not latency targets: the helper normally
// compiles in well under a second and runs in a few milliseconds. On a loaded
// machine (load 40-190 in #104) a 2s check killed healthy sessions, while a
// generous budget only delays reporting a genuinely broken toolchain.
export const HELPER_COMPILE_TIMEOUT_MS = 60_000; // once per source hash, not per supervisor
export const HELPER_CHECK_TIMEOUT_MS = 10_000;   // once per supervisor process
export const PROCESS_TABLE_TIMEOUT_MS = 10_000;  // each ownership sample
const LOCK_POLL_MS = 25;
const LOCK_GRACE_MS = 5_000;

export type HelperFailure = 'timeout' | 'toolchain' | 'compile' | 'check';
/** Why the macOS process identity helper is unusable. Only `toolchain` means Xcode tools are missing. */
export class ProcessHelperError extends Error {
  readonly kind: HelperFailure;
  readonly step: 'compile' | 'check';
  constructor(kind: HelperFailure, step: 'compile' | 'check', message: string) {
    super(message); this.name = 'ProcessHelperError'; this.kind = kind; this.step = step;
  }
}

/** Runs a program to completion; throws like execFileSync (code ETIMEDOUT/ENOENT, status, stderr). */
export type HelperRunner = (file: string, args: string[], timeoutMs: number) => void;
const defaultRunner: HelperRunner = (file, args, timeout) => { execFileSync(file, args, { timeout, stdio: ['ignore', 'ignore', 'pipe'] }); };

export interface HelperOptions {
  /** Private cache directory (created 0700). Default: FOREMAN_PROCESS_HELPER_DIR, else a per-user temp dir. */
  cacheDir?: string;
  compiler?: string;
  source?: string;
  compileTimeoutMs?: number;
  checkTimeoutMs?: number;
  run?: HelperRunner;
}

export function defaultHelperCacheDir() {
  // Not under FOREMAN_HOME: every test that launches an owned process would
  // otherwise write into the real ~/.foreman. macOS TMPDIR is already per-user 0700.
  return process.env.FOREMAN_PROCESS_HELPER_DIR || join(tmpdir(), `foreman-process-helper-${process.getuid?.() ?? 'user'}`);
}

const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;
function detail(error: unknown) {
  const e = error as NodeJS.ErrnoException & { stderr?: Buffer | string; status?: number | null; signal?: string | null };
  const stderr = String(e.stderr ?? '').trim().split('\n').filter(Boolean).slice(0, 5).join('; ');
  if (stderr) return stderr;
  if (typeof e.status === 'number') return `exit ${e.status}`;
  if (e.signal) return `killed by ${e.signal}`;
  return e.message ?? String(error);
}
const timedOut = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ETIMEDOUT';

function classifyCompile(error: unknown, compiler: string, budget: number): ProcessHelperError {
  if (timedOut(error)) return new ProcessHelperError('timeout', 'compile',
    `Compiling the macOS process identity helper with ${compiler} timed out after ${seconds(budget)} (machine under heavy load?)`);
  const message = detail(error);
  // /usr/bin/cc is an xcrun shim: without the Command Line Tools it exists but
  // fails with "xcrun: error: invalid active developer path".
  if ((error as NodeJS.ErrnoException).code === 'ENOENT' || /xcrun: error|active developer path|xcode-select|CommandLineTools/i.test(message)) {
    return new ProcessHelperError('toolchain', 'compile',
      `macOS process ownership requires working Xcode Command Line Tools (install with xcode-select --install): ${compiler}: ${message}`);
  }
  return new ProcessHelperError('compile', 'compile', `Compiling the macOS process identity helper failed: ${compiler}: ${message}`);
}
function classifyCheck(error: unknown, budget: number): ProcessHelperError {
  if (timedOut(error)) return new ProcessHelperError('timeout', 'check',
    `The macOS process identity helper check timed out after ${seconds(budget)} (machine under heavy load?)`);
  return new ProcessHelperError('check', 'check', `The macOS process identity API check failed: ${detail(error)}`);
}

function sleepSync(ms: number) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** A private directory we own: not a symlink, and no group/other access. */
function privateDir(dir: string) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    const uid = process.getuid?.();
    if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) return false;
    if (stat.mode & 0o077) chmodSync(dir, 0o700);
    return true;
  } catch { return false; } // e.g. a file or dangling symlink squats the path: fall back, don't fail
}
/** The lock names a holder that no longer exists (an empty or unreadable lock is not proof). */
function holderDead(lock: string) {
  let pid = 0;
  try { pid = Number(readFileSync(lock, 'utf8')); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
/** Reuse only a regular, non-empty file we own that nobody else can modify. */
function trustedBinary(file: string) {
  try {
    const stat = lstatSync(file);
    const uid = process.getuid?.();
    return stat.isFile() && stat.size > 0 && (uid === undefined || stat.uid === uid) && (stat.mode & 0o022) === 0 && (stat.mode & 0o100) !== 0;
  } catch { return false; }
}

function compileInto(dir: string, target: string, compiler: string, source: string, budget: number, run: HelperRunner) {
  const temp = join(dir, `.build-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    try { run(compiler, ['-O2', '-Wall', '-Werror', source, '-o', temp], budget); }
    catch (error) { throw classifyCompile(error, compiler, budget); }
    chmodSync(temp, 0o700);
    if (!trustedBinary(temp)) throw new ProcessHelperError('compile', 'compile', `Compiling the macOS process identity helper produced no usable binary: ${compiler}`);
    renameSync(temp, target); // atomic: readers see the old binary or the complete new one
  } finally { rmSync(temp, { force: true }); }
}

/** Return the cached binary for this source, compiling it at most once across concurrent processes. */
function cachedBinary(dir: string, compiler: string, source: string, budget: number, run: HelperRunner, replace: boolean) {
  const key = createHash('sha256').update(readFileSync(source)).update(`\0${compiler}\0${process.arch}\0${release()}\0-O2 -Wall -Werror`).digest('hex').slice(0, 32);
  const target = join(dir, `process-table-${key}`);
  const lock = `${target}.lock`;
  let deadline = Date.now() + budget + LOCK_GRACE_MS;
  for (;;) {
    if (!replace && trustedBinary(target)) return { target, fresh: false };
    let fd: number | undefined;
    try { fd = openSync(lock, 'wx', 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (fd !== undefined) {
      try {
        writeSync(fd, String(process.pid)); closeSync(fd);
        if (!replace && trustedBinary(target)) return { target, fresh: false };
        // Never unlink the target: other supervisors exec it on every sample.
        compileInto(dir, target, compiler, source, budget, run);
        return { target, fresh: true };
      } finally { rmSync(lock, { force: true }); }
    }
    // Another process is compiling. A holder that died leaves a stale lock. Two
    // waiters racing to break it can at worst compile twice, which is still safe.
    let age = 0;
    try { age = Date.now() - lstatSync(lock).mtimeMs; } catch { continue; }
    if (age > budget + LOCK_GRACE_MS || holderDead(lock)) {
      // Waiting on a stale lock was not waiting on a compile: give the next holder a full budget.
      try { unlinkSync(lock); } catch {}
      deadline = Date.now() + budget + LOCK_GRACE_MS; continue;
    }
    if (Date.now() > deadline) throw new ProcessHelperError('timeout', 'compile',
      `Waiting for another process to compile the macOS process identity helper timed out after ${seconds(budget + LOCK_GRACE_MS)} (machine under heavy load?)`);
    sleepSync(LOCK_POLL_MS);
  }
}

/** Build (or reuse) and check the helper. Throws ProcessHelperError. */
export function buildProcessHelper(options: HelperOptions = {}) {
  const compiler = options.compiler ?? '/usr/bin/cc';
  const source = options.source ?? fileURLToPath(new URL('./process-table-darwin.c', import.meta.url));
  const compileBudget = options.compileTimeoutMs ?? HELPER_COMPILE_TIMEOUT_MS;
  const checkBudget = options.checkTimeoutMs ?? HELPER_CHECK_TIMEOUT_MS;
  const run = options.run ?? defaultRunner;
  let dir = options.cacheDir ?? defaultHelperCacheDir();
  if (!privateDir(dir)) {
    // Someone else owns the shared path (e.g. TMPDIR=/tmp): fall back to an uncached private build.
    dir = mkdtempSync(join(tmpdir(), 'foreman-process-helper-'));
    const own = dir; process.once('exit', () => rmSync(own, { recursive: true, force: true }));
  }
  for (let attempt = 0; ; attempt++) {
    const { target, fresh } = cachedBinary(dir, compiler, source, compileBudget, run, attempt > 0);
    try { run(target, [], checkBudget); return target; }
    catch (error) {
      const failure = classifyCheck(error, checkBudget);
      // A damaged cached binary is rebuilt (atomically replaced) once; a fresh
      // one that fails is a real API failure. Timeouts are reported, not retried.
      if (failure.kind === 'check' && !fresh && attempt === 0) continue;
      throw failure;
    }
  }
}

let helper: string | undefined;
export function processHelper() {
  if (process.platform !== 'darwin') return undefined;
  if (!helper) helper = buildProcessHelper();
  return helper;
}

export interface ProcessEntry { pid: number; ppid: number; pgid: number; started: string; stat: string; parentIdentity?: string }
export function processTable(): ProcessEntry[] {
  const native = processHelper();
  if (native) {
    const output = execFileSync(native, [], {encoding:'utf8',timeout:PROCESS_TABLE_TIMEOUT_MS,maxBuffer:8_000_000});
    return output.trim().split('\n').map((line) => {
      const [pid,ppid,pgid,stat,identity,parentIdentity] = line.split(' ');
      if (!parentIdentity) throw new Error('Invalid macOS process identity row');
      return {pid:Number(pid),ppid:Number(ppid),pgid:Number(pgid),stat,started:`id:${identity}`,parentIdentity:`id:${parentIdentity}`};
    });
  }
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {
    encoding: 'utf8', timeout: PROCESS_TABLE_TIMEOUT_MS, maxBuffer: 8_000_000, env: { ...process.env, LC_ALL: 'C' },
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
