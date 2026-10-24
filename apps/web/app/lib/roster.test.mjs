import { test } from "node:test";
import assert from "node:assert/strict";
import { workedToday } from "./roster.mjs";

test("the HR roster adds the day's sessions", () => {
  assert.equal(workedToday({ sessions: [{ worked: 120 }, { worked: 95 }], entry: { worked: 95 } }), 215);
});

test("an older service without per-session rows still shows the day (no crash)", () => {
  // The exact pulse-dev payload of 9 Oct 2026: roster rows with an entry and no `sessions` field.
  assert.equal(workedToday({ entry: { worked: 480 } }), 480);
  assert.equal(workedToday({ sessions: null, entry: { worked: 30 } }), 30);
  assert.equal(workedToday({ sessions: [], entry: null }), 0);
  assert.equal(workedToday(undefined), 0);
});
