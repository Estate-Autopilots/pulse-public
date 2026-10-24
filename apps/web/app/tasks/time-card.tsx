"use client";
// TASKS-4B: time on a task, captured by itself. The clock runs while the doer has the task in Doing (one task at a
// time) and pauses with Blocked, check-out, breaks and leaving the office; Done stops it. The card shows what has been
// captured against the estimate, the clock (Start / Pause / Resume for the doer), and each entry with a correction.
// Typing time in by hand stays, as a correction. A task with no estimate asks once: "About how long will this take?"
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Pause, Pencil, Play, Plus, Timer, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../records";
import { styles } from "../ui";
import { Tooltip } from "../kit";
import { LogTime } from "./client";
import { dayMonthYear } from "./parts";
import type { Detail, Life } from "./types";
import { useOrgZone } from "../org-code";
import css from "./life.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const hours = (m: number) => m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
const clockTime = (iso: string, zone: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zone }).format(new Date(iso));
const WHY: Record<string, string> = { paused: "paused", blocked: "paused: blocked", todo: "paused: back to To do", done: "stopped: done", cancelled: "stopped: cancelled", switched: "paused: you started another task",
  reassigned: "stopped: someone else has it", checkout: "paused at check-out", break: "paused for a break", away: "paused: you left the office", capped: "stopped after 10 hours: check the time", deleted: "stopped" };

export function TimeCard({ d, today }: { d: Detail; today: string }) {
  const zone = useOrgZone();
  const router = useRouter(); const t = d.task; const life = d.life as Life; const clock = life.clock;
  const [busy, setBusy] = useState(false), [adding, setAdding] = useState(false), [fixing, setFixing] = useState<string | null>(null), [minutes, setMinutes] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!clock.running) return; const h = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(h); }, [clock.running]);
  const runningMine = !!clock.running && clock.mine;
  const live = clock.running ? Math.max(0, Math.floor((now - Date.parse(clock.running.startedAt)) / 60000)) : 0;
  const total = clock.captured + live;
  const est = t.estimateMinutes ?? null;
  async function toggle(on: boolean) {
    setBusy(true);
    try { const r = await post<{ minutes?: number }>(`tasks/${t.id}/timer`, { on }); notify({ id: "clock", tone: "success", title: on ? "The clock is running" : `Paused${r.minutes ? ` · ${hours(r.minutes)} captured` : ""}`, timeout: 2000 }); router.refresh(); }
    catch (e) { notify({ id: "clock", tone: "error", title: "Not changed", message: msg(e) }); } finally { setBusy(false); }
  }
  async function fix(id: string, decision: "adjust" | "retire") {
    setBusy(true);
    try { await post(`time/${id}`, decision === "adjust" ? { decision, minutes: Math.round(Number(minutes)) } : { decision }); setFixing(null); notify({ id: "clock", tone: "success", title: decision === "adjust" ? "Corrected" : "Removed", timeout: 2000 }); router.refresh(); }
    catch (e) { notify({ id: "clock", tone: "error", title: "Not changed", message: msg(e) }); } finally { setBusy(false); }
  }
  const finished = ["done", "in_review", "accepted", "cancelled"].includes(t.status);
  return <section className={css.timeCard} aria-label="Time">
    <div className={css.timeHead}>
      <Timer size={16} aria-hidden="true" /><b>{total ? hours(total) : clock.running ? "Just started" : "No time yet"}</b>{est ? <small>of about {hours(est)}</small> : null}
      {clock.mine && !finished ? runningMine ? <button type="button" className={styles.btn} disabled={busy} onClick={() => void toggle(false)}><Pause size={13} aria-hidden="true" />Pause</button>
        : <button type="button" className={styles.btn} disabled={busy} onClick={() => void toggle(true)}><Play size={13} aria-hidden="true" />{t.status === "in_progress" ? "Resume" : "Start"}</button> : null}
    </div>
    {est ? <div className={css.timeBar} data-over={total > est ? "" : undefined} role="img" aria-label={`${hours(total)} of about ${hours(est)}`}><i style={{ width: `${Math.min(100, Math.round((total / est) * 100))}%` }} /></div> : null}
    <p className={css.timeState}>{clock.running ? <><span className={css.live} aria-hidden="true" />Running since {clockTime(clock.running.startedAt, zone)}{clock.mine ? "" : ` (${d.task.assigneeName?.split(" ")[0] ?? "the doer"})`} · {hours(live || 1)} so far</>
      : clock.last ? <>Clock {WHY[clock.last.reason] ?? "paused"} · {clockTime(clock.last.endedAt, zone)}</>
      : t.status === "in_progress" ? "The clock starts when whoever does it moves it to Doing." : finished ? "Captured while it was in Doing." : "Starts by itself when the work moves to Doing."}
      {clock.proposed ? <> · <b>{hours(clock.proposed)} to check</b></> : null}</p>
    {d.time.length ? <ul className={css.timeList}>{d.time.slice(0, 10).map((e) => <li key={e.id}>
      <span><b>{hours(e.minutes)}</b> · {e.personName.split(" ")[0]} · {dayMonthYear(e.date)}{e.source === "timer" ? "" : e.source === "manual" ? " · by hand" : ` · ${e.source}`}{e.status === "proposed" ? " · to check" : ""}</span>
      {e.personId === d.me ? fixing === e.id ? <form className={css.fixForm} onSubmit={(ev) => { ev.preventDefault(); void fix(e.id, "adjust"); }}>
        <input type="number" min={1} max={1440} value={minutes} onChange={(ev) => setMinutes(ev.target.value)} aria-label="Minutes" autoFocus />
        <button type="submit" className={styles.btn} disabled={busy || !Number(minutes)}>Save</button>
        <Tooltip content="Remove this entry"><button type="button" className={css.iconBtn} aria-label="Remove this entry" onClick={() => void fix(e.id, "retire")}><X size={13} /></button></Tooltip>
      </form> : <Tooltip content="Correct the time"><button type="button" className={css.iconBtn} aria-label={`Correct ${hours(e.minutes)} on ${dayMonthYear(e.date)}`} onClick={() => { setFixing(e.id); setMinutes(String(e.minutes)); }}><Pencil size={13} /></button></Tooltip> : <span />}
    </li>)}</ul> : null}
    {d.me ? adding ? <LogTime taskId={t.id} projectId={t.projectId} today={today} /> : <button type="button" className={css.linkBtn} onClick={() => setAdding(true)}><Plus size={13} aria-hidden="true" />Add or correct time by hand</button> : null}
  </section>;
}

