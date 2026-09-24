// The project manager: one long-lived Claude Agent SDK session in streaming-input mode.
// Tool access is enforced here (canUseTool), not just prompted.
import { query, type SDKUserMessage, type Query, type HookCallback, type TerminalReason } from "@anthropic-ai/claude-agent-sdk";
import { normalizeModel } from "./models.ts";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, existsSync, appendFileSync, realpathSync, statSync, renameSync } from "node:fs";
import { join, resolve, sep, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { Fleet } from "./fleet.ts";
import { makeFleetServer, type ManagedFleetService } from "./tools.ts";
import { makePeerMcpServer, PEER_ALLOWED_TOOLS, PEER_INSTRUCTIONS } from "./peer-tools.ts";
import { FOREMAN_HOME, MEMORY_DIR, PM_SESSION_FILE, PM_HISTORY_FILE, REPO_ROOT } from "./paths.ts";

export type PmEvent =
  | { type: "turn_start"; ts: string }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; summary: string }
  | { type: "assistant_text"; text: string }
  | { type: "turn_end"; ts: string; cost_usd: number; is_error: boolean; subtype: string }
  | { type: "status"; text: string }
  | { type: "peer"; text: string };

const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$|^(readme|changelog|contributing|license|todo|roadmap)$/i;

const home = homedir();
const under = (p: string, dir: string) => { const a = resolve(p); const d = resolve(dir); return a === d || a.startsWith(d + sep); };
const expand = (p: string) => (p === '~' ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);
const canonical = (p: string) => realpathSync(resolve(FOREMAN_HOME, p));
function memoryWritePath(p: string): boolean {
  try {
    const target = resolve(FOREMAN_HOME, p);
    if (existsSync(target)) return under(canonical(target), canonical(MEMORY_DIR));
    // Check the nearest existing parent too, so a symlink cannot escape the memory directory.
    let parent = dirname(target);
    while (!existsSync(parent) && parent !== dirname(parent)) parent = dirname(parent);
    return under(target, MEMORY_DIR) && under(canonical(parent), canonical(MEMORY_DIR));
  } catch { return false; }
}

// The SDK's own abort reasons. Typed against the installed SDK so a typo or an SDK rename
// fails `npm run typecheck` instead of silently turning a Stop into a failure (or vice versa).
const SDK_ABORT_REASONS = ['aborted_streaming', 'aborted_tools'] as const satisfies readonly TerminalReason[];
const isAbortReason = (reason: unknown): boolean => (SDK_ABORT_REASONS as readonly unknown[]).includes(reason);
// Resume-handle rejections, deliberately narrow. Only diagnostics that name the saved resume
// handle itself as unusable count; auth, spawn (ENOENT), network and every other provider error
// never match, so they never quarantine a session. (A bare "session ... not found" is not used:
// the CLI emits "Session not found" for MCP HTTP transports and remote agents too.)
// - MISSING_CONVERSATION: the CLI's `--resume` message when the transcript for that id is gone
//   ("No conversation found with session ID: <id>"). A fresh run can take over the input.
// - INVALID_RESUME_HANDLE: the provider rejected the handle as malformed/unusable.
const MISSING_CONVERSATION = /\bno conversation found with session id\b/i;
const INVALID_RESUME_HANDLE = /\binvalid resume handle\b/i;
// Abandoned session ids are moved here, never deleted: one JSON line per quarantine,
// `{ ts, session_id, reason }`, with the provider diagnostic truncated.
const PM_SESSION_QUARANTINE_FILE = `${PM_SESSION_FILE}.quarantine.jsonl`;
// The diagnostic an error result carries: primarily the text the SDK's exit echo uses (errors[]
// for an error subtype, `result` for an is_error success). Unlike the SDK, it falls back to the
// other field when the primary one is empty; the echo then differs, so it never suppresses one.
const resultDiagnostic = (m: any): string => {
  const errors = Array.isArray(m.errors) ? m.errors.map((e: unknown) => String(e).trim()).filter(Boolean).join('; ') : '';
  const result = typeof m.result === 'string' ? m.result : '';
  return (m.subtype === 'success' ? result || errors : errors || result);
};
const errorText = (error: unknown): string => String((error as any)?.message ?? error);
// When the CLI exits after an error result, the SDK throws this echo of the result's diagnostic.
const sdkErrorResultEcho = (diagnostic: string) => `Claude Code returned an error result: ${diagnostic}`;

