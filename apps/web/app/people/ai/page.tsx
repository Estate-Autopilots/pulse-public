import Link from "next/link";
import type { ReactNode } from "react";
import { AlertTriangle, Bot, CheckCircle2, Clock3, MessageSquareText, PhoneMissed, Send, UserRoundCheck } from "lucide-react";
import { api } from "../../lib/api";
import { Avatar, Badge, Empty, Message, Page, PageHeader, styles } from "../../ui";
import { AiBadge } from "../../kit";
import css from "./workload.module.css";

// AI-EMP-2 (owner, 25 Oct 2026): the AI workload for admins and leaders (and an AI employee's manager, for theirs): what
// each AI employee did on a day, its cards waiting for a person, its questions to colleagues waiting, and the mistakes
// people caught (a card edited before it went, or turned down; a run that failed). GET /api/v0/agents/workload (1056).

type Card = { id: string; kind: string; body: string; why: string | null; urgent: boolean; channel: string; channelId: string; client: boolean; approver: string; since: string;
  reminded: string | null; escalatedTo: string | null; messageId: string | null; chatId: string };
type Question = { id: string; colleague: string; question: string; for: string | null; channel: string; client: boolean; since: string; state: string; reminded: string | null; escalated: string | null; chatId: string };
type Caught = { at: string; kind: string; by: string | null; channel: string | null; wrote: string | null; sent: string | null };
type Step = { at: string; kind: string; state: string; error: string | null; tokens: number | null; seconds: number | null; about: string | null; from: string | null; where: string | null; did: string[] };
type Agent = { id: string; name: string; title: string; employeeId: string; approver: string | null; manager: string | null; status: "on" | "paused" | "off";
  runtime: { state: string | null; until: string | null; provider: string | null };
  did: { runs: number; tokens: number; failed: number; answered: number; tasks: number; afterAnswers: number; quietClients: number; missedCalls: number; recordedCalls: number };
  posted: number;
  cards: { made: number; replies: number; tasks: number; sent: number; edited: number; turnedDown: number; expired: number; waiting: number; reminded: number; escalated: number; urgent: number };
  asked: { asked: number; answered: number; relayed: number; reminded: number; escalated: number };
  waitingCards: Card[]; waitingQuestions: Question[]; caught: Caught[]; timeline: Step[] };
type Workload = { day: string; timeZone: string; agents: Agent[] };

const KIND: Record<string, string> = { "chat.message": "Direct message", "chat.mention": "Mentioned", "chat.reply": "Reply to it", "chat.group": "Group message", "task.assigned": "Task given to it",
  "task.mention": "Mentioned on a task", "consult.answer": "A colleague answered it", "client.silent": "Quiet client", "call.missed": "Missed call", "call.recorded": "Recorded call" };
const CAUGHT: Record<string, string> = { edited: "Edited before sending", turned_down: "Turned down", model_error: "Run failed", runaway: "Stopped as a runaway", no_answer: "Gave no answer", stuck: "Got stuck", needs_budget: "Needed more budget", out_of_quota: "Out of quota", error: "Run failed" };
const DID: Record<string, string> = { "card:reply:pending": "card waiting", "card:reply:sent": "card sent", "card:reply:dismissed": "card turned down", "card:reply:expired": "card expired",
  "card:task:pending": "task card waiting", "card:task:sent": "task created", "card:task:dismissed": "task turned down", "card:task:expired": "task card expired" };
const n = (x: number) => Number(x || 0).toLocaleString("en-IN");
const k = (x: number) => x >= 1000 ? `${(x / 1000).toFixed(x < 10000 ? 1 : 0).replace(/\.0$/, "")}k` : String(x);

function when(iso: string, zone: string) { return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: zone }); }
function since(iso: string, zone: string, now: number) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  const ago = m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
  return `${ago} (since ${new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: zone })})`;
}
const shiftDay = (day: string, by: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + by); return d.toISOString().slice(0, 10); };
const dayWords = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

/** The request's moment: a server component renders once per request. */
const clock = () => Date.now();

