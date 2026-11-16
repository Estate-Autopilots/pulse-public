// GROWTH-LOOP slice 5: the price-list import's row checks (the screen checks the same; this is the server's word).
import assert from "node:assert/strict";
import test from "node:test";
import { cleanRows, gstRate, kindOf, paise, sheetCsvUrl } from "../dist/catalog-import.js";

test("rates are read the way people type them, into paise", () => {
  assert.equal(paise("₹4,500"), 450000);
  assert.equal(paise("Rs. 1,24,500/-"), 12450000);
  assert.equal(paise("4500.5"), 450050);
  assert.equal(paise(18000), 1800000);
  assert.equal(paise("abc"), null);
  assert.equal(paise("-5"), null);
  assert.equal(paise(""), null);
});

test("GST % is one of India's rates; empty means 18", () => {
  assert.equal(gstRate("18%"), 18);
  assert.equal(gstRate("GST 12"), 12);
  assert.equal(gstRate("0.18"), 18);
  assert.equal(gstRate(""), 18);
  assert.equal(gstRate("0"), 0);
  assert.equal(gstRate("17"), null);
});

test("every row is checked, and skipped rows say why", () => {
  const r = cleanRows([
    { name: "Reel edit", unit: "per video", rate: "₹4,500", gst: "18%", sac: "998361", category: "Video" },
    { name: "  Room   plan ", rate: "12500", gst: "", sac: "", category: "" },
    { name: "", rate: "100" },
    { name: "No price", rate: "" },
    { name: "Odd GST", rate: "10", gst: "17%" },
    { name: "Bad code", rate: "10", sac: "99-83" },
    { name: "reel edit", rate: "1" },
  ]);
  assert.deepEqual(r.rows, [
    { name: "Reel edit", unit: "per video", price: 450000, gstRate: 18, sac: "998361", category: "Video" },
    { name: "Room plan", unit: "nos", price: 1250000, gstRate: 18, sac: null, category: null },
  ]);
  assert.deepEqual(r.skipped.map((s) => [s.row, s.why]), [[3, "No name"], [4, "No rate"], [5, "GST % is not 0, 5, 12, 18, 28 or another GST rate"],
    [6, "HSN/SAC is 4 to 8 digits"], [7, "The same name is in the list twice"]]);
  assert.throws(() => cleanRows("nope"), /Send the rows/);
  assert.throws(() => cleanRows(Array(2001).fill({ name: "x", rate: 1 })), /up to 2,000/);
});

test("a goods HSN makes a product, a service SAC (99…) or none a service", () => {
  assert.equal(kindOf("998361"), "service");
  assert.equal(kindOf(null), "service");
  assert.equal(kindOf("9403"), "product");
});

test("only a Google Sheets link becomes a CSV export address", () => {
  assert.equal(sheetCsvUrl("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=42"),
    "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/export?format=csv&gid=42");
  assert.equal(sheetCsvUrl("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit"),
    "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/export?format=csv");
  assert.equal(sheetCsvUrl("https://evil.example/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345"), null);
  assert.equal(sheetCsvUrl("http://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345"), null);
});
