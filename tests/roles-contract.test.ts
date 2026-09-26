import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES, AGENT_ROLES, EFFORTS, CONFIG_ROLES, SESSION_STATES, ROLE_DEFAULTS, ROLE_ENV, LEAD_LIMITS, LEAD_LIMIT_ENV,
  MAX_HANDOFF_BYTES, MAX_HANDOFFS_KEPT, MAX_LEAD_ROWS, MAX_HANDOFF_READ, MAX_LEAD_WORKERS, MAX_SYNC_RECORDS, MAX_BYPASS_GRANTS,
  MAX_LEAD_FRAME, MAX_LEAD_RESULT_FRAME, MAX_FIRST_TASK, GRANT_TIMEOUT_MS, MAX_LEAD_RECORD_BYTES,
  AGENT_PERMISSION_MODES, POLICY_REASONS, DEV_SETTING_KEYS, LEAD_OPS, LEAD_ERROR_CODES, HANDOFF_KINDS, HANDOFF_STATUSES,
  LEADS_ROUTE, SETTINGS_ROUTE, LAUNCH_APPROVAL_TOOL, HELD_LAUNCH_STATE, HELD_LAUNCH_REASON, LAUNCH_DENIED, LAUNCH_EXPIRED,
  AGENT_NATIVE_REFUSED, DEFAULT_BYPASS_GRANTS,
  resolveRoleConfig, leadLimits, roleOf, launchedBy, isLaunchedBy, isBypassGrantRef, looksLikeAbsolutePath, workstreamKey,
  agentModeSupported, parseRequestedAgentMode, resolveAgentLaunchPolicy, approvedLaunchPolicy, matchBypassGrant,
  parseDevSetting, effectiveDevSettings, defaultDevSettings, parseDevSettingsView, parseSettingsPost,
  parseLeadHandoff, parseLeadRecord, parseLeadListEntry, lastHandoffOf, parseLeadRpc, parseLeadOpArgs, parseLeadRpcResult,
  parseLeadOpResult, leadRpcError, leadRpcOk, parseLaunchApprovalInput, truncateFirstTask,
  type DevSettings, type AgentRole, type LeadStore, type AgentSessionService,
  type LeadsResponse, type SettingsResponse,
} from '../shared/roles.ts';
import { allowedRequest } from '../shared/relay.ts';
import { buildPushPayload, NOTIFY_KINDS, utf8Length, type NotifyFrame } from '../shared/notify.ts';

const LEAD = 'fm:3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21';
const LEAD2 = 'fm:a9b8c7d6-1234-4abc-8def-0123456789ab';
const MID = '3f1c2b1e-8e0a-4f3c-9b2a-0d6f5c4e3a21';
const AT = '2026-09-25T12:34:56.789Z';
const PATHS = ['/Users/hong/code/foreman', '~/code/foreman', '~', 'C:\\work\\foreman', 'c:/work', '\\\\server\\share', ' /leading-space'];

function handoff(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1, lead: LEAD, seq: 3, at: AT, kind: 'checkpoint', project: 'foreman', workstream: 'portable-pm', goal: 'Ship portable PM state',
    status: 'in_progress', summary: 'Contracts landed.\nNext: DO tables.', decisions: ['Use lead_rpc'], open_questions: [], next_steps: ['Write CL-02'],
    links: [{ label: 'Epic', url: 'https://github.com/hyang0129/foreman/issues/157' }, { label: 'Branch', url: 'branch:agent/165-contracts' }],
    workers: [{ session_key: 'fm:11111111-2222-4333-8444-555555555555', name: 'worker-a', state: 'working' }],
    ...extra,
  };
}

function record(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1, lead: LEAD, machine_id: MID, machine_name: 'hong-mbp', name: 'lead-portable-pm', project: 'foreman', workstream: 'portable-pm',
    goal: 'Ship portable PM state', model: 'opus[1m]', effort: 'medium', permission_mode: 'bypass', bypass_grant: 'standing:coordinator/*',
    policy_reason: 'standing_grant', launched_by: 'coordinator', state: 'working', alive: true, created_at: 1_700_000_000_000,
    updated_at: 1_700_000_100_000, pending_approvals: 1,
    workers: [{ session_key: 'fm:11111111-2222-4333-8444-555555555555', name: 'worker-a', state: 'needs_input', permission_mode: 'auto', needs_attention: true }],
    last_handoff: { seq: 3, at: AT, kind: 'checkpoint', status: 'in_progress', summary: 'Contracts landed.' },
    ...extra,
  };
}

function settings(extra: Partial<DevSettings> = {}): DevSettings {
  return { ...defaultDevSettings(), ...extra };
}

