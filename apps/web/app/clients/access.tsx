"use client";
// CLIENT-PORTAL: Clients → Pulse access. Every client record with its access to Pulse; tick one or many and press
// Invite. Nothing is sent by itself: each invitation answers with its private link (copy, WhatsApp) and, only when
// "Also e-mail" is ticked and the record has an address, an e-mail.
import { Check, CheckCircle2, Copy, Mail, Search, Send, Share2, UserPlus, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { SelectField } from "../kit/select-field";
import css from "./access.module.css";

export type Contact = { id: string; name: string; email: string | null; phone: string | null; primary: boolean; side: string; optin: string | null; onPulse: boolean };
export type Access = { state: "none" | "invited" | "expired" | "withdrawn" | "ended" | "joined"; requestId?: string; invitedAt?: string; invitedBy?: string; contact?: string; email?: string | null;
  emailedAt?: string | null; openedAt?: string | null; expiresAt?: string; joinedAt?: string; org?: { name: string; handle: string | null } | null; people?: { seat: string; name: string; handle: string; email: string | null; since: string }[];
  team?: { seat: string; name: string }[]; waiting?: { id: string; name: string; email: string | null; at: string; expired: boolean }[]; historyOptIn?: string | null; poc?: string | null; role?: string | null };
type Row = { id: string; name: string; company: string | null; type: string; city: string | null; email: string | null; phone: string | null; contact: { id: string; name: string } | null;
  contacts: Contact[]; owner: { id: string; name: string } | null; projects: number; lastMonth: string | null; access: Access };
export type AccessData = { clients: Row[]; team: { id: string; name: string }[]; me: string; org: string; mail: boolean };
type Data = AccessData;
export type Result = { clientId: string; ok: boolean; error?: string; name?: string; contact?: string; email?: string | null; link?: string; whatsapp?: string;
  mail?: { to: string | null; sent: boolean; why: string | null; subject: string; body: string } };

const day = (s?: string | null) => s ? new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "";
export const STATE: Record<Access["state"], [string, string]> = { none: ["Not invited", "muted"], invited: ["Invited", "info"], expired: ["Link expired", "warn"], withdrawn: ["Withdrawn", "muted"], ended: ["Ended", "muted"], joined: ["On Pulse", "ok"] };
type Filter = "all" | "none" | "invited" | "joined";

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "That did not work. Try again.");
  return data as T;
}

