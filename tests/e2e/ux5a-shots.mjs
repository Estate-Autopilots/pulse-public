// UX-5A screenshots, the unstyled-page gate and the layout-shift gate, as the synthetic personas of TASKS-P0's seed
// (tools/tasks-p0-seed.mjs) plus tools/ux5a-seed.mjs: staff = Rifob, HR = Asha, a founder = Kedab, admin = Tara;
// Meera reviews Kedab's finance work.
//   node tests/e2e/ux5a-shots.mjs --base http://127.0.0.1:<port> --out <dir> [--seed <seed.json>] [--widths 1440,390]
//        [--themes light,dark] [--only me-,accept] [--before] [--tall] [--set walk|owner]
// --before takes the shots without failing (the old screens). Every shot runs STYLE_AUDIT (style-gate.mjs) and the
// layout-shift gate (layout-shift.mjs): the page load, and every click step, measured until the page is quiet.
// Writes <out>/<name>-<width>-<theme>.png and <out>/report.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { STYLE_AUDIT } from "./style-gate.mjs";
import { CLICK_LIMIT, LOAD_LIMIT, SHIFTS, SHIFT_RECORDER, settleShifts } from "./layout-shift.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const base = opt("base", "http://127.0.0.1:3200"), out = opt("out", "/tmp/ux5a-shots"); mkdirSync(out, { recursive: true });
const seed = JSON.parse(readFileSync(opt("seed", join(process.env.HOME, "ea-research/ux/tasks4b/seed.json")), "utf8"));
const widths = opt("widths", "1440,390").split(",").map(Number), themes = opt("themes", "light,dark").split(",");
const only = (opt("only", "") ?? "").split(",").filter(Boolean), before = args.includes("--before"), tall = args.includes("--tall");
const set = opt("set", "owner");
const P = { ...Object.fromEntries(Object.entries(seed.people).map(([k, v]) => [k, v.email])), tara: "tara.kapoor@synthetic.invalid" };
const T = seed.tasks;
const RIFOB = seed.people.rifob.id;

/** [name, path, who, { steps, must }]. Steps: ["click", name] (button, link, menu item or tab by accessible name; the
 *  shifts after it are measured), ["text", text] (click the first visible element with this text), ["summary", text],
 *  ["wait", selector], ["key", key], ["type", text], ["fill", label, text], ["scroll", selector], ["pause", ms].
 *  `must` = [selector, minimum visible] checked after the steps. */
const OWNER = [
  // 1. Right-side panels: accepting work from every entry point, the person picker, request forms, people panels.
  ["accept-row", "/tasks?scope=me", P.meera, { steps: [["click", /^(Review|Accept|Acknowledge)$/], ["wait", "[role=dialog]"]] }],
  ["accept-task", `/tasks/${T.zoho}`, P.meera, {}],
  ["accept-bell", "/tasks?view=me", P.meera, { steps: [["click", /^Notifications/], ["wait", "[data-card]"]] }],
  ["accept-reviews", "/tasks?view=reviews", P.meera, {}],
  ["accept-notifications", "/notifications", P.meera, {}],
  ["who-does-it", "/tasks?scope=me", P.kedab, { steps: [["key", "n"], ["pause", 800], ["click", /^Who does it/]] }],
  ["give", `/tasks/${T.wifi}`, P.kedab, { steps: [["click", /^Who does it/]] }],
  ["edit-task", `/tasks/${T.wifi}`, P.kedab, { steps: [["click", /^More actions/], ["click", /^Edit/]] }],
  ["request-hr", "/me", P.rifob, { steps: [["click", /^New request|^Raise/], ["wait", "[role=dialog]"]] }],
  ["apply-leave", "/me", P.rifob, { steps: [["click", /^Apply for leave|^Apply/], ["wait", "[role=dialog]"]] }],
  ["correction", "/me?tab=attendance", P.rifob, { steps: [["click", /^Request (a )?correction|^Fix a day/], ["wait", "[role=dialog]"]] }],
  ["person-edit", `/people/${RIFOB}`, P.tara, { steps: [["click", /^Edit/], ["wait", "[role=dialog]"]] }],
  ["thank", "/me", P.rifob, { steps: [["click", /^Thank/], ["wait", "[role=dialog]"]] }],
  // 2, 3. My desk and its Attendance tab.
  ["me-staff", "/me", P.rifob, {}],
  ["me-founder", "/me", P.kedab, {}],
  ["me-hr", "/me", P.asha, {}],
  ["me-attendance", "/me?tab=attendance", P.rifob, {}],
  // 4. Clicks that move the page: asking to work on a day off.
  ["day-off-ask", "/me?tab=attendance", P.rifob, { steps: [["click", /^Work on a day off/], ["wait", "[role=dialog]"], ["click", /^I.ll work on/], ["pause", 1500]] }],
  ["profile-knows", `/people/${RIFOB}?tab=info`, P.rifob, {}],
  ["day-off-drawer", "/me?tab=attendance", P.rifob, { steps: [["click", /^Work on a day off/], ["wait", "[role=dialog]"]] }],
  // 5. Ctrl+K.
  ["ctrlk-office", "/dashboard", P.asha, { steps: [["key", "Control+k"], ["type", "office"], ["pause", 1200]] }],
  ["ctrlk-office-staff", "/dashboard", P.rifob, { steps: [["key", "Control+k"], ["type", "office"], ["pause", 1200]] }],
  ["ctrlk-question", "/dashboard", P.asha, { steps: [["key", "Control+k"], ["type", "where do I add the office internet?"], ["pause", 2500]] }],
];
const WALK = [];
for (const [who, key] of [[P.rifob, "staff"], [P.asha, "hr"], [P.kedab, "founder"], [P.tara, "admin"]])
  for (const [path, page] of [["/dashboard", "dashboard"], ["/tasks", "work"], ["/chats", "chats"], ["/people", "people"], ["/hr", "hr"], ["/finance", "finance"], ["/erp", "erp"], ["/map", "map"], ["/settings", "settings"], ["/me", "me"]])
    WALK.push([`walk-${key}-${page}`, path, who, {}]);
