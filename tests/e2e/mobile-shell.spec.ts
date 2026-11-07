// MOBILE-SHELL (9 Oct 2026): the web app on a phone and inside the Pulse phone app, against the synthetic test server.
import { expect, test, type Page } from "@playwright/test";

test.skip(Boolean(process.env.PULSE_REAL_SMOKE), "Synthetic fixtures use the isolated test server");
const admin = { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" };
const staff = { "Cf-Access-Authenticated-User-Email": "staff@example.test" };
const PHONES = [{ width: 360, height: 780 }, { width: 390, height: 844 }];

async function noSideways(page: Page) {
  return page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth + 1);
}

test("internal lane paths stay unavailable instead of redirecting anonymous API calls to login", async ({ request }) => {
  for (const path of ["/v1", "/v1/deliveries/claimable", "/v1/accounts/claimable"]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(404);
    expect(response.headers().location).toBeUndefined();
  }
  const mutation = await request.post("/v1/deliveries/missing/claim", { data: {}, maxRedirects: 0 });
  expect(mutation.status()).toBe(404);
  const exposed = await request.get("/api/v1/deliveries/claimable", { maxRedirects: 0 });
  expect(exposed.status()).toBe(401);
  expect(exposed.headers()["content-type"]).toContain("application/json");
});

