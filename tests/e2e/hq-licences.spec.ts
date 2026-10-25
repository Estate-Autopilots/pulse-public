import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

test.beforeEach(async ({ baseURL }) => {
  test.skip(!baseURL || !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname), "Synthetic local API only");
});

for (const org of ["acme", "pulsehq"]) test(`${org}: HQ panel, direct licence URL and shortcuts`, async ({ page }) => {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": `admin@hq-${org}.example` });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/hq/licences?from=test");
  const hqLinks = page.locator('#pulse-sidebar-panel a[href^="/hq/"]');
  for (const label of ["Feature catalogue", "Offer Studio", "Ideas", "Brand", "Stack Intelligence"]) {
    await expect(page.locator("#pulse-sidebar-panel").getByRole("link", { name: label, exact: true })).toBeVisible();
  }
  await expect(hqLinks.filter({ hasText: /^Licences$/ })).toHaveCount(org === "pulsehq" ? 1 : 0);
  await expect(page.getByText(org === "pulsehq" ? "Licensed organisations" : "Licences are managed in Pulse HQ", { exact: true })).toBeVisible();
  await expect(page.getByText(/403|Forbidden/)).toHaveCount(0);
  // Hydration has completed before sending keyboard events.
  await page.getByRole("button", { name: "Collapse sidebar navigation", exact: true }).click();
  await page.getByRole("button", { name: "Expand sidebar navigation", exact: true }).click();
  await page.keyboard.press("?");
  const keys = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  await expect(keys).toBeVisible();
  await expect(keys.getByText("Go to Licences", { exact: true })).toHaveCount(org === "pulsehq" ? 1 : 0);
  await keys.getByRole("button", { name: "Close", exact: true }).click();
  // The shortcut strips the query by navigating only inside the platform owner's organisation.
  await page.keyboard.press("g");
  await page.keyboard.press("l");
  if (org === "pulsehq") await expect(page).toHaveURL(/\/hq\/licences$/);
  else await expect(page).toHaveURL(/\/hq\/licences\?from=test$/);

  if (!process.env.PULSE_SCREENSHOT_DIR) return;
  await mkdir(process.env.PULSE_SCREENSHOT_DIR, { recursive: true });
  for (const theme of ["light", "dark"] as const) for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/hq/licences");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    if (width === 1440) await expect(hqLinks.first()).toBeVisible();
    await expect(page.getByText(org === "pulsehq" ? "Licensed organisations" : "Licences are managed in Pulse HQ", { exact: true })).toBeVisible();
    await page.screenshot({ path: join(process.env.PULSE_SCREENSHOT_DIR, `hq-${org}-${theme}-${width}.png`) });
  }
});
