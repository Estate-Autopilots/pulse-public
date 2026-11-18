// LAYOUT-SWEEP preview: this worktree's `next dev` (own dist dir) in front of an API, plus the layout audit, screenshots
// and timings on request, all inside one heavy-work slot:
//
//   ea-heavy node tests/e2e/layout-serve.mjs --serve 47390 [--api http://127.0.0.1:3203] [--web 47391] [--prod]
//
//   curl '127.0.0.1:47390/sweep?routes=/me,/people&sizes=1366x768,390x844&out=/dir&shots=1'   (routes=all: every page)
//   curl '127.0.0.1:47390/shot?path=/me&sizes=1440x900,390x844&themes=light,dark&out=/dir&name=me[&full=1][&click=Text][&probe=js]'
//   curl '127.0.0.1:47390/time?path=/people/<id>?tab=documents&runs=3&ready=main%20h3'
//   curl '127.0.0.1:47390/check'    (eslint on changed web files, tsc, web unit tests)
//   curl '127.0.0.1:47390/stop'
//
// Every browser here refuses API writes (layout-audit.mjs openContext), so pointing it at pulse-dev's API reads real
// data and never changes it. `--prod` builds once (NEXT_DIST_DIR=.next-layout-build) and serves `next start`.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { ROUTES, SIZES, openContext, openRoute, settle } from "./layout-audit.mjs";
// The rules are re-read for every sweep, so a change to layout-audit.mjs applies without restarting (and re-queueing).
const rules = () => import(`./layout-audit.mjs?at=${Date.now()}`);
let cancel = false;

const here = dirname(fileURLToPath(import.meta.url)); const repo = join(here, "../.."); const web = join(repo, "apps/web");
const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const api = opt("api", "http://127.0.0.1:3203"); const prod = args.includes("--prod");
const freePort = () => new Promise((ok) => { const s = netServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const webPort = Number(opt("web", "")) || await freePort(); const base = `http://127.0.0.1:${webPort}`;
const children = [];
const start = (cmd, argv, opts) => { const c = spawn(cmd, argv, { ...opts, detached: true, stdio: ["ignore", "pipe", "pipe"] }); children.push(c); let log = ""; c.stdout.on("data", (d) => { log += d; }); c.stderr.on("data", (d) => { log += d; }); c.log = () => log.slice(-4000); return c; };
const restore = () => { try { execFileSync("git", ["checkout", "--", "apps/web/tsconfig.json"], { cwd: repo, stdio: "ignore" }); } catch {} };
const stop = () => { for (const c of children) { try { process.kill(-c.pid, "SIGTERM"); } catch {} } restore(); };
process.on("exit", stop); process.on("SIGINT", () => process.exit(130)); process.on("SIGTERM", () => process.exit(143));
const waitFor = async (url, ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return; } catch {} await new Promise((r) => setTimeout(r, 500)); } throw new Error(`timed out waiting for ${url}`); };
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", PULSE_API_URL: api };
const next = join(web, "node_modules/.bin/next");
let server, mode = prod ? "prod" : "dev", privateApi = null;
/** Starts the web server in `want` mode ("prod" builds first); stops the current one. Same slot throughout. */
async function launch(want) {
  if (server) { try { process.kill(-server.pid, "SIGTERM"); } catch {} children.splice(children.indexOf(server), 1); await new Promise((r) => setTimeout(r, 1500)); }
  mode = want;
  if (want === "prod") {
    const build = sh(`NODE_ENV=production NEXT_DIST_DIR=.next-layout-build ${next} build`);
    restore();
    if (/EXIT \d+/.test(build)) throw new Error(`build failed\n${build.slice(-3000)}`);
    server = start(next, ["start", "-p", String(webPort), "-H", "127.0.0.1"], { cwd: web, env: { ...env, NODE_ENV: "production", NEXT_DIST_DIR: ".next-layout-build" } });
  } else {
    server = start(next, ["dev", "--disable-source-maps", "-p", String(webPort), "-H", "127.0.0.1"], { cwd: web, env: { ...env, NODE_ENV: "development", NEXT_DIST_DIR: ".next-layout" } });
  }
  try { await waitFor(`${base}/healthz`, 180_000); } catch (e) { throw new Error(`${e}\n${server.log()}`); }
  console.log(`web ${base} (${want === "prod" ? "next start" : "next dev"}) → api ${api}`);
}

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const sizesOf = (q) => (q.get("sizes") ?? "").split(",").filter(Boolean).map((s) => s.split("x").map(Number));
const sh = (cmd, cwd = web) => { try { return execFileSync("bash", ["-c", `${cmd} 2>&1`], { cwd, encoding: "utf8", maxBuffer: 1 << 26, env }); } catch (e) { return `${e.stdout ?? ""}${e.stderr ?? ""}\nEXIT ${e.status}`; } };
try { await launch(mode); } catch (e) { console.error(String(e)); process.exit(1); }

