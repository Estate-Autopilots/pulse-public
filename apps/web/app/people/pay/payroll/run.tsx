"use client";

// COMP-B: one payroll run. Its steps and the one next step (check, approve and lock, download the bank file, correct),
// the totals, the exceptions HR clears, each person's month (figures hidden until shown; every look is logged), HR's
// adjustments, payslips and what happened.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Download, Eye, EyeOff, FileText, RefreshCw, ShieldCheck } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { FinTable, type FinRow } from "../../../finance/table";
import { Modal, post } from "../../../records";
import { Badge, Kpi, Panel, styles, Tiles } from "../../../ui";
import { day, PAY_TYPE, rupees, type PayType } from "../model";
import { Steps } from "./months";
import { ADJUST, EVENT, EXCEPTION, monthLong, RUN_STATUS, runTitle, type Run, type RunLine, type Slip } from "./model";
import css from "./payroll.module.css";

const when = (t: string | null | undefined) => (t ? `${day(t.slice(0, 10))}, ${t.slice(11, 16)}` : "");

export function RunView({ run }: { run: Run }) {
  const router = useRouter();
  // Figures belong to one calculation: a recalculation or a step hides them again (they are opened per look, logged).
  const at = `${run.calc}:${run.status}`;
  const [shown, setShown] = useState<{ at: string; map: Map<string, Slip> } | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const slips = shown?.at === at ? shown.map : null, setSlips = (m: Map<string, Slip> | null) => setShown(m ? { at, map: m } : null);
  const [open, setOpen] = useState<RunLine | null>(null), [act, setAct] = useState<"check" | "approve" | "return" | "withdraw" | "correct" | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!slips) return;
    const hide = () => { if (document.hidden) setShown(null); };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [slips]);
  async function show() {
    setLoading(true); setError("");
    try {
      const r = await fetch(`/api/v0/comp/payroll/${run.id}?figures=1`), d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Figures are not available");
      setSlips(new Map((d.lines as RunLine[]).filter((l) => l.slip).map((l) => [l.person, l.slip!])));
    } catch (e) { setError(e instanceof Error ? e.message : "Figures are not available"); } finally { setLoading(false); }
  }
  async function recalc() {
    setBusy(true);
    try { const r = await post<{ people: number }>(`comp/payroll/${run.id}/compute`); notify({ id: "payroll", tone: "success", title: `Recalculated for ${r.people} ${r.people === 1 ? "person" : "people"}`, timeout: 3000 }); router.refresh(); }
    catch (e) { notify({ id: "payroll", tone: "error", title: e instanceof Error ? e.message : "Could not recalculate", timeout: 5000 }); } finally { setBusy(false); }
  }
  const t = run.totals, correction = run.kind === "correction", st = RUN_STATUS[run.status];
  const exceptions = useMemo(() => {
    const by = new Map<string, RunLine[]>();
    for (const l of run.lines) for (const k of l.exceptions) by.set(k, [...(by.get(k) ?? []), l]);
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [run.lines]);
  const left = run.lines.filter((l) => l.exceptions.includes("no_bank") || l.hold);

  const primary = run.status === "draft" && run.can.check ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setAct("check")}>Mark checked</button>
    : run.status === "checked" && run.can.approve ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setAct("approve")}>Approve and lock</button>
    : run.status === "locked" && run.can.payout && run.payout ? <a className={`${styles.btn} ${styles.btnPrimary}`} href={`/api/v0/comp/payroll/${run.id}/bank-file`} download><Download size={14} aria-hidden="true" />Download bank file</a>
    : null;
  const waiting = run.status === "checked" && !run.can.approve ? (run.checkedBy ? `Checked by ${run.checkedBy}. A founder other than the person who checked it approves it.` : "A founder approves it next.") : null;

  const rows: FinRow[] = run.lines.map((l) => {
    const s = slips?.get(l.person);
    return { id: l.person, tags: [l.exceptions.length ? "exceptions" : "", l.adjustments.length ? "adjusted" : "", l.hold ? "held" : ""].filter(Boolean),
      cells: {
        person: { v: l.name, t: l.name, sub: [l.role, l.pod].filter(Boolean).join(" · ") || undefined },
        type: l.payType ? PAY_TYPE[l.payType as PayType] ?? l.payType : null,
        days: s ? { v: s.paidDays, t: `${s.paidDays} of ${s.monthDays}`, sub: s.lopDays ? `${s.lopDays} loss of pay` : undefined } : null,
        gross: s ? { v: s.gross, t: rupees(s.gross) } : slips ? null : { v: null, t: "Hidden" },
        deductions: s ? { v: s.deductions, t: rupees(s.deductions) } : null,
        net: s ? { v: s.difference ?? s.net, t: rupees(s.difference ?? s.net), sub: s.difference !== undefined && s.difference !== null ? `net ${rupees(s.net)}, paid ${rupees(s.paid ?? 0)}` : s.reimbursements ? `incl. ${rupees(s.reimbursements)} reimbursed` : undefined } : null,
        flags: l.exceptions.length || l.hold || l.adjustments.length ? { v: l.exceptions.length, t: [l.hold ? "Held" : "", ...l.exceptions.map((k) => EXCEPTION[k]?.label ?? k), l.adjustments.length ? "Adjusted" : ""].filter(Boolean).join(" · "), tone: l.exceptions.length ? "warning" : "neutral", chip: true } : null,
      },
      action: <button type="button" className={styles.btn} onClick={() => setOpen(l)} aria-label={`Details: ${l.name}`}>{run.can.adjust && !l.self ? "Details or adjust" : "Details"}</button> };
  });

  return <div className={css.page}>
    <section className={css.next} data-act={primary ? "" : undefined} aria-label="This payroll">
      <div><h2>{runTitle(run)} <Badge tone={st.tone}>{st.label}</Badge></h2>
        <p>{run.status === "locked" ? `Approved by ${run.approvedBy ?? "a founder"} on ${day(run.approvedAt?.slice(0, 10))}. Payslips are in each person's My pay.` : run.status === "checked" ? (waiting ?? `Checked by ${run.checkedBy}. Approving it files the payslips, makes the bank file and posts the ledger.`) : run.status === "draft" ? `Calculated ${run.calc === 1 ? "once" : `${run.calc} times`}. Clear what you can below, recalculate, then mark it checked.` : "Withdrawn."}
          {run.payOn && run.status !== "withdrawn" ? ` Pay date ${day(run.payOn)}.` : ""}{correction && run.note ? ` Correction: ${run.note}` : ""}</p>
        <Steps r={run} /></div>
      <div className={css.nextActions}>
        {run.can.compute ? <button type="button" className={styles.btn} onClick={recalc} disabled={busy}><RefreshCw size={14} aria-hidden="true" />{busy ? "Recalculating…" : "Recalculate"}</button> : null}
        {run.status === "checked" && run.can.return ? <button type="button" className={styles.btn} onClick={() => setAct("return")}>Send back</button> : null}
        {run.status === "locked" && run.can.correct ? <button type="button" className={styles.btn} onClick={() => setAct("correct")}>Correct this month</button> : null}
        {primary}
      </div>
    </section>

    {run.runExceptions.length ? <ul className={css.notes}>{run.runExceptions.map((x) => <li key={x.key}>{x.text}.</li>)}</ul> : null}

    {t ? <Tiles count={5} dense>
      <Kpi label="People" value={String(t.people)} note={run.lines.filter((l) => l.hold).length ? `${run.lines.filter((l) => l.hold).length} held` : "in this run"} />
      <Kpi label="Gross pay" value={rupees(t.gross)} note={`${rupees(t.deductions)} deducted`} />
      <Kpi label={correction ? "Difference to pay" : "Net pay"} value={rupees(correction ? t.difference ?? 0 : t.net)} note={t.reimbursements ? `incl. ${rupees(t.reimbursements)} reimbursements` : "to people's accounts"} />
      <Kpi label="Statutory dues" value={rupees(t.statutory)} note="PF, ESI, PT and TDS estimates" />
      <Kpi label="People cost" value={rupees(t.cost)} note={`${rupees(t.employer)} employer contributions`} />
    </Tiles> : null}

    {exceptions.length && run.status !== "locked" ? <Panel title="Exceptions to look at" sub="listed, not blocking: fix what you can and recalculate">
      <div className={css.pane}><ul className={css.todo}>{exceptions.map(([k, ls]) => <li key={k}><b>{EXCEPTION[k]?.label ?? k}</b><span className={css.who}>{ls.map((l) => l.name).join(", ")}</span><small>{EXCEPTION[k]?.fix}</small></li>)}</ul></div>
    </Panel> : null}

    {error ? <p role="alert" className={css.note}>{error}</p> : null}
    {/* RELEASE-6: not `fill`: the bank-file note and the history follow, and sharing the height hid the last person behind the row count. */}
    <FinTable label="People in this payroll" title="People" sub={`${run.lines.length}`} search csv={slips ? `payroll-${run.month.slice(0, 7)}` : undefined}
      filters={[{ key: "all", label: "Everyone" }, { key: "exceptions", label: "Exceptions" }, { key: "adjusted", label: "Adjusted" }, { key: "held", label: "Held" }]}
      toolbar={run.can.figures ? slips ? <button type="button" className={styles.btn} onClick={() => setSlips(null)}><EyeOff size={14} aria-hidden="true" />Hide figures</button>
        : <button type="button" className={styles.btn} onClick={show} disabled={loading}><Eye size={14} aria-hidden="true" />{loading ? "Opening…" : "Show figures"}</button> : null}
      columns={[{ key: "person", label: "Person", phone: "title" }, { key: "type", label: "Pay type", phone: "hide" }, { key: "days", label: "Days paid", align: "right" },
        { key: "gross", label: "Gross", align: "right" }, { key: "deductions", label: "Deductions", align: "right", phone: "hide" }, { key: "net", label: correction ? "Difference" : "Net pay", align: "right", phone: "value" },
        { key: "flags", label: "To look at" }]}
      rows={rows} empty="Nobody is paid this month: nobody has pay in force, and no item, claim or full and final is waiting." />
    {run.status === "locked" && left.length ? <p className={css.note}>Not in the bank file: {left.map((l) => l.name).join(", ")} ({left.some((l) => l.hold) ? "held, or " : ""}no bank details). Pay them by hand.</p> : null}

    <Panel title="What happened"><div className={css.pane}>
      <ul className={css.events}>{run.events.map((e, i) => <li key={i}><time dateTime={e.at}>{when(e.at)}</time><span><b>{EVENT[e.kind] ?? e.kind}</b>{e.by ? ` · ${e.by}` : ""}{typeof e.detail.note === "string" && e.detail.note ? ` · “${e.detail.note}”` : ""}
        {typeof e.detail.people === "number" ? ` · ${e.detail.people} people` : ""}{typeof e.detail.calc === "number" ? ` · calculation ${e.detail.calc}` : ""}{typeof e.detail.adjustment === "string" ? ` · ${ADJUST[e.detail.adjustment]?.toLowerCase() ?? e.detail.adjustment}` : ""}</span></li>)}</ul>
      <p className={css.note}><ShieldCheck size={13} aria-hidden="true" /> Every calculation is kept and every look at figures is logged. A locked month is corrected by a new run, never changed.</p>
    </div></Panel>

    {open ? <Person run={run} line={open} slip={slips?.get(open.person) ?? null} onClose={() => setOpen(null)} /> : null}
    {act ? <Step run={run} act={act} onClose={() => setAct(null)} busy={busy} setBusy={setBusy} /> : null}
  </div>;
}

