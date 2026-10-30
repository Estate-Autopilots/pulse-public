// WA-INTEL (1070): Insights → From the chats reads only the filters it knows; anything else never reaches the database.
import test from "node:test";
import assert from "node:assert/strict";
import { intelFilter } from "../dist/wa-intel.js";

const id = "0b6f5c1e-2a3d-4e5f-8a9b-1c2d3e4f5a6b";

test("the summary is the default part", () => {
  assert.deepEqual(intelFilter({}), { part: "summary" });
  assert.deepEqual(intelFilter({ part: "everything" }), { part: "summary" });
});

test("known filters pass, unknown values are dropped", () => {
  assert.deepEqual(intelFilter({ part: "learning", kind: "decision", verdict: "bad", client: id, person: "not-a-uuid", category: "budget", limit: "50" }),
    { part: "learning", kind: "decision", verdict: "bad", client: id, category: "budget", limit: 50 });
  assert.deepEqual(intelFilter({ part: "learning", kind: "drop table", verdict: "great", category: "Budget'; --" }), { part: "learning" });
  assert.deepEqual(intelFilter({ part: "work", state: "accepted", stale: "true" }), { part: "work", state: "accepted", stale: true });
  assert.deepEqual(intelFilter({ part: "work", state: "deleted", stale: "maybe" }), { part: "work" });
  assert.deepEqual(intelFilter({ part: "team", side: "client" }), { part: "team", side: "client" });
});

test("the limit is capped and must be positive", () => {
  assert.equal(intelFilter({ part: "work", limit: "100000" }).limit, 1000);
  assert.equal(intelFilter({ part: "work", limit: "-3" }).limit, undefined);
  assert.equal(intelFilter({ part: "work", limit: "abc" }).limit, undefined);
});
