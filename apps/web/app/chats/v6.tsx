"use client";
// CHAT-V6: my reminders and my scheduled messages in one place (from the list's ⋮ menu and the message box's clock).
import { useCallback, useEffect, useState } from "react";
import { AlarmClock, ArrowLeft, BellRing, Clock3, ExternalLink, Pencil, SendHorizontal, Trash2 } from "lucide-react";
import { whenWords } from "../lib/chat-v5.mjs";
import { useOrgZone } from "../org-code";
import { get, send } from "./net";
import { GroupAvatar, go } from "./parts";
import { cachedThread, updateThread } from "./store";
import { WhenDialog, refreshChatList } from "./v5";
import type { ChatData, ReminderItem, ScheduledItem } from "./types";
import css from "./chats.module.css";
import v3 from "./v3.module.css";
import v5 from "./v5.module.css";
import v6 from "./v6.module.css";

export { LATER_EVENT, openLater } from "./v5";

const first = (name: string) => name.replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];

/** The bubble's alarm mark follows a change made here, when that conversation is cached. */
function markReminder(r: ReminderItem, reminder: { id: string; at: string } | null) {
  if (cachedThread(r.channelId)) updateThread(r.channelId, (ms) => ms.map((m) => m.id === r.messageId ? { ...m, reminder } : m));
}

