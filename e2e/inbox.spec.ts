import { test, expect, type Page } from "@playwright/test";

const managed = {
  session_key: "managed:alpha",
  session_id: "native-alpha",
  provider: "claude",
  name: "Fix sign-in",
  cwd: "/Users/dev/code/app",
  state: "working",
  current_tool: "Read",
  managed: true,
  capabilities: { message: true, interrupt: true, approvals: true },
  updated_at: new Date().toISOString(),
};
const observed = {
  ...managed,
  session_key: "codex:observed",
  session_id: "observed",
  provider: "codex",
  name: "Terminal research",
  managed: false,
  state: "idle",
  capabilities: { message: false, interrupt: false, approvals: false },
  control_reason:
    "Observed session; Foreman does not own its input connection.",
};
const DEV_MAC_ID = "6f1c2b8e-4a3d-4c5e-9f70-1a2b3c4d5e6f";
async function fixture(
  page: Page,
  options: {
    online?: boolean;
    approvals?: any[];
    history?: any[];
    auth?: any;
  } = {},
) {
  const deferred = new Map<string, Promise<void>>();
  const state = {
    defer(path: string) {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      deferred.set(path, pending);
      return () => { deferred.delete(path); release(); };
    },
    failures: new Map<string, string>(),
    online: options.online ?? true,
    sessions: [structuredClone(managed), structuredClone(observed)],
    approvals: options.approvals ?? [],
    history: options.history ?? [
      {
        id: "reply",
        role: "assistant",
        text: "I found the sign-in issue.",
        at: new Date().toISOString(),
      },
    ],
    receipts: [] as any[],
    calls: [] as { path: string; body: any; headers: any }[],
    projects: [{ id: "project-app", name: "app", path: "/Users/dev/code/app", canonicalPath: "/Users/dev/code/app", aliases: ["personal repo"], lastUsed: "2026-09-10" }] as any[],
    projectDelay: 0,
    projectErrors: {} as Record<string, string>,
    pmHistory: [{ role: "assistant", text: "How can I help the fleet?" }] as any[],
    pmModel: null as string | null,
    pmBusy: false,
    pmError: null as string | null,
    failMessages: 0,
    failCreates: 0,
    deny: false,
    launchStatus: "ready",
    launchError: "Launcher unavailable",
    launchProposal: { project: "app", cwd: "/Users/dev/code/app", provider: "codex", model: "gpt-6-astra", name: "fix-sign-in", text: "Repair sign-in and verify with tests", reason: "Codex suits this implementation task." },
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const body = request.method() === "POST" ? request.postDataJSON() : null;
    state.calls.push({ path, body, headers: request.headers() });
    await deferred.get(path);
    if (state.failures.has(path)) {
      await route.fulfill({ status: 502, json: { error: state.failures.get(path) } });
      return;
    }
    let result: any = {},
      status = 200;
    if (path === "/api/config")
      result = { auth: options.auth ?? { required: false } };
    else if (state.deny) {
      status = 403;
      result = { error: "Not authorized" };
    } else if (path === "/api/host")
      result = { online: state.online, host: "Dev Mac", machine_id: DEV_MAC_ID, standby_online: false };
    // Epic #26 contract D: the relay's answer for a single machine that runs the PM.
    else if (path === "/api/pm/host" && request.method() === "GET")
      result = {
        active: { machine_id: DEV_MAC_ID, name: "Dev Mac", online: state.online, epoch: 1, assigned_at: Date.parse("2026-09-01T00:00:00Z"), assigned_by: "bootstrap" },
        machines: [{ machine_id: DEV_MAC_ID, name: "Dev Mac", platform: "darwin", online: state.online, last_seen: Date.now(), active: true }],
        open_turns: 0,
        uncertain_turns: 0,
        mode: "relay",
      };
    else if (path === "/api/projects") result = { projects: state.projects };
    else if (path === "/api/projects/resolve") {
      const reference = body.reference.toLowerCase().replace(/^the /, "");
      const exact = state.projects.filter((p) => [p.name, p.path, ...p.aliases].some((v) => v.toLowerCase() === reference));
      const matches = exact.length ? exact : state.projects.filter((p) => [p.name, p.path, ...p.aliases].some((v) => v.toLowerCase().includes(reference)));
      result = reference.startsWith("/") ? { status: "resolved", path: body.reference, project: exact[0] } : matches.length === 1 ? { status: "resolved", path: matches[0].path, project: matches[0] } : { status: matches.length ? "ambiguous" : "not_found", candidates: matches };
      if (state.projectErrors[body.reference]) { status = 400; result = { error: state.projectErrors[body.reference] }; }
      if (state.projectDelay) await new Promise((resolve) => setTimeout(resolve, state.projectDelay));
    } else if (path === "/api/projects/register") {
      result = { id: `project-${state.projects.length}`, name: body.name, path: body.path, canonicalPath: body.path, aliases: body.aliases || [], lastUsed: null }; state.projects.push(result);
    } else if (path === "/api/projects/update") {
      result = state.projects.find((p) => p.id === body.id); Object.assign(result, { name: body.name, aliases: body.aliases });
    } else if (path === "/api/projects/remove") { const removed = state.projects.find((p) => p.id === body.id); if (removed) delete state.projectErrors[removed.path]; state.projects = state.projects.filter((p) => p.id !== body.id); result = { ok: true }; }
    else if (path === "/api/sessions" && request.method() === "GET")
      result = state.sessions;
    else if (path === "/api/sessions") {
      if (state.failCreates-- > 0) {
        status = 502;
        result = { error: "Temporary relay failure" };
      } else {
        const session = {
          ...managed,
          session_key: "managed:new",
          name: body.name,
          cwd: body.cwd,
          provider: body.provider,
          permission_mode: body.permission_mode,
        };
        state.sessions.push(session);
        result = session;
      }
    } else if (path === "/api/launch/propose" || path === "/api/launch") {
      result = { id: body?.id || url.searchParams.get("id"), status: state.launchStatus, model: body?.model || "claude-sonnet-5", proposal: state.launchProposal, error: state.launchError };
    } else if (path === "/api/launch/cancel") { result = { status: "cancelled" };
    } else if (path === "/api/session") {
      const session = state.sessions.find(
        (s) => s.session_key === url.searchParams.get("id"),
      );
      result = {
        session,
        history: state.history,
        receipts: state.receipts,
        approvals: session?.managed ? state.approvals : [],
      };
    } else if (path === "/api/session/message") {
      if (state.failMessages-- > 0) {
        status = 502;
        result = { error: "Temporary relay failure" };
      } else {
        result = {
          id: body.message_id,
          text: body.text,
          status: "queued",
          source: "user",
          at: new Date().toISOString(),
        };
        state.receipts.push(result);
        state.history.push({ ...result, role: "user" });
      }
    } else if (path === "/api/session/approval") {
      state.approvals = state.approvals.filter(
        (a) => a.id !== body.approval_id,
      );
      result = { ok: true };
    } else if (path === "/api/session/interrupt") result = { ok: true };
    else if (path === "/api/models") result = { models: url.searchParams.get("provider") === "codex"
      ? [{ value: "gpt-6-astra", displayName: "GPT-6-Astra" }]
      : [{ value: "haiku", displayName: "Haiku" }, { value: "sonnet", displayName: "Sonnet" }] };
    else if (path === "/api/pm/model") { state.pmModel = body.model; result = { model: state.pmModel }; }
    else if (path === "/api/pm/history")
      result = {
        history: state.pmHistory,
        busy: state.pmBusy,
        error: state.pmError,
        model: state.pmModel,
      };
    else if (path === "/api/pm/message") result = { ok: true };
    else {
      status = 404;
      result = { error: "Unknown mock route" };
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(result),
    });
  });
  return state;
}
async function openManaged(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Fix sign-in/ }).click();
  await expect(
    page.getByRole("heading", { name: "Fix sign-in", exact: true }),
  ).toBeVisible();
}

test("managed follow-up is queued, approval resolves, history survives refresh", async ({
  page,
}) => {
  const state = await fixture(page, {
    approvals: [
      {
        id: "approval-1",
        kind: "permission",
        tool: "Bash",
        input: { command: "npm test" },
        reason: "Run project tests",
      },
    ],
  });
  await openManaged(page);
  await page
    .getByLabel("Message this session")
    .fill("Please add a regression test.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await expect(page.locator("#send-feedback")).toHaveText("Message accepted.");
  await page.getByLabel("Message this session").fill("A new unsent draft");
  await expect(page.locator("#send-feedback")).toBeHidden();
  expect(
    state.calls.find((c) => c.path === "/api/session/message")?.body.id,
  ).toBe(managed.session_key);
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0);
  expect(
    state.calls.find((c) => c.path === "/api/session/approval")?.body,
  ).toMatchObject({
    id: managed.session_key,
    approval_id: "approval-1",
    decision: "allow",
  });
  await page.reload();
  await expect(
    page.getByText("Please add a regression test.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
});

test("message retry retains its ID and composer text", async ({ page }) => {
  const state = await fixture(page);
  state.failMessages = 1;
  await openManaged(page);
  await page.getByLabel("Message this session").fill("Check the tests");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator("#send-feedback")).toContainText("Retry the same message");
  await expect(page.getByLabel("Message this session")).toHaveValue(
    "Check the tests",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  const sends = state.calls.filter((c) => c.path === "/api/session/message");
  expect(sends).toHaveLength(2);
  expect(sends[0].body.message_id).toBe(sends[1].body.message_id);
});

test("new Codex session retries creation with stable ID and opens chat", async ({
  page,
}) => {
  const state = await fixture(page);
  state.failCreates = 1;
  await page.goto("/");
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.locator("#start-manually").click();
  await page
    .getByRole("combobox", { name: "Agent", exact: true })
    .selectOption("codex");
  await page.getByLabel("Session name").fill("Review worker");
  await page.getByLabel("Project directory").fill("/Users/dev/code/worker");
  await page.getByLabel("First task").fill("Review the worker for correctness");
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await expect(page.locator("#new-error")).toContainText(
    "Temporary relay failure",
  );
  await page
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review worker", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#provider")).toHaveText("Codex");
  const creates = state.calls.filter(
    (c) => c.path === "/api/sessions" && c.body,
  );
  expect(creates).toHaveLength(2);
  expect(creates[0].body.id).toBe(creates[1].body.id);
  expect(creates[1].body.provider).toBe("codex");
});

