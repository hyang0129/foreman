// Coordinator and Project Lead contracts (epic #157, story CL-01 / #165), shared by the local host
// (server/, Node with --experimental-strip-types) and the relay Durable Object (cloud/, Workers).
// Pure and dependency-free apart from sibling shared modules: no I/O, no `node:` imports, no TS
// enums/namespaces/parameter properties, synchronous everywhere.
//
// Style follows shared/pm-state.ts: `Parsed<T>` results, validators that never throw and return a
// fresh copy on success, sizes measured in UTF-8 bytes of the serialized JSON, and any error or
// reason string that reaches the relay bounded and redacted (`boundedReason`).
//
// Two validation postures:
// - Frame envelopes and op arguments (`lead_rpc`, `POST /api/settings`) are strict: an unexpected
//   key is rejected, as in pm-state.ts.
// - Stored data records (`LeadHandoff`, `LeadRecord`, `LeadListEntry`, dev settings values) are
//   version-tolerant (H5): `v` may be absent (read as 1) or any integer >= 1, every known field is
//   validated, and unknown fields are dropped so a reader accepts records written by newer or
//   older code.
//
// Invariant: no filesystem path is ever carried to or stored by the relay in these records. A
// project is its registered NAME; values that look like absolute paths (`/…`, `~/…`, `X:\…`,
// `\\server\…`) are rejected in `project`, `workstream`, Lead/worker names and link labels. A
// LeadRecord never has a cwd field.

import { isIsoTimestamp, utf8Length } from './notify.ts';
import { boundedReason, isMachineId, isMachineName, isPmId, normalizeMachineId, MAX_REASON, type Parsed } from './pm-state.ts';

export type { Parsed } from './pm-state.ts';

// ---------------------------------------------------------------------------------------------
// 1. Roles
// ---------------------------------------------------------------------------------------------

/** A managed session's role. `session` is today's developer-launched session (the default). */
export const ROLES = ['session', 'lead', 'worker'] as const;
export type Role = typeof ROLES[number];

/** Roles that may request an agent launch (the requester side of the launch policy and grants). */
export const AGENT_ROLES = ['coordinator', 'lead'] as const;
export type AgentRole = typeof AGENT_ROLES[number];

/** Claude effort levels. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof EFFORTS[number];

/** Roles whose model/effort is configurable (`DevSettings.roles`, env, `ROLE_DEFAULTS`). */
export const CONFIG_ROLES = ['coordinator', 'lead', 'investigator'] as const;
export type ConfigRole = typeof CONFIG_ROLES[number];

/** Session states, identical to `State` in server/fleet.ts (duplicated here: shared/ cannot import server/). */
export const SESSION_STATES = ['needs_input', 'working', 'turn_finished', 'idle', 'ended', 'dead', 'unknown'] as const;
export type SessionState = typeof SESSION_STATES[number];

export function isRole(value: unknown): value is Role { return includes(ROLES, value); }
export function isAgentRole(value: unknown): value is AgentRole { return includes(AGENT_ROLES, value); }
export function isEffort(value: unknown): value is Effort { return includes(EFFORTS, value); }
export function isConfigRole(value: unknown): value is ConfigRole { return includes(CONFIG_ROLES, value); }
export function isSessionState(value: unknown): value is SessionState { return includes(SESSION_STATES, value); }

// ---------------------------------------------------------------------------------------------
// 2. Role defaults and resolution (D5)
// ---------------------------------------------------------------------------------------------

export interface RoleConfig { model: string; effort: Effort }

/**
 * D5 defaults. `opus[1m]` is the installed CLI's Opus 5.5 catalog value (`supportedModels()` on
 * CLI 2.1.280); `opus` is the Agent-tool alias used for investigators. The Coordinator's `model`
 * here is only the fallback when `pm_settings.model` is null: the Coordinator's model setting
 * itself stays in `pm_settings.model` and is never part of `DevSettings`.
 */
export const ROLE_DEFAULTS: Readonly<Record<ConfigRole, Readonly<RoleConfig>>> = {
  coordinator: { model: 'opus[1m]', effort: 'medium' },
  lead: { model: 'opus[1m]', effort: 'medium' },
  investigator: { model: 'opus', effort: 'low' },
};

/** Env overrides, per role. The Coordinator has no model env here (its model is `pm_settings.model`). */
export const ROLE_ENV: Readonly<Record<ConfigRole, { model?: string; effort: string }>> = {
  coordinator: { effort: 'FOREMAN_PM_EFFORT' },
  lead: { model: 'FOREMAN_LEAD_MODEL', effort: 'FOREMAN_LEAD_EFFORT' },
  investigator: { model: 'FOREMAN_INVESTIGATOR_MODEL', effort: 'FOREMAN_INVESTIGATOR_EFFORT' },
};

export type Env = Record<string, string | undefined>;

/**
 * Resolves one role's model and effort with precedence DO (`dev.roles`) → env → `ROLE_DEFAULTS`.
 * Each field resolves independently. Invalid values at any level are ignored (fall through).
 * For `coordinator`, `dev.roles.coordinator.model` does not exist and there is no model env: the
 * returned model is the default, which the caller uses only when `pm_settings.model` is null.
 */
export function resolveRoleConfig(role: ConfigRole, sources: { dev?: DevSettings['roles'] | null; env?: Env | null } = {}): RoleConfig {
  const defaults = ROLE_DEFAULTS[role];
  const dev = sources.dev && isPlainObject(sources.dev) ? sources.dev[role] as { model?: unknown; effort?: unknown } | undefined : undefined;
  const env = sources.env ?? {};
  const envModel = ROLE_ENV[role].model ? env[ROLE_ENV[role].model as string] : undefined;
  const envEffort = env[ROLE_ENV[role].effort];
  const devModel = role !== 'coordinator' && dev && isModel(dev.model) ? dev.model : undefined;
  const devEffort = dev && isEffort(dev.effort) ? dev.effort : undefined;
  const envModelOk = typeof envModel === 'string' && isModel(envModel.trim()) ? envModel.trim() : undefined;
  const envEffortOk = typeof envEffort === 'string' && isEffort(envEffort.trim()) ? envEffort.trim() as Effort : undefined;
  return { model: devModel ?? envModelOk ?? defaults.model, effort: devEffort ?? envEffortOk ?? defaults.effort };
}

// ---------------------------------------------------------------------------------------------
// 3. Limits (D4) and bounds
// ---------------------------------------------------------------------------------------------

export interface LeadLimits { maxLeads: number; maxWorkersPerLead: number }
/** D4: at most 3 active Leads and 4 active workers per Lead (held Bypass launches count toward both). */
export const LEAD_LIMITS: Readonly<LeadLimits> = { maxLeads: 3, maxWorkersPerLead: 4 };
export const LEAD_LIMIT_ENV: Readonly<Record<keyof LeadLimits, string>> = { maxLeads: 'FOREMAN_MAX_LEADS', maxWorkersPerLead: 'FOREMAN_MAX_WORKERS_PER_LEAD' };

/** Parses `FOREMAN_MAX_LEADS` / `FOREMAN_MAX_WORKERS_PER_LEAD`: decimal positive integers only; anything else → default. */
export function leadLimits(env: Env | null | undefined): LeadLimits {
  const read = (name: string, fallback: number): number => {
    const raw = env?.[name];
    if (typeof raw !== 'string' || !/^\s*[0-9]{1,6}\s*$/.test(raw)) return fallback;
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n >= 1 ? n : fallback;
  };
  return { maxLeads: read(LEAD_LIMIT_ENV.maxLeads, LEAD_LIMITS.maxLeads), maxWorkersPerLead: read(LEAD_LIMIT_ENV.maxWorkersPerLead, LEAD_LIMITS.maxWorkersPerLead) };
}

/** A LeadHandoff serialized (UTF-8 JSON) is at most 32 KiB. */
export const MAX_HANDOFF_BYTES = 32 * 1024;
/** A LeadRecord serialized is at most 16 KiB. */
export const MAX_LEAD_RECORD_BYTES = 16 * 1024;
/** The DO keeps the newest 20 handoffs per Lead. */
export const MAX_HANDOFFS_KEPT = 20;
/** The DO keeps at most 200 Lead rows; the oldest ended rows are pruned first. */
export const MAX_LEAD_ROWS = 200;
/** `read_handoff` / `lead.get` return at most 5 handoffs. */
export const MAX_HANDOFF_READ = 5;
/** Workers listed on a LeadRecord / LeadHandoff. */
export const MAX_LEAD_WORKERS = 20;
/** `lead.sync` carries at most 50 records (and must still fit in `MAX_LEAD_FRAME`; the host chunks). */
export const MAX_SYNC_RECORDS = 50;
/** `lead.list` limit ceiling. */
export const MAX_LEAD_LIST = MAX_LEAD_ROWS;
/** `bypass_grants` entries. */
export const MAX_BYPASS_GRANTS = 100;
/** How long the host waits for `settings.get` before treating grants as unavailable (→ Auto). */
export const GRANT_TIMEOUT_MS = 5_000;

