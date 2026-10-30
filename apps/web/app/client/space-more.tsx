"use client";
// PORTAL-2: the client space's newer parts: creatives to approve, paying an invoice or instalment ("I've paid" with a
// proof), notifications and the sign-in address, and the first-sign-in tour. Data: GET /api/v0/client-portal
// (pulse.cp_more merged into pulse.cp_home).
import { ArrowRight, Bell, Check, Copy, FileImage, FileText, IndianRupee, Link2, Mail, Music, Paperclip, Smartphone, Video, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { inr, rupeesToPaise, upiLink } from "../lib/client-pay.mjs";
import css from "./client.module.css";
import { STATE, when, type Deliverable } from "./review/review";
import { uploadFile } from "./upload";

export type Pay = { payee: string; upi: string | null; bank: { accountName?: string; bankName?: string; branch?: string; accountNumber?: string; ifsc?: string }; note: string | null; gateway: string } | null;
export type Claim = { id: string; documentId: string | null; milestoneId: string | null; amount: number; paidOn: string; method: string; reference: string | null;
  state: "waiting" | "confirmed" | "not_received"; at: string; decidedNote: string | null; what: string | null };
export type Account = { handle: string; email: string | null; confirmed: boolean; pending: string | null; links: boolean } | null;
export type More = { deliverables: Deliverable[]; pay: Pay; claims: Claim[]; prefs: { tourDone: boolean; digest: boolean }; account: Account; unread: number; mail: boolean;
  instalments: Record<string, { id: string; documentId: string | null; balance: number }[]> };

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "That did not work. Try again.");
  return data as T;
}
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

