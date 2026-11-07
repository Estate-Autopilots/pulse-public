"use client";

import { Check, Eye, EyeOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import type { HrRecord, PersonFlag } from "../lib/api";
import { post } from "../records";
import { styles } from "../ui";
import css from "./people.module.css";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const month = (value: string) => `${MONTHS[Number(value.slice(5, 7)) - 1]} ${value.slice(0, 4)}`;
const KIND = { monthly: "Base salary", current: "Current salary", increment: "Increment", total: "Total paid", invoice: "Invoice" } as const;
const TERMS = { proposed: "Proposed, pending acceptance", conditional: "Conditional", settled: "Settled", active: "In force" } as const;

/** Settle a "needs confirmation" question by choosing which source is right. */
export function FlagActions({ personId, flag }: { personId: string; flag: PersonFlag }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function choose(value: string) {
    setBusy(true);
    try { await post(`people/${personId}/flags/${flag.id}`, { value }); notify({ id: `flag:${flag.id}`, tone: "success", title: "Confirmed", message: "The record now uses this value and keeps it when sources sync.", timeout: 3000 }); router.refresh(); }
    catch (e) { notify({ id: `flag:${flag.id}`, tone: "error", title: "Not saved", message: e instanceof Error ? e.message : undefined }); } finally { setBusy(false); }
  }
  const text = (value: string) => flag.field === "status" ? (value === "active" ? "Still here" : "Has left") : value;
  return <span className={css.flagActions}>{flag.options.map((o) => (
    <button key={o.value} type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} title={o.source} onClick={() => choose(o.value)}><Check size={12} aria-hidden="true" />{text(o.value)}</button>
  ))}</span>;
}

/** Salary history. Figures stay hidden until asked for, so an open profile shows nothing over a shoulder. */
export function SalaryTable({ rows }: { rows: NonNullable<HrRecord["compensation"]> }) {
  const [shown, setShown] = useState(false);
  const money = (amount: number, currency: string) => new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  return <>
    <div className={styles.subhead} style={{ borderTop: 0 }}><span>{rows.length} entries from {new Set(rows.map((r) => r.sourceName)).size} sheets</span>
      <button type="button" className={`${styles.btn} ${styles.btnSmall}`} aria-pressed={shown} onClick={() => setShown(!shown)}>{shown ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}{shown ? "Hide figures" : "Show figures"}</button></div>
    <div className={styles.tableWrap}><table className={styles.table}>
      <thead><tr><th>Month</th><th>Entry</th><th className={styles.right}>Amount</th><th>Components / effective dates</th><th>Source</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id}>
          <td className={styles.nowrap}>{month(r.month)}</td><td className={styles.nowrap}>{KIND[r.kind]}{r.termsStatus ? <span className={styles.cellSub}>{TERMS[r.termsStatus]}</span> : null}{shown && r.termsNote ? <span className={styles.cellSub}>{r.termsNote}</span> : null}</td>
          <td className={`${styles.right} ${css.amount}`} data-hidden={shown ? undefined : ""}>{shown ? money(r.amount, r.currency) : "•••••"}</td>
          <td>{shown?<>{r.components&&Object.keys(r.components).length?Object.entries(r.components).map(([key,value])=><span key={key} className={styles.cellSub}>{key==='ctc'?'Annual CTC':key}: {money(value,r.currency)}</span>):<span className={styles.cellSub}>Components not stated in source</span>}</>:"•••••"}<span className={styles.cellSub}>{r.effectiveFrom??r.month}{r.effectiveTo?` → ${r.effectiveTo}`:" onwards"}</span></td><td className={css.srcCell}><span title={`${r.sourceName} › ${r.sourceSheet}. ${r.basis}`}>{r.sourceName} › {r.sourceSheet}</span></td>
        </tr>
      ))}</tbody>
    </table></div>
  </>;
}
