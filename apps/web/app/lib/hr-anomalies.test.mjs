import { test } from "node:test";
import assert from "node:assert/strict";
import { groupAnomalies, shortReason } from "./hr-anomalies.mjs";

const excluded = (labels) => ({ type: "statistics_excluded", personId: "p", name: "P", date: "2026-10-07", detail: `${labels.join("; ")}. Day excluded from averages; review the attendance correction.` });

test("excluded days say their reason in one short line", () => {
  assert.equal(shortReason(excluded(["Session not yet closed", "Over the provisional 12-hour session bound"])), "Session not closed (12 h+)");
  assert.equal(shortReason(excluded(["Check-out needs correction", "Correction awaiting a decision"])), "Check-out missing · Correction pending");
  assert.equal(shortReason(excluded(["Over the provisional 12-hour daily bound"])), "Day over 12 h");
  assert.equal(shortReason(excluded(["Times need review", "Sessions overlap", "Breaks overlap"])), "Times need review · Sessions overlap", "at most two reasons");
  assert.equal(shortReason(excluded(["A label the web does not know yet"])), "A label the web does not know yet");
});

test("the other kinds are shortened from the service's sentence", () => {
  assert.equal(shortReason({ type: "late", detail: "Late 4 times in the last 14 days." }), "Late 4 times in 14 days");
  assert.equal(shortReason({ type: "absent", detail: "One working day without a check-in or approved leave." }), "1 day without a check-in");
  assert.equal(shortReason({ type: "absent", detail: "3 working days without a check-in or approved leave." }), "3 days without a check-in");
  assert.equal(shortReason({ type: "long_break", detail: "Breaks added up to 2 h 40 min." }), "Breaks took 2 h 40 min");
  assert.equal(shortReason({ type: "long_break", detail: "Breaks added up to 3 h 0 min." }), "Breaks took 3 h");
  assert.equal(shortReason({ type: "long_day", detail: "Worked 14 h. Check the record." }), "Worked 14 h");
});

test("anomalies group by kind, most pressing first, counting people once", () => {
  const groups = groupAnomalies([
    { type: "late", personId: "a", name: "A", date: null, detail: "" },
    { type: "statistics_excluded", personId: "a", name: "A", date: "2026-10-07", detail: "" },
    { type: "statistics_excluded", personId: "a", name: "A", date: "2026-10-06", detail: "" },
    { type: "statistics_excluded", personId: "b", name: "B", date: "2026-10-06", detail: "" },
  ]);
  assert.deepEqual(groups.map((g) => [g.label, g.items.length, g.people]), [["Attendance needs review", 3, 2], ["Often late", 1, 1]]);
  assert.deepEqual(groupAnomalies(null), []);
});
