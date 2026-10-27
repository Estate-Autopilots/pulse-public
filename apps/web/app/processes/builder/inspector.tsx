"use client";
// FLOW-B: the inspector beside the canvas. With nothing chosen it shows the process: its name, what it is for, what to
// fix before it goes live, its stages and its roles. With a step chosen: who does it, when it is due (per package when
// the process has packages), which packages it runs for, the module's settings, its checklist and quality test, the part
// of the write-up that explains it, where each Need comes from, who is told when each Make is ready, and Pip's hints.
// With a wire chosen: what it carries, whether it fits, who it tells.
import { useState } from "react";
import { ArrowRight, Bell, BookmarkPlus, CircleAlert, ListTree, Plus, Sparkles, Trash2, X } from "lucide-react";
import { article, checkWire, kindOf, moduleOf } from "../../lib/flow-canvas.mjs";
import type { Assign, BlockKind, DueRule, FlowDef, FlowStep, ModuleManifest, Primitive, Problem, SettingField, VariantField, WriteupSection } from "../flow-types";
import { ENGINE_BADGE, KIND_SLOT, KIND_WORD, ModuleIcon } from "./kinds";
import type { Intel } from "./builder";
import type { Sel } from "./canvas";
import css from "./builder.module.css";
import { SelectField } from "../../kit/select-field";

export type Hint = { key: string; text: string; add?: { module: string; label: string; before: string; port: string } };
type Edit = (fn: (d: FlowDef) => FlowDef, key?: string) => void;

export function Inspector({ onClose, people, def, byKey, modules, sel, onSelect, edit, writeup, problems, hints, name, summary, onName, onSummary, readOnly, onDelete, onAddBefore, onConvert, primitives = [], onSaveBlock }: {
  onClose: () => void; people: Intel["people"] | null; def: FlowDef; byKey: Record<string, ModuleManifest>; modules: ModuleManifest[]; sel: Sel; onSelect: (s: Sel) => void; edit: Edit; writeup: WriteupSection[];
  problems: Problem[]; hints: (step: FlowStep) => Hint[]; name: string; summary: string; onName: (v: string) => void; onSummary: (v: string) => void; readOnly: boolean;
  onDelete: (s: Sel) => void; onAddBefore: (h: NonNullable<Hint["add"]>) => void; onConvert: (wire: number, module: string) => void;
  primitives?: Primitive[]; onSaveBlock?: (s: FlowStep, name: string) => Promise<boolean>;
}) {
  const step = sel?.kind === "step" ? def.steps.find((s) => s.id === sel.id) : undefined;
  const wire = sel?.kind === "wire" ? def.wires[sel.index] : undefined;
  return <aside className={css.inspector} data-float-avoid="" aria-label={step ? "The chosen step" : wire ? "The chosen wire" : "This process"}>
    {step ? <StepPanel key={step.id} people={people} step={step} def={def} byKey={byKey} edit={edit} writeup={writeup} hints={hints(step)} readOnly={readOnly} onClose={() => onSelect(null)}
      onDelete={() => onDelete(sel)} onAddBefore={onAddBefore} onSelect={onSelect} primitive={step.block ? primitives.find((p) => p.key === step.block) : undefined} onSaveBlock={onSaveBlock} />
      : wire && sel?.kind === "wire" ? <WirePanel index={sel.index} def={def} byKey={byKey} modules={modules} edit={edit} readOnly={readOnly} onClose={() => onSelect(null)} onDelete={() => onDelete(sel)} onConvert={onConvert} onSelect={onSelect} />
        : <ProcessPanel def={def} edit={edit} problems={problems} name={name} summary={summary} onName={onName} onSummary={onSummary} readOnly={readOnly} onSelect={onSelect} onClose={onClose} />}
  </aside>;
}

