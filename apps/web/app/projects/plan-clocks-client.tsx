"use client";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { CalendarCheck2, ChevronRight, Lock, Rocket } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { celebrate } from "../kit/game";
import { confirmDialog } from "../kit/dialogs";
import { DateField } from "../kit/date-field";
import { Modal, post } from "../records";
import { styles } from "../ui";
import css from "./plan-clocks.module.css";

/** PM-BUILD-1 (2262): record one of the plan's clocks: every input is in (day 0) or the day it went live. The person
 *  picks the day (today by default; never a day in the future). While an input is open the button says so and names
 *  them; the database refuses it too (an AI employee cannot press it). Going live is a milestone: a small celebration. */
export function ClockButton({ projectId, clock, label, what, open, primary, today }: { projectId: string; clock: "day0" | "live"; label: string; what: string;
  open: { code: string; title: string; taskId: string | null; who?: string | null }[]; primary?: boolean; today: string }) {
  const router = useRouter(); const btn = useRef<HTMLButtonElement>(null);
  const [show, setShow] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const blocked = open.length > 0;
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError("");
    try {
      const r = await post<{ dated: number; on: string }>(`projects/${projectId}/clock`, { clock, on: f.get("on") || null });
      notify({ id: `clock-${clock}`, tone: "success", title: clock === "live" ? `${what}: recorded` : `${what}: declared`,
        message: r.dated ? `${r.dated} ${r.dated === 1 ? "step now has its dates" : "steps now have their dates"}.` : undefined, timeout: 5000 });
      if (clock === "live") celebrate(btn.current, { big: true, id: `live-${projectId}` });
      setShow(false); router.refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "That did not save. Try again."); } finally { setBusy(false); }
  }
  const Icon = clock === "live" ? Rocket : CalendarCheck2;
  async function explain() {
    const first = open[0];
    const ok = await confirmDialog({ title: clock === "live" ? "Can't go live yet" : `Can't declare ${what.charAt(0).toLowerCase()}${what.slice(1)} yet`,
      body: <>{`You can ${label.charAt(0).toLowerCase()}${label.slice(1)} once ${open.length === 1 ? "this step is" : `these ${open.length} steps are`} done:`}
        <ul className={css.blockers}>{open.map((x) => <li key={x.code}><b>{x.code}</b><span>{x.title}<small>{x.who ? `${x.who} has it` : "Nobody has it yet"}</small></span></li>)}</ul></>,
      confirmLabel: first?.taskId ? "Open the step" : "Close", cancelLabel: "Close" });
    if (ok && first?.taskId) router.push(`/tasks/${first.taskId}`);
  }
  return <>
    {/* While inputs are open it is one locked control that says what it waits on; pressing it explains, never a dead button. */}
    <button ref={btn} type="button" className={`${styles.btn} ${primary && !blocked ? styles.btnPrimary : ""}`} onClick={blocked ? explain : () => setShow(true)}
      data-blocked={blocked ? "" : undefined} aria-label={blocked ? `${label}: waits on ${open.map((x) => x.code).join(", ")}` : undefined}>
      {blocked ? <><span className={css.lockDot} aria-hidden="true"><Lock size={15} /></span><span className={css.waitsOn} title={open.map((x) => `${x.code} ${x.title}`).join("; ")}>
          <span className={css.waitsWhat}>Waits on: <b>{open[0].title}</b></span>
          <small>{open[0].code} · {open[0].who ? `${open[0].who.split(" ")[0]} has it` : "nobody has it yet"}{open.length > 1 ? ` · and ${open.length - 1} more` : ""}</small></span><ChevronRight size={20} aria-hidden="true" className={css.lockGo} /></>
        : <><Icon size={14} aria-hidden="true" />{label}</>}</button>
    {show && !blocked ? <Modal title={label} size="sm" onClose={() => setShow(false)} foot={<div className={styles.modalFoot}>
      <button type="button" className={styles.btn} onClick={() => setShow(false)}>Cancel</button>
      <button form={`clock-${clock}`} className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}><Icon size={14} aria-hidden="true" />{label}</button></div>}>
      <form id={`clock-${clock}`} onSubmit={save} className={css.clockForm}>
        <label className={styles.field}>{clock === "live" ? "The day it went live" : "The day the last input came in"}<DateField name="on" defaultValue={today} max={today} required /></label>
        <p className={css.hint}>{clock === "live" ? "Every step after going live gets its dates from this day, and so do the windows that count from it." : "Every step that counts from this day gets its dates now. Your name and the day you declared it are kept."}</p>
        {error ? <p role="alert" className={css.problem}>{error}</p> : null}
      </form>
    </Modal> : null}
  </>;
}