/** A person's month: the payslip's lines, HR's adjustments (and adding one), the payslip once issued. */
function Person({ run, line, slip, onClose }: { run: Run; line: RunLine; slip: Slip | null; onClose: () => void }) {
  const router = useRouter(), [kind, setKind] = useState<"lop_days" | "amount" | "hold">("lop_days");
  const [days, setDays] = useState(""), [amount, setAmount] = useState(""), [label, setLabel] = useState(""), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const adjust = run.can.adjust && !line.self;
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try { await post(`comp/payroll/${run.id}/adjust`, { person: line.person, kind, days, amount, label, reason }); notify({ id: "payroll", tone: "success", title: "Adjusted and recalculated", timeout: 3000 }); onClose(); router.refresh(); }
    catch (x) { setError(x instanceof Error ? x.message : "Could not save"); } finally { setBusy(false); }
  }
  async function remove(id: string) {
    setBusy(true);
    try { await post(`comp/payroll/adjustments/${id}/remove`); notify({ id: "payroll", tone: "success", title: "Adjustment removed and recalculated", timeout: 3000 }); onClose(); router.refresh(); }
    catch (x) { setError(x instanceof Error ? x.message : "Could not remove"); } finally { setBusy(false); }
  }
  const group = (k: string, title: string) => { const ls = slip?.lines.filter((l) => l.kind === k) ?? []; return ls.length ? [<tr key={k} data-group=""><th colSpan={2}>{title}</th></tr>,
    ...ls.map((l, i) => <tr key={`${k}${i}`}><th>{l.label}{l.basis && !/^\d{4}-\d{2}-\d{2}\.\./.test(l.basis) ? <small>{l.basis}</small> : null}</th><td data-neg={l.amount < 0 ? "" : undefined}>{l.amount < 0 ? "− " : ""}{rupees(Math.abs(l.amount))}</td></tr>)] : []; };
  return <Modal title={line.name} sub={`${monthLong(run.month)} · ${[line.role, line.pod].filter(Boolean).join(" · ")}`} onClose={onClose} size="lg">
    <div className={styles.modalBody}>
      {line.exceptions.length ? <ul className={css.notes}>{line.exceptions.map((k) => <li key={k}><b>{EXCEPTION[k]?.label ?? k}.</b> {EXCEPTION[k]?.fix}</li>)}</ul> : null}
      {slip ? <table className={css.slip}><caption className={css.note}>{slip.paidDays} of {slip.monthDays} days paid{slip.lopDays ? ` · ${slip.lopDays} loss of pay (${slip.lopBasis ?? ""})` : ""}</caption>
        <tbody>{group("earning", "Earnings")}{group("deduction", "Deductions")}{group("reimbursement", "Reimbursements")}{group("employer", "Paid by the company (not in take-home)")}</tbody>
        <tfoot><tr><th>Net pay</th><td>{rupees(slip.net)}</td></tr>{slip.difference !== undefined && slip.difference !== null ? <tr><th>Paid before · difference</th><td>{rupees(slip.paid ?? 0)} · {rupees(slip.difference)}</td></tr> : null}</tfoot></table>
        : run.can.figures ? <p className={css.note}>Show figures on the page to see this month’s lines.</p> : null}
      {line.payslip ? <p><a href={`/api/v0/comp/payslips/${line.payslip.id}/pdf`} target="_blank" rel="noreferrer"><FileText size={14} aria-hidden="true" /> Open the payslip{line.payslip.version > 1 ? ` (version ${line.payslip.version})` : ""}</a>{line.payslip.seenAt ? <span className={css.note}> · seen {day(line.payslip.seenAt.slice(0, 10))}</span> : null}</p> : null}
      {line.adjustments.length ? <ul className={css.todo} aria-label="Adjustments">{line.adjustments.map((a) => <li key={a.id}><b>{ADJUST[a.kind]}{a.kind === "lop_days" ? `: ${a.days}` : a.label ? `: ${a.label}` : ""}</b>
        <span className={css.who}>{a.by}{adjust ? <> · <button type="button" className={styles.btn} onClick={() => remove(a.id)} disabled={busy}>Remove</button></> : null}</span><small>{a.reason}</small></li>)}</ul> : null}
      {adjust ? <form onSubmit={submit} className={styles.modalBody} aria-label="Adjust">
        <div className={css.kinds} role="radiogroup" aria-label="Adjustment">{(["lop_days", "amount", "hold"] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} className={css.kind} onClick={() => setKind(k)}>{ADJUST[k]}</button>)}</div>
        {kind === "lop_days" ? <label className={styles.field}>Loss-of-pay days this month<input inputMode="decimal" value={days} onChange={(e) => setDays(e.target.value)} required placeholder="For example 1.5" /><small className={css.note}>Replaces the days worked out from attendance.</small></label> : null}
        {kind === "amount" ? <><label className={styles.field}>Line on the payslip<input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} required placeholder="For example: Shoot allowance" /></label>
          <label className={styles.field}>Amount (negative to deduct)<span className={css.money}><span aria-hidden="true">₹</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required /></span></label></> : null}
        {kind === "hold" ? <p className={css.note}>Their payslip is issued as usual, but they are left out of the bank file: pay them by hand or in a later run.</p> : null}
        <label className={`${styles.field} ${styles.wide}`}>Why<textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required /></label>
        <div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Saving…" : "Adjust and recalculate"}</button></div>
      </form> : line.self && run.status === "draft" ? <p className={css.note}>Someone else in HR adjusts your own pay.</p> : null}
    </div>
  </Modal>;
}

