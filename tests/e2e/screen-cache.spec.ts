import { expect, test } from "@playwright/test";

// REPLAY-FIXES #1 (REPLAY-INSIGHTS 20 Nov 2026: moving between main screens took 3-10 s, 9 people; Savuzo tapped Home and
// nothing moved for 3 s). A screen seen before opens at once from this tab's copy (app/screen-cache.tsx), marked
// "Updating…", and the real page, fetched fresh, replaces it. Here the server takes 2.5 s to answer People: the copy must
// show within a moment of the tap, and give way to the real page when it comes.
const admin = { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" };

test("a screen seen before shows its copy at once while the real page comes, then the real page replaces it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setExtraHTTPHeaders(admin);
  await page.addInitScript(() => localStorage.setItem("pulse.sidebar.collapsed", "false"));
  const t0 = Date.parse("2030-01-01T09:00:00Z");
  await page.clock.setFixedTime(t0);
  await page.goto("/people");
  const main = page.locator("#main-content");
  const heading = main.locator("h1, h2").first();
  await expect(heading).toBeVisible();
  await expect(main.locator('[aria-busy="true"]')).toHaveCount(0);
  const words = (await heading.textContent())?.trim() ?? "";
  expect(words.length).toBeGreaterThan(0);
  // People is "seen" once the screen cache runs. The heading is in the first HTML, so on a busy runner the tap below
  // could come while Pulse is still starting; that tap is held and pressed later, and the screen it leaves is not kept.
  await expect(page.locator("body[data-screen-cache]")).toHaveCount(1, { timeout: 15_000 });

  const rail = page.getByRole("navigation", { name: "Main sections" });
  await rail.locator('[data-nav-id="rail:work"]').click();
  await expect(page).toHaveURL(/\/tasks/);
  await expect(main.locator('[data-screen-copy]')).toHaveCount(0);

  // A minute later Next's own 30 s copy of People is stale, so the move asks the server, which is slow now.
  await page.clock.setFixedTime(t0 + 60_000);
  let slowed = 0;
  await page.route((url) => url.pathname === "/people" && url.searchParams.has("_rsc"), async (route) => {
    slowed++; await new Promise((done) => setTimeout(done, 2500)); await route.continue().catch(() => {});
  });
  const tapped = Date.now();
  await rail.locator('[data-nav-id="rail:people"]').click();
  const copy = page.locator('[data-screen-copy="/people"]');
  await expect(copy).toBeVisible({ timeout: 1500 });
  expect(Date.now() - tapped).toBeLessThan(2000);
  await expect(copy).toContainText(words);
  await expect(copy).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("status").filter({ hasText: "Updating…" })).toBeVisible();
  // The copy is a still picture: nothing in it can take focus.
  expect(await copy.locator('a[href]:not([tabindex="-1"]), button:not([tabindex="-1"])').count()).toBe(0);

  // The real page arrives and takes its place.
  await expect(copy).toHaveCount(0, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/people$/);
  await expect(heading).toContainText(words);
  expect(slowed).toBeGreaterThan(0);
});

test("a screen never seen in this tab opens as before, with the thin bar while it comes and no copy", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setExtraHTTPHeaders(admin);
  await page.addInitScript(() => localStorage.setItem("pulse.sidebar.collapsed", "false"));
  await page.goto("/tasks");
  await expect(page.locator("#main-content h1, #main-content h2").first()).toBeVisible();
  await page.route((url) => url.pathname === "/people" && url.searchParams.has("_rsc"), async (route) => {
    await new Promise((done) => setTimeout(done, 2000)); await route.continue().catch(() => {});
  });
  await page.getByRole("navigation", { name: "Main sections" }).locator('[data-nav-id="rail:people"]').click();
  await expect(page.locator("[data-screen-copy]")).toHaveCount(0);
  await expect(page).toHaveURL(/\/people$/, { timeout: 15_000 });
});
