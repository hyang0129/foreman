// Foreman server: static UI + JSON/SSE API over the fleet store and the PM.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { Fleet, transcriptTail } from "./fleet.ts";
import { modelCatalog } from "./models.ts";
import { ProjectManager, choosePmStore } from "./pm.ts";
import { Launcher, relayLaunchDecision } from "./launcher.ts";
import { ProjectRegistry } from "./projects.ts";
import { SessionService, LAUNCH_DECISION_EVENT, type LaunchDecisionEvent } from "./session-service.ts";
import { makeSessionPrep } from "./peer-tools.ts";
import { createLeadStore } from "./lead-store.ts";
import { buildLeadRecords, makeLeadTools, type LeadToolsDeps } from "./lead-tools.ts";
import { GRANT_TIMEOUT_MS, LEADS_ROUTE, SETTINGS_ROUTE, isLeadKey, normalizeLeadKey, roleOf, type HandoffWorker, type LeadHandoff, type LeadRecord, type LeadStore, type LeadsResponse, type SettingsResponse } from "../shared/roles.ts";
import { startHostBridge, readBridgeConfig } from "./host-bridge.ts";
import { Notifier } from "./notifier.ts";
import { runClaude } from "./tools.ts";
import { PORT, REPO_ROOT, ensureDirs, HOST, FOREMAN_HOME, CLAUDE_BIN_CHOICE } from "./paths.ts";
import { claudeVersion, describeClaudeSource } from "./claude-bin.ts";
import { loadMachineIdentity, type MachineIdentity } from "./machine.ts";
import { createPmStore, type HostPmStore } from "./pm-store.ts";
import { redactSecrets } from "../shared/redact.ts";
import { PM_HOST_LOCAL_ONLY_ERROR, type MemoryResponse, type PmHostResponse } from "../shared/pm-state.ts";

import { localAuth } from './local-auth.ts';

ensureDirs();
// #155: the Claude CLI every Claude use runs, and its version, reported by `npm run status`. The path
// is chosen at startup; the version is probed per request, because an updater can repoint the path
// (e.g. the ~/.local/bin/claude symlink) and new sessions then run the new version without a restart.
const claudeCli = async () => ({ path: CLAUDE_BIN_CHOICE.path, source: CLAUDE_BIN_CHOICE.source, source_text: describeClaudeSource(CLAUDE_BIN_CHOICE.source), version: await claudeVersion(CLAUDE_BIN_CHOICE.path) });
const auth = localAuth(FOREMAN_HOME);
// Epic #26: PM memory lives in the PM state store (the relay DO, or pm/state.json in local-only
// mode). The daemon no longer seeds or reads memory/PROJECTS.md or LOG.md; the store imports them once.

const projects = new ProjectRegistry();
// D7: the launcher's propose flow is gone; only its old native identities stay hidden from the fleet.
const launcher = new Launcher({ identityFile: join(FOREMAN_HOME, 'launcher-sessions.json') });
const fleet = new Fleet({ excludeSession: (session) => launcher.ownsSession(session) });
const sessions = new SessionService({ fleet, projects });
// Attached right after construction: held launches that expired on restart are emitted on the next tick.
sessions.on(LAUNCH_DECISION_EVENT, (event: LaunchDecisionEvent) => { void relayLaunchDecision(sessions, event); });
projects.seed(sessions.list());
// Role-aware provider setup. Until the Lead store exists (below) a Lead row is refused with a
// clear error ("Lead tools are unavailable on this host"); every other session gets peer tools.
sessions.setPrepare(makeSessionPrep(sessions));
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
// #122: why this machine runs no PM (no store), so POST /api/pm/host can name the cause.
let pmUnavailable: string | null = null;
function failUnavailable(reason: string) { pmUnavailable = reason; pm.failUnavailable(reason); }
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

