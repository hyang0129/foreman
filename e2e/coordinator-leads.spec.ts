import { test, expect, devices, type Page } from "@playwright/test";

// Epic #157 (CL-07): the Coordinator (the PM, renamed in presentation only), Project Leads as chats,
// workers nested under their Lead, the Archived group, the "Launch with Bypass" card, the ⚠ Bypass /
// Auto labels, the Lead info screen, Settings, and the manual-only New session with "Ask the
// Coordinator". Fixture data follows shared/roles.ts (SessionRoleFields on session rows,
// LeadsResponse from GET /api/leads, DevSettingsView + writable from GET/POST /api/settings, the
// held-launch approval with tool `foreman.launch_bypass`). Galaxy S24 emulation, as #154's spec.
const { defaultBrowserType: _browser, ...s24 } = devices["Galaxy S24"];
test.use({ ...s24 });

const now = Date.now();
const iso = (ago: number) => new Date(now - ago).toISOString();
const M = "6f1c2b8e-4a3d-4c5e-9f70-1a2b3c4d5e6f";
const TRIAGE = "fm:11111111-1111-4111-8111-111111111111";
const DOCS = "fm:22222222-2222-4222-8222-222222222222";
const OLD = "fm:33333333-3333-4333-8333-333333333333";
const RISKY = "fm:44444444-4444-4444-8444-444444444444";
const DENIED = "fm:55555555-5555-4555-8555-555555555555";
const WORKER = "fm:66666666-6666-4666-8666-666666666666";
const APPROVED = "fm:77777777-7777-4777-8777-777777777777";
const LAUNCH_DENIED = "Bypass launch denied by developer; nothing ran";
const LAUNCH_EXPIRED = "Launch approval expired; nothing was launched";
const caps = { message: true, interrupt: true, approvals: true };
const base = { provider: "claude", managed: true, capabilities: caps, cwd: "/Users/dev/code/app", project_name: "app", model: "opus[1m]" };

function rows() {
  return [
    { ...base, session_key: "fm:dev", session_id: "dev", name: "Fix sign-in", state: "turn_finished", permission_mode: "bypass", model: "sonnet",
      updated_at: iso(3 * 60_000), last_message: "Signed in fine." },
    { ...base, session_key: TRIAGE, session_id: "triage", name: "lead-triage", state: "working", current_tool: "Agent", role: "lead", launched_by: "coordinator",
      workstream: "triage", effort: "medium", permission_mode: "bypass", bypass_grant: "standing:coordinator/*", policy_reason: "standing_grant", updated_at: iso(60_000) },
    { ...base, session_key: DOCS, session_id: "docs", name: "lead-docs", state: "turn_finished", role: "lead", launched_by: "coordinator",
      workstream: "docs", effort: "high", permission_mode: "auto", policy_reason: "grant_off", updated_at: iso(10 * 60_000), last_message: "Docs are drafted." },
    { ...base, session_key: APPROVED, session_id: "approved", name: "lead-release", state: "idle", role: "lead", launched_by: "coordinator",
      workstream: "release", effort: "medium", permission_mode: "bypass", bypass_grant: "approved:launch-0", policy_reason: "approved", updated_at: iso(20 * 60_000) },
    { ...base, session_key: OLD, session_id: "old", name: "lead-triage-old", state: "ended", role: "lead", launched_by: "coordinator",
      workstream: "triage", superseded_by: TRIAGE, permission_mode: "bypass", bypass_grant: "standing:coordinator/*", end_reason: `superseded by ${TRIAGE}`, updated_at: iso(2 * 3600_000) },
    { ...base, session_key: DENIED, session_id: "denied", name: "lead-denied", state: "ended", role: "lead", launched_by: "coordinator",
      permission_mode: null, end_reason: LAUNCH_DENIED, updated_at: iso(3 * 3600_000) },
    { ...base, session_key: WORKER, session_id: "worker", name: "fix-tests", state: "working", role: "worker", launched_by: TRIAGE, parent: TRIAGE,
      permission_mode: "bypass", bypass_grant: "standing:lead/*", policy_reason: "standing_grant", updated_at: iso(30_000), current_tool: "Bash" },
    { ...base, session_key: "claude:pm", session_id: "pm", name: "foreman-pm", state: "idle", managed: false, updated_at: iso(1000) },
  ];
}
const held = { ...base, session_key: RISKY, session_id: "risky", name: "lead-risky", state: "needs_input", reason: "awaiting_bypass_approval", role: "lead",
  launched_by: "coordinator", workstream: "risky", effort: "medium", permission_mode: null, updated_at: iso(5000),
  capabilities: { message: false, interrupt: false, approvals: true } };
const launchApproval = {
  id: "launch-1", kind: "permission", tool: "foreman.launch_bypass",
  input: { name: "lead-risky", project: "app", cwd: "/Users/dev/code/app", provider: "claude", model: "opus[1m]", effort: "medium", role: "lead",
    requested_by: "coordinator", first_task: "Rewrite the deploy script and run it.\nThen report back." },
};
function leadEntries() {
  const entry = (lead: string, extra: any) => ({
    v: 1, lead, machine_id: M, machine_name: "machine-a", project: "app", goal: "Goal", model: "opus[1m]", effort: "medium", launched_by: "coordinator",
    alive: true, created_at: now - 3600_000, updated_at: now - 60_000, pending_approvals: 0, workers: [], machine_online: true, reported_at: now - 30_000, ended: false, ...extra,
  });
  return [
    entry(TRIAGE, { name: "lead-triage", workstream: "triage", state: "working", permission_mode: "bypass", bypass_grant: "standing:coordinator/*",
      workers: [{ session_key: WORKER, name: "fix-tests", state: "working", permission_mode: "bypass", needs_attention: false }],
      last_handoff: { seq: 3, at: iso(4 * 60_000), kind: "checkpoint", status: "in_progress", summary: "Triaged 12 bugs; 3 need a decision." } }),
    entry(DOCS, { name: "lead-docs", workstream: "docs", effort: "high", state: "turn_finished", permission_mode: "auto", machine_online: false,
      reported_at: Date.parse("2026-09-20T10:15:00Z") }),
    entry(OLD, { name: "lead-triage-old", workstream: "triage", state: "ended", alive: false, permission_mode: "bypass", superseded_by: TRIAGE, ended: true }),
  ];
}
const defaultSettings = () => ({
  settings: { roles: {}, bypass_grants: [{ role: "coordinator", project: "*", allow: true }, { role: "lead", project: "*", allow: true }], bypass_ask: false },
  versions: { roles: 0, bypass_grants: 0, bypass_ask: 0 }, updated_at: null,
});

