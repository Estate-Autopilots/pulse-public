"use client";
// CHAT-V3: the parts the upgraded conversation adds: approvals on a message, "Seen by", someone typing, the pinned bar,
// a small notice line, forwarding, message info, the gallery, and saved messages.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, Clock3, File as FileIcon, Link2, Mic, Pin, Send, Undo2, X, MessageSquareWarning } from "lucide-react";
import { Avatar } from "../ui";
import { clock, dayChip, linkDomain } from "../lib/chat-format.mjs";
import { get, send } from "./net";
import { syncThread, GroupAvatar } from "./parts";
import { cachedList } from "./store";
import type { Attachment, Channel, ChatData, ChatMessage, Member, Reader } from "./types";
import type { Typer } from "./live";
import css from "./chats.module.css";
import v3 from "./v3.module.css";
import { fileUrl } from "./files";

const first = (name: string) => name.replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, "").split(" ")[0];
const when = (iso: string | null) => iso ? `${dayChip(iso)}, ${clock(iso)}` : "";
/** Muted now: until a time still ahead, or always. */
export const mutedNow = (until?: string | null) => !!until && (until === "infinity" || Date.parse(until) > Date.now());

/** A notice that shows for a moment at the bottom of the conversation ("Link copied"). */
export function useNotice(): [ReactNode, (text: string) => void] {
  const [text, setText] = useState(""); const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((t: string) => { setText(t); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setText(""), 2200); }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return [text ? <p className={v3.toast} role="status">{text}</p> : null, show];
}

/** An approval asked on a message: who asked, where it stands; anyone else in the chat approves or asks for changes. */
export function ApprovalCard({ m, viewer, channelId, onError }: { m: ChatMessage; viewer: string; channelId: string; onError?: (e: string) => void }) {
  const a = m.approval; const [note, setNote] = useState<string | null>(null), [busy, setBusy] = useState(false);
  if (!a) return null;
  const mine = a.askedBy === viewer, by = a.decidedBy === viewer ? "you" : first(a.decidedByName ?? "");
  const act = async (action: string, body?: string) => {
    setBusy(true);
    try { await send(`chats/messages/${m.id}/approval`, { action, note: body }); setNote(null); await syncThread(channelId); } catch (e) { onError?.((e as Error).message); } finally { setBusy(false); }
  };
  return <div className={v3.approval} data-state={a.state} data-approval={a.state}>
    <header>{a.state === "approved" ? <CheckCircle2 size={15} aria-hidden="true" /> : a.state === "changes" ? <MessageSquareWarning size={15} aria-hidden="true" /> : <Clock3 size={15} aria-hidden="true" />}
      {a.state === "approved" ? `Approved by ${by}` : a.state === "changes" ? `Changes asked by ${by}` : "Waiting for approval"}</header>
    {a.state === "changes" && a.note ? <p>“{a.note}”</p> : null}
    <p>{a.state === "waiting" ? `${mine ? "You" : first(a.askedByName)} asked${mine ? " the others in this chat" : " you and the others here"}` : a.decidedAt ? when(a.decidedAt) : ""}{a.rounds ? ` · ${a.rounds} round${a.rounds === 1 ? "" : "s"} of changes` : ""}</p>
    {note !== null ? <><textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change?" aria-label="What should change" autoFocus maxLength={2000} />
      <footer><button type="button" className={v3.btnPrimary} disabled={busy || !note.trim()} onClick={() => void act("changes", note.trim())}>Send</button><button type="button" className={v3.btn} onClick={() => setNote(null)}>Cancel</button></footer></>
      : a.state === "waiting" && !mine ? <footer><button type="button" className={v3.btnPrimary} disabled={busy} onClick={() => void act("approved")}><CheckCircle2 size={14} aria-hidden="true" />Approve</button>
        <button type="button" className={v3.btn} disabled={busy} onClick={() => setNote("")}>Ask for changes</button></footer>
      : mine ? <footer>{a.state === "waiting" ? <button type="button" className={v3.btn} disabled={busy} onClick={() => void act("withdraw")}><Undo2 size={14} aria-hidden="true" />Withdraw</button>
        : <button type="button" className={v3.btn} disabled={busy} onClick={() => void act("ask")}>Ask again</button>}</footer> : null}
  </div>;
}

