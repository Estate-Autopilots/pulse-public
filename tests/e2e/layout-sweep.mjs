// LAYOUT-SWEEP: every route at every size, checked by layout-audit.mjs. Read-only: requests other than GET to the API
// are refused, so a sweep of real data never writes.
//
//   ea-heavy node tests/e2e/layout-sweep.mjs [--base http://127.0.0.1:3200] [--as admin@estateautopilots.com]
//     [--sizes 1366x768,1440x900,1920x1080,768x1024,390x844] [--theme light] [--out dir] [--shots] [--all-shots]
//     [--discover] (follow each page's tabs and views at the first size) [--routes /a,/b] [--warn] (print warnings)
//
// Writes <out>/layout-<theme>.json ({ path, width, height, findings }) and, with --shots, a screenshot per view with
// blocking findings (each one outlined). Exit status 1 when a blocking finding remains.
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { BLOCKING, ROUTES, SIZES, recordRoutes, sweep } from "./layout-audit.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(`--${k}`);
const base = opt("base", "http://127.0.0.1:3200").replace(/\/$/, "");
const email = opt("as", "admin@estateautopilots.com");
const theme = opt("theme", "light");
const sizes = opt("sizes", "") ? opt("sizes").split(",").map((s) => s.split("x").map(Number)) : SIZES;
const out = opt("out", "/tmp/layout-sweep"); await mkdir(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const routes = opt("routes", "") ? opt("routes").split(",") : [...ROUTES, ...await recordRoutes(browser, { base, email })];
const records = await sweep(browser, { base, email, routes, sizes, theme, out, shots: has("shots"), allShots: has("all-shots"), discover: has("discover"), warn: has("warn"),
  onRecord: () => void writeFile(`${out}/layout-${theme}.json`, JSON.stringify(records, null, 1)) });
await writeFile(`${out}/layout-${theme}.json`, JSON.stringify(records, null, 1));
await browser.close();
const failing = records.filter((r) => r.findings.some((f) => BLOCKING.includes(f.rule)));
console.log(`\n${records.length} views; ${failing.length} with blocking findings. Report: ${out}/layout-${theme}.json`);
process.exit(failing.length ? 1 : 0);
