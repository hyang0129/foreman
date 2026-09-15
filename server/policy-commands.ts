import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { canonical, protectedPath, shellSandbox, toolDecision, trustedNetworkCommand, under, type PermissionMode } from './permission-policy.ts';

type Process = { oneTimeAccess: boolean; child: ChildProcessWithoutNullStreams; output: string; code: number | null; done: boolean; wake: Set<() => void> };
export const POLICY_COMMAND_TOOLS = [
  { type: 'function', name: 'foreman_exec', description: 'Run a shell command under this session’s fixed launch policy. Returns output and, for ongoing commands, a process_id. In Workspace only, request_access asks the developer to approve this exact command once when network or outside-project access is needed. It never changes the session policy.', inputSchema: { type: 'object', additionalProperties: false, required: ['command'], properties: {
    command: { type: 'string' }, cwd: { type: 'string' }, request_access: { type: 'boolean' }, yield_ms: { type: 'integer', minimum: 0, maximum: 30000 },
  } } },
  { type: 'function', name: 'foreman_process', description: 'Read output, send stdin, or terminate a process started by foreman_exec in this session. Retains the original command’s sandbox.', inputSchema: { type: 'object', additionalProperties: false, required: ['process_id'], properties: {
    process_id: { type: 'string' }, chars: { type: 'string' }, terminate: { type: 'boolean' }, yield_ms: { type: 'integer', minimum: 0, maximum: 30000 },
  } } },
];
export const POLICY_COMMAND_INSTRUCTIONS = 'Use foreman_exec for all shell commands and foreman_process for ongoing processes. They enforce your immutable launch policy. In Workspace, if a command needs network or outside-project access, retry that exact command with request_access:true to ask the developer for one-time approval. Do not bypass these tools or change the session policy. File searches should use these sandboxed commands so denied descendants remain unreadable.';

/** One owner per thread. No HTTP endpoint or caller-selected policy/identity. */
export class PolicyCommands {
  private processes = new Map<string, Process>();
  private closed = false;
  private readonly mode: PermissionMode;
  private readonly cwd: string;
  private readonly approve: (command: string, cwd: string) => Promise<boolean>;
  constructor(mode: PermissionMode, cwd: string, approve: (command: string, cwd: string) => Promise<boolean>) {
    this.mode = mode; this.cwd = canonical(resolve(cwd)); this.approve = approve;
  }
  async call(name: string, input: any) {
    if (this.closed) throw new Error('Command controller is closed');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tool input must be an object');
    const keys = name === 'foreman_exec' ? ['command', 'cwd', 'request_access', 'yield_ms'] : name === 'foreman_process' ? ['process_id', 'chars', 'terminate', 'yield_ms'] : [];
    if (!keys.length || Object.keys(input).some((key) => !keys.includes(key))) throw new Error('Unknown command tool or argument; the launch policy cannot be changed');
    if (input.yield_ms !== undefined && (!Number.isInteger(input.yield_ms) || input.yield_ms < 0 || input.yield_ms > 30000)) throw new Error('yield_ms must be 0–30000');
    for (const key of ['request_access', 'terminate']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} must be boolean`);
    if (name === 'foreman_exec') {
      if (typeof input.command !== 'string' || !input.command.trim() || Buffer.byteLength(input.command) > 65536) throw new Error('command must contain 1–65536 bytes');
      if (input.cwd !== undefined && typeof input.cwd !== 'string') throw new Error('cwd must be a string');
      const cwd = canonical(resolve(this.cwd, input.cwd ?? '.'));
      if (protectedPath(cwd)) throw new Error('Command directory is on the deny list');
      if (input.request_access && !['workspace', 'full'].includes(this.mode)) throw new Error('This launch policy refuses one-time access requests');
      if (!under(cwd, this.cwd) && this.mode !== 'full' && !(this.mode === 'workspace' && input.request_access)) throw new Error('Outside-project commands require Workspace one-time approval; other restricted presets refuse them');
      const decision = toolDecision(this.mode, this.cwd, 'Bash', { command: input.command, cwd });
      if (decision.behavior === 'deny') throw new Error(decision.message);
      let oneTimeAccess = false;
      if (this.mode === 'workspace' && input.request_access) {
        if (!await this.approve(input.command, cwd)) throw new Error('Command denied by the developer');
        oneTimeAccess = true;
      }
      if (this.closed) throw new Error('Command controller is closed');
      if ([...this.processes.values()].filter((p) => !p.done).length >= 16) throw new Error('Too many active commands');
      for (const [id, process] of this.processes) if (process.done) this.processes.delete(id);
      if (this.processes.size >= 100) throw new Error('Collect completed command output before starting more commands');
      const network = this.mode === 'full' || oneTimeAccess || (this.mode === 'trusted' && trustedNetworkCommand(input.command));
      const command = shellSandbox(input.command, this.cwd, this.mode, network, undefined, undefined, oneTimeAccess);
      const child = spawn('/bin/sh', ['-c', command], { cwd, stdio: 'pipe', detached: true });
      const id = randomUUID();
      const process: Process = { oneTimeAccess, child, output: '', code: null, done: false, wake: new Set() };
      this.processes.set(id, process);
      const append = (data: Buffer) => { process.output = (process.output + data.toString()).slice(-1_000_000); };
      child.stdout.on('data', append); child.stderr.on('data', append);
      child.stdin.on('error', () => {});
      child.on('error', () => { process.output += '\nCould not start the guarded command'; process.code = 1; process.done = true; for (const wake of process.wake) wake(); });
      child.on('close', (code) => { process.code = code; process.done = true; for (const wake of process.wake) wake(); });
      return this.collect(id, process, input.yield_ms ?? 1000);
    }
    const process = this.processes.get(input.process_id);
    if (!process) throw new Error('No such process in this session');
    if (input.chars !== undefined) {
      if (process.oneTimeAccess) throw new Error('stdin cannot extend a one-time command approval; submit a new exact command');
      if (typeof input.chars !== 'string' || Buffer.byteLength(input.chars) > 65536) throw new Error('stdin exceeds 65536 bytes');
      if (process.done) throw new Error('Process has ended');
      process.child.stdin.write(input.chars);
    }
    if (input.terminate) this.kill(process);
    return this.collect(input.process_id, process, input.yield_ms ?? 1000);
  }
  private async collect(id: string, process: Process, delay: number) {
    if (!process.done && delay) await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); process.wake.delete(done); resolve(); };
      const timer = setTimeout(done, delay); process.wake.add(done);
    });
    const output = process.output; process.output = '';
    if (process.done) this.processes.delete(id);
    return { process_id: process.done ? null : id, exit_code: process.code, output };
  }
  private kill(child: Process) {
    if (!child.done && child.child.pid) { try { process.kill(-child.child.pid, 'SIGKILL'); } catch {} }
  }
  interrupt() { for (const child of this.processes.values()) this.kill(child); }
  close() { this.closed = true; this.interrupt(); }
}
