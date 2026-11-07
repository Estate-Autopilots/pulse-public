"use client";
// ONBOARD-CHECKIN-TG (owner, 6 Nov 2026: "push notifications, nudged firmly but politely"). In a browser, after sign-in:
// * once, a full-screen card: what Vitals will notify you about (calls, tasks due, approvals, check-in reminders), Turn
//   on, Send me a test notification, and Test a call (rings only your own signed-in devices: POST calls/ring-test; it
//   never dials a number);
// * "Not now" brings the card back at most once a week; until notifications are on, a slim banner stays at the top of
//   the page (Later hides it for this visit only);
// * nothing when this browser can't do it, or the server can't push yet (asking would be a promise we can't keep).
// The phone app asks in notify-permission.tsx; the desktop app at its first start. Replaces the top bar's chip
// (BrowserNotifyAsk) where this is mounted.
import { BellRing, CalendarCheck, CheckCircle2, ListChecks, PhoneCall, Send, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBackLayer } from "@pulse/ui-shell";
import { post } from "./records";
import { BROWSER_ASKED, allow, current, sendTest } from "./notify-status";
import css from "./notify-welcome.module.css";

const WEEK = 7 * 24 * 3600 * 1000;
type Saved = { shownAt?: number; declinedAt?: number };
const key = (person: string) => `vitals.notify.ask.${person}`;
const load = (person: string): Saved => { try { return JSON.parse(localStorage.getItem(key(person)) ?? "{}") as Saved; } catch { return {}; } };
const save = (person: string, s: Saved) => { try { localStorage.setItem(key(person), JSON.stringify(s)); localStorage.setItem(BROWSER_ASKED, "1"); } catch { /* private mode */ } };
const later = () => { try { return sessionStorage.getItem("vitals.notify.banner.later") === "1"; } catch { return false; } };

/** Whether the full-screen card should open now: never asked, or declined at least a week ago. */
export function askDue(s: Saved, now: number): boolean {
  if (!s.shownAt) return true;
  return !!s.declinedAt && now - s.declinedAt >= WEEK;
}

const KINDS = [
  { Icon: PhoneCall, title: "Calls", text: "A colleague or an AI employee calling you rings like a phone call." },
  { Icon: ListChecks, title: "Tasks due", text: "Work given to you, and what is due today." },
  { Icon: ShieldCheck, title: "Approvals", text: "Leave, corrections and requests waiting for your decision." },
  { Icon: CalendarCheck, title: "Check-in reminders", text: "One gentle reminder a day, if your company uses attendance." },
];

