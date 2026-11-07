// DROPDOWNS (4 Nov 2026): opens every dropdown Pulse draws on a page and checks it the way the owner uses it, at
// 1920×1080, 1366×768 and 390×844 (a phone, touch): the list sits inside the window; its last option can be reached by
// the wheel (a touch swipe on the phone) without the page behind it moving; the keyboard works (End/Home reach the ends,
// ↓ moves, a letter jumps or searches, Escape closes; a kit select also opens from the keyboard); and the chosen option
// is in view when it opens. One screenshot per open dropdown. Read-only: every write request is refused in the browser,
// and the runner never presses Enter on an option or clicks one.
//
//   BASE=http://127.0.0.1:3271 AS=kedab.mifos@synthetic.invalid node tests/e2e/dropdown-audit.mjs <out dir> [route,route…]
//
// Routes: every page under apps/web/app without a [segment], plus one sample of each [segment] route reached by a link
// from them, plus scripted cases (a dropdown behind a press; a long list injected into the Package select of Billing →
// New document, as on production; the same select near the bottom of the window, which must open upward).
// Writes <out>/report.json (one row per route × dropdown × viewport) and <out>/report.md.
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const [out = "/tmp/dropdown-audit", only] = process.argv.slice(2);
const base = process.env.BASE ?? "http://127.0.0.1:3200", who = process.env.AS ?? "kedab.mifos@synthetic.invalid";
const PER_ROUTE = Number(process.env.PER_ROUTE ?? 14);
const VIEWPORTS = (process.env.VIEWPORTS ?? "1920x1080,1366x768,390x844").split(",").map((v) => { const [w, h] = v.split("x").map(Number); return { w, h, phone: w < 600, name: v }; });
mkdirSync(out, { recursive: true });

// ------------------------------------------------------------------------------------------------------------ routes
const SKIP = /^\/(login|portal|signup|join|invited|oauth|welcome|start|team-setup|accept|connect|apps\/sales-xray\/callback|hidden|insights-demo|healthz|mcp|telemetry)(\/|$)/;
function pages(dir, prefix = "") {
  const found = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!name.startsWith("_") && !name.startsWith("(") && !name.startsWith("@") && name !== "api") found.push(...pages(p, `${prefix}/${name}`)); }
    else if (name === "page.tsx") found.push(prefix || "/");
  }
  return found;
}
const appDir = join(here, "../../apps/web/app");
const all = pages(appDir);
const patterns = all.filter((r) => r.includes("[")).map((r) => ({ r, re: new RegExp(`^${r.replace(/\[\.\.\.[^\]]+\]/g, ".+").replace(/\[[^\]]+\]/g, "[^/]+")}$`) }));
let routes = only ? only.split(",") : all.filter((r) => !r.includes("[") && !SKIP.test(r));
// EXTRA: more pages to open (comma-separated), e.g. a document, task or project that no list page links to.
if (process.env.EXTRA) routes = [...routes, ...process.env.EXTRA.split(",").filter(Boolean)];

// ------------------------------------------------------------------------------------------------------------ browser
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
async function context(vp) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, ...(vp.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    extraHTTPHeaders: { "cf-access-authenticated-user-email": who } });
  await ctx.addInitScript(() => { try { localStorage.setItem("pulse.notify.browser.asked", "1"); } catch { /* private */ } });
  // Read-only: nothing on pulse-dev changes because of the audit.
  await ctx.route("**/*", (route) => {
    const r = route.request(), u = new URL(r.url());
    if (u.pathname.endsWith("/events") || u.pathname.includes("/chats/events")) return route.abort();
    if (!["GET", "HEAD", "OPTIONS"].includes(r.method()) && u.pathname.startsWith("/api/")) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "dropdown audit: read-only" }) });
    return route.fallback();
  });
  return ctx;
}

const rows = [];
const slug = (s) => s.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home";
const settle = (page, ms = 350) => page.waitForTimeout(ms);

