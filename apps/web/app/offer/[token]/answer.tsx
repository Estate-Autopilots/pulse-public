"use client";

import { useState } from "react";
import { PdfPages } from "../../erp/preview";
import css from "../../erp/erp.module.css";

/** The person's answer: their typed name is their signature, kept with the time, an IP digest and their browser. */
export function OfferAnswer({ token, pdf, canDecide, company }: { token: string; pdf: string | null; canDecide: boolean; company: string }) {
  const [name, setName] = useState(""), [note, setNote] = useState(""), [busy, setBusy] = useState(false), [done, setDone] = useState<string | null>(null), [error, setError] = useState("");
  const bytes = pdf ? Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0)) : null;
  async function answer(decision: "accepted" | "declined") {
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/offer/${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, name, note }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Your answer was not recorded");
      setDone(decision);
    } catch (e) { setError(e instanceof Error ? e.message : "Your answer was not recorded"); } finally { setBusy(false); }
  }
  return <>
    {canDecide && !done ? <div className={css.acceptBox}>
      <p className={css.note}>Read the letter below. To accept, type your full name: it is your signature, kept with the time of your answer.</p>
      <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Your full name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" style={{ height: 38, padding: "0 10px", borderRadius: 8, border: "1px solid var(--theme-border)", font: "inherit" }} /></label>
      <label style={{ display: "grid", gap: 4, fontSize: 13 }}>A note to {company} (optional)<textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} style={{ padding: 8, borderRadius: 8, border: "1px solid var(--theme-border)", font: "inherit" }} /></label>
      <div className={css.actionsBar}>
        <button type="button" disabled={busy || name.trim().length < 2} onClick={() => answer("accepted")} style={{ height: 40, padding: "0 20px", borderRadius: 8, border: 0, background: "var(--theme-action)", color: "var(--theme-action-text)", fontWeight: 600, cursor: "pointer" }}>Accept the offer</button>
        <button type="button" disabled={busy || name.trim().length < 2} onClick={() => answer("declined")} style={{ height: 40, padding: "0 18px", borderRadius: 8, border: "1px solid var(--theme-border)", background: "var(--theme-surface)", color: "var(--theme-text)", cursor: "pointer" }}>Decline</button>
      </div>
      {error ? <p className={css.previewNote} role="alert">{error}</p> : null}
    </div> : null}
    {done ? <div className={css.acceptBox}><strong>{done === "accepted" ? `Welcome. Your acceptance is recorded; ${company} will be in touch about your first day.` : "Your answer is recorded. Thank you for letting us know."}</strong><span className={css.note}>You can close this page.</span></div> : null}
    {bytes ? <PdfPages bytes={bytes} label="Offer letter" /> : null}
  </>;
}