test("external session is readable and clearly monitor-only", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: /Terminal research/ }).click();
  await expect(
    page.getByRole("heading", { name: "Terminal research", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("I found the sign-in issue.")).toBeVisible();
  await expect(page.getByLabel("Message this session")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Interrupt", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#control-note")).toContainText(
    "does not own its input",
  );
});

test("host disconnection disables mutations and preserves last conversation", async ({
  page,
}) => {
  const state = await fixture(page);
  await openManaged(page);
  await page.getByLabel("Message this session").fill("Hold this draft");
  state.online = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(
    page.getByText("Dev Mac · offline", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Message this session")).toBeDisabled();
  await expect(page.locator("#activity-status")).toContainText("Last known · Working…");
  expect(await page.locator("#activity-status").evaluate((el) => el.getAnimations({ subtree: true }).some((animation) => animation.playState === "running"))).toBe(false);
  await expect(
    page.getByRole("button", { name: "New session", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("I found the sign-in issue.")).toBeVisible();
  await expect(page.getByLabel("Message this session")).toHaveValue(
    "Hold this draft",
  );
  state.online = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByLabel("Message this session")).toBeEnabled();
});

test("question answers survive polling and submit their provider IDs", async ({
  page,
}) => {
  const state = await fixture(page, {
    approvals: [
      {
        id: "question-1",
        kind: "question",
        tool: "requestUserInput",
        input: {},
        questions: [
          {
            id: "scope",
            question: "Which test scope?",
            options: ["Unit tests", "All tests"],
          },
        ],
      },
    ],
  });
  await openManaged(page);
  await page.getByLabel("Which test scope?").selectOption("Unit tests");
  state.approvals.push({
    id: "approval-2",
    kind: "permission",
    tool: "Read",
    input: {},
  });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByText("Permission requested · Read")).toBeVisible();
  await expect(page.getByLabel("Which test scope?")).toHaveValue("Unit tests");
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect
    .poll(
      () =>
        state.calls.filter((c) => c.path === "/api/session/approval").length,
    )
    .toBe(1);
  expect(
    state.calls.find((c) => c.path === "/api/session/approval")?.body.answers,
  ).toEqual({ scope: "Unit tests" });
});

test("mobile navigation opens accessibly and closes on selecting a session", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.goto("/");
  await expect(page.locator("#rail")).toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "Open session navigation" }).click();
  await expect(
    page.getByRole("button", { name: "Open session navigation" }),
  ).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: /Fix sign-in/ }).click();
  await expect(
    page.getByRole("heading", { name: "Fix sign-in", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open session navigation" }),
  ).toHaveAttribute("aria-expanded", "false");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});

test("provider transcript and session names never become executable HTML", async ({
  page,
}) => {
  const malicious =
    '<img src=x onerror="window.foremanXss=true"><script>window.foremanXss=true</script>';
  const state = await fixture(page, {
    history: [
      {
        id: "xss",
        role: "assistant",
        text: malicious,
        at: new Date().toISOString(),
      },
    ],
  });
  state.sessions[0].name = malicious;
  await page.goto("/");
  await page.getByRole("button", { name: new RegExp("<img src=x") }).click();
  await expect(page.locator(".message-body")).toHaveText(malicious);
  await expect(
    page.locator("#messages img, #messages script, #session-list img"),
  ).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).foremanXss)).toBeUndefined();
});

test("missing hosted auth configuration leaves the app locked", async ({
  page,
}) => {
  const state = await fixture(page, { auth: { required: true } });
  await page.goto("/");
  await expect(page.locator("#auth-status")).toContainText(
    "has not been configured",
  );
  await expect(page.locator("#app")).toBeHidden();
  expect(state.calls.filter((c) => c.path !== "/api/config")).toHaveLength(0);
});

test("hosted requests use bearer tokens and a denied identity loses access", async ({
  page,
}) => {
  await page.route(
    "https://www.gstatic.com/firebasejs/**/firebase-app.js",
    (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: "export const initializeApp = value => value;",
      }),
  );
  await page.route(
    "https://www.gstatic.com/firebasejs/**/firebase-auth.js",
    (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `
    const user = {email:'denied@example.com',getIdToken:async()=> 'fixture-id-token'};
    export const getAuth = () => ({currentUser:user});
    export const onAuthStateChanged = (auth,callback) => queueMicrotask(()=>callback(user));
  `,
      }),
  );
  const state = await fixture(page, {
    auth: { required: true, firebase: { apiKey: "fixture-api-key" } },
  });
  state.deny = true;
  await page.goto("/");
  await expect(page.locator("#auth-status")).toContainText(
    "does not have access",
  );
  await expect(page.locator("#app")).toBeHidden();
  const hostCall = state.calls.find((c) => c.path === "/api/host");
  expect(hostCall?.headers.authorization).toBe("Bearer fixture-id-token");
  expect(state.calls.some((c) => c.path.includes("token="))).toBe(false);
});

test("large fleets and long conversations scroll independently inside the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  const state = await fixture(page, {
    history: Array.from({ length: 60 }, (_, index) => ({
      id: `history-${index}`,
      role: index % 2 ? "assistant" : "user",
      text: `Turn ${index + 1}: ${"A detailed update about the project and its next steps. ".repeat(8)}`,
      at: new Date().toISOString(),
    })),
  });
  state.sessions.push(
    ...Array.from({ length: 60 }, (_, index) => ({
      ...observed,
      session_key: `codex:observed-${index}`,
      session_id: `observed-${index}`,
      name: `Terminal session ${index + 1}`,
    })),
  );
  await openManaged(page);
  await expect(page.locator(".message")).toHaveCount(60);

  const dimensions = await page.evaluate(() => {
    const rect = (selector: string) => {
      const bounds = document.querySelector(selector)!.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom };
    };
    const rail = document.querySelector("#session-list")!;
    const timeline = document.querySelector("#timeline")!;
    return {
      viewport: window.innerHeight,
      document: document.documentElement.scrollHeight,
      header: rect(".conversation-head"),
      composer: rect("#composer"),
      railScrolls: rail.scrollHeight > rail.clientHeight,
      timelineScrolls: timeline.scrollHeight > timeline.clientHeight,
    };
  });
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.header.top).toBeGreaterThanOrEqual(0);
  expect(dimensions.header.bottom).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.composer.top).toBeGreaterThan(dimensions.header.bottom);
  expect(dimensions.composer.bottom).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.railScrolls).toBe(true);
  expect(dimensions.timelineScrolls).toBe(true);

  const scrolling = await page.evaluate(() => {
    const rail = document.querySelector("#session-list")!;
    const timeline = document.querySelector("#timeline")!;
    timeline.scrollTop = 200;
    rail.scrollTop = 300;
    const historyPosition = timeline.scrollTop;
    timeline.scrollTop = 500;
    return {
      historyPosition,
      railPosition: rail.scrollTop,
      timelinePosition: timeline.scrollTop,
      pagePosition: window.scrollY,
    };
  });
  expect(scrolling).toEqual({
    historyPosition: 200,
    railPosition: 300,
    timelinePosition: 500,
    pagePosition: 0,
  });
});


test("model selections follow the provider and reach session creation", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/");
  await page.locator("#new-session").click();
  await page.locator("#start-manually").click();
  await expect(page.locator("#new-model option[value=haiku]")).toHaveCount(1);
  await page.locator("#new-model").selectOption("haiku");
  await page.locator("#new-provider").selectOption("codex");
  await expect(page.locator("#new-model option[value=gpt-6-astra]")).toHaveCount(1);
  await expect(page.locator("#new-model")).toHaveValue("");
  await expect(page.locator("#new-model option[value=haiku]")).toHaveCount(0);
  await page.locator("#new-model").selectOption("gpt-6-astra");
  await page.locator("#new-name").fill("Model selection");
  await page.locator("#new-cwd").fill("/Users/dev/code/app");
  await page.locator("#new-prompt").fill("Inspect this project");
  await page.locator("#create-session").click();
  await expect.poll(() => state.calls.find((c) => c.path === "/api/sessions" && c.body)?.body.model).toBe("gpt-6-astra");
});

test("project manager model persists across reload and is locked while busy", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/");
  await page.locator("#select-pm").click();
  await expect(page.locator("#pm-model option[value=haiku]")).toHaveCount(1);
  await page.locator("#pm-model").selectOption("haiku");
  await expect.poll(() => state.pmModel).toBe("haiku");
  await page.reload();
  await expect(page.locator("#pm-model")).toHaveValue("haiku");
  state.pmBusy = true;
  await expect(page.locator("#pm-model")).toBeDisabled();
  state.pmBusy = false;
  await expect(page.locator("#pm-model")).toBeEnabled({ timeout: 10000 });
  await page.locator("#pm-model").selectOption("");
  await expect.poll(() => state.pmModel).toBe(null);
});

test('launch policy defaults to Native, Bypass requires confirmation, and running sessions show it', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.locator("#start-manually").click();
  await expect(page.getByLabel('Permission policy')).toHaveValue('native');
  await page.getByLabel('Session name').fill('Bypass worker');
  await page.getByLabel('Project directory').fill('/Users/dev/code/worker');
  await page.getByLabel('First task').fill('Work on the project');
  await page.getByLabel('Permission policy').selectOption('bypass');
  await expect(page.locator('#new-policy-hint')).toContainText('outside the project without permission prompts');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  expect(state.calls.filter((c) => c.path === '/api/sessions' && c.body)).toHaveLength(0);
  await page.locator('#confirm-bypass').check();
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bypass worker', exact: true })).toBeVisible();
  expect(state.calls.find((c) => c.path === '/api/sessions' && c.body)?.body.permission_mode).toBe('bypass');
  await expect(page.locator('#conversation-subtitle')).toContainText('⚠ Bypass');
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.locator("#start-manually").click();
  await expect(page.getByLabel('Permission policy')).toHaveValue('native');
  await page.getByLabel('Permission policy').selectOption('bypass');
  await expect(page.locator('#confirm-bypass')).not.toBeChecked();
});

