import { test, expect, devices, type Page } from "@playwright/test";

// #154: the phone app works like a minimal messaging app. Galaxy S24 emulation (360×780 CSS px
// at 3×, touch, mobile UA), checked at the acceptance sizes 360×740 and 360×420 (keyboard open).
//
// Baseline on main before #154 (267f644, this fixture, S24 emulation): the conversation got
// 284 of 780 px (36%) and 244 of 740 px (33%). With the keyboard open (360×420) it got 32 px
// (8%) and the latest message was scrolled out of view.
//
// Thresholds. The phone chrome is now a 56 px header plus a ~60 px composer, so the conversation
// can take ~84% of 740 px. The 70% bound leaves room for one warning banner (~40 px) or a
// slightly taller header at a larger system font, and is still more than twice the baseline.
// At 360×420 the same chrome leaves ~72%; the 50% bound (210 px, about eight lines of text)
// keeps the latest messages readable while typing and is six times the baseline.
const MIN_SHARE_740 = 0.7;
const MIN_SHARE_420 = 0.5;

const { defaultBrowserType: _browser, ...s24 } = devices["Galaxy S24"];
test.use({ ...s24 });

const now = Date.now();
const LAST = "LAST MESSAGE: the build is green.";
const pmHistory = [
  ...Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    text: i % 2 ? `Reply ${i}: I delegated the task to a session and will report back.` : `Message ${i}: please check the build`,
    ts: new Date(now - (9 - i) * 60_000).toISOString(),
  })),
  { role: "assistant", text: LAST, ts: new Date(now).toISOString() },
];
const A = "6f1c2b8e-4a3d-4c5e-9f70-1a2b3c4d5e6f", B = "0b8f7a4c-2d1e-4f3a-8b6c-5d4e3f2a1b0c";
const worker = {
  session_key: "managed:alpha", session_id: "alpha", provider: "claude", name: "Fix sign-in",
  cwd: "/Users/dev/code/app", project_name: "app", state: "working", current_tool: "Read", managed: true,
  permission_mode: "native", model: "sonnet", capabilities: { message: true, interrupt: true, approvals: true },
  updated_at: new Date(now - 5 * 60_000).toISOString(), last_message: "Reading the auth module",
};
const waiting = {
  ...worker, session_key: "managed:beta", session_id: "beta", name: "Write docs", state: "needs_input",
  reason: "Can I run the test suite?", updated_at: new Date(now - 60 * 60_000).toISOString(),
};
const idle = {
  ...worker, session_key: "managed:gamma", session_id: "gamma", name: "Tidy CSS", state: "turn_finished",
  last_message: "Done: tokens are consolidated.", updated_at: new Date(now - 2 * 60_000).toISOString(),
};

async function fixture(page: Page) {
  const state = { pmModel: null as string | null, pmBusy: false, machineAOnline: true, calls: [] as { path: string; body: any }[] };
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const body = request.method() === "POST" ? request.postDataJSON() : null;
    state.calls.push({ path, body });
    let result: any = {}, status = 200;
    if (path === "/api/config") result = { auth: { required: false } };
    else if (path === "/api/host") result = { online: true, host: "Dev Mac" };
    else if (path === "/api/sessions") result = [worker, waiting, idle];
    else if (path === "/api/session") {
      const session = [worker, waiting, idle].find((s) => s.session_key === url.searchParams.get("id"));
      result = { session, history: [{ id: "h1", role: "assistant", text: `History of ${session?.name}`, at: new Date(now).toISOString() }], receipts: [], approvals: [] };
    } else if (path === "/api/pm/history") result = { history: pmHistory, busy: state.pmBusy, error: null, model: state.pmModel };
    else if (path === "/api/pm/host" && request.method() === "GET") result = {
      active: { machine_id: A, name: "machine-a", online: state.machineAOnline, epoch: 1 },
      machines: [
        { machine_id: A, name: "machine-a", platform: "darwin", online: state.machineAOnline, last_seen: Date.now(), active: true },
        { machine_id: B, name: "machine-b", platform: "linux", online: true, last_seen: Date.now(), active: false },
      ],
      mode: "relay",
    };
    else if (path === "/api/models") result = { models: [{ value: "haiku", displayName: "Haiku" }, { value: "sonnet", displayName: "Sonnet" }] };
    else if (path === "/api/pm/model") { state.pmModel = body.model; result = { model: state.pmModel }; }
    else { status = 404; result = { error: "Unknown mock route" }; }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(result) });
  });
  return state;
}
const pollNow = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("online")));

