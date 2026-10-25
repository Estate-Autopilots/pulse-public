"use client";
import {AccountTools} from './account/tools';

import { Check, Copy, Info, Link2, Pencil, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { notify } from "@pulse/ui-shell";
import styles from "./ui.module.css";
import { ImagePicker } from "./image-crop";
import { Drawer, DrawerFooter, DrawerSection, type DrawerSize } from "./kit/drawer";
import { Combobox, type Option } from "./kit/combobox";
import { DatePicker } from "./kit/date-picker";
import { HelpHint, Tooltip } from "./kit/popover";
import { useOrgZone } from "./org-code";
import { zoneDay } from "./lib/zone.mjs";

export async function post<T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? "Could not save");
  window.dispatchEvent(new Event("pulse:data-changed"));
  return data;
}
const message = (e: unknown) => e instanceof Error ? e.message : "Could not save";

/** "First sentence. The rest." → [first sentence, the rest]; a first sentence longer than a line goes behind "?" too. */
function splitSub(sub?: string): [string, string] {
  if (!sub) return ["", ""];
  const m = sub.match(/^([\s\S]+?[.!?])\s+([\s\S]+)$/);
  const [first, rest] = m ? [m[1], m[2]] : [sub, ""];
  return first.length > 90 ? ["", sub] : [first, rest];
}
/** A side panel for editing and adding (UX-5A: the kit's one Drawer; a bottom sheet on phones). The page behind stays
 *  where it was. A short `sub` is the context line under the title; a longer one (an explanation) goes behind the "?"
 *  next to the title instead of a paragraph. `context`, `help`, `icon` and `size` go straight to the Drawer. `min` and
 *  `scroll` are kept for callers: the body always scrolls on its own and the footer stays put. */
export function Modal({ title, sub, onClose, children, foot, context, help, icon, size, label, describedBy }: { title: string; sub?: string; onClose: () => void; children: ReactNode; foot?: ReactNode;
  /** @deprecated the drawer body scrolls; pages are gone. */ min?: number; /** @deprecated always scrolls. */ scroll?: boolean;
  context?: ReactNode; help?: ReactNode; icon?: ReactNode; size?: DrawerSize; label?: string; describedBy?: string }) {
  // The first sentence of `sub` stays as the context line (it is often the state: "2 subtasks are still open."); the
  // rest, the explanation, goes behind the "?".
  const [lead, rest] = splitSub(sub);
  const more = rest && help ? <><span style={{ display: "block", marginBottom: 6 }}>{rest}</span>{help}</> : help ?? (rest || undefined);
  return <Drawer title={title} label={label} describedBy={describedBy} onClose={onClose} icon={icon} size={size}
    context={context ?? (lead ? <span className={styles.drawerSub}>{lead}</span> : undefined)} help={more} footer={foot}>{children}</Drawer>;
}

/** `choice` shows the options as a row of buttons; `suggest` offers values already in use while still taking a new one;
 *  `section` starts a titled group; `hint` is one quiet line under the field. */
export type FieldDef = { key: string; label: string; type?: "number" | "text" | "select" | "choice" | "date" | "month" | "textarea" | "email" | "tel" | "url"; options?: readonly { value: string; label: string; hint?: string }[];
  required?: boolean; maxLength?: number; placeholder?: string; wide?: boolean; section?: string; hint?: string; suggest?: readonly string[] };
type Values = Record<string, string | null | undefined>;