test('local token unlock stays usable after an invalid token without Google sign-in', async ({page}) => {
  await fixture(page, {auth:{required:true,kind:'local'}});
  let unlocked=false;
  await page.route('**/api/host', async (route) => route.fulfill({status:unlocked?200:401,json:unlocked?{online:true,host:'Local'}:{error:'Local API token required'}}));
  await page.route('**/api/auth/local', async (route) => {
    unlocked=route.request().postDataJSON().token==='fixture-local-token';
    await route.fulfill({status:unlocked?200:401,json:unlocked?{ok:true}:{error:'Invalid local API token'}});
  });
  await page.goto('/');
  await page.getByPlaceholder('Local API token').fill('wrong');
  await page.getByRole('button',{name:'Unlock Foreman'}).click();
  await expect(page.locator('#auth-status')).toContainText('Invalid local API token');
  await expect(page.locator('#sign-in')).toBeHidden();
  await page.getByPlaceholder('Local API token').fill('fixture-local-token');
  await page.getByRole('button',{name:'Unlock Foreman'}).click();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#auth-screen')).toBeHidden();
});

async function refreshFixture(page: Page, state: Awaited<ReturnType<typeof fixture>>) {
  const before = state.calls.filter((call) => call.path === "/api/host").length;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => state.calls.filter((call) => call.path === "/api/host").length).toBeGreaterThan(before);
}

async function expectNoPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function expectActionTextFits(page: Page, selector: string) {
  const clippedLabels = await page.locator(selector).evaluateAll((buttons) => buttons.flatMap((button) => {
    const bounds = button.getBoundingClientRect();
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      if (!text.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      if (Array.from(range.getClientRects()).some((rect) => rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1))
        return [button.textContent];
    }
    return [];
  }));
  expect(clippedLabels).toEqual([]);
}

test("activity transitions are stable across polls and queued messages are not running turns", async ({ page }) => {
  const state = await fixture(page);
  await openManaged(page);
  const status = page.locator("#activity-status");
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toContainText("Working…");
  await expect(status).toContainText("Read");
  await page.evaluate(() => {
    (window as any).statusMutations = 0;
    new MutationObserver((records) => { (window as any).statusMutations += records.length; })
      .observe(document.querySelector("#activity-status")!, { childList: true, subtree: true, characterData: true });
  });
  const before = state.calls.filter((call) => call.path === "/api/session").length;
  await refreshFixture(page, state);
  await expect.poll(() => state.calls.filter((call) => call.path === "/api/session").length).toBeGreaterThan(before);
  // Wait for the response to be rendered, not merely for its request to arrive.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => (window as any).statusMutations)).toBe(0);
  for (const [reported, label] of [["needs_input", "Needs you"], ["turn_finished", "Ready"], ["failed", "Failed"]]) {
    state.sessions[0].state = reported;
    await refreshFixture(page, state);
    await expect(status).toHaveText(label);
  }
  state.sessions[0].state = "turn_finished";
  await refreshFixture(page, state);
  await expect(status).toHaveText("Ready");
  await page.getByLabel("Message this session").fill("A queued follow-up");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await expect(status).toHaveText("Ready");
});

test("PM busy and offline last-known activity use the same status without live offline animation", async ({ page }) => {
  const state = await fixture(page);
  state.pmBusy = true;
  await page.goto("/");
  await page.locator("#select-pm").click();
  const status = page.locator("#activity-status");
  await expect(status).toHaveText("Working…");
  await expect.poll(() => status.evaluate((el) => el.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length)).toBeGreaterThan(0);
  state.online = false;
  await refreshFixture(page, state);
  await expect(status).toContainText("Last known");
  await expect(status).toContainText("Working…");
  expect(await status.evaluate((el) => el.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length)).toBe(0);
  state.online = true;
  state.pmBusy = false;
  await refreshFixture(page, state);
  await expect(status).toHaveText("Ready");
});

test("reduced motion keeps the working label and static activity symbol", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page);
  await openManaged(page);
  const status = page.locator("#activity-status");
  await expect(status).toContainText("Working…");
  expect(await status.evaluate((el) => el.getAnimations({ subtree: true }).some((animation) => animation.playState === "running"))).toBe(false);
});

