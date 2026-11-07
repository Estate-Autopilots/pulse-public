import test from "node:test";
import assert from "node:assert/strict";
import { formatDay, parseDay } from "./day-text.mjs";

test("a day reads dd MMM yyyy", () => {
  assert.equal(formatDay("2026-10-24"), "24 Oct 2026");
  assert.equal(formatDay("2027-01-05"), "5 Jan 2027");
  assert.equal(formatDay(""), "");
  assert.equal(formatDay(null), "");
  assert.equal(formatDay("24/10/2026"), "");
});

test("what people type becomes the day, day first", () => {
  const today = "2026-10-24";
  assert.equal(parseDay("2026-10-24", today), "2026-10-24");
  assert.equal(parseDay("24/10/2026", today), "2026-10-24");
  assert.equal(parseDay("24-10-26", today), "2026-10-24");
  assert.equal(parseDay("4.1.2027", today), "2027-01-04");
  assert.equal(parseDay("24/10", today), "2026-10-24");
  assert.equal(parseDay("24 Oct 2026", today), "2026-10-24");
  assert.equal(parseDay("24 october", today), "2026-10-24");
  assert.equal(parseDay("1st Nov, 2026", today), "2026-11-01");
  assert.equal(parseDay("Oct 24 2026", today), "2026-10-24");
  assert.equal(parseDay("24-Oct-2026", today), "2026-10-24");
  assert.equal(parseDay("  ", today), "");
});

test("what is not a day is refused", () => {
  const today = "2026-10-24";
  assert.equal(parseDay("31/02/2026", today), null);
  assert.equal(parseDay("13/13/2026", today), null);
  assert.equal(parseDay("next friday", today), null);
  assert.equal(parseDay("24 Oc", today), null);
  assert.equal(parseDay("2026-02-30", today), null);
});

test("a typed day survives a round trip", () => {
  for (const iso of ["2026-01-01", "2026-12-31", "2028-02-29"]) assert.equal(parseDay(formatDay(iso), "2026-10-24"), iso);
});
