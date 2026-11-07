"use client";
// PULSE-HQ: recently opened features and offers (this browser only), shown on the HQ front page, and a search across
// every feature, offer and idea from there.
import Link from "next/link";
import { useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Clock, Gem, Lightbulb, Search } from "lucide-react";
import { CATEGORY, type Feature, type Idea, type Offer } from "./model";
import { FeatureIcon, StatusPill, hue } from "./parts";
import css from "./hq.module.css";

type Recent = { href: string; title: string; kind: "feature" | "offer"; at: number };
const KEY = "pulse.hq.recent";
let raw: string | null | undefined, list: Recent[] = [];
const read = () => { let r: string | null = null; try { r = window.localStorage.getItem(KEY); } catch { /* private window */ }
  if (r !== raw) { raw = r; try { list = r ? JSON.parse(r) as Recent[] : []; } catch { list = []; } } return list; };
const EMPTY: Recent[] = [];

/** Remembers that this page was opened (call it from the page). */
export function TrackRecent({ href, title, kind }: Omit<Recent, "at">) {
  useEffect(() => {
    try {
      const next = [{ href, title, kind, at: Date.now() }, ...read().filter((x) => x.href !== href)].slice(0, 8);
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch { /* private window */ }
  }, [href, title, kind]);
  return null;
}

export function RecentItems() {
  const items = useSyncExternalStore((on) => { window.addEventListener("storage", on); return () => window.removeEventListener("storage", on); }, read, () => EMPTY);
  if (!items.length) return null;
  return <section className={css.section} aria-labelledby="hq-recent">
    <div className={css.sectionHead}><h2 id="hq-recent"><Clock size={18} aria-hidden="true" style={{ verticalAlign: -3, marginRight: 6 }} />Recently opened</h2></div>
    <ul className={css.recent}>{items.map((r) => <li key={r.href}><Link href={r.href}>{r.kind === "offer" ? <Gem size={15} aria-hidden="true" /> : <Search size={15} aria-hidden="true" />}<span>{r.title}</span><small>{r.kind}</small></Link></li>)}</ul>
  </section>;
}

export function HqSearch({ features, offers, ideas }: { features: Feature[]; offers: Offer[]; ideas: Idea[] }) {
  const [query, setQuery] = useState("");
  const q = useDeferredValue(query.trim().toLowerCase());
  const hits = useMemo(() => q.length < 2 ? null : {
    features: features.filter((f) => !f.archived && `${f.name} ${f.promise} ${f.what}`.toLowerCase().includes(q)).slice(0, 8),
    offers: offers.filter((o) => `${o.name} ${o.icp} ${o.dreamOutcome} ${o.naming?.tagline ?? ""}`.toLowerCase().includes(q)).slice(0, 5),
    ideas: ideas.filter((i) => `${i.title} ${i.problem} ${i.forWhom}`.toLowerCase().includes(q)).slice(0, 5),
  }, [q, features, offers, ideas]);
  const none = hits && !hits.features.length && !hits.offers.length && !hits.ideas.length;
  return <section className={css.section} aria-label="HQ search">
    <label className={css.search} style={{ maxWidth: 640 }}><Search size={16} aria-hidden="true" /><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search features, offers and ideas ( / )" aria-label="Search Pulse HQ" /></label>
    {hits ? <div className={css.searchHits}>
      {none ? <p className={css.faint}>Nothing matches “{query.trim()}”.</p> : null}
      {hits.features.length ? <><p className={css.subhead}>Features</p><ul className={css.list}>{hits.features.map((f) => <li key={f.id}><Link className={css.itemRow} href={`/hq/features/${f.key}`}>
        <span className={css.featIcon} style={hue(f.category)}><FeatureIcon name={f.icon} size={15} /></span><span className={css.listText}><b>{f.name}</b><span>{CATEGORY[f.category].label} · {f.promise}</span></span><StatusPill status={f.status} /></Link></li>)}</ul></> : null}
      {hits.offers.length ? <><p className={css.subhead}>Offers</p><ul className={css.list}>{hits.offers.map((o) => <li key={o.id}><Link className={css.itemRow} href={`/hq/offers/${o.id}`}>
        <span className={css.featIcon} style={{ "--hue": 262 } as CSSProperties}><Gem size={15} aria-hidden="true" /></span><span className={css.listText}><b>{o.name}</b><span>{o.naming?.tagline || o.dreamOutcome}</span></span><StatusPill status={o.status} /></Link></li>)}</ul></> : null}
      {hits.ideas.length ? <><p className={css.subhead}>Ideas</p><ul className={css.list}>{hits.ideas.map((i) => <li key={i.id}><Link className={css.itemRow} href={`/hq/ideas?open=${i.id}`}>
        <span className={css.featIcon} style={{ "--hue": 45 } as CSSProperties}><Lightbulb size={15} aria-hidden="true" /></span><span className={css.listText}><b>{i.title}</b><span>{i.problem}</span></span><StatusPill status={i.status} /></Link></li>)}</ul></> : null}
    </div> : null}
  </section>;
}
