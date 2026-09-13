# Foreman developer MVP

Product decision: ship a private, single-developer remote session inbox for one Mac. Direct Claude and Codex conversations are the primary workflow; the project manager remains a pinned conversation. Existing terminal sessions are monitor-only unless Foreman owns a tested controller.

## Release scope and acceptance

1. **Shared session service:** start either provider in an existing local project; list state and capabilities; retain readable history, message receipts, and session metadata under `~/.foreman`. Queue follow-ups and deduplicate by client message ID. After restart, mark uncertain work explicitly and never replay it automatically.
2. **Session-first browser:** responsive session list, focused conversation, provider/activity indicators, new-session form, follow-up composer, interrupt, one-time approvals, and supported question answers. Refresh restores authoritative state. Keep PM accessible.
3. **Peer tools:** managed Claude, managed Codex, and PM use the same service to list sessions, read bounded history, send messages, request updates, and inspect receipts. Foreman supplies sender identity. No automatic conversation loops.
4. **Private hosted access:** Cloudflare Worker serves static UI; Firebase Google sign-in allows verified `hooong.yang@gmail.com` only. An authenticated outbound Mac WebSocket relays allowlisted API requests. Provider credentials and execution remain on the Mac. Offline state is explicit and mutations fail while disconnected.
5. **Verification and release:** controller/service regression tests, auth/relay tests, browser journey, provider smoke tests, refresh/retry and restart recovery. Review and commit implementation; no push required.

## Shared API contract

All JSON responses use `{error: string}` on failure. Request bodies are bounded. Existing `/api/pm/*`, `/api/memory`, and `/api/session/tail?id=` remain available.

- `GET /api/host` → `{online:true, host:string}` locally; relay reports its connection state remotely.
- `GET /api/sessions` → array of discovered and managed sessions. Existing fleet fields plus `managed:boolean`, `capabilities:{message:boolean,interrupt:boolean,approvals:boolean}`, optional `control_reason:string`. Managed `session_key` is a stable opaque identifier; provider native ID is separate.
- `POST /api/sessions` body `{id,provider:"claude"|"codex",name,cwd,text}` → session; `id` deduplicates creation.
- `GET /api/session?id=` → `{session,history,receipts,approvals}`. History entries `{id,role:"user"|"assistant"|"system"|"tool",text,at,source?}`; receipts `{id,status:"queued"|"running"|"completed"|"failed"|"uncertain",text,at,error?,source?}`.
- `POST /api/session/message` body `{id:session_key,message_id,text}` → receipt. User-provided sender identity is ignored.
- `POST /api/session/interrupt` body `{id}` → `{ok:true}`.
- `POST /api/session/approval` body `{id,approval_id,decision:"allow"|"deny",answers?:Record<string,string>}` → `{ok:true}`. Approvals `{id,kind:"permission"|"question"|"unsupported",tool,input,reason?,questions?:[{id,question,options?:string[]}]}`. Stale responses fail.
- `GET /api/events` SSE: existing `fleet`, `pm`, `pm_state`; `session` means refetch selected conversation; `host` gives connection status. Browser can poll authoritative JSON when streaming is unavailable.
- `GET /api/config` → `{auth:{required:boolean,firebase?:object}}`. Local returns auth not required; hosted returns public Firebase config.

## Parallel ownership

- Session implementation: `server/session-service.ts`, local HTTP integration in `server/main.ts`, controller changes, service regression tests.
- Browser implementation: `web/*` only; follow the API above, use Firebase browser SDK and bearer-authenticated fetch, poll while signed in.
- Peer implementation: `server/peer-tools.ts`, `server/peer-mcp.ts`, PM/tools integration and peer tests; coordinate controller tool injection with session implementation.
- Root: Cloudflare Worker/DO, outbound host bridge, Firebase/Cloudflare provisioning, package/config/docs integration, release checks.

## Deferred

Multiple users/hosts, cloud execution, arbitrary live terminal takeover, native apps, push notifications, kanban/PR views, editing/diff UI, model selection, and Happy implementation parity. Codex hook trust requires the user's `/hooks` action; managed sessions also report state directly through controllers.

## Implementation outcome

The listed local service, UI, peer tools, and Cloudflare relay are implemented. The Mac is paired with the deployed Worker. Disposable live Claude/Codex journeys passed, including cross-provider tools and approval denial. All 98 automated provider/service, browser, and Workers tests pass. A real browser also created a Codex session through the local HTTP API and completed a context-preserving follow-up. Firebase project activation is externally blocked by HTTP403 despite verified IAM permissions; completing Firebase console setup, Google provider deployment, public config/domain setup, and actual sign-in validation remain. See [Cloud setup](CLOUD_SETUP.md).

Recovery ships conservatively: saved histories/receipts remain; restarted sessions are read-only and unfinished work is marked uncertain without replay. The pinned legacy PM has separate message semantics. PM shell/glob/grep access was removed and a pre-tool guard enforces documentation/memory boundaries before provider auto-approval.
