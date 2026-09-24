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

## Access and recovery

- Only a valid, unexpired Firebase token from project `foreman-hong-2026`, with verified email `hooong.yang@gmail.com` and Google sign-in provider, can use hosted APIs. Verification checks RSA signatures, issuer, audience, subject, and timestamps.
- The host credential authenticates the outbound relay endpoint only; it is not a browser sign-in token. Static assets and public Firebase configuration reveal no session data.
- The browser polls authoritative state with bearer headers. Tokens are not embedded in URLs. Session mutations are disabled when the host is offline.
- Relay requests have bounded bodies and deadlines. Disconnect/timeout can mean delivery is uncertain; refresh the saved receipt before retrying. Managed creation/message IDs deduplicate retries. The relay never replays a mutation.
- Managed history and receipts live on the Mac. Daemon restart retains them, marks unfinished work uncertain, and makes recovered sessions read-only. Start a new session to continue; automatic resume/takeover is deferred.
- The pinned PM has separate legacy history and does not have managed sessions' durable retry guarantees.
- The Mac must remain awake, connected, and logged in. A hosted page cannot execute local processes while the Mac is off.

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

Both use Firebase project `foreman-hong-2026`, its Google provider, public web configuration, and the same single allowed identity, **hooong.yang@gmail.com**. Both run on this Mac and consume the same Cloudflare and provider accounts/quotas. Dev has separate managed sessions, receipts, PM history, memory, local API token, provider configuration/history, and (for the UX sprint) project registry. Production's launchd job, pairing and state are never read or modified by the dev commands.

Dev is not a filesystem sandbox. Sessions can work in whichever project directory you select, so choose a disposable worktree for UX testing. The dev daemon uses the selected branch's application code, including its normal PM and provider behavior; Native/Bypass still mean the same thing. No production sessions or project registrations are imported. Existing terminal sessions in production's provider registry are not shown in the isolated dev registry.

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

Deployment creates a source snapshot beneath `~/.foreman-dev/release-*`, links the source checkout's installed dependencies, adds the DEV badge to the snapshot only, and uploads its Worker and web assets using a generated dev-only config. Failed deploys remove the new snapshot and retain the prior deployment record. Successful deploys prune superseded release directories. Public Firebase configuration is parsed as JSONC from the selected snapshot. Starting the daemon uses that exact snapshot. The lockfile check is only a precondition: it says what should be installed, not what is. Deploy therefore also records in `deployment.json` the resolved real path of the linked `node_modules` and a SHA-256 identity of the installed tree (every relative path and entry type, file contents and executable bit, symlink targets as text without following them; FIFOs, sockets and devices count by type only). `dev:start` re-resolves the snapshot's `node_modules` link and recomputes that identity before it checks the relay or spawns anything (under a second for a ~580 MB tree with a warm file cache). If the link points elsewhere, or any file was edited, added or removed, it refuses: reinstall the dependencies that match the lockfile in the source checkout and run `npm run dev:deploy` again. A preview deployed before this check existed has no dependency record and must be redeployed. Keep the source checkout and its dependencies available and unchanged while the dev daemon runs; the check runs at start only, so a change made after the daemon starts is not detected until the next start. No package install scripts run during deploy. The config supports the current `HostRelay`/`RELAY`/`ASSETS` contract; a future branch that changes bindings or migrations needs an explicit update to the dev workflow.

Only `foreman-dev`, its fixed Cloudflare account, hostname, home and port are accepted. Dev scripts refuse `FOREMAN_*`, account/environment/config overrides, extra target flags, unsafe state files, a busy port, or an unrelated process in the saved PID. A running dev daemon must be stopped before redeploy. Start also refuses a mismatched Worker commit or an already-connected dev host. Mutating commands are locked by PID and process start identity; dead or reused owners are recovered automatically. `dev:status` remains available while an operation holds the lock. A legacy lock without an owner record requires checking that no dev command remains, then removing only `~/.foreman-dev/operation.lock`. A reused daemon PID is reported with the exact stale record to remove; it is never signalled.

