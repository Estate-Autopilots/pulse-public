"use client";
// READY (0972): Hiring for one job: the candidates linked to it and where each stands (applied → interview → offer →
// hired, or rejected / withdrawn). The interview stage keeps when, who interviews and where, and one task for the
// interviewer due then. Candidates themselves are added under HR → People moves; here they are linked to the job.
import { CalendarClock, UserPlus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { notify } from "@pulse/ui-shell";
import { Modal, post } from "../../../records";
import { Badge, styles } from "../../../ui";
import skills from "../../[id]/skills.module.css";
import css from "../jobs.module.css";
import { SelectField } from "../../../kit/select-field";

export type Application = { id: string; personId: string; name: string; role: string | null; stage: Stage; interviewAt: string | null; interviewerId: string | null;
  interviewer: string | null; place: string | null; taskId: string | null; note: string | null; updatedAt: string };
export type Hiring = { applications: Application[]; pool: { id: string; name: string; role: string | null; stage: string }[]; interviewers: { id: string; name: string }[] };
type Stage = "applied" | "interview" | "offer" | "hired" | "rejected" | "withdrawn";
const STAGES: { value: Stage; label: string; tone: "neutral" | "accent" | "success" | "warning" }[] = [
  { value: "applied", label: "Applied", tone: "neutral" }, { value: "interview", label: "Interview", tone: "accent" }, { value: "offer", label: "Offer", tone: "accent" },
  { value: "hired", label: "Hired", tone: "success" }, { value: "rejected", label: "Not taken", tone: "warning" }, { value: "withdrawn", label: "Withdrew", tone: "neutral" },
];
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
/** A datetime-local value in the viewer's own clock. */
const local = (iso: string | null) => { if (!iso) return ""; const d = new Date(iso); const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16); };

export function HiringCard({ jobId, data, me }: { jobId: string; data: Hiring; me: string | null }) {
  const router = useRouter();
  const [pick, setPick] = useState(""), [busy, setBusy] = useState(false), [editing, setEditing] = useState<Application | null>(null);
  async function link(e: FormEvent) {
    e.preventDefault(); if (!pick) return; setBusy(true);
    try { await post(`hiring/jobs/${jobId}/applications`, { personId: pick }); setPick(""); notify({ id: "hiring", tone: "success", title: "Linked to the job", timeout: 2500 }); router.refresh(); }
    catch (err) { notify({ id: "hiring", tone: "error", title: "Not linked", message: msg(err) }); } finally { setBusy(false); }
  }
  async function stage(a: Application, s: Stage) {
    if (s === "interview" && !a.interviewAt) { setEditing({ ...a, stage: "interview" }); return; }
    try { await post(`hiring/applications/${a.id}`, { stage: s }); router.refresh(); }
    catch (err) { notify({ id: "hiring", tone: "error", title: "Not changed", message: msg(err) }); }
  }
  const tone = (s: Stage) => STAGES.find((x) => x.value === s)?.tone ?? "neutral";
  return <section id="job-hiring" className={skills.card} data-wide="" aria-labelledby="job-hiring-title">
    <header className={skills.cardHead}><span className={skills.cardIcon} aria-hidden="true"><UserPlus size={16} /></span>
      <div><h3 id="job-hiring-title">Candidates for this job</h3><p>{data.applications.length ? `${data.applications.length} linked · interviews get a task for the interviewer` : "Link candidates added under HR → People moves."}</p></div></header>
    <div className={skills.cardBody}>
      {data.applications.length ? <ul className={css.hiring}>{data.applications.map((a) => <li key={a.id}>
        <div className={css.hiringWho}><b>{a.name}</b>{a.role ? <small>{a.role}</small> : null}</div>
        <div className={css.hiringStage}>
          <Badge tone={tone(a.stage)}>{STAGES.find((x) => x.value === a.stage)?.label ?? a.stage}</Badge>
          {a.stage === "interview" && a.interviewAt ? <span className={css.hiringWhen}><CalendarClock size={13} aria-hidden="true" />{when(a.interviewAt)}{a.interviewer ? ` · ${a.interviewer}` : ""}{a.place ? ` · ${a.place}` : ""}</span> : null}
          {a.taskId && a.stage === "interview" ? <Link className={styles.fill} href={`/tasks/${a.taskId}`}>Interview task</Link> : null}
        </div>
        <div className={css.hiringTools}>
          <SelectField value={a.stage} onChange={(e) => void stage(a, e.target.value as Stage)} aria-label={`Stage for ${a.name}`}>
            {STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</SelectField>
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setEditing({ ...a, stage: "interview" })}><CalendarClock size={13} aria-hidden="true" />{a.interviewAt ? "Reschedule" : "Schedule interview"}</button>
        </div>
      </li>)}</ul> : null}
      {data.pool.length ? <form className={css.hiringLink} onSubmit={link}>
        <label><span>Link a candidate</span><SelectField value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Choose a candidate…</option>
          {data.pool.map((p) => <option key={p.id} value={p.id}>{p.name}{p.role ? ` · ${p.role}` : ""}{p.stage === "offer" ? " (offer made)" : ""}</option>)}</SelectField></label>
        <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !pick}>Link to this job</button>
      </form> : <p className={skills.muted}>Every candidate is linked. <Link className={styles.fill} href="/hr?tab=moves">Add a candidate</Link> under HR → People moves.</p>}
    </div>
    {editing ? <Interview a={editing} interviewers={data.interviewers} me={me} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); router.refresh(); }} /> : null}
  </section>;
}

function Interview({ a, interviewers, me, onClose, onSaved }: { a: Application; interviewers: Hiring["interviewers"]; me: string | null; onClose: () => void; onSaved: () => void }) {
  const [at, setAt] = useState(local(a.interviewAt)), [who, setWho] = useState(a.interviewerId ?? me ?? ""), [place, setPlace] = useState(a.place ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(e: FormEvent) {
    e.preventDefault(); if (!at) { setError("Choose the date and time"); return; }
    setBusy(true); setError("");
    try { await post(`hiring/applications/${a.id}`, { stage: "interview", interviewAt: new Date(at).toISOString(), interviewerId: who || null, place });
      notify({ id: "hiring", tone: "success", title: `Interview set for ${a.name}`, message: "The interviewer has a task due then.", timeout: 3500 }); onSaved(); }
    catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }
  return <Modal title={`Interview: ${a.name}`} sub="The interviewer gets a task due at this time" onClose={onClose}
    foot={<><p role="alert" className={styles.status}>{error}</p><button type="button" className={styles.btn} onClick={onClose}>Cancel</button><button type="submit" form="hiring-interview" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Saving…" : "Save interview"}</button></>}>
    <form id="hiring-interview" className={styles.modalBody} onSubmit={save}>
      <label className={styles.field}>When<input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required /></label>
      <label className={styles.field}>Interviewer<SelectField value={who} onChange={(e) => setWho(e.target.value)}>{interviewers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectField></label>
      <label className={`${styles.field} ${styles.wide}`}>Where<input value={place} onChange={(e) => setPlace(e.target.value)} maxLength={200} placeholder="Office, a video call link, or a phone call" /></label>
    </form>
  </Modal>;
}
