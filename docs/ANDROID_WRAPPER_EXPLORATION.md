# Android wrapper exploration

Status: recommendation and implementation plan, not an Android build. Reviewed 2026-09-13.

## Recommendation

Make Foreman installable as a Progressive Web App (PWA), then use Bubblewrap to package the same hosted origin as an Android Trusted Web Activity (TWA). For personal use, the installed PWA is the smallest first milestone; a signed TWA APK supplies a conventional Android package when wanted. This is a recommendation based on the current architecture, subject to a real Android sign-in test.

A TWA displays the hosted site using a supporting browser, with the browser toolbar hidden after website/app ownership verification. Web UI changes arrive through normal Cloudflare deployments when the page loads again. Native package metadata and native dependency changes still need a new Android release. [Chrome overview](https://developer.chrome.com/docs/android/trusted-web-activity), [Bubblewrap CLI](https://github.com/GoogleChromeLabs/bubblewrap/tree/main/packages/cli).

| Approach | Fit for Foreman | Tradeoff |
| --- | --- | --- |
| Installed PWA | First personal-phone milestone; home-screen launch and standalone display | Browser installation rather than our own APK or Play listing |
| TWA using Bubblewrap | Recommended Android package; serves the existing hosted UI | Requires signing, domain association, and a supporting browser; Google sign-in may temporarily show browser UI |
| Capacitor | Reconsider if native device integrations or iOS become priorities | Bundled assets need API-origin and authentication integration; more maintenance |
| Plain WebView | Poor fit for the current Firebase popup flow | Requires explicit external-browser/native authentication and lifecycle handling |

Capacitor's remote `server.url` setting is documented for development live reload, not production. A production Capacitor implementation would need a considered bundled-app approach. Foreman's relative `/api/*` requests and Cloudflare same-origin checks would also need adaptation. [Capacitor configuration](https://capacitorjs.com/docs/config).

## What is already ready

Repository inspection found HTTPS hosting, a responsive UI, Firebase Google authentication, and browser reconnection/polling. A wrapper continues using the existing Mac execution host; it does not move Claude/Codex execution onto the phone or make sessions work while the Mac is unavailable. No additional server is needed for the proposed wrapper.

The web directory has no web app manifest, install icons, service worker, or Digital Asset Links file. This Mac has Android SDK command-line tools, platform tools, an emulator, and API 35 assets in the standard SDK directory. No Java runtime was discoverable through `java_home`; Bubblewrap is not configured. These checks do not establish that a phone is connected or that all build dependencies are ready.

## First milestones

1. **Installable web app.** Add a manifest with stable app identity, name, `/` start URL/scope, standalone display, theme/background colors, and 192px/512px icons including a maskable variant. Link it from the page. Test installation and the keyboard, safe areas, and Android Back behavior. Chrome's install-promotion criteria require manifest metadata and HTTPS; a service worker is not listed as a current prerequisite. [Install criteria](https://web.dev/articles/install-criteria).
2. **Authentication proof on Android.** Test the existing popup flow from Chrome and installed mode with a real authorized account. Confirm account selection, cancellation, return to Foreman, token refresh, and sign-out. Google recommends browser-based authentication rather than embedded WebView OAuth. [Google guidance](https://support.google.com/faqs/answer/12284343?hl=en).
3. **Signed APK prototype.** Configure compatible Java/Android tools and pin Bubblewrap. Proposed package ID: `io.github.hyang0129.foreman` (confirm before the first distributed build). Generate from the hosted manifest, keep signing keys/passwords outside Git, and install on a test phone. Bubblewrap supports project generation, signed builds, and device installation. [Quick start](https://developer.chrome.com/docs/android/trusted-web-activity/quick-start).
4. **Verified full-screen launch.** Serve `/.well-known/assetlinks.json` with the package ID and the actual signing certificate's SHA-256 fingerprint. Check that the response is public JSON and that verification succeeds. Wrong fingerprints cause a browser-toolbar fallback. If later using Play App Signing, associate the Play signing certificate as well as any separately distributed APK certificate. Google-owned login origins will retain browser UI. [Quick start](https://developer.chrome.com/docs/android/trusted-web-activity/quick-start), [multiple-origin behavior](https://developer.chrome.com/docs/android/trusted-web-activity/multi-origin).
5. **Release smoke test.** Verify session selection, model selection, sending one message without duplicate delivery, approval presentation, background/foreground recovery, phone-network loss, host-offline behavior, keyboard visibility, and loading a new web deployment. Test an authenticated journey on a physical Android device before calling the wrapper ready.

## Authentication contingency

The current app uses `signInWithPopup`, with a Firebase auth domain different from its Cloudflare origin. Do not assume replacing it with redirects will just work: Firebase requires a supported mitigation for third-party storage restrictions. If device testing calls for redirect sign-in, evaluate its documented reverse-proxy option for `/__/auth/*`, update `authDomain` and the OAuth redirect URI, and validate return-state handling. Cloudflare currently runs the Worker first only for `/api/*`; helper requests would need their own route. Auth helpers must not inherit framing restrictions that prevent Firebase's iframe from functioning. Keep this as separate authentication work, with regression checks. [Firebase redirect guidance](https://firebase.google.com/docs/auth/web/redirect-best-practices).

## Offline behavior and distribution

An offline screen can be a later PWA improvement. If adding a service worker, cache only an intentional public shell and offline assets; bypass auth helpers, `/api/*`, tokens, and session history. Do not queue mutations offline or automatically reload while someone is drafting or answering an approval. Background push notifications are separate functionality, not something the wrapper supplies automatically.

Start with the user's preferred personal-install or distribution path. Google Play adds account verification, testing/release requirements, a store listing and privacy disclosures; creating a developer account currently costs US$25 once. No paid account or store submission has been initiated. Outside-Play distribution rules also vary by device/region and are changing; recheck the chosen channel when releasing. [Play Console setup](https://support.google.com/googleplay/android-developer/answer/6112435?hl=en), [Android distribution guidance](https://developer.android.com/developer-verification/guides).

The immediate unknown is the end-to-end Android login journey. The remaining concrete work is install metadata/icons, Java/Bubblewrap setup, signing/domain association, and device validation. No UI runtime, cloud configuration, SDK installation, signing key, APK, or store release was changed during this exploration.