export const MAX_GOAL = 1000;
export const MAX_SUMMARY = 4000;
export const MAX_LIST_ITEM = 500;
export const MAX_DECISIONS = 30;
export const MAX_OPEN_QUESTIONS = 20;
export const MAX_NEXT_STEPS = 20;
export const MAX_LINKS = 30;
export const MAX_LINK_LABEL = 200;
export const MAX_LINK_URL = 2048;
export const MAX_BRANCH = 200;
/** Registered project names (server/projects.ts `label`: 1–200 chars, trimmed). */
export const MAX_PROJECT = 200;
/** Workstream keys are kebab-case, at most 64 chars. */
export const MAX_WORKSTREAM = 64;
/** Session display names (server/session-service.ts: ≤200). */
export const MAX_SESSION_NAME = 200;
/** Session keys (`fm:<uuid>`, `<provider>:<id>`): printable ASCII, ≤300 (shared/notify.ts). */
export const MAX_SESSION_KEY = 300;
/** `LeadRecord.last_handoff.summary` is a ≤500-char excerpt. */
export const MAX_LAST_HANDOFF_SUMMARY = 500;
/** `pending_approvals` count ceiling. */
export const MAX_PENDING_APPROVALS = 10_000;
/** `LaunchApprovalInput.first_task` is truncated to 2000 chars for the card. */
export const MAX_FIRST_TASK = 2000;
/** Approval ids in `approved:<id>` grants. */
export const MAX_APPROVAL_ID = 200;

// ---------------------------------------------------------------------------------------------
// Shared validator plumbing (pm-state.ts style; its helpers are module-private there)
// ---------------------------------------------------------------------------------------------

const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/; // server/models.ts normalizeModel
const SESSION_KEY_PATTERN = /^[\x21-\x7e]{1,300}$/;                // shared/notify.ts
const LEAD_KEY_PATTERN = /^fm:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKSTREAM_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const APPROVAL_ID_PATTERN = /^[\x21-\x7e]{1,200}$/;
// Single-line fields: no control characters at all. Multi-line fields: newline, CR and tab allowed.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
// `/…`, `~`, `~/…`, `~\…`, `X:\…`, `X:/…`, `\\server\…`.
const ABSOLUTE_PATH = /^\s*(?:[\/\\]|~(?:[\/\\]|\s*$)|[A-Za-z]:[\/\\])/;
const HTTPS_URL = /^https:\/\/[^\s\/?#@]+(?:[\/?#][^\s]*)?$/;
const BRANCH_LINK = /^branch:([A-Za-z0-9._\/-]{1,200})$/;

function includes<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) return key;
  return null;
}

function fail<T>(error: string): Parsed<T> { return { ok: false, error }; }

function serializedBytes(value: unknown): number {
  return utf8Length(JSON.stringify(value));
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Epoch milliseconds (non-negative safe integer). */
export function isEpochMs(value: unknown): value is number { return isNonNegativeInt(value); }

/** Record versions: absent → 1; otherwise any safe integer >= 1 (H5: readers accept other versions). */
function recordVersion(raw: Record<string, unknown>): boolean {
  return raw.v === undefined || (typeof raw.v === 'number' && Number.isSafeInteger(raw.v) && raw.v >= 1);
}

/** Bounded single-line text: 1..max chars, not blank, no control characters. */
function isLine(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max && value.trim().length > 0 && !CONTROL.test(value);
}

/** Bounded multi-line text: 0..max chars (or 1..max when `nonBlank`), controls other than \n \r \t rejected. */
function isText(value: unknown, max: number, nonBlank: boolean): value is string {
  return typeof value === 'string' && value.length <= max && (!nonBlank || value.trim().length > 0) && !CONTROL_MULTILINE.test(value);
}

/** True for a value that looks like an absolute filesystem path (`/…`, `~/…`, `X:\…`, `\\…`). */
export function looksLikeAbsolutePath(value: unknown): boolean {
  return typeof value === 'string' && ABSOLUTE_PATH.test(value);
}

/** A model id, same shape as server/models.ts `normalizeModel`. */
export function isModel(value: unknown): value is string {
  return typeof value === 'string' && MODEL_PATTERN.test(value);
}

/** Any session key: printable ASCII, 1–300 chars. */
export function isSessionKey(value: unknown): value is string {
  return typeof value === 'string' && SESSION_KEY_PATTERN.test(value);
}

/** A Lead's session key: `fm:<uuid v4>` (either case; `normalizeLeadKey` lowercases it). */
export function isLeadKey(value: unknown): value is string {
  return typeof value === 'string' && LEAD_KEY_PATTERN.test(value);
}

export function normalizeLeadKey(value: string): string { return value.toLowerCase(); }

/** A registered project NAME: 1–200 chars, single line, not blank, not path-looking. */
export function isProjectName(value: unknown): value is string {
  return isLine(value, MAX_PROJECT) && !looksLikeAbsolutePath(value);
}

/** A workstream key: kebab-case `[a-z0-9]+(-[a-z0-9]+)*`, at most 64 chars (never a path). */
export function isWorkstream(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_WORKSTREAM && WORKSTREAM_PATTERN.test(value);
}

/** Slugifies free text into a workstream key, or returns null when nothing usable remains. */
export function workstreamKey(text: string): string | null {
  if (typeof text !== 'string') return null;
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_WORKSTREAM).replace(/-+$/g, '');
  return isWorkstream(slug) ? slug : null;
}

/** A session display name: 1–200 chars, single line, not blank, not path-looking. */
export function isSessionName(value: unknown): value is string {
  return isLine(value, MAX_SESSION_NAME) && !looksLikeAbsolutePath(value);
}

/**
 * Project-name comparison used for grant matching and project references: trimmed, case- and
 * whitespace-insensitive, and a leading "the " is ignored, exactly like the registry's `key()` in
 * server/projects.ts ("The Foreman" names the same project as "foreman").
 */
export function sameProject(a: string, b: string): boolean {
  const key = (s: string) => s.trim().toLocaleLowerCase().replace(/^the\s+/, '').replace(/\s+/g, ' ');
  return key(a) === key(b);
}

/**
 * The pre-#197 comparison (no "the " stripping). Used only for the duplicate check on grant lists,
 * so every list accepted before still parses (a list holding both "foreman" and "the foreman"
 * stays valid; `matchBypassGrant` resolves that pair toward the lower privilege).
 */
function sameProjectLegacy(a: string, b: string): boolean {
  const key = (s: string) => s.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  return key(a) === key(b);
}

// ---------------------------------------------------------------------------------------------
// 13. Policy reasons (declared early: used by 4 and 5)
// ---------------------------------------------------------------------------------------------

export const POLICY_REASONS = ['requested_auto', 'grant_unavailable', 'grant_off', 'ask_before_bypass', 'standing_grant', 'approved'] as const;
/**
 * Why an agent launch got its policy:
 * - `requested_auto`: the requesting agent asked for Auto.
 * - `grant_unavailable`: settings could not be read (DO unreachable within 5 s, or local-only) → Auto.
 * - `grant_off`: the standing grant for (role, project) is off → Auto.
 * - `ask_before_bypass`: grant on but `bypass_ask` is set → held launch (approval card).
 * - `standing_grant`: grant on → Bypass.
 * - `approved`: a held launch the developer approved → Bypass.
 */
export type PolicyReason = typeof POLICY_REASONS[number];
export function isPolicyReason(value: unknown): value is PolicyReason { return includes(POLICY_REASONS, value); }

// ---------------------------------------------------------------------------------------------
// 4. Session role fields (additive on SessionRow / RecordData.creation)
// ---------------------------------------------------------------------------------------------

/** Who launched a session: the developer, the Coordinator, or a Lead (its session key `fm:<uuid>`). */
export type LaunchedBy = 'developer' | 'coordinator' | string;

/**
 * `standing:<role>/<project|*>` (the matching grant entry) or `approved:<approval id>` (a held
 * launch the developer approved).
 */
export type BypassGrantRef = string;

/**
 * Additive, persisted role fields. Every field is optional: records written before this epic read
 * as `role: 'session'`, `launched_by: 'developer'` (use `roleOf` / `launchedBy`).
 */
