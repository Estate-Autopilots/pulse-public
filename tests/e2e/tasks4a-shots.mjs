// TASKS-4A screenshots (creating work and finding it), on the synthetic seed (tools/tasks-p0-seed.mjs) of the dev DB,
// with the unstyled-page gate (style-gate.mjs) on every shot unless --before.
//   node tests/e2e/tasks4a-shots.mjs --base http://127.0.0.1:<port> --out <dir> [--widths 1440,390] [--themes light,dark]
//        [--only create,person] [--before] [--seed ~/ea-research/ux/tasks-p0/seed.json]
// Writes <out>/<name>-<width>-<theme>.png and <out>/report.json; a scene may add notes (what it found) to the report.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { STYLE_AUDIT } from "./style-gate.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const base = opt("base", "http://127.0.0.1:3200"), out = opt("out", "/tmp/tasks4a-shots"); mkdirSync(out, { recursive: true });
const seed = JSON.parse(readFileSync(opt("seed", join(process.env.HOME, "ea-research/ux/tasks-p0/seed.json")), "utf8"));
const widths = opt("widths", "1440,390").split(",").map(Number), themes = opt("themes", "light,dark").split(",");
const only = (opt("only", "") ?? "").split(",").filter(Boolean), before = args.includes("--before");
const kedab = seed.people.kedab.email, neha = seed.people.neha.email;
const launch = seed.projects["Launch & admin (synthetic)"];

const dialog = (page) => page.locator('[role="dialog"][aria-modal="true"]').last();
/** Opens + Create with the C key (the button differs between before and after). */
async function openCreate(page) { await page.locator("main").click({ position: { x: 5, y: 5 } }).catch(() => null); await page.keyboard.press("c"); await dialog(page).waitFor({ timeout: 15000 }); await page.waitForTimeout(450); }
async function openTask(page) { await openCreate(page); await page.keyboard.press("t"); await page.getByRole("textbox", { name: /what needs doing/i }).first().waitFor({ timeout: 20000 }); await page.waitForTimeout(500); }
const typeTitle = async (page, text) => { const t = page.getByRole("textbox", { name: /what needs doing/i }).first(); await t.click(); await t.pressSequentially(text, { delay: 40 }); };
async function quickAdd(page) { const box = page.getByRole("textbox", { name: /add a task/i }).or(page.getByRole("combobox", { name: /add a task/i })).first(); await box.waitFor({ timeout: 20000 }); await box.click(); return box; }

