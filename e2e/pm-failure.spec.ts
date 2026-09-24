import { test, expect, type Page } from "@playwright/test";

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

async function fixture(page: Page, options: { pmHistory?: any[] } = {}) {
  const state = {
    pmError: null as string | null,
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
    let result: any = {},
      status = 200;
    if (path === "/api/config") result = { auth: { required: false } };
    else if (path === "/api/host") result = { online: true, host: "Dev Mac" };
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
  await page.goto("/");

  // Nothing selected: the summary is polled, and without an error there is no flag.
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
