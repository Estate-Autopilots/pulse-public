// FLOAT (owner, 21 Oct 2026: "the Pip buttons and all floating things and all the notifications: all of that is ugly
// and not working"): every element that floats over a page, in its states, screenshotted and clicked for real.
//
//   ea-heavy node tests/e2e/float-audit.mjs --base http://127.0.0.1:3200 --out ~/ea-research/flow/float-shots/before \
//     [--as admin@estateautopilots.com,hr@estateautopilots.com] [--sizes 1440x900,390x844] [--themes light,dark] [--paths /dashboard,/tasks]
//
// Writes `<out>/<who>-<path>-<size>-<theme>-<state>.png` and `<out>/audit.json` (findings per view: overlaps between
// floating things, the page's own buttons and the phone tab bar; things off screen or covered; menu items that did
// nothing). API writes are answered by the browser with an empty 204 (pulse-dev keeps its data); each attempted write
// is recorded, so "did something" means: a dialog opened, the page moved, a write was sent or a confirmation showed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const FLOATING = {
  pip: "[data-island] [data-pip]",
  pipMenu: "[data-island] [role=menu]",
  pipBubble: "[data-island][data-open] [data-island-content]",
  pipSummary: "[data-island] [role=tooltip]",
  checkin: "[data-shell-actions] button[data-state]",
  checkinMenu: "[data-checkin-menu]",
  review: "[data-shell-actions] a[href='/tasks?view=reviews']",
  bell: "[data-shell-actions] button[aria-haspopup=dialog][aria-label^='Notifications']",
  bellPanel: "#pulse-notices",
  companion: "[role=complementary][aria-label='Task companion']",
  insights: "[data-insights]",
  permission: "[role=region][aria-label='Notifications are off']",
  tabBar: "nav[aria-label='Mobile navigation']",
};

/** Boxes of everything floating, the page header's buttons and the tab bar, and what overlaps what. */
export const measure = (page) => page.evaluate((FLOATING) => {
  const vis = (el) => { if (!el) return null; const c = getComputedStyle(el); if (c.visibility === "hidden" || c.display === "none" || Number(c.opacity) < 0.05) return null; const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 ? r : null; };
  const box = (r) => r && { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  const items = {};
  for (const [k, sel] of Object.entries(FLOATING)) { const el = document.querySelector(sel); const r = vis(el); if (r) items[k] = { ...box(r), el }; }
  // The ring/list of Pip's menu: each item is its own box.
  const menuItems = [...document.querySelectorAll("[data-island] [role=menu] [role^=menuitem]")].map((el) => ({ label: el.getAttribute("data-label") ?? el.textContent?.trim(), r: vis(el), el })).filter((x) => x.r);
  // The page's own actions: buttons and links in the page header, and the main column's primary buttons.
  const own = [...document.querySelectorAll("main [data-page-header] button, main [data-page-header] a[href], main button[data-primary], main [class*='primary']")]
    .map((el) => ({ label: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40), r: vis(el), el })).filter((x) => x.r && x.label);
  const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  const findings = [];
  const covered = (el, name) => {
    const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) { findings.push({ rule: "off-screen", what: name, box: box(r) }); return; }
    const top = document.elementFromPoint(x, y);
    if (top && !el.contains(top) && !top.contains(el)) findings.push({ rule: "covered", what: name, by: `${top.tagName.toLowerCase()}.${String(top.getAttribute("class") ?? "").split(" ")[0]}` });
  };
  for (const [k, v] of Object.entries(items)) {
    if (k === "tabBar") continue;
    const r = v.el.getBoundingClientRect();
    if (r.right > innerWidth + 1 || r.left < -1 || r.bottom > innerHeight + 1 || r.top < -1) findings.push({ rule: "outside-window", what: k, box: box(r) });
    // Under a modal sheet (the phone's notifications) the bar's controls are meant to be covered.
    if (["pip", "bell", "checkin", "review"].includes(k) && !document.querySelector("[aria-modal='true']")) covered(v.el, k);
  }
  for (const m of menuItems) covered(m.el, `pip menu: ${m.label}`);
  const floatKeys = Object.keys(items).filter((k) => k !== "tabBar");
  for (let i = 0; i < floatKeys.length; i++) for (let j = i + 1; j < floatKeys.length; j++) {
    const a = items[floatKeys[i]], b = items[floatKeys[j]];
    const pair = [floatKeys[i], floatKeys[j]].sort().join("+");
    // Things that belong together (Pip and its own menu or bubble, a chip and its menu) may overlap.
    if (/^(pip\+pip(Bubble|Menu|Summary)|pipBubble\+pipMenu|checkin\+checkinMenu|bell\+bellPanel)$/.test(pair)) continue;
    if (document.querySelector("[aria-modal='true']") && /bellPanel/.test(pair)) continue;
    if (hit(a.el.getBoundingClientRect(), b.el.getBoundingClientRect())) findings.push({ rule: "floating-overlap", what: pair });
  }
  const floaters = ["pip", "pipBubble", "pipMenu", "companion", "permission"].filter((k) => items[k]);
  for (const k of floaters) {
    const r = items[k].el.getBoundingClientRect();
    if (items.tabBar && hit(r, items.tabBar.el.getBoundingClientRect())) findings.push({ rule: "covers-tab-bar", what: k });
    for (const o of own) if (hit(r, o.r)) findings.push({ rule: "covers-page-action", what: k, action: o.label });
  }
  for (const m of menuItems) for (const o of own) if (hit(m.r, o.r)) findings.push({ rule: "covers-page-action", what: `pip menu: ${m.label}`, action: o.label });
  const out = {}; for (const [k, v] of Object.entries(items)) { const { el, ...b } = v; out[k] = b; }
  return { boxes: out, menu: menuItems.map((m) => ({ label: m.label, ...box(m.r) })), findings };
}, FLOATING);

