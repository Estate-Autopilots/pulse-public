#!/usr/bin/env node
// DE-EA (owner, 28 Oct 2026: "make Pulse ready as a product for any company"): product code names no single company.
// A company's domain, its short name and its people's names belong in tenant or platform config, pack data or comments,
// never in a screen's words or a code default. This check counts, per file and outside comments:
//   domain  the install company's mail/web domain (estateautopilots)
//   ea      "EA" as a word ("EA-0042", "EA's own decision", "All EA accounts")
//   name    a colleague's first name (Kazuk, Datup, Posip, Savuzo): roles name people in product copy
//   pod     "Pod"/"Pods" written into web screen text (apps/web/app): the company's team word comes from its vocabulary
//           (useWords(), vocabulary(), <W k="team" />), never a word one company chose
// and fails when a file has more than tools/tenant-neutral-baseline.json allows. The baseline only shrinks: a lane that
// removes hits runs `node tools/check-tenant-neutral.mjs --update`; nobody raises a count by hand. A line that must keep
// one (an allow-listed config value, a migration-era alias) carries `tenant-neutral:allow` and a reason.
//
//   node tools/check-tenant-neutral.mjs            check (CI: tools group of tools/ci.sh)
//   node tools/check-tenant-neutral.mjs --update   rewrite the baseline to today's counts (never above the old ones)
//   node tools/check-tenant-neutral.mjs --counts   totals per signal (the DE-EA report's table)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "tools/tenant-neutral-baseline.json");
const ROOTS = ["apps/web/app", "apps/web/components", "services/api/src", "services/workers/src", "apps/mobile", "apps/desktop/src", "packages"];
const CODE = /\.(ts|tsx|mts|mjs|js|jsx|py)$/;
const SKIP = /(^|\/)(node_modules|dist|build|\.next|target|tests?|__tests__|fixtures?|e2e)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]*\.py$|\.d\.ts$/;
export const SIGNALS = {
  domain: /estateautopilots/gi,
  ea: /(?<![A-Za-z0-9_$.-])EA(?![A-Za-z0-9_$])/g,
  name: /\b(?:Kazuk|Datup|Posip|Savuzo)\b/g,
};
/** Web text only: "Pod" inside a string or after a JSX tag (not a type name such as `Pod[]`). */
const POD = /(["'`>])[^"'`<>{}]*?\bPods?\b/g;

/** The line without its comments (block comments carry over lines through `state`). Strings stay. */
export function code(line, py, state) {
  if (py) return line.replace(/(^|\s)#.*$/, "$1");
  let out = "", i = 0;
  while (i < line.length) {
    if (state.block) { const end = line.indexOf("*/", i); if (end < 0) return out; state.block = false; i = end + 2; continue; }
    const c = line[i];
    if (c === "/" && line[i + 1] === "*") { state.block = true; i += 2; continue; }
    if (c === "/" && line[i + 1] === "/" && line[i - 1] !== ":" && line[i - 1] !== "\\") return out;
    out += c; i += 1;
  }
  return out;
}

export function countFile(text, py, web = false) {
  const n = { domain: 0, ea: 0, name: 0, pod: 0 }, lines = {}; const state = { block: false };
  text.split("\n").forEach((line, i) => {
    if (line.includes("tenant-neutral:allow")) return;
    const c = code(line, py, state);
    const signals = web ? { ...SIGNALS, pod: POD } : SIGNALS;
    for (const [k, re] of Object.entries(signals)) {
      const m = c.match(re)?.length ?? 0;
      if (m) { n[k] += m; (lines[k] ??= []).push(i + 1); }
    }
  });
  return { n, lines };
}

function files() {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...ROOTS], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  return out.split("\0").filter((f) => f && CODE.test(f) && !SKIP.test(f) && existsSync(join(ROOT, f)));
}

function scan() {
  const found = {};
  for (const f of files()) {
    const r = countFile(readFileSync(join(ROOT, f), "utf8"), f.endsWith(".py"), f.startsWith("apps/web/app/"));
    if (r.n.domain || r.n.ea || r.n.name || r.n.pod) found[f] = r;
  }
  return found;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const found = scan();
  const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")).files ?? {} : {};
  if (args.has("--counts")) {
    const t = { domain: [0, 0], ea: [0, 0], name: [0, 0], pod: [0, 0] };
    for (const r of Object.values(found)) for (const k of Object.keys(t)) if (r.n[k]) { t[k][0] += 1; t[k][1] += r.n[k]; }
    for (const [k, [fs, hits]] of Object.entries(t)) console.log(`${k.padEnd(7)} files=${fs} hits=${hits}`);
    return;
  }
  if (args.has("--update")) {
    const files = {};
    for (const [f, r] of Object.entries(found).sort()) {
      const was = base[f] ?? { domain: 0, ea: 0, name: 0, pod: 0 };
      files[f] = Object.fromEntries(Object.keys(r.n).map((k) => [k, Math.min(r.n[k], f in base && k in was ? was[k] : r.n[k])]));
    }
    writeFileSync(BASELINE, JSON.stringify({ note: "DE-EA: per-file counts of company-specific literals outside comments; only ever shrinks (tools/check-tenant-neutral.mjs).", files }, null, 1) + "\n");
    console.log(`tenant-neutral baseline: ${Object.keys(files).length} files`);
    return;
  }
  const failures = [], shrunk = [];
  for (const [f, r] of Object.entries(found)) {
    const allowed = base[f] ?? { domain: 0, ea: 0, name: 0, pod: 0 };
    for (const k of Object.keys(r.n)) {
      if (r.n[k] > (allowed[k] ?? 0)) failures.push(`${f}: ${r.n[k]} ${k} (allowed ${allowed[k] ?? 0}) on line(s) ${r.lines[k].join(", ")}`);
      else if (r.n[k] < (allowed[k] ?? 0)) shrunk.push(f);
    }
  }
  for (const f of Object.keys(base)) if (!found[f]) shrunk.push(f);
  if (failures.length) {
    console.error("Company-specific literals in product code (DE-EA). Read the company's words, code, domain or roles from");
    console.error("tenant/platform config, pack data or the vocabulary helper instead, or move the text into a comment:");
    for (const x of failures) console.error(`  ${x}`);
    process.exit(1);
  }
  if (shrunk.length) console.log(`tenant-neutral: ok; ${new Set(shrunk).size} file(s) are below their baseline, run --update to lock that in`);
  else console.log("tenant-neutral: ok");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
