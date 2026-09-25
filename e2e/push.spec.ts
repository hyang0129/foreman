import { test, expect, devices, type Page, type BrowserContext, type Worker } from "@playwright/test";

// Push opt-in and service-worker push handling (AND-05), on Chromium with Pixel 7 emulation.
// Full Chromium, as in pwa.spec.ts, so the service worker behaves as in Chrome.
//
// What is real and what is stubbed:
// - The push and notificationclick handlers are the shipped web/sw.js. Pushes are delivered
//   into it by CDP ServiceWorker.deliverPushMessage (a real PushEvent carrying the payload),
//   and notifications are read back from the real registration.getNotifications().
// - Headless Chromium has no push service, so PushManager.subscribe fails ("Registration
//   failed"). The page's PushManager is replaced by a recording stub (init script, tests only)
//   that returns subscription objects shaped like the real ones.
// - Notification.requestPermission is wrapped to record when it is called and then grant the
//   permission through context.grantPermissions (headless cannot show the prompt).
// - A notification click cannot be made in headless Chromium, so the test dispatches a
//   NotificationEvent into the worker; the shipped listener handles it. Only waitUntil is
//   replaced (untrusted events may not call it) so the test can await the handler's work.
// Notifications stay in Chromium's own (per-browser) notification store: with the OS
// notification center (macOS), every parallel test browser shares one app identity, so a
// notification closed in one test could remove a same-tag notification shown in another.
const { defaultBrowserType: _browser, ...pixel7 } = devices["Pixel 7"];
test.use({ ...pixel7, channel: "chromium", launchOptions: { args: ["--disable-features=NativeNotifications,SystemNotifications"] } });

const ORIGIN = "http://127.0.0.1:4188";
// 65-byte uncompressed P-256 points, base64url, as /api/config returns them.
const VAPID_KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const OLD_KEY = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
const ALL_KINDS = ["approval_requested", "question_asked", "session_failed", "pm_failed", "host_offline"];

const managed = {
  session_key: "managed:alpha",
  session_id: "native-alpha",
  provider: "claude",
  name: "Fix sign-in",
  cwd: "/Users/dev/code/app",
  state: "needs_input",
  managed: true,
  capabilities: { message: true, interrupt: true, approvals: true },
  updated_at: new Date().toISOString(),
};
const second = { ...managed, session_key: "managed:beta", session_id: "native-beta", name: "Write docs", state: "idle" };

type Call = { path: string; body: any; authorization: string | undefined };
type Options = { push?: any; auth?: any; unsubscribeFails?: boolean; testStatus?: number };

async function fixture(page: Page, options: Options = {}) {
  const state = { calls: [] as Call[], events: [] as string[] };
  const push = "push" in options ? options.push : { vapid_public_key: VAPID_KEY };
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    let body: any = null;
    try { body = request.postDataJSON(); } catch { body = request.postData(); }
    state.calls.push({ path, body, authorization: request.headers()["authorization"] });
    let result: any = {}, status = 200;
    if (path === "/api/config") result = { auth: options.auth ?? { required: true, firebase: { apiKey: "fixture-api-key" } }, push };
    else if (path === "/api/host") result = { online: true, host: "Dev Mac" };
    else if (path === "/api/sessions") result = [managed, second];
    else if (path === "/api/session") {
      const session = [managed, second].find((s) => s.session_key === url.searchParams.get("id"));
      if (!session) { status = 404; result = { error: "Unknown session" }; }
      else result = { session, history: [{ id: `h-${session.session_id}`, role: "assistant", text: `History of ${session.name}` }], receipts: [], approvals: [] };
    } else if (path === "/api/pm/history") result = { history: [{ role: "assistant", text: "How can I help the fleet?" }], error: null, busy: false, model: null };
    else if (path === "/api/models") result = { models: [] };
    else if (path === "/api/projects") result = { projects: [] };
    else if (path === "/api/push/subscribe") result = { ok: true, id: "sub-1" };
    else if (path === "/api/push/unsubscribe") {
      state.events.push("unsubscribe");
      if (options.unsubscribeFails) { await route.abort("failed"); return; }
      result = { ok: true, removed: true };
    } else if (path === "/api/push/test") {
      status = options.testStatus ?? 200;
      result = status === 200 ? { ok: true, sent: 1, failed: 0 } : { error: "Too many test notifications; try again later" };
    } else { status = 404; result = { error: "Unknown mock route" }; }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(result) });
  });
  // Firebase: a signed-in user, and a sign-out the test can order against the API calls.
  await page.exposeFunction("__recordEvent", (name: string) => { state.events.push(name); });
  await page.route("https://www.gstatic.com/firebasejs/**/firebase-app.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "export const initializeApp = value => value;" }));
  await page.route("https://www.gstatic.com/firebasejs/**/firebase-auth.js", (route) => route.fulfill({ contentType: "application/javascript", body: `
    const user = {email:'owner@example.com',getIdToken:async()=> 'fixture-id-token'};
    let callback;
    export const getAuth = () => ({currentUser:user});
    export const onAuthStateChanged = (auth,fn) => { callback=fn; queueMicrotask(()=>fn(auth.currentUser)); };
    export class GoogleAuthProvider { setCustomParameters() {} }
    export const signInWithPopup = async (auth) => { auth.currentUser = user; return { user }; };
    export const signOut = async auth => { await window.__recordEvent('signOut'); auth.currentUser=null; callback(null); };
  ` }));
  return state;
}
const pushCalls = (state: { calls: Call[] }, path: string) => state.calls.filter((c) => c.path === path);

