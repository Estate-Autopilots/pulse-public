"use client";
// DOCS-INTERACTIVE: the doc page's parts for docs that travel between people.
//   AskBanner     the recipient: "Asha asks you to approve this", with Approve / Ask for changes / Decline (or Mark as read)
//   TrackingChip  the recipient sees, always, that reading is measured, by whom it is seen, and what is never recorded
//   SendPanel     send the doc to a person (read, approve or review), with a note and a date; who it was sent to and their answer
//   ReadsPanel    the owner's and sender's reading receipts: "Read 92 %, 6 min, skipped §4", each section read, skimmed or skipped
//   LinksPanel    the doc's tasks, projects and goals (its brief or related), both ways
import { useEffect, useState } from "react";
import { Check, CheckCircle2, Eye, Pencil, RefreshCw, ThumbsUp, X } from "lucide-react";
import { post } from "../orgs/client";
import type { Answer } from "./blocks";
import { KindIcon } from "./editor";
import { when } from "./workbench";
import css from "./docs.module.css";

export type DocRequest = { id: string; docId: string; title: string; ask: "read" | "approve" | "review"; status: string; note: string | null; dueAt: string | null; from: string; fromId: string;
  to: string; toId: string; sentAt: string; answeredAt: string | null; answerNote: string | null; openedAt: string | null };
type SectionRead = { id: string; title: string; words: number; ms: number; views: number; state: "read" | "skimmed" | "skipped" };
export type ReadSummary = { personId: string; name: string; sessions: number; activeMs: number; depth: number; readPct: number; reReads: number; firstAt: string | null; lastAt: string | null;
  sections: SectionRead[]; summary: string; request: null | { id: string; ask: string; status: string; sentAt: string; answeredAt: string | null; openedAt: string | null } };
export type DocLink = { id: string; kind: "task" | "project" | "goal"; refId: string; role: "brief" | "related"; label: string; sub: string | null; href: string; hidden: boolean };
export type Interactive = { me: string; readsOn: boolean; tracking: boolean; forMe: DocRequest | null; requests: DocRequest[]; answers: Answer[]; links: DocLink[]; reads: ReadSummary[] };

