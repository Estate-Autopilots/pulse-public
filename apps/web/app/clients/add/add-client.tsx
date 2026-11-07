"use client";
// SELF-SERVE (owner, 4 Nov 2026: "a psychologist adds a client; the client gets an e-mail with a one-click link that
// creates their account and lands them in a client portal (appointments, files, invoices, messages), no password"):
// add one client and, ticked by default, e-mail them the link to their own space. Then the next step right here: book
// their first appointment, copy or WhatsApp the link, or add the next client. Never a dead end.
import { Check, Copy, MessageCircle, UserPlus } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { BookForm } from "../../appointments/book";
import a from "../../appointments/appointments.module.css";
import s from "../../signup/setup.module.css";

type Made = { id: string; name: string; email: string | null; link: string; sent: boolean; why: string | null; whatsapp: string };
const slot = (x: string) => new Date(x).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

export function AddClient({ one, many }: { one: string; many: string }) {
  const [busy, setBusy] = useState(false); const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<Made | null>(null); const [send, setSend] = useState(true);
  const [booked, setBooked] = useState<string | null>(null); const [copied, setCopied] = useState(false);
  const word = one.toLowerCase();
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setProblem(null);
    try {
      const r = await fetch("/api/v0/practice/clients", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: f.get("name"), email: f.get("email"), phone: f.get("phone"), message: f.get("message"), send }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof d?.error === "string" ? d.error : "That did not save. Try again.");
      setMade(d as Made); setBooked(null); setCopied(false); window.scrollTo({ top: 0 });
    } catch (err) { setProblem((err as Error).message); } finally { setBusy(false); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(made!.link); setCopied(true); } catch { setCopied(false); } };

  if (made) return <div className={a.wrap}><div className={a.grid}>
    <section className={a.section} aria-labelledby="made-h" data-added="">
      <h2 id="made-h" className={a.sectionHead}><Check size={16} aria-hidden="true" />{made.name} is added</h2>
      <p className={a.ok} role="status">{made.sent ? `We e-mailed ${made.email} a link. One click opens their space: appointments, files, invoices and messages with you. No password needed.`
        : made.why ?? `Nothing was e-mailed. Share the link below with ${made.name.split(" ")[0]}: it opens their space.`}</p>
      <ol className={a.steps} aria-label="What happens next">
        <li><span className={a.no}>1</span><span>{made.name.split(" ")[0]} opens the link and lands in their own space.</span></li>
        <li><span className={a.no}>2</span><span>Book their first appointment below: it shows in their space at once.</span></li>
        <li><span className={a.no}>3</span><span>Send invoices and share files from their page under {many}.</span></li>
      </ol>
      <div className={a.row}>
        <button type="button" className={a.quiet} onClick={() => void copy()}><Copy size={14} aria-hidden="true" />{copied ? "Link copied" : "Copy their link"}</button>
        <a className={a.quiet} href={`https://wa.me/?text=${encodeURIComponent(made.whatsapp)}`} target="_blank" rel="noreferrer"><MessageCircle size={14} aria-hidden="true" />Share on WhatsApp</a>
      </div>
      {/* Review, 5 Nov 2026: only the e-mailed link proves the address; the one shared here asks for details first. */}
      <small className={a.link}>{made.sent ? <>The link you copy or share asks {made.name.split(" ")[0]} for their details first; the one in their e-mail opens their space in one click.</>
        : <>The link asks {made.name.split(" ")[0]} for their details, then opens their space. It works once, for 30 days.</>}</small>
    </section>
    <aside className={a.side}>
      <section className={a.section} aria-labelledby="first-appt-h">
        <h2 id="first-appt-h" className={a.sectionHead}>Book the first appointment</h2>
        {booked ? <p className={a.ok} role="status">Booked for {booked}. It is in {made.name.split(" ")[0]}&apos;s space.</p>
          : <BookForm clientId={made.id} compact onBooked={(x) => setBooked(slot(x.startsAt))} />}
        {booked ? <Link className={a.quiet} href="/appointments">See all appointments</Link> : null}
      </section>
      <button type="button" className={a.primary} onClick={() => setMade(null)}><UserPlus size={16} aria-hidden="true" />Add another {word}</button>
      <Link className={a.quiet} href={`/clients/${made.id}`}>Open {made.name}&apos;s page</Link>
    </aside>
  </div></div>;

  return <div className={a.wrap}><div className={a.grid}>
    <form className={a.section} onSubmit={submit} aria-labelledby="add-h">
      <h2 id="add-h" className={a.sectionHead}><UserPlus size={16} aria-hidden="true" />Add a {word}</h2>
      <label className={s.field}>Name<input name="name" required minLength={2} maxLength={120} autoComplete="off" placeholder="Asha Rao" /></label>
      <label className={s.field}>E-mail <small>their link to their own space goes here</small><input name="email" type="email" maxLength={254} autoComplete="off" placeholder="asha@example.com" /></label>
      <label className={s.field}>Phone <small>optional</small><input name="phone" type="tel" maxLength={40} autoComplete="off" placeholder="+91 98200 00000" /></label>
      <label className={s.field}>A line from you <small>optional, in the e-mail</small><textarea name="message" maxLength={1000} placeholder="Looking forward to our first session." /></label>
      <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14 }}><input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} style={{ width: 20, height: 20, marginTop: 1 }} />
        <span><b>E-mail them a link to their space</b><br /><small style={{ color: "var(--theme-text-muted)" }}>One click makes their account: no password. They see only what you share with them.</small></span></label>
      {problem ? <p className={a.problem} role="alert">{problem}</p> : null}
      <button type="submit" className={a.primary} disabled={busy}>{busy ? "Adding…" : send ? `Add and e-mail their link` : `Add ${word}`}</button>
    </form>
    <aside className={a.side}>
      <section className={a.section} aria-labelledby="how-h">
        <h2 id="how-h" className={a.sectionHead}>What your {word} gets</h2>
        <ol className={a.steps}>
          <li><span className={a.no}>1</span><span>An e-mail from you with one link.</span></li>
          <li><span className={a.no}>2</span><span>Their own space: appointments, files, invoices and messages with you.</span></li>
          <li><span className={a.no}>3</span><span>Next time, a sign-in code to their e-mail. No password to forget.</span></li>
        </ol>
      </section>
      <Link className={a.quiet} href="/clients">All {many.toLowerCase()}</Link>
    </aside>
  </div></div>;
}
