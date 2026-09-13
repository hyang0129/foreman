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

For work that continues when the laptop is off, use a dedicated powered Mac with this checkout, repositories, provider CLIs and separately authenticated provider accounts; install the same LaunchAgent under its logged-in user. This is the lowest-change path for the current macOS-oriented app. A Linux VM is another option after replacing Mac-specific terminal launching and providing a systemd unit; it also needs repository access and fresh provider authentication.

An always-on host runs sessions started on that host. It cannot keep the laptop's existing processes alive; a handoff needs synchronized repository changes, required files, and a resumable provider session or a new session with supplied context. Do not blindly copy account credential stores between hosts.

The authenticated outbound Cloudflare relay, host identity, heartbeat/offline state, and reconnect handling are implemented and paired on this Mac. The daemon loads its private pairing from `~/.foreman/cloud.json`; the service installer itself does not provision cloud resources. Hosted Firebase Google login is configured; see [Cloud setup](CLOUD_SETUP.md). Keep the local HTTP server bound to loopback. Managed histories/receipts survive daemon restart, but recovered sessions are read-only and unfinished delivery is marked uncertain without replay.

## Validation

`node --test tests/service.test.mjs` verifies native plist parsing/escaping on macOS, exact argument preservation, excluded credentials, ownership refusal, opt-in sleep assertions, invalid input handling, and occupied-port protection. This validates service configuration without starting a provider session. Controlled handoff, service startup, and process restart were verified on this Mac. Login/reboot-cycle behavior has not been exercised.
