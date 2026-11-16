import Link from "next/link";
import { CheckCircle2, Clock3, MessageSquareText, PhoneMissed, UserRoundCheck } from "lucide-react";
import { Avatar, Badge, styles } from "../../ui";
import type { Agent, Step, Workload } from "./workload-types";
import css from "./workload.module.css";

// AI-EMP-2 (owner, 25 Oct 2026): the day log for admins and leaders (and an AI employee's manager, for theirs): what
// each AI employee did on a day, its cards waiting for a person, its questions to colleagues waiting, and the mistakes
// people caught (a card edited before it went, or turned down; a run that failed). FIX-AI-EMPLOYEES (10 Nov 2026): this
// is now the second tab of Autopilots ("Today's log"); the cards are the main view.

/** Several of one kind, in a row: "3 direct messages". */
const KINDS: Record<string, string> = { "chat.message": "direct messages", "chat.mention": "mentions", "chat.reply": "replies to it", "chat.group": "group messages", "task.assigned": "tasks given to it",
  "task.mention": "mentions on tasks", "consult.answer": "answers from colleagues", "client.silent": "quiet clients", "call.missed": "missed calls", "call.recorded": "recorded calls" };
const KIND: Record<string, string> = { "chat.message": "Direct message", "chat.mention": "Mentioned", "chat.reply": "Reply to it", "chat.group": "Group message", "task.assigned": "Task given to it",
  "task.mention": "Mentioned on a task", "consult.answer": "A colleague answered it", "client.silent": "Quiet client", "call.missed": "Missed call", "call.recorded": "Recorded call" };
export const CAUGHT: Record<string, string> = { edited: "Edited before sending", turned_down: "Turned down", model_error: "Run failed", runaway: "Stopped as a runaway", no_answer: "Gave no answer", stuck: "Got stuck", needs_budget: "Needed more budget", out_of_quota: "Out of quota", error: "Run failed" };
const DID: Record<string, string> = { "card:reply:pending": "card waiting", "card:reply:sent": "card sent", "card:reply:dismissed": "card turned down", "card:reply:expired": "card expired",
  "card:task:pending": "task card waiting", "card:task:sent": "task created", "card:task:dismissed": "task turned down", "card:task:expired": "task card expired" };
const n = (x: number) => Number(x || 0).toLocaleString("en-IN");
const k = (x: number) => x >= 1000 ? `${(x / 1000).toFixed(x < 10000 ? 1 : 0).replace(/\.0$/, "")}k` : String(x);

function when(iso: string, zone: string) { return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: zone }); }
function ago(iso: string, now: number) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
}
const sinceAt = (iso: string, zone: string) => `Since ${new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: zone })}`;

/** Steps in a row that read the same (same kind, from, where, nothing quoted, nothing done) become one line with a count. */
function runs(steps: Step[]): { s: Step; n: number; last: string }[] {
  const out: { s: Step; n: number; last: string }[] = [];
  const plain = (x: Step) => !x.about && !x.did.length && x.state !== "error";
  for (const x of steps) {
    const prev = out.at(-1);
    if (prev && plain(x) && plain(prev.s) && prev.s.kind === x.kind && prev.s.from === x.from && prev.s.where === x.where) { prev.n += 1; prev.last = x.at; }
    else out.push({ s: x, n: 1, last: x.at });
  }
  return out;
}

/** Every AI employee's day in full, the busiest first; one that did nothing is one quiet line. */
export function DayLog({ w, now }: { w: Workload; now: number }) {
  const zone = w.timeZone || "Asia/Kolkata";
  const isQuiet = (a: Agent) => !a.timeline.length && !a.waitingCards.length && !a.waitingQuestions.length && !a.caught.length;
  const busy = w.agents.filter((a) => !isQuiet(a)).sort((a, b) => (b.timeline.length + b.waitingCards.length) - (a.timeline.length + a.waitingCards.length) || a.name.localeCompare(b.name));
  const quiet = w.agents.filter(isQuiet).map((a) => a.name).sort();
  return <div className={css.list}>
    {busy.map((a) => <LogCard key={a.id} a={a} zone={zone} now={now} />)}
    {quiet.length ? <p className={`${css.agent} ${css.quietLine}`} data-quiet="">{quiet.length === 1 ? `${quiet[0]} had nothing to do.` : `${quiet.length} had nothing to do: ${quiet.join(", ")}.`}</p> : null}
  </div>;
}

