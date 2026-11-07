// POLISH-1 mail speed on a phone: node mail-timing.mjs [base] [runs] [email] — one JSON line per measure (median).
// Timings only: nothing from the mailbox is printed or saved, and no screenshot is taken.
// first: a phone that never opened mail (no device cache) until the first conversation row shows;
// again: the same phone reopens mail (its own cache draws first);
// other: a second phone that never opened mail, right after the first (Pulse's last read of the list answers).
import { chromium } from "@playwright/test";
const [base = "http://127.0.0.1:3200", runs = "3", email = "user-668d21b6@estateautopilots.com"] = process.argv.slice(2);
const ROW = '[data-mail] nav[aria-label="Conversations"] [data-chat-row]';
const UA = "Mozilla/5.0 (Linux; Android 13; Redmi Note 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 PulseShell/1.1.2";
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)]); };
const result = { first: [], again: [], other: [] };
const browser = await chromium.launch();
const phone = () => browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA, extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": email } });
async function open(page) { const t = Date.now(); await page.goto(`${base}/chats?source=email`, { waitUntil: "commit" }); await page.locator(ROW).first().waitFor({ timeout: 90000 }); return Date.now() - t; }
for (let i = 0; i < Number(runs); i++) {
  const a = await phone(); const page = await a.newPage();
  // The chats route compiled and the phone signed in first, so "first" is a phone's first mail, not the dev server's compile.
  await page.goto(`${base}/chats`, { waitUntil: "load" }); await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  result.first.push(await open(page)); await page.waitForTimeout(1500);
  await page.goto(`${base}/dashboard`, { waitUntil: "load" });
  result.again.push(await open(page)); await a.close();
  const b = await phone(); const other = await b.newPage();
  await other.goto(`${base}/dashboard`, { waitUntil: "load" });
  result.other.push(await open(other)); await b.close();
  await new Promise((r) => setTimeout(r, 65000)); // past the one-minute fresh window, so each run starts from a stale list
}
await browser.close();
for (const [k, v] of Object.entries(result)) if (v.length) console.log(JSON.stringify({ measure: k, medianMs: median(v), runsMs: v }));
