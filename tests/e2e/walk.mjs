// Persona walkthrough helper for live checks against pulse-dev (127.0.0.1:3200).
//   node walk.mjs <WxH> <light|dark> <identity> <out-prefix> <path> [<path> ...]
// identity: an Access e-mail (admin@…, hr@…) or "session:<token>" for a Pulse password session. pulse-dev sits behind
// Cloudflare Access, so a password user still arrives with an Access identity (ACCESS_AS, default an outside address).
// For each path: screenshot to /tmp/shots/<out-prefix>-<n>.png and print console errors, page errors and
// failed requests (HTTP >= 400 or aborted), so a page that renders but whose data calls fail is still caught.
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

export async function persona({ size = "1536x730", theme = "light", identity = "admin@estateautopilots.com", base = "http://127.0.0.1:3200" } = {}) {
  const [width, height] = size.split("x").map(Number);
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const phone = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, isMobile: phone, hasTouch: phone, deviceScaleFactor: 1 });
  const gate = identity.startsWith("session:") || !identity ? process.env.ACCESS_AS ?? "user-e294a776@gmail.com" : identity;
  if (identity.startsWith("session:")) await ctx.addCookies([{ name: "pulse_session", value: identity.slice(8), url: base }]);
  await ctx.route("**/*", (route) => {
    const headers = { ...route.request().headers() };
    if (route.request().url().startsWith(base)) headers["cf-access-authenticated-user-email"] = gate;
    return route.continue({ headers });
  });
  await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); } catch {} }, theme);
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror ${e.message.slice(0, 240)}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console ${m.text().slice(0, 240)}`); });
  page.on("response", (r) => { if (r.status() >= 400 && r.url().startsWith(base)) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().slice(base.length)}`); });
  page.on("requestfailed", (r) => { const f = r.failure()?.errorText ?? ""; if (r.url().startsWith(base) && !/ERR_ABORTED/.test(f)) problems.push(`failed ${r.url().slice(base.length)} ${f}`); });
  const settle = async () => {
    await page.waitForFunction(() => document.querySelector("main h1,main h2,main h3,main [class*='__message'],form") && !document.querySelector("main [aria-busy='true']"), {}, { timeout: 45000 }).catch(() => problems.push("never settled"));
    await page.evaluate(async () => { await document.fonts.ready; }).catch(() => {});
    await page.waitForTimeout(500);
  };
  const go = async (path) => { await page.goto(base + path, { waitUntil: "networkidle", timeout: 60000 }).catch((e) => problems.push(`goto ${e.message.slice(0, 120)}`)); await settle(); };
  const shot = async (name) => { await mkdir("/tmp/shots", { recursive: true }); await page.screenshot({ path: `/tmp/shots/${name}.png` }); };
  const flush = (label) => { const out = [...new Set(problems.splice(0))]; if (out.length) console.log(`[${label}]`, out.join("\n  ")); return out; };
  return { browser, ctx, page, go, settle, shot, flush, problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [size, theme, identity, prefix, ...paths] = process.argv.slice(2);
  const p = await persona({ size, theme, identity });
  let n = 0;
  for (const path of paths) {
    await p.go(path);
    await p.shot(`${prefix}-${++n}`);
    const issues = p.flush(path);
    console.log(`${n} ${path}${issues.length ? "" : " ok"}`);
  }
  await p.browser.close();
}
