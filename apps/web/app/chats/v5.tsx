"use client";
// CHAT-V5: the parts this upgrade adds: the Threads inbox, reminders and messages sent later.
import { useEffect, useState, useSyncExternalStore } from "react";
import { AlarmClock, BarChart3, Check, ChevronDown, Clock3, MessageSquareText, Pencil, SendHorizontal, Trash2, X } from "lucide-react";
import { listTime } from "../lib/chat-format.mjs";
import { fromLocalInput, laterChoices, localInput, whenWords } from "../lib/chat-v5.mjs";
import { useOrgZone } from "../org-code";
import { get, send } from "./net";
import { GroupAvatar } from "./parts";
import { registerChatCommand } from "./commands";
import { cachedList } from "./store";
import type { ChatData, ChatMessage, ScheduledItem, ThreadItem } from "./types";
import css from "./chats.module.css";
import v5 from "./v5.module.css";

const first = (name: string) => name.replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];
/** Ask the chat list to read itself again (a thread opened, a reminder set...). */
export const LIST_REFRESH = "pulse:chats-refresh";
export const refreshChatList = () => { if (typeof window !== "undefined") window.dispatchEvent(new Event(LIST_REFRESH)); };

/** A thread opened: read up to now (for the Threads inbox); quiet if it fails. */
export function threadSeen(rootId: string) {
  if (rootId.startsWith("local-")) return;
  void send(`chats/threads/${rootId}/seen`).then(refreshChatList).catch(() => {});
}

/** CHAT-V5: every thread I am in, the ones with replies I have not read first. `stamp` changes when the list changes. */
export function ThreadsInbox({ data, stamp, onOpen }: { data: ChatData; stamp: unknown; onOpen: (t: ThreadItem) => void }) {
  const [list, setList] = useState<ThreadItem[] | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    get<{ threads: ThreadItem[] }>("chats/threads").then((d) => { if (live) { setList(d.threads); setError(""); } }).catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [stamp]);
  if (!list) return <p className={css.empty} role="status">{error || "Opening your threads…"}</p>;
  if (!list.length) return <p className={css.empty}>No threads yet. Start one from a message’s menu: Start a thread. Threads you start, reply in or are mentioned in show here.</p>;
  return <section className={v5.threads} aria-label="Threads" data-threads-inbox="">
    {list.map((t) => {
      const c = data.channels.find((x) => x.id === t.channelId);
      const who = (id: string | null, name: string | null) => id === data.viewer ? "You" : first(name ?? "");
      return <button key={t.rootId} type="button" className={`${css.row} ${v5.thread}`} data-unread={t.unread ? "" : undefined} data-thread-row={t.rootId} onClick={() => onOpen(t)}>
        {c ? <GroupAvatar channel={c} size={40} /> : <span className={v5.threadIcon} aria-hidden="true"><MessageSquareText size={18} /></span>}
        <span className={css.rowMain}>
          <span className={css.rowTop}><b>{c?.name ?? "Conversation"}</b><time dateTime={t.lastAt}>{listTime(t.lastAt)}</time></span>
          <span className={v5.threadRoot}><b>{who(t.rootAuthorId, t.rootName)}:</b> {t.rootRemoved ? "This message was deleted" : t.rootBody || (t.rootFiles ? "📎 Attachment" : "")}</span>
          <span className={css.rowBottom}><span className={css.preview}><span className={v5.replies}>{t.replies} repl{t.replies === 1 ? "y" : "ies"}</span>{t.lastBody ? <> · {who(t.lastAuthorId, t.lastName)}: {t.lastBody}</> : null}</span>
            {t.unread ? <b className={css.badge} aria-label={`${t.unread} unread repl${t.unread === 1 ? "y" : "ies"}`}>{t.unread > 99 ? "99+" : t.unread}</b> : null}</span>
        </span>
      </button>;
    })}
  </section>;
}

/** CHAT-V5 (emoji): the emoji I use, most used and most recent first (this browser's, per person), for the picker's
 *  Recent row and the quick reactions. */
