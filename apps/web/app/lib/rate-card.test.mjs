import assert from "node:assert/strict";
import test from "node:test";
import { cardLines, cardPrice, periodUnit } from "./rate-card.mjs";

// An obviously invented card: ₹40,000 a month, X = reels per week.
const card = { id: "00000000-0000-4000-8000-0000000000a8", itemId: "00000000-0000-4000-8000-0000000000b8", name: "Synthetic social media", base: 4000000, xLabel: "Reels per week", xMin: 1, xMax: 5,
  talents: [{ key: "junior", label: "Junior", factor: 0.8 }, { key: "senior", label: "Senior", factor: 1.5 }],
  periods: [{ key: "month", label: "Per month", months: 1, factor: 1 }, { key: "quarter", label: "Per quarter", months: 3, factor: 0.95 }],
  addOns: [{ key: "shoot", label: "Synthetic shoot day", price: 1500000, per: "once" }, { key: "ads", label: "Ad management", price: 500000, per: "month" }], sac: "998361", gstRate: 18 };

test("a rate card prices base × X × talent × months × period factor, exactly", () => {
  assert.equal(cardPrice(card, { x: 1, talent: "junior", period: "month" }), 3200000);
  assert.equal(cardPrice(card, { x: 2.5, talent: "senior", period: "quarter" }), 42750000); // 40000 × 2.5 × 1.5 × 3 × 0.95
  assert.equal(cardPrice(card, { x: 1.333, talent: "junior", period: "quarter" }), 12156960); // half up to the paisa
  assert.equal(cardPrice(card, { x: 6, talent: "junior", period: "month" }), null);
  assert.equal(cardPrice(card, { x: 1, talent: "lead", period: "month" }), null);
});

test("an add-on is priced per month of the period or once", () => {
  assert.equal(cardPrice(card, { x: 1, talent: "junior", period: "quarter", part: "addon:ads" }), 1500000);
  assert.equal(cardPrice(card, { x: 1, talent: "junior", period: "quarter", part: "addon:shoot" }), 1500000);
  assert.equal(cardPrice(card, { x: 1, talent: "junior", period: "quarter", part: "addon:nope" }), null);
});

test("a choice becomes the service line and its add-on lines, each carrying the choice", () => {
  const r = cardLines(card, { x: 2, talent: "senior", period: "quarter", addOns: ["ads", "shoot", "gone"] });
  assert.equal(r.main.description, "Synthetic social media · Senior · Per quarter");
  assert.equal(r.main.details, "Reels per week 2 · Senior · 3 months");
  assert.equal(r.main.rate, 34200000);
  assert.equal(r.main.unit, "quarter");
  assert.deepEqual(r.main.rateCard, { cardId: card.id, x: 2, talent: "senior", period: "quarter", part: "base" });
  assert.deepEqual(r.addOns.map((a) => [a.description, a.rate, a.unit, a.rateCard.part]), [["Ad management (Synthetic social media)", 1500000, "quarter", "addon:ads"],
    ["Synthetic shoot day (Synthetic social media)", 1500000, "once", "addon:shoot"]]);
  assert.equal(cardLines(card, { x: 9, talent: "senior", period: "quarter" }), null);
  assert.deepEqual([1, 3, 6, 12].map(periodUnit), ["month", "quarter", "6 months", "year"]);
});

// QUOTE-BUILDER-4 (Kazuk's 19 Nov test): the Neeti card's line says the users and months, under its own name.
test("a card that counts users says how many for how long, without its phase prefix", () => {
  const neeti = { id: "c-n", itemId: "i-n", name: "Phase 4: Synthetic Sales System™ — Seats CRM", base: 20000, xLabel: "Users", xMin: 1, xMax: 50,
    talents: [{ key: "senior", label: "AI", factor: 9.495 }], periods: [{ key: "x6", label: "6 months (10% prepaid)", months: 6, factor: 0.9 }, { key: "x1", label: "1 month", months: 1, factor: 1 }], addOns: [], gstRate: 18 };
  const r = cardLines(neeti, { x: 6, talent: "senior", period: "x6" });
  assert.equal(r.main.description, "Seats CRM · AI · 6 users × 6 months");
  assert.equal(r.main.details, "10% prepaid");
  assert.equal(r.main.rate, 6152760, "₹61,527.60 as the card prices it");
  assert.equal(cardLines(neeti, { x: 1, talent: "senior", period: "x1" }).main.description, "Seats CRM · AI · 1 user × 1 month");
  const ads = { ...neeti, name: "Phase 3: Journey — Synthetic ads", xLabel: "Projects", xMax: 5 };
  assert.equal(cardLines(ads, { x: 1, talent: "senior", period: "x6" }).main.description, "Synthetic ads · AI · 6 months");
  assert.equal(cardLines(ads, { x: 2, talent: "senior", period: "x6" }).main.description, "Synthetic ads · AI · 2 projects × 6 months");
});