// ------------------------------------------------------------------------------------------------ creatives
const KIND_ICON = { image: FileImage, video: Video, audio: Music, document: FileText, link: Link2, other: Paperclip } as const;
function Thumb({ d }: { d: Deliverable }) {
  const v = d.versions[0];
  const Icon = KIND_ICON[(d.kind as keyof typeof KIND_ICON)] ?? Paperclip;
  // eslint-disable-next-line @next/next/no-img-element -- a private file streamed by the API
  if (v?.fileId && v.mime?.startsWith("image/")) return <img className={css.thumb} src={`/api/v0/client-portal/files/${v.fileId}`} alt="" loading="lazy" />;
  return <span className={css.thumb} aria-hidden="true"><Icon size={20} /></span>;
}
export function DeliverableRow({ d, todo }: { d: Deliverable; todo?: boolean }) {
  const open = d.comments.filter((c) => c.version === d.version && !c.resolvedAt).length;
  return <Link href={`/client/review/${d.id}`} className={css.item} data-tone={todo ? "todo" : undefined}>
    <Thumb d={d} />
    <span className={css.itemMain}><b>{d.title}</b>
      <small>{[d.version > 1 ? `Version ${d.version}` : null, todo ? (d.answerBy ? `Answer by ${when(d.answerBy)}` : `Shared ${when(d.sharedAt)}`) : d.decidedAt ? when(d.decidedAt) : `Shared ${when(d.sharedAt)}`,
        open ? `${open} ${open === 1 ? "comment" : "comments"}` : null].filter(Boolean).join(" · ")}</small></span>
    {todo ? <span className={css.go}>Review<ArrowRight size={14} aria-hidden="true" /></span> : <span className={css.pill} data-tone={STATE[d.state][1]}>{d.state === "waiting" ? "Waiting for you" : STATE[d.state][0]}</span>}
  </Link>;
}
export function Creatives({ items }: { items: Deliverable[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 6);
  return <section className={css.section} aria-labelledby="approvals-h" id="approvals">
    <div className={css.sectionHead}><h2 id="approvals-h">Creatives and files{items.length ? <span className={css.count}>{items.length}</span> : null}</h2></div>
    {items.length ? <>{shown.map((d) => <DeliverableRow key={d.id} d={d} />)}
      {items.length > shown.length ? <button type="button" className={css.linkBtn} onClick={() => setAll(true)}>Show all {items.length}</button> : null}</>
      : <p className={css.empty}>Designs, videos and documents your team shares for your approval show here, with every version and your comments.</p>}
  </section>;
}

// ------------------------------------------------------------------------------------------------ paying
export type PayTarget = { kind: "invoice" | "instalment"; id: string; documentId: string | null; label: string; balance: number };
function CopyLine({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return <li><span><small>{label}</small>{value}</span>
    <button type="button" className={`${css.btn} ${css.quiet}`} aria-label={`Copy ${label}`} onClick={async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* the text is selectable */ } }}>
      {done ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}</button></li>;
}
export function PayNow({ target, pay, onDone, onCancel }: { target: PayTarget; pay: NonNullable<Pay>; onDone: (t: string) => Promise<void>; onCancel: () => void }) {
  const [amount, setAmount] = useState(String(target.balance / 100)), [on, setOn] = useState(today()), [method, setMethod] = useState(pay.upi ? "upi" : "bank");
  const [reference, setReference] = useState(""), [noteText, setNoteText] = useState(""), [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const paise = rupeesToPaise(amount);
  const upi = upiLink({ upi: pay.upi, payee: pay.payee, paise: paise ?? target.balance, note: target.label });
  const bank = pay.bank ?? {};
  const send = async (e: FormEvent) => { e.preventDefault(); setError(null);
    if (!paise) { setError("Type the amount you paid, like 25000"); return; }
    setBusy(true);
    try {
      const proofFileId = file ? await uploadFile("/api/v0/client-portal/files", file, {}) : null;
      await post("client-portal/pay", { ...(target.kind === "invoice" ? { documentId: target.id } : { milestoneId: target.id }), amount: paise, paidOn: on, method, reference, note: noteText, proofFileId });
      await onDone(`Thank you. Finance will check the payment of ${inr(paise)} and tell you here when it is in.`);
    } catch (err) { setError((err as Error).message); setBusy(false); } };
  return <div className={css.payBox} role="group" aria-label={`Pay ${target.label}`}>
    <p className={css.payHead}><IndianRupee size={16} aria-hidden="true" /><b>Pay {inr(target.balance)}</b><span>{target.label}</span></p>
    <ol className={css.paySteps}>
      <li><b>Pay {pay.payee}</b>
        <ul className={css.payDetails}>
          {pay.upi ? <CopyLine label="UPI ID" value={pay.upi} /> : null}
          {bank.accountNumber ? <CopyLine label="Account number" value={bank.accountNumber} /> : null}
          {bank.ifsc ? <CopyLine label="IFSC" value={bank.ifsc} /> : null}
          {bank.accountName ? <li><span><small>Account name</small>{bank.accountName}</span></li> : null}
          {bank.bankName || bank.branch ? <li><span><small>Bank</small>{[bank.bankName, bank.branch].filter(Boolean).join(", ")}</span></li> : null}
        </ul>
        {upi ? <a className={`${css.btn} ${css.primary}`} href={upi}><Smartphone size={15} aria-hidden="true" />Pay with a UPI app</a> : null}
        {upi ? <p className={css.fine}>On your phone this opens Google Pay, PhonePe, Paytm or your bank&apos;s app with the amount filled in.</p> : null}
        {pay.note ? <p className={css.fine}>{pay.note}</p> : null}
      </li>
      <li><b>Then tell us</b>
        <form className={css.form} onSubmit={send}>
          <div className={css.twoCols}>
            <label className={css.field}>Amount paid (₹)<input className={css.input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
            <label className={css.field}>Paid on<input className={css.input} type="date" value={on} max={today()} onChange={(e) => setOn(e.target.value)} required /></label>
          </div>
          <div className={css.chips} role="radiogroup" aria-label="How you paid">
            {[["upi", "UPI"], ["bank", "Bank transfer"], ["cheque", "Cheque"], ["other", "Other"]].map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={method === k} className={css.chip} onClick={() => setMethod(k)}>{l}</button>)}
          </div>
          <label className={css.field}>{method === "upi" ? "UPI transaction ID" : method === "bank" ? "UTR or reference" : method === "cheque" ? "Cheque number" : "Reference"} <small>(helps Finance find it)</small>
            <input className={css.input} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} autoCapitalize="characters" /></label>
          <label className={css.field}>Screenshot or receipt <small>(optional, photo or PDF up to 10 MB)</small>
            <input className={css.input} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          <label className={css.field}>Note <small>(optional)</small><input className={css.input} value={noteText} onChange={(e) => setNoteText(e.target.value)} maxLength={1000} /></label>
          {error ? <p className={css.note} data-tone="error" role="alert">{error}</p> : null}
          <div className={css.actions}><button className={`${css.btn} ${css.primary}`} disabled={busy}><Check size={15} aria-hidden="true" />{busy ? "Sending…" : "I've paid"}</button>
            <button type="button" className={`${css.btn} ${css.quiet}`} onClick={onCancel}>Not now</button></div>
        </form>
      </li>
    </ol>
  </div>;
}
export function ClaimLine({ c }: { c: Claim }) {
  return <p className={css.claim} data-state={c.state}>{c.state === "waiting" ? `You told us you paid ${inr(c.amount)} on ${when(c.paidOn)}. Finance is checking it.`
    : c.state === "confirmed" ? `${inr(c.amount)} received. Thank you.` : `Not found yet: ${c.decidedNote ?? "Finance could not find this payment."}`}</p>;
}