function LogCard({ a, zone, now }: { a: Agent; zone: string; now: number }) {
  const quiet = !a.timeline.length && !a.waitingCards.length && !a.waitingQuestions.length && !a.caught.length;
  return <article className={css.agent} aria-label={a.name} data-quiet={quiet ? "" : undefined}>
    <header className={css.agentHead}>
      <Avatar name={a.name} size={quiet ? 32 : 40} ai />
      <div className={css.agentName}>
        <span><Link href={`/people/${encodeURIComponent(a.id)}?tab=ai`}>{a.name}</Link></span>
        {quiet ? <small>Nothing to do on this day.</small> : <small>{n(a.did.runs)} {a.did.runs === 1 ? "piece" : "pieces"} of work · {a.cost?.today.inr !== null && a.cost?.today.inr !== undefined ? `cost ₹${Math.max(0, Math.round(a.cost.today.inr)).toLocaleString("en-IN")}` : `${k(a.did.tokens)} tokens`}{a.did.failed ? ` · ${n(a.did.failed)} failed` : ""}</small>}
      </div>
    </header>
    {quiet ? null : <>
      {a.waitingCards.length ? <section className={css.part} data-wait="" aria-label="Cards waiting for a person">
        <h3><Clock3 size={14} aria-hidden="true" />Waiting for a person<small>{a.waitingCards.length}</small></h3>
        <ul>{a.waitingCards.map((c, i) => <li key={c.id} data-urgent={c.urgent ? "" : undefined}>
          {i > 0 && a.waitingCards[i - 1].channel === c.channel && a.waitingCards[i - 1].kind === c.kind && !c.urgent ? null
            : <div className={css.rowHead}>{c.urgent ? <Badge tone="danger">Urgent</Badge> : null}<b>{c.kind === "task" ? "Tasks" : "Replies"} for {c.channel}</b>{c.client ? <Badge tone="accent">Client</Badge> : null}</div>}
          <p className={css.quote}>{c.body}</p>
          <small title={sinceAt(c.since, zone)}>Waiting {ago(c.since, now)} on {c.approver}{c.reminded ? " · reminded" : ""}{c.escalatedTo ? ` · asked ${c.escalatedTo} too` : ""}{c.canOpen === false ? ` · in ${c.approver}’s messages` : ""}</small>
          {c.canOpen === false ? null : <Link className={css.openCard} href={`/chats?channel=${c.chatId}${c.messageId ? `&message=${c.messageId}` : ""}`}>{c.kind === "task" ? "Review the task" : "Review the reply"}</Link>}
        </li>)}</ul>
      </section> : null}

      {a.waitingQuestions.length ? <section className={css.part} aria-label="Questions to colleagues waiting">
        <h3><MessageSquareText size={14} aria-hidden="true" />Questions waiting<small>{a.waitingQuestions.length}</small></h3>
        <ul>{a.waitingQuestions.map((c) => <li key={c.id}>
          <div className={css.rowHead}><b>{c.colleague}</b>{c.state === "answered" ? <Badge tone="success">Answered</Badge> : null}{c.client ? <Badge tone="accent">Client</Badge> : null}</div>
          <p className={css.quote}>{c.question}</p>
          <small title={sinceAt(c.since, zone)}>Waiting {ago(c.since, now)} · for {c.for ?? "someone"} in {c.channel}{c.reminded ? " · reminded" : ""}{c.escalated ? " · approver asked" : ""}</small>
          <Link className={css.openCard} href={`/chats?channel=${c.chatId}`}>Open the chat</Link>
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

      {a.timeline.length ? <details className={css.part} open={a.timeline.length <= 4}>
        <summary><h3><CheckCircle2 size={14} aria-hidden="true" />What it worked on</h3></summary>
        <ol className={css.timeline}>{runs(a.timeline).map(({ s, n: count, last }, i) => <li key={`${s.at}:${i}`}>
          <time dateTime={s.at}>{count > 1 ? `${when(last, zone)}–${when(s.at, zone)}` : when(s.at, zone)}</time>
          <span><b>{s.kind === "call.missed" ? <PhoneMissed size={13} aria-hidden="true" /> : null}{count > 1 ? `${count} ${KINDS[s.kind] ?? s.kind}` : KIND[s.kind] ?? s.kind}</b>{s.from ? ` from ${s.from}` : ""}{s.where ? ` in ${s.where}` : ""}{s.about ? <>: <q>{s.about}</q></> : null}
            <small>{[...s.did.map((x) => x.startsWith("asked:") ? `asked ${x.slice(6)}` : DID[x] ?? x), s.state === "error" ? CAUGHT[s.error ?? "error"] ?? "failed" : ""].filter(Boolean).join(" · ")}</small></span>
        </li>)}</ol>
      </details> : null}
    </>}
  </article>;
}
