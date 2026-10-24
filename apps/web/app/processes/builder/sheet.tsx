"use client";
// FLOW-D (owner, 21 Oct 2026: "creating is hard"): a step's side sheet asks plain questions, in the order a person
// thinks: what kind of step it is, what happens, who does it, when it is due, what it uses from earlier steps, what
// they hand in, who should know when it is done. Each primitive asks only what it needs (a Collect asks which form,
// a Decide which answer decides, a Message who reads what). Every answer is the same process definition the Map shows.
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Bell, CircleAlert, Plus, Trash2, X } from "lucide-react";
import { kindOf, moduleOf } from "../../lib/flow-canvas.mjs";
import { before, gates } from "../../lib/flow-list.mjs";
import type { AlertRule, Assign, BlockKind, FlowDef, FlowStep, ModuleManifest, Primitive, Problem, VariantField, WriteupSection } from "../flow-types";
import type { Intel } from "./builder";
import { Due, Holders, roleName, RunsFor, SaveBlock, withKind } from "./inspector";
import { ModuleIcon } from "./kinds";
import { AppLine } from "./app-line";
import css from "./builder.module.css";

type Edit = (fn: (d: FlowDef) => FlowDef, key?: string) => void;
type FormLite = { id: string; name: string; status: string; photos: number; fields: { key: string; label: string; type: string }[] };
const slug = (x: string) => x.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "role";
const lines = (x: unknown) => (Array.isArray(x) ? x.map(String) : typeof x === "string" && x ? x.split("\n") : []);
/** Primitives that go by themselves: nobody is asked to do them. */
const SELF = new Set(["start", "wait", "end"]);

