"use client";
// UI-UPGRADE (owner, 24 Oct 2026: "a sticky Save bar showing unsaved changes, toasts on save"): the bar a settings form
// shows while something is unsaved. It sticks to the bottom of the page (above a phone's tab bar, beside a floating
// Pip), says how many changes wait, and offers Discard and Save. The form shows its own toast on success.
import { Check, LoaderCircle } from "lucide-react";
import css from "./kit.module.css";
import { styles } from "../ui";

export function SaveBar({ changes, busy = false, error, onSave, onDiscard, saveLabel = "Save changes", always = false }: {
  /** How many settings differ from what is saved. */ changes: number; busy?: boolean; error?: string; onSave: () => void; onDiscard?: () => void; saveLabel?: string;
  /** Shown even with nothing unsaved (a form whose Save is its only button). */ always?: boolean;
}) {
  if (!changes && !busy && !error && !always) return null;
  return <div className={css.saveBar} role="region" aria-label="Unsaved changes" data-float-avoid="" data-dirty={changes ? "" : undefined}>
    <span className={css.saveText}>{changes ? <i aria-hidden="true" /> : null}{busy ? "Saving…" : changes ? (changes === 1 ? "1 unsaved change" : `${changes} unsaved changes`) : "Everything is saved"}
      {error ? <em role="alert">{error}</em> : null}</span>
    {onDiscard && changes ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={onDiscard}>Discard</button> : null}
    <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || (!changes && !always)} onClick={onSave}>
      {busy ? <LoaderCircle size={15} className={css.saveSpin} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}{saveLabel}</button>
  </div>;
}