/** The dropdown triggers on the page (kit Combobox/Select/SelectField faces, kit menus, and native selects). */
async function triggers(page) {
  return page.evaluate(() => {
    const seen = [];
    const visible = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility !== "hidden" && !el.closest("[hidden],[inert]"); };
    const nameOf = (el) => (el.getAttribute("aria-label") || el.closest("label")?.childNodes[0]?.textContent || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    let i = 0;
    for (const el of document.querySelectorAll('button[aria-haspopup="listbox"], button[aria-haspopup="menu"], [role="combobox"][aria-haspopup], select:not([multiple])')) {
      if (el.closest("[data-layer], [popover]") || !visible(el) && !(el.tagName === "SELECT")) continue;
      if (el.tagName === "SELECT" && (el.closest("span")?.querySelector(':scope > button[aria-haspopup="listbox"]') || !visible(el))) continue; // a kit select's hidden real one
      if (el.disabled) continue;
      // A list row with a right-click menu (chats) is a row, not a dropdown.
      if (el.getAttribute("aria-haspopup") === "menu" && ((el.textContent || "").trim().length > 60 || !el.hasAttribute("aria-expanded"))) continue;
      const kind = el.tagName === "SELECT" ? "native-select" : el.getAttribute("aria-haspopup") === "menu" ? "menu" : el.getAttribute("aria-hidden") === "true" ? "select-field" : "combobox";
      el.setAttribute("data-dd-audit", String(i));
      seen.push({ i: i++, kind, name: nameOf(el) || kind, shell: !el.closest("main") });
    }
    return seen;
  });
}

/** Everything that scrolls on the page outside the floating layers, with its position. */
const pageScroll = (page) => page.evaluate(() => {
  const s = [scrollX, scrollY];
  for (const el of document.querySelectorAll("body *")) { if (el.closest("[data-layer], [popover], [role=menu], [role=listbox]")) continue; if (el.scrollTop || el.scrollLeft) s.push(el.scrollTop, el.scrollLeft); }
  return s.join(",");
});

/** The open floating list: its box, scroller, options and the active/chosen ones. */
/** Marks the lists and menus already on the page, so one that opens after a press can be told apart. */
const markOld = (page) => page.evaluate(() => { for (const x of document.querySelectorAll('[role="menu"], [role="listbox"]')) x.setAttribute("data-dd-old", ""); });
const layerState = (page) => page.evaluate(() => {
  const shown = (l) => !l.hasAttribute("data-closing") && l.getBoundingClientRect().height > 4 && getComputedStyle(l).visibility !== "hidden";
  // The kit's floating layer (in the top layer), else a list or menu that appeared after the press (one-off dropdowns).
  const layers = [...document.querySelectorAll("[data-layer], [popover]:popover-open")].filter(shown);
  const fresh = [...document.querySelectorAll('[role="menu"]:not([data-dd-old]), [role="listbox"]:not([data-dd-old])')].filter((x) => shown(x) && !x.closest("[data-layer], [popover]"));
  const l = layers.at(-1) ?? fresh.at(-1); if (!l) return null;
  const r = l.getBoundingClientRect();
  const opts = [...l.querySelectorAll('[role="option"], [role^="menuitem"]')];
  let box = null;
  for (const n of [l, ...l.querySelectorAll("*")]) { const oy = getComputedStyle(n).overflowY; if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1) { box = n; break; } }
  const inView = (el) => { if (!el) return null; const e = el.getBoundingClientRect(), b = (box ?? l).getBoundingClientRect(); return e.top >= Math.max(0, b.top) - 1 && e.bottom <= Math.min(innerHeight, b.bottom) + 1 && e.height > 0; };
  // The active option: focus (menus), aria-activedescendant / aria-selected (kit), or a data-on/data-active mark.
  const marked = opts.findIndex((o) => o.hasAttribute("data-on") || o.hasAttribute("data-active"));
  const active = marked >= 0 ? marked : opts.findIndex((o) => o.getAttribute("aria-selected") === "true" || o === document.activeElement);
  const chosen = opts.findIndex((o) => o.hasAttribute("data-chosen") || o.getAttribute("aria-checked") === "true");
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: document.documentElement.clientWidth, vh: innerHeight, side: l.dataset.side ?? null,
    n: opts.length, scrolls: !!box, scrollTop: box?.scrollTop ?? 0, lastInView: inView(opts.at(-1)), firstInView: inView(opts[0]), active, activeInView: active >= 0 ? inView(opts[active]) : null,
    chosen, chosenInView: chosen >= 0 ? inView(opts[chosen]) : null, labels: opts.map((o) => (o.querySelector('[class*="lbMain"] > span')?.textContent ?? o.textContent ?? "").trim().slice(0, 40)),
    center: { x: r.left + r.width / 2, y: (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2 }, search: !!(l.closest('[role="dialog"]') ?? l).querySelector('input[role="combobox"], input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])') };
});

