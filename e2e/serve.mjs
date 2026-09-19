import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../web/", import.meta.url));
const allowed = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/appearance.js", "appearance.js"],
  ["/style.css", "style.css"],
]);
const mime = {
  html: "text/html",
  js: "application/javascript",
  css: "text/css",
};
const server = createServer(async (req, res) => {
  const file = allowed.get(new URL(req.url, "http://localhost").pathname);
  if (!file) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  try {
    res.writeHead(200, {
      "content-type": mime[file.split(".").at(-1)],
      "cache-control": "no-store",
    });
    res.end(await readFile(join(root, file)));
  } catch {
    res.writeHead(500);
    res.end("Failed to serve fixture");
  }
});
server.listen(4188, "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => server.close(() => process.exit(0)));
