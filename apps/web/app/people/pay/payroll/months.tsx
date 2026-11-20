"use client";

// COMP-B: Payroll, month by month. The next thing to do first (start the month, finish checking it, approve it, upload
// the bank file), then every run with its status and totals. Pulse never pays.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ShieldCheck } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { FinTable } from "../../../finance/table";
import { Modal, post } from "../../../records";
import { styles } from "../../../ui";
import { rupees } from "../model";
import { dueMonth, monthLong, RUN_STATUS, runTitle, type RunSummary, type Runs } from "./model";
import css from "./payroll.module.css";
import { SelectField } from "../../../kit/select-field";

const addMonth = (m: string, n: number) => { const [y, mo] = m.split("-").map(Number), d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); };

/** Draft → HR checks → a founder approves → locked, with who did each. */
export function Steps({ r }: { r: Pick<RunSummary, "status" | "openedBy" | "checkedBy" | "approvedBy" | "calc"> }) {
  const at = r.status === "locked" ? 4 : r.status === "checked" ? 2 : r.calc ? 1 : 0;
  const steps = [["Draft", r.openedBy], ["HR checks", r.checkedBy], ["A founder approves", r.approvedBy], ["Locked", null]] as const;
  return <ol className={css.steps} aria-label="Payroll steps">{steps.map(([label, by], i) => {
    const state = i < at || (i === 3 && at === 4) ? "done" : i === at ? "now" : "later";
    return <li key={label} data-state={state} aria-current={state === "now" ? "step" : undefined}><i aria-hidden="true">{state === "done" ? "✓" : i + 1}</i>{label}{by && state === "done" ? <small>· {by}</small> : null}</li>;
  })}</ol>;
}

export function Months({ data }: { data: Runs }) {
  const router = useRouter(), [starting, setStarting] = useState(false);
  const thisMonth = data.today.slice(0, 7), open = data.runs.find((r) => ["draft", "checked"].includes(r.status));
  const due = dueMonth(data);
  const latestLocked = data.runs.find((r) => r.status === "locked");
  const next = open
    ? { title: runTitle(open), text: open.status === "draft" ? `${open.people} people · ${open.exceptions ? `${open.exceptions} exceptions to look at` : "no exceptions"} · HR checks it next` : `Checked by ${open.checkedBy}: a founder approves it next`,
        act: open.status === "draft" ? data.can.start : data.can.approve, href: `/people/pay/payroll/${open.id}`, label: open.status === "draft" ? (data.can.start ? "Check payroll" : "Open") : data.can.approve ? "Review and approve" : "Open", run: open }
    : due ? { title: `${monthLong(`${due}-01`)} payroll`, text: "Not started yet. Starting works out everyone's month from their pay records and attendance; nothing is paid or sent.", act: data.can.start, href: null, label: "Start payroll", run: null }
    : latestLocked ? { title: runTitle(latestLocked), text: `Locked${latestLocked.approvedBy ? ` by ${latestLocked.approvedBy}` : ""}: payslips are out${latestLocked.payout ? " and the bank file is ready to upload" : ""}.`, act: false, href: `/people/pay/payroll/${latestLocked.id}`, label: "Open", run: latestLocked }
    : null;
  return <div className={css.page}>
    {next ? <section className={css.next} data-act={next.act ? "" : undefined} aria-label="Next">
      <div><h2>{next.title}</h2><p>{next.text}</p>{next.run ? <Steps r={next.run} /> : null}</div>
      <div className={css.nextActions}>{next.href ? <Link className={`${styles.btn} ${next.act ? styles.btnPrimary : ""}`} href={next.href}>{next.label}</Link>
        : data.can.start ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setStarting(true)}>{next.label}</button> : <span className={css.note}>HR starts payroll.</span>}</div>
    </section> : null}
    <FinTable fill label="Payroll runs" title="Every month" csv="payroll-runs" sort={{ key: "month", dir: "desc" }}
      toolbar={data.can.start && !(next && !next.href) ? <button type="button" className={styles.btn} onClick={() => setStarting(true)}>Start a month</button> : null}
      columns={[{ key: "month", label: "Month", phone: "title" }, { key: "status", label: "Status" }, { key: "people", label: "People", align: "right" }, { key: "exceptions", label: "Exceptions", align: "right", phone: "hide" },
        { key: "net", label: "Net pay", align: "right", phone: "value" }, { key: "cost", label: "People cost", align: "right", phone: "hide" }, { key: "payslips", label: "Payslips", align: "right", phone: "hide" }]}
      rows={data.runs.map((r) => ({ id: r.id, cells: {
        month: { v: `${r.month}-${r.seq}`, t: runTitle(r).replace(/ payroll/, ""), href: `/people/pay/payroll/${r.id}`, sub: r.note ?? undefined },
        status: { v: r.status, t: RUN_STATUS[r.status].label, tone: RUN_STATUS[r.status].tone, chip: true }, people: r.people, exceptions: r.status === "locked" ? null : r.exceptions,
        net: r.totals ? { v: r.totals.difference ?? r.totals.net, t: rupees(r.totals.difference ?? r.totals.net), sub: r.totals.difference !== null ? "difference" : undefined } : null,
        cost: r.totals ? { v: r.totals.cost, t: rupees(r.totals.cost) } : null, payslips: r.status === "locked" ? r.payslips : null } }))}
      empty="No payroll yet. Start the month when its attendance is settled." />
    <p className={css.note}><ShieldCheck size={13} aria-hidden="true" /> {data.withRecords} of {data.staff} current staff have pay in Pulse; payroll pays only them. Pulse never pays anyone: a founder uploads the bank file in the bank’s portal.
      {data.cutoffDay ? ` Attendance closes for payroll on day ${data.cutoffDay} of the month.` : ""}{data.attendanceEnabled ? "" : " Attendance tracking is off, so no loss of pay is read from it."}</p>
    {starting ? <Start data={data} suggested={due ?? thisMonth} onClose={() => setStarting(false)} onDone={(id) => router.push(`/people/pay/payroll/${id}`)} /> : null}
  </div>;
}

