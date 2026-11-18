import { expect, test } from "@playwright/test";

// SIGNED-OUT-SHELL (62871651, 4 Nov 2026): a visit with no identity goes to the sign-in page, as it should. The shell
// checks below were written when an anonymous load still drew the frame; they visit as the synthetic admin instead.
const admin = { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" };

test("release tooltips wait for a resting pointer and stay on one line", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setExtraHTTPHeaders(admin);
  await page.addInitScript(() => localStorage.setItem("pulse.sidebar.collapsed", "false"));
  const items = ["/people", "/tasks/projects"].flatMap((route) => Array.from({ length: 6 }, (_, i) => ({
    note: 1, route, anchor: `synthetic-change-${i}`,
    text: "A longer release summary that should still fit on one short line for navigation",
    headline: "Synthetic release", releasedAt: "2030-01-01T00:00:00Z",
  })));
  await page.route("**/api/v0/whats-new/unseen", (route) => route.fulfill({ json: { on: true, count: 12, items } }));
  await page.clock.install({ time: new Date("2030-01-01T00:00:00Z") });
  await page.goto("/tasks");
  const rail = page.getByRole("navigation", { name: "Main sections" });
  const people = rail.locator('[data-nav-id="rail:people"]');
  const work = rail.locator('[data-nav-id="rail:work"]');
  await expect(people).toHaveAccessibleName("People, New");
  await page.clock.pauseAt(new Date("2030-01-01T00:05:00Z"));
  const tooltip = page.locator('.sidebar-tooltip-panel[role="tooltip"]');
  await people.hover();
  await page.clock.runFor(299);
  await expect(tooltip).toHaveCount(0);
  await work.hover();
  await page.clock.runFor(299);
  await expect(tooltip).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(tooltip).toBeVisible();
  const text = await tooltip.textContent();
  expect(text!.length).toBeLessThanOrEqual(72);
  expect(text).toMatch(/^New in Work: .* \+5 more$/);
  const dimensions = await tooltip.locator('.sidebar-tooltip-content').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    return { height: rect.height, lineHeight: parseFloat(getComputedStyle(element).lineHeight),
      lines: range.getClientRects().length, right: rect.right, viewport: window.innerWidth };
  });
  expect(dimensions.lines).toBe(1);
  expect(dimensions.height).toBeLessThanOrEqual(dimensions.lineHeight + 1);
  expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport);
  await page.mouse.move(1000, 700);
  await expect(tooltip).toHaveCount(0);
  // Keyboard users still receive the description immediately.
  await people.focus();
  await expect(tooltip).toHaveText(/^New in People:/);
  await expect(people).toHaveAttribute("aria-describedby", await tooltip.getAttribute("id") ?? "");
});

test("desktop Chats rail shows new unread messages and clears when read on the people page", async ({ page }) => {
  // IA-NAV / FIX-CHAT-AI (9–10 Nov 2026): the rail's chat group is Messages (Chats and Calls inside it); its unread count is the same.
  await page.setViewportSize({ width: 1536, height: 730 });
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" });
  await page.addInitScript(() => {
    localStorage.setItem("pulse.theme", "dark");
    localStorage.setItem("pulse.sidebar.collapsed", "false");
  });
  let unread = 0;
  await page.route(/\/api\/v0\/companion\/updates(?:\?.*)?$/, async (route) => {
    await route.fulfill({ json: {
      rows: [], counts: { chats: unread, inbox: 4, total: unread + 4 },
      cursor: new Date().toISOString(), page: null, hasMore: false,
    } });
  });
  await page.goto("/people");
  const chats = page.getByRole("navigation", { name: "Main sections" }).locator('a[href="/chats"]');
  const badge = chats.locator("i");
  await expect(page.getByRole("button", { name: "Notifications, 4 unread", exact: true })).toBeVisible();
  await expect(chats).toHaveAccessibleName("Messages");
  await expect(badge).toHaveCount(0); // Other notifications do not count as unread chats.
  for (const collapsed of [false, true]) {
    if (collapsed) await page.getByRole("button", { name: "Collapse sidebar navigation" }).click();
    for (const count of [3, 7, 120, 0]) {
      unread = count;
      await page.evaluate(() => window.dispatchEvent(new Event("pulse:poll-now")));
      await expect(chats).toHaveAccessibleName(count ? `Messages, ${count} unread` : "Messages");
      if (count) {
        await expect(badge).toBeVisible();
        await expect(badge).toHaveText(count > 99 ? "99+" : String(count));
      } else {
        await expect(badge).toHaveCount(0);
      }
    }
  }
  await chats.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Messages");
});

