// Test-only static server for the Playwright UI suites (127.0.0.1 is a secure context, so the
// service worker registers). It serves an explicit allowlist from web/ and applies the rules in
// web/_headers, as Cloudflare's static assets do, so tests exercise the real header file.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../web/", import.meta.url));
const allowed = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/appearance.js", "appearance.js"],
  ["/style.css", "style.css"],
  ["/sw.js", "sw.js"],
  ["/offline.html", "offline.html"],
  ["/manifest.webmanifest", "manifest.webmanifest"],
  ["/icons/icon-192.png", "icons/icon-192.png"],
  ["/icons/icon-512.png", "icons/icon-512.png"],
  ["/icons/maskable-512.png", "icons/maskable-512.png"],
  ["/icons/apple-touch-icon-180.png", "icons/apple-touch-icon-180.png"],
  ["/icons/badge-96.png", "icons/badge-96.png"],
]);
const mime = {
  html: "text/html",
  js: "application/javascript",
  css: "text/css",
  png: "image/png",
  webmanifest: "application/manifest+json",
};
// Minimal _headers parser: an unindented path line (exact, or ending in "*"), followed by
// indented "Name: value" lines.
function parseHeaders(text) {
  const rules = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) rules.push({ pattern: line.trim(), headers: [] });
    else if (rules.length) {
      const at = line.indexOf(":");
      rules.at(-1).headers.push([line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()]);
    }
  }
  return rules;
}
const headerRules = parseHeaders(readFileSync(join(root, "_headers"), "utf8"));
const matches = (pattern, path) => pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : pattern === path;

// Test-only deploy simulation: a request carrying the cookie `foreman-e2e-version=<marker>`
// gets that marker stamped into index.html and app.js, as if a new version had been deployed.
// Without the cookie every file is served byte-for-byte. Only tests set the cookie, and this
// server never runs outside the Playwright suite.
function versionMarker(req) {
  const match = /(?:^|;\s*)foreman-e2e-version=([A-Za-z0-9-]{1,32})(?:;|$)/.exec(req.headers.cookie || "");
  return match?.[1] ?? null;
}
function stamp(file, body, marker) {
  if (!marker) return body;
  if (file === "app.js") return Buffer.concat([body, Buffer.from(`\nglobalThis.__foremanE2EVersion = "${marker}";\n`)]);
  if (file === "index.html")
    return Buffer.from(body.toString("utf8").replace("<head>", `<head>\n    <meta name="foreman-e2e-version" content="${marker}" />`));
  return body;
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const file = allowed.get(path);
  if (!file) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  try {
    const body = stamp(file, await readFile(join(root, file)), versionMarker(req));
    const headers = {
      "content-type": mime[file.split(".").at(-1)],
      "cache-control": "no-store",
    };
    for (const rule of headerRules)
      if (matches(rule.pattern, path))
        for (const [name, value] of rule.headers) headers[name] = value;
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(500);
    res.end("Failed to serve fixture");
  }
});
server.listen(4188, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => server.close(() => process.exit(0)));