// Test-only replacements for what headless Chromium cannot do (see the header). The
// subscription survives reloads through sessionStorage, as a real one survives in the browser.
async function stubPush(page: Page, context: BrowserContext, options: { existingKey?: string; permission?: "denied" } = {}) {
  await page.exposeFunction("__grantNotifications", () => context.grantPermissions(["notifications"], { origin: ORIGIN }));
  await page.addInitScript(({ existingKey, permission }) => {
    const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const fromB64 = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
    const log = { permissionRequests: [] as boolean[], subscribeCalls: [] as { key: string; userVisibleOnly: boolean }[], unsubscribed: [] as string[], current: null as any };
    (window as any).__push = log;
    const save = () => sessionStorage.setItem("e2e-push", JSON.stringify({ current: log.current && { endpoint: log.current.endpoint, key: toB64(new Uint8Array(log.current.options.applicationServerKey)) }, unsubscribed: log.unsubscribed }));
    const make = (endpoint: string, key: Uint8Array) => {
      const subscription = {
        endpoint,
        expirationTime: null,
        options: { applicationServerKey: key.slice().buffer, userVisibleOnly: true },
        toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "BPe2e-receiver-key", auth: "e2e-auth-secret" } }),
        unsubscribe: async () => {
          log.unsubscribed.push(endpoint);
          if (log.current === subscription) log.current = null;
          save();
          return true;
        },
      };
      return subscription;
    };
    const saved = JSON.parse(sessionStorage.getItem("e2e-push") || "null");
    if (saved) {
      log.unsubscribed = saved.unsubscribed;
      if (saved.current) log.current = make(saved.current.endpoint, fromB64(saved.current.key));
    } else if (existingKey) {
      log.current = make("https://fcm.googleapis.com/fcm/send/e2e-existing", fromB64(existingKey));
      save();
    }
    PushManager.prototype.subscribe = async function (options: PushSubscriptionOptionsInit) {
      const key = new Uint8Array(options.applicationServerKey as Uint8Array);
      log.subscribeCalls.push({ key: toB64(key), userVisibleOnly: !!options.userVisibleOnly });
      log.current = make(`https://fcm.googleapis.com/fcm/send/e2e-${log.subscribeCalls.length}`, key);
      save();
      return log.current;
    };
    PushManager.prototype.getSubscription = async function () { return log.current; };
    if (permission) Object.defineProperty(Notification, "permission", { get: () => permission });
    Notification.requestPermission = async () => {
      log.permissionRequests.push(navigator.userActivation.isActive);
      await (window as any).__grantNotifications();
      return Notification.permission;
    };
  }, options);
}
const pushLog = (page: Page) => page.evaluate(() => {
  const { permissionRequests, subscribeCalls, unsubscribed, current } = (window as any).__push;
  return { permissionRequests, subscribeCalls, unsubscribed, endpoint: current?.endpoint ?? null };
});

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Open session navigation" }).tap();
  const summary = page.locator("#notify-settings summary");
  await expect(summary).toBeVisible();
  if (!(await page.locator("#notify-settings").evaluate((d: HTMLDetailsElement) => d.open))) await summary.tap();
}
async function signedIn(page: Page) {
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.getByText("owner@example.com")).toBeAttached();
}
async function enable(page: Page, state: { calls: Call[] }) {
  await openSettings(page);
  await page.getByRole("button", { name: "Turn on notifications" }).tap();
  await expect(page.locator("#notify-summary")).toHaveText("On");
  await expect.poll(() => pushCalls(state, "/api/push/subscribe").length).toBe(1);
}

