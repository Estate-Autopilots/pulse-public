// AGREEMENTS screenshots and the acceptance video, on synthetic data only: mock-editors-api.mjs behind a small layer that
// answers the Agreements routes (fixtures/agreements.mjs), and a private `next dev` (its own dist dir) pointed at it.
// Never touches pulse-dev. Run through the CPU wrapper:
//   ea-heavy node tests/e2e/agreements-shots.mjs --out <dir> [--widths 1440,363] [--themes light,dark] [--only accept-term] [--video]
// Each shot also reports clipped boxes and sideways overflow (as hr-polish-shots.mjs).
import { spawn, execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { PEOPLE, answer as agreements } from "./fixtures/agreements.mjs";
const here = dirname(fileURLToPath(import.meta.url)); const repo = join(here, "../.."); const web = join(repo, "apps/web");
const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = opt("out", "/tmp/agreements-shots"); mkdirSync(out, { recursive: true });
const widths = opt("widths", "1440,363").split(",").map(Number); const themes = opt("themes", "light,dark").split(",");
const only = opt("only", "")?.split(",").filter(Boolean) ?? [];

const freePort = () => new Promise((ok) => { const s = netServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const children = [];
const start = (cmd, argv, opts) => { const c = spawn(cmd, argv, { ...opts, detached: true, stdio: ["ignore", "pipe", "pipe"] }); children.push(c); let log = ""; c.stdout.on("data", (d) => { log += d; }); c.stderr.on("data", (d) => { log += d; }); c.log = () => log.slice(-3000); return c; };
const stop = () => { for (const c of children) { try { process.kill(-c.pid, "SIGTERM"); } catch {} } };
process.on("exit", stop); process.on("SIGINT", () => process.exit(130)); process.on("SIGTERM", () => process.exit(143));
const waitFor = async (url, ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return; } catch {} await new Promise((r) => setTimeout(r, 500)); } throw new Error(`timed out waiting for ${url}`); };

const mockPort = await freePort(); const apiPort = await freePort(); const webPort = await freePort();
start(process.execPath, ["tests/e2e/mock-editors-api.mjs"], { cwd: repo, env: { ...process.env, PORT: String(mockPort) } });
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({}); } }); });
createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x"); const identity = String(req.headers["cf-access-authenticated-user-email"] ?? "").toLowerCase(); const p = PEOPLE[identity];
    const body = req.method === "POST" && p ? await readBody(req) : undefined;
    const own = await agreements(url, req.method, identity, body); if (own) return send(res, own[0], own[1]);
    if (p) req.headers["cf-access-authenticated-user-email"] = p.as;
    // The person's own name on screen (the mock's synthetic staff member is "Synthetic Sam").
    if (p && url.pathname === "/api/v0/me") {
      const r = await fetch(`http://127.0.0.1:${mockPort}${req.url}`, { headers: { "cf-access-authenticated-user-email": p.as } });
      return send(res, r.status, { ...(await r.json()), name: p.name });
    }
    const up = httpRequest({ host: "127.0.0.1", port: mockPort, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on("error", () => send(res, 502, { error: "mock unavailable" }));
    if (body !== undefined) up.end(JSON.stringify(body)); else req.pipe(up);
  } catch (e) { console.error(e); send(res, 500, { error: String(e).slice(0, 200) }); }
}).listen(apiPort, "127.0.0.1");

start(join(web, "node_modules/.bin/next"), ["dev", "--disable-source-maps", "-p", String(webPort), "-H", "127.0.0.1"],
  { cwd: web, env: { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: ".next-agreements", PULSE_API_URL: `http://127.0.0.1:${apiPort}` } });
const restore = () => { try { execFileSync("git", ["checkout", "--", "apps/web/tsconfig.json"], { cwd: repo, stdio: "ignore" }); } catch {} };
process.on("exit", restore);
await waitFor(`http://127.0.0.1:${mockPort}/api/v0/me`, 30000); await waitFor(`http://127.0.0.1:${webPort}/login`, 180000);
console.log(`web http://127.0.0.1:${webPort}  api http://127.0.0.1:${apiPort}`);

