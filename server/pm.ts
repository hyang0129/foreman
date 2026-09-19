// The project manager: one long-lived Claude Agent SDK session in streaming-input mode.
// Tool access is enforced here (canUseTool), not just prompted.
import { query, type SDKUserMessage, type Query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { normalizeModel } from "./models.ts";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, existsSync, appendFileSync, realpathSync, statSync, renameSync } from "node:fs";
import { join, resolve, sep, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { Fleet } from "./fleet.ts";
import { ProjectRegistry } from "./projects.ts";
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

class Inbox {
  private q: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  push(text: string, sessionId: string) {
    this.q.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: sessionId } as SDKUserMessage);
    this.wake?.(); this.wake = null;
  }
  async *stream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      if (this.q.length) { yield this.q.shift()!; continue; }
      await new Promise<void>((r) => (this.wake = r));
    }
  }
}

export class ProjectManager extends EventEmitter {
  private inbox = new Inbox();
  private q: Query | null = null;
  sessionId: string | null = null;
  busy = false;
  tools: string[] = [];
  private running = false;
  private closed = false;
  private pendingTurns = 0;
  private changingModel = false;
  model: string | undefined;
  private settingsPath: string;
  get modelBusy() { return this.busy || this.pendingTurns > 0 || this.changingModel; }