/** Check, approve and lock, send back, withdraw or correct: a note and the one button. */
function Step({ run, act, onClose, busy, setBusy }: { run: Run; act: "check" | "approve" | "return" | "withdraw" | "correct"; onClose: () => void; busy: boolean; setBusy: (b: boolean) => void }) {
  const router = useRouter(), [note, setNote] = useState(""), [error, setError] = useState("");
  const words = {
    check: { title: "Mark payroll checked", sub: `You looked at every exception for ${monthLong(run.month)}. A founder approves it next.`, button: "Mark checked", need: false },
    approve: { title: "Approve and lock payroll", sub: "Payslips go to each person's My pay, the bank file is made for you to upload, and the people-cost ledger is posted. A locked month is corrected, never changed.", button: "Approve and lock", need: false },
    return: { title: "Send payroll back", sub: "It goes back to draft for HR, with your note.", button: "Send back", need: true },
    withdraw: { title: "Withdraw this payroll", sub: "It is kept in the history, marked withdrawn.", button: "Withdraw", need: false },
    correct: { title: `Correct ${monthLong(run.month)}`, sub: "A new run recomputes the month. People whose pay changes get a revised payslip; the difference is paid in its own bank file or recovered next month.", button: "Start the correction", need: true },
  }[act];
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      if (act === "correct") { const r = await post<{ id: string }>("comp/payroll", { month: run.month.slice(0, 7), note }); onClose(); router.push(`/people/pay/payroll/${r.id}`); return; }
      const r = await post<{ status: string; payout?: { rows: number; leftOut: number } | null }>(`comp/payroll/${run.id}/${act}`, { note, calc: run.calc });
      notify({ id: "payroll", tone: "success", title: act === "approve" ? `Locked: payslips issued${r.payout ? `, bank file with ${r.payout.rows} ${r.payout.rows === 1 ? "payment" : "payments"}` : ""}` : act === "check" ? "Checked: the founders are told" : act === "return" ? "Sent back to draft" : "Withdrawn", timeout: 5000 });
      onClose(); router.refresh();
    } catch (x) { setError(x instanceof Error ? x.message : "Could not save"); } finally { setBusy(false); }
  }
  return <Modal title={words.title} sub={words.sub} onClose={onClose}>
    <form className={styles.modalBody} onSubmit={submit}>
      {act === "approve" && run.totals ? <ul className={css.events}><li><span>People</span><b>{run.totals.people}</b></li><li><span>{run.kind === "correction" ? "Difference to pay" : "Net pay"}</span><b>{rupees(run.kind === "correction" ? run.totals.difference ?? 0 : run.totals.net)}</b></li><li><span>People cost</span><b>{rupees(run.totals.cost)}</b></li></ul> : null}
      <label className={`${styles.field} ${styles.wide}`}>{words.need ? "Note (required)" : "Note (optional)"}<textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} required={words.need} /></label>
      <div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>Cancel</button>
        <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Working…" : words.button}</button></div>
    </form>
  </Modal>;
}
