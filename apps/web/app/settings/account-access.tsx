"use client";
// ACCOUNT-META (owner, 15 Nov 2026: a person signs in only with the e-mail they name as their own; "admin@ addresses that I
// and others control cannot be able to log in — it is a security issue."): Settings -> Account access.
// The e-mails that sign this account in (only ones the person alone reads; never a shared mailbox), add one with a code
// and "only I can read this mailbox", remove one, make one the main one; where you are signed in; and the rule in plain
// words. A company's own sign-in (its password, its e-mailed code, its Google or Access) can see this list but not change
// it (pulse.account_access / account_email_*, migration 2125).
import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import Link from "next/link";
import { KeyRound, Laptop, MoreHorizontal, ShieldCheck, ShieldOff } from "lucide-react";
import { Menu, confirmDialog, toast } from "../kit";
import { post } from "../records";
import { addAccountPasskey, proveHere } from "../orgs/client";
import { passkeyMessage, passkeysSupported } from "../lib/passkeys";
import css from "./account-access.module.css";

type Email = { email: string; personal: boolean; primary: boolean; verified: boolean; kind: "personal" | "work" };
type Session = { id: string; company: string; device: string | null; since: string; via: string; personal: boolean; current: boolean };
// SWITCH-SMOOTH (2165): the browsers the person confirmed it's them on; every company opens there for 180 days.
type Device = { id: string; label: string; proof: string; provedAt: string; lastSeen: string; expiresAt: string; thisDevice: boolean };
const noSubscribe = () => () => {};
const oneLine = (s: string) => s.replace(/ /g, "\u00a0");
const HOW: Record<string, string> = { password: "with your password", code: "with a code to your e-mail", google: "with Google", microsoft: "with Microsoft",
  apple: "with Apple", passkey: "with a passkey", session: "by signing in as yourself" };
// SWITCH-SMOOTH (2178): the account's own passkeys (one tap to confirm it's you, on any device).
type Passkey = { id: string; name: string; addedAt: string; lastUsed: string | null };
type Access = { handle: string; password: boolean; protected: boolean; personalSession: boolean; emails: Email[]; removed: { email: string; at: string }[]; sessions: Session[] };