  private fleet: Fleet;
  private sessions?: ManagedFleetService;
  private projects?: ProjectRegistry;
  constructor(fleet: Fleet, sessions?: ManagedFleetService, settingsPath = join(FOREMAN_HOME, 'pm', 'settings.json'), projects?: ProjectRegistry) {
    super(); this.fleet = fleet; this.sessions = sessions; this.projects = projects; this.settingsPath = settingsPath;
    this.model = normalizeModel(existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')).model : process.env.FOREMAN_PM_MODEL);
  }
  async setModel(value: unknown) {
    const model = normalizeModel(value);
    if (this.modelBusy) throw new Error('Wait for the project manager to finish before changing its model');
    if (!this.q || this.closed || !this.running) throw new Error('Project manager is unavailable');
    this.changingModel = true;
    const previous = this.model;
    try {
      await this.q.setModel(model);
      try {
        const tmp = `${this.settingsPath}.${randomUUID()}.tmp`;
        writeFileSync(tmp, JSON.stringify({ model: model ?? null }), { flag: 'wx', mode: 0o600 });
        renameSync(tmp, this.settingsPath);
        this.model = model;
      } catch (error) {
        // If persistence fails, restore the previous live selection before accepting more messages.
        try { await this.q.setModel(previous); } catch { this.close(); }
        throw error;
      }
    } finally { this.changingModel = false; }
  }

  history(): any[] {
    if (!existsSync(PM_HISTORY_FILE)) return [];
    return readFileSync(PM_HISTORY_FILE, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-200);
  }
  private record(entry: any) { appendFileSync(PM_HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"); }

  send(text: string) {
    if (this.changingModel) throw new Error('Model change in progress; retry your message');
    if (!this.running || this.closed) throw new Error('Project manager is unavailable');
    this.record({ role: "user", text });
    this.pendingTurns++;
    this.inbox.push(text, this.sessionId ?? "");
  }
  async interrupt() { await this.q?.interrupt(); }
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
    this.running = true;
    const base = readFileSync(join(REPO_ROOT, "agents", "pm-system-prompt.md"), "utf8");
    const resumeId = existsSync(PM_SESSION_FILE) ? readFileSync(PM_SESSION_FILE, "utf8").trim() || undefined : undefined;
    const run = async (resume?: string) => {
      this.q = query({
        prompt: this.inbox.stream(),
        options: {
          cwd: FOREMAN_HOME,
          resume,
          systemPrompt: { type: "preset", preset: "claude_code", append: base + '\nUse list_projects and resolve_project for project references; ask when ambiguous or missing. When the developer gives a name or alias for their current known project, register_project records it. Never invent directories.' + this.memoryBlock() + (this.sessions ? '\n\n' + PEER_INSTRUCTIONS + '\nFor Foreman-managed sessions, use peer tools to request updates and read outcomes. Native SendMessage subscriptions apply only to legacy Claude background sessions. You still must not read or edit source code or bypass your PM tool restrictions.' : '') },
          settingSources: ["user"],
          permissionMode: "default",
          canUseTool: this.canUseTool,
          hooks: { PreToolUse: [{ hooks: [this.enforceToolBoundary] }] },
          includePartialMessages: true,
          mcpServers: { fleet: makeFleetServer(this.fleet, this.sessions, this.projects), ...(this.sessions ? { peers: makePeerMcpServer(this.sessions, 'foreman-pm') } : {}) },
          allowedTools: ["mcp__fleet__list_projects", "mcp__fleet__resolve_project", "mcp__fleet__register_project", "mcp__fleet__list_sessions", "mcp__fleet__list_models", "mcp__fleet__session_tail", "mcp__fleet__log_note", "ListAgents", "WebFetch", "WebSearch", ...(this.sessions ? PEER_ALLOWED_TOOLS : [])],
          disallowedTools: ["Agent", "Bash", "Glob", "Grep"],
          extraArgs: { name: "foreman-pm" },
          maxTurns: 60,
          effort: (process.env.FOREMAN_PM_EFFORT as any) || "medium",
          ...(this.model ? { model: this.model } : {}),
          stderr: (chunk: string) => { if (/error|warn/i.test(chunk)) this.emit("event", { type: "status", text: chunk.trim().slice(0, 300) } as PmEvent); },
        },
      });
      let text = "";
      for await (const m of this.q as any) {
        if (m.type === "system" && m.subtype === "init") {
          this.sessionId = m.session_id; writeFileSync(PM_SESSION_FILE, m.session_id);
          this.tools = m.tools ?? [];
          this.emit("event", { type: "status", text: `PM session ${m.session_id.slice(0, 8)} ready (${this.tools.length} tools${this.tools.includes("SendMessage") ? ", cross-session messaging on" : ""})` } as PmEvent);
        } else if (m.type === "stream_event") {
          const ev = m.event;
          if (ev?.type === "message_start") { if (!this.busy) { this.busy = true; this.emit("event", { type: "turn_start", ts: new Date().toISOString() } as PmEvent); } }
          if (ev?.type === "content_block_start" && ev.content_block?.type === "text" && text && !text.endsWith("\n")) { text += "\n\n"; this.emit("event", { type: "delta", text: "\n\n" } as PmEvent); }
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") { text += ev.delta.text; this.emit("event", { type: "delta", text: ev.delta.text } as PmEvent); }
        } else if (m.type === "assistant") {
          for (const b of m.message?.content ?? []) {
            if (b.type === "tool_use") {
              const summary = b.name === "mcp__fleet__spawn_session" ? `${b.input?.name} in ${b.input?.cwd}` : b.name === "SendMessage" ? `→ ${b.input?.to}${b.input?.notify_when_idle ? " (notify when idle)" : ""}` : JSON.stringify(b.input ?? {}).slice(0, 160);
              this.emit("event", { type: "tool", name: b.name.replace(/^mcp__fleet__/, "fleet."), summary } as PmEvent);
              this.record({ role: "tool", name: b.name, summary });
            }
          }
        } else if (m.type === "user") {
          const c = m.message?.content;
          const txt = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : "";
          if (/Cross-session (idle notice|message)|<cross-session-message/i.test(txt.slice(0, 200))) {
            this.record({ role: "peer", text: txt.slice(0, 600) });
            this.emit("event", { type: "peer", text: txt.slice(0, 600) } as PmEvent);
          }
        } else if (m.type === "result") {
          this.pendingTurns = Math.max(0, this.pendingTurns - 1);
          this.busy = false;
          if (text.trim()) this.record({ role: "assistant", text });
          this.emit("event", { type: "assistant_text", text } as PmEvent);
          this.emit("event", { type: "turn_end", ts: new Date().toISOString(), cost_usd: m.total_cost_usd ?? 0, is_error: !!m.is_error, subtype: m.subtype } as PmEvent);
          text = "";
        }
      }
    };
    try { await run(resumeId); }
    catch (e: any) {
      if (this.closed) return;
      const msg = String(e?.message ?? e);
      this.emit("event", { type: "status", text: `PM stopped: ${msg.slice(0, 300)}` } as PmEvent);
      if (resumeId && /resume|session/i.test(msg)) { writeFileSync(PM_SESSION_FILE, ""); await run(); return; }
      this.running = false;
    } finally { this.running = false; this.busy = false; this.pendingTurns = 0; }
  }
}
