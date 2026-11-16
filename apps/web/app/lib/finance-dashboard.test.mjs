// FIX-PEOPLE-MONEY C4: the finance dashboard's six answers from a synthetic finance model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { burnOf, cashOf, dashboardOf, monthOf, payablesOf, receivablesOf, taxOf } from "./finance-dashboard.mjs";

const model = {
  burn: { net: -190000, avgMonthlyCost: 710000, runwayMonths: 9.7, runwayNote: null, balance: { amount: 1840000, asOf: "2026-11-08", ageDays: 2 } },
  collections: { outstanding: { count: 25, amount: 1690000 }, overdue: { buckets: [{ bucket: "0–30 days", count: 9, amount: 620000 }, { bucket: "31–60 days", count: 7, amount: 480000 }, { bucket: "90+ days", count: 4, amount: 280000 }],
    top: [{ client: "Lotus Interiors", total: 50000, ageDays: 95 }, { client: "Harbor Builders", total: 90000, ageDays: 40 }, { client: "Lotus Interiors", total: 70000, ageDays: 120 }] } },
  payroll: [{ month: "2026-09", total: 500000, people: 11 }, { month: "2026-10", total: 520000, people: 12 }],
  software: { renewals30: [{ vendor: "Zoom", lastAmount: 1300, currency: "INR", nextRenewal: "2026-11-20" }, { vendor: "Netlify", lastAmount: 20, currency: "USD", nextRenewal: "2026-11-15" }] },
  revenue: { months: [{ month: "2026-09", revenue: 900000, invoiced: 900000 }, { month: "2026-10", revenue: null, invoiced: 960000 }, { month: "2026-11", revenue: 100000, invoiced: 100000 }] },
  expenses: { months: [{ month: "2026-09", total: 700000, byCategory: { "Payroll (monthly total)": 500000, "Software & AI": 60000, "Office & rent": 80000 } },
    { month: "2026-10", total: 710000, byCategory: { "Payroll (monthly total)": 520000, "Software & AI": 60000, "Office & rent": 80000, "Marketing spend": 30000 } }] },
  compliance: { upcoming: [{ what: "GSTR-3B for Oct 2026", due: "2026-11-20" }, { what: "GSTR-1 for Oct 2026", due: "2026-11-11" }], late: ["Apr 2026–Jun 2026"], gaps: ["Jul 2026–Sep 2026"] },
};

test("cash is fresh within 45 days and stale after; no balance is said plainly", () => {
  assert.deepEqual(cashOf(model), { known: true, amount: 1840000, asOf: "2026-11-08", ageDays: 2, stale: false });
  assert.equal(cashOf({ burn: { balance: { amount: 69453, asOf: "2025-10-07", ageDays: 383 } } }).stale, true);
  assert.equal(cashOf({}).known, false);
});

test("receivables keep the four ageing buckets, and the top late clients add up their invoices", () => {
  const r = receivablesOf(model);
  assert.deepEqual(r.buckets.map((b) => [b.label, b.amount]), [["0–30", 620000], ["31–60", 480000], ["61–90", 0], ["90+", 280000]]);
  assert.equal(r.amount, 1690000);
  assert.equal(r.late, 760000);
  assert.deepEqual(r.top.map((t) => [t.client, t.amount, t.invoices]), [["Lotus Interiors", 120000, 2], ["Harbor Builders", 90000, 1]]);
});

test("payables: next month's salaries, rupee renewals only, and the next GST return", () => {
  const p = payablesOf(model, "2026-11-10");
  assert.equal(payablesOf({ compliance: { upcoming: [{ what: "GSTR-1 for Oct–Dec", due: "2027-01-13" }] } }, "2026-11-10").rows.length, 0, "a return due after 30 days is not in We owe");
  assert.deepEqual(p.rows.map((r) => [r.key, r.amount, r.when]), [["salaries", 520000, "2026-12-01"], ["renewals", 1300, "2026-11-15"], ["gst", null, "2026-11-11"]]);
  assert.equal(p.amount, 521300);
});

test("the month: the latest month with both figures, people first, and a loss is a negative profit", () => {
  const m = monthOf(model);
  assert.equal(m.month, "2026-10");
  assert.equal(m.revenue, 960000);
  assert.equal(m.profit, 250000);
  assert.deepEqual(m.lines.map((l) => [l.label, l.amount]), [["People", 520000], ["Software & AI", 60000], ["Rent & office", 80000], ["Marketing", 30000], ["Other", 20000]]);
  assert.equal(monthOf({ revenue: { months: [{ month: "2026-10", revenue: 100 }] }, expenses: { months: [{ month: "2026-10", total: 400, byCategory: {} }] } }).profit, -300);
  assert.equal(monthOf({}), null);
});

test("burn and runway; no runway without a balance", () => {
  const b = burnOf(model);
  // The last three months' net (Sep 900000 − 700000, Oct 960000 − 710000) averages to earning, not burning.
  assert.equal(b.burn, 0);
  assert.equal(b.earning, 225000);
  assert.equal(b.runway, 9.7);
  assert.equal(b.series.length, 2);
  assert.equal(burnOf({ burn: { net: -5, runwayMonths: null, runwayNote: "stale" } }).note, "Needs a recent bank balance");
});

test("tax: earliest return first, with days to go, late and missing quarters", () => {
  const t = taxOf(model, "2026-11-10");
  assert.deepEqual(t.list.map((x) => [x.what, x.inDays]), [["GSTR-1 for Oct 2026", 1], ["GSTR-3B for Oct 2026", 10]]);
  assert.deepEqual(t.missing, [{ label: "Jul 2026–Sep 2026", due: "2026-10-13" }]);
  assert.deepEqual(Object.keys(dashboardOf(null, "2026-11-10")), ["cash", "receivables", "payables", "month", "burn", "tax", "certified", "asOf"]);
});
