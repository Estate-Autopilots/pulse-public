"use client";
// PULSE-HQ (owner, 23 Oct 2026): Pulse's positioning and brand, worked on in place. Every block (positioning line,
// one-liner, category, for, against, promise, voice, pillars, proof, pricing principles, colours) has its own edit
// with Save (Ctrl+Enter) and Cancel (Esc); a save can be undone at once and every save is a version that can be put
// back. "Used in offers" shows where the brand meets the offers.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { BadgeCheck, CircleAlert, Compass, Crosshair, Gem, History, Megaphone, PenLine, RotateCcw, Swords, Tags, Target, Users } from "lucide-react";
import { hqPost } from "../client";
import type { Brand, BrandVersion, Offer } from "../model";
import css from "../hq.module.css";

const EMPTY: Brand = { tagline: "", oneLiner: "", category: "", forWho: "", against: "", promise: "", pillars: [], proof: [], voice: "", pricing: "", colours: [], draft: true };
type Field = { key: keyof Brand; label: string; kind: "line" | "text" | "list" | "colours"; max: number; hint?: string };
const F: Record<string, Field> = {
  tagline: { key: "tagline", label: "Positioning line", kind: "line", max: 160, hint: "Seven words or fewer, a promise not a description." },
  oneLiner: { key: "oneLiner", label: "One-liner", kind: "text", max: 300, hint: "What Pulse is, for whom, in one sentence." },
  category: { key: "category", label: "Category", kind: "line", max: 120, hint: "The shelf a buyer puts us on." },
  promise: { key: "promise", label: "The promise", kind: "text", max: 300 },
  forWho: { key: "forWho", label: "For", kind: "text", max: 300, hint: "Who, how big, where." },
  against: { key: "against", label: "Against", kind: "text", max: 300, hint: "What we replace; the enemy is the status quo, not a competitor." },
  voice: { key: "voice", label: "Voice", kind: "text", max: 400 },
  pillars: { key: "pillars", label: "Pillars", kind: "list", max: 6, hint: "Up to six, one per line." },
  proof: { key: "proof", label: "Proof", kind: "list", max: 8, hint: "Facts a buyer can check." },
  pricing: { key: "pricing", label: "Pricing principles", kind: "text", max: 600 },
  colours: { key: "colours", label: "Colours", kind: "colours", max: 6, hint: "Hex values, one per line, e.g. #6b4cf0." },
};
const when = (d: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(d));

