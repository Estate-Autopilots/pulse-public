"use client";
// AGENT-UI-CONTROL: an AI employee's card under its message in the chat, for what it lacks instead of failing: Add client
// (the client is not in Clients), Add task, Add project (a standard AI employee proposes work; the person adds it in one
// click) or Pick one (several match). Filled in with what it knows; the person checks it and saves it as themselves (their
// own permissions decide: adding a client is for admins, leadership and Finance, as on Clients). Saved, the chat says so
// and the AI employee carries on. The same fields make the client form it can open on screen (form.open "client").
import Link from "next/link";
import { useId, useState, useSyncExternalStore, type FormEvent } from "react";
import { Building2, CircleCheck, FolderPlus, ListPlus, MousePointerClick, Sparkles } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Modal, post } from "../records";
import css from "./agent-ui.module.css";

export type CardKind = "client.add" | "task.add" | "project.add" | "choice";
export type ChatCard = { id: string; kind: CardKind; title: string; fields: Record<string, unknown>; state: "open" | "done" | "dismissed";
  result: Record<string, unknown> | null; forPersonId: string | null; doneByName: string | null };
type Field = { key: string; label: string; type?: "text" | "tel" | "email" | "date"; wide?: boolean; required?: boolean; area?: boolean };

const FIELDS: Record<Exclude<CardKind, "choice">, Field[]> = {
  "client.add": [{ key: "name", label: "Client name", required: true, wide: true }, { key: "phone", label: "Phone", type: "tel" }, { key: "email", label: "E-mail", type: "email" },
    { key: "city", label: "City" }, { key: "company", label: "Company" }],
  "task.add": [{ key: "name", label: "Task", required: true, wide: true }, { key: "dueOn", label: "Due", type: "date" }, { key: "notes", label: "Notes", wide: true, area: true }],
  "project.add": [{ key: "name", label: "Project name", required: true, wide: true }, { key: "summary", label: "What it is for", wide: true, area: true }],
};
const SAVE: Record<Exclude<CardKind, "choice">, string> = { "client.add": "Add client", "task.add": "Add task", "project.add": "Add project" };
const ICON = { "client.add": Building2, "task.add": ListPlus, "project.add": FolderPlus, choice: MousePointerClick } as const;
const str = (v: unknown) => (typeof v === "string" ? v : "");
/** What the card starts with: the AI employee's words for each field. */
const prefill = (kind: CardKind, f: Record<string, unknown>): Record<string, string> => ({
  name: str(f.name) || str(f.title), phone: str(f.phone), email: str(f.email), city: str(f.city), company: str(f.company), dueOn: str(f.dueOn),
  notes: kind === "task.add" ? str(f.notes) : "", summary: kind === "project.add" ? str(f.summary) || str(f.notes) : "",
});
const doneLink = (kind: CardKind, r: Record<string, unknown> | null) => {
  if (!r) return null;
  if (kind === "client.add" && r.clientId) return `/clients/${r.clientId}`;
  if (kind === "task.add" && r.taskId) return `/tasks/${r.taskId}`;
  if (kind === "project.add" && r.projectId) return `/tasks/projects/${r.projectId}`;
  return null;
};
const DONE: Record<CardKind, string> = { "client.add": "Added the client", "task.add": "Made the task", "project.add": "Made the project", choice: "Picked" };

function Fields({ kind, values, set, form }: { kind: Exclude<CardKind, "choice">; values: Record<string, string>; set: (k: string, v: string) => void; form: string }) {
  return <div className={css.fields}>{FIELDS[kind].map((f) => <label key={f.key} className={css.field} data-wide={f.wide || undefined}>
    <span>{f.label}{f.required ? "" : " (if you know it)"}</span>
    {f.area ? <textarea form={form} rows={2} value={values[f.key] ?? ""} maxLength={2000} onChange={(e) => set(f.key, e.target.value)} />
      : <input form={form} type={f.type ?? "text"} value={values[f.key] ?? ""} required={f.required} maxLength={f.key === "phone" ? 40 : 200} onChange={(e) => set(f.key, e.target.value)}
        autoComplete="off" inputMode={f.type === "tel" ? "tel" : undefined} />}
  </label>)}</div>;
}

