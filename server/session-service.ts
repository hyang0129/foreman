import { ProjectRegistry, readableDirectory } from './projects.ts';
import { permissionMode, type PermissionMode } from './permission-policy.ts';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeControl, type ClaudeReceipt } from './claude-control.ts';
import { normalizeModel } from './models.ts';
import { CodexControl } from './codex-control.ts';
import { Fleet, transcriptTail, type Session } from './fleet.ts';
import { CLAUDE_BIN, FOREMAN_HOME, HOST } from './paths.ts';

export type Source = 'user' | { sender: string; chain: string[] };
export interface Receipt { id: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'uncertain'; text: string; at: string; error?: string; source: Source }
export interface History { id: string; role: 'user' | 'assistant' | 'system' | 'tool'; text: string; at: string; source?: Source }
export interface Approval { id: string; kind: 'permission' | 'question' | 'unsupported'; tool: string; input: Record<string, any>; reason?: string; questions?: { id: string; question: string; options?: string[] }[] }
export type SessionRow = Session & { managed: boolean; model?: string; project_name?: string; capabilities: { message: boolean; interrupt: boolean; approvals: boolean }; control_reason?: string };
interface RecordData { version: 1; creation: { id: string; provider: string; name: string; cwd: string; text: string; model?: string; permission_mode?: PermissionMode; project_reference?: string }; session: SessionRow; history: History[]; receipts: Receipt[] }
export interface ProviderSetup {
  claude?: Pick<ConstructorParameters<typeof ClaudeControl>[0], 'mcpServers' | 'allowedTools' | 'systemPrompt'>;
  codexArgs?: string[];
  codexTools?: { dynamicTools: any[]; developerInstructions?: string; call: (name: string, args: any) => Promise<any> };
  cleanup?: () => void;
}
interface Runtime { claude?: ClaudeControl; codex?: CodexControl; ready: boolean; stopped?: boolean; active?: string; turn?: string; dispatching: boolean; interrupting?: boolean; setup?: ProviderSetup }
interface Options { home?: string; projects?: ProjectRegistry; fleet?: Fleet; claudeFactory?: (options: ConstructorParameters<typeof ClaudeControl>[0]) => ClaudeControl; codexFactory?: (options: ConstructorParameters<typeof CodexControl>[0]) => CodexControl; prepare?: (session: SessionRow) => ProviderSetup | Promise<ProviderSetup> }
const now = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
function bounded<T extends { text: string }>(items: T[], bytes = 180000): T[] {
  const output: T[] = [];
  for (let i = items.length - 1; i >= 0 && output.length < 200 && bytes > 0; i--) {
    const item = clone(items[i]); item.text = item.text.slice(-Math.min(bytes, 32000)); bytes -= Buffer.byteLength(item.text);
    output.unshift(item);
  }
  return output;
}
const textValue = (value: unknown, name: string, limit: number) => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit) throw new Error(`${name} must contain 1–${limit} bytes`);
  return value;
};

