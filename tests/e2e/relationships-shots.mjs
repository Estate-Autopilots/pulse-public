// R46: screenshots of /relationships as an admin on a local preview (Access header sent to Pulse only).
//   node relationships-shots.mjs <base url> <out dir>
// Fails on page errors; prints what each view says it shows (counts, groups) for the report.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const [base = "http://127.0.0.1:3260", out = "/tmp/shots/r46", email = "admin@estateautopilots.com"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const views = [
  ["graph", "/relationships"],
  ["review", "/relationships?view=review"],
  ["development", "/relationships?kind=development"],
  ["unresolved", "/relationships?status=unresolved"],
];
const browser = await chromium.launch();
const errors = [];
for (const [width, height] of [[1440, 900], [390, 844]]) {
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1 });
    await ctx.route(`${base}/**`, (route) => route.continue({ headers: { ...route.request().headers(), "cf-access-authenticated-user-email": email } }).catch(() => {}));
    await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); localStorage.setItem("theme", t); } catch { /* private mode */ } }, theme);
    for (const [name, path] of views) {
      if (theme === "dark" && name !== "graph") continue;
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errors.push(`${name} ${width} ${theme}: ${e.message}`));
      await page.goto(base + path, { waitUntil: "load", timeout: 180000 });
      // The list (or its empty state), not the loading skeleton.
      await page.waitForFunction(() => document.querySelector("main article") || /Nothing waits|No relationships here/.test(document.querySelector("main")?.textContent ?? ""), {}, { timeout: 120000 });
      await page.waitForTimeout(800);
      if (name === "unresolved" && width === 1440) {
        const history = page.getByRole("button", { name: "History" }).first();
        if (await history.count()) { await history.click(); await page.getByLabel("Versions of this relationship").waitFor({ timeout: 30000 }); }
      }
      const facts = await page.evaluate(() => ({
        groups: document.querySelectorAll("main article").length, edges: document.querySelectorAll("main article li[data-status]").length,
        wide: document.documentElement.scrollWidth > window.innerWidth + 1,
      }));
      console.log(JSON.stringify({ name, width, theme, ...facts }));
      if (facts.wide) errors.push(`${name} ${width} ${theme}: page wider than the window`);
      await page.screenshot({ path: `${out}/${name}-${width}-${theme}.png` });
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
