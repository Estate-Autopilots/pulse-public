"use client";
// CONNECTIONS (spec reports/CONNECT-MAP.md §3.5-3.8): one connection. Its sentence and agreement badge, the one next step
// (confirm / draft an agreement / review it / give a task), then Agreement, Tasks (you gave / they gave), Docs (shared by
// you / shared with you), Money and Activity. A task given here lands in the doer's own space; a doc is shared through
// their guest seat in yours; opening something of another space moves into it first. Pulse never sends an agreement.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Activity, ArrowRight, CheckCircle2, FileSignature, FileText, IndianRupee, ListChecks, Share2, XCircle } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Chip, GameCard, GamePage, PageHeader, celebrate } from "../../kit/game";
import { useConfirm } from "../../kit/dialogs";
import { CompanyMark } from "../../company-mark";
import { agreementBadge, isPersonSide, nextStep, otherSide, shortLine, sideName, type ConnRow } from "../../lib/connections.mjs";
import { money } from "../../lib/founder.mjs";
import { openCompany, post } from "../../orgs/client";
import css from "../connections.module.css";

type Item = { id: string; kind: string; ref: string; host: string; hostName: string; title: string; status?: string; dueOn?: string | null; doer?: string | null;
  access: string; governs: boolean; at: string; revokedAt: string | null; by: string | null; byAccount: string | null; mine: boolean };
export type Detail = ConnRow & { items: Item[]; money: { id: string; type: string; number: string | null; status: string; total: number; issued: string; due: string | null }[] | null;
  activity: { at: string; action: string; who: string | null; note: string | null; where: string }[]; endedOn: string | null; endReason: string | null;
  from: { org: string; name: string; current: boolean; personal: boolean } };