/** Edit or create one record. Complete records include unchanged defaults; edits send changed fields; the page reloads its data afterwards. */
export function RecordForm({ path, title, sub, fields, values = {}, label, icon = "edit", variant, created, note, extra, done, action, complete, defaultOpen = false }: {
  path: string; title: string; sub?: string; fields: readonly FieldDef[]; values?: Values; label: string; icon?: "edit" | "add" | "none"; defaultOpen?: boolean;
  variant?: "primary" | "ghost" | "link"; created?: string; note?: string; extra?: Record<string, unknown>; complete?: boolean; done?: string; action?: string;
}) {
  const router = useRouter(); const [open, setOpen] = useState(defaultOpen); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const formId = useId();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget); const body: Record<string, unknown> = { ...extra };
    // The kit's lists and days carry their value in a hidden input, which the browser does not check: say what is missing.
    const missing = fields.find((f) => f.required && !String(data.get(f.key) ?? "").trim());
    if (missing) { setError(`${missing.label}: ${["select", "choice", "date", "month"].includes(missing.type ?? "") ? "choose one" : "fill this in"}`); return; }
    for (const f of fields) { const next = String(data.get(f.key) ?? "").trim(); if (complete || next !== (values[f.key] ?? "")) body[f.key] = next; }
    if (!created && Object.keys(body).length === Object.keys(extra ?? {}).length) { setOpen(false); return; }
    setBusy(true); setError("");
    try {
      const result = await post<{ id?: string }>(path, body);
      setOpen(false);
      notify({ id: `saved:${path}`, tone: "success", title: created ? "Record created" : done ?? "Saved", timeout: 2500 });
      if (created && result.id) router.push(`${created}${result.id}`); else router.refresh();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  const Icon = icon === "add" ? Plus : Pencil;
  // UX-5A: fields grouped under their section labels; explanations behind "?"; the kit's controls, not the browser's.
  const groups: { section?: string; fields: FieldDef[] }[] = [];
  for (const f of fields) if (f.section || !groups.length) groups.push({ section: f.section, fields: [f] }); else groups.at(-1)!.fields.push(f);
  return <>
    {variant === "link" ? <button type="button" className={`${styles.fill}`} style={{ border: 0, padding: 0, background: "none", font: "inherit" }} onClick={() => setOpen(true)}>{label}</button>
      : <button type="button" className={`${styles.btn}${variant === "primary" ? ` ${styles.btnPrimary}` : variant === "ghost" ? ` ${styles.btnGhost}` : ""}`} onClick={() => setOpen(true)}>{icon === "none" ? null : <Icon size={14} aria-hidden="true" />}{label}</button>}
    {open ? (
      <Modal title={title} sub={sub} help={note} onClose={() => setOpen(false)} foot={<DrawerFooter status={error}><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(false)}>Cancel</button><button form={formId} className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Saving…" : action ?? (created ? "Create" : "Save changes")}</button></DrawerFooter>}>
        <form id={formId} className={styles.drawerForm} onSubmit={submit} noValidate={false}>
          {groups.map((g, i) => <DrawerSection key={`${g.section ?? ""}${i}`} title={g.section}>
            <div className={styles.modalBody}>{g.fields.map((f) => <FormField key={f.key} f={f} value={values[f.key] ?? ""} formId={formId} />)}</div>
          </DrawerSection>)}
        </form>
      </Modal>
    ) : null}
  </>;
}

/** The label row of a field: its words, required or optional, and the "?" with its hint. The "?" sits outside the
 *  <label>, so the field's accessible name stays exactly its label. */
