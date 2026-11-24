// TOKENS-TELEMETRY screenshots of /telemetry/insights (what changed since yesterday, the journey map, key-job funnels,
// speed, struggle, AI cost) on synthetic data only: mock-editors-api.mjs behind a small layer that answers
// /api/v0/telemetry/story and /api/v0/telemetry/ai-cost, and a private `next dev` (its own dist dir). Never touches
// pulse-dev or any real data. The shapes and sizes copy what production showed for one company (17 Nov 2026), with
// invented numbers. Run: nivi-heavy node tests/e2e/insights-shots.mjs --out <dir> [--widths 1440,363] [--themes light,dark]
import { spawn, execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
const here = dirname(fileURLToPath(import.meta.url)); const repo = join(here, "../.."); const web = join(repo, "apps/web");
const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = opt("out", "/tmp/insights-shots"); mkdirSync(out, { recursive: true });
const widths = opt("widths", "1440,363").split(",").map(Number); const themes = opt("themes", "light,dark").split(",");
const only = opt("only", "")?.split(",").filter(Boolean) ?? [];
const IDENTITY = "leadership@northwind.example";
// ------------------------------------------------------------------ synthetic fixtures (all numbers invented)
const DAYS = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 9, 19 + i)).toISOString().slice(0, 10));
const wave = (i, a, b) => Math.round(a + b * Math.sin(i / 3) + (i % 5) * b * 0.1);
const SPEED = DAYS.flatMap((day, i) => [
  { day, kind: "nav.route", n: 120 + i * 2, p50: wave(i, 1100 - i * 12, 90), p90: wave(i, 4800 - i * 60, 500) },
  { day, kind: "nav.load", n: 30 + i, p50: wave(i, 3600 - i * 20, 200), p90: wave(i, 10500 - i * 140, 900) },
  { day, kind: "api", n: 1500 + i * 10, p50: wave(i, 380 - i * 2, 30), p90: wave(i, 1300 - i * 15, 120) }]);
const PAGES = DAYS.flatMap((day, i) => ["/tasks", "/chats", "/dashboard", "/people", "/me"].map((page, k) => ({ day, page, n: 20, p90: wave(i + k, [4200, 2600, 3500, 6000, 5200][k] - i * 50, 400) })));
const STRUGGLE = DAYS.map((day, i) => ({ day, errors: i % 7 === 0 ? 3 : i % 3, rage: wave(i, 14, 6), dead: wave(i, 18, 8), refused: wave(i, 6, 3), slowStarts: Math.max(0, wave(i, 6 - i / 6, 2)), early: i > 26 ? 1 : 0, people: 16, sessions: 110 }));
const N = (name, step, page, views) => ({ name, step, page, views });
const JOURNEYS = { sessions: 676, nodes: [
  N("1 · /", 0, "/", 120), N("1 · /chats", 0, "/chats", 104), N("1 · /dashboard", 0, "/dashboard", 78), N("1 · /me", 0, "/me", 68), N("1 · /tasks", 0, "/tasks", 64), N("1 · /welcome", 0, "/welcome", 39), N("1 · Other", 0, "Other", 203),
  N("2 · /tasks", 1, "/tasks", 120), N("2 · /chats", 1, "/chats", 96), N("2 · /people", 1, "/people", 61), N("2 · Other", 1, "Other", 130), N("2 · Left", 1, "Left", 269),
  N("3 · /tasks/:id", 2, "/tasks/:id", 88), N("3 · /chats", 2, "/chats", 70), N("3 · Other", 2, "Other", 110), N("3 · Left", 2, "Left", 139),
  N("4 · /tasks", 3, "/tasks", 60), N("4 · Other", 3, "Other", 90), N("4 · Left", 3, "Left", 118)],
  links: [] };
