# Session launch permissions

`POST /api/sessions`, `SessionService.create`, and managed `spawn_session` accept
`permission_mode`: `read-only`, `workspace`, `trusted`, or `full`. Omission and JSON null are
normalized to `workspace` before validation, idempotency comparison, persistence,
and provider launch. Native Claude flags are not managed presets. Existing legacy
`bg`/`tab` launches retain their separate native flag validation.

Managed session rows and peer summaries report the normalized preset. Observed
external sessions instead expose `provider_permission_mode` to peers; a native
Claude mode is not a Foreman preset. Old
managed rows recorded as `default` display Workspace; stopped sessions are never
resumed or silently upgraded. Duplicate creation IDs cannot select another policy.
There is no update-policy endpoint. Peer tools cannot launch sessions or approve
permissions. The PM may propose elevated settings, but its pre-tool guard refuses
to grant Trusted or Full: the developer must choose them in New session. This does
not implement the separate UX-12 launcher.

| Preset | Operation grant | Prompts |
| --- | --- | --- |
| Read-only | Project inspection and a small set of simple inspection commands; no writes or command networking | Forbidden operations are refused |
| Workspace | Project writes; one-time approval for command networking or access outside the project | Existing one-time approval UI |
| Trusted | Project writes and the agreed CLI network operations below; other command networking and outside-project data access are refused | No permission prompts |
| Full | Commands, networking, and files outside the project, subject to the deny list | No permission prompts; explicit confirmation checkbox at launch |

Trusted and Full have visible warning markers at launch, in the session rail, and
in the running session heading. Every new launch dialog starts at Workspace and
clears Full confirmation. API clients explicitly opt in by sending `full`.
Questions requesting task input remain questions, not permission escalation.

## Concrete provider mapping

| Preset | Codex `sandbox` / `approvalPolicy` | Claude `permissionMode` |
| --- | --- | --- |
| Read-only | `read-only` / `never` | `dontAsk` |
| Workspace | `workspace-write` / `on-request` | `default` |
| Trusted | `workspace-write` / `never`, network enabled | `dontAsk` |
| Full | `danger-full-access` / `never` | `bypassPermissions`, with `allowDangerouslySkipPermissions` |

These native values alone do **not** implement the presets. The additional
controls below are mandatory, including at Full. Codex's start response and
Claude's initialization event must report the expected native policy or the
controller fails instead of running with a mislabeled policy.

Claude's `PreToolUse` hook checks canonical file paths before provider auto-allow
rules or Full bypass take effect. Permitted file operations proceed immediately.
Shell operations receive an inherited macOS Seatbelt boundary; Workspace shell
approvals still go through `canUseTool`, displaying the original command, guarded
command, and grant description. Ordinary approval retains project confinement and
no network. Only an explicit `dangerouslyDisableSandbox:true` request followed by
developer approval enables one-time outside access; the mandatory deny list and
local-control-plane network denial remain active. Background Bash is refused with
an explanation because native Monitor/TaskStop are not in the launch grant. `allowedTools` retains the existing peer-tool list;
it is not expanded into a blanket allow rule. `disallowedTools` additionally blocks
Agent, ExitPlanMode, and EnterWorktree. Provider-native shell sandboxing is disabled
because Foreman supplies the mandatory shell sandbox; nesting the two does not
work reliably on macOS. User/provider authentication is otherwise retained.

Codex keeps the native sandbox mapping above for its native file tools. Its
`PreToolUse` guard is copied to a private per-controller snapshot, so editing the
source tree cannot change that session's guard. Native shell/unified-exec tools
are disabled and the hook refuses any native shell fallback. Instead, the host
provides `foreman_exec` and `foreman_process` as thread-bound dynamic tools. This
is necessary because Codex's sandbox rejects applying a second Seatbelt policy.
The host runs each command under the same mandatory boundary used for Claude,
retains it for child processes, rejects stdin on processes with a one-time escape,
bounds output and active processes, reaps completed entries at spawn, and
terminates owned commands on interrupt/disconnect. The command tools accept no
policy, caller identity, or provider flag override.

Workspace commands start inside the project grant with networking disabled.
`foreman_exec(request_access:true)` asks through the existing approval UI for the
**exact command and directory, once**. Approval permits that command's outside
access while preserving the deny list. It never persists a broader grant for a
later command. Interactive stdin on an approved interpreter is refused: submit a
new exact command for new input. Codex `request_permissions` receives an empty turn-scoped grant; session-wide
approval decisions are rejected. Read-only and Trusted refuse access requests.

## Command grants and protected paths