test('constants match the #165 contract', () => {
  assert.deepEqual([...ROLES], ['session', 'lead', 'worker']);
  assert.deepEqual([...AGENT_ROLES], ['coordinator', 'lead']);
  assert.deepEqual([...EFFORTS], ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual([...CONFIG_ROLES], ['coordinator', 'lead', 'investigator']);
  assert.deepEqual([...SESSION_STATES], ['needs_input', 'working', 'turn_finished', 'idle', 'ended', 'dead', 'unknown']);
  assert.deepEqual(ROLE_DEFAULTS, { coordinator: { model: 'opus[1m]', effort: 'medium' }, lead: { model: 'opus[1m]', effort: 'medium' }, investigator: { model: 'opus', effort: 'low' } });
  assert.deepEqual(ROLE_ENV, { coordinator: { effort: 'FOREMAN_PM_EFFORT' }, lead: { model: 'FOREMAN_LEAD_MODEL', effort: 'FOREMAN_LEAD_EFFORT' }, investigator: { model: 'FOREMAN_INVESTIGATOR_MODEL', effort: 'FOREMAN_INVESTIGATOR_EFFORT' } });
  assert.deepEqual(LEAD_LIMITS, { maxLeads: 3, maxWorkersPerLead: 4 });
  assert.deepEqual(LEAD_LIMIT_ENV, { maxLeads: 'FOREMAN_MAX_LEADS', maxWorkersPerLead: 'FOREMAN_MAX_WORKERS_PER_LEAD' });
  assert.equal(MAX_HANDOFF_BYTES, 32 * 1024);
  assert.equal(MAX_LEAD_RECORD_BYTES, 16 * 1024);
  assert.equal(MAX_HANDOFFS_KEPT, 20);
  assert.equal(MAX_LEAD_ROWS, 200);
  assert.equal(MAX_HANDOFF_READ, 5);
  assert.equal(MAX_LEAD_WORKERS, 20);
  assert.equal(MAX_SYNC_RECORDS, 50);
  assert.equal(MAX_BYPASS_GRANTS, 100);
  assert.equal(MAX_LEAD_FRAME, 65536);
  assert.equal(MAX_LEAD_RESULT_FRAME, 1_048_576);
  assert.equal(MAX_FIRST_TASK, 2000);
  assert.equal(GRANT_TIMEOUT_MS, 5000);
  assert.deepEqual([...AGENT_PERMISSION_MODES], ['bypass', 'auto']);
  assert.deepEqual([...POLICY_REASONS], ['requested_auto', 'grant_unavailable', 'grant_off', 'ask_before_bypass', 'standing_grant', 'approved']);
  assert.deepEqual([...DEV_SETTING_KEYS], ['roles', 'bypass_grants', 'bypass_ask']);
  assert.deepEqual([...LEAD_OPS], ['lead.upsert', 'lead.handoff', 'lead.sync', 'lead.list', 'lead.get', 'settings.get']);
  assert.deepEqual([...LEAD_ERROR_CODES], ['invalid', 'too_large', 'forbidden', 'not_found', 'unavailable']);
  assert.deepEqual([...HANDOFF_KINDS], ['seed', 'checkpoint', 'final']);
  assert.deepEqual([...HANDOFF_STATUSES], ['in_progress', 'blocked', 'waiting_on_developer', 'done', 'abandoned']);
  assert.equal(LEADS_ROUTE, '/api/leads');
  assert.equal(SETTINGS_ROUTE, '/api/settings');
  assert.equal(LAUNCH_APPROVAL_TOOL, 'foreman.launch_bypass');
  assert.equal(HELD_LAUNCH_STATE, 'needs_input');
  assert.equal(HELD_LAUNCH_REASON, 'awaiting_bypass_approval');
  assert.equal(LAUNCH_DENIED, 'Bypass launch denied by developer; nothing ran');
  assert.equal(LAUNCH_EXPIRED, 'Launch approval expired; nothing was launched');
});

test('resolveRoleConfig precedence is DO → env → defaults, per field', () => {
  assert.deepEqual(resolveRoleConfig('lead'), ROLE_DEFAULTS.lead);
  assert.deepEqual(resolveRoleConfig('investigator', {}), { model: 'opus', effort: 'low' });
  const env = { FOREMAN_LEAD_MODEL: 'claude-sonnet-5', FOREMAN_LEAD_EFFORT: 'high', FOREMAN_INVESTIGATOR_MODEL: 'haiku', FOREMAN_INVESTIGATOR_EFFORT: 'medium', FOREMAN_PM_EFFORT: 'xhigh' };
  assert.deepEqual(resolveRoleConfig('lead', { env }), { model: 'claude-sonnet-5', effort: 'high' });
  assert.deepEqual(resolveRoleConfig('investigator', { env }), { model: 'haiku', effort: 'medium' });
  assert.deepEqual(resolveRoleConfig('coordinator', { env }), { model: 'opus[1m]', effort: 'xhigh' });
  // DO beats env, field by field.
  assert.deepEqual(resolveRoleConfig('lead', { env, dev: { lead: { effort: 'max' } } }), { model: 'claude-sonnet-5', effort: 'max' });
  assert.deepEqual(resolveRoleConfig('lead', { env, dev: { lead: { model: 'opus', effort: 'low' } } }), { model: 'opus', effort: 'low' });
  assert.deepEqual(resolveRoleConfig('coordinator', { env, dev: { coordinator: { effort: 'low' } } }), { model: 'opus[1m]', effort: 'low' });
  // The Coordinator's model is never taken from dev settings (it is pm_settings.model).
  assert.equal(resolveRoleConfig('coordinator', { dev: { coordinator: { model: 'haiku' } } as never }).model, 'opus[1m]');
  // Invalid values at any level fall through.
  assert.deepEqual(resolveRoleConfig('lead', { env: { FOREMAN_LEAD_MODEL: 'bad model!', FOREMAN_LEAD_EFFORT: 'extreme' }, dev: { lead: { effort: 'ultra' as never } } }), ROLE_DEFAULTS.lead);
  assert.equal(resolveRoleConfig('lead', { env: { FOREMAN_LEAD_EFFORT: ' high ' } }).effort, 'high');
  assert.deepEqual(resolveRoleConfig('lead', { dev: null, env: null }), ROLE_DEFAULTS.lead);
});

test('leadLimits accepts only positive integers from env', () => {
  assert.deepEqual(leadLimits({}), LEAD_LIMITS);
  assert.deepEqual(leadLimits(undefined), LEAD_LIMITS);
  assert.deepEqual(leadLimits({ FOREMAN_MAX_LEADS: '5', FOREMAN_MAX_WORKERS_PER_LEAD: '8' }), { maxLeads: 5, maxWorkersPerLead: 8 });
  assert.deepEqual(leadLimits({ FOREMAN_MAX_LEADS: ' 2 ' }), { maxLeads: 2, maxWorkersPerLead: 4 });
  for (const bad of ['0', '-1', '1.5', 'abc', '', '1e3', '0x10', '9999999', '+3', 'Infinity'])
    assert.deepEqual(leadLimits({ FOREMAN_MAX_LEADS: bad, FOREMAN_MAX_WORKERS_PER_LEAD: bad }), LEAD_LIMITS, bad);
});

test('roleOf / launchedBy default old records to session / developer', () => {
  assert.equal(roleOf({}), 'session');
  assert.equal(roleOf(null), 'session');
  assert.equal(roleOf({ role: 'bogus' }), 'session');
  assert.equal(roleOf({ role: 'lead' }), 'lead');
  assert.equal(roleOf({ role: 'worker' }), 'worker');
  assert.equal(launchedBy({}), 'developer');
  assert.equal(launchedBy(undefined), 'developer');
  assert.equal(launchedBy({ launched_by: 'someone' }), 'developer');
  assert.equal(launchedBy({ launched_by: 'coordinator' }), 'coordinator');
  assert.equal(launchedBy({ launched_by: LEAD.toUpperCase().replace('FM:', 'fm:') }), LEAD);
  assert.equal(isLaunchedBy('claude:abc'), false);
  for (const ok of ['standing:coordinator/*', 'standing:lead/foreman', 'standing:lead/My Project', 'approved:appr-123'])
    assert.equal(isBypassGrantRef(ok), true, ok);
  for (const bad of ['standing:worker/*', 'standing:lead/', 'standing:lead//Users/x', 'approved:', 'approved:a b', 'bypass', 42])
    assert.equal(isBypassGrantRef(bad), false, String(bad));
});

test('parseRequestedAgentMode refuses native with a clear error', () => {
  assert.deepEqual(parseRequestedAgentMode(undefined), { ok: true, value: undefined });
  assert.deepEqual(parseRequestedAgentMode(null), { ok: true, value: undefined });
  assert.deepEqual(parseRequestedAgentMode('bypass'), { ok: true, value: 'bypass' });
  assert.deepEqual(parseRequestedAgentMode('auto'), { ok: true, value: 'auto' });
  assert.deepEqual(parseRequestedAgentMode('native'), { ok: false, error: AGENT_NATIVE_REFUSED });
  assert.equal(parseRequestedAgentMode('default').ok, false);
  assert.equal(agentModeSupported('claude', 'auto'), true);
  assert.equal(agentModeSupported('codex', 'auto'), false);
  assert.equal(agentModeSupported('claude', 'bypass'), true);
});

test('resolveAgentLaunchPolicy covers every branch and never returns native', () => {
  const on = settings();
  const table: [string, Parameters<typeof resolveAgentLaunchPolicy>[0], ReturnType<typeof resolveAgentLaunchPolicy>][] = [
    ['requested auto wins over grant', { requesterRole: 'coordinator', project: 'foreman', requested: 'auto', settings: on }, { decision: 'auto', policy_reason: 'requested_auto' }],
    ['requested auto even when settings are unavailable', { requesterRole: 'lead', project: null, requested: 'auto', settings: null }, { decision: 'auto', policy_reason: 'requested_auto' }],
    ['settings unavailable → auto, never bypass', { requesterRole: 'coordinator', project: 'foreman', settings: null }, { decision: 'auto', policy_reason: 'grant_unavailable' }],
    ['settings unavailable with bypass requested → still auto', { requesterRole: 'lead', project: 'foreman', requested: 'bypass', settings: null }, { decision: 'auto', policy_reason: 'grant_unavailable' }],
    ['default grants: coordinator bypass', { requesterRole: 'coordinator', project: 'foreman', settings: on }, { decision: 'bypass', bypass_grant: 'standing:coordinator/*', policy_reason: 'standing_grant' }],
    ['default grants: lead bypass', { requesterRole: 'lead', project: null, settings: on }, { decision: 'bypass', bypass_grant: 'standing:lead/*', policy_reason: 'standing_grant' }],
    ['explicit bypass request with grant on', { requesterRole: 'lead', project: 'foreman', requested: 'bypass', settings: on }, { decision: 'bypass', bypass_grant: 'standing:lead/*', policy_reason: 'standing_grant' }],
    ['no grants at all → auto', { requesterRole: 'coordinator', project: 'foreman', settings: settings({ bypass_grants: [] }) }, { decision: 'auto', policy_reason: 'grant_off' }],
    ['role grant off → auto', { requesterRole: 'lead', project: 'foreman', settings: settings({ bypass_grants: [{ role: 'lead', project: '*', allow: false }, { role: 'coordinator', project: '*', allow: true }] }) }, { decision: 'auto', policy_reason: 'grant_off' }],
    ['other role on does not apply', { requesterRole: 'lead', project: 'foreman', settings: settings({ bypass_grants: [{ role: 'coordinator', project: '*', allow: true }] }) }, { decision: 'auto', policy_reason: 'grant_off' }],
    ['per-project allow:false beats * on', { requesterRole: 'coordinator', project: 'Foreman', settings: settings({ bypass_grants: [{ role: 'coordinator', project: '*', allow: true }, { role: 'coordinator', project: 'foreman', allow: false }] }) }, { decision: 'auto', policy_reason: 'grant_off' }],
    ['per-project allow:true beats * off', { requesterRole: 'coordinator', project: 'foreman', settings: settings({ bypass_grants: [{ role: 'coordinator', project: 'foreman', allow: true }, { role: 'coordinator', project: '*', allow: false }] }) }, { decision: 'bypass', bypass_grant: 'standing:coordinator/foreman', policy_reason: 'standing_grant' }],
    ['per-project entry for another project does not apply', { requesterRole: 'coordinator', project: 'other', settings: settings({ bypass_grants: [{ role: 'coordinator', project: '*', allow: true }, { role: 'coordinator', project: 'foreman', allow: false }] }) }, { decision: 'bypass', bypass_grant: 'standing:coordinator/*', policy_reason: 'standing_grant' }],
    ['unregistered project only matches *', { requesterRole: 'coordinator', project: null, settings: settings({ bypass_grants: [{ role: 'coordinator', project: 'foreman', allow: true }] }) }, { decision: 'auto', policy_reason: 'grant_off' }],
    ['grant on + ask → hold', { requesterRole: 'lead', project: 'foreman', settings: settings({ bypass_ask: true }) }, { decision: 'hold', policy_reason: 'ask_before_bypass' }],
    ['grant off + ask → auto (no card)', { requesterRole: 'lead', project: 'foreman', settings: settings({ bypass_ask: true, bypass_grants: [] }) }, { decision: 'auto', policy_reason: 'grant_off' }],
  ];
  for (const [label, input, expected] of table) {
    const result = resolveAgentLaunchPolicy(input);
    assert.deepEqual(result, expected, label);
    assert.notEqual(result.decision as string, 'native', label);
  }
  assert.throws(() => resolveAgentLaunchPolicy({ requesterRole: 'coordinator', project: 'foreman', requested: 'native' as never, settings: settings() }), { message: AGENT_NATIVE_REFUSED });
  assert.throws(() => resolveAgentLaunchPolicy({ requesterRole: 'coordinator', project: 'foreman', requested: 'default' as never, settings: settings() }), TypeError);
  assert.throws(() => resolveAgentLaunchPolicy({ requesterRole: 'worker' as AgentRole, project: 'foreman', settings: settings() }), TypeError);
  assert.deepEqual(approvedLaunchPolicy('appr-1'), { decision: 'bypass', bypass_grant: 'approved:appr-1', policy_reason: 'approved' });
  assert.equal(matchBypassGrant([], 'lead', 'x'), null);
});

test('effectiveDevSettings applies defaults (grant on for both roles, ask off) and fails toward lower privilege', () => {
  const d = effectiveDevSettings({});
  assert.deepEqual(d, { roles: {}, bypass_grants: [{ role: 'coordinator', project: '*', allow: true }, { role: 'lead', project: '*', allow: true }], bypass_ask: false });
  assert.deepEqual(effectiveDevSettings(null), d);
  assert.deepEqual(DEFAULT_BYPASS_GRANTS, d.bypass_grants);
  d.bypass_grants.push({ role: 'lead', project: 'x', allow: false });
  assert.equal(effectiveDevSettings({}).bypass_grants.length, 2, 'defaults are fresh copies');
  assert.deepEqual(effectiveDevSettings({ bypass_ask: true, bypass_grants: [], roles: { lead: { effort: 'high' } } }), { roles: { lead: { effort: 'high' } }, bypass_grants: [], bypass_ask: true });
  // Corrupt stored values: grants → off, roles → none, and a corrupt ask turns the grants off (ask → off).
  assert.deepEqual(effectiveDevSettings({ bypass_grants: 'yes', bypass_ask: 'no', roles: 5 }), { roles: {}, bypass_grants: [], bypass_ask: false });
  assert.equal(resolveAgentLaunchPolicy({ requesterRole: 'lead', project: 'x', settings: effectiveDevSettings({ bypass_grants: [{ role: 'lead', project: '/etc', allow: true }] }) }).decision, 'auto');
});

test('#197: a corrupt stored bypass_ask turns the grants off (Auto, no held launch), even beside valid grants', () => {
  const grants = [{ role: 'lead', project: '*', allow: true }, { role: 'coordinator', project: 'foreman', allow: true }];
  for (const bad of ['yes', 'false', 1, 0, null, {}, [true]]) {
    const eff = effectiveDevSettings({ bypass_grants: grants, bypass_ask: bad, roles: { lead: { effort: 'high' } } });
    assert.deepEqual(eff, { roles: { lead: { effort: 'high' } }, bypass_grants: [], bypass_ask: false }, JSON.stringify(bad));
    // Never written grants (the standing default) are turned off too.
    assert.deepEqual(effectiveDevSettings({ bypass_ask: bad }).bypass_grants, [], JSON.stringify(bad));
    for (const requesterRole of ['coordinator', 'lead'] as const) {
      assert.deepEqual(resolveAgentLaunchPolicy({ requesterRole, project: 'foreman', settings: eff }), { decision: 'auto', policy_reason: 'grant_off' });
    }
  }
  // Every shape that parsed before still parses to the same value (no change for valid stored values).
  for (const ask of [true, false]) {
    assert.deepEqual(effectiveDevSettings({ bypass_grants: grants, bypass_ask: ask }), { roles: {}, bypass_grants: grants, bypass_ask: ask });
    assert.deepEqual(effectiveDevSettings({ bypass_ask: ask }).bypass_grants, [...DEFAULT_BYPASS_GRANTS]);
  }
});

test('parseDevSetting validates each key strictly and drops unknown nested fields', () => {
  assert.deepEqual(parseDevSetting('bypass_ask', false), { ok: true, value: false });
  assert.equal(parseDevSetting('bypass_ask', 'false').ok, false);
  assert.deepEqual(parseDevSetting('roles', { lead: { model: 'opus', effort: 'low', extra: 1 }, investigator: {}, worker: { effort: 'low' }, junk: 1 }), { ok: true, value: { lead: { model: 'opus', effort: 'low' }, investigator: {} } });
  for (const bad of [null, [], { lead: 'x' }, { lead: { effort: 'extreme' } }, { lead: { model: 'bad model' } }, { coordinator: { model: 'opus' } }])
    assert.equal(parseDevSetting('roles', bad).ok, false, JSON.stringify(bad));
  const grants = parseDevSetting('bypass_grants', [{ role: 'lead', project: ' foreman ', allow: false, note: 'dropped' }, { role: 'coordinator', project: '*', allow: true }]);
  assert.deepEqual(grants, { ok: true, value: [{ role: 'lead', project: 'foreman', allow: false }, { role: 'coordinator', project: '*', allow: true }] });
  const tooMany = Array.from({ length: MAX_BYPASS_GRANTS + 1 }, (_, i) => ({ role: 'lead', project: `p${i}`, allow: true }));
  assert.equal(parseDevSetting('bypass_grants', tooMany).ok, false);
  assert.equal(parseDevSetting('bypass_grants', tooMany.slice(0, MAX_BYPASS_GRANTS)).ok, true);
  for (const bad of [
    {}, [null], [{ role: 'worker', project: '*', allow: true }], [{ role: 'lead', project: '', allow: true }], [{ role: 'lead', project: 'x', allow: 'yes' }],
    [{ role: 'lead', project: 'x'.repeat(201), allow: true }], [{ role: 'lead', project: 'a\nb', allow: true }],
    [{ role: 'lead', project: 'Foreman', allow: true }, { role: 'lead', project: 'foreman', allow: false }],
    [{ role: 'lead', project: '*', allow: true }, { role: 'lead', project: '*', allow: false }],
    ...PATHS.map((project) => [{ role: 'lead', project, allow: true }]),
  ]) assert.equal(parseDevSetting('bypass_grants', bad).ok, false, JSON.stringify(bad));
  assert.equal(parseDevSetting('nope' as never, true).ok, false);
});

test('#197: sameProject ignores a leading "the " like the registry key(); ambiguous grants resolve to off', () => {
  const s = (bypass_grants: unknown) => effectiveDevSettings({ bypass_grants });
  // "The Foreman" grant applies to the registered project "foreman" (and the reverse).
  const on = { requesterRole: 'coordinator' as const, settings: s([{ role: 'coordinator', project: 'The Foreman', allow: true }]) };
  assert.deepEqual(resolveAgentLaunchPolicy({ ...on, project: 'foreman' }), { decision: 'bypass', bypass_grant: 'standing:coordinator/The Foreman', policy_reason: 'standing_grant' });
  const off = s([{ role: 'coordinator', project: '*', allow: true }, { role: 'coordinator', project: 'foreman', allow: false }]);
  assert.equal(resolveAgentLaunchPolicy({ requesterRole: 'coordinator', project: 'the  Foreman', settings: off }).decision, 'auto');
  // Only a leading "the " followed by whitespace is ignored.
  assert.equal(matchBypassGrant([{ role: 'lead', project: 'theforeman', allow: true }], 'lead', 'foreman'), null);
  assert.equal(matchBypassGrant([{ role: 'lead', project: 'foreman the', allow: true }], 'lead', 'foreman'), null);
  // Backward compatible: a stored list holding both spellings still parses (it did before #197)…
  const both = [{ role: 'lead', project: 'the foreman', allow: true }, { role: 'lead', project: 'foreman', allow: false }];
  assert.equal(parseDevSetting('bypass_grants', both).ok, true);
  assert.equal(parseDevSetting('bypass_grants', [...both].reverse()).ok, true);
  // …and whichever order, the off entry wins for either spelling: ambiguity never grants Bypass.
  for (const grants of [both, [...both].reverse()]) for (const project of ['foreman', 'The Foreman']) {
    assert.deepEqual(resolveAgentLaunchPolicy({ requesterRole: 'lead', project, settings: s(grants) }), { decision: 'auto', policy_reason: 'grant_off' }, `${JSON.stringify(grants)} ${project}`);
  }
  // Two "on" spellings: the first applies (Bypass either way).
  assert.equal(matchBypassGrant([{ role: 'lead', project: 'the foreman', allow: true }, { role: 'lead', project: 'foreman', allow: true }], 'lead', 'foreman')?.project, 'the foreman');
});

test('#197: agentModeSupported is Claude only in both modes (agent launches are Claude only)', () => {
  assert.equal(agentModeSupported('codex', 'bypass'), false);
  assert.equal(agentModeSupported('codex', 'auto'), false);
  assert.equal(agentModeSupported('claude', 'bypass'), true);
  assert.equal(agentModeSupported('claude', 'auto'), true);
  assert.equal(agentModeSupported('other', 'bypass'), false);
});

test('parseSettingsPost and parseDevSettingsView', () => {
  assert.deepEqual(parseSettingsPost({ key: 'bypass_ask', value: true, version: 2 }), { ok: true, value: { key: 'bypass_ask', value: true, version: 2 } });
  assert.deepEqual(parseSettingsPost({ key: 'bypass_grants', value: [] }), { ok: true, value: { key: 'bypass_grants', value: [] } });
  for (const bad of [null, { key: 'model', value: 'x' }, { key: 'bypass_ask', value: 1 }, { key: 'bypass_ask', value: true, version: -1 }, { key: 'bypass_ask', value: true, extra: 1 }, { value: true }])
    assert.equal(parseSettingsPost(bad).ok, false, JSON.stringify(bad));
  const view = { settings: defaultDevSettings(), versions: { roles: 0, bypass_grants: 3, bypass_ask: 1 }, updated_at: 1_700_000_000_000 };
  assert.deepEqual(parseDevSettingsView(view), { ok: true, value: view });
  assert.deepEqual(parseDevSettingsView({ ...view, updated_at: null }), { ok: true, value: { ...view, updated_at: null } });
  for (const bad of [{ ...view, versions: { roles: 0, bypass_grants: 0 } }, { ...view, updated_at: 'now' }, { ...view, settings: { ...view.settings, bypass_ask: 'x' } }, null])
    assert.equal(parseDevSettingsView(bad).ok, false);
  const response: SettingsResponse = { ...view, writable: true };
  assert.equal(response.writable, true);
});

test('parseLeadHandoff round-trips, tolerates versions, drops unknown fields', () => {
  const raw = handoff();
  const parsed = parseLeadHandoff(raw);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, raw);
  assert.notEqual(parsed.value, raw);
  assert.deepEqual(parseLeadHandoff(JSON.parse(JSON.stringify(parsed.value))), parsed);
  const noV = handoff(); delete noV.v;
  assert.deepEqual(parseLeadHandoff(noV), { ok: true, value: raw });
  const v2 = parseLeadHandoff(handoff({ v: 2, future_field: { x: 1 }, cwd: '/Users/hong/secret' }));
  assert.ok(v2.ok);
  assert.equal(v2.value.v, 1);
  assert.equal('future_field' in v2.value, false);
  assert.equal('cwd' in v2.value, false);
  const upper = parseLeadHandoff(handoff({ lead: `fm:${LEAD.slice(3).toUpperCase()}` }));
  assert.ok(upper.ok);
  assert.equal(upper.value.lead, LEAD);
  for (const kind of HANDOFF_KINDS) assert.ok(parseLeadHandoff(handoff({ kind })).ok, kind);
  for (const status of HANDOFF_STATUSES) assert.ok(parseLeadHandoff(handoff({ status })).ok, status);
  assert.ok(parseLeadHandoff(handoff({ summary: '' })).ok);
});

