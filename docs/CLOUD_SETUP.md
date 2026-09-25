# Hosted access

The Cloudflare app is deployed at **https://foreman.hooong-yang.workers.dev**. Its Worker serves the browser and verifies Firebase ID tokens; a per-owner Durable Object relays allowlisted JSON API requests to the Mac over an outbound WebSocket. No inbound router port or public local server is required.

## Firebase configuration

Firebase project **foreman-hong-2026** (number `1070263755050`) is active. Google sign-in is enabled, the web app is registered, and the public SDK configuration is deployed. Google Cloud billing is disabled; no paid plan was enabled.

Authorized domains are `foreman-hong-2026.firebaseapp.com`, `foreman-hong-2026.web.app`, `foreman.hooong-yang.workers.dev`, and `foreman-dev.hooong-yang.workers.dev`. The Worker allows verified Google identity `hooong.yang@gmail.com` only.

Open the hosted app and choose **Continue with Google**. The deployed browser flow was checked through the Google Accounts sign-in page with no browser errors. Completing account selection in the user's browser remains the final end-to-end identity check; unauthenticated and malformed-token API requests were verified to fail with 401/403.

To reproduce configuration on this project:

1. Run `npx --yes firebase-tools deploy --only auth --project foreman-hong-2026`. The checked-in `firebase.json` enables Google sign-in and creates the default web app when absent.
2. Retrieve public web configuration with `npx --yes firebase-tools apps:sdkconfig WEB --project foreman-hong-2026 --json` and update `FIREBASE_CONFIG` in `wrangler.jsonc`. This browser API key is public configuration, not an admin credential.
3. Preserve the authorized domains in Firebase Authentication settings, including the hosted Foreman domain.
4. Run `npm run cloud:types`, `npm run cloud:typecheck`, and `npm run cloud:deploy`.

The earlier activation403 was resolved after Firebase Console setup. Firebase terms acceptance is a console-only step for a new account; it cannot be completed with the CLI.

## Deploy and pair the Mac

```sh
npx wrangler login
npm run cloud:deploy
npm run service:restart
```

`cloud:deploy` builds/uploads the Worker and assets, generates or reuses a random host credential, passes it to Wrangler through a temporary mode-0600 secrets file, and saves the pairing to `~/.foreman/cloud.json` with mode 0600. Secrets are not passed in command arguments or committed. Deployment preserves the existing token so the host can reconnect across upgrades. Restarting the daemon loads the pairing; check `~/.foreman/logs/service.stdout.log` for `cloud relay connected`.

The alternate environment configuration requires **both** `FOREMAN_RELAY_URL` (HTTPS origin) and `FOREMAN_HOST_TOKEN`. The launchd installer deliberately does not capture secrets from shell environment; use the pairing file for the installed service.

Run `cloud:deploy` only on a machine that already holds the pairing (`cloud.json`) and `vapid.json` in its `FOREMAN_HOME`. Without `cloud.json` it generates a new host token, which disconnects every paired machine. Without `vapid.json` it generates a new Web Push key, so existing phone subscriptions stop working.

## Add a second machine

Every machine uses the same host token. There are no per-machine tokens. To pair another machine, such as the Linux box `homen`, with the same relay:

