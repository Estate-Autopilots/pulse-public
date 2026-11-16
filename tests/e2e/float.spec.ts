import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// FLOAT (owner, 21 Oct 2026: "The Pip buttons and all floating things and all the notifications: all of that is ugly
// and not working"). Everything that floats is clicked for real here: Pip's one menu (every item does what it says),
// dragging Pip and its remembered spot, Pip stepping aside for a page's primary button and an open sheet, Pip above a
// phone's tab bar, messages one at a time (short, auto-dismissed, urgent ones stay), and the bell panel (needs you
// first, actionable rows, mark all read, settings, a failed load says so). Synthetic people and notices only.
test.skip(Boolean(process.env.PULSE_REAL_SMOKE), "synthetic notices on the isolated test server");

const admin = { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" };
const iso = (ms: number) => new Date(ms).toISOString();
const istDay = (ms: number) => iso(ms + 330 * 60_000).slice(0, 10);
const day = (person: string, patch: Record<string, unknown> = {}) => {
  const now = Date.now();
  return { attendanceEnabled: true, person: { id: person, name: "Synthetic Admin", firstName: "Synthetic" }, now: iso(now), today: istDay(now), clock: "12:00", timezone: "Asia/Kolkata",
    utcOffsetMinutes: 330, shift: { start: "00:01", end: "23:59", graceMinutes: 15, onTimeBy: "00:16", workingDay: true, mode: "office" }, shiftStartsAt: iso(now - 3_600_000),
    shiftEndsAt: iso(now + 3_600_000), state: "out", holiday: null, entry: null, nextShift: null, streak: { onTime: 0, firstCheckIn: false }, waiting: null,
    presence: { autoCheckIn: false, offices: [], sites: [] }, ...patch };
};
const someone = { id: "22222222-2222-4222-8222-222222222222", name: "Synthetic Colleague", photoAt: null };
const card = (id: string, title: string, priority: "urgent" | "needs_you" | "fyi", extra: Record<string, unknown> = {}) => ({
  id, ids: [id], kind: "task", eventType: "task.assigned", title, body: null, href: "/tasks", at: iso(Date.now() - 60_000), readAt: null, active: true,
  state: "open", group: priority === "fyi" ? "update" : "action", from: someone, subject: { type: "task", id, title }, open: { label: "Open", href: "/tasks" },
  actions: priority === "fyi" ? [] : [{ key: "accept", label: "Accept", tone: "primary", method: "POST", path: `/api/v0/synthetic/${id}/accept`, done: "It's yours" }], priority, ...extra });
const NOTICES = [card("n-urgent", "Approve Rifob's leave before payroll closes", "urgent"), card("n-need", "Kabir asks you to review the brochure", "needs_you"),
  card("n-fyi", "The Diwali messages project moved to Review", "fyi")];

type Wired = { posts: string[]; notices: { fail: boolean; rows: unknown[] } };
/** SHIP-4 (25 Oct): VISIBLE's Home panels (leadership's cards, "New in Pulse") reach Pip's corners, where Pip steps aside
 *  from their buttons or turns into the slim tab over their words, as designed, and fill the page with links. These specs
 *  test Pip, so they keep the Home they were written against: the panels are hidden before the page's own scripts run. */
const withoutHomePanels = (context: BrowserContext) => context.addInitScript(() => {
  const add = () => { if (!document.head) return false; const s = document.createElement("style"); s.textContent = "[data-lead-pulse], [data-whats-new] { display: none !important; }"; document.head.append(s); return true; };
  if (!add()) new MutationObserver((_, seen) => { if (add()) seen.disconnect(); }).observe(document, { childList: true, subtree: true });
});

async function wire(context: BrowserContext, person: string, opts: { rows?: unknown[]; day?: Record<string, unknown> } = {}): Promise<Wired> {
  await withoutHomePanels(context);
  const w: Wired = { posts: [], notices: { fail: false, rows: opts.rows ?? NOTICES } };
  const settings = { dnd: false, quiet: false, start: "21:00", end: "08:00", timezone: "UTC", types: {} };
  await context.route("**/api/v0/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname.replace("/api/v0/", "");
    if (req.method() === "POST" && /^(attendance\/|companion\/notification-settings|notices\/|synthetic\/)/.test(path)) {
      w.posts.push(`${path} ${req.postData() ?? ""}`);
      return route.fulfill({ json: path.startsWith("attendance/") ? { id: "synthetic-receipt" } : { ok: true } });
    }
    if (path === "companion") return route.fulfill({ json: day(person, opts.day) });
    if (path === "companion/updates") return route.fulfill({ json: { person: { id: person, name: "Synthetic Admin" }, settings, suppression: null, rows: [], counts: { chats: 0, inbox: 3, total: 3, important: 2 }, cursor: iso(Date.now()), hasMore: false, page: null } });
    if (path === "companion/notification-settings") return route.fulfill({ json: { settings, webPushKey: null } });
    if (path === "notices") {
      if (w.notices.fail) return route.fulfill({ status: 503, json: { error: "unavailable" } });
      const rows = w.notices.rows as { priority: string; readAt: string | null }[];
      return route.fulfill({ json: { rows, counts: { unread: rows.length, action: rows.filter((r) => r.priority !== "fyi").length, mention: 0, update: 1, important: rows.filter((r) => r.priority !== "fyi").length }, dnd: false, today: { due: 1, overdue: 0 } } });
    }
    return route.continue();
  });
  return w;
}

