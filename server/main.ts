// Foreman server: static UI + JSON/SSE API over the fleet store and the PM.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { Fleet, transcriptTail } from "./fleet.ts";
import { modelCatalog } from "./models.ts";
import { ProjectManager } from "./pm.ts";
import { SessionService } from "./session-service.ts";
import { preparePeerTools } from "./peer-tools.ts";
import { startHostBridge } from "./host-bridge.ts";
import { runClaude } from "./tools.ts";
import { PORT, REPO_ROOT, ensureDirs, MEMORY_DIR, HOST, FOREMAN_HOME } from "./paths.ts";
import { writeFileSync } from "node:fs";

import { localAuth } from './local-auth.ts';

ensureDirs();
const auth = localAuth(FOREMAN_HOME);
for (const [f, seed] of [["PROJECTS.md", "# Projects\n\n(none yet)\n"], ["LOG.md", "# Log\n"]] as const) {
  const p = join(MEMORY_DIR, f); if (!existsSync(p)) writeFileSync(p, seed);
}

const fleet = new Fleet();
const sessions = new SessionService({ fleet });
sessions.setPrepare((session) => preparePeerTools(sessions, session));
const pm = new ProjectManager(fleet, sessions);
let bridge: { close(): void } | undefined;
const clients = new Set<ServerResponse>();

function sse(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event: string, data: unknown) { for (const c of clients) sse(c, event, data); }

fleet.on("change", () => broadcast("fleet", sessions.list()));
sessions.on("change", (list) => broadcast("fleet", list));
sessions.on("session", (event) => broadcast("session", event));
pm.on("event", (ev) => broadcast("pm", ev));

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 128 * 1024) throw new Error("Request body exceeds 128 KiB"); chunks.push(c as Buffer); }
  const s = Buffer.concat(chunks).toString("utf8"); const value = s ? JSON.parse(s) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required');
  return value;
}
function json(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
    if (!allowedHosts.has(req.headers.host ?? '')) return json(res, 403, { error: 'Use the Foreman loopback address' });
    if (req.headers.origin && ![...allowedHosts].some((host) => req.headers.origin === `http://${host}`)) return json(res, 403, { error: 'Cross-origin requests are not allowed' });
    if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, { auth: { required: true, kind: 'local' } });
    if (url.pathname === '/api/auth/local' && req.method === 'POST') {
      const { token } = await body(req);
      if (!auth.valid(token)) return json(res, 401, { error: 'Invalid local API token' });
      res.setHeader('Set-Cookie', `foreman_local=${token}; HttpOnly; SameSite=Strict; Path=/`);
      return json(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/health' && !auth.accepts(req)) return json(res, 401, { error: 'Local API token required' });
    if (url.pathname === '/api/host' && req.method === 'GET') return json(res, 200, { online: true, host: HOST });
    if (url.pathname === "/api/health" && req.method === "GET") return json(res, 200, { ok: true, pid: process.pid, uptime: process.uptime(), pm_enabled: process.env.FOREMAN_PM_DISABLED !== "1" });
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": hello\n\n");
      clients.add(res);
      sse(res, "fleet", sessions.list());
      sse(res, "pm_state", { busy: pm.busy, session_id: pm.sessionId, tools: pm.tools });
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    if (url.pathname === "/api/sessions" && req.method === 'GET') { await fleet.refresh(); return json(res, 200, sessions.list()); }
    if (url.pathname === '/api/sessions' && req.method === 'POST') return json(res, 202, await sessions.create(await body(req)));
    if (url.pathname === '/api/session' && req.method === 'GET') return json(res, 200, sessions.detail(url.searchParams.get('id') ?? ''));
    if (url.pathname === '/api/session/message' && req.method === 'POST') {
      const { id, message_id, text } = await body(req); return json(res, 202, sessions.send(id, text, message_id));
    }
    if (url.pathname === '/api/session/interrupt' && req.method === 'POST') { const { id } = await body(req); await sessions.interrupt(id); return json(res, 200, { ok: true }); }
    if (url.pathname === '/api/session/approval' && req.method === 'POST') {
      const { id, approval_id, decision, answers } = await body(req); await sessions.approve(id, approval_id, decision, answers); return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/session/tail") {
      const id = url.searchParams.get('id') ?? '';
      if (id.startsWith('fm:')) return json(res, 200, { text: sessions.detail(id).history.map((entry) => `${entry.role}: ${entry.text}`).join('\n\n') });
      const s = fleet.get(url.searchParams.get("id") ?? "");
      if (!s) return json(res, 404, { error: "no such session" });
      if (s.transcript_path) return json(res, 200, { text: transcriptTail(s.transcript_path, 10, s.provider) });
      if (s.bg_id) { const r = await runClaude(["logs", s.bg_id]); return json(res, 200, { text: r.stdout.slice(-6000) || r.stderr }); }
      return json(res, 200, { text: "(no transcript yet)" });
    }
    if (url.pathname === '/api/models' && req.method === 'GET') return json(res, 200, { models: await modelCatalog.list(url.searchParams.get('provider') ?? '') });
    if (url.pathname === '/api/pm/model' && req.method === 'POST') { const { model } = await body(req); await pm.setModel(model); return json(res, 200, { model: pm.model ?? null }); }
    if (url.pathname === "/api/pm/history") return json(res, 200, { history: pm.history(), error: pm.lastError, busy: pm.modelBusy, session_id: pm.sessionId, model: pm.model ?? null });
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
    json(res, 400, { error: String(e?.message ?? e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`foreman: http://localhost:${PORT}`);
  console.log(`foreman: local API token file: ${auth.path}`);
  fleet.start();
  bridge = startHostBridge(PORT, auth.token);
  if (process.env.FOREMAN_PM_DISABLED !== "1") pm.start().catch((e: unknown) => console.error("pm:", e));
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  fleet.stop(); pm.close(); bridge?.close();
  const providersClosed = sessions.close();
  for (const client of clients) client.end();
  clients.clear();
  const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  setTimeout(() => process.exit(1), 5000).unref();
  try { await Promise.all([httpClosed, providersClosed]); process.exit(0); }
  catch (error) { console.error('Foreman shutdown cleanup failed:', error); process.exit(1); }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
