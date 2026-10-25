"use client";
// What the Pulse phone app (the Capacitor shell) adds to this same web app, mounted once for a signed-in person. In a
// browser `shell()` is null and nothing here runs.
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { closeTopLayer } from "@pulse/ui-shell";
import { useEffect, useState } from "react";
import { ATTENDANCE_KEY } from "./lib/attendance-recovery.mjs";
import { enrollShell } from "./lib/shell-enrollment.mjs";
import { attendanceShell, shell } from "./lib/native-shell";
import { ArrivalPrompt } from "./arrival-setup";
import { NotifyPermission } from "./notify-permission";
import { BrowserNotifyAsk } from "./notify-status";
import { useInShell } from "./use-in-shell";
import css from "./shell-bridge.module.css";

export function ShellBridge({ person, via, staff = true }: { person: string; via?: string; /** UI-POLISH (R120): a client seat has no browser pings. */ staff?: boolean }) {
  const inShell = useInShell();
  useKeyboardFocus();
  useEffect(() => {
    const s = shell(); if (!s) return;
    // Only a Pulse sign-in on this phone can register it (the shell's device is bound to that sign-in).
    let active = true;
    const enroll = () => { if (via === "password" && document.visibilityState === "visible") void enrollShell(person, s, fetch, () => active).then(() => { if (active) window.dispatchEvent(new Event("pulse:shell-status")); }).catch(() => { if (active) window.dispatchEvent(new Event("pulse:shell-status")); }); };
    enroll();
    window.addEventListener("online", enroll);
    window.addEventListener("pulse:shell-enroll", enroll);
    // Status and navigation bars follow Pulse's light or dark theme.
    const root = document.documentElement;
    const theme = () => void s.setTheme({ dark: root.dataset.theme === "dark" }).catch(() => {});
    theme();
    const watch = new MutationObserver(theme); watch.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    // Android back closes what is open (a sheet, a drawer, search) before it goes back a page.
    const w = window as unknown as { __pulseBack?: () => boolean };
    w.__pulseBack = () => {
      // FLOAT-2: an open menu or panel (Pip's menu, the bell, the account menu, More) closes first.
      if (closeTopLayer()) return true;
      if (document.querySelector('[aria-modal="true"], dialog[open]')) { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; }
      // POLISH-1: a page may take back for a view of its own (an open chat on a phone returns to the chat list).
      const back = new Event("pulse:back", { cancelable: true }); window.dispatchEvent(back);
      return back.defaultPrevented;
    };
    // Coming back to the app shows fresh numbers.
    const resumed = () => { if (document.visibilityState === "visible") { enroll(); window.dispatchEvent(new Event("pulse:data-changed")); } };
    document.addEventListener("visibilitychange", resumed);
    return () => { active = false; watch.disconnect(); delete w.__pulseBack; document.removeEventListener("visibilitychange", resumed); window.removeEventListener("online", enroll); window.removeEventListener("pulse:shell-enroll", enroll); };
  }, [person, via]);
  useEffect(() => {
    const surfaces = attendanceShell(); if (!surfaces) return;
    const refresh = () => { if (document.visibilityState === "visible") void surfaces.refresh({ personId: person }).catch(() => {}); };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("pulse:attendance", refresh);
    window.addEventListener("pulse:shell-status", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => { clearInterval(timer); window.removeEventListener("pulse:attendance", refresh); window.removeEventListener("pulse:shell-status", refresh); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("online", refresh); };
  }, [person]);
  // RELEASE-3: a browser asks once too (notify-status.tsx); the phone app asks in notify-permission.tsx.
  return inShell ? <><PullToRefresh /><NotifyPermission /><ArrivalPrompt /></> : staff ? <BrowserNotifyAsk /> : null;
}

/** Pull down at the top of a page to refresh it, like any phone app; the page itself never reloads. */
function PullToRefresh() {
  const router = useRouter();
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let start = 0, distance = 0, active = false;
    const scrolled = (el: Element | null) => { for (let x = el; x && x !== document.documentElement; x = x.parentElement) if (x.scrollTop > 0) return true; return false; };
    const down = (e: TouchEvent) => {
      active = e.touches.length === 1 && window.scrollY <= 0 && !document.querySelector('[aria-modal="true"]') && !scrolled(e.target as Element) && !(e.target as Element).closest("textarea, [role=log], [data-no-pull]");
      start = e.touches[0]?.clientY ?? 0; distance = 0;
    };
    const move = (e: TouchEvent) => { if (!active) return; distance = Math.max(0, (e.touches[0]?.clientY ?? start) - start); setPull(Math.min(96, distance * 0.45)); };
    const up = () => {
      if (!active) return; active = false;
      if (distance * 0.45 < 60) { setPull(0); return; }
      setBusy(true); setPull(52);
      router.refresh(); window.dispatchEvent(new Event("pulse:data-changed"));
      window.setTimeout(() => { setBusy(false); setPull(0); }, 900);
    };
    window.addEventListener("touchstart", down, { passive: true });
    window.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("touchend", up, { passive: true });
    window.addEventListener("touchcancel", up, { passive: true });
    return () => { window.removeEventListener("touchstart", down); window.removeEventListener("touchmove", move); window.removeEventListener("touchend", up); window.removeEventListener("touchcancel", up); };
  }, [router]);
  if (!pull) return null;
  return <div className={css.pull} style={{ transform: `translate(-50%, ${pull}px)`, opacity: Math.min(1, pull / 52) }} role="status" aria-label={busy ? "Refreshing" : "Pull to refresh"}>
    <RefreshCw size={18} className={busy ? css.spin : undefined} style={busy ? undefined : { transform: `rotate(${pull * 4}deg)` }} aria-hidden="true" />
  </div>;
}

