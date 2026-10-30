// CALLS-V2 probe: a recorded call between two synthetic people on a running Pulse, with what the recorder does every two
// seconds (its MediaRecorder, audio clock, parts made and waiting) and every recording request (sent, answered), plus how
// many requests the recorder's page has open. Prints one line per event; the recording as Pulse saved it at the end.
//   BASE=http://127.0.0.1:3200 API=http://127.0.0.1:3203 [QUIET=1] node tests/e2e/calls-v2-rec-probe.mjs [seconds]
// What it showed on a loaded pulse-dev (26 Oct, load 16-49): headless Chromium's audio clock ran at ~7% of real time (so
// test recordings hold seconds of audio); over HTTP/1.1 the page's streams and slow reads held all six connections, so
// the parts and the heartbeat queued (Pulse ended the call after 30 s without one); a press before the chat page was
// hydrated did nothing.
import { chromium } from "@playwright/test";
const base = process.env.BASE ?? "http://127.0.0.1:3200", apiBase = process.env.API ?? "http://127.0.0.1:3203", hold = Number(process.argv[2] ?? 16);
const P = { kedab: "kedab.mifos@synthetic.invalid", asha: "asha.kireteso@synthetic.invalid" };
const api = async (as, path) => (await fetch(`${apiBase}/api/v0/${path}`, { headers: { "cf-access-authenticated-user-email": P[as] } })).json();
const t0 = Date.now(), log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...a);
const dm = (await api("kedab", "chats")).channels.find((c) => c.kind === "direct" && /^Asha\b/.test(c.name));
const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const person = async (who, phone) => {
  const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: phone, hasTouch: phone, permissions: ["microphone", "camera"],
    extraHTTPHeaders: { "cf-access-authenticated-user-email": P[who] } });
  const page = await ctx.newPage(); page.setDefaultTimeout(60000); return page;
};
const K = await person("kedab", false), A = await person("asha", true);
// Whether a call button's press reached the calls host, and how long the microphone took.
await K.context().addInitScript(() => {
  window.__probe = { evt: 0, gum: [] };
  window.addEventListener("pulse:call", () => { window.__probe.evt++; });
  const md = navigator.mediaDevices; if (md?.getUserMedia) { const g = md.getUserMedia.bind(md); md.getUserMedia = (c) => { const e = { at: Math.round(performance.now()), c: JSON.stringify(c).slice(0, 80), done: null, err: null }; window.__probe.gum.push(e); return g(c).then((x) => { e.done = Math.round(performance.now()); return x; }, (x) => { e.err = String(x?.name); throw x; }); }; }
});
// QUIET=1: endpoints that are not the call's (telemetry, the intelligence rail, briefs, freshness) answer at once, so
// on a loaded box over HTTP/1.1 (six connections a site) they do not hold the recorder's uploads back.
if (process.env.QUIET === "1") await K.context().route(/\/api\/v0\/(telemetry|intelligence|briefs\/tick|freshness)/, (r) => r.fulfill({ status: 204, body: "" }));
const open = new Map();
const watched = (u) => u.includes("/recordings/") || /\/api\/v0\/calls(\/[^/]+\/(recording|answer|leave|signal))?$/.test(u.split("?")[0]);
K.on("request", (r) => { open.set(r, Date.now()); if (watched(r.url()) && (r.method() === "POST" || r.url().includes("/recordings/"))) { let b = ""; try { const j = JSON.parse(r.postData() ?? "{}"); b = j.seq !== undefined ? `seq=${j.seq} b64=${String(j.bytes ?? "").length}` : JSON.stringify(j); } catch { /* none */ } log("K →", r.method(), r.url().replace(/^.*\/api\/v0\//, ""), b, `open=${open.size}`); } });
const done = (r, how) => { const at = open.get(r); open.delete(r); if (watched(r.url()) && (r.method() === "POST" || r.url().includes("/recordings/"))) log("K ←", how, r.url().replace(/^.*\/api\/v0\//, ""), at ? `${Date.now() - at} ms` : ""); };
K.on("requestfinished", (r) => void r.response().then((x) => done(r, x?.status() ?? "?"))); K.on("requestfailed", (r) => done(r, `failed ${r.failure()?.errorText}`));
K.on("console", (m) => { if (m.type() === "error") log("K console:", m.text().slice(0, 160)); });
const ready = (p) => p.waitForFunction(() => window.__pulseCalls?.me && window.__pulseCalls.live === true, null, { timeout: 240000 });
await A.goto(base + "/dashboard", { waitUntil: "load", timeout: 120000 }); await ready(A);
await K.goto(`${base}/chats?channel=${dm.id}`, { waitUntil: "load", timeout: 120000 }); await ready(K);
// The page's own buttons work once its part of the page is hydrated (the calls engine, in the layout, is earlier).
await K.waitForFunction(() => { const b = document.querySelector('[data-chat-call="voice"]'); return !!b && Object.keys(b).some((k) => k.startsWith("__reactProps")); }, null, { timeout: 240000 });
log("ready");
await K.locator('[data-chat-call="voice"]').first().click();
log("call clicked", `open=${open.size}`);
const ring = A.getByRole("alertdialog", { name: /is calling/ });
await ring.waitFor({ timeout: 120000 }).catch(async (e) => { log("no ring", JSON.stringify(await K.evaluate(() => ({ error: window.__pulseCalls?.error, session: !!window.__pulseCalls?.session, live: window.__pulseCalls?.live, starting: window.__pulseCalls?.starting, now: Math.round(performance.now()), probe: window.__probe, buttons: document.querySelectorAll('[data-chat-call="voice"]').length })))); log("open requests:", [...open.keys()].map((r) => `${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, "").slice(0, 60)}`).join(" | ")); throw e; });
log("ringing"); await ring.getByRole("button", { name: "Answer" }).click();
const connected = (p) => p.waitForFunction(() => [...(window.__pulseCalls?.session?.peers.values() ?? [])].some((x) => x.pc.connectionState === "connected"), null, { timeout: 120000 });
await connected(K); await connected(A); log("connected", `open=${open.size}`, [...open.keys()].map((r) => r.url().replace(/^.*\/api\/v0\//, "").slice(0, 40)).join(" | "));
const stage = K.getByRole("dialog", { name: /^Call with/ });
await stage.getByRole("button", { name: "Record the call" }).click();
await K.getByRole("button", { name: "Start recording" }).click();
const state = () => K.evaluate(() => { const r = window.__pulseCalls?.session?.rec; return r ? { mr: r.mr?.state, ctx: r.ctx?.state, t: Math.round((r.ctx?.currentTime ?? 0) * 10) / 10, made: r.seq, waiting: r.queue?.length, sending: r.sending, fails: r.fails, srcs: r.srcs?.size } : null; });
for (let i = 0; i < hold / 2; i++) { await K.waitForTimeout(2000); log("recorder", JSON.stringify(await state()), `open=${open.size}`); }
await stage.getByRole("button", { name: "Stop recording" }).click(); log("stop clicked");
for (let i = 0; i < 4; i++) { await K.waitForTimeout(1500); log("after stop", JSON.stringify(await state()), `open=${open.size}`); }
const rid = await K.evaluate(() => [...document.querySelectorAll("[data-recording-line]")].at(-1)?.getAttribute("data-recording-line"));
await K.getByRole("button", { name: "Hang up" }).first().click(); await K.waitForTimeout(3000);
const r = rid ? (await api("kedab", `calls/recordings/${rid}`)).recording : null;
log("saved", JSON.stringify(r ? { state: r.state, seconds: r.seconds, bytes: r.bytes, parts: r.parts, transcript: r.transcriptState ?? r.transcript_state } : null));
await browser.close();