test.describe("notification settings", () => {
  test("hidden when the relay has no push", async ({ page }) => {
    await fixture(page, { push: null });
    await page.goto("/");
    await signedIn(page);
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await expect(page.locator("#notify-settings")).toBeHidden();
    await expect(page.locator("#notify-settings")).toHaveAttribute("data-state", "unsupported");
  });

  test("hidden in open (unauthenticated local) mode even with a key", async ({ page }) => {
    await fixture(page, { auth: { required: false } });
    await page.goto("/");
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your session inbox" })).toBeVisible();
    await expect(page.locator("#notify-settings")).toBeHidden();
  });

  test("hidden when the browser has no Push API", async ({ page }) => {
    await page.addInitScript(() => { delete (window as any).PushManager; });
    const state = await fixture(page);
    await page.goto("/");
    await signedIn(page);
    await expect.poll(() => state.calls.some((c) => c.path === "/api/host")).toBe(true);
    await expect(page.locator("#notify-settings")).toBeHidden();
  });

  test("enabling asks for permission only from the tap and subscribes with every kind on", async ({ page, context }) => {
    await stubPush(page, context);
    const state = await fixture(page);
    await page.goto("/");
    await signedIn(page);
    await openSettings(page);
    await expect(page.locator("#notify-summary")).toHaveText("Off");
    await expect(page.locator("#notify-kinds")).toBeHidden();
    // Nothing is asked or subscribed on load, even after the app has settled.
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await page.waitForTimeout(300);
    expect(await pushLog(page)).toEqual({ permissionRequests: [], subscribeCalls: [], unsubscribed: [], endpoint: null });
    expect(await page.evaluate(() => Notification.permission)).toBe("default");
    expect(state.calls.filter((c) => c.path.startsWith("/api/push/"))).toEqual([]);

    await page.getByRole("button", { name: "Turn on notifications" }).tap();
    await expect(page.locator("#notify-summary")).toHaveText("On");
    await expect(page.locator("#notify-feedback")).toHaveText("Notifications are on for this device.");
    const log = await pushLog(page);
    // Requested once, with the tap's user activation.
    expect(log.permissionRequests).toEqual([true]);
    expect(await page.evaluate(() => Notification.permission)).toBe("granted");
    expect(log.subscribeCalls).toEqual([{ key: VAPID_KEY, userVisibleOnly: true }]);
    const [subscribe] = pushCalls(state, "/api/push/subscribe");
    expect(subscribe.authorization).toBe("Bearer fixture-id-token");
    expect(subscribe.body).toEqual({
      subscription: { endpoint: log.endpoint, expirationTime: null, keys: { p256dh: "BPe2e-receiver-key", auth: "e2e-auth-secret" } },
      device_label: "Android · Chrome",
      kinds: ALL_KINDS,
    });
    for (const name of ["Approvals and questions", "A session failed", "Project manager errors", "Mac offline"])
      await expect(page.getByLabel(name)).toBeChecked();
    await expect(page.getByRole("button", { name: "Send test notification" })).toBeVisible();

    // A reload reads the state back without asking or posting again.
    await page.reload();
    await signedIn(page);
    await openSettings(page);
    await expect(page.locator("#notify-summary")).toHaveText("On");
    expect(pushCalls(state, "/api/push/subscribe")).toHaveLength(1);
    expect((await pushLog(page)).permissionRequests).toEqual([]);
  });

  test("changing a kind re-posts the subscription", async ({ page, context }) => {
    await stubPush(page, context);
    const state = await fixture(page);
    await page.goto("/");
    await signedIn(page);
    await enable(page, state);
    const endpoint = (await pushLog(page)).endpoint;

    await page.getByLabel("Approvals and questions").tap();
    await expect.poll(() => pushCalls(state, "/api/push/subscribe").length).toBe(2);
    expect(pushCalls(state, "/api/push/subscribe")[1].body).toMatchObject({
      subscription: { endpoint }, device_label: "Android · Chrome", kinds: ["session_failed", "pm_failed", "host_offline"],
    });
    await expect(page.locator("#notify-feedback")).toHaveText("Saved.");
    await page.getByLabel("Mac offline").tap();
    await expect.poll(() => pushCalls(state, "/api/push/subscribe").length).toBe(3);
    expect(pushCalls(state, "/api/push/subscribe")[2].body.kinds).toEqual(["session_failed", "pm_failed"]);
    // No new browser subscription: the same one is re-posted.
    expect((await pushLog(page)).subscribeCalls).toHaveLength(1);
    // Saved once the relay accepted it (the display after a reload reads it back).
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("foreman:push-kinds") || "null"))).toEqual(["session_failed", "pm_failed"]);

    await page.reload();
    await signedIn(page);
    await openSettings(page);
    await expect(page.getByLabel("Approvals and questions")).not.toBeChecked();
    await expect(page.getByLabel("Mac offline")).not.toBeChecked();
    await expect(page.getByLabel("A session failed")).toBeChecked();
  });

  test("Send test notification calls /api/push/test for this device and shows errors", async ({ page, context }) => {
    await stubPush(page, context);
    const state = await fixture(page, { testStatus: 429 });
    await page.goto("/");
    await signedIn(page);
    await enable(page, state);
    await page.getByRole("button", { name: "Send test notification" }).tap();
    await expect(page.locator("#notify-feedback")).toHaveText("Too many test notifications; try again later");
    const [call] = pushCalls(state, "/api/push/test");
    expect(call.body).toEqual({ endpoint: (await pushLog(page)).endpoint });
    expect(call.authorization).toBe("Bearer fixture-id-token");
  });

  test("Send test notification reports success", async ({ page, context }) => {
    await stubPush(page, context);
    const state = await fixture(page);
    await page.goto("/");
    await signedIn(page);
    await enable(page, state);
    await page.getByRole("button", { name: "Send test notification" }).tap();
    await expect(page.locator("#notify-feedback")).toHaveText("Test notification sent. It should arrive in a few seconds.");
    expect(pushCalls(state, "/api/push/test")).toHaveLength(1);
  });

  test("Turn off unsubscribes this device on the relay and in the browser", async ({ page, context }) => {
    await stubPush(page, context);
    const state = await fixture(page);
    await page.goto("/");
    await signedIn(page);
    await enable(page, state);
    const endpoint = (await pushLog(page)).endpoint;
    await page.getByRole("button", { name: "Turn off" }).tap();
    await expect(page.locator("#notify-summary")).toHaveText("Off");
    expect(pushCalls(state, "/api/push/unsubscribe").map((c) => c.body)).toEqual([{ endpoint }]);
    expect(await pushLog(page)).toMatchObject({ unsubscribed: [endpoint], endpoint: null });
    await expect(page.getByRole("button", { name: "Turn on notifications" })).toBeVisible();
  });

  test("blocked permission explains how to re-enable and offers no button", async ({ page, context }) => {
    await stubPush(page, context, { permission: "denied" });
    const state = await fixture(page);
    await page.goto("/");
    await signedIn(page);
    await openSettings(page);
    await expect(page.locator("#notify-summary")).toHaveText("Blocked");
    await expect(page.locator("#notify-status")).toContainText("Settings → Apps → Foreman → Notifications");
    await expect(page.getByRole("button", { name: "Turn on notifications" })).toBeHidden();
    expect((await pushLog(page)).permissionRequests).toEqual([]);
    expect(state.calls.filter((c) => c.path.startsWith("/api/push/"))).toEqual([]);
  });

  test("a subscription made with an old key is replaced with the current key", async ({ page, context }) => {
    await context.grantPermissions(["notifications"], { origin: ORIGIN });
    await stubPush(page, context, { existingKey: OLD_KEY });
    const state = await fixture(page);
    await page.addInitScript(() => localStorage.setItem("foreman:push-kinds", JSON.stringify(["approval_requested", "question_asked"])));
    await page.goto("/");
    await signedIn(page);
    await expect.poll(() => pushCalls(state, "/api/push/subscribe").length).toBe(1);
    const log = await pushLog(page);
    expect(log.unsubscribed).toEqual(["https://fcm.googleapis.com/fcm/send/e2e-existing"]);
    expect(log.subscribeCalls).toEqual([{ key: VAPID_KEY, userVisibleOnly: true }]);
    expect(pushCalls(state, "/api/push/subscribe")[0].body).toMatchObject({ subscription: { endpoint: log.endpoint }, kinds: ["approval_requested", "question_asked"] });
    await expect.poll(() => pushCalls(state, "/api/push/unsubscribe").map((c) => c.body)).toEqual([{ endpoint: "https://fcm.googleapis.com/fcm/send/e2e-existing" }]);
    await openSettings(page);
    await expect(page.locator("#notify-summary")).toHaveText("On");
    // No permission prompt: it was already granted.
    expect(log.permissionRequests).toEqual([]);
  });
});

