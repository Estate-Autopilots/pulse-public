// WA-NATIVE (1053): the six recommendations carry the company's own numbers and become a task and an SOP step.
import test from "node:test";
import assert from "node:assert/strict";
import { recommendations } from "../dist/ops-insights.js";

const data = {
  groups: 120,
  path: { days: { startToLive: 9.1, creativeToApproval: 7.7, revisions: 16 } },
  waits: { sides: { team: { medianMinutes: 6, p90Hours: 6.2 }, client: { medianMinutes: 26, p90Hours: 21 } } },
  wrong: { signals: [{ kind: "lead_quality", n: 346, groups: 44 }, { kind: "complaint", n: 900, groups: 80 }], funds: { asks: 2367, groups: 100 }, atRisk: 12 },
  sop: { steps: [{ step_no: 6, observed_share: 0.72, median_hours_from_start: 307 }, { step_no: 7, observed_share: 0.21 }, { step_no: 8, observed_share: 0.95 },
    { step_no: 12, observed_share: 0.74, median_hours_from_start: 386.6 }] },
};

test("six recommendations, each with this company's numbers, a task and an SOP step", () => {
  const recs = recommendations(data);
  assert.deepEqual(recs.map((r) => r.id), ["day-one", "call-48h", "one-approver", "funds-rule", "lead-feedback", "one-owner"]);
  const by = Object.fromEntries(recs.map((r) => [r.id, r]));
  assert.match(by["day-one"].why, /a median 16.1 days in/);
  assert.match(by["call-48h"].why, /12.8 days in; the service agreement shows in 21% of groups/);
  assert.match(by["one-approver"].why, /7.7 days and start → live 9.1 days/);
  assert.match(by["funds-rule"].why, /2,367 times in 100 groups/);
  assert.match(by["lead-feedback"].why, /346 lead-quality signals in 44 groups/);
  assert.match(by["one-owner"].why, /6 working minutes \(90% within 6.2 h\); 12 clients/);
  for (const r of recs) {
    assert.ok(r.task.title.length <= 200 && r.task.notes.includes(r.why) && r.task.notes.includes(r.sop.title));
    assert.ok(r.sop.title && r.sop.detail && r.sop.phase && r.evidence.length >= 1);
  }
});

test("missing numbers read as a dash, never NaN or undefined", () => {
  const recs = recommendations({ groups: 0, path: { days: {} }, waits: { sides: {} }, wrong: { signals: [], funds: {} }, sop: { steps: [] } });
  for (const r of recs) assert.doesNotMatch(r.why + r.evidence.join(" "), /NaN|undefined|null/);
});