const message = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const day = (s: string | null | undefined) => s ? new Date(s.length === 10 ? `${s}T00:00:00Z` : s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "";
const TASK: Record<string, string> = { open: "To do", in_progress: "Doing", blocked: "Blocked", done: "Done", in_review: "In review", accepted: "Accepted", cancelled: "Cancelled" };
const ACTION: Record<string, string> = { "connection.made": "Connection added", "connection.confirmed": "Confirmed", "connection.agreement_drafted": "Agreement drafted",
  "connection.agreement_linked": "Agreement linked", "connection.task_given": "Task given", "connection.doc_shared": "Doc shared", "connection.doc_unshared": "Doc unshared",
  "connection.ended": "Connection ended" };

export function ConnectionPage({ initial, me }: { initial: Detail; me: string | null }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const from = d.from.org;
  const refresh = async () => { const r = await fetch(`/api/v0/connections/${d.id}/detail`, { cache: "no-store" }); if (r.ok) setD(await r.json()); router.refresh(); };
  const run = async (key: string, work: () => Promise<void>) => { setBusy(key); try { await work(); } catch (e) { notify({ id: "conn", tone: "error", title: "That did not work", message: message(e) }); } finally { setBusy(null); } };
  const open = async (host: string, hostName: string, path: string) => {
    if (host === from && d.from.current) { router.push(path); return; }
    try { await openCompany(host, hostName, path); } catch (e) { notify({ id: "conn-open", tone: "error", title: "Could not open it", message: message(e) }); }
  };

  const other = otherSide(d);
  const badge = agreementBadge(d.agreement);
  const step = nextStep(d);
  const canAct = !!d.mySide;
  const livesHere = d.mySide === "a";
  const tasks = d.items.filter((i) => i.kind === "task");
  const docs = d.items.filter((i) => i.kind === "doc" && !i.revokedAt);
  const iGave = (i: Item) => !!me && i.byAccount === me;
  const agreementItem = d.items.find((i) => i.kind === "contract" && i.governs && !i.revokedAt);

  const doStep = () => {
    if (!step) return;
    if (step.key === "confirm") void run("confirm", async () => { const r = await post<{ draft: unknown }>(`connections/${d.id}/confirm`, { from });
      notify({ id: "conn", tone: "success", title: "Confirmed", message: r.draft ? "A draft agreement is ready to review. Nothing was sent." : undefined, timeout: 4000 }); await refresh(); });
    else if (step.key === "draft") void run("draft", async () => { await post(`connections/${d.id}/agreement`, { from });
      notify({ id: "conn", tone: "success", title: "Draft agreement ready", message: "Review it. Nothing is sent until you press Send.", timeout: 4000 }); await refresh(); });
    else if (step.key === "review" && d.agreement.contract && d.agreement.host) void open(d.agreement.host, agreementItem?.hostName ?? d.from.name, `/contracts/${d.agreement.contract}`);
    else document.getElementById("give-task")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const stepAllowed = !!step && canAct && ((step.key !== "confirm" && step.key !== "draft") || livesHere);

  return <GamePage label="Connection">
    <PageHeader eyebrow={<><Link href="/connections" className={css.back}>Connections</Link> · {d.status === "suggested" ? "Suggested" : d.status === "ended" ? `Ended ${day(d.endedOn)}` : `Since ${day(d.startedOn ?? d.since)}`}</>}
      title={sideName(other)} subtitle={shortLine(d, me)}
      side={step && d.status !== "ended" ? undefined : <Chip tone={badge.tone}>{badge.text}</Chip>}
      primary={stepAllowed && step ? { label: busy ? "Working…" : step.label, onClick: doStep, busy: !!busy } : undefined} />

    {step && d.status !== "ended" ? <p className={css.next} role="note"><CheckCircle2 size={16} aria-hidden="true" />{step.why}</p> : null}

    <div className={css.cols}>
      <div className={css.col}>
        <GameCard title="Agreement" icon={FileSignature}>
          <div className={css.agree}>
            {d.agreement.title ? <><small className={css.rowSub}>{badge.text}</small><button type="button" className={css.linkBtn} onClick={() => void open(d.agreement.host ?? from, agreementItem?.hostName ?? d.from.name, `/contracts/${d.agreement.contract}`)}>{d.agreement.title}<ArrowRight size={13} aria-hidden="true" /></button></>
              : <p className={css.muted}>{d.kind === "investor" ? "Add the investment papers yourself." : livesHere ? "None yet. Pulse can draft one for you to review." : "None yet. The other side drafts it."}</p>}
          </div>
          <p className={css.small}>Pulse never sends or signs anything for you. You check it, then you send it.</p>
        </GameCard>

        <GameCard title="Tasks" icon={ListChecks} note={tasks.length ? String(tasks.length) : null}>
          {tasks.length ? <ul className={css.list}>{tasks.map((t) => <li key={t.id} className={css.row}>
            <CompanyMark name={t.hostName} size={28} />
            <button type="button" className={css.rowMain} onClick={() => void open(t.host, t.hostName, `/tasks/${t.ref}`)}>
              <b className={css.rowTitle}>{t.title}</b>
              <small className={css.rowSub}>{[iGave(t) ? `You gave it${t.doer ? ` to ${t.doer}` : ""}` : `${t.by ?? "They"} gave it`, t.host === from && d.from.personal ? "in your own space" : `in ${t.hostName}`, t.dueOn ? `due ${day(t.dueOn)}` : null].filter(Boolean).join(" · ")}</small>
            </button>
            <Chip tone={t.status === "done" || t.status === "accepted" ? "good" : undefined}>{TASK[t.status ?? ""] ?? "To do"}</Chip>
          </li>)}</ul> : <p className={css.muted}>No tasks between you yet.</p>}
          {canAct && d.status === "active" ? <GiveTask id={d.id} from={from} other={sideName(other)} person={isPersonSide(other)} onDone={refresh} /> : null}
        </GameCard>

        <GameCard title="Docs" icon={FileText} note={docs.length ? String(docs.length) : null}>
          {docs.length ? <ul className={css.list}>{docs.map((x) => <li key={x.id} className={css.row}>
            <CompanyMark name={x.hostName} size={28} />
            <button type="button" className={css.rowMain} onClick={() => void open(x.host, x.hostName, `/docs/${x.ref}`)}>
              <b className={css.rowTitle}>{x.title}</b>
              <small className={css.rowSub}>{[x.mine && canAct ? "Shared by you" : `Shared with you by ${x.by ?? sideName(other)}`, `can ${x.access}`, x.hostName].join(" · ")}</small>
            </button>
            {x.mine && canAct ? <button type="button" className={css.quietBtn} disabled={!!busy} onClick={() => void run(`unshare-${x.ref}`, async () => {
              if (!await confirm({ title: `Stop sharing “${x.title}”?`, body: `${sideName(other)} will no longer open it. The doc stays yours.`, confirmLabel: "Stop sharing" })) return;
              await post(`connections/${d.id}/unshare-doc`, { from, doc: x.ref }); await refresh(); })}>Stop sharing</button> : null}
          </li>)}</ul> : <p className={css.muted}>No docs shared yet.</p>}
          {canAct && d.status === "active" ? <ShareDoc id={d.id} from={from} person={isPersonSide(other)} onDone={refresh} /> : null}
        </GameCard>
      </div>

      <div className={css.col}>


        {d.money?.length ? <GameCard title="Money" icon={IndianRupee}>
          <div className={css.tableBox}><table className={css.table}><thead><tr><th scope="col">Document</th><th scope="col">Status</th><th scope="col">Total</th></tr></thead>
            <tbody>{d.money.map((m) => <tr key={m.id}><th scope="row">{m.type === "quotation" ? "Quote" : m.type === "proforma" ? "Proforma" : "Invoice"} {m.number ?? ""}<small>{day(m.issued)}</small></th>
              <td>{m.status.replace(/_/g, " ")}</td><td>{money(m.total)}</td></tr>)}</tbody></table></div>
        </GameCard> : null}

        <GameCard title="Activity" icon={Activity}>
          {d.activity.length ? <ul className={css.list}>{[...d.activity].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12).map((a, i) => <li key={`${a.at}-${i}`} className={css.row} data-compact="">
            <span className={css.rowMain} data-static=""><b className={css.rowTitle}>{ACTION[a.action] ?? a.action.replace(/^connection\./, "").replace(/_/g, " ")}</b>
              <small className={css.rowSub}>{[a.who, a.where, day(a.at), a.note].filter(Boolean).join(" · ")}</small></span>
          </li>)}</ul> : <p className={css.muted}>Nothing yet.</p>}
        </GameCard>

        {canAct && d.status !== "ended" ? <button type="button" className={css.endBtn} disabled={!!busy} onClick={() => void run("end", async () => {
          if (!await confirm({ title: `End your connection with ${sideName(other)}?`, body: "Shared docs close for them. Tasks stay with whoever does them. The history stays.", confirmLabel: "End connection", danger: true })) return;
          await post(`connections/${d.id}/close`, { from }); notify({ id: "conn", tone: "success", title: "Connection ended", timeout: 2500 }); await refresh(); })}>
          <XCircle size={15} aria-hidden="true" />End this connection</button> : null}
      </div>
    </div>
  </GamePage>;
}

function GiveTask({ id, from, other, person, onDone }: { id: string; from: string; other: string; person: boolean; onDone: () => Promise<void> }) {
  const [title, setTitle] = useState(""); const [due, setDue] = useState(""); const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      const r = await post<{ orgName: string; landed: string }>(`connections/${id}/give`, { from, title, dueOn: due || undefined, toHandle: to.replace(/^@/, "") || undefined });
      notify({ id: "conn-give", tone: "success", title: "Task given", message: r.landed === "theirs" ? `It is in ${r.orgName}. You both see it.` : "It waits here until they have their own space.", timeout: 4000 });
      celebrate(null); setTitle(""); setDue(""); await onDone();
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  return <form id="give-task" className={css.inline} onSubmit={submit} aria-label={`Give ${other} a task`}>
    <label className={css.field}><span>Give {other} a task</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} placeholder="What should they do?" required minLength={2} /></label>
    <div className={css.fields}>
      <label className={css.field}><span>Due <small>(optional)</small></span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
      {person ? null : <label className={css.field}><span>Their contact <small>(@handle)</small></span><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="@name" autoCapitalize="none" spellCheck={false} /></label>}
    </div>
    <small className={css.small}>It goes to their own space. You both see it.</small>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <div className={css.actions}><button className={css.quietBtn} disabled={busy || title.trim().length < 2}><Share2 size={14} aria-hidden="true" />{busy ? "Giving…" : "Give task"}</button></div>
  </form>;
}

