// The project manager: one long-lived Claude Agent SDK session in streaming-input mode.
// Tool access is enforced here (canUseTool), not just prompted.
import { query, type SDKUserMessage, type Query } from "@anthropic-ai/claude-agent-sdk";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { Fleet } from "./fleet.ts";
import { makeFleetServer } from "./tools.ts";
import { FOREMAN_HOME, MEMORY_DIR, PM_SESSION_FILE, PM_HISTORY_FILE, REPO_ROOT } from "./paths.ts";

export type PmEvent =
  | { type: "turn_start"; ts: string }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; summary: string }
  | { type: "assistant_text"; text: string }
  | { type: "turn_end"; ts: string; cost_usd: number; is_error: boolean; subtype: string }
  | { type: "status"; text: string }
  | { type: "peer"; text: string };

const DOC_PATH = /(^|\/)(docs?|documentation|issues?|adrs?|rfcs?|specs?|notes?|plans?|\.github)(\/|$)|\.(md|mdx|markdown|txt|rst|adoc)$|(^|\/)(readme|changelog|contributing|license|todo|roadmap)[^/]*$/i;
const BASH_ALLOW = /^\s*(gh\s+(issue|pr|repo|run)\s+(list|view|status|checks|diff\s+--stat)\b|git\s+(log|status|branch|remote|show\s+--stat|diff\s+--stat)\b|claude\s+(agents|logs)\b|ls\b|date\b|pwd\b|cat\s+\S+\.(md|txt|rst)\b|head\s+\S+\.(md|txt|rst)\b)/;

const home = homedir();
const under = (p: string, dir: string) => { const a = resolve(p); const d = resolve(dir); return a === d || a.startsWith(d + sep); };
const expand = (p: string) => (p.startsWith("~") ? join(home, p.slice(1)) : p);

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

  private fleet: Fleet;
  constructor(fleet: Fleet) { super(); this.fleet = fleet; }

  history(): any[] {
    if (!existsSync(PM_HISTORY_FILE)) return [];
    return readFileSync(PM_HISTORY_FILE, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-200);
  }
  private record(entry: any) { appendFileSync(PM_HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"); }

  send(text: string) {
    this.record({ role: "user", text });
    this.inbox.push(text, this.sessionId ?? "");
  }
  async interrupt() { await this.q?.interrupt(); }

  private memoryBlock(): string {
    const read = (f: string) => (existsSync(join(MEMORY_DIR, f)) ? readFileSync(join(MEMORY_DIR, f), "utf8").trim() : "(empty)");
    return `\n\n# Memory (from ~/.foreman/memory, read at start)\n\n## PROJECTS.md\n${read("PROJECTS.md")}\n\n## LOG.md (last 40 lines)\n${read("LOG.md").split("\n").slice(-40).join("\n")}\n`;
  }

  private canUseTool = async (name: string, input: Record<string, any>) => {
    const allow = () => ({ behavior: "allow" as const, updatedInput: input });
    const deny = (message: string) => ({ behavior: "deny" as const, message });
    const delegate = "Denied: the project manager does not touch code. Brief a session agent with spawn_session instead.";
    if (name.startsWith("mcp__fleet__") || ["ListAgents", "SendMessage", "WebFetch", "WebSearch", "TodoWrite", "TaskCreate", "TaskList", "TaskUpdate", "TaskGet"].includes(name)) return allow();
    if (name === "Read" || name === "Glob" || name === "Grep") {
      const p = expand(String(input.file_path ?? input.path ?? input.pattern ?? ""));
      if (!p) return name === "Read" ? deny("Read needs a file_path.") : allow();
      if (under(p, FOREMAN_HOME) || under(p, REPO_ROOT + "/docs") || DOC_PATH.test(p)) return allow();
      return deny(`${delegate} (${name} is limited to docs, issues, markdown, and ~/.foreman.)`);
    }
    if (name === "Write" || name === "Edit" || name === "MultiEdit" || name === "NotebookEdit") {
      const p = expand(String(input.file_path ?? ""));
      if (p && under(p, MEMORY_DIR)) return allow();
      return deny(`${delegate} (Writes are limited to ~/.foreman/memory.)`);
    }
    if (name === "Bash") {
      const cmd = String(input.command ?? "");
      if (BASH_ALLOW.test(cmd) && !/[;&|`$(]/.test(cmd.replace(/\|\|/g, ""))) return allow();
      return deny(`${delegate} (Bash is limited to read-only gh/git/claude agents commands.)`);
    }
    if (name === "Agent") return deny("Denied: no subagents for the PM; spawn a tracked session with spawn_session so the user can see it.");
    return deny(`Denied: ${name} is not available to the project manager.`);
  };

  async start() {
    if (this.running) return;
    this.running = true;
    const base = readFileSync(join(REPO_ROOT, "agents", "pm-system-prompt.md"), "utf8");
    const resumeId = existsSync(PM_SESSION_FILE) ? readFileSync(PM_SESSION_FILE, "utf8").trim() || undefined : undefined;
    const run = async (resume?: string) => {
      this.q = query({
        prompt: this.inbox.stream(),
        options: {
          cwd: FOREMAN_HOME,
          resume,
          systemPrompt: { type: "preset", preset: "claude_code", append: base + this.memoryBlock() },
          settingSources: ["user"],
          permissionMode: "default",
          canUseTool: this.canUseTool,
          includePartialMessages: true,
          mcpServers: { fleet: makeFleetServer(this.fleet) },
          allowedTools: ["mcp__fleet__list_sessions", "mcp__fleet__session_tail", "mcp__fleet__log_note", "ListAgents", "WebFetch", "WebSearch"],
          disallowedTools: ["Agent"],
          extraArgs: { name: "foreman-pm" },
          maxTurns: 60,
          effort: (process.env.FOREMAN_PM_EFFORT as any) || "medium",
          ...(process.env.FOREMAN_PM_MODEL ? { model: process.env.FOREMAN_PM_MODEL } : {}),
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
      const msg = String(e?.message ?? e);
      this.emit("event", { type: "status", text: `PM stopped: ${msg.slice(0, 300)}` } as PmEvent);
      if (resumeId && /resume|session/i.test(msg)) { writeFileSync(PM_SESSION_FILE, ""); this.running = false; return this.start(); }
      this.running = false;
    }
  }
}
