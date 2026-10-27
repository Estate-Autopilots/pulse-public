"use client";
// TASKS-P0: project categories are the company's own (SaaS: every company names its own; the defaults are Client
// delivery, Internal, Admin & finance, Launch and HR). Leadership edits them; a project's owner picks its category,
// colour and icon. Naming hints suggest a tidier name and point at projects that already have it.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Palette, Plus, Tags } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Modal, post } from "../records";
import { styles } from "../ui";
import { PROJECT_COLORS, PROJECT_ICONS } from "./chips";
import f from "./focus.module.css";
import { SelectField } from "../kit/select-field";

export type Category = { key: string; label: string; icon: string; color: string; projects?: number; retired?: boolean };
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";

function Swatches({ value, onChange, icon }: { value: string; onChange: (c: string) => void; icon: string }) {
  const Icon = PROJECT_ICONS[icon] ?? PROJECT_ICONS.folder;
  return <div role="radiogroup" aria-label="Colour" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{PROJECT_COLORS.map((c) =>
    <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} title={c} className={`${f.proj} ${f.projDot}`} data-color={c} onClick={() => onChange(c)}
      style={{ width: 32, height: 32, border: value === c ? "2px solid var(--theme-text)" : "1px solid var(--theme-border)", cursor: "pointer" }}><Icon size={14} aria-hidden="true" /></button>)}</div>;
}
function Icons({ value, onChange, color }: { value: string; onChange: (i: string) => void; color: string }) {
  return <div role="radiogroup" aria-label="Icon" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{Object.entries(PROJECT_ICONS).map(([k, Icon]) =>
    <button key={k} type="button" role="radio" aria-checked={value === k} aria-label={k} title={k} className={`${f.proj} ${f.projDot}`} data-color={color} onClick={() => onChange(k)}
      style={{ width: 32, height: 32, border: value === k ? "2px solid var(--theme-text)" : "1px solid var(--theme-border)", cursor: "pointer" }}><Icon size={15} aria-hidden="true" /></button>)}</div>;
}

/** Leadership: the company's project categories. */
export function ProjectCategories({ rows }: { rows: Category[] }) {
  const router = useRouter(); const [open, setOpen] = useState(false), [edit, setEdit] = useState<Category | null>(null), [busy, setBusy] = useState(false);
  async function save(c: Category & { retired?: boolean }) {
    setBusy(true);
    try { await post("work/project-categories", { key: c.key || undefined, label: c.label, icon: c.icon, color: c.color, retired: c.retired === true }); notify({ id: "category", tone: "success", title: c.retired ? "Category retired" : "Category saved", timeout: 2500 }); setEdit(null); router.refresh(); }
    catch (e) { notify({ id: "category", tone: "error", title: "Not saved", message: msg(e) }); } finally { setBusy(false); }
  }
  return <><button type="button" className={styles.btn} onClick={() => setOpen(true)}><Tags size={13} aria-hidden="true" />Categories</button>
    {open ? <Modal title="Project categories" sub="Your company’s own: every project sits in one. Projects without one follow their kind (client delivery or internal)." onClose={() => setOpen(false)}
      foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Done</button></div>}>
      <ul className={f.proofs}>{rows.map((c) => { const Icon = PROJECT_ICONS[c.icon] ?? PROJECT_ICONS.folder; return <li key={c.key}>
        <span className={`${f.proj} ${f.projDot}`} data-color={c.color}><Icon size={13} aria-hidden="true" /></span>
        <div style={{ minWidth: 0 }}><b>{c.label}</b><div className={f.proofMeta}>{c.projects ?? 0} projects</div></div>
        <span className={f.actions}><button type="button" className={styles.btn} onClick={() => setEdit(c)}>Edit</button></span></li>; })}</ul>
      <button type="button" className={styles.btn} onClick={() => setEdit({ key: "", label: "", icon: "folder", color: "slate" })}><Plus size={13} aria-hidden="true" />Add a category</button>
      {edit ? <CategoryForm initial={edit} busy={busy} onCancel={() => setEdit(null)} onSave={save} /> : null}
    </Modal> : null}</>;
}
function CategoryForm({ initial, busy, onCancel, onSave }: { initial: Category; busy: boolean; onCancel: () => void; onSave: (c: Category & { retired?: boolean }) => void }) {
  const [c, setC] = useState(initial);
  return <form className={f.cardBody} style={{ padding: "12px 0 0", borderTop: "1px solid var(--theme-border)" }} onSubmit={(e: FormEvent) => { e.preventDefault(); onSave(c); }}>
    <label className={styles.field}>Name<input value={c.label} onChange={(e) => setC({ ...c, label: e.target.value })} maxLength={60} minLength={2} required autoFocus placeholder="e.g. Events" /></label>
    <div className={styles.field}><span>Colour</span><Swatches value={c.color} onChange={(color) => setC({ ...c, color })} icon={c.icon} /></div>
    <div className={styles.field}><span>Icon</span><Icons value={c.icon} onChange={(icon) => setC({ ...c, icon })} color={c.color} /></div>
    <div className={f.actions}><button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>Save</button><button type="button" className={styles.btn} onClick={onCancel}>Cancel</button>
      {initial.key ? <button type="button" className={styles.btn} disabled={busy} onClick={() => onSave({ ...c, retired: true })}>Retire</button> : null}</div>
  </form>;
}

