"use client";
// POLISH-1: office arrival with Pulse closed, in two steps, only within the person's own agreement (their presence
// choice) and HR's setting. Step 1: location while using Pulse (office Wi-Fi). Step 2: "Allow all the time", after Pulse's
// own explanation and the consent terms, so Android's geofences (or iOS's regions) around the registered offices can wake
// Pulse on arrival. Declining keeps office Wi-Fi and the one-tap check-in in Pulse. Nothing here runs in a browser.
import { MapPin, Wifi, X } from "lucide-react";
import { useEffect, useState } from "react";
import { shell, type ShellInfo, type ShellPresence } from "./lib/native-shell";
import css from "./notify-permission.module.css";

export const ARRIVAL_ASKED = "pulse.arrival.asked";
const wait = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);

/** The sheet. `presence` is this phone's presence choice with what the system allows (`arrival`). */
export function ArrivalSetup({ presence, platform, onChanged, onClose }: { presence: ShellPresence; platform: ShellInfo["platform"]; onChanged: (p: ShellPresence) => void; onClose: () => void }) {
  const arrival = presence.arrival ?? { location: false, background: false };
  const [busy, setBusy] = useState(false), [note, setNote] = useState("");
  const offices = presence.offices.map((o) => o.name).filter(Boolean);
  const where = offices.length === 1 ? offices[0] : "your office";
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  async function ask(kind: "location" | "background") {
    const s = shell(); if (!s || busy) return;
    setBusy(true); setNote("");
    try {
      try { localStorage.setItem(ARRIVAL_ASKED, "1"); } catch { /* private mode */ }
      const r = await s.requestPermissions({ permissions: [kind] });
      const p = await s.presencePreferences().catch(() => null);
      if (p) onChanged(p);
      const granted = kind === "location" ? r.location === "granted" : r.background === "granted";
      if (kind === "background") setNote(granted ? `Done. Pulse will notice when you reach ${where}, even with Pulse closed.`
        : "That’s fine. Pulse still notices the office Wi-Fi while it’s open, and checking in stays one tap.");
      else if (!granted) setNote("Location stays off. Checking in stays one tap in Pulse; the office network still counts at the office.");
    } catch { setNote(platform === "ios" ? "iOS did not change it. You can choose it in Settings → Pulse → Location." : "Android did not change it. You can choose it in Settings → Apps → Pulse → Location."); }
    finally { setBusy(false); }
  }
  const done = arrival.location && arrival.background;
  return <div className={css.backdrop}>
    <section className={css.sheet} role="dialog" aria-modal="true" aria-labelledby="pulse-arrival-title">
      <button type="button" className={css.sheetClose} aria-label="Close" onClick={onClose}><X size={18} aria-hidden="true" /></button>
      <span className={css.icon} aria-hidden="true">{arrival.location ? <MapPin size={28} /> : <Wifi size={28} />}</span>
      <p className={css.steps} aria-label={`Step ${arrival.location ? 2 : 1} of 2`}><span data-on={!arrival.location || undefined}>1 · While using Pulse</span><span data-on={arrival.location && !done || undefined}>2 · With Pulse closed</span></p>
      {!arrival.location ? <>
        <h2 id="pulse-arrival-title">Recognise {where}</h2>
        <p>{platform === "ios" ? "iOS" : "Android"} shares the Wi-Fi’s name only with apps allowed to use location. With it, Pulse can tell when this phone joins the office Wi-Fi.</p>
      </> : done ? <>
        <h2 id="pulse-arrival-title">Office arrival is on</h2>
        <p>Pulse notices when you reach {where}, even with Pulse closed. {presence.auto ? "Pulse checks you in when two signals agree, as you agreed and HR allows." : "Pulse asks “Check in?”; nothing happens until you tap."}</p>
      </> : <>
        <h2 id="pulse-arrival-title">Notice your arrival with Pulse closed</h2>
        <p>So {presence.auto ? "your check-in happens" : "“Check in?” is waiting"} when you reach {where}, even if you haven’t opened Pulse. {platform === "ios" ? "iOS calls this “Always”." : "Android calls this “Allow all the time”."}</p>
      </>}
      {!done ? <div className={css.terms}>
        <b>What Pulse does and does not do</b>
        <ul>
          <li>{platform === "ios" ? "iOS" : "Android"} watches only the area around {offices.length > 1 ? "your offices" : where} and wakes Pulse when you arrive or leave: no tracking during the day, no location history.</li>
          <li>Pulse sends only which office and the kind of signal, never where you are.</li>
          <li>{presence.auto ? "HR’s setting, which you agreed to: Pulse checks you in when two signals agree for a few minutes. You see it in your day and can correct it." : "HR’s setting: Pulse asks “Check in?”. Nothing is recorded until you tap."} Check-out is never automatic.</li>
          <li>Turn it off any time in Settings → Devices → This phone; it stops on every device at once.</li>
        </ul>
      </div> : null}
      {!arrival.location ? <button type="button" className={css.primary} disabled={busy} onClick={() => void ask("location")}>Allow while using Pulse</button>
        : !done ? <>
          <small>{platform === "ios" ? "On the next question, choose “Change to Always Allow”." : "On the next screen, choose “Allow all the time”, then come back."}</small>
          <button type="button" className={css.primary} disabled={busy} onClick={() => void ask("background")}>{platform === "ios" ? "Allow always" : "Choose “Allow all the time”"}</button>
        </> : null}
      <button type="button" className={css.quiet} onClick={onClose}>{done ? "Done" : "Not now: office Wi-Fi and one tap in Pulse"}</button>
      {note ? <p role="status" className={css.sheetNote}>{note}</p> : null}
    </section>
  </div>;
}

/** Offered once per phone after sign-in, when the person agreed to office arrival, HR registered an office, and the
 *  system does not yet allow it with Pulse closed (waits until the notifications question is answered). */
export function ArrivalPrompt() {
  const [presence, setPresence] = useState<ShellPresence | null>(null), [platform, setPlatform] = useState<ShellInfo["platform"]>("android");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const s = shell(); if (!s) return;
    let active = true;
    const check = async () => {
      try {
        if (localStorage.getItem(ARRIVAL_ASKED)) return;
        const info = await wait(s.info(), 4000);
        if (!info.enrolled || (!info.notifications && !localStorage.getItem("pulse.notify.asked"))) return;
        const p = await wait(s.presencePreferences(), 8000);
        if (!active || !p.enabled || !p.offices.length || !p.arrival || p.arrival.background) return;
        setPlatform(info.platform); setPresence(p); setOpen(true);
      } catch { /* offline or not registered yet: ask on a later visit */ }
    };
    void check();
    window.addEventListener("pulse:notify-settled", check);
    return () => { active = false; window.removeEventListener("pulse:notify-settled", check); };
  }, []);
  if (!open || !presence) return null;
  return <ArrivalSetup presence={presence} platform={platform} onChanged={setPresence}
    onClose={() => { try { localStorage.setItem(ARRIVAL_ASKED, "1"); } catch { /* private mode */ } setOpen(false); }} />;
}