export function StepSheet({ step, def, byKey, primitives, edit, writeup, problems, people, readOnly, onClose, onSaveBlock, onRemove, onMove, onAddBefore, onAddAfter }: {
  step: FlowStep; def: FlowDef; byKey: Record<string, ModuleManifest>; primitives: Primitive[]; edit: Edit; writeup: WriteupSection[]; problems: Problem[];
  people: Intel["people"] | null; readOnly: boolean; onClose: () => void; onSaveBlock?: (s: FlowStep, name: string) => Promise<boolean>;
  onRemove: () => void; onMove: (dir: "up" | "down") => void; onAddBefore: (pick: string) => void; onAddAfter: (pick: string) => void;
}) {
  const pr = primitives.find((p) => p.key === step.block);
  const m = moduleOf(step, byKey), kind = pr ? kindOf(step, pr) : null;
  const set = (patch: Partial<FlowStep>, key?: string) => edit((d) => ({ ...d, steps: d.steps.map((s) => s.id === step.id ? { ...s, ...patch } : s) }), key);
  const setting = (k: string, v: unknown, key?: string) => edit((d) => ({ ...d, steps: d.steps.map((s) => s.id === step.id ? { ...s, settings: { ...s.settings, [k]: v } } : s) }), key ?? `set-${step.id}-${k}`);
  const variant = def.fields.find((f) => f.variant && f.type === "choice");
  const [more, setMore] = useState(!!kind?.more);
  const id = step.id, block = step.block ?? "";
  return <aside className={css.sheet} aria-label={`Step: ${step.title || kind?.label || m.name}`} data-block={block || undefined}>
    <div className={css.sheetHead}>
      <span className={css.sheetIcon}><ModuleIcon name={m.icon} size={18} /></span>
      <span><b>{pr?.name ?? m.name}</b><small>{pr?.finish ?? m.summary}</small></span>
      <button type="button" className={css.close} onClick={onClose} aria-label="Close the step" title="Close (Esc)"><X size={16} /></button>
    </div>
    <div className={css.sheetBody}>
      {problems.length ? <ul className={css.sheetProblems} aria-label="To look at">{problems.map((p, i) => <li key={i} data-level={p.level}><CircleAlert size={14} aria-hidden="true" /><span>{p.text}</span>
        {p.fix && p.fix.kind === "block" && !readOnly ? <button type="button" onClick={() => onAddBefore(`block:${p.fix && p.fix.kind === "block" ? p.fix.block : "task"}`)}><Plus size={12} aria-hidden="true" />{p.fix.label}</button> : null}</li>)}</ul> : null}

      {pr ? <fieldset className={css.q}><legend>{pr.question}</legend>
        {kind && (block === "app" || block === "start") ? <AppLine block={block} kind={kind.key} stepId={step.id} readOnly={readOnly} /> : null}
        <div className={css.kinds} role="radiogroup" aria-label={pr.question}>
          {pr.kinds.filter((k) => !k.more || more || k.key === kind?.key).map((k) => <button key={k.key} type="button" role="radio" aria-checked={k.key === kind?.key} disabled={readOnly}
            onClick={() => edit((d) => withKind(d, step, k, byKey))} title={k.help}><b>{k.label}</b><small>{k.help}</small></button>)}
          {pr.kinds.some((k) => k.more) && !more ? <button type="button" className={css.moreKinds} onClick={() => setMore(true)}>More kinds…</button> : null}
        </div></fieldset> : null}

      <label className={css.q}><span>What happens here?</span>
        <input value={step.title} onChange={(e) => set({ title: e.target.value }, `title-${id}`)} maxLength={200} disabled={readOnly} placeholder={kind?.label ?? m.name} />
        <textarea rows={2} value={step.note ?? ""} onChange={(e) => set({ note: e.target.value || null }, `note-${id}`)} disabled={readOnly} maxLength={2000} placeholder="Say more for whoever does it (optional)" /></label>

      {kind ? <KindQuestions step={step} kind={kind} def={def} edit={edit} setting={setting} set={set} readOnly={readOnly} /> : null}

      {!SELF.has(block) && !(block === "message" && kind?.key === "pulse") ? <div className={css.q}><span className={css.qLabel}>{block === "review" ? "Who approves it?" : block === "ai" ? "Who keeps what Pip does?" : "Who does it?"}</span>
        <WhoPick who={step.who} def={def} edit={edit} readOnly={readOnly} onChange={(who) => set({ who })} />
        {step.who.by === "role" && step.who.role && people?.[step.who.role] ? <Holders list={people[step.who.role]} role={roleName(def, step.who.role) ?? step.who.role} /> : null}</div> : null}

      {!["start", "end"].includes(block) ? <div className={css.q}><span className={css.qLabel}>When is it due?</span>
        <Due step={step} def={def} variant={variant} readOnly={readOnly} onChange={(due) => set({ due }, `due-${id}`)} /></div> : null}

      {!["start"].includes(block) ? <Uses step={step} def={def} byKey={byKey} edit={edit} readOnly={readOnly} /> : null}

      {block === "task" || (!block && m.surface === "task") ? <label className={css.q}><span>What do they hand in? <em>optional</em></span>
        <input value={String(step.settings.handIn ?? "")} onChange={(e) => setting("handIn", e.target.value || undefined)} disabled={readOnly} placeholder="e.g. the signed contract, a link to the design" maxLength={200} /></label> : null}

      {!["start", "end", "wait", "decide", "message"].includes(block) ? <label className={css.q}><span>Checklist <em>one line each</em></span>
        <textarea rows={3} disabled={readOnly} value={(step.checklist ?? []).join("\n")} placeholder={(m.defaults.checklist ?? []).join("\n") || "What to do, line by line"}
          onChange={(e) => set({ checklist: e.target.value.split("\n") }, `check-${id}`)} onBlur={() => set({ checklist: (step.checklist ?? []).map((l) => l.trim()).filter(Boolean) })} /></label> : null}

      {!["end"].includes(block) ? <Tell step={step} def={def} byKey={byKey} edit={edit} readOnly={readOnly} onAddMessage={() => onAddAfter("block:message")} /> : null}

      {variant ? <div className={css.q}><span className={css.qLabel}>Only for</span><RunsFor step={step} variant={variant} readOnly={readOnly} onChange={(when) => set({ when })} /></div> : null}

      {writeup.length ? <label className={css.q}><span>How it is done <em>the part of the write-up</em></span><select value={step.sop?.section ?? ""} disabled={readOnly} onChange={(e) => set({ sop: e.target.value ? { ...step.sop, section: e.target.value } : null })}>
        <option value="">No part chosen</option>{writeup.map((w) => <option key={w.key} value={w.key}>{w.title}</option>)}</select></label> : null}

      {!readOnly ? <div className={css.sheetActions}>
        <div className={css.row2}><button type="button" className={css.saveBlock} onClick={() => onMove("up")} title="Move up"><ArrowUp size={14} aria-hidden="true" />Up</button>
          <button type="button" className={css.saveBlock} onClick={() => onMove("down")} title="Move down"><ArrowDown size={14} aria-hidden="true" />Down</button></div>
        {onSaveBlock ? <SaveBlock step={step} fallback={kind?.label ?? m.name} onSave={onSaveBlock} /> : null}
        <button type="button" className={css.danger} onClick={onRemove}><Trash2 size={14} aria-hidden="true" />Remove this step</button>
      </div> : null}
    </div>
  </aside>;
}