// ------------------------------------------------------------------------------------------------------- the process
function ProcessPanel({ def, edit, problems, name, summary, onName, onSummary, readOnly, onSelect, onClose }: { def: FlowDef; edit: Edit; problems: Problem[]; name: string; summary: string;
  onName: (v: string) => void; onSummary: (v: string) => void; readOnly: boolean; onSelect: (s: Sel) => void; onClose: () => void }) {
  const errors = problems.filter((p) => p.level === "error"), warnings = problems.filter((p) => p.level === "warning");
  const variant = def.fields.find((f) => f.variant && f.type === "choice");
  return <div className={css.panel}>
    <div className={css.panelHead}><span className={css.cardIcon} style={{ "--k": "var(--theme-action)" } as React.CSSProperties}><ListTree size={16} aria-hidden="true" /></span>
      <span><b>The process</b><small>Its name, what it is for, its stages, and what to fix before it goes live</small></span>
      <button type="button" className={css.close} onClick={onClose} aria-label="Close"><X size={15} /></button></div>
    <label className={css.field}><span>Name</span><input value={name} onChange={(e) => onName(e.target.value)} maxLength={200} disabled={readOnly} /></label>
    <label className={css.field}><span>What it is for</span><textarea rows={2} value={summary} onChange={(e) => onSummary(e.target.value)} maxLength={2000} disabled={readOnly} placeholder="One line people read on the card" /></label>
    <section className={css.group} aria-label="Before it goes live">
      <h4>{errors.length ? "Before it goes live" : warnings.length ? "Worth a look" : "Ready to go live"}</h4>
      {problems.length ? <ul className={css.problems}>{problems.slice(0, 12).map((p, i) => <li key={i} data-level={p.level}>
        <CircleAlert size={14} aria-hidden="true" />
        {p.step ? <button type="button" onClick={() => onSelect({ kind: "step", id: p.step! })}>{p.text}</button> : p.wire !== undefined ? <button type="button" onClick={() => onSelect({ kind: "wire", index: p.wire! })}>{p.text}</button> : <span>{p.text}</span>}
      </li>)}{problems.length > 12 ? <li className={css.muted}>and {problems.length - 12} more</li> : null}</ul>
        : <p className={css.muted}>Every step has someone, every Need has a source and every wire fits.</p>}
    </section>
    {variant ? <section className={css.group} aria-label={variant.label}><h4>{variant.label}</h4>
      <p className={css.muted}>Chosen when a run starts. Steps can run for some {variant.label.toLowerCase()}s only and be due on different days for each; pick one above the canvas to see its steps.</p>
      <div className={css.chips}>{variant.options?.map((o) => <span key={o.value} className={css.chip}>{o.label}</span>)}</div></section> : null}
    <section className={css.group} aria-label="Stages">
      <h4>Stages</h4>
      <ol className={css.stageList}>{def.stages.map((g, i) => <li key={g.key}>
        <input value={g.label} disabled={readOnly} aria-label={`Stage ${i + 1} name`} onChange={(e) => edit((d) => ({ ...d, stages: d.stages.map((x) => x.key === g.key ? { ...x, label: e.target.value } : x) }), `stage-${g.key}`)} />
        <small>{def.steps.filter((s) => s.stage === g.key).length}</small>
        {!readOnly ? <button type="button" aria-label={`Remove the stage ${g.label}`} title="Remove the stage (its steps stay, without a stage)"
          onClick={() => edit((d) => ({ ...d, stages: d.stages.filter((x) => x.key !== g.key), steps: d.steps.map((s) => s.stage === g.key ? { ...s, stage: null } : s) }))}><X size={13} /></button> : null}
      </li>)}</ol>
      {!readOnly ? <button type="button" className={css.add} onClick={() => edit((d) => { let n = d.stages.length + 1; while (d.stages.some((x) => x.key === `stage${n}`)) n++; return { ...d, stages: [...d.stages, { key: `stage${n}`, label: `Stage ${d.stages.length + 1}` }] }; })}>
        <Plus size={13} aria-hidden="true" />Add a stage</button> : null}
    </section>
    {def.roles.length ? <section className={css.group} aria-label="Roles"><h4>Who works in it</h4><div className={css.chips}>{def.roles.map((r, i) => <span key={r.key} className={css.chip} data-slot={(i % 6) + 1}>{r.label}</span>)}</div></section> : null}
    <p className={css.tip}>Drag a step in from the left. Join a step&apos;s Makes (right) to another&apos;s Needs (left). Delete removes what is chosen; ⌘Z undoes.</p>
  </div>;
}

