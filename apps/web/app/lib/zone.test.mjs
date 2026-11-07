import { test } from "node:test";
import assert from "node:assert/strict";
import { weekday, zoneDay, zoneTime } from "./zone.mjs";

test("R51: a company's day and its due time, in India, London and Pago Pago", () => {
  const at = Date.parse("2026-10-20T20:00:00Z");
  assert.equal(zoneDay("Asia/Kolkata", at), "2026-10-21");
  assert.equal(zoneDay("Europe/London", at), "2026-10-20");
  assert.equal(zoneDay("Pacific/Pago_Pago", new Date(at)), "2026-10-20");
  // A due time typed as 18:00 is 18:00 on the company's clock (EA: 12:30 UTC, as the old +05:30 gave).
  assert.equal(zoneTime("2026-10-20", "Asia/Kolkata", "18:00").toISOString(), "2026-10-20T12:30:00.000Z");
  assert.equal(zoneTime("2026-10-20", "Europe/London", "18:00").toISOString(), "2026-10-20T17:00:00.000Z");
  assert.equal(zoneTime("2026-12-20", "Europe/London", "18:00").toISOString(), "2026-12-20T18:00:00.000Z");
  assert.equal(zoneTime("2026-10-20", "Pacific/Pago_Pago", "18:00").toISOString(), "2026-10-21T05:00:00.000Z");
  assert.equal(zoneTime("2026-10-25", "Europe/London").toISOString(), "2026-10-24T23:00:00.000Z");
  for (const zone of ["Asia/Kolkata", "Europe/London", "America/New_York"]) for (const day of ["2026-03-08", "2026-03-29", "2026-11-01"]) assert.equal(zoneDay(zone, zoneTime(day, zone)), day);
  assert.equal(weekday("2026-10-12"), 1);
});