test("appearance follows the OS until overridden and persists only its preference locally", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await fixture(page);
  await page.goto("/");
  const appearance = page.getByRole("combobox", { name: "Appearance", exact: true });
  await expect(appearance).toHaveValue("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkThemeColor = await page.locator('meta[name="theme-color"]').getAttribute("content");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.locator('meta[name="theme-color"]').getAttribute("content")).not.toBe(darkThemeColor);
  await appearance.focus();
  await expect(appearance).toBeFocused();
  await page.keyboard.press("d");
  await page.keyboard.press("Enter");
  await expect(appearance).toHaveValue("dark");
  await page.reload();
  await expect(appearance).toHaveValue("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({ "foreman:appearance": "dark" });
  await appearance.selectOption("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await appearance.selectOption("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("stored appearance reaches sign-in before app code loads", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => localStorage.setItem("foreman:appearance", "dark"));
  await fixture(page, { auth: { required: true } });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/app.js", async (route) => { await pending; await route.continue(); });
  await page.goto("/", { waitUntil: "commit" });
  await expect(page.locator("#auth-title")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  release();
  await expect(page.locator("#auth-status")).toContainText("has not been configured");
  const appearance = page.getByRole("combobox", { name: "Appearance", exact: true });
  await expect(appearance).toHaveValue("dark");
  await appearance.selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("unavailable browser storage leaves appearance and inbox usable", async ({ page }) => {
  await page.addInitScript(() => {
    for (const method of ["getItem", "setItem"] as const)
      Storage.prototype[method] = () => { throw new DOMException("Storage blocked", "SecurityError"); };
  });
  await page.emulateMedia({ colorScheme: "light" });
  await fixture(page);
  await openManaged(page);
  const appearance = page.getByRole("combobox", { name: "Appearance", exact: true });
  await expect(appearance).toHaveValue("system");
  await appearance.selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByLabel("Message this session")).toBeEnabled();
  await page.reload();
  await expect(appearance).toHaveValue("system");
});

test("initial conversation loading becomes a true empty state and background refresh retains history", async ({ page }) => {
  const state = await fixture(page, { history: [] });
  let release = state.defer("/api/session");
  await page.goto("/");
  await page.getByRole("button", { name: /Fix sign-in/ }).click();
  const loading = page.locator("#conversation-loading");
  await expect(loading).toHaveAttribute("role", "status");
  await expect(loading).toContainText("Opening conversation…");
  release();
  await expect(loading).toBeHidden();
  await expect(page.getByText("Send a task or a follow-up to begin the conversation.", { exact: true })).toBeVisible();
  await expect(page.locator(".message")).toHaveCount(0);
  state.history.push({ id: "loaded", role: "assistant", text: "History remains readable", at: new Date().toISOString() });
  await refreshFixture(page, state);
  await expect(page.getByText("History remains readable", { exact: true })).toBeVisible();
  release = state.defer("/api/session");
  const before = state.calls.filter((call) => call.path === "/api/session").length;
  await refreshFixture(page, state);
  await expect.poll(() => state.calls.filter((call) => call.path === "/api/session").length).toBeGreaterThan(before);
  await expect(page.getByText("History remains readable", { exact: true })).toBeVisible();
  await expect(loading).toBeHidden();
  release();
});

test("send and interrupt show pending once and retain local recoverable failures", async ({ page }) => {
  const state = await fixture(page);
  await openManaged(page);
  let release = state.defer("/api/session/message");
  await page.getByLabel("Message this session").fill("Preserve my draft");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sending…", exact: true })).toBeDisabled();
  expect(state.calls.filter((call) => call.path === "/api/session/message")).toHaveLength(1);
  await expect(page.getByText("Queued", { exact: true })).toHaveCount(0);
  state.failures.set("/api/session/message", "Relay unavailable: " + "unbroken-error-detail".repeat(20));
  release();
  await expect(page.locator("#send-feedback")).toContainText("Relay unavailable");
  await expect(page.getByLabel("Message this session")).toHaveValue("Preserve my draft");
  await expectNoPageOverflow(page);
  release = state.defer("/api/session/interrupt");
  await page.getByRole("button", { name: "Interrupt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Interrupting…", exact: true })).toBeDisabled();
  expect(state.calls.filter((call) => call.path === "/api/session/interrupt")).toHaveLength(1);
  state.failures.set("/api/session/interrupt", "Interrupt was not accepted");
  release();
  await expect(page.locator("#interrupt-feedback")).toContainText("Interrupt was not accepted");
  await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeEnabled();
});

test("session creation and model save wait for confirmation before reporting success", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/");
  await page.locator("#select-pm").click();
  await expect(page.locator("#pm-model")).toBeEnabled();
  let release = state.defer("/api/pm/model");
  await page.locator("#pm-model").selectOption("haiku");
  await expect(page.locator("#pm-model-hint")).toHaveText("Saving…");
  await expect(page.locator("#pm-model")).toBeDisabled();
  expect(state.calls.filter((call) => call.path === "/api/pm/model")).toHaveLength(1);
  expect(state.pmModel).toBeNull();
  release();
  await expect(page.locator("#pm-model-hint")).toContainText("Saved");
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.locator("#start-manually").click();
  await page.getByLabel("Session name").fill("Pending launch");
  await page.getByLabel("Project directory").fill("/Users/dev/code/app");
  await page.getByLabel("First task").fill("Inspect the project");
  release = state.defer("/api/sessions");
  await page.getByRole("button", { name: "Start session", exact: true }).click();
  await expect(page.getByRole("button", { name: "Starting…", exact: true })).toBeDisabled();
  expect(state.calls.filter((call) => call.path === "/api/sessions" && call.body)).toHaveLength(1);
  expect(state.sessions).toHaveLength(2);
  release();
  await expect(page.getByRole("heading", { name: "Pending launch", exact: true })).toBeVisible();
});

for (const [kind, decision, action, pending] of [
  ["permission", "allow", "Allow once", "Allowing…"],
  ["permission", "deny", "Deny", "Denying…"],
  ["question", "allow", "Send answer", "Sending answer…"],
  ["question", "deny", "Decline", "Declining…"],
]) {
  test(`${action} stays pending across polls and failure preserves the request`, async ({ page }) => {
    const state = await fixture(page, { approvals: [{
      id: "pending-approval", kind, tool: "Read", input: { path: "src/index.ts" },
      ...(kind === "question" ? { questions: [{ id: "scope", question: "Which scope?", options: ["Unit", "All"] }] } : {}),
    }] });
    await openManaged(page);
    if (kind === "question") await page.getByLabel("Which scope?").selectOption("Unit");
    const release = state.defer("/api/session/approval");
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect(page.getByRole("button", { name: pending, exact: true })).toBeDisabled();
    state.approvals.push({ id: "arrived-during-response", kind: "permission", tool: "Write", input: {} });
    await refreshFixture(page, state);
    await expect(page.getByText("Permission requested · Write", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: pending, exact: true })).toBeDisabled();
    const calls = state.calls.filter((call) => call.path === "/api/session/approval");
    expect(calls).toHaveLength(1);
    expect(calls[0].body.decision).toBe(decision);
    state.failures.set("/api/session/approval", "Approval response was not accepted");
    release();
    await expect(page.locator("#approvals").getByRole("alert")).toContainText("Approval response was not accepted");
    await expect(page.locator("#approvals form").first().getByRole("button", { name: action, exact: true })).toBeEnabled();
    if (kind === "question") await expect(page.getByLabel("Which scope?")).toHaveValue("Unit");
  });
}

test.describe("mobile polish", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 360, height: 740 } });

  test("touch navigation, full session details, and dismiss controls remain reachable", async ({ page }) => {
    const state = await fixture(page);
    const longPath = "/Users/dev/code/" + "a-long-project-directory-".repeat(8);
    state.sessions[0].cwd = longPath;
    await page.goto("/");
    await page.getByRole("button", { name: "Open session navigation" }).tap();
    await page.getByRole("button", { name: /Fix sign-in/ }).tap();
    await page.getByText("Session details", { exact: true }).tap();
    await expect(page.getByText(longPath, { exact: false })).toBeVisible();
    await expectNoPageOverflow(page);
    await page.getByText("Session details", { exact: true }).tap();
    await page.getByRole("button", { name: "Open session navigation" }).tap();
    const appearance = page.getByRole("combobox", { name: "Appearance", exact: true });
    await appearance.selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator("#close-nav").tap();
    await expect(page.locator("#open-nav")).toBeFocused();
    for (const selector of ["#open-nav", "#interrupt", "#send"]) {
      const box = await page.locator(selector).boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
  });

  test("keyboard dismiss returns focus and the short landscape dialog can scroll to its actions", async ({ page }) => {
    await fixture(page);
    await page.goto("/");
    await page.locator("#open-nav").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#close-nav")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#open-nav")).toBeFocused();
    await page.keyboard.press("Enter");
    await page.locator("#new-session").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#launch-brief")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#new-session")).toBeFocused();
    await page.keyboard.press("Enter");
    await page.locator("#start-manually").click();
    await page.setViewportSize({ width: 740, height: 360 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.getByLabel("Session name").fill("Landscape test");
    await page.getByLabel("Project directory").fill("/Users/dev/code/app");
    await page.getByLabel("First task").fill("Keep the form usable");
    await page.getByRole("button", { name: "Start session", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Start session", exact: true })).toBeInViewport();
    await expectActionTextFits(page, ".dialog-actions button");
    await expectNoPageOverflow(page);
    await page.getByRole("button", { name: "Cancel", exact: true }).tap();
    await expect(page.locator("#new-session")).toBeFocused();
  });

  test("short landscape rail retains scrollable sessions and reachable appearance at 200 percent text", async ({ page }) => {
    await page.setViewportSize({ width: 740, height: 360 });
    const state = await fixture(page);
    state.sessions.push(...Array.from({ length: 30 }, (_, index) => ({
      ...observed, session_key: `codex:landscape-${index}`, session_id: `landscape-${index}`, name: `Landscape worker ${index + 1}`,
    })));
    await page.goto("/");
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.getByRole("button", { name: "Open session navigation" }).tap();
    await page.getByRole("button", { name: /Landscape worker 30/ }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: /Landscape worker 30/ })).toBeInViewport();
    const dimensions = await page.locator("#session-list").evaluate((el) => ({ height: el.clientHeight, scrolls: el.scrollHeight > el.clientHeight }));
    expect(dimensions.height).toBeGreaterThan(44);
    expect(dimensions.scrolls).toBe(true);
    await page.getByRole("button", { name: /Landscape worker 30/ }).tap();
    await expect(page.getByRole("heading", { name: "Landscape worker 30", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open session navigation" }).tap();
    const appearance = page.getByRole("combobox", { name: "Appearance", exact: true });
    await appearance.scrollIntoViewIfNeeded();
    await expect(appearance).toBeInViewport();
    await appearance.selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator("#close-nav").scrollIntoViewIfNeeded();
    await page.locator("#close-nav").tap();
    await expect(page.locator("#open-nav")).toBeFocused();
    await expectNoPageOverflow(page);
  });

  test("200 percent text and a reduced visual viewport preserve composer and approval actions", async ({ page }) => {
    await fixture(page, { approvals: [{
      id: "mobile-question", kind: "question", tool: "requestUserInput", input: {},
      questions: [{ id: "scope", question: "Which scope should this long-running session inspect?", options: ["Unit tests", "All tests"] }],
    }], history: Array.from({ length: 25 }, (_, index) => ({
      id: `mobile-${index}`, role: "assistant", text: `Update ${index}: ${"A readable history entry. ".repeat(10)}`,
      at: new Date().toISOString(),
    })) });
    await page.goto("/");
    await page.getByRole("button", { name: "Open session navigation" }).tap();
    await page.getByRole("button", { name: /Fix sign-in/ }).tap();
    await expect(page.locator(".message")).toHaveCount(25);
    // Root text sizing persists when polling replaces message or approval elements.
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await expectNoPageOverflow(page);
    await expectActionTextFits(page, "#send, #interrupt, #approvals button");
    const answer = page.getByLabel("Which scope should this long-running session inspect?");
    await answer.selectOption("All tests");
    await page.getByRole("button", { name: "Send answer", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Send answer", exact: true })).toBeInViewport();
    await page.getByRole("button", { name: "Send answer", exact: true }).tap();
    await expect(answer).toHaveCount(0);
    await page.getByLabel("Message this session").fill("A mobile draft");
    // Reduced viewport exercises layout constraints, not actual Android keyboard behavior.
    await page.setViewportSize({ width: 360, height: 420 });
    await expectNoPageOverflow(page);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
    await page.getByRole("button", { name: "Send", exact: true }).tap();
    await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  });
});


test("project picker resolves names, asks for ambiguity and missing references, and confirms an absolute path before launch", async ({ page }) => {
  const state = await fixture(page);
  state.projects.push({ id: "second", name: "work app", path: "/Users/dev/work/app", aliases: ["personal repo"], lastUsed: null });
  await page.goto("/"); await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.locator("#start-manually").click();
  await expect(page.getByRole("button", { name: "app /Users/dev/code/app", exact: true })).toBeVisible();
  await page.getByLabel("Project directory").fill("personal repo");
  await expect(page.locator("#project-status")).toContainText("Which project");
  await expect(page.getByRole("button", { name: "Start session", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "work app /Users/dev/work/app", exact: true }).click();
  await expect(page.locator("#project-status")).toContainText("/Users/dev/work/app");
  await page.getByLabel("Project directory").fill("unknown repo");
  await expect(page.locator("#project-status")).toContainText("No project matches");
  expect(state.calls.filter((c) => c.path === "/api/sessions" && c.body)).toHaveLength(0);
  await page.getByLabel("Project directory").fill("app");
  await expect(page.locator("#project-status")).toContainText("Project: app · /Users/dev/code/app");
  await page.getByLabel("Session name").fill("named-project"); await page.getByLabel("First task").fill("Inspect this project");
  await page.getByRole("button", { name: "Start session", exact: true }).click();
  expect(state.calls.find((c) => c.path === "/api/sessions" && c.body)?.body.cwd).toBe("/Users/dev/code/app");
});

test("a developer remembers, renames, removes projects on the host and can read full paths by keyboard on mobile", async ({ page }) => {
  const state = await fixture(page); (state.sessions[0] as any).project_name = "personal";
  await page.setViewportSize({ width: 360, height: 640 }); await page.goto("/");
  await page.getByRole("button", { name: "Open session navigation" }).click();
  await page.getByRole("button", { name: /Fix sign-in/ }).click();
  const details = page.locator("#heading-details summary"); await details.focus(); await page.keyboard.press("Enter");
  await expect(page.locator("#conversation-subtitle")).toContainText(managed.cwd);
  await expect(details).toContainText("personal");
  await page.getByRole("button", { name: "Open session navigation" }).click();
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.locator("#start-manually").click();
  await page.getByLabel("Project directory").fill("/Users/dev/code/new-project");
  await expect(page.locator("#project-status")).toContainText("Unregistered directory");
  await page.getByText("Remember or manage a project", { exact: true }).click();
  await page.getByLabel("Short project name").fill("new repo"); await page.getByLabel("Aliases (comma separated)").fill("my repo");
  await page.getByRole("button", { name: "Remember project", exact: true }).click();
  await expect(page.locator("#project-feedback")).toContainText("Project saved");
  expect(state.projects.at(-1)).toMatchObject({ name: "new repo", aliases: ["my repo"] });
  await page.getByLabel("Short project name").fill("renamed repo"); await page.getByRole("button", { name: "Save project name" }).click();
  await expect(page.locator("#project-status")).toContainText("renamed repo");
  await page.getByRole("button", { name: "Remove project" }).click();
  await expect(page.locator("#project-feedback")).toContainText("Project removed");
  expect(state.projects.some((p) => p.name === "renamed repo")).toBe(false);
  await expect(page.getByLabel("Project directory")).toBeFocused();
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("a stale project resolution cannot enable launch for a newer unknown reference", async ({ page }) => {
  const state = await fixture(page); state.projectDelay = 500;
  await page.goto("/"); await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.locator("#start-manually").click();
  await page.getByLabel("Project directory").fill("app");
  await expect.poll(() => state.calls.some((c) => c.path === "/api/projects/resolve" && c.body.reference === "app")).toBe(true);
  state.projectDelay = 0; await page.getByLabel("Project directory").fill("unknown");
  await expect(page.locator("#project-status")).toContainText("No project matches");
  await page.waitForTimeout(600);
  await expect(page.locator("#project-status")).toContainText("No project matches");
  await expect(page.getByRole("button", { name: "Start session", exact: true })).toBeDisabled();
  expect(state.calls.filter((c) => c.path === "/api/sessions" && c.body)).toHaveLength(0);
});


for (const problem of ["Project directory is missing or unreadable", "Project directory changed its symlink target"]) {
  test(`an unavailable registered project remains manageable: ${problem}`, async ({ page }) => {
    const state = await fixture(page); state.projectErrors["/Users/dev/code/app"] = `${problem}: /Users/dev/code/app`;
    await page.goto("/"); await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.locator("#start-manually").click();
    await page.getByRole("button", { name: "app /Users/dev/code/app", exact: true }).click();
    await expect(page.locator("#project-status")).toContainText(problem);
    await expect(page.getByRole("button", { name: "Start session", exact: true })).toBeDisabled();
    await page.getByText("Remember or manage a project", { exact: true }).click();
    await page.getByLabel("Short project name").fill("stale project"); await page.getByRole("button", { name: "Save project name" }).click();
    await expect(page.locator("#project-feedback")).toContainText("Project saved");
    await expect(page.getByRole("button", { name: "Start session", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Remove project" }).click();
    await expect(page.locator("#project-feedback")).toContainText("Project removed");
    expect(state.projects).toHaveLength(0);
    // Restoring a directory or removing its obsolete pin makes explicit registration possible.
    await page.getByLabel("Project directory").fill("/Users/dev/code/app");
    await expect(page.locator("#project-status")).toContainText("Unregistered directory");
    await page.getByLabel("Short project name").fill("restored project"); await page.getByRole("button", { name: "Remember project", exact: true }).click();
    await expect(page.locator("#project-status")).toContainText("restored project");
    expect(state.calls.filter((c) => c.path === "/api/sessions" && c.body)).toHaveLength(0);
  });
}

test('launcher brief is default, has an independent model, and manual spends no launcher turn', async ({ page }) => {
  const state = await fixture(page); await page.goto('/'); await page.locator('#new-session').click();
  await expect(page.locator('#launch-brief')).toBeFocused();
  await expect(page.locator('#launcher-model')).toHaveValue('claude-sonnet-5');
  await page.locator('#launch-brief').fill('Fix sign-in in app');
  await expect(page.locator('#propose-session')).toBeEnabled();
  expect(state.calls.filter((c) => c.path === '/api/launch/propose' || c.path === '/api/sessions' && c.body)).toHaveLength(0);
  await page.locator('#start-manually').click();
  await expect(page.locator('#new-prompt')).toHaveValue('Fix sign-in in app');
  await expect(page.locator('#new-name')).toBeFocused();
  expect(state.calls.filter((c) => c.path === '/api/launch/propose')).toHaveLength(0);
});

test('proposal requires confirmation, every field is editable, and confirmation retains creation retry ID', async ({ page }) => {
  const state = await fixture(page); state.failCreates = 1;
  await page.goto('/'); await page.locator('#new-session').click();
  await page.locator('#launch-brief').fill('Fix sign-in in app');
  await page.locator('#launcher-model').selectOption('haiku');
  const release = state.defer('/api/launch/propose');
  await page.locator('#propose-session').click();
  await expect(page.locator('#launch-status')).toContainText('Working…');
  await expect(page.locator('#propose-session')).toBeDisabled();
  expect(state.calls.filter((c) => c.path === '/api/sessions' && c.body)).toHaveLength(0);
  release();
  await expect(page.locator('#launch-status')).toContainText('Proposal ready');
  await expect(page.locator('#new-model')).toHaveValue('gpt-6-astra');
  expect(state.calls.find((c) => c.path === '/api/launch/propose')?.body.model).toBe('haiku');
  await expect(page.locator('#launch-reason')).toContainText('Codex suits');
  await page.locator('#new-name').fill('edited-session');
  await page.locator('#new-cwd').fill('/Users/dev/code/other');
  await page.locator('#new-provider').selectOption('claude');
  await expect(page.locator('#new-model')).toBeEnabled(); await page.locator('#new-model').selectOption('sonnet');
  await page.locator('#new-prompt').fill('The complete edited first task\nKeep every line.');
  expect(state.calls.filter((c) => c.path === '/api/sessions' && c.body)).toHaveLength(0);
  await page.getByRole('button', { name: 'Confirm and start', exact: true }).click();
  await expect(page.locator('#new-error')).toContainText('Temporary relay failure');
  await page.getByRole('button', { name: 'Confirm and start', exact: true }).click();
  await expect(page.locator('#new-dialog')).not.toBeVisible();
  const creates = state.calls.filter((c) => c.path === '/api/sessions' && c.body);
  expect(creates).toHaveLength(2); expect(creates[0].body.id).toBe(creates[1].body.id);
  expect(creates[1].body).toMatchObject({ name: 'edited-session', cwd: '/Users/dev/code/other', provider: 'claude', model: 'sonnet', text: 'The complete edited first task\nKeep every line.', permission_mode: 'native' });
});

for (const reason of ['Launcher claude-sonnet-5 is unavailable', 'Launcher took too long', 'Which project do you mean?', 'Launcher returned an unusable proposal']) {
  test(`launcher manual fallback preserves brief: ${reason}`, async ({ page }) => {
    const state = await fixture(page); state.launchStatus = 'failed'; state.launchError = reason;
    await page.goto('/'); await page.locator('#new-session').click(); await page.locator('#launch-brief').fill('Preserve the complete brief');
    await page.locator('#propose-session').click();
    await expect(page.locator('#launch-status')).toContainText(reason);
    await expect(page.locator('#new-prompt')).toHaveValue('Preserve the complete brief');
    await expect(page.locator('#new-name')).toBeFocused();
    expect(state.calls.filter((c) => c.path === '/api/sessions' && c.body)).toHaveLength(0);
    expect(state.calls.find((c) => c.path === '/api/launch/propose')?.body.model).toBe('claude-sonnet-5');
    await page.locator('#edit-brief').click(); await expect(page.locator('#launch-brief')).toHaveValue('Preserve the complete brief');
  });
}

test('cancel/manual discard delayed proposals, preserve edits, and never create sessions', async ({ page }) => {
  const state = await fixture(page); await page.goto('/'); await page.locator('#new-session').click();
  await page.locator('#launch-brief').fill('First brief'); let release = state.defer('/api/launch/propose');
  await page.locator('#propose-session').click(); await expect(page.locator('#launch-status')).toContainText('Working');
  await page.locator('#start-manually').click(); await page.locator('#new-name').fill('manual-edit');
  release(); await expect.poll(() => state.calls.filter((c) => c.path === '/api/launch/cancel').length).toBe(1);
  await expect(page.locator('#new-name')).toHaveValue('manual-edit'); await expect(page.locator('#new-prompt')).toHaveValue('First brief');
  await page.locator('#edit-brief').click(); await page.locator('#launch-brief').fill('Second brief');
  release = state.defer('/api/launch/propose'); await page.locator('#propose-session').click();
  await expect(page.locator('#launch-status')).toContainText('Working'); await page.keyboard.press('Escape'); release();
  await expect(page.locator('#new-dialog')).not.toBeVisible();
  await expect.poll(() => state.calls.filter((c) => c.path === '/api/launch/cancel').length).toBe(2);
  expect(state.calls.filter((c) => c.path === '/api/sessions' && c.body)).toHaveLength(0);
});

test('manual after proposal retains edits and first-task text without another launcher turn', async ({ page }) => {
  const state = await fixture(page); await page.goto('/'); await page.locator('#new-session').click();
  await page.locator('#launch-brief').fill('Original brief'); await page.locator('#propose-session').click();
  await expect(page.locator('#launch-status')).toContainText('Proposal ready');
  await page.locator('#new-name').fill('my-edited-name'); await page.locator('#new-prompt').fill('My edited complete task');
  await page.locator('#start-manually').click();
  await expect(page.locator('#new-name')).toHaveValue('my-edited-name'); await expect(page.locator('#new-prompt')).toHaveValue('My edited complete task');
  expect(state.calls.filter((c) => c.path === '/api/launch/propose')).toHaveLength(1);
  expect(state.calls.filter((c) => c.path === '/api/sessions' && c.body)).toHaveLength(0);
});

test('launcher keyboard review remains usable at 360px and short landscape with enlarged text', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 }); await fixture(page); await page.goto('/');
  await page.locator('#open-nav').click(); await page.locator('#new-session').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#launch-brief')).toBeFocused(); await page.locator('#launch-brief').fill('Fix sign-in in app');
  await page.locator('#propose-session').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#new-name')).toBeFocused(); await expectNoPageOverflow(page);
  await page.setViewportSize({ width: 740, height: 360 }); await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.locator('#new-prompt').fill('Edited task on a small screen');
  await page.locator('#create-session').scrollIntoViewIfNeeded(); await expect(page.locator('#create-session')).toBeInViewport();
  await expectActionTextFits(page, '.dialog-actions button'); await expectNoPageOverflow(page);
  await page.keyboard.press('Escape'); await expect(page.locator('#new-session')).toBeFocused();
});

test('a model catalog refresh failure retains the explicitly proposed worker model for confirmation', async ({ page }) => {
  const state = await fixture(page); await page.goto('/'); await page.locator('#new-session').click();
  await expect(page.locator('#new-model option')).toHaveCount(3);
  await page.locator('#launch-brief').fill('Fix sign-in in app');
  state.failures.set('/api/models', 'Model catalog disconnected');
  await page.locator('#propose-session').click();
  await expect(page.locator('#launch-status')).toContainText('Proposal ready');
  await expect(page.locator('#new-model-hint')).toContainText('Model catalog disconnected');
  await expect(page.locator('#new-model')).toHaveValue('gpt-6-astra');
  await page.locator('#create-session').click();
  await expect.poll(() => state.calls.filter((c) => c.path === '/api/sessions' && c.body).length).toBe(1);
  expect(state.calls.find((c) => c.path === '/api/sessions' && c.body)?.body.model).toBe('gpt-6-astra');
});

test('an offline host cancels a pending proposal and preserves the brief in manual fallback', async ({ page }) => {
  const state = await fixture(page); state.launchStatus = 'working';
  await page.goto('/'); await page.locator('#new-session').click(); await page.locator('#launch-brief').fill('Keep this offline brief');
  await page.locator('#propose-session').click(); await expect(page.locator('#launch-status')).toContainText('Working');
  state.online = false; await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#launch-status')).toContainText('Host is offline');
  await expect(page.locator('#new-prompt')).toHaveValue('Keep this offline brief');
  await expect(page.locator('#create-session')).toBeDisabled();
  await expect.poll(() => state.calls.filter((c) => c.path === '/api/launch/cancel').length).toBe(1);
  expect(state.calls.filter((c) => c.path === '/api/sessions' && c.body)).toHaveLength(0);
});

test('sign-out cancels the launcher and erases its brief while a delayed response cannot restore it', async ({ page }) => {
  await page.route('https://www.gstatic.com/firebasejs/**/firebase-app.js', (route) => route.fulfill({ contentType: 'application/javascript', body: 'export const initializeApp = value => value;' }));
  await page.route('https://www.gstatic.com/firebasejs/**/firebase-auth.js', (route) => route.fulfill({ contentType: 'application/javascript', body: `
    const user = {email:'owner@example.com',getIdToken:async()=> 'fixture-id-token'};
    let callback;
    export const getAuth = () => ({currentUser:user});
    export const onAuthStateChanged = (auth,fn) => { callback=fn; queueMicrotask(()=>fn(user)); };
    export const signOut = async auth => { auth.currentUser=null; callback(null); };
  ` }));
  const state = await fixture(page, { auth: { required: true, firebase: { apiKey: 'fixture-api-key' } } });
  await page.goto('/'); await page.locator('#new-session').click(); await page.locator('#launch-brief').fill('Private launch draft');
  const release = state.defer('/api/launch/propose'); await page.locator('#propose-session').click();
  await expect(page.locator('#launch-status')).toContainText('Working');
  // Sign-out control sits outside the modal; exercise the existing sign-out handler directly.
  await page.locator('#sign-out').evaluate((button: HTMLButtonElement) => button.click());
  release(); await expect(page.locator('#app')).toBeHidden(); await expect(page.locator('#new-dialog')).not.toBeVisible();
  await expect(page.locator('#launch-brief')).toHaveValue('');
  await expect.poll(() => state.calls.filter((c) => c.path === '/api/launch/cancel').length).toBe(1);
  expect(state.calls.filter((c) => c.path === '/api/sessions' && c.body)).toHaveLength(0);
});

async function refreshTimeline(page: Page) {
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/session");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await response;
  await page.evaluate(() => new Promise(requestAnimationFrame));
}

test("new output preserves the reading anchor across polls, streaming and history truncation", async ({ page }) => {
  const state = await fixture(page, {
    history: Array.from({ length: 60 }, (_, index) => ({ role: "assistant", text: `Answer ${index}\n${"Read this detail. ".repeat(20)}`, at: new Date(2026, 8, 1, 0, index).toISOString() })),
  });
  await openManaged(page);
  const timeline = page.locator("#timeline");
  await expect(page.locator("#jump-latest")).toBeHidden();
  await timeline.evaluate((el) => { el.scrollTop = 1800; });
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
  const anchor = await page.locator(".message").evaluateAll((els) => {
    const top = document.querySelector("#timeline")!.getBoundingClientRect().top;
    const el = els.find((el) => el.getBoundingClientRect().bottom > top)!;
    return { text: el.querySelector(".message-body")!.textContent!, top: el.getBoundingClientRect().top };
  });
  await refreshTimeline(page);
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
  state.history = state.history.slice(3);
  state.history[0].text += "\nStreaming growth above the visible answer. ".repeat(10);
  state.history.push({ role: "assistant", text: "A new answer arrived", at: new Date().toISOString() });
  await refreshTimeline(page);
  await expect(page.getByRole("button", { name: "New messages ↓", exact: true })).toBeVisible();
  const position = await page.locator(".message").filter({ has: page.locator(".message-body", { hasText: anchor.text }) }).evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(position - anchor.top)).toBeLessThan(2);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "New messages ↓", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(timeline).toBeFocused();
  await expect(page.locator("#jump-latest")).toBeHidden();
  expect(await timeline.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
  state.history.push({ role: "assistant", text: "Automatically follow this new answer", at: new Date().toISOString() });
  await refreshTimeline(page);
  expect(await timeline.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
});

test("receipt updates do not announce new history and switching conversations clears the marker", async ({ page }) => {
  const state = await fixture(page, { history: Array.from({ length: 40 }, (_, i) => ({ id: `entry-${i}`, role: "assistant", text: `Message ${i} ${"detail ".repeat(40)}` })) });
  state.receipts.push({ id: "receipt", text: "queued task", status: "queued" });
  await openManaged(page);
  await page.locator("#timeline").evaluate((el) => { el.scrollTop = 200; });
  state.receipts[0].status = "running";
  await refreshTimeline(page);
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New messages ↓", exact: true })).toBeHidden();
  state.history.at(-1)!.text += " streamed output";
  await refreshTimeline(page);
  await expect(page.getByRole("button", { name: "New messages ↓", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Terminal research/ }).click();
  await expect(page.locator(".message")).toHaveCount(41);
  await expect(page.locator("#jump-latest")).toBeHidden();
  await page.locator("#timeline").evaluate((el) => { el.scrollTop = 200; });
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
  await page.locator("#timeline").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator("#jump-latest")).toBeHidden();
});

test("mobile touch jump stays separate from composer and approval actions", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  const state = await fixture(page, { history: Array.from({ length: 30 }, (_, i) => ({ id: String(i), role: "assistant", text: `Answer ${i} ${"detail ".repeat(30)}` })), approvals: [{ id: "allow", kind: "permission", tool: "Read", reason: "Read the project file" }] });
  await page.goto("/");
  await page.getByRole("button", { name: "Open session navigation" }).tap();
  await page.getByRole("button", { name: /Fix sign-in/ }).tap();
  await expect(page.locator(".message")).toHaveCount(30);
  await page.locator("#timeline").evaluate((el) => { el.scrollTop = 100; });
  state.history.push({ id: "new", role: "assistant", text: "New answer" });
  await refreshTimeline(page);
  const button = page.getByRole("button", { name: "New messages ↓", exact: true });
  const bounds = await button.boundingBox();
  const composer = await page.locator("#composer").boundingBox();
  const history = await page.locator("#timeline").boundingBox();
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
  expect(bounds!.y).toBeGreaterThanOrEqual(history!.y + history!.height);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(composer!.y);
  await button.tap();
  await expect(button).toBeHidden();
  await expect(page.getByRole("button", { name: "Allow once" })).toBeInViewport();
  await context.close();
});


test("PM timestamp identity notices a repeated answer after capped history shifts", async ({ page }) => {
  const state = await fixture(page);
  state.pmHistory = Array.from({ length: 40 }, (_, i) => ({ role: "assistant", text: i === 0 ? "Done" : `Answer ${i} ${"detail ".repeat(40)}`, ts: new Date(2026, 8, 1, 0, i).toISOString() }));
  await page.goto("/");
  await page.getByRole("button", { name: /Project manager Plan and delegate/ }).click();
  await expect(page.locator(".message")).toHaveCount(40);
  await page.locator("#timeline").evaluate((el) => { el.scrollTop = 1000; });
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
  state.pmHistory = state.pmHistory.slice(1);
  state.pmHistory.push({ role: "assistant", text: "Done", ts: new Date(2026, 8, 1, 1, 0).toISOString() });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("button", { name: "New messages ↓", exact: true })).toBeVisible();
});


test("jump and composer remain reachable when a viewport resize notification is missed", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  // Model a delayed visualViewport resize event, while keeping the real viewport.
  await page.addInitScript(() => {
    const viewport = window.visualViewport!;
    const listen = viewport.addEventListener.bind(viewport);
    viewport.addEventListener = ((type: string, ...args: any[]) => {
      if (type !== "resize") (listen as any)(type, ...args);
    }) as typeof viewport.addEventListener;
  });
  await fixture(page, { history: Array.from({ length: 30 }, (_, i) => ({ id: String(i), role: "assistant", text: `Answer ${i} ${"detail ".repeat(30)}` })) });
  await page.goto("/");
  await page.getByRole("button", { name: "Open session navigation" }).tap();
  await page.getByRole("button", { name: /Fix sign-in/ }).tap();
  await expect(page.locator(".message")).toHaveCount(30);
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await page.setViewportSize({ width: 360, height: 420 });
  await page.locator("#timeline").evaluate((el) => { el.scrollTop = 100; });
  const jump = page.getByRole("button", { name: "Jump to latest", exact: true });
  await expect(jump).toBeInViewport();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
  await expectNoPageOverflow(page);
  await jump.tap();
  await expect(jump).toBeHidden();
  await context.close();
});

test("copy controls write original message and fenced code bytes without sending work", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const code = "printf '<unsafe> & text'\n  indented\n";
  const original = `A useful answer\n\n\`\`\`sh\n${code}\`\`\`\nKeep the final newline.\n`;
  const state = await fixture(page, { history: [{ id: "copy", role: "assistant", text: original, at: new Date().toISOString() }] });
  await openManaged(page);
  const codeCopy = page.getByRole("button", { name: "Copy code", exact: true });
  await codeCopy.focus();
  await page.keyboard.press("Enter");
  await expect(codeCopy.locator("..").getByRole("status")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
  await expect(codeCopy).toBeFocused();
  const messageCopy = page.getByRole("button", { name: "Copy message", exact: true });
  await messageCopy.click();
  await expect(messageCopy.locator("..").getByRole("status")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(original);
  expect(state.calls.filter((call) => call.body && /message|sessions|approval/.test(call.path))).toHaveLength(0);
  await expect(page.locator("#messages unsafe")).toHaveCount(0);
});

test("copy feedback waits for clipboard success and preserves focus through denial and receipt polling", async ({ page }) => {
  const state = await fixture(page, { history: [{ id: "copy", role: "user", text: "Original task" }] });
  state.receipts.push({ id: "copy", text: "Original task", status: "queued" });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => new Promise<void>((resolve, reject) => { (window as any).finishCopy = { resolve, reject }; }) } });
  });
  await openManaged(page);
  const copy = page.getByRole("button", { name: "Copy message", exact: true });
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect(copy).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("Copied", { exact: true })).toHaveCount(0);
  state.receipts[0].status = "running";
  await refreshTimeline(page);
  await expect(copy).toBeFocused();
  await page.evaluate(() => (window as any).finishCopy.reject(new DOMException("Denied", "NotAllowedError")));
  await expect(page.getByRole("status").filter({ hasText: "Could not copy." })).toBeVisible();
  await expect(copy).toBeFocused();
  await expect(page.locator(".message-body")).toHaveText("Original task");
  await page.keyboard.press("Enter");
  await page.evaluate(() => (window as any).finishCopy.resolve());
  await expect(page.getByText("Copied", { exact: true })).toBeVisible();
  await expect(copy).toBeFocused();
});

test("copy controls stay discoverable and tappable on touch at enlarged text", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  await fixture(page, { history: [{ id: "copy", role: "assistant", text: "```sh\necho touch\n```" }] });
  await page.goto("/");
  await page.getByRole("button", { name: "Open session navigation" }).tap();
  await page.getByRole("button", { name: /Fix sign-in/ }).tap();
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  const copy = page.getByRole("button", { name: "Copy code", exact: true });
  await expect(copy).toBeVisible();
  await copy.tap();
  await expect(copy.locator("..").getByRole("status")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("echo touch\n");
  expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expectNoPageOverflow(page);
  await context.close();
});


for (const kind of ["message", "code"]) test(`pending ${kind} clipboard results follow streaming while copying the clicked text`, async ({ page }) => {
  const content = (text: string) => kind === "code" ? `\`\`\`sh\n${text}\n\`\`\`` : text;
  const copied = (text: string) => kind === "code" ? `${text}\n` : text;
  const state = await fixture(page, { history: [{ id: "stream", role: "assistant", text: content("First chunk") }] });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: (text: string) => new Promise<void>((resolve, reject) => { (window as any).finishCopy = { text, resolve, reject }; }) } });
  });
  await openManaged(page);
  const copy = page.getByRole("button", { name: kind === "code" ? "Copy code" : "Copy message", exact: true });
  await copy.focus();
  await page.keyboard.press("Enter");
  state.history[0].text = content("First chunk and more output");
  await refreshTimeline(page);
  await expect(copy).toBeFocused();
  await expect(copy).toHaveAttribute("aria-busy", "true");
  expect(await page.evaluate(() => (window as any).finishCopy.text)).toBe(copied("First chunk"));
  await page.evaluate(() => (window as any).finishCopy.reject(new DOMException("Denied", "NotAllowedError")));
  await expect(copy.locator("..").getByRole("status")).toContainText("Could not copy");
  await expect(copy).toBeFocused();
  await page.keyboard.press("Enter");
  state.history[0].text = content("First chunk and more output again");
  await refreshTimeline(page);
  expect(await page.evaluate(() => (window as any).finishCopy.text)).toBe(copied("First chunk and more output"));
  await page.evaluate(() => (window as any).finishCopy.resolve());
  await expect(copy.locator("..").getByRole("status")).toHaveText("Copied");
  await expect(copy).toBeFocused();
  await expect(page.locator(kind === "code" ? "code" : ".message-body")).toHaveText(copied("First chunk and more output again"));
});

