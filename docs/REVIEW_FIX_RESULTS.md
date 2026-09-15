# Issue #2 consolidated review fixes

2026-09-14, baseline `4c479d8`. This pass covers the permission-policy review only.
Issue #3 and epic #1 are unchanged. No deployment or installed-service restart
was performed. Root package manifests, the repository `.claude/`, real
`~/.claude`, and `~/.foreman` were left unchanged. The scratch brief was removed
before the final commit.

## Findings and reproduction evidence

The runtime counterexamples used disposable projects, synthetic credential data,
and a test-owned server with an isolated state directory and an assigned port.
Baseline and removed-mechanism replays distinguish existing implementation bugs
from missing tests. A failed live provider precondition is never counted as an
exercised authorization boundary.

| Finding | Reproduction / disposition |
| --- | --- |
| 1. Git credential relaxation | A repository `core.sshCommand` wrote both `SYNTHETIC_GH_SECRET` from a fake `hosts.yml` and `SYNTHETIC_ENV_SECRET` from GH_TOKEN to STOLEN. The same test now finds neither. Removed the credential-read exception and token retention entirely, including for gh. Authenticated gh/private Git compatibility is intentionally unavailable; no authentication broker was introduced. |
| 2. Package egress and self-launch API | A temporary npm preinstall reached a loopback HTTP listener and exited 0 without approval. An unauthenticated request to the isolated server's session API returned 200. Package operations no longer qualify for automatic networking. Guarded commands independently deny loopback egress, including at Full, and the API requires a token. Regression checks cover denied unauthenticated Full creation, valid bearer/cookie access, invalid tokens, and bridge authentication. |
| 3. Codex Workspace ask collapsed | Replaying the old mapping made executable hook checks for Read, view_image, and WebFetch return allow instead of ask. The hook preserves ask. Current provider compatibility prevents live activation; executable-hook evidence is separate. |
| 4. Stdin widened an exact approval | One approved `sh` accepted an outside-read command over foreman_process stdin; the new rejection test failed with the old branch. Processes with a one-time escape now refuse stdin. Polling/termination remain available. |
| 5. Claude preapproved escape | Executing the old Workspace decision's wrapped `touch` created a sibling file without any escape request. Ordinary approval now retains confinement; only an explicit request and subsequent approval rebuild the command with outside access. The approval shows the command and the requested grant. Tests cover confinement and successful explicit approval. |
| 6. Empty native grant | A real RPC fixture sends item/permissions/requestApproval at all four presets and requires exactly `{permissions:{},scope:'turn'}`. Restoring a session network grant turns the new test red. |
| 7. Private snapshot | The test resolves the executable hook outside the repository, checks private directory permissions and byte-identical policy copy, executes it, and verifies cleanup. Repointing the hook to the live source turns the test red. Claude uses its already-loaded module; the live source-edit probe is recorded separately. |
| 8. Workspace approval denial | A false approver must reject and leave the command's target absent. Removing the denial branch turns the test red. |
| 9. Claude immutable approval input | Attempting to replace a pending wrapped command with raw input throws and leaves the original request pending. Removing the guard turns the test red. |
| 10. Mode mismatch hang | Removing the init-mode check now fails within the test's one-second timeout, with cleanup, instead of hanging the entire job. |
| 11. Requested-preset tautology | A deliberately misreported Full row requested as Workspace must fail before peer/UI work. The harness retains `requested` on the returned row and uses it for API, peer, and UI comparisons. Restoring the API-to-itself comparison turns the test red. |
| 12. Native disclosure blindness | Synthetic native item/started and item/completed disclosures now fail the leak assertion. A fake provider event emitter verifies the actual live observer forwards these events. Restoring either old filter turns tests red. Both Workspace and Trusted outside-read probes check token absence. |
| 13. Non-macOS proof gap | The regular suite now contains an explicit mandatory macOS enforcement check. Substituting Linux produces a labeled failure. No actual Linux enforcement run is claimed. |
| 14. Missing credential stores | Baseline protectedPath returned false for all six listed standard stores. Tests now exercise the native predicate and actual Seatbelt reads against synthetic home fixtures; none discloses content. No generic dot-prefix changes were made. |
| 15. Unverified Codex config | Installed CLI 0.149.0's thread/start response has no effective-config attestation. Authenticated diagnostic runs completed a seed turn but did not execute the diagnostic hooks; hooks/list reported untrusted definitions. New config/read and hooks/list validation refuses activation when settings or the exact trusted guard are missing. Six fault-injection cases and removal of the validation turn tests red. **Current Foreman/Codex integration fails closed; compatible managed Codex launch remains unresolved.** |
| 16. Temp pollution | The old command left populated `.foreman-tmp` after exit. New command-specific caches clean up on normal exit; each contains a self-ignoring `.gitignore`. An actual killed command leaves no `git status` entry. Empty directories alone were not Git pollution; the cache files were. |
| 17. Lost result delivery | A fixture closes the thread before a pending command result completes. Previously the delivery exception disappeared. Now a diagnostic is emitted and the controller disconnects/closes; the failure is surfaced to the session owner. |
| 18. Completed process cap | With 100 completed-but-uncollected entries, removing opportunistic reaping reproduces a rejected new command. New spawns now reap completed entries. The oldest uncollected completed output can therefore be discarded; output is already bounded and active process ownership is unchanged. |
| 19. Background Bash dead end | Baseline toolDecision allowed run_in_background while monitor/stop tools were denied. Background Bash now returns an explicit actionable refusal. |
| 20. JSON null | Executing baseline permissionMode(null) throws. It now normalizes to Workspace like omission. |
| 21. Workspace provider split | The baseline Claude wrapped command could write outside; Codex's confined command could not without request_access. Their command grants now match. Claude still prompts for each Bash call, whereas Codex prompts only for an explicit escape; this difference is documented. |
| 22. Snapshot hard-kill leak | A baseline mkdtemp/SIGKILL replay left the snapshot. New snapshots carry an owner marker; an actual SIGKILL regression verifies removal on the next sweep. Live/unknown/symlinked snapshots are preserved. **Old unmarked snapshots and PID reuse remain conservative cleanup limitations.** |
| 23. FOREMAN_HOME inheritance | The original executable hook with FOREMAN_HOME removed allows a synthetic custom state-root read at Full; explicit argv now denies it. **The claim that this installed Codex applies shell_environment_policy.exclude to hook processes could not be verified because those hooks did not execute.** The argv change makes that inheritance assumption unnecessary; it is not evidence that filtering caused a live bypass. |
| 24. Description/reporting drift | Inspection confirmed the PM flat denial contradicted the spawn description. The description now directs elevated launches to New session. A peer fixture distinguishes managed `permission_mode:full` from observed `provider_permission_mode:bypassPermissions`. |
| 25. Dead branches | Baseline Glob at the system trust tree still returned deny at every preset. Recursive searches are now denied before path computation; removed unreachable READ_TOOLS entries, the identity conditional, and the unused approvedInput default. |

