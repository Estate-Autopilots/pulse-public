"use client";
// SOP-WORKFLOW part 2: design a workflow. The steps on the left with who does each (a role, a person, by domain,
// whoever starts it, the project's owner, the pool), its kind of work, times, branches and their conditions; the live
// flow on the right with Pip's warnings drawn on the steps, and Pip's advice under it: who could do the chosen step and
// the effect of putting someone there, how long it usually takes, the management steps the workflow lacks, and earlier
// workflows or SOPs it repeats. Leadership saves, publishes, pauses; a run starts from here or from a project.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Copy, Lightbulb, Pause, Play, Plus, Rocket, Sparkles, Trash2, TriangleAlert, UserPlus, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { PersonPicker, useWorkOptions } from "../create";
import { post } from "../records";
import { Avatar, styles } from "../ui";
import { Links, TagInput, TimeField } from "./editor";
import { FlowCanvas } from "./flow";
import { StartRun } from "./run-parts";
import { useLaneSlots } from "./view";
import { ASSIGN_LABEL, KIND_LABEL, emptyStep, type Advice, type AssignBy, type Condition, type Holder, type StepKind, type Trigger, type WfDef, type WfStep, type WorkflowDetail } from "./types";
import css from "./sops.module.css";

const msg = (e: unknown) => e instanceof Error ? e.message : "Could not save";
const OPS: [Condition["op"], string][] = [["gt", "is more than"], ["gte", "is at least"], ["lt", "is less than"], ["lte", "is at most"], ["eq", "is"], ["ne", "is not"], ["contains", "contains"], ["filled", "is filled in"], ["empty", "is empty"]];
const wfStep = (id: string, over: Partial<WfStep> = {}): WfStep => ({ ...emptyStep(id), assign: { by: "starter" }, category: null, formId: null, join: "any", waitHours: null, next: null, ...over } as WfStep);
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function WorkflowBuilder({ data, roles, forms = [] }: { data: WorkflowDetail; roles: string[]; forms?: { id: string; name: string; fields: { key: string; label: string; type: string }[] }[] }) {
  const router = useRouter(); const w = data.workflow;
  const { data: options } = useWorkOptions();
  const [name, setName] = useState(w.name), [purpose, setPurpose] = useState(w.purpose ?? ""), [trigger, setTrigger] = useState<Trigger>(w.trigger);
  const [def, setDef] = useState<WfDef>(w.definition), [sel, setSel] = useState<string | null>(w.definition.steps[0]?.id ?? null);
  const [advice, setAdvice] = useState<Advice | null>(null), [tryPerson, setTryPerson] = useState<{ step: string; person: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [dirty, setDirty] = useState(false), [starting, setStarting] = useState(false);
  const slotOf = useLaneSlots(def as never);
  const people = useMemo(() => Object.fromEntries([...(options?.people ?? []).map((p) => [p.id, { id: p.id, name: p.name, photoAt: p.photoAt ?? null, pod: p.pod ?? null }]),
    ...data.persons.map((p) => [p.id, p])]) as Record<string, Holder>, [options, data.persons]);
  const cats = useMemo(() => Object.fromEntries(data.categories.map((c) => [c.key, c.label])), [data.categories]);
  const step = def.steps.find((s) => s.id === sel) ?? null; const index = step ? def.steps.indexOf(step) : -1;
  const allRoles = useMemo(() => [...new Set([...def.steps.map((s) => s.role).filter((r): r is string => !!r), ...roles])], [def.steps, roles]);
  // Pip reads the design again a moment after it changes (and when a person is tried on a step).
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current; const t = window.setTimeout(() => {
      fetch("/api/v0/workflows/intel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ definition: def, workflowId: w.id, sopId: w.sopId, stepId: tryPerson?.step, personId: tryPerson?.person }) })
        .then((r) => r.ok ? r.json() : null).then((a) => { if (a && n === seq.current) setAdvice(a); }).catch(() => null);
    }, 650);
    return () => window.clearTimeout(t);
  }, [def, tryPerson, w.id, w.sopId]);
  const stepAdvice = advice?.steps.find((a) => a.stepId === sel) ?? null;
  // On the flow, a warning in a few words ("Only Meera holds the role"); the whole sentence is in Pip's box.
  const issues = useMemo(() => Object.fromEntries((advice?.steps ?? []).map((a) => [a.stepId, a.flags.find((f) => f.level === "warn")?.text.split(":")[0].replace(/“[^”]*”/, "the role")]).filter(([, t]) => t)) as Record<string, string>, [advice]);

  const change = (steps: WfStep[]) => { setDef((d) => ({ ...d, steps })); setDirty(true); };
  const patch = (p: Partial<WfStep>) => step && change(def.steps.map((s) => s.id === step.id ? { ...s, ...p } : s));
  const newId = () => { let n = def.steps.length + 1; while (def.steps.some((s) => s.id === `s${n}`)) n++; return `s${n}`; };
  const add = (after = index, over: Partial<WfStep> = {}) => { const id = newId(); const steps = [...def.steps]; steps.splice(after + 1, 0, wfStep(id, { role: step?.role ?? null, phase: step?.phase ?? null, assign: step ? { ...step.assign } : { by: "starter" }, ...over })); change(steps); setSel(id); };
  const move = (k: number, by: number) => { const steps = [...def.steps]; const [x] = steps.splice(k, 1); steps.splice(k + by, 0, x); change(steps); };
  const remove = (id: string) => { const k = def.steps.findIndex((s) => s.id === id); change(def.steps.filter((s) => s.id !== id).map((s) => s.next ? { ...s, next: s.next.filter((n) => n.to !== id) } : s)); setSel(def.steps[k + 1]?.id ?? def.steps[k - 1]?.id ?? null); };
  const setAssign = (a: WfStep["assign"]) => patch({ assign: a, role: a.by === "role" ? a.role ?? step?.role ?? null : step?.role ?? null, personId: a.by === "person" ? a.personId ?? null : null });
  const incoming = step ? def.steps.filter((s, i) => (s.next ? s.next.some((n) => n.to === step.id) : def.steps[i + 1]?.id === step.id && s.kind !== "end")).length : 0;
  const fields = useMemo(() => [...new Set([...forms.flatMap((f) => def.steps.filter((s) => s.formId === f.id).flatMap((s) => f.fields.filter((x) => x.type !== "photo" && x.type !== "signature").map((x) => `${s.id}.${x.key}`))),
    ...(trigger.kind === "form" ? forms.find((f) => f.id === trigger.formId)?.fields.filter((x) => x.type !== "photo" && x.type !== "signature").map((x) => `form.${x.key}`) ?? [] : []),
    ...def.steps.flatMap((s) => (s.next ?? []).map((n) => n.when?.field).filter((x): x is string => !!x))])], [def.steps, forms, trigger]);

  async function save(publish = false) {
    setBusy(true); setError("");
    try {
      await post(`workflows/${w.id}`, { name, purpose: purpose || null, definition: def, trigger, sopId: w.sopId, clientId: w.clientId });
      if (publish) await post(`workflows/${w.id}/publish`);
      setDirty(false); notify({ id: "wf", tone: "success", title: publish ? "Published: new runs follow it" : w.status === "live" ? "Saved: new runs follow the change" : "Saved", timeout: 3000 }); router.refresh();
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  async function status(next: "paused" | "live" | "archived") {
    setBusy(true); try { await post(`workflows/${w.id}/status`, { status: next }); router.refresh(); } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }

  return <div className={css.area}>
    <div className={css.editor}>
      <div className={css.form}>
        <div className={css.box}>
          <label className={css.field}><span>Name</span><input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} maxLength={200} /></label>
          <label className={css.field}><span>What it is for</span><textarea value={purpose} rows={2} onChange={(e) => { setPurpose(e.target.value); setDirty(true); }} maxLength={2000} /></label>
          <TriggerField trigger={trigger} onChange={(t) => { setTrigger(t); setDirty(true); }} categories={data.categories} forms={forms} />
          {w.sopTitle ? <p className={css.hint}>From the SOP <Link className={css.linkBtn} href={`/sops/${w.sopId}`}>{w.sopTitle}</Link></p> : null}
        </div>
        <div className={css.box}>
          <div className={css.panelHead}><p className={css.sub}>Steps</p><button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => add(def.steps.length - 1)}><Plus size={13} aria-hidden="true" />Add a step</button></div>
          <ol className={css.stepList}>{def.steps.map((s, k) => <li key={s.id} className={css.stepItem} data-slot={slotOf(s as never)} aria-current={sel === s.id ? "true" : undefined}>
            <span className={css.stepNo} style={{ width: 24, height: 24, fontSize: 11 }}>{k + 1}</span>
            <button type="button" onClick={() => setSel(s.id)}><b>{s.title || "Untitled step"}</b><small>{[who(s, people), s.kind !== "task" ? KIND_LABEL[s.kind] : null, issues[s.id] ? "⚠" : null].filter(Boolean).join(" · ")}</small></button>
            <span className={css.moves}><button type="button" aria-label={`Move step ${k + 1} up`} disabled={k === 0} onClick={() => move(k, -1)}><ArrowUp size={13} /></button>
              <button type="button" aria-label={`Move step ${k + 1} down`} disabled={k === def.steps.length - 1} onClick={() => move(k, 1)}><ArrowDown size={13} /></button></span>
          </li>)}</ol>
        </div>
        {step ? <div className={css.box} role="group" aria-label={`Step ${index + 1}`}>
          <div className={css.panelHead}><p className={css.sub}>Step {index + 1}</p><span style={{ display: "flex", gap: 2 }}>
            <button type="button" className={css.iconBtn} aria-label="Add a step after this one" onClick={() => add()}><Plus size={15} /></button>
            <button type="button" className={css.iconBtn} aria-label="Copy this step" onClick={() => { const id = newId(); const steps = [...def.steps]; steps.splice(index + 1, 0, { ...step, id, next: null }); change(steps); setSel(id); }}><Copy size={14} /></button>
            <button type="button" className={css.iconBtn} aria-label="Remove this step" onClick={() => remove(step.id)}><Trash2 size={14} /></button></span></div>
          <label className={css.field}><span>What happens</span><input value={step.title} onChange={(e) => patch({ title: e.target.value })} maxLength={200} /></label>
          <div className={css.field}><span>Kind</span><span className={css.toggle} role="group" aria-label="Kind of step">{(["task", "decision", "approval", "wait", "end"] as StepKind[]).map((k) =>
            <button key={k} type="button" aria-pressed={step.kind === k} onClick={() => patch({ kind: k, waitHours: k === "wait" ? step.waitHours ?? 24 : null,
              next: (k === "decision" || k === "approval") && !step.next ? [...(def.steps[index + 1] ? [{ to: def.steps[index + 1].id, label: k === "approval" ? "Approved" : "Yes" }] : []), ...(k === "approval" && index > 0 ? [{ to: def.steps[index - 1].id, label: "Send back" }] : [])] : step.next })}>{KIND_LABEL[k]}</button>)}</span></div>
          {step.kind === "wait" ? <TimeField key={`w${step.id}`} label="Wait for" hours={step.waitHours} onChange={(h) => patch({ waitHours: h })} hint="The run goes on by itself after this long" />
            : step.kind === "end" ? <p className={css.hint}>The run ends here (other branches still running carry on).</p> : <>
            <div className={css.field}><span>Who does it</span>
              <select value={step.assign.by} aria-label="Who does it" onChange={(e) => { const by = e.target.value as AssignBy; setAssign(by === "role" ? { by, role: step.role ?? "" } : by === "person" ? { by, personId: step.personId } : by === "domain" ? { by, category: step.category } : by === "pool" ? { by, scope: "company" } : { by }); }}>
                {(Object.keys(ASSIGN_LABEL) as AssignBy[]).map((k) => <option key={k} value={k}>{ASSIGN_LABEL[k]}</option>)}</select></div>
            {step.assign.by === "role" ? <label className={css.field}><span>Role</span><input value={step.assign.role ?? ""} list="wf-roles" onChange={(e) => setAssign({ by: "role", role: e.target.value })} placeholder="PGS" maxLength={80} /></label> : null}
            {step.assign.by === "person" && options ? <div className={css.field}><span>Person</span><PersonPicker people={options.people} value={options.people.find((p) => p.id === step.assign.personId) ?? null} onChange={(p) => { setAssign({ by: "person", personId: p?.id ?? null }); if (p) setTryPerson({ step: step.id, person: p.id }); }} me={options.me} label="Person" /></div> : null}
            {step.assign.by === "domain" ? <label className={css.field}><span>Whose domains cover</span><select value={step.assign.category ?? ""} onChange={(e) => setAssign({ by: "domain", category: e.target.value || null })}><option value="">Choose a kind of work</option>{data.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label> : null}
            {step.assign.by === "pool" ? <label className={css.field}><span>Which pool</span><select value={step.assign.scope ?? "company"} onChange={(e) => setAssign({ by: "pool", scope: e.target.value as "company" | "pod" })}><option value="company">{"The company's"}</option><option value="pod">{"The project's pod"}</option></select></label> : null}
            <PipStep advice={stepAdvice} step={step} onUse={(id) => { setAssign({ by: "person", personId: id }); setTryPerson({ step: step.id, person: id }); }} onSla={(h) => patch({ slaHours: h })} />
            <div className={css.row2}>
              <label className={css.field}><span>Kind of work</span><select value={step.category ?? ""} onChange={(e) => patch({ category: e.target.value || null })}><option value="">{stepAdvice?.categoryLabel ? `Guess: ${stepAdvice.categoryLabel}` : "Guess from the name"}</option>{data.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
              <label className={css.field}><span>Form to fill</span><select value={step.formId ?? ""} onChange={(e) => patch({ formId: e.target.value || null })} disabled={!forms.length}><option value="">{forms.length ? "None" : "No forms yet"}</option>{forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
            </div>
            <label className={css.field}><span>How (one point per line)</span><textarea rows={3} value={(step.detail ?? "").replace(/^• /gm, "")} onChange={(e) => patch({ detail: e.target.value ? e.target.value.split("\n").map((l) => l.trim() ? `• ${l.replace(/^•\s*/, "")}` : l).join("\n") : null })} /></label>
            <TagInput label="Needs (inputs)" value={step.inputs} onChange={(v) => patch({ inputs: v })} placeholder="Enter to add" />
            <TagInput label="Hands over (outputs)" value={step.outputs} onChange={(v) => patch({ outputs: v })} placeholder="Enter to add" />
            <div className={css.row2} key={step.id}>
              <TimeField label="Usual work time" hours={step.minutes != null ? step.minutes / 60 : null} onChange={(h) => patch({ minutes: h == null ? null : Math.max(1, Math.round(h * 60)) })} hint="How long the work itself takes" />
              <TimeField label="SLA" hours={step.slaHours} onChange={(h) => patch({ slaHours: h })} hint="How long it may take from start to done; late steps are flagged" />
            </div></>}
          {incoming > 1 ? <div className={css.field}><span>Starts when</span><span className={css.toggle} role="group" aria-label="Starts when"><button type="button" aria-pressed={step.join !== "all"} onClick={() => patch({ join: "any" })}>Any step before it is done</button><button type="button" aria-pressed={step.join === "all"} onClick={() => patch({ join: "all" })}>All are done</button></span></div> : null}
          <WfConnections step={step} def={def} fields={fields} onChange={(next) => patch({ next })} />
          <Links step={step as never} onChange={(links) => patch({ links })} />
        </div> : null}
        <div className={css.footer}>
          <span>{error ? <span className={css.error} role="alert">{error}</span> : dirty ? "Unsaved changes" : w.status === "live" ? `Live · version ${w.version}` : w.status === "paused" ? "Paused" : "Draft"}</span>
          {w.status === "live" ? <button type="button" className={styles.btn} disabled={busy} onClick={() => void status("paused")}><Pause size={14} aria-hidden="true" />Pause</button> : null}
          {w.status === "paused" ? <button type="button" className={styles.btn} disabled={busy} onClick={() => void status("live")}><Play size={14} aria-hidden="true" />Resume</button> : null}
          <button type="button" className={styles.btn} disabled={busy || !dirty} onClick={() => void save(false)}>Save</button>
          {w.status === "draft" ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !def.steps.length} onClick={() => void save(true)}><Rocket size={14} aria-hidden="true" />Publish</button>
            : data.canStart ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || dirty} onClick={() => setStarting(true)}><Play size={14} aria-hidden="true" />Start a run</button> : null}
        </div>
      </div>
      <div className={css.editorFlow}>
        <FlowCanvas steps={def.steps} people={data.people} persons={people} selected={sel} onSelect={(id) => id && setSel(id)} issues={issues} label="The workflow" />
        <PipPanel advice={advice} onAdd={(sg) => { const k = sg.after ? def.steps.findIndex((s) => s.id === sg.after) : -1; if (sg.key === "sla") return; add(k, { ...sg.step, assign: (sg.step.assign as WfStep["assign"]) ?? { by: "project_owner" } }); }} />
      </div>
    </div>
    <datalist id="wf-roles">{allRoles.map((r) => <option key={r} value={r} />)}</datalist>
    {starting ? <StartRun workflowId={w.id} name={w.name} fields={fields} onClose={() => setStarting(false)} /> : null}
  </div>;
}

const who = (s: WfStep, people: Record<string, Holder>) => s.kind === "wait" ? `Wait ${s.waitHours ?? 24} h` : s.kind === "end" ? "End" : s.assign.by === "role" ? s.assign.role || "A role" : s.assign.by === "person" ? people[s.assign.personId ?? ""]?.name ?? "A person"
  : ASSIGN_LABEL[s.assign.by];

/** Pip on one step: who could do it, the effect of the person chosen, how long it usually takes, what to watch. */
function PipStep({ advice, step, onUse, onSla }: { advice: StepAdviceType | null; step: WfStep; onUse: (id: string) => void; onSla: (h: number) => void }) {
  if (!advice) return null;
  const est = advice.estimate;
  return <div className={css.pip} aria-label="Pip on this step" role="note">
    <p className={css.pipHead}><Sparkles size={13} aria-hidden="true" />Pip</p>
    {advice.candidates.length ? <ul className={css.pipPeople}>{advice.candidates.map((c) => <li key={c.id}>
      <Avatar name={c.name} id={c.id} photoAt={c.photoAt} size={24} /><span><b>{c.name}</b><small>{c.reasons.join(" · ")}</small></span>
      {step.assign.by === "person" && step.assign.personId === c.id ? <em>Chosen</em> : <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => onUse(c.id)}><UserPlus size={12} aria-hidden="true" />Use</button>}</li>)}</ul> : null}
    {advice.effect ? <div className={css.effect} data-warn={advice.effect.warn ? "" : undefined}><b>If {advice.effect.name.split(" ")[0]} does it</b><ul>{advice.effect.lines.map((l) => <li key={l}>{l}</li>)}</ul></div> : null}
    {est ? <p className={css.hint}>Usually {est.days != null ? `${est.days < 1 ? `${Math.max(1, Math.round(est.days * 24))} h` : `${Math.round(est.days * 10) / 10} d`} from start to done` : ""}{est.minutes ? `${est.days != null ? ", " : ""}${Math.round(est.minutes / 6) / 10} h of work` : ""} ({est.basis}).
      {est.days != null && !step.slaHours ? <> <button type="button" className={css.linkBtn} onClick={() => onSla(Math.max(1, Math.ceil(est.days! * 24 * 1.25)))}>Use as the SLA</button></> : null}</p> : null}
    {advice.flags.map((f) => <p key={f.text} className={css.flag} data-level={f.level}>{f.level === "warn" ? <TriangleAlert size={12} aria-hidden="true" /> : <Lightbulb size={12} aria-hidden="true" />}{f.text}</p>)}
  </div>;
}
type StepAdviceType = Advice["steps"][number];

