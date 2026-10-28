import { expect, test, type Request } from "@playwright/test";

// TELEMETRY (owner, 24 Oct 2026): clicking around records page views, clicks and API calls with their timings, and
// nothing typed. The batches are caught here (the mock API has no telemetry route), so this runs anywhere.
type Ev = { k: string; t: number; n?: string; p?: string; d?: number; s?: number; r?: string; x?: Record<string, unknown> };

test("clicking around produces page views, clicks and API calls with timings, never typed text", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" });
  const batches: { sid: string; app: Record<string, unknown>; ev: Ev[] }[] = [];
  await page.route("**/api/v0/telemetry", async (route) => {
    batches.push(JSON.parse(route.request().postData() ?? "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ accepted: 1, dropped: 0 }) });
  });
  const ids: string[] = [];
  page.on("request", (r: Request) => { if (/\/api\/v0\/(?!telemetry)/.test(r.url()) && r.resourceType() === "fetch") ids.push(r.headers()["x-pulse-request-id"] ?? ""); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dashboard");
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-theme"));
  await page.waitForTimeout(800);

  // A route change by a click, a shortcut that opens the palette, typing into it, and leaving it with Escape.
  await page.getByRole("link", { name: "Settings", exact: true }).first().click();
  await page.waitForURL(/\/settings/);
  await page.waitForTimeout(800);
  await expect(async () => { await page.keyboard.press("Control+k"); await expect(page.getByRole("dialog", { name: "Search Pulse" })).toBeVisible({ timeout: 1000 }); }).toPass();
  await page.getByRole("dialog", { name: "Search Pulse" }).getByRole("combobox").fill("synthetic secret words");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  // The page going away sends what is left at once.
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(() => batches.flatMap((b) => b.ev).some((e) => e.k === "nav.leave"), { timeout: 15_000 }).toBe(true);

  const events = batches.flatMap((b) => b.ev);
  const kinds = new Set(events.map((e) => e.k));
  expect(batches[0].sid).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  expect(batches[0].app).toMatchObject({ plat: "web", dev: "desktop" });
  const load = events.find((e) => e.k === "nav.load");
  expect(load?.d, "page load timed to the settled screen").toBeGreaterThan(0);
  expect(load?.p).toBe("/dashboard");
  const click = events.find((e) => e.k === "ui.click" && e.n === "link /settings");
  expect(click, JSON.stringify([...kinds])).toBeTruthy();
  expect(click!.d).toBeGreaterThanOrEqual(0);
  expect(typeof click!.x?.paint).toBe("number");
  expect(typeof click!.x?.sel).toBe("string");
  const route = events.find((e) => e.k === "nav.route" && e.n?.startsWith("/settings"));
  expect(route?.x?.from).toBe("/dashboard");
  expect(route?.d).toBeGreaterThanOrEqual(0);
  expect(events.some((e) => e.k === "ui.key" && /K$/.test(e.n ?? ""))).toBe(true);
  expect(events.some((e) => e.k === "ui.dialog.open")).toBe(true);
  const api = events.filter((e) => e.k === "api");
  expect(api.length, "the browser's own API calls").toBeGreaterThan(0);
  expect(api.every((e) => /^(GET|POST|PUT) \/api\/v0\//.test(e.n ?? "") && typeof e.d === "number")).toBe(true);
  expect(api.some((e) => typeof e.s === "number" && e.r && ids.includes(e.r)), "the request id the API receives").toBe(true);
  expect(kinds.has("vital.cls") && kinds.has("nav.leave")).toBe(true);
  expect(JSON.stringify(batches)).not.toMatch(/secret|synthetic secret/i);
  expect(JSON.stringify(batches)).not.toContain("admin@estateautopilots.com");
});
