"use client";
// CLIENT-PORTAL: a client's home at the organisation that serves them. Phone first, plain words, every card has a next
// step. Data: GET /api/v0/client-portal (pulse.cp_home); the client sees only their own record's rows.
import { ArrowRight, Check, CheckCircle2, ChevronDown, CircleHelp, Copy, FileText, FolderOpen, History, MessageCircle, Phone, Plus, Receipt, Send, Share2, Sparkles, UserPlus, Users, Video, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { startCall } from "../calls/call-host";
import css from "./client.module.css";
import { ClaimLine, Creatives, DeliverableRow, PayNow, Settings, Tour, steps, type More, type PayTarget } from "./space-more";

export type Doc = { id: string; documentId: string; docType: string; number: string | null; status: string; issueDate: string | null; validUntil: string | null; taxable: number; tax: number; total: number;
  note: string | null; sharedAt: string; decision: "accepted" | "changes" | "declined" | null; decidedAt: string | null; decidedName: string | null; decisionNote: string | null; canDecide: boolean; expired: boolean;
  lines: { name: string; details: string | null; qty: number; rate: number; gstRate: number; total: number }[]; hasPdf: boolean };
export type Space = {
  provider: { name: string; handle: string | null; code: string | null }; role: string | null; kind: string; connection: string; since: string;
  client: { name: string; org: string | null; record: boolean }; me: { id: string; name: string };
  historyOffer: boolean; historyOptIn: string | null;
  team: { person: string; name: string; role: string | null }[]; colleagues: { person: string; name: string; me: boolean }[]; invited: { id: string; name: string; at: string }[];
  chats: { id: string; name: string; kind: string; lastAt: string | null; last: string | null; lastBy: string | null; unread: number }[];
  projects: { id: string; title: string; status: string; location: string | null; startsOn: string | null; endsOn: string | null; deliveries: number; lastDeliveredAt: string | null;
    latest: { name: string; kind: string | null; at: string; mime: string | null }[] }[];
  tasks: { id: string; title: string; status: string; dueAt: string | null; by: string | null }[];
  documents: Doc[];
  invoices: { id: string; number: string | null; status: string; issueDate: string | null; dueDate: string | null; total: number; paid: number; balance: number; overdue: boolean; hasPdf: boolean }[];
  contracts: { id: string; name: string; status: string; startsOn: string | null; price: number; gstRate: number; project: string | null; package: string | null;
    instalments: { label: string; amount: number; dueOn: string | null; invoiced: boolean; paid: boolean; number: string | null }[] }[];
  requests: { id: string; kind: string; title: string; at: string; by: string | null; status: string | null; taskId: string | null; assignee: string | null }[];
  timeline: { at: string; kind: string; text: string }[];
} & More;

const ZONE = "Asia/Kolkata";
export const money = (paise: number) => `₹${(Number(paise) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
export const day = (s: string | null | undefined) => s ? new Date(s.length === 10 ? `${s}T12:00:00+05:30` : s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: ZONE }) : "";
const when = (s: string) => {
  const d = new Date(s), mins = (Date.now() - d.getTime()) / 60000;
  if (mins < 1) return "just now"; if (mins < 60) return `${Math.round(mins)} min ago`; if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: ZONE });
};
const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const PROJECT: Record<string, [string, string]> = { onboarding: ["Getting started", "info"], active: ["In progress", "teal"], paused: ["Paused", "warn"], done: ["Done", "ok"], cancelled: ["Stopped", "muted"] };
const TASK: Record<string, string> = { open: "To do", unknown: "To do", in_progress: "Being worked on", blocked: "Stuck", in_review: "Done, being checked", done: "Done", accepted: "Done", cancelled: "Closed" };
const DOC: Record<string, string> = { quotation: "Quotation", proforma: "Proforma invoice", invoice: "Invoice", credit_note: "Credit note" };
const REQUEST: Record<string, string> = { request: "Request", change: "Change", question: "Question", problem: "Problem" };

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "That did not work. Try again.");
  return data as T;
}

function Section({ id, title, count, action, children }: { id: string; title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return <section className={css.section} aria-labelledby={`${id}-h`} id={id}>
    <div className={css.sectionHead}><h2 id={`${id}-h`}>{title}{count ? <span className={css.count}>{count}</span> : null}</h2>{action}</div>
    {children}
  </section>;
}

export function ClientSpace({ data: initial, digestOff = false }: { data: Space; digestOff?: boolean }) {
  const [data, setData] = useState(initial);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  const router = useRouter();
  // PORTAL-2: the first-sign-in tour (once; again from Notifications and sign-in), and paying from an invoice or instalment.
  const [tour, setTour] = useState(!initial.prefs?.tourDone);
  const [payFor, setPayFor] = useState<PayTarget | null>(null);
  useEffect(() => { if (!digestOff || !initial.prefs?.digest) return;
    void post<{ prefs: More["prefs"] }>("client-portal/prefs", { digest: false }).then((r) => { setData((x) => ({ ...x, prefs: r.prefs })); setNote({ tone: "ok", text: "Done: no more daily e-mails. Turn them on again under Notifications and sign-in." }); }).catch(() => {}); },
  [digestOff, initial.prefs?.digest]);
  const endTour = () => { setTour(false); if (!data.prefs?.tourDone) void post<{ prefs: More["prefs"] }>("client-portal/prefs", { tourDone: true }).then((r) => setData((x) => ({ ...x, prefs: r.prefs }))).catch(() => {}); };
  const refresh = async () => { const r = await fetch("/api/v0/client-portal", { cache: "no-store" }); if (r.ok) setData(await r.json()); };
  const run = async (key: string, work: () => Promise<void>, done?: string) => {
    setBusy(key); setNote(null);
    try { await work(); if (done) setNote({ tone: "ok", text: done }); } catch (e) { setNote({ tone: "error", text: e instanceof Error ? e.message : "That did not work" }); } finally { setBusy(null); }
  };
  const group = async () => (await post<{ id: string }>("client-portal/chat")).id;
  const openChat = () => run("chat", async () => { router.push(`/chats?channel=${await group()}`); });
  const call = (video: boolean) => run(video ? "video" : "voice", async () => { startCall(await group(), video); });

  const waiting = data.documents.filter((d) => d.canDecide);
  const toCheck = (data.deliverables ?? []).filter((d) => d.state === "waiting");
  const unread = data.chats.reduce((n, c) => n + (c.unread || 0), 0);
  const contact = data.team[0];
  const todo = waiting.length + toCheck.length + data.tasks.length;
  const hasMoney = data.invoices.length > 0 || data.contracts.length > 0 || data.documents.some((d) => !d.canDecide);

  return <div className={css.page}>
    <header className={css.hero}>
      <p className={css.kicker}>{data.provider.name}{data.role ? ` · ${data.role}` : ""}</p>
      <h2 className={css.hello} id="hello">Hi {first(data.me.name)}</h2>
      <p className={css.lead}>{todo ? <>{todo === 1 ? "One thing needs you" : `${todo} things need you`}. Everything else about your work with {data.provider.name} is below.</>
        : <>Nothing needs you right now. Here is how your work with {data.provider.name} is going.</>}</p>
      <div className={css.actions} id="hero-actions">
        <button type="button" className={`${css.btn} ${css.primary}`} onClick={openChat} disabled={!!busy}><MessageCircle size={16} aria-hidden="true" />Message team{unread ? <span className={css.dot}>{unread}</span> : null}</button>
        <button type="button" className={css.btn} onClick={() => call(false)} disabled={!!busy || !contact}><Phone size={16} aria-hidden="true" />Call</button>
        <button type="button" className={css.btn} onClick={() => call(true)} disabled={!!busy || !contact}><Video size={16} aria-hidden="true" />Video call</button>
        <button type="button" className={css.btn} onClick={() => setAsk((v) => !v)} aria-expanded={ask}><Plus size={16} aria-hidden="true" />Ask for something</button>
      </div>
      {ask ? <AskForm onDone={async () => { setAsk(false); await refresh(); setNote({ tone: "ok", text: `Sent. ${contact ? first(contact.name) : "Your team"} will pick it up.` }); }} onCancel={() => setAsk(false)} /> : null}
    </header>
    {note ? <p className={css.note} data-tone={note.tone} role={note.tone === "error" ? "alert" : "status"}>{note.text}</p> : null}

    {data.historyOffer && !data.historyOptIn ? <div className={css.offer}>
      <History size={18} aria-hidden="true" />
      <div><b>See your past conversations here?</b><p>Your earlier WhatsApp messages and files with {data.provider.name} can show in your chats on Pulse. Only you and your team see them. You can turn this off any time.</p></div>
      <button type="button" className={`${css.btn} ${css.primary}`} disabled={!!busy} onClick={() => run("history", async () => { await post("client-portal/history", { yes: true }); await refresh(); }, "Done. Your past conversations will show in Chats.")}>Yes, show them</button>
    </div> : null}

    <div className={css.grid}>
      <div className={css.col}>
        {todo ? <Section id="todo" title="Waiting for you" count={todo}>
          {toCheck.map((d) => <DeliverableRow key={d.id} d={d} todo />)}
          {waiting.map((d) => <DocCard key={d.id} d={d} me={data.me.name} onAnswered={async (t) => { await refresh(); setNote({ tone: "ok", text: t }); }} />)}
          {data.tasks.map((t) => <Link key={t.id} href={`/tasks/${t.id}`} className={css.item} data-tone="todo">
            <CheckCircle2 size={18} aria-hidden="true" />
            <span className={css.itemMain}><b>{t.title}</b><small>{t.by ? `From ${t.by}` : "For you"}{t.dueAt ? ` · by ${day(t.dueAt)}` : ""}</small></span>
            <span className={css.go}>Open<ArrowRight size={14} aria-hidden="true" /></span>
          </Link>)}
        </Section> : null}

        <Section id="projects" title="Your projects" count={data.projects.length}>
          {data.projects.length ? data.projects.map((p) => { const [label, tone] = PROJECT[p.status] ?? [p.status, "muted"]; return <article key={p.id} className={css.card}>
            <div className={css.cardHead}><FolderOpen size={18} aria-hidden="true" /><b>{p.title}</b><span className={css.pill} data-tone={tone}>{label}</span></div>
            <p className={css.meta}>{[p.location, p.startsOn ? `Started ${day(p.startsOn)}` : null, p.deliveries ? `${p.deliveries} ${p.deliveries === 1 ? "delivery" : "deliveries"}` : "Nothing delivered yet"].filter(Boolean).join(" · ")}</p>
            {p.latest.length ? <ul className={css.files}>{p.latest.map((f, i) => <li key={i}><span>{f.name}</span><small suppressHydrationWarning>{when(f.at)}</small></li>)}</ul> : null}
          </article>; }) : <p className={css.empty}>Your projects show here as soon as work starts.</p>}
        </Section>

        <Creatives items={data.deliverables ?? []} />

        <Section id="chats" title="Chats" count={unread || undefined} action={<button type="button" className={`${css.btn} ${css.quiet}`} onClick={openChat} disabled={!!busy}>Open chat<ArrowRight size={14} aria-hidden="true" /></button>}>
          {data.chats.length ? data.chats.slice(0, 5).map((c) => <Link key={c.id} href={`/chats?channel=${c.id}`} className={css.item}>
            <MessageCircle size={18} aria-hidden="true" />
            <span className={css.itemMain}><b>{c.name}</b><small>{c.last ? `${c.lastBy ? `${first(c.lastBy)}: ` : ""}${c.last}` : "No messages yet"}</small></span>
            {c.unread ? <span className={css.dot}>{c.unread}</span> : c.lastAt ? <small className={css.time} suppressHydrationWarning>{when(c.lastAt)}</small> : null}
          </Link>) : <p className={css.empty}>Start a chat with your team: “Message the team” above.</p>}
        </Section>

        <Section id="requests" title="Your requests" count={data.requests.length || undefined} action={<button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => { setAsk(true); window.scrollTo({ top: 0, behavior: "smooth" }); }}><Plus size={14} aria-hidden="true" />New</button>}>
          {data.requests.length ? data.requests.slice(0, 8).map((r) => <Link key={r.id} href={r.taskId ? `/tasks/${r.taskId}` : "#"} className={css.item}>
            <CircleHelp size={18} aria-hidden="true" />
            <span className={css.itemMain}><b>{r.title}</b><small suppressHydrationWarning>{REQUEST[r.kind] ?? r.kind} · {when(r.at)}{r.assignee ? ` · with ${first(r.assignee)}` : ""}</small></span>
            <span className={css.pill} data-tone={["done", "accepted", "in_review"].includes(r.status ?? "") ? "ok" : "info"}>{TASK[r.status ?? ""] ?? "Sent"}</span>
          </Link>) : <p className={css.empty}>Need a change, a new creative or an answer? Ask here and it reaches your team as a task you can follow.</p>}
        </Section>
      </div>

      <div className={css.col}>
        <Section id="team" title={`Your team at ${data.provider.name}`}>
          {data.team.length ? data.team.map((t) => <div key={t.person} className={css.item}>
            <span className={css.face} aria-hidden="true">{t.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("")}</span>
            <span className={css.itemMain}><b>{t.name}</b><small>{t.role ?? "Your contact"}</small></span>
          </div>) : <p className={css.empty}>Your contact will show here.</p>}
        </Section>

        <Money data={data} payFor={payFor} setPayFor={setPayFor} onPaid={async (t) => { setPayFor(null); await refresh(); setNote({ tone: "ok", text: t }); window.scrollTo({ top: 0, behavior: "smooth" }); }} />

        <Section id="happening" title="What’s happening">
          {data.timeline.length ? <ol className={css.timeline}>{data.timeline.slice(0, 12).map((e, i) => <li key={i} data-kind={e.kind}><span>{e.text}</span><small suppressHydrationWarning>{when(e.at)}</small></li>)}</ol>
            : <p className={css.empty}>Updates show here as work moves.</p>}
        </Section>

        <People data={data} refresh={refresh} />
        <Settings more={data} onChange={(patch) => setData((x) => ({ ...x, ...patch }))} onTour={() => setTour(true)} />
      </div>
    </div>
    {tour ? <Tour list={steps({ todo: todo > 0, money: hasMoney }, data.provider.name)} onEnd={endTour} /> : null}
  </div>;
}

function AskForm({ onDone, onCancel }: { onDone: () => Promise<void>; onCancel: () => void }) {
  const [kind, setKind] = useState("request"); const [title, setTitle] = useState(""); const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const send = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(null);
    try { await post("client-portal/requests", { kind, title, body }); await onDone(); } catch (err) { setError(err instanceof Error ? err.message : "Could not send"); setBusy(false); } };
  return <form className={css.form} onSubmit={send} aria-label="Ask for something">
    <div className={css.chips} role="radiogroup" aria-label="What is it">
      {Object.entries(REQUEST).map(([k, label]) => <button type="button" key={k} role="radio" aria-checked={kind === k} className={css.chip} onClick={() => setKind(k)}>{label}</button>)}
    </div>
    <label className={css.field}>In a few words<input className={css.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: change the brochure cover" required minLength={2} maxLength={200} autoFocus /></label>
    <label className={css.field}>Details <small>(optional)</small><textarea className={css.input} rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} /></label>
    {error ? <p className={css.note} data-tone="error" role="alert">{error}</p> : null}
    <div className={css.actions}><button className={`${css.btn} ${css.primary}`} disabled={busy}><Send size={15} aria-hidden="true" />{busy ? "Sending…" : "Send"}</button><button type="button" className={`${css.btn} ${css.quiet}`} onClick={onCancel}>Cancel</button></div>
  </form>;
}

export function DocCard({ d, me, onAnswered }: { d: Doc; me: string; onAnswered: (text: string) => Promise<void> }) {
  const [open, setOpen] = useState<"accepted" | "changes" | "declined" | null>(null);
  const [lines, setLines] = useState(false);
  const [name, setName] = useState(me); const [text, setText] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const answer = async (e: FormEvent) => { e.preventDefault(); if (!open) return; setBusy(true); setError(null);
    try { await post(`client-portal/documents/${d.id}/answer`, { decision: open, name, note: text });
      await onAnswered(open === "accepted" ? "Thank you. Your team has been told and will start right away." : open === "changes" ? "Sent. Your team will send an updated quotation." : "Noted. Your team has been told.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not send"); setBusy(false); } };
  return <article className={css.card} data-tone="todo">
    <div className={css.cardHead}><FileText size={18} aria-hidden="true" /><b>{DOC[d.docType] ?? d.docType} {d.number ?? ""}</b><span className={css.amount}>{money(d.total)}</span></div>
    <p className={css.meta}>{d.validUntil ? `Valid until ${day(d.validUntil)}` : `Shared ${day(d.sharedAt)}`} · {money(d.taxable)} + GST {money(d.tax)}</p>
    {d.note ? <p className={css.quote}>{d.note}</p> : null}
    <button type="button" className={css.linkBtn} onClick={() => setLines((v) => !v)} aria-expanded={lines}><ChevronDown size={14} aria-hidden="true" data-open={lines ? "" : undefined} />{lines ? "Hide what is included" : "What is included"}</button>
    {lines ? <ul className={css.lines}>{d.lines.map((l, i) => <li key={i}><span>{l.name}{l.details ? <small>{l.details}</small> : null}</span><b>{money(l.total)}</b></li>)}</ul> : null}
    <div className={css.actions}>
      {d.hasPdf ? <a className={css.btn} href={`/api/v0/client-portal/documents/${d.documentId}/pdf`} target="_blank" rel="noreferrer"><FileText size={15} aria-hidden="true" />PDF</a> : null}
      <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => setOpen("accepted")} aria-pressed={open === "accepted"}><Check size={15} aria-hidden="true" />Accept</button>
      <button type="button" className={css.btn} onClick={() => setOpen("changes")} aria-pressed={open === "changes"}>Ask for changes</button>
      <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setOpen("declined")} aria-pressed={open === "declined"}><X size={15} aria-hidden="true" />Decline</button>
    </div>
    {open ? <form className={css.form} onSubmit={answer}>
      {open === "accepted" ? <label className={css.field}>Type your full name to accept<input className={css.input} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} autoComplete="name" /></label> : null}
      <label className={css.field}>{open === "changes" ? "What should change?" : open === "declined" ? "Anything to tell the team? (optional)" : "A note (optional)"}
        <textarea className={css.input} rows={3} value={text} onChange={(e) => setText(e.target.value)} required={open === "changes"} maxLength={2000} /></label>
      {error ? <p className={css.note} data-tone="error" role="alert">{error}</p> : null}
      <div className={css.actions}><button className={`${css.btn} ${css.primary}`} disabled={busy}>{busy ? "Sending…" : open === "accepted" ? "Accept the quotation" : open === "changes" ? "Send" : "Decline"}</button>
        <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setOpen(null)}>Back</button></div>
      {open === "accepted" ? <p className={css.fine}>Accepting records your name, the time and this quotation as your agreement. Your project and payment schedule start from it.</p> : null}
    </form> : null}
  </article>;
}

function Money({ data, payFor, setPayFor, onPaid }: { data: Space; payFor: PayTarget | null; setPayFor: (t: PayTarget | null) => void; onPaid: (text: string) => Promise<void> }) {
  const answered = data.documents.filter((d) => !d.canDecide);
  if (!data.invoices.length && !data.contracts.length && !answered.length) return null;
  const claimFor = (documentId: string | null, milestoneId?: string) => (data.claims ?? []).find((c) => (documentId && c.documentId === documentId) || (milestoneId && c.milestoneId === milestoneId));
  const payForm = (key: string) => payFor && data.pay && payFor.id === key ? <PayNow target={payFor} pay={data.pay} onDone={onPaid} onCancel={() => setPayFor(null)} /> : null;
  return <Section id="money" title="Payments and documents">
    {data.invoices.map((i) => { const claim = claimFor(i.id); const waitingClaim = claim?.state === "waiting"; return <div key={i.id} className={css.moneyRow}>
      <div className={css.item} data-tone={i.overdue ? "warn" : undefined}>
        <Receipt size={18} aria-hidden="true" />
        <span className={css.itemMain}><b>Invoice {i.number}</b><small>{money(i.total)} · {i.balance > 0 ? `${money(i.balance)} to pay${i.dueDate ? ` by ${day(i.dueDate)}` : ""}` : "Paid"}</small></span>
        <span className={css.pill} data-tone={i.balance <= 0 ? "ok" : waitingClaim ? "info" : i.overdue ? "warn" : "info"}>{i.balance <= 0 ? "Paid" : waitingClaim ? "Checking" : i.overdue ? "Overdue" : i.paid > 0 ? "Part paid" : "To pay"}</span>
        {i.hasPdf ? <a className={`${css.btn} ${css.quiet}`} href={`/api/v0/client-portal/documents/${i.id}/pdf`} target="_blank" rel="noreferrer" aria-label={`Invoice ${i.number} PDF`}><FileText size={15} aria-hidden="true" /></a> : null}
      </div>
      {i.balance > 0 && data.pay && !waitingClaim && payFor?.id !== i.id ? <button type="button" className={`${css.btn} ${css.primary} ${css.payBtn}`} onClick={() => setPayFor({ kind: "invoice", id: i.id, documentId: i.id, label: `Invoice ${i.number ?? ""}`.trim(), balance: i.balance })}>Pay now</button> : null}
      {claim && (claim.state !== "confirmed" || i.balance > 0) ? <ClaimLine c={claim} /> : null}
      {payForm(i.id)}
    </div>; })}
    {data.contracts.map((c) => <article key={c.id} className={css.card}>
      <div className={css.cardHead}><Sparkles size={18} aria-hidden="true" /><b>{c.package ?? c.name}</b><span className={css.amount}>{money(c.price)}<small> + GST</small></span></div>
      <p className={css.meta}>{[c.project, c.startsOn ? `From ${day(c.startsOn)}` : null].filter(Boolean).join(" · ")}</p>
      <ul className={css.lines}>{c.instalments.map((m, i) => { const ref = data.instalments?.[c.id]?.[i]; const claim = ref ? claimFor(ref.documentId, ref.id) : undefined;
        const canPay = !!data.pay && !!ref && !m.paid && ref.balance > 0 && claim?.state !== "waiting";
        return <li key={i} className={css.instalment}><span>{m.label}<small>{m.dueOn ? day(m.dueOn) : ""}</small></span><b>{money(m.amount)}</b>
          <span className={css.pill} data-tone={m.paid ? "ok" : claim?.state === "waiting" ? "info" : m.invoiced ? "info" : "muted"}>{m.paid ? "Paid" : claim?.state === "waiting" ? "Checking" : m.invoiced ? `Invoiced${m.number ? ` ${m.number}` : ""}` : "Later"}</span>
          {canPay && ref && payFor?.id !== ref.id ? <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setPayFor({ kind: "instalment", id: ref.id, documentId: ref.documentId, label: m.label, balance: ref.balance })}>Pay now</button> : null}
          {claim && !m.paid ? <ClaimLine c={claim} /> : null}
          {ref ? payForm(ref.id) : null}</li>; })}</ul>
    </article>)}
    {answered.map((d) => <div key={d.id} className={css.item}>
      <FileText size={18} aria-hidden="true" />
      <span className={css.itemMain}><b>{DOC[d.docType] ?? d.docType} {d.number}</b><small>{money(d.total)} · {d.decision === "accepted" ? `Accepted by ${d.decidedName ?? "you"} ${day(d.decidedAt)}` : d.decision === "changes" ? "You asked for changes" : d.decision === "declined" ? "Declined" : d.expired ? "Expired" : `Shared ${day(d.sharedAt)}`}</small></span>
      {d.hasPdf ? <a className={`${css.btn} ${css.quiet}`} href={`/api/v0/client-portal/documents/${d.documentId}/pdf`} target="_blank" rel="noreferrer" aria-label="PDF"><FileText size={15} aria-hidden="true" /></a> : null}
    </div>)}
  </Section>;
}

function People({ data, refresh }: { data: Space; refresh: () => Promise<void> }) {
  const [open, setOpen] = useState(false); const [name, setName] = useState(""); const [email, setEmail] = useState("");
  const [made, setMade] = useState<{ link: string; whatsapp: string } | null>(null); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const add = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(null);
    try { setMade(await post("client-portal/colleagues", { name, email })); setName(""); setEmail(""); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : "Could not add"); } finally { setBusy(false); } };
  return <Section id="people" title={`People of ${data.client.name}`} action={<button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => { setOpen((v) => !v); setMade(null); }} aria-expanded={open}><UserPlus size={14} aria-hidden="true" />Add</button>}>
    {data.colleagues.map((c) => <div key={c.person} className={css.item}><Users size={18} aria-hidden="true" /><span className={css.itemMain}><b>{c.name}{c.me ? " (you)" : ""}</b><small>On Pulse</small></span></div>)}
    {data.invited.map((c) => <div key={c.id} className={css.item}><UserPlus size={18} aria-hidden="true" /><span className={css.itemMain}><b>{c.name}</b><small suppressHydrationWarning>Invited {when(c.at)}</small></span></div>)}
    {open ? made ? <div className={css.form}>
      <p className={css.fine}>Send this link to them yourself. It works once, for 30 days.</p>
      <div className={css.copy}><input className={css.input} readOnly value={made.link} onFocus={(e) => e.target.select()} aria-label="Their link" />
        <button type="button" className={css.btn} onClick={async () => { try { await navigator.clipboard.writeText(made.link); setCopied(true); } catch { /* the field is selectable */ } }}><Copy size={15} aria-hidden="true" />{copied ? "Copied" : "Copy"}</button></div>
      <a className={`${css.btn} ${css.primary}`} href={`https://wa.me/?text=${encodeURIComponent(made.whatsapp)}`} target="_blank" rel="noreferrer"><Share2 size={15} aria-hidden="true" />Share on WhatsApp</a>
    </div> : <form className={css.form} onSubmit={add} aria-label="Add a colleague">
      <label className={css.field}>Their name<input className={css.input} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} /></label>
      <label className={css.field}>E-mail <small>(optional)</small><input className={css.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      {error ? <p className={css.note} data-tone="error" role="alert">{error}</p> : null}
      <div className={css.actions}><button className={`${css.btn} ${css.primary}`} disabled={busy}>{busy ? "Making their link…" : "Get their link"}</button></div>
    </form> : null}
  </Section>;
}
