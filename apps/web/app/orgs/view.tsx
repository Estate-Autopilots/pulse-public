"use client";
import { ArrowRight, Check, Copy, KeyRound, Link2, Mail, Plus, Sparkles, UserPlus, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { AccountState } from "../lib/api";
import { arrive, post, switchOrg, type Moved } from "./client";
import { kindLabel, orgInitials } from "./labels";
import css from "./orgs.module.css";

export type Invite = { id: string; kind: string; title: string | null; toHandle: string | null; link: boolean; status: string; at: string; expiresAt: string; by: string | null; who: string | null };
type Note = { tone: "ok" | "error" | "info"; text: string } | null;
const KINDS = [["staff", "Team member"], ["freelancer", "Freelancer"], ["client", "Client"]] as const;

/** The token of an invitation link pasted in (…/join#token) or the token itself. */
export const tokenOf = (raw: string) => { const t = raw.trim(); const m = /#([A-Za-z0-9_-]{43})\s*$/.exec(t); return m ? m[1] : /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null; };

export function OrgsView({ state: initial, error, invites: initialInvites, orgName }: { state: AccountState | null; error: string | null; invites: Invite[] | null; orgName: string }) {
  const [state, setState] = useState(initial);
  const [note, setNote] = useState<Note>(error ? { tone: "error", text: error } : null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, work: () => Promise<void>) => { setBusy(key); setNote(null); try { await work(); } catch (e) { setNote({ tone: "error", text: e instanceof Error ? e.message : "That did not work" }); } finally { setBusy(null); } };
  useEffect(() => { const h = window.location.hash; if (h.startsWith("#invite-") || h === "#join") document.getElementById(h === "#join" ? "join" : "invitations")?.scrollIntoView({ block: "center" }); }, []);
  const orgs = state?.orgs ?? [];
  return <div className={css.page}>
    {note ? <p className={css.note} data-tone={note.tone} role={note.tone === "error" ? "alert" : "status"}>{note.text}</p> : null}

    <section className={css.section} aria-labelledby="orgs-h">
      <div className={css.sectionHead}><h2 id="orgs-h">Your organisations</h2><p>Switch at once, no sign-in: <kbd className={css.kbd}>Ctrl</kbd> <kbd className={css.kbd}>Shift</kbd> <kbd className={css.kbd}>O</kbd> anywhere.</p></div>
      <div className={css.grid}>
        {orgs.map((o) => <div key={o.id} className={css.card} data-current={o.current ? "" : undefined}>
          <div className={css.cardHead}><span className={css.tile} data-big="" aria-hidden="true">{orgInitials(o.name)}</span>
            <div className={css.cardTitle}><b>{o.name}</b><small>{o.handle ? `@${o.handle}` : o.code} · {kindLabel(o.kind)}</small></div></div>
          <div className={css.cardFoot}>{o.current ? <span className={css.pill} data-tone="teal"><Check size={12} aria-hidden="true" />You are here</span>
            : <button type="button" className={`${css.btn} ${css.primary}`} disabled={!!busy} onClick={() => run(o.id, () => switchOrg(o.id, o.name))}>{busy === o.id ? "Opening…" : <>Open<ArrowRight size={15} aria-hidden="true" /></>}</button>}</div>
        </div>)}
        <a href="/orgs/new" className={css.card} data-clickable="" style={{ textDecoration: "none", color: "inherit", borderStyle: "dashed" }}>
          <div className={css.cardHead}><span className={css.tile} data-big="" data-invite="" aria-hidden="true"><Plus size={18} /></span>
            <div className={css.cardTitle}><b>Start your own Pulse</b><small>Your organisation, set up for your industry in one step</small></div></div>
        </a>
      </div>
    </section>

    {state?.invites?.length ? <section className={css.section} id="invitations" aria-labelledby="inv-h">
      <div className={css.sectionHead}><h2 id="inv-h">Invitations for you</h2></div>
      <div className={css.table}>{state.invites.map((v) => <div className={css.tr} key={v.id} id={`invite-${v.id}`}>
        <span><b>{v.org}</b> invited you as {kindLabel(v.kind).toLowerCase()}{v.title ? ` · ${v.title}` : ""}</span>
        <button type="button" className={`${css.btn} ${css.primary}`} disabled={!!busy} onClick={() => run(v.id, async () => arrive(await post<Moved>("account/accept", { id: v.id })))}>{busy === v.id ? "Joining…" : "Accept and open"}</button>
      </div>)}</div>
    </section> : null}

    <JoinByLink busy={busy} run={run} />
    <AccountCard state={state} setState={setState} busy={busy} run={run} setNote={setNote} />
    {initialInvites ? <InvitePeople initial={initialInvites} orgName={orgName} busy={busy} run={run} /> : null}
  </div>;
}

function JoinByLink({ busy, run }: { busy: string | null; run: (k: string, w: () => Promise<void>) => Promise<void> }) {
  const [link, setLink] = useState("");
  const submit = (e: FormEvent) => { e.preventDefault(); const token = tokenOf(link); void run("join", async () => { if (!token) throw new Error("Paste the whole invitation link you were sent"); arrive(await post<Moved>("account/accept", { token })); }); };
  return <section className={css.section} id="join" aria-labelledby="join-h">
    <div className={css.sectionHead}><h2 id="join-h">Join with an invitation link</h2><p>Someone sent you a Pulse link: paste it to join with this account.</p></div>
    <form className={css.row} onSubmit={submit}>
      <label className={css.field}>Invitation link<input className={css.input} value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…/join#…" autoComplete="off" spellCheck={false} /></label>
      <button className={css.btn} disabled={!link || busy === "join"}><Link2 size={15} aria-hidden="true" />{busy === "join" ? "Joining…" : "Join"}</button>
    </form>
  </section>;
}

function AccountCard({ state, setState, busy, run, setNote }: { state: AccountState | null; setState: (s: AccountState) => void; busy: string | null; run: (k: string, w: () => Promise<void>) => Promise<void>; setNote: (n: Note) => void }) {
  const account = state?.account ?? null;
  const [handle, setHandle] = useState(account?.handle ?? state?.suggestion ?? "");
  const [password, setPassword] = useState("");
  const [linkLogin, setLinkLogin] = useState(""); const [linkPassword, setLinkPassword] = useState("");
  const save = (e: FormEvent) => { e.preventDefault(); void run("claim", async () => { const s = await post<AccountState>("account/claim", { handle, password: password || undefined }); setState(s); setPassword(""); setNote({ tone: "ok", text: account ? "Saved." : `Your Pulse handle is @${s.account?.handle}.` }); }); };
  const link = (e: FormEvent) => { e.preventDefault(); void run("link", async () => { const s = await post<AccountState>("account/link", { login: linkLogin, password: linkPassword }); setState(s); setLinkPassword(""); setNote({ tone: "ok", text: `Linked to @${s.account?.handle}: its organisations are in your switcher now.` }); }); };
  return <section className={css.section} aria-labelledby="acct-h">
    <div className={css.sectionHead}><h2 id="acct-h">Your Pulse account</h2><p>{account ? <>Signed in as <b>@{account.handle}</b>. <a href="/orgs/profile">Your profile that travels with you →</a></> : "Claim a handle: organisations invite you by it, and you switch between them with it."}</p></div>
    <div className={css.grid}>
      <form className={`${css.card} ${css.form}`} onSubmit={save}>
        <label className={css.field}>Handle<span className={css.prefix}><span>@</span><input className={css.input} value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, ""))} maxLength={30} required minLength={3} autoCapitalize="none" spellCheck={false} /></span><small>3–30 letters, digits, dots or underscores</small></label>
        <label className={css.field}>{account?.hasPassword ? "New account password" : "Account password"} <small>(optional) signs you in at the shared address with @{handle || "handle"}</small>
          <input className={css.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} placeholder="At least 10 characters" /></label>
        <div className={css.cardFoot}><button className={`${css.btn} ${css.primary}`} disabled={busy === "claim"}><KeyRound size={15} aria-hidden="true" />{busy === "claim" ? "Saving…" : account ? "Save" : "Claim handle"}</button></div>
      </form>
      {!account ? <form className={`${css.card} ${css.form}`} onSubmit={link}>
        <b>Already have a Pulse account?</b><p className={css.muted}>Link this {state?.orgs?.[0]?.name ?? "organisation"} profile to it, so one account opens both.</p>
        <label className={css.field}>Handle or e-mail<input className={css.input} value={linkLogin} onChange={(e) => setLinkLogin(e.target.value)} autoCapitalize="none" spellCheck={false} required /></label>
        <label className={css.field}>Its password<input className={css.input} type="password" value={linkPassword} onChange={(e) => setLinkPassword(e.target.value)} autoComplete="current-password" required /></label>
        <div className={css.cardFoot}><button className={css.btn} disabled={busy === "link"}>{busy === "link" ? "Linking…" : "Link account"}</button></div>
      </form> : null}
    </div>
  </section>;
}