test.describe("sign-out", () => {
  test("unsubscribes on the relay with the token before Firebase sign-out, then in the browser", async ({ page, context }) => {
    await stubPush(page, context);
    const state = await fixture(page);
    await page.goto("/");
    await signedIn(page);
    await enable(page, state);
    const endpoint = (await pushLog(page)).endpoint;
    state.events.length = 0;
    await page.getByRole("button", { name: "Sign out" }).tap();
    await expect(page.locator("#app")).toBeHidden();
    await expect.poll(() => state.events).toEqual(["unsubscribe", "signOut"]);
    const [call] = pushCalls(state, "/api/push/unsubscribe");
    expect(call.body).toEqual({ endpoint });
    expect(call.authorization).toBe("Bearer fixture-id-token");
    expect(await pushLog(page)).toMatchObject({ unsubscribed: [endpoint], endpoint: null });
  });

  test("a failing unsubscribe does not block sign-out", async ({ page, context }) => {
    await stubPush(page, context);
    const state = await fixture(page, { unsubscribeFails: true });
    await page.goto("/");
    await signedIn(page);
    await enable(page, state);
    const endpoint = (await pushLog(page)).endpoint;
    state.events.length = 0;
    await page.getByRole("button", { name: "Sign out" }).tap();
    await expect.poll(() => state.events).toEqual(["unsubscribe", "signOut"]);
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    expect((await pushLog(page)).unsubscribed).toEqual([endpoint]);
  });
});