const AUDIT = () => {
  const describe = (el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} «${(el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60)}»`;
  const clipped = [];
  for (const el of document.querySelectorAll("main *, [data-policy-accept] *")) {
    if (!(el instanceof HTMLElement) || !el.offsetParent || /srOnly/.test(String(el.className))) continue;
    const c = getComputedStyle(el);
    if (!["hidden", "clip"].includes(c.overflowY) || c.textOverflow === "ellipsis" || (c.webkitLineClamp && c.webkitLineClamp !== "none")) continue;
    if (el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0) clipped.push(`${describe(el)} ${el.scrollHeight}>${el.clientHeight}`);
  }
  const wide = document.documentElement.scrollWidth > innerWidth + 1 ? `page is ${document.documentElement.scrollWidth}px wide` : null;
  const sheet = document.querySelector("[data-policy-accept] [role=dialog]"); const r = sheet?.getBoundingClientRect();
  return { clipped: clipped.slice(0, 12), wide, sheet: r ? `${Math.round(r.width)}x${Math.round(r.height)} of ${innerWidth}x${innerHeight}` : null };
};
const sheet = (page) => page.locator("[data-policy-accept] [role=dialog]");
const pause = (page, ms) => page.waitForTimeout(ms);
const openSheet = async (page) => { await sheet(page).waitFor({ timeout: 60000 }); await pause(page, 700); };
const tick = async (page, n, slow = 0) => { for (let i = 0; i < n; i++) { await sheet(page).getByRole("button", { name: /^(I understand|Continue)/ }).click(); await pause(page, slow || 350); } };
const later = async (page) => { await openSheet(page); await sheet(page).getByRole("button", { name: "Not now" }).click(); await pause(page, 500); };
const pageReady = (page) => page.waitForFunction(() => document.querySelector("main h1, main h2") && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 120000 });

// [name, path, identity, act]: `act` drives the page to the moment shot.
const ALL = [
  ["accept-first", "/me", "diya@agreements.test", async (page) => { await openSheet(page); }],
  ["accept-term", "/me", "diya@agreements.test", async (page) => { await openSheet(page); await tick(page, 2); }],
  ["accept-table", "/me", "diya@agreements.test", async (page) => { await openSheet(page); await tick(page, 4); }],
  ["accept-finish", "/me", "diya@agreements.test", async (page) => { await openSheet(page); await tick(page, 6); }],
  ["accept-done", "/me", "diya@agreements.test", async (page) => { await openSheet(page); await tick(page, 6); await sheet(page).getByRole("button", { name: "I accept" }).click(); await pause(page, 2200); }],
  ["hub-mine", "/agreements", "diya@agreements.test", async (page) => { await later(page); await pageReady(page); }],
  ["hub-mine-done", "/agreements", "aarav@agreements.test", async (page) => { await pageReady(page); await pause(page, 2500); }],
  ["hub-team", "/agreements?tab=team", "isha@agreements.test", async (page) => { await pageReady(page); }],
  // AGREEMENTS round 14 Nov: People → Agreements, a workspace; an offer answered term by term.
  ["team-agreements", "/people/agreements", "isha@agreements.test", async (page) => { await pageReady(page); }],
  ["team-agreements-offer", "/people/agreements?pick=offer:tanvi", "isha@agreements.test", async (page) => { await pageReady(page); }],
  ["team-agreements-new", "/people/agreements?pick=new", "isha@agreements.test", async (page) => { await pageReady(page); await page.locator("select option").nth(1).waitFor({ state: "attached", timeout: 30000 }); }],
  ["offer-term", "/me", "rifob@agreements.test", async (page) => { await openSheet(page); await tick(page, 1); }],
  ["offer-done", "/me", "rifob@agreements.test", async (page) => { await openSheet(page); await tick(page, 4); await sheet(page).getByRole("button", { name: "I accept" }).click(); await pause(page, 2200); }],
  // My desk: only its Policies panel changed (the list's words and the button), so the shot is that panel.
  ["desk-policies", "/me?tab=policies&doc=pay", "diya@agreements.test", async (page) => { await later(page); await pageReady(page); }, "main [data-grow]"],
];
const SHOTS = ALL.filter(([name]) => !only.length || only.some((o) => name === o || name.startsWith(`${o}-`)));

const browser = await chromium.launch();
const context = async (width, theme, identity, video) => {
  const height = width < 500 ? 844 : 900;
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1, extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": identity },
    ...(video ? { recordVideo: { dir: video, size: { width, height } } } : {}) });
  await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); localStorage.setItem("theme", t); } catch {} }, theme);
  return ctx;
};
const report = [];
for (const [name, path, identity, act, only] of SHOTS) for (const width of widths) for (const theme of themes) {
  const ctx = await context(width, theme, identity); const page = await ctx.newPage(); const errors = [];
  page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  try {
    await page.goto(`http://127.0.0.1:${webPort}${path}`, { waitUntil: "load", timeout: 240000 });
    await act(page); await pause(page, 1800);
    const audit = await page.evaluate(AUDIT);
    // Pages on a phone scroll inside the shell: grow the window to their length so one image holds all of it (as
    // hr-polish-shots.mjs); the acceptance view is the whole screen there, so it keeps the phone's height.
    if (width < 1180 && !name.startsWith("accept") && !name.startsWith("offer")) {
      const full = await page.evaluate(() => { let h = document.documentElement.scrollHeight; for (const el of document.querySelectorAll("body *")) { const c = getComputedStyle(el); if (/(auto|scroll)/.test(c.overflowY) && el.scrollHeight > el.clientHeight + 4) h = Math.max(h, el.scrollHeight + el.getBoundingClientRect().top); } return Math.ceil(h); });
      if (full > 844) { await page.setViewportSize({ width, height: Math.min(full, 6000) }); await pause(page, 500); }
    }
    const file = join(out, `${name}-${width}-${theme}.png`);
    // `only`: that part of the page, with the page's own 16px around it.
    const box = only ? await page.locator(only).first().boundingBox() : null;
    if (box) { const x = Math.max(0, box.x - 16), y = Math.max(0, box.y - 16); await page.screenshot({ path: file, clip: { x, y, width: Math.min(width - x, box.width + 32), height: box.height + 32 } }); }
    else await page.screenshot({ path: file });
    report.push({ name, width, theme, file, ...audit, errors: errors.slice(0, 4) });
    console.log(`${name} ${width} ${theme}${audit.sheet ? ` sheet ${audit.sheet}` : ""}${audit.clipped.length ? ` CLIPPED ${audit.clipped.join(" | ")}` : ""}${audit.wide ? ` WIDE ${audit.wide}` : ""}${errors.length ? ` ERRORS ${errors.slice(0, 2).join(" | ")}` : ""}`);
  } catch (e) { report.push({ name, width, theme, error: String(e).slice(0, 300) }); console.log(`${name} ${width} ${theme} FAILED ${String(e).slice(0, 300)}`); }
  await ctx.close();
}
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));