// --- Leads (epic #157) ---------------------------------------------------------------------------
// The Lead store (relay DO registry, or this machine's files in local-only mode) exists whenever
// this machine has an identity and a PM store mode, whether or not it is the active Coordinator
// host: Leads left on a standby keep syncing. It is also the GrantSource for agent launches
// (no store: every agent launch runs Auto).
let leadStore: LeadStore | null = null;
// The latest handoff per Lead (fed by the Lead tools, seeded from the store at startup), for
// the registry rows' `last_handoff` and goal.
const latestHandoffs = new Map<string, LeadHandoff>();
// The last row sent per Lead, without `updated_at`: an unchanged row is not re-sent on every
// session change (the periodic resync still refreshes it).
const sentLeadRows = new Map<string, string>();

const managedRows = () => sessions.list().filter((row) => row.managed);
function leadRecords(machine: { machine_id: string; name: string }): LeadRecord[] {
  return buildLeadRecords(managedRows(), { machine, handoffs: latestHandoffs, approvals: (key) => sessions.approvals(key).length });
}
function syncLeadRows(machine: { machine_id: string; name: string }) {
  if (!leadStore) return;
  for (const record of leadRecords(machine)) {
    const { updated_at: _updated, ...rest } = record;
    const signature = JSON.stringify(rest);
    if (sentLeadRows.get(record.lead) === signature) continue;
    sentLeadRows.set(record.lead, signature);
    leadStore.upsert(record);
  }
}
function workersOf(lead: string): HandoffWorker[] {
  return managedRows().filter((row) => roleOf(row) === 'worker' && typeof row.parent === 'string' && normalizeLeadKey(row.parent) === lead && row.name)
    .map((row) => ({ session_key: row.session_key, name: row.name!, state: row.state as HandoffWorker['state'] }));
}

function wireLeads(machineIdentity: MachineIdentity, relayBridge: NonNullable<ReturnType<typeof startHostBridge>['bridge']> | null, localOnly: boolean) {
  const machine = { machine_id: machineIdentity.machine_id, name: machineIdentity.name };
  try {
    leadStore = relayBridge ? createLeadStore({ identity: machineIdentity, bridge: relayBridge, workersOf })
      : localOnly ? createLeadStore({ identity: machineIdentity, workersOf }) : null;
  } catch (error) {
    console.error('foreman: Lead store error:', redactSecrets(String((error as Error)?.message ?? error)).slice(0, 300));
    leadStore = null;
  }
  if (!leadStore) return;
  const store = leadStore;
  sessions.setGrantSource(store);
  const deps: LeadToolsDeps = {
    sessions, store, projects, machine,
    onHandoff: (handoff) => { latestHandoffs.set(handoff.lead, handoff); syncLeadRows(machine); },
  };
  const tools = makeLeadTools(deps);
  sessions.setPrepare(makeSessionPrep(sessions, { leadServer: tools.leadServer }));
  store.track(() => leadRecords(machine));
  sessions.on('change', () => syncLeadRows(machine));
  // Seed each local Lead's latest handoff (from its file or the DO), so a restart keeps last_handoff.
  for (const row of managedRows()) {
    if (roleOf(row) !== 'lead' || !isLeadKey(row.session_key)) continue;
    const key = normalizeLeadKey(row.session_key);
    store.latestHandoff(key).then((handoff) => {
      if (handoff && !latestHandoffs.has(key)) { latestHandoffs.set(key, handoff); syncLeadRows(machine); }
    }, () => {});
  }
  syncLeadRows(machine);
  // The Coordinator's `leads` server is built fresh for each provider start (an SDK MCP server
  // instance serves one connection); the tools share this store and the held-supersede state.
  pm.setLeads({ store, machineId: machine.machine_id, tools: { server: () => makeLeadTools(deps).server } });
}

