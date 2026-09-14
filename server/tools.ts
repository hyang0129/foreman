import { PERMISSION_MODES, type PermissionMode } from './permission-policy.ts';
// In-process MCP tools the PM uses to see and steer the fleet.
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { Fleet, transcriptTail } from "./fleet.ts";
import { CLAUDE_BIN, WARP_SPAWN, MEMORY_DIR } from "./paths.ts";
import { bindPeerTools, type PeerService } from "./peer-tools.ts";
import { modelCatalog } from "./models.ts";
import { randomUUID } from "node:crypto";

export interface ManagedFleetService extends PeerService {
  create(input: { id: string; provider: 'claude' | 'codex'; name: string; cwd: string; text: string; model?: string; permission_mode?: PermissionMode }): any;
  interrupt(id: string): any;
}

const fmt = (o: unknown) => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });
const err = (m: string) => ({ content: [{ type: "text" as const, text: m }], isError: true });

export function runClaude(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, args, { cwd, timeout: 30_000, env: process.env, maxBuffer: 4_000_000 }, (e: any, stdout, stderr) => {
      resolve({ code: e?.code && typeof e.code === "number" ? e.code : e ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function makeFleetServer(fleet: Fleet, sessions?: ManagedFleetService) {
  const peers = sessions ? bindPeerTools(sessions, 'foreman-pm') : undefined;
  const list_sessions = tool(
    "list_sessions",
    "List tracked Claude Code and Codex sessions on this machine with its state (needs_input, working, turn_finished, idle, ended, dead), name, directory, last message and last error. Same data the user sees in the session rail.",
    { include_ended: z.boolean().optional().describe("Include ended and dead sessions (default false)") },
    async ({ include_ended }) => {
      await fleet.refresh();
      if (peers) return fmt(await peers.call('list_sessions', { include_ended }));
      const rows = fleet.list()
        .filter((s) => include_ended || (s.state !== "ended" && s.state !== "dead"))
        .map((s) => ({
          name: s.name, session_id: s.session_id, session_key: s.session_key, provider: s.provider, state: s.state, reason: s.reason, kind: s.kind, cwd: s.cwd,
          current_tool: s.current_tool, active_subagents: s.active_subagents, updated_at: s.updated_at,
          last_message: s.last_message ? s.last_message.slice(0, 400) : null, last_error: s.last_error, bg_id: s.bg_id,
        }));
      return fmt(rows);
    },
    { annotations: { readOnlyHint: true } },
  );

  const list_models = tool('list_models', 'List available models for a provider before choosing a model for spawn_session. Omit model to use provider settings.',
    { provider: z.enum(['claude', 'codex']) }, async ({ provider }) => {
      try { return fmt({ provider, models: await modelCatalog.list(provider) }); }
      catch (error) { return err(error instanceof Error ? error.message : String(error)); }
    });
  const spawn_session = tool(
    "spawn_session",
    "Start a tracked session agent. Default mode 'managed' creates a Claude or Codex conversation in Foreman's durable service, controllable in the webapp and through peer tools. Legacy mode 'bg' uses the Claude supervisor; 'tab' opens Warp. State the goal, definition of done, and constraints in the prompt. Read managed outcomes with peers.session_tail and request_update; managed sessions do not support native SendMessage subscriptions.",
    {
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).describe("Short kebab-case task name, e.g. auth-refactor"),
      cwd: z.string().describe("Absolute path of the project directory"),
      prompt: z.string().min(20).describe("The full brief for the worker"),
      mode: z.enum(["managed", "bg", "tab"]).optional().describe("managed (default), bg, or tab"),
      provider: z.enum(["claude", "codex"]).optional().describe("Managed provider (default claude)"),
      permission_mode: z.enum([...PERMISSION_MODES, "default", "acceptEdits", "bypassPermissions"]).optional().describe("Managed launch preset: read-only, workspace (default), trusted, full. Above Workspace requires developer approval of this exact spawn call. Legacy modes accept only default, acceptEdits, bypassPermissions."),
      model: z.string().optional().describe("Optional model identifier from list_models for the selected provider; omit to use provider settings"),
    },
    async ({ name, cwd, prompt, mode, provider, permission_mode, model }) => {
      if (!existsSync(cwd)) return err(`cwd does not exist: ${cwd}`);
      if (mode === 'managed' || (!mode && sessions)) {
        if (!sessions) return err('Managed session service is unavailable');
        if (permission_mode && !PERMISSION_MODES.includes(permission_mode as PermissionMode)) return err('Managed permission_mode must be read-only, workspace, trusted, or full');
        try { return fmt(await sessions.create({ id: randomUUID(), provider: provider ?? 'claude', name, cwd, text: prompt, model, permission_mode: permission_mode as PermissionMode | undefined })); }
        catch (error) { return err(error instanceof Error ? error.message : String(error)); }
      }
      if (permission_mode && PERMISSION_MODES.includes(permission_mode as PermissionMode)) return err('Launch presets require managed mode');
      if (provider === 'codex') return err('Codex requires managed mode');
      if (mode === "tab") {
        if (!existsSync(WARP_SPAWN)) return err(`warp-spawn not found at ${WARP_SPAWN}`);
        const line = prompt.replace(/\s+/g, " ").trim();
        const r = await new Promise<string>((resolve) => {
          execFile(WARP_SPAWN, [line, cwd], { timeout: 20_000, env: process.env }, (e, so, se) => resolve(e ? `error: ${se || e.message}` : String(so)));
        });
        return fmt(`Requested a visible Warp tab for ${name} in ${cwd}. warp-spawn said: ${r.trim() || "ok"}. Note: tab sessions get their name from the first prompt; check list_sessions in a moment.`);
      }
      const args = ["--bg", "--name", name];
      if (permission_mode) args.push("--permission-mode", permission_mode);
      if (model) args.push("--model", model);
      args.push(prompt);
      const r = await runClaude(args, cwd);
      if (r.code !== 0) return err(`claude --bg failed (exit ${r.code}): ${r.stderr || r.stdout}`);
      setTimeout(() => fleet.refresh().catch(() => {}), 1500);
      return fmt(`Started background session "${name}" in ${cwd}.\n${r.stdout.trim()}\nSubscribe with SendMessage(to: "${name}", notify_when_idle: true) to be told when it finishes.`);
    },
  );

  const session_tail = tool(
    "session_tail",
    "Read the last few turns of a session's transcript (user and assistant text only, no code) to judge where it is. Use sparingly; prefer the worker's own outcome summary.",
    { session: z.string().describe("Session name, session_id, or bg id"), turns: z.number().int().min(1).max(30).optional() },
    async ({ session, turns }) => {
      await fleet.refresh();
      if (peers) {
        try { return fmt(await peers.call('session_tail', { session, limit: turns ?? 10 })); }
        catch (error) { return err(error instanceof Error ? error.message : String(error)); }
      }
      const s = fleet.get(session);
      if (!s) return err(`No session matches "${session}".`);
      if (s.transcript_path) return fmt(transcriptTail(s.transcript_path, turns ?? 10, s.provider));
      if (s.bg_id) { const r = await runClaude(["logs", s.bg_id]); return fmt(r.stdout.slice(-6000) || r.stderr); }
      return err("No transcript path known for this session yet (it may not have been prompted).");
    },
    { annotations: { readOnlyHint: true } },
  );

  const stop_session = tool(
    "stop_session",
    "Stop a background session (its conversation is kept and can be resumed). Only works for sessions run by the background supervisor.",
    { session: z.string().describe("Session name, session_id, or bg id") },
    async ({ session }) => {
      await fleet.refresh();
      const s = fleet.get(session);
      if (!s?.bg_id) return err(`"${session}" is not a background session; ask the user to close it where it runs.`);
      const r = await runClaude(["stop", s.bg_id]);
      return r.code === 0 ? fmt(`Stopped ${s.name ?? s.bg_id}.`) : err(r.stderr || r.stdout);
    },
  );

  const log_note = tool(
    "log_note",
    "Append one dated line to ~/.foreman/memory/LOG.md (decisions, outcomes). Use Write/Edit on PROJECTS.md for the project overview.",
    { note: z.string().min(3).max(500) },
    async ({ note }) => {
      const line = `- ${new Date().toISOString().slice(0, 16).replace("T", " ")} — ${note.replace(/\s+/g, " ").trim()}\n`;
      appendFileSync(join(MEMORY_DIR, "LOG.md"), line);
      return fmt("Logged.");
    },
  );

  return createSdkMcpServer({ name: "fleet", version: "0.1.0", tools: [list_sessions, list_models, spawn_session, session_tail, stop_session, log_note] });
}
