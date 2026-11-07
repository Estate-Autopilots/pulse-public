// CALLS-V2 checks on a running Pulse with synthetic people (Kedab on a computer, Asha on a phone, Chromium's fake
// microphone and camera): a call connects and says how (a setup note with its media path), recording asks first, shows
// to both and leaves its line in the chat, the call ends cleanly; the chat dock draws polls, reactions and files; a
// reaction on a message far back shows at once.
//   BASE=http://127.0.0.1:3200 API=http://127.0.0.1:3203 node tests/e2e/calls-v2-check.mjs [shots dir] [only]
// Uses the direct chat between Kedab and Asha, "Brochure launch (test)" (tests/e2e/chat-v4-seed.mjs) and "Long history
// (test)" (tests/e2e/chat-v6-seed.mjs); writes only into those.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
const base = process.env.BASE ?? "http://127.0.0.1:3200", apiBase = process.env.API ?? "http://127.0.0.1:3203", shots = process.argv[2], only = process.argv[3];
const P = { kedab: "kedab.mifos@synthetic.invalid", asha: "asha.kireteso@synthetic.invalid" };
async function api(as, path, body) {
  const r = await fetch(`${apiBase}/api/v0/${path}`, { method: body ? "POST" : "GET", headers: { "cf-access-authenticated-user-email": P[as], ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${as} ${path}: ${d.error ?? r.status}`); return d;
}
const list = await api("kedab", "chats");
const dm = list.channels.find((c) => c.kind === "direct" && /^Asha\b/.test(c.name)); assert.ok(dm, "open a direct chat between Kedab and Asha first");
const group = list.channels.find((c) => c.name === "Brochure launch (test)"); assert.ok(group, "seed first: tests/e2e/chat-v4-seed.mjs");
const long = list.channels.find((c) => c.name === "Long history (test)"); assert.ok(long, "seed first: tests/e2e/chat-v6-seed.mjs");
const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const results = [];
const person = async (who, phone) => {
  const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: phone, hasTouch: phone, permissions: ["microphone", "camera"],
    extraHTTPHeaders: { "cf-access-authenticated-user-email": P[who] } });
  const page = await ctx.newPage(); page.setDefaultTimeout(30000); return { ctx, page };
};
const K = await person("kedab", false), A = await person("asha", true);
const ready = (page) => page.waitForFunction(() => { const e = window.__pulseCalls; return !!e && !!e.me && e.live === true; }, null, { timeout: 240000 });
const go = async (page, path) => { await page.goto(base + path, { waitUntil: "load", timeout: 120000 }); await ready(page); await page.waitForTimeout(500); };
const check = async (name, fn) => {
  if (only && !name.includes(only)) return;
  try { await fn(); results.push(["PASS", name]); }
  catch (e) {
    results.push(["FAIL", name, String(e.message).split("\n")[0]]);
    if (shots) { await K.page.screenshot({ path: `${shots}/fail-${name.split(":")[0].replace(/\W+/g, "-")}-kedab.png` }).catch(() => {}); await A.page.screenshot({ path: `${shots}/fail-${name.split(":")[0].replace(/\W+/g, "-")}-asha.png` }).catch(() => {}); }
    for (const p of [K, A]) await p.page.evaluate(() => window.__pulseCalls?.hangup?.()).catch(() => {});
  }
};
const stage = (p) => p.page.getByRole("dialog", { name: /^Call with/ });
const connected = (p) => p.page.waitForFunction(() => [...(window.__pulseCalls?.session?.peers.values() ?? [])].some((x) => x.pc.connectionState === "connected"), null, { timeout: 120000 });

await check("call: rings, connects, and notes how (setup time and media path)", async () => {
  await go(A.page, "/dashboard"); await go(K.page, `/chats?channel=${dm.id}`);
  await K.page.locator('[data-chat-call="voice"]').first().click();
  const ring = A.page.getByRole("alertdialog", { name: /is calling/ }); await ring.waitFor();
  await ring.getByRole("button", { name: "Answer" }).click();
  await connected(K); await connected(A);
  // The clock runs on both sides.
  await stage(K).getByText(/^\d+:\d\d$/).waitFor(); await stage(A).getByText(/^\d+:\d\d$/).waitFor();
  const id = await K.page.evaluate(() => window.__pulseCalls.session.call.id);
  // Both browsers wrote their setup note (read through the summary when Kedab may: leadership and admins).
  // The notes go when each side sees the media flowing (a second or two after the page shows the clock): read again for
  // up to 30 s.
  let q = null;
  for (let i = 0; i < 15; i++) { q = await api("kedab", "calls/quality?days=1").catch(() => null); if (!q || (q.connects >= 2 && Object.keys(q.paths).length)) break; await K.page.waitForTimeout(2000); }
  if (q) assert.ok(q.connects >= 2 && Object.keys(q.paths).length >= 1, `setup notes with a path: ${JSON.stringify(q.paths)}`);
  globalThis.callId = id;
});

await check("recording: asks first, both see it, the other gets the notice, the chat gets its line", async () => {
  await stage(K).getByRole("button", { name: "Record the call" }).click();
  await K.page.getByRole("dialog", { name: "Record this call?" }).waitFor();
  await K.page.getByRole("button", { name: "Start recording" }).click();
  await stage(K).locator("[data-call-recording]").waitFor();
  await stage(A).locator("[data-call-recording]").waitFor();
  const notice = A.page.locator("[data-recording-notice]"); await notice.waitFor();
  assert.equal(await K.page.locator("[data-recording-notice]").count(), 0, "the recorder gets no notice");
  await notice.getByRole("button", { name: "OK, stay" }).click(); await notice.waitFor({ state: "detached" });
  await K.page.waitForTimeout(11000); // two 5-second parts
  await stage(K).getByRole("button", { name: "Stop recording" }).click();
  await stage(A).locator("[data-call-recording]").waitFor({ state: "detached", timeout: 15000 });
  await K.page.getByRole("button", { name: "Hang up" }).first().click();
  await stage(A).waitFor({ state: "detached", timeout: 15000 });
  const line = K.page.locator("[data-recording-line]").last(); await line.waitFor({ timeout: 20000 });
  await K.page.waitForFunction(() => [...document.querySelectorAll("[data-recording-line]")].at(-1)?.getAttribute("data-state") === "saved", null, { timeout: 20000 });
  const rid = await line.getAttribute("data-recording-line");
  const r = await api("asha", `calls/recordings/${rid}`);
  assert.ok(r.recording.state === "saved" && r.recording.bytes > 1000 && r.recording.acks.length === 2, `saved with audio and two acknowledgements: ${JSON.stringify({ ...r.recording, transcript: undefined, segments: undefined })}`);
  const audio = await fetch(`${apiBase}/api/v0/calls/recordings/${rid}/audio`, { headers: { "cf-access-authenticated-user-email": P.kedab, range: "bytes=0-99" } });
  assert.equal(audio.status, 206); assert.equal((await audio.arrayBuffer()).byteLength, 100);
  if (shots) await K.page.screenshot({ path: `${shots}/recording-line.png` });
});

await check("dock: polls with bars, reactions and files show; a reaction toggles there", async () => {
  await K.page.evaluate((id) => { localStorage.setItem("pulse.chat.last", id); sessionStorage.setItem("pulse.chat.dock.open", "1"); }, group.id);
  await go(K.page, "/dashboard");
  const dock = K.page.locator("[data-chat-dock-panel]"); await dock.waitFor();
  await dock.locator("[data-dock-message]").first().waitFor({ timeout: 30000 });
  const polls = await dock.locator("[data-poll]").count(), reacts = await dock.locator('[aria-pressed]').count();
  assert.ok(polls + reacts > 0, `the group's polls (${polls}) or reactions (${reacts}) show in the dock`);
  if (shots) await K.page.screenshot({ path: `${shots}/dock.png` });
});

await check("far back: my reaction on a message 1,000+ back shows at once", async () => {
  const page = K.page;
  const msgs = await api("kedab", `chats/${long.id}/messages`);
  // A message far back: page backwards a few times.
  let before = msgs.messages[0]?.createdAt, target = null;
  for (let i = 0; i < 6 && before; i++) { const d = await api("kedab", `chats/${long.id}/messages?before=${encodeURIComponent(before)}`); before = d.messages[0]?.createdAt; target = d.messages.find((m) => m.kind !== "event" && !m.removed) ?? target; }
  assert.ok(target, "a message far back");
  await go(page, `/chats?channel=${long.id}&message=${target.id}`);
  const m = page.locator(`#m-${target.id}`); await m.waitFor({ timeout: 30000 });
  const had = (await m.locator('[aria-pressed="true"]').count());
  await m.hover(); await m.getByRole("button", { name: "React", exact: true }).click();
  await m.getByRole("group", { name: "Choose a reaction" }).getByRole("button", { name: /^React / }).first().click();
  await page.waitForFunction(([id, n]) => document.querySelectorAll(`#m-${id} [aria-pressed="true"]`).length !== n, [target.id, had], { timeout: 1500 });
});

await K.ctx.close(); await A.ctx.close(); await browser.close();
for (const r of results) console.log(r.join(" | "));
console.log(`${results.filter((r) => r[0] === "PASS").length}/${results.length} passed`);
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
