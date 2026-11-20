// READABILITY GATE runner (QA-1 steps 3b and 5b): screens × states through readability-gate.mjs, compared with the
// baseline, so only NEW certain findings fail.
//
//   ea-heavy node tests/e2e/readability-run.mjs --base http://127.0.0.1:3200 [--session <pulse_session> | --as <email>]
//     (or READABILITY_SESSION in the environment, so a session never shows in a process list)
//     [--routes /tasks,/people | --changed [--since dev/live]] [--states corners | land | 363-light,1440-dark,363-dark-130]
//     [--out /tmp/readability] [--baseline tests/e2e/readability-baseline.json] [--write-baseline] [--no-axe] [--no-open]
//     [--budget <seconds>]
//
// --changed: the screens a lane's diff touches (a page's folder under apps/web/app; shared components and styles: the
// smoke set), at most --max-routes. Writes <out>/readability.json (every finding) and prints one line per screen and
// state. Exit 1 when a certain finding is not in the baseline; 2 on a bad argument; 0 otherwise.
// --states land: the four corners the land gate checks (363 and 1440 px, light and dark); corners adds 363 dark at 130%.
// --budget: no screen-state starts after that many seconds; the ones left are listed as not checked (never a failure).
// --write-baseline records today's certain findings and the screen-states it looked at (merged into the file): the
// week-1 rule, only new ones block. A screen-state the baseline never looked at blocks only when its page is new
// (no page file for it at the merge base); an older one is reported as "no baseline yet".
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORNERS, RULES, auditScreen, fingerprint, gateContext, stateOf } from "./readability-gate.mjs";

const here = dirname(fileURLToPath(import.meta.url)); const repo = join(here, "../..");
export const BASELINE = join(here, "readability-baseline.json");

/** Screens every shared change is checked on (the app shell, the busiest pages). */
export const SMOKE = Object.freeze(["/dashboard", "/tasks", "/people", "/chats", "/settings"]);
/** The land gate's states: the four corners (no 130% pass; the night matrix has it). */
export const LAND_STATES = Object.freeze(CORNERS.filter((s) => s.text === 1));
export const statesOf = (spec = "corners") => (spec === "corners" ? CORNERS : spec === "land" ? LAND_STATES : spec.split(",").map((s) => stateOf(s.trim())));

/** apps/web/app/<segments>/<file> → the route's segments (route groups dropped; a dynamic or private segment ends it). */
function segmentsOf(f) {
  const m = /^apps\/web\/app\/(.+)$/.exec(f);
  if (!m) return null;
  const parts = m[1].split("/").slice(0, -1).filter((p) => !/^\(.*\)$/.test(p));
  const route = [];
  for (const p of parts) { if (p.startsWith("[") || p.startsWith("_") || p.startsWith("@")) break; route.push(p); }
  return { parts, route };
}

/** The routes a diff touches: apps/web/app/<segments>/... → /<segments> (route groups dropped; a dynamic segment ends
 * the route at its parent); shared code (components, lib, styles, the root layout) → the smoke set. With `pages` (the
 * routes that have a page, routesAt), a folder without a page of its own (tasks/views) maps to its nearest page above. */
export function changedRoutes(files, max = 8, pages = null) {
  const out = new Set();
  let shared = false;
  for (const f of files) {
    const s = segmentsOf(f);
    if (!s || !/\.(tsx?|jsx?|mjs|css)$/.test(f) || /\.test\.|\.spec\./.test(f)) continue;
    if (!s.parts.length || ["components", "lib", "ui", "hooks", "styles", "api"].includes(s.parts[0])) { shared = shared || s.parts[0] !== "api"; continue; }
    const route = [...s.route];
    if (pages) while (route.length && !pages.has(`/${route.join("/")}`)) route.pop();
    if (route.length) out.add(`/${route.join("/")}`);
  }
  if (shared) for (const r of SMOKE) out.add(r);
  return [...out].slice(0, max);
}

/** The routes that have a page (or a page under a dynamic segment) in a list of files: what existed at a commit. */
export function pageRoutes(files) {
  const out = new Set();
  for (const f of files) {
    if (!/\/page\.(tsx?|jsx?|mdx?)$/.test(f)) continue;
    const s = segmentsOf(f);
    if (s) out.add(`/${s.route.join("/")}`);
  }
  return out;
}

