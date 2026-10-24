"use client";
// Settings → Devices → This phone: only inside the Pulse phone app. Notifications, the app's version and updates.
import { BellRing, Download, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { ArrivalSetup } from "../arrival-setup";
import { attendanceShell, shell, type ShellInfo, type ShellPresence, type ShellUpdate } from "../lib/native-shell";
import { styles } from "../ui";
import css from "./devices.module.css";

const mb = (n?: number) => (n ? `${(n / 1048576).toFixed(1)} MB` : "");

export function ThisPhone() {
  const [info, setInfo] = useState<ShellInfo | null>(null);
  const [update, setUpdate] = useState<ShellUpdate | null>(null);
  const [step, setStep] = useState<"" | "checking" | "downloading" | "ready" | "permission">("");
  const [note, setNote] = useState("");
  const [ribbon, setRibbon] = useState<boolean | null>(null), [ribbonBusy, setRibbonBusy] = useState(false);
  const [presence, setPresence] = useState<ShellPresence | null>(null), [presenceBusy, setPresenceBusy] = useState(false);
  const refresh = () => void shell()?.info().then(setInfo).catch(() => {});
  useEffect(() => { refresh(); document.addEventListener("visibilitychange", refresh); return () => document.removeEventListener("visibilitychange", refresh); }, []);
  const s = shell();
  useEffect(() => {
    let active = true;
    if (info?.enrolled) void shell()?.presencePreferences().then(p => { if (active) setPresence(p); }).catch(() => {});
    return () => { active = false; };
  }, [info?.enrolled, info?.deviceId]);
  useEffect(() => {
    let active = true;
    const read = () => void attendanceShell()?.ribbon().then(r => { if (active) setRibbon(r.enabled); }).catch(() => {});
    read(); document.addEventListener("visibilitychange", read);
    return () => { active = false; document.removeEventListener("visibilitychange", read); };
  }, []);
  if (!s || !info) return null;
  async function chooseRibbon(enabled: boolean) {
    const native = attendanceShell(); if (!native) return;
    setRibbonBusy(true);
    try { const r = await native.ribbon({ enabled }); setRibbon(r.enabled); setNote(enabled ? r.permission ? "Attendance shortcuts are on. Swipe them away to keep them off until you choose them again." : "Attendance shortcuts are selected, but Android notifications are off. Manual attendance still works on My desk." : "Attendance shortcuts are off."); }
    catch { setNote("Could not save attendance shortcut choice. Try again."); }
    finally { setRibbonBusy(false); }
  }

  async function presenceChoice(enabled: boolean) {
    if (!s) return;
    setPresenceBusy(true);
    try { setPresence(await s.presencePreferences({ enabled })); setNote(enabled ? "Office helpers are on. They read Wi-Fi or one position only when you tap on Today." : "Office helpers are off. Any current office evidence for this phone is cleared."); }
    catch (e) { setNote((e as Error).message); }
    finally { setPresenceBusy(false); }
  }

  async function notifications() {
    if (!s) return;
    const r = await s.requestNotifications().catch(() => ({ state: "denied" as const }));
    if (r.state !== "granted") { setNote("Notifications are off for Pulse in your phone's settings. Turn them on there, then come back."); await s.openNotificationSettings(); }
    else setNote("Notifications are on. Pulse just sent one so you know what they look like.");
    refresh();
  }
  async function check() {
    if (!s) return;
    setStep("checking"); setNote("");
    try { const u = await s.checkUpdate(); setUpdate(u); setStep(""); if (!u.available) setNote(`Pulse ${u.current} is the latest version.`); }
    catch (e) { setStep(""); setNote((e as Error).message); }
  }
  async function install() {
    if (!s) return;
    try {
      if (step !== "ready") { setStep("downloading"); await s.downloadUpdate(); setStep("ready"); }
      const r = await s.installUpdate();
      if (r.result === "permission") { setStep("permission"); setNote("Android asks once: allow Pulse to install its own updates, then tap Install again."); await s.openInstallSettings(); }
    } catch (e) { setStep(""); setNote((e as Error).message); }
  }

  return (
    <div className={css.list}>
      <article className={css.card}>
        <div className={css.heading}><Smartphone size={22} aria-hidden="true" /><div><h3>Pulse for {info.platform === "ios" ? "iPhone" : "Android"}</h3><small>Version {info.version} · {info.enrolled ? "this phone is registered to you" : "registering this phone…"}</small></div></div>
        <p>This is the Pulse web app inside the phone app: everything you see here is the same Pulse as in a browser. This phone appears under Your devices and can be signed out there.</p>
      </article>
      {info.enrolled && presence && (presence.offices.length || presence.enabled) ? <article className={css.card}>
        <h3>Office check-in helpers</h3>
        <p>When this phone reaches the office (office Wi-Fi, the office network or the office area), Pulse asks “Check in?”. It sends only which office and which kind of signal, never where you are, and keeps no location history. Check-out is never automatic.</p>
        <label className={styles.inline} style={{ minHeight: 44 }}><input type="checkbox" checked={presence.enabled} disabled={presenceBusy} onChange={e => void presenceChoice(e.target.checked)} />Allow office check-in helpers on this phone</label>
        {presence.enabled && presence.arrival ? <ArrivalPermissions presence={presence} platform={info.platform} onChanged={setPresence} /> : null}
      </article> : null}
      <article className={css.card}>
        <div className={css.heading}><BellRing size={22} aria-hidden="true" /><div><h3>Notifications</h3><small>{info.notifications ? "On" : "Off"}</small></div></div>
        <p>New messages in your chats, requests waiting for you and decisions on yours. Notifications say what happened, never what a message says.</p>
        <div className={styles.inline}>{info.notifications ? <button type="button" className={styles.btn} onClick={() => void s.openNotificationSettings()}>Notification settings</button>
          : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void notifications()}>Turn on notifications</button>}</div>
      </article>
      {info.platform === "android" && ribbon !== null ? <article className={css.card} aria-label="Attendance shortcuts">
        <h3>Attendance shortcuts</h3>
        <p>Add the Pulse Workspace widget from your home screen’s widget picker. It shows the last confirmed status and update time. Opening a shortcut checks your sign-in; confirm on My desk before attendance changes.</p>
        <label className={styles.inline} style={{ minHeight: 44 }}><input type="checkbox" checked={ribbon} disabled={ribbonBusy || !info.enrolled} onChange={e => void chooseRibbon(e.target.checked)} />Show attendance shortcuts in notifications</label>
        <p>Optional and dismissible. Swiping it away turns it off until you choose it again. Android can delay updates after sleep or reboot; open Pulse to refresh. No background location or permanent notification.</p>
      </article> : null}
      {info.platform === "android" ? <article className={css.card}>
        <div className={css.heading}><Download size={22} aria-hidden="true" /><div><h3>Updates</h3><small>{update?.available ? `Pulse ${update.version} is available` : `Version ${info.version}`}</small></div></div>
        {update?.available ? <p>{update.notes || "A newer Pulse is ready."} {mb(update.size)}</p> : <p>Pulse checks the same update channel as the computer apps. Updates install only after Android asks you to confirm.</p>}
        <div className={styles.inline}>
          {update?.available ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={step === "downloading"} onClick={() => void install()}>{step === "downloading" ? "Downloading…" : step === "ready" || step === "permission" ? "Install" : "Download and install"}</button>
            : <button type="button" className={styles.btn} disabled={step === "checking"} onClick={() => void check()}>{step === "checking" ? "Checking…" : "Check for updates"}</button>}
        </div>
      </article> : null}
      {note ? <p className={styles.muted} role="status">{note}</p> : null}
    </div>
  );
}

