"use client";
// SOP-WORKFLOW: write or change an SOP. The steps on the left (reorder, add, remove), the chosen step's details under
// them, and the live picture on the right: the flow redraws as you type. A step goes on to the next one unless you say
// where (decisions and approvals branch: "Approved" / "Send back"). Leadership saves a draft or makes it active.
import { useRouter } from "next/navigation";
import { useMemo, useState, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, ClipboardPaste, Copy, Plus, Sparkles, Trash2, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { PersonPicker, useWorkOptions } from "../create";
import { post } from "../records";
import { styles } from "../ui";
import { FlowCanvas } from "./flow";
import { Confidence } from "./parts";
import { useLaneSlots } from "./view";
import { emptyStep, KIND_LABEL, type Draft, type Holder, type SopDoc, type SopStep, type StepKind } from "./types";
import css from "./sops.module.css";
import { SelectField } from "../kit/select-field";

const msg = (e: unknown) => e instanceof Error ? e.message : "Could not save";
type Mode = { kind: "new" } | { kind: "edit"; id: string } | { kind: "import"; sourceId: string; part: number };
const UNITS = [["min", 1 / 60], ["h", 1], ["d", 24]] as const;
const split = (h: number | null): [string, string] => h == null ? ["", "h"] : h >= 24 && h % 24 === 0 ? [String(h / 24), "d"] : h < 1 ? [String(Math.round(h * 60)), "min"] : [String(h), "h"];
const join = (v: string, u: string) => { const n = Number(v); if (!v.trim() || !Number.isFinite(n) || n <= 0) return null; return Math.round(n * (UNITS.find((x) => x[0] === u)?.[1] ?? 1) * 100) / 100; };

export function TagInput({ label, value, onChange, placeholder }: { label: string; value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [text, setText] = useState("");
  const add = () => { const t = text.trim(); if (t && !value.includes(t)) onChange([...value, t]); setText(""); };
  const key = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1)); };
  return <label className={css.field}><span>{label}</span><span className={css.tagInput}>
    {value.map((v) => <span key={v} className={css.chip}>{v}<button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}><X size={10} aria-hidden="true" /></button></span>)}
    <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={key} onBlur={add} placeholder={value.length ? "" : placeholder} aria-label={label} /></span></label>;
}

export function TimeField({ label, hours, onChange, hint }: { label: string; hours: number | null; onChange: (h: number | null) => void; hint: string }) {
  const [v, u] = split(hours); const [val, setVal] = useState(v), [unit, setUnit] = useState(u);
  return <label className={css.field} title={hint}><span>{label}</span><span style={{ display: "flex", gap: 6 }}>
    <input type="number" min={0} step="any" inputMode="decimal" value={val} aria-label={label} onChange={(e) => { setVal(e.target.value); onChange(join(e.target.value, unit)); }} placeholder="—" />
    <SelectField value={unit} aria-label={`${label} unit`} style={{ width: 76 }} onChange={(e) => { setUnit(e.target.value); onChange(join(val, e.target.value)); }}>{UNITS.map(([k]) => <option key={k} value={k}>{k === "min" ? "min" : k === "h" ? "hours" : "days"}</option>)}</SelectField></span></label>;
}

