// POLISH-1 Documents on a phone: node documents-timing.mjs <base> <personId> [email] [runs] — one JSON line per measure.
// Timings only: no document, name or page is printed or saved.
// list: the person's Documents tab until its first document row shows; open: "Open" on the largest protected file until
// PDF.js has drawn its first page inside Pulse; reopen: the same file again (kept in memory on the page).
// Each runs on a plain connection and on a 4G-like one (40 ms, 9 Mbit/s down).
import { chromium } from "@playwright/test";
const [base, person, email = "user-668d21b6@estateautopilots.com", runs = "3"] = process.argv.slice(2);
const UA = "Mozilla/5.0 (Linux; Android 13; Redmi Note 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 PulseShell/1.1.2";
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)]); };
const browser = await chromium.launch();
for (const network of ["plain", "4g"]) {
  const result = { list: [], open: [], reopen: [] };
  for (let i = 0; i < Number(runs); i++) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: UA, extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": email } });
    await ctx.addInitScript(() => { localStorage.setItem("pulse.notify.asked", "1"); localStorage.setItem("pulse.arrival.asked", "1"); });
    const page = await ctx.newPage();
    if (network === "4g") { const cdp = await ctx.newCDPSession(page); await cdp.send("Network.enable"); await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: 9e6 / 8, uploadThroughput: 3e6 / 8 }); }
    await page.goto(`${base}/people/${person}?tab=overview`, { waitUntil: "load", timeout: 120000 }); // the route compiled, the phone signed in
    let t = Date.now(); await page.goto(`${base}/people/${person}?tab=documents`, { waitUntil: "commit" });
    // A usable view: the tab's first view with its rows (or the protected files' Open buttons on older pages).
    const view = page.getByRole("button", { name: "Protected documents", exact: true }).or(page.getByRole("link", { name: "Open", exact: true })).first();
    await view.waitFor({ timeout: 90000 }); result.list.push(Date.now() - t);
    const tab = page.getByRole("button", { name: "Protected documents", exact: true });
    const row = page.getByRole("link", { name: "Open", exact: true }).first();
    // A tap before the page is interactive is lost on a slow connection: tap again until the view shows.
    for (let k = 0; k < 20 && await tab.count() && !(await row.isVisible()); k++) { if (await tab.first().isVisible()) await tab.first().click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(500); }
    try { await row.waitFor({ timeout: 30000 }); } catch (e) { console.error(`run ${i} ${network}: no Open after the view; views: ${await page.getByRole("button").allInnerTexts().then((x) => x.slice(0, 30).join(" | "))}`); throw e; }
    const opens = page.getByRole("link", { name: "Open", exact: true }); const n = await opens.count();
    if (process.env.BEFORE) {
      // The page before POLISH-1 opened the file in a new tab; in the phone app that was two full downloads (the WebView's,
      // then the shell's) and then another app. Measured here: the two downloads.
      const href = await opens.first().getAttribute("href");
      t = Date.now(); await page.evaluate(async (h) => { for (let k = 0; k < 2; k++) await (await fetch(h, { cache: "no-store" })).arrayBuffer(); }, href); result.open.push(Date.now() - t);
      await ctx.close(); continue;
    }
    t = Date.now(); await opens.first().click(); void n;
    await page.locator('[role="dialog"] [data-page="1"] canvas[data-drawn="1"]').first().waitFor({ timeout: 90000 }); result.open.push(Date.now() - t);
    await page.keyboard.press("Escape"); await page.waitForTimeout(400);
    t = Date.now(); await opens.first().click(); await page.locator('[role="dialog"] [data-page="1"] canvas[data-drawn="1"]').first().waitFor({ timeout: 90000 }); result.reopen.push(Date.now() - t);
    await ctx.close();
  }
  for (const [k, v] of Object.entries(result)) console.log(JSON.stringify({ network, measure: k, medianMs: median(v), runsMs: v }));
}
await browser.close();