test('parseLeadHandoff rejects bad values, bounds and paths', () => {
  const rejects: [string, unknown][] = [
    ['v 0', handoff({ v: 0 })], ['v 1.5', handoff({ v: 1.5 })], ['v string', handoff({ v: '1' })],
    ['lead not fm uuid', handoff({ lead: 'claude:abc' })], ['seq negative', handoff({ seq: -1 })], ['seq float', handoff({ seq: 1.5 })],
    ['at not ISO', handoff({ at: 'yesterday' })], ['kind', handoff({ kind: 'draft' })], ['status', handoff({ status: 'paused' })],
    ['project empty', handoff({ project: '' })], ['project too long', handoff({ project: 'p'.repeat(201) })],
    ['workstream not kebab', handoff({ workstream: 'Portable PM' })], ['workstream too long', handoff({ workstream: 'a'.repeat(65) })],
    ['goal blank', handoff({ goal: '   ' })], ['goal too long', handoff({ goal: 'g'.repeat(1001) })],
    ['summary too long', handoff({ summary: 's'.repeat(4001) })], ['summary control char', handoff({ summary: 'a\u0007b' })],
    ['decisions too many', handoff({ decisions: Array(31).fill('d') })], ['decision too long', handoff({ decisions: ['d'.repeat(501)] })],
    ['decision blank', handoff({ decisions: [' '] })], ['open_questions too many', handoff({ open_questions: Array(21).fill('q') })],
    ['next_steps too many', handoff({ next_steps: Array(21).fill('n') })], ['next_steps not array', handoff({ next_steps: 'n' })],
    ['links too many', handoff({ links: Array(31).fill({ label: 'x', url: 'https://example.com' }) })],
    ['link http', handoff({ links: [{ label: 'x', url: 'http://example.com' }] })],
    ['link javascript', handoff({ links: [{ label: 'x', url: 'javascript:alert(1)' }] })],
    ['link userinfo', handoff({ links: [{ label: 'x', url: 'https://user@evil.example' }] })],
    ['link branch dotdot', handoff({ links: [{ label: 'x', url: 'branch:a/../b' }] })],
    ['link branch leading dash', handoff({ links: [{ label: 'x', url: 'branch:-f' }] })],
    ['link file', handoff({ links: [{ label: 'x', url: 'file:///etc/passwd' }] })],
    ['link label multi-line', handoff({ links: [{ label: 'a\nb', url: 'https://example.com' }] })],
    ['workers too many', handoff({ workers: Array(21).fill({ session_key: 'fm:x', name: 'w', state: 'idle' }) })],
    ['worker bad state', handoff({ workers: [{ session_key: 'fm:x', name: 'w', state: 'sleeping' }] })],
    ['worker path name', handoff({ workers: [{ session_key: 'fm:x', name: '/Users/hong', state: 'idle' }] })],
    ['missing workers', (() => { const h = handoff(); delete h.workers; return h; })()],
    ['null', null], ['array', [handoff()]],
  ];
  for (const path of PATHS) {
    rejects.push([`project path ${path}`, handoff({ project: path })]);
    rejects.push([`workstream path ${path}`, handoff({ workstream: path })]);
    rejects.push([`link label path ${path}`, handoff({ links: [{ label: path, url: 'https://example.com' }] })]);
  }
  for (const [label, raw] of rejects) assert.equal(parseLeadHandoff(raw).ok, false, label);
  // Serialized size bound: a handoff at the field bounds with multibyte text exceeds 32 KiB.
  const huge = handoff({ summary: '\u{1F600}'.repeat(2000), decisions: Array(30).fill('\u00e9'.repeat(500)), goal: '\u{1F600}'.repeat(500) });
  const result = parseLeadHandoff(huge);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /exceeds 32768 bytes/);
  const fits = parseLeadHandoff(handoff({ summary: 's'.repeat(4000) }));
  assert.ok(fits.ok && utf8Length(JSON.stringify(fits.value)) <= MAX_HANDOFF_BYTES);
  assert.equal(looksLikeAbsolutePath('foreman'), false);
  assert.equal(looksLikeAbsolutePath('~/x'), true);
  assert.equal(workstreamKey('Portable PM: state!'), 'portable-pm-state');
  assert.equal(workstreamKey('/Users/hong'), 'users-hong');
  assert.equal(workstreamKey('!!!'), null);
});