The command sandbox is a kernel boundary inherited by child processes. It applies
to indirect reads, scripts, interpreters, redirections, and symlink aliases, not
just paths mentioned in a command string. Native file tools check both lexical
and canonical paths, including the nearest existing parent for new files and
dangling symlinks. Read-only/Trusted reject paths escaping the project except the
public system trust anchors below; Workspace requires approval for other outside paths; Full
permits outside paths but never protected targets.

Protected families are `.env`/`.env.*`/`*.env`, `secret(s)` and `credential(s)`
files/directories (including extensions), private-key files (`pem`, `key`, `p12`,
`pfx`), `.ssh`, `.aws`, `.gnupg`, `.claude`, `.codex`, `.git-credentials`, `.npmrc`,
`.netrc`, home `~/.docker/config.json` and `~/.kube/config`, relay credential/token filenames,
`cloud.json`, and Wrangler JSON/JSONC. Foreman's state directory (including
`~/.foreman/cloud.json` or configured `FOREMAN_HOME`) and private policy snapshots
are protected as well. They cannot be read or written through either file tools
or command execution, even with Full or an approved Workspace escape.

The PEM read rule has one exception, matched by anchored absolute path:
`/etc/ssl/cert.pem`, `/etc/ssl/certs/` and its descendants, and their
`/private/etc/...` equivalents. These are public, OS-owned TLS trust anchors,
not user credentials. Both native path checks (lexical and canonical) and the
Seatbelt policy permit their reads and explicitly forbid their writes at every
preset, including Full and approved Workspace access. Only the PEM read rule is
narrowed: `.key`/`.p12`/`.pfx`, credential names such as `secrets.pem`, and all
other protected families still apply within the trust directory. A PEM in a
project, `.foreman-tmp`, another temporary directory, or a home directory remains
protected; a path merely ending in `etc/ssl/cert.pem` acquires no exception.

System runtime directories remain readable so binaries and libraries can run;
these are not writable project roots. A simple Git command can consume Git
configuration, including repository configuration. Git/gh children get **no
credential-read exception**: GitHub configuration and macOS Keychains are denied,
and GitHub tokens are scrubbed along with other sensitive environment variables.
Repository-controlled `core.sshCommand`, credential helpers, URL rewrites, and
replacement executables therefore do not gain the host's credentials.

This deliberately removes authenticated `gh` and private Git compatibility with
the host's login. Public HTTPS Git still has a network grant. Foreman does not
implement an authentication proxy in this pass. Pinning a few Git flags would not
safely cover all child execution or agent-controlled executables, so the former
credential relaxation was removed entirely. No successful authenticated operation
is promised until a separately reviewed credential broker exists.

Every guarded shell command, including Full and approved Workspace escapes,
denies outbound loopback connections. The local HTTP API independently requires
a bearer token or an HttpOnly SameSite=Strict cookie. A new server process creates
an owned mode-0600 `local-api-token` in its configured Foreman state directory and
reuses it on subsequent starts. The browser accepts that token through its local
unlock form; the host bridge adds it to forwarded requests. `/api/config`,
`/api/health`, and the token exchange are public and grant no session authority.
Existing running services require a future owner-managed restart to apply this
code; this pass does not restart or deploy them.

Trusted's agreed network operations are:

- `gh issue` list/view/create/edit/comment/close/reopen/delete/pin/unpin/transfer/lock/unlock;
  `gh pr` list/view/create/edit/comment/review/merge/close/reopen/checks/diff/ready;
  `gh repo` view/list; `gh run` list/view/watch/rerun/cancel;
  `gh workflow` list/view/run/enable/disable; and
  `gh release` list/view/create/edit/delete/upload/download.
- `git push`, `git fetch`, and `git pull` (without executable override flags).

Package install/ci/add commands have **no automatic network grant**. Their
lifecycle scripts are arbitrary project-controlled programs. Offline/cached
installs can work within the project; networked installs require a Workspace
one-time request or Full, with the credential and loopback denials still active.

Trusted commands allocate a unique cache below `.foreman-tmp/`, redirect TMPDIR,
package caches, and Apple's `xcrun_db`, and remove that command's directory on
normal shell exit. Each cache contains a self-ignoring `.gitignore`, so even a
hard-killed command's residual cache cannot pollute `git add -A` in other projects.
The per-user OS temp directory acquires no additional write grant.