/** Under my latest message in a group: who has read it ("Seen by Asha, Neha" or "Seen by everyone"). */
export function SeenBy({ m, readers, members, onInfo }: { m: ChatMessage; readers: Reader[]; members: Member[]; onInfo: () => void }) {
  const at = Date.parse(m.createdAt);
  const seen = readers.filter((r) => r.at && Date.parse(r.at) >= at).map((r) => members.find((p) => p.id === r.id)).filter((p): p is Member => !!p);
  if (!seen.length) return null;
  const all = seen.length >= readers.length && readers.length > 1;
  const names = seen.slice(0, 3).map((p) => first(p.name)).join(", ") + (seen.length > 3 ? ` +${seen.length - 3}` : "");
  return <div className={v3.seen} data-seen-by="">
    <button type="button" onClick={onInfo} aria-label={`Seen by ${seen.map((p) => p.name).join(", ")}. Message info`}>
      <span aria-hidden="true">{seen.slice(0, 3).map((p) => <Avatar key={p.id} name={p.name} id={p.id} photoAt={p.photoAt} size={18} />)}</span> {all ? "Seen by everyone" : `Seen by ${names}`}
    </button></div>;
}

/** Someone typing, at the foot of the conversation. */
export function TypingBubble({ typers, members, direct }: { typers: Typer[]; members: Member[]; direct: boolean }) {
  if (!typers.length) return null;
  const p = members.find((x) => x.id === typers[0].person);
  return <div className={v3.typing} role="status" aria-live="polite" data-typing="">
    {!direct ? <Avatar name={typers[0].name} id={typers[0].person} photoAt={p?.photoAt} ai={p?.agent} size={24} /> : null}
    <span aria-hidden="true"><i /><i /><i /></span>
    <span>{typers.length === 1 ? `${first(typers[0].name)} is typing` : `${typers.map((t) => first(t.name)).slice(0, 2).join(" and ")}${typers.length > 2 ? ` and ${typers.length - 2} more` : ""} are typing`}</span>
  </div>;
}

/** Up to three pinned messages on top of the conversation; a tap shows it (and steps to the next pinned one). */
export function PinnedBar({ pinned, viewer, onJump, onUnpin }: { pinned: ChatMessage[]; viewer: string; onJump: (m: ChatMessage) => void; onUnpin: (m: ChatMessage) => void }) {
  const [i, setI] = useState(0);
  if (!pinned.length) return null;
  const m = pinned[i % pinned.length];
  const text = m.body || (m.attachments[0]?.name ? `📎 ${m.attachments[0].name}` : "Attachment");
  return <div className={v3.pinnedBar} data-pinned-bar="">
    <button type="button" onClick={() => { onJump(m); setI((x) => x + 1); }} aria-label={`Pinned message${pinned.length > 1 ? ` ${(i % pinned.length) + 1} of ${pinned.length}` : ""}: ${text}`}>
      <Pin size={16} aria-hidden="true" /><span><b>{pinned.length > 1 ? `Pinned ${(i % pinned.length) + 1} of ${pinned.length}` : "Pinned"} · {m.authorId === viewer ? "You" : first(m.name)}</b><small>{text}</small></span></button>
    <button type="button" className={css.iconBtn} onClick={() => onUnpin(m)} aria-label="Unpin this message" title="Unpin"><X size={16} aria-hidden="true" /></button>
  </div>;
}

