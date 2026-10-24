"use client";
// R49: one internal job for HR and admins. Its required and preferred skills (with the level, how recently, and other
// skills the job accepts as the same); every current staff member ranked by points with each requirement explained:
// the skill that counted and the arithmetic, every other skill on record and why it did not add, unknowns as
// "up to"; the people a reviewer picked (only once HR accepted the method) and the checks asked of people. Nothing
// here hides or rejects anyone; the database decides every rule (migration 0370).
import { ClipboardCheck, ListChecks, Search, UserCheck, Users, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { notify } from "@pulse/ui-shell";
import { Modal, RecordForm, post } from "../../../records";
import { Badge, styles } from "../../../ui";
import skills from "../../[id]/skills.module.css";
import { Ask, OUTCOME, RequirementExplain, levelName, num, type Outcome, type ReqResult, type Scale } from "../explain";
import type { Method } from "../method";
import css from "../jobs.module.css";

type Req = { id: string; conceptId: string; label: string; family: string; status: string; importance: "required" | "preferred"; minLevel: number | null;
  recentMonths: number | null; note: string | null; version: number; also: { id: string; label: string; family: string }[];
  mapped: { label: string; family: string; relation: string }[] };
type Pick = { id: string; personId: string; person: string; note: string; by: string | null; at: string; weightsVersion: number; points: number; max: number;
  withdrawn: { by: string | null; at: string; note: string | null } | null };
type Check = { id: string; personId: string; person: string; requirementId: string; skill: string; question: string; by: string | null; at: string;
  before: Outcome; after: Outcome | null; answer: string | null; answeredAt: string | null; closed: { by: string | null; at: string; note: string | null } | null };
export type Job = { id: string; title: string; purpose: string | null; status: "draft" | "open" | "closed"; createdBy: string | null; createdAt: string; updatedAt: string;
  requirements: Req[]; picks: Pick[]; checks: Check[]; weights: Method["current"]; scale: Scale };
type Cand = { personId: string; name: string; self: boolean; rank: number; picked: boolean; openCheck: boolean; points: number; max: number; upTo: number;
  matched: number; unknown: number; missing: number; requiredUnknown: number; requiredMissing: number; requirements: ReqResult[] };
export type Candidates = { weights: Method["current"]; candidates: Cand[] };
type Hit = { id: string; family: string; label: string; status: string; local: boolean; matched: { label: string; kind: string; former: boolean; local: boolean } | null };

const FAMILY: Record<string, string> = { esco: "ESCO", onet: "O*NET", local: "Local" };
const RELATION: Record<string, string> = { exact: "same skill (counts)", close: "close match (counts partly)", broad: "broader (hint only)", narrow: "narrower (hint only)", related: "related (hint only)" };
const day = (d: string) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const message = (e: unknown) => e instanceof Error ? e.message : "Not saved";
const first = (name: string) => name.split(/\s+/)[0];

function Card({ id, icon, title, sub, tools, children, wide }: { id: string; icon: ReactNode; title: string; sub?: ReactNode; tools?: ReactNode; children: ReactNode; wide?: boolean }) {
  return <section id={`job-${id}`} className={skills.card} data-wide={wide ? "" : undefined} aria-labelledby={`job-${id}-title`}>
    <header className={skills.cardHead}><span className={skills.cardIcon} aria-hidden="true">{icon}</span><div><h3 id={`job-${id}-title`}>{title}</h3>{sub ? <p>{sub}</p> : null}</div>{tools ? <span className={skills.tools}>{tools}</span> : null}</header>
    <div className={skills.cardBody}>{children}</div>
  </section>;
}

/** Search the company's skills list (approved taxonomy and HR's local skills). */
function useSkillSearch(active: boolean) {
  const [q, setQ] = useState(""), [found, setFound] = useState<{ q: string; items: Hit[] } | null>(null);
  const term = q.trim(), hits = term.length >= 2 && found?.q === term ? found.items : null;
  useEffect(() => {
    if (!active || term.length < 2) return;
    const ctl = new AbortController();
    const t = window.setTimeout(() => { fetch(`/api/v0/skills/catalog?q=${encodeURIComponent(term)}`, { signal: ctl.signal }).then((r) => r.json()).then((d) => setFound({ q: term, items: d.items ?? [] })).catch(() => undefined); }, 220);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [term, active]);
  return { q, setQ, term, hits };
}

export function JobView({ job, cands }: { job: Job; cands: Candidates }) {
  const scale = job.scale, weights = cands.weights.weights;
  const [all, setAll] = useState(false);
  const blank = cands.candidates.filter((c) => c.matched + c.missing === 0);
  const shown = all ? cands.candidates : cands.candidates.filter((c) => c.matched + c.missing > 0);
  return <div className={skills.page} data-grow="">
    <section className={skills.intro} aria-label="The job">
      <span className={skills.introIcon} aria-hidden="true"><ClipboardCheck size={18} /></span>
      <div><h3>{job.title}</h3><p>{job.purpose ?? "No description yet."} · Created by {job.createdBy ?? "HR"} on {day(job.createdAt)}.</p></div>
      <div className={skills.introTools}>
        <RecordForm path="ats/jobs" complete extra={{ id: job.id }} title="Edit the job" label="Edit" variant="ghost" done="Saved"
          values={{ title: job.title, purpose: job.purpose, status: job.status }}
          fields={[{ key: "title", label: "Job", required: true, wide: true, maxLength: 120 }, { key: "purpose", label: "What the job is for", type: "textarea", maxLength: 1500 },
            { key: "status", label: "Status", type: "choice", required: true, options: [{ value: "draft", label: "Draft", hint: "Trying out its skills and the ranking." },
              { value: "open", label: "Open", hint: "Reviewers can pick people (once HR accepted the method)." }, { value: "closed", label: "Closed", hint: "Nothing changes; everything stays readable." }] }]} />
      </div>
    </section>
    {!cands.weights.accepted ? <p className={skills.notice}>HR hasn’t accepted the matching method yet (owner errand E16): this ranking is for trying out, and nobody can be picked. <Link className={styles.fill} href="/people/jobs">How matching works</Link></p> : null}

    <div className={skills.grid}>
      <Card id="skills" wide icon={<ListChecks size={16} />} title="Skills the job needs" sub="Required skills weigh more. Other skills the job accepts as the same count like the skill."
        tools={job.status !== "closed" ? <RequirementEditor job={job} /> : undefined}>
        {job.requirements.length ? <ul className={skills.list}>{job.requirements.map((r) => <li key={r.id}>
          <div className={skills.head}><span className={skills.name}><b>{r.label}</b><Badge tone={r.family === "local" ? "accent" : "neutral"}>{FAMILY[r.family] ?? r.family}</Badge></span><Ask r={r} scale={scale} /></div>
          {r.also.length ? <p className={skills.meta}>Also accepted as the same: {r.also.map((a) => a.label).join(", ")}</p> : null}
          {r.mapped.length ? <p className={skills.meta}>In other lists: {r.mapped.map((m) => `${m.label} (${FAMILY[m.family] ?? m.family}, ${RELATION[m.relation] ?? m.relation})`).join("; ")}</p> : null}
          {r.note ? <p className={skills.text}>{r.note}</p> : null}
          {job.status !== "closed" ? <div className={skills.actions}><RequirementEditor job={job} req={r} /><RemoveRequirement req={r} /></div> : null}
        </li>)}</ul> : <p className={skills.muted}>No skills yet. Add what the job needs: required or preferred, and the level.</p>}
      </Card>

      <Card id="candidates" wide icon={<Users size={16} />} title="Current staff, ranked" sub={`${cands.candidates.length} people · points out of ${num(cands.candidates[0]?.max ?? 0)} · open a row to see every skill and how it counted`}>
        <div className={css.toolbar}>
          <p>Unknown is not a minus: “up to” is what checking unknowns could add. Ties share a rank (names only order them). Pulse never filters anyone out.</p>
          {blank.length ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setAll((x) => !x)}>
            {all ? "Hide people with nothing on record" : `Show ${blank.length} ${blank.length === 1 ? "person" : "people"} with nothing on record`}</button> : null}
        </div>
        {job.requirements.length === 0 ? <p className={css.empty}>Add the job’s skills to see a ranking.</p>
          : shown.length ? <ol className={css.cands} aria-label="Ranked candidates">{shown.map((c) => <Candidate key={c.personId} c={c} job={job} weights={weights} accepted={!!cands.weights.accepted} />)}</ol>
          : <p className={css.empty}>Nobody has any of these skills on record yet.</p>}
      </Card>

      <Card id="picks" icon={<UserCheck size={16} />} title="Picked" sub="A reviewer’s choice with a reason; the explanation as it stood is kept with it.">
        {job.picks.length ? <ul className={skills.list}>{job.picks.map((p) => <li key={p.id}>
          <div className={skills.head}><span className={skills.name}><Link className={styles.fill} href={`/people/${p.personId}?tab=skills`}>{p.person}</Link>{p.withdrawn ? <Badge tone="neutral">Withdrawn</Badge> : <Badge tone="success">Picked</Badge>}</span>
            <span className={skills.level}>{num(p.points)} of {num(p.max)} then</span></div>
          <p className={skills.meta}>“{p.note}” · {p.by ?? "Reviewer"} · {day(p.at)} · weights version {p.weightsVersion}</p>
          {p.withdrawn ? <p className={skills.meta}>Withdrawn by {p.withdrawn.by ?? "a reviewer"} on {day(p.withdrawn.at)}{p.withdrawn.note ? `: “${p.withdrawn.note}”` : ""}</p>
            : <div className={skills.actions}><RecordForm path={`ats/picks/${p.id}/withdraw`} complete title={`Withdraw ${p.person}`} label="Withdraw" icon="none" variant="ghost" action="Withdraw" done="Withdrawn"
              fields={[{ key: "note", label: "Why (optional)", type: "textarea", maxLength: 300 }]} /></div>}
        </li>)}</ul> : <p className={skills.muted}>Nobody picked yet.</p>}
      </Card>

      <Card id="checks" icon={<ClipboardCheck size={16} />} title="Checks asked" sub="People see the question and what Pulse read about them for that skill; not the job or anyone else.">
        {job.checks.length ? <ul className={skills.list}>{job.checks.map((c) => <li key={c.id}>
          <div className={skills.head}><span className={skills.name}><b>{c.person}</b><Badge tone="neutral">{c.skill}</Badge></span>
            <span className={skills.level}>{c.closed ? "Closed" : c.answeredAt ? "Answered" : "Waiting"}</span></div>
          <p className={skills.text}>“{c.question}” · {c.by ?? "Reviewer"} · {day(c.at)}</p>
          <p className={skills.meta}>Then: {OUTCOME[c.before].label}{c.after ? ` → at the answer: ${OUTCOME[c.after].label}` : ""}{c.answer ? ` · “${c.answer}”` : ""}</p>
          {c.closed ? <p className={skills.meta}>Closed by {c.closed.by ?? "a reviewer"} on {day(c.closed.at)}{c.closed.note ? `: “${c.closed.note}”` : ""}</p>
            : <div className={skills.actions}><RecordForm path={`ats/checks/${c.id}/close`} complete title="Close the check" label="Close" icon="none" variant="ghost" action="Close check" done="Closed"
              fields={[{ key: "note", label: "Note (optional)", type: "textarea", maxLength: 300 }]} /></div>}
        </li>)}</ul> : <p className={skills.muted}>No checks asked.</p>}
      </Card>
    </div>
  </div>;
}

function Candidate({ c, job, weights, accepted }: { c: Cand; job: Job; weights: Job["weights"]["weights"]; accepted: boolean }) {
  const who = first(c.name);
  const why = c.self ? "Someone else decides about you." : c.picked ? "" : job.status !== "open" ? "Open the job to pick people." : !accepted ? "Picking opens once HR accepts the method." : "";
  return <li className={css.cand} data-picked={c.picked ? "" : undefined} data-person={c.name}>
    <details>
      <summary>
        <span className={css.rank} aria-label={`Rank ${c.rank}`}>{c.rank}</span>
        <span className={css.who}><b>{c.name}{c.self ? " (you)" : ""}</b>
          <span className={css.counts}><Badge tone="success">{c.matched} matched</Badge>{c.unknown ? <Badge tone="neutral">{c.unknown} unknown</Badge> : null}{c.missing ? <Badge tone="warning">{c.missing} below level</Badge> : null}
            {c.picked ? <Badge tone="success">Picked</Badge> : null}{c.openCheck ? <Badge tone="accent">Check open</Badge> : null}
            {c.requiredMissing ? <span className={css.flag}>A required skill is below the level asked</span> : null}</span></span>
        <span className={css.score}><b>{num(c.points)} / {num(c.max)}</b>{Number(c.upTo) > Number(c.points) ? `up to ${num(c.upTo)}` : "nothing unknown"}</span>
      </summary>
      <div className={css.candBody}>
        {c.requirements.map((r) => <RequirementExplain key={r.requirementId} r={r} scale={job.scale} weights={weights} who={who} />)}
        <div className={css.actions}>
          <Link className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} href={`/people/${c.personId}?tab=skills`}>Skills & CV</Link>
          {!c.self && !c.picked && !why ? <RecordForm path={`ats/jobs/${job.id}/picks`} complete extra={{ personId: c.personId }} title={`Pick ${c.name}`} sub={`${num(c.points)} of ${num(c.max)} points, up to ${num(c.upTo)}`}
            label="Pick" icon="none" variant="primary" action="Pick" done="Picked"
            fields={[{ key: "note", label: "Why you pick them", type: "textarea", required: true, maxLength: 300, placeholder: "What you saw in the explanation and beyond it" }]}
            note="Your reason and this explanation are kept with the pick. Picking is a person’s decision; nobody else is rejected by it." /> : why ? <small>{why}</small> : null}
          {!c.self && job.status !== "closed" ? <RecordForm path={`ats/jobs/${job.id}/checks`} complete extra={{ personId: c.personId }} title={`Ask ${who} to check`} label="Ask to check" icon="none" variant="ghost" action="Ask" done="Asked"
            values={{ requirementId: (c.requirements.find((r) => r.outcome !== "matched") ?? c.requirements[0])?.requirementId ?? "" }}
            fields={[{ key: "requirementId", label: "Which skill", type: "select", required: true, options: c.requirements.map((r) => ({ value: r.requirementId ?? "", label: `${r.label}: ${OUTCOME[r.outcome].label.toLowerCase()}${r.minLevel ? ` (asks ${levelName(job.scale, r.minLevel)})` : ""}` })) },
              { key: "question", label: `Question for ${who}`, type: "textarea", required: true, maxLength: 500, placeholder: "e.g. Is your level for model shoots still Learning? Update it if not." }]}
            note={`${who} sees your question and what Pulse read about them for that skill, on their Skills & CV tab: not this job or anyone else.`} /> : null}
        </div>
      </div>
    </details>
  </li>;
}

