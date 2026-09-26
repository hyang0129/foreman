# Session launch modes

Foreman selects native provider permissions. It adds no execution sandbox,
credential deny list, command parser, or approval classifier.

There are three policies: `native`, `bypass` and `auto`. `POST /api/sessions`
and `SessionService.create` (developer launches) accept all three. Omission
means `native`; JSON null in the HTTP API also selects `native`. The New
session dialog offers Native (the default) and Bypass. Sessions that agents
start (Leads and their workers) never run Native: see
[Agent launches](#agent-launches).

| Mode | Claude | Codex |
| --- | --- | --- |
| **Native** (default) | `permissionMode: default`; normal provider permission rules and prompts; sandbox settings inherited from provider configuration | `sandbox: workspace-write`, `approvalPolicy: on-request`, workspace command networking disabled; normal native shell and file tools |
| **Bypass** | `permissionMode: bypassPermissions`, `allowDangerouslySkipPermissions: true`, native sandbox disabled | `sandbox: danger-full-access`, `approvalPolicy: never` |
| **Auto** | `permissionMode: auto` (Claude's model-classifier mode); no `allowDangerouslySkipPermissions`; sandbox settings inherited from provider configuration | Unsupported: refused before anything is saved ("Auto is not supported for Codex") |

Native is a choice to use the provider's permission system, not a promise of
identical filesystem boundaries or prompt counts. In particular, Claude's default
permission mode is not an OS sandbox. User/project rules and provider behavior
still apply. Codex uses `approvalsReviewer: user`; automatic review is not enabled.
Foreman does not override native search, delegation, worktree, or shell tools.
The existing peer-tool allow list is retained; it is not a blanket tool allowance.

Claude initialization must report the requested permission mode (`default`,
`bypassPermissions` or `auto`). Codex's thread-start response must report the
requested sandbox and approval policy, including disabled workspace networking
for Native. A mismatch fails startup.
These are checks of provider-reported settings, not independent enforcement
attestation. There is no mandatory Foreman hook or replacement execution tool.
Provider authentication and Git credential helpers are retained.

**Auto depends on the model.** Whether the Claude CLI applies `auto` depends on
the CLI and the model. On CLI 2.1.280, `sonnet` and `opus[1m]` (the Lead default)
report `auto`, but `haiku` silently reports `default`. The init check is not
relaxed for this, so an Auto launch on such a model fails: the session becomes
unavailable with "Claude did not apply the requested launch policy: requested
auto, provider reported default; this model may not support Auto".

## What Bypass permits

Bypass requests commands, networking, credential access, and reads/writes outside
the project without execution-permission prompts. It can use authenticated `gh`
and private Git with the user's existing credentials. Foreman does not hide those
credentials from agent-controlled code or limit which authenticated operations it
performs. Provider/organization restrictions can still reject a request.

There is no Foreman protection for `.env`, `.ssh`, `.claude`, `.codex`, Keychain,
relay credentials, or the Foreman state directory. A chosen agent can make a
mistake or follow malicious instructions found in a repository, dependency, issue,
or webpage. Bypass accepts the resulting filesystem and account authority; it is
not a contained environment for hostile code. No direct-path filter is advertised.

Local API authentication remains mandatory: bearer token or the local unlock
cookie. It rejects unauthenticated callers. **It does not isolate Foreman from an
agent running as the user that can read the local API token.** Bypass also allows
access to localhost services. Foreman's peer-tool restrictions limit those tools'
API surface; they are not a security boundary against an unrestricted shell.

## Selection, approvals, and recovery

The New session dialog defaults to Native every time it opens. Bypass has a
visible warning in the dialog and on the running session, and requires a
confirmation checkbox. API callers opt in by explicitly sending `bypass` (or
`auto`). The selected mode is persisted and participates in creation-ID
deduplication. Reusing an ID with different input is rejected. Foreman provides
no endpoint to change a running session's mode.

Native execution approvals identify the pending provider request and original
input. Foreman sends only a one-time decision, not persistent permission updates
or command-prefix amendments. Claude command input is snapshotted and cannot be
replaced by an approval response. Cancellation, interruption, completed turns,
and disconnection invalidate pending approvals as supported by each adapter.
Codex's separate `request_permissions` requests receive an empty turn grant;
command/file approval requests still go to the user. Stop uses the providers'
native turn interruption and cancels pending Foreman approvals and queued messages.
For Codex, Foreman also cleans native terminals and terminates commands announced
late for the interrupted turn, using their exact native execution IDs. A new send
is rejected while Stop is cleaning up. The tested session remains usable afterward.
Interruption does not undo effects already performed. Unknown provider dialogs
remain unsupported and require interruption or the original client.

Approval authorizes the native operation, including any subprocesses or
interactive behavior that provider permits. Foreman no longer supplies an
additional command sandbox or restricts stdin after approval. It cannot guarantee
that arbitrary approved scripts do only what their command text suggests.

Task questions remain questions, including in Bypass; they are never automatically
answered as execution approvals. Peer tools cannot launch sessions or approve
requests. The Coordinator has no `spawn_session`: it starts Leads with
`start_lead`, and only Leads start workers. Both go through the agent-launch
policy below, which never lets an agent choose Native or grant itself Bypass.

Read-only, Workspace, Trusted, and Full are retired and rejected for new managed
launches. Their shared grants depended on the deleted enforcement runtime. Full
is not an alias for Bypass: the latter deliberately removes credential protection.
Historical rows keep their original policy values and display as legacy policies.
On recovery they remain unavailable, with history retained and uncertain work
never replayed. Old creation IDs cannot silently acquire the new semantics; use a
new session. Existing legacy `bg`/`tab` provider flags remain separate.

## Agent launches

Sessions that agents start go through `SessionService.launchAgent`, never through
`create()`: a Lead started by the Coordinator (`start_lead`) and a worker started
by its Lead (the Lead's `spawn_session`). Agent launches are Claude only. The
tools accept an optional `permission_mode` of `bypass` or `auto`; `native` is
refused ("Agents cannot launch Native sessions…"). The host decides the policy on
every launch, in this order (`resolveAgentLaunchPolicy` in `shared/roles.ts`):

1. **`auto` requested:** Auto. The grant is not read.
2. **Grant unreadable:** Auto. That covers the relay not answering within 5 s,
   local-only mode (no relay, so no settings), no Lead store on this machine, and
   a settings view that fails validation. It never falls back to Bypass or to an
   approval card.
3. **Standing grant off** for the requester's role and the target project: Auto,
   even when the agent asked for `bypass`.
4. **Grant on and "Ask me before each Bypass launch" set:** a held launch (below).
5. **Grant on:** Bypass, recorded as `bypass_grant: standing:<role>/<project|*>`.

So with no mode (or `bypass`) and the default settings, an agent launch runs
Bypass. Every launch that reads the grant asks the relay's Durable Object, with
no cache, so turning a grant off applies to the next launch. Every
agent-launched session records `role`, `launched_by`, its effective
`permission_mode`, `policy_reason` and, for Bypass, `bypass_grant`. The chat list
labels it **⚠ Bypass · standing**, **⚠ Bypass · approved** or **Auto**. No
request field can set `bypass_grant` or `policy_reason`, and nothing on this path
ever launches Native or upgrades a request.

### Standing grants

The grant is a list of `{ role, project, allow }` entries (the `bypass_grants`
developer setting). `role` is the **requester's** role: a `coordinator` entry
covers Leads the Coordinator starts, and a `lead` entry covers workers that Leads
start. `project` is a registered project name or `*`. For a launch, an entry for
that exact project wins over the role's `*` entry (the most specific entry
wins). Project names match the way the project registry resolves them: trimmed,
case- and whitespace-insensitive, ignoring a leading "the ". If two entries name
the same project that way (for example `foreman` and `the foreman`), an
`allow: false` entry wins. A launch into a directory that is not a registered
project matches only `*`. `allow: false` turns Bypass off for that scope, and
those launches run Auto.

**The grant is on by default.** Until the developer changes it, the grant is
`{ coordinator, *, allow: true }` and `{ lead, *, allow: true }`, and
"Ask me before each Bypass launch" is off. A stored value that fails validation
fails toward lower privilege: grants read as none (Auto) and "ask" reads as on.

The developer changes these in **Settings** in the hosted app (⋮ → Settings):
one checkbox per role for all projects, per-project overrides (on or off), and
"Ask me before each Bypass launch". Grants are written **only** by the Worker's
`POST /api/settings`, which requires the Firebase bearer, the allowed email and
the same-origin check. Hosts can only read them (`lead_rpc` op `settings.get`);
no host op, Foreman tool or agent path writes them. The local UI shows the
settings read-only, and the host answers `POST /api/settings` with 400.

### Held launches

With "Ask me before each Bypass launch" on, a launch that the grant would run in
Bypass is held instead. A held launch is saved but not started: state
`needs_input`, reason `awaiting_bypass_approval`, no permission mode, and nothing
runs. The tool returns at once with `status: awaiting_developer_approval`. The
session has one approval, tool `foreman.launch_bypass`, shown as a
**Launch with Bypass** card naming the session, project, directory, provider,
model and effort, role, who asked, and the first task (at most 2000 characters).
It sends the usual approval push, and the card answers through the existing
`POST /api/session/approval`.

- **Launch with Bypass:** the session starts in Bypass with the normal launch
  verification, recorded as `bypass_grant: approved:<approval id>`.
- **Deny:** the session is ended ("Bypass launch denied by developer; nothing
  ran"). Its first message is marked failed, not uncertain.
- **Restart while held:** the session is ended ("Launch approval expired; nothing
  was launched"). No `session_failed` push is sent.

A held launch never runs Native, and it never starts until approved. A Lead that
asked is told the outcome by a Foreman message in its own session, sent once and
never replayed. The Coordinator sees the outcome in `list_leads` and
`session_state`. Held launches count toward the Lead and worker limits.

### The local API token caveat

"An agent can never set or widen its own grant" holds for the grant itself: only
the hosted Worker route writes it. It does **not** hold for what a Bypass agent
can do on the machine. A Bypass session with a shell can read
`~/.foreman/local-api-token` and call the local API as the developer, for
example `POST /api/sessions` with `bypass`. So the invariant holds only for agents
that do not run in Bypass. For an Auto agent it rests entirely on Claude's own
Auto-mode classifier declining to run such a command: Foreman adds no protection
of its own there (the token file is readable by the user's processes, and no
Foreman rule denies an Auto agent's shell access to it). This is accepted,
consistent with the rest of this page: Foreman adds no sandbox.

## Managed Codex process lifetime

Foreman owns the app-server it launches over stdio. A separate watchdog tracks
its process family and detached process groups, sends TERM on teardown, escalates
to KILL, and waits for the processes to exit. It survives loss of Foreman's IPC
connection, including Foreman being killed. Provider exit/crash also starts cleanup.
Controller close, thread `closed`/`archived`/`notLoaded`, transport disconnect, and
daemon shutdown all retire the owned runtime. Graceful daemon shutdown waits for
cleanup before reporting successful exit; cleanup failure produces a nonzero exit.

On macOS, a small C helper reads kernel process birth identities and original
parent identities using the [Apple process-identity ABI](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h). Those identities survive reparenting and prevent PID reuse
from assigning unrelated processes to a session. The provider starts behind a
one-byte readiness gate until its identity is recorded. This fixes the race where
an app-server dies immediately after creating a detached shell, before an ordinary
`ps` ancestry poll sees it. No shell commands or native provider tools are replaced.

**macOS now requires Xcode Command Line Tools (`/usr/bin/cc`) and the process
identity API.** Each watchdog builds and validates the 49-line helper in its own
temporary directory before launching the provider, then removes that directory
on exit. It writes no helper or configuration to `~/.foreman` or `.claude`.
The helper only reads process metadata and gates startup; it is not a sandbox,
a credential filter, a TCC change, or a permissions attestation.

The live evidence covers managed Codex on macOS. Linux uses PID/start-time/group
observation and has not received equivalent live certification; it lacks the
macOS original-parent recovery for a detached child whose parent dies before a
sample. Socket attachment to an existing external app-server does not transfer
ownership to Foreman: disconnecting that client must not kill a shared server.
Claude continues to use SDK lifecycle handling; its foreground interruption is
checked in the native-mode matrix, not the Codex crash matrix.

Lifecycle cleanup is not containment of hostile code. Work deliberately delegated
to another service (for example launchd), elevated processes, killing the watchdog
itself, or multiple unseen intermediate processes that detach and disappear cannot
be given a universal cleanup guarantee by this adapter. These are not restored
Trusted guarantees. Normal command groups, background children, immediate provider
death, and graceful/abrupt daemon shutdown are exercised by the lifecycle tests.

## Verification

Run:

```sh
npm test
npm run typecheck
npm run cloud:typecheck
npm run cloud:test
npm run test:ui
FOREMAN_LIVE=1 FOREMAN_LIVE_CLAUDE_KEYCHAIN=1 \
  FOREMAN_LIVE_PRIVATE_REPO=owner/private-repository \
  npm --prefix tests/live run test:policy
FOREMAN_LIVE=1 FOREMAN_LIVE_CLAUDE_KEYCHAIN=1 \
  npm --prefix tests/live run test:leads
FOREMAN_LIVE=1 FOREMAN_LIVE_CLAUDE_KEYCHAIN=1 \
  node --experimental-strip-types --test --test-concurrency=1 tests/live/lifecycle.live.mjs
```

`test:policy` and the lifecycle suite start a separate Foreman server on an
assigned loopback port with the Coordinator (PM) disabled and a disposable
`FOREMAN_HOME`. `test:leads` instead runs a real Coordinator in-process
(`ProjectManager` with the Lead tools wired as `server/main.ts` wires them, a
local-only Lead store, and a stub grant source with the default settings), with
its own disposable `FOREMAN_HOME` and `CLAUDE_CONFIG_DIR`. No live suite
restarts the installed service.
Claude uses an isolated config directory bootstrapped from the macOS Keychain
with explicit opt-in, no user/project settings, and no persistent transcript.
It does not read or copy the real `.claude` directories. Codex uses a temporary
`CODEX_HOME` containing a private copy of existing `auth.json`, without user config.
Authentication copies and temporary projects are removed on teardown.

The suite requires successful real provider turns before asserting reporting. It
checks API/peer/browser mode reporting, native shell execution, Native one-time
approvals, and Bypass access to a synthetic `.env`, outside writes, authenticated
private-repository `gh`, private Git fetch, and native command interruption.
Its agent-launch cases start Leads through `launchAgent` and record the
provider's own init mode: a standing-grant launch with no mode is verified
`bypassPermissions`; with the grant off it is verified `auto`; `haiku` with Auto
is refused; and a held launch shows no provider activity until it is approved,
then is verified `bypassPermissions` with `approved:<id>`. `test:leads` runs the
Coordinator → Lead path (`start_lead`, a handoff, `list_leads`) and one
investigator whose mutating `git` call is denied.
Tool results, independent filesystem artifacts, and process-table observations establish execution;
assistant prose and missing provider calls cannot pass. Git fetch downloads into
a disposable repository without checking out or executing private code. Existing
host Git/gh authentication is used without a special credential exception.

Default models are `haiku` and `gpt-5.6-luna`; override with
`FOREMAN_LIVE_CLAUDE_MODEL` and `FOREMAN_LIVE_CODEX_MODEL`. Live calls spend provider
quota. Claude has a six-turn/$1 SDK bound; probes have a 60-second deadline and
bounded tool attempts. Codex has no matching USD budget in this harness.

See [live results](LIVE_POLICY_RESULTS.md) and [replacement review](REVIEW_FIX_RESULTS.md).
Provider references: [Codex sandbox and approvals](https://learn.chatgpt.com/docs/sandboxing),
[Codex App Server](https://developers.openai.com/codex/app-server), and the installed
Claude Agent SDK `Options`, `CanUseTool`, and initialization-message declarations.