// ---------------------------------------------------------------------------------------------------------- a step
/** FLOW-D: a block step changes kind (Collect: answers → photos on the spot): its module and the kind's settings; its
 *  wires follow (what came after it now comes after the new kind's first output; uses the new kind lacks are dropped). */
export function withKind(d: FlowDef, step: FlowStep, k: BlockKind, byKey: Record<string, ModuleManifest>): FlowDef {
  const pr = step.block ? byKey[`block:${step.block}`] as unknown as Primitive | undefined : undefined;
  const was = kindOf(step, pr), marks = Object.keys(was?.settings ?? {});
  const settings = { ...Object.fromEntries(Object.entries(step.settings ?? {}).filter(([key]) => !marks.includes(key))), ...(k.settings ?? {}) };
  const next = { ...step, module: k.module, settings }, m = moduleOf(next, byKey);
  return { ...d, steps: d.steps.map((s) => s.id === step.id ? next : s),
    wires: d.wires.filter((w) => w.to.step !== step.id || m.needs.some((n) => n.key === w.to.port))
      .map((w) => w.from.step === step.id && !m.makes.some((p) => p.key === w.from.port) && m.makes[0] ? { ...w, from: { step: step.id, port: m.makes[0].key } } : w)
      .filter((w) => w.from.step !== step.id || m.makes.some((p) => p.key === w.from.port)) };
}