const EMOJI_KEY = "pulse.chats.emoji.v1";
type EmojiUse = Record<string, { n: number; at: number }>;
let emojiUse: EmojiUse | null = null;
const emojiListeners = new Set<() => void>();
function readEmoji(): EmojiUse {
  if (emojiUse) return emojiUse;
  try { const v = JSON.parse(localStorage.getItem(EMOJI_KEY) ?? "{}") as { viewer?: string; use?: EmojiUse }; emojiUse = v.viewer === document.body?.dataset.viewer ? v.use ?? {} : {}; } catch { emojiUse = {}; }
  return emojiUse;
}
/** Ranked: uses, weighted down by age (a week halves them). */
export function recentEmoji(limit = 16): string[] {
  if (typeof window === "undefined") return [];
  const now = Date.now(), use = readEmoji();
  return Object.entries(use).map(([e, u]) => [e, u.n * Math.pow(0.5, (now - u.at) / (7 * 86400000))] as [string, number]).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([e]) => e);
}
export function noteEmoji(e: string) {
  if (typeof window === "undefined") return;
  const use = { ...readEmoji() }; use[e] = { n: (use[e]?.n ?? 0) + 1, at: Date.now() };
  const keep = Object.entries(use).sort((a, b) => b[1].at - a[1].at).slice(0, 60); emojiUse = Object.fromEntries(keep);
  try { localStorage.setItem(EMOJI_KEY, JSON.stringify({ viewer: document.body?.dataset.viewer, use: emojiUse })); } catch { /* memory still works */ }
  emojiListeners.forEach((l) => l());
}
let emojiVersion = 0; emojiListeners.add(() => { emojiVersion++; });
/** Re-render when the ranking changes. */
const onEmoji = (l: () => void) => { emojiListeners.add(l); return () => { emojiListeners.delete(l); }; };
export function useEmojiVersion() { return useSyncExternalStore(onEmoji, () => emojiVersion, () => 0); }
/** The six quick reactions: the ones I use most, filled up with the usual six. */
export function quickReactions(defaults: string[]): string[] { const mine = recentEmoji(6); return [...mine, ...defaults.filter((e) => !mine.includes(e))].slice(0, 6); }

/** CHAT-V5 (polls): "/poll Which cover?" opens the poll dialog with the question written. */
export const POLL_EVENT = "pulse:chat-poll";
registerChatCommand({ name: "poll", hint: "Ask the group a question", detail: "/poll Which cover do we send?", icon: BarChart3, takesText: true,
  when: (c) => c.kind !== "direct", run: (x) => window.dispatchEvent(new CustomEvent(POLL_EVENT, { detail: { channelId: x.channel.id, question: x.args } })) });

/** A poll's choices with live results: tap to vote (again to take it back); several choices when it allows them. */
export function PollCard({ m, viewer, canVote, onVote, onClose }: { m: ChatMessage; viewer: string; canVote: boolean; onVote: (choices: number[]) => void; onClose: () => void }) {
  const p = m.poll!; const people = cachedList()?.people ?? [];
  const counts = p.options.map((_, i) => p.votes.filter(([c]) => c === i).length);
  const voters = new Set(p.votes.map(([, who]) => who)).size;
  const mine = p.votes.filter(([, who]) => who === viewer).map(([c]) => c);
  const most = Math.max(0, ...counts);
  const nameOf = (id: string) => id === viewer ? "You" : first(people.find((x) => x.id === id)?.name ?? "Someone");
  const pick = (i: number) => { if (!canVote || p.closed) return; onVote(p.multi ? (mine.includes(i) ? mine.filter((c) => c !== i) : [...mine, i]) : mine.includes(i) ? [] : [i]); };
  return <div className={v5.poll} data-poll={m.id} data-closed={p.closed || undefined}>
    <b className={v5.pollQ}><BarChart3 size={15} aria-hidden="true" />{m.body}</b>
    <small className={v5.pollHint}>{p.closed ? "Closed" : p.multi ? "Choose one or more" : "Choose one"} · {voters} {voters === 1 ? "person" : "people"} voted</small>
    <div role="group" aria-label="Choices">{p.options.map((o, i) => {
      const n = counts[i], pct = voters ? Math.round((n / voters) * 100) : 0, chosen = mine.includes(i);
      const who = p.votes.filter(([c]) => c === i).map(([, id]) => nameOf(id));
      return <button key={i} type="button" className={v5.pollOpt} role={p.multi ? "checkbox" : "radio"} aria-checked={chosen} disabled={!canVote || p.closed} onClick={() => pick(i)}
        title={who.length ? who.join(", ") : "No votes yet"} data-lead={p.closed && n === most && n > 0 ? "" : undefined} data-choice={i}>
        <span className={v5.pollBar} style={{ width: `${pct}%` }} aria-hidden="true" />
        <span className={v5.pollMark} aria-hidden="true">{chosen ? <Check size={13} /> : null}</span>
        <span className={v5.pollLabel}>{o}</span><span className={v5.pollCount}>{n}{voters ? <small> · {pct}%</small> : null}</span>
      </button>; })}</div>
    {p.votes.length ? <small className={v5.pollWho}>{p.options.map((o, i) => counts[i] ? `${o}: ${p.votes.filter(([c]) => c === i).map(([, id]) => nameOf(id)).join(", ")}` : null).filter(Boolean).join(" · ")}</small> : null}
    {!p.closed && canVote && (p.createdBy === viewer) ? <button type="button" className={v5.pollClose} onClick={onClose}>Close the poll</button> : null}
  </div>;
}

