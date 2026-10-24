"use client";
// FLOW-C: the libraries. One shelf per library (the names are the company's own: a swipe file, a reference-video folder,
// a testimonial library), searchable, filtered by segment; a video kept in Drive plays here in a viewer; the word list
// (use / avoid / scope / why) beside them. Leadership adds a reference with its link, segment and tags.
import { useMemo, useState } from "react";
import { BookA, ExternalLink, Film, Library, Play, Plus, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { notify } from "@pulse/ui-shell";
import { styles } from "../../ui";
import { flow, why } from "../flow-client";
import type { FlowRecord } from "../flow-types";
import { playable } from "../../steps/media";
import css from "./libraries.module.css";

const WORDS = "Word list";
const str = (x: unknown) => (typeof x === "string" ? x : "");
const tags = (r: FlowRecord) => (Array.isArray(r.data.tags) ? r.data.tags.filter((t): t is string => typeof t === "string") : []);

export function Libraries({ items, words, canEdit, initial, query }: { items: FlowRecord[]; words: FlowRecord[]; canEdit: boolean; initial: string | null; query: string }) {
  const router = useRouter();
  const shelves = useMemo(() => { const m = new Map<string, number>(); for (const r of items) { const k = str(r.data.library) || "Other"; m.set(k, (m.get(k) ?? 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); }, [items]);
  const [shelf, setShelf] = useState<string | null>(initial ?? shelves[0]?.[0] ?? (words.length ? WORDS : null));
  const [q, setQ] = useState(query), [segment, setSegment] = useState(""), [open, setOpen] = useState<FlowRecord | null>(null), [adding, setAdding] = useState(false);
  const here = shelf === WORDS ? [] : items.filter((r) => (str(r.data.library) || "Other") === shelf);
  const segments = [...new Set(here.map((r) => str(r.data.segment)).filter(Boolean))].sort();
  const needle = q.trim().toLowerCase();
  const shown = here.filter((r) => (!segment || str(r.data.segment) === segment) && (!needle || `${r.title} ${str(r.data.note)} ${tags(r).join(" ")} ${str(r.data.segment)}`.toLowerCase().includes(needle)));
  const shownWords = words.filter((r) => !needle || `${str(r.data.use)} ${str(r.data.avoid)} ${str(r.data.why)}`.toLowerCase().includes(needle));
  return <div className={css.wrap}>
    <nav className={css.shelves} aria-label="Libraries">
      {shelves.map(([k, n]) => <button key={k} type="button" aria-current={shelf === k ? "true" : undefined} onClick={() => { setShelf(k); setSegment(""); }}><Library size={14} aria-hidden="true" /><span>{k}</span><small>{n}</small></button>)}
      <button type="button" aria-current={shelf === WORDS ? "true" : undefined} onClick={() => setShelf(WORDS)}><BookA size={14} aria-hidden="true" /><span>{WORDS}</span><small>{words.length}</small></button>
      {canEdit ? <button type="button" className={css.add} onClick={() => setAdding(true)}><Plus size={14} aria-hidden="true" />Add a reference</button> : null}
    </nav>
    <section className={css.main} aria-label={shelf ?? "Library"}>
      <div className={css.tools}>
        <label className={css.search}><Search size={14} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={shelf === WORDS ? "Search the words" : "Search titles, notes and tags"} aria-label="Search" /></label>
        {segments.length > 1 ? <div className={css.segs} role="group" aria-label="Segment"><button type="button" aria-pressed={!segment} onClick={() => setSegment("")}>All</button>
          {segments.map((s) => <button key={s} type="button" aria-pressed={segment === s} onClick={() => setSegment(s)}>{s}</button>)}</div> : null}
      </div>
      {adding ? <AddReference shelves={shelves.map(([k]) => k)} current={shelf === WORDS ? "" : shelf ?? ""} onDone={(saved) => { setAdding(false); if (saved) router.refresh(); }} /> : null}
      {shelf === WORDS ? shownWords.length ? <table className={css.words}><thead><tr><th scope="col">Use</th><th scope="col">Avoid</th><th scope="col">Where</th><th scope="col">Why</th></tr></thead>
        <tbody>{shownWords.map((r) => <tr key={r.id}><td>{str(r.data.use)}</td><td>{str(r.data.avoid)}</td><td>{str(r.data.scope) || "All"}</td><td>{str(r.data.why)}</td></tr>)}</tbody></table>
        : <p className={css.empty}>No words kept for the whole company yet. Each project&apos;s word list is made in its own step; words leadership keeps here apply to every check.</p>
        : shown.length ? <ul className={css.grid}>{shown.map((r) => { const p = playable(str(r.data.url));
          return <li key={r.id}><article className={css.card}>
            <button type="button" className={css.thumb} data-kind={p.kind} onClick={() => setOpen(r)} aria-label={`Open ${r.title}`}>{p.kind === "frame" || p.kind === "video" ? <Play size={22} aria-hidden="true" /> : <Film size={20} aria-hidden="true" />}</button>
            <div className={css.body}><b>{r.title}</b>{str(r.data.segment) ? <small>{str(r.data.segment)}</small> : null}
              {str(r.data.note) ? <p>{str(r.data.note)}</p> : null}
              {tags(r).length ? <span className={css.tags}>{tags(r).slice(0, 5).map((t) => <i key={t}>{t}</i>)}</span> : null}</div>
          </article></li>; })}</ul>
        : <p className={css.empty}>{items.length ? "Nothing here matches." : "No references yet. Leadership adds swipe files, reference videos and testimonials here; any step can point to them."}</p>}
    </section>
    {open ? <Viewer r={open} onClose={() => setOpen(null)} /> : null}
  </div>;
}

function Viewer({ r, onClose }: { r: FlowRecord; onClose: () => void }) {
  const url = str(r.data.url), p = playable(url);
  return <div className={css.viewer} role="dialog" aria-modal="true" aria-label={r.title} onClick={onClose} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
    <div className={css.viewerBox} onClick={(e) => e.stopPropagation()}>
      <header><b>{r.title}</b><small>{[str(r.data.library), str(r.data.segment)].filter(Boolean).join(" · ")}</small>
        {url ? <a className={styles.btn} href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden="true" />Open in Drive</a> : null}
        <button type="button" className={css.close} onClick={onClose} aria-label="Close" autoFocus><X size={16} /></button></header>
      {p.kind === "frame" ? <div className={css.player}><iframe src={p.src} title={r.title} allow="autoplay; fullscreen" allowFullScreen referrerPolicy="no-referrer" /></div>
        : p.kind === "video" ? <div className={css.player}><video src={p.src} controls playsInline /></div>
        : <p className={css.empty}>{url ? "This one opens beside the page." : "This reference has no link."}</p>}
      {str(r.data.note) ? <p className={css.note}>{str(r.data.note)}</p> : null}
    </div>
  </div>;
}

function AddReference({ shelves, current, onDone }: { shelves: string[]; current: string; onDone: (saved: boolean) => void }) {
  const [f, setF] = useState({ title: "", library: current, url: "", segment: "", note: "", tags: "" }), [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await flow("records", "POST", { type: "library_item", title: f.title, data: { title: f.title, library: f.library, url: f.url || null, segment: f.segment || null, note: f.note || null, tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean) } });
      notify({ id: "lib", tone: "success", title: "Added to the library", timeout: 2000 }); onDone(true); }
    catch (e) { notify({ id: "lib", tone: "error", title: "Not added", message: why(e) }); }
    finally { setBusy(false); }
  }
  return <form className={css.form} onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label="Add a reference">
    <label>Title<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required maxLength={300} /></label>
    <label>Library<input list="lib-shelves" value={f.library} onChange={(e) => setF({ ...f, library: e.target.value })} required placeholder="e.g. Swipe file" /><datalist id="lib-shelves">{shelves.map((s) => <option key={s} value={s} />)}</datalist></label>
    <label>Link<input type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://drive.google.com/…" /></label>
    <label>Segment<input value={f.segment} onChange={(e) => setF({ ...f, segment: e.target.value })} /></label>
    <label data-wide="">Note<textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Why it is worth looking at" /></label>
    <label data-wide="">Tags<input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="Separated by commas" /></label>
    <footer><button type="button" className={styles.btn} onClick={() => onDone(false)}>Cancel</button><button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !f.title.trim() || !f.library.trim()}>Add</button></footer>
  </form>;
}
