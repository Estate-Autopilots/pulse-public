// UX-BILLING (owner, 5 Nov 2026): the words and colours Billing shows for a document's state and for a line of its log,
// kept apart from the screens so they are tested on their own (billing-words.test.mjs). Pure: no React, no fetch.

const OPEN = new Set(["issued", "sent", "part_paid"]);

/** What a document waits for, in words, and its stripe's tone; null for a state the screen labels itself (paid, accepted,
 *  cancelled …). `d` needs docType, status, dueDate, ownerApproval, approvalAskedBy and approvalToName; `free`: the company's
 *  approval is off (KAZUK-FLOW). */
export function docStateWords(d, today, free = false) {
  const open = d.docType === "invoice" && OPEN.has(d.status);
  if (open && d.dueDate && d.dueDate < today) return { label: "Overdue", tone: "danger" };
  if (d.ownerApproval === "needed") return { label: "Price to approve", tone: "warning" };
  if (d.status === "draft") return d.approvalAskedBy ? { label: `With ${d.approvalToName ?? "the approver"}`, tone: "warning" } : { label: "Draft", tone: "neutral" };
  if (d.docType === "credit_note" && ["issued", "sent"].includes(d.status)) return { label: "Issued", tone: "neutral" };
  // KAZUK-FLOW (G2): with no approval a numbered quotation is simply to send.
  if (d.status === "issued") return { label: d.docType === "invoice" || free ? "To send" : "Approved · to send", tone: "accent" };
  if (d.status === "part_paid") return { label: "Part-paid", tone: "warning" };
  if (d.status === "sent") return { label: d.docType === "invoice" ? "Awaiting payment" : "With the customer", tone: "accent" };
  return null;
}

/** Words for what happened to something that is not a document (a catalogue item, stock, the settings). */
export const OTHER_WORDS = { created: "Added", edited: "Changed", saved: "Saved", parts: "Parts changed", seeded: "Drafted from past invoices", in: "Stock in", out: "Stock out",
  adjust: "Stock counted and set", deleted: "Deleted", exported: "Exported", archived: "Archived" };
export const SUBJECT_WORDS = { settings: "Billing settings", party: "A client's billing details", engagement: "A client package", template: "A template", export: "An export" };
const MONEY = new Set(["payment", "payment_voided", "payment_account"]);

/** "approval_asked" → "Approval asked": never a raw key on screen. */
export const sentence = (k) => String(k ?? "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** A log line's stripe: money in green, approvals and stock out amber, cancellations red, the rest blue or grey. */
export function logTone(kind) {
  if (kind === "payment" || kind.endsWith("accepted") || kind === "in") return "success";
  if (["cancel", "payment_voided", "deleted", "declined", "client_declined", "stock_short", "project_failed"].includes(kind)) return "danger";
  if (["approval_asked", "revised", "owner_approved", "out", "adjust"].includes(kind)) return "warning";
  if (["issued", "approval_given", "sent", "booked", "project_started"].includes(kind)) return "accent";
  return "neutral";
}

/** Which chip a log line falls under. */
export const logShow = (e) => (MONEY.has(e.kind) ? "money" : e.subjectType === "document" ? "documents" : e.subjectType === "item" || e.subjectType === "stock" ? "catalogue" : "other");

/** A log line as a sentence: what happened, to what, and where it opens. `events` maps a document event's kind to its
 *  words (documents/chain's EVENT); `types` a document type to its name. */
export function describeLog(e, events = {}, types = {}) {
  if (e.subjectType === "document") {
    const type = types[e.docType ?? "invoice"] ?? "Document";
    return { what: events[e.kind] ?? sentence(e.kind), of: e.number ? `${type} ${e.number}` : `${type} draft`,
      href: e.subjectId && e.kind !== "deleted" ? `/erp/documents/${e.subjectId}` : undefined };
  }
  if (e.subjectType === "item" || e.subjectType === "stock") {
    const qty = typeof e.detail?.qty === "number" ? ` · ${e.detail.qty}` : "";
    return { what: `${OTHER_WORDS[e.kind] ?? sentence(e.kind)}${qty}`, of: e.item ?? "A catalogue item", href: e.subjectId ? `/erp/catalog/${e.subjectId}` : undefined };
  }
  return { what: OTHER_WORDS[e.kind] ?? sentence(e.kind), of: SUBJECT_WORDS[e.subjectType] ?? sentence(e.subjectType), href: e.subjectType === "settings" ? "/erp/settings" : undefined };
}