async function open(page: Page, path = "/dashboard") {
  await page.goto(path);
  await page.waitForFunction(() => { const b = document.querySelector("[data-island][data-home='free'] [data-pip]"); return !!b && Object.keys(b).some((k) => k.startsWith("__reactProps")); });
  await page.waitForTimeout(400);
}
const pip = (page: Page) => page.locator("[data-island] [data-pip]");
const box = async (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; });
const overlap = (a: { left: number; top: number; right: number; bottom: number }, b: typeof a) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
/** Every point of the element is what a click there reaches, and it is inside the window. */
const reachable = (page: Page, selector: string) => page.locator(selector).evaluateAll((els) => els.map((el) => {
  const r = el.getBoundingClientRect();
  const inside = r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  const onTop = [[.15, .5], [.5, .5], [.85, .5]].every(([x, y]) => { const hit = document.elementFromPoint(r.left + r.width * x, r.top + r.height * y); return !!hit && el.contains(hit); });
  return `${el.getAttribute("data-label")}: ${inside && onTop ? "ok" : !inside ? "outside the window" : "covered"}`;
}));

async function setup(browser: import("@playwright/test").Browser, request: import("@playwright/test").APIRequestContext, viewport = { width: 1440, height: 900 }, opts: { rows?: unknown[]; touch?: boolean; day?: Record<string, unknown> } = {}) {
  const person = (await (await request.get("/api/v0/hr/self", { headers: admin })).json()).person.id as string;
  const context = await browser.newContext({ viewport, extraHTTPHeaders: admin, hasTouch: !!opts.touch, isMobile: !!opts.touch });
  const wired = await wire(context, person, opts);
  const page = await context.newPage();
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  return { context, page, wired, errors };
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const phone = viewport.width < 600;
  test(`Pip's menu names every item, each on top and inside the window, and each one works (${viewport.width})`, async ({ browser, request }) => {
    test.setTimeout(180_000);
    const { context, page, wired, errors } = await setup(browser, request, viewport, { touch: phone });
    await open(page);
    // Pip is a calm round button in its corner (never the old 96 px character).
    const b = await box(page, "[data-island] [data-pip]");
    expect(b.right - b.left).toBeLessThanOrEqual(60);
    expect(viewport.width - b.right).toBeLessThan(40);
    await pip(page).click();
    const menu = page.getByRole("menu", { name: "Pip" });
    await expect(menu).toBeVisible();
    // One clear menu: the day's own button, what needs you, notifications, Ask Pip, quick create, Pip's settings.
    // FLOAT-2: with the top bar's check-in chip on screen the menu leaves the check-in button to it (one ask, not three).
    const chip = await page.locator("[data-shell-actions] [data-checkin-chip]").evaluateAll((els) => els.some((el) => el.getBoundingClientRect().width > 0));
    await expect(menu.getByRole("menuitem", { name: /^Check in/ })).toHaveCount(chip ? 0 : 1);
    for (const name of ["Approve Rifob's leave", "Kabir asks you to review", "Notifications", "Ask Pip", "New task", "New project", "Tuck Pip away", "Put Pip in the top bar"])
      await expect(menu.getByRole("menuitem", { name: new RegExp(`^${name}`) })).toBeVisible();
    await expect(menu.getByRole("menuitemcheckbox", { name: /Do not disturb/ })).toHaveAttribute("aria-checked", "false");
    // FYI is not "needs you".
    await expect(menu.getByRole("menuitem", { name: /Diwali/ })).toHaveCount(0);
    expect((await reachable(page, "[data-island] [role=menu] [role^=menuitem]")).filter((x) => !x.endsWith("ok"))).toEqual([]);

    const item = async (name: RegExp, role: "menuitem" | "menuitemcheckbox" = "menuitem") => {
      await open(page);
      await pip(page).click();
      await page.getByRole("menu", { name: "Pip" }).getByRole(role, { name }).click();
    };
    if (chip) { await open(page); await page.locator("[data-shell-actions] [data-checkin-chip] button").first().click(); }
    else await item(/^Check in/);
    await expect.poll(() => wired.posts.some((p) => p.startsWith("attendance/check-in"))).toBe(true);
    await item(/^Approve Rifob's leave/);
    const panel = page.getByRole("dialog", { name: "Notifications" });
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-id='n-urgent'] button").first()).toBeFocused();
    await item(/^Notifications/);
    await expect(panel).toBeVisible();
    await item(/^Ask Pip/);
    await expect(page.getByRole("dialog", { name: "Insights and actions" })).toBeVisible();
    await item(/^New task/);
    await expect(page.getByRole("dialog", { name: /New task/ })).toBeVisible();
    await item(/^New project/);
    await expect(page.getByRole("dialog", { name: /New project/ })).toBeVisible();
    await item(/Do not disturb/, "menuitemcheckbox");
    await expect.poll(() => wired.posts.find((p) => p.startsWith("companion/notification-settings"))).toContain('"dnd":true');
    await item(/^Tuck Pip away/);
    await expect(page.locator("[data-island][data-tucked]")).toHaveCount(1);
    // It slides half out past the right edge.
    await expect.poll(async () => (await box(page, "[data-island] [data-pip]")).right).toBeGreaterThan(viewport.width + 10);
    await pip(page).click();
    await expect(page.locator("[data-island][data-tucked]")).toHaveCount(0);
    await item(/^Put Pip in the top bar/);
    await expect(page.locator("header [data-island]")).toHaveCount(1);
    await expect(page.locator("[data-island][data-home='free']")).toHaveCount(0);
    expect(errors).toEqual([]);
    await context.close();
  });
}

