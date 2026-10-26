import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { creativePeople, creativeView } from "./fixtures/creative.mjs";

test.use({ extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": "admin@creative-on.example" }, reducedMotion: "reduce", timezoneId: "Asia/Kolkata" });
test.skip(!!process.env.PULSE_REAL_SMOKE, "Synthetic fixtures only");
const before = process.env.PULSE_CREATIVE_BEFORE === "1";
async function shot(page: Page, name: string) {
  const out = process.env.PULSE_CREATIVE_SHOTS;
  if (out) { await mkdir(out, { recursive: true }); await page.screenshot({ path: join(out, `${before ? 'before' : 'after'}-${name}.png`), fullPage: true }); }
}
async function choose(page: Page, field: string, person: string) {
  await page.getByRole("button", { name: new RegExp(`^${field}:`) }).click();
  await page.getByRole("listbox", { name: field, exact: true }).getByRole("option", { name: person, exact: true }).click();
}

for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
  test(`intake refusal, Retry and received context at ${width} ${theme}`, async ({ page }) => {
    let refuse = true;
    const view = structuredClone(creativeView), sent: Record<string, string>[] = [];
    await page.route("**/api/**", async (route) => {
      if (route.request().method() === "GET") return route.continue();
      if (!route.request().url().endsWith("/creative/sprints/synthetic-sprint")) return route.abort();
      const body = route.request().postDataJSON(); sent.push(body);
      if (refuse && "package" in body) return route.fulfill({ status: 503, json: { error: "Synthetic refusal" } });
      Object.assign(view.sprint, body);
      return route.fulfill({ json: view });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
    await page.addInitScript((value) => localStorage.setItem("pulse.theme", value), theme);
    await page.goto("/creative/sprints/synthetic-sprint");
    await expect(page.locator('body > div[hidden][id^="S:"]')).toHaveCount(0);
    await expect(page.getByRole("radiogroup", { name: "Package", exact: true })).toHaveAttribute("data-ready", "");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.getByRole("radio", { name: "Plus", exact: true }).click();
    const retry = page.getByRole("button", { name: before ? "Retry" : "Not saved · Retry", exact: true });
    await expect(retry).toBeVisible();
    await shot(page, `intake-refused-${width}-${theme}`);
    if (before) return;
    await expect(page.getByRole("radio", { name: "Plus", exact: true })).toBeChecked();
    await choose(page, "Growth strategist", "Synthetic Creative");
    await expect(retry).toBeVisible();
    await expect(page.getByRole("radio", { name: "Plus", exact: true })).toBeChecked();
    const box = await retry.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    refuse = false; await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(page.getByRole("radio", { name: "Plus", exact: true })).toBeChecked();
    expect(sent.at(-1)?.package).toBe("plus");
    await expect(page.getByText(/^Due before Day 1 · Tue,? 20 Oct$/)).toBeVisible();
    await page.goto("/creative");
    await expect(page.locator('body > div[hidden][id^="S:"]')).toHaveCount(0);
    await expect(page.getByText("Nothing due", { exact: true })).toBeVisible();
    await expect(page.getByText("No active sprint", { exact: true })).toBeVisible();
    await shot(page, `home-empty-${width}-${theme}`);
    let fail = true, release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/v0/creative/choices", async (route) => {
      if (!fail) return route.continue();
      await held; return route.fulfill({ status: 503, json: { error: "Synthetic outage" } });
    });
    await page.getByRole("button", { name: "Start a sprint", exact: true }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("status", { name: "Loading sprint choices" })).toBeVisible();
    await shot(page, `start-loading-${width}-${theme}`); release();
    await expect(drawer.getByText("This didn’t load", { exact: true })).toBeVisible();
    await shot(page, `start-error-${width}-${theme}`);
    fail = false; await drawer.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(drawer.getByRole("button", { name: /^Growth strategist:/ })).toContainText("Me (Synthetic)");
    await shot(page, `start-ready-${width}-${theme}`);
  });
}

test("Start uses local Day 1 and active Me; absent Me requires a choice and an explicit colleague submits", async ({ page }) => {
  test.skip(before);
  await page.clock.install({ time: new Date("2026-10-19T20:00:00Z") }); // 01:30 on 20 Oct in Kolkata
  let absent = false;
  const sent: Record<string, string>[] = [];
  await page.route("**/api/v0/creative/choices", (route) => route.fulfill({ json: { projects: [{ id: "synthetic-project", name: "Synthetic Campaign", client: null }], people: creativePeople, me: absent ? "inactive-person" : "synthetic-gs" } }));
  await page.route("**/api/v0/creative/sprints", (route) => {
    if (route.request().method() === "GET") return route.continue();
    sent.push(route.request().postDataJSON()); return route.fulfill({ json: creativeView });
  });
  await page.goto("/creative");
  await expect(page.locator('body > div[hidden][id^="S:"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Start a sprint", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByLabel("Day 1", { exact: true })).toHaveValue("2026-10-20");
  await expect(drawer.getByRole("button", { name: /^Growth strategist:/ })).toContainText("Me (Synthetic)");
  await drawer.getByRole("button", { name: "Cancel", exact: true }).click();
  absent = true; await page.reload();
  await expect(page.locator('body > div[hidden][id^="S:"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Start a sprint", exact: true }).click();
  await expect(drawer.getByRole("button", { name: /^Growth strategist:/ })).toContainText("Choose someone");
  await choose(page, "Client project", "Synthetic Campaign");
  await drawer.getByRole("button", { name: "Start the sprint", exact: true }).click();
  await expect(drawer.getByRole("alert")).toHaveText("Choose the growth strategist"); expect(sent).toHaveLength(0);
  await choose(page, "Growth strategist", "Synthetic Creative");
  await choose(page, "Creative strategist", "Synthetic Growth");
  await drawer.getByLabel("Client approver (one named person)").fill("Synthetic Approver");
  await drawer.getByRole("button", { name: "Start the sprint", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1); expect(sent[0].gsPersonId).toBe("synthetic-cs"); expect(sent[0].dayOne).toBe("2026-10-20");
});

for (const part of ["home", "sprints", "config", "detail"]) {
  test(`${part} transient failure retries without a false empty state`, async ({ page }) => {
    test.skip(before);
    await page.setExtraHTTPHeaders({ "Cf-Access-Authenticated-User-Email": `creative-${part}-error@creative-on.example` });
    await page.goto(part === "detail" ? "/creative/sprints/synthetic-sprint" : "/creative");
    await expect(page.locator('body > div[hidden][id^="S:"]')).toHaveCount(0);
    await expect(page.getByText("This didn’t load", { exact: true })).toBeVisible();
    if (part === "sprints") await expect(page.getByText("No active sprint", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Try again", exact: true }).first().click();
    await expect(page.getByText("This didn’t load", { exact: true })).toHaveCount(0);
  });
}

test("Whose Home and Start choices show loading, failure and a working retry", async ({ page }) => {
  test.skip(before);
  let state = "loading", release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v0/creative/choices", async (route) => {
    if (state === "loading") await held;
    return state === "good" ? route.continue() : route.fulfill({ status: 503, json: { error: "Synthetic outage" } });
  });
  await page.goto("/creative");
  await expect(page.locator('body > div[hidden][id^="S:"]')).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Loading Whose Home", exact: true })).toBeVisible();
  release(); state = "failed";
  await expect(page.getByRole("button", { name: "Whose Home · Try again", exact: true })).toBeVisible();
  state = "good"; await page.getByRole("button", { name: "Whose Home · Try again", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Whose Home:/ })).toBeVisible();
  state = "failed"; await page.getByRole("button", { name: "Start a sprint", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText("This didn’t load", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Every project already has a sprint", { exact: true })).toHaveCount(0);
  state = "good"; await drawer.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(drawer.getByRole("button", { name: /^Client project:/ })).toBeVisible();
});

for (const [id, title] of [["forbidden", "This sprint is not yours to open"], ["missing", "Sprint not found"]]) {
  test(`detail ${id} is distinct from a transient failure`, async ({ page }) => {
    test.skip(before); await page.goto(`/creative/sprints/${id}`);
    await expect(page.locator('body > div[hidden][id^="S:"]')).toHaveCount(0);
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
  });
}
