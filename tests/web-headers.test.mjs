// The hosted app's HTML and code must never mix deploys: a stale app.js/style.css under a fresh
// index.html broke the installed Android app after the #154 deploy. web/_headers keeps them all
// out of the browser cache. The e2e fixture server sends no-store on everything, so only
// a check on the file itself can catch a regression.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

function headerRules(text) {
  const rules = new Map();
  let current = null;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) { current = new Map(); rules.set(line.trim(), current); continue; }
    const at = line.indexOf(":");
    current?.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return rules;
}

test("the page and its code are never stored in the browser cache", () => {
  const rules = headerRules(readFileSync(new URL("../web/_headers", import.meta.url), "utf8"));
  for (const path of ["/", "/index.html", "/app.js", "/appearance.js", "/style.css"])
    assert.equal(rules.get(path)?.get("cache-control"), "no-store", `${path} must be Cache-Control: no-store`);
});

// An installed service worker keeps answering from the files it precached until sw.js itself
// changes, so a fix to offline.html (or an icon) reaches no installed app unless the cache version
// is bumped with it. The hashes below are the precached files of the current version: a change to
// one of them fails here until CACHE in web/sw.js is bumped and the new hashes recorded.
const PRECACHED = {
  version: "v2",
  files: {
    "/offline.html": "97da563a190c35e9837a083304d2a4e698e24e35183da59611d88f7c3afbab6b",
    "/icons/icon-192.png": "a42c4a3ff59a565c0039e19f2d6061d467ec73b414ff17961c4f5baf761b6316",
    "/icons/icon-512.png": "5cc6ddff195640a3f5c2a43db3a5c402d91b2c885e187916d85b9bda820c5372",
    "/icons/maskable-512.png": "c20af94f05f0bd01088ee0b7a17bdf4eccce991808d84c1c69fc1a455a895a65",
  },
};
test("a change to a precached file comes with a new service worker cache version", () => {
  const sw = readFileSync(new URL("../web/sw.js", import.meta.url), "utf8");
  const version = /const CACHE = `\$\{CACHE_PREFIX\}(v\d+)`;/.exec(sw)?.[1];
  const offline = /const OFFLINE_URL = "([^"]+)";/.exec(sw)?.[1];
  const list = /const PRECACHE = \[([^\]]*)\];/.exec(sw)?.[1];
  assert.ok(version && offline && list, "sw.js declares CACHE, OFFLINE_URL and PRECACHE");
  const precached = [...list.matchAll(/"([^"]+)"|OFFLINE_URL/g)].map((m) => m[1] ?? offline);
  assert.deepEqual(precached.sort(), Object.keys(PRECACHED.files).sort(), "the recorded files are the precached ones");
  const hashes = Object.fromEntries(precached.map((path) =>
    [path, createHash("sha256").update(readFileSync(new URL(`../web${path}`, import.meta.url))).digest("hex")]));
  const changed = Object.keys(hashes).filter((path) => hashes[path] !== PRECACHED.files[path]);
  if (version === PRECACHED.version)
    assert.deepEqual(changed, [], `precached files changed without a new cache version: bump CACHE in web/sw.js (now ${version}) and record the new hashes here`);
  else assert.fail(`sw.js is at cache ${version}; record its precached files' hashes here (${JSON.stringify(hashes)})`);
});

test("sw.js keeps no-cache so browsers check for a new worker on every update", () => {
  const rules = headerRules(readFileSync(new URL("../web/_headers", import.meta.url), "utf8"));
  assert.equal(rules.get("/sw.js")?.get("cache-control"), "no-cache");
});
