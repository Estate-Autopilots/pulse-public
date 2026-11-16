import Link from "next/link";
import type { CSSProperties } from "react";
import { ArrowUpRight, Lightbulb } from "lucide-react";
import { Message } from "../ui";
import { loadHq } from "./load";
import { CATEGORIES, fromPrice, money, per, plural, priority, valueWord } from "./model";
import { Legend, StatusBars, StatusPill, ValueRing, hue, statusCount } from "./parts";
import css from "./hq.module.css";
import { HqSearch, RecentItems } from "./recent";

export const dynamic = "force-dynamic";

/** PULSE-HQ (owner, 23 Oct 2026): the front page of the business of Pulse: what Pulse does, what we sell and what we
 *  are thinking about next, at a glance. */
export default async function HqOverview() {
  const r = await loadHq();
  if (r.error || !r.data) return <Message text={r.error ?? "Pulse HQ is unavailable."} />;
  const { ideas, offers, brand } = r.data;
  // Archived features left the product: they count nowhere on the front page (the catalogue shows them under Archived).
  const features = r.data.features.filter((f) => !f.archived);
  const live = statusCount(features, "live");
  const best = [...offers].sort((a, b) => b.value - a.value)[0];
  const rising = [...ideas].filter((i) => i.status !== "shipped" && i.status !== "parked").sort((a, b) => priority(b) - priority(a)).slice(0, 4);
  return <>
    <header className={css.pageHead}>
      <div><h1>Pulse HQ</h1><p>{brand?.oneLiner || "The business of Pulse: what it does, how we sell it and what comes next."}</p></div>
    </header>
    <HqSearch features={features} offers={offers} ideas={ideas} />
    <RecentItems />

    <section className={css.kpis} aria-label="At a glance">
      <Link href="/hq/features" className={css.kpi} style={{ "--i": 0 } as CSSProperties}>
        <span className={css.kpiLabel}>Features live</span>
        <span className={css.kpiValue}>{live}<small>/ {features.length}</small></span>
        <StatusBars features={features} />
      </Link>
      <Link href="/hq/features" className={css.kpi} style={{ "--i": 1 } as CSSProperties}>
        <span className={css.kpiLabel}>Product areas</span>
        <span className={css.kpiValue}>{CATEGORIES.filter((c) => features.some((f) => f.category === c.key)).length}</span>
        <span className={css.kpiSub}>from home to self-hosting</span>
      </Link>
      <Link href="/hq/offers" className={css.kpi} style={{ "--i": 2 } as CSSProperties}>
        <span className={css.kpiLabel}>Offers</span>
        <span className={css.kpiValue}>{offers.length}</span>
        <span className={css.kpiSub}>{best ? `Best value: ${best.name} · ${best.value.toFixed(1)}` : "Build the first one"}</span>
      </Link>
      <Link href="/hq/ideas" className={css.kpi} style={{ "--i": 3 } as CSSProperties}>
        <span className={css.kpiLabel}>Ideas in play</span>
        <span className={css.kpiValue}>{ideas.filter((i) => i.status !== "shipped" && i.status !== "parked").length}</span>
        <span className={css.kpiSub}>{ideas.filter((i) => i.status === "planned").length} planned · {plural(ideas.reduce((s, i) => s + i.votes, 0), "vote")}</span>
      </Link>
    </section>

    <section className={css.section} aria-labelledby="hq-areas">
      <div className={css.sectionHead}><h2 id="hq-areas">The product</h2><Link href="/hq/features">Open the catalogue</Link></div>
      <Legend />
      <div className={css.tiles}>
        {CATEGORIES.map((c, i) => {
          const own = features.filter((f) => f.category === c.key);
          if (!own.length) return null;
          return <Link key={c.key} href={`/hq/features?c=${c.key}`} className={css.tile} style={{ ...hue(c.key), "--i": i } as CSSProperties}>
            <span className={css.tileTop}><span className={css.hueIcon}><c.Icon size={19} aria-hidden="true" /></span><span className={css.tileName}>{c.label}</span><span className={css.tileCount}>{own.length}</span></span>
            <p className={css.tileBlurb}>{c.blurb}</p>
            <StatusBars features={own} />
          </Link>;
        })}
      </div>
    </section>

    <section className={css.section} aria-labelledby="hq-offers">
      <div className={css.sectionHead}><h2 id="hq-offers">Offers</h2><Link href="/hq/offers">Offer Studio</Link></div>
      <div className={css.offers}>
        {offers.map((o, i) => <Link key={o.id} href={`/hq/offers/${o.id}`} className={css.offerCard} style={{ "--offer": o.accent, "--i": i } as CSSProperties}>
          <div className={css.offerTop}>
            <div><StatusPill status={o.status} /><h3 className={css.offerName} style={{ marginTop: 10 }}>{o.name}</h3><p className={css.offerTag}>{o.naming?.tagline || o.dreamOutcome}</p></div>
            <ValueRing value={o.value} accent={o.accent} />
          </div>
          <div className={css.offerStats}>
            <div><span>From</span><b>{money(fromPrice(o), o.currency)}{fromPrice(o) === null ? "" : per(o.billing)}</b></div>
            <div><span>Tiers</span><b>{o.tiers.length}</b></div>
            <div><span>Value</span><b>{valueWord(o.value)}</b></div>
          </div>
        </Link>)}
      </div>
    </section>

    {rising.length ? <section className={css.section} aria-labelledby="hq-ideas">
      <div className={css.sectionHead}><h2 id="hq-ideas">Ideas rising</h2><Link href="/hq/ideas">Ideas board</Link></div>
      <div className={css.tiles}>
        {rising.map((idea, i) => <Link key={idea.id} href={`/hq/ideas?open=${idea.id}`} className={css.tile} style={{ "--hue": 262, "--i": i } as CSSProperties}>
          <span className={css.tileTop}><span className={css.hueIcon}><Lightbulb size={18} aria-hidden="true" /></span><span className={css.tileName}>{idea.title}</span><span className={css.priority} title="Priority">{priority(idea)}</span></span>
          <p className={css.tileBlurb}>{idea.problem}</p>
          <span className={css.cardFoot}><StatusPill status={idea.status} /><span className={css.cardWho}>{idea.forWhom}</span><ArrowUpRight size={15} aria-hidden="true" /></span>
        </Link>)}
      </div>
    </section> : null}

    {brand ? <Link href="/hq/brand" className={css.brandHero} style={{ textDecoration: "none" }}>
      <span className={css.eyebrow}>Positioning{brand.draft ? " · draft" : ""}</span>
      <h2>{brand.tagline}</h2>
      <p>{brand.promise}</p>
    </Link> : null}
  </>;
}
