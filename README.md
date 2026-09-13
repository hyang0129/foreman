# Foreman

A private session inbox for a developer working with Claude and Codex on one Mac.

Start either provider in a project directory, follow its conversation, queue messages, answer approvals, and interrupt work from the browser. Managed sessions and the pinned project manager share tools for reading session state/history, sending messages, and requesting updates. Existing terminal sessions remain visible through hooks and are explicitly monitor-only.

**Local app:** http://localhost:4177

**Cloudflare app:** https://foreman.hooong-yang.workers.dev — deployed and paired, with sign-in blocked until Firebase activation finishes. See [Cloud setup](docs/CLOUD_SETUP.md).

## Run locally

```sh
npm install
npm run hooks:install
npm run hooks:codex:install
# In Codex: /hooks → review and trust the Foreman definitions.
npm start
```

Use installed provider logins. `FOREMAN_CODEX_BIN` selects a supported Codex executable; `FOREMAN_CLAUDE_BIN` overrides the SDK-bundled Claude binary. On this Mac, the launchd service already selects the newer VS Code Codex binary because the global 0.149 CLI cannot run the configured model.

The service is already installed on this Mac, so do not also run `npm start` on the same port/state directory:

```sh
npm run service:status
npm run service:restart
npm run status
```

Restart interrupts managed sessions and active PM work. The LaunchAgent restarts automatically and holds an AC-only sleep assertion. Keep the Mac awake, network-connected, and logged in. [Execution host details](docs/EXECUTION_HOST.md).

## Developer workflow

1. Open Foreman and choose **New session**. Pick Claude or Codex, a name, an existing absolute project directory, and the first task.
2. Open the session conversation. Follow-up messages queue while it works; saved receipts distinguish queued, running, completed, failed, and uncertain delivery.
3. Answer inline tool approvals or supported questions. Permission responses apply once. **Interrupt** also cancels queued follow-ups.
4. Ask a managed session to use Foreman peer tools: `list_sessions`, `session_state`, `session_tail`, `send_message`, `request_update`, and `message_status`. Sender identity is supplied by Foreman. An update is recorded in the target conversation; read it after completion.
5. Use the pinned **Project manager** to coordinate work. Its default spawns use the same managed Claude/Codex service.

The responsive inbox groups work needing your attention and shows provider, project, activity, host availability, and control limitations. Observed external sessions have readable available transcripts and no message controls. Trusting Codex hooks enables additional external-session monitoring; managed Codex sessions also report state directly through their controller.

## Persistence and boundaries

State lives under `~/.foreman` (override `FOREMAN_HOME`): managed snapshots/receipts, hook observations, PM history/memory, and the private cloud pairing. An exclusive service lock prevents simultaneous writers. Browser refresh restores history. Reusing a managed creation/message ID with identical input returns the existing result; different input is rejected.

After daemon restart, unfinished receipts become uncertain and recovered sessions become read-only. Nothing is automatically replayed or resumed. Start a new session to continue. The legacy PM conversation has separate history and does not yet share managed message deduplication. Arbitrary takeover of a live terminal/desktop, multiple users/hosts, and background push notifications are deferred.

The PM is a coordinator: specific existing document reads and memory reads only; no Bash, Glob, Grep, code, or subagent tools. Memory writes resolve parent symlinks and stay in its memory directory. It cannot directly read Foreman configuration. Sessions perform implementation work through their provider's normal permission flow.

## Verify

```sh
npm test
npm run typecheck
npm run cloud:test
npm run cloud:typecheck
npm run test:ui
```

Browser tests may require `npx playwright install chromium`. Automated tests use mocks/disposable state and do not call providers. The explicit integration probe makes small real provider calls in sessions it creates:

```sh
FOREMAN_CODEX_BIN=/absolute/path/to/supported/codex npm run probe:mvp -- --live
```

## Code map

| Path | Purpose |
| --- | --- |
| `server/session-service.ts` | Durable managed sessions, queues, history, approvals, recovery |
| `server/claude-control.ts`, `server/codex-control.ts` | Provider process/protocol adapters |
| `server/peer-tools.ts` | Shared Claude MCP, Codex dynamic tools, and PM interface |
| `server/fleet.ts`, `hooks/` | External-session discovery and hook monitoring |
| `server/main.ts`, `server/host-bridge.ts` | Loopback API and outbound authenticated relay |
| `cloud/worker.ts`, `cloud/auth.ts` | Cloudflare relay and Firebase verification |
| `web/` | Vanilla browser inbox and Google sign-in |
| `server/pm.ts`, `server/tools.ts` | Pinned PM and delegation tools |

[MVP plan](docs/MVP_PLAN.md) · [Readiness and remaining blockers](docs/BLOCKERS.md) · [Original design](docs/DESIGN.md)
