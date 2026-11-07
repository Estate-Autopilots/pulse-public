"use client";

import { ArrowRight, SlidersHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { notify } from "@pulse/ui-shell";
import { dayYear } from "../../lib/format";
import { Modal, post } from "../../records";
import { styles } from "../../ui";
import css from "../desk.module.css";
import { dayCount, type Balance, type LeaveType } from "../types";
import { SelectField } from "../../kit/select-field";

type Person = { id: string; name: string; balances: Balance[] };

/** Add days to a person's leave balance or take them away: opening balances and corrections. The reason stays on their record. */
export function AdjustBalance({ people, types, personId, year, trackingFrom, small }: { people: Person[]; types: LeaveType[]; personId?: string; year: number; trackingFrom: string; small?: boolean }) {
  const router = useRouter(); const formId = useId(); const allowance = types.filter((t) => t.annualDays !== null && t.active);
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [who, setWho] = useState(personId ?? ""); const [kind, setKind] = useState(allowance[0]?.key ?? ""); const [days, setDays] = useState(""); const [reason, setReason] = useState("");
  const person = people.find((p) => p.id === who); const balance = person?.balances.find((b) => b.key === kind); const n = Number(days); const valid = days !== "" && Number.isFinite(n) && n !== 0;
  const start = () => { setWho(personId ?? ""); setDays(""); setReason(""); setError(""); setOpen(true); };
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await post("hr/leave-adjustments", { personId: who, kind, days: n, reason });
      setOpen(false); notify({ id: "leave-adjust", tone: "success", title: `${person?.name ?? "Balance"}: ${n > 0 ? "added" : "took away"} ${dayCount(Math.abs(n))}`, timeout: 3000 }); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  }
  return <>
    <button type="button" className={`${styles.btn}${small ? ` ${styles.btnSmall} ${styles.btnGhost}` : ""}`} onClick={start}>{small ? null : <SlidersHorizontal size={14} aria-hidden="true" />}{small ? "Adjust" : "Adjust balance"}</button>
    {open ? (
      <Modal title={person && personId ? `Adjust ${person.name}'s leave balance` : "Adjust a leave balance"} onClose={() => setOpen(false)} foot={<div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(false)}>Cancel</button><button form={formId} className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !valid || !who}>{busy ? "Saving…" : "Save adjustment"}</button></div>}>
        <form id={formId} className={styles.modalBody} onSubmit={submit}>
          {personId ? null : <label className={`${styles.field} ${styles.wide}`}>Person<SelectField value={who} onChange={(event) => setWho(event.target.value)} required><option value="">Choose…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectField></label>}
          <label className={styles.field}>Leave type<SelectField value={kind} onChange={(event) => setKind(event.target.value)}>{allowance.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</SelectField></label>
          <label className={styles.field}>Days to add<input type="number" step="0.5" min="-60" max="60" value={days} onChange={(event) => setDays(event.target.value)} placeholder="e.g. 4 or -1.5" required /></label>
          <label className={`${styles.field} ${styles.wide}`}>Reason<input value={reason} onChange={(event) => setReason(event.target.value)} required minLength={3} maxLength={300} placeholder="e.g. Opening balance from the leave register" autoComplete="off" /></label>
          <span className={`${styles.inline} ${styles.wide}`}>
            <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setReason(`Opening balance on ${dayYear(trackingFrom)}`)}>Opening balance</button>
            <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setReason("Correction: ")}>Correction</button>
          </span>
          {balance ? <p className={css.preview}><span>Available for {year}:</span><b>{dayCount(balance.available)}</b>{valid ? <><ArrowRight size={13} aria-hidden="true" /><b>{dayCount(balance.available + n)}</b></> : null}</p> : null}
          <p className={styles.modalNote}>Pulse counts leave from {dayYear(trackingFrom)}. What a person had before that date goes in here as an opening balance. Use a minus to take days away. The person sees the adjustment and its reason on their leave record.</p>
        </form>
      </Modal>
    ) : null}
  </>;
}
