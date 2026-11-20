// SPEED-5 (owner, 18 Nov 2026): My desk (GET /api/v0/hr/self) took p50 0.49 s / p90 2.3 s on production for real people
// (Estate Autopilots, 196 reads in 3 days, ~50 queries each). Read-only timing of its parts as the people who use it most:
// the delivery block 100-130 ms (three queries each calling delivery_matches once per delivery of the company), a
// manager's team 280 ms (every staff member's first day and the whole company's sessions read, then filtered to the
// reports), and every attendance read paying a walk of the company's correction requests (never-analyzed tables: 2394).
// The answers are unchanged (compared field by field against the previous build on production, read-only).
// The database half (the view's rows with the index and statistics) is tests/core/test_hr_self_speed.py.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hr = readFileSync(new URL("../src/hr.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../../db/migrations/2394_attendance_correction_entry.sql", import.meta.url), "utf8");
const fn = (name) => hr.slice(hr.indexOf(`async function ${name}(`), hr.indexOf("\n}\n", hr.indexOf(`async function ${name}(`)) + 2);
const inner = (name) => { const at = hr.indexOf(`  async function ${name}(`); return hr.slice(at, hr.indexOf("\n  }\n", at) + 4); };

test("the delivery block finds the person's files once, in one statement", () => {
  const perf = fn("performance");
  assert.equal((perf.match(/c\.query\(/g) ?? []).length, 1);
  assert.doesNotMatch(perf, /pulse\.delivery_matches\(/);
  assert.match(perf, /with mine as materialized \(select a\.file_id from pulse\.delivery_actor a where a\.actor_id=\$1::uuid\)/);
  // the same answer as before: 16 weeks (12 shown), this week, the 56-day quality and the all-time count
  assert.match(perf, /weeks: weeks\.slice\(4\), thisWeek: weeks\[15\]\.deliveries, recent, baseline, quality, allTime: r0\.all_n as number, firstDeliveryAt: r0\.all_first/);
  assert.match(perf, /from d where d\.delivered_at >= now\(\) - interval '56 days'/);
});

test("a manager's team reads only the reports' records", () => {
  const roster = inner("roster");
  assert.match(roster, /and \(\$2::uuid\[\] is null or p\.id=any\(\$2\)\) order by p\.display_name`, \[x\.policy\.attendanceEnabled, only \?\? null\]/);
  assert.match(roster, /and \(\$2::uuid\[\] is null or e\.person_id=any\(\$2\)\) order by e\.checked_in_at`, \[date, only \?\? null\]/);
  // the first tracked day is the record's own date, without the view's per-entry correction lookups
  assert.match(roster, /select min\(work_date\)::text from pulse\.attendance_entry e where e\.person_id=p\.id and e\.voided_at is null/);
});

test("My desk reads its rule versions once and this month's work from home from the month's sessions", () => {
  const bundle = inner("bundle");
  assert.equal((bundle.match(/ruleVersions\(c\)/g) ?? []).length, 1);
  assert.match(bundle, /await balances\(c, x, \[id\], versions\)/);
  assert.match(bundle, /month === x\.today\.slice\(0, 7\) \? entries\.filter\(e => e\.mode === "wfh" && e\.date\.startsWith\(month\)\)\.length/);
  assert.match(bundle, /from pulse\.attendance_entry where person_id=\$1 and voided_at is null/);
  assert.match(hr, /async function balances\(c: PoolClient, x: Ctx, people: string\[\] \| null, known\?: [^)]+\) \{\n  const versions=known\?\?await ruleVersions\(c\);/);
});

test("2394 indexes corrections by entry and analyzes the HR and attendance tables", () => {
  assert.match(migration, /create index if not exists attendance_correction_entry on pulse\.attendance_correction_time\(entry_id, created_at desc, regularisation_id desc\);/);
  assert.match(migration, /c\.relname ~ '\^\(attendance_\|leave_\|hr_\)'/);
  assert.match(migration, /execute format\('analyze pulse\.%I', t\);/);
});