test('parseLeadRecord round-trips, tolerates versions, drops unknown fields and cwd', () => {
  const raw = record();
  const parsed = parseLeadRecord(raw);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, raw);
  const minimal = record(); for (const k of ['bypass_grant', 'policy_reason', 'last_handoff']) delete minimal[k];
  assert.deepEqual(parseLeadRecord(minimal), { ok: true, value: minimal });
  const noV = record(); delete noV.v;
  assert.deepEqual(parseLeadRecord(noV), { ok: true, value: raw });
  const future = parseLeadRecord(record({ v: 7, cwd: '/Users/hong/code/foreman', shiny: true, machine_id: MID.toUpperCase() }));
  assert.ok(future.ok);
  assert.equal(future.value.v, 1);
  assert.equal(future.value.machine_id, MID);
  assert.equal('cwd' in future.value, false);
  assert.equal('shiny' in future.value, false);
  assert.ok(parseLeadRecord(record({ permission_mode: null, state: 'needs_input', end_reason: 'Launch approval expired; nothing was launched', supersedes: LEAD2, superseded_by: LEAD2 })).ok);
});

test('parseLeadRecord rejects bad values', () => {
  const rejects: [string, unknown][] = [
    ['v 0', record({ v: 0 })], ['lead', record({ lead: 'codex:x' })], ['machine_id', record({ machine_id: 'not-a-uuid' })],
    ['machine_name', record({ machine_name: '' })], ['name path', record({ name: '/tmp/x' })], ['name too long', record({ name: 'n'.repeat(201) })],
    ['model', record({ model: 'bad model' })], ['effort', record({ effort: 'extreme' })], ['permission native', record({ permission_mode: 'native' })],
    ['launched_by lead', record({ launched_by: LEAD2 })], ['launched_by other', record({ launched_by: 'someone' })],
    ['state', record({ state: 'sleeping' })], ['alive', record({ alive: 'yes' })], ['created_at', record({ created_at: -1 })],
    ['updated_at string', record({ updated_at: AT })], ['pending_approvals', record({ pending_approvals: -1 })],
    ['workers too many', record({ workers: Array(21).fill({ session_key: 'fm:x', name: 'w', state: 'idle', permission_mode: 'auto', needs_attention: false }) })],
    ['worker native', record({ workers: [{ session_key: 'fm:x', name: 'w', state: 'idle', permission_mode: 'native', needs_attention: false }] })],
    ['worker needs_attention', record({ workers: [{ session_key: 'fm:x', name: 'w', state: 'idle', permission_mode: 'auto' }] })],
    ['bypass_grant', record({ bypass_grant: 'always' })], ['policy_reason', record({ policy_reason: 'because' })],
    ['end_reason too long', record({ end_reason: 'e'.repeat(301) })], ['supersedes', record({ supersedes: 'x' })],
    ['last_handoff summary too long', record({ last_handoff: { seq: 1, at: AT, kind: 'final', status: 'done', summary: 's'.repeat(501) } })],
    ['last_handoff kind', record({ last_handoff: { seq: 1, at: AT, kind: 'x', status: 'done', summary: '' } })],
    ['null', null],
  ];
  for (const path of PATHS) {
    rejects.push([`project path ${path}`, record({ project: path })]);
    rejects.push([`workstream path ${path}`, record({ workstream: path })]);
  }
  for (const [label, raw] of rejects) assert.equal(parseLeadRecord(raw).ok, false, label);
  // Serialized bound.
  const big = record({ goal: '\u{1F600}'.repeat(500), workers: Array.from({ length: 20 }, (_, i) => ({ session_key: `fm:${'k'.repeat(290)}${i}`, name: '\u{1F600}'.repeat(100), state: 'idle', permission_mode: 'auto', needs_attention: false })) });
  assert.match((parseLeadRecord(big) as { error: string }).error, /exceeds 16384 bytes/);
});