export interface SessionRoleFields {
  role?: Role;
  launched_by?: LaunchedBy;
  /** Session key of the parent (a worker's Lead). */
  parent?: string;
  /** Session key of the Lead this one replaced. */
  supersedes?: string;
  /** Session key of the Lead that replaced this one. */
  superseded_by?: string;
  /** Kebab workstream key (Leads). */
  workstream?: string;
  effort?: Effort;
  bypass_grant?: BypassGrantRef;
  policy_reason?: PolicyReason;
}

/** `launched_by` values: `developer`, `coordinator`, or a Lead session key. */
export function isLaunchedBy(value: unknown): value is LaunchedBy {
  return value === 'developer' || value === 'coordinator' || isLeadKey(value);
}

/** A session's role, defaulting to `session` for old records (or any invalid value). */
export function roleOf(row: { role?: unknown } | null | undefined): Role {
  const role = row && typeof row === 'object' ? row.role : undefined;
  return isRole(role) ? role : 'session';
}

/** Who launched a session, defaulting to `developer` for old records (or any invalid value). */
export function launchedBy(row: { launched_by?: unknown } | null | undefined): LaunchedBy {
  const by = row && typeof row === 'object' ? row.launched_by : undefined;
  return isLaunchedBy(by) ? (isLeadKey(by) ? normalizeLeadKey(by) : by) : 'developer';
}

/** `standing:<role>/<project|*>` or `approved:<id>`. */
export function isBypassGrantRef(value: unknown): value is BypassGrantRef {
  if (typeof value !== 'string' || value.length > 16 + MAX_PROJECT + MAX_APPROVAL_ID) return false;
  if (value.startsWith('approved:')) return APPROVAL_ID_PATTERN.test(value.slice('approved:'.length));
  const m = /^standing:(coordinator|lead)\/(.+)$/.exec(value);
  return !!m && (m[2] === '*' || isProjectName(m[2]));
}

export function standingGrantRef(role: AgentRole, project: string): BypassGrantRef { return `standing:${role}/${project}`; }
export function approvedGrantRef(approvalId: string): BypassGrantRef { return `approved:${approvalId}`; }

// ---------------------------------------------------------------------------------------------
// 5. Agent-launch permission policy (S1, D6)
// ---------------------------------------------------------------------------------------------

/**
 * Modes an agent-launched session may run in. Agents never launch `native` (Native stays for
 * sessions the developer starts by hand). `auto` is Claude-only (D6: unsupported for Codex).
 */
export const AGENT_PERMISSION_MODES = ['bypass', 'auto'] as const;
export type AgentPermissionMode = typeof AGENT_PERMISSION_MODES[number];
export function isAgentPermissionMode(value: unknown): value is AgentPermissionMode { return includes(AGENT_PERMISSION_MODES, value); }

/** Providers that support `auto` (D6). */
export const AUTO_PROVIDERS = ['claude'] as const;

export const AGENT_NATIVE_REFUSED = 'Agents cannot launch Native sessions: request bypass or auto (or omit the mode for the standing policy)';
export const AUTO_UNSUPPORTED = 'Auto permission mode is supported for Claude sessions only';

/** Whether `provider` can run an agent session in `mode`. */
export function agentModeSupported(provider: string, mode: AgentPermissionMode): boolean {
  // Agent launches are Claude only (`AgentLaunchRequest.provider`), in either mode.
  return mode === 'bypass' ? provider === 'claude' : (AUTO_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Validates an agent's requested mode. Absent (`undefined`/`null`/`''`) → `undefined` (use the
 * standing policy). `native` is refused with `AGENT_NATIVE_REFUSED`; anything else is invalid.
 */
export function parseRequestedAgentMode(value: unknown): Parsed<AgentPermissionMode | undefined> {
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
  if (value === 'native') return fail(AGENT_NATIVE_REFUSED);
  if (isAgentPermissionMode(value)) return { ok: true, value };
  return fail('permission_mode must be bypass or auto');
}

export interface AgentLaunchPolicyInput {
  requesterRole: AgentRole;
  /** Registered project name, or null when the launch target is not a registered project. */
  project: string | null;
  requested?: AgentPermissionMode;
  /** Effective settings (`effectiveDevSettings`), or null when unavailable (DO unreachable within 5 s, or local-only). */
  settings: DevSettings | null;
}

export type AgentLaunchDecision = 'bypass' | 'auto' | 'hold';

export interface AgentLaunchPolicy {
  /** `hold` = held launch awaiting the developer's approval card; it never runs until approved. */
  decision: AgentLaunchDecision;
  /** Present only when `decision === 'bypass'`. */
  bypass_grant?: BypassGrantRef;
  policy_reason: PolicyReason;
}

/**
 * The grant entry that applies to (role, project): an entry for this exact project beats the
 * role's `'*'` entry; no matching entry → null (grant off). With `project === null`, only `'*'`
 * applies. When several project entries name the same project (possible only for a list holding
 * both "foreman" and "the foreman"), an `allow: false` entry wins: ambiguity never resolves
 * toward Bypass.
 */
export function matchBypassGrant(grants: readonly BypassGrant[], role: AgentRole, project: string | null): BypassGrant | null {
  let wildcard: BypassGrant | null = null;
  let specific: BypassGrant | null = null;
  for (const grant of grants) {
    if (grant.role !== role) continue;
    if (grant.project === '*') { wildcard ??= grant; continue; }
    if (project !== null && sameProject(grant.project, project)) {
      if (grant.allow !== true) return grant;
      specific ??= grant;
    }
  }
  return specific ?? wildcard;
}

/**
 * Pure launch-policy decision for an agent-launched session:
 * 1. `requested === 'auto'` → Auto (`requested_auto`).
 * 2. settings null → Auto (`grant_unavailable`): fail to the lower-privilege mode, never to Bypass
 *    and never to a card.
 * 3. grant for (requesterRole, project) off or absent → Auto (`grant_off`).
 * 4. grant on and `bypass_ask` → hold (`ask_before_bypass`).
 * 5. grant on → Bypass with `bypass_grant: 'standing:<role>/<project|*>'` (`standing_grant`).
 * An approved held launch uses `approvedLaunchPolicy`. Nothing ever resolves to Native: a
 * `requested` of `native` (or anything unknown) throws `AGENT_NATIVE_REFUSED` / a TypeError, so
 * callers must validate with `parseRequestedAgentMode` first.
 */
export function resolveAgentLaunchPolicy(input: AgentLaunchPolicyInput): AgentLaunchPolicy {
  const { requesterRole, project, requested, settings } = input;
  if ((requested as unknown) === 'native') throw new Error(AGENT_NATIVE_REFUSED);
  if (requested !== undefined && !isAgentPermissionMode(requested)) throw new TypeError('requested must be bypass, auto or undefined');
  if (!isAgentRole(requesterRole)) throw new TypeError('requesterRole must be coordinator or lead');
  if (requested === 'auto') return { decision: 'auto', policy_reason: 'requested_auto' };
  if (settings === null || settings === undefined) return { decision: 'auto', policy_reason: 'grant_unavailable' };
  const grant = matchBypassGrant(Array.isArray(settings.bypass_grants) ? settings.bypass_grants : [], requesterRole, project);
  if (!grant || grant.allow !== true) return { decision: 'auto', policy_reason: 'grant_off' };
  if (settings.bypass_ask === true) return { decision: 'hold', policy_reason: 'ask_before_bypass' };
  return { decision: 'bypass', bypass_grant: standingGrantRef(requesterRole, grant.project), policy_reason: 'standing_grant' };
}

/** The policy of a held launch the developer approved: Bypass, `approved:<approval id>`. */
export function approvedLaunchPolicy(approvalId: string): AgentLaunchPolicy & { decision: 'bypass'; bypass_grant: BypassGrantRef } {
  return { decision: 'bypass', bypass_grant: approvedGrantRef(approvalId), policy_reason: 'approved' };
}

// ---------------------------------------------------------------------------------------------
// 6. Developer settings (H1: keys validated here, no DB CHECK)
// ---------------------------------------------------------------------------------------------

export const DEV_SETTING_KEYS = ['roles', 'bypass_grants', 'bypass_ask'] as const;
export type DevSettingKey = typeof DEV_SETTING_KEYS[number];
export function isDevSettingKey(value: unknown): value is DevSettingKey { return includes(DEV_SETTING_KEYS, value); }

/**
 * One standing Bypass grant entry. `project` is a registered project name or `'*'` (every
 * project). `allow: false` turns the grant off for that scope; the most specific entry wins.
 */
export interface BypassGrant { role: AgentRole; project: string; allow: boolean }

export interface RoleSettings {
  /** The Coordinator's model is `pm_settings.model`, not here. */
  coordinator?: { effort?: Effort };
  lead?: { model?: string; effort?: Effort };
  investigator?: { model?: string; effort?: Effort };
}

export interface DevSettings {
  roles: RoleSettings;
  bypass_grants: BypassGrant[];
  /** "Ask me before each Bypass launch": grant-on launches are held for an approval card. */
  bypass_ask: boolean;
}

/** S1: the standing grant is on by default for the Coordinator and Lead roles on every project. */
export const DEFAULT_BYPASS_GRANTS: readonly Readonly<BypassGrant>[] = [
  { role: 'coordinator', project: '*', allow: true },
  { role: 'lead', project: '*', allow: true },
];

/** Values used for a key that was never written. */
export function defaultDevSettings(): DevSettings {
  return { roles: {}, bypass_grants: DEFAULT_BYPASS_GRANTS.map((g) => ({ ...g })), bypass_ask: false };
}

function parseRoleSettings(raw: unknown): Parsed<RoleSettings> {
  if (!isPlainObject(raw)) return fail('roles must be an object');
  const out: RoleSettings = {};
  for (const role of CONFIG_ROLES) {
    const entry = raw[role];
    if (entry === undefined) continue;
    if (!isPlainObject(entry)) return fail(`roles.${role} must be an object`);
    const value: { model?: string; effort?: Effort } = {};
    if (entry.model !== undefined) {
      if (role === 'coordinator') return fail('roles.coordinator.model is not a setting: the Coordinator model is pm_settings.model');
      if (!isModel(entry.model)) return fail(`roles.${role}.model must be a model id`);
      value.model = entry.model;
    }
    if (entry.effort !== undefined) {
      if (!isEffort(entry.effort)) return fail(`roles.${role}.effort must be one of ${EFFORTS.join(', ')}`);
      value.effort = entry.effort;
    }
    (out as Record<string, unknown>)[role] = value;
  }
  return { ok: true, value: out };
}

function parseBypassGrants(raw: unknown): Parsed<BypassGrant[]> {
  if (!Array.isArray(raw)) return fail('bypass_grants must be an array');
  if (raw.length > MAX_BYPASS_GRANTS) return fail(`bypass_grants must have at most ${MAX_BYPASS_GRANTS} entries`);
  const out: BypassGrant[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) return fail('each bypass grant must be an object');
    if (!isAgentRole(entry.role)) return fail('bypass grant role must be coordinator or lead');
    if (entry.project !== '*' && !isProjectName(entry.project)) return fail("bypass grant project must be a registered project name or '*'");
    if (typeof entry.allow !== 'boolean') return fail('bypass grant allow must be a boolean');
    const project = entry.project === '*' ? '*' : (entry.project as string).trim();
    if (out.some((g) => g.role === entry.role && (g.project === '*' ? project === '*' : project !== '*' && sameProjectLegacy(g.project, project)))) return fail('duplicate bypass grant for the same role and project');
    out.push({ role: entry.role, project, allow: entry.allow });
  }
  return { ok: true, value: out };
}