async function touchSwipe(page, x, y, dy, top, bottom) {
  // The finger stays on the list (a touch outside it is a tap outside, which closes it).
  if (top !== undefined) { const t = Math.max(0, top) + 10, b = Math.min(page.viewportSize().height, bottom) - 10; dy = Math.max(4, Math.min(dy, b - t)); y = (t + b) / 2; }
  const cdp = await page.context().newCDPSession(page);
  // A finger: down, up the screen in small steps, lifted.
  const at = (yy) => [{ x: Math.round(x), y: Math.round(yy), id: 1 }];
  const y0 = y + dy / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(y0) });
  for (let i = 1; i <= 10; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(y0 - (dy * i) / 10) }); await new Promise((r) => setTimeout(r, 16)); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** Opens one dropdown and runs the checks; returns the row. */
async function check(page, vp, route, t, shot) {
  const row = { route, viewport: vp.name, dropdown: t.name, kind: t.kind, checks: {}, notes: [] };
  const el = page.locator(`[data-dd-audit="${t.i}"]`);
  if (t.kind === "native-select") {
    // The browser's own list (Chrome's customizable select where supported): sized and scrolled by the browser. Checked:
    // keyboard focus and ↓ (value moves) — the value is put back after.
    const r = await el.evaluate((s) => { s.focus(); return { before: s.selectedIndex, n: s.options.length }; });
    await page.keyboard.press(vp.phone ? "Tab" : "ArrowDown").catch(() => {});
    // Chrome's customizable select (appearance: base-select) opens its list on ↓; a classic one moves the value.
    const after = await el.evaluate((s, b) => { let open = false; try { open = s.matches(":open"); } catch { /* older engine */ } const i = s.selectedIndex; s.selectedIndex = b; return { i, open }; }, r.before);
    if (after.open) { await page.keyboard.press("Escape"); await settle(page, 150); }
    // Linux Chrome's classic select neither moves nor opens on ↓ (Windows moves the value): Space opens its list.
    let spaced = false;
    if (!vp.phone && !after.open && after.i === r.before && r.n > 1) {
      await el.focus(); await page.keyboard.press(" "); await settle(page, 200);
      spaced = await el.evaluate((s) => { try { return s.matches(":open"); } catch { return false; } });
      await page.keyboard.press("Escape"); await settle(page, 150); await el.evaluate((s, b) => { s.selectedIndex = b; }, r.before);
    }
    row.checks = { inViewport: "browser", wheelToLast: "browser", keyboard: vp.phone ? "n/a" : (r.n < 2 || after.open || after.i !== r.before || spaced) };
    row.pass = row.checks.keyboard !== false; return row;
  }
  await el.evaluate((b) => b.scrollIntoView({ block: "center", inline: "nearest" }));
  await settle(page, 150); await markOld(page);
  await el.click({ force: t.kind === "select-field", timeout: 5000 }).catch((e) => row.notes.push(`click: ${e.message.split("\n")[0]}`));
  await settle(page);
  let s = await layerState(page);
  if (!s) { row.notes.push("no list opened"); row.pass = null; return row; }
  row.options = s.n; row.side = s.side;
  const inVp = (x) => x.top >= -1 && x.bottom <= x.vh + 1 && x.left >= -1 && x.right <= x.vw + 1;
  row.checks.inViewport = inVp(s);
  row.checks.chosenInView = s.chosen < 0 ? "n/a" : s.chosenInView;
  await page.screenshot({ path: `${shot}-open.png` });
  // Wheel (a swipe on the phone) to the end; the page behind must not move.
  const before = await pageScroll(page);
  let still = 0;
  for (let k = 0; k < 60; k++) {
    const st = s.scrollTop;
    if (vp.phone) await touchSwipe(page, s.center.x, s.center.y, 260, s.top, s.bottom); else { await page.mouse.move(s.center.x, s.center.y); await page.mouse.wheel(0, 240); }
    // Wheel scrolling is asynchronous (and slower on a busy server): wait for it to land.
    for (let w = 0; w < 6; w++) { await settle(page, 70); s = await layerState(page); if (!s || s.scrollTop !== st) break; }
    if (!s) break;
    still = s.scrollTop === st ? still + 1 : 0;
    if (process.env.DD_DEBUG) console.log("  scroll", k, st, "->", s.scrollTop, "last", s.lastInView, "scrolls", s.scrolls);
    if (s.lastInView && (still || !s.scrolls)) break;
    if (still >= 3) break;
  }
  if (!s) { row.notes.push("list closed while scrolling"); row.checks.wheelToLast = false; row.pass = false; return row; }
  row.checks.wheelToLast = !!s.lastInView;
  row.checks.pageStill = (await pageScroll(page)) === before;
  row.checks.inViewportAfter = inVp(s);
  await page.screenshot({ path: `${shot}-end.png` });
  // Keyboard: Home, End, ↓, a letter, Escape.
  if (!vp.phone) {
    const k = {};
    await page.keyboard.press("Home"); await settle(page, 80); s = await layerState(page);
    k.home = !!s && (s.active === 0 || s.firstInView) && (s.active < 0 || s.activeInView);
    await page.keyboard.press("End"); await settle(page, 80); s = await layerState(page);
    k.end = !!s && s.lastInView && (s.active < 0 || s.activeInView);
    await page.keyboard.press("Home"); await page.keyboard.press("ArrowDown"); await settle(page, 80); s = await layerState(page);
    k.down = !!s && (s.n < 2 || s.active === 1 || (t.kind === "menu" && s.active >= 0));
    const target = s?.labels.slice(1).find((x) => /^[a-z]/i.test(x));
    if (target && !s.search) { await page.keyboard.press(target[0].toLowerCase()); await settle(page, 80); const s2 = await layerState(page); if (process.env.DD_DEBUG) console.log("  letter", target[0], s2?.active, JSON.stringify(s2?.labels), s2?.activeInView, await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 160))); k.typeahead = !!s2 && s2.active >= 0 && s2.labels[s2.active].toLowerCase().startsWith(target[0].toLowerCase()) && s2.activeInView; }
    else if (target && s.search) { await page.keyboard.type(target.slice(0, 3)); await settle(page, 150); const s2 = await layerState(page); if (process.env.DD_DEBUG) console.log("  typed", JSON.stringify(target.slice(0, 3)), JSON.stringify(s2?.labels.slice(0, 5)), await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 160))); k.typeahead = !!s2 && s2.labels.some((x) => x.toLowerCase().includes(target.slice(0, 3).toLowerCase())); }
    await page.keyboard.press("Escape"); await settle(page, 250);
    k.escape = !(await layerState(page));
    // A kit select opens from the keyboard on its (hidden, focused) real select; a kit button from ↓.
    if (t.kind === "select-field") {
      await el.evaluate((b) => b.parentElement?.querySelector("select")?.focus());
      await page.keyboard.press("Enter"); await settle(page); const s3 = await layerState(page);
      k.opensFromKeys = !!s3 && (s3.chosen < 0 || s3.chosenInView); await page.keyboard.press("Escape"); await settle(page, 200);
    } else {
      // ↓ on the button (kit), else Enter (a plain button that opens a list).
      await el.focus().catch(() => {}); await page.keyboard.press("ArrowDown"); await settle(page); let opened = !!(await layerState(page));
      if (!opened) { await el.focus().catch(() => {}); await page.keyboard.press("Enter"); await settle(page); opened = !!(await layerState(page)); }
      k.opensFromKeys = opened; await page.keyboard.press("Escape"); await settle(page, 200);
    }
    row.checks.keyboard = Object.values(k).every((v) => v !== false); row.keys = k;
  } else { await page.keyboard.press("Escape").catch(() => {}); await page.mouse.click(2, 2).catch(() => {}); await settle(page, 250); }
  if (await layerState(page)) { await page.keyboard.press("Escape"); await settle(page, 200); }
  row.pass = Object.values(row.checks).every((v) => v !== false);
  return row;
}

