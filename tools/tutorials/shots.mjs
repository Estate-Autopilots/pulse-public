#!/usr/bin/env node
// Learn screenshots: one picture per tutorial step, on a computer-size window (1280x800), from the storyboard's
// `screens` steps, and a check that every **Label** a step names is really on the screen at that moment.
//
//   node shots.mjs <outdir> [id,id]        (env as capture.mjs: REELS_BASE, REELS_LOGINS, REELS_CHROME optional)
//
// A storyboard's `screens`: { "setup": [steps, not shot], "steps": [steps; a step with "shot": "01" is pictured after
// it runs, with "focus" (a target, as in capture.mjs) ringed] }. The Learn page's steps (apps/web/app/lib/learn.mjs)
// name the same shot ids. Writes <outdir>/<id>/<shot>.png and <outdir>/shots.json (per shot: missing labels, errors).
// tools/tutorials/learn.py webp turns the PNGs into the web app's public/learn-shots/<id>/<shot>.webp.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { locate, runStep } from "./capture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { TUTORIALS, stepParts } = await import(path.join(HERE, "../../apps/web/app/lib/learn.mjs"));
export const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 };

const RING = `(() => { if (window.__learnRing) return; window.__learnRing = (b) => {
  document.querySelectorAll('.learn-ring').forEach((e) => e.remove()); if (!b) return;
  const d = document.createElement('div'); d.className = 'learn-ring';
  d.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border-radius:10px;box-shadow:0 0 0 3px rgba(91,69,214,.9),0 0 0 9px rgba(91,69,214,.18)';
  Object.assign(d.style, { left: (b.x - 5) + 'px', top: (b.y - 5) + 'px', width: (b.width + 10) + 'px', height: (b.height + 10) + 'px' });
  document.documentElement.appendChild(d); }; })()`;

/** Labels from a step's words (**Label**) not visible on the page: by accessible name or by text. */
async function missingLabels(page, text) {
  const out = [];
  for (const p of stepParts(text).filter((x) => x.ui)) {
    const label = p.text.replace(/…$/, "");
    const hit = await page.evaluate((l) => {
      const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      for (const e of document.querySelectorAll("body *")) {
        if (!seen(e)) continue;
        const own = norm([...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" "));
        if (own.includes(l) || norm(e.getAttribute("aria-label")).includes(l) || norm(e.getAttribute("placeholder")).includes(l)
          || (e.tagName === "LABEL" && norm(e.textContent).includes(l)) || ((e.tagName === "BUTTON" || e.tagName === "A") && norm(e.textContent).includes(l))) return true;
      }
      return false;
    }, label);
    if (!hit) out.push(p.text);
  }
  return out;
}

/** Signs in once per person and keeps the session (a slow dev server can wipe a fill made before hydration, so the
 *  fields are checked before pressing Sign in, and it tries again). */
const sessions = {};
async function session(browser, base, user, logins) {
  if (sessions[user]) return sessions[user];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctx = await browser.newContext({ ...DESKTOP, locale: "en-IN", timezoneId: "Asia/Kolkata" });
    const page = await ctx.newPage();
    try {
      await page.goto(new URL("/login", base).toString(), { waitUntil: "domcontentloaded", timeout: 180000 });
      await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(2500 * attempt);
      await page.locator('input[name="username"]').fill(user);
      await page.locator('input[name="password"]').fill(logins[user]);
      if ((await page.locator('input[name="username"]').inputValue()) !== user) throw new Error("the form was not ready");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 180000 });
      sessions[user] = await ctx.storageState();
      return sessions[user];
    } catch (e) {
      console.log(`sign-in ${user}, try ${attempt}: ${String(e).split("\n")[0].slice(0, 160)}`);
    } finally {
      await ctx.close();
    }
  }
  throw new Error(`could not sign in as ${user}`);
}

