import assert from "node:assert/strict";
import test from "node:test";
import { cleanLines, copyLine, documentInput, isEstimate, neededLines, soldLines } from "../dist/erp-model.js";
import { applyChanges, builderEvents, cleanChanges, describeChange, rupees, splitFigures, STALE } from "../dist/quote-builder-model.js";

// QUOTE-BUILDER (owner, 19-20 Nov 2026; board 5, option C; migration 2490): your own price on a line, extra charges,
// variable charges kept apart as estimates, the AI's change card, the telemetry. Invented names and figures only (the
// board's sample: "Dorugohum Residency (sample)", Pune).
const ITEM = "0f4c2d6e-aaaa-4bbb-8ccc-0000000000a1", INV = "0f4c2d6e-aaaa-4bbb-8ccc-0000000000a2", BAT = "0f4c2d6e-aaaa-4bbb-8ccc-0000000000a3";
const MH = { placeOfSupply: "27", roundTotal: true, reverseCharge: false, zeroRated: false };
const R = (rupee) => rupee * 100;
/** The board's quotation: three items at the seller's prices, then installation, loading and transport. */
const board = (transport = { charge: "fixed" }) => cleanLines([
  { itemId: ITEM, description: "PUREPower 5 kW solar system", qty: 1, rate: R(365000), gstRate: 18, priceNote: "Festive offer" },
  { itemId: INV, description: "Hybrid inverter 5 kVA", qty: 1, rate: R(104500), gstRate: 18 },
  { itemId: BAT, description: "Lithium battery 5 kWh", qty: 2, rate: R(75000), gstRate: 18 },
  { description: "Transport", unit: "km", qty: 65, rate: R(100), gstRate: 18, ...transport },
  { description: "Installation", rate: R(12000), gstRate: 18, charge: "fixed" },
  { description: "Loading & unloading", rate: R(1500), gstRate: 18, charge: "fixed" },
]);

test("a line keeps its charge kind, confirmation and price note; a wrong one is refused in plain words", () => {
  const [solar, , , transport, install] = board({ charge: "variable" });
  assert.equal(solar.priceNote, "Festive offer"); assert.equal(solar.charge, null);
  assert.equal(transport.charge, "variable"); assert.equal(transport.confirmed, false); assert.equal(isEstimate(transport), true);
  assert.equal(install.charge, "fixed"); assert.equal(isEstimate(install), false);
  const [c] = cleanLines([{ description: "Transport", rate: 0, charge: "variable", confirmed: true, open: true }]);
  assert.equal(c.confirmed, true); assert.equal(c.open, false, "a variable charge is an estimate, never an open amount");
  assert.equal(cleanLines([{ description: "Install", rate: 100, charge: "fixed", confirmed: true }])[0].confirmed, false, "only a variable charge is confirmed");
  assert.throws(() => cleanLines([{ description: "X", rate: 0, charge: "per-km" }]), /a charge is fixed or variable/);
  assert.throws(() => cleanLines([{ description: "X", rate: 0, charge: "fixed", role: "included" }]), /not an included/);
  assert.throws(() => cleanLines([{ description: "X", rate: 1, priceNote: "a".repeat(161) }]), /price note is longer than 160/);
  const plain = cleanLines([{ description: "Old client line", rate: 100 }])[0];
  assert.deepEqual([plain.charge, plain.confirmed, plain.priceNote], [null, false, null], "an older client sends none and gets a plain line");
});

test("totals add up: the board's sample is ₹6,39,500 taxable + 18% GST = ₹7,54,610", () => {
  const { kept } = neededLines(board());
  const s = splitFigures("27", MH, kept);
  assert.equal(s.fig.taxable, R(639500));
  assert.equal(s.fig.cgst + s.fig.sgst, R(115110));
  assert.equal(s.fig.total, R(754610));
  assert.equal(s.estimate, 0);
  // Every line's figures add up to the document's, line by line.
  const sum = (k) => s.lines.reduce((n, l) => n + l[k], 0);
  assert.equal(sum("taxable"), s.fig.taxable); assert.equal(sum("cgst") + sum("sgst"), s.fig.tax);
  assert.equal(s.fig.total, s.fig.taxable + s.fig.tax + s.fig.roundOff);
});

test("a variable charge is an estimate: out of the total, figured apart with its GST, in the total once confirmed", () => {
  const { kept } = neededLines(board({ charge: "variable" }));
  const s = splitFigures("27", MH, kept);
  assert.equal(s.fig.taxable, R(633000), "transport ₹6,500 is not in the fixed total");
  assert.equal(s.fig.total, R(746940));
  assert.equal(s.estimate, R(7670), "₹6,500 + 18% GST, to be confirmed");
  assert.equal(s.lines[3].taxable, R(6500), "the estimate line keeps its own figures at its place");
  assert.equal(s.lines[4].taxable, R(12000));
  const confirmed = kept.map((l) => (l.charge === "variable" ? { ...l, rate: R(110) * 1, qty: 70, confirmed: true } : l));
  const c = splitFigures("27", MH, confirmed);
  assert.equal(c.estimate, 0);
  assert.equal(c.fig.taxable, R(633000 + 7700), "70 km × ₹110 = ₹7,700, now in the total");
});

