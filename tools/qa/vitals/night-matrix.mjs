#!/usr/bin/env node
// QA-2 (QA system stage 1, step 7; research §4.1 L3 and §4.3): Vitals' share of the night matrix. Every screen a QA
// person's menu opens (from tonight's role walk) × the standard states, on dev, with the browser on nivi, until the
// deadline (01:00 UTC). Each screen is checked as the least-privileged QA person whose menu has it (seller first, owner
// last), then by a second role where time allows.
//
//   node tools/qa/vitals/night-matrix.mjs --walk <role-walk.json> [--until 01:00] [--out DIR] [--states standard|corners]
//
// The checks are QA-1's Readability Gate (tests/e2e/readability-gate.mjs: R1-R15 + axe) when this checkout has it;
// otherwise the role walk's own page checks (refusal, blank, junk, sideways overflow, script errors, failed requests).
// Read only (every write held). Output: <out>/matrix.json (findings with fingerprints) and <out>/summary.txt.
// Speed: animations are made to end at once and live streams are answered empty (10-17 s a screen-state with the gate).
// Order: every screen at the corner states first, then the rest of the standard states, then the second role, so a
// short night still covers every screen at its worst states.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaBrowser } from "./nivi-browser.mjs";
import { JUNK, REFUSAL, STAFF, parseArgs, probe, vitalsEnv } from "./vitals-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const V = vitalsEnv("dev", { credentials: args.credentials });
const OUT = args.out || path.join(os.homedir(), ".local/state/vitals-qa/night", new Date().toISOString().slice(0, 10));
fs.mkdirSync(OUT, { recursive: true });
const until = (() => { const [h, m] = String(args.until || "01:00").split(":").map(Number); const d = new Date(); d.setUTCHours(h, m, 0, 0); if (d <= new Date()) d.setUTCDate(d.getUTCDate() + 1); return d; })();
const deadline = args.minutes ? Date.now() + Number(args.minutes) * 60_000 : until.getTime();

// States (research §4.3). Corners first: (360, dark, 130%), (360, light, 100%), (1280, light), (1280, dark).
const CORNER = ["360-dark-130", "360-light", "1280-light", "1280-dark"];
const REST = ["360-dark", "360-light-130", "412-light", "412-dark", "412-light-130", "412-dark-130", "768-light", "1440-light"];
const STATES = args.states === "corners" ? CORNER : [...CORNER, ...REST];
const stateOf = (name) => { const m = /^(\d+)-(light|dark)(?:-(\d+))?$/.exec(name); const width = Number(m[1]); return { name, width, height: width < 600 ? 800 : 900, theme: m[2], text: m[3] ? Number(m[3]) / 100 : 1 }; };
// The least-privileged first: a screen is checked as someone who should see it, not only as the owner.
const ORDER = ["seller", "sales_head", "hr", "finance", "admin", "owner"];

// QA-1's gate, when this checkout has it.
let gate = null;
for (const f of [path.resolve(here, "../../../tests/e2e/readability-gate.mjs"), "/home/eadev/work/pulse/strike/tests/e2e/readability-gate.mjs"]) {
  if (!fs.existsSync(f)) continue;
  // A module namespace cannot take a new property: copy it, so the checkout's own gate is used and matrix.json names it.
  try { gate = { ...(await import(pathToFileURL(f).href)), file: f }; break; } catch (e) { process.stderr.write(`gate ${f}: ${e.message.split("\n")[0]}\n`); }
}

