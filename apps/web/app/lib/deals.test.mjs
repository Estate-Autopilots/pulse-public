import { test } from "node:test";
import assert from "node:assert/strict";
import { cutText, daysText, discount, discountText, discountTone, headline, money } from "./deals.mjs";

test("the discount runs from the first price to the latest, with one decimal", () => {
  assert.equal(discount(7500000, 2250000), 70);
  assert.equal(discount(25000000, 22500000), 10);
  assert.equal(discount(300, 299), 0.3);
  assert.equal(discount(100, 110), -10);
  assert.equal(discount(0, 100), null);
  assert.equal(discountText(10), "10% off");
  assert.equal(discountText(-10), "10% up");
  assert.equal(discountText(0), "No discount");
  assert.equal(discountTone(4), "accent");
  assert.equal(discountTone(20), "accent");
  assert.equal(discountTone(-3), "neutral");
});

test("days and services read as people say them", () => {
  assert.equal(daysText(null), "Not yet");
  assert.equal(daysText(0), "Same day");
  assert.equal(daysText(1), "1 day");
  assert.equal(daysText(9), "9 days");
  assert.equal(cutText({ removed: 1, lowered: 0 }), "Cut in 1 deal");
  assert.equal(cutText({ removed: 2, lowered: 1 }), "Cut in 2 deals · lowered in 1 deal");
  assert.equal(money(7500000), "₹75,000");
  assert.equal(money(42000000), "₹4,20,000");
});

test("the headline says why a number is missing", () => {
  const none = headline({ deals: 0, won: 0, lost: 0, open: 0, v1Won: 0, finalWon: 0, versions: null, revised: 0, daysToYes: null, daysToPaid: null, paid: 0 });
  assert.equal(none.discount, "—");
  assert.match(none.versionsNote, /None sent in this period/);
  const h = headline({ deals: 2, won: 1, lost: 1, open: 0, v1Won: 7500000, finalWon: 2250000, versions: 2, revised: 1, daysToYes: 3, daysToPaid: 1, paid: 1 });
  assert.equal(h.discount, "70%");
  assert.equal(h.versionsNote, "1 of 2 deals got a new version");
  assert.equal(h.yes, "3");
});