/** Validates one setting value by key. Never throws; returns a fresh copy. Unknown nested fields are dropped. */
export function parseDevSetting<K extends DevSettingKey>(key: K, value: unknown): Parsed<DevSettings[K]> {
  try {
    switch (key as DevSettingKey) {
      case 'roles': return parseRoleSettings(value) as Parsed<DevSettings[K]>;
      case 'bypass_grants': return parseBypassGrants(value) as Parsed<DevSettings[K]>;
      case 'bypass_ask':
        if (typeof value !== 'boolean') return fail('bypass_ask must be a boolean');
        return { ok: true, value: value as DevSettings[K] };
      default: return fail('unknown setting');
    }
  } catch { return fail('invalid setting'); }
}

/**
 * Applies defaults to stored settings. A key that was never written takes its default (grant on
 * for coordinator and lead on `'*'`, `bypass_ask` false, no role overrides). A stored value that
 * fails validation fails toward LOWER privilege: `bypass_grants` → `[]` (grant off → Auto),
 * `bypass_ask` → `true` (hold), `roles` → `{}`.
 */
export function effectiveDevSettings(stored: Partial<Record<DevSettingKey, unknown>> | null | undefined): DevSettings {
  const out = defaultDevSettings();
  const s = isPlainObject(stored) ? stored : {};
  if (s.roles !== undefined) { const r = parseDevSetting('roles', s.roles); out.roles = r.ok ? r.value : {}; }
  if (s.bypass_grants !== undefined) { const r = parseDevSetting('bypass_grants', s.bypass_grants); out.bypass_grants = r.ok ? r.value : []; }
  if (s.bypass_ask !== undefined) { const r = parseDevSetting('bypass_ask', s.bypass_ask); out.bypass_ask = r.ok ? r.value : true; }
  return out;
}

/**
 * Settings as served by `settings.get` and `GET /api/settings`: effective values, a per-key
 * version (0 = never written; bumped on every write, used for optimistic concurrency on POST) and
 * the last write time (epoch ms) or null.
 */
export interface DevSettingsView { settings: DevSettings; versions: Record<DevSettingKey, number>; updated_at: number | null }

export function parseDevSettingsView(raw: unknown): Parsed<DevSettingsView> {
  try {
    if (!isPlainObject(raw)) return fail('settings view must be an object');
    if (!isPlainObject(raw.settings)) return fail('settings must be an object');
    const settings = {} as DevSettings;
    for (const key of DEV_SETTING_KEYS) {
      const r = parseDevSetting(key, raw.settings[key]);
      if (!r.ok) return fail(r.error);
      (settings as unknown as Record<string, unknown>)[key] = r.value;
    }
    if (!isPlainObject(raw.versions)) return fail('versions must be an object');
    const versions = {} as Record<DevSettingKey, number>;
    for (const key of DEV_SETTING_KEYS) {
      if (!isNonNegativeInt(raw.versions[key])) return fail(`versions.${key} must be a non-negative integer`);
      versions[key] = raw.versions[key] as number;
    }
    if (raw.updated_at !== null && !isEpochMs(raw.updated_at)) return fail('updated_at must be epoch milliseconds or null');
    return { ok: true, value: { settings, versions, updated_at: raw.updated_at as number | null } };
  } catch { return fail('invalid settings view'); }
}

// ---------------------------------------------------------------------------------------------
// 7. LeadHandoff (H5: v 1)
// ---------------------------------------------------------------------------------------------

export const LEAD_HANDOFF_VERSION = 1;
export const HANDOFF_KINDS = ['seed', 'checkpoint', 'final'] as const;
export type HandoffKind = typeof HANDOFF_KINDS[number];
export const HANDOFF_STATUSES = ['in_progress', 'blocked', 'waiting_on_developer', 'done', 'abandoned'] as const;
export type HandoffStatus = typeof HANDOFF_STATUSES[number];

/** A link: `url` is `https://…` or `branch:<name>`; `label` is single-line text, never a path. */
export interface HandoffLink { label: string; url: string }
/** A worker as listed in a handoff (filled in by the host, not the model). */
export interface HandoffWorker { session_key: string; name: string; state: SessionState }

/**
 * A Lead's structured handoff, ≤ 32 KiB serialized. Written by the host (`seed`) and by the Lead's
 * `write_handoff` tool (`checkpoint`, `final`); stored first on the Lead's machine, then synced to
 * the DO (dedup by `(lead, seq)`).
 */
export interface LeadHandoff {
  /** Always 1 on a parsed value (the reader's view); readers accept stored `v` absent or ≥ 1. */
  v: 1;
  /** Lead session key `fm:<uuid>` (lowercased). */
  lead: string;
  /** Per Lead, host-assigned, monotonic. */
  seq: number;
  /** ISO timestamp. */
  at: string;
  kind: HandoffKind;
  /** Registered project NAME, never a path. */
  project: string;
  /** Kebab workstream key. */
  workstream: string;
  goal: string;
  status: HandoffStatus;
  summary: string;
  decisions: string[];
  open_questions: string[];
  next_steps: string[];
  links: HandoffLink[];
  workers: HandoffWorker[];
}

/** `https://<host>…` (no whitespace, ≤2048) or `branch:<name>` (git-ref characters, no `..`, no leading `-`/`/`). */
export function isHandoffLinkUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_LINK_URL || CONTROL.test(value)) return false;
  if (HTTPS_URL.test(value)) return true;
  const m = BRANCH_LINK.exec(value);
  return !!m && !m[1].includes('..') && !/^[-\/]/.test(m[1]) && !m[1].endsWith('/') && !m[1].endsWith('.lock');
}