function InvitePeople({ initial, orgName, busy, run }: { initial: Invite[]; orgName: string; busy: string | null; run: (k: string, w: () => Promise<void>) => Promise<void> }) {
  const [invites, setInvites] = useState(initial);
  const [kind, setKind] = useState<string>("freelancer"); const [title, setTitle] = useState(""); const [toHandle, setToHandle] = useState("");
  const [made, setMade] = useState<{ link: string | null; toHandle: string | null } | null>(null); const [copied, setCopied] = useState(false);
  const refresh = async () => { const r = await fetch("/api/v0/account/invites", { cache: "no-store" }); if (r.ok) setInvites((await r.json()).invites); };
  const submit = (e: FormEvent) => { e.preventDefault(); setMade(null); setCopied(false); void run("invite", async () => { const r = await post<{ link: string | null; toHandle: string | null }>("account/invites", { kind, title, toHandle: toHandle.replace(/^@/, "") }); setMade(r); setTitle(""); setToHandle(""); await refresh(); }); };
  const copy = async () => { if (!made?.link) return; try { await navigator.clipboard.writeText(made.link); setCopied(true); } catch { setCopied(false); } };
  return <section className={css.section} aria-labelledby="invite-h">
    <div className={css.sectionHead}><h2 id="invite-h">Invite people to {orgName}</h2><p>Team members, freelancers and clients join with their own Pulse account. Nothing is e-mailed.</p></div>
    <form className={`${css.card} ${css.form}`} onSubmit={submit}>
      <div className={css.segmented} role="group" aria-label="They join as">{KINDS.map(([k, label]) => <button type="button" key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>)}</div>
      <p className={css.muted}>{kind === "client" ? "A client sees the tasks and chats you share with them, nothing else of the team." : kind === "freelancer" ? "A freelancer works like the team on what they are given, and keeps their profile and badges." : "A team member, like the people HR adds."}</p>
      <div className={css.row}>
        <label className={css.field}>Their role <small>(optional)</small><input className={css.input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder={kind === "client" ? "Client · Skyline Homes" : "Video editor"} /></label>
        <label className={css.field}>Their handle <small>(or leave empty for a private link)</small><span className={css.prefix}><span>@</span><input className={css.input} value={toHandle} onChange={(e) => setToHandle(e.target.value.toLowerCase())} autoCapitalize="none" spellCheck={false} /></span></label>
        <button className={`${css.btn} ${css.primary}`} disabled={busy === "invite"}><UserPlus size={15} aria-hidden="true" />{busy === "invite" ? "Inviting…" : toHandle ? "Invite" : "Make link"}</button>
      </div>
      {made?.link ? <div className={css.linkBox}><code>{made.link}</code><button type="button" className={css.btn} onClick={copy}>{copied ? <><Check size={14} aria-hidden="true" />Copied</> : <><Copy size={14} aria-hidden="true" />Copy</>}</button></div> : null}
      {made?.link ? <p className={css.muted}>Shown once. Send it privately; anyone with the link can join. It works for 14 days.</p> : made ? <p className={css.note} data-tone="ok"><Mail size={13} aria-hidden="true" /> @{made.toHandle} sees it in their switcher.</p> : null}
    </form>
    {invites.length ? <div className={css.table}>{invites.map((v) => <div className={css.tr} key={v.id}>
      <span><b>{kindLabel(v.kind)}</b>{v.title ? ` · ${v.title}` : ""} · {v.toHandle ? `@${v.toHandle}` : "private link"}{v.who ? ` · joined: ${v.who}` : ""}</span>
      <span className={css.pill} data-tone={v.status === "accepted" ? "teal" : undefined}>{v.status === "open" ? "Waiting" : v.status === "accepted" ? "Joined" : v.status === "revoked" ? "Withdrawn" : "Expired"}</span>
      {v.status === "open" ? <button type="button" className={`${css.btn} ${css.quiet}`} aria-label="Withdraw invitation" onClick={() => run(v.id, async () => { const r = await post<{ invites: Invite[] }>(`account/invites/${v.id}/revoke`); setInvites(r.invites); })}><X size={14} aria-hidden="true" />Withdraw</button> : null}
    </div>)}</div> : <p className={css.muted}><Sparkles size={13} aria-hidden="true" /> No invitations yet.</p>}
  </section>;
}
