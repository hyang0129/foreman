# Native modes and session lifecycle: live verification

2026-09-15. Supersedes the previously documented Codex interruption failure.

**The original interruption regression passes.** Its assertion that the completion
marker must remain absent is unchanged. Both providers still launch, execute native
shell commands, and perform authenticated gh/private Git operations in Bypass.

Test environment: macOS, Node 26.3.0, Claude Agent SDK 0.3.270, Codex CLI 0.149.0;
models `haiku` and `gpt-5.6-luna`. Tests use the real Foreman service and controllers.
The runtime fix is committed in `f36839e`. An additional live interruption
smoke check on that commit passed **1/1**, exit 0, in **24.9 seconds**: shell
59901 and child 59902 disappeared, and a same-session follow-up command executed.

## Required checks

| Command | Result |
| --- | --- |
| `npm test` | 95 passed, 0 failed, 0 skipped; exit 0 |
| `npm run typecheck` | Exit 0 |
| `npm run cloud:typecheck` | Exit 0 |
| `npm run cloud:test` | 36 passed across 2 files; exit 0 |
| `npm run test:ui` | 15 passed; exit 0 |

Cloud tests still print a missing `HOST_TOKEN` configuration warning; all 36 tests
pass in their test environment. This is not verification of deployed cloud secrets.

## Native-mode matrix

```sh
FOREMAN_LIVE=1 FOREMAN_LIVE_CLAUDE_KEYCHAIN=1 \
  FOREMAN_LIVE_PRIVATE_REPO=owner/private-repository \
  npm --prefix tests/live run test:policy
```

**25 passed / 0 failed / 0 skipped, exit 0, 125.2 seconds** including parent groups:
20 leaf scenarios across Claude/Native (3), Claude/Bypass (6), Codex/Native (3),
Codex/Bypass (6), and cross-provider authentication/recovery checks (2).

Evidence includes successful provider seed turns; API/peer/browser mode reporting;
native shell reads; one-time approved and separately denied writes; stale approval
rejection; synthetic `.env` reads and outside writes; authenticated gh access to an
existing private repository; and a real private HTTPS Git fetch with `FETCH_HEAD`.
Both providers' Bypass operations require no execution-approval prompts. Repository
identity, contents, and credentials are not published in this report.

For interruption, the unchanged command writes a start marker, sleeps 12 seconds,
and then would write a completion marker. The test now records the OS shell and
child PIDs/PGID before Stop, requires that group to disappear from `ps`, waits
another 13 seconds, checks `ps` again, and retains the original absent-marker
assertion. In the successful Codex matrix run, shell **44070** and child **44071**
in group **44070** were present before Stop and absent afterward. Claude's process
group and original marker assertion also passed.

## Codex lifecycle matrix

```sh
FOREMAN_LIVE=1 FOREMAN_LIVE_CLAUDE_KEYCHAIN=1 \
  node --experimental-strip-types --test --test-concurrency=1 tests/live/lifecycle.live.mjs
```

**9 passed / 0 failed / 0 skipped, exit 0, 131.3 seconds.**

| Case | Shell PID / child PID / PGID before teardown | After teardown |
| --- | --- | --- |
| Interrupt | 52517 / 52518 / 52517 | Group absent; same-session follow-up executed |
| Controller close | 53144 / 53145 / 53144 | Owned provider and command groups absent |
| Thread archive/unload | 53688 / 53690 / 53688 | Owned provider and command groups absent |
| Provider SIGKILL | 54162 / 54163 / 54162 | Owned provider and command groups absent |
| Provider SIGABRT | 54648 / 54649 / 54648 | Owned provider and command groups absent |
| Provider killed immediately by its new shell | 55201 / 55202 / 55201 | Owned provider and command groups absent |
| Background child after shell exit | 55738 / 55739 / 55738 | Owned provider and command groups absent |
| Foreman SIGTERM | 56181 / 56183 / 56181 | Groups absent; daemon exit 0 |
| Foreman SIGKILL | 56588 / 56589 / 56588 | Groups absent despite abrupt owner death |

Each case starts a real native command with a 120-second child. Checks inspect
whole OS process groups before fixture cleanup; the harness cannot make a test
pass by killing leftovers during teardown. Close/crash cases also check every
observed provider group, including the npm launcher, native binary, watchdog, and
code-mode host. The interrupt case executes another native command in the same
session afterward.

Cases: interrupt; controller close; real native thread archive/unload; native
provider SIGKILL; native provider SIGABRT; provider killed by its just-started
shell without a readiness delay; background child after its shell exits;
Foreman SIGTERM shutdown; and Foreman SIGKILL. Thread archive can close the
controller before the archive RPC reply arrives: the authoritative evidence is
the native `notLoaded` transition and the empty process table, not that RPC error.

The immediate-crash and background cases publish a completed `ps` snapshot by
atomic rename before triggering teardown. This avoids confusing an opened but
not-yet-written evidence file with the process snapshot.

## What was fixed and what was tried

- Original reproduction: the shell was already running, but native terminal list
  was empty. `turn/completed(interrupted)` arrived before `item/started` for that
  command. A cleanup before or immediately after interruption could miss it.
- Retained fix: native interruption plus terminal cleanup, with exact-ID termination
  of late command announcements belonging to the interrupted turn. Unsupported or
  failed cleanup retires the managed controller rather than claiming it stopped.
- Adjacent gap: native archive emitted `notLoaded`/`thread/archived`; Foreman handled
  only `thread/closed`. It now retires the runtime for all three terminal states.
- A watchdog using only `ps` parent PIDs leaked in **5/5** synthetic trials that
  killed the provider immediately after detached spawn. The macOS birth-identity
  helper and startup gate passed **5/5** corresponding trials with no readiness
  delay. Automated tests also retain detached children, TERM-ignoring processes,
  unrelated sentinel processes, PID reuse checks, and killed owner/provider cases.
- Early live attempts failed on a TypeScript strip-types startup mistake (fixed),
  a Claude command selector that did not account for native shell quoting (now
  locates the unique fixture marker), and the unhandled thread-unload path (fixed).
- The first expanded nine-case run was **8 passed / 1 failed**: the immediate-crash
  test read its `ps` artifact before the writer finished. Publishing that artifact
  atomically kept the assertion intact; the focused rerun passed.

## Scope and isolation

The crash evidence is for **managed Codex on macOS**. The helper requires Xcode
Command Line Tools and reads kernel process identity metadata; it does not change
permissions, TCC, native shell commands, or credential handling. Linux lacks the
macOS original-parent recovery and was not live-certified here. Shared external
app-servers and Claude SDK crash cleanup are not covered by the Codex crash matrix.
See [session lifetime and its limits](SESSION_PERMISSIONS.md#managed-codex-process-lifetime).

Every test server uses an assigned loopback port, PM disabled, disposable
`FOREMAN_HOME`, projects, and provider configuration. Claude credentials come from
Keychain into temporary config; Codex receives a private temporary copy of existing
authentication. Private Git fetches into a disposable repository without checkout
or execution. Test-owned state, credentials, and helper builds are removed afterward.

No deployment or installed Foreman restart occurred. Package manifests/lockfiles,
the real `~/.foreman`, and real/repository `.claude` directories remain untouched.
The installed service retains its loaded code until an owner-managed restart.
Bypass still offers no credential isolation; local API authentication does not
isolate Foreman from same-user code that can read its token.
