#!/usr/bin/env node
// Pulse reels capture: drives headless Chromium through a storyboard's takes and records each take as a constant
// 30 fps clip plus an ACTION LOG: every tap, type, appear and mark with its frame number and the element's box,
// so the editor can cut 2-4 frames before a tap and punch in on the exact element.
//
//   node capture.mjs <storyboard.json> <outdir> [--only take,take]
//
// env: REELS_BASE    base URL (a fictional demo company, e.g. http://reels-demo.localhost:13200)
//      REELS_CHROME  Chromium binary;  REELS_LOGINS  JSON file {email: password} for the demo's synthetic people
//      REELS_WATCHDOG_S (default 900). One browser at a time; ffmpeg runs niced with -threads 2.
import { chromium } from "playwright-core";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const FPS = 30;
export const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

const TAP_JS = `(() => {
  if (window.__reelTap) return;
  const style = document.createElement('style');
  style.textContent = '.reel-tap{position:fixed;z-index:2147483647;pointer-events:none;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;background:rgba(255,255,255,.55);box-shadow:0 0 0 3px rgba(91,69,214,.85),0 4px 18px rgba(0,0,0,.25);animation:reel-tap .5s ease-out forwards}@keyframes reel-tap{0%{transform:scale(.55);opacity:1}60%{opacity:.9}100%{transform:scale(1.5);opacity:0}}';
  document.documentElement.appendChild(style);
  window.__reelTap = (x, y) => { const d = document.createElement('div'); d.className = 'reel-tap'; d.style.left = x + 'px'; d.style.top = y + 'px'; document.documentElement.appendChild(d); setTimeout(() => d.remove(), 650); };
})()`;

/** Frame number of wall-clock time t (seconds) in a clip whose frame 0 is t0. */
export function frameAt(t, t0, fps = FPS) {
  return Math.max(0, Math.round((t - t0) * fps));
}

