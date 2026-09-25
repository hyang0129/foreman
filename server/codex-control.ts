// Small app-server client. stdio owns a server; socket attaches to an existing one.
// Never resumes an arbitrary disk transcript implicitly or changes a session's permissions.
import { permissionMode, codexPolicy, type PermissionMode } from './permission-policy.ts';
import { EventEmitter } from 'node:events';
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import WebSocket from 'ws';
import { spawnOwnedProcess } from './owned-process.ts';

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
  private closing?: Promise<void>;
  private interrupted = new Set<string>();
  private interrupting = new Map<string, Promise<unknown>>();
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
    this.child = spawnOwnedProcess(this.options.bin ?? process.env.FOREMAN_CODEX_BIN ?? 'codex', [...args, ...(this.options.args ?? [])], {
      cwd: this.options.cwd, env: this.options.env ?? process.env,
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

  private setActive(active: boolean) {
    if (this.child?.connected) this.child.send!({ type: 'active', active }, () => {});
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
          this.emit('request', message);
        } else {
          // Codex can announce a native command AFTER turn/completed(interrupted).
          // Terminate that exact execution, never sweep a newer turn's terminals.
          if (message.method === 'item/started' && p.item?.type === 'commandExecution' &&
              this.interrupted.has(p.turnId)) {
            if (!p.item.processId) { void this.close(); continue; }
            void this.request('thread/backgroundTerminals/terminate', { threadId: p.threadId, processId: p.item.processId })
              .catch(() => { void this.close(); });
          }
          const threadEnded = ['thread/closed', 'thread/archived'].includes(message.method) ||
            (message.method === 'thread/status/changed' && p.status?.type === 'notLoaded');
          const completedActiveTurn = message.method === 'turn/completed' && this.turns.get(p.threadId) === p.turn?.id;
          if (message.method === 'turn/started' && p.threadId && p.turn?.id) this.turns.set(p.threadId, p.turn.id);
          if (completedActiveTurn) this.turns.delete(p.threadId);
          if (message.method === 'serverRequest/resolved') this.requests.delete(p.requestId);
          if (threadEnded) { this.attached.delete(p.threadId); this.turns.delete(p.threadId); }
          if (message.method === 'turn/completed' || threadEnded) {
            for (const [id, req] of this.requests) {
              if (req.params.threadId !== p.threadId) continue;
              // A delayed completion must not discard a newer turn's approval.
              if (threadEnded ||
                (req.params.turnId ? req.params.turnId === p.turn?.id : completedActiveTurn)) {
                this.requests.delete(id);
              }
            }
          }
          if (message.method === 'turn/started' || completedActiveTurn || threadEnded) this.setActive(this.turns.size > 0);
          this.emit('notification', message);
          if (threadEnded && this.child && !this.attached.size) void this.close();
        }
      }
    }
  }
  private disconnected(error: Error) {
    const wasConnected = this.ready || this.pending.size > 0;
    this.ready = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.requests.clear(); this.attached.clear(); this.turns.clear();
    if (wasConnected) this.emit('disconnect', error);
    if (this.child) void this.close();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.child && this.child.exitCode === null && this.child.signalCode === null
      ? new Promise<void>((resolve, reject) => { this.child!.once('exit', (code) => code === 1
        ? reject(new Error('Codex process cleanup failed; inspect diagnostics')) : resolve()); })
      : this.child?.exitCode === 1 ? Promise.reject(new Error('Codex process cleanup failed; inspect diagnostics')) : Promise.resolve();
    // Event-driven disconnects also initiate cleanup; explicit callers still
    // receive rejection, without an unhandled promise when no caller awaits it.
    void this.closing.catch(() => {});
    this.disconnected(new Error('Codex client closed'));
    this.child?.stdin.end(); this.child?.kill('SIGTERM');
    this.socket?.terminate();
    // Socket attachment does not own the external app-server or its processes.
    return this.closing;
  }
  // A Codex app-server with no login still initializes, lists models and starts
  // threads; only the first turn fails (401 after retries). Check the local
  // account first so a signed-out host reports Codex as unavailable up front.
  // account/read reads local credentials without refreshing them. Only an
  // explicit "no account, OpenAI auth required" answer refuses; an older
  // app-server that cannot answer keeps the previous behavior.
  async requireSignedIn() {
    let result: { account?: unknown; requiresOpenaiAuth?: unknown } | undefined;
    try { result = await this.request('account/read', { refreshToken: false }); }
    catch (error) {
      // Behavior is unchanged (the launch continues), but leave a trace so a
      // slow or failing Codex app-server is visible in the service log (#106).
      console.error('foreman: Codex account/read failed; continuing without the sign-in check:', String((error as Error)?.message ?? error).slice(0, 300));
      return;
    }
    if (result?.account === null && result?.requiresOpenaiAuth === true) {
      throw new Error('Codex is not signed in on this host, so Codex sessions are unavailable. Sign in with `codex login` using the CODEX_HOME this Foreman uses, then try again.');
    }
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
    const result = await this.request<{ thread: CodexThread; approvalPolicy: string; sandbox: { type: string; networkAccess?: boolean } }>('thread/start', {
      ...extra, cwd, ...codexPolicy(mode), approvalsReviewer: 'user',
      // Native has a concrete Codex mapping; user configuration must not silently enable egress.
      ...(mode === 'native' ? { config: { 'sandbox_workspace_write.network_access': false } } : {}),
    });
    const expectedSandbox = mode === 'bypass' ? 'dangerFullAccess' : 'workspaceWrite';
    if (result.approvalPolicy !== codexPolicy(mode).approvalPolicy || result.sandbox?.type !== expectedSandbox ||
        (mode === 'native' && result.sandbox.networkAccess !== false)) {
      throw new Error('Codex did not apply the requested native mode; session was not activated');
    }
    this.attached.add(result.thread.id);
    this.setActive(this.turns.size > 0);
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
    if (this.interrupting.has(threadId)) throw new Error('Session interruption is still cleaning up');
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
    if (this.interrupting.has(threadId)) throw new Error('Session interruption is still cleaning up');
    if (!text.trim() || text.length > 100_000) throw new Error('Message must contain 1–100000 characters');
    return this.request('thread/queue/add', { threadId, input: [{ type: 'text', text }], clientUserMessageId: messageId });
  }
  interrupt(threadId: string) {
    this.requireAttached(threadId);
    const prior = this.interrupting.get(threadId); if (prior) return prior;
    const turnId = this.turns.get(threadId);
    if (!turnId) throw new Error('No known active turn');
    this.interrupted.add(turnId);
    for (const [id, request] of this.requests) if (request.params.threadId === threadId) this.requests.delete(id);
    const operation = (async () => {
      try {
        const result = await this.request('turn/interrupt', { threadId, turnId });
        await this.request('thread/backgroundTerminals/clean', { threadId });
        return result;
      } catch (error) { await this.close(); throw error; }
      finally { this.interrupting.delete(threadId); }
    })();
    this.interrupting.set(threadId, operation);
    return operation;
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
    // Forward only the decision/answers, never caller-supplied permission amendments.
    const response = request.method === 'item/tool/requestUserInput' ? { answers: result.answers } : { decision: result.decision };
    this.write({ id, result: response }); this.requests.delete(id);
  }
}