test("rounding is explained, not lost: ₹10 + 18% = ₹11.80, total ₹12 with a round off of +₹0.20", () => {
  const s = splitFigures("27", MH, cleanLines([{ description: "Washer", rate: R(10), gstRate: 18 }]));
  assert.equal(s.lines[0].total, 1180); assert.equal(s.fig.total, 1200); assert.equal(s.fig.roundOff, 20);
  assert.equal(s.fig.total, s.fig.taxable + s.fig.tax + s.fig.roundOff);
  const inter = splitFigures("27", { ...MH, placeOfSupply: "29" }, cleanLines([{ description: "Washer", rate: R(10), qty: 3, gstRate: 18 }, { description: "Loading", rate: 333, charge: "variable" }]));
  assert.equal(inter.fig.igst, 540); assert.equal(inter.fig.total, 3500);
  assert.equal(inter.estimate, 393, "an estimate is never rounded: ₹3.33 + 18% = ₹3.93");
});

test("the customer's copy: estimates print apart, and never a base price, difference or note", () => {
  const stored = [
    { description: "Hybrid inverter 5 kVA", qty: 1, rate: R(104500), gst_rate: 18, catalogue_rate: R(110000), price_note: "Festive offer", not_needed: false },
    { description: "Transport", unit: "km", qty: 65, rate: R(100), gst_rate: 18, charge: "variable", confirmed: false, not_needed: false },
    { description: "Loading", qty: 1, rate: R(1500), gst_rate: 18, charge: "variable", confirmed: true, not_needed: false },
  ];
  const doc = documentInput({ doc_type: "quotation", status: "draft", issue_date: "2026-11-20" }, stored);
  assert.deepEqual(doc.lines.map((l) => l.description), ["Hybrid inverter 5 kVA", "Loading"]);
  assert.deepEqual(doc.estimates.map((l) => l.description), ["Transport"]);
  const printed = JSON.stringify(doc);
  for (const secret of ["110000", "11000000", "catalogue", "Festive", "priceNote", "price_note", "base"]) assert.ok(!printed.includes(secret), `the copy must not carry ${secret}`);
  assert.equal(documentInput({ doc_type: "invoice", status: "draft", issue_date: "2026-11-20" }, [stored[0]]).estimates, undefined, "no estimates key without one");
});

test("a quotation's lines carry their charges onto the proforma or invoice made from it", () => {
  const src = [{ description: "Inverter", qty: 1, rate: 100, gst_rate: 18, line_role: null }, { description: "Transport", qty: 65, unit: "km", rate: 10000, gst_rate: 18, charge: "variable", confirmed: false, price_note: null }];
  const sold = soldLines(src);
  assert.equal(sold[1].charge, "variable"); assert.equal(sold[1].confirmed, false);
  assert.equal(copyLine({ ...src[0], price_note: "Match" }).priceNote, "Match");
  assert.equal(cleanLines(sold)[1].charge, "variable", "and the receiving draft keeps them");
});

// ------------------------------------------------------------------------------------------------ the AI's change card
const draft = () => cleanLines([
  { itemId: ITEM, description: "PUREPower 5 kW solar system", qty: 1, rate: R(365000), gstRate: 18 },
  { itemId: INV, description: "Hybrid inverter 5 kVA", qty: 1, rate: R(110000), gstRate: 18 },
  { description: "Old line", rate: 100, notNeeded: true },
  { itemId: BAT, description: "Lithium battery 5 kWh", qty: 2, rate: R(75000), gstRate: 18 },
]);
const bases = [R(385000), R(110000), null, R(75000)];

test("the card: 'add transport to Hinjewadi, 65 km at ₹100 per km, and give 5% off the inverter'", () => {
  const lines = draft();
  const changes = cleanChanges([
    { op: "add_charge", description: "Transport to Hinjewadi", unit: "km", qty: 65, rate: R(100), variable: true },
    { op: "price", line: 2, percentOff: 5, note: "Asked on the call" },
  ], lines);
  assert.equal(changes[1].expect, "Hybrid inverter 5 kVA");
  assert.deepEqual(changes.map((c) => describeChange(c, lines, bases)), [
    "Add Transport to Hinjewadi · ₹100/km × 65 km · ₹6,500 (estimate, settled at the end)",
    "Hybrid inverter 5 kVA: ₹1,10,000 → ₹1,04,500 (−5%)",
  ]);
  const after = applyChanges(lines, changes, bases);
  assert.equal(lines[1].rate, R(110000), "proposing changes nothing");
  assert.equal(after[1].rate, R(104500)); assert.equal(after[1].priceNote, "Asked on the call");
  assert.equal(after.length, 5); assert.equal(after[4].charge, "variable"); assert.equal(after[4].qty, 65);
  const s = splitFigures("27", MH, neededLines(after).kept);
  assert.equal(s.fig.taxable, R(365000 + 104500 + 150000)); assert.equal(s.estimate, R(7670));
});

