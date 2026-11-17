// Dev helper: node shot.mjs <path> <name> [width] [theme] [email] — screenshots pulse-dev's local port as a signed-in account.
import { chromium } from "@playwright/test";
const [path = "/", name = "shot", width = "1440", theme = "light", email = "admin@estateautopilots.com", full = ""] = process.argv.slice(2);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: Number(width), height: Number(width) < 500 ? 844 : 900 }, colorScheme: theme, extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": email }, deviceScaleFactor: 1 });
await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); localStorage.setItem("theme", t); } catch {} }, theme);
const page = await ctx.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(`http://127.0.0.1:3200${path}`, { waitUntil: "networkidle" });
await page.waitForFunction(()=>document.querySelector('main h2,main h3,main [class*="__message"]')&&!document.querySelector('main [aria-busy="true"]'),{},{timeout:45000});
await page.waitForTimeout(600);
await page.screenshot({ path: `/tmp/shots/${name}.png`, fullPage: !!full });
if (errors.length) console.log("ERRORS", errors.slice(0, 5));
await browser.close();
