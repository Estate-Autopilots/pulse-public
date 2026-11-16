"use client";
// PORTAL-2: what the client said they paid on this document from their Pulse space ("I've paid", with a proof). Finance
// checks the bank, then confirms (the payment is recorded on the invoice and the client is told) or says it has not
// arrived (the client sees the note). The check task closes either way.
import { CheckCheck, FileImage, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { notify } from "@pulse/ui-shell";
import { inr } from "../../lib/client-pay.mjs";
import { styles } from "../../ui";
import css from "./documents.module.css";

type Claim = { id: string; amount: number; paidOn: string; method: string; reference: string | null; note: string | null; proofFileId: string | null; state: "waiting" | "confirmed" | "not_received";
  at: string; by: string | null; decidedAt: string | null; decidedNote: string | null; decidedBy: string | null; what: string | null; taskId: string | null };
const day = (s: string | null) => s ? new Date(s.length === 10 ? `${s}T12:00:00+05:30` : s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "";
const METHOD: Record<string, string> = { upi: "UPI", bank: "bank transfer", cheque: "cheque", cash: "cash", other: "another way" };

export function PortalClaims({ id, canWrite, onRecorded }: { id: string; canWrite: boolean; onRecorded: () => void }) {
  const [claims, setClaims] = useState<Claim[]>([]); const [busy, setBusy] = useState<string | null>(null); const [why, setWhy] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);
  useEffect(() => { let live = true;
    void fetch(`/api/v0/erp/documents/${id}/payment-claims`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((d) => { if (live) setClaims(d?.claims ?? []); }).catch(() => { if (live) setClaims([]); });
    return () => { live = false; }; }, [id, tick]);
  if (!claims.length) return null;
  const decide = async (c: Claim, decision: "confirmed" | "not_received") => { setBusy(c.id);
    try {
      const r = await fetch(`/api/v0/erp/payment-claims/${c.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, note: why[c.id] ?? "" }) });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d?.error ?? "That did not work");
      notify({ id: "portal-claim", tone: "success", title: decision === "confirmed" ? "Payment recorded" : "The client has been told", message: decision === "confirmed" ? `${inr(c.amount)} is on the invoice; the client sees it as received.` : "" });
      setTick((t) => t + 1); if (decision === "confirmed") onRecorded();
    } catch (e) { notify({ id: "portal-claim", tone: "error", title: "Not saved", message: e instanceof Error ? e.message : "" }); } finally { setBusy(null); } };
  return <section className={styles.panel} aria-label="Payments the client told us about" style={{ padding: 14, display: "grid", gap: 10 }}>
    <p className={css.label}>Paid, says the client</p>
    {claims.map((c) => <div key={c.id} className={css.note} style={{ display: "grid", gap: 8 }}>
      <span><b>{c.by ?? "The client"}</b> says they paid <b>{inr(c.amount)}</b> on {day(c.paidOn)} by {METHOD[c.method] ?? c.method}{c.reference ? `, reference ${c.reference}` : ""}. Told {day(c.at)}.</span>
      {c.note ? <q>{c.note}</q> : null}
      {c.proofFileId ? <a href={`/api/v0/client-files/${c.proofFileId}`} target="_blank" rel="noreferrer" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><FileImage size={14} aria-hidden="true" />Their proof</a> : null}
      {c.state === "waiting" ? canWrite ? <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={!!busy} onClick={() => void decide(c, "confirmed")}><CheckCheck size={13} aria-hidden="true" />{busy === c.id ? "Saving…" : "It arrived: record it"}</button>
        <input aria-label="What you see (for the client)" placeholder="Not in the bank yet? Say what you see" value={why[c.id] ?? ""} onChange={(e) => setWhy({ ...why, [c.id]: e.target.value })} maxLength={1000}
          style={{ flex: "1 1 220px", minHeight: 34, padding: "0 10px", borderRadius: 8, border: "1px solid var(--lx-line)", background: "var(--lx-surface)", color: "var(--lx-ink)" }} />
        <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!!busy || !(why[c.id] ?? "").trim()} onClick={() => void decide(c, "not_received")}><Undo2 size={13} aria-hidden="true" />Not received</button>
      </div> : <span>Finance checks it.</span>
        : <span>{c.state === "confirmed" ? `Recorded by ${c.decidedBy ?? "Finance"} ${day(c.decidedAt)}.` : `Not received (${c.decidedBy ?? "Finance"}, ${day(c.decidedAt)}): ${c.decidedNote ?? ""}`}</span>}
    </div>)}
  </section>;
}
