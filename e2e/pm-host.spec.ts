import { test, expect, type Page } from "@playwright/test";

// PMM-06 (#84, epic #26): the PM view shows which machine runs the PM and moves it.
// Self-contained route mock following contract D in shared/pm-state.ts:
//   GET  /api/pm/host  → PmHostResponse
//   POST /api/pm/host  { machine_id, expected_epoch } → 200 PmHostMoveResponse | 4xx { error }
//   GET  /api/host     → { online, host, machine_id, standby_online } for the active PM host
const A = "0b7c1f7e-1111-4a4a-8a8a-000000000001";
const B = "0b7c1f7e-2222-4b4b-9b9b-000000000002";
const C = "0b7c1f7e-3333-4c4c-ac4c-000000000003";
const HOUR = 3_600_000;

type Machine = { machine_id: string; name: string; platform: string; online: boolean; last_seen: number };
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

async function fixture(page: Page, options: { machines?: Machine[]; active?: string | null; epoch?: number; mode?: "relay" | "local" } = {}) {
  const now = Date.now();
  const state = {
    mode: options.mode ?? ("relay" as "relay" | "local"),
    machines: options.machines ?? [{ machine_id: A, name: "machine-a", platform: "darwin", online: true, last_seen: now }],
    active: options.active === undefined ? A : options.active,
    epoch: options.epoch ?? 1,
    pmHistory: [{ id: "hello", role: "assistant", text: "How can I help the fleet?" }] as any[],
    pmError: null as string | null,
    pmHostStatus: 200,
    // A one-shot answer for the next POST /api/pm/host, and a change the server makes first.
    moveReply: null as null | { status: number; error: string; before?: () => void },
    calls: [] as { method: string; path: string; search: string; body: any }[],
    machine(id: string) {
      return state.machines.find((m) => m.machine_id === id)!;
    },
    activeRow() {
      const m = state.active ? state.machine(state.active) : null;
      return m ? { machine_id: m.machine_id, name: m.name, online: m.online, epoch: state.epoch, assigned_at: now - HOUR, assigned_by: "developer" } : null;
    },
    pmHost() {
      return {
        active: state.activeRow(),
        machines: state.machines.map((m) => ({ ...m, active: m.machine_id === state.active })),
        open_turns: 0,
        uncertain_turns: 0,
        mode: state.mode,
      };
    },
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      method = request.method();
    const body = method === "POST" ? request.postDataJSON() : null;
    state.calls.push({ method, path, search: url.search, body });
    const active = state.active ? state.machine(state.active) : null;
    let result: any = {},
      status = 200;
    if (path === "/api/config") result = { auth: { required: false } };
    else if (path === "/api/host")
      result = {
        online: !!active?.online,
        host: active?.name ?? null,
        machine_id: active?.machine_id ?? null,
        standby_online: state.machines.some((m) => m.online && m.machine_id !== state.active),
      };
    else if (path === "/api/pm/host" && method === "GET") {
      status = state.pmHostStatus;
      result = status === 200 ? state.pmHost() : { error: "Not found" };
    } else if (path === "/api/pm/host" && method === "POST") {
      const reply = state.moveReply;
      state.moveReply = null;
      reply?.before?.();
      if (reply) {
        status = reply.status;
        result = { error: reply.error };
      } else {
        state.active = body.machine_id;
        state.epoch += 1;
        // A fresh conversation on the new machine (developer decision 4).
        state.pmHistory = [];
        result = { active: state.activeRow(), epoch: state.epoch };
      }
    } else if (!active?.online) {
      // Relayed routes while the PM's machine is offline (contract D).
      status = 503;
      result = { error: `Your PM's machine (${active?.name}) is offline.` };
    } else if (path === "/api/sessions") result = [structuredClone(managed)];
    else if (path === "/api/session")
      result = { session: managed, history: [{ id: "r", role: "assistant", text: "Working on it." }], receipts: [], approvals: [] };
    else if (path === "/api/models") result = { models: [{ value: "haiku", displayName: "Haiku" }] };
    else if (path === "/api/pm/history")
      result = url.searchParams.get("summary") === "1"
        ? { error: state.pmError, busy: false }
        : { history: state.pmHistory, error: state.pmError, busy: false, session_id: null, model: null };
    else {
      status = 404;
      result = { error: "Unknown mock route" };
    }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(result) });
  });
  return state;
}
type State = Awaited<ReturnType<typeof fixture>>;
const pmHostGets = (state: State) => state.calls.filter((c) => c.path === "/api/pm/host" && c.method === "GET");
const movePosts = (state: State) => state.calls.filter((c) => c.path === "/api/pm/host" && c.method === "POST");
// Start another poll now instead of waiting for the 3 s timer.
const pollNow = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("online")));