test("Pip is dragged out of the way and remembers the spot; it steps aside for the page's primary button and an open sheet", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const { context, page, errors } = await setup(browser, request);
  await open(page);
  const start = await box(page, "[data-island] [data-pip]");
  await page.mouse.move(start.left + 28, start.top + 28);
  await page.mouse.down();
  await page.mouse.move(700, 560, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole("menu", { name: "Pip" })).toHaveCount(0);
  // UI-UPGRADE R067 (5404af05, intended): a dropped Pip settles into the nearer bottom corner of the page, not where it
  // fell (700 px of 1440 is the left half). Wait until it rests there; after a reload it must be in the same spot.
  const view = page.viewportSize()!;
  let dropped = await box(page, "[data-island] [data-pip]");
  await expect.poll(async () => {
    const now = await box(page, "[data-island] [data-pip]"), still = Math.abs(now.left - dropped.left) + Math.abs(now.top - dropped.top) < 1;
    dropped = now;
    return still && now.right < view.width / 2 && now.bottom > view.height - 120;
  }, { timeout: 4000 }).toBe(true);
  await page.reload();
  await open(page);
  const again = await box(page, "[data-island] [data-pip]");
  expect(Math.abs(again.left - dropped.left)).toBeLessThan(4);
  expect(Math.abs(again.top - dropped.top)).toBeLessThan(4);

  // The page puts its primary button where Pip is: Pip slides off it, and back when it is gone.
  await page.mouse.move(10, 450);
  await page.evaluate(({ x, y }) => {
    const b = document.createElement("button"); b.id = "synthetic-primary"; b.className = "synthetic-primary"; b.textContent = "Save";
    Object.assign(b.style, { position: "fixed", left: `${x - 30}px`, top: `${y - 4}px`, width: "120px", height: "44px", zIndex: "5" });
    document.querySelector("main")!.append(b);
  }, { x: again.left, y: again.top });
  await expect.poll(async () => overlap(await box(page, "[data-island] [data-pip]"), await box(page, "#synthetic-primary")), { timeout: 4000 }).toBe(false);
  expect(await page.evaluate(() => { const b = document.getElementById("synthetic-primary")!.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return hit?.id; })).toBe("synthetic-primary");
  await page.evaluate(() => document.getElementById("synthetic-primary")!.remove());
  await expect.poll(async () => Math.abs((await box(page, "[data-island] [data-pip]")).left - again.left), { timeout: 4000 }).toBeLessThan(4);

  // The notifications panel opens over Pip's corner: Pip moves clear of it.
  await page.evaluate(() => localStorage.removeItem("pulse.pip.pos"));
  await page.reload(); await open(page);
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const panel = page.getByRole("dialog", { name: "Notifications" });
  await expect(panel).toBeVisible();
  await page.mouse.move(10, 450);
  await expect.poll(async () => overlap(await box(page, "[data-island] [data-pip]"), await box(page, "#pulse-notices")), { timeout: 4000 }).toBe(false);
  expect(errors).toEqual([]);
  await context.close();
});

