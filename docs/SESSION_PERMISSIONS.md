# Session launch modes

Foreman selects native provider permissions. It adds no execution sandbox,
credential deny list, command parser, or approval classifier.

`POST /api/sessions`, `SessionService.create`, and managed `spawn_session` accept
`permission_mode: "native" | "bypass"`. Omission means `native`; JSON null in
the HTTP API also selects `native`.

| Mode | Claude | Codex |
| --- | --- | --- |
| **Native** (default) | `permissionMode: default`; normal provider permission rules and prompts; sandbox settings inherited from provider configuration | `sandbox: workspace-write`, `approvalPolicy: on-request`, workspace command networking disabled; normal native shell and file tools |
| **Bypass** | `permissionMode: bypassPermissions`, `allowDangerouslySkipPermissions: true`, native sandbox disabled | `sandbox: danger-full-access`, `approvalPolicy: never` |

Native is a choice to use the provider's permission system, not a promise of
identical filesystem boundaries or prompt counts. In particular, Claude's default
permission mode is not an OS sandbox. User/project rules and provider behavior
still apply. Codex uses `approvalsReviewer: user`; automatic review is not enabled.
Foreman does not override native search, delegation, worktree, or shell tools.
The existing peer-tool allow list is retained; it is not a blanket tool allowance.

Claude initialization must report the requested native permission mode. Codex's
thread-start response must report the requested sandbox and approval policy,
including disabled workspace networking for Native. A mismatch fails startup.
These are checks of provider-reported settings, not independent enforcement
attestation. There is no mandatory Foreman hook or replacement execution tool.
Provider authentication and Git credential helpers are retained.

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

The launcher defaults to Native every time it opens. Bypass has a visible warning
in the launcher and running-session display and requires a confirmation checkbox.
API callers opt in by explicitly sending `bypass`. The selected mode is persisted
and participates in creation-ID deduplication. Reusing an ID with different input
is rejected. Foreman provides no endpoint to change a running session's mode.

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
requests. The project manager retains its separate role restrictions and may
propose Bypass, but cannot grant it through its managed or legacy launch tool.
The developer selects Bypass in New session.

Read-only, Workspace, Trusted, and Full are retired and rejected for new managed
launches. Their shared grants depended on the deleted enforcement runtime. Full
is not an alias for Bypass: the latter deliberately removes credential protection.
Historical rows keep their original policy values and display as legacy policies.
On recovery they remain unavailable, with history retained and uncertain work
never replayed. Old creation IDs cannot silently acquire the new semantics; use a
new session. Existing legacy `bg`/`tab` provider flags remain separate.

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
  node --experimental-strip-types --test --test-concurrency=1 tests/live/lifecycle.live.mjs
```

The live suite starts a separate Foreman server on an assigned loopback port with
PM disabled and disposable `FOREMAN_HOME`. It never restarts the installed service.
Claude uses an isolated config directory bootstrapped from the macOS Keychain
with explicit opt-in, no user/project settings, and no persistent transcript.
It does not read or copy the real `.claude` directories. Codex uses a temporary
`CODEX_HOME` containing a private copy of existing `auth.json`, without user config.
Authentication copies and temporary projects are removed on teardown.

The suite requires successful real provider turns before asserting reporting. It
checks API/peer/browser mode reporting, native shell execution, Native one-time
approvals, and Bypass access to a synthetic `.env`, outside writes, authenticated
private-repository `gh`, private Git fetch, and native command interruption.
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
