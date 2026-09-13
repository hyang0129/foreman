# Foreman readiness and blockers

Updated September 13, 2026 after orchestrating session-control proofs, local-host setup, and Codex monitoring. Cloudflare/Firebase logins were verified in the prior step. No cloud resources have been created or deployed.

## 1. Existing-session control

Implemented reusable controllers in `server/claude-control.ts` and `server/codex-control.ts`. The web UI still sends messages only to the PM; wiring full session chat to these modules is subsequent work.

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

## Remaining product work

| Requirement | Status |
| --- | --- |
| Cloudflare hosting | Login and write scopes verified. Worker configuration, authenticated outbound relay, host heartbeat/offline state, and deployment remain. |
| Firebase Google sign-in | Login verified as `hooong.yang@gmail.com`; project listing succeeded with no projects. User authorized project creation. Project/web-app creation, Google provider setup, allowed domain, server token verification, and identity allowlist remain. Project-creation rights/quota have not yet been exercised. |
| Happy-style UI | Source inspected at `slopus/happy` commit `4b7d763ee3afda04985f3210b9cb9acf9359c7d9`. Its Expo UI and Fastify/Socket.IO/Prisma server are not a drop-in Workers app. Adapt its session/chat interaction design. |
| Web session chat | Controllers exist; HTTP/cloud routing, user-facing approval/question controls, persisted receipts, and reconnect behavior still need integration. |
| Cross-provider collaboration | Native Claude peer delivery is proven. Claude↔Codex shared MCP/API tools, sender identity, update subscriptions, routing, access boundaries, and loop prevention remain. |

## Verification

24 automated tests passed across controller, fleet, hook installer/observer, launchd configuration, and process-shutdown checks, including a review regression for delayed Codex turn completion preserving a newer approval. Type checking passes for server code, TypeScript probes, and tests. Live provider proofs are listed separately above; unit tests are not substituted for live evidence.

## References

- [Codex app-server](https://learn.chatgpt.com/docs/app-server): threads, turns, Unix WebSockets, history, and approvals.
- [Codex hooks](https://learn.chatgpt.com/docs/hooks): lifecycle contract and trust review.
- [Claude cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging).
- [Claude streaming SDK input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) and [session resume](https://code.claude.com/docs/en/agent-sdk/sessions).
- [Firebase token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens) and [Google sign-in](https://firebase.google.com/docs/auth/web/google-signin).
- [Cloudflare Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
- [Happy session view](https://github.com/slopus/happy/blob/main/packages/happy-app/sources/-session/SessionView.tsx) and [Claude launcher loop](https://github.com/slopus/happy/blob/main/packages/happy-cli/src/claude/loop.ts).