test("on a phone Pip sits above the tab bar, and its menu stays inside the window", async ({ browser, request }) => {
  const { context, page } = await setup(browser, request, { width: 390, height: 844 }, { touch: true });
  await open(page);
  const p = await box(page, "[data-island] [data-pip]");
  const tabs = await box(page, "nav[aria-label='Mobile navigation']");
  expect(p.bottom).toBeLessThanOrEqual(tabs.top - 8);
  await pip(page).tap();
  const m = await box(page, "[data-island] [role=menu]");
  expect(m.top).toBeGreaterThanOrEqual(0);
  expect(m.left).toBeGreaterThanOrEqual(0);
  expect(m.right).toBeLessThanOrEqual(390);
  expect(overlap(m, tabs)).toBe(false);
  await context.close();
});

test("messages come one at a time, short, with one action; they settle by themselves, an urgent one waits", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const { context, page, wired } = await setup(browser, request);
  await open(page);
  // Three arrivals at once, as the poll reports them: one shows, the others wait their turn.
  wired.notices.rows = [card("a1", "First synthetic update about a task that has a rather long title to see it stay short", "fyi"), card("a2", "Second synthetic update", "fyi"), card("a3", "Third synthetic update", "fyi")];
  await page.evaluate(() => { for (const id of ["a1", "a2", "a3"]) window.dispatchEvent(new CustomEvent("pulse:arrival", { detail: { id, title: id, href: "/tasks" } })); });
  const bubble = page.locator("[data-island][data-open] [data-island-content]");
  await expect(bubble).toBeVisible();
  await expect(bubble).toContainText("First synthetic update");
  expect(await page.locator("[data-island][data-open]").count()).toBe(1);
  const b = await box(page, "[data-island][data-open] [data-island-content]");
  expect(b.bottom - b.top).toBeLessThan(90);
  expect(b.right).toBeLessThanOrEqual(1440); expect(b.left).toBeGreaterThanOrEqual(0);
  await expect(bubble.getByRole("button", { name: "Open" })).toBeVisible();
  // It settles back by itself (about five seconds), then the next one.
  await page.mouse.move(10, 450);
  await expect(bubble).toContainText("Second synthetic update", { timeout: 9000 });
  await bubble.getByRole("button", { name: "Dismiss" }).click();
  await expect(bubble).toContainText("Third synthetic update", { timeout: 4000 });
  await bubble.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator("[data-island][data-open]")).toHaveCount(0, { timeout: 4000 });

  // Urgent: it stays until it is answered or dismissed.
  wired.notices.rows = [card("u1", "Payroll closes in an hour: approve the last leave", "urgent")];
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("pulse:arrival", { detail: { id: "u1", title: "u1", href: "/tasks" } })));
  await expect(bubble).toContainText("Payroll closes in an hour");
  await expect(page.locator("[data-island][data-urgent]")).toHaveCount(1);
  await page.waitForTimeout(8000);
  await expect(bubble).toContainText("Payroll closes in an hour");
  await bubble.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator("[data-island][data-open]")).toHaveCount(0);

  // The page's own button sits just above Pip: the message opens beside Pip instead, covering nothing.
  const p = await box(page, "[data-island] [data-pip]");
  await page.evaluate(({ x, y }) => {
    const b = document.createElement("button"); b.id = "synthetic-primary"; b.className = "synthetic-primary"; b.textContent = "Check";
    Object.assign(b.style, { position: "fixed", left: `${x - 200}px`, top: `${y - 70}px`, width: "250px", height: "44px", zIndex: "5" });
    document.querySelector("main")!.append(b);
  }, { x: p.left, y: p.top });
  wired.notices.rows = [card("b1", "A synthetic update while the page's button is near", "fyi")];
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("pulse:arrival", { detail: { id: "b1", title: "b1", href: "/tasks" } })));
  await expect(bubble).toContainText("A synthetic update");
  await page.waitForTimeout(500);
  expect(overlap(await box(page, "[data-island][data-open] [data-island-content]"), await box(page, "#synthetic-primary"))).toBe(false);
  await expect(page.locator("[data-island][data-msg='beside']")).toHaveCount(1);
  await context.close();
});

