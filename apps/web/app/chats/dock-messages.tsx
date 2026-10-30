"use client";
// CALLS-V2 (CHAT-V6 leftover): the dock's messages as they are in Chats, not text only: pictures (a tap opens the
// message in Chats), voice notes that play here (played state as in Chats), other files to open or download, polls with
// their live bars (vote and change a vote here; the asker closes it), and reactions (tap one to add or take back mine).
// Used by the dock's conversation and by a thread opened in the dock.
import { FileText } from "lucide-react";
import { PollCard } from "./v5";
import { VoiceNote, isVoice, useVoiceState } from "./voice";
import type { ChatMessage } from "./types";
import css from "./dock.module.css";

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const first = (n: string | null | undefined) => (n ?? "").split(" ")[0];
const isImage = (a: ChatMessage["attachments"][number]) => !!a.id && /^image\/(png|jpe?g|gif|webp)$/.test(a.mime ?? "");
async function post(path: string, body: unknown = {}) {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "That did not go through");
}

/** The messages, with `update` changing one of them in the dock's own list (optimistic; `reload` reads it again). */
export function DockMessages({ channelId, messages, viewer, names, update, reload, root }: {
  channelId: string; messages: ChatMessage[]; viewer: string; names: boolean;
  update: (id: string, change: (m: ChatMessage) => ChatMessage) => void; reload: () => void; root?: boolean;
}) {
  const voice = useVoiceState(channelId, messages);
  function react(m: ChatMessage, emoji: string) {
    update(m.id, (x) => {
      const r = x.reactions.find((y) => y.emoji === emoji);
      const reactions = r ? (r.mine ? x.reactions.map((y) => y.emoji === emoji ? { ...y, count: y.count - 1, mine: false } : y).filter((y) => y.count > 0) : x.reactions.map((y) => y.emoji === emoji ? { ...y, count: y.count + 1, mine: true } : y)) : [...x.reactions, { emoji, count: 1, mine: true }];
      return { ...x, reactions };
    });
    void post(`chats/messages/${m.id}/react`, { emoji }).catch(reload);
  }
  function vote(m: ChatMessage, choices: number[]) {
    update(m.id, (x) => x.poll ? { ...x, poll: { ...x.poll, votes: [...x.poll.votes.filter(([, who]) => who !== viewer), ...choices.map((c) => [c, viewer] as [number, string])] } } : x);
    void post(`chats/messages/${m.id}/vote`, { choices }).catch(reload);
  }
  return <>{messages.filter((m) => m.kind !== "event").map((m) => {
    const mine = m.authorId === viewer;
    const images = m.removed ? [] : m.attachments.filter(isImage), notes = m.removed ? [] : m.attachments.filter(isVoice);
    const files = m.removed ? [] : m.attachments.filter((a) => a.id && !isImage(a) && !isVoice(a));
    const open = `/chats?channel=${encodeURIComponent(channelId)}&message=${encodeURIComponent(m.id)}`;
    return <div key={m.id} className={css.msg} data-mine={mine || undefined} data-root={root || undefined} data-dock-message={m.id}>
      {!mine && names ? <small>{first(m.name)}</small> : null}
      {m.poll && !m.removed ? <div className={css.pollWrap}><PollCard m={m} viewer={viewer} canVote onVote={(c) => vote(m, c)} onClose={() => void post(`chats/messages/${m.id}/poll-close`).then(reload, reload)} /><time>{clock(m.createdAt)}</time></div>
        : <p>
          {images.length ? <span className={css.imgs} data-n={Math.min(images.length, 4)}>{images.slice(0, 4).map((a) => <a key={a.id} href={open} aria-label={`Open ${a.name} in Chats`}>
            {/* eslint-disable-next-line @next/next/no-img-element -- member-only file served by the API */}
            <img src={`/api/v0/chats/files/${a.id}?inline=1`} alt={a.name} loading="lazy" /></a>)}</span> : null}
          {notes.map((a) => <span key={a.id} className={css.voice}><VoiceNote messageId={m.id} a={a} mine={mine} state={voice.notes[m.id]} transcripts={voice.transcripts} onPlayed={() => voice.played(m.id)} onTranscribe={() => voice.transcribe(m.id)} /></span>)}
          {files.map((a) => <a key={a.id} className={css.file} href={`/api/v0/chats/files/${a.id}`} target="_blank" rel="noreferrer"><FileText size={15} aria-hidden="true" /><span>{a.name}</span></a>)}
          {m.removed ? <em>This message was deleted</em> : m.body || (m.attachments.length ? null : <em>Attachment</em>)}
          <time>{clock(m.createdAt)}</time></p>}
      {m.reactions.length && !m.removed ? <span className={css.reacts}>{m.reactions.map((r) => <button key={r.emoji} type="button" data-mine={r.mine || undefined} aria-pressed={r.mine} onClick={() => react(m, r.emoji)}
        aria-label={`${r.emoji} ${r.count}${r.mine ? ", yours: take it back" : ": add yours"}`}>{r.emoji}{r.count > 1 ? <b>{r.count}</b> : null}</button>)}</span> : null}
    </div>;
  })}</>;
}