async function fixture(page: Page, options: { writable?: boolean; leads?: boolean; settings?: boolean; auth?: any } = {}) {
  const state = {
    sessions: rows() as any[],
    approvals: {} as Record<string, any[]>,
    leads: leadEntries() as any[],
    settings: defaultSettings() as any,
    writable: options.writable ?? true,
    conflict: false,
    pmHistory: [{ role: "assistant", text: "Coordinator here. What are we working on?", ts: iso(60_000) }] as any[],
    calls: [] as { path: string; method: string; body: any }[],
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const body = request.method() === "POST" ? request.postDataJSON() : null;
    state.calls.push({ path, method: request.method(), body });
    let result: any = {}, status = 200;
    if (path === "/api/config") result = { auth: options.auth ?? { required: false } };
    else if (path === "/api/host") result = { online: true, host: "machine-a", machine_id: M };
    else if (path === "/api/pm/host" && request.method() === "GET") result = {
      active: { machine_id: M, name: "machine-a", online: true, epoch: 1 },
      machines: [{ machine_id: M, name: "machine-a", platform: "darwin", online: true, last_seen: now, active: true }], mode: "relay",
    };
    else if (path === "/api/sessions" && request.method() === "GET") result = state.sessions;
    else if (path === "/api/sessions") {
      result = { ...base, session_key: "fm:new", session_id: "new", name: body.name, cwd: body.cwd, state: "working", permission_mode: body.permission_mode, updated_at: iso(0) };
      state.sessions.push(result);
    } else if (path === "/api/session") {
      const session = state.sessions.find((s) => s.session_key === url.searchParams.get("id"));
      result = { session, history: [{ id: "h1", role: "assistant", text: `History of ${session?.name}`, at: iso(60_000) }], receipts: [], approvals: state.approvals[session?.session_key] || [] };
    } else if (path === "/api/session/approval") {
      state.approvals[body.id] = (state.approvals[body.id] || []).filter((a) => a.id !== body.approval_id);
      result = { ok: true };
    } else if (path === "/api/leads") {
      if (options.leads === false) { status = 404; result = { error: "Not found" }; }
      else result = { leads: state.leads, mode: "relay" };
    } else if (path === "/api/settings" && request.method() === "GET") {
      if (options.settings === false) { status = 404; result = { error: "Not found" }; }
      else result = { ...state.settings, writable: state.writable };
    } else if (path === "/api/settings") {
      if (!state.writable) { status = 403; result = { error: "Settings are read-only here" }; }
      else if (state.conflict || (body.version !== undefined && body.version !== state.settings.versions[body.key])) {
        state.conflict = false;
        status = 409; result = { error: "Version conflict" };
      } else {
        state.settings.settings[body.key] = body.value;
        state.settings.versions[body.key]++;
        state.settings.updated_at = Date.now();
        result = { ...state.settings, writable: true };
      }
    } else if (path === "/api/pm/history") result = { history: state.pmHistory, busy: false, error: null, model: null };
    else if (path === "/api/pm/message") { state.pmHistory.push({ role: "user", text: body.text, ts: iso(0) }); result = { ok: true }; }
    else if (path === "/api/models") result = { models: [{ value: "opus[1m]", displayName: "Opus 5.5" }, { value: "sonnet", displayName: "Sonnet" }] };
    else if (path === "/api/projects") result = { projects: [{ id: "p-app", name: "app", path: "/Users/dev/code/app", canonicalPath: "/Users/dev/code/app", aliases: [] }] };
    else if (path === "/api/projects/resolve") result = { status: "resolved", path: "/Users/dev/code/app", project: { id: "p-app", name: "app", path: "/Users/dev/code/app", aliases: [] } };
    else { status = 404; result = { error: "Unknown mock route" }; }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(result) });
  });
  return state;
}
const pollNow = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("online")));
async function openRail(page: Page) {
  await page.getByRole("button", { name: "Open session navigation" }).tap();
  await expect(page.locator("#rail")).toBeInViewport();
}
const railRows = (page: Page) => page.locator("#session-list > .session-row");
async function openChat(page: Page, name: RegExp) {
  await openRail(page);
  await page.locator("#session-list").getByRole("button", { name }).tap();
}

test("the Coordinator is pinned and named; Leads are chats, workers are hidden, ended Leads are archived", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  // The home view is the Coordinator, named in the header and pinned above the list.
  await expect(page.getByRole("heading", { name: "Coordinator", exact: true })).toBeVisible();
  await expect(page.getByText("Coordinator here. What are we working on?")).toBeVisible();
  await expect(page.getByLabel("Message this session")).toHaveAttribute("placeholder", "What are we working on?");
  await openRail(page);
  const pinned = page.locator("#select-pm");
  await expect(pinned).toContainText("Coordinator");
  await expect(pinned).toContainText("PINNED");
  await expect(page.locator("#rail")).not.toContainText(/project manager/i);
  // Leads and your own sessions are chats, most recent first; the worker and the Coordinator's
  // own provider session are not rows.
  await expect(railRows(page).locator(".session-name")).toHaveText([/^lead-triage/, /^Fix sign-in/, /^lead-docs/, /^lead-release/]);
  await expect(railRows(page).filter({ hasText: "lead-triage" }).locator(".role-tag")).toHaveText("Lead");
  await expect(railRows(page).filter({ hasText: "Fix sign-in" }).locator(".role-tag")).toHaveCount(0);
  await expect(page.locator("#session-list")).not.toContainText("fix-tests");
  await expect(page.locator("#session-list")).not.toContainText("foreman-pm");
  expect((await railRows(page).first().boundingBox())!.y).toBeGreaterThan((await pinned.boundingBox())!.y);
  // Superseded and ended Leads sit under Archived, closed until opened.
  const archived = page.locator(".archived-group");
  await expect(archived.locator("summary")).toHaveText("Archived · 2");
  await expect(archived.getByRole("button", { name: /lead-triage-old/ })).toBeHidden();
  await archived.locator("summary").tap();
  await expect(archived.locator(".session-row .session-name")).toHaveText([/^lead-triage-old/, /^lead-denied/]);
  await expect(archived.getByRole("button", { name: /lead-denied/ }).locator(".session-sub")).toHaveText("Bypass launch denied; nothing ran.");
  // It stays open across polls, and the archived chat opens from there.
  await pollNow(page);
  await archived.getByRole("button", { name: /lead-triage-old/ }).tap();
  await expect(page.getByRole("heading", { name: "app · Lead", exact: true })).toBeVisible();
  await expect(page.getByText("History of lead-triage-old")).toBeVisible();
});

