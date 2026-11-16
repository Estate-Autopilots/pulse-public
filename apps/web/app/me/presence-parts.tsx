"use client";
// My desk, PRESENCE-ONBOARD: "On time this week" (the habit), and the day as it happened — every check-in, break and
// check-out with how it was recorded, everything Pulse noticed or reminded, and "That's not right" on anything Pulse
// did by itself, which turns into an ordinary correction request (HR or the manager decides; nothing is edited silently).
import { AlarmClock, Bell, Building2, CalendarCheck, ChevronLeft, ChevronRight, Coffee, LogIn, LogOut, MapPin, ShieldQuestion, Wifi } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { notify } from "@pulse/ui-shell";
import { useCompanionDay } from "../lib/companion-day";
import { longDay, shiftDay, time } from "../lib/format";
import { Modal, post } from "../records";
import { Badge, Skeleton, styles } from "../ui";
import { DatePicker } from "../kit";
import css from "./presence.module.css";

const DOT: Record<string, string> = { on_time: "On time", late: "Late", missed: "No check-in", off: "Day off", today: "Today" };
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The habit: this week's days and the on-time streak, from the same day every Pulse surface reads. */
export function HabitCard({ title = "On time this week" }: { title?: string }) {
  const { payload } = useCompanionDay();
  const week = payload?.attendanceEnabled ? payload.week : null;
  if (!payload || !week) return null;
  const counted = week.onTime + week.late + week.missed;
  const line = payload.streak.firstCheckIn ? "Your first check-in. Welcome to Pulse!"
    : counted && week.onTime === counted ? "Every day on time so far. Keep it going!"
    : week.late ? `Check in by ${payload.shift.onTimeBy} to be on time.` : week.missed ? "A day without a check-in counts as absent for payroll unless it is corrected." : `Check in by ${payload.shift.onTimeBy} to be on time.`;
  return (
    <section className={css.habit} aria-label={title}>
      <p className={css.habitHead}><b>{title}</b><span>{counted ? `${week.onTime} of ${counted} on time` : "A new week"}</span></p>
      <ol className={css.days}>{week.days.map((d) => (
        <li key={d.date} data-state={d.state}><span aria-hidden="true">{WEEKDAY[new Date(`${d.date}T00:00:00Z`).getUTCDay()].slice(0, 1)}</span><i aria-hidden="true" /><small className={css.srOnly}>{longDay(d.date)}: {DOT[d.state]}</small></li>
      ))}</ol>
      <p className={css.habitLine}>{payload.streak.onTime > 1 ? <b>{payload.streak.onTime} working days on time in a row. </b> : null}{line}</p>
    </section>
  );
}

type Session = { id: string; in: string; out: string | null; mode: string; late: number; source: string; inVia: string | null; inTrigger: string | null; inQueued: boolean;
  outVia: string | null; outTrigger: string | null; outQueued: boolean; office: string | null; breaks: { id: string; start: string; end: string | null }[] };
type Event = { id: string; at: string; kind: "arrival_asked" | "auto_check_in" | "left_office" | "correction_proposed" | "reminder" | "nudge"; detail: string | null; signals: string[];
  office: string | null; device: string | null; entryId: string | null; correctionId: string | null; disputedAt: string | null; disputeId: string | null };
type Correction = { id: string; kind: string; inTime: string | null; outTime: string | null; reason: string; status: string; createdAt: string };
type DayData = { attendanceEnabled: boolean; date: string; today: string; self?: boolean; sessions: Session[]; events: Event[]; corrections: Correction[] };
type Row = { at: string; icon: typeof LogIn; title: string; sub?: string; tone?: "warning" | "success"; event?: Event; session?: Session; correction?: Correction };

const SIGNAL: Record<string, string> = { wifi: "office Wi-Fi", network: "office network", geofence: "phone at the office", schedule: "your shift", hr: "HR" };
const VIA: Record<string, string> = { web: "Pulse on the web", widget: "Pulse on the web", desktop: "the desktop app", mobile: "the phone app", chrome: "the Chrome extension" };
const HOW: Record<string, string> = { manual: "", suggested: " · answering “Check in?”", notification: " · from a notification", widget: " · from the widget", reminder: " · from a reminder", auto: " · automatically" };
const REMINDER: Record<string, string> = { start: "Reminder to check in", end: "Reminder to check out", done: "“Done for the day?”", departure: "“Possibly left the office?”", break: "“Still on your break?”" };
const signals = (s: string[]) => s.map((x) => SIGNAL[x] ?? x).join(" + ");
const via = (v: string | null, t: string | null, queued: boolean) => `${v ? `via ${VIA[v] ?? v}` : "recorded"}${HOW[t ?? "manual"] ?? ""}${queued ? " · saved offline, synced later" : ""}`;

