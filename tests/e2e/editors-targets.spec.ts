import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

test.skip(Boolean(process.env.PULSE_BASE_URL), "Uses synthetic data for local web builds; real-data checks run separately.");

const admin = { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" };
const baseUrl = process.env.PLAYWRIGHT_TEST_BASE_URL;

test("editor target table shows placeholder badges, live totals, and light/dark desktop/mobile views", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  if (!baseUrl) throw new Error("Playwright did not configure a base URL.");
  await page.goto(new URL("/editors", baseUrl).toString());
  await expect(page).toHaveURL(/\/people\?[^#]*tab=tracking[^#]*view=accounts/);

  const accountsTable = page.getByRole("table", { name: "Uploader accounts and weekly targets" });
  await expect(accountsTable).toBeVisible();
  const editorRow = accountsTable.getByRole("row", { name: /alex\.editor@example\.test/ });
  await expect(editorRow.getByText("placeholder target", { exact: true })).toBeVisible();
  await expect(editorRow.getByRole("cell").nth(3)).toContainText("13 / week");
  await expect(editorRow).toContainText("13");
  await expect(editorRow).toContainText("3");
  await expect(editorRow).toContainText("10");
  const sharedRow = accountsTable.getByRole("row", { name: /studio@example\.test/ });
  if (await sharedRow.count() === 0) {
    await page.getByRole("group", { name: "Pages of Uploader accounts" }).getByRole("button", { name: "Next page" }).click();
  }
  await expect(sharedRow.getByRole("cell").nth(3)).toHaveText("Shared login · no personal target");
  await expect(sharedRow.getByRole("cell").nth(5)).toHaveText("—");

  const scratchDir = process.env.PAPERCLIP_RUN_SCRATCH_DIR;
  if (scratchDir) {
    await mkdir(scratchDir, { recursive: true });
    await page.screenshot({ path: join(scratchDir, "editors-light-desktop.png"), fullPage: true });
  }
  // LAYOUT-SWEEP: the theme switch lives in the account menu at every width.
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  if (scratchDir) await page.screenshot({ path: join(scratchDir, "editors-dark-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 1280 });
  await expect(page.locator('nav[aria-label="Mobile navigation"]')).toBeVisible();
  const mobileAccounts = page.getByRole("region", { name: "Uploader accounts" });
  await expect(mobileAccounts).toBeVisible();
  if (scratchDir) await mobileAccounts.screenshot({ path: join(scratchDir, "editors-dark-phone.png") });
  // Phones carry the theme switch in the account menu (PRESENCE-2: the top bar fits at 360 and 390 px).
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Switch to light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  if (scratchDir) await mobileAccounts.screenshot({ path: join(scratchDir, "editors-light-phone.png") });

  await mobileAccounts.getByRole("link", { name: "alex.editor@example.test" }).click();
  await expect(page).toHaveURL(/\/people\/accounts\//);
  const mobileTargets = page.getByRole("region", { name: "alex.editor@example.test weekly targets by creative type" });
  await expect(mobileTargets).toBeVisible();
  await expect(mobileTargets.getByText("placeholder target", { exact: true })).toHaveCount(6);
  if (scratchDir) await mobileTargets.screenshot({ path: join(scratchDir, "editor-profile-light-phone.png") });
  // Phones carry the theme switch in the account menu (PRESENCE-2: the top bar fits at 360 and 390 px).
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  if (scratchDir) await mobileTargets.screenshot({ path: join(scratchDir, "editor-profile-dark-phone.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const typeTable = page.getByRole("table", { name: "alex.editor@example.test target, delivered, and gap by creative type" });
  await expect(typeTable).toBeVisible();
  await expect(typeTable.getByText("placeholder target", { exact: true })).toHaveCount(6);
  await expect(typeTable.getByRole("row", { name: /All types · API total/ })).toContainText("3 · 1 drafts / 2 finals");
  await expect(typeTable.getByRole("row", { name: /Model video/ })).toContainText("4 / week");
  await expect(typeTable.getByRole("row", { name: /Model video/ })).toContainText("3 · 1 drafts / 2 finals");
  await expect(typeTable.getByRole("row", { name: /Model video/ })).toContainText("1");
  await expect(typeTable.getByRole("row", { name: /Walkthrough/ })).toContainText("1 / week");
  if (scratchDir) await page.screenshot({ path: join(scratchDir, "editor-profile-dark-desktop.png"), fullPage: true });
  // LAYOUT-SWEEP: the theme switch lives in the account menu at every width.
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Switch to light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  if (scratchDir) await page.screenshot({ path: join(scratchDir, "editor-profile-light-desktop.png"), fullPage: true });

  await page.goto(new URL("/people/accounts/studio%40example.test", baseUrl).toString());
  const sharedTargets = page.getByRole("table", { name: "studio@example.test target, delivered, and gap by creative type" });
  await expect(sharedTargets.getByRole("row", { name: /All types/ })).toContainText("Shared login · no personal target");
  await expect(sharedTargets.getByRole("row", { name: /All types/ }).getByRole("cell").nth(2)).toHaveText("—");
});

test("weekly target gaps are only compared against an exact seven-day period", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  if (!baseUrl) throw new Error("Playwright did not configure a base URL.");

  await page.goto(new URL("/editors?from=2026-10-02&to=2026-10-08", baseUrl).toString());
  await expect(page).toHaveURL(/\/people\?[^#]*tab=tracking[^#]*view=accounts/);
  const accountsTable = page.getByRole("table", { name: "Uploader accounts and weekly targets" });
  const editorRow = accountsTable.getByRole("row", { name: /alex\.editor@example\.test/ });
  await expect(accountsTable.getByRole("columnheader", { name: "Target / week" })).toBeVisible();
  await expect(accountsTable.getByRole("columnheader", { name: "Gap · 7 days" })).toBeVisible();
  await expect(editorRow.getByRole("cell").nth(5)).toHaveText("10");
  await page.goto(new URL("/editors/alex.editor%40example.test?from=2026-10-02&to=2026-10-08", baseUrl).toString());
  const weekProfileTable = page.getByRole("table", { name: "alex.editor@example.test target, delivered, and gap by creative type" });
  await expect(weekProfileTable.getByRole("row", { name: /All types · API total/ }).getByRole("cell").nth(2)).toHaveText("10");
  await expect(weekProfileTable.getByRole("row", { name: /Model video/ }).getByRole("cell").nth(1)).toHaveText("—");
  await expect(weekProfileTable.getByRole("row", { name: /Model video/ }).getByRole("cell").nth(2)).toHaveText("—");

  const longRange = "?from=2026-10-01&to=2026-10-31";
  await page.goto(new URL(`/editors${longRange}`, baseUrl).toString());
  const longRangeTable = page.getByRole("table", { name: "Uploader accounts and weekly targets" });
  const longRangeRow = longRangeTable.getByRole("row", { name: /alex\.editor@example\.test/ });
  await expect(longRangeRow.getByRole("cell").nth(3)).toContainText("/ week");
  await expect(longRangeRow.getByRole("cell").nth(5)).toHaveText("—");

  await page.goto(new URL(`/editors/alex.editor%40example.test${longRange}`, baseUrl).toString());
  const profileTable = page.getByRole("table", { name: "alex.editor@example.test target, delivered, and gap by creative type" });
  const totalRow = profileTable.getByRole("row", { name: /All types · API total/ });
  await expect(profileTable.getByRole("columnheader", { name: "Target / week" })).toBeVisible();
  await expect(profileTable.getByRole("columnheader", { name: "Delivered · selected period (draft / final)" })).toBeVisible();
  await expect(totalRow.getByRole("cell").nth(0)).toContainText("/ week");
  await expect(totalRow.getByRole("cell").nth(2)).toHaveText("—");
});
