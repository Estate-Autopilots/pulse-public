import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const headersFor = (email: string) => ({ "Cf-Access-Authenticated-User-Email": email });
const noAttendanceStatuses = /\b(Present|Absent|No check-in|No data)\b/i;

test("HR attendance views stay neutral when attendance is off", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pulse.theme", "light"));
  await page.setExtraHTTPHeaders(headersFor("hr@estateautopilots.com"));
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const view of ["week", "today", "team", "month", "totals"]) {
    await page.goto(`/hr?tab=attendance&view=${view}`);
    const main = page.locator("#main-content");
    await expect(main.getByText("Attendance is off for your organisation", { exact: true })).toBeVisible();
    await expect(main.getByText("Pulse is not recording check-ins. Leave and the other HR tools work as usual.", { exact: true })).toBeVisible();
    await expect(main.getByText(noAttendanceStatuses)).toHaveCount(0);
    if (view === "week") {
      await mkdir("test-results/hr-attendance-gate", { recursive: true });
      for (const [size, width, height] of [["desktop", 1440, 900], ["phone", 390, 844]] as const) {
        await page.setViewportSize({ width, height });
        for (const theme of ["light", "dark"] as const) {
          await page.evaluate((value) => { localStorage.setItem("pulse.theme", value); document.documentElement.dataset.theme = value; }, theme);
          await page.waitForTimeout(250);
          await page.screenshot({ path: `test-results/hr-attendance-gate/week-${size}-${theme}.png`, fullPage: true });
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  }
});

test("HR dashboard hides attendance while keeping leave visible", async ({ page }) => {
  await page.setExtraHTTPHeaders(headersFor("hr@estateautopilots.com"));
  await page.goto("/hr?tab=dashboard");
  const main = page.locator("#main-content");
  await expect(main.getByText("On leave", { exact: true })).toBeVisible();
  await expect(main.getByRole("heading", { name: /Waiting for you/ })).toBeVisible();
  await expect(main.getByRole("heading", { name: "Coming up" })).toBeVisible();
  for (const label of ["In now", "Checked in", "From home", "Not in yet", "No check-in", "Late", "Attendance averages", "Worth a look", "Last 14 days"])
    await expect(main.getByText(label, { exact: true })).toHaveCount(0);
});

test("Manager shared approvals stay visible when attendance is off", async ({ page }) => {
  await page.setExtraHTTPHeaders(headersFor("manager-attendance-off@estateautopilots.com"));
  await page.goto("/me");
  const main = page.locator("#main-content");
  // Owner workbench (21 Oct 2026): what waits for the manager is a list in My desk's Today card ("Due today").
  await expect(main.getByRole("region", { name: "Due today", exact: true }).getByRole("list", { name: "Waiting for you" })).toBeVisible();
  await expect(main.getByRole("heading", { name: "Your team today" })).toHaveCount(0);
  await expect(main.getByText(noAttendanceStatuses)).toHaveCount(0);
});

test("My desk attendance is neutral while leave stays available", async ({ page }) => {
  await page.setExtraHTTPHeaders(headersFor("staff@example.test"));
  await page.goto("/me?tab=attendance");
  const main = page.locator("#main-content");
  await expect(main.getByText("Attendance is off for your organisation", { exact: true })).toBeVisible();
  await expect(main.getByText(noAttendanceStatuses)).toHaveCount(0);
  // Owner workbench (21 Oct 2026): Leave is a view of My desk's Time group.
  await expect(page.getByRole("navigation", { name: "My desk", exact: true }).getByRole("link", { name: "Time" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Time", exact: true }).getByRole("link", { name: "Leave", exact: true })).toBeVisible();
});
