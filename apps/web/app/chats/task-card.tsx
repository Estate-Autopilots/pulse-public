"use client";
// A task in a chat is a live card: its state, who has it and when it is due, read fresh (30 seconds at most old) for
// every card in the conversation in one request. Its owner can post the task's updates into this chat from the card.
// CHAT-WORK: the person a task was given to in this chat answers on its card (take it, decline it, ask a question);
// everyone else sees where that stands, and where an AI employee's work on it stands.
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BellOff, BellRing, Bot, CalendarDays, Check, CircleHelp, ListChecks, Lock, X } from "lucide-react";
import { Avatar } from "../ui";
import { get, send } from "./net";
import { cachedList } from "./store";
import type { TaskCardData, TaskHandshake } from "./types";
import { zoneDay } from "../lib/zone.mjs";
import { useOrgZone } from "../org-code";
import css from "./chats.module.css";
import own from "./work.module.css";

const cards = new Map<string, { at: number; data: TaskCardData | null }>();
const listeners = new Set<() => void>();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dueLabel = (d: string, zone: string) => { const x = new Date(`${d}T00:00:00Z`); const today = zoneDay(zone); const n = Math.round((x.getTime() - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  return n === 0 ? "Due today" : n === 1 ? "Due tomorrow" : n === -1 ? "Due yesterday" : n < 0 ? `${-n} days late` : `Due ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`; };
const first = (name: string | null | undefined) => (name ?? "Someone").replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];
/** Read one card again now (after an answer), for every conversation showing it. */
function refresh(id: string) {
  void get<{ tasks: TaskCardData[] }>(`chats/task-cards?ids=${id}`).then((d) => { cards.set(id, { at: Date.now(), data: d.tasks.find((t) => t.id === id) ?? null }); listeners.forEach((l) => l()); }).catch(() => cards.delete(id));
}

/** Live cards for the tasks named in a conversation. `bump` re-reads when the conversation changes. */
export function useTaskCards(ids: string[], bump = 0) {
  const [version, setTick] = useState(0);
  const key = ids.join(","), seenBump = useRef(bump);
  useEffect(() => { const l = () => setTick((n) => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  useEffect(() => {
    // A new message (often a task update line) re-reads every card; otherwise cards older than 30 seconds.
    const force = seenBump.current !== bump; seenBump.current = bump;
    const stale = key.split(",").filter((id) => id && (force || !cards.has(id) || Date.now() - cards.get(id)!.at > 30000));
    if (!stale.length) return;
    let live = true;
    void get<{ tasks: TaskCardData[] }>(`chats/task-cards?ids=${stale.join(",")}`).then((d) => {
      const at = Date.now(); for (const id of stale) cards.set(id, { at, data: d.tasks.find((t) => t.id === id) ?? null });
      if (live) setTick((n) => n + 1);
    }).catch(() => { /* the card shows its name until the next try */ });
    return () => { live = false; };
  }, [key, bump]);
  // CHAT-V3 (speed): the same object until a card changes, so bubbles that show no new card are not drawn again.
  return useMemo(() => ({ version, get: (id: string) => cards.get(id)?.data ?? (cards.has(id) ? null : undefined) }), [version]);
}

export function TaskCard({ task, fallback, channelId, compact }: { task: TaskCardData | null | undefined; fallback: string; channelId: string; compact?: boolean }) {
  const zone = useOrgZone();
  const [following, setFollowing] = useState<boolean | null>(null), [busy, setBusy] = useState(false);
  if (task === null) return <div className={css.task} data-hidden=""><Lock size={15} aria-hidden="true" /><span><b>{fallback}</b><small>A task you can’t open</small></span></div>;
  if (!task) return <div className={css.task} data-loading=""><ListChecks size={15} aria-hidden="true" /><span><b>{fallback}</b><small>Loading…</small></span></div>;
  const on = following ?? task.followedIn.includes(channelId);
  async function toggle() { setBusy(true); try { await send(`chats/tasks/${task!.id}/follow`, { channelId, on: !on }); setFollowing(!on); cards.delete(task!.id); } catch { /* unchanged */ } finally { setBusy(false); } }
  const handshake = task.handshakes?.find((h) => h.channelId === channelId) ?? null;
  return <div className={css.task} data-status={task.status} data-compact={compact || undefined} data-task-card={task.id}>
    <span className={css.taskTop}><em data-status={task.status}>{task.statusLabel}</em>{task.priority && ["high", "urgent"].includes(task.priority) ? <em data-priority={task.priority}>{task.priority === "urgent" ? "Urgent" : "High"}</em> : null}</span>
    <Link href={`/tasks/${task.id}`} className={css.taskTitle}>{task.title}</Link>
    {!compact ? <span className={css.taskMeta}>
      {task.assigneeId ? <span><Avatar ai={task.assigneeAgent} name={task.assigneeName ?? "?"} id={task.assigneeId} photoAt={task.assigneePhotoAt} size={20} />{task.assigneeName}</span> : <span>Unassigned</span>}
      {task.dueOn ? <span><CalendarDays size={13} aria-hidden="true" />{dueLabel(task.dueOn, zone)}</span> : null}
      {task.projectName ? <span className={css.taskProject}>{task.projectName}</span> : null}
    </span> : null}
    {!compact && handshake ? <Answer task={task} h={handshake} channelId={channelId} /> : null}
    {!compact && task.assigneeAgent && task.agentWork && !task.canApprove ? <AgentWork w={task.agentWork} done={["done", "accepted", "in_review"].includes(task.status)} /> : null}
    {!compact && task.canApprove ? <Review task={task} /> : null}
    {task.canFollow && !compact ? <button type="button" className={css.taskFollow} aria-pressed={on} disabled={busy} onClick={() => void toggle()}>{on ? <BellRing size={14} aria-hidden="true" /> : <BellOff size={14} aria-hidden="true" />}{on ? "Updates post here" : "Post updates here"}</button> : null}
  </div>;
}

/** Take it, decline (a reason, optional) or ask a question (posted in the chat, quoting this card). */
function Answer({ task, h, channelId }: { task: TaskCardData; h: TaskHandshake; channelId: string }) {
  const viewer = cachedList()?.viewer;
  const [mode, setMode] = useState<null | "decline" | "ask">(null), [note, setNote] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const mine = h.personId === viewer && (h.state === "waiting" || h.state === "question");
  async function answer(kind: "accept" | "decline" | "ask", text = "") {
    setBusy(true); setError("");
    try { await send(`chats/tasks/${task.id}/respond`, { channelId, answer: kind, note: text }); setMode(null); setNote(""); refresh(task.id); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function submit(e: FormEvent) { e.preventDefault(); if (mode === "ask" && !note.trim()) { setError("Write your question"); return; } void answer(mode!, note.trim()); }
  const status = h.state === "accepted" ? <><Check size={13} aria-hidden="true" />{h.personId === viewer ? "You" : first(h.personName)} took it{h.note ? <q>{h.note}</q> : null}</>
    : h.state === "declined" ? <><X size={13} aria-hidden="true" />{h.personId === viewer ? "You" : first(h.personName)} declined{h.note ? <q>{h.note}</q> : null}</>
    : h.state === "question" ? <><CircleHelp size={13} aria-hidden="true" />{h.personId === viewer ? "You asked" : `${first(h.personName)} asked`}: <q>{h.note}</q></>
    : <>{h.personId === viewer ? "Given to you. Will you take it?" : `Waiting for ${first(h.personName)} to take it`}</>;
  return <div className={own.answer} data-answer={h.state}>
    <p data-state={h.state}>{status}</p>
    {mine && !mode ? <div className={own.buttons}>
      <button type="button" data-primary="" disabled={busy} onClick={() => void answer("accept")}><Check size={14} aria-hidden="true" />Take it</button>
      <button type="button" disabled={busy} onClick={() => { setMode("decline"); setError(""); }}>Decline</button>
      <button type="button" disabled={busy} onClick={() => { setMode("ask"); setError(""); }}><CircleHelp size={14} aria-hidden="true" />Ask a question</button>
    </div> : null}
    {mine && mode ? <form className={own.note} onSubmit={submit}>
      <input autoFocus value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setMode(null); } }}
        placeholder={mode === "ask" ? "Your question, posted in this chat" : "A short reason (optional)"}
        aria-label={mode === "ask" ? "Your question" : "Why you decline (optional)"} />
      <span className={own.buttons}><button type="submit" data-primary="" disabled={busy}>{mode === "ask" ? "Ask" : "Decline"}</button>
        <button type="button" disabled={busy} onClick={() => setMode(null)} aria-label="Cancel"><X size={14} aria-hidden="true" /></button></span>
    </form> : null}
    {error ? <p className={own.answerError} role="alert">{error}</p> : null}
  </div>;
}

/** J7: the reviewer approves finished work from its card (or opens it to look first). */
function Review({ task }: { task: TaskCardData }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function act(path: string, body: Record<string, unknown>) { setBusy(true); setError(""); try { await send(`tasks/${task.id}/${path}`, body); refresh(task.id); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <div className={own.answer} data-review="">
    <p data-state="question"><CircleHelp size={13} aria-hidden="true" />Finished: yours to review</p>
    <div className={own.buttons}><button type="button" data-primary="" disabled={busy} onClick={() => void act("accept", { quality: "good" })}><Check size={14} aria-hidden="true" />Approve</button>
      <button type="button" disabled={busy} onClick={() => void act("accept", { quality: "great" })}>Great work</button>
      <button type="button" disabled={busy} onClick={() => void act("return", { note: "Sent back from the chat" })}>Send back</button>
      <Link href={`/tasks/${task.id}`} className={own.linkButton}>Open to review</Link></div>
    {error ? <p className={own.answerError} role="alert">{error}</p> : null}
  </div>;
}

/** Where an AI employee's work on the task stands, in plain words and only what Pulse recorded. */
const AGENT_WHY: Record<string, string> = {
  not_chats: "its runtime on this server answers in Chats only", budget_spent: "today’s token budget is spent", expired: "it waited more than a day",
  gave_up: "it could not start after five tries", stuck: "it got stuck", model_error: "something went wrong while working", no_answer: "it had nothing to report",
  out_of_quota: "its Claude or Codex plan is out of quota", agent_left: "it is no longer in that chat", paused: "it is paused until an admin switches it back on",
};
function AgentWork({ w, done }: { w: NonNullable<TaskCardData["agentWork"]>; done: boolean }) {
  const who = first(w.agent);
  const until = w.runtimeUntil ?? w.retryAt ?? null;
  const [now] = useState(() => Date.now());
  const quota = w.reason === "out_of_quota" || w.runtimeState === "out_of_quota" && (!until || Date.parse(until) > now);
  const text = ["queued", "leased"].includes(w.state) ? (w.reason === "paused" ? `${who} is paused until an admin switches it back on`
      : quota ? `Waiting for ${who}: its plan is out of quota${until ? ` until ${new Date(until).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : ""}; it starts then` : `Queued for ${who}`)
    : w.state === "dispatching" ? `${who} is working on it…` : w.state === "done" ? (done ? `${who} finished; it is yours to review` : `${who} reported back in the chat`)
    : `${who} couldn’t work on it${w.reason && AGENT_WHY[w.reason] ? `: ${AGENT_WHY[w.reason]}` : ""}`;
  return <div className={own.answer} data-agent-work={w.state}><p data-state={["queued", "leased", "dispatching"].includes(w.state) ? "queued" : w.state === "done" ? "accepted" : "declined"}><Bot size={13} aria-hidden="true" />{text}</p></div>;
}