test("the bell panel: needs you first, every row actionable, mark all read, settings, and a failed load says so", async ({ browser, request }) => {
  const { context, page, wired } = await setup(browser, request);
  await open(page);
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const panel = page.getByRole("dialog", { name: "Notifications" });
  await expect(panel).toBeVisible();
  // The panel opens before its rows arrive: wait for the three sections, then read their order.
  await expect(panel.locator("section h3")).toHaveCount(3);
  expect(await panel.locator("section h3").evaluateAll((hs) => hs.map((h) => h.firstChild?.textContent))).toEqual(["Urgent", "Needs your action", "For your information"]);
  // Each row opens its subject, and a request has its own answer right there.
  for (const id of ["n-urgent", "n-need", "n-fyi"]) await expect(panel.locator(`[data-id='${id}'] a`).first()).toBeVisible();
  await panel.locator("[data-id='n-need']").getByRole("button", { name: "Accept" }).click();
  await expect(panel.locator("[data-id='n-need']")).toContainText("It's yours");
  await panel.getByRole("button", { name: "Mark all read" }).click();
  await expect.poll(() => wired.posts.some((p) => p.startsWith("notices/read-all"))).toBe(true);
  const settings = panel.getByRole("link", { name: "Notification settings" });
  await expect(settings).toBeVisible();
  await expect(settings).toHaveAttribute("href", "/notifications#ping-settings");
  await expect(settings).toContainText("Settings");
  await panel.getByRole("button", { name: "Close notifications" }).click();

  // Pulse cannot be reached: the panel says so, and Try again reads again.
  wired.notices.fail = true;
  await page.reload(); await open(page);
  await page.getByRole("button", { name: /^Notifications/ }).click();
  await expect(panel.getByRole("alert")).toContainText("Notifications did not load");
  wired.notices.fail = false;
  await panel.getByRole("button", { name: "Try again" }).click();
  await expect(panel.locator("[data-id='n-urgent']")).toBeVisible();
  await context.close();
});

