// Scratch probe (not committed): node .probe-people.mjs <path> <WxH> <js-expression>
import { chromium } from "@playwright/test";
const [path, size = "1366x650", expr = "1", theme = "light"] = process.argv.slice(2);
const [width, height] = size.split("x").map(Number);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": process.env.EMAIL ?? "admin@estateautopilots.com" } });
await ctx.addInitScript((t) => localStorage.setItem("pulse.theme", t), theme);
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:3200${path}`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
console.log(JSON.stringify(await page.evaluate(expr), null, 1));
await browser.close();
