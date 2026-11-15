"use client";
// PULSE-HQ: one feature, in the catalogue's side sheet and on its own page (<base>/<key>): what it does, who it is for,
// its status and area, where it lives in Pulse (a real link), the offers that include it, the ideas that touch it and
// its review state. Pulse's editors edit, mark reviewed, archive and restore it in either place.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Archive, ArrowLeft, ArrowUpRight, BadgeCheck, CircleAlert, Expand, Gem, Lightbulb, PenLine, RotateCcw, X } from "lucide-react";
import { hqPost, useDialog } from "./client";
import { CATEGORIES, CATEGORY, FEATURE_STATUS, ICON_NAMES, type Category, type Feature, type FeatureStatus, type Idea, type Offer } from "./model";
import { FeatureIcon, StatusPill, hue } from "./parts";
import css from "./hq.module.css";
import { TrackRecent } from "./recent";
import { SelectField } from "../kit/select-field";

type Draft = { name: string; category: Category; status: FeatureStatus; promise: string; what: string; who: string; proof: string; icon: string; href: string };
const draftOf = (f: Feature | null): Draft => f ? { name: f.name, category: f.category, status: f.status, promise: f.promise, what: f.what, who: f.who, proof: f.proof, icon: f.icon, href: f.href ?? "" }
  : { name: "", category: "work", status: "idea", promise: "", what: "", who: "", proof: "", icon: "Sparkles", href: "" };

type Common = { canEdit: boolean; offers: Offer[]; ideas: Idea[]; base: string };

export function FeatureSheet({ open, onClose, onSaved, ...rest }: Common & { open: Feature | "new" | null; onClose: () => void; onSaved: () => void }) {
  const ref = useDialog(open !== null, onClose);
  const feature = open === "new" ? null : open;
  return <dialog ref={ref} className={`${css.sheet} ${css.glassThick}`} aria-label={feature?.name ?? "Add a feature"}>
    {open ? <FeatureBody key={feature?.id ?? "new"} feature={feature} onClose={onClose} onSaved={onSaved} inSheet {...rest} /> : null}
  </dialog>;
}

/** The feature's own page: everything about it, with a way back to the catalogue. */
export function FeaturePage({ feature, ...rest }: Common & { feature: Feature }) {
  const router = useRouter();
  return <>
    <TrackRecent href={`${rest.base}/${feature.key}`} title={feature.name} kind="feature" />
    <Link href={rest.base} className={css.crumb}><ArrowLeft size={15} aria-hidden="true" />All features</Link>
    <div className={css.featurePage}><FeatureBody feature={feature} onClose={() => router.push(rest.base)} onSaved={() => router.refresh()} {...rest} /></div>
  </>;
}