export function BrandCanvas({ brand, canEdit, updatedAt, versions, offers }: { brand: Brand | null; canEdit: boolean; updatedAt: string | null; versions: BrandVersion[]; offers: Offer[] }) {
  const router = useRouter();
  const [b, setB] = useState<Brand>({ ...EMPTY, ...brand });
  const [editing, setEditing] = useState<keyof Brand | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<Brand | null>(null);
  const save = async (next: Brand, keepUndo?: Brand | null) => {
    setBusy(true); setError(null);
    try { await hqPost("brand", next); setB(next); setEditing(null); setUndo(keepUndo ?? null); router.refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Not saved"); } finally { setBusy(false); }
  };
  const block = (f: Field, children: ReactNode, opts?: { span?: number; icon?: ReactNode; i?: number }) =>
    <Card key={f.key} i={opts?.i ?? 0} span={opts?.span} icon={opts?.icon} title={f.label} canEdit={canEdit} editing={editing === f.key} onEdit={() => setEditing(f.key)}
      editor={<Editor f={f} value={b[f.key]} busy={busy} onCancel={() => setEditing(null)} onSave={(v) => save({ ...b, [f.key]: v }, b)} />}>{children}</Card>;

  return <>
    <header className={css.pageHead}>
      <div><h1>Positioning and brand</h1><p>How we say what Pulse is, to whom, against what, and how we price it.{updatedAt ? ` Updated ${when(updatedAt)}.` : ""}</p></div>
      {canEdit && b.draft ? <div className={css.headActions}><button type="button" className={css.secondary} disabled={busy} onClick={() => save({ ...b, draft: false }, b)}><BadgeCheck size={16} aria-hidden="true" />Mark agreed</button></div> : null}
    </header>
    {b.draft ? <p className={css.draftNote}><CircleAlert size={17} aria-hidden="true" /><span>A first draft to argue with: edit any block in place (the pencil), then mark it agreed. Every save is kept in the history below.</span></p> : null}
    {error ? <p className={css.draftNote} role="alert"><CircleAlert size={17} aria-hidden="true" /><span>{error}</span></p> : null}
    {undo ? <div className={`${css.toast} ${css.glassThick}`} role="status"><span>Saved.</span><button type="button" className={css.linkBtn} onClick={() => save(undo, null)}>Undo</button><button type="button" className={css.linkBtn} onClick={() => setUndo(null)}>Dismiss</button></div> : null}

    <section className={css.brandHero}>
      {editing === "tagline" || editing === "oneLiner" || editing === "category" ? <div className={css.heroEdit}>
        <Editor f={F[editing]} value={b[editing]} busy={busy} onCancel={() => setEditing(null)} onSave={(v) => save({ ...b, [editing]: v }, b)} />
      </div> : <>
        <span className={css.eyebrow}>{b.category || "Category"}{canEdit ? <EditBtn label="category" onClick={() => setEditing("category")} light /> : null}</span>
        <h2>{b.tagline || "Write the positioning line"}{canEdit ? <EditBtn label="positioning line" onClick={() => setEditing("tagline")} light /> : null}</h2>
        <p>{b.oneLiner}{canEdit ? <EditBtn label="one-liner" onClick={() => setEditing("oneLiner")} light /> : null}</p>
      </>}
    </section>

    <div className={css.brandGrid}>
      {block(F.promise, <p style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.02em" }}>{b.promise}</p>, { span: 2, icon: <Target size={14} />, i: 0 })}
      {block(F.forWho, <p>{b.forWho}</p>, { icon: <Users size={14} />, i: 1 })}
      {block(F.against, <p>{b.against}</p>, { icon: <Swords size={14} />, i: 2 })}
      {block(F.voice, <p>{b.voice}</p>, { icon: <Megaphone size={14} />, i: 3 })}
      {block(F.colours, <div className={css.colourRow}>{b.colours.map((c) => <span key={c} className={css.colour}><i style={{ "--c": c } as CSSProperties} />{c}</span>)}</div>, { icon: <Crosshair size={14} />, i: 4 })}
      {block(F.pillars, <ol className={css.pillars}>{b.pillars.map((p) => <li key={p}>{p}</li>)}</ol>, { span: 2, icon: <Compass size={14} />, i: 5 })}
      {block(F.pricing, <p>{b.pricing}</p>, { icon: <Tags size={14} />, i: 6 })}
      {block(F.proof, <ul className={css.ticks}>{b.proof.map((p) => <li key={p}><BadgeCheck size={15} aria-hidden="true" style={{ color: "var(--accent)" }} />{p}</li>)}</ul>, { span: 3, icon: <BadgeCheck size={14} />, i: 7 })}
    </div>

    <section className={css.section} aria-labelledby="brand-offers">
      <div className={css.sectionHead}><h2 id="brand-offers">Used in offers</h2><Link href="/hq/offers">Offer Studio</Link></div>
      {offers.length ? <ul className={css.usedIn}>{offers.map((o) => <li key={o.id} style={{ "--offer": o.accent } as CSSProperties}>
        <Link href={`/hq/offers/${o.id}`}><Gem size={16} aria-hidden="true" /><b>{o.name}</b></Link>
        <span>{o.naming?.tagline || "No tagline yet"}</span>
        <small>{o.positioning ? o.positioning.slice(0, 180) + (o.positioning.length > 180 ? "…" : "") : "No positioning statement yet: add it in the builder's last step."}</small>
      </li>)}</ul> : <p className={css.empty}>No offers yet. Build one in Offer Studio and it will appear here with its positioning.</p>}
    </section>

    <section className={css.section} aria-labelledby="brand-history">
      <div className={css.sectionHead}><h2 id="brand-history"><History size={18} aria-hidden="true" style={{ verticalAlign: -3, marginRight: 6 }} />History</h2></div>
      {versions.length ? <ol className={css.history}>{versions.map((v, i) => <li key={v.id}>
        <span className={css.historyWhen}>{when(v.savedAt)}{i === 0 ? " · current" : ""}</span>
        <span className={css.historyWhat}>{v.body.tagline || "No positioning line"}<small>{v.by ?? "Pulse"}</small></span>
        {canEdit && i > 0 ? <button type="button" className={css.ghost} disabled={busy} onClick={async () => { setBusy(true); try { await hqPost(`brand/versions/${v.id}/restore`); setB({ ...EMPTY, ...v.body }); setUndo(b); router.refresh(); } finally { setBusy(false); } }}>
          <RotateCcw size={14} aria-hidden="true" />Restore</button> : null}
      </li>)}</ol> : <p className={css.empty}>Every save is kept here.</p>}
    </section>
  </>;
}

function EditBtn({ label, onClick, light }: { label: string; onClick: () => void; light?: boolean }) {
  return <button type="button" className={css.editBtn} data-light={light ? "" : undefined} onClick={onClick} aria-label={`Edit the ${label}`} title="Edit"><PenLine size={14} aria-hidden="true" /></button>;
}

function Card({ i, icon, title, span, canEdit, editing, onEdit, editor, children }: { i: number; icon?: ReactNode; title: string; span?: number; canEdit: boolean; editing: boolean; onEdit: () => void; editor: ReactNode; children: ReactNode }) {
  return <section className={css.brandCard} data-span={span} data-editing={editing ? "" : undefined} style={{ "--i": i } as CSSProperties}>
    <h3>{icon}{title}{canEdit && !editing ? <EditBtn label={title.toLowerCase()} onClick={onEdit} /> : null}</h3>
    {editing ? editor : children}
  </section>;
}

function Editor({ f, value, busy, onSave, onCancel }: { f: Field; value: Brand[keyof Brand]; busy: boolean; onSave: (v: Brand[keyof Brand]) => void; onCancel: () => void }) {
  const [text, setText] = useState(Array.isArray(value) ? value.join("\n") : String(value ?? ""));
  const out = (): Brand[keyof Brand] => {
    if (f.kind === "list") return text.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, f.max);
    if (f.kind === "colours") return text.split(/[\s,]+/).map((x) => x.trim()).filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, f.max);
    return text.trim().slice(0, f.max);
  };
  const keys = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSave(out()); } };
  return <div className={css.inlineEdit} onKeyDown={keys}>
    {f.kind === "line" ? <input className={css.input} value={text} maxLength={f.max} onChange={(e) => setText(e.target.value)} aria-label={f.label} autoFocus />
      : <textarea className={css.textarea} value={text} onChange={(e) => setText(e.target.value)} aria-label={f.label} autoFocus />}
    {f.hint ? <small className={css.faint}>{f.hint} Ctrl+Enter saves, Esc cancels.</small> : <small className={css.faint}>Ctrl+Enter saves, Esc cancels.</small>}
    <div className={css.toolbar}><button type="button" className={css.primary} disabled={busy} onClick={() => onSave(out())}>Save</button><button type="button" className={css.ghost} onClick={onCancel}>Cancel</button></div>
  </div>;
}
