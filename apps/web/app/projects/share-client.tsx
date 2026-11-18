"use client";
import { useState } from "react";
import { Link2 } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Modal, post } from "../records";
import { styles } from "../ui";
import css from "./overview.module.css";

/** KAZUK (28 Oct 2026): the client timeline link. A new link replaces the old one; the link is shown once, to copy into
 *  the client group's description. Pulse never sends it. */
export function ShareTimeline({ projectId, active }: { projectId: string; active: boolean }) {
  const [open, setOpen] = useState(false), [url, setUrl] = useState<string | null>(null), [on, setOn] = useState(active), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function make(revoke = false) {
    setBusy(true); setError("");
    try { const r = await post<{ active: boolean; path?: string }>(`projects/${projectId}/share`, revoke ? { revoke: true } : {}); setOn(r.active); setUrl(r.path ? `${window.location.origin}${r.path}` : null); }
    catch (err) { setError(err instanceof Error ? err.message : "That did not work. Try again."); } finally { setBusy(false); }
  }
  async function copy() { if (!url) return; try { await navigator.clipboard.writeText(url); notify({ id: "share", tone: "success", title: "Link copied", message: "Paste it into the client group's description.", timeout: 3000 }); } catch { /* the field stays selectable */ } }
  return <><button type="button" className={styles.btn} onClick={() => setOpen(true)}><Link2 size={13} aria-hidden="true" />Client timeline link</button>
    {open ? <Modal title="Client timeline link" onClose={() => setOpen(false)} foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Close</button></div>}>
      <div className={css.form}>
        <p className={css.hint}>A read-only page for the client: the stages and steps of this project with their dates and what is done. No names, notes, money or internal chats. Pulse never sends it; paste it into the client group&apos;s description.</p>
        {url ? <div className={css.twoFields}><input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Client timeline link" /><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void copy()}>Copy</button></div>
          : <p className={css.hint}>{on ? "A link is active. Making a new one stops the old one." : "No link yet."}</p>}
        <div className={css.twoFields}>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void make()}>{on ? "Make a new link" : "Make the link"}</button>
          {on ? <button type="button" className={styles.btn} disabled={busy} onClick={() => void make(true)}>Stop the link</button> : null}
        </div>
        {error ? <p role="alert" className={css.problem}>{error}</p> : null}
      </div>
    </Modal> : null}</>;
}