test('parseLeadListEntry and lastHandoffOf', () => {
  const entry = { ...record(), machine_online: false, reported_at: 1_700_000_200_000, ended: false };
  assert.deepEqual(parseLeadListEntry(entry), { ok: true, value: entry });
  assert.equal(parseLeadListEntry(record()).ok, false);
  assert.equal(parseLeadListEntry({ ...entry, reported_at: 'x' }).ok, false);
  const h = parseLeadHandoff(handoff({ summary: 'x'.repeat(499) + '\u{1F600}' + 'y'.repeat(100) }));
  assert.ok(h.ok);
  const last = lastHandoffOf(h.value);
  assert.equal(last.summary.length <= 500, true);
  assert.ok(last.summary.endsWith('…'));
  assert.ok(parseLeadRecord(record({ last_handoff: last })).ok);
  const response: LeadsResponse = { leads: [entry as never], mode: 'relay' };
  assert.equal(response.mode, 'relay');
});

test('lead_rpc: every op round-trips; strict envelopes and args', () => {
  const frames: [string, unknown][] = [
    ['lead.upsert', { record: record() }],
    ['lead.handoff', { handoff: handoff() }],
    ['lead.sync', { records: [record(), record({ lead: LEAD2 })] }],
    ['lead.list', {}],
    ['lead.list', { include_ended: true, limit: 200 }],
    ['lead.get', { lead: LEAD }],
    ['lead.get', { lead: LEAD, handoffs: 5 }],
    ['settings.get', {}],
  ];
  for (const [op, args] of frames) {
    const raw = { type: 'lead_rpc', id: 'r-1', op, args };
    const parsed = parseLeadRpc(raw);
    assert.ok(parsed.ok, `${op}: ${!parsed.ok && parsed.error}`);
    assert.deepEqual(parsed.value, raw, op);
  }
  const rejects: [string, unknown, string | null, string][] = [
    ['not a frame', { type: 'pm_rpc', id: 'r', op: 'lead.list', args: {} }, null, 'invalid'],
    ['bad id', { type: 'lead_rpc', id: 'a b', op: 'lead.list', args: {} }, null, 'invalid'],
    ['epoch is not a lead_rpc key', { type: 'lead_rpc', id: 'r', epoch: 1, op: 'lead.list', args: {} }, 'r', 'invalid'],
    ['unknown op', { type: 'lead_rpc', id: 'r', op: 'lead.delete', args: {} }, 'r', 'invalid'],
    ['args extra key', { type: 'lead_rpc', id: 'r', op: 'settings.get', args: { x: 1 } }, 'r', 'invalid'],
    ['list limit 0', { type: 'lead_rpc', id: 'r', op: 'lead.list', args: { limit: 0 } }, 'r', 'invalid'],
    ['list limit 201', { type: 'lead_rpc', id: 'r', op: 'lead.list', args: { limit: 201 } }, 'r', 'invalid'],
    ['get handoffs 6', { type: 'lead_rpc', id: 'r', op: 'lead.get', args: { lead: LEAD, handoffs: 6 } }, 'r', 'invalid'],
    ['get bad lead', { type: 'lead_rpc', id: 'r', op: 'lead.get', args: { lead: 'x' } }, 'r', 'invalid'],
    ['bad record', { type: 'lead_rpc', id: 'r', op: 'lead.upsert', args: { record: record({ project: '/etc' }) } }, 'r', 'invalid'],
    ['sync duplicate', { type: 'lead_rpc', id: 'r', op: 'lead.sync', args: { records: [record(), record()] } }, 'r', 'invalid'],
    ['sync too many', { type: 'lead_rpc', id: 'r', op: 'lead.sync', args: { records: Array(51).fill(record()) } }, 'r', 'too_large'],
    ['handoff too large', { type: 'lead_rpc', id: 'r', op: 'lead.handoff', args: { handoff: handoff({ summary: '\u{1F600}'.repeat(2000), decisions: Array(30).fill('\u00e9'.repeat(500)) }) } }, 'r', 'too_large'],
    ['frame too large', { type: 'lead_rpc', id: 'r', op: 'lead.sync', args: { records: Array.from({ length: 50 }, () => record({ goal: 'g'.repeat(1000) })) } }, 'r', 'too_large'],
  ];
  for (const [label, raw, id, code] of rejects) {
    const parsed = parseLeadRpc(raw);
    assert.equal(parsed.ok, false, label);
    if (!parsed.ok) { assert.equal(parsed.id, id, label); assert.equal(parsed.code, code, label); }
  }
  assert.equal(parseLeadOpArgs('lead.list', null).ok, false);
});

