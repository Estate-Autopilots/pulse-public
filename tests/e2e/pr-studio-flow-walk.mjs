// PR-STUDIO-2 walk (synthetic data on a scratch database: pr-pipeline-seed.sql, then pr-studio-flow-seed.py): Strategy ->
// Calendar (month, week with a drag to another hour, day) -> Board (approve a card) -> Library (a carousel's drawer) ->
// Post kit (mark posted with its link, then log the numbers) -> Insights. Screenshots at 1440 and 390 to $OUT; fails on
// page errors, 5xx answers and missing steps.
//   WEB=http://127.0.0.1:4692 OUT=/path node tests/e2e/pr-studio-flow-walk.mjs
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const base = process.env.WEB ?? "http://127.0.0.1:4692";
const out = process.env.OUT ?? "/tmp/pr-studio-flow-shots";
const who = process.env.WHO ?? "asha@example.invalid";
const BRAND = "00000000-0000-4000-8000-00000000b501";
const READY = { 1440: "00000000-0000-4000-8000-0000000d0001", 390: "00000000-0000-4000-8000-0000000d0002" };
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const failures = [];
for (const [w, h, tag] of [[1440, 900, "1440"], [390, 844, "390"]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: w < 600, hasTouch: w < 600 });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base }).catch(() => {});
  await ctx.route("**/*", (route) => {
    const headers = { ...route.request().headers() };
    if (route.request().url().startsWith(base)) headers["cf-access-authenticated-user-email"] = who;
    return route.continue({ headers });
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => failures.push(`${tag} pageerror ${e.message.slice(0, 200)}`));
  page.on("response", (r) => { if (r.status() >= 500 && r.url().startsWith(base)) failures.push(`${tag} HTTP ${r.status()} ${r.url().slice(base.length)}`); });
  const go = async (path) => {
    await page.goto(`${base}/pr?brand=${BRAND}&${path}`, { waitUntil: "networkidle", timeout: 240000 }).catch((e) => failures.push(`${tag} goto ${path} ${e.message.slice(0, 100)}`));
    await page.getByRole("button", { name: "Later", exact: true }).click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(600);
  };
  const shot = (name) => page.screenshot({ path: `${out}/${tag}-${name}.png`, fullPage: true });
  const step = async (name, f) => { try { await f(); console.log(tag, name, "ok"); } catch (e) { failures.push(`${tag} ${name}: ${e.message.slice(0, 200)}`); console.log(tag, name, "FAILED"); } await shot(name).catch(() => {}); };
  const moved = (path) => page.waitForResponse((r) => r.url().includes(path) && r.request().method() === "POST", { timeout: 30000 });

  await step("1-strategy", async () => { await go("view=strategy"); await page.getByText("Content pillars").waitFor({ timeout: 30000 }); await page.getByText("A usual week, by the hour").waitFor(); });
  await step("2-calendar-month", async () => { await go("view=calendar&cal=month"); await page.getByRole("complementary", { name: "What to post where today" }).getByText(/Example post ready/).first().waitFor({ timeout: 30000 }); });
  await step("3-calendar-week", async () => {
    await go("view=calendar&cal=week");
    await page.getByText("Example thread header").first().waitFor({ timeout: 30000 });
    if (w >= 1000) {
      // Drag tonight's status from 20:00 to 21:00 on the same day: the move is saved.
      const chip = page.locator("a[data-ch=whatsapp_status][data-stage=scheduled]").first();
      const target = page.locator("div[data-today=yes]").nth(21 - 6);
      const wait = moved("/pr/flow/posts/");
      await chip.dragTo(target, { timeout: 15000 }).catch(() => {});
      const r = await wait.catch(() => null);
      if (!r || r.status() !== 200) throw new Error(`the drag did not save (${r ? r.status() : "no request"})`);
    }
  });
  await step("4-calendar-day", async () => { await go("view=calendar&cal=day"); await page.getByText(/Example post ready for the/).first().waitFor({ timeout: 30000 }); });
  await step("5-board", async () => {
    await go("view=board");
    const card = page.locator("article").filter({ hasText: "Example quote in design" });
    await card.waitFor({ timeout: 30000 });
    if (tag === "1440") {
      const wait = moved("/move");
      await card.getByRole("button", { name: /Send to review/ }).click();
      const r = await wait;
      if (r.status() !== 200) throw new Error(`send to review answered ${r.status()}`);
      await page.locator("section[aria-label=Review]").getByText("Example quote in design").waitFor({ timeout: 30000 });
    }
  });
  await step("6-library", async () => {
    await go("view=library");
    await page.getByText("Example carousel: 1,234 synthetic commits").first().click();
    const drawer = page.getByRole("dialog");
    await drawer.getByText("Two hooks to test").waitFor({ timeout: 30000 });
    await drawer.getByText(/Needs Example Partner OK before posting/).waitFor();
    await drawer.getByRole("button", { name: "Next slide" }).click();
    await drawer.getByText("2 / 4").waitFor();
  });
  await step("7-post-kit", async () => {
    await go(`view=kit&post=${READY[tag]}`);
    await page.getByRole("button", { name: "Copy caption" }).first().click();
    await page.getByRole("link", { name: /Download the image/ }).waitFor();
    await page.getByLabel("The post's link").fill(`https://example.invalid/post/walk-${tag}`);
    const wait = moved("/move");
    await page.getByRole("button", { name: "Mark posted" }).click();
    const r = await wait;
    if (r.status() !== 200) throw new Error(`mark posted answered ${r.status()}`);
    await page.getByRole("button", { name: "Save the numbers" }).waitFor({ timeout: 30000 });
  });
  await step("8-numbers", async () => {
    await page.getByLabel("Impressions").fill("1500");
    await page.getByLabel("Reactions").fill("40");
    const wait = moved("/move");
    await page.getByRole("button", { name: "Save the numbers" }).click();
    const r = await wait;
    if (r.status() !== 200) throw new Error(`numbers answered ${r.status()}`);
    await page.getByText("Measured").first().waitFor({ timeout: 30000 });
  });
  await step("9-insights", async () => { await go("view=insights"); await page.getByText("Posts a week against the plan").waitFor({ timeout: 30000 }); await page.getByText("Top posts").waitFor(); });
  await ctx.close();
}
await browser.close();
if (failures.length) { console.log("FAILURES\n" + failures.join("\n")); process.exit(1); }
console.log("WALK OK");
