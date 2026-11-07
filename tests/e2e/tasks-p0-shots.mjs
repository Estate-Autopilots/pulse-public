// TASKS-P0 screenshots and the computed-style gate, on the synthetic "Kazuk-like" seed (tools/tasks-p0-seed.mjs).
//   node tests/e2e/tasks-p0-shots.mjs --base http://127.0.0.1:<port> --seed ~/ea-research/ux/tasks-p0/seed.json --out <dir>
//        [--widths 1440,390] [--themes light,dark] [--only task,board] [--before]   (--before: shots only, no gate)
// Every shot runs STYLE_AUDIT (from RELEASE-DEV's release-proof.mjs: stylesheets loaded, module classes defined, no
// browser-default controls, the theme's background, the app font, a framed page, nothing spilling sideways) and the
// page's own checks; any problem fails the run. Writes <out>/<name>-<width>-<theme>.png and <out>/report.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const base = opt("base", "http://127.0.0.1:3200"), out = opt("out", "/tmp/tasks-p0-shots"); mkdirSync(out, { recursive: true });
const seed = JSON.parse(readFileSync(opt("seed", join(process.env.HOME, "ea-research/ux/tasks-p0/seed.json")), "utf8"));
const widths = opt("widths", "1440,390").split(",").map(Number), themes = opt("themes", "light,dark").split(",");
const only = (opt("only", "") ?? "").split(",").filter(Boolean), before = args.includes("--before");
const admin = "user-668d21b6@estateautopilots.com", kedab = seed.people.kedab.email, asha = seed.people.asha.email;
const T = seed.tasks;

/** [name, path, who, { click, wait, must }] — `must` = [selector, minimum visible] checked after the page settles. */
const SHOTS = [
  ["task-doer", `/tasks/${T.wifi}`, kedab, { must: [["h1", 1], ['[role="checkbox"]', 3]] }],
  ["task-reviewer", `/tasks/${T.salary}`, seed.people.meera.email, {}],
  ["task-viewer-pdf", `/tasks/${T.roadmap}?proof=${seed.proofs.pdf}`, kedab, { wait: 'div[data-page="1"] canvas[data-drawn="1"]', must: [['[role="dialog"]', 1]] }],
  ["task-protected", `/tasks/${T.offer}?proof=${seed.proofs.protected}`, admin, { wait: '[role="dialog"]' }],
  ["task-pip", `/tasks/${T.wifi}`, kedab, { click: "Plan it with Pip", wait: '[aria-label="Pip’s plan"]' }],
  ["task-mention", `/tasks/${T.wifi}`, asha, { type: { box: "Write a comment", text: "Thanks @Kir", pick: true } }],
  ["task-same-work", `/tasks/${T.notice}`, kedab, {}],
  ["board-kedab-as-owner", `/tasks?view=board&scope=person&person=${seed.people.kedab.id}`, admin, { must: [['section[aria-label="Today"] li', 1, 900]] }],
  ["board-kedab-self", "/tasks?view=board&scope=mine", kedab, {}],
  ["board-kedab-status", `/tasks?view=board&scope=person&person=${seed.people.kedab.id}&group=status`, admin, {}],
  ["my-tasks-kedab", "/tasks?view=me", kedab, {}],
  ["unlock-map", `/tasks/map?project=${seed.projects["Launch & admin (synthetic)"]}`, admin, { wait: "main a[aria-label]" }],
  ["projects-categories", "/tasks?view=projects", admin, {}],
  ["blocking", "/tasks?view=blocking", admin, {}],
].filter(([name]) => !only.length || only.some((o) => name.startsWith(o)));