The parser accepts a single command with quoted arguments. Shell composition,
substitution, environment assignments, aliases, `gh auth`, `gh api`, extensions,
and browser launches do not acquire this automatic network grant. Other commands
can still run with networking disabled. Native recursive Glob/Grep are refused
because they can traverse denied descendants; use the guarded shell for searches.
Unknown tools and delegation/worktree/policy-changing tools are refused rather
than given an implicit grant outside the reviewed tool boundary.

The command boundary targets Foreman's macOS execution host. On other operating
systems it fails closed, and `npm test` explicitly fails for missing mandatory
macOS enforcement coverage instead of reporting a green enforcement suite. This does not install hooks, alter user configuration,
restart Foreman, or deploy anything.

## Default behavior change requiring owner review

Omitted `permission_mode` now means Workspace, but that is **not behaviorally
equivalent to the old omitted native mode**. Native Glob/Grep are denied at every
preset, so Claude falls back to Bash and requires one human approval per search at
Workspace. In-project native Write/Edit now auto-allow where they previously
prompted. Unknown tools fail closed. Codex's confined `foreman_exec` does not
prompt until `request_access:true`; Claude Workspace Bash still prompts for each
command. The grants now match, but these prompt counts differ.

These changes trade search convenience and per-edit review for uniform path
checks and fail-closed tool coverage. This pass documents that tradeoff for the
owner; it does not redesign the default or the search/edit experience.

## Codex activation compatibility and lifecycle

Foreman verifies the provider's `config/read` response for hooks, disabled native
shell/unified execution, and web-search mode, and requires `hooks/list` to report
the exact private PreToolUse command as enabled, synchronous, and trusted or
managed. Missing or untrusted configuration refuses activation before a user turn.
The current Foreman integration with **Codex CLI 0.149.0 does not satisfy this check**: thread start
does not attest the configuration, and diagnostic hooks were listed as untrusted
and did not execute. Codex managed launches currently fail closed. This is an
explicit compatibility limitation, not a successful live enforcement result.
A working, supported hook trust/registration integration remains to be implemented;
we do not bypass trust for arbitrary user/project hooks.

The out-of-process guard receives the absolute configured Foreman root as a quoted argv
argument, independent of environment filtering. Snapshot directories record their
owning PID. Startup and snapshot creation sweep marked, owned directories whose
owners no longer exist, preserving live owners, unknown legacy directories, and
symlinks. PID reuse conservatively retains a directory. Old unmarked snapshots
remain a manual cleanup limitation. Failed host-tool result delivery emits a
diagnostic and disconnects the controller rather than disappearing into a catch.

## Verification

`tests/permission-policy.test.ts` exercises all presets, canonical paths, denied
files, shell syntax, indirect access, and real Seatbelt enforcement on synthetic
temporary fixtures. `tests/policy-commands.test.ts` executes commands at every
preset, verifies one-time approvals do not persist, checks networking and process
ownership, and installs an empty temporary npm fixture. Provider adapter tests
check hooks, flags, denial at Full, effective-mode rejection, and host approval
routing. `tests/system-trust.test.ts` verifies private-material denial in project,
temporary, and home-like fixtures at every preset, including approved Workspace
shell access, plus actual CA reads and kernel-reported write denials. The kernel
check has an unsandboxed control so OS file ownership cannot masquerade as policy
enforcement; no system trust data is opened for writing. Service/tool tests check
defaults, persistence, deduplication, reporting, and inability to self-escalate. Playwright checks Full confirmation, default reset,
and the running-policy marker.

Run all five project checks: `npm test`, `npm run typecheck`,
`npm run cloud:typecheck`, `npm run cloud:test`, and `npm run test:ui`.