export function SopEditor({ initial, mode, roles, holders = {}, evidence }: { initial: Draft; mode: Mode; roles: string[]; holders?: Record<string, Holder[]>; evidence?: string[] }) {
  const router = useRouter();
  const { data: options } = useWorkOptions();
  const [title, setTitle] = useState(initial.title), [purpose, setPurpose] = useState(initial.purpose ?? ""), [ownerRole, setOwnerRole] = useState(initial.ownerRole ?? "");
  const [doc, setDoc] = useState<SopDoc>(initial.doc), [sel, setSel] = useState<string | null>(initial.doc.steps[0]?.id ?? null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [paste, setPaste] = useState(mode.kind === "new" && !initial.doc.steps.length);
  const slotOf = useLaneSlots(doc);
  const people = useMemo(() => Object.fromEntries((options?.people ?? []).map((p) => [p.id, { id: p.id, name: p.name, photoAt: p.photoAt ?? null, pod: p.pod ?? null }])), [options]);
  const allRoles = useMemo(() => [...new Set([...doc.roles, ...roles])], [doc.roles, roles]);
  const phases = useMemo(() => [...new Set(doc.steps.map((s) => s.phase).filter(Boolean))] as string[], [doc.steps]);
  const step = doc.steps.find((s) => s.id === sel) ?? null;
  const index = step ? doc.steps.indexOf(step) : -1;
  const newId = () => { let n = doc.steps.length + 1; while (doc.steps.some((s) => s.id === `s${n}`)) n++; return `s${n}`; };
  const setSteps = (steps: SopStep[]) => setDoc((d) => ({ ...d, steps, roles: [...new Set([...d.roles.filter((r) => steps.some((s) => s.role === r || s.involves.includes(r))), ...steps.map((s) => s.role).filter((r): r is string => !!r)])] }));
  const patch = (p: Partial<SopStep>) => step && setSteps(doc.steps.map((s) => s.id === step.id ? { ...s, ...p } : s));
  const add = (after = index) => { const id = newId(); const base = step ? { role: step.role, phase: step.phase } : {}; const steps = [...doc.steps]; steps.splice(after + 1, 0, emptyStep(id, base)); setSteps(steps); setSel(id); };
  const move = (k: number, by: number) => { const steps = [...doc.steps]; const [x] = steps.splice(k, 1); steps.splice(k + by, 0, x); setSteps(steps); };
  const remove = (id: string) => { const k = doc.steps.findIndex((s) => s.id === id); setSteps(doc.steps.filter((s) => s.id !== id).map((s) => s.next ? { ...s, next: s.next.filter((n) => n.to !== id) } : s)); setSel(doc.steps[k + 1]?.id ?? doc.steps[k - 1]?.id ?? null); };

  async function save(status: "draft" | "active") {
    setBusy(true); setError("");
    const payload = { title: title.trim(), purpose: purpose.trim() || null, ownerRole: ownerRole.trim() || null, doc, status, confidence: initial.confidence ?? null };
    try {
      if (!payload.title) throw new Error("Name the SOP");
      if (mode.kind === "edit") { await post(`sops/${mode.id}`, payload); router.push(`/sops/${mode.id}`); }
      else if (mode.kind === "import") { const r = await post<{ id: string }>(`sops/drive/${mode.sourceId}/import`, { ...payload, part: mode.part }); router.push(`/sops/${r.id}`); }
      else { const r = await post<{ id: string }>("sops", payload); router.push(`/sops/${r.id}`); }
      notify({ id: "sop", tone: "success", title: status === "active" ? "Saved and active" : "Draft saved", timeout: 3000 }); router.refresh();
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }

  return <div className={css.area}>
    {paste ? <PasteBox onUse={(d) => { setTitle(d.title); setPurpose(d.purpose ?? ""); setOwnerRole(d.ownerRole ?? ""); setDoc(d.doc); setSel(d.doc.steps[0]?.id ?? null); setPaste(false); }} onSkip={() => { setPaste(false); if (!doc.steps.length) { const s = emptyStep("s1"); setDoc({ ...doc, steps: [s] }); setSel("s1"); } }} /> : null}
    {!paste ? <div className={css.editor}>
      <div className={css.form}>
        <div className={css.box}>
          <label className={css.field}><span>Name</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Client onboarding" maxLength={200} /></label>
          <label className={css.field}><span>What it is for</span><textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} placeholder="One or two lines: the outcome and when to use it" maxLength={2000} /></label>
          <label className={css.field}><span>Owned by (role)</span><input value={ownerRole} onChange={(e) => setOwnerRole(e.target.value)} list="sop-roles" placeholder="PGS" maxLength={80} /></label>
          {evidence?.length ? <p className={css.hint}><Sparkles size={13} aria-hidden="true" /><span>{initial.confidence != null ? <Confidence value={initial.confidence} /> : null} {evidence.join(" · ")}</span></p> : null}
        </div>
        <div className={css.box}>
          <div className={css.panelHead}><p className={css.sub}>Steps</p><span style={{ display: "flex", gap: 6 }}>{mode.kind === "new" ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setPaste(true)}><ClipboardPaste size={13} aria-hidden="true" />From text</button> : null}
            <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => add(doc.steps.length - 1)}><Plus size={13} aria-hidden="true" />Add a step</button></span></div>
          <ol className={css.stepList}>{doc.steps.map((s, k) => <li key={s.id} className={css.stepItem} data-slot={slotOf(s)} aria-current={sel === s.id ? "true" : undefined}>
            <span className={css.stepNo} style={{ width: 24, height: 24, fontSize: 11 }}>{k + 1}</span>
            <button type="button" onClick={() => setSel(s.id)}><b>{s.title || "Untitled step"}</b><small>{[s.role ?? (s.personId ? people[s.personId]?.name : null) ?? "No owner yet", s.kind !== "task" ? KIND_LABEL[s.kind] : null, s.phase].filter(Boolean).join(" · ")}</small></button>
            <span className={css.moves}><button type="button" aria-label={`Move step ${k + 1} up`} disabled={k === 0} onClick={() => move(k, -1)}><ArrowUp size={13} /></button>
              <button type="button" aria-label={`Move step ${k + 1} down`} disabled={k === doc.steps.length - 1} onClick={() => move(k, 1)}><ArrowDown size={13} /></button></span>
          </li>)}</ol>
        </div>
        {step ? <div className={css.box} aria-label={`Step ${index + 1}`} role="group">
          <div className={css.panelHead}><p className={css.sub}>Step {index + 1}</p><span style={{ display: "flex", gap: 2 }}>
            <button type="button" className={css.iconBtn} aria-label="Add a step after this one" onClick={() => add()}><Plus size={15} /></button>
            <button type="button" className={css.iconBtn} aria-label="Copy this step" onClick={() => { const id = newId(); const steps = [...doc.steps]; steps.splice(index + 1, 0, { ...step, id, next: null }); setSteps(steps); setSel(id); }}><Copy size={14} /></button>
            <button type="button" className={css.iconBtn} aria-label="Remove this step" onClick={() => remove(step.id)}><Trash2 size={14} /></button></span></div>
          <label className={css.field}><span>What happens</span><input value={step.title} onChange={(e) => patch({ title: e.target.value })} placeholder="Client onboarding call" maxLength={200} autoFocus={!step.title} /></label>
          <div className={css.field}><span>Kind</span><span className={css.toggle} role="group" aria-label="Kind of step">{(["task", "decision", "approval", "wait", "end"] as StepKind[]).map((k) =>
            <button key={k} type="button" aria-pressed={step.kind === k} onClick={() => patch({ kind: k, next: (k === "decision" || k === "approval") && !step.next && doc.steps[index + 1] ? [{ to: doc.steps[index + 1].id, label: k === "approval" ? "Approved" : "Yes" }] : step.next })}>{KIND_LABEL[k]}</button>)}</span></div>
          <div className={css.row2}>
            <label className={css.field}><span>Role</span><input value={step.role ?? ""} onChange={(e) => patch({ role: e.target.value || null })} list="sop-roles" placeholder="PGS" maxLength={80} /></label>
            <label className={css.field}><span>Phase</span><input value={step.phase ?? ""} onChange={(e) => patch({ phase: e.target.value || null })} list="sop-phases" placeholder="Optional" maxLength={120} /></label>
          </div>
          {options ? <div className={css.field}><span>A specific person (optional)</span>
            <PersonPicker people={options.people} value={step.personId ? options.people.find((p) => p.id === step.personId) ?? null : null} onChange={(p) => patch({ personId: p?.id ?? null })} me={options.me} label="A specific person" /></div> : null}
          {step.role && holders[step.role]?.length ? <p className={css.hint}>{step.role}: {holders[step.role].map((h) => h.name).slice(0, 5).join(", ")}{holders[step.role].length > 5 ? ` and ${holders[step.role].length - 5} more` : ""}</p> : null}
          <label className={css.field}><span>How (one point per line)</span><textarea value={(step.detail ?? "").replace(/^• /gm, "")} rows={4} onChange={(e) => patch({ detail: e.target.value ? e.target.value.split("\n").map((l) => l.trim() ? `• ${l.replace(/^•\s*/, "")}` : l).join("\n") : null })} placeholder="Share 2–3 options in the client group&#10;Check availability first" /></label>
          <TagInput label="Needs (inputs)" value={step.inputs} onChange={(v) => patch({ inputs: v })} placeholder="Brochure, logo files… Enter to add" />
          <TagInput label="Hands over (outputs)" value={step.outputs} onChange={(v) => patch({ outputs: v })} placeholder="Approved script… Enter to add" />
          <TagInput label="Done well when (KPIs)" value={step.kpis} onChange={(v) => patch({ kpis: v })} placeholder="Client confirmed the date" />
          <div className={css.row2} key={step.id}>
            <TimeField label="Usual work time" hours={step.minutes != null ? step.minutes / 60 : null} onChange={(h) => patch({ minutes: h == null ? null : Math.max(1, Math.round(h * 60)) })} hint="How long the work itself takes" />
            <TimeField label="SLA" hours={step.slaHours} onChange={(h) => patch({ slaHours: h })} hint="How long it may take from start to done" />
          </div>
          <Connections step={step} doc={doc} onChange={(next) => patch({ next })} />
          <Links step={step} onChange={(links) => patch({ links })} />
        </div> : null}
        <div className={css.footer}>
          <span>{error ? <span className={css.error} role="alert">{error}</span> : `${doc.steps.length} step${doc.steps.length === 1 ? "" : "s"}`}</span>
          <button type="button" className={styles.btn} disabled={busy} onClick={() => router.back()}>Cancel</button>
          <button type="button" className={styles.btn} disabled={busy} onClick={() => void save("draft")}>Save draft</button>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !doc.steps.length} onClick={() => void save("active")}>{mode.kind === "import" ? "Bring in as active" : "Save and make active"}</button>
        </div>
      </div>
      <div className={css.editorFlow}>{doc.steps.length ? <FlowCanvas steps={doc.steps} people={holders} persons={people} selected={sel} onSelect={(id) => id && setSel(id)} label="Preview of the flow" /> : null}</div>
    </div> : null}
    <datalist id="sop-roles">{allRoles.map((r) => <option key={r} value={r} />)}</datalist>
    <datalist id="sop-phases">{phases.map((p) => <option key={p} value={p} />)}</datalist>
  </div>;
}