test("the card names lines as the person sees them (not-needed lines skipped) and refuses what does not fit", () => {
  const lines = draft();
  assert.equal(cleanChanges([{ op: "qty", line: 3, qty: 3 }], lines)[0].expect, "Lithium battery 5 kWh");
  assert.equal(applyChanges(lines, cleanChanges([{ op: "qty", line: 3, qty: 3 }], lines))[3].qty, 3);
  assert.throws(() => cleanChanges([{ op: "price", line: 4, rate: 1 }], lines), /line is 1 to 3/);
  assert.throws(() => cleanChanges([{ op: "price", line: 1, rate: 1, percentOff: 5 }], lines), /not both/);
  assert.throws(() => cleanChanges([{ op: "price", line: 1, percentOff: 120 }], lines), /percentOff/);
  assert.throws(() => cleanChanges([{ op: "edit_charge", line: 1, rate: 5 }], lines), /not an extra charge/);
  assert.throws(() => cleanChanges([{ op: "teleport", line: 1 }], lines), /op is price/);
  assert.throws(() => cleanChanges([], lines), /1 to 20/);
  assert.throws(() => cleanChanges([{ op: "add_charge", description: "Crane", rate: -1 }], lines), /amount in paise/);
  assert.throws(() => cleanChanges([{ op: "add_charge", description: "Crane", rate: 100, gstRate: 7 }], lines), /GST rate/);
});

test("Apply refuses a card the draft has moved past (ask again); remove keeps the line as not needed", () => {
  const lines = draft();
  const card = cleanChanges([{ op: "remove", line: 1 }], lines);
  assert.equal(describeChange(card[0], lines), "Take off PUREPower 5 kW solar system");
  const moved = [lines[1], lines[0], ...lines.slice(2)];
  assert.throws(() => applyChanges(moved, card), new RegExp(STALE.slice(0, 30)));
  const after = applyChanges(lines, card);
  assert.equal(after[0].notNeeded, true); assert.equal(after.length, 4);
});

test("a variable charge is confirmed by its final amount; a fixed one is changed in place", () => {
  const lines = cleanLines([{ description: "Item", rate: 100 }, { description: "Transport", unit: "km", qty: 65, rate: R(100), charge: "variable" }]);
  const card = cleanChanges([{ op: "edit_charge", line: 2, qty: 72, confirmed: true }], lines);
  assert.equal(describeChange(card[0], lines), "Transport: quantity 65 → 72, confirmed: the final amount");
  const [, t] = applyChanges(lines, card);
  assert.deepEqual([t.qty, t.confirmed, isEstimate(t)], [72, true, false]);
  assert.throws(() => cleanChanges([{ op: "edit_charge", line: 2, variable: false, confirmed: true }], lines), /only a variable charge/);
  const fixed = applyChanges(lines, cleanChanges([{ op: "edit_charge", line: 2, variable: false }], lines))[1];
  assert.deepEqual([fixed.charge, fixed.confirmed], ["fixed", false]);
});

test("rupees read as people write them", () => {
  assert.equal(rupees(R(754610)), "₹7,54,610"); assert.equal(rupees(1180), "₹11.80"); assert.equal(rupees(R(100)), "₹100"); assert.equal(rupees(-R(25500)), "−₹25,500");
  assert.equal(rupees(R(12345678)), "₹1,23,45,678");
});

test("telemetry: a new price away from the base and a charge added or confirmed; amounts only, never words", () => {
  const before = [{ item_id: INV, rate: R(110000), description: "Hybrid inverter 5 kVA" }, { description: "Transport", charge: "variable", confirmed: false, rate: R(6500) }];
  const after = cleanLines([
    { itemId: INV, description: "Hybrid inverter 5 kVA", rate: R(104500), priceNote: "Festive" },
    { itemId: ITEM, description: "Solar", rate: R(385000) },
    { description: "Transport", rate: R(7000), charge: "variable", confirmed: true },
    { description: "Crane", rate: R(2000), charge: "fixed" },
  ]);
  const ev = builderEvents("quotation", "ai", before, after.map((line, i) => ({ line, base: [R(110000), R(385000), null, null][i] })));
  assert.deepEqual(ev.map((e) => [e.kind, e.detail.step ?? null]), [["billing.price_override", null], ["billing.variable_charge", "confirmed"], ["billing.variable_charge", "added"]]);
  assert.deepEqual(ev[0].detail, { by: "ai", base: R(110000), rate: R(104500), percentOff: 5, note: true });
  assert.equal(ev[0].value, R(5500));
  assert.ok(!JSON.stringify(ev).includes("Hybrid") && !JSON.stringify(ev).includes("Festive"), "no words leave the save");
  // The same price saved again (autosave) is not a new event.
  const again = builderEvents("quotation", "person", [{ item_id: INV, rate: R(104500) }], [{ line: after[0], base: R(110000) }]);
  assert.equal(again.length, 0);
});
