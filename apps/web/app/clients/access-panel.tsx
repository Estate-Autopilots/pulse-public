"use client";
// CLIENT-PORTAL: a client's page → Pulse access: invite them (or see they are on Pulse), the people of theirs who sign
// in, more people, and the onboarding steps from quote to kickoff call.
import { Check, ClipboardList, History, Rocket, Send, UserPlus, Users, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { SelectField } from "../kit/select-field";
import { InviteSheet, Results, STATE, type Access, type Contact, type Result } from "./access";
import css from "./access.module.css";

type Step = { key: string; label: string; done: boolean; at: string | null; manual?: boolean; sent?: boolean; open?: number; count?: number };
type Data = { canManage: boolean; team?: { id: string; name: string }[]; org?: string; owner?: { id: string; name: string } | null; access?: Access; onboarding?: Step[]; contacts?: Contact[]; mail?: boolean; kickoff?: { title: string; notes: string }[] };
const day = (s?: string | null) => s ? new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "";
const MANUAL: Record<string, string> = { team: "team", kickoff: "kickoff", first_call: "first_call", quote: "welcome", first_chat: "first_chat" };

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "That did not work. Try again.");
  return data as T;
}

export function ClientAccessPanel({ id, name }: { id: string; name: string }) {
  const [data, setData] = useState<Data | null>(null); const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false); const [results, setResults] = useState<Result[] | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null); const [busy, setBusy] = useState<string | null>(null);
  const load = async () => { const r = await fetch(`/api/v0/clients/${id}/access`, { cache: "no-store" }); const d = await r.json().catch(() => ({}));
    if (r.ok) setData(d as Data); else setError(typeof d?.error === "string" ? d.error : "Client access is unavailable right now."); };
  useEffect(() => { void Promise.resolve().then(load); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (key: string, work: () => Promise<void>, done?: string) => { setBusy(key); setNote(null);
    try { await work(); await load(); if (done) setNote({ tone: "ok", text: done }); } catch (e) { setNote({ tone: "error", text: e instanceof Error ? e.message : "That did not work" }); } finally { setBusy(null); } };
  if (error) return <p className={css.note} data-tone="error" role="alert">{error}</p>;
  if (!data) return <p className={css.muted} role="status">Loading…</p>;
  if (!data.canManage) return <p className={css.muted}>Admins, HR and leadership manage a client’s Pulse access.</p>;
  const a = data.access!; const [label, tone] = STATE[a.state]; const org = data.org ?? "your team";
  const joined = a.state === "joined";
  return <div className={css.wrap}>
    {note ? <p className={css.note} data-tone={note.tone} role={note.tone === "error" ? "alert" : "status"}>{note.text}</p> : null}
    <div className={css.panels}>
      <section className={css.card} aria-labelledby="acc-h">
        <h3 id="acc-h"><Users size={16} aria-hidden="true" />Pulse access <span className={css.pill} data-tone={tone}>{label}</span></h3>
        {joined ? <>
          <p className={css.muted}>{a.org?.name ? `${a.org.name}${a.org.handle ? ` (@${a.org.handle})` : ""} · ` : ""}on Pulse since {day(a.joinedAt)}. They see their projects, shared documents, invoices, chats and calls with your team, nothing else.</p>
          <ul className={css.list}>{(a.people ?? []).map((p) => <li key={p.seat}><span><b>{p.name}</b><small>@{p.handle}{p.email ? ` · ${p.email}` : ""} · since {day(p.since)}</small></span></li>)}</ul>
          {a.waiting?.length ? <ul className={css.list}>{a.waiting.map((w) => <li key={w.id}><span>{w.name}<small>{w.expired ? "Link expired" : `Invited ${day(w.at)}`}</small></span>
            <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => run(w.id, async () => { await post(`client-access/requests/${w.id}/revoke`); }, "Withdrawn.")}><X size={14} aria-hidden="true" />Withdraw</button></li>)}</ul> : null}
          <p className={css.muted}>Your contacts with them: {(a.team ?? []).map((t) => t.name).join(", ") || "none yet"}.</p>
          <p className={css.muted}><History size={13} aria-hidden="true" /> Past WhatsApp conversations: {a.historyOptIn ? `they said yes on ${day(a.historyOptIn)}` : "they have not said yes yet (they see an offer in their space)"}.</p>
          <AddPerson id={id} contacts={(data.contacts ?? []).filter((c) => !c.onPulse)} mail={!!data.mail} onMade={load} />
        </> : <>
          <p className={css.muted}>{a.state === "invited" ? `Invited ${day(a.invitedAt)} by ${a.invitedBy ?? "someone"}${a.contact ? ` for ${a.contact}` : ""}${a.emailedAt ? ` · e-mailed ${day(a.emailedAt)}` : ""}${a.openedAt ? ` · they opened it ${day(a.openedAt)}` : " · not opened yet"}. The link works until ${day(a.expiresAt)}.`
            : a.state === "none" ? `${name} has no Pulse access yet. Invite them: they make their account from a private link and see their work with ${org}.`
            : `The last invitation ${a.state === "expired" ? "expired" : "was withdrawn"}. Invite again for a new link.`}</p>
          <div className={css.actions}>
            <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => { setSheet(true); setResults(null); }}><Send size={15} aria-hidden="true" />{a.state === "none" ? "Invite to Pulse" : "Invite again"}</button>
            {a.state === "invited" && a.requestId ? <button type="button" className={`${css.btn} ${css.quiet}`} disabled={!!busy} onClick={() => run("revoke", async () => { await post(`client-access/requests/${a.requestId}/revoke`); }, "Invitation withdrawn.")}><X size={14} aria-hidden="true" />Withdraw</button> : null}
          </div>
        </>}
      </section>
      {data.onboarding ? <Onboarding id={id} steps={data.onboarding} joined={joined} kickoff={data.kickoff ?? []} busy={busy} run={run} /> : null}
    </div>
    {sheet ? <InviteSheet single ids={[id]} rows={[{ id, name, contacts: data.contacts ?? [], owner: data.owner ?? null }]} data={{ team: data.team ?? [], mail: !!data.mail, org }} onClose={() => setSheet(false)}
      results={results} onDone={async (r) => { setResults(r); await load(); }} /> : null}
  </div>;
}