const fail = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
export const ASK_WORDS = { read: "read", approve: "approve", review: "review" } as const;
export const STATUS_WORDS: Record<string, string> = { waiting: "Waiting", read: "Read", approved: "Approved", declined: "Declined", changes: "Asked for changes", cancelled: "Taken back" };
const mins = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`;
const day = (iso: string | null) => { if (!iso) return ""; const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }); };

function Head({ title, onClose }: { title: string; onClose: () => void }) {
  return <h2>{title}<button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={onClose} aria-label="Close"><X size={16} aria-hidden="true" /></button></h2>;
}

export function AskBanner({ request, onAnswered }: { request: DocRequest; onAnswered: () => void }) {
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<null | "changes" | "decline">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function answer(a: "approve" | "decline" | "changes" | "read") {
    setBusy(true); setError(null);
    try { await post(`docs/requests/${request.id}/answer`, { answer: a, note }); setMode(null); onAnswered(); } catch (e) { setError(fail(e)); } finally { setBusy(false); }
  }
  const waiting = request.status === "waiting";
  return <section className={css.ask} aria-label="What you are asked to do" data-state={request.status}>
    <p className={css.askLine}><strong>{request.from}</strong>{waiting ? ` asks you to ${ASK_WORDS[request.ask]} this doc` : ` sent you this doc to ${ASK_WORDS[request.ask]}`}
      {request.dueAt && waiting ? <span className={css.due}> · needed by {day(request.dueAt)}</span> : null}</p>
    {request.note ? <p className={css.askNote}>“{request.note}”</p> : null}
    {!waiting ? <p className={css.askDone}><CheckCircle2 size={16} aria-hidden="true" />You answered: {STATUS_WORDS[request.status] ?? request.status}{request.answeredAt ? `, ${when(request.answeredAt)}` : ""}</p>
      : <>
        {mode ? <label className={css.field}>{mode === "changes" ? "What should change?" : "Why not? (optional)"}<textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={2} /></label> : null}
        <div className={css.toolbarRow}>
          {request.ask === "approve" ? <>
            <button type="button" className={`${css.btn} ${css.violet}`} disabled={busy} onClick={() => void answer("approve")}><ThumbsUp size={16} aria-hidden="true" />Approve</button>
            {mode ? <button type="button" className={css.btn} disabled={busy || (mode === "changes" && !note.trim())} onClick={() => void answer(mode)}>{mode === "changes" ? "Send: ask for changes" : "Send: decline"}</button>
              : <><button type="button" className={css.btn} disabled={busy} onClick={() => setMode("changes")}><Pencil size={16} aria-hidden="true" />Ask for changes</button>
                <button type="button" className={`${css.btn} ${css.quiet}`} disabled={busy} onClick={() => setMode("decline")}><X size={16} aria-hidden="true" />Decline</button></>}
          </> : <>
            <button type="button" className={`${css.btn} ${css.violet}`} disabled={busy} onClick={() => void answer("read")}><Check size={16} aria-hidden="true" />{request.ask === "review" ? "Done reviewing" : "I have read it"}</button>
            {mode ? <button type="button" className={css.btn} disabled={busy || !note.trim()} onClick={() => void answer("changes")}>Send: ask for changes</button>
              : <button type="button" className={css.btn} disabled={busy} onClick={() => setMode("changes")}><Pencil size={16} aria-hidden="true" />Ask for changes</button>}
          </>}
        </div>
      </>}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
  </section>;
}

export function TrackingChip({ from }: { from: string | null }) {
  return <details className={css.track}>
    <summary><Eye size={13} aria-hidden="true" />Read tracking on</summary>
    <p>Pulse notes how long each part of this doc is on your screen while you are active, and how far you scroll, so {from ?? "the sender"} knows it was read.
      Only {from ?? "the sender"} and the doc&apos;s owner see it. What you type and click is never recorded. Your company can turn this off.</p>
  </details>;
}

export function SendPanel({ docId, ix, onClose, onChanged, beforeSend }: { docId: string; ix: Interactive | null; onClose: () => void; onChanged: () => void; beforeSend: () => Promise<void> }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ kind: "person" | "agent"; id: string; label: string }[]>([]);
  const [to, setTo] = useState<{ id: string; label: string } | null>(null);
  const [ask, setAsk] = useState<"approve" | "read" | "review">("approve");
  const [note, setNote] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => {
    if (!q.trim()) return;
    const t = setTimeout(() => { void fetch(`/api/v0/docs/mentions?q=${encodeURIComponent(q)}&kinds=person,agent`, { cache: "no-store" }).then((r) => r.ok ? r.json() : { items: [] }).then((d) => setHits(d.items ?? [])); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  async function send() {
    if (!to) return;
    setBusy(true); setError(null);
    try {
      await beforeSend();
      await post(`docs/${docId}/requests`, { to: to.id, ask, note: note.trim() || undefined, dueAt: due || undefined });
      setSent(to.label); setTo(null); setNote(""); setDue(""); onChanged();
    } catch (e) { setError(fail(e)); } finally { setBusy(false); }
  }
  const mine = (ix?.requests ?? []).filter((r) => r.fromId === ix?.me);
  return <aside className={css.panel}>
    <Head title="Send for approval" onClose={onClose} />
    <p className={css.hint}>They get a notification and answer right in the doc. You see how much they read.</p>
    {to ? <p className={css.picked}><KindIcon kind="person" />{to.label}<button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={() => setTo(null)} aria-label="Choose someone else"><X size={14} aria-hidden="true" /></button></p>
      : <>
        <label className={css.field}>Send to<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a name" autoComplete="off" /></label>
        {(q.trim() ? hits : []).slice(0, 6).map((h) => <button key={h.id} type="button" className={`${css.btn} ${css.small} ${css.quiet}`} style={{ justifyContent: "flex-start" }}
          onClick={() => { setTo({ id: h.id, label: h.label }); setQ(""); setSent(null); }}><KindIcon kind={h.kind} />{h.label}</button>)}
      </>}
    <fieldset className={css.choice}><legend>Ask them to</legend>
      {(["approve", "read", "review"] as const).map((a) => <label key={a} className={css.radio}><input type="radio" name="ask" checked={ask === a} onChange={() => setAsk(a)} />
        <span><strong>{a === "approve" ? "Approve it" : a === "read" ? "Read it" : "Review and edit it"}</strong><br />
          <span className={css.hint}>{a === "approve" ? "They approve, decline or ask for changes." : a === "read" ? "They confirm they read it." : "They can change the words too."}</span></span></label>)}
    </fieldset>
    <label className={css.field}>Note (optional)<textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="e.g. Please check the dates in section 3" /></label>
    <label className={css.field}>Needed by (optional)<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    {sent ? <p className={css.okay} role="status"><CheckCircle2 size={16} aria-hidden="true" />Sent to {sent}.</p> : null}
    <button type="button" className={`${css.btn} ${css.violet}`} disabled={!to || busy} onClick={() => void send()}>{busy ? "Sending…" : "Send"}</button>
    {mine.length ? <>
      <p className={css.sideHead}>Sent</p>
      <ul className={css.sentList}>{mine.map((r) => <li key={r.id}>
        <span><strong>{r.to}</strong> · {ASK_WORDS[r.ask]}</span>
        <span className={css.state} data-state={r.status}>{STATUS_WORDS[r.status] ?? r.status}</span>
        {r.status === "waiting" ? <button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={() => { void post(`docs/requests/${r.id}/cancel`).then(onChanged).catch((e) => setError(fail(e))); }}>Take back</button> : null}
        {r.answerNote ? <q>{r.answerNote}</q> : null}
      </li>)}</ul>
    </> : null}
  </aside>;
}

const SECTION_WORDS = { read: "Read", skimmed: "Skimmed", skipped: "Skipped" } as const;
export function ReadsPanel({ ix, onClose, onRefresh }: { ix: Interactive | null; onClose: () => void; onRefresh: () => void }) {
  const reads = ix?.reads ?? [];
  return <aside className={css.panel}>
    <Head title="Who read it" onClose={onClose} />
    {!ix?.readsOn ? <p className={css.hint}>Reading receipts are off for your company. An admin turns them on in Docs.</p> : null}
    <p className={css.hint}>Only time when the doc was on screen and the person was active counts. Only you{ix?.requests.some((r) => r.fromId !== ix.me) ? ", the sender" : ""} and the owner see this.</p>
    {!reads.length ? <p className={css.empty}>Nobody has opened it yet. Send it with “Send for approval”.</p> : reads.map((r) => <div key={r.personId} className={css.readCard}>
      <p className={css.readHead}><strong>{r.name}</strong>{r.request ? <span className={css.state} data-state={r.request.status}>{STATUS_WORDS[r.request.status] ?? r.request.status}</span> : null}</p>
      <p className={css.readSummary}>{r.summary}</p>
      <div className={css.meter} role="img" aria-label={`Read ${r.readPct} percent`}><span style={{ width: `${Math.min(100, r.readPct)}%` }} /></div>
      <p className={css.hint}>{r.sessions ? `${r.sessions} visit${r.sessions > 1 ? "s" : ""} · scrolled to ${Math.round(r.depth * 100)} % · ${mins(r.activeMs)} active` : "Not opened yet"}
        {r.request?.openedAt ? ` · first opened ${when(r.request.openedAt)}` : ""}{r.request?.answeredAt ? ` · answered ${when(r.request.answeredAt)}` : ""}</p>
      {r.sections.length ? <ol className={css.sections}>{r.sections.map((s, i) => <li key={s.id} data-state={s.state}>
        <span className={css.secName}>§{i + 1} {s.title}</span>
        <span className={css.secState}>{SECTION_WORDS[s.state]}{s.ms ? ` · ${mins(s.ms)}` : ""}{s.views > r.sessions ? ` · re-read` : ""}</span>
      </li>)}</ol> : null}
    </div>)}
    <button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} onClick={onRefresh}><RefreshCw size={14} aria-hidden="true" />Refresh</button>
  </aside>;
}

export function LinksPanel({ docId, links, canEdit, onClose, onLinks }: { docId: string; links: DocLink[]; canEdit: boolean; onClose: () => void; onLinks: (l: DocLink[]) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ kind: "task" | "project" | "goal"; id: string; label: string; sub: string | null }[]>([]);
  const [brief, setBrief] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!q.trim()) return;
    const t = setTimeout(() => { void fetch(`/api/v0/docs/mentions?q=${encodeURIComponent(q)}&kinds=task,project,goal`, { cache: "no-store" }).then((r) => r.ok ? r.json() : { items: [] }).then((d) => setHits(d.items ?? [])); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  async function act(path: string, body: unknown = {}) {
    setError(null);
    try { const r = await post<{ links: DocLink[] }>(path, body); onLinks(r.links); setQ(""); } catch (e) { setError(fail(e)); }
  }
  return <aside className={css.panel}>
    <Head title="Linked work" onClose={onClose} />
    <p className={css.hint}>Tasks, projects and goals this doc belongs to. Each one lists this doc too.</p>
    {links.length ? <ul className={css.sentList}>{links.map((l) => <li key={l.id}>
      <a href={l.hidden ? undefined : l.href} className={css.linkName}><KindIcon kind={l.kind} />{l.label}</a>
      {l.role === "brief" ? <span className={css.state} data-state="approved">Brief</span> : null}
      {l.sub ? <span className={css.hint}>{l.sub.replace(/_/g, " ")}</span> : null}
      {canEdit ? <button type="button" className={`${css.btn} ${css.small} ${css.quiet}`} aria-label={`Unlink ${l.label}`} onClick={() => void act(`docs/${docId}/links/${l.id}/remove`)}><X size={14} aria-hidden="true" /></button> : null}
    </li>)}</ul> : <p className={css.hint}>Nothing linked yet.</p>}
    {canEdit ? <>
      <label className={css.field}>Link a task, project or goal<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type its name" autoComplete="off" /></label>
      <label className={css.radio}><input type="checkbox" checked={brief} onChange={(e) => setBrief(e.target.checked)} />This doc is its brief</label>
      {(q.trim() ? hits : []).slice(0, 8).map((h) => <button key={`${h.kind}:${h.id}`} type="button" className={`${css.btn} ${css.small} ${css.quiet}`} style={{ justifyContent: "flex-start" }}
        onClick={() => void act(`docs/${docId}/links`, { kind: h.kind, id: h.id, role: brief ? "brief" : "related" })}><KindIcon kind={h.kind} />{h.label}{h.sub ? <small className={css.hint}>· {h.sub.replace(/_/g, " ")}</small> : null}</button>)}
    </> : null}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
  </aside>;
}
