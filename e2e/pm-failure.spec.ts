import { test, expect, type Page } from "@playwright/test";
// The app opens on the PM; tests about the rail summary start on a session instead.
const SESSION_URL = "/?session=managed%3Aalpha";

// Self-contained route mock for the PM failure UI (#37). It records every API
// call so tests can prove which PM reads were actually made.
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

const DEV_MAC_ID = "6f1c2b8e-4a3d-4c5e-9f70-1a2b3c4d5e6f";
async function fixture(page: Page, options: { pmHistory?: any[]; auth?: any } = {}) {
  const state = {
    pmError: null as string | null,
    // Fails the lightweight summary read: an HTTP 500 or a network error.
    summaryFailure: null as null | 500 | "network",
    pmHistory: options.pmHistory ?? [
      { role: "assistant", text: "How can I help the fleet?" },
    ],
    calls: [] as { path: string; search: string; at: number }[],
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    state.calls.push({ path, search: url.search, at: Date.now() });
    if (path === "/api/pm/history" && url.search === "?summary=1" && state.summaryFailure) {
      if (state.summaryFailure === "network") await route.abort("failed");
      else await route.fulfill({ status: 500, json: { error: "Internal relay failure" } });
      return;
    }
    let result: any = {},
      status = 200;
    if (path === "/api/config") result = { auth: options.auth ?? { required: false } };
    else if (path === "/api/host") result = { online: true, host: "Dev Mac", machine_id: DEV_MAC_ID, standby_online: false };
    // Epic #26 contract D: the relay's answer for a single machine that runs the PM.
    else if (path === "/api/pm/host")
      result = {
        active: { machine_id: DEV_MAC_ID, name: "Dev Mac", online: true, epoch: 1, assigned_at: Date.parse("2026-09-01T00:00:00Z"), assigned_by: "bootstrap" },
        machines: [{ machine_id: DEV_MAC_ID, name: "Dev Mac", platform: "darwin", online: true, last_seen: Date.now(), active: true }],
        open_turns: 0,
        uncertain_turns: 0,
        mode: "relay",
      };
    else if (path === "/api/sessions") result = [structuredClone(managed)];
    else if (path === "/api/session")
      result = {
        session: managed,
        history: [{ id: "r", role: "assistant", text: "Working on it." }],
        receipts: [],
        approvals: [],
      };
    else if (path === "/api/models") result = { models: [] };
    else if (path === "/api/pm/history")
      result =
        url.searchParams.get("summary") === "1"
          ? { error: state.pmError, busy: false }
          : {
              history: state.pmHistory,
              error: state.pmError,
              busy: false,
              session_id: null,
              model: null,
            };
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

const summaryCalls = (state: Awaited<ReturnType<typeof fixture>>) =>
  state.calls.filter(
    (c) => c.path === "/api/pm/history" && c.search === "?summary=1",
  );
const fullPmCalls = (state: Awaited<ReturnType<typeof fixture>>) =>
  state.calls.filter((c) => c.path === "/api/pm/history" && c.search === "");

for (const colorScheme of ["light", "dark"] as const) {
  test(`persisted PM error entry is distinct and labelled (${colorScheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await fixture(page, {
      pmHistory: [
        { role: "system", text: "PM restarted after an update." },
        {
          role: "system",
          error: true,
          text: "Project manager failed: OAuth session expired.",
        },
      ],
    });
    await page.goto("/");
    await page.locator("#select-pm").click();

    const failure = page.locator(".message.system.error");
    await expect(failure).toHaveCount(1);
    await expect(failure).toContainText("OAuth session expired.");
    await expect(failure.locator(".message-label")).toHaveText(
      /^Project manager error/,
    );
    await expect(
      page.getByRole("article", { name: "Project manager error" }),
    ).toHaveCount(1);

    const plain = page.locator(".message.system", {
      hasText: "PM restarted after an update.",
    });
    await expect(plain).toHaveCount(1);
    await expect(plain).not.toHaveClass(/\berror\b/);
    await expect(plain.locator(".message-label")).toHaveText(/^Session/);
    expect(await plain.getAttribute("aria-label")).toBeNull();

    // The failure uses the theme's error tokens; the ordinary entry does not.
    const styles = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const probe = document.createElement("div");
      document.body.append(probe);
      probe.style.color = root.getPropertyValue("--error").trim();
      probe.style.backgroundColor = root.getPropertyValue("--error-soft").trim();
      const tokens = getComputedStyle(probe);
      const error = document.querySelector(".message.system.error")!;
      const plainEntry = [...document.querySelectorAll(".message.system")].find(
        (el) => !el.classList.contains("error"),
      )!;
      return {
        tokenError: tokens.color,
        tokenSoft: tokens.backgroundColor,
        errorBorder: getComputedStyle(error).borderLeftColor,
        errorBackground: getComputedStyle(error).backgroundColor,
        plainBorder: getComputedStyle(plainEntry).borderLeftColor,
        plainBackground: getComputedStyle(plainEntry).backgroundColor,
      };
    });
    expect(styles.errorBorder).toBe(styles.tokenError);
    expect(styles.errorBackground).toBe(styles.tokenSoft);
    expect(styles.plainBorder).not.toBe(styles.tokenError);
    expect(styles.plainBackground).not.toBe(styles.tokenSoft);
  });
}

test("HTML-like provider text in an error entry renders as text", async ({
  page,
}) => {
  const payload =
    '<img src=x onerror="window.__pwned=1"><b id="injected">bold</b>';
  await fixture(page, {
    pmHistory: [{ role: "system", error: true, text: payload }],
  });
  await page.goto("/");
  await page.locator("#select-pm").click();
  const failure = page.locator(".message.system.error");
  await expect(failure.locator(".message-body")).toHaveText(payload);
  await expect(failure.locator("img, b")).toHaveCount(0);
  await expect(page.locator("#injected")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
});

test("rail flags a PM failure from the summary read and clears it", async ({
  page,
}) => {
  const state = await fixture(page);
  const pmRow = page.locator("#select-pm");
  const indicator = pmRow.locator(".pm-alert");
  await page.goto(SESSION_URL);

  // A session is open (the PM is not selected): the summary is polled, and without an error
  // there is no flag.
  await expect.poll(() => summaryCalls(state).length).toBeGreaterThan(0);
  await expect(indicator).toHaveCount(0);
  await expect(pmRow).not.toHaveClass(/has-error/);
  await expect(page.getByRole("button", { name: "Project manager, has an error" })).toHaveCount(0);

  // Error appears on a later poll.
  state.pmError = "Project manager failed: provider outage";
  await expect(indicator).toHaveCount(1);
  await expect(indicator).toHaveText(/Project manager has an error/);
  await expect(
    page.getByRole("button", { name: "Project manager, has an error" }),
  ).toBeVisible();
  await expect(pmRow).toHaveAttribute("title", /provider outage/);
  // The #28 banner is for the selected PM only; it is not raised from the rail read.
  await expect(page.locator("#error-banner")).toBeHidden();

  // With another conversation selected the flag persists and keeps polling.
  await page.getByRole("button", { name: /Fix sign-in/ }).click();
  await expect(page.getByRole("heading", { name: "Fix sign-in", exact: true })).toBeVisible();
  const before = summaryCalls(state).length;
  await expect.poll(() => summaryCalls(state).length).toBeGreaterThan(before);
  await expect(indicator).toHaveCount(1);

  // The error clears: the flag and its accessible name go away.
  state.pmError = null;
  await expect(indicator).toHaveCount(0);
  await expect(pmRow).not.toHaveClass(/has-error/);
  expect(await pmRow.getAttribute("aria-label")).toBeNull();
  expect(await pmRow.getAttribute("title")).toBeNull();
  await expect(page.getByRole("button", { name: /Project manager/ })).toBeVisible();
});

test("summary is not requested while the PM is selected", async ({ page }) => {
  const state = await fixture(page);
  state.pmError = "Project manager failed: provider outage";
  await page.goto("/");
  await expect(page.locator("#select-pm .pm-alert")).toHaveCount(1);

  await page.locator("#select-pm").click();
  await expect(page.getByText("How can I help the fleet?")).toBeVisible();
  // The #28 banner still shows for the selected PM.
  await expect(page.locator("#error-text")).toHaveText(/provider outage/);
  // The full history keeps the indicator in sync without a summary read.
  const selectedAt = Date.now();
  const fullBefore = fullPmCalls(state).length;
  await expect.poll(() => fullPmCalls(state).length, { timeout: 10000 }).toBeGreaterThan(fullBefore + 1);
  expect(summaryCalls(state).filter((c) => c.at > selectedAt)).toHaveLength(0);
  await expect(page.locator("#select-pm .pm-alert")).toHaveCount(1);

  // Full history reports recovery: the flag clears with no summary read.
  state.pmError = null;
  await expect(page.locator("#select-pm .pm-alert")).toHaveCount(0);
  expect(summaryCalls(state).filter((c) => c.at > selectedAt)).toHaveLength(0);
});

// #65: every poll makes exactly one summary read. The calls between two consecutive
// /api/host requests are one complete poll.
test("each poll requests the PM summary exactly once", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(SESSION_URL);
  const hosts = () => state.calls.filter((c) => c.path === "/api/host").length;
  // Start extra polls instead of waiting for the timer; a poll already in flight ignores them.
  for (let polls = 1; polls <= 4; polls++) {
    await expect.poll(() => summaryCalls(state).length).toBeGreaterThanOrEqual(polls);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(hosts).toBeGreaterThan(polls);
  }
  const windows: string[][] = [];
  for (const call of state.calls) {
    if (call.path === "/api/host") windows.push([]);
    else if (windows.length) windows.at(-1)!.push(call.path + call.search);
  }
  const complete = windows.slice(0, -1);
  expect(complete.length).toBeGreaterThanOrEqual(4);
  for (const poll of complete)
    expect(poll.filter((call) => call === "/api/pm/history?summary=1")).toHaveLength(1);
  // The full PM history is never read while the PM is not selected.
  expect(fullPmCalls(state)).toHaveLength(0);
});

for (const failure of [500, "network"] as const) {
  test(`a failed PM summary read (${failure}) leaves the UI usable and the indicator unset`, async ({ page }) => {
    const state = await fixture(page);
    state.summaryFailure = failure;
    await page.goto(SESSION_URL);
    // The failing read was really made, and more than once: polling continues after it.
    await expect.poll(() => summaryCalls(state).length).toBeGreaterThanOrEqual(1);
    const failedAt = summaryCalls(state).length;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => summaryCalls(state).length).toBeGreaterThan(failedAt);
    await expect(page.locator("#select-pm .pm-alert")).toHaveCount(0);
    await expect(page.locator("#select-pm")).not.toHaveClass(/has-error/);
    await expect(page.locator("#error-banner")).toBeHidden();
    await expect(page.locator("#host-status")).toHaveText("Dev Mac · online");
    await expect(page.locator("#connection-banner")).toBeHidden();

    // Still usable: a conversation and the PM open normally.
    await page.getByRole("button", { name: /Fix sign-in/ }).click();
    await expect(page.getByText("Working on it.")).toBeVisible();
    await page.locator("#select-pm").click();
    await expect(page.getByText("How can I help the fleet?")).toBeVisible();

    // Once reads succeed again, a real error is still flagged (the mechanism was not disabled).
    await page.getByRole("button", { name: /Fix sign-in/ }).click();
    state.summaryFailure = null;
    state.pmError = "Project manager failed: provider outage";
    await expect(page.locator("#select-pm .pm-alert")).toHaveCount(1);
  });
}

test("a known indicator survives a failed summary read", async ({ page }) => {
  const state = await fixture(page);
  state.pmError = "Project manager failed: provider outage";
  await page.goto(SESSION_URL);
  await expect(page.locator("#select-pm .pm-alert")).toHaveCount(1);
  state.summaryFailure = 500;
  const before = summaryCalls(state).length;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => summaryCalls(state).length).toBeGreaterThan(before);
  await expect(page.locator("#select-pm .pm-alert")).toHaveCount(1);
  await expect(page.locator("#error-banner")).toBeHidden();
});

test("the rail indicator appears even when the PM row has no PINNED tag", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(SESSION_URL);
  await expect.poll(() => summaryCalls(state).length).toBeGreaterThan(0);
  await page.locator("#select-pm .pinned").evaluate((el) => el.remove());
  state.pmError = "Project manager failed: provider outage";
  const indicator = page.locator("#select-pm .pm-alert");
  await expect(indicator).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Project manager, has an error" })).toBeVisible();
  state.pmError = null;
  await expect(indicator).toHaveCount(0);
});

test("a PM error entry that gains its error flag re-renders as a failure", async ({ page }) => {
  const at = "2026-09-20T10:00:00.000Z";
  const state = await fixture(page, { pmHistory: [{ role: "system", text: "Project manager stopped.", at }] });
  await page.goto("/");
  await page.locator("#select-pm").click();
  const entry = page.locator(".message.system", { hasText: "Project manager stopped." });
  await expect(entry).toHaveCount(1);
  await expect(entry).not.toHaveClass(/\berror\b/);
  // Same role, text and timestamp: only the error flag changes.
  state.pmHistory = [{ role: "system", error: true, text: "Project manager stopped.", at }];
  await expect(entry).toHaveClass(/\berror\b/);
  await expect(entry.locator(".message-label")).toHaveText(/^Project manager error/);
});

test("signing out clears the PM failure indicator", async ({ page }) => {
  await page.route("https://www.gstatic.com/firebasejs/**/firebase-app.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "export const initializeApp = value => value;" }));
  await page.route("https://www.gstatic.com/firebasejs/**/firebase-auth.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
    const user = {email:'owner@example.com',getIdToken:async()=> 'fixture-id-token'};
    let callback;
    export const getAuth = () => ({currentUser:user});
    export const onAuthStateChanged = (auth,fn) => { callback=fn; queueMicrotask(()=>fn(user)); };
    export const signOut = async auth => { auth.currentUser=null; callback(null); };
  `,
    }));
  const state = await fixture(page, { auth: { required: true, firebase: { apiKey: "fixture-api-key" } } });
  state.pmError = "Project manager failed: provider outage";
  await page.goto("/");
  const pmRow = page.locator("#select-pm");
  await expect(pmRow.locator(".pm-alert")).toHaveCount(1);
  await page.locator("#sign-out").click();
  await expect(page.locator("#app")).toBeHidden();
  // Cleared by sign-out itself, while the host still reports the error.
  await expect(pmRow.locator(".pm-alert")).toHaveCount(0);
  await expect(pmRow).not.toHaveClass(/has-error/);
  expect(await pmRow.getAttribute("aria-label")).toBeNull();
  expect(await pmRow.getAttribute("title")).toBeNull();
});
