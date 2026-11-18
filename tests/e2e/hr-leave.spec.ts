import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const headersFor = (email: string) => ({ "Cf-Access-Authenticated-User-Email": email });

test("HR and admin see team leave; staff see only their own leave", async ({ page, request }) => {
  const mainContent = page.locator("#main-content");
  await page.addInitScript(() => localStorage.setItem("pulse.theme", "light"));
  for (const email of ["hr@estateautopilots.com", "admin@estateautopilots.com"]) {
    const headers = headersFor(email);
    await page.setExtraHTTPHeaders(headers);
    await page.goto("/hr?tab=leave&view=waiting");
    await expect(page.getByRole("heading", { name: "HR desk", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Waiting for you" })).toBeVisible();
    const leaveBalanceSummary = mainContent.getByText(/7 days available now, 5 days left after this/);
    await expect(leaveBalanceSummary).toHaveCount(1);
    await expect(leaveBalanceSummary).toBeVisible();
    await expect(page.getByRole("link", { name: "Synthetic Taylor" })).toBeVisible();
    expect((await request.get("/api/v0/hr/leave", { headers })).status()).toBe(200);

    const views = page.getByRole("navigation", { name: "Views" });
    await views.getByRole("link", { name: "Calendar" }).click();
    await expect(page.getByRole("heading", { name: "Team calendar" })).toBeVisible();
    await expect(page.getByRole("row", { name: /Synthetic Taylor/ })).toBeVisible();
    if (email.startsWith("hr@")) {
      await mkdir("test-results/hr-leave", { recursive: true });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: "test-results/hr-leave/calendar-light-desktop.png", fullPage: true });
      // LAYOUT-SWEEP: the theme switch lives in the account menu at every width.
      await page.getByRole("button", { name: "Open account menu" }).click();
      await page.getByRole("menuitem", { name: "Switch to dark mode" }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await page.screenshot({ path: "test-results/hr-leave/calendar-dark-desktop.png", fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: "test-results/hr-leave/calendar-dark-phone.png", fullPage: true });
      // Phones carry the theme switch in the account menu (PRESENCE-2: the top bar fits at 360 and 390 px).
      await page.getByRole("button", { name: "Open account menu" }).click();
      await page.getByRole("menuitem", { name: "Switch to light mode" }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await page.screenshot({ path: "test-results/hr-leave/calendar-light-phone.png", fullPage: true });
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await views.getByRole("link", { name: "History" }).click();
    await expect(page.getByRole("heading", { name: "Recent decisions" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Balance adjustments" })).toBeVisible();
    await expect(mainContent.getByText("No adjustments yet", { exact: true })).toBeVisible();
    await views.getByRole("link", { name: "Balances" }).click();
    await expect(page.getByRole("row", { name: /Synthetic Taylor.*7.*1 used/ })).toBeVisible();
    await expect(mainContent.getByText(/balances count from/)).toBeVisible();
  }

  const staff = headersFor("staff@example.test");
  await page.setExtraHTTPHeaders(staff);
  await page.goto("/hr?tab=leave");
  await expect(mainContent.getByText("The HR desk is for HR and admins", { exact: true }).first()).toBeVisible();
  expect((await request.get("/api/v0/hr/leave", { headers: staff })).status()).toBe(403);

  await page.goto("/me?tab=leave");
  await expect(page.getByRole("heading", { name: "My desk", level: 2 })).toBeVisible();
  await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Your requests", exact: true }).click();
  await expect(mainContent.getByText("Synthetic personal day", { exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic Taylor", { exact: true })).toHaveCount(0);
});
