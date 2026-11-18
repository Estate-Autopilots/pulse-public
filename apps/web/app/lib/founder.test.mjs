import { test } from "node:test";
import assert from "node:assert/strict";
// Money and "N days late" keep their words together (no-break spaces): compare as people read them.
const plain = (x) => String(x).replace(/\u00A0/g, " ");
import { clearOf, countsOf, designationLine, designations, money, moneyPill, myRole, needsOf, nextHref, nextShort, nextText, roleWord, sharedPersonLine, toneOf, totalsOf } from "./founder.mjs";

const calm = { today: "2026-11-09", kind: "company", role: "Founder", access: "owner", money: { dueWeek: { count: 0, amount: 0 }, late: { count: 0, amount: 0 }, unbilled: { count: 0, amount: 0 }, waiting: { count: 0, amount: 0 }, atRisk: 0 },
  clientIssues: { count: 0, top: null }, tasksLate: { count: 0, top: null }, people: { total: 4, in: 3, away: 1 }, ai: { total: 1, working: 1, stuck: 0, top: null }, next: null };

test("designations read as a person says them, one company each", () => {
  assert.equal(designationLine([{ company: "EA", role: "Head PGS" }, { company: "Vitals", role: "Adviser" }]), "Head PGS at EA · Adviser at Vitals");
  assert.equal(designationLine([{ company: "Lotus", role: null, kind: "client" }, { company: "Kite", role: " ", kind: "staff" }]), "Client at Lotus · Team member at Kite");
  assert.equal(designationLine([]), ""); assert.equal(designationLine(null), "");
  assert.equal(roleWord("  CEO ", "staff"), "CEO");
  // No job title: the seat's access names it, as on the cards and in the switcher.
  assert.deepEqual(designations([{ company: "Kite", role: null, kind: "staff", access: "admin" }, { company: "Maple", role: "", kind: "staff", access: "owner" }]), ["Admin at Kite", "Owner at Maple"]);
});

test("a person in two of the founder's companies gets one line", () => {
  assert.equal(sharedPersonLine({ id: "x", name: "Diya Nair", role: "Head of sales", kind: "staff", elsewhere: [{ company: "Kite Studio", role: "Adviser", kind: "staff" }] }),
    "Diya Nair is also adviser at Kite Studio");
  assert.equal(sharedPersonLine({ id: "x", name: "Sana", role: null, kind: "staff", elsewhere: [{ company: "B", role: "CEO", kind: "staff" }] }), "Sana is also CEO at B");
  assert.equal(sharedPersonLine({ id: "x", name: "Sana", role: null, kind: "staff", elsewhere: [{ company: "B", role: null, kind: "staff" }, { company: "C", role: "Adviser", kind: "staff" }] }), "Sana also works at B, and adviser at C");
});

test("money is said in rupees from paise, lakh and crore", () => {
  assert.equal(plain(money(11800000)), "₹1.18 L"); assert.equal(plain(money(0)), "₹0"); assert.equal(plain(money(4500000)), "₹45,000"); assert.equal(plain(money(null)), "₹0");
});

test("the next thing says what to do and where it opens", () => {
  const bill = { kind: "late_bill", id: "d1", amount: 11800000, buyer: "Lotus Interiors", age: 5 };
  assert.equal(plain(nextText(bill)), "Collect the bill from Lotus Interiors · 5 days late"); assert.equal(nextHref(bill), "/erp/documents/d1");
  assert.equal(plain(nextText({ kind: "ai_stuck", id: "a", name: "Studio AI", why: "paused" })), "Studio AI is paused. See why");
  assert.equal(plain(nextText({ kind: "ai_stuck", id: "a", name: "Studio AI", why: "blocked", task: "Draft the post" })), "Studio AI is stuck on “Draft the post”");
  assert.equal(nextHref({ kind: "ai_stuck", id: "a" }), "/people/ai/a");
  assert.equal(plain(nextText({ kind: "client_issue", client: "Harbor", title: "Drawings missing" })), "Answer Harbor: Drawings missing");
  assert.equal(nextHref({ kind: "client_issue", projectId: "p" }), "/projects/p"); assert.equal(nextHref({ kind: "client_issue", taskId: "t", projectId: "p" }), "/tasks/t");
  assert.equal(plain(nextText({ kind: "late_task", id: "t", title: "Send drawings", days: 1, who: "Diya" })), "Follow up “Send drawings” (1 day late)");
  assert.equal(plain(nextText({ kind: "late_task", id: "t", title: "Send drawings", days: 0 })), "Follow up “Send drawings” (due today)");
  assert.equal(nextHref({ kind: "unbilled", why: "milestone", projectId: "p" }), "/projects/p"); assert.equal(nextHref({ kind: "unbilled", why: "accepted", id: "q" }), "/erp/documents/q");
  assert.equal(plain(nextText(null)), "All clear today"); assert.equal(nextHref(null), null);
  assert.equal(plain(nextShort(bill)), "collect a late bill"); assert.equal(plain(nextShort({ kind: "client_issue", client: "Harbor" })), "answer Harbor");
});

