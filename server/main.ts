// Foreman server: static UI + JSON/SSE API over the fleet store and the PM.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { Fleet, transcriptTail } from "./fleet.ts";
import { modelCatalog } from "./models.ts";
import { ProjectManager, choosePmStore } from "./pm.ts";
import { Launcher } from "./launcher.ts";
import { ProjectRegistry } from "./projects.ts";
import { SessionService } from "./session-service.ts";
import { preparePeerTools } from "./peer-tools.ts";
import { startHostBridge, readBridgeConfig } from "./host-bridge.ts";
import { Notifier } from "./notifier.ts";
import { runClaude } from "./tools.ts";
import { PORT, REPO_ROOT, ensureDirs, HOST, FOREMAN_HOME } from "./paths.ts";
import { loadMachineIdentity, type MachineIdentity } from "./machine.ts";
import { createPmStore, type HostPmStore } from "./pm-store.ts";
import { redactSecrets } from "../shared/redact.ts";
import { PM_HOST_LOCAL_ONLY_ERROR, type MemoryResponse, type PmHostResponse } from "../shared/pm-state.ts";

import { localAuth } from './local-auth.ts';

ensureDirs();
const auth = localAuth(FOREMAN_HOME);
// Epic #26: PM memory lives in the PM state store (the relay DO, or pm/state.json in local-only
// mode). The daemon no longer seeds or reads memory/PROJECTS.md or LOG.md; the store imports them once.

const projects = new ProjectRegistry();
const launcher = new Launcher(projects, { identityFile: join(FOREMAN_HOME, 'launcher-sessions.json') });
const fleet = new Fleet({ excludeSession: (session) => launcher.ownsSession(session) });
const sessions = new SessionService({ fleet, projects });
projects.seed(sessions.list());
sessions.setPrepare((session) => preparePeerTools(sessions, session));
// Machine identity (machine.json). As with an invalid cloud.json (logged, and the daemon runs
// without the relay and without a PM), an invalid, symlinked or foreign-owned machine.json is logged and the daemon
// keeps running: without an identity it speaks the legacy relay protocol and runs no PM, and the
// PM's error names the cause. machine.json is never regenerated over a bad file.
let identity: MachineIdentity | null = null;
let identityError: string | null = null;
try { identity = loadMachineIdentity(); }
catch (error) { identityError = redactSecrets(String((error as Error)?.message ?? error)).slice(0, 300); console.error('foreman: machine identity error:', identityError); }
const pm = new ProjectManager(fleet, { sessions, projects, machineName: identity?.name ?? HOST });
let store: HostPmStore | null = null;
const startedAt = Date.now();
let bridge: ReturnType<typeof startHostBridge> | undefined;
let notifier: Notifier | undefined;
const clients = new Set<ServerResponse>();

function sse(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event: string, data: unknown) { for (const c of clients) sse(c, event, data); }

