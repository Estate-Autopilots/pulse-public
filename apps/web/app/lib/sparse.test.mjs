import { test } from "node:test";
import assert from "node:assert/strict";
import { change, sparse } from "./sparse.mjs";

test("a chart needs three points with a value; fewer are said in words", () => {
  const week = (values) => values.map((value, i) => ({ label: `w${i}`, value }));
  assert.deepEqual(sparse(week([0, 0, 0])), [], "nothing at all");
  assert.deepEqual(sparse(week([0, 9, 0])).map((p) => p.value), [9], "one lonely bar");
  assert.deepEqual(sparse(week([12, 0, 9])).map((p) => p.value), [12, 9], "two bars become a comparison");
  assert.equal(sparse(week([1, 2, 3])), null, "three points draw the chart");
  assert.equal(sparse([{ n: 4 }, { n: 5 }, { n: 6 }, { n: 0 }], (p) => p.n), null, "custom value reader");
});

test("two values are compared in plain words", () => {
  assert.equal(change(12, 9), "Down 3 (−25%)");
  assert.equal(change(3, 4), "Up 1 (+33%)");
  assert.equal(change(5, 5), "Same");
  assert.equal(change(0, 2), "Up 2");
});