const L = (source, target, value) => JOURNEYS.links.push({ source, target, value });
L("1 · /", "2 · /tasks", 40); L("1 · /", "2 · /chats", 22); L("1 · /", "2 · Left", 30); L("1 · /", "2 · Other", 28);
L("1 · /chats", "2 · Left", 50); L("1 · /chats", "2 · /tasks", 24); L("1 · /chats", "2 · /people", 10); L("1 · /chats", "2 · Other", 20);
L("1 · /dashboard", "2 · /tasks", 30); L("1 · /dashboard", "2 · /chats", 18); L("1 · /dashboard", "2 · Left", 30);
L("1 · /me", "2 · Left", 40); L("1 · /me", "2 · /people", 16); L("1 · /me", "2 · Other", 12);
L("1 · /tasks", "2 · /chats", 24); L("1 · /tasks", "2 · Left", 20); L("1 · /tasks", "2 · /people", 20);
L("1 · /welcome", "2 · /tasks", 26); L("1 · /welcome", "2 · Left", 13);
L("1 · Other", "2 · Left", 86); L("1 · Other", "2 · Other", 70); L("1 · Other", "2 · /chats", 32); L("1 · Other", "2 · /people", 15);
L("2 · /tasks", "3 · /tasks/:id", 70); L("2 · /tasks", "3 · Left", 30); L("2 · /tasks", "3 · Other", 20);
L("2 · /chats", "3 · /chats", 40); L("2 · /chats", "3 · Left", 36); L("2 · /chats", "3 · Other", 20);
L("2 · /people", "3 · Other", 40); L("2 · /people", "3 · Left", 21);
L("2 · Other", "3 · Other", 30); L("2 · Other", "3 · /chats", 30); L("2 · Other", "3 · Left", 52); L("2 · Other", "3 · /tasks/:id", 18);
L("3 · /tasks/:id", "4 · /tasks", 40); L("3 · /tasks/:id", "4 · Left", 30); L("3 · /tasks/:id", "4 · Other", 18);
L("3 · /chats", "4 · Other", 30); L("3 · /chats", "4 · Left", 40);
L("3 · Other", "4 · /tasks", 20); L("3 · Other", "4 · Other", 42); L("3 · Other", "4 · Left", 48);
const FUNNELS = [
  { key: "task", label: "Create a task", steps: [{ label: "Opened New task", sessions: 16, kept: null }, { label: "Task saved", sessions: 11, kept: 69 }] },
  { key: "document", label: "Quote or invoice", steps: [{ label: "Opened Billing", sessions: 37, kept: null }, { label: "Draft made", sessions: 14, kept: 38 }, { label: "Saved", sessions: 12, kept: 32 }] },
  { key: "checkin", label: "Check in", steps: [{ label: "Opened attendance", sessions: 130, kept: null }, { label: "Checked in", sessions: 96, kept: 74 }] }];
const line = (key, label, unit, now, before, change, verdict) => ({ key, label, unit, now, before, change, verdict, lowerIsBetter: key !== "people" });
const DIGEST = { lines: [
  line("load", "Opening the app", "ms", 6819, 10018, -32, "better"), line("route", "Moving between pages", "ms", 3420, 4488, -24, "better"),
  line("api", "Waiting for data", "ms", 814, 1026, -21, "better"), line("errors", "Errors on screen", "count", 1, 2.3, -57, "better"),
  line("struggle", "Struggle moments", "count", 60, 21.3, 182, "worse"), line("people", "People using Pulse", "count", 16, 17, -6, "same"),
  line("aiPerRun", "AI tokens per job", "tokens", 18200, 32698, -44, "better")],
  pagesWorse: [line("/docs/:id", "/docs/:id", "ms", 9593, 6079, 58, "worse")], pagesBetter: [line("/people", "/people", "ms", 1170, 6727, -83, "better"), line("/whats-new", "/whats-new", "ms", 1911, 5906, -68, "better")] };