// ------------------------------------------------------------------------------------- computed styles (release-proof)
const STYLE_AUDIT = ({ theme, width }) => {
  const problems = []; const stats = {};
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const c = getComputedStyle(el); return c.visibility !== "hidden" && c.display !== "none"; };
  const label = (el) => `${el.tagName.toLowerCase()}.${String(el.getAttribute("class") ?? "").split(" ")[0]} «${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40)}»`;
  let rules = 0; const defined = new Set();
  const walk = (list) => { for (const r of list) { rules++; if (r.selectorText) for (const m of r.selectorText.matchAll(/\.([A-Za-z_-][\w-]*)/g)) defined.add(m[1]); if (r.cssRules) walk(r.cssRules); } };
  for (const s of document.styleSheets) { try { walk(s.cssRules); } catch { problems.push(`stylesheet unreadable: ${s.href}`); } }
  for (const l of document.querySelectorAll('link[rel="stylesheet"]')) if (!l.sheet) problems.push(`stylesheet not applied: ${l.getAttribute("href")}`);
  stats.rules = rules; if (rules < 300) problems.push(`only ${rules} CSS rules on the page`);
  const missing = new Map(); let moduleClasses = 0;
  for (const el of document.querySelectorAll("body [class]")) {
    if (el instanceof SVGElement || !visible(el)) continue;
    const bad = []; let good = 0;
    for (const t of el.classList) { const hashed = /module__/.test(t); if (hashed) moduleClasses++; if (t === "undefined" || t === "null" || t === "false" || (hashed && !defined.has(t))) bad.push(t); else if (hashed && defined.has(t)) good++; }
    if (!good) for (const t of bad) missing.set(t, label(el));
  }
  stats.moduleClasses = moduleClasses; if (moduleClasses < 20) problems.push(`only ${moduleClasses} CSS-module class names on visible elements`);
  for (const [t, where] of [...missing].slice(0, 8)) problems.push(`class "${t}" has no CSS rule (${where})`);
  for (const b of document.querySelectorAll("button, input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]), select, textarea")) {
    if (!visible(b)) continue; const c = getComputedStyle(b);
    if (getComputedStyle(b).opacity === "0") continue;
    if (c.borderTopStyle === "outset" || (c.borderTopStyle === "inset" && b.matches("input,textarea") && c.borderTopWidth === "2px") || c.fontSize === "13.3333px") problems.push(`unstyled control ${label(b)}: border ${c.borderTopStyle} ${c.borderTopWidth}, font ${c.fontSize}`);
  }
  const lum = (rgb) => { const m = rgb.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0]; return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; } return "rgb(255, 255, 255)"; };
  const main = document.querySelector("main"); const bg = bgOf(main ?? document.body); stats.background = bg;
  if (theme === "dark" ? lum(bg) > 0.35 : lum(bg) < 0.6) problems.push(`background ${bg} does not match the ${theme} theme`);
  const font = getComputedStyle(document.body).fontFamily; if (/^"?Times/i.test(font) || font === "serif") problems.push(`body font is the browser default (${font})`);
  if (!main || !visible(main)) problems.push("no visible <main>");
  else {
    const m = main.getBoundingClientRect();
    if (m.width < (width >= 1180 ? 0.5 : 0.85) * innerWidth) problems.push(`main is only ${Math.round(m.width)} px wide`);
    if (m.height < 200) problems.push(`main is only ${Math.round(m.height)} px tall`);
    if (![...document.querySelectorAll("main h1, main h2, h1, h2, main h3, [role=heading]")].some(visible)) problems.push("no visible page heading");
  }
  if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`page is ${document.documentElement.scrollWidth} px wide at ${innerWidth}`);
  const clipped = (el) => { for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) { const c = getComputedStyle(e); if (c.overflowX !== "visible" || c.position === "fixed") return true; } return false; };
  const spill = [...(main?.querySelectorAll("*") ?? [])].filter((el) => !(el instanceof SVGElement) && visible(el) && el.getBoundingClientRect().right > innerWidth + 2 && !clipped(el));
  if (spill.length) problems.push(`${spill.length} element(s) run past the right edge, e.g. ${label(spill[0])}`);
  return { problems, stats };
};

const browser = await chromium.launch();
const report = []; let failed = 0;
for (const [name, path, who, o] of SHOTS) for (const width of widths) for (const theme of themes) {
  const height = width >= 900 ? 900 : 844;
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1, extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": who } });
  await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); localStorage.setItem("theme", t); } catch { /* private mode */ } }, theme);
  const page = await ctx.newPage(); const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  try {
    await page.goto(base + path, { waitUntil: "load", timeout: 120000 });
    await page.locator("main").waitFor({ timeout: 60000 });
    await page.waitForTimeout(1200);
    // A kept plan shows at once; otherwise ask for one.
    if (o.click && await page.getByRole("button", { name: o.click }).count()) await page.getByRole("button", { name: o.click }).first().click();
    if (o.type) { const box = page.getByRole("textbox", { name: o.type.box }); await box.click(); await box.pressSequentially(o.type.text); if (o.type.pick) { await page.getByRole("listbox").waitFor(); await page.keyboard.press("Enter"); await box.pressSequentially("could you send them today?"); } }
    if (o.wait) await page.locator(o.wait).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(600);
    const file = join(out, `${name}-${width}-${theme}.png`); await page.screenshot({ path: file });
    const audit = before ? { problems: [], stats: {} } : await page.evaluate(STYLE_AUDIT, { theme, width });
    for (const [sel, min, from = 0] of before ? [] : (o.must ?? []).filter(([, , w = 0]) => width >= w)) { const n = await page.locator(sel).filter({ visible: true }).count(); if (n < min) audit.problems.push(`expected ${min}+ visible "${sel}", found ${n}`); }
    if (errors.length && !before) audit.problems.push(...errors.map((e) => `page error: ${e}`));
    if (audit.problems.length) failed++;
    report.push({ name, width, theme, file, ...audit });
    console.log(`${audit.problems.length ? "FAIL" : "ok  "} ${name} ${width} ${theme}${audit.problems.length ? `: ${audit.problems.slice(0, 3).join(" | ")}` : ""}`);
  } catch (e) { failed++; report.push({ name, width, theme, error: String(e).slice(0, 300) }); console.log(`FAIL ${name} ${width} ${theme}: ${String(e).slice(0, 200)}`); }
  await ctx.close();
}
await browser.close();
writeFileSync(join(out, "report.json"), JSON.stringify({ base, before, at: new Date().toISOString(), shots: report.length, failed, report }, null, 1));
console.log(`${report.length} shots, ${failed} with problems → ${out}`);
process.exit(failed && !before ? 1 : 0);
