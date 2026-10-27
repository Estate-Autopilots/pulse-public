// BUG-REPORT (owner, 27 Oct 2026): opening the bug reporter from anywhere. The shortcut, a phone shake, the account
// menu, the command palette and an error screen's "Report this" all fire one window event; the reporter mounted once in
// the app frame (reporter.tsx) listens for it.
import { shortcutAction } from "../lib/bug-report.mjs";

export const REPORT_BUG_EVENT = "pulse:report-bug";
/** What the person was looking at when they chose Report on an error screen. */
export type ReportAbout = Readonly<{ title: string; reference?: string }>;

export function openBugReport(about?: ReportAbout): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ReportAbout | null>(REPORT_BUG_EVENT, { detail: about ?? null }));
}

/** A rich-text editor, where Ctrl+B means bold and is left alone (Ctrl+Shift+B still opens the reporter). */
function inEditor(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  return (el instanceof HTMLElement && el.isContentEditable) || !!el.closest('[contenteditable=""], [contenteditable="true"], [role="textbox"], [data-rich-text]');
}

/** Ctrl+B (⌘B on a Mac) reports a bug from any screen, a menu or panel open too; listened for before anything else on
 *  the page, so a menu that keeps its keys cannot swallow it. Inside a text editor Ctrl+B stays bold: Ctrl+Shift+B
 *  (⌘⇧B) works there and everywhere. */
export function installReportShortcut(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat || shortcutAction(event, inEditor(event.target)) !== "open") return;
    event.preventDefault();
    event.stopPropagation();
    openBugReport();
  };
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}

/** True on a Mac (for showing ⌘B instead of Ctrl+B). */
export const isMac = () => typeof navigator !== "undefined" && /Macintosh|Mac OS X|iPhone|iPad/.test(navigator.userAgent);