fleet.on("change", () => { projects.seed(sessions.list()); broadcast("fleet", sessions.list()); });
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
    if (url.pathname === '/api/launch/propose' && req.method === 'POST') return json(res, 202, launcher.start(await body(req)));
    if (url.pathname === '/api/launch' && req.method === 'GET') return json(res, 200, launcher.get(url.searchParams.get('id') ?? ''));
    if (url.pathname === '/api/launch/cancel' && req.method === 'POST') { const { id } = await body(req); return json(res, 200, launcher.cancel(id)); }
    if (url.pathname === '/api/projects' && req.method === 'GET') { await fleet.refresh(); projects.seed(sessions.list()); return json(res, 200, { projects: projects.list() }); }
    if (url.pathname === '/api/projects/resolve' && req.method === 'POST') { const { reference } = await body(req); return json(res, 200, projects.resolve(reference)); }
    if (url.pathname === '/api/projects/register' && req.method === 'POST') return json(res, 200, projects.register(await body(req)));
    if (url.pathname === '/api/projects/update' && req.method === 'POST') { const { id, name, aliases } = await body(req); return json(res, 200, projects.update(id, name, aliases)); }
    if (url.pathname === '/api/projects/remove' && req.method === 'POST') { const { id } = await body(req); projects.remove(id); return json(res, 200, { ok: true }); }
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
    if (url.pathname === "/api/pm/history" && url.searchParams.get("summary") === "1") return json(res, 200, { error: pm.lastError, busy: pm.modelBusy });
    if (url.pathname === "/api/pm/history") return json(res, 200, { history: pm.history(), error: pm.lastError, busy: pm.modelBusy, session_id: pm.sessionId, model: pm.model ?? null });
    if (url.pathname === "/api/pm/message" && req.method === "POST") {
      const { text } = await body(req);
      if (!text || typeof text !== "string") return json(res, 400, { error: "text required" });
      // 202 only once the in-flight turn is recorded and the message dispatched; otherwise 503 with the cause.
      try { await pm.send(text); }
      catch (error) { return json(res, 503, { error: String((error as Error)?.message ?? error) }); }
      return json(res, 202, { ok: true });
    }
    if (url.pathname === "/api/pm/interrupt" && req.method === "POST") { await pm.interrupt(); return json(res, 200, { ok: true }); }
    if (url.pathname === '/api/pm/host' && req.method === 'GET') return pmHost(res);
    if (url.pathname === '/api/pm/host' && req.method === 'POST') {
      // Only the relay reassigns the PM; the Worker answers this route for the hosted app.
      return json(res, 400, { error: store?.mode === 'relay' ? 'Move the PM from the hosted app; the cloud relay makes that change.' : PM_HOST_LOCAL_ONLY_ERROR });
    }
    if (url.pathname === "/api/memory" && req.method === 'GET') {
      if (!store) return json(res, 503, { error: pm.lastError ?? 'PM memory is unavailable on this machine' });
      let memory;
      try { memory = await store.read(); }
      catch (error) { return json(res, 503, { error: redactSecrets(String((error as Error)?.message ?? error)).slice(0, 300) }); }
      const response: MemoryResponse = { projects: memory.projects.content, log: memory.log.map((entry) => `- ${entry.at} ${entry.text}`).join('\n'), preferences: memory.preferences.content };
      return json(res, 200, response);
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

// GET /api/pm/host. Local-only mode answers for its single machine. In relay mode the Worker/DO
// answers this route for the hosted app (it is never relayed); a request that reaches this host
// directly (the local UI) gets 404 with this host's own view of the assignment: this host cannot
// see the other machines, whether they are online, or when and by whom the PM was assigned, so it
// never answers a PmHostResponse. The PM view shows this view as one line (whether this machine
// runs the PM, the active machine's name) and points to the hosted app for the rest.
function pmHost(res: ServerResponse) {
  if (store?.mode === 'local' && identity) {
    const response: PmHostResponse = {
      active: { machine_id: identity.machine_id, name: identity.name, online: true, epoch: 1, assigned_at: startedAt, assigned_by: 'bootstrap' },
      machines: [{ machine_id: identity.machine_id, name: identity.name, platform: process.platform, online: true, last_seen: Date.now(), active: true }],
      open_turns: store.openTurnIds().length, uncertain_turns: store.uncertainTurns().length, mode: 'local',
    };
    return json(res, 200, response);
  }
  if (store?.mode === 'relay') {
    const a = store.assignment(), frame = bridge?.bridge?.currentAssignment() ?? null;
    return json(res, 404, {
      error: 'The cloud relay answers /api/pm/host; open the hosted app to see every machine or move the PM.',
      view: {
        mode: 'relay', connected: a.connected, this_machine_active: a.active, epoch: frame?.epoch ?? null, active_machine: frame?.active_machine ?? null,
        this_machine: identity ? { machine_id: identity.machine_id, name: identity.name } : null,
      },
    });
  }
  return json(res, 404, { error: pm.lastError ?? 'The PM is unavailable on this machine.' });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`foreman: http://localhost:${PORT}`);
  console.log(`foreman: local API token file: ${auth.path}`);
  fleet.start();
  // Every hello lists the PM's open turns, so a socket blip is never reported as a restart.
  bridge = startHostBridge(PORT, auth.token, identity ? { identity, pmOpenTurns: () => store?.openTurnIds() ?? [] } : {});
  // Push notifications only exist in cloud mode; local-only mode constructs no notifier. It starts
  // before the PM is attached, so an uncertain turn reported at activation is a pm_failed edge.
  const notify = bridge.notify?.bind(bridge);
  if (notify) notifier = new Notifier({ sessions, pm, send: notify }).start();
  if (!identity) { pm.failUnavailable(`machine.json is invalid (${identityError})`); return; }
  // Never two PMs: LocalPmStore only when no relay is configured at all (no cloud.json, no relay
  // env). A configured relay that is invalid or did not start means no PM on this machine.
  const choice = choosePmStore(readBridgeConfig, Boolean(bridge.bridge));
  if (choice.mode === 'unavailable') { pm.failUnavailable(choice.reason); return; }
  try {
    // RelayPmStore when the relay is configured (a v2 bridge), else LocalPmStore (pm/state.json).
    store = createPmStore({ identity, bridge: choice.mode === 'relay' ? bridge.bridge! : null });
  } catch (error) {
    const reason = redactSecrets(String((error as Error)?.message ?? error)).slice(0, 300);
    console.error('foreman: PM state store error:', reason);
    pm.failUnavailable(`the PM state store could not be opened (${reason})`);
    return;
  }
  // The PM runs only while this machine is the active PM host. FOREMAN_PM_DISABLED=1 only defers
  // the provider launch to the first message, as before.
  pm.attach(store, { bridge: bridge.bridge ?? null, autoStart: process.env.FOREMAN_PM_DISABLED !== "1" });
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  // Detach the notifier first: closing sessions below marks them unavailable, which is not a failure.
  notifier?.close();
  fleet.stop(); pm.close(); store?.close(); launcher.close(); bridge?.close();
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
