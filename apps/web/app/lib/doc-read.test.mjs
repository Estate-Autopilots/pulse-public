// DOCS-POLISH: the reading view's rules (doc-read.mjs). Every value is synthetic.
import assert from "node:assert/strict";
import test from "node:test";
import { initials, isNumberCell, isTotalRow, readMinutes, whenText } from "./doc-read.mjs";

test("a time is written the same whatever the machine's own zone: the company's zone decides", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  assert.equal(whenText("2026-11-14T08:02:00Z", "Asia/Kolkata", now), "14 Nov, 1:32 pm");
  assert.equal(whenText("2026-11-13T20:00:00Z", "Asia/Kolkata", now), "14 Nov, 1:30 am");
  assert.equal(whenText("2026-11-14T08:02:00Z", "America/New_York", now), "14 Nov, 3:02 am");
  assert.equal(whenText("2025-12-31T18:45:00Z", "Asia/Kolkata", now), "1 Jan, 12:15 am", "1 Jan 2026 is this year");
  assert.equal(whenText("2025-06-01T06:30:00Z", "Asia/Kolkata", now), "1 Jun 2025, 12:00 pm");
  assert.equal(whenText("not a date", "Asia/Kolkata", now), "");
  assert.equal(whenText("2026-11-14T08:02:00Z", "Not/A_Zone", now), "14 Nov, 8:02 am", "an unknown zone falls back to UTC");
});

test("read time, number cells, total rows and initials", () => {
  assert.equal(readMinutes(""), 1);
  assert.equal(readMinutes(Array.from({ length: 1320 }, () => "word").join(" ")), 6);
  for (const t of ["₹1,24,500", "12%", "-3.5", "4.2 L", "₹1.1 Cr", "40,000/-", "Rs. 900", "1,248", "18k"]) assert.ok(isNumberCell(t), t);
  for (const t of ["", "Pune", "Week 1", "12 kits", "2 years", "A1", "—"]) assert.ok(!isNumberCell(t), t);
  assert.ok(isTotalRow("Total") && isTotalRow("Grand total") && isTotalRow("Subtotal") && !isTotalRow("Totally new"));
  assert.equal(initials("Kedab Mifos"), "KM"); assert.equal(initials("Diya"), "DI"); assert.equal(initials(""), ""); assert.equal(initials(" Aarav  Kalah Shah "), "AS");
});