test("header identifies the PM and honestly explains its selected model and independent agent choices", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: /Project manager Plan and delegate/ }).click();
  await expect(page.getByRole("heading", { name: "Claude · Project manager", exact: true })).toBeVisible();
  await expect(page.locator("#header-model")).toHaveText("Model · Provider default");
  await page.getByText("Model details", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#conversation-subtitle")).toContainText("Provider settings determine the model");
  await expect(page.locator(".pm-model-help")).toContainText("replies and planning");
  await expect(page.locator(".pm-model-help")).toContainText("agents have their own model selection");
  await expect(page.locator("#pm-model option[value=haiku]")).toHaveCount(1);
  await page.locator("#pm-model").selectOption("haiku");
  await expect(page.locator("#header-model")).toHaveText("Model · haiku");
  await expect(page.locator("#pm-model-hint")).toContainText("next turn");
  state.pmBusy = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("#pm-model")).toBeDisabled();
  await expect(page.locator("#header-model")).toHaveText("Model · haiku");
});

test("worker header separates identity state project and full model details without inferring defaults", async ({ page }) => {
  const state = await fixture(page);
  Object.assign(state.sessions[0], { permission_mode: "native", project_name: "app", model: "provider-model-with-a-very-long-identifier-".repeat(5) });
  await openManaged(page);
  await expect(page.locator("#provider")).toHaveText("Claude");
  await expect(page.locator("#activity-label")).toContainText("Working");
  await expect(page.locator("#header-model")).toContainText((state.sessions[0] as any).model);
  const details = page.locator("#heading-details summary");
  await details.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#conversation-subtitle dd").filter({ hasText: (state.sessions[0] as any).model })).toBeVisible();
  await expect(page.locator("#conversation-subtitle")).toContainText(managed.cwd);
  await expect(page.locator("#conversation-subtitle")).toContainText("Native");
  (state.sessions[0] as any).model = null;
  await refreshTimeline(page);
  await expect(page.locator("#header-model")).toHaveText("Model · Provider default");
  await expect(page.locator("#conversation-subtitle")).toContainText("Provider settings determine the model");
  await expect(details).toBeFocused();
});

