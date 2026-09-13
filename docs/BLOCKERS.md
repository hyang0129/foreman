# Foreman readiness and blockers

Updated September 13, 2026 after implementing and testing the developer MVP. Cloudflare is deployed at https://foreman.hooong-yang.workers.dev and the Mac relay is connected. The local app is usable at http://localhost:4177. Google sign-in remains blocked by Firebase project activation.

## MVP release state

Implemented: session-first responsive browser, managed Claude/Codex creation, direct conversations, durable message queues/receipts, approvals/questions, interruption, peer tools, private Cloudflare relay, Google-token verification, and explicit offline/restart behavior. [Plan](MVP_PLAN.md) · [Cloud setup](CLOUD_SETUP.md).

**Remaining external actions:**

1. **Firebase activation:** Google Cloud project `foreman-hong-2026` exists. All four required IAM permissions are verified and Firebase Management API is enabled, but `addFirebase` returns HTTP403. The user has been asked to open Firebase Console and complete terms/project activation. After that, deploy the checked-in Google auth configuration, retrieve the public web SDK config, authorize the Workers domain, redeploy, and verify actual Google login. Hosted APIs remain locked while this is pending.
2. **Codex hook trust:** review/trust the installed Foreman hooks in `/hooks`. Managed Codex sessions work through controller events already; live monitoring of external sessions depends on this trust gate.

**Intentional MVP limits:** one user/one Mac; discovered external sessions are monitor-only. On daemon restart, managed history/receipts remain but sessions become read-only and unfinished delivery becomes uncertain. Start a new session to continue; automatic resume is deferred. The pinned legacy PM conversation lacks managed message deduplication. Unsupported provider dialogs require interruption/local action. Actual Google sign-in and the full authenticated cloud-to-provider journey cannot be verified until Firebase activation completes.

## New MVP live proof

`scripts/probe-mvp.ts --live` passed with disposable sessions: both providers completed queued follow-ups with retained context; Claude invoked peer MCP to request a Codex update with an attributed durable receipt and response; Codex invoked dynamic tools to read Claude state/history; Claude tool approval was denied through the shared service; reopening the store retained history/receipts without replay. Supported question handling is covered by mocked provider and browser tests, not a live model question proof. No existing user working session was messaged or stopped.

## 1. Existing-session control

Implemented reusable controllers in `server/claude-control.ts` and `server/codex-control.ts`. The session service now connects these adapters to direct browser chat and peer tools; historical lower-level proofs are retained below.

| Proof | Result | Boundary |
| --- | --- | --- |
| Managed Claude queued input | Passed live: second prompt retained the first prompt's nonce. | Serial SDK input; deduplication is in memory for the controller lifetime. |
| Claude permission response | Passed live: Bash request reached the controller, was denied, and the session completed. | No permanent permission changes. Generic dialogs and AskUserQuestion are not live-tested. |
| Stopped external Claude handoff | Passed live: independently spawned CLI exited, then SDK resumed its session with context preserved. | This is a handoff after exit, not takeover of a live TTY. |
| Native Claude live peer delivery | Passed live: a separately launched headless CLI remained running and acknowledged an SDK sender's cross-session message. | Receiver declined the requested exact nonce response. Agent-message delivery is not a guarantee of compliance or direct-user authority. Arbitrary TTY/desktop takeover and busy-peer behavior remain unproven. |
| Codex shared-server attachment | Passed live: an independent client created a session, a second client attached and queued a message, and the original client observed completion. | Both clients connected to one private app-server Unix socket. |
| Codex real terminal attachment | Passed live: a real TUI launched with `--remote` created its own thread; a separate Foreman client attached and sent a second turn. The still-running TUI displayed both the external prompt and `FMTUI_REMOTE_CONFIRMED.` | Private Unix app-server, two tiny model turns. Hook review used “Continue without trusting”; user trust was unchanged. The disposable thread was archived and test processes stopped. This does not prove takeover of an arbitrary desktop or separate stdio server. |
| Codex history and reconnect | Passed live: history was readable; disconnect/reconnect retained the same thread and accepted another turn. Three successful turns total. | A disk-only thread is not implicitly resumed. Existing sessions on a different server require that server's endpoint or a stopped-session handoff. |
| Codex busy steering and approval broker | Protocol tests pass for busy handling, expected-turn IDs, one-time approval response, stale request rejection, and disconnect cleanup. | These are simulated protocol tests, not live model approval/steering proofs. |