export async function context(browser, { base, email, width, height, theme }) {
  const phone = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const origin = new URL(base).origin;
  ctx.writes = [];
  await ctx.route("**/*", (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) return route.continue();
    if (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(req.method())) { ctx.writes.push(`${req.method()} ${url.pathname}`); return route.fulfill({ status: 200, json: { ok: true } }); }
    return route.continue({ headers: { ...req.headers(), "cf-access-authenticated-user-email": email } });
  });
  await ctx.addInitScript((t) => {
    try { localStorage.setItem("pulse.theme", t); localStorage.setItem("pulse.flow.view", "map"); } catch {}
    // What a click set off: the app's own window events.
    window.__events = [];
    const send = window.dispatchEvent.bind(window);
    window.dispatchEvent = (e) => { if (e.type.startsWith("pulse:") && !/^pulse:(communications|ping-status|data-changed|presence)/.test(e.type)) window.__events.push(e.type); return send(e); };
  }, theme);
  return ctx;
}

async function open(ctx, url) {
  const page = await ctx.newPage(); const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));
  await page.goto(url, { waitUntil: "load", timeout: 180_000 });
  await page.waitForFunction(() => { const m = document.querySelector("main"); return m && m.innerText.trim().length > 10 && !m.querySelector("[aria-busy='true']"); }, {}, { timeout: 90_000 }).catch(() => errors.push("main did not settle"));
  await page.waitForTimeout(1800);
  return { page, errors };
}

