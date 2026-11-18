// INSIGHTS-2 (1082): the redesigned Insights reads only the filters it knows; anything else never reaches the database.
import test from "node:test";
import assert from "node:assert/strict";
import { actionKey, libraryFilter, opsFilter, scopeOf, since } from "../dist/insight-cards.js";

const id = "0b6f5c1e-2a3d-4e5f-8a9b-1c2d3e4f5a6b";
const today = new Date("2026-10-26T10:00:00Z");

test("a period becomes the first day it covers", () => {
  assert.equal(since("90d", today), "2026-07-28");
  assert.equal(since("12m", today), "2025-10-26");
  assert.equal(since("2025", today), "2025-01-01");
  assert.equal(since("all", today), null);
  assert.equal(since(undefined, today), null);
  assert.equal(since("forever", today), null);
});

test("ops filters: known values pass, the rest is dropped", () => {
  assert.deepEqual(opsFilter({ period: "90d", pod: "Pod 1", segment: "R", client: id, fresh: "1" }, today),
    { since: "2026-07-28", pod: "Pod 1", segment: "R", client: id, fresh: "1" });
  assert.deepEqual(opsFilter({ pod: "x'; drop table task; --", client: "nope", segment: "<b>" }, today), {});
});

test("a scope names one subject", () => {
  assert.deepEqual(scopeOf({ person: id }), { person_id: id });
  assert.deepEqual(scopeOf({ client: id, person: "x" }), { client_id: id });
  assert.equal(scopeOf({ person: "x" }), null);
});

test("library filters are bounded", () => {
  assert.deepEqual(libraryFilter({ q: "approval", family: "contrast", area: "who_waits", status: "confirmed", sort: "effect", minValue: "5000", limit: "999", offset: "60" }),
    { q: "approval", family: "contrast", area: "who_waits", status: "confirmed", sort: "effect", minValue: 5000, limit: 200, offset: 60 });
  assert.deepEqual(libraryFilter({ family: "Contrast!", area: "a", status: "retired", sort: "random", minValue: "-1", limit: "abc" }), {});
});

test("an action key fits the recommendation column", () => {
  const k = actionKey("pattern", "p-" + "a".repeat(78));
  assert.match(k, /^[a-z0-9_-]{2,40}$/);
  assert.notEqual(actionKey("pattern", "x1"), actionKey("card", "x1"));
});