/** Where a step goes: on to the next one (the default), or chosen branches with a label each. */
function Connections({ step, doc, onChange }: { step: SopStep; doc: SopDoc; onChange: (next: SopStep["next"]) => void }) {
  const others = doc.steps.filter((s) => s.id !== step.id); const k = doc.steps.indexOf(step);
  const custom = step.next !== null;
  return <div className={css.field}><span>Then</span>
    <span className={css.toggle} role="group" aria-label="Where it goes">
      <button type="button" aria-pressed={!custom} onClick={() => onChange(null)}>{doc.steps[k + 1] ? "The next step" : "It ends"}</button>
      <button type="button" aria-pressed={custom} onClick={() => onChange(step.next ?? (doc.steps[k + 1] ? [{ to: doc.steps[k + 1].id, label: null }] : []))}>Choose</button></span>
    {custom ? <div className={css.nextList}>{(step.next ?? []).map((n, i) => <div key={i}>
      <SelectField value={n.to} aria-label={`Branch ${i + 1} goes to`} onChange={(e) => onChange(step.next!.map((x, j) => j === i ? { ...x, to: e.target.value } : x))}>
        {others.map((s) => <option key={s.id} value={s.id}>{doc.steps.indexOf(s) + 1}. {s.title || "Untitled"}</option>)}</SelectField>
      <input value={n.label ?? ""} placeholder={step.kind === "approval" ? "Approved / Send back" : "Label (Yes, No…)"} aria-label={`Branch ${i + 1} label`} maxLength={60} onChange={(e) => onChange(step.next!.map((x, j) => j === i ? { ...x, label: e.target.value || null } : x))} />
      <button type="button" className={css.iconBtn} aria-label={`Remove branch ${i + 1}`} onClick={() => onChange(step.next!.filter((_, j) => j !== i))}><X size={14} /></button></div>)}
      {others.length ? <button type="button" className={css.linkBtn} onClick={() => onChange([...(step.next ?? []), { to: others[0].id, label: null }])}><Plus size={13} aria-hidden="true" />Add a branch</button> : null}
      {!step.next?.length ? <p className={css.hint}>No branches: the flow ends at this step.</p> : null}</div> : null}
  </div>;
}

