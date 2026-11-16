"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowUpRight, BellRing, CalendarClock, Check, LayoutTemplate, UserRound } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Modal, post } from "../records";
import { styles } from "../ui";
import { DateField } from "../kit/date-field";
import { SelectField } from "../kit/select-field";
import css from "./stages.module.css";

/** PROJECTS-STAGES (owner, 4 Nov 2026; Kazuk's 3 Nov meeting B2-B9, migration 1485): the small controls of projects run
 *  in stages. A starter template for the company's industry, a stage's owner, a task's stage, the doer's reason for late
 *  work and the lead's answer to it (chase, a new date, escalate). Every control says what it did. */
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not save. Try again.";
type Person = { id: string; name: string };
let peopleCache: Promise<Person[]> | null = null;
function usePeople(on: boolean) {
  const [people, setPeople] = useState<Person[] | null>(null);
  useEffect(() => {
    if (!on || people) return;
    peopleCache ??= fetch("/api/v0/tasks/options").then((r) => r.json()).then((o) => (o?.people ?? []).map((p: Person) => ({ id: p.id, name: p.name }))).catch(() => []);
    peopleCache.then(setPeople);
  }, [on, people]);
  return people;
}

export type StarterLite = { key: string; name: string; industry: string; summary: string; suggested: boolean; adopted: boolean; stages: string[]; steps: number };
/** B7/B8: choose how projects run, from starters for the company's industry (its own first). */
export function StarterPick({ starters, projectId }: { starters: StarterLite[]; projectId?: string }) {
  const router = useRouter();
  const [key, setKey] = useState(starters.find((s) => s.suggested)?.key ?? starters[0]?.key ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [all, setAll] = useState(false);
  const shown = all ? starters : starters.filter((s, i) => s.suggested || i < 4 || s.key === key);
  async function use() {
    setBusy(true); setError("");
    try {
      await post(`projects/starters/${key}`, projectId ? { projectId } : {});
      notify({ id: "starter", tone: "success", title: `${starters.find((s) => s.key === key)?.name ?? "Template"} added`, message: projectId ? "Now set up this project's plan." : "Set up a project's plan from its page.", timeout: 4000 });
      router.refresh();
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  return <div className={css.starters}>
    <div role="radiogroup" aria-label="Starter templates" className={css.starterList}>
      {shown.map((s) => <button key={s.key} type="button" role="radio" aria-checked={key === s.key} className={css.starter} onClick={() => setKey(s.key)}>
        <span className={css.starterHead}><LayoutTemplate size={14} aria-hidden="true" /><b>{s.name}</b>{s.suggested ? <small className={css.tag}>For your industry</small> : null}{s.adopted ? <small className={css.tag}>Added</small> : null}</span>
        <span className={css.starterSub}>{s.industry} · {s.summary}</span>
        <span className={css.starterStages}>{s.stages.map((x, i) => <span key={x}>{i ? <i aria-hidden="true">→</i> : null}{x}</span>)}</span>
      </button>)}
    </div>
    <div className={css.rowEnd}>
      {!all && shown.length < starters.length ? <button type="button" className={styles.btn} onClick={() => setAll(true)}>Show all {starters.length}</button> : <span />}
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !key} onClick={use}>{busy ? "Adding…" : "Use this template"}</button>
    </div>
    {error ? <p role="alert" className={css.problem}>{error}</p> : null}
  </div>;
}

/** B2: a stage's owner, given by the project's lead. */
export function StageOwnerPick({ projectId, stage, label, ownerId, owner }: { projectId: string; stage: number; label: string; ownerId: string | null; owner: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const people = usePeople(open);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError("");
    const personId = String(f.get("personId") ?? "") || null;
    try {
      await post(`projects/${projectId}/stage-owner`, { stage, personId });
      notify({ id: "stage-owner", tone: "success", title: personId ? `${people?.find((p) => p.id === personId)?.name ?? "They"} owns ${label}` : `${label} has no owner now`, timeout: 3000 });
      setOpen(false); router.refresh();
    } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }
  return <><button type="button" className={css.ownerBtn} data-none={ownerId ? undefined : ""} onClick={() => setOpen(true)} aria-label={`Owner of stage ${stage}, ${label}: ${owner ?? "nobody yet"}. Change`}>
    <UserRound size={13} aria-hidden="true" />{owner ?? "Give it an owner"}</button>
    {open ? <Modal title={`Owner of ${label}`} sub="They answer for this stage's work and see its late tasks" onClose={() => setOpen(false)}
      foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button><button form={`so-${stage}`} className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !people}>Save</button></div>}>
      <form id={`so-${stage}`} onSubmit={save} className={css.form}>
        <label className={styles.field}>Owner<SelectField name="personId" defaultValue={ownerId ?? ""}>{[<option key="" value="">Nobody</option>, ...(people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)]}</SelectField></label>
        {!people ? <p className={css.hint}>Loading people…</p> : null}
        {error ? <p role="alert" className={css.problem}>{error}</p> : null}
      </form>
    </Modal> : null}</>;
}

/** B9: put a task on a stage of its project (one tap; the list says which stage it is on). */
export function TaskStagePick({ projectId, taskId, title, stages, stage }: { projectId: string; taskId: string; title: string; stages: { n: number; label: string }[]; stage: number | null }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function move(v: string) {
    if (v === "") return; setBusy(true);
    try { const r = await post<{ label: string }>(`projects/${projectId}/task-stage`, { taskId, stage: Number(v) }); notify({ id: "task-stage", tone: "success", title: `On ${r.label}`, timeout: 2200 }); router.refresh(); }
    catch (e) { notify({ id: "task-stage", tone: "error", title: "That did not move", message: msg(e), timeout: 4000 }); } finally { setBusy(false); }
  }
  return <select className={css.stageSelect} value={stage === null ? "" : String(stage)} disabled={busy} aria-label={`Stage of ${title}`} onChange={(e) => move(e.currentTarget.value)}>
    {stage === null ? <option value="">Put on a stage…</option> : null}
    {stages.map((s) => <option key={s.n} value={s.n}>{s.n} · {s.label}</option>)}
  </select>;
}

