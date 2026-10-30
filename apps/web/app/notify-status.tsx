"use client";
// RELEASE-3 (owner: "turn this on"): every signed-in person is asked once whether Pulse may notify them. The Pulse
// phone app asks in notify-permission.tsx and the desktop app at its first start; a browser asks here, with a calm
// banner above the page (it never covers anything). Settings and Notifications show "Notifications: on/off" for this
// device, with the one way to turn them on and a test that reaches only the person themself.
import { BellOff, BellRing, Send, Volume2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useBackLayer } from "@pulse/ui-shell";
import { createPortal } from "react-dom";
import { post } from "./records";
import { shell } from "./lib/native-shell";
import { sharedJson } from "./lib/shared-get.mjs";
import { notificationSound } from "./lib/notification-sound";
import css from "./notify-permission.module.css";

export const BROWSER_ASKED = "pulse.notify.browser.asked";
type State = "unknown" | "late" | "on" | "off" | "blocked" | "unsupported" | "server";
/** QA-1024 (R087): this device's last known notification state, shown at once while a fresh check runs. */
const STATUS = "pulse.notify.status";
const still = () => () => {};
type Where = "browser" | "phone";
const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };
const browserSupported = () => typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;

async function webPushKey(): Promise<string | null> {
  // PERF: shared with the browser pings' read of the same settings on the same page load.
  return (await sharedJson<{ webPushKey?: string | null }>("/api/v0/companion/notification-settings"))?.webPushKey ?? null;
}

/** This device's state: the phone app's system setting, or the browser's permission and the server's push key. */
async function current(): Promise<{ where: Where; state: State }> {
  const s = shell();
  if (s) {
    const info = await s.info().catch(() => null);
    if (!info) return { where: "phone", state: "unknown" };
    return { where: "phone", state: info.notifications ? "on" : info.notificationsAsk === "denied" ? "blocked" : "off" };
  }
  if (!browserSupported()) return { where: "browser", state: "unsupported" };
  if (!await webPushKey()) return { where: "browser", state: "server" };
  return { where: "browser", state: Notification.permission === "granted" ? "on" : Notification.permission === "denied" ? "blocked" : "off" };
}

/** The browser asks only from a click; the subscription itself is made by BrowserPings (browser-pings.tsx). */
async function allow(where: Where): Promise<State> {
  const s = shell();
  if (where === "phone" && s) {
    const before = await s.info().catch(() => null);
    if (before?.notificationsAsk === "denied") { await s.openNotificationSettings().catch(() => {}); return "blocked"; }
    await s.requestNotifications().catch(() => null);
    return (await current()).state;
  }
  if (!browserSupported()) return "unsupported";
  const answer = await Notification.requestPermission().catch(() => "denied" as NotificationPermission);
  if (answer !== "granted") return answer === "denied" ? "blocked" : "off";
  // Wait for the enrolment's answer (BrowserPings reports it), so a test right after reaches this browser.
  await new Promise<void>((done) => {
    const finish = () => { window.removeEventListener("pulse:ping-status", finish); clearTimeout(timer); done(); };
    const timer = setTimeout(finish, 8000);
    window.addEventListener("pulse:ping-status", finish);
    window.dispatchEvent(new Event("pulse:enable-browser-pings"));
  });
  return "on";
}