/** Durable local inbox. Save before executing, and never replay after uncertain delivery. */
export class SessionService extends EventEmitter {
  private records = new Map<string, RecordData>();
  private runtime = new Map<string, Runtime>();
  private directory: string;
  private options: Options;
  private closed = false;
  private lockPath: string;
  private lockValue = JSON.stringify({ pid: process.pid, token: randomUUID() });
  constructor(options: Options = {}) {
    super(); this.options = options;
    this.directory = join(options.home ?? FOREMAN_HOME, 'managed');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.lockPath = join(this.directory, '.owner');
    try { writeFileSync(this.lockPath, this.lockValue, { flag: 'wx', mode: 0o600 }); }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      const reclaim = `${this.lockPath}.reclaim`;
      mkdirSync(reclaim, { mode: 0o700 });
      try {
        const owner = JSON.parse(readFileSync(this.lockPath, 'utf8'));
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid session storage lock');
        try { process.kill(owner.pid, 0); throw new Error('Another Foreman process owns this session storage'); }
        catch (error: any) { if (error.code !== 'ESRCH') throw error; }
        unlinkSync(this.lockPath); writeFileSync(this.lockPath, this.lockValue, { flag: 'wx', mode: 0o600 });
      } finally { rmdirSync(reclaim); }
    }
    try {
    for (const file of readdirSync(this.directory).filter((name) => /^[a-f0-9-]+\.json$/.test(name))) {
      const data: RecordData = JSON.parse(readFileSync(join(this.directory, file), 'utf8'));
      if (data.version !== 1 || data.session.session_key !== `fm:${file.slice(0, -5)}`) throw new Error(`Invalid managed session file: ${file}`);
      for (const receipt of data.receipts) if (['queued', 'running'].includes(receipt.status)) { receipt.status = 'uncertain'; receipt.error = 'Foreman restarted; delivery cannot be confirmed. Message was not replayed.'; }
      data.session.state = 'unknown'; data.session.alive = false;
      data.session.control_reason = 'Foreman restarted. History is retained; start a new session to continue safely.';
      this.records.set(data.session.session_key, data); this.save(data);
    }
    } catch (error) { this.releaseLock(); throw error; }
  }
  private releaseLock() {
    try { if (readFileSync(this.lockPath, 'utf8') === this.lockValue) unlinkSync(this.lockPath); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  setPrepare(prepare: Options['prepare']) { this.options.prepare = prepare; }
  private save(data: RecordData) {
    const path = join(this.directory, `${data.session.session_key.slice(3)}.json`);
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { flag: 'wx', mode: 0o600 }); renameSync(tmp, path);
  }
  private changed(data: RecordData) { data.session.updated_at = now(); this.save(data); this.emit('session', { id: data.session.session_key }); this.emit('change', this.list()); }
  private row(data: RecordData): SessionRow {
    const runtime = this.runtime.get(data.session.session_key);
    const available = !!runtime?.ready && !this.closed;
    return { ...clone(data.session), ...(this.options.projects?.forPath(data.session.cwd) ? { project_name: this.options.projects.forPath(data.session.cwd)!.name } : {}), capabilities: { message: available, interrupt: available && !!runtime?.active, approvals: available } };
  }
  list(): SessionRow[] {
    const managed = [...this.records.values()].map((data) => this.row(data));
    const nativeKeys = new Set(managed.filter((s) => s.session_id).map((s) => `${s.provider}:${s.session_id}`));
    const observed = (this.options.fleet?.list() ?? []).filter((s) => !nativeKeys.has(s.session_key)).map((s) => ({ ...clone(s), ...(this.options.projects?.forPath(s.cwd) ? { project_name: this.options.projects.forPath(s.cwd)!.name } : {}), managed: false, capabilities: { message: false, interrupt: false, approvals: false }, control_reason: 'Observed session; Foreman does not own its input connection.' }));
    return [...managed, ...observed].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  }
  detail(id: string) {
    const data = this.records.get(id);
    if (data) return { session: this.row(data), history: bounded(data.history), receipts: bounded(data.receipts), approvals: this.approvals(id) };
    const session = this.list().find((s) => s.session_key === id);
    if (!session) throw new Error('No such session');
    let text = '(no transcript available)';
    try { text = transcriptTail(session.transcript_path, 30, session.provider); } catch { text = '(transcript unavailable)'; }
    return { session, history: [{ id: 'observed-tail', role: 'system' as const, text, at: session.updated_at ?? now() }], receipts: [] as Receipt[], approvals: [] as Approval[] };
  }
  receipt(id: string, messageId: string) { const result = this.records.get(id)?.receipts.find((r) => r.id === messageId); if (!result) throw new Error('No such receipt'); return clone(result); }
  activeSource(id: string): Source { const runtime = this.runtime.get(id); return clone(this.records.get(id)?.receipts.find((r) => r.id === runtime?.active)?.source ?? 'user'); }
  async create(input: { id: string; provider: 'claude' | 'codex'; name?: string; cwd: string; text: string; model?: string; permission_mode?: PermissionMode }) {
    if (this.closed) throw new Error('Session service is closed');
    const id = textValue(input.id, 'Creation id', 200);
    if (!['claude', 'codex'].includes(input.provider)) throw new Error('Unsupported provider');
    const cwdInput = textValue(input.cwd, 'Project directory', 4096);
    const previous = [...this.records.values()].find((data) => data.creation.id === id);
    // A durable retry retains its project identity even after a registry rename/removal.
    const resolution = previous && (cwdInput === previous.creation.project_reference || cwdInput === previous.creation.cwd)
      ? { path: previous.creation.cwd } : this.options.projects?.require(cwdInput);
    const cwd = resolution?.path ?? readableDirectory(cwdInput), text = textValue(input.text, 'Message', 64 * 1024);
    const name = input.name === undefined || input.name === '' ? `${input.provider} session` : textValue(input.name, 'Name', 200);
    const model = normalizeModel(input.model);
    const policy = permissionMode(input.permission_mode);
    const creation = { id, provider: input.provider, name, cwd, text, ...(model ? { model } : {}), permission_mode: policy };
    if (previous) { const { project_reference, ...original } = previous.creation; if (JSON.stringify(original) !== JSON.stringify(creation)) throw new Error('Creation id was already used for different input'); return this.row(previous); }
    if (this.records.size >= 500) throw new Error('Session limit reached');
    const key = `fm:${randomUUID()}`;
    const session: SessionRow = { session_key: key, session_id: '', provider: input.provider, name, cwd, ...(model ? { model } : {}), state: 'working', reason: 'starting', kind: 'sdk', entrypoint: 'foreman', pid: null, alive: false, tracked: true, current_tool: null, active_subagents: 0, last_message: null, last_error: null, started_at: now(), updated_at: now(), ended_at: null, end_reason: null, permission_mode: policy, bg_id: null, bg_state: null, bg_waiting_for: null, host: HOST, transcript_path: null, managed: true, capabilities: { message: false, interrupt: false, approvals: false } };
    const receipt: Receipt = { id, status: 'queued', text, at: now(), source: 'user' };
    const data: RecordData = { version: 1, creation: { ...creation, project_reference: cwdInput }, session, receipts: [receipt], history: [{ id, role: 'user', text, at: receipt.at, source: 'user' }] };
    this.options.projects?.used(cwd);
    this.save(data); this.records.set(key, data);
    const runtime: Runtime = { ready: false, dispatching: false }; this.runtime.set(key, runtime); this.changed(data);
    // Launch independently: creation is durably accepted before slow provider startup.
    void this.launch(data, runtime, resolution && 'project' in resolution ? resolution.project : undefined);
    return this.row(data);
  }
  send(id: string, text: string, messageId: string, source: Source = 'user'): Receipt {
    textValue(messageId, 'Message id', 200); textValue(text, 'Message', 64 * 1024);
    const data = this.records.get(id); if (!data) throw new Error('Session is monitor-only or unavailable');
    const existing = data.receipts.find((r) => r.id === messageId);
    if (existing) { if (existing.text !== text || JSON.stringify(existing.source) !== JSON.stringify(source)) throw new Error('Message id was already used for different input'); return clone(existing); }
    const runtime = this.runtime.get(id);
    if (!runtime?.ready || this.closed) throw new Error(data.session.control_reason ?? 'Session is not ready');
    if (runtime.interrupting) throw new Error('Session interruption is still cleaning up');
    if (data.receipts.filter((r) => ['queued', 'running'].includes(r.status)).length >= 100 || data.receipts.length >= 10000) throw new Error('Session queue or receipt limit reached');
    const receipt: Receipt = { id: messageId, status: 'queued', text, at: now(), source: clone(source) };
    data.receipts.push(receipt); data.history.push({ id: messageId, role: 'user', text, at: receipt.at, source: clone(source) });
    this.changed(data); void this.dispatch(data, runtime); return clone(receipt);
  }
  private async launch(data: RecordData, runtime: Runtime, project?: { path: string; canonicalPath: string; registeredPaths?: string[] }) {
    try {
      runtime.setup = await this.options.prepare?.(this.row(data));
      if (this.closed) { runtime.setup?.cleanup?.(); return; }
      for (const path of project?.registeredPaths ?? [project?.path ?? data.session.cwd!]) readableDirectory(path, project?.canonicalPath ?? data.session.cwd!);
      if (data.session.provider === 'claude') {
        const control = (this.options.claudeFactory ?? ((options) => new ClaudeControl(options)))({ cwd: data.session.cwd!, pathToClaudeCodeExecutable: CLAUDE_BIN, settingSources: ['user', 'project'], ...runtime.setup?.claude, permission_mode: permissionMode(data.creation.permission_mode), ...(data.session.model ? { model: data.session.model } : {}) });
        runtime.claude = control;
        control.on('receipt', (receipt: ClaudeReceipt) => {
          const stored = data.receipts.find((r) => r.id === receipt.id); if (!stored || this.closed) return;
          if (['completed', 'failed'].includes(receipt.status)) this.complete(data, runtime, receipt.status as 'completed' | 'failed', receipt.error);
        });
        control.on('message', (message: any) => {
          if (this.closed) return;
          if (message.session_id) data.session.session_id = message.session_id;
          if (message.type === 'assistant') {
            const text = (message.message?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
            if (text) this.history(data, `claude:${message.uuid ?? randomUUID()}`, 'assistant', text);
          }
          this.changed(data);
        });
        control.on('state', (state: string) => {
          if (this.closed) return;
          if (state === 'failed' || state === 'closed') { this.unavailable(data, runtime, 'Claude process ended'); return; }
          data.session.state = state === 'input-needed' ? 'needs_input' : runtime.active ? 'working' : 'idle'; this.changed(data);
        });
        control.on('approval', () => this.changed(data));
      } else {
        const control = (this.options.codexFactory ?? ((options) => new CodexControl(options)))({ cwd: data.session.cwd!, args: runtime.setup?.codexArgs });
        runtime.codex = control;
        control.on('disconnect', () => { if (!this.closed) this.unavailable(data, runtime, 'Codex disconnected; delivery may be uncertain'); });
        control.on('notification', (event: any) => this.codexEvent(data, runtime, event));
        control.on('request', (request: any) => {
          if (request.method === 'item/tool/call') {
            const tools = runtime.setup?.codexTools;
            if (!tools || request.params.threadId !== data.session.session_id || request.params.namespace) {
              control.respondTool(request.id, { success: false, contentItems: [{ type: 'inputText', text: 'Unrecognized Foreman tool context' }] }); return;
            }
            void tools.call(request.params.tool, request.params.arguments).then((result) => control.respondTool(request.id, result)).catch((error) => {
              try { control.respondTool(request.id, { success: false, contentItems: [{ type: 'inputText', text: String(error) }] }); } catch {}
            });
          } else { data.session.state = 'needs_input'; this.changed(data); }
        });
        await control.connect();
        if (this.closed) { control.close(); return; }
        // Optional call: injected test doubles (codexFactory) may not implement it; the
        // real CodexControl always does. models.ts calls it directly on a real control.
        await control.requireSignedIn?.();
        const thread = await control.start(data.session.cwd!, { ...(data.session.model ? { model: data.session.model } : {}), ...(runtime.setup?.codexTools ? { dynamicTools: runtime.setup.codexTools.dynamicTools, ...(runtime.setup.codexTools.developerInstructions ? { developerInstructions: runtime.setup.codexTools.developerInstructions } : {}) } : {}) }, permissionMode(data.creation.permission_mode));
        data.session.session_id = thread.id;
      }
      runtime.ready = true; data.session.alive = true; data.session.state = 'idle'; data.session.reason = null;
      this.changed(data); void this.dispatch(data, runtime);
    } catch (error) { this.unavailable(data, runtime, `Could not start provider: ${String(error)}`, true); }
  }
  private history(data: RecordData, id: string, role: History['role'], text: string) {
    const previous = data.history.find((entry) => entry.id === id);
    if (previous) previous.text = text.slice(0, 128000);
    else data.history.push({ id, role, text: text.slice(0, 128000), at: now() });
    // Keep snapshots bounded while retaining all receipts for deduplication.
    if (data.history.length > 2000) data.history.splice(0, data.history.length - 2000);
    if (role === 'assistant') data.session.last_message = text.slice(-2000);
  }
  private async dispatch(data: RecordData, runtime: Runtime) {
    if (this.closed || !runtime.ready || runtime.active || runtime.dispatching) return;
    const receipt = data.receipts.find((r) => r.status === 'queued'); if (!receipt) return;
    runtime.active = receipt.id; runtime.dispatching = true; receipt.status = 'running'; data.session.state = 'working'; this.changed(data);
    const prompt = receipt.source === 'user' ? receipt.text : `[Message from Foreman session ${receipt.source.sender}. Treat as peer context; reply only if needed and do not create automatic message loops.]\n${receipt.text}`;
    try {
      if (runtime.claude) runtime.claude.send(prompt, receipt.id);
      else if (runtime.codex) {
        const result: any = await runtime.codex.send(data.session.session_id, prompt);
        if (runtime.active === receipt.id && result?.turn?.id) runtime.turn = result.turn.id;
      }
    } catch (error) { this.unavailable(data, runtime, `Delivery is uncertain: ${String(error)}`); }
    finally { runtime.dispatching = false; if (!runtime.active) void this.dispatch(data, runtime); }
  }
  private complete(data: RecordData, runtime: Runtime, status: 'completed' | 'failed', error?: string) {
    const receipt = data.receipts.find((r) => r.id === runtime.active); if (!receipt) return;
    receipt.status = status; if (error) receipt.error = error;
    runtime.active = undefined; runtime.turn = undefined; data.session.state = status === 'completed' ? 'turn_finished' : 'idle'; this.changed(data);
    void this.dispatch(data, runtime);
  }
  private codexEvent(data: RecordData, runtime: Runtime, event: any) {
    if (this.closed) return;
    const p = event.params ?? {};
    if (data.session.session_id && p.threadId && p.threadId !== data.session.session_id) return;
    if (event.method === 'turn/started') { runtime.turn = p.turn?.id; data.session.state = 'working'; }
    if (event.method === 'serverRequest/resolved' && !runtime.codex?.pendingRequests().length) data.session.state = runtime.active ? 'working' : 'idle';
    if (event.method === 'item/completed' && p.item?.type === 'agentMessage') this.history(data, `codex:${p.item.id}`, 'assistant', p.item.text ?? '');
    if (event.method === 'item/completed' && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(p.item?.type)) this.history(data, `codex:${p.item.id}`, 'tool', `${p.item.type}: ${p.item.command ?? p.item.tool ?? ''} (${p.item.status ?? 'completed'})`);
    if (event.method === 'turn/completed' && runtime.turn === p.turn?.id) {
      this.complete(data, runtime, p.turn.status === 'completed' ? 'completed' : 'failed', p.turn.error?.message ?? (p.turn.status === 'interrupted' ? 'Interrupted by user' : undefined));
    }
    if (['thread/closed', 'thread/archived'].includes(event.method) || (event.method === 'thread/status/changed' && p.status?.type === 'notLoaded')) this.unavailable(data, runtime, 'Codex thread closed');
    this.changed(data);
  }
  private unavailable(data: RecordData, runtime: Runtime, reason: string, definite = false) {
    if (runtime.stopped) return;
    runtime.stopped = true;
    runtime.ready = false; runtime.active = undefined; runtime.turn = undefined;
    data.session.alive = false; data.session.state = 'unknown'; data.session.control_reason = reason; data.session.last_error = reason;
    for (const receipt of data.receipts) if (['running', 'queued'].includes(receipt.status)) { receipt.status = definite ? 'failed' : 'uncertain'; receipt.error = reason; }
    this.changed(data);
    runtime.claude?.close(); runtime.codex?.close();
  }
  /** Pending approvals of a managed session (copies), without copying its history or receipts as `detail()` does. [] for an unknown, observed, not-ready or closed session. */
  approvals(id: string): Approval[] {
    const runtime = this.runtime.get(id); if (!runtime?.ready || this.closed) return [];
    if (runtime.claude) return runtime.claude.pendingApprovals().map((r) => ({ id: r.id, kind: r.tool === 'AskUserQuestion' ? 'question' : 'permission', tool: r.tool, input: clone(r.input), reason: r.reason,
      ...(r.tool === 'AskUserQuestion' ? { questions: (Array.isArray(r.input.questions) ? r.input.questions : []).map((q: any) => ({ id: q.question, question: q.question, options: q.options?.map((o: any) => o.label) })) } : {}) }));
    return (runtime.codex?.pendingRequests() ?? []).filter((r) => r.method !== 'item/tool/call').map((r) => ({ id: String(r.id), kind: r.method === 'item/tool/requestUserInput' ? 'question' : ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(r.method) ? 'permission' : 'unsupported', tool: r.method, input: clone(r.params), reason: typeof r.params.reason === 'string' ? r.params.reason : undefined,
      ...(r.method === 'item/tool/requestUserInput' ? { questions: (Array.isArray(r.params.questions) ? r.params.questions : []).map((q: any) => ({ id: q.id, question: q.question, options: q.options?.map((o: any) => o.label) })) } : {}) }));
  }
  async approve(id: string, approvalId: string, decision: 'allow' | 'deny', answers?: Record<string, string>) {
    if (!['allow', 'deny'].includes(decision)) throw new Error('Decision must be allow or deny');
    const approval = this.approvals(id).find((r) => r.id === approvalId); if (!approval) throw new Error('Approval is no longer pending');
    if (approval.kind === 'unsupported') throw new Error('This provider request is not supported; interrupt the session');
    if (approval.kind === 'question' && decision === 'allow') {
      for (const question of approval.questions ?? []) textValue(answers?.[question.id], 'Answer', 8000);
    }
    const runtime = this.runtime.get(id)!;
    if (runtime.claude) {
      if (!runtime.claude.respondApproval(approvalId, decision, approval.kind === 'question' && decision === 'allow' ? { ...approval.input, answers } : undefined)) throw new Error('Approval is no longer pending');
    } else if (runtime.codex) {
      const request = runtime.codex.pendingRequests().find((r) => String(r.id) === approvalId); if (!request) throw new Error('Approval is no longer pending');
      runtime.codex.respond(request.id, approval.kind === 'question' ? { answers: decision === 'deny' ? {} : Object.fromEntries(Object.entries(answers ?? {}).map(([key, value]) => [key, { answers: [value] }])) } : { decision: decision === 'allow' ? 'accept' : 'decline' });
    }
    const data = this.records.get(id)!; data.session.state = runtime.active ? 'working' : 'idle'; this.changed(data);
  }
  async interrupt(id: string) {
    const runtime = this.runtime.get(id); if (!runtime?.ready || !runtime.active) throw new Error('No active managed turn');
    if (runtime.interrupting) throw new Error('Session interruption is still cleaning up');
    runtime.interrupting = true;
    const data = this.records.get(id)!;
    // Explicit stop cancels follow-ups too; never start queued work immediately after stop.
    for (const receipt of data.receipts) if (receipt.status === 'queued') { receipt.status = 'failed'; receipt.error = 'Cancelled by user interruption'; }
    this.changed(data);
    try {
      if (runtime.claude) await runtime.claude.interrupt(); else await runtime.codex!.interrupt(data.session.session_id);
    } finally { runtime.interrupting = false; }
  }
  private finished = Promise.resolve();
  close() {
    if (this.closed) return this.finished;
    this.closed = true;
    const closing: Promise<unknown>[] = [];
    for (const [id, runtime] of this.runtime) {
      this.unavailable(this.records.get(id)!, runtime, 'Foreman stopped; pending delivery is uncertain');
      runtime.claude?.close();
      if (runtime.codex) closing.push(Promise.resolve(runtime.codex.close()));
      runtime.setup?.cleanup?.();
    }
    this.releaseLock();
    this.finished = Promise.all(closing).then(() => {});
    return this.finished;
  }
}