function FeatureBody({ feature, canEdit, offers, ideas, base, onClose, onSaved, inSheet }: Common & { feature: Feature | null; onClose: () => void; onSaved: () => void; inSheet?: boolean }) {
  const [editing, setEditing] = useState(feature === null);
  const [d, setD] = useState<Draft>(draftOf(feature));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const run = async (work: () => Promise<unknown>, done = true) => {
    setBusy(true); setError(null);
    try { await work(); onSaved(); if (done && inSheet) onClose(); else setEditing(false); } catch (e) { setError(e instanceof Error ? e.message : "Not saved"); } finally { setBusy(false); }
  };
  const inOffers = feature ? offers.flatMap((o) => o.tiers.filter((t) => t.features.includes(feature.key)).map((t) => ({ offer: o.name, tier: t.name, href: `/hq/offers/${o.id}`, id: `${o.id}-${t.key}` }))) : [];
  const linked = feature ? ideas.filter((i) => i.featureKeys.includes(feature.key) || i.featureId === feature.id) : [];
  const shot = feature?.screenshot && /^(https:\/\/|\/api\/)/.test(feature.screenshot) ? feature.screenshot : null;
  const Wrap = inSheet ? "div" : "section";
  return <>
    <Wrap className={inSheet ? css.sheetScroll : css.featureMain}>
      <div className={css.sheetHead} style={hue(d.category)}>
        <span className={css.bigIcon}><FeatureIcon name={d.icon} size={26} /></span>
        <div>
          <span className={css.pills}>{editing ? <span className={css.subhead}>{feature ? "Edit feature" : "New feature"}</span> : <><StatusPill status={feature!.status} />
            {canEdit ? (feature!.draft ? <StatusPill status="draft" label="Waiting for review" /> : <StatusPill status="ready" label="Reviewed" />) : null}
            {feature!.archived ? <StatusPill status="retired" label="Archived" /> : null}</>}</span>
          {inSheet ? <h2>{d.name || "Untitled feature"}</h2> : <h1 className={css.featureTitle}>{d.name || "Untitled feature"}</h1>}
          {!editing && d.promise ? <p>{d.promise}</p> : null}
        </div>
        {inSheet ? <button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close"><X size={17} /></button> : null}
      </div>
      {editing ? <div className={css.formGrid}>
        <label className={`${css.fieldLabel} ${css.wide}`}><span>Name</span><input className={css.input} value={d.name} maxLength={80} onChange={(e) => set("name", e.target.value)} autoFocus /></label>
        <label className={`${css.fieldLabel} ${css.wide}`}><span>One-line promise <small>{d.promise.length}/200</small></span><input className={css.input} value={d.promise} maxLength={200} onChange={(e) => set("promise", e.target.value)} /></label>
        <label className={`${css.fieldLabel} ${css.wide}`}><span>What it does</span><textarea className={css.textarea} value={d.what} maxLength={600} onChange={(e) => set("what", e.target.value)} /></label>
        <label className={css.fieldLabel}><span>Area</span><SelectField className={css.select} value={d.category} onChange={(e) => set("category", e.target.value as Category)}>{CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</SelectField></label>
        <label className={css.fieldLabel}><span>Status</span><SelectField className={css.select} value={d.status} onChange={(e) => set("status", e.target.value as FeatureStatus)}>{FEATURE_STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</SelectField></label>
        <label className={css.fieldLabel}><span>For whom</span><input className={css.input} value={d.who} maxLength={120} onChange={(e) => set("who", e.target.value)} /></label>
        <label className={css.fieldLabel}><span>Icon</span><SelectField className={css.select} value={d.icon} onChange={(e) => set("icon", e.target.value)}>{ICON_NAMES.map((name) => <option key={name} value={name}>{name}</option>)}</SelectField></label>
        <label className={`${css.fieldLabel} ${css.wide}`}><span>Page in Pulse <small>e.g. /finance/desk</small></span><input className={`${css.input} ${css.mono}`} value={d.href} maxLength={200} onChange={(e) => set("href", e.target.value)} /></label>
        <label className={`${css.fieldLabel} ${css.wide}`}><span>Notes for the team (where it is built)</span><input className={`${css.input} ${css.mono}`} value={d.proof} maxLength={300} onChange={(e) => set("proof", e.target.value)} /></label>
      </div> : <>
        <dl className={css.facts}>
          <div><dt>What it does</dt><dd>{feature!.what || feature!.promise}</dd></div>
          <div><dt>For whom</dt><dd>{feature!.who || "Everyone"}</dd></div>
          <div><dt>Area</dt><dd>{CATEGORY[feature!.category]?.label}</dd></div>
          <div><dt>Status</dt><dd>{FEATURE_STATUS.find((s) => s.key === feature!.status)?.label} · {FEATURE_STATUS.find((s) => s.key === feature!.status)?.hint}</dd></div>
          {canEdit ? <div><dt>Review</dt><dd>{feature!.draft ? "Waiting for a review (first draft, 23 Oct 2026)" : "Reviewed"}</dd></div> : null}
        </dl>
        {feature!.href ? <Link href={feature!.href} className={css.openLink} onClick={inSheet ? onClose : undefined}><span>Open it in Pulse<small>{feature!.href}</small></span><ArrowUpRight size={18} aria-hidden="true" /></Link> : null}
        {inSheet ? <Link href={`${base}/${feature!.key}`} className={css.secondary} onClick={onClose}><Expand size={15} aria-hidden="true" />Open the full page</Link> : null}
        {/* eslint-disable-next-line @next/next/no-img-element -- a stored product screenshot, any size */}
        {shot ? <figure className={css.shot}><img src={shot} alt={`${feature!.name} in Pulse`} /></figure> : null}
        {inOffers.length ? <div className={css.stackSm}><p className={css.subhead}>In offers</p><ul className={css.linkList}>{inOffers.map((o) => <li key={o.id}><Gem size={15} aria-hidden="true" />{canEdit ? <Link href={o.href}>{o.offer}</Link> : o.offer}<small>{o.tier}</small></li>)}</ul></div> : null}
        {linked.length ? <div className={css.stackSm}><p className={css.subhead}>Ideas</p><ul className={css.linkList}>{linked.map((i) => <li key={i.id}><Lightbulb size={15} aria-hidden="true" /><Link href={`/hq/ideas?open=${i.id}`}>{i.title}</Link><small>{i.votes} {i.votes === 1 ? "vote" : "votes"}</small></li>)}</ul></div> : null}
      </>}
      {error ? <p className={css.draftNote} role="alert"><CircleAlert size={16} aria-hidden="true" /><span>{error}</span></p> : null}
    </Wrap>
    {canEdit ? <div className={inSheet ? css.sheetFoot : css.featureFoot}>
      {editing ? <>
        <button type="button" className={css.primary} disabled={busy || d.name.trim().length < 2} onClick={() => run(() => feature ? hqPost(`features/${feature.id}`, d) : hqPost("features", d), !feature)}>{feature ? "Save" : "Add feature"}</button>
        <button type="button" className={css.ghost} onClick={() => feature ? (setD(draftOf(feature)), setEditing(false)) : onClose()}>Cancel</button>
      </> : <>
        <button type="button" className={css.secondary} onClick={() => setEditing(true)}><PenLine size={15} aria-hidden="true" />Edit</button>
        {feature!.draft ? <button type="button" className={css.primary} disabled={busy} onClick={() => run(() => hqPost(`features/${feature!.id}`, { draft: false }), false)}><BadgeCheck size={16} aria-hidden="true" />Mark reviewed</button> : null}
        <span className={css.grow} />
        {feature!.archived
          ? <button type="button" className={css.ghost} disabled={busy} onClick={() => run(() => hqPost(`features/${feature!.id}`, { archived: false }), false)}><RotateCcw size={15} aria-hidden="true" />Restore</button>
          : <button type="button" className={`${css.ghost} ${css.danger}`} disabled={busy} onClick={() => run(() => hqPost(`features/${feature!.id}`, { archived: true }), false)}><Archive size={15} aria-hidden="true" />Archive</button>}
      </>}
    </div> : null}
  </>;
}
