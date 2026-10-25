"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../../records";
import { Badge, Empty, styles } from "../../../ui";
import { Receipt } from "lucide-react";
import { day, rupees, type Claim } from "../model";
import css from "../pay.module.css";

/** One card per claim: the bill, what it was for, approve or reject (a note to reject). */
export function ClaimQueue({ claims, focus }: { claims: Claim[]; focus?: string }) {
  const router = useRouter(), [notes, setNotes] = useState<Record<string, string>>({}), [busy, setBusy] = useState("");
  async function decide(id: string, action: string) {
    setBusy(id);
    try { const r = await post<{ status: string }>(`comp/claims/${id}/decide`, { action, note: notes[id] ?? "" }); notify({ id: "comp", tone: "success", title: r.status === "head_approved" ? "Approved: HR or a founder approves it too" : `Claim ${r.status}`, timeout: 3500 }); router.refresh(); }
    catch (e) { notify({ id: "comp", tone: "error", title: e instanceof Error ? e.message : "Could not save", timeout: 5000 }); } finally { setBusy(""); }
  }
  if (!claims.length) return <section className={styles.panel}><Empty icon={Receipt} first title="No claims wait for you" text="When someone you approve for claims a reimbursement, it appears here." /></section>;
  return <ul className={css.claims}>{claims.map((k) => <li key={k.id} data-focus={k.id === focus ? "" : undefined}>
    <a className={css.bill} href={`/api/v0/comp/claims/${k.id}/receipt`} target="_blank" rel="noreferrer" aria-label={`The bill from ${k.name}`}>
      {k.receiptMime.startsWith("image/")
        // eslint-disable-next-line @next/next/no-img-element -- a private bill, not a public asset
        ? <img src={`/api/v0/comp/claims/${k.id}/receipt`} alt="" /> : <span>PDF</span>}</a>
    <div className={css.claimText}>
      <p><b>{rupees(k.amount)}</b> · {k.vendor ?? k.category} · {day(k.spentOn)}</p>
      <p><Link href={`/people/pay/${k.person}`}>{k.name}</Link>{k.pod ? ` · ${k.pod}` : ""}{k.note ? ` · ${k.note}` : ""}</p>
      <p>{k.status === "head_approved" ? <Badge tone="warning">Approved by {k.headBy}: second approval</Badge> : k.aboveThreshold ? <Badge tone="warning">Above the limit: HR or a founder approves too</Badge> : <Badge>Waiting</Badge>}</p>
      <label className={styles.field}>Note<input value={notes[k.id] ?? ""} onChange={(e) => setNotes({ ...notes, [k.id]: e.target.value })} maxLength={1000} placeholder="Needed to reject" /></label>
      <div className={css.rowTools}><button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy === k.id || !(notes[k.id] ?? "").trim()} onClick={() => decide(k.id, "reject")}>Reject</button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy === k.id} onClick={() => decide(k.id, "approve")}>Approve</button></div>
    </div>
  </li>)}</ul>;
}
