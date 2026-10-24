#!/usr/bin/env node
// UX-5B: backtest of Pip's value and priority (services/api/src/ai/task-scorer.ts) on a Pulse database, read-only.
//   DATABASE_URL=… PULSE_ORG=<org id> PULSE_VIEWER=<an admin's person id> node tools/value-backtest.mjs [--out file.md]
// Builds each task's inputs the way suggestFor() does (work-domains.ts), with "today" set to the day the task was made,
// and asks: does Pip's value agree with the values people set (rank correlation)? Did work Pip would have put first get
// finished sooner (revealed priority)? Does client and unlocking work rank above routine internal work? Requires the
// API build (services/api/dist). Nothing is written: the whole run is one read-only transaction.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "services", "api", "package.json"));
const pg = require("pg");
const { heuristicScorer } = await import(join(ROOT, "services", "api", "dist", "ai", "task-scorer.js"));

const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
const ORG = process.env.PULSE_ORG, VIEWER = process.env.PULSE_VIEWER;
if (!process.env.DATABASE_URL || !ORG || !VIEWER) { console.error("set DATABASE_URL, PULSE_ORG and PULSE_VIEWER"); process.exit(2); }

/** Spearman's rank correlation (average ranks for ties). */
export function spearman(xs, ys) {
  const rank = (v) => { const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = new Array(v.length); let i = 0;
    while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; };
  const a = rank(xs), b = rank(ys), n = xs.length; if (n < 3) return null;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0; for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? Math.round((num / Math.sqrt(da * db)) * 100) / 100 : null;
}
const median = (v) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (v) => v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 100) / 100 : null;

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, options: "-c role=pulse_api" });
await client.connect();
await client.query("begin read only");
await client.query("select set_config('pulse.org_id',$1,true), set_config('pulse.viewer_id',$2,true)", [ORG, VIEWER]);
const q = async (sql, args = []) => (await client.query(sql, args)).rows;

/** Pip's suggestion for a task, with the inputs suggestFor() gathers, "today" being the day it was made. */
async function suggest(t) {
  const category = t.category ?? (await q("select pulse.work_category_guess($1) k", [t.title]))[0].k;
  const label = category ? (await q("select label from pulse.work_category where key=$1", [category]))[0]?.label ?? null : null;
  const project = t.project_id ? (await q(`select coalesce(pr.title,pr.name) name,wp.kind,pulse.work_package_band(pr.id) band from pulse.project pr left join pulse.work_project wp on wp.project_id=pr.id where pr.id=$1`, [t.project_id]))[0] ?? null : null;
  const sim = (await q("select pulse.work_similar_effort($1,$2) s", [category, t.title]))[0].s;
  const unlocks = (await q(`select count(*)::int tasks,coalesce(sum(coalesce(w.value_points,(w.ai_suggestion->>'valuePoints')::int)),0)::int value
    from pulse.task_link l join pulse.task w on w.id=l.task_id where l.blocker_id=$1`, [t.id]))[0];
  const learnt = (await q("select pulse.work_category_baseline($1) b,pulse.work_value_learning($1) l,pulse.work_estimate_calibration() k", [category]))[0];
  return heuristicScorer.suggest({ title: t.title, category, categoryLabel: label, priority: t.priority, dueOn: t.due_on, today: t.made_on,
    project: project ? { name: project.name, kind: project.kind ?? null, packageBand: project.band ?? null } : null,
    similar: sim && sim.n ? { n: sim.n, minutes: sim.minutes, minutesN: sim.minutesN, cycleDays: sim.cycleDays, value: sim.value, points: sim.points } : null,
    estimateMinutes: t.estimate_minutes, unlocks: unlocks.tasks ? unlocks : null, baseline: learnt.b?.n ? { n: learnt.b.n, value: learnt.b.value } : null,
    learning: learnt.l?.n ? { n: learnt.l.n, ratio: learnt.l.ratio } : null, calibration: learnt.k?.n ? { n: learnt.k.n, ratio: learnt.k.ratio === null ? null : Number(learnt.k.ratio) } : null });
}
const TZ = "(select pulse.org_time_zone())";
const COLS = `t.id,t.title,t.category,t.project_id,t.priority,t.estimate_minutes,t.value_points,t.value_source,t.status,(t.due_at at time zone ${TZ})::date::text due_on,
  coalesce((t.created_at at time zone ${TZ})::date,(t.done_at at time zone ${TZ})::date,current_date)::text made_on,t.created_at,t.done_at,t.source`;

const lines = [];
const say = (s = "") => { lines.push(s); console.log(s); };
say(`Backtest of Pip's value and priority on ${new Date().toISOString().slice(0, 10)} (read-only). Scorer: ${heuristicScorer.name} v${heuristicScorer.version} + priority WSJF v1.`);