for (const route of ["/", "/dashboard", "/my-week", "/leadership"]) {
  test(`web shell route ${route} renders`, async ({ page }) => {
    await page.setExtraHTTPHeaders(admin);
    const response = await page.goto(route);
    expect(response, `${route} should return a response`).not.toBeNull();
    expect(response!.status(), `${route} should load successfully`).toBeLessThan(400);
    await expect(page.locator("body")).not.toBeEmpty();
    await expect(page.getByRole("navigation", { name: "Main sections" })).toHaveCount(1);
    // EST-2093: the admin's /dashboard is the calm home (html[data-pulse-focus]), whose top bar has no breadcrumb.
    if (route === "/dashboard") await expect(page.locator("html")).toHaveAttribute("data-pulse-focus", /.*/);
    else await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveCount(1);
  });
}

test("Cloudflare Access identity and organisation owner role are shown in the account menu", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" });
  await page.goto("/");
  await expect(async () => { await page.getByRole("button", { name: "Open account menu" }).click(); await expect(page.getByText("admin@estateautopilots.com")).toBeVisible({ timeout: 1000 }); }).toPass();
  await expect(page.getByText("Organisation owner/admin").first()).toBeVisible();
});

test("HR navigation is everyone's pages plus the HR pages, never clients, money or admin, while admin keeps the full navigation", async ({ page }) => {
  // IA-NAV (9 Nov 2026): the rail holds the groups (Home, Work, Messages, Sales & clients, Money, People, Growth, AI, then
  // Settings at its foot) and the sidebar beside it folds each group open on its own head; My desk is a People page.
  await page.setViewportSize({ width: 1440, height: 900 });
  const rail = page.getByRole("navigation", { name: "Main sections" });
  const sidebar = page.getByRole("complementary", { name: "Pulse navigation" });
  const pagesOf = async (section: string) => {
    const head = sidebar.getByRole("button", { name: new RegExp(`^${section}(, New)?$`) });
    if (await head.getAttribute("aria-expanded") !== "true") await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true");
    return page.getByRole("navigation", { name: `${section} pages`, exact: true });
  };
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "hr@estateautopilots.com" });
  // CHAT-SHELL (22 Oct 2026): "/" opens Chats on a computer, and Chats keeps the panel aside; the panel is read on the
  // dashboard.
  await page.goto("/dashboard");
  // RELEASE-4: HR's own day, chats and the team were missing from its rail (the pages always opened for HR). Owner
  // workbench (21 Oct 2026): HR accounts get Work too.
  await expect(rail.getByRole("link")).toHaveCount(4);
  for (const [section, names] of [["Home", ["Dashboard"]], ["Work", ["Tasks"]], ["Messages", ["Chats"]], ["People", ["Team", "My desk", "HR desk", "Review data"]]] as const) {
    const list = await pagesOf(section);
    for (const name of names) await expect(list.getByRole("link", { name, exact: true })).toBeVisible();
  }
  for (const name of ["Sales & clients", "Clients", "Money", "Map", "Leadership", "Finance", "Billing", "Audit"]) await expect(sidebar.getByRole("link", { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
  for (const [route, name] of [["/hr-history", "HR desk"], ["/shifts", "HR desk"], ["/opshub", "Review data"]] as const) {
    await page.goto(route);
    await expect(rail.getByRole("link", { name: "People", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("navigation", { name: "People pages", exact: true }).getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page");
  }

  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" });
  await page.goto("/dashboard");
  await expect(rail.getByRole("link")).toHaveCount(8);
  // VISIBLE (25 Oct 2026): What's new and the product map are named in the panel; IA-NAV moved the rest into its groups.
  for (const [section, names] of [["Home", ["Dashboard", "What's new", "Learn Pulse"]], ["Work", ["Tasks", "Processes", "Runs", "Product map"]], ["Messages", ["Chats", "Calls"]],
    ["Sales & clients", ["Clients", "Contacts", "Leads", "Map", "Insights"]], ["Money", ["Finance", "Billing"]], ["People", ["Team", "My desk", "HR desk", "Leadership"]],
    ["Settings", ["Review data", "Audit"]]] as const) {
    const list = await pagesOf(section);
    for (const name of names) await expect(list.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "Settings", exact: true }).first()).toBeVisible();
});

test("the command palette opens from the ⌘K shortcut", async ({ page }) => {
  // Not "/": its redirect can land after the document started streaming and close the open palette (see below).
  await page.setExtraHTTPHeaders(admin);
  await page.goto("/dashboard");
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-theme"));
  // The shortcut is bound when the shell hydrates, which can be a moment after the theme is set.
  await expect(async () => { await page.keyboard.press("Control+k"); await expect(page.getByRole("dialog", { name: "Search Pulse" })).toBeVisible({ timeout: 1000 }); }).toPass();
  const palette = page.getByRole("dialog", { name: "Search Pulse" });
  // IA-NAV: "Projects" is one of Tasks' own words, so it ranks Tasks first; the page's whole name picks it.
  await palette.getByRole("combobox").fill("Client projects");
  const projects = palette.getByRole("option", { name: "Client projects", exact: true });
  await expect(projects).toBeVisible();
  await expect(projects).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  // KAZUK (60d4791c): Client projects opens Work → Projects.
  await expect(page).toHaveURL(/\/tasks\?view=projects$/);
  await expect(palette).toHaveCount(0);
});

test("the command palette keeps its query when records finish loading", async ({ page }) => {
  const records: Record<string, unknown> = {
    projects: { projects: [{ projectId: "synthetic-project", title: "Projects Record Sentinel", clientName: "Synthetic Client", location: "Pune" }] },
    clients: { clients: [] },
    contacts: { contacts: [] },
    people: { people: [] },
  };
  const paths = Object.keys(records);
  const requested = new Set<string>();
  const fulfilled = new Set<string>();
  let releaseResponses!: () => void;
  let resolveAllRequested!: () => void;
  let resolveAllFulfilled!: () => void;
  const responseGate = new Promise<void>((resolve) => { releaseResponses = resolve; });
  const allRequested = new Promise<void>((resolve) => { resolveAllRequested = resolve; });
  const allFulfilled = new Promise<void>((resolve) => { resolveAllFulfilled = resolve; });

  for (const [path, body] of Object.entries(records)) {
    await page.route(`**/api/v0/${path}`, async (route) => {
      requested.add(path);
      if (requested.size === paths.length) resolveAllRequested();
      await responseGate;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      fulfilled.add(path);
      if (fulfilled.size === paths.length) resolveAllFulfilled();
    });
  }

  try {
    // "/" redirects (to /chats or /dashboard) after the document has started streaming, so that navigation can land
    // while the palette is open and close it; open the page the redirect ends on.
    await page.setExtraHTTPHeaders(admin);
    await page.goto("/dashboard");
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-theme"));
    await expect(async () => { await page.keyboard.press("Control+k"); await expect(page.getByRole("dialog", { name: "Search Pulse" })).toBeVisible({ timeout: 1000 }); }).toPass();
    const palette = page.getByRole("dialog", { name: "Search Pulse" });
    const input = palette.getByRole("combobox");
    await allRequested;
    await input.fill("Projects");
    releaseResponses();
    await allFulfilled;

    await expect(palette.getByRole("option", { name: /Projects Record Sentinel/ })).toBeVisible();
    await expect(input).toHaveValue("Projects");
    // IA-NAV: "Projects" is one of Tasks' own words, so Tasks is the first answer, and it stays chosen when records arrive.
    await expect(palette.getByRole("option", { name: "Client projects", exact: true })).toBeVisible();
    const tasks = palette.getByRole("option", { name: "Tasks", exact: true });
    await expect(tasks).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/tasks(?:\?.*)?$/);
  } finally {
    releaseResponses();
  }
});

test("the shell theme toggle applies dark tokens", async ({ page }) => {
  // LAYOUT-SWEEP: one quiet header. The theme switch lives in the account menu at every width, wide windows included.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setExtraHTTPHeaders(admin);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Switch to dark mode" })).toBeHidden();
  await expect(async () => { await page.getByRole("button", { name: "Open account menu" }).click(); await expect(page.getByRole("menuitem", { name: "Switch to dark mode" })).toBeVisible({ timeout: 1000 }); }).toPass();
  await page.getByRole("menuitem", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("at laptop widths the theme switch is in the account menu and applies dark tokens", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setExtraHTTPHeaders(admin);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Switch to dark mode" })).toBeHidden();
  // "/" redirects to Chats after the first paint, which can close a menu opened before it; open it again until it stays.
  await expect(async () => { await page.getByRole("button", { name: "Open account menu" }).click(); await expect(page.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: "Switch to dark mode" })).toBeVisible({ timeout: 1000 }); }).toPass();
  await page.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});


test("offline status appears without losing the open Pulse shell", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  await page.goto("/dashboard");
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-theme"));
  await page.context().setOffline(true);
  await expect(async () => { await page.evaluate(() => window.dispatchEvent(new Event("offline"))); await expect(page.getByRole("status", { name: "Offline status" })).toBeVisible({ timeout: 1000 }); }).toPass();
  // EST-2093: the admin's /dashboard is the calm home, which has no breadcrumb; the shell is its rail and its page.
  await expect(page.getByRole("navigation", { name: "Main sections" })).toHaveCount(1);
  await expect(page.locator("#main-content")).toHaveCount(1);
});
