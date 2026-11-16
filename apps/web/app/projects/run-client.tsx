"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { CalendarClock, CirclePause } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Modal, post } from "../records";
import { styles } from "../ui";
import { DateField } from "../kit/date-field";
import css from "./overview.module.css";
import { W } from "../kit/word";

/** KAZUK (Kazuk's screens 5 and 6): set a project's status with a reason, and change a task's dates with a reason. The
 *  database decides who may (pulse.project_set_status, pulse.project_reschedule, migration 1300). */
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not save. Try again.";
export type RunStatus = "active" | "paused" | "on_hold" | "discontinued";
export const STATUS_LABEL: Record<RunStatus, string> = { active: "Active", paused: "Paused", on_hold: "On hold", discontinued: "Discontinued" };
const MEANS: Record<RunStatus, string> = {
  active: "Work goes on. Coming back from a pause can move every open task by the days it was paused.",
  paused: "The client asked to stop for a while. Paused projects drop out of late counts but stay visible.",
  on_hold: "Our own decision to stop work, for example payment pending or a registration document missing. Tell the client why.",
  discontinued: "The engagement ends. Open tasks are cancelled and kept for history; you get a final-numbers report task and an assets-and-access handover task.",
};

export function ProjectStatusButton({ projectId, status }: { projectId: string; status: RunStatus }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [to, setTo] = useState<RunStatus>(status === "active" ? "paused" : "active"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError("");
    try {
      const r = await post<{ tasks: number; shiftedDays: number | null }>(`projects/${projectId}/status`, { status: to, reason: f.get("reason"), from: f.get("from") || null, restart: f.get("restart") || null, shift: f.get("shift") === "on",
        stops: { tasks: f.get("stopTasks") === "on", ads: f.get("stopAds") === "on", months: f.get("stopMonths") === "on", guarantee: f.get("moveGuarantee") === "on", post: f.get("post") === "on" } });
      notify({ id: "project-status", tone: "success", title: `Project is now ${STATUS_LABEL[to].toLowerCase()}`, message: to === "discontinued" ? `${r?.tasks ?? 0} open tasks cancelled; two closing tasks added for the lead.` : r?.shiftedDays ? `Open tasks moved by ${r.shiftedDays} days.` : undefined, timeout: 4000 });
      setOpen(false); router.refresh();
    } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }
  const choices = (Object.keys(STATUS_LABEL) as RunStatus[]).filter((s) => s !== status);
  return <><button type="button" className={styles.btn} onClick={() => setOpen(true)}><CirclePause size={13} aria-hidden="true" />Status: {STATUS_LABEL[status]}</button>
    {open ? <Modal title="Project status" onClose={() => setOpen(false)} foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button>
      <button form="project-status" className={`${styles.btn} ${styles.btnPrimary}`} data-tone={to === "discontinued" ? "danger" : undefined} disabled={busy}>{to === "active" ? "Restart project" : to === "discontinued" ? "Discontinue project" : to === "paused" ? "Pause project" : "Put on hold"}</button></div>}>
      <form id="project-status" onSubmit={save} className={css.form}>
        <div className={styles.segmented} role="radiogroup" aria-label="New status">{choices.map((s) => <button type="button" key={s} role="radio" aria-checked={to === s} className={styles.segment} aria-current={to === s ? "true" : undefined} onClick={() => setTo(s)}>{STATUS_LABEL[s]}</button>)}</div>
        <p className={css.hint}>{MEANS[to]}</p>
        {to === "paused" || to === "on_hold" ? <div className={css.twoFields}><label className={styles.field}>From<DateField name="from" /></label><label className={styles.field}>Expected restart (if known)<DateField name="restart" /></label></div> : null}
        {to === "discontinued" ? <label className={styles.field}>Last working day<DateField name="from" /></label> : null}
        <label className={styles.field}>Reason (required)<input name="reason" required minLength={3} maxLength={500} placeholder={to === "on_hold" ? "Payment pending" : to === "paused" ? "Price revision for the next phase" : to === "active" ? "Client is ready again" : "Client ended the engagement"} /></label>
        {to === "paused" || to === "on_hold" ? <fieldset className={css.checks}><legend>What stops</legend>
          <label><input type="checkbox" name="stopTasks" defaultChecked />Open tasks and their reminders</label>
          <label><input type="checkbox" name="stopAds" defaultChecked />Ads switched off</label>
          <label><input type="checkbox" name="stopMonths" defaultChecked />Campaign months stop counting</label>
          <label><input type="checkbox" name="moveGuarantee" />Guarantee checks move by the paused days</label>
        </fieldset> : null}
        {to === "active" && status !== "discontinued" ? <label className={css.check}><input type="checkbox" name="shift" defaultChecked />Move every open task by the days it was paused</label> : null}
        {to !== "active" ? <label className={css.check}><input type="checkbox" name="post" defaultChecked />Remind me to tell the client group and the <W k="team" lc /> chat</label> : null}
        {error ? <p role="alert" className={css.problem}>{error}</p> : null}
      </form>
    </Modal> : null}</>;
}

