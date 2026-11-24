"use client";
// CHAT-SHELL v2: the chat on every page, from the Chat button in the top bar (with the unread count). "Open Chats" (or G
// then C, from anywhere) goes to the full chat. Not on Chats itself, not inside the side panel, and on a phone the bottom
// bar's Chats tab is the way in.
// CHAT-V6: a Threads tab: the threads I am in (unread first, with the count), each opening here with its replies and a
// reply box; opening one reads it (as in Chats).
// CALLS-V2: both show messages as Chats does: pictures, voice notes, files, polls with their bars, reactions (dock-messages).
// FIX-CHAT-AI (owner walkthrough, 10 Nov 2026: "it auto-opens the last AI item as a panel covering half the page; make
// it a clean, compact chat popover with a recent-conversations list, not just the last one"): the button opens a
// compact popover under it with the recent conversations (All · Unread · Threads, a search box, one "New message"
// button); a conversation opens inside the popover with a back arrow. It never opens by itself on a page load (it used
// to reopen on every page while it had been open once); only a click, or an AI employee typing a draft for the person.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Maximize2, MessageCircle, MessageSquareText, Search, SendHorizontal, SquarePen, X } from "lucide-react";
import { draftStore, LAST_CHANNEL } from "./drafts";
import { DockMessages } from "./dock-messages";
import { GroupAvatar } from "./parts";
import { AiBadge } from "../kit/ai-badge";
import { COMPOSER_EVENT, type ComposerInsert } from "../agent-ui/events";
import { saveList } from "./store";
import { aiThinking, filterChats, listTime, preview, sortChats, thinkingLine } from "../lib/chat-format.mjs";
import type { Channel, ChatData, ChatMessage } from "./types";
import css from "./dock.module.css";
import v3 from "./v3.module.css";
import { eventElement } from "../lib/key-target.mjs";

type Msg = ChatMessage;
/** A message of mine on its way (until the conversation is read again). */
const local = (id: string, viewer: string, body: string, channelId: string, parentId: string | null = null): Msg => ({ id, channelId, authorId: viewer, name: "You", username: null, body, parentId, createdAt: new Date().toISOString(),
  editedAt: null, removed: false, replies: 0, attachments: [], mentions: [], reactions: [], pending: true });
type ThreadRow = { rootId: string; channelId: string; rootAuthorId: string; rootName: string; rootBody: string; rootFiles: number; rootRemoved: boolean; replies: number; lastAt: string; lastName: string | null; lastAuthorId: string | null; lastBody: string | null; unread: number };
type View = "list" | "chat" | "threads";
const never = () => () => {};
const RECENT = 30;
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const read = async <T,>(path: string): Promise<T | null> => { try { const r = await fetch(`/api/v0/${path}`, { cache: "no-store" }); return r.ok ? await r.json() as T : null; } catch { return null; } };