/** What a click did, within a moment: a dialog, a new address, a write, a confirmation in Pip's island, an event. */
async function outcome(page, ctx, before, run) {
  const writes = ctx.writes.length;
  const pipBefore = await page.evaluate(() => { const p = document.querySelector("[data-island] [data-pip]")?.getBoundingClientRect(); return p ? { x: Math.round(p.left), y: Math.round(p.top), docked: !!document.querySelector("header [data-island]") } : null; });
  await page.evaluate(() => { window.__events = []; });
  const dialogs = await page.locator("[role=dialog]:visible, dialog[open]").count();
  await run();
  await page.waitForTimeout(1400);
  const after = await page.evaluate(() => ({ url: location.pathname + location.search, pip: (() => { const p = document.querySelector("[data-island] [data-pip]")?.getBoundingClientRect(); return p ? { x: Math.round(p.left), y: Math.round(p.top), docked: !!document.querySelector("header [data-island]") } : null; })(), events: window.__events, bubble: document.querySelector("[data-island][data-open] [data-island-content]")?.textContent?.trim() ?? null, dialog: [...document.querySelectorAll("[role=dialog], dialog[open]")].filter((d) => d.getBoundingClientRect().width > 1).map((d) => d.getAttribute("aria-label") ?? d.querySelector("h2,h3")?.textContent ?? "dialog").slice(0, 3) }));
  const did = [];
  if (after.url !== before) did.push(`went to ${after.url}`);
  if (ctx.writes.length > writes) did.push(`sent ${ctx.writes.slice(writes).join(", ")}`);
  if ((await page.locator("[role=dialog]:visible, dialog[open]").count()) > dialogs) did.push(`opened ${after.dialog.join(" / ")}`);
  if (after.bubble) did.push(`Pip said "${after.bubble.slice(0, 60)}"`);
  if (pipBefore && after.pip && (after.pip.docked !== pipBefore.docked || Math.hypot(after.pip.x - pipBefore.x, after.pip.y - pipBefore.y) > 20)) did.push(after.pip.docked && !pipBefore.docked ? "Pip went to the top bar" : `Pip moved to ${after.pip.x},${after.pip.y}`);
  if (after.events.length) did.push(`events ${[...new Set(after.events)].join(" ")}`);
  return did;
}

