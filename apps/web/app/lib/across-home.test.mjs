import test from "node:test";
import assert from "node:assert/strict";
import { collectTotal, greeting, moneyRows, summaryLine, waitingCount, waitingItems } from "./across-home.mjs";

const card = (org, name, money, next = null, issues = 0) => ({ org, name, handle: null, current: false, mark: null, accent: null, weight: null, people: [],
  today: { today: "2026-11-16", kind: "company", role: null, access: "owner", money, clientIssues: { count: issues, top: null }, tasksLate: { count: 0, top: null },
    people: { total: 3, in: 2, away: 0 }, ai: { total: 0, working: 0, stuck: 0, top: null }, next } });
const m = (late, due, unbilled = 0) => ({ late: { count: late ? 1 : 0, amount: late }, dueWeek: { count: due ? 1 : 0, amount: due }, unbilled: { count: 0, amount: unbilled }, waiting: { count: 0, amount: 0 }, atRisk: late + unbilled, topLate: null, topUnbilled: null });

test("the summary says only what is not zero, in plain words", () => {
  assert.equal(summaryLine({ late: 2, waiting: 3, collect: 42000000 }), "2 things are late, 3 things wait on you, ₹4.2 L to collect.");
  assert.equal(summaryLine({ late: 1, waiting: 1 }), "1 thing is late, 1 thing waits on you.");
  assert.equal(summaryLine({ today: 4 }), "4 things to do today.");
  assert.equal(summaryLine({}), "All clear. Nothing is late and nothing waits on you.");
});

test("money rows skip companies whose money this person cannot see, biggest worry first", () => {
  const rows = moneyRows([card("a", "Alpha Works", m(0, 500000)), card("b", "Beta Studio", null), card("c", "Gamma Labs", m(1200000, 0, 300000))]);
  assert.deepEqual(rows.map((r) => r.org), ["c", "a"]);
  assert.equal(collectTotal(rows), 1700000);
});

test("waiting on you: agreements to sign first, then a client's question or a late bill per company", () => {
  const cards = [card("a", "Alpha Works", null, { kind: "client_issue", client: "Synthetic Client", title: "Where is the plan?", taskId: "t1" }, 2),
    card("b", "Beta Studio", null, { kind: "late_task", title: "x", days: 2, id: "t2" })];
  const contracts = [{ key: "k1", canAccept: true, title: "Service agreement", heldBy: "Gamma Labs", parties: [{ name: "Gamma Labs", mine: false }, { name: "Me", mine: true }] },
    { key: "k2", canAccept: false, title: "Old", heldBy: "Gamma Labs", parties: [] }];
  const w = waitingItems({ cards, contracts });
  assert.deepEqual(w.map((x) => x.key), ["contract:k1", "next:a"]);
  assert.equal(w[0].who, "Gamma Labs");
  assert.equal(w[1].action, "Reply");
  assert.equal(w[1].href, "/tasks/t1");
  assert.equal(waitingCount({ cards, contracts }), 3);
});

test("greeting by the hour", () => {
  assert.equal(greeting(9, "Asha Rao"), "Good morning, Asha");
  assert.equal(greeting(21, null), "Good evening");
  assert.equal(greeting(2, "Asha"), "Working late, Asha");
});
