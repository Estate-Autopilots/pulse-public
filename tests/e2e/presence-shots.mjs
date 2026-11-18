// PRESENCE-ONBOARD screenshots on synthetic data only: mock-editors-api.mjs behind a small layer that serves the
// check-in day, My desk, the onboarding wizard and HR's Onboard team from fixtures/presence-onboard.mjs, and a private
// `next dev` (its own dist dir) pointed at it. Never touches pulse-dev. (Same harness as hr-polish-shots.mjs.)
// Run through the CPU wrapper:  ea-heavy node tests/e2e/presence-shots.mjs --out <dir> [--only header,welcome]
//   [--widths 1440,390] [--themes light,dark] [--serve <port>] (keep the servers up and shoot on request, see below)
// Each shot also reports clipped boxes (content cut off by overflow: hidden) and sideways overflow.
import { spawn, execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import * as fixtures from "./fixtures/presence-onboard.mjs";
// Reloaded before each batch of shots in --serve mode, so fixture edits apply without a restart.
let fx = fixtures;

const here = dirname(fileURLToPath(import.meta.url)); const repo = join(here, "../.."); const web = join(repo, "apps/web");
const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = opt("out", "/tmp/presence-onboard"); mkdirSync(out, { recursive: true });
const widths = opt("widths", "1440,390").split(",").map(Number); const themes = opt("themes", "light,dark").split(",");
const only = opt("only", "")?.split(",").filter(Boolean) ?? [];
const ALL = [
  ["header-out", "/me", "out"], ["header-arrive", "/me", "arrive"], ["header-in", "/me", "in"], ["header-break", "/me", "break"], ["header-done", "/me", "done"],
  ["me-overview", "/me", "in"], ["me-overview-new", "/me", "new"], ["me-attendance", "/me?tab=attendance", "break"], ["me-attendance-auto", "/me?tab=attendance", "done"],
  ["welcome-start", "/welcome", "new"], ["welcome-details", "/welcome?step=details", "new"], ["welcome-bank", "/welcome?step=bank", "new"], ["welcome-documents", "/welcome?step=documents", "in"],
  ["welcome-app", "/welcome?step=app", "new"], ["welcome-notifications", "/welcome?step=notifications", "new"], ["welcome-consent", "/welcome?step=consent", "new"], ["welcome-done", "/welcome?step=done", "in"],
  ["hr-onboard", "/hr?tab=onboard", "hr"], ["hr-onboard-paused", "/hr?tab=onboard", "hrpaused"], ["welcome-paused-documents", "/welcome?step=documents", "paused"], ["welcome-paused-bank", "/welcome?step=bank", "paused"], ["hr-onboard-settings", "/hr?tab=onboard&view=settings", "hr"], ["hr-onboard-kit", "/hr?tab=onboard&view=kit", "hr"],
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

// Identities `<variant>@presence.test` read as a synthetic employee (or HR) with the variant's day.
// `paused` / `hrpaused`: "new" / "hr" on a server without the document keyring (PRESENCE-2).
const VARIANTS = ["out", "arrive", "in", "break", "done", "new", "hr", "paused", "hrpaused"];
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const api = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x"); const who = String(req.headers["cf-access-authenticated-user-email"] ?? "").toLowerCase();
  const variant = VARIANTS.find((v) => who === `${v}@presence.test`);
  if (variant) {
    const base = variant === "hrpaused" ? "hr" : variant === "paused" ? "new" : variant, hr = base === "hr";
    if (url.pathname === "/api/v0/me") return send(res, 200, { email: who, person: fx.personId(base), role: hr ? "hr" : "person", name: hr ? "Synthetic HR" : "Synthetic Sam", pod: "Pod 2", username: null, photoAt: null, hrAccess: hr, via: "access" });
    if (req.method === "POST") return send(res, 200, { ok: true });
    if (url.pathname === "/api/v0/hr/work-calendar") return send(res, 404, { error: "not in this fixture" });
    const own = fx.route?.(url, base);
    if (own && variant !== base && own[1] && "filesReady" in own[1]) own[1] = { ...own[1], filesReady: false };
    if (own) return send(res, own[0], own[1]);
    req.headers["cf-access-authenticated-user-email"] = hr ? "hr@estateautopilots.com" : "editor@estateautopilots.com";
  }
  const up = httpRequest({ host: "127.0.0.1", port: mockPort, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  up.on("error", () => send(res, 502, { error: "mock unavailable" })); req.pipe(up);
}).listen(apiPort, "127.0.0.1");

const next = start(join(web, "node_modules/.bin/next"), ["dev", "--disable-source-maps", "-p", String(webPort), "-H", "127.0.0.1"],
  { cwd: web, env: { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: ".next-presence", PULSE_API_URL: `http://127.0.0.1:${apiPort}` } });
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
  fx = await import(`./fixtures/presence-onboard.mjs?at=${Date.now()}`);
  mkdirSync(dir, { recursive: true }); const report = []; const lines = [];
  for (const [name, path, variant] of shots) for (const width of widths) for (const theme of themes) {
    const height = width < 500 ? 844 : width < 1100 ? 1024 : 900;
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: 1, extraHTTPHeaders: { "Cf-Access-Authenticated-User-Email": `${variant}@presence.test` } });
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
    const pick = (q.get("only") ?? "").split(",").filter(Boolean);
    // ?path=/me/approvals&name=me-approvals&as=admin: one ad-hoc page.
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
