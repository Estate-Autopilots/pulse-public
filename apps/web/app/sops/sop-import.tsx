"use client";
// WORKFLOW BUILDER: SOPs into blocks. The Drive documents Pulse found (the same list as From Drive), by folder and in the
// folder's own order; choose a folder or single documents and each SOP becomes a Checklist block whose checklist is its
// steps, done by its owner's role. The blocks join the tab's draft, wired one after another; Save or Publish keeps them.
import { useEffect, useMemo, useState } from "react";
import { Drawer, DrawerFooter, DrawerSection } from "../kit";
import { post } from "../records";
import { styles } from "../ui";
import css from "./blocks.module.css";

type Source = { id: string; name: string; folder: string; status: string; parts: { title: string; steps: number; ownerRole: string | null }[] };
export type SopBlock = { title: string; detail: string | null; role: string | null; source: string; cut: boolean };
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const STATUS = { imported: "in the library", dismissed: "set aside", new: null } as Record<string, string | null>;

export function SopImport({ onClose, onAdd }: { onClose: () => void; onAdd: (blocks: SopBlock[]) => void }) {
  const [sources, setSources] = useState<Source[] | null>(null), [q, setQ] = useState(""), [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    fetch("/api/v0/workflows/sop-sources").then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error ?? "The SOPs could not be read"); if (live) setSources(d.sources); })
      .catch((e) => { if (live) { setSources([]); setError(msg(e)); } });
    return () => { live = false; };
  }, []);
  const groups = useMemo(() => {
    const words = q.trim().toLowerCase();
    const list = (sources ?? []).filter((s) => s.parts.length && (!words || `${s.folder} ${s.name}`.toLowerCase().includes(words)));
    const out = new Map<string, Source[]>();
    for (const s of list) out.set(s.folder, [...(out.get(s.folder) ?? []), s]);
    return [...out.entries()];
  }, [sources, q]);
  const found = groups.flatMap(([, list]) => list.map((s) => s.id));
  const blocks = (sources ?? []).filter((s) => chosen.includes(s.id)).reduce((n, s) => n + s.parts.length, 0);
  const toggle = (ids: string[], on: boolean) => setChosen((c) => on ? [...new Set([...c, ...ids])] : c.filter((x) => !ids.includes(x)));
  async function add() {
    setBusy(true); setError("");
    try { const r = await post<{ blocks: SopBlock[] }>("workflows/sop-blocks", { sourceIds: chosen }); onAdd(r.blocks); }
    catch (e) { setError(msg(e)); setBusy(false); }
  }
  return <Drawer title="Blocks from SOPs" size="md" onClose={onClose}
    help="Each SOP becomes a Checklist block: its steps are the checklist, and its owner's role does it. The blocks are added to this tab's draft, one after another."
    footer={<DrawerFooter status={error}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !blocks} onClick={() => void add()}>
      {blocks ? `Add ${blocks} ${blocks === 1 ? "block" : "blocks"}` : "Choose SOPs"}</button></DrawerFooter>}>
    <DrawerSection>
      <label className={css.field}><span>Find a document or folder</span><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Creative Strategist" data-autofocus="" /></label>
      {q.trim() && found.length ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${css.srcPick}`} onClick={() => toggle(found, !found.every((x) => chosen.includes(x)))}>
        {found.every((x) => chosen.includes(x)) ? "Clear what was found" : `Choose all ${found.length} found`}</button> : null}
    </DrawerSection>
    {sources === null ? <DrawerSection><div className={css.srcSkeleton} aria-busy="true" aria-label="Reading the SOPs" /></DrawerSection>
      : !groups.length ? <DrawerSection><p className={css.note}>{q ? "No SOP matches." : "Pulse has not found SOPs in Drive yet. They appear here after the Drive refresh reads them (SOPs → From Drive)."}</p></DrawerSection>
      : groups.map(([folder, list]) => {
        const all = list.every((s) => chosen.includes(s.id));
        // A deep Drive path reads by its last two folders ("EA Creative Strategist SOPs / #7 Big Idea").
        return <DrawerSection key={folder} title={folder.split(" / ").slice(-2).join(" / ")}>
          <button type="button" className={`${styles.btn} ${styles.btnSmall} ${css.srcPick}`} onClick={() => toggle(list.map((s) => s.id), !all)}>{all ? "Clear this folder" : `Choose all ${list.length}`}</button>
          <ul className={css.srcList}>{list.map((s) => <li key={s.id}><label className={css.srcRow}>
            <input type="checkbox" checked={chosen.includes(s.id)} onChange={(e) => toggle([s.id], e.target.checked)} />
            <span><b>{s.name}</b><small>{s.parts.length === 1 ? `${s.parts[0].steps} ${s.parts[0].steps === 1 ? "step" : "steps"}` : `${s.parts.length} SOPs · ${s.parts.reduce((n, p) => n + p.steps, 0)} steps`}
              {s.parts[0]?.ownerRole ? ` · ${s.parts[0].ownerRole}` : ""}{STATUS[s.status] ? ` · ${STATUS[s.status]}` : ""}</small></span></label></li>)}</ul>
        </DrawerSection>;
      })}
  </Drawer>;
}