function StepPanel({ people, step, def, byKey, edit, writeup, hints, readOnly, onClose, onDelete, onAddBefore, onSelect, primitive, onSaveBlock }: { people: Intel["people"] | null; step: FlowStep; def: FlowDef; byKey: Record<string, ModuleManifest>; edit: Edit;
  writeup: WriteupSection[]; hints: Hint[]; readOnly: boolean; onClose: () => void; onDelete: () => void; onAddBefore: (h: NonNullable<Hint["add"]>) => void; onSelect: (s: Sel) => void;
  primitive?: Primitive; onSaveBlock?: (s: FlowStep, name: string) => Promise<boolean> }) {
  const m = moduleOf(step, byKey);
  const kind = primitive ? kindOf(step, primitive) : null;
  const set = (patch: Partial<FlowStep>, key?: string) => edit((d) => ({ ...d, steps: d.steps.map((s) => s.id === step.id ? { ...s, ...patch } : s) }), key);
  const variant = def.fields.find((f) => f.variant && f.type === "choice");
  const ins = def.wires.map((w, i) => ({ w, i })).filter((x) => x.w.to.step === step.id), outs = def.wires.map((w, i) => ({ w, i })).filter((x) => x.w.from.step === step.id);
  const title = (id: string) => def.steps.find((s) => s.id === id)?.title || "a step";
  return <div className={css.panel}>
    <div className={css.panelHead}>
      <span className={css.cardIcon} style={{ "--k": `var(--k${KIND_SLOT[m.makes[0]?.kind ?? "any"]})` } as React.CSSProperties}><ModuleIcon name={m.icon} size={16} /></span>
      <span><b>{m.name}</b><small>{m.summary}</small></span>
      <button type="button" className={css.close} onClick={onClose} aria-label="Back to the process"><X size={15} /></button>
    </div>
    {m.engine !== "live" ? <p className={css.engineNote} data-engine={m.engine}>{ENGINE_BADGE[m.engine].label}: {m.status || ENGINE_BADGE[m.engine].title}.</p> : null}
    {primitive ? <label className={css.field}><span>{primitive.question}</span><SelectField value={kind?.key ?? ""} disabled={readOnly} onChange={(e) => { const k = primitive.kinds.find((x) => x.key === e.target.value); if (k) edit((d) => withKind(d, step, k, byKey)); }}>
      {primitive.kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</SelectField>{kind ? <small>{kind.help}</small> : null}</label> : null}
    <label className={css.field}><span>{primitive ? "What is it called?" : "Step"}</span><input value={step.title} onChange={(e) => set({ title: e.target.value }, `title-${step.id}`)} maxLength={200} disabled={readOnly} placeholder={kind?.label ?? m.name} /></label>
    <div className={css.stack}>
      <label className={css.field}><span>Stage</span><SelectField value={step.stage ?? ""} disabled={readOnly} onChange={(e) => set({ stage: e.target.value || null })}>
        <option value="">No stage</option>{def.stages.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}</SelectField></label>
      <Who who={step.who} def={def} readOnly={readOnly} onChange={(who) => set({ who })} />
    </div>
    {step.who.by === "role" && step.who.role && people?.[step.who.role] ? <Holders list={people[step.who.role]} role={roleName(def, step.who.role) ?? step.who.role} /> : null}
    <Due step={step} def={def} variant={variant} readOnly={readOnly} onChange={(due) => set({ due }, `due-${step.id}`)} />
    {variant ? <RunsFor step={step} variant={variant} readOnly={readOnly} onChange={(when) => set({ when })} /> : null}

    <section className={css.group} aria-label="Needs">
      <h4>Needs</h4>
      {m.needs.length ? <ul className={css.portList}>{m.needs.map((p) => {
        const from = ins.filter((x) => x.w.to.port === p.key), typed = (step.inputs ?? []).find((x) => x.port === p.key);
        return <li key={p.key} data-k={KIND_SLOT[p.kind]}><i /><span><b>{p.label}</b><small>{KIND_WORD[p.kind]}{p.required ? " · needed to start" : ""}</small>
          {from.length ? from.map((x) => <button key={x.i} type="button" className={css.link} onClick={() => onSelect({ kind: "wire", index: x.i })}>from {title(x.w.from.step)}</button>)
            : typed ? <small>Typed in or uploaded by {roleName(def, typed.owner.role) ?? "whoever starts the run"}</small>
              : <small className={p.required ? css.warn : undefined}>{p.required ? "Not joined yet: the step waits for it" : "Not joined"}</small>}
          {!from.length && !readOnly ? <label className={css.inline}><input type="checkbox" checked={!!typed} onChange={(e) => set({ inputs: e.target.checked ? [...(step.inputs ?? []), { port: p.key, owner: { by: "starter" } }] : (step.inputs ?? []).filter((x) => x.port !== p.key) })} />Someone types it in or uploads it</label> : null}
          {typed && !readOnly ? <SelectField aria-label="Who brings it" value={typed.owner.by === "role" ? typed.owner.role ?? "" : ""} onChange={(e) => set({ inputs: (step.inputs ?? []).map((x) => x.port === p.key ? { ...x, owner: e.target.value ? { by: "role", role: e.target.value } : { by: "starter" } } : x) })}>
            <option value="">Whoever starts the run</option>{def.roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</SelectField> : null}
        </span></li>;
      })}</ul> : <p className={css.muted}>Nothing: it can start as soon as the run does.</p>}
    </section>
    <section className={css.group} aria-label="Makes">
      <h4>Makes</h4>
      {m.makes.length ? <ul className={css.portList}>{m.makes.map((p) => {
        const to = outs.filter((x) => x.w.from.port === p.key);
        return <li key={p.key} data-k={KIND_SLOT[p.kind]}><i /><span><b>{p.label}</b><small>{KIND_WORD[p.kind]}</small>
          {to.map((x) => <span key={x.i} className={css.wireRow}><button type="button" className={css.link} onClick={() => onSelect({ kind: "wire", index: x.i })}><ArrowRight size={12} aria-hidden="true" />{title(x.w.to.step)}</button>
            <Notify roles={def.roles} value={x.w.notify ?? []} readOnly={readOnly} onChange={(notify) => edit((d) => ({ ...d, wires: d.wires.map((w, j) => j === x.i ? { ...w, notify } : w) }))} /></span>)}
          {!to.length ? <small>Not used by another step yet</small> : null}</span></li>;
      })}</ul> : <p className={css.muted}>Nothing travels on from here.</p>}
    </section>

    {m.settings.length ? <section className={css.group} aria-label="Settings"><h4>Settings</h4>
      {m.settings.map((f) => <Setting key={f.key} f={f} value={step.settings?.[f.key]} def={def} readOnly={readOnly} onChange={(v) => set({ settings: { ...step.settings, [f.key]: v } }, `set-${step.id}-${f.key}`)} />)}</section> : null}
    <label className={css.field}><span>Checklist <em>one line each</em></span><textarea rows={4} disabled={readOnly} value={(step.checklist ?? []).join("\n")} placeholder={(m.defaults.checklist ?? []).join("\n") || "What to do, line by line"}
      onChange={(e) => set({ checklist: e.target.value.split("\n") }, `check-${step.id}`)} onBlur={() => set({ checklist: (step.checklist ?? []).map((l) => l.trim()).filter(Boolean) })} /></label>
    <label className={css.field}><span>Quality test <em>optional</em></span><textarea rows={2} disabled={readOnly} value={(step.qualityTest ?? []).join("\n")} placeholder={(m.defaults.qualityTest ?? []).join("\n") || "What “good” means, line by line"}
      onChange={(e) => set({ qualityTest: e.target.value.split("\n") }, `qt-${step.id}`)} onBlur={() => set({ qualityTest: (step.qualityTest ?? []).map((l) => l.trim()).filter(Boolean) })} /></label>
    <label className={css.field}><span>Explained in the write-up</span><SelectField value={step.sop?.section ?? ""} disabled={readOnly || !writeup.length} onChange={(e) => set({ sop: e.target.value ? { ...step.sop, section: e.target.value } : null })}>
      <option value="">{writeup.length ? "No part chosen" : "The process has no write-up yet"}</option>{writeup.map((w) => <option key={w.key} value={w.key}>{w.title}</option>)}</SelectField></label>

    {hints.length ? <section className={css.pip} aria-label="Pip's suggestions"><h4><Sparkles size={13} aria-hidden="true" />Pip</h4>
      <ul>{hints.map((h) => <li key={h.key}><span>{h.text}</span>{h.add && !readOnly ? <button type="button" onClick={() => onAddBefore(h.add!)}><Plus size={12} aria-hidden="true" />{h.add.label}</button> : null}</li>)}</ul></section> : null}
    {!readOnly && onSaveBlock ? <SaveBlock step={step} fallback={kind?.label ?? m.name} onSave={onSaveBlock} /> : null}
    {!readOnly ? <button type="button" className={css.danger} onClick={onDelete}><Trash2 size={14} aria-hidden="true" />Remove this step</button> : null}
  </div>;
}

/** "Save as a block": this step, named, under "Your company's blocks" for every process. */
export function SaveBlock({ step, fallback, onSave }: { step: FlowStep; fallback: string; onSave: (s: FlowStep, name: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false), [name, setName] = useState(step.title || fallback), [busy, setBusy] = useState(false);
  if (!open) return <button type="button" className={css.saveBlock} onClick={() => { setName(step.title || fallback); setOpen(true); }}><BookmarkPlus size={14} aria-hidden="true" />Save as a block</button>;
  return <form className={css.saveBlockForm} onSubmit={async (e) => { e.preventDefault(); setBusy(true); if (await onSave(step, name.trim() || fallback)) setOpen(false); setBusy(false); }}>
    <label className={css.field}><span>Name of the block</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus /><small>It keeps this step’s kind, checklist, who and due, for any process.</small></label>
    <div className={css.row2}><button type="submit" className={css.saveBlock} disabled={busy}>{busy ? "Saving…" : "Save the block"}</button><button type="button" className={css.link} onClick={() => setOpen(false)}>Cancel</button></div>
  </form>;
}

/** Who holds the role, least loaded first, from the API's check: their open steps and focused hours. */
export function Holders({ list, role }: { list: NonNullable<Intel["people"]>[string]; role: string }) {
  if (!list.length) return <p className={css.muted}>Nobody in the team holds “{role}” yet: name someone when a run starts.</p>;
  return <div className={css.holders} aria-label={`Who holds ${role}`}><small>{role}, least busy first</small>
    <ul>{list.slice(0, 4).map((p) => <li key={p.id} data-warn={p.warning ? "" : undefined} title={p.warning ?? undefined}><b>{p.name}</b><small>{p.steps} open {p.steps === 1 ? "step" : "steps"}{p.hours ? ` · ${p.hours} h` : ""}</small></li>)}</ul></div>;
}

export const roleName = (def: FlowDef, key: string | null | undefined) => key ? def.roles.find((r) => r.key === key)?.label ?? key : null;
const BY: { by: Assign["by"]; label: string }[] = [{ by: "role", label: "A role" }, { by: "starter", label: "Whoever starts it" }, { by: "project_owner", label: "The project's owner" }, { by: "pool", label: "The pool (first to take it)" }];

export function Who({ who, def, readOnly, onChange }: { who: Assign; def: FlowDef; readOnly: boolean; onChange: (w: Assign) => void }) {
  const value = who.by === "role" ? `role:${who.role ?? ""}` : who.by;
  return <label className={css.field}><span>Who does it</span>
    <SelectField value={value} disabled={readOnly} onChange={(e) => { const v = e.target.value; onChange(v.startsWith("role:") ? { by: "role", role: v.slice(5) || null } : { by: v as Assign["by"] }); }}>
      {def.roles.length ? <optgroup label="A role">{def.roles.map((r) => <option key={r.key} value={`role:${r.key}`}>{r.label}</option>)}</optgroup> : null}
      {who.by === "role" && who.role && !def.roles.some((r) => r.key === who.role) ? <option value={`role:${who.role}`}>{who.role}</option> : null}
      {who.by === "role" && !who.role ? <option value="role:">Choose…</option> : null}
      {BY.filter((b) => b.by !== "role").map((b) => <option key={b.by} value={b.by}>{b.label}</option>)}
    </SelectField></label>;
}

export function Due({ step, def, variant, readOnly, onChange }: { step: FlowStep; def: FlowDef; variant: VariantField | undefined; readOnly: boolean; onChange: (d: DueRule | null) => void }) {
  const due = step.due ?? null;
  const per = !!due && typeof due.days === "object";
  const from = due?.from ?? "";
  const others = def.steps.filter((s) => s.id !== step.id);
  const setFrom = (f: string) => onChange(f ? { from: f as DueRule["from"], days: due?.days ?? 1, field: due?.field, workdays: due?.workdays ?? true } : null);
  return <div className={css.dueBox}>
    <div className={css.row2}>
      <label className={css.field}><span>Due</span><SelectField value={from.startsWith("step:") ? "step" : from} disabled={readOnly} onChange={(e) => setFrom(e.target.value === "step" ? `step:${others[0]?.id ?? ""}` : e.target.value)}>
        <option value="">No due date</option><option value="start">Days after the run starts</option><option value="day1">On Day N (Day 1 = inputs in)</option>{others.length ? <option value="step">Days after another step</option> : null}</SelectField></label>
      {due && !per ? <label className={css.field}><span>{from === "day1" ? "Day" : "Days"}</span><input type="number" min={0} max={365} value={typeof due.days === "number" ? due.days : 0} disabled={readOnly}
        onChange={(e) => onChange({ ...due, days: Math.max(0, Number(e.target.value) || 0) })} /></label> : null}
    </div>
    {due && from.startsWith("step:") ? <label className={css.field}><span>After</span><SelectField value={from.slice(5)} disabled={readOnly} onChange={(e) => onChange({ ...due, from: `step:${e.target.value}` })}>
      {others.map((s) => <option key={s.id} value={s.id}>{s.title || s.id}</option>)}</SelectField></label> : null}
    {due && variant ? <label className={css.inline}><input type="checkbox" checked={per} disabled={readOnly} onChange={(e) => onChange(e.target.checked
      ? { ...due, field: variant.key, days: Object.fromEntries((variant.options ?? []).map((o) => [o.value, typeof due.days === "number" ? due.days : 1])) }
      : { ...due, days: typeof due.days === "number" ? due.days : Math.min(...Object.values(due.days)) })} />Different for each {variant.label.toLowerCase()}</label> : null}
    {due && per && variant ? <div className={css.perVariant}>{(variant.options ?? []).map((o) => <label key={o.value}><span>{o.label}</span>
      <input type="number" min={0} max={365} value={(due.days as Record<string, number>)[o.value] ?? ""} disabled={readOnly}
        onChange={(e) => onChange({ ...due, days: { ...(due.days as Record<string, number>), [o.value]: Math.max(0, Number(e.target.value) || 0) } })} /></label>)}</div> : null}
    {due ? <label className={css.inline}><input type="checkbox" checked={due.workdays !== false} disabled={readOnly} onChange={(e) => onChange({ ...due, workdays: e.target.checked })} />Working days only</label> : null}
  </div>;
}

export function RunsFor({ step, variant, readOnly, onChange }: { step: FlowStep; variant: VariantField; readOnly: boolean; onChange: (w: FlowStep["when"]) => void }) {
  const all = (variant.options ?? []).map((o) => o.value);
  const cond = (step.when ?? []).find((c) => c.field === variant.key && c.op === "in");
  const on = cond?.values ?? all;
  const toggle = (v: string, yes: boolean) => {
    const next = yes ? [...new Set([...on, v])] : on.filter((x) => x !== v);
    const rest = (step.when ?? []).filter((c) => c !== cond);
    onChange(next.length === all.length ? rest : [...rest, { field: variant.key, op: "in", values: next }]);
  };
  return <fieldset className={css.runsFor}><legend>Runs for</legend>
    {(variant.options ?? []).map((o) => <label key={o.value}><input type="checkbox" checked={on.includes(o.value)} disabled={readOnly || (on.length === 1 && on.includes(o.value))} onChange={(e) => toggle(o.value, e.target.checked)} />{o.label}</label>)}
  </fieldset>;
}

export function Notify({ roles, value, readOnly, onChange }: { roles: FlowDef["roles"]; value: string[]; readOnly: boolean; onChange: (v: string[]) => void }) {
  if (!roles.length) return null;
  return <span className={css.notify} role="group" aria-label="Who is told when it is ready"><Bell size={11} aria-hidden="true" />
    {roles.map((r) => <button key={r.key} type="button" aria-pressed={value.includes(r.key)} disabled={readOnly} onClick={() => onChange(value.includes(r.key) ? value.filter((x) => x !== r.key) : [...value, r.key])}>{r.label}</button>)}</span>;
}

export function Setting({ f, value, def, readOnly, onChange }: { f: SettingField; value: unknown; def: FlowDef; readOnly: boolean; onChange: (v: unknown) => void }) {
  const v = value ?? f.default ?? "";
  if (f.type === "boolean") return <label className={css.inline}><input type="checkbox" checked={!!v} disabled={readOnly} onChange={(e) => onChange(e.target.checked)} />{f.label}</label>;
  return <label className={css.field}><span>{f.label}</span>
    {f.type === "choice" ? <SelectField value={String(v)} disabled={readOnly} onChange={(e) => onChange(e.target.value)}><option value="">Choose…</option>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</SelectField>
      : f.type === "role" ? <SelectField value={String(v)} disabled={readOnly} onChange={(e) => onChange(e.target.value)}><option value="">Choose…</option>{def.roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</SelectField>
        : f.type === "longtext" || f.type === "list" || f.type === "items" ? <textarea rows={3} disabled={readOnly} value={Array.isArray(v) ? v.join("\n") : String(v)} onChange={(e) => onChange(f.type === "longtext" ? e.target.value : e.target.value.split("\n"))} />
          : <input type={f.type === "number" ? "number" : "text"} value={String(v)} disabled={readOnly} onChange={(e) => onChange(f.type === "number" ? Number(e.target.value) : e.target.value)} />}
    {f.help ? <small>{f.help}</small> : null}</label>;
}

// --------------------------------------------------------------------------------------------------------- a wire
function WirePanel({ index, def, byKey, modules, edit, readOnly, onClose, onDelete, onConvert, onSelect }: { index: number; def: FlowDef; byKey: Record<string, ModuleManifest>; modules: ModuleManifest[];
  edit: Edit; readOnly: boolean; onClose: () => void; onDelete: () => void; onConvert: (wire: number, module: string) => void; onSelect: (s: Sel) => void }) {
  const w = def.wires[index], c = checkWire(def, byKey, modules, w);
  const a = def.steps.find((s) => s.id === w.from.step), z = def.steps.find((s) => s.id === w.to.step);
  const out = a ? moduleOf(a, byKey).makes.find((p) => p.key === w.from.port) : undefined, inn = z ? moduleOf(z, byKey).needs.find((p) => p.key === w.to.port) : undefined;
  return <div className={css.panel}>
    <div className={css.panelHead}><span className={css.wireIcon} data-k={KIND_SLOT[c.fromKind]} data-bad={c.ok ? undefined : ""} /><span><b>{out?.label ?? "A wire"}</b><small>{c.ok ? `Carries ${article(c.fromKind)}` : c.why}</small></span>
      <button type="button" className={css.close} onClick={onClose} aria-label="Back to the process"><X size={15} /></button></div>
    <p className={css.wirePath}><button type="button" className={css.link} onClick={() => a && onSelect({ kind: "step", id: a.id })}>{a?.title || "A step"}</button> makes <b>{out?.label}</b>
      <ArrowRight size={13} aria-hidden="true" /> <button type="button" className={css.link} onClick={() => z && onSelect({ kind: "step", id: z.id })}>{z?.title || "a step"}</button> needs <b>{inn?.label}</b></p>
    {!c.ok ? <section className={css.pip} aria-label="How to fix it"><h4><Sparkles size={13} aria-hidden="true" />Pip</h4>
      <p>{c.why}. {c.converters.length ? `Put a step between them that turns ${article(c.fromKind)} into ${article(c.toKind)}:` : "No step turns one into the other yet; join it to a step that makes what this one needs."}</p>
      {!readOnly ? <ul>{c.converters.slice(0, 4).map((k) => <li key={k}><span><ModuleIcon name={byKey[k]?.icon} size={14} />{byKey[k]?.name}</span><button type="button" onClick={() => onConvert(index, k)}><Plus size={12} aria-hidden="true" />Add it</button></li>)}</ul> : null}
    </section> : null}
    <section className={css.group} aria-label="Tell people"><h4>When it is ready, tell</h4>
      <Notify roles={def.roles} value={w.notify ?? []} readOnly={readOnly} onChange={(notify) => edit((d) => ({ ...d, wires: d.wires.map((x, j) => j === index ? { ...x, notify } : x) }))} />
      <p className={css.muted}>A hand-off is a message, not a lock: the next step starts when its data is there.</p></section>
    <label className={css.field}><span>Words on the wire <em>optional</em></span><input value={w.label ?? ""} maxLength={80} disabled={readOnly} placeholder="e.g. the brochure from the client"
      onChange={(e) => edit((d) => ({ ...d, wires: d.wires.map((x, j) => j === index ? { ...x, label: e.target.value || null } : x) }), `wl-${index}`)} /></label>
    {!readOnly ? <button type="button" className={css.danger} onClick={onDelete}><Trash2 size={14} aria-hidden="true" />Remove this wire</button> : null}
  </div>;
}