export function LaterList({ data, onBack }: { data: ChatData; onBack: () => void }) {
  const zone = useOrgZone();
  const [reminders, setReminders] = useState<ReminderItem[] | null>(null), [scheduled, setScheduled] = useState<ScheduledItem[] | null>(null);
  const [error, setError] = useState(""), [timing, setTiming] = useState<{ kind: "reminder"; item: ReminderItem } | { kind: "send"; item: ScheduledItem } | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const load = useCallback(async () => {
    const [r, s] = await Promise.all([get<{ reminders: ReminderItem[] }>("chats/reminders"), get<{ scheduled: ScheduledItem[] }>("chats/scheduled")]);
    setReminders(r.reminders); setScheduled(s.scheduled); setError("");
  }, []);
  useEffect(() => {
    let live = true;
    Promise.all([get<{ reminders: ReminderItem[] }>("chats/reminders"), get<{ scheduled: ScheduledItem[] }>("chats/scheduled")])
      .then(([r, s]) => { if (live) { setReminders(r.reminders); setScheduled(s.scheduled); } }).catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, []);
  const act = async (fn: () => Promise<unknown>) => { setError(""); try { await fn(); await load(); refreshChatList(); } catch (e) { setError((e as Error).message); } };
  const chat = (id: string) => data.channels.find((c) => c.id === id);
  const now = new Date();
  const upcoming = reminders?.filter((r) => !r.fired) ?? [], rang = reminders?.filter((r) => r.fired) ?? [];
  const where = (id: string) => { const c = chat(id); return c ? c.name : "A conversation"; };
  const reminderRow = (r: ReminderItem) => <li key={r.id} className={v6.item} data-later-reminder={r.id} data-rang={r.fired || undefined}>
    <span className={v6.head}>{chat(r.channelId) ? <GroupAvatar channel={chat(r.channelId)!} size={28} /> : null}<b>{where(r.channelId)}</b>
      <span className={v5.when}>{r.fired ? <><BellRing size={13} aria-hidden="true" />Rang {whenWords(r.at, now, zone)}</> : <><AlarmClock size={13} aria-hidden="true" />{whenWords(r.at, now, zone)}</>}</span></span>
    <p><b>{r.authorId === data.viewer ? "You" : first(r.name)}:</b> {r.body || "📎 Attachment"}</p>
    <span className={v5.actions}>
      <button type="button" onClick={() => go(`channel=${r.channelId}&message=${r.messageId}${r.parentId ? `&thread=${r.parentId}` : ""}`)}><ExternalLink size={13} aria-hidden="true" />Open</button>
      <button type="button" onClick={() => setTiming({ kind: "reminder", item: r })}><AlarmClock size={13} aria-hidden="true" />{r.fired ? "Remind me again" : "Change time"}</button>
      <button type="button" data-danger="" onClick={() => void act(async () => { await send(`chats/reminders/${r.id}/cancel`); markReminder(r, null); })}><Trash2 size={13} aria-hidden="true" />{r.fired ? "Dismiss" : "Cancel"}</button>
    </span>
  </li>;
  const scheduledRow = (s: ScheduledItem) => <li key={s.id} className={v6.item} data-later-scheduled={s.id} data-failed={s.failed || undefined}>
    <span className={v6.head}>{chat(s.channelId) ? <GroupAvatar channel={chat(s.channelId)!} size={28} /> : null}<b>{where(s.channelId)}</b>
      <span className={v5.when}><Clock3 size={13} aria-hidden="true" />{s.failed ? `Not sent: ${s.error ?? "Pulse could not send it"}` : `Sends ${whenWords(s.at, now, zone)}`}</span></span>
    {editing?.id === s.id ? <span className={v5.editRow}><textarea value={editing.text} onChange={(e) => setEditing({ id: s.id, text: e.target.value })} rows={2} maxLength={12000} aria-label="Edit the scheduled message" autoFocus />
      <button type="button" className={css.primary} disabled={!editing.text.trim() && !s.attachments.length} onClick={() => void act(() => send(`chats/scheduled/${s.id}`, { body: editing.text })).then(() => setEditing(null))}>Save</button>
      <button type="button" className={css.secondary} onClick={() => setEditing(null)}>Cancel</button></span>
      : <p>{s.body || s.attachments.map((a) => `📎 ${a.name}`).join(", ")}</p>}
    {editing?.id === s.id ? null : <span className={v5.actions}>
      <button type="button" onClick={() => go(`channel=${s.channelId}`)}><ExternalLink size={13} aria-hidden="true" />Open</button>
      <button type="button" onClick={() => setEditing({ id: s.id, text: s.body })}><Pencil size={13} aria-hidden="true" />Edit</button>
      <button type="button" onClick={() => setTiming({ kind: "send", item: s })}><AlarmClock size={13} aria-hidden="true" />Change time</button>
      <button type="button" onClick={() => void act(() => send(`chats/scheduled/${s.id}/cancel`, { now: true }))}><SendHorizontal size={13} aria-hidden="true" />Send now</button>
      <button type="button" data-danger="" onClick={() => void act(() => send(`chats/scheduled/${s.id}/cancel`, {}))}><Trash2 size={13} aria-hidden="true" />Cancel</button></span>}
  </li>;
  return <section className={v6.later} aria-label="Reminders and scheduled messages" data-later-list="">
    <button type="button" className={v3.archivedRow} onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />Back to chats</button>
    {error ? <p className={css.sideError} role="alert">{error}<button type="button" onClick={() => void load().catch((e) => setError((e as Error).message))}>Retry</button></p> : null}
    {!reminders || !scheduled ? (error ? null : <p className={css.empty} role="status">Opening your reminders…</p>) : <>
      {rang.length ? <><h3 className={v6.title}>Reminders that rang <small>{rang.length}</small></h3><ul className={v6.items}>{rang.map(reminderRow)}</ul></> : null}
      <h3 className={v6.title}>Reminders <small>{upcoming.length}</small></h3>
      {upcoming.length ? <ul className={v6.items}>{upcoming.map(reminderRow)}</ul> : <p className={v6.none}>No reminders waiting. On any message: its menu (or press and hold) → Remind me.</p>}
      <h3 className={v6.title}>Scheduled messages <small>{scheduled.length}</small></h3>
      {scheduled.length ? <ul className={v6.items}>{scheduled.map(scheduledRow)}</ul> : <p className={v6.none}>Nothing scheduled. Write a message, then the clock beside Send: Send later.</p>}
    </>}
    {timing?.kind === "reminder" ? <WhenDialog title="Remind me about this message" kind="reminder" current={timing.item.fired ? null : timing.item.at} onClose={() => setTiming(null)}
      onPick={(at) => act(async () => { const r = await send<{ id: string }>(`chats/messages/${timing.item.messageId}/remind`, { at }); markReminder(timing.item, { id: r.id, at }); })} /> : null}
    {timing?.kind === "send" ? <WhenDialog title="Send it at another time" kind="send" current={timing.item.failed ? null : timing.item.at} onClose={() => setTiming(null)}
      onPick={(at) => act(() => send(`chats/scheduled/${timing.item.id}`, { at }))} /> : null}
  </section>;
}