// ------------------------------------------------------------------------------------------------ settings
export function Settings({ more, onChange, onTour }: { more: More; onChange: (patch: Partial<More>) => void; onTour: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [edit, setEdit] = useState(false), [email, setEmail] = useState(more.account?.email ?? "");
  const [sent, setSent] = useState<string | null>(null);
  const a = more.account;
  const digest = async (on: boolean) => { setBusy(true); setError(null);
    try { const r = await post<{ prefs: More["prefs"] }>("client-portal/prefs", { digest: on }); onChange({ prefs: r.prefs }); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const change = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(null);
    try { const r = await post<{ pending: string }>("client-portal/email", { email }); setSent(r.pending); setEdit(false); onChange({ account: a ? { ...a, pending: r.pending } : a }); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  return <section className={css.section} aria-labelledby="settings-h" id="settings">
    <div className={css.sectionHead}><h2 id="settings-h"><Bell size={16} aria-hidden="true" />Notifications and sign-in</h2></div>
    <p className={css.meta}>New quotations, invoices, creatives to check, messages and missed calls show in the bell at the top{more.unread ? ` (${more.unread} unread)` : ""}.</p>
    <label className={css.toggle}>
      <input type="checkbox" checked={more.prefs.digest} disabled={busy || !a?.email || !more.mail} onChange={(e) => void digest(e.target.checked)} />
      <span><b>E-mail me a daily summary</b><small>{!more.mail ? "E-mail is not switched on here yet." : !a?.email ? "Add your e-mail first." : "Once a day, only when something is new. Turn it off any time."}</small></span>
    </label>
    <div className={css.item}><Mail size={18} aria-hidden="true" /><span className={css.itemMain} data-wrap=""><b>{a?.email ?? "No e-mail yet"}</b>
      <small>{a?.pending ? `Check ${a.pending}: press the link we sent to confirm it.` : a?.email ? (a.confirmed ? "Confirmed. Sign-in links go here." : "Sign-in links and your summary go here.") : "Add one to get sign-in links and the summary."}{a?.handle ? ` · Your handle: @${a.handle}` : ""}</small></span>
      {more.mail ? <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setEdit((x) => !x)} aria-expanded={edit}>{a?.email ? "Change" : "Add"}</button> : null}</div>
    {edit ? <form className={css.form} onSubmit={change} aria-label="Your e-mail">
      <label className={css.field}>Your e-mail<input className={css.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></label>
      <div className={css.actions}><button className={`${css.btn} ${css.primary}`} disabled={busy}>{busy ? "Sending…" : "Send a confirmation link"}</button></div>
      <p className={css.fine}>Your address changes when you press the link in that e-mail.</p>
    </form> : null}
    {sent ? <p className={css.note} data-tone="ok" role="status">Sent to {sent}. Press the link in it to confirm.</p> : null}
    {error ? <p className={css.note} data-tone="error" role="alert">{error}</p> : null}
    <p className={css.fine}>Forgot your password? On the sign-in page, ask for a sign-in link or a reset link. <button type="button" className={css.linkBtn} onClick={onTour}>Take the tour again</button></p>
  </section>;
}

// ------------------------------------------------------------------------------------------------ the tour
type Step = { target: string; title: string; text: string };
export function steps(has: { todo: boolean; money: boolean }, provider: string): Step[] {
  return [
    { target: has.todo ? "todo" : "hello", title: "What needs you comes first", text: "Quotations to accept, creatives to approve and anything your team asked you for show at the top. Tap one to answer it." },
    { target: "hero-actions", title: `Talk to ${provider}`, text: "Message, call or video call your team from here, or ask for something: it reaches them as a task you can follow." },
    { target: "approvals", title: "Your creatives", text: "Every design, video and document shared with you, with its versions. Tap the picture where something should change to pin a comment." },
    { target: has.money ? "money" : "team", title: has.money ? "Payments and documents" : "Your team", text: has.money ? "Invoices, your payment schedule and documents. Pay here, then tell us with “I've paid”." : "The people who work with you. Your space keeps everything you do together in one place." },
    { target: "settings", title: "Stay in the loop", text: "The bell tells you when something new arrives. Turn on a daily e-mail summary here if you like." },
  ];
}
export function Tour({ list, onEnd }: { list: Step[]; onEnd: () => void }) {
  const [i, setI] = useState(0);
  const step = list[i];
  useEffect(() => {
    const el = document.getElementById(step.target);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    el?.classList.add(css.tourFocus);
    return () => el?.classList.remove(css.tourFocus);
  }, [step.target]);
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === "Escape") onEnd(); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onEnd]);
  return <div className={css.tour} role="dialog" aria-modal="false" aria-labelledby="tour-h" aria-describedby="tour-t">
    <p className={css.tourCount}>{i + 1} of {list.length}</p>
    <h2 id="tour-h">{step.title}</h2>
    <p id="tour-t">{step.text}</p>
    <div className={css.actions}>
      {i > 0 ? <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setI(i - 1)}>Back</button> : <button type="button" className={`${css.btn} ${css.quiet}`} onClick={onEnd}>Skip</button>}
      <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => i + 1 < list.length ? setI(i + 1) : onEnd()} autoFocus>{i + 1 < list.length ? "Next" : "Done"}</button>
    </div>
    <button type="button" className={css.tourClose} onClick={onEnd} aria-label="Close the tour"><X size={16} aria-hidden="true" /></button>
  </div>;
}