// 1. Values people set: does Pip agree on the order?
const valued = await q(`select ${COLS} from pulse.task t where t.deleted_at is null and t.value_points is not null and t.value_source in ('leadership','creator','reviewer')`);
const a = []; for (const t of valued) a.push({ t, s: await suggest(t) });
const rhoA = spearman(a.map((x) => x.s.valuePoints), a.map((x) => x.t.value_points));
const errA = median(a.map((x) => Math.abs(x.s.valuePoints - x.t.value_points)));
say(`\n1. Values set by people: ${a.length} tasks. Rank correlation (Spearman) of Pip's value with theirs: ${rhoA ?? "n/a"}; median absolute difference: ${errA ?? "n/a"} points.`);

// 2. Revealed priority: was work Pip would have put first finished sooner?
const done = await q(`select ${COLS} from pulse.task t where t.deleted_at is null and t.source='pulse' and t.done_at is not null and t.created_at is not null and t.done_at>t.created_at`);
const b = []; for (const t of done) b.push({ t, s: await suggest(t), days: (Date.parse(t.done_at) - Date.parse(t.created_at)) / 86400000 });
const rhoB = spearman(b.map((x) => x.s.priority.score), b.map((x) => x.days));
const top = b.filter((x) => x.s.priority.score >= 3).map((x) => x.days), rest = b.filter((x) => x.s.priority.score < 3).map((x) => x.days);
say(`\n2. Work made and finished in Pulse: ${b.length} tasks. Rank correlation of priority (points an hour) with days to finish: ${rhoB ?? "n/a"} (negative = higher priority finished sooner).`);
say(`   Median days to finish: priority ≥ 3: ${median(top)?.toFixed(1) ?? "n/a"} (${top.length} tasks); below 3: ${median(rest)?.toFixed(1) ?? "n/a"} (${rest.length} tasks).`);

// 3. Accepted work: credited points against Pip.
const acc = await q(`select ${COLS},(select points from pulse.work_credit c where c.task_id=t.id and c.reversed_at is null and c.basis<>'help' limit 1) credited
  from pulse.task t where t.deleted_at is null and t.status='accepted'`);
const c3 = []; for (const t of acc) if (t.credited) c3.push({ t, s: await suggest(t) });
say(`\n3. Accepted work with a credit: ${c3.length} task${c3.length === 1 ? "" : "s"}.${c3.length ? ` Pip ${c3.map((x) => `${x.s.valuePoints} vs credited ${x.t.credited}`).join("; ")}.` : ""}`);

// 4. The tracker's finished work: does the order make sense by kind, client and what it unlocked?
const tracker = await q(`select ${COLS} from pulse.task t where t.deleted_at is null and t.source='imported' and t.status='done' and t.category is not null order by t.id limit 400`);
const d = []; for (const t of tracker) d.push({ t, s: await suggest(t) });
const clientWork = d.filter((x) => /client/i.test(x.s.priority.why)), internal = d.filter((x) => !/client/i.test(x.s.priority.why));
say(`\n4. Finished tracker work (first 400 with a kind of work): median priority, client work ${median(clientWork.map((x) => x.s.priority.score))?.toFixed(2) ?? "n/a"} (${clientWork.length}) vs other ${median(internal.map((x) => x.s.priority.score))?.toFixed(2) ?? "n/a"} (${internal.length}); median value ${median(clientWork.map((x) => x.s.valuePoints)) ?? "n/a"} vs ${median(internal.map((x) => x.s.valuePoints)) ?? "n/a"} points.`);
const byKind = new Map(); for (const x of d) { const k = x.t.category; byKind.set(k, [...(byKind.get(k) ?? []), x]); }
say("   By kind of work (tasks · median value · median hours · median points an hour · confidence):");
for (const [k, xs] of [...byKind].sort((p, q2) => q2[1].length - p[1].length).slice(0, 10))
  say(`   - ${k}: ${xs.length} · ${median(xs.map((x) => x.s.valuePoints))} · ${median(xs.map((x) => x.s.priority.sizeHours))} · ${median(xs.map((x) => x.s.priority.score))} · ${["low", "medium", "high"].map((c) => `${xs.filter((x) => x.s.priority.confidence === c).length} ${c}`).join(", ")}`);

// 5. Determinism: the same inputs give the same answer.
const again = d.slice(0, 25); let same = 0; for (const x of again) if (JSON.stringify(await suggest(x.t)) === JSON.stringify(x.s)) same++;
say(`\n5. Same inputs, same answer: ${same} of ${again.length}.`);
const conf = [...a, ...b, ...d].map((x) => x.s.priority.confidence);
say(`\nConfidence over all ${conf.length} scored tasks: ${["low", "medium", "high"].map((c) => `${conf.filter((x) => x === c).length} ${c}`).join(", ")}; mean confidence score ${mean([...a, ...b, ...d].map((x) => x.s.priority.confidenceScore))}.`);
await client.query("rollback"); await client.end();
if (out) writeFileSync(out, `${lines.join("\n")}\n`);
