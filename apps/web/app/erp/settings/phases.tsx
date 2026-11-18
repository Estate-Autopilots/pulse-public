"use client";
// QUOTE-STRUCT (Kazuk, 16 Nov 2026: "VitalsOS Quotations: Phase-wise Package Editing: Build Guide"): the phases a company
// sells in, in order, each with optional sub-groups. Catalogue items pick one; a package added to a quotation opens into
// its parts under these headings, and the PDF prints them phase by phase with one total. A company with no phases keeps
// one flat list. Leadership and Finance change them (POST /api/v0/erp/phases); renaming keeps the items in their phase.
import { ArrowDown, ArrowUp, Layers, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { styles } from "../../ui";
import { Card, EmptyState, SectionHeader } from "../../components/calm";
import { useConfirm } from "../../kit/dialogs";
import type { Phase } from "../types";
import s from "./settings.module.css";

type Draft = { key?: string; name: string; groups: string };
const toDraft = (p: Phase): Draft => ({ key: p.key, name: p.name, groups: p.groups.join(", ") });

export function PhaseSettings({ initial, canWrite }: { initial: Phase[]; canWrite: boolean }) {
  const confirm = useConfirm();
  const [saved, setSaved] = useState(initial);
  const [rows, setRows] = useState<Draft[]>(initial.map(toDraft));
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(rows) !== JSON.stringify(saved.map(toDraft));
  const set = (i: number, patch: Partial<Draft>) => setRows(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const move = (i: number, by: number) => { const next = [...rows]; const [r] = next.splice(i, 1); next.splice(i + by, 0, r); setRows(next); };
  async function save() {
    const removed = saved.filter((p) => !rows.some((r) => r.key === p.key));
    if (removed.length && !(await confirm({ title: `Remove ${removed.map((p) => p.name).join(", ")}?`, body: "Catalogue items in it lose their phase and print under “Other items” until you give them another. Quotations already made keep their headings.", confirmLabel: "Remove and save", danger: true }))) return;
    setBusy(true);
    try {
      const r = await fetch("/api/v0/erp/phases", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ phases: rows.map((x) => ({ ...(x.key ? { key: x.key } : {}), name: x.name, groups: x.groups.split(",").map((g) => g.trim()).filter(Boolean) })) }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error ?? "Not saved");
      setSaved(d.phases); setRows((d.phases as Phase[]).map(toDraft));
      notify({ id: "erp-phases", tone: "success", title: d.phases.length ? "Phases saved" : "Phases removed", message: d.phases.length ? "Pick a phase on each catalogue item to group it." : undefined, timeout: 3500 });
    } catch (e) { notify({ id: "erp-phases", tone: "error", title: "Not saved", message: e instanceof Error ? e.message : "Not saved" }); } finally { setBusy(false); }
  }
  return <Card id="phases" label="Phases on quotations" className={s.card}>
    <SectionHeader id="phases-h" icon={<Layers size={16} aria-hidden="true" />} title="Phases on quotations" hint={saved.length ? `${saved.length} in order` : "None yet"} />
    <p className={s.quiet}>Group what you sell into phases. A package on a quotation opens into its parts under these headings, and the customer sees the quotation phase by phase.</p>
    {rows.length ? <ol className={s.phaseList} aria-label="Phases">
      {rows.map((r, i) => <li key={r.key ?? `new-${i}`} className={s.phaseRow}>
        <span className={s.phaseNo} aria-hidden="true">{i + 1}</span>
        <label className={`${styles.field} ${s.phaseName}`}>Name<input value={r.name} maxLength={120} disabled={!canWrite || busy} onChange={(e) => set(i, { name: e.target.value })} placeholder={`Phase ${i + 1}`} /></label>
        <label className={`${styles.field} ${s.phaseGroups}`}>Sub-headings (optional)<input value={r.groups} disabled={!canWrite || busy} onChange={(e) => set(i, { groups: e.target.value })} placeholder="e.g. Attention, Trust" /></label>
        {canWrite ? <span className={s.phaseActions}>
          <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} aria-label={`Move ${r.name || "this phase"} up`} disabled={busy || i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} aria-hidden="true" /></button>
          <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} aria-label={`Move ${r.name || "this phase"} down`} disabled={busy || i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} aria-hidden="true" /></button>
          <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} aria-label={`Remove ${r.name || "this phase"}`} disabled={busy} onClick={() => setRows(rows.filter((_, n) => n !== i))}><Trash2 size={14} aria-hidden="true" /></button>
        </span> : null}
      </li>)}
    </ol> : <EmptyState icon={<Layers size={18} aria-hidden="true" />} title="No phases yet" text={canWrite ? "Quotations stay one simple list until you add phases." : "Leadership or Finance adds phases."}
      action={canWrite ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setRows([{ name: "", groups: "" }])}><Plus size={14} aria-hidden="true" />Add the first phase</button> : undefined} />}
    {canWrite && rows.length ? <div className={s.phaseFoot}>
      {rows.length < 20 ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => setRows([...rows, { name: "", groups: "" }])}><Plus size={13} aria-hidden="true" />Add a phase</button> : null}
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !dirty || rows.some((r) => !r.name.trim())} onClick={() => void save()}>{busy ? "Saving…" : "Save phases"}</button>
    </div> : null}
  </Card>;
}
