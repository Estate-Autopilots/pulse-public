// CHAT-V6 checks on a running Pulse as Kedab (synthetic): reminders and scheduled in one place, the emoji picker
// (search, categories, keyboard, phone), find and jump far back in a long chat, drawing only what is near the screen
// (and keeping the place while pages load above), the Threads tab in the chat dock, a muted chat's @everyone.
//   BASE=http://127.0.0.1:3200 API=http://127.0.0.1:3203 node tests/e2e/chat-v6-check.mjs [shots dir] [only]
// Uses "Brochure launch (test)" (tests/e2e/chat-v4-seed.mjs) and "Long history (test)" (tests/e2e/chat-v6-seed.mjs);
// writes only into those synthetic groups.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
const base = process.env.BASE ?? "http://127.0.0.1:3200", apiBase = process.env.API ?? "http://127.0.0.1:3203", shots = process.argv[2], only = process.argv[3];
const P = { kedab: "kedab.mifos@synthetic.invalid", asha: "asha.kireteso@synthetic.invalid", neha: "neha.soniba@synthetic.invalid" };
async function api(as, path, body) {
  const r = await fetch(`${apiBase}/api/v0/${path}`, { method: body ? "POST" : "GET", headers: { "cf-access-authenticated-user-email": P[as], ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${as} ${path}: ${d.error ?? r.status}`); return d;
}
const say = async (who, channel, body, extra = {}) => (await api(who, `chats/${channel}/messages`, { body, attachments: [], clientId: crypto.randomUUID(), ...extra })).message;
const list = await api("kedab", "chats");
const group = list.channels.find((c) => c.name === "Brochure launch (test)"); assert.ok(group, "seed first: tests/e2e/chat-v4-seed.mjs");
const long = list.channels.find((c) => c.name === "Long history (test)"); assert.ok(long, "seed first: tests/e2e/chat-v6-seed.mjs");
const browser = await chromium.launch(); const results = [];
let page;
const check = async (name, fn) => {
  if (only && !name.includes(only)) return;
  try { await fn(); results.push(["PASS", name]); }
  catch (e) {
    const at = String(e.stack ?? "").split("\n").find((l) => l.includes("chat-v6-check.mjs")) ?? "";
    results.push(["FAIL", name, String(e.message).split("\n")[0], at.trim()]);
    if (shots) await page.screenshot({ path: `${shots}/fail-${name.split(":")[0].replace(/\W+/g, "-")}.png` }).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
  }
};
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "cf-access-authenticated-user-email": P.kedab } });
page = await ctx.newPage();
const open = async (ch, q = "") => { await page.goto(`${base}/chats?channel=${ch.id}${q}`, { waitUntil: "load", timeout: 120000 }); await page.locator('[role="log"] article[id^="m-"]').first().waitFor({ timeout: 60000 }); await page.waitForTimeout(800); };
const box = () => page.getByRole("textbox", { name: /^Message / });
/** Where a message is on screen (null when it is not drawn). */
const where = (id) => page.evaluate((id) => { const el = document.getElementById(`m-${id}`), log = document.querySelector('[role="log"]'); if (!el || !log) return null; const r = el.getBoundingClientRect(), l = log.getBoundingClientRect(); return { top: r.top - l.top, bottom: r.bottom - l.top, height: l.height }; }, id);
const inView = async (id) => { const w = await where(id); return !!w && w.bottom > 0 && w.top < w.height; };

await check("muted @everyone: no @ badge while muted, the badge when not", async () => {
  const mentions = async () => (await api("kedab", "chats")).channels.find((c) => c.id === group.id).mentions;
  await api("kedab", `chats/${group.id}/read`, { through: new Date(Date.now() + 2000).toISOString() });
  await api("kedab", `chats/${group.id}/mute`, { until: "always" });
  try {
    await say("asha", group.id, "@everyone proofs are in the folder (test)");
    assert.equal(await mentions(), 0);
  } finally { await api("kedab", `chats/${group.id}/mute`, { until: null }); }
  assert.equal(await mentions(), 1);
  await api("kedab", `chats/${group.id}/read`, { through: new Date(Date.now() + 2000).toISOString() });
});

await check("reminders and scheduled: one screen from the list's menu and the message box's clock; change a time, cancel", async () => {
  const m = await say("neha", group.id, "Collect the signed booking form from the client (test)");
  const r = await api("kedab", `chats/messages/${m.id}/remind`, { at: new Date(Date.now() + 2 * 3600000).toISOString() });
  const s = await api("kedab", `chats/${group.id}/scheduled`, { body: "Good morning, proofs at 10 (test)", attachments: [], at: new Date(Date.now() + 26 * 3600000).toISOString() });
  try {
    await page.goto(`${base}/chats`, { waitUntil: "load", timeout: 120000 });
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.locator("[data-later-open]").click();
    const rem = page.locator(`[data-later-reminder="${r.id}"]`); await rem.waitFor({ timeout: 20000 });
    await page.locator(`[data-later-scheduled="${s.id}"]`).waitFor();
    assert.match(await rem.textContent(), /Collect the signed booking form/);
    if (shots) await page.screenshot({ path: `${shots}/check-later-1440.png` });
    // Change the reminder's time: "Tomorrow, 9:00 am".
    await rem.getByRole("button", { name: "Change time" }).click();
    const dlg = page.getByRole("dialog", { name: "Remind me about this message" }); await dlg.waitFor();
    await dlg.getByRole("button", { name: /^Tomorrow/ }).click();
    await page.waitForFunction(async () => true);
    await page.waitForTimeout(1500);
    const mine = (await api("kedab", "chats/reminders")).reminders.find((x) => x.messageId === m.id);
    assert.ok(mine && Date.parse(mine.at) > Date.now() + 5 * 3600000, "moved to tomorrow");
    // Cancel the scheduled message.
    await page.locator(`[data-later-scheduled="${s.id}"]`).getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator(`[data-later-scheduled="${s.id}"]`).waitFor({ state: "detached", timeout: 10000 });
    assert.ok(!(await api("kedab", "chats/scheduled")).scheduled.some((x) => x.id === s.id));
    // From the message box's clock (Send later): all of them.
    await open(group);
    await box().fill("Later words (test)"); await page.locator("[data-send-later]").click();
    await page.getByRole("dialog", { name: "Send later" }).locator("[data-later-all]").click();
    await page.locator("[data-later-list]").waitFor({ timeout: 10000 });
    await box().fill("");
    const again = (await api("kedab", "chats/reminders")).reminders.find((x) => x.messageId === m.id);
    if (again) await api("kedab", `chats/reminders/${again.id}/cancel`, {});
  } finally { await api("kedab", `chats/scheduled/${s.id}/cancel`, {}).catch(() => {}); }
});

await check("emoji picker: search, categories, arrows and Enter", async () => {
  await open(group);
  await page.locator("[data-emoji-toggle]").click();
  const picker = page.locator("[data-emoji-picker]"); await picker.waitFor();
  const search = picker.getByRole("combobox", { name: "Search emoji" });
  assert.ok(await search.evaluate((el) => el === document.activeElement), "search has the focus");
  await search.fill("party");
  await picker.locator('[data-emoji="🥳"]').waitFor();
  // Arrows move the active cell; Enter puts it in the box.
  const active = async () => picker.locator("[data-active]").getAttribute("data-emoji");
  const firstHit = await active();
  await search.press("ArrowRight"); const second = await active(); assert.notEqual(second, firstHit);
  await search.press("Enter");
  assert.ok((await box().inputValue()).includes(second), "the picked emoji is in the box");
  // Categories: the Food tab scrolls to its section and is marked.
  await search.fill("");
  await picker.locator('[data-emoji-tab="food"]').click(); await page.waitForTimeout(400);
  assert.equal(await picker.locator('[data-emoji-tab="food"]').getAttribute("aria-selected"), "true");
  // Down moves a whole row (same column).
  await search.focus(); const before = await active(); await search.press("ArrowDown"); const after = await active();
  assert.notEqual(before, after);
  if (shots) await page.screenshot({ path: `${shots}/check-emoji-1440.png` });
  await search.press("Escape"); await picker.waitFor({ state: "detached" });
  await box().fill("");
});

await check("find far back: a match 1,400 messages up opens in place, then back to the latest", async () => {
  await open(long);
  await page.keyboard.press("Control+Shift+F");
  await page.locator("[data-find-bar] input").fill("zebracrossing");
  const far = (await api("kedab", `chats/search?q=zebracrossing&channel=${long.id}`)).messages[0];
  await page.waitForFunction((id) => !!document.getElementById(`m-${id}`), far.id, { timeout: 20000 });
  await page.waitForTimeout(600);
  assert.ok(await inView(far.id), "the match is on screen");
  assert.ok(await page.locator(`#m-${far.id}[data-flash]`).count() <= 1);
  if (shots) await page.screenshot({ path: `${shots}/check-find-far-1440.png` });
  // Reading down from there loads on towards the latest; the way-down button goes there at once.
  await page.locator("[data-find-bar] input").press("Escape");
  await page.getByRole("button", { name: /Scroll to the latest|scroll to the latest/ }).click();
  const newest = (await api("kedab", `chats/${long.id}/messages`)).messages.at(-1);
  await page.waitForFunction((id) => !!document.getElementById(`m-${id}`), newest.id, { timeout: 15000 });
  await page.waitForTimeout(500);
  assert.ok(await inView(newest.id), "the latest is on screen");
});

await check("long chat: only what is near the screen is drawn, and the place holds while earlier pages load", async () => {
  await open(long);
  const drawn = await page.locator('[role="log"] article[id^="m-"]').count();
  // Scroll far up, a screen at a time: earlier pages load (60 each) while only what is near the screen is drawn.
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => { const log = document.querySelector('[role="log"]'); log.scrollTop = Math.max(0, log.scrollTop - log.clientHeight * 0.9); });
    await page.waitForTimeout(700);
  }
  const many = await page.locator('[role="log"] article[id^="m-"]').count();
  assert.ok(many < 160, `drawn ${many} of the loaded messages`);
  assert.ok(drawn < 160, `drawn at open: ${drawn}`);
  // Hold: near the top an earlier page loads above; the message on screen must not move.
  const a = await page.evaluate(async () => { const log = document.querySelector('[role="log"]'); log.scrollTop = 150; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const top = log.getBoundingClientRect().top; const el = [...log.querySelectorAll("article[id^='m-']")].find((x) => x.getBoundingClientRect().top > top + 40); return { id: el.id.slice(2), top: el.getBoundingClientRect().top - top, h: log.scrollHeight }; });
  await page.waitForTimeout(2500);   // the earlier page (scrollTop < 200) goes in above
  const b = await where(a.id);
  assert.ok(await page.evaluate((h) => document.querySelector('[role="log"]').scrollHeight > h + 1000, a.h), "an earlier page went in above");
  assert.ok(b && Math.abs(b.top - a.top) < 6, `the message moved ${b ? Math.round(b.top - a.top) : "off screen"} px while a page loaded above it`);
  if (shots) await page.screenshot({ path: `${shots}/check-long-1440.png` });
});

