"use client";

import { useState } from "react";
import { PdfPages } from "../../erp/preview";
import css from "../../erp/erp.module.css";

/** The client's answer: their typed name is their signature, kept with the time, an IP digest and their browser. */
export function AcceptAnswer({ token, pdf, canDecide, title }: { token: string; pdf: string | null; canDecide: boolean; title: string }) {
  const [name, setName] = useState(""), [note, setNote] = useState(""), [busy, setBusy] = useState(false), [done, setDone] = useState<string | null>(null), [error, setError] = useState("");
  const bytes = pdf ? Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0)) : null;
  async function answer(decision: "accepted" | "declined") {
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/accept/${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, name, note }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Your answer was not recorded");
      setDone(decision);
    } catch (e) { setError(e instanceof Error ? e.message : "Your answer was not recorded"); } finally { setBusy(false); }
  }
  return <>
    {canDecide && !done ? <div className={css.acceptBox}>
      <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Your full name (your signature)<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" style={{ height: 36, padding: "0 10px", borderRadius: 8, border: "1px solid var(--theme-border)", font: "inherit" }} /></label>
      <label style={{ display: "grid", gap: 4, fontSize: 13 }}>A note (optional)<textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} style={{ padding: 8, borderRadius: 8, border: "1px solid var(--theme-border)", font: "inherit" }} /></label>
      <p className={css.note}>By accepting, you agree to {title} as shown below. The time of your answer is recorded.</p>
      <div className={css.actionsBar}>
        <button type="button" disabled={busy || name.trim().length < 2} onClick={() => answer("accepted")} style={{ height: 38, padding: "0 18px", borderRadius: 8, border: 0, background: "var(--theme-action)", color: "var(--theme-action-text)", fontWeight: 600, cursor: "pointer" }}>Accept</button>
        <button type="button" disabled={busy || name.trim().length < 2} onClick={() => answer("declined")} style={{ height: 38, padding: "0 18px", borderRadius: 8, border: "1px solid var(--theme-border)", background: "var(--theme-surface)", color: "var(--theme-text)", cursor: "pointer" }}>Decline</button>
      </div>
      {error ? <p className={css.previewNote} role="alert">{error}</p> : null}
    </div> : null}
    {done ? <div className={css.acceptBox}><strong>Thank you. Your answer ({done}) is recorded.</strong><span className={css.note}>You can close this page.</span></div> : null}
    {bytes ? <PdfPages bytes={bytes} label={title} /> : null}
  </>;
}
