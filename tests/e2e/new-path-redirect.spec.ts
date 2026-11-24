import { expect, test } from "@playwright/test";

// PROJECTS-FLICKER (owner, 22 Nov 2026, P0: "the project page … is flickering like crazy, it does not open"). What's
// new's Show me on a change to Work → Projects stores a path to /projects (new-path.tsx). For an agency /projects
// sends the person on to /tasks?view=projects, so the path, finding itself off its page, opened /projects again,
// landed on /tasks again, and so on: on production about eight times a second (the owner's session, 07:07-07:08 UTC),
// the page drawn again each time (layout shift 0.9), Work's live check asked again each time, and every lap added a
// history entry, so Back went nowhere. The path opens a step's page once; landing elsewhere straight after (a
// redirect), it carries on there.
const admin = { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" };

test("Show me on a page that redirects opens it once, the page settles, and the path carries on where it landed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setExtraHTTPHeaders(admin);
  await page.route("**/api/v0/whats-new/unseen", (route) => route.fulfill({ json: { on: true, count: 0, items: [] } }));
  await page.route("**/api/v0/work/changed**", (route) => route.fulfill({ json: { at: Date.now(), changed: false } }));
  // The path What's new's Show me stores for a change to the Projects page as a whole (startPath → pathPlan on a phone
  // or with the rail hidden: one step, the page), as the owner's was.
  await page.addInitScript(() => {
    if (sessionStorage.getItem("spec.seeded")) return;
    sessionStorage.setItem("spec.seeded", "1");
    sessionStorage.setItem("pulse.new-path", JSON.stringify({ route: "/projects", href: "/projects", text: "Projects is one list of colour cards",
      anchor: "", inferred: false, steps: [{ kind: "page", label: "Projects" }], i: 0, at: Date.now() }));
  });
  const urls: string[] = [];
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) urls.push(new URL(frame.url()).pathname); });
  await page.goto("/whats-new");
  // The path opens /projects; the server sends an agency on to Work → Projects.
  await expect(page).toHaveURL(/\/tasks\?view=projects/, { timeout: 20_000 });
  const settled = urls.length;
  await page.waitForTimeout(4_000);
  // Before the fix: dozens of address changes in these 4 s (/projects, /tasks?view=projects, /projects, …).
  expect(urls.length - settled, `the address kept changing: ${urls.slice(settled, settled + 12).join(" → ")}`).toBeLessThanOrEqual(1);
  expect(urls.filter((u) => u === "/projects").length, "the path opened /projects more than once").toBeLessThanOrEqual(1);
  await expect(page).toHaveURL(/\/tasks\?view=projects/);
  // Back has somewhere to go: at most the start page, /projects (replaced by the redirect) and Work → Projects.
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(4);
  // The path carries on where the redirect landed: its card says the change is on this page.
  await expect(page.locator('[data-new-path="page"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-new-path="page"]')).toContainText("Projects");
});
