import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// EST-1737: the Team list's People · AI · Both switch (synthetic ai-team tenant in mock-editors-api.mjs). The header counts
// AI employees in words ("3 AI employees", HR-PEOPLE 13 Nov) beside "2 current".
const as = (role: string) => ({ "Cf-Access-Authenticated-User-Email": `${role}@ai-team.example` });
const header = (page: Page) => page.locator("[data-page-header]");
const aiRows = (page: Page) => page.locator("[data-ai]:visible");
const humanRows = (page: Page) => page.locator('a[href^="/people/synthetic-team-"]:visible');
// HR-PEOPLE (13 Nov 2026): the Team list keeps one row of filters; People · AI · Both (and who, function and skill) sit
// in the Filters sheet, whose main button shows the list.
const sheet = (page: Page) => page.getByRole("dialog", { name: "Filter the team", exact: true });
async function filters(page: Page) {
  if (!(await sheet(page).isVisible())) await page.getByRole("button", { name: /^Filters/ }).click();
  await expect(sheet(page)).toBeVisible();
  return sheet(page);
}
const members = async (page: Page) => (await filters(page)).getByRole("radiogroup", { name: "Members", exact: true });
async function done(page: Page) { await sheet(page).getByRole("button", { name: /^Show / }).click(); await expect(sheet(page)).toHaveCount(0); }
async function show(page: Page, name: "People" | "AI" | "Both") {
  await (await members(page)).getByRole("radio", { name, exact: true }).click();
  await done(page);
}

test.beforeEach(async ({ baseURL }) => {
  test.skip(!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname), "Synthetic local API only");
});

for (const role of ["admin", "leadership"]) test(`${role} switches People · AI · Both and the human headcount never moves`, async ({ page }) => {
  await page.setExtraHTTPHeaders(as(role));
  // A computer's window: the Team list pages by height, and since the owner's workbench (21 Oct 2026) the page header
  // sits in the page, so a 720 px window moves the third AI row to page 2.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/people");
  await expect((await members(page)).getByRole("radio", { name: "Both", exact: true })).toHaveAttribute("aria-checked", "true");
  await done(page);
  await expect(page.locator('span[title="2 current"]')).toBeVisible();
  await expect(header(page)).toContainText("3 AI employees");
  await expect(humanRows(page)).toHaveCount(2);
  await expect(aiRows(page)).toHaveCount(3);
  const scout = aiRows(page).filter({ hasText: "Scout" });
  await expect(scout).toHaveAttribute("href", "/people/ai/synthetic-ai-scout");
  await expect(scout.getByRole("img", { name: "AI employee · NW-AI-001", exact: true })).toBeVisible();
  await expect(scout).toContainText("Research assistant");
  await expect(scout).toContainText("Quick lane");
  await expect(scout).toContainText("Owner Avery · 1,82,000 tokens left today");
  await expect(aiRows(page).filter({ hasText: "Quill" })).toContainText("Paused");
  // No presence dot, attendance, pod or sign-in on an AI row.
  await expect(aiRows(page).locator('[title="Checked in"], [aria-label*="office"], [aria-label*="Offline"]')).toHaveCount(0);

  await show(page, "AI");
  await expect(humanRows(page)).toHaveCount(0);
  await expect(aiRows(page)).toHaveCount(3);
  // People's own filters step aside for AI employees: no team chips, and no Who (status) in the sheet.
  await expect(page.getByRole("group", { name: /^Show one team/ })).toHaveCount(0);
  await expect((await filters(page)).getByRole("group", { name: "Status", exact: true })).toHaveCount(0);
  await done(page);
  await expect(page.locator('span[title="2 current"]')).toBeVisible();
  await page.getByRole("searchbox", { name: "Search the team" }).fill("nw-ai-003");
  await expect(aiRows(page)).toHaveCount(1);
  await expect(aiRows(page)).toContainText("No owner");
  await page.getByRole("searchbox", { name: "Search the team" }).fill("");

  await show(page, "People");
  await expect(aiRows(page)).toHaveCount(0);
  await expect(humanRows(page)).toHaveCount(2);
  await expect(page.locator('span[title="2 current"]')).toBeVisible();
  await expect(header(page)).toContainText("3 AI employees");

  // A filter only people have (alumni, pod, team, skill) leaves AI employees out of Both.
  await show(page, "Both");
  await expect(aiRows(page)).toHaveCount(3);
  await (await filters(page)).getByRole("group", { name: "Status", exact: true }).getByRole("button", { name: /^Alumni/ }).click();
  await done(page);
  await expect(aiRows(page)).toHaveCount(0);
  await expect(humanRows(page)).toHaveCount(1);
});

test("the list view gives AI employees their own columns", async ({ page }) => {
  await page.setExtraHTTPHeaders(as("admin"));
  await page.goto("/people?view=list");
  // DE-EA: this company has not named its teams, so the unit column reads the neutral "Team" (a function is a "Department").
  await expect(page.getByRole("columnheader", { name: "Team", exact: true })).toBeVisible();
  const table = page.locator("table").filter({ has: page.getByRole("columnheader", { name: "AI employee", exact: true }) });
  await expect(table.getByRole("columnheader", { name: "Budget left today", exact: true })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Team", exact: true })).toHaveCount(0);
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator("tbody tr").filter({ hasText: "Quill" })).toContainText("0 tokens");
  await show(page, "AI");
  await expect(page.getByRole("columnheader", { name: "Team", exact: true })).toHaveCount(0);
  await expect(table.locator("tbody tr")).toHaveCount(3);
});

