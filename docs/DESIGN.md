# Foreman — design

Foreman is a local control room for Claude Code sessions. You talk to one agent, the **project
manager (PM)**. The PM never codes. It keeps a high-level memory of what you are working on, starts
**session agents** to do the actual work, watches them through hooks, and tells you what needs your
attention.

Scope for v0: one machine. Remote fleets (other machines, cloud sessions) come later; the state
model is designed so a remote host can push the same records.

## The three parts

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Browser  http://localhost:4177                                          │
│  ┌──────────────┐  ┌──────────────────────────────────────────────────┐  │
│  │ session rail │  │ PM chat                                          │  │
│  │ ● name  st.  │  │ you ⇄ project manager                            │  │
│  │ ● name  st.  │  │                                                  │  │
│  └──────────────┘  └──────────────────────────────────────────────────┘  │
└───────────▲───────────────────────────▲──────────────────────────────────┘
            │ SSE                       │ SSE / POST
┌───────────┴───────────────────────────┴──────────────────────────────────┐
│  server/  (Node)                                                          │
│   fleet store ◄── watches ~/.foreman/sessions/*.json + ~/.claude/sessions │
│   PM host     ◄── Claude Agent SDK, persistent session, restricted tools  │
└───────────▲───────────────────────────────────────────────────────────────┘
            │ hook events (every Claude Code session on the machine)
┌───────────┴───────────────────────────────────────────────────────────────┐
│  hooks/foreman-hook   installed once into ~/.claude/settings.json          │
└───────────────────────────────────────────────────────────────────────────┘
```

### 1. Hooks: every session logs itself

`hooks/foreman-hook <event>` is registered globally in `~/.claude/settings.json`. It runs for every
Claude Code session on the machine, whatever started it: VS Code extension, a Warp tab,
`claude --bg`, mngr, the SDK, or the PM itself. It reads the hook JSON on stdin and writes one
record per session to `~/.foreman/sessions/<session_id>.json`, plus an append-only
`~/.foreman/events.jsonl`.

| Hook event | Foreman state | Notes |
|---|---|---|
| `SessionStart` | `idle` | records `cwd`, `source`, `started_at` |
| `UserPromptSubmit` | `working` | clears needs-input |
| `PreToolUse` | `working` | records `current_tool` |
| `PermissionRequest` | `needs_input` / `permission` | |
| `Notification` `permission_prompt` | `needs_input` / `permission` | prompt waited ~6 s |
| `Notification` `elicitation_dialog` | `needs_input` / `dialog` | |
| `Notification` `idle_prompt` | `idle` | turn ended ~60 s ago, nothing typed |
| `Stop` | `turn_finished` | stores `last_message` (the final assistant text) |
| `PostToolUseFailure` | unchanged | stores `last_error` |
| `SubagentStart` / `SubagentStop` | unchanged | `active_subagents` counter |
| `SessionEnd` | `ended` | stores `end_reason` |

The hook is `async` for everything except `SessionEnd`, so it never slows a session. It is a bash
script that depends only on `jq`.

Why hooks and not transcript parsing: transcripts are undocumented and drift by version, and a
permission prompt leaves no trace on disk. Hooks are the supported contract, and this is the exact
mechanism Imbue's mngr uses internally.

### 2. Fleet store: one list, several sources

`server/fleet.ts` merges three sources into one `Session[]`:

1. `~/.foreman/sessions/*.json` — hook records (authoritative for state).
2. `~/.claude/sessions/<pid>.json` — Claude Code's own live registry: display name, cwd, pid,
   messaging socket. Used for names and liveness (`kill -0 pid`).
3. `claude agents --json --all` — background sessions run by the supervisor, with native state.

Derived states shown in the rail:

| State | Meaning | Source |
|---|---|---|
| `needs_input` | waiting on a permission, a question, or a dialog | hook |
| `working` | mid-turn, tool running, or subagents active | hook |
| `turn_finished` | finished a turn, waiting for a next prompt | hook `Stop` |
| `idle` | never prompted, or idle for a minute | hook |
| `ended` | exited cleanly | hook `SessionEnd` |
| `dead` | pid gone without a `SessionEnd` | store, liveness pass |

Sessions that predate the hook install have no record and show as `unknown` with whatever the
registry knows (name, cwd, age). The store emits an SSE stream so the rail updates live.

### 3. The PM agent

Hosted in-process through the Claude Agent SDK as a single long-lived session (`resume` across
restarts; the session id is kept in `~/.foreman/pm/session`). It is a real Claude Code session, so it
gets the cross-session tools: it can `ListAgents`, `SendMessage` a session agent, and subscribe with
`notify_when_idle` so finished work is pushed to it.

**Contract (enforced in code, not just prompted):**

- It never edits code. `Edit`, `Write`, `MultiEdit`, `NotebookEdit` are denied except under
  `~/.foreman/memory/`.
- `Read`/`Glob`/`Grep` are limited to documentation-shaped paths: `docs/`, `*.md`, `issues/`,
  `.github/`, `README*`, `CHANGELOG*`, plus `~/.foreman/`. Everything else is denied with a message
  telling it to delegate.
- `Bash` is limited to an allowlist: `gh issue|pr` (read), `git log|status|branch`, `claude agents
  --json`, and the `foreman` tools below.
- It gets an in-process MCP server with the fleet tools:
  - `list_sessions()` — the merged fleet, same data as the rail.
  - `spawn_session({name, cwd, prompt, mode})` — runs `claude --bg --name <name> "<prompt>"` in
    `cwd` (mode `bg`, default), or `warp-spawn` (mode `tab`) for a visible tab.
  - `session_transcript_tail({session_id, n})` — last n turns of a session, for review.
  - `stop_session({id})` — `claude stop`.
- Memory: it maintains `~/.foreman/memory/PROJECTS.md` (one paragraph per active project: goal,
  current state, open questions, owning sessions) and `~/.foreman/memory/LOG.md` (dated decisions).
  These are injected at session start. Implementation detail never goes in them.

**Behavioural rules in the system prompt:** speak at the level of goals and outcomes; never walk the
user through implementation; when asked "how", answer "which session will do it"; before spawning,
check the fleet for a session already on it; after a session finishes, summarise the outcome in one
or two sentences and update memory; surface anything that needs the user (permission, question,
failure) immediately.

## Data on disk

```
~/.foreman/
  sessions/<session_id>.json   hook records
  events.jsonl                 append-only hook log (rotated at 20 MB)
  memory/PROJECTS.md           PM memory: what we are working on
  memory/LOG.md                PM memory: dated decisions and outcomes
  pm/session                   PM session id for resume
```

Record schema (`sessions/<id>.json`):

```json
{
  "session_id": "…", "name": "auth-refactor", "cwd": "/Users/hong/code/x",
  "state": "needs_input", "reason": "permission", "source": "startup",
  "permission_mode": "default", "current_tool": "Bash", "active_subagents": 0,
  "last_message": "Tests pass. Ready for review.", "last_error": null,
  "started_at": "2026-09-12T19:00:00Z", "updated_at": "2026-09-12T19:31:12Z", "ended_at": null,
  "end_reason": null, "transcript_path": "…", "host": "hongs-macbook-air"
}
```

`host` is present from day one so a remote host can push the same records into the same store
later (rsync, a small HTTP endpoint, or a shared directory).

## Roadmap

- **v0 (this repo):** hooks, fleet store, PM host, web UI with rail + chat, spawn via `claude --bg`.
- **v0.1:** notifications split by urgency (terminal-notifier locally; phone via Remote Control's
  `PushNotification` from the PM); attach button that opens `claude attach <id>` in a Warp tab.
- **v1:** remote hosts push records; PM can spawn on a remote host (ssh + `claude --bg`, or mngr);
  per-project views.

## Non-goals

- Replacing VS Code or Warp. Sessions stay wherever you started them.
- A kanban of PRs. `gh` and the agent view already do that; the PM can read it.
- Making the PM smart about code. It reads issues and docs, and delegates.
