// CHAT-V5 checks on a running Pulse as Kedab (synthetic): the Threads inbox, reminders, send later, polls, @everyone,
// recent emoji, press and hold on a phone (touch), and the UX sweep (Ctrl+K, Ctrl+/, Up to edit, find with marks,
// offline banner).
//   BASE=http://127.0.0.1:3200 API=http://127.0.0.1:3203 node tests/e2e/chat-v5-check.mjs [shots dir] [only]
// Uses the group of tests/e2e/chat-v4-seed.mjs; writes only into that synthetic group (synthetic people, "(test)" words).
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
const browser = await chromium.launch(); const results = [];
const check = async (name, fn) => {
  if (only && !name.includes(only)) return;
  try { await fn(); results.push(["PASS", name]); }
  catch (e) {
    const at = String(e.stack ?? "").split("\n").find((l) => l.includes("chat-v5-check.mjs")) ?? "";
    results.push(["FAIL", name, String(e.message).split("\n")[0], at.trim()]);
    if (shots) await page.screenshot({ path: `${shots}/fail-${name.split(":")[0].replace(/\W+/g, "-")}.png` }).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
  }
};
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "cf-access-authenticated-user-email": P.kedab } });
const page = await ctx.newPage();
const open = async (q = "") => { await page.goto(`${base}/chats?channel=${group.id}${q}`, { waitUntil: "load", timeout: 120000 }); await page.locator('[role="log"] article[id^="m-"]').first().waitFor({ timeout: 60000 }); };
const box = () => page.getByRole("textbox", { name: /^Message / });
await open();

await check("threads inbox: a reply in my thread shows unread first and opening it reads it", async () => {
  const root = await say("kedab", group.id, "Which paper for the brochure cover? (test)");
  await say("asha", group.id, "Matte, 300 gsm (test)", { parentId: root.id });
  await page.reload({ waitUntil: "load" });
  const tab = page.locator('[role="tab"][data-filter="threads"]'); await tab.waitFor({ timeout: 30000 });
  await page.waitForFunction(() => /Threads \d/.test(document.querySelector('[role="tab"][data-filter="threads"]')?.textContent ?? ""), null, { timeout: 20000 });
  await tab.click();
  const row = page.locator(`[data-thread-row="${root.id}"]`); await row.waitFor({ timeout: 15000 });
  assert.equal(await row.getAttribute("data-unread"), "");
  assert.equal(await page.locator("[data-thread-row]").first().getAttribute("data-thread-row"), root.id, "unread first");
  if (shots) await page.screenshot({ path: `${shots}/check-threads-1440.png` });
  await row.click();
  await page.locator("[data-thread-pane]").getByText("Matte, 300 gsm").waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
  const t = (await api("kedab", "chats/threads")).threads.find((x) => x.rootId === root.id);
  assert.equal(t.unread, 0);
  await page.getByRole("button", { name: "Close the thread" }).click();
  await page.locator('[role="tab"][data-filter="all"]').click();
});

await check("remind me: set from the message menu, shown on the bubble, rings as a notification and a chip", async () => {
  await open();
  const m = await say("neha", group.id, "Client call moved to Monday 11 am (test)");
  await page.locator(`#m-${m.id}`).waitFor({ timeout: 20000 });
  await page.locator(`#m-${m.id}`).hover(); await page.locator(`#m-${m.id} [aria-label="More actions"]`).click();
  await page.getByRole("menuitem", { name: "Remind me" }).click();
  const dlg = page.getByRole("dialog", { name: "Remind me about this message" }); await dlg.waitFor();
  if (shots) await page.screenshot({ path: `${shots}/check-remind-1440.png` });
  await dlg.getByRole("button", { name: /In 20 minutes/ }).click();
  await page.locator(`#m-${m.id} [data-reminder]`).waitFor({ timeout: 10000 });
  // Ring one soon through the API (the API's timer delivers what is due every 10 s).
  const m2 = await say("neha", group.id, "Send the print proof (test)");
  await api("kedab", `chats/messages/${m2.id}/remind`, { at: new Date(Date.now() + 32000).toISOString() });
  await page.goto(`${base}/chats`, { waitUntil: "load" });
  const row = page.locator(`[data-chat-row]:has-text("${group.name}")`).first();
  await row.locator("[data-reminder-chip]").waitFor({ timeout: 75000 });
  // The notification itself ("Reminder: <words>", a mention-priority push) is checked in tests/core/test_chat_v5.py.
  if (shots) await page.screenshot({ path: `${shots}/check-reminder-chip-1440.png` });
  await row.click(); await page.waitForTimeout(2000);
  await page.locator(`[data-chat-row]:has-text("${group.name}") [data-reminder-chip]`).waitFor({ state: "detached", timeout: 15000 });
});

