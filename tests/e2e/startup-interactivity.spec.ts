import { expect, test, type Response } from "@playwright/test";

test("page controls work while background hosts' code is still downloading", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@northwind-on.example" });
  await page.route("**/api/v0/auth/account", (route) => route.fulfill({ json: {
    delivery: null, twoStep: false, recoveryRemaining: 0, sessions: [], activity: [],
  } }));
  // Discover emitted chunk names on a warm visit, so this works with development and production builds.
  const markers = ["pulse.screen.paused", "pulse:policy-accept"];
  const chunks = new Map<string, string>();
  const discover = async (response: Response) => {
    const path = new URL(response.url()).pathname;
    if (!path.startsWith("/_next/static/chunks/") || !path.endsWith(".js")) return;
    const body = await response.text().catch(() => "");
    for (const marker of markers) if (body.includes(marker)) chunks.set(marker, path);
  };
  page.on("response", discover);
  await page.goto("/account");
  await expect(page.getByRole("tab", { name: "Email", exact: true })).toBeVisible();
  await expect.poll(() => chunks.size).toBe(2);
  page.off("response", discover);
  await page.goto("about:blank");

  // Hold the actual modules, including when they share a chunk with the layout before the fix.
  // No speed threshold: the page must respond before this code is allowed to arrive.
  const paths = new Set(chunks.values());
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const blocked = new Set<string>();
  await page.route("**/_next/static/chunks/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (paths.has(path)) { blocked.add(path); await held; }
    await route.continue();
  });
  try {
    await page.goto("/account", { waitUntil: "commit" });
    await expect(page.getByRole("heading", { name: "Account / Security" })).toBeVisible();
    await expect.poll(() => blocked.size, { message: "both background host chunks are held" }).toBe(paths.size);
    const email = page.getByRole("tab", { name: "Email", exact: true });
    await email.click();
    await expect(email).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Delivery email", exact: true })).toBeVisible();
    // Both hosts must still start once their downloads complete.
    const started = Promise.all([
      page.waitForRequest("**/api/v0/screen/events"),
      page.waitForRequest((request) => new URL(request.url()).pathname === "/api/v0/agreements/policies"),
    ]);
    release();
    await started;
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
