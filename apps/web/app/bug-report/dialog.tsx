"use client";
// STAFF-UX (owner, 28 Oct 2026: "the bug reporter must work everywhere, also while a dialog or sheet is open; open it as
// a centred dialog over a dimmed page, a full-height sheet on a phone"). The reporter is a native modal <dialog> in the
// browser's top layer: above every z-index, sheet, menu and other modal dialog, and the page under it (another dialog's
// focus trap included) is inert until it closes. It lives in its own root on <body> marked data-bug-reporter, so the
// picture of the screen leaves it out. Keys typed in it stop at that root: Escape or Tab never reach a drawer below
// (whose document listener would close it or pull focus back), while the window's own Ctrl+B listener still runs first.
import { Bug, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { lockPageScroll } from "../kit/drawer";
import { REPORTER_MARK } from "./capture";
import { openBugReport } from "./open";
import styles from "./bug-report.module.css";

const subscribeNothing = () => () => {};
const KEYS = ["keydown", "keyup", "keypress"] as const;

/** One root on <body> for the reporter, made once in the browser. */
function useRoot(): HTMLElement | null {
  const browser = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!browser) return;
    const el = document.createElement("div");
    el.setAttribute(REPORTER_MARK, "");
    el.dataset.bugReporterRoot = "";
    document.body.appendChild(el);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the root exists only after it is attached
    setRoot(el);
    return () => { el.remove(); };
  }, [browser]);
  return root;
}

/** Keys pressed inside the reporter stay inside it (React's own listener on the root runs first). */
function useContainKeys(root: HTMLElement | null) {
  useEffect(() => {
    if (!root) return;
    const stop = (event: Event) => event.stopPropagation();
    for (const k of KEYS) root.addEventListener(k, stop);
    return () => { for (const k of KEYS) root.removeEventListener(k, stop); };
  }, [root]);
}

export function ReportDialog({ title, icon, context, onClose, footer, wide, children }: {
  title: string; icon?: ReactNode; context?: ReactNode; onClose: () => void; footer?: ReactNode; /** The mark-up step: as large as the window. */ wide?: boolean; children: ReactNode;
}) {
  const root = useRoot();
  useContainKeys(root);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  const pressed = useRef(false);
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const before = document.activeElement as HTMLElement | null;
    try { if (!el.open) el.showModal(); } catch { el.setAttribute("open", ""); }
    const unlock = lockPageScroll();
    return () => { unlock(); if (el.open) el.close(); if (before?.isConnected) before.focus?.({ preventScroll: true }); };
  }, [root]);
  if (!root) return null;
  return createPortal(
    <dialog ref={dialog} className={styles.dialog} data-wide={wide ? "" : undefined} aria-label={title}
      onCancel={(event) => { event.preventDefault(); close.current(); }}
      // A press that starts and ends on the dimmed page around the dialog closes it (the draft stays for next time).
      onPointerDown={(event) => { pressed.current = event.target === event.currentTarget; }}
      onClick={(event) => { if (pressed.current && event.target === event.currentTarget) close.current(); pressed.current = false; }}>
      <div className={styles.dialogBox}>
        <header className={styles.dialogHead}>
          <span className={styles.dialogIcon} aria-hidden="true">{icon}</span>
          <div className={styles.dialogTitle}><h2>{title}</h2>{context ? <div className={styles.dialogContext}>{context}</div> : null}</div>
          <button type="button" className={styles.dialogClose} aria-label="Close" onClick={() => close.current()}><X size={18} aria-hidden="true" /></button>
        </header>
        <div className={styles.dialogBody}>{children}</div>
        {footer}
      </div>
    </dialog>, root);
}

/** While recording: a small bar above everything (the top layer, not modal: the page is what is being shown). */
export function TopLayerBar({ children }: { children: ReactNode }) {
  const root = useRoot();
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bar.current as (HTMLDivElement & { showPopover?: () => void }) | null;
    try { el?.showPopover?.(); } catch { /* an older browser: the bar is a fixed layer */ }
  }, [root]);
  return root ? createPortal(<div ref={bar} popover="manual" className={styles.recordingBar} role="status">{children}</div>, root) : null;
}

/** A small "Report a bug" button in a corner, for pages with no account menu or palette (signed out, the profile gate). */
export function ReportTrigger() {
  const browser = useSyncExternalStore(subscribeNothing, () => true, () => false);
  if (!browser) return null;
  return createPortal(<button type="button" className={styles.trigger} data-capture-skip="" aria-label="Report a bug" title="Report a bug"
    onClick={() => openBugReport()}><Bug size={16} aria-hidden="true" /><span>Report a bug</span></button>, document.body);
}