test("phone header keeps history space and exposes long model and project values by touch", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true });
  const page = await context.newPage();
  const state = await fixture(page);
  const longModel = "model-".repeat(45), longPath = "/Users/dev/" + "long-project/".repeat(20);
  Object.assign(state.sessions[0], { model: longModel, cwd: longPath, project_name: "Personal project" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open session navigation" }).tap();
  await page.getByRole("button", { name: /Fix sign-in/ }).tap();
  await expect(page.locator("#header-model")).toContainText(longModel);
  const header = await page.locator(".conversation-head").boundingBox();
  const history = await page.locator("#timeline").boundingBox();
  expect(header!.height).toBeLessThan(history!.height);
  await page.locator("#heading-details summary").tap();
  await expect(page.locator("#conversation-subtitle")).toContainText(longModel);
  await expect(page.locator("#conversation-subtitle")).toContainText(longPath);
  await page.locator("#conversation-subtitle dd").filter({ hasText: longPath }).scrollIntoViewIfNeeded();
  await expect(page.locator("#conversation-subtitle dd").filter({ hasText: longPath })).toBeInViewport();
  await expectNoPageOverflow(page);
  await context.close();
});


test("PM header does not claim a default while its selected model is loading", async ({ page }) => {
  const state = await fixture(page);
  state.pmModel = "sonnet";
  const release = state.defer("/api/pm/history");
  await page.goto("/");
  await page.getByRole("button", { name: /Project manager Plan and delegate/ }).click();
  await expect(page.locator("#header-model")).toHaveText("Model · Loading model…");
  await expect(page.locator("#conversation-subtitle")).not.toContainText("Provider default");
  release();
  await expect(page.locator("#header-model")).toHaveText("Model · sonnet");
});

