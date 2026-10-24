"use client";
// TASKS-4B, then INTEGRITY (owner, 22 Oct 2026: "Remove the Pip value per task: the value assignment is easily
// riggable"): a task has no value and nobody is credited points for it. This card keeps what still helps the work:
// importance, urgency, the estimate, one line on why it matters, and Pip's suggestion for importance and effort with
// how it was worked out. Who may change them is unchanged (leadership, HR, the doer's head, the reviewer or the creator;
// never the doer alone).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, ChevronDown, Flag, Pencil, RefreshCw, Sparkles } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Tooltip } from "../kit";
import { post } from "../records";
import { styles } from "../ui";
import { PRIORITY } from "./parts";
import type { Detail, Task } from "./types";
import css from "./life.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const hours = (m: number) => m < 60 ? `${m} min` : `${Math.round(m / 6) / 10} h`;
const URGENCY: Record<string, string> = { low: "Can wait", normal: "Normal", high: "Urgent" };
type Suggestion = NonNullable<Detail["task"]["suggestion"]>;

export function ValueCard({ task, suggestion, canValue, why }: { task: Task; suggestion: Suggestion | null; canValue: boolean; why: string | null }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [open, setOpen] = useState(false);
  const [importance, setImportance] = useState<string>(task.priority);
  const [urgency, setUrgency] = useState<string>(task.urgency ?? "normal"), [estimate, setEstimate] = useState<string>(task.estimateMinutes ? String(Math.round(task.estimateMinutes / 6) / 10) : "");
  async function save(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    try { await post(`work/tasks/${task.id}/value`, body); notify({ id: "value", tone: "success", title: ok, timeout: 2500 }); setEditing(false); router.refresh(); }
    catch (e) { notify({ id: "value", tone: "error", title: "Not saved", message: msg(e) }); } finally { setBusy(false); }
  }
  async function ask() {
    setBusy(true); try { await post(`work/tasks/${task.id}/suggest`, {}); setOpen(true); router.refresh(); } catch (e) { notify({ id: "value", tone: "error", title: "Pip could not work it out", message: msg(e) }); } finally { setBusy(false); }
  }
  const finished = task.status === "accepted";
  const differs = !!(suggestion && suggestion.importance !== task.priority);
  return <section className={css.valueCard} aria-label="Priority">
    <div className={css.valueHead}>
      <span className={css.valuePts}><Flag size={16} aria-hidden="true" /><b>{PRIORITY[task.priority]}</b></span>
      <span className={css.valueMeta}>importance{task.urgency && task.urgency !== "normal" ? ` · ${URGENCY[task.urgency].toLowerCase()}` : ""}{task.estimateMinutes ? ` · about ${hours(task.estimateMinutes)}` : ""}</span>
      {canValue && !editing && !finished ? <Tooltip content="Change the priority or the estimate"><button type="button" className={css.iconBtn} aria-label="Change the priority or the estimate" onClick={() => setEditing(true)}><Pencil size={14} /></button></Tooltip> : null}
    </div>
    {why ? <p className={css.valueWhy}><b>Why it matters:</b> {why}</p> : null}
    {suggestion && !editing ? <div className={css.pipValue}>
      <button type="button" className={css.pipToggle} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Sparkles size={14} aria-hidden="true" /><span><b>Pip: {String(PRIORITY[suggestion.importance as Task["priority"]] ?? suggestion.importance).toLowerCase()} · about {hours(suggestion.effortMinutes)}</b>{suggestion.confidence ? <small> · {suggestion.confidence} confidence</small> : null}</span>
        <span className={css.pipHow}>How was this worked out<ChevronDown size={13} aria-hidden="true" /></span>
      </button>
      {open ? <div className={css.breakdown}>
        {suggestion.basis?.length ? <ul>{suggestion.basis.map((b) => <li key={b}>{b}</li>)}</ul> : <p>{suggestion.reason}</p>}
        {canValue && !finished ? <button type="button" className={css.linkBtn} disabled={busy} onClick={() => void ask()}><RefreshCw size={13} aria-hidden="true" />Work it out again</button> : null}
      </div> : null}
      {canValue && !finished && (differs || !task.estimateMinutes) ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void save({ useSuggestion: true }, "Pip’s suggestion used")}><Check size={13} aria-hidden="true" />Use Pip’s suggestion</button> : null}
    </div> : !suggestion && canValue && !editing && !finished ? <button type="button" className={css.linkBtn} disabled={busy} onClick={() => void ask()}><Sparkles size={13} aria-hidden="true" />Ask Pip for the effort</button> : null}
    {editing ? <form className={css.valueForm} onSubmit={(e) => { e.preventDefault(); void save({ importance, urgency, estimateMinutes: estimate ? Math.round(Number(estimate) * 60) : null }, "Saved"); }}>
      <label className={styles.field}>Importance<select value={importance} onChange={(e) => setImportance(e.target.value)}>{Object.entries(PRIORITY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label className={styles.field}>Urgency<select value={urgency} onChange={(e) => setUrgency(e.target.value)}>{Object.entries(URGENCY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label className={styles.field}>Estimate (hours)<input type="number" min={0.1} max={330} step={0.25} value={estimate} onChange={(e) => setEstimate(e.target.value)} placeholder={suggestion ? String(Math.round(suggestion.effortMinutes / 6) / 10) : ""} /></label>
      <div className={css.valueFoot}><button type="button" className={styles.btn} onClick={() => setEditing(false)}>Cancel</button><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>Save</button></div>
    </form> : null}
  </section>;
}
