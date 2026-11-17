"use client";
// SELLER-ONBOARD (owner, 17 Nov 2026): the card under "Sakobe sent the details of 6 sellers": what Pulse read, what it
// will do with each row (new, an update of someone already in Pulse, or not added and why), the problems it found, and
// for the people who may confirm, "Add 6 sellers" or "Not now". After it: who was added, the group, the testers' list
// and the invitations; each private invite link is shown once, ready to send on WhatsApp from the confirmer's phone.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, CircleAlert, Copy, Info, MessageCircle, TriangleAlert, Users } from "lucide-react";
import { get, send } from "./net";
import css from "./chats.module.css";
import ic from "./intake-card.module.css";

type Problem = { level: "block" | "warn" | "info"; code: string; text: string };
type Row = { n: number; name: string | null; phone: string | null; email: string | null; role: string | null; roleKey: string | null; active: boolean | null;
  joinedOn: string | null; reportsTo: string | null; area: string | null; languages: string[]; android: boolean | null; model: string | null; problems: Problem[];
  action?: "add" | "update" | "skip"; match?: { name: string; how: string } | null; manager?: { name: string } | null };
type Invite = { personId: string; name: string; mailed: boolean; link: string | null; whatsapp: string | null; error?: string };
type Result = { added: number; updated: number; skipped: number; rows: { n: number; name: string; action: string; why?: string; manager?: string }[];
  group: { id: string; name: string } | null; groupNote: string | null; testers: { label: string | null; count: number } | null; alreadyIn: number; invitedBefore: number;
  noEmail: string[]; invites?: { mailed: number; links: number; failed: { name: string; why: string | null }[]; people?: Invite[] } };
type Card = { id: string; state: "preview" | "applying" | "applied" | "dismissed" | "superseded" | "empty"; source: string; rows: Row[]; readFrom: { kind: string; name?: string }[];
  author: { id: string; name: string } | null; decidedBy: string | null; decidedAt: string | null; result: Result | null; canDecide: boolean; approvers: string[];
  intake: { title: string; groupName: string | null; groupId: string | null; testerLabel: string | null; handoff: boolean } };

const ROLE: Record<string, string> = { sales_executive: "Sales executive", team_lead: "Team lead", manager: "Manager", owner_admin: "Owner-admin" };
const DID: Record<string, "add" | "update" | "skip"> = { added: "add", updated: "update", skipped: "skip" };
const FROM: Record<string, string> = { text: "message", csv: "CSV", xlsx: "Excel", photo: "photo", doc: "doc", text_file: "text file" };
const one = (title: string, n: number) => (n === 1 ? title.replace(/s$/i, "") : title).toLowerCase();
/** A date with no time ("2025-08-12"), shown as that same day wherever the browser is. */
const day = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");