await check("long chat: opening with 5 unread starts at the first of them", async () => {
  await api("kedab", `chats/${long.id}/read`, { through: new Date(Date.now() + 1000).toISOString() });
  await page.waitForTimeout(1200);
  const firstNew = await say("asha", long.id, "Unread one: the site photos are uploaded (test)");
  for (let i = 2; i <= 5; i++) await say("asha", long.id, `Unread ${i} (test)`);
  await page.goto(`${base}/chats`, { waitUntil: "load" });
  const row = page.locator(`[data-chat-row][data-unread]:has-text("Long history (test)")`).first(); await row.waitFor({ timeout: 30000 });
  await page.waitForFunction(() => /Unread 5 \(test\)/.test(document.querySelector('[data-chat-row][data-unread]')?.closest("nav")?.textContent ?? ""), null, { timeout: 30000 });
  await row.click();
  await page.locator("[data-unread-line]").waitFor({ timeout: 20000 }); await page.waitForTimeout(800);
  assert.ok(await inView(firstNew.id), "the first unread message is on screen");
});

await check("dock: Threads tab lists my threads, opens one with its replies, and replies there", async () => {
  const root = await say("kedab", group.id, "Which courier for the brochures? (test)");
  await say("asha", group.id, "Blue Dart, same day (test)", { parentId: root.id });
  await page.goto(`${base}/dashboard`, { waitUntil: "load", timeout: 120000 });
  await page.locator("[data-chat-dock]").click();
  await page.locator("[data-dock-threads]").click();
  const row = page.locator(`[data-dock-thread-row="${root.id}"]`); await row.waitFor({ timeout: 20000 });
  assert.equal(await row.getAttribute("data-unread"), "");
  await row.click();
  const pane = page.locator(`[data-dock-thread="${root.id}"]`); await pane.getByText("Blue Dart, same day").waitFor({ timeout: 15000 });
  await page.getByRole("textbox", { name: "Reply in the thread" }).fill("Booked them for 4 pm (test)");
  await page.getByRole("button", { name: "Send the reply" }).click();
  await pane.getByText("Booked them for 4 pm").waitFor({ timeout: 15000 });
  if (shots) await page.screenshot({ path: `${shots}/check-dock-threads-1440.png` });
  const t = (await api("kedab", "chats/threads")).threads.find((x) => x.rootId === root.id);
  assert.equal(t.unread, 0); assert.equal(t.replies, 2);
  await page.getByRole("button", { name: "Close the chat" }).click();
});