const shellDone = new Set();
async function audit(page, vp, route, label = route) {
  // The top bar's and Pip's menus are the same on every page: checked once per window size.
  const found = await triggers(page);
  const ts = found.filter((t) => !t.shell || !shellDone.has(`${vp.name}:${t.name}`));
  for (const t of ts) if (t.shell) shellDone.add(`${vp.name}:${t.name}`);
  const shellLabel = (t) => t.shell ? "(app shell, every page)" : label;
  const dir = join(out, vp.name); mkdirSync(dir, { recursive: true });
  for (const t of ts.slice(0, PER_ROUTE)) {
    let row;
    try { row = await check(page, vp, shellLabel(t), t, join(dir, `${slug(shellLabel(t))}-${t.i}`)); }
    catch (e) { row = { route: shellLabel(t), viewport: vp.name, dropdown: t.name, kind: t.kind, pass: false, notes: [`error: ${e.message.split("\n")[0]}`] }; await page.keyboard.press("Escape").catch(() => {}); }
    row.screenshot = join(vp.name, `${slug(shellLabel(t))}-${t.i}-end.png`);
    rows.push(row);
    console.log(`${row.pass === true ? "PASS" : row.pass === false ? "FAIL" : "SKIP"} ${vp.name} ${shellLabel(t)} [${t.kind}] ${t.name} ${row.pass ? "" : JSON.stringify(row.checks ?? {}) + " " + JSON.stringify(row.keys ?? {}) + " " + (row.notes ?? []).join("; ")}`);
  }
  if (ts.length > PER_ROUTE) console.log(`  (${ts.length - PER_ROUTE} more on ${label} not opened)`);
  return found.filter((t) => !t.shell).length;
}

