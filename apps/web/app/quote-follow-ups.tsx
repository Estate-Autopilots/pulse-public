import Link from "next/link";
import { BellRing, Send } from "lucide-react";
import { api } from "./lib/api";
import { quoteRows, type QuoteHome } from "./lib/quote-moves.mjs";
import { Panel } from "./ui";
import css from "./resume-drafts.module.css";

/** QUOTE-FIXES (Mac re-test of 3214d396, 21 Nov 2026: "Home shows draft quotes, but the proforma is missing", and the
 *  follow-up never reached Home or My day): the person's own quotations and proformas not sent yet, and their next quote
 *  follow-ups with the day and time, on every dashboard view and on My day. Nothing shows when there is nothing to do.
 *  Data: GET /api/v0/quotes/follow-ups (pulse.erp_quote_home); someone without Billing gets nothing back. */
export async function QuoteFollowUps() {
  const r = await api<NonNullable<QuoteHome>>("quotes/follow-ups");
  const rows = quoteRows(r.data ?? null);
  if (!rows.length) return null;
  return <Panel title="Quotes to follow up" sub="Send what is not sent yet; follow up on the day">
    <ul className={css.list} aria-label="Quotes to follow up">{rows.map((x) => <li key={x.key}><Link href={x.href} className={css.row}>
      {x.go === "Open" ? <BellRing size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
      <span className={css.main}><b>{x.title}</b><small>{x.sub}</small></span><span className={css.go}>{x.go}</span>
    </Link></li>)}</ul>
  </Panel>;
}
