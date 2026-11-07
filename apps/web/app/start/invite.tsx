"use client";
import { ArrowRight, Copy, Send } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { post } from "../orgs/client";
import { SEATS, parseEmails, type SeatKey } from "./catalogue";
import css from "./start.module.css";

type Row = { email: string; seat: SeatKey; status: string; mailed: boolean; hasAccount?: boolean; link: string | null };
const STATUS: Record<string, string> = { created: "Invited", member: "Already in your company", invalid: "Not an e-mail address" };

/** ONBOARD-SELF: who to invite, by seat. Each seat says who it is for and what they will and won't see; paste any
 *  number of e-mails per seat; each person gets their own private link by e-mail. Someone already on Pulse signs in
 *  with their account and the company joins it. */
export function InviteTeam({ org, next }: { org: string; next: string }) {
  const [text, setText] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<SeatKey | null>("staff");
  const [busy, setBusy] = useState(false); const [note, setNote] = useState<{ text: string; tone?: "error" | "ok" } | null>(null);
  const [done, setDone] = useState<Row[]>([]);
  const parsed = Object.fromEntries(SEATS.map((s) => [s.key, parseEmails(text[s.key] ?? "")])) as Record<SeatKey, ReturnType<typeof parseEmails>>;
  const total = SEATS.reduce((n, s) => n + parsed[s.key].emails.length, 0);
  const send = async () => {
    setBusy(true); setNote(null);
    const rows = SEATS.flatMap((s) => parsed[s.key].emails.map((email) => ({ email, seat: s.key })));
    try {
      const out: Row[] = [];
      for (let i = 0; i < rows.length; i += 50) out.push(...(await post<{ rows: Row[] }>("account/invites", { rows: rows.slice(i, i + 50) })).rows);
      setDone((d) => [...out, ...d]); setText({});
      const sent = out.filter((r) => r.status === "created").length;
      setNote({ text: sent ? `${sent} invitation${sent === 1 ? "" : "s"} sent.${out.some((r) => r.link) ? " Some could not be e-mailed: copy their links below and send them privately." : ""}` : "Nobody new to invite.", tone: "ok" });
    } catch (e) { setNote({ text: e instanceof Error ? e.message : "Could not send the invitations", tone: "error" }); }
    setBusy(false);
  };
  return <div className={css.inPage}>
    <p className={css.lede}>Invite the people who work with {org}. Each gets a private link by e-mail. Someone already on Pulse signs in with their own account (password, Google or a sign-in code) and {org} is added to it.</p>
    {SEATS.map((s) => { const p = parsed[s.key]; const shown = open === s.key || !!text[s.key]; return (
      <section key={s.key} className={css.seat} aria-labelledby={`seat-${s.key}`}>
        <div className={css.seatHead}><div><b id={`seat-${s.key}`}>{s.label}</b><p className={css.muted}>{s.who}</p></div>
          {shown ? null : <button type="button" className={css.btn} onClick={() => setOpen(s.key)}>Add people</button>}</div>
        <div className={css.seeWont}>
          <div><p>Will see</p><ul>{s.sees.map((x) => <li key={x}>{x}</li>)}</ul></div>
          <div><p>Won’t see</p><ul>{s.wont.map((x) => <li key={x}>{x}</li>)}</ul></div>
        </div>
        {shown ? <label className={css.field}>E-mails <small>paste a list: one per line, or separated by commas</small>
          <textarea className={css.textarea} value={text[s.key] ?? ""} onChange={(e) => setText((t) => ({ ...t, [s.key]: e.target.value }))} inputMode="email" autoCapitalize="none" spellCheck={false}
            placeholder={s.key === "client" ? "user-0198d0c2@org-cef0a5.example" : "user-f4c1ef7d@org-b604f9.example, user-02b0a7cf@org-b604f9.example"} />
          <span className={css.count}>{p.emails.length} to invite{p.invalid.length ? ` · not e-mails: ${p.invalid.slice(0, 3).join(", ")}` : ""}</span></label> : null}
      </section>); })}
    {note ? <p className={css.note} data-tone={note.tone} role={note.tone === "error" ? "alert" : "status"}>{note.text}</p> : null}
    <div className={css.actions}>
      <button type="button" className={`${css.btn} ${css.primary} ${css.grow}`} onClick={() => void send()} disabled={busy || total === 0}><Send size={17} aria-hidden="true" />{busy ? "Sending…" : total ? `Send ${total} invitation${total === 1 ? "" : "s"}` : "Send invitations"}</button>
      <Link className={css.btn} href={next}>{done.length ? "Continue" : "Skip for now"}<ArrowRight size={17} aria-hidden="true" /></Link>
    </div>
    {done.length ? <ul className={css.results} aria-label="Invitations">{done.map((r, i) => <li key={`${r.email}-${i}`}>
      <span><b>{r.email}</b> · {SEATS.find((s) => s.key === r.seat)?.label} · {STATUS[r.status] ?? r.status}{r.status === "created" ? r.mailed ? r.hasAccount ? ", e-mailed (already on Pulse)" : ", e-mailed" : "" : ""}</span>
      {r.link ? <span><code>{r.link}</code> <button type="button" className={css.btn} onClick={() => void navigator.clipboard?.writeText(r.link!)}><Copy size={15} aria-hidden="true" />Copy link</button></span> : null}
    </li>)}</ul> : null}
  </div>;
}