// `base=` on any request points the browser at another web server (e.g. pulse-dev's own, for "before" evidence).
const baseOf = (q) => (q.get("base") ?? base).replace(/\/$/, "");
async function shot(q) {
  const base = baseOf(q);
  const out = q.get("out") ?? "/tmp/layout-shots"; mkdirSync(out, { recursive: true });
  const path = q.get("path") ?? "/dashboard", name = q.get("name") ?? path.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, ""), email = q.get("as") ?? "admin@estateautopilots.com";
  const lines = [];
  for (const [width, height] of sizesOf(q).length ? sizesOf(q) : [[1440, 900], [390, 844]]) for (const theme of (q.get("themes") ?? "light").split(",")) {
    const ctx = await openContext(browser, { base, email, width, height, theme });
    try {
      const { page, errors } = await openRoute(ctx, base + path, { timeout: 240_000 });
      for (const text of q.getAll("click")) { await page.getByRole("button", { name: text }).or(page.getByText(text, { exact: true })).first().click(); await settle(page, 500); }
      if (q.get("probe")) lines.push(`probe ${width}: ${JSON.stringify(await page.evaluate(q.get("probe"))).slice(0, 4000)}`);
      if (q.get("full") && width < 1180) {
        const full = await page.evaluate(() => { let h = document.documentElement.scrollHeight; for (const el of document.querySelectorAll("body *")) { const c = getComputedStyle(el); if (/(auto|scroll)/.test(c.overflowY) && el.scrollHeight > el.clientHeight + 4) h = Math.max(h, el.scrollHeight + el.getBoundingClientRect().top); } return Math.ceil(h); });
        if (full > height) { await page.setViewportSize({ width, height: Math.min(full, 9000) }); await settle(page, 400); }
      }
      const file = join(out, `${name}-${width}x${height}-${theme}.png`);
      await page.screenshot({ path: file });
      lines.push(`${file}${errors.length ? ` ERRORS ${errors.join(" | ")}` : ""}`);
    } catch (e) { lines.push(`${name} ${width} ${theme} FAILED ${String(e).slice(0, 300)}`); }
    await ctx.close();
  }
  return lines.join("\n");
}

