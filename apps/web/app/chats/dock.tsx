"use client";
// CHAT-SHELL v2: the chat on every page. A quiet "Chat" tab in the bottom corner (with the unread count) opens the
// conversation last used in Chats: its latest messages and a message box that keeps its draft (drafts.ts). "Open
// chat" (or G then C, from anywhere) goes to the full chat. Not on Chats itself, not inside the side panel, and on a
// phone the bottom bar's Chats tab is the way in.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Maximize2, MessageCircle, SendHorizontal, X } from "lucide-react";
import { draftStore, LAST_CHANNEL } from "./drafts";
import css from "./dock.module.css";

type Msg = { id: string; authorId: string; name: string; body: string; createdAt: string; kind?: string; removed?: boolean; attachments?: unknown[] };
type Chan = { id: string; name: string; unread: number; kind: string; moderationOnly?: boolean };
const never = () => () => {};
const OPEN_KEY = "pulse.chat.dock.open";
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const read = async <T,>(path: string): Promise<T | null> => { try { const r = await fetch(`/api/v0/${path}`, { cache: "no-store" }); return r.ok ? await r.json() as T : null; } catch { return null; } };

export function ChatDock() {
  const pathname = usePathname(), router = useRouter();
  const [open, setOpen] = useState(false), [unread, setUnread] = useState(0);
  const [chan, setChan] = useState<Chan | null>(null), [msgs, setMsgs] = useState<Msg[] | null>(null), [viewer, setViewer] = useState("");
  const [text, setText] = useState(""), [error, setError] = useState("");
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
    const all = await read<{ channels: Chan[] }>("chats"); if (!all) { setError("Chats can’t be reached right now."); return; }
    let last: string | null = null; try { last = window.localStorage.getItem(LAST_CHANNEL); } catch { /* none */ }
    const c = all.channels.find((x) => x.id === last && !x.moderationOnly) ?? all.channels.filter((x) => !x.moderationOnly).sort((a, b) => b.unread - a.unread)[0] ?? null;
    setChan(c); setError("");
    if (c) { const d = await read<{ messages: Msg[] }>(`chats/${c.id}/messages?flat=1`); setMsgs((d?.messages ?? []).slice(-30)); setText(draftStore.get(c.id) ?? ""); }
  }, []);
  useEffect(() => { if (!open || hidden) return; queueMicrotask(() => void load()); const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15000); return () => window.clearInterval(t); }, [open, hidden, load]);
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs]);
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
  return <>{button}<section className={css.dock} aria-label="Chat" data-chat-dock-panel="">
    <header>
      <b title={chan?.name}>{chan?.name ?? "Chat"}</b>
      <Link href={chan ? `/chats?channel=${chan.id}` : "/chats"} className={css.icon} aria-label="Open the full chat" title="Open the full chat · G then C"><Maximize2 size={15} aria-hidden="true" /></Link>
      <button type="button" className={css.icon} onClick={() => toggle(false)} aria-label="Close the chat"><X size={16} aria-hidden="true" /></button>
    </header>
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
  </section></>;
}
