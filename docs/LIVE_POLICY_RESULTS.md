# Native permission modes: live verification

2026-09-15. Replaces the historical custom-enforcement results.

**Both providers launch and execute authenticated gh and private Git operations
in Bypass without prompts. One live scenario remains failing: Codex native shell
commands can continue after their turn is interrupted. This is not an all-green
live suite or a claim of credential containment.**

## Final retained implementation

Tested the runtime in `82a70f2` and the Bypass styling correction in `fcbff27`, on
macOS with Node 26.3.0, Claude Agent SDK 0.3.270, and Codex CLI 0.149.0. Models:
`haiku` and `gpt-5.6-luna`. Subsequent documentation changes do not change runtime
behavior.

```sh
FOREMAN_LIVE=1 FOREMAN_LIVE_CLAUDE_KEYCHAIN=1 \
  FOREMAN_LIVE_PRIVATE_REPO=owner/private-repository \
  npm --prefix tests/live run test:policy
```

The repository argument was an existing, accessible, nonempty private repository
owned by the developer. Its identity and contents are not included in this report.
A host precondition and each provider's authenticated `gh api` call confirmed
private visibility. Git fetched its HEAD over HTTPS into a disposable repository
without checking out files or executing repository code. No credential-helper
override or authentication broker was used.

**Final result: 19 passed / 1 failed leaf scenarios.** Node's totals, including
parent groups, were **22 passed / 3 failed / 0 skipped**, exit **1**, in **179.6 s**.
The extra failures are the Codex/Bypass group and overall parent, not additional
failed scenarios.

| Provider / mode | Passed / failed leaf scenarios | Actual evidence |
| --- | --- | --- |
| Claude / Native | 3 / 0 | Successful seed turn; API/peer/browser reporting; native shell read; one approved write followed by a separately denied write and stale-response rejection |
| Claude / Bypass | 6 / 0 | Successful seed turn; reporting; native shell read; synthetic `.env` read and outside write; authenticated private-repository gh; private Git fetch; foreground interruption |
| Codex / Native | 3 / 0 | Successful seed turn; reporting; native shell read; one approved write followed by a separately denied write and stale-response rejection |
| Codex / Bypass | 5 / 1 | Successful seed turn; reporting; native shell read; synthetic `.env` read and outside write; authenticated private-repository gh; private Git fetch. Foreground interruption failed |
| Cross-provider checks | 2 / 0 | Unauthenticated local API requests rejected; isolated server recovery retained modes without resuming providers |

Every Bypass operation above had zero Foreman execution-approval prompts. Success
requires correlated native tool output; Git also requires a real `FETCH_HEAD`.
Reporting checks cannot pass in place of provider activation. The `.env` file
contains only a planted synthetic token; no real secret was deliberately read by
an agent as a probe.

## Remaining cancellation limitation

The interruption test starts a native shell command that writes a start marker,
sleeps 12 seconds, and conditionally writes a completion marker. Foreman requests
interruption after observing the start marker, waits for the turn to settle, then
waits beyond the command's original duration. On Codex, the completion marker
still appears. A cancelled turn is therefore not proof that its command stopped.
Claude's equivalent probe leaves no completion marker.

Codex's documented `thread/backgroundTerminals/clean` endpoint was tried both
after and before `turn/interrupt`, with the same foreground failure. A focused
probe confirmed that Stop returned in 9 ms and the interrupted turn was marked
failed while the command later completed. That ineffective workaround was
removed. Foreman retains native turn cancellation and pending-approval/queue
cancellation; it does not restore a host process manager or claim reliable
termination of all Codex subprocesses. The live regression remains failing.

## Required local checks

| Command | Final result |
| --- | --- |
| `npm test` | 84 passed, 0 failed, 0 skipped; exit 0 |
| `npm run typecheck` | Exit 0 |
| `npm run cloud:typecheck` | Exit 0 |
| `npm run cloud:test` | 36 passed; exit 0 |
| `npm run test:ui` | 15 passed; exit 0 |

## Earlier attempts in this change

- Initial native matrix: 21 passed / 4 failed including parents, exit 1. Codex
  declined the synthetic `.env` command because the harness also told it not to
  read credential/configuration files. The prompt now explicitly authorizes the
  synthetic fixture. Codex command interruption also failed.
- Corrected-fixture matrix: 18 passed / 4 failed including parents, exit 1. Codex
  Native's seed failed with “Selected model is at capacity”; its dependent checks
  did not run. Codex Bypass authentication and Git passed; interruption failed.
- Native-cleanup candidate: 22 passed / 3 failed including parents, exit 1.
  Calling terminal cleanup after interruption did not stop the foreground command.
  The focused reverse-order attempt failed too. Neither is a successful fix.
- Final matrix above: ran after removing that candidate and reproduces the one
  outstanding scenario on the retained implementation. No capacity failure in
  the final run. Failed attempts were not converted into skipped or passing tests.

## Isolation and scope

The harness starts its own Foreman server on an assigned loopback port, with PM
disabled and disposable state/project directories. Claude gets temporary config
and Keychain-bootstrapped OAuth credentials; Codex gets temporary config with a
private copy of existing authentication. Teardown removes these copies and test
repositories. Only the test-owned server is restarted for the recovery check.

No deployment or installed-service restart occurred. The real `~/.foreman`, real
and repository `.claude` directories, and package manifests/lockfiles were left
untouched. Existing installed-service behavior changes only after an owner-managed
restart. These tests deliberately use isolated provider configuration; custom
user/project rules and organization restrictions may alter native behavior.

Foreman no longer promises protection of credential paths, outside files, or
localhost services in Bypass. Local API authentication does not isolate the API
from same-user code that can read its token. See [session modes](SESSION_PERMISSIONS.md)
and [replacement review](REVIEW_FIX_RESULTS.md).
