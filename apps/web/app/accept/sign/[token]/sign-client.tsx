"use client";
// CONTRACTS-2: the client's signing page (the chosen concept: the summary first, the clauses as an accordion with "Ask
// for a change" on each, a sticky Sign bar, and the signing sheet). One main button: Sign.
import { useState } from "react";
import { agreementClauses, clauseRefs, readSource } from "@pulse/invoice-doc/browser";
import { money } from "../../../lib/contracts.mjs";
import { linkWords } from "../../../lib/agreements.mjs";
import { FALLBACK_ZONE } from "../../../lib/zone.mjs";
import { SignatureImage, SignSheet, TypedSignature, type Signature } from "../../../contracts/sign-sheet";
import css from "../../../contracts/sign.module.css";
import { clauseHeads, ContractText } from "../../../contracts/contract-text";

export type Seen = { expired?: boolean; from: string; key: string; title: string; body: string; scope: string; rates: { label: string; amountMinor: number; unit: string }[];
  currency: string; startsOn: string | null; endsOn: string | null; version: number; status: string; signedAt: string | null; expiresAt: string; canAnswer: boolean;
  zone?: string;
  me: { key: string; name: string; signer: string | null; signedAt: string | null; declinedAt: string | null; declinedNote: string | null };
  parties: { key: string; name: string; role: string; signer: string | null; signedAt: string | null; signedBy: string | null; kind: string | null; image: string | null; declinedAt: string | null }[];
  notes: { id: string; kind: string; clause: string | null; body: string | null; at: string; by: string | null; resolved: boolean }[] };

const day = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
const when = (iso: string, timeZone: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone });

async function send(token: string, body: Record<string, unknown>) {
  const r = await fetch(`/api/accept/sign/${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof d?.error === "string" ? d.error : "That did not work. Try again.");
  return d as Record<string, unknown>;
}

export function SignClient({ token, seen, now }: { token: string; seen: Seen; now: number }) {
  const [signing, setSigning] = useState(false);
  const [done, setDone] = useState<"signed" | "declined" | null>(seen.me.signedAt ? "signed" : seen.me.declinedAt ? "declined" : null);
  const [asking, setAsking] = useState<string | null>(null);
  const [askText, setAskText] = useState("");
  const [notes, setNotes] = useState(seen.notes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saying, setSaying] = useState(false);
  const clauses = agreementClauses(seen.body || seen.scope);
  const meta = readSource(seen.body || "").meta;
  const refs = clauseRefs(readSource(seen.body || "").text);
  const heads = clauseHeads(clauses.map((c) => c.title));
  const zone = seen.zone || FALLBACK_ZONE; // the sending company's own time zone
  const total = seen.rates.filter((r) => r.unit === "one_off" || r.unit === "deliverable").reduce((s, r) => s + r.amountMinor, 0);
  const open = seen.canAnswer && !done;

  async function ask(clause: string | null, change: boolean) {
    if (askText.trim().length < 2) { setError("Write what you would like changed."); return; }
    setBusy(true); setError(null);
    try {
      await send(token, { action: change ? "change" : "comment", clause, text: askText.trim(), name: seen.me.signer ?? undefined });
      setNotes([...notes, { id: `mine-${notes.length}`, kind: change ? "change_asked" : "commented", clause, body: askText.trim(), at: new Date().toISOString(), by: seen.me.signer ?? seen.me.name, resolved: false }]);
      setAsking(null); setAskText("");
    } catch (e) { setError(e instanceof Error ? e.message : "Not sent. Try again."); } finally { setBusy(false); }
  }
  async function decline() {
    setBusy(true); setError(null);
    try { await send(token, { action: "decline", text: askText.trim(), name: seen.me.signer ?? undefined }); setDone("declined"); setSaying(false); }
    catch (e) { setError(e instanceof Error ? e.message : "Not sent. Try again."); } finally { setBusy(false); }
  }
  async function sign(s: Signature) { await send(token, { action: "sign", ...s }); setSigning(false); setDone("signed"); }

  const askForm = (clause: string | null) => <div className={css.askBox}>
    <label className={css.label}>{clause ? `What should change in "${clause}"?` : "Your question or change"}
      <textarea value={askText} onChange={(e) => setAskText(e.target.value)} maxLength={2000} autoFocus /></label>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <div className={css.row}>
      <button type="button" className={css.btn} style={{ background: "var(--theme-action, #6b4cf0)", color: "var(--theme-action-text, #fff)", borderColor: "transparent" }} disabled={busy} onClick={() => ask(clause, true)}>{busy ? "Sending…" : "Send"}</button>
      <button type="button" className={css.btn} onClick={() => { setAsking(null); setAskText(""); setError(null); }}>Cancel</button>
    </div>
  </div>;

  // The bare page around it is already the one <main> (ui-shell, data-bare-page), so a plain container.
  return <div className={css.page}>
    <p className={css.from}>From {seen.from}</p>
    <h1 className={css.title}>{seen.title}</h1>
    <div className={css.summary}>
      {total ? <div><span>Total</span><strong>{money(total, seen.currency)}</strong></div> : null}
      {seen.startsOn ? <div><span>Starts</span><strong>{day(seen.startsOn)}</strong></div> : null}
      <div><span>For</span><strong>{seen.me.name}</strong></div>
    </div>
    {done === "signed" ? <div className={css.banner} data-tone="good" role="status"><strong>You signed this agreement. Thank you!</strong>
      <span>{seen.status === "active" || seen.parties.every((p) => p.signedAt || p.key === seen.me.key) ? "Everyone has signed. Keep a copy for your records." : `${seen.from} will sign next. You can download your copy now or later from this link.`}</span>
      <a className={css.btn} href={`/api/accept/sign/${token}/pdf`}>Download your copy (PDF)</a></div> : null}
    {done === "declined" ? <div className={css.banner} data-tone="bad" role="status"><strong>{`You said no. ${seen.from} has been told.`}</strong>
      <span>If you change your mind, ask them to send it again.</span></div> : null}
    {!seen.canAnswer && !done ? <div className={css.banner}><strong>This agreement is not waiting for your answer.</strong><span>{`Ask ${seen.from} if you have a question.`}</span></div> : null}

    <h2 className={css.h2}>The agreement</h2>
    {/* CONTRACTS-PRO: the printed document itself (letterhead, parties, numbered clauses, signatures) opens in a new tab. */}
    <a className={css.ask} href={`/api/accept/sign/${token}/pdf?inline=1`} target="_blank" rel="noreferrer">Read it as the printed document</a>
    <div className={css.clauses}>{clauses.map((c, i) => <details key={c.key} className={css.clause} open={i < 2}>
      <summary>{heads[i]}</summary>
      <div className={css.clauseBody}>
        <ContractText text={c.text} meta={meta} refs={refs} />
        {open ? asking === c.key ? askForm(heads[i]) : <button type="button" className={css.ask} onClick={() => { setAsking(c.key); setAskText(""); setError(null); }}>Ask for a change</button> : null}
      </div>
    </details>)}</div>

    {notes.length ? <section aria-label="Your questions"><h2 className={css.h2}>Questions and changes</h2>
      <ul className={css.notes}>{notes.map((n) => <li key={n.id}><span>{`${n.by ?? "Someone"}${n.clause ? ` · ${n.clause}` : ""} · ${when(n.at, zone)}${n.resolved ? " · done" : ""}`}</span>{n.body}</li>)}</ul></section> : null}
    {open ? asking === "general" ? askForm(null) : <button type="button" className={css.ask} onClick={() => { setAsking("general"); setAskText(""); setError(null); }}>Ask a question about the whole agreement</button> : null}

    <h2 className={css.h2}>Who signs</h2>
    <div className={css.parties}>{seen.parties.map((p) => <div key={p.key} className={css.partyBox}>
      <strong>{p.name}</strong>
      {p.signedAt ? <>{p.image ? <SignatureImage src={p.image} alt={`Signature of ${p.signedBy ?? p.name}`} /> : <TypedSignature name={p.signedBy ?? p.signer ?? p.name} />}
        <span className={css.ok}>{`Signed by ${p.signedBy ?? p.signer ?? p.name} · ${when(p.signedAt, zone)}`}</span></>
        : <span className={css.wait}>{p.declinedAt ? "Said no" : p.key === seen.me.key ? "Waiting for you" : "Not signed yet"}</span>}
    </div>)}</div>
    <a className={css.btn} href={`/api/accept/sign/${token}/pdf`}>Download as PDF</a>

    {open ? <div className={css.bar}><div className={css.barInner}>
      {saying ? <div className={css.askBox}>
        <label className={css.label}>Why not? (optional)<textarea value={askText} onChange={(e) => setAskText(e.target.value)} maxLength={1000} /></label>
        {error ? <p className={css.error} role="alert">{error}</p> : null}
        <div className={css.row}><button type="button" className={css.btn} disabled={busy} onClick={decline}>{busy ? "Sending…" : "Tell them I won't sign"}</button>
          <button type="button" className={css.btn} onClick={() => setSaying(false)}>Go back</button></div>
      </div> : <>
        <button type="button" className={css.big} onClick={() => setSigning(true)}>Sign</button>
        <div className={css.row} style={{ justifyContent: "space-between" }}>
          <span className={css.note}>{linkWords(seen.expiresAt, now, zone)}</span>
          <button type="button" className={css.ask} onClick={() => { setSaying(true); setAskText(""); setError(null); }}>Not ready to sign?</button>
        </div>
      </>}
    </div></div> : null}
    {signing ? <SignSheet signer={seen.me.signer ?? ""} what={`"${seen.title}"`} onSign={sign} onClose={() => setSigning(false)} /> : null}
  </div>;
}
