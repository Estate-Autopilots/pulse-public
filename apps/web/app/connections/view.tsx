"use client";
import { ArrowRight, Check, CheckSquare, Copy, Handshake, Link2, Mail, MessagesSquare, Plus, Send, UsersRound, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { notify } from "@pulse/ui-shell";
import { useState, type FormEvent } from "react";
import { arrive, post, type Moved } from "../orgs/client";
import { orgInitials } from "../orgs/labels";
import { Qr } from "./qr";
import css from "../orgs/orgs.module.css";
import { DateField } from "../kit/date-field";
import { SelectField } from "../kit/select-field";

export type Person = { id: string; name: string };
export type Shared = { id: string; kind: "chat" | "task"; ref: string; title: string; hostOrg: string; hostName: string; here: boolean; members?: number; lastAt?: string | null; last?: string | null; lastBy?: string | null;
  status?: string; assignee?: string | null; by?: string | null; dueAt?: string | null };
export type Connection = { id: string; since: string; weInvited: boolean; project: string | null; summary: string | null;
  other: { org: string | null; name: string; handle: string | null; individual: boolean };
  ours: { seat: string; person: string; name: string; me: boolean }[]; theirs: { seat: string; person: string; name: string; role: string | null }[];
  canManage?: boolean; mySeat: boolean; shared: Shared[];
  /** CLIENT-PORTAL 2: who hires whom (the serving side does the role), the client record here, the contract as the serving side keeps it. */
  kind?: "client" | "vendor" | "partner"; role?: string | null; weServe?: boolean; clientId?: string | null;
  contract?: { packages: { id: string; name: string; status: string; startsOn: string | null; price: number; instalments: number; paid: number; project: string | null }[]; waiting: number; projects: number } | null };
export type Request = { id: string; company: string; contact: string; email: string | null; project: string | null; status: string; at: string; poc: string | null; joined: string | null };
export type Data = { connections: Connection[]; requests: Request[] | null; canInvite: boolean; me: string; team: Person[]; ai?: Person[] };
type Made = { link: string; warning: string; email: { to: string | null; sent: boolean; why: string; subject: string; body: string } };
type Note = { tone: "ok" | "error" | "info"; text: string } | null;

/** CLIENT-PORTAL 2: who hires whom, in words. */
export function relation(c: Pick<Connection, "kind" | "role" | "weServe" | "weInvited" | "other">) {
  if (c.kind === "partner") return `Partner${c.role ? ` · ${c.role}` : ""}`;
  const serve = c.weServe ?? c.weInvited;
  return serve ? `${c.other.name} hires you${c.role ? ` as ${c.role.toLowerCase()}` : ""}` : `You hire ${c.other.name}${c.role ? ` as ${c.role.toLowerCase()}` : ""}`;
}
const inr = (paise: number) => `₹${(Number(paise) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const day = (s: string) => new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const STATUS: Record<string, string> = { open: "To do", in_progress: "Doing", blocked: "Blocked", done: "Done", in_review: "Done · in review", accepted: "Accepted", cancelled: "Cancelled", unknown: "To do" };

/** Open something that lives in another organisation: switch there (the shared item is reached through my seat), then go. */
async function openThere(org: string, path: string) {
  window.dispatchEvent(new CustomEvent("pulse:org-moving", { detail: { name: "the shared space" } }));
  arrive(await post<Moved>("account/switch", { org }), path);
}

export function ConnectionsView({ data: initial, orgName }: { data: Data; orgName: string }) {
  const [data, setData] = useState(initial);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, work: () => Promise<void>) => { setBusy(key); setNote(null); try { await work(); } catch (e) { setNote({ tone: "error", text: e instanceof Error ? e.message : "That did not work" }); } finally { setBusy(null); } };
  const refresh = async () => { const r = await fetch("/api/v0/connections", { cache: "no-store" }); if (r.ok) setData(await r.json()); };
  return <div className={css.page}>
    {note ? <p className={css.note} data-tone={note.tone} role={note.tone === "error" ? "alert" : "status"}>{note.text}</p> : null}
    <section className={css.section} aria-labelledby="conn-h">
      <div className={css.sectionHead}><h2 id="conn-h">Connected organisations</h2><p>Only the groups and tasks made for a connection are shared. Nothing else of {orgName} is visible to them, and nothing of theirs to you.</p></div>
      {data.connections.length ? data.connections.map((c) => <ConnectionCard key={c.id} c={c} team={data.team.filter((p) => p.id !== data.me)} ai={data.ai ?? []} everyone={data.team} me={data.me} busy={busy} run={run} refresh={refresh} setNote={setNote} />)
        : <p className={css.muted}><Handshake size={14} aria-hidden="true" /> No connections yet. {data.canInvite ? "When you close a deal, invite the client below." : "When a client or partner connects with " + orgName + ", they show here."}</p>}
    </section>
    {data.canInvite ? <InviteClient orgName={orgName} team={data.team} me={data.me} busy={busy} run={run} onMade={refresh} /> : null}
    {data.requests?.length ? <section className={css.section} aria-labelledby="req-h">
      <div className={css.sectionHead}><h2 id="req-h">Client requests</h2></div>
      <div className={css.table}>{data.requests.map((q) => <div className={css.tr} key={q.id}>
        <span><b>{q.company}</b> · {q.contact}{q.project ? ` · ${q.project}` : ""}{q.poc ? ` · contact: ${q.poc}` : ""}{q.joined ? ` · accepted by ${q.joined}` : ""}</span>
        <span className={css.pill} data-tone={q.status === "accepted" ? "teal" : undefined}>{q.status === "open" ? "Waiting" : q.status === "accepted" ? "Connected" : q.status === "revoked" ? "Withdrawn" : "Expired"}</span>
        {q.status === "open" ? <button type="button" className={`${css.btn} ${css.quiet}`} aria-label={`Withdraw the request to ${q.company}`} onClick={() => run(q.id, async () => { await post(`connections/requests/${q.id}/revoke`); await refresh(); })}><X size={14} aria-hidden="true" />Withdraw</button> : null}
      </div>)}</div>
    </section> : null}
  </div>;
}

function ConnectionCard({ c, team, ai, everyone, me, busy, run, refresh, setNote }: { c: Connection; team: Person[]; ai: Person[]; everyone: Person[]; me: string; busy: string | null; run: (k: string, w: () => Promise<void>) => Promise<void>; refresh: () => Promise<void>; setNote: (n: Note) => void }) {
  const [form, setForm] = useState<"group" | "task" | null>(null);
  const router = useRouter();
  const groups = c.shared.filter((s) => s.kind === "chat"), tasks = c.shared.filter((s) => s.kind === "task");
  return <article className={css.card} aria-label={`Connection with ${c.other.name}`} style={{ marginBottom: 12 }}>
    <div className={css.cardHead}><span className={css.tile} data-big="" aria-hidden="true">{orgInitials(c.other.name)}</span>
      <div className={css.cardTitle}><b>{c.other.name}</b><small>{c.other.handle ? `@${c.other.handle} · ` : c.other.individual ? "Individual client · " : ""}{relation(c)} · connected {day(c.since)}{c.project ? ` · ${c.project}` : ""}</small></div></div>
    {c.summary ? <p className={css.muted}>{c.summary}</p> : null}
    {c.contract && (c.contract.packages.length || c.contract.waiting) ? <div className={css.table} aria-label="Contract">
      {c.contract.packages.map((p) => <div className={css.tr} key={p.id}><span><b>{p.name}</b> · {inr(p.price)} + GST{p.startsOn ? ` · from ${day(p.startsOn)}` : ""}{p.project ? ` · ${p.project}` : ""}</span>
        <span className={css.pill} data-tone={p.status === "active" ? "teal" : undefined}>{p.status === "active" ? `${p.paid} of ${p.instalments} paid` : p.status}</span></div>)}
      {c.contract.waiting ? <div className={css.tr}><span>{c.contract.waiting === 1 ? "A quotation waits" : `${c.contract.waiting} quotations wait`} for their answer</span></div> : null}
    </div> : c.weServe && c.clientId ? <p className={css.muted}>No package yet: share a quotation from Billing and it shows in their space.</p> : null}
    {c.clientId ? <p className={css.muted}><a href={`/clients/${c.clientId}?tab=access`}>Open their client record</a></p> : null}
    <Contacts c={c} everyone={everyone} me={me} busy={busy} run={run} refresh={refresh} setNote={setNote} />
    <div className={css.sectionHead}><h3 style={{ margin: "8px 0 4px", fontSize: 15 }}>Shared with {c.other.name}</h3></div>
    {c.shared.length ? <div className={css.table}>
      {groups.map((s) => <div className={css.tr} key={s.id}>
        <span><MessagesSquare size={14} aria-hidden="true" /> <b>{s.title}</b> · {s.here ? `group with ${c.other.name}` : `group in ${s.hostName}`}{s.last ? <> · <span className={css.muted}>{s.lastBy ? `${shortName(s.lastBy)}: ` : ""}{s.last}</span></> : null}</span>
        <ShareOpen s={s} busy={busy} run={run} />
      </div>)}
      {tasks.map((s) => <div className={css.tr} key={s.id}>
        <span><CheckSquare size={14} aria-hidden="true" /> <b>{s.title}</b> · {s.assignee ?? "nobody"}{s.here ? "" : ` · in ${s.hostName}`}</span>
        <span className={css.pill} data-tone={["done", "in_review", "accepted"].includes(s.status ?? "") ? "teal" : undefined}>{STATUS[s.status ?? ""] ?? s.status}</span>
        <ShareOpen s={s} busy={busy} run={run} />
      </div>)}
    </div> : <p className={css.muted}>Nothing shared yet.</p>}
    {c.theirs.length ? <div className={css.cardFoot}>
      <button type="button" className={css.btn} aria-pressed={form === "group"} onClick={() => setForm(form === "group" ? null : "group")}><UsersRound size={15} aria-hidden="true" />New group with {c.other.name}</button>
      <button type="button" className={css.btn} aria-pressed={form === "task"} onClick={() => setForm(form === "task" ? null : "task")}><CheckSquare size={15} aria-hidden="true" />Give a task to {c.other.name}</button>
    </div> : null}
    {form === "group" ? <NewGroup c={c} team={team} ai={ai} busy={busy} run={run} done={async (id) => { setForm(null); setNote({ tone: "ok", text: "Group made. Opening it…" }); await refresh(); router.push(`/chats?channel=${id}`); }} /> : null}
    {form === "task" ? <GiveTask c={c} busy={busy} run={run} done={async () => { setForm(null); setNote({ tone: "ok", text: `Task given to ${c.other.name}.` }); await refresh(); }} /> : null}
    {c.canManage ? <EndConnection c={c} busy={busy} run={run} done={async () => { setNote({ tone: "ok", text: `The connection with ${c.other.name} has ended. What you shared stays here.` }); await refresh(); }} /> : null}
  </article>;
}

/** CONNECT 2: end the connection, after saying what happens (0986). */
function EndConnection({ c, busy, run, done }: { c: Connection; busy: string | null; run: (k: string, w: () => Promise<void>) => Promise<void>; done: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <div className={css.cardFoot} style={{ justifyContent: "flex-end" }}>
    <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setAsking(true)}>End connection</button></div>;
  return <div className={css.cardFoot} role="group" aria-label={`End the connection with ${c.other.name}`} style={{ flexWrap: "wrap" }}>
    <p className={css.muted} style={{ flex: "1 1 280px", margin: 0 }}>{c.other.name}’s contacts leave your shared groups and your contacts leave theirs. Groups keep their history; tasks stay with whoever gave them. You can connect again later.</p>
    <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setAsking(false)}>Keep it</button>
    <button type="button" className={css.btn} style={{ color: "var(--lx-danger)" }} disabled={!!busy} onClick={() => void run(`end:${c.id}`, async () => { await post(`connections/${c.id}/end`); setAsking(false); await done(); })}>
      {busy === `end:${c.id}` ? "Ending…" : "End connection"}</button>
  </div>;
}

/** Both sides' points of contact. Whoever manages connections here adds people of their own team (each gets a seat in
 *  the other organisation) and removes them; a side always keeps one. */
function Contacts({ c, everyone, me, busy, run, refresh, setNote }: { c: Connection; everyone: Person[]; me: string; busy: string | null; run: (k: string, w: () => Promise<void>) => Promise<void>; refresh: () => Promise<void>; setNote: (n: Note) => void }) {
  const free = everyone.filter((p) => !c.ours.some((o) => o.person === p.id));
  const [pick, setPick] = useState("");
  const chosen = free.some((p) => p.id === pick) ? pick : "";
  const manage = !!c.canManage;
  const add = () => run(`add:${c.id}`, async () => {
    const name = free.find((p) => p.id === chosen)?.name ?? "They";
    await post(`connections/${c.id}/contacts`, { person: chosen }); setPick(""); await refresh();
    setNote({ tone: "ok", text: `${name} is now a contact for ${c.other.name}.` });
  });
  const remove = (seat: string, name: string) => run(`rm:${seat}`, async () => {
    await post(`connections/${c.id}/contacts/${seat}/remove`); await refresh();
    setNote({ tone: "ok", text: `${name} is no longer a contact for ${c.other.name}.` });
  });
  return <div className={css.contactCols}>
    <div><small className={css.contactHead}>Their contacts</small>
      <ul className={css.contactList} aria-label={`Contacts from ${c.other.name}`}>{c.theirs.length ? c.theirs.map((p) => <li key={p.seat}>{p.name}</li>) : <li className={css.muted}>None yet</li>}</ul></div>
    <div><small className={css.contactHead}>Our contacts</small>
      <ul className={css.contactList} aria-label="Our contacts">{c.ours.length ? c.ours.map((p) => <li key={p.seat}><span>{p.name}{p.person === me ? " (you)" : ""}</span>
        {manage && c.ours.length > 1 ? <button type="button" className={`${css.btn} ${css.quiet} ${css.contactRemove}`} disabled={!!busy} aria-label={`Remove ${p.name} as a contact`}
          onClick={() => void remove(p.seat, p.name)}>{busy === `rm:${p.seat}` ? "Removing…" : "Remove"}</button> : null}</li>) : <li className={css.muted}>None yet</li>}</ul>
      {manage && free.length ? <div className={css.contactAdd}>
        <SelectField className={css.input} value={chosen} onChange={(e) => setPick(e.target.value)} aria-label={`Add a contact for ${c.other.name}`}>
          <option value="">Add a contact…</option>{free.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === me ? " (you)" : ""}</option>)}</SelectField>
        <button type="button" className={css.btn} disabled={!!busy || !chosen} onClick={() => void add()}><Plus size={14} aria-hidden="true" />{busy === `add:${c.id}` ? "Adding…" : "Add"}</button>
      </div> : null}</div>
  </div>;
}

function ShareOpen({ s, busy, run }: { s: Shared; busy: string | null; run: (k: string, w: () => Promise<void>) => Promise<void> }) {
  const path = s.kind === "chat" ? `/chats?channel=${s.ref}` : `/tasks/${s.ref}`;
  return s.here ? <a className={css.btn} href={path}>Open<ArrowRight size={14} aria-hidden="true" /></a>
    : <button type="button" className={css.btn} disabled={!!busy} onClick={() => run(s.id, () => openThere(s.hostOrg, path))}>{busy === s.id ? "Opening…" : <>Open in {s.hostName}<ArrowRight size={14} aria-hidden="true" /></>}</button>;
}

/** SIM-CLIENTS R139: who wrote last, short: a person's first name; an AI employee's whole name ("Project: …" read as a label). */
const shortName = (n: string) => /\(AI\)\s*$/.test(n) ? n : n.split(" ")[0];

function NewGroup({ c, team, ai, busy, run, done }: { c: Connection; team: Person[]; ai: Person[]; busy: string | null; run: (k: string, w: () => Promise<void>) => Promise<void>; done: (id: string) => Promise<void> }) {
  const [name, setName] = useState(`${c.other.name}${c.project ? ` · ${c.project}` : ""}`.slice(0, 60));
  const [picked, setPicked] = useState<Set<string>>(new Set(c.theirs.map((p) => p.person)));
  const [q, setQ] = useState("");
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const shown = team.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase())).slice(0, 12);
  const submit = (e: FormEvent) => { e.preventDefault(); void run("group", async () => { const r = await post<{ id: string }>(`connections/${c.id}/groups`, { name, memberIds: [...picked] }); await done(r.id); }); };
  return <form className={css.form} onSubmit={submit} aria-label={`New group with ${c.other.name}`}>
    <label className={css.field}>Group name<input className={css.input} value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={60} required /></label>
    <fieldset className={css.group} style={{ border: 0, padding: 0 }}><legend className={css.muted}>From {c.other.name}</legend>
      {c.theirs.map((p) => <label key={p.person} className={css.check}><input type="checkbox" checked={picked.has(p.person)} onChange={() => toggle(p.person)} /> {p.name}</label>)}</fieldset>
    <fieldset className={css.group} style={{ border: 0, padding: 0 }}><legend className={css.muted}>From your team (you are in it)</legend>
      <input className={css.input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a teammate" aria-label="Find a teammate" />
      {shown.map((p) => <label key={p.id} className={css.check}><input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} /> {p.name}</label>)}</fieldset>
    {/* SIM-CLIENTS R138: AI employees can be in the group from the start; with a client there they ask a person before anything is posted. */}
    {ai.length ? <fieldset className={css.group} style={{ border: 0, padding: 0 }}><legend className={css.muted}>AI employees (they ask a person before they post with a client)</legend>
      {ai.map((p) => <label key={p.id} className={css.check}><input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} /> {p.name}</label>)}</fieldset> : null}
    <div className={css.cardFoot}><button className={`${css.btn} ${css.primary}`} disabled={busy === "group"}><Plus size={15} aria-hidden="true" />{busy === "group" ? "Making…" : "Make the group"}</button></div>
  </form>;
}

const readBase64 = (f: File) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] ?? ""); r.onerror = () => no(new Error("Could not read the file")); r.readAsDataURL(f); });
const MAX_FILE = 5 * 1024 * 1024;

function GiveTask({ c, busy, run, done }: { c: Connection; busy: string | null; run: (k: string, w: () => Promise<void>) => Promise<void>; done: () => Promise<void> }) {
  const [title, setTitle] = useState(""); const [who, setWho] = useState(c.theirs[0]?.person ?? ""); const [due, setDue] = useState(""); const [notes, setNotes] = useState("");
  // SIM-CLIENTS R140: what the client is asked to approve goes with the task: a file up to 5 MB, or a link (Drive, YouTube).
  const [file, setFile] = useState<File | null>(null); const [link, setLink] = useState("");
  const tooBig = !!file && file.size > MAX_FILE, badLink = !!link.trim() && !/^https?:\/\/\S+$/.test(link.trim());
  const submit = (e: FormEvent) => { e.preventDefault(); void run("task", async () => {
    const t = await post<{ id: string }>(`connections/${c.id}/tasks`, { title, assigneeId: who, dueOn: due || undefined, notes });
    let missed = "";
    try {
      if (file) await post(`tasks/${t.id}/attachments`, { name: file.name, mime: file.type || "application/octet-stream", bytes: await readBase64(file), label: file.name });
      if (link.trim()) await post(`tasks/${t.id}/attachments`, { url: link.trim(), label: "" });
    } catch (err) { missed = err instanceof Error ? err.message : "The attachment did not go with it"; }
    notify({ id: "connect-task", tone: missed ? "error" : "success", title: "Task given", message: missed ? `“${title}” is in ${c.other.name}'s Work, without the attachment: ${missed}` : `“${title}” is in ${c.other.name}'s Work now.`, timeout: missed ? 8000 : 3500 });
    setTitle(""); setNotes(""); setFile(null); setLink(""); await done(); }); };
  return <form className={css.form} onSubmit={submit} aria-label={`Give a task to ${c.other.name}`}>
    <label className={css.field}>Task<input className={css.input} value={title} onChange={(e) => setTitle(e.target.value)} minLength={2} maxLength={300} required placeholder="Share the site photos and floor plans" /></label>
    <div className={css.row}>
      <label className={css.field}>For<SelectField className={css.input} value={who} onChange={(e) => setWho(e.target.value)}>{c.theirs.map((p) => <option key={p.person} value={p.person}>{p.name} ({c.other.name})</option>)}</SelectField></label>
      <label className={css.field}>Due <small>(optional)</small><DateField className={css.input} value={due} onChange={(e) => setDue(e.target.value)} /></label>
    </div>
    <label className={css.field}>Notes <small>(optional)</small><textarea className={css.textarea} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} rows={2} /></label>
    <div className={css.row}>
      <label className={css.field}>Attach a file <small>(optional, up to 5 MB: picture, PDF, document)</small><input className={css.input} type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv,application/zip,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      <label className={css.field}>Or a link <small>(optional: the reel on Drive or YouTube)</small><input className={css.input} type="url" value={link} onChange={(e) => setLink(e.target.value)} maxLength={2000} placeholder="https://drive.google.com/…" /></label>
    </div>
    {tooBig ? <p className={css.note} data-tone="error" role="alert">That file is over 5 MB: share it on Drive and paste the link instead.</p> : badLink ? <p className={css.note} data-tone="error" role="alert">Paste the whole link, starting with https://</p> : null}
    <div className={css.cardFoot}><button className={`${css.btn} ${css.primary}`} disabled={busy === "task" || !who || tooBig || badLink}><Send size={15} aria-hidden="true" />{busy === "task" ? "Giving…" : "Give the task"}</button>
      <span className={css.muted}>It stays in your Work; you review it when they finish.</span></div>
  </form>;
}

function InviteClient({ orgName, team, me, busy, run, onMade }: { orgName: string; team: Person[]; me: string; busy: string | null; run: (k: string, w: () => Promise<void>) => Promise<void>; onMade: () => Promise<void> }) {
  const empty = { company: "", contact: "", email: "", phone: "", project: "", summary: "", poc: me, kind: "client", role: "" };
  const [f, setF] = useState(empty);
  const [made, setMade] = useState<Made | null>(null); const [copied, setCopied] = useState(false);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = (e: FormEvent) => { e.preventDefault(); setMade(null); setCopied(false); void run("invite", async () => { setMade(await post<Made>("connections/requests", f)); setF(empty); await onMade(); }); };
  const copy = async () => { if (!made) return; try { await navigator.clipboard.writeText(made.link); setCopied(true); } catch { setCopied(false); } };
  return <section className={css.section} aria-labelledby="invite-client-h">
    <div className={css.sectionHead}><h2 id="invite-client-h">Invite a client, vendor or partner</h2><p>Closed a deal? Fill in what you know: the client opens one link, sets up their organisation from it and connects with {orgName}. It also counts as a referral to Pulse.</p></div>
    <form className={`${css.card} ${css.form}`} onSubmit={submit} aria-label="Client request">
      <div className={css.row}>
        <label className={css.field}>They are<SelectField className={css.input} value={f.kind} onChange={set("kind")}><option value="client">Our client (they hire us)</option><option value="vendor">Our vendor (we hire them)</option><option value="partner">A partner</option></SelectField></label>
        <label className={css.field}>{f.kind === "vendor" ? "What they do for you" : f.kind === "partner" ? "The partnership" : "What you are to them"} <small>(optional)</small><input className={css.input} value={f.role} onChange={set("role")} maxLength={80} placeholder={f.kind === "vendor" ? "Developer" : f.kind === "partner" ? "Referral partner" : "Marketing agency"} /></label>
      </div>
      <div className={css.row}>
        <label className={css.field}>{f.kind === "client" ? "Client company" : "Company"}<input className={css.input} value={f.company} onChange={set("company")} required minLength={2} maxLength={80} placeholder="Skyline Homes" /></label>
        <label className={css.field}>Contact name<input className={css.input} value={f.contact} onChange={set("contact")} required minLength={2} maxLength={120} placeholder="Rila Mifos" /></label>
      </div>
      <div className={css.row}>
        <label className={css.field}>Contact e-mail <small>(optional)</small><input className={css.input} type="email" value={f.email} onChange={set("email")} maxLength={254} /></label>
        <label className={css.field}>Contact phone <small>(optional)</small><input className={css.input} type="tel" value={f.phone} onChange={set("phone")} maxLength={40} /></label>
      </div>
      <div className={css.row}>
        <label className={css.field}>Project <small>(optional)</small><input className={css.input} value={f.project} onChange={set("project")} maxLength={160} placeholder="Website and lead capture" /></label>
        <label className={css.field}>Their point of contact here<SelectField className={css.input} value={f.poc} onChange={set("poc")}>{team.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === me ? " (you)" : ""}</option>)}</SelectField></label>
      </div>
      <label className={css.field}>Deal summary <small>(optional; the client sees it)</small><textarea className={css.textarea} value={f.summary} onChange={set("summary")} maxLength={2000} rows={3} /></label>
      <div className={css.cardFoot}><button className={`${css.btn} ${css.primary}`} disabled={busy === "invite"}><Link2 size={15} aria-hidden="true" />{busy === "invite" ? "Preparing…" : "Make the client link"}</button></div>
      {made ? <div aria-label="Client link" role="group">
        <div className={css.linkBox}><code data-client-link="">{made.link}</code><button type="button" className={css.btn} onClick={copy}>{copied ? <><Check size={14} aria-hidden="true" />Copied</> : <><Copy size={14} aria-hidden="true" />Copy</>}</button>
          {/* FEATURES-1024 (CONNECT 2): send it on WhatsApp, where most clients are; the message is written, nothing is sent until they press send. */}
          <a className={css.btn} href={`https://wa.me/?text=${encodeURIComponent(`${orgName} invites you to work together on Pulse. Open this link to set up your account (it works for 30 days): ${made.link}`)}`} target="_blank" rel="noreferrer" data-whatsapp-share=""><Send size={14} aria-hidden="true" />WhatsApp</a></div>
        <div className={css.row} style={{ alignItems: "flex-start" }}>
          <Qr text={made.link} label="Scan to open the client link" />
          <div className={css.card} style={{ flex: "1 1 220px", minWidth: 0 }} aria-label="E-mail preview">
            <small className={css.muted}><Mail size={13} aria-hidden="true" /> E-mail {made.email.to ? `to ${made.email.to}` : "(no address given)"} · not sent</small>
            <b>{made.email.subject}</b>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit", margin: 0 }}>{made.email.body}</pre>
            <small className={css.muted}>{made.email.why}</small>
          </div>
        </div>
        <p className={css.muted}>{made.warning} It works for 30 days.</p>
      </div> : null}
    </form>
  </section>;
}
