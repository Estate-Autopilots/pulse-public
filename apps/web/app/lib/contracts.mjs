// CONNECTORS-CONTRACTS (owner, 6 Nov 2026): the words a contract says on the screens (services/api/src/contracts.ts,
// migration 1583), in one place so the contracts page, a contract's page and My day say the same (contracts.test.mjs).

export const KIND_WORDS = Object.freeze({ employment: "Employment", retainer: "Retainer", services: "Services", revenue_share: "Revenue share", equity: "Equity" });
export const STATUS_WORDS = Object.freeze({ draft: "Draft", proposed: "Waiting for acceptance", active: "Active", ended: "Ended", cancelled: "Cancelled" });
export const ROLE_WORDS = Object.freeze({ provider: "Provider", client: "Client", employer: "Employer", employee: "Employee", partner: "Partner" });
export const UNIT_WORDS = Object.freeze({ month: "a month", hour: "an hour", deliverable: "each", one_off: "once", percent: "" });
export const SCHEDULE_WORDS = Object.freeze({ monthly: "Monthly", quarterly: "Quarterly", milestones: "At milestones", on_delivery: "On delivery", one_off: "Once" });
export const TXN_WORDS = Object.freeze({ invoice: "Invoice", retainer: "Retainer", payout: "Payout", payment: "Payment" });

const SYMBOL = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };
/** An amount in minor units (paise, cents) as people write it: ₹1,50,000 or ₹1,500.50. @param {number} minor @param {string} [currency] */
export function money(minor, currency = "INR") {
  const whole = Math.abs(minor) / 100;
  const text = new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-GB", { minimumFractionDigits: Number.isInteger(whole) ? 0 : 2, maximumFractionDigits: 2 }).format(whole);
  return `${minor < 0 ? "-" : ""}${SYMBOL[currency] ?? `${currency} `}${text}`;
}

/** One rate line in words: "₹1,00,000 a month", "10% of revenue". @param {{ label: string; amountMinor: number; unit: string }} r @param {string} currency */
export function rateWords(r, currency) {
  if (r.unit === "percent") return `${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(r.amountMinor / 100)}%`;
  return [money(r.amountMinor, currency), UNIT_WORDS[r.unit] ?? ""].filter(Boolean).join(" ");
}

/** Who has accepted the current version: "2 of 2 accepted", or who is still to accept. @param {{ name: string; current: boolean }[]} parties */
export function acceptanceWords(parties) {
  const done = parties.filter((p) => p.current).length;
  if (done === parties.length) return "Everyone accepted";
  const waiting = parties.filter((p) => !p.current).map((p) => p.name);
  return `${done} of ${parties.length} accepted · waiting for ${waiting.join(", ")}`;
}

/** Billed, paid and still owed, per currency. @param {{ currency: string; billedMinor: number; paidMinor: number; outstandingMinor: number }[]} totals */
export function totalsWords(totals) {
  if (!totals.length) return "Nothing billed yet";
  return totals.map((t) => `${money(t.billedMinor, t.currency)} billed · ${money(t.paidMinor, t.currency)} paid${t.outstandingMinor ? ` · ${money(t.outstandingMinor, t.currency)} owed` : ""}`).join("; ");
}

/** The dates in a line: "1 Dec 2026 – 30 Nov 2027 · 30 days' notice". @param {{ startsOn: string | null; endsOn: string | null; noticeDays: number | null }} c */
export function datesWords(c) {
  const d = (s) => new Date(`${s}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const span = c.startsOn && c.endsOn ? `${d(c.startsOn)} – ${d(c.endsOn)}` : c.startsOn ? `From ${d(c.startsOn)}` : c.endsOn ? `Until ${d(c.endsOn)}` : "No dates yet";
  return c.noticeDays === null || c.noticeDays === undefined ? span : `${span} · ${c.noticeDays === 1 ? "1 day's" : `${c.noticeDays} days'`} notice`;
}

/** The other side, from the viewer's: the parties that are not theirs. @param {{ name: string; mine: boolean; orgId: string | null }[]} parties @param {string | null} [us] */
export const otherSide = (parties, us = null) => parties.filter((p) => !p.mine && (!us || p.orgId !== us)).map((p) => p.name).join(", ") || "—";
