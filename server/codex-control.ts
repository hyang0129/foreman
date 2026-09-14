import { PolicyCommands, POLICY_COMMAND_TOOLS, POLICY_COMMAND_INSTRUCTIONS } from './policy-commands.ts';
// Small app-server client. stdio owns a server; socket attaches to an existing one.
// Never resumes an arbitrary disk transcript implicitly or changes a session's permissions.
import { permissionMode, codexPolicy, type PermissionMode } from './permission-policy.ts';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import WebSocket from 'ws';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };
export type CodexStatus = { type: 'idle' | 'notLoaded' | 'systemError' | 'active'; activeFlags?: string[] };
export interface CodexThread {
  id: string; name?: string | null; cwd: string; path?: string | null;
  preview?: string; createdAt: number; updatedAt: number; status: CodexStatus;
  canAcceptDirectInput?: boolean | null;
  turns?: { id: string; status: string; items: Json[] }[];
}
export interface CodexRequest { id: string | number; method: string; params: Record<string, Json> }
interface Options { bin?: string; socket?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }

export class CodexControl extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private socket: WebSocket | null = null;
  private attempted = false;
  private ready = false;
  private seq = 0;
  private buffer = '';
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private requests = new Map<string | number, CodexRequest>();
  private attached = new Set<string>();
  private turns = new Map<string, string>();
  private options: Options;
  private policySnapshots: string[] = [];
  private commands = new Map<string, PolicyCommands>();
  private commandApprovals = new Map<string, (allowed: boolean) => void>();
  constructor(options: Options = {}) { super(); this.options = options; }

  async connect() {
    if (this.attempted) throw new Error('Already connected; create a new client after disconnect');
    this.attempted = true;
    if (this.options.socket) {
      if (!isAbsolute(this.options.socket) || /[:?#]/.test(this.options.socket)) throw new Error('Use an absolute Unix socket path without :, ?, or #');
      this.socket = new WebSocket(`ws+unix:${this.options.socket}:/`, { perMessageDeflate: false, handshakeTimeout: this.options.timeoutMs ?? 10_000, maxPayload: 8_000_000 });
      this.socket.on('message', (data, binary) => {
        if (binary) { this.disconnected(new Error('Expected a Codex text frame')); this.close(); return; }
        this.receive(data.toString() + '\n');
      });
      this.socket.on('error', (error) => this.disconnected(error));
      this.socket.on('close', () => this.disconnected(new Error('Codex socket disconnected')));
      await new Promise<void>((resolve, reject) => { this.socket!.once('open', resolve); this.socket!.once('error', reject); });
    } else {
    const args = ['app-server', '--stdio'];
    this.child = spawn(this.options.bin ?? process.env.FOREMAN_CODEX_BIN ?? 'codex', [...args, ...(this.options.args ?? [])], {
      cwd: this.options.cwd, env: this.options.env ?? process.env, stdio: 'pipe',
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk));
    // Diagnostics can contain account/config details. Emit only when a caller explicitly subscribes.
    this.child.stderr.on('data', (chunk: Buffer) => this.emit('diagnostic', chunk.toString()));
    this.child.on('error', (error) => this.disconnected(error));
    this.child.on('exit', (code) => this.disconnected(new Error(`Codex connection closed (exit ${code})`)));
    this.child.stdin.on('error', (error) => this.disconnected(error));
    }
    try {
      await this.request('initialize', { clientInfo: { name: 'foreman', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      this.write({ method: 'initialized', params: {} });
      this.ready = true;
    } catch (error) { this.close(); throw error; }
    return this;
  }

  private write(message: Json) {
    if (this.socket) {
      if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Codex is disconnected');
      this.socket.send(JSON.stringify(message)); return;
    }
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex is disconnected');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request<T = unknown>(method: string, params: Json = {}): Promise<T> {
    if (!this.ready && method !== 'initialize') return Promise.reject(new Error('Codex is not initialized'));
    if (this.pending.size >= 64) return Promise.reject(new Error('Too many pending Codex requests'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out; delivery is unknown. Do not retry a mutation automatically.`));
      }, this.options.timeoutMs ?? 30_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private receive(chunk: string) {
    this.buffer += chunk;
    // A paginated transcript should fit; fail closed on an unbounded/malformed peer.
    if (this.buffer.length > 8_000_000) { this.disconnected(new Error('Codex frame exceeds 8 MB')); this.close(); return; }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.disconnected(new Error('Invalid Codex JSON frame')); this.close(); return; }
      if (!message || typeof message !== 'object') continue;
      if (!message.method && typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`Codex: ${message.error.message ?? 'request failed'}`));
        else pending.resolve(message.result);
      } else if (typeof message.method === 'string') {
        const p = message.params ?? {};
        if (message.id !== undefined) {
          if (message.method === 'item/permissions/requestApproval') {
            this.write({ id: message.id, result: { permissions: {}, scope: 'turn' } });
            continue;
          }
          this.requests.set(message.id, message);
          const commands = this.commands.get(p.threadId);
          if (message.method === 'item/tool/call' && ['foreman_exec', 'foreman_process'].includes(p.tool) && !p.namespace && commands) {
            void commands.call(p.tool, p.arguments).then(
              (result) => this.respondTool(message.id, { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] }),
              (error) => this.respondTool(message.id, { success: false, contentItems: [{ type: 'inputText', text: String(error) }] }),
            ).catch(() => {});
          } else this.emit('request', message);
        } else {
          const completedActiveTurn = message.method === 'turn/completed' && this.turns.get(p.threadId) === p.turn?.id;
          if (message.method === 'turn/started' && p.threadId && p.turn?.id) this.turns.set(p.threadId, p.turn.id);
          if (completedActiveTurn) this.turns.delete(p.threadId);
          if (message.method === 'serverRequest/resolved') this.requests.delete(p.requestId);
          if (message.method === 'thread/closed') { this.attached.delete(p.threadId); this.turns.delete(p.threadId); this.commands.get(p.threadId)?.close(); this.commands.delete(p.threadId); }
          if (message.method === 'turn/completed' || message.method === 'thread/closed') {
            for (const [id, req] of this.requests) {
              if (req.params.threadId !== p.threadId) continue;
              // A delayed completion must not discard a newer turn's approval.
              if (message.method === 'thread/closed' ||
                (req.params.turnId ? req.params.turnId === p.turn?.id : completedActiveTurn)) {
                this.commandApprovals.get(String(id))?.(false); this.commandApprovals.delete(String(id)); this.requests.delete(id);
              }
            }
          }
          this.emit('notification', message);
        }
      }
    }
  }
  private disconnected(error: Error) {
    const wasConnected = this.ready || this.pending.size > 0;
    this.ready = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    for (const resolve of this.commandApprovals.values()) resolve(false);
    this.commandApprovals.clear();
    for (const commands of this.commands.values()) commands.close();
    this.commands.clear();
    this.pending.clear(); this.requests.clear(); this.attached.clear(); this.turns.clear();
    if (wasConnected) this.emit('disconnect', error);
  }
  close() {
    this.disconnected(new Error('Codex client closed'));
    this.child?.stdin.end(); this.child?.kill('SIGTERM');
    this.socket?.terminate();
    for (const directory of this.policySnapshots) rmSync(directory, { recursive: true, force: true });
    this.policySnapshots = [];
    // Closing a socket disconnects this client, not the shared app-server.
  }
  list(cursor?: string) {
    return this.request<{ data: CodexThread[]; nextCursor: string | null }>('thread/list', { limit: 100, sortKey: 'updated_at', ...(cursor ? { cursor } : {}) });
  }
  read(threadId: string) { return this.request<{ thread: CodexThread }>('thread/read', { threadId, includeTurns: false }); }
  history(threadId: string, cursor?: string) {
    return this.request<{ data: Json[]; nextCursor: string | null }>('thread/turns/list', { threadId, limit: 10, itemsView: 'full', ...(cursor ? { cursor } : {}) });
  }
  async start(cwd: string, extra: Record<string, Json> = {}, policy?: PermissionMode) {
    const mode = permissionMode(policy);
    for (const key of ['sandbox', 'approvalPolicy', 'permissions', 'config', 'approvalsReviewer']) {
      if (key in extra) throw new Error('Provider permission overrides are forbidden; choose a launch preset');
    }
    const directory = mkdtempSync(join(tmpdir(), 'foreman-policy-'));
    this.policySnapshots.push(directory);
    for (const name of ['permission-policy.ts', 'permission-hook.ts']) copyFileSync(fileURLToPath(new URL(name, import.meta.url)), join(directory, name));
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const command = [process.execPath, '--experimental-strip-types', join(directory, 'permission-hook.ts'), mode, cwd].map(quote).join(' ');
    const result = await this.request<{ thread: CodexThread; approvalPolicy: string; sandbox: { type: string; networkAccess?: boolean } }>('thread/start', {
      ...extra, cwd, ...codexPolicy(mode), approvalsReviewer: 'user',
      dynamicTools: [...(Array.isArray(extra.dynamicTools) ? extra.dynamicTools : []), ...POLICY_COMMAND_TOOLS] as Json,
      developerInstructions: [extra.developerInstructions ?? '', POLICY_COMMAND_INSTRUCTIONS].join('\n'),
      config: {
        'features.hooks': true,
        'features.shell_tool': false,
        'features.unified_exec': false,
        'hooks.PreToolUse': [{ hooks: [{ type: 'command', command }] }],
        'sandbox_workspace_write.network_access': mode === 'trusted',
        'web_search': mode === 'read-only' || mode === 'trusted' ? 'disabled' : mode === 'full' ? 'live' : 'cached',
        'shell_environment_policy.exclude': ['FOREMAN_*', '*SECRET*', '*PASSWORD*', '*CREDENTIAL*'],
      },
    });
    const expectedSandbox = mode === 'full' ? 'dangerFullAccess' : mode === 'read-only' ? 'readOnly' : 'workspaceWrite';
    if (result.approvalPolicy !== codexPolicy(mode).approvalPolicy || result.sandbox?.type !== expectedSandbox ||
      (mode !== 'full' && !!result.sandbox.networkAccess !== (mode === 'trusted'))) {
      throw new Error('Codex did not apply the requested launch policy; session was not activated');
    }
    this.commands.set(result.thread.id, new PolicyCommands(mode, cwd, (command, workdir) => {
      const id = `foreman-command:${randomUUID()}`;
      const request: CodexRequest = { id, method: 'item/commandExecution/requestApproval', params: { threadId: result.thread.id, ...(this.turns.get(result.thread.id) ? { turnId: this.turns.get(result.thread.id)! } : {}), command, cwd: workdir, reason: 'One-time network or outside-project access. The deny list and session policy stay in force.' } };
      return new Promise<boolean>((resolve) => {
        this.commandApprovals.set(id, resolve); this.requests.set(id, request); this.emit('request', request);
      });
    }));
    this.attached.add(result.thread.id);
    return result.thread;
  }
  async attach(threadId: string) {
    const { thread } = await this.read(threadId);
    if (thread.status.type === 'notLoaded') throw new Error('Thread is not running on this app-server. Use its original server, or explicitly hand off a stopped session.');
    if (thread.canAcceptDirectInput === false) throw new Error('This thread does not accept direct input');
    const result = await this.request<{ thread: CodexThread }>('thread/resume', { threadId });
    this.attached.add(threadId);
    const active = result.thread.turns?.find((turn) => turn.status === 'inProgress');
    if (active) this.turns.set(threadId, active.id);
    else this.turns.delete(threadId);
    return result.thread;
  }
  private requireAttached(threadId: string) {
    if (!this.attached.has(threadId)) throw new Error('Attach to this live session before sending input');
  }
  async send(threadId: string, text: string, mode: 'turn' | 'steer' = 'turn') {
    this.requireAttached(threadId);
    if (!text.trim() || text.length > 100_000) throw new Error('Message must contain 1–100000 characters');
    const turnId = this.turns.get(threadId);
    if (mode === 'steer') {
      if (!turnId) throw new Error('No known active turn; refresh/attach before steering');
      return this.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text }], clientUserMessageId: randomUUID() });
    }
    if (turnId) throw new Error('Session is busy; explicitly steer it or queue a message');
    return this.request('turn/start', { threadId, input: [{ type: 'text', text }], clientUserMessageId: randomUUID() });
  }
  queue(threadId: string, text: string, messageId: string = randomUUID()) {
    this.requireAttached(threadId);
    if (!text.trim() || text.length > 100_000) throw new Error('Message must contain 1–100000 characters');
    return this.request('thread/queue/add', { threadId, input: [{ type: 'text', text }], clientUserMessageId: messageId });
  }
  interrupt(threadId: string) {
    this.requireAttached(threadId);
    this.commands.get(threadId)?.interrupt();
    for (const [id, resolve] of this.commandApprovals) if (this.requests.get(id)?.params.threadId === threadId) { resolve(false); this.commandApprovals.delete(id); this.requests.delete(id); }
    const turnId = this.turns.get(threadId);
    if (!turnId) throw new Error('No known active turn');
    return this.request('turn/interrupt', { threadId, turnId });
  }
  pendingRequests() { return [...this.requests.values()]; }
  respondTool(id: string | number, result: Record<string, Json>) {
    const request = this.requests.get(id);
    if (!request || request.method !== 'item/tool/call') throw new Error('Tool request is no longer pending');
    this.write({ id, result }); this.requests.delete(id);
  }
  respond(id: string | number, result: Record<string, Json>) {
    const request = this.requests.get(id);
    if (!request) throw new Error('Request is no longer pending');
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) {
      if (!['accept', 'decline', 'cancel'].includes(String(result.decision))) throw new Error('Use a one-time accept, decline, or cancel decision');
    } else if (request.method === 'item/tool/requestUserInput') {
      if (!result.answers || typeof result.answers !== 'object' || Array.isArray(result.answers)) throw new Error('answers required');
    } else throw new Error(`Unsupported request type: ${request.method}. Respond in the original client.`);
    const commandApproval = this.commandApprovals.get(String(id));
    if (commandApproval) {
      this.commandApprovals.delete(String(id)); this.requests.delete(id);
      commandApproval(result.decision === 'accept');
      return;
    }
    this.write({ id, result }); this.requests.delete(id);
  }
}