/** Signing in again (no sign-out first) replaces this sign-in with your own, then comes back here. */
const AGAIN = `/login?next=${encodeURIComponent("/settings?tab=account&part=access")}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function AccountAccess() {
  const [data, setData] = useState<Access | null>(null), [error, setError] = useState("");
  const [adding, setAdding] = useState(false), [email, setEmail] = useState(""), [sentTo, setSentTo] = useState(""), [wait, setWait] = useState(0), [busy, setBusy] = useState(false), [own, setOwn] = useState(false), [formError, setFormError] = useState("");
  const [round, setRound] = useState(0);
  const [devices, setDevices] = useState<Device[] | null>(null), [proving, setProving] = useState(false);
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null), [adding2, setAdding2] = useState(false);
  // Read in the browser only (the server draws no "Add a passkey").
  const canPasskey = useSyncExternalStore(noSubscribe, passkeysSupported, () => false);
  useEffect(() => {
    let live = true;
    void fetch("/api/v0/account/passkeys", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { passkeys: [] })).then((j: { passkeys?: Passkey[] }) => { if (live) setPasskeys(j.passkeys ?? []); })
      .catch(() => { if (live) setPasskeys([]); });
    void fetch("/api/v0/account/devices", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { devices: [] })).then((j: { devices?: Device[] }) => { if (live) setDevices(j.devices ?? []); })
      .catch(() => { if (live) setDevices([]); });
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

  async function forget(d: Device | null) {
    if (!await confirmDialog({ title: d ? (d.thisDevice ? "Forget this device?" : `Forget ${d.label}?`) : "Forget every device?",
      body: "Pulse will check it's you once more there before it opens your other companies. Nobody is signed out.", confirmLabel: d ? "Forget device" : "Forget all", danger: true })) return;
    try { const r = await post<{ devices: Device[] }>("account/devices", d ? { action: "forget", id: d.id } : { action: "forget", all: true }); setDevices(r.devices ?? []); toast.success(d ? "Device forgotten" : "Every device forgotten"); load(); }
    catch (err) { toast.error(err instanceof Error ? err.message : "That did not work"); }
  }
  async function addKey() {
    setAdding2(true);
    try { await addAccountPasskey(); toast.success("Passkey added. Next time it's one tap."); load(); }
    catch (err) { const m = passkeyMessage(err, ""); if (m) toast.error(m); } finally { setAdding2(false); }
  }
  async function removeKey(k: Passkey) {
    if (!await confirmDialog({ title: `Remove ${k.name}?`, body: "It will no longer confirm it's you. You can add a passkey again later.", confirmLabel: "Remove passkey", danger: true })) return;
    try { const r = await post<{ passkeys: Passkey[] }>("account/passkey", { action: "remove", id: k.id }); setPasskeys(r.passkeys ?? []); toast.success("Passkey removed"); }
    catch (err) { toast.error(err instanceof Error ? err.message : "That did not work"); }
  }
  async function confirmMe() {
    setProving(true);
    try { if (await proveHere()) { toast.success("Done. This device opens all your companies now."); load(); } }
    catch (err) { toast.error(err instanceof Error ? err.message : "That did not work"); } finally { setProving(false); }
  }

  if (error) return <div className={css.wrap}><p className={css.error} role="alert">{error}</p><button type="button" className={css.btn} onClick={load}>Try again</button></div>;
  if (!data) return <div className={css.wrap} aria-busy="true"><div className={css.skeleton} /><div className={css.skeleton} /><div className={css.skeleton} /></div>;
  return <div className={css.wrap} data-account-access>
    {locked ? <div className={css.rule} data-tone="look" role="status">
      <ShieldCheck size={20} aria-hidden="true" />
      <div>
        <p><b>You came in through a company’s sign-in, so you can only look here.</b> Your account is yours: only e‑mails that you alone read can sign you in. To change them or open your other companies, confirm it’s you once on this device.</p>
        <button type="button" className={css.primary} data-confirm-me="" disabled={proving} onClick={() => void confirmMe()}>{proving ? "Checking…" : "Confirm it’s you"}</button>
        <p className={css.foot}>Or <Link href={AGAIN}>sign in as yourself</Link>.</p>
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

    <section aria-labelledby="aa-passkeys" data-passkeys>
      <div className={css.headRow}><h2 className={css.head} id="aa-passkeys">Passkeys</h2>
        {!locked && canPasskey ? <button type="button" className={css.linkBtn} data-passkey-add="" disabled={adding2} onClick={() => void addKey()}>{adding2 ? "Adding…" : "+ Add a passkey"}</button> : null}</div>
      {passkeys === null ? <div className={css.skeleton} /> : passkeys.length ? <ul className={css.list}>{passkeys.map((k) => <li key={k.id} className={css.row} data-passkey-row>
        <span className={css.device}><KeyRound size={18} aria-hidden="true" /><span className={css.who}><b>{k.name}</b>
          <small>Added {oneLine(day(k.addedAt))} · {k.lastUsed ? `last used ${oneLine(day(k.lastUsed))}` : "not used yet"}</small></span></span>
        {locked ? null : <span className={css.links}><button type="button" className={css.btn} aria-label={`Remove ${k.name}`} onClick={() => void removeKey(k)}>Remove</button></span>}
      </li>)}</ul> : <p className={css.notice}>No passkey yet. With one, your fingerprint, face or screen lock confirms it’s you in one tap, on any device.</p>}
      {passkeys?.length ? <p className={css.foot}>A passkey is your fingerprint, face or screen lock. It confirms it’s you in one tap, instead of a code.</p> : null}
    </section>

    <section aria-labelledby="aa-devices" data-devices>
      <div className={css.headRow}><h2 className={css.head} id="aa-devices">Trusted devices</h2>
        {!locked && devices && devices.length > 1 ? <button type="button" className={css.linkBtn} onClick={() => void forget(null)}>Forget all</button> : null}</div>
      {devices === null ? <div className={css.skeleton} /> : devices.length ? <ul className={css.list}>{devices.map((d) => <li key={d.id} className={css.row} data-device-row>
        <span className={css.device}><ShieldCheck size={18} aria-hidden="true" /><span className={css.who}><b>{d.label}{d.thisDevice ? " · this device" : ""}</b>
          <small>Confirmed {HOW[d.proof] ?? ""} on {oneLine(day(d.provedAt))} · trusted until {oneLine(day(d.expiresAt))}</small></span></span>
        {locked ? null : <span className={css.links}><button type="button" className={css.btn} aria-label={`Forget ${d.label}${d.thisDevice ? " (this device)" : ""}`} onClick={() => void forget(d)}>Forget</button></span>}
      </li>)}</ul> : <p className={css.notice}>None yet. Once you confirm it’s you on a device, all your companies open there in one tap for 180 days.</p>}
      <p className={css.foot}>On a trusted device all your companies open in one tap. Forget one, and Pulse e-mails you a code there next time. To sign a device out, use <Link href="/settings?tab=account&part=security">Password &amp; security</Link>.</p>
    </section>
  </div>;
}
