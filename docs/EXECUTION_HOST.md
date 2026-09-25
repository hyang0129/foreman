# Execution host

Foreman runs the session processes on an execution host. A hosted Cloudflare UI and relay cannot read this Mac's files or run its local CLI sessions without that host being reachable. The initial execution host is this Mac, under the existing user account and provider logins.

## macOS service

`scripts/service.mjs` provides a user LaunchAgent with startup at login, automatic restart, a ten-second restart throttle, and separate stdout/stderr logs. It uses the current Node executable and an explicit CLI search path, so an interactive shell is unnecessary. The server remains bound to `127.0.0.1`.

```sh
# Read-only; safe while another Foreman instance is running.
node scripts/service.mjs status
node scripts/service.mjs plist

# After stopping the existing foreground Foreman instance:
node scripts/service.mjs install
node scripts/service.mjs status

# Restart interrupts the running Foreman process, managed sessions, and active PM work.
node scripts/service.mjs restart

# Removes only this checkout's service; keeps session state and logs.
node scripts/service.mjs uninstall
```

Installation starts the service. It refuses an occupied server port without stopping its owner, and refuses to modify a plist from another checkout or a foreign job. Do not run a second `npm start` alongside the installed service. After moving the checkout, uninstall using the original checkout before installing from the new location. After changing the Node installation path, reinstall the service.

Configuration comes from `FOREMAN_HOME`, `FOREMAN_PORT`, `FOREMAN_CLAUDE_BIN`, `FOREMAN_CODEX_BIN`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `FOREMAN_WARP_SPAWN` at install time. Executable/config paths must be absolute. The installer deliberately excludes tokens, API keys, and the rest of the shell environment. Existing user provider credentials remain in their normal local stores. Changing installed settings requires uninstalling and reinstalling.

The plist is `~/Library/LaunchAgents/com.foreman.daemon.plist`. Logs are `<FOREMAN_HOME>/logs/service.stdout.log` and `service.stderr.log` (default `~/.foreman/logs/`). Logs are retained on uninstall and currently require manual rotation. Status reports only selected launchd fields so it does not expose launchd's environment dump.

## Sleep, logout, and power

A user LaunchAgent requires the user to be logged in. It restarts a failed process but does not keep a sleeping or powered-off computer online. Reboot requires logging in again, including FileVault unlock where applicable. This follows Apple's [LaunchAgent lifecycle](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) and [LaunchAgents location guidance](https://support.apple.com/guide/terminal/apdc6c1077b-5d5d-4d35-9c19-60f2397b2369/mac).

For an explicit AC-power keep-awake option:

```sh
node scripts/service.mjs install --keep-awake
```

This wraps the process in `/usr/bin/caffeinate -s`; the assertion lasts only while the service runs and applies only on AC power (see the local `man caffeinate`). It changes no permanent power settings and allows display sleep. It does not guarantee operation with the lid closed, during explicit sleep, logout, battery operation, network loss, or shutdown. Leave the lid open and the power connected for the local-host option. Removing the service removes its assertion.

On September 13, 2026, the idle manual server was verified and handed off to this LaunchAgent. The service is installed with AC-only keep-awake enabled; startup and restart both passed the `/api/health` check. No user working session was interrupted. The underlying one-minute sleep configuration remains unchanged. The service records the newer installed VS Code Codex binary in `FOREMAN_CODEX_BIN` because the shell CLI rejects the configured model; reinstall with a supported executable if that extension path changes.

## Always-on execution path

