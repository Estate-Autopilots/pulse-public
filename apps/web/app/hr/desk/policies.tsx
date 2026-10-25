"use client";

import Link from "next/link";
import { CalendarPlus, ChevronRight, PartyPopper, Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { notify } from "@pulse/ui-shell";
import { dayTime, dayYear, longDay, plural } from "../../lib/format";
import { Modal, post } from "../../records";
import { Badge, Empty, Fit, Panel, styles } from "../../ui";
import css from "../desk.module.css";
import type { LeaveType, PolicyData } from "../types";
import { dest } from "../../destinations/registry.mjs";
import { DateField } from "../../kit/date-field";
import { SelectField } from "../../kit/select-field";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ACCRUAL: Record<LeaveType["accrual"], string> = { monthly: "A share each month", yearly: "All at the start of the year", none: "Fixed, not earned over time" };
const message = (e: unknown) => e instanceof Error ? e.message : "Could not save";

/** Add a leave type or change one. A type without days per year has no balance (unpaid leave, for example). */
function TypeDialog({ type, onClose }: { type?: LeaveType; onClose: () => void }) {
  const router = useRouter(); const formId = useId(); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [annual, setAnnual] = useState(type ? (type.annualDays === null ? "" : String(type.annualDays)) : "12");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const d = new FormData(event.currentTarget); setBusy(true); setError("");
    try {
      await post("hr/leave-types", { key: type?.key, name: d.get("name"), annualDays: annual === "" ? null : Number(annual), accrual: d.get("accrual") ?? "none", carryForwardMax: Number(d.get("carryForwardMax") ?? 0), paid: d.get("paid") === "on", active: d.get("active") === "on" });
      notify({ id: "leave-type", tone: "success", title: type ? "Leave type saved" : "Leave type added", timeout: 2500 }); onClose(); router.refresh();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title={type ? `Edit ${type.name}` : "New leave type"} onClose={onClose} foot={<div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>Cancel</button><button form={formId} className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Saving…" : type ? "Save changes" : "Add leave type"}</button></div>}>
      <form id={formId} className={styles.modalBody} onSubmit={submit}>
        <label className={`${styles.field} ${styles.wide}`}>Name<input name="name" defaultValue={type?.name ?? ""} required minLength={2} maxLength={40} placeholder="e.g. Casual leave" autoComplete="off" /></label>
        <label className={styles.field}>Days per year<input type="number" min="0" max="365" step="0.5" value={annual} onChange={(event) => setAnnual(event.target.value)} placeholder="Empty for no allowance" /></label>
        <label className={styles.field}>How it is earned<SelectField name="accrual" defaultValue={type?.accrual === "none" && annual !== "" ? "none" : type?.accrual === "yearly" ? "yearly" : "monthly"} disabled={annual === ""}>
          <option value="monthly">{ACCRUAL.monthly}</option><option value="yearly">{ACCRUAL.yearly}</option>{type?.accrual === "none" && type.annualDays !== null ? <option value="none">{ACCRUAL.none}</option> : null}</SelectField></label>
        <label className={`${styles.field} ${styles.wide}`}>Most days carried into the next year<input type="number" name="carryForwardMax" min="0" max="365" step="0.5" defaultValue={type?.carryForwardMax ?? 0} disabled={annual === ""} /></label>
        <span className={css.checks}>
          <label className={css.check}><input type="checkbox" name="paid" defaultChecked={type?.paid ?? true} />Paid leave</label>
          <label className={css.check}><input type="checkbox" name="active" defaultChecked={type?.active ?? true} />People can apply for it</label>
        </span>
        <p className={styles.modalNote}>{annual === "" ? "With no days per year, this type has no balance: people can apply and you decide each request." : "“A share each month” adds one twelfth of the days every month; “all at the start” gives the whole allowance on the first day of the leave year."} Changing a type changes everyone’s balance from now on.</p>
      </form>
    </Modal>
  );
}

/** Working rules: shift hours, grace before a late mark, working days, the leave year. Saving also confirms them. */
export function WorkingRules({ data }: { data: PolicyData }) {
  const router = useRouter(); const p = data.policy; const can = data.canEdit;
  const saved = { shiftStart: p.shiftStart, shiftEnd: p.shiftEnd, graceMinutes: String(p.graceMinutes), workDays: p.workDays, wfhPerMonth: p.wfhPerMonth === null ? "" : String(p.wfhPerMonth), leaveYearStart: String(p.leaveYearStart), trackingFrom: p.trackingFrom };
  const [form, setForm] = useState(saved);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const dirty = JSON.stringify(form) !== JSON.stringify(saved); const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const toggleDay = (d: number) => set({ workDays: form.workDays.includes(d) ? form.workDays.filter((x) => x !== d) : [...form.workDays, d].sort() });
  const start = Number(form.shiftStart.slice(0, 2)) * 60 + Number(form.shiftStart.slice(3)) + (Number(form.graceMinutes) || 0);
  const lateFrom = `${String(Math.floor(start / 60) % 24).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
  const [h1, m1] = form.shiftStart.split(":").map(Number), [h2, m2] = form.shiftEnd.split(":").map(Number);
  const half = Number.isFinite(h1 + m1 + h2 + m2) ? (() => { const mid = Math.round(((h1 * 60 + m1) + (h2 * 60 + m2)) / 2); return `${String(Math.floor(mid / 60)).padStart(2, "0")}:${String(mid % 60).padStart(2, "0")}`; })() : null;
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await post("hr/policy", { ...form, graceMinutes: Number(form.graceMinutes), wfhPerMonth: form.wfhPerMonth === "" ? null : Number(form.wfhPerMonth), leaveYearStart: Number(form.leaveYearStart) });
      notify({ id: "policy", tone: "success", title: p.confirmedAt ? "Policy saved" : "Policy confirmed and saved", timeout: 3000 }); router.refresh();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <Fit className={css.pair}>
    <form className={`${styles.panel} ${css.rulesPane}`} onSubmit={save}>
      <div className={styles.panelHead}><h3 className={styles.panelTitle}>Working rules<small>{p.confirmedAt ? `Confirmed${data.confirmedBy ? ` by ${data.confirmedBy}` : ""} · ${dayTime(p.confirmedAt)}` : "Not confirmed yet: these are Pulse's starting values"}</small></h3></div>
      <fieldset className={css.policyForm} disabled={!can || busy} style={{ border: 0, margin: 0, minWidth: 0 }}>
        <label className={styles.field}>Shift starts<input type="time" value={form.shiftStart} onChange={(event) => set({ shiftStart: event.target.value })} required /></label>
        <label className={styles.field}>Shift ends<input type="time" value={form.shiftEnd} onChange={(event) => set({ shiftEnd: event.target.value })} required /></label>
        <label className={styles.field}>Grace before a late mark, in minutes<input type="number" min="0" max="240" step="1" value={form.graceMinutes} onChange={(event) => set({ graceMinutes: event.target.value })} required />
          <span className={css.hint}>A check-in after {lateFrom} counts as late.</span></label>
        <label className={styles.field}>Work-from-home days a month<input type="number" min="0" max="31" step="1" value={form.wfhPerMonth} onChange={(event) => set({ wfhPerMonth: event.target.value })} placeholder="No limit" />
          <span className={css.hint}>{form.wfhPerMonth === "" ? "Empty means no limit." : "Days beyond this show as extra; nothing is blocked."}</span></label>
        <div className={`${styles.field} ${css.wide}`}><span id="work-days">Working days</span>
          <div className={css.days} role="group" aria-labelledby="work-days">{DAYS.map((label, i) => <button key={label} type="button" className={css.dayBtn} aria-pressed={form.workDays.includes(i + 1)} onClick={() => toggleDay(i + 1)}>{label}</button>)}</div>
          <span className={css.hint}>{form.workDays.length ? `${plural(form.workDays.length, "working day")} a week. The other days are weekly offs and are not counted as leave or absence.` : "Choose at least one working day."}</span></div>
        <label className={styles.field}>Leave year starts in<SelectField value={form.leaveYearStart} onChange={(event) => set({ leaveYearStart: event.target.value })}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</SelectField>
          <span className={css.hint}>Balances reset and carry forward on the 1st.</span></label>
        <label className={styles.field}>Leave is counted in Pulse from<DateField value={form.trackingFrom} onChange={(event) => set({ trackingFrom: event.target.value })} required />
          <span className={css.hint}>Earlier leave is entered as an opening balance.</span></label>
      </fieldset>
      <div className={css.saveBar} data-dirty={dirty ? "" : undefined}>
        <span role="alert" style={error ? { color: "var(--theme-danger)" } : undefined}>{error || (dirty ? "You have changes that are not saved yet." : p.confirmedAt ? "Every change is kept in the change history with your name." : "Nothing changed? Confirm the values as they are.")}</span>
        <span className={styles.inline}>
          {dirty ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={() => { setForm(saved); setError(""); }}>Undo changes</button> : null}
          <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={!can || busy || (!dirty && !!p.confirmedAt) || !form.workDays.length}>{busy ? "Saving…" : p.confirmedAt ? "Save changes" : "Confirm and save"}</button>
        </span>
      </div>
    </form>
    <section className={`${styles.panel} ${css.rulesPane}`} aria-label="How Pulse applies these rules">
      <div className={styles.panelHead}><h3 className={styles.panelTitle}>How Pulse applies them</h3></div>
      <dl className={css.ruleFacts}>
        <div><dt>Late mark</dt><dd>A first check-in after {lateFrom} on a working day.</dd></div>
        <div><dt>Half-day leave</dt><dd>The first or the second half of the shift{half ? ` (${form.shiftStart}–${half} or ${half}–${form.shiftEnd})` : ""}, counted as 0.5 day. People choose it when they apply.</dd></div>
        <div><dt>Weekly offs and holidays</dt><dd>Never counted as leave or absence, also inside a longer leave.</dd></div>
        <div><dt>Someone works other hours</dt><dd>Person and organisation shifts, and standing working patterns, replace these rules for that person. <Link href="/hr?tab=policies&view=patterns">Patterns &amp; shifts<ChevronRight size={12} aria-hidden="true" /></Link></dd></div>
      </dl>
    </section>
  </Fit>;
}

/** Leave & holidays: the leave types people apply for (with their allowance) and the holiday list. */
export function LeaveHolidays({ data, proposed }: { data: PolicyData; proposed?: number }) {
  const router = useRouter(); const can = data.canEdit;
  const [busy, setBusy] = useState(false); const [editing, setEditing] = useState<LeaveType | "new" | null>(null); const [removing, setRemoving] = useState<string | null>(null);
  async function addHoliday(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const el = event.currentTarget; const d = new FormData(el); setBusy(true);
    try { await post("hr/holidays", { day: d.get("day"), name: d.get("name"), optional: d.get("optional") === "on" }); notify({ id: "holiday", tone: "success", title: `${d.get("name")} added`, timeout: 2500 }); el.reset(); router.refresh(); }
    catch (e) { notify({ id: "holiday", tone: "error", title: "The holiday was not added", message: message(e) }); } finally { setBusy(false); }
  }
  async function removeHoliday(day: string, name: string) {
    if (!window.confirm(`Remove ${name} on ${dayYear(day)}? That day counts as a working day again.`)) return;
    setRemoving(day);
    try { await post("hr/holidays", { day, action: "remove" }); notify({ id: "holiday", tone: "success", title: `${name} removed`, timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "holiday", tone: "error", title: "The holiday was not removed", message: message(e) }); } finally { setRemoving(null); }
  }
  const years = [...new Set(data.holidays.map((h) => h.day.slice(0, 4)))];
  return <>
    <Fit className={css.pair}>
      <Panel fill title="Leave types" sub={`${plural(data.types.filter((t) => t.active).length, "type")} people can apply for`} action={{ href: "/hr?tab=leave&view=balances", label: "Balances" }} tools={can ? <button type="button" className={styles.btn} onClick={() => setEditing("new")}><Plus size={14} aria-hidden="true" />New leave type</button> : undefined}>
        <div className={styles.tableWrap}><table className={`${styles.table} ${css.typesTable}`}>
          <thead><tr><th>Leave type</th><th className={styles.right}>Days per year</th><th>How it is earned</th><th className={styles.right}>Carried forward, at most</th><th>Paid</th><th>Status</th><th /></tr></thead>
          <tbody>{data.types.map((t) => (
            <tr key={t.key} className={t.active ? undefined : css.offRow}>
              <td className={styles.nowrap}><b style={{ fontWeight: 550 }}>{t.name}</b></td>
              <td className={styles.right} data-label="Days a year">{t.annualDays === null ? <span className={styles.muted}>No allowance</span> : t.annualDays}</td>
              <td data-label="Earned">{t.annualDays === null ? <span className={styles.muted}>Decided per request</span> : ACCRUAL[t.accrual]}</td>
              <td className={styles.right} data-label="Carry forward">{t.annualDays === null ? <span className={styles.muted}>–</span> : t.carryForwardMax ? plural(t.carryForwardMax, "day") : "Nothing"}</td>
              <td>{t.paid ? "Paid" : "Unpaid"}</td>
              <td>{t.active ? <Badge tone="success">In use</Badge> : <Badge>Switched off</Badge>}</td>
              <td className={styles.right}>{can ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}><Pencil size={12} aria-hidden="true" />Edit</button> : null}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </Panel>
      <Panel fill title="Holidays" sub={data.holidays.length ? `${plural(data.holidays.length, "holiday")} from ${data.today.slice(0, 4)} on` : `${data.today.slice(0, 4)} onwards`} action={proposed ? { href: "/review-data?kind=holiday", label: `${proposed} proposed to confirm` } : undefined}
        foot={can ? <form className={css.inlineForm} onSubmit={addHoliday} aria-label="Add a holiday" {...dest("hr.policies.leave.holiday")}>
          <label className={styles.field}>Date<DateField name="day" required /></label>
          <label className={styles.field}>Holiday<input name="name" required minLength={2} maxLength={80} placeholder="e.g. Diwali" autoComplete="off" /></label>
          <label className={css.check} title="An optional holiday stays a working day; people take it as leave if they want it"><input type="checkbox" name="optional" />Optional</label>
          <button className={styles.btn} disabled={busy}><CalendarPlus size={14} aria-hidden="true" />Add holiday</button>
        </form> : undefined}>
        {data.holidays.length ? years.map((year) => <div key={year}>
          <div className={styles.subhead}><span>{year}</span></div>
          <ul className={styles.list}>{data.holidays.filter((h) => h.day.startsWith(year)).map((h) => (
            <li key={h.day} className={styles.row} style={h.day < data.today ? { color: "var(--theme-text-muted)" } : undefined}>
              <span className={css.dateChip} aria-hidden="true"><small>{MONTHS[Number(h.day.slice(5, 7)) - 1].slice(0, 3)}</small><b>{Number(h.day.slice(8))}</b></span>
              <span className={styles.rowMain}><span className={styles.rowTitle}>{h.name}</span><span className={styles.rowMeta}><span>{longDay(h.day)} {h.day.slice(0, 4)}</span>{h.optional ? <span>Optional: counts as a working day unless leave is taken</span> : null}</span></span>
              {h.optional ? <Badge>Optional</Badge> : null}
              {can ? <button type="button" className={styles.iconBtn} aria-label={`Remove ${h.name}`} title="Remove" disabled={removing === h.day} onClick={() => removeHoliday(h.day, h.name)}><Trash2 size={14} aria-hidden="true" /></button> : null}
            </li>
          ))}</ul>
        </div>) : <Empty icon={PartyPopper} compact title="No holiday list yet" text={`Pulse has no holidays for the organisation, so every working day counts as one: a festival day without a check-in would show as “no check-in”, and leave across it uses a day. ${proposed ? "Confirm the proposed holidays, or add" : "Add"} this year's holidays below.`} />}
      </Panel>
    </Fit>
    {editing ? <TypeDialog type={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} /> : null}
  </>;
}
