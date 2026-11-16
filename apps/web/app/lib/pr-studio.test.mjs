// PR-STUDIO: PR Studio's screen helpers (lib/pr-studio.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { addDays, monthGrid, mondayOf, plainText, ratioSize, shareHref, shiftMonth, streakWords, weekGrid, wrapLines } from "./pr-studio.mjs";

test("the month's calendar is whole weeks, Monday first, covering every day of the month", () => {
  const g = monthGrid("2026-11", "2026-11-06");
  assert.equal(g[0][0].day, "2026-10-26");
  assert.ok(g.every((w) => w.length === 7));
  const days = g.flat();
  assert.equal(days.filter((d) => d.inMonth).length, 30);
  assert.equal(days.at(-1).day, "2026-12-06");
  assert.deepEqual(days.filter((d) => d.today).map((d) => d.day), ["2026-11-06"]);
  assert.ok(days.find((d) => d.day === "2026-11-05").past);
  // A month starting on a Monday starts on its 1st.
  assert.equal(monthGrid("2027-02", "2027-02-01")[0][0].day, "2027-02-01");
});

test("weeks, days and months move as calendars do", () => {
  assert.equal(mondayOf("2026-11-08"), "2026-11-02");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.deepEqual(weekGrid("2026-11-06", "2026-11-06").map((d) => d.day.slice(8)), ["02", "03", "04", "05", "06", "07", "08"]);
});

test("share links open the app with the words in, and send nothing", () => {
  assert.equal(shareHref("whatsapp", "*Hi* there"), "https://wa.me/?text=*Hi*%20there");
  assert.match(shareHref("telegram", "a&b"), /text=a%26b$/);
  assert.equal(shareHref("email", "Body", "Update"), "mailto:?subject=Update&body=Body");
  assert.ok(shareHref("x", "x".repeat(400)).length < 330);
  assert.match(shareHref("linkedin", "anything"), /^https:\/\/www\.linkedin\.com\//);
});

test("WhatsApp bold and italic come out for other channels", () => {
  assert.equal(plainText("*Big news*: _today_ we shipped 3*4 things"), "Big news: today we shipped 3*4 things");
});

test("image sizes follow the audience's shape", () => {
  assert.deepEqual(ratioSize("9:16"), { width: 1080, height: 1920 });
  assert.deepEqual(ratioSize("16:9"), { width: 1920, height: 1080 });
  assert.deepEqual(ratioSize("4:5"), { width: 1080, height: 1350 });
});

test("lines wrap to the width and the last kept line ends with an ellipsis", () => {
  const measure = (s) => s.length * 10;
  assert.deepEqual(wrapLines(measure, "one two three four", 90, 3), ["one two", "three", "four"]);
  const cut = wrapLines(measure, "alpha beta gamma delta epsilon zeta", 110, 2);
  assert.equal(cut.length, 2);
  assert.ok(cut[1].endsWith("…"));
  assert.equal(streakWords(0), "Tell one thing today to start a streak");
  assert.equal(streakWords(4), "4 days told in a row");
});
