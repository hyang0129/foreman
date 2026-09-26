import { test, expect, devices, type Page, type BrowserContext } from "@playwright/test";
import { inflateSync } from "node:zlib";

// Installable web shell (AND-02): manifest, icons, service worker, offline screen, updates,
// deep links and Android Back, on Chromium with Pixel 7 emulation (viewport, touch, mobile UA).
// The full Chromium build (not the default headless shell) is used because the headless shell
// does not evaluate installability: its Page.getInstallabilityErrors returns [] even for a
// manifest with no icons and display "browser".
const { defaultBrowserType: _browser, ...pixel7 } = devices["Pixel 7"];
test.use({ ...pixel7, channel: "chromium" });

const managed = {
  session_key: "managed:alpha",
  session_id: "native-alpha",
  provider: "claude",
  name: "Fix sign-in",
  cwd: "/Users/dev/code/app",
  state: "idle",
  managed: true,
  capabilities: { message: true, interrupt: true, approvals: true },
  updated_at: new Date().toISOString(),
};
const second = { ...managed, session_key: "managed:beta", session_id: "native-beta", name: "Write docs" };

async function fixture(page: Page | BrowserContext, options: { auth?: any } = {}) {
  const state = { calls: [] as { path: string; search: string }[] };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()), path = url.pathname;
    state.calls.push({ path, search: url.search });
    let result: any = {}, status = 200;
    if (path === "/api/config") result = { auth: options.auth ?? { required: false } };
    else if (path === "/api/host") result = { online: true, host: "Dev Mac" };
    else if (path === "/api/sessions") result = [managed, second];
    else if (path === "/api/session") {
      const session = [managed, second].find((s) => s.session_key === url.searchParams.get("id"));
      if (!session) { status = 404; result = { error: "Unknown session" }; }
      else result = { session, history: [{ id: `h-${session.session_id}`, role: "assistant", text: `History of ${session.name}` }], receipts: [], approvals: [] };
    } else if (path === "/api/pm/history") result = { history: [{ role: "assistant", text: "How can I help the fleet?" }], error: null, busy: false, model: null };
    else if (path === "/api/models") result = { models: [] };
    else if (path === "/api/projects") result = { projects: [] };
    else { status = 404; result = { error: "Unknown mock route" }; }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(result) });
  });
  return state;
}

async function controlled(page: Page) {
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 10000 }).toBe(true);
}

// Minimal PNG reader (8-bit RGB/RGBA, non-interlaced): enough to check the committed icons.
function readPng(buffer: Buffer) {
  expect(buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let offset = 8, width = 0, height = 0, colorType = 0;
  const data: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString("ascii", offset + 4, offset + 8);
    const chunk = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
      expect(chunk[8]).toBe(8);
      colorType = chunk[9];
      expect(chunk[12]).toBe(0);
    } else if (type === "IDAT") data.push(chunk);
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  expect(channels).toBeGreaterThan(0);
  const raw = inflateSync(Buffer.concat(data)), stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y ? pixels[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      pixels[y * stride + x] = (row[x] + predictor) & 0xff;
    }
  }
  const pixel = (x: number, y: number) => [...pixels.subarray(y * stride + x * channels, y * stride + x * channels + channels)];
  return { width, height, channels, pixel };
}

