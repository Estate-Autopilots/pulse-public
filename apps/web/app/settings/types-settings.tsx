"use client";
// PEOPLE-CONTACTS part 4: Settings → Organisation → Contact and client types. Admins add a type ("Add contact type"),
// rename, recolour, describe and reorder it, give it its own fields, and archive it; records keep an archived type,
// new ones cannot get it. "Other" and "Internal" are how Pulse works and stay. Everyone else reads the list.
import { Archive, ArchiveRestore, GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { notify } from "@pulse/ui-shell";
import { plural } from "../lib/format";
import { Modal, post } from "../records";
import { TYPE_COLORS, TypeBadge, typeStyle, type RecordType, type TypeField } from "../record-types";
import { Empty, Panel, styles } from "../ui";
import css from "./types-settings.module.css";
import { SelectField } from "../kit/select-field";

type Types = { contact: RecordType[]; client: RecordType[]; canEdit: boolean };
const KINDS: [TypeField["type"], string][] = [["text", "Text"], ["number", "Number"], ["date", "Date"], ["url", "Link"], ["tel", "Phone"], ["email", "E-mail"], ["choice", "Choice"]];
const WHAT = { contact: { one: "contact", title: "Contact types", sub: "People outside the team: who they are to you.", example: "e.g. Architect, Photographer, Bank" },
  client: { one: "client", title: "Client types", sub: "The kinds of organisations you work for.", example: "e.g. Hospital, School, Startup" } } as const;

export function TypesSettings() {
  const [data, setData] = useState<Types | null>(null), [error, setError] = useState("");
  const [editing, setEditing] = useState<{ entity: "contact" | "client"; type: RecordType | null } | null>(null);
  const load = () => fetch("/api/v0/types", { cache: "no-store" }).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setData(d); }).catch((e) => setError((e as Error).message));
  useEffect(() => { void load(); }, []);
  async function archive(t: RecordType, archived: boolean) {
    try { await post("settings/types", { entity: t.entity, key: t.key, archived }); notify({ id: "type", tone: "success", title: archived ? `${t.label} archived` : `${t.label} restored`, message: archived ? `The ${t.count} record${t.count === 1 ? "" : "s"} with it keep it; new ones cannot get it.` : undefined, timeout: 3500 }); await load(); }
    catch (e) { notify({ id: "type", tone: "error", title: "Not saved", message: (e as Error).message }); }
  }
  if (error) return <Panel title="Contact and client types"><Empty icon={Archive} title="Types are not available" text={error} /></Panel>;
  if (!data) return <Panel title="Contact and client types"><p className={css.loading}>Loading…</p></Panel>;
  return <div className={css.wrap}>
    {(["contact", "client"] as const).map((entity) => {
      const list = data[entity], w = WHAT[entity];
      return <Panel key={entity} title={w.title} sub={w.sub} tools={data.canEdit ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnPrimary}`} onClick={() => setEditing({ entity, type: null })}><Plus size={13} aria-hidden="true" />Add {w.one} type</button> : undefined}>
        <ul className={css.list}>{list.map((t) => <li key={t.key} data-archived={t.archived ? "" : undefined}>
          <span className={css.swatch} style={typeStyle(t.color)} aria-hidden="true" />
          <span className={css.text}><span className={css.name}><TypeBadge types={list} entity={entity} value={t.key} />{t.archived ? <small className={css.tag}>Archived</small> : null}{t.system ? <small className={css.tag} title="Part of how Pulse works: it can be renamed, not archived">Built in</small> : null}</span>
            <small>{[t.hint, plural(t.count, entity === "contact" ? "contact" : "client")].filter(Boolean).join(" · ")}</small>
            {t.fields.length ? <span className={css.fields}>{t.fields.map((f) => <span key={f.key}>{f.label}</span>)}</span> : null}</span>
          {data.canEdit ? <span className={css.actions}>
            <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setEditing({ entity, type: t })} aria-label={`Edit ${t.label}`}><Pencil size={13} aria-hidden="true" />Edit</button>
            {!t.system ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => void archive(t, !t.archived)} aria-label={`${t.archived ? "Restore" : "Archive"} ${t.label}`}>{t.archived ? <ArchiveRestore size={13} aria-hidden="true" /> : <Archive size={13} aria-hidden="true" />}{t.archived ? "Restore" : "Archive"}</button> : null}
          </span> : null}
        </li>)}</ul>
      </Panel>;
    })}
    <p className={css.foot}>A type’s key never changes, so renaming one keeps every record, filter and report that uses it. Each change is recorded in the organisation’s history.</p>
    {editing ? <TypeEditor entity={editing.entity} type={editing.type} existing={data[editing.entity]} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); }} /> : null}
  </div>;
}

type Draft = TypeField & { id: number; optionsText: string };
function TypeEditor({ entity, type, existing, onClose, onSaved }: { entity: "contact" | "client"; type: RecordType | null; existing: RecordType[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const w = WHAT[entity];
  const [color, setColor] = useState(type?.color ?? Object.keys(TYPE_COLORS).find((c) => c !== "slate" && !existing.some((t) => t.color === c)) ?? "blue");
  const [fields, setFields] = useState<Draft[]>((type?.fields ?? []).map((f, i) => ({ ...f, id: i, optionsText: (f.options ?? []).join(", ") })));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const add = () => setFields((list) => [...list, { id: Date.now(), key: "", label: "", type: "text", optionsText: "" }]);
  const change = (id: number, patch: Partial<Draft>) => setFields((list) => list.map((f) => f.id === id ? { ...f, ...patch } : f));
  const move = (id: number, by: number) => setFields((list) => { const i = list.findIndex((f) => f.id === id), j = i + by; if (j < 0 || j >= list.length) return list; const next = [...list]; [next[i], next[j]] = [next[j], next[i]]; return next; });
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError("");
    const f = new FormData(e.currentTarget);
    const clean = fields.filter((x) => x.label.trim()).map((x) => ({ key: x.key, label: x.label.trim(), type: x.type, ...(x.type === "choice" ? { options: x.optionsText.split(",").map((o) => o.trim()).filter(Boolean) } : {}) }));
    if (clean.some((x) => x.type === "choice" && !x.options?.length)) { setError("A choice needs its options, separated by commas."); return; }
    setBusy(true);
    try {
      await post("settings/types", { entity, key: type?.key ?? "", label: f.get("label"), plural: f.get("plural"), hint: f.get("hint"), color, fields: clean });
      notify({ id: "type", tone: "success", title: type ? "Type saved" : `${String(f.get("label"))} added`, timeout: 2500 }); await onSaved();
    } catch (x) { setError((x as Error).message); } finally { setBusy(false); }
  }
  const formId = `type-${entity}`;
  return <Modal title={type ? `Edit ${type.label}` : `Add a ${w.one} type`} sub={type ? `${plural(type.count, w.one)} have this type.` : w.example} onClose={onClose} scroll
    foot={<div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>Cancel</button><button form={formId} className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Saving…" : type ? "Save" : "Add type"}</button></div>}>
    <form id={formId} className={css.form} onSubmit={submit}>
      <label className={css.field}><span>Name</span><input name="label" required minLength={2} maxLength={40} defaultValue={type?.label} placeholder={w.example.replace("e.g. ", "").split(",")[0]} /></label>
      <label className={css.field}><span>Plural <i>optional</i></span><input name="plural" maxLength={48} defaultValue={type?.plural === type?.label ? "" : type?.plural} placeholder="Used in filters, e.g. Architects" /></label>
      <label className={css.field}><span>What it means <i>optional</i></span><input name="hint" maxLength={160} defaultValue={type?.hint ?? ""} placeholder="One line, shown when choosing a type" /></label>
      <fieldset className={css.colors}><legend>Colour</legend>{Object.keys(TYPE_COLORS).map((c) => <label key={c} style={typeStyle(c)} title={c}><input type="radio" name="color" value={c} checked={color === c} onChange={() => setColor(c)} aria-label={c} /><i aria-hidden="true" /></label>)}</fieldset>
      <fieldset className={css.fieldList}><legend>Its own fields <i>optional</i></legend>
        <p className={css.hint}>Extra details only {w.one}s of this type have, e.g. a RERA number for a developer or a rate for a model.</p>
        {fields.map((x, i) => <div key={x.id} className={css.fieldRow}>
          <span className={css.order}><button type="button" onClick={() => move(x.id, -1)} disabled={i === 0} aria-label="Move up"><GripVertical size={14} aria-hidden="true" /></button></span>
          <input aria-label="Field name" placeholder="Field name" value={x.label} maxLength={40} onChange={(e) => change(x.id, { label: e.target.value })} />
          <SelectField aria-label="Kind" value={x.type} onChange={(e) => change(x.id, { type: e.target.value as TypeField["type"] })}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</SelectField>
          <button type="button" className={css.remove} onClick={() => setFields((list) => list.filter((f) => f.id !== x.id))} aria-label={`Remove ${x.label || "field"}`}><Trash2 size={14} aria-hidden="true" /></button>
          {x.type === "choice" ? <input className={css.options} aria-label="Options" placeholder="Options, separated by commas" value={x.optionsText} onChange={(e) => change(x.id, { optionsText: e.target.value })} /> : null}
        </div>)}
        {fields.length < 12 ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={add}><Plus size={13} aria-hidden="true" />Add a field</button> : null}
      </fieldset>
    </form>
  </Modal>;
}