class Inbox {
  delivered = 0;
  private q: SDKUserMessage[] = [];
  private waiters: (() => void)[] = [];
  private generation = 0;
  push(text: string, sessionId: string) {
    this.q.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: sessionId } as SDKUserMessage);
    this.notify();
  }
  private notify() { const waiters = this.waiters; this.waiters = []; for (const wake of waiters) wake(); }
  // Opening a stream retires every earlier stream at once, so an abandoned provider attempt
  // (e.g. a rejected resume) can never consume input meant for its replacement. `taken`
  // records every message this stream handed to its reader (the SDK reads it eagerly).
  open(): { prompt: AsyncGenerator<SDKUserMessage>; taken: SDKUserMessage[] } {
    const generation = ++this.generation;
    this.notify();
    const inbox = this, taken: SDKUserMessage[] = [];
    const prompt = (async function* () {
      while (generation === inbox.generation) {
        if (inbox.q.length) { const message = inbox.q.shift()!; taken.push(message); inbox.delivered++; yield message; continue; }
        await new Promise<void>((r) => inbox.waiters.push(r));
      }
    })();
    return { prompt, taken };
  }
  // End every open stream: a reader parked on it wakes and its stream completes.
  retire() { this.generation++; this.notify(); }
  // Hand back input a stream took but its provider never processed, ahead of anything queued
  // after it. The stream is retired first so it cannot take the input again.
  requeue(taken: SDKUserMessage[]) {
    this.retire();
    const returned = taken.splice(0);
    this.q.unshift(...returned);
    this.delivered -= returned.length;
  }
}

export class ProjectManager extends EventEmitter {
  private inbox = new Inbox();
  private q: Query | null = null;
  private queryFactory = query;
  lastError: string | null = null;
  sessionId: string | null = null;
  busy = false;
  tools: string[] = [];
  private running = false;
  private closed = false;
  // Cancellation is bound to a turn: `dispatched` counts inputs accepted by send(), and an
  // interrupt remembers the count it was raised at, so any later input invalidates it.
  private dispatched = 0;
  private interruptedAt: number | null = null;
  // Set when the still-running provider rejected a turn; the next explicit send restarts it.
  private providerFailed = false;
  // Each start() owns one generation; a retired run must not touch shared state.
  private generation = 0;
  private reconciled = false;
  private pendingTurns = 0;
  private changingModel = false;
  // A provider launch that threw synchronously (spawn ENOENT, unreadable prompt) while send()
  // was starting it: send() rejects with this cause instead of accepting input no run can read.
  private launchFailure: string | null = null;
  // Session ids quarantined by this process. Never resumed again, even when clearing the active
  // session file failed and it still names one, so the next explicit send starts fresh.
  private quarantinedIds = new Set<string>();
  model: string | undefined;
  private settingsPath: string;
  get modelBusy() { return this.busy || this.pendingTurns > 0 || this.changingModel; }

