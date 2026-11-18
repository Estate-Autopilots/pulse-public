import { test } from "node:test";
import assert from "node:assert/strict";
import { INCENTIVE, firstName, neetiValue, syncText, todayItems } from "./sales-home.mjs";

test("Neeti numbers say Not recorded when Sales X-Ray sent nothing", () => {
  const n = { connected: true, lastSync: "2026-11-09T04:10:00Z", leads: 18, attempts: 0, firstCallMinutes: 95, settingCalls: null, strategySessions: null, proposals: 4, closes: 1, lost: [] };
  assert.equal(neetiValue(n, "leads"), "18");
  assert.equal(neetiValue(n, "attempts"), "0");
  assert.equal(neetiValue(n, "settingCalls"), null);
  assert.equal(neetiValue(n, "firstCallMinutes"), "2 h");
  assert.equal(neetiValue({ ...n, firstCallMinutes: 12 }, "firstCallMinutes"), "12 min");
  assert.equal(neetiValue({ ...n, connected: false }, "leads"), null);
  assert.equal(syncText(n), "Last sync 9 Nov, 9:40 am");
  assert.match(syncText({ connected: false, lastSync: null }), /not connected/);
  assert.equal(syncText({ connected: true, lastSync: null }), "Not synced yet.");
});

test("today lists missed follow-ups first, then late invoices by amount, then today's follow-ups", () => {
  const items = todayItems({
    today: "2026-11-09",
    pipeline: { followUps: { items: [
      { id: "a", title: "Call Test Realty", dueOn: "2026-11-09", overdue: false },
      { id: "b", title: "Call Lotus", dueOn: "2026-11-07", overdue: true },
      { id: "c", title: "Call later", dueOn: "2026-11-12", overdue: false },
    ] } },
    invoices: [
      { id: "i1", number: "INV/26-27/0001", buyer: "Test Realty", dueDate: "2026-11-04", baseDue: 100000, gstDue: 18000 },
      { id: "i2", number: "INV/26-27/0002", buyer: null, dueDate: "2026-11-01", baseDue: 500000, gstDue: 90000 },
      { id: "i3", number: "INV/26-27/0003", buyer: null, dueDate: "2026-11-20", baseDue: 500000, gstDue: 0 },
      { id: "i4", number: "INV/26-27/0004", buyer: null, dueDate: "2026-11-01", baseDue: 0, gstDue: 0 },
    ],
  });
  assert.deepEqual(items.map((i) => i.key), ["t-b", "i-i2", "i-i1", "t-a"]);
  assert.equal(items[1].sub, "Invoice 8 days late: ask for the payment");
  assert.equal(firstName("  Synthetic Seller One "), "Synthetic");
  // With the Sales Agent's reminders: they replace the period's late invoices and carry their drafts.
  const withAgent = todayItems({ today: "2026-11-09", invoices: [{ id: "i1", number: "X", dueDate: "2026-11-01", baseDue: 1, gstDue: 0 }],
    pipeline: { followUps: { items: [{ id: "a", title: "Call Test Realty", dueOn: "2026-11-09", overdue: false }] } },
    nudges: [{ kind: "renewal", key: "r", title: "Renewal", sub: "", href: "/clients/c", draft: "Hi" }, { kind: "no_reply", key: "n", title: "No reply", sub: "", href: "/erp/documents/q", draft: "Hi again", amount: 5 },
      { kind: "overdue", key: "o", title: "Late", sub: "", href: "/erp/documents/i2", draft: "Pay", amount: 100, phone: "+91 90000 00111" }] });
  assert.deepEqual(withAgent.map((i) => i.key), ["o", "n", "t-a", "r"]);
  assert.equal(withAgent[0].draft, "Pay");
  assert.equal(withAgent[1].amount, undefined);
  assert.equal(INCENTIVE.pending.label, "Pending");
});
