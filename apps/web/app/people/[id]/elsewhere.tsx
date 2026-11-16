"use client";
// PROFILE-UNIFY (1683): "Invite to another company": an admin, HR or leadership person who also runs another company
// on Pulse invites this person there, as a second seat or as a move. Their profile goes with them at once; the new
// company starts a fresh work record; on a move, this seat becomes alumni (history kept) when they accept.
import { ArrowRightLeft } from "lucide-react";
import { useState, type FormEvent } from "react";
import { post } from "../../orgs/client";
import css from "../../orgs/orgs.module.css";
import { styles } from "../../ui";
import { SelectField } from "../../kit/select-field";

type Targets = { targets: { id: string; name: string }[]; hasAccount: boolean };

export function InviteElsewhere({ personId, name }: { personId: string; name: string }) {
  const [open, setOpen] = useState(false); const [t, setT] = useState<Targets | null>(null);
  const [org, setOrg] = useState(""); const [title, setTitle] = useState(""); const [move, setMove] = useState(true);
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const first = name.split(/\s+/)[0];
  const show = async () => {
    setOpen(true); if (t) return;
    try { const r = await fetch(`/api/v0/account/invite-targets/${personId}`, { cache: "no-store" }); const d = (await r.json()) as Targets; setT(d); setOrg(d.targets[0]?.id ?? ""); }
    catch { setT({ targets: [], hasAccount: false }); }
  };
  const send = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setMsg(null);
    try { await post("account/invite-elsewhere", { person: personId, org, title, move }); setMsg({ tone: "ok", text: `Invited. ${first} sees it under My career and Organisations; ${move ? "accepting moves them and this seat becomes alumni." : "accepting adds a seat there."}` }); }
    catch (err) { setMsg({ tone: "error", text: err instanceof Error ? err.message : "Not invited" }); } finally { setBusy(false); }
  };
  if (!open) return <button type="button" className={styles.btn} onClick={() => void show()}><ArrowRightLeft size={14} aria-hidden="true" />Invite to another company</button>;
  return <form className={`${css.card} ${css.form}`} onSubmit={send} aria-label={`Invite ${name} to another company`} style={{ flexBasis: "100%" }}>
    {!t ? <p className={css.muted}>Reading your companies…</p> : !t.hasAccount ? <p className={css.muted}>{first} has no Pulse account yet. Ask them to claim their @handle on Organisations first.</p>
      : !t.targets.length ? <p className={css.muted}>You are not an admin, HR or leadership in another company where {first} could join.</p> : <>
      <div className={css.row}>
        <label className={css.field}>Company<SelectField className={css.select} value={org} onChange={(e) => setOrg(e.target.value)}>{t.targets.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</SelectField></label>
        <label className={css.field}>Role there <small>(optional)</small><input className={css.input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Video editor" /></label>
      </div>
      <label className={css.toggle}><input type="checkbox" checked={move} onChange={(e) => setMove(e.target.checked)} />Move {first} (their seat here ends when they accept; the history stays)</label>
      <div className={css.cardFoot}><button className={`${css.btn} ${css.primary}`} disabled={busy || !org}>{busy ? "Inviting…" : move ? "Invite to move" : "Invite"}</button>
        <button type="button" className={`${css.btn} ${css.quiet}`} onClick={() => setOpen(false)}>Close</button></div>
    </>}
    {msg ? <p className={css.note} data-tone={msg.tone} role={msg.tone === "error" ? "alert" : "status"}>{msg.text}</p> : null}
  </form>;
}