test('lead_rpc_result: envelope, per-op results, redacted bounded errors', () => {
  const ok = leadRpcOk('r-1', 'lead.handoff', { stored: false });
  assert.deepEqual(parseLeadRpcResult(ok), { ok: true, value: ok });
  const err = leadRpcError('r-1', 'forbidden', `Row belongs to another machine; token=abcdefgh12345678 ${'x'.repeat(500)}`);
  assert.equal(err.ok, false);
  if (!err.ok) {
    assert.ok(err.message.length <= 300);
    assert.equal(err.message.includes('abcdefgh12345678'), false);
  }
  assert.ok(parseLeadRpcResult(err).ok);
  for (const bad of [
    { type: 'lead_rpc_result', id: 'r', ok: false, code: 'stale_epoch', message: 'x' },
    { type: 'lead_rpc_result', id: 'r', ok: false, code: 'invalid', message: 'x'.repeat(301) },
    { type: 'lead_rpc_result', id: 'r', ok: true },
    { type: 'lead_rpc_result', id: 'r', ok: 'yes', result: {} },
    { type: 'lead_rpc_result', id: 'r', ok: true, result: {}, extra: 1 },
  ]) assert.equal(parseLeadRpcResult(bad).ok, false, JSON.stringify(bad).slice(0, 80));
  const entry = { ...record(), machine_online: true, reported_at: 1, ended: false };
  assert.deepEqual(parseLeadOpResult('lead.upsert', {}), { ok: true, value: {} });
  assert.deepEqual(parseLeadOpResult('lead.sync', {}), { ok: true, value: {} });
  assert.equal(parseLeadOpResult('lead.upsert', { x: 1 }).ok, false);
  assert.deepEqual(parseLeadOpResult('lead.handoff', { stored: true }), { ok: true, value: { stored: true } });
  assert.equal(parseLeadOpResult('lead.handoff', { stored: 1 }).ok, false);
  assert.deepEqual(parseLeadOpResult('lead.list', { leads: [entry] }), { ok: true, value: { leads: [entry] } });
  assert.equal(parseLeadOpResult('lead.list', { leads: Array(201).fill(entry) }).ok, false);
  assert.deepEqual(parseLeadOpResult('lead.get', { lead: entry, handoffs: [handoff()] }), { ok: true, value: { lead: entry, handoffs: [handoff()] } });
  assert.equal(parseLeadOpResult('lead.get', { lead: entry, handoffs: Array(6).fill(handoff()) }).ok, false);
  const view = { settings: defaultDevSettings(), versions: { roles: 0, bypass_grants: 0, bypass_ask: 0 }, updated_at: null };
  assert.deepEqual(parseLeadOpResult('settings.get', view), { ok: true, value: view });
  assert.equal(parseLeadOpResult('settings.get', {}).ok, false);
});