export async function audit(browser, { base, emails, sizes, themes, paths, out, log = console.log }) {
  mkdirSync(out, { recursive: true });
  const records = [];
  for (const email of emails) for (const [width, height] of sizes) for (const theme of themes) for (const path of paths) {
    const who = email.split("@")[0], tag = `${who}-${path.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "home"}-${width}-${theme}`;
    const shot = (page, state) => page.screenshot({ path: join(out, `${tag}-${state}.png`) });
    const rec = { who, path, width, height, theme, states: {}, clicks: [], errors: [] };
    const ctx = await context(browser, { base, email, width, height, theme });
    try {
      let { page, errors } = await open(ctx, base + path);
      rec.errors.push(...errors);
      rec.states.closed = await measure(page); await shot(page, "closed");
      const pip = page.locator("[data-island] [data-pip]");
      if (await pip.count()) {
        if (width >= 600) { await pip.hover(); await page.waitForTimeout(700); rec.states.hover = await measure(page); await shot(page, "pip-hover"); await page.mouse.move(5, height - 5); }
        await pip.click(); await page.waitForTimeout(700);
        rec.states.menu = await measure(page); await shot(page, "pip-menu");
        // Every item is clicked on the first page only (each click reloads it); the others are looked at.
        const labels = path === paths[0] ? rec.states.menu.menu.map((m) => m.label) : [];
        for (const label of labels) {
          // Each item from a fresh page, so one item's effect never hides the next one's.
          await page.close(); ({ page } = await open(ctx, base + path));
          const p = page.locator("[data-island] [data-pip]");
          await p.click(); await page.waitForTimeout(600);
          // By its name (the menu fills in "Needs you" as the list arrives, so positions move).
          const item = page.locator(`[data-island] [role=menu] [data-label=${JSON.stringify(label)}]`).first();
          const before = await page.evaluate(() => location.pathname + location.search);
          let did; try { did = await outcome(page, ctx, before, () => item.click({ timeout: 8000 })); } catch (e) { did = [`click failed: ${String(e).split("\n")[0].slice(0, 120)}`]; }
          await shot(page, `pip-item-${label.replace(/[^a-z0-9]+/gi, "_")}`);
          rec.clicks.push({ control: `Pip menu: ${label}`, did });
          // In the top bar: its pill and its menu there too; then back to floating for the rest.
          if (did.includes("Pip went to the top bar")) {
            await page.locator("header [data-island] [data-pip]").click().catch(() => {}); await page.waitForTimeout(700);
            await shot(page, "docked-menu"); rec.states.docked = await measure(page);
            await page.keyboard.press("Escape");
            await page.evaluate(() => { localStorage.removeItem("pulse.pip.dock"); document.cookie = "pulse.pip.dock=0; path=/"; });
          }
          log(`${tag} Pip menu "${label}": ${did.join("; ") || "NOTHING"}`);
        }
        await page.close(); ({ page } = await open(ctx, base + path));
      }
      const bell = page.locator("[data-shell-actions] button[aria-label^='Notifications']");
      if (await bell.count()) {
        const before = await page.evaluate(() => location.pathname + location.search);
        rec.clicks.push({ control: "Bell", did: await outcome(page, ctx, before, () => bell.click()) });
        rec.states.bell = await measure(page); await shot(page, "bell-open");
        const panel = page.locator("#pulse-notices");
        rec.states.bell.groups = await panel.locator("section h3").allInnerTexts();
        const all = panel.getByRole("button", { name: "Mark all read" });
        if (await all.isEnabled().catch(() => false)) rec.clicks.push({ control: "Bell: Mark all read", did: await outcome(page, ctx, before, () => all.click()) });
        else rec.clicks.push({ control: "Bell: Mark all read", did: ["disabled (nothing unread)"] });
        rec.states.bell.settings = await panel.getByRole("link", { name: "Notification settings" }).getAttribute("href").catch(() => null);
        await page.keyboard.press("Escape");
      }
      const chip = page.locator("[data-shell-actions] button[data-state]");
      if (await chip.count() && await chip.first().isVisible()) {
        const state = await chip.first().getAttribute("data-state");
        if (state !== "out") {
          const before = await page.evaluate(() => location.pathname + location.search);
          rec.clicks.push({ control: `Check-in chip (${state})`, did: await outcome(page, ctx, before, () => chip.first().click()) });
          rec.states.checkin = await measure(page); await shot(page, "checkin-open");
          await page.keyboard.press("Escape");
        } else rec.clicks.push({ control: "Check-in chip (out)", did: ["not clicked: one tap checks in (a write)"] });
      }
      // The keyboard's floating things: Ctrl+K (the command palette) and C (the task form), on a computer.
      if (width >= 600) {
        await page.keyboard.press("Escape"); await page.evaluate(() => document.activeElement?.blur?.());
        await page.keyboard.press("Control+k"); await page.waitForTimeout(700); await shot(page, "palette"); rec.states.palette = await measure(page);
        await page.keyboard.press("Escape"); await page.waitForTimeout(300);
        await page.keyboard.press("c"); await page.waitForTimeout(900); await shot(page, "create"); rec.states.create = await measure(page);
        await page.keyboard.press("Escape"); await page.waitForTimeout(300);
      }
      // Many notifications at once: arrivals as the poll would report them, then the island one at a time.
      await page.evaluate(() => { for (let i = 0; i < 4; i++) window.dispatchEvent(new CustomEvent("pulse:arrival", { detail: { id: `float-audit-${i}`, title: `Synthetic update ${i + 1}: a long line to see how a toast wraps when it says more than it should`, href: "/notifications" } })); });
      await page.waitForTimeout(1500);
      rec.states.arrivals = await measure(page); await shot(page, "arrivals");
      await page.close();
    } catch (e) { rec.errors.push(String(e).slice(0, 300)); }
    await ctx.close();
    records.push(rec);
    const f = Object.entries(rec.states).flatMap(([s, m]) => (m?.findings ?? []).map((x) => `${s}: ${x.rule} ${x.what}${x.by ? ` by ${x.by}` : ""}${x.action ? ` (${x.action})` : ""}`));
    log(`${tag}: ${f.length ? f.join(" | ") : "no layout findings"}${rec.errors.length ? ` ERRORS ${rec.errors.join(" | ")}` : ""}`);
  }
  writeFileSync(join(out, "audit.json"), JSON.stringify(records, null, 1));
  return records;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  const browser = await chromium.launch();
  await audit(browser, {
    base: opt("base", "http://127.0.0.1:3200"), out: opt("out", "/tmp/float-audit"),
    emails: opt("as", "admin@estateautopilots.com,hr@estateautopilots.com").split(","),
    sizes: opt("sizes", "1440x900,390x844").split(",").map((s) => s.split("x").map(Number)),
    themes: opt("themes", "light,dark").split(","), paths: opt("paths", "/dashboard").split(","),
  });
  await browser.close();
}
