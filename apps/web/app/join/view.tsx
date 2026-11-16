"use client";
import { ArrowRight, Building2, LogIn } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { arrive, post, type Moved } from "../orgs/client";
import { NewPassword } from "../orgs/password-field";
import { kindLabel } from "../orgs/labels";
import { SEATS } from "../start/catalogue";
import css from "../orgs/orgs.module.css";

type Peek = { org: string; orgHandle: string | null; kind: string; title: string | null; seat?: string | null; caSalaries?: boolean; email?: string | null; hasAccount?: boolean };
type Account = { account: { handle: string; name: string } | null; orgs: { name: string }[] };
const KEY = "pulse.join";

export function JoinView() {
  const [token, setToken] = useState<string | null>(null);
  const [peek, setPeek] = useState<Peek | null>(null); const [gone, setGone] = useState<string | null>(null);
  // CA-ACCESS: the seat this link is for (Employee, Manager, CA / accountant, Partner, Client, Vendor …), when it names one.
  const seat = peek?.seat ? SEATS.find((s) => s.key === peek.seat) ?? null : null;
  const [me, setMe] = useState<Account | null | undefined>(undefined);
  const [busy, setBusy] = useState(false); const [note, setNote] = useState<string | null>(null); const [waiting, setWaiting] = useState<string | null>(null);
  const [name, setName] = useState(""); const [handle, setHandle] = useState(""); const [touched, setTouched] = useState(false);
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  useEffect(() => { void Promise.resolve().then(() => {
    let t = window.location.hash.slice(1);
    try { if (/^[A-Za-z0-9_-]{43}$/.test(t)) window.sessionStorage.setItem(KEY, t); else t = window.sessionStorage.getItem(KEY) ?? ""; } catch { /* private window */ }
    if (!/^[A-Za-z0-9_-]{43}$/.test(t)) { setGone("This page needs the whole invitation link you were sent."); setMe(null); return; }
    setToken(t);
    void post<Peek>("auth/join-peek", { token: t }).then(setPeek).catch((e) => setGone(e instanceof Error ? e.message : "This invitation is no longer open."));
    void fetch("/api/v0/account", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then(setMe).catch(() => setMe(null));
  }); }, []);
  const done = (moved: Moved | { waiting: true; message: string }) => { try { window.sessionStorage.removeItem(KEY); } catch { /* */ }
    // ACCOUNT-SEATS: linked to an earlier, inactive record: its HR decides when the place opens.
    if ("waiting" in moved) { setWaiting(moved.message); setBusy(false); return; } arrive(moved); };
  const shownHandle = touched ? handle : name.toLowerCase().replace(/[^a-z]/g, "").slice(0, 20);
  const accept = async () => { setBusy(true); setNote(null); try { done(await post<Moved | { waiting: true; message: string }>("account/accept", { token })); } catch (e) { setNote(e instanceof Error ? e.message : "Could not join"); setBusy(false); } };
  const create = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setNote(null);
    try { done(await post<Moved | { waiting: true; message: string }>("auth/join", { token, name, handle: shownHandle, email, password })); } catch (err) { setNote(err instanceof Error ? err.message : "Could not join"); setBusy(false); } };

  return <div className={css.joinWrap}><div className={css.joinCard}>
    <p className={css.kicker}>Pulse invitation</p>
    {waiting ? <><h1>You’re linked</h1><p className={css.muted} role="status">{waiting}</p><Link className={css.btn} href="/">Open Pulse</Link></>
      : gone ? <><h1>This link does not open</h1><p className={css.muted}>{gone} Ask the person who invited you for a new link.</p><Link className={css.btn} href="/">Open Pulse</Link></>
      : !peek ? <p className={css.muted} role="status">Checking your invitation…</p>
      : <>
        <div className={css.cardHead}><span className={css.tile} data-big="" aria-hidden="true"><Building2 size={20} /></span>
          <div className={css.cardTitle}><h1>Join {peek.org}</h1><small>{peek.orgHandle ? `@${peek.orgHandle} · ` : ""}as {seat ? (seat.key === "accountant" ? "their CA" : seat.label.toLowerCase()) : kindLabel(peek.kind).toLowerCase()}{peek.title && peek.title !== seat?.label ? ` · ${peek.title}` : ""}</small></div></div>
        {/* CA-ACCESS: the seat in plain words: what they will see, what they can do, what they won't see. */}
        {seat ? <dl className={css.seatWords}><div><dt>You will see</dt><dd>{seat.sees.join(" · ")}</dd></div><div><dt>You can</dt><dd>{seat.does.join(" · ")}</dd></div>
          <div><dt>You won’t see</dt><dd>{seat.key === "accountant" && peek.caSalaries ? seat.wont.filter((w) => !w.includes("salary")).join(" · ") : seat.wont.join(" · ")}</dd></div></dl>
        : peek.kind === "client" ? <p className={css.muted}>You will see the work {peek.org} shares with you. You can also start your own Pulse later and switch between them.</p>
          : <p className={css.muted}>Your profile, skills and badges stay with your Pulse account wherever you work.</p>}
        {seat?.key === "accountant" ? <p className={css.muted}>Serve many companies? Each one sends its own link, and they all open from this one login.</p> : null}
        {note ? <p className={css.note} data-tone="error" role="alert">{note}</p> : null}
        {me === undefined ? null : me ? <>
          <button type="button" className={`${css.btn} ${css.primary}`} onClick={accept} disabled={busy}>{busy ? "Joining…" : <>Join as {me.account ? `@${me.account.handle}` : "yourself"}<ArrowRight size={15} aria-hidden="true" /></>}</button>
          <p className={css.muted}>It joins your account{me.orgs?.length ? ` (with ${me.orgs.map((o) => o.name).join(", ")})` : ""}; switch between them with Ctrl+Shift+O.</p>
        </> : peek.hasAccount ? <>
          {/* ONBOARD-SELF: the invited address already has a Pulse account: the same account joins, never a second one. */}
          <p className={css.muted}>{peek.email} already has a Pulse account. Sign in with it (password, Google or a sign-in code), then this page adds {peek.org} to it.</p>
          <a className={`${css.btn} ${css.primary}`} href="/login?next=/join"><LogIn size={15} aria-hidden="true" />Sign in to join</a>
        </> : <form className={css.form} onSubmit={create}>
          <label className={css.field}>Your name<input className={css.input} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} autoComplete="name" /></label>
          <label className={css.field}>Your handle<span className={css.prefix}><span>@</span><input className={css.input} value={shownHandle} onChange={(e) => { setTouched(true); setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, "")); }} required minLength={3} maxLength={30} autoCapitalize="none" spellCheck={false} autoComplete="username" /></span></label>
          {peek.email ? <p className={css.muted}>Your account’s e-mail: <b>{peek.email}</b> (the invitation proved it).</p>
            : <label className={css.field}>E-mail <small>(optional) another way to sign in</small><input className={css.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>}
          <NewPassword value={password} onChange={setPassword} inputClass={css.input} fieldClass={css.field} />
          <button className={`${css.btn} ${css.primary}`} disabled={busy}>{busy ? "Joining…" : <>Create account and join<ArrowRight size={15} aria-hidden="true" /></>}</button>
          <a className={`${css.btn} ${css.quiet}`} href="/login?next=/join"><LogIn size={15} aria-hidden="true" />I already have a Pulse account</a>
        </form>}
      </>}
  </div></div>;
}