/** PRESENCE-ONBOARD: what the phone lets Pulse notice. Joining the office Wi-Fi works with location "while using";
 *  arriving without Wi-Fi (the office area) needs "Allow all the time" (iOS: "Always"): both are asked in POLISH-1's
 *  two-step sheet, with Pulse's explanation and the consent terms, only on a tap. */
function ArrivalPermissions({ presence, platform, onChanged }: { presence: ShellPresence; platform: ShellInfo["platform"]; onChanged: (p: ShellPresence) => void }) {
  const [open, setOpen] = useState(false);
  const arrival = presence.arrival ?? { location: false, background: false };
  return <div className={styles.stack}>
    <p><b>Arrival</b>: office Wi-Fi {arrival.location ? "on" : "needs location “while using”"} · office area {arrival.background ? "on" : `needs “${platform === "ios" ? "Always" : "Allow all the time"}”`}.</p>
    <div className={styles.inline}>
      {!arrival.location || !arrival.background ? <button type="button" className={styles.btn} onClick={() => setOpen(true)}>{arrival.location ? "Notice arrival with Pulse closed" : "Allow location while using Pulse"}</button> : null}
    </div>
    {open ? <ArrivalSetup presence={presence} platform={platform} onChanged={onChanged} onClose={() => setOpen(false)} /> : null}
  </div>;
}
