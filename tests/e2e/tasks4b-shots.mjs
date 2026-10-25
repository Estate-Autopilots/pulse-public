// TASKS-4B screenshots and the computed-style gate (a task's life: doing, finishing, reviewing, value), on the synthetic
// "Kazuk-like" seed (tools/tasks-p0-seed.mjs, plus the states tools/tasks4b-seed.mjs adds).
//   node tests/e2e/tasks4b-shots.mjs --base http://127.0.0.1:<port> --seed ~/ea-research/ux/tasks4b/seed.json --out <dir>
//        [--widths 1440,390] [--themes light,dark] [--only task-review,notices] [--before] [--tall]
// --before takes the shots without failing on the gate (the old screens); --tall makes the viewport tall enough to show a
// whole page in one picture. Every shot runs STYLE_AUDIT (tasks-p0-shots.mjs: stylesheets loaded, module classes defined,
// no browser-default controls, the theme's background, the app font, a framed page, nothing spilling sideways) and the
// shot's own checks; any problem fails the run. Writes <out>/<name>-<width>-<theme>.png and <out>/report.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { STYLE_AUDIT } from "./tasks4b-gate.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const base = opt("base", "http://127.0.0.1:3200"), out = opt("out", "/tmp/tasks4b-shots"); mkdirSync(out, { recursive: true });
const seed = JSON.parse(readFileSync(opt("seed", join(process.env.HOME, "ea-research/ux/tasks4b/seed.json")), "utf8"));
const widths = opt("widths", "1440,390").split(",").map(Number), themes = opt("themes", "light,dark").split(",");
const only = (opt("only", "") ?? "").split(",").filter(Boolean), before = args.includes("--before"), tall = args.includes("--tall");
const P = Object.fromEntries(Object.entries(seed.people).map(([k, v]) => [k, v.email]));
const T = seed.tasks;
const LAUNCH = seed.projects["Launch & admin (synthetic)"];

/** [name, path, who, { steps, must }]. Steps: ["click", name] (a button or link by its accessible name), ["summary", text]
 *  (opens a <details> by its summary text), ["wait", selector], ["key", key], ["scroll", selector].
 *  `must` = [selector, minimum visible, from width] checked after the page settles. */
const SHOTS = [
  // 1, 2, 7, 8: the finished task as its reviewer, its doer and leadership; the founder's own finished work.
  ["task-review", `/tasks/${T.zoho}`, P.meera, { must: [["h1", 1]] }],
  ["task-done-doer", `/tasks/${T.zoho}`, P.kedab, {}],
  ["task-leader", `/tasks/${T.zoho}`, P.neha, {}],
  ["task-accepted", `/tasks/${T.workspace}`, P.kedab, {}],
  ["task-cancelled", `/tasks/${T.lawyer}`, P.kedab, {}],
  ["task-blocked", `/tasks/${T.stores}`, P.kedab, {}],
  ["task-overdue", `/tasks/${T.gst}`, P.kedab, {}],
  // 3, 4: value and how Pip worked it out.
  ["task-value", `/tasks/${T.zoho}`, P.neha, { steps: [["summary", "Value"], ["scroll", "summary:has-text('Value')"]] }],
  // 5, 6: time and history.
  ["task-time", `/tasks/${T.gst}`, P.kedab, { steps: [["summary", "Time"], ["scroll", "summary:has-text('Time')"]] }],
  ["task-history", `/tasks/${T.zoho}`, P.neha, { steps: [["summary", "History"], ["scroll", "summary:has-text('History')"]] }],
  // 9: discussion.
  ["task-discussion", `/tasks/${T.zoho}`, P.kedab, { steps: [["scroll", "summary:has-text('Discussion')"]] }],
  // 10, 11: the bell's "Ready to accept" card, the reviewer's queue.
  ["notices", "/tasks?view=me", P.meera, { steps: [["click", /^Notifications/], ["wait", "[data-card]"]] }],
  ["my-tasks-reviewer", "/tasks?view=me", P.meera, {}],
  // 12: delete a task and a project.
  ["delete-task", `/tasks/${T.zoho}`, P.neha, { steps: [["click", "More actions"], ["click", "Delete…"], ["wait", "[role=dialog]"]] }],
  ["project", `/tasks/projects/${LAUNCH}`, P.neha, {}],
  // 13: My tasks' domains and value shipped.
  ["my-tasks-doer", "/tasks?view=me", P.kedab, {}],
  // After TASKS-4B: the review queue, the done dialog with open subtasks, help, project delete, the record, settings.
  ["reviews", "/tasks?view=reviews", P.meera, {}],
  ["done-dialog", `/tasks/${T.gst}?finish=1`, P.kedab, { steps: [["wait", "[role=dialog]"]] }],
  ["ask-for-help", `/tasks/${T.gst}`, P.kedab, { steps: [["click", /Ask for help/], ["scroll", "[aria-label='Ask for help']"]] }],
  ["delete-project", `/tasks/projects/${LAUNCH}`, P.neha, { steps: [["more"], ["click", "Delete…"], ["wait", "[role=dialog]"]] }],
  ["outcomes", "/tasks/outcomes", P.kedab, {}],
  ["review-settings", "/settings?tab=work-rules", P.neha, { steps: [["scroll", "#review-policy-title"]] }],
].filter(([name]) => !only.length || only.some((o) => name.startsWith(o)));

async function step(page, [kind, arg]) {
  if (kind === "click") { const b = page.getByRole("button", { name: arg }).or(page.getByRole("menuitem", { name: arg })).or(page.getByRole("link", { name: arg })).filter({ visible: true }).first(); await b.click({ timeout: 20000 }); await page.waitForTimeout(400); }
  else if (kind === "summary") { const s = page.locator("summary", { hasText: arg }).filter({ visible: true }).first(); if (await s.count()) { const open = await s.evaluate((el) => el.parentElement?.hasAttribute("open")); if (!open) await s.click(); } }
  else if (kind === "wait") await page.locator(arg).first().waitFor({ timeout: 30000 });
  else if (kind === "key") await page.keyboard.press(arg);
  else if (kind === "more") { const more = page.getByRole("button", { name: /^More actions \(/ }).filter({ visible: true }); if (await more.count()) { await more.first().click(); await page.waitForTimeout(300); } }
  else if (kind === "scroll") await page.locator(arg).first().evaluate((el) => el.scrollIntoView({ block: "start" })).catch(() => null);
}

const browser = await chromium.launch();
const report = []; let failed = 0;
for (const [name, path, who, o] of SHOTS) for (const width of widths) for (const theme of themes) {
  const height = tall ? (width >= 900 ? 2000 : 2400) : width >= 900 ? 900 : 844;
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1, extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": who } });
  await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); localStorage.setItem("theme", t); } catch { /* private mode */ } }, theme);
  const page = await ctx.newPage(); const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  try {
    await page.goto(base + path, { waitUntil: "load", timeout: 180000 });
    await page.locator("main").waitFor({ timeout: 60000 });
    await page.waitForTimeout(1500);
    for (const s of o.steps ?? []) await step(page, s);
    await page.waitForTimeout(700);
    const file = join(out, `${name}-${width}-${theme}.png`); await page.screenshot({ path: file });
    const audit = before ? { problems: [], stats: {} } : await page.evaluate(STYLE_AUDIT, { theme, width });
    for (const [sel, min, from = 0] of before ? [] : (o.must ?? []).filter(([, , w = 0]) => width >= w)) { const n = await page.locator(sel).filter({ visible: true }).count(); if (n < min) audit.problems.push(`expected ${min}+ visible "${sel}", found ${n}`); void from; }
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