export default async function AiWorkload({ searchParams }: { searchParams: Promise<{ day?: string }> }) {
  const q = await searchParams; const day = /^\d{4}-\d{2}-\d{2}$/.test(q.day ?? "") ? q.day! : "";
  const r = await api<Workload>(`agents/workload${day ? `?day=${day}` : ""}`);
  if (r.error) return <Message text={r.error} />;
  const w = r.data!; const zone = w.timeZone || "Asia/Kolkata"; const now = clock();
  const total = (f: (a: Agent) => number) => w.agents.reduce((s, a) => s + (f(a) || 0), 0);
  const waiting = total((a) => a.waitingCards.length), asking = total((a) => a.waitingQuestions.length), caught = total((a) => a.caught.length);
  return (
    <Page>
      <PageHeader title="AI workload" back={{ href: "/people", label: "Team" }}
        context={[dayWords(w.day), `${w.agents.length} AI employees`]}
        actions={<>
          <Link className={styles.btn} href={`/people/ai?day=${shiftDay(w.day, -1)}`}>Day before</Link>
          {day ? <Link className={styles.btn} href="/people/ai">Today</Link> : null}
          {/* AI-TASKS: what each AI employee did with the tasks people gave it, and the cost. */}
          <Link className={styles.btn} href="/people/ai/tasks">Tasks and cost</Link>
        </>} />
      <div className={css.tiles} aria-label="Today in numbers">
        <Tile icon={<Bot size={16} aria-hidden="true" />} label="Pieces of work" value={n(total((a) => a.did.runs))} note={`${k(total((a) => a.did.tokens))} tokens`} />
        <Tile icon={<Send size={16} aria-hidden="true" />} label="Cards made" value={n(total((a) => a.cards.made))} note={`${n(total((a) => a.cards.sent + a.cards.edited))} sent · ${n(total((a) => a.posted))} posted directly`} />
        <Tile icon={<Clock3 size={16} aria-hidden="true" />} label="Waiting for a person" value={n(waiting)} note={`${n(asking)} questions to colleagues`} tone={waiting ? "wait" : undefined} />
        <Tile icon={<AlertTriangle size={16} aria-hidden="true" />} label="Mistakes caught" value={n(caught)} note="edited, turned down or failed" tone={caught ? "bad" : undefined} />
      </div>
      {!w.agents.length ? <Empty icon={Bot} title="No AI employees here" text="Add one from Team → Add member." />
        : <div className={css.list}>{w.agents.map((a) => <AgentCard key={a.id} a={a} zone={zone} now={now} />)}</div>}
    </Page>
  );
}

function Tile({ icon, label, value, note, tone }: { icon: ReactNode; label: string; value: string; note: string; tone?: "wait" | "bad" }) {
  return <div className={css.tile} data-tone={tone}><span className={css.tileLabel}>{icon}{label}</span><b>{value}</b><small>{note}</small></div>;
}

