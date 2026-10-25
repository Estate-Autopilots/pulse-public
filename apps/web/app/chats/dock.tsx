"use client";
// CHAT-SHELL v2: the chat on every page. A quiet "Chat" tab in the bottom corner (with the unread count) opens the
// conversation last used in Chats: its latest messages and a message box that keeps its draft (drafts.ts). "Open
// chat" (or G then C, from anywhere) goes to the full chat. Not on Chats itself, not inside the side panel, and on a
// phone the bottom bar's Chats tab is the way in.
// CHAT-V6: a Threads tab beside the conversation: the threads I am in (unread first, with the count), each opening here
// with its replies and a reply box; opening one reads it (as in Chats).
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Maximize2, MessageCircle, MessageSquareText, SendHorizontal, X } from "lucide-react";
import { draftStore, LAST_CHANNEL } from "./drafts";
import css from "./dock.module.css";

type Msg = { id: string; authorId: string; name: string; body: string; createdAt: string; kind?: string; removed?: boolean; attachments?: unknown[] };
type Chan = { id: string; name: string; unread: number; kind: string; moderationOnly?: boolean };
type ThreadRow = { rootId: string; channelId: string; rootAuthorId: string; rootName: string; rootBody: string; rootFiles: number; rootRemoved: boolean; replies: number; lastAt: string; lastName: string | null; lastAuthorId: string | null; lastBody: string | null; unread: number };
const never = () => () => {};
const OPEN_KEY = "pulse.chat.dock.open";
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const read = async <T,>(path: string): Promise<T | null> => { try { const r = await fetch(`/api/v0/${path}`, { cache: "no-store" }); return r.ok ? await r.json() as T : null; } catch { return null; } };