function RemoveRequirement({ req }: { req: Req }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function go() {
    if (!window.confirm(`Remove ${req.label} from the job?`)) return;
    setBusy(true);
    try { await post(`ats/requirements/${req.id}/remove`); notify({ id: "req", tone: "success", title: "Removed", timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "req", tone: "error", title: "Not removed", message: message(e) }); } finally { setBusy(false); }
  }
  return <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => void go()}>Remove</button>;
}

/** Add a skill to the job or change one: required or preferred, the level, how recently, accepted alternatives. */
function RequirementEditor({ job, req }: { job: Job; req?: Req }) {
  const router = useRouter(); const levels = job.scale.levels;
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [pick, setPick] = useState<{ id: string; label: string; family: string } | null>(null);
  const [importance, setImportance] = useState<"required" | "preferred">("required"), [min, setMin] = useState(""), [months, setMonths] = useState(""), [note, setNote] = useState("");
  const [also, setAlso] = useState<{ id: string; label: string; family: string }[]>([]), [adding, setAdding] = useState(false);
  const main = useSkillSearch(open && !pick), alt = useSkillSearch(open && adding);
  const taken = new Set(job.requirements.filter((r) => r.id !== req?.id).map((r) => r.conceptId));
  function start() {
    setPick(req ? { id: req.conceptId, label: req.label, family: req.family } : null); setImportance(req?.importance ?? "required");
    setMin(req?.minLevel ? String(req.minLevel) : ""); setMonths(req?.recentMonths ? String(req.recentMonths) : ""); setNote(req?.note ?? ""); setAlso(req?.also ?? []);
    main.setQ(""); alt.setQ(""); setAdding(false); setError(""); setOpen(true);
  }
  async function save() {
    if (!pick) { setError("Choose a skill from the list"); return; }
    setBusy(true); setError("");
    try {
      await post(`ats/jobs/${job.id}/requirements`, { id: req?.id, conceptId: pick.id, importance, minLevel: min, recentMonths: months, also: also.map((a) => a.id), note });
      setOpen(false); notify({ id: "req", tone: "success", title: req ? "Saved" : `${pick.label} added`, timeout: 2500 }); router.refresh();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  const results = (s: ReturnType<typeof useSkillSearch>, onPick: (h: Hit) => void, skip: Set<string>) => s.hits === null
    ? <p className={skills.muted}>{s.term.length >= 2 ? "Searching…" : "Type two letters or more."}</p>
    : s.hits.length ? <ul className={skills.results}>{s.hits.map((h) => <li key={h.id}><button type="button" className={skills.result} disabled={skip.has(h.id) || h.status !== "active"} onClick={() => onPick(h)}>
      <b>{h.label}<Badge tone={h.local ? "accent" : "neutral"}>{FAMILY[h.family] ?? h.family}</Badge>{skip.has(h.id) ? <Badge tone="neutral">Already on the job</Badge> : null}</b>
      {h.matched ? <small>{h.matched.former ? `Formerly “${h.matched.label}”` : `Also called “${h.matched.label}”`}</small> : null}
      {h.status !== "active" ? <small>No longer offered</small> : null}</button></li>)}</ul>
    : <p className={skills.muted}>Nothing in the list matches. HR can add it as a local skill on the Skills list.</p>;
  return <>
    <button type="button" className={req ? `${styles.btn} ${styles.btnSmall} ${styles.btnGhost}` : `${styles.btn} ${styles.btnGhost}`} onClick={start}>{req ? "Edit" : "Add a skill"}</button>
    {open ? <Modal title={req ? `Edit ${req.label}` : "Add a skill the job needs"} sub="From the company’s skills list." onClose={() => setOpen(false)} scroll
      foot={<div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !pick} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button></div>}>
      <div className={skills.form}>
        {pick ? <div className={skills.picked}><b>{pick.label}<Badge tone={pick.family === "local" ? "accent" : "neutral"}>{FAMILY[pick.family] ?? pick.family}</Badge></b>
          {!req ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setPick(null)}>Change</button> : null}</div>
          : <div className={skills.fieldset}><label className={skills.search}><Search size={15} aria-hidden="true" /><input value={main.q} onChange={(e) => main.setQ(e.target.value)} placeholder="Search skills, e.g. video editing" aria-label="Search skills" autoComplete="off" /></label>
            {results(main, (h) => setPick({ id: h.id, label: h.label, family: h.family }), taken)}</div>}
        <fieldset className={skills.fieldset}><legend>How much it matters</legend>
          <div className={skills.levels}>{([["required", "Required", "The job needs it."], ["preferred", "Preferred", "Helps; weighs less."]] as const).map(([v, l, h]) => <label key={v} className={skills.levelOption}>
            <input type="radio" name="importance" checked={importance === v} onChange={() => setImportance(v)} /><span><b>{l}</b><small>{h}</small></span></label>)}</div>
        </fieldset>
        <div className={skills.months}>
          <label className={styles.field}><span>At least this level</span><select value={min} onChange={(e) => setMin(e.target.value)}><option value="">Any level</option>{levels.map((l) => <option key={l.level} value={l.level}>{l.level} {l.label}</option>)}</select></label>
          <label className={styles.field}><span>Used in the last … months (optional)</span><input type="number" min={1} max={240} value={months} onChange={(e) => setMonths(e.target.value)} placeholder="e.g. 12" /></label>
        </div>
        <fieldset className={skills.fieldset}><legend>Other skills the job accepts as the same (optional)</legend>
          {also.length ? <ul className={css.chips}>{also.map((a) => <li key={a.id}>{a.label}<button type="button" aria-label={`Remove ${a.label}`} onClick={() => setAlso((cur) => cur.filter((x) => x.id !== a.id))}><X size={12} aria-hidden="true" /></button></li>)}</ul> : null}
          {adding ? <><label className={skills.search}><Search size={15} aria-hidden="true" /><input value={alt.q} onChange={(e) => alt.setQ(e.target.value)} placeholder="Find another skill" aria-label="Find another skill" autoComplete="off" /></label>
            {results(alt, (h) => { setAlso((cur) => [...cur, { id: h.id, label: h.label, family: h.family }]); setAdding(false); alt.setQ(""); }, new Set([...also.map((a) => a.id), ...(pick ? [pick.id] : [])]))}</>
            : also.length < 10 ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setAdding(true)}>Add one</button> : null}
        </fieldset>
        <label className={styles.field}><span>Note (optional)</span><textarea value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="What the job does with this skill" /></label>
      </div>
    </Modal> : null}
  </>;
}