  private fleet: Fleet;
  private sessions?: ManagedFleetService;
  constructor(fleet: Fleet, sessions?: ManagedFleetService, settingsPath = join(FOREMAN_HOME, 'pm', 'settings.json')) {
    super(); this.fleet = fleet; this.sessions = sessions; this.settingsPath = settingsPath;
    this.model = normalizeModel(existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')).model : process.env.FOREMAN_PM_MODEL);
  }
  async setModel(value: unknown) {
    const model = normalizeModel(value);
    if (this.modelBusy) throw new Error('Wait for the project manager to finish before changing its model');
    if (this.closed) throw this.unavailable(' (closed)');
    const q = this.q;
    if (!q || !this.running) throw this.unavailable();
    this.changingModel = true;
    const previous = this.model;
    try {
      await q.setModel(model);
      try {
        const tmp = `${this.settingsPath}.${randomUUID()}.tmp`;
        writeFileSync(tmp, JSON.stringify({ model: model ?? null }), { flag: 'wx', mode: 0o600 });
        renameSync(tmp, this.settingsPath);
        this.model = model;
      } catch (error) {
        // If persistence fails, restore the previous live selection before accepting more messages.
        try { await q.setModel(previous); }
        catch (restoreError) {
          // The live model no longer matches the saved one, so the PM closes. Keep both causes
          // as the PM's error, so this rejection and every later one carries them.
          const reason = `the model change could not be saved (${errorText(error).slice(0, 600)}) and restoring the previous model failed (${errorText(restoreError).slice(0, 600)})`;
          this.fail(reason, 'The project manager was closed so it does not run with an unsaved model; restart Foreman to recover.');
          this.close();
          throw new Error(this.lastError!);
        }
        throw error;
      }
    } finally { this.changingModel = false; }
  }

  history(): any[] {
    if (!existsSync(PM_HISTORY_FILE)) return [];
    return readFileSync(PM_HISTORY_FILE, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-200);
  }
  private record(entry: any) { appendFileSync(PM_HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"); }
  // Reporting (history appends and 'event' listeners) must never replace a provider cause or
  // skip lifecycle state: EventEmitter.emit rethrows a listener's exception synchronously, and
  // an append can fail on the filesystem. Each report runs once; a failure is logged on its own.
  private report(kind: 'history' | 'event', detail: string, action: () => void) {
    try { action(); }
    catch (error: any) { console.error('foreman: pm reporting failed', JSON.stringify({ kind, detail, error: String(error?.message ?? error).slice(0, 500) })); }
  }
  private reportRecord(entry: any) { this.report('history', String(entry.role), () => this.record(entry)); }
  private emitEvent(event: PmEvent) { this.report('event', event.type, () => this.emit("event", event)); }

  // A rejection that carries the PM's current error, so the caller never gets only generic text.
  private unavailable(detail = '') { return new Error(`Project manager is unavailable${detail}${this.lastError ? `: ${this.lastError}` : ''}`); }
  private static failureText(reason: string, next = 'Your message was not completed; after resolving the error, send a new message to retry. Failed messages are not replayed.') {
    return `Project manager failed: ${reason.slice(0, 1500)}. ${next}`;
  }
  private fail(reason: string, next?: string) {
    const text = ProjectManager.failureText(reason, next);
    const duplicateRejection = this.inbox.delivered === 0 && this.lastError === text;
    this.lastError = text;
    console.error('foreman: pm failure', JSON.stringify({ session_id: this.sessionId, pending_turns: this.pendingTurns, error: reason.slice(0, 1500) }));
    if (!duplicateRejection) {
      this.reportRecord({ role: "system", text, error: true });
      this.emitEvent({ type: "status", text });
    }
  }

  // Stop resuming a saved session the provider rejected by handle: record the id and the
  // diagnostic in the quarantine file (evidence is kept), then clear the active session file so
  // the next start runs fresh. A failed record is logged with the id instead of masking the
  // provider error, and the session file is still cleared so the PM can heal.
  private quarantine(sessionId: string, reason: string) {
    const entry = { ts: new Date().toISOString(), session_id: sessionId, reason: reason.slice(0, 1500) };
    try { appendFileSync(PM_SESSION_QUARANTINE_FILE, JSON.stringify(entry) + "\n", { mode: 0o600 }); }
    catch (error: any) { console.error('foreman: pm session quarantine record failed', JSON.stringify({ ...entry, error: String(error?.message ?? error) })); }
    // Remembered in memory first, so the id is never resumed again even if the clear below fails.
    this.quarantinedIds.add(sessionId);
    // Clearing the active file can fail too; the provider's error stays the cause either way.
    try { writeFileSync(PM_SESSION_FILE, ""); }
    catch (error: any) { console.error('foreman: pm session quarantine clear failed', JSON.stringify({ ...entry, error: String(error?.message ?? error) })); }
    if (this.sessionId === sessionId) this.sessionId = null;
  }

  private reconcileHistory() {
    if (this.reconciled) return;
    this.reconciled = true;
    const last = this.history().reverse().find((entry) => ['user', 'assistant', 'system'].includes(entry.role));
    if (last?.role === 'user' && last.delivery !== 'rejected') {
      const text = 'Foreman restarted; delivery cannot be confirmed. Message was not replayed.';
      this.lastError = text;
      this.reportRecord({ role: 'system', text, error: true });
      this.emitEvent({ type: 'status', text });
    }
  }

  send(text: string) {
    this.reconcileHistory();
    const rejection = this.dispatchRejection();
    this.record({ role: "user", text, ...(rejection ? { delivery: 'rejected' } : {}) });
    if (rejection) throw rejection;
    this.pendingTurns++;
    this.dispatched++;
    this.inbox.push(text, this.sessionId ?? "");
  }
  // Why new input cannot be dispatched, or null once a provider is running to take it. A
  // rejection carries the specific cause, never only generic text, so the caller receives it.
  private dispatchRejection(): Error | null {
    if (this.changingModel) return new Error('Model change in progress; retry your message');
    if (this.closed) return this.unavailable(' (closed)');
    // Explicit input is the only restart trigger: no automatic replay or retry loop.
    // A provider that rejected a turn but stayed alive is restarted here, once it has settled
    // every turn it accepted, so only this new input reaches the new process.
    if (this.running && this.providerFailed && !this.pendingTurns && !this.busy) this.retire();
    if (!this.running) {
      void this.start();
      // start() launches synchronously; a launch that already threw cannot take this input.
      if (this.launchFailure !== null) return new Error(ProjectManager.failureText(this.launchFailure));
    }
    if (!this.running) return this.unavailable();
    return null;
  }
  async interrupt() {
    if (!this.q || !this.modelBusy) return;
    const token = this.dispatched;
    this.interruptedAt = token;
    try { await this.q.interrupt(); } catch (error) { if (this.interruptedAt === token) this.interruptedAt = null; throw error; }
  }
  // Detach the current run: close its provider and reset per-run state. Its start() keeps
  // unwinding in the background but no longer owns any PM state.
  private retire() {
    const q = this.q;
    this.generation++;
    this.q = null; this.running = false; this.busy = false; this.pendingTurns = 0;
    this.interruptedAt = null; this.providerFailed = false;
    this.inbox.retire(); this.inbox = new Inbox(); // release the old provider's parked input reader
    q?.close();
  }
  close() { this.closed = true; this.q?.close(); this.q = null; }

  private memoryBlock(): string {
    const read = (f: string) => (existsSync(join(MEMORY_DIR, f)) ? readFileSync(join(MEMORY_DIR, f), "utf8").trim() : "(empty)");
    return `\n\n# Memory (from ~/.foreman/memory, read at start)\n\n## PROJECTS.md\n${read("PROJECTS.md")}\n\n## LOG.md (last 40 lines)\n${read("LOG.md").split("\n").slice(-40).join("\n")}\n`;
  }

  private canUseTool = async (name: string, input: Record<string, any>) => {
    const allow = () => ({ behavior: "allow" as const, updatedInput: input });
    const deny = (message: string) => ({ behavior: "deny" as const, message });
    const delegate = "Denied: the project manager does not touch code. Brief a session agent with spawn_session instead.";
    // A model may propose a preset, but only the developer approves an elevated
    // launch. Do not auto-allow this via the broad fleet-tool rule below.
    if (name === 'mcp__fleet__spawn_session' && ['bypass', 'bypassPermissions'].includes(input.permission_mode))
      return deny('Bypass must be launched by the developer in the New session dialog. Propose the settings in your reply; you cannot grant an elevated policy.');
    if (name.startsWith("mcp__fleet__") || PEER_ALLOWED_TOOLS.includes(name) || ["ListAgents", "SendMessage", "WebFetch", "WebSearch", "TodoWrite", "TaskCreate", "TaskList", "TaskUpdate", "TaskGet"].includes(name)) return allow();
    if (name === "Read") {
      const p = expand(String(input.file_path ?? ""));
      if (!p) return deny("Read needs a file_path.");
      try {
        const actual = canonical(p);
        if (!statSync(actual).isFile()) return deny('Read requires an existing document file.');
        if (under(actual, canonical(MEMORY_DIR))) return allow();
        if (under(actual, canonical(FOREMAN_HOME))) return deny('Use session tools for session history. Foreman configuration and credentials are unavailable to the PM.');
        if (DOC_FILE.test(basename(actual))) return allow();
      } catch { return deny('Read requires an existing document file.'); }
      return deny(`${delegate} (Read is limited to document files and PM memory.)`);
    }
    if (name === "Write" || name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") {
      const p = expand(String(input.file_path ?? ""));
      if (p && memoryWritePath(p)) return allow();
      return deny(`${delegate} (Writes are limited to ~/.foreman/memory.)`);
    }
    if (["Bash", "Glob", "Grep"].includes(name)) return deny(`${delegate} (Use the fleet and peer tools to inspect sessions, and Read for a specific document.)`);
    if (name === "Agent") return deny("Denied: no subagents for the PM; spawn a tracked session with spawn_session so the user can see it.");
    return deny(`Denied: ${name} is not available to the project manager.`);
  };

  // Permission callbacks alone can be bypassed by provider defaults or user allow rules.
  // Enforce the PM role before every tool invocation, including auto-approved reads.
  private enforceToolBoundary: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const decision = await this.canUseTool(input.tool_name, (input.tool_input ?? {}) as Record<string, any>);
    return decision.behavior === 'deny'
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.message } }
      : {};
  };

