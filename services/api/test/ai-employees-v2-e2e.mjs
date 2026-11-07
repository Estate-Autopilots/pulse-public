// AI-EMPLOYEES v2 journey in a real browser, against pulse-dev, as the owner (admin) with synthetic people only.
// The AI employee's profile is the same as a person's; its AI tab sets model, thinking and tools; it is added to a
// group; a client-style message arrives in that group (synthetic Asha); the AI, set to ask first, sends its approver a
// direct message with what it would post; the approver taps Send it; the AI posts in the group as itself.
// The AI's runtime is the real runner (services/coworker/runner.mjs) with its profile set to the test runtime.
//
//   BASE=http://127.0.0.1:3200 API=http://127.0.0.1:3203 OWNER=user-668d21b6@estateautopilots.com CLIENT=asha.kireteso@synthetic.invalid \
//   AI=<luna person id> HUMAN=<a person id> GROUP="Skyline client room (test)" OUT=~/ea-research/ux/journeys/AI-EMP node services/api/test/ai-employees-v2-e2e.mjs
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const { chromium, expect: expect0 } = await import("../../../tests/e2e/node_modules/@playwright/test/index.mjs");
const expect = expect0.configure({ timeout: 90000 });
const BASE = process.env.BASE ?? "http://127.0.0.1:3200", API = process.env.API ?? "http://127.0.0.1:3203";
const OWNER = process.env.OWNER, CLIENT = process.env.CLIENT, AI = process.env.AI, HUMAN = process.env.HUMAN, GROUP = process.env.GROUP;
const OUT = process.env.OUT, SHOTS = join(OUT, "shots"); mkdirSync(SHOTS, { recursive: true });
const call = async (who, path, body) => {
  const r = await fetch(API + path, { method: body ? "POST" : "GET", headers: { "cf-access-authenticated-user-email": who, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { s: r.status, d };
};
const log = []; const step = (s) => { log.push(`${new Date().toISOString()} ${s}`); console.log(s); };
let n = 0; const shot = async (page, name) => { n += 1; const f = join(SHOTS, `${String(n).padStart(2, "0")}-${name}.png`); await page.screenshot({ path: f }); step(`shot ${f}`); };

const browser = await chromium.launch();
async function open(size, video) {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1, colorScheme: "light", ...(video ? { recordVideo: { dir: join(OUT, "tmp-video"), size } } : {}) });
  await ctx.route(`${BASE}/**`, (r) => r.continue({ headers: { ...r.request().headers(), "cf-access-authenticated-user-email": OWNER } }));
  const page = await ctx.newPage(); page.setDefaultTimeout(90000); return { ctx, page };
}
const errors = [];
const { ctx, page } = await open({ width: 1440, height: 900 }, true);
page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
try {
  // 1-2. A person's profile and the AI employee's: the same card.
  await page.goto(`${BASE}/people/${HUMAN}`); await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); await page.waitForTimeout(1500);
  await shot(page, "human-profile");
  await page.goto(`${BASE}/people/${AI}`); await expect(page.getByRole("heading", { level: 2, name: "Luna" })).toBeVisible();
  await expect(page.getByText("Reports to").first()).toBeVisible(); await page.waitForTimeout(1500);
  await shot(page, "ai-profile-same-card");
  // 3-4. Its AI section: model, thinking, tools, on its own or ask first.
  await page.goto(`${BASE}/people/${AI}?tab=ai`);
  const form = page.getByRole("form", { name: "AI employee settings" }); await expect(form).toBeVisible(); await page.waitForTimeout(1000);
  await shot(page, "ai-tab");
  // UI-UPGRADE (intended change): the settings sit behind a left sub-nav, with segmented controls, switches and kit
  // pickers instead of native selects; one sticky bar saves every change.
  await page.getByRole("tab", { name: "Model & limits" }).click();
  await form.getByRole("radiogroup", { name: "Thinking" }).getByRole("radio", { name: "Deep", exact: true }).click();
  await page.getByRole("tab", { name: "Behaviour" }).click();
  await form.getByRole("radiogroup", { name: "Who it listens to" }).getByRole("radio", { name: "Everyone, clients too" }).click();
  await form.getByRole("radiogroup", { name: "When @mentioned or replied to" }).getByRole("radio", { name: "Asks first" }).click();
  await form.getByRole("radiogroup", { name: "Anything else said in its groups" }).getByRole("radio", { name: "Asks first" }).click();
  await page.getByRole("tab", { name: "Tools & training" }).click();
  for (const t of [/^Projects/, /^Web/]) { const c = form.getByRole("switch", { name: t }); if (!(await c.isChecked())) await c.check(); }
  await form.getByLabel("Instructions").fill("You coordinate production for Estate Autopilots clients. Be warm and brief. Never promise a date without the coordinator.");
  await shot(page, "ai-settings-filled");
  // This journey's AI keeps the test runtime (no plan quota is used; its profile says "Test runtime").
  const bar = page.getByRole("region", { name: "Unsaved changes" });
  await bar.getByRole("button", { name: "Save changes" }).click(); await expect(bar).toHaveCount(0, { timeout: 60000 });
  await page.goto(`${BASE}/people/${AI}?tab=ai`); await expect(page.getByText("Deep thinking").first()).toBeVisible({ timeout: 120000 });
  await shot(page, "ai-settings-saved");
  // 5. Into a group, like a person: "Add to a group" opens a list of the groups the viewer runs.
  await page.getByRole("tab", { name: "Groups & projects" }).click();
  await page.getByRole("button", { name: /^Add it to a group you run/ }).click();
  await page.getByRole("option", { name: GROUP }).click();
  await expect(page.getByRole("link", { name: GROUP })).toBeVisible({ timeout: 60000 });
  await page.getByRole("link", { name: GROUP }).scrollIntoViewIfNeeded(); await shot(page, "ai-added-to-group");
  // 6. A client-style message arrives in the group (synthetic Asha).
  const chats = (await call(OWNER, "/api/v0/chats")).d.channels;
  const group = chats.find((c) => c.name === GROUP); assert.ok(group, "group");
  const said = (await call(CLIENT, `/api/v0/chats/${group.id}/messages`, { body: "Hello! Any update on the Skyline walkthrough video? Our buyers' visit is on Saturday.", clientId: randomUUID(), attachments: [] }));
  assert.equal(said.s, 200, JSON.stringify(said.d)); step("client message posted");
  await page.goto(`${BASE}/chats?channel=${group.id}`); await expect(page.getByText("Our buyers' visit is on Saturday").first()).toBeVisible(); await page.waitForTimeout(1500);
  await shot(page, "group-client-message");
  // 7. The AI does not post there; it DMs its approver (the owner) with a proposal.
  let dm = null;
  for (let i = 0; i < 40 && !dm; i++) {
    const list = (await call(OWNER, "/api/v0/chats")).d.channels; const c = list.find((x) => x.kind === "direct" && x.peerId === AI);
    if (c) { const ms = (await call(OWNER, `/api/v0/chats/${c.id}/messages`)).d; const arr = ms.messages ?? ms; if (arr.some((m) => m.proposal?.state === "pending")) dm = c; }
    if (!dm) await new Promise((r) => setTimeout(r, 3000));
  }
  assert.ok(dm, "proposal in the owner's DM"); step("proposal arrived");
  await page.goto(`${BASE}/chats?channel=${dm.id}`); const card = page.locator('[data-proposal][data-state="pending"]').last();
  await expect(card).toBeVisible(); await card.scrollIntoViewIfNeeded(); await page.waitForTimeout(1000);
  await shot(page, "dm-proposal");
  // 8. Send it: posted in the group as the AI, logged with who approved.
  const pid = await card.getAttribute("data-proposal");
  await card.getByRole("button", { name: "Send it" }).click();
  await expect(page.locator(`[data-proposal="${pid}"][data-state="sent"]`)).toBeVisible({ timeout: 60000 }); await page.waitForTimeout(800);
  await shot(page, "dm-sent");
  await page.goto(`${BASE}/chats?channel=${group.id}`); await expect(page.locator("[data-proposal-sent]").last()).toBeVisible({ timeout: 60000 }); await page.waitForTimeout(1200);
  await shot(page, "group-ai-posted");
  // 9. Its profile lists what it asked and who decided.
  await page.goto(`${BASE}/people/${AI}?tab=ai&s=asked`); await expect(page.getByText(/Approved by/).first()).toBeVisible();
  await shot(page, "ai-proposals-log");
  step(`PASS${errors.length ? ` (page errors: ${errors.join(" | ")})` : ""}`);
} catch (err) {
  await shot(page, "failure").catch(() => {}); step(`FAIL: ${err.message.slice(0, 400)}`); process.exitCode = 1;
} finally {
  await ctx.close();
  for (const f of readdirSync(join(OUT, "tmp-video"))) renameSync(join(OUT, "tmp-video", f), join(OUT, "journey-1440-light.webm"));
  // A phone look at the profile's AI tab (no video).
  const phone = await open({ width: 390, height: 844 }, false);
  await phone.page.goto(`${BASE}/people/${AI}?tab=ai`).catch(() => {}); await phone.page.waitForTimeout(2500); await phone.page.screenshot({ path: join(SHOTS, "phone-ai-tab.png"), fullPage: false }).catch(() => {});
  await phone.ctx.close(); await browser.close();
  writeFileSync(join(OUT, "results.txt"), log.join("\n") + "\n");
}