function Start({ data, suggested, onClose, onDone }: { data: Runs; suggested: string; onClose: () => void; onDone: (id: string) => void }) {
  const thisMonth = data.today.slice(0, 7), options = [-3, -2, -1, 0, 1].map((n) => addMonth(thisMonth, n));
  const [month, setMonth] = useState(suggested), [note, setNote] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const correcting = data.runs.some((r) => r.month.slice(0, 7) === month && r.kind === "regular" && r.status === "locked");
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try { const r = await post<{ id: string; people: number }>("comp/payroll", { month, note }); notify({ id: "payroll", tone: "success", title: `${monthLong(`${month}-01`)} payroll calculated for ${r.people} ${r.people === 1 ? "person" : "people"}`, timeout: 4000 }); onDone(r.id); }
    catch (x) { setError(x instanceof Error ? x.message : "Could not start"); } finally { setBusy(false); }
  }
  return <Modal title="Start payroll" sub="Works out everyone's month from their pay records and attendance. Nothing is paid or sent; HR checks it, then a founder approves it." onClose={onClose}>
    <form className={styles.modalBody} onSubmit={submit}>
      <label className={styles.field}>Month<SelectField value={month} onChange={(e) => setMonth(e.target.value)}>{options.map((m) => <option key={m} value={m}>{monthLong(`${m}-01`)}</option>)}</SelectField></label>
      {correcting ? <label className={`${styles.field} ${styles.wide}`}>What this correction is for<textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} required placeholder="For example: a raise backdated to this month" /></label> : null}
      {correcting ? <p className={css.note}>{monthLong(`${month}-01`)} is locked already: this run corrects it. People whose pay changes get a revised payslip; the difference is paid in its own bank file, or recovered next month.</p> : null}
      <div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>Cancel</button>
        <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Calculating…" : correcting ? "Start the correction" : "Start and calculate"}</button></div>
    </form>
  </Modal>;
}