The shell Codex CLI is **0.149.0** and rejects the configured `gpt-6-astra` model with an upgrade-required error. The successful live proof used the existing VS Code bundled binary **0.154.0-alpha.6.2**. `FOREMAN_CODEX_BIN` selects that executable; the installed Foreman service records the override. The global CLI was not replaced. Reinstall the service with a supported binary if the extension path changes.

Live probes are explicit and isolated:

```sh
npm run probe:claude -- --live
npm run probe:claude:peer -- --live
FOREMAN_CODEX_BIN=/absolute/path/to/supported/codex npm run probe:codex -- --live
```

They consume small provider usage and only target sessions they create. No existing user working session was messaged or stopped. Probe scripts distinguish transport delivery from receiver compliance and do not bypass approval or hook trust.

## 2. Local execution host

**Installed and running:** a user LaunchAgent, `com.foreman.daemon`, runs Foreman on `127.0.0.1:4177`. The previous manual Foreman process was verified to belong to this checkout and have an idle PM before handoff. Health and restart checks passed. SIGTERM shutdown with an open SSE client is also covered by a process-level test.

The service restarts automatically, logs to `~/.foreman/logs/`, and uses an AC-only `caffeinate -s` assertion. It changes no permanent power settings. The Mac still needs power, network, an open lid, and a logged-in user. Battery operation, explicit sleep, logout, and shutdown can take it offline. Login/reboot recovery has not been exercised.

For execution while this laptop is off, use a dedicated powered host with its own repositories and provider authentication. An always-on host cannot keep processes on a powered-off laptop running; sessions need a controlled handoff or restart there. No additional host has been provisioned.

See [Execution host](EXECUTION_HOST.md) for service commands, installation configuration, and migration details.

## 3. Codex monitoring

**Implemented and installed:** 12 lifecycle observer hooks in `~/.codex/hooks.json`, plus a safe installer/uninstaller. The installer preserves unrelated handlers and backs up existing files. Events serialize per session, write atomically, and guard completed turns against late tool events. Unsafe transcript references are rejected.

The fleet and UI now distinguish providers with `session_key` values such as `codex:<id>`. Ambiguous bare IDs/names are rejected. Legacy Codex JSONL message records are supported; paginated history is accessed through the app-server adapter. Unknown liveness remains unknown rather than being reported as a dead process solely because a hook record is old.

**Remaining user action:** Codex `hooks/list` finds the 12 enabled Foreman hooks but reports them as **untrusted**. Open `/hooks` in Codex, review and trust those definitions, then start or resume a session. This is Codex's runtime trust gate; the installer does not bypass it. End-to-end live hook delivery remains pending that action. Lifecycle, concurrency, path validation, and installation tests pass in temporary directories.

## Verification

The final automated suites pass **98 tests: 51 Node, 36 Workers, and 11 browser**. They cover local controllers/service/PM guards/hooks/bridge, Workers JWT and Durable Object routing, and browser flows, including a large-fleet layout regression. Typechecks pass for Node, Workers, and Workers tests. The explicit live MVP proof above is separate from mocked tests. The deployed static page and unauthenticated API rejection were checked over HTTPS; the installed daemon reports its cloud relay connected. A separate real-browser journey through the local HTTP API created a disposable Codex session, sent a follow-up, and displayed two completed receipts with retained context and no browser errors. Test daemon/provider processes were stopped and temporary state removed.

The review also removed PM shell/search execution and unrestricted Foreman-state reads. A PreToolUse guard applies before provider auto-approval, preventing the PM from reading the relay credential through file tools or symlink aliases.

## References

- [Codex app-server](https://learn.chatgpt.com/docs/app-server): threads, turns, Unix WebSockets, history, and approvals.
- [Codex hooks](https://learn.chatgpt.com/docs/hooks): lifecycle contract and trust review.
- [Claude cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging).
- [Claude streaming SDK input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) and [session resume](https://code.claude.com/docs/en/agent-sdk/sessions).
- [Firebase token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens) and [Google sign-in](https://firebase.google.com/docs/auth/web/google-signin).
- [Cloudflare Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
- [Happy session view](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/-session/SessionView.tsx) and [Claude launcher loop](https://github.com/slopus/happy/blob/main/packages/happy-cli/src/claude/loop.ts).
