import { expect, test, type Page } from "@playwright/test";
// Round 7B (v0.1 release gate): the daily screens of each role on the real EA tenant, read-only. Password roles
// (person, PGS, new joiner) are covered against a synthetic tenant by tests/core/test_access_matrix.py.
test.skip(!process.env.PULSE_REAL_SMOKE, "Run against an environment with the real EA tenant");
const admin = { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" };
const hr = { "Cf-Access-Authenticated-User-Email": "hr@estateautopilots.com" };

/** A desktop page fits the window: no document scroll and no region that scrolls past its box (except a chat log or a
 *  policy document, which are read by scrolling). */
async function fits(page: Page) {
  return page.evaluate(() => document.scrollingElement!.scrollHeight <= innerHeight + 1 && document.scrollingElement!.scrollWidth <= innerWidth + 1
    && [...document.querySelectorAll<HTMLElement>("main *")].every((el) => { const c = getComputedStyle(el); return !/auto|scroll/.test(c.overflowY) || el.scrollHeight <= el.clientHeight + 1 || !!el.closest("[data-pager-view], [role='log'], [role='document'], [class*='messages']"); }));
}

test("sign-in is Pulse's own screen with one primary action", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "someone.outside@example.com" });
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in to Pulse" })).toBeVisible();
  await expect(page.getByLabel("Username")).toBeVisible(); await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await page.getByRole("button", { name: "Forgot your password?" }).click();
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await page.goto("/login?change=1");
  await expect(page.getByLabel("New password again")).toBeVisible();
  await expect(page.getByText("At least 10 characters")).toBeVisible();
});

test("leadership: dashboard, projects, review queue, tasks, money and audit fit the window", async ({ page }) => {
  test.setTimeout(150000);
  await page.setViewportSize({ width: 1536, height: 730 }); await page.setExtraHTTPHeaders(admin);
  for (const [path, heading] of [["/dashboard?mode=max", "Deliveries per week"], ["/review-data", "Needs attention"], ["/money", "Cash flow by month"], ["/money?tab=ledger", null], ["/audit", null], ["/leadership?tab=performance", "Pods"], ["/leadership?tab=money", "In Money"]] as const) {
    await page.goto(path); await page.waitForLoadState("networkidle");
    if (heading) await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
    expect(await fits(page), `${path} fits 1536×730`).toBe(true);
  }
  await expect(page.getByText("Money is not connected yet")).toHaveCount(0);
  // RT1: /tasks opens on My tasks; the full list with its status filter is the All tasks view.
  await page.goto("/tasks?view=all"); await expect(page.getByRole("group", { name: "Status" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Done/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous" })).toHaveCount(0); // one pager, not two
  await page.goto("/projects"); await expect(page.getByRole("group", { name: "Filter by stage" })).toBeVisible();
});

test("HR: desk, leave, policies and inviting a new joiner from the record", async ({ page, request }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1536, height: 730 }); await page.setExtraHTTPHeaders(hr);
  await page.goto("/hr"); await expect(page.getByRole("heading", { name: /^Who is in/ })).toBeVisible();
  await page.goto("/hr?tab=leave"); await expect(page.getByRole("button", { name: "File leave for someone" })).toBeVisible();
  await page.goto("/hr?tab=policies"); await expect(page.getByRole("navigation", { name: "Policies" })).toBeVisible();
  expect(await fits(page), "policies fit").toBe(true);
  // Someone current with neither a Pulse password nor a company Google account gets "Invite to Pulse" on their record.
  const access = await (await request.get("/api/v0/admin/access", { headers: hr })).json();
  const person = access.people.find((p: { loginStatus: string | null; accounts: string[] }) => !p.loginStatus && !p.accounts.length);
  test.skip(!person, "Everyone has a sign-in");
  await page.goto(`/people/${person.id}`);
  await expect(page.getByRole("button", { name: "Invite to Pulse" })).toBeVisible();
  await page.goto(`/people/${person.id}?tab=hr`);
  await expect(page.getByRole("button", { name: "Notes" })).toHaveCount(0); // a restriction notice is not a view of its own
});

test("rail highlights the real section for secondary pages", async ({ page }) => {
  await page.setExtraHTTPHeaders(admin);
  for (const [path, label] of [["/notifications", "My desk"], ["/hr-history", "HR desk"], ["/activity", "Team"]] as const) {
    await page.goto(path); await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(`nav a[aria-label="${label}"][class*="Active"], nav a[aria-label="${label}"][aria-current="page"]`).first()).toBeVisible();
  }
});
