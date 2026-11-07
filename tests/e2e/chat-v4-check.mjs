// CHAT-V4 checks on a running Pulse as Kedab (synthetic): link preview, "@" order, /ask, the one right-hand column.
//   BASE=http://127.0.0.1:3200 node tests/e2e/chat-v4-check.mjs [shots dir]
// Uses the group of tests/e2e/chat-v4-seed.mjs. Sends nothing to anyone (drafts only).
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
const base = process.env.BASE ?? "http://127.0.0.1:3200", apiBase = process.env.API ?? "http://127.0.0.1:3203", shots = process.argv[2];
const KEDAB = "kedab.mifos@synthetic.invalid";
const list = await (await fetch(`${apiBase}/api/v0/chats`, { headers: { "cf-access-authenticated-user-email": KEDAB } })).json();
const group = list.channels.find((c) => c.name === "Brochure launch (test)"); assert.ok(group, "seed first: tests/e2e/chat-v4-seed.mjs");
const browser = await chromium.launch(); const results = [];
const check = async (name, fn) => { try { await fn(); results.push(["PASS", name]); } catch (e) { results.push(["FAIL", name, String(e.message).split("\n")[0]]); } };
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "cf-access-authenticated-user-email": KEDAB } });
const page = await ctx.newPage();
await page.goto(`${base}/chats?channel=${group.id}`, { waitUntil: "load", timeout: 120000 });
await page.locator('[role="log"] article[id^="m-"]').first().waitFor({ timeout: 60000 });
await check("a link shows its preview card", async () => { await page.locator("[data-link-preview]").first().waitFor({ timeout: 15000 }); });
await check("@ offers first names first", async () => {
  const box = page.getByRole("textbox", { name: /^Message / });
  await box.fill("@n"); const first = page.getByRole("listbox", { name: "People" }).getByRole("option").first();
  await first.waitFor({ timeout: 5000 }); assert.match(await first.innerText(), /Neha Soniba/);
  await box.fill("");
});
await check("info docks as one column and the top bar ends at its edge", async () => {
  await page.getByRole("button", { name: /details and members/ }).first().click();
  const info = page.getByRole("complementary", { name: "Group info" }); await info.waitFor();
  const [a, bar] = await Promise.all([info.boundingBox(), page.locator("[data-shell-topbar]").boundingBox()]);
  assert.equal(Math.round(a.y), 0, "info starts at the top of the window");
  assert.ok(bar.x + bar.width <= a.x + 1, `top bar ends at the column (${bar.x + bar.width} vs ${a.x})`);
  if (shots) await page.screenshot({ path: `${shots}/check-info-1440.png` });
  await page.getByRole("button", { name: "Close details" }).click();
});
await check("a row's quick actions open on right-click and close with Escape", async () => {
  await page.locator(`[data-chat-row]:has-text("${group.name}")`).first().click({ button: "right" });
  const menu = page.getByRole("menu", { name: `${group.name}: actions` }); await menu.waitFor({ timeout: 5000 });
  for (const item of [/Pin chat|Unpin chat/, /Mark as (un)?read/, /Mute for 8 hours|Unmute/, /Archive chat|Unarchive chat/]) await menu.getByRole("menuitem", { name: item }).waitFor();
  if (shots) await page.screenshot({ path: `${shots}/check-row-menu-1440.png` });
  await page.keyboard.press("Escape"); await menu.waitFor({ state: "detached", timeout: 3000 });
});
if (process.env.CHAT_V4_API === "1") await check("mark unread from the conversation, then opening it clears the mark", async () => {
  await page.getByRole("button", { name: /^Conversation options$/ }).click();
  await page.getByRole("menuitem", { name: "Mark as unread" }).click();
  const row = page.locator(`[data-chat-row]:has-text("${group.name}")`).first();
  await row.locator('[aria-label="Marked unread"]').waitFor({ timeout: 8000 });
  await row.click(); await page.waitForTimeout(1500);
  assert.equal(await row.locator('[aria-label="Marked unread"]').count(), 0);
});
if (process.env.CHAT_V4_API === "1") await check("edited opens the earlier words", async () => {
  // A message of Kedab's in the synthetic group, edited once through the API (as the composer's Edit does).
  const post = async (path, body) => { const r = await fetch(`${apiBase}/api/v0/${path}`, { method: "POST", headers: { "cf-access-authenticated-user-email": KEDAB, "content-type": "application/json" }, body: JSON.stringify(body) }); assert.ok(r.ok, `${path}: ${r.status}`); return r.json(); };
  const { id } = await post(`chats/${group.id}/messages`, { body: "Cover photo: the sea-facing one (test)", attachments: [], clientId: crypto.randomUUID() });
  await post(`chats/messages/${id}/edit`, { body: "Cover photo: the garden one (test)" });
  await page.goto(`${base}/chats?channel=${group.id}&message=${id}`, { waitUntil: "load" });
  await page.locator(`#m-${id} [data-edited-open]`).click({ timeout: 20000 });
  const dialog = page.getByRole("dialog", { name: "Edit history" }); await dialog.waitFor();
  await dialog.getByText("the sea-facing one").waitFor({ timeout: 8000 }); await dialog.getByText("the garden one").first().waitFor();
  if (shots) await page.screenshot({ path: `${shots}/check-edits-1440.png` });
  await page.keyboard.press("Escape");
});
await check("/ask for an AI employee outside the group opens their chat with the question written", async () => {
  const ai = list.people.find((p) => p.agent && p.name === "Mira") ?? list.people.find((p) => p.agent);
  const box = page.getByRole("textbox", { name: /^Message / });
  await box.fill(`/ask ${ai.name.split(" ")[0]} what is due this week`); await box.press("Enter");
  await page.waitForURL((u) => !u.searchParams.get("channel")?.startsWith(group.id), { timeout: 15000 });
  const draft = page.getByRole("textbox", { name: /^Message / });
  await draft.waitFor(); await page.waitForTimeout(800);
  assert.equal(await draft.inputValue(), "what is due this week");
  if (shots) await page.screenshot({ path: `${shots}/check-ask-1440.png` });
  await draft.fill("");
});
await browser.close();
for (const r of results) console.log(r.join("  "));
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
