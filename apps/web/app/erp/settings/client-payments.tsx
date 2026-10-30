"use client";
// PORTAL-2: paying from the client's Pulse space. Off until Finance switches it on: then each unpaid invoice and
// instalment there has "Pay now" with these details (UPI opens the client's UPI app on a phone), and "I've paid" gives
// Finance a task to check it. A card payment gateway (Razorpay) needs its keys on the server first (decision
// portal-pay-gateway); until then this is bank transfer and UPI only.
import { CreditCard, Save } from "lucide-react";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { styles } from "../../ui";
import s from "./settings.module.css";

type Bank = { accountName?: string; bankName?: string; branch?: string; accountNumber?: string; ifsc?: string };
export type ClientPaySettings = { enabled: boolean; gateway: string; payee: string | null; upi: string | null; bank: Bank; note: string | null; templateBank: Bank; updatedAt: string | null; updatedBy: string | null; canEdit: boolean };
const BANK: [keyof Bank, string][] = [["accountName", "Account name"], ["bankName", "Bank"], ["branch", "Branch"], ["accountNumber", "Account number"], ["ifsc", "IFSC"]];

export function ClientPayments({ initial }: { initial: ClientPaySettings }) {
  const [v, setV] = useState(initial); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const readOnly = !v.canEdit;
  const save = async (enabled = v.enabled) => { setBusy(true); setError(null);
    try {
      const r = await fetch("/api/v0/erp/client-payments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled, payee: v.payee ?? "", upi: v.upi ?? "", bank: v.bank, note: v.note ?? "", gateway: "none" }) });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d?.error ?? "Not saved");
      setV(d); notify({ id: "client-pay", tone: "success", title: d.enabled ? "Clients can pay from their space" : "Saved", message: d.enabled ? "Unpaid invoices and instalments show Pay now." : "" });
    } catch (e) { setError(e instanceof Error ? e.message : "Not saved"); } finally { setBusy(false); } };
  return <section className={s.card} id="client-payments" aria-labelledby="client-pay-h">
    <div className={s.head}><h2 id="client-pay-h">Payments in the client space</h2><small>{v.enabled ? "On: clients see Pay now" : "Off"}{v.updatedBy ? ` · changed by ${v.updatedBy}` : ""}</small></div>
    <label className={s.toggle}>
      <input type="checkbox" className={s.switch} checked={v.enabled} disabled={busy || readOnly} onChange={(e) => void save(e.target.checked)} />
      <span className={s.toggleText}>Let clients pay from their Pulse space<small>They pay you by UPI or bank transfer, then press “I&apos;ve paid”; Finance gets a task to check the bank and record it.</small></span>
    </label>
    <div className={s.fields}>
      <label className={styles.field}>Pay to (name they see)<input value={v.payee ?? ""} onChange={(e) => setV({ ...v, payee: e.target.value })} maxLength={120} disabled={readOnly} /></label>
      <label className={styles.field}>UPI ID<input value={v.upi ?? ""} onChange={(e) => setV({ ...v, upi: e.target.value.trim() })} placeholder="name@bank" maxLength={330} disabled={readOnly} autoCapitalize="none" spellCheck={false} /></label>
      {BANK.map(([k, label]) => <label key={k} className={styles.field}>{label}<input value={v.bank?.[k] ?? ""} onChange={(e) => setV({ ...v, bank: { ...v.bank, [k]: e.target.value } })} maxLength={120} disabled={readOnly} /></label>)}
      <label className={`${styles.field} ${s.wide}`}>A line for clients <span className={s.hint}>(optional, for example: “Add the invoice number in the remark”)</span>
        <input value={v.note ?? ""} onChange={(e) => setV({ ...v, note: e.target.value })} maxLength={1000} disabled={readOnly} /></label>
    </div>
    {Object.values(v.templateBank ?? {}).some(Boolean) ? <p className={s.quiet}>The bank details start from your invoice template&apos;s; change them here for the client space only.</p> : null}
    <p className={s.quiet}><CreditCard size={13} aria-hidden="true" style={{ verticalAlign: "-2px" }} /> <b>Cards and net banking</b>: not connected. A payment gateway (Razorpay) needs its keys added on the server first; until then clients pay by UPI or bank transfer.</p>
    {error ? <p className={`${s.quiet} ${s.bad}`} role="alert">{error}</p> : null}
    {v.canEdit ? <div className={s.actions}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void save()}><Save size={14} aria-hidden="true" />{busy ? "Saving…" : "Save details"}</button></div> : null}
  </section>;
}
