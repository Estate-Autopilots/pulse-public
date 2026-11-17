// SPEED-TELEMETRY screenshots of /telemetry's two new views (How people move, Speed targets), on synthetic data only:
// mock-editors-api.mjs behind a small layer that answers the telemetry routes from the fixtures below, and a private
// `next dev` (its own dist dir) pointed at it. Never touches pulse-dev or any real data. Run through the CPU wrapper:
//   nivi-heavy node tests/e2e/speed-telemetry-shots.mjs --out <dir> [--widths 1440,363] [--themes light,dark] [--only moves]
// Each shot also reports clipped boxes and sideways overflow (as agreements-shots.mjs).
import { spawn, execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
const here = dirname(fileURLToPath(import.meta.url)); const repo = join(here, "../.."); const web = join(repo, "apps/web");
const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = opt("out", "/tmp/speed-telemetry-shots"); mkdirSync(out, { recursive: true });
const widths = opt("widths", "1440,363").split(",").map(Number); const themes = opt("themes", "light,dark").split(",");
const only = opt("only", "")?.split(",").filter(Boolean) ?? [];
const IDENTITY = "leadership@northwind.example";

// ------------------------------------------------------------------ synthetic fixtures (names are invented)
const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000000${i + 1}`);
const NAMES = ["Asha Example", "Ravi Sample", "Meera Test", "Kabir Demo", "Nisha Fixture", "Ahoro Placeholder"];
const ago = (min) => new Date(Date.UTC(2026, 10, 14, 10, 0) - min * 60_000).toISOString();
const OVERVIEW = { days: 7, platform: null, zone: "Asia/Kolkata",
  totals: { events: 41210, sessions: 212, people: 6, views: 2380, actions: 4120, apiCalls: 30110, errors: 41, viewP75: 1450, actionP75: 620, serverP75: 48 },
  pages: [], actions: [], server: [], client: [], vitals: [], longTasks: [], errors: [], people: [], roles: [], sessions: [], trend: [], versions: [] };
const PAGES = [["/dashboard", 610, 6, 95_000, 820, 1900, 41], ["/tasks", 540, 6, 210_000, 640, 1400, 22], ["/chats", 480, 5, 180_000, 520, 1300, 35],
  ["/people", 160, 5, 40_000, 2100, 4800, 6], ["/me", 150, 6, 52_000, 1700, 3900, 9], ["/tasks/:id", 140, 5, 75_000, 900, 2100, 4],
  ["/hr", 60, 3, 61_000, 1600, 3500, 3], ["/clients", 44, 3, 38_000, 1200, 2600, 2], ["/settings", 30, 2, 33_000, 1100, 2400, 1]];
const TRAILS = (person, page) => {
  const scale = person ? 0.2 : 1;
  const moves = [["/dashboard", "/tasks", 180, 6, 610, 1300], ["/tasks", "/tasks/:id", 140, 5, 880, 2100], ["/dashboard", "/chats", 120, 5, 450, 1100],
    ["/tasks/:id", "/tasks", 96, 5, 520, 1200], ["/dashboard", "/people", 60, 4, 1900, 4600], ["/people", "/people/:id", 52, 4, 980, 2300],
    ["/dashboard", "/me", 48, 6, 1500, 3700], ["/me", "/me?tab=attendance", 40, 5, 700, 1900], ["/chats", "/dashboard", 38, 4, 560, 1250],
    ["/dashboard", "/hr", 20, 3, 1400, 3300], ["/dashboard", "/clients", 16, 3, 1100, 2500]]
    .filter(([f, t]) => !page || f === page || t === page)
    .map(([from, to, n, people, p50, p90]) => ({ from, to, n: Math.max(1, Math.round(n * scale)), people: person ? 1 : people, p50, p90 }));
  return { days: 7, zone: "Asia/Kolkata", person: person ? { id: person, name: NAMES[ids.indexOf(person)] ?? "Asha Example" } : null, page,
    people: person ? [] : ids.map((id, i) => ({ personId: id, name: NAMES[i], role: i === 0 ? "leadership" : "person", sessions: 48 - i * 7, views: 520 - i * 70, activeMin: 610 - i * 80,
      last: ago(i * 37), topPage: ["/tasks", "/chats", "/dashboard", "/tasks", "/me", "/people"][i], slowPage: ["/people", "/me", "/people", "/hr", "/me", "/clients"][i], slowP75: [4200, 3100, 2600, 1900, 1400, 1100][i] })),
    moves,
    pages: PAGES.filter(([p]) => !page || p === page).map(([p, views, people, act, o50, o90, exits]) => ({ page: p, views: Math.max(1, Math.round(views * scale)), people: person ? 1 : people, activeP50: act, openP50: o50, openP90: o90, exits: Math.round(exits * scale) })),
    slowest: [["/people", 160, 2100, 4800], ["/me", 150, 1700, 3900], ["/hr", 60, 1600, 3500], ["/clients", 44, 1200, 2600], ["/settings", 30, 1100, 2400], ["/tasks/:id", 140, 900, 2100]]
      .map(([pg, n, p50, p90]) => ({ page: pg, n: Math.max(2, Math.round(n * scale)), p50, p90 })),
    sessions: Array.from({ length: 6 }, (_, i) => ({ id: `synthetic-session-${i + 1}`, name: person ? null : NAMES[i], start: ago(30 + i * 55), end: ago(i * 55), views: 14 - i,
      path: ["/dashboard", "/tasks", "/tasks/:id", "/tasks", "/chats", "/dashboard", "/people", "/people/:id", "/me"].slice(0, 9 - i), replay: i % 2 === 0 })) };
};
// SPEED-2: the owner's new targets (1 s / 500 ms / 3 s) and a day like production's 15 Nov (one target met).
const SPEED = { targets: { route: 1000, api: 500, load: 3000 },
  now: { route: 2200, routeBefore: 5100, load: 2600, loadBefore: 9600, api: 770, apiBefore: 1560, views: 384, prefetches: 0.6 },
  pages: [["/people", 19, 1900, 3900, 7000], ["/me", 20, 1500, 3300, 9600], ["/hr", 3, 1400, 2900, 4600], ["/settings", 4, 1300, 2600, 6400], ["/clients", 4, 1100, 2400, 5000],
    ["/tasks/:id", 4, 800, 1700, 8400], ["/tasks", 41, 700, 1450, 6900], ["/dashboard", 56, 650, 1300, 7100], ["/chats", 58, 500, 1100, 7200]].map(([name, n, p50, p90, p90Before]) => ({ name, n, p50, p90, p90Before })),
  api: [["GET /api/v0/calls", 210, 340, 1900, 1490], ["GET /api/v0/screen/pending", 105, 420, 1500, 769], ["GET /api/v0/tasks/reviews/count", 523, 330, 980, 1426],
    ["GET /api/v0/companion", 370, 400, 900, 1147], ["GET /api/v0/work/scorecard/:id", 12, 60, 140, 2100], ["GET /api/v0/hr/self/approvals", 30, 45, 120, null]].map(([name, n, p50, p90, p90Before]) => ({ name, n, p50, p90, p90Before })) };

const LISTEN = { on: true, live: true, retentionDays: 14, canEdit: true, instant: { server: false, on: true, provider: null },
  agents: [{ id: "00000000-0000-4000-8000-0000000000a1", name: "Bharata" }],
  sessions: [{ id: "00000000-0000-4000-8000-0000000000b1", title: "Client call: site signboards", purpose: "meeting", startedAt: ago(90), stoppedAt: ago(70), agent: "Bharata", by: "Asha Example", segments: 42, purgeAfter: ago(-20160) }] };

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
    if (req.method === "GET" && url.pathname === "/api/v0/telemetry") return send(res, 200, OVERVIEW);
    if (req.method === "GET" && url.pathname === "/api/v0/telemetry/trails") return send(res, 200, TRAILS(url.searchParams.get("person"), url.searchParams.get("page")));
    if (req.method === "GET" && url.pathname === "/api/v0/telemetry/speed") return send(res, 200, SPEED);
    // SPEED-2: Listen before it starts (its one line on what it does), on the server's Whisper as production is today.
    if (req.method === "GET" && url.pathname === "/api/v0/listen") return send(res, 200, LISTEN);
    const up = httpRequest({ host: "127.0.0.1", port: mockPort, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on("error", () => send(res, 502, { error: "mock unavailable" }));
    req.pipe(up);
  } catch (e) { console.error(e); send(res, 500, { error: String(e).slice(0, 200) }); }
}).listen(apiPort, "127.0.0.1");
const webServer = start(join(web, "node_modules/.bin/next"), ["dev", "--disable-source-maps", "-p", String(webPort), "-H", "127.0.0.1"],
  { cwd: web, env: { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: ".next-speed-telemetry", PULSE_API_URL: `http://127.0.0.1:${apiPort}` } });
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
  ["moves", "/telemetry?view=moves"],
  ["moves-person", `/telemetry?view=moves&person=${ids[0]}`],
  ["speed", "/telemetry?view=speed"],
  // SPEED-2: last, once the dev server has compiled the API proxy and the fonts (shot first, it timed out on fonts).
  ["listen", "/listen"],
];
const SHOTS = ALL.filter(([name]) => !only.length || only.includes(name));
// Compile each page once before the first shot (a cold `next dev` compile on a busy box took over 4 minutes).
for (const [, path] of SHOTS) { try { await fetch(`http://127.0.0.1:${webPort}${path}`, { headers: { "Cf-Access-Authenticated-User-Email": IDENTITY }, signal: AbortSignal.timeout(480000) }); } catch {} }
// SPEED-2: compile the API proxy route too (the first client call of a cold `next dev` waited on it).
try { await fetch(`http://127.0.0.1:${webPort}/api/v0/listen`, { headers: { "Cf-Access-Authenticated-User-Email": IDENTITY }, signal: AbortSignal.timeout(240000) }); } catch {}
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