/** The sign-in page inside the phone app. POLISH-2 (QA-E2E P2-22): it no longer ends the phone's registration. It
 *  showed whenever a session simply expired (or someone chose "switch account"), and every time it revoked the phone,
 *  so the widget, arrival questions and notifications stopped until the next sign-in. A registration that really ended
 *  (signed out everywhere, the device removed) answers 401 and the app forgets it then; another person signing in on
 *  this phone replaces it (enrollShell). */
export function ShellSignedOut() {
  useKeyboardFocus();
  useEffect(() => {
    try { localStorage.removeItem(ATTENDANCE_KEY); } catch { /* storage unavailable */ }
    const s = shell(); if (!s) return;
    const root = document.documentElement;
    const theme = () => void s.setTheme({ dark: root.dataset.theme === "dark" }).catch(() => {});
    theme();
    const watch = new MutationObserver(theme); watch.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => watch.disconnect();
  }, []);
  return null;
}

/** Android's resized WebView and iOS's visual viewport must leave the active field above the keyboard. */
function useKeyboardFocus() {
  useEffect(() => {
    if (!shell()) return;
    let frame = 0;
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const field = document.activeElement;
        if (!(field instanceof HTMLElement) || !field.matches("input,textarea,[contenteditable=true]")) return;
        const viewport = window.visualViewport;
        const top = viewport?.offsetTop ?? 0, bottom = top + (viewport?.height ?? innerHeight);
        const bounds = field.getBoundingClientRect();
        if (bounds.bottom > bottom - 80 || bounds.top < top + 56) field.scrollIntoView({ block: "center", behavior: "instant" });
      });
    };
    window.visualViewport?.addEventListener("resize", reveal);
    window.addEventListener("resize", reveal);
    document.addEventListener("focusin", reveal);
    return () => { cancelAnimationFrame(frame); window.visualViewport?.removeEventListener("resize", reveal); window.removeEventListener("resize", reveal); document.removeEventListener("focusin", reveal); };
  }, []);
}