test("phone login clears system bars in both themes and keeps its recovery controls tappable", async ({ browser, baseURL }) => {
  for (const size of PHONES) for (const theme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: size, colorScheme: theme,
      userAgent: "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36 PulseShell/1.1.0" });
    await context.addInitScript((t) => { localStorage.setItem("pulse.theme", t); }, theme);
    const page = await context.newPage();
    // The phone's system bars as env(safe-area-inset-*) (POLISH-1: the page counts env() only; the shell's injected
    // copy of the same insets made a double band on Android 14 and older).
    await (await context.newCDPSession(page)).send("Emulation.setSafeAreaInsetsOverride" as never, { insets: { top: 54, bottom: 34, left: 0, right: 0 } } as never);
    try {
      await page.goto(`${baseURL}/login`);
      await expect(page.getByRole("heading", { name: "Sign in to Pulse", exact: true })).toBeVisible();
      // The page streams in behind the loading boundary; measure once the hidden streamed copy has been revealed.
      await expect(page.locator('body > div[hidden][id^="S:"]')).toHaveCount(0);
      const wordmark = await page.locator('section[aria-label="Pulse"] b').boundingBox();
      expect(wordmark!.y).toBeGreaterThanOrEqual(54);
      for (const field of [page.getByLabel("Username or @handle", { exact: true }) /* ORG part 1 (21 Oct): handles sign in too */, page.getByLabel("Password", { exact: true })]) {
        expect(Math.round((await field.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
      }
      expect(Math.round((await page.getByRole("button", { name: "Forgot your password?", exact: true }).boundingBox())!.height)).toBeGreaterThanOrEqual(44);
      expect(await noSideways(page)).toBe(true);
      await page.screenshot({ path: `test-results/mobile-shell/login-${size.width}-${theme}.png` });
    } finally { await context.close(); }
  }
});

test("HR desk renders a roster row in an older service shape, with a one-line average and no lonely bars", async ({ page }) => {
  for (const size of [{ width: 1440, height: 900 }, ...PHONES]) {
    await page.setViewportSize(size); await page.setExtraHTTPHeaders(admin);
    await page.goto("/hr");
    await expect(page.getByRole("heading", { name: /^Who is in/ })).toBeVisible();
    await expect(page.getByText("This view could not load")).toHaveCount(0);
    // Synthetic Sam's row has no per-session rows; the desk shows the entry's total instead of crashing.
    await expect(page.getByText("Synthetic Sam").first()).toBeVisible();
    await expect(page.locator("main").getByText(/1 h 30 min/).first()).toBeVisible();
    // Owner workbench (21 Oct 2026): the 14-day averages and chart moved from the overview to Time → Attendance → Totals.
    await expect(page.getByRole("link", { name: "Attendance", exact: true }).first()).toHaveAttribute("href", "/hr?tab=attendance&view=totals");
    await page.goto("/hr?tab=attendance&view=totals");
    // Attendance averages: a headline number and one line; the details are one tap away.
    const averages = page.locator("[data-attendance-statistics]").first();
    await expect(averages.locator("strong")).toHaveText("8 h 4 min");
    await expect(averages).toContainText("a usual day across 8 checked person-days · 1 to review");
    await expect(averages.locator("details")).not.toHaveAttribute("open", "");
    await expect(averages).toContainText("flagged sessions"); // kept for HR behind "How this is counted"
    // Only one day of the last 14 had check-ins: the fact in words, not a chart with one bar.
    const trend = page.getByRole("group", { name: "People checked in per day, last 14 days" });
    await expect(trend).toContainText("checked in on");
    await expect(trend).toContainText("Only one of the 14 has any so far.");
    if (size.width < 900) expect(await noSideways(page), `HR desk fits ${size.width}`).toBe(true);
  }
});

test("phones: one frame, a solid header, reachable tabs and nothing floating over the page", async ({ page }) => {
  // This designer fixture has attendance enabled. hr-attendance-gate.spec.ts verifies the off state.
  for (const size of PHONES) for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize(size); await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "designer-a@estateautopilots.com" });
    await page.addInitScript((t) => { localStorage.setItem("pulse.theme", t); localStorage.setItem("pulse-companion-web", JSON.stringify({ open: false })); }, theme);
    await page.goto("/me");
    await expect(page.getByRole("heading", { name: "My desk", exact: true, level: 1 })).toBeVisible();
    // The header is a solid surface (content never shows through it while scrolling) and stays on top.
    const header = await page.locator("header").first().evaluate((el) => { const c = getComputedStyle(el); return { position: c.position, background: c.backgroundColor, blur: c.backdropFilter }; });
    expect(header.position).toBe("sticky");
    expect(header.background).not.toBe("rgba(0, 0, 0, 0)");
    // The Pulse companion is not a floating bubble on a phone; Pip is on the Today card.
    await expect(page.getByRole("button", { name: /Open the Pulse companion/ })).toHaveCount(0);
    await expect(page.locator("section[aria-label='Today'] svg").first()).toBeVisible();
    const modes = page.getByRole("group", { name: "Where you are working" });
    const modeBounds = (await modes.boundingBox())!;
    for (const label of ["Office", "Home", "On duty"]) {
      const bounds = (await modes.getByRole("button", { name: label, exact: true }).boundingBox())!;
      expect(bounds.x + bounds.width, `${label} is fully inside the working-mode row`).toBeLessThanOrEqual(modeBounds.x + modeBounds.width + 1);
      // Whole pixels: layout can report a 44 px target as 43.99997 px.
      expect(Math.round(bounds.height)).toBeGreaterThanOrEqual(44);
    }
    // Notifications live behind the bell (UX-NOTIFY: it opens the panel as a full-screen sheet). Pip floats free by
    // default (owner, 20 Oct 2026): whole on the screen, between the header and the tab bar, covering neither.
    await expect(page.getByRole("button", { name: /^Notifications/ })).toBeVisible();
    const bar = (await page.locator("header").first().boundingBox())!, pipButton = page.getByRole("button", { name: /^Pip/ });
    // Pip may glide aside once the page settles (island.tsx re-checks its spot at 0, 0.7 and 2.2 s with a springy 420 ms
    // move): read it when it rests, not mid-move.
    let pip = (await pipButton.boundingBox())!;
    await expect.poll(async () => { await page.waitForTimeout(250); const now = (await pipButton.boundingBox())!; const still = Math.abs(now.x - pip.x) < 0.5 && Math.abs(now.y - pip.y) < 0.5; pip = now; return still; }, { timeout: 6000 }).toBe(true);
    const tabBar = (await page.getByRole("navigation", { name: "Mobile navigation" }).boundingBox())!;
    expect(pip.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1); expect(pip.y + pip.height).toBeLessThanOrEqual(tabBar.y + 1);
    expect(pip.x).toBeGreaterThanOrEqual(0); expect(pip.x + pip.width).toBeLessThanOrEqual(size.width + 1);
    // Owner workbench (21 Oct 2026): My desk has five tabs with icons instead of eight; every tab can be reached.
    const tabs = page.getByRole("navigation", { name: "My desk", exact: true });
    for (const name of [/^Today/, /^Time/, /^Growth/, /^Requests/, /^About me/]) {
      const tab = tabs.getByRole("link", { name });
      await tab.scrollIntoViewIfNeeded();
      await expect(tab).toBeInViewport();
    }
    // Capture the default page after proving the last section is reachable.
    await tabs.evaluate((el) => el.scrollTo({ left: 0 }));
    await expect(tabs.getByRole("link", { name: /^Today/ })).toBeInViewport();
    expect(await noSideways(page), `My desk fits ${size.width} ${theme}`).toBe(true);
    await page.screenshot({ path: `test-results/mobile-shell/me-${size.width}-${theme}.png` });
  }
});

