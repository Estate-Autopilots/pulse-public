"use client";
// PEOPLE-CONTACTS (owner, 11 Oct 2026): bank details for salary, filled in by the person or by HR. The IFSC is checked
// as it is typed and names the bank and branch (GET /api/v0/ifsc/:code); the account number is typed twice and never
// shown again after saving (only the last four digits). The API seals it (PRESENCE-2) before the database sees it.
import { Check, CircleAlert, Landmark, LoaderCircle } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { styles } from "../ui";
import css from "./bank-form.module.css";

export type IfscAnswer = { ifsc: string; valid: boolean; known: boolean | null; bank: string | null; branch: string | null; city: string | null; state: string | null; source: string };
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export type BankInput = { holder: string; bank: string; branch: string; ifsc: string; account: string; confirm: string; upi: string };

/** The form itself; `onSave` posts it (to onboarding/:person/bank) and throws with the API's sentence. */
export function BankForm({ holder, onSave, onCancel, submitLabel = "Save bank details", note }: {
  holder: string; onSave: (data: BankInput) => Promise<void>; onCancel?: () => void; submitLabel?: string; note?: string;
}) {
  const uid = useId();
  const [ifsc, setIfsc] = useState(""), [bank, setBank] = useState(""), [branch, setBranch] = useState("");
  const [answer, setAnswer] = useState<IfscAnswer | null>(null), [looking, setLooking] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [account, setAccount] = useState(""), [confirm, setConfirm] = useState("");
  const code = ifsc.replace(/\s/g, "").toUpperCase();
  // Ask once the code is complete; a typed bank or branch is never overwritten.
  useEffect(() => {
    if (!IFSC.test(code)) return;
    let live = true;
    const t = window.setTimeout(() => {
      setLooking(true);
      fetch(`/api/v0/ifsc/${code}`, { cache: "force-cache" }).then((r) => r.ok ? r.json() : null).then((a: IfscAnswer | null) => {
        if (!live || !a) return; setAnswer(a);
        if (a.bank) setBank((b) => b.trim() ? b : a.bank!); if (a.branch) setBranch((b) => b.trim() ? b : [a.branch, a.city].filter(Boolean).join(", "));
      }).catch(() => {}).finally(() => { if (live) setLooking(false); });
    }, 250);
    return () => { live = false; window.clearTimeout(t); };
  }, [code]);
  // An answer counts only for the code now typed.
  const found = answer?.ifsc === code ? answer : null;
  const digits = (s: string) => s.replace(/[\s-]/g, "");
  const mismatch = confirm.length > 0 && digits(confirm) !== digits(account).slice(0, digits(confirm).length);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError("");
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try { await onSave({ holder: String(f.get("holder") ?? ""), bank, branch, ifsc: code, account: digits(account), confirm: digits(confirm), upi: String(f.get("upi") ?? "").trim() }); }
    catch (x) { setError(x instanceof Error ? x.message : "Not saved"); } finally { setBusy(false); }
  }
  const status = !code ? null : !IFSC.test(code) ? (code.length >= 11 ? { tone: "bad", text: "An IFSC has 11 characters: 4 letters, a zero, then 6 letters or digits." } : null)
    : looking && !found ? { tone: "wait", text: "Looking up the branch…" }
      : found?.known === false ? { tone: "bad", text: "This IFSC is not in the RBI list. Check it on a cheque or the passbook." }
        : found?.bank ? { tone: "ok", text: [found.bank, found.branch].filter(Boolean).join(" · ") } : null;
  return (
    <form className={css.form} onSubmit={submit} autoComplete="off">
      <label className={css.field}><span>Account holder’s name</span><input name="holder" required minLength={2} maxLength={80} defaultValue={holder} /><small>Exactly as the bank has it.</small></label>
      <label className={css.field}><span>IFSC</span>
        <input name="ifsc" required value={ifsc} onChange={(e) => setIfsc(e.target.value.toUpperCase())} maxLength={11} placeholder="HDFC0001234" spellCheck={false} autoCapitalize="characters"
          aria-invalid={status?.tone === "bad"} aria-describedby={`${uid}-ifsc`} className={css.mono} />
        <small id={`${uid}-ifsc`} className={css.lookup} data-tone={status?.tone} role="status">
          {status?.tone === "wait" ? <LoaderCircle size={12} className={css.spin} aria-hidden="true" /> : status?.tone === "ok" ? <Check size={12} aria-hidden="true" /> : status?.tone === "bad" ? <CircleAlert size={12} aria-hidden="true" /> : null}
          {status?.text ?? "On a cheque or the passbook’s first page. The bank and branch fill in from it."}</small>
      </label>
      <div className={css.pair}>
        <label className={css.field}><span>Bank</span><input name="bank" required value={bank} onChange={(e) => setBank(e.target.value)} maxLength={60} placeholder="Fills in from the IFSC" /></label>
        <label className={css.field}><span>Branch</span><input name="branch" value={branch} onChange={(e) => setBranch(e.target.value)} maxLength={120} placeholder="Fills in from the IFSC" /></label>
      </div>
      <label className={css.field}><span>Account number</span><input name="account" required inputMode="numeric" value={account} onChange={(e) => setAccount(e.target.value)} maxLength={22} className={css.mono} autoComplete="off" /></label>
      <label className={css.field}><span>Account number again</span><input name="confirm" required inputMode="numeric" value={confirm} onChange={(e) => setConfirm(e.target.value)} maxLength={22} className={css.mono}
        aria-invalid={mismatch} onPaste={(e) => e.preventDefault()} autoComplete="off" />
        <small className={css.lookup} data-tone={mismatch ? "bad" : confirm && digits(confirm) === digits(account) ? "ok" : undefined}>{mismatch ? "The two numbers are different." : confirm && digits(confirm) === digits(account) ? "The numbers match." : "Typed again, not pasted, so a slip is caught."}</small></label>
      <label className={css.field}><span>UPI ID <i className={css.optional}>optional</i></span><input name="upi" maxLength={120} placeholder="name@okhdfcbank" spellCheck={false} autoCapitalize="none" /></label>
      <p className={css.note}><Landmark size={14} aria-hidden="true" /><span>{note ?? "Encrypted as soon as you save. Afterwards Pulse shows only the bank and the last four digits; HR opens the full number only to pay salaries, and every opening is logged."}</span></p>
      {error ? <p role="alert" className={css.error}>{error}</p> : null}
      <div className={css.actions}>
        {onCancel ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onCancel}>Cancel</button> : null}
        <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || mismatch}>{busy ? "Saving…" : submitLabel}</button>
      </div>
    </form>
  );
}
