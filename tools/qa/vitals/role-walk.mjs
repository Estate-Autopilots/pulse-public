#!/usr/bin/env node
// QA-2 (QA system stage 1, step 6; research §4.2 and §4.5): the role walk. Signs in as each synthetic person of the QA
// company (QA-1's tools/admin/qa-org.py; never a real person), opens every item of that person's own menu, and fails
// on what a person would hit: a refusal page ("Not part of your access", "This view is unavailable", Page not found),
// a blank page, a script error, a failed request, a sign-in wall, junk on screen ("undefined", "NaN", "[object Object]",
// "Invalid Date") or a page wider than the window. Home must open for every role. The operator console must be out of
// reach of every customer role. Signed out, staff pages must lead to sign-in. The AI employee's key must work on its
// own tools (MCP tools/list and each read-only tool that needs no input) and never as a person.
//
//   node tools/qa/vitals/role-walk.mjs --env dev  [--roles owner,seller] [--out DIR] [--width 1440] [--theme light]
//   node tools/qa/vitals/role-walk.mjs --env prod --mode monitor        (the 15-minute production monitor: main screens)
//
// Read only: the browser holds every request that is not GET/HEAD/OPTIONS (answered 204 and counted as "held", never sent), and
// sign-in/sign-out are the only writes (made here, outside the browser). The browser runs on nivi (nivi-browser.mjs;
// QA_BROWSER=local runs it here); dev's pages are fetched from ea's own dev server (dev.vitalsos.ai is behind Access).
// Credentials: ~/.config/vitals-qa/<env>.json (mode 600, written by qa-org.py); never printed.
// Output: <out>/role-walk.json (every page), <out>/summary.txt; stdout: the summary only. Exit 0 all good, 1 findings,
// 2 could not run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { qaBrowser } from "./nivi-browser.mjs";
import { JUNK, REFUSAL, STAFF, parseArgs, probe, vitalsEnv } from "./vitals-env.mjs";

const args = parseArgs(process.argv.slice(2));
const ENV = args.env || "dev";
const MODE = args.mode || "walk";
const WIDTH = Number(args.width || 1440);
const THEME = args.theme || "light";
const PHONE = WIDTH < 700;
const OUT = args.out || path.join(os.homedir(), ".local/state/vitals-qa", `${MODE}-${ENV}`, new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
const V = vitalsEnv(ENV, { credentials: args.credentials });
const { creds, ORIGIN, HOSTNAME, call, signIn, signOut } = V;
const ROLES = (args.roles || (MODE === "monitor" ? "owner,seller" : [...STAFF, "client", "agent"].join(","))).split(",").map((s) => s.trim()).filter(Boolean);
// The monitor opens these where the role's own menu has them (plus home), not the whole menu.
const MAIN = ["/tasks", "/chats", "/people", "/erp", "/finance", "/hr", "/calendar", "/docs", "/sales", "/dashboard"];
fs.mkdirSync(OUT, { recursive: true });
const log = (m) => process.stderr.write(`${m}\n`);

// ---- the browser: reads only (every write held); dev fed from ea ----
async function newContext(browser, jar) {
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: PHONE ? 844 : 900 }, colorScheme: THEME, deviceScaleFactor: 1, ...(PHONE ? { hasTouch: true, isMobile: true } : {}) });
  const held = await V.routeContext(ctx);
  await V.addSession(ctx, jar);
  await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); localStorage.setItem("pulse.notify.browser.asked", "1"); } catch { /* storage off */ } }, THEME);
  return { ctx, held };
}