/** Pip on the whole workflow: what it adds up to, management steps it lacks, earlier workflows it repeats. */
function PipPanel({ advice, onAdd }: { advice: Advice | null; onAdd: (s: Advice["suggestions"][number]) => void }) {
  if (!advice) return <div className={css.pip}><p className={css.pipHead}><Sparkles size={13} aria-hidden="true" />Pip is reading the workflow…</p></div>;
  return <div className={css.pip} role="region" aria-label="Pip on this workflow">
    <p className={css.pipHead}><Sparkles size={13} aria-hidden="true" />Pip on this workflow</p>
    {advice.summary.map((l) => <p key={l} className={css.hint}>{l}</p>)}
    {advice.suggestions.length ? <ul className={css.pipList}>{advice.suggestions.map((s) => <li key={s.key}><span><b>{s.text}</b><small>{s.why}</small></span>
      {s.key !== "sla" ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => onAdd(s)}><Plus size={12} aria-hidden="true" />Add</button> : null}</li>)}</ul> : null}
    {advice.reuse.map((r) => <p key={r.id} className={css.flag} data-level="info"><Copy size={12} aria-hidden="true" /><span>{r.shared} of these steps are already in the {r.kind === "sop" ? "SOP" : "workflow"} <Link className={css.linkBtn} href={r.kind === "sop" ? `/sops/${r.id}` : `/sops/workflows/${r.id}`}>{r.name}</Link>: reuse it rather than keep two.</span></p>)}
    {!advice.summary.length && !advice.suggestions.length && !advice.reuse.length ? <p className={css.hint}>Nothing to add: the steps have owners, times and checks.</p> : null}
  </div>;
}

