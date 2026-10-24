"use client";
// ATT (21 Oct 2026): HR desk → Time → Attendance → To check. Pulse settles confident days by itself; HR sees only the
// days it could not (no check-out and no signal, a question nobody answered, breaks beyond the allowance) and the
// check-out proposals Pulse once made by mistake. Each shows what Pulse saw and when, with one tap: Confirm, Fix the
// time they left, or Dismiss. Corrections people asked for stay in Approvals (counted here).
import Link from "next/link";
import { CircleCheck, Coffee, LogOut, MapPin, MessageCircleQuestion, Undo2, Wifi } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { notify } from "@pulse/ui-shell";
import { longDay, plural } from "../../lib/format";
import { Avatar, Badge, Empty, Panel, styles } from "../../ui";
import css from "../desk.module.css";

type Moment = { kind: string; at: string; clock: string; signals: string[] | null; detail: string | null };
type Exception = { id: string; personId: string; name: string; date: string; kind: "missing_checkout" | "unanswered" | "long_break" | "conflict" | "correction" | "stale_proposal";
  summary: string; evidence: Record<string, unknown>; inClock: string | null; outClock: string | null; inVia: string | null; outVia: string | null; timeline: Moment[] };
type Stale = { id: string; personId: string; name: string; date: string; outTime: string; inTime: string | null };
type Data = { attendanceEnabled: boolean; open: Exception[]; stale: Stale[]; counts: { open: number; settled: number; corrections: number } };

const KIND: Record<Exception["kind"], { label: string; tone: "warning" | "accent" | "neutral" }> = {
  missing_checkout: { label: "No check-out", tone: "warning" }, unanswered: { label: "No answer", tone: "warning" }, long_break: { label: "Long breaks", tone: "accent" },
  conflict: { label: "Signals disagree", tone: "warning" }, correction: { label: "Correction", tone: "neutral" }, stale_proposal: { label: "Pulse's mistake", tone: "neutral" },
};
// What Pulse saw, in words (signal kinds only: never a place).
const SIGNAL: Record<string, string> = { wifi: "office Wi-Fi", geofence: "phone at the office", network: "office network", laptop: "laptop in use", phone: "Pulse open on the phone", schedule: "reminder", hr: "HR" };
const MOMENT: Record<string, string> = { arrival_asked: "Asked “Check in?”", auto_check_in: "Checked in by itself", break_detected: "Away and back: a break", auto_check_out: "Checked out by itself",
  asked: "Asked once", answered: "They answered", closed_for_review: "Held for review", left_office: "Left the office", correction_proposed: "Proposed a check-out", nudge: "HR nudged" };
const signals = (s: unknown) => Array.isArray(s) && s.length ? s.map((x) => SIGNAL[String(x)] ?? String(x)).join(" + ") : "no signal";

function Evidence({ x }: { x: Exception }) {
  const e = x.evidence as { reason?: string; signals?: string[]; lastSeen?: string | null; lastActivity?: string | null };
  return (
    <div className={css.attEvidence}>
      <p><span>In {x.inClock ?? "—"}{x.inVia === "auto" ? " (by itself)" : ""}</span>{" · "}<span>Out {x.outClock ?? "not recorded"}{x.outVia === "auto" ? " (by itself)" : e.reason === "day_ended" ? " (held for review)" : ""}</span></p>
      <p className={styles.muted}>{e.signals && e.signals.length ? <><Wifi size={12} aria-hidden="true" /> Seen by {signals(e.signals)}</> : <><MapPin size={12} aria-hidden="true" /> No device saw them at the office</>}</p>
      {x.timeline.length ? <ol className={css.attTimeline} aria-label="What Pulse noticed">{x.timeline.map((m, i) => <li key={i}><time>{m.clock}</time>{MOMENT[m.kind] ?? m.kind}{m.signals?.length ? ` · ${signals(m.signals)}` : ""}</li>)}</ol> : null}
    </div>
  );
}

