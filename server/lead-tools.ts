// Coordinator Lead tools and a Lead's own tools (epic #157, story CL-05 / #170).
//
// - The Coordinator gets the `leads` MCP server: start_lead, retire_lead, list_leads, read_handoff.
// - Each Lead gets its own `lead` MCP server, bound by the host to the Lead's session key (never a
//   caller-supplied identity): write_handoff, spawn_session, list_workers.
// - `buildLeadRecords` is the pure mapping from session rows to the DO registry's LeadRecord v1.
//
// Everything is coded against the CL-01 contracts in shared/roles.ts (`AgentSessionService`,
// `LeadStore`): the host enforces limits and launch policy inside `launchAgent`; these tools only
// validate input, resolve projects on this machine, compose the seed and surface the result.
// Invariant: nothing written to a handoff or a LeadRecord carries a filesystem path. A project is
// its registered name; the absolute checkout path is used only for the local launch.

import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { boundedReason } from '../shared/pm-state.ts';
import {
  HANDOFF_STATUSES, HELD_LAUNCH_REASON, MAX_GOAL, MAX_HANDOFF_READ, MAX_LEAD_WORKERS, MAX_PENDING_APPROVALS,
  MAX_WORKSTREAM, ROLE_DEFAULTS,
  isAgentPermissionMode, isBypassGrantRef, isEffort, isLeadKey, isModel, isPolicyReason, isProjectName, isSessionName, isSessionState,
  isWorkstream, lastHandoffOf, launchedBy, looksLikeAbsolutePath, normalizeLeadKey, parseLeadHandoff, parseLeadRecord,
  parseRequestedAgentMode, resolveRoleConfig, roleOf, sameProject,
  type AgentLaunchResult, type AgentPermissionMode, type AgentSessionService, type Effort, type Env, type HandoffLink, type LeadHandoff,
  type LeadListEntry, type LeadRecord, type LeadStore, type LeadWorker, type SessionState,
} from '../shared/roles.ts';

// ---------------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------------

/** The slice of server/projects.ts ProjectRegistry these tools use. */
export interface LeadProjects {
  list(): { name: string; aliases: string[]; path: string }[];
  /** Resolves a registered name/alias or an existing absolute directory (throws otherwise). */
  require(reference: string): { path: string };
}

export interface LeadMachine { machine_id: string; name: string }

export interface LeadToolsDeps {
  sessions: AgentSessionService;
  store: LeadStore;
  projects: LeadProjects;
  /** This machine (machine.json). Leads run here (D3: machine-aware contract, no routing yet). */
  machine: LeadMachine;
  /** Env for role config (`FOREMAN_LEAD_MODEL` / `FOREMAN_LEAD_EFFORT`); defaults to process.env. */
  env?: Env;
  /** Called after every handoff this module stores (seed, checkpoint, final), e.g. to refresh the registry row. */
  onHandoff?: (handoff: LeadHandoff) => void;
}

export const OTHER_MACHINE_REFUSED = 'Leads on other machines are not available yet (#162)';
export const LEAD_SERVER_NAME = 'lead';
export const COORDINATOR_LEAD_SERVER_NAME = 'leads';
export const LEAD_TOOL_NAMES = ['write_handoff', 'spawn_session', 'list_workers'] as const;
export const COORDINATOR_LEAD_TOOL_NAMES = ['start_lead', 'retire_lead', 'list_leads', 'read_handoff'] as const;
export const LEAD_ALLOWED_TOOLS = LEAD_TOOL_NAMES.map((name) => `mcp__${LEAD_SERVER_NAME}__${name}`);
export const COORDINATOR_LEAD_ALLOWED_TOOLS = COORDINATOR_LEAD_TOOL_NAMES.map((name) => `mcp__${COORDINATOR_LEAD_SERVER_NAME}__${name}`);

/** Seed/tail bounds (the seed is the new Lead's first message; SessionService caps a message at 64 KiB). */
const MAX_FIRST_TASK_INPUT = 16_000;
const SEED_TAIL_MESSAGES = 10;
const SEED_TAIL_ENTRY_CHARS = 1_500;
const SEED_TAIL_TOTAL_BYTES = 10_000;
const SEED_HANDOFF_BYTES = 28_000;
const SEED_MAX_BYTES = 60_000;

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/** Cuts text to at most `max` UTF-8 bytes without splitting a code point, marking the cut. */
export function clipBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  let out = '', used = 0;
  const limit = Math.max(0, max - 3); // room for the ellipsis
  for (const ch of text) { const n = bytes(ch); if (used + n > limit) break; out += ch; used += n; }
  return out + '…';
}

const ENDED_STATES: readonly string[] = ['ended', 'dead', 'closed'];
/** Worker/listing view: a dead or ended session is no longer live. */
const isEnded = (row: any) => ENDED_STATES.includes(row?.state);
/**
 * Retire view: only `ended` is final. A `dead` Lead (process gone, row not ended) still has to be
 * retired so CL-04 ends it and stamps `superseded_by`.
 */
const isRetired = (row: any) => row?.state === 'ended';
const time = (value: unknown) => { const t = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(t) ? t : 0; };
const byRecent = (a: any, b: any) => time(b.updated_at) - time(a.updated_at);

/**
 * Whether a Lead is mid-turn: `working`, or `needs_input` for a real approval/question. A held
 * Bypass launch (`needs_input` / `awaiting_bypass_approval`) never ran, so it is not busy.
 */