test("a worker surfaces in the list while it needs you, labeled via its Lead, and its approval works", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/");
  await openRail(page);
  await expect(page.locator("#session-list")).not.toContainText("fix-tests");
  // The worker asks for a tool approval: it surfaces, first, labeled "<worker> · via <lead>".
  const worker = state.sessions.find((s) => s.session_key === WORKER);
  Object.assign(worker, { state: "needs_input", reason: "Can I run npm test?" });
  state.approvals[WORKER] = [{ id: "a1", kind: "permission", tool: "Bash", input: { command: "npm test" } }];
  await pollNow(page);
  const row = railRows(page).first();
  await expect(row.locator(".session-name")).toHaveText(/^fix-tests · via lead-triage/);
  await expect(row.locator(".attention-badge")).toHaveText("Needs you");
  await expect(row.locator(".session-sub")).toHaveText("Can I run npm test?");
  await expect(row.locator(".policy-tag")).toHaveText("⚠ Bypass · standing");
  await row.tap();
  // An ordinary tool approval is unchanged: Allow once / Deny.
  await expect(page.getByRole("heading", { name: "Permission requested · Bash" })).toBeVisible();
  await page.getByRole("button", { name: "Allow once", exact: true }).tap();
  await expect.poll(() => state.calls.find((c) => c.path === "/api/session/approval")?.body).toEqual({ id: WORKER, approval_id: "a1", decision: "allow" });
  // Once it no longer needs you (and is not open), it is hidden again.
  Object.assign(worker, { state: "working", reason: null });
  await page.getByRole("button", { name: "Open session navigation" }).tap();
  await page.locator("#select-pm").tap();
  await pollNow(page);
  await openRail(page);
  await expect(page.locator("#session-list")).not.toContainText("fix-tests");
});

test("agent-launched sessions show ⚠ Bypass (standing or approved) or Auto; your own sessions show no label", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  await openRail(page);
  const tag = (name: string) => railRows(page).filter({ hasText: name }).locator(".policy-tag");
  await expect(tag("lead-triage")).toHaveText("⚠ Bypass · standing");
  await expect(tag("lead-triage")).toHaveClass(/is-bypass/);
  await expect(tag("lead-release")).toHaveText("⚠ Bypass · approved");
  await expect(tag("lead-docs")).toHaveText("Auto");
  await expect(tag("lead-docs")).not.toHaveClass(/is-bypass/);
  // A session you started yourself in Bypass keeps its policy on its info screen, not a list label.
  await expect(tag("Fix sign-in")).toHaveCount(0);
  // The label is spelled out on the info screen.
  await railRows(page).filter({ hasText: "lead-docs" }).tap();
  await page.getByRole("heading", { name: "app · Lead", exact: true }).tap();
  await expect(page.locator("#conversation-subtitle")).toContainText("Auto · Claude decides routine permissions");
  await page.getByRole("button", { name: "Close info" }).tap();
  await openChat(page, /lead-release/);
  await page.getByRole("heading", { name: "app · Lead", exact: true }).tap();
  await expect(page.locator("#conversation-subtitle")).toContainText("⚠ Bypass · no permission prompts · you approved this launch");
});

test("a held launch shows a Launch with Bypass card that approves with the existing approval route", async ({ page }) => {
  const state = await fixture(page);
  state.sessions.push(structuredClone(held));
  state.approvals[RISKY] = [structuredClone(launchApproval)];
  await page.goto("/");
  await openRail(page);
  const row = railRows(page).first();
  await expect(row.locator(".session-name")).toHaveText(/^lead-risky/);
  await expect(row.locator(".session-sub")).toHaveText("Launch with Bypass? Waiting for your approval");
  await expect(row.locator(".attention-badge")).toHaveText("Needs you");
  await row.tap();
  const card = page.locator(".approval.launch-approval");
  await expect(card.getByRole("heading", { name: "Launch with Bypass?" })).toBeVisible();
  await expect(card).toContainText("Nothing has run yet.");
  for (const [label, value] of [["Session", "lead-risky"], ["Project", "app"], ["Directory", "/Users/dev/code/app"], ["Agent", "Claude · opus[1m] · medium"],
    ["Role", "Project Lead"], ["Requested by", "The Coordinator"]] as const) {
    await expect(card.locator("dt", { hasText: label })).toBeVisible();
    await expect(card.locator("dt", { hasText: label }).locator("+ dd")).toHaveText(value);
  }
  await expect(card.locator(".launch-task")).toHaveText("Rewrite the deploy script and run it.\nThen report back.");
  // No generic tool wording or raw JSON on this card.
  await expect(card).not.toContainText("Permission requested");
  await expect(card.getByText("Show details")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Allow once" })).toHaveCount(0);
  const launch = card.getByRole("button", { name: "Launch with Bypass", exact: true });
  await expect(launch).toBeInViewport();
  await launch.tap();
  await expect.poll(() => state.calls.filter((c) => c.path === "/api/session/approval").map((c) => c.body)).toEqual([
    { id: RISKY, approval_id: "launch-1", decision: "allow" },
  ]);
  await expect(card).toHaveCount(0);
});

test("denying a held launch posts deny and the chat says nothing ran; an expired launch says nothing was launched", async ({ page }) => {
  const state = await fixture(page);
  state.sessions.push(structuredClone(held));
  state.approvals[RISKY] = [structuredClone(launchApproval)];
  await page.goto(`/?session=${encodeURIComponent(RISKY)}`);
  const card = page.locator(".approval.launch-approval");
  await card.getByRole("button", { name: "Deny", exact: true }).tap();
  await expect.poll(() => state.calls.filter((c) => c.path === "/api/session/approval").map((c) => c.body)).toEqual([
    { id: RISKY, approval_id: "launch-1", decision: "deny" },
  ]);
  // The host ends the held record: nothing ran.
  Object.assign(state.sessions.find((s) => s.session_key === RISKY), { state: "ended", reason: null, end_reason: LAUNCH_DENIED });
  await pollNow(page);
  await expect(page.locator(".launch-outcome")).toHaveText("Bypass launch denied; nothing ran.");
  await expect(card).toHaveCount(0);
  // A restart while it was held: expired, nothing was launched.
  Object.assign(state.sessions.find((s) => s.session_key === RISKY), { end_reason: LAUNCH_EXPIRED });
  await pollNow(page);
  await expect(page.locator(".launch-outcome")).toHaveText("Launch approval expired; nothing was launched.");
  // The open chat is archived now, so its group is shown open.
  await openRail(page);
  await expect(page.locator(".archived-group").getByRole("button", { name: /lead-risky/ }).locator(".session-sub")).toHaveText("Launch approval expired; nothing was launched.");
});

test("the Lead info screen shows model · effort, policy, machine, the latest handoff and its workers", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  await openChat(page, /lead-triage Lead/);
  await page.getByRole("button", { name: "Conversation options" }).tap();
  await page.getByRole("menuitem", { name: "Lead info" }).tap();
  const info = page.getByRole("dialog", { name: "lead-triage" });
  await expect(info).toBeVisible();
  await expect(info.locator("#info-eyebrow")).toHaveText("PROJECT LEAD INFO");
  // Full screen on a phone, like the #154 info screen.
  expect((await info.boundingBox())!.width).toBeGreaterThanOrEqual(359);
  const field = (label: string) => info.locator("#conversation-subtitle dt", { hasText: label }).locator("+ dd");
  await expect(field("Selected model")).toHaveText("opus[1m] · medium");
  await expect(field("Role")).toHaveText("Project Lead");
  await expect(field("Started by")).toHaveText("The Coordinator");
  await expect(field("Permissions")).toHaveText("⚠ Bypass · no permission prompts · standing grant for the Coordinator on every project");
  await expect(field("Machine")).toHaveText("machine-a · online");
  await expect(info.locator("#lead-handoff-status")).toHaveText("In progress · 4m ago");
  await expect(info.locator("#lead-handoff-summary")).toHaveText("Triaged 12 bugs; 3 need a decision.");
  // Workers are listed here, with their state, and their conversation opens from here.
  const worker = info.getByRole("button", { name: "fix-tests · Working · ⚠ Bypass" });
  await expect(worker).toBeVisible();
  await worker.tap();
  await expect(info).toBeHidden();
  await expect(page.getByRole("heading", { name: "app · Worker", exact: true })).toBeVisible();
  await page.getByRole("heading", { name: "app · Worker", exact: true }).tap();
  await expect(page.locator("#conversation-subtitle dt", { hasText: "Role" }).locator("+ dd")).toHaveText("Worker · via lead-triage");
  await expect(page.locator("#lead-workers")).toBeHidden();
});