test("receipt labels distinguish every authoritative status including uncertainty without color", async ({ page }) => {
  const state = await fixture(page, { history: [] });
  state.receipts = ["queued", "running", "completed", "failed", "uncertain"].map((status) => ({ id: status, text: `Task ${status}`, status }));
  await openManaged(page);
  await expect(page.locator(".receipt-label")).toHaveText(["Queued", "Running", "Completed", "Failed", "Delivery uncertain · Check the session before sending again"]);
  const symbols = await page.locator(".receipt-symbol").allTextContents();
  expect(new Set(symbols).size).toBe(5);
  await expect(page.locator(".receipt-symbol[aria-hidden=true]")).toHaveCount(5);
  await expect(page.locator(".message").filter({ hasText: "Task uncertain" })).not.toContainText("Failed");
  expect(state.calls.filter((call) => call.body)).toHaveLength(0);
});

test("approval details retain full safe input, focus and answers across polls without choosing a decision", async ({ page }) => {
  const command = `cat ${"very-long-file-name/".repeat(30)}<untrusted>`;
  const state = await fixture(page, { approvals: [{ id: "request", kind: "question", tool: "Read", reason: "Choose which files to inspect", input: { command, nested: { complete: "Preserve all input" } }, questions: [{ id: "scope", question: "Which files?" }] }] });
  await openManaged(page);
  await expect(page.getByRole("heading", { name: "The agent has a question" })).toBeVisible();
  await expect(page.locator(".approval-reason")).toHaveText("Choose which files to inspect");
  await expect(page.locator(".approval-context")).toContainText("cat very-long-file-name/");
  const answer = page.getByLabel("Which files?");
  await expect(answer).toHaveValue("");
  const summary = page.locator(".approval summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".approval pre")).toHaveText(JSON.stringify(state.approvals[0].input, null, 2));
  await expect(page.locator(".approval untrusted")).toHaveCount(0);
  await answer.fill("Only source files");
  state.approvals.push({ id: "other", kind: "permission", tool: "Write", input: {} });
  await refreshTimeline(page);
  await expect(answer).toBeFocused();
  await expect(answer).toHaveValue("Only source files");
  await expect(page.locator(".approval details")).toHaveAttribute("open", "");
  await summary.focus();
  state.approvals[1].reason = "Write the requested change";
  await refreshTimeline(page);
  await expect(summary).toBeFocused();
  expect(state.calls.filter((call) => call.path === "/api/session/approval")).toHaveLength(0);
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  expect(state.calls.find((call) => call.path === "/api/session/approval")?.body).toEqual({ id: "managed:alpha", approval_id: "other", decision: "deny" });
  await expect(answer).toHaveValue("Only source files");
});

test("local day separators retain history and receipt order with neutral unknown timestamps", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US", timezoneId: "America/Los_Angeles" });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-09-19T19:00:00Z"));
  const state = await fixture(page, { history: [
    { id: "old", role: "assistant", text: "Older answer", at: "2026-09-15T19:00:00Z" },
    { id: "yesterday", role: "assistant", text: "Yesterday locally", at: "2026-09-19T00:30:00Z" },
    { id: "today", role: "assistant", text: "Today locally", at: "2026-09-19T18:00:00Z" },
    { id: "invalid", role: "assistant", text: "Invalid timestamp", at: "not-a-date" },
    { id: "missing", role: "assistant", text: "Missing timestamp" },
  ] });
  state.receipts.push({ id: "receipt", text: "Receipt from yesterday", status: "uncertain", at: "2026-09-19T02:00:00Z" });
  await openManaged(page);
  await expect(page.locator(".date-separator")).toHaveText(["Sep 15, 2026", "Yesterday", "Today", "Date unavailable", "Yesterday"]);
  await expect(page.locator(".message-body")).toHaveText(["Older answer", "Yesterday locally", "Today locally", "Invalid timestamp", "Missing timestamp", "Receipt from yesterday"]);
  await expect(page.locator(".timestamp-unavailable")).toHaveCount(2);
  const time = page.locator(".message").filter({ hasText: "Yesterday locally" }).locator("time");
  await expect(time).toHaveAccessibleDescription(/Friday, September 18, 2026.*5:30:00 PM/);
  await expect(time).toHaveAttribute("datetime", "2026-09-19T00:30:00.000Z");
  await expect(page.locator(".receipt-label")).toContainText("Delivery uncertain");
  await context.close();
});

