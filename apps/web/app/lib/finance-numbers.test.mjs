// FINANCE-TRUTH: the words and money format of Finance → Numbers and My sales.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PERIODS, dueText, monthName, periodHref, rupees, span, statusLabel } from "./finance-numbers.mjs";

test("paise read as whole rupees the Indian way", () => {
  assert.equal(rupees(1234567800), "₹1,23,45,678");
  assert.equal(rupees(-50000), "−₹500");
  assert.equal(rupees(null), "₹0");
  assert.equal(rupees(149), "₹1");
});

test("months and periods in words", () => {
  assert.equal(monthName("2026-04"), "Apr 2026");
  assert.equal(monthName(undefined), "");
  assert.equal(span("2026-04", "2026-11"), "Apr 2026 – Nov 2026");
  assert.equal(span("2026-11", "2026-11"), "Nov 2026");
  assert.deepEqual(PERIODS.map((p) => p.key), ["month", "last", "quarter", "fy", "lastfy"]);
  assert.equal(periodHref("/finance?tab=numbers", "fy"), "/finance?tab=numbers&period=fy");
  assert.equal(periodHref("/sales", "last", { person: "p1", empty: "" }), "/sales?person=p1&period=last");
});

test("what is due says base and GST apart", () => {
  assert.equal(dueText(0, 0), "Nothing due");
  assert.equal(dueText(100000, 18000), "₹1,000 + GST ₹180 due");
  assert.equal(dueText(0, 18000), "GST ₹180 still to come");
  assert.equal(dueText(100000, 0), "₹1,000 due");
  assert.equal(statusLabel("part_paid"), "Part paid");
});