// Phone: the picker is a sheet over the messages, inside the screen, with 44 px cells; a tap puts emoji in the box
// without opening the keyboard (the box is not focused).
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, extraHTTPHeaders: { "cf-access-authenticated-user-email": P.kedab } });
await check("emoji picker on a phone: inside the screen, big cells, no keyboard", async () => {
  page = await phone.newPage();
  await open(group);
  await page.locator("[data-emoji-toggle]").tap();
  const picker = page.locator("[data-emoji-picker]"); await picker.waitFor();
  const r = await picker.boundingBox(); assert.ok(r.x >= 0 && r.x + r.width <= 391, `picker ${Math.round(r.x)}..${Math.round(r.x + r.width)}`);
  const cell = await picker.locator("[data-emoji]").first().boundingBox(); assert.ok(cell.height >= 40, `cell ${cell.height}px`);
  await picker.locator('[data-emoji="👍"]:not([data-recent-emoji])').first().tap();
  await picker.locator('[data-emoji="🙏"]:not([data-recent-emoji])').first().tap();
  assert.ok((await box().inputValue()).endsWith("👍🙏"));
  assert.ok(!(await box().evaluate((el) => el === document.activeElement)), "the box is not focused (no keyboard)");
  if (shots) await page.screenshot({ path: `${shots}/check-emoji-390.png` });
  await page.getByRole("button", { name: "Close emoji" }).tap();
  await box().fill("");
});

await browser.close();
for (const r of results) console.log(r.join(" | "));
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`${results.length - failed}/${results.length} pass`);
process.exit(failed ? 1 : 0);