## Sabotage verification

All **18 mutation checks exited nonzero**, with the production mechanism restored
in a `finally` block after each run:

- P1 #6–#13: nine checks (separate #12 observer and leak-assertion mutations).
- P0: loopback denial, API authentication, Codex ask mapping, escaped-process stdin,
  Claude Workspace confinement, and restoration of package egress.
- P2: completed-process reaping, explicit hook state-root argv, and config attestation.

The Git credential and package-lifecycle regression tests also failed against the
original mechanisms with actual synthetic disclosure / an observed HTTP request.
The one-second mismatch timeout was exercised by deleting the production guard,
not merely by testing a helper timer. All mechanisms were restored before final
verification and commits.

## Owner decision and remaining limitations

The default behavior change is documented, not redesigned: native Glob/Grep are
refused; Claude Workspace shell searches require approval; project native
Write/Edit auto-allow; unknown tools fail closed. That trades search convenience
and per-edit review for the new policy boundary. The owner still needs to decide
whether this is the desired default experience.

The current Codex integration cannot attest an active trusted guard, so managed
Codex launches are unavailable. Authenticated gh/private Git no longer consume
host credentials. Old unmarked snapshot directories are not swept blindly.
Unobserved live native escalation attempts remain failures. None of these is
presented as a closed compatibility or live-coverage issue.

Full matrix numbers, per-preset results, focused Git results, and required checks
are recorded in [LIVE_POLICY_RESULTS.md](LIVE_POLICY_RESULTS.md). The historical
106/23 run is retained there and is not the result of this pass.
