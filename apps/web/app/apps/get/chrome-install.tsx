"use client";
import { useEffect, useState } from "react";
import { Bell, Download } from "lucide-react";
import css from "./get.module.css";

// WL-ONBOARD-FIX (17 Nov 2026): until the phone app reaches everyone, Willow Lane's staff use Chrome. Pulse installs as
// an app from Chrome (its own window and icon, opened from the desktop or the phone's apps), and notifications for
// check-in and check-out, tasks and messages come through Chrome even with Pulse closed. One button for each.
type Prompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
type State = "ready" | "installed" | "manual" | "apple";

const installed = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const apple = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const permission = () => typeof Notification === "undefined" ? "unsupported" : Notification.permission;

export function ChromeInstall() {
  // Where to find it in Chrome is said at once; Chrome's own offer (it comes after the page loads, or never in other
  // browsers) turns it into a button.
  const [state, setState] = useState<State>("manual");
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [pings, setPings] = useState<string>("default");
  useEffect(() => {
    const first = installed() ? "installed" : apple() ? "apple" : null;
    queueMicrotask(() => { if (first) setState(first); setPings(permission()); });
    const offer = (e: Event) => { e.preventDefault(); setPrompt(e as Prompt); setState("ready"); };
    const done = () => { setPrompt(null); setState("installed"); };
    window.addEventListener("beforeinstallprompt", offer);
    window.addEventListener("appinstalled", done);
    return () => { window.removeEventListener("beforeinstallprompt", offer); window.removeEventListener("appinstalled", done); };
  }, []);
  // One Install button always: Chrome's own install when it has offered one; otherwise it says where Chrome keeps it.
  const [how, setHow] = useState(false), [blocked, setBlocked] = useState(false);
  const install = async () => {
    if (!prompt) { setHow(true); return; }
    await prompt.prompt();
    const { outcome } = await prompt.userChoice.catch(() => ({ outcome: "dismissed" as const }));
    setPrompt(null); setState(outcome === "accepted" ? "installed" : "manual");
  };
  const turnOn = async () => {
    // Asked here, inside the click (browsers only ask then); the signed-in app then registers this browser for
    // notifications with the page closed (browser-pings.tsx listens for the event).
    const got = typeof Notification === "undefined" ? "unsupported" : await Notification.requestPermission().catch(() => Notification.permission);
    setPings(got);
    if (got === "granted") window.dispatchEvent(new Event("pulse:enable-browser-pings"));
  };
  const canInstall = state === "ready" || state === "manual";
  return <>
    {canInstall ? <button type="button" className={`${css.button} ${css.primary}`} onClick={() => void install()} data-testid="install-chrome"><Download size={16} aria-hidden="true" />Install on this device</button> : null}
    {state === "installed" ? <p className={css.hint} role="status" data-testid="install-state">Installed. Open Vitals OS from your desktop or apps.</p>
      : state === "apple" ? <p className={css.hint} role="status" data-testid="install-state">On an iPhone or iPad, use Safari: see iPhone and iPad below.</p>
        : how ? <p className={css.hint} role="status" data-testid="install-state">In Chrome, open the ⋮ menu and choose Install (on a computer: Cast, save and share, then Install page as app).</p>
          : <span className={css.sr} role="status" data-testid="install-state">{state === "ready" ? "Ready to install" : "Install from Chrome"}</span>}
    {pings === "granted" ? <p className={css.hint} role="status">Notifications are on.</p>
      : pings === "unsupported" ? null
        : <button type="button" className={css.button} onClick={() => { if (pings === "denied") setBlocked(true); else void turnOn(); }} data-testid="pings-chrome"><Bell size={16} aria-hidden="true" />Turn on notifications</button>}
    {blocked ? <p className={css.hint} role="status">This browser is blocking them. Tap the icon left of the web address, choose Notifications, then Allow.</p> : null}
  </>;
}
