"use client";
// One tap, everywhere: the check-in control in Pulse's header, on every page, on a computer, a phone browser and in the
// Pulse phone app. Check in, Break, End break, Check out, with the time worked. Taps go through the same saved queue as My
// desk (attendance-recovery: saved before sending, retried with the same id, accepted only on the server's receipt), so
// a tap offline syncs later and a double tap can never check in twice. When Pulse notices the person at an office and
// HR's setting is "ask", Pip's island asks once "You're at <office>. Check in?" and this control turns to "attention".
// On a phone's My desk the day's card is the one control, so this one steps aside there (EST-1196).
import { useBackLayer } from "@pulse/ui-shell";
import { Clock3, Coffee, Cloud, LogIn, LogOut, Play } from "lucide-react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { celebration, pipSvg, type ActionId, type Mode } from "@pulse/companion";
import { useAttendanceRecovery } from "./hr/attendance-recovery";
import { checkinView, clock, words } from "./lib/checkin-view.mjs";
import { currentDay, emitNudge, refreshDay, useCompanionDay } from "./lib/companion-day";
import { haptic } from "./lib/native-shell";
import css from "./checkin-chip.module.css";

const ICON = { "check-in": LogIn, "break-start": Coffee, "break-end": Play, "check-out": LogOut } as const;
const MODES: { id: Mode; label: string }[] = [{ id: "office", label: "Office" }, { id: "wfh", label: "Home" }, { id: "field", label: "On duty" }];
const DOT: Record<string, string> = { on_time: "On time", late: "Late", missed: "No check-in", off: "Day off", today: "Today" };