export function AccessView({ initial }: { initial?: Data | null }) {
  const [data, setData] = useState<Data | null>(initial ?? null); const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all"); const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set()); const [sheet, setSheet] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const load = async () => { const r = await fetch("/api/v0/client-access", { cache: "no-store" }); const d = await r.json().catch(() => ({}));
    if (r.ok) setData(d as Data); else setError(typeof d?.error === "string" ? d.error : "Client access is unavailable right now."); };
  useEffect(() => { if (!initial) void Promise.resolve().then(load); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => (data?.clients ?? []).filter((c) => {
    const s = c.access.state;
    if (filter === "none" && !["none", "withdrawn", "ended", "expired"].includes(s)) return false;
    if (filter === "invited" && s !== "invited") return false;
    if (filter === "joined" && s !== "joined") return false;
    return !q || `${c.name} ${c.company ?? ""} ${c.contact?.name ?? ""} ${c.city ?? ""}`.toLowerCase().includes(q.toLowerCase());
  }), [data, filter, q]);
  if (error) return <p className={css.note} data-tone="error" role="alert">{error}</p>;
  if (!data) return <p className={css.muted} role="status">Loading client access…</p>;
  const counts = { all: data.clients.length, none: data.clients.filter((c) => ["none", "withdrawn", "ended", "expired"].includes(c.access.state)).length,
    invited: data.clients.filter((c) => c.access.state === "invited").length, joined: data.clients.filter((c) => c.access.state === "joined").length };
  const selectable = rows.filter((c) => c.access.state !== "joined");
  const allPicked = selectable.length > 0 && selectable.every((c) => picked.has(c.id));
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return <div className={css.wrap}>
    <div className={css.intro}>
      <div><h2>Give your clients their own Pulse</h2><p>Each client gets a private link. They make their account in a minute and see their projects, approvals, invoices, chats and calls with your team. Nothing is sent until you press Invite.</p></div>
      <div className={css.stats}><span><b>{counts.joined}</b>on Pulse</span><span><b>{counts.invited}</b>invited</span><span><b>{counts.none}</b>not yet</span></div>
    </div>
    <div className={css.toolbar}>
      <div className={css.segmented} role="group" aria-label="Show">
        {(["all", "none", "invited", "joined"] as Filter[]).map((f) => <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === "all" ? "All" : f === "none" ? "Not invited" : f === "invited" ? "Invited" : "On Pulse"}<span>{counts[f]}</span></button>)}
      </div>
      <label className={css.search}><Search size={14} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients…" aria-label="Search clients" /></label>
    </div>
    {picked.size ? <div className={css.bulk} role="region" aria-label="Selected clients">
      <span><b>{picked.size}</b> selected</span>
      <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => { setSheet(true); setResults(null); }}><Send size={15} aria-hidden="true" />Invite {picked.size === 1 ? "1 client" : `${picked.size} clients`}</button>
      <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setPicked(new Set())}>Clear</button>
    </div> : null}
    {sheet ? <InviteSheet ids={[...picked]} rows={data.clients} data={data} onClose={() => setSheet(false)}
      onDone={async (r) => { setResults(r); setPicked(new Set()); await load(); }} results={results} /> : null}
    <div className={css.table} role="table" aria-label="Clients and their Pulse access">
      <div className={css.tr} role="row" data-head="">
        <span role="columnheader"><input type="checkbox" aria-label="Select every client shown" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(selectable.map((c) => c.id)))} /></span>
        <span role="columnheader">Client</span><span role="columnheader" className={css.wide}>Contact</span><span role="columnheader">Access</span><span role="columnheader" className={css.wide}>Since</span>
      </div>
      {rows.slice(0, 400).map((c) => { const [label, tone] = STATE[c.access.state]; const contact = c.contacts.find((x) => x.primary) ?? c.contacts[0];
        return <div key={c.id} className={css.tr} role="row" data-picked={picked.has(c.id) ? "" : undefined}>
          <span role="cell">{c.access.state === "joined" ? <CheckCircle2 size={16} className={css.okIcon} aria-label="On Pulse" /> : <input type="checkbox" aria-label={`Select ${c.name}`} checked={picked.has(c.id)} onChange={() => toggle(c.id)} />}</span>
          <span role="cell" className={css.name}><Link href={`/clients/${c.id}?tab=access`}>{c.name}</Link><small>{[c.company !== c.name ? c.company : null, c.projects ? `${c.projects} ${c.projects === 1 ? "project" : "projects"}` : null, c.owner?.name].filter(Boolean).join(" · ")}</small></span>
          <span role="cell" className={`${css.wide} ${css.name}`}>{contact ? <>{contact.name}<small>{contact.email ?? contact.phone ?? (c.email || c.phone) ?? "No e-mail or phone yet"}</small></> : <small>No contact yet</small>}</span>
          <span role="cell"><span className={css.pill} data-tone={tone}>{label}</span>{c.access.state === "invited" && c.access.openedAt ? <small className={css.sub}>opened</small> : null}</span>
          <span role="cell" className={`${css.wide} ${css.sub}`}>{c.access.state === "joined" ? `${day(c.access.joinedAt)} · ${c.access.people?.length ?? 0} ${c.access.people?.length === 1 ? "person" : "people"}` : c.access.invitedAt ? `Invited ${day(c.access.invitedAt)}` : "—"}</span>
        </div>; })}
      {!rows.length ? <p className={css.muted}>No clients match.</p> : null}
    </div>
  </div>;
}

