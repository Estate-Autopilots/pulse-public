// HR-POLISH screenshots on synthetic data only: mock-editors-api.mjs behind a small layer that serves the busy HR
// desk in fixtures/hr-polish.mjs, and a private `next dev` (its own dist dir) pointed at it. Never touches pulse-dev.
// Run through the CPU wrapper:  ea-heavy node tests/e2e/hr-polish-shots.mjs --out <dir> [--only dashboard,leave]
//   [--widths 1440,390] [--themes light,dark] [--serve <port>] (keep the servers up and shoot on request, see below)
// Each shot also reports clipped boxes (content cut off by overflow: hidden) and sideways overflow.
import { spawn, execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
const here = dirname(fileURLToPath(import.meta.url)); const repo = join(here, "../.."); const web = join(repo, "apps/web");
const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
// --fixtures <name>: which synthetic fixture module answers in front of the mock (default HR-POLISH's); it may bring its
// own shot list (SHOTS) and identities (VARIANTS). Reloaded before each batch of shots in --serve mode.
const FIXTURES = opt("fixtures", "hr-polish");
let fx = await import(`./fixtures/${FIXTURES}.mjs`);
const out = opt("out", "/tmp/hr-polish"); mkdirSync(out, { recursive: true });
const widths = opt("widths", "1440,390").split(",").map(Number); const themes = opt("themes", "light,dark").split(",");
const only = opt("only", "")?.split(",").filter(Boolean) ?? [];
const ALL = fx.SHOTS ?? [
  ["dashboard", "/hr", "admin"], ["dashboard-quiet", "/hr", "quiet"], ["dashboard-off", "/hr", "hr"],
  ["approvals", "/hr?tab=approvals", "admin"], ["pods", "/hr?tab=pods", "admin"], ["attendance", "/hr?tab=attendance", "admin"],
  ["attendance-month", "/hr?tab=attendance&view=month", "admin"], ["attendance-totals", "/hr?tab=attendance&view=totals", "admin"],
  ["leave", "/hr?tab=leave", "admin"], ["leave-calendar", "/hr?tab=leave&view=calendar", "admin"], ["leave-balances", "/hr?tab=leave&view=balances", "admin"],
  ["requests", "/hr?tab=requests", "admin"], ["payroll", "/hr?tab=payroll", "admin"],
  ["policies", "/hr?tab=policies", "admin"], ["policies-rules", "/hr?tab=policies&view=rules", "admin"], ["policies-leave", "/hr?tab=policies&view=leave", "admin"],
  ["policies-patterns", "/hr?tab=policies&view=patterns", "admin"], ["policies-presence", "/hr?tab=policies&view=presence", "admin"], ["policies-approvals", "/hr?tab=policies&view=approvals", "admin"],
];
const SHOTS = ALL.filter(([name]) => !only.length || only.some((o) => name === o || name.startsWith(`${o}-`)));

const freePort = () => new Promise((ok) => { const s = netServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const children = [];
const start = (cmd, argv, opts) => { const c = spawn(cmd, argv, { ...opts, detached: true, stdio: ["ignore", "pipe", "pipe"] }); children.push(c); let log = ""; c.stdout.on("data", (d) => { log += d; }); c.stderr.on("data", (d) => { log += d; }); c.log = () => log.slice(-3000); return c; };
const stop = () => { for (const c of children) { try { process.kill(-c.pid, "SIGTERM"); } catch {} } };
process.on("exit", stop); process.on("SIGINT", () => process.exit(130)); process.on("SIGTERM", () => process.exit(143));
const waitFor = async (url, ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return; } catch {} await new Promise((r) => setTimeout(r, 500)); } throw new Error(`timed out waiting for ${url}`); };

const mockPort = await freePort(); const apiPort = await freePort(); const webPort = await freePort();
start(process.execPath, ["tests/e2e/mock-editors-api.mjs"], { cwd: repo, env: { ...process.env, PORT: String(mockPort) } });

// Identities `<variant>@hr-polish.test` read as the mock's synthetic admin (or HR), with the variant's HR data.
const VARIANT = { "admin@hr-polish.test": "admin", "quiet@hr-polish.test": "quiet", "hr@hr-polish.test": "hr", ...(fx.VARIANTS ?? {}) };
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const api = createServer(async (req, res) => { try { await answer(req, res); } catch (e) { console.error(e); send(res, 500, { error: String(e).slice(0, 200) }); } }).listen(apiPort, "127.0.0.1");
async function answer(req, res) {
  const url = new URL(req.url ?? "/", "http://x"); const who = String(req.headers["cf-access-authenticated-user-email"] ?? "").toLowerCase(); const variant = VARIANT[who];
  // A fixture may answer any identity's request (fixtures with `routeAny`), e.g. a plain staff member's own home.
  const anyOwn = await fx.routeAny?.(url, who, { mockPort, headers: req.headers }); if (anyOwn) return send(res, anyOwn[0], anyOwn[1]);
  if (variant) {
    const me = variant === "hr" ? "synthetic-hr" : "synthetic-admin";
    if (url.pathname === "/api/v0/hr/desk" && fx.desk) return send(res, 200, variant === "quiet" ? fx.quietDesk(me) : variant === "hr" ? { ...fx.desk(me), attendanceEnabled: false } : fx.desk(me));
    const own = fx.route?.(url, variant, me); if (own) return send(res, own[0], own[1]);
    req.headers["cf-access-authenticated-user-email"] = variant === "hr" ? "hr@estateautopilots.com" : "admin@estateautopilots.com";
  }
  const up = httpRequest({ host: "127.0.0.1", port: mockPort, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  up.on("error", () => send(res, 502, { error: "mock unavailable" })); req.pipe(up);
}

const next = start(join(web, "node_modules/.bin/next"), ["dev", "--disable-source-maps", "-p", String(webPort), "-H", "127.0.0.1"],
  { cwd: web, env: { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: ".next-polish", PULSE_API_URL: `http://127.0.0.1:${apiPort}` } });
// `next dev` with another dist dir adds it to tsconfig.json (next-env.d.ts is not tracked); put it back.
const restore = () => { try { execFileSync("git", ["checkout", "--", "apps/web/tsconfig.json"], { cwd: repo, stdio: "ignore" }); } catch {} };
process.on("exit", restore);
try { await waitFor(`http://127.0.0.1:${mockPort}/api/v0/me`, 30000); await waitFor(`http://127.0.0.1:${webPort}/login`, 120000); }
catch (e) { console.error(String(e), next.log()); process.exit(1); }
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

const browser = await chromium.launch();
/** Shoot `shots` at every width and theme into `dir`; returns the log lines. */
async function shoot(shots, widths, themes, dir, clicks = [], probe = "") {
  fx = await import(`./fixtures/${FIXTURES}.mjs?at=${Date.now()}`);
  mkdirSync(dir, { recursive: true }); const report = []; const lines = [];
  for (const [name, path, variant] of shots) for (const width of widths) for (const theme of themes) {
    const height = width < 500 ? 844 : width < 1100 ? 1024 : 900;
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1, extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": variant.includes("@") ? variant : `${variant}@hr-polish.test` } });
    await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); localStorage.setItem("theme", t); } catch {} }, theme);
    const page = await ctx.newPage(); const errors = [];
    page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
    try {
      // Not "networkidle": the shell keeps polling, so the network is never idle for long on a dev server.
      await page.goto(`http://127.0.0.1:${webPort}${path}`, { waitUntil: "load", timeout: 240000 });
      await page.waitForFunction(() => document.querySelector("main h2") && !document.querySelector('main [aria-busy="true"]'), {}, { timeout: 120000 });
      await page.waitForTimeout(1500);
      // Optional clicks (button or summary text) before the shot, e.g. to open a group.
      for (const text of clicks) { await page.locator("main").getByText(text, { exact: true }).first().click(); await page.waitForTimeout(400); }
      const audit = await page.evaluate(AUDIT);
      // `probe`: a JS expression evaluated in the page, printed with the shot (layout debugging).
      if (probe) lines.push(`probe ${name} ${width}: ${JSON.stringify(await page.evaluate(probe)).slice(0, 3000)}`);
      // Phones and tablets scroll: grow the window to the page's length so one image holds all of it.
      if (width < 1180) {
        const full = await page.evaluate(() => { let h = document.documentElement.scrollHeight; for (const el of document.querySelectorAll("body *")) { const c = getComputedStyle(el); if (/(auto|scroll)/.test(c.overflowY) && el.scrollHeight > el.clientHeight + 4) h = Math.max(h, el.scrollHeight + el.getBoundingClientRect().top); } return Math.ceil(h); });
        if (full > height) { await page.setViewportSize({ width, height: Math.min(full, 9000) }); await page.waitForTimeout(500); }
      }
      const file = join(dir, `${name}${clicks.length ? "-open" : ""}-${width}-${theme}.png`); await page.screenshot({ path: file });
      report.push({ name, width, theme, file, ...audit, errors: errors.slice(0, 4) });
      lines.push(`${name} ${width} ${theme}${audit.clipped.length ? ` CLIPPED ${audit.clipped.length}: ${audit.clipped.join(" | ")}` : ""}${audit.wide ? ` WIDE ${audit.wide}` : ""}${errors.length ? ` ERRORS ${errors.slice(0, 2).join(" | ")}` : ""}`);
    } catch (e) { report.push({ name, width, theme, error: String(e).slice(0, 300) }); lines.push(`${name} ${width} ${theme} FAILED ${String(e).slice(0, 200)}`); }
    console.log(lines.at(-1));
    await ctx.close();
  }
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 1));
  return lines;
}

