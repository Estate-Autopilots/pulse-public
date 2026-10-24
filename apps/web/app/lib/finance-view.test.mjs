import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bullets, costMix, dayName, inr, inrShort, kpis, monthName, monthSpan, sortRows, statementNeed, supplier, toCsv, topClients, trend } from "./finance-view.mjs";

// The wholly synthetic FIN-LIVE fixture the browser tests use (invented names and amounts).
const model = JSON.parse(readFileSync(new URL("../../../../tests/e2e/fixtures/finance-live.json", import.meta.url), "utf8")).model;

test("rupees read in lakh and crore, axes with one decimal at most", () => {
  assert.equal(inr(123456), "₹1.23 L");
  assert.equal(inr(123456789), "₹12.35 Cr");
  assert.equal(inr(-42000), "−₹42,000");
  assert.equal(inr(null), "Unknown");
  assert.equal(inrShort(1000000), "₹10 L");
  assert.equal(inrShort(250000), "₹2.5 L");
  assert.equal(inrShort(40000), "₹40k");
  assert.equal(monthName("2026-09"), "Sep 2026", "never en-IN's “Sept”");
  assert.equal(dayName("2025-10-07"), "7 Oct 2025");
  assert.equal(monthSpan(["2026-07", "2026-08", "2026-09"]), "Jul–Sep 2026");
  assert.equal(monthSpan(["2025-11", "2026-01"]), "Nov 2025–Jan 2026");
  assert.equal(supplier("Kazuk: Axis Bank export (or CA Pukapafa: Tally)"), "Kazuk");
});

test("six tiles; a figure the sources cannot support says what is needed and who supplies it", () => {
  const t = kpis(model);
  assert.deepEqual(t.map((k) => k.key), ["revenue", "collected", "overdue", "costs", "burn", "cash"]);
  assert.equal(t[0].label, "Revenue · Sep 2026", "the last complete month, not the month just started");
  assert.equal(t[1].label, "Collected · Sep 2025", "a month the bank lines only partly cover is skipped");
  assert.equal(t[5].value, "Statement needed");
  assert.match(t[5].note, /7 Oct 2025 — Kazuk/);
  assert.equal(t[3].up, "bad", "a rise in costs is bad news");
});

test("the brief is one sentence per item with one bold figure; the paragraph stays for the details", () => {
  const b = bullets(model);
  assert.ok(b.length >= 5 && b.length <= 7);
  for (const item of b) {
    const sentence = `${item.before}${item.figure}${item.after}`;
    assert.ok(item.figure.length > 0 && sentence.split(/(?<=\.)\s+(?=[A-Z])/).length === 1, `one sentence: ${sentence}`);
    assert.ok(sentence.length < 140, `short: ${sentence}`);
    assert.ok(item.paragraph.length > sentence.length / 2, "the model's paragraph is kept for Details");
    assert.match(item.confidence, /high|medium|low/);
  }
  assert.equal(b[1].figure, inr(model.collections.overdue.confirmed.amount));
  assert.equal(b.find((x) => x.key === "compliance").href, "/finance/desk");
});

test("eighteen months of revenue and costs; unknown months stay unknown", () => {
  const t = trend(model, 18);
  assert.equal(t.length, 18);
  assert.equal(t.at(-1).month, "2026-09");
  assert.equal(t.at(-1).cost, null, "no cost sheet for September yet");
  assert.ok(t.some((p) => p.revenue !== null && p.cost !== null));
});

test("cost mix and top clients add up", () => {
  const mix = costMix(model);
  assert.ok(Math.abs(mix.items.reduce((n, x) => n + x.share, 0) - 1) < 1e-9);
  assert.equal(mix.items[0].label, "Payroll");
  const top = topClients(model, 5);
  assert.equal(top.items.length, 5);
  assert.ok(top.items[0].invoiced >= top.items[4].invoiced);
  assert.equal(statementNeed(model).what, "Upload Axis statements after 5 Oct 2025");
});

test("CSV keeps numbers plain and neutralises spreadsheet formulas", () => {
  const csv = toCsv([{ key: "a", label: "Client" }, { key: "b", label: "Amount" }], [{ a: "Beta, Homes", b: 123456.5 }, { a: "=HYPERLINK(1)", b: null }]);
  assert.equal(csv, 'Client,Amount\r\n"Beta, Homes",123456.5\r\n\'=HYPERLINK(1),\r\n');
});

test("sorting puts unknowns last in either direction", () => {
  const rows = [{ k: 3 }, { k: null }, { k: 10 }, { k: 1 }];
  assert.deepEqual(sortRows(rows, "k", "desc").map((r) => r.k), [10, 3, 1, null]);
  assert.deepEqual(sortRows(rows, "k", "asc").map((r) => r.k), [1, 3, 10, null]);
  assert.deepEqual(sortRows([{ k: "INV-10" }, { k: "INV-9" }], "k", "asc").map((r) => r.k), ["INV-9", "INV-10"]);
});
