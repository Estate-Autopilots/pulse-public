"use client";
// Move someone to their next stage (HR and admins): the date it happens, and what that stage needs (the last working
// day for a notice, how they left, the probation end). The database checks the same rules and keeps the move dated.
import { ArrowRightLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { notify } from "@pulse/ui-shell";
import { shiftDay } from "../../lib/format";
import { Modal, post } from "../../records";
import { styles } from "../../ui";
import { LEFT_LABEL, NEXT, STAGE_LABEL, moveLabel, type LeftType, type Stage } from "./types";
import css from "./moves.module.css";
import { DateField } from "../../kit/date-field";
import { SelectField } from "../../kit/select-field";

export function MoveButton({ person, stage, today, small }: { person: { id: string; name: string }; stage: Stage; today: string; small?: boolean }) {
  const router = useRouter();
  const options = NEXT[stage];
  const [open, setOpen] = useState(false), [to, setTo] = useState<Stage>(options[0]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [on, setOn] = useState(today), [lwd, setLwd] = useState(shiftDay(today, 30)), [type, setType] = useState<LeftType | "">(""), [probationTo, setProbationTo] = useState(shiftDay(today, 90)), [note, setNote] = useState("");
  const [caseId, setCaseId] = useState<string | null>(null);
  const first = person.name.split(" ")[0];
  const types: LeftType[] = ["candidate", "offer"].includes(stage) ? ["not_joined"] : ["resigned", "terminated", "contract_ended"];
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const out = await post<{ caseId: string | null }>(`lifecycle/people/${person.id}/move`, { to, effectiveOn: on, lastWorkingDay: to === "notice" ? lwd : undefined, leftType: to === "left" ? type : undefined, probationTo: to === "probation" ? probationTo : undefined, note });
      router.refresh();
      if (out.caseId) setCaseId(out.caseId); else setOpen(false);
      notify({ id: `move:${person.id}`, tone: "success", title: `${first}: ${STAGE_LABEL[to]}`, message: to === "left" ? "Alumni now: out of current counts and groups, history kept." : to === "notice" ? "The leaving checklist is open." : to === "joining" ? "The joining checklist is open. Nothing was sent." : "Saved with today's date.", timeout: 3500 });
    } catch (err) { setError(err instanceof Error ? err.message : "Not saved"); } finally { setBusy(false); }
  }
  return <>
    <button type="button" className={`${styles.btn}${small ? ` ${styles.btnSmall}` : ""}`} onClick={() => { setOpen(true); setCaseId(null); }}><ArrowRightLeft size={13} aria-hidden="true" />Move</button>
    {open ? <Modal title={`Move ${first}`} sub={`Now: ${STAGE_LABEL[stage]}. Every move is dated and kept.`} onClose={() => setOpen(false)}
      foot={caseId ? <><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Close</button><Link className={`${styles.btn} ${styles.btnPrimary}`} href={`/hr/moves/${caseId}`}>Open the checklist</Link></>
        : <><button type="button" className={styles.btn} onClick={() => setOpen(false)}>Cancel</button><button type="submit" form={`move-${person.id}`} className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || (to === "left" && !type)}>{moveLabel(stage, to)}</button></>}>
      {caseId ? <p className={css.note} role="status">Done. The {to === "joining" ? "joining" : "leaving"} checklist is open: Pulse proposes each step and you confirm it.</p> :
      <form id={`move-${person.id}`} className={css.form} onSubmit={save}>
        <fieldset className={css.field} data-wide="" style={{ border: 0, padding: 0, margin: 0 }}><legend style={{ marginBottom: 4 }}>To</legend>
          <div className={css.chips} role="radiogroup">{options.map((o) => <label key={o} style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--theme-text)", fontSize: 13 }}>
            <input type="radio" name="to" checked={to === o} onChange={() => setTo(o)} />{moveLabel(stage, o)}</label>)}</div></fieldset>
        <label className={css.field}><span>{to === "notice" ? "Notice given on" : to === "left" ? "Last working day" : "From"}</span><DateField value={on} onChange={(e) => setOn(e.target.value)} max={to === "left" ? today : undefined} required /></label>
        {to === "notice" ? <label className={css.field}><span>Last working day</span><DateField value={lwd} min={on} onChange={(e) => setLwd(e.target.value)} required /></label> : null}
        {to === "probation" ? <label className={css.field}><span>Probation ends</span><DateField value={probationTo} min={on} onChange={(e) => setProbationTo(e.target.value)} /></label> : null}
        {to === "left" ? <label className={css.field}><span>How they left</span><SelectField value={type} onChange={(e) => setType(e.target.value as LeftType)} required><option value="">Choose…</option>{types.map((t) => <option key={t} value={t}>{LEFT_LABEL[t]}</option>)}</SelectField></label> : null}
        <label className={css.field} data-wide=""><span>Note (kept with the move)</span><textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></label>
        {to === "left" ? <p className={css.note} data-wide="">They become alumni: out of current counts, groups, pickers and attendance, signed out of Pulse. Their tasks, deliveries and messages stay. A last working day still to come is a notice.</p> : null}
        {to === "joining" ? <p className={css.note}>Opens the joining checklist. No invitation is sent until you press Send on their record.</p> : null}
        {error ? <p role="alert" className={css.note} style={{ color: "var(--theme-danger)" }}>{error}</p> : null}
      </form>}
    </Modal> : null}
  </>;
}
