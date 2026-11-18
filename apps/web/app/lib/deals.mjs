// KAZUK-V2 G12 (Kazuk, 6 Nov 2026, R31): the words and sums of the negotiation numbers (Billing → Deals and the My
// sales section). Amounts arrive in paise from GET /api/v0/sales-deals; nothing here reads the network. Unit-tested in
// deals.test.mjs.
import { rupees as short } from "./goals.mjs";

/** Full rupees from paise, Indian grouping: ₹75,000, ₹4,20,000. @param {number} paise */
export const money = (paise) => short(Math.round(Number(paise ?? 0) / 100), true);

/** The discount from the first price to the latest, in % with one decimal; null when there is no first price.
 *  Negative when the price went up. @param {number} v1 @param {number} final */
export function discount(v1, final) {
  const a = Number(v1), b = Number(final);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null;
  return Math.round(((a - b) / a) * 1000) / 10;
}

/** @param {number | null} pct */
export function discountText(pct) {
  if (pct === null || pct === undefined) return "No first price";
  if (pct === 0) return "No discount";
  return pct > 0 ? `${pct}% off` : `${-pct}% up`;
}

/** The chip's colour: the house accent for any discount; never warning or red (it is a read-only report, not a verdict). */
export function discountTone(pct) {
  return pct === null || pct === undefined || pct <= 0 ? "neutral" : "accent";
}

/** @param {number | null | undefined} n */
export function daysText(n) {
  if (n === null || n === undefined) return "Not yet";
  if (n <= 0) return "Same day";
  return n === 1 ? "1 day" : `${n} days`;
}

export const LOST_WORDS = { price: "Price", competitor: "Competitor", no_response: "No response", timing: "Timing", scope: "Scope", other: "Other", not_said: "Not said" };
export const WHY_WORDS = { price: "Price", scope: "Scope", timeline: "Timeline", other: "Other", not_said: "Not said" };

/** What happened to a service between the first quotation and the latest: "Cut in 2 deals · lowered in 1". */
export function cutText(c) {
  const parts = [];
  if (c.removed) parts.push(`cut in ${c.removed} deal${c.removed === 1 ? "" : "s"}`);
  if (c.lowered) parts.push(`lowered in ${c.lowered} deal${c.lowered === 1 ? "" : "s"}`);
  const s = parts.join(" · ");
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

/** The four headline numbers of a summary, ready for tiles. */
export function headline(s) {
  const pct = discount(s.v1Won, s.finalWon);
  return {
    pct, discount: pct === null ? "—" : `${pct}%`,
    discountNote: s.won ? `${money(s.v1Won)} → ${money(s.finalWon)}` : "No deal won in this period",
    versions: s.versions === null || s.versions === undefined ? "—" : String(s.versions),
    versionsNote: s.deals ? `${s.revised} of ${s.deals} deal${s.deals === 1 ? "" : "s"} got a new version` : "None sent in this period",
    yes: s.daysToYes === null || s.daysToYes === undefined ? "—" : String(s.daysToYes),
    yesNote: s.won ? "On average" : "Once a deal is won",
    paid: s.daysToPaid === null || s.daysToPaid === undefined ? "—" : String(s.daysToPaid),
    paidNote: s.paid ? "Invoice to paid, on average" : "Once an invoice is paid",
  };
}