1. On the new machine, clone this repository, run `npm install` and `npm run hooks:install`, and sign in to the providers there. Provider logins are per machine; don't copy credential stores.
2. Copy `cloud.json` from a paired machine's `~/.foreman` into the new machine's `~/.foreman` (or its `FOREMAN_HOME`), and make it private: `chmod 600 ~/.foreman/cloud.json`. The daemon accepts only a regular file (not a symlink) owned by the user running it, with mode 0600. Any other file counts as present-but-invalid, and that machine runs no PM until it is fixed.
3. Copy **only** `cloud.json`. `machine.json` must be created fresh on each machine, because two machines with the same `machine_id` replace each other's relay connection. Don't copy `vapid.json` either unless the machine will run `cloud:deploy`.
4. Optionally set `FOREMAN_MACHINE_NAME` in the daemon's environment to name the machine in the PM view (default: the short hostname). On a Mac, set it when you run `npm run service:install`: the installer copies it (and `FOREMAN_PM_HUNG_MS`) into the installed service, and refuses to install if either is invalid. The daemon saves the name to `machine.json`, so to rename later run `npm run service:uninstall`, then `service:install` again with the new name. Installing without it keeps the name already saved.
5. Start the daemon: `npm run service:install` on a Mac, or `npm start` on Linux (see [Linux host](EXECUTION_HOST.md#linux-host)). The log shows `cloud relay connected`.

Never rotate, regenerate or hand-edit the token or `cloud.json`. Every paired machine holds the same token, and the Worker's `HOST_TOKEN` secret must match it. A changed token disconnects every machine that still has the old one.

Instead of `cloud.json`, a daemon can take the pairing from the environment: set **both** `FOREMAN_RELAY_URL` (the `url` from `cloud.json`, an HTTPS origin) and `FOREMAN_HOST_TOKEN` (its `token`). The environment takes precedence over `cloud.json`. Setting only one of them is invalid, and that machine runs no PM. The macOS service installer does not capture these variables, so an installed service needs `cloud.json`.

The new machine connects as a **standby**: the PM stays on the machine that already runs it, and the hosted app keeps talking to that machine only. The new machine appears in the **Move PM…** dialog of the PM view. See [More than one machine](EXECUTION_HOST.md#more-than-one-machine) and [Moving the PM](EXECUTION_HOST.md#moving-the-pm).

## Upgrading to the portable PM

This release moves PM memory into the relay's Durable Object ([details](DESIGN.md#pm-memory-and-the-pm-host)). Deploy the Worker first, then restart the daemons:

1. Update the checkout on each machine to this release. Then run `npm run cloud:deploy` on the paired machine (the one holding `cloud.json` and `vapid.json`).
2. Restart the daemon of the machine whose PM memory you want to keep (`npm run service:restart`). The first upgraded daemon to connect becomes the PM host, and it imports its own `memory/PROJECTS.md`, `memory/LOG.md` and `pm/settings.json` model into the relay once. The import writes `memory/.imported.json` and leaves the source files untouched. First importer wins: a machine that becomes the PM host later imports nothing.
   A machine that ran local-only imports its `pm/state.json` instead of those files when it holds valid memory. Unpairing a machine later does not copy the relay's memory down: the local-only daemon uses its own `pm/state.json` and logs that the relay memory is not merged ([details](DESIGN.md#switching-between-local-only-and-relay-mode)).
3. Start or restart any other machines. They join as standbys.

A daemon that has not been upgraded keeps working against the new Worker until the first upgraded daemon connects. From then on the relay sends everything to the PM host. An upgraded daemon against the old Worker never receives a PM assignment, so it runs no PM (fail closed) until the Worker is deployed.

After the restart the PM conversation starts empty. Earlier PM conversations are not carried over. `pm/history.jsonl`, `pm/session` and `pm/session.quarantine.jsonl` are no longer used and are safe to delete by hand.

## Access and recovery

- Only a valid, unexpired Firebase token from project `foreman-hong-2026`, with verified email `hooong.yang@gmail.com` and Google sign-in provider, can use hosted APIs. Verification checks RSA signatures, issuer, audience, subject, and timestamps.
- The host credential authenticates the outbound relay endpoint only; it is not a browser sign-in token. Static assets and public Firebase configuration reveal no session data.
- The browser polls authoritative state with bearer headers. Tokens are not embedded in URLs. Session mutations are disabled when the host is offline.
- Relay requests have bounded bodies and deadlines. Disconnect/timeout can mean delivery is uncertain; refresh the saved receipt before retrying. Managed creation/message IDs deduplicate retries. The relay never replays a mutation.
- Managed history and receipts live on the machine that runs the session. Daemon restart retains them, marks unfinished work uncertain, and makes recovered sessions read-only. Start a new session to continue; automatic resume/takeover is deferred.
- The pinned PM keeps no conversation history. Its memory lives in the relay's Durable Object. A PM message is recorded before it is sent; if its machine restarts or the PM moves before it finishes, the message is reported once as uncertain and never replayed. See [PM memory and the PM host](DESIGN.md#pm-memory-and-the-pm-host).
- The hosted app talks to one machine at a time: the active PM host. That machine must remain awake, connected, and logged in. A hosted page cannot execute local processes while it is off; move the PM to another online machine instead ([Moving the PM](EXECUTION_HOST.md#moving-the-pm)).

## Verification

`npm run cloud:test` exercises Firebase token rules and actual Durable Object WebSocket routing in the Workers test runtime. `npm test` includes the outbound bridge and local session service. `npm run test:ui` covers browser flows with mock APIs. `npm run probe:mvp -- --live` exercises both installed providers in disposable sessions and consumes provider usage.

References: [Firebase activation requirements](https://firebase.google.com/docs/projects/use-firebase-with-existing-cloud-project), [Firebase token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens), [Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

## Stable development environment

**https://foreman-dev.hooong-yang.workers.dev** is the reusable branch preview. Its browser tab says **[DEV]** and a **DEV · commit · :4178** badge stays visible. The hostname remains stable across deploys, including teardown/recreation. This is one shared dev environment, not one environment per branch.

| | Production | Development |
|---|---|---|
| Worker | `foreman` | `foreman-dev` |
| Durable Object | Production `HostRelay` namespace | Separate `HostRelay` namespace owned by `foreman-dev` |
| Local port | 4177 | 4178 (loopback only) |
| Local state | `~/.foreman` | `~/.foreman-dev` |
| Pairing | `~/.foreman/cloud.json` | `~/.foreman-dev/dev-pairing.json`, independent random credential |
| Daemon | Installed launchd service | Detached process controlled only by `dev:*` scripts |
| Provider logins | Host `~/.claude`, `~/.codex` | The same host logins (default), or `~/.foreman-dev/claude` and `~/.foreman-dev/codex` with `dev:start -- --isolated-logins` |

Both use Firebase project `foreman-hong-2026`, its Google provider, public web configuration, and the same single allowed identity, **hooong.yang@gmail.com**. Both run on this Mac and consume the same Cloudflare and provider accounts/quotas. Dev has separate managed sessions, receipts, PM memory (in the dev Durable Object), local API token, and (for the UX sprint) project registry. By default it shares this Mac's provider configuration, logins and history with production and terminal sessions; with `--isolated-logins` those are separate too. Production's launchd job, pairing and state are never read or modified by the dev commands.

Dev is not a filesystem sandbox. Sessions can work in whichever project directory you select, so choose a disposable worktree for UX testing. The dev daemon uses the selected branch's application code, including its normal PM and provider behavior; Native/Bypass still mean the same thing. No production sessions or project registrations are imported. With the default host logins, dev reads the host's Claude session registry (`~/.claude/sessions`) and background agents, so the dev fleet also lists terminal sessions and production-managed sessions running on this Mac, as production's fleet does, and the dev PM's `stop_session` tool can stop host background sessions. The reverse also holds: production's fleet lists sessions the dev daemon launched, and production's PM can stop dev background sessions. With `--isolated-logins` the dev registry is separate and those sessions are not shown.

### Deploy a branch or worktree

Run these commands from a checkout containing this workflow. Until this PR merges, use `/private/tmp/foreman-dev-environment` on `feat/dev-environment`; the UX branch itself does not need these scripts.

```sh
cd /private/tmp/foreman-dev-environment
npm run dev:stop
npm run dev:deploy -- --source /private/tmp/foreman-ux-integration
npm run dev:start
npm run dev:status
```

That deploys the committed `HEAD` of `/private/tmp/foreman-ux-integration` (`epic/1-ux-polish`) without changing its branch or working files. Alternatively choose any local branch/ref explicitly:

```sh
npm run dev:stop
npm run dev:deploy -- --source /Users/hong/code/foreman --ref epic/1-ux-polish
npm run dev:start
```

Without arguments, `dev:deploy` selects the workflow checkout's `HEAD`. The source must be a local Git checkout with installed `node_modules` and a `package-lock.json` identical to the selected commit. Use `npm ci` in the source checkout when needed. Tracked changes must be committed for a `HEAD` preview; untracked files are excluded. A named `--ref` intentionally previews that commit, ignoring working changes. Commits containing symlinks are refused.

Deployment creates a source snapshot beneath `~/.foreman-dev/release-*`, links the source checkout's installed dependencies, adds the DEV badge to the snapshot only, and uploads its Worker and web assets using a generated dev-only config. Failed deploys remove the new snapshot and retain the prior deployment record. Successful deploys prune superseded release directories. Public Firebase configuration is parsed as JSONC from the selected snapshot. Starting the daemon uses that exact snapshot. The lockfile check is only a precondition: it says what should be installed, not what is. Deploy therefore also records in `deployment.json` the resolved real path of the linked `node_modules` and a SHA-256 identity of the installed tree (every relative path and entry type, file contents and executable bit, symlink targets as text without following them; FIFOs, sockets and devices count by type only). `dev:start` re-resolves the snapshot's `node_modules` link and recomputes that identity before it checks the relay or spawns anything (under a second for a ~580 MB tree with a warm file cache). If the link points elsewhere, or any file was edited, added or removed, it refuses: reinstall the dependencies that match the lockfile in the source checkout and run `npm run dev:deploy` again. It also refuses, with the same instruction, when it cannot read the tree: an unreadable file or directory, a `node_modules` that is now a regular file, or an entry removed while it was being hashed. That message names the error code and the path. Caches count too. The identity covers everything under `node_modules`, including `node_modules/.cache`. A tool that writes a cache there in the source checkout (a bundler, a test runner, a linter) changes the identity. The next `dev:start` then refuses even though no package changed. Run `npm run dev:deploy` again after such a tool has run, or configure it to keep its cache outside `node_modules` while a preview is deployed. A preview deployed before this check existed has no dependency record and must be redeployed. Keep the source checkout and its dependencies available and unchanged while the dev daemon runs; the check runs at start only, so a change made after the daemon starts is not detected until the next start. No package install scripts run during deploy. The generated config supports exactly the current contract: Durable Object binding `RELAY` → `HostRelay`, migration `v1` with `new_sqlite_classes: ["HostRelay"]`, and assets binding `ASSETS`. Deploy reads the selected snapshot's own `wrangler.jsonc` and refuses, before uploading anything or creating a pairing credential, if it diverges: an extra, missing, renamed or duplicated Durable Object binding, a different class, an external (`script_name`) binding, an extra or different migration (for example a `v2` tag, or `new_classes` instead of `new_sqlite_classes`), a renamed assets binding, or any other binding kind (KV, R2, D1, services, queues, workflows and so on). Vars and required secrets are checked the same way. The dev config defines exactly the vars `FIREBASE_PROJECT_ID` and `ALLOWED_EMAIL`, fixed to the owner's values (`foreman-hong-2026` and `hooong.yang@gmail.com`), and `FIREBASE_CONFIG`, taken from the snapshot. It requires exactly the secret `HOST_TOKEN`. Deploy refuses a snapshot that has any of these problems:

- a `vars` entry other than those three
- a `FIREBASE_PROJECT_ID` or `ALLOWED_EMAIL` with a different value
- a missing or non-string `FIREBASE_CONFIG`
- a `secrets.required` entry other than `HOST_TOKEN`
- a malformed `vars`, `secrets` or `secrets.required`, or an extra key under `secrets`

A snapshot may leave out the fixed vars or `HOST_TOKEN`, because dev supplies them. The message names each divergence. The previous deployment stays in place. To preview such a branch, first extend `scripts/dev-environment.mjs`: add bindings and migrations to `SUPPORTED_WORKER_CONTRACT`, vars to `SUPPORTED_DEV_VARS`, and required secrets to `SUPPORTED_DEV_SECRETS`, and update `workerConfig` to emit them. The dev config ignores the snapshot's name, account, routes, build and environments (`env.<name>` sections, including bindings declared only there) and sets those itself.

Only `foreman-dev`, its fixed Cloudflare account, hostname, home and port are accepted. Dev scripts refuse `FOREMAN_*`, account/environment/config overrides, extra target flags, unsafe state files, a busy port, or an unrelated process in the saved PID. A running dev daemon must be stopped before redeploy. Start also refuses a mismatched Worker commit or an already-connected dev host. Mutating commands are locked by PID and process start identity; dead or reused owners are recovered automatically. `dev:status` remains available while an operation holds the lock. A legacy lock without an owner record requires checking that no dev command remains, then removing only `~/.foreman-dev/operation.lock`. A reused daemon PID is reported with the exact stale record to remove; it is never signalled.

`cloud:deploy`, `cloud:dev` (Wrangler's local emulator), and `service:*` retain their existing production behavior. Do not use them for this preview. The dev scripts do not call them.

### Start, use, and stop

`dev:start` passes `FOREMAN_HOME=~/.foreman-dev`, `FOREMAN_PORT=4178`, `FOREMAN_RELAY_URL=https://foreman-dev.hooong-yang.workers.dev`, and the dev `FOREMAN_HOST_TOKEN` to a detached daemon. The token stays out of command arguments and logs. Pairing and credential files have mode 0600 inside a mode-0700 directory. The daemon remains running after the shell exits; it does not automatically start after logout/reboot or restart after a crash.

**By default DEV uses this Mac's normal provider logins.** `dev:start` leaves `CLAUDE_CONFIG_DIR` and `CODEX_HOME` unset for the dev daemon, so it signs in exactly as a `claude` or `codex` started in a terminal does (`~/.claude` and the default Keychain entry, `~/.codex`). No second OAuth login is needed. On macOS the Claude CLI keys its Keychain login by config directory, which is why a separate config directory needs its own login. Using the same directory is the same installation, not a copy, so it cannot invalidate production's refresh token. `npm run dev:status` reports `"logins": "host"` or `"isolated"` for a running daemon.

**The Claude login is required; the Codex login is optional.** Before spawning anything, `dev:start` runs `claude auth status --json` (the SDK binary for your platform/architecture, with no config override). If this Mac has no normal Claude login, it refuses and prints the recovery command: `claude auth login`, then `npm run dev:start`. Startup also checks the host Codex login (`codex login status` with the default `CODEX_HOME`). If it is missing, or the `codex` CLI is not installed, DEV starts anyway and prints one notice line: Codex sessions are unavailable in DEV. The dev daemon then reports Codex as unavailable: the Codex model catalog returns an error, the launcher never proposes Codex, and a Codex session fails at launch with "Codex is not signed in on this host". If the notice says the Codex CLI is not installed, install it first. To enable Codex in DEV, run `codex login`, then restart dev (`npm run dev:stop && npm run dev:start`). Setting `OPENAI_API_KEY` in the environment alone does not sign Codex in: `codex login status` still reports "Not logged in", and DEV treats Codex as unavailable. Inherited `CODEX_HOME` and `CLAUDE_CONFIG_DIR` overrides are refused.

Sessions the dev daemon launches still report to the dev daemon, not production. The daemon passes `FOREMAN_HOME=~/.foreman-dev` to Claude, and Claude passes it to the Foreman hook (`hooks/foreman-hook`), which records under `${FOREMAN_HOME:-~/.foreman}`. The Codex hook command installed in `~/.codex/hooks.json` pins `FOREMAN_HOME` to production's home, so the daemon also passes `FOREMAN_HOOK_HOME=~/.foreman-dev`, which `hooks/codex-hook.mjs` prefers. That hook file runs from the checkout that installed the Codex hooks, so dev Codex sessions route correctly only once that checkout includes this change. Until then their hook records land in production's session list.

**Isolated logins (opt-in).** `npm run dev:start -- --isolated-logins` restores the separate provider homes: the daemon runs with `CLAUDE_CONFIG_DIR=~/.foreman-dev/claude` and `CODEX_HOME=~/.foreman-dev/codex`, which need their own logins. Run `CLAUDE_CONFIG_DIR="$HOME/.foreman-dev/claude" /path/to/source/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude auth login` and, optionally, `CODEX_HOME="$HOME/.foreman-dev/codex" codex login` (or, for an API key, `printenv OPENAI_API_KEY | CODEX_HOME="$HOME/.foreman-dev/codex" codex login --with-api-key`). Then start with the flag. The flag applies to that start only: a later `npm run dev:start` without it uses the host logins again. In this mode the recovery messages name the isolated directories and the flag.

The workflow never copies either provider's OAuth credential. Copying a rotating refresh token creates competing copies: refreshing dev can invalidate production even without writing a production file. An explicit `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` can supply Claude authentication instead, in either mode. Provider accounts and real usage are shared. Existing previews created by the former credential-copy workflow must stop dev, remove only the copied `~/.foreman-dev/codex/auth.json`, and start dev again. A local login-status check verifies credential presence, not its provenance or server-side validity. The local health check and model catalog do not prove inference authentication; send the PM a short test message and verify an actual answer.

Open the dev URL, choose **Continue with Google**, and select **hooong.yang@gmail.com**. Confirm the DEV badge, wait for the Mac to show online, and use the app normally. For the UX sprint, register a disposable project worktree in Settings before creating a session. Keep this Mac awake and connected. Google sign-in is for the hosted URL; `http://127.0.0.1:4178` uses the separate local token at `~/.foreman-dev/local-api-token`.

```sh
npm run dev:status  # PID, logins, commit, URL, home, port, authenticated relay status
npm run dev:stop    # gracefully stops only the recorded dev daemon
npm run dev:start   # resumes the deployed snapshot with host logins; preserves dev history
npm run dev:start -- --isolated-logins  # the same, with dev's own provider logins
```

Logs are in `~/.foreman-dev/daemon.log`, replaced at each start. A successful start requires both a health response from the new PID and an online relay. Status queries a dev-only credential-protected endpoint without replacing its WebSocket. Normal browser APIs still require the allowed Google identity. `dev:stop` checks the process start time and command identity before signalling and refuses to kill a reused PID. `dev:start` records a startup intent before spawning the daemon and its PID after; if recording the PID fails, start stops the child it spawned and confirms it exited before reporting the error. If a start is interrupted before its PID is recorded, `dev:status` reports the leftover daemon and `dev:start` refuses; run `npm run dev:stop`, which finds that daemon only by its unique `~/.foreman-dev/run.mjs <id>` command line owned by your user, stops it, and discards the record. A startup record with no matching process is discarded by the next `dev:start` or `dev:stop`. A failed deploy retains its credential for recovery; a failed teardown retains local state.

### Smoke test (opt-in, real)

```sh
FOREMAN_DEV_SMOKE=1 node tests/live/dev-smoke.live.mjs
FOREMAN_DEV_SMOKE=1 FOREMAN_DEV_SMOKE_KEEP=1 node tests/live/dev-smoke.live.mjs  # leave dev running afterwards
```

Run it from a clean checkout with installed `node_modules`. It deploys that checkout's `HEAD` to `foreman-dev` for real. First it refuses unless the target in `scripts/dev-environment.mjs`, and the name in the config deploy would generate, is `foreman-dev` and not the production Worker. It stops a running dev daemon (deploy requires that), then runs `dev:deploy`. `dev:status` must then report that commit from the dev origin's `/api/dev/status`, and the dev page's DEV badge must show it. It runs `dev:start` with the host's normal logins, and checks that local `/api/health` answers from the recorded PID and that the dev relay shows the host online. It checks the PWA headers on the dev origin: `/manifest.webmanifest` has exactly one `Content-Type: application/manifest+json`, `/sw.js` has `Cache-Control: no-cache`, and `/offline.html` redirects to `/offline`, which returns 200 HTML. Last it runs `dev:stop` and waits for the relay to show the host offline. If the test fails after `dev:start` and before a successful `dev:stop`, it still runs `dev:stop` on the way out, unless `FOREMAN_DEV_SMOKE_KEEP=1` is set. It prints an evidence log of each command's exit code, the commit and the statuses. Without `FOREMAN_DEV_SMOKE=1` it is skipped, and `npm test` never picks it up. It never runs `dev:destroy`, which would delete the Worker and dev history. Destroy is covered by the mocked `destroy` tests in `tests/dev-lifecycle.test.mjs` and the `deleteDevWorker` tests in `tests/dev-environment.test.mjs`.

### Firebase setup (once per hostname)

The dev hostname **foreman-dev.hooong-yang.workers.dev** has been added to Firebase Authentication authorized domains, preserving all three original domains. The existing configuration procedure above still applies: `npx --yes firebase-tools deploy --only auth --project foreman-hong-2026` enables Google, and `apps:sdkconfig` retrieves its public config. Neither command adds arbitrary authorized domains.

To reproduce the domain step manually, open [Firebase Authentication settings](https://console.firebase.google.com/project/foreman-hong-2026/authentication/settings), choose **Authorized domains → Add domain**, and enter `foreman-dev.hooong-yang.workers.dev` (no scheme or path). Preserve production's domain and both Firebase defaults. This setup was applied and read back using the Firebase CLI's signed-in account and Identity Toolkit `projects.updateConfig` with `updateMask=authorizedDomains`, appending to the existing list. The console is the supported interactive alternative; don't put admin credentials in this repository. Firebase terms acceptance, if ever required for a new account, remains console-only. No additional paid plan or identity allowlist is needed.

### Tear down

```sh
npm run dev:destroy
```

This gracefully stops dev, deletes only `foreman-dev` and its Durable Object namespace through Cloudflare's API with `force=false` (refusing dependency-breaking deletion), then removes its local home, snapshots, pairing, isolated provider directories (if `--isolated-logins` was ever used) and session history. An isolated Claude login's macOS Keychain entry, keyed by that directory, is not removed; delete it in Keychain Access if you no longer need it. It removes only the verified `~/.foreman-dev` home, never the host's `~/.claude` or `~/.codex`, and a link inside the dev home is removed without following it. It uses the current Wrangler login, or Cloudflare API credentials from the environment. Cloudflare deletion must succeed before local cleanup. This permanently discards dev history; use `dev:stop` to preserve it. Firebase's authorized domain stays configured so recreation uses the same link without another console change. Shared provider accounts, repositories and production are untouched.

References: [Cloudflare namespace isolation](https://developers.cloudflare.com/durable-objects/reference/environments/), [Worker deletion API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/delete/), [Firebase Google sign-in](https://firebase.google.com/docs/auth/web/google-signin).
