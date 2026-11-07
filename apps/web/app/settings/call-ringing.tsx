"use client";
// CALLS-NATIVE: Settings → Devices → Calls ring. Will a Pulse call ring here, with Pulse closed or the phone locked?
// Inside the phone app: what Android or iOS allows (notifications, full-screen calls, the Calls sound, battery),
// each with the one place to fix it. In a browser: notifications and browser pings. "Test my ringing" rings every
// device of mine now (POST /api/v0/calls/ring-test).
import { CheckCircle2, CircleAlert, PhoneCall } from "lucide-react";
import { useEffect, useState } from "react";
import { NotificationStatus } from "../notify-status";
import { post } from "../records";
import { shell, type CallReadiness } from "../lib/native-shell";
import { styles } from "../ui";
import css from "./devices.module.css";

type Result = { device: string; platform: string; result: string };
type Test = { testId: string; ringAllowed: boolean; phones: number; results: Result[] };
type Check = { key: string; ok: boolean; title: string; fix?: string; what?: "notifications" | "fullscreen" | "channel" | "battery" | "app" };

const said = (r: string) => r === "accepted" ? "rang" : r === "retry" || r === "not set up on this server" ? "not set up on the server yet" : r === "expired" ? "signed out of pings: open Pulse there once" : "could not be reached";

/** The phone's own checks, in plain words (absent on a shell older than 1.1.6). */
export function phoneChecks(r: CallReadiness, platform: "android" | "ios"): Check[] {
  const out: Check[] = [
    { key: "notifications", ok: r.notifications, title: r.notifications ? "Notifications are on" : "Notifications are off for Pulse", fix: "Turn on", what: "notifications" },
  ];
  if (platform === "android") {
    out.push({ key: "channel", ok: r.channel === "on", title: r.channel === "on" ? "Calls ring with sound" : r.channel === "silent" ? "Calls are set to silent" : "Calls are switched off", fix: "Open Calls settings", what: "channel" });
    out.push({ key: "fullscreen", ok: r.fullScreen, title: r.fullScreen ? "Calls can fill the locked screen" : "Calls can't fill the locked screen", fix: "Allow full screen", what: "fullscreen" });
    if (r.battery !== "unknown") out.push({ key: "battery", ok: r.battery === "ok", title: r.battery === "ok" ? "Battery saving won't hold calls back" : "Battery saving may delay calls", fix: "Allow in background", what: "battery" });
  }
  out.push({ key: "push", ok: r.push === "ready", title: r.push === "ready" ? "Pulse can wake this phone for a call" : r.push === "no-push" ? "This build can't be woken yet: calls ring while Pulse is open" : "Waiting for this phone to register for calls", what: "app" });
  return out;
}

export function CallRinging() {
  const s = shell();
  const [info, setInfo] = useState<{ platform: "android" | "ios" } | null>(null);
  const [ready, setReady] = useState<CallReadiness | null>(null);
  const [old, setOld] = useState(false);
  const [browser, setBrowser] = useState<"granted" | "denied" | "default" | "unsupported" | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<Test | null>(null);
  const [note, setNote] = useState("");
  const [arrived, setArrived] = useState(false);

  const refresh = () => {
    const native = shell();
    if (native) {
      void native.info().then(i => setInfo({ platform: i.platform })).catch(() => {});
      if (native.callReadiness) void native.callReadiness().then(setReady).catch(() => setOld(true)); else setOld(true);
    } else setBrowser(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  };
  useEffect(() => {
    // After the first paint (what the phone or browser allows is read, never rendered on the server).
    const first = setTimeout(() => { refresh(); setArrived(new URLSearchParams(window.location.search).has("ringtest")); }, 0);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearTimeout(first); document.removeEventListener("visibilitychange", refresh); };
  }, []);

  async function ring() {
    setBusy(true); setNote(""); setTest(null);
    // On the phone: time to lock it or leave Pulse, so the ring shows the way a real call would.
    if (s) { setNote("Lock your phone or leave Pulse now: the test call rings in 8 seconds."); await new Promise(r => setTimeout(r, 8000)); setNote(""); }
    try { setTest(await post<Test>("calls/ring-test", {})); }
    catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); }
  }
  const fix = (what: Check["what"]) => { if (s?.openCallSettings && what && what !== "app") void s.openCallSettings({ what }).catch(() => {}); };

  const checks = ready && info ? phoneChecks(ready, info.platform) : [];
  const bad = checks.filter(c => !c.ok).length;
  return (
    <div className={css.list}>
      <article className={css.card} aria-label="Calls ring">
        <div className={css.heading}><PhoneCall size={22} aria-hidden="true" /><div><h3>Calls ring here</h3>
          <small>{s ? (ready ? (bad ? `${bad} thing${bad > 1 ? "s" : ""} to fix on this phone` : "Ready: calls ring even with Pulse closed") : old ? "Update Pulse to ring with the app closed" : "Checking…")
            : browser === "granted" ? "This browser can ring while Pulse is open in a tab" : "Turn on browser pings to hear calls"}</small></div></div>
        <p>A Pulse call rings like a phone call: full screen on a locked phone, Answer or Decline, a missed call when nobody answers. Answering on one device stops the ring on the others. A colleague’s call rings through quiet hours, never through Do not disturb; an AI employee’s call keeps both.</p>
        {arrived ? <p className={styles.muted} role="status"><CheckCircle2 size={16} aria-hidden="true" /> Your test ring arrived here and you opened it. Ringing works on this device.</p> : null}
        {s && old ? <p>This version of the Pulse app rings only while Pulse is open. Update it under Updates, then come back here.</p> : null}
        {checks.length ? <ul className={css.list} aria-label="Ringing checks" style={{ listStyle: "none", padding: 0, gap: 8 }}>
          {checks.map(c => <li key={c.key} className={styles.inline} style={{ justifyContent: "space-between", minHeight: 44 }}>
            <span className={styles.inline}>{c.ok ? <CheckCircle2 size={18} aria-hidden="true" color="var(--success, #22b35e)" /> : <CircleAlert size={18} aria-hidden="true" color="var(--warning, #c98a00)" />}{c.title}</span>
            {!c.ok && c.fix ? <button type="button" className={styles.btn} onClick={() => fix(c.what)}>{c.fix}</button> : null}
          </li>)}
        </ul> : null}
        {/* In a browser: this device's notifications, with the one way to turn them on (the same as Settings and Notifications). */}
        {!s ? <NotificationStatus /> : null}
        <div className={styles.inline}>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void ring()}>{busy ? "Ringing…" : "Test my ringing"}</button>
        </div>
        {test ? <div role="status" className={styles.stack}>
          {test.results.length ? <p>Test ring sent: {test.results.map(r => `${r.platform === "web" ? "a browser" : r.device} ${said(r.result)}`).join(" · ")}. It rings for 30 seconds; open it to confirm.</p>
            : <p>No phone or browser of yours is set up for pings yet{test.phones ? " (your phone is registered but hasn't registered for calls: open Pulse on it once)" : ""}. Install the Pulse app from Get the apps, or turn on browser pings.</p>}
          {!test.ringAllowed ? <p className={styles.muted}>Do not disturb or a snooze is on, so real calls won’t ring now. Change it under Notifications.</p> : null}
        </div> : null}
        {note ? <p className={styles.muted} role="status">{note}</p> : null}
      </article>
    </div>
  );
}
