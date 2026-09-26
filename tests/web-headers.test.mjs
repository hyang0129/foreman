// The hosted app's HTML and code must never mix deploys: a stale app.js/style.css under a fresh
// index.html broke the installed Android app after the #154 deploy. web/_headers keeps them all
// out of the browser cache. The e2e fixture server sends no-store on everything, so only
// a check on the file itself can catch a regression.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

test("sw.js keeps no-cache so browsers check for a new worker on every update", () => {
  const rules = headerRules(readFileSync(new URL("../web/_headers", import.meta.url), "utf8"));
  assert.equal(rules.get("/sw.js")?.get("cache-control"), "no-cache");
});
