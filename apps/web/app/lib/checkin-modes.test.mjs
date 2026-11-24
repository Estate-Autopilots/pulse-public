// VITALS-SWEEP (VTI #3, 23 Nov 2026, Kazuk for the EA pod head: "the Work from Home option is not easy to find"): both
// check-in places (the top bar's menu and My desk / HR) name the choice the same plain way, before the Check in button.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECKIN_MODES, CHECKIN_MODES_LABEL, modeLabel, pressLabel } from "./checkin-modes.mjs";

test("the check-in choice says Work from home in words, Office first", () => {
  assert.deepEqual(CHECKIN_MODES.map((m) => m.id), ["office", "wfh", "field"]);
  assert.deepEqual(CHECKIN_MODES.map((m) => m.label), ["Office", "Work from home", "On duty"]);
  assert.equal(CHECKIN_MODES_LABEL, "Where are you working today?");
  assert.equal(modeLabel("wfh"), "Work from home");
  assert.equal(modeLabel("nonsense"), "Office");
});

// VITALS-SWEEP (VTI #2, "check-in confirmation is slow"): the press was saved after one round trip (server p50 0.09 s), but
// the button said "Checking in…" until the whole page had refreshed (press to settled p90 4.3-4.9 s, 14 people). Once
// Pulse has accepted it, the button says so while the page catches up.
test("the check-in button says Checked in as soon as Pulse accepted it", () => {
  const idle = "Check in";
  assert.equal(pressLabel("check-in", idle, { doing: null, sending: false, settled: false }), "Check in");
  assert.equal(pressLabel("check-in", idle, { doing: "check-in", sending: true, settled: false }), "Checking in…");
  assert.equal(pressLabel("check-in", idle, { doing: "check-in", sending: true, settled: true }), "Checked in");
  assert.equal(pressLabel("check-out", "Check out", { doing: "check-out", sending: true, settled: true }), "Checked out");
  assert.equal(pressLabel("check-in", idle, { doing: "check-in", sending: false, settled: false }), "Check in"); // saved on this device, not sent
  assert.equal(pressLabel("check-out", "Check out", { doing: "check-in", sending: true, settled: true }), "Check out"); // another button
});
