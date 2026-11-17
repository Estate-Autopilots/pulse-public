// Evidence shots of one element (scrolled into view) at several widths and themes, with its computed style.
//   node element-shots.mjs <base> <path> <email> <selector> <out-prefix> [widths=1440,390,360] [themes=light,dark] [click-text]
// The page is synthetic when <base> is a fixture server (hr-polish-shots.mjs); prints one line per shot.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
const [base, path, email, selector, prefix, widths = "1440,390,360", themes = "light,dark", click = ""] = process.argv.slice(2);
mkdirSync(dirname(prefix), { recursive: true });
const browser = await chromium.launch();
for (const width of widths.split(",").map(Number)) for (const theme of themes.split(",")) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: theme, extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": email } });
  await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); } catch {} }, theme);
  const page = await ctx.newPage();
  try {
    await page.goto(`${base}${path}`, { waitUntil: "load", timeout: 240000 });
    if (click) { await page.locator("main").getByText(click, { exact: true }).first().click(); await page.waitForTimeout(400); }
    const el = page.locator(selector).first();
    await el.waitFor({ timeout: 120000 }); await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(500);
    const file = `${prefix}-${width}-${theme}.png`;
    await el.screenshot({ path: file });
    const style = await el.evaluate((e) => { const c = getComputedStyle(e); return { w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height), border: `${c.borderTopStyle} ${c.borderTopWidth}`, radius: c.borderRadius, font: `${c.fontSize} ${c.fontFamily.split(",")[0]}` }; });
    console.log(`${file} ${JSON.stringify(style)}`);
  } catch (e) { console.log(`${width} ${theme} FAILED ${String(e).slice(0, 200)}`); }
  await ctx.close();
}
await browser.close();
