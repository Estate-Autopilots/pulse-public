// READABILITY GATE (QA-1 step 3b, owner 18 Nov 2026: "Yes, start stage 1"; QA-SYSTEM-RESEARCH §4.4): the checks R1-R15
// and axe-core on a Vitals screen, measured in the page by script, for no AI tokens. layout-audit.mjs keeps its rules
// (they ARE R1, R2, R3, R8, R9 here); this module adds the rest and runs them per state (width × theme × text size).
//
//   R1  sideways overflow        layout-audit "sideways"
//   R2  text overlap             layout-audit "overlap"
//   R3  cut text                 layout-audit "clipped", "spill" (and "truncated" as a warning)
//   R4  contrast                 axe-core color-contrast (both themes)
//   R5  text over image/gradient the worst pixel behind the text (screenshot of the box with the text hidden)
//   R6  tap target               under 24×24 px with no 24 px spacing (axe target-size and our own); phone main actions
//                                under 44 px and gaps under 8 px are warnings
//   R7  tiny text                under 12 px at 100% text (11 px for captions: small, figcaption, caption, time, sup, sub)
//   R8  covered control          layout-audit "covered"
//   R9  out of reach             layout-audit "unreachable", "end", "cramped"
//   R10 junk on screen           undefined, NaN, null, [object Object], Invalid Date, U+FFFD, raw message keys
//   R11 empty / loading / error  blank main, an error page, a console error, a failed request (5xx), a layout jump > 0.1
//   R12 large text               every check again at 130% text (state "-130")
//   R13 dark mode                every check again in dark, plus text the colour of its background, a white box
//   R14 long real-shaped data    every check again on the "long" synthetic organisation (QA-1 step 4b)
//   R15 hover and open states    R2, R8, R9 again with each menu / popup toggle open (first 4 per screen)
//
// "certain" findings block (once they are not in the baseline); "warn" ones are reported. `[data-layout-ok]` exempts a
// subtree, as in layout-audit (say why beside it). Every browser here refuses API writes (openContext).
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCKING, auditLayout, openContext, settle } from "./layout-audit.mjs";

export const RULES = Object.freeze({
  R1: "Sideways overflow", R2: "Text overlap", R3: "Cut text", R4: "Contrast", R5: "Text over an image or gradient", R6: "Tap target",
  R7: "Tiny text", R8: "Covered control", R9: "Out of reach", R10: "Junk on screen", R11: "Empty, loading or error state",
  R12: "Large text", R13: "Dark mode", R14: "Long real-shaped data", R15: "Hover and open states", AXE: "Accessibility (axe-core)",
});
const FROM_LAYOUT = { sideways: "R1", overlap: "R2", spill: "R3", clipped: "R3", truncated: "R3", covered: "R8", unreachable: "R9", end: "R9", cramped: "R9" };

/** The corner states (L0): the owner's 363 px Note 8 and 1440 px, light and dark, and 130% text on the phone in dark. */
export const CORNERS = Object.freeze([
  { name: "363-light", width: 363, height: 800, theme: "light", text: 1 },
  { name: "363-dark", width: 363, height: 800, theme: "dark", text: 1 },
  { name: "1440-light", width: 1440, height: 900, theme: "light", text: 1 },
  { name: "1440-dark", width: 1440, height: 900, theme: "dark", text: 1 },
  { name: "363-dark-130", width: 363, height: 800, theme: "dark", text: 1.3 },
]);
export const stateOf = (name) => {
  const m = /^(\d+)(?:x(\d+))?-(light|dark)(?:-(\d+))?$/.exec(name);
  if (!m) throw new Error(`state "${name}": <width>[x<height>]-<light|dark>[-<text %>]`);
  const width = Number(m[1]);
  return { name, width, height: Number(m[2] || (width < 600 ? 800 : 900)), theme: m[3], text: m[4] ? Number(m[4]) / 100 : 1 };
};