test.describe("installability", () => {
  test("manifest, icons and headers satisfy install requirements", async ({ page, request }) => {
    await fixture(page);
    const manifestResponse = await request.get("/manifest.webmanifest");
    expect(manifestResponse.headers()["content-type"]).toBe("application/manifest+json");
    expect(manifestResponse.headers()["x-content-type-options"]).toBe("nosniff");
    const manifest = await manifestResponse.json();
    expect(manifest).toMatchObject({ name: "Foreman", short_name: "Foreman", id: "/", start_url: "/", scope: "/", display: "standalone" });
    // Launch colors agree with the light theme the page paints first.
    const light = (await (await request.get("/index.html")).text()).match(/name="theme-color" content="(#[0-9a-f]{6})"/)![1];
    expect(manifest.theme_color).toBe(light);
    expect(manifest.background_color).toBe(light);
    expect(await (await request.get("/appearance.js")).text()).toContain(`"${light}"`);

    const icons = manifest.icons as { src: string; sizes: string; type: string; purpose: string }[];
    expect(icons.map((icon) => `${icon.sizes} ${icon.purpose}`).sort()).toEqual(["192x192 any", "512x512 any", "512x512 maskable"]);
    for (const icon of icons) {
      const response = await request.get(icon.src);
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toBe("image/png");
      const png = readPng(await response.body());
      expect(`${png.width}x${png.height}`).toBe(icon.sizes);
      if (icon.purpose !== "maskable") continue;
      // Maskable: fully opaque, and everything outside the central 80% circle is background.
      const background = png.pixel(0, 0);
      const radius = png.width * 0.4, center = png.width / 2;
      const translucent: string[] = [], outside: string[] = [];
      for (let y = 0; y < png.height; y++)
        for (let x = 0; x < png.width; x++) {
          const value = png.pixel(x, y);
          if (png.channels === 4 && value[3] !== 255) translucent.push(`${x},${y}`);
          if (Math.hypot(x + 0.5 - center, y + 0.5 - center) > radius && value.slice(0, 3).join() !== background.slice(0, 3).join()) outside.push(`${x},${y}`);
        }
      expect(translucent).toEqual([]);
      expect(outside).toEqual([]);
      // And the mark is really drawn inside it.
      let ink = 0;
      for (let y = 0; y < png.height; y += 2)
        for (let x = 0; x < png.width; x += 2)
          if (png.pixel(x, y).slice(0, 3).join() !== background.slice(0, 3).join()) ink++;
      expect(ink).toBeGreaterThan(1000);
    }

    // Apple touch icon: 180x180 and fully opaque (iOS fills transparent pixels with black).
    const apple = await request.get("/icons/apple-touch-icon-180.png");
    expect(apple.status()).toBe(200);
    expect(apple.headers()["content-type"]).toBe("image/png");
    const applePng = readPng(await apple.body());
    expect(`${applePng.width}x${applePng.height}`).toBe("180x180");
    const translucent: string[] = [];
    for (let y = 0; y < applePng.height; y++)
      for (let x = 0; x < applePng.width; x++)
        if (applePng.channels === 4 && applePng.pixel(x, y)[3] !== 255) translucent.push(`${x},${y}`);
    expect(translucent).toEqual([]);
    // The corners are the brand ink, not a black or white fill.
    for (const [x, y] of [[0, 0], [179, 0], [0, 179], [179, 179]]) expect(applePng.pixel(x, y).slice(0, 3)).toEqual([0x21, 0x37, 0x2d]);

    // Notification badge (sw.js passes it as `badge`): Android uses only its alpha channel, so it
    // is a white glyph on transparent, 96x96.
    const badge = await request.get("/icons/badge-96.png");
    expect(badge.status()).toBe(200);
    expect(badge.headers()["content-type"]).toBe("image/png");
    const badgePng = readPng(await badge.body());
    expect(`${badgePng.width}x${badgePng.height}`).toBe("96x96");
    expect(badgePng.channels).toBe(4);
    let clear = 0, glyph = 0;
    const colored: string[] = [];
    for (let y = 0; y < badgePng.height; y++)
      for (let x = 0; x < badgePng.width; x++) {
        const [r, g, b, a] = badgePng.pixel(x, y);
        if (a === 0) clear++;
        if (a === 255) glyph++;
        if (a > 0 && (r !== 255 || g !== 255 || b !== 255)) colored.push(`${x},${y}`);
      }
    expect(colored).toEqual([]);
    // Mostly transparent, with a solid glyph (not an opaque square, not empty).
    expect(clear).toBeGreaterThan(96 * 96 * 0.5);
    expect(glyph).toBeGreaterThan(500);
    for (const [x, y] of [[0, 0], [95, 0], [0, 95], [95, 95]]) expect(badgePng.pixel(x, y)[3]).toBe(0);

    const sw = await request.get("/sw.js");
    expect(sw.headers()["cache-control"]).toBe("no-cache");
    expect(sw.headers()["content-type"]).toBe("application/javascript");
    const index = await request.get("/");
    for (const [name, value] of [["x-content-type-options", "nosniff"], ["referrer-policy", "same-origin"], ["content-security-policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"]])
      expect(index.headers()[name]).toBe(value);

    await page.goto("/");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/icons/apple-touch-icon-180.png");
    await controlled(page);
    const cdp = await page.context().newCDPSession(page);
    const parsed = await cdp.send("Page.getAppManifest");
    expect(parsed.errors).toEqual([]);
    expect(parsed.url).toBe("http://127.0.0.1:4188/manifest.webmanifest");
    // Playwright's browser contexts are off-the-record profiles, which Chromium never installs
    // from; that is the only error allowed. (A broken manifest here reports e.g.
    // manifest-display-not-supported and manifest-missing-suitable-icon.)
    const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
    expect(installabilityErrors.map((error) => error.errorId)).toEqual(["in-incognito"]);
  });
});