async function openPage(page, href, sink) {
  sink.errors = []; sink.failed = [];
  const t0 = Date.now();
  let status = null;
  try {
    const resp = await page.goto(ORIGIN + href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    status = resp?.status() ?? null;
  } catch (e) { return { href, ok: false, problems: [`did not load: ${String(e.message).split("\n")[0].slice(0, 100)}`], ms: Date.now() - t0 }; }
  await page.waitForFunction(() => { const m = document.querySelector("main") || document.body; return m && m.innerText.trim().length > 30; }, null, { timeout: 20_000 }).catch(() => null);
  await page.waitForLoadState("networkidle", { timeout: 2_500 }).catch(() => null);
  await page.waitForTimeout(300);
  const p = await page.evaluate(probe).catch(() => ({ text: "", textLen: 0, head: "", overflowX: 0 }));
  const final = new URL(page.url());
  const problems = [];
  if (status && status >= 400) problems.push(`page answered ${status}`);
  if (/^\/(login|portal\/login|sign-in)/.test(final.pathname) && !/^\/(login|portal)/.test(href)) problems.push("sent to sign-in");
  const refusal = REFUSAL.exec(p.text);
  if (refusal) problems.push(`refusal: "${(p.text.match(new RegExp(`[^.]{0,40}${refusal[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^.]{0,40}`)) || [refusal[0]])[0].trim()}"`);
  if (p.textLen < 20) problems.push("blank page");
  const junk = JUNK.exec(p.text);
  if (junk) problems.push(`junk on screen: "${(p.text.slice(Math.max(0, junk.index - 30), junk.index + 30)).trim()}"`);
  if (p.overflowX > 2) problems.push(`page ${p.overflowX}px wider than the window`);
  for (const e of sink.errors.slice(0, 3)) problems.push(`script error: ${e}`);
  for (const f of sink.failed.slice(0, 3)) problems.push(`request failed: ${f}`);
  return { href, final: final.pathname + final.search, head: p.head, ok: problems.length === 0, problems, ms: Date.now() - t0 };
}

// The person's own menu: the main strip (the sections) and the side menu of the section that is open, every group
// unfolded. A section's own pages show in the side menu once the section is open, so the walk opens each section and
// reads its menu again (pages inside a section do not change the menu).
async function menuOf(page, unfold = true) {
  if (PHONE) return [];
  if (unfold) {
    // One pass over the folded groups (a click that does not open one is not retried).
    const heads = await page.locator('aside[aria-label="Pulse navigation"] button[data-nav-id^="group:"][aria-expanded="false"]').all();
    for (const h of heads.slice(0, 15)) await h.click({ timeout: 2_000 }).catch(() => null);
    if (heads.length) await page.waitForTimeout(300);
  }
  const links = await page.$$eval('aside[aria-label="Pulse navigation"] a[href^="/"]', (as) => as.map((a) => ({
    href: a.getAttribute("href"), section: !!a.closest('nav[aria-label="Main sections"]'),
    label: (a.querySelector("span")?.innerText || a.getAttribute("aria-label") || a.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60) })));
  const seen = new Set(); const out = [];
  for (const l of links) { if (!l.href || seen.has(l.href)) continue; seen.add(l.href); out.push(l); }
  return out;
}

async function walkStaff(browser, role) {
  const res = { role, kind: "staff", pages: [], checks: [] };
  const s = await signIn(role);
  if (s.error) { res.checks.push({ name: "sign-in", ok: false, detail: s.error }); return res; }
  res.checks.push({ name: "sign-in", ok: true });
  try {
    const me = await call("/api/v0/me", { cookies: { pulse_session: s.jar.pulse_session } });
    res.me = { role: me.json?.role, salesSeat: me.json?.salesSeat, lead: me.json?.lead };
    // Operator console: never for a customer role (the API's own answer, and the page)
    const op = !!(me.json?.platformAdmin || me.json?.platformConsole);
    res.checks.push({ name: "no operator console (me)", ok: me.status === 200 && !op, detail: me.status !== 200 ? `me ${me.status}` : op ? "platformAdmin or platformConsole is on" : "" });
    if (ENV === "dev") {
      const ho = await call("/api/v0/auth/admin-handoff", { body: {}, cookies: { pulse_session: s.jar.pulse_session } });
      res.checks.push({ name: "no operator console (hand-off refused)", ok: ho.status >= 400, detail: `admin-handoff ${ho.status}` });
    }
    const { ctx, held } = await newContext(browser, s.jar);
    const page = await ctx.newPage();
    const sink = { errors: [], failed: [] };
    page.on("pageerror", (e) => sink.errors.push(String(e.message).split("\n")[0].slice(0, 120)));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR_ABORTED|net::ERR_FAILED/.test(m.text())) sink.errors.push(m.text().split("\n")[0].slice(0, 120)); });
    page.on("response", (r) => { const u = new URL(r.url()); if (u.host === HOSTNAME && r.status() >= 400 && u.pathname.startsWith("/api/")) sink.failed.push(`${r.status()} ${u.pathname}`); });
    // Home
    const home = await openPage(page, "/", sink);
    home.label = "Home"; res.pages.push(home);
    res.checks.push({ name: "home opens", ok: home.ok, detail: home.ok ? home.final : home.problems.join("; ") });
    const menu = await menuOf(page, MODE !== "monitor");
    res.checks.push({ name: "operator console not in the menu", ok: !menu.some((m) => m.href === "/admin" || m.href.startsWith("/admin/")), detail: "" });
    // Breadth first: each section's own pages show in the side menu once the section is open, so every page opened adds
    // the menu items it reveals (capped; the monitor keeps to the main screens and does not follow).
    const seen = new Set(["/", home.final]);
    const queue = [];
    const add = (items) => { for (const m of items) if (!seen.has(m.href)) { seen.add(m.href); queue.push(m); } };
    add(MODE === "monitor" ? menu.filter((m) => MAIN.some((x) => m.href === x || m.href.startsWith(x + "?"))) : menu);
    const cap = Number(args.cap || 150);
    while (queue.length && res.pages.length < cap) {
      const m = queue.shift();
      const r = await openPage(page, m.href, sink);
      r.label = m.label;
      res.pages.push(r);
      log(`  ${role} ${r.ok ? "ok  " : "FAIL"} ${m.href} ${r.ms}ms${r.ok ? "" : ` ${r.problems[0]}`}`);
      if (MODE !== "monitor" && m.section && r.ok) add(await menuOf(page));
    }
    res.menu = [...seen];
    if (queue.length) res.checks.push({ name: "walk cap", ok: true, info: true, detail: `${queue.length} menu items left after ${cap} pages` });
    // The console's own address leads elsewhere (Settings), never into it.
    const adm = await openPage(page, "/admin", sink);
    res.checks.push({ name: "operator console address refused", ok: !adm.final?.startsWith("/admin"), detail: adm.final || adm.problems.join("; ") });
    res.held = [...new Set(held)].slice(0, 20); res.heldCount = held.length;
    await ctx.close();
  } finally { await signOut(s.jar); }
  return res;
}