test("weekly and ranked charts use facts for zero, one or two populated values", async ({ page }) => {
  test.setTimeout(60_000); // Sixteen full-page phone captures on the two-worker CI runner.
  await page.setExtraHTTPHeaders(admin);
  for (const size of PHONES) for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize(size);
    await page.addInitScript((t) => { localStorage.setItem("pulse.theme", t); }, theme);
    for (const populated of [0, 1, 2, 3]) {
      // Sparse-chart assertions exercise the retained legacy overview.
      await page.goto(`/dashboard?mode=max&tab=overview&week=2025-W0${populated + 1}`);
      const weekly = page.locator("section").filter({ has: page.getByRole("heading", { name: /^Deliveries per week/ }) }).last();
      const clients = page.locator("section").filter({ has: page.getByRole("heading", { name: /^Clients/ }) }).last();
      const pipeline = page.locator("section").filter({ has: page.getByRole("heading", { name: /^Project pipeline/ }) }).last();
      await expect(weekly).toBeVisible(); await expect(clients).toBeVisible();
      await expect(pipeline.getByRole("img")).toHaveCount(populated < 3 ? 0 : 1);
      if (populated < 3) {
        await expect(weekly.locator("[data-some]")).toHaveCount(0);
        await expect(clients.locator("ul")).toHaveCount(0);
        if (!populated) {
          await expect(weekly).toContainText("No deliveries in this period.");
          await expect(clients).toContainText("No deliveries in the last eight weeks.");
        } else {
          const facts = weekly.getByRole("group", { name: "Deliveries per week", exact: true });
          await expect(facts.locator("a")).toHaveCount(populated);
          await expect(facts.locator("a").first()).toHaveAttribute("href", /week=2024-W/);
          await expect(clients.getByRole("group", { name: "Counts by category" }).locator("a")).toHaveCount(populated);
          // A category ranking is a comparison, not a change over time.
          await expect(clients.getByText(/^Up |^Down /)).toHaveCount(0);
          if (populated === 2) await expect(facts).toContainText("Up 1 (+50%)");
        }
      } else {
        await expect(weekly.locator("[data-some]")).toHaveCount(3);
        await expect(clients.locator("ul > li")).toHaveCount(3);
      }
      expect(await noSideways(page)).toBe(true);
      await page.screenshot({ path: `test-results/mobile-shell/dashboard-${populated}-${size.width}-${theme}.png`, fullPage: true });
    }
  }
});

