// READABILITY GATE at land (QA-1 step 5b): the screens a lane's diff touches, at the four corners (363 and 1440 px,
// light and dark), on the lane's own web (`next dev` of this checkout) in front of pulse-dev's API, signed in as the
// "long" QA company's owner on dev (synthetic data that only QA tools change: QA-1D's @vitalsqalong). Blocks on a
// certain finding that is not in tests/e2e/readability-baseline.json. land-gate.sh runs it when apps/web/app changed:
//
//   node tests/e2e/readability-land.mjs [--since dev/live] [--budget 120] [--hard 170] [--max-routes 4] [--out <dir>]
//     [--api http://127.0.0.1:3203] [--creds ~/.config/vitals-qa/dev-long.json] [--role owner] [--open] [--all-axe]
//     [--parallel 1]   (>1: a screen's first state alone, the rest side by side; no faster on ea's two cores, 18 Nov)
//   node tests/e2e/readability-land.mjs --routes all|/a,/b --write-baseline     (the baseline, on dev/live; no time limit)
//
// Exit 1: new certain findings (they are printed). Exit 0: none, or nothing to check, or NOT CHECKED (the server, the
// sign-in or the browser did not come up: printed as "readability: not checked: …"; week 1 never blocks a land on our
// own machinery). --budget (no screen-state starts after it) and --hard (the run stops, judging what it checked) count
// from the start, server included; screen-states left at the end are listed, not failed.
// Every browser here refuses API writes (held writes answer 204), so dev's data never changes. No session is printed.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES } from "./layout-audit.mjs";
import { AXE_BLOCKING } from "./readability-gate.mjs";
import { LAND_STATES, changedRoutes, gitFiles, launchBrowser, mergeBase, readBaseline, routesAt, runGate, statesOf, writeBaseline } from "./readability-run.mjs";

const here = dirname(fileURLToPath(import.meta.url)); const repo = join(here, "../.."); const web = join(repo, "apps/web");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(`--${k}`);
const t0 = Date.now();
// --budget: no screen-state starts later than this; --hard: the run stops here whatever it is doing, judges what it has
// checked and lists the rest as not checked. Both count from the start (server included); 0 = no limit.
const budget = Number(opt("budget", has("write-baseline") ? 0 : 120)), hard = Number(opt("hard", has("write-baseline") ? 0 : 170));
const deadline = budget > 0 ? t0 + budget * 1000 : Infinity;
const secs = () => `${Math.round((Date.now() - t0) / 1000)} s`;
const out = opt("out", "/tmp/readability-land"); mkdirSync(out, { recursive: true });
const notChecked = (why) => { console.log(`readability: not checked: ${why} (${secs()}; not blocking)`); return 0; };
/** What has been checked so far (runGate fills it), so the hard stop can still judge it. */
const progress = { records: [], fresh: [], unbaselined: [], skipped: [] };
let routes = [], states = [];
function verdict(cut) {
  writeFileSync(join(out, "readability.json"), JSON.stringify(progress.records, null, 1));
  const done = new Set(progress.records.map((r) => `${r.path} @ ${r.state}`));
  const left = cut ? routes.flatMap((p) => states.map((s) => `${p} @ ${s.name}`)).filter((k) => !done.has(k)) : progress.skipped;
  if (left.length) console.log(`readability: not checked in the time allowed (not a failure): ${left.join(", ")}`);
  console.log(`readability: ${progress.records.length} screen-states in ${secs()}${cut ? " (stopped at the time limit)" : ""}, ${progress.fresh.length} new certain finding(s)${progress.unbaselined.length ? `, ${progress.unbaselined.length} on screens with no baseline yet (not blocking)` : ""}. Report: ${join(out, "readability.json")}`);
  if (progress.fresh.length) console.log("readability: FAIL. Fix them in this lane (or, for a finding that is not a problem, mark the element [data-layout-ok] with the reason beside it).");
  return progress.fresh.length ? 1 : 0;
}

