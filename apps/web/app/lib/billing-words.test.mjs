import test from "node:test";
import assert from "node:assert/strict";
import { describeLog, docStateWords, logShow, logTone, sentence } from "./billing-words.mjs";

// Synthetic documents only (UX-BILLING, 5 Nov 2026).
const today = "2026-11-05";
const doc = (x) => ({ docType: "invoice", status: "sent", dueDate: null, ownerApproval: null, approvalAskedBy: null, approvalToName: null, ...x });

test("a document's state reads as words with its stripe's tone", () => {
  assert.deepEqual(docStateWords(doc({ dueDate: "2026-10-01" }), today), { label: "Overdue", tone: "danger" });
  assert.deepEqual(docStateWords(doc({ status: "part_paid", dueDate: "2026-11-20" }), today), { label: "Part-paid", tone: "warning" });
  assert.deepEqual(docStateWords(doc({ dueDate: "2026-11-20" }), today), { label: "Awaiting payment", tone: "accent" });
  assert.deepEqual(docStateWords(doc({ status: "issued" }), today), { label: "To send", tone: "accent" });
  assert.deepEqual(docStateWords(doc({ docType: "quotation", status: "issued" }), today), { label: "Approved · to send", tone: "accent" });
  // KAZUK-FLOW (G2): with no approval it is simply to send.
  assert.deepEqual(docStateWords(doc({ docType: "quotation", status: "issued" }), today, true), { label: "To send", tone: "accent" });
  assert.deepEqual(docStateWords(doc({ docType: "quotation", status: "sent" }), today), { label: "With the customer", tone: "accent" });
  assert.deepEqual(docStateWords(doc({ docType: "credit_note", status: "issued" }), today), { label: "Issued", tone: "neutral" });
  assert.deepEqual(docStateWords(doc({ docType: "quotation", status: "draft" }), today), { label: "Draft", tone: "neutral" });
  assert.deepEqual(docStateWords(doc({ docType: "quotation", status: "draft", approvalAskedBy: "p1", approvalToName: "Synthetic Owner" }), today), { label: "With Synthetic Owner", tone: "warning" });
  assert.deepEqual(docStateWords(doc({ docType: "quotation", status: "draft", approvalAskedBy: "p1" }), today), { label: "With the approver", tone: "warning" });
  assert.deepEqual(docStateWords(doc({ docType: "quotation", status: "draft", ownerApproval: "needed" }), today), { label: "Price to approve", tone: "warning" });
  // A paid invoice is never "overdue" (its label is the screen's own); a quotation has no due date to miss.
  assert.equal(docStateWords(doc({ status: "paid", dueDate: "2026-10-01" }), today), null);
  assert.notEqual(docStateWords(doc({ docType: "quotation", status: "sent", dueDate: "2026-10-01" }), today)?.label, "Overdue");
});

test("a log line is a sentence, never a raw key", () => {
  assert.equal(sentence("approval_asked"), "Approval asked");
  const events = { approval_asked: "Sent for approval" }, types = { quotation: "Quotation", invoice: "Tax invoice" };
  assert.deepEqual(describeLog({ subjectType: "document", subjectId: "d1", kind: "approval_asked", docType: "quotation", number: null }, events, types),
    { what: "Sent for approval", of: "Quotation draft", href: "/erp/documents/d1" });
  assert.deepEqual(describeLog({ subjectType: "document", subjectId: "d1", kind: "deleted", docType: "invoice", number: "INV/26-27/0001" }, events, types),
    { what: "Deleted", of: "Tax invoice INV/26-27/0001", href: undefined });
  assert.deepEqual(describeLog({ subjectType: "stock", subjectId: "i1", kind: "in", detail: { qty: 4 }, item: "Synthetic Inverter" }),
    { what: "Stock in · 4", of: "Synthetic Inverter", href: "/erp/catalog/i1" });
  assert.deepEqual(describeLog({ subjectType: "party", subjectId: null, kind: "saved" }), { what: "Saved", of: "A client's billing details", href: undefined });
  assert.deepEqual(describeLog({ subjectType: "settings", subjectId: null, kind: "edited" }), { what: "Changed", of: "Billing settings", href: "/erp/settings" });
  assert.equal(describeLog({ subjectType: "warehouse_bin", subjectId: null, kind: "re_counted" }).what, "Re counted");
});

test("a log line's stripe and chip follow what happened", () => {
  assert.equal(logTone("payment"), "success");
  assert.equal(logTone("client_accepted"), "success");
  assert.equal(logTone("cancel"), "danger");
  assert.equal(logTone("payment_voided"), "danger");
  assert.equal(logTone("approval_asked"), "warning");
  assert.equal(logTone("issued"), "accent");
  assert.equal(logTone("edited"), "neutral");
  assert.equal(logShow({ subjectType: "document", kind: "payment" }), "money");
  assert.equal(logShow({ subjectType: "document", kind: "issued" }), "documents");
  assert.equal(logShow({ subjectType: "stock", kind: "in" }), "catalogue");
  assert.equal(logShow({ subjectType: "settings", kind: "edited" }), "other");
});