/** axe-core's browser build, from the workspace (it is in the lockfile through the web app's lint plugins). */
export function axePath() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (let dir = here, i = 0; i < 6; i++, dir = dirname(dir)) {
    const direct = join(dir, "node_modules/axe-core/axe.min.js");
    if (existsSync(direct)) return direct;
    const store = join(dir, "node_modules/.pnpm");
    if (existsSync(store)) {
      const hit = readdirSync(store).filter((d) => d.startsWith("axe-core@")).sort().pop();
      if (hit) return join(store, hit, "node_modules/axe-core/axe.min.js");
    }
  }
  return null;
}

/** The in-page checks this module adds (R5 candidates, R6, R7, R10, R11, R13). Serializable: no outer scope. */
export function readabilityAudit(options = {}) {
  const theme = options.theme ?? "light", textScale = options.textScale ?? 1, phone = innerWidth < 600, max = options.max ?? 80;
  const findings = [], seen = new Set(), candidates = [];
  const style = (el) => getComputedStyle(el);
  const exempt = (el) => !!el.closest("[data-layout-ok],[data-layout-marks]");
  const where = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const label = el.getAttribute("aria-label") || el.getAttribute("title") || (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${el.tagName.toLowerCase()}${id}${label ? ` "${label}"` : ""}`;
  };
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const add = (rule, el, detail, kind = "certain") => {
    const w = el ? where(el) : "page", key = `${rule}|${w}|${detail}`;
    if (seen.has(key) || findings.length >= max) return;
    seen.add(key); findings.push({ rule, where: w, detail, kind, box: el ? box(el) : null });
  };
  const shown = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const c = style(e);
      if (c.display === "none" || c.visibility === "hidden" || Number(c.opacity) === 0) return false;
      if (c.position === "absolute" && c.clip === "rect(0px, 0px, 0px, 0px)") return false;
    }
    const r = el.getBoundingClientRect();
    // Parked off the page (a skip link above or left of it until focused) is not on screen.
    if (r.right <= 0 || r.bottom + scrollY <= 0 || r.left >= document.documentElement.scrollWidth) return false;
    return r.width > 1 && r.height > 1;
  };
  const rgba = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s || ""); if (!m) return null; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  /** The colour behind an element (ancestors' backgrounds composed), and whether an image or gradient is in the way. */
  const behind = (el) => {
    const layers = []; let image = false;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const c = style(e);
      if (c.backgroundImage && c.backgroundImage !== "none") { image = true; break; }
      const bg = rgba(c.backgroundColor);
      if (bg && bg[3] > 0) { layers.push(bg); if (bg[3] >= 0.99) break; }
    }
    let out = theme === "dark" ? [0, 0, 0] : [255, 255, 255];
    for (const [r, g, b, a] of layers.reverse()) out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
    return { colour: out, image };
  };

  // Text: every element that directly holds visible text.
  const texts = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && texts.size < 5000; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || !n.textContent.trim() || texts.has(el) || exempt(el) || el.closest("script,style,noscript,template")) continue;
    texts.add(el);
  }
  const JUNK = /(^|[^\w-])(undefined|NaN|null)(?![\w-])|\[object Object\]|Invalid Date|�/;
  const KEY = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+){2,}$/;
  for (const el of texts) {
    if (!shown(el)) continue;
    const c = style(el), size = parseFloat(c.fontSize), own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ").trim();
    // R7: at 100% text only (at 130% everything is larger by design).
    if (textScale === 1 && size < 12) {
      const caption = !!el.closest("small,figcaption,caption,time,sup,sub,[data-caption]");
      if (size < 11 || !caption) add("R7", el, `${size}px text${caption ? " (captions may be 11 px)" : ""}`);
    }
    // R10: words a person should never read.
    if (!el.closest("code,pre,kbd,samp,textarea,[contenteditable]")) {
      const m = JUNK.exec(own);
      if (m) add("R10", el, `shows "${(m[2] || m[0]).trim()}"`);
      else if (KEY.test(own) && !/\.(ai|com|in|io|org|net|app|dev|co)$/.test(own) && !/@/.test(own)) add("R10", el, `a raw message key "${own.slice(0, 60)}"`);
    }
    // R13: text the colour of its background (dark mode), R5 candidates (text drawn on an image or gradient).
    const fg = rgba(c.color);
    if (!fg || fg[3] < 0.1) continue;
    const b = behind(el);
    if (b.image) {
      if (candidates.length < 12) {
        el.setAttribute("data-gate-r5", String(candidates.length));
        candidates.push({ index: candidates.length, large: size >= 24 || (size >= 18.66 && Number(c.fontWeight) >= 700), colour: fg.slice(0, 3), where: where(el), box: box(el) });
      }
    }
    else if (theme === "dark" && ratio(fg, b.colour) < 1.6) add("R13", el, `text the colour of its background (${ratio(fg, b.colour).toFixed(2)}:1)`);
  }

  // R13: a white box left in dark mode (a hard-coded background).
  if (theme === "dark") {
    for (const el of [document.body, ...document.querySelectorAll("body *")]) {
      if (exempt(el) || el.matches("img,video,canvas,svg,svg *,picture,iframe,input[type=color]")) continue;
      const bg = rgba(style(el).backgroundColor);
      if (!bg || bg[3] < 0.9 || lum(bg) < 0.85) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height >= 2400 && shown(el)) add("R13", el, `a light box (${style(el).backgroundColor}) in dark mode`);
    }
  }

  // R6: tap targets. WCAG 2.5.8: under 24×24 fails unless a 24 px circle on it touches no other target; inline links in
  // a sentence are exempt. Phones: main actions under 44 px tall and gaps under 8 px are warnings.
  const TARGETS = "a[href],button,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=radio],input:not([type=hidden]),select,textarea,summary";
  const targets = [...document.querySelectorAll(TARGETS)].filter((el) => !exempt(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true" && shown(el));
  const centres = targets.map((el) => { const r = el.getBoundingClientRect(); return { el, r, x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  for (const t of centres) {
    const { el, r } = t;
    if (r.width >= 24 && r.height >= 24) continue;
    const inline = el.matches("a") && style(el).display === "inline" && [...(el.parentElement?.childNodes ?? [])].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (inline || el.matches("input[type=checkbox],input[type=radio]") && el.closest("label")) continue;
    const spaced = centres.every((o) => o === t || o.el.contains(el) || el.contains(o.el) || Math.hypot(o.x - t.x, o.y - t.y) >= 24);
    if (!spaced) add("R6", el, `${Math.round(r.width)}×${Math.round(r.height)} px target with others closer than 24 px`);
  }
  if (phone) {
    for (const el of targets.filter((e) => e.matches("button[type=submit],[data-primary],.primary,[class*='btn-primary']"))) {
      const r = el.getBoundingClientRect();
      if (r.height < 44) add("R6", el, `a main action ${Math.round(r.height)} px tall (44 on phones)`, "warn");
    }
  }

  // R11: a blank main area or an error page; a layout jump after load (window.__gateShift, set by the context).
  const main = document.querySelector("main");
  if (!main) add("R11", null, "no <main> on the page", "warn");
  else if (!main.innerText.trim() && !main.querySelector("img,svg,canvas,video")) add("R11", main, "the main area is blank");
  const errorText = /Application error|Unhandled Runtime Error|This page could not be found|Internal Server Error|Something went wrong/i.exec(document.body.innerText);
  if (errorText) add("R11", main ?? document.body, `the page says "${errorText[0]}"`);
  if ((window.__gateShift ?? 0) > 0.1) add("R11", null, `the layout jumped after load (shift ${window.__gateShift.toFixed(2)})`);
  return { findings, candidates };
}

/** R5: the worst contrast between a candidate's text colour and the pixels behind it (in the page; PNG from the node side). */
export async function worstContrast({ png, colour }) {
  const img = new Image();
  img.src = `data:image/png;base64,${png}`;
  await img.decode();
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
  const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  const lum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const text = lum(...colour);
  let worst = 21;
  const step = Math.max(1, Math.floor(Math.sqrt((c.width * c.height) / 4000)));
  for (let y = 0; y < c.height; y += step) for (let x = 0; x < c.width; x += step) {
    const i = (y * c.width + x) * 4, l = lum(data[i], data[i + 1], data[i + 2]);
    const r = (Math.max(l, text) + 0.05) / (Math.min(l, text) + 0.05);
    if (r < worst) worst = r;
  }
  return worst;
}

/** Animations and transitions end at once (their end state is what the checks measure). settle() waits for every finite
 * animation, several times a screen, and the "new" dots run 7 rounds: about 60 s a screen-state on a software renderer,
 * 10-17 s with this, the same findings (QA-2's night matrix, 18 Nov 2026). */
export const FAST_MOTION = "*,*::before,*::after{animation-duration:1ms!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:1ms!important;transition-delay:0s!important}";
/** A live stream (chat and call events) never ends, and an aborted one is retried at once with a "Failed to load
 * resource" each time (a false R11): it is answered empty, asking the browser to wait ten minutes before reconnecting. */
export const isLiveStream = (url, headers = {}) => /\/events$|\/stream$/.test(new URL(url).pathname) || String(headers.accept ?? "").includes("text/event-stream");

/** A context for one state: layout-audit's (viewport, theme, no API writes: held writes answer 204), plus the text size,
 * a layout-shift meter, motion that ends at once (`fastMotion: false` keeps the page's own) and empty live streams. */
export async function gateContext(browser, { base, email, session, state, fastMotion = true }) {
  const ctx = await openContext(browser, { base, email, session, width: state.width, height: state.height, theme: state.theme });
  const origin = new URL(base).origin;
  // Registered after openContext's route, so it is asked first; anything else falls back to that one.
  await ctx.route("**/*", (route) => {
    const req = route.request();
    if (new URL(req.url()).origin === origin && req.method() === "GET" && isLiveStream(req.url(), req.headers())) {
      return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store" }, body: "retry: 600000\n\n" });
    }
    return route.fallback();
  });
  await ctx.addInitScript(([scale, motion]) => {
    window.__gateShift = 0;
    try { new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__gateShift += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch {}
    document.addEventListener("DOMContentLoaded", () => {
      if (scale !== 1) { const s = document.createElement("style"); s.textContent = `html{font-size:${scale * 100}% !important;-webkit-text-size-adjust:${scale * 100}% !important}`; document.head.append(s); }
      if (motion) { const s = document.createElement("style"); s.dataset.gate = "fast-motion"; s.textContent = motion; document.head.append(s); }
    });
  }, [state.text ?? 1, fastMotion ? FAST_MOTION : ""]);
  return ctx;
}

const fromLayout = (f) => ({ rule: FROM_LAYOUT[f.rule] ?? "R9", where: f.where, detail: `${f.rule}: ${f.detail}`, kind: BLOCKING.includes(f.rule) ? "certain" : "warn", box: f.box ?? null });

/** The axe-core rules whose findings are certain (R4, R6); the rest are warnings. The land gate runs only these. */
export const AXE_BLOCKING = Object.freeze(["color-contrast", "target-size"]);

/** Console errors about the machine or the dev server, not the screen (QA-1F, 19 Nov 2026), are warnings:
 * - Chromium's network-change family: ea's network interfaces change as containers start and stop, and every request in
 *   flight fails with it (40 of 41 false "new" findings in one 24-minute run of dev/live against its own baseline);
 * - React's dev-only notice that attributes did not hydrate: production ignores such a mismatch without a word, and a
 *   slow first compile on ea (60 s) is enough for a time-dependent attribute to differ between server and browser.
 * While the network changes, a screen-state's loading and error checks (R11) are not judged (an error is recorded). */
export const MACHINE_NETWORK = /net::ERR_(NETWORK_CHANGED|INTERNET_DISCONNECTED|NETWORK_IO_SUSPENDED)\b/;
const DEV_ONLY_CONSOLE = /A tree hydrated but some attributes of the server rendered HTML didn't match the client properties/;
export const consoleKind = (text) => (MACHINE_NETWORK.test(text) || DEV_ONLY_CONSOLE.test(text) ? "warn" : "certain");

/** Opens one screen in a gate context and runs every check. `axeRules` runs only those axe rules (default: all of WCAG
 * 2.2 A and AA). Returns { findings, errors }. */
export async function auditScreen(ctx, url, { axe = true, axeRules = null, open = true, timeout = 90_000, state } = {}) {
  const page = await ctx.newPage();
  const errors = [], findings = [], origin = new URL(url).origin;
  let netChanged = false;
  page.on("pageerror", (e) => findings.push({ rule: "R11", where: "page", detail: `script error: ${e.message.slice(0, 160)}`, kind: "certain", box: null }));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text(); if (MACHINE_NETWORK.test(text)) netChanged = true;
    findings.push({ rule: "R11", where: "console", detail: `console error: ${text.slice(0, 160)}`, kind: consoleKind(text), box: null });
  });
  page.on("requestfailed", (r) => { if (MACHINE_NETWORK.test(r.failure()?.errorText ?? "")) netChanged = true; });
  page.on("response", (r) => { const u = new URL(r.url()); if (u.origin === origin && r.status() >= 500) findings.push({ rule: "R11", where: u.pathname, detail: `request failed: HTTP ${r.status()}`, kind: "certain", box: null }); });
  try {
    const response = await page.goto(url, { waitUntil: "load", timeout });
    if (response && response.status() >= 400) findings.push({ rule: "R11", where: "page", detail: `HTTP ${response.status()}`, kind: "certain", box: null });
    await page.waitForFunction(() => { const m = document.querySelector("main"); return m && m.innerText.trim().length > 10 && !m.querySelector("[aria-busy='true']"); }, {}, { timeout: Math.min(timeout, 60_000) })
      .catch(() => findings.push({ rule: "R11", where: "main", detail: "the main area never showed its content (60 s)", kind: "certain", box: null }));
    await settle(page, 600);
    const { findings: layout } = await page.evaluate(auditLayout, {});
    findings.push(...layout.map(fromLayout));
    const own = await page.evaluate(readabilityAudit, { theme: state?.theme, textScale: state?.text ?? 1 });
    findings.push(...own.findings);
    // R5: hide the candidate's text, photograph what is behind it, find the worst pixel.
    for (const cand of own.candidates.slice(0, 8)) {
      const b = cand.box;
      if (b.w < 2 || b.h < 2 || b.x + b.w <= 0 || b.y + b.h <= 0) continue;
      const sel = `[data-gate-r5="${cand.index}"]`;
      const prev = await page.$eval(sel, (el) => { const p = el.style.cssText; el.style.setProperty("color", "transparent", "important"); el.style.setProperty("text-shadow", "none", "important"); return p; }).catch(() => null);
      if (prev === null) continue;
      const clip = { x: Math.max(0, b.x), y: Math.max(0, b.y), width: Math.max(2, b.w), height: Math.max(2, b.h) };
      const png = (await page.screenshot({ clip }).catch(() => null))?.toString("base64");
      await page.$eval(sel, (el, p) => { el.style.cssText = p; }, prev).catch(() => {});
      if (!png) continue;
      const worst = await page.evaluate(worstContrast, { png, colour: cand.colour });
      if (worst < (cand.large ? 3 : 4.5)) findings.push({ rule: "R5", where: cand.where, detail: `text over an image or gradient: worst pixel ${worst.toFixed(2)}:1`, kind: "certain", box: b });
    }
    // R4 and the rest of axe-core (WCAG 2.2 A and AA).
    const ax = axe ? axePath() : null;
    if (axe && !ax) errors.push("axe-core not found: R4 not checked");
    if (ax) {
      await page.addScriptTag({ path: ax });
      const runOnly = axeRules?.length ? { type: "rule", values: [...axeRules] } : { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] };
      const violations = await page.evaluate(async (only) => (await window.axe.run(document, { resultTypes: ["violations"], runOnly: only }))
        .violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 10).map((n) => ({ target: String(n.target?.[0] ?? ""), summary: (n.failureSummary || "").split("\n").slice(1, 2).join(" ").trim() })) })), runOnly);
      for (const v of violations) for (const n of v.nodes) {
        const rule = v.id === "color-contrast" ? "R4" : v.id === "target-size" ? "R6" : "AXE";
        findings.push({ rule, where: n.target, detail: `${v.id}: ${(n.summary || v.help).slice(0, 160)}`, kind: rule !== "AXE" ? "certain" : "warn", box: null, axe: v.id, impact: v.impact });
      }
    }
    // R15: each popup toggle open in turn; what newly covers, overlaps or falls out of reach.
    if (open) {
      const before = new Set(layout.filter((f) => BLOCKING.includes(f.rule)).map((f) => `${f.rule}|${f.where}`));
      const toggles = await page.$$("main [aria-haspopup]:not([aria-disabled=true]), main [aria-expanded=false], header [aria-haspopup], nav [aria-haspopup]");
      const path = page.url();
      for (const t of toggles.slice(0, 4)) {
        const label = await t.evaluate((el) => (el.getAttribute("aria-label") || el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 40)).catch(() => "");
        if (!(await t.isVisible().catch(() => false))) continue;
        await t.click({ timeout: 3000 }).catch(() => {});
        await settle(page, 300);
        if (page.url() !== path) { await page.goto(path, { waitUntil: "load" }).catch(() => {}); await settle(page, 400); break; }
        // The popup that opened: the toggle's aria-controls target, else an open dialog, menu, listbox or popover. What
        // a modal hides behind it (scroll locked) is not a finding; only what is inside the popup is.
        const popups = await t.evaluate((el) => {
          const own = (el.getAttribute("aria-controls") || "").split(/\s+/).map((id) => id && document.getElementById(id)).filter(Boolean);
          const open = own.length ? own : [...document.querySelectorAll("[role=dialog],[role=menu],[role=listbox],[aria-modal=true],dialog[open],[popover]:popover-open,[data-state=open]:not([aria-expanded])")];
          return open.map((p) => ({ r: p.getBoundingClientRect(), text: (p.innerText || "").replace(/\s+/g, " ") })).filter(({ r }) => r.width > 1 && r.height > 1)
            .map(({ r, text }) => ({ x: r.x, y: r.y, w: r.width, h: r.height, text }));
        }).catch(() => []);
        // Inside a popup: its box lies within the popup AND (when the finding names its text) that text is the popup's own,
        // so what a full-screen sheet merely sits on top of (the toggle, the page behind) is not counted.
        const inside = (f) => f.box && popups.some((p) => {
          const b = f.box, label = /«(.+?)»/.exec(String(f.where))?.[1]?.replace(/…$/, "").trim();
          return b.x >= p.x - 1 && b.y >= p.y - 1 && b.x + b.w <= p.x + p.w + 1 && b.y + b.h <= p.y + p.h + 1 && (!label || p.text.includes(label.slice(0, 30)));
        });
        const { findings: now } = popups.length ? await page.evaluate(auditLayout, {}) : { findings: [] };
        for (const f of now) if (["covered", "overlap", "unreachable", "end"].includes(f.rule) && !before.has(`${f.rule}|${f.where}`) && inside(f)) {
          findings.push({ rule: "R15", where: f.where, detail: `with "${label}" open: ${f.rule}: ${f.detail}`, kind: "certain", box: f.box ?? null });
        }
        await page.keyboard.press("Escape").catch(() => {});
        await settle(page, 200);
      }
    }
  } catch (e) {
    errors.push(String(e.message ?? e).slice(0, 300));
  } finally {
    await page.close();
  }
  if (netChanged) {
    for (const f of findings) if (f.rule === "R11" && f.kind === "certain") f.kind = "warn";
    errors.push("the machine's network changed during the check (net::ERR_NETWORK_CHANGED): its loading and error checks (R11) are not judged");
  }
  return { findings, errors };
}

/** Words in a label that change with the calendar, not with the code. */
const DATE_WORDS = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu|thurs?|fri|sat|sun|today|yesterday|tomorrow|tonight|now|ago)\b/gi;
/** A finding's identity for the baseline: route, state, rule and where (numbers and calendar words blurred, so counts,
 * ids and dates do not count, "9+" is a number too; a CSS module's build hash dropped, `.work3-module__okylgG__lenses` → `.work3-module__lenses`). */
export const fingerprint = (path, state, f) => [path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id"), state, f.rule,
  String(f.where).replace(/-module__[A-Za-z0-9_-]{4,12}?__/g, "-module__").replace(DATE_WORDS, "<date>").replace(/\d+\+?/g, "#")].join(" | ");
