// Fleet store: merges hook records, Claude Code's live session registry, and `claude agents --json`
// into one list, and emits "change" whenever the merged view differs.
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync, watch, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { SESSIONS_DIR, CLAUDE_REGISTRY_DIR, CLAUDE_BIN, HOST, CLAUDE_CONFIG_DIR } from "./paths.ts";

export type State = "needs_input" | "working" | "turn_finished" | "idle" | "ended" | "dead" | "unknown";

export interface Session {
  session_id: string;
  name: string | null;
  cwd: string | null;
  state: State;
  reason: string | null;
  kind: "interactive" | "background" | "sdk" | "unknown";
  entrypoint: string | null;
  pid: number | null;
  alive: boolean;
  tracked: boolean; // has a hook record
  current_tool: string | null;
  active_subagents: number;
  last_message: string | null;
  last_error: string | null;
  started_at: string | null;
  updated_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  permission_mode: string | null;
  bg_id: string | null; // short id for claude attach/logs/stop
  bg_state: string | null; // native state from agent view
  bg_waiting_for: string | null;
  host: string;
  transcript_path: string | null;
}

interface HookRecord {
  session_id: string; name?: string | null; cwd?: string | null; state?: string; reason?: string | null;
  current_tool?: string | null; active_subagents?: number; last_message?: string | null; last_error?: string | null;
  started_at?: string; updated_at?: string; ended_at?: string | null; end_reason?: string | null;
  permission_mode?: string | null; transcript_path?: string | null; host?: string; source?: string | null;
}
interface RegistryEntry {
  pid: number; sessionId?: string; cwd?: string; startedAt?: number; kind?: string; entrypoint?: string; name?: string;
}
interface AgentViewEntry {
  id?: string; sessionId?: string; cwd?: string; kind?: string; state?: string; status?: string; waitingFor?: string;
  name?: string; pid?: number; startedAt?: number;
}

const STATE_ORDER: Record<State, number> = { needs_input: 0, working: 1, turn_finished: 2, idle: 3, unknown: 4, ended: 5, dead: 6 };

function readJsonDir<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  const out: T[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try { out.push(JSON.parse(readFileSync(join(dir, f), "utf8"))); } catch { /* partial write; skip */ }
  }
  return out;
}

function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

function agentView(): Promise<AgentViewEntry[]> {
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, ["agents", "--json", "--all"], { timeout: 8000, env: process.env }, (err, stdout) => {
      if (err) return resolve([]);
      try { resolve(JSON.parse(stdout)); } catch { resolve([]); }
    });
  });
}

export class Fleet extends EventEmitter {
  private sessions: Session[] = [];
  private lastJson = "";
  private timer: NodeJS.Timeout | null = null;
  private av: AgentViewEntry[] = [];
  private avAt = 0;

  list(): Session[] { return this.sessions; }
  get(id: string): Session | undefined { return this.sessions.find((s) => s.session_id === id || s.bg_id === id || s.name === id); }

