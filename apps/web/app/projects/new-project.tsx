"use client";
import { Say } from "../kit/word";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { CalendarRange, LayoutTemplate, Plus } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { forgetWorkOptions } from "../create";
import { Modal, post } from "../records";
import { styles } from "../ui";
import { DateField } from "../kit/date-field";
import { SelectField } from "../kit/select-field";
import sc from "./stages.module.css";
import css from "./new-project.module.css";

/** PROJECTS-CREATE (owner, 4 Nov 2026: "there is no way to create a task wala project here, so much confusion on the project
 *  view"). Work → Projects starts a team project in three fields (name, lead, an optional stage plan), and a project with
 *  no stage plan gets one from its row. Client projects are not made here: a paid invoice in Billing starts them (1471).
 *  A stage plan is one of the company's delivery templates, or a ready-made starter it adds (1485); Pulse lays the stages
 *  and steps out from the kick-off day (pulse.project_plan_set). */
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not save. Try again.";
type Person = { id: string; name: string; connectionId?: string | null };
type Options = { me: string; today: string; people: Person[]; canCreateProject: boolean };
type Template = { key: string; name: string; stages: { n: number; label: string }[]; packages: { key: string; label: string }[] };
type Starter = { key: string; name: string; industry: string; summary: string; suggested: boolean; adopted: boolean; stages: string[] };
/** One choice of stage plan: the company's own template, or a starter it does not have yet. */
type Choice = { key: string; name: string; stages: string[]; note: string; starter: boolean; packages: { key: string; label: string }[] };

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api/v0/${path}`); const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "Could not load"); return d as T;
}
/** The company's templates first, then the starters it may add (all of them while it has none). */
async function loadChoices(projectId?: string): Promise<{ choices: Choice[]; canAdd: boolean }> {
  const [t, s] = await Promise.all([get<{ templates: Template[] }>("projects/templates"),
    get<{ templates: number; canAdopt: boolean; starters: Starter[] }>(`projects/starters${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`).catch(() => null)]);
  const own: Choice[] = t.templates.map((x) => ({ key: x.key, name: x.name, stages: x.stages.map((y) => y.label), note: "Your company's template", starter: false, packages: x.packages }));
  // A new project's maker leads it, and a project's lead may add the company's first template (delivery_template_adopt).
  const canAdd = !!s && (s.canAdopt || (!projectId && s.templates === 0));
  const more: Choice[] = canAdd ? s!.starters.filter((x) => !x.adopted && !own.some((o) => o.key === x.key))
    .map((x) => ({ key: x.key, name: x.name, stages: x.stages, note: x.suggested ? "Ready-made · for your industry" : `Ready-made · ${x.industry}`, starter: true, packages: [] })) : [];
  return { choices: [...own, ...more], canAdd };
}
/** Add the starter if it is new, then lay the plan out on the project from the kick-off day. */
async function setPlan(projectId: string, c: Choice, kickoff: string, pkg: string | null, leadId: string | null) {
  let packages = c.packages;
  if (c.starter) {
    await post(`projects/starters/${c.key}`, { projectId });
    packages = (await get<{ templates: Template[] }>("projects/templates")).templates.find((x) => x.key === c.key)?.packages ?? [];
  }
  const p = pkg && packages.some((x) => x.key === pkg) ? pkg : packages[0]?.key ?? null;
  // The lead's steps go to the project's lead (the plan keeps the current lead when none is given).
  return post<{ tasks: number }>(`projects/${projectId}/plan`, { template: c.key, package: p, kickoff, leadId });
}

/** The stage plans to choose from, as cards (the starter cards' look); `none` adds "No stage plan" first. */
function PlanCards({ choices, value, onChange, none }: { choices: Choice[]; value: string; onChange: (key: string) => void; none?: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? choices : choices.filter((c, i) => i < 4 || c.key === value);
  return <div className={sc.starters}>
    <div role="radiogroup" aria-label="Stage plan" className={css.cards}>
      {none ? <button type="button" role="radio" aria-checked={value === ""} className={sc.starter} onClick={() => onChange("")}>
        <span className={sc.starterHead}><b>No stage plan</b></span><span className={sc.starterSub}>Just tasks. You can add a plan later from the project.</span></button> : null}
      {shown.map((c) => <button key={c.key} type="button" role="radio" aria-checked={value === c.key} className={sc.starter} onClick={() => onChange(c.key)}>
        <span className={sc.starterHead}><LayoutTemplate size={14} aria-hidden="true" /><b>{c.name}</b></span>
        <span className={sc.starterSub}>{c.note}</span>
        <span className={sc.starterStages}>{c.stages.map((x, i) => <span key={`${i}-${x}`}>{i ? <i aria-hidden="true">→</i> : null}{x}</span>)}</span>
      </button>)}
    </div>
    {!all && shown.length < choices.length ? <button type="button" className={`${styles.btn} ${css.more}`} onClick={() => setAll(true)}>Show all {choices.length} plans</button> : null}
  </div>;
}

function PackagePick({ choice, value, onChange }: { choice: Choice | null; value: string; onChange: (v: string) => void }) {
  if (!choice || choice.packages.length < 2) return null;
  return <label className={styles.field}>What was sold<SelectField value={value || choice.packages[0].key} onChange={(e) => onChange(e.currentTarget.value)}>
    {choice.packages.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</SelectField></label>;
}

/** The one line that says where client projects come from. */
export function ClientProjectsLine({ className }: { className?: string }) {
  return <span className={className}><Say t="{Client} projects start by themselves when the {client} pays an invoice in" /> <Link href="/erp">Billing</Link>.</span>;
}

/** Work → Projects' primary action: a team project in a few fields. */
export function NewProjectButton({ primary = true, label = "New project" }: { primary?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className={`${styles.btn}${primary ? ` ${styles.btnPrimary}` : ""}`} onClick={() => setOpen(true)} data-new-project="">
    <Plus size={15} aria-hidden="true" />{label}</button>
    {open ? <NewProjectDialog onClose={() => setOpen(false)} /> : null}</>;
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [o, setO] = useState<Options | null>(null), [plans, setPlans] = useState<Choice[] | null>(null), [error, setError] = useState("");
  const [name, setName] = useState(""), [lead, setLead] = useState(""), [plan, setPlanKey] = useState(""), [pkg, setPkg] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    get<Options>("work/options").then((x) => { setO(x); setLead((l) => l || x.me); }).catch((e) => setError(msg(e)));
    loadChoices().then((x) => setPlans(x.choices)).catch(() => setPlans([]));
  }, []);
  const choice = plans?.find((c) => c.key === plan) ?? null;
  const staff = (o?.people ?? []).filter((p) => !p.connectionId);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (busy || name.trim().length < 2) return;
    const f = new FormData(e.currentTarget); const kickoff = String(f.get("kickoff") ?? "") || o?.today || "";
    setBusy(true); setError("");
    let id: string;
    try {
      id = (await post<{ id: string }>("work/projects", { type: "internal", name: name.trim(), ownerId: lead || null })).id;
    } catch (err) { setError(msg(err)); setBusy(false); return; }
    forgetWorkOptions();
    let planned: string | null = null, planError: string | null = null;
    if (choice) { try { const r = await setPlan(id, choice, kickoff, pkg || null, lead || null); planned = `${choice.name}: ${r.tasks} ${r.tasks === 1 ? "step" : "steps"} laid out`; } catch (err) { planError = msg(err); } }
    notify({ id: "project-new", tone: planError ? "info" : "success", title: `${name.trim()} created`, timeout: 5000,
      message: planError ? `The stage plan was not set: ${planError} Set it from the project.` : planned ?? "Add its first tasks on the project." });
    onClose(); router.push(`/tasks/projects/${id}`); router.refresh();
  }
  return <Modal title="New project" sub="A project for your team's own work. Give it a name and a lead; a stage plan is optional." onClose={onClose}
    foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={onClose}>Cancel</button>
      <button form="new-project" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !o || name.trim().length < 2}>{busy ? "Creating…" : "Create project"}</button></div>}>
    <form id="new-project" onSubmit={submit} className={sc.form}>
      {o && !o.canCreateProject ? <p role="alert" className={sc.problem}>Your role does not start projects. Ask your team head or leadership.</p> : null}
      <label className={styles.field}>Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required minLength={2} autoFocus placeholder="For example: Office move, Website refresh" /></label>
      <label className={styles.field}>Lead<SelectField name="leadId" value={lead} onChange={(e) => setLead(e.currentTarget.value)} disabled={!o} searchable>
        {o ? staff.map((p) => <option key={p.id} value={p.id}>{p.id === o.me ? `${p.name} (you)` : p.name}</option>) : [<option key="" value="">Loading people…</option>]}</SelectField></label>
      <fieldset className={css.group}><legend>Stage plan <small>optional</small></legend>
        <p className={sc.hint}>A plan splits the project into stages, each with an owner, and lays out its steps with due days.</p>
        {plans === null ? <p className={sc.hint}>Loading plans…</p> : <PlanCards choices={plans} value={plan} onChange={(k) => { setPlanKey(k); setPkg(""); }} none />}
      </fieldset>
      {choice ? <div className={css.two}><label className={styles.field}>Kick-off day<DateField name="kickoff" required defaultValue={o?.today ?? null} /></label><PackagePick choice={choice} value={pkg} onChange={setPkg} /></div> : null}
      {error ? <p role="alert" className={sc.problem}>{error}</p> : null}
      <p className={sc.hint}><ClientProjectsLine /></p>
    </form>
  </Modal>;
}

/** "No plan yet" on a project's row, made actionable: choose one of the company's plans, or add a ready-made one. */
export function StagePlanPick({ projectId, title, today, leadId = null }: { projectId: string; title: string; today: string; leadId?: string | null }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" className={css.pick} onClick={() => setOpen(true)} aria-label={`Choose a stage plan for ${title}`}>
    <CalendarRange size={13} aria-hidden="true" />Choose a stage plan</button>
    {open ? <StagePlanDialog projectId={projectId} title={title} today={today} leadId={leadId} onClose={() => setOpen(false)} /> : null}</>;
}

function StagePlanDialog({ projectId, title, today, leadId, onClose }: { projectId: string; title: string; today: string; leadId: string | null; onClose: () => void }) {
  const router = useRouter();
  const [plans, setPlans] = useState<Choice[] | null>(null), [plan, setPlanKey] = useState(""), [pkg, setPkg] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { loadChoices(projectId).then((x) => { setPlans(x.choices); setPlanKey(x.choices[0]?.key ?? ""); }).catch((e) => { setPlans([]); setError(msg(e)); }); }, [projectId]);
  const choice = plans?.find((c) => c.key === plan) ?? null;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!choice || busy) return;
    const kickoff = String(new FormData(e.currentTarget).get("kickoff") ?? "") || today;
    setBusy(true); setError("");
    try {
      const r = await setPlan(projectId, choice, kickoff, pkg || null, leadId);
      notify({ id: "plan-pick", tone: "success", title: `${title} now runs in stages`, message: `${choice.name}: ${r.tasks} ${r.tasks === 1 ? "step" : "steps"} laid out from ${kickoff}.`, timeout: 4500 });
      onClose(); router.refresh();
    } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  }
  return <Modal title="Choose a stage plan" sub={`For ${title}. Pulse lays out the stages and their steps from the kick-off day; you can rename or move anything later.`} onClose={onClose}
    foot={<div className={styles.modalFoot}><button type="button" className={styles.btn} onClick={onClose}>Cancel</button>
      <button form="stage-plan" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !choice}>{busy ? "Setting it up…" : "Use this plan"}</button></div>}>
    <form id="stage-plan" onSubmit={submit} className={sc.form}>
      {plans === null ? <p className={sc.hint}>Loading plans…</p> : plans.length ? <PlanCards choices={plans} value={plan} onChange={(k) => { setPlanKey(k); setPkg(""); }} />
        : <p className={sc.hint}>Your company has no stage plans yet, and only admins and leadership add one. Ask them to add a plan.</p>}
      {choice ? <div className={css.two}><label className={styles.field}>Kick-off day<DateField name="kickoff" required defaultValue={today} /></label><PackagePick choice={choice} value={pkg} onChange={setPkg} /></div> : null}
      {error ? <p role="alert" className={sc.problem}>{error}</p> : null}
    </form>
  </Modal>;
}
