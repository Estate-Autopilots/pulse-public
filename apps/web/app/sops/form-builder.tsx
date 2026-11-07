"use client";
// SOP-WORKFLOW part 3: build a field form. Fields on the left (add by type, reorder, what each needs); the phone on the
// right shows the form exactly as it will be filled. Leadership saves, makes it live, or archives it.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Rocket, Trash2 } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { ProjectPicker, useWorkOptions } from "../create";
import { post } from "../records";
import { styles } from "../ui";
import { FormFill } from "./fill";
import { FIELD_TYPE_LABEL, type FieldType, type FormDetail, type FormField } from "./types";
import f from "./forms.module.css";
import css from "./sops.module.css";
import { SelectField } from "../kit/select-field";

const msg = (e: unknown) => e instanceof Error ? e.message : "Could not save";
const keyOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "field";
const blank = (type: FieldType, n: number): FormField => ({ key: "", label: type === "photo" ? "Photo" : `${FIELD_TYPE_LABEL[type]} ${n}`, type, required: true, help: null,
  ...(["select", "multi", "checklist"].includes(type) ? { options: ["First", "Second"] } : {}), ...(type === "photo" ? { min: 1, max: 4, geotag: true, stamp: true } : {}) });

export function FormBuilder({ data }: { data: FormDetail }) {
  const router = useRouter(); const form = data.form;
  const [name, setName] = useState(form.name), [purpose, setPurpose] = useState(form.purpose ?? ""), [fields, setFields] = useState<FormField[]>(form.fields);
  const [sel, setSel] = useState(0), [adding, setAdding] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [dirty, setDirty] = useState(false);
  const change = (next: FormField[]) => { setFields(next); setDirty(true); };
  const patch = (i: number, p: Partial<FormField>) => change(fields.map((x, j) => j === i ? { ...x, ...p } : x));
  const move = (i: number, by: number) => { const next = [...fields]; const [x] = next.splice(i, 1); next.splice(i + by, 0, x); change(next); setSel(i + by); };
  const keyed = fields.map((x) => ({ ...x, key: x.key || keyOf(x.label) }));
  async function save(status?: "live" | "archived") {
    setBusy(true); setError("");
    try {
      await post(`forms/${form.id}`, { name, purpose: purpose || null, fields: keyed, clientId: form.clientId });
      if (status) await post(`forms/${form.id}/status`, { status });
      setDirty(false); notify({ id: "form", tone: "success", title: status === "live" ? "Live: workflows and people can use it" : "Saved", timeout: 3000 }); router.refresh();
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  const x = fields[sel];
  return <div className={f.builder}>
    <div className={css.form}>
      <div className={css.box}>
        <label className={css.field}><span>Name</span><input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} maxLength={200} /></label>
        <label className={css.field}><span>When it is filled</span><textarea rows={2} value={purpose} onChange={(e) => { setPurpose(e.target.value); setDirty(true); }} maxLength={1000} placeholder="On arrival at the customer's site" /></label>
      </div>
      <div className={css.box}>
        <div className={css.panelHead}><p className={css.sub}>Fields</p><button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setAdding(!adding)}><Plus size={13} aria-hidden="true" />Add a field</button></div>
        {adding ? <div className={f.typeMenu} role="group" aria-label="Kind of field">{(Object.keys(FIELD_TYPE_LABEL) as FieldType[]).map((t) =>
          <button key={t} type="button" onClick={() => { change([...fields, blank(t, fields.length + 1)]); setSel(fields.length); setAdding(false); }}>{FIELD_TYPE_LABEL[t]}</button>)}</div> : null}
        <ol className={f.fields}>{fields.map((fd, i) => <li key={i} className={f.fieldCard} aria-current={sel === i ? "true" : undefined}>
          <div className={f.fieldTop}><button type="button" onClick={() => setSel(i)}><b>{fd.label || "Untitled"}</b><small>{FIELD_TYPE_LABEL[fd.type]}{fd.required ? " · required" : ""}</small></button>
            <span className={css.moves}><button type="button" aria-label={`Move ${fd.label} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={13} /></button>
              <button type="button" aria-label={`Move ${fd.label} down`} disabled={i === fields.length - 1} onClick={() => move(i, 1)}><ArrowDown size={13} /></button>
              <button type="button" aria-label={`Remove ${fd.label}`} onClick={() => { change(fields.filter((_, j) => j !== i)); setSel(Math.max(0, i - 1)); }}><Trash2 size={13} /></button></span></div>
          {sel === i && x ? <FieldEditor field={x} onChange={(p) => patch(i, p)} /> : null}
        </li>)}</ol>
      </div>
      <div className={css.footer}>
        <span>{error ? <span className={css.error} role="alert">{error}</span> : dirty ? "Unsaved changes" : form.status === "live" ? `Live · version ${form.version}` : form.status === "draft" ? "Draft" : "Archived"}</span>
        <button type="button" className={styles.btn} disabled={busy || !dirty} onClick={() => void save()}>Save</button>
        {form.status !== "live" ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !fields.length} onClick={() => void save("live")}><Rocket size={14} aria-hidden="true" />Make it live</button>
          : <button type="button" className={styles.btn} disabled={busy} onClick={() => void save("archived")}>Archive</button>}
      </div>
    </div>
    <div className={f.phone}><p>On the phone</p><FormFill form={{ id: form.id, name, purpose, fields: keyed, live: true }} preview /></div>
  </div>;
}

function FieldEditor({ field: x, onChange }: { field: FormField; onChange: (p: Partial<FormField>) => void }) {
  const choice = ["select", "multi", "checklist"].includes(x.type);
  return <div className={css.form}>
    <label className={css.field}><span>Question or label</span><input value={x.label} onChange={(e) => onChange({ label: e.target.value })} maxLength={120} /></label>
    <div className={f.row}>
      <label className={css.field}><span>Kind</span><SelectField value={x.type} onChange={(e) => { const t = e.target.value as FieldType; onChange({ type: t, ...(["select", "multi", "checklist"].includes(t) && !x.options?.length ? { options: ["First", "Second"] } : {}), ...(t === "photo" ? { min: 1, max: 4, geotag: true, stamp: true } : {}) }); }}>
        {(Object.keys(FIELD_TYPE_LABEL) as FieldType[]).map((t) => <option key={t} value={t}>{FIELD_TYPE_LABEL[t]}</option>)}</SelectField></label>
      <label className={css.check} style={{ alignSelf: "end", minHeight: 38 }}><input type="checkbox" checked={x.required} onChange={(e) => onChange({ required: e.target.checked })} />Required</label>
    </div>
    <label className={css.field}><span>Help (optional)</span><input value={x.help ?? ""} onChange={(e) => onChange({ help: e.target.value || null })} maxLength={300} placeholder="What a good answer looks like" /></label>
    {choice ? <label className={css.field}><span>Choices (one per line)</span><textarea rows={4} value={(x.options ?? []).join("\n")} onChange={(e) => onChange({ options: e.target.value.split("\n") })} /></label> : null}
    {x.type === "number" ? <div className={f.row}>
      <label className={css.field}><span>Unit</span><input value={x.unit ?? ""} onChange={(e) => onChange({ unit: e.target.value || null })} placeholder="kW" maxLength={20} /></label>
      <label className={css.field}><span>Least</span><input type="number" value={x.min ?? ""} onChange={(e) => onChange({ min: e.target.value === "" ? null : Number(e.target.value) })} /></label>
      <label className={css.field}><span>Most</span><input type="number" value={x.max ?? ""} onChange={(e) => onChange({ max: e.target.value === "" ? null : Number(e.target.value) })} /></label>
      <label className={css.field}><span>Decimals</span><input type="number" min={0} max={4} value={x.decimals ?? 0} onChange={(e) => onChange({ decimals: Number(e.target.value) })} /></label></div> : null}
    {x.type === "photo" ? <><div className={f.row}>
      <label className={css.field}><span>At least</span><input type="number" min={0} max={10} value={x.min ?? 1} onChange={(e) => onChange({ min: Number(e.target.value) })} /></label>
      <label className={css.field}><span>At most</span><input type="number" min={1} max={10} value={x.max ?? 4} onChange={(e) => onChange({ max: Number(e.target.value) })} /></label></div>
      <label className={css.check}><input type="checkbox" checked={x.geotag !== false} onChange={(e) => onChange({ geotag: e.target.checked })} />Record where it was taken</label>
      <label className={css.check}><input type="checkbox" checked={x.stamp !== false} onChange={(e) => onChange({ stamp: e.target.checked })} />Stamp the time (and place) on the photo</label>
      <p className={css.hint}>Photos come from the camera only: the phone opens it, and pictures from the gallery are refused.</p></> : null}
    {x.type === "longtext" ? <label className={css.check}><input type="checkbox" checked={!!x.lines} onChange={(e) => onChange({ lines: e.target.checked })} />One item per line (serial numbers, a list)</label> : null}
  </div>;
}

/** The project a standalone form is filled for (optional). */
export function ProjectChoice({ formId, value }: { formId: string; value: string | null }) {
  const router = useRouter(); const { data } = useWorkOptions();
  if (!data) return null;
  return <div className={css.field}><span>For the project (optional)</span><ProjectPicker projects={data.projects} value={value} onChange={(p) => router.replace(`/sops/forms/${formId}/fill${p ? `?project=${p}` : ""}`)} label="Project" /></div>;
}