async function main() {
  const since = mergeBase(opt("since", "dev/live"));
  routes = opt("routes") === "all" ? [...ROUTES] : opt("routes") ? opt("routes").split(",").map((s) => s.trim()).filter(Boolean)
    : changedRoutes(gitFiles(since), Number(opt("max-routes", 4)), routesAt("HEAD"));
  if (!routes.length) { console.log("readability: no screen changed: nothing to check"); return 0; }
  states = statesOf(opt("states", "land"));
  console.log(`readability: ${routes.join(" ")} × ${states.map((s) => s.name).join(" ")}${budget > 0 ? ` within ${budget} s` : ""}`);

  // The QA company's sign-in (dev only: vitals-env refuses writes off dev, and these logins exist only there).
  const { vitalsEnv } = await import("../../tools/qa/vitals/vitals-env.mjs").catch(() => ({}));
  if (!vitalsEnv) return notChecked("tools/qa/vitals/vitals-env.mjs is missing");
  let V;
  try { V = vitalsEnv("dev", { credentials: opt("creds", join(homedir(), ".config/vitals-qa/dev-long.json")) }); }
  catch (e) { return notChecked(`no dev QA credentials (${String(e.message).split("\n")[0].slice(0, 80)})`); }

  // Turbopack's file cache (dist/dev/cache, ~0.6 GB) is kept outside the worktree for the next run (a rename out and
  // in): ONE slot, the last worktree's only (ea's disk is ~90% full), so a lane landing again soon compiles only what
  // changed; any other run starts cold (about a minute for the first screen on ea) and replaces it.
  const dist = join(web, ".next-readability"), cacheIn = join(dist, "dev/cache");
  const slot = join(homedir(), ".cache/pulse-readability"), cacheOut = join(slot, "turbopack"), owner = join(slot, "worktree");
  rmSync(dist, { recursive: true, force: true });
  let mine = false; try { mine = readFileSync(owner, "utf8") === repo; } catch {}
  if (mine) { try { mkdirSync(dirname(cacheIn), { recursive: true }); renameSync(cacheOut, cacheIn); console.log("readability: turbopack cache from this worktree's last run"); } catch {} }
  const port = await new Promise((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  // Its own dist dir, so a developer's or another tool's .next is never touched; next dev rewrites tsconfig.json and
  // next-env.d.ts, which are put back on exit.
  const server = spawn(join(web, "node_modules/.bin/next"), ["dev", "--disable-source-maps", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: web, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: ".next-readability", PULSE_API_URL: opt("api", "http://127.0.0.1:3203") },
  });
  let serverLog = ""; server.stdout.on("data", (d) => { serverLog = (serverLog + d).slice(-6000); }); server.stderr.on("data", (d) => { serverLog = (serverLog + d).slice(-6000); });
  // Stopped, its dist dir removed (nivi-heavy would copy it to nivi with the worktree) and next's edits put back.
  let stopped = false;
  const stop = () => {
    if (stopped) return; stopped = true;
    try { process.kill(-server.pid, "SIGKILL"); } catch {}
    if (existsSync(cacheIn)) try { rmSync(slot, { recursive: true, force: true }); mkdirSync(slot, { recursive: true }); renameSync(cacheIn, cacheOut); writeFileSync(owner, repo); } catch {}
    try { rmSync(dist, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    try { execFileSync("git", ["checkout", "--", "apps/web/tsconfig.json", "apps/web/next-env.d.ts"], { cwd: repo, stdio: "ignore" }); } catch {}
  };
  process.on("exit", stop); for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { stop(); process.exit(143); });
  /** A polite stop first (next writes its cache out on SIGTERM), at most 8 s, then the hard one. */
  const shutdown = async () => {
    if (stopped) return;
    try { process.kill(-server.pid, "SIGTERM"); } catch {}
    const end = Date.now() + 8000;
    while (server.exitCode === null && server.signalCode === null && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
    stop();
  };

  let jar = null, browser = null;
  try {
    const up = Math.min(deadline, Date.now() + 120_000);
    for (;;) {
      try { const r = await fetch(`${base}/healthz`); if (r.status < 500) break; } catch {}
      if (Date.now() > up || server.exitCode !== null) { writeFileSync(join(out, "web.log"), serverLog); return notChecked(`the lane's web did not start (log ${join(out, "web.log")})`); }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`readability: web up (${secs()})`);
    const s = await V.signIn(opt("role", "owner"));
    if (s.error) return notChecked(`QA sign-in: ${s.error}`);
    jar = s.jar;
    try { browser = await launchBrowser(); } catch (e) { return notChecked(`no browser (${String(e.message).split("\n")[0].slice(0, 80)})`); }
    const before = routesAt(since);
    const baselineFile = opt("baseline");
    if (hard > 0) {
      setTimeout(async () => {
        const code = verdict(true);
        await Promise.race([V.signOut(jar), new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
        await shutdown();
        process.exit(code);
      }, Math.max(0, t0 + hard * 1000 - Date.now())).unref();
    }
    const gate = (only) => runGate(browser, {
      base, routes: only, states, session: jar.pulse_session, baseline: readBaseline(baselineFile), deadline, existed: (p) => before.has(p), into: progress,
      // R15's popup pass (up to 4 opened a screen) is the night matrix's; --open adds it here.
      // Only the axe rules that can block (R4 contrast, R6 target size); the other axe rules are night-matrix warnings.
      axe: true, axeRules: has("all-axe") ? null : AXE_BLOCKING, open: has("open"), timeout: 100_000, parallel: Number(opt("parallel", 1)),
    });
    if (has("write-baseline")) {
      // Saved after every screen (merged), so a long run that is stopped keeps what it looked at.
      for (const path of routes) {
        const from = progress.records.length;
        await gate([path]);
        const n = writeBaseline(progress.records.slice(from), baselineFile);
        console.log(`readability: baseline: ${n.findings} findings on ${n.screens} screen-states (${secs()})`);
      }
      writeFileSync(join(out, "readability.json"), JSON.stringify(progress.records, null, 1));
      return 0;
    }
    await gate(routes);
    return verdict(false);
  } finally {
    await browser?.close().catch(() => {});
    if (jar) await V.signOut(jar);
    await shutdown();
  }
}

process.exit(await main().catch((e) => notChecked(`error: ${String(e.message ?? e).split("\n")[0].slice(0, 200)}`)));