async function openPm(page: Page) {
  await page.goto("/");
  await expect(page.getByText(LAST)).toBeVisible();
}
// What the conversation gets, and whether the last message is fully inside it and above the
// composer.
async function measure(page: Page) {
  return page.evaluate(() => {
    const timeline = document.querySelector("#timeline")!.getBoundingClientRect();
    const composer = document.querySelector("#composer")!.getBoundingClientRect();
    const header = document.querySelector(".conversation-head")!.getBoundingClientRect();
    const last = [...document.querySelectorAll(".message")].at(-1)!.getBoundingClientRect();
    const height = window.visualViewport?.height ?? window.innerHeight;
    return {
      height,
      share: timeline.height / height,
      header: header.height,
      lastVisible: last.top >= timeline.top - 1 && last.bottom <= timeline.bottom + 1 && last.bottom <= composer.top + 1,
      composerInView: composer.bottom <= height + 1,
    };
  });
}

test("at 360×740 the conversation takes most of the height, with the latest message in view", async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 360, height: 740 });
  await openPm(page);
  const m = await measure(page);
  expect(m.share).toBeGreaterThanOrEqual(MIN_SHARE_740);
  expect(m.header).toBeLessThanOrEqual(64);
  expect(m.lastVisible).toBe(true);
  expect(m.composerInView).toBe(true);
});

test("with the keyboard open (360×420, the layout viewport resizes) the last message stays above the composer", async ({ page }) => {
  await fixture(page);
  await openPm(page);
  await page.getByLabel("Message this session").tap();
  // interactive-widget=resizes-content: the keyboard shrinks the layout viewport.
  await page.setViewportSize({ width: 360, height: 420 });
  await expect.poll(async () => (await measure(page)).lastVisible).toBe(true);
  const m = await measure(page);
  expect(m.share).toBeGreaterThanOrEqual(MIN_SHARE_420);
  expect(m.composerInView).toBe(true);
  await expect(page.getByLabel("Message this session")).toBeFocused();
});

test("with the keyboard open (only the visual viewport resizes) the last message stays above the composer", async ({ page }) => {
  await fixture(page);
  await openPm(page);
  await page.getByLabel("Message this session").tap();
  // Browsers that resize only the visual viewport: the layout stays 780 px tall and the app
  // fits itself to visualViewport.height (420 px).
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, "height", { configurable: true, get: () => 420 });
    viewport.dispatchEvent(new Event("resize"));
  });
  await expect.poll(async () => (await measure(page)).lastVisible).toBe(true);
  const m = await measure(page);
  expect(m.height).toBe(420);
  expect(m.share).toBeGreaterThanOrEqual(MIN_SHARE_420);
  expect(m.composerInView).toBe(true);
});

test("the conversation view has no model or settings controls, no per-message chrome, and no keyboard hints", async ({ page }) => {
  const state = await fixture(page);
  await openPm(page);
  const main = page.locator("main");
  // No select boxes or configuration in the conversation (PM view).
  await expect(main.getByRole("combobox")).toHaveCount(0);
  for (const selector of ["#pm-model", "#pm-model-control", "#pm-host", "#pm-host-label", "#control-note", "#header-model", "#move-pm", "#provider"])
    await expect(page.locator(selector)).toBeHidden();
  for (const text of ["Model details", "Session details", "Project manager model", "Model ·", "PM on machine-a"])
    await expect(main.getByText(text)).toHaveCount(0);
  // No per-message Copy buttons, and no desktop keyboard hint on a touch screen.
  await expect(page.getByRole("button", { name: "Copy message" })).toHaveCount(0);
  await expect(page.getByText("Enter to send", { exact: false })).toBeHidden();
  // Interrupt shows only while a turn runs.
  await expect(page.locator("#interrupt")).toBeHidden();
  state.pmBusy = true;
  await pollNow(page);
  await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeVisible();
  // The header is the menu button, the name, one status line, Interrupt and one overflow menu.
  await expect(page.locator(".conversation-head button:visible")).toHaveCount(3);

  // A worker session: the same minimal view.
  await page.getByRole("button", { name: "Open session navigation" }).tap();
  await page.getByRole("button", { name: /Fix sign-in/ }).tap();
  await expect(page.getByText("History of Fix sign-in")).toBeVisible();
  await expect(main.getByRole("combobox")).toHaveCount(0);
  for (const selector of ["#control-note", "#header-model", "#provider", "#conversation-subtitle"])
    await expect(page.locator(selector)).toBeHidden();
  await expect(page.locator("#activity-status")).toHaveText(/Working/);
});