// #197: the registry is relay data and may be malformed. A worker without a string session key is
// skipped (it cannot be opened or matched to a session); one with a non-string name is named by its key.
test("the Lead info screen skips registry workers without a string session key", async ({ page }) => {
  const state = await fixture(page);
  state.leads[0].workers = [
    { session_key: 42, name: "numeric key", state: "working" },
    { session_key: null, name: "null key", state: "working" },
    { session_key: "", name: "empty key", state: "working" },
    { name: "no key", state: "working" },
    null,
    "fm:plain-string",
    { session_key: { toLowerCase: "not a function" }, name: "object key" },
    { session_key: "fm:odd-name", name: 7, state: "idle" },
    { session_key: WORKER, name: "fix-tests", state: "working", permission_mode: "bypass", needs_attention: false },
  ];
  await page.goto("/");
  await openChat(page, /lead-triage Lead/);
  await page.getByRole("button", { name: "Conversation options" }).tap();
  await page.getByRole("menuitem", { name: "Lead info" }).tap();
  const info = page.getByRole("dialog", { name: "lead-triage" });
  await expect(info).toBeVisible();
  const items = info.locator("#lead-worker-list > li");
  await expect(items).toHaveText(["fm:odd-name · Idle", "fix-tests · Working · ⚠ Bypass"]);
  await expect(info.locator("#lead-handoff-summary")).toHaveText("Triaged 12 bugs; 3 need a decision.");
  await expect(page.locator("#error-banner")).toBeHidden();
});

test("a Lead on an offline machine shows its last known state", async ({ page }) => {
  await fixture(page);
  await page.goto(`/?session=${encodeURIComponent(DOCS)}`);
  await page.getByRole("heading", { name: "app · Lead", exact: true }).tap();
  const info = page.getByRole("dialog", { name: "lead-docs" });
  await expect(info.locator("#conversation-subtitle dt", { hasText: "Selected model" }).locator("+ dd")).toHaveText("opus[1m] · high");
  await expect(info.locator("#conversation-subtitle dt", { hasText: "Machine" }).locator("+ dd")).toHaveText(/^machine-a · machine offline · last known state at .*2026/);
  await expect(info.locator("#lead-handoff-status")).toHaveText("No handoff yet.");
  await expect(info.locator("#lead-worker-list")).toHaveText("No workers.");
});

test("without /api/leads the list still works, and the Lead info says so without an error", async ({ page }) => {
  const state = await fixture(page, { leads: false });
  await page.goto(`/?session=${encodeURIComponent(TRIAGE)}`);
  await expect(page.getByText("History of lead-triage")).toBeVisible();
  await page.getByRole("heading", { name: "app · Lead", exact: true }).tap();
  const info = page.getByRole("dialog", { name: "lead-triage" });
  await expect(info.locator("#lead-handoff-status")).toHaveText("Handoffs are unavailable here.");
  // Workers still come from the session list.
  await expect(info.getByRole("button", { name: /^fix-tests · Working/ })).toBeVisible();
  await expect(page.locator("#error-banner")).toBeHidden();
  // A 404 is asked again only after a minute, not on every poll.
  await pollNow(page);
  await pollNow(page);
  await expect.poll(() => state.calls.filter((c) => c.path === "/api/sessions").length, { timeout: 15000 }).toBeGreaterThanOrEqual(3);
  expect(state.calls.filter((c) => c.path === "/api/leads")).toHaveLength(1);
});

