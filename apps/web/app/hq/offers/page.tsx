import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { CircleAlert, FileText, PenLine } from "lucide-react";
import { Message } from "../../ui";
import { loadHq } from "../load";
import { fromPrice, money, per, stackValue, valueWord } from "../model";
import { StatusPill, ValueRing } from "../parts";
import { DuplicateOffer, NewOffer } from "./actions";
import { STEPS, stepsDone } from "../steps";
import css from "../hq.module.css";

export const dynamic = "force-dynamic";

/** PULSE-HQ: Offer Studio's front: every offer with its value score and price, and the offers side by side. */
export default async function OffersPage() {
  const r = await loadHq();
  if (r.error || !r.data) return <Message text={r.error ?? "Offers are unavailable."} />;
  const { offers, canEdit } = r.data;
  const rows: { label: string; cell: (o: (typeof offers)[number]) => ReactNode }[] = [
    { label: "For", cell: (o) => o.icp.split(/[.,]/)[0] },
    { label: "Starts at", cell: (o) => <b>{money(fromPrice(o), o.currency)}{fromPrice(o) === null ? "" : per(o.billing)}</b> },
    { label: "Value score", cell: (o) => <b>{o.value.toFixed(1)} · {valueWord(o.value)}</b> },
    { label: "Dream × likelihood", cell: (o) => `${o.dream} × ${o.likelihood}` },
    { label: "Time × effort", cell: (o) => `${o.time} × ${o.effort}` },
    { label: "Tiers", cell: (o) => o.tiers.map((t) => t.name).join(" · ") },
    { label: "Features in top tier", cell: (o) => Math.max(0, ...o.tiers.map((t) => t.features.length)) },
    { label: "Problems solved", cell: (o) => (o.problems ?? []).length },
    { label: "Delivered as", cell: (o) => (o.delivery ?? []).slice(0, 3).join(" · ") },
    { label: "Bonuses worth", cell: (o) => money(stackValue(o), o.currency) },
    { label: "Builder", cell: (o) => `${stepsDone(o)} of ${STEPS.length} steps` },
    { label: "Guarantee", cell: (o) => o.guarantee.split(":")[0] },
  ];
  return <>
    <header className={css.pageHead}>
      <div><h1>Offer Studio</h1><p>Pick features into tiers, score the value equation, stack the bonuses, name it and price it.</p></div>
      {canEdit ? <div className={css.headActions}><NewOffer /></div> : null}
    </header>
    {offers.some((o) => o.draft) ? <p className={css.draftNote}><CircleAlert size={17} aria-hidden="true" />The three seeded offers are first drafts to react to: the prices, guarantees and bonuses are proposals, not commitments.</p> : null}
    {!offers.length ? <div className={css.empty}><b>No offers yet</b><span>Start one and the builder walks you through it: customer, problems, solutions from Pulse, delivery, bonuses, guarantee, name and price.</span>{canEdit ? <NewOffer label="Build the first offer" /> : null}</div> : null}
    <div className={css.offers}>
      {offers.map((o, i) => <article key={o.id} className={css.offerCard} style={{ "--offer": o.accent, "--i": i } as CSSProperties}>
        <div className={css.offerTop}>
          <div><StatusPill status={o.status} /><h2 className={css.offerName} style={{ marginTop: 10 }}>{o.name}</h2><p className={css.offerTag}>{o.naming?.tagline || o.dreamOutcome}</p></div>
          <ValueRing value={o.value} accent={o.accent} />
        </div>
        <div className={css.offerStats}>
          <div><span>Starts at</span><b>{money(fromPrice(o), o.currency, true)}{fromPrice(o) === null ? "" : per(o.billing)}</b></div>
          <div><span>Tiers</span><b>{o.tiers.length}</b></div>
          <div><span>Builder</span><b>{stepsDone(o)} / {STEPS.length} steps</b></div>
        </div>
        <div className={css.offerActions}>
          <Link href={`/hq/offers/${o.id}`} className={css.primary}><PenLine size={15} aria-hidden="true" />{canEdit ? "Open in studio" : "Open"}</Link>
          <Link href={`/hq/offers/${o.id}/sheet`} className={css.secondary}><FileText size={15} aria-hidden="true" />Offer sheet</Link>
          {canEdit ? <DuplicateOffer id={o.id} /> : null}
        </div>
      </article>)}
    </div>
    {offers.length > 1 ? <section className={css.section} aria-labelledby="hq-compare">
      <div className={css.sectionHead}><h2 id="hq-compare">Side by side</h2></div>
      <div className={css.tableWrap}><table className={css.table}>
        <thead><tr><td />{offers.map((o) => <th key={o.id} scope="col" style={{ color: o.accent }}>{o.name}</th>)}</tr></thead>
        <tbody>{rows.map((row) => <tr key={row.label}><th scope="row">{row.label}</th>{offers.map((o) => <td key={o.id}>{row.cell(o)}</td>)}</tr>)}</tbody>
      </table></div>
    </section> : null}
  </>;
}
