// Billing redesign (18 Oct 2026): what the document page and the composer share. The chain a document belongs to
// (Quotation → Proforma → Tax invoice, or Tax invoice → Credit note) from the documents related to it, the log's words,
// and rupees.
import { formatInr } from "@pulse/invoice-doc/gst";
import type { ChainStep } from "../../kit/next-step";
import type { Doc } from "../types";

export const inr = (paise: number) => formatInr(paise, { decimals: Math.round(paise) % 100 !== 0 });
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The steps of the chain this document sits in; documents made from it or that it was made from link to each other. */
export function chainSteps(d: Pick<Doc, "id" | "docType" | "number" | "sourceId" | "againstId">, related: Doc[]): ChainStep[] {
  const live = related.filter((r) => r.status !== "cancelled" && r.id !== d.id);
  const step = (key: string, label: string, r?: Pick<Doc, "id" | "number"> | null, self = false): ChainStep =>
    ({ key, label, href: r && !self ? `/erp/documents/${r.id}` : undefined, sub: r ? r.number ?? "draft" : undefined });
  if (d.docType === "credit_note") return [step("invoice", "Tax invoice", live.find((r) => r.id === d.againstId)), step("credit_note", "Credit note", d, true)];
  const source = live.find((r) => r.id === d.sourceId);
  const made = (type: string) => live.find((r) => r.sourceId === d.id && r.docType === type);
  const quote = d.docType === "quotation" ? d : source?.docType === "quotation" ? source : null;
  const proforma = d.docType === "proforma" ? d : source?.docType === "proforma" ? source : made("proforma");
  const invoice = d.docType === "invoice" ? d : made("invoice");
  const steps: ChainStep[] = [];
  // An invoice made straight from a milestone has no quotation before it: the chain starts where the document did.
  if (quote) steps.push(step("quotation", "Quotation", quote, quote === d));
  if (proforma || d.docType === "quotation") steps.push(step("proforma", "Proforma", proforma, proforma === d));
  steps.push(step("invoice", "Tax invoice", invoice, invoice === d));
  return steps;
}

export const EVENT: Record<string, string> = { created: "Created", edited: "Edited", issued: "Approved and numbered", exported: "PDF downloaded", sent: "Marked sent", payment: "Payment recorded",
  payment_voided: "Payment removed", cancel: "Cancelled", accepted: "Customer accepted", declined: "Customer declined", task: "Given to a person", link_created: "Acceptance link made",
  link_opened: "Customer opened the link", client_accepted: "Customer accepted (link)", client_declined: "Customer declined (link)", deleted: "Deleted", owner_approved: "Owner approved the price",
  followup_scheduled: "Follow-up scheduled", followup_due: "Follow-up due", followup_replied: "Customer replied", followup_later: "Follow-up moved (call later)",
  followup_close: "Follow-up closed", followup_stopped: "Follow-ups stopped" };
export const when = (at: string) => new Date(at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
