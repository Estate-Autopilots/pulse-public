"use client";

import { Building2, Check, Coffee, House, LogIn, LogOut, MapPin, PencilLine, Play, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { notify } from "@pulse/ui-shell";
import { liveSeconds, pipSvg, type ActionId } from "@pulse/companion";
import { hm } from "../lib/checkin-view.mjs";
import { useCompanionDay } from "../lib/companion-day";
import { dayYear, longDay, time } from "../lib/format";
import { attendanceShell, haptic } from "../lib/native-shell";
import { useAttendanceRecovery } from "./attendance-recovery";
import { OfficeCheck } from "./office-check";
import { DrawerFooter } from "../kit/drawer";
import { Popover, usePopoverState } from "../kit/popover";
import { DatePicker, Segmented, Select } from "../kit";
import { useDoParam } from "../lib/do-param";
import { Modal, post } from "../records";
import { Badge, styles } from "../ui";
import css from "./hr.module.css";
import { CATEGORY, MODE, REG_KIND, dayCount, duration, type Balance, type LeaveType, type Mode, type PersonHr, type Policy, type RegKind, type TicketStatus } from "./types";

const message = (e: unknown) => e instanceof Error ? e.message : "Could not save";
const MODE_ICON = { office: Building2, wfh: House, field: MapPin } as const;
/** EST-1195: what an attendance button says while Pulse is being asked. */
const DOING: Record<ActionId, string> = { "check-in": "Checking in…", "check-out": "Checking out…", "break-start": "Starting break…", "break-end": "Ending break…" };

/** Run one HR action, say what happened, and reload the page's data. */
function useAction() {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function run(path: string, body: unknown, done: string, id = path) {
    setBusy(true);
    try { await post(path, body); if (path.startsWith("attendance/")) haptic("success"); notify({ id, tone: "success", title: done, timeout: 2500 }); if (path.startsWith("attendance/")) window.dispatchEvent(new Event("pulse:attendance")); router.refresh(); return true; }
    catch (e) { notify({ id, tone: "error", title: "That did not work", message: message(e) }); return false; } finally { setBusy(false); }
  }
  return { busy, run };
}

/** Today: check in (office, home or on duty), take a break, check out. The clock counts while the person is in. */
export function TodayCard({ now, policy, clock, today, canAct, wfh, name, attendanceEnabled, personId, compact }: { now: NonNullable<PersonHr["now"]>; policy: Policy; clock: string; today: string; canAct: boolean; wfh: NonNullable<PersonHr["wfh"]>; name?: string; attendanceEnabled?: boolean; personId?: string;
  /** UX-5A: My desk's small "today": no Pip, no hints, the state and the buttons. */ compact?: boolean }) {
  const legacy = useAction();
  // EST-1195: a tap shows its progress at once ("Checking in…"). Whichever way Pulse accepts it (this button, Try again,
  // Retry saved attendance), the hook keeps it until this card's day changes, so a slow refresh never shows the old buttons.
  const serverKey = `${now.state}|${now.entry?.in ?? ""}|${now.entry?.out ?? ""}|${now.entry?.onBreak ? 1 : 0}`;
  const recovery = useAttendanceRecovery(canAct && attendanceEnabled === true ? personId : undefined, serverKey);
  const doing = personId ? recovery.working : null;
  const busy = personId ? doing !== null : legacy.busy;
  // A tap saved on this device but not sent yet keeps the button's own name (disabled); the line under it says it is saved.
  const say = (action: ActionId, idle: string) => doing !== action || (recovery.working === action && !recovery.sending) ? idle : DOING[action];
  const run = (path: string, body: Record<string, unknown>, done: string, id: string, trigger?: "suggested") => {
    if (!personId) return legacy.run(path, body, done, id);
    const action: ActionId = path.endsWith('check-in') ? 'check-in' : path.endsWith('check-out') ? 'check-out' : body.action === 'end' ? 'break-end' : 'break-start';
    return recovery.act(action, String(body.mode ?? 'office'), trigger, body.leave === 'cancel' ? { leave: 'cancel' } : undefined);
  };
  const [mode, setMode] = useState<Mode>("office");
  // UX-5A: on a day of approved leave the check-in asks first; it never cancels the leave silently.
  const { open: askOpen, setOpen: setAskOpen, anchor: askAnchor, close: closeAsk } = usePopoverState();
  // Ctrl+K's "Check in" on a day the header control does not show (approved leave) lands here and asks about the leave.
  useDoParam(canAct ? "check-in" : undefined, (p) => { const m = p.get("mode"); if (m === "office" || m === "wfh" || m === "field") setMode(m); if (now.state === "leave" && !now.entry) setAskOpen(true); });
  const [surfaceAction, setSurfaceAction] = useState<"check-in" | "check-out" | null>(null);
  useEffect(() => {
    const native = attendanceShell();
    if (!native || !personId || !canAct || attendanceEnabled !== true) return;
    let active = true;
    const take = () => {
      if (document.visibilityState !== "visible") return;
      void native.takeAction({ personId }).then(r => {
        if (active && r.personId === personId && (r.action === "check-in" || r.action === "check-out")) setSurfaceAction(r.action);
      }).catch(() => {});
    };
    take(); window.addEventListener("online", take); document.addEventListener("visibilitychange", take);
    return () => { active = false; window.removeEventListener("online", take); document.removeEventListener("visibilitychange", take); };
  }, [personId, canAct, attendanceEnabled]);
  const entry = now.entry; const open = !!entry && !entry.out;
  // Minutes worked so far tick on the screen; the server's figure is the starting point.
  const worked = entry?.worked ?? 0; const [tick, setTick] = useState({ from: worked, minutes: 0 });
  useEffect(() => {
    if (attendanceEnabled !== true || !open || entry?.onBreak) return;
    const started = Date.now(); const timer = window.setInterval(() => setTick({ from: worked, minutes: Math.floor((Date.now() - started) / 60000) }), 15000);
    return () => window.clearInterval(timer);
  }, [attendanceEnabled, open, entry?.onBreak, worked]);
  const extra = open && !entry?.onBreak && tick.from === worked ? tick.minutes : 0;
  const state = now.state; const earlier = open && entry.date !== today;
  // EST-1196: on a break the card says so with the break's own clock (from the day the header already reads).
  const day = useCompanionDay();
  const live = personId && !name && day.payload?.person.id === personId && day.payload.entry ? day.payload.entry : null;
  const [breakAt, setBreakAt] = useState<number | null>(null);
  useEffect(() => {
    if (state !== "break" || !live) return;
    const t = () => setBreakAt(Date.now()); const first = window.setTimeout(t, 0), timer = window.setInterval(t, 15000);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [state, live]);
  const breakClock = state === "break" && live && breakAt !== null ? hm(liveSeconds(live, breakAt + day.offset).onBreak) : null;
  // EST-1196: on a phone's My desk this card is the one attendance control (the header's copy steps aside).
  const own = canAct && !!personId && !name && attendanceEnabled === true;
  // CTO review: while this card is the person's own control, Pip's menu, the island's nudges and Ctrl+K act through it
  // (the header chip leaves them to it), so a queued tap, "not saved" and Try again show here, where the person looks.
  const actRef = useRef<(id: ActionId, how?: Mode) => void>(() => {});
  useEffect(() => {
    actRef.current = (id, how) => {
      if (id === "check-in") {
        // CTO review: the place the shortcut chose (home, on duty) is kept before the leave question, so either answer sends it.
        if (how) setMode(how);
        if (state === "leave" && !entry) { setAskOpen(true); return; }
        void run("attendance/check-in", { mode: how ?? mode }, "Checked in", "attendance", day.payload?.arrival && state === "out" ? "suggested" : undefined);
      } else if (id === "check-out") void run("attendance/check-out", {}, "Checked out", "attendance");
      else void run("attendance/break", { action: id === "break-end" ? "end" : "start" }, id === "break-end" ? "Back from the break" : "Break started", "attendance");
    };
  });
  useEffect(() => {
    if (!own) return;
    const take = (event: Event) => { const d = (event as CustomEvent<{ id?: ActionId; mode?: Mode; handled?: boolean }>).detail; if (!d?.id || d.handled) return; d.handled = true; actRef.current(d.id, d.mode); };
    window.addEventListener("pulse:checkin-act", take);
    return () => window.removeEventListener("pulse:checkin-act", take);
  }, [own]);
  useEffect(() => {
    if (!own) return;
    document.documentElement.dataset.todayCard = "";
    return () => { delete document.documentElement.dataset.todayCard; };
  }, [own]);
  const title = state === "in" ? (name ? `${name} is checked in` : "You are checked in") : state === "break" ? (breakClock ? `On break · ${breakClock}` : "On break") : state === "done" ? "Done for today"
    : state === "leave" ? "On leave today" : state === "holiday" ? (now.holiday ?? "Holiday") : state === "off" ? "Weekly off" : "Not checked in yet";
  const wfhLeft = wfh.allowance === null ? null : Math.max(0, wfh.allowance - wfh.used);
  if (attendanceEnabled !== true) return null;
  return (
    <section className={css.today} data-state={state} data-compact={compact ? "" : undefined} aria-label="Today">
      {/* Pip lives here on phones and in the Pulse app (no floating bot over the page). */}
      {name || compact ? null : <span className={css.todayPip} aria-hidden="true" dangerouslySetInnerHTML={{ __html: pipSvg({ mood: state === "in" ? "in" : state === "break" ? "break" : state === "done" ? "done" : "idle", size: 52, uid: "today", still: true }) }} />}
      <div className={css.todayMain}>
        <span className={css.todayEyebrow}><i className={css.pulse} data-state={state} />{longDay(today)} · shift {policy.shiftStart} to {policy.shiftEnd}</span>
        <h3 className={css.todayTitle}>{title}</h3>
        {entry ? (
          <p className={css.todayLine}>
            <span>In at <b>{time(entry.in)}</b>{earlier ? ` on ${dayYear(entry.date)}` : ""}</span>
            {entry.out ? <span>Out at <b>{time(entry.out)}</b></span> : null}
            <span><b>{duration(entry.worked + extra)}</b> worked{open ? " so far" : ""}</span>
            {entry.breakMinutes ? <span>{duration(entry.breakMinutes)} on breaks</span> : null}
            <Badge>{MODE[entry.mode]}</Badge>
            {/* POLISH-2 (QA-E2E P1-12): a check-in after the shift ended is work after hours, not "late by 10 h". */}
            {entry.late && policy.shiftEnd > policy.shiftStart && time(entry.in) >= policy.shiftEnd ? <Badge>After the shift</Badge>
              : entry.late ? <Badge tone="warning">Late by {duration(entry.late)}</Badge> : null}
            {now.leaveCheckIn ? <Badge tone={now.leaveCheckIn.decision === "kept" ? "warning" : undefined}>{now.leaveCheckIn.decision === "kept" ? "On leave · HR decides" : "Today’s leave cancelled"}</Badge> : null}
          </p>
        ) : (
          <p className={css.todayLine}>{state === "out" ? <span>{name ? `No check-in today so far. The shift starts at ${policy.shiftStart}.` : clock > policy.shiftStart ? `A check-in after ${addMinutes(policy.shiftStart, policy.graceMinutes)} counts as late.` : `Check in by ${addMinutes(policy.shiftStart, policy.graceMinutes)} to be on time.`}</span>
            : state === "outcome" ? <span>{name ? "Outcome-based: no check-in needed. Their time comes from work." : "You are outcome-based: no check-in needed. Log time on your tasks, or confirm what Pulse proposes from your work."}</span>
            : state === "leave" ? <span>{name ? "Approved leave covers today." : "Approved leave today. Working after all? Check in and Pulse asks about the leave."}</span> : <span>{name ? "Not a working day." : <>Working anyway? <a href="/me?tab=attendance">Ask first in Attendance</a>, then check in once it is approved.</>}</span>}</p>
        )}
      </div>
      {canAct ? (
        <div className={css.todayActions}>
          {!entry || entry.out ? <>
            {!entry ? <div suppressHydrationWarning className={styles.segmented} role="group" aria-label="Where you are working">
              {(Object.keys(MODE) as Mode[]).map((m) => { const Icon = MODE_ICON[m]; return <button key={m} type="button" className={styles.segment} aria-current={mode === m ? "true" : undefined} title={MODE[m]} onClick={() => setMode(m)}><Icon size={13} aria-hidden="true" />{m === "office" ? "Office" : m === "wfh" ? "Home" : "On duty"}</button>; })}
            </div> : null}
            <button ref={askAnchor} type="button" className={`${styles.btn} ${styles.btnPrimary} ${css.bigBtn}`} disabled={busy || state === "off" || state === "holiday"} aria-haspopup={state === "leave" && !entry ? "dialog" : undefined}
              onClick={() => state === "leave" && !entry ? setAskOpen(true) : run("attendance/check-in", { mode }, entry ? "Welcome back. The time away is recorded as a break." : "Checked in", "attendance")}>
              <LogIn size={15} aria-hidden="true" />{say("check-in", entry ? "Check in again" : "Check in")}</button>
            <Popover open={askOpen} onClose={closeAsk} anchor={askAnchor} label="You’re on leave today" placement="bottom-end" sheet>
              <div className={css.leaveAsk}>
                <b>You’re on leave today.</b><span>Cancel the leave and check in?</span>
                <div className={css.leaveAskButtons}>
                  <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} data-autofocus="" onClick={() => { closeAsk(); void run("attendance/check-in", { mode, leave: "cancel" }, "Checked in · today’s leave cancelled, HR told", "attendance"); }}>Cancel today’s leave and check in</button>
                  <button type="button" className={styles.btn} onClick={() => { closeAsk(); void run("attendance/check-in", { mode }, "Checked in · your leave stays until HR decides", "attendance"); }}>Check in, keep the leave</button>
                </div>
                <small>Keeping it sends the day to HR to decide. Only today changes; other leave days stay.</small>
              </div>
            </Popover>
            {/* Always there, so choosing a place never moves the buttons. */}
            {!entry ? <span className={css.todayHint}>{mode === "wfh" ? (wfhLeft === null ? "Counts as a day worked from home" : wfhLeft ? `${wfhLeft} of ${wfh.allowance} work-from-home days left this month` : `This month's ${wfh.allowance} work-from-home days are used; this one will show as extra`) : mode === "field" ? "On duty outside the office, such as a shoot or a client visit" : "Counts as a day in the office"}</span> : null}
            {/* The phone app's office check (it shows only inside the app) stays in the compact card too. */}
            {!entry && mode === "office" && !name ? <OfficeCheck /> : null}
          </> : <>
            {entry.onBreak ? <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${css.bigBtn}`} disabled={busy} onClick={() => run("attendance/break", { action: "end" }, "Back from the break", "attendance")}><Play size={15} aria-hidden="true" />{say("break-end", "End break")}</button>
              : <button type="button" className={`${styles.btn} ${css.bigBtn}`} disabled={busy} onClick={() => run("attendance/break", { action: "start" }, "Break started", "attendance")}><Coffee size={15} aria-hidden="true" />{say("break-start", "Break")}</button>}
            <button type="button" className={`${styles.btn} ${css.bigBtn}`} disabled={busy} onClick={() => run("attendance/check-out", {}, "Checked out", "attendance")}><LogOut size={15} aria-hidden="true" />{say("check-out", "Check out")}</button>
          </>}
          {surfaceAction ? <div role="group" aria-label="Confirm attendance shortcut" style={{ flexBasis: "100%" }}>
            <p>{surfaceAction === "check-in" ? "Confirm check-in using the work location selected above." : "Done for the day? Confirm check-out."} The time of your confirmation is saved; Pulse must accept it before attendance changes.</p>
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || (surfaceAction === "check-in" && (state === "off" || state === "holiday"))} onClick={() => { const action = surfaceAction; setSurfaceAction(null); void recovery.act(action, mode); }}>Confirm {surfaceAction === "check-in" ? "check-in" : "check-out"}</button>
            <button type="button" className={styles.btn} onClick={() => setSurfaceAction(null)}>Cancel shortcut</button>
          </div> : null}
          {recovery.receipts}
        </div>
      ) : null}
    </section>
  );
}
const addMinutes = (hhmm: string, minutes: number) => { const total = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) + minutes; return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; };

/** A button that opens a form in a dialog and posts it. */
function FormDialog({ label, title, icon, variant, small, path, build, done, submit = "Send", note, help, context, openOn, children }: {
  label: ReactNode; title: string; icon?: ReactNode; variant?: "primary" | "ghost"; small?: boolean; path: string;
  build: (data: FormData) => Record<string, unknown>; done: string; submit?: string; note?: ReactNode; help?: ReactNode; context?: ReactNode;
  /** UX-5A: opens by itself when the page is opened with `?do=<openOn>` (Ctrl+K's actions). */ openOn?: string; children: ReactNode;
}) {
  const router = useRouter(); const formId = useId(); const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useDoParam(openOn, () => { setError(""); setOpen(true); });
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try { await post(path, build(new FormData(event.currentTarget))); setOpen(false); notify({ id: path, tone: "success", title: done, timeout: 3000 }); router.refresh(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <>
    <button type="button" className={`${styles.btn}${variant === "primary" ? ` ${styles.btnPrimary}` : variant === "ghost" ? ` ${styles.btnGhost}` : ""}${small ? ` ${styles.btnSmall}` : ""}`} onClick={() => { setError(""); setOpen(true); }}>{icon}{label}</button>
    {open ? (
      <Modal title={title} help={help} context={context} onClose={() => setOpen(false)} foot={<DrawerFooter status={error}><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(false)}>Cancel</button><button form={formId} className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Sending…" : submit}</button></DrawerFooter>}>
        {/* UX-5A: the drawer's body pads and scrolls; a live line (a balance, a rule) sits under the fields, explanations behind "?". */}
        <form id={formId} className={styles.modalBody} onSubmit={send}>{children}{note ? <p className={styles.modalNote}>{note}</p> : null}</form>
      </Modal>
    ) : null}
  </>;
}

/** Apply for leave: type, dates, an optional half day and the reason. The balance of the chosen type shows as you pick. */
export function ApplyLeave({ types, balances, today, variant = "primary", autoOpen = true }: { types: LeaveType[]; balances: Balance[]; today: string; variant?: "primary" | "ghost";
  /** Opens with `?do=apply-leave` (one instance per page should). */ autoOpen?: boolean }) {
  const [kind, setKind] = useState(types[0]?.key ?? ""); const [from, setFrom] = useState(today); const [to, setTo] = useState(today);
  const balance = balances.find((b) => b.key === kind); const type = types.find((t) => t.key === kind);
  const [notice,setNotice]=useState<{required:number;given:number;unit:string;late:boolean}|null>(null);
  const [emergencies,setEmergencies]=useState<{id:string;fromDate:string;returnDate:string;recordBy:string;leaveId:string|null}[]>([]);
  const [halfDay,setHalfDay]=useState('');
  useEffect(()=>{const abort=new AbortController();fetch(`/api/v0/leave/notice?from=${from}&to=${to}&kind=${kind}&half=${halfDay}`,{signal:abort.signal}).then(r=>r.ok?r.json():null).then(d=>setNotice(d?.flag??null)).catch(()=>{});return()=>abort.abort();},[from,to,kind,halfDay]);
  useEffect(()=>{fetch('/api/v0/leave/emergencies').then(r=>r.ok?r.json():null).then(d=>setEmergencies(d?.rows??[])).catch(()=>{});},[]);
  return (
    <FormDialog label="Apply for leave" title="Apply for leave" icon={<Plus size={14} aria-hidden="true" />} variant={variant} path="leave" openOn={autoOpen ? "apply-leave" : undefined} done="Leave request sent for approval" submit="Send request"
      build={(d) => ({ kind: d.get("kind"), fromDate: d.get("fromDate"), toDate: d.get("toDate"), halfDay: d.get("halfDay") || undefined, reason: d.get("reason"), special: d.get("special") === "on",emergencyId:d.get("emergencyId")||undefined })}
      note={<>Weekly offs and holidays inside the dates are not counted. {type ? (balance ? <>You have <b>{dayCount(balance.available - balance.pending)}</b> of {type.name.toLowerCase()} free{balance.pending ? ` (${dayCount(balance.pending)} more waiting for a decision)` : ""}.</> : <>{type.name} has no fixed allowance{type.paid ? "" : " and is not paid"}.</>) : null}</>}>
      {/* Each leave type is one tap and shows what is free, so nobody has to open a list or guess a balance. */}
      <fieldset className={`${styles.field} ${styles.wide} ${css.kinds}`}><legend>Leave type</legend>
        <div className={css.kindGrid}>{types.map((t) => { const b = balances.find((x) => x.key === t.key); const free = b ? b.available - b.pending : null; return (
          <label key={t.key} className={css.kind} data-on={kind === t.key ? "" : undefined}>
            <input type="radio" name="kind" value={t.key} checked={kind === t.key} onChange={() => setKind(t.key)} required />
            <b>{t.name}</b><small>{free === null ? "As needed" : `${dayCount(Math.max(0, free))} free`}{t.paid ? "" : " · unpaid"}</small>
          </label>); })}</div>
      </fieldset>
      <label className={styles.field}>From<input type="date" name="fromDate" value={from} onChange={(event) => { setFrom(event.target.value); if (event.target.value > to) setTo(event.target.value); }} required /></label>
      <label className={styles.field}>To<input type="date" name="toDate" value={to} min={from} onChange={(event) => setTo(event.target.value)} required /></label>
      {from === to ? <label className={`${styles.field} ${styles.wide}`}>How much of the day<select name="halfDay" value={halfDay} onChange={e=>setHalfDay(e.target.value)}><option value="">The whole day</option><option value="first">First half only</option><option value="second">Second half only</option></select></label> : null}
      {notice?<p role="status">Apply at least {notice.required} {notice.unit} ahead. {notice.late?`This request gives ${Math.max(0,notice.given)} ${notice.unit}; you can still apply and the approver sees the shortfall.`:'This request meets the advance-notice rule.'}</p>:null}
      {emergencies.some(e=>!e.leaveId)?<label className={styles.field}>Record notified emergency<select name="emergencyId" defaultValue=""><option value="">Ordinary application</option>{emergencies.filter(e=>!e.leaveId).map(e=><option key={e.id} value={e.id}>{e.fromDate} · returned {e.returnDate} · due {e.recordBy}</option>)}</select></label>:null}
      <label className={`${styles.field} ${styles.wide}`}>Reason<textarea name="reason" required minLength={3} maxLength={500} placeholder="A line for the person approving. Your pod head and HR can read it." /></label>
      <label className={styles.field}><span><input type="checkbox" name="special"/> Special or emergency leave (needs HR)</span></label>
    </FormDialog>
  );
}

/** Ask for a day's attendance to be corrected, or (HR) record a day for someone. */
export function Regularise({ today, date, entryId, kind = "missed_punch", personId, personName, label, small, variant }: { today: string; date?: string; entryId?:string; kind?: RegKind; personId?: string; personName?: string; label?: string; small?: boolean; variant?: "primary" | "ghost" }) {
  const [what, setWhat] = useState<RegKind>(kind), [day, setDay] = useState(date ?? today); const times = what === "missed_punch";
  return (
    <FormDialog label={label ?? "Request a correction"} title={personName ? `Record attendance for ${personName}` : "Request an attendance correction"} variant={variant} small={small}
      icon={personId ? undefined : <PencilLine size={14} aria-hidden="true" />}
      path="hr/regularisations" done={personId ? "Filed: someone else in HR or leadership approves it" : "Request sent for approval"} submit={personId ? "File for approval" : "Send request"}
      build={(d) => ({ personId, entryId, kind: what, date: d.get("date"), inTime: d.get("inTime") || undefined, outTime: d.get("outTime") || undefined, reason: d.get("reason") })}
      note={personId ? "Filed for them, it waits for someone other than you to approve it; then the day is updated and marked as corrected." : "Your manager or HR decides. Once approved, the day is updated and marked as corrected."}>
      {/* UX-5A: the kit's list and day picker (the form still posts the day as "date"). */}
      <div className={`${styles.kitField} ${styles.wide}`}><span>What needs correcting</span><Select label="What needs correcting" value={what} onChange={(v) => { if (v) setWhat(v as RegKind); }}
        options={(Object.keys(REG_KIND) as RegKind[]).filter((k) => !personId || k !== "late").map((k) => ({ value: k, label: REG_KIND[k] }))} /></div>
      <div className={`${styles.kitField} ${times ? "" : styles.wide}`}><span>Day</span><DatePicker label="Day" value={{ date: day, time: null }} today={today} max={times || what === "late" ? today : undefined}
        onChange={(v) => { if (v.date) setDay(v.date); }} /><input type="hidden" name="date" value={day} /></div>
      {times ? <span /> : null}
      {what !== "late" ? <>
        <label className={styles.field}>Started at{times ? "" : " (optional)"}<input type="time" name="inTime" /></label>
        <label className={styles.field}>Finished at{times ? "" : " (optional)"}<input type="time" name="outTime" /></label>
      </> : null}
      <label className={`${styles.field} ${styles.wide}`}>Reason<textarea name="reason" required minLength={5} maxLength={500} placeholder={what === "late" ? "Why the late mark should not count" : what === "missed_punch" ? "What happened, e.g. forgot to check out after the shoot" : "Where you are working and why"} /></label>
    </FormDialog>
  );
}

/** Approve or reject a leave or correction request. Rejecting asks for a line of explanation. */
export function Decide({ kind, id, name }: { kind: "leave" | "regularisation"; id: string; name?: string }) {
  const { busy, run } = useAction(); const path = kind === "leave" ? `leave/${id}/decision` : `hr/regularisations/${id}`;
  return <span className={styles.inline}>
    <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={busy} onClick={() => run(path, { decision: "approved" }, name ? `Approved for ${name}` : "Approved", `decide:${id}`)}><Check size={12} aria-hidden="true" />Approve</button>
    <FormDialog label="Reject" icon={<X size={12} aria-hidden="true" />} title={name ? `Reject ${name}'s request` : "Reject this request"} small path={path} done="Rejected" submit="Reject" build={(d) => ({ decision: "rejected", note: d.get("note") })}
      note="The person sees this note with the decision.">
      <label className={`${styles.field} ${styles.wide}`}>Why<textarea name="note" required minLength={3} maxLength={300} placeholder="e.g. Two people from the pod are already away that week" /></label>
    </FormDialog>
  </span>;
}

/** Withdraw your own waiting request, or cancel approved leave that has not started. */
export function Withdraw({ kind, id, label = "Withdraw" }: { kind: "leave" | "regularisation"; id: string; label?: string }) {
  const { busy, run } = useAction();
  return <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => { if (window.confirm(`${label} this request?`)) run(kind === "leave" ? `leave/${id}/decision` : `hr/regularisations/${id}`, { decision: "cancelled" }, "Request withdrawn", `decide:${id}`); }}><X size={12} aria-hidden="true" />{label}</button>;
}

/** Raise a request with HR: a question, a problem or a grievance. */
export function NewTicket({ categories, variant = "primary", autoOpen = true }: { categories: string[]; variant?: "primary" | "ghost"; autoOpen?: boolean }) {
  // UX-5A: the kit's list and segments (no browser selects); who reads it sits behind "?".
  const [category, setCategory] = useState("other"), [priority, setPriority] = useState("normal");
  return (
    <FormDialog label="Raise a request" title="Raise a request with HR" icon={<Plus size={14} aria-hidden="true" />} variant={variant} path="hr/tickets" done="Sent to HR" submit="Send to HR" openOn={autoOpen ? "new-request" : undefined}
      build={(d) => ({ category, subject: d.get("subject"), body: d.get("body"), priority })}
      help="Only you, HR and organisation admins can read it. Every reply and the resolution show here.">
      <div className={styles.kitField}><span>About</span><Select label="About" value={category} onChange={(v) => setCategory(v ?? "other")} options={categories.map((c) => ({ value: c, label: CATEGORY[c] ?? c }))} /></div>
      <div className={styles.kitField}><span>How urgent</span><Segmented label="How urgent" value={priority} onChange={setPriority} fill options={[{ value: "low", label: "Can wait" }, { value: "normal", label: "Normal" }, { value: "high", label: "Urgent" }]} /></div>
      <label className={`${styles.field} ${styles.wide}`}>In a few words<input name="subject" required minLength={3} maxLength={140} placeholder="e.g. September salary slip is missing" autoComplete="off" /></label>
      <label className={`${styles.field} ${styles.wide}`}>Details<textarea name="body" maxLength={4000} placeholder="What happened, since when, and what you need" /></label>
    </FormDialog>
  );
}

/** Reply on a request; HR can also leave a note only HR and admins see. */
export function TicketReply({ id, staff, closed }: { id: string; staff: boolean; closed: boolean }) {
  const { busy, run } = useAction(); const [text, setText] = useState(""); const [internal, setInternal] = useState(false);
  async function send(event: FormEvent) { event.preventDefault(); if (text.trim() && await run(`hr/tickets/${id}`, { comment: text, internal }, internal ? "Note added" : "Reply sent", `ticket:${id}`)) setText(""); }
  return (
    <form className={css.reply} onSubmit={send}>
      <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={4000} placeholder={closed ? "Add a comment…" : staff ? "Reply to the person, or add a note…" : "Reply to HR…"} aria-label="Reply" />
      <div className={css.replyFoot}>
        {staff ? <label className={css.check}><input type="checkbox" checked={internal} onChange={(event) => setInternal(event.target.checked)} />Note for HR and admins only</label> : <span />}
        <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !text.trim()}>{internal ? "Add note" : "Send reply"}</button>
      </div>
    </form>
  );
}

/** HR: assign a request, set its priority and move it along; resolving asks how it was resolved. The raiser can close or reopen. */
export function TicketControls({ id, status, priority, assigneeId, assignees, staff, mine }: { id: string; status: TicketStatus; priority: string; assigneeId: string | null; assignees: { id: string; name: string }[]; staff: boolean; mine: boolean }) {
  const { busy, run } = useAction(); const done = status === "resolved" || status === "closed";
  if (!staff) return mine ? <button type="button" className={styles.btn} disabled={busy} onClick={() => run(`hr/tickets/${id}`, { status: done ? "open" : "closed" }, done ? "Reopened" : "Closed", `ticket:${id}`)}>{done ? "Reopen request" : "Close request"}</button> : null;
  return (
    <div className={css.controls}>
      <label className={styles.field}>Assigned to<select value={assigneeId ?? ""} disabled={busy} onChange={(event) => run(`hr/tickets/${id}`, { assigneeId: event.target.value || null }, "Assignment saved", `ticket:${id}`)}><option value="">Nobody yet</option>{assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label className={styles.field}>Priority<select value={priority} disabled={busy} onChange={(event) => run(`hr/tickets/${id}`, { priority: event.target.value }, "Priority saved", `ticket:${id}`)}><option value="low">Can wait</option><option value="normal">Normal</option><option value="high">Urgent</option></select></label>
      <label className={styles.field}>Status<select value={status} disabled={busy} onChange={(event) => { if (event.target.value !== "resolved") run(`hr/tickets/${id}`, { status: event.target.value }, "Status saved", `ticket:${id}`); }}>
        <option value="open">Open</option><option value="in_progress">In progress</option><option value="waiting">Waiting for the person</option>{status === "resolved" ? <option value="resolved">Resolved</option> : null}<option value="closed">Closed</option></select></label>
      {done ? null : <FormDialog label="Resolve" title="Resolve this request" variant="primary" icon={<Check size={14} aria-hidden="true" />} path={`hr/tickets/${id}`} done="Resolved" submit="Mark resolved" build={(d) => ({ status: "resolved", resolution: d.get("resolution") })}
        note="The person who raised it reads this and can reopen the request if it is not solved.">
        <label className={`${styles.field} ${styles.wide}`}>How it was resolved<textarea name="resolution" required minLength={3} maxLength={1000} /></label>
      </FormDialog>}
    </div>
  );
}

/** Add, remove or change skills as chips. The person edits their own; HR and admins edit anyone's. */
export function SkillsEditor({ personId, skills, canEdit }: { personId: string; skills: string[]; canEdit: boolean }) {
  const { busy, run } = useAction(); const [draft, setDraft] = useState("");
  const save = (next: string[]) => run(`people/${personId}/self`, { skills: next }, "Skills saved", "skills");
  async function add(event: FormEvent) {
    event.preventDefault();
    // UI-UPGRADE: Add is never a greyed-out button; with nothing typed it points at the field.
    if (!draft.trim()) { (event.currentTarget as HTMLFormElement).querySelector("input")?.focus(); return; }
    const fresh = draft.split(",").map((s) => s.trim()).filter((s) => s && !skills.some((k) => k.toLowerCase() === s.toLowerCase()));
    if (fresh.length && await save([...skills, ...fresh])) setDraft("");
  }
  return (
    <div className={css.skills}>
      {skills.length ? skills.map((s) => <span key={s} className={css.skill}>{s}{canEdit ? <button type="button" aria-label={`Remove ${s}`} disabled={busy} onClick={() => save(skills.filter((k) => k !== s))}><X size={11} aria-hidden="true" /></button> : null}</span>)
        : <span className={styles.muted}>{canEdit ? "No skills listed yet. Add them here, so the right work finds the right person." : "No skills listed yet."}</span>}
      {canEdit ? <form className={css.skillAdd} onSubmit={add}><input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={80} placeholder="Add a skill, e.g. Premiere Pro" aria-label="Add a skill" /><button className={`${styles.btn} ${styles.btnSmall}`} disabled={busy}><Plus size={12} aria-hidden="true" />Add</button></form> : null}
    </div>
  );
}

export function EmergencyLeave({today}:{today:string}) {
 const [rule,setRule]=useState<{config:{notifyHours:number;recordWorkingDays:number}}|null>(null);
 useEffect(()=>{fetch('/api/v0/leave/emergencies').then(r=>r.ok?r.json():null).then(d=>setRule(d?.rule??null)).catch(()=>{});},[]);
 if(!rule)return null;
 return <FormDialog label="Emergency: notify pod head now" title="Notify emergency leave" path="leave/emergency" done="Pod head notified in Pulse" submit="Notify pod head now" build={d=>Object.fromEntries(d)} note={`Notify within ${rule.config.notifyHours} hours of your shift start. Record the leave within ${rule.config.recordWorkingDays} working days after return. This alerts inside Pulse.`}>
  <label className={styles.field}>Leave starts<input type="date" name="fromDate" defaultValue={today} required/></label><label className={styles.field}>Return to work<input type="date" name="returnDate" min={today} required/></label><label className={styles.field}>Reason<textarea name="reason" required minLength={3} maxLength={500}/></label>
 </FormDialog>;
}