function parseStringList(raw: unknown, field: string, maxItems: number): Parsed<string[]> {
  if (!Array.isArray(raw) || raw.length > maxItems) return fail(`${field} must be an array of at most ${maxItems} items`);
  for (const item of raw) if (!isText(item, MAX_LIST_ITEM, true)) return fail(`${field} items must be 1-${MAX_LIST_ITEM} characters`);
  return { ok: true, value: [...raw as string[]] };
}

function parseWorkerList(raw: unknown): Parsed<HandoffWorker[]> {
  if (!Array.isArray(raw) || raw.length > MAX_LEAD_WORKERS) return fail(`workers must be an array of at most ${MAX_LEAD_WORKERS} entries`);
  const out: HandoffWorker[] = [];
  for (const w of raw) {
    if (!isPlainObject(w)) return fail('each worker must be an object');
    if (!isSessionKey(w.session_key)) return fail('worker session_key is invalid');
    if (!isSessionName(w.name)) return fail('worker name must be 1-200 printable characters and not a path');
    if (!isSessionState(w.state)) return fail('worker state is invalid');
    out.push({ session_key: w.session_key, name: w.name, state: w.state });
  }
  return { ok: true, value: out };
}

/**
 * Validates a LeadHandoff. Accepts `v` absent or any integer ≥ 1, validates the known fields,
 * drops unknown ones, and rejects path-looking `project` / `workstream` / `links[].label`. The
 * normalized value must serialize to ≤ 32 KiB.
 */
export function parseLeadHandoff(raw: unknown): Parsed<LeadHandoff> {
  try {
    if (!isPlainObject(raw)) return fail('handoff must be an object');
    if (!recordVersion(raw)) return fail('v must be an integer >= 1');
    if (!isLeadKey(raw.lead)) return fail('lead must be a Lead session key fm:<uuid>');
    if (!isNonNegativeInt(raw.seq)) return fail('seq must be a non-negative integer');
    if (!isIsoTimestamp(raw.at)) return fail('at must be an ISO timestamp');
    if (!includes(HANDOFF_KINDS, raw.kind)) return fail('kind must be seed, checkpoint or final');
    if (!isProjectName(raw.project)) return fail('project must be a registered project name, not a path');
    if (!isWorkstream(raw.workstream)) return fail(`workstream must be a kebab-case key of at most ${MAX_WORKSTREAM} characters`);
    if (!isText(raw.goal, MAX_GOAL, true)) return fail(`goal must be 1-${MAX_GOAL} characters`);
    if (!includes(HANDOFF_STATUSES, raw.status)) return fail('invalid status');
    if (!isText(raw.summary, MAX_SUMMARY, false)) return fail(`summary must be at most ${MAX_SUMMARY} characters`);
    const decisions = parseStringList(raw.decisions, 'decisions', MAX_DECISIONS); if (!decisions.ok) return fail(decisions.error);
    const open_questions = parseStringList(raw.open_questions, 'open_questions', MAX_OPEN_QUESTIONS); if (!open_questions.ok) return fail(open_questions.error);
    const next_steps = parseStringList(raw.next_steps, 'next_steps', MAX_NEXT_STEPS); if (!next_steps.ok) return fail(next_steps.error);
    if (!Array.isArray(raw.links) || raw.links.length > MAX_LINKS) return fail(`links must be an array of at most ${MAX_LINKS} entries`);
    const links: HandoffLink[] = [];
    for (const link of raw.links) {
      if (!isPlainObject(link)) return fail('each link must be an object');
      if (!isLine(link.label, MAX_LINK_LABEL) || looksLikeAbsolutePath(link.label)) return fail(`link label must be 1-${MAX_LINK_LABEL} printable characters and not a path`);
      if (!isHandoffLinkUrl(link.url)) return fail('link url must be https://… or branch:<name>');
      links.push({ label: link.label, url: link.url });
    }
    const workers = parseWorkerList(raw.workers); if (!workers.ok) return fail(workers.error);
    const value: LeadHandoff = {
      v: 1, lead: normalizeLeadKey(raw.lead), seq: raw.seq, at: raw.at, kind: raw.kind, project: raw.project, workstream: raw.workstream,
      goal: raw.goal, status: raw.status, summary: raw.summary, decisions: decisions.value, open_questions: open_questions.value,
      next_steps: next_steps.value, links, workers: workers.value,
    };
    if (serializedBytes(value) > MAX_HANDOFF_BYTES) return fail(`handoff exceeds ${MAX_HANDOFF_BYTES} bytes`);
    return { ok: true, value };
  } catch { return fail('invalid handoff'); }
}

// ---------------------------------------------------------------------------------------------
// 8. LeadRecord (H5: v 1; machine-aware per D3)
// ---------------------------------------------------------------------------------------------

export const LEAD_RECORD_VERSION = 1;

export interface LeadWorker {
  session_key: string;
  name: string;
  state: SessionState;
  /** null while the worker's launch is held for approval. */
  permission_mode: AgentPermissionMode | null;
  needs_attention: boolean;
}

export interface LeadLastHandoff { seq: number; at: string; kind: HandoffKind; status: HandoffStatus; summary: string }

/**
 * The DO registry row for one Lead, upserted by the Lead's machine (a machine may write only its
 * own rows). Never carries a path: no cwd. Times are epoch milliseconds, ≤ 16 KiB serialized.
 */
export interface LeadRecord {
  /** Always 1 on a parsed value; readers accept stored `v` absent or ≥ 1. */
  v: 1;
  /** Lead session key `fm:<uuid>` (lowercased). */
  lead: string;
  /** The machine running the Lead (UUID v4, lowercased) and its display name. */
  machine_id: string;
  machine_name: string;
  /** Session display name, e.g. `lead-<workstream>`. */
  name: string;
  project: string;
  workstream: string;
  goal: string;
  model: string;
  effort: Effort;
  /** null while the launch is held for approval. */
  permission_mode: AgentPermissionMode | null;
  bypass_grant?: BypassGrantRef;
  policy_reason?: PolicyReason;
  /** `developer` or `coordinator` (Leads cannot start Leads). */
  launched_by: 'developer' | 'coordinator';
  state: SessionState;
  alive: boolean;
  /** Bounded (≤300) and redacted by the writer with `boundedReason`. */
  end_reason?: string;
  supersedes?: string;
  superseded_by?: string;
  created_at: number;
  updated_at: number;
  /** Pending approvals on the Lead and its workers. */
  pending_approvals: number;
  workers: LeadWorker[];
  last_handoff?: LeadLastHandoff;
}

const LEAD_RECORD_OPTIONAL = ['bypass_grant', 'policy_reason', 'end_reason', 'supersedes', 'superseded_by', 'last_handoff'] as const;

