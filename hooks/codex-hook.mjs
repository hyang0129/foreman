#!/usr/bin/env node
// Advisory Codex lifecycle observer. Never emits decisions or reads transcript contents.
import { constants, promises as fs } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { assertTestHome } from "../server/home-guard.mjs";

export const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact", "SubagentStart", "SubagentStop", "Stop", "Interrupt", "SessionEnd"];
const short = (value, limit = 256) => typeof value === "string" ? value.slice(0, limit) : null;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);

export function reduceEvent(previous, input, now = new Date().toISOString()) {
  const event = input.hook_event_name;
  if (!EVENTS.includes(event) || !/^[a-zA-Z0-9_-]{1,160}$/.test(input.session_id ?? "")) return null;
  const p = object(previous) ? previous : {};
  const turn = short(input.turn_id);
  // Delayed tool/subagent completion must not resurrect a finished turn or closed session.
  if (p.state === "ended" && event !== "SessionStart") return null;
  if (turn && p.completed_turn_ids?.includes(turn) && !["SessionEnd", "SessionStart", "SubagentStop"].includes(event)) return null;
  const r = {
    ...p, provider: "codex", session_id: input.session_id, name: p.name ?? null,
    cwd: short(input.cwd, 4096) ?? p.cwd ?? null,
    transcript_path: input.transcript_path ?? p.transcript_path ?? null,
    permission_mode: short(input.permission_mode) ?? p.permission_mode ?? null,
    model: short(input.model) ?? p.model ?? null,
    host: hostname().split(".")[0], started_at: p.started_at ?? now, updated_at: now,
    ended_at: p.ended_at ?? null, end_reason: p.end_reason ?? null,
    source: p.source ?? null, state: p.state ?? "idle", reason: p.reason ?? null,
    current_tool: p.current_tool ?? null, active_subagents: p.active_subagents ?? 0,
    active_subagent_ids: p.active_subagent_ids ?? [], last_message: p.last_message ?? null,
    last_error: p.last_error ?? null, last_event: event, turn_id: event === "SubagentStop" ? p.turn_id ?? turn : turn ?? p.turn_id ?? null,
    event_sequence: (p.event_sequence ?? 0) + 1, completed_turn_ids: p.completed_turn_ids ?? [],
  };
  if (event === "SessionStart") {
    r.source = short(input.source);
    if (input.source !== "compact" || r.state === "ended") { r.state = "idle"; r.reason = null; r.current_tool = null; }
    r.ended_at = null; r.end_reason = null;
  } else if (event === "UserPromptSubmit") {
    r.state = "working"; r.reason = null; r.current_tool = null;
  } else if (event === "PreToolUse") {
    r.state = "working"; r.reason = null; r.current_tool = short(input.tool_name);
  } else if (event === "PermissionRequest") {
    r.state = "needs_input"; r.reason = "permission"; r.current_tool = short(input.tool_name);
  } else if (event === "PostToolUse") {
    r.state = "working"; r.reason = null; r.current_tool = null;
  } else if (event === "PreCompact" || event === "PostCompact") {
    r.state = "working"; r.reason = event === "PreCompact" ? "compacting" : null;
  } else if (event === "SubagentStart" || event === "SubagentStop") {
    const ids = new Set(r.active_subagent_ids);
    const id = short(input.agent_id);
    if (id) { if (event === "SubagentStart") ids.add(id); else ids.delete(id); }
    r.active_subagent_ids = [...ids]; r.active_subagents = ids.size;
    // Parent can be awaiting input while a child starts or finishes.
  } else if (event === "Stop" || event === "Interrupt") {
    r.state = "turn_finished"; r.reason = event === "Interrupt" ? "interrupted" : null;
    r.current_tool = null;
    if (event === "Stop") r.last_message = short(input.last_assistant_message, 2000) ?? r.last_message;
    if (turn) r.completed_turn_ids = [...new Set([...r.completed_turn_ids, turn])].slice(-64);
  } else if (event === "SessionEnd") {
    r.state = "ended"; r.reason = null; r.ended_at = now; r.end_reason = short(input.reason);
    r.current_tool = null; r.active_subagent_ids = []; r.active_subagents = 0;
  }
  return r;
}

