// CONTRACTS-3: who pays whom, in words and numbers (moneyFlow), and the log line for a proposed draft.
import assert from "node:assert/strict";
import test from "node:test";
import { changeWords, eventWords, moneyFlow } from "./agreements.mjs";

const us = { key: "a", role: "provider", name: "Kedab Studio (synthetic)" }, them = { key: "b", role: "client", name: "Lotus Interiors (synthetic)" };
const base = { kind: "services", schedule: "milestones", currency: "INR", parties: [us, them], rates: [], transactions: [] };

test("from a quotation: the client pays us its total, due on its date", () => {
  const f = moneyFlow({ ...base, rates: [{ label: "Design", amountMinor: 10000000, unit: "one_off" }, { label: "Build", amountMinor: 32000000, unit: "one_off" }] },
    { total: 42000000, dueDate: "2026-11-30", documentNumber: "QT-0042", documentType: "quotation", documentId: "d1" }, "2026-11-09");
  assert.equal(f.payer?.name, them.name); assert.equal(f.payee?.name, us.name);
  assert.equal(f.totalMinor, 42000000); assert.equal(f.per, null); assert.equal(f.paidPct, 0);
  assert.deepEqual(f.parts.map((p) => [p.label, p.state, p.when]), [["Design", "later", ""], ["Build", "later", ""]]);
  assert.deepEqual(f.next, { amountMinor: 42000000, when: "due on 30 Nov", late: false, full: true });
  assert.deepEqual(f.document, { label: "quotation QT-0042", id: "d1" });
});

test("bills and payments under the agreement decide the parts, what is paid and what is next", () => {
  const f = moneyFlow({ ...base, transactions: [
    { payer: "b", payee: "a", label: "On signing", amountMinor: 12600000, status: "paid", dueOn: "2026-11-01", paidOn: "2026-11-02" },
    { payer: "b", payee: "a", label: "On delivery", amountMinor: 16800000, status: "billed", dueOn: "2026-11-30", paidOn: null },
    { payer: "b", payee: "a", label: "On handover", amountMinor: 12600000, status: "billed", dueOn: null, paidOn: null },
    { payer: "b", payee: "a", label: "Cancelled bill", amountMinor: 999, status: "void", dueOn: null, paidOn: null }] }, null, "2026-11-09");
  assert.equal(f.totalMinor, 42000000); assert.equal(f.paidMinor, 12600000); assert.equal(f.paidPct, 30);
  assert.deepEqual(f.parts.map((p) => [p.state, p.when]), [["paid", "Paid 2 Nov"], ["due", "Due 30 Nov"], ["later", "Not due yet"]]);
  assert.deepEqual(f.next, { amountMinor: 16800000, when: "due on 30 Nov", late: false, full: false });
  const late = moneyFlow({ ...base, transactions: [{ payer: "b", payee: "a", label: "First", amountMinor: 100, status: "billed", dueOn: "2026-11-01", paidOn: null }] }, null, "2026-11-09");
  assert.equal(late.parts[0].state, "late"); assert.equal(late.next?.late, true); assert.equal(late.next?.when, "was due on 1 Nov");
});

test("a monthly retainer reads as a month's fee; an employer pays the employee", () => {
  const r = moneyFlow({ ...base, kind: "retainer", schedule: "monthly", rates: [{ label: "Monthly fee", amountMinor: 5000000, unit: "month" }] }, null, "2026-11-09");
  assert.equal(r.per, "month"); assert.equal(r.totalMinor, 5000000); assert.equal(r.parts[0].when, "Every month"); assert.equal(r.gets, "Monthly fee");
  const e = moneyFlow({ ...base, kind: "employment", parties: [{ key: "x", role: "employer", name: "Kedab Studio" }, { key: "y", role: "employee", name: "Aarav Shah" }] }, null, "2026-11-09");
  assert.equal(e.payer?.name, "Kedab Studio"); assert.equal(e.payee?.name, "Aarav Shah"); assert.equal(e.next, null);
});

test("words for a comparison and a proposed draft", () => {
  assert.equal(changeWords([{ kind: "same", text: "You pay " }, { kind: "removed", text: "50%" }, { kind: "added", text: "30%" }]), "taken out: 50%; added: 30%");
  assert.equal(eventWords({ kind: "draft_proposed", by: "Diya Nair", body: "Through an AI assistant" }), "Diya Nair proposed a new draft (Through an AI assistant)");
});
