// PR-PIPELINE walk (synthetic data on a scratch database, tests/e2e/pr-pipeline-seed.sql): calendar -> idea (its brief,
// proof and designed images with their checks) -> send to review -> approve -> proof of work -> brand wizard -> weekly
// report -> "Share with…" (opened, never sent). Screenshots at 1440 and 390 to $OUT; fails on page errors and 5xx.
//   WEB=http://127.0.0.1:4690 OUT=/path node tests/e2e/pr-pipeline-walk.mjs
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const base = process.env.WEB ?? "http://127.0.0.1:4690";
const out = process.env.OUT ?? "/tmp/pr-pipeline-shots";
const who = process.env.WHO ?? "asha@example.invalid";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const failures = [];
for (const [w, h, tag] of [[1440, 900, "1440"], [390, 844, "390"]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: w < 600, hasTouch: w < 600 });
  await ctx.route("**/*", (route) => {
    const headers = { ...route.request().headers() };
    if (route.request().url().startsWith(base)) headers["cf-access-authenticated-user-email"] = who;
    return route.continue({ headers });
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => failures.push(`${tag} pageerror ${e.message.slice(0, 200)}`));
  page.on("response", (r) => { if (r.status() >= 500 && r.url().startsWith(base)) failures.push(`${tag} HTTP ${r.status()} ${r.url().slice(base.length)}`); });
  const go = async (path) => {
    await page.goto(base + path, { waitUntil: "networkidle", timeout: 240000 }).catch((e) => failures.push(`${tag} goto ${path} ${e.message.slice(0, 100)}`));
    await page.getByRole("button", { name: "Later", exact: true }).click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(800);
  };
  const shot = (name) => page.screenshot({ path: `${out}/${tag}-${name}.png`, fullPage: true });
  const step = async (name, f) => { try { await f(); } catch (e) { failures.push(`${tag} ${name}: ${e.message.slice(0, 160)}`); } await shot(name).catch(() => {}); console.log(tag, name, "ok"); };

  await step("1-calendar", async () => { await go("/pr?tab=calendar"); await page.getByText(/In review|Draft|Approved/).first().waitFor({ timeout: 30000 }); });
  await step("2-ideas", async () => { await go("/pr?tab=ideas"); await page.locator("article[id^=idea-]").first().waitFor({ timeout: 30000 }); });
  let cardId = null;
  await step("3-review", async () => {
    cardId = await page.locator("article[id^=idea-]").filter({ has: page.getByRole("button", { name: "Send to review" }) }).first().getAttribute("id");
    const card = page.locator(`#${cardId}`);
    await card.getByRole("button", { name: "Send to review" }).click();
    await card.getByRole("button", { name: "Approve" }).waitFor({ timeout: 30000 });
  });
  await step("4-approved", async () => {
    const card = page.locator(`#${cardId}`);
    await card.getByRole("button", { name: "Approve" }).click();
    await card.getByText("Approved", { exact: true }).waitFor({ timeout: 30000 });
  });
  await step("5-proof-of-work", async () => { await go("/pr?tab=pipeline"); await page.getByText("of 100 · proof of work").first().waitFor({ timeout: 30000 }); });
  await step("6-brand-wizard", async () => {
    await go("/pr?tab=brands");
    await page.getByRole("button", { name: "Set up a brand" }).click();
    await page.getByLabel("Brand name").fill("Example Client Brand");
    await page.getByText(/easy to read|too faint/).waitFor({ timeout: 30000 });
  });
  await step("7-weekly-report", async () => { await go("/pr?tab=report"); await page.getByText("Draft, only you see it").first().waitFor({ timeout: 30000 }); });
  await step("8-share-with", async () => {
    await page.getByRole("button", { name: "Share with…" }).first().click();
    await page.getByRole("dialog").getByText("Ravi Example").waitFor({ timeout: 30000 });
  });
  await ctx.close();
}
await browser.close();
if (failures.length) { console.log("FAILURES\n  " + failures.join("\n  ")); process.exit(1); }
console.log("WALK-OK");
