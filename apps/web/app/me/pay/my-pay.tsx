"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FileDown, FileText, Receipt, ShieldCheck } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../records";
import { Badge, styles } from "../../ui";
import { ClaimForm, ComponentList } from "../../people/pay/flows";
import { day, ITEM_KIND, LETTER_KIND, monthName, PAY_TYPE, rupees, STATUS, type PersonPay } from "../../people/pay/model";
import css from "../../people/pay/pay.module.css";

const CLAIM: Record<string, [string, "neutral" | "warning" | "success" | "danger"]> = { submitted: ["With your head", "warning"], head_approved: ["With HR", "warning"], approved: ["Approved", "success"],
  rejected: ["Not approved", "danger"], withdrawn: ["Withdrawn", "neutral"] };

export type Payslip = { id: string; month: string; version: number; issuedAt: string; seenAt: string | null; pages: number; correction: boolean };

/** My money, opened up: pay now, payslips, the offer to answer, letters, claims (with "Claim a reimbursement") and items. */
export function MyPay({ p, payslips = [] }: { p: PersonPay; payslips?: Payslip[] }) {
  const router = useRouter(), [claiming, setClaiming] = useState(false), [name, setName] = useState(""), [busy, setBusy] = useState(false);
  const now = p.inForce, st = p.record ? STATUS[p.record.status] : null;
  const offer = (p.offers ?? []).find((o) => o.status === "sent");
  async function answer(decision: "accepted" | "declined") {
    setBusy(true);
    try { await post(`comp/offers/${offer!.id}/answer`, { decision, name }); notify({ id: "comp", tone: "success", title: decision === "accepted" ? "Offer accepted" : "Offer declined", timeout: 4000 }); router.refresh(); }
    catch (e) { notify({ id: "comp", tone: "error", title: e instanceof Error ? e.message : "Could not save", timeout: 5000 }); } finally { setBusy(false); }
  }
  return <div className={css.page}>
    {offer ? <section className={`${css.section} ${css.offerBox}`} aria-label="Your offer"><header><h2>Your offer: {offer.role}</h2><Badge tone="accent">Open until {day(offer.validUntil)}</Badge></header>
      <p>Starting {day(offer.startOn)} · {offer.figures ? `${rupees(offer.figures.monthly)} a month` : ""}{offer.probationDays ? ` · ${offer.probationDays} days' probation` : ""}</p>
      {offer.letterId ? <p><a href={`/api/v0/comp/letters/${offer.letterId}/pdf?inline=1`} target="_blank" rel="noreferrer"><FileText size={14} aria-hidden="true" /> Read the offer letter</a></p> : null}
      <label className={styles.field}>Type your full name to answer<input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" /></label>
      <div className={css.rowTools}><button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy || name.trim().length < 2} onClick={() => answer("declined")}>Decline</button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || name.trim().length < 2} onClick={() => answer("accepted")}>Accept the offer</button></div>
    </section> : null}

    <header className={css.hero}>
      <div className={css.heroText}><h1>Pay now</h1>
        <div className={css.chips}>{st ? <Badge tone={st.tone}>{st.label}</Badge> : <Badge>No pay record yet</Badge>}{p.employment.probationTo && p.record?.status === "probation" ? <span className={css.quiet}>Probation until {day(p.employment.probationTo)}</span> : null}</div></div>
      <div className={css.figure}>{now?.figures ? <><b>{now.payType === "hourly" && now.figures.rate ? `${rupees(now.figures.rate)} an hour` : rupees(now.figures.monthly)}</b>
        <span>{now.payType === "hourly" ? "" : "a month"}{now.figures.ctc && now.payType === "salary" ? ` · ${rupees(now.figures.ctc)} a year (CTC)` : ""}</span><small>{PAY_TYPE[now.payType]} since {day(now.effectiveOn)}</small></>
        : <><b>—</b><small>{p.keyring ? "HR has not recorded your pay in Pulse yet" : "Pay cannot be shown on this server yet"}</small></>}</div>
    </header>
    {now?.components?.length ? <section className={css.section} aria-label="By component"><header><h2>By component</h2></header><ComponentList items={now.components} /></section> : null}

    <section className={css.section} aria-label="Payslips"><header><FileText size={16} aria-hidden="true" /><h2>Payslips</h2></header>
      {payslips.length ? <ul className={css.list}>{payslips.map((s) => <li key={s.id}><span><b>{monthName(s.month)}{s.version > 1 ? ` · revised (version ${s.version})` : ""}</b><small>Issued {day(s.issuedAt.slice(0, 10))}{s.seenAt ? "" : " · new"}</small></span>
        <span className={css.letterLinks}><a href={`/api/v0/comp/payslips/${s.id}/pdf`} target="_blank" rel="noreferrer"><FileText size={13} aria-hidden="true" />Open</a></span></li>)}</ul>
        : <p className={css.quiet}>Your payslip arrives here each month once payroll is approved.</p>}
    </section>

    <section className={css.section} aria-label="Claims"><header><Receipt size={16} aria-hidden="true" /><h2>Reimbursements</h2><div className={css.tools}><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setClaiming(true)}>Claim a reimbursement</button></div></header>
      {p.approvals ? <p><Link href="/people/pay/claims">{p.approvals} {p.approvals === 1 ? "claim waits" : "claims wait"} for your approval</Link></p> : null}
      {(p.claims ?? []).length ? <ul className={css.list}>{(p.claims ?? []).map((k) => <li key={k.id}><span><b>{rupees(k.amount)}</b> · {k.vendor ?? k.category} · {day(k.spentOn)}<small>{k.note}{k.decisionNote ? ` · “${k.decisionNote}”` : ""}</small></span>
        <span className={css.rowTools}>{["submitted", "head_approved"].includes(k.status) ? <button type="button" className={styles.btn} onClick={async () => { await post(`comp/claims/${k.id}/decide`, { action: "withdraw" }).catch(() => undefined); router.refresh(); }}>Withdraw</button> : null}
          <Badge tone={CLAIM[k.status]?.[1]}>{CLAIM[k.status]?.[0] ?? k.status}</Badge></span></li>)}</ul> : <p className={css.quiet}>Snap the bill with your phone or upload a PDF; your head approves it and it is paid with the next payroll.</p>}
    </section>

    {(p.items ?? []).length ? <section className={css.section} aria-label="Bonuses and other items"><header><h2>Bonuses and other items</h2></header><ul className={css.list}>{(p.items ?? []).map((i) => <li key={i.id}><span><b>{ITEM_KIND[i.kind]} · {rupees(i.amount)}</b> · {monthName(i.forMonth)}<small>{i.reason}</small></span></li>)}</ul></section> : null}

    <section className={css.section} aria-label="Letters"><header><FileText size={16} aria-hidden="true" /><h2>Letters</h2></header>
      {(p.letters ?? []).length ? <ul className={css.list}>{(p.letters ?? []).map((l) => <li key={l.id}><span><b>{l.title}</b><small>{LETTER_KIND[l.kind]} · {day(l.issuedAt.slice(0, 10))}</small></span>
        <span className={css.letterLinks}><a href={`/api/v0/comp/letters/${l.id}/pdf?inline=1`} target="_blank" rel="noreferrer"><FileText size={13} aria-hidden="true" />Open</a><a href={`/api/v0/comp/letters/${l.id}/docx`}><FileDown size={13} aria-hidden="true" />Word</a></span></li>)}</ul>
        : <p className={css.quiet}>Letters about your pay (offer, revisions, confirmation) appear here when they are issued.</p>}
    </section>
    {(p.versions ?? []).length ? <section className={css.section} aria-label="Pay history"><header><h2>Pay history</h2></header><ul className={css.list}>{(p.versions ?? []).map((v) => <li key={v.id}><span><b>{v.figures ? rupees(v.figures.monthly) : "—"}</b> a month from {day(v.effectiveOn)}<small>{v.reason}</small></span>{v.inForce ? <Badge tone="success">Now</Badge> : null}</li>)}</ul></section> : null}
    <p className={css.quiet}><ShieldCheck size={13} aria-hidden="true" /> Only you, HR and the founders see your pay; every look is logged.</p>
    {claiming ? <ClaimForm categories={p.categories ?? []} threshold={p.threshold ?? null} onClose={() => setClaiming(false)} /> : null}
  </div>;
}
