// QUOTE-FIXES (Mac tests 21 Nov 2026; owner, 20 Nov: "a visible 'not sent yet' state and an exact follow-up on Home"): the
// "Quotes to follow up" rows on the dashboard (every Home view) and on My day, from GET /api/v0/quotes/follow-ups
// (pulse.erp_quote_home, 2500/2501). Pure; tested in quote-moves.test.mjs.

const DAY = 86_400_000;
const DAY_FMT = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
const TIME_FMT = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const istDay = (t) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(t));
const NOUN = { quotation: "Quotation", proforma: "Proforma" };

/**
 * @typedef {{ documentId: string; number: string | null; client: string; nextDueAt: string }} FollowUp
 * @typedef {{ documentId: string; docType: string; number: string | null; client: string; issuedAt?: string | null }} NotSent
 * @typedef {{ followUps?: FollowUp[]; notSent?: number; notSentDocs?: NotSent[] } | null | undefined} QuoteHome
 * @typedef {{ key: string; title: string; sub: string; href: string; go: string; tone: "warn" | "info" }} QuoteRow
 */

/** "today, 9:00 am", "tomorrow, 9:00 am", "Mon, 23 Nov, 9:00 am", "was due Fri, 20 Nov, 9:00 am" (India time). */
export function whenWords(at, now = Date.now()) {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return "";
  const days = Math.round((Date.parse(`${istDay(t)}T00:00:00+05:30`) - Date.parse(`${istDay(now)}T00:00:00+05:30`)) / DAY);
  const time = TIME_FMT.format(new Date(t));
  return `${days < 0 ? "was due " : ""}${days === 0 ? "today" : days === 1 ? "tomorrow" : DAY_FMT.format(new Date(t))}, ${time}`;
}

/** The panel's rows: each document not sent yet (Send), then each follow-up, soonest first (Open). Empty: no panel.
 * @param {QuoteHome} q @param {number} [now] @returns {QuoteRow[]} */
export function quoteRows(q, now = Date.now()) {
  /** @type {QuoteRow[]} */
  const rows = [];
  for (const d of (q?.notSentDocs ?? []).slice(0, 5)) {
    rows.push({ key: `ns-${d.documentId}`, title: `${NOUN[d.docType] ?? "Document"} ${d.number ?? ""} · ${d.client}`.replace(/\s+·/, " ·"),
      sub: "Not sent yet", href: `/erp/documents/${d.documentId}`, go: "Send", tone: "warn" });
  }
  const more = Number(q?.notSent ?? 0) - rows.length;
  if (more > 0) rows.push({ key: "ns-more", title: `${more} more not sent yet`, sub: "Quotations and proformas", href: `/erp/documents?q=${encodeURIComponent("not sent yet")}`, go: "See all", tone: "warn" });
  for (const f of (q?.followUps ?? []).slice(0, 5)) {
    const t = Date.parse(f.nextDueAt);
    if (Number.isNaN(t)) continue;
    rows.push({ key: `fu-${f.documentId}`, title: `Follow up ${f.client} on ${f.number ?? "the quotation"}`, sub: `Follow-up ${whenWords(f.nextDueAt, now)}`,
      href: `/erp/documents/${f.documentId}`, go: "Open", tone: t <= now ? "warn" : "info" });
  }
  return rows;
}