/** Forward a message to up to 5 chats I am in (its files are copied into each). */
export function ForwardDialog({ m, data, onClose, onDone }: { m: ChatMessage; data: ChatData; onClose: () => void; onDone: (n: number) => void }) {
  const [q, setQ] = useState(""), [chosen, setChosen] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);
  const list = useMemo(() => (cachedList() ?? data).channels.filter((c) => !c.moderationOnly && !c.duplicateOf && !(c.kind === "direct" && c.peerFormer) && (!q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase())))
    .sort((a, b) => (b.lastAt ? Date.parse(b.lastAt) : 0) - (a.lastAt ? Date.parse(a.lastAt) : 0)).slice(0, 60), [data, q]);
  const go = async () => {
    setBusy(true); setError("");
    try { await send(`chats/messages/${m.id}/forward`, { channels: chosen }); onDone(chosen.length); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return <div className={css.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className={css.dialog} role="dialog" aria-modal="true" aria-label="Forward message">
    <header><h2>Forward to…</h2><button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close"><X size={16} aria-hidden="true" /></button></header>
    <p className={css.hint}>“{(m.body || m.attachments.map((a) => a.name).join(", ")).slice(0, 120)}”</p>
    <input className={v3.find} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a chat" aria-label="Find a chat" autoFocus />
    <div className={v3.pick} role="group" aria-label="Chats">{list.map((c: Channel) => <label key={c.id}>
      <input type="checkbox" checked={chosen.includes(c.id)} disabled={!chosen.includes(c.id) && chosen.length >= 5} onChange={(e) => setChosen((x) => e.target.checked ? [...x, c.id] : x.filter((y) => y !== c.id))} />
      <GroupAvatar channel={c} size={34} /><span><b>{c.name}</b><small>{c.kind === "direct" ? "Direct message" : `${c.members} members`}</small></span></label>)}</div>
    {error ? <p className={css.sideError} role="alert">{error}</p> : null}
    <footer><span className={css.hint}>{chosen.length ? `${chosen.length} of 5 chosen` : "Choose up to 5 chats"}</span><button type="button" className={css.primary} disabled={!chosen.length || busy} onClick={() => void go()}><Send size={15} aria-hidden="true" />Forward</button></footer>
  </div></div>;
}

/** Message info: when each member read it (direct chats and small groups keep read receipts). */
export function MessageInfo({ m, readers, members, onClose }: { m: ChatMessage; readers: Reader[]; members: Member[]; onClose: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);
  const at = Date.parse(m.createdAt);
  const rows = readers.map((r) => ({ p: members.find((x) => x.id === r.id), read: r.at && Date.parse(r.at) >= at ? r.at : null })).filter((r) => r.p);
  return <div className={css.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className={css.dialog} role="dialog" aria-modal="true" aria-label="Message info">
    <header><h2>Message info</h2><button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close"><X size={16} aria-hidden="true" /></button></header>
    <p className={css.hint}>Sent {when(m.createdAt)}</p>
    {rows.length ? <div className={v3.pick}>{rows.map(({ p, read }) => <div key={p!.id} className={v3.gRows}><div><Avatar name={p!.name} id={p!.id} photoAt={p!.photoAt} size={30} /><span><b>{p!.name}</b><small>{read ? `Read ${when(read)}` : "Not read yet"}</small></span></div></div>)}</div>
      : <p className={css.hint}>Read receipts show in direct chats and groups of up to 12 people.</p>}
  </div></div>;
}

type MediaItem = { messageId: string; authorId: string; name: string; createdAt: string; attachment: Attachment };
const KINDS: [string, string][] = [["image", "Photos"], ["file", "Files"], ["link", "Links"], ["voice", "Voice notes"]];
/** A conversation's photos, files, links and voice notes; `compact` shows the latest photos with a way to all of it. */
export function Gallery({ channel, onOpenImage, onJump, compact, onAll }: { channel: Channel; onOpenImage: (messageId: string, fileId: string) => void; onJump: (messageId: string) => void; compact?: boolean; onAll?: () => void }) {
  const [kind, setKind] = useState("image"), [data, setData] = useState<{ items: MediaItem[]; counts: Record<string, number> } | null>(null), [error, setError] = useState("");
  useEffect(() => { let live = true; get<{ items: MediaItem[]; counts: Record<string, number> }>(`chats/${channel.id}/media?kind=${kind}`).then((d) => { if (live) setData(d); }).catch((e) => { if (live) setError((e as Error).message); }); return () => { live = false; }; }, [channel.id, kind]);
  const items = data?.items ?? [];
  const total = data ? Object.values(data.counts ?? {}).reduce((a, b) => a + b, 0) : 0;
  if (compact) return <section className={v3.gallery} aria-label="Media, files and links">
    <h3 style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: 0, fontSize: 14 }}>Media, files and links{total ? <button type="button" className={css.linkBtn} onClick={onAll}>{total} ›</button> : null}</h3>
    {data && !items.length ? <p className={v3.gEmpty}>{total ? "No photos yet. Files and links are under the count." : "Nothing shared yet."}</p> : null}
    <div className={v3.gGrid}>{items.slice(0, 6).map((it) => <button key={`${it.messageId}:${it.attachment.id}`} type="button" onClick={() => onOpenImage(it.messageId, it.attachment.id!)} aria-label={`${it.attachment.name}, from ${it.name}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- member-only file served by the API */}
      <img src={fileUrl(it.attachment, true)} alt="" loading="lazy" /></button>)}</div>
  </section>;
  return <section className={v3.gallery} aria-label="Media, files and links" data-gallery="">
    <div className={v3.gTabs} role="tablist" aria-label="Show">{KINDS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => { setKind(k); setData(null); }}>{l}{data?.counts?.[k] ? ` ${data.counts[k]}` : ""}</button>)}</div>
    {error ? <p className={css.sideError} role="alert">{error}</p> : null}
    {!data ? <p className={v3.gEmpty}>Loading…</p> : !items.length ? <p className={v3.gEmpty}>No {KINDS.find(([k]) => k === kind)?.[1].toLowerCase()} in this chat yet.</p>
      : kind === "image" ? <div className={v3.gGrid}>{items.map((it) => <button key={`${it.messageId}:${it.attachment.id}`} type="button" onClick={() => onOpenImage(it.messageId, it.attachment.id!)} aria-label={`${it.attachment.name}, from ${it.name}, ${when(it.createdAt)}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- member-only file served by the API */}
        <img src={fileUrl(it.attachment, true)} alt="" loading="lazy" />{it.attachment.version ? <span className={v3.version}>v{it.attachment.version}</span> : null}</button>)}</div>
      : <div className={v3.gRows}>{items.map((it) => { const a = it.attachment; const icon = kind === "link" ? <Link2 size={18} aria-hidden="true" /> : kind === "voice" ? <Mic size={18} aria-hidden="true" /> : <FileIcon size={18} aria-hidden="true" />;
        const meta = `${first(it.name)} · ${when(it.createdAt)}${kind === "link" && a.url ? ` · ${linkDomain(a.url)}` : ""}${kind === "voice" && a.voice ? ` · ${Math.round(a.voice.seconds)} s` : ""}`;
        return kind === "voice" ? <div key={`${it.messageId}:${a.id}`} role="button" tabIndex={0} onClick={() => onJump(it.messageId)} onKeyDown={(e) => { if (e.key === "Enter") onJump(it.messageId); }} style={{ cursor: "pointer" }}>{icon}<span><b>Voice note</b><small>{meta}</small></span></div>
          : <a key={`${it.messageId}:${a.id ?? a.url}`} href={a.url ?? fileUrl(a)} target="_blank" rel="noreferrer">{icon}<span><b>{a.name}</b><small>{meta}</small></span></a>; })}</div>}
  </section>;
}