/** ffmpeg concat list giving each screencast frame its real duration, so the clip keeps real time. */
export function concatList(frames, tEnd) {
  const lines = ["ffconcat version 1.0"];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : tEnd;
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(6)}`);
  });
  if (frames.length) lines.push(`file '${frames[frames.length - 1].file}'`);
  return lines.join("\n") + "\n";
}

const rx = (v) => (typeof v === "string" && v.startsWith("/") && v.lastIndexOf("/") > 0 ? new RegExp(v.slice(1, v.lastIndexOf("/")), v.slice(v.lastIndexOf("/") + 1)) : v);

function locate(page, s) {
  if (s.within) return locate(page, { ...s.within, nth: s.within.nth }).locator(s.sel || "*").filter(s.hasText ? { hasText: rx(s.hasText) } : {}).nth(s.nth ?? 0);
  if (s.sel && s.hasText) return page.locator(s.sel).filter({ hasText: rx(s.hasText) }).nth(s.nth ?? 0);
  if (s.sel) return page.locator(s.sel).filter({ visible: true }).nth(s.nth ?? 0);
  if (s.role) return page.getByRole(s.role, { name: rx(s.name), exact: s.exact ?? false }).filter({ visible: true }).nth(s.nth ?? 0);
  if (s.label) return page.getByLabel(rx(s.label), { exact: s.exact ?? false }).filter({ visible: true }).nth(s.nth ?? 0);
  if (s.placeholder) return page.getByPlaceholder(s.placeholder).nth(s.nth ?? 0);
  if (s.text) return page.getByText(rx(s.text), { exact: s.exact ?? false }).filter({ visible: true }).nth(s.nth ?? 0);
  throw new Error(`step has no target: ${JSON.stringify(s)}`);
}

async function box(loc) {
  const b = await loc.boundingBox().catch(() => null);
  return b ? [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 10) / 10) : null;
}

const VARS = {};
const subst = (v) => (typeof v === "string" ? v.replace(/\$\{(\w+)\}/g, (_, k) => VARS[k] ?? "") : v);

async function runStep(page, raw, log, base, logins) {
  const s = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, subst(v)]));
  const now = () => Date.now() / 1000;
  const ev = (type, extra) => log.push({ type, t: now(), ...extra });
  switch (s.do) {
    case "goto":
      await page.goto(new URL(s.url, base).toString(), { waitUntil: "domcontentloaded" });
      await page.evaluate(TAP_JS);
      if (s.settle !== false) await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      if (s.mark) ev("mark", { mark: s.mark });
      break;
    case "login": {
      // Pulse password sign-in at the demo company's own address (Username or @handle, Password, Sign in).
      const pw = logins[s.user];
      if (!pw) throw new Error(`no password for ${s.user} in REELS_LOGINS`);
      await page.goto(new URL("/login", base).toString(), { waitUntil: "domcontentloaded" });
      // Fill only after hydration: a fill before React attaches is wiped and the sign-in posts empty fields.
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      await page.locator('input[name="username"]').fill(s.as || s.user);
      await page.locator('input[name="password"]').fill(pw);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 30000 });
      break;
    }
    case "cookie":
      await page.context().addCookies([{ name: s.name, value: s.value, url: base }]);
      break;
    case "tap": {
      const loc = locate(page, s);
      await loc.waitFor({ state: "visible", timeout: s.timeout ?? 20000 });
      if (s.scroll !== false) await loc.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(s.before ?? 120);
      const b = await box(loc);
      if (b) await page.evaluate(([x, y]) => window.__reelTap && window.__reelTap(x, y), [b[0] + b[2] / 2, b[1] + b[3] / 2]);
      ev("tap", { box: b, label: s.say || s.name || s.text || s.label || s.sel, mark: s.mark, zoom: s.zoom, sfx: s.sfx });
      await loc.click({ timeout: 10000, force: s.force ?? false });
      if (s.after) await page.waitForTimeout(s.after);
      break;
    }
    case "type": {
      const loc = locate(page, s);
      await loc.waitFor({ state: "visible", timeout: s.timeout ?? 20000 });
      ev("type", { box: await box(loc), label: s.value, mark: s.mark, zoom: s.zoom });
      await loc.click();
      if (s.clear) await loc.fill("");
      await loc.pressSequentially(s.value, { delay: s.delay ?? 45 });
      ev("typed", { box: await box(loc), mark: s.markEnd });
      break;
    }
    case "fill": {
      // secret: take the value from REELS_LOGINS (a demo password), never from the storyboard or the log.
      const loc = locate(page, s);
      await loc.waitFor({ state: "visible", timeout: s.timeout ?? 20000 });
      await loc.fill(s.secret ? logins[s.secret] : s.value);
      break;
    }
    case "press":
      await page.keyboard.press(s.key);
      ev("press", { label: s.key, mark: s.mark });
      break;
    case "appear": {
      // Waits until an element is visible and logs the moment with its box (a reply landing, a sheet opening).
      const loc = locate(page, s);
      await loc.waitFor({ state: "visible", timeout: s.timeout ?? 45000 });
      ev("appear", { box: await box(loc), label: s.say || s.text || s.sel, mark: s.mark, zoom: s.zoom, sfx: s.sfx });
      break;
    }
    case "scroll":
      ev("scroll", { mark: s.mark, label: String(s.dy) });
      await page.mouse.wheel(0, s.dy);
      break;
    case "eval":
      await page.evaluate(s.js);
      break;
    case "wait":
      await page.waitForTimeout(s.ms);
      break;
    case "grab": {
      // Keeps an element's text (or attribute) for later steps as ${var}, e.g. the client link.
      const loc = locate(page, s);
      await loc.waitFor({ state: "visible", timeout: s.timeout ?? 20000 });
      VARS[s.var] = (s.attr ? await loc.getAttribute(s.attr) : await loc.textContent()).trim();
      if (s.replaceOrigin) VARS[s.var] = VARS[s.var].replace(/^https?:\/\/[^/]+/, new URL(base).origin);
      break;
    }
    case "shot":
      // Debug still (not part of the clip): REELS_SHOTS=1.
      if (process.env.REELS_SHOTS) await page.screenshot({ path: path.join(process.env.REELS_SHOTS_DIR || ".", `${s.name}.png`) });
      break;
    case "back":
      ev("back", { mark: s.mark });
      await page.goBack({ waitUntil: "domcontentloaded" });
      break;
    case "storage":
      await page.evaluate(([k, v]) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }, [s.key, s.value ?? null]);
      break;
    case "mark":
      ev("mark", { mark: s.mark });
      break;
    default:
      throw new Error(`unknown step ${s.do}`);
  }
}

async function shootTake(browser, take, outDir, base, logins) {
  const ctx = await browser.newContext({ ...PHONE, colorScheme: take.colorScheme || "light", locale: "en-IN", timezoneId: "Asia/Kolkata" });
  // Dev-server noise is not part of the product: the Next.js dev badge is hidden and stray unhandled rejections from
  // the dev server (HMR) do not raise the "Something glitched" notice during a take. Real page errors still fail QA.
  await ctx.addInitScript(() => {
    const css = "nextjs-portal{display:none!important}";
    const add = () => { const st = document.createElement("style"); st.textContent = css; document.documentElement.appendChild(st); };
    if (document.documentElement) add(); else document.addEventListener("DOMContentLoaded", add);
    document.addEventListener("DOMContentLoaded", () => { document.body.spellcheck = false; document.documentElement.spellcheck = false; });
    window.addEventListener("unhandledrejection", (e) => { e.stopImmediatePropagation(); e.preventDefault(); }, true);
    // React's dev hydration warning (a server/client time-zone mismatch on dev) would raise the glitch notice too.
    window.addEventListener("error", (e) => { if (/hydrat/i.test(String(e.message) + String(e.error))) e.stopImmediatePropagation(); }, true);
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
  const log = [];
  try {
    for (const s of take.setup || []) await runStep(page, s, log, base, logins);
  } catch (e) {
    await page.screenshot({ path: path.join(outDir, `${take.id}-setup-error.png`) }).catch(() => {});
    throw e;
  }
  log.length = 0;
  await page.evaluate(TAP_JS).catch(() => {});
  const frameDir = path.join(outDir, `${take.id}.frames`);
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });
  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  let n = 0;
  cdp.on("Page.screencastFrame", async (f) => {
    const file = `${String(n++).padStart(6, "0")}.jpg`;
    fs.writeFileSync(path.join(frameDir, file), Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  const t0 = Date.now() / 1000;
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1170, maxHeight: 2532, everyNthFrame: 1 });
  // A one-pixel ticker keeps frames coming while the UI is still, so the clock never drifts.
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;left:0;bottom:0;width:1px;height:1px;z-index:2147483647;pointer-events:none;opacity:.02;background:#000";
    document.documentElement.appendChild(d);
    setInterval(() => { d.style.background = d.style.background === "rgb(0, 0, 0)" ? "#010101" : "#000"; }, 100);
  }).catch(() => {});
  let error = null;
  try {
    for (const s of take.steps) await runStep(page, s, log, base, logins);
    await page.waitForTimeout(take.tail ?? 900);
  } catch (e) {
    error = String(e && e.message ? e.message : e).slice(0, 400);
    await page.screenshot({ path: path.join(outDir, `${take.id}-error.png`) }).catch(() => {});
  }
  const tEnd = Date.now() / 1000;
  await cdp.send("Page.stopScreencast").catch(() => {});
  await ctx.close();
  if (!frames.length) throw new Error(`take ${take.id}: no frames`);
  // Frame 0 is the start of recording: the first screencast frame is held back to t0.
  frames[0].t = Math.min(frames[0].t, t0);
  const t0clip = frames[0].t;
  fs.writeFileSync(path.join(frameDir, "list.ffconcat"), concatList(frames, tEnd));
  const mp4 = path.join(outDir, `${take.id}.mp4`);
  const r = spawnSync("nice", ["-n", "19", "ionice", "-c3", "ffmpeg", "-y", "-loglevel", "error", "-threads", "2",
    "-f", "concat", "-safe", "0", "-i", path.join(frameDir, "list.ffconcat"),
    "-vf", `fps=${FPS},scale=1170:2532:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "medium", "-crf", "12",
    "-threads", "2", "-r", String(FPS), mp4], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${take.id}`);
  const events = log.map((e, i) => ({ i, ...e, frame: frameAt(e.t, t0clip) }));
  const frameCount = Math.round((tEnd - t0clip) * FPS);
  const out = { take: take.id, fps: FPS, device: "phone", viewport: PHONE.viewport, scale: PHONE.deviceScaleFactor,
    size: [1170, 2532], t0: t0clip, frames: frameCount, screencastFrames: frames.length, events, error, pageErrors };
  fs.writeFileSync(path.join(outDir, `${take.id}.actions.json`), JSON.stringify(out, null, 1));
  if (!process.env.REELS_KEEP_FRAMES) fs.rmSync(frameDir, { recursive: true, force: true });
  return out;
}

async function main() {
  const [storyPath, outDir, ...rest] = process.argv.slice(2);
  if (!storyPath || !outDir) {
    console.error("usage: node capture.mjs <storyboard.json> <outdir> [--only take,take]");
    process.exit(2);
  }
  const story = JSON.parse(fs.readFileSync(storyPath, "utf8"));
  const only = rest.includes("--only") ? rest[rest.indexOf("--only") + 1].split(",") : null;
  const base = process.env.REELS_BASE;
  if (!base) throw new Error("REELS_BASE is not set");
  const logins = process.env.REELS_LOGINS ? JSON.parse(fs.readFileSync(process.env.REELS_LOGINS, "utf8")) : {};
  fs.mkdirSync(outDir, { recursive: true });
  // Values grabbed in one take (a client link) stay usable when a later take is shot again on its own.
  const varsFile = path.join(outDir, "vars.json");
  if (fs.existsSync(varsFile)) Object.assign(VARS, JSON.parse(fs.readFileSync(varsFile, "utf8")));
  const watchdog = setTimeout(() => { console.error("watchdog: capture took too long"); process.exit(3); },
    Number(process.env.REELS_WATCHDOG_S || 900) * 1000);
  const browser = await chromium.launch({ executablePath: process.env.REELS_CHROME, args: ["--disable-dev-shm-usage", "--font-render-hinting=none"] });
  const results = [];
  try {
    for (const take of story.takes) {
      if (only && !only.includes(take.id)) continue;
      const t = Date.now();
      const r = await shootTake(browser, take, outDir, base, logins);
      fs.writeFileSync(varsFile, JSON.stringify(VARS), { mode: 0o600 });
      results.push({ take: take.id, frames: r.frames, events: r.events.length, error: r.error, seconds: (Date.now() - t) / 1000 });
      console.log(JSON.stringify(results[results.length - 1]));
    }
  } finally {
    await browser.close();
    clearTimeout(watchdog);
  }
  if (results.some((r) => r.error)) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