async function walkClient(browser) {
  const res = { role: "client", kind: "client", pages: [], checks: [] };
  const v = creds.logins.client;
  const r = await call("/api/v0/portal/auth/sign-in", { body: { username: v.username, password: v.password } });
  // The portal picks its company by address: on the shared address a QA company's client cannot sign in (recorded, not a fault).
  res.checks.push({ name: "portal sign-in on the shared address", ok: true, info: true, detail: r.status === 200 ? "signed in" : `not available here (${r.status}): the client portal signs in at the company's own address` });
  if (r.status === 200 && r.jar.pulse_client_session) await call("/api/v0/portal/auth/sign-out", { body: {}, cookies: { pulse_client_session: r.jar.pulse_client_session } });
  // Signed out (a client with a link and no seat): staff pages lead to sign-in and show nothing.
  const { ctx } = await newContext(browser, null);
  const page = await ctx.newPage();
  const sink = { errors: [], failed: [] };
  for (const href of ["/dashboard", "/people", "/erp", "/finance", "/hr", "/chats", "/tasks"]) {
    await page.goto(ORIGIN + href, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => null);
    await page.waitForTimeout(800);
    const final = new URL(page.url()).pathname;
    const text = await page.evaluate(() => (document.body.innerText || "").slice(0, 3000)).catch(() => "");
    const ok = /^\/(login|portal\/login|sign-in|welcome)/.test(final) || /Sign in|Log in/i.test(text);
    res.pages.push({ href, final, ok, problems: ok ? [] : [`signed out, ${href} did not lead to sign-in (${final})`], label: "signed out" });
  }
  void sink;
  await ctx.close();
  return res;
}

async function walkAgent() {
  const res = { role: "agent", kind: "agent", pages: [], checks: [], tools: [] };
  const key = creds.logins.agent.key;
  const H = { authorization: `Bearer ${key}`, accept: "application/json, text/event-stream" };
  const rpc = async (method, params, id) => {
    const r = await call("/api/v1/mcp", { body: { jsonrpc: "2.0", id, method, params }, headers: H });
    const line = (r.text.match(/^data: (.*)$/m) || [])[1];
    let j = r.json; try { if (line) j = JSON.parse(line); } catch { /* keep */ }
    return { status: r.status, j };
  };
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitals-qa-2", version: "1" } }, 1);
  res.checks.push({ name: "MCP initialize with the AI employee's key", ok: init.status === 200 && !!init.j?.result, detail: `${init.status}` });
  const list = await rpc("tools/list", {}, 2);
  const tools = list.j?.result?.tools || [];
  res.checks.push({ name: "MCP tools/list", ok: tools.length > 0, detail: `${tools.length} tools` });
  // Each read-only tool that needs no input, as the agent (a refusal or a tool error is a finding).
  const readable = tools.filter((t) => t.annotations?.readOnlyHint && !(t.inputSchema?.required || []).length).slice(0, 40);
  let id = 10;
  for (const t of readable) {
    const r = await rpc("tools/call", { name: t.name, arguments: {} }, id++);
    const isErr = r.status !== 200 || !!r.j?.error || r.j?.result?.isError === true;
    const msg = isErr ? String(r.j?.error?.message || r.j?.result?.content?.[0]?.text || r.status).replace(/\s+/g, " ").slice(0, 140) : "";
    // A 403 with its reason is the tool refusing this AI employee by role: grouped below as one finding (the tools
    // list offers it a tool it may not use), not one per tool.
    const refused = isErr && /"status":403|Forbidden/.test(msg);
    res.tools.push({ name: t.name, ok: !isErr || refused, refused, detail: msg });
  }
  const offered = res.tools.filter((t) => t.refused).map((t) => t.name);
  res.checks.push({ name: "every tool offered to it works for it", ok: !offered.length, detail: offered.length ? `${offered.length} offered but refused by role: ${offered.join(", ")}` : "" });
  // Never as a person: the key on a person's route is refused.
  const me = await call("/api/v0/me", { headers: { "x-pulse-agent-key": key } });
  res.checks.push({ name: "the key is not a person's sign-in", ok: me.status === 401 || me.status === 403 || (me.status === 200 && !me.json?.person), detail: `me ${me.status}` });
  return res;
}