test("Settings reads and writes role models, standing grants and ask-before-Bypass in the hosted app", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Conversation options" }).tap();
  await page.getByRole("menuitem", { name: "Settings" }).tap();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  expect((await settings.boundingBox())!.width).toBeGreaterThanOrEqual(359);
  const effort = settings.getByRole("combobox", { name: "Lead effort" });
  await expect(effort).toBeEnabled();
  await expect(effort).toHaveValue("");
  await expect(effort.locator("option").first()).toHaveText("Default (medium)");
  await expect(settings.getByRole("combobox", { name: "Lead model" }).locator("option").first()).toHaveText("Default (opus[1m])");
  await expect(settings.getByRole("combobox", { name: "Investigator model" }).locator("option").first()).toHaveText("Default (opus)");
  const leadGrant = settings.getByRole("checkbox", { name: "Workers that Leads start (all projects)" });
  const coordinatorGrant = settings.getByRole("checkbox", { name: "Leads the Coordinator starts (all projects)" });
  const ask = settings.getByRole("checkbox", { name: "Ask me before each Bypass launch" });
  await expect(coordinatorGrant).toBeChecked();
  await expect(leadGrant).toBeChecked();
  await expect(ask).not.toBeChecked();
  const posts = () => state.calls.filter((c) => c.path === "/api/settings" && c.method === "POST").map((c) => c.body);

  // Each change posts one key with its current version.
  await effort.selectOption("high");
  await expect.poll(posts).toEqual([{ key: "roles", value: { lead: { effort: "high" } }, version: 0 }]);
  await expect(settings.locator("#settings-status")).toHaveText("Saved.");
  await settings.getByRole("combobox", { name: "Investigator model" }).selectOption("sonnet");
  await expect.poll(() => posts().at(-1)).toEqual({ key: "roles", value: { lead: { effort: "high" }, investigator: { model: "sonnet" } }, version: 1 });
  await expect(settings.getByRole("combobox", { name: "Investigator model" })).toHaveValue("sonnet");

  // Turning a standing grant off (Auto) keeps the other role's grant.
  await leadGrant.uncheck();
  await expect.poll(() => posts().at(-1)).toEqual({ key: "bypass_grants", version: 0,
    value: [{ role: "lead", project: "*", allow: false }, { role: "coordinator", project: "*", allow: true }] });
  await expect(leadGrant).not.toBeChecked();
  // A per-project override.
  await settings.getByRole("combobox", { name: "Starts from" }).selectOption("coordinator");
  await settings.getByRole("combobox", { name: "Project name" }).fill("secrets");
  await settings.getByRole("combobox", { name: "Bypass", exact: true }).selectOption("false");
  await settings.getByRole("button", { name: "Add override" }).tap();
  await expect.poll(() => posts().at(-1)).toEqual({ key: "bypass_grants", version: 1, value: [
    { role: "lead", project: "*", allow: false }, { role: "coordinator", project: "*", allow: true }, { role: "coordinator", project: "secrets", allow: false }] });
  await expect(settings.locator(".grant-override")).toHaveText([/^secrets · Leads the Coordinator starts · Auto \(Bypass off\)/]);
  await settings.getByRole("button", { name: "Remove the secrets override for leads the coordinator starts" }).tap();
  await expect.poll(() => posts().at(-1)?.value).toEqual([{ role: "lead", project: "*", allow: false }, { role: "coordinator", project: "*", allow: true }]);
  await expect(settings.locator(".grant-override")).toHaveCount(0);
  // Ask me before each Bypass launch.
  await ask.check();
  await expect.poll(() => posts().at(-1)).toEqual({ key: "bypass_ask", value: true, version: 0 });

  // A change made somewhere else meanwhile: 409, then the latest values are shown.
  state.conflict = true;
  state.settings.settings.roles = { lead: { effort: "max" } };
  await ask.uncheck();
  await expect(settings.locator("#settings-status")).toHaveText("These settings changed somewhere else. The latest values are shown; make your change again.");
  await expect(ask).toBeChecked();
  await expect(effort).toHaveValue("max");
  expect(state.settings.settings.bypass_ask).toBe(true);

  // Back closes Settings and returns to the Coordinator.
  await page.goBack();
  await expect(settings).toBeHidden();
  await expect(page.getByRole("heading", { name: "Coordinator", exact: true })).toBeVisible();
});

test("Settings are read-only in the local UI", async ({ page }) => {
  const state = await fixture(page, { writable: false });
  state.settings.settings.bypass_grants = [{ role: "coordinator", project: "*", allow: false }, { role: "lead", project: "*", allow: true }];
  await page.goto("/");
  await page.getByRole("button", { name: "Conversation options" }).tap();
  await page.getByRole("menuitem", { name: "Settings" }).tap();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.locator("#settings-status")).toHaveText("Read-only here. Change settings from the hosted app.");
  await expect(settings.getByRole("checkbox", { name: "Leads the Coordinator starts (all projects)" })).not.toBeChecked();
  await expect(settings.getByRole("checkbox", { name: "Workers that Leads start (all projects)" })).toBeChecked();
  for (const control of await settings.locator("select, input, #grant-add").all()) await expect(control).toBeDisabled();
  await settings.getByRole("button", { name: "Close settings" }).tap();
  await expect(settings).toBeHidden();
  expect(state.calls.filter((c) => c.path === "/api/settings" && c.method === "POST")).toHaveLength(0);
});

test("a host without /api/settings says Settings are unavailable", async ({ page }) => {
  await fixture(page, { settings: false });
  await page.goto("/");
  await page.getByRole("button", { name: "Conversation options" }).tap();
  await page.getByRole("menuitem", { name: "Settings" }).tap();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.locator("#settings-status")).toHaveText("Settings are unavailable: this host or relay doesn’t serve settings yet.");
  for (const control of await settings.locator("select, input, #grant-add").all()) await expect(control).toBeDisabled();
  await expect(page.locator("#error-banner")).toBeHidden();
});

test("the Coordinator's info screen summarizes its settings and opens Settings; Back steps out one layer at a time", async ({ page }) => {
  const state = await fixture(page);
  state.settings.settings.roles = { lead: { model: "sonnet", effort: "high" } };
  state.settings.settings.bypass_grants = [{ role: "coordinator", project: "*", allow: true }, { role: "coordinator", project: "secrets", allow: false }, { role: "lead", project: "*", allow: false }];
  await page.goto("/");
  await page.getByRole("button", { name: "Conversation options" }).tap();
  await page.getByRole("menuitem", { name: "Coordinator info and model" }).tap();
  const info = page.getByRole("dialog", { name: "Claude · Coordinator" });
  await expect(info.locator("#info-eyebrow")).toHaveText("COORDINATOR INFO");
  const summary = info.locator("#coordinator-settings-summary");
  const field = (label: string) => summary.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("+ dd");
  await expect(field("Coordinator effort")).toHaveText("medium (default)");
  await expect(field("Leads")).toHaveText("sonnet · high");
  await expect(field("Investigators")).toHaveText("opus (default) · low");
  await expect(field("Leads it starts")).toHaveText("⚠ Bypass on every project · 1 project override");
  await expect(field("Workers Leads start")).toHaveText("Auto (Bypass off)");
  await expect(field("Before each Bypass launch")).toHaveText("Don’t ask");
  // The conversation itself has no settings.
  await expect(page.locator("main").getByRole("combobox")).toHaveCount(0);
  await info.getByRole("button", { name: "Settings…" }).tap();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("combobox", { name: "Lead model" })).toHaveValue("sonnet");
  await page.goBack();
  await expect(settings).toBeHidden();
  await expect(info).toBeVisible();
  await page.goBack();
  await expect(info).toBeHidden();
  await expect(page.getByText("Coordinator here. What are we working on?")).toBeVisible();
});

