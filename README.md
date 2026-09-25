# Foreman

A private session inbox for a developer working with Claude and Codex on one Mac.

Start either provider in a project directory, follow its conversation, queue messages, answer approvals, and interrupt work from the browser. Managed sessions and the pinned project manager share tools for reading session state/history, sending messages, and requesting updates. Existing terminal sessions remain visible through hooks and are explicitly monitor-only.

**Local app:** http://localhost:4177

**Cloudflare app:** https://foreman.hooong-yang.workers.dev — deployed and paired, with Firebase Google sign-in configured for `hooong.yang@gmail.com`. See [Cloud setup](docs/CLOUD_SETUP.md).

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

## Install on Android

Foreman installs from Chrome as an app. There is no APK or Play Store listing; the installed app is the hosted web app, so every cloud deploy reaches it the next time you open it.

1. Open https://foreman.hooong-yang.workers.dev in **Chrome** on the phone. Open the ⋮ menu and choose **Install app** (on some phones it's **Add to Home screen** → **Install**). Foreman appears in the launcher and opens full screen.
2. Open Foreman and choose **Continue with Google** with the authorized account. You stay signed in until you sign out.
3. To get notifications, open the menu (☰) → **Notifications** → **Turn on notifications**, then allow them when Android asks. All kinds start on: approvals and questions, a session failed, project manager errors, and Mac offline (after it has been disconnected for over 5 minutes). Untick a kind to stop it. **Send test notification** checks delivery to this phone.
4. Tapping a notification opens that conversation, or the project manager.

Notifications carry only the kind of event, the session name, and the Mac's name. Transcript text, tool input, file paths, and error details never leave the Mac in a notification; you see them after the app opens and loads them through your signed-in session.

To stop notifications on this phone, open **Notifications** → **Turn off**. **Sign out** also removes this phone's subscription. You can block them from Android instead (Settings → Apps → Foreman → Notifications). If you blocked them and want them back, allow them there first; Foreman then offers **Turn on notifications** again.

Everything still runs on the Mac. Notifications and the app work only while the Mac is awake and connected; the phone is a remote control. When the Mac is unreachable, the app shows an offline screen and keeps your draft.

For QA, https://foreman-dev.hooong-yang.workers.dev (see [Cloud setup](docs/CLOUD_SETUP.md)) installs and notifies the same way as a separate app. Use it only to test a branch; it's torn down and redeployed often.

Known contingency: sign-in uses a Google popup. If the popup ever fails in the installed app, the fallback is redirect sign-in through the Worker (tracked as AND-C in #43, not built).

## Developer workflow

1. Open Foreman and choose **New session**. Pick Claude or Codex, a model (or provider default), a name, an existing absolute project directory, a permission mode (Native by default), and the first task. Bypass is visibly marked and requires confirmation. See [Session permissions](docs/SESSION_PERMISSIONS.md) for the native provider mappings and their limits.
2. Open the session conversation. Follow-up messages queue while it works; saved receipts distinguish queued, running, completed, failed, and uncertain delivery.
3. Answer inline tool approvals or supported questions. Permission responses apply once. **Interrupt** also cancels queued follow-ups.
4. Ask a managed session to use Foreman peer tools: `list_sessions`, `session_state`, `session_tail`, `send_message`, `request_update`, and `message_status`. Sender identity is supplied by Foreman. An update is recorded in the target conversation; read it after completion.
5. Use the pinned **Project manager** to coordinate work. Its default spawns use the same managed Claude/Codex service. Choose its Claude model below the conversation while it is idle; the choice is saved in `~/.foreman/pm/settings.json` and applies to subsequent turns. Before the first saved choice, `FOREMAN_PM_MODEL` supplies the optional default. The PM can discover worker models with `list_models` and pass a model to `spawn_session`. Worker model selection is made when starting a new session.

The responsive inbox groups work needing your attention and shows provider, project, activity, host availability, and control limitations. Observed external sessions have readable available transcripts and no message controls. Trusting Codex hooks enables additional external-session monitoring; managed Codex sessions also report state directly through their controller.

## Persistence and boundaries

State lives under `~/.foreman` (override `FOREMAN_HOME`): managed snapshots/receipts, hook observations, PM history/memory, and the private cloud pairing. An exclusive service lock prevents simultaneous writers. Browser refresh restores history. Reusing a managed creation/message ID with identical input returns the existing result; different input is rejected.

After daemon restart, unfinished receipts become uncertain and recovered sessions become read-only. Nothing is automatically replayed or resumed. Start a new session to continue. The legacy PM conversation has separate history and does not yet share managed message deduplication. Arbitrary takeover of a live terminal/desktop and multiple users/hosts are deferred. Push notifications exist only on the hosted app (see [Install on Android](#install-on-android)), not at `localhost:4177`.

The PM is a coordinator: specific existing document reads and memory reads only; no Bash, Glob, Grep, code, or subagent tools. Memory writes resolve parent symlinks and stay in its memory directory. It cannot directly read Foreman configuration. Managed sessions perform implementation work under their immutable launch preset and the mandatory protected-path guard.

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
