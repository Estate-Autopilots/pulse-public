"use client";
// CHAT-V3: threads and comments on pictures. A thread opens beside the conversation (full screen on a phone): its first
// message, the replies, and a box to answer in the thread. The picture viewer (revision rounds) shows a picture large,
// its comments pinned to points (click the picture to comment on a point), its versions (v1, v2…), and its approval.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ArrowLeft, ArrowRight, Check, Download, ExternalLink, MapPin, MessageSquareText, PanelRight, SendHorizontal, Upload, X } from "lucide-react";
import { Avatar } from "../ui";
import { clock, dayChip, segments } from "../lib/chat-format.mjs";
import { get, readBase64, send } from "./net";
import { cachedThread, storeVersion, subscribe, updateThread } from "./store";
import { deliver } from "./outbox";
import { iAmTyping } from "./live";
import { openInPanel } from "./workspace/tabs";
import { ApprovalCard } from "./v3";
import type { Attachment, Channel, ChatMessage, Member } from "./types";
import css from "./chats.module.css";
import v3 from "./v3.module.css";

const isImage = (a: Attachment) => !!a.id && /^image\/(png|jpe?g|gif|webp)$/.test(a.mime ?? "");
const coarse = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
type Page = { messages: ChatMessage[]; root: ChatMessage | null };

/** A thread's first message and replies, kept fresh while the conversation changes (the live stream syncs it). */
function useThread(channel: string, root: string) {
  useSyncExternalStore(subscribe, storeVersion, () => 0);
  const at = cachedThread(channel)?.at ?? 0;
  const [page, setPage] = useState<Page | null>(null), [error, setError] = useState("");
  const load = useCallback(() => get<Page>(`chats/${channel}/messages?thread=${root}`).then((d) => { setPage(d); setError(""); }).catch((e) => setError((e as Error).message)), [channel, root]);
  useEffect(() => { void load(); }, [load, at]);
  return { page, error, load, setPage };
}

function Body({ text, usernames }: { text: string; usernames: (string | null)[] }) {
  if (!text) return null;
  return <p>{segments(text, usernames).map((s, i) => s.type === "link" ? <span key={i}><a href={s.value} target="_blank" rel="noreferrer">{s.label}</a>{s.rest}</span> : s.type === "mention" ? <mark key={i}>{s.value}</mark> : <span key={i}>{s.value}</span>)}</p>;
}

/** One message in a thread or in the picture viewer's comments. */
function Line({ m, viewer, usernames, number, active, onPin, onResolve, onImage }: { m: ChatMessage; viewer: string; usernames: (string | null)[]; number?: number; active?: boolean;
  onPin?: () => void; onResolve?: (on: boolean) => void; onImage?: (fileId: string) => void }) {
  const images = m.attachments.filter(isImage);
  return <article className={v3.tm} id={`t-${m.id}`} data-pending={m.pending || undefined} data-active={active || undefined}>
    <Avatar ai={m.byAgent} name={m.name} id={m.authorId} photoAt={m.photoAt} size={30} />
    <div><header><b>{m.authorId === viewer ? "You" : m.name}</b><time dateTime={m.createdAt}>{dayChip(m.createdAt)}, {clock(m.createdAt)}</time></header>
      {m.removed ? <p className={v3.muted}>This message was deleted</p> : <Body text={m.body} usernames={usernames} />}
      {images.map((a) => /* eslint-disable-next-line @next/next/no-img-element -- member-only file served by the API */
        <img key={a.id} src={`/api/v0/chats/files/${a.id}?inline=1`} alt={a.name} loading="lazy" onClick={() => onImage?.(a.id!)} />)}
      {m.annotation && number ? <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button type="button" className={v3.pinTag} data-resolved={m.annotation.resolved || undefined} onClick={onPin} aria-label={`Comment ${number} on the picture: show the point`}><span className={v3.num} data-resolved={m.annotation.resolved || undefined}>{number}</span>on the picture</button>
        {onResolve ? <button type="button" className={v3.pinTag} onClick={() => onResolve(!m.annotation!.resolved)} aria-pressed={m.annotation.resolved}><Check size={12} aria-hidden="true" />{m.annotation.resolved ? "Done" : "Mark done"}</button> : null}</span> : null}
    </div>
  </article>;
}