async function openPm(page: Page) {
  await page.goto("/?view=pm");
  await expect(page.getByRole("heading", { name: "Claude · Project manager", exact: true })).toBeVisible();
}
const label = (page: Page) => page.locator("#pm-host-label");
const moveButton = (page: Page) => page.getByRole("button", { name: "Move PM…", exact: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Move PM" });
const machineRadio = (page: Page, name: string) => dialog(page).getByRole("radio", { name: new RegExp(`^${name}`) });

test("the PM view names the PM's machine, online and offline", async ({ page }) => {
  const state = await fixture(page);
  await openPm(page);
  await expect(label(page)).toHaveText("PM on machine-a · online");
  await expect(page.locator("#pm-host-dot")).toHaveClass(/\bonline\b/);
  await expect(page.locator("#pm-host-offline")).toBeHidden();
  await expect(moveButton(page)).toBeHidden();
  // Model details name the machine too.
  await page.getByText("Model details", { exact: true }).click();
  await expect(page.locator("#conversation-subtitle")).toContainText("Runs on");
  await expect(page.locator("#conversation-subtitle")).toContainText("machine-a · online");

  // The machine goes offline: the relay still answers /api/pm/host.
  state.machine(A).online = false;
  await pollNow(page);
  await expect(label(page)).toHaveText("PM on machine-a · offline");
  await expect(page.locator("#pm-host-dot")).toHaveClass(/\boffline\b/);
  await expect(page.locator("#pm-host-offline")).toHaveText("Your PM's machine (machine-a) is offline.");
  await expect(page.locator("#pm-host")).toHaveClass(/is-offline/);
  await expect(page.locator("#conversation-subtitle")).toContainText("machine-a · offline");
  // No other machine is online, so there is nowhere to move it.
  await expect(moveButton(page)).toBeHidden();

  // Back online.
  state.machine(A).online = true;
  await pollNow(page);
  await expect(label(page)).toHaveText("PM on machine-a · online");
  await expect(page.locator("#pm-host-offline")).toBeHidden();

  // The machine line belongs to the PM view only.
  await page.getByRole("button", { name: /Fix sign-in/ }).click();
  await expect(page.getByRole("heading", { name: "Fix sign-in", exact: true })).toBeVisible();
  await expect(page.locator("#pm-host")).toBeHidden();
});

test("Move PM is offered only while another machine is online", async ({ page }) => {
  const state = await fixture(page, {
    machines: [
      { machine_id: A, name: "machine-a", platform: "darwin", online: true, last_seen: Date.now() },
      { machine_id: B, name: "machine-b", platform: "linux", online: false, last_seen: Date.now() - HOUR },
    ],
  });
  await openPm(page);
  await expect(label(page)).toHaveText("PM on machine-a · online");
  await expect(moveButton(page)).toBeHidden();

  // A standby comes online: Move is offered while the PM's machine is online too.
  state.machine(B).online = true;
  await pollNow(page);
  await expect(moveButton(page)).toBeVisible();

  // The PM's machine goes offline with the standby online: the offline copy plus Move.
  state.machine(A).online = false;
  await pollNow(page);
  await expect(page.locator("#pm-host-offline")).toHaveText("Your PM's machine (machine-a) is offline.");
  await expect(moveButton(page)).toBeVisible();

  // The standby goes offline too: nothing to move to.
  state.machine(B).online = false;
  await pollNow(page);
  await expect(label(page)).toHaveText("PM on machine-a · offline");
  await expect(moveButton(page)).toBeHidden();
});

test("the dialog lists machines, allows only online standbys, and moves the PM", async ({ page }) => {
  const state = await fixture(page, {
    epoch: 3,
    machines: [
      { machine_id: A, name: "machine-a", platform: "darwin", online: false, last_seen: Date.now() - 5 * 60_000 },
      { machine_id: B, name: "machine-b", platform: "linux", online: true, last_seen: Date.now() },
      { machine_id: C, name: "machine-c", platform: "win32", online: false, last_seen: Date.now() - 2 * HOUR - 60_000 },
    ],
  });
  await openPm(page);
  await expect(page.locator("#pm-host-offline")).toHaveText("Your PM's machine (machine-a) is offline.");
  await moveButton(page).click();
  const modal = dialog(page);
  await expect(modal).toBeVisible();
  await expect(modal).toContainText(
    "The PM starts a fresh conversation on the new machine with the same memory. A message still in progress will be reported as uncertain and not replayed.",
  );
  const rows = modal.locator(".machine-choice");
  await expect(rows).toHaveCount(3);
  // Name, platform, online state and last seen for every machine.
  await expect(rows.filter({ hasText: "machine-a" })).toContainText("macOS · Offline · Last seen 5 min ago");
  await expect(rows.filter({ hasText: "machine-a" })).toContainText("Runs the PM now");
  await expect(rows.filter({ hasText: "machine-b" })).toContainText("Linux · Online · Last seen just now");
  await expect(rows.filter({ hasText: "machine-c" })).toContainText("Windows · Offline · Last seen 2 h ago");
  // Only the online, non-active machine can be chosen.
  await expect(machineRadio(page, "machine-a")).toBeDisabled();
  await expect(machineRadio(page, "machine-c")).toBeDisabled();
  await expect(machineRadio(page, "machine-b")).toBeEnabled();
  const confirm = modal.getByRole("button", { name: "Move PM", exact: true });
  await expect(confirm).toBeDisabled();
  // Keyboard: focus starts on the first choice; Space selects it.
  await expect(machineRadio(page, "machine-b")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(machineRadio(page, "machine-b")).toBeChecked();
  await expect(confirm).toBeEnabled();
  expect(movePosts(state)).toHaveLength(0);
  await confirm.click();

  await expect(modal).toBeHidden();
  expect(movePosts(state)).toHaveLength(1);
  expect(movePosts(state)[0].body).toEqual({ machine_id: B, expected_epoch: 3 });
  await expect(label(page)).toHaveText("PM on machine-b · online");
  await expect(page.locator("#pm-host-offline")).toBeHidden();
  await expect(page.locator("#app-notice")).toContainText("The PM now runs on machine-b");
  // The new machine's conversation is empty, which is not an error.
  await expect(page.getByRole("heading", { name: "New conversation.", exact: true })).toBeVisible();
  await expect(page.locator("#error-banner")).toBeHidden();
  // No other machine is online now, so Move is gone and focus lands in the conversation.
  await expect(moveButton(page)).toBeHidden();
  await expect(page.locator("#timeline")).toBeFocused();
});

test("a 409 shows the server's reason and refreshes the list", async ({ page }) => {
  const state = await fixture(page, {
    epoch: 7,
    machines: [
      { machine_id: A, name: "machine-a", platform: "darwin", online: true, last_seen: Date.now() },
      { machine_id: B, name: "machine-b", platform: "linux", online: true, last_seen: Date.now() },
      { machine_id: C, name: "machine-c", platform: "linux", online: true, last_seen: Date.now() },
    ],
  });
  await openPm(page);
  await moveButton(page).click();
  await machineRadio(page, "machine-b").check();
  // Meanwhile the PM was moved to machine-b from another device, and machine-c went offline.
  state.moveReply = {
    status: 409,
    error: "The PM moved since you opened this list.",
    before: () => {
      state.active = B;
      state.epoch = 8;
      state.machine(C).online = false;
    },
  };
  const getsBefore = pmHostGets(state).length;
  await dialog(page).getByRole("button", { name: "Move PM", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toHaveText("The PM moved since you opened this list.");
  expect(movePosts(state)[0].body).toEqual({ machine_id: B, expected_epoch: 7 });
  // The list was re-read and now reflects the server.
  expect(pmHostGets(state).length).toBeGreaterThan(getsBefore);
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator(".machine-choice").filter({ hasText: "machine-b" })).toContainText("Runs the PM now");
  await expect(machineRadio(page, "machine-b")).toBeDisabled();
  await expect(machineRadio(page, "machine-c")).toBeDisabled();
  await expect(machineRadio(page, "machine-a")).toBeEnabled();
  await expect(machineRadio(page, "machine-a")).not.toBeChecked();
  await expect(dialog(page).getByRole("button", { name: "Move PM", exact: true })).toBeDisabled();
  // Focus stays in the dialog.
  expect(await page.evaluate(() => document.getElementById("move-pm-dialog")!.contains(document.activeElement))).toBe(true);

  // Retrying with the refreshed list uses the new epoch.
  await machineRadio(page, "machine-a").check();
  await dialog(page).getByRole("button", { name: "Move PM", exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  expect(movePosts(state)[1].body).toEqual({ machine_id: A, expected_epoch: 8 });
  await expect(label(page)).toHaveText("PM on machine-a · online");
});

for (const [status, error] of [
  [400, "machine-b already runs the PM."],
  [404, "Unknown machine."],
  [400, "Reassignment needs the cloud relay"],
] as const) {
  test(`a ${status} answer shows the server's error (${error})`, async ({ page }) => {
    const state = await fixture(page, {
      machines: [
        { machine_id: A, name: "machine-a", platform: "darwin", online: true, last_seen: Date.now() },
        { machine_id: B, name: "machine-b", platform: "linux", online: true, last_seen: Date.now() },
      ],
    });
    await openPm(page);
    await moveButton(page).click();
    await machineRadio(page, "machine-b").check();
    state.moveReply = { status, error };
    await dialog(page).getByRole("button", { name: "Move PM", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toHaveText(error);
    await expect(dialog(page)).toBeVisible();
    await expect(label(page)).toHaveText("PM on machine-a · online");
    // The rest of the app is untouched: no banner, still signed in.
    await expect(page.locator("#error-banner")).toBeHidden();
    await expect(page.locator("#app")).toBeVisible();
  });
}

test("the dialog traps focus, works from the keyboard, and returns focus", async ({ page }) => {
  await fixture(page, {
    machines: [
      { machine_id: A, name: "machine-a", platform: "darwin", online: true, last_seen: Date.now() },
      { machine_id: B, name: "machine-b", platform: "linux", online: true, last_seen: Date.now() },
      { machine_id: C, name: "machine-c", platform: "linux", online: true, last_seen: Date.now() },
    ],
  });
  await openPm(page);
  const inDialog = () => page.evaluate(() => document.getElementById("move-pm-dialog")!.contains(document.activeElement));
  await moveButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await expect(machineRadio(page, "machine-b")).toBeFocused();
  // Arrow keys move between the selectable machines.
  await page.keyboard.press("ArrowDown");
  await expect(machineRadio(page, "machine-c")).toBeFocused();
  await expect(machineRadio(page, "machine-c")).toBeChecked();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    expect(await inDialog()).toBe(true);
  }
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await inDialog()).toBe(true);
  }
  // Escape closes and returns focus to Move PM.
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expect(moveButton(page)).toBeFocused();

  // Cancel and the close button return focus the same way.
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(moveButton(page)).toBeFocused();
  await moveButton(page).click();
  await dialog(page).getByRole("button", { name: "Close move PM", exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(moveButton(page)).toBeFocused();
});

test("Move PM and the dialog fit a phone with 44px touch targets", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true });
  const page = await context.newPage();
  await fixture(page, {
    machines: [
      { machine_id: A, name: "machine-a", platform: "darwin", online: false, last_seen: Date.now() - HOUR },
      { machine_id: B, name: "a-machine-with-a-rather-long-name-for-a-phone-screen", platform: "linux", online: true, last_seen: Date.now() },
    ],
  });
  await openPm(page);
  await expect(page.locator("#pm-host-offline")).toBeVisible();
  const move = moveButton(page);
  expect((await move.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await move.tap();
  await expect(dialog(page)).toBeVisible();
  for (const target of await dialog(page).locator(".machine-choice, button").all()) {
    const box = (await target.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
  // Tapping the whole row selects the machine.
  await dialog(page).locator(".machine-choice").filter({ hasText: "rather-long-name" }).tap();
  await expect(machineRadio(page, "a-machine-with")).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await context.close();
});

test("Back closes the Move PM dialog before leaving the PM", async ({ page }) => {
  await fixture(page, {
    machines: [
      { machine_id: A, name: "machine-a", platform: "darwin", online: true, last_seen: Date.now() },
      { machine_id: B, name: "machine-b", platform: "linux", online: true, last_seen: Date.now() },
    ],
  });
  await page.goto("/");
  await page.locator("#select-pm").click();
  await moveButton(page).click();
  await expect(dialog(page)).toBeVisible();
  await page.goBack();
  await expect(dialog(page)).toBeHidden();
  await expect(page).toHaveURL(/\?view=pm$/);
  await expect(page.getByRole("heading", { name: "Claude · Project manager", exact: true })).toBeVisible();
});

test("an empty PM conversation uses neutral copy, not an error", async ({ page }) => {
  const state = await fixture(page);
  state.pmHistory = [];
  await openPm(page);
  const empty = page.locator(".empty-state");
  await expect(empty.getByRole("heading", { name: "New conversation.", exact: true })).toBeVisible();
  await expect(empty).toContainText("The PM remembers projects and decisions, not past chats.");
  await expect(empty.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".message.error")).toHaveCount(0);
  await expect(page.locator("#error-banner")).toBeHidden();
  await expect(page.locator("#select-pm .pm-alert")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message this session" })).toBeEnabled();
});

test("an uncertain turn is shown as a failure, with the rail indicator", async ({ page }) => {
  const state = await fixture(page);
  const text = "Your message sent at 10:02 to the PM on machine-b could not be confirmed (machine went offline). It was not replayed.";
  state.pmHistory = [{ role: "system", error: true, text, at: new Date().toISOString() }];
  state.pmError = text;
  await openPm(page);
  const failure = page.locator(".message.system.error");
  await expect(failure).toHaveCount(1);
  await expect(failure).toContainText("could not be confirmed");
  await expect(failure.locator(".message-label")).toHaveText(/^Project manager error/);
  await expect(page.getByRole("article", { name: "Project manager error" })).toHaveCount(1);
  await expect(page.locator("#select-pm .pm-alert")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Project manager, has an error" })).toBeVisible();
  // Leaving the PM keeps the indicator through the summary read (#37).
  await page.getByRole("button", { name: /Fix sign-in/ }).click();
  await expect(page.getByText("Working on it.")).toBeVisible();
  await pollNow(page);
  await expect(page.locator("#select-pm .pm-alert")).toHaveCount(1);
});

test("local-only mode shows the single machine and hides Move", async ({ page }) => {
  const state = await fixture(page, {
    mode: "local",
    machines: [
      { machine_id: A, name: "this-mac", platform: "darwin", online: true, last_seen: Date.now() },
      // Even a second online machine in the answer never offers Move without the relay.
      { machine_id: B, name: "other", platform: "linux", online: true, last_seen: Date.now() },
    ],
  });
  await openPm(page);
  await expect(label(page)).toHaveText("PM on this-mac · online");
  await expect.poll(() => pmHostGets(state).length).toBeGreaterThan(1);
  await expect(moveButton(page)).toBeHidden();
  await expect(page.locator("#move-pm")).toBeHidden();
  await page.getByText("Model details", { exact: true }).click();
  await expect(page.locator("#conversation-subtitle")).toContainText("this machine only (no cloud relay)");
  expect(movePosts(state)).toHaveLength(0);
});

test("a host or relay without /api/pm/host shows no machine line and no error", async ({ page }) => {
  const state = await fixture(page);
  state.pmHostStatus = 404;
  await openPm(page);
  await expect(page.getByText("How can I help the fleet?")).toBeVisible();
  await expect.poll(() => pmHostGets(state).length).toBeGreaterThan(0);
  await expect(page.locator("#pm-host")).toBeHidden();
  await expect(page.locator("#error-banner")).toBeHidden();
});

test("the model hint says the model is saved with the PM", async ({ page }) => {
  await fixture(page);
  await openPm(page);
  await expect(page.locator("#pm-model option[value=haiku]")).toHaveCount(1);
  await expect(page.locator("#pm-model-hint")).toHaveText("Changes apply to the next turn and are saved with the PM.");
});

// Every poll reads /api/pm/host at most once. The calls between two consecutive /api/host
// requests are one complete poll.
for (const scenario of ["the PM selected", "the inbox", "the PM's machine offline"] as const) {
  test(`each poll reads /api/pm/host at most once (${scenario})`, async ({ page }) => {
    const state = await fixture(page, {
      machines: [
        { machine_id: A, name: "machine-a", platform: "darwin", online: scenario !== "the PM's machine offline", last_seen: Date.now() },
        { machine_id: B, name: "machine-b", platform: "linux", online: true, last_seen: Date.now() },
      ],
    });
    if (scenario === "the inbox") await page.goto("/");
    else await openPm(page);
    await expect(page.locator("#host-status")).not.toHaveText("Connecting to execution host…");
    const hosts = () => state.calls.filter((c) => c.path === "/api/host").length;
    for (let polls = 1; polls <= 4; polls++) {
      await expect.poll(() => pmHostGets(state).length).toBeGreaterThanOrEqual(polls);
      await pollNow(page);
      await expect.poll(hosts).toBeGreaterThan(polls);
    }
    // Let the regular timer run at least one more poll as well.
    const before = hosts();
    await expect.poll(hosts, { timeout: 8000 }).toBeGreaterThan(before + 1);
    const windows: string[][] = [];
    for (const call of state.calls) {
      if (call.path === "/api/host") windows.push([]);
      else if (windows.length) windows.at(-1)!.push(`${call.method} ${call.path}${call.search}`);
    }
    const complete = windows.slice(0, -1);
    expect(complete.length).toBeGreaterThanOrEqual(5);
    for (const poll of complete) expect(poll.filter((call) => call === "GET /api/pm/host").length).toBeLessThanOrEqual(1);
    // It is read on every poll, including while the PM's machine is offline.
    for (const poll of complete) expect(poll).toContain("GET /api/pm/host");
    expect(movePosts(state)).toHaveLength(0);
  });
}
