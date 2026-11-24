// SPEED-5 (owner, 18 Nov 2026): an attendance action asks Pulse for the day after it (`day: true`) and shows that day at
// once, so the header's Check in / Check out and My desk change after one round trip, not the action and then a second
// read of the day (header Check in p90 1.8 s for real people). The reads its announcement starts use the given day.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("an action posts day: true, shows the day it gets back, and keeps it out of the saved receipt", () => {
  const hook = src("hr/attendance-recovery.tsx");
  assert.match(hook, /body: JSON\.stringify\(\{ \.\.\.body, day: true \}\)/);
  assert.match(hook, /const \{ day: given, \.\.\.data \} = await r\.json\(\)\.catch\(\(\) => \(\{\}\)\);/);
  // shown only when Pulse accepted the action, before the recovery records it (its announcement comes after)
  assert.ok(hook.indexOf("if (!r.ok) throw") < hook.indexOf("if (given) giveDay(given);"));
  assert.ok(hook.indexOf("if (given) giveDay(given);") < hook.indexOf("return data;"));
  // reads (no body) are unchanged
  assert.match(hook, /body === undefined \? \{ cache: 'no-store', signal \}/);
});

test("a given day is shown at once, and the reads right after it use it instead of asking again", () => {
  const day = src("lib/companion-day.ts");
  assert.match(day, /export function giveDay\(payload: CompanionDay\) \{/);
  assert.match(day, /snapshot = \{ payload, offset: clockOffset\(payload\) \}; givenAt = Date\.now\(\); emit\(\);/);
  const refresh = day.slice(day.indexOf("export function refreshDay("));
  assert.ok(refresh.indexOf("if (Date.now() - givenAt < GIVEN_FRESH_MS) return Promise.resolve();") < refresh.indexOf("if (loading) return loading;"));
  assert.match(day, /const GIVEN_FRESH_MS = 2000;/);
});
