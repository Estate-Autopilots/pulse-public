#!/usr/bin/env node
// PM-BUILD-1 (17 Nov 2026): read a delivery timeline document (a Google Doc saved as plain text) into a delivery
// template's steps (format 3), and say what differs from the company's current template. A person reads the result and
// saves it through pulse.delivery_template_save (it keeps every version); this tool writes nothing to any database.
//
//   pnpm --dir services/api build
//   node tools/timeline-to-template.mjs <doc.txt> <options.json> [current-template.json] > template.json
//
// options.json: { "packages": [{"key","label"}], "clocks": [{"key":"start","label","day"}, {"key":"day0","label","step"},
//   {"key":"live","label","step","inputs":[…]}, {"key":"bought","label"}], "liveDay": 21, "base": { …template fields to keep… },
//   "match": { "<step id>": ["words a quotation line's title carries"] } }
// The differences from the current template go to stderr: steps added, removed and changed (title, days, owner, type).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [doc, opts, current] = process.argv.slice(2);
if (!doc || !opts) { console.error("usage: timeline-to-template.mjs <doc.txt> <options.json> [current-template.json]"); process.exit(2); }
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { importTimeline } = await import(join(root, "services/api/dist/timeline-import.js"));
const o = JSON.parse(readFileSync(opts, "utf8"));
const r = importTimeline(readFileSync(doc, "utf8"), o);
const base = o.base ?? {};
// The words a quotation line's title carries for a step ("model video"): a line made into a task takes that step.
for (const s of r.steps) if (o.match?.[s.id]) s.match = o.match[s.id];
const out = { ...base, format: 3, stages: r.stages, packages: o.packages, clocks: o.clocks, steps: r.steps };
for (const w of r.warnings) console.error(`warning: ${w}`);
if (current) {
  const cur = JSON.parse(readFileSync(current, "utf8"));
  const was = new Map((cur.steps ?? []).map((s) => [s.id, s]));
  const now = new Map(r.steps.map((s) => [s.id, s]));
  const added = r.steps.filter((s) => !was.has(s.id)).map((s) => s.id), gone = [...was.keys()].filter((k) => !now.has(k));
  console.error(`steps: ${was.size} → ${now.size}; added ${added.length}: ${added.join(" ")}; removed ${gone.length}: ${gone.join(" ")}`);
  for (const s of r.steps) {
    const w = was.get(s.id); if (!w) continue;
    const diff = ["title", "owner", "start", "end"].filter((k) => String(w[k]) !== String(s[k])).map((k) => `${k} ${JSON.stringify(w[k])} → ${JSON.stringify(s[k])}`);
    if ((w.kind ?? "task") !== s.type) diff.push(`type ${w.kind} → ${s.type}`);
    if (diff.length) console.error(`  ${s.id}: ${diff.join("; ")}`);
  }
}
console.error(`phases: ${r.stages.map((s) => `${s.n} ${s.label}`).join(" | ")}`);
process.stdout.write(`${JSON.stringify(out)}\n`);
