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
//   requests; an open page with a draft or an approval is left alone.
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
// Extending (AND-05): add `push` and `notificationclick` listeners below the fetch handler.
// They are independent of the fetch/caching logic; a notification click must only open or
// focus a same-origin URL that passes the deep-link safety check (see safeAppUrl).

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
// backslash, whitespace or control characters. For AND-05's notificationclick handler.
function safeAppUrl(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) return false;
  if (url[0] !== "/" || url[1] === "/") return false;
  if (url.includes("\\")) return false;
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(url)) return false;
  return true;
}