  async start(): Promise<void> {
    if (this.running || this.closed) return;
    this.reconcileHistory();
    this.running = true;
    this.providerFailed = false;
    this.launchFailure = null;
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    const inbox = this.inbox;
    let q: Query | null = null;
    // What the latest provider attempt did: the input its stream handed out, and how many
    // frames the provider emitted. Zero frames means the CLI never processed any input.
    // `reported` is the SDK's error echo of a failed result this attempt already reported, while
    // that result is still the latest frame: the CLI exiting on it must not report it twice.
    type Attempt = { taken: SDKUserMessage[]; frames: number; initialized: boolean; reported?: string };
    let attempt: Attempt = { taken: [], frames: 0, initialized: false };
    // The latest turn failure this start() reported, until a later turn succeeds. A process error
    // or stream end after it is reported together with it, so it never replaces that cause.
    let turnFailure: string | undefined;
    const launch = (resume?: string): { provider: Query; state: Attempt } => {
      try {
        const base = readFileSync(join(REPO_ROOT, "agents", "pm-system-prompt.md"), "utf8");
        const stream = inbox.open();
        const state: Attempt = attempt = { taken: stream.taken, frames: 0, initialized: false };
        const provider: Query = q = this.q = this.queryFactory({
          prompt: stream.prompt,
          options: {
            cwd: FOREMAN_HOME,
            resume,
            systemPrompt: { type: "preset", preset: "claude_code", append: base + this.memoryBlock() + (this.sessions ? '\n\n' + PEER_INSTRUCTIONS + '\nFor Foreman-managed sessions, use peer tools to request updates and read outcomes. Native SendMessage subscriptions apply only to legacy Claude background sessions. You still must not read or edit source code or bypass your PM tool restrictions.' : '') },
            settingSources: ["user"],
            permissionMode: "default",
            canUseTool: this.canUseTool,
            hooks: { PreToolUse: [{ hooks: [this.enforceToolBoundary] }] },
            includePartialMessages: true,
            mcpServers: { fleet: makeFleetServer(this.fleet, this.sessions), ...(this.sessions ? { peers: makePeerMcpServer(this.sessions, 'foreman-pm') } : {}) },
            allowedTools: ["mcp__fleet__list_sessions", "mcp__fleet__list_models", "mcp__fleet__session_tail", "mcp__fleet__log_note", "ListAgents", "WebFetch", "WebSearch", ...(this.sessions ? PEER_ALLOWED_TOOLS : [])],
            disallowedTools: ["Agent", "Bash", "Glob", "Grep"],
            extraArgs: { name: "foreman-pm" },
            maxTurns: 60,
            effort: (process.env.FOREMAN_PM_EFFORT as any) || "medium",
            ...(this.model ? { model: this.model } : {}),
            stderr: (chunk: string) => { if (current() && /error|warn/i.test(chunk)) this.emitEvent({ type: "status", text: chunk.trim().slice(0, 300) }); },
          },
        });
        return { provider, state };
      } catch (error) {
        // Still synchronous with the send() that started this run: that send rejects with it.
        if (current() && !MISSING_CONVERSATION.test(errorText(error))) this.launchFailure = errorText(error);
        throw error;
      }
    };
    const run = async (resume?: string) => {
      const { provider, state } = launch(resume);
      let text = "", completeText = "", turnError = "";
      for await (const m of provider as any) {
        if (!current()) break; // retired by an explicit send; the replacement owns all state now
        // The CLI reports a rejected --resume as an error result (then exits 1) before any
        // system/init. That result is the resume rejection itself, not a turn: it is not a turn
        // failure, settles no turn, and is not a frame of processed input. Route it to the
        // resume-rejection handling below. Any other pre-init error result is handled as before.
        if (resume && !state.initialized && m.type === "result" && m.is_error) {
          const diagnostic = resultDiagnostic(m);
          if (MISSING_CONVERSATION.test(diagnostic) || INVALID_RESUME_HANDLE.test(diagnostic)) throw new Error(diagnostic);
        }
        state.frames++;
        state.reported = undefined;
        if (m.type === "system" && m.subtype === "init") {
          state.initialized = true;
          this.sessionId = m.session_id; writeFileSync(PM_SESSION_FILE, m.session_id);
          this.tools = m.tools ?? [];
          this.emitEvent({ type: "status", text: `PM session ${m.session_id.slice(0, 8)} ready (${this.tools.length} tools${this.tools.includes("SendMessage") ? ", cross-session messaging on" : ""})` });
        } else if (m.type === "stream_event") {
          const ev = m.event;
          if (ev?.type === "message_start") { if (!this.busy) { this.busy = true; this.emitEvent({ type: "turn_start", ts: new Date().toISOString() }); } }
          if (ev?.type === "content_block_start" && ev.content_block?.type === "text" && text && !text.endsWith("\n")) { text += "\n\n"; this.emitEvent({ type: "delta", text: "\n\n" }); }
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") { text += ev.delta.text; this.emitEvent({ type: "delta", text: ev.delta.text }); }
        } else if (m.type === "assistant") {
          const content = (m.message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
          if (m.error || m.isApiErrorMessage) {
            turnError = content || String(m.error || 'Provider rejected the turn');
          } else if (content) completeText += (completeText ? '\n\n' : '') + content;
          for (const b of m.message?.content ?? []) {
            if (b.type === "tool_use") {
              const summary = b.name === "mcp__fleet__spawn_session" ? `${b.input?.name} in ${b.input?.cwd}` : b.name === "SendMessage" ? `→ ${b.input?.to}${b.input?.notify_when_idle ? " (notify when idle)" : ""}` : JSON.stringify(b.input ?? {}).slice(0, 160);
              this.emitEvent({ type: "tool", name: b.name.replace(/^mcp__fleet__/, "fleet."), summary });
              this.reportRecord({ role: "tool", name: b.name, summary });
            }
          }
        } else if (m.type === "user") {
          const c = m.message?.content;
          const txt = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : "";
          if (/Cross-session (idle notice|message)|<cross-session-message/i.test(txt.slice(0, 200))) {
            // A peer message starts a turn send() never dispatched: no pending Stop applies to it.
            this.interruptedAt = null;
            this.reportRecord({ role: "peer", text: txt.slice(0, 600) });
            this.emitEvent({ type: "peer", text: txt.slice(0, 600) });
          }
        } else if (m.type === "result") {
          // Fail closed: an SDK abort reason is authoritative; otherwise cancellation is inferred
          // only for a result with no terminal_reason, after an interrupt raised against the turn
          // in flight with no newer input since. Any other terminal_reason is never a Stop.
          const reason: TerminalReason | undefined = m.terminal_reason;
          const cancelled = isAbortReason(reason) || (reason == null && this.interruptedAt !== null && this.interruptedAt === this.dispatched);
          const failed = !!m.is_error && !cancelled;
          text = text.trim() ? text : completeText || (!failed && !cancelled && typeof m.result === 'string' ? m.result : '');
          // A partial answer must precede its terminal explanation in history.
          if (text.trim()) this.reportRecord({ role: "assistant", text });
          if (failed) {
            this.providerFailed = true;
            const failure = turnError || (m.errors ?? []).join('; ') || m.result || `Provider returned ${m.subtype || 'an error'} without a diagnostic`;
            this.fail(failure);
            turnFailure = failure;
            // Suppress the SDK's exit echo only when its diagnostic is already fully in what was
            // recorded (fail() keeps the first 1500 chars). Otherwise the echo is the only carrier
            // of this result's own diagnostic, so it must surface as its own failure entry.
            const echoed = resultDiagnostic(m);
            if (echoed && failure.slice(0, 1500).includes(echoed)) state.reported = sdkErrorResultEcho(echoed);
          } else {
            turnFailure = undefined;
            this.providerFailed = false;
            this.lastError = null;
            if (cancelled) {
              const message = 'Project manager stopped at your request. Message was not replayed.';
              this.reportRecord({ role: 'system', text: message });
              this.emitEvent({ type: 'status', text: message });
            }
          }
          this.interruptedAt = null; // an interrupt is spent by the first result after it
          this.pendingTurns = Math.max(0, this.pendingTurns - 1);
          this.busy = false;
          this.emitEvent({ type: "assistant_text", text });
          this.emitEvent({ type: "turn_end", ts: new Date().toISOString(), cost_usd: m.total_cost_usd ?? 0, is_error: failed, subtype: m.subtype });
          text = ""; completeText = ""; turnError = "";
        }
      }
      if (current() && !this.closed && (!this.lastError || this.pendingTurns)) throw new Error('Provider stream ended unexpectedly');
    };
    try {
      const saved = existsSync(PM_SESSION_FILE) ? readFileSync(PM_SESSION_FILE, "utf8").trim() || undefined : undefined;
      // A quarantined id is never resumed again, even if clearing the session file failed.
      const resumeId = saved && !this.quarantinedIds.has(saved) ? saved : undefined;
      try { await run(resumeId); }
      catch (error: any) {
        if (!current() || this.closed || !resumeId) throw error;
        const diagnostic = String(error?.message ?? error);
        const rejected = attempt;
        if (!MISSING_CONVERSATION.test(diagnostic)) {
          // An invalid-handle rejection quarantines only when the provider emitted nothing first:
          // then the CLI failed on the handle before it processed anything. Once a frame arrived
          // the session was live, so the failure is not attributed to the handle and the saved
          // session is kept. The failure is loud either way (fail() in the outer catch) and
          // nothing is replayed; after a quarantine the next explicit send starts fresh.
          if (INVALID_RESUME_HANDLE.test(diagnostic) && !rejected.frames) this.quarantine(resumeId, diagnostic);
          throw error;
        }
        // The saved conversation is gone: never resume it again (with or without frames, as
        // before), but keep the id and diagnostic on record instead of wiping them.
        this.quarantine(resumeId, diagnostic);
        // The SDK reads prompt input eagerly, so "taken from the inbox" is not "processed".
        // Decide by what the provider did: if the rejected attempt emitted no frame at all, the
        // CLI failed while loading the resume and never processed its input, so that input goes
        // back to the head of the inbox, once, for its first real delivery to a fresh session.
        // If any frame arrived, the input may have been processed: fail loudly, never re-send.
        // This branch runs at most once per start(), and the fresh run() never resumes.
        if (rejected.frames) throw error;
        (q as Query | null)?.close();
        inbox.requeue(rejected.taken);
        try { await run(); }
        catch (freshError) {
          // The fresh session failed too: report its error together with the rejection that led
          // to it (an echo of an already reported result is passed through for suppression).
          const message = errorText(freshError);
          if (!current() || this.closed || message === attempt.reported || message.includes(diagnostic)) throw freshError;
          throw new Error(`${message.slice(0, 700)} (after the saved session ${resumeId} was rejected and quarantined: ${diagnostic.slice(0, 600)})`);
        }
      }
    } catch (error: any) {
      // The SDK's exit error that only echoes the failed result already reported is not a
      // second failure of the same attempt.
      const message = errorText(error);
      const echo = attempt.reported !== undefined && message === attempt.reported;
      // A process error or stream end after a reported turn failure keeps that failure as cause.
      const cause = turnFailure && !message.includes(turnFailure) ? ` (after the provider failure: ${turnFailure.slice(0, 700)})` : '';
      if (current() && !this.closed && !echo) this.fail(cause ? message.slice(0, 800) + cause : message);
    } finally {
      // Reset lifecycle state before closing, so nothing close() throws can skip it.
      const owned = current() ? this.q : (q as Query | null);
      if (current()) { this.q = null; this.running = false; this.busy = false; this.pendingTurns = 0; this.interruptedAt = null; this.providerFailed = false; this.inbox.retire(); this.inbox = new Inbox(); }
      try { owned?.close(); }
      catch (error: any) { console.error('foreman: pm provider close failed', JSON.stringify({ error: String(error?.message ?? error) })); }
    }
  }
}
