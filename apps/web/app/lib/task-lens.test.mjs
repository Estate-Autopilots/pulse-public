import assert from "node:assert/strict";
import test from "node:test";
import { firstLens, inLens, lensCount, lensRows } from "./task-lens.mjs";

const me = "me", kazuk = "kazuk", asha = "asha";
const task = (over) => ({ id: "t", status: "open", assigneeId: me, createdBy: me, reviewerId: null, assignerId: me, ...over });

test("Assigned to me is work someone else gave me; my own notes are under I created", () => {
  const given = task({ id: "given", createdBy: kazuk, assignerId: kazuk, reviewerId: kazuk });
  const own = task({ id: "own" });
  const handed = task({ id: "handed", createdBy: asha, assignerId: kazuk });
  const tracker = task({ id: "tracker", createdBy: null, assignerId: null });
  assert.equal(inLens("assigned", given, me), true);
  assert.equal(inLens("assigned", handed, me), true);
  assert.equal(inLens("assigned", tracker, me), true);
  assert.equal(inLens("assigned", own, me), false);
  assert.equal(inLens("created", own, me), true);
  assert.equal(inLens("created", given, me), false);
  for (const t of [given, own, handed, tracker]) assert.equal(inLens("all", t, me), true);
});

test("I created and I'm reviewing hold other people's tasks, never mine twice", () => {
  const forAsha = task({ id: "forAsha", assigneeId: asha, createdBy: me, assignerId: me, reviewerId: me });
  const pooled = task({ id: "pooled", assigneeId: null, createdBy: me, assignerId: me, reviewerId: me });
  const mineToReview = task({ id: "mineToReview", reviewerId: me });
  assert.equal(inLens("created", forAsha, me), true);
  assert.equal(inLens("created", pooled, me), true);
  assert.equal(inLens("reviewing", forAsha, me), true);
  assert.equal(inLens("reviewing", mineToReview, me), false);
  assert.equal(inLens("assigned", forAsha, me), false);
  assert.equal(inLens("all", forAsha, me), false);
});

test("the default lens is Assigned to me, else All mine; counts are open work only", () => {
  const rows = [task({ id: "a", createdBy: kazuk, assignerId: kazuk }), task({ id: "b", createdBy: kazuk, assignerId: kazuk, status: "done" }), task({ id: "c" })];
  assert.equal(firstLens(undefined, rows, me), "assigned");
  assert.equal(firstLens("reviewing", rows, me), "reviewing");
  assert.equal(firstLens("nonsense", [task({ id: "c" })], me), "all");
  assert.equal(lensCount("assigned", rows, me), 1);
  assert.equal(lensCount("all", rows, me), 2);
  assert.equal(firstLens(undefined, [], null), "all");
});

test("lensRows lists each task once", () => {
  const a = task({ id: "a" }), b = task({ id: "b", assigneeId: asha });
  assert.deepEqual(lensRows({ rows: [a], created: [b], reviewing: [b] }).map((t) => t.id), ["a", "b"]);
  assert.deepEqual(lensRows({ rows: [a] }).map((t) => t.id), ["a"]);
});
