"use client";
// FLOW-C: typed records inside the work (personas, competitors, USPs, facts with their source and status, words, ideas,
// talent, consent …): each a card with its key fields and its status, moved along the type's own status machine; a form
// built from the type's fields to add or change one. Any company's own record types draw the same way.
import { useState } from "react";
import { Pencil, Plus, X } from "lucide-react";
import { styles } from "../ui";
import type { FlowRecord, PersonRef, RecordField, RecordType } from "../processes/flow-types";
import type { Work } from "./work";
import { dayText, str, strList } from "./types";
import css from "./work.module.css";
import { DateField } from "../kit/date-field";
import { SelectField } from "../kit/select-field";

type Data = Record<string, unknown>;

/** The run's records of one type, with Add. `stepKey` marks the ones this step makes (its output). */
export function RecordsInline({ w, type, title, note, compact }: { w: Work; type: string; title?: string; note?: string; compact?: boolean }) {
  const t = w.types.find((x) => x.key === type);
  const [adding, setAdding] = useState(false);
  if (!t) return null;
  const mine = w.runRecords.filter((r) => r.type === type);
  const editable = w.d.canAct && w.d.run.status === "running";
  return <section className={css.records} aria-label={title ?? t.plural}>
    <h4>{title ?? t.plural}<small>{mine.length || "none yet"}</small>
      {editable && !adding ? <button type="button" className={css.addBtn} onClick={() => setAdding(true)}><Plus size={13} aria-hidden="true" />Add {t.name.toLowerCase()}</button> : null}</h4>
    {note ? <p className={css.quiet}>{note}</p> : null}
    {adding ? <RecordForm w={w} t={t} onDone={() => setAdding(false)} /> : null}
    {mine.length ? <ul className={css.recordList} data-compact={compact ? "" : undefined}>{mine.map((r) => <li key={r.id}><RecordCard w={w} t={t} r={r} editable={editable} /></li>)}</ul>
      : !adding ? <p className={css.quiet}>{t.summary}</p> : null}
  </section>;
}

export function RecordCard({ w, t, r, editable }: { w: Work; t: RecordType; r: FlowRecord; editable: boolean }) {
  const [edit, setEdit] = useState(false);
  const status = t.statuses.find((s) => s.key === r.status);
  const shown = t.fields.filter((f) => f.key !== t.titleField && !["json"].includes(f.type) && r.data[f.key] !== undefined && r.data[f.key] !== null && r.data[f.key] !== "" && !(Array.isArray(r.data[f.key]) && !(r.data[f.key] as unknown[]).length)).slice(0, 6);
  if (edit) return <RecordForm w={w} t={t} r={r} onDone={() => setEdit(false)} />;
  return <article className={css.recordCard} data-tone={status?.tone ?? "neutral"}>
    <header><b>{r.code ? <code>{r.code}</code> : null}{r.title}</b>
      <span className={css.chip} data-tone={status?.tone ?? "neutral"}>{status?.label ?? r.statusLabel}</span>
      {editable && !r.frozenAt ? <button type="button" className={css.iconBtn} aria-label={`Change ${r.title}`} title="Change" onClick={() => setEdit(true)}><Pencil size={13} /></button> : null}</header>
    {shown.length ? <dl>{shown.map((f) => <div key={f.key}><dt>{f.label}</dt><dd>{valueText(f, r.data[f.key], w)}</dd></div>)}</dl> : null}
    {editable && status?.next.length ? <div className={css.moves}>{status.next.map((n) => { const to = t.statuses.find((s) => s.key === n);
      return <button key={n} type="button" disabled={w.busy} data-tone={to?.tone ?? "neutral"} onClick={() => void w.act(`records/${r.id}/status`, { status: n }, `${t.name}: ${to?.label ?? n}`)}>{to?.label ?? n}</button>; })}</div> : null}
    {r.stepKey && r.stepKey !== w.d.step.key ? <small className={css.from}>From step {r.stepKey}</small> : null}
  </article>;
}

/** The records as a table (a message sequence reads best this way): one row each, one column per field, the status last. */
export function RecordTable({ w, t, rows, editable }: { w: Work; t: RecordType; rows: FlowRecord[]; editable: boolean }) {
  const [edit, setEdit] = useState<string | null>(null);
  const cols = t.fields.filter((f) => f.type !== "json");
  const sorted = [...rows].sort((a, z) => `${str(a.data.track)}:${String(a.data.day ?? "").padStart(4, "0")}:${a.title}`.localeCompare(`${str(z.data.track)}:${String(z.data.day ?? "").padStart(4, "0")}:${z.title}`));
  return <div className={css.tableWrap} role="region" aria-label={`${t.plural} table`} tabIndex={0}><table className={css.table}>
    <thead><tr>{cols.map((f) => <th key={f.key} scope="col">{f.label}</th>)}<th scope="col">Status</th>{editable ? <th scope="col"><span className={css.srOnly}>Change</span></th> : null}</tr></thead>
    <tbody>{sorted.map((r) => { const st = t.statuses.find((x) => x.key === r.status);
      return edit === r.id ? <tr key={r.id}><td colSpan={cols.length + 2}><RecordForm w={w} t={t} r={r} onDone={() => setEdit(null)} /></td></tr>
        : <tr key={r.id}>{cols.map((f) => <td key={f.key} data-long={f.type === "longtext" ? "" : undefined}>{r.data[f.key] === undefined || r.data[f.key] === null || r.data[f.key] === "" ? "" : valueText(f, r.data[f.key], w)}</td>)}
          <td><span className={css.chip} data-tone={st?.tone ?? "neutral"}>{st?.label ?? r.statusLabel}</span></td>
          {editable ? <td><button type="button" className={css.iconBtn} aria-label={`Change ${r.title}`} onClick={() => setEdit(r.id)}><Pencil size={13} /></button></td> : null}</tr>; })}</tbody>
  </table></div>;
}

