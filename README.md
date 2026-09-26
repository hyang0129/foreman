# Foreman

A private session inbox for a developer working with Claude and Codex on one Mac.

Start either provider in a project directory, follow its conversation, queue messages, answer approvals, and interrupt work from the browser. Or ask the pinned **Coordinator**: it starts **Project Leads**, managed Claude sessions that each own one workstream and start their own worker sessions. Managed sessions and the Coordinator share tools for reading session state/history, sending messages, and requesting updates. Existing terminal sessions remain visible through hooks and are explicitly monitor-only.

The Coordinator was called the project manager (PM) before epic #157. Only the name changed on screen: API routes, relay frames and tables, and deep links still say `pm` (`/api/pm/*`, `?view=pm`).

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

Use installed provider logins. `FOREMAN_CODEX_BIN` selects a supported Codex executable; Foreman runs the installed `claude` found on its own `PATH` (the service's explicit search path) for model discovery, managed sessions (Leads and workers included) and the Coordinator; `FOREMAN_CLAUDE_BIN` overrides it, and the SDK-bundled binary is used only when no installed `claude` is found. `npm run status` shows which CLI and version the daemon uses. On this Mac, the launchd service already selects the newer VS Code Codex binary because the global 0.149 CLI cannot run the configured model.

The service is already installed on this Mac, so do not also run `npm start` on the same port/state directory:

```sh
npm run service:status
npm run service:restart
npm run status
```

Restart interrupts managed sessions and active Coordinator work. Every Lead and worker ends (history kept, nothing replayed or respawned), Leads move under Archived, and a Bypass launch still waiting for approval expires. The LaunchAgent restarts automatically and holds an AC-only sleep assertion. Keep the Mac awake, network-connected, and logged in. [Execution host details](docs/EXECUTION_HOST.md).

## Install on Android

Foreman installs from Chrome as an app. There is no APK or Play Store listing; the installed app is the hosted web app, so every cloud deploy reaches it the next time you open it.

1. Open https://foreman.hooong-yang.workers.dev in **Chrome** on the phone. Open the ⋮ menu and choose **Install app** (on some phones it's **Add to Home screen** → **Install**). Foreman appears in the launcher and opens full screen.
2. Open Foreman and choose **Continue with Google** with the authorized account. You stay signed in until you sign out.
3. To get notifications, open the menu (☰), tap **Notifications** at the bottom of the panel, then **Turn on notifications**, then allow them when Android asks. All kinds start on: approvals and questions (including **Launch with Bypass** requests), a session failed, Coordinator errors, and **Machine offline** (the Coordinator's machine has been disconnected for over 5 minutes). Untick a kind to stop it. **Send test notification** checks delivery to this phone.
4. Tapping an approval, question, or failed-session notification opens that conversation; a Coordinator error opens the Coordinator; **Machine offline** and test notifications open Foreman's home screen.

Notifications carry only the kind of event, the session name, and the machine's name (for example "Approval needed: fix-login is waiting for your approval"). Transcript text, tool input, file paths, and error details never leave the machine in a notification; you see them after the app opens and loads them through your signed-in session.

To stop notifications on this phone, open the menu (☰) → **Notifications** → **Turn off**. **Sign out** also removes this phone's subscription. You can block them from Android instead (Settings → Apps → Foreman → Notifications). If you blocked them and want them back, allow them there first; Foreman then offers **Turn on notifications** again.

Everything still runs on the machine that runs the Coordinator (macOS or Linux); the phone is a remote control. When that machine is asleep or disconnected, the app still opens and shows it offline by name with the last known state: the Coordinator chat's machine line says "Your Coordinator's machine (name) is offline.", and elsewhere a banner says the machine is disconnected. Sending messages, answering approvals, and starting sessions are disabled until it reconnects, and your unsent text is kept. No session notifications arrive while the machine is down; if the **Machine offline** kind is on, you get one such notification per outage, once it has been disconnected for over 5 minutes. Foreman's separate "You're offline" screen appears only when the phone itself can't reach the hosted app (no network); it keeps anything you typed and retries automatically.

For QA, https://foreman-dev.hooong-yang.workers.dev (see [Cloud setup](docs/CLOUD_SETUP.md)) installs and notifies the same way as a separate app. Use it only to test a branch; it's torn down and redeployed often.

Known contingency: sign-in uses a Google popup. If the popup ever fails in the installed app, the fallback is redirect sign-in through the Worker (tracked as AND-C in #43, not built).

## Developer workflow

1. Open Foreman and choose **New session**. The dialog has two parts:
   - **Ask the Coordinator**: describe the work, and it is sent to the Coordinator, which starts a Lead for it and picks the setup. The Coordinator chat opens.
   - The manual form: pick Claude or Codex, a model (or provider default), a name, an existing absolute project directory, a permission mode (Native by default), and the first task. Bypass is visibly marked and requires confirmation. See [Session permissions](docs/SESSION_PERMISSIONS.md) for the native provider mappings and their limits.

   The old launcher (a brief turned into a proposed session, `/api/launch/*`) is removed.
2. Open the session conversation. It shows your messages, the agent's prose, approvals and questions, and saved receipts; tool calls, tool results, raw JSON, file paths and subagent or peer messages are hidden. While a turn runs, the header's one status line says in plain words what the agent is doing ("Checking your projects…", "Asking an investigator: …"). Sending an investigator, a subagent, a Lead or a worker stays as one compact line ("Sent an investigator: …", "Started Lead foreman · triage"). For debugging, ⋮ → **Show N steps** lists the hidden steps until you hide them again. Managed sessions are asked to narrate their progress in prose. Follow-up messages queue while it works; saved receipts distinguish queued, running, completed, failed, and uncertain delivery, and failed or uncertain receipts always stay visible.
3. Answer inline tool approvals or supported questions. Permission responses apply once. **Interrupt** also cancels queued follow-ups.
4. Ask a managed session to use Foreman peer tools: `list_sessions`, `session_state`, `session_tail`, `send_message`, `request_update`, and `message_status`. Sender identity is supplied by Foreman. An update is recorded in the target conversation; read it after completion.
5. Use the pinned **Coordinator** to coordinate work. It never touches code: it starts, steers and replaces **Leads** (`start_lead`, `list_leads`, `read_handoff`, `retire_lead`) and answers small read-only questions with **investigators**. Each Lead runs in a registered project on the Coordinator's machine, writes handoffs, and starts its own **workers** for implementation. Leads appear in the chat list with a "Lead" tag; workers stay nested under their Lead (on its info screen) and surface in the list as "`<worker>` · via `<lead>`" while they need you; superseded and ended Leads go under **Archived**. At most 3 Leads run at once, with at most 4 workers each (`FOREMAN_MAX_LEADS`, `FOREMAN_MAX_WORKERS_PER_LEAD`). Choose the Coordinator's Claude model on its info screen while it is idle; the choice is saved with its memory. See [Leads and workers](docs/DESIGN.md#leads-and-workers).
6. Sessions that agents start (Leads and workers) run in **⚠ Bypass** under a standing grant that is on by default, or in **Auto** when the grant is off or can't be read; they are never Native. Change this in **Settings** (⋮ → Settings, or Settings… on the Coordinator's info screen) in the hosted app: the Coordinator, Lead and investigator models and effort, Bypass on or off per role and per project, and **Ask me before each Bypass launch**, which turns each such launch into a **Launch with Bypass** card you approve or deny. The local UI shows Settings read-only. See [Agent launches](docs/SESSION_PERMISSIONS.md#agent-launches), including the local API token caveat.

The responsive inbox groups work needing your attention and shows provider, project, activity, host availability, and control limitations. Observed external sessions have readable available transcripts and no message controls. Trusting Codex hooks enables additional external-session monitoring; managed Codex sessions also report state directly through their controller.

## Persistence and boundaries

State lives under `~/.foreman` (override `FOREMAN_HOME`): managed snapshots/receipts, hook observations, the project registry, this machine's identity, and the private cloud pairing. The Coordinator's memory, the Lead registry, synced handoffs and the developer's settings live in the cloud relay; without one, memory is in `pm/state.json` and there are no settings (see [Portable Coordinator](#portable-coordinator-and-more-machines)). Each Lead's handoffs are also kept on its machine under `leads/`. An exclusive service lock prevents simultaneous writers. Browser refresh restores history. Reusing a managed creation/message ID with identical input returns the existing result; different input is rejected.

After daemon restart, unfinished receipts become uncertain and recovered sessions become read-only. Nothing is automatically replayed or resumed. Start a new session to continue; for a Lead, ask the Coordinator for a successor, which is seeded from the Lead's last handoff. The Coordinator keeps listing restarted Leads that have no successor yet, so it can offer one. The Coordinator keeps no conversation history: its conversation starts empty after a restart, and a message interrupted by the restart is reported once as uncertain, not replayed. Arbitrary takeover of a live terminal/desktop, multiple users, and seeing or starting sessions (including Leads) on a machine that does not run the Coordinator from the hosted app are deferred (#162). Push notifications exist only on the hosted app (see [Install on Android](#install-on-android)), not at `localhost:4177`.

The Coordinator reads only specific existing documents on its own thread: no Bash, Glob, Grep, file writes, code, or `spawn_session`. Its only subagents are read-only investigators (a strict allowlist of `gh` and `git` read commands, no access to Foreman state or credential directories, at most 3 at a time). It reaches its memory only through its memory tools and cannot directly read Foreman configuration. Leads and workers perform implementation work under their launch mode, which cannot change while they run; Foreman adds no sandbox.

## Portable Coordinator and more machines

The Coordinator's memory (projects, preferences, its log and its model) lives in the cloud relay, not on one machine (without a relay, in `~/.foreman/pm/state.json`). Several machines can be paired with the relay. Exactly one of them runs the Coordinator, and the hosted app talks to that machine only. You move it with **Move Coordinator…** on the Coordinator's info screen. Leads run on the Coordinator's machine; Leads left on another machine keep running there and stay visible in the registry, read-only. Sessions, transcripts and project paths stay on the machine that owns them. Coordinator conversations are not kept, and an interrupted message is reported as uncertain, never replayed.

When upgrading to a release that changes the relay (such as the Lead registry and Settings), deploy the Worker first (`npm run cloud:deploy`), then restart the host.

- [Add a second machine](docs/CLOUD_SETUP.md#add-a-second-machine) and [upgrade order](docs/CLOUD_SETUP.md#upgrading-to-portable-coordinator-memory)
- [More than one machine](docs/EXECUTION_HOST.md#more-than-one-machine), [moving the Coordinator](docs/EXECUTION_HOST.md#moving-the-pm), [Leads, settings and routes](docs/EXECUTION_HOST.md#leads-settings-and-routes) and the [Linux host](docs/EXECUTION_HOST.md#linux-host) note
- [PM memory and the PM host](docs/DESIGN.md#pm-memory-and-the-pm-host): the one-time import, uncertain messages, the hung-provider rule, and the `~/.foreman` layout

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
| `server/peer-tools.ts` | Shared Claude MCP, Codex dynamic tools, role-aware session prep (Lead tools and prompt) |
| `server/fleet.ts`, `hooks/` | External-session discovery and hook monitoring |
| `server/main.ts`, `server/host-bridge.ts` | Loopback API and outbound authenticated relay |
| `cloud/worker.ts`, `cloud/auth.ts` | Cloudflare relay and Firebase verification |
| `web/` | Vanilla browser inbox and Google sign-in |
| `server/pm.ts`, `server/tools.ts`, `agents/coordinator-system-prompt.md` | Pinned Coordinator (formerly PM), its tool boundary and investigators, fleet and memory tools |
| `server/lead-tools.ts`, `server/lead-store.ts`, `agents/lead-system-prompt.md` | Lead tools (`start_lead`, `write_handoff`, …), the host Lead store with its outbox, and the Lead prompt |
| `shared/roles.ts` | Roles, limits, agent-launch policy, developer settings, handoff and `lead_rpc` contracts |
| `cloud/leads.ts` | Relay Lead registry, handoffs and developer settings |

[MVP plan](docs/MVP_PLAN.md) · [Readiness and remaining blockers](docs/BLOCKERS.md) · [Original design](docs/DESIGN.md)