/** Messages I saved for later, from every chat; a tap opens the message in its chat. */
export function Saved({ data, onOpen }: { data: ChatData; onOpen: (m: ChatMessage) => void }) {
  const [list, setList] = useState<ChatMessage[] | null>(null), [error, setError] = useState("");
  useEffect(() => { let live = true; get<{ messages: ChatMessage[] }>("chats/starred").then((d) => { if (live) setList(d.messages); }).catch((e) => { if (live) setError((e as Error).message); }); return () => { live = false; }; }, []);
  return <section className={css.found} aria-label="Saved messages" data-saved="">
    <h2>{list ? (list.length ? `${list.length} saved message${list.length === 1 ? "" : "s"}` : "No saved messages") : "Saved messages"}</h2>
    {error ? <p className={css.sideError} role="alert">{error}</p> : null}
    {list && !list.length ? <p className={css.empty}>Save a message with ☆ in its menu to find it here later.</p> : null}
    {list?.map((m) => { const c = data.channels.find((x) => x.id === m.channelId); return <button key={m.id} type="button" className={css.row} onClick={() => onOpen(m)}>
      {c ? <GroupAvatar channel={c} size={40} /> : <Avatar name={m.name} size={40} />}
      <span className={css.rowMain}><span className={css.rowTop}><b>{c?.name ?? "Conversation"}</b><time>{dayChip(m.createdAt)}</time></span><span className={css.rowBottom}><span className={css.preview}>{m.authorId === data.viewer ? "You" : first(m.name)}: {m.body || m.attachments.map((a) => a.name).join(", ")}</span></span></span>
    </button>; })}
  </section>;
}