const git = (argv) => execFileSync("git", argv, { cwd: repo, encoding: "utf8", maxBuffer: 1 << 26 });
export const mergeBase = (since = "dev/live") => git(["merge-base", "HEAD", since]).trim();
export const gitFiles = (base) => git(["diff", "--name-only", base, "HEAD"]).split("\n").filter(Boolean);
export const routesAt = (commit) => pageRoutes(git(["ls-tree", "-r", "--name-only", commit, "apps/web/app"]).split("\n"));

/** A fingerprint without its state: `path | rule | where`. */
const stateless = (fp) => { const [path, , ...rest] = fp.split(" | "); return [path, ...rest].join(" | "); };
/** `rule | where` alone: the same element on any screen (the app shell's nav and header are on every one). */
const shellOf = (fp) => fp.split(" | ").slice(2).join(" | ");
/**
 * Is a finding known to the baseline? Its exact fingerprint; or the same screen, rule and element at any other state;
 * or the same rule and element on two or more screens of the baseline (the shell: the phone nav's "New: 9+" badge
 * shows on whichever screen has unread items). What shows depends on data and time as well as the code (the badges
 * came and went between runs of the same tree, 18-19 Nov), and a block on such a finding would be noise. The cost: a
 * change that makes an already-flagged element worse in another state, or adds the same tiny-text pattern a shell
 * element has, is not caught here (the night matrix still reports it).
 */
export function knownTo(baseline) {
  const keys = Object.keys(baseline.findings ?? {});
  const anyState = new Set(keys.map(stateless));
  const screens = new Map();
  for (const k of keys) { const sh = shellOf(k), path = k.split(" | ")[0]; if (!screens.has(sh)) screens.set(sh, new Set()); screens.get(sh).add(path); }
  const shell = new Set([...screens].filter(([, paths]) => paths.size >= 2).map(([sh]) => sh));
  return (fp) => !!baseline.findings?.[fp] || anyState.has(stateless(fp)) || shell.has(shellOf(fp));
}

export const readBaseline = (file = BASELINE) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { findings: {} });
export const screenKey = (path, state) => fingerprint(path, state, { rule: "", where: "" }).split(" | ").slice(0, 2).join(" | ");

/**
 * Screens × states through the gate. `existed(path)` says whether the page was there before the change (a screen-state
 * the baseline never looked at blocks only when the page is new). Returns { records, fresh, unbaselined, skipped }.
 */
export async function runGate(browser, { base, routes, states, session = "", email = "", baseline = { findings: {} }, axe = true, axeRules = null, open = true, deadline = Infinity, existed = () => true, log = console.log, timeout = 90_000, parallel = 1, into = null }) {
  // `into`: the caller's object, filled as screens finish (a caller that stops early still has what was checked).
  const acc = into ?? {}; for (const k of ["records", "fresh", "unbaselined", "skipped"]) acc[k] ??= [];
  const { records, fresh, unbaselined, skipped } = acc;
  const looked = baseline.screens ? new Set(baseline.screens) : null, known = knownTo(baseline);
  const audit = async (path, state) => {
    const ctx = await gateContext(browser, { base, email, session, state });
    const t = Date.now();
    try { return { ...await auditScreen(ctx, base + path, { state, axe, axeRules, open, timeout }), ms: Date.now() - t }; } finally { await ctx.close(); }
  };
  // Route by route, all its states together: a page compiled for its first state is warm for the rest, and a time cut
  // leaves whole screens unchecked rather than one state everywhere. With `parallel` > 1 the first state runs alone (a
  // dev server compiles the page once) and the rest side by side, that many at a time.
  for (const path of routes) {
    const batches = parallel > 1 ? [states.slice(0, 1)] : [];
    for (let i = parallel > 1 ? 1 : 0; i < states.length; i += parallel) batches.push(states.slice(i, i + parallel));
    for (const batch of batches) {
      if (Date.now() > deadline) { skipped.push(...batch.map((s) => `${path} @ ${s.name}`)); continue; }
      const results = await Promise.all(batch.map((state) => audit(path, state)));
      batch.forEach((state, i) => note(path, state, results[i]));
    }
  }
  return acc;

  function note(path, state, { findings, errors, ms }) {
    const certain = findings.filter((f) => f.kind === "certain").map((f) => ({ ...f, fp: fingerprint(path, state.name, f) }));
    const added = certain.filter((f) => !known(f.fp));
    const blocks = !looked || looked.has(screenKey(path, state.name)) || !existed(path);
    (blocks ? fresh : unbaselined).push(...added.map((f) => ({ path, state: state.name, ...f })));
    records.push({ path, state: state.name, ms, findings, errors });
    const tag = state.text > 1 ? " (R12)" : state.theme === "dark" ? " (R13)" : "";
    const mark = added.length ? (blocks ? "✗" : "~") : errors.length ? "!" : "✓";
    log(`${mark} ${state.name}${tag} ${path}: ${certain.length} certain (${added.length} new${blocks ? "" : ", no baseline yet for this screen: not blocking"}), ${findings.length - certain.length} warnings, ${Math.round(ms / 1000)} s${errors.length ? `; ${errors.join("; ")}` : ""}`);
    for (const f of added.slice(0, 12)) log(`    ${f.rule} ${RULES[f.rule] ?? ""}: ${f.where} — ${f.detail}`);
  }
}