test("the leave request offers each leave type as one tap with what is free", async ({ page }) => {
  await page.setViewportSize(PHONES[1]); await page.setExtraHTTPHeaders(staff);
  await page.goto("/me?tab=leave");
  await page.getByRole("button", { name: "Apply for leave", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Apply for leave" });
  await expect(sheet.getByRole("group", { name: "Leave type" })).toBeVisible();
  await expect(sheet.locator("label", { has: page.locator("input[name=kind][value=annual]") })).toContainText(/Annual leave/);
  // UI-POLISH (R017, intended change): the days are the kit's DateField (a text field showing "24 Oct 2026").
  await expect(sheet.locator("label", { has: page.locator("input[name=fromDate]") }).locator("input[data-date-field]")).toBeVisible();
  await expect(sheet.locator("label", { has: page.locator("input[name=toDate]") }).locator("input[data-date-field]")).toBeVisible();
  // A bottom sheet on the phone: Android back (Escape) closes it.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});

test("inside the Pulse phone app: registers the phone after sign-in, follows the theme, Back closes sheets", async ({ browser, baseURL }) => {
  // The phone app's WebView: Android Chrome with "PulseShell/<version>" appended, and the shell's bridge.
  const context = await browser.newContext({ viewport: PHONES[1], isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 13; Redmi Note 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 PulseShell/1.1.0" });
  await context.addCookies([{ name: "pulse_session", value: "syntheticshellsession" + "x".repeat(30), url: baseURL! }]);
  const page = await context.newPage();
  await page.addInitScript(() => {
    const calls: [string, unknown][] = []; (window as unknown as { __shellCalls: typeof calls }).__shellCalls = calls;
    const answers: Record<string, unknown> = {
      info: { platform: "android", version: "1.1.0", build: 1001000, enrolled: false, deviceId: null, personId: null, notifications: false, pushReady: false, pushActive: false },
      startEnrollment: { code: "ABCD-EFGH", replaces: null }, finishEnrollment: { deviceId: "synthetic-phone" },
    };
    const plugin = new Proxy({}, { get: (_t, name: string) => async (arg?: unknown) => { calls.push([name, arg]); return answers[name] ?? {}; } });
    (window as unknown as { Capacitor: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => "android", Plugins: { PulseShell: plugin } };
  });
  const enrolled: unknown[] = [];
  await page.route("**/api/v0/native/shell/enroll", async (route) => { enrolled.push(route.request().postDataJSON()); await route.fulfill({ json: { status: "approved", deviceId: "synthetic-phone" } }); });
  await page.goto("/me");
  await expect(page.locator("html")).toHaveAttribute("data-shell", "android");
  await expect.poll(() => enrolled.length).toBe(1);
  expect(enrolled[0]).toEqual({ code: "ABCD-EFGH", replaces: null, expectedPersonId: "synthetic-sam" });
  const calls = () => page.evaluate(() => (window as unknown as { __shellCalls: [string, unknown][] }).__shellCalls.map((c) => c[0]));
  await expect.poll(calls).toEqual(expect.arrayContaining(["info", "startEnrollment", "finishEnrollment", "setTheme"]));
  // Interface text is not selectable inside the app; fields stay selectable.
  expect(await page.evaluate(() => getComputedStyle(document.body).userSelect)).toBe("none");
  // Android back closes an open sheet first (the shell asks the page before going back).
  await page.getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("dialog", { name: "All pages" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __pulseBack: () => boolean }).__pulseBack())).toBe(true);
  await expect(page.getByRole("dialog", { name: "All pages" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pulseBack: () => boolean }).__pulseBack())).toBe(false);
  // Settings → Devices starts with this phone.
  await page.goto("/settings?tab=devices");
  await expect(page.getByRole("heading", { name: "Pulse for Android" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn on notifications" })).toBeVisible();
  await context.close();
});

test("office helpers read sensors only on a tap after device consent, and never check in automatically", async ({ page }) => {
  await page.setViewportSize(PHONES[0]);
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "designer-a@estateautopilots.com" });
  await page.addInitScript(() => {
    const state = { consent: false, calls: [] as string[] };
    (window as unknown as { __presence: typeof state }).__presence = state;
    const office = { id: "synthetic-office", name: "Synthetic office", lat: 12, lng: 77, radius: 150, wifi: [{ ssid: "Synthetic WiFi", bssids: ["a4:2b:b0:11:22:33"] }] };
    const plugin = new Proxy({}, { get: (_target, name: string) => async (arg?: { enabled?: boolean }) => {
      state.calls.push(name);
      if (name === "presencePreferences") { if (typeof arg?.enabled === "boolean") state.consent = arg.enabled; return { enabled: state.consent, offices: [office], sites: [] }; }
      if (name === "info") return { platform: "android", enrolled: true, personId: "fixture", version: "1.1.0" };
      if (name === "requestPermissions") return { location: "granted" };
      if (name === "wifi") return { permission: "granted", ssid: "Synthetic WiFi", bssid: "a4:2b:b0:11:22:33" };
      if (name === "location") return { lat: 12, lng: 77, accuracy: 20, at: Date.now() };
      return {};
    } });
    (window as unknown as { Capacitor: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => "android", Plugins: { PulseShell: plugin } };
  });
  const checkins: string[] = [];
  await page.route("**/api/v0/attendance/check-in", route => { checkins.push(route.request().postData() ?? ""); return route.fulfill({ json: { ok: true } }); });
  await page.goto("/me");
  const reads = () => page.evaluate(() => (window as unknown as { __presence: { calls: string[] } }).__presence.calls.filter(c => ["requestPermissions", "wifi", "location"].includes(c)));
  await expect(page.getByRole("button", { name: "Check office Wi-Fi", exact: true })).toBeVisible();
  expect(await noSideways(page)).toBe(true);
  expect(await reads()).toEqual([]);
  await page.getByRole("button", { name: "Check office Wi-Fi", exact: true }).click();
  await expect(page.getByText("Turn on office check-in helpers for this phone first.")).toBeVisible();
  expect(await reads()).toEqual([]);
  await page.getByRole("link", { name: "This phone settings" }).click();
  await page.getByRole("checkbox", { name: "Allow office check-in helpers on this phone" }).check();
  await expect(page.getByText("Office helpers are on.", { exact: false })).toBeVisible();
  expect(await reads()).toEqual([]);
  await page.goto("/me");
  // Init scripts recreate a native stub on a full navigation; emulate the device's persisted server choice.
  await page.evaluate(() => { (window as unknown as { __presence: { consent: boolean } }).__presence.consent = true; });
  await page.getByRole("button", { name: "Check office Wi-Fi", exact: true }).click();
  await expect(page.getByText("Synthetic office Wi-Fi confirmed.", { exact: false })).toBeVisible();
  expect(await reads()).toEqual(["requestPermissions", "wifi"]);
  await page.getByRole("button", { name: "Check location", exact: true }).click();
  await expect(page.getByText("You are at Synthetic office.", { exact: false })).toBeVisible();
  expect(await reads()).toEqual(["requestPermissions", "wifi", "requestPermissions", "location"]);
  await page.evaluate(() => { (window as unknown as { __presence: { consent: boolean } }).__presence.consent = false; });
  await page.getByRole("button", { name: "Check location", exact: true }).click();
  await expect(page.getByText("Turn on office check-in helpers for this phone first.")).toBeVisible();
  expect(await reads()).toHaveLength(4);
  expect(checkins).toEqual([]);
});

test("signed-out pages send people to the sign-in page and back", async ({ request }) => {
  test.skip(!process.env.PULSE_PUBLIC_LOGIN_SMOKE, "Public sign-in mode only (the isolated public-login server)");
  const r = await request.get("/tasks?view=week", { maxRedirects: 0 });
  expect(r.status()).toBe(307);
  expect(r.headers().location).toBe("/login?next=%2Ftasks%3Fview%3Dweek");
});
