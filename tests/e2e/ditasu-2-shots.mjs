// DITASU-2 screenshots (synthetic data only): My day with the one-click circle and its Undo beside the circle (AC card 7),
// and the Telemetry overview's "Session replays" storage panel (decision 3). mock-editors-api.mjs behind a small layer that
// answers My day and the Telemetry overview, and a private `next dev` (its own dist dir). Never touches real data.
// Run: nivi-heavy node tests/e2e/ditasu-2-shots.mjs --out <dir> [--widths 1440,363] [--themes light,dark] [--only myday,undo,telemetry]
import { spawn, execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
const here = dirname(fileURLToPath(import.meta.url)); const repo = join(here, "../.."); const web = join(repo, "apps/web");
const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = opt("out", "/tmp/ditasu-2-shots"); mkdirSync(out, { recursive: true });
const widths = opt("widths", "1440,363").split(",").map(Number); const themes = opt("themes", "light,dark").split(",");
const only = opt("only", "")?.split(",").filter(Boolean) ?? [];
const IDENTITY = "leadership@northwind.example";

// ------------------------------------------------------------------ synthetic fixtures (names and ids are invented)
const ORG = "00000000-0000-4000-8000-00000000a001";
const now = new Date(); const TODAY = new Date(now.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
const task = (i, title, status, extra = {}) => ({ id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, title, status, stage: null, priority: "normal", dueAt: `${TODAY}T12:30:00Z`, dueOn: TODAY,
  dueTime: null, workOn: null, startsOn: null, estimateMinutes: null, projectId: null, projectName: "Northwind launch", projectColor: "#7c3aed", workstream: null, parentId: null, repeats: null, doneAt: null, minutesToday: 0, ...extra });
const TASKS = [task(1, "Send the April invoice to the client", "open", { priority: "high" }), task(2, "Plan the client workshop", "in_progress"), task(3, "Collect last year's records", "open"),
  task(4, "Call the printer about the brochures", "open", { dueAt: null, dueOn: null }), task(5, "Draft the hiring post", "done", { doneAt: now.toISOString() })];
const PRISTINE = JSON.stringify(TASKS);
const resetTasks = () => { const fresh = JSON.parse(PRISTINE); TASKS.splice(0, TASKS.length, ...fresh); };
const DAY = () => ({ generatedAt: now.toISOString(), more: 0, seats: [{ org: ORG, name: "Northwind Studio", handle: "northwind", kind: "staff", current: true, ok: true, purpose: "work", today: TODAY, weekStart: TODAY,
  timeZone: "Asia/Kolkata", accent: null, mark: null, tasks: TASKS, timer: null, timeToday: [], timeWeek: [], targets: { dailyMinutes: null, weeklyMinutes: null, own: false, tasksPerWeek: null, unit: null },
  counts: { minutesWeek: 0, doneToday: 1, doneWeek: 4, undated: 1 } }] });
const pct = { n: 0, p50: null, p75: null, p95: null };
const OVERVIEW = { days: 7, platform: null, zone: "Asia/Kolkata",
  totals: { events: 18240, sessions: 212, people: 14, views: 3120, actions: 5480, apiCalls: 9310, errors: 12, viewP75: 840, actionP75: 260, serverP75: 120 },
  pages: [{ ...pct, n: 812, p50: 410, p75: 820, p95: 2400, name: "/tasks", kind: "nav.route" }, { ...pct, n: 402, p50: 380, p75: 710, p95: 1900, name: "/my-day", kind: "nav.route" }],
  actions: [{ ...pct, n: 1210, p50: 120, p75: 260, p95: 900, page: "/tasks", name: "Mark done", kind: "ui.click" }], server: [], client: [], vitals: [], longTasks: [], errors: [], people: [], roles: [], sessions: [],
  trend: Array.from({ length: 7 }, (_, i) => ({ day: new Date(now.getTime() - (6 - i) * 864e5).toISOString().slice(0, 10), events: 2400 + i * 50, errors: 2, people: 12, routeP75: 700 + i * 10, loadP75: 2100, clickP75: 250, apiP75: 180, serverP75: 110 })),
  versions: [],
  replays: { bytes: 318 * 1048576, chunks: 412, sessions: 61, struggle: 38, sampled: 21, reports: 2, oldest: new Date(now.getTime() - 6 * 864e5).toISOString(), budgetBytes: 1024 * 1048576, days: 7, sample: 0.1,
    serverBytes: 540 * 1048576, serverCap: 3 * 1073741824 } };

// ------------------------------------------------------------------ servers
const freePort = () => new Promise((ok) => { const s = netServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const children = [];
const start = (cmd, argv, opts) => { const c = spawn(cmd, argv, { ...opts, detached: true, stdio: ["ignore", "pipe", "pipe"] }); children.push(c); let log = ""; c.stdout.on("data", (d) => { log += d; }); c.stderr.on("data", (d) => { log += d; }); c.log = () => log.slice(-3000); return c; };
const stop = () => { for (const c of children) { try { process.kill(-c.pid, "SIGTERM"); } catch {} } };
process.on("exit", stop); process.on("SIGINT", () => process.exit(130)); process.on("SIGTERM", () => process.exit(143));
const waitFor = async (url, ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return; } catch {} await new Promise((r) => setTimeout(r, 500)); } throw new Error(`timed out waiting for ${url}`); };
const mockPort = await freePort(); const apiPort = await freePort(); const webPort = await freePort();
start(process.execPath, ["tests/e2e/mock-editors-api.mjs"], { cwd: repo, env: { ...process.env, PORT: String(mockPort) } });
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
createServer((req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/api/v0/tasks/my-day") return send(res, 200, DAY());
    if (req.method === "GET" && url.pathname === "/api/v0/tasks/my-day/streaks") return send(res, 200, { today: TODAY, checkins: [TODAY], done: [{ day: TODAY, n: 2 }] });
    if (req.method === "POST" && url.pathname === "/api/v0/tasks/my-day/act") { let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => { try { const j = JSON.parse(b); const t = TASKS.find((x) => x.id === j.task); if (t && j.action === "done") Object.assign(t, { status: "done", doneAt: new Date().toISOString() }); if (t && j.action === "reopen") Object.assign(t, { status: j.to ?? "open", doneAt: null }); } catch {} send(res, 200, { org: ORG, status: "done" }); }); return; }
    if (req.method === "GET" && url.pathname === "/api/v0/telemetry") return send(res, 200, OVERVIEW);
    const up = httpRequest({ host: "127.0.0.1", port: mockPort, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on("error", () => send(res, 502, { error: "mock unavailable" }));
    req.pipe(up);
  } catch (e) { console.error(e); send(res, 500, { error: String(e).slice(0, 200) }); }
}).listen(apiPort, "127.0.0.1");
const webServer = start(join(web, "node_modules/.bin/next"), ["dev", "--disable-source-maps", "-p", String(webPort), "-H", "127.0.0.1"],
  { cwd: web, env: { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: ".next-ditasu-2", PULSE_API_URL: `http://127.0.0.1:${apiPort}` } });
const restore = () => { try { execFileSync("git", ["checkout", "--", "apps/web/tsconfig.json", "apps/web/next-env.d.ts"], { cwd: repo, stdio: "ignore" }); } catch {} };
process.on("exit", restore);
await waitFor(`http://127.0.0.1:${mockPort}/api/v0/me`, 30000); // SPEED-2: a busy box needs longer for the first compile; the dev server's own words when it never answers.
await waitFor(`http://127.0.0.1:${webPort}/login`, 480000).catch((e) => { console.error(webServer.log()); throw e; });
console.log(`web http://127.0.0.1:${webPort}  api http://127.0.0.1:${apiPort}`);

const AUDIT = () => {
  const describe = (el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} «${(el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60)}»`;
  const clipped = [];
  for (const el of document.querySelectorAll("main *")) {
    if (!(el instanceof HTMLElement) || !el.offsetParent || /srOnly/.test(String(el.className))) continue;
    const c = getComputedStyle(el);
    if (!["hidden", "clip"].includes(c.overflowY) || c.textOverflow === "ellipsis" || (c.webkitLineClamp && c.webkitLineClamp !== "none")) continue;
    if (el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0) clipped.push(`${describe(el)} ${el.scrollHeight}>${el.clientHeight}`);
  }
  const wide = document.documentElement.scrollWidth > innerWidth + 1 ? `page is ${document.documentElement.scrollWidth}px wide` : null;
  return { clipped: clipped.slice(0, 12), wide };
};
const pause = (page, ms) => page.waitForTimeout(ms);
// SPEED-2: and no kit skeleton still saying "Loading…" (Listen draws its room after its first API answer).
const pageReady = (page) => page.waitForFunction(() => document.querySelector("main h1, main h2") && !document.querySelector('main [aria-busy="true"]') && !document.querySelector('main [role="status"][aria-label^="Loading"]'), {}, { timeout: 180000 });
const ALL = [["myday", "/my-day"], ["undo", "/my-day"], ["telemetry", "/telemetry"]];
const SHOTS = ALL.filter(([name]) => !only.length || only.includes(name));
for (const [, path] of SHOTS) { try { await fetch(`http://127.0.0.1:${webPort}${path}`, { headers: { "Cf-Access-Authenticated-User-Email": IDENTITY }, signal: AbortSignal.timeout(480000) }); } catch {} }
try { await fetch(`http://127.0.0.1:${webPort}/api/v0/tasks/my-day/streaks`, { headers: { "Cf-Access-Authenticated-User-Email": IDENTITY }, signal: AbortSignal.timeout(240000) }); } catch {}
const browser = await chromium.launch();
const report = [];
for (const [name, path] of SHOTS) for (const width of widths) for (const theme of themes) {
  const height = width < 500 ? 844 : 900;
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1, extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": IDENTITY } });
  await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); localStorage.setItem("theme", t); } catch {} }, theme);
  resetTasks(); // each shot starts from the same synthetic day
  const page = await ctx.newPage(); const errors = [];
  page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  try {
    await page.goto(`http://127.0.0.1:${webPort}${path}`, { waitUntil: "load", timeout: 240000 });
    await pageReady(page); await pause(page, 1800);
    let extra = {};
    if (name === "undo") {
      // One click on a circle: it is done at once, with "Done · Undo" beside the circle (no question in Pip's corner).
      const circle = page.locator('main button[aria-label^="Mark “Collect last year"]').first();
      await circle.scrollIntoViewIfNeeded(); const box = await circle.boundingBox();
      // A busy builder answers slowly: wait for the day's own data (the streak line) before the click, then for the pill.
      await page.waitForFunction(() => /in a row/.test(document.querySelector("main")?.textContent ?? ""), {}, { timeout: 30000 }).catch(() => {});
      await circle.click(); await page.locator("[data-undo-here]").waitFor({ timeout: 15000 }).catch(() => {}); await pause(page, 700);
      const pill = await page.locator("[data-undo-here]").boundingBox().catch(() => null);
      extra = { circle: box, pill, beside: !!(box && pill && Math.abs((pill.y + pill.height / 2) - (box.y + box.height / 2)) < 60) };
    }
    // The new part of the Telemetry overview: bring the "Session replays" panel into view (below the tiles on a phone).
    if (name === "telemetry") { await page.evaluate(() => { const h = [...document.querySelectorAll("h3")].find((x) => /Session replays/.test(x.textContent ?? "")); h?.closest("section")?.scrollIntoView({ block: "center" }); }); await pause(page, 600); }
    const audit = await page.evaluate(AUDIT);
    if (name === "myday") {
      const full = await page.evaluate(() => { let h = document.documentElement.scrollHeight; for (const el of document.querySelectorAll("body *")) { const c = getComputedStyle(el); if (/(auto|scroll)/.test(c.overflowY) && el.scrollHeight > el.clientHeight + 4) h = Math.max(h, el.scrollHeight + el.getBoundingClientRect().top); } return Math.ceil(h); });
      if (full > height) { await page.setViewportSize({ width, height: Math.min(full, 5000) }); await pause(page, 600); }
    }
    const file = join(out, `${name}-${width}-${theme}.png`);
    await page.screenshot({ path: file });
    report.push({ name, width, theme, file, ...audit, ...extra, errors: errors.slice(0, 4) });
    console.log(`${name} ${width} ${theme}${audit.clipped.length ? ` CLIPPED ${audit.clipped.join(" | ")}` : ""}${audit.wide ? ` WIDE ${audit.wide}` : ""}${extra.pill !== undefined ? ` pill=${JSON.stringify(extra.pill)} beside=${extra.beside}` : ""}${errors.length ? ` ERRORS ${errors.slice(0, 2).join(" | ")}` : ""}`);
  } catch (e) { report.push({ name, width, theme, error: String(e).slice(0, 300) }); console.log(`${name} ${width} ${theme} FAILED ${String(e).slice(0, 300)}`); }
  await ctx.close();
}
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
await browser.close();
console.log("SHOTS-DONE");
process.exit(0);