export function Links({ step, onChange }: { step: SopStep; onChange: (l: SopStep["links"]) => void }) {
  const [label, setLabel] = useState(""), [url, setUrl] = useState("");
  const ok = /^(https:\/\/|\/[^/])/.test(url.trim());
  return <div className={css.field}><span>Templates and links</span>
    {step.links.map((l, i) => <span key={i} className={css.chips}><span className={css.chip}>{l.label}</span><button type="button" className={css.iconBtn} aria-label={`Remove ${l.label}`} onClick={() => onChange(step.links.filter((_, j) => j !== i))}><X size={13} /></button></span>)}
    <span style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr) auto", gap: 6 }}>
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Brief template" aria-label="Link name" maxLength={80} />
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.google.com/…" aria-label="Link address" maxLength={500} />
      <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!ok} onClick={() => { onChange([...step.links, { label: label.trim() || url.trim(), url: url.trim() }]); setLabel(""); setUrl(""); }}>Add</button></span></div>;
}

type Parsed = { title: string; purpose: string | null; ownerRole: string | null; doc: SopDoc; confidence: number; confidenceWords: string; evidence: string[]; steps: number };
/** Paste an SOP written for people; Pulse reads it into steps and roles to start from. */
function PasteBox({ onUse, onSkip }: { onUse: (d: Draft) => void; onSkip: () => void }) {
  const [title, setTitle] = useState(""), [text, setText] = useState(""), [parts, setParts] = useState<Parsed[] | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function read() {
    setBusy(true); setError(""); try { const r = await post<{ parts: Parsed[] }>("sops/parse", { title: title || "Pasted SOP", text }); setParts(r.parts); if (!r.parts.length) setError("Pulse found no steps in that text. Number the steps (1., 2., …) or start from scratch."); }
    catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  return <div className={css.box} style={{ maxWidth: 880 }}>
    <div className={css.panelHead}><div><h3 style={{ margin: 0, fontSize: 16 }}>Start from a document</h3><small style={{ color: "var(--theme-text-muted)", fontSize: 13 }}>Paste an SOP as written (from a Google Doc, Word or a chat). Pulse reads the steps, who does them, inputs, outputs and times. You check and edit before saving.</small></div></div>
    <label className={css.field}><span>Name</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Shoot coordination" maxLength={200} /></label>
    <label className={css.field}><span>The SOP text</span><textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} placeholder={"1. Sample flat check\n   * Confirm the sample flat is ready\n2. Model shortlisting (Coordinator)\n   * Share 2–3 options in the client group within 24 hours"} /></label>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    {parts?.length ? <ul className={css.sources}>{parts.map((p, i) => <li key={i} className={css.part}>
      <h4>{p.title}<Confidence value={p.confidence} words={p.confidenceWords} /></h4>
      <span className={css.partActions}><button type="button" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} onClick={() => onUse({ title: p.title, purpose: p.purpose, ownerRole: p.ownerRole, doc: p.doc, confidence: p.confidence })}>Use these {p.steps} steps</button></span>
      <p className={css.evidence}>{p.evidence.join(" · ")}</p>
      <ol>{p.doc.steps.slice(0, 8).map((s) => <li key={s.id}>{s.title}{s.role ? <small>· {s.role}</small> : null}</li>)}</ol></li>)}</ul> : null}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || text.trim().length < 20} onClick={() => void read()}><Sparkles size={14} aria-hidden="true" />Read the steps</button>
      <button type="button" className={styles.btn} onClick={onSkip}>Write it step by step instead</button></div>
  </div>;
}
