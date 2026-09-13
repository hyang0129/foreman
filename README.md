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

## Codex monitoring and session control

```sh
npm run hooks:codex:install
# In Codex: /hooks → review and trust the Foreman entries, then start/resume a session.
npm run status
```

The fleet and session detail UI distinguish Claude and Codex records. Use `session_key`
(`claude:<id>` or `codex:<id>`) when routing a request; ambiguous names/IDs are rejected.
Codex hooks serialize updates and preserve turn completion against late events. A stale hook
record without process evidence is shown as unknown, not proof that a process died.
Legacy Codex JSONL transcripts can be displayed; paginated history is available through the
Codex app-server adapter. Monitoring begins when Codex actually runs the trusted hooks.

`server/claude-control.ts` provides queued SDK input, receipts, permission responses, and a
stopped-session handoff. `server/codex-control.ts` supports stdio-owned sessions or attachment
to a running app-server over a local Unix socket, including history, queueing, steering,
interruption, and permission responses. These are integration modules; the web UI still sends
messages only to the PM. Full session chat and the hosted relay are subsequent work.

The live probes use disposable sessions and consume provider usage only with `--live`:

```sh
npm run probe:claude -- --live
npm run probe:claude:peer -- --live
npm run probe:codex -- --live
```

Set `FOREMAN_CODEX_BIN` to a Codex executable that supports your configured model. On this
machine, the shell CLI 0.149.0 rejected the configured model; the live proof passed using the
newer installed VS Code binary 0.154.0-alpha.6.2. A separate manual test also verified
that a real Codex terminal connected to the shared app-server displays externally submitted turns. The installed Foreman service records that
executable override. See [the blocker and proof report](docs/BLOCKERS.md) for tested boundaries.

## Background service

On this Mac, Foreman is installed as a user LaunchAgent on port 4177. It restarts automatically
and prevents system sleep while on AC power. Keep the user logged in, the lid open, and power
connected; battery operation, explicit sleep, and shutdown can take it offline.

```sh
npm run service:status
npm run service:restart    # interrupts active PM work
npm run service:uninstall
```

Do not start another `npm start` while the service owns the port. Configuration, logs,
installation on another host, and availability limits are in [Execution host](docs/EXECUTION_HOST.md).

Run `npm test` and `npm run typecheck` for local verification. These do not call models.

## The PM's contract

- Reads only documentation-shaped paths (docs, issues, markdown, README, ADRs) and `~/.foreman`.
- Writes only under `~/.foreman/memory` (`PROJECTS.md`, `LOG.md`).
- Bash limited to read-only `gh`, `git log/status`, `claude agents`.
- No subagents. Work goes to tracked sessions via `spawn_session` (`claude --bg --name …`, or a
  visible Warp tab with mode `tab`).
- Hears back through cross-session messaging (`SendMessage` with `notify_when_idle`).

## Status

Local only, with Claude/Codex control proofs and a background service. Cloudflare hosting,
Firebase sign-in, session chat, and shared cross-provider tools are not deployed yet.
See `docs/BLOCKERS.md` for current readiness and `docs/DESIGN.md` for the original design.