function FieldLabel({ f, htmlFor, id }: { f: FieldDef; htmlFor?: string; id?: string }) {
  const words = <>{f.label}{f.required ? <i className={styles.req} aria-hidden="true"> *</i> : <span className={styles.srOnly}> (optional)</span>}</>;
  return <span className={styles.fieldTop}>{htmlFor ? <label htmlFor={htmlFor}>{words}</label> : <span id={id}>{words}</span>}{f.hint ? <HelpHint label={`About: ${f.label}`}>{f.hint}</HelpHint> : null}</span>;
}
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** The months around now (two years back, one ahead), newest first, for a month field. */
function monthOptions(current: string) {
  const now = new Date(); const out: Option[] = [];
  for (let i = 12; i >= -24; i--) { const d = new Date(now.getFullYear(), now.getMonth() + i, 1); const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; out.push({ value: v, label: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}` }); }
  if (current && !out.some((o) => o.value === current)) out.unshift({ value: current, label: current });
  return out;
}
/** One field of a RecordForm. Choices, lists, days and months are the kit's controls with a hidden input carrying the
 *  value, so the form still submits FormData; text stays a (styled) text box. */
export function FormField({ f, value, formId }: { f: FieldDef; value: string; formId: string }) {
  const [v, setV] = useState(value);
  const zone = useOrgZone();
  const id = `${formId}-${f.key}`, wide = f.wide || f.type === "textarea" || f.type === "choice";
  const cls = `${styles.field}${wide ? ` ${styles.wide}` : ""}`, kit = `${styles.kitField}${wide ? ` ${styles.wide}` : ""}`;
  const hidden = <input type="hidden" name={f.key} value={v} />;
  const label = typeof f.label === "string" ? f.label : f.key;
  if (f.type === "choice") {
    // Styled chips over radio inputs (not the browser's look); an option's hint is its tooltip.
    const options = [...(f.required ? [] : [{ value: "", label: "Not set" }]), ...(f.options ?? [])];
    return <fieldset className={`${styles.field} ${styles.wide} ${styles.choice}`} data-field={f.key}><legend><FieldLabel f={f} id={`${id}-label`} /></legend>
      <div className={styles.choiceRow}>{options.map((o) => { const chip = <label key={o.value} className={styles.choiceItem}><input type="radio" name={f.key} value={o.value} defaultChecked={value === o.value} required={f.required} /><span>{o.label}</span></label>;
        return "hint" in o && o.hint ? <Tooltip key={o.value} content={o.hint}>{chip}</Tooltip> : chip; })}</div>
    </fieldset>;
  }
  if (f.type === "select") {
    const options: Option[] = (f.options ?? []).map((o) => ({ value: o.value, label: o.label, detail: o.hint }));
    return <div className={kit} data-field={f.key}><FieldLabel f={f} id={`${id}-label`} />
      <Combobox label={label} options={options} noneLabel={f.required ? undefined : "Not set"} value={v || null} onChange={(x) => setV(x ?? "")} placeholder={f.required ? "Choose…" : "Not set"} />
      {hidden}</div>;
  }
  if (f.type === "date") return <div className={kit} data-field={f.key}><FieldLabel f={f} id={`${id}-label`} />
    <DatePicker label={label} value={{ date: v || null, time: null }} onChange={(x) => setV(x.date ?? "")} today={zoneDay(zone)} placeholder={f.placeholder ?? "Pick a day"} />{hidden}</div>;
  if (f.type === "month") return <div className={kit} data-field={f.key}><FieldLabel f={f} id={`${id}-label`} />
    <Combobox label={label} options={monthOptions(v)} value={v || null} onChange={(x) => setV(x ?? "")} noneLabel={f.required ? undefined : "Not set"} placeholder="Choose a month" />{hidden}</div>;
  return <div className={cls} data-field={f.key}><FieldLabel f={f} htmlFor={id} />
    {f.type === "textarea" ? <textarea id={id} name={f.key} defaultValue={value} placeholder={f.placeholder} maxLength={f.maxLength ?? 2000} />
      : <input id={id} name={f.key} type={f.type ?? "text"} defaultValue={value} required={f.required} placeholder={f.placeholder} autoComplete="off" list={f.suggest ? `${id}-list` : undefined} maxLength={f.maxLength} />}
    {f.suggest ? <datalist id={`${id}-list`}>{f.suggest.map((x) => <option key={x} value={x} />)}</datalist> : null}
  </div>;
}

/** Upload or remove a person's or a contact's photo (PEOPLE-CONTACTS): the cropper opens first (pinch, drag, turn,
 *  circle mask) and a sharp square image is saved; the database decides who may (migration 0210). */
export function PhotoControls({ personId, hasPhoto, name }: { personId: string; hasPhoto: boolean; name?: string }) {
  const router = useRouter();
  const label = name ? `${name.split(/\s+/)[0]}’s photo` : "the photo";
  async function send(body: unknown, done: string) {
    try { await post(`people/${personId}/photo`, body); notify({ id: "photo", tone: "success", title: done, timeout: 2500 }); router.refresh(); }
    catch (e) { notify({ id: "photo", tone: "error", title: "The photo was not saved", message: message(e) }); throw e; }
  }
  return <ImagePicker label={label} has={hasPhoto} shapes={["circle", "square"]} save={(r) => send({ dataUrl: r.dataUrl }, hasPhoto ? "Photo updated" : "Photo added")}
    remove={() => send({ remove: true }, "Photo removed")} onError={(m) => notify({ id: "photo", tone: "error", title: "The photo was not saved", message: m })} />;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className={styles.iconBtn} aria-label="Copy" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch {} }}>{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}</button>;
}

export function LoginActions({personId,hasLogin,active,small}:{personId:string;hasLogin:boolean;active:boolean;small?:boolean}){return <AccountTools id={personId} active={hasLogin?active:true} hasLogin={hasLogin} small={small}/>;}
export function ResetRequestActions({id,known}:{id:string;known:boolean}){
 const router=useRouter(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function run(action:string){setBusy(true);setError('');try{await post(`admin/reset-requests/${id}`,{action});router.refresh();}catch(e){setError(message(e));}finally{setBusy(false);}}
 return <span className={styles.inline}>{known?<button className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={()=>run('send')}>Send reset link</button>:null}<button className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={()=>run('dismiss')}>Dismiss</button>{error?<small role="alert">{error}</small>:null}</span>;
}

/** Admin: link an uploader account to this person so their deliveries are credited to them, or unlink it. */
export function LinkAccount({ personId, unlink }: { personId: string; unlink?: string }) {
  const router = useRouter(); const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [accounts, setAccounts] = useState<{ handle: string; deliveries: number }[] | null>(null); const [query, setQuery] = useState("");
  useEffect(() => {
    if (!open || accounts) return;
    fetch("/api/v0/accounts").then((r) => r.json()).then((d) => setAccounts(d.accounts ?? [])).catch(() => setAccounts([]));
  }, [open, accounts]);
  async function save(handle: string, action: "link" | "unlink") {
    setBusy(true); setError("");
    try { await post(`people/${personId}/accounts`, { handle, action }); setOpen(false); notify({ id: "account", tone: "success", title: action === "link" ? "Account linked" : "Account unlinked", timeout: 2500 }); router.refresh(); }
    catch (e) { setError(message(e)); if (action === "unlink") notify({ id: "account", tone: "error", title: "Not unlinked", message: message(e) }); } finally { setBusy(false); }
  }
  if (unlink) return <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => save(unlink, "unlink")}>Unlink</button>;
  const shown = (accounts ?? []).filter((a) => a.handle.includes(query.trim().toLowerCase())).slice(0, 8);
  return <>
    <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setOpen(true)}><Link2 size={13} aria-hidden="true" />Link an account</button>
    {open ? (
      <Modal title="Link an uploader account" onClose={() => setOpen(false)}>
        <div className={styles.modalBody}>
          <label className={`${styles.field} ${styles.wide}`}>Google account that uploads this person’s work<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by e-mail…" autoComplete="off" /></label>
          <ul className={`${styles.list} ${styles.wide}`} style={{ border: "1px solid var(--theme-border)", borderRadius: 9, overflow: "hidden" }}>
            {accounts === null ? <li className={styles.row} style={{ borderTop: 0 }}><span className={styles.muted}>Loading accounts…</span></li>
              : shown.length ? shown.map((a, i) => <li key={a.handle} className={styles.row} style={i ? undefined : { borderTop: 0 }}><span className={styles.rowMain}><span className={styles.rowTitle}>{a.handle}</span><span className={styles.rowMeta}><span>{a.deliveries} deliveries</span></span></span><button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => save(a.handle, "link")}>Link</button></li>)
                : <li className={styles.row} style={{ borderTop: 0 }}><span className={styles.muted}>No unlinked personal account matches.</span></li>}
          </ul>
          <p className={styles.modalNote}>Only accounts used by one person can be linked. Shared logins stay under Team, Tracking and are never credited to a person. {error ? <b style={{ color: "var(--theme-danger)" }}>{error}</b> : null}</p>
        </div>
      </Modal>
    ) : null}
  </>;
}

/** A quiet "how Pulse knows" link: the explanation opens in the side drawer and stays out of the page itself. */
export function InfoDrawer({ label = "How Pulse knows", title, sub, children }: { label?: string; title: string; sub?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={styles.infoLink} onClick={() => setOpen(true)}><Info size={13} aria-hidden="true" />{label}</button>
    {open ? <Modal title={title} sub={sub} onClose={() => setOpen(false)}><div className={styles.infoBody}>{children}</div></Modal> : null}
  </>;
}

const SUGGEST: Record<"project" | "client" | "contact", { value: string; label: string }[]> = {
  project: [{ value: "title", label: "Project name" }, { value: "client", label: "Client" }, { value: "location", label: "Location" }, { value: "pod", label: "Pod" }, { value: "pgs", label: "PGS" }, { value: "status", label: "Stage or status" }, { value: "segment", label: "Segment" }, { value: "other", label: "Something else" }],
  client: [{ value: "name", label: "Client name" }, { value: "type", label: "Client type" }, { value: "contact", label: "Primary contact" }, { value: "location", label: "Location" }, { value: "other", label: "Something else" }],
  contact: [{ value: "name", label: "Name" }, { value: "type", label: "Contact type" }, { value: "phone", label: "Phone" }, { value: "email", label: "E-mail" }, { value: "client", label: "Client" }, { value: "other", label: "Something else" }],
};
/** For everyone who cannot edit the record: a suggestion that lands in Review data for an admin to apply. */
export function SuggestCorrection({ entity, id, name }: { entity: "project" | "client" | "contact"; id: string; name: string }) {
  return <RecordForm path="corrections/suggest" title="Suggest a correction" sub={name} label="Suggest a correction" extra={{ entity, entityId: id }} done="Sent to an admin" action="Send to an admin"
    fields={[{ key: "field", label: "What is wrong", type: "select", required: true, options: SUGGEST[entity] }, { key: "value", label: "The right value", placeholder: "e.g. the correct client or location" }, { key: "note", label: "Anything else to know", type: "textarea", placeholder: "Where you saw it, or what changed" }]}
    note="An admin reviews it in Review data and corrects the record. The record keeps its history, and your name is kept with the suggestion." />;
}
