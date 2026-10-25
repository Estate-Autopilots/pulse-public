"use client";

import {Payslip} from "../payslip";
import { Eye, EyeOff, Lock, Plus, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type FormEvent } from "react";
import { notify } from "@pulse/ui-shell";
import { dayTime, dayYear, plural, userId } from "../../lib/format";
import { Modal, post } from "../../records";
import { Avatar, Badge, Empty, Panel, Workspace, styles } from "../../ui";
import css from "../desk.module.css";
import type { Payroll } from "../types";
import { useOrgCode } from "../../org-code";
import { DateField } from "../../kit/date-field";
import { SelectField } from "../../kit/select-field";

type Figures = NonNullable<Payroll["figures"]>;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const month = (value: string) => `${MONTHS[Number(value.slice(5, 7)) - 1]} ${value.slice(0, 4)}`;
const TYPES: Record<string, string> = { full_time: "Full time", part_time: "Part time", intern: "Intern", contract: "Contract", freelance: "Freelance" };
const money = (amount: number, currency: string) => new Intl.NumberFormat("en-IN", { style: "currency", currency: currency || "INR", maximumFractionDigits: 0 }).format(amount);

/** Add a salary entry for one person. The amount goes straight to the restricted record and is never echoed back. */
function AddEntry({ people, today, onSaved }: { people: Payroll["people"]; today: string; onSaved: () => void }) {
  const router = useRouter(); const formId = useId(); const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const d = new FormData(event.currentTarget); setBusy(true); setError("");
    try {
      await post(`people/${d.get("personId")}/salary`, { month: d.get("month"), kind: d.get("kind"), amount: Number(d.get("amount")), note: d.get("note"), ...Object.fromEntries(["ctc","fixed","variable","bonus","reimbursements","deductions","effectiveFrom","effectiveTo"].map(key=>[key,d.get(key)])) });
      setOpen(false); notify({ id: "salary", tone: "success", title: "Salary entry saved", message: "Figures are hidden again. Show them to check the entry.", timeout: 3500 }); onSaved(); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  }
  return <>
    <button type="button" className={styles.btn} onClick={() => { setError(""); setOpen(true); }}><Plus size={14} aria-hidden="true" />Add salary entry</button>
    {open ? (
      <Modal title="Add a salary entry" onClose={() => setOpen(false)} foot={<div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(false)}>Cancel</button><button form={formId} className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Saving…" : "Save entry"}</button></div>}>
        <form id={formId} className={styles.modalBody} onSubmit={submit} autoComplete="off">
          <label className={`${styles.field} ${styles.wide}`}>Person<SelectField name="personId" required defaultValue=""><option value="" disabled>Choose…</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.status!=="active"?" · not current":""}</option>)}</SelectField></label>
          <label className={styles.field}>Kind of entry<SelectField name="kind" defaultValue="current"><option value="current">Current salary</option><option value="increment">Increment</option></SelectField></label>
          <label className={styles.field}>Applies from<input type="month" name="month" defaultValue={today.slice(0, 7)} required /></label>
          <label className={`${styles.field} ${styles.wide}`}>Amount per month, in rupees<input type="number" name="amount" min="1" step="1" required inputMode="numeric" /></label>
          {[["ctc","Annual CTC"],["fixed","Fixed per month"],["variable","Variable per month"],["bonus","Bonus for this entry"],["reimbursements","Reimbursements"],["deductions","Deductions"]].map(([key,label])=><label key={key} className={styles.field}>{label}<input type="number" name={key} min="0" step="0.01" placeholder="Unknown / not specified"/></label>)}
          <label className={styles.field}>Effective from<DateField name="effectiveFrom"/></label><label className={styles.field}>Effective until<DateField name="effectiveTo"/></label>
          <label className={`${styles.field} ${styles.wide}`}>Note<input name="note" maxLength={200} placeholder="e.g. Revised after the April review" /></label>
          <p className={styles.modalNote}>Saved to the restricted salary record with your name. The amount does not appear in notifications, the change history or anywhere outside this tab and the person’s HR tab.</p>
        </form>
      </Modal>
    ) : null}
  </>;
}