function rows(d: DayData): Row[] {
  const out: Row[] = [];
  for (const s of d.sessions) {
    out.push({ at: s.in, icon: LogIn, title: `${s.inTrigger === "auto" ? "Checked in automatically" : "Checked in"} at ${time(s.in)}${s.office ? ` · ${s.office}` : ""}`,
      sub: `${s.source === "regularised" ? "Recorded by an approved correction" : via(s.inVia, s.inTrigger, s.inQueued)}${s.late ? ` · late by ${s.late} min` : ""}`, tone: s.late ? "warning" : undefined, session: s });
    for (const b of s.breaks) out.push({ at: b.start, icon: Coffee, title: `Break ${time(b.start)}${b.end ? ` – ${time(b.end)}` : " · still on it"}`, sub: b.end ? `${Math.round((Date.parse(b.end) - Date.parse(b.start)) / 60000)} min` : undefined });
    if (s.out) out.push({ at: s.out, icon: LogOut, title: `Checked out at ${time(s.out)}`, sub: via(s.outVia, s.outTrigger, s.outQueued) });
  }
  for (const e of d.events) {
    if (e.kind === "auto_check_in") continue;   // shown on its check-in row, with "That's not right"
    const icon = e.kind === "arrival_asked" ? Wifi : e.kind === "left_office" ? MapPin : e.kind === "correction_proposed" ? ShieldQuestion : e.kind === "nudge" ? Bell : AlarmClock;
    const title = e.kind === "arrival_asked" ? `Pulse noticed you at ${e.office ?? "the office"} and asked “Check in?”`
      : e.kind === "left_office" ? `You seemed to leave ${e.office ?? "the office"}; Pulse reminded you to check out`
      : e.kind === "correction_proposed" ? "Check-out proposed at your last presence, for a decision"
      : e.kind === "nudge" ? "HR reminded you to check in" : REMINDER[e.detail ?? ""] ?? "Reminder";
    out.push({ at: e.at, icon, title: `${time(e.at)} · ${title}`, sub: e.signals.length && e.kind !== "reminder" && e.kind !== "nudge" ? `From ${signals(e.signals)}${e.device ? ` on your ${e.device}` : ""}. No location is kept.` : undefined, event: e,
      tone: e.kind === "correction_proposed" ? "warning" : undefined });
  }
  for (const c of d.corrections) out.push({ at: c.createdAt, icon: CalendarCheck, title: `Correction ${c.status === "pending" ? "requested" : c.status}: ${c.kind === "late" ? "late mark" : c.kind === "missed_punch" ? `${c.inTime ?? "–"} to ${c.outTime ?? "–"}` : c.kind}`, sub: c.reason, correction: c, tone: c.status === "pending" ? "warning" : c.status === "approved" ? "success" : undefined });
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** One day, as it happened; "That's not right" on whatever Pulse did by itself. */
export function DayTimeline({ today, canAct, title = "Your day" }: { today: string; canAct: boolean; title?: string }) {
  const [date, setDate] = useState(today);
  const [data, setData] = useState<DayData | null>(null);
  const [error, setError] = useState("");
  const [dispute, setDispute] = useState<{ event: Event; session: Session | null } | null>(null);
  const [version, setVersion] = useState(0);
  const load = useCallback(() => setVersion((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    fetch(`/api/v0/attendance/day?date=${date}`, { cache: "no-store" })
      .then(async (r) => { const body = await r.json(); if (!r.ok) throw new Error(body.error); if (alive) { setData(body); setError(""); } })
      .catch((e) => { if (alive) setError((e as Error).message || "Could not load the day"); });
    return () => { alive = false; };
  }, [date, version]);
  useEffect(() => { window.addEventListener("pulse:attendance", load); return () => window.removeEventListener("pulse:attendance", load); }, [load]);
  const list = data ? rows(data) : [];
  const autoFor = (s?: Session) => s ? data?.events.find((e) => e.kind === "auto_check_in" && e.entryId === s.id) : undefined;
  return (
    <section className={css.timeline} aria-label={title}>
      <header className={css.timelineHead}>
        <b>{date === today ? "Your day so far" : longDay(date)}</b>
        <span className={css.dayNav}>
          <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} aria-label="Previous day" onClick={() => setDate(shiftDay(date, -1))}><ChevronLeft size={14} aria-hidden="true" /></button>
          {/* UX-5A: the kit's day picker, not the browser's date box. */}
          <DatePicker label="Day" value={{ date, time: null }} max={today} today={today} quick={false} size="sm" variant="chip" onChange={(v) => { if (v.date) setDate(v.date); }} />
          <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} aria-label="Next day" disabled={date >= today} onClick={() => setDate(shiftDay(date, 1))}><ChevronRight size={14} aria-hidden="true" /></button>
        </span>
      </header>
      {error ? <p role="alert" className={styles.muted}>{error}</p> : !data ? <div role="status" aria-busy="true" className={styles.stack} style={{ gap: 8 }}><span className={styles.srOnly}>Loading your day</span>{[0, 1, 2].map((i) => <Skeleton key={i} height={34} />)}</div> : !list.length ? (
        <p className={css.empty}>{date === today ? "Nothing yet today. When you check in, it shows here with how it was recorded." : "No check-in on this day."}{date < today && canAct ? <> If you worked, <Link href="/me?tab=attendance">request a correction</Link>.</> : null}</p>
      ) : (
        <ol className={css.events}>{list.map((r, i) => { const auto = autoFor(r.session); const disputable = canAct && data.self !== false && (auto || r.event?.kind === "correction_proposed");
          const ev = auto ?? r.event; const Icon = r.icon;
          return (
            <li key={`${r.at}-${i}`} data-tone={r.tone}>
              <Icon size={15} aria-hidden="true" className={css.eventIcon} />
              <span className={css.eventText}><b>{r.title}</b>{auto ? <small>Checked in by Pulse after {signals(auto.signals)} held for the dwell time. No location is kept.</small> : r.sub ? <small>{r.sub}</small> : null}</span>
              {disputable && ev ? (ev.disputedAt ? <Badge tone="warning">Correction asked</Badge>
                : <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setDispute({ event: ev, session: r.session ?? data.sessions.find((s) => s.id === ev.entryId) ?? null })}>That’s not right</button>) : null}
            </li>
          ); })}</ol>
      )}
      {dispute && data ? <NotRight date={data.date} today={data.today} event={dispute.event} session={dispute.session} corrections={data.corrections} onClose={() => setDispute(null)} onDone={() => { setDispute(null); load(); }} /> : null}
    </section>
  );
}

