"use client";

// COMP-B: the company's payroll settings in the pay policy: the statutory basics (each on or off), how attendance turns
// into loss of pay, the pay day and the bank file's layout.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../../records";
import { styles } from "../../../ui";
import css from "../pay.module.css";

type Part = { on: boolean; [k: string]: unknown };
export type PayrollSettings = { statutory: { pf: Part; esi: Part; pt: Part; tds: Part }; attendance: Record<string, string>; payDay: number; bankFormat: "axis" | "generic"; debitAccount: string | null;
  narration: string; canEdit: boolean; cutoffDay: number | null; attendanceEnabled: boolean };

const rupee = (paise: unknown) => (typeof paise === "number" ? String(paise / 100) : "");
export function PayrollSettingsForm({ s: initial }: { s: PayrollSettings }) {
  const router = useRouter(), [s, setS] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const st = s.statutory;
  const part = (k: keyof PayrollSettings["statutory"], patch: Record<string, unknown>) => setS({ ...s, statutory: { ...st, [k]: { ...st[k], ...patch } } });
  const [pfCap, setPfCap] = useState(rupee(st.pf.wageCap)), [esiLimit, setEsiLimit] = useState(rupee(st.esi.grossLimit));
  async function save() {
    setBusy(true); setError("");
    try {
      await post("comp/payroll/settings", { statutory: { pf: { ...st.pf, wageCap: pfCap }, esi: { ...st.esi, grossLimit: esiLimit }, pt: st.pt, tds: { on: st.tds.on, contractorPct: st.tds.contractorPct } },
        attendance: s.attendance, payDay: s.payDay, bankFormat: s.bankFormat, debitAccount: s.debitAccount ?? "", narration: s.narration });
      notify({ id: "payroll", tone: "success", title: "Payroll settings saved", timeout: 3000 }); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  }
  const sw = (k: keyof PayrollSettings["statutory"], label: string, text: string) => <label className={css.check}><input type="checkbox" checked={st[k].on} disabled={!s.canEdit} onChange={(e) => part(k, { on: e.target.checked })} /><span><b>{label}</b> <span className={css.quiet}>{text}</span></span></label>;
  const rule = (k: string, label: string, options: [string, string][]) => <label className={styles.field}>{label}<select value={s.attendance[k]} disabled={!s.canEdit} onChange={(e) => setS({ ...s, attendance: { ...s.attendance, [k]: e.target.value } })}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>;
  return <>
    <section className={css.section} aria-label="Payroll: statutory basics"><header><h2>Payroll: statutory basics</h2><span className={css.quiet}>India by default; estimates the CA confirms</span></header><div className={styles.modalBody}>
      {sw("pf", "Provident fund", `${st.pf.employeePct}% from the person and ${st.pf.employerPct}% from the company, of the basic share of pay`)}
      {st.pf.on ? <div className={css.actions}><label className={css.check}><input type="checkbox" checked={st.pf.capped !== false} disabled={!s.canEdit} onChange={(e) => part("pf", { capped: e.target.checked })} />Cap the PF wage at</label>
        <span className={css.money}><span aria-hidden="true">₹</span><input aria-label="PF wage ceiling" inputMode="decimal" value={pfCap} disabled={!s.canEdit} onChange={(e) => setPfCap(e.target.value)} /></span></div> : null}
      {sw("esi", "ESI", `${st.esi.employeePct}% from the person and ${st.esi.employerPct}% from the company, for monthly pay up to the limit`)}
      {st.esi.on ? <label className={styles.field}>ESI applies up to a monthly gross of<span className={css.money}><span aria-hidden="true">₹</span><input inputMode="decimal" value={esiLimit} disabled={!s.canEdit} onChange={(e) => setEsiLimit(e.target.value)} /></span></label> : null}
      {sw("pt", "Professional tax", "by each person's PT state and category: the company's confirmed PT rule, else Maharashtra's slabs")}
      {sw("tds", "TDS estimates", "salary under the new tax regime; a share of fees for contractors")}
      {st.tds.on ? <label className={styles.field}>TDS on contractors’ fees, %<input inputMode="decimal" value={String(st.tds.contractorPct ?? 10)} disabled={!s.canEdit} onChange={(e) => part("tds", { contractorPct: e.target.value })} /></label> : null}
    </div></section>
    <section className={css.section} aria-label="Payroll: attendance"><header><h2>Payroll: attendance</h2><span className={css.quiet}>{s.attendanceEnabled ? `How the month's attendance turns into loss of pay${s.cutoffDay ? `; attendance closes on day ${s.cutoffDay}` : ""}` : "Attendance tracking is off: payroll reads no loss of pay from it"}</span></header><div className={styles.modalBody}>
      {rule("unpaidLeave", "Unpaid leave", [["pay", "Loss of pay"], ["none", "No effect on pay"]])}
      {rule("halfDays", "Automatic half days", [["none", "No effect on pay"], ["pay", "Half a day's pay each"]])}
      {rule("lateMarks", "Late marks", [["leave", "Debit leave (the late-mark rule)"], ["pay", "Loss of pay instead"]])}
      {rule("absent", "Days with no check-in and no leave", [["none", "No effect on pay"], ["pay", "Loss of pay"]])}
    </div></section>
    <section className={css.section} aria-label="Payroll: paying"><header><h2>Payroll: pay day and bank file</h2><span className={css.quiet}>Pulse never pays: a founder uploads the file in the bank’s portal</span></header><div className={styles.modalBody}>
      <label className={styles.field}>Pay day (of the next month)<input inputMode="numeric" value={String(s.payDay)} disabled={!s.canEdit} onChange={(e) => setS({ ...s, payDay: Number(e.target.value) || 0 })} /></label>
      <label className={styles.field}>Bank file<select value={s.bankFormat} disabled={!s.canEdit} onChange={(e) => setS({ ...s, bankFormat: e.target.value as "axis" | "generic" })}><option value="axis">Axis Bank bulk upload (IFT and NEFT)</option><option value="generic">Generic CSV</option></select></label>
      <label className={styles.field}>Company account it is paid from<input inputMode="numeric" value={s.debitAccount ?? ""} disabled={!s.canEdit} onChange={(e) => setS({ ...s, debitAccount: e.target.value })} placeholder="Optional" /></label>
      <label className={styles.field}>Narration<input value={s.narration} maxLength={60} disabled={!s.canEdit} onChange={(e) => setS({ ...s, narration: e.target.value })} /><small className={css.hint}>{"{{month}}"} becomes the month, e.g. Salary Oct 2026</small></label>
      <p className={css.quiet}>Check the column order with the bank before the first upload.</p>
    </div></section>
    {s.canEdit ? <div className={css.saveBar}><p role="alert" className={css.warnText}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={save} disabled={busy}>{busy ? "Saving…" : "Save payroll settings"}</button></div> : null}
  </>;
}