export async function safeTranscript(value, codexHome) {
  if (typeof value !== "string" || !isAbsolute(value) || !value.endsWith(".jsonl")) return null;
  try {
    const real = await fs.realpath(value);
    for (const subdir of ["sessions", "archived_sessions"]) {
      const root = await fs.realpath(join(codexHome, subdir)).catch(() => null);
      if (!root) continue;
      const rel = relative(root, real);
      if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && (await fs.stat(real)).isFile()) return real;
    }
  } catch { /* Missing or outside the session store: leave unavailable. */ }
  return null;
}

async function acquireLock(path) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    try {
      await fs.mkdir(path, { mode: 0o700 });
      await fs.writeFile(join(path, "owner"), String(process.pid), { mode: 0o600 });
      return async () => fs.rm(path, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Serialize reclaimers, then recheck the owner. A second reclaimer must not
      // rename a new live lock using a stale observation of the previous owner.
      const reclaim = `${path}.reclaim`;
      let ownsReclaim = false;
      try {
        await fs.mkdir(reclaim, { mode: 0o700 });
        ownsReclaim = true;
        const age = Date.now() - (await fs.lstat(path)).mtimeMs;
        const pid = Number(await fs.readFile(join(path, "owner"), "utf8"));
        if (age > 30_000 && Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (e) {
            if (e.code === "ESRCH") {
              const stale = `${path}.stale-${randomUUID()}`;
              await fs.rename(path, stale);
              await fs.rm(stale, { recursive: true, force: true });
            }
          }
        }
      } catch { /* Another observer may have released it or be reclaiming it. */ }
      finally { if (ownsReclaim) await fs.rmdir(reclaim).catch(() => {}); }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("session lock timed out");
}

// The installed hook command pins FOREMAN_HOME to the installing Foreman's home.
// A Foreman daemon that shares this CODEX_HOME but keeps its own state (the dev
// preview) sets FOREMAN_HOOK_HOME for the sessions it launches, so their
// records reach that daemon rather than the one that installed the hook.
export async function recordEvent(input, options = {}) {
  const { foremanHome = process.env.FOREMAN_HOOK_HOME || process.env.FOREMAN_HOME || join(homedir(), ".foreman"), codexHome = process.env.CODEX_HOME || join(homedir(), ".codex") } = options;
  if (!object(input) || !EVENTS.includes(input.hook_event_name) || !/^[a-zA-Z0-9_-]{1,160}$/.test(input.session_id ?? "")) return false;
  // Story #121: under node --test, never record into the real ~/.foreman.
  assertTestHome(foremanHome, { explicit: Boolean(options.foremanHome || process.env.FOREMAN_HOOK_HOME || process.env.FOREMAN_HOME), variable: "FOREMAN_HOOK_HOME or FOREMAN_HOME" });
  const dir = join(foremanHome, "sessions");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `codex-${input.session_id}.json`);
  const unlock = await acquireLock(`${file}.lock`);
  let temporary;
  try {
    let previous = {};
    try {
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { previous = JSON.parse(await handle.readFile("utf8")); } finally { await handle.close(); }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const transcript = await safeTranscript(input.transcript_path ?? previous.transcript_path, codexHome);
    const next = reduceEvent(previous, { ...input, transcript_path: transcript });
    if (!next) return false;
    // Explicitly clear unsafe/missing paths rather than carrying a stale value forward.
    next.transcript_path = transcript;
    temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
    return true;
  } finally {
    if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
    await unlock();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let body = "";
    for await (const chunk of process.stdin) {
      body += chunk;
      if (Buffer.byteLength(body) > 2_000_000) throw new Error("input too large");
    }
    await recordEvent(JSON.parse(body));
  } catch {
    // Generic error only: tool arguments and transcripts can contain secrets.
    process.stderr.write("Foreman Codex observer could not record this event.\n");
  }
  process.stdout.write("{}\n");
}