for (const role of ["hr", "staff"]) {
  test(`${role} sees no toggle and no AI rows, even where the data would answer`, async ({ page }) => {
    await page.setExtraHTTPHeaders(as(role));
    await page.goto("/people");
    await expect(page.getByRole("searchbox", { name: "Search the team" })).toBeVisible();
    await expect(page.locator('span[title="2 current"]')).toBeVisible();
    await expect(header(page)).not.toContainText("3 AI employees");
    await expect((await filters(page)).getByRole("radiogroup", { name: "Members", exact: true })).toHaveCount(0);
    await expect(page.locator("[data-ai]")).toHaveCount(0);
    await expect(page.getByRole("img", { name: /^AI employee/ })).toHaveCount(0);
  });
}

test("an empty AI roster explains what will appear without changing headcount", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@ai-team-empty.example" });
  await page.goto("/people");
  await expect(page.locator('span[title="2 current"]')).toBeVisible();
  await expect(header(page)).toContainText("0 AI employees");
  await show(page, "AI");
  await expect(page.getByText("No AI employees yet", { exact: true })).toBeVisible();
});

for (const width of [1280, 390]) test(`an unavailable AI roster preserves people, filtering and Add people at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@ai-team-error.example" });
  await page.goto("/people");
  const notice = page.getByRole("status", { name: "AI employees unavailable", exact: true });
  await expect(notice.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await expect(page.locator('span[title="2 current"]')).toBeVisible();
  await expect(humanRows(page)).toHaveCount(2);
  await expect(header(page)).not.toContainText("0 AI employees");
  // Header actions can fold into More in the production build; exercise the visible flow.
  const form = page.getByRole("dialog", { name: "Add people", exact: true });
  await expect(async () => {
    if (await form.isVisible()) return;
    const add = page.getByRole("button", { name: "Add people", exact: true });
    if (!await add.isVisible()) await page.getByRole("button", { name: /^More actions \(/ }).click({ timeout: 1000 });
    await add.click({ timeout: 1000 });
    await expect(form).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await show(page, "AI");
  await expect(notice).toBeVisible();
  await expect(humanRows(page)).toHaveCount(0);
  await expect(page.getByText("No AI employees yet", { exact: true })).toHaveCount(0);
  await show(page, "People");
  await expect(notice).toHaveCount(0);
  await expect(humanRows(page)).toHaveCount(2);
});

test("an unavailable AI roster does not replace Tracking", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@ai-team-error.example" });
  await page.goto("/people?tab=tracking&view=accounts");
  await expect(page.getByRole("table", { name: "Uploader accounts and weekly targets" })).toBeVisible();
  await expect(page.locator('span[title="2 current"]')).toBeVisible();
  await expect(header(page)).not.toContainText("0 AI employees");
});

test("synthetic screenshots of the AI view", async ({ page }) => {
  test.skip(!process.env.PULSE_SCREENSHOT_DIR, "Only when screenshots are asked for");
  await page.setExtraHTTPHeaders(as("admin"));
  await mkdir(process.env.PULSE_SCREENSHOT_DIR!, { recursive: true });
  for (const theme of ["light", "dark"] as const) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const view of ["cards", "list"]) {
      await page.goto(`/people?view=${view}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await show(page, "AI");
      await expect(aiRows(page)).toHaveCount(3);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: join(process.env.PULSE_SCREENSHOT_DIR!, `ai-team-${view}-${theme}-${width}.png`) });
    }
  }
});

test("synthetic All, empty and unavailable views", async ({ page }) => {
  test.skip(!process.env.PULSE_SCREENSHOT_DIR, "Only when screenshots are asked for");
  await mkdir(process.env.PULSE_SCREENSHOT_DIR!, { recursive: true });
  for (const [theme, width] of [["light", 1440], ["dark", 390]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const state of ["all", "empty", "unavailable"] as const) for (const view of state === "empty" ? ["cards"] : ["cards", "list"]) {
      const tenant = state === "all" ? "ai-team" : state === "empty" ? "ai-team-empty" : "ai-team-error";
      await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": `admin@${tenant}.example` });
      await page.goto(`/people?view=${view}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator('span[title="2 current"]')).toBeVisible();
      if (state === "empty") {
        await show(page, "AI");
        await expect(page.getByText("No AI employees yet", { exact: true })).toBeVisible();
      } else {
        await expect(humanRows(page)).toHaveCount(2);
        if (state === "all") await expect(aiRows(page)).toHaveCount(3);
        else await expect(page.getByRole("status", { name: "AI employees unavailable", exact: true })).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: join(process.env.PULSE_SCREENSHOT_DIR!, `ai-team-${state}-${view}-${theme}-${width}.png`) });
    }
  }
});