const STORY = { days: 30, zone: "Asia/Kolkata", journeys: JOURNEYS, funnels: FUNNELS, speed: SPEED, pages: PAGES, struggle: STRUGGLE, digest: DIGEST };
const EMPTY_STORY = { days: 30, zone: "Asia/Kolkata", journeys: { sessions: 0, nodes: [], links: [] }, funnels: FUNNELS.map((f) => ({ ...f, steps: f.steps.map((s) => ({ ...s, sessions: 0, kept: null })) })), speed: [], pages: [], struggle: [], digest: { lines: [], pagesWorse: [], pagesBetter: [] } };
const TYPES = [["task.daily", 9, 27000], ["task.assigned", 2, 28000], ["chat.quote", 2, 24000], ["chat.ask", 2, 18000], ["task.mention", 1, 30000], ["chat.short", 1, 9000]];
const BYDAY = DAYS.flatMap((day, i) => TYPES.map(([type, runs, per]) => {
  const after = i >= 27, r = type === "task.daily" && after ? 2 : Math.max(0, runs - (i % 3 === 0 ? 1 : 0));
  return { day, type, runs: r, tokens: r * per, tokensIn: r * per * 0.95, tokensOut: r * per * 0.05, failed: i % 9 === 0 && type === "chat.quote" ? 1 : 0, inr: Math.round(r * per * 0.00028 * 100) / 100, unpriced: 0,
    ruled: type === "task.daily" && after ? 7 : type === "chat.short" && i % 4 === 0 ? 1 : 0, ruledTokens: 0, saved: type === "task.daily" && after ? 7 * 27000 : type === "chat.short" && i % 4 === 0 ? 13300 : 0 };
}));
const AGENT = (id, name, budget, today, p90, runs, tokens, ruled, saved, warn) => ({ id: `00000000-0000-4000-8000-0000000000a${id}`, name, title: null, budget, today, p90Day: p90, runs, tokens, inr: null, failed: 0, ruled, saved, waitedForBudget: 0, warn, suggested: Math.max(100000, Math.ceil((p90 * 1.5) / 50000) * 50000), provider: "claude", paused: false });
// TOKENS-2: the model router's report, shaped like production's replay (233 runs before the router; the first routed week).
const ROUTER = { days: 30, priced: true,
  classes: [{ class: "unrouted", runs: 233, strongest: 58, strong: 152, escalated: 0, tokens: 5900000, inr: 1773 }, { class: "small", runs: 14, strongest: 0, strong: 0, escalated: 1, tokens: 84000, inr: 3.4 },
    { class: "action", runs: 9, strongest: 0, strong: 0, escalated: 1, tokens: 214000, inr: 47 }, { class: "lookup", runs: 4, strongest: 0, strong: 0, escalated: 0, tokens: 72000, inr: 16 },
    { class: "heavy", runs: 2, strongest: 2, strong: 2, escalated: 0, tokens: 96000, inr: 61 }],
  weeks: [["2026-10-19", 31, 12, 0, 214], ["2026-10-26", 52, 18, 0, 402], ["2026-11-02", 61, 16, 0, 455], ["2026-11-09", 70, 10, 0, 520], ["2026-11-16", 48, 4, 29, 210]].map(([week, runs, strongest, routed, inr]) => ({ week, runs, strongest, routed, inr })),
  types: TYPES.map(([taskType, , per]) => ({ taskType, runs: 30, strongest: 0, tokens: 30 * per, inr: 30 * per * 0.00028, inrPerRun: Math.round(per * 0.00028 * 100) / 100 })),
  patterns: [{ key: "pattern:task.daily:ab12cd34ef", taskType: "task.daily", title: "Same kind of answer for daily task looks (task:comment+status=waiting)", state: "candidate", uses: 0, saved: 0, evidence: { runs: 12, agents: 2, avgTokens: 9000, days: 14 } },
    { key: "pattern:chat.quote:0f1e2d3c4b", taskType: "chat.quote", title: "Same steps for quotation chats: find_client → draft_quotation", state: "candidate", uses: 0, saved: 0, evidence: { runs: 7, agents: 1, avgTokens: 24000, days: 14 } }] };
