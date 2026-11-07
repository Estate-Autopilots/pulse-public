// CHATS-2 speed check: node chats-timing.mjs [base] [runs] [email] — prints one JSON line per measure (median of runs).
// cold: a fresh browser opens /chats until the first conversation row is visible.
// revisit: the same browser goes to another page and back through the rail link (cache warm).
// reload: the same browser loads /chats again by URL.
// open: a click on another conversation until its messages (or its empty state) show.
import { chromium } from "@playwright/test";
const [base = "http://127.0.0.1:3200", runs = "3", email = "user-668d21b6@estateautopilots.com"] = process.argv.slice(2);
const ROW = 'nav[aria-label="Conversations"] [data-chat-row], nav[aria-label="Conversations"] button';
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)]); };
const result = { cold: [], revisit: [], reload: [], open: [] };
const browser = await chromium.launch();
for (let i = 0; i < Number(runs); i++) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": email } });
  const page = await ctx.newPage();
  // Warm the dev server's compile of other routes so "cold" is the first browser visit, not the first compile.
  await page.goto(`${base}/dashboard`, { waitUntil: "load" });
  await ctx.clearCookies(); await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  const c0 = Date.now(); await page.goto(`${base}/chats`, { waitUntil: "commit" }); await page.locator(ROW).first().waitFor({ timeout: 60000 }); result.cold.push(Date.now() - c0);
  await page.waitForTimeout(1500);
  await page.goto(`${base}/dashboard`, { waitUntil: "load" }); await page.waitForTimeout(500);
  const r0 = Date.now(); await page.locator('a[href="/chats"]').first().click(); await page.locator(ROW).first().waitFor({ timeout: 60000 }); result.revisit.push(Date.now() - r0);
  await page.waitForTimeout(1000);
  const l0 = Date.now(); await page.goto(`${base}/chats`, { waitUntil: "commit" }); await page.locator(ROW).first().waitFor({ timeout: 60000 }); result.reload.push(Date.now() - l0);
  await page.waitForTimeout(1500);
  const rows = page.locator(ROW); const n = await rows.count();
  if (n > 1) {
    const o0 = Date.now(); await rows.nth(Math.min(n - 1, 1 + i)).click();
    await page.waitForFunction(() => { const log = document.querySelector('[role="log"]'); return !!log && (!!log.querySelector("article, [data-chat-empty]") || /Welcome to/.test(log.textContent ?? "")); }, null, { timeout: 60000 }); result.open.push(Date.now() - o0);
  }
  await ctx.close();
}
await browser.close();
for (const [k, v] of Object.entries(result)) if (v.length) console.log(JSON.stringify({ measure: k, medianMs: median(v), runsMs: v }));
