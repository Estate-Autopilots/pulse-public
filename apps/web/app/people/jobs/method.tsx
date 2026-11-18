"use client";
// R49: HR's and admins' list of internal jobs and the published matching method: the weights in force, earlier
// versions, and HR's acceptance (owner errand E16: HR validates example explanations before anyone is picked).
// The database decides who may change what (migration 0370).
import { BadgeCheck, Briefcase, Scale as ScaleIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { notify } from "@pulse/ui-shell";
import { Modal, RecordForm, post } from "../../records";
import { Badge, styles } from "../../ui";
import skills from "../[id]/skills.module.css";
import { MethodText, STATUS, num, type Weights } from "./explain";
import css from "./jobs.module.css";

export type JobRow = { id: string; title: string; status: "draft" | "open" | "closed"; updatedAt: string; required: number; preferred: number; picked: number; openChecks: number };
type Version = { version: number; weights: Weights; reason: string; setBy: string | null; setAt: string };
export type Method = { current: { version: number; weights: Weights; reason: string; setBy: string | null; setAt: string | null; default: boolean;
  accepted: { by: string | null; at: string; note: string } | null };
  defaults: Weights; versions: Version[]; acceptances: { version: number; by: string | null; at: string; note: string }[]; can: { review: boolean; accept: boolean } };

const day = (d: string) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const message = (e: unknown) => e instanceof Error ? e.message : "Not saved";
const KEYS: { key: keyof Weights; label: string; hint: string; step: number; max: number }[] = [
  { key: "required", label: "Required skill (points)", hint: "1 to 10", step: 0.5, max: 10 }, { key: "preferred", label: "Preferred skill (points)", hint: "0 to the required points", step: 0.5, max: 10 },
  { key: "verified", label: "Verified at the level asked", hint: "share, 0 to 1", step: 0.05, max: 1 }, { key: "approvedWork", label: "Self-assessed with approved work", hint: "share, at most verified", step: 0.05, max: 1 },
  { key: "self", label: "Self-assessed only", hint: "share, at most approved work", step: 0.05, max: 1 }, { key: "close", label: "Close match in another list", hint: "share, 0 to 1", step: 0.05, max: 1 },
  { key: "notRecent", label: "Not used within the months asked", hint: "share, 0 to 1", step: 0.05, max: 1 }];

function Card({ id, icon, title, sub, tools, children, wide }: { id: string; icon: ReactNode; title: string; sub?: ReactNode; tools?: ReactNode; children: ReactNode; wide?: boolean }) {
  return <section className={skills.card} data-wide={wide ? "" : undefined} aria-labelledby={`jobs-${id}`}>
    <header className={skills.cardHead}><span className={skills.cardIcon} aria-hidden="true">{icon}</span><div><h3 id={`jobs-${id}`}>{title}</h3>{sub ? <p>{sub}</p> : null}</div>{tools ? <span className={skills.tools}>{tools}</span> : null}</header>
    <div className={skills.cardBody}>{children}</div>
  </section>;
}

export function WeightTiles({ w }: { w: Weights }) {
  return <div className={css.weights}>{KEYS.map((k) => <div key={k.key}><b>{num(w[k.key])}</b>{k.label}</div>)}</div>;
}

export function JobsView({ jobs, method }: { jobs: JobRow[]; method: Method }) {
  const cur = method.current;
  return <div className={skills.page} data-grow="">
    <section className={skills.intro} aria-label="Internal jobs">
      <span className={skills.introIcon} aria-hidden="true"><Briefcase size={18} /></span>
      <div><h3>Match current staff to internal jobs</h3>
        <p>Describe a job by the skills it needs. Pulse reads each person’s skills, verifications and approved work and explains, skill by skill, what matched, what is unknown and what is below the level asked. People decide; Pulse never rejects anyone. External applicants are not in Pulse (owner errand E16).</p></div>
      <div className={skills.introTools}>
        <RecordForm path="ats/jobs" complete created="/people/jobs/" title="New internal job" label="New job" icon="add" variant="primary"
          fields={[{ key: "title", label: "Job", required: true, wide: true, maxLength: 120, placeholder: "e.g. Launch film editor" },
            { key: "purpose", label: "What the job is for (optional)", type: "textarea", maxLength: 1500 }]}
          note="It starts as a draft: add its skills, look at the ranking, then open it." />
      </div>
    </section>
    {!cur.accepted ? <p className={skills.notice}>HR hasn’t accepted the matching method{cur.default ? " (Pulse’s starting weights)" : ` (version ${cur.version})`} yet. Rankings are for trying out: read a few explanations on a job, then HR accepts below. Nobody can be picked until then.</p> : null}
    <div className={skills.grid}>
      <Card id="list" wide icon={<Briefcase size={16} />} title="Jobs" sub={jobs.length ? "Drafts and open jobs first." : undefined}>
        {jobs.length ? <ul className={css.jobs}>{jobs.map((j) => <li key={j.id}>
          <div className={skills.head}><span className={skills.name}><Link href={`/people/jobs/${j.id}`}>{j.title}</Link><Badge tone={STATUS[j.status].tone}>{STATUS[j.status].label}</Badge></span>
            <span className={skills.level}>Changed {day(j.updatedAt)}</span></div>
          <p className={skills.meta}>{j.required} required · {j.preferred} preferred{j.picked ? ` · ${j.picked} picked` : ""}{j.openChecks ? ` · ${j.openChecks} check${j.openChecks === 1 ? "" : "s"} open` : ""}</p>
        </li>)}</ul> : <p className={skills.muted}>No internal jobs yet. Start one with “New job”.</p>}
      </Card>

      <Card id="method" wide icon={<ScaleIcon size={16} />} title="How matching works"
        sub={cur.default ? "Pulse’s published starting weights. HR and admins can change them; each change is a new version with a reason." : `Version ${cur.version}, set by ${cur.setBy ?? "HR"} on ${day(cur.setAt!)}: “${cur.reason}”.`}
        tools={<>{method.can.review ? <WeightsEditor current={cur.weights} /> : null}
          {method.can.accept && !cur.accepted ? <RecordForm path="ats/accept" complete extra={{ version: cur.version }} title="Accept the matching method" label="Accept" icon="none" variant="primary" action="Accept" done="Accepted"
            fields={[{ key: "note", label: "Which example explanations did you check?", type: "textarea", required: true, maxLength: 600, placeholder: "e.g. The launch editor job: the top five and two people with unknowns" }]}
            note="You confirm that the explanations read right for these weights. Changing the weights later asks for a new acceptance." /> : null}</>}>
        <MethodText w={cur.weights} />
        <WeightTiles w={cur.weights} />
        <p className={`${skills.mark} ${css.accepted}`} data-state={cur.accepted ? "verified" : "self"}>{cur.accepted ? <><BadgeCheck size={13} aria-hidden="true" />Accepted by {cur.accepted.by ?? "HR"} on {day(cur.accepted.at)}: “{cur.accepted.note}”</> : "Not accepted by HR yet."}</p>
        {method.versions.length ? <ul className={skills.opened} aria-label="Earlier versions">{method.versions.map((v) => <li key={v.version}>Version {v.version} · {v.setBy ?? "HR"} · {day(v.setAt)} · {v.reason}</li>)}<li>Version 0 · Pulse’s starting weights</li></ul> : null}
      </Card>
    </div>
  </div>;
}

/** HR and admins publish a new version of the weights, with a reason. */
function WeightsEditor({ current }: { current: Weights }) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [rows, setRows] = useState<Record<string, string>>({}), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save() {
    setBusy(true); setError("");
    try {
      const weights = Object.fromEntries(KEYS.map((k) => [k.key, Number(rows[k.key])]));
      const r = await post<{ version: number }>("ats/weights", { weights, reason });
      setOpen(false); notify({ id: "weights", tone: "success", title: `Weights version ${r.version} published`, message: "HR accepts them again before anyone is picked.", timeout: 4000 }); router.refresh();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <>
    <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => { setRows(Object.fromEntries(KEYS.map((k) => [k.key, String(current[k.key])]))); setReason(""); setError(""); setOpen(true); }}>Change weights</button>
    {open ? <Modal title="Matching weights" sub="Published to everyone. A new version needs HR’s acceptance again." onClose={() => setOpen(false)} scroll
      foot={<div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || reason.trim().length < 3} onClick={() => void save()}>Publish</button></div>}>
      <div className={skills.form}>
        <div className={css.weightForm}>{KEYS.map((k) => <label key={k.key} className={styles.field}><span>{k.label}</span>
          <input type="number" min={0} max={k.max} step={k.step} value={rows[k.key] ?? ""} onChange={(e) => setRows((cur) => ({ ...cur, [k.key]: e.target.value }))} /><small>{k.hint}</small></label>)}</div>
        <label className={styles.field}><span>Why they change</span><input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Required skills should matter more" /></label>
      </div>
    </Modal> : null}
  </>;
}