// --video: the whole acceptance at a person's pace, desktop and phone (their acceptance stays, so the page after shows it).
if (args.includes("--video")) for (const [width, label, identity] of [[1440, "desktop", "kedab@agreements.test"], [390, "phone", "sana@agreements.test"]]) {
  const dir = join(out, `video-${label}`); mkdirSync(dir, { recursive: true });
  const ctx = await context(width, "light", identity, dir); const page = await ctx.newPage();
  try {
    await page.goto(`http://127.0.0.1:${webPort}/me`, { waitUntil: "load", timeout: 240000 });
    await openSheet(page); await pause(page, 1500);
    await tick(page, 6, 1400);
    await pause(page, 1200); await sheet(page).getByRole("button", { name: "I accept" }).click(); await pause(page, 2600);
    await sheet(page).getByRole("button", { name: "Back to work" }).click(); await pause(page, 1500);
    await page.goto(`http://127.0.0.1:${webPort}/agreements`, { waitUntil: "load" }); await pageReady(page); await pause(page, 2500);
    console.log(`video ${label} recorded`);
  } catch (e) { console.log(`video ${label} FAILED ${String(e).slice(0, 300)}`); }
  await ctx.close();
  const f = readdirSync(dir).find((x) => x.endsWith(".webm")); if (f) renameSync(join(dir, f), join(out, `acceptance-${label}.webm`));
}
await browser.close();
console.log("SHOTS-DONE");

// --pw hr-policies.spec.ts[,…]: run browser specs against this server in the same slot (asynchronous: this process also
// serves the API the pages read). Identities the fixture does not know reach the mock unchanged. Playwright empties
// tests/e2e/test-results first: keep --out elsewhere.
const specs = (opt("pw", "") ?? "").split(",").filter((x) => /^[\w.-]+\.spec\.ts$/.test(x));
if (specs.length) {
  const code = await new Promise((ok) => {
    const run = spawn("bash", ["-c", `npx playwright test ${specs.join(" ")} --workers=1 --reporter=line 2>&1 | tail -60`], { cwd: here, env: { ...process.env, PULSE_BASE_URL: `http://127.0.0.1:${webPort}` } });
    run.stdout.on("data", (d) => process.stdout.write(d)); run.stderr.on("data", (d) => process.stdout.write(d)); run.on("close", ok);
  });
  console.log(`PW-DONE ${code}`);
}
process.exit(0);