Provider references: [Codex App Server](https://developers.openai.com/codex/app-server),
[Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Codex configuration](https://developers.openai.com/codex/config-reference),
and the installed Claude Agent SDK `Options`, `PreToolUseHookSpecificOutput`, and
`SDKSystemMessage` declarations. Codex CLI 0.149.0's generated protocol schema was
also checked locally.

### Opt-in live conformance

Run `FOREMAN_LIVE=1 FOREMAN_LIVE_CLAUDE_KEYCHAIN=1 npm --prefix tests/live run test:policy` on macOS. This separate
npm package leaves the root package/lock files alone and is excluded from `npm test`;
without the flag it skips before starting a provider, server, or browser. It uses
the installed Chromium from the existing Playwright setup. Model overrides are
`FOREMAN_LIVE_CLAUDE_MODEL` and `FOREMAN_LIVE_CODEX_MODEL` (defaults: `haiku` and
`gpt-5.6-luna`, the small model in this host's Codex catalog). Availability depends
on the provider account; an unavailable model is a failure, not a skipped proof.

The harness owns a temporary `FOREMAN_HOME`, an OS-assigned loopback port (never
4177), and its server process group. It verifies the health response's PID before
using the instance, disables PM, clears inherited relay settings, and removes its
fixtures on exit. It neither installs hooks nor restarts a service. Claude gets a
temporary `CLAUDE_CONFIG_DIR`, no settings sources, and no persistent transcript.
The separate `FOREMAN_LIVE_CLAUDE_KEYCHAIN=1` opt-in reads the macOS generic-password
entry `Claude Code-credentials` and writes it exclusively as `.credentials.json`
with mode `0600` inside that isolated directory. Claude does not consult Keychain
automatically with a nondefault config directory. Missing opt-in, missing/unreadable
Keychain data, or invalid OAuth JSON fails setup loudly before any provider starts.
Teardown explicitly removes the credential file and temporary tree even after
setup, test, or shutdown failures (unrecoverable process termination such as SIGKILL
cannot run JavaScript teardown). Neither the harness nor this bootstrap reads,
copies from, or writes to the developer's real `~/.claude` directory. The repository's
`.claude/` and real `~/.foreman` are also left alone.
Codex uses its existing provider login. A real `~/.ssh` alias is planted
but never traversed; the symlink read probe targets a disposable synthetic `.ssh`
directory instead.

Every preset attempts `wc -c` on the real temporary OAuth file: it opens and reads
the file, but exposes only a byte count if enforcement fails. Workspace receives
one exact approval to ensure the credential restriction survives that approval.
A separate in-project synthetic `.credentials.json` probe tests the filename
restriction without an outside-project boundary masking it; Claude uses native
Read and Codex uses its guarded shell. No real credential content is printed.

Each of eight sessions receives short, single-operation prompts. Claude has a
three-turn SDK limit and a $0.30 session budget; all probes have a 60-second deadline
and a six-tool-attempt limit. Allow several minutes for the full matrix (up to 30
minutes before the outer timeout). Small-model calls are intended to cost cents,
but actual provider billing and availability vary; the aggregate Claude budget is
$1.20 and Codex has no equivalent USD cap. The test does perform real read-only
GitHub requests (`gh issue view` and a shallow `git fetch` into a throwaway project).

Test-only observers record actual hook decisions and correlated tool results; they
do not replace the SDK, provider binary, policy, or HTTP handlers. Controller source
is copied byte-for-byte into each disposable project before loading, so the
source-edit probe changes the actual loaded guard's source while leaving the running
module and private Codex hook snapshot intact. Row and browser checks use real HTTP;
peer reporting uses the same bound peer projection over private parent/child IPC.
These private controller taps are intentionally isolated in `tests/live/observe.mjs`.

A negative probe passes only with an attempted operation and enforcement evidence:
a matching guard denial, exact approval denial, or a failed guarded command with a
permission error. Network checks also verify a healthy local listener and absence
of the attempted request. Missing tool calls, model abstention, missing files,
provider/login errors, and timeouts are failures, not evidence of authorization
refusal. Native tools that the provider cannot be induced to call therefore leave
an explicit live-coverage failure; executable-hook tests separately cover them.
`tests/live-evidence.test.mjs` ensures unrelated errors and model prose cannot pass.

Existing non-live tests retain deterministic coverage of policy and peer-tool
mutation rejection, native-policy fault injection, process-group cleanup on
controller close, and foreign-platform refusal. The live suite adds provider
conformance, source edits, inherited execution, exact approvals across turns,
reported policy, and a real server restart including a legacy row. It proves only
the operations actually observed on the installed providers and host, not universal
model behavior or resistance to a compromised provider binary. See
[the recorded run](LIVE_POLICY_RESULTS.md) for results and remaining gaps.

### Focused Trusted Git TLS regression

```sh
FOREMAN_LIVE=1 FOREMAN_LIVE_CLAUDE_KEYCHAIN=1 node --experimental-strip-types --test tests/live/git-fetch.live.mjs
```

This uses the same isolated harness for Claude Trusted and Codex Trusted, without
restarting any service. It checks real HTTPS `git fetch`, `git pull --ff-only`, and
`gh issue view`, with no approvals. Fetch must return exit 0, populate `FETCH_HEAD`,
and clean the project-local xcrun cache. Pull uses a disposable sparse checkout
to avoid replacing the harness fixtures. A test-only Claude observer reports the
actual guarded shell exit and returns the same status to the SDK; Codex supplies
its command exit directly. Missing exits, unrelated successes, and model abstention
fail. The regular live matrix's fetch row uses the same exit-status assertion.
