// Foreman server: static UI + JSON/SSE API over the fleet store and the PM.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { Fleet, transcriptTail } from "./fleet.ts";
import { ProjectManager } from "./pm.ts";
import { runClaude } from "./tools.ts";
import { PORT, REPO_ROOT, ensureDirs, MEMORY_DIR } from "./paths.ts";
import { writeFileSync } from "node:fs";

ensureDirs();
for (const [f, seed] of [["PROJECTS.md", "# Projects\n\n(none yet)\n"], ["LOG.md", "# Log\n"]] as const) {
  const p = join(MEMORY_DIR, f); if (!existsSync(p)) writeFileSync(p, seed);
}

const fleet = new Fleet();
const pm = new ProjectManager(fleet);
const clients = new Set<ServerResponse>();

function sse(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event: string, data: unknown) { for (const c of clients) sse(c, event, data); }

fleet.on("change", (list) => broadcast("fleet", list));
pm.on("event", (ev) => broadcast("pm", ev));

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString("utf8"); return s ? JSON.parse(s) : {};
}
function json(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname === "/api/health" && req.method === "GET") return json(res, 200, { ok: true, pid: process.pid, uptime: process.uptime(), pm_enabled: process.env.FOREMAN_PM_DISABLED !== "1" });
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": hello\n\n");
      clients.add(res);
      sse(res, "fleet", fleet.list());
      sse(res, "pm_state", { busy: pm.busy, session_id: pm.sessionId, tools: pm.tools });
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    if (url.pathname === "/api/sessions") { await fleet.refresh(); return json(res, 200, fleet.list()); }
    if (url.pathname === "/api/session/tail") {
      const s = fleet.get(url.searchParams.get("id") ?? "");
      if (!s) return json(res, 404, { error: "no such session" });
      if (s.transcript_path) return json(res, 200, { text: transcriptTail(s.transcript_path, 10, s.provider) });
      if (s.bg_id) { const r = await runClaude(["logs", s.bg_id]); return json(res, 200, { text: r.stdout.slice(-6000) || r.stderr }); }
      return json(res, 200, { text: "(no transcript yet)" });
    }
    if (url.pathname === "/api/pm/history") return json(res, 200, { history: pm.history(), busy: pm.busy, session_id: pm.sessionId });
    if (url.pathname === "/api/pm/message" && req.method === "POST") {
      const { text } = await body(req);
      if (!text || typeof text !== "string") return json(res, 400, { error: "text required" });
      pm.send(text); return json(res, 202, { ok: true });
    }
    if (url.pathname === "/api/pm/interrupt" && req.method === "POST") { await pm.interrupt(); return json(res, 200, { ok: true }); }
    if (url.pathname === "/api/memory") {
      const read = (f: string) => (existsSync(join(MEMORY_DIR, f)) ? readFileSync(join(MEMORY_DIR, f), "utf8") : "");
      return json(res, 200, { projects: read("PROJECTS.md"), log: read("LOG.md") });
    }
    // static
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = join(REPO_ROOT, "web", p);
    if (!file.startsWith(join(REPO_ROOT, "web")) || !existsSync(file)) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch (e: any) {
    json(res, 500, { error: String(e?.message ?? e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`foreman: http://localhost:${PORT}`);
  fleet.start();
  if (process.env.FOREMAN_PM_DISABLED !== "1") pm.start().catch((e: unknown) => console.error("pm:", e));
});
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  fleet.stop(); pm.close();
  for (const client of clients) client.end();
  clients.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
