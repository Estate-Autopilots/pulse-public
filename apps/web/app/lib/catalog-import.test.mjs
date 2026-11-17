import assert from "node:assert/strict";
import test from "node:test";
import { fromSheet, guessMapping, hasHeader, mapRows, parseTable, planLine, rupees } from "./catalog-import.mjs";

const CSV = `Service,Per,Price,GST,SAC code,Type,Notes
Reel edit,per video,"₹4,500",18%,998361,Video,
"Video shoot, full day",per day,18000,18%,998361,Video,"says ""hi"""
`;

test("a CSV with quotes, commas inside a cell and a header", () => {
  const t = parseTable(CSV);
  assert.equal(t.length, 3);
  assert.deepEqual(t[2], ["Video shoot, full day", "per day", "18000", "18%", "998361", "Video", 'says "hi"']);
  assert.equal(hasHeader(t), true);
});

test("a table pasted from a sheet (tabs) or a doc (pipes)", () => {
  assert.deepEqual(parseTable("Item\tRate\nRoom plan\t12500\n\n"), [["Item", "Rate"], ["Room plan", "12500"]]);
  const md = "| Item | Rate |\n|---|---|\n| Site visit | 2,500 |";
  assert.deepEqual(parseTable(md), [["Item", "Rate"], ["Site visit", "2,500"]]);
  assert.deepEqual(parseTable("a;b\n1;2"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseTable(""), []);
});

test("columns are matched by their names", () => {
  const t = parseTable(CSV);
  assert.deepEqual(guessMapping(t[0], t.slice(1)), { name: 0, unit: 1, rate: 2, gst: 3, sac: 4, category: 5, stock: -1 });
  assert.deepEqual(guessMapping(["Particulars", "UOM", "Amount", "Tax %", "HSN", "Group"], []), { name: 0, unit: 1, rate: 2, gst: 3, sac: 4, category: 5, stock: -1 });
});

test("without a header, columns are matched by what their values look like", () => {
  const body = [["Reel edit", "4500", "18", "998361"], ["Room plan", "12,500", "18%", "998391"]];
  assert.equal(hasHeader(body), false);
  const m = guessMapping(["A", "B", "C", "D"], body);
  assert.deepEqual([m.name, m.rate, m.gst, m.sac, m.unit, m.category], [0, 1, 2, 3, -1, -1]);
});

test("rows carry only the mapped fields; Excel cells become text", () => {
  const m = { name: 0, unit: -1, rate: 1, gst: -1, sac: -1, category: -1, stock: -1 };
  assert.deepEqual(mapRows([["Reel edit", "4500", "x"]], m), [{ name: "Reel edit", unit: "", rate: "4500", gst: "", sac: "", category: "", stock: "" }]);
  assert.deepEqual(fromSheet([["Reel edit", 4500, null], [null, null, undefined]]), [["Reel edit", "4500", ""]]);
});

test("the plan in one line, rupees the Indian way", () => {
  assert.equal(planLine({ created: 42, updated: 6, unchanged: 0, skipped: [{ row: 1, name: "", why: "No rate" }, { row: 2, name: "", why: "No rate" }] }), "42 new · 6 updated · 2 skipped (no rate)");
  assert.equal(planLine({ created: 1, updated: 0, unchanged: 3, skipped: [] }), "1 new · 0 updated · 3 already the same");
  assert.equal(rupees(12450000), "₹1,24,500");
  assert.equal(rupees(450050), "₹4,500.5");
});

// WL-ONBOARD-FIX (17 Nov 2026): prices and stock kept in one sheet (synthetic items).
test("a Stock column is matched and carried; the plan says when a serial-numbered item's stock is left alone", () => {
  const t = parseTable("Item,Rate,GST,In stock\nTEST battery 12,361903.81,5,12\nTEST panel,1000,18,0\n");
  const m = guessMapping(t[0], t.slice(1));
  assert.deepEqual([m.name, m.rate, m.gst, m.stock], [0, 1, 2, 3]);
  assert.deepEqual(mapRows(t.slice(1), m)[0], { name: "TEST battery 12", unit: "", rate: "361903.81", gst: "5", sac: "", category: "", stock: "12" });
  assert.equal(guessMapping(["Name", "Price", "Qty"], []).stock, 2);
  assert.equal(planLine({ created: 0, updated: 2, unchanged: 0, skipped: [], stockLeft: ["Inverter X"] }), "0 new · 2 updated · stock not set for 1 serial-numbered item (count them on the item)");
});
