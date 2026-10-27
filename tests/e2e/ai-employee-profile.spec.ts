import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// ea-heavy pnpm --dir tests/e2e exec playwright test --config=ai-employee-profile.config.ts --workers=1
test.skip(process.env.PULSE_AI_PROFILE_CONTRACT !== "1" || !!process.env.PULSE_REAL_SMOKE, "Dedicated synthetic contract server only");
const route = (id = "synthetic-visible") => `/people/ai/${id}`;

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`AI fields, keyboard and layout: ${theme} at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 960 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.goto(route());
      const profile = page.getByRole("region", { name: "AI employee profile", exact: true });
      await expect(profile.getByRole("heading", { name: "Synthetic Studio Assistant", exact: true })).toBeVisible();
      expect(await profile.locator("h1").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(profile.getByLabel("AI employee · NW-AI-001", { exact: true })).toBeVisible();
      const fields = { "Employee ID": "NW-AI-001", Company: "Northwind Studio (NW)", Owner: "Synthetic Owner", Role: "Creative assistant", Lane: "Thinking", Model: "Synthetic runtime", Status: "On", "Daily budget": "40,000 of 160,000 tokens used today" };
      for (const [label, value] of Object.entries(fields)) {
        const row = profile.locator("dl > div").filter({ has: page.getByText(label, { exact: true }) });
        await expect(row.locator("dd")).toHaveText(value);
      }
      await expect(profile).not.toContainText(/attendance|presence|leave|payroll|sign.in|skills/i);
      await expect(profile.getByRole("heading", { name: /^work$/i })).toHaveCount(0);
      await expect(profile.getByRole("progressbar", { name: "Daily budget" })).toHaveAttribute("aria-valuenow", "25");
      const owner = profile.getByRole("link", { name: "Synthetic Owner", exact: true });
      await expect(owner).toHaveAttribute("href", "/people/synthetic-owner");
      await profile.getByRole("link", { name: "Team", exact: true }).focus();
      for (let i = 0; i < 5 && !(await owner.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
      await expect(owner).toBeFocused();
      expect(await owner.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (process.env.PULSE_SCREENSHOT_DIR) {
        await mkdir(process.env.PULSE_SCREENSHOT_DIR, { recursive: true });
        await profile.screenshot({ path: join(process.env.PULSE_SCREENSHOT_DIR, `ai-profile-${theme}-${width}.png`) });
      }
    });
  }
}

test("Quick lane, status reasons and budget limits", async ({ page }) => {
  for (const [id, text] of [["synthetic-quick", "Quick"], ["synthetic-paused", "Paused: Daily budget reached"], ["synthetic-off", "Off"]]) {
    await page.goto(route(id));
    await expect(page.getByRole("region", { name: "AI employee profile" }).getByText(text, { exact: true })).toBeVisible();
  }
  for (const [id, percent, text] of [["synthetic-zero", "0", "0 of 0 tokens used today"], ["synthetic-over", "100", "180,000 of 160,000 tokens used today"]]) {
    await page.goto(route(id));
    const bar = page.getByRole("progressbar", { name: "Daily budget" });
    await expect(bar).toHaveAttribute("aria-valuenow", percent);
    await expect(bar).toHaveAttribute("aria-valuetext", text);
  }
});

test("hidden and unknown profiles use the human Not found view", async ({ page }) => {
  await page.goto("/people/synthetic-hidden");
  await expect(page.getByText("Not found", { exact: true })).toBeVisible();
  for (const id of ["synthetic-hidden", "synthetic-unknown"]) {
    expect((await page.request.get(`/api/v0/agents/${id}`)).status()).toBe(404);
    await page.goto(route(id));
    await expect(page.getByText("Not found", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "AI employee profile" })).toHaveCount(0);
    await expect(page.getByText("NW-AI-001", { exact: true })).toHaveCount(0);
  }
});

test("loading has a skeleton and outages offer retry", async ({ page }) => {
  await page.goto(route("synthetic-slow"), { waitUntil: "commit" });
  await expect(page.getByRole("status", { name: "Loading AI employee" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Synthetic Studio Assistant", exact: true })).toBeVisible();
  await page.goto(route("synthetic-unavailable"));
  await expect(page.getByText("This didn’t load", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
});