test('launch approval input and first-task truncation', () => {
  const input = { name: 'lead-portable-pm', project: 'foreman', cwd: '/Users/hong/code/foreman', provider: 'claude', model: 'opus[1m]', effort: 'medium', role: 'lead', requested_by: 'coordinator', first_task: 'Do the thing' };
  assert.deepEqual(parseLaunchApprovalInput(input), { ok: true, value: input });
  assert.ok(parseLaunchApprovalInput({ ...input, project: null, requested_by: LEAD, role: 'worker' }).ok);
  for (const bad of [{ ...input, provider: 'codex' }, { ...input, cwd: 'relative/dir' }, { ...input, requested_by: 'developer' }, { ...input, first_task: 'x'.repeat(2001) }, { ...input, extra: 1 }, { ...input, role: 'session' }])
    assert.equal(parseLaunchApprovalInput(bad).ok, false, JSON.stringify(bad).slice(0, 80));
  assert.equal(truncateFirstTask('short'), 'short');
  const cut = truncateFirstTask('x'.repeat(1998) + '\u{1F600}' + 'y'.repeat(10));
  assert.ok(cut.length <= MAX_FIRST_TASK && cut.endsWith('…'));
  assert.ok(parseLaunchApprovalInput({ ...input, first_task: cut }).ok);
});

