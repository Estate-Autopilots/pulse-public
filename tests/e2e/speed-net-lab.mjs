// SPEED-NET lab: a page load from "India" (Chrome's network emulation: the owner's measured round trip and bandwidth),
// before and after the boot call (lib/boot.mjs), on synthetic data only: mock-editors-api.mjs behind a layer that waits
// like the server (SERVER_MS a call) and keeps the collector's own batches, and a private `next dev` (its own dist dir).
// "before" is the same page with the boot script switched off before it runs (window.__pulseBoot set first, so it returns
// at once: no boot call, no sharing layer; the HTML stays the same, so React hydrates as usual); "after" is the page as
// served. Chrome adds the round trip to every request (dev mode's script files too, which production caches); bandwidth
// is not limited by default (dev mode's scripts are several MB and uncached; production's are cached on a repeat visit).
// Measured per load: API calls that crossed the network in the first 10 s, and the app's own telemetry numbers for the
// load (nav.load, perf.boot), as production records them. Never touches pulse-dev or real data.
//   ea-heavy node tests/e2e/speed-net-lab.mjs --out <dir> [--rtt 650] [--down 0|kbit/s] [--runs 3] [--pages /whats-new,/me]
import { spawn, execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
const here = dirname(fileURLToPath(import.meta.url)); const repo = join(here, "../.."); const web = join(repo, "apps/web");
const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = opt("out", "/tmp/speed-net-lab"); mkdirSync(out, { recursive: true });
const RTT = Number(opt("rtt", "650")), DOWN = Number(opt("down", "0")), RUNS = Number(opt("runs", "3")), SERVER_MS = Number(opt("server", "30"));
const PAGES = opt("pages", "/whats-new,/me/work,/me/approvals,/erp/settings,/chats").split(",");
const IDENTITY = "admin@estateautopilots.com"; // the mock's synthetic admin

const freePort = () => new Promise((ok) => { const s = netServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const children = [];
const start = (cmd, argv, opts) => { const c = spawn(cmd, argv, { ...opts, detached: true, stdio: ["ignore", "pipe", "pipe"] }); children.push(c); let log = ""; c.stdout.on("data", (d) => { log += d; }); c.stderr.on("data", (d) => { log += d; }); c.log = () => log.slice(-3000); return c; };
const stop = () => { for (const c of children) { try { process.kill(-c.pid, "SIGTERM"); } catch {} } };
process.on("exit", stop); process.on("SIGINT", () => process.exit(130)); process.on("SIGTERM", () => process.exit(143));
const waitFor = async (url, ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return; } catch {} await new Promise((r) => setTimeout(r, 500)); } throw new Error(`timed out waiting for ${url}`); };
const mockPort = await freePort(); const apiPort = await freePort(); const webPort = await freePort();
start(process.execPath, ["tests/e2e/mock-editors-api.mjs"], { cwd: repo, env: { ...process.env, PORT: String(mockPort) } });
let batches = [];
createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "POST" && url.pathname === "/api/v0/telemetry") {
    let body = ""; req.on("data", (d) => { body += d; }); req.on("end", () => { try { batches.push(JSON.parse(body)); } catch {} res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
    return;
  }
  setTimeout(() => {
    const up = httpRequest({ host: "127.0.0.1", port: mockPort, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on("error", () => { res.writeHead(502, { "content-type": "application/json" }); res.end('{"error":"mock unavailable"}'); });
    req.pipe(up);
  }, SERVER_MS);
}).listen(apiPort, "127.0.0.1");
const webServer = start(join(web, "node_modules/.bin/next"), ["dev", "--disable-source-maps", "-p", String(webPort), "-H", "127.0.0.1"],
  { cwd: web, env: { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: ".next-speed-net", PULSE_API_URL: `http://127.0.0.1:${apiPort}` } });
const restore = () => { try { execFileSync("git", ["checkout", "--", "apps/web/tsconfig.json", "apps/web/next-env.d.ts"], { cwd: repo, stdio: "ignore" }); } catch {} };
process.on("exit", restore);
await waitFor(`http://127.0.0.1:${mockPort}/api/v0/me`, 30000);
await waitFor(`http://127.0.0.1:${webPort}/login`, 600000).catch((e) => { console.error(webServer.log()); throw e; });
const H = { "Cf-Access-Authenticated-User-Email": IDENTITY };
for (const p of PAGES) { try { await fetch(`http://127.0.0.1:${webPort}${p}`, { headers: H, signal: AbortSignal.timeout(600000) }); } catch {} }
try { await fetch(`http://127.0.0.1:${webPort}/api/v0/boot?k=companion`, { headers: H, signal: AbortSignal.timeout(300000) }); } catch {}
console.log(`web http://127.0.0.1:${webPort}  api http://127.0.0.1:${apiPort}  rtt ${RTT} ms  down ${DOWN} kbit/s  server ${SERVER_MS} ms`);

const browser = await chromium.launch();
const results = [];
for (const mode of ["before", "after"]) {
  const ctx = await browser.newContext({ viewport: { width: 1536, height: 730 }, extraHTTPHeaders: H });
  // The boot is off in a browser driven by tests unless asked for (lib/boot.mjs); "before" switches it off outright.
  if (mode === "before") await ctx.addInitScript(() => { window.__pulseBoot = { off: true }; });
  else await ctx.addInitScript(() => { try { localStorage.setItem("pulse.boot", "on"); } catch {} });
  for (const path of PAGES) for (let run = 0; run <= RUNS; run++) {
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: RTT, downloadThroughput: DOWN > 0 ? (DOWN * 1000) / 8 : -1, uploadThroughput: DOWN > 0 ? (DOWN * 500) / 8 : -1 });
    const api = [], errors = [];
    let t0 = 0;
    page.on("request", (q) => { const u = new URL(q.url()); if (u.pathname.startsWith("/api/v0/") && u.pathname !== "/api/v0/telemetry") api.push({ at: Date.now() - t0, path: u.pathname + u.search, method: q.method() }); });
    page.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|404/.test(m.text())) errors.push(m.text().slice(0, 160)); });
    batches = [];
    t0 = Date.now();
    try {
      await page.goto(`http://127.0.0.1:${webPort}${path}`, { waitUntil: "load", timeout: 180000 });
      await page.waitForTimeout(10000);
      const boot = await page.evaluate(() => { const b = window.__pulseBoot; return b && !b.off ? { keys: b.keys, served: b.served, shared: b.shared, ms: b.t1 ? Math.round(b.t1 - b.t0) : null, late: !!b.late } : null; });
      await page.goto("about:blank"); await new Promise((r) => setTimeout(r, 1500));
      const ev = batches.flatMap((b) => b.ev ?? []);
      const load = ev.find((e) => e.k === "nav.load");
      const first10 = api.filter((a) => a.at < 10000);
      const row = { mode, path, run, apiCalls: first10.length, gets: first10.filter((a) => a.method === "GET").length, boot,
        load: load ? { d: load.d, paint: load.x?.paint, ttfb: load.x?.ttfb, api: load.x?.api, cut: load.x?.cut } : null,
        served: ev.filter((e) => e.k === "api" && e.x?.boot).length, shared: ev.filter((e) => e.k === "api" && e.x?.shared).length,
        calls: first10.map((a) => `${a.at} ${a.method} ${a.path.slice(8, 60)}`), errors: errors.slice(0, 4) };
      if (run > 0) results.push(row); // run 0 warms the browser's cache (repeat visit, like the owner's tabs)
      console.log(`${mode} ${path} run ${run}: ${row.apiCalls} API calls in 10 s, load ${row.load?.d ?? "?"} ms (paint ${row.load?.paint ?? "?"}), boot ${JSON.stringify(boot)}${errors.length ? ` ERRORS ${errors.join(" | ")}` : ""}`);
    } catch (e) { console.log(`${mode} ${path} run ${run} FAILED ${String(e).slice(0, 300)}`); results.push({ mode, path, run, error: String(e).slice(0, 300) }); }
    await page.close();
  }
  await ctx.close();
}
await browser.close();
const med = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const summary = PAGES.map((path) => Object.fromEntries([["path", path], ...["before", "after"].flatMap((m) => {
  const rows = results.filter((r) => r.path === path && r.mode === m && !r.error);
  return [[`${m}Calls`, med(rows.map((r) => r.apiCalls))], [`${m}Load`, med(rows.map((r) => r.load?.d))]];
})]));
writeFileSync(join(out, "lab.json"), JSON.stringify({ rtt: RTT, down: DOWN, server: SERVER_MS, runs: RUNS, summary, results }, null, 1));
console.table(summary);
console.log("LAB-DONE");
process.exit(0);