test.describe("service worker", () => {
  test("controls the page after reload without handling API, app code or caching them", async ({ page }) => {
    const state = await fixture(page);
    const responses: { path: string; fromSW: boolean }[] = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin === "http://127.0.0.1:4188") responses.push({ path: url.pathname, fromSW: response.fromServiceWorker() });
    });
    await page.goto("/");
    await controlled(page);
    responses.length = 0;
    const hostCalls = state.calls.filter((c) => c.path === "/api/host").length;
    await page.reload();
    await controlled(page);
    await expect(page.getByRole("button", { name: /Fix sign-in/ })).toBeVisible();
    await expect.poll(() => state.calls.filter((c) => c.path === "/api/host").length).toBeGreaterThan(hostCalls);
    // The navigation went through the worker (it is really in the path) ...
    expect(responses.find((r) => r.path === "/")?.fromSW).toBe(true);
    // ... but API traffic and app code went to the network untouched.
    const api = responses.filter((r) => r.path.startsWith("/api/"));
    expect(api.length).toBeGreaterThan(0);
    expect(api.filter((r) => r.fromSW)).toEqual([]);
    for (const asset of ["/app.js", "/style.css", "/appearance.js"])
      expect(responses.find((r) => r.path === asset)).toEqual({ path: asset, fromSW: false });

    const cached = await page.evaluate(async () => {
      const entries: string[] = [];
      for (const name of await caches.keys())
        for (const request of await (await caches.open(name)).keys()) entries.push(`${name} ${new URL(request.url).pathname}`);
      return entries.sort();
    });
    expect(cached).toEqual([
      "foreman-shell-v1 /icons/icon-192.png",
      "foreman-shell-v1 /icons/icon-512.png",
      "foreman-shell-v1 /icons/maskable-512.png",
      "foreman-shell-v1 /offline.html",
    ]);
  });

  test("offline shows the Foreman offline screen and Retry restores the app and draft", async ({ page, context }) => {
    await fixture(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Open session navigation" }).tap();
    await page.getByRole("button", { name: /Fix sign-in/ }).tap();
    await expect(page.getByText("History of Fix sign-in")).toBeVisible();
    await page.getByLabel("Message this session").fill("Draft typed before going offline");
    await controlled(page);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "You’re offline" })).toBeVisible();
    await expect(page).toHaveTitle("Foreman · Offline");
    expect(page.url()).toBe("http://127.0.0.1:4188/?session=managed%3Aalpha");
    // No session data on the offline screen.
    const text = await page.locator("body").innerText();
    for (const secret of ["Fix sign-in", "History of", "Draft typed", "managed:alpha"]) expect(text).not.toContain(secret);

    // Retry reloads (a fresh document) and, still offline, shows the offline screen again.
    await page.evaluate(() => { (window as any).__before = true; });
    await page.getByRole("button", { name: "Retry" }).tap();
    await expect.poll(async () => {
      try { return await page.evaluate(() => (window as any).__before ?? false); } catch { return "navigating"; }
    }).toBe(false);
    await expect(page.getByRole("heading", { name: "You’re offline" })).toBeVisible();

    // Back online: the page retries by itself, and the app returns with the draft.
    await context.setOffline(false);
    await expect(page.getByRole("heading", { name: "Fix sign-in", exact: true })).toBeVisible();
    await expect(page.getByLabel("Message this session")).toHaveValue("Draft typed before going offline");
  });

  test("the Retry button restores the app", async ({ page, context }) => {
    await fixture(page);
    await page.goto("/?view=pm");
    await controlled(page);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    // Restore the network while the offline screen ignores the online event, so only the
    // button can bring the app back.
    await page.addInitScript(() => {
      const add = window.addEventListener.bind(window);
      window.addEventListener = ((type: string, ...rest: any[]) => type === "online" ? undefined : add(type, ...rest)) as any;
    });
    await page.reload();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await context.setOffline(false);
    await page.waitForTimeout(500);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await page.getByRole("button", { name: "Retry" }).tap();
    await expect(page.getByRole("heading", { name: "Coordinator", exact: true })).toBeVisible();
  });

  test("a deploy reaches the controlled app on the next load", async ({ page, context }) => {
    await fixture(page);
    await page.goto("/");
    await controlled(page);
    await page.reload();
    await controlled(page);
    expect(await page.evaluate(() => (globalThis as any).__foremanE2EVersion)).toBeUndefined();
    // Simulate a deploy: the server now stamps a new version into index.html and app.js.
    await context.addCookies([{ name: "foreman-e2e-version", value: "v2", url: "http://127.0.0.1:4188" }]);
    const appJs = page.waitForResponse((response) => new URL(response.url()).pathname === "/app.js");
    const navigation = await page.reload();
    expect(navigation!.fromServiceWorker()).toBe(true);
    expect((await appJs).fromServiceWorker()).toBe(false);
    await expect(page.locator('meta[name="foreman-e2e-version"]')).toHaveAttribute("content", "v2");
    await expect.poll(() => page.evaluate(() => (globalThis as any).__foremanE2EVersion)).toBe("v2");
    await controlled(page);
    await expect(page.getByRole("button", { name: /Fix sign-in/ })).toBeAttached();
  });

  test("a direct navigation to an /api URL is left to the network", async ({ page, context }) => {
    await fixture(page);
    await page.goto("/");
    await controlled(page);
    // Real network from here on: the test server answers anything under /api with its 404.
    await page.unrouteAll();
    for (const path of ["/api", "/api/sessions"]) {
      // Online: the browser fetched it itself; the worker never answered it.
      const response = await page.goto(path);
      expect(response!.status()).toBe(404);
      expect(response!.fromServiceWorker()).toBe(false);
      // A control: an app navigation from the same page does go through the worker.
      expect((await page.goto("/"))!.fromServiceWorker()).toBe(true);
      await controlled(page);
      // Offline: a plain network error, never the offline screen or the app shell.
      await context.setOffline(true);
      await expect(page.goto(path)).rejects.toThrow(/ERR_INTERNET_DISCONNECTED/);
      await expect(page.getByRole("heading", { name: "You’re offline" })).toHaveCount(0);
      await context.setOffline(false);
      await page.goto("/");
      await controlled(page);
    }
  });
});