function parseLeadRecordFields(raw: Record<string, unknown>): Parsed<LeadRecord> {
  if (!recordVersion(raw)) return fail('v must be an integer >= 1');
  if (!isLeadKey(raw.lead)) return fail('lead must be a Lead session key fm:<uuid>');
  if (!isMachineId(raw.machine_id)) return fail('machine_id must be a UUID v4');
  if (!isMachineName(raw.machine_name)) return fail('machine_name must be 1-80 printable characters');
  if (!isSessionName(raw.name)) return fail('name must be 1-200 printable characters and not a path');
  if (!isProjectName(raw.project)) return fail('project must be a registered project name, not a path');
  if (!isWorkstream(raw.workstream)) return fail(`workstream must be a kebab-case key of at most ${MAX_WORKSTREAM} characters`);
  if (!isText(raw.goal, MAX_GOAL, true)) return fail(`goal must be 1-${MAX_GOAL} characters`);
  if (!isModel(raw.model)) return fail('model must be a model id');
  if (!isEffort(raw.effort)) return fail('invalid effort');
  if (raw.permission_mode !== null && !isAgentPermissionMode(raw.permission_mode)) return fail('permission_mode must be bypass, auto or null');
  if (raw.launched_by !== 'developer' && raw.launched_by !== 'coordinator') return fail('launched_by must be developer or coordinator');
  if (!isSessionState(raw.state)) return fail('invalid state');
  if (typeof raw.alive !== 'boolean') return fail('alive must be a boolean');
  if (!isEpochMs(raw.created_at) || !isEpochMs(raw.updated_at)) return fail('created_at and updated_at must be epoch milliseconds');
  if (!isNonNegativeInt(raw.pending_approvals) || raw.pending_approvals > MAX_PENDING_APPROVALS) return fail('pending_approvals must be a non-negative integer');
  if (!Array.isArray(raw.workers) || raw.workers.length > MAX_LEAD_WORKERS) return fail(`workers must be an array of at most ${MAX_LEAD_WORKERS} entries`);
  const workers: LeadWorker[] = [];
  for (const w of raw.workers) {
    if (!isPlainObject(w)) return fail('each worker must be an object');
    if (!isSessionKey(w.session_key)) return fail('worker session_key is invalid');
    if (!isSessionName(w.name)) return fail('worker name must be 1-200 printable characters and not a path');
    if (!isSessionState(w.state)) return fail('worker state is invalid');
    if (w.permission_mode !== null && !isAgentPermissionMode(w.permission_mode)) return fail('worker permission_mode must be bypass, auto or null');
    if (typeof w.needs_attention !== 'boolean') return fail('worker needs_attention must be a boolean');
    workers.push({ session_key: w.session_key, name: w.name, state: w.state, permission_mode: w.permission_mode as AgentPermissionMode | null, needs_attention: w.needs_attention });
  }
  const value: LeadRecord = {
    v: 1, lead: normalizeLeadKey(raw.lead), machine_id: normalizeMachineId(raw.machine_id), machine_name: raw.machine_name, name: raw.name,
    project: raw.project, workstream: raw.workstream, goal: raw.goal, model: raw.model, effort: raw.effort,
    permission_mode: raw.permission_mode as AgentPermissionMode | null, launched_by: raw.launched_by, state: raw.state, alive: raw.alive,
    created_at: raw.created_at, updated_at: raw.updated_at, pending_approvals: raw.pending_approvals, workers,
  };
  for (const key of LEAD_RECORD_OPTIONAL) {
    const v = raw[key];
    if (v === undefined) continue;
    switch (key) {
      case 'bypass_grant': if (!isBypassGrantRef(v)) return fail('invalid bypass_grant'); value.bypass_grant = v; break;
      case 'policy_reason': if (!isPolicyReason(v)) return fail('invalid policy_reason'); value.policy_reason = v; break;
      case 'end_reason': if (!isText(v, MAX_REASON, false)) return fail(`end_reason must be at most ${MAX_REASON} characters`); value.end_reason = v as string; break;
      case 'supersedes': case 'superseded_by': if (!isLeadKey(v)) return fail(`${key} must be a Lead session key`); value[key] = normalizeLeadKey(v); break;
      case 'last_handoff': {
        if (!isPlainObject(v)) return fail('last_handoff must be an object');
        if (!isNonNegativeInt(v.seq) || !isIsoTimestamp(v.at) || !includes(HANDOFF_KINDS, v.kind) || !includes(HANDOFF_STATUSES, v.status)) return fail('invalid last_handoff');
        if (!isText(v.summary, MAX_LAST_HANDOFF_SUMMARY, false)) return fail(`last_handoff.summary must be at most ${MAX_LAST_HANDOFF_SUMMARY} characters`);
        value.last_handoff = { seq: v.seq, at: v.at, kind: v.kind, status: v.status, summary: v.summary as string };
        break;
      }
    }
  }
  if (serializedBytes(value) > MAX_LEAD_RECORD_BYTES) return fail(`lead record exceeds ${MAX_LEAD_RECORD_BYTES} bytes`);
  return { ok: true, value };
}

/** Validates a LeadRecord: `v` absent or ≥ 1, known fields validated, unknown fields (incl. any cwd) dropped. */
export function parseLeadRecord(raw: unknown): Parsed<LeadRecord> {
  try {
    if (!isPlainObject(raw)) return fail('lead record must be an object');
    return parseLeadRecordFields(raw);
  } catch { return fail('invalid lead record'); }
}

/** Builds `LeadRecord.last_handoff` from a handoff (summary cut to 500 chars without splitting a surrogate pair). */
export function lastHandoffOf(handoff: LeadHandoff): LeadLastHandoff {
  let summary = handoff.summary;
  if (summary.length > MAX_LAST_HANDOFF_SUMMARY) {
    let out = '';
    for (const ch of summary) { if (out.length + ch.length > MAX_LAST_HANDOFF_SUMMARY - 1) break; out += ch; }
    summary = out + '…';
  }
  return { seq: handoff.seq, at: handoff.at, kind: handoff.kind, status: handoff.status, summary };
}

/** A registry row as read back from the DO: the record plus DO-computed liveness. */
export type LeadListEntry = LeadRecord & {
  /** Whether the Lead's machine currently has a socket to the DO. */
  machine_online: boolean;
  /** When the DO last received this row (epoch ms). */
  reported_at: number;
  /** The Lead has ended (state `ended`/`dead`, or superseded). */
  ended: boolean;
};

export function parseLeadListEntry(raw: unknown): Parsed<LeadListEntry> {
  try {
    if (!isPlainObject(raw)) return fail('lead entry must be an object');
    const record = parseLeadRecordFields(raw);
    if (!record.ok) return fail(record.error);
    if (typeof raw.machine_online !== 'boolean') return fail('machine_online must be a boolean');
    if (!isEpochMs(raw.reported_at)) return fail('reported_at must be epoch milliseconds');
    if (typeof raw.ended !== 'boolean') return fail('ended must be a boolean');
    return { ok: true, value: { ...record.value, machine_online: raw.machine_online, reported_at: raw.reported_at, ended: raw.ended } };
  } catch { return fail('invalid lead entry'); }
}

// ---------------------------------------------------------------------------------------------
// 9. lead_rpc frames (host → DO; accepted from any hello-v2 machine; NOT epoch-fenced)
// ---------------------------------------------------------------------------------------------

/** Serialized bound for a host→DO `lead_rpc` frame. */
export const MAX_LEAD_FRAME = 64 * 1024;
/** Serialized bound for a DO→host `lead_rpc_result` frame. The DO trims `lead.list` (oldest ended first) to fit. */
export const MAX_LEAD_RESULT_FRAME = 1024 * 1024;

export const LEAD_OPS = ['lead.upsert', 'lead.handoff', 'lead.sync', 'lead.list', 'lead.get', 'settings.get'] as const;
export type LeadOp = typeof LEAD_OPS[number];

/**
 * - `invalid`: malformed frame or args.
 * - `too_large`: a size bound was exceeded.
 * - `forbidden`: the row belongs to another machine.
 * - `not_found`: unknown Lead.
 * - `unavailable`: the DO cannot serve the op right now.
 */
export const LEAD_ERROR_CODES = ['invalid', 'too_large', 'forbidden', 'not_found', 'unavailable'] as const;
export type LeadErrorCode = typeof LEAD_ERROR_CODES[number];

export function isLeadOp(value: unknown): value is LeadOp { return includes(LEAD_OPS, value); }
export function isLeadErrorCode(value: unknown): value is LeadErrorCode { return includes(LEAD_ERROR_CODES, value); }

export interface LeadOpArgs {
  /** `record.machine_id` must be the sending machine (else `forbidden`). */
  'lead.upsert': { record: LeadRecord };
  'lead.handoff': { handoff: LeadHandoff };
  /** Full resync of the sender's Lead rows (≤ 50 per frame; the host chunks to fit `MAX_LEAD_FRAME`). */
  'lead.sync': { records: LeadRecord[] };
  'lead.list': { include_ended?: boolean; limit?: number };
  /** `handoffs`: 0..5 newest handoffs (default 0). */
  'lead.get': { lead: string; handoffs?: number };
  'settings.get': Record<string, never>;
}

export interface LeadOpResults {
  'lead.upsert': Record<string, never>;
  /** `stored: false` = duplicate `(lead, seq)`; not an error. */
  'lead.handoff': { stored: boolean };
  'lead.sync': Record<string, never>;
  'lead.list': { leads: LeadListEntry[] };
  /** `handoffs` newest first. */
  'lead.get': { lead: LeadListEntry; handoffs: LeadHandoff[] };
  'settings.get': DevSettingsView;
}

/** host → DO (contract shape). */
export interface LeadRpc { type: 'lead_rpc'; id: string; op: LeadOp; args: unknown }
export type LeadRpcFor<O extends LeadOp> = { type: 'lead_rpc'; id: string; op: O; args: LeadOpArgs[O] };
export type TypedLeadRpc = { [O in LeadOp]: LeadRpcFor<O> }[LeadOp];

/** DO → host. */
export type LeadRpcResult =
  | { type: 'lead_rpc_result'; id: string; ok: true; result: unknown }
  | { type: 'lead_rpc_result'; id: string; ok: false; code: LeadErrorCode; message: string };

export type LeadArgsParsed<O extends LeadOp> = { ok: true; value: LeadOpArgs[O] } | { ok: false; code: 'invalid' | 'too_large'; error: string };

function bad(error: string): { ok: false; code: 'invalid'; error: string } { return { ok: false, code: 'invalid', error }; }
function big(error: string): { ok: false; code: 'too_large'; error: string } { return { ok: false, code: 'too_large', error }; }