function Onboarding({ id, steps, joined, kickoff, busy, run }: { id: string; steps: Step[]; joined: boolean; kickoff: { title: string; notes: string }[]; busy: string | null; run: (k: string, w: () => Promise<void>, d?: string) => Promise<void> }) {
  const [edit, setEdit] = useState(false); const [items, setItems] = useState(kickoff.map((k) => ({ ...k, on: true })));
  const done = steps.filter((s) => s.done).length;
  const kick = steps.find((s) => s.key === "kickoff");
  return <section className={css.card} aria-labelledby="onb-h">
    <h3 id="onb-h"><Rocket size={16} aria-hidden="true" />Onboarding <span className={css.pill} data-tone={done === steps.length ? "ok" : "info"}>{done} of {steps.length}</span></h3>
    <ol className={css.steps}>{steps.map((s) => <li key={s.key} data-done={s.done ? "" : undefined}>
      <span className={css.tick} aria-hidden="true"><Check size={14} /></span>
      <b>{s.label}{s.key === "kickoff" && s.sent && !s.done ? ` · ${s.open} open` : ""}</b>
      {s.at ? <small className={css.sub}>{day(s.at)}</small> : null}
      {s.manual && MANUAL[s.key] ? <button type="button" className={`${css.btn} ${css.quiet}`} disabled={!!busy} aria-label={s.done ? `Mark “${s.label}” not done` : `Mark “${s.label}” done`}
        onClick={() => run(s.key, async () => { await post(`clients/${id}/onboarding`, { step: MANUAL[s.key], done: !s.done }); })}>{s.done ? "Undo" : "Done"}</button> : null}
    </li>)}</ol>
    {joined && !kick?.sent ? edit ? <div className={css.form}>
      <p className={css.muted}>These become tasks in their space. Untick what does not apply.</p>
      {items.map((it, i) => <label key={i} className={css.check}><input type="checkbox" checked={it.on} onChange={(e) => setItems((x) => x.map((y, j) => j === i ? { ...y, on: e.target.checked } : y))} />
        <span><b>{it.title}</b> <small className={css.sub}>{it.notes}</small></span></label>)}
      <div className={css.actions}><button type="button" className={`${css.btn} ${css.primary}`} disabled={!!busy || !items.some((x) => x.on)}
        onClick={() => run("kickoff", async () => { await post(`clients/${id}/kickoff`, { items: items.filter((x) => x.on).map(({ title, notes }) => ({ title, notes })) }); setEdit(false); }, "Kickoff checklist sent to their space.")}>
        <ClipboardList size={15} aria-hidden="true" />Send {items.filter((x) => x.on).length} items</button>
        <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setEdit(false)}>Cancel</button></div>
    </div> : <button type="button" className={css.btn} onClick={() => setEdit(true)}><ClipboardList size={15} aria-hidden="true" />Send the kickoff checklist</button>
      : !joined ? <p className={css.muted}>The kickoff checklist goes to their space once they are on Pulse.</p> : null}
    {!steps.find((s) => s.key === "quote")?.done ? <p className={css.muted}>Next: make a quotation from your packages in <a href="/erp/new?type=quotation">Billing</a>, issue it and press “Share in their Pulse”. They accept it in their space and the project and payment plan start by themselves.</p> : null}
  </section>;
}