export function leadIsBusy(row: any): boolean {
  if (row?.state === 'working') return true;
  return row?.state === 'needs_input' && row?.reason !== HELD_LAUNCH_REASON;
}

/**
 * Host-side path check for free-text handoff fields (summary, decisions, questions, next steps,
 * goal). shared/roles.ts rejects path-looking project/workstream/labels; this also refuses text
 * that embeds an absolute home or system path, so a handoff synced to the relay never carries one.
 * Deliberately narrow (`~/…`, `X:\…`, `/Users/…`, `/home/…`, `/tmp/…` and similar roots) so API
 * routes like `/api/leads` stay writable.
 */
const EMBEDDED_PATH = /(?:^|[\s"'`(\[<{=:,;])(?:~[\/\\]|[A-Za-z]:[\/\\]|\\\\[^\\\s]|\/(?:Users|home|private|tmp|var|Volumes|mnt|opt|root|srv|work|etc|usr|Library)\/)/;
export function containsFilesystemPath(text: string): boolean {
  return typeof text === 'string' && EMBEDDED_PATH.test(text);
}

function approvalsCount(sessions: AgentSessionService, key: string): number {
  try {
    const direct = (sessions as any).approvals;
    if (typeof direct === 'function') { const list = direct.call(sessions, key); return Array.isArray(list) ? list.length : 0; }
    const detail = sessions.detail(key);
    return Array.isArray(detail?.approvals) ? detail.approvals.length : 0;
  } catch { return 0; }
}

function rowsOf(sessions: AgentSessionService): any[] {
  try { const rows = sessions.list(); return Array.isArray(rows) ? rows : []; } catch { return []; }
}

const parentOf = (row: any): string | null => (isLeadKey(row?.parent) ? normalizeLeadKey(row.parent) : null);
const keyOf = (row: any): string => (isLeadKey(row?.session_key) ? normalizeLeadKey(row.session_key) : String(row?.session_key ?? ''));

function launchSummary(result: AgentLaunchResult) {
  return {
    session_key: result.session_key, name: result.name, status: result.status, permission_mode: result.permission_mode,
    ...(result.bypass_grant ? { bypass_grant: result.bypass_grant } : {}), policy_reason: result.policy_reason,
    ...(result.status === 'awaiting_developer_approval'
      ? { message: 'Held for the developer: they must approve this Bypass launch on their phone ("Launch with Bypass"). Nothing runs until they approve; a denial ends it.' }
      : {}),
  };
}

function modeOf(row: any): AgentPermissionMode | null {
  if (row?.reason === HELD_LAUNCH_REASON) return null;
  return isAgentPermissionMode(row?.permission_mode) ? row.permission_mode : null;
}

// ---------------------------------------------------------------------------------------------
// buildLeadRecords (pure)
// ---------------------------------------------------------------------------------------------

export interface BuildLeadRecordsOptions {
  machine: LeadMachine;
  /** Latest handoff per Lead key (for `goal`, `last_handoff`, and project/workstream fallbacks). */
  handoffs?: ReadonlyMap<string, LeadHandoff> | Readonly<Record<string, LeadHandoff | undefined>>;
  /**
   * Pending approvals per session key (e.g. `(key) => sessions.approvals(key).length`). Absent:
   * a row's numeric `pending_approvals` if it has one, else 0.
   */
  approvals?: (sessionKey: string) => number;
}

function handoffFor(handoffs: BuildLeadRecordsOptions['handoffs'], lead: string): LeadHandoff | undefined {
  if (!handoffs) return undefined;
  if (handoffs instanceof Map) return handoffs.get(lead);
  return (handoffs as Record<string, LeadHandoff | undefined>)[lead];
}

/**
 * Maps session rows to LeadRecord v1 rows for the DO registry: one per Lead row (role `lead`,
 * key `fm:<uuid>`, launched by the developer or the Coordinator), with its workers
 * (`parent` = the Lead), `pending_approvals` counting the Lead and its workers, and per-worker
 * `needs_attention`. Pure. No path field is ever emitted: every record is normalized through
 * `parseLeadRecord`, which drops unknown fields (a row's `cwd`, `transcript_path`, …). Rows that
 * cannot form a valid record (unknown project/workstream) are skipped.
 */
export function buildLeadRecords(rows: readonly any[], options: BuildLeadRecordsOptions): LeadRecord[] {
  const list = Array.isArray(rows) ? rows : [];
  const pending = (row: any): number => {
    const n = options.approvals ? options.approvals(String(row.session_key)) : row.pending_approvals;
    return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0;
  };
  const out: LeadRecord[] = [];
  for (const row of list) {
    if (!row || roleOf(row) !== 'lead' || !isLeadKey(row.session_key)) continue;
    const lead = normalizeLeadKey(row.session_key);
    const by = launchedBy(row);
    if (by !== 'developer' && by !== 'coordinator') continue;
    const handoff = handoffFor(options.handoffs, lead);
    const project = isProjectName(row.project_name) ? row.project_name : handoff?.project;
    const workstream = isWorkstream(row.workstream) ? row.workstream : handoff?.workstream;
    if (!project || !workstream) continue;
    const workerRows = list.filter((w) => w && roleOf(w) === 'worker' && parentOf(w) === lead && isSessionName(w.name));
    // Active workers first, then the most recently updated, capped at the record's worker bound.
    workerRows.sort((a, b) => Number(isEnded(a)) - Number(isEnded(b)) || byRecent(a, b));
    let approvals = pending(row);
    const workers: LeadWorker[] = [];
    for (const w of workerRows) {
      const count = pending(w);
      approvals += count;
      if (workers.length >= MAX_LEAD_WORKERS) continue;
      const state: SessionState = isSessionState(w.state) ? w.state : 'unknown';
      workers.push({ session_key: String(w.session_key), name: w.name, state, permission_mode: modeOf(w), needs_attention: state === 'needs_input' || count > 0 });
    }
    const state: SessionState = isSessionState(row.state) ? row.state : 'unknown';
    const reason = typeof row.end_reason === 'string' && row.end_reason ? row.end_reason
      : (state === 'unknown' || state === 'dead') && typeof row.control_reason === 'string' && row.control_reason ? row.control_reason : undefined;
    const raw: Record<string, unknown> = {
      v: 1, lead, machine_id: options.machine.machine_id, machine_name: options.machine.name,
      name: isSessionName(row.name) ? row.name : `lead-${workstream}`, project, workstream,
      goal: handoff?.goal ?? `Lead for ${workstream}`,
      model: isModel(row.model) ? row.model : ROLE_DEFAULTS.lead.model,
      effort: isEffort(row.effort) ? row.effort : ROLE_DEFAULTS.lead.effort,
      permission_mode: modeOf(row), launched_by: by, state, alive: row.alive === true,
      created_at: time(row.started_at), updated_at: time(row.updated_at) || time(row.started_at),
      pending_approvals: Math.min(approvals, MAX_PENDING_APPROVALS), workers,
      ...(isBypassGrantRef(row.bypass_grant) ? { bypass_grant: row.bypass_grant } : {}),
      ...(isPolicyReason(row.policy_reason) ? { policy_reason: row.policy_reason } : {}),
      ...(reason ? { end_reason: boundedReason(reason) } : {}),
      ...(isLeadKey(row.supersedes) ? { supersedes: row.supersedes } : {}),
      ...(isLeadKey(row.superseded_by) ? { superseded_by: row.superseded_by } : {}),
      ...(handoff ? { last_handoff: lastHandoffOf(handoff) } : {}),
    };
    let parsed = parseLeadRecord(raw);
    // Too large (many long worker names): drop workers from the end until it fits.
    while (!parsed.ok && /exceeds/.test(parsed.error) && workers.length) { workers.pop(); parsed = parseLeadRecord(raw); }
    if (parsed.ok) out.push(parsed.value);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tool schemas (strict: identity and routing fields cannot be smuggled in)
// ---------------------------------------------------------------------------------------------

const leadRef = z.string().min(1).max(300);
const stringList = z.array(z.string()).max(100);
const schemas = {
  start_lead: z.object({
    project: z.string().min(1).max(200),
    workstream: z.string().min(1).max(MAX_WORKSTREAM),
    goal: z.string().min(1).max(MAX_GOAL),
    first_task: z.string().min(1).max(MAX_FIRST_TASK_INPUT),
    permission_mode: z.string().optional(),
    model: z.string().max(200).optional(),
    effort: z.string().optional(),
    supersedes: leadRef.optional(),
    force: z.boolean().optional(),
    machine: z.string().min(1).max(200).optional(),
  }).strict(),
  retire_lead: z.object({ lead: leadRef, force: z.boolean().optional() }).strict(),
  list_leads: z.object({ include_ended: z.boolean().optional() }).strict(),
  read_handoff: z.object({ lead: leadRef, count: z.number().int().min(1).max(MAX_HANDOFF_READ).optional() }).strict(),
};
const leadSchemas = {
  write_handoff: z.object({
    kind: z.enum(['checkpoint', 'final']),
    status: z.enum(HANDOFF_STATUSES),
    summary: z.string(),
    decisions: stringList,
    open_questions: stringList,
    next_steps: stringList,
    links: z.array(z.object({ label: z.string(), url: z.string() }).strict()).max(100),
    goal: z.string().optional(),
    workstream: z.string().optional(),
  }).strict(),
  spawn_session: z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
    prompt: z.string().trim().min(20).max(MAX_FIRST_TASK_INPUT),
    model: z.string().max(200).optional(),
    effort: z.string().optional(),
    permission_mode: z.string().optional(),
    cwd: z.string().min(1).max(4096).optional(),
  }).strict(),
  list_workers: z.object({ include_ended: z.boolean().optional() }).strict(),
};
type CoordinatorTool = keyof typeof schemas;
type LeadTool = keyof typeof leadSchemas;

const descriptions: Record<CoordinatorTool, string> = {
  start_lead: 'Start a Project Lead: a managed Claude session that owns one workstream of one registered project on this machine and delegates implementation to its own worker sessions. `project` is a registered project name (never a path); `workstream` a kebab-case key; `goal` ≤1000 chars; `first_task` the Lead\'s first brief. A Lead already on the same project/workstream (or the one named in `supersedes`) is superseded: the new Lead is seeded with its latest handoff and live workers, and it is retired (if the new Lead is held for the developer\'s approval, only once they approve). A working Lead is refused unless `force: true`. `permission_mode` is bypass or auto (omit for the developer\'s standing policy; native is not available). `model`/`effort` override the Lead role config. The host enforces the Lead limit.',
  retire_lead: 'Retire (end) a Lead on this machine by session key or name. An idle, finished or dead Lead ends now; a working Lead is refused unless force: true. Its workers keep running and its chat stays readable.',
  list_leads: 'List Leads from the registry (all machines): project, workstream, goal, state, permission mode, pending approvals (including workers), workers, latest handoff, and whether the Lead\'s machine is online or reachable from here.',
  read_handoff: 'Read the newest handoffs (1-5, newest first) of a Lead by session key or name, from the registry.',
};
const leadDescriptions: Record<LeadTool, string> = {
  write_handoff: 'Record a structured handoff for your workstream: kind checkpoint (at natural points) or final (before you end). Summarize state, decisions, open questions, next steps, and links (https:// issue/PR URLs or branch:<name>). Never include filesystem paths. The host fills in your identity, project and workers, and returns the stored seq.',
  spawn_session: 'Start a managed Claude worker session for one bounded implementation task. The host stamps it as your worker. State the goal, definition of done, the worktree/branch to use and the checks to run in the prompt. `cwd` is a registered project name or an existing absolute directory (default: your own project). `permission_mode` bypass or auto (omit for the standing policy). The host enforces the per-Lead worker limit.',
  list_workers: 'List your worker sessions with state, permission mode, pending approvals and last message.',
};

// ---------------------------------------------------------------------------------------------
// makeLeadTools
// ---------------------------------------------------------------------------------------------

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const failure = (error: unknown) => ({ content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true });

function zodMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------------
// Retire-on-approval (held supersede)
// ---------------------------------------------------------------------------------------------

/** Bound on the role-config read in start_lead; on timeout it falls back to env/defaults. */
export const ROLE_CONFIG_TIMEOUT_MS = 2_000;

/**
 * Supersedes recorded by `start_lead` when the new Lead's launch was held for the developer.
 * Keyed by the new Lead's session key. Process-local: after a restart `force` is forgotten, which
 * errs on the safe side (a working predecessor is left running and reported).
 */
const heldSupersedes = new Map<string, { supersedes: string; force: boolean }>();

export interface LaunchDecisionEvent { session_key: string; decision: string }

export interface SupersedeOutcome {
  lead: string;
  superseded?: string;
  retired: boolean | 'already ended' | 'not needed';
  reason?: string;
  error?: string;
}

/**
 * CL-06 calls this for every `launch_decision` event (CL-04 emits `{ session_key, decision, ... }`).
 * On `approved` it retires the approved Lead's `supersedes` target with reason
 * `superseded by <new key>`. A working predecessor is interrupted and retired only if the original
 * `start_lead` passed `force`; otherwise it is left running and the outcome says so. On any other
 * decision (denied) nothing is retired and the recorded supersede is dropped.
 */
export async function retireSupersededOnApproval(sessions: AgentSessionService, event: LaunchDecisionEvent): Promise<SupersedeOutcome> {
  const lead = isLeadKey(event?.session_key) ? normalizeLeadKey(event.session_key) : String(event?.session_key ?? '');
  const held = heldSupersedes.get(lead);
  heldSupersedes.delete(lead);
  if (event?.decision !== 'approved') return { lead, retired: 'not needed', reason: `launch ${event?.decision ?? 'not approved'}; the predecessor keeps running` };
  const rows = rowsOf(sessions);
  const self = rows.find((row) => keyOf(row) === lead);
  const target = isLeadKey(self?.supersedes) ? normalizeLeadKey(self.supersedes) : held?.supersedes;
  if (!target) return { lead, retired: 'not needed', reason: 'the approved Lead supersedes no Lead' };
  const old = rows.find((row) => roleOf(row) === 'lead' && keyOf(row) === target);
  if (!old) return { lead, superseded: target, retired: false, reason: 'the superseded Lead is not on this machine' };
  if (isRetired(old)) return { lead, superseded: target, retired: 'already ended' };
  const force = held?.force === true;
  if (leadIsBusy(old) && !force) {
    return { lead, superseded: target, retired: false, reason: `${old.name} (${target}) is working and the request had no force; it was left running. Retire it with retire_lead once it is idle.` };
  }
  try {
    await sessions.retire(target, `superseded by ${lead}`, force ? { force: true } : undefined);
    return { lead, superseded: target, retired: true };
  } catch (error) {
    return { lead, superseded: target, retired: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function makeLeadTools(deps: LeadToolsDeps) {
  const { sessions, store, projects, machine } = deps;
  const env = () => deps.env ?? (process.env as Env);
  const notify = (handoff: LeadHandoff) => { try { deps.onHandoff?.(handoff); } catch { /* an observer never fails the tool */ } };

  const localLeadRows = () => rowsOf(sessions).filter((row) => roleOf(row) === 'lead' && isLeadKey(row.session_key));
  function findLocalLead(ref: string): any | undefined {
    const rows = localLeadRows();
    if (isLeadKey(ref)) return rows.find((row) => keyOf(row) === normalizeLeadKey(ref));
    return rows.filter((row) => row.name === ref).sort(byRecent)[0];
  }
  async function findStoredLead(ref: string): Promise<LeadListEntry | undefined> {
    let entries: LeadListEntry[] = [];
    try { entries = await store.list({ include_ended: true }); } catch { return undefined; }
    if (isLeadKey(ref)) return entries.find((e) => e.lead === normalizeLeadKey(ref));
    return entries.filter((e) => e.name === ref).sort((a, b) => b.updated_at - a.updated_at)[0];
  }
  const isThisMachine = (id: string) => id.toLowerCase() === machine.machine_id.toLowerCase();

  function resolveProject(reference: string): { name: string; path: string } {
    const where = `\`${reference}\` isn't registered on \`${machine.name}\``;
    if (!isProjectName(reference) || looksLikeAbsolutePath(reference)) throw new Error(`${where}. Pass a registered project name, not a path.`);
    const matches = projects.list().filter((p) => sameProject(p.name, reference) || (p.aliases ?? []).some((a) => sameProject(a, reference)));
    if (!matches.length) throw new Error(`${where}. Ask the developer where it lives and register it; never guess a path.`);
    if (matches.length > 1) throw new Error(`\`${reference}\` matches several registered projects on \`${machine.name}\`: ${matches.map((p) => p.name).join(', ')}. Use the exact name.`);
    const project = matches[0];
    // Re-resolve through the registry: validates the directory and its pinned symlink target.
    const path = projects.require(project.path).path;
    return { name: project.name, path };
  }

  async function latestHandoff(lead: string): Promise<LeadHandoff | null> {
    try { return await store.latestHandoff(lead); } catch { return null; }
  }

  function localTail(lead: string): string[] {
    let history: any[] = [];
    try { const detail = sessions.detail(lead); history = Array.isArray(detail?.history) ? detail.history : []; } catch { return []; }
    const entries = history.filter((e) => (e?.role === 'user' || e?.role === 'assistant') && typeof e.text === 'string' && e.text.trim()).slice(-SEED_TAIL_MESSAGES);
    const lines = entries.map((e) => `[${e.role}] ${e.text.length > SEED_TAIL_ENTRY_CHARS ? `…${e.text.slice(-SEED_TAIL_ENTRY_CHARS)}` : e.text}`);
    // Keep the newest messages within the byte budget.
    const kept: string[] = [];
    let used = 0;
    for (const line of lines.reverse()) { const n = bytes(line) + 2; if (used + n > SEED_TAIL_TOTAL_BYTES) break; kept.unshift(line); used += n; }
    return kept;
  }

  function renderHandoff(h: LeadHandoff): string {
    const list = (title: string, items: string[]) => (items.length ? `${title}:\n${items.map((i) => `- ${i}`).join('\n')}` : '');
    return [
      `Handoff seq ${h.seq} (${h.kind}, status ${h.status}, at ${h.at}), project ${h.project}, workstream ${h.workstream}.`,
      `Goal: ${h.goal}`,
      h.summary ? `Summary:\n${h.summary}` : '',
      list('Decisions', h.decisions), list('Open questions', h.open_questions), list('Next steps', h.next_steps),
      list('Links', h.links.map((l) => `${l.label}: ${l.url}`)),
      list('Workers at that time', h.workers.map((w) => `${w.name} (${w.session_key}) ${w.state}`)),
    ].filter(Boolean).join('\n');
  }

  interface Predecessor { key: string; name: string; local: boolean; row?: any; entry?: LeadListEntry }

  async function findPredecessor(input: { supersedes?: string; project: string; workstream: string }): Promise<Predecessor | null> {
    if (input.supersedes) {
      if (!isLeadKey(input.supersedes)) throw new Error('supersedes must be a Lead session key fm:<uuid>');
      const key = normalizeLeadKey(input.supersedes);
      const row = findLocalLead(key);
      if (row) return { key, name: row.name, local: true, row };
      const entry = await findStoredLead(key);
      if (entry) return { key, name: entry.name, local: isThisMachine(entry.machine_id), entry };
      throw new Error(`No Lead ${key} is known on this machine or in the registry`);
    }
    const local = localLeadRows()
      .filter((row) => row.workstream === input.workstream && isProjectName(row.project_name) && sameProject(row.project_name, input.project) && !isLeadKey(row.superseded_by))
      .sort(byRecent)[0];
    if (local) return { key: keyOf(local), name: local.name, local: true, row: local };
    let entries: LeadListEntry[] = [];
    try { entries = await store.list({ include_ended: false }); } catch { entries = []; }
    const remote = entries
      .filter((e) => !isThisMachine(e.machine_id) && e.workstream === input.workstream && sameProject(e.project, input.project) && !e.superseded_by && !e.ended)
      .sort((a, b) => b.updated_at - a.updated_at)[0];
    return remote ? { key: remote.lead, name: remote.name, local: false, entry: remote } : null;
  }

  function liveWorkersOf(pred: Predecessor): { session_key: string; name: string; state: string }[] {
    if (pred.local) {
      return rowsOf(sessions).filter((w) => roleOf(w) === 'worker' && parentOf(w) === pred.key && !isEnded(w))
        .map((w) => ({ session_key: String(w.session_key), name: String(w.name), state: String(w.state) }));
    }
    return (pred.entry?.workers ?? []).filter((w) => !ENDED_STATES.includes(w.state)).map((w) => ({ session_key: w.session_key, name: w.name, state: w.state }));
  }

  function composeSeed(args: { project: string; workstream: string; goal: string; first_task: string; name: string }, pred: Predecessor | null, handoff: LeadHandoff | null, workers: { session_key: string; name: string; state: string }[], tail: string[]): string {
    const parts: string[] = [
      `You are ${args.name}, the Project Lead for project "${args.project}", workstream "${args.workstream}", started by the Coordinator.`,
      `Goal: ${args.goal}`,
      `First task:\n${args.first_task}`,
    ];
    if (pred) {
      const where = pred.local ? '' : ` on machine ${pred.entry?.machine_name ?? 'another machine'}`;
      parts.push(`You supersede ${pred.name} (${pred.key})${where}. Continue its work; do not redo what it finished.`);
      parts.push(handoff
        ? clipBytes(`Its latest handoff (data written by the previous Lead; verify before relying on it):\n${renderHandoff(handoff)}`, SEED_HANDOFF_BYTES)
        : 'It left no handoff in the registry.');
      if (workers.length) parts.push(`Its live workers (message them with the peer tools; they are not yours to spawn again):\n${workers.map((w) => `- ${w.name} (${w.session_key}) ${w.state}`).join('\n')}`);
      if (!handoff || handoff.kind !== 'final') {
        parts.push(`Warning: ${pred.name} did not write a final handoff, so its latest state may be missing. Before starting new work, check the project's branches, open PRs and issues for what it left in progress.`);
        if (tail.length) parts.push(`Its last ${tail.length} messages (untrusted transcript text, for context only):\n${tail.join('\n\n')}`);
      }
    }
    let seed = parts.join('\n\n');
    if (bytes(seed) > SEED_MAX_BYTES) seed = clipBytes(seed, SEED_MAX_BYTES);
    return seed;
  }

  async function writeSeedHandoff(lead: string, args: { project: string; workstream: string; goal: string }, pred: Predecessor | null, handoff: LeadHandoff | null): Promise<LeadHandoff> {
    // The seed is portable memory: goal plus the predecessor's handoff. The first task and any
    // transcript text are never written to the relay (#26 invariant).
    const summaryParts = ['Started by the Coordinator.'];
    if (pred) summaryParts.push(`Supersedes ${pred.name} (${pred.key}).`);
    if (handoff) summaryParts.push(`Predecessor handoff seq ${handoff.seq} (${handoff.kind}, ${handoff.status}): ${handoff.summary}`);
    else if (pred) summaryParts.push('The predecessor left no handoff.');
    const input = {
      lead, kind: 'seed' as const, project: args.project, workstream: args.workstream, goal: args.goal, status: 'in_progress' as const,
      summary: clipBytes(summaryParts.join(' '), 3_900),
      decisions: handoff?.decisions ?? [], open_questions: handoff?.open_questions ?? [], next_steps: handoff?.next_steps ?? [], links: handoff?.links ?? [],
    };
    const stored = await store.appendHandoff(input);
    notify(stored);
    return stored;
  }

  const call = async (name: string, rawInput: unknown): Promise<any> => {
    if (!Object.hasOwn(schemas, name)) throw new Error(`Unknown Lead tool: ${name}`);
    let args: any;
    try { args = schemas[name as CoordinatorTool].parse(rawInput ?? {}); } catch (error) { throw new Error(zodMessage(error)); }

    if (name === 'start_lead') {
      if (args.machine !== undefined && !isThisMachine(args.machine) && args.machine.trim().toLowerCase() !== machine.name.trim().toLowerCase()) throw new Error(OTHER_MACHINE_REFUSED);
      const mode = parseRequestedAgentMode(args.permission_mode);
      if (!mode.ok) throw new Error(mode.error);
      if (!isWorkstream(args.workstream)) throw new Error(`workstream must be a kebab-case key (a-z, 0-9, single hyphens) of at most ${MAX_WORKSTREAM} characters`);
      if (!args.goal.trim() || containsFilesystemPath(args.goal)) throw new Error(`goal must be 1-${MAX_GOAL} characters with no filesystem paths`);
      if (!args.first_task.trim()) throw new Error('first_task must not be blank');
      if (args.model !== undefined && !isModel(args.model)) throw new Error('model must be a model id from list_models');
      if (args.effort !== undefined && !isEffort(args.effort)) throw new Error('effort must be one of low, medium, high, xhigh, max');
      const project = resolveProject(args.project);
      const leadName = `lead-${args.workstream}`;

      const pred = await findPredecessor({ supersedes: args.supersedes, project: project.name, workstream: args.workstream });
      if (pred?.local && pred.row && leadIsBusy(pred.row) && !args.force) {
        throw new Error(`${pred.name} (${pred.key}) is working. Ask it for a final handoff with send_message and try again when it is idle, or pass force: true to interrupt and retire it.`);
      }
      const handoff = pred ? await latestHandoff(pred.key) : null;
      const workers = pred ? liveWorkersOf(pred) : [];
      const tail = pred?.local && (!handoff || handoff.kind !== 'final') ? localTail(pred.key) : [];

      let model = args.model as string | undefined, effort = args.effort as Effort | undefined;
      if (!model || !effort) {
        let dev = null;
        try { dev = (await store.devSettings(ROLE_CONFIG_TIMEOUT_MS))?.settings.roles ?? null; } catch { dev = null; }
        const config = resolveRoleConfig('lead', { dev, env: env() });
        model ??= config.model; effort ??= config.effort;
      }

      const seed = composeSeed({ project: project.name, workstream: args.workstream, goal: args.goal, first_task: args.first_task, name: leadName }, pred, handoff, workers, tail);
      const result = await sessions.launchAgent({
        id: randomUUID(), name: leadName, cwd: project.path, text: seed, provider: 'claude', model, effort,
        role: 'lead', requester_role: 'coordinator', launched_by: 'coordinator', workstream: args.workstream,
        ...(pred ? { supersedes: pred.key } : {}), ...(mode.value ? { requested_mode: mode.value } : {}),
      });
      const lead = normalizeLeadKey(result.session_key);

      const output: Record<string, unknown> = {
        lead, name: result.name, status: result.status, permission_mode: result.permission_mode,
        ...(result.bypass_grant ? { bypass_grant: result.bypass_grant } : {}), policy_reason: result.policy_reason,
        project: project.name, workstream: args.workstream, model, effort, machine: machine.name,
      };
      if (result.status === 'awaiting_developer_approval') output.message = 'Held for the developer: they must approve this Bypass launch on their phone ("Launch with Bypass"). The Lead does not start until they approve; a denial ends it and nothing runs.';
      try { output.seed_handoff = (await writeSeedHandoff(lead, { project: project.name, workstream: args.workstream, goal: args.goal }, pred, handoff)).seq; }
      catch (error) { output.seed_handoff_error = `The Lead started but its seed handoff was not recorded: ${boundedReason(error instanceof Error ? error.message : String(error))}`; }

      if (pred) {
        const superseded: Record<string, unknown> = { lead: pred.key, name: pred.name, latest_handoff: handoff ? { seq: handoff.seq, kind: handoff.kind } : null, live_workers: workers.length };
        if (!pred.local) superseded.note = `${pred.name} is on ${pred.entry?.machine_name ?? 'another machine'}, not reachable from here; it was not retired.`;
        else if (pred.row && isRetired(pred.row)) superseded.retired = 'already ended';
        else if (result.status === 'awaiting_developer_approval') {
          // Held: the developer may deny, so the predecessor keeps running until approval.
          heldSupersedes.set(lead, { supersedes: pred.key, force: args.force === true });
          superseded.retired = 'on approval';
          superseded.note = `${pred.name} keeps running until the developer approves ${result.name}; it is retired then${args.force ? ' (interrupted if still working)' : ' if it is idle'}. If they deny, it is not retired.`;
        } else {
          try { await sessions.retire(pred.key, `superseded by ${lead}`, args.force ? { force: true } : undefined); superseded.retired = true; }
          catch (error) { superseded.retired = false; superseded.error = error instanceof Error ? error.message : String(error); }
        }
        output.superseded = superseded;
        if (superseded.retired === 'on approval') output.message = `${output.message ?? ''} ${pred.name} is not retired yet: it is retired when the developer approves, and keeps running if they deny.`.trim();
      }
      return output;
    }

    if (name === 'retire_lead') {
      const row = findLocalLead(args.lead);
      if (!row) {
        const entry = await findStoredLead(args.lead);
        if (entry && !isThisMachine(entry.machine_id)) throw new Error(`${entry.name} is on ${entry.machine_name}, not reachable from here`);
        throw new Error(`No Lead matches "${args.lead}" on this machine`);
      }
      const key = keyOf(row);
      if (isRetired(row)) return { lead: key, name: row.name, retired: 'already ended' };
      if (leadIsBusy(row) && !args.force) throw new Error(`${row.name} (${key}) is working. Ask it for a final handoff first, or pass force: true to interrupt and retire it.`);
      await sessions.retire(key, 'retired by the Coordinator', args.force ? { force: true } : undefined);
      return { lead: key, name: row.name, retired: true };
    }

    if (name === 'list_leads') {
      const entries = await store.list({ include_ended: args.include_ended === true });
      return {
        machine: machine.name, store: store.mode,
        leads: entries.map((e) => {
          const notes: string[] = [];
          if (!isThisMachine(e.machine_id)) notes.push(`on ${e.machine_name}, not reachable from here`);
          if (!e.machine_online) notes.push(`last known state at ${new Date(e.reported_at).toISOString()}; machine offline; newer handoffs may exist there`);
          return {
            lead: e.lead, name: e.name, project: e.project, workstream: e.workstream, goal: e.goal, state: e.state, alive: e.alive, ended: e.ended,
            machine: e.machine_name, machine_online: e.machine_online, permission_mode: e.permission_mode,
            ...(e.bypass_grant ? { bypass_grant: e.bypass_grant } : {}), ...(e.policy_reason ? { policy_reason: e.policy_reason } : {}),
            model: e.model, effort: e.effort, pending_approvals: e.pending_approvals, workers: e.workers,
            ...(e.last_handoff ? { last_handoff: e.last_handoff } : {}), ...(e.end_reason ? { end_reason: e.end_reason } : {}),
            ...(e.supersedes ? { supersedes: e.supersedes } : {}), ...(e.superseded_by ? { superseded_by: e.superseded_by } : {}),
            updated_at: new Date(e.updated_at).toISOString(), ...(notes.length ? { note: notes.join('; ') } : {}),
          };
        }),
      };
    }

    // read_handoff
    let key: string | undefined;
    if (isLeadKey(args.lead)) key = normalizeLeadKey(args.lead);
    else key = findLocalLead(args.lead) ? keyOf(findLocalLead(args.lead)) : (await findStoredLead(args.lead))?.lead;
    if (!key) throw new Error(`No Lead matches "${args.lead}"`);
    const result = await store.get(key, args.count ?? 1);
    if (!result) throw new Error(`No Lead ${key} in the registry`);
    const notes: string[] = [];
    if (!isThisMachine(result.lead.machine_id)) notes.push(`on ${result.lead.machine_name}, not reachable from here`);
    if (!result.lead.machine_online) notes.push(`last known state at ${new Date(result.lead.reported_at).toISOString()}; machine offline; newer handoffs may exist there`);
    return { lead: key, name: result.lead.name, handoffs: result.handoffs, ...(notes.length ? { note: notes.join('; ') } : {}) };
  };

  /** A Lead's own tools, bound by the host to `leadKey`. */
  function bindLead(leadKey: string) {
    if (!isLeadKey(leadKey)) throw new Error('Lead tools need a Lead session key fm:<uuid>');
    const lead = normalizeLeadKey(leadKey);
    const ownRow = () => localLeadRows().find((row) => keyOf(row) === lead);

    const leadCall = async (name: string, rawInput: unknown): Promise<any> => {
      if (!Object.hasOwn(leadSchemas, name)) throw new Error(`Unknown Lead tool: ${name}`);
      let args: any;
      try { args = leadSchemas[name as LeadTool].parse(rawInput ?? {}); } catch (error) { throw new Error(zodMessage(error)); }

      if (name === 'write_handoff') {
        const row = ownRow();
        const previous = await latestHandoff(lead);
        const project = isProjectName(row?.project_name) ? row.project_name : previous?.project;
        const workstream = args.workstream ?? (isWorkstream(row?.workstream) ? row.workstream : previous?.workstream);
        const goal = args.goal ?? previous?.goal;
        if (!project) throw new Error('Your project is not registered on this machine; the handoff cannot be recorded');
        if (!workstream) throw new Error('workstream is required (a kebab-case key)');
        if (!goal) throw new Error('goal is required for your first handoff');
        const fields = [goal, args.summary, ...args.decisions, ...args.open_questions, ...args.next_steps, ...args.links.map((l: HandoffLink) => l.label)];
        if (fields.some(containsFilesystemPath)) throw new Error('Handoffs must not contain filesystem paths: name projects, branches, issues and PRs instead');
        const input = {
          lead, kind: args.kind as 'checkpoint' | 'final', project, workstream, goal, status: args.status,
          summary: args.summary, decisions: args.decisions, open_questions: args.open_questions, next_steps: args.next_steps,
          links: args.links.map((l: HandoffLink) => ({ label: l.label, url: l.url })),
        };
        // Validate up front (limits, kebab workstream, link urls) so the error names the field.
        const check = parseLeadHandoff({ v: 1, seq: 0, at: new Date().toISOString(), workers: [], ...input });
        if (!check.ok) throw new Error(check.error);
        const stored = await store.appendHandoff(input);
        notify(stored);
        return { seq: stored.seq, at: stored.at, kind: stored.kind, status: stored.status };
      }

      if (name === 'spawn_session') {
        const mode = parseRequestedAgentMode(args.permission_mode);
        if (!mode.ok) throw new Error(mode.error);
        if (args.model !== undefined && !isModel(args.model)) throw new Error('model must be a Claude model id');
        if (args.effort !== undefined && !isEffort(args.effort)) throw new Error('effort must be one of low, medium, high, xhigh, max');
        let cwd: string;
        if (args.cwd !== undefined) cwd = projects.require(args.cwd).path;
        else {
          let own: any;
          try { own = sessions.detail(lead)?.session; } catch { own = ownRow(); }
          if (!own?.cwd) throw new Error('Your own project directory is unknown; pass cwd');
          cwd = own.cwd;
        }
        const result = await sessions.launchAgent({
          id: randomUUID(), name: args.name, cwd, text: args.prompt, provider: 'claude',
          ...(args.model ? { model: args.model } : {}), ...(args.effort ? { effort: args.effort } : {}),
          role: 'worker', requester_role: 'lead', launched_by: lead, parent: lead,
          ...(mode.value ? { requested_mode: mode.value } : {}),
        });
        return launchSummary(result);
      }

      // list_workers
      const workers = rowsOf(sessions).filter((w) => roleOf(w) === 'worker' && parentOf(w) === lead && (args.include_ended || !isEnded(w))).sort(byRecent);
      return {
        workers: workers.map((w) => {
          const count = approvalsCount(sessions, String(w.session_key));
          return {
            session_key: w.session_key, name: w.name, state: w.state, permission_mode: modeOf(w), pending_approvals: count,
            needs_attention: w.state === 'needs_input' || count > 0, updated_at: w.updated_at ?? null,
            ...(w.last_message ? { last_message: String(w.last_message).slice(0, 400) } : {}), ...(w.last_error ? { last_error: String(w.last_error).slice(0, 400) } : {}),
          };
        }),
      };
    };
    return { lead, call: leadCall };
  }

  function mcp<T extends string>(serverName: string, names: readonly T[], table: Record<T, z.ZodObject<any>>, desc: Record<T, string>, invoke: (name: string, input: unknown) => Promise<any>, readOnly: readonly string[]) {
    return createSdkMcpServer({ name: serverName, version: '0.1.0', tools: names.map((name) => tool(
      name, desc[name], table[name].shape,
      async (args: unknown) => { try { return text(await invoke(name, args)); } catch (error) { return failure(error); } },
      { annotations: { readOnlyHint: readOnly.includes(name) } },
    )) });
  }

  return {
    /** The Coordinator's `leads` MCP server. */
    server: mcp(COORDINATOR_LEAD_SERVER_NAME, COORDINATOR_LEAD_TOOL_NAMES, schemas, descriptions, call, ['list_leads', 'read_handoff']),
    allowedTools: COORDINATOR_LEAD_ALLOWED_TOOLS,
    /** Direct call into the Coordinator tools (tests, and non-MCP callers). */
    call,
    /** A Lead's tools bound to its session key. */
    bindLead,
    /** A Lead's `lead` MCP server, bound to its session key by the host. */
    leadServer: (leadKey: string) => {
      const bound = bindLead(leadKey);
      return mcp(LEAD_SERVER_NAME, LEAD_TOOL_NAMES, leadSchemas, leadDescriptions, bound.call, ['list_workers']);
    },
  };
}

export type LeadTools = ReturnType<typeof makeLeadTools>;