/** A new poll: the question, 2-10 choices, one or several choices allowed. */
export function PollDialog({ question = "", onCreate, onClose }: { question?: string; onCreate: (q: string, options: string[], multi: boolean) => Promise<unknown>; onClose: () => void }) {
  const [q, setQ] = useState(question), [options, setOptions] = useState(["", ""]), [multi, setMulti] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const dup = new Set(filled.map((o) => o.toLowerCase())).size !== filled.length;
  const ok = q.trim().length > 0 && filled.length >= 2 && !dup;
  const set = (i: number, v: string) => setOptions((list) => { const next = list.map((o, j) => j === i ? v : o); if (i === next.length - 1 && v.trim() && next.length < 10) next.push(""); return next; });
  async function create() { if (!ok) return; setBusy(true); setError(""); try { await onCreate(q.trim(), filled, multi); onClose(); } catch (e) { setError((e as Error).message); setBusy(false); } }
  return <div className={css.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className={css.dialog} role="dialog" aria-modal="true" aria-label="Create a poll" data-poll-dialog="">
    <header><h2>Create a poll</h2><button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close"><X size={16} aria-hidden="true" /></button></header>
    <label className={v5.field}>Question<input value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} placeholder="Which cover do we send?" autoFocus /></label>
    <div className={v5.field} role="group" aria-label="Choices">Choices
      {options.map((o, i) => <span key={i} className={v5.optRow}><input value={o} onChange={(e) => set(i, e.target.value)} maxLength={120} placeholder={`Choice ${i + 1}`} aria-label={`Choice ${i + 1}`}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (ok && !o.trim()) void create(); else (e.currentTarget.parentElement?.nextElementSibling?.querySelector("input") as HTMLInputElement | null)?.focus(); } }} />
        {options.length > 2 ? <button type="button" className={css.iconBtn} onClick={() => setOptions((list) => list.filter((_, j) => j !== i))} aria-label={`Remove choice ${i + 1}`}><X size={14} aria-hidden="true" /></button> : null}</span>)}
    </div>
    <label className={v5.check}><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} />People can choose more than one</label>
    {dup ? <p className={css.composeError} role="alert">Each choice once, please.</p> : null}
    {error ? <p className={css.composeError} role="alert">{error}</p> : null}
    <footer><button type="button" className={css.secondary} onClick={onClose}>Cancel</button><button type="button" className={css.primary} disabled={!ok || busy} onClick={() => void create()}>Send the poll</button></footer>
  </div></div>;
}

/** CHAT-V5 (later): a time for a reminder or for sending later: quick choices, or a date and time picked. */
export function WhenDialog({ title, kind, current, note, onPick, onClear, clearLabel, onClose }: { title: string; kind: "reminder" | "send"; current?: string | null; note?: string;
  onPick: (iso: string) => Promise<unknown> | void; onClear?: () => Promise<unknown> | void; clearLabel?: string; onClose: () => void }) {
  const zone = useOrgZone();
  const [choices] = useState(() => laterChoices(kind, new Date(), zone));
  const [custom, setCustom] = useState(() => localInput(current ?? choices.find(([l]) => l.startsWith("Tomorrow"))?.[1] ?? new Date(Date.now() + 3600000).toISOString(), zone));
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [opened] = useState(() => Date.now());
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);
  const run = async (fn: () => Promise<unknown> | void) => { setBusy(true); setError(""); try { await fn(); onClose(); } catch (e) { setError((e as Error).message); setBusy(false); } };
  const picked = fromLocalInput(custom, zone);
  return <div className={css.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className={css.dialog} role="dialog" aria-modal="true" aria-label={title} data-when-dialog={kind}>
    <header><h2>{title}</h2><button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close"><X size={16} aria-hidden="true" /></button></header>
    {note ? <p className={css.hint}>{note}</p> : null}
    {current ? <p className={v5.current}><AlarmClock size={15} aria-hidden="true" />{kind === "reminder" ? "Reminds you" : "Sends"} {whenWords(current, new Date(), zone)}</p> : null}
    <div className={v5.choices} role="group" aria-label="When">
      {choices.map(([label, iso]) => <button key={iso} type="button" disabled={busy} onClick={() => void run(() => onPick(iso))}><span>{label.split(", ")[0]}</span><small>{label.includes(", ") ? label.split(", ")[1] : whenWords(iso, new Date(), zone)}</small></button>)}
    </div>
    <label className={v5.pick}>Pick a date and time
      <span><input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Date and time" />
        <button type="button" className={css.primary} disabled={busy || !picked || Date.parse(picked) < opened + 30000} onClick={() => { if (picked) void run(() => onPick(picked)); }}>{kind === "reminder" ? "Remind me" : "Schedule"}</button></span></label>
    {error ? <p className={css.composeError} role="alert">{error}</p> : null}
    {current && onClear ? <footer><button type="button" className={css.secondary} disabled={busy} onClick={() => void run(onClear)}>{clearLabel ?? "Cancel the reminder"}</button></footer> : null}
  </div></div>;
}

