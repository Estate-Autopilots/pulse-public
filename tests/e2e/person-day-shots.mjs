// DOREVE-FIX screenshots of /telemetry/day (one person's day, their struggle moments and the replay), on synthetic data
// only: mock-editors-api.mjs behind a small layer that answers /api/v0/telemetry/day and one synthetic replay, and a
// private `next dev` (its own dist dir). Never touches pulse-dev or any real data. The day copies the shape of what
// production showed for one Atlas Crest person (refused circles, a page not ready for 23 s, repeated clicks),
// with invented names and ids. Run: nivi-heavy node tests/e2e/person-day-shots.mjs --out <dir> [--widths 1440,363] [--themes light,dark]
import { spawn, execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";
const here = dirname(fileURLToPath(import.meta.url)); const repo = join(here, "../.."); const web = join(repo, "apps/web");
const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = opt("out", "/tmp/person-day-shots"); mkdirSync(out, { recursive: true });
const widths = opt("widths", "1440,363").split(",").map(Number); const themes = opt("themes", "light,dark").split(",");
const only = opt("only", "")?.split(",").filter(Boolean) ?? [];
const IDENTITY = "leadership@northwind.example";

// ------------------------------------------------------------------ synthetic fixtures (names and ids are invented)
const PERSON = "00000000-0000-4000-8000-0000000000d1";
const NAMES = ["Asha Example", "Ravi Sample", "Meera Test", "Kabir Demo", "Nisha Fixture"];
const at = (hhmmss) => new Date(`2026-11-17T${hhmmss}+05:30`).toISOString();
const PEOPLE = NAMES.map((name, i) => ({ id: i === 0 ? PERSON : `00000000-0000-4000-8000-0000000000e${i}`, name, days: [9, 12, 7, 3, 1][i], last: at(["15:57:00", "14:10:00", "11:02:00", "09:40:00", "18:20:00"][i]),
  refused: [9, 0, 1, 0, 0][i], slowStarts: [2, 1, 0, 0, 0][i] }));
const STEP0 = { at: at("09:10:47"), sessionId: "synthetic-session-0", kind: "nav.load", label: "Opened /tasks", page: "/tasks", ms: 22994, tone: "slow", requestId: null };
const STEPS = [
  ["14:50:57", "nav.load", "Opened /tasks", "/tasks", 2432, "ok"], ["14:51:30", "ui.click", "Clicked a task's circle", "/tasks", 53, "ok"],
  ["14:51:32", "ui.click", "Clicked “Mark done” · refused", "/tasks", 150, "fail"], ["14:51:32", "api", "POST tasks/:id/move refused (400)", "/tasks", 111, "fail"],
  ["14:51:41", "ui.click", "Clicked a task's circle", "/tasks", 36, "ok"], ["14:51:42", "ui.click", "Clicked a task's circle · refused", "/tasks", 131, "fail"],
  ["14:53:12", "ui.click", "Clicked a task's circle", "/tasks", 54, "ok"], ["14:53:15", "ui.click", "Clicked a task's circle", "/tasks", 422, "ok"],
  ["14:53:37", "ui.click", "Clicked “A person”", "/tasks", 156, "ok"], ["14:53:59", "nav.route", "Went to /tasks/:id from /tasks", "/tasks/:id", 296, "ok"],
  ["14:55:04", "nav.route", "Went to /tasks/:id from /tasks", "/tasks/:id", 4100, "slow"], ["15:02:10", "ui.click", "Clicked the finance link", "/tasks/:id", 910, "ok"],
  ["15:02:33", "ui.submit", "Sent a form (Save entry)", "/finance", 1602, "ok"],
].map(([t, kind, label, page, ms, tone], i) => ({ at: at(t), sessionId: i < 11 ? "synthetic-session-1" : "synthetic-session-2", kind, label, page, ms, tone, requestId: null }));
STEPS.unshift(STEP0);
const STRUGGLES = [
  ["09:10:47", "dead_start", "/tasks looked ready but did not respond for 23 s", "It appeared in 312 ms, but clicks did nothing for 23 s", "/tasks", 22994, "synthetic-session-0"],
  ["14:51:30", "repeat", "Clicked a task's circle 3 times in 12 s", "The same thing again and again: it may not have answered", "/tasks", 12156, "synthetic-session-1"],
  ["14:51:32", "refused", "Clicked “Mark done”; it was refused", "POST tasks/:id/move answered 400", "/tasks", 150, "synthetic-session-1"],
  ["14:51:42", "refused", "Clicked a task's circle; it was refused", "POST tasks/:id/move answered 400", "/tasks", 131, "synthetic-session-1"],
  ["14:55:04", "slow", "Waited 4.1 s for /tasks/:id", "Still loading: GET /api/v0/work/options", "/tasks", 4100, "synthetic-session-1"],
  ["15:02:20", "freeze", "/finance froze for 1.3 s", "Right after a click", "/finance", 1300, "synthetic-session-2"],
].map(([t, kind, title, detail, page, ms, sessionId]) => ({ at: at(t), sessionId, kind, title, detail, page, ms, requestId: null }));
const DAY = (person, date) => !person ? { zone: "Asia/Kolkata", people: PEOPLE, person: null } : {
  zone: "Asia/Kolkata", people: PEOPLE, person: { id: PERSON, name: "Asha Example" }, date: date ?? "2026-11-17",
  days: [{ d: "2026-11-15", n: 536 }, { d: "2026-11-16", n: 278 }, { d: "2026-11-17", n: 252 }],
  sessions: [
    { id: "synthetic-session-0", start: at("09:10:47"), end: at("09:30:02"), platform: "web", device: "desktop", replay: null },
    { id: "synthetic-session-1", start: at("14:50:57"), end: at("14:58:10"), platform: "web", device: "desktop", replay: { from: at("14:50:59"), to: at("14:57:59"), chunks: 1 } },
    { id: "synthetic-session-2", start: at("15:01:00"), end: at("15:57:52"), platform: "web", device: "desktop", replay: null }],
  truncated: false, steps: STEPS, struggles: STRUGGLES,
  slowPages: [{ name: "/tasks", n: 3, p50: 2432, p90: 22994, max: 22994 }, { name: "/tasks/:id", n: 4, p50: 296, p90: 4100, max: 4100 }, { name: "/finance", n: 2, p50: 910, p90: 1022, max: 1022 }, { name: "/dashboard", n: 2, p50: 527, p90: 690, max: 690 }],
  slowActions: [{ name: "“Save entry” on /finance", n: 2, p50: 1291, p90: 1602, max: 1602 }, { name: "the finance link on /tasks/:id", n: 1, p50: 910, p90: 910, max: 910 }, { name: "a task's circle on /tasks", n: 6, p50: 54, p90: 422, max: 422 }],
  totals: { sessions: 3, loads: 2, moves: 5, actions: 13, failed: 2, struggles: STRUGGLES.length, activeMs: 4 * 3600_000 + 3 * 60_000 } };
// One synthetic replay chunk: a small invented task list, as rrweb records a page.
const t0 = Date.parse(at("14:50:59"));
let nid = 1; const el = (tagName, attributes = {}, childNodes = []) => ({ type: 2, tagName, attributes, childNodes, id: nid++ }); const tx = (textContent) => ({ type: 3, textContent, id: nid++ });
const rowsHtml = ["Send the April invoice", "Plan the client workshop", "Collect last year's records", "Call the printer", "Draft the hiring post", "Book the venue", "Reply to the landlord",
  "Update the price list", "Check the GST filing", "Pay the internet bill", "Share the design brief", "Order new visiting cards", "Fix the website contact form"].map((t, i) =>
  el("tr", {}, [el("td", { style: "width:28px;padding:10px 6px 10px 14px;border-bottom:1px solid #e5e7eb" }, [tx(i === 2 ? "◉" : "○")]), el("td", { style: "padding:10px 14px;border-bottom:1px solid #e5e7eb;font-weight:600" }, [tx(t)]), el("td", { style: "padding:10px 14px;border-bottom:1px solid #e5e7eb;color:#b91c1c" }, [tx("Late")])]));
const SNAP = { type: 0, childNodes: [{ type: 1, name: "html", publicId: "", systemId: "", id: nid++ }, el("html", {}, [el("head", {}, []), el("body", { style: "margin:0;font:14px system-ui;background:#fafafa;color:#111" }, [
  el("div", { style: "padding:24px" }, [el("h1", { style: "margin:0 0 16px;font-size:22px" }, [tx("Work")]), el("table", { style: "width:100%;border-collapse:collapse;background:#fff;border-radius:12px" }, [el("tbody", {}, rowsHtml)]),
    el("div", { style: "position:fixed;right:24px;bottom:24px;padding:12px 16px;border-radius:12px;background:#fff;border-left:4px solid #dc2626;box-shadow:0 6px 20px rgba(0,0,0,.15);font-weight:600" }, [tx("Not changed · Finish, move out or cancel its open subtask first")])])])])] };
const EVENTS = [{ type: 4, timestamp: t0, data: { href: "https://example.invalid/tasks", width: 1280, height: 720 } }, { type: 2, timestamp: t0 + 5, data: { node: SNAP, initialOffset: { top: 0, left: 0 } } },
  // The pointer moves to the third row's circle and clicks it at the refused moment (33 s in).
  ...Array.from({ length: 40 }, (_, i) => ({ type: 3, timestamp: t0 + 1000 + i * 1500, data: { source: 1, positions: [{ x: Math.max(40, 600 - i * 40), y: Math.max(160, 460 - i * 20), id: 1, timeOffset: 0 }] } })),
  { type: 3, timestamp: t0 + 33000, data: { source: 2, type: 2, id: 1, x: 40, y: 160 } }];
const REPLAY_GZ = gzipSync(Buffer.from(JSON.stringify(EVENTS)));
const REPLAY_META = { sid: "synthetic-session-1", zone: "Asia/Kolkata", who: "Asha Example", chunks: [{ seq: 0, route: "/tasks", startedAt: at("14:50:59"), endedAt: at("14:57:59"), events: EVENTS.length, bytes: REPLAY_GZ.length, reason: "sample" }] };

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
    if (req.method === "GET" && url.pathname === "/api/v0/telemetry/day") return send(res, 200, DAY(url.searchParams.get("person"), url.searchParams.get("date")));
    if (req.method === "GET" && url.pathname === "/api/v0/telemetry/replay/synthetic-session-1") return send(res, 200, REPLAY_META);
    if (req.method === "GET" && url.pathname === "/api/v0/telemetry/replay/synthetic-session-1/0") { res.writeHead(200, { "content-type": "application/gzip" }); return res.end(REPLAY_GZ); }
    const up = httpRequest({ host: "127.0.0.1", port: mockPort, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on("error", () => send(res, 502, { error: "mock unavailable" }));
    req.pipe(up);
  } catch (e) { console.error(e); send(res, 500, { error: String(e).slice(0, 200) }); }
}).listen(apiPort, "127.0.0.1");
const webServer = start(join(web, "node_modules/.bin/next"), ["dev", "--disable-source-maps", "-p", String(webPort), "-H", "127.0.0.1"],
  { cwd: web, env: { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: ".next-person-day", PULSE_API_URL: `http://127.0.0.1:${apiPort}` } });
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
const ALL = [
  ["people", "/telemetry/day"],
  ["day", `/telemetry/day?person=${PERSON}&date=2026-11-17`],
  ["replay", `/telemetry/day?person=${PERSON}&date=2026-11-17&watch=synthetic-session-1&t=${Date.parse("2026-11-17T09:21:32Z")}`],
];
const SHOTS = ALL.filter(([name]) => !only.length || only.includes(name));
// Compile each page once before the first shot (a cold `next dev` compile on a busy box took over 4 minutes).
for (const [, path] of SHOTS) { try { await fetch(`http://127.0.0.1:${webPort}${path}`, { headers: { "Cf-Access-Authenticated-User-Email": IDENTITY }, signal: AbortSignal.timeout(480000) }); } catch {} }
// SPEED-2: compile the API proxy route too (the first client call of a cold `next dev` waited on it).
try { await fetch(`http://127.0.0.1:${webPort}/api/v0/telemetry/day`, { headers: { "Cf-Access-Authenticated-User-Email": IDENTITY }, signal: AbortSignal.timeout(240000) }); } catch {}
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
    await pageReady(page); await pause(page, 1800);
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
