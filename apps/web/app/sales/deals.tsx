import Link from "next/link";
import { Handshake, Scissors, ThumbsDown, Users } from "lucide-react";
import { Badge } from "../ui";
import { StatTile as Tile, StatTiles as Tiles, StripeCard as Card } from "../components/kit";
import { EmptyState as GameEmpty } from "../kit/game";
import { DEAL_LABEL, type DealStatus } from "../erp/types";
import { LOST_WORDS, cutText, daysText, discount, discountText, discountTone, headline, money } from "../lib/deals.mjs";
import css from "./deals.module.css";

/* KAZUK-V2 G12 (Kazuk, 6 Nov 2026, R31: "how the first quotation was, the second, the final"). The negotiation numbers,
   read only, as one board: Billing → Deals (everyone's for the Sales Head, leadership and Finance) and a section of My
   sales (the person's own). Layout from Codex's concept 1 (tiles, "cut most" beside "why lost") with concept 3's deal
   cards, so nothing is a wide table on a phone (reports/kazuk-v2/concepts/deals). Data: GET /api/v0/sales-deals
   (pulse.sales_deals, 1930), paise. */

type Summary = { deals: number; won: number; lost: number; open: number; v1Won: number; finalWon: number; versions: number | null; revised: number; daysToYes: number | null; daysToPaid: number | null; paid: number };
export type Deals = {
  period: string; from: string; to: string; today: string; everyone: boolean; canSeeTeam: boolean; canOpenErp: boolean; ownOnly: boolean; team: { id: string; name: string }[] | null;
  person: { id: string; name: string; self: boolean } | null;
  summary: Summary;
  people: (Omit<Summary, "open" | "revised" | "paid"> & { id: string | null; name: string })[] | null;
  cuts: { name: string; deals: number; removed: number; lowered: number; amount: number }[];
  lostBy: { reason: string; count: number; value: number }[];
  versionWhy: { reason: string; count: number }[];
  deals: { id: string; number: string | null; buyer: string | null; status: DealStatus; salesperson: string | null; versions: number; v1: number; final: number;
    sentOn: string | null; yesOn: string | null; daysToYes: number | null; invoicedOn: string | null; paidOn: string | null; daysToPaid: number | null; lostReason: string | null }[];
};

/** "Said yes the same day", "Said yes in 9 days", "No yes yet". */
const yesWords = (n: number | null) => (n === null || n === undefined ? "No yes yet" : n <= 0 ? "Said yes the same day" : `Said yes in ${daysText(n)}`);

/** Why a quotation was changed, as people say it. */
const WHY_PLAIN: Record<string, string> = { price: "price", scope: "what was included", timeline: "timing", other: "other reasons" };

const TONE: Partial<Record<DealStatus, "success" | "warning" | "danger" | "accent" | "neutral">> = { paid: "success", accepted: "success", invoiced: "accent", part_paid: "warning", lost: "danger", negotiating: "warning", sent: "accent" };

