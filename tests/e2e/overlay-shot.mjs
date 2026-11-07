// Round 6: screenshots and checks the command palette and an edit drawer at a given size. node overlay-shot.mjs <stage> <w>x<h> [light|dark]
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const [stage = "probe", size = "1366x650", theme = "light"] = process.argv.slice(2);
const [width, height] = size.split("x").map(Number);
const out = `/home/eadev/ea-research/round-6/${stage}`; await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": "admin@estateautopilots.com" } });
await ctx.addInitScript((t) => localStorage.setItem("pulse.theme", t), theme);
const page = await ctx.newPage();
const check = () => page.evaluate(() => {
  const f = []; const dlg = document.querySelector('[aria-modal="true"], [role="dialog"]'); if (!dlg) return ["no dialog"];
  for (const el of [dlg, ...dlg.querySelectorAll("*")]) { if (!el.getClientRects().length) continue; const c = getComputedStyle(el); const r = el.getBoundingClientRect();
    if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(c.fontSize) < 11.95) f.push(`text<12 ${el.className} ${c.fontSize}`);
    if (el.matches("button, input:not([type=checkbox]):not([type=radio]), select, a[href]") && r.height < 31.5 && c.display !== "inline") f.push(`tap<32 ${el.tagName} ${el.className} ${Math.round(r.height)}`);
    if (c.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1 && !el.closest("[title]")) f.push(`truncated ${el.textContent.slice(0, 30)}`); }
  const r = dlg.getBoundingClientRect(); if (r.bottom > innerHeight + 1 || r.right > innerWidth + 1) f.push("dialog outside viewport");
  return [...new Set(f)];
});
await page.goto("http://127.0.0.1:3200/dashboard", { waitUntil: "networkidle" }); await page.waitForTimeout(800);
await page.keyboard.press("Control+k"); await page.waitForTimeout(400); await page.keyboard.type("an"); await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/${theme}-${size}-palette.png` }); console.log("palette", await check());
await page.keyboard.press("Escape");
const clients = await (await ctx.request.get("http://127.0.0.1:3200/api/v0/clients")).json();
await page.goto(`http://127.0.0.1:3200/clients/${clients.clients[0].id}`, { waitUntil: "networkidle" }); await page.waitForTimeout(800);
const edit = page.getByRole("button", { name: /edit/i }).first();
if (await edit.count()) { await edit.click(); await page.waitForTimeout(700); await page.screenshot({ path: `${out}/${theme}-${size}-drawer.png` }); console.log("drawer", await check()); await page.keyboard.press("Escape"); }
else console.log("no edit button");
await browser.close();