function Reply({ channel, placeholder, onSend, onTyping, autoFocus }: { channel: Channel; placeholder: string; onSend: (text: string) => Promise<void> | void; onTyping?: () => void; autoFocus?: boolean }) {
  const [text, setText] = useState(""), box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const el = box.current; if (!el) return; el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 140)}px`; }, [text]);
  const go = () => { const t = text.trim(); if (!t) return; setText(""); void onSend(t); iAmTyping(channel.id, false); box.current?.focus(); };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !coarse()) { e.preventDefault(); go(); } };
  return <div className={v3.paneCompose}><textarea ref={box} rows={1} value={text} placeholder={placeholder} aria-label={placeholder} autoFocus={autoFocus} maxLength={12000} enterKeyHint="send"
    onChange={(e) => { setText(e.target.value); if (e.target.value.trim()) { iAmTyping(channel.id, true); onTyping?.(); } }} onKeyDown={key} />
    <button type="button" onClick={go} disabled={!text.trim()} aria-label="Send"><SendHorizontal size={18} aria-hidden="true" /></button></div>;
}

/** A thread beside the conversation. */
export function ThreadPane({ channel, rootId, viewer, me, usernames, onClose, onImage }: { channel: Channel; rootId: string; viewer: string; me: Member | undefined; usernames: (string | null)[]; onClose: () => void; onImage: (messageId: string, fileId: string) => void }) {
  const { page, error, setPage } = useThread(channel.id, rootId);
  const [failed, setFailed] = useState("");
  useEffect(() => { const k = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector("[data-lightbox]")) onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [page?.messages.length]);
  const root = page?.root ?? cachedThread(channel.id)?.messages.find((m) => m.id === rootId) ?? null;
  async function reply(text: string) {
    const clientId = crypto.randomUUID();
    const temp: ChatMessage = { id: `local-${clientId}`, clientId, channelId: channel.id, authorId: viewer, name: me?.name ?? "You", username: me?.username ?? null, photoAt: me?.photoAt, body: text, parentId: rootId, quoteId: null, kind: "text",
      createdAt: new Date().toISOString(), editedAt: null, removed: false, replies: 0, attachments: [], mentions: [], reactions: [], pending: true };
    setPage((p) => p ? { ...p, messages: [...p.messages, temp] } : p); setFailed("");
    try {
      const r = await send<{ id: string; message: ChatMessage }>(`chats/${channel.id}/messages`, { body: text, attachments: [], parentId: rootId, clientId });
      setPage((p) => p ? { ...p, messages: p.messages.map((m) => m.clientId === clientId ? r.message : m) } : p);
      // The first message's reply count in the conversation moves at once.
      updateThread(channel.id, (ms) => ms.map((m) => m.id === rootId ? { ...m, replies: m.replies + 1, lastReplyAt: r.message.createdAt } : m));
    } catch (e) { setPage((p) => p ? { ...p, messages: p.messages.filter((m) => m.clientId !== clientId) } : p); setFailed(`Not sent: ${(e as Error).message}`); }
  }
  const replies = page?.messages ?? [];
  const pins = replies.filter((m) => m.annotation);
  return <aside className={v3.pane} aria-label="Thread" data-thread-pane="">
    <header className={v3.paneHead}><h3>Thread<small>{channel.name}</small></h3><button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close the thread"><X size={18} aria-hidden="true" /></button></header>
    <div ref={list} className={v3.paneBody}>
      {root ? <Line m={root} viewer={viewer} usernames={usernames} onImage={(f) => onImage(root.id, f)} /> : <p className={v3.muted}>{error || "Opening the thread…"}</p>}
      {root?.approval ? <ApprovalCard m={root} viewer={viewer} channelId={channel.id} /> : null}
      <div className={v3.rootSep}>{replies.length ? `${replies.length} repl${replies.length === 1 ? "y" : "ies"}` : "No replies yet"}</div>
      {replies.map((m) => <Line key={m.clientId ?? m.id} m={m} viewer={viewer} usernames={usernames} number={m.annotation ? pins.indexOf(m) + 1 : undefined}
        onPin={() => root && m.annotation && onImage(root.id, m.annotation.fileId)} onImage={(f) => onImage(m.id, f)} />)}
      {failed ? <p className={css.sideError} role="alert">{failed}</p> : null}
    </div>
    <Reply channel={channel} placeholder="Reply in the thread" onSend={reply} autoFocus={!coarse()} />
  </aside>;
}

/** The versions of a picture: walks the `prev` links among the messages loaded here (v1 ← v2 ← v3). */
function versionsOf(channel: string, messageId: string): { id: string; n: number }[] {
  const ms = cachedThread(channel)?.messages ?? [];
  const byId = new Map(ms.map((m) => [m.id, m]));
  const prevOf = (m: ChatMessage) => m.attachments.find((a) => a.prev)?.prev;
  let start = byId.get(messageId), guard = 0;
  while (start && prevOf(start) && byId.has(prevOf(start)!) && guard++ < 30) start = byId.get(prevOf(start)!);
  if (!start) return [];
  const chain = [start]; guard = 0;
  for (let cur = start; guard++ < 30;) { const next = ms.find((m) => prevOf(m) === cur.id && !m.removed); if (!next) break; chain.push(next); cur = next; }
  return chain.length > 1 ? chain.map((m, i) => ({ id: m.id, n: m.attachments.find((a) => a.version)?.version ?? i + 1 })) : [];
}

/** The picture viewer: comments pinned to points, versions, approval, prev / next through the chat's pictures. */
export function Lightbox({ channel, messageId, fileId, viewer, me, usernames, onClose, onGo, onPanel }: { channel: Channel; messageId: string; fileId?: string; viewer: string; me: Member | undefined; usernames: (string | null)[];
  onClose: () => void; onGo: (messageId: string, fileId: string) => void; onPanel: (fileId: string, name: string) => void }) {
  const { page, error, load } = useThread(channel.id, messageId);
  useSyncExternalStore(subscribe, storeVersion, () => 0);
  const root = page?.root ?? cachedThread(channel.id)?.messages.find((m) => m.id === messageId) ?? null;
  const images = root?.attachments.filter(isImage) ?? [];
  const image = images.find((a) => a.id === fileId) ?? images[0];
  const [commenting, setCommenting] = useState(() => !coarse()), [draft, setDraft] = useState<{ x: number; y: number } | null>(null), [active, setActive] = useState<string | null>(null);
  const [problem, setProblem] = useState(""), [busy, setBusy] = useState(false), picker = useRef<HTMLInputElement>(null);
  const replies = useMemo(() => page?.messages ?? [], [page]);
  const pins = useMemo(() => replies.filter((m) => m.annotation && m.annotation.fileId === image?.id), [replies, image?.id]);
  // Every picture loaded in this conversation, for ← and →.
  const all = useMemo(() => (cachedThread(channel.id)?.messages ?? []).flatMap((m) => m.removed ? [] : m.attachments.filter(isImage).map((a) => ({ m: m.id, f: a.id! }))), [channel.id, page]); // eslint-disable-line react-hooks/exhaustive-deps
  const here = all.findIndex((x) => x.m === messageId && x.f === image?.id);
  const versions = versionsOf(channel.id, messageId);
  useEffect(() => {
    const k = (e: globalThis.KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA") { if (e.key === "Escape") { if (draft) setDraft(null); else onClose(); } return; }
      if (e.key === "Escape") { if (draft) setDraft(null); else onClose(); }
      if (e.key === "ArrowLeft" && here > 0) onGo(all[here - 1].m, all[here - 1].f);
      if (e.key === "ArrowRight" && here >= 0 && here < all.length - 1) onGo(all[here + 1].m, all[here + 1].f);
    };
    document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k);
  }, [all, here, draft, onClose, onGo]);
  async function comment(text: string) {
    setProblem("");
    try {
      if (draft && image?.id) await send(`chats/messages/${messageId}/annotate`, { fileId: image.id, x: draft.x, y: draft.y, body: text, clientId: crypto.randomUUID() });
      else await send(`chats/${channel.id}/messages`, { body: text, attachments: [], parentId: messageId, clientId: crypto.randomUUID() });
      setDraft(null); await load();
      updateThread(channel.id, (ms) => ms.map((m) => m.id === messageId ? { ...m, replies: m.replies + 1, lastReplyAt: new Date().toISOString() } : m));
    } catch (e) { setProblem((e as Error).message); }
  }
  async function resolve(m: ChatMessage, on: boolean) { try { await send(`chats/annotations/${m.id}/resolve`, { on }); await load(); } catch (e) { setProblem((e as Error).message); } }
  // A new version: uploaded here, sent to the conversation as v(n+1), quoting this one.
  async function newVersion(file: File) {
    if (!root || !image) return; setProblem("");
    if (file.size > 5 * 1024 * 1024) { setProblem(`${file.name} is over 5 MB. Share a Drive link instead.`); return; }
    setBusy(true);
    try {
      const a = await send<Attachment>(`chats/${channel.id}/files`, { name: file.name, mime: file.type || "application/octet-stream", bytes: await readBase64(file) });
      const n = (versions.length ? Math.max(...versions.map((v) => v.n)) : image.version ?? 1) + 1;
      const last = versions.length ? versions[versions.length - 1].id : root.id;
      const clientId = crypto.randomUUID();
      const temp: ChatMessage = { id: `local-${clientId}`, clientId, channelId: channel.id, authorId: viewer, name: me?.name ?? "You", username: me?.username ?? null, photoAt: me?.photoAt, body: `Version ${n}`, parentId: null, quoteId: last, quote: null, kind: "text",
        createdAt: new Date().toISOString(), editedAt: null, removed: false, replies: 0, attachments: [{ id: a.id, name: a.name, mime: a.mime, version: n, prev: last }], mentions: [], reactions: [], pending: true };
      updateThread(channel.id, (ms) => [...ms, temp]);
      const id = await deliver(channel.id, temp);
      if (id) onGo(id, a.id!);
    } catch (e) { setProblem((e as Error).message); } finally { setBusy(false); }
  }
  const place = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!commenting) return;
    const r = (e.currentTarget.querySelector("img") as HTMLImageElement).getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    setDraft({ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }); setActive(null);
    requestAnimationFrame(() => (document.querySelector("[data-lightbox] textarea") as HTMLTextAreaElement | null)?.focus());
  };
  return <div className={v3.lb} role="dialog" aria-modal="true" aria-label={`Picture: ${image?.name ?? ""}`} data-lightbox="">
    <div className={v3.lbStage}>
      <div className={v3.lbTop}><span><b>{root ? (root.authorId === viewer ? "You" : root.name) : ""}</b><small>{root ? `${dayChip(root.createdAt)}, ${clock(root.createdAt)} · ${image?.name ?? ""}` : ""}</small></span>
        <button type="button" className={v3.lbBtn} onClick={onClose} aria-label="Close the picture"><X size={20} aria-hidden="true" /></button></div>
      <div className={v3.lbCanvas}>
        {here > 0 ? <button type="button" className={`${v3.lbBtn} ${v3.lbNav}`} data-side="prev" onClick={() => onGo(all[here - 1].m, all[here - 1].f)} aria-label="Previous picture"><ArrowLeft size={20} aria-hidden="true" /></button> : null}
        {image ? <div className={v3.lbFrame} data-commenting={commenting || undefined} onClick={place}>
          {/* eslint-disable-next-line @next/next/no-img-element -- member-only file served by the API */}
          <img src={`/api/v0/chats/files/${image.id}?inline=1`} alt={image.name} draggable={false} />
          {pins.map((m, i) => <button key={m.id} type="button" className={v3.lbPin} style={{ left: `${m.annotation!.x * 100}%`, top: `${m.annotation!.y * 100}%` }} data-resolved={m.annotation!.resolved || undefined} data-active={active === m.id || undefined}
            onClick={(e) => { e.stopPropagation(); setActive(m.id); setDraft(null); document.getElementById(`t-${m.id}`)?.scrollIntoView({ block: "nearest" }); }} aria-label={`Comment ${i + 1}: ${m.body.slice(0, 80)}`}>{i + 1}</button>)}
          {draft ? <span className={v3.lbPin} data-draft="" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }} aria-hidden="true">{pins.length + 1}</span> : null}
        </div> : <p className={v3.hint}>{error || "Opening the picture…"}</p>}
        {here >= 0 && here < all.length - 1 ? <button type="button" className={`${v3.lbBtn} ${v3.lbNav}`} data-side="next" onClick={() => onGo(all[here + 1].m, all[here + 1].f)} aria-label="Next picture"><ArrowRight size={20} aria-hidden="true" /></button> : null}
      </div>
      <div className={v3.lbBottom}>
        <button type="button" className={v3.lbBtn} aria-pressed={commenting} onClick={() => { setCommenting(!commenting); setDraft(null); }} title="Click the picture to comment on a point"><MapPin size={16} aria-hidden="true" />Comment on a point</button>
        <span style={{ flex: 1 }} />
        {image ? <a className={v3.lbBtn} href={`/api/v0/chats/files/${image.id}`} download aria-label="Download"><Download size={16} aria-hidden="true" /></a> : null}
        {image && !coarse() ? <button type="button" className={v3.lbBtn} onClick={() => onPanel(image.id!, image.name)} aria-label="Open beside the chat" title="Open beside the chat"><PanelRight size={16} aria-hidden="true" /></button> : null}
        {image ? <a className={v3.lbBtn} href={`/api/v0/chats/files/${image.id}?inline=1`} target="_blank" rel="noreferrer" aria-label="Open in a new tab"><ExternalLink size={16} aria-hidden="true" /></a> : null}
      </div>
    </div>
    <aside className={v3.lbSide} aria-label="Comments">
      <header><h3><MessageSquareText size={15} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 6 }} />Comments{pins.length ? ` · ${pins.filter((p) => !p.annotation!.resolved).length} open` : ""}</h3>
        {versions.length ? <div className={v3.versions} role="group" aria-label="Versions">{versions.map((v) => <button key={v.id} type="button" aria-current={v.id === messageId} onClick={() => { const m = cachedThread(channel.id)?.messages.find((x) => x.id === v.id); const f = m?.attachments.find(isImage); if (f?.id) onGo(v.id, f.id); }}>v{v.n}</button>)}</div> : null}
        {root ? <ApprovalCard m={root} viewer={viewer} channelId={channel.id} onError={setProblem} /> : null}
        {root && !root.approval ? <button type="button" className={v3.btn} onClick={async () => { try { await send(`chats/messages/${root.id}/approval`, { action: "ask" }); await load(); } catch (e) { setProblem((e as Error).message); } }}>Ask for approval</button> : null}
        <button type="button" className={v3.btn} disabled={busy} onClick={() => picker.current?.click()}><Upload size={14} aria-hidden="true" />{busy ? "Sending…" : "Send a new version"}</button>
        <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void newVersion(f); }} />
      </header>
      <div className={v3.lbList}>
        {!replies.length ? <p className={v3.hint}>{commenting ? "Click the picture to comment on a point, or write below." : "No comments yet."}</p> : null}
        {replies.map((m) => <Line key={m.id} m={m} viewer={viewer} usernames={usernames} active={active === m.id} number={m.annotation && m.annotation.fileId === image?.id ? pins.indexOf(m) + 1 : undefined}
          onPin={() => setActive(m.id)} onResolve={(on) => void resolve(m, on)} />)}
        {problem ? <p className={css.sideError} role="alert">{problem}</p> : null}
      </div>
      <Reply channel={channel} placeholder={draft ? `Comment on point ${pins.length + 1}` : "Write a comment"} onSend={comment} />
    </aside>
  </div>;
}
