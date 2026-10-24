"use client";
// HR → Onboard team → Settings: what arriving at the office does, reminders, the payroll cut-off, profile reminders
// and which documents to ask for. Each change is recorded with who made it.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../records";
import { styles } from "../../ui";
import type { CheckinSettings, DocKindSetting } from "./types";
import css from "./onboard.module.css";
import { Select } from "../../kit";
import { dest } from "../../destinations/registry.mjs";

export function OnboardSettings({ settings, kinds, canEdit }: { settings: CheckinSettings; kinds: DocKindSetting[]; canEdit: boolean }) {
  const router = useRouter();
  const [s, setS] = useState(settings); const [busy, setBusy] = useState(false);
  const [docs, setDocs] = useState(kinds.length ? kinds : []);
  async function save(body: Record<string, unknown>, done: string) {
    setBusy(true);
    try { const next = await post<CheckinSettings>("hr/checkin-settings", body); setS({ ...s, ...next }); notify({ id: "checkin-settings", tone: "success", title: done, timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "checkin-settings", tone: "error", title: "Not saved", message: (e as Error).message }); } finally { setBusy(false); }
  }
  async function saveDocs() {
    setBusy(true);
    try { const r = await post<{ kinds: DocKindSetting[] }>("hr/onboard/kinds", { kinds: docs }); setDocs(r.kinds); notify({ id: "kinds", tone: "success", title: "Documents saved", timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "kinds", tone: "error", title: "Not saved", message: (e as Error).message }); } finally { setBusy(false); }
  }
  const off = !canEdit || busy;
  return (
    <div className={css.settings} data-grow="">
      <section className={css.card} aria-label="Arriving at the office" {...dest("hr.onboard.settings.arrival")}>
        <h3>When someone arrives at the office</h3>
        <p className={styles.muted}>Pulse notices arrival from office Wi-Fi, the office network or the phone at the office, only for people who agreed. {s.offices.count ? `${s.offices.count} office${s.offices.count === 1 ? "" : "s"} registered.` : "No office is registered yet."} <Link href="/hr?tab=policies&view=presence">Offices, Wi-Fi and networks</Link></p>
        <div className={css.choices} role="radiogroup" aria-label="Arrival">
          {([["ask", "Ask “Check in?”", "One tap to check in. Recommended to start."], ["auto", "Check in automatically when Pulse is sure", "Two signals for a few minutes, and only for people who agreed to it. Otherwise it asks."], ["off", "Do nothing", "People check in themselves."]] as const).map(([value, title, sub]) => (
            <label key={value} className={css.choice}><input type="radio" name="arrival" checked={s.arrival === value} disabled={off} onChange={() => void save({ arrival: value }, "Arrival setting saved")} /><span><b>{title}</b><small>{sub}</small></span></label>
          ))}
        </div>
        <p className={css.fine}>Check-out is never automatic. Leaving reminds the person; a forgotten check-out becomes a correction for them to confirm and you to decide.</p>
      </section>

      <section className={css.card} aria-label="Reminders" {...dest("hr.onboard.settings.reminders")}>
        <h3>Reminders</h3>
        <label className={css.choice}><input type="checkbox" checked={s.reminders.enabled} disabled={off} onChange={(e) => void save({ reminders: { ...s.reminders, enabled: e.target.checked } }, e.target.checked ? "Reminders on" : "Reminders off")} />
          <span><b>Remind people to check in, come back from a long break and check out</b><small>In Pulse and on the phone app. At most two of each a day, 15 minutes apart, never in quiet hours; anyone can snooze. {s.reminders.approvedBy ? `Turned on by ${s.reminders.approvedBy.replace(/^HR: /, "")}.` : ""}</small></span></label>
        <div className={css.row}>
          {/* UX-5A: the kit's lists, not the browser's selects. */}
          <div className={styles.kitField}><span>First check-in reminder</span><Select label="First check-in reminder" value={String(s.reminders.startOffset)} disabled={off}
            onChange={(v) => { if (v !== null) void save({ reminders: { ...s.reminders, startOffset: Number(v) } }, "Saved"); }}
            options={[0, 5, 10, 15].map((n) => ({ value: String(n), label: n ? `${n} minutes after the shift starts` : `At the shift start (${s.shift.start})` }))} /></div>
          <div className={styles.kitField}><span>A break is long after</span><Select label="A break is long after" value={String(s.reminders.longBreak)} disabled={off}
            onChange={(v) => { if (v !== null) void save({ reminders: { ...s.reminders, longBreak: Number(v) } }, "Saved"); }}
            options={[30, 45, 60, 90, 120].map((n) => ({ value: String(n), label: `${n} minutes` }))} /></div>
        </div>
      </section>

      <section className={css.card} aria-label="Payroll cut-off" {...dest("hr.onboard.settings.cutoff")}>
        <h3>Payroll cut-off</h3>
        <p className={styles.muted}>Everyone’s My desk says “This is what payroll will use; fix it before …” with this date.</p>
        <div className={styles.kitField}><span>Attendance closes for payroll on</span><Select label="Attendance closes for payroll on" value={s.cutoffDay ? String(s.cutoffDay) : null} disabled={off} noneLabel="Not set" placeholder="Not set"
          onChange={(v) => void save({ cutoffDay: v ? Number(v) : null }, "Cut-off saved")} options={Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `day ${i + 1} of each month` }))} /></div>
      </section>

      <section className={css.card} aria-label="Profiles" {...dest("hr.onboard.settings.profiles")}>
        <h3>Profiles</h3>
        <label className={css.choice}><input type="checkbox" checked={s.onboardingReminders} disabled={off} onChange={(e) => void save({ onboardingReminders: e.target.checked }, e.target.checked ? "Profile reminders on" : "Profile reminders off")} />
          <span><b>Remind people until their profile is complete</b><small>In Pulse first, then on the phone. Every two days at most, during the working day, six times at most.</small></span></label>
        <h4>Documents to ask for</h4>
        <ul className={css.kinds}>{docs.map((d, i) => <li key={d.kind}>
          <input value={d.label} disabled={off || !!d.idNumber} aria-label="Document name" onChange={(e) => setDocs(docs.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} />
          <label><input type="checkbox" checked={d.required} disabled={off} onChange={(e) => setDocs(docs.map((x, j) => j === i ? { ...x, required: e.target.checked } : x))} /> Needed</label>
          <label><input type="checkbox" checked={d.active} disabled={off} onChange={(e) => setDocs(docs.map((x, j) => j === i ? { ...x, active: e.target.checked } : x))} /> Ask</label>
        </li>)}</ul>
        {canEdit ? <div className={css.row}>
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={off || docs.length >= 12} onClick={() => setDocs([...docs, { kind: `doc_${docs.length + 1}`, label: "", required: false, idNumber: null, sort: (docs.length + 1) * 10, active: true }])}>Add a document</button>
          <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} disabled={off} onClick={() => void saveDocs()}>Save documents</button>
        </div> : null}
        <p className={css.fine}>Aadhaar and PAN numbers are kept masked (last four characters); files are encrypted; only the person and HR can open them, and each opening is logged.</p>
      </section>
    </div>
  );
}
