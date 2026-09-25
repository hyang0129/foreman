// Foreman service worker: installability, an offline fallback screen and update-safe
// navigation. Deliberately small.
//
// Invariants:
// - Never caches /api/*, auth, tokens, history, app code or any navigation response. The only
//   cached files are the offline screen and the icons, precached into a versioned cache.
// - Handles navigations only (network-first, offline screen on network failure). Everything
//   else (app.js, style.css, Firebase, API traffic) is left to the browser exactly as without a
//   service worker, so a web deploy reaches the app on its next load and nothing is pinned.
// - Never reloads or navigates a page. skipWaiting + clients.claim only take over future
//   requests; an open page with a draft or an approval is left alone. A notification click
//   posts its URL to an open app window (the app routes it in place) and opens a new window
//   only when none is open.
// - Push handling never fetches anything (no /api/* access: the worker holds no credentials)
//   and shows only title, body, tag and url from a validated payload.
//
// Kill switch: if this worker ever misbehaves in the field, deploy an sw.js that replaces this
// file with only:
//   self.addEventListener("install", () => self.skipWaiting());
//   self.addEventListener("activate", (event) => event.waitUntil((async () => {
//     for (const key of await caches.keys()) if (key.startsWith("foreman-shell-")) await caches.delete(key);
//     await self.registration.unregister();
//   })()));
// sw.js is served with Cache-Control: no-cache (web/_headers) and registered with
// updateViaCache "none", so browsers pick the replacement up on their next update check.
//
// Push (AND-05): the `push` and `notificationclick` listeners below the fetch handler are
// independent of the fetch/caching logic. A notification click only opens or focuses a
// same-origin URL that passes the deep-link safety check (see safeAppUrl).

const CACHE_PREFIX = "foreman-shell-";
const CACHE = `${CACHE_PREFIX}v1`;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const url of PRECACHE) {
      const response = await fetch(new Request(url, { cache: "reload" }));
      if (!response.ok) throw new Error(`Precache failed for ${url} (${response.status})`);
      // Store a clean copy: a redirected response (a host that canonicalizes /offline.html)
      // cannot be used to answer a navigation.
      await cache.put(url, new Response(await response.blob(), { status: 200, headers: response.headers }));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys())
      if (key.startsWith(CACHE_PREFIX) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Returning without respondWith hands the request back to the browser untouched.
  if (request.method !== "GET" || request.mode !== "navigate") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname === "/api" || url.pathname.startsWith("/api/")) return;
  event.respondWith(navigate(request));
});

// Network-first and never cached; the offline screen only when the network fails.
async function navigate(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const offline = await caches.match(OFFLINE_URL, { cacheName: CACHE });
    if (offline) return offline;
    throw error;
  }
}

// Mirrors pushUrlIsSafe in shared/notify.ts: relative, same-origin, one leading "/", no
// backslash, whitespace or control characters.
function safeAppUrl(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) return false;
  if (url[0] !== "/" || url[1] === "/") return false;
  if (url.includes("\\")) return false;
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(url)) return false;
  return true;
}

// Push payload (epic #43 contract B): { v: 1, kind, host, session_key?, session_name?, at, tag,
// title, body, url }. Only title, body, tag and url are shown; every other field is ignored.
// An empty payload (the relay's payload-less fallback), unreadable JSON, another version, a
// malformed field or an unsafe url shows the generic notification, which opens "/".
const GENERIC_NOTIFICATION = { title: "Foreman needs your attention", body: "Open Foreman to see what needs you.", tag: "foreman", url: "/", renotify: true };
// No `badge`: Android draws a badge from its alpha channel only, and every shipped icon is an
// opaque square, which would show as a blank white square in the status bar. Chrome's default
// badge is used until a monochrome badge icon exists.
const ICON = "/icons/icon-192.png";
const isText = (value, max, allowEmpty = false) => typeof value === "string" && value.length <= max && (allowEmpty || value.length > 0);

function notificationFor(data) {
  let payload;
  try { payload = data ? data.json() : null; } catch { return GENERIC_NOTIFICATION; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.v !== 1) return GENERIC_NOTIFICATION;
  const { title, body, tag, url, kind } = payload;
  if (!isText(title, 200) || !isText(body, 500, true) || !isText(tag, 400) || !safeAppUrl(url)) return GENERIC_NOTIFICATION;
  // Approvals and questions alert again when they replace an earlier notification.
  return { title, body, tag, url, renotify: kind === "approval_requested" || kind === "question_asked" };
}

self.addEventListener("push", (event) => {
  const note = notificationFor(event.data);
  event.waitUntil(self.registration.showNotification(note.title, {
    body: note.body,
    tag: note.tag,
    renotify: note.renotify,
    icon: ICON,
    data: { url: note.url },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safeAppUrl(event.notification.data?.url) ? event.notification.data.url : "/";
  event.waitUntil(openApp(url));
});

// Route an open app window in place (the app handles the message with its deep-link routing,
// so drafts and history are kept), preferring a focused, then a visible window; otherwise
// open a new one.
async function openApp(url) {
  const windows = (await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
    .filter((client) => ["/", "/index.html"].includes(new URL(client.url).pathname));
  const client = windows.find((c) => c.focused) || windows.find((c) => c.visibilityState === "visible") || windows[0];
  if (client) {
    client.postMessage({ type: "foreman:open", url });
    try { await client.focus(); } catch { /* Focus needs the click's activation; routing already happened. */ }
    return;
  }
  await self.clients.openWindow(new URL(url, self.location.origin).href);
}