// --- Service worker push and click handling ---

async function worker(page: Page): Promise<Worker> {
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 10000 }).toBe(true);
  await expect.poll(() => page.context().serviceWorkers().length).toBeGreaterThan(0);
  return page.context().serviceWorkers()[0];
}
// Delivers a real push message (a trusted PushEvent) into the registered service worker.
async function deliver(page: Page, data: string) {
  const cdp = await page.context().newCDPSession(page);
  const registrations: { registrationId: string; isDeleted: boolean }[] = [];
  cdp.on("ServiceWorker.workerRegistrationUpdated", (event) => registrations.push(...event.registrations));
  await cdp.send("ServiceWorker.enable");
  await expect.poll(() => registrations.some((r) => !r.isDeleted)).toBe(true);
  const { registrationId } = registrations.find((r) => !r.isDeleted)!;
  await cdp.send("ServiceWorker.deliverPushMessage", { origin: `${ORIGIN}/`, registrationId, data });
  await cdp.detach();
}
type Shown = { title: string; body: string; tag: string; url: unknown; icon: string; renotify: boolean; data: unknown };
const shown = (page: Page) => page.evaluate(async () => {
  const registration = await navigator.serviceWorker.ready;
  return (await registration.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, url: n.data?.url, icon: n.icon, renotify: (n as any).renotify, data: n.data }));
}) as Promise<Shown[]>;
function payload(overrides: Record<string, unknown> = {}) {
  return {
    v: 1, kind: "approval_requested", host: "Dev Mac", session_key: "managed:alpha", session_name: "Fix sign-in",
    at: "2026-09-24T10:00:00.000Z", tag: "session:managed:alpha", title: "Approval needed",
    body: "Fix sign-in is waiting for your approval", url: "/?session=managed%3Aalpha", ...overrides,
  };
}
const GENERIC = { title: "Foreman needs your attention", body: "Open Foreman to see what needs you.", tag: "foreman", url: "/" };