// Screens from tonight's walk: route -> the roles whose walk opened it cleanly.
const walk = JSON.parse(fs.readFileSync(args.walk, "utf8"));
const seenBy = new Map();
for (const r of walk.results || []) {
  if (!STAFF.includes(r.role)) continue;
  for (const p of r.pages || []) {
    if (!p.ok || !p.final || /^\/(login|portal)/.test(p.final)) continue;
    const route = p.href;
    if (!seenBy.has(route)) seenBy.set(route, new Set());
    seenBy.get(route).add(r.role);
  }
}
const routes = [...seenBy.keys()].sort();
const first = (route) => ORDER.find((r) => seenBy.get(route).has(r));
const second = (route) => [...ORDER].reverse().find((r) => seenBy.get(route).has(r) && r !== first(route));
// Jobs: (role, state) -> routes. Pass 1 corners, pass 2 the rest, pass 3 the second role's corners.
const passes = [];
for (const [states, pick] of [[CORNER.filter((s) => STATES.includes(s)), first], [REST.filter((s) => STATES.includes(s)), first], [CORNER.filter((s) => STATES.includes(s)), second]]) {
  for (const s of states) for (const role of ORDER) {
    const rs = routes.filter((rt) => pick(rt) === role);
    if (rs.length) passes.push({ role, state: s, routes: rs });
  }
}