const CHOICES = [{ m: 30, label: "30 min" }, { m: 120, label: "2 h" }, { m: 480, label: "A day" }, { m: 1440, label: "A few days" }];
/** Asked once, when nobody (not even Pip, from similar work) knows how long it takes. */
export function AskEstimate({ taskId, pip }: { taskId: string; pip: number | null }) {
  const router = useRouter(); const [busy, setBusy] = useState(false), [gone, setGone] = useState(false);
  async function answer(minutes: number | null) {
    setBusy(true);
    try { await post(`tasks/${taskId}/estimate`, { minutes }); setGone(true); if (minutes) notify({ id: "estimate", tone: "success", title: `About ${hours(minutes)}`, message: "The time captured is measured against it.", timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "estimate", tone: "error", title: "Not saved", message: msg(e) }); } finally { setBusy(false); }
  }
  if (gone) return null;
  return <div className={css.ask} role="group" aria-label="About how long will this take?">
    <Timer size={16} aria-hidden="true" />
    <span className={css.askText}><b>About how long will this take?</b><small>{pip ? `Pip’s guess from similar work is about ${hours(pip)}, but it is not sure. ` : "Nothing similar has been finished yet. "}Asked once; the clock is measured against it.</small></span>
    <span className={css.askChoices}>{CHOICES.map((c) => <button key={c.m} type="button" className={styles.btn} disabled={busy} onClick={() => void answer(c.m)}>{c.label}</button>)}
      <button type="button" className={css.linkBtn} disabled={busy} onClick={() => void answer(null)}>Skip</button></span>
  </div>;
}