function Row({ x, onDone }: { x: Exception; onDone: () => void }) {
  const [fixing, setFixing] = useState(false), [time, setTime] = useState(x.outClock ?? ""), [busy, setBusy] = useState(""), [error, setError] = useState("");
  async function act(action: "confirm" | "fix" | "dismiss") {
    setBusy(action); setError("");
    try {
      const r = await fetch(`/api/v0/hr/attendance/exceptions/${x.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action === "fix" ? { action, outTime: time } : { action }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "That did not work. Try again.");
      notify({ id: `att-${x.id}`, tone: "success", title: action === "confirm" ? `${x.name.split(" ")[0]}’s day confirmed` : action === "fix" ? `Check-out set to ${time}` : "Dismissed" });
      onDone();
    } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  }
  const k = KIND[x.kind];
  return (
    <li className={css.attException} data-kind={x.kind}>
      <Link href={`/people/${x.personId}?tab=attendance`} className={css.whoPerson}><Avatar name={x.name} id={x.personId} size={28} /><span><span className={css.whoName}>{x.name}</span><span className={css.whoSub}>{longDay(x.date)}</span></span></Link>
      <div className={css.attBody}><p className={css.attHead}><Badge tone={k.tone}>{k.label}</Badge><span>{x.summary}</span></p><Evidence x={x} /></div>
      <div className={css.attActions}>
        {fixing ? <form onSubmit={(e) => { e.preventDefault(); void act("fix"); }} className={css.attFix}>
          <label>Left at<input type="time" value={time} onChange={(e) => setTime(e.target.value)} required /></label>
          <button type="submit" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} disabled={!!busy || !time}>{busy === "fix" ? "Saving…" : "Save"}</button>
          <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} onClick={() => setFixing(false)}>Cancel</button>
        </form> : <>
          {x.kind !== "long_break" ? <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} disabled={!!busy} onClick={() => void act("confirm")}><CircleCheck size={14} aria-hidden="true" />{x.outClock ? `Confirm ${x.outClock}` : "Confirm"}</button> : null}
          {x.kind !== "long_break" ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!!busy} onClick={() => setFixing(true)}><LogOut size={14} aria-hidden="true" />Fix time</button> : null}
          <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} disabled={!!busy} onClick={() => void act("dismiss")}>{x.kind === "long_break" ? "Seen" : "Dismiss"}</button>
        </>}
        {error ? <p role="alert" className={css.attError}>{error}</p> : null}
      </div>
    </li>
  );
}

export function AttendanceExceptions({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/v0/hr/attendance/exceptions", { cache: "no-store" }); const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Not available"); setData(d as Data); setError("");
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => {
    let live = true;
    void fetch("/api/v0/hr/attendance/exceptions", { cache: "no-store" }).then(async (r) => { const d = await r.json(); if (!live) return; if (r.ok) setData(d as Data); else setError(d.error ?? "Not available"); }).catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, []);
  async function withdraw() {
    setBusy(true);
    try {
      const r = await fetch("/api/v0/hr/attendance/exceptions/stale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "withdraw" }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Could not withdraw them");
      notify({ id: "att-stale", tone: "success", title: `${plural(d.withdrawn ?? 0, "proposal")} withdrawn`, message: "Their approval requests and reminders are gone too." });
      await load();
    } catch (e) { notify({ id: "att-stale", tone: "error", title: (e as Error).message }); } finally { setBusy(false); }
  }
  if (error) return compact ? null : <Panel title="To check"><p role="alert">{error}</p></Panel>;
  if (!data) return compact ? null : <Panel title="To check" sub="Loading…"><div className={css.attSkeleton} aria-busy="true" /></Panel>;
  if (!data.attendanceEnabled) return null;
  const waiting = data.open.length + (data.stale.length ? 1 : 0);
  if (compact) return (
    <Link href="/hr?tab=attendance&view=check" className={css.attCompact} data-waiting={waiting ? "" : undefined}>
      <span className={css.attCompactIcon} aria-hidden="true">{waiting ? <MessageCircleQuestion size={18} /> : <CircleCheck size={18} />}</span>
      <span><b>{waiting ? `Attendance: ${plural(data.open.length + data.stale.length, "day")} to check` : "Attendance: nothing to check"}</b>
        <small>{plural(data.counts.settled, "day")} settled by themselves this week{data.counts.corrections ? ` · ${plural(data.counts.corrections, "correction")} asked for` : ""}</small></span>
    </Link>
  );
  return (
    <div className={css.attStack}>
      <Panel title="To check" sub={`${plural(data.counts.settled, "day")} this week settled by themselves: Pulse saw people arrive and leave, or they checked in and out.`}
        tools={data.counts.corrections ? <Link href="/hr?tab=approvals" className={styles.btn}>{plural(data.counts.corrections, "correction")} asked for</Link> : undefined}>
        {data.stale.length ? <div className={css.attStale}>
          <Undo2 size={18} aria-hidden="true" />
          <div><b>{plural(data.stale.length, "check-out proposal")} Pulse made by mistake</b>
            <p>An office departure from an earlier day made each new session look left at once: each proposes a check-out at its own check-in time ({data.stale.slice(0, 3).map((s) => `${s.name.split(" ")[0]}, ${longDay(s.date)}, ${s.outTime}`).join("; ")}{data.stale.length > 3 ? "; …" : ""}). Withdrawing them changes no times; their approvals and reminders go.</p></div>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void withdraw()}>{busy ? "Withdrawing…" : `Withdraw all ${data.stale.length}`}</button>
        </div> : null}
        {data.open.length ? <ul className={css.attList}>{data.open.map((x) => <Row key={x.id} x={x} onDone={() => void load()} />)}</ul>
          : !data.stale.length ? <Empty icon={Coffee} compact title="Nothing to check" text="Days Pulse could not settle by itself show here, with what it saw and one tap to confirm or fix." /> : null}
      </Panel>
    </div>
  );
}
