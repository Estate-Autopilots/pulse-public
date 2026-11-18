import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

test.skip(Boolean(process.env.PULSE_BASE_URL), "Uses synthetic API responses; real-data checks run separately.");

const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR;

test("a person claims an uploader account, a manager confirms it, and designer totals update", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "sam@example.test" });
  await page.goto("/me?tab=accounts");
  await expect(page.getByRole("heading", { name: "Accounts to claim" })).toBeVisible();
  await expect(page.getByText("synthetic-editor@example.test")).toBeVisible();
  if (scratch) {
    await mkdir(scratch, { recursive: true });
    await page.screenshot({ path: join(scratch, "est-436-accounts-light-desktop.png"), fullPage: true });
  }

  // LAYOUT-SWEEP: the theme switch lives in the account menu at every width.
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  if (scratch) await page.screenshot({ path: join(scratch, "est-436-accounts-dark-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  if (scratch) await page.screenshot({ path: join(scratch, "est-436-accounts-dark-phone.png"), fullPage: true });
  // Phones carry the theme switch in the account menu (PRESENCE-2: the top bar fits at 360 and 390 px).
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Switch to light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  if (scratch) await page.screenshot({ path: join(scratch, "est-436-accounts-light-phone.png"), fullPage: true });

  await page.getByRole("button", { name: "Claim account" }).click();
  await expect(page.getByText("Waiting for confirmation")).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "manager@estateautopilots.com" });
  await page.goto("/people?tab=tracking&view=claims");
  const queue = page.getByRole("heading", { name: "Account claims to confirm" }).locator("xpath=../..");
  await expect(queue.getByText("Synthetic Sam")).toBeVisible();
  await expect(queue.getByText("synthetic-editor@example.test")).toBeVisible();
  await expect(queue.getByText("synthetic-manager@example.test")).toHaveCount(0);
  if (scratch) await page.screenshot({ path: join(scratch, "est-436-review-light-desktop.png"), fullPage: true });
  // LAYOUT-SWEEP: the theme switch lives in the account menu at every width.
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Switch to dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  if (scratch) await page.screenshot({ path: join(scratch, "est-436-review-dark-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  if (scratch) await page.screenshot({ path: join(scratch, "est-436-review-dark-phone.png"), fullPage: true });
  // Phones carry the theme switch in the account menu (PRESENCE-2: the top bar fits at 360 and 390 px).
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Switch to light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  if (scratch) await page.screenshot({ path: join(scratch, "est-436-review-light-phone.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await queue.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("No claims to confirm")).toBeVisible();

  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "sam@example.test" });
  await page.goto("/me?tab=accounts");
  const claimHistory = page.getByRole("heading", { name: "Your account claims" }).locator("xpath=../..");
  await expect(claimHistory.getByText("Confirmed", { exact: true })).toBeVisible();

  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "manager@estateautopilots.com" });
  await page.goto("/designers?week=2026-W39");
  const designers = page.getByRole("table", { name: "Weekly design deliveries by person and type" });
  await expect(designers.getByRole("row", { name: /Synthetic Sam/ })).toContainText("4");
});