// ---- run ----
const t0 = Date.now();
let qb;
const results = [];
const save = () => fs.writeFileSync(path.join(OUT, "role-walk.json"), JSON.stringify({ env: ENV, mode: MODE, width: WIDTH, theme: THEME, origin: ORIGIN, org: creds.org.handle, at: new Date().toISOString(), browser: qb?.where, results }, null, 1));
// Stopped from outside (a timeout, systemd): close the nivi browser first, so its slot is freed at once.
for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, async () => { save(); if (qb) await qb.close(); process.exit(143); });
try {
  const needBrowser = ROLES.some((r) => r !== "agent");
  if (needBrowser) qb = await qaBrowser({ ttl: MODE === "monitor" ? 600 : 3600, slot: MODE !== "monitor", log });
  for (const role of ROLES) {
    log(`walking ${role}`);
    try {
      if (STAFF.includes(role)) results.push(await walkStaff(qb.browser, role));
      else if (role === "client") results.push(await walkClient(qb.browser));
      else if (role === "agent") results.push(await walkAgent());
      else results.push({ role, checks: [{ name: "known role", ok: false, detail: "no such role" }], pages: [] });
    } catch (e) { results.push({ role, checks: [{ name: "walk finished", ok: false, detail: String(e.message).split("\n")[0].slice(0, 160) }], pages: [] }); }
    save(); // after every role: a run cut short keeps what it walked
  }
} catch (e) {
  fs.writeFileSync(path.join(OUT, "summary.txt"), `could not run: ${e.message}\n`);
  console.log(`role walk (${ENV}, ${MODE}): could not run: ${String(e.message).split("\n")[0]}`);
  process.exit(2);
} finally { if (qb) await qb.close(); }

const lines = [];
let bad = 0;
for (const r of results) {
  const pagesBad = r.pages.filter((p) => !p.ok);
  const checksBad = r.checks.filter((c) => !c.ok);
  const toolsBad = (r.tools || []).filter((t) => !t.ok);
  bad += pagesBad.length + checksBad.length + toolsBad.length;
  const tail = r.kind === "agent" ? `${(r.tools || []).length - toolsBad.length}/${(r.tools || []).length} tools` : `${r.pages.length - pagesBad.length}/${r.pages.length} pages`;
  lines.push(`${pagesBad.length + checksBad.length + toolsBad.length ? "FAIL" : "ok  "} ${r.role.padEnd(10)} ${tail}, ${r.checks.length - checksBad.length}/${r.checks.length} checks${r.heldCount ? `, ${r.heldCount} writes held` : ""}`);
  for (const c of checksBad) lines.push(`     check ${c.name}: ${c.detail}`);
  for (const c of r.checks.filter((c) => c.info)) lines.push(`     note  ${c.name}: ${c.detail}`);
  for (const p of pagesBad) lines.push(`     ${p.href}${p.label ? ` (${p.label})` : ""}: ${p.problems.join("; ")}`);
  for (const t of toolsBad) lines.push(`     tool ${t.name}: ${t.detail}`);
}
const head = `role walk ${ENV} ${MODE} ${WIDTH}px ${THEME}, browser ${qb?.where || "none"}, ${Math.round((Date.now() - t0) / 1000)}s: ${bad ? `${bad} findings` : "all good"}`;
const summary = [head, ...lines].join("\n");
save();
fs.writeFileSync(path.join(OUT, "summary.txt"), summary + "\n");
console.log(summary);
console.log(`(details: ${path.join(OUT, "role-walk.json")})`);
process.exit(bad ? 1 : 0);