/** Who does it: a role (or a new one, named here), or whoever starts the run. */
function WhoPick({ who, def, edit, readOnly, onChange }: { who: Assign; def: FlowDef; edit: Edit; readOnly: boolean; onChange: (w: Assign) => void }) {
  const [adding, setAdding] = useState(false), [name, setName] = useState("");
  const value = who.by === "role" ? `role:${who.role ?? ""}` : who.by;
  if (adding) return <form className={css.row2} onSubmit={(e) => { e.preventDefault(); const label = name.trim(); if (!label) return; const key = slug(label);
    edit((d) => ({ ...d, roles: d.roles.some((r) => r.key === key) ? d.roles : [...d.roles, { key, label }] })); onChange({ by: "role", role: key }); setAdding(false); setName(""); }}>
    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Site surveyor" autoFocus maxLength={80} aria-label="The new role" />
    <button type="submit" className={css.saveBlock}>Add</button></form>;
  return <select value={value} disabled={readOnly} aria-label="Who does it" onChange={(e) => { const v = e.target.value; if (v === "new") { setAdding(true); return; }
    onChange(v.startsWith("role:") ? { by: "role", role: v.slice(5) || null } : { by: v as Assign["by"] }); }}>
    <option value="starter">Whoever starts it</option>
    {def.roles.length ? <optgroup label="A role">{def.roles.map((r) => <option key={r.key} value={`role:${r.key}`}>{r.label}</option>)}</optgroup> : null}
    {who.by === "role" && !who.role ? <option value="role:">Choose…</option> : null}
    <option value="project_owner">The project’s owner</option><option value="pool">The pool (first to take it)</option>
    <option value="new">A new role…</option>
  </select>;
}

/** What it uses from earlier steps (data passes by itself; this names it, and Pulse checks it comes earlier). */
function Uses({ step, def, byKey, edit, readOnly }: { step: FlowStep; def: FlowDef; byKey: Record<string, ModuleManifest>; edit: Edit; readOnly: boolean }) {
  const earlier = useMemo(() => { const b = before(def, byKey, step.id); return def.steps.filter((s) => b.has(s.id) && moduleOf(s, byKey).makes.length && s.block !== "start"); }, [def, byKey, step.id]);
  const uses = step.uses ?? [];
  const on = (sid: string) => uses.some((u) => u.step === sid);
  const toggle = (s: FlowStep) => edit((d) => ({ ...d, steps: d.steps.map((x) => x.id === step.id ? { ...x, uses: on(s.id) ? uses.filter((u) => u.step !== s.id) : [...uses, { step: s.id, label: s.title || moduleOf(s, byKey).name }] } : x) }));
  if (!earlier.length) return null;
  return <div className={css.q}><span className={css.qLabel}>What does it use from earlier steps? <em>it arrives by itself</em></span>
    <div className={css.useChips}>{earlier.slice(-12).map((s) => { const out = moduleOf(s, byKey).makes[0];
      return <button key={s.id} type="button" aria-pressed={on(s.id)} disabled={readOnly} onClick={() => toggle(s)} data-block={s.block ?? undefined}>
        <ModuleIcon name={moduleOf(s, byKey).icon} size={12} />{out?.label ?? "What it makes"} · {s.title || moduleOf(s, byKey).name}</button>; })}</div></div>;
}

/** Who should know when it is done: told inside Pulse as the steps after it open. */
function Tell({ step, def, byKey, edit, readOnly, onAddMessage }: { step: FlowStep; def: FlowDef; byKey: Record<string, ModuleManifest>; edit: Edit; readOnly: boolean; onAddMessage: () => void }) {
  const outs = gates(def, byKey).filter((w) => w.from.step === step.id);
  const told = [...new Set(outs.flatMap((w) => w.notify ?? []))];
  const toggle = (r: string) => edit((d) => ({ ...d, wires: d.wires.map((w) => outs.some((o) => o.from.step === w.from.step && o.from.port === w.from.port && o.to.step === w.to.step && o.to.port === w.to.port)
    ? { ...w, notify: told.includes(r) ? (w.notify ?? []).filter((x) => x !== r) : [...new Set([...(w.notify ?? []), r])] } : w) }));
  return <div className={css.q}><span className={css.qLabel}><Bell size={13} aria-hidden="true" />Who should know when it’s done?</span>
    {!outs.length ? <p className={css.muted}>Nothing comes after it yet. {!readOnly ? <button type="button" className={css.link} onClick={onAddMessage}>Add a Message after it</button> : null}</p>
      : def.roles.length ? <div className={css.useChips}>{def.roles.map((r) => <button key={r.key} type="button" aria-pressed={told.includes(r.key)} disabled={readOnly} onClick={() => toggle(r.key)}>{r.label}</button>)}
        <button type="button" aria-pressed={told.includes("starter")} disabled={readOnly} onClick={() => toggle("starter")}>Whoever started it</button></div>
        : <div className={css.useChips}><button type="button" aria-pressed={told.includes("starter")} disabled={readOnly} onClick={() => toggle("starter")}>Whoever started it</button></div>}
  </div>;
}