For work that continues when the laptop is off, use a dedicated powered Mac with this checkout, repositories, provider CLIs and separately authenticated provider accounts; install the same LaunchAgent under its logged-in user. This is the lowest-change path for the current macOS-oriented app. A Linux machine also works as a host, but without the service (see [Linux host](#linux-host)); it needs repository access and fresh provider authentication.

An always-on host runs sessions started on that host. It cannot keep the laptop's existing processes alive; a handoff needs synchronized repository changes, required files, and a resumable provider session or a new session with supplied context. Do not blindly copy account credential stores between hosts.

The authenticated outbound Cloudflare relay, host identity, heartbeat/offline state, and reconnect handling are implemented and paired on this Mac. The daemon loads its private pairing from `~/.foreman/cloud.json`; the service installer itself does not provision cloud resources. Hosted Firebase Google login is configured; see [Cloud setup](CLOUD_SETUP.md). Keep the local HTTP server bound to loopback. Managed histories/receipts survive daemon restart, but recovered sessions are read-only and unfinished delivery is marked uncertain without replay.

## More than one machine

Several machines can be paired with the same relay at once, for example this Mac and the Linux box `homen`. Each `FOREMAN_HOME` is one machine, identified by `<FOREMAN_HOME>/machine.json` (a random `machine_id` and a display name, created on first start). The display name defaults to the short hostname. Set `FOREMAN_MACHINE_NAME` to choose another name (1–80 printable characters); it is saved to `machine.json`, so later starts keep it. An invalid value means no PM on that machine until it is fixed.

To pair another machine, copy `cloud.json` to it; see [Add a second machine](CLOUD_SETUP.md#add-a-second-machine). Never copy `machine.json` or a whole `~/.foreman`: two daemons with the same `machine_id` count as one machine and replace each other's relay connection.

- **One PM at a time.** The relay records one active PM host. The first machine that connects with this version becomes the PM host, and it stays the PM host until you move it. Every other connected machine is a standby.
- **The hosted app talks to the PM host only.** Sessions, projects, launches and the PM are all relayed to that one machine. A standby receives nothing through the relay. The hosted app shows standbys only in the Move PM dialog. A standby's own sessions are still available from its local UI (`http://localhost:4177`).
- **PM memory is shared; everything else is per machine.** The PM's memory (projects, preferences, log, model) lives in the relay, so it is the same on every machine. Worker sessions, their transcripts and receipts, worktrees, and the project registry (`projects.json`, with its paths) stay on the machine that owns them. Register a project under the same name on each machine where the PM should find it: PM memory refers to projects by name, and each machine resolves the name to its own path.
- **A machine that is not the PM host runs no PM.** Its local UI refuses PM messages with "The PM runs on <name>.". A PM host that loses the relay also refuses PM messages ("The cloud relay is unreachable; the PM is unavailable on this machine.") until it reconnects, because it cannot confirm it is still the PM host.

See [PM memory and the PM host](DESIGN.md#pm-memory-and-the-pm-host) for the full model.

## Moving the PM

Moving the PM is always a developer action; there is no automatic failover.

1. Open the hosted app and the PM view. The header shows "PM on <name> · online" (or offline).
2. Choose **Move PM…**. It appears only when another machine is online.
3. Pick an online machine and confirm.

The move needs an online target. The current PM host may be offline, which is how you recover from losing a machine. If the PM host changed since the page loaded, the move is refused (409); the dialog reloads the machine list.

After the move:

- The new PM host starts with an empty conversation and a fresh provider session built from the shared memory. Past conversations are not kept anywhere.
- A message that was still in progress on the old machine appears once on the new one as an uncertain entry: "…could not be confirmed (the PM was moved)", or "(machine went offline)" if the old machine was offline. It is never replayed. Send it again if you still need it.
- The old machine stops its PM and refuses PM messages from its local UI ("The PM runs on <name>."). If it was online during the move, its PM view also shows "The PM now runs on <name>.". When a lost machine comes back, it is a standby; it never takes the PM back.

In relay mode the PM can be moved only from the hosted app. The local UI at `localhost` cannot see the other machines. A machine without `cloud.json` (local-only mode) is always its own PM host and has nothing to move to.

Restarting the PM host's daemon keeps the PM there. A message in progress during the restart is reported once as uncertain ("Foreman restarted") and not replayed. A brief network drop is not reported: a turn that finishes across it completes normally.

## Linux host

A Linux machine runs the daemon in the foreground with `npm start` (after `npm install`, `npm run hooks:install` and the provider logins). Service management (`npm run service:*`, `scripts/service.mjs`) is macOS-only and refuses to run elsewhere, so keep `npm start` running yourself and restart it by hand.

## Validation

`node --test tests/service.test.mjs` verifies native plist parsing/escaping on macOS, exact argument preservation, excluded credentials, ownership refusal, opt-in sleep assertions, invalid input handling, and occupied-port protection. This validates service configuration without starting a provider session. Controlled handoff, service startup, and process restart were verified on this Mac. Login/reboot-cycle behavior has not been exercised.
