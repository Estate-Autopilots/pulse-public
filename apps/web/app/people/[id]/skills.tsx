"use client";
// R48 (PLAN P21): a person's skills, experience and internal CV on their profile. The person picks skills from the
// company's list (an approved taxonomy once the owner approves one, HR's local skills meanwhile), says how well on the
// scale, since when and when last, and links work that shows it; their manager, pod head or HR marks what they saw,
// separately and per version; the person reviews the CV others may read, and sees who opened it. Nothing here comes
// from app usage or activity, and the database decides every rule (migration 0360).
import { BadgeCheck, Briefcase, Download, FileText, FolderKanban, ListChecks, MessageSquareText, Plus, Ruler, Search, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { notify } from "@pulse/ui-shell";
import { Modal, RecordForm, post, type FieldDef } from "../../records";
import { Badge, styles } from "../../ui";
import css from "./skills.module.css";
import { OUTCOME, RequirementExplain, type ReqResult, type Scale, type Weights } from "../jobs/explain";

type Level = { level: number; label: string; description: string };
type Rubric = { confirmed: boolean; confirmedAt?: string; levels: Level[] };
type Source = { family: string; version: string; language: string; dataLicence: string; softwareLicence: string | null; attribution: string; adapted: string; sourceUrl: string | null; importedAt: string };
type Evidence = { id: string; kind: "task" | "project" | "experience"; ref: string; title: string | null; state: "approved" | "claimed" | "unavailable" };
type Verification = { id: string; level: number; basis: "manager" | "hr"; by: string; at: string; note: string | null; version: number; current: boolean };
export type Skill = { id: string; conceptId: string; family: string; code: string; label: string; status: "active" | "deprecated" | "absent"; local: boolean;
  replacedBy: { id: string; label: string } | null; version: number; level: number; since: string | null; lastUsed: string | null; note: string | null;
  verification: Verification | null; evidence: Evidence[] };
export type Experience = { id: string; version: number; title: string; projectId: string | null; project: string | null; started: string; ended: string | null;
  responsibilities: string | null; outcomes: string | null; confirmed: { by: string; basis: string; at: string; note: string | null; version: number; current: boolean } | null };
export type SkillProfile = { skills: Skill[]; experience: Experience[]; rubric: Rubric; sources: Source[]; can: { edit: boolean; verify: boolean; curate: boolean }; jobs?: boolean };
type Work = { id: string; title: string; state: "approved" | "claimed" };
export type MyWork = { tasks: Work[]; projects: Work[] };
type CvSkill = { label: string; family: string; local: boolean; level: number; levelLabel: string | null; since: string | null; lastUsed: string | null;
  verified: { level: number; levelLabel: string | null; by: string; basis: string; at: string } | null; approvedWork: string[]; claimedWork: number };
type CvBody = { person: { name: string; role: string | null; team: string | null; pod: string | null }; headline: string | null; summary: string | null; skills: CvSkill[];
  experience: { title: string; project: string | null; started: string; ended: string | null; responsibilities: string | null; outcomes: string | null; confirmed: { by: string; basis: string } | null }[];
  scale: Rubric; attribution: string[] };
type Draft = { body: CvBody; sha256: string; skills: string[]; experience: string[]; headline: string | null; summary: string | null };
export type CvData = { self: boolean; reviewed: { id: string; version: number; reviewedAt: string; body: CvBody } | null; changedSince?: boolean | null;
  openedBy?: { by: string | null; purpose: string; at: string }[] | null; draft: Draft | null };
type Check = { id: string; question: string; by: string | null; at: string; skill: string; before: ReqResult; now: ReqResult | null; answer: string | null;
  answeredAt: string | null; closedAt: string | null; closeNote: string | null };
/** R49: what HR asked the person to check about internal job matching, with what Pulse read (their own record only). */
export type MyChecks = { checks: Check[]; scale: Scale; weights: Weights };
type Hit = { id: string; family: string; label: string; status: string; local: boolean; description: string | null; replacedBy: { id: string; label: string } | null;
  matched: { label: string; kind: string; language: string; local: boolean; former: boolean } | null };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const month = (m: string | null | undefined) => m && /^\d{4}-\d{2}/.test(m) ? `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : "";
const day = (d: string) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const FAMILY: Record<string, string> = { esco: "ESCO", onet: "O*NET", local: "Local" };
const BASIS: Record<string, string> = { manager: "manager", hr: "HR" };
const STATE: Record<Evidence["state"], { label: string; tone: "success" | "neutral" | "warning" }> = {
  approved: { label: "Approved", tone: "success" }, claimed: { label: "Not approved yet", tone: "neutral" }, unavailable: { label: "No longer available", tone: "warning" } };
const KIND_ICON = { task: ListChecks, project: FolderKanban, experience: Briefcase };
const message = (e: unknown) => e instanceof Error ? e.message : "Not saved";
const thisMonth = () => new Date().toISOString().slice(0, 7);

function Card({ id, icon, title, sub, tools, children, wide }: { id: string; icon: ReactNode; title: string; sub?: ReactNode; tools?: ReactNode; children: ReactNode; wide?: boolean }) {
  return <section id={`skills-${id}`} className={css.card} data-wide={wide ? "" : undefined} aria-labelledby={`skills-${id}-title`}>
    <header className={css.cardHead}><span className={css.cardIcon} aria-hidden="true">{icon}</span><div><h3 id={`skills-${id}-title`}>{title}</h3>{sub ? <p>{sub}</p> : null}</div>{tools ? <span className={css.tools}>{tools}</span> : null}</header>
    <div className={css.cardBody}>{children}</div>
  </section>;
}
function Dots({ level, of }: { level: number; of: number }) {
  return <span className={css.dots} aria-hidden="true">{Array.from({ length: of }, (_, i) => <i key={i} data-on={i < level ? "" : undefined} />)}</span>;
}
function Remove({ path, what, done }: { path: string; what: string; done: string }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  async function go() {
    if (!window.confirm(`Remove ${what} from your profile?`)) return;
    setBusy(true);
    try { await post(path); notify({ id: "skills", tone: "success", title: done, timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "skills", tone: "error", title: "Not removed", message: message(e) }); } finally { setBusy(false); }
  }
  return <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => void go()} aria-label={`Remove ${what}`}><Trash2 size={12} aria-hidden="true" />Remove</button>;
}

export function SkillsTab({ person, data, cv, work, checks }: { person: { id: string; name: string }; data: SkillProfile; cv: CvData | null; work: MyWork | null; checks?: MyChecks | null }) {
  const first = person.name.split(/\s+/)[0]; const me = data.can.edit;
  const levels = data.rubric.levels; const label = (n: number) => levels.find((l) => l.level === n)?.label ?? `Level ${n}`;
  const projects = work?.projects ?? [];
  const expFields: FieldDef[] = [
    { key: "title", label: "Role or piece of work", required: true, wide: true, placeholder: "e.g. Shoot lead for model videos" },
    { key: "projectId", label: "RE project (optional)", type: "select", wide: true, options: projects.map((p) => ({ value: p.id, label: p.title })), hint: projects.length ? "Only RE projects you worked on." : "No RE project is linked to you yet." },
    { key: "started", label: "From", type: "month", required: true }, { key: "ended", label: "To (empty: still doing it)", type: "month" },
    { key: "responsibilities", label: "What you were responsible for", type: "textarea", maxLength: 1500 },
    { key: "outcomes", label: "What came of it", type: "textarea", maxLength: 1500, placeholder: "Results people can check: what shipped, numbers, feedback" },
  ];
  return <div className={css.page} data-grow="">
    <section className={css.intro} aria-label="Skills and CV">
      <span className={css.introIcon} aria-hidden="true"><Sparkles size={18} /></span>
      <div><h3>{me ? "Your skills and work" : `${first}’s skills and work`}</h3>
        <p>{me ? `What you can do, how well, and the work that shows it. Your manager, pod head or HR can verify a skill; their mark stays separate from yours. Nothing here comes from app usage.${data.jobs ? " HR may compare these skills with internal jobs; nothing else about you is used, and people decide." : ""}`
          : `What ${first} says they can do and the work that shows it; a manager, pod head or HR marks what they saw separately.`}</p></div>
      <div className={css.introTools}>
        {data.can.curate ? <Link className={`${styles.btn} ${styles.btnGhost}`} href="/people/skills">Skills list</Link> : null}
        {data.can.curate && data.jobs ? <Link className={`${styles.btn} ${styles.btnGhost}`} href="/people/jobs">Internal jobs</Link> : null}
        {me ? <SkillEditor personId={person.id} data={data} work={work} /> : null}
      </div>
    </section>
    {!data.sources.length ? <p className={css.notice}>No industry taxonomy is in Pulse yet: the list holds the skills HR added. ESCO arrives once the owner approves its download and licence.</p> : null}

    <div className={css.grid}>
      {checks?.checks.length ? <Card id="checks" wide icon={<MessageSquareText size={16} />} title="Checks from HR"
        sub="HR is looking at internal jobs and asks you to check what Pulse read about one of your skills. Correct the skill above if it is wrong, then answer.">
        <ul className={css.list}>{checks.checks.map((c) => <li key={c.id} data-check={c.skill}>
          <div className={css.head}><span className={css.name}><b>{c.skill}</b><Badge tone={c.closedAt ? "neutral" : c.answeredAt ? "success" : "accent"}>{c.closedAt ? "Closed" : c.answeredAt ? "Answered" : "Waiting for you"}</Badge></span>
            <span className={css.level}>{c.by ?? "HR"} · {day(c.at)}</span></div>
          <p className={css.text}>“{c.question}”</p>
          <RequirementExplain r={c.now ?? c.before} scale={checks.scale} weights={checks.weights} who="you" self />
          {c.now && c.now.outcome !== c.before.outcome ? <p className={css.meta}>When HR asked: {OUTCOME[c.before.outcome].label}. Now: {OUTCOME[c.now.outcome].label}.</p> : null}
          {c.answer ? <p className={css.meta}>Your answer: “{c.answer}”{c.answeredAt ? ` · ${day(c.answeredAt)}` : ""}</p> : null}
          {c.closedAt ? <p className={css.meta}>Closed {day(c.closedAt)}{c.closeNote ? `: “${c.closeNote}”` : ""}</p>
            : <div className={css.actions}><RecordForm path={`ats/checks/${c.id}/answer`} complete title={`Answer about ${c.skill}`} label={c.answeredAt ? "Answer again" : "Answer"} icon="none" variant="ghost" action="Send" done="Sent"
              fields={[{ key: "answer", label: "Your answer (optional)", type: "textarea", maxLength: 500, placeholder: "e.g. I updated the level; I ran the August shoots" }]}
              note="HR sees your answer and what Pulse reads now. Change the skill itself above." /></div>}
        </li>)}</ul>
      </Card> : null}
      <Card id="list" wide icon={<Sparkles size={16} />} title="Skills" sub={data.skills.length ? `${data.skills.length} on the profile · levels are self-assessed` : undefined}>
        {data.skills.length ? <ul className={`${css.list} ${css.skills}`}>{data.skills.map((s) => {
          const v = s.verification;
          const when = [s.since ? `since ${month(s.since)}` : null, s.lastUsed ? `last used ${month(s.lastUsed)}` : "in use now"].filter(Boolean).join(" · ");
          return <li key={s.id} data-skill={s.label}>
            <div className={css.head}>
              <span className={css.name}><b>{s.label}</b><Badge tone={s.local ? "accent" : "neutral"}>{FAMILY[s.family] ?? s.family}</Badge>
                {s.status === "deprecated" ? <Badge tone="warning">{s.replacedBy ? `Replaced by ${s.replacedBy.label}` : "Retired by the source"}</Badge>
                  : s.status === "absent" ? <Badge tone="warning">Not in the current list</Badge> : null}</span>
              <span className={css.level} title={levels.find((l) => l.level === s.level)?.description}><Dots level={s.level} of={levels.length} />{label(s.level)}<small>self</small></span>
            </div>
            <p className={css.meta}>{when}{s.note ? ` · ${s.note}` : ""}</p>
            <p className={css.mark} data-state={v?.current ? "verified" : v ? "earlier" : "self"}>
              {v?.current ? <><BadgeCheck size={13} aria-hidden="true" />Verified {label(v.level)} by {v.by} ({BASIS[v.basis]}) · {day(v.at)}{v.note ? ` · “${v.note}”` : ""}</>
                : v ? <>Verified {label(v.level)} by {v.by} before {me ? "your" : `${first}’s`} last change</> : "Not verified yet"}</p>
            {s.evidence.length ? <ul className={css.evidence}>{s.evidence.map((e) => { const Icon = KIND_ICON[e.kind]; return <li key={e.id}><Icon size={12} aria-hidden="true" /><span>{e.title ?? "Work"}</span><Badge tone={STATE[e.state].tone}>{STATE[e.state].label}</Badge></li>; })}</ul> : null}
            <div className={css.actions}>
              {me ? <SkillEditor personId={person.id} data={data} work={work} skill={s} /> : null}
              {me ? <Remove path={`skills/claims/${s.id}/remove`} what={s.label} done="Skill removed" /> : null}
              {data.can.verify ? <RecordForm path={`skills/claims/${s.id}/verify`} extra={{ version: s.version }} complete title={`Verify ${s.label}`} sub={`${first} says: ${label(s.level)}`}
                label={v?.current ? "Verify again" : "Verify"} variant="ghost" icon="none" action="Verify" done="Verified"
                fields={[{ key: "level", label: "The level you saw", type: "choice", required: true, options: levels.map((l) => ({ value: String(l.level), label: `${l.level} ${l.label}`, hint: l.description })) },
                  { key: "note", label: "What you saw (optional)", type: "textarea", maxLength: 300 }]}
                values={{ level: String(v?.current ? v.level : s.level) }}
                note={`Your mark is kept apart from ${first}’s own level and stays on this version: if ${first} changes the skill, it shows as verified before the change.`} /> : null}
            </div>
          </li>;
        })}</ul> : <p className={css.muted}>{me ? "No skills yet. Add the ones you use at work, with how well and since when." : `${first} hasn’t added skills yet.`}</p>}
      </Card>

      <Card id="experience" icon={<Briefcase size={16} />} title="Experience here" sub={me ? "What you did at the company: role, months, responsibilities and outcomes." : `What ${first} did at the company.`}
        tools={me ? <RecordForm path={`people/${person.id}/experience`} complete title="Add experience" label="Add" icon="add" variant="ghost" done="Added" fields={expFields}
          note="Your manager, pod head or HR can confirm it. Changing an entry later asks for a new confirmation." /> : undefined}>
        {data.experience.length ? <ul className={css.list}>{data.experience.map((e) => <li key={e.id}>
          <div className={css.head}><span className={css.name}><b>{e.title}</b>{e.project ? <Badge tone="neutral">{e.project}</Badge> : null}</span>
            <span className={css.level}>{month(e.started)} – {e.ended ? month(e.ended) : "now"}</span></div>
          <p className={css.mark} data-state={e.confirmed?.current ? "verified" : e.confirmed ? "earlier" : "self"}>
            {e.confirmed?.current ? <><BadgeCheck size={13} aria-hidden="true" />Confirmed by {e.confirmed.by} ({BASIS[e.confirmed.basis] ?? e.confirmed.basis}) · {day(e.confirmed.at)}</>
              : e.confirmed ? <>Confirmed by {e.confirmed.by} before the last change</> : "Self-reported"}</p>
          {e.responsibilities ? <p className={css.text}><b>Responsible for:</b> {e.responsibilities}</p> : null}
          {e.outcomes ? <p className={css.text}><b>Outcomes:</b> {e.outcomes}</p> : null}
          <div className={css.actions}>
            {me ? <RecordForm path={`people/${person.id}/experience`} extra={{ id: e.id }} complete title="Edit experience" label="Edit" variant="ghost" done="Saved" fields={expFields}
              values={{ title: e.title, projectId: e.projectId, started: e.started, ended: e.ended, responsibilities: e.responsibilities, outcomes: e.outcomes }} /> : null}
            {me ? <Remove path={`skills/experience/${e.id}/remove`} what={e.title} done="Removed" /> : null}
            {data.can.verify && !e.confirmed?.current ? <RecordForm path={`skills/experience/${e.id}/confirm`} extra={{ version: e.version }} complete title={`Confirm: ${e.title}`} label="Confirm" variant="ghost" icon="none" action="Confirm" done="Confirmed"
              fields={[{ key: "note", label: "Note (optional)", type: "textarea", maxLength: 300 }]} note={`You confirm this entry as ${first} wrote it. If ${first} changes it, it asks for a new confirmation.`} /> : null}
          </div>
        </li>)}</ul> : <p className={css.muted}>{me ? "Nothing yet. Add what you did here: it makes the CV." : "Nothing recorded yet."}</p>}
      </Card>

      <Card id="cv" icon={<FileText size={16} />} title="Internal CV" sub={me ? "Built from your skills and experience. Only the version you keep is shown to your manager, HR and admins; each opening is logged." : `The version ${first} reviewed and kept. Opening it is logged and ${first} sees it.`}>
        {me && cv ? <MyCv personId={person.id} cv={cv} data={data} /> : <OpenCv personId={person.id} first={first} />}
      </Card>

      <Card id="scale" icon={<Ruler size={16} />} title="The scale" sub={data.rubric.confirmed ? "Confirmed by HR." : "Pulse’s starting scale: HR hasn’t confirmed its own yet."}>
        <ol className={css.scale}>{levels.map((l) => <li key={l.level}><b>{l.level}</b><span>{l.label}<small>{l.description}</small></span></li>)}</ol>
        {data.sources.length ? <div className={css.sources}>{data.sources.map((s) => <p key={`${s.family}${s.version}`}>{s.attribution} {FAMILY[s.family] ?? s.family} {s.version} ({s.language}). Data licence: {s.dataLicence}.{s.softwareLicence ? ` Software licence: ${s.softwareLicence}.` : ""} {s.adapted}</p>)}</div> : null}
      </Card>
    </div>
  </div>;
}

/** Add a skill (search the list, then level, months, work) or change one (its skill stays). */
function SkillEditor({ personId, data, work, skill }: { personId: string; data: SkillProfile; work: MyWork | null; skill?: Skill }) {
  const router = useRouter(); const levels = data.rubric.levels;
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [q, setQ] = useState(""), [found, setFound] = useState<{ q: string; items: Hit[] } | null>(null);
  const term = q.trim(), hits = term.length >= 2 && found?.q === term ? found.items : null;
  const [pick, setPick] = useState<{ id: string; label: string; family: string } | null>(null);
  const [level, setLevel] = useState(0), [since, setSince] = useState(""), [last, setLast] = useState(""), [now, setNow] = useState(true), [note, setNote] = useState("");
  const [links, setLinks] = useState<Set<string>>(new Set());
  function start() {
    setPick(skill ? { id: skill.conceptId, label: skill.label, family: skill.family } : null); setLevel(skill?.level ?? 0); setSince(skill?.since ?? ""); setLast(skill?.lastUsed ?? "");
    setNow(!skill?.lastUsed); setNote(skill?.note ?? ""); setLinks(new Set((skill?.evidence ?? []).filter((e) => e.state !== "unavailable").map((e) => `${e.kind}:${e.ref}`)));
    setQ(""); setFound(null); setError(""); setOpen(true);
  }
  useEffect(() => {
    if (!open || skill || term.length < 2) return;
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      fetch(`/api/v0/skills/catalog?q=${encodeURIComponent(term)}`, { signal: ctl.signal }).then((r) => r.json()).then((d) => setFound({ q: term, items: d.items ?? [] })).catch(() => undefined);
    }, 220);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [term, open, skill]);
  const have = new Set(data.skills.map((s) => s.conceptId));
  const options: { key: string; title: string; state: string; kind: Evidence["kind"] }[] = [
    ...(work?.tasks ?? []).map((t) => ({ key: `task:${t.id}`, title: t.title, state: t.state, kind: "task" as const })),
    ...(work?.projects ?? []).map((p) => ({ key: `project:${p.id}`, title: p.title, state: p.state, kind: "project" as const })),
    ...data.experience.map((e) => ({ key: `experience:${e.id}`, title: e.title, state: e.confirmed?.current ? "approved" : "claimed", kind: "experience" as const })),
  ];
  async function save() {
    if (!pick) { setError("Choose a skill from the list"); return; }
    if (!level) { setError("Choose how well"); return; }
    setBusy(true); setError("");
    try {
      await post(`people/${personId}/skills`, { conceptId: pick.id, level, since, lastUsed: now ? "" : last, note,
        evidence: [...links].map((k) => ({ kind: k.slice(0, k.indexOf(":")), id: k.slice(k.indexOf(":") + 1) })) });
      setOpen(false); notify({ id: "skills", tone: "success", title: skill ? "Skill saved" : `${pick.label} added`, timeout: 2500 }); router.refresh();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <>
    <button type="button" className={skill ? `${styles.btn} ${styles.btnSmall} ${styles.btnGhost}` : `${styles.btn} ${styles.btnPrimary}`} onClick={start}>{skill ? "Edit" : <><Plus size={14} aria-hidden="true" />Add a skill</>}</button>
    {open ? <Modal title={skill ? `Edit ${skill.label}` : "Add a skill"} sub={skill ? "Changing the level or months asks for a new verification." : "From the company’s list."} onClose={() => setOpen(false)} scroll
      foot={<div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !pick || !level} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button></div>}>
      <div className={css.form}>
        {pick ? <div className={css.picked}><b>{pick.label}<Badge tone={pick.family === "local" ? "accent" : "neutral"}>{FAMILY[pick.family] ?? pick.family}</Badge></b>
          {!skill ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setPick(null)}>Change</button> : null}</div>
          : <div className={css.fieldset}>
            <label className={css.search}><Search size={15} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search skills, e.g. video editing" aria-label="Search skills" autoComplete="off" /></label>
            {hits === null ? <p className={css.muted}>{term.length >= 2 ? "Searching…" : "Type two letters or more."} Local names (for example in Hindi or Marathi) find a skill too.</p>
              : hits.length ? <ul className={css.results}>{hits.map((h) => {
                const taken = have.has(h.id), off = h.status !== "active";
                return <li key={h.id}><button type="button" className={css.result} disabled={taken || off} onClick={() => setPick({ id: h.id, label: h.label, family: h.family })}>
                  <b>{h.label}<Badge tone={h.local ? "accent" : "neutral"}>{FAMILY[h.family] ?? h.family}</Badge>{taken ? <Badge tone="success">On your profile</Badge> : null}</b>
                  {h.matched ? <small>{h.matched.former ? `Formerly “${h.matched.label}”` : h.matched.local ? `Local name “${h.matched.label}” (${h.matched.language}, not an official translation)` : `Also called “${h.matched.label}”`}</small> : null}
                  {off ? <small>{h.replacedBy ? `No longer offered: choose ${h.replacedBy.label}` : "No longer offered"}</small> : h.description ? <small>{h.description}</small> : null}
                </button></li>;
              })}</ul> : <p className={css.muted}>Nothing in the list matches. Ask HR to add it as a local skill.</p>}
          </div>}
        <fieldset className={css.fieldset}><legend>How well (your own assessment){data.rubric.confirmed ? "" : " · Pulse’s starting scale"}</legend>
          <div className={css.levels}>{levels.map((l) => <label key={l.level} className={css.levelOption}><input type="radio" name="level" checked={level === l.level} onChange={() => setLevel(l.level)} />
            <span><b>{l.level} {l.label}</b><small>{l.description}</small></span></label>)}</div>
        </fieldset>
        <div className={css.months}>
          <label className={styles.field}><span>Since (optional)</span><input type="month" value={since} max={thisMonth()} onChange={(e) => setSince(e.target.value)} /></label>
          <label className={styles.field}><span>Last used</span><input type="month" value={now ? "" : last} max={thisMonth()} disabled={now} onChange={(e) => setLast(e.target.value)} /></label>
        </div>
        <label className={css.check}><input type="checkbox" checked={now} onChange={(e) => setNow(e.target.checked)} />I still use it</label>
        <label className={styles.field}><span>Note (optional)</span><textarea value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Tools, kinds of work, anything that helps" /></label>
        <fieldset className={css.fieldset}><legend>Work that shows it (optional) · only your own work</legend>
          {options.length ? <ul className={css.works}>{options.map((o) => { const Icon = KIND_ICON[o.kind]; return <li key={o.key}><label>
            <input type="checkbox" checked={links.has(o.key)} onChange={(e) => setLinks((cur) => { const next = new Set(cur); if (e.target.checked) next.add(o.key); else next.delete(o.key); return next; })} />
            <Icon size={13} aria-hidden="true" /><span className={css.workTitle}>{o.title}</span><Badge tone={o.state === "approved" ? "success" : "neutral"}>{o.state === "approved" ? "Approved" : "Not approved yet"}</Badge></label></li>; })}</ul>
            : <p className={css.muted}>No tasks, RE projects or experience entries of yours yet.</p>}
        </fieldset>
      </div>
    </Modal> : null}
  </>;
}

/** The CV as a document: what is self-assessed, verified and approved, the scale and the attribution. */
function CvView({ body }: { body: CvBody }) {
  const p = body.person;
  return <article className={css.cv} aria-label={`CV of ${p.name}`}>
    <div><h4>{p.name}</h4><p className={css.meta}>{[p.role, p.team, p.pod ? (/^pod\b/i.test(p.pod) ? p.pod : `Pod ${p.pod}`) : null].filter(Boolean).join(" · ")}</p></div>
    {body.headline ? <p><b>{body.headline}</b></p> : null}
    {body.summary ? <p>{body.summary}</p> : null}
    {body.skills.length ? <><h5>Skills</h5><ul>{body.skills.map((s) => <li key={s.label}><b>{s.label}</b> ({FAMILY[s.family] ?? s.family}): {s.levelLabel ?? `level ${s.level}`}, self-assessed;{" "}
      {s.verified ? `verified ${s.verified.levelLabel ?? s.verified.level} by ${s.verified.by} (${BASIS[s.verified.basis] ?? s.verified.basis})` : "not verified yet"}
      {s.approvedWork.length ? <span className={css.meta}> · Approved work: {s.approvedWork.join("; ")}</span> : null}
      {s.claimedWork ? <span className={css.meta}> · {s.claimedWork} more linked, not approved yet</span> : null}</li>)}</ul></> : null}
    {body.experience.length ? <><h5>Experience</h5><ul>{body.experience.map((e, i) => <li key={i}><b>{e.title}</b>{e.project ? ` · ${e.project}` : ""} <span className={css.meta}>({month(e.started)} – {e.ended ? month(e.ended) : "now"}; {e.confirmed ? `confirmed by ${e.confirmed.by}` : "self-reported"})</span>
      {e.responsibilities ? <p className={css.text}>Responsible for: {e.responsibilities}</p> : null}{e.outcomes ? <p className={css.text}>Outcomes: {e.outcomes}</p> : null}</li>)}</ul></> : null}
    <p className={css.cvFoot}>Scale: {body.scale.confirmed ? "confirmed by HR" : "Pulse’s starting scale, not yet confirmed by HR"} ({body.scale.levels.map((l) => `${l.level} ${l.label}`).join(", ")}).{body.attribution.length ? ` ${body.attribution.join(" ")}` : ""}</p>
  </article>;
}

function MyCv({ personId, cv, data }: { personId: string; cv: CvData; data: SkillProfile }) {
  const r = cv.reviewed;
  return <>
    {r ? <p className={css.mark} data-state={cv.changedSince ? "earlier" : "verified"}>{cv.changedSince ? "Your skills or experience changed since you kept it: review it again." : <><BadgeCheck size={13} aria-hidden="true" />Up to date</>}</p> : null}
    <p className={css.muted}>{r ? `Version ${r.version}, kept ${day(r.reviewedAt)}.` : "Not kept yet: nobody else sees a CV until you review and keep one."}</p>
    <div className={css.actions}>
      <CvEditor personId={personId} cv={cv} data={data} />
      {r ? <a className={`${styles.btn} ${styles.btnGhost}`} href={`/api/v0/people/${personId}/cv/export`} download><Download size={14} aria-hidden="true" />Download</a> : null}
    </div>
    {cv.openedBy?.length ? <ul className={css.opened} aria-label="Who opened your CV">{cv.openedBy.map((o, i) => <li key={i}>{o.by ?? "Someone"} {o.purpose === "resume_export" ? "downloaded" : "opened"} it · {day(o.at)}</li>)}</ul>
      : r ? <p className={css.meta}>Nobody else has opened it yet.</p> : null}
  </>;
}

/** The person chooses what goes in, writes a headline and summary, reads the result, and keeps exactly that. */
function CvEditor({ personId, cv, data }: { personId: string; cv: CvData; data: SkillProfile }) {
  const router = useRouter(); const d = cv.draft!;
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [skills, setSkills] = useState<Set<string>>(new Set(d.skills)), [exp, setExp] = useState<Set<string>>(new Set(d.experience));
  const [headline, setHeadline] = useState(d.headline ?? ""), [summary, setSummary] = useState(d.summary ?? "");
  const [preview, setPreview] = useState<Draft>(d), [stale, setStale] = useState(false);
  const toggle = (set: Set<string>, id: string, on: boolean) => { const next = new Set(set); if (on) next.add(id); else next.delete(id); return next; };
  const choice = () => ({ headline, summary, skills: [...skills], experience: [...exp] });
  async function refresh() {
    setBusy(true); setError("");
    try { setPreview(await post<Draft>(`people/${personId}/cv/preview`, choice())); setStale(false); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function keep() {
    setBusy(true); setError("");
    try { const r = await post<{ version: number }>(`people/${personId}/cv`, { ...choice(), sha256: preview.sha256 }); setOpen(false);
      notify({ id: "cv", tone: "success", title: `CV kept as version ${r.version}`, message: "Your manager, HR and admins now see this version.", timeout: 4000 }); router.refresh(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <>
    <button type="button" className={`${styles.btn}${cv.reviewed && !cv.changedSince ? "" : ` ${styles.btnPrimary}`}`} onClick={() => {
      // Start from the latest draft: skills or entries added since the page loaded are in it.
      setSkills(new Set(d.skills)); setExp(new Set(d.experience)); setHeadline(d.headline ?? ""); setSummary(d.summary ?? ""); setPreview(d); setStale(false); setError(""); setOpen(true);
    }}>{cv.reviewed ? "Review again" : "Review and keep"}</button>
    {open ? <Modal title="Your internal CV" sub="Choose what goes in and read it. Keeping it shows exactly this version to your manager, HR and admins." onClose={() => setOpen(false)} scroll
      foot={<div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(false)}>Cancel</button>
        {stale ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void refresh()}>Show the result</button>
          : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => void keep()}>Keep this version</button>}</div>}>
      <div className={css.form}>
        <label className={styles.field}><span>Headline (optional)</span><input value={headline} maxLength={120} onChange={(e) => { setHeadline(e.target.value); setStale(true); }} placeholder="e.g. Video editor for real-estate launches" /></label>
        <label className={styles.field}><span>Summary (optional)</span><textarea value={summary} maxLength={1200} onChange={(e) => { setSummary(e.target.value); setStale(true); }} /></label>
        <fieldset className={css.fieldset}><legend>Skills to include</legend>
          {data.skills.length ? <ul className={css.choose}>{data.skills.map((s) => <li key={s.id}><label><input type="checkbox" checked={skills.has(s.id)} onChange={(e) => { setSkills((cur) => toggle(cur, s.id, e.target.checked)); setStale(true); }} />{s.label}</label></li>)}</ul> : <p className={css.muted}>No skills yet.</p>}
        </fieldset>
        <fieldset className={css.fieldset}><legend>Experience to include</legend>
          {data.experience.length ? <ul className={css.choose}>{data.experience.map((x) => <li key={x.id}><label><input type="checkbox" checked={exp.has(x.id)} onChange={(e) => { setExp((cur) => toggle(cur, x.id, e.target.checked)); setStale(true); }} />{x.title}</label></li>)}</ul> : <p className={css.muted}>No experience entries yet.</p>}
        </fieldset>
        {stale ? <p className={css.notice}>You changed the choice: show the result, read it, then keep it.</p> : <CvView body={preview.body} />}
      </div>
    </Modal> : null}
  </>;
}

/** Someone else opens the kept CV on purpose (each opening is logged and the person sees it). */
function OpenCv({ personId, first }: { personId: string; first: string }) {
  const [open, setOpen] = useState(false), [cv, setCv] = useState<CvData | null>(null), [error, setError] = useState("");
  async function show() {
    setError("");
    try { const r = await fetch(`/api/v0/people/${personId}/cv`); const d = await r.json(); if (!r.ok) throw new Error(d.error ?? "Not available"); setCv(d); setOpen(true); }
    catch (e) { setError(message(e)); }
  }
  return <>
    <div className={css.actions}><button type="button" className={styles.btn} onClick={() => void show()}><FileText size={14} aria-hidden="true" />Open the CV</button></div>
    {error ? <p role="alert" className={css.muted}>{error}</p> : null}
    {open && cv ? <Modal title={`${first}’s CV`} sub={cv.reviewed ? `Version ${cv.reviewed.version}, kept by ${first} on ${day(cv.reviewed.reviewedAt)}` : undefined} onClose={() => setOpen(false)} scroll
      foot={cv.reviewed ? <div className={styles.modalFoot}><a className={`${styles.btn} ${styles.btnPrimary}`} href={`/api/v0/people/${personId}/cv/export`} download><Download size={14} aria-hidden="true" />Download</a></div> : undefined}>
      <div className={css.form}>{cv.reviewed ? <CvView body={cv.reviewed.body} /> : <p className={css.muted}>{first} hasn’t kept a CV yet.</p>}</div>
    </Modal> : null}
  </>;
}