// Fallback checks (no gate): the walk's own, per state.
async function fallbackAudit(ctx, url) {
  const page = await ctx.newPage();
  const findings = [];
  page.on("pageerror", (e) => findings.push({ rule: "R11", where: "page", detail: `script error: ${e.message.slice(0, 140)}`, kind: "certain" }));
  page.on("response", (r) => { const u = new URL(r.url()); if (u.host === V.HOSTNAME && r.status() >= 500) findings.push({ rule: "R11", where: u.pathname, detail: `request failed: HTTP ${r.status()}`, kind: "certain" }); });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(() => { const m = document.querySelector("main") || document.body; return m && m.innerText.trim().length > 30; }, null, { timeout: 20_000 }).catch(() => null);
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => null);
    const p = await page.evaluate(probe);
    if (REFUSAL.test(p.text)) findings.push({ rule: "R11", where: "main", detail: `refusal: ${REFUSAL.exec(p.text)[0]}`, kind: "certain" });
    if (p.textLen < 20) findings.push({ rule: "R11", where: "main", detail: "blank page", kind: "certain" });
    const j = JUNK.exec(p.text); if (j) findings.push({ rule: "R10", where: "main", detail: `junk: ${p.text.slice(Math.max(0, j.index - 20), j.index + 20)}`, kind: "certain" });
    if (p.overflowX > 2) findings.push({ rule: "R1", where: "page", detail: `${p.overflowX}px wider than the window`, kind: "certain" });
  } catch (e) { findings.push({ rule: "R11", where: "page", detail: `did not load: ${String(e.message).split("\n")[0].slice(0, 100)}`, kind: "certain" }); }
  await page.close().catch(() => {});
  return { findings, errors: [] };
}
const fp = (route, f) => [route.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id"), f.rule, String(f.where ?? "").replace(/\d+/g, "#").slice(0, 80)].join(" | ");

const log = (m) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const t0 = Date.now();
const findings = new Map(); // fingerprint (no state) -> finding with states/roles
const done = []; let audits = 0, stopped = false;
let qb;
const sessions = {};
for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, async () => { if (qb) await qb.close(); for (const s of Object.values(sessions)) if (s.jar) await V.signOut(s.jar); process.exit(143); });
try {
  qb = await qaBrowser({ ttl: Math.max(600, Math.round((deadline - Date.now()) / 1000) + 900), slot: true, log });
  log(`matrix: ${routes.length} screens, ${passes.length} role/state jobs, gate ${gate ? "QA-1 readability gate" : "fallback (walk checks)"}, browser ${qb.where}`);
  for (const job of passes) {
    if (Date.now() > deadline) { stopped = true; break; }
    if (!sessions[job.role]) { const s = await V.signIn(job.role); if (s.error) { log(`${job.role}: ${s.error}`); sessions[job.role] = { error: s.error }; } else sessions[job.role] = s; }
    if (sessions[job.role].error) continue;
    const st = stateOf(job.state);
    const ctx = gate
      ? await gate.gateContext(qb.browser, { base: V.ORIGIN, session: sessions[job.role].jar.pulse_session, state: { ...st, text: st.text } })
      : await qb.browser.newContext({ viewport: { width: st.width, height: st.height }, colorScheme: st.theme, deviceScaleFactor: 1, ...(st.width < 600 ? { isMobile: true, hasTouch: true } : {}) });
    await V.routeContext(ctx); // after the gate's own route: this one answers first (dev fed from ea, writes held)
    await V.addSession(ctx, sessions[job.role].jar);
    await ctx.addInitScript((t) => { try { localStorage.setItem("pulse.theme", t); localStorage.setItem("pulse.notify.browser.asked", "1"); } catch { /* off */ } }, st.theme);
    // Animations end at once (their end state is what the checks measure): the gate's settle waits for every finite
    // animation, and the "new" dots run 7 rounds, several times a screen: 60 s a screen on nivi's software renderer,
    // 10-17 s with this (the same findings; QA-2, 18 Nov).
    await ctx.addInitScript(() => { document.addEventListener("DOMContentLoaded", () => { const el = document.createElement("style"); el.dataset.qa = "fast-motion";
      el.textContent = "*,*::before,*::after{animation-duration:1ms!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:1ms!important;transition-delay:0s!important}";
      document.head.append(el); }); });
    for (const route of job.routes) {
      if (Date.now() > deadline) { stopped = true; break; }
      const res = gate ? await gate.auditScreen(ctx, V.ORIGIN + route, { state: st, axe: true, timeout: 60_000 }).catch((e) => ({ findings: [{ rule: "R11", where: "page", detail: `audit failed: ${String(e.message).slice(0, 100)}`, kind: "certain" }] }))
        : await fallbackAudit(ctx, V.ORIGIN + route);
      audits++;
      for (const f of res.findings || []) {
        const key = fp(route, f);
        const cur = findings.get(key) || { fingerprint: key, route, rule: f.rule, where: f.where, detail: f.detail, kind: f.kind || "certain", states: [], roles: [] };
        if (!cur.states.includes(job.state)) cur.states.push(job.state);
        if (!cur.roles.includes(job.role)) cur.roles.push(job.role);
        findings.set(key, cur);
      }
    }
    await ctx.close().catch(() => {});
    done.push(`${job.role}@${job.state}`);
    log(`done ${job.role}@${job.state} (${job.routes.length} screens; ${audits} audits, ${findings.size} distinct findings)`);
  }
} finally {
  for (const s of Object.values(sessions)) if (s.jar) await V.signOut(s.jar);
  if (qb) await qb.close();
}
const list = [...findings.values()].sort((a, b) => (a.kind === "certain" ? 0 : 1) - (b.kind === "certain" ? 0 : 1) || b.states.length * b.roles.length - a.states.length * a.roles.length);
const certain = list.filter((f) => f.kind === "certain").length;
const head = `night matrix dev: ${routes.length} screens, ${audits} screen-states in ${Math.round((Date.now() - t0) / 60000)} min${stopped ? " (stopped at the deadline)" : ""}, ${list.length} distinct findings (${certain} certain), checks: ${gate ? "readability gate" : "walk checks"}`;
fs.writeFileSync(path.join(OUT, "matrix.json"), JSON.stringify({ at: new Date().toISOString(), env: "dev", gate: gate?.file || null, browser: qb?.where, routes: routes.length, audits, stopped, jobsDone: done, jobsTotal: passes.length, findings: list }, null, 1));
const summary = [head, ...list.slice(0, 15).map((f) => `  ${f.kind === "certain" ? "!" : "-"} ${f.route} ${f.rule} ${String(f.detail).slice(0, 90)} [${f.states.length} states, ${f.roles.join("/")}]`)].join("\n");
fs.writeFileSync(path.join(OUT, "summary.txt"), summary + "\n");
console.log(summary);