const SHOTS = (set === "walk" ? WALK : set === "all" ? [...OWNER, ...WALK] : OWNER).filter(([name]) => !only.length || only.some((o) => name.startsWith(o)));

const shifts = [];
async function step(page, [kind, arg, extra]) {
  if (kind === "click") {
    const b = page.getByRole("button", { name: arg }).or(page.getByRole("menuitem", { name: arg })).or(page.getByRole("link", { name: arg })).or(page.getByRole("tab", { name: arg })).filter({ visible: true }).first();
    const t = await page.evaluate(() => performance.now());
    await b.click({ timeout: 20000 });
    await settleShifts(page);
    const s = await page.evaluate(SHIFTS, { since: t, all: true });
    shifts.push({ after: String(arg), ...s });
  }
  else if (kind === "text") await page.getByText(arg).filter({ visible: true }).first().click({ timeout: 20000 });
  else if (kind === "summary") { const s = page.locator("summary", { hasText: arg }).filter({ visible: true }).first(); if (await s.count()) { const open = await s.evaluate((el) => el.parentElement?.hasAttribute("open")); if (!open) await s.click(); } }
  else if (kind === "wait") await page.locator(arg).first().waitFor({ timeout: 30000 });
  else if (kind === "key") { await page.keyboard.press(arg); await page.waitForTimeout(300); }
  else if (kind === "type") await page.keyboard.type(arg, { delay: 25 });
  else if (kind === "fill") await page.getByLabel(arg).filter({ visible: true }).first().fill(extra);
  else if (kind === "pause") await page.waitForTimeout(Number(arg));
  else if (kind === "scroll") await page.locator(arg).first().evaluate((el) => el.scrollIntoView({ block: "start" })).catch(() => null);
}

const browser = await chromium.launch();
const report = []; let failed = 0;
for (const [name, path, who, o] of SHOTS) for (const width of widths) for (const theme of themes) {
  const height = tall ? (width >= 900 ? 2000 : 2400) : width >= 900 ? 900 : 844;
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1, extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": who } });
  await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); localStorage.setItem("theme", t); } catch { /* private mode */ } }, theme);
  await ctx.addInitScript(SHIFT_RECORDER);
  const page = await ctx.newPage(); const errors = []; shifts.length = 0;
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  try {
    await page.goto(base + path, { waitUntil: "load", timeout: 180000 });
    await page.locator("main").waitFor({ timeout: 60000 });
    await page.waitForFunction(() => document.querySelector("main h1,main h2,main h3,h1") && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 60000 }).catch(() => null);
    await settleShifts(page, 900, 8000);
    const load = await page.evaluate(SHIFTS, { since: 0 });
    for (const s of o.steps ?? []) await step(page, s);
    await page.waitForTimeout(500);
    const file = join(out, `${name}-${width}-${theme}.png`); await page.screenshot({ path: file });
    const audit = await page.evaluate(STYLE_AUDIT, { theme, width });
    for (const [sel, min] of o.must ?? []) { const n = await page.locator(sel).filter({ visible: true }).count(); if (n < min) audit.problems.push(`expected ${min}+ visible "${sel}", found ${n}`); }
    if (load.score > LOAD_LIMIT) audit.problems.push(`layout shift while loading ${load.score} (limit ${LOAD_LIMIT}): ${load.shifts.slice(0, 3).map((s) => `${s.value} ${s.where.join(", ")}`).join(" | ")}`);
    for (const s of shifts) if (s.score > CLICK_LIMIT) audit.problems.push(`layout shift after “${s.after}” ${s.score} (limit ${CLICK_LIMIT}): ${s.shifts.slice(0, 3).map((x) => `${x.value} ${x.where.join(", ")}`).join(" | ")}`);
    if (errors.length) audit.problems.push(...errors.map((e) => `page error: ${e}`));
    if (audit.problems.length && !before) failed++;
    report.push({ name, path, width, theme, file, load, clicks: [...shifts], ...audit });
    console.log(`${audit.problems.length ? (before ? "note" : "FAIL") : "ok  "} ${name} ${width} ${theme}${audit.problems.length ? `: ${audit.problems.slice(0, 3).join(" | ")}` : ""}`);
  } catch (e) {
    const file = join(out, `${name}-${width}-${theme}.png`); await page.screenshot({ path: file }).catch(() => null);
    if (!before) failed++; report.push({ name, path, width, theme, file, error: String(e).slice(0, 300) }); console.log(`${before ? "note" : "FAIL"} ${name} ${width} ${theme}: ${String(e).slice(0, 200)}`);
  }
  await ctx.close();
}
await browser.close();
writeFileSync(join(out, "report.json"), JSON.stringify({ base, before, set, at: new Date().toISOString(), shots: report.length, failed, report }, null, 1));
console.log(`${report.length} shots, ${failed} failed → ${out}`);
process.exit(failed ? 1 : 0);