test("every control moved out of the conversation is reachable from the header's info screen", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const state = await fixture(page);
  await openPm(page);
  await page.getByRole("button", { name: "Conversation options" }).tap();
  await expect(page.getByRole("menu", { name: "Conversation options" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Project manager info and model" }).tap();
  const info = page.getByRole("dialog", { name: "Claude · Project manager" });
  await expect(info).toBeVisible();
  // The model picker, its help text and hint, the model details, the PM machine line, Move PM,
  // and the control note.
  const picker = info.getByRole("combobox", { name: "Project manager model · Claude" });
  await expect(picker).toBeEnabled();
  await expect(info.locator(".pm-model-help")).toBeVisible();
  await expect(info.locator("#pm-model-hint")).toHaveText("Changes apply to the next turn and are saved with the PM.");
  await expect(info.locator("#header-model")).toHaveText("Model · Provider default");
  await expect(info.locator("#conversation-subtitle")).toContainText("Runs on");
  await expect(info.locator("#pm-host-label")).toHaveText("PM on machine-a · online");
  await expect(info.getByRole("button", { name: "Move PM…" })).toBeVisible();
  await expect(info.locator("#control-note")).toContainText("delegates to session agents");
  // It fills the phone screen, like a contact-info screen, and the picker works.
  const box = (await info.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(359);
  await picker.selectOption("haiku");
  await expect.poll(() => state.pmModel).toBe("haiku");
  await expect(info.locator("#pm-model-hint")).toContainText("Saved");
  // Move PM opens from here.
  await info.getByRole("button", { name: "Move PM…" }).tap();
  await expect(page.getByRole("dialog", { name: "Move PM" })).toBeVisible();
  // Back closes Move PM, then the info screen, and stays in the conversation.
  await page.goBack();
  await expect(page.getByRole("dialog", { name: "Move PM" })).toBeHidden();
  await expect(info).toBeVisible();
  await page.goBack();
  await expect(info).toBeHidden();
  await expect(page.getByText(LAST)).toBeVisible();

  // Tapping the name opens the same screen; for a worker it shows the session's details.
  await page.getByRole("button", { name: "Open session navigation" }).tap();
  await page.getByRole("button", { name: /Fix sign-in/ }).tap();
  await page.getByRole("heading", { name: "Fix sign-in", exact: true }).tap();
  const sessionInfo = page.getByRole("dialog", { name: "Fix sign-in" });
  await expect(sessionInfo).toBeVisible();
  await expect(sessionInfo.locator("#provider")).toHaveText("Claude");
  await expect(sessionInfo.locator("#header-model")).toHaveText("Model · sonnet");
  await expect(sessionInfo.locator("#conversation-subtitle")).toContainText("/Users/dev/code/app");
  await expect(sessionInfo.locator("#conversation-subtitle")).toContainText("Native");
  await expect(sessionInfo.locator("#control-note")).toContainText("Follow-ups are queued");
  await expect(sessionInfo.getByRole("combobox")).toHaveCount(0);
  await sessionInfo.getByRole("button", { name: "Close info" }).tap();
  await expect(sessionInfo).toBeHidden();

  // Copy moved to the overflow menu (last message) and the message menu.
  await page.getByRole("button", { name: "Conversation options" }).tap();
  await page.getByRole("menuitem", { name: "Copy last message" }).tap();
  await expect(page.locator("#copy-status")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("History of Fix sign-in");
});

test("the PM machine's offline warning stays in the conversation as a banner", async ({ page }) => {
  const state = await fixture(page);
  state.machineAOnline = false;
  await openPm(page);
  await expect(page.locator("main").getByRole("status").filter({ hasText: "Your PM's machine (machine-a) is offline." })).toBeVisible();
  const m = await measure(page);
  expect(m.lastVisible).toBe(true);
});

test("long-press on a message opens its menu, and Copy message copies its text", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await fixture(page);
  await openPm(page);
  const message = page.locator(".message").filter({ hasText: LAST });
  const box = (await message.boundingBox())!;
  const cdp = await context.newCDPSession(page);
  const point = { x: box.x + 20, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(700);
  await expect(page.getByRole("menu", { name: "Message options" })).toBeVisible();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.getByRole("menuitem", { name: "Copy message" }).tap();
  await expect(page.getByRole("menu", { name: "Message options" })).toBeHidden();
  await expect(page.locator("#copy-status")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(LAST);
  // A plain tap (scrolling, reading) opens nothing.
  await message.tap();
  await page.waitForTimeout(600);
  await expect(page.getByRole("menu", { name: "Message options" })).toBeHidden();
});

test("the session list reads like a chat list: PM pinned, then name, time, preview and a needs-you badge", async ({ page }) => {
  await fixture(page);
  await openPm(page);
  await page.getByRole("button", { name: "Open session navigation" }).tap();
  const rail = page.locator("#rail");
  // The PM is pinned above every session.
  const pm = (await page.locator("#select-pm").boundingBox())!;
  const rows = rail.locator(".session-row");
  await expect(rows).toHaveCount(3);
  expect((await rows.first().boundingBox())!.y).toBeGreaterThan(pm.y);
  // Needs you first, then by most recent activity.
  await expect(rows.locator(".session-name")).toHaveText(["Write docs", "Tidy CSS", "Fix sign-in"]);
  const first = rows.first();
  await expect(first.locator(".session-sub")).toHaveText("Can I run the test suite?");
  await expect(first.locator(".session-age")).toHaveText("1h");
  await expect(first.locator(".attention-badge")).toHaveText("Needs you");
  await expect(rows.nth(1).locator(".session-sub")).toHaveText("Done: tokens are consolidated.");
  await expect(rows.nth(1).locator(".attention-badge")).toHaveCount(0);
  // No console-style metadata line in the list.
  await expect(rail.locator(".session-meta, .group-heading")).toHaveCount(0);
});