/** Validates `args` for one op (strict keys). Never throws; returns a fresh copy on success. */
export function parseLeadOpArgs<O extends LeadOp>(op: O, args: unknown): LeadArgsParsed<O> {
  try {
    if (!isPlainObject(args)) return bad('args must be an object');
    const a = args;
    let extra: string | null;
    switch (op as LeadOp) {
      case 'lead.upsert': {
        if ((extra = onlyKeys(a, ['record']))) return bad(`unexpected key ${extra}`);
        const record = parseLeadRecord(a.record);
        if (!record.ok) return /exceeds/.test(record.error) ? big(record.error) : bad(record.error);
        return { ok: true, value: { record: record.value } as LeadOpArgs[O] };
      }
      case 'lead.handoff': {
        if ((extra = onlyKeys(a, ['handoff']))) return bad(`unexpected key ${extra}`);
        const handoff = parseLeadHandoff(a.handoff);
        if (!handoff.ok) return /exceeds/.test(handoff.error) ? big(handoff.error) : bad(handoff.error);
        return { ok: true, value: { handoff: handoff.value } as LeadOpArgs[O] };
      }
      case 'lead.sync': {
        if ((extra = onlyKeys(a, ['records']))) return bad(`unexpected key ${extra}`);
        if (!Array.isArray(a.records)) return bad('records must be an array');
        if (a.records.length > MAX_SYNC_RECORDS) return big(`records exceeds ${MAX_SYNC_RECORDS} entries`);
        const records: LeadRecord[] = [];
        for (const item of a.records) {
          const record = parseLeadRecord(item);
          if (!record.ok) return /exceeds/.test(record.error) ? big(record.error) : bad(record.error);
          if (records.some((r) => r.lead === record.value.lead)) return bad('duplicate lead in records');
          records.push(record.value);
        }
        return { ok: true, value: { records } as LeadOpArgs[O] };
      }
      case 'lead.list': {
        if ((extra = onlyKeys(a, ['include_ended', 'limit']))) return bad(`unexpected key ${extra}`);
        const value: LeadOpArgs['lead.list'] = {};
        if (a.include_ended !== undefined) { if (typeof a.include_ended !== 'boolean') return bad('include_ended must be a boolean'); value.include_ended = a.include_ended; }
        if (a.limit !== undefined) { if (!isNonNegativeInt(a.limit) || a.limit < 1 || a.limit > MAX_LEAD_LIST) return bad(`limit must be 1-${MAX_LEAD_LIST}`); value.limit = a.limit; }
        return { ok: true, value: value as LeadOpArgs[O] };
      }
      case 'lead.get': {
        if ((extra = onlyKeys(a, ['lead', 'handoffs']))) return bad(`unexpected key ${extra}`);
        if (!isLeadKey(a.lead)) return bad('lead must be a Lead session key fm:<uuid>');
        const value: LeadOpArgs['lead.get'] = { lead: normalizeLeadKey(a.lead) };
        if (a.handoffs !== undefined) { if (!isNonNegativeInt(a.handoffs) || a.handoffs > MAX_HANDOFF_READ) return bad(`handoffs must be 0-${MAX_HANDOFF_READ}`); value.handoffs = a.handoffs; }
        return { ok: true, value: value as LeadOpArgs[O] };
      }
      case 'settings.get':
        if ((extra = onlyKeys(a, []))) return bad(`unexpected key ${extra}`);
        return { ok: true, value: {} as LeadOpArgs[O] };
      default:
        return bad('unknown op');
    }
  } catch { return bad('invalid args'); }
}

/**
 * Validates a host→DO `lead_rpc`. On failure, `id` is the frame's id when it was valid (so the
 * DO can answer with a `lead_rpc_result` carrying `code`), else null (drop the frame).
 */
export type LeadRpcParsed = { ok: true; value: TypedLeadRpc } | { ok: false; id: string | null; code: 'invalid' | 'too_large'; error: string };

export function parseLeadRpc(raw: unknown): LeadRpcParsed {
  let id: string | null = null;
  try {
    if (!isPlainObject(raw) || raw.type !== 'lead_rpc') return { ok: false, id, code: 'invalid', error: 'not a lead_rpc frame' };
    if (isPmId(raw.id)) id = raw.id;
    const extra = onlyKeys(raw, ['type', 'id', 'op', 'args']);
    if (extra) return { ok: false, id, code: 'invalid', error: `unexpected key ${extra}` };
    if (id === null) return { ok: false, id, code: 'invalid', error: 'invalid id' };
    if (!isLeadOp(raw.op)) return { ok: false, id, code: 'invalid', error: 'unknown op' };
    if (serializedBytes(raw) > MAX_LEAD_FRAME) return { ok: false, id, code: 'too_large', error: 'frame too large' };
    const args = parseLeadOpArgs(raw.op, raw.args);
    if (!args.ok) return { ok: false, id, code: args.code, error: args.error };
    return { ok: true, value: { type: 'lead_rpc', id, op: raw.op, args: args.value } as TypedLeadRpc };
  } catch { return { ok: false, id, code: 'invalid', error: 'invalid lead_rpc' }; }
}

/** Builds a failed `lead_rpc_result`; the message is redacted and bounded to 300 chars. */
export function leadRpcError(id: string, code: LeadErrorCode, message: string): LeadRpcResult {
  return { type: 'lead_rpc_result', id, ok: false, code, message: boundedReason(message) };
}

export function leadRpcOk<O extends LeadOp>(id: string, _op: O, result: LeadOpResults[O]): LeadRpcResult {
  return { type: 'lead_rpc_result', id, ok: true, result };
}

/** Validates a DO→host `lead_rpc_result` envelope (check `result` with `parseLeadOpResult`). */
export function parseLeadRpcResult(raw: unknown): Parsed<LeadRpcResult> {
  try {
    if (!isPlainObject(raw) || raw.type !== 'lead_rpc_result') return fail('not a lead_rpc_result frame');
    if (!isPmId(raw.id)) return fail('invalid id');
    if (serializedBytes(raw) > MAX_LEAD_RESULT_FRAME) return fail('frame too large');
    if (raw.ok === true) {
      const extra = onlyKeys(raw, ['type', 'id', 'ok', 'result']);
      if (extra) return fail(`unexpected key ${extra}`);
      if (!('result' in raw)) return fail('missing result');
      return { ok: true, value: { type: 'lead_rpc_result', id: raw.id, ok: true, result: raw.result } };
    }
    if (raw.ok === false) {
      const extra = onlyKeys(raw, ['type', 'id', 'ok', 'code', 'message']);
      if (extra) return fail(`unexpected key ${extra}`);
      if (!isLeadErrorCode(raw.code)) return fail('unknown error code');
      if (typeof raw.message !== 'string' || raw.message.length > MAX_REASON) return fail(`message must be a string of at most ${MAX_REASON} characters`);
      return { ok: true, value: { type: 'lead_rpc_result', id: raw.id, ok: false, code: raw.code, message: raw.message } };
    }
    return fail('ok must be a boolean');
  } catch { return fail('invalid lead_rpc_result'); }
}

function isEmptyObject(raw: unknown): boolean {
  return isPlainObject(raw) && Object.keys(raw).length === 0;
}

/** Validates the `result` of a successful `lead_rpc_result` for the op the host sent. */
export function parseLeadOpResult<O extends LeadOp>(op: O, raw: unknown): Parsed<LeadOpResults[O]> {
  try {
    switch (op as LeadOp) {
      case 'lead.upsert':
      case 'lead.sync':
        if (!isEmptyObject(raw)) return fail('expected an empty result');
        return { ok: true, value: {} as LeadOpResults[O] };
      case 'lead.handoff':
        if (!isPlainObject(raw) || onlyKeys(raw, ['stored']) || typeof raw.stored !== 'boolean') return fail('invalid lead.handoff result');
        return { ok: true, value: { stored: raw.stored } as LeadOpResults[O] };
      case 'lead.list': {
        if (!isPlainObject(raw) || onlyKeys(raw, ['leads']) || !Array.isArray(raw.leads) || raw.leads.length > MAX_LEAD_LIST) return fail(`leads must be an array of at most ${MAX_LEAD_LIST} entries`);
        const leads: LeadListEntry[] = [];
        for (const item of raw.leads) { const e = parseLeadListEntry(item); if (!e.ok) return fail(e.error); leads.push(e.value); }
        return { ok: true, value: { leads } as LeadOpResults[O] };
      }
      case 'lead.get': {
        if (!isPlainObject(raw) || onlyKeys(raw, ['lead', 'handoffs'])) return fail('invalid lead.get result');
        const lead = parseLeadListEntry(raw.lead); if (!lead.ok) return fail(lead.error);
        if (!Array.isArray(raw.handoffs) || raw.handoffs.length > MAX_HANDOFF_READ) return fail(`handoffs must be an array of at most ${MAX_HANDOFF_READ} entries`);
        const handoffs: LeadHandoff[] = [];
        for (const item of raw.handoffs) { const h = parseLeadHandoff(item); if (!h.ok) return fail(h.error); handoffs.push(h.value); }
        return { ok: true, value: { lead: lead.value, handoffs } as LeadOpResults[O] };
      }
      case 'settings.get': {
        const view = parseDevSettingsView(raw);
        return view.ok ? { ok: true, value: view.value as LeadOpResults[O] } : fail(view.error);
      }
      default:
        return fail('unknown op');
    }
  } catch { return fail('invalid result'); }
}