// ------------------------------------------------------------------------------------------------------------ scripted
const longPackages = (n) => Array.from({ length: n }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `Audit package ${String(i + 1).padStart(2, "0")}`, price: 1000000, gstRate: 18, milestones: [], status: "draft", version: 1 }));
async function packageSelect(page, vp, low) {
  await page.route("**/api/v0/erp/projects/*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const r = await route.fetch(); const d = await r.json().catch(() => null);
    if (!d?.packages) return route.fulfill({ response: r });
    d.packages = [...d.packages, ...longPackages(36)]; d.canWrite = true;
    return route.fulfill({ response: r, json: d });
  });
  await page.goto(`${base}/erp/new?type=quotation`, { waitUntil: "load", timeout: 120000 });
  await page.getByRole("button", { name: /^Choose / }).first().click();
  await page.getByRole("button", { name: "Sell a package on this project" }).click();
  await settle(page, 600);
  const face = page.locator("label", { hasText: "Package" }).locator('button[aria-haspopup="listbox"]').first();
  if (low) {
    // Put the select near the bottom of the window: the list must open upward (more room there) and fit.
    await face.evaluate((b) => { let n = b.parentElement; while (n && !(n.scrollHeight > n.clientHeight && /auto|scroll/.test(getComputedStyle(n).overflowY))) n = n.parentElement; const sc = n ?? document.scrollingElement; const r = b.getBoundingClientRect(); sc.scrollTop += r.bottom - innerHeight + 60; });
    await settle(page, 300);
  }
  await face.evaluate((b) => { document.querySelectorAll("[data-dd-audit]").forEach((x) => x.removeAttribute("data-dd-audit")); b.setAttribute("data-dd-audit", "900"); });
  const label = `/erp/new?type=quotation (Package, 47 options${low ? ", near the bottom" : ""})`;
  const dir = join(out, vp.name); mkdirSync(dir, { recursive: true });
  const t = { i: 900, kind: "select-field", name: "Package" };
  if (low) {
    // Only placement here: no scrollIntoView first.
    const a = await face.boundingBox(), vh = vp.h, room = { above: a.y, below: vh - a.y - a.height };
    await markOld(page); await face.click({ force: true }); await settle(page);
    const s = await layerState(page);
    // It fits below, or it opens on the side with more room (upward when that is above).
    const fitsBelow = s && s.side === "bottom" && s.bottom - s.top >= s.n * 30;
    const row = { route: label, viewport: vp.name, dropdown: "Package", kind: "select-field", options: s?.n, side: s?.side, room,
      checks: { inViewport: !!s && s.top >= -1 && s.bottom <= s.vh + 1, sideWithMoreRoom: !!s && (fitsBelow || s.side === (room.above > room.below ? "top" : "bottom")) }, notes: [] };
    await page.screenshot({ path: join(dir, `erp-new-package-low-open.png`) }); row.screenshot = join(vp.name, "erp-new-package-low-open.png");
    row.pass = Object.values(row.checks).every(Boolean); rows.push(row); await page.keyboard.press("Escape");
    console.log(`${row.pass ? "PASS" : "FAIL"} ${vp.name} ${label} ${JSON.stringify(row.checks)}`);
    return;
  }
  const row = await check(page, vp, label, t, join(dir, "erp-new-package"));
  row.screenshot = join(vp.name, "erp-new-package-end.png"); rows.push(row);
  console.log(`${row.pass ? "PASS" : "FAIL"} ${vp.name} ${label} ${JSON.stringify(row.checks)} ${JSON.stringify(row.keys ?? {})} ${(row.notes ?? []).join("; ")}`);
}