// GET /api/settings (host-local): the developer's settings, read-only here. Only the hosted app
// changes them (POST /api/settings on the Worker). Local-only mode has none: agent launches use Auto.
async function settingsView(res: ServerResponse) {
  if (!leadStore) return json(res, 503, { error: 'this machine has no Lead registry, so there are no developer settings here; agent launches use Auto.' });
  if (leadStore.mode === 'local') return json(res, 503, { error: 'local-only mode has no developer settings; agent launches use Auto. Connect the cloud relay to use Settings.' });
  const view = await leadStore.devSettings(GRANT_TIMEOUT_MS);
  if (!view) return json(res, 503, { error: 'the cloud relay did not answer; agent launches use Auto until it does.' });
  const response: SettingsResponse = { ...view, writable: false };
  return json(res, 200, response);
}

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
    if (url.pathname === '/api/claude-cli' && req.method === 'GET') return json(res, 200, await claudeCli());
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
    if (url.pathname === LEADS_ROUTE && req.method === 'GET') {
      if (!leadStore) return json(res, 404, { error: 'The Lead registry is unavailable on this machine.' });
      const response: LeadsResponse = { leads: await leadStore.list({ include_ended: true }), mode: leadStore.mode };
      return json(res, 200, response);
    }
    if (url.pathname === SETTINGS_ROUTE && req.method === 'GET') return settingsView(res);
    if (url.pathname === SETTINGS_ROUTE && req.method === 'POST') return json(res, 400, { error: 'Change settings from the hosted app' });
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
    // #122: the model is known before the first PM start (from the store, else the configured default).
    if (url.pathname === "/api/pm/history") return json(res, 200, { history: pm.history(), error: pm.lastError, busy: pm.modelBusy, session_id: pm.sessionId, model: await pm.displayModel() });
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
      // #122: with no PM store (e.g. an invalid relay configuration), name the cause.
      const error = store?.mode === 'relay' ? 'Move the Coordinator from the hosted app; the cloud relay makes that change.'
        : !store && pmUnavailable ? `${PM_HOST_LOCAL_ONLY_ERROR}, which this machine cannot use: ${pmUnavailable}` : PM_HOST_LOCAL_ONLY_ERROR;
      return json(res, 400, { error });
    }
    if (url.pathname === "/api/memory" && req.method === 'GET') {
      if (!store) return json(res, 503, { error: pm.lastError ?? 'Coordinator memory is unavailable on this machine' });
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
  return json(res, 404, { error: pm.lastError ?? 'The Coordinator is unavailable on this machine.' });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`foreman: http://localhost:${PORT}`);
  console.log(`foreman: local API token file: ${auth.path}`);
  void claudeCli().then((cli) => console.log(`foreman: Claude CLI: ${cli.path} (${cli.source_text}), version ${cli.version ?? 'unknown (could not run --version)'}`));
  fleet.start();
  // Every hello lists the PM's open turns, so a socket blip is never reported as a restart.
  bridge = startHostBridge(PORT, auth.token, identity ? { identity, pmOpenTurns: () => store?.openTurnIds() ?? [] } : {});
  // Push notifications only exist in cloud mode; local-only mode constructs no notifier. It starts
  // before the PM is attached, so an uncertain turn reported at activation is a pm_failed edge.
  const notify = bridge.notify?.bind(bridge);
  if (notify) notifier = new Notifier({ sessions, pm, send: notify }).start();
  if (!identity) { failUnavailable(`machine.json is invalid (${identityError})`); return; }
  // Never two PMs: LocalPmStore only when no relay is configured at all (no cloud.json, no relay
  // env). A configured relay that is invalid or did not start means no PM on this machine.
  const choice = choosePmStore(readBridgeConfig, Boolean(bridge.bridge), process.env, bridge.error);
  // The Lead store is created next to the PM store and independently of which machine is the
  // active Coordinator host (relay: the bridge; local-only: this machine's files).
  wireLeads(identity, bridge.bridge ?? null, choice.mode === 'local');
  if (choice.mode === 'unavailable') { failUnavailable(choice.reason); return; }
  try {
    // RelayPmStore when the relay is configured (a v2 bridge), else LocalPmStore (pm/state.json).
    store = createPmStore({ identity, bridge: choice.mode === 'relay' ? bridge.bridge! : null });
  } catch (error) {
    const reason = redactSecrets(String((error as Error)?.message ?? error)).slice(0, 300);
    console.error('foreman: PM state store error:', reason);
    failUnavailable(`the Coordinator state store could not be opened (${reason})`);
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
  fleet.stop(); pm.close(); store?.close(); leadStore?.close(); bridge?.close();
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