test("a calm company is all clear and green; trouble turns it amber or rose", () => {
  assert.deepEqual(clearOf(calm), { clear: 4, of: 4 }); assert.equal(toneOf(calm), "good");
  assert.equal(toneOf({ ...calm, tasksLate: { count: 2 } }), "warn");
  assert.equal(toneOf({ ...calm, ai: { total: 1, working: 0, stuck: 1 } }), "bad");
  assert.equal(toneOf({ ...calm, money: { ...calm.money, late: { count: 1, amount: 5 } } }), "bad");
  // Billing nobody may read here counts as clear, never as trouble.
  assert.deepEqual(clearOf({ ...calm, money: null, people: { total: 4, in: 1, away: 0 } }), { clear: 4, of: 4 });
  assert.deepEqual(clearOf({ ...calm, tasksLate: { count: 1 }, ai: { total: 1, working: 0, stuck: 1 } }), { clear: 2, of: 4 });
});

test("the counts are short lines", () => {
  assert.deepEqual(countsOf({ ...calm, clientIssues: { count: 1 }, tasksLate: { count: 3 }, ai: { total: 2, working: 1, stuck: 1 } }).map((c) => c.text),
    ["1 client issue", "3 tasks late", "3 of 4 at work today", "1 AI helper stuck"]);
  assert.deepEqual(countsOf({ ...calm, people: { total: 0, in: 0, away: 0 }, ai: { total: 0, working: 0, stuck: 0 } }).map((c) => c.text),
    ["No issues", "None late", "No team yet", "No AI helpers"]);
  assert.deepEqual(needsOf(calm), { text: "All clear", tone: "good" });
  assert.deepEqual(needsOf({ ...calm, tasksLate: { count: 1 }, ai: { total: 1, working: 0, stuck: 1 } }), { text: "2 things need you", tone: "bad" });
  assert.deepEqual(((x) => x && { ...x, text: plain(x.text) })(moneyPill({ ...calm, money: { ...calm.money, late: { count: 1, amount: 11800000 } } })), { text: "₹1.18 L late", tone: "bad" });
  assert.deepEqual(((x) => x && { ...x, text: plain(x.text) })(moneyPill({ ...calm, money: { ...calm.money, unbilled: { count: 1, amount: 500000 } } })), { text: "₹5,000 not billed", tone: "warn" });
  assert.deepEqual(((x) => x && { ...x, text: plain(x.text) })(moneyPill(calm)), { text: "Nothing late", tone: "good" }); assert.equal(moneyPill({ ...calm, money: null }), null);
});

test("totals add every card; the role chip falls back to Owner or Admin", () => {
  const t = totalsOf([{ today: calm }, { today: { ...calm, money: { ...calm.money, dueWeek: { count: 1, amount: 500 }, late: { count: 1, amount: 900 }, atRisk: 1900 }, tasksLate: { count: 2 }, ai: { total: 1, working: 0, stuck: 1 } } }, { today: { ...calm, money: null } }]);
  assert.deepEqual(t, { due: 500, risk: 900, late: 2, stuck: 1, clear: 2, companies: 3 });
  assert.equal(myRole({ ...calm, role: null, access: "owner" }), "Owner"); assert.equal(myRole({ ...calm, role: null, access: "admin" }), "Admin");
  assert.equal(myRole({ ...calm, role: "Adviser" }), "Adviser");
});
