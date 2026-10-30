"use client";
// UI-UPGRADE (owner, 24 Oct 2026: "a sticky Save bar showing unsaved changes, toasts on save"): the bar a settings form
// shows while something is unsaved. It sticks to the bottom of the page (above a phone's tab bar, beside a floating
// Pip), says how many changes wait, and offers Discard and Save. The form shows its own toast on success.
import { Check, LoaderCircle } from "lucide-react";
import css from "./kit.module.css";
import { styles } from "../ui";

/** UI-POLISH-3: how many of a form's settings differ from what is saved, compared key by key by value (for `changes`). */
export function countChanges<T extends object>(saved: T, now: T): number {
  const a = saved as Record<string, unknown>, b = now as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).length;
}

export function SaveBar({ changes, busy = false, error, onSave, onDiscard, saveLabel = "Save changes", always = false, note, blocked }: {
  /** How many settings differ from what is saved. */ changes: number; busy?: boolean; error?: string; onSave: () => void; onDiscard?: () => void; saveLabel?: string;
  /** Shown even with nothing unsaved (a form whose Save is its only button). */ always?: boolean;
  /** UI-POLISH-3: the words while nothing is unsaved (instead of "Everything is saved"), e.g. what saving does. */ note?: string;
  /** UI-POLISH-3: why Save cannot run yet (a required choice is missing); Save stays off and the reason shows. */ blocked?: string;
}) {
  if (!changes && !busy && !error && !always) return null;
  return <div className={css.saveBar} role="region" aria-label="Unsaved changes" data-float-avoid="" data-dirty={changes ? "" : undefined}>
    <span className={css.saveText}>{changes ? <i aria-hidden="true" /> : null}{busy ? "Saving…" : changes ? (changes === 1 ? "1 unsaved change" : `${changes} unsaved changes`) : note ?? "Everything is saved"}
      {error ? <em role="alert">{error}</em> : blocked ? <em>{blocked}</em> : null}</span>
    {/* UI-POLISH-3: Discard and Save wrap together, to the right, when the bar is narrow (Save had dropped to a line alone). */}
    <span className={css.saveActions}>
      {onDiscard && changes ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={onDiscard}>Discard</button> : null}
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !!blocked || (!changes && !always)} onClick={onSave}>
        {busy ? <LoaderCircle size={15} className={css.saveSpin} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}{saveLabel}</button>
    </span>
  </div>;
}