function ShareDoc({ id, from, person, onDone }: { id: string; from: string; person: boolean; onDone: () => Promise<void> }) {
  const [docs, setDocs] = useState<{ id: string; title: string }[] | null>(null);
  const [doc, setDoc] = useState(""); const [access, setAccess] = useState("read"); const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  useEffect(() => { let live = true; void fetch(`/api/v0/connections/${id}/shareable-docs?from=${from}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : { docs: [] })
    .then((x: { docs: { id: string; title: string }[] }) => { if (live) setDocs(x.docs); }).catch(() => { if (live) setDocs([]); }); return () => { live = false; }; }, [id, from]);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    try { await post(`connections/${id}/share-doc`, { from, doc, access, toHandle: to.replace(/^@/, "") || undefined });
      notify({ id: "conn-share", tone: "success", title: "Doc shared", timeout: 2500 }); setDoc(""); await onDone(); }
    catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  if (docs && !docs.length) return <p className={css.small}>You have no docs here to share yet. Write one in Docs, then share it here.</p>;
  return <form className={css.inline} onSubmit={submit} aria-label="Share a doc">
    <div className={css.fields}>
      <label className={css.field}><span>Share a doc</span><select value={doc} onChange={(e) => setDoc(e.target.value)} required>
        <option value="">{docs ? "Pick a doc" : "Loading…"}</option>{(docs ?? []).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></label>
      <label className={css.field}><span>They can</span><select value={access} onChange={(e) => setAccess(e.target.value)}>
        <option value="read">Read</option><option value="comment">Comment</option><option value="edit">Edit</option></select></label>
      {person ? null : <label className={css.field}><span>Their contact <small>(@handle)</small></span><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="@name" autoCapitalize="none" spellCheck={false} /></label>}
    </div>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <div className={css.actions}><button className={css.quietBtn} disabled={busy || !doc}><Share2 size={14} aria-hidden="true" />{busy ? "Sharing…" : "Share"}</button></div>
  </form>;
}
