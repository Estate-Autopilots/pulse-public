"use client";
import { ArrowRight, Building2, Handshake, LogIn, User } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { arrive, post, type Moved } from "../orgs/client";
import { NewPassword } from "../orgs/password-field";
import css from "../orgs/orgs.module.css";
import { SelectField } from "../kit/select-field";

type Peek = { from: string; fromHandle: string | null; company: string; contact: string; email: string | null; phone: string | null; project: string | null; summary: string | null; poc: string | null; handleSuggestion: string;
  /** CLIENT-PORTAL: an existing client's access, one more person of a connected client, the past-conversations offer. */
  kind?: string; role?: string | null; client?: boolean; colleague?: boolean; joinsOrg?: string | null; historyOffer?: boolean };
type Account = { account: { handle: string; name: string } | null; orgs: { id: string; name: string; kind: string }[] };
const KEY = "pulse.invited";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function InvitedView() {
  const [token, setToken] = useState<string | null>(null);
  const [peek, setPeek] = useState<Peek | null>(null); const [gone, setGone] = useState<string | null>(null);
  const [me, setMe] = useState<Account | null | undefined>(undefined);
  const [mode, setMode] = useState<"new" | "existing" | "individual">("new");
  const [orgName, setOrgName] = useState(""); const [orgHandle, setOrgHandle] = useState(""); const [org, setOrg] = useState("");
  const [name, setName] = useState(""); const [handle, setHandle] = useState(""); const [touched, setTouched] = useState(false);
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false); const [note, setNote] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  useEffect(() => { void Promise.resolve().then(() => {
    let t = window.location.hash.slice(1);
    try { if (TOKEN.test(t)) window.sessionStorage.setItem(KEY, t); else t = window.sessionStorage.getItem(KEY) ?? ""; } catch { /* private window */ }
    if (!TOKEN.test(t)) { setGone("This page needs the whole link you were sent."); setMe(null); return; }
    setToken(t);
    void post<Peek>("auth/connect-peek", { token: t }).then((p) => { setPeek(p); setOrgName(p.company); setOrgHandle(p.handleSuggestion); setName(p.contact); setEmail(p.email ?? ""); })
      .catch((e) => setGone(e instanceof Error ? e.message : "This link is no longer open."));
    void fetch("/api/v0/account", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((a: Account | null) => { setMe(a); const mine = a?.orgs?.find((o) => o.kind === "staff"); if (mine) setOrg(mine.id); }).catch(() => setMe(null));
  }); }, []);
  const choice = { mode, orgName, orgHandle, org: mode === "existing" ? org : undefined, history: history ? "yes" : "no" };
  const done = (moved: Moved) => { try { window.sessionStorage.removeItem(KEY); } catch { /* */ } arrive(moved, moved.home && moved.home !== "/connections" ? moved.home : mode === "individual" ? "/chats" : "/connections?welcome=1"); };
  const fail = (e: unknown) => { setNote(e instanceof Error ? e.message : "Could not connect"); setBusy(false); };
  const accept = async () => { setBusy(true); setNote(null); try { done(await post<Moved>("account/connect-accept", { token, ...choice })); } catch (e) { fail(e); } };
  const shownHandle = touched ? handle : name.toLowerCase().replace(/[^a-z]/g, "").slice(0, 20);
  const create = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setNote(null);
    try { done(await post<Moved>("auth/connect-join", { token, name, handle: shownHandle, email, password, ...choice })); } catch (err) { fail(err); } };
  const myOrgs = (me?.orgs ?? []).filter((o) => o.kind === "staff");

  return <div className={css.joinWrap}><div className={css.joinCard} style={{ maxWidth: 620 }}>
    <p className={css.kicker}>Pulse · client invitation</p>
    {gone ? <><h1>This link does not open</h1><p className={css.muted}>{gone} Ask the person who sent it for a new link.</p><Link className={css.btn} href="/">Open Pulse</Link></>
      : !peek ? <p className={css.muted} role="status">Checking your link…</p>
      : <>
        <div className={css.cardHead}><span className={css.tile} data-big="" aria-hidden="true"><Handshake size={20} /></span>
          <div className={css.cardTitle}><h1>{peek.colleague ? `Join ${peek.company} on Pulse` : peek.client ? `${peek.from} has set up your Pulse` : `${peek.from} invites ${peek.company}`}</h1><small>{peek.colleague ? `Your space with ${peek.from}: projects, approvals, invoices, chats and calls` : peek.client ? "Your projects, approvals, invoices, chats and calls with the team, in one place" : `${peek.fromHandle ? `@${peek.fromHandle} · ` : ""}to work together on Pulse`}</small></div></div>
        <dl className={css.list} aria-label="What they filled in" style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: "8px 0" }}>
          <dt className={css.muted}>Company</dt><dd style={{ margin: 0 }}>{peek.company}</dd>
          <dt className={css.muted}>Contact</dt><dd style={{ margin: 0 }}>{peek.contact}{peek.email ? ` · ${peek.email}` : ""}{peek.phone ? ` · ${peek.phone}` : ""}</dd>
          {peek.project ? <><dt className={css.muted}>Project</dt><dd style={{ margin: 0 }}>{peek.project}</dd></> : null}
          {peek.summary ? <><dt className={css.muted}>The deal</dt><dd style={{ margin: 0, whiteSpace: "pre-wrap" }}>{peek.summary}</dd></> : null}
          {peek.poc ? <><dt className={css.muted}>Your contact</dt><dd style={{ margin: 0 }}>{peek.poc} at {peek.from}</dd></> : null}
        </dl>
        <p className={css.muted}>You will share only the groups and tasks made for this connection. {peek.from} sees nothing else of yours, and you nothing else of theirs.</p>

        {peek.colleague ? <p className={css.muted}>{peek.joinsOrg ? `You join ${peek.joinsOrg} on Pulse and its space with ${peek.from}.` : `You join the space ${peek.company} has with ${peek.from}.`}</p> : <>
        <div className={css.segmented} role="group" aria-label="How you join">
          <button type="button" aria-pressed={mode === "new"} onClick={() => setMode("new")}><Building2 size={14} aria-hidden="true" /> Set up {peek.company}</button>
          {me && myOrgs.length ? <button type="button" aria-pressed={mode === "existing"} onClick={() => setMode("existing")}>Use an organisation I run</button> : null}
          <button type="button" aria-pressed={mode === "individual"} onClick={() => setMode("individual")}><User size={14} aria-hidden="true" /> Just me</button>
        </div>
        {mode === "new" ? <div className={css.row}>
          <label className={css.field}>Organisation name<input className={css.input} value={orgName} onChange={(e) => setOrgName(e.target.value)} required minLength={2} maxLength={80} /></label>
          <label className={css.field}>Its handle<span className={css.prefix}><span>@</span><input className={css.input} value={orgHandle} onChange={(e) => setOrgHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, ""))} minLength={3} maxLength={30} autoCapitalize="none" spellCheck={false} /></span></label>
        </div> : mode === "existing" ? <label className={css.field}>Your organisation<SelectField className={css.input} value={org} onChange={(e) => setOrg(e.target.value)}>{myOrgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</SelectField></label>
          : <p className={css.muted}>You join {peek.from} as their client: you see the work they share with you. You can start your organisation later.</p>}
        </>}
        {peek.historyOffer ? <label className={css.check ?? undefined} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", border: "1px solid var(--lx-line)", borderRadius: 12 }}><input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} style={{ marginTop: 3, width: 18, height: 18 }} /><span><b>Show my past WhatsApp conversations with {peek.from}</b><br /><small className={css.muted}>Your earlier messages and files with the team appear in your chats on Pulse. Only you, your colleagues and the team see them. You can change this later.</small></span></label> : null}
        {note ? <p className={css.note} data-tone="error" role="alert">{note}</p> : null}

        {me === undefined ? null : me ? <>
          <button type="button" className={`${css.btn} ${css.primary}`} onClick={accept} disabled={busy}>{busy ? "Connecting…" : <>Accept as {me.account ? `@${me.account.handle}` : "yourself"}<ArrowRight size={15} aria-hidden="true" /></>}</button>
          <p className={css.muted}>It uses your Pulse account; switch between organisations with Ctrl+Shift+O.</p>
        </> : <form className={css.form} onSubmit={create} aria-label="Your Pulse account">
          <label className={css.field}>Your name<input className={css.input} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} autoComplete="name" /></label>
          <label className={css.field}>Your handle<span className={css.prefix}><span>@</span><input className={css.input} value={shownHandle} onChange={(e) => { setTouched(true); setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, "")); }} required minLength={3} maxLength={30} autoCapitalize="none" spellCheck={false} autoComplete="username" /></span></label>
          <label className={css.field}>E-mail <small>(optional) another way to sign in</small><input className={css.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
          <NewPassword value={password} onChange={setPassword} inputClass={css.input} fieldClass={css.field} />
          <button className={`${css.btn} ${css.primary}`} disabled={busy}>{busy ? "Connecting…" : <>Create my account and accept<ArrowRight size={15} aria-hidden="true" /></>}</button>
          <a className={`${css.btn} ${css.quiet}`} href="/login?next=/invited"><LogIn size={15} aria-hidden="true" />I already have a Pulse account</a>
        </form>}
      </>}
  </div></div>;
}
