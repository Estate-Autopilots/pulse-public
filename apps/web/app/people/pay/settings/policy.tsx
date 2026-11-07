"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { LETTER_DEFAULTS, LETTER_KINDS } from "@pulse/invoice-doc/browser";
import { post } from "../../../records";
import { styles } from "../../../ui";
import { SaveBar } from "../../../kit";
import { LETTER_KIND, type Component } from "../model";
import css from "../pay.module.css";
import { SelectField } from "../../../kit/select-field";

export type Policy = { approvers: string; probationApproval: string; managers: string; currency: string; probationDays: number; remindDays: number; noticeProbation: number | null;
  noticeConfirmed: number | null; offerDays: number; dayBasis: string; encashBasis: string; encashDivisor: number; components: Component[]; claimCategories: { key: string; label: string; cap?: number }[];
  claimThreshold: number | null; recoverMax: number; letters: Record<string, { title?: string; body?: string }>; founders: { id: string; name: string }[] | null; foundersNamed: boolean; canEdit: boolean; canEditApprovers: boolean };

const num = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
/** One form, saved at once; leadership alone changes who approves. */
export function PolicyForm({ policy }: { policy: Policy }) {
  const router = useRouter(), [p, setP] = useState(policy), [letter, setLetter] = useState("offer"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  // UI-UPGRADE: what differs from the saved policy, for the sticky save bar (Discard puts it back).
  const [base, setBase] = useState(policy);
  const changes = (Object.keys(p) as (keyof Policy)[]).filter((k) => JSON.stringify(p[k]) !== JSON.stringify(base[k])).length;
  const set = <K extends keyof Policy>(k: K, v: Policy[K]) => setP({ ...p, [k]: v });
  const own = p.letters[letter] ?? {}, def = LETTER_DEFAULTS[letter as keyof typeof LETTER_DEFAULTS];
  async function save() {
    setBusy(true); setError("");
    try { await post("comp/policy", { ...p, components: p.components.map(({ amount: _a, ...c }) => c) }); setBase(p); notify({ id: "comp", tone: "success", title: "Pay policy saved", timeout: 3000 }); router.refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  }
  return <div className={css.policy}>
    <section className={css.section} aria-label="Who decides"><header><h2>Who decides</h2></header><div className={styles.modalBody}>
      <label className={styles.field}>A pay change, offer, pause or bonus is approved by
        <SelectField value={p.approvers} disabled={!p.canEditApprovers} onChange={(e) => set("approvers", e.target.value)}><option value="founders">A founder</option><option value="leadership">Leadership</option><option value="second_hr">A second person in HR</option></SelectField></label>
      <label className={styles.field}>Confirming or extending probation
        <SelectField value={p.probationApproval} disabled={!p.canEditApprovers} onChange={(e) => set("probationApproval", e.target.value)}><option value="hr">HR records it</option><option value="founder">A founder approves it</option></SelectField></label>
      <label className={styles.field}>Managers see<SelectField value={p.managers} onChange={(e) => set("managers", e.target.value)}><option value="none">Nothing about pay</option><option value="status">Their people’s status and dates, never amounts</option></SelectField></label>
      <p className={`${styles.wide} ${css.quiet}`}>Founders: {p.founders?.map((f) => f.name).join(", ") || "none"}{p.foundersNamed ? "" : " (no founders are named in HR settings, so leadership counts as founders)"}. HR proposes; nobody approves what they proposed or decides their own pay.{!p.canEditApprovers ? " Only leadership changes who approves." : ""}</p>
    </div></section>
    <section className={css.section} aria-label="Probation and notice"><header><h2>Probation, notice and offers</h2></header><div className={styles.modalBody}>
      <label className={styles.field}>Probation, days<input inputMode="numeric" value={num(p.probationDays)} onChange={(e) => set("probationDays", Number(e.target.value) || 0)} /></label>
      <label className={styles.field}>Remind the manager and HR, days before the end<input inputMode="numeric" value={num(p.remindDays)} onChange={(e) => set("remindDays", Number(e.target.value) || 1)} /></label>
      <label className={styles.field}>Notice in probation, days<input inputMode="numeric" value={num(p.noticeProbation)} placeholder="The exit rule's (15)" onChange={(e) => set("noticeProbation", e.target.value === "" ? null : Number(e.target.value))} /></label>
      <label className={styles.field}>Notice once confirmed, days<input inputMode="numeric" value={num(p.noticeConfirmed)} placeholder="The exit rule's (30)" onChange={(e) => set("noticeConfirmed", e.target.value === "" ? null : Number(e.target.value))} /></label>
      <label className={styles.field}>An offer stays open, days<input inputMode="numeric" value={num(p.offerDays)} onChange={(e) => set("offerDays", Number(e.target.value) || 7)} /></label>
      <label className={styles.field}>Leave encashment<SelectField value={p.encashBasis} onChange={(e) => set("encashBasis", e.target.value)}><option value="basic">Basic ÷ days a month</option><option value="gross">Gross ÷ days a month</option><option value="none">None</option></SelectField></label>
      <label className={styles.field}>Days a month for a day’s pay<SelectField value={String(p.encashDivisor)} onChange={(e) => set("encashDivisor", Number(e.target.value))}><option value="30">30</option><option value="26">26 (working days)</option></SelectField></label>
      <label className={styles.field}>Advances and loans: at most, months<input inputMode="numeric" value={num(p.recoverMax)} onChange={(e) => set("recoverMax", Number(e.target.value) || 1)} /></label>
    </div></section>
    <section className={css.section} aria-label="Salary structure"><header><h2>Salary structure</h2><span className={css.quiet}>Each component as a share of gross or of another component; one takes the balance.</span></header>
      <table className={css.policyTable}><thead><tr><th scope="col">Component</th><th scope="col">Kind</th><th scope="col">Share</th><th scope="col">Of</th><th scope="col">Cap a month (₹)</th></tr></thead><tbody>
        {p.components.map((c, i) => { const put = (x: Partial<Component>) => set("components", p.components.map((y, j) => (j === i ? { ...y, ...x } : y)));
          return <tr key={c.key}><td><input aria-label={`Name of ${c.key}`} value={c.label} onChange={(e) => put({ label: e.target.value })} /></td>
            <td><SelectField aria-label={`Kind of ${c.label}`} value={c.kind} onChange={(e) => put({ kind: e.target.value as Component["kind"] })}><option value="earning">Earning</option><option value="employer">Paid by the company</option></SelectField></td>
            <td>{c.balance ? "The balance" : <input aria-label={`Share of ${c.label}`} inputMode="decimal" value={num(c.pct)} onChange={(e) => put({ pct: Number(e.target.value) || 0 })} />}</td>
            <td>{c.balance ? "" : <SelectField aria-label={`Base of ${c.label}`} value={c.of ?? "gross"} onChange={(e) => put({ of: e.target.value })}><option value="gross">Gross</option>{p.components.filter((y) => y.key !== c.key && y.kind === "earning").map((y) => <option key={y.key} value={y.key}>{y.label}</option>)}</SelectField>}</td>
            <td><input aria-label={`Cap of ${c.label}`} inputMode="numeric" value={c.cap ? String(c.cap / 100) : ""} placeholder="None" onChange={(e) => put({ cap: e.target.value ? Number(e.target.value) * 100 : undefined })} /></td></tr>; })}
      </tbody></table>
    </section>
    <section className={css.section} aria-label="Claims"><header><h2>Reimbursement claims</h2></header><div className={styles.modalBody}>
      <label className={styles.field}>Above this, HR or a founder approves too (₹)<input inputMode="numeric" value={num(p.claimThreshold)} placeholder="Never" onChange={(e) => set("claimThreshold", e.target.value === "" ? null : Number(e.target.value))} /></label>
      <div className={styles.wide}><table className={css.policyTable}><thead><tr><th scope="col">Category</th><th scope="col">Monthly limit a person (₹)</th></tr></thead><tbody>
        {p.claimCategories.map((c, i) => <tr key={c.key}><td><input aria-label={`Category ${c.key}`} value={c.label} onChange={(e) => set("claimCategories", p.claimCategories.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} /></td>
          <td><input aria-label={`Limit for ${c.label}`} inputMode="numeric" value={c.cap ? String(c.cap) : ""} placeholder="No limit" onChange={(e) => set("claimCategories", p.claimCategories.map((y, j) => (j === i ? { ...y, cap: e.target.value ? Number(e.target.value) : undefined } : y)))} /></td></tr>)}
      </tbody></table></div>
    </div></section>
    <section className={css.section} aria-label="Letters"><header><h2>Letters</h2><span className={css.quiet}>{"Fields in double braces are filled in: {{firstName}}, {{role}}, {{effective}}, {{paySentence}}, {{reason}} and others. Empty paragraphs are left out."}</span></header><div className={styles.modalBody}>
      <label className={styles.field}>Letter<SelectField value={letter} onChange={(e) => setLetter(e.target.value)}>{LETTER_KINDS.filter((k) => k !== "start").map((k) => <option key={k} value={k}>{LETTER_KIND[k]}</option>)}</SelectField></label>
      <label className={styles.field}>Title<input value={own.title ?? ""} placeholder={def.title} onChange={(e) => set("letters", { ...p.letters, [letter]: { ...own, title: e.target.value } })} /></label>
      <label className={`${styles.field} ${styles.wide}`}>Words<textarea className={css.letterBody} value={own.body ?? def.body} onChange={(e) => set("letters", { ...p.letters, [letter]: { ...own, body: e.target.value } })} /></label>
      {own.body || own.title ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => { const next = { ...p.letters }; delete next[letter]; set("letters", next); }}>Use Pulse’s wording</button> : null}
    </div></section>
    <SaveBar changes={changes} busy={busy} error={error} onSave={() => void save()} onDiscard={() => { setP(base); setError(""); }} saveLabel="Save the policy" />
  </div>;
}