  start() {
    const kick = () => this.refresh().catch(() => {});
    for (const d of [SESSIONS_DIR, CLAUDE_REGISTRY_DIR]) {
      if (existsSync(d)) { try { watch(d, { persistent: false }, () => kick()); } catch { /* fs.watch unsupported; polling covers it */ } }
    }
    this.timer = setInterval(kick, 4000);
    kick();
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  async refresh() {
    if (Date.now() - this.avAt > 10_000) { this.av = await agentView(); this.avAt = Date.now(); }
    const hooks = readJsonDir<HookRecord>(SESSIONS_DIR);
    const registry = readJsonDir<RegistryEntry>(CLAUDE_REGISTRY_DIR);
    const bySid = new Map<string, Session>();

    const base = (sid: string): Session => ({
      session_id: sid, name: null, cwd: null, state: "unknown", reason: null, kind: "unknown", entrypoint: null, pid: null,
      alive: false, tracked: false, current_tool: null, active_subagents: 0, last_message: null, last_error: null,
      started_at: null, updated_at: null, ended_at: null, end_reason: null, permission_mode: null, bg_id: null,
      bg_state: null, bg_waiting_for: null, host: HOST, transcript_path: null,
    });

    for (const h of hooks) {
      if (!h.session_id) continue;
      const s = bySid.get(h.session_id) ?? base(h.session_id);
      s.tracked = true;
      s.name = h.name ?? s.name; s.cwd = h.cwd ?? s.cwd; s.state = (h.state as State) ?? "unknown"; s.reason = h.reason ?? null;
      s.current_tool = h.current_tool ?? null; s.active_subagents = h.active_subagents ?? 0;
      s.last_message = h.last_message ?? null; s.last_error = h.last_error ?? null;
      s.started_at = h.started_at ?? null; s.updated_at = h.updated_at ?? null; s.ended_at = h.ended_at ?? null;
      s.end_reason = h.end_reason ?? null; s.permission_mode = h.permission_mode ?? null; s.transcript_path = h.transcript_path ?? null;
      s.host = h.host ?? HOST;
      bySid.set(h.session_id, s);
    }
    for (const r of registry) {
      if (!r.sessionId) continue;
      const s = bySid.get(r.sessionId) ?? base(r.sessionId);
      s.pid = r.pid; s.alive = pidAlive(r.pid);
      s.name = s.name ?? r.name ?? null; s.cwd = s.cwd ?? r.cwd ?? null;
      s.kind = r.entrypoint === "sdk-ts" || r.entrypoint === "sdk-py" ? "sdk" : (r.kind as any) ?? "interactive";
      s.entrypoint = r.entrypoint ?? null;
      s.started_at = s.started_at ?? (r.startedAt ? new Date(r.startedAt).toISOString() : null);
      bySid.set(r.sessionId, s);
    }
    for (const a of this.av) {
      if (!a.sessionId) continue;
      const s = bySid.get(a.sessionId) ?? base(a.sessionId);
      s.bg_id = a.id ?? null; s.bg_state = a.state ?? a.status ?? null; s.bg_waiting_for = a.waitingFor ?? null;
      if (a.kind === "background") s.kind = "background";
      s.name = s.name ?? a.name ?? null; s.cwd = s.cwd ?? a.cwd ?? null;
      if (a.pid) { s.pid = s.pid ?? a.pid; s.alive = s.alive || pidAlive(a.pid); }
      // Native state wins for supervisor-run sessions when the hook record is silent.
      if (!s.tracked && a.kind === "background") {
        if (a.status === "waiting") { s.state = "needs_input"; s.reason = a.waitingFor ?? null; }
        else if (a.status === "busy" || a.state === "working") s.state = "working";
        else if (a.state === "done") s.state = "turn_finished";
        else if (a.state === "failed" || a.state === "stopped") s.state = "ended";
      }
      bySid.set(a.sessionId, s);
    }

    // Fallback for sessions that predate the hooks: infer from the transcript.
    for (const s of bySid.values()) {
      if (s.tracked || s.state !== "unknown") continue;
      const t = s.transcript_path ?? guessTranscript(s.cwd, s.session_id);
      if (!t) { if (s.alive) s.state = "idle"; continue; }
      s.transcript_path = t;
      const g = inferFromTranscript(t);
      if (g) { s.state = g.state; s.updated_at = g.updated_at; s.last_message = g.last_message; s.current_tool = g.current_tool; }
      // A "working" inference with no activity for 10 minutes is a stale read, not real work.
      if (s.state === "working" && s.updated_at && Date.now() - Date.parse(s.updated_at) > 10 * 60_000) s.state = "turn_finished";
    }
    // Liveness pass: a tracked session whose process vanished without SessionEnd is dead.
    for (const s of bySid.values()) {
      const known = s.pid !== null;
      if (s.state === "ended") continue;
      if (known && !s.alive && s.kind !== "background") s.state = "dead";
      if (!known && s.tracked && s.updated_at && Date.now() - Date.parse(s.updated_at) > 12 * 3600_000) s.state = "dead";
    }

    const list = [...bySid.values()].sort((a, b) => {
      const d = STATE_ORDER[a.state] - STATE_ORDER[b.state];
      if (d) return d;
      return (Date.parse(b.updated_at ?? b.started_at ?? "0") || 0) - (Date.parse(a.updated_at ?? a.started_at ?? "0") || 0);
    });
    const json = JSON.stringify(list);
    if (json !== this.lastJson) { this.lastJson = json; this.sessions = list; this.emit("change", list); }
  }
}

// For sessions that predate the hooks: locate the transcript from cwd + session id and infer a
// coarse state from the last message record. Undocumented format; best effort only.
export function guessTranscript(cwd: string | null, sid: string): string | null {
  if (!cwd) return null;
  const slug = cwd.replace(/[\/_.]/g, "-");
  const p = join(CLAUDE_CONFIG_DIR, "projects", slug, `${sid}.jsonl`);
  return existsSync(p) ? p : null;
}
export function inferFromTranscript(path: string): { state: State; updated_at: string | null; last_message: string | null; current_tool: string | null } | null {
  try {
    const size = statSync(path).size;
    const buf = readFileSync(path, "utf8").slice(Math.max(0, size - 200_000));
    const lines = buf.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let rec: any; try { rec = JSON.parse(lines[i]); } catch { continue; }
      if (rec.isSidechain) continue;
      if (rec.type === "system" && rec.subtype === "api_error") return { state: "turn_finished", updated_at: rec.timestamp ?? null, last_message: "API error", current_tool: null };
      if (rec.type !== "user" && rec.type !== "assistant") continue;
      const c = rec.message?.content;
      if (rec.type === "assistant") {
        const blocks = Array.isArray(c) ? c : [];
        const tool = blocks.find((b: any) => b.type === "tool_use");
        if (rec.message?.stop_reason === "tool_use" || tool) return { state: "working", updated_at: rec.timestamp ?? null, last_message: null, current_tool: tool?.name ?? null };
        const txt = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").trim();
        return { state: "turn_finished", updated_at: rec.timestamp ?? null, last_message: txt.slice(0, 2000) || null, current_tool: null };
      }
      if (rec.type === "user") {
        const s = typeof c === "string" ? c : "";
        if (/\[Request interrupted by user/.test(s)) return { state: "turn_finished", updated_at: rec.timestamp ?? null, last_message: null, current_tool: null };
        return { state: "working", updated_at: rec.timestamp ?? null, last_message: null, current_tool: null };
      }
    }
  } catch { /* ignore */ }
  return null;
}

export function transcriptTail(path: string | null, n = 12): string {
  if (!path || !existsSync(path)) return "(no transcript on disk)";
  const size = statSync(path).size;
  const fd = readFileSync(path, { encoding: "utf8", flag: "r" });
  const lines = fd.slice(Math.max(0, size - 400_000)).split("\n").filter(Boolean);
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    let rec: any; try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (rec.type !== "user" && rec.type !== "assistant") continue;
    if (rec.isSidechain) continue;
    const c = rec.message?.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) text = c.map((b: any) => b.type === "text" ? b.text : b.type === "tool_use" ? `[tool ${b.name}]` : b.type === "tool_result" ? "[tool result]" : "").filter(Boolean).join(" ");
    if (!text.trim()) continue;
    out.push(`${rec.type === "user" ? "user" : "assistant"} (${rec.timestamp ?? "?"}): ${text.slice(0, 600)}`);
  }
  return out.reverse().join("\n\n") || "(no message records found)";
}