export function ChatDock() {
  const pathname = usePathname(), router = useRouter();
  const [open, setOpen] = useState(false), [unread, setUnread] = useState(0);
  const [view, setView] = useState<View>("list"), [filter, setFilter] = useState<"all" | "unread">("all"), [q, setQ] = useState("");
  const [channels, setChannels] = useState<Channel[] | null>(null), [viewer, setViewer] = useState("");
  const [chan, setChan] = useState<Channel | null>(null), [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [text, setText] = useState(""), [error, setError] = useState("");
  const [threadsUnread, setThreadsUnread] = useState(0), [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [thread, setThread] = useState<{ row: ThreadRow; root: Msg | null; msgs: Msg[] | null } | null>(null), [reply, setReply] = useState("");
  const list = useRef<HTMLDivElement>(null), box = useRef<HTMLElement>(null);
  const hidden = pathname?.startsWith("/chats");
  // Owner workbench UI (22 Oct 2026): the Chat button lives in the top bar beside the bell, and the popover opens under
  // it at the right. The bar's actions are the shell's, found once the shell is drawn.
  // HR-PEOPLE (owner, 13 Nov 2026, T1.1.9: "the chat button … looks ugly"): it sits in the layout's slot beside the bell,
  // drawn like the bell; the shell's actions row is the fallback.
  const actions = useSyncExternalStore(never, () => document.querySelector<HTMLElement>("[data-chat-slot]") ?? document.querySelector<HTMLElement>("[data-shell-actions]"), () => null);
  const names = useMemo(() => Object.fromEntries((channels ?? []).map((x) => [x.id, x.name])), [channels]);

  // G then C, from anywhere outside a text box: the full chat.
  useEffect(() => {
    let g = 0;
    const key = (e: KeyboardEvent) => {
      const t = eventElement(e.target);   // BC-249: a key from the document has no closest()
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
  useEffect(() => { queueMicrotask(() => setViewer(document.body.dataset.viewer ?? "")); }, []);
  // A new page closes it (it never follows the person around, and never opens by itself).
  useEffect(() => { queueMicrotask(() => setOpen(false)); }, [pathname]);

  const loadList = useCallback(async () => {
    const all = await read<ChatData & { threadsUnread?: number }>("chats"); if (!all) { setError("Chats can’t be reached right now."); return; }
    setThreadsUnread(all.threadsUnread ?? 0); setChannels(all.channels); setError("");
    // The list Chats keeps too (polls name their voters from it; Chats then opens drawn at once).
    if (all.viewer) { saveList(all); setViewer(all.viewer); }
  }, []);
  const loadChat = useCallback(async (c: Channel) => {
    const d = await read<{ messages: Msg[] }>(`chats/${c.id}/messages?flat=1`);
    const got = (d?.messages ?? []).slice(-RECENT); setMsgs(got);
    const last = got.at(-1);
    if (c.unread && last) { await fetch(`/api/v0/chats/${c.id}/read`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ through: last.createdAt }) }).catch(() => null);
      setChannels((l) => l?.map((x) => x.id === c.id ? { ...x, unread: 0 } : x) ?? l); setChan((x) => x && x.id === c.id ? { ...x, unread: 0 } : x); }
  }, []);
  // BUGFIX #26 (owner, 7 Nov: "when I send a message it does not say that the agent is … thinking"): while an AI employee
  // works on an answer (the same rule as Chats), the open conversation says so and looks for the reply every 3 s, not 15.
  const thinking = useMemo(() => view === "chat" ? aiThinking(msgs) : [], [view, msgs]), answering = thinking.length > 0;
  const sending = view === "chat" && !!msgs?.some((m) => m.pending);
  useEffect(() => {
    if (!open || hidden) return;
    const tick = () => { if (view === "chat" && chan) void loadChat(chan); else void loadList(); };
    queueMicrotask(tick);
    const t = window.setInterval(() => { if (document.visibilityState === "visible") tick(); }, answering ? 3000 : 15000);
    return () => window.clearInterval(t);
  }, [open, hidden, view, chan, loadList, loadChat, answering]);
  const openChat = useCallback((c: Channel) => {
    setChan(c); setMsgs(null); setView("chat"); setThread(null); setText(draftStore.get(c.id) ?? ""); setError("");
    try { window.localStorage.setItem(LAST_CHANNEL, c.id); } catch { /* none */ }
  }, []);
  const toggle = useCallback((on: boolean) => { setOpen(on); if (on) { setView("list"); setChan(null); setThread(null); setQ(""); } }, []);

  // Click outside or Escape closes it (Escape in a conversation goes back to the list first).
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { const t = e.target as Node | null; if (t && !box.current?.contains(t) && !(t as HTMLElement).closest?.("[data-chat-dock]")) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key !== "Escape") return; if (view !== "list") { setView("list"); setChan(null); setThread(null); } else setOpen(false); };
    document.addEventListener("pointerdown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key); };
  }, [open, view]);

  // AGENT-UI-CONTROL: an AI employee types a draft or an emoji for the person: into the open box, else the popover opens
  // on that conversation with the words in its box (never sent). Not on Chats: its own message box takes them there.
  useEffect(() => {
    if (hidden) return;
    const put = (e: Event) => {
      const d = (e as CustomEvent<ComposerInsert>).detail; if (!d?.text) return;
      e.preventDefault();
      const join = (before: string) => `${before}${before && !/\s$/.test(before) && /^[\p{L}\p{N}]/u.test(d.text) ? " " : ""}${d.text}`;
      if (open && chan && view === "chat" && (!d.channelId || d.channelId === chan.id)) { setText((t) => { const next = join(t); draftStore.set(chan.id, next); return next; }); return; }
      let id = d.channelId ?? chan?.id ?? null;
      if (!id) { try { id = window.localStorage.getItem(LAST_CHANNEL); } catch { /* none */ } }
      if (!id) return;
      draftStore.set(id, join(draftStore.get(id) ?? ""));
      const target = id;
      void (async () => {
        const all = await read<ChatData>("chats"); const c = all?.channels.find((x) => x.id === target);
        if (all) setChannels(all.channels);
        setOpen(true); if (c) openChat(c);
      })();
    };
    window.addEventListener(COMPOSER_EVENT, put);
    return () => window.removeEventListener(COMPOSER_EVENT, put);
  }, [hidden, open, chan, view, openChat]);

  const loadThreads = useCallback(async () => { const d = await read<{ threads: ThreadRow[] }>("chats/threads"); if (d) setThreads(d.threads); }, []);
  const openThread = useCallback(async (row: ThreadRow) => {
    setThread((t) => t?.row.rootId === row.rootId ? { ...t, row } : { row, root: null, msgs: null });
    const d = await read<{ messages: Msg[]; root: Msg | null }>(`chats/${row.channelId}/messages?thread=${row.rootId}`);
    setThread((t) => t && t.row.rootId === row.rootId ? { ...t, root: d?.root ?? null, msgs: d?.messages ?? [] } : t);
    if (row.unread) { await fetch(`/api/v0/chats/threads/${row.rootId}/seen`, { method: "POST" }).catch(() => null); setThreads((l) => l?.map((x) => x.rootId === row.rootId ? { ...x, unread: 0 } : x) ?? l); setThreadsUnread((n) => Math.max(0, n - 1)); }
  }, []);
  useEffect(() => { if (!open || hidden || view !== "threads") return; queueMicrotask(() => void loadThreads()); const t = window.setInterval(() => { if (document.visibilityState === "visible") void loadThreads(); }, 15000); return () => window.clearInterval(t); }, [open, hidden, view, loadThreads]);
  useEffect(() => { const el = list.current; if (el && view !== "list") el.scrollTop = el.scrollHeight; }, [msgs, thread?.msgs, view, answering, sending]);

  async function sendReply() {
    const body = reply.trim(); if (!body || !thread) return; const { row } = thread; const clientId = crypto.randomUUID();
    setThread((t) => t && { ...t, msgs: [...(t.msgs ?? []), local(`local-${clientId}`, viewer, body, row.channelId, row.rootId)] }); setReply(""); setError("");
    try {
      const r = await fetch(`/api/v0/chats/${row.channelId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body, attachments: [], clientId, parentId: row.rootId }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Not sent");
      void openThread({ ...row, unread: 0 });
    } catch (e) { setError(`${(e as Error).message}. Your words are back in the box.`); setReply(body); setThread((t) => t && { ...t, msgs: (t.msgs ?? []).filter((x) => x.id !== `local-${clientId}`) }); }
  }
  async function sendNow() {
    const body = text.trim(); if (!body || !chan) return;
    const clientId = crypto.randomUUID();
    setMsgs((m) => [...(m ?? []), local(`local-${clientId}`, viewer, body, chan.id)]);
    setText(""); draftStore.set(chan.id, "");
    try {
      const r = await fetch(`/api/v0/chats/${chan.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body, attachments: [], clientId }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Not sent");
      void loadChat(chan);
    } catch (e) { setError(`${(e as Error).message}. Your words are back in the box.`); setText(body); draftStore.set(chan.id, body); setMsgs((m) => (m ?? []).filter((x) => x.id !== `local-${clientId}`)); }
  }

  if (hidden) return null;
  const tab = <button type="button" className={css.tab} data-open={open || undefined} aria-expanded={open} aria-haspopup="dialog" onClick={() => toggle(!open)} aria-label={unread ? `Chat, ${unread} unread` : "Chat"} title="Chat · G then C for the full chat" data-chat-dock="">
    <MessageCircle size={16} aria-hidden="true" /><span>Chat</span>{unread ? <i>{unread > 99 ? "99+" : unread}</i> : null}</button>;
  const button = actions ? createPortal(tab, actions) : null;
  if (!open) return button;
  const first = (n: string | null) => (n ?? "").split(" ")[0];
  const who = (id: string | null, n: string | null) => id === viewer ? "You" : first(n);
  const shown = channels ? sortChats(filterChats(channels, filter, q)).slice(0, 40) : null;
  const unreadChats = channels ? filterChats(channels, "unread").length : 0;
  const full = view === "threads" ? (thread ? `/chats?channel=${thread.row.channelId}&thread=${thread.row.rootId}` : "/chats") : view === "chat" && chan ? `/chats?channel=${chan.id}` : "/chats";
  const back = () => { setView(thread ? "threads" : "list"); setChan(null); setThread(null); if (!thread) void loadList(); };

  return <>{button}<section ref={box} className={css.dock} role="dialog" aria-label="Chats" data-chat-dock-panel="" data-view={view}>
    {view === "chat" && chan ? <header className={css.head}>
      <button type="button" className={css.icon} onClick={back} aria-label="Back to your chats"><ArrowLeft size={17} aria-hidden="true" /></button>
      <GroupAvatar channel={chan} size={30} />
      <b className={css.title} title={chan.name}>{chan.name}</b>
      <Link href={full} className={css.icon} aria-label="Open in Chats" title="Open in Chats · G then C"><Maximize2 size={15} aria-hidden="true" /></Link>
      <button type="button" className={css.icon} onClick={() => setOpen(false)} aria-label="Close"><X size={16} aria-hidden="true" /></button>
    </header> : <>
      <header className={css.head}>
        {thread ? <button type="button" className={css.icon} onClick={() => { setThread(null); void loadThreads(); }} aria-label="Back to threads"><ArrowLeft size={17} aria-hidden="true" /></button> : null}
        <b className={css.title}>Chats</b>
        <Link href={full} className={css.openAll}>Open Chats</Link>
        <button type="button" className={css.icon} onClick={() => setOpen(false)} aria-label="Close"><X size={16} aria-hidden="true" /></button>
      </header>
      {thread ? null : <div className={css.tools}>
        {view === "list" ? <label className={css.search}><Search size={15} aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" aria-label="Search chats" autoFocus /></label> : null}
        <span className={css.tabs} role="tablist" aria-label="Show">
          <button type="button" role="tab" aria-selected={view === "list" && filter === "all"} onClick={() => { setView("list"); setFilter("all"); }}>All</button>
          <button type="button" role="tab" aria-selected={view === "list" && filter === "unread"} onClick={() => { setView("list"); setFilter("unread"); }}>Unread{unreadChats ? <i>{unreadChats > 99 ? "99+" : unreadChats}</i> : null}</button>
          <button type="button" role="tab" aria-selected={view === "threads"} onClick={() => { setView("threads"); setThread(null); }} data-dock-threads="">Threads{threadsUnread ? <i aria-label={`${threadsUnread} with unread replies`}>{threadsUnread > 99 ? "99+" : threadsUnread}</i> : null}</button>
        </span>
      </div>}
    </>}

    {view === "list" ? <>
      <div className={css.rows} aria-label="Recent chats" data-dock-list="">
        {shown === null ? <p className={css.note}>{error || "Opening your chats…"}</p>
          : !shown.length ? <p className={css.note}>{q ? `No chat matches “${q}”.` : filter === "unread" ? "All read. Nice work." : "No chats yet."}</p>
          : shown.map((c) => <button key={c.id} type="button" className={css.row} data-unread={c.unread ? "" : undefined} data-dock-row={c.id} onClick={() => openChat(c)}>
            <GroupAvatar channel={c} size={40} />
            <span className={css.rowMain}>
              <span className={css.rowTop}><b>{c.name}</b>{c.peerAgent ? <AiBadge /> : null}<time dateTime={c.lastAt ?? undefined}>{listTime(c.lastAt)}</time></span>
              <span className={css.rowBottom}><span>{preview(c, viewer)}</span>{c.unread ? <i aria-label={`${c.unread} unread`}>{c.unread > 99 ? "99+" : c.unread}</i> : null}</span>
            </span>
          </button>)}
      </div>
      <footer className={css.foot}><Link href="/chats?new=1" className={css.primary} data-dock-new=""><SquarePen size={16} aria-hidden="true" />New message</Link></footer>
    </> : view === "threads" ? <>
      {thread ? <>
        <div ref={list} className={css.msgs} role="log" aria-label={`Thread in ${names[thread.row.channelId] ?? "a conversation"}`} data-dock-thread={thread.row.rootId}>
          <p className={css.threadIn}>Thread in <b>{names[thread.row.channelId] ?? "a conversation"}</b></p>
          {thread.root ? <DockMessages channelId={thread.row.channelId} messages={[thread.root]} viewer={viewer} names root update={(_, f) => setThread((t) => t && t.root ? { ...t, root: f(t.root) } : t)} reload={() => void openThread(thread.row)} /> : null}
          {thread.msgs === null ? <p className={css.note}>Opening…</p> : thread.msgs.length ? <><p className={css.replies}>{thread.msgs.length} repl{thread.msgs.length === 1 ? "y" : "ies"}</p>
            <DockMessages channelId={thread.row.channelId} messages={thread.msgs} viewer={viewer} names update={(id, f) => setThread((t) => t && t.msgs ? { ...t, msgs: t.msgs.map((m) => m.id === id ? f(m) : m) } : t)} reload={() => void openThread(thread.row)} /></> : <p className={css.note}>No replies yet.</p>}
        </div>
        {error ? <p className={css.error} role="alert">{error}</p> : null}
        <form className={css.box} onSubmit={(e) => { e.preventDefault(); void sendReply(); }}>
          <textarea rows={1} value={reply} placeholder="Reply in the thread" aria-label="Reply in the thread" maxLength={12000} onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void sendReply(); } }} />
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
    </> : chan ? <>
      <div ref={list} className={css.msgs} role="log" aria-label={`Messages with ${chan.name}`}>
        {msgs === null ? <p className={css.note}>{error || "Opening…"}</p>
          : msgs.length ? <DockMessages channelId={chan.id} messages={msgs} viewer={viewer} names={chan.kind !== "direct"} update={(id, f) => setMsgs((l) => l?.map((m) => m.id === id ? f(m) : m) ?? l)} reload={() => void loadChat(chan)} />
          : <p className={css.note}>Say hello.</p>}
        {msgs && (answering || sending) ? <div className={`${v3.typing} ${css.thinking}`} role="status" data-ai-thinking="" data-dock-thinking=""><span aria-hidden="true"><i /><i /><i /></span>
          <span>{answering ? thinkingLine(thinking) : "Sending…"}</span></div> : null}
      </div>
      {error && msgs ? <p className={css.error} role="alert">{error}</p> : null}
      <form className={css.box} onSubmit={(e) => { e.preventDefault(); void sendNow(); }}>
        <textarea rows={1} value={text} placeholder={`Message ${chan.name}`} aria-label={`Message ${chan.name}`} maxLength={12000} autoFocus
          onChange={(e) => { setText(e.target.value); draftStore.set(chan.id, e.target.value); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void sendNow(); } }} />
        <button type="submit" disabled={!text.trim()} aria-label="Send"><SendHorizontal size={17} aria-hidden="true" /></button>
      </form>
    </> : null}
  </section></>;
}