/** The card in the chat. */
export function AgentCard({ card, compact = false }: { card: ChatCard; viewer?: string; compact?: boolean }) {
  const [values, setValues] = useState(() => prefill(card.kind, card.fields));
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [local, setLocal] = useState<Pick<ChatCard, "state" | "result"> | null>(null);
  const form = useId();
  const state = local?.state ?? card.state, result = local?.result ?? card.result;
  const Icon = ICON[card.kind];
  async function save(extra?: Record<string, string>) {
    setBusy(true); setError("");
    try {
      const r = await post<{ state: "done"; result: Record<string, unknown> }>(`screen/cards/${card.id}/submit`, { values: { ...values, ...extra } });
      setLocal({ state: "done", result: r.result });
    } catch (e) { setError(e instanceof Error ? e.message : "That did not save. Try again."); } finally { setBusy(false); }
  }
  async function close() {
    setBusy(true);
    try { await post(`screen/cards/${card.id}/dismiss`); setLocal({ state: "dismissed", result: null }); } catch { /* it stays open */ } finally { setBusy(false); }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void save(); };
  const head = <h4><Icon size={15} aria-hidden="true" />{card.title}</h4>;
  if (state === "done") {
    const link = doneLink(card.kind, result), what = str(result?.name) || str(result?.title) || str(result?.choice);
    return <div className={css.chatCard} data-compact={compact || undefined} data-agent-card={card.id} data-state="done">{head}
      <p className={css.cardDone}><CircleCheck size={15} aria-hidden="true" /><span>{DONE[card.kind]}{what ? <> “{link ? <Link href={link}>{what}</Link> : what}”</> : null}{card.doneByName ? <span className={css.doneBy}> by {card.doneByName}</span> : null}</span></p></div>;
  }
  if (state === "dismissed") return <div className={css.chatCard} data-compact={compact || undefined} data-agent-card={card.id} data-state="dismissed">{head}<p className={css.cardClosed}>Closed. Ask again any time.</p></div>;
  if (card.kind === "choice") {
    const options = Array.isArray(card.fields.options) ? card.fields.options.filter((o): o is string => typeof o === "string") : [];
    return <div className={css.chatCard} data-compact={compact || undefined} data-agent-card={card.id}>{head}
      <div className={css.choices}>{options.map((o) => <button key={o} type="button" className={css.btn} disabled={busy} onClick={() => void save({ choice: o })}>{o}</button>)}</div>
      {error ? <p className={css.error} role="alert" style={{ paddingLeft: 0 }}>{error}</p> : null}</div>;
  }
  return <form id={form} className={css.chatCard} data-compact={compact || undefined} data-agent-card={card.id} onSubmit={submit}>{head}
    <Fields kind={card.kind} values={values} set={(k, v) => setValues((x) => ({ ...x, [k]: v }))} form={form} />
    {error ? <p className={css.error} role="alert" style={{ paddingLeft: 0 }}>{error}</p> : null}
    <div className={css.cardButtons}>
      <button type="submit" className={css.primary} disabled={busy || !values.name?.trim()}>{busy ? "Saving…" : SAVE[card.kind]}</button>
      <button type="button" className={css.ghost} disabled={busy} onClick={() => void close()}>Not now</button>
    </div>
  </form>;
}

// ---- form.open "client": the same fields in a drawer on the person's screen. ----
type ClientAsk = { values: Record<string, string>; by: string; done: (ok: boolean, id?: string) => void };
let ask: ClientAsk | null = null;
const subs = new Set<() => void>();
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
/** Opens the client form filled in; resolves when the person saves (with the new client's id) or closes it. */
export function openClientForm(values: Record<string, string>, by: string) {
  return new Promise<{ ok: boolean; id?: string }>((resolve) => { ask?.done(false); ask = { values, by, done: (ok, id) => { ask = null; subs.forEach((f) => f()); resolve({ ok, id }); } }; subs.forEach((f) => f()); });
}
export function ClientFormHost() {
  const a = useSyncExternalStore(subscribe, () => ask, () => null);
  return a ? <ClientForm key={JSON.stringify(a.values)} a={a} /> : null;
}
function ClientForm({ a }: { a: ClientAsk }) {
  const [values, setValues] = useState(a.values), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const form = useId();
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const r = await post<{ id: string }>("clients", { displayName: values.name.trim(), clientType: "other", ...(values.phone ? { phone: values.phone } : {}), ...(values.email ? { email: values.email } : {}),
        ...(values.city ? { city: values.city } : {}), ...(values.company ? { companyName: values.company } : {}) });
      notify({ id: "agent-client", tone: "success", title: `Added ${values.name.trim()} to Clients`, timeout: 3000 });
      a.done(true, r.id);
    } catch (err) { setError(err instanceof Error ? err.message : "That did not save. Try again."); } finally { setBusy(false); }
  }
  return <Modal title="Add a client" sub={`${a.by} filled in what it knows. Check it and save.`} icon={<Sparkles size={16} aria-hidden="true" />} onClose={() => a.done(false)}
    foot={<><button type="button" className={css.ghost} onClick={() => a.done(false)}>Cancel</button><button form={form} className={css.primary} disabled={busy || !values.name?.trim()}>{busy ? "Saving…" : "Add client"}</button></>}>
    <form id={form} onSubmit={save} data-agent-ui="">
      <Fields kind="client.add" values={values} set={(k, v) => setValues((x) => ({ ...x, [k]: v }))} form={form} />
      {error ? <p className={css.error} role="alert" style={{ paddingLeft: 0 }}>{error}</p> : null}
    </form>
  </Modal>;
}
