"use client";
// DOCS-POLISH (owner, 14 Nov 2026; Codex concept 2): "Make this doc richer". The API (services/api/src/doc-richer.ts) reads
// the doc and offers upgrades made only from what it already says: a chart under a number table, big numbers from a key
// numbers list or a Total row, a timeline from dated steps, a flow diagram for a numbered process, a toggle for an
// appendix, amounts written the Indian way. Each one shows what it will look like (the real block); the person keeps the
// ones they want and applies them in one click. The change is its own version in History, and Undo is offered at once.
import { useEffect, useRef, useState } from "react";
import { BarChart3, CalendarRange, ChevronRight, Hash, IndianRupee, ListCollapse, Network, Sparkles, X } from "lucide-react";
import { post } from "../orgs/client";
import { BlockCard, type Block } from "./blocks";
import css from "./docs.module.css";
import r from "./rich/rich.module.css";

export type RicherKind = "chart" | "stat" | "timeline" | "diagram" | "toggle" | "numbers";
export type Suggestion = { id: string; kind: RicherKind; title: string; detail: string; on: boolean; block?: Block; examples?: string[] };
export type RicherLook = { version: number; canEdit: boolean; suggestions: Suggestion[]; kept: { tables: number } };
export type RicherDone = { applied: Suggestion[]; version: number; html: string; undo: string | null };

const ICON = { chart: BarChart3, stat: Hash, timeline: CalendarRange, diagram: Network, toggle: ListCollapse, numbers: IndianRupee } as const;
const WORD: Record<RicherKind, string> = { chart: "a chart", stat: "big numbers", timeline: "a timeline", diagram: "a diagram", toggle: "a toggle", numbers: "Indian amounts" };
/** "a chart, big numbers and a timeline" */
export function upgradeWords(list: { kind: RicherKind }[]): string {
  const w = [...new Set(list.map((s) => WORD[s.kind]))];
  return w.length <= 1 ? w.join("") : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
}

export async function lookRicher(docId: string): Promise<RicherLook | null> {
  try { const res = await fetch(`/api/v0/docs/${docId}/richer`, { cache: "no-store" }); return res.ok ? await res.json() as RicherLook : null; } catch { return null; }
}

/** The sheet: what could change (each with its preview and a tick), Not now, Apply N changes. */
export function RicherDialog({ docId, open, onClose, beforeLook, onApplied }: { docId: string; open: boolean; onClose: () => void;
  beforeLook: () => Promise<void>; onApplied: (done: RicherDone) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [look, setLook] = useState<RicherLook | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "saving">("loading");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (open && !d.open) d.showModal(); else if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      setState("loading"); setError(null);
      await beforeLook();
      const l = await lookRicher(docId);
      if (!live) return;
      if (!l) { setState("error"); return; }
      setLook(l); setPicked(new Set(l.suggestions.filter((s) => s.on).map((s) => s.id))); setState("ready");
    })();
    return () => { live = false; };
  }, [open, docId, beforeLook]);
  async function apply() {
    if (!look || !picked.size) return;
    setState("saving"); setError(null);
    try {
      const done = await post<RicherDone>(`docs/${docId}/richer`, { apply: [...picked], baseVersion: look.version });
      onApplied(done); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "That did not work. Try again."); setState("ready"); }
  }
  const list = look?.suggestions ?? [];
  const n = picked.size;
  return <dialog ref={ref} className={`${r.dialog} ${css.richer}`} aria-labelledby="richer-title" onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <div className={r.dialogHead}>
      <h2 id="richer-title"><Sparkles size={20} aria-hidden="true" className={css.richerSpark} />Make this doc richer</h2>
      <button type="button" className={r.iconBtn} aria-label="Close" onClick={onClose}><X size={18} aria-hidden="true" /></button>
    </div>
    {state === "loading" ? <div className={css.richerList} aria-busy="true"><p className={r.hint}>Reading your doc…</p>
      {[0, 1, 2].map((i) => <div key={i} className={css.richerSkeleton} />)}</div>
      : state === "error" ? <div className={css.richerEmpty}><p>Your doc could not be read just now.</p>
        <button type="button" className={`${r.btn} ${r.primary}`} onClick={() => { setState("loading"); void lookRicher(docId).then((l) => { if (l) { setLook(l); setPicked(new Set(l.suggestions.filter((s) => s.on).map((s) => s.id))); setState("ready"); } else setState("error"); }); }}>Try again</button></div>
      : !list.length ? <div className={css.richerEmpty}>
        <p><strong>Nothing to upgrade yet.</strong></p>
        <p className={r.hint}>Add a table of numbers, a “Key numbers” list (Revenue: ₹42.6 L) or dated steps (Week 1: …) and look again. Or type / for a chart, big numbers or a diagram.</p>
        {look?.kept.tables ? <p className={r.hint}>{look.kept.tables === 1 ? "Your table of words stays a table" : `Your ${look.kept.tables} tables of words stay tables`}: they read best that way.</p> : null}
        <div className={r.dialogFoot}><button type="button" className={`${r.btn} ${r.primary}`} onClick={onClose}>Close</button></div></div>
      : <>
        <p className={css.richerLead}>We found {list.length} {list.length === 1 ? "upgrade" : "upgrades"}. Nothing is made up: every number and word comes from your doc.</p>
        <ul className={css.richerList}>{list.map((s) => { const I = ICON[s.kind]; const on = picked.has(s.id); return <li key={s.id} className={css.richerItem} data-on={on ? "1" : undefined}>
          <label className={css.richerPick}>
            <input type="checkbox" checked={on} onChange={() => setPicked((p) => { const x = new Set(p); if (x.has(s.id)) x.delete(s.id); else x.add(s.id); return x; })} />
            <span className={css.richerIcon}><I size={18} aria-hidden="true" /></span>
            <span className={css.richerWords}><strong>{s.title}</strong><small>{s.detail}</small></span>
          </label>
          <div className={css.richerPreview} aria-hidden="true">
            {s.block ? <BlockCard block={s.block} />
              : s.kind === "toggle" ? <p className={css.richerToggle}><ChevronRight size={16} />{s.title.replace(/^Fold “(.*)” away$/, "$1")}</p>
              : s.examples?.length ? <p className={css.richerExamples}>{s.examples.map((x) => <span key={x}>{x}</span>)}</p> : null}
          </div>
        </li>; })}</ul>
        {look?.kept.tables ? <p className={r.hint}>{look.kept.tables === 1 ? "1 table of words stays a table" : `${look.kept.tables} tables of words stay tables`}: they read best that way.</p> : null}
        {error ? <p className={r.error} role="alert">{error}</p> : null}
        <div className={`${r.dialogFoot} ${css.richerFoot}`}>
          <span className={r.hint}>You can undo this in History.</span>
          <button type="button" className={r.btn} onClick={onClose}>Not now</button>
          <button type="button" className={`${r.btn} ${r.primary}`} disabled={!n || state === "saving"} onClick={() => void apply()}>
            {state === "saving" ? "Applying…" : n ? `Apply ${n} ${n === 1 ? "change" : "changes"}` : "Pick a change"}</button>
        </div>
      </>}
  </dialog>;
}
