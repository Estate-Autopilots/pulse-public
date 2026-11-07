// BILLING-EMAIL (owner, 5 Nov 2026; Kazuk: "e-mail is how my quotations go out", Akabod: the same for proformas and
// invoices). The e-mail an issued quotation, proforma or tax invoice goes out with: who it can go to (the customer's
// e-mail on the document, the billing profile and the point of contact), a subject and a message in plain words, the
// filed PDF attached and, for a quotation, the customer's acceptance link. Pure: no database, no mail; erp.ts reads the
// document and sends through the platform's one mail path (mail-send.ts). Nothing here sends by itself: a person
// presses Send in the composer.
import { ErpInputError } from "./erp-model.js";

/** The documents that go by e-mail, and the states they can be sent in (approved and numbered, not closed). */
export const MAIL_DOC_TYPES = ["quotation", "proforma", "invoice"] as const;
export const MAIL_STATUSES = ["issued", "sent", "accepted", "part_paid", "paid"] as const;
export const MAX_RECIPIENTS = 5;
const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const LABEL: Record<string, string> = { quotation: "Quotation", proforma: "Proforma invoice", invoice: "Tax invoice" };

export const mailable = (docType: string, status: string) => (MAIL_DOC_TYPES as readonly string[]).includes(docType) && (MAIL_STATUSES as readonly string[]).includes(status);

/** An address as it is sent to, or null when it is not one. */
export function cleanAddress(x: unknown): string | null {
  const a = typeof x === "string" ? x.trim().toLowerCase() : "";
  return a.length <= 254 && EMAIL.test(a) ? a : null;
}

export type Suggestion = { email: string; name: string | null; source: "document" | "billing" | "contact" };
/** The addresses offered in the composer, each once, the document's own first. */
export function suggestions(rows: { email: unknown; name?: unknown; source: Suggestion["source"] }[]): Suggestion[] {
  const seen = new Set<string>(), out: Suggestion[] = [];
  for (const r of rows) {
    const email = cleanAddress(r.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 120) : null, source: r.source });
  }
  return out.slice(0, 10);
}

/** The recipients the person chose: valid, each once, one to five. Anything else is refused with what to fix. */
export function recipients(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,;\s]+/) : [];
  const out: string[] = [];
  for (const x of list) {
    if (typeof x === "string" && !x.trim()) continue;
    const a = cleanAddress(x);
    if (!a) throw new ErpInputError(`“${String(x).slice(0, 80)}” is not an e-mail address`);
    if (!out.includes(a)) out.push(a);
  }
  if (!out.length) throw new ErpInputError("Add the customer's e-mail address");
  if (out.length > MAX_RECIPIENTS) throw new ErpInputError(`Send to at most ${MAX_RECIPIENTS} addresses at a time`);
  return out;
}

const rupees = (paise: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format((Number(paise) || 0) / 100);
/** A calendar day ("2026-11-20") as people read it: 20 Nov 2026. */
const day = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d)
  ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }) : null);
const first = (name: unknown) => (typeof name === "string" && name.trim() ? name.trim().split(/\s+/)[0] : "");

export type MailDoc = { docType: string; number: string | null; total: number; balance?: number | null; validUntil?: string | null; dueDate?: string | null;
  buyer?: { name?: string | null; contactName?: string | null } | null; seller?: { tradeName?: string | null; legalName?: string | null } | null };

/** The subject and message the composer starts with; the person can change both before sending. */
export function documentMail(d: MailDoc, sender: { name?: string | null } = {}) {
  const label = LABEL[d.docType] ?? "Document";
  const company = (d.seller?.tradeName || d.seller?.legalName || "").trim() || "us";
  const greet = first(d.buyer?.contactName) || first(d.buyer?.name);
  const number = d.number ?? "";
  const lines = [`Hello${greet ? ` ${greet}` : ""},`, ""];
  if (d.docType === "quotation") {
    lines.push(`Please find attached our quotation ${number} for ${rupees(d.total)}${day(d.validUntil) ? `, valid until ${day(d.validUntil)}` : ""}.`, "",
      "You can see it and accept it online with the link below. If anything needs to change, reply to this e-mail and we will revise it.");
  } else if (d.docType === "proforma") {
    lines.push(`Please find attached proforma invoice ${number} for ${rupees(d.total)}.`, "", "The tax invoice follows once the payment is received. Reply to this e-mail with any questions.");
  } else {
    const due = d.balance !== undefined && d.balance !== null ? Math.max(0, d.balance) : d.total;
    lines.push(`Please find attached tax invoice ${number} for ${rupees(d.total)}.`, "",
      due > 0 ? `${rupees(due)} is due${day(d.dueDate) ? ` by ${day(d.dueDate)}` : ""}. The bank details are on the invoice.` : "It is paid in full: thank you.");
  }
  lines.push("", "Thank you,", ...(sender.name?.trim() ? [sender.name.trim()] : []), company);
  return { subject: `${label} ${number} from ${company}`.replace(/\s+/g, " ").trim().slice(0, 200), body: lines.join("\n") };
}

/** The message as sent: the person's words, and for a quotation the acceptance link on its own line at the end. */
export function finalBody(body: string, link: string | null) {
  const text = body.replace(/\r\n?/g, "\n").trim().slice(0, 8000);
  return link ? `${text}\n\nSee the quotation and accept it: ${link}` : text;
}