export function ChatDock() {
  const pathname = usePathname(), router = useRouter();
  const [open, setOpen] = useState(false), [unread, setUnread] = useState(0);
  const [chan, setChan] = useState<Chan | null>(null), [msgs, setMsgs] = useState<Msg[] | null>(null), [viewer, setViewer] = useState("");
  const [text, setText] = useState(""), [error, setError] = useState("");
  // CHAT-V6: the Threads tab, and a thread open in the dock (its first message, replies, a reply box).
  const [view, setView] = useState<"chat" | "threads">("chat"), [threadsUnread, setThreadsUnread] = useState(0), [names, setNames] = useState<Record<string, string>>({});
  const [threads, setThreads] = useState<ThreadRow[] | null>(null), [thread, setThread] = useState<{ row: ThreadRow; root: Msg | null; msgs: Msg[] | null } | null>(null), [reply, setReply] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const hidden = pathname?.startsWith("/chats");
  // Owner workbench UI (22 Oct 2026): the Chat button lives in the top bar beside the bell, and the dock opens under it
  // at the right, so nothing of the chat floats over a page until it is opened (the pill at the bottom left covered
  // page content and the sidebar). The bar's actions are the shell's, found once the shell is drawn.
  const actions = useSyncExternalStore(never, () => document.querySelector<HTMLElement>("[data-shell-actions]"), () => null);

  // G then C, from anywhere outside a text box: the full chat.
  useEffect(() => {
    let g = 0;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || t?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (e.key === "g" || e.key === "G") { g = Date.now(); return; }
      if ((e.key === "c" || e.key === "C") && Date.now() - g < 900) { e.preventDefault(); e.stopPropagation(); g = 0; router.push("/chats"); }
    };
    window.addEventListener("keydown", key, true); return () => window.removeEventListener("keydown", key, true);
  }, [router]);
  useEffect(() => {
    const changed = (e: Event) => { const n = (e as CustomEvent<{ counts?: { chats?: unknown } }>).detail?.counts?.chats; if (typeof n === "number") setUnread(n); };
    window.addEventListener("pulse:communications", changed); return () => window.removeEventListener("pulse:communications", changed);
  }, []);
  useEffect(() => { queueMicrotask(() => { try { setOpen(window.sessionStorage.getItem(OPEN_KEY) === "1"); } catch { /* none */ } setViewer(document.body.dataset.viewer ?? ""); }); }, []);

  const load = useCallback(async () => {
    const all = await read<{ channels: Chan[]; threadsUnread?: number }>("chats"); if (!all) { setError("Chats can’t be reached right now."); return; }
    setThreadsUnread(all.threadsUnread ?? 0); setNames(Object.fromEntries(all.channels.map((x) => [x.id, x.name])));
    let last: string | null = null; try { last = window.localStorage.getItem(LAST_CHANNEL); } catch { /* none */ }
    const c = all.channels.find((x) => x.id === last && !x.moderationOnly) ?? all.channels.filter((x) => !x.moderationOnly).sort((a, b) => b.unread - a.unread)[0] ?? null;
    setChan(c); setError("");
    if (c) { const d = await read<{ messages: Msg[] }>(`chats/${c.id}/messages?flat=1`); setMsgs((d?.messages ?? []).slice(-30)); setText(draftStore.get(c.id) ?? ""); }
  }, []);
  useEffect(() => { if (!open || hidden) return; queueMicrotask(() => void load()); const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15000); return () => window.clearInterval(t); }, [open, hidden, load]);
  const loadThreads = useCallback(async () => { const d = await read<{ threads: ThreadRow[] }>("chats/threads"); if (d) setThreads(d.threads); }, []);
  const openThread = useCallback(async (row: ThreadRow) => {
    setThread((t) => t?.row.rootId === row.rootId ? { ...t, row } : { row, root: null, msgs: null });
    const d = await read<{ messages: Msg[]; root: Msg | null }>(`chats/${row.channelId}/messages?thread=${row.rootId}`);
    setThread((t) => t && t.row.rootId === row.rootId ? { ...t, root: d?.root ?? null, msgs: d?.messages ?? [] } : t);
    if (row.unread) { await fetch(`/api/v0/chats/threads/${row.rootId}/seen`, { method: "POST" }).catch(() => null); setThreads((l) => l?.map((x) => x.rootId === row.rootId ? { ...x, unread: 0 } : x) ?? l); setThreadsUnread((n) => Math.max(0, n - 1)); }
  }, []);
  useEffect(() => { if (!open || hidden || view !== "threads") return; queueMicrotask(() => void loadThreads()); const t = window.setInterval(() => { if (document.visibilityState === "visible") void loadThreads(); }, 15000); return () => window.clearInterval(t); }, [open, hidden, view, loadThreads]);
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs, thread?.msgs]);
  async function sendReply() {
    const body = reply.trim(); if (!body || !thread) return; const { row } = thread; const clientId = crypto.randomUUID();
    setThread((t) => t && { ...t, msgs: [...(t.msgs ?? []), { id: `local-${clientId}`, authorId: viewer, name: "You", body, createdAt: new Date().toISOString() }] }); setReply(""); setError("");
    try {
      const r = await fetch(`/api/v0/chats/${row.channelId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body, attachments: [], clientId, parentId: row.rootId }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Not sent");
      void openThread({ ...row, unread: 0 });
    } catch (e) { setError(`${(e as Error).message}. Your words are back in the box.`); setReply(body); setThread((t) => t && { ...t, msgs: (t.msgs ?? []).filter((x) => x.id !== `local-${clientId}`) }); }
  }
  const toggle = (on: boolean) => { setOpen(on); try { window.sessionStorage.setItem(OPEN_KEY, on ? "1" : "0"); } catch { /* none */ } };

  async function sendNow() {
    const body = text.trim(); if (!body || !chan) return;
    const clientId = crypto.randomUUID();
    setMsgs((m) => [...(m ?? []), { id: `local-${clientId}`, authorId: viewer, name: "You", body, createdAt: new Date().toISOString() }]);
    setText(""); draftStore.set(chan.id, "");
    try {
      const r = await fetch(`/api/v0/chats/${chan.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body, attachments: [], clientId }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Not sent");
      void load();
    } catch (e) { setError(`${(e as Error).message}. Your words are back in the box.`); setText(body); draftStore.set(chan.id, body); setMsgs((m) => (m ?? []).filter((x) => x.id !== `local-${clientId}`)); }
  }

  if (hidden) return null;
  const tab = <button type="button" className={css.tab} data-open={open || undefined} aria-expanded={open} onClick={() => toggle(!open)} aria-label={unread ? `Chat, ${unread} unread` : "Chat"} title="Chat · G then C for the full chat" data-chat-dock="">
    <MessageCircle size={16} aria-hidden="true" /><span>Chat</span>{unread ? <i>{unread > 99 ? "99+" : unread}</i> : null}</button>;
  const button = actions ? createPortal(tab, actions) : null;
  if (!open) return button;
  const first = (n: string | null) => (n ?? "").split(" ")[0];
  const who = (id: string | null, n: string | null) => id === viewer ? "You" : first(n);
  const full = view === "threads" ? (thread ? `/chats?channel=${thread.row.channelId}&thread=${thread.row.rootId}` : "/chats") : chan ? `/chats?channel=${chan.id}` : "/chats";
  return <>{button}<section className={css.dock} aria-label="Chat" data-chat-dock-panel="">
    <header>
      {view === "threads" && thread ? <button type="button" className={css.icon} onClick={() => { setThread(null); void loadThreads(); }} aria-label="Back to threads"><ArrowLeft size={16} aria-hidden="true" /></button> : null}
      <span className={css.tabs} role="tablist" aria-label="Show">
        <button type="button" role="tab" aria-selected={view === "chat"} onClick={() => { setView("chat"); setThread(null); }} title={chan?.name}>{chan?.name ?? "Chat"}</button>
        <button type="button" role="tab" aria-selected={view === "threads"} onClick={() => setView("threads")} data-dock-threads="">Threads{threadsUnread ? <i aria-label={`${threadsUnread} with unread replies`}>{threadsUnread > 99 ? "99+" : threadsUnread}</i> : null}</button>
      </span>
      <Link href={full} className={css.icon} aria-label="Open the full chat" title="Open the full chat · G then C"><Maximize2 size={15} aria-hidden="true" /></Link>
      <button type="button" className={css.icon} onClick={() => toggle(false)} aria-label="Close the chat"><X size={16} aria-hidden="true" /></button>
    </header>
    {view === "threads" ? <>
      {thread ? <>
        <div ref={list} className={css.msgs} role="log" aria-label={`Thread in ${names[thread.row.channelId] ?? "a conversation"}`} data-dock-thread={thread.row.rootId}>
          <p className={css.threadIn}>Thread in <b>{names[thread.row.channelId] ?? "a conversation"}</b></p>
          {thread.root ? <div className={css.msg} data-mine={thread.root.authorId === viewer || undefined} data-root=""><small>{who(thread.root.authorId, thread.root.name)}</small><p>{thread.root.removed ? <em>This message was deleted</em> : thread.root.body || <em>Attachment</em>}<time>{clock(thread.root.createdAt)}</time></p></div> : null}
          {thread.msgs === null ? <p className={css.note}>Opening…</p> : thread.msgs.length ? <><p className={css.replies}>{thread.msgs.length} repl{thread.msgs.length === 1 ? "y" : "ies"}</p>{thread.msgs.filter((m) => m.kind !== "event").map((m) => <div key={m.id} className={css.msg} data-mine={m.authorId === viewer || undefined}>
            {m.authorId !== viewer ? <small>{first(m.name)}</small> : null}<p>{m.removed ? <em>This message was deleted</em> : m.body || <em>Attachment</em>}<time>{clock(m.createdAt)}</time></p></div>)}</> : <p className={css.note}>No replies yet.</p>}
        </div>
        {error ? <p className={css.error} role="alert">{error}</p> : null}
        <form className={css.box} onSubmit={(e) => { e.preventDefault(); void sendReply(); }}>
          <textarea rows={1} value={reply} placeholder="Reply in the thread" aria-label="Reply in the thread" maxLength={12000} onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void sendReply(); } if (e.key === "Escape") setThread(null); }} />
          <button type="submit" disabled={!reply.trim()} aria-label="Send the reply"><SendHorizontal size={17} aria-hidden="true" /></button>
        </form></>
      : <div className={css.threadList} aria-label="Threads" data-dock-thread-list="">
        {threads === null ? <p className={css.note}>Opening your threads…</p> : !threads.length ? <p className={css.note}>No threads yet. Threads you start, reply in or are mentioned in show here.</p>
          : threads.map((t) => <button key={t.rootId} type="button" className={css.threadRow} data-unread={t.unread ? "" : undefined} data-dock-thread-row={t.rootId} onClick={() => void openThread(t)}>
            <span className={css.threadTop}><MessageSquareText size={14} aria-hidden="true" /><b>{names[t.channelId] ?? "Conversation"}</b><time>{clock(t.lastAt)}</time></span>
            <span className={css.threadRoot}><b>{who(t.rootAuthorId, t.rootName)}:</b> {t.rootRemoved ? "This message was deleted" : t.rootBody || (t.rootFiles ? "📎 Attachment" : "")}</span>
            <span className={css.threadLast}><em>{t.replies} repl{t.replies === 1 ? "y" : "ies"}</em>{t.lastBody ? <> · {who(t.lastAuthorId, t.lastName)}: {t.lastBody}</> : null}{t.unread ? <i>{t.unread}</i> : null}</span>
          </button>)}
      </div>}
    </> : <>
    <div ref={list} className={css.msgs} role="log" aria-label="Messages">
      {msgs === null ? <p className={css.note}>{error || "Opening…"}</p> : !chan ? <p className={css.note}>No conversations yet. <Link href="/chats">Start one</Link>.</p>
        : msgs.length ? msgs.filter((m) => m.kind !== "event").map((m) => <div key={m.id} className={css.msg} data-mine={m.authorId === viewer || undefined}>
          {m.authorId !== viewer && chan.kind !== "direct" ? <small>{m.name.split(" ")[0]}</small> : null}
          <p>{m.removed ? <em>This message was deleted</em> : m.body || <em>Attachment</em>}<time>{clock(m.createdAt)}</time></p></div>)
        : <p className={css.note}>Say hello.</p>}
    </div>
    {error && msgs ? <p className={css.error} role="alert">{error}</p> : null}
    {chan ? <form className={css.box} onSubmit={(e) => { e.preventDefault(); void sendNow(); }}>
      <textarea rows={1} value={text} placeholder={`Message ${chan.name}`} aria-label={`Message ${chan.name}`} maxLength={12000}
        onChange={(e) => { setText(e.target.value); draftStore.set(chan.id, e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void sendNow(); } if (e.key === "Escape") toggle(false); }} />
      <button type="submit" disabled={!text.trim()} aria-label="Send"><SendHorizontal size={17} aria-hidden="true" /></button>
    </form> : null}
    </>}
  </section></>;
}
