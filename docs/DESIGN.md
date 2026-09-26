# Foreman — design

> Historical initial design. The current session-first Claude/Codex MVP and hosted relay are documented in [MVP plan](MVP_PLAN.md) and [README](../README.md). These sections are current: [The Coordinator](#3-the-coordinator) and [Leads and workers](#leads-and-workers) (epic #157), [PM memory and the PM host](#pm-memory-and-the-pm-host) (the portable PM, epic #26), and [Data on disk](#data-on-disk).

> **Naming.** The project manager (PM) is now called the **Coordinator** everywhere the developer
> reads it (epic #157). Wire and storage names keep `pm`: `/api/pm/*`, the `pm_rpc` frame, the
> Durable Object's `pm_*` tables, `?view=pm`, the `pm_failed` notification kind and the native
> session name `foreman-pm`. This page says "PM" where it describes those, and in the historical
> parts.

Foreman is a local control room for Claude Code sessions. You talk to one agent, the
**Coordinator** (formerly the project manager, PM). The Coordinator never codes. It keeps a
high-level memory of what you are working on, starts **Project Leads** that own the actual work,
and tells you what needs your attention.

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

### 3. The Coordinator

Hosted in-process through the Claude Agent SDK (`server/pm.ts`). The provider session is
**disposable**: every start is a fresh session, `resume` is never passed, and Foreman keeps no
Coordinator transcript anywhere. Each start reads the Coordinator's memory from the PM state store
and appends it to the system prompt (`agents/coordinator-system-prompt.md`): the `projects` and
`preferences` docs, the newest 40 log entries, and a `## leads` section. That section lists up to 20
non-archived Leads from the Lead registry, newest first, with state, mode, pending approvals,
workers, the latest handoff's status and summary, and whether each Lead is on this machine or "on
<machine>, not reachable from here". After them it lists Leads ended by a restart and not yet
superseded (at most 5 of the 20), marked "ended (restarted)" with their latest handoff, so the
Coordinator can offer the developer a successor. The registry read is bounded to 3 s; when it
fails, the section says so. The Coordinator's durable state is that memory, not its conversations.

**Model and effort.** The model is the saved `pm_settings.model`, then `FOREMAN_PM_MODEL`, then the
role default `opus[1m]` (Opus 5.5). Effort comes from the role config: the developer's Settings
(`roles.coordinator.effort`), then `FOREMAN_PM_EFFORT`, then `medium`. It is read once per fresh
start.

**Contract (enforced in code by `canUseTool` and a PreToolUse hook, not just prompted):**

- It writes nothing on disk. `Write`, `Edit`, `MultiEdit` and `NotebookEdit` are disallowed; the
  denial points to the memory tools.
- `Read` is limited to existing document files (`.md`, `.txt`, `README`, `CHANGELOG` and similar).
  Anything under `FOREMAN_HOME` is denied, `memory/` included, by path and by file identity, so
  Foreman configuration, credentials and session files are unavailable to it.
- `Bash`, `Glob` and `Grep` are denied on its own thread, and so is any tool not explicitly allowed.
  The denials tell it to give the work to a Lead.
- It has **no `spawn_session`** in any mode. It starts Leads, and Leads start workers.
- Its in-process MCP servers are `fleet` (`list_sessions`, `list_models`, `list_projects`,
  `resolve_project`, `register_project`, `session_tail`, `stop_session`, and the memory tools),
  `peers` (the peer tools, sender `coordinator`), and `leads` (`start_lead`, `retire_lead`,
  `list_leads`, `read_handoff`; see [Leads and workers](#leads-and-workers)).
- `Agent` is allowed only with `subagent_type: "investigator"`, in the foreground: `isolation` and
  `mode` are refused and `run_in_background` is forced to `false`.
- The memory tools are the **only** way to reach memory (`server/memory-tools.ts`):
  - `memory_read`;
  - `memory_write` (replace a whole doc) and `memory_edit` (replace text that occurs exactly once),
    both with an `expected_version` check;
  - `log_note` (append one log line of 3–500 characters).

  A version conflict, an oversize doc, or this machine no longer being the Coordinator host comes
  back as a tool error with a next step. Nothing is retried automatically.

**Behavioural rules in the system prompt:** speak at the level of goals and outcomes; never walk the
developer through implementation; send all research, design, implementation and review to a Lead;
prefer a new Lead over reuse (message an alive Lead only to steer its current task; any new task, or
a Lead that is dead, ended, or idle for more than 2 h, gets a new Lead); put pending approvals in the
first line of the reply. Before ending any turn that changed project status, decisions, blockers,
Leads or the developer's preferences, the Coordinator writes the change to memory. That write is the
handoff. There is no separate summarization turn. The Coordinator gets **no automatic turns** from
Lead events: it answers from the registry when the developer asks.

#### Investigators

For small read-only lookups the Coordinator starts SDK subagents of type `investigator` inside its
own query. They are not sessions: they never appear in the chat list, and each result comes back
as one `Agent` tool line in the Coordinator chat. Every tool call a subagent makes carries
`agent_id`, and the hook applies these rules to it (`investigatorDecision` in `server/pm.ts`):

- **Tools:** `Read`, `Grep`, `Glob`, `Bash`, `WebFetch` and `WebSearch`, at most 15 turns. Writes,
  `Agent`, and the fleet, Lead, peer and memory tools are denied.
- **Protected locations.** `Read`, `Grep`, `Glob` and `git -C` need an existing path, resolved with
  realpath. Refused: `FOREMAN_HOME`; home credential and agent-state locations (`~/.ssh`,
  `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.config/gh`, `~/.aws`, `~/.gnupg`, `~/.docker`,
  `~/.kube`, `~/.netrc`, `~/.npmrc`, `~/.git-credentials`, `~/Library/Keychains` and similar); the
  process's `CLAUDE_CONFIG_DIR` and `CODEX_HOME`; and any `.env*` file. They are matched by path
  and by **file identity** (device and inode), so a symlinked parent, a hard link or a macOS alias
  path (`/System/Volumes/Data`, `/.nofollow`, `/.resolve`, which are refused outright) cannot reach
  them. A directory that contains a protected location, such as `~` or `/`, is refused too.
- **Grep and Glob** need an explicit `path`, and their patterns cannot leave that directory or
  target `.env`. Grep with `output_mode: "content"` needs a single readable file, and a directory
  Grep always excludes `.env` files.
- **Bash** allows only these command families, with no shell metacharacters, quotes, variables,
  globs or redirection (a character whitelist): `gh issue view|list`, `gh pr view|list|diff|checks`,
  `gh run view|list`, and `git -C <absolute checkout directory> log|show|status|diff|branch`.
  `gh api`, gh's global flags, `--web` and `--watch` are refused. For git, options that write
  files, run programs or read outside the repository are refused (`--output`, `--ext-diff`,
  `--textconv`, `--no-index`, `--orderfile`/`-O`, `--exec`, `--upload-pack`, `--config-env`,
  signature formats and their abbreviations), as are absolute or `..` path arguments and any
  argument naming `.env`; `git branch` may only list.
- **Forced git options.** The hook rewrites every allowed git command to run with `--no-pager
  -c core.fsmonitor=false -c log.showSignature=false`, and `log`, `show` and `diff` also with
  `--no-ext-diff --no-textconv`.
- **Concurrency:** at most 3 investigators at once. A slot is reserved at the `Agent` call and
  released when the subagent stops or the call ends.
- **Model and effort** come from the role config: Settings (`roles.investigator`), then
  `FOREMAN_INVESTIGATOR_MODEL` / `FOREMAN_INVESTIGATOR_EFFORT`, then `opus` at `low`. The
  Coordinator may choose a different model for one investigator through the `Agent` tool's own
  `model` input.

**Known residual risks.** These are accepted, not fixed:

- A repository's own `.git/config` can still define behaviour the forced options do not turn off
  (for example clean/smudge filters), which a read-only git command in that checkout may run.
- Content already committed in git history is readable with `git show`/`git log`, even where the
  current file would be refused.
- An investigator may read any file outside the protected locations, and `WebFetch` is allowed, so
  a prompt-injected investigator could send out a non-credential file it read.

## Leads and workers

Epic #157 adds three session roles next to the developer's own sessions (`role: 'session'`):

- **Coordinator** — the pinned chat above. It starts, tracks and replaces Leads.
- **Lead** (`role: 'lead'`) — a managed Claude session that owns one workstream of one project. It
  plans, starts worker sessions, reviews their outcomes and writes handoffs. Its prompt is
  `agents/lead-system-prompt.md`; its tools are the peer tools plus a `lead` MCP server
  (`write_handoff`, `spawn_session`, `list_workers`), bound by the host to its own session key.
- **Worker** (`role: 'worker'`) — a managed session a Lead starts for one bounded implementation
  task, with `parent` and `launched_by` set to that Lead. Workers get peer tools only: no spawn
  tool.

Every managed row reports `role` and `launched_by` (`developer`, `coordinator` or a Lead's session
key); older records read as `session` / `developer`. Agent launches also record `parent`,
`supersedes` / `superseded_by`, `workstream`, `effort`, `policy_reason` and `bypass_grant`. Their
permission policy is described in [Agent launches](SESSION_PERMISSIONS.md#agent-launches).

### Starting a Lead

`start_lead { project, workstream, goal, first_task, permission_mode?, model?, effort?, supersedes?,
force?, machine? }`:

- `project` is a registered project name or alias, never a path. It must be registered on **this**
  machine; otherwise the call fails. The Lead runs in that checkout on the Coordinator's machine.
  `machine`, when given, must name this machine; any other machine is refused, pointing at #162
  (cross-machine Leads are a follow-up epic).
- The Lead is named `lead-<workstream>`, runs Claude, and gets its model and effort from the role
  config unless `start_lead` passes them: Settings (`roles.lead`), then `FOREMAN_LEAD_MODEL` /
  `FOREMAN_LEAD_EFFORT`, then `opus[1m]` at `medium`.
- `goal` must not contain filesystem paths. The Lead's first message is the goal and first task,
  plus the predecessor's handoff and live workers when it supersedes one.
- The result reports `seeded_from` (`{ lead, seq, kind }` of the predecessor handoff the new Lead
  was seeded from, or `null`) and `own_seed_seq` (the `seq` of the new Lead's own `seed` handoff).
  If that seed handoff could not be recorded, the Lead still runs and `own_seed_error` says so.

A Lead's `spawn_session { name, prompt, model?, effort?, permission_mode?, cwd? }` starts a managed
Claude worker (no `bg` or `tab` modes). `cwd` defaults to the Lead's own checkout; otherwise it is a
registered project or an existing absolute directory.

**Role rules** are enforced by the host (`SessionService.launchAgent`): only the Coordinator starts a
Lead, so a Lead cannot start a Lead; a worker's parent must be an active Lead, which is the one
starting it; workers have no spawn tool.

### Limits

Enforced by the host, not the prompt, and checked before and after the grant read:

- at most **3 active Leads** (`FOREMAN_MAX_LEADS`);
- at most **4 active workers per Lead** (`FOREMAN_MAX_WORKERS_PER_LEAD`).

The overrides are positive integers; anything else keeps the default. They are read from the
daemon's environment; the macOS service installer does not copy them into the installed service,
and the dev preview scripts (`npm run dev:*`) refuse any inherited `FOREMAN_*` variable.
Active means not `ended`, `dead` or `unknown`. Held Bypass launches count toward both limits. A Lead
that the new launch supersedes is not counted, so superseding one of 3 Leads works with every slot
in use. The refusal names the limit and its variable.

### Supersede and retire

Starting a Lead on the same project and workstream, or with an explicit `supersedes`, supersedes the
old Lead:

- The new Lead's first message carries the goal, the old Lead's latest handoff and its live workers.
  When the old Lead is on this machine and has no `final` handoff, it also gets a warning to check
  branches and PRs first, and the old Lead's last 10 messages. The `seed` handoff written to the registry holds only the goal and the predecessor's
  handoff content, never the first task or transcript text.
- A **working** old Lead (working, or waiting on a real approval) is refused unless `force: true`,
  which interrupts and retires it. An idle, finished or dead one is retired.
- The old Lead is retired only **after** the new one launched. If the new Lead is a held launch, the
  old one keeps running and is retired only when the developer approves (a denied or expired launch
  retires nothing).
- Retiring sets `ended` with `end_reason: superseded by <key>` and `superseded_by`. It never marks the
  session unavailable, so no `session_failed` push is sent. The old chat stays readable under
  **Archived**, and its workers keep running.
- A Lead on another machine is not retired ("not reachable from here"); the new Lead is seeded from
  its registry handoff.

`retire_lead { lead, force? }` ends a Lead the same way.

### Handoffs

A handoff is a structured record (`LeadHandoff` in `shared/roles.ts`, at most 32 KiB): `kind`
(`seed`, `checkpoint` or `final`), `status`, goal, summary, decisions, open questions, next steps and
links (`https://` URLs or `branch:<name>`). The host fills in the Lead, a per-Lead monotonic `seq`,
the time, the project, the workstream and the workers. Handoffs hold no filesystem paths; project and
workstream are names, and `write_handoff` refuses text that embeds a home or system path. The host
writes a `seed` handoff when a Lead starts, and the Lead writes `checkpoint` handoffs and a `final`
one before it ends (a prompt rule).

- **On the machine first.** Each handoff is appended to `<FOREMAN_HOME>/leads/<uuid>.jsonl` (directory
  0700, files 0600). The next `seq` is one past the highest in that file, so it survives restarts.
  The tool returns after the local write, not after the relay acknowledges it.
- **Outbox (relay mode).** The handoff is also queued in `leads/outbox.json` (0600) and flushed in
  order over `lead_rpc` (`lead.handoff`). The Durable Object deduplicates by `(lead, seq)` and keeps
  the newest 20 per Lead. A transient failure keeps the entry for the next hello or 4-minute tick. A
  handoff whose Lead row has not reached the relay yet waits for it, and is dropped from the outbox
  (kept in the local log) after 24 h. A refused handoff is dropped with a log line and never retried.
- **Local-only mode** keeps the same files and no outbox. Handoffs written while local-only never
  reach the relay, even if the machine is paired later.

### The Lead registry

The registry is the Durable Object's `leads` table: one row per Lead with its machine, state, mode,
model and effort, pending approvals (its own and its workers'), workers and latest handoff.

- The host sends a row on each state change, coalescing further changes to the same Lead into one
  send per 30 s. It resyncs all of its rows on every hello and every 4 minutes while connected, so a
  connected machine's rows are at most about 5 minutes old.
- `lead_rpc` is accepted from any identified (hello v2) machine, not only the active Coordinator
  host, so Leads left on a standby keep syncing. A machine may write only its own rows.
- When the registry is read, the relay computes `machine_online` from its live sockets and returns
  `reported_at`. A Lead whose machine is offline shows its last known state ("machine offline · last
  known state at T"); handoffs written meanwhile arrive after the machine reconnects.
- The relay keeps at most 200 Lead rows, pruning the oldest ended ones first.
- The Coordinator reads it with `list_leads` and `read_handoff`. When the relay cannot answer, those
  fall back to this machine's own rows and handoff files, marked `local`.

The hosted app reads it through `GET /api/leads`, which the Worker answers itself, so it works while
the host is offline. Leads run only on the Coordinator's machine in this epic, and the hosted app
shows chats only for the Coordinator's machine; a Lead on another machine is visible in the registry
and the Coordinator's memory, but has no chat row there (#162).

### Restart

A daemon restart ends every Lead's provider, like every managed session. The host's own session
row stays `unknown` ("Foreman restarted…"), its history stays readable, and unfinished messages
become uncertain and are never replayed. Nothing respawns automatically.

- **The registry reports it as ended.** The Lead's registry row says state `dead` with
  `end_reason: restarted`, so the relay marks it ended and the app moves its chat under
  **Archived**. Its workers are reported `dead` the same way (`list_workers` shows their
  `end_reason`), and a successor is not seeded with them as live workers.
- **The Coordinator still sees it.** `list_leads` hides ended Leads unless `include_ended`, except
  a restarted Lead that has not been superseded: it stays listed as ended, with a hint to start a
  successor with `start_lead`. The `## leads` memory block lists such Leads too. A row synced by an
  older host that still says `unknown` for a Lead that is not alive is shown as ended
  (`end_reason: unavailable` when it has none).
- **A successor is started on request.** The Coordinator gets no automatic turns. When the developer
  next asks, it offers a successor: `start_lead` on the same project and workstream (or with
  `supersedes`) seeds the new Lead from the restarted Lead's latest handoff and retires it with
  `superseded by <key>`.

A held launch expires on restart (see [Held launches](SESSION_PERMISSIONS.md#held-launches)).

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

The model chosen on the Coordinator's info screen is saved with the memory, so it follows the
Coordinator to another machine. If that model is not available there, the provider's error is shown
as usual; nothing is substituted. While no model has been saved, `FOREMAN_PM_MODEL` is used, and
without it the role default `opus[1m]`.

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
it, and the override is saved to `machine.json`. The macOS service installer copies a
`FOREMAN_MACHINE_NAME` set at install time into the service (refusing an invalid one), and the
service saves it when it starts. A service installed without it keeps the saved name. Every daemon
with a valid identity greets the relay with a protocol-2 hello: its `machine_id`, name and platform, and the PM turns it still holds.
Several machines can be connected at once, and the relay remembers up to 16.

The Durable Object records exactly one **active PM host**, with an **epoch** (`cloud/worker.ts`,
`cloud/pm-state.ts`):

- The first machine to send a protocol-2 hello becomes the PM host at epoch 1 (`assigned_by:
  'bootstrap'`), because no PM exists yet to move. Later hellos never change it.
- After that, only the developer changes it, with **Move Coordinator…** on the Coordinator's info
  screen in the hosted app.
  The dialog is offered only when another machine is online. It sends `POST /api/pm/host` with the
  epoch the page loaded. The target must be online, and the request fails with 409 if the epoch has
  changed in the meantime. The old host may be offline: that is the machine-loss case. Each move
  increments the epoch.
- Every PM state write carries the epoch. A write from a machine that is no longer the PM host is
  rejected (`stale_epoch` or `not_active`) and changes nothing, and that machine stops its PM.
- A host runs a PM only while it is connected to the relay **and** holds the current assignment:
  - A machine that is not the PM host refuses PM sends, from its local UI too, with "The
    Coordinator runs on <name>." If this machine was running the Coordinator and its daemon was not
    restarted, its Coordinator chat also gets the entry "The Coordinator now runs on <name>. This
    machine no longer runs it; messages sent here are refused." when it learns of the move: at once
    if it was connected during the move, otherwise when it reconnects.
  - A machine that cannot reach the relay refuses them with "The cloud relay is unreachable; the
    Coordinator is unavailable on this machine." It cannot know it is still the PM host, so it fails
    closed.
- Local-only mode is always its own PM host, at epoch 1, and there is nowhere to move the PM.

**Relay traffic goes only to the active PM host**: sessions, projects and the Coordinator alike.
Other connected machines are standbys. They receive no relayed requests, and the hosted app shows
them only in the Move Coordinator dialog's machine list. When the PM host is down, relayed requests get 503
"Your Coordinator's machine (<name>) is offline." The hosted app's host status and the offline push
notification follow the active PM host too. The Worker answers `GET` and `POST /api/pm/host`,
`GET /api/leads`, and `GET` and `POST /api/settings` itself and never relays them, so the machine
list, Move Coordinator, the Lead registry and Settings work while the PM host is offline. Standbys
still send `lead_rpc` frames over their own sockets (see [The Lead registry](#the-lead-registry)).

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
initialized, it imports its own memory from its `FOREMAN_HOME` (`server/pm-store.ts`).

Into the relay, the source is `pm/state.json` when this machine ran local-only and the file is valid
(what the PM learned in local-only mode, which is newer than the retired files). Its `projects`
doc, log entries and model are imported with the limits below. Its `preferences` doc follows as the
first write of the relay's empty `preferences` doc. Log entries get the import time as their
timestamp. A `pm/state.json` that is a symlink, is not a regular file, is owned by another user,
does not parse, or fails the local store's validation is not imported. The import logs why, falls
back to the retired files, and leaves the file alone.

Otherwise, and always for local-only mode, the source is the pre-portable memory:

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

### Switching between local-only and relay mode

PM memory is never merged between the two modes. Moving from one to the other never loses memory
silently, and never modifies, renames or deletes a local file:

- **Local-only → relay** (the machine is paired later): if the relay's memory is uninitialized, the
  one-time import above carries `pm/state.json` into the relay. If the relay already has memory,
  the relay wins. The import is a logged no-op and `pm/state.json` is left as it is.
- **Relay → local-only** (the pairing is removed): the daemon uses its local `pm/state.json`, or
  imports the retired files once as usual if the file does not exist. Memory held in the relay is
  not available and is not copied down. In relay mode the daemon records this in `memory/.pm-mode.json`
  (`{ version, mode: 'relay', machine_id, at }`) once the relay memory is known to be initialized.
  Every local-only start of a machine with that marker logs that the relay's PM memory is not
  available in local-only mode and is not merged. It logs on every start, not once, because the
  daemon log is the only place this is shown and the memory stays apart for as long as the machine
  runs local-only. Deleting `memory/.pm-mode.json` silences it.

### Conversations are not kept

- **The conversation lives only in the daemon's memory.** The Coordinator chat holds at most 200
  entries, and `/api/pm/history` returns it. It is **empty after a daemon restart, and whenever this
  machine becomes the PM host** (a move). The chat then says "New conversation." and "The
  Coordinator remembers projects, decisions and Leads, not past chats."
- **A fresh session in the same process keeps the conversation.** That happens on recovery after a
  provider failure, or under the hung-provider rule below. It adds one neutral entry: "Started a
  fresh Coordinator session. It answers from memory, not from the messages above."
- **Every message is recorded before it is sent.** `POST /api/pm/message` answers 202 only after the
  store has durably recorded the turn (write-ahead) and the message was dispatched. If the record
  cannot be written, the send fails with 503 and its cause, and nothing is dispatched. The record
  holds a turn id, the send time, the machine and the epoch, and never the message text.
- **An interrupted message is reported once as uncertain, and never replayed.** The next PM
  conversation shows one error entry for each such message: "Your message sent at <time> to the
  Coordinator on <host> could not be confirmed (<reason>). It was not replayed." The reasons are:
  - *Foreman restarted*: the daemon restarted while the turn was open (relay or local-only mode);
  - *the Coordinator was moved*: the Coordinator moved while the old host was online;
  - *machine went offline*: the Coordinator moved off a machine that was offline;
  - *the Coordinator stopped responding*: the hung-provider rule.

  Input that a stopped provider had already taken is reported the same way ("the Coordinator
  stopped: <cause>"). Input it never read is reported as not delivered. A reply that cannot be
  matched to its message is reported as uncertain, never as completed. Each of these entries also
  becomes the Coordinator's current error, so it shows the error indicator and can send a
  "Coordinator needs attention" push notification (kind `pm_failed`).
- **A network blip is not an interruption.** A closed relay socket marks nothing. Each reconnect
  hello lists the turns the PM still holds, so a turn that finishes across a short drop produces no
  uncertain entry. While the socket is down, new sends are refused.

### Hung provider

Suppose a message is outstanding and the provider has sent nothing for **5 minutes**
(`FOREMAN_PM_HUNG_MS` overrides this, in milliseconds; the macOS service installer copies it into
the installed service when it is set at install time, and refuses a value that is not a positive
integer). The next message you send then acts on it:

1. Every outstanding message is reported as uncertain (*the Coordinator stopped responding*).
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
| `local-api-token` | Token for the loopback UI and API. Any process running as the user can read it, including a Bypass agent; see [the local API token caveat](SESSION_PERMISSIONS.md#the-local-api-token-caveat) |
| `cloud.json` | Relay pairing (`url`, `token`), mode 0600. The same file on every paired machine; see [Cloud setup](CLOUD_SETUP.md#add-a-second-machine) |
| `machine.json` | This machine's identity, `{ machine_id, name }`, mode 0600. Never copy it to another machine |
| `pm/state.json` | Local-only mode only: PM memory, model and in-flight turn records, mode 0600 |
| `memory/.imported.json` | Written once by the one-time import: `{ machine_id, at, target }` |
| `memory/.pm-mode.json` | Written in relay mode: this machine's PM memory is in the relay, so a later local-only start logs that it is not merged. Safe to delete |
| `memory/PROJECTS.md`, `memory/LOG.md` | **Retired.** Import sources only. Kept untouched; no longer the PM's memory |
| `pm/settings.json` | **Retired.** Only the import reads its `model`; no longer written |
| `pm/history.jsonl`, `pm/session`, `pm/session.quarantine.jsonl` | **Retired.** Never read or written; safe to delete by hand |
| `leads/<uuid>.jsonl` | Each Lead's handoffs, appended in `seq` order (dir 0700, files 0600). A Lead's state stays on its machine |
| `leads/outbox.json` | Relay mode only: handoffs not yet delivered to the relay, flushed in order, mode 0600 |
| `launcher-sessions.json` | **Retired launcher.** Read only, so native sessions the old launcher started stay hidden from the fleet |
| `vapid.json` | Web Push signing key, created by `npm run cloud:deploy` on the machine that deploys, mode 0600 |
| `logs/` | macOS service stdout and stderr |

In relay mode the Coordinator's memory, its model and its in-flight turn records are not on disk
at all: they live in the relay's Durable Object, as do the Lead registry, the synced handoffs and
the developer's settings (role models and effort, Bypass grants).

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

Historical. Leads on other machines, with machine-targeted relay routing, are the follow-up epic
#162.

- **v0 (this repo):** hooks, fleet store, PM host, web UI with rail + chat, spawn via `claude --bg`.
- **v0.1:** notifications split by urgency (terminal-notifier locally; phone via Remote Control's
  `PushNotification` from the PM); attach button that opens `claude attach <id>` in a Warp tab.
- **v1:** remote hosts push records; PM can spawn on a remote host (ssh + `claude --bg`, or mngr);
  per-project views.

## Non-goals

- Replacing VS Code or Warp. Sessions stay wherever you started them.
- A kanban of PRs. `gh` and the agent view already do that; the PM can read it.
- Making the Coordinator smart about code. It reads documents, uses read-only investigators for
  lookups, and delegates everything else to Leads.