`cloud:deploy`, `cloud:dev` (Wrangler's local emulator), and `service:*` retain their existing production behavior. Do not use them for this preview. The dev scripts do not call them.

### Start, use, and stop

`dev:start` passes `FOREMAN_HOME=~/.foreman-dev`, `FOREMAN_PORT=4178`, `FOREMAN_RELAY_URL=https://foreman-dev.hooong-yang.workers.dev`, and the dev `FOREMAN_HOST_TOKEN` to a detached daemon. The token stays out of command arguments and logs. Pairing and credential files have mode 0600 inside a mode-0700 directory. The daemon remains running after the shell exits; it does not automatically start after logout/reboot or restart after a crash.

**Both providers require independent dev logins.** Run `CODEX_HOME="$HOME/.foreman-dev/codex" codex login` and `CLAUDE_CONFIG_DIR="$HOME/.foreman-dev/claude" /path/to/source/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude auth login` on this Mac, then `npm run dev:start`. Use the Claude SDK binary for your platform/architecture. Startup checks both isolated logins and prints the appropriate recovery command if one is missing. Inherited `CODEX_HOME` and `CLAUDE_CONFIG_DIR` overrides are refused.

The workflow never copies either provider's production OAuth credential. Copying a rotating refresh token creates competing copies: refreshing dev can invalidate production even without writing a production file. An explicit `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` can supply Claude authentication instead. Provider accounts and real usage are shared, but dev login storage and session history are separate. Existing previews created by the former credential-copy workflow must stop dev, remove only the copied `~/.foreman-dev/codex/auth.json`, perform both independent logins, and start dev again. A local login-status check verifies credential presence, not its provenance or server-side validity. The local health check and model catalog do not prove inference authentication; send the PM a short test message and verify an actual answer.

Open the dev URL, choose **Continue with Google**, and select **hooong.yang@gmail.com**. Confirm the DEV badge, wait for the Mac to show online, and use the app normally. For the UX sprint, register a disposable project worktree in Settings before creating a session. Keep this Mac awake and connected. Google sign-in is for the hosted URL; `http://127.0.0.1:4178` uses the separate local token at `~/.foreman-dev/local-api-token`.

```sh
npm run dev:status  # PID, commit, URL, home, port, authenticated relay status
npm run dev:stop    # gracefully stops only the recorded dev daemon
npm run dev:start   # resumes the deployed snapshot; preserves dev history
```

Logs are in `~/.foreman-dev/daemon.log`, replaced at each start. A successful start requires both a health response from the new PID and an online relay. Status queries a dev-only credential-protected endpoint without replacing its WebSocket. Normal browser APIs still require the allowed Google identity. `dev:stop` checks the process start time and command identity before signalling and refuses to kill a reused PID. `dev:start` records a startup intent before spawning the daemon and its PID after; if recording the PID fails, start stops the child it spawned and confirms it exited before reporting the error. If a start is interrupted before its PID is recorded, `dev:status` reports the leftover daemon and `dev:start` refuses; run `npm run dev:stop`, which finds that daemon only by its unique `~/.foreman-dev/run.mjs <id>` command line owned by your user, stops it, and discards the record. A startup record with no matching process is discarded by the next `dev:start` or `dev:stop`. A failed deploy retains its credential for recovery; a failed teardown retains local state.

### Firebase setup (once per hostname)

The dev hostname **foreman-dev.hooong-yang.workers.dev** has been added to Firebase Authentication authorized domains, preserving all three original domains. The existing configuration procedure above still applies: `npx --yes firebase-tools deploy --only auth --project foreman-hong-2026` enables Google, and `apps:sdkconfig` retrieves its public config. Neither command adds arbitrary authorized domains.

To reproduce the domain step manually, open [Firebase Authentication settings](https://console.firebase.google.com/project/foreman-hong-2026/authentication/settings), choose **Authorized domains → Add domain**, and enter `foreman-dev.hooong-yang.workers.dev` (no scheme or path). Preserve production's domain and both Firebase defaults. This setup was applied and read back using the Firebase CLI's signed-in account and Identity Toolkit `projects.updateConfig` with `updateMask=authorizedDomains`, appending to the existing list. The console is the supported interactive alternative; don't put admin credentials in this repository. Firebase terms acceptance, if ever required for a new account, remains console-only. No additional paid plan or identity allowlist is needed.

### Tear down

```sh
npm run dev:destroy
```

This gracefully stops dev, deletes only `foreman-dev` and its Durable Object namespace through Cloudflare's API with `force=false` (refusing dependency-breaking deletion), then removes its local home, snapshots, pairing, independent provider credentials and session history. It uses the current Wrangler login, or Cloudflare API credentials from the environment. Cloudflare deletion must succeed before local cleanup. This permanently discards dev history; use `dev:stop` to preserve it. Firebase's authorized domain stays configured so recreation uses the same link without another console change. Shared provider accounts, repositories and production are untouched.

References: [Cloudflare namespace isolation](https://developers.cloudflare.com/durable-objects/reference/environments/), [Worker deletion API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/delete/), [Firebase Google sign-in](https://firebase.google.com/docs/auth/web/google-signin).
