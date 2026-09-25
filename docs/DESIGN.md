# Foreman — design

> Historical initial design. The current session-first Claude/Codex MVP, hosted relay, and PM restrictions are documented in [MVP plan](MVP_PLAN.md) and [README](../README.md). The sections [The PM agent](#3-the-pm-agent), [PM memory and the PM host](#pm-memory-and-the-pm-host) and [Data on disk](#data-on-disk) are current: they describe the portable PM (epic #26).

Foreman is a local control room for Claude Code sessions. You talk to one agent, the **project
manager (PM)**. The PM never codes. It keeps a high-level memory of what you are working on, starts
**session agents** to do the actual work, watches them through hooks, and tells you what needs your
attention.

Scope for v0: one machine. Remote fleets (other machines, cloud sessions) come later; the state
model is designed so a remote host can push the same records.

## The three parts

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  Browser  http://localhost:4177                                                    │
│  ┌──────────────┐  ┌───────────────────────────────────────┐  ┌────────────────┐  │
│  │ session rail │  │ PM chat                               │  │ session detail │  │
│  │ ● name  st.  │  │ you ⇄ project manager                 │  │ (on click)     │  │
│  │ ● name  st.  │  │                                       │  │ state, cwd,    │  │
│  └──────────────┘  └───────────────────────────────────────┘  │ last turns     │  │
│                                                               └────────────────┘  │
└───────────▲───────────────────────────▲───────────────────────────────────────────┘
            │ SSE                       │ SSE / POST
┌───────────┴───────────────────────────┴──────────────────────────────────┐
│  server/  (Node)                                                          │
│   fleet store ◄── watches ~/.foreman/sessions/*.json + ~/.claude/sessions │
│   PM host     ◄── Claude Agent SDK, disposable session, restricted tools  │
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
   messaging socket. Used for names and liveness (`kill -0 pid`). For sessions that predate the
   hooks, the store locates the transcript from cwd + session id and infers a coarse state from
   its last message record (best effort; the format is undocumented).
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

Sessions that predate the hook install have no record; the transcript fallback above fills in
`working` / `turn_finished` / `idle` for them. The store emits an SSE stream so the rail updates live.

### 3. The PM agent

Hosted in-process through the Claude Agent SDK (`server/pm.ts`). The provider session is
**disposable**: every start is a fresh session, `resume` is never passed, and Foreman keeps no PM
transcript anywhere. Each start reads the PM's memory from the PM state store and appends it to the
system prompt: the `projects` and `preferences` docs and the newest 40 log entries. The PM's durable
state is that memory, not its conversations.

**Contract (enforced in code by `canUseTool`, not just prompted):**

- It writes nothing on disk. `Write`, `Edit`, `MultiEdit` and `NotebookEdit` are denied everywhere;
  the denial points to the memory tools.
- `Read` is limited to existing document files (`.md`, `.txt`, `README`, `CHANGELOG` and similar).
  Anything under `FOREMAN_HOME` is denied, `memory/` included, so Foreman configuration,
  credentials and session files are unavailable to the PM.
- `Bash`, `Glob`, `Grep` and `Agent` are denied, and so is any tool not explicitly allowed. The
  denials tell it to delegate the work to a session.
- It gets an in-process MCP server, `fleet`, with `list_sessions`, `list_models`, `list_projects`,
  `resolve_project`, `register_project`, `spawn_session`, `session_tail` and `stop_session`, and a
  second one, `peers`, with the peer tools for managed sessions. A bypass launch is always denied:
  only the developer can start one.
- The same server carries the four memory tools, the **only** way to reach memory
  (`server/memory-tools.ts`):
  - `memory_read`;
  - `memory_write` (replace a whole doc) and `memory_edit` (replace text that occurs exactly once),
    both with an `expected_version` check;
  - `log_note` (append one log line of 3–500 characters).

  A version conflict, an oversize doc, or this machine no longer being the PM host comes back as a
  tool error with a next step. Nothing is retried automatically.

**Behavioural rules in the system prompt:** speak at the level of goals and outcomes; never walk the
user through implementation; when asked "how", answer "which session will do it"; before spawning,
check the fleet for a session already on it; after a session finishes, summarise the outcome in one
or two sentences; surface anything that needs the user (permission, question, failure) immediately.
Before ending any turn that changed project status, decisions, blockers or the developer's
preferences, the PM writes the change to memory. That write is the handoff. There is no separate
summarization turn.

## PM memory and the PM host

### Where PM memory lives

PM memory belongs to the PM, not to one machine. It has four parts:

- the `projects` doc (at most 32 KiB). The prompt tells the PM to keep one `## <project name>`
  section per project, with its goal, state, decisions, blockers and owning session names;
- the `preferences` doc (at most 8 KiB);
- an append-only `log` (entries of 3–500 characters, newest 2000 kept);
- the PM `model` setting.

Where they are kept depends on the mode (`server/pm-store.ts`):

- **Relay mode** (a `cloud.json` pairing, or the relay env): in the relay's Durable Object
  (`cloud/pm-state.ts`). The host keeps no copy on disk. Memory is read from the Durable Object at
  every fresh PM session start, and the memory tools write straight to it.
- **Local-only mode** (no `cloud.json` and no relay env): in `<FOREMAN_HOME>/pm/state.json`
  (mode 0600), with the same limits and version checks.

The PM is told to keep no filesystem paths in memory (a prompt rule; the store does not check it).
Projects are keyed by name. The PM resolves a name to a directory on the current machine with
`resolve_project`, and asks when the name is not registered there.

The model chosen in the PM view is saved with the memory, so it follows the PM to another machine.
If that model is not available there, the provider's error is shown as usual; nothing is
substituted. `FOREMAN_PM_MODEL` is used only while no model has been saved.

**Store selection fails closed** (`choosePmStore` in `server/pm.ts`, called from `server/main.ts`):

- No `cloud.json` and neither `FOREMAN_RELAY_URL` nor `FOREMAN_HOST_TOKEN`: local-only mode.
- A valid relay configuration: relay mode.
- A `cloud.json` that is present but invalid (bad JSON, missing fields, a mode other than 0600, the
  wrong owner, a symlink), invalid relay env, or a relay whose connection could not be started:
  **no PM on this machine.** PM sends and `/api/memory` return 503 naming the cause. No store is
  opened, nothing is imported, and no `pm/state.json` is created. The rest of the daemon keeps
  running and the file is left alone. It never falls back to a local PM built from this machine's
  files.
- An invalid, symlinked or foreign-owned `machine.json`, or an invalid `FOREMAN_MACHINE_NAME`, also
  means no PM on this machine: sends return 503 `machine.json is invalid (…)`, and the file is never
  replaced. A corrupt `pm/state.json` is handled the same way.

### One PM at a time

Each `FOREMAN_HOME` is one **machine**. `machine.json` holds a random `machine_id` and a display
name (`server/machine.ts`). The name defaults to the short hostname. `FOREMAN_MACHINE_NAME` overrides
it, and the override is saved to `machine.json`. Every daemon with a valid identity greets the relay
with a protocol-2 hello: its `machine_id`, name and platform, and the PM turns it still holds.
Several machines can be connected at once, and the relay remembers up to 16.

The Durable Object records exactly one **active PM host**, with an **epoch** (`cloud/worker.ts`,
`cloud/pm-state.ts`):

- The first machine to send a protocol-2 hello becomes the PM host at epoch 1 (`assigned_by:
  'bootstrap'`), because no PM exists yet to move. Later hellos never change it.
- After that, only the developer changes it, with **Move PM…** in the PM view of the hosted app.
  The dialog is offered only when another machine is online. It sends `POST /api/pm/host` with the
  epoch the page loaded. The target must be online, and the request fails with 409 if the epoch has
  changed in the meantime. The old host may be offline: that is the machine-loss case. Each move
  increments the epoch.
- Every PM state write carries the epoch. A write from a machine that is no longer the PM host is
  rejected (`stale_epoch` or `not_active`) and changes nothing, and that machine stops its PM.
- A host runs a PM only while it is connected to the relay **and** holds the current assignment:
  - A machine that is not the PM host refuses PM sends, from its local UI too, with "The PM runs on
    <name>." If this machine was running the PM and its daemon was not restarted, its PM view also
    gets the entry "The PM now runs on <name>." when it learns of the move: at once if it was
    connected during the move, otherwise when it reconnects.
  - A machine that cannot reach the relay refuses them with "The cloud relay is unreachable; the PM
    is unavailable on this machine." It cannot know it is still the PM host, so it fails closed.
- Local-only mode is always its own PM host, at epoch 1, and there is nowhere to move the PM.

**Relay traffic goes only to the active PM host**: sessions, projects, launches and the PM alike.
Other connected machines are standbys. They receive no relayed requests, and the hosted app shows
them only in the Move PM dialog's machine list. When the PM host is down, relayed requests get 503
"Your PM's machine (<name>) is offline." The hosted app's host status and the offline push
notification follow the active PM host too. The Worker answers `GET` and `POST /api/pm/host` itself
and never relays them, so the machine list and Move PM work while the PM host is offline.

In relay mode the PM can be moved only from the hosted app. A daemon's local UI gets 404 from
`GET /api/pm/host`, because the host cannot see the other machines, and 400 from
`POST /api/pm/host`.

### What stays on each machine

Worker-level state is per machine and never moves:

- managed sessions, with their histories and receipts;
- provider transcripts and worktrees;
- hook records;
- the project registry (`projects.json`: names, aliases and paths);
- `machine.json`.

After a move, the old machine's sessions keep running, but only its own local UI
(`http://localhost:4177`) shows them, because the hosted app talks to the PM host alone.

### The one-time import

The first time a machine becomes the active PM host while the store's memory has never been
initialized, it imports the pre-portable memory from its own `FOREMAN_HOME` (`server/pm-store.ts`):

- `memory/PROJECTS.md` becomes the `projects` doc. Over 32 KiB it is cut at a line boundary, and the
  cut is logged.
- Each `- ` line of `memory/LOG.md` becomes a log entry. Lines shorter than 3 characters are dropped,
  lines longer than 500 are truncated, and the newest 2000 are kept.
- The `model` in `pm/settings.json` becomes the saved model. `preferences` starts empty.

The sources are only read, never modified or deleted. The import then writes
`memory/.imported.json` (`{ machine_id, at, target }`, where `target` is `relay` or `local`).

**First importer wins.** Memory counts as initialized after an import or after a first memory
write. A later import from another machine is then a logged no-op ("relay memory already
initialized; local memory not imported"), and nothing is merged. A standby never imports: the
import runs on activation. In local-only mode it runs the first time the daemon creates
`pm/state.json`.

`pm/history.jsonl`, `pm/session` and `pm/session.quarantine.jsonl` are not imported, and Foreman no
longer reads or writes them. They are left on disk and are safe to delete by hand.

### Conversations are not kept

- **The conversation lives only in the daemon's memory.** The PM view's conversation holds at most
  200 entries, and `/api/pm/history` returns it. It is **empty after a daemon restart, and whenever
  this machine becomes the PM host** (a move). The PM view then says "New conversation. The PM
  remembers projects and decisions, not past chats."
- **A fresh session in the same process keeps the conversation.** That happens on recovery after a
  provider failure, or under the hung-provider rule below. It adds one neutral entry: "Started a
  fresh PM session. It answers from memory, not from the messages above."
- **Every message is recorded before it is sent.** `POST /api/pm/message` answers 202 only after the
  store has durably recorded the turn (write-ahead) and the message was dispatched. If the record
  cannot be written, the send fails with 503 and its cause, and nothing is dispatched. The record
  holds a turn id, the send time, the machine and the epoch, and never the message text.
- **An interrupted message is reported once as uncertain, and never replayed.** The next PM
  conversation shows one error entry for each such message: "Your message sent at <time> to the PM
  on <host> could not be confirmed (<reason>). It was not replayed." The reasons are:
  - *Foreman restarted*: the daemon restarted while the turn was open (relay or local-only mode);
  - *the PM was moved*: the PM moved while the old host was online;
  - *machine went offline*: the PM moved off a machine that was offline;
  - *the PM stopped responding*: the hung-provider rule.

  Input that a stopped provider had already taken is reported the same way ("the PM stopped:
  <cause>"). Input it never read is reported as not delivered. A reply that cannot be matched to its
  message is reported as uncertain, never as completed. Each of these entries also becomes the PM's
  current error, so it shows the PM error indicator and can send a "project manager error" push
  notification.
- **A network blip is not an interruption.** A closed relay socket marks nothing. Each reconnect
  hello lists the turns the PM still holds, so a turn that finishes across a short drop produces no
  uncertain entry. While the socket is down, new sends are refused.

### Hung provider

Suppose a message is outstanding and the provider has sent nothing for **5 minutes**
(`FOREMAN_PM_HUNG_MS` overrides this, in milliseconds; the macOS service installer does not pass it
to the installed service). The next message you send then acts on it:

1. Every outstanding message is reported as uncertain (*the PM stopped responding*).
2. The provider is retired.
3. A fresh session starts.
4. Only the new message is dispatched.

Before the threshold, new messages queue as usual. Nothing is timer-driven: if you send nothing,
nothing happens, and Stop still works.

## Data on disk

`~/.foreman`, or `FOREMAN_HOME` when set. Everything in it belongs to this machine.

| Path | Purpose |
|---|---|
| `sessions/<session_id>.json` | Hook records |
| `events.jsonl` | Append-only hook log (rotated at 20 MB) |
| `managed/` | Managed session snapshots, histories and receipts |
| `projects.json` | Project registry: names, aliases and paths on this machine |
| `local-api-token` | Token for the loopback UI and API |
| `cloud.json` | Relay pairing (`url`, `token`), mode 0600. The same file on every paired machine; see [Cloud setup](CLOUD_SETUP.md#add-a-second-machine) |
| `machine.json` | This machine's identity, `{ machine_id, name }`, mode 0600. Never copy it to another machine |
| `pm/state.json` | Local-only mode only: PM memory, model and in-flight turn records, mode 0600 |
| `memory/.imported.json` | Written once by the one-time import: `{ machine_id, at, target }` |
| `memory/PROJECTS.md`, `memory/LOG.md` | **Retired.** Import sources only. Kept untouched; no longer the PM's memory |
| `pm/settings.json` | **Retired.** Only the import reads its `model`; no longer written |
| `pm/history.jsonl`, `pm/session`, `pm/session.quarantine.jsonl` | **Retired.** Never read or written; safe to delete by hand |
| `vapid.json` | Web Push signing key, created by `npm run cloud:deploy` on the machine that deploys, mode 0600 |
| `logs/` | macOS service stdout and stderr |

In relay mode the PM's memory, its model and its in-flight turn records are not on disk at all:
they live in the relay's Durable Object.

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
