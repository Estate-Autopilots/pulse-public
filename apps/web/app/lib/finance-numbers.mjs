// FINANCE-TRUTH (owner, 4 Nov 2026): the words and money format of Finance → Numbers and My sales (the API sends paise).

/** The periods a person picks, in the order they are offered. */
export const PERIODS = [
  { key: "month", label: "This month" },
  { key: "last", label: "Last month" },
  { key: "quarter", label: "Last 3 months" },
  { key: "fy", label: "This financial year" },
  { key: "lastfy", label: "Last financial year" },
];

const NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10" → "Oct 2026". */
export const monthName = (m) => (/^\d{4}-\d{2}/.test(String(m ?? "")) ? `${NAMES[Number(String(m).slice(5, 7)) - 1]} ${String(m).slice(0, 4)}` : "");
/** "Apr 2026 – Nov 2026", or one month alone. */
export const span = (from, to) => (from === to ? monthName(from) : `${monthName(from)} – ${monthName(to)}`);

/** Paise as whole rupees the Indian way; a negative figure keeps its sign. */
export function rupees(paise) {
  const n = Math.round(Number(paise ?? 0) / 100);
  return `${n < 0 ? "−" : ""}₹${Math.abs(n).toLocaleString("en-IN")}`;
}

/** A link's query for a period, keeping the other choices (the person being looked at). */
export function periodHref(base, period, keep = {}) {
  const q = new URLSearchParams(Object.entries({ ...keep, period }).filter(([, v]) => v));
  return `${base}${base.includes("?") ? "&" : "?"}${q}`;
}

const DOC_STATUS = { draft: "Draft", issued: "Approved", sent: "Sent", part_paid: "Part paid", paid: "Paid", accepted: "Accepted", declined: "Declined", converted: "Converted", cancelled: "Cancelled" };
export const statusLabel = (s) => DOC_STATUS[s] ?? String(s ?? "");

/** What is still due on an invoice, in words: base and GST apart when both are owed. */
export function dueText(baseDue, gstDue) {
  const b = Number(baseDue) || 0, g = Number(gstDue) || 0;
  if (!b && !g) return "Nothing due";
  if (b && g) return `${rupees(b)} + GST ${rupees(g)} due`;
  return b ? `${rupees(b)} due` : `GST ${rupees(g)} still to come`;
}
