import assert from "node:assert/strict";
import test from "node:test";
import { cleanCard, cleanSelection, partPrice } from "../dist/rate-card-model.js";
import { cleanLines } from "../dist/erp-model.js";

// KAZUK-REST (1710): what a rate card accepts and how each part is priced. Invented figures only.
const service = "0f4c2d6e-aaaa-4bbb-8ccc-dddddddddddd";
const body = { itemId: service, name: "  Synthetic social media\u0007 ", base: 4000000, xLabel: "Reels per week", xMin: 1, xMax: 5,
  talents: [{ label: "Junior", factor: 0.8 }, { label: "Senior", factor: "1.5" }],
  periods: [{ label: "Per month", months: 1 }, { label: "Per quarter", months: 3, factor: 0.95 }],
  addOns: [{ label: "Synthetic shoot day", price: 1500000, per: "once" }, { label: "Ad management", price: 500000 }] };

test("a rate card is checked and its keys come from the names", () => {
  const c = cleanCard(body);
  assert.equal(c.name, "Synthetic social media");
  assert.deepEqual(c.talents.map((t) => [t.key, t.factor]), [["junior", 0.8], ["senior", 1.5]]);
  assert.deepEqual(c.periods.map((p) => [p.key, p.months, p.factor]), [["per-month", 1, 1], ["per-quarter", 3, 0.95]]);
  assert.deepEqual(c.addOns.map((a) => [a.key, a.per]), [["synthetic-shoot-day", "once"], ["ad-management", "month"]]);
  assert.throws(() => cleanCard({ ...body, itemId: "x" }), /service/);
  assert.throws(() => cleanCard({ ...body, base: 0 }), /base price/);
  assert.throws(() => cleanCard({ ...body, xMin: 5, xMax: 1 }), /highest X/);
  assert.throws(() => cleanCard({ ...body, talents: [] }), /at least 1 talent level/);
  assert.throws(() => cleanCard({ ...body, talents: [{ label: "A", factor: 1 }, { label: "a", factor: 2 }] }), /same name/);
  assert.throws(() => cleanCard({ ...body, periods: [{ label: "Year", months: 13 }] }), /1 to 12 months/);
  // QUOTE-STRUCT: factors take up to six decimals and go up to 1000 (an exact price ratio needs no made-up base).
  assert.equal(cleanCard({ ...body, talents: [{ label: "Ratio", factor: 2.001669 }] }).talents[0].factor, 2.001669);
  assert.equal(cleanCard({ ...body, talents: [{ label: "Big", factor: 250 }] }).talents[0].factor, 250);
  assert.throws(() => cleanCard({ ...body, talents: [{ label: "Odd", factor: 1.0000001 }] }), /six decimals/);
  assert.throws(() => cleanCard({ ...body, talents: [{ label: "Huge", factor: 1001 }] }), /six decimals/);
});

test("each part is priced exactly as the database does", () => {
  const c = cleanCard(body);
  const s = { x: 2, talent: "senior", period: "per-quarter" };
  assert.equal(partPrice(c, { ...s, part: "base" }), 34200000);
  assert.equal(partPrice(c, { ...s, x: 1.333, talent: "junior", part: "base" }), 12156960);
  assert.equal(partPrice(c, { ...s, part: "addon:ad-management" }), 1500000);
  assert.equal(partPrice(c, { ...s, part: "addon:synthetic-shoot-day" }), 1500000);
  assert.throws(() => partPrice(c, { ...s, x: 6, part: "base" }), /reels per week from 1 to 5/);
  assert.throws(() => partPrice(c, { ...s, part: "addon:nope" }), /not on the rate card/);
});

test("a document line keeps its rate card choice, checked", () => {
  const choice = { cardId: service, part: "addon:ads", x: 2, talent: "senior", period: "quarter" };
  assert.deepEqual(cleanSelection(choice), choice);
  assert.equal(cleanSelection(null), null);
  assert.equal(cleanSelection({ ...choice, part: undefined }).part, "base");
  assert.throws(() => cleanSelection({ ...choice, cardId: "nope" }), /choose a rate card/);
  assert.throws(() => cleanSelection({ ...choice, part: "addon:../x" }), /base or an add-on/);
  assert.throws(() => cleanSelection([choice]), /not valid/);
  const [line, plain] = cleanLines([{ description: "Synthetic social media · Senior", qty: 1, rate: 34200000, gstRate: 18, rateCard: choice }, { description: "Synthetic line", qty: 1, rate: 100, gstRate: 18 }]);
  assert.deepEqual(line.rateCard, choice);
  assert.equal(plain.rateCard, null);
  assert.throws(() => cleanLines([{ description: "x", qty: 1, rate: 1, rateCard: { ...choice, x: "lots" } }]), /Line 1: X/);
});
