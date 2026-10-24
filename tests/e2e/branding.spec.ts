import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const outputDir = () => process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? "test-results";

test("signed-out branding stays organisation-specific in both themes and at phone width", async ({ browser }) => {
  const screenshots = outputDir();
  await mkdir(screenshots, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
      await context.addInitScript((value) => localStorage.setItem("pulse.theme", value), theme);
      const page = await context.newPage();
      await page.goto("/login");
      await expect(page.getByRole("region", { name: "Pulse" }).getByText("for Northwind Studio", { exact: true })).toBeVisible();
      await expect(page.locator("#main-content").getByText("Northwind Studio. Every sign-in is recorded.", { exact: true })).toBeVisible();
      await expect(page).toHaveTitle("Pulse · Northwind Studio");
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      await page.screenshot({ path: join(screenshots, `northwind-sign-in-${theme}-${width}.png`), fullPage: true });
      await context.close();
    }
  }
});

test("signed-in shell takes its organisation name from /api/v0/me", async ({ browser }) => {
  const screenshots = outputDir();
  await mkdir(screenshots, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: theme,
        extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": "owner@northwind.test" },
      });
      await context.addInitScript((value) => localStorage.setItem("pulse.theme", value), theme);
      const page = await context.newPage();
      await page.goto("/dashboard");
      await expect(page).toHaveTitle("Pulse · Northwind Studio");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      const navigation = page.getByRole("navigation", { name: width < 500 ? "Mobile navigation" : "Main sections" });
      await expect(navigation).toBeVisible();
      await navigation.screenshot({ path: join(screenshots, `northwind-shell-${theme}-${width}.png`) });
      if (width < 500) {
        // The phone More sheet is headed with the organisation, never a fixed company.
        await navigation.getByRole("button", { name: "More" }).click();
        const sheet = page.getByRole("dialog", { name: "All pages" });
        await expect(sheet.getByText("Northwind Studio", { exact: true })).toBeVisible();
        await expect(sheet).not.toContainText("Estate Autopilots");
        await sheet.screenshot({ path: join(screenshots, `northwind-more-${theme}-${width}.png`) });
        await sheet.getByRole("button", { name: "Close" }).click();
      } else {
        // The sidebar panel that holds the switcher starts collapsed.
        const expand = page.getByRole("button", { name: "Expand sidebar navigation" });
        if (await expand.isVisible()) await expand.click();
        await page.getByRole("button", { name: "Current workspace: Northwind Studio" }).click();
        const menu = page.getByRole("menu", { name: "Switch account" });
        await expect(menu.getByText("Northwind Studio", { exact: true })).toBeVisible();
        await expect(menu).not.toContainText("Estate Autopilots");
        await page.keyboard.press("Escape");
      }
      if (width === 1440) {
        await page.goto("/settings");
        await expect(page.locator("main").getByText("Northwind Studio", { exact: true })).toBeVisible();
      }
      await context.close();
    }
  }
});
