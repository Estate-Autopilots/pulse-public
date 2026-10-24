// CHAT-V3 speed check on a running Pulse (pulse-dev by default), as synthetic people only (nobody real is messaged).
//   node tests/e2e/chat-v3-timing.mjs [web base] [api base] [runs]
// Seeds once: a group "Chat V3 bench (test)" (Kedab, Asha, Neha) with ~1200 messages, made through the API as them.
// Prints one JSON line per measure (median of runs, and every run):
//   cold     a fresh browser opens /chats until the first conversation row shows
//   open     a click on the bench group until its messages show (not cached)
//   switch   to another conversation and back (cached)
//   send     Enter until my bubble shows (optimistic), and until it is stored (sendStored)
//   receive  Asha sends through the API until the bubble shows in Kedab's open conversation
//   search   Enter in the list's search until messages are listed
//   older    scrolled to the top until the earlier messages are drawn
//   blocking long tasks (ms over 50) while opening the bench group and scrolling up three screens
import { chromium } from "@playwright/test";
const [base = "http://127.0.0.1:3200", apiBase = "http://127.0.0.1:3203", runs = "3"] = process.argv.slice(2);
const KEDAB = "kedab.mifos@synthetic.invalid", ASHA = "asha.kireteso@synthetic.invalid", NEHA = "neha.soniba@synthetic.invalid";
const BENCH = "Chat V3 bench (test)", SEED = Number(process.env.CHAT_V3_SEED ?? 1200);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)]); };
async function api(as, path, body) {
  const r = await fetch(`${apiBase}/api/v0/${path}`, { method: body ? "POST" : "GET", headers: { "cf-access-authenticated-user-email": as, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${path}: ${d.error ?? r.status}`); return d;
}
const me = async (as) => (await api(as, "me")).person;
const [kedab, asha, neha] = [await me(KEDAB), await me(ASHA), await me(NEHA)];
let list = await api(KEDAB, "chats");
let bench = list.channels.find((c) => c.name === BENCH && !c.moderationOnly);
if (!bench) { const { id } = await api(KEDAB, "chats/groups", { name: BENCH, memberIds: [asha, neha] }); list = await api(KEDAB, "chats"); bench = list.channels.find((c) => c.id === id); }
const have = (await api(KEDAB, `chats/${bench.id}/messages?flat=1`)).hasMore ? SEED : 0;
if (!have) {
  const who = [KEDAB, ASHA, NEHA], words = "draft brochure reel script revision client approved payment shoot edit thumbnail caption voiceover colour logo site visit".split(" ");
  for (let i = 0; i < SEED; i += 6) await Promise.all(Array.from({ length: Math.min(6, SEED - i) }, (_, k) => {
    const n = i + k, w = (j) => words[(n * 7 + j * 3) % words.length];
    return api(who[n % 3], `chats/${bench.id}/messages`, { body: `Bench ${n}: the ${w(1)} for the ${w(2)} ${n % 5 ? "" : `is ready, take a look at the ${w(3)} and tell me what to change before we send it`}`.trim(), attachments: [], clientId: crypto.randomUUID() });
  }));
}
const other = list.channels.find((c) => c.id !== bench.id && !c.moderationOnly && c.lastAt);
const out = { cold: [], open: [], switch: [], send: [], sendStored: [], receive: [], search: [], older: [], blocking: [] };
const browser = await chromium.launch();
const ROW = '[data-chat-row]';
for (let i = 0; i < Number(runs); i++) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "cf-access-authenticated-user-email": KEDAB } });
  await ctx.addInitScript(() => { window.__long = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long += Math.max(0, e.duration - 50); }).observe({ type: "longtask", buffered: true }); } catch { /* no longtask API */ } });
  const page = await ctx.newPage();
  await page.goto(`${base}/dashboard`, { waitUntil: "load", timeout: 120000 });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  let t = Date.now(); await page.goto(`${base}/chats`, { waitUntil: "commit" }); await page.locator(ROW).first().waitFor({ timeout: 60000 }); out.cold.push(Date.now() - t);
  await page.waitForTimeout(1500);
  const benchRow = page.locator(`${ROW}:has-text("${BENCH}")`).first();
  await page.evaluate(() => { window.__long = 0; });
  t = Date.now(); await benchRow.click(); await page.locator('[role="log"] article[id^="m-"]').first().waitFor({ timeout: 60000 }); out.open.push(Date.now() - t);
  await page.waitForTimeout(800);
  // Older: scroll the log to the top three times.
  const log = page.locator('[role="log"]');
  const before = await log.locator('article[id^="m-"]').count();
  t = Date.now();
  for (let s = 0; s < 3; s++) { await log.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); }); await page.waitForTimeout(150); }
  await page.waitForFunction((n) => document.querySelectorAll('[role="log"] article[id^="m-"]').length > n, before, { timeout: 20000 }).catch(() => {});
  out.older.push(Date.now() - t);
  out.blocking.push(Math.round(await page.evaluate(() => window.__long)));
  if (other) {
    await page.locator(`${ROW}:has-text("${other.name}")`).first().click(); await page.waitForTimeout(700);
    t = Date.now(); await benchRow.click(); await page.locator('[role="log"] article[id^="m-"]').first().waitFor({ timeout: 60000 }); out.switch.push(Date.now() - t);
    await page.waitForTimeout(700);
  }
  // Send: as Kedab, in the bench group.
  const text = `Timing ${Date.now()} ${i}`;
  const box = page.locator("[data-chat-composer] textarea"); await box.click(); await box.fill(text);
  t = Date.now(); await box.press("Enter");
  const mine = page.locator(`[role="log"] article[id^="m-"]:has-text("${text}")`);
  await mine.first().waitFor({ timeout: 30000 }); out.send.push(Date.now() - t);
  await page.waitForFunction((x) => [...document.querySelectorAll('[role="log"] article[id^="m-"]')].some((a) => a.textContent.includes(x) && !a.hasAttribute("data-pending") && !a.id.startsWith("m-local-")), text, { timeout: 30000 }); out.sendStored.push(Date.now() - t);
  // Receive: Asha writes through the API.
  await page.waitForTimeout(2500);
  const theirs = `From Asha ${Date.now()} ${i}`;
  t = Date.now(); await api(ASHA, `chats/${bench.id}/messages`, { body: theirs, attachments: [], clientId: crypto.randomUUID() });
  await page.locator(`[role="log"] article:has-text("${theirs}")`).first().waitFor({ timeout: 30000 }); out.receive.push(Date.now() - t);
  // Search from the list.
  const q = page.getByRole("textbox", { name: /Search chats and people/ });
  if (await q.count()) {
    await q.fill("brochure"); t = Date.now(); await q.press("Enter");
    await page.locator('section[aria-label="Messages"]').first().waitFor({ timeout: 30000 }); out.search.push(Date.now() - t);
  }
  await ctx.close();
}
await browser.close();
for (const [k, v] of Object.entries(out)) if (v.length) console.log(JSON.stringify({ measure: k, medianMs: median(v), runsMs: v }));