const REASONS: [string, string][] = [["client_delay", "Client delay"], ["our_delay", "Our delay"], ["client_paused", "Client paused"], ["ea_hold", "Our hold"], ["scope_change", "Scope change"], ["other", "Other"]];
export const REASON_LABEL = Object.fromEntries(REASONS) as Record<string, string>;

export function ChangeDates({ projectId, task }: { projectId: string; task: { id: string; title: string; who: string | null; start: string | null; due: string | null; waiting: number } }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError("");
    try {
      const r = await post<{ moved: number }>(`projects/${projectId}/reschedule`, { taskId: task.id, start: f.get("start") || null, due: f.get("due") || null, reason, note: f.get("note") || null, cascade: f.get("cascade") === "on" });
      notify({ id: "reschedule", tone: "success", title: "Dates changed", message: r?.moved ? `${r.moved} waiting ${r.moved === 1 ? "task" : "tasks"} moved too.` : undefined, timeout: 3000 });
      setOpen(false); router.refresh();
    } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }
  return <><button type="button" className={css.linkButton} onClick={() => setOpen(true)} aria-label={`Change dates of ${task.title}`}><CalendarClock size={13} aria-hidden="true" /></button>
    {open ? <Modal title="Change dates" onClose={() => setOpen(false)} foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button><button form="change-dates" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !reason}>{task.who ? `Save and tell ${task.who.split(" ")[0]}` : "Save"}</button></div>}>
      <form id="change-dates" onSubmit={save} className={css.form}>
        <p className={css.hint}><b>{task.title}</b>{task.who ? ` · ${task.who}` : ""}</p>
        <div className={css.twoFields}><label className={styles.field}>Start<DateField name="start" defaultValue={task.start ?? ""} /></label><label className={styles.field}>End<DateField name="due" defaultValue={task.due ?? ""} /></label></div>
        {task.due ? <p className={css.hint}>Was {task.start ? `${task.start} → ` : ""}{task.due}</p> : null}
        <fieldset className={css.reasons}><legend>Reason (required)</legend>{REASONS.map(([k, l]) => <button type="button" key={k} className={styles.segment} aria-pressed={reason === k} aria-current={reason === k ? "true" : undefined} onClick={() => setReason(k)}>{l}</button>)}</fieldset>
        <label className={styles.field}>Note{reason === "other" ? " (required)" : ""}<input name="note" maxLength={300} required={reason === "other"} placeholder="Model approval came on 21 Oct" /></label>
        {task.waiting ? <label className={css.check}><input type="checkbox" name="cascade" defaultChecked />Also move the {task.waiting === 1 ? "task that waits" : `${task.waiting} tasks that wait`} for it</label> : null}
        {error ? <p role="alert" className={css.problem}>{error}</p> : null}
      </form>
    </Modal> : null}</>;
}