await check("send later: scheduled from the box, waits in the bar, sent now from there", async () => {
  await open();
  await box().fill("Reminder for all: shoot at 10 tomorrow (test)");
  await page.locator("[data-send-later]").click();
  const dlg = page.getByRole("dialog", { name: "Send later" }); await dlg.waitFor();
  await dlg.getByRole("button", { name: /^Tomorrow/ }).first().click();
  const bar = page.locator("[data-scheduled-bar]"); await bar.waitFor({ timeout: 10000 });
  assert.equal(await box().inputValue(), "");
  await bar.getByRole("button", { name: /scheduled message/ }).click();
  if (shots) await page.screenshot({ path: `${shots}/check-scheduled-1440.png` });
  const item = bar.locator("[data-scheduled-item]").filter({ hasText: "shoot at 10 tomorrow" }).first();
  await item.getByRole("button", { name: "Send now" }).click();
  await page.locator('[role="log"]').getByText("Reminder for all: shoot at 10 tomorrow (test)").last().waitFor({ timeout: 20000 });
});

await check("a poll: created from the menu, voted on, results live, closed", async () => {
  await open();
  const before = await page.locator("[data-poll]").count();
  await page.getByRole("button", { name: /^Conversation options$/ }).click();
  await page.locator("[data-poll-open]").click();
  const dlg = page.getByRole("dialog", { name: "Create a poll" }); await dlg.waitFor();
  await dlg.getByLabel("Question").fill("Which cover goes to print? (test)");
  await dlg.getByLabel("Choice 1", { exact: true }).fill("Garden"); await dlg.getByLabel("Choice 2", { exact: true }).fill("Sea view"); await dlg.getByLabel("Choice 3", { exact: true }).fill("Night shot");
  await dlg.getByRole("button", { name: "Send the poll" }).click();
  await page.waitForFunction((n) => document.querySelectorAll("[data-poll]").length > n, before, { timeout: 15000 });
  const poll = page.locator(`[data-poll="${await page.locator("[data-poll]").last().getAttribute("data-poll")}"]`);
  await poll.getByRole("radio", { name: /Sea view/ }).click();
  const id = await poll.getAttribute("data-poll");
  await api("asha", `chats/messages/${id}/vote`, { choices: [1] });
  await poll.getByText(/2 people voted/).waitFor({ timeout: 15000 });
  if (shots) await page.screenshot({ path: `${shots}/check-poll-1440.png` });
  await poll.getByRole("button", { name: "Close the poll" }).click();
  await page.locator(`[data-poll="${id}"][data-closed]`).waitFor({ timeout: 15000 });
});

await check("@everyone: offered in the people list and marked in the message", async () => {
  await open();
  await box().fill("@ev");
  const opt = page.getByRole("listbox", { name: "People" }).locator('[data-broadcast="everyone"]'); await opt.waitFor({ timeout: 5000 });
  if (shots) await page.screenshot({ path: `${shots}/check-everyone-1440.png` });
  await opt.dispatchEvent("mousedown");
  assert.equal(await box().inputValue(), "@everyone ");
  await box().fill("@everyone the brochure is approved (test)"); await box().press("Enter");
  await page.locator('[role="log"] article').last().locator("mark", { hasText: "@everyone" }).waitFor({ timeout: 15000 });
});

await check("recent emoji: a picked emoji leads the picker next time", async () => {
  await open();
  await page.getByRole("button", { name: "Emoji", exact: true }).click();
  await page.locator('[data-emoji-picker] [data-emoji="🥳"]:not([data-recent-emoji])').click();   // CHAT-V6: cells are labelled "🥳 party"
  await box().fill("");
  await page.getByRole("button", { name: "Emoji", exact: true }).click(); await page.getByRole("button", { name: "Emoji", exact: true }).click();
  await page.locator('[data-emoji-picker] [data-recent-emoji]', { hasText: "🥳" }).waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Emoji", exact: true }).click();
});

