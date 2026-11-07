"use client";
// FLOW-C: the daily update: what I work on today, written by Pulse from my open steps, for the team's group. Pulse copies
// it; it does not post it.
import { useState } from "react";
import { ClipboardCopy, Sun } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { styles } from "../ui";
import { flow, why } from "../processes/flow-client";
import css from "./work.module.css";
import m from "./screens.module.css";

export function DailyUpdate({ compact }: { compact?: boolean }) {
  const [text, setText] = useState<string | null>(null), [busy, setBusy] = useState(false);
  async function write() {
    setBusy(true);
    try { const r = await flow<{ text: string }>("daily-update"); setText(r.text); } catch (e) { notify({ id: "daily", tone: "error", title: "Not written", message: why(e) }); } finally { setBusy(false); }
  }
  async function copy() { try { await navigator.clipboard.writeText(text ?? ""); notify({ id: "daily", tone: "success", title: "Copied", message: "Paste it in the team's group.", timeout: 2500 }); } catch { /* the text stays on screen */ } }
  // On My steps: one press writes it and copies it.
  async function copyNow() {
    setBusy(true);
    try { const r = await flow<{ text: string }>("daily-update"); await navigator.clipboard.writeText(r.text); notify({ id: "daily", tone: "success", title: "Today's update copied", message: r.text.split("\n").slice(0, 3).join(" "), timeout: 4000 }); }
    catch (e) { notify({ id: "daily", tone: "error", title: "Not copied", message: why(e) }); } finally { setBusy(false); }
  }
  if (compact) return <button type="button" className={styles.btn} disabled={busy} onClick={() => void copyNow()} title="Written from your open steps, for the team's group"><Sun size={14} aria-hidden="true" />{busy ? "Writing…" : "Copy today's update"}</button>;
  return <section className={m.card} aria-label="Today's update">
    <h3><Sun size={15} aria-hidden="true" />Today&apos;s update<small>from your open steps, for the team&apos;s group</small></h3>
    {text === null ? <div className={m.row}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void write()}>{busy ? "Writing…" : "Write it"}</button></div>
      : <><textarea className={m.message} rows={Math.min(14, text.split("\n").length + 2)} value={text} onChange={(e) => setText(e.target.value)} aria-label="Today's update" />
        <div className={m.row}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void copy()}><ClipboardCopy size={14} aria-hidden="true" />Copy it</button>
          <button type="button" className={styles.btn} disabled={busy} onClick={() => void write()}>Write it again</button><small className={css.quiet}>Pulse does not post it.</small></div></>}
  </section>;
}
