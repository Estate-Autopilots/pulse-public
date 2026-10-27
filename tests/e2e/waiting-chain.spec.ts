import { test, expect } from "@playwright/test";
import { chain } from "./fixtures/waiting-chain.mjs";
const endpoint = "**/api/v0/tasks/tp-task/waiting";
for (const theme of ["light", "dark"]) for (const width of [390, 1440]) {
  test(`${theme} ${width}: three waiting steps fit and retain the add control`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript((t) => localStorage.setItem("pulse.theme", t), theme);
    await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" });
    await page.route(endpoint, (r) => r.fulfill({ json: chain }));
    await page.goto("/tasks/tp-task");
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    const section = page.getByRole("region", { name: "Waiting chain", exact: true });
    await expect(section.getByRole("listitem")).toHaveCount(3);
    await expect(section.getByRole("link", { name: "Approve the synthetic brief" })).toHaveAttribute("href", "/tasks/synthetic-blocker-0");
    await expect(section.getByText("A task you can't open", { exact: true })).toBeVisible();
    await expect(section.getByRole("img", { name: "AI employee", exact: true })).toBeVisible();
    await expect(section.getByText("+2 more", { exact: true })).toBeVisible();
    await expect(section.getByText("Northwind Studio", { exact: true })).toHaveCount(0);
    await expect(section.getByText("Example Partner Studio", { exact: true })).toHaveCount(2);
    const rows = await section.getByRole("listitem").evaluateAll((items) => items.map((i) => ({ left: i.getBoundingClientRect().left, right: i.getBoundingClientRect().right })));
    expect(rows[1].left).toBeGreaterThan(rows[0].left); expect(rows[2].left).toBeGreaterThan(rows[1].left);
    for (const row of rows) { expect(row.left).toBeGreaterThanOrEqual(0); expect(row.right).toBeLessThanOrEqual(width); }
    await section.screenshot({ path: info.outputPath(`waiting-${theme}-${width}.png`) });
    await section.getByRole("button", { name: "Waiting on…", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "What is this task waiting on?" })).toBeVisible();
  });
}
test("an open blocker form survives a task refresh and the chain reloads", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" });
  let reads = 0, release!: () => void, started!: () => void;
  const pending = new Promise<void>((r) => { release = r; }), refreshing = new Promise<void>((r) => { started = r; });
  await page.route(endpoint, (r) => { reads++; return r.fulfill({ json: chain }); });
  await page.goto("/tasks/tp-task");
  const section = page.getByRole("region", { name: "Waiting chain", exact: true });
  await expect(section.getByRole("listitem")).toHaveCount(3);
  await page.route(/\/tasks\/tp-task\?/, async (r) => {
    if (r.request().headers().rsc === "1") { started(); await pending; }
    await r.continue();
  });
  await page.route("**/api/v0/tasks/tp-task/proof", (r) => r.fulfill({ json: { id: "synthetic-proof" } }));
  const proof = page.getByRole("region", { name: "Proof", exact: true });
  await proof.getByRole("textbox", { name: "Proof link" }).fill("https://example.com/synthetic-proof");
  await proof.getByRole("button", { name: "Add link", exact: true }).click();
  await refreshing;
  await section.getByRole("button", { name: "Waiting on…", exact: true }).click();
  const input = page.getByLabel("Search tasks or describe a new one");
  await input.fill("Preserve this synthetic blocker draft");
  release();
  await expect.poll(() => reads).toBe(2);
  await expect(input).toHaveValue("Preserve this synthetic blocker draft");
});
test("loading, error, retry, none and offline recovery", async ({ page, context }) => {
  await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" });
  let release!: () => void;
  const pending = new Promise<void>((r) => { release = r; });
  await page.route(endpoint, async (r) => { await pending; await r.fulfill({ status: 503, json: {} }); });
  await page.goto("/tasks/tp-task");
  const section = page.getByRole("region", { name: "Waiting chain", exact: true });
  await expect(section.getByRole("status", { name: "Loading waiting chain" })).toBeVisible();
  release(); await expect(section.getByRole("alert")).toContainText("could not load");
  await page.unroute(endpoint); await page.route(endpoint, (r) => r.fulfill({ json: { ...chain, steps: [], declared: [], more: 0 } }));
  await section.getByRole("button", { name: "Try again" }).click();
  await expect(section).toContainText("Linked blockers and client waits appear here");
  await page.unroute(endpoint); await page.route(endpoint, (r) => r.abort()); await context.setOffline(true);
  // An online event refreshes this section without polling or reloading the task page.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(section.getByRole("alert")).toContainText("offline");
  await page.unroute(endpoint); await page.route(endpoint, (r) => r.fulfill({ json: chain })); await context.setOffline(false);
  await expect(section.getByRole("listitem")).toHaveCount(3);
});
