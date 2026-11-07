// CALLS-V2 screenshots of a call between two synthetic people on pulse-dev (Chromium's fake microphone, camera and
// screen): ringing, the incoming screen (and decline with a message), the call, camera on, a shared screen, recording
// (the confirm, the badge, the notice), the minimised call window, and the call's lines in the chat. Light and dark;
// one person on a computer (1440) and the other on a phone (390), then the other way round.
//   BASE=http://127.0.0.1:3200 node tests/e2e/calls-v2-shots.mjs <out dir> [prefix] [themes]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
const [out = "/tmp/calls-v2", prefix = "calls", themesArg = "light,dark"] = process.argv.slice(2);
const base = process.env.BASE ?? "http://127.0.0.1:3200", api = process.env.API ?? "http://127.0.0.1:3203";
const KEDAB = "kedab.mifos@synthetic.invalid", ASHA = "asha.kireteso@synthetic.invalid";
mkdirSync(out, { recursive: true });
const get = async (who, path) => (await fetch(`${api}/api/v0/${path}`, { headers: { "cf-access-authenticated-user-email": who } })).json();
const list = await get(KEDAB, "chats");
const dm = list.channels.find((c) => c.kind === "direct" && /^Asha\b/.test(c.name));
if (!dm) throw new Error("No direct chat between Kedab and Asha on this server (open one in Chats first)");
const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--auto-select-desktop-capture-source=Entire screen"] });
const shots = [];
async function person(email, phone, theme) {
  const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, colorScheme: theme, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1,
    permissions: ["microphone", "camera"], extraHTTPHeaders: { "cf-access-authenticated-user-email": email } });
  await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); localStorage.removeItem("pulse.call.mini.corner"); } catch {} }, theme);
  const page = await ctx.newPage(); page.setDefaultTimeout(60000);
  return { ctx, page, phone };
}
const snap = async (p, name) => { const f = `${out}/${prefix}-${name}-${p.phone ? 390 : 1440}.png`; await p.page.screenshot({ path: f }); shots.push(f); };
const settle = (p, ms = 1200) => p.page.waitForTimeout(ms);
async function open(p, path) { await p.page.goto(base + path, { waitUntil: "load", timeout: 120000 }); await p.page.waitForFunction(() => window.__pulseCalls?.me && window.__pulseCalls.live, null, { timeout: 240000 }); await settle(p, 1500); }
const stage = (p) => p.page.getByRole("dialog", { name: /^Call with/ });

for (const theme of themesArg.split(",")) for (const flip of [false, true]) {
  // flip: Asha calls from a computer and Kedab answers on a phone.
  const caller = await person(flip ? ASHA : KEDAB, false, theme), callee = await person(flip ? KEDAB : ASHA, true, theme);
  const t = `${theme}${flip ? "-b" : ""}`;
  try {
    await open(callee, "/dashboard");
    await open(caller, `/chats?channel=${dm.id}`);
    await caller.page.locator('[data-chat-call="voice"]').first().click();
    await stage(caller).getByText("Ringing…", { exact: true }).waitFor(); await settle(caller);
    const ring = callee.page.getByRole("alertdialog", { name: /is calling/ }); await ring.waitFor();
    await snap(caller, `ringing-${t}`); await snap(callee, `incoming-${t}`);
    await ring.getByRole("button", { name: "Decline with a message" }).click(); await settle(callee, 500); await snap(callee, `incoming-replies-${t}`);
    await ring.getByRole("button", { name: "Answer" }).click();
    await stage(callee).waitFor(); await callee.page.waitForFunction(() => [...(window.__pulseCalls?.session?.peers.values() ?? [])].some((x) => x.pc.connectionState === "connected"), null, { timeout: 45000 });
    await settle(caller, 2500); await snap(caller, `call-${t}`); await snap(callee, `call-${t}`);
    // Camera on (computer): the phone sees the video, the computer its own small view.
    await stage(caller).getByRole("button", { name: "Turn camera on" }).click(); await settle(caller, 4000);
    await snap(caller, `video-${t}`); await snap(callee, `video-${t}`);
    // Share the screen (computer): the phone sees it whole, large.
    const share = stage(caller).getByRole("button", { name: "Share your screen" });
    if (await share.count()) { await share.click(); await settle(caller, 4500); await snap(caller, `share-${t}`); await snap(callee, `share-${t}`);
      await caller.page.getByRole("button", { name: "Stop sharing" }).first().click(); await settle(caller); }
    await stage(caller).getByRole("button", { name: "Turn camera off" }).click(); await settle(caller);
    // Recording: the confirm, then the badge (both) and the notice (the other person).
    const rec = stage(caller).getByRole("button", { name: "Record the call" });
    if (await rec.count()) {
      await rec.click(); await settle(caller, 600); await snap(caller, `record-confirm-${t}`);
      await caller.page.getByRole("button", { name: "Start recording" }).click(); await settle(caller, 3000);
      await snap(caller, `recording-${t}`); await snap(callee, `recording-notice-${t}`);
      await callee.page.getByRole("button", { name: "OK, stay" }).click().catch(() => {}); await settle(callee, 6000);
    }
    // Minimised: the small call window, on both.
    await stage(caller).getByRole("button", { name: "Minimise the call" }).click(); await settle(caller); await snap(caller, `mini-${t}`);
    await stage(callee).getByRole("button", { name: "Minimise the call" }).click(); await settle(callee); await snap(callee, `mini-${t}`);
    await caller.page.getByRole("region", { name: "Call in progress" }).getByRole("button", { name: "Hang up" }).click(); await settle(caller, 4000);
    await snap(caller, `chat-lines-${t}`);
  } catch (e) { console.error(`${t}: ${String(e.message).split("\n")[0]}`); await caller.page.screenshot({ path: `${out}/${prefix}-failed-caller-${t}.png` }).catch(() => {}); await callee.page.screenshot({ path: `${out}/${prefix}-failed-callee-${t}.png` }).catch(() => {}); }
  finally {
    // Anything left ringing or in a call goes (the next round starts clean).
    for (const p of [caller, callee]) await p.page.evaluate(() => window.__pulseCalls?.hangup?.()).catch(() => {});
    await caller.ctx.close(); await callee.ctx.close();
  }
}
await browser.close();
console.log(JSON.stringify({ shots: shots.length, out }));
