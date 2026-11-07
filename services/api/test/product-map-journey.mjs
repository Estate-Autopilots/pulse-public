// PRODUCT-MAP: the Product map in a real browser against a running Pulse (pulse-dev by default), as a synthetic leader
// (Access identity), on an app already connected (PM_PRODUCT names it; default "Pulse"): every view at 1440 and 390,
// light and dark, no sideways scroll; open a screen; plan a journey by clicking screens where the last step leads,
// propose a new screen in it, save it and see it in the list with its gap marked; add an idea and vote. What the run
// adds is removed again.
//   PM_BASE=http://127.0.0.1:3200 PM_OUT=~/ea-research/ux/journeys/PRODUCT-MAP node services/api/test/product-map-journey.mjs
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const { chromium } = await import("../../../tests/e2e/node_modules/@playwright/test/index.mjs");
const BASE = process.env.PM_BASE ?? "http://127.0.0.1:3200";
const OUT = process.env.PM_OUT ?? "/tmp/product-map";
const WHO = process.env.PM_WHO ?? "kedab.mifos@synthetic.invalid";
const PRODUCT = process.env.PM_PRODUCT ?? "Pulse";
const run = Date.now().toString(36).slice(-5), JOURNEY = `Journey test ${run}`, SCREEN = `Proposed test screen ${run}`, IDEA = `Idea test ${run}`;
await mkdir(OUT, { recursive: true });
const report = { base: BASE, run, checks: 0, steps: [], shots: [], sideways: [] };
const ok = (c, m) => { report.checks++; assert.ok(c, m); };
const step = (s) => { report.steps.push(s); console.log("·", s); };
const browser = await chromium.launch();
const get = (page, path) => page.evaluate(async (p) => (await fetch(`/api/v0/${p}`, { cache: "no-store" })).json(), path);
const post = (page, path, body = {}) => page.evaluate(async ([p, b]) => { const r = await fetch(`/api/v0/${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return r.json(); }, [path, body]);
async function open({ w = 1440, theme = "light" } = {}) {
  const phone = w < 500;
  const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 900 }, colorScheme: theme, isMobile: phone, hasTouch: phone, extraHTTPHeaders: { "cf-access-authenticated-user-email": WHO } });
  const page = await ctx.newPage(); page.setDefaultTimeout(90_000); page.setDefaultNavigationTimeout(180_000);
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  return { ctx, page };
}
const snap = async (page, name) => { await page.waitForTimeout(450); const path = `${OUT}/${String(report.shots.length + 1).padStart(2, "0")}-${name}.png`; await page.screenshot({ path }); report.shots.push(path); };
const sideways = async (page, where) => { const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1); if (wide) report.sideways.push(where); ok(!wide, `no sideways scroll: ${where}`); };
const tab = (page, name) => page.getByRole("tab", { name: new RegExp(`^${name}`) }).click();

const d = await open();
let productId = null;
try {
  await d.page.goto(`${BASE}/product-map`);
  const list = await get(d.page, "product-map");
  productId = list.products.find((p) => p.name === PRODUCT)?.id;
  ok(productId, `${PRODUCT} is connected`);
  await d.page.goto(`${BASE}/product-map?product=${productId}`);
  await d.page.locator("#main-content").getByRole("heading", { name: "Product map", level: 1 }).waitFor();
  await d.page.locator("#main-content").getByRole("heading", { name: PRODUCT, level: 2, exact: true }).waitFor();
  await snap(d.page, "overview-1440-light"); await sideways(d.page, "overview 1440");
  step("overview");

  await tab(d.page, "Screens"); await d.page.locator("button", { hasText: "/chats" }).first().waitFor();
  await snap(d.page, "screens-1440-light"); await sideways(d.page, "screens 1440");
  await d.page.locator("button", { hasText: "/chats" }).first().click();
  await d.page.getByRole("dialog").getByText("On this screen").waitFor();
  await snap(d.page, "screen-drawer-1440-light");
  await d.page.keyboard.press("Escape");
  step("screens and a screen");

  for (const [t, name] of [["Features", "features"], ["User types", "user-types"], ["Issues", "issues"], ["Build", "build"]]) {
    await tab(d.page, t); await d.page.waitForTimeout(400); await snap(d.page, `${name}-1440-light`); await sideways(d.page, `${name} 1440`);
  }
  step("features, user types, issues, build");

  // Plan a journey: a user type, then screens from where the last step leads, then a new proposed screen.
  await tab(d.page, "Journeys"); await d.page.getByRole("button", { name: "Plan a journey" }).waitFor();
  await snap(d.page, "journeys-1440-light"); await sideways(d.page, "journeys 1440");
  await d.page.getByRole("button", { name: "Plan a journey" }).click();
  const ed = d.page.getByRole("dialog");
  await ed.getByLabel("Journey", { exact: true }).fill(JOURNEY);
  const persona = ed.getByLabel("User type");
  const options = await persona.locator("option").allTextContents();
  await persona.selectOption({ label: options.find((o) => /Team member/.test(o)) ?? options[1] });
  for (let i = 0; i < 2; i++) { await ed.locator('[class*="adder"] [class*="chipOff"]').first().click(); await ed.locator("ol li").nth(i).waitFor(); }
  ok((await ed.locator("ol li").count()) === 2, "two steps added by clicking screens");
  await ed.getByLabel("New screen").fill(SCREEN);
  await ed.getByRole("button", { name: "Propose it" }).click();
  await ed.locator("ol li").nth(2).waitFor();
  await ed.getByLabel("Status").selectOption("planned");
  await snap(d.page, "journey-editor-1440-light");
  await ed.getByRole("button", { name: "Save", exact: true }).click();
  await d.page.getByRole("button", { name: new RegExp(JOURNEY) }).waitFor();
  const map = await get(d.page, `product-map/products/${productId}`);
  const j = map.journeys.find((x) => x.title === JOURNEY);
  ok(j && j.steps.length === 3 && j.status === "planned", "the journey is saved with three steps, planned");
  ok(map.screens.some((s) => s.title === SCREEN && s.proposed), "the proposed screen is in the map");
  const plan = await d.page.evaluate(async ([p, k]) => (await fetch(`/api/v0/product-map/products/${p}/plan?format=md&journeys=${k}`)).text(), [productId, j.key]);
  ok(plan.includes(JOURNEY) && plan.includes("(proposed, to build)") && plan.includes("Acceptance criteria"), "the plan for it reads as Markdown with the proposed screen and acceptance criteria");
  await writeFile(`${OUT}/plan-sample.md`, plan);
  step("journey planned by clicking screens, with a proposed screen; plan exported");

  await tab(d.page, "Ideas"); await d.page.getByRole("button", { name: "Idea", exact: true }).click();
  await d.page.getByRole("dialog").getByLabel("Idea", { exact: true }).fill(IDEA);
  await d.page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await d.page.getByRole("button", { name: new RegExp(IDEA) }).waitFor();
  await d.page.locator("article", { hasText: IDEA }).getByRole("button", { pressed: false }).first().click();
  await d.page.waitForTimeout(900);
  await snap(d.page, "ideas-1440-light");
  step("idea added and voted");

  for (const [w, theme] of [[390, "light"], [390, "dark"], [1440, "dark"]]) {
    const v = await open({ w, theme });
    await v.page.goto(`${BASE}/product-map?product=${productId}`); await v.page.locator("#main-content").getByRole("heading", { name: PRODUCT, level: 2, exact: true }).waitFor();
    await snap(v.page, `overview-${w}-${theme}`); await sideways(v.page, `overview ${w} ${theme}`);
    for (const [t, name] of [["Screens", "screens"], ["User types", "user-types"], ["Journeys", "journeys"], ["Issues", "issues"]]) {
      await tab(v.page, t); await v.page.waitForTimeout(500); await snap(v.page, `${name}-${w}-${theme}`); await sideways(v.page, `${name} ${w} ${theme}`);
    }
    await tab(v.page, "Journeys"); await v.page.locator("button", { hasText: JOURNEY }).first().click(); await v.page.getByRole("dialog").getByText("Steps").first().waitFor();
    await snap(v.page, `journey-editor-${w}-${theme}`);
    await v.ctx.close();
  }
  step("390 and dark");
} finally {
  if (productId) {
    const map = await get(d.page, `product-map/products/${productId}`).catch(() => null);
    for (const j of map?.journeys.filter((x) => /^Journey test [a-z0-9]{5}$/.test(x.title)) ?? []) await post(d.page, `product-map/journeys/${j.id}/remove`);
    for (const s of map?.screens.filter((x) => /^Proposed test screen [a-z0-9]{5}$/.test(x.title)) ?? []) await post(d.page, `product-map/screens/${s.id}/remove`);
    for (const i of map?.ideas.filter((x) => /^Idea test [a-z0-9]{5}$/.test(x.title)) ?? []) await post(d.page, `product-map/ideas/${i.id}/remove`);
  }
  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(`PASS ${report.checks} checks, ${report.shots.length} screenshots in ${OUT}`);