/** CHAT-V5 (later): my messages waiting to be sent in this conversation: edit the words or the time, send now, cancel. */
export function ScheduledBar({ channelId, count, stamp, onChanged }: { channelId: string; count: number; stamp: unknown; onChanged: () => void }) {
  const [items, setItems] = useState<ScheduledItem[]>([]), [open, setOpen] = useState(false), [error, setError] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null), [timing, setTiming] = useState<ScheduledItem | null>(null);
  const zone = useOrgZone();
  const known = items.length > 0;
  useEffect(() => {
    if (!count && !known) return; let live = true;
    get<{ scheduled: ScheduledItem[] }>(`chats/${channelId}/scheduled`).then((d) => { if (live) setItems(d.scheduled); }).catch(() => {});
    return () => { live = false; };
  }, [channelId, count, known, stamp]);
  if (!items.length) return null;
  const act = async (fn: () => Promise<unknown>) => { setError(""); try { await fn(); const d = await get<{ scheduled: ScheduledItem[] }>(`chats/${channelId}/scheduled`); setItems(d.scheduled); onChanged(); } catch (e) { setError((e as Error).message); } };
  const failed = items.filter((s) => s.failed).length;
  return <div className={v5.scheduled} data-scheduled-bar="">
    <button type="button" className={v5.scheduledHead} onClick={() => setOpen(!open)} aria-expanded={open}>
      <Clock3 size={15} aria-hidden="true" /><b>{items.length} scheduled message{items.length === 1 ? "" : "s"}</b>
      {failed ? <em>{failed} not sent</em> : <small>next {whenWords(items[0].at, new Date(), zone)}</small>}<ChevronDown size={15} aria-hidden="true" data-open={open || undefined} />
    </button>
    {open ? <ul>{items.map((s) => <li key={s.id} data-failed={s.failed || undefined} data-scheduled-item={s.id}>
      <span className={v5.when}><Clock3 size={13} aria-hidden="true" />{s.failed ? `Not sent: ${s.error ?? "Pulse could not send it"}` : `Sends ${whenWords(s.at, new Date(), zone)}`}</span>
      {editing?.id === s.id ? <span className={v5.editRow}><textarea value={editing.text} onChange={(e) => setEditing({ id: s.id, text: e.target.value })} rows={2} maxLength={12000} aria-label="Edit the scheduled message" autoFocus />
        <button type="button" className={css.primary} disabled={!editing.text.trim() && !s.attachments.length} onClick={() => void act(() => send(`chats/scheduled/${s.id}`, { body: editing.text })).then(() => setEditing(null))}>Save</button>
        <button type="button" className={css.secondary} onClick={() => setEditing(null)}>Cancel</button></span>
        : <p>{s.body || s.attachments.map((a) => `📎 ${a.name}`).join(", ")}</p>}
      {editing?.id === s.id ? null : <span className={v5.actions}>
        <button type="button" onClick={() => setEditing({ id: s.id, text: s.body })}><Pencil size={13} aria-hidden="true" />Edit</button>
        <button type="button" onClick={() => setTiming(s)}><AlarmClock size={13} aria-hidden="true" />Change time</button>
        <button type="button" onClick={() => void act(() => send(`chats/scheduled/${s.id}/cancel`, { now: true }))}><SendHorizontal size={13} aria-hidden="true" />Send now</button>
        <button type="button" data-danger="" onClick={() => void act(() => send(`chats/scheduled/${s.id}/cancel`, {}))}><Trash2 size={13} aria-hidden="true" />Cancel</button></span>}
    </li>)}</ul> : null}
    {error ? <p className={css.composeError} role="alert">{error}</p> : null}
    {timing ? <WhenDialog title="Send it at another time" kind="send" current={timing.failed ? null : timing.at} onClose={() => setTiming(null)} onPick={(iso) => act(() => send(`chats/scheduled/${timing.id}`, { at: iso }))} /> : null}
  </div>;
}
