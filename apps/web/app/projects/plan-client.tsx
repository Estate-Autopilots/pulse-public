"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { CalendarRange } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Modal, post } from "../records";
import { styles } from "../ui";
import { DateField } from "../kit/date-field";
import { SelectField } from "../kit/select-field";
import css from "./overview.module.css";

/** KAZUK (28 Oct 2026): set a project's delivery plan (template, package sold, category, kick-off, lead). Pulse lays out
 *  the template's steps as tasks with due days from the kick-off (pulse.project_plan_set, 1370). */
type TemplateLite = { key: string; name: string; packages: { key: string; label: string }[]; categories: { key: string; label: string; units: number }[]; bandwidth: { role: string } };

export function PlanSetup({ projectId, templates, label = "Set up the plan" }: { projectId: string; templates: TemplateLite[]; label?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [key, setKey] = useState(templates[0]?.key ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [people, setPeople] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => { if (!open || people) return;
    fetch("/api/v0/tasks/options").then((r) => r.json()).then((o) => setPeople((o?.people ?? []).map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })))).catch(() => setPeople([])); }, [open, people]);
  const t = templates.find((x) => x.key === key) ?? templates[0];
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError("");
    try {
      const r = await post<{ tasks: number; matched: number }>(`projects/${projectId}/plan`, { template: key, package: f.get("package"), category: f.get("category") || null, kickoff: f.get("kickoff"), leadId: f.get("leadId") || null });
      notify({ id: "plan", tone: "success", title: "Plan set", message: `${r.tasks} steps laid out${r.matched ? `, ${r.matched} quotation tasks placed on their steps` : ""}.`, timeout: 4000 });
      setOpen(false); router.refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "That did not save. Try again."); } finally { setBusy(false); }
  }
  if (!t) return null;
  return <><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setOpen(true)}><CalendarRange size={13} aria-hidden="true" />{label}</button>
    {open ? <Modal title="Delivery plan" onClose={() => setOpen(false)} foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button><button form="plan-set" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>Lay out the plan</button></div>}>
      <form id="plan-set" onSubmit={save} className={css.form}>
        {templates.length > 1 ? <label className={styles.field}>Template<SelectField name="template" value={key} onChange={(e) => setKey(e.currentTarget.value)}>{templates.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</SelectField></label> : null}
        <div className={css.twoFields}>
          <label className={styles.field}>Package sold<SelectField name="package" defaultValue={t.packages[0]?.key}>{t.packages.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</SelectField></label>
          <label className={styles.field}>Category<SelectField name="category" defaultValue="">{[<option key="" value="">Choose later</option>, ...t.categories.map((x) => <option key={x.key} value={x.key}>{x.label} · {x.units} units</option>)]}</SelectField></label>
        </div>
        <div className={css.twoFields}>
          <label className={styles.field}>Kick-off day<DateField name="kickoff" required /></label>
          <label className={styles.field}>{t.bandwidth.role}<SelectField name="leadId" defaultValue="">{[<option key="" value="">Keep the current lead</option>, ...(people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)]}</SelectField></label>
        </div>
        <p className={css.hint}>Only the steps sold in this package are laid out; due days count from the kick-off. Tasks made from the quotation take their step and due day instead of a second task.</p>
        {error ? <p role="alert" className={css.problem}>{error}</p> : null}
      </form>
    </Modal> : null}</>;
}

/** A creative card's column (the template's: Script … Rough cut, 2 PM session … Live). */
export function CreativeMove({ projectId, taskId, code, state, columns }: { projectId: string; taskId: string; code: string; state: string; columns: string[] }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function move(next: string) {
    if (next === state) return; setBusy(true);
    try { await post(`projects/${projectId}/creative`, { taskId, state: next }); router.refresh(); }
    catch (err) { notify({ id: "creative", tone: "error", title: "That did not move", message: err instanceof Error ? err.message : undefined, timeout: 4000 }); } finally { setBusy(false); }
  }
  return <label className={css.moveCard}><span className={styles.srOnly}>Move {code} to</span>
    <select value={state} disabled={busy} onChange={(e) => move(e.currentTarget.value)} aria-label={`Move ${code}`}>{columns.map((c) => <option key={c} value={c}>{code} → {c}</option>)}</select></label>;
}

/** Targets from the handover: the lead or leadership fills them in. */
export function TargetsEdit({ projectId, targets, values }: { projectId: string; targets: { key: string; label: string; unit?: string }[]; values: Record<string, string> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError("");
    try { await post(`projects/${projectId}/targets`, { targets: Object.fromEntries(targets.map((t) => [t.key, String(f.get(t.key) ?? "")])) }); setOpen(false); router.refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "That did not save. Try again."); } finally { setBusy(false); }
  }
  return <><button type="button" className={styles.btn} onClick={() => setOpen(true)}>Edit</button>
    {open ? <Modal title="Targets from the handover" onClose={() => setOpen(false)} foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button><button form="targets" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>Save</button></div>}>
      <form id="targets" onSubmit={save} className={css.form}>
        {targets.map((t) => <label key={t.key} className={styles.field}>{t.label}{t.unit ? ` (${t.unit})` : ""}<input name={t.key} defaultValue={values[t.key] ?? ""} maxLength={40} /></label>)}
        <p className={css.hint}>From the sales handover and the agreement. Leave a target empty until it is known.</p>
        {error ? <p role="alert" className={css.problem}>{error}</p> : null}
      </form>
    </Modal> : null}</>;
}