export function NotifyWelcome({ person }: { person: string }) {
  const [state, setState] = useState<"off" | "on" | "blocked" | "none">("none");
  const [open, setOpen] = useState(false), [banner, setBanner] = useState(false);
  const [busy, setBusy] = useState(false), [note, setNote] = useState("");
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  useBackLayer(open, () => decline());

  useEffect(() => {
    let live = true;
    // After the page settles, so the card never races the page's own first paint.
    const t = window.setTimeout(() => void current().then((r) => {
      if (!live || r.where !== "browser") return;
      if (r.state === "on") { setState("on"); return; }
      if (r.state !== "off" && r.state !== "blocked") return; // unsupported, or the server can't push yet
      setState(r.state);
      if (r.state === "off" && askDue(load(person), Date.now())) setOpen(true);
      if (!later()) setBanner(true);
    }), 1500);
    return () => { live = false; window.clearTimeout(t); };
  }, [person]);
  useEffect(() => { if (open) first.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") decline(); };
    document.addEventListener("keydown", esc);
    const root = document.documentElement, before = root.style.overflow; root.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", esc); root.style.overflow = before; };
  });
  // The banner's place: the top of the page's main column (it moves nothing else and covers nothing).
  useEffect(() => {
    if (!banner || state === "on") return;
    const main = document.querySelector<HTMLElement>("main"); if (!main) return;
    const box = document.createElement("div"); box.dataset.notifyBanner = "";
    main.prepend(box);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the host exists only once the page's main is in place
    setSlot(box);
    return () => { box.remove(); setSlot(null); };
  }, [banner, state]);

  function decline() { const s = load(person); save(person, { ...s, shownAt: s.shownAt ?? Date.now(), declinedAt: Date.now() }); setOpen(false); }
  async function turnOn() {
    setBusy(true); setNote("");
    const s = load(person); save(person, { ...s, shownAt: s.shownAt ?? Date.now() });
    try {
      const r = await allow("browser");
      if (r === "on") { setState("on"); setBanner(false); setNote("Notifications are on. Send yourself a test to see one arrive."); }
      else if (r === "blocked") { setState("blocked"); setNote("This browser blocked them. Allow notifications from the icon left of the address bar, then come back."); }
      else setNote("Not turned on. You can do it any time from Settings → Notifications.");
    } finally { setBusy(false); }
  }
  async function test() { setBusy(true); try { setNote(await sendTest()); } finally { setBusy(false); } }
  async function ring() {
    setBusy(true); setNote("");
    try {
      const r = await post<{ results: { platform: string }[]; ringAllowed: boolean }>("calls/ring-test", {});
      setNote(r.results.length ? `Ringing your ${r.results.length === 1 ? "device" : `${r.results.length} devices`} now: it rings for 30 seconds. Only your own signed-in devices ring; no number is called.`
        : "No device of yours can ring yet. Turn on notifications first, or install the Vitals app.");
    } catch (e) { setNote(e instanceof Error ? e.message : "The test call could not start."); }
    finally { setBusy(false); }
  }

  const on = state === "on";
  return <>
    {open ? createPortal(<div className={css.overlay} role="dialog" aria-modal="true" aria-labelledby="notify-welcome-title" data-float-avoid="">
      <div className={css.sheet}>
        <button type="button" className={css.close} aria-label="Not now" onClick={decline}><X size={18} aria-hidden="true" /></button>
        <div className={css.body}>
          <span className={css.badge} aria-hidden="true">{on ? <CheckCircle2 size={26} /> : <BellRing size={26} />}</span>
          <h2 id="notify-welcome-title">{on ? "You’re all set" : "Don’t miss what needs you"}</h2>
          <p className={css.lead}>{on ? "Vitals will let you know, also with this tab closed. Quiet hours and Do not disturb still apply." : "Turn on notifications and Vitals tells you, also with this tab closed. Only what needs you pings; the rest waits quietly in the bell."}</p>
          <ul className={css.kinds} aria-label="What you’ll be notified about">
            {KINDS.map(({ Icon, title, text }) => <li key={title}><span aria-hidden="true"><Icon size={18} /></span><span><b>{title}</b><small>{text}</small></span></li>)}
          </ul>
          {note ? <p role="status" className={css.note}>{note}</p> : null}
        </div>
        <div className={css.foot}>
          {on ? <>
            <button ref={first} type="button" className={css.primary} disabled={busy} onClick={() => void test()}><Send size={16} aria-hidden="true" />Send me a test notification</button>
            <button type="button" className={css.secondary} disabled={busy} onClick={() => void ring()}><PhoneCall size={16} aria-hidden="true" />Test a call</button>
            <button type="button" className={css.text} onClick={() => setOpen(false)}>Done</button>
          </> : <>
            <button ref={first} type="button" className={css.primary} disabled={busy} onClick={() => void turnOn()}><BellRing size={16} aria-hidden="true" />Turn on notifications</button>
            <button type="button" className={css.text} disabled={busy} onClick={decline}>Not now</button>
          </>}
        </div>
      </div>
    </div>, document.body) : null}
    {slot && banner && !open && !on ? createPortal(<div className={css.banner} role="region" aria-label="Notifications are off">
      <BellRing size={16} aria-hidden="true" />
      <span className={css.bannerText}><b>Notifications are off.</b> {state === "blocked" ? "This browser blocks them: allow them from the icon left of the address bar." : "Turn them on so calls, approvals and tasks due reach you."}</span>
      <span className={css.bannerActions}>
        {state === "off" ? <button type="button" className={css.primarySmall} onClick={() => setOpen(true)}>Turn on</button> : null}
        <button type="button" className={css.textSmall} onClick={() => { try { sessionStorage.setItem("vitals.notify.banner.later", "1"); } catch { /* private mode */ } setBanner(false); }}>Later</button>
      </span>
    </div>, slot) : null}
  </>;
}
