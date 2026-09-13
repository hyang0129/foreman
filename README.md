# Foreman

One agent to talk to, many agents doing the work.

Foreman tracks every Claude Code session on this machine through hooks and puts a **project
manager** agent in front of them. The PM keeps the high-level picture, starts session agents for
anything that touches code, watches them, and tells you what needs you. It never codes; the host
denies it the tools.

```
left rail: sessions + state        center: the project manager        right: session detail
```

## Quick start

```bash
npm install
npm run hooks:install      # registers hooks/foreman-hook in ~/.claude/settings.json (backup written)
npm start                  # http://localhost:4177
```

Hooks apply to sessions started after the install. Sessions already running show as "untracked"
with what Claude Code's own registry knows (name, directory, liveness).

## What is where

| Path | Role |
|---|---|
| `hooks/foreman-hook` | bash + jq; writes `~/.foreman/sessions/<id>.json` on every hook event |
| `scripts/install-hooks.mjs` | idempotent installer / `--uninstall` |
| `server/fleet.ts` | merges hook records, `~/.claude/sessions`, and `claude agents --json` |
| `server/pm.ts` | the PM: Agent SDK session, `canUseTool` enforces the no-code contract |
| `server/tools.ts` | PM's fleet tools: `list_sessions`, `spawn_session`, `session_tail`, `stop_session`, `log_note` |
| `server/main.ts` | HTTP + SSE + static |
| `agents/pm-system-prompt.md` | how the PM behaves |
| `docs/DESIGN.md` | design and roadmap |

State lives in `~/.foreman/` (sessions, events log, PM memory, PM session id). Override with
`FOREMAN_HOME`. `FOREMAN_CLAUDE_BIN` picks the `claude` used for `--bg` spawns and `agents --json`.

## The PM's contract

- Reads only documentation-shaped paths (docs, issues, markdown, README, ADRs) and `~/.foreman`.
- Writes only under `~/.foreman/memory` (`PROJECTS.md`, `LOG.md`).
- Bash limited to read-only `gh`, `git log/status`, `claude agents`.
- No subagents. Work goes to tracked sessions via `spawn_session` (`claude --bg --name …`, or a
  visible Warp tab with mode `tab`).
- Hears back through cross-session messaging (`SendMessage` with `notify_when_idle`).

## Status

v0, local only. See `docs/DESIGN.md` for the roadmap (notifications, attach button, remote hosts).