/** Merges a run's certain findings and the screen-states it looked at into the baseline file. */
export function writeBaseline(records, file = BASELINE) {
  const old = readBaseline(file);
  const all = { ...old.findings }, screens = new Set(old.screens ?? []);
  for (const r of records) {
    if (r.errors?.length) continue; // a screen that did not open is not "known clean"
    screens.add(screenKey(r.path, r.state));
    for (const f of r.findings) if (f.kind === "certain") all[fingerprint(r.path, r.state, f)] = { rule: f.rule, detail: String(f.detail).slice(0, 160) };
  }
  writeFileSync(file, JSON.stringify({
    note: "Readability Gate baseline (QA-1): certain findings known on the day and the screen-states looked at; only new ones block. Shrink it, never grow it by hand.",
    updated: new Date().toISOString().slice(0, 10), screens: [...screens].sort(), findings: Object.fromEntries(Object.entries(all).sort()),
  }, null, 1) + "\n");
  return { findings: Object.keys(all).length, screens: screens.size };
}

export const launchBrowser = async () => (await import("@playwright/test")).chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

async function main(args) {
  const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  const has = (k) => args.includes(`--${k}`);
  const base = (opt("base", "") || "").replace(/\/$/, "");
  if (!base) { console.error("readability: --base <url> is needed"); return 2; }
  const states = statesOf(opt("states", "corners"));
  const since = mergeBase(opt("since", "dev/live"));
  const routes = has("changed") ? changedRoutes(gitFiles(since), Number(opt("max-routes", 8)), routesAt("HEAD"))
    : (opt("routes", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!routes.length) { console.log("readability: no screen changed: nothing to check"); return 0; }
  const out = opt("out", "/tmp/readability"); mkdirSync(out, { recursive: true });
  const baselineFile = opt("baseline", BASELINE);
  const before = routesAt(since);
  const browser = await launchBrowser();
  let run;
  try {
    run = await runGate(browser, { base, routes, states, email: opt("as", ""), session: opt("session", "") || process.env.READABILITY_SESSION || "",
      baseline: readBaseline(baselineFile), axe: !has("no-axe"), open: !has("no-open"), deadline: Number(opt("budget", 0)) > 0 ? Date.now() + Number(opt("budget")) * 1000 : Infinity,
      existed: (p) => before.has(p) });
  } finally { await browser.close(); }
  writeFileSync(join(out, "readability.json"), JSON.stringify(run.records, null, 1));
  if (run.skipped.length) console.log(`readability: not checked in the time allowed (not a failure): ${run.skipped.join(", ")}`);
  if (has("write-baseline")) {
    const n = writeBaseline(run.records, baselineFile);
    console.log(`readability: baseline ${baselineFile}: ${n.findings} findings on ${n.screens} screen-states`);
    return 0;
  }
  console.log(`readability: ${run.records.length} screen-states, ${run.fresh.length} new certain finding(s)${run.unbaselined.length ? `, ${run.unbaselined.length} on screens with no baseline yet (not blocking)` : ""}. Report: ${join(out, "readability.json")}`);
  return run.fresh.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main(process.argv.slice(2)));