test("New session has no launcher: Ask the Coordinator posts to the Coordinator and opens its chat", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/?session=${encodeURIComponent("fm:dev")}`);
  await expect(page.getByText("History of Fix sign-in")).toBeVisible();
  await openRail(page);
  await page.getByRole("button", { name: "New session", exact: true }).tap();
  const dialog = page.getByRole("dialog", { name: "New session" });
  await expect(dialog).toBeVisible();
  // The launcher is gone: no brief-to-proposal flow, no launcher model, no manual toggle.
  for (const selector of ["#launch-brief", "#propose-session", "#launcher-model", "#start-manually", "#edit-brief", "#launch-status"])
    await expect(page.locator(selector)).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "Session name" })).toBeVisible();
  const ask = dialog.getByRole("textbox", { name: /Describe the work/ });
  await expect(ask).toBeFocused();
  const send = dialog.getByRole("button", { name: "Ask the Coordinator", exact: true });
  await expect(send).toBeDisabled();
  await ask.fill("Start a Lead on app to triage open bugs");
  await send.tap();
  await expect.poll(() => state.calls.filter((c) => c.path === "/api/pm/message").map((c) => c.body)).toEqual([{ text: "Start a Lead on app to triage open bugs" }]);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "Coordinator", exact: true })).toBeVisible();
  await expect(page.locator(".message.user").filter({ hasText: "Start a Lead on app to triage open bugs" })).toBeVisible();
  expect(state.calls.filter((c) => c.path.startsWith("/api/launch") || (c.path === "/api/sessions" && c.method === "POST"))).toHaveLength(0);
  // Back from the Coordinator leaves nothing of the dialog behind.
  await expect(page).toHaveURL(/\/$/);
});

test("a failed Ask the Coordinator keeps the text in the dialog", async ({ page }) => {
  const state = await fixture(page);
  await page.route("**/api/pm/message", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "The Coordinator is busy." }) }));
  await page.goto("/");
  await openRail(page);
  await page.getByRole("button", { name: "New session", exact: true }).tap();
  const dialog = page.getByRole("dialog", { name: "New session" });
  await dialog.getByRole("textbox", { name: /Describe the work/ }).fill("Keep this brief");
  await dialog.getByRole("button", { name: "Ask the Coordinator", exact: true }).tap();
  await expect(dialog.locator("#ask-coordinator-status")).toContainText("The Coordinator is busy.");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: /Describe the work/ })).toHaveValue("Keep this brief");
  expect(state.calls.filter((c) => c.path === "/api/sessions" && c.method === "POST")).toHaveLength(0);
});

test("manual New session with Bypass still needs its confirmation and starts in Bypass", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/");
  await openRail(page);
  await page.getByRole("button", { name: "New session", exact: true }).tap();
  const dialog = page.getByRole("dialog", { name: "New session" });
  await expect(dialog.getByRole("combobox", { name: "Permission policy" })).toHaveValue("native");
  await dialog.getByRole("combobox", { name: "Permission policy" }).selectOption("bypass");
  const confirm = dialog.getByRole("checkbox", { name: /I allow Bypass/ });
  await expect(confirm).toBeVisible();
  await dialog.getByRole("textbox", { name: "Session name" }).fill("risky-manual");
  await dialog.getByRole("textbox", { name: "Project directory or name" }).fill("app");
  await dialog.getByRole("textbox", { name: "First task" }).fill("Do the risky thing");
  await expect(dialog.locator("#project-status")).toContainText("Project: app");
  await dialog.getByRole("button", { name: "Start session", exact: true }).tap();
  // Without the confirmation nothing is created.
  await expect(dialog).toBeVisible();
  expect(state.calls.filter((c) => c.path === "/api/sessions" && c.method === "POST")).toHaveLength(0);
  await confirm.check();
  await dialog.getByRole("button", { name: "Start session", exact: true }).tap();
  await expect.poll(() => state.calls.filter((c) => c.path === "/api/sessions" && c.method === "POST").map((c) => c.body.permission_mode)).toEqual(["bypass"]);
  await expect(page.getByRole("heading", { name: "risky-manual", exact: true })).toBeVisible();
});

test("the machine-offline notification setting uses machine wording", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  const kinds = page.locator("#notify-kinds label");
  await expect(kinds).toHaveText(["Approvals and questions", "A session failed", "Coordinator errors", "Machine offline"]);
});

async function openSettingsDialog(page: Page) {
  await page.getByRole("button", { name: "Conversation options" }).tap();
  await page.getByRole("menuitem", { name: "Settings" }).tap();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  return settings;
}

test("removing an override after turning a role's all-projects grant off leaves Bypass off", async ({ page }) => {
  const state = await fixture(page);
  state.settings.settings.bypass_grants = [
    { role: "coordinator", project: "*", allow: true }, { role: "lead", project: "*", allow: true }, { role: "coordinator", project: "secrets", allow: false }];
  await page.goto("/");
  const settings = await openSettingsDialog(page);
  const leadGrant = settings.getByRole("checkbox", { name: "Workers that Leads start (all projects)" });
  await expect(leadGrant).toBeChecked();
  await expect(settings.locator(".grant-override")).toHaveText([/^secrets · Leads the Coordinator starts/]);
  await leadGrant.uncheck();
  await expect(settings.locator("#settings-status")).toHaveText("Saved.");
  expect(state.settings.settings.bypass_grants).toContainEqual({ role: "lead", project: "*", allow: false });
  // The override list was drawn before the uncheck; removing from it must not re-post the old grant.
  await settings.getByRole("button", { name: "Remove the secrets override for leads the coordinator starts" }).tap();
  await expect.poll(() => state.settings.versions.bypass_grants).toBe(2);
  expect(state.settings.settings.bypass_grants).toEqual([{ role: "lead", project: "*", allow: false }, { role: "coordinator", project: "*", allow: true }]);
  await expect(leadGrant).not.toBeChecked();
  await expect(settings.locator(".grant-override")).toHaveCount(0);
});

test("a settings read that started before a save cannot replace the saved values", async ({ page }) => {
  const state = await fixture(page);
  let hold = false, release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let heldRequests = 0;
  await page.route("**/api/settings", async (route) => {
    if (!hold || route.request().method() !== "GET") return route.fallback();
    // Answer with the settings as they were when the read was made, once released.
    const snapshot = JSON.stringify({ ...structuredClone(state.settings), writable: true });
    heldRequests++;
    await held;
    await route.fulfill({ contentType: "application/json", body: snapshot });
  });
  await page.goto("/");
  let settings = await openSettingsDialog(page);
  const ask = () => settings.getByRole("checkbox", { name: "Ask me before each Bypass launch" });
  await expect(ask()).toBeEnabled();
  await settings.getByRole("button", { name: "Close settings" }).tap();
  await expect(settings).toBeHidden();
  // Reopening reads the settings again; that read is held while the developer changes a setting.
  hold = true;
  settings = await openSettingsDialog(page);
  await expect.poll(() => heldRequests).toBe(1);
  await ask().check();
  await expect(settings.locator("#settings-status")).toHaveText("Saved.");
  expect(state.settings.settings.bypass_ask).toBe(true);
  hold = false;
  release();
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  await expect(ask()).toBeChecked();
  // The view kept the saved version: the next change is not a conflict.
  await ask().uncheck();
  await expect(settings.locator("#settings-status")).toHaveText("Saved.");
  const posts = state.calls.filter((c) => c.path === "/api/settings" && c.method === "POST").map((c) => c.body);
  expect(posts).toEqual([{ key: "bypass_ask", value: true, version: 0 }, { key: "bypass_ask", value: false, version: 1 }]);
  expect(state.settings.settings.bypass_ask).toBe(false);
});

test("signing out clears unsent Ask the Coordinator text", async ({ page }) => {
  await page.route("https://www.gstatic.com/firebasejs/**/firebase-app.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "export const initializeApp = value => value;" }));
  await page.route("https://www.gstatic.com/firebasejs/**/firebase-auth.js", (route) => route.fulfill({ contentType: "application/javascript", body: `
    const user = {email:'owner@example.com',getIdToken:async()=> 'fixture-id-token'};
    let callback;
    export const getAuth = () => ({currentUser:user});
    export const onAuthStateChanged = (auth,fn) => { callback=fn; queueMicrotask(()=>fn(user)); };
    export const signOut = async auth => { auth.currentUser=null; callback(null); };
  ` }));
  await fixture(page, { auth: { required: true, firebase: { apiKey: "fixture-api-key" } } });
  await page.goto("/");
  await openRail(page);
  await page.getByRole("button", { name: "New session", exact: true }).tap();
  const dialog = page.getByRole("dialog", { name: "New session" });
  await dialog.getByRole("textbox", { name: /Describe the work/ }).fill("Private plan for the Coordinator");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Closing the dialog alone keeps the text; signing out does not.
  await expect(page.locator("#ask-coordinator")).toHaveValue("Private plan for the Coordinator");
  // The rail is still open behind the closed dialog.
  await expect(page.locator("#rail")).toBeInViewport();
  await page.getByRole("button", { name: "Sign out" }).tap();
  await expect(page.locator("#app")).toBeHidden();
  await expect(page.locator("#ask-coordinator")).toHaveValue("");
});

// #176: the header is one row that names the conversation, never a generic title.
const LONG_PROJECT = "a-very-long-project-name-that-cannot-possibly-fit-on-one-phone-row";
async function recordTitles(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__titles = [];
    document.addEventListener("DOMContentLoaded", () => {
      const title = document.querySelector("#conversation-title")!;
      w.__titles.push(title.textContent);
      new MutationObserver(() => w.__titles.push(title.textContent)).observe(title, { childList: true, characterData: true, subtree: true });
    });
  });
}
async function headerMetrics(page: Page) {
  return page.evaluate(() => {
    const head = document.querySelector(".conversation-head")!.getBoundingClientRect();
    const title = document.querySelector("#conversation-title") as HTMLElement;
    const style = getComputedStyle(title);
    return {
      head: head.height, titleHeight: title.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight),
      truncated: title.scrollWidth > title.clientWidth, textOverflow: style.textOverflow, whiteSpace: style.whiteSpace,
      titleRight: title.getBoundingClientRect().right, menuLeft: document.querySelector("#conversation-menu-button")!.getBoundingClientRect().left,
    };
  });
}
async function expectOneRow(page: Page, text: string, maxHead?: number) {
  await expect(page.locator("#conversation-title")).toHaveText(text);
  const m = await headerMetrics(page);
  expect(m.titleHeight).toBeLessThanOrEqual(m.lineHeight + 1);
  expect(m.whiteSpace).toBe("nowrap");
  expect(m.titleRight).toBeLessThanOrEqual(m.menuLeft);
  if (maxHead) expect(m.head).toBeLessThanOrEqual(maxHead);
  return m;
}
function longLead(project = LONG_PROJECT) {
  return { ...base, session_key: "fm:88888888-8888-4888-8888-888888888888", session_id: "long", name: "lead-long", state: "working", current_tool: "Bash",
    role: "lead", launched_by: "coordinator", project_name: project, cwd: `/Users/dev/code/${project}`, permission_mode: "auto", updated_at: iso(1000) };
}

test("#176 at 360×780 the header is one row of at most 56 px naming the Coordinator, a Lead, a session and a loading chat", async ({ page }) => {
  const state = await fixture(page);
  state.sessions.push(longLead());
  let holdDetail = false, release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/session?*", async (route) => { if (holdDetail) await held; await route.fallback(); });
  await recordTitles(page);
  expect(page.viewportSize()).toEqual({ width: 360, height: 780 });
  const html = await (await page.request.get("/")).text();
  expect(html).not.toContain("Your session inbox");
  await page.goto("/");
  // The Coordinator.
  await expect(page.getByText("Coordinator here. What are we working on?")).toBeVisible();
  await expectOneRow(page, "Coordinator", 56);
  // A plain session keeps its own name.
  await openChat(page, /Fix sign-in/);
  await expect(page.getByText("History of Fix sign-in")).toBeVisible();
  await expectOneRow(page, "Fix sign-in", 56);
  // A Lead is named by its project and role; a working one also shows its status in the header.
  await openChat(page, /lead-triage Lead/);
  await expect(page.getByText("History of lead-triage")).toBeVisible();
  await expect(page.locator("#activity-status")).toBeVisible();
  await expectOneRow(page, "app · Lead", 56);
  await openChat(page, /lead-long/);
  await expect(page.getByText("History of lead-long")).toBeVisible();
  // A long project name is cut with an ellipsis on the same row; the info screen has it in full.
  const long = await expectOneRow(page, `${LONG_PROJECT} · Lead`, 56);
  expect(long.truncated).toBe(true);
  expect(long.textOverflow).toBe("ellipsis");
  await page.locator("#conversation-heading").tap();
  const info = page.getByRole("dialog", { name: "lead-long" });
  await expect(info.locator("#conversation-subtitle dt", { hasText: /^Project$/ }).locator("+ dd")).toHaveText(LONG_PROJECT);
  await page.getByRole("button", { name: "Close info" }).tap();
  await expect(info).toBeHidden();
  // Loading: the chat's name from the list, on the same single row, before its history arrives.
  holdDetail = true;
  await openChat(page, /lead-docs/);
  await expectOneRow(page, "app · Lead", 56);
  await expect(page.getByText("History of lead-docs")).toBeHidden();
  holdDetail = false;
  release();
  await expect(page.getByText("History of lead-docs")).toBeVisible();
  // Never the generic title, at any point.
  const titles: string[] = await page.evaluate(() => (window as any).__titles);
  expect(titles.length).toBeGreaterThan(1);
  for (const title of titles) {
    expect(title).not.toBe("Your session inbox");
    expect(title?.trim()).toBeTruthy();
  }
});

test("#176 a worker chat is named by its project and role", async ({ page }) => {
  await fixture(page);
  await page.goto(`/?session=${encodeURIComponent(WORKER)}`);
  await expect(page.getByText("History of fix-tests")).toBeVisible();
  await expectOneRow(page, "app · Worker", 56);
});

test("#176 a deep link that is still loading shows a short neutral title on one row", async ({ page }) => {
  await fixture(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  // Neither the list nor the chat has answered yet.
  await page.route("**/api/sessions", async (route) => { await held; await route.fallback(); });
  await page.route("**/api/session?*", async (route) => { await held; await route.fallback(); });
  await recordTitles(page);
  await page.goto(`/?session=${encodeURIComponent(DOCS)}`);
  await expectOneRow(page, "Loading…", 56);
  release();
  await expectOneRow(page, "app · Lead", 56);
  await expect(page.getByText("History of lead-docs")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__titles)).not.toContain("Your session inbox");
});

test.describe("#176 desktop header", () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
  test("one row naming the Coordinator, a Lead and a session; a long name is cut with an ellipsis", async ({ page }) => {
    const state = await fixture(page);
    state.sessions.push(longLead(LONG_PROJECT.repeat(4)));
    await recordTitles(page);
    await page.goto("/");
    await expect(page.getByText("Coordinator here. What are we working on?")).toBeVisible();
    await expectOneRow(page, "Coordinator");
    const list = page.locator("#session-list");
    await list.getByRole("button", { name: /Fix sign-in/ }).click();
    await expect(page.getByText("History of Fix sign-in")).toBeVisible();
    await expectOneRow(page, "Fix sign-in");
    await list.getByRole("button", { name: /lead-triage Lead/ }).click();
    await expect(page.getByText("History of lead-triage")).toBeVisible();
    await expectOneRow(page, "app · Lead");
    await list.getByRole("button", { name: /lead-long/ }).click();
    await expect(page.getByText("History of lead-long")).toBeVisible();
    const long = await expectOneRow(page, `${LONG_PROJECT.repeat(4)} · Lead`);
    expect(long.truncated).toBe(true);
    expect(long.textOverflow).toBe("ellipsis");
    expect(await page.evaluate(() => (window as any).__titles)).not.toContain("Your session inbox");
    await expect(page.locator("body")).not.toContainText("Your session inbox");
  });
});

// #197: a dialog's close event is queued. Closing and at once reopening Info, Settings or New
// session delivers the first close after the reopening; that late event must not pop the reopened
// dialog's Back entry or send focus away, and the next real close still returns focus to its opener.
const LATE_CLOSE_DIALOGS = [
  { name: "Info", dialog: "#info-dialog", reopen: "#open-info", overlay: "info", back: null as string | null,
    async open(page: Page) {
      await page.getByRole("button", { name: "Conversation options" }).tap();
      await page.getByRole("menuitem", { name: "Coordinator info and model" }).tap();
    },
    opener: "#conversation-menu-button", close: "#close-info" },
  { name: "Settings", dialog: "#settings-dialog", reopen: "#open-settings", overlay: "settings", back: null as string | null,
    async open(page: Page) {
      await page.getByRole("button", { name: "Conversation options" }).tap();
      await page.getByRole("menuitem", { name: "Settings" }).tap();
    },
    opener: "#conversation-menu-button", close: "#close-settings" },
  { name: "New session", dialog: "#new-dialog", reopen: "#new-session", overlay: "dialog", back: "nav" as string | null,
    async open(page: Page) {
      await openRail(page);
      await page.getByRole("button", { name: "New session", exact: true }).tap();
    },
    opener: "#new-session", close: "#close-dialog" },
];
for (const target of LATE_CLOSE_DIALOGS) {
  test(`a late close event after a quick close and reopen leaves ${target.name} open and its Back entry in place`, async ({ page }) => {
    await fixture(page);
    await page.goto("/");
    await expect(page.getByText("Coordinator here. What are we working on?")).toBeVisible();
    await target.open(page);
    const dialog = page.locator(target.dialog);
    await expect(dialog).toBeVisible();
    await expect.poll(() => page.evaluate(() => history.state?.overlay)).toBe(target.overlay);
    // Close and reopen in one task, before the close event can be dispatched.
    const late = await page.evaluate(({ dialog, reopen }) => {
      const element = document.querySelector(dialog) as HTMLDialogElement;
      const w = window as any;
      w.__closes = 0;
      element.addEventListener("close", () => { w.__closes++; });
      element.close();
      (document.querySelector(reopen) as HTMLButtonElement).click();
      return { reopened: element.open, firedBeforeReopen: w.__closes };
    }, { dialog: target.dialog, reopen: target.reopen });
    expect(late).toEqual({ reopened: true, firedBeforeReopen: 0 });
    await expect.poll(() => page.evaluate(() => (window as any).__closes)).toBe(1);
    await expect(dialog).toBeVisible();
    await expect.poll(() => page.evaluate(() => history.state?.overlay)).toBe(target.overlay);
    // A real close now returns focus to the opener and steps off the dialog's entry.
    await page.locator(target.close).tap();
    await expect(dialog).toBeHidden();
    await expect(page.locator(target.opener)).toBeFocused();
    await expect.poll(() => page.evaluate(() => history.state?.overlay ?? null)).toBe(target.back);
  });

  test(`close, reopen and close ${target.name} before either close event fires returns focus to its opener`, async ({ page }) => {
    await fixture(page);
    await page.goto("/");
    await expect(page.getByText("Coordinator here. What are we working on?")).toBeVisible();
    await target.open(page);
    const dialog = page.locator(target.dialog);
    await expect(dialog).toBeVisible();
    await expect.poll(() => page.evaluate(() => history.state?.overlay)).toBe(target.overlay);
    const late = await page.evaluate(({ dialog, reopen }) => {
      const element = document.querySelector(dialog) as HTMLDialogElement;
      const w = window as any;
      w.__closes = 0;
      element.addEventListener("close", () => { w.__closes++; });
      element.close();
      (document.querySelector(reopen) as HTMLButtonElement).click();
      const reopened = element.open;
      element.close();
      return { reopened, closedAgain: !element.open, firedSoFar: w.__closes };
    }, { dialog: target.dialog, reopen: target.reopen });
    expect(late).toEqual({ reopened: true, closedAgain: true, firedSoFar: 0 });
    await expect.poll(() => page.evaluate(() => (window as any).__closes)).toBe(2);
    await expect(dialog).toBeHidden();
    await expect(page.locator(target.opener)).toBeFocused();
    await expect.poll(() => page.evaluate(() => history.state?.overlay ?? null)).toBe(target.back);
  });
}
