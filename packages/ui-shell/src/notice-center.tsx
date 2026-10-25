"use client";

import { useEffect } from "react";

export type NoticeTone = "error" | "info" | "success";
export type Notice = Readonly<{
  id: string;
  tone: NoticeTone;
  title: string;
  message?: string;
  /** A request reference the AC team can trace; shown short, copied in full. */
  reference?: string;
  action?: Readonly<{ label: string; run: () => void }>;
  /** The action opens this page (shown with an arrow, not a retry icon). */
  href?: string;
  /** Milliseconds it stays open; errors stay longer by default. */
  timeout?: number;
}>;

let notices: readonly Notice[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/**
 * Short confirmations and app-level problems. Since UX-NOTIFY (10 Oct 2026) there are no corner toasts: the web app's
 * Pip island takes each notice from here (subscribeNotices), shows it in the top bar and dismisses it. A repeated id
 * replaces the older notice.
 */
export function notify(notice: Notice) {
  notices = [...notices.filter((item) => item.id !== notice.id), notice].slice(-3);
  emit();
}

export function dismissNotice(id: string) {
  if (!notices.some((item) => item.id === id)) return;
  notices = notices.filter((item) => item.id !== id);
  emit();
}

/** For the island: notices waiting to be shown. */
export function currentNotices(): readonly Notice[] {
  return notices;
}

export function subscribeNotices(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Catches unexpected script failures so they never surface as a developer panel: one calm notice per burst, which
 * the island shows like any other. Renders nothing.
 */
export function NoticeCenter() {
  useEffect(() => {
    let last = 0;
    const glitch = () => {
      // One notice per burst; an error loop must not flood the screen.
      const now = Date.now();
      if (now - last < 4000) return;
      last = now;
      notify({
        id: "unexpected",
        tone: "error",
        title: "Something glitched on this screen",
        message: "Your calls and reports are safe. Reload to continue.",
        action: { label: "Reload", run: () => window.location.reload() },
      });
    };
    const onError = (event: ErrorEvent) => {
      // Resource and cross-origin script noise carry no error object.
      if (event.error) glitch();
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason as { name?: string } | null;
      if (reason?.name === "AbortError") return;
      glitch();
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