test.describe("service worker push", () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(["notifications"], { origin: ORIGIN });
  });

  test("shows exactly the payload's title, body and tag, and nothing else", async ({ page }) => {
    await fixture(page);
    await page.goto("/");
    await worker(page);
    // Fields outside title/body/tag/url must never be rendered, even if a payload carried them.
    await deliver(page, JSON.stringify(payload({ text: "SECRET transcript text", input: { command: "rm -rf /Users/dev" }, session_name: "SECRET name" })));
    await expect.poll(() => shown(page)).toHaveLength(1);
    const [note] = await shown(page);
    expect(note).toMatchObject({ title: "Approval needed", body: "Fix sign-in is waiting for your approval", tag: "session:managed:alpha", url: "/?session=managed%3Aalpha", renotify: true });
    expect(note.icon).toBe(`${ORIGIN}/icons/icon-192.png`);
    expect(note.data).toEqual({ url: "/?session=managed%3Aalpha" });
    expect(JSON.stringify(note)).not.toMatch(/SECRET|rm -rf|Dev Mac/);
  });

  test("a second push with the same tag replaces the first; another tag stacks", async ({ page }) => {
    await fixture(page);
    await page.goto("/");
    await worker(page);
    await deliver(page, JSON.stringify(payload()));
    await expect.poll(() => shown(page)).toHaveLength(1);
    await deliver(page, JSON.stringify(payload({ kind: "question_asked", title: "Question from Fix sign-in", body: "Fix sign-in has a question for you" })));
    await expect.poll(async () => (await shown(page)).map((n) => n.title)).toEqual(["Question from Fix sign-in"]);
    await deliver(page, JSON.stringify(payload({ kind: "pm_failed", session_key: undefined, session_name: undefined, tag: "pm", url: "/?view=pm", title: "PM needs attention", body: "The project manager hit an error. Open Foreman for details." })));
    await expect.poll(async () => (await shown(page)).map((n) => n.tag).sort()).toEqual(["pm", "session:managed:alpha"]);
    // Only approvals and questions re-alert.
    expect((await shown(page)).find((n) => n.tag === "pm")!.renotify).toBe(false);
  });

  const invalid: [string, string][] = [
    ["an unsafe absolute url", JSON.stringify(payload({ url: "https://evil.example/?session=managed%3Aalpha" }))],
    ["a protocol-relative url", JSON.stringify(payload({ url: "//evil.example/" }))],
    ["a javascript: url", JSON.stringify(payload({ url: "javascript:alert(1)" }))],
    ["an empty payload (payload-less push)", ""],
    ["unreadable JSON", "{not json"],
    ["another payload version", JSON.stringify(payload({ v: 2 }))],
    ["a non-string title", JSON.stringify(payload({ title: { html: "<b>x</b>" } }))],
  ];
  for (const [label, data] of invalid)
    test(`${label} shows the generic notification opening /`, async ({ page }) => {
      await fixture(page);
      await page.goto("/");
      await worker(page);
      await deliver(page, data);
      await expect.poll(() => shown(page)).toHaveLength(1);
      expect((await shown(page))[0]).toMatchObject({ ...GENERIC, data: { url: "/" } });
    });
});

