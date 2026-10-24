"use client";
// FEATURES-1024: the one-time note about telemetry for signed-in people: a small toast at the top that leaves by itself
// after about 6 s (or on a tap), seen for good once it has shown; it never covers the page's content or the phone's
// bottom bar, and never shows inside the chat's side panel (a framed page). The full words are in Settings → Privacy.
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Gauge, X } from "lucide-react";
import { TELEMETRY_NOTE } from "./privacy-note";
import css from "./telemetry-notice.module.css";

const KEY = "pulse.telemetry.notice.v1";
const SHOW_MS = 6000;
const never = () => () => {};
// Automated browsers (every test runner) never get it unless a test asks (pulse.telemetry.notice.v1.test).
const due = () => { try { return window.self === window.top && localStorage.getItem(KEY) !== "1" && (!navigator.webdriver || localStorage.getItem(`${KEY}.test`) === "1"); } catch { return false; } };

export function TelemetryNotice({ privacyHref }: { privacyHref: string }) {
  // Read once when the page opens: it shows if it has never been seen in this browser.
  const show = useSyncExternalStore(never, due, () => false);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!show) return;
    try { localStorage.setItem(KEY, "1"); } catch { /* private mode: it may show once more */ }
    const t = window.setTimeout(() => setGone(true), SHOW_MS);
    return () => window.clearTimeout(t);
  }, [show]);
  if (!show || gone) return null;
  return createPortal(<aside className={css.toast} role="status" aria-label={TELEMETRY_NOTE.title}>
    <Gauge size={16} aria-hidden="true" className={css.icon} />
    <p><b>{TELEMETRY_NOTE.title}.</b> {TELEMETRY_NOTE.toast} <Link href={privacyHref} onClick={() => setGone(true)}>Privacy</Link></p>
    <button type="button" className={css.x} onClick={() => setGone(true)} aria-label="Dismiss"><X size={15} /></button>
  </aside>, document.body);
}