function AgentCard({ a, zone, now }: { a: Agent; zone: string; now: number }) {
  const out = a.runtime.state === "out_of_quota" || a.runtime.state === "error";
  return <article className={css.agent} aria-label={a.name}>
    <header className={css.agentHead}>
      <Avatar name={a.name} size={40} ai />
      <div className={css.agentName}>
        <span><Link href={`/people/${encodeURIComponent(a.id)}?tab=ai`}>{a.name}</Link><AiBadge employeeId={a.employeeId} /></span>
        <small>{a.title}{a.approver ? ` · asks ${a.approver}` : ""}{a.manager && a.manager !== a.approver ? ` · reports to ${a.manager}` : ""}</small>
      </div>
      {a.status !== "on" ? <Badge tone="neutral">{a.status === "paused" ? "Paused" : "Off"}</Badge> : out ? <Badge tone="warning">{a.runtime.state === "error" ? "Failing" : "Out of quota"}</Badge> : a.runtime.provider === "stub" ? <Badge>Test runtime</Badge> : <Badge tone="success">On</Badge>}
    </header>
    <dl className={css.did} aria-label="What it did">
      <div><dt>Answered</dt><dd>{n(a.did.answered)}<small>{a.did.afterAnswers ? ` · ${n(a.did.afterAnswers)} after a colleague` : ""}</small></dd></div>
      <div><dt>Cards</dt><dd>{n(a.cards.made)}<small>{a.cards.made ? ` · ${n(a.cards.sent)} sent, ${n(a.cards.edited)} edited, ${n(a.cards.turnedDown)} turned down` : ""}</small></dd></div>
      <div><dt>Asked colleagues</dt><dd>{n(a.asked.asked)}<small>{a.asked.asked ? ` · ${n(a.asked.answered)} answered` : ""}</small></dd></div>
      <div><dt>Followed up</dt><dd>{n(a.did.quietClients + a.did.missedCalls + a.did.recordedCalls)}<small>{a.did.quietClients || a.did.missedCalls || a.did.recordedCalls ? ` · ${[a.did.quietClients ? `${a.did.quietClients} quiet client` : "", a.did.missedCalls ? `${a.did.missedCalls} missed call` : "", a.did.recordedCalls ? `${a.did.recordedCalls} recorded call` : ""].filter(Boolean).join(", ")}` : ""}</small></dd></div>
      <div><dt>Tasks</dt><dd>{n(a.did.tasks)}<small>{a.cards.tasks ? ` · ${n(a.cards.tasks)} proposed` : ""}</small></dd></div>
      <div><dt>Runs</dt><dd>{n(a.did.runs)}<small> · {k(a.did.tokens)} tokens{a.did.failed ? `, ${n(a.did.failed)} failed` : ""}</small></dd></div>
    </dl>

    {a.waitingCards.length ? <section className={css.part} aria-label="Cards waiting for a person">
      <h3><Clock3 size={14} aria-hidden="true" />Waiting for a person<small>{a.waitingCards.length}</small></h3>
      <ul>{a.waitingCards.map((c) => <li key={c.id} data-urgent={c.urgent ? "" : undefined}>
        <div className={css.rowHead}>{c.urgent ? <Badge tone="danger">Urgent</Badge> : null}<b>{c.kind === "task" ? "Task" : "Reply"} for {c.channel}</b>{c.client ? <Badge tone="accent">Client</Badge> : null}</div>
        <p className={css.quote}>{c.body}</p>
        <small>{c.approver} decides · {since(c.since, zone, now)}{c.reminded ? " · reminded" : ""}{c.escalatedTo ? ` · asked ${c.escalatedTo} too` : ""} · <Link href={`/chats?channel=${c.chatId}${c.messageId ? `&message=${c.messageId}` : ""}`}>Open the card</Link></small>
      </li>)}</ul>
    </section> : null}

    {a.waitingQuestions.length ? <section className={css.part} aria-label="Questions to colleagues waiting">
      <h3><MessageSquareText size={14} aria-hidden="true" />Questions waiting<small>{a.waitingQuestions.length}</small></h3>
      <ul>{a.waitingQuestions.map((c) => <li key={c.id}>
        <div className={css.rowHead}><b>{c.colleague}</b>{c.state === "answered" ? <Badge tone="success">Answered</Badge> : null}{c.client ? <Badge tone="accent">Client</Badge> : null}</div>
        <p className={css.quote}>{c.question}</p>
        <small>For {c.for ?? "someone"} in {c.channel} · {since(c.since, zone, now)}{c.reminded ? " · reminded" : ""}{c.escalated ? " · approver asked" : ""} · <Link href={`/chats?channel=${c.chatId}`}>Open</Link></small>
      </li>)}</ul>
    </section> : null}

    {a.caught.length ? <section className={css.part} aria-label="Mistakes caught">
      <h3><UserRoundCheck size={14} aria-hidden="true" />Mistakes caught<small>{a.caught.length}</small></h3>
      <ul>{a.caught.map((c, i) => <li key={`${c.at}:${i}`}>
        <div className={css.rowHead}><Badge tone={c.kind === "edited" ? "warning" : "danger"}>{CAUGHT[c.kind] ?? c.kind}</Badge>{c.by ? <span>by {c.by}</span> : null}<small>{when(c.at, zone)}{c.channel ? ` · ${c.channel}` : ""}</small></div>
        {c.wrote ? <p className={css.quote} data-struck={c.kind === "turned_down" ? "" : undefined}><span className={styles.srOnly}>It wrote: </span>{c.wrote}</p> : null}
        {c.sent ? <p className={css.quote} data-sent=""><span className={styles.srOnly}>Sent instead: </span>{c.sent}</p> : null}
      </li>)}</ul>
    </section> : null}

    {a.timeline.length ? <details className={css.part}>
      <summary><h3><CheckCircle2 size={14} aria-hidden="true" />What it worked on<small>{a.timeline.length}</small></h3></summary>
      <ol className={css.timeline}>{a.timeline.map((s, i) => <li key={`${s.at}:${i}`}>
        <time dateTime={s.at}>{when(s.at, zone)}</time>
        <span><b>{s.kind === "call.missed" ? <PhoneMissed size={13} aria-hidden="true" /> : null}{KIND[s.kind] ?? s.kind}</b>{s.from ? ` from ${s.from}` : ""}{s.where ? ` in ${s.where}` : ""}{s.about ? <>: <q>{s.about}</q></> : null}
          <small>{[...s.did.map((x) => x.startsWith("asked:") ? `asked ${x.slice(6)}` : DID[x] ?? x), s.state === "error" ? CAUGHT[s.error ?? "error"] ?? "failed" : "", s.tokens ? `${k(s.tokens)} tokens` : ""].filter(Boolean).join(" · ")}</small></span>
      </li>)}</ol>
    </details> : <p className={css.quiet}>Nothing to do on this day.</p>}
  </article>;
}
