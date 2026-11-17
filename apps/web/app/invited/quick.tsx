"use client";
// SELF-SERVE (owner, 4 Nov 2026: "the client gets an e-mail with a one-click link that creates their account and lands
// them in a client portal, no password needed"): the invitation page for a link that was e-mailed to one person. One
// press makes their Pulse account (the e-mail it came to is proven by the key only the e-mailed link carries) and opens their space. An address that
// already has an account signs in with an e-mailed code first, then comes back here. Anyone who wants the longer way
// (a password, their own organisation) has it one press away.
import { ArrowRight, CalendarClock, FileText, LogIn, MessageCircle, Receipt } from "lucide-react";
import { useState } from "react";
import { arrive, post, type Moved } from "../orgs/client";
import css from "../orgs/orgs.module.css";

export function QuickJoin({ token, linkKey, from, contact, email, hasAccount, onLonger, done }: { token: string; linkKey: string; from: string; contact: string; email: string | null;
  hasAccount: boolean; onLonger: () => void; done: (to: string) => void }) {
  const [name, setName] = useState(contact);
  const [busy, setBusy] = useState(false); const [note, setNote] = useState<string | null>(null);
  const open = async () => {
    setBusy(true); setNote(null);
    try { const moved = await post<Moved>("auth/connect-join", { token, key: linkKey, oneClick: true, name }); const to = moved.home || "/client"; done(to); arrive(moved, to); }
    catch (e) { setNote(e instanceof Error ? e.message : "Could not open your space"); setBusy(false); }
  };
  const first = from.split(" ")[0];
  return <div className={css.form} data-quick-join="">
    <ul aria-label={`What your space with ${first} has`} style={{ display: "grid", gap: 8, margin: "4px 0", padding: 0, listStyle: "none" }}>
      <li style={{ display: "flex", gap: 10, alignItems: "center" }}><CalendarClock size={18} aria-hidden="true" /> Your appointments, with the time and the place or video link</li>
      <li style={{ display: "flex", gap: 10, alignItems: "center" }}><FileText size={18} aria-hidden="true" /> Files you and {first} share</li>
      <li style={{ display: "flex", gap: 10, alignItems: "center" }}><Receipt size={18} aria-hidden="true" /> Invoices, and paying them</li>
      <li style={{ display: "flex", gap: 10, alignItems: "center" }}><MessageCircle size={18} aria-hidden="true" /> Messages with {first}</li>
    </ul>
    {hasAccount ? <>
      <p className={css.note} data-tone="info" role="status">{email ?? "This e-mail"} already has a Pulse account. Sign in with a code we e-mail you, then this link opens your space.</p>
      <a className={`${css.btn} ${css.primary}`} href="/login?next=/invited"><LogIn size={15} aria-hidden="true" />Sign in with an e-mailed code</a>
    </> : <>
      <label className={css.field}>Your name<input className={css.input} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} autoComplete="name" /></label>
      {note ? <p className={css.note} data-tone="error" role="alert">{note}</p> : null}
      <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => void open()} disabled={busy || name.trim().length < 2}>{busy ? "Opening your space…" : <>Open my space<ArrowRight size={15} aria-hidden="true" /></>}</button>
      <p className={css.muted}>No password needed. Next time, sign in with a code Pulse e-mails to {email ?? "you"}.</p>
    </>}
    <button type="button" className={`${css.btn} ${css.quiet}`} onClick={onLonger}>Set up with a password or my organisation instead</button>
  </div>;
}
