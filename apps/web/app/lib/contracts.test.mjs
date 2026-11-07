// CONNECTORS-CONTRACTS: the words a contract says (lib/contracts.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceWords, datesWords, money, otherSide, rateWords, totalsWords } from "./contracts.mjs";

test("money is written the Indian way, without needless paise", () => {
  assert.equal(money(15000000), "₹1,50,000");
  assert.equal(money(150050), "₹1,500.50");
  assert.equal(money(2500, "USD"), "$25");
  assert.equal(money(100, "AED"), "AED 1");
});

test("rate lines say their unit", () => {
  assert.equal(rateWords({ label: "Retainer", amountMinor: 10000000, unit: "month" }, "INR"), "₹1,00,000 a month");
  assert.equal(rateWords({ label: "Share", amountMinor: 1250, unit: "percent" }, "INR"), "12.5%");
  assert.equal(rateWords({ label: "Reel", amountMinor: 500000, unit: "deliverable" }, "INR"), "₹5,000 each");
});

test("acceptance names who is still to accept", () => {
  assert.equal(acceptanceWords([{ name: "A", current: true }, { name: "B", current: true }]), "Everyone accepted");
  assert.equal(acceptanceWords([{ name: "Synthetic Co", current: true }, { name: "Asha", current: false }]), "1 of 2 accepted · waiting for Asha");
});

test("totals and dates", () => {
  assert.equal(totalsWords([]), "Nothing billed yet");
  assert.equal(totalsWords([{ currency: "INR", billedMinor: 10000000, paidMinor: 5000000, outstandingMinor: 5000000 }]), "₹1,00,000 billed · ₹50,000 paid · ₹50,000 owed");
  assert.equal(datesWords({ startsOn: "2026-12-01", endsOn: null, noticeDays: 30 }), "From 1 Dec 2026 · 30 days' notice");
  assert.equal(datesWords({ startsOn: null, endsOn: null, noticeDays: null }), "No dates yet");
  assert.equal(otherSide([{ name: "Us", mine: true, orgId: null }, { name: "Them", mine: false, orgId: "o2" }]), "Them");
});