// --serve <port>: keep everything up (one heavy-work slot) and shoot on request:
//   curl 'http://127.0.0.1:<port>/shoot?only=dashboard&widths=1440,390&themes=light&out=/dir&click=View%20all%2015'
const serve = opt("serve", "");
if (serve) {
  createServer(async (req, res) => {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    if (q.get("stop") !== null) { res.end("stopping\n"); stop(); setTimeout(() => process.exit(0), 2000); return; }
    // ?check: lint the changed web files, typecheck and run the web unit tests inside this slot (nested heavy work).
    if (q.get("check") !== null) {
      const sh = (cmd) => { try { return execFileSync("bash", ["-c", `${cmd} 2>&1`], { cwd: web, encoding: "utf8", maxBuffer: 1 << 24 }); } catch (e) { return `${e.stdout ?? ""}${e.stderr ?? ""}\nEXIT ${e.status}`; } };
      const files = sh("git diff --name-only HEAD -- app; git ls-files --others --exclude-standard app").split("\n").filter((f) => /\.(tsx?|mjs)$/.test(f)).map((f) => f.replace(/^apps\/web\//, ""));
      const lint = files.length ? sh(`npx eslint --max-warnings=0 ${files.join(" ")} && echo LINT OK`) : "LINT nothing changed";
      const tsc = sh("npx tsc --noEmit -p . && echo TSC OK"); const unit = sh("node --test --test-concurrency=2 app/lib/*.test.mjs | grep -E '^ℹ (tests|pass|fail)'");
      return res.end([lint, tsc, unit].map((x) => x.split("\n").filter((l) => !/npm warn/.test(l)).join("\n").trim()).join("\n") + "\n");
    }
    // ?pw=finance-live.spec.ts,finance-desk.spec.ts: run browser specs against this server inside the same slot.
    if (q.get("pw") !== null) {
      const specs = (q.get("pw") ?? "").split(",").filter((x) => /^[\w.-]+\.spec\.ts$/.test(x));
      // Asynchronous: this process also serves the API the pages read, so it must keep answering meanwhile.
      const run = spawn("bash", ["-c", `npx playwright test ${specs.join(" ")} --workers=2 --reporter=line 2>&1 | tail -60`], { cwd: here, env: { ...process.env, PULSE_BASE_URL: `http://127.0.0.1:${webPort}` } });
      let log = ""; run.stdout.on("data", (d) => { log += d; }); run.stderr.on("data", (d) => { log += d; });
      return run.on("close", (code) => res.end(`${log}\nEXIT ${code}\n`));
    }
    const pick = (q.get("only") ?? "").split(",").filter(Boolean);
    // ?path=/me/approvals&name=me-approvals&as=admin: one ad-hoc page (`as` may also be a whole address, e.g. accountant@example.test).
    const shots = q.get("path") ? [[q.get("name") ?? "page", q.get("path"), q.get("as") ?? "admin"]] : ALL.filter(([name]) => !pick.length || pick.some((o) => name === o || name.startsWith(`${o}-`)));
    try {
      const lines = await shoot(shots, (q.get("widths") ?? "1440,390").split(",").map(Number), (q.get("themes") ?? "light,dark").split(","), q.get("out") ?? out, q.getAll("click"), q.get("probe") ?? "");
      res.end(lines.join("\n") + "\n");
    } catch (e) { res.end(`FAILED ${e}\n`); }
  }).listen(Number(serve), "127.0.0.1");
  console.log(`serving shots on http://127.0.0.1:${serve}`);
} else {
  await shoot(SHOTS, widths, themes, out);
  await browser.close();
  process.exit(0);
}