/** B4: the doer says why the task is late and when it can be done. */
export function DelayAnswer({ taskId, reasons, today, compact }: { taskId: string; reasons: Record<string, string>; today: string; compact?: boolean }) {
  const router = useRouter();
  const [reason, setReason] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    if (!reason) { setError("Choose why it is late"); return; }
    setBusy(true); setError("");
    try {
      await post(`tasks/${taskId}/delay`, { reason, note: String(f.get("note") ?? "").trim() || null, by: String(f.get("by") ?? "") || null });
      notify({ id: "delay", tone: "success", title: "Sent", message: "The project's lead and the stage's owner see your answer.", timeout: 3200 });
      router.refresh();
    } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }
  return <form className={css.answer} onSubmit={send} data-compact={compact ? "" : undefined} aria-label="Why it is late">
    <fieldset className={css.reasons}><legend>Why is it late?</legend>
      {Object.entries(reasons).map(([k, label]) => <button key={k} type="button" className={styles.btn} aria-pressed={reason === k} onClick={() => setReason(k)}>{label}</button>)}
    </fieldset>
    <div className={css.answerRow}>
      <label className={styles.field}>{reason === "other" ? "Say why" : "A note (optional)"}<input name="note" maxLength={300} required={reason === "other"} placeholder="For example: the client has not sent the photos" /></label>
      <label className={styles.field}>Can be done by<DateField name="by" min={today} /></label>
    </div>
    {error ? <p role="alert" className={css.problem}>{error}</p> : null}
    <div className={css.rowEnd}><span /><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Sending…" : "Send"}</button></div>
  </form>;
}

export type DelayLite = { id: string; title: string; who: string | null; daysLate: number; canBy: string | null; answeredAt: string | null; action: string | null; dueOn: string };
/** B5: the lead or the stage's owner acts on late work: chase the doer, give it a new date, or escalate. */
export function DelayActions({ delay, today }: { delay: DelayLite; today: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<null | "date" | "up">(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  // Only people who may open the task (the API refuses anyone else).
  const [people, setPeople] = useState<Person[] | null>(null);
  useEffect(() => {
    if (mode !== "up" || people) return;
    fetch(`/api/v0/projects/delays/${delay.id}/targets`).then((r) => r.json()).then((o) => setPeople(o?.people ?? [])).catch(() => setPeople([]));
  }, [mode, people, delay.id]);
  async function act(action: string, body: Record<string, unknown> = {}) {
    setBusy(true); setError("");
    try {
      await post(`projects/delays/${delay.id}`, { action, ...body });
      notify({ id: "delay-act", tone: "success", timeout: 3000, title: action === "chased" ? `Asked ${delay.who ?? "the doer"} again` : action === "rescheduled" ? "New date set" : "Escalated" });
      setMode(null); router.refresh();
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); const note = String(f.get("note") ?? "").trim() || null;
    if (mode === "date") void act("rescheduled", { due: String(f.get("due") ?? ""), note });
    else void act("escalated", { toId: String(f.get("toId") ?? "") || null, note });
  }
  return <div className={css.acts}>
    <button type="button" className={styles.btn} disabled={busy} onClick={() => act("chased")}><BellRing size={13} aria-hidden="true" />Chase</button>
    <button type="button" className={styles.btn} disabled={busy} onClick={() => setMode("date")}><CalendarClock size={13} aria-hidden="true" />New date</button>
    <button type="button" className={styles.btn} disabled={busy} onClick={() => setMode("up")}><ArrowUpRight size={13} aria-hidden="true" />Escalate</button>
    {error && !mode ? <p role="alert" className={css.problem}>{error}</p> : null}
    {mode ? <Modal title={mode === "date" ? "Give it a new date" : "Escalate"} sub={`“${delay.title}” · ${delay.daysLate} ${delay.daysLate === 1 ? "day" : "days"} late`} onClose={() => setMode(null)}
      foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={() => setMode(null)}>Cancel</button><button form={`da-${delay.id}`} className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}><Check size={13} aria-hidden="true" />{mode === "date" ? "Set the date" : "Escalate"}</button></div>}>
      <form id={`da-${delay.id}`} onSubmit={submit} className={css.form}>
        {mode === "date" ? <label className={styles.field}>New due day<DateField name="due" required min={today} defaultValue={delay.canBy && delay.canBy >= today ? delay.canBy : undefined} /></label>
          : <><label className={styles.field}>To<SelectField name="toId" required defaultValue="">{[<option key="" value="">{people ? "Choose a person" : "Loading people…"}</option>, ...(people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)]}</SelectField></label>
            {people && !people.length ? <p className={css.hint}>Nobody else can open this task. Chase it or give it a new date instead.</p> : <p className={css.hint}>Only people who can open this task are listed.</p>}</>}
        <label className={styles.field}>Note (optional)<input name="note" maxLength={300} /></label>
        {mode === "date" && delay.canBy ? <p className={css.hint}>{delay.who ?? "The doer"} said it can be done by {delay.canBy}.</p> : null}
        {error ? <p role="alert" className={css.problem}>{error}</p> : null}
      </form>
    </Modal> : null}
  </div>;
}