const COST = { days: 30, byDay: BYDAY, priced: true, router: ROUTER, canReview: true,
  agents: [AGENT(1, "Project Coordinator (AI)", 1000000, 164000, 330000, 160, 4300000, 24, 650000, false), AGENT(2, "Quotations helper (AI)", 1000000, 820000, 760000, 48, 1200000, 3, 40000, true), AGENT(3, "HR Assistant (AI)", 240000, 0, 60000, 8, 170000, 0, 0, false)],
  waste: { daily: { runs: 105, tokens: 2890000 }, repeat: { runs: 97, tokens: 2880000 }, failed: { runs: 19, tokens: 154000 }, fallback: { runs: 40, tokens: 1070000 } },
  rules: [{ key: "task.quiet", title: "Quiet task: look again after 1, 2 and 4 days, then only when something happens", type: "task", kind: "rule", state: "active", uses: 21, saved: 567000 },
    { key: "task.with_reviewer", title: "No daily look while the task is with its reviewer", type: "task", kind: "rule", state: "active", uses: 4, saved: 108000 },
    { key: "chat.screen_direct", title: "Plain screen requests (\"open Finance\") done without a model", type: "chat", kind: "rule", state: "active", uses: 8, saved: 106400 }] };
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
    const empty = url.searchParams.get("days") === "7"; // the shots show the 7-day view as a company with no use yet
    if (req.method === "GET" && url.pathname === "/api/v0/telemetry/story") return send(res, 200, empty ? EMPTY_STORY : STORY);
    if (req.method === "GET" && url.pathname === "/api/v0/telemetry/ai-cost") return send(res, 200, empty ? { ...COST, byDay: [], agents: [], rules: [] } : COST);
    const up = httpRequest({ host: "127.0.0.1", port: mockPort, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on("error", () => send(res, 502, { error: "mock unavailable" }));
    req.pipe(up);
  } catch (e) { console.error(e); send(res, 500, { error: String(e).slice(0, 200) }); }
}).listen(apiPort, "127.0.0.1");
const webServer = start(join(web, "node_modules/.bin/next"), ["dev", "--disable-source-maps", "-p", String(webPort), "-H", "127.0.0.1"],
  { cwd: web, env: { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: ".next-insights", PULSE_API_URL: `http://127.0.0.1:${apiPort}` } });
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
const ALL = [["insights", "/telemetry/insights"], ["journeys", "/telemetry/insights?tab=journeys"], ["speed", "/telemetry/insights?tab=speed"], ["struggle", "/telemetry/insights?tab=struggle"], ["ai", "/telemetry/insights?tab=ai"], ["empty", "/telemetry/insights?days=7"]];
const SHOTS = ALL.filter(([name]) => !only.length || only.includes(name));
// Compile each page once before the first shot (a cold `next dev` compile on a busy box took over 4 minutes).
for (const [, path] of SHOTS) { try { await fetch(`http://127.0.0.1:${webPort}${path}`, { headers: { "Cf-Access-Authenticated-User-Email": IDENTITY }, signal: AbortSignal.timeout(480000) }); } catch {} }
// SPEED-2: compile the API proxy route too (the first client call of a cold `next dev` waited on it).
try { await fetch(`http://127.0.0.1:${webPort}/api/v0/telemetry/story`, { headers: { "Cf-Access-Authenticated-User-Email": IDENTITY }, signal: AbortSignal.timeout(240000) }); } catch {}
const browser = await chromium.launch();
const report = [];
for (const [name, path] of SHOTS) for (const width of widths) for (const theme of themes) {
  const height = width < 500 ? 844 : 900;
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1, extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": IDENTITY } });
  await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); localStorage.setItem("theme", t); } catch {} }, theme);
  const page = await ctx.newPage(); const errors = [];
  page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  try {
    await page.goto(`http://127.0.0.1:${webPort}${path}`, { waitUntil: "load", timeout: 240000 });
    await pageReady(page);
    // Every chart has finished drawing (ECharts is loaded on demand and animates in).
    await page.waitForFunction(() => [...document.querySelectorAll('main [role="img"]')].every((el) => el.hasAttribute("data-drawn")), {}, { timeout: 90000 }).catch(() => console.log("charts not all drawn"));
    await pause(page, 1200);
    const audit = await page.evaluate(AUDIT);
    // Pages scroll inside the shell: grow the window to their length so one image holds all of it.
    const full = await page.evaluate(() => { let h = document.documentElement.scrollHeight; for (const el of document.querySelectorAll("body *")) { const c = getComputedStyle(el); if (/(auto|scroll)/.test(c.overflowY) && el.scrollHeight > el.clientHeight + 4) h = Math.max(h, el.scrollHeight + el.getBoundingClientRect().top); } return Math.ceil(h); });
    if (full > height) { await page.setViewportSize({ width, height: Math.min(full, 7000) }); await pause(page, 600); }
    const file = join(out, `${name}-${width}-${theme}.png`);
    await page.screenshot({ path: file });
    report.push({ name, width, theme, file, ...audit, errors: errors.slice(0, 4) });
    console.log(`${name} ${width} ${theme}${audit.clipped.length ? ` CLIPPED ${audit.clipped.join(" | ")}` : ""}${audit.wide ? ` WIDE ${audit.wide}` : ""}${errors.length ? ` ERRORS ${errors.slice(0, 2).join(" | ")}` : ""}`);
  } catch (e) { report.push({ name, width, theme, error: String(e).slice(0, 300) }); console.log(`${name} ${width} ${theme} FAILED ${String(e).slice(0, 300)}`); }
  await ctx.close();
}
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
await browser.close();
console.log("SHOTS-DONE");
process.exit(0);