test("PM dates use ts and midnight relabeling preserves copy focus without a new-message marker", async ({ page }) => {
  const now = new Date("2026-09-19T12:00:00Z");
  await page.clock.setFixedTime(now);
  const state = await fixture(page);
  state.pmHistory = Array.from({ length: 30 }, (_, i) => ({ role: "assistant", text: `Answer ${i} ${"detail ".repeat(30)}`, ts: now.toISOString() }));
  await page.goto("/");
  await page.getByRole("button", { name: /Project manager Plan and delegate/ }).click();
  await expect(page.locator(".date-separator")).toHaveText(["Today"]);
  await expect(page.locator("time")).toHaveCount(30);
  const copy = page.getByRole("button", { name: "Copy message", exact: true }).nth(10);
  await copy.focus();
  await expect(page.getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
  const before = await copy.evaluate((el) => el.getBoundingClientRect().top);
  await page.evaluate(() => { (window as any).dateSeparatorBefore = document.querySelector(".date-separator"); });
  await page.clock.setFixedTime(new Date("2026-09-20T12:00:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".date-separator")).toHaveText(["Yesterday"]);
  await expect(copy).toBeFocused();
  expect(Math.abs(await copy.evaluate((el) => el.getBoundingClientRect().top) - before)).toBeLessThan(2);
  await expect(page.getByRole("button", { name: "New messages ↓", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).dateSeparatorBefore === document.querySelector(".date-separator"))).toBe(true);
  await expect(page.locator(".date-separator[aria-live], .date-separator[role=status]")).toHaveCount(0);
});


test("impossible calendar dates stay neutral while valid offsets and leap days keep their local dates", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US", timezoneId: "America/Los_Angeles" });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-09-19T19:00:00Z"));
  await fixture(page, { history: [
    { id: "feb", role: "assistant", text: "Impossible February day", at: "2026-02-30T12:00:00Z" },
    { id: "apr", role: "assistant", text: "Impossible April day", at: "2026-04-31T12:00:00Z" },
    { id: "nonleap", role: "assistant", text: "Not a leap year", at: "2025-02-29T12:00:00Z" },
    { id: "leap", role: "assistant", text: "Valid leap day", at: "2024-02-29T12:00:00-08:00" },
    { id: "offset", role: "assistant", text: "Offset crosses local midnight", at: "2026-09-19T02:30:00+02:00" },
  ] });
  await openManaged(page);
  await expect(page.locator(".timestamp-unavailable")).toHaveCount(3);
  await expect(page.locator(".date-separator")).toHaveText(["Date unavailable", "Feb 29, 2024", "Yesterday"]);
  await expect(page.locator("time")).toHaveCount(2);
  await expect(page.locator(".message").filter({ hasText: "Offset crosses local midnight" }).locator("time")).toHaveAccessibleDescription(/Friday, September 18, 2026.*5:30:00 PM/);
  await context.close();
});

test("no-match search offers a keyboard clear action that preserves focus through polling", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Find a session" });
  await search.fill("no such conversation");
  await expect(page.getByText("No sessions match your search.", { exact: true })).toBeVisible();
  const clear = page.getByRole("button", { name: "Clear search", exact: true });
  await clear.focus();
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/sessions");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await response;
  await expect(clear).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await expect(page.getByRole("button", { name: /Fix sign-in/ })).toBeVisible();
  expect(state.calls.filter((call) => call.body)).toHaveLength(0);
});

test("loading, no sessions and offline empty states retain authoritative Start availability", async ({ page }) => {
  const state = await fixture(page);
  state.sessions = [];
  const release = state.defer("/api/sessions");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Loading sessions…", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No sessions yet", exact: true })).toHaveCount(0);
  release();
  await expect(page.getByRole("heading", { name: "No sessions yet", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start a session", exact: true })).toBeEnabled();
  expect(state.calls.filter((call) => call.body)).toHaveLength(0);
  state.online = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("heading", { name: "Dev Mac is offline", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start a session", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "New session", exact: true })).toBeDisabled();
  state.online = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("heading", { name: "No sessions yet", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start a session", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(state.calls.filter((call) => call.path === "/api/launch/propose" || (call.path === "/api/sessions" && call.body))).toHaveLength(0);
});

test("managed and observed empty states recognize host sentinel history without hiding real output", async ({ page }) => {
  const state = await fixture(page, { history: [] });
  await openManaged(page);
  await expect(page.getByRole("heading", { name: "Ready when you are.", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Terminal research/ }).click();
  await expect(page.getByRole("heading", { name: "No readable history yet.", exact: true })).toBeVisible();
  for (const text of ["(no transcript available)", "(transcript unavailable)", "(no transcript on disk)", "(no message records found)"]) {
    state.history = [{ id: "observed-tail", role: "system", text }];
    await refreshTimeline(page);
    await expect(page.getByRole("heading", { name: "No readable history yet.", exact: true })).toBeVisible();
    await expect(page.locator(".message")).toHaveCount(0);
  }
  state.history[0].text = "assistant: (no transcript on disk) is the error we are investigating";
  await refreshTimeline(page);
  await expect(page.locator(".message-body")).toHaveText(state.history[0].text);
  state.online = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("#connection-banner")).toBeVisible();
  await expect(page.locator(".message-body")).toHaveText(state.history[0].text);
});

test("touch clear search is reachable at enlarged text without launching work", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true });
  const page = await context.newPage();
  const state = await fixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open session navigation" }).tap();
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  const search = page.getByRole("searchbox", { name: "Find a session" });
  await search.fill("missing project");
  const clear = page.getByRole("button", { name: "Clear search", exact: true });
  await expect(clear).toBeVisible();
  expect((await clear.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await clear.tap();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await expect(page.getByRole("button", { name: /Fix sign-in/ })).toBeVisible();
  await expectNoPageOverflow(page);
  expect(state.calls.filter((call) => call.body)).toHaveLength(0);
  await context.close();
});

test("PM provider failure is visible after polling and reload", async ({ page }) => {
  const state = await fixture(page);
  state.pmError = "Project manager failed: OAuth session expired and could not be refreshed. Retry after signing in.";
  await page.goto("/");
  await page.locator('#select-pm').click();
  await expect(page.locator("#error-banner")).toBeVisible();
  await expect(page.locator("#error-text")).toContainText("OAuth session expired");
  await page.reload();
  await expect(page.locator("#error-banner")).toBeVisible();
  await expect(page.locator("#error-text")).toContainText("OAuth session expired");
});

test("PM error clears after recovery and dismissal survives unchanged polling", async ({page})=>{
  const state=await fixture(page);state.pmError='Project manager failed: temporary outage';
  await page.goto('/');await page.locator('#select-pm').click();
  await expect(page.locator('#error-banner')).toBeVisible();
  state.pmError=null;
  await expect(page.locator('#error-banner')).toBeHidden();
  state.pmError='Project manager failed: another outage';
  await expect(page.locator('#error-banner')).toBeVisible();
  await page.locator('#dismiss-error').click();
  const before=state.calls.filter(c=>c.path==='/api/pm/history').length;
  await expect.poll(()=>state.calls.filter(c=>c.path==='/api/pm/history').length).toBeGreaterThan(before);
  await expect(page.locator('#error-banner')).toBeHidden();
});