test.describe("deep links", () => {
  test("a session link opens that conversation and is canonical", async ({ page }) => {
    const state = await fixture(page);
    await page.goto("/?session=managed:alpha&utm_source=notification");
    await expect(page.getByRole("heading", { name: "Fix sign-in", exact: true })).toBeVisible();
    await expect(page.getByText("History of Fix sign-in")).toBeVisible();
    expect(page.url()).toBe("http://127.0.0.1:4188/?session=managed%3Aalpha");
    expect(state.calls.filter((c) => c.path === "/api/session").every((c) => c.search === "?id=managed%3Aalpha")).toBe(true);
    // The PM sits beneath a deep link, so Back returns to it rather than leaving.
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Coordinator", exact: true })).toBeVisible();
    expect(page.url()).toBe("http://127.0.0.1:4188/");
  });

  test("the PM link opens the project manager at its canonical home URL", async ({ page }) => {
    await fixture(page);
    await page.goto("/?view=pm");
    await expect(page.getByRole("heading", { name: "Coordinator", exact: true })).toBeVisible();
    await expect(page.getByText("How can I help the fleet?")).toBeVisible();
    expect(page.url()).toBe("http://127.0.0.1:4188/");
  });

  test("the app opens on the project manager, ready to message", async ({ page }) => {
    await fixture(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Coordinator", exact: true })).toBeVisible();
    await expect(page.getByText("How can I help the fleet?")).toBeVisible();
    const composer = page.getByLabel("Message this session");
    await expect(composer).toBeEnabled();
    await expect(composer).toHaveAttribute("placeholder", "What are we working on?");
    // A tap focuses it (on a phone, this is what raises the keyboard).
    await composer.tap();
    await expect(composer).toBeFocused();
    expect(page.url()).toBe("http://127.0.0.1:4188/");
  });

  for (const [label, link] of [["unknown", "/?session=fm:not-on-this-mac"], ["malformed", "/?session=has%20space"], ["the PM sentinel", "/?session=pm"]]) {
    test(`an ${label} session link falls back to the PM with a neutral notice`, async ({ page }) => {
      const state = await fixture(page);
      await page.goto(link);
      await expect(page.locator("#app-notice")).toHaveText("That conversation isn’t available on the execution host. Showing the Coordinator.");
      await expect(page.locator("#app-notice")).toHaveAttribute("role", "status");
      await expect(page.getByRole("heading", { name: "Coordinator", exact: true })).toBeVisible();
      await expect(page.getByText("How can I help the fleet?")).toBeVisible();
      await expect(page.locator("#error-banner")).toBeHidden();
      await expect.poll(() => page.url()).toBe("http://127.0.0.1:4188/");
      expect(state.calls.filter((c) => c.path === "/api/session")).toEqual([]);
      // The app stays fully usable.
      await page.getByRole("button", { name: "Open session navigation" }).tap();
      await page.getByRole("button", { name: /Write docs/ }).tap();
      await expect(page.getByText("History of Write docs")).toBeVisible();
      await expect(page.locator("#app-notice")).toBeHidden();
    });
  }

  test("Forward after Back from a rejected link repeats the neutral notice", async ({ page }) => {
    const state = await fixture(page);
    await page.goto("/?session=fm:not-on-this-mac");
    await expect(page.locator("#app-notice")).toHaveText("That conversation isn’t available on the execution host. Showing the Coordinator.");
    await expect.poll(() => page.url()).toBe("http://127.0.0.1:4188/");
    await expect.poll(() => page.evaluate(() => history.state?.view ?? null)).toBeNull();
    // Dismiss the first notice so the next one is observably new.
    await page.locator("#app-notice").evaluate((notice: HTMLElement) => { notice.hidden = true; });
    await page.goForward();
    await expect(page.locator("#app-notice")).toBeVisible();
    await expect(page.locator("#app-notice")).toHaveText("That conversation isn’t available on the execution host. Showing the Coordinator.");
    await expect(page.getByRole("heading", { name: "Coordinator", exact: true })).toBeVisible();
    await expect.poll(() => page.url()).toBe("http://127.0.0.1:4188/");
    await page.waitForTimeout(300);
    await expect(page.locator("#error-banner")).toBeHidden();
    expect(state.calls.filter((c) => c.path === "/api/session")).toEqual([]);
    // The app stays usable: a conversation opens and Back returns to the PM.
    await page.getByRole("button", { name: "Open session navigation" }).tap();
    await page.getByRole("button", { name: /Write docs/ }).tap();
    await expect(page.getByText("History of Write docs")).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Coordinator", exact: true })).toBeVisible();
  });

  test("selecting conversations updates the URL and reload keeps the view", async ({ page }) => {
    await fixture(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Open session navigation" }).tap();
    await page.getByRole("button", { name: /Write docs/ }).tap();
    await expect(page).toHaveURL("http://127.0.0.1:4188/?session=managed%3Abeta");
    await page.reload();
    await expect(page.getByText("History of Write docs")).toBeVisible();
    await page.getByRole("button", { name: "Open session navigation" }).tap();
    await page.locator("#select-pm").tap();
    await expect(page).toHaveURL("http://127.0.0.1:4188/");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Coordinator", exact: true })).toBeVisible();
  });

  test("a deep link waits for sign-in, then opens", async ({ page }) => {
    await page.route("https://www.gstatic.com/firebasejs/**/firebase-app.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: "export const initializeApp = value => value;" }));
    await page.route("https://www.gstatic.com/firebasejs/**/firebase-auth.js", (route) => route.fulfill({ contentType: "application/javascript", body: `
      const user = {email:'owner@example.com',getIdToken:async()=> 'fixture-id-token'};
      let callback;
      export const getAuth = () => ({currentUser:null});
      export const onAuthStateChanged = (auth,fn) => { callback=fn; queueMicrotask(()=>fn(null)); };
      export class GoogleAuthProvider { setCustomParameters() {} }
      export const signInWithPopup = async (auth) => { auth.currentUser = user; return { user }; };
    ` }));
    const state = await fixture(page, { auth: { required: true, firebase: { apiKey: "fixture-api-key" } } });
    await page.goto("/?session=managed%3Abeta");
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    expect(state.calls.filter((c) => c.path === "/api/session")).toEqual([]);
    await page.getByRole("button", { name: "Continue with Google" }).tap();
    await expect(page.getByText("History of Write docs")).toBeVisible();
    expect(page.url()).toBe("http://127.0.0.1:4188/?session=managed%3Abeta");
  });
});

test.describe("Android Back", () => {
  test("Back closes the drawer, then leaves the conversation, then leaves the app", async ({ page }) => {
    await fixture(page);
    await page.goto("/");
    const openNav = page.getByRole("button", { name: "Open session navigation" });

    // Drawer: Back closes it and keeps the PM.
    await openNav.tap();
    await expect(openNav).toHaveAttribute("aria-expanded", "true");
    await page.goBack();
    await expect(openNav).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#rail")).toHaveAttribute("inert", "");
    expect(page.url()).toBe("http://127.0.0.1:4188/");

    // Closing the drawer by its own controls does not leave entries behind.
    for (let i = 0; i < 3; i++) {
      await openNav.tap();
      await expect(openNav).toHaveAttribute("aria-expanded", "true");
      await page.locator("#close-nav").tap();
      await expect(openNav).toHaveAttribute("aria-expanded", "false");
      await expect.poll(() => page.evaluate(() => history.state?.overlay ?? null)).toBeNull();
    }

    // Conversation from the drawer, then Back to the PM.
    await openNav.tap();
    await page.getByRole("button", { name: /Fix sign-in/ }).tap();
    await expect(page.getByText("History of Fix sign-in")).toBeVisible();
    await expect(page).toHaveURL(/\?session=managed%3Aalpha$/);
    // Switching conversations replaces the entry: Back still goes to the PM.
    await openNav.tap();
    await page.getByRole("button", { name: /Write docs/ }).tap();
    await expect(page.getByText("History of Write docs")).toBeVisible();
    await expect(page).toHaveURL(/\?session=managed%3Abeta$/);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Coordinator", exact: true })).toBeVisible();
    await expect(page.getByText("How can I help the fleet?")).toBeVisible();
    // The PM home view is ready to message, never an empty screen with a dead composer.
    await expect(page.getByLabel("Message this session")).toBeEnabled();
    expect(page.url()).toBe("http://127.0.0.1:4188/");

    // From the PM, Back leaves the app: nothing is trapped and nothing is blank.
    await page.goBack();
    expect(page.url()).toBe("about:blank");
  });

  test("Back closes the new-session dialog before the drawer", async ({ page }) => {
    await fixture(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Open session navigation" }).tap();
    await page.getByRole("button", { name: "New session", exact: true }).tap();
    await expect(page.locator("#new-dialog")).toBeVisible();
    await page.goBack();
    await expect(page.locator("#new-dialog")).toBeHidden();
    await expect(page.getByRole("button", { name: "Open session navigation" })).toHaveAttribute("aria-expanded", "true");
    await page.goBack();
    await expect(page.getByRole("button", { name: "Open session navigation" })).toHaveAttribute("aria-expanded", "false");
    // Closing the dialog with its own button pops its entry, so one Back leaves the app.
    await page.locator("#new-session").evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator("#new-dialog")).toBeVisible();
    await page.getByRole("button", { name: "Close new session" }).tap();
    await expect(page.locator("#new-dialog")).toBeHidden();
    await expect.poll(() => page.evaluate(() => history.state?.overlay ?? null)).toBeNull();
    await page.goBack();
    expect(page.url()).toBe("about:blank");
  });

  test("a reload with the drawer open leaves no duplicate entry: one Back returns to the PM", async ({ page }) => {
    await fixture(page);
    await page.goto("/");
    const openNav = page.getByRole("button", { name: "Open session navigation" });
    await openNav.tap();
    await page.getByRole("button", { name: /Fix sign-in/ }).tap();
    await expect(page.getByText("History of Fix sign-in")).toBeVisible();
    await openNav.tap();
    await expect(openNav).toHaveAttribute("aria-expanded", "true");
    await page.reload();
    await expect(page.getByText("History of Fix sign-in")).toBeVisible();
    await expect(openNav).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => page.evaluate(() => history.state)).toEqual({ foreman: 1, view: "managed:alpha" });
    // One Back is a visible navigation, not a silent step between identical entries.
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Coordinator", exact: true })).toBeVisible();
    expect(page.url()).toBe("http://127.0.0.1:4188/");
    // Forward returns to the conversation; the dead drawer entry beyond it is not a stop either.
    await page.goForward();
    await expect(page.getByText("History of Fix sign-in")).toBeVisible();
    await page.goForward();
    await expect.poll(() => page.evaluate(() => history.state)).toEqual({ foreman: 1, view: "managed:alpha" });
    await expect(openNav).toHaveAttribute("aria-expanded", "false");
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Coordinator", exact: true })).toBeVisible();
    await page.goBack();
    expect(page.url()).toBe("about:blank");
  });

  test("a reload with a dialog over the drawer leaves no duplicate entries", async ({ page }) => {
    await fixture(page);
    await page.goto("/?view=pm");
    await expect(page.getByRole("heading", { name: "Coordinator", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open session navigation" }).tap();
    await page.getByRole("button", { name: "New session", exact: true }).tap();
    await expect(page.locator("#new-dialog")).toBeVisible();
    await expect.poll(() => page.evaluate(() => history.state?.overlay ?? null)).toBe("dialog");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Coordinator", exact: true })).toBeVisible();
    await expect(page.locator("#new-dialog")).toBeHidden();
    // The PM home entry records view null, at "/".
    await expect.poll(() => page.evaluate(() => history.state)).toEqual({ foreman: 1, view: null });
    expect(page.url()).toBe("http://127.0.0.1:4188/");
    // Both dead overlay entries were stepped off, so one Back leaves the app.
    await page.goBack();
    expect(page.url()).toBe("about:blank");
  });

  test("Forward after Back returns to the conversation", async ({ page }) => {
    await fixture(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Open session navigation" }).tap();
    await page.getByRole("button", { name: /Fix sign-in/ }).tap();
    await expect(page.getByText("History of Fix sign-in")).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Coordinator", exact: true })).toBeVisible();
    await page.goForward();
    await expect(page.getByText("History of Fix sign-in")).toBeVisible();
  });
});

test.describe("drafts", () => {
  test("drafts survive a reload, stay bounded to their conversation and clear on send", async ({ page }) => {
    await fixture(page);
    await page.route("**/api/session/message", (route) => route.fulfill({ json: { id: "m1", text: "x", status: "queued" } }));
    await page.goto("/?session=managed%3Aalpha");
    const composer = page.getByLabel("Message this session");
    await expect(composer).toBeEnabled();
    await composer.fill("Alpha draft");
    await page.getByRole("button", { name: "Open session navigation" }).tap();
    await page.getByRole("button", { name: /Write docs/ }).tap();
    await expect(composer).toHaveValue("");
    await composer.fill("Beta draft");
    await page.reload();
    await expect(composer).toHaveValue("Beta draft");
    await page.getByRole("button", { name: "Open session navigation" }).tap();
    await page.getByRole("button", { name: /Fix sign-in/ }).tap();
    await expect(composer).toHaveValue("Alpha draft");
    await page.getByRole("button", { name: "Send", exact: true }).tap();
    await expect(composer).toHaveValue("");
    await page.reload();
    await expect(page.getByText("History of Fix sign-in")).toBeVisible();
    await expect(composer).toHaveValue("");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("foreman:drafts") || "[]"));
    expect(stored).toEqual([["managed:beta", "Beta draft"]]);
  });

  test("sign-out erases stored drafts", async ({ page }) => {
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
    await page.goto("/?session=managed%3Aalpha");
    await page.getByLabel("Message this session").fill("Private draft");
    await page.reload();
    await expect(page.getByLabel("Message this session")).toHaveValue("Private draft");
    await page.getByRole("button", { name: "Open session navigation" }).tap();
    await page.getByRole("button", { name: "Sign out" }).tap();
    await expect(page.locator("#app")).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("foreman:drafts"))).toBeNull();
    await expect(page.getByLabel("Message this session")).toHaveValue("");
  });
});

test.describe("standalone display mode", () => {
  // Chromium's CDP cannot emulate `display-mode: standalone` (Emulation.setEmulatedMedia ignores
  // it), and a real PWA.install creates OS app shortcuts, so it is not used here. The shell has
  // no display-mode-specific code; this checks that nothing in it (service worker, history
  // handling, headers) stands between the tap and the popup call.
  test("popup sign-in is reachable from the installable shell", async ({ page }) => {
    await page.route("https://www.gstatic.com/firebasejs/**/firebase-app.js", (route) =>
      route.fulfill({ contentType: "application/javascript", body: "export const initializeApp = value => value;" }));
    // The Firebase popup call is mocked; the check is that nothing in the shell blocks it:
    // it runs from the tap's user activation and may open a window.
    await page.route("https://www.gstatic.com/firebasejs/**/firebase-auth.js", (route) => route.fulfill({ contentType: "application/javascript", body: `
      const user = {email:'owner@example.com',getIdToken:async()=> 'fixture-id-token'};
      export const getAuth = () => ({currentUser:null});
      export const onAuthStateChanged = (auth,fn) => { queueMicrotask(()=>fn(null)); };
      export class GoogleAuthProvider { setCustomParameters(params) { this.params = params; } }
      export const signInWithPopup = async (auth, provider) => {
        // Transient activation from the tap must still be present (opening the popup consumes it).
        const active = navigator.userActivation.isActive;
        const popup = window.open("about:blank", "firebaseAuth", "popup,width=500,height=600");
        window.__popup = { active,
          opened: !!popup, controlled: !!navigator.serviceWorker.controller, prompt: provider.params?.prompt };
        popup?.close();
        auth.currentUser = user;
        return { user };
      };
    ` }));
    const state = await fixture(page, { auth: { required: true, firebase: { apiKey: "fixture-api-key" } } });
    await page.goto("/");
    await controlled(page);
    await page.reload();
    const popup = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Continue with Google" }).tap();
    await popup;
    await expect(page.locator("#app")).toBeVisible();
    expect(await page.evaluate(() => (window as any).__popup)).toEqual({ active: true, opened: true, controlled: true, prompt: "select_account" });
    await expect.poll(() => state.calls.some((c) => c.path === "/api/host")).toBe(true);
  });
});