// The audit as a team member (no admin pages, their own day and requests): every floating thing at rest and open, on a
// computer and a phone, light and dark; none of them covers another, the tab bar or the page's own buttons.
// FLOAT_SHOTS=<dir> keeps the screenshots (the report's member shots).
for (const [width, height] of [[1440, 900], [390, 844]]) for (const theme of ["light", "dark"] as const) {
  test(`a team member's floating things do not cover each other or the page (${width}, ${theme})`, async ({ browser, request }, info) => {
    test.setTimeout(120_000);
    const member = { "Cf-Access-Authenticated-User-Email": "editor@estateautopilots.com" };
    const person = (await (await request.get("/api/v0/me", { headers: member })).json()).person as string;
    const phone = width < 600;
    const context = await browser.newContext({ viewport: { width, height }, extraHTTPHeaders: member, colorScheme: theme, hasTouch: phone, isMobile: phone });
    await context.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); } catch { /* private mode */ } }, theme);
    await wire(context, person);
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    const shot = async (state: string) => { const dir = process.env.FLOAT_SHOTS; await page.screenshot({ path: dir ? `${dir}/member-${width}-${theme}-${state}.png` : info.outputPath(`${state}.png`) }); };
    const clashes = () => page.evaluate(() => {
      const vis = (el: Element | null) => { if (!el) return null; const c = getComputedStyle(el); if (c.visibility === "hidden" || c.display === "none") return null; const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 ? r : null; };
      const things: [string, DOMRect | null][] = [["Pip", vis(document.querySelector("[data-island][data-home='free'] [data-pip]"))], ["Pip's menu", vis(document.querySelector("[data-island] [role=menu]"))],
        ["Pip's message", vis(document.querySelector("[data-island][data-open] [data-island-content]"))], ["companion", vis(document.querySelector("[aria-label='Task companion']"))],
        ["notice banner", vis(document.querySelector("[aria-label='Notifications are off'], .ask"))]];
      const tabs = vis(document.querySelector("nav[aria-label='Mobile navigation']"));
      const own = [...document.querySelectorAll("main [data-page-header] :is(button, a[href])")].map((el) => [el.textContent?.trim() ?? "", vis(el)] as const).filter(([, r]) => r);
      const hit = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      const out: string[] = [];
      for (const [n, r] of things) if (r) {
        if (tabs && hit(r, tabs)) out.push(`${n} covers the tab bar`);
        // An open menu is a popover the person asked for: it may lie over the page for as long as it is open.
        if (n !== "Pip's menu") for (const [label, o] of own) if (hit(r, o!)) out.push(`${n} covers the page's ${label}`);
        for (const [m, q] of things) if (q && m !== n && n < m && !(n.startsWith("Pip") && m.startsWith("Pip"))) { if (hit(r, q)) out.push(`${n} overlaps ${m}`); }
        if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) out.push(`${n} leaves the window`);
      }
      return out;
    });
    await open(page, "/me");
    await shot("rest");
    expect(await clashes()).toEqual([]);
    await pip(page).click();
    await expect(page.getByRole("menu", { name: "Pip" })).toBeVisible();
    await shot("pip-menu");
    expect(await clashes()).toEqual([]);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Notifications/ }).first().click();
    await expect(page.getByRole("dialog", { name: "Notifications" })).toBeVisible();
    await shot("bell");
    await page.getByRole("button", { name: "Close notifications" }).click();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("pulse:arrival", { detail: { id: "n-need", title: "n-need", href: "/tasks" } })));
    await expect(page.locator("[data-island][data-open]")).toHaveCount(1);
    await shot("message");
    expect(await clashes()).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  });
}