/** "That's not right": the person says what really happened; it becomes a correction request linked to the event. */
function NotRight({ date, today, event, session, corrections, onClose, onDone }: { date: string; today: string; event: Event; session: Session | null; corrections: Correction[]; onClose: () => void; onDone: () => void }) {
  const router = useRouter(); const form = useId();
  const proposed = event.kind === "correction_proposed" ? corrections.find((c) => c.id === event.correctionId && c.status === "pending") : undefined;
  const [what, setWhat] = useState<"time" | "late">(proposed ? "time" : session?.late ? "late" : "time");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const closed = !!session?.out || date < today;
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError("");
    const f = new FormData(e.currentTarget);
    try {
      // A proposed check-out the person disagrees with is withdrawn and replaced by their own times.
      if (proposed) await post(`hr/regularisations/${proposed.id}`, { decision: "cancelled" });
      const r = await post<{ id: string }>("hr/regularisations", what === "late"
        ? { kind: "late", date, entryId: session?.id, reason: f.get("reason") }
        : { kind: "missed_punch", date, entryId: session?.id, inTime: f.get("inTime") || undefined, outTime: f.get("outTime") || undefined, reason: f.get("reason") });
      await post(`attendance/events/${event.id}/dispute`, { correctionId: r.id });
      notify({ id: `dispute:${event.id}`, tone: "success", title: "Correction sent", message: "Your manager or HR decides. The day shows the decision.", timeout: 3500 });
      window.dispatchEvent(new Event("pulse:attendance")); router.refresh(); onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  const inAt = session ? time(session.in) : "", outAt = proposed?.outTime ?? (session?.out ? time(session.out) : "");
  return (
    <Modal title="That’s not right" sub={event.kind === "correction_proposed" ? "Say when you really finished. Nothing changes until it is approved." : "Say what really happened. Nothing changes until it is approved."} onClose={onClose}
      foot={<div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>Cancel</button><button form={form} className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Sending…" : "Send correction"}</button></div>}>
      <form id={form} className={styles.modalBody} onSubmit={send}>
        {session?.late && !proposed ? <fieldset className={`${styles.field} ${styles.wide}`}><legend>What is wrong?</legend>
          <label><input type="radio" name="what" checked={what === "time"} onChange={() => setWhat("time")} /> The time is wrong</label>
          <label><input type="radio" name="what" checked={what === "late"} onChange={() => setWhat("late")} /> I arrived on time: remove the late mark</label>
        </fieldset> : null}
        {what === "time" ? <>
          <label className={styles.field}>Started at<input type="time" name="inTime" defaultValue={inAt} required={!session} /></label>
          <label className={styles.field}>Finished at{closed || proposed ? "" : " (if you have)"}<input type="time" name="outTime" defaultValue={outAt} required={closed || !!proposed} /></label>
        </> : null}
        <label className={`${styles.field} ${styles.wide}`}>What happened<textarea name="reason" required minLength={5} maxLength={500}
          defaultValue={event.kind === "auto_check_in" ? `Automatic check-in at ${inAt} was not right: ` : event.kind === "correction_proposed" ? "I finished at a different time: " : ""} /></label>
        <p className={styles.modalNote}><Building2 size={12} aria-hidden="true" /> Pulse keeps the original record; the decision and who made it show on the day.</p>
      </form>
    </Modal>
  );
}