/** The project's owner (pod head, leadership): category, colour and icon. */
export function ProjectStyle({ projectId, category, color, icon }: { projectId: string; category: string | null; color: string | null; icon: string | null }) {
  const router = useRouter(); const [open, setOpen] = useState(false), [rows, setRows] = useState<Category[] | null>(null), [busy, setBusy] = useState(false);
  const [v, setV] = useState({ category: category ?? "", color: color ?? "slate", icon: icon ?? "folder" });
  useEffect(() => { if (open && !rows) fetch("/api/v0/work/project-categories").then((r) => r.ok ? r.json() : { rows: [] }).then((d) => setRows((d.rows as Category[]).filter((c) => !c.retired))).catch(() => setRows([])); }, [open, rows]);
  async function save() {
    setBusy(true);
    try { await post(`work/projects/${projectId}/style`, v); notify({ id: "style", tone: "success", title: "Saved", timeout: 2000 }); setOpen(false); router.refresh(); }
    catch (e) { notify({ id: "style", tone: "error", title: "Not saved", message: msg(e) }); } finally { setBusy(false); }
  }
  return <><button type="button" className={styles.btn} onClick={() => setOpen(true)}><Palette size={13} aria-hidden="true" />Category & colour</button>
    {open ? <Modal title="Category, colour and icon" sub="They show on every card of this project, so people see at a glance what it is." onClose={() => setOpen(false)}
      foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={save}>Save</button></div>}>
      <label className={styles.field}>Category<SelectField value={v.category} onChange={(e) => { const c = rows?.find((x) => x.key === e.target.value); setV({ category: e.target.value, color: c?.color ?? v.color, icon: c?.icon ?? v.icon }); }}>
        <option value="">Follow its kind</option>{(rows ?? []).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</SelectField></label>
      <div className={styles.field}><span>Colour</span><Swatches value={v.color} onChange={(color) => setV({ ...v, color })} icon={v.icon} /></div>
      <div className={styles.field}><span>Icon</span><Icons value={v.icon} onChange={(icon) => setV({ ...v, icon })} color={v.color} /></div>
    </Modal> : null}</>;
}

/** Naming hints for a project name being typed: a tidier name, and projects that already have (nearly) this one. */
export function NameHints({ name, except, onUse }: { name: string; except?: string | null; onUse: (name: string) => void }) {
  const [hints, setHints] = useState<{ for: string; similar: { id: string; name: string; tasks: number }[]; suggestions: string[] } | null>(null);
  const term = name.trim();
  useEffect(() => {
    if (term.length < 3) return;
    const h = setTimeout(() => { fetch(`/api/v0/work/projects/name-check?name=${encodeURIComponent(term)}${except ? `&id=${except}` : ""}`).then((r) => r.ok ? r.json() : null).then((d) => d && setHints({ for: term, ...d })).catch(() => undefined); }, 300);
    return () => clearTimeout(h);
  }, [term, except]);
  const live = hints && hints.for === term ? hints : null;
  if (!live || (!live.similar.length && !live.suggestions.length)) return null;
  return <div className={f.same} role="note" aria-label="Naming hints" style={{ marginTop: 6 }}>
    <span>{live.similar.length ? <>Already there: {live.similar.map((s, i) => <span key={s.id}>{i ? ", " : ""}<Link href={`/tasks/projects/${s.id}`} target="_blank">{s.name}</Link> ({s.tasks} tasks)</span>)}. Use it instead of a second one?</> : "A tidier name:"}</span>
    {live.suggestions.map((s) => <button key={s} type="button" className={styles.btn} onClick={() => onUse(s)}>Use “{s}”</button>)}
  </div>;
}
