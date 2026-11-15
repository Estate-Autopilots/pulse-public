"use client";
// ACCOUNT-META (owner, 15 Nov 2026: a person signs in only with the e-mail they name as their own; "admin@ addresses that I
// and others control cannot be able to log in — it is a security issue."): Settings -> Account access.
// The e-mails that sign this account in (only ones the person alone reads; never a shared mailbox), add one with a code
// and "only I can read this mailbox", remove one, make one the main one; where you are signed in; and the rule in plain
// words. A company's own sign-in (its password, its e-mailed code, its Google or Access) can see this list but not change
// it (pulse.account_access / account_email_*, migration 2125).
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Laptop, MoreHorizontal, ShieldCheck, ShieldOff } from "lucide-react";
import { Menu, confirmDialog, toast } from "../kit";
import { post } from "../records";
import css from "./account-access.module.css";

type Email = { email: string; personal: boolean; primary: boolean; verified: boolean; kind: "personal" | "work" };
type Session = { id: string; company: string; device: string | null; since: string; via: string; personal: boolean; current: boolean };
type Access = { handle: string; password: boolean; protected: boolean; personalSession: boolean; emails: Email[]; removed: { email: string; at: string }[]; sessions: Session[] };

/** Signing in again (no sign-out first) replaces this sign-in with your own, then comes back here. */
const AGAIN = `/login?next=${encodeURIComponent("/settings?tab=account&part=access")}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function AccountAccess() {
  const [data, setData] = useState<Access | null>(null), [error, setError] = useState("");
  const [adding, setAdding] = useState(false), [email, setEmail] = useState(""), [sentTo, setSentTo] = useState(""), [wait, setWait] = useState(0), [busy, setBusy] = useState(false), [own, setOwn] = useState(false), [formError, setFormError] = useState("");
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    void fetch("/api/v0/account/access", { cache: "no-store" })
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? "Could not load your sign-in"); return j as Access; })
      .then((j) => { if (live) { setData(j); setError(""); } })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : "Could not load your sign-in"); });
    return () => { live = false; };
  }, [round]);
  const load = () => { setError(""); setRound((n) => n + 1); };
  useEffect(() => { if (wait <= 0) return; const t = setTimeout(() => setWait((w) => w - 1), 1000); return () => clearTimeout(t); }, [wait]);

  const locked = !!data && data.protected && !data.personalSession;
  async function act(action: "remove" | "primary", e: Email) {
    if (action === "remove" && !await confirmDialog({ title: `Remove ${e.email}?`, body: "It will no longer sign you in. You can add it again later with a code.", confirmLabel: "Remove e-mail", danger: true })) return;
    try { setData(await post<Access>("account/emails", { action, email: e.email })); toast.success(action === "remove" ? "E-mail removed" : `${e.email} is now your main e-mail`); }
    catch (err) { toast.error(err instanceof Error ? err.message : "That did not work"); }
  }
  async function send(ev?: FormEvent) {
    ev?.preventDefault(); setFormError("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setFormError("Type a whole e-mail address, like name@example.com."); return; }
    if (!own) { setFormError("Tick “Only I can read this inbox” first. A shared inbox must never sign you in."); return; }
    setBusy(true);
    try { const r = await post<{ to: string; resendIn: number }>("account/emails", { action: "start", email: email.trim() }); setSentTo(r.to); setWait(r.resendIn ?? 60); }
    catch (err) { setFormError(err instanceof Error ? err.message : "The code could not be sent"); } finally { setBusy(false); }
  }
  async function finish(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault(); setFormError("");
    const code = String(new FormData(ev.currentTarget).get("code") ?? "").replace(/\D/g, "");
    if (code.length !== 6) { setFormError("Type the 6 digits from the e-mail."); return; }
    setBusy(true);
    try { setData(await post<Access>("account/emails", { action: "finish", email: email.trim(), code, own })); toast.success(`${email.trim()} now signs you in`); setEmail(""); setSentTo(""); setOwn(false); setAdding(false); }
    catch (err) { setFormError(err instanceof Error ? err.message : "That code did not work"); } finally { setBusy(false); }
  }

  if (error) return <div className={css.wrap}><p className={css.error} role="alert">{error}</p><button type="button" className={css.btn} onClick={load}>Try again</button></div>;
  if (!data) return <div className={css.wrap} aria-busy="true"><div className={css.skeleton} /><div className={css.skeleton} /><div className={css.skeleton} /></div>;
  return <div className={css.wrap} data-account-access>
    {locked ? <div className={css.rule} data-tone="look" role="status">
      <ShieldCheck size={20} aria-hidden="true" />
      <div>
        <p><b>You came in through a company’s sign-in, so you can only look here.</b> Your account is yours: only e‑mails that you alone read can sign you in. To change them or open your other companies, sign in as yourself.</p>
        <Link className={css.primary} href={AGAIN}>Sign in as yourself</Link>
      </div>
    </div> : <div className={css.rule} role="note">
      <ShieldCheck size={20} aria-hidden="true" />
      <div>
        <p><b>Your account is yours.</b> Only e‑mails that you alone read can sign you in, never shared ones like admin@ or info@. A company can remove you, but never sign in as you.</p>
      </div>
    </div>}

    <section aria-labelledby="aa-emails">
      <div className={css.headRow}><h2 className={css.head} id="aa-emails">E-mails that sign you in</h2>
        {locked || adding || sentTo ? null : <button type="button" className={css.linkBtn} data-add-open onClick={() => { setAdding(true); requestAnimationFrame(() => document.getElementById("aa-new-email")?.focus()); }}>+ Add an e-mail</button>}</div>
      {data.emails.length ? <ul className={css.list}>
        {data.emails.map((e) => <li key={e.email} className={css.emailRow} data-email-row>
          <b className={css.address}>{e.email}</b>
          {e.primary || !e.personal ? <span className={css.tags}>{e.primary ? <span className={css.tag} data-tone="main">Main</span> : null}
            {e.personal ? null : <span className={css.tag}>Work e-mail · not confirmed as only yours</span>}</span> : null}
          {locked || e.primary ? null : <span className={css.links}>
            <Menu label={`Actions for ${e.email}`} buttonLabel={`Actions for ${e.email}`} className={css.menuBtn}
              items={[{ key: "primary", label: "Make main", onSelect: () => void act("primary", e) }, { key: "remove", label: "Remove", danger: true, onSelect: () => void act("remove", e) }]}>
              <MoreHorizontal size={18} aria-hidden="true" /></Menu></span>}
        </li>)}
      </ul> : <p className={css.notice}>No e-mail signs you in yet. Add one that only you read, so you can always get a sign-in code.</p>}
      <p className={css.foot}>{data.password ? "Your Pulse password also signs you in, with your username @" + data.handle + " or any e-mail above. To change the main e-mail, make another one main first." : "You have no Pulse password yet: set one in Password & security."}</p>
    </section>

    {data.removed.map((r) => <p key={r.email + r.at} className={css.removed} data-removed>
      <ShieldOff size={16} aria-hidden="true" /><span><b>{r.email}</b> was removed on {day(r.at)}, because it is a shared mailbox.</span></p>)}
    {locked || !(adding || sentTo) ? null : <section aria-labelledby="aa-add">
      <h2 className={css.head} id="aa-add">Add an e-mail</h2>
      {!sentTo ? <form className={css.add} onSubmit={(ev) => void send(ev)}>
        <label htmlFor="aa-new-email">E-mail</label>
        <div className={css.addRow}>
          <input id="aa-new-email" type="email" value={email} onChange={(ev) => setEmail(ev.target.value)} autoComplete="email" placeholder="you@example.com" maxLength={254} />
          <button type="submit" className={css.primary} disabled={busy}>{busy ? "Sending…" : "Send code"}</button>
        </div>
        <label className={css.check}><input type="checkbox" checked={own} onChange={(ev) => setOwn(ev.target.checked)} />Only I can read this inbox (no admin or team shares it).</label>
        {formError ? <p className={css.error} role="alert">{formError}</p> : null}
      </form> : <form className={css.add} onSubmit={(ev) => void finish(ev)}>
        <p className={css.sent} role="status">We sent a 6-digit code to <b>{email.trim()}</b>. It works for 10 minutes. Not there? Check spam.</p>
        <label>6-digit code<input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="6 digits" /></label>
        {formError ? <p className={css.error} role="alert">{formError}</p> : null}
        <div><button type="submit" className={css.primary} disabled={busy}>{busy ? "Adding…" : "Add e-mail"}</button></div>
        <div className={css.formLinks}>
          <button type="button" className={css.linkBtn} disabled={busy || wait > 0} onClick={() => void send()}>{wait > 0 ? `Send again in ${wait} s` : "Send again"}</button>
          <button type="button" className={css.linkBtn} onClick={() => { setSentTo(""); setFormError(""); }}>Use another e-mail</button>
        </div>
      </form>}
    </section>}


    <section aria-labelledby="aa-sessions">
      <h2 className={css.head} id="aa-sessions">Where you are signed in</h2>
      <ul className={css.list}>{[...data.sessions].sort((a, b) => Number(b.current) - Number(a.current)).map((s) => <li key={s.id} className={css.row}>
        <span className={css.device}><Laptop size={18} aria-hidden="true" /><span className={css.who}><b>{s.company}{s.current ? " · this device" : ""}</b><small>{s.device ?? "Browser"} · since {day(s.since)}</small></span></span>
        <span className={css.tags}>{s.personal ? <span className={css.tag} data-tone="good">Your own sign-in</span> : <span className={css.tag}>Only for {s.company}</span>}</span>
      </li>)}</ul>
      <p className={css.foot}>Sign out a device in <Link href="/settings?tab=account&part=security">Password &amp; security</Link>.</p>
    </section>
  </div>;
}