// ------------------------------------------------------------------------------------------------------------ run
const withDropdowns = new Map();
for (const vp of VIEWPORTS) {
  const ctx = await context(vp); let page = await ctx.newPage(); page.setDefaultTimeout(60000);
  if (!only || only.includes("erp/new")) for (const low of [false, true]) {
    try { await packageSelect(page, vp, low); } catch (e) { rows.push({ route: "/erp/new?type=quotation (Package)", viewport: vp.name, dropdown: "Package", pass: false, notes: [e.message.split("\n")[0]] }); console.log("FAIL package", e.message.split("\n")[0]); }
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
  const list = vp === VIEWPORTS[0] ? routes : [...withDropdowns.keys()];
  const samples = new Map();
  for (let ri = 0; ri < list.length; ri++) {
    const route = list[ri];
    // A fresh tab per page: a page's own late navigation (a redirect, a replace) never lands on the next one.
    await page.close().catch(() => {}); page = await ctx.newPage(); page.setDefaultTimeout(60000);
    try {
      const res = await page.goto(base + route, { waitUntil: "load", timeout: 90000 });
      if (!res || res.status() >= 400) { console.log(`skip ${route}: HTTP ${res?.status()}`); continue; }
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await settle(page, 500);
      if (vp === VIEWPORTS[0] && !only) {
        // One sample of each [segment] route linked from here.
        const hrefs = await page.evaluate(() => [...document.querySelectorAll("main a[href^='/']")].map((a) => a.getAttribute("href").split(/[?#]/)[0]));
        for (const h of hrefs) { const p = patterns.find((x) => x.re.test(h)); if (p && !samples.has(p.r) && !SKIP.test(h)) { samples.set(p.r, h); list.push(h); } }
      }
      const n = await audit(page, vp, route);
      if (n && vp === VIEWPORTS[0]) withDropdowns.set(route, n);
    } catch (e) { console.log(`error ${route}: ${e.message.split("\n")[0]}`); }
  }
  await ctx.close();
}
await browser.close();

// ------------------------------------------------------------------------------------------------------------ report
writeFileSync(join(out, "report.json"), JSON.stringify(rows, null, 1));
const md = ["| route | dropdown | kind | viewport | options | side | result | failed checks |", "|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.route} | ${String(r.dropdown).replace(/\|/g, "/")} | ${r.kind ?? ""} | ${r.viewport} | ${r.options ?? ""} | ${r.side ?? ""} | ${r.pass === true ? "pass" : r.pass === false ? "FAIL" : "skip"} | ${Object.entries(r.checks ?? {}).filter(([, v]) => v === false).map(([k]) => k).concat(Object.entries(r.keys ?? {}).filter(([, v]) => v === false).map(([k]) => `key:${k}`)).concat(r.notes ?? []).join(", ")} |`)];
writeFileSync(join(out, "report.md"), md.join("\n") + "\n");
const fails = rows.filter((r) => r.pass === false).length;
console.log(`\n${rows.length} dropdown checks, ${rows.filter((r) => r.pass).length} pass, ${fails} fail, ${rows.filter((r) => r.pass === null).length} skipped; routes with dropdowns: ${withDropdowns.size}`);
process.exitCode = fails ? 1 : 0;
