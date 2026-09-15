import { permissionMode, claudePolicy, type PermissionMode } from "./permission-policy.ts";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { query, type Options, type Query, type SDKUserMessage, type PermissionResult, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";

type State = "idle" | "working" | "input-needed" | "closed" | "failed";
export type ClaudeReceipt = { id: string; status: "queued" | "running" | "completed" | "failed"; result?: unknown; error?: string };
type PermissionContext = Parameters<CanUseTool>[2];
export type ClaudeApproval = { id: string; tool: string; input: Record<string, unknown>; reason?: string; context: Omit<PermissionContext, "signal"> };
type Pending = { receipt: ClaudeReceipt; text: string; uuid: string };
type QueryFactory = typeof query;

class InputQueue {
  private values: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  push(value: SDKUserMessage) { this.values.push(value); this.wake?.(); }
  close() { this.closed = true; this.wake?.(); }
  async *stream(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (this.values.length) yield this.values.shift()!;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

/** A single SDK-owned process. Resume requires the former process to have stopped.
 * This is not an attachment API for an arbitrary live terminal session.
 * Receipts are deduplicated for this controller's lifetime, not across restarts.
 */
export class ClaudeControl extends EventEmitter {
  state: State = "idle";
  sessionId: string | null = null;
  private input = new InputQueue();
  private stream?: Query;
  private pending: Pending[] = [];
  private active?: Pending;
  private receipts = new Map<string, ClaudeReceipt>();
  private sentText = new Map<string, string>();
  private approvals = new Map<string, { request: ClaudeApproval; approvedInput: Record<string, unknown>; resolve: (result: PermissionResult) => void; promise: Promise<PermissionResult> }>();
  readonly finished: Promise<void>;
  private readonly policy: PermissionMode;
  get permission_mode() { return this.policy; }

  constructor(options: Pick<Options, "cwd" | "resume" | "model" | "maxBudgetUsd" | "maxTurns" | "tools" | "settingSources" | "settings" | "systemPrompt" | "persistSession" | "pathToClaudeCodeExecutable" | "mcpServers" | "allowedTools"> & { permission_mode?: PermissionMode },
    factory: QueryFactory = query) {
    super();
    this.policy = permissionMode(options.permission_mode);
    const { permission_mode: _policy, ...providerOptions } = options;
    // Defer startup so callers can subscribe before any process or error event.
    this.finished = Promise.resolve().then(async () => {
      if (this.isClosed()) return;
      try {
        this.stream = factory({ prompt: this.input.stream(), options: {
          ...providerOptions,
          permissionMode: claudePolicy(this.policy),
          allowDangerouslySkipPermissions: this.policy === 'bypass',
          // Bypass explicitly disables the provider sandbox; Native inherits provider settings.
          ...(this.policy === 'bypass' ? { sandbox: { enabled: false } } : {}),
          includePartialMessages: true,
          canUseTool: (tool, input, context) => this.requestApproval(tool, input, context),
        } });
        for await (const message of this.stream) {
          if (message.type === "system" && message.subtype === "init") {
            const expected = claudePolicy(this.policy);
            if (message.permissionMode !== expected) throw new Error('Claude did not apply the requested launch policy');
            this.sessionId = message.session_id;
          }
          this.emit("message", message);
          if (message.type === "result" && this.active) {
            const echoed = message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : []);
            // Native peer/background turns may interleave with our input. Do not
            // acknowledge another send when the producer supplies correlation.
            if (echoed.length && !echoed.includes(this.active.uuid)) continue;
            if (!echoed.length && message.origin && message.origin.kind !== "human") continue;
            for (const approval of [...this.approvals.values()])
              approval.resolve({ behavior: 'deny', message: 'Provider turn completed' });
            const receipt = this.active.receipt;
            receipt.status = message.is_error ? "failed" : "completed";
            receipt.result = message;
            this.active = undefined;
            this.setState("idle");
            this.emit("receipt", receipt);
            this.dispatch();
          }
        }
        if (!this.isClosed()) this.stop("failed", "Claude process ended");
      } catch (error) {
        if (!this.isClosed()) this.stop("failed", String(error));
      }
    });
  }

  send(text: string, id: string = randomUUID()): ClaudeReceipt {
    if (!text.trim()) throw new Error("Message cannot be empty");
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("Message exceeds 64 KiB");
    if (!id || id.length > 200) throw new Error("Message id must contain 1–200 characters");
    const previous = this.receipts.get(id);
    if (previous) {
      if (this.sentText.get(id) !== text) throw new Error("Message id was already used for different text");
      return previous;
    }
    if (this.state === "closed" || this.state === "failed") throw new Error("Claude controller is unavailable");
    if (this.pending.length >= 100) throw new Error("Claude message queue is full");
    if (this.receipts.size >= 10000) throw new Error("Claude receipt limit reached; open a new controller");
    const receipt: ClaudeReceipt = { id, status: "queued" };
    this.receipts.set(id, receipt);
    this.sentText.set(id, text);
    this.pending.push({ text, receipt, uuid: randomUUID() });
    this.emit("receipt", receipt);
    this.dispatch();
    return receipt;
  }

  private dispatch() {
    if (this.active || !this.pending.length || this.state === "closed" || this.state === "failed") return;
    this.active = this.pending.shift()!;
    this.active.receipt.status = "running";
    this.setState("working");
    this.emit("receipt", this.active.receipt);
    this.input.push({ type: "user", session_id: this.sessionId ?? "", uuid: this.active.uuid,
      parent_tool_use_id: null, message: { role: "user", content: this.active.text } } as SDKUserMessage);
  }

  pendingApprovals(): ClaudeApproval[] { return [...this.approvals.values()].map(({ request }) => structuredClone(request)); }

  /** Answer one concrete request only. No permanent permissions are written. */
  respondApproval(id: string, decision: "allow" | "deny", updatedInput?: Record<string, unknown>): boolean {
    const approval = this.approvals.get(id);
    if (!approval) return false;
    if (updatedInput && approval.request.tool !== 'AskUserQuestion') throw new Error('Approval cannot change the approved tool input or launch policy');
    approval.resolve(decision === "allow"
      ? { behavior: "allow", updatedInput: updatedInput ?? approval.approvedInput }
      : { behavior: "deny", message: "Denied by the user in Foreman" });
    return true;
  }

  private requestApproval(tool: string, input: Record<string, unknown>, context: PermissionContext): Promise<PermissionResult> {
    if (this.state === "closed" || this.state === "failed" || context.signal.aborted)
      return Promise.resolve({ behavior: "deny", message: "Session is unavailable" });
    const id = context.requestId || context.toolUseID;
    const existing = this.approvals.get(id);
    if (existing) {
      if (existing.request.tool !== tool || JSON.stringify(existing.approvedInput) !== JSON.stringify(input))
        return Promise.resolve({ behavior: 'deny', message: 'Approval id reused for different input' });
      return existing.promise;
    }
    const approvedInput = structuredClone(input);
    let resolve!: (result: PermissionResult) => void;
    const promise = new Promise<PermissionResult>((settle) => { resolve = settle; });
    const abort = () => finish({ behavior: "deny", message: "Permission request cancelled" });
    const finish = (result: PermissionResult) => {
      if (!this.approvals.delete(id)) return;
      context.signal.removeEventListener("abort", abort);
      if (!this.approvals.size && this.state === "input-needed") this.setState(this.active ? "working" : "idle");
      resolve(result);
    };
    const { signal, ...displayContext } = context;
    const request = { id, tool, input: structuredClone(input), reason: context.decisionReason, context: displayContext };
    this.approvals.set(id, { request, approvedInput, resolve: finish, promise });
    context.signal.addEventListener("abort", abort, { once: true });
    this.setState("input-needed");
    this.emit("approval", structuredClone(request));
    return promise;
  }

  async interrupt() {
    for (const approval of [...this.approvals.values()]) approval.resolve({ behavior: 'deny', message: 'Interrupted by user' });
    return this.stream?.interrupt();
  }
  private isClosed(): boolean { return this.state === "closed"; }
  close() { this.stop("closed", "Claude controller closed"); }

  private stop(state: "closed" | "failed", error: string) {
    this.setState(state);
    for (const approval of [...this.approvals.values()]) approval.resolve({ behavior: "deny", message: error });
    for (const item of [...(this.active ? [this.active] : []), ...this.pending]) {
      item.receipt.status = "failed"; item.receipt.error = error;
      this.emit("receipt", item.receipt);
    }
    this.active = undefined; this.pending = [];
    this.input.close(); this.stream?.close();
  }
  private setState(state: State) { this.state = state; this.emit("state", state); }
}