async function sendTest(): Promise<string> {
  try {
    const r = await post<{ browsers: number; phones: number; webPush: boolean }>("companion/notification-test", {});
    const places = [r.browsers ? `${r.browsers} browser${r.browsers === 1 ? "" : "s"}` : "", r.phones ? `${r.phones} phone${r.phones === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
    return places ? `Test sent to your ${places}. It appears in a few seconds.` : "Test sent to your notifications in Pulse. No browser or phone is set up for notifications yet.";
  } catch (e) { return e instanceof Error ? e.message : "The test could not be sent."; }
}

function describe(where: Where, state: State) {
  switch (state) {
    case "on": return where === "phone" ? "On this phone." : "In this browser, also with Pulse closed.";
    case "off": return where === "phone" ? "Not allowed on this phone yet." : "Not allowed in this browser yet.";
    case "blocked": return where === "phone" ? "Turned off in this phone’s settings for Pulse." : "Blocked in this browser’s site settings: allow them from the icon left of the address.";
    case "unsupported": return "This browser can’t show them. The Pulse apps can.";
    case "server": return "You see notifications while Pulse is open. Alerts with Pulse closed aren’t switched on for your team yet.";
    case "late": return "Pulse couldn’t check this device just now. Notifications still show while Pulse is open.";
    default: return "Checking…";
  }
}

/** "Notifications: on/off" for this device, with Turn on and a test. Used in Settings and Notifications. */
export function NotificationStatus() {
  const [where, setWhere] = useState<Where>("browser"), [state, setState] = useState<State>("unknown");
  const [busy, setBusy] = useState(false), [note, setNote] = useState("");
  // QA-1024 (R087): the last known state shows at once instead of "Checking…" (a slow link fetched the push key for
  // seconds), and a check still running after 4 s says so plainly instead of waiting forever.
  const remembered = useSyncExternalStore(still, () => read(STATUS), () => null);
  const last = useMemo(() => { try { const v = remembered ? JSON.parse(remembered) as { where: Where; state: State } : null; return v && v.state && v.state !== "unknown" && v.state !== "late" ? v : null; } catch { return null; } }, [remembered]);
  useEffect(() => {
    let live = true;
    const check = () => {
      const late = window.setTimeout(() => { if (live) setState((s) => (s === "unknown" ? "late" : s)); }, 4000);
      void current().then((r) => { window.clearTimeout(late); if (!live) return; setWhere(r.where); setState(r.state); if (r.state !== "unknown") write(STATUS, JSON.stringify(r)); });
    };
    check();
    const back = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", back);
    return () => { live = false; document.removeEventListener("visibilitychange", back); };
  }, []);
  const pending = state === "unknown" || state === "late";
  const shownWhere = pending && last ? last.where : where, shown = pending && last ? last.state : state;
  async function turnOn() { setBusy(true); setNote(""); try { write(BROWSER_ASKED, "1"); setState(await allow(shownWhere)); } finally { setBusy(false); } }
  async function test() { setBusy(true); setNote(""); try { setNote(await sendTest()); } finally { setBusy(false); } }
  const on = shown === "on";
  return <div className={css.status} data-state={shown}>
    <span className={css.statusLine}>
      {on ? <BellRing size={16} aria-hidden="true" /> : <BellOff size={16} aria-hidden="true" />}
      <span><b>Notifications: {on ? "on" : shown === "unknown" ? "…" : shown === "late" ? "not checked" : shown === "server" ? "in Pulse only" : "off"}</b> <span className={css.statusDetail}>{describe(shownWhere, shown)}</span></span>
    </span>
    <span className={css.statusActions}>
      {shown === "off" || (shown === "blocked" && shownWhere === "phone") ? <button type="button" className={css.turnOn} disabled={busy} onClick={() => void turnOn()}>{shown === "blocked" ? "Open settings" : "Turn on"}</button> : null}
      {on ? <button type="button" className={css.test} disabled={busy} onClick={() => void test()}><Send size={14} aria-hidden="true" />Send a test</button> : null}
    </span>
    {shownWhere === "browser" ? <NotificationSound /> : null}
    {note ? <p role="status" className={css.statusNote}>{note}</p> : null}
  </div>;
}

function NotificationSound() {
  const on = useSyncExternalStore(notificationSound.subscribe, notificationSound.enabled, () => true);
  const [note, setNote] = useState("");
  async function preview() {
    const played = await notificationSound.play(true);
    setNote(played ? "That’s the chime for new alerts while Pulse is open." : "Sound could not play. Check this browser’s sound settings and your device volume.");
  }
  return <div className={css.sound}>
    <label><input type="checkbox" checked={on} onChange={(e) => { notificationSound.setEnabled(e.target.checked); setNote(""); }} />Notification sound in this browser</label>
    <button type="button" className={css.test} onClick={() => void preview()}><Volume2 size={14} aria-hidden="true" />Preview sound</button>
    <p role="status" className={css.statusNote}>{note || "A gentle two-note chime while Pulse is open. Quiet hours and Do not disturb still apply. With Pulse closed, your system controls the sound."}</p>
  </div>;
}

/** The browser's one question (FLOAT-2, device audit): a small "Turn on notifications" chip in the top bar, beside the
 *  bell, until the person answers it. A tap opens a short card under it (Allow / Not now, both inside the card). It
 *  covers nothing: the floating card it replaced sat over the chat composer, the sidebar and page arrows on a computer
 *  and took a fifth of a phone's screen. "Not now" is remembered in this browser. */
export function BrowserNotifyAsk() {
  const [state, setState] = useState<"hidden" | "ask" | "on" | "off">("hidden");
  const [busy, setBusy] = useState(false), [note, setNote] = useState(""), [open, setOpen] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const chip = useRef<HTMLButtonElement>(null), card = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  useBackLayer(open, () => setOpen(false));
  useEffect(() => {
    if (shell() || read(BROWSER_ASKED) || !browserSupported() || Notification.permission !== "default") return;
    let live = true;
    // Only where the server can push to browsers.
    void webPushKey().then((key) => { if (live && key && Notification.permission === "default" && !read(BROWSER_ASKED)) setState("ask"); });
    return () => { live = false; };
  }, []);
  // The chip's place: in the top bar's actions, just before the bell (or first, when there is no bell).
  useEffect(() => {
    if (state === "hidden") return;
    const actions = document.querySelector<HTMLElement>("[data-shell-actions]"); if (!actions) return;
    const bell = actions.querySelector<HTMLElement>("button[aria-controls='pulse-notices'], button[aria-haspopup='dialog'][aria-label^='Notifications']");
    const box = document.createElement("span"); box.dataset.notifyAsk = "";
    if (bell?.parentElement) bell.parentElement.insertBefore(box, bell); else actions.prepend(box);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the host exists only once the top bar is in the page
    setSlot(box);
    return () => { box.remove(); setSlot(null); };
  }, [state]);
  useEffect(() => {
    if (!open) return;
    const place = () => { const r = chip.current?.getBoundingClientRect(); if (r) setAt({ top: Math.round(r.bottom + 8), right: Math.max(8, Math.round(window.innerWidth - r.right)) }); };
    place();
    const away = (e: PointerEvent) => { const t = e.target as Node; if (!card.current?.contains(t) && !chip.current?.contains(t)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); chip.current?.focus(); } };
    window.addEventListener("resize", place); document.addEventListener("pointerdown", away); document.addEventListener("keydown", key);
    return () => { window.removeEventListener("resize", place); document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [open]);
  async function yes() {
    setBusy(true); write(BROWSER_ASKED, "1");
    try { const r = await allow("browser"); setState(r === "on" ? "on" : "off"); setOpen(r === "on"); } finally { setBusy(false); }
  }
  function notNow() { write(BROWSER_ASKED, "1"); setOpen(false); setState("hidden"); }
  if (state === "hidden" || state === "off" || !slot) return null;
  const on = state === "on";
  return <>{createPortal(
    <button ref={chip} type="button" className={css.askChip} data-on={on ? "" : undefined} aria-haspopup="dialog" aria-expanded={open}
      aria-label={on ? "Notifications are on" : "Turn on notifications"} title={on ? "Notifications are on" : "Turn on notifications"} onClick={() => setOpen((v) => !v)}>
      <BellRing size={16} aria-hidden="true" /><span>{on ? "Notifications on" : "Turn on notifications"}</span>
    </button>, slot)}
    {open && at ? createPortal(<div ref={card} className={css.askCard} role="dialog" aria-label="Notifications" style={{ top: at.top, right: at.right }} data-float-avoid="">
      {on ? <>
        <p><b>Notifications are on in this browser.</b> {note || "Send yourself a test to see one arrive."}</p>
        <div className={css.askActions}>
          <button type="button" className={css.later} onClick={() => { setOpen(false); setState("hidden"); }}>Done</button>
          <button type="button" className={css.turnOn} disabled={busy} onClick={() => { setBusy(true); void sendTest().then((m) => { setNote(m); setBusy(false); }); }}><Send size={14} aria-hidden="true" />Send a test</button>
        </div>
      </> : <>
        <p><b>Turn on notifications?</b> Pulse can remind you to check in and out, and tell you when an approval, a chat or a task needs you, also with this tab closed.</p>
        <div className={css.askActions}>
          <button type="button" className={css.later} disabled={busy} onClick={notNow}>Not now</button>
          <button type="button" className={css.turnOn} disabled={busy} onClick={() => void yes()}>Allow notifications</button>
        </div>
      </>}
    </div>, document.body) : null}
  </>;
}