test('host interfaces are implementable (type-level)', () => {
  const store: LeadStore = {
    mode: 'local', devSettings: async () => null, upsert() {}, track() {},
    appendHandoff: async () => { const h = parseLeadHandoff(handoff()); if (!h.ok) throw new Error(h.error); return h.value; },
    list: async () => [], get: async () => null, latestHandoff: async () => null, close() {},
  };
  const service: AgentSessionService = {
    launchAgent: async () => ({ session_key: LEAD, name: 'lead-x', status: 'started', permission_mode: 'bypass', bypass_grant: 'standing:coordinator/*', policy_reason: 'standing_grant' }),
    retire: async () => {}, list: () => [], detail: () => null,
  };
  assert.equal(store.mode, 'local');
  assert.equal(typeof service.launchAgent, 'function');
});

test('#157 D7: the relay allowlist no longer accepts /api/launch*; Lead and settings routes are not relayed', () => {
  for (const [method, path] of [['GET', '/api/launch'], ['GET', '/api/launch?id=1'], ['POST', '/api/launch/propose'], ['POST', '/api/launch/cancel'], ['POST', '/api/launch']])
    assert.equal(allowedRequest(method, path), false, `${method} ${path}`);
  for (const [method, path] of [['GET', LEADS_ROUTE], ['GET', SETTINGS_ROUTE], ['POST', SETTINGS_ROUTE]])
    assert.equal(allowedRequest(method, path), false, `${method} ${path}`);
  // Unchanged routes still pass.
  for (const [method, path] of [['GET', '/api/sessions'], ['POST', '/api/sessions'], ['GET', '/api/pm/history'], ['POST', '/api/pm/message'], ['POST', '/api/projects/resolve']])
    assert.equal(allowedRequest(method, path), true, `${method} ${path}`);
});

test('#157 D8: push text says Coordinator and machine, never Mac', () => {
  const AT2 = '2026-09-25T00:00:00.000Z';
  const events = [
    ...NOTIFY_KINDS.map((kind) => ({ type: 'notify', id: 'x', kind, host: 'h', ...(kind === 'pm_failed' ? {} : { session_key: 'fm:1' }), at: AT2 }) as NotifyFrame),
    { kind: 'host_offline' as const, host: '', at: AT2 },
  ];
  const text = events.map((e) => { const p = buildPushPayload(e); return `${p.title} ${p.body}`; }).join('\n');
  assert.match(text, /Coordinator/);
  assert.match(text, /Machine offline/);
  assert.doesNotMatch(text, /\bMac\b|\bPM\b|project manager/i);
});
