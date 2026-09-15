# Issue #2: replace custom enforcement with native execution

2026-09-15. Supersedes the custom-policy implementation and its four fix passes.

## Architectural reversal

The owner chose functional native execution over Foreman's attempt to contain
arbitrary agent-controlled code. The previous design disabled managed Codex
launches when it could not attest a trusted hook, and removed authenticated gh
and private Git to preserve its credential boundary. Those costs did not fit a
single developer running chosen agents on their own Mac and repositories.

New managed launches offer **Native** and **Bypass**, defaulting to Native.
Read-only, Workspace, Trusted, and Full are retired, not renamed or silently
mapped to weaker grants. Historical rows retain their recorded policies and
remain unavailable after recovery. See [session modes](SESSION_PERMISSIONS.md)
for provider mappings, migration behavior, and the limits of native execution.

## Removed

- Seatbelt generation, command rewriting, credential path matching and environment
  scrubbing, Git/gh parsing, credential exceptions, and project cache workarounds.
- The executable permission hook, private policy snapshots, and snapshot cleanup.
- Replacement Codex execution/process tools and their host process manager.
- Mandatory hook attestation and disabling Codex's native shell tools.
- Blanket managed-session search, delegation, worktree, and unknown-tool bans.
- Enforcement-only tests, the hostile-code live matrix, and the separate Trusted
  Git matrix. Old enforcement reports are available in Git history rather than
  retained as current security claims.

## Retained and checked

- Small provider mappings and checks of the modes actually reported at startup.
- Explicit launch selection, Bypass confirmation, visible mode reporting,
  persistence, creation-ID validation, and no automatic recovery/replay.
- Native approval routing, original request inputs, one-time decisions, question
  handling, cancellation, and stale-response rejection. Claude approvals now
  snapshot inputs and reject changed requests reusing an ID. Codex forwards only
  decision/answer fields, without permission amendments.
- Foreman peer-tool authority limits and the project manager's separate role
  boundary. The PM cannot launch Bypass, including through the legacy bypass flag.
- Local API bearer/cookie authentication and host bridge authentication.

These application controls do not isolate the server from unrestricted code
running as the same user. In Bypass an agent can read the local API token, access
credentials, call localhost services, and perform authenticated GitHub operations.
There is no replacement deny list, credential broker, or auto-classifier.

## Issue #3

The dot-prefix gap is **obsolete because its implementation and contract were
removed**. `SECRET_COMPONENT`, `SECRET_NON_PEM_COMPONENT`, and the generated
Seatbelt regex no longer exist. Dot-prefixed secrets are not newly protected:
Foreman no longer promises credential-path protection at all. The issue can be
closed as obsolete, not described as a security fix.

## Verification and rollout

The replacement live suite uses real controllers and provider tools through an
isolated Foreman HTTP server. It requires successful provider turns, verifies
Native approvals, and checks Bypass authenticated gh/private Git execution on
both providers. Tool-result correlation and independent file artifacts replace
model prose as evidence. [Actual results and limitations](LIVE_POLICY_RESULTS.md)
record the runs, including failed attempts. The formerly failing Codex CLI 0.149.0
foreground-interruption regression now passes, with its completion-marker assertion
unchanged and additional process-table checks.

## Follow-up: session lifecycle, not permission enforcement

The failure was a race: Codex could report the turn interrupted before registering
and announcing its already-running shell. A one-off terminal cleanup missed that
shell. Foreman now remembers interrupted turns, cleans registered native terminals,
and terminates late announcements by their exact execution IDs. New sends cannot
race Stop cleanup, and a live follow-up command verifies the session stays usable.

Owned app-servers now run under a small process watchdog. It handles controller
close, thread unload/archive/close, broken transport, provider kill/crash, and
normal or abrupt Foreman shutdown. Native shell groups are separate from the
app-server group; signaling only the app-server PID or PGID was insufficient.
Shutdown now waits for cleanup. Shared external socket servers remain unowned.

Ordinary PID polling also failed five immediate-spawn/crash trials. The retained
macOS implementation uses kernel birth/original-parent identities and gates provider
startup until ownership is recorded; the same five trials now pass without a
readiness delay. This adds a small C helper and an explicit Command Line Tools
prerequisite. It does not reintroduce Seatbelt, shell rewriting, policy snapshots,
credential rules, hook attestation, or replacement execution tools. See the precise
platform and ownership limits in [session modes](SESSION_PERMISSIONS.md).

No deployment, installed-service restart, package manifest/lockfile changes, or
changes to the real `~/.foreman` or `.claude` directories are part of this work.
Only disposable test servers are started and restarted. The running installed
service retains its loaded implementation until an owner-managed restart.