// ---------------------------------------------------------------------------------------------
// 10. HTTP shapes (Worker-terminated, H2; NOT in the relay allowlist)
// ---------------------------------------------------------------------------------------------

export const LEADS_ROUTE = '/api/leads';
export const SETTINGS_ROUTE = '/api/settings';

/** GET /api/leads. */
export interface LeadsResponse { leads: LeadListEntry[]; mode: 'relay' | 'local' }
/** GET /api/settings; `writable` is false where the developer cannot change settings (e.g. local-only). */
export type SettingsResponse = DevSettingsView & { writable: boolean };
/** POST /api/settings body. `version` (optional) must equal the key's current version, else 409. */
export interface SettingsPostRequest { key: DevSettingKey; value: unknown; version?: number }
/** POST /api/settings 200 body. */
export type SettingsPostResponse = DevSettingsView & { writable: true };

/** A validated POST /api/settings body: `value` already parsed for `key`. */
export type ParsedSettingsPost = { [K in DevSettingKey]: { key: K; value: DevSettings[K]; version?: number } }[DevSettingKey];

/** Validates a POST /api/settings body (strict keys; `value` validated for `key`). */
export function parseSettingsPost(raw: unknown): Parsed<ParsedSettingsPost> {
  try {
    if (!isPlainObject(raw)) return fail('body must be an object');
    const extra = onlyKeys(raw, ['key', 'value', 'version']);
    if (extra) return fail(`unexpected key ${extra}`);
    if (!isDevSettingKey(raw.key)) return fail(`key must be one of ${DEV_SETTING_KEYS.join(', ')}`);
    if (raw.version !== undefined && !isNonNegativeInt(raw.version)) return fail('version must be a non-negative integer');
    const value = parseDevSetting(raw.key, raw.value);
    if (!value.ok) return fail(value.error);
    return { ok: true, value: { key: raw.key, value: value.value, ...(raw.version !== undefined ? { version: raw.version as number } : {}) } as ParsedSettingsPost };
  } catch { return fail('invalid body'); }
}

// ---------------------------------------------------------------------------------------------
// 11. Host interfaces (types only)
// ---------------------------------------------------------------------------------------------

/** Reads the developer's settings. Resolves null when unavailable (no cache; the caller treats it as `grant_unavailable`). */
export interface GrantSource { devSettings(timeoutMs?: number): Promise<DevSettingsView | null> }

export interface LeadStore extends GrantSource {
  readonly mode: 'relay' | 'local';
  /** Assigns `seq` and `at`, fills `workers`, stores locally, queues for the DO, and returns the stored handoff. */
  appendHandoff(input: Omit<LeadHandoff, 'v' | 'seq' | 'at' | 'workers'>): Promise<LeadHandoff>;
  /** Debounced upsert of one row. */
  upsert(record: LeadRecord): void;
  /** Registers the resync source (called on every hello and periodically while connected). */
  track(records: () => LeadRecord[]): void;
  list(opts?: { include_ended?: boolean; limit?: number }): Promise<LeadListEntry[]>;
  get(lead: string, handoffs?: number): Promise<{ lead: LeadListEntry; handoffs: LeadHandoff[] } | null>;
  latestHandoff(lead: string): Promise<LeadHandoff | null>;
  close(): void;
}

export interface AgentLaunchRequest {
  /** Creation id (idempotency key, as `SessionService.create`). */
  id: string;
  name: string;
  /** Registered project name or absolute directory (resolved on the host; never sent to the relay). */
  cwd: string;
  /** The first task. */
  text: string;
  provider: 'claude';
  model?: string;
  effort?: Effort;
  role: 'lead' | 'worker';
  requester_role: AgentRole;
  launched_by: LaunchedBy;
  parent?: string;
  supersedes?: string;
  workstream?: string;
  requested_mode?: AgentPermissionMode;
}

export interface AgentLaunchResult {
  session_key: string;
  name: string;
  status: 'started' | 'awaiting_developer_approval';
  /** null while held for approval. */
  permission_mode: AgentPermissionMode | null;
  bypass_grant?: BypassGrantRef;
  policy_reason: PolicyReason;
}

/** Implemented by CL-04 (server/session-service.ts); consumed by CL-05/CL-06. */
export interface AgentSessionService {
  launchAgent(req: AgentLaunchRequest): Promise<AgentLaunchResult>;
  retire(id: string, reason: string, options?: { force?: boolean }): Promise<void>;
  list(): any[];
  detail(id: string): any;
}

// ---------------------------------------------------------------------------------------------
// 12. Held-launch approval
// ---------------------------------------------------------------------------------------------

/** Tool name on the approval card for a held Bypass launch. */
export const LAUNCH_APPROVAL_TOOL = 'foreman.launch_bypass';
/** A held launch's session state and reason. */
export const HELD_LAUNCH_STATE = 'needs_input';
export const HELD_LAUNCH_REASON = 'awaiting_bypass_approval';
/** End reasons for a held launch that never ran. */
export const LAUNCH_DENIED = 'Bypass launch denied by developer; nothing ran';
export const LAUNCH_EXPIRED = 'Launch approval expired; nothing was launched';

/** The approval card's input for `LAUNCH_APPROVAL_TOOL` (host-local; shown to the developer). */
export interface LaunchApprovalInput {
  name: string;
  /** Registered project name, or null when the target directory is not registered. */
  project: string | null;
  /** Absolute directory on the Lead's machine (host-local only). */
  cwd: string;
  provider: 'claude';
  model: string;
  effort: Effort;
  role: 'lead' | 'worker';
  /** `coordinator` or the requesting Lead's session key. */
  requested_by: LaunchedBy;
  /** ≤ 2000 chars (`truncateFirstTask`). */
  first_task: string;
}

/** Cuts a first task to `MAX_FIRST_TASK` chars (with an ellipsis) without splitting a surrogate pair. */
export function truncateFirstTask(text: string): string {
  if (typeof text !== 'string') return '';
  if (text.length <= MAX_FIRST_TASK) return text;
  let out = '';
  for (const ch of text) { if (out.length + ch.length > MAX_FIRST_TASK - 1) break; out += ch; }
  return out + '…';
}

/** Validates a LaunchApprovalInput (strict keys). */
export function parseLaunchApprovalInput(raw: unknown): Parsed<LaunchApprovalInput> {
  try {
    if (!isPlainObject(raw)) return fail('launch approval input must be an object');
    const extra = onlyKeys(raw, ['name', 'project', 'cwd', 'provider', 'model', 'effort', 'role', 'requested_by', 'first_task']);
    if (extra) return fail(`unexpected key ${extra}`);
    if (!isSessionName(raw.name)) return fail('name must be 1-200 printable characters and not a path');
    if (raw.project !== null && !isProjectName(raw.project)) return fail('project must be a registered project name or null');
    if (!isLine(raw.cwd, 4096) || !looksLikeAbsolutePath(raw.cwd)) return fail('cwd must be an absolute directory');
    if (raw.provider !== 'claude') return fail('provider must be claude');
    if (!isModel(raw.model)) return fail('model must be a model id');
    if (!isEffort(raw.effort)) return fail('invalid effort');
    if (raw.role !== 'lead' && raw.role !== 'worker') return fail('role must be lead or worker');
    if (raw.requested_by !== 'coordinator' && !isLeadKey(raw.requested_by)) return fail('requested_by must be coordinator or a Lead session key');
    if (!isText(raw.first_task, MAX_FIRST_TASK, true)) return fail(`first_task must be 1-${MAX_FIRST_TASK} characters`);
    return { ok: true, value: { name: raw.name, project: raw.project as string | null, cwd: raw.cwd, provider: 'claude', model: raw.model, effort: raw.effort, role: raw.role, requested_by: raw.requested_by, first_task: raw.first_task } };
  } catch { return fail('invalid launch approval input'); }
}