export function InviteSheet({ ids, rows, data, onClose, onDone, results, single }: { ids: string[]; rows: { id: string; name: string; contacts: Contact[]; owner: { id: string; name: string } | null; email?: string | null; phone?: string | null }[];
  data: { team: { id: string; name: string }[]; mail: boolean; org: string }; onClose: () => void; onDone: (r: Result[]) => Promise<void>; results: Result[] | null; single?: boolean }) {
  const one = ids.length === 1 ? rows.find((r) => r.id === ids[0]) : null;
  const primary = one ? one.contacts.find((x) => x.primary) ?? one.contacts[0] : null;
  const [poc, setPoc] = useState(""); const [message, setMessage] = useState(""); const [email, setEmail] = useState(false);
  const [contactId, setContactId] = useState(primary?.id ?? ""); const contact = one?.contacts.find((x) => x.id === contactId) ?? null;
  const [contactName, setContactName] = useState(""); const [emailTo, setEmailTo] = useState(""); const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const invite = async () => { setBusy(true); setError(null);
    try { const r = await post<{ results: Result[] }>("client-access/invite", { clientIds: ids, poc: poc || undefined, message, email,
      ...(one ? { contactId: contactId || undefined, contact: contactName || undefined, emailTo: emailTo || undefined, phone: phone || undefined } : {}) });
      await onDone(r.results); } catch (e) { setError(e instanceof Error ? e.message : "Could not invite"); } finally { setBusy(false); } };
  return <div className={css.sheet} role="dialog" aria-label={results ? "Invitations made" : "Invite to Pulse"}>
    <div className={css.sheetHead}><h3>{results ? "Invitations ready" : one ? `Invite ${one.name}` : `Invite ${ids.length} clients`}</h3><button type="button" className={`${css.btn} ${css.quiet}`} onClick={onClose} aria-label="Close"><X size={16} aria-hidden="true" /></button></div>
    {results ? <Results results={results} /> : <div className={css.form}>
      {one ? <>
        {one.contacts.length > 1 ? <label className={css.field}>Who gets the link<SelectField className={css.input} value={contactId} onChange={(e) => setContactId(e.target.value)}>
          {one.contacts.map((x) => <option key={x.id} value={x.id}>{x.name}{x.primary ? " (main contact)" : ""}{x.onPulse ? " · already on Pulse" : ""}</option>)}</SelectField></label> : null}
        <div className={css.row}>
          <label className={css.field}>Their name<input className={css.input} value={contactName} placeholder={contact?.name ?? one.name} onChange={(e) => setContactName(e.target.value)} /></label>
          <label className={css.field}>E-mail<input className={css.input} type="email" value={emailTo} placeholder={contact?.email ?? one.email ?? "name@company.com"} onChange={(e) => setEmailTo(e.target.value)} /></label>
          <label className={css.field}>Phone<input className={css.input} value={phone} placeholder={contact?.phone ?? one.phone ?? "+91…"} onChange={(e) => setPhone(e.target.value)} /></label>
        </div>
      </> : <p className={css.muted}>Each client gets their own link for their main contact, with the details on their record.</p>}
      <label className={css.field}>Their contact at {data.org}<SelectField className={css.input} value={poc} onChange={(e) => setPoc(e.target.value)}>
        <option value="">{one?.owner ? `${one.owner.name} (relationship owner)` : single || one ? "You, unless the record names a relationship owner" : "Each client's relationship owner, else you"}</option>
        {data.team.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</SelectField></label>
      <label className={css.field}>A short note <small>(optional, shown with the invitation)</small><textarea className={css.input} rows={2} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} /></label>
      <label className={css.check}><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} disabled={!data.mail} />
        <span><Mail size={14} aria-hidden="true" /> Also e-mail the link {data.mail ? "to clients with an e-mail address" : "(e-mail is not switched on here; copy or share the links instead)"}</span></label>
      {error ? <p className={css.note} data-tone="error" role="alert">{error}</p> : null}
      <div className={css.actions}><button type="button" className={`${css.btn} ${css.primary}`} onClick={invite} disabled={busy}><UserPlus size={15} aria-hidden="true" />{busy ? "Making links…" : ids.length === 1 ? "Invite" : `Invite ${ids.length} clients`}</button>
        <button type="button" className={`${css.btn} ${css.quiet}`} onClick={onClose}>Cancel</button></div>
    </div>}
  </div>;
}

export function Results({ results }: { results: Result[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (key: string, text: string) => { try { await navigator.clipboard.writeText(text); setCopied(key); } catch { /* the field is selectable */ } };
  return <div className={css.form}>
    <p className={css.muted}>Each link is shown once and works for 30 days. Send it to the client privately; anyone with it can accept for them.</p>
    {results.map((r) => r.ok ? <div key={r.clientId} className={css.result}>
      <div className={css.resultHead}><b>{r.name}</b><small>{r.contact}{r.mail?.sent ? ` · e-mailed to ${r.mail.to}` : ""}</small></div>
      <div className={css.copy}><input className={css.input} readOnly value={r.link} onFocus={(e) => e.target.select()} aria-label={`Link for ${r.name}`} />
        <button type="button" className={css.btn} onClick={() => copy(r.clientId, r.link!)}>{copied === r.clientId ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}{copied === r.clientId ? "Copied" : "Copy"}</button>
        <a className={css.btn} href={`https://wa.me/?text=${encodeURIComponent(r.whatsapp ?? r.link!)}`} target="_blank" rel="noreferrer"><Share2 size={15} aria-hidden="true" />WhatsApp</a></div>
      {r.mail && !r.mail.sent && r.mail.why ? <small className={css.sub}>{r.mail.why}</small> : null}
    </div> : <div key={r.clientId} className={css.result} data-tone="error"><b>{r.name ?? "A client"}</b><small>{r.error}</small></div>)}
  </div>;
}