test("the check-in menu opens under the chip and inside the window on a phone's calm home (it opened half off screen)", async ({ browser, request }) => {
  const now = Date.now();
  const { context, page } = await setup(browser, request, { width: 390, height: 844 }, { touch: true, day: { state: "in",
    entry: { id: "synthetic-entry", date: istDay(now), in: iso(now - 2 * 3_600_000), out: null, mode: "office", late: 0, onBreak: false, breakStartedAt: null, closedBreakSeconds: 0 } } });
  await open(page);
  const chip = page.locator("[data-shell-actions] button[data-state='in']");
  await chip.tap();
  const menu = page.getByRole("dialog", { name: "Today’s attendance" });
  await expect(menu).toBeVisible();
  const m = await box(page, "[data-checkin-menu]"), c = await box(page, "[data-shell-actions] button[data-state='in']");
  expect(m.left).toBeGreaterThanOrEqual(0); expect(m.right).toBeLessThanOrEqual(390); expect(m.top).toBeGreaterThanOrEqual(c.bottom);
  // Its buttons are the ones a tap reaches.
  await expect(menu.getByRole("button", { name: "Check out" })).toBeVisible();
  expect(await menu.getByRole("button", { name: "Check out" }).evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); })).toBe(true);
  // A tap on the page outside it (a spot with nothing to press) closes it.
  const spot = await page.evaluate(() => { const m = document.querySelector("[data-checkin-menu]")!.getBoundingClientRect();
    for (let y = m.bottom + 20; y < innerHeight - 120; y += 17) for (let x = 20; x < innerWidth - 20; x += 23) { const e = document.elementFromPoint(x, y);
      if (e && !e.closest("a, button, input, [role=button], [tabindex], [data-island]")) return { x, y }; } return null; });
  expect(spot).not.toBeNull();
  await page.touchscreen.tap(spot!.x, spot!.y);
  await expect(menu).toHaveCount(0);
  await context.close();
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`Pip put in the top bar stays visible on the calm home and its menu opens inside the window, as a card (${viewport.width})`, async ({ browser, request }) => {
    const { context, page, errors } = await setup(browser, request, viewport, { touch: viewport.width < 600 });
    await context.addInitScript(() => { try { localStorage.setItem("pulse.pip.dock", "1"); } catch { /* private mode */ } });
    await page.goto("/dashboard");
    // It vanished there: the calm home hid everything carrying data-home, Pip included.
    const docked = page.locator("header [data-island] [data-pip]");
    await expect(docked).toBeVisible();
    await page.waitForFunction(() => { const b = document.querySelector("header [data-island] [data-pip]"); return !!b && Object.keys(b).some((k) => k.startsWith("__reactProps")); });
    await docked.click();
    const menu = page.getByRole("menu", { name: "Pip" });
    await expect(menu).toBeVisible();
    const m = await box(page, "[data-island] [role=menu]");
    expect(m.left).toBeGreaterThanOrEqual(0); expect(m.right).toBeLessThanOrEqual(viewport.width); expect(m.top).toBeGreaterThan(0);
    // A card the page never shows through.
    expect(await menu.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(/rgba?\(0, 0, 0, 0\)|transparent/);
    expect((await reachable(page, "[data-island] [role=menu] [role^=menuitem]")).filter((x) => !x.endsWith("ok"))).toEqual([]);
    await menu.getByRole("menuitem", { name: /^Let Pip float free/ }).click();
    await expect(page.locator("[data-island][data-home='free']")).toHaveCount(1);
    expect(errors).toEqual([]);
    await context.close();
  });
}
