// SPEED-4 (owner, 18 Nov 2026: "make the slowest real actions fast"): the header's Check in / Check out (p90 1.4-1.8 s
// for real people on production, 3 days) read the person's day twice, one round trip after the other: the attendance
// recovery hook announces an accepted tap (pulse:attendance → the day's read, the page's refresh, every listener), and
// the header control then announced it again after joining that read, which started a second read of the day.
// These tests keep one announcement per accepted tap, and keep it for taps the hook does not announce (queued).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const here = new URL("../", import.meta.url);
const src = (path) => readFileSync(new URL(path, here), "utf8");

test("an accepted tap is announced once: by the recovery hook, not again by the header control", () => {
  const hook = src("hr/attendance-recovery.tsx");
  // The hook announces every newly accepted tap (and refreshes the page) when its records change.
  assert.match(hook, /accepted = next; router\.refresh\(\); window\.dispatchEvent\(new Event\('pulse:attendance'\)\);/);
  const chip = src("checkin-chip.tsx");
  const act = chip.slice(chip.indexOf("async function act("), chip.indexOf("const primary ="));
  assert.ok(act.includes("await refreshDay();"), "the header control still waits for the day before it celebrates");
  assert.match(act, /if \(result !== "accepted"\) window\.dispatchEvent\(new Event\("pulse:attendance"\)\);/);
  assert.equal(act.match(/dispatchEvent\(new Event\("pulse:attendance"\)\)/g)?.length, 1, "one announcement, only for taps the hook did not announce");
});

test("the day's read joins a read already running instead of starting another", () => {
  const day = src("lib/companion-day.ts");
  assert.match(day, /if \(loading\) return loading;/);
  assert.match(day, /window\.addEventListener\("pulse:attendance", visibleRefresh\);/);
});

test("recovery's changes are told before act() resolves, so the hook's announcement comes first", () => {
  const rec = src("lib/attendance-recovery.mjs");
  // run(): finally { …; this.changed(); } happens inside the task that act() returns.
  assert.match(rec, /finally \{ this\.busy = false; if \(this\.current\(\)\) this\.changed\(\); \}\s*\}\)\)\.then\(\(\) => result\);/);
});
