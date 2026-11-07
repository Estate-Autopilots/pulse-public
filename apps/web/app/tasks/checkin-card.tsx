"use client";
// ONBOARD-CHECKIN-TG (owner, 6 Nov 2026: check-in and check-out "especially for Estate Autopilots staff"): the day's card
// at the top of My day, in a company that uses attendance (the card is absent where attendance is off).
// * Not checked in: one big Check in (where you work: office, home, on duty), the on-time streak, the shift.
// * Checked in: today's timer ticking, Break and Check out.
// * Checked out: a short day summary (time worked, tasks done today) and, once a day, a small celebration
//   (lib/motion.ts burst; nothing moves under reduced motion).
// * Forgot: past the shift, or a check-out forgotten yesterday, the card says so plainly with the one fix.
// Taps go through the header's check-in control (pulse:checkin-act), so there is one saved queue and one set of rules
// (offline taps sync later, a double tap never checks in twice); without that control the card opens My desk.
import { CalendarCheck, Coffee, Flame, LogIn, LogOut, Play, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActionId, Mode } from "@pulse/companion";
import { checkinView, clock, words } from "../lib/checkin-view.mjs";
import { refreshDay, useCompanionDay } from "../lib/companion-day";
import { burst } from "../lib/motion";
import css from "./checkin-card.module.css";

const ICON = { "check-in": LogIn, "break-start": Coffee, "break-end": Play, "check-out": LogOut } as const;
const MODES: { id: Mode; label: string }[] = [{ id: "office", label: "Office" }, { id: "wfh", label: "Home" }, { id: "field", label: "On duty" }];
const pad = (n: number) => String(n).padStart(2, "0");
const timer = (s: number) => { const t = Math.max(0, Math.floor(s)); return `${Math.floor(t / 3600)}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`; };
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

export function CheckinCard({ personId, doneToday }: { personId: string; doneToday: number }) {
  const router = useRouter();
  const day = useCompanionDay();
  const p = day.payload && day.payload.person.id === personId ? day.payload : null;
  const [now, setNow] = useState(() => Date.now());
  const [mode, setMode] = useState<Mode | null>(null), [waiting, setWaiting] = useState<ActionId | null>(null);
  const card = useRef<HTMLElement>(null), button = useRef<HTMLButtonElement>(null);
  const view = checkinView(p, now + day.offset, [], {});
  const ticking = view.show && (view.state === "in" || view.state === "break");
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ticking ? 1000 : 30000);
    return () => window.clearInterval(t);
  }, [ticking]);
  // The day's small celebration: once, the first time this device sees the day done after a tap here.
  const state = view.show ? view.state : null;
  const wasWaiting = useRef<ActionId | null>(null);
  useEffect(() => { wasWaiting.current = waiting; }, [waiting]);
  useEffect(() => {
    if (!p || state !== "done" || wasWaiting.current !== "check-out") return;
    const key = `vitals.checkout.celebrated.${personId}.${p.today}`;
    if (read(key)) return;
    write(key, "1");
    burst(card.current?.querySelector("[data-summary]") ?? card.current, { big: false });
  }, [state, p, personId]);
  useEffect(() => { if (waiting && state && state !== "pending") { const t = window.setTimeout(() => setWaiting(null), 400); return () => window.clearTimeout(t); } }, [state, waiting]);

  if (!view.show || !p) return null;
  const chosen: Mode = mode ?? (p.shift.mode as Mode) ?? "office";
  function act(id: ActionId) {
    const detail: { id: ActionId; mode?: Mode; handled?: boolean } = { id, mode: chosen };
    setWaiting(id);
    window.dispatchEvent(new CustomEvent("pulse:checkin-act", { detail }));
    if (!detail.handled) { router.push("/me?tab=attendance"); return; }
    window.setTimeout(() => void refreshDay(), 1200);
  }
  const streak = p.streak?.onTime ?? 0;
  const week = p.week;
  const tone = view.state === "stale" || view.tone === "attention" ? "attention" : view.state === "done" ? "done" : view.state === "out" ? "action" : "live";
  const fix = view.fix;
  return (
    <section ref={card} className={css.card} data-tone={tone} aria-label="Today’s check-in" data-checkin-card="">
      <div className={css.top}>
        <span className={css.icon} aria-hidden="true"><CalendarCheck size={18} /></span>
        <div className={css.head}>
          <b>{view.state === "out" ? "Ready to start?" : view.state === "done" ? "Done for today" : view.state === "break" ? "On a break" : view.state === "stale" ? (fix?.closed ? "Check-out missing" : "Still checked in?") : view.state === "pending" ? "Saving…" : "You’re checked in"}</b>
          <small>{view.title}</small>
        </div>
        {streak > 1 ? <span className={css.streak} title={`${streak} working days in a row on time`}><Flame size={14} aria-hidden="true" />{streak} days</span> : null}
      </div>

      {view.state === "in" || view.state === "break" ? <p className={css.timer} aria-live="off">
        <span className={css.clock} role="timer" aria-label={`${words(view.worked)} worked today`}>{timer(view.worked)}</span>
        <small>{view.state === "break" ? `on break ${words(view.onBreak)}` : p.entry ? `worked today · in at ${clock(p.entry.in, p)}` : "worked today"}</small>
      </p> : null}

      {view.state === "done" ? <p className={css.summary} data-summary="">
        <Sparkles size={16} aria-hidden="true" />
        <span><b>{words(view.worked)}</b> worked{doneToday ? <> · <b>{doneToday}</b> task{doneToday === 1 ? "" : "s"} done</> : null}{p.entry?.out ? ` · out at ${clock(p.entry.out, p)}` : ""}. {streak > 1 ? `That’s ${streak} days on time in a row. ` : ""}See you tomorrow.</span>
      </p> : null}

      {view.state === "out" ? <div className={css.modes} role="group" aria-label="Where you are working">
        {MODES.map((m) => <button key={m.id} type="button" aria-pressed={chosen === m.id} onClick={() => setMode(m.id)}>{m.label}</button>)}
      </div> : null}

      {view.actions.length || fix ? <div className={css.actions}>
        {view.actions.map((a, i) => { const I = ICON[a.id]; const main = a.primary || view.actions.length === 1 || (view.state === "in" && a.id === "check-out" && view.tone === "attention");
          return <button key={a.id} ref={i === 0 ? button : undefined} type="button" className={main ? css.primary : css.secondary} disabled={waiting !== null || view.state === "pending"} onClick={() => act(a.id)}>
            <I size={16} aria-hidden="true" />{waiting === a.id ? "Saving…" : a.label}</button>; })}
        {fix && !fix.pending ? <a className={css.secondary} href="/me?checkout=1">I left earlier: fix the time</a> : null}
      </div> : null}

      {week ? <div className={css.week} aria-label={`This week: ${week.onTime} on time${week.late ? `, ${week.late} late` : ""}`}>
        <ol>{week.days.map((d) => <li key={d.date} data-state={d.state} title={d.date} />)}</ol>
        <small>{week.onTime} on time this week{week.late ? ` · ${week.late} late` : ""}</small>
      </div> : null}
    </section>
  );
}