function TriggerField({ trigger, onChange, categories, forms }: { trigger: Trigger; onChange: (t: Trigger) => void; categories: { key: string; label: string }[]; forms: { id: string; name: string }[] }) {
  return <div className={css.field}><span>Runs start</span>
    <select value={trigger.kind} aria-label="Runs start" onChange={(e) => { const k = e.target.value as Trigger["kind"]; onChange(k === "schedule" ? { kind: k, every: "week", weekday: 1, at: "09:00" } : k === "milestone" ? { kind: k, category: categories[0]?.key } : k === "form" ? { kind: k, formId: forms[0]?.id ?? null } : { kind: k }); }}>
      <option value="manual">By hand (on a project or a client)</option><option value="package">When a new client package is made</option><option value="milestone">At a project milestone</option><option value="schedule">On a schedule</option>
      <option value="form" disabled={!forms.length}>When a form is sent</option></select>
    {trigger.kind === "package" ? <label className={css.check}><input type="checkbox" checked={!!trigger.imported} onChange={(e) => onChange({ ...trigger, imported: e.target.checked })} />Also packages imported from Drive</label> : null}
    {trigger.kind === "milestone" ? <span className={css.row2}>
      <select aria-label="Milestone" value={trigger.category ? `c:${trigger.category}` : `s:${trigger.projectStatus ?? "done"}`} onChange={(e) => onChange(e.target.value.startsWith("c:") ? { kind: "milestone", category: e.target.value.slice(2) } : { kind: "milestone", projectStatus: e.target.value.slice(2) })}>
        <optgroup label="When work of this kind is finished">{categories.map((c) => <option key={c.key} value={`c:${c.key}`}>{c.label}</option>)}</optgroup>
        <optgroup label="When the project becomes">{["active", "paused", "done"].map((s) => <option key={s} value={`s:${s}`}>{s}</option>)}</optgroup></select></span> : null}
    {trigger.kind === "schedule" ? <span className={css.row2}>
      <select aria-label="Every" value={trigger.every ?? "week"} onChange={(e) => onChange({ ...trigger, every: e.target.value as Trigger["every"] })}><option value="day">Every day</option><option value="week">Every week</option><option value="month">Every month</option></select>
      {trigger.every === "week" ? <select aria-label="Day of the week" value={trigger.weekday ?? 1} onChange={(e) => onChange({ ...trigger, weekday: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select>
        : trigger.every === "month" ? <input type="number" min={1} max={28} aria-label="Day of the month" value={trigger.day ?? 1} onChange={(e) => onChange({ ...trigger, day: Number(e.target.value) })} /> : null}
      <input type="time" aria-label="At" value={trigger.at ?? "09:00"} onChange={(e) => onChange({ ...trigger, at: e.target.value })} /></span> : null}
    {trigger.kind === "form" ? <select aria-label="Form" value={trigger.formId ?? ""} onChange={(e) => onChange({ kind: "form", formId: e.target.value })}>{forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select> : null}
  </div>;
}

/** Where a step goes: on to the next one, or branches with a label and (for decisions) a condition on the run's values. */
function WfConnections({ step, def, fields, onChange }: { step: WfStep; def: WfDef; fields: string[]; onChange: (next: WfStep["next"]) => void }) {
  const others = def.steps.filter((s) => s.id !== step.id); const k = def.steps.indexOf(step); const custom = step.next !== null;
  const set = (i: number, p: Partial<NonNullable<WfStep["next"]>[number]>) => onChange(step.next!.map((x, j) => j === i ? { ...x, ...p } : x));
  return <div className={css.field}><span>Then</span>
    <span className={css.toggle} role="group" aria-label="Where it goes"><button type="button" aria-pressed={!custom} onClick={() => onChange(null)}>{def.steps[k + 1] ? "The next step" : "It ends"}</button>
      <button type="button" aria-pressed={custom} onClick={() => onChange(step.next ?? (def.steps[k + 1] ? [{ to: def.steps[k + 1].id, label: null }] : []))}>Choose</button></span>
    {custom ? <div className={css.nextList}>{(step.next ?? []).map((n, i) => <div key={i} className={css.branch}>
      <select value={n.to} aria-label={`Branch ${i + 1} goes to`} onChange={(e) => set(i, { to: e.target.value })}>{others.map((s) => <option key={s.id} value={s.id}>{def.steps.indexOf(s) + 1}. {s.title || "Untitled"}</option>)}</select>
      <input value={n.label ?? ""} placeholder={step.kind === "approval" ? "Approved / Send back" : "Label"} aria-label={`Branch ${i + 1} label`} maxLength={60} onChange={(e) => set(i, { label: e.target.value || null })} />
      <button type="button" className={css.iconBtn} aria-label={`Remove branch ${i + 1}`} onClick={() => onChange(step.next!.filter((_, j) => j !== i))}><X size={14} /></button>
      {step.kind === "decision" ? <span className={css.cond}>{n.when ? <>
        <input list="wf-fields" value={n.when.field} aria-label={`Branch ${i + 1}: value`} placeholder="install.panels" onChange={(e) => set(i, { when: { ...n.when!, field: e.target.value } })} />
        <select value={n.when.op} aria-label={`Branch ${i + 1}: test`} onChange={(e) => set(i, { when: { ...n.when!, op: e.target.value as Condition["op"] } })}>{OPS.map(([o, l]) => <option key={o} value={o}>{l}</option>)}</select>
        {!["filled", "empty"].includes(n.when.op) ? <input value={String(n.when.value ?? "")} aria-label={`Branch ${i + 1}: compared with`} placeholder="10" onChange={(e) => set(i, { when: { ...n.when!, value: e.target.value } })} /> : null}
        <button type="button" className={css.linkBtn} onClick={() => set(i, { when: null })}>Otherwise</button></>
        : <button type="button" className={css.linkBtn} onClick={() => set(i, { when: { field: fields[0] ?? "", op: "gt", value: "" } })}>{i ? "Otherwise · add a condition" : "Add a condition"}</button>}</span> : null}
    </div>)}
      {others.length ? <button type="button" className={css.linkBtn} onClick={() => onChange([...(step.next ?? []), { to: others[0].id, label: null }])}><Plus size={13} aria-hidden="true" />Add a branch</button> : null}
      {step.kind === "decision" ? <p className={css.hint}>A decision with conditions goes the first way whose condition holds (a form’s answers are named step.field); without conditions, the person doing it chooses.</p> : null}
    </div> : null}
    <datalist id="wf-fields">{fields.map((f) => <option key={f} value={f} />)}</datalist>
  </div>;
}
