import test from "node:test";
import assert from "node:assert/strict";
import { calendarYears, daysIn, dobParts, dobRange, dobValue } from "./dob.mjs";

const today = "2026-10-28";

test("a date of birth runs from 80 years ago to 16 years ago", () => {
  assert.deepEqual(dobRange(today), { min: "1946-01-01", max: "2010-10-28" });
});

test("a recent day (a stray tap on today's calendar) reads as empty, so it is chosen again", () => {
  assert.deepEqual(dobParts("2026-10-06", today), { year: "", month: "", day: "" });
  assert.deepEqual(dobParts("2031-01-01", today), { year: "", month: "", day: "" });
  assert.deepEqual(dobParts("1930-05-01", today), { year: "", month: "", day: "" });
  assert.deepEqual(dobParts("1995-02-30", today), { year: "", month: "", day: "" });
  assert.deepEqual(dobParts(null, today), { year: "", month: "", day: "" });
  assert.deepEqual(dobParts("1995-07-14", today), { year: "1995", month: "07", day: "14" });
});

test("months have their own lengths, leap years included", () => {
  assert.equal(daysIn("2000", "02"), 29);
  assert.equal(daysIn("1999", "02"), 28);
  assert.equal(daysIn("1999", "04"), 30);
  assert.equal(daysIn("", ""), 31);
});

test("the value is whole or empty, and says what is wrong", () => {
  assert.deepEqual(dobValue({ year: "1995", month: "07", day: "14" }, today), { iso: "1995-07-14", day: "14", problem: "" });
  assert.equal(dobValue({ year: "1995", month: "", day: "14" }, today).iso, "");
  assert.match(dobValue({ year: "", month: "", day: "" }, today).problem, /year, month and day/);
  // 31 February is no day: the day is dropped and has to be chosen again.
  assert.deepEqual(dobValue({ year: "1999", month: "02", day: "31" }, today).iso, "");
  assert.match(dobValue({ year: "2012", month: "01", day: "01" }, today).problem, /less than 16 years/);
  assert.match(dobValue({ year: "2027", month: "01", day: "01" }, today).problem, /future/);
});

// BUGFIX #19 (Omoza, 28 Oct 2026: "open the date of birth and try to change the year"): the profile's calendar only had
// month arrows. A date-of-birth field now has a year list in its header, 80 to 16 years back, newest first.
test("the date-of-birth calendar lists its years, newest first, within the allowed range", () => {
  const { min, max } = dobRange("2026-11-06");
  const years = calendarYears("2026-11-06", min, max);
  assert.equal(years[0], "2010");
  assert.equal(years.at(-1), "1946");
  assert.equal(years.length, 65);
  assert.ok(years.includes("1995"));
  assert.equal(calendarYears("2026-11-06").length, 101);
});

test("the profile's date-of-birth fields use the calendar with the year list", async () => {
  const { readFileSync } = await import("node:fs");
  const src = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  const info = src("../people/[id]/my-info.tsx");
  assert.equal(info.match(/label: "Date of birth", type: "date"[^}]*birth: true/g)?.length, 2);
  assert.match(src("../records.tsx"), /f\.birth \? \{ years: true, quick: false as const, \.\.\.dobRange\(/);
  assert.match(src("../kit/date-picker.tsx"), /aria-label="Year"[^>]*onChange=\{\(e\) => setMonth\(/);
});
