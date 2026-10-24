"use client";
// POLISH-1 (P0): the phone app never asked for notifications, so Android kept them off (POST_NOTIFICATIONS not granted,
// app importance NONE) and staff got nothing. After sign-in, Pulse says in one short screen why it asks, then Android or
// iOS asks. While notifications stay off, a calm banner above the page keeps one "Turn on" path: the system prompt while
// it can still appear, otherwise the app's own notification settings. Nothing here runs in a browser.
import { BellOff, BellRing, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { shell, type PulseShell } from "./lib/native-shell";
import css from "./notify-permission.module.css";

const ASKED = "pulse.notify.asked", LATER = "pulse.notify.later";
type State = "unknown" | "on" | "ask" | "off";
const today = () => new Date().toISOString().slice(0, 10);
const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };

/** What the system would do on a request: show its prompt, or nothing (denied: only Settings can turn them on). */
async function ask(s: PulseShell): Promise<"granted" | "prompt" | "denied" | null> {
  const info = await s.info();
  if (info.notifications) return "granted";
  if (info.notificationsAsk) return info.notificationsAsk;
  // Shells before 1.1.2 (the 1.1.0 on staff phones): Capacitor's own permission check (Android 13+).
  const p = await Promise.race([s.checkPermissions().then((x) => x?.notifications, () => undefined), new Promise<undefined>((done) => setTimeout(() => done(undefined), 3000))]);
  return p === "prompt" || p === "prompt-with-rationale" ? "prompt" : p === "denied" ? "denied" : info.platform === "ios" ? null : "denied";
}

export function NotifyPermission() {
  const [state, setState] = useState<State>("unknown");
  const [system, setSystem] = useState<"granted" | "prompt" | "denied" | null>(null);
  const [later, setLater] = useState(false), [busy, setBusy] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const s = shell(); if (!s) return;
    let active = true;
    const check = async () => {
      try {
        const now = await ask(s); if (!active) return;
        setSystem(now); setLater(read(LATER) === today());
        // The explanation comes first, once per phone, and only while the system can still ask.
        setState(now === "granted" ? "on" : (now === "prompt" || now === null) && !read(ASKED) ? "ask" : "off");
      } catch { /* the shell could not answer; try again when Pulse comes back to the front */ }
    };
    void check();
    const back = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", back);
    return () => { active = false; document.removeEventListener("visibilitychange", back); };
  }, []);
  // The banner sits in the page flow, above the page (like the offline notice), so it never covers anything. Its host
  // is made when the banner mounts (this component itself renders at the end of the page).
  const host = useCallback((anchor: HTMLSpanElement | null) => {
    if (!anchor) return;
    const main = document.getElementById("main-content"); if (!main?.parentElement) return;
    const box = document.createElement("div"); main.parentElement.insertBefore(box, main); setSlot(box);
    return () => { box.remove(); setSlot(null); };
  }, []);
  // The office-arrival question (arrival-setup.tsx) waits until this one is answered.
  useEffect(() => { if (state === "on" || state === "off") window.dispatchEvent(new Event("pulse:notify-settled")); }, [state]);
  useEffect(() => {
    if (state !== "ask") return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") notNow(); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });

  async function turnOn() {
    const s = shell(); if (!s || busy) return;
    setBusy(true); write(ASKED, "1");
    try {
      if (system === "denied") { await s.openNotificationSettings(); return; }
      await s.requestNotifications().catch(() => null);
      const now = await ask(s); setSystem(now);
      if (now === "granted") { setState("on"); return; }
      // Android stops showing its prompt after the second "Don't allow": the app's settings are the way from here.
      if (state === "off") await s.openNotificationSettings();
      setState("off");
    } catch { setState("off"); } finally { setBusy(false); }
  }
  function notNow() { write(ASKED, "1"); setState("off"); }

  if (state === "ask") return <div className={css.backdrop}>
    <section className={css.sheet} role="dialog" aria-modal="true" aria-labelledby="pulse-notify-title">
      <span className={css.icon} aria-hidden="true"><BellRing size={28} /></span>
      <h2 id="pulse-notify-title">Let Pulse tell you when something needs you</h2>
      <p>Approvals, chats and check-in reminders arrive as notifications, even when Pulse is closed.</p>
      <ul><li>Requests waiting for your decision, and decisions on yours</li><li>New messages in your chats</li><li>A reminder to check in or out</li></ul>
      <small>Notifications show who and what, never the message text.</small>
      <button type="button" className={css.primary} onClick={() => void turnOn()} disabled={busy}>Allow notifications</button>
      <button type="button" className={css.quiet} onClick={notNow}>Not now</button>
    </section>
  </div>;
  if (state !== "off" || later) return null;
  return <><span hidden ref={host} />{slot ? createPortal(<div className={css.banner} role="region" aria-label="Notifications are off" data-float-avoid="">
    <BellOff size={16} aria-hidden="true" />
    {/* POLISH-2 (QA-E2E P1-10): after two "Don't allow" taps Android never asks again; say so and open Settings. */}
    <span><b>Notifications are off.</b> {system === "denied" ? "The phone won’t ask again: turn them on in its settings for Pulse." : "Approvals, chats and check-in reminders can’t reach you."}</span>
    <button type="button" className={css.turnOn} onClick={() => void turnOn()} disabled={busy}>{system === "denied" ? "Open settings" : "Turn on"}</button>
    <button type="button" className={css.close} aria-label="Hide until tomorrow" title="Hide until tomorrow" onClick={() => { write(LATER, today()); setLater(true); }}><X size={15} aria-hidden="true" /></button>
  </div>, slot) : null}</>;
}