/** `list={false}` leaves out the per-deal cards (My sales lists the deals once, in its own My deals). */
export function DealsBoard({ d, own, newHref, list = true }: { d: Deals; own: boolean; newHref?: string; list?: boolean }) {
  const s = d.summary, h = headline(s), you = own ? "you" : d.everyone ? "the team" : (d.person?.name ?? "they");
  if (!s.deals) return <GameEmpty art="nothing" title="No deals in this period yet"
    text="Once a quotation goes out, its versions show here: the first price, the final one, and what was cut on the way. Pick a longer period to see older deals."
    action={newHref ? { href: newHref, label: "New quotation" } : undefined} />;
  const lostTotal = s.lost;
  return <div className={css.board}>
    {h.pct !== null && h.pct > 0 ? <div className={css.takeaway}>
      <p>{own ? "You" : d.everyone ? "The team" : d.person?.name ?? "They"} gave <b>{h.discount} off</b> the first price on deals won.</p>
      <div className={css.tryFirst}><span>{own ? "Next time, try these first:" : "Before a discount, salespeople can try first:"}</span>
        <ol>{["Better payment terms", "A bonus at no charge", "One package down"].map((t, i) => <li key={t}><b>{i + 1}</b>{t}</li>)}</ol></div>
    </div> : null}
    <Tiles count={5} label="Deal numbers">
      <Tile label="Average discount" value={h.discount} note={h.discountNote}
 />
      <Tile label="Quotes changed" value={String(s.revised)} note={s.deals ? `of ${s.deals} deals` : h.versionsNote} />
      <Tile label="Days to say yes" value={h.yes} note={h.yes === "0" ? "Same day, on average" : h.yesNote} />
      <Tile label="Days to paid" value={h.paid} note={h.paidNote} />
      <Tile label="Lost" value={String(lostTotal)}
        note={`${s.won} won · ${s.open} open`} />
    </Tiles>
    <div className={css.grid}>
      <Card stripe="in" icon={Scissors} title={own ? "Services I cut or made cheaper" : "Services cut or made cheaper"} sub="First quotation against the latest version">
        <div className={css.pad}>
          {d.cuts.length ? <ul className={css.facts2}>{d.cuts.map((c, i) => <li key={i}><b>{c.name}</b><span>{cutText(c)} · {money(c.amount)} less</span></li>)}</ul>
            : <p className={css.why}>{s.revised ? "Every service kept its first price." : "No deal got a new version yet, so nothing was cut."}</p>}
          {d.versionWhy.length ? <p className={css.why}>Changed: {d.versionWhy.map((r) => `${r.count} for ${WHY_PLAIN[r.reason] ?? "other reasons"}`).join(", ")}</p> : null}
        </div>
      </Card>
      <Card stripe="in" icon={ThumbsDown} title={own ? "Why I lost deals" : "Why deals were lost"} sub={lostTotal ? `${lostTotal} lost, worth ${money(d.lostBy.reduce((a, l) => a + l.value, 0))}` : undefined}>
        <div className={css.pad}>
          {d.lostBy.length ? <ul className={css.facts2}>{d.lostBy.map((l) => <li key={l.reason}><b>{LOST_WORDS[l.reason as keyof typeof LOST_WORDS] ?? l.reason}</b><span>{l.count} deal{l.count === 1 ? "" : "s"} · {money(l.value)}</span></li>)}</ul>
            : <p className={css.why}>No deal was lost in this period. Nice work by {you}.</p>}
        </div>
      </Card>
    </div>
    {d.everyone && d.people?.length ? <Card stripe="in" icon={Users} title="By salesperson" sub="Won deals: first price against agreed">
      <ul className={css.people} aria-label="By salesperson"><li className={`${css.person} ${css.personHead}`} aria-hidden="true"><span>Salesperson</span><span>Won</span><span>Off the first price</span><span>Versions and days to yes</span></li>{d.people.map((p) => {
        const pct = discount(p.v1Won, p.finalWon);
        return <li key={p.id ?? "none"} className={css.person}>
          <b>{p.name}</b>
          <span>{p.won} won of {p.deals}{p.lost ? ` · ${p.lost} lost` : ""}</span>
          <span>{pct === null ? "No deal won" : discountText(pct)}</span>
          <span>{p.versions ?? "—"} version{p.versions === 1 ? "" : "s"} a deal · {yesWords(p.daysToYes)}</span>
        </li>;
      })}</ul>
    </Card> : null}
    {list ? <Card stripe="in" icon={Handshake} title={own ? "My deals" : "Each deal"} count={d.deals.length} sub="By the day the first quotation went out, newest first">
      <ul className={css.deals} aria-label="Each deal">{d.deals.map((x) => {
        const pct = discount(x.v1, x.final);
        const name = `${x.buyer ?? "Client not named"}${x.number ? ` · ${x.number}` : ""}`;
        return <li key={x.id} className={css.deal}>
          <div className={css.dealTop}>
            {d.canOpenErp ? <Link href={`/erp/documents/${x.id}`} className={css.dealName}>{name}</Link> : <span className={css.dealName}>{name}</span>}
            <span className={css.dealRight}><b>{money(x.final)}</b><Badge tone={TONE[x.status] ?? "neutral"}>{DEAL_LABEL[x.status] ?? x.status}{x.status === "lost" && x.lostReason ? `: ${(LOST_WORDS[x.lostReason as keyof typeof LOST_WORDS] ?? x.lostReason).toLowerCase()}` : ""}</Badge></span>
          </div>
          {x.v1 !== x.final ? <p className={css.price}><span>First price {money(x.v1)}</span>{pct !== null && pct !== 0 ? <Badge tone={discountTone(pct)}>{discountText(pct)}</Badge> : null}</p> : null}
          <p className={css.facts}>
            <span className={css.dots} aria-label={`${x.versions} version${x.versions === 1 ? "" : "s"}`}>{Array.from({ length: Math.min(x.versions, 6) }, (_, i) => <i key={i} />)}<small>{x.versions} version{x.versions === 1 ? "" : "s"}</small></span>
            {x.status === "lost" ? null : <span>{x.yesOn ? yesWords(x.daysToYes) : "Waiting for a yes"}</span>}
            {x.paidOn ? <span>{x.daysToPaid ? `Paid ${daysText(x.daysToPaid)} after the invoice` : "Paid the day of the invoice"}</span> : x.invoicedOn ? <span>Invoiced, not fully paid</span> : null}
            {d.everyone && x.salesperson ? <span>{x.salesperson}</span> : null}
          </p>
        </li>;
      })}</ul>
    </Card> : null}
  </div>;
}
