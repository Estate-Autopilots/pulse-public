import assert from "node:assert/strict";
import test from "node:test";
import { judge } from "../dist/project-health.js";

const base = { open: 3, late: 0, blocked: 0, soon: 0, noOwner: 0, noDue: 0, waitingClient: 0, dueOn: null };
const T = "2026-10-27";

test("a project with nothing late or blocked is on track", () => {
  assert.deepEqual(judge(base, T).health, "on_track");
  assert.equal(judge(base, T).why, "On track");
});

test("blocked beats waiting, waiting beats late, late beats due soon (worst first)", () => {
  const blocked = judge({ ...base, blocked: 1, late: 2 }, T), waiting = judge({ ...base, waitingClient: 1, late: 5 }, T);
  const late = judge({ ...base, late: 3 }, T), soon = judge({ ...base, soon: 1 }, T);
  assert.equal(blocked.health, "blocked"); assert.equal(waiting.health, "waiting"); assert.equal(late.health, "at_risk"); assert.equal(soon.health, "watch");
  assert.ok(blocked.score > waiting.score && waiting.score > late.score && late.score > soon.score);
  assert.match(blocked.why, /1 blocked · 2 late/);
});

test("a project past its end date is at risk; no due day alone is only a note", () => {
  assert.equal(judge({ ...base, dueOn: "2026-10-01" }, T).health, "at_risk");
  const r = judge({ ...base, noDue: 4 }, T);
  assert.equal(r.health, "on_track"); assert.equal(r.why, "4 with no due day");
});