export function CheckinChip({ personId }: { personId: string }) {
  const day = useCompanionDay();
  const p = day.payload;
  const recovery = useAttendanceRecovery(personId, `${p?.state ?? ""}|${p?.entry?.in ?? ""}|${p?.entry?.out ?? ""}|${p?.entry?.onBreak ? 1 : 0}`);
  const [now, setNow] = useState(() => Date.now());
  const [menu, setMenu] = useState(false);
  useBackLayer(menu, () => setMenu(false)); // FLOAT-2: back closes the check-in menu
  const [mode, setMode] = useState<Mode | null>(null);
  const [online, setOnline] = useState(true);
  // POLISH-1: the time the person left, for a forgotten check-out (sent as a correction; nothing changes until approved).
  const [leftAt, setLeftAt] = useState(""), [sending, setSending] = useState(false), [fixError, setFixError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const payload = day.payload;
  const at = now + day.offset;
  const view = checkinView(payload && payload.person.id === personId ? payload : null, at, recovery.records, { online, tapped: recovery.working !== null });
  // "You're at the office. Check in?" (EST-1196): asked once, by the server's notification (Pip's island shows it; ATT:
  // this control no longer sends its own copy), and this control turns to "attention" with the same line in its menu.
  const open = menu;
  const setOpen = setMenu;
  const close = useRef(() => setOpen(false));
  useEffect(() => { close.current = () => setOpen(false); });

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), open ? 1000 : 15000);
    return () => window.clearInterval(tick);
  }, [open]);
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine);
    changed(); window.addEventListener("online", changed); window.addEventListener("offline", changed);
    return () => { window.removeEventListener("online", changed); window.removeEventListener("offline", changed); };
  }, []);
  // POLISH-2: a notice about a check-out (/me?checkout=…: "Still checked in?", "You didn’t check out") opens this
  // control's menu, where the time left is sent, once the day has loaded.
  const ready = !!payload;
  useEffect(() => {
    if (!ready || !new URLSearchParams(window.location.search).has("checkout")) return;
    const t = window.setTimeout(() => setMenu(true), 0);
    return () => window.clearTimeout(t);
  }, [ready]);
  // The header makes room for this control only while it is shown.
  useEffect(() => {
    if (!view.show) return;
    document.documentElement.dataset.checkin = "";
    return () => { delete document.documentElement.dataset.checkin; };
  }, [view.show]);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !sheet.current?.contains(event.target as Node)) close.current(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close.current(); };
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [open]);
  // FLOAT: the menu lives on the page's floating layer, under the chip and inside the window. Inside the top bar it was
  // placed by whatever glass held the chip: on a phone's calm home it opened half off the screen's left edge.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = sheet.current, chip = root.current; if (!el || !chip) return;
      const r = chip.getBoundingClientRect(), w = Math.min(320, window.innerWidth - 16);
      el.style.width = `${w}px`;
      el.style.top = `${Math.round(r.bottom + 8)}px`;
      el.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - 8 - w, r.right - w)))}px`;
      el.style.maxHeight = `${Math.max(200, window.innerHeight - r.bottom - 16)}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  // ATT: no nudges of this page's own about breaks or checking out: Pulse's one notification policy asks (the long-break
  // reminder, and the one question when the signals conflict), never this control as well.
  // Pulse's question (/me?ask=…) opens this control's menu with the two answers, once the day has loaded.
  useEffect(() => {
    if (!ready || !new URLSearchParams(window.location.search).has("ask")) return;
    const t = window.setTimeout(() => setMenu(true), 0);
    return () => window.clearTimeout(t);
  }, [ready]);
  const [answering, setAnswering] = useState(false), [answerError, setAnswerError] = useState("");
  // An automatic check-in is confirmed with one tap ("That's me"), once, on this device.
  const autoKey = payload?.entry?.inVia === "auto" && payload.entry.id && !payload.entry.out ? `pulse:auto-ok:${payload.entry.id}` : null;
  const [acked, setAcked] = useState("");
  // Read when the menu renders (it only opens in the browser): no effect, no flash.
  const autoOk = !autoKey || acked === autoKey || (typeof window !== "undefined" && (() => { try { return localStorage.getItem(autoKey) === "1"; } catch { return true; } })());

  // Pip's menu and the island's nudges ("Check in", "End break", "Check out") act through this control's saved queue.
  // UX-5A: Ctrl+K's actions too, with the place ("Check in (from home)"); `handled` tells the palette this control took it
  // (on a day it does not show, such as approved leave, the palette opens My desk instead, which asks about the leave).
  const actRef = useRef<((id: ActionId, mode?: Mode) => void) | null>(null);
  useEffect(() => { actRef.current = view.show && payload && payload.state !== "leave" ? (id, how) => void act(id, how) : null; });
  useEffect(() => {
    // CTO review: on My desk the day's card takes these (its listener), so their feedback shows where the person looks.
    const run = (event: Event) => { if ("todayCard" in document.documentElement.dataset) return; const d = (event as CustomEvent<{ id?: ActionId; mode?: Mode; handled?: boolean }>).detail; if (d?.id && !d.handled && actRef.current) { d.handled = true; actRef.current(d.id, d.mode); } };
    window.addEventListener("pulse:checkin-act", run);
    return () => window.removeEventListener("pulse:checkin-act", run);
  }, []);

  if (!view.show || !payload) return null;
  const chosen: Mode = mode ?? (payload.shift.mode as Mode) ?? "office";
  // EST-1195: only a tap of this person's own in flight (or saved and waiting) holds the control; a background retry
  // no longer swallows a tap silently: the tap waits its turn and shows "Saving…" at once.
  const busy = recovery.working !== null;
  async function act(id: ActionId, how?: Mode) {
    if (busy) return;
    setOpen(false); haptic("light");
    const result = await recovery.act(id, how ?? chosen, view.show && view.arrival && id === "check-in" ? "suggested" : "manual");
    // Nothing could be saved (Pulse unreachable before its clock was confirmed): the menu says so, with Try again.
    if (result === "unsaved") { haptic("warning"); setMenu(true); return; }
    if (result === "accepted" || result === "queued") haptic("success");
    await refreshDay();
    window.dispatchEvent(new Event("pulse:attendance"));
    // A first check-in or an on-time streak milestone: Pip celebrates in the island (the corner companion used to).
    const fresh = currentDay();
    const party = id === "check-in" && fresh?.entry && !fresh.entry.late ? celebration(fresh) : null;
    if (party && fresh) emitNudge({ id: `celebrate:${fresh.today}`, kind: fresh.streak?.firstCheckIn ? "first-check-in" : "streak", title: party, actions: [], at: Date.now() });
  }
  const primary = view.actions.find((a) => a.primary) ?? (view.actions.length === 1 && view.state !== "stale" ? view.actions[0] : null);
  const Icon = view.state === "pending" ? Cloud : view.state === "out" ? LogIn : view.state === "break" ? Coffee : view.state === "stale" ? Clock3 : null;
  const fix = view.fix ?? null, left = leftAt || fix?.suggested || "";
  // The existing correction flow (a missed check-out for that session), the same request as My desk → Request a correction.
  async function sendFix() {
    if (!fix || !left || sending) return;
    setSending(true); setFixError("");
    try {
      const r = await fetch("/api/v0/hr/regularisations", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "missed_punch", date: fix.date, entryId: fix.entryId ?? undefined, outTime: left, reason: `Forgot to check out; I left at ${left} (sent from the check-in control).` }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error ?? "Could not send");
      haptic("success"); setLeftAt(""); await refreshDay(); window.dispatchEvent(new Event("pulse:attendance"));
    } catch (e) { setFixError((e as Error).message); } finally { setSending(false); }
  }
  const question = view.question ?? null;
  async function answer(kind: "left" | "working") {
    if (!question || answering) return;
    setAnswering(true); setAnswerError("");
    try {
      const r = await fetch("/api/v0/attendance/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entryId: question.entryId, answer: kind }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error ?? "Could not send");
      haptic("success"); setOpen(false); await refreshDay(); window.dispatchEvent(new Event("pulse:attendance")); window.dispatchEvent(new Event("pulse:poll-now"));
    } catch (e) { setAnswerError((e as Error).message); } finally { setAnswering(false); }
  }
  const confirmAuto = () => { try { if (autoKey) localStorage.setItem(autoKey, "1"); } catch { /* private mode */ } setAcked(autoKey ?? ""); };
  // Not checked in: the control itself is the one tap. Checked in: it shows the time and opens Break / Check out.
  const direct = view.state === "out";
  const week = payload.week;
  return (
    // CTO review: on a phone's My desk this control steps aside for the card, except while it carries something the card
    // does not (a check-out to correct, or its menu open, e.g. /me?checkout=…).
    <div className={css.root} ref={root} data-keep={fix || open ? "" : undefined} data-checkin-chip="">
      <button type="button" className={css.chip} data-tone={view.tone} data-state={view.state} data-fix={fix?.closed && !fix.pending ? "" : undefined} disabled={view.state === "pending"}
        aria-haspopup={direct ? undefined : "dialog"} aria-expanded={direct ? undefined : open} title={view.title}
        aria-label={(view.state === "in" || view.state === "done") && view.label !== "Done" && !view.question ? `${view.label} worked today. ${view.title}` : `${view.label} ${view.title}`}
        onClick={() => direct && primary ? void act(primary.id) : setOpen((v) => !v)}>
        {Icon ? <Icon size={15} strokeWidth={2} aria-hidden="true" /> : <i className={css.dot} data-state={view.state} aria-hidden="true" />}
        <span className={css.full}>{view.label}</span><span className={css.short}>{view.short}</span>
      </button>
      {direct ? <button type="button" className={css.more} aria-label="Check-in options" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}><span aria-hidden="true">▾</span></button> : null}
      {open ? createPortal(
        <section ref={sheet} className={css.menu} role="dialog" aria-label="Today’s attendance" data-checkin-menu="">
          {view.arrival ? <div className={css.arrival}>
            <span className={css.pip} aria-hidden="true" dangerouslySetInnerHTML={{ __html: pipSvg({ mood: "waking", size: 40, uid: "chip", still: true }) }} />
            <span><b>You’re at {view.arrival.office ?? "the office"}.</b><small>Pulse noticed your arrival. Check in?</small></span>
          </div> : null}
          {question ? <div className={css.arrival} data-question={question.kind}>
            <span className={css.pip} aria-hidden="true" dangerouslySetInnerHTML={{ __html: pipSvg({ mood: "listening", size: 40, uid: "chip-ask", still: true }) }} />
            <span><b>{question.title}</b><small>{question.kind === "left_early" ? "Done for the day, or back later?" : "Your laptop is still in use somewhere else."} One tap answers it; Pulse won’t ask again.</small></span>
          </div> : null}
          {question ? <div className={css.actions} role="group" aria-label="Your answer">
            <button type="button" className={css.primary} disabled={answering} onClick={() => void answer("left")}><LogOut size={15} aria-hidden="true" />Yes, I left at {question.leftAt}</button>
            <button type="button" className={css.secondary} disabled={answering} onClick={() => void answer("working")}><Play size={15} aria-hidden="true" />{question.kind === "left_early" ? "Back later" : "Still working"}</button>
            {answerError ? <small role="alert" className={css.fixError}>{answerError}</small> : null}
          </div> : null}
          {!autoOk && payload.entry ? <div className={css.autoIn}>
            <span>Checked in automatically at {clock(payload.entry.in, payload)}.</span>
            <button type="button" className={css.secondary} onClick={confirmAuto}>That’s me</button>
            <Link href="/me?tab=attendance" className={css.link} onClick={() => setOpen(false)}>Not right?</Link>
          </div> : null}
          {view.arrival || question || (fix && !fix.closed) ? null : <p className={css.head}><b>{view.state === "out" ? (view.arrival ? "One tap checks you in" : "Not checked in yet") : view.state === "break" ? "On break" : view.state === "done" ? "Done for today" : "Checked in"}</b>
            {view.state === "out" || view.tone === "attention" ? <span>{view.title}</span> : null}</p>}
          {fix ? <div className={css.fix} data-pending={fix.pending ? "" : undefined} data-closed={fix.closed ? "" : undefined}>
            <p className={css.head}><b>{fix.pending ? "Check-out time sent" : fix.closed ? `You didn’t check out ${fix.day === "yesterday" || fix.day === "today" ? fix.day : `on ${fix.day}`}.` : `Still checked in since ${fix.since}.`}</b>
              <span>{fix.pending ? `For the session since ${fix.since}. Your manager or HR approves it; until then nothing changes.` : fix.closed ? `Checked in at ${fix.in}. Pulse noted ${fix.suggested} for now: when did you leave?` : "Check out at the right time?"}</span></p>
            {fix.pending ? null : <form className={css.fixForm} onSubmit={(e) => { e.preventDefault(); void sendFix(); }}>
              <label>I left at<input type="time" value={left} onChange={(e) => setLeftAt(e.target.value)} required /></label>
              <button type="submit" className={css.primary} disabled={sending || !left}><LogOut size={15} aria-hidden="true" />Check out at {left}</button>
              <small>Sent as a correction for {fix.date === payload.today ? "today" : fix.since.split(" ").slice(0, -1).join(" ")}: your manager or HR approves it. Nothing changes until then.</small>
              {fixError ? <small role="alert" className={css.fixError}>{fixError}</small> : null}
            </form>}
          </div> : null}
          {view.state === "in" || view.state === "break" || view.state === "done" ? <p className={css.timer}><span>{words(view.worked)}</span> worked{payload.entry ? ` · in at ${clock(payload.entry.in, payload)}` : ""}</p> : null}
          {view.state === "out" ? <div className={css.modes} role="group" aria-label="Where you are working">{MODES.map((m) => <button key={m.id} type="button" aria-pressed={chosen === m.id} onClick={() => setMode(m.id)}>{m.label}</button>)}</div> : null}
          <div className={css.actions}>
            {view.actions.map((a) => { const I = ICON[a.id]; return <button key={a.id} type="button" className={a.primary || (view.actions.length === 1 && !fix) ? css.primary : css.secondary} disabled={busy} onClick={() => void act(a.id)}><I size={15} aria-hidden="true" />{a.label}</button>; })}
            {view.arrival ? <button type="button" className={css.secondary} onClick={() => setOpen(false)}>Not now</button> : null}
          </div>
          {week ? <div className={css.week} aria-label={`This week: ${week.onTime} on time${week.late ? `, ${week.late} late` : ""}`}>
            <span>This week</span>
            <ol>{week.days.map((d) => <li key={d.date} data-state={d.state} title={`${d.date}: ${DOT[d.state]}`}><span className={css.srOnly}>{d.date} {DOT[d.state]}</span></li>)}</ol>
            <b>{payload.streak.onTime > 1 ? `${payload.streak.onTime} days on time in a row` : `${week.onTime} on time`}</b>
          </div> : null}
          {recovery.receipts}
          <Link href="/me?tab=attendance" className={css.link} onClick={() => setOpen(false)}>Your day and corrections</Link>
        </section>, document.body
      ) : null}
    </div>
  );
}
