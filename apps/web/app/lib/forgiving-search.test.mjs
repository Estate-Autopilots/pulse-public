import test from "node:test";
import assert from "node:assert/strict";
import { rank, score, squash, words } from "./forgiving-search.mjs";

// Synthetic catalogue in the shape Willow Lane described (BILLING-WL, 4 Nov 2026).
const items = [
  { name: "Pure Power 12", code: "PP-12" },
  { name: "Pure Power 120.0", code: "PP-120" },
  { name: "Pure Power 5.0", code: "PP-5" },
  { name: "Pure Power 20.0", code: "PP-20" },
  { name: "Solar panel 540 W", code: "SP540" },
  { name: "Installation", code: null },
];
const fields = (i) => [i.name, i.code];
const names = (q) => rank(items, q, fields).map((i) => i.name);

test("case, spaces and punctuation never matter", () => {
  assert.equal(squash("Pure Power 5.0"), "purepower50");
  assert.equal(squash(" pure-power  5.0 "), "purepower50");
  assert.deepEqual(words("pure power5.0"), ["pure", "power50"]);
  for (const q of ["purepower 5", "Pure Power 5.0", "pure power5.0", "PUREPOWER5", "pure power 5"]) assert.equal(names(q)[0], "Pure Power 5.0", q);
});

test("a code or a number finds its item", () => {
  assert.equal(names("pp-20")[0], "Pure Power 20.0");
  assert.equal(names("PP20")[0], "Pure Power 20.0");
  assert.equal(names("540")[0], "Solar panel 540 W");
  assert.equal(names("120")[0], "Pure Power 120.0");
});

test("words in any order, closest first, nothing for nonsense", () => {
  assert.equal(names("power 12 pure")[0], "Pure Power 12");
  assert.deepEqual(names("pure power 12"), ["Pure Power 12", "Pure Power 120.0"], "the exact model before the longer one");
  assert.deepEqual(names("zzz"), []);
  assert.equal(names("").length, items.length, "an empty search lists everything");
});

test("names, companies and phone numbers score like the database does", () => {
  assert.equal(score("Asohiv Mifos", ["Asohiv Mifos", null]), 100);
  assert.equal(score("asohiv", ["Asohiv Mifos"]), 85);
  assert.equal(score("mifos asohiv", ["Asohiv Mifos"]), 50);
  assert.equal(score("Mifos", ["Asohiv Mifos", "Mifos Solar Works"]), 85);
  assert.equal(score("98765 43210", ["Asohiv Mifos", "+91 98765-43210"]), 70);
  assert.equal(score("Ajay", ["Ruvin Soniba", "Majestic Infra"]), 0);
});
