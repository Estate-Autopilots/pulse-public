import assert from "node:assert/strict";
import test from "node:test";
import { importTimeline, parseDays, parsePackages } from "../dist/timeline-import.js";

// PM-BUILD-1: a delivery timeline written as a document's tables, in the shape a Google Doc's text export has (a table
// starts at a line "ID"; every other cell is a tab-indented line). Synthetic words only.
const cells = (rows) => rows.flat().map((c, i) => (i ? `\t${c}` : c)).join("\n");
const DOC = [
  "Stage 0 — Getting ready (Day −3 to 0)",
  cells([["ID", "Step", "Owner", "Day", "Depends on", "Type", "Packages"],
    ["A1", "Paid invoice opens the project", "System", "−3", "—", "Auto", "All"],
    ["A2", "Brief received", "Lead", "−3 to −1", "A1", "Client input", "All"],
    ["A3", "Ready: every input in", "Lead", "0", "A2", "Gate", "All"]]),
  "Phase 1 — Making things (Day 1–20)",
  cells([["ID", "Step", "Owner", "Day", "Depends on", "Hours", "Packages"],
    ["M1", "First set made", "Maker + Lead", "1–5", "A3", "4–6 each", "Big, Small"],
    ["M2", "Extra set", "Maker", "5–9", "M1 accepted", "—", "Big; paid on request in Small"],
    ["M3", "Testimonials", "Maker", "6–9", "M1, Q9", "—", "All, where real buyers exist"]]),
  "Phase 2 — Running (Day 10 onward)",
  cells([["ID", "Step", "Owner", "Day", "Depends on", "Type", "Packages"],
    ["R1", "Channel set up", "Lead", "8–10", "M1", "Ongoing", "All"],
    ["R2", "Live", "Lead", "10–12", "R1", "Milestone", "All"],
    ["R3", "Tell the client", "Lead", "12–14", "R2", "Task", "Big"],
    ["R4", "Monthly review", "Lead", "Monthly from 20", "R2", "Recurring", "As R3"],
    ["R5", "Remix", "Maker", "40–55", "R2 plus 30 days", "Task", "Big"],
    ["R6", "Renewal talk", "Lead", "Month 2 on Small; month 4 on Big", "R2", "Milestone", "All"]]),
  "Paid add-ons and bonuses",
  cells([["ID", "Step", "Owner", "Day from purchase", "Depends on", "Type"],
    ["X1", "Brand film", "Lead", "+0 to +40", "Invoice line", "Add-on chain"]]),
].join("\n");
const OPTS = { packages: [{ key: "big", label: "Big" }, { key: "small", label: "Small" }],
  clocks: [{ key: "start", label: "Paid", day: -3 }, { key: "day0", label: "Ready", step: "A3" }, { key: "live", label: "Live", step: "R2", inputs: ["M1", "R1"] }, { key: "bought", label: "Bought" }] };

test("days, packages and the document's words", () => {
  assert.deepEqual(parseDays("−7 to −6"), { start: -7, end: -6 });
  assert.deepEqual(parseDays("2–4"), { start: 2, end: 4 });
  assert.deepEqual(parseDays("12"), { start: 12, end: 12 });
  assert.deepEqual(parseDays("28 onward"), { start: 28, end: null });
  assert.deepEqual(parseDays("Monthly from 30"), { start: 30, end: null, repeat: "monthly" });
  assert.deepEqual(parseDays("+0 to +40"), { start: 0, end: 40 });
  assert.deepEqual(parseDays("With the shoot"), { start: null, end: null });
  const p = (s) => parsePackages(s, OPTS.packages, new Map()).packages;
  assert.deepEqual(p("All"), { big: "yes", small: "yes" });
  assert.deepEqual(p("Big"), { big: "yes", small: "no" });
  assert.deepEqual(p("Big, add-on"), { big: "yes", small: "optional" });
  assert.deepEqual(p("Bonus on Big; paid on request in Small"), { big: "yes", small: "optional" });
  assert.deepEqual(p("Optional"), { big: "optional", small: "optional" });
});

test("a timeline document becomes phases and steps on their clocks", () => {
  const r = importTimeline(DOC, OPTS);
  assert.deepEqual(r.stages.map((s) => s.label), ["Stage 0 · Getting ready", "Phase 1 · Making things", "Phase 2 · Running", "Paid add-ons and bonuses"]);
  const s = Object.fromEntries(r.steps.map((x) => [x.id, x]));
  // Stage 0 runs on negative days from the plan's start (Day −3 is start + 0); the step that records day 0 is expected at start + 3.
  assert.deepEqual([s.A1.type, s.A1.from, s.A1.start], ["auto", "start", 0]);
  assert.deepEqual([s.A2.from, s.A2.start, s.A2.end, s.A2.clientInput], ["start", 0, 2, true]);
  assert.deepEqual([s.A3.type, s.A3.from, s.A3.start, s.A3.end], ["gate", "start", 3, 3]);
  assert.deepEqual([s.M1.from, s.M1.start, s.M1.end, s.M1.owner], ["day0", 1, 5, "Maker + Lead"]);
  assert.deepEqual(s.M1.hours, [4, 6]);
  assert.deepEqual(s.M1.packages, { big: "yes", small: "yes" });
  assert.match(s.M2.note, /M1 accepted/);
  assert.deepEqual(s.M2.packages, { big: "yes", small: "optional" });
  assert.equal(s.M3.when, "realBuyers");
  assert.deepEqual(s.M3.after, ["M1"]);
  assert.ok(r.warnings.some((w) => /M3 waits on Q9/.test(w)));
  // After going live: days count from it (Day 12 is live + 0 when live is Day 12); "plus 30 days" starts 30 after.
  assert.deepEqual([s.R1.type, s.R1.from], ["ongoing", "day0"]);
  assert.deepEqual(s.R2.gateInputs, ["M1", "R1"]);
  assert.deepEqual([s.R3.from, s.R3.start, s.R3.end], ["live", 0, 2]);
  assert.deepEqual([s.R4.type, s.R4.from, s.R4.start, s.R4.end], ["repeating", "live", 8, null]);
  assert.deepEqual(s.R4.packages, s.R3.packages);
  assert.deepEqual([s.R5.from, s.R5.start, s.R5.end], ["live", 30, 45]);
  assert.deepEqual(s.R6.byPackage, { small: { start: 30, end: 60 }, big: { start: 90, end: 120 } });
  assert.deepEqual([s.X1.from, s.X1.start, s.X1.end], ["bought", 0, 40]);
  assert.deepEqual(s.X1.packages, { big: "optional", small: "optional" });
});