/** Payroll: the staff list carries no figures until someone asks for them, and asking is written to the access log. */
export function PayrollDesk({ data, today }: { data: Payroll; today: string }) {
  const orgCode = useOrgCode();
  const [figures, setFigures] = useState<Figures | null>(null); const [log, setLog] = useState(data.log); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const shown = figures !== null; const hide = () => setFigures(null);
  // Figures never outlive the moment they were asked for: leaving the tab hides them again.
  useEffect(() => {
    if (!shown) return;
    const onHide = () => { if (document.hidden) setFigures(null); };
    document.addEventListener("visibilitychange", onHide); return () => document.removeEventListener("visibilitychange", onHide);
  }, [shown]);
  async function show() {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/v0/hr/payroll?figures=1", { cache: "no-store" }); const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? "The figures could not be read");
      setFigures((body as Payroll).figures ?? []); setLog((body as Payroll).log ?? log);
    } catch (e) { setError(e instanceof Error ? e.message : "The figures could not be read"); } finally { setBusy(false); }
  }
  const current = data.people.filter((p) => p.status === "active").length; const by = new Map((figures ?? []).map((f) => [f.personId, f]));
  const hidden = <span className={css.amount} data-hidden="">•••••</span>;
  return <Workspace initial={0}>
    <p className={css.note} data-tone="warning"><Lock size={14} aria-hidden="true" /><span><b>Restricted to HR and leadership.</b> Salary never leaves this tab (no dashboards, no notifications), and every “Show figures” is logged with your name.</span></p>
    {/* COMP-A: pay changes, offers, probation, pauses, claims and exits now go through People & pay (maker-checker, letters). */}
    <p className={css.note}><span>To change someone&apos;s pay, make an offer, confirm a probation or settle an exit, use <Link href="/people/pay">People &amp; pay</Link>: HR proposes, a founder approves, a letter goes out.</span></p>
    <Panel title="Staff and salary" sub={`${plural(current, "current person", "current people")}${data.people.length > current ? ` · ${data.people.length - current} not current` : ""}`}
      tools={<>{data.canWrite ? <AddEntry people={data.people} today={today} onSaved={hide} /> : null}
        <button type="button" className={`${styles.btn}${shown ? "" : ` ${styles.btnPrimary}`}`} aria-pressed={shown} disabled={busy} onClick={shown ? hide : show}>{shown ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}{busy ? "Reading…" : shown ? "Hide figures" : "Show figures"}</button></>}>
      {error ? <p className={styles.panelFoot} role="alert" style={{ color: "var(--theme-danger)" }}>{error}</p> : null}
      <div className={styles.tableWrap}><table className={`${styles.table} ${css.payTable}`} data-figures={shown ? "" : undefined}>
        <thead><tr><th>Person</th><th>Employment</th><th>Joined</th><th className={styles.right}>Current salary</th>{shown ? <><th>Professional Tax</th><th>Net projection</th><th>Payslip</th><th>As of</th><th className={styles.right}>Entries</th><th>Bank details</th></> : null}</tr></thead>
        <tbody>{data.people.map((p) => { const f = by.get(p.id); return (
          <tr key={p.id} className={p.status === "active" ? undefined : css.pastRow}>
            <td><Link href={`/people/${p.id}?tab=hr`} className={styles.person}><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={26} /><span><span className={styles.cellLink}>{p.name}</span>
              <span className={styles.cellSub}>{[userId(p.userNo, orgCode), p.role, p.status === "active" ? null : "not current"].filter(Boolean).join(" · ")}</span></span></Link></td>
            <td className={styles.nowrap} data-label="Employment">{p.employmentType ? TYPES[p.employmentType] ?? p.employmentType : <span className={styles.muted}>Not set</span>}</td>
            <td className={styles.nowrap} data-label="Joined">{p.joinedOn ? dayYear(p.joinedOn) : <span className={styles.muted}>Not set</span>}</td>
            <td className={styles.right} data-label="Salary">{!shown ? hidden : f ? <span className={css.amount}>{money(f.amount, f.currency)}</span> : <span className={styles.muted}>No entry</span>}</td>
            {shown ? <>
              <td data-label="Professional Tax">{f?.ptReview?"HR review required":money(f?.professionalTax??0,f?.currency??"INR")}</td><td data-label="Net">{f?.net===null?"Awaiting tax review":f?.net!==undefined?money(f.net,f.currency):"—"}</td><td><Payslip personId={p.id} month={today.slice(0,7)}/></td>
              <td className={styles.nowrap} data-label="As of">{f ? <>{month(f.month)}{f.kind === "monthly" ? <span className={styles.cellSub}>From the salary sheet</span> : null}</> : <span className={styles.muted}>–</span>}</td>
              <td className={styles.right} data-label="Entries">{f ? f.entries : <span className={styles.muted}>0</span>}</td>
              <td data-label="Bank">{f?.bankOnFile ? <Badge tone="success">On file</Badge> : <Badge>Not on file</Badge>}</td>
            </> : null}
          </tr>
        ); })}</tbody>
      </table></div>
      <p className={styles.panelFoot}><span>{shown ? "On screen until you hide them or leave this tab. " : "Hidden until you ask. "}A person’s page has their full salary history and sources; Pulse keeps only whether bank details are on file, never the account.</span></p>
    </Panel>
    <Panel title="Access log" sub="Each time the salary figures were shown on this tab">
      {log.length ? <ul className={styles.timeline} style={{ paddingTop: 10 }}>{log.map((l, i) => <li key={i}><span><b>{l.viewer ?? "Unknown"}</b> viewed the salary figures of {plural(l.people, "person", "people")}</span><small>{dayTime(l.at)}</small></li>)}</ul>
        : <Empty icon={ShieldCheck} compact title="Nobody has shown the figures yet" text="The first time anyone presses “Show figures”, it is listed here with their name and the time." />}
    </Panel>
  </Workspace>;
}
