import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

// EST-647: a synthetic second company (Northwind, mock API) with AC's off list:
// designers, map, acquisition, chats, briefs, money, hr.
const northwind = { "Cf-Access-Authenticated-User-Email": "admin@northwind.example" };
const ea = { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" };
// Processes (FLOW-B, 23 Oct 2026: they replaced the SOP pages) are always on; ERP belongs to Money.
const onPages = ["Dashboard", "Work", "Clients", "Contacts", "Processes", "Team", "My desk", "Leadership", "Review data", "Audit"];
const offPages = ["Chats", "Acquisition", "Map", "HR desk", "Finance"];
// `/leave` is a next.config redirect into My desk → Leave, not a page of its own.
const offUrls = ["/designers", "/map", "/acquisition", "/portal", "/chats", "/communication", "/inbox", "/groups", "/briefs",
  "/finance", "/money", "/hr", "/hr-history", "/shifts"];
const offTitle = "This module is not switched on for your organisation.";
const shots = "test-results/module-switches";

test("switched-off modules leave the rail, the phone tabs and the palette", async ({ page }) => {
  await page.setExtraHTTPHeaders(northwind);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dashboard");
  // Owner workbench (21 Oct 2026): the rail holds sections and the panel beside it lists the shown section's pages
  // (pointing at a section shows them). Chats and Money are whole sections, so they leave the rail.
  const rail = page.getByRole("navigation", { name: "Main sections" });
  const sidebar = page.getByRole("complementary", { name: "Pulse navigation" });
  const sections = { Home: ["Dashboard", "My desk"], Work: ["Work", "Processes"], Clients: ["Clients", "Contacts"], People: ["Team", "Leadership"], Settings: ["Review data", "Audit"] };
  await expect(rail.getByRole("link")).toHaveCount(4);
  for (const name of ["Chats", "Money"]) await expect(rail.getByRole("link", { name, exact: true })).toHaveCount(0);
  for (const [section, names] of Object.entries(sections)) {
    await sidebar.getByRole("link", { name: section, exact: true }).first().hover();
    const list = page.getByRole("navigation", { name: `${section} pages`, exact: true });
    for (const name of names) await expect(list.getByRole("link", { name, exact: true })).toBeVisible();
    for (const name of offPages) await expect(list.getByRole("link", { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("link", { name: "Settings", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /^Inbox/ })).toHaveCount(0);

  await page.waitForFunction(() => document.documentElement.hasAttribute("data-theme"));
  await expect(async () => { await page.keyboard.press("Control+k"); await expect(page.getByRole("dialog", { name: "Search Pulse" })).toBeVisible({ timeout: 1000 }); }).toPass();
  const palette = page.getByRole("dialog", { name: "Search Pulse" });
  for (const name of onPages) await expect(palette.getByRole("option", { name, exact: true })).toBeVisible();
  for (const name of [...offPages, "Designers", "Briefs"]) {
    await palette.getByRole("combobox").fill(name);
    await expect(palette.getByRole("option", { name, exact: true })).toHaveCount(0);
  }
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "More" }).click();
  const sheet = page.getByRole("dialog", { name: "All pages" });
  for (const name of onPages) await expect(sheet.getByRole("link", { name, exact: true })).toBeVisible();
  for (const name of offPages) await expect(sheet.getByRole("link", { name, exact: true })).toHaveCount(0);
});

test("an off module's URL shows one neutral page with the way back", async ({ page }) => {
  await page.setExtraHTTPHeaders(northwind);
  const main = page.locator("#main-content");
  for (const url of offUrls) {
    await page.goto(url);
    await expect(main.getByText(offTitle, { exact: true }), url).toBeVisible();
    await expect(main.getByRole("link", { name: "Go to Dashboard" }), url).toHaveAttribute("href", "/dashboard");
  }
  await mkdir(shots, { recursive: true });
  await page.goto("/map");
  for (const [size, width, height] of [["desktop", 1440, 900], ["phone", 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => { localStorage.setItem("pulse.theme", value); document.documentElement.dataset.theme = value; }, theme);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${shots}/off-page-${size}-${theme}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await main.getByRole("link", { name: "Go to Dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(main.getByText(offTitle, { exact: true })).toHaveCount(0);
  // A link inside a page navigates without reloading the layout; the gate still applies.
  await page.evaluate(() => (window as unknown as { next: { router: { push: (href: string) => void } } }).next.router.push("/finance"));
  await expect(page).toHaveURL(/\/finance$/);
  await expect(main.getByText(offTitle, { exact: true })).toBeVisible();
});

test("My desk, whose data is HR's, shows the neutral page when hr is off", async ({ page }) => {
  await page.setExtraHTTPHeaders(northwind);
  for (const url of ["/me", "/me/approvals", "/leave"]) {
    await page.goto(url);
    await expect(page.locator("#main-content").getByText(offTitle, { exact: true }), url).toBeVisible();
  }
});

test("Team hides the Designers button only when designers is off", async ({ page }) => {
  // Owner workbench (21 Oct 2026): Designers moved from Team's header to the sidebar, under Team.
  await page.setViewportSize({ width: 1440, height: 900 });
  const actions = page.getByRole("navigation", { name: "People pages", exact: true });
  await page.setExtraHTTPHeaders(northwind);
  await page.goto("/people");
  await expect(page.locator("#main-content").getByRole("heading", { name: "Team" })).toBeVisible();
  await expect(actions.getByRole("link", { name: "Team", exact: true })).toBeVisible();
  await expect(actions.getByRole("link", { name: "Designers", exact: true })).toHaveCount(0);
  await page.setExtraHTTPHeaders(ea);
  await page.goto("/people");
  await expect(actions.getByRole("link", { name: "Designers", exact: true })).toBeVisible();
});

// EST-648: Northwind's Dashboard leaves out every panel of an off module, for each role, with no error. Its twin
// Northwind-on (same synthetic data, every module on) shows that those panels exist.
const as = (role: "admin" | "hr" | "staff", company = "northwind") => ({ "Cf-Access-Authenticated-User-Email": `${role}@${company}.example` });

test("Dashboard leaves out the panels of switched-off modules for admin, HR and staff", async ({ page }) => {
  const main = page.locator("#main-content");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sections = () => main.locator("[data-section]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-section")));
  const open = async (url: string) => {
    await page.goto(url);
    await expect(main.getByRole("heading", { name: "Dashboard", level: 2 })).toBeVisible();
    await expect(main.getByText("This view is unavailable")).toHaveCount(0);
  };
  const tabs = main.getByRole("navigation", { name: "Sections" }), views = main.getByRole("navigation", { name: "Views" });

  for (const company of ["northwind-on", "northwind"]) {
    const on = company === "northwind-on";
    await page.setExtraHTTPHeaders(as("admin", company));
    // Module-panel assertions exercise the retained legacy overview.
    await open("/dashboard?mode=max&tab=overview");
    await expect(tabs.getByRole("link", { name: "Finance", exact: true })).toHaveCount(on ? 1 : 0);
    await expect(main.getByText(/^\d+ in today · \d+ on leave$/)).toHaveCount(on ? 1 : 0);
    await open("/dashboard?tab=people");
    await expect(views.getByRole("link", { name: "Today", exact: true })).toHaveCount(on ? 1 : 0);
    await expect(views.getByRole("link", { name: on ? "Today" : "Pods & teams", exact: true })).toHaveAttribute("aria-current", "true");
    await open("/dashboard?tab=money");
    await expect(main.getByText("Finance has its own workspace")).toHaveCount(on ? 1 : 0);

    await page.setExtraHTTPHeaders(as("hr", company));
    await open("/dashboard");
    expect(await sections()).toEqual(on ? ["Attendance today", "Leave requests", "People changes"] : ["People changes"]);
    await expect(main.getByText("Leave pending", { exact: true })).toHaveCount(on ? 1 : 0);

    await page.setExtraHTTPHeaders(as("staff", company));
    await open("/dashboard");
    expect((await sections()).includes("Today")).toBe(on);
    expect(await sections()).toEqual(expect.arrayContaining(["My deliveries per week", "Recent work", "My projects"]));
    for (const label of ["Attendance", "My leave"]) await expect(main.getByText(label, { exact: true })).toHaveCount(on ? 1 : 0);
  }
  expect(errors).toEqual([]);

  await mkdir(shots, { recursive: true });
  for (const role of ["admin", "hr", "staff"] as const) {
    await page.setExtraHTTPHeaders(as(role));
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(role === "admin" ? "/dashboard?mode=max&tab=overview" : "/dashboard");
    for (const [size, width, height] of [["desktop", 1440, 900], ["phone", 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((value) => { localStorage.setItem("pulse.theme", value); document.documentElement.dataset.theme = value; }, theme);
        await page.waitForTimeout(250);
        await page.screenshot({ path: `${shots}/dashboard-${role}-${size}-${theme}.png`, fullPage: true });
      }
    }
  }
});

test("with no modules document EA keeps every module", async ({ page }) => {
  await page.setExtraHTTPHeaders(ea);
  await page.goto("/map");
  await expect(page.locator("#main-content").getByText(offTitle, { exact: true })).toHaveCount(0);
  // Owner workbench (21 Oct 2026): Map is a page of the Clients section.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("navigation", { name: "Main sections" }).getByRole("link", { name: "Clients", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Clients pages", exact: true }).getByRole("link", { name: "Map", exact: true })).toHaveAttribute("aria-current", "page");
});