// Dispatches notificationclick for the shown notification with `tag` into the shipped
// listener, and waits for the work it hands to waitUntil.
async function click(sw: Worker, tag: string) {
  await sw.evaluate(async (tag) => {
    const [notification] = await (self as any).registration.getNotifications({ tag });
    if (!notification) throw new Error(`No notification with tag ${tag}`);
    const event: any = new (self as any).NotificationEvent("notificationclick", { notification });
    const pending: Promise<unknown>[] = [];
    Object.defineProperty(event, "waitUntil", { value: (promise: Promise<unknown>) => pending.push(promise) });
    self.dispatchEvent(event);
    if (!pending.length) throw new Error("The handler did not call waitUntil");
    await Promise.all(pending);
  }, tag);
}

test.describe("notification click", () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(["notifications"], { origin: ORIGIN });
  });

  test("routes the open app to the session in place, and Back returns to the inbox", async ({ page }) => {
    const state = await fixture(page);
    await page.goto("/");
    await signedIn(page);
    await expect(page.getByRole("heading", { name: "Your session inbox" })).toBeVisible();
    const sw = await worker(page);
    await page.evaluate(() => { (window as any).__sameDocument = true; });
    await deliver(page, JSON.stringify(payload()));
    await expect.poll(() => shown(page)).toHaveLength(1);
    await click(sw, "session:managed:alpha");
    await expect(page).toHaveURL(`${ORIGIN}/?session=managed%3Aalpha`);
    await expect(page.getByRole("heading", { name: "Fix sign-in", exact: true })).toBeVisible();
    await expect(page.getByText("History of Fix sign-in")).toBeVisible();
    expect(state.calls.some((c) => c.path === "/api/session")).toBe(true);
    // No reload: the same document handled it.
    expect(await page.evaluate(() => (window as any).__sameDocument)).toBe(true);
    // The notification was closed.
    expect(await shown(page)).toEqual([]);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Your session inbox" })).toBeVisible();
  });

  test("a PM notification opens the project manager", async ({ page }) => {
    await fixture(page);
    await page.goto("/?session=managed%3Abeta");
    await signedIn(page);
    await expect(page.getByText("History of Write docs")).toBeVisible();
    const sw = await worker(page);
    await deliver(page, JSON.stringify(payload({ kind: "pm_failed", session_key: undefined, tag: "pm", url: "/?view=pm", title: "PM needs attention", body: "The project manager hit an error." })));
    await expect.poll(() => shown(page)).toHaveLength(1);
    await click(sw, "pm");
    await expect(page).toHaveURL(`${ORIGIN}/?view=pm`);
    await expect(page.getByRole("heading", { name: "Claude · Project manager" })).toBeVisible();
  });

  test("a session missing from the Mac falls back to the inbox with the neutral notice", async ({ page }) => {
    await fixture(page);
    await page.goto("/");
    await signedIn(page);
    const sw = await worker(page);
    await deliver(page, JSON.stringify(payload({ session_key: "fm:gone", tag: "session:fm:gone", url: "/?session=fm%3Agone" })));
    await expect.poll(() => shown(page)).toHaveLength(1);
    await click(sw, "session:fm:gone");
    await expect(page.locator("#app-notice")).toHaveText("That conversation isn’t available on the execution host. Showing your inbox.");
    await expect(page.getByRole("heading", { name: "Your session inbox" })).toBeVisible();
    await expect.poll(() => page.url()).toBe(`${ORIGIN}/`);
  });

  test("with no app window open, it opens one at the notification's URL", async ({ page, context }) => {
    await fixture(page);
    await page.goto("/");
    const sw = await worker(page);
    await deliver(page, JSON.stringify(payload()));
    await expect.poll(() => shown(page)).toHaveLength(1);
    // clients.openWindow needs a real click's activation, so record the call instead.
    await sw.evaluate(() => {
      (self as any).__opened = [];
      (self as any).clients.openWindow = async (url: string) => { (self as any).__opened.push(url); return null; };
    });
    // A blank tab keeps the context alive; it is not an app window.
    const blank = await context.newPage();
    await page.close();
    await click(sw, "session:managed:alpha");
    expect(await sw.evaluate(() => (self as any).__opened)).toEqual([`${ORIGIN}/?session=managed%3Aalpha`]);
    await blank.close();
  });
});
