import { test, expect, type Page } from "@playwright/test";

const managed = {
  session_key: "managed:alpha",
  session_id: "native-alpha",
  provider: "claude",
  name: "Fix sign-in",
  cwd: "/Users/dev/code/app",
  state: "working",
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
async function fixture(
  page: Page,
  options: {
    online?: boolean;
    approvals?: any[];
    history?: any[];
    auth?: any;
  } = {},
) {
  const state = {
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
    pmModel: null as string | null,
    pmBusy: false,
    failMessages: 0,
    failCreates: 0,
    deny: false,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const body = request.method() === "POST" ? request.postDataJSON() : null;
    state.calls.push({ path, body, headers: request.headers() });
    let result: any = {},
      status = 200;
    if (path === "/api/config")
      result = { auth: options.auth ?? { required: false } };
    else if (state.deny) {
      status = 403;
      result = { error: "Not authorized" };
    } else if (path === "/api/host")
      result = { online: state.online, host: "Dev Mac" };
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
        history: [{ role: "assistant", text: "How can I help the fleet?" }],
        busy: state.pmBusy,
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
  await expect(page.getByRole("alert")).toContainText("Retry the same message");
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
    page.getByText("Execution host offline", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Message this session")).toBeDisabled();
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

test('launch policy defaults to Workspace, Full requires confirmation, and running sessions show it', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await expect(page.getByLabel('Permission policy')).toHaveValue('workspace');
  await page.getByLabel('Session name').fill('Full worker');
  await page.getByLabel('Project directory').fill('/Users/dev/code/worker');
  await page.getByLabel('First task').fill('Work on the project');
  await page.getByLabel('Permission policy').selectOption('full');
  await expect(page.locator('#new-policy-hint')).toContainText('outside the project without permission prompts');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  expect(state.calls.filter((c) => c.path === '/api/sessions' && c.body)).toHaveLength(0);
  await page.locator('#confirm-full').check();
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Full worker', exact: true })).toBeVisible();
  expect(state.calls.find((c) => c.path === '/api/sessions' && c.body)?.body.permission_mode).toBe('full');
  await expect(page.locator('#conversation-subtitle')).toContainText('⚠ Full');
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await expect(page.getByLabel('Permission policy')).toHaveValue('workspace');
  await page.getByLabel('Permission policy').selectOption('full');
  await expect(page.locator('#confirm-full')).not.toBeChecked();
});