function AddPerson({ id, contacts, mail, onMade }: { id: string; contacts: Contact[]; mail: boolean; onMade: () => Promise<void> }) {
  const [open, setOpen] = useState(false); const [contactId, setContactId] = useState(""); const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [send, setSend] = useState(false);
  const [made, setMade] = useState<{ link: string; whatsapp: string; mail: { sent: boolean; why: string | null; to: string | null } } | null>(null);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const pick = (v: string) => { setContactId(v); const c = contacts.find((x) => x.id === v); if (c) { setName(c.name); setEmail(c.email ?? ""); } };
  const add = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(null);
    try { setMade(await post(`clients/${id}/access/person`, { name, email, contactId: contactId || undefined, sendEmail: send })); await onMade(); } catch (err) { setError(err instanceof Error ? err.message : "Could not add"); } finally { setBusy(false); } };
  if (!open) return <button type="button" className={css.btn} onClick={() => setOpen(true)}><UserPlus size={15} aria-hidden="true" />Add a person of theirs</button>;
  if (made) return <div className={css.form}>
    <Results results={[{ clientId: id, ok: true, name, contact: name, link: made.link, whatsapp: made.whatsapp, mail: { ...made.mail, subject: "", body: "" } }]} />
    <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => { setMade(null); setOpen(false); setName(""); setEmail(""); setContactId(""); }}>Done</button>
  </div>;
  return <form className={css.form} onSubmit={add} aria-label="Add a person of theirs">
    {contacts.length ? <label className={css.field}>From their contacts<SelectField className={css.input} value={contactId} onChange={(e) => pick(e.target.value)}>
      <option value="">Someone new</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField></label> : null}
    <div className={css.row}>
      <label className={css.field}>Name<input className={css.input} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} /></label>
      <label className={css.field}>E-mail <small>(optional)</small><input className={css.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
    </div>
    <label className={css.check}><input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} disabled={!mail} /><span>Also e-mail the link{mail ? "" : " (e-mail is not switched on here)"}</span></label>
    {error ? <p className={css.note} data-tone="error" role="alert">{error}</p> : null}
    <div className={css.actions}><button className={`${css.btn} ${css.primary}`} disabled={busy}>{busy ? "Making their link…" : "Make their link"}</button>
      <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setOpen(false)}>Cancel</button></div>
    <small className={css.sub}>You copy or share the link yourself; nothing is sent unless you tick e-mail.</small>
  </form>;
}
