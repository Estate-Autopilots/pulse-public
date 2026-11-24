// QA-1D step 4b: the long QA company's fixture is what R14 asks for (QA-SYSTEM-RESEARCH §4.4): 40-character names,
// Devanagari, long titles, "100%", crore amounts, quotations in nine stages, and every value inside what the API takes.
// node --test tools/qa/vitals/long-org.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEVANAGARI, STAGES, longFixture } from "./long-org.mjs";

const len = (s) => [...s].length;

test("names are 40 characters or more, in English, Hindi and Marathi, and fit the fields", () => {
  const f = longFixture();
  assert.ok(f.people.length >= 40);
  for (const p of f.people) {
    assert.ok(len(p.name) >= 40 && len(p.name) <= 80, p.name); // People: name, 80 at most
    assert.ok(len(p.role) <= 80, p.role);
  }
  assert.equal(new Set(f.people.map((p) => p.name)).size, f.people.length, "no two people share a name");
  const dev = f.people.filter((p) => DEVANAGARI.test(p.name)).length;
  assert.ok(dev >= f.people.length / 3 && dev < f.people.length, `Devanagari and Latin names both (${dev})`);
  for (const c of f.clients) {
    assert.ok(len(c.name) >= 40 && len(c.name) <= 120, c.name);
    assert.ok(len(c.contact) >= 40, c.contact);
  }
  assert.ok(f.clients.some((c) => DEVANAGARI.test(c.name)) && f.clients.some((c) => !DEVANAGARI.test(c.name)));
  for (const p of f.projects) assert.ok(len(p.title) >= 40 && len(p.title) <= 160, p.title);
});

test("tasks: many, different, long, with Devanagari and 100%", () => {
  const { tasks } = longFixture();
  assert.ok(tasks.length >= 100);
  assert.equal(new Set(tasks.map((t) => t.title)).size, tasks.length);
  for (const t of tasks) assert.ok(len(t.title) >= 40 && len(t.title) <= 120, t.title);
  assert.ok(tasks.some((t) => DEVANAGARI.test(t.title)) && tasks.some((t) => t.title.includes("100%")));
  assert.deepEqual(new Set(tasks.map((t) => t.priority)), new Set(["low", "normal", "high", "urgent"]));
});

test("quotations: two in each of the nine stages, crore amounts in paise inside the API's limits", () => {
  const { quotes, settings } = longFixture();
  assert.equal(STAGES.length, 9);
  for (const s of STAGES) assert.equal(quotes.filter((q) => q.stage === s).length, 2, s);
  assert.equal(new Set(quotes.map((q) => q.key)).size, quotes.length);
  for (const q of quotes) {
    assert.match(q.note, new RegExp(`^\\[${q.key}\\] `), "the note finds the quotation again on a rerun");
    let total = 0;
    for (const l of q.lines) {
      assert.ok(Number.isInteger(l.rate) && l.rate >= 0 && l.rate <= 1e12, `rate ${l.rate}`); // paise, as erp-model.ts checks
      assert.ok(len(l.description) <= 300 && len(l.details) <= 1000 && len(l.unit) <= 20);
      total += l.discountPercent === 100 ? 0 : l.qty * l.rate;
    }
    assert.ok(total >= 1e7 * 100, `${q.key} comes to at least ₹1 crore`);
  }
  assert.ok(quotes.some((q) => q.lines.some((l) => l.discountPercent === 100)), "a 100% discount line");
  assert.ok(quotes.some((q) => DEVANAGARI.test(q.note)));
  assert.equal(settings.stateCode, "27");
  assert.ok(len(settings.legalName) >= 40 && len(settings.legalName) <= 200);
});

test("the fixture is the same on every run (a rerun finds what the last one made)", () => {
  assert.deepEqual(longFixture(), longFixture());
});