await check("keyboard: Ctrl+K jumps to a chat, Ctrl+/ lists shortcuts, Up edits my last message, Esc cancels", async () => {
  await page.goto(`${base}/chats`, { waitUntil: "load" }); await page.locator("[data-chat-row]").first().waitFor({ timeout: 30000 });
  await page.getByRole("status").filter({ hasText: /^(Live|Reconnecting…)$/ }).first().waitFor({ timeout: 20000 });   // hydrated
  await page.keyboard.press("Control+k");
  const jump = page.getByRole("dialog", { name: "Jump to a chat" }); await jump.waitFor({ timeout: 5000 });
  await page.keyboard.type("Brochure launch");
  if (shots) await page.screenshot({ path: `${shots}/check-jump-1440.png` });
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => u.searchParams.get("channel") === group.id, { timeout: 10000 });
  await page.locator('[role="log"] article[id^="m-"]').first().waitFor({ timeout: 30000 });
  await page.keyboard.press("Control+/");
  await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor(); await page.keyboard.press("Escape");
  const mine = await say("kedab", group.id, "Typo in this line (test)");
  await page.locator(`#m-${mine.id}`).waitFor({ timeout: 20000 });
  await box().click(); await box().fill(""); await page.keyboard.press("ArrowUp");
  await page.getByRole("textbox", { name: "Edit your message" }).waitFor({ timeout: 5000 });
  await page.keyboard.press("Escape");
  await box().waitFor({ timeout: 5000 });
});

await check("find in this chat: count, step, the words marked", async () => {
  await open();
  await page.keyboard.press("Control+Shift+F");
  const find = page.locator("[data-find-bar] input"); await find.waitFor({ timeout: 5000 });
  await find.fill("brochure");
  await page.locator("[data-find-count]").filter({ hasText: /of \d+/ }).waitFor({ timeout: 15000 });
  const marks = await page.evaluate(() => (globalThis.CSS?.highlights?.get("chat-find")?.size ?? 0) + (globalThis.CSS?.highlights?.get("chat-find-now")?.size ?? 0));
  assert.ok(marks > 0, "words marked");
  if (shots) await page.screenshot({ path: `${shots}/check-find-1440.png` });
  await find.press("ArrowUp"); await page.locator("[data-find-count]").filter({ hasText: /^2 of/ }).waitFor({ timeout: 10000 });
  await find.press("Escape"); await page.locator("[data-find-bar]").waitFor({ state: "detached", timeout: 5000 });
});

await check("offline: a banner says messages wait", async () => {
  await open();
  await ctx.setOffline(true);
  await page.locator("[data-offline]").first().waitFor({ timeout: 5000 });
  if (shots) await page.screenshot({ path: `${shots}/check-offline-1440.png` });
  await ctx.setOffline(false);
  await page.locator("[data-offline]").first().waitFor({ state: "detached", timeout: 5000 });
});

// CHAT-V4 left this open: the phone's press and hold, with a real touch (CDP touch events, not a right-click).
await check("phone: press and hold a message opens its actions; press and hold a chat row opens its menu", async () => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, extraHTTPHeaders: { "cf-access-authenticated-user-email": P.kedab } });
  const p = await phone.newPage(); const cdp = await phone.newCDPSession(p);
  const hold = async (loc) => {
    const b = await loc.boundingBox(); const x = b.x + Math.min(40, b.width / 2), y = b.y + b.height / 2;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await p.waitForTimeout(700);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await p.goto(`${base}/chats?channel=${group.id}`, { waitUntil: "load", timeout: 120000 });
  const theirs = p.locator('[role="log"] article[id^="m-"]:not([data-mine])').last(); await theirs.waitFor({ timeout: 60000 });
  await theirs.scrollIntoViewIfNeeded(); await p.waitForTimeout(2500);   // hydrated, settled
  await hold(theirs.locator('[class*="bubble"]').first());
  const sheet = p.getByRole("dialog", { name: "Message actions" }); await sheet.waitFor({ timeout: 5000 });
  for (const item of ["Reply", "Remind me", "Forward"]) await sheet.getByRole("button", { name: item, exact: true }).waitFor();
  if (shots) await p.screenshot({ path: `${shots}/check-hold-message-390.png` });
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await p.goto(`${base}/chats`, { waitUntil: "load" });
  const row = p.locator(`[data-chat-row]:has-text("${group.name}")`).first(); await row.waitFor({ timeout: 30000 });
  await hold(row);
  const menu = p.getByRole("menu", { name: `${group.name}: actions` }); await menu.waitFor({ timeout: 5000 });
  if (shots) await p.screenshot({ path: `${shots}/check-hold-row-390.png` });
  assert.equal(new URL(p.url()).searchParams.get("channel"), null, "holding did not open the chat");
  await phone.close();
});

await browser.close();
for (const r of results) console.log(r.join("  "));
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
