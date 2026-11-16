// PULSE-HQ: an offer as a one-page sheet, the way a customer or an investor reads it: the dream, the value equation,
// what you get, the tiers, the value stack against the price, the guarantee, scarcity and urgency, the positioning.
// No hooks: Offer Studio shows it live beside the editor and /hq/offers/[id]/sheet prints it.
import type { CSSProperties } from "react";
import { Check, Clock, Flame, Gift, Hourglass, ShieldCheck, Sparkles, Target } from "lucide-react";
import { CATEGORIES, money, per, stackValue, valueScore, valueWord, type Feature, type Offer } from "./model";
import css from "./hq.module.css";

const TIER_PREVIEW = 6;

export function OfferSheet({ offer: o, features, full }: { offer: Offer; features: Feature[]; full?: boolean }) {
  const byKey = new Map(features.map((f) => [f.key, f]));
  const value = valueScore(o);
  const bonusTotal = stackValue(o);
  const highlight = o.tiers.find((t) => t.highlight) ?? o.tiers[0];
  const price = typeof o.price === "number" ? o.price : highlight?.price ?? null;
  const shared = o.tiers.length ? o.tiers[0].features.filter((k) => o.tiers.every((t) => t.features.includes(k))) : [];
  const differs = [...new Set(o.tiers.flatMap((t) => t.features))].filter((k) => !shared.includes(k) && byKey.has(k));
  const diffGroups = CATEGORIES.map((c) => ({ ...c, keys: differs.filter((k) => byKey.get(k)?.category === c.key) })).filter((g) => g.keys.length);
  return <article className={css.sheetDoc} style={{ "--offer": o.accent } as CSSProperties} aria-label={`Offer sheet: ${o.name}`}>
    <div className={css.docTop}><span className={css.docBrand}><i>P</i>Pulse</span><span>{o.draft || o.status === "draft" ? "Draft offer" : o.status === "testing" ? "Offer in testing" : "Offer"}</span></div>
    <header>
      <h2 className={css.docName}>{o.name || "Untitled offer"}</h2>
      {o.naming?.tagline ? <p className={css.docTagline}>{o.naming.tagline}</p> : null}
      {o.icp ? <p className={css.docFor}><b>Made for</b> {o.icp}</p> : null}
    </header>
    {o.dreamOutcome ? <p className={css.dream}><small>The dream outcome</small>{o.dreamOutcome}</p> : null}

    {(o.problems ?? []).length ? <section className={css.docBox} aria-label="The problems it solves">
      <h4><Target size={14} aria-hidden="true" />The problems it solves</h4>
      <ul className={css.probList}>{o.problems.map((p, i) => <li key={i}><span className={css.probQ}>{p.problem}</span><span className={css.probA}><Check size={14} aria-hidden="true" />{p.solution}
        {p.features.length ? <small>{p.features.map((k) => byKey.get(k)?.name).filter(Boolean).join(" · ")}</small> : null}</span></li>)}</ul>
    </section> : null}

    <div className={css.docGrid}>
      <section className={css.docBox} aria-label="What you get">
        <h4><Sparkles size={14} aria-hidden="true" />What you get</h4>
        {o.deliverables.length || (o.delivery ?? []).length ? <ul className={css.ticks}>{[...o.deliverables, ...(o.delivery ?? []).filter((d) => !o.deliverables.includes(d))].map((d, i) => <li key={i}><Check size={15} aria-hidden="true" />{d}</li>)}</ul> : <p>Add how it is delivered.</p>}
      </section>
      <section className={css.docBox} aria-label="Value equation">
        <h4><Target size={14} aria-hidden="true" />Value equation</h4>
        <div className={css.valueBadge}><b>{value >= 10 ? Math.round(value) : value.toFixed(1)}</b><span title="(dream × likelihood) ÷ (time delay × effort)">{valueWord(value)} value</span></div>
        <Factor label="Dream" v={o.dream} />
        <Factor label="Likelihood" v={o.likelihood} />
        <Factor label="Time delay" v={o.time} down />
        <Factor label="Effort" v={o.effort} down />
      </section>
    </div>

    {o.tiers.length ? <section className={css.section} aria-label="Tiers" style={{ gap: 18 }}>
      <div className={css.tiers} style={{ "--n": o.tiers.length } as CSSProperties}>
        {o.tiers.map((t) => <div key={t.key} className={css.tierCard} data-highlight={t.highlight ? "" : undefined}>
          {t.highlight ? <span className={css.tierBadge}>Most chosen</span> : null}
          <span className={css.tierName}>{t.name}</span>
          <span className={css.tierPrice}>{t.price !== null ? <>{money(t.price, o.currency)}<small>{per(o.billing)}</small></> : <small style={{ marginLeft: 0 }}>Price on request</small>}</span>
          {t.blurb ? <p className={css.tierBlurb}>{t.blurb}{t.seats ? ` Up to ${t.seats} people.` : ""}</p> : null}
          <ul className={css.tierFeats}>
            {t.features.filter((k) => byKey.has(k)).slice(0, full ? 999 : TIER_PREVIEW).map((k) => <li key={k}><Check size={13} aria-hidden="true" />{byKey.get(k)!.name}</li>)}
            {!full && t.features.length > TIER_PREVIEW ? <li className={css.more}>+ {t.features.length - TIER_PREVIEW} more features</li> : null}
          </ul>
        </div>)}
      </div>
      {o.tiers.length > 1 && diffGroups.length ? <details open={full}>
        <summary className={css.subhead} style={{ cursor: "pointer" }}>Compare tiers · every tier includes {shared.length} core features</summary>
        <div style={{ overflowX: "auto", marginTop: 8 }}><table className={css.compare}>
          <thead><tr><th>Feature</th>{o.tiers.map((t) => <th key={t.key}>{t.name}</th>)}</tr></thead>
          <tbody>{diffGroups.map((g) => [<tr key={g.key} className={css.catRow}><td colSpan={o.tiers.length + 1}>{g.label}</td></tr>,
            ...g.keys.map((k) => <tr key={k}><td>{byKey.get(k)!.name}</td>{o.tiers.map((t) => <td key={t.key}>{t.features.includes(k) ? <Check size={15} aria-label="Included" /> : <span aria-label="Not included" style={{ color: "var(--faint)" }}>–</span>}</td>)}</tr>)])}</tbody>
        </table></div>
      </details> : null}
    </section> : null}

    {o.bonuses.length || o.anchors.length ? <div className={css.docGrid}>
      <section className={css.docBox} aria-label="Value stack">
        <h4><Gift size={14} aria-hidden="true" />The value stack</h4>
        <ul className={css.stack}>
          {o.bonuses.map((b, i) => <li key={i}><span>{b.name}{b.why ? <small>{b.why}</small> : null}</span><b>{money(b.value, o.currency)}</b></li>)}
          {o.bonuses.length ? <li data-total=""><span>Bonuses worth</span><b>{money(bonusTotal, o.currency)}</b></li> : null}
          {price !== null ? <li data-price=""><span>Your price{highlight ? ` (${highlight.name})` : ""}</span><b>{money(price, o.currency)}{per(o.billing)}</b></li> : null}
        </ul>
      </section>
      <section className={css.docBox} aria-label="Price anchors">
        <h4><Clock size={14} aria-hidden="true" />What it costs without Pulse</h4>
        <ul className={css.stack}>{o.anchors.map((a, i) => <li key={i}><span>{a.label}</span><b>{money(a.amount, o.currency)}</b></li>)}</ul>
      </section>
    </div> : null}

    <div className={css.promise3}>
      {o.guarantee ? <section className={css.docBox}><h4><ShieldCheck size={14} aria-hidden="true" />Guarantee</h4><p>{o.guarantee}</p></section> : null}
      {o.scarcity ? <section className={css.docBox}><h4><Hourglass size={14} aria-hidden="true" />Scarcity</h4><p>{o.scarcity}</p></section> : null}
      {o.urgency ? <section className={css.docBox}><h4><Flame size={14} aria-hidden="true" />Urgency</h4><p>{o.urgency}</p></section> : null}
    </div>
    {o.positioning ? <p className={css.positioning}>{o.positioning}</p> : null}
    <div className={css.docFoot}><span>Pulse · the operating system for teams that deliver</span><span>{o.updatedAt ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(o.updatedAt)) : null}</span></div>
  </article>;
}

function Factor({ label, v, down }: { label: string; v: number; down?: boolean }) {
  return <div className={css.factor}><span>{label}</span><span className={css.factorBar} data-down={down ? "" : undefined}><i style={{ "--v": v } as CSSProperties} /></span><span>{v}</span></div>;
}