export function IntakeCard({ batchId }: { batchId: string }) {
  const [card, setCard] = useState<Card | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [leaveOut, setLeaveOut] = useState<Set<number>>(new Set()), [fresh, setFresh] = useState<Invite[] | null>(null), [copied, setCopied] = useState<string | null>(null);
  const load = useCallback(() => get<Card>(`people-intake/batches/${batchId}`).then((c) => { setCard(c); setError(""); }).catch((e: Error) => setError(e.message)), [batchId]);
  useEffect(() => { void load(); }, [load]);
  // Someone else may confirm it: a card still waiting looks again now and then, and when the tab comes back.
  useEffect(() => {
    if (card && card.state !== "preview" && card.state !== "applying") return;
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 20000);
    const back = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", back);
    return () => { window.clearInterval(t); document.removeEventListener("visibilitychange", back); };
  }, [card, load]);
  if (!card) return error ? <p className={ic.card} role="alert">{error}</p> : <p className={ic.card} data-loading="">Reading the list…</p>;
  const title = card.intake.title, rows = card.rows, planned = rows.some((r) => r.action);
  const counted = (a: string) => rows.filter((r) => r.action === a && !leaveOut.has(r.n)).length;
  const adding = planned ? counted("add") + counted("update") : rows.filter((r) => !r.problems.some((p) => p.level === "block")).length;
  const problems = rows.flatMap((r) => r.problems.map((p) => ({ ...p, row: r }))).sort((a, b) => ["block", "warn", "info"].indexOf(a.level) - ["block", "warn", "info"].indexOf(b.level));
  const confirm = async () => {
    setBusy(true); setError("");
    try { const r = await send<Result>(`people-intake/batches/${card.id}/confirm`, { skip: [...leaveOut] }); setFresh(r.invites?.people ?? []); await load(); }
    catch (e) { setError((e as Error).message); await load(); } finally { setBusy(false); }
  };
  const dismiss = async () => { setBusy(true); setError(""); try { await send(`people-intake/batches/${card.id}/dismiss`); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const copy = (link: string, id: string) => { void navigator.clipboard?.writeText(link).then(() => { setCopied(id); window.setTimeout(() => setCopied(null), 2000); }); };
  const from = card.readFrom.map((f) => f.name ? `${FROM[f.kind] ?? f.kind} “${f.name}”` : FROM[f.kind] ?? f.kind).join(", ");
  const res = card.result;
  const done = new Map((card.state === "applied" ? res?.rows ?? [] : []).map((x) => [x.n, x.action]));
  return <section className={ic.card} data-state={card.state} data-intake-card={card.id} aria-label={`${title} to add`}>
    <header>
      <b>{card.state === "preview" ? `Add ${adding} ${one(title, adding)}?` : card.state === "applying" ? "Adding…" : card.state === "applied" ? `${title} added to Pulse`
        : card.state === "dismissed" ? "Set aside" : card.state === "superseded" ? "Replaced by a newer list" : "Nothing to add"}</b>
      <small>{rows.length} row{rows.length === 1 ? "" : "s"}{from ? ` from the ${from}` : ""}{card.author ? ` · sent by ${card.author.name}` : ""}</small>
    </header>
    {planned && card.state === "preview" ? <p className={ic.counts}><span data-kind="add">{counted("add")} new</span><span data-kind="update">{counted("update")} already in Pulse (updated)</span>
      {rows.filter((r) => r.action === "skip" || leaveOut.has(r.n)).length ? <span data-kind="skip">{rows.filter((r) => r.action === "skip" || leaveOut.has(r.n)).length} not added</span> : null}</p> : null}
    <div className={ic.scroll} role="region" aria-label="The rows" tabIndex={0}>
      <table className={ic.table} data-pick={card.canDecide && card.state === "preview" ? "" : undefined}>
        <thead><tr>{card.canDecide && card.state === "preview" ? <th scope="col"><span className={ic.sr}>Add</span></th> : null}<th scope="col">#</th><th scope="col">Seller</th>
          <th scope="col">WhatsApp · Gmail</th><th scope="col">Role · reports to</th><th scope="col">Active</th><th scope="col">Area · languages</th><th scope="col">Phone</th></tr></thead>
        <tbody>{rows.map((r) => {
          const blocked = r.action === "skip" || r.problems.some((p) => p.level === "block"), out = blocked || leaveOut.has(r.n);
          // Once added: what was done with the row; before: what will be.
          const did = done.get(r.n), kind = did ? DID[did] : r.action;
          const status = did ? ({ added: "Added", updated: "Updated", skipped: "Not added" } as Record<string, string>)[did] ?? null
            : r.action === "update" ? `Updates ${r.match?.name ?? "their record"}` : r.action === "add" ? "New" : r.action === "skip" ? "Not added" : null;
          return <tr key={r.n} data-action={out || did === "skipped" ? "skip" : kind}>
            {card.canDecide && card.state === "preview" ? <td data-col="check"><input type="checkbox" aria-label={`Add ${r.name ?? `row ${r.n}`}`} disabled={blocked || busy} checked={!out}
              onChange={(e) => setLeaveOut((s) => { const x = new Set(s); if (e.target.checked) x.delete(r.n); else x.add(r.n); return x; })} /></td> : null}
            <td data-col="n">{r.n}</td>
            <th scope="row" data-col="name" data-n={r.n}><span>{r.name ?? <i>no name</i>}</span>{status ? <small data-status={kind}>{status}</small> : null}</th>
            <td data-col="contact"><span>{r.phone ?? "No number"}</span><small>{r.email ?? "No Gmail"}</small></td>
            <td data-col="role"><span>{r.roleKey ? ROLE[r.roleKey] : r.role ?? "Sales executive"}</span>{r.reportsTo ? <small>reports to {r.reportsTo}{planned && !r.manager ? " (not found)" : ""}</small> : null}</td>
            <td data-col="active"><span>{r.active === false ? "Not active" : r.active ? "Active" : "Active?"}</span>{r.joinedOn ? <small>since {day(r.joinedOn)}</small> : null}</td>
            <td data-col="area"><span>{r.area ?? "–"}</span>{r.languages.length ? <small>{r.languages.join(", ")}</small> : null}</td>
            <td data-col="phone"><span>{r.android === true ? "Android" : r.android === false ? "Not Android" : "Android?"}</span>{r.model ? <small>{r.model}</small> : null}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    {problems.length && (card.state === "preview" || card.state === "superseded") ? <ul className={ic.problems} aria-label="What Pulse found">{problems.map((p, i) =>
      <li key={i} data-level={p.level}>{p.level === "block" ? <CircleAlert size={13} aria-hidden="true" /> : p.level === "warn" ? <TriangleAlert size={13} aria-hidden="true" /> : <Info size={13} aria-hidden="true" />}
        <span><b>Row {p.row.n}{p.row.name ? ` · ${p.row.name}` : ""}:</b> {p.text}</span></li>)}</ul> : null}
    {card.state === "preview" ? (card.canDecide ? <>
      <p className={ic.what}>Adds them to People{card.intake.groupName ? `, puts them in the group “${card.intake.groupName}” with the first steps pinned` : ""}{card.intake.handoff ? `, sends the ${card.intake.testerLabel ?? "testers"} tester list` : ""} and sends each new person an invite. Nobody hears anything before you confirm.</p>
      <span className={css.aiActions}>
        <button type="button" className={css.primary} disabled={busy || adding === 0} onClick={() => void confirm()} data-intake-confirm="">{busy ? "Adding…" : `Add ${adding} ${one(title, adding)}`}</button>
        <button type="button" className={css.secondary} disabled={busy} onClick={() => void dismiss()}>Not now</button>
      </span>
      <small className={ic.muted}>Something wrong? Send the corrected list here: it replaces this one.</small></>
      : <small className={ic.muted}>Waiting for {card.approvers.join(" or ") || "an admin"} to confirm.</small>) : null}
    {card.state === "applied" && res ? <div className={ic.result} data-intake-result="">
      <p><Check size={14} aria-hidden="true" /><span>{res.added} added, {res.updated} updated{res.skipped ? `, ${res.skipped} not added` : ""}{card.decidedBy ? ` · confirmed by ${card.decidedBy}` : ""}</span></p>
      {res.rows.filter((r) => r.action === "skipped").map((r) => <small key={r.n} className={ic.muted}>Row {r.n} {r.name ?? ""}: {r.why}</small>)}
      {res.rows.filter((r) => r.manager?.startsWith("not set")).map((r) => <small key={`m${r.n}`} className={ic.muted}>{r.name}: manager {r.manager}</small>)}
      {res.group ? <p><Users size={14} aria-hidden="true" /><span><Link href={`/chats?channel=${res.group.id}`}>{res.group.name}</Link>: everyone is in it, with the first steps pinned.</span></p> : null}
      {res.groupNote ? <small role="alert">{res.groupNote}</small> : null}
      {res.testers ? <p><MessageCircle size={14} aria-hidden="true" /><span>{res.testers.count} sent to be added as {res.testers.label ?? "app"} testers. Their tester link is pinned in the group when it comes back.</span></p> : null}
      {res.invites ? <p>Invites: {res.invites.mailed} e-mailed{res.invites.links ? `, ${res.invites.links} as a private link` : ""}{res.alreadyIn ? ` · ${res.alreadyIn} already sign in` : ""}{res.invitedBefore ? ` · ${res.invitedBefore} invited before` : ""}{res.noEmail.length ? ` · no Gmail: ${res.noEmail.join(", ")}` : ""}.</p> : <p>Sending the invites…</p>}
      {res.invites?.failed?.length ? <small role="alert">Not invited: {res.invites.failed.map((f) => `${f.name}${f.why ? ` (${f.why})` : ""}`).join("; ")}</small> : null}
      {fresh?.some((x) => x.link) ? <div className={ic.links}>
        <small>Send each person their own link on WhatsApp now (shown only this once; later: their profile → Account access → Resend invitation):</small>
        {fresh.filter((x) => x.link).map((x) => <span key={x.personId}>
          {x.whatsapp ? <a className={css.secondary} href={x.whatsapp} target="_blank" rel="noreferrer" data-intake-whatsapp=""><MessageCircle size={14} aria-hidden="true" />{x.name}</a> : <b>{x.name}</b>}
          <button type="button" className={css.secondary} onClick={() => copy(x.link!, x.personId)} aria-label={`Copy ${x.name}'s invite link`}><Copy size={14} aria-hidden="true" />{copied === x.personId ? "Copied" : "Copy link"}</button>
        </span>)}
      </div> : null}
    </div> : null}
    {card.state === "dismissed" && card.decidedBy ? <small className={ic.muted}>Set aside by {card.decidedBy}. Send the list again to see it here.</small> : null}
    {error ? <small role="alert">{error}</small> : null}
  </section>;
}