/** Time to a usable view: navigation start until `ready` (a selector) is visible and nothing in main is loading. */
async function time(q) {
  const base = baseOf(q);
  const path = q.get("path") ?? "/dashboard", runs = Number(q.get("runs") ?? 3), ready = q.get("ready") ?? "main h2, main h3", email = q.get("as") ?? "admin@estateautopilots.com";
  const ctx = await openContext(browser, { base, email, width: 1440, height: 900 });
  const out = [];
  for (let i = 0; i < runs; i++) {
    const page = await ctx.newPage(); const t0 = Date.now();
    try {
      const response = await page.goto(base + path, { waitUntil: "commit", timeout: 120_000 }); const ttfb = Date.now() - t0;
      await page.locator(ready).first().waitFor({ state: "visible", timeout: 120_000 });
      await page.waitForFunction(() => !document.querySelector("main [aria-busy='true']"), {}, { timeout: 120_000 });
      out.push({ run: i + 1, status: response?.status(), ttfb, usable: Date.now() - t0 });
    } catch (e) { out.push({ run: i + 1, error: String(e).slice(0, 200) }); }
    await page.close();
  }
  await ctx.close();
  return JSON.stringify({ path, ready, runs: out });
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x"), q = url.searchParams;
  try {
    if (url.pathname === "/stop") { res.end("stopping\n"); await browser.close().catch(() => {}); stop(); setTimeout(() => process.exit(0), 1500); return; }
    if (url.pathname === "/check") {
      const files = sh("git diff --name-only HEAD -- app; git ls-files --others --exclude-standard app").split("\n").filter((f) => /\.(tsx?|mjs)$/.test(f)).map((f) => f.replace(/^apps\/web\//, ""));
      const lint = files.length ? sh(`npx eslint --max-warnings=0 ${files.join(" ")} && echo LINT OK`) : "LINT nothing changed";
      const tsc = sh("npx tsc --noEmit -p . && echo TSC OK"); restore();
      const unit = sh("node --test --test-concurrency=2 app/lib/*.test.mjs | grep -E '^ℹ (tests|pass|fail)'");
      return res.end([lint, tsc, unit].map((x) => x.split("\n").filter((l) => !/npm warn/.test(l)).join("\n").trim()).join("\n") + "\n");
    }
    // /run?task=…: a few whitelisted jobs that run inside this slot (nested heavy work inherits it).
    if (url.pathname === "/run") {
      const task = q.get("task") ?? "";
      if (task === "api-build") return res.end(sh("corepack pnpm --dir services/api run build && corepack pnpm --dir services/api run lint && echo API OK && cd services/api && node --test --test-concurrency=2 test/brand.test.mjs test/health.test.mjs test/people-work.test.mjs 2>&1 | grep -E '^(ℹ|✖|not ok)'", repo).slice(-6000) + "\n");
      if (task === "api-start") {
        if (privateApi) { try { process.kill(-privateApi.pid, "SIGTERM"); } catch {} children.splice(children.indexOf(privateApi), 1); }
        const port = Number(q.get("port") ?? 3291);
        // pulse-dev's database through this worktree's API build; no web-push key, so it runs no background delivery.
        privateApi = start("bash", ["-c", `set -a; . /etc/estate-autopilots/db/pulse_dev.env; set +a; unset PULSE_WEB_PUSH_PRIVATE_KEY_FILE PULSE_WEB_PUSH_PUBLIC_KEY; HOST=127.0.0.1 PORT=${port} exec node services/api/dist/server.js`], { cwd: repo, env: { ...process.env } });
        try { await waitFor(`http://127.0.0.1:${port}/healthz`, 60_000); return res.end(`private API on http://127.0.0.1:${port}\n`); } catch (e) { return res.end(`FAILED ${e}\n${privateApi.log()}\n`); }
      }
      if (task === "shell-check") return res.end(sh("npx tsc --noEmit -p . && echo SHELL TSC OK", join(repo, "packages/ui-shell")).slice(-4000) + "\n");
      if (task === "pw") {
        const specs = (q.get("specs") ?? "").split(",").filter((x) => /^[\w.-]+\.spec\.ts$/.test(x));
        // Managed mode (its own mock API and production build), two workers; asynchronous so this server keeps answering.
        // `built=1` reuses the last production build (only specs changed); `grep=` picks tests; the full log stays in
        // /tmp/layout-serve-pw.log.
        const grep = q.get("grep") ? ` --grep ${JSON.stringify(q.get("grep"))}` : "";
        const run = spawn("bash", ["-c", `npx playwright test ${specs.join(" ")}${grep} --workers=2 --reporter=line > /tmp/layout-serve-pw.log 2>&1; s=$?; sed 's/\x1b\[[0-9;]*[A-Za-z]//g' /tmp/layout-serve-pw.log | grep -v '^\\[' | tail -150; exit $s`], { cwd: here, env: { ...process.env, PULSE_BASE_URL: "", ...(q.get("built") ? { PULSE_WEB_BUILT: "1" } : {}), ...(q.get("shots") ? { FLOAT_SHOTS: q.get("shots") } : {}) } });
        let log = ""; run.stdout.on("data", (d) => { log += d; }); run.stderr.on("data", (d) => { log += d; });
        return run.on("close", (code) => { restore(); res.end(`${log}\nEXIT ${code}\n`); });
      }
      return res.end("tasks: api-build, api-start[&port=], shell-check, pw&specs=a.spec.ts,b.spec.ts\n");
    }
    if (url.pathname === "/restart") { await launch(q.get("mode") === "prod" ? "prod" : "dev"); return res.end(`${mode} on ${base}\n`); }
    if (url.pathname === "/shot") return res.end(await shot(q) + "\n");
    // FLOAT: every floating thing in its states, clicked for real (float-audit.mjs, re-read per request).
    if (url.pathname === "/audit") {
      const { audit } = await import(`./float-audit.mjs?at=${Date.now()}`); const lines = [];
      await audit(browser, { base: baseOf(q), out: q.get("out") ?? "/tmp/float-audit", emails: (q.get("as") ?? "admin@estateautopilots.com").split(","),
        sizes: sizesOf(q).length ? sizesOf(q) : [[1440, 900], [390, 844]], themes: (q.get("themes") ?? "light").split(","), paths: (q.get("paths") ?? "/dashboard").split(","),
        only: q.get("only") ?? undefined, log: (l) => { lines.push(l); console.log(l); } });
      return res.end(lines.join("\n") + "\n");
    }
    if (url.pathname === "/time") return res.end(await time(q) + "\n");
    if (url.pathname === "/cancel") { cancel = true; return res.end("cancelling the running sweep after this view\n"); }
    if (url.pathname === "/sweep") {
      const { sweep, recordRoutes } = await rules(); cancel = false;
      const base = baseOf(q);
      const email = q.get("as") ?? "admin@estateautopilots.com";
      const routes = q.get("routes") === "all" ? [...ROUTES, ...await recordRoutes(browser, { base, email })] : (q.get("routes") ?? "/dashboard").split(",");
      const out = q.get("out") ?? "/tmp/layout-sweep"; mkdirSync(out, { recursive: true });
      const lines = [];
      const records = await sweep(browser, { base, email, routes, sizes: sizesOf(q).length ? sizesOf(q) : SIZES, theme: q.get("theme") ?? "light", out, shots: !!q.get("shots"), warn: !!q.get("warn"), discover: !!q.get("discover"), stop: () => cancel, log: (l) => { lines.push(l); console.log(l); } });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(out, `layout-${q.get("theme") ?? "light"}.json`), JSON.stringify(records, null, 1));
      const failing = records.filter((r) => r.findings.some((f) => f.rule !== "small-text" && f.rule !== "truncated"));
      return res.end(`${lines.join("\n")}\n${records.length} views; ${failing.length} with blocking findings\n`);
    }
    res.end(`${mode} on ${base}; routes: /sweep /shot /time /check /restart?mode=dev|prod /stop\n`);
  } catch (e) { res.end(`FAILED ${String(e.stack ?? e).slice(0, 800)}\n`); }
}).listen(Number(opt("serve", "47390")), "127.0.0.1");
console.log(`control on http://127.0.0.1:${opt("serve", "47390")}`);
