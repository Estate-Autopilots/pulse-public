"use client";
// WORKFLOW BUILDER: one block, in the kit Drawer (a panel on the right on a computer, a sheet from the bottom on a
// phone). What the block is and how much of it is built; who does it; its form, wait or hand-off; the SOP inside it
// (its checklist, one line each); what goes in and out, and its wires (with a way to wire it without dragging).
import { useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { ContextChip, Drawer, DrawerFooter, DrawerSection, PersonSelect, type PickPerson } from "../kit";
import { useWorkOptions } from "../create";
import { checklistOf, detailOf, outType, specOf } from "../lib/wf-canvas.mjs";
import { styles } from "../ui";
import { ENGINE_WORD, TYPE_SLOT, type BlockSpec, type BlockStep, type BoardDetail, type Tab } from "./board-types";
import { ASSIGN_LABEL, type AssignBy, type Condition } from "./types";
import css from "./blocks.module.css";

const OPS: [Condition["op"], string][] = [["gt", "is more than"], ["gte", "is at least"], ["lt", "is less than"], ["lte", "is at most"], ["eq", "is"], ["ne", "is not"], ["contains", "contains"], ["filled", "is filled in"], ["empty", "is empty"]];

export function BlockPanel({ data, tab, step, steps, byModule, who, onClose, onPatch, onRemove, onWire, onUnwire, tabName }: {
  data: BoardDetail; tab: Tab; step: BlockStep; steps: BlockStep[]; byModule: Record<string, BlockSpec>; who: string; onClose: () => void;
  onPatch: (p: Partial<BlockStep>) => void; onRemove: () => void; onWire: (from: string, port: string | null, to: string, inKey: string | null) => void;
  onUnwire: (from: string, index: number) => void; tabName: (id: string | undefined) => string | null;
}) {
  const spec = specOf(step as never, byModule);
  const { data: options } = useWorkOptions();
  const people = useMemo(() => (options?.people ?? []).map((p) => ({ id: p.id, name: p.name, photoAt: p.photoAt ?? null, pod: p.pod ?? null, role: p.role ?? null })) as PickPerson[], [options]);
  const roles = useMemo(() => [...new Set([...Object.keys(data.people), ...steps.map((s) => s.role).filter((r): r is string => !!r), ...(tab.tabRole ? [tab.tabRole] : [])])], [data.people, steps, tab.tabRole]);
  const lines = checklistOf(step.detail);
  const setLines = (l: string[]) => onPatch({ detail: detailOf(l) ?? null });
  const [draftLine, setDraftLine] = useState("");
  const [port, setPort] = useState(spec.outputs[0]?.key ?? ""), [target, setTarget] = useState("");
  const person = spec.engine !== "auto" && step.kind !== "wait" && step.kind !== "end";
  const forms = spec.module === "site_visit" ? [...data.forms.filter((f) => f.photo), ...data.forms.filter((f) => !f.photo)] : data.forms;
  const fields = useMemo(() => [...new Set(["record.project", "record.client", "record.status", ...steps.flatMap((s) => {
    const f = data.forms.find((x) => x.id === s.formId); const o = specOf(s as never, byModule).outputs.filter((x) => x.type !== "any").map((x) => `${s.id}.${x.key}`);
    return [...o, ...(f ? f.fields.filter((x) => x.type !== "photo" && x.type !== "signature").map((x) => `${s.id}.${x.key}`) : [])]; })])], [steps, data.forms, byModule]);
  const assignBy = (by: AssignBy) => onPatch({ assign: by === "role" ? { by, role: step.assign.role ?? step.role ?? tab.tabRole ?? "" } : by === "person" ? { by, personId: step.assign.personId ?? tab.tabPersonId ?? null } : by === "pool" ? { by, scope: "company" } : { by } });
  const wiresOut = (step.next ?? []).map((n, i) => ({ n, i, to: steps.find((s) => s.id === n.to) }));
  const others = steps.filter((s) => s.id !== step.id && specOf(s as never, byModule).inputs.length);
  const slot = (t: keyof typeof TYPE_SLOT) => css[`t${TYPE_SLOT[t]}`];

  return <Drawer title={step.title || spec.label} onClose={onClose} size="md" help={<>{spec.what} {spec.status}</>}
    context={<><ContextChip>{spec.label}</ContextChip><ContextChip>{ENGINE_WORD[spec.engine]}</ContextChip><ContextChip>{who}</ContextChip></>}
    footer={<DrawerFooter><button type="button" className={styles.btn} onClick={onRemove}><Trash2 size={14} aria-hidden="true" />Remove the block</button>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onClose}>Done</button></DrawerFooter>}>
    <div className={css.vars} style={{ display: "contents" }}>
      <DrawerSection title="Block">
        <label className={css.field}><span>Name</span><input value={step.title} maxLength={200} onChange={(e) => onPatch({ title: e.target.value })} /></label>
        <p className={css.note} data-tone={spec.engine === "stub" ? "stub" : undefined}>{spec.status}</p>
        {spec.link ? <p className={css.note}>Its task opens <b>{spec.module === "tax_invoice" ? "Billing → a new invoice" : "Billing → a new quotation"}</b> for the run’s project.</p> : null}
      </DrawerSection>

      {person ? <DrawerSection title="Who does it" help="Each run gives this block to the person these rules pick: people on the run's project first, then whoever has the fewest open tasks.">
        <label className={css.field}><span>Who</span><select value={step.assign.by} onChange={(e) => assignBy(e.target.value as AssignBy)}>
          {(Object.keys(ASSIGN_LABEL) as AssignBy[]).map((k) => <option key={k} value={k}>{ASSIGN_LABEL[k]}</option>)}</select></label>
        {step.assign.by === "role" ? <label className={css.field}><span>Role</span><input value={step.assign.role ?? ""} list="wf-board-roles" maxLength={80} placeholder="Sales"
          onChange={(e) => onPatch({ assign: { by: "role", role: e.target.value }, role: e.target.value || null })} />
          <datalist id="wf-board-roles">{roles.map((r) => <option key={r} value={r} />)}</datalist>
          {data.people[step.assign.role ?? ""]?.length ? <small className={css.note}>Held by {data.people[step.assign.role ?? ""].map((h) => h.name).join(", ")}</small> : step.assign.role ? <small className={css.note}>Nobody holds this role yet: save, and the people list fills in.</small> : null}</label> : null}
        {step.assign.by === "person" ? <div className={css.field}><span>Person</span><PersonSelect label="Person" people={people} value={step.assign.personId ?? null} onChange={(p) => onPatch({ assign: { by: "person", personId: p?.id ?? null }, personId: p?.id ?? null })} /></div> : null}
        {step.assign.by === "domain" ? <label className={css.field}><span>Whose domains cover</span><select value={step.assign.category ?? ""} onChange={(e) => onPatch({ assign: { by: "domain", category: e.target.value || null } })}>
          <option value="">Choose a kind of work</option>{data.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label> : null}
        <label className={css.field}><span>SLA (hours from start to done)</span><input type="number" min={0.25} step={0.25} value={step.slaHours ?? ""} inputMode="decimal"
          onChange={(e) => onPatch({ slaHours: e.target.value ? Number(e.target.value) : null })} placeholder="None" /></label>
      </DrawerSection> : null}

      {step.kind === "wait" ? <DrawerSection title="Wait"><label className={css.field}><span>Hours</span><input type="number" min={0.25} step={0.25} value={step.waitHours ?? 24} inputMode="decimal"
        onChange={(e) => onPatch({ waitHours: e.target.value ? Number(e.target.value) : 24 })} /></label></DrawerSection> : null}

      {spec.needsForm ? <DrawerSection title="Form" help="Sending the form finishes the block; its answers join the run's values.">
        <label className={css.field}><span>The form to fill</span><select value={step.formId ?? ""} onChange={(e) => onPatch({ formId: e.target.value || null })}>
          <option value="">{forms.length ? "Choose a form" : "No live forms yet"}</option>{forms.map((f) => <option key={f.id} value={f.id}>{f.name}{f.photo ? " · camera" : ""}</option>)}</select></label>
        {!step.formId ? <p className={css.note} data-tone="stub">Without a form this block is a plain task. Forms → Templates has a Site visit and the solar installation forms.</p> : null}
      </DrawerSection> : null}

      {spec.module === "handoff" ? <DrawerSection title="Passes the work to" help="The run of that tab starts at once, with this run's project, client and values. In a test run, a test run starts.">
        <label className={css.field}><span>Tab</span><select value={step.handoff?.workflowId ?? ""} onChange={(e) => onPatch({ handoff: e.target.value ? { workflowId: e.target.value } : null })}>
          <option value="">Choose the tab</option>
          <optgroup label="On this board">{data.tabs.filter((t) => t.id !== tab.id).map((t) => <option key={t.id} value={t.id}>{tabName(t.id)}</option>)}</optgroup>
          <optgroup label="Other workflows">{data.workflows.filter((w) => !data.tabs.some((t) => t.id === w.id)).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</optgroup></select></label>
        <p className={css.note}>A live run hands over only to a published tab.</p>
      </DrawerSection> : null}

      {step.kind === "decision" ? <DrawerSection title="Which way" help="The first way whose condition holds is taken; with no condition that holds, the person doing it chooses.">
        {wiresOut.map(({ n, i, to }) => <div key={i} className={css.field}><span>{n.label ?? "A way"} → {to?.title ?? "?"}</span>
          {n.when ? <div className={css.row2}>
            <input list="wf-board-fields" value={n.when.field} aria-label="Value" onChange={(e) => onPatch({ next: (step.next ?? []).map((x, j) => j === i ? { ...x, when: { ...x.when!, field: e.target.value } } : x) })} />
            <select value={n.when.op} aria-label="Test" onChange={(e) => onPatch({ next: (step.next ?? []).map((x, j) => j === i ? { ...x, when: { ...x.when!, op: e.target.value as Condition["op"] } } : x) })}>
              {OPS.map(([o, l]) => <option key={o} value={o}>{l}</option>)}</select>
            {!["filled", "empty"].includes(n.when.op) ? <input value={String(n.when.value ?? "")} aria-label="Compared with" onChange={(e) => onPatch({ next: (step.next ?? []).map((x, j) => j === i ? { ...x, when: { ...x.when!, value: e.target.value } } : x) })} /> : null}
            <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => onPatch({ next: (step.next ?? []).map((x, j) => j === i ? { ...x, when: null } : x) })}>No condition</button></div>
            : <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => onPatch({ next: (step.next ?? []).map((x, j) => j === i ? { ...x, when: { field: fields[0] ?? "", op: "gt" as Condition["op"], value: "" } } : x) })}>Add a condition</button>}
        </div>)}
        <datalist id="wf-board-fields">{fields.map((f) => <option key={f} value={f} />)}</datalist>
      </DrawerSection> : null}

      <DrawerSection title="SOP inside this block" help="The checklist the person follows in this step. Each line can be ticked on the step while it waits for them.">
        <ol className={css.checklist}>{lines.map((l, i) => <li key={i}>
          <input type="text" value={l} aria-label={`Line ${i + 1}`} maxLength={300} onChange={(e) => setLines(lines.map((x, j) => j === i ? e.target.value : x))} />
          <button type="button" className={css.iconBtn} aria-label={`Remove line ${i + 1}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}><X size={14} /></button></li>)}
          <li><input type="text" value={draftLine} placeholder="Add a line, then Enter" aria-label="New line" maxLength={300} onChange={(e) => setDraftLine(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && draftLine.trim()) { e.preventDefault(); setLines([...lines, draftLine.trim()]); setDraftLine(""); } }} />
            <button type="button" className={css.iconBtn} aria-label="Add the line" disabled={!draftLine.trim()} onClick={() => { setLines([...lines, draftLine.trim()]); setDraftLine(""); }}><Plus size={14} /></button></li></ol>
      </DrawerSection>

      <DrawerSection title="In and out">
        <div className={css.field}><span>Takes in</span><span className={css.io}>{spec.inputs.length ? spec.inputs.map((p) => <span key={p.key} className={`${css.chip} ${slot(p.type)}`}><i />{p.label} · {data.types[p.type]}</span>) : <span className={css.note}>Nothing: it starts a run</span>}</span></div>
        <div className={css.field}><span>Gives out</span><span className={css.io}>{spec.outputs.length ? spec.outputs.map((p) => { const t = p.type === "any" ? outType(steps as never, byModule, step.id, p.key) : p.type;
          return <span key={p.key} className={`${css.chip} ${slot(t)}`}><i />{p.label} · {data.types[t]}</span>; }) : <span className={css.note}>{spec.module === "handoff" ? `The work, to ${tabName(step.handoff?.workflowId) ?? "the tab you choose"}` : "Nothing: the run ends"}</span>}</span></div>
        {wiresOut.length ? <ul className={css.links}>{wiresOut.map(({ n, i, to }) => <li key={i}><span>{spec.outputs.find((o) => o.key === n.port)?.label ?? n.label ?? "Out"} → {to?.title ?? "?"}</span>
          <button type="button" className={css.iconBtn} aria-label={`Remove the wire to ${to?.title ?? "that block"}`} onClick={() => onUnwire(step.id, i)}><X size={14} /></button></li>)}</ul> : null}
        {spec.outputs.length && others.length ? <div className={css.row2}>
          <label className={css.field}><span>Wire an output</span><select value={port} onChange={(e) => setPort(e.target.value)}>{spec.outputs.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</select></label>
          <label className={css.field}><span>To</span><select value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Choose a block</option>{others.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={!target} onClick={() => { onWire(step.id, port || null, target, null); setTarget(""); }}><Plus size={12} aria-hidden="true" />Wire</button></div> : null}
      </DrawerSection>
    </div>
  </Drawer>;
}
