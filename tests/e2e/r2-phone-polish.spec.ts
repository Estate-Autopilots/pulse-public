import { expect, test, type Route } from "@playwright/test";

// R2 Phone polish (EST-1199..1205), on a phone against the synthetic test server. Synthetic persona and data only.
test.skip(Boolean(process.env.PULSE_REAL_SMOKE), "Isolated synthetic browser adapters only");
const admin = { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" };
const PHONE = { width: 390, height: 844 };
const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const chats = () => ({
  channels: [
    { id: "33333333-3333-4333-8333-333333333333", name: "Synthetic Leadership", kind: "team", description: "Your team", address: null, unread: 1, members: 6, lastAt: at(3), preview: "Plan for Monday is in the doc", previewAuthor: "Synthetic Rila" },
    { id: "44444444-4444-4444-8444-444444444444", name: "Synthetic Rila", kind: "direct", description: "", address: null, unread: 0, members: 2, lastAt: at(9), peerId: "synthetic-rila", preview: "See you at 10" },
  ],
  viewer: "synthetic-admin", canModerate: false, retentionDays: 365,
  people: [{ id: "synthetic-admin", name: "Synthetic Admin", username: "admin" }, { id: "synthetic-rila", name: "Synthetic Rila", username: "rila", team: "Leadership" }],
});

// EST-1204: with the server failing, Chats used to stay on "Loading your chats" for good.
test("Chats with nothing cached says it is reconnecting, and Try now brings the list", async ({ browser }) => {
  test.setTimeout(60_000); // a busy server may take most of it before the page itself shows
  const context = await browser.newContext({ viewport: PHONE, extraHTTPHeaders: admin });
  let up = false, reads = 0;
  await context.route("**/api/v0/chats/events", (route) => route.abort());
  await context.route("**/api/v0/chats", (route) => { reads++; return up ? route.fulfill({ json: chats() }) : route.fulfill({ status: 503, json: { error: "Synthetic outage canary" } }); });
  const page = await context.newPage();
  await page.goto("/chats");
  // The loading view asks nothing and says the same after 8 s; on a slow server the page then replaces it. Act on the
  // page itself: it has asked once (and failed) before its alert counts.
  await expect.poll(() => reads, { timeout: 25_000 }).toBeGreaterThanOrEqual(1);
  // 23 Oct (Chats never spin for good): the list asks again by itself and says so in one calm line with Try now.
  const alert = page.getByRole("status").filter({ hasText: "Reconnecting… your chats show here as soon as Pulse answers." });
  await expect(alert).toBeVisible({ timeout: 9_000 });
  await expect(page.getByText("Synthetic outage canary")).toHaveCount(0);
  const before = reads; up = true;
  await alert.getByRole("button", { name: "Try now" }).click();
  await expect(page.getByRole("button", { name: /Synthetic Rila/ }).first()).toBeVisible();
  await expect(alert).toHaveCount(0);
  expect(reads - before).toBeGreaterThanOrEqual(1); // the 15 s fallback poll may also have asked
  await context.close();
});

test("Chats with a cached list shows it while Pulse is unreachable, with Retry", async ({ browser }) => {
  const context = await browser.newContext({ viewport: PHONE, extraHTTPHeaders: admin });
  let up = true;
  await context.route("**/api/v0/chats/events", (route) => route.abort());
  await context.route("**/api/v0/chats", (route) => up ? route.fulfill({ json: chats() }) : route.fulfill({ status: 503, json: { error: "Pulse data is temporarily unavailable" } }));
  const page = await context.newPage();
  await page.goto("/chats");
  await expect(page.getByRole("button", { name: /Synthetic Rila/ }).first()).toBeVisible();
  await page.waitForTimeout(600); // the cache is written 400 ms after a change
  up = false;
  await page.reload();
  await expect(page.getByRole("button", { name: /Synthetic Rila/ }).first()).toBeVisible();
  await expect(page.getByRole("alert").getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 9_000 });
  await context.close();
});

// EST-1205: a page reached from a menu is named in the top bar (it said "Dashboard" and marked it current).
test("Connect a Pulse app is named in the phone's top bar, and Home is not marked current", async ({ browser }) => {
  const context = await browser.newContext({ viewport: PHONE, extraHTTPHeaders: admin });
  const page = await context.newPage();
  await page.goto("/connect");
  await expect(page.locator('header[class*="topBar"] h1')).toHaveText("Connect a Pulse app");
  await expect(page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("link", { name: "Home (Dashboard)", exact: true })).not.toHaveAttribute("aria-current", "page");
  await context.close();
});

// EST-1205: Settings has one permissions entry, "Who can do what", holding the work rules and the roles; the old
// ?tab=roles link still opens the roles.
test("Settings shows one permissions entry and the old roles link opens its roles", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: admin });
  const page = await context.newPage();
  await page.goto("/settings?tab=work-rules");
  const tabs = page.getByRole("main").getByRole("navigation", { name: "Sections" });
  await expect(tabs.getByRole("link", { name: "Who can do what", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(tabs.getByRole("link", { name: "Roles & permissions" })).toHaveCount(0);
  const views = page.getByRole("main").getByRole("navigation", { name: "Views" });
  await expect(views.getByRole("button", { name: "Work rules", exact: true })).toHaveAttribute("aria-current", "true");
  await page.goto("/settings?tab=roles");
  await expect(tabs.getByRole("link", { name: "Who can do what", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(views.getByRole("button", { name: "Roles & permissions", exact: true })).toHaveAttribute("aria-current", "true");
  await context.close();
});

// EST-1205: a phone's top bar keeps the page title whole while reviews wait (the Reviews chip squeezed it to "Set…").
test("A phone's top bar shows the whole page title while reviews wait; a computer keeps the Reviews chip", async ({ browser }) => {
  const reviews = (route: Route) => route.fulfill({ json: { n: 12, oldestHours: 30 } });
  for (const viewport of [{ width: 360, height: 800 }, PHONE]) {
    const context = await browser.newContext({ viewport, extraHTTPHeaders: admin });
    await context.route("**/api/v0/tasks/reviews/count", reviews);
    const page = await context.newPage();
    await page.goto("/settings");
    const title = page.locator('header[class*="topBar"] h1');
    await expect(title).toHaveText("Settings");
    await expect(page.getByRole("link", { name: /waiting for your review/ })).toHaveCount(0);
    expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: admin });
  await context.route("**/api/v0/tasks/reviews/count", reviews);
  const page = await context.newPage();
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: "12 finished tasks waiting for your review" })).toBeVisible();
  await context.close();
});
