import assert from "node:assert/strict";
import test from "node:test";
import { draftInput, screenFacts } from "../dist/kazuk-gaps.js";

test("a kept draft needs a valid key, a name, a page in Pulse and an object to keep", () => {
  const ok = draftInput(`erp-${["0f4c2d6e", "aaaa", "4bbb", "8ccc", "dddddddddddd"].join("-")}`, { title: "  QT draft\u0007 · Synthetic Towers ", href: "/erp/documents/x", data: { notes: "half typed" } });
  assert.equal(ok.title, "QT draft  · Synthetic Towers");
  assert.deepEqual(ok.data, { notes: "half typed" });
  assert.throws(() => draftInput("../x", { title: "a", href: "/a", data: {} }), /valid draft/);
  assert.throws(() => draftInput("new-project", { title: " ", href: "/a", data: {} }), /name/);
  assert.throws(() => draftInput("new-project", { title: "a", href: "https://elsewhere.example", data: {} }), /page in Pulse/);
  assert.throws(() => draftInput("new-project", { title: "a", href: "//elsewhere.example", data: {} }), /page in Pulse/);
  assert.throws(() => draftInput("new-project", { title: "a", href: "/a", data: [] }), /Nothing to keep/);
  assert.throws(() => draftInput("new-project", { title: "a", href: "/a", data: { x: "y".repeat(70000) } }), /too large/);
});

const money = (count, amount) => ({ count, amount, items: [] });

test("the CEO's question carries the screen's numbers, rupees included only for those who see them", () => {
  const rupees = (p) => `₹${Math.round(p / 100)}`;
  const base = { projects: 12, late: 7, waiting: 2, blocked: 1, alerts: 3, cs: 1, rupees };
  const withMoney = screenFacts({ ...base, money: { today: "2026-11-06", stallDays: 7, atLeast: 2500000, overdue: money(2, 11800000), unbilled: money(1, 5000000), stalled: money(3, 9000000) } });
  assert.match(withMoney, /^On this screen: 12 active projects; 7 tasks late; 2 waiting on the client; 1 blocked;/);
  assert.match(withMoney, /overdue invoices 2 \(₹118000\); not billed yet 1 \(₹50000\); quotations of ₹25000 or more with no answer for 7\+ days 3 \(₹90000\)/);
  assert.match(withMoney, /3 same-day alerts; 1 client issues raised today\.$/);
  const without = screenFacts({ ...base, money: null });
  assert.doesNotMatch(without, /₹|invoices/);
  assert.ok(screenFacts({ ...base, money: null }, 40).length <= 40);
});
