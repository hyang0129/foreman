# Hosted access

The Cloudflare app is deployed at **https://foreman.hooong-yang.workers.dev**. Its Worker serves the browser and verifies Firebase ID tokens; a per-owner Durable Object relays allowlisted JSON API requests to the Mac over an outbound WebSocket. No inbound router port or public local server is required.

## Current Firebase activation blocker

Google Cloud project **foreman-hong-2026** (number `1070263755050`) was created under `hooong.yang@gmail.com`. The account has all four documented permissions for adding Firebase, and the Firebase Management API is enabled. Adding Firebase still returns `403 PERMISSION_DENIED`. Google documents missing Firebase terms acceptance as another cause of this error.

Open [Firebase Console](https://console.firebase.google.com/) as that account, accept any Firebase terms prompt, and add Firebase to the **existing** Google Cloud project. CLI login alone does not complete Firebase activation.

After activation:

1. Run `npx --yes firebase-tools deploy --only auth --project foreman-hong-2026`. The checked-in `firebase.json` enables Google sign-in and creates the default web app when absent.
2. Run `npx --yes firebase-tools apps:sdkconfig WEB --project foreman-hong-2026 --json`. Copy the result's public `sdkConfig` object into `wrangler.jsonc`'s `FIREBASE_CONFIG` string. The public web API key is configuration, not an admin credential.
3. In Firebase Authentication → Settings → Authorized domains, append `foreman.hooong-yang.workers.dev` while preserving existing Firebase domains.
4. Run `npm run cloud:types`, `npm run cloud:typecheck`, and `npm run cloud:deploy`. Sign in with the allowed Google account to verify the complete deployed journey.

Until these steps complete, the deployed page explains that sign-in is unconfigured and session APIs remain inaccessible. There is no auth bypass. The local app at http://localhost:4177 is usable.

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