async function main() {
  const [outDir, only] = process.argv.slice(2);
  if (!outDir) { console.error("usage: node shots.mjs <outdir> [id,id]"); process.exit(2); }
  const base = process.env.REELS_BASE;
  if (!base) throw new Error("REELS_BASE is not set");
  const logins = process.env.REELS_LOGINS ? JSON.parse(fs.readFileSync(process.env.REELS_LOGINS, "utf8")) : {};
  const ids = only ? only.split(",") : TUTORIALS.map((t) => t.id);
  const report = fs.existsSync(path.join(outDir, "shots.json")) ? JSON.parse(fs.readFileSync(path.join(outDir, "shots.json"), "utf8")) : {};
  const browser = await chromium.launch({ executablePath: process.env.REELS_CHROME || undefined, args: ["--disable-dev-shm-usage", "--font-render-hinting=none"] });
  try {
    for (const id of ids) {
      const t = TUTORIALS.find((x) => x.id === id);
      const sbFile = path.join(HERE, "storyboards", `${id}.json`);
      if (!t || !fs.existsSync(sbFile)) { console.log(`${id}: no tutorial or storyboard`); continue; }
      const screens = JSON.parse(fs.readFileSync(sbFile, "utf8")).screens;
      if (!screens) { console.log(`${id}: storyboard has no screens`); continue; }
      const dir = path.join(outDir, id);
      fs.mkdirSync(dir, { recursive: true });
      const who = (screens.setup || []).find((s) => s.do === "login")?.user;
      const storageState = who ? await session(browser, base, who, logins) : undefined;
      const ctx = await browser.newContext({ ...DESKTOP, storageState, colorScheme: "light", locale: "en-IN", timezoneId: "Asia/Kolkata" });
      await ctx.addInitScript(() => {
        const add = () => { const st = document.createElement("style"); st.textContent = "nextjs-portal{display:none!important}"; document.documentElement.appendChild(st); };
        if (document.documentElement) add(); else document.addEventListener("DOMContentLoaded", add);
        window.addEventListener("unhandledrejection", (e) => { e.stopImmediatePropagation(); e.preventDefault(); }, true);
      });
      const page = await ctx.newPage();
      page.setDefaultTimeout(180000);
      const rec = { shots: {}, error: null };
      const log = [];
      try {
        for (const s of screens.setup || []) if (s.do !== "login") await runStep(page, { timeout: 120000, ...s }, log, base, logins);
        for (const s of screens.steps) {
          if (s.do) await runStep(page, { timeout: 120000, ...s }, log, base, logins);
          if (!s.shot) continue;
          await page.waitForTimeout(s.settle ?? 900);
          await page.evaluate(RING);
          const b = s.focus ? await locate(page, s.focus).boundingBox().catch(() => null) : null;
          await page.evaluate((bb) => window.__learnRing(bb), b);
          // `blur`: [{sel}] hides what must not be pictured (a client link carries a token).
          for (const bl of s.blur || []) await page.evaluate((sel) => document.querySelectorAll(sel).forEach((e) => { e.style.filter = "blur(9px)"; }), bl.sel);
          await page.screenshot({ path: path.join(dir, `${s.shot}.png`) });
          await page.evaluate(() => window.__learnRing(null));
          const step = t.steps.find((x) => x.shot === s.shot);
          const missing = step ? await missingLabels(page, step.text) : ["(no step on the Learn page uses this shot)"];
          rec.shots[s.shot] = { missing, focus: !!b || !s.focus };
          console.log(`${id}/${s.shot}: ${missing.length ? "MISSING " + missing.join(", ") : "labels ok"}${s.focus && !b ? " · focus not found" : ""}`);
        }
      } catch (e) {
        rec.error = String(e && e.message ? e.message : e).split("\n")[0].slice(0, 300);
        await page.screenshot({ path: path.join(dir, "error.png") }).catch(() => {});
        console.log(`${id}: ERROR ${rec.error}`);
      }
      for (const st of t.steps) if (st.shot && !rec.shots[st.shot]) rec.shots[st.shot] = { missing: ["(not shot)"], focus: false };
      report[id] = rec;
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(outDir, "shots.json"), JSON.stringify(report, null, 1));
  const bad = Object.values(report).filter((r) => r.error || Object.values(r.shots).some((x) => x.missing.length));
  console.log(bad.length ? `${bad.length} tutorial(s) need a look (shots.json)` : "all shots ok");
  process.exit(bad.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
