import { expect, test } from "@playwright/test";

for (const route of ["/", "/dashboard", "/my-week", "/leadership"]) {
  test(`web shell route ${route} renders`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response, `${route} should return a response`).not.toBeNull();
    expect(response!.status(), `${route} should load successfully`).toBeLessThan(400);
    await expect(page.locator("body")).not.toBeEmpty();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveCount(1);
  });
}

test("Cloudflare Access identity and organisation owner role are shown in the account menu", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" });
  await page.goto("/");
  await expect(async () => { await page.getByRole("button", { name: "Open account menu" }).click(); await expect(page.getByText("admin@estateautopilots.com")).toBeVisible({ timeout: 1000 }); }).toPass();
  await expect(page.getByText("Organisation owner/admin").first()).toBeVisible();
});

test("HR navigation is everyone's pages plus the HR pages, never clients, money or admin, while admin keeps the full navigation", async ({ page }) => {
  // Owner workbench (21 Oct 2026): the rail holds sections (Home, Work, Chats, Clients, People, Money, then Settings) and
  // the panel beside it lists the shown section's pages; pointing at a section shows its pages there.
  await page.setViewportSize({ width: 1440, height: 900 });
  const rail = page.getByRole("navigation", { name: "Main sections" });
  const sidebar = page.getByRole("complementary", { name: "Pulse navigation" });
  const pagesOf = async (section: string) => {
    await sidebar.getByRole("link", { name: section, exact: true }).first().hover();
    return page.getByRole("navigation", { name: `${section} pages`, exact: true });
  };
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "hr@estateautopilots.com" });
  // CHAT-SHELL (22 Oct 2026): "/" opens Chats on a computer, and Chats keeps the panel aside; the panel is read on the
  // dashboard.
  await page.goto("/dashboard");
  // RELEASE-4: HR's own day, chats and the team were missing from its rail (the pages always opened for HR). Owner
  // workbench (21 Oct 2026): HR accounts get Work too.
  await expect(rail.getByRole("link")).toHaveCount(4);
  for (const [section, names] of [["Home", ["Dashboard", "My desk"]], ["Work", ["Work"]], ["Chats", ["Chats"]], ["People", ["Team", "HR desk", "Review data"]]] as const) {
    const list = await pagesOf(section);
    for (const name of names) await expect(list.getByRole("link", { name, exact: true })).toBeVisible();
  }
  for (const name of ["Clients", "Money", "Map", "Leadership", "Finance", "Billing", "Audit"]) await expect(sidebar.getByRole("link", { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
  for (const [route, name] of [["/hr-history", "HR desk"], ["/shifts", "HR desk"], ["/opshub", "Review data"]] as const) {
    await page.goto(route);
    await expect(rail.getByRole("link", { name: "People", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("navigation", { name: "People pages", exact: true }).getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page");
  }

  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" });
  await page.goto("/dashboard");
  await expect(rail.getByRole("link")).toHaveCount(6);
  // VISIBLE (25 Oct 2026): the groups hub's views, Insights, What's new and the product map are named in the panel.
  for (const [section, names] of [["Home", ["Dashboard", "My desk", "What's new", "Learn Pulse"]], ["Work", ["Work", "Processes", "Runs", "Product map"]], ["Chats", ["Chats", "All groups", "Client groups", "Waiting on us"]], ["Clients", ["Clients", "Contacts", "Acquisition", "Map", "Insights", "Pulse access"]],
    ["People", ["Team", "HR desk", "Leadership"]], ["Money", ["Finance", "Billing"]], ["Settings", ["Settings", "Review data", "Audit"]]] as const) {
    const list = await pagesOf(section);
    for (const name of names) await expect(list.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "Settings", exact: true }).first()).toBeVisible();
});

test("the command palette opens from the ⌘K shortcut", async ({ page }) => {
  // Not "/": its redirect can land after the document started streaming and close the open palette (see below).
  await page.goto("/dashboard");
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-theme"));
  // The shortcut is bound when the shell hydrates, which can be a moment after the theme is set.
  await expect(async () => { await page.keyboard.press("Control+k"); await expect(page.getByRole("dialog", { name: "Search Pulse" })).toBeVisible({ timeout: 1000 }); }).toPass();
  const palette = page.getByRole("dialog", { name: "Search Pulse" });
  await palette.getByRole("combobox").fill("Projects");
  const projects = palette.getByRole("option", { name: "Client projects", exact: true });
  await expect(projects).toBeVisible();
  await expect(projects).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/projects$/);
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
    const projects = palette.getByRole("option", { name: "Client projects", exact: true });
    await expect(projects).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/projects$/);
  } finally {
    releaseResponses();
  }
});

test("the shell theme toggle applies dark tokens", async ({ page }) => {
  // LAYOUT-SWEEP: one quiet header. The theme switch lives in the account menu at every width, wide windows included.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Switch to dark mode" })).toBeHidden();
  await expect(async () => { await page.getByRole("button", { name: "Open account menu" }).click(); await expect(page.getByRole("menuitem", { name: "Switch to dark mode" })).toBeVisible({ timeout: 1000 }); }).toPass();
  await page.getByRole("menuitem", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("at laptop widths the theme switch is in the account menu and applies dark tokens", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Switch to dark mode" })).toBeHidden();
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});


test("offline status appears without losing the open Pulse shell", async ({ page }) => {
  await page.goto("/dashboard");
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-theme"));
  await page.context().setOffline(true);
  await expect(async () => { await page.evaluate(() => window.dispatchEvent(new Event("offline"))); await expect(page.getByRole("status", { name: "Offline status" })).toBeVisible({ timeout: 1000 }); }).toPass();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveCount(1);
});