/** [name, path, who, run?(page, note)] */
const SCENES = [
  ["p1-quick-add-at", "/tasks?view=me", kedab, async (page, note) => { const box = await quickAdd(page); await box.pressSequentially("@", { delay: 60 }); await page.waitForTimeout(700); note(`listbox after "@": ${await page.getByRole("listbox").count()}`); }],
  ["p1-quick-add-error", "/tasks?view=me", kedab, async (page, note) => { const box = await quickAdd(page); await box.pressSequentially("tomorrow", { delay: 40 }); await page.keyboard.press("Escape"); await page.keyboard.press("Enter"); await page.waitForTimeout(600); note(`alert: ${(await page.getByRole("alert").allTextContents()).join(" | ")}`); }],
  ["p2-create-button", "/tasks?view=me", kedab, async (page, note) => { const b = page.getByRole("button", { name: /create a task or a project|^create$/i }).first(); const r = await b.boundingBox(); note(`create button ${r ? `${Math.round(r.width)}×${Math.round(r.height)} at ${Math.round(r.x)},${Math.round(r.y)}` : "not visible"}`); }],
  ["p3-chooser", "/tasks?view=me", kedab, async (page, note) => { await openCreate(page); const r = await dialog(page).boundingBox(); note(`dialog ${Math.round(r.width)}×${Math.round(r.height)} top ${Math.round(r.y)}`); }],
  ["p4-task-form", "/tasks?view=me", neha, async (page, note) => { await openTask(page); const r = await dialog(page).boundingBox(); note(`dialog ${Math.round(r.width)}×${Math.round(r.height)} top ${Math.round(r.y)} of ${page.viewportSize().height}`); note(`placeholder: ${await page.getByRole("textbox", { name: /what needs doing/i }).first().getAttribute("placeholder")}`); }],
  ["p4-title-at", "/tasks?view=me", neha, async (page, note) => { await openTask(page); await typeTitle(page, "Edit the reel @Ro"); await page.waitForTimeout(700); note(`listbox while typing @ in the title: ${await dialog(page).getByRole("listbox").count()}`); }],
  ["p4-pool", "/tasks?view=me", neha, async (page, note) => { await openTask(page); await typeTitle(page, "Clean up the shared drive"); await dialog(page).getByRole("button", { name: /pool/i }).first().click(); await page.waitForTimeout(500); note(`hint: ${(await dialog(page).locator("p").allTextContents()).filter((t) => /claim/i.test(t)).join(" | ").slice(0, 200)}`); }],
  ["p4-pool-back", "/tasks?view=me", neha, async (page, note) => {
    await openTask(page); await typeTitle(page, "Clean up the shared drive"); await dialog(page).getByRole("button", { name: /pool/i }).first().click(); await page.waitForTimeout(300);
    // What a person does to go back to choosing someone: the visible "back" first, as the owner did.
    const toggle = dialog(page).locator('button[aria-pressed="true"]').filter({ hasText: /^Pool$/ });
    const back = dialog(page).getByRole("button", { name: /choose a person|back to a person|person/i }).first();
    if (await toggle.count()) { await toggle.click(); note("pressed Pool again"); } else if (await back.count()) { await back.click(); note("pressed the in-form way back to a person"); } else { await dialog(page).getByRole("button", { name: /back/i }).first().click(); note("pressed the header back arrow"); }
    await page.waitForTimeout(500); note(`after going back: title field ${await page.getByRole("textbox", { name: /what needs doing/i }).count() ? "still there" : "GONE (back on the chooser)"}`);
    const arrow = dialog(page).getByRole("button", { name: /back to the two choices/i }); note(`header back arrow visible on the task form: ${await arrow.count()}`);
  }],
  ["p4-when", "/tasks?view=me", neha, async (page, note) => { await openTask(page); const pick = dialog(page).getByRole("button", { name: /pick a day|more dates|calendar|pick a date|^due date/i }).first(); await pick.click(); await page.waitForTimeout(600); note(`date control: ${await dialog(page).locator('input[type="date"]').count() ? "native date input" : "calendar"}; grid: ${await page.getByRole("grid").count()}`); }],
  ["p4-priority", "/tasks?view=me", neha, async (page, note) => { await openTask(page); await typeTitle(page, "Send the CA the GST pack"); await page.waitForTimeout(900); note(`priority groups: ${(await dialog(page).getByRole("group").or(dialog(page).getByRole("radiogroup")).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).join(", ")}`); }],
  ["p4-kind", "/tasks?view=me", neha, async (page, note) => {
    await openTask(page); await typeTitle(page, "Edit the Lodha reel"); await page.waitForTimeout(1200);
    const native = dialog(page).locator("select"); note(`native selects: ${await native.count()}`);
    const kind = dialog(page).getByRole("combobox", { name: /kind/i }).or(dialog(page).getByRole("button", { name: /kind/i })).first();
    if (!(await native.count()) && await kind.count()) { await kind.click(); await page.waitForTimeout(500); }
    note(`kind text: ${(await dialog(page).getByText(/read from the title/i).allTextContents()).join(" | ").slice(0, 120)}`);
  }],
  ["p4-title-chip", "/tasks?view=me", neha, async (page, note) => { await openTask(page); await typeTitle(page, "Edit the Lodha reel for @ro"); await page.waitForTimeout(500); await page.keyboard.press("Enter"); await page.waitForTimeout(900);
    note(`chips: ${await dialog(page).locator("[data-mention-id]").count()}; who: ${await dialog(page).getByRole("button", { name: /^Who does it/ }).getAttribute("aria-label").catch(() => "?")}`); }],
  ["p4-title-parse", "/tasks?view=me", neha, async (page, note) => { await openTask(page); await typeTitle(page, "Send the CA the GST pack #launch !high fri"); await page.waitForTimeout(1200);
    note(`from the title: ${await dialog(page).getByText("from the title").count()}`); }],
  ["p4-date-open", "/tasks?view=me", neha, async (page) => { await openTask(page); await typeTitle(page, "Book the drone for the Saturday shoot"); await dialog(page).getByRole("button", { name: /^Due date/ }).click(); await page.waitForTimeout(500); }],
  ["p4-kind-open", "/tasks?view=me", neha, async (page) => { await openTask(page); await typeTitle(page, "Edit the Lodha reel"); await page.waitForTimeout(1200); await dialog(page).getByRole("button", { name: /^Kind of work/ }).click(); await page.waitForTimeout(400); }],
  ["p4-who-open", "/tasks?view=me", neha, async (page) => { await openTask(page); await dialog(page).getByRole("button", { name: /^Who does it/ }).click(); await page.waitForTimeout(400); }],
  ["p11-project-form", "/tasks?view=me", neha, async (page, note) => { await openCreate(page); await page.keyboard.press("p"); await page.waitForTimeout(800); note(`native date inputs: ${await dialog(page).locator('input[type="date"]').count()}`); }],
  ["p11-project-dates", "/tasks?view=me", neha, async (page) => { await openCreate(page); await page.keyboard.press("p"); await page.waitForTimeout(600); await dialog(page).getByRole("button", { name: /^Due:/ }).click(); await page.waitForTimeout(400); }],
  ["p5-pool", "/tasks?view=pool", neha, async (page, note) => { note(`words in the pool view: ${(await page.locator("main").innerText()).split(/\s+/).length}`); }],
  ["p6-work-home-leader", "/tasks", neha, async (page, note) => { note(`view tabs: ${(await page.getByRole("navigation", { name: /task views/i }).getByRole("link").allTextContents()).join(" · ")}`); }],
  ["p6-work-home-doer", "/tasks", kedab, async (page, note) => { note(`view tabs: ${(await page.getByRole("navigation", { name: /task views/i }).getByRole("link").allTextContents()).join(" · ")}`); }],
  ["p7-board", "/tasks?view=board", neha, null],
  ["p7-all", "/tasks?view=all", neha, null],
  ["p8-team", "/tasks?view=team", neha, async (page, note) => { const t = await page.locator("main").innerText(); note(`"team" words: ${(t.match(/\bteams?\b/gi) ?? []).length}, "pod" words: ${(t.match(/\bpods?\b/gi) ?? []).length}`); }],
  ["p9-person", `/tasks/people/${seed.people.kedab.id}`, neha, async (page, note) => {
    const rows = page.locator('main li:has(a[href^="/tasks/"])'); const n = await rows.count();
    const last = rows.nth(Math.max(0, n - 1)); await last.scrollIntoViewIfNeeded().catch(() => null); await page.waitForTimeout(300);
    const seen = await last.evaluate((el) => { const r = el.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; }).catch(() => false);
    note(`task rows: ${n}; last row reachable by scrolling: ${seen}`);
  }],
  ["p9-person-scrolled", `/tasks/people/${seed.people.kedab.id}`, neha, async (page) => { await page.mouse.move(500, 600); for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 600); await page.waitForTimeout(120); } }],
  ["p6-project", `/tasks/projects/${launch}`, neha, null],
  // TASKS-4A after: scopes and the six views, filters, saved views, projects timeline, the team word.
  ["v-company-table", "/tasks?scope=company&layout=table", neha, async (page, note) => { note(`rows: ${await page.locator("tbody tr").count()}`); }],
  ["v-company-calendar", "/tasks?scope=company&layout=calendar", neha, null],
  ["v-company-timeline", "/tasks?scope=company&layout=timeline", neha, null],
  ["v-pod-gallery", "/tasks?scope=pod&layout=gallery", neha, null],
  ["v-board-eisenhower", "/tasks?scope=company&layout=board&group=eisenhower", neha, null],
  ["v-kedab-board-when", `/tasks?scope=person&person=${seed.people.kedab.id}&layout=board&group=when`, neha, null],
  ["v-filters", "/tasks?scope=company&layout=list", neha, async (page) => { await page.getByRole("button", { name: /^Filter/ }).click(); await page.waitForTimeout(300); }],
  ["v-saved", "/tasks?scope=company", neha, async (page) => { await page.getByRole("button", { name: /^Views/ }).click(); await page.waitForTimeout(300); }],
  ["v-scope-person", "/tasks?scope=me", neha, async (page) => { await page.getByRole("button", { name: /^A person:/ }).click(); await page.keyboard.type("ki"); await page.waitForTimeout(300); }],
  ["v-projects-timeline", "/tasks?view=projects&pl=timeline", neha, null],
  ["v-settings-team", "/settings?tab=work-rules", "user-668d21b6@estateautopilots.com", null],
  // The shared kit (/kit), each control open.
  ["k-kit", "/kit", neha, null],
  ["k-combobox", "/kit", neha, async (page, note) => { await page.getByRole("button", { name: /^Kind of work:/ }).click(); await page.keyboard.type("dr"); await page.waitForTimeout(400); note(`options: ${await page.getByRole("option").count()}`); }],
  ["k-select", "/kit", neha, async (page) => { await page.getByRole("button", { name: /^Status:/ }).click(); await page.keyboard.press("ArrowDown"); }],
  ["k-person", "/kit", neha, async (page) => { await page.getByRole("button", { name: /^Who does it:/ }).click(); await page.keyboard.type("r"); }],
  ["k-date", "/kit", neha, async (page, note) => { await page.getByRole("button", { name: /^Due:/ }).click(); await page.waitForTimeout(300); await page.keyboard.press("ArrowRight"); note(`focused: ${await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))}`); }],
  ["k-date-time", "/kit", neha, async (page) => { await page.getByRole("button", { name: /^Due with time:/ }).click(); }],
  ["k-mention", "/kit", neha, async (page, note) => { const box = page.getByRole("textbox", { name: "What needs doing" }); await box.click(); await box.pressSequentially("Ask @ro", { delay: 50 }); await page.waitForTimeout(300); await page.keyboard.press("Enter"); await box.pressSequentially("for the cut, then @", { delay: 30 }); await page.waitForTimeout(400); note(`chips: ${await page.locator("[data-mention-id]").count()}`); }],
  ["k-menu", "/kit", neha, async (page) => { await page.getByRole("button", { name: "More actions" }).click(); await page.keyboard.press("ArrowDown"); }],
  ["k-tooltip", "/kit", neha, async (page) => { await page.getByRole("button", { name: "+ New" }).focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab"); await page.waitForTimeout(250); }],
  ["k-help", "/kit", neha, async (page) => { await page.getByRole("button", { name: "What is the pool?" }).click(); }],
];

const browser = await chromium.launch();
const report = []; let failed = 0;
for (const [name, path, who, run] of SCENES.filter(([n]) => !only.length || only.some((o) => n.startsWith(o)))) for (const width of widths) for (const theme of themes) {
  const height = width >= 900 ? 900 : 844;
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1, reducedMotion: "reduce", extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": who } });
  await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); localStorage.setItem("theme", t); } catch { /* private mode */ } }, theme);
  // Writes are blocked: these shots only look (creating happens in the specs, against a scratch database).
  await ctx.route("**/api/v0/**", (route) => { const m = route.request().method(); return m === "GET" || /\/preview$/.test(route.request().url()) || /\/prefs/.test(route.request().url()) ? route.continue() : route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Shots do not write" }) }); });
  const page = await ctx.newPage(); const errors = [], notes = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  try {
    await page.goto(base + path, { waitUntil: "load", timeout: 180000 });
    await page.locator("main").waitFor({ timeout: 90000 });
    await page.waitForFunction(() => !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 60000 }).catch(() => null);
    await page.waitForTimeout(1200);
    if (run) await run(page, (s) => notes.push(s));
    await page.waitForTimeout(500);
    const file = join(out, `${name}-${width}-${theme}.png`); await page.screenshot({ path: file });
    const audit = before ? { problems: [], stats: {} } : await page.evaluate(STYLE_AUDIT, { theme, width });
    if (errors.length && !before) audit.problems.push(...errors.map((e) => `page error: ${e}`));
    if (audit.problems.length) failed++;
    report.push({ name, width, theme, file, notes, ...audit });
    console.log(`${audit.problems.length ? "FAIL" : "ok  "} ${name} ${width} ${theme}${notes.length ? ` — ${notes.join("; ")}` : ""}${audit.problems.length ? `: ${audit.problems.slice(0, 3).join(" | ")}` : ""}`);
  } catch (e) { failed++; report.push({ name, width, theme, notes, error: String(e).slice(0, 300) }); console.log(`FAIL ${name} ${width} ${theme}: ${String(e).slice(0, 200)}${notes.length ? ` — ${notes.join("; ")}` : ""}`); }
  await ctx.close();
}
await browser.close();
writeFileSync(join(out, "report.json"), JSON.stringify({ base, before, at: new Date().toISOString(), shots: report.length, failed, report }, null, 1));
console.log(`${report.length} shots, ${failed} with problems → ${out}`);
process.exit(failed && !before ? 1 : 0);
