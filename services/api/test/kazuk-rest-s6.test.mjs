import assert from "node:assert/strict";
import test from "node:test";
import { coverNote, coverPolicyInput, coverTimes } from "../dist/leave-cover.js";

test("the cover rule takes 1 to 168 whole hours and an explicit yes for required", () => {
  assert.deepEqual(coverPolicyInput({ hours: 24, required: true }), { hours: 24, required: true, sop: null });
  assert.deepEqual(coverPolicyInput({ hours: "12", required: "yes" }), { hours: 12, required: false, sop: null });
  for (const hours of [0, 169, 2.5, "x", undefined]) assert.throws(() => coverPolicyInput({ hours }), /1 to 168 hours/);
  assert.throws(() => coverPolicyInput(null), /1 to 168 hours/);
});

test("a cover note is one short line", () => {
  assert.equal(coverNote("  Synthetic\nhandover\u0007notes "),"Synthetic handover notes");
  assert.equal(coverNote("x".repeat(400)).length, 300);
  assert.equal(coverNote(42), "");
});

test("HR's steps are text, up to 4,000 characters; empty goes back to the standard steps", () => {
  assert.equal(coverPolicyInput({ hours: 24, sop: "  1. Synthetic step\r\n2. Another  " }).sop, "1. Synthetic step\n2. Another");
  assert.equal(coverPolicyInput({ hours: 24, sop: "" }).sop, "");
  assert.throws(() => coverPolicyInput({ hours: 24, sop: "x".repeat(4001) }), /4,000/);
  assert.throws(() => coverPolicyInput({ hours: 24, sop: 7 }), /as text/);
});

test("the hours covered are two HH:MM times or none", () => {
  assert.deepEqual(coverTimes(undefined, ""), [null, null]);
  assert.deepEqual(coverTimes("09:30", "18:30"), ["09:30", "18:30"]);
  assert.throws(() => coverTimes("09:30", null), /both times/);
  assert.throws(() => coverTimes("9.30", "18:30"), /such as 10:00/);
});