function valueText(f: RecordField, v: unknown, w: Work): string {
  if (f.type === "boolean") return v ? "Yes" : "No";
  if (f.type === "date") return dayText(str(v));
  if (f.type === "list" || f.type === "multi") return strList(v).join(" · ");
  if (f.type === "record") return w.runRecords.find((x) => x.id === v)?.title ?? "Linked";
  if (f.type === "person") return peopleOf(w).find((p) => p.id === v)?.name ?? "Someone";
  return str(v);
}

/** The people named on the run (with a person behind them), for owner fields. */
export function peopleOf(w: Work): PersonRef[] {
  const seen = new Map<string, PersonRef>();
  for (const p of Object.values(w.d.run.people)) if (p && "id" in p && p.id) seen.set(p.id, p);
  if (w.d.step.who?.id) seen.set(w.d.step.who.id, w.d.step.who);
  return [...seen.values()];
}

export function RecordForm({ w, t, r, onDone, stepKey, extra }: { w: Work; t: RecordType; r?: FlowRecord; onDone: () => void; stepKey?: string; extra?: Data }) {
  const [data, setData] = useState<Data>(() => ({ ...(r?.data ?? {}) }));
  const fields = t.fields.filter((f) => f.type !== "json");
  const missing = fields.filter((f) => f.required && (data[f.key] === undefined || data[f.key] === "" || (Array.isArray(data[f.key]) && !(data[f.key] as unknown[]).length)));
  const set = (k: string, v: unknown) => setData((x) => ({ ...x, [k]: v }));
  async function save() {
    const clean = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, fields.some((f) => f.key === k && f.type === "list") ? strList(v).map((x) => x.trim()).filter(Boolean) : v]));
    const ok = r ? await w.act(`records/${r.id}`, { data: clean }, `${t.name} saved`)
      : await w.act("records", { type: t.key, runId: w.d.run.id, stepKey: stepKey ?? w.d.step.key, data: { ...clean, ...(extra ?? {}) } }, `${t.name} added`);
    if (ok) onDone();
  }
  return <form className={css.recordForm} onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label={r ? `Change ${r.title}` : `New ${t.name.toLowerCase()}`}>
    <header><b>{r ? `Change ${t.name.toLowerCase()}` : `New ${t.name.toLowerCase()}`}</b><button type="button" className={css.iconBtn} aria-label="Close" onClick={onDone}><X size={14} /></button></header>
    <div className={css.fields}>{fields.map((f) => <Field key={f.key} f={f} value={data[f.key]} onChange={(v) => set(f.key, v)} w={w} />)}</div>
    <footer>{missing.length ? <small>Still to fill: {missing.map((f) => f.label).join(", ")}</small> : <small />}
      <button type="button" className={styles.btn} onClick={onDone}>Cancel</button>
      <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={w.busy || missing.length > 0}>{r ? "Save" : "Add"}</button></footer>
  </form>;
}

function Field({ f, value, onChange, w }: { f: RecordField; value: unknown; onChange: (v: unknown) => void; w: Work }) {
  const id = `f-${f.key}`, label = <label htmlFor={id}>{f.label}{f.required ? <i aria-hidden="true"> *</i> : null}</label>;
  const wide = ["longtext", "list", "multi"].includes(f.type);
  let input;
  switch (f.type) {
    case "longtext": input = <textarea id={id} rows={3} value={str(value)} onChange={(e) => onChange(e.target.value)} maxLength={f.max ?? 20000} />; break;
    case "number": case "money": input = <input id={id} type="number" value={value === undefined || value === null ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />; break;
    case "date": input = <DateField id={id} value={str(value)} onChange={(e) => onChange(e.target.value || null)} />; break;
    case "boolean": return <label className={css.check}><input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />{f.label}</label>;
    case "choice": input = <SelectField id={id} value={str(value)} onChange={(e) => onChange(e.target.value || null)}><option value="">Choose</option>{(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</SelectField>; break;
    case "multi": { const on = strList(value);
      return <fieldset className={css.multi}><legend>{f.label}</legend>{(f.options ?? []).map((o) => <label key={o}><input type="checkbox" checked={on.includes(o)} onChange={(e) => onChange(e.target.checked ? [...on, o] : on.filter((x) => x !== o))} />{o}</label>)}</fieldset>; }
    case "list": input = <textarea id={id} rows={3} value={Array.isArray(value) ? value.map(str).join("\n") : ""} placeholder="One per line" onChange={(e) => onChange(e.target.value.split("\n"))} />; break;
    case "person": input = <SelectField id={id} value={str(value)} onChange={(e) => onChange(e.target.value || null)}><option value="">Nobody yet</option>{peopleOf(w).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectField>; break;
    case "record": input = <SelectField id={id} value={str(value)} onChange={(e) => onChange(e.target.value || null)}><option value="">None</option>{w.runRecords.filter((x) => !f.recordType || x.type === f.recordType).map((x) => <option key={x.id} value={x.id}>{x.code ?? x.title}</option>)}</SelectField>; break;
    case "url": input = <input id={id} type="url" value={str(value)} placeholder="https://" onChange={(e) => onChange(e.target.value)} />; break;
    default: input = <input id={id} type="text" value={str(value)} onChange={(e) => onChange(e.target.value)} maxLength={2000} />;
  }
  return <div className={css.field} data-wide={wide ? "" : undefined}>{label}{input}{f.help ? <small>{f.help}</small> : null}</div>;
}