/** The questions only one kind asks. */
function KindQuestions({ step, kind, def, edit, setting, set, readOnly }: { step: FlowStep; kind: BlockKind; def: FlowDef; edit: Edit;
  setting: (k: string, v: unknown, key?: string) => void; set: (patch: Partial<FlowStep>, key?: string) => void; readOnly: boolean }) {
  const s = step.settings, b = step.block, k = kind.key;
  const dateFields = def.fields.filter((f) => f.type === "date");
  if (b === "start" && k === "schedule") return <div className={css.q}><span className={css.qLabel}>When does a run start?</span><div className={css.row3}>
    <select value={String(s.every ?? "week")} disabled={readOnly} onChange={(e) => setting("every", e.target.value)} aria-label="How often"><option value="day">Every day</option><option value="week">Every week</option></select>
    {String(s.every ?? "week") === "week" ? <select value={String(s.day ?? 1)} disabled={readOnly} onChange={(e) => setting("day", Number(e.target.value))} aria-label="On">{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select> : null}
    <input type="time" value={String(s.at ?? "10:00")} disabled={readOnly} onChange={(e) => setting("at", e.target.value)} aria-label="At" /></div></div>;
  if (b === "start" && k === "form") return <FormPick label="Which form starts it?" value={String(s.formId ?? "")} onChange={(v) => setting("formId", v)} readOnly={readOnly} />;
  if (b === "start" && k === "lead") return <p className={css.muted}>Each new lead (from the ads or added in Pulse) starts a run by itself, on its project.</p>;
  if (b === "start" && k === "hand") return <p className={css.muted}>Someone presses Start and picks the client or project.</p>;
  if (b === "collect" && (k === "answers" || k === "photos")) return <>
    <FormPick label={k === "photos" ? "Which form takes the photos?" : "Which form?"} value={String(s.formId ?? "")} onChange={(v) => setting("formId", v)} readOnly={readOnly} photos={k === "photos"} />
    <label className={css.q}><span>From whom?</span><select value={String(s.from ?? "team")} disabled={readOnly} onChange={(e) => setting("from", e.target.value)}>
      <option value="team">Someone in the team fills it</option><option value="client">The client fills it (a link to send)</option></select></label></>;
  if (b === "collect" && k === "items") {
    const items = (Array.isArray(s.items) ? s.items : []) as { key: string; label: string; critical?: boolean; owner?: string }[];
    const text = items.map((i) => `${i.label}${i.critical === false ? "" : " *"}`).join("\n");
    const clock = def.clock?.from === "intake" && def.clock.step === step.id;
    return <label className={css.q}><span>What must come in? <em>one per line; * = needed to start</em></span>
      <textarea rows={4} disabled={readOnly} defaultValue={text} placeholder={"Signed order *\nRoof photos *\nElectricity bill"}
        onBlur={(e) => setting("items", e.target.value.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 40).map((l) => ({ key: slug(l.replace(/\*$/, "")), label: l.replace(/\s*\*$/, ""), critical: /\*$/.test(l), owner: "" })))} />
      <span className={css.inline}><input type="checkbox" checked={clock} disabled={readOnly} onChange={(e) => edit((d) => ({ ...d, clock: e.target.checked ? { from: "intake", step: step.id } : { from: "start" } }))} />Day 1 is the day the starred ones are all in</span></label>;
  }
  if (b === "collect" && k === "files") return <label className={css.q}><span>What files?</span><input value={String(s.what ?? "")} disabled={readOnly} onChange={(e) => setting("what", e.target.value)} placeholder="e.g. floor plans, raw footage" /></label>;
  if (b === "meet" && k === "meeting") return <>
    <RolesPick label="Who meets?" def={def} value={lines(s.people)} onChange={(v) => setting("people", v)} readOnly={readOnly} />
    <label className={css.inline}><input type="checkbox" checked={!!s.score} disabled={readOnly} onChange={(e) => setting("score", e.target.checked)} />Score the client after it</label>
    <p className={css.muted}>Paste the transcript or notes in the step; Pip writes the summary and the follow-ups.</p></>;
  if (b === "meet" && k === "slot") return <>
    <RolesPick label="Who attends?" def={def} value={lines(s.people)} onChange={(v) => setting("people", v)} readOnly={readOnly} />
    {dateFields.length ? <label className={css.q}><span>The date it fixes</span><select value={String(s.field ?? "")} disabled={readOnly} onChange={(e) => setting("field", e.target.value)}><option value="">None</option>{dateFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select></label> : null}</>;
  if (b === "write" && k === "doc") return <label className={css.q}><span>Its sections <em>one per line</em></span><textarea rows={3} disabled={readOnly} value={lines(s.sections).join("\n")} placeholder={"Summary\nFindings\nNext steps"}
    onChange={(e) => setting("sections", e.target.value.split("\n"))} onBlur={() => setting("sections", lines(s.sections).map((x) => x.trim()).filter(Boolean))} /></label>;
  if (b === "write" && k === "section") {
    const docs = def.steps.filter((x) => x.module === "doc" && x.id !== step.id);
    return <div className={css.row2}><label className={css.q}><span>Which document?</span><select value={String(s.docStep ?? "")} disabled={readOnly} onChange={(e) => setting("docStep", e.target.value)}><option value="">The run’s first document</option>{docs.map((d) => <option key={d.id} value={d.id}>{d.title || d.id}</option>)}</select></label>
      <label className={css.q}><span>Section</span><input value={String(s.section ?? "")} disabled={readOnly} onChange={(e) => setting("section", e.target.value)} placeholder="e.g. Findings" /></label></div>;
  }
  if (b === "write" && k === "deliverable") return <div className={css.row2}><label className={css.q}><span>Type</span><input value={String(s.assetType ?? "")} disabled={readOnly} onChange={(e) => setting("assetType", e.target.value)} placeholder="e.g. Video, Report" /></label>
    <label className={css.q}><span>Tabs <em>one per line</em></span><textarea rows={2} disabled={readOnly} value={lines(s.tabs).join("\n")} onChange={(e) => setting("tabs", e.target.value.split("\n"))} /></label></div>;
  if (b === "review" && (k === "approve" || k === "client")) {
    const rule = def.rules.find((r) => r.key === `late_${slug(step.id)}`);
    const setLimit = (days: number | null) => edit((d) => ({ ...d, steps: d.steps.map((x) => x.id === step.id ? { ...x, settings: { ...x.settings, slaDays: days ?? undefined } } : x),
      rules: [...d.rules.filter((r) => r.key !== `late_${slug(step.id)}`), ...(days ? [{ key: `late_${slug(step.id)}`, name: `${step.title || "Review"} waiting`, when: "in-state-longer", steps: [step.id], state: k === "client" ? "in_review" : "open", waitDays: days, notify: ["doer", "starter"] } as AlertRule] : [])] }));
    return <>{k === "client" ? <label className={css.q}><span>It is done when</span><select value={String(typeof s.finishWhen === "string" ? s.finishWhen : "confirmed")} disabled={readOnly} onChange={(e) => setting("finishWhen", e.target.value)}>
        <option value="confirmed">The client confirms</option><option value="sent">It is sent to them</option></select></label> : null}
      <div className={css.row2}><label className={css.q}><span>Answer within <em>working days</em></span><input type="number" min={0} max={60} value={Number(s.slaDays ?? 0) || ""} disabled={readOnly} placeholder="No limit"
        onChange={(e) => setLimit(Number(e.target.value) || null)} /><small>{rule ? "Late answers alert whoever does it and whoever started it." : "Set a limit to be alerted."}</small></label>
        <label className={css.q}><span>Rounds allowed</span><input type="number" min={0} max={20} value={Number(s.rounds ?? 0) || ""} disabled={readOnly} placeholder="Any" onChange={(e) => setting("rounds", Number(e.target.value) || undefined)} /></label></div></>;
  }
  if (b === "review" && k === "check" || b === "ai" && (k === "check" || k === "score")) return <label className={css.q}><span>What “good” means <em>one test per line</em></span>
    <textarea rows={3} disabled={readOnly} value={(step.qualityTest ?? []).join("\n")} placeholder={"No word to avoid\nEvery figure has a source"} onChange={(e) => set({ qualityTest: e.target.value.split("\n") }, `qt-${step.id}`)}
      onBlur={() => set({ qualityTest: (step.qualityTest ?? []).map((l) => l.trim()).filter(Boolean) })} /></label>;
  if (b === "decide") return <DecideQuestions step={step} kind={kind} def={def} edit={edit} setting={setting} readOnly={readOnly} />;
  if (b === "wait" && k === "time") { const hours = Number(s.hours ?? 24);
    return <div className={css.row2}><label className={css.q}><span>How long?</span><input type="number" min={1} max={365} value={hours % 24 === 0 ? hours / 24 : hours} disabled={readOnly}
      onChange={(e) => setting("hours", (Number(e.target.value) || 1) * (hours % 24 === 0 ? 24 : 1))} /></label>
      <label className={css.q}><span>&nbsp;</span><select value={hours % 24 === 0 ? "days" : "hours"} disabled={readOnly} onChange={(e) => setting("hours", e.target.value === "days" ? Math.max(1, Math.round(hours / 24)) * 24 : Math.max(1, hours % 24 === 0 ? hours / 24 : hours))}><option value="days">days</option><option value="hours">hours</option></select></label></div>; }
  if (b === "wait" && k === "date") return <DateField step={step} def={def} edit={edit} setting={setting} readOnly={readOnly} />;
  if (b === "wait" && k === "arrives") return <label className={css.q}><span>What arrives?</span><input value={String(s.what ?? "")} disabled={readOnly} onChange={(e) => setting("what", e.target.value)} placeholder="e.g. the signed agreement, the payment" /><small>Whoever does it marks it arrived, with what came.</small></label>;
  if (b === "message") return <MessageQuestions step={step} kind={kind} def={def} setting={setting} readOnly={readOnly} />;
  if (b === "app" && k === "process") return <ProcessPick value={String(s.processId ?? "")} onChange={(v) => setting("processId", v)} readOnly={readOnly} />;
  if (b === "app" && k === "folder") return <label className={css.q}><span>Folders <em>one per line</em></span><textarea rows={3} disabled={readOnly} value={lines(s.folders).join("\n")} onChange={(e) => setting("folders", e.target.value.split("\n"))} /></label>;
  if (b === "app" && (k === "quote" || k === "invoice")) return <p className={css.muted}>Opens Billing to make the {k === "quote" ? "quotation" : "invoice"} for the run’s client; the step keeps the one chosen on it.</p>;
  if (b === "app" && k === "xray") return <p className={css.muted}>Whoever does it picks the call from their Sales X-Ray; its summary, items asked for, objections and promises travel on.</p>;
  if (b === "repeat" && k === "session") return <div className={css.row3}>
    <select value={String(s.every ?? "day")} disabled={readOnly} onChange={(e) => setting("every", e.target.value)} aria-label="How often"><option value="day">Every day</option><option value="week">Every week</option></select>
    <input value={String(s.at ?? "")} disabled={readOnly} onChange={(e) => setting("at", e.target.value)} placeholder="At (e.g. 14:00)" aria-label="At" />
    <select value={String(s.agenda ?? "open")} disabled={readOnly} onChange={(e) => setting("agenda", e.target.value)} aria-label="Agenda"><option value="open">Agenda: open steps</option><option value="rough_cut">Agenda: drafts ready to look at</option><option value="live">Agenda: work live 10–15 days</option></select></div>;
  return null;
}

function DecideQuestions({ step, kind, def, edit, setting, readOnly }: { step: FlowStep; kind: BlockKind; def: FlowDef; edit: Edit; setting: (k: string, v: unknown) => void; readOnly: boolean }) {
  const s = step.settings, rule = (s.rule && typeof s.rule === "object" ? s.rule : {}) as { field?: string; op?: string; value?: string };
  const field = def.fields.find((f) => f.key === rule.field);
  const [label, setLabel] = useState(""), [opts, setOpts] = useState("");
  return <>
    <div className={css.row2}><label className={css.q}><span>One way is</span><input value={String(s.yes ?? "")} placeholder="Yes" disabled={readOnly} onChange={(e) => setting("yes", e.target.value || undefined)} maxLength={40} /></label>
      <label className={css.q}><span>The other way</span><input value={String(s.no ?? "")} placeholder="Otherwise" disabled={readOnly} onChange={(e) => setting("no", e.target.value || undefined)} maxLength={40} /></label></div>
    {kind.key === "rule" ? <div className={css.q}><span className={css.qLabel}>It goes the first way when</span>
      {def.fields.length ? <div className={css.row3}>
        <select value={rule.field ?? ""} disabled={readOnly} onChange={(e) => setting("rule", { ...rule, field: e.target.value, op: rule.op ?? "eq" })} aria-label="The answer"><option value="">Choose the answer…</option>{def.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
        <select value={rule.op ?? "eq"} disabled={readOnly} onChange={(e) => setting("rule", { ...rule, op: e.target.value })} aria-label="Is"><option value="eq">is</option><option value="ne">is not</option><option value="gt">is more than</option><option value="lt">is less than</option><option value="filled">is filled in</option></select>
        {rule.op === "filled" ? null : field?.options?.length ? <select value={String(rule.value ?? "")} disabled={readOnly} onChange={(e) => setting("rule", { ...rule, value: e.target.value })} aria-label="Value"><option value="">Choose…</option>{field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          : <input value={String(rule.value ?? "")} disabled={readOnly} onChange={(e) => setting("rule", { ...rule, value: e.target.value })} aria-label="Value" placeholder="Value" />}</div>
        : <p className={css.muted}>A rule reads an answer the run has. Ask one when a run starts:</p>}
      {!readOnly ? <form className={css.row3} onSubmit={(e) => { e.preventDefault(); const l = label.trim(); if (!l) return; const key = slug(l); const options = opts.split(",").map((x) => x.trim()).filter(Boolean);
        edit((d) => ({ ...d, fields: [...d.fields.filter((f) => f.key !== key), options.length ? { key, label: l, type: "choice", options: options.map((o) => ({ value: slug(o), label: o })) } : { key, label: l, type: "text" }] as VariantField[] }));
        setting("rule", { field: key, op: "eq", value: options.length ? slug(options[0]) : "" }); setLabel(""); setOpts(""); }}>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="New question, e.g. Roof" aria-label="A question asked when a run starts" />
        <input value={opts} onChange={(e) => setOpts(e.target.value)} placeholder="Answers, e.g. RCC, Tin" aria-label="Its answers, separated by commas" />
        <button type="submit" className={css.saveBlock}>Ask it</button></form> : null}</div>
      : <p className={css.muted}>Whoever does it picks the way; the other way’s steps are skipped.</p>}
  </>;
}

function DateField({ step, def, edit, setting, readOnly }: { step: FlowStep; def: FlowDef; edit: Edit; setting: (k: string, v: unknown) => void; readOnly: boolean }) {
  const dates = def.fields.filter((f) => f.type === "date"); const [label, setLabel] = useState("");
  return <div className={css.q}><span className={css.qLabel}>Until which date?</span>
    {dates.length ? <select value={String(step.settings.field ?? "")} disabled={readOnly} onChange={(e) => setting("field", e.target.value)}><option value="">Choose…</option>{dates.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select> : null}
    {!readOnly ? <form className={css.row2} onSubmit={(e) => { e.preventDefault(); const l = label.trim(); if (!l) return; const key = slug(l);
      edit((d) => ({ ...d, fields: [...d.fields.filter((f) => f.key !== key), { key, label: l, type: "date" }] })); setting("field", key); setLabel(""); }}>
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="A new date, e.g. Install date" aria-label="A new date asked when a run starts" /><button type="submit" className={css.saveBlock}>Add</button></form> : null}
    <small className={css.muted}>The date is asked when a run starts (and can change on the run).</small></div>;
}

function MessageQuestions({ step, kind, def, setting, readOnly }: { step: FlowStep; kind: BlockKind; def: FlowDef; setting: (k: string, v: unknown) => void; readOnly: boolean }) {
  const s = step.settings, text = String(s.text ?? "");
  const values = [{ k: "{client}", l: "Client" }, { k: "{project}", l: "Project" }, { k: "{run}", l: "Run name" }, { k: "{today}", l: "Today" }, ...def.fields.map((f) => ({ k: `{${f.key}}`, l: f.label }))];
  const roles = lines(s.roles);
  return <>
    {kind.key === "pulse" ? <RolesPick label="Who should know?" def={def} value={roles} onChange={(v) => setting("roles", v)} readOnly={readOnly} starter />
      : <div className={css.row2}><label className={css.q}><span>How</span><select value={String(s.channel ?? "whatsapp")} disabled={readOnly} onChange={(e) => setting("channel", e.target.value)}><option value="whatsapp">WhatsApp</option><option value="email">E-mail</option></select></label>
        <label className={css.q}><span>To</span><input value={String(s.to ?? "")} disabled={readOnly} onChange={(e) => setting("to", e.target.value)} placeholder="e.g. the client" /></label></div>}
    <label className={css.q}><span>What do they read?</span><textarea rows={3} value={text} disabled={readOnly} maxLength={1000} onChange={(e) => setting("text", e.target.value)} placeholder="e.g. Hello {client}, your site visit is booked." /></label>
    {!readOnly ? <div className={css.useChips} aria-label="Put in a value">{values.map((v) => <button key={v.k} type="button" onClick={() => setting("text", `${text}${text && !text.endsWith(" ") ? " " : ""}${v.k}`)}>+ {v.l}</button>)}</div> : null}
    {kind.key === "send" ? <p className={css.muted}>Pulse fills in the values; whoever does it copies the text to {String(s.channel ?? "whatsapp") === "email" ? "e-mail" : "WhatsApp"} and marks it sent.</p> : null}
  </>;
}

function RolesPick({ label, def, value, onChange, readOnly, starter }: { label: string; def: FlowDef; value: string[]; onChange: (v: string[]) => void; readOnly: boolean; starter?: boolean }) {
  const toggle = (r: string) => onChange(value.includes(r) ? value.filter((x) => x !== r) : [...value, r]);
  return <div className={css.q} role="group" aria-label={label}><span className={css.qLabel}>{label}</span><div className={css.useChips}>
    {starter ? <button type="button" aria-pressed={value.includes("starter")} disabled={readOnly} onClick={() => toggle("starter")}>Whoever started it</button> : null}
    {def.roles.map((r) => <button key={r.key} type="button" aria-pressed={value.includes(r.key)} disabled={readOnly} onClick={() => toggle(r.key)}>{r.label}</button>)}
    {!def.roles.length && !starter ? <span className={css.muted}>Name roles under “Who does it?” first.</span> : null}</div></div>;
}

function FormPick({ label, value, onChange, readOnly, photos }: { label: string; value: string; onChange: (v: string) => void; readOnly: boolean; photos?: boolean }) {
  const [forms, setForms] = useState<FormLite[] | null>(null);
  useEffect(() => { let gone = false; fetch("/api/v0/forms").then((r) => r.json()).then((d: { forms?: FormLite[] }) => { if (!gone) setForms(d.forms ?? []); }).catch(() => setForms([])); return () => { gone = true; }; }, []);
  const list = (forms ?? []).filter((f) => f.status === "live" && (!photos || f.photos > 0));
  return <label className={css.q}><span>{label}</span>
    <select value={value} disabled={readOnly || !forms} onChange={(e) => onChange(e.target.value)}><option value="">{forms ? (list.length ? "Choose a form…" : photos ? "No live form takes photos yet" : "No live form yet") : "Loading the forms…"}</option>
      {list.map((f) => <option key={f.id} value={f.id}>{f.name} · {f.fields.length} {f.fields.length === 1 ? "field" : "fields"}{f.photos ? ` · ${f.photos} photo` : ""}</option>)}</select>
    <small><a href="/sops/forms" target="_blank" rel="noreferrer">Make or change a form</a>{photos ? " · a camera photo field takes the time and place" : ""}</small></label>;
}

function ProcessPick({ value, onChange, readOnly }: { value: string; onChange: (v: string) => void; readOnly: boolean }) {
  const [list, setList] = useState<{ id: string; name: string; status: string; source: string }[] | null>(null);
  useEffect(() => { let gone = false; fetch("/api/v1/flow/processes").then((r) => r.json()).then((d: { processes?: { id: string; name: string; status: string; source: string }[] }) => { if (!gone) setList((d.processes ?? []).filter((p) => p.source === "flow")); }).catch(() => setList([])); return () => { gone = true; }; }, []);
  return <label className={css.q}><span>Which process takes over?</span><select value={value} disabled={readOnly || !list} onChange={(e) => onChange(e.target.value)}>
    <option value="">{list ? "Choose…" : "Loading…"}</option>{(list ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}{p.status === "live" ? "" : " (not live yet)"}</option>)}</select>
    <small>Its run starts with the same client, project and answers when it is live.</small></label>;
}

