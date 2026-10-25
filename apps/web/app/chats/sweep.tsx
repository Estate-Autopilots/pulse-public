"use client";
// CHAT-V5 (UX sweep): the offline banner, Ctrl+K to jump to a chat, the keyboard shortcuts, the in-chat find bar with
// the words marked in the messages, and the upload with progress.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { ChevronDown, ChevronUp, CloudOff, Keyboard, Search, X } from "lucide-react";
import { Avatar } from "../ui";
import { dayChip, filterChats, sortChats } from "../lib/chat-format.mjs";
import { get } from "./net";
import { GroupAvatar } from "./parts";
import type { Channel, ChatData, ChatMessage, Member } from "./types";
import css from "./chats.module.css";
import v5 from "./v5.module.css";

/** The browser's connection, live. */
export function useOnline() {
  return useSyncExternalStore((l) => { window.addEventListener("online", l); window.addEventListener("offline", l); return () => { window.removeEventListener("online", l); window.removeEventListener("offline", l); }; },
    () => navigator.onLine, () => true);
}
export function OfflineBanner({ waiting = 0 }: { waiting?: number }) {
  const online = useOnline();
  if (online) return null;
  return <p className={v5.offline} role="status" data-offline=""><CloudOff size={15} aria-hidden="true" />You’re offline.{waiting ? ` ${waiting} message${waiting === 1 ? "" : "s"} will send when you’re back.` : " Messages you send wait and go when you’re back."}</p>;
}

/** Ctrl+K in Chats: jump to a conversation (or start one with someone) by typing a few letters. */
export function JumpDialog({ data, onPick, onPerson, onClose }: { data: ChatData; onPick: (id: string) => void; onPerson: (p: Member) => void; onClose: () => void }) {
  const [q, setQ] = useState(""), [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const items = useMemo(() => {
    const chats = sortChats(filterChats(data.channels, "all", q)).sort((a, b) => q ? 0 : (b.unread || b.markedUnread ? 1 : 0) - (a.unread || a.markedUnread ? 1 : 0)).slice(0, 12);
    const dm = new Set(data.channels.filter((c) => c.kind === "direct").map((c) => c.peerId));
    const t = q.trim().toLowerCase();
    const people = t ? data.people.filter((p) => p.id !== data.viewer && !dm.has(p.id) && `${p.name} ${p.username ?? ""}`.toLowerCase().includes(t)).slice(0, 5) : [];
    return [...chats.map((c) => ({ kind: "chat" as const, c })), ...people.map((p) => ({ kind: "person" as const, p }))];
  }, [data, q]);
  const choose = (i: number) => { const it = items[i]; if (!it) return; onClose(); if (it.kind === "chat") onPick(it.c.id); else onPerson(it.p); };
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);
  return <div className={css.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} data-jump=""><div className={`${css.dialog} ${v5.jump}`} role="dialog" aria-modal="true" aria-label="Jump to a chat">
    <label className={v5.jumpBox}><Search size={17} aria-hidden="true" /><input autoFocus value={q} placeholder="Jump to a chat or a person…" aria-label="Jump to a chat" role="combobox" aria-expanded="true" aria-controls="chat-jump-list"
      aria-activedescendant={items.length ? `chat-jump-${active}` : undefined}
      onChange={(e) => { setQ(e.target.value); setActive(0); }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const n = items.length || 1; setActive((a) => (a + (e.key === "ArrowUp" ? n - 1 : 1)) % n); }
        else if (e.key === "Enter") { e.preventDefault(); choose(active); }
        else if (e.key === "Escape") { e.preventDefault(); onClose(); }
      }} /><kbd>Esc</kbd></label>
    <div ref={list} className={v5.jumpList} role="listbox" id="chat-jump-list" aria-label="Chats">
      {items.length ? items.map((it, i) => <button key={it.kind === "chat" ? it.c.id : it.p.id} id={`chat-jump-${i}`} data-i={i} type="button" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => choose(i)}>
        {it.kind === "chat" ? <><GroupAvatar channel={it.c} size={30} /><span><b>{it.c.name}</b>{it.c.unread ? <small>{it.c.unread} unread</small> : it.c.markedUnread ? <small>marked unread</small> : null}</span></>
          : <><Avatar name={it.p.name} id={it.p.id} photoAt={it.p.photoAt} size={30} ai={it.p.agent} /><span><b>{it.p.name}</b><small>Start a chat</small></span></>}
      </button>) : <p className={css.hint}>No chat or person matches “{q}”.</p>}
    </div>
    <p className={v5.jumpFoot} aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>↵</kbd> open</span><span><kbd>Ctrl</kbd><kbd>/</kbd> all shortcuts</span></p>
  </div></div>;
}

const SHORTCUTS: [string[], string][] = [
  [["Ctrl", "K"], "Jump to a chat or a person"], [["Alt", "↑"], "The chat above in the list"], [["Alt", "↓"], "The chat below in the list"],
  [["↑"], "Edit your last message (in an empty box)"], [["Esc"], "Cancel a reply or an edit; close search, a thread or a menu"],
  [["Ctrl", "Shift", "F"], "Search this chat"], [["Enter"], "Send"], [["Shift", "Enter"], "New line"], [["Ctrl", "Enter"], "Send as a task (when offered)"],
  [["Ctrl", "."], "Open or close the side panel"], [["Ctrl", "/"], "These shortcuts"],
];
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);
  return <div className={css.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className={css.dialog} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
    <header><h2><Keyboard size={17} aria-hidden="true" style={{ verticalAlign: "-3px", marginRight: 8 }} />Keyboard shortcuts</h2><button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close"><X size={16} aria-hidden="true" /></button></header>
    <dl className={v5.keys}>{SHORTCUTS.map(([keys, what]) => <div key={what}><dt>{keys.map((k) => <kbd key={k}>{k}</kbd>)}</dt><dd>{what}</dd></div>)}</dl>
  </div></div>;
}

/** Ctrl+K (in Chats it jumps to a chat; Pulse's own search stays one more Ctrl+K away from the dialog), Ctrl+/, Alt+↑↓. */
export function useChatKeys({ onJump, onJumpClose, onKeys, onStep }: { onJump: () => void; onJumpClose: () => void; onKeys: () => void; onStep: (by: 1 | -1) => void }) {
  const fns = useRef({ onJump, onJumpClose, onKeys, onStep });
  useEffect(() => { fns.current = { onJump, onJumpClose, onKeys, onStep }; });
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        // A second Ctrl+K while the jump dialog is open goes on to Pulse's search, as before.
        if (document.querySelector("[data-jump]")) { fns.current.onJumpClose(); return; }
        e.preventDefault(); e.stopImmediatePropagation(); fns.current.onJump();
      } else if (mod && e.key === "/") { e.preventDefault(); fns.current.onKeys(); }
      else if (e.altKey && !mod && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); fns.current.onStep(e.key === "ArrowUp" ? -1 : 1); }
    };
    window.addEventListener("keydown", k, true); return () => window.removeEventListener("keydown", k, true);
  }, []);
}

/** The words searched for, marked in the messages on screen (CSS highlights: nothing in the messages is redrawn). */
export function useFindMarks(words: string, current: string | null, root: RefObject<HTMLElement | null>, stamp: unknown) {
  useEffect(() => {
    const reg = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    const H = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    const el = root.current; const w = words.trim().toLowerCase();
    if (!reg || !H) return;
    if (!el || w.length < 2) { reg.delete("chat-find"); reg.delete("chat-find-now"); return; }
    const all: Range[] = [], now: Range[] = [];
    for (const p of el.querySelectorAll<HTMLElement>("article [data-find-text]")) {
      const inNow = !!current && p.closest(`#m-${CSS.escape(current)}`);
      const walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const t = (n.textContent ?? "").toLowerCase(); let i = t.indexOf(w);
        while (i >= 0) { const r = new Range(); r.setStart(n, i); r.setEnd(n, i + w.length); (inNow ? now : all).push(r); i = t.indexOf(w, i + w.length); }
      }
    }
    reg.set("chat-find", new H(...all)); reg.set("chat-find-now", new H(...now));
    return () => { reg.delete("chat-find"); reg.delete("chat-find-now"); };
  }, [words, current, root, stamp]);
}

/** CHAT-V5: search this chat: the messages that match, newest first, stepped through with ↑ ↓ (or Enter); each is shown
 *  in place with the words marked. `onShow` brings a message into view (loading earlier pages when needed).
 *  CHAT-V6: the server searches the whole chat; matches come 60 at a time (the next 60 when the last is reached), and
 *  any of them opens in place however far back it is (the conversation loads the page around it). */
export function FindBar({ channel, onShow, onClose, onWords }: { channel: Channel; onShow: (m: ChatMessage) => Promise<boolean>; onClose: () => void; onWords: (w: string, current: string | null) => void }) {
  const [q, setQ] = useState(""), [hits, setHits] = useState<ChatMessage[] | null>(null), [at, setAt] = useState(0), [busy, setBusy] = useState(false), [list, setList] = useState(false), [miss, setMiss] = useState("");
  const [more, setMore] = useState(false);
  const PAGE = 60;
  const input = useRef<HTMLInputElement>(null);
  const run = async (words: string) => {
    if (words.trim().length < 2) { setHits(null); onWords("", null); return; }
    setBusy(true);
    try { const d = await get<{ messages: ChatMessage[] }>(`chats/search?q=${encodeURIComponent(words.trim())}&channel=${channel.id}`); setHits(d.messages); setMore(d.messages.length >= PAGE); setAt(0); if (d.messages[0]) void step(d.messages, 0, words); else onWords(words, null); }
    catch { setHits([]); setMore(false); } finally { setBusy(false); }
  };
  const step = async (list: ChatMessage[], i: number, words = q) => {
    const m = list[i]; if (!m) return; setAt(i); setMiss(""); onWords(words, m.id);
    if (!(await onShow(m))) setMiss("This message could not be opened");
  };
  /** The next 60 matches, older than the last one. */
  const next = async (): Promise<ChatMessage[] | null> => {
    const last = hits?.at(-1); if (!last || !more) return null;
    setBusy(true);
    try {
      const d = await get<{ messages: ChatMessage[] }>(`chats/search?q=${encodeURIComponent(q.trim())}&channel=${channel.id}&older=${encodeURIComponent(last.createdAt)}`);
      const all = [...(hits ?? []), ...d.messages.filter((m) => !hits?.some((x) => x.id === m.id))]; setHits(all); setMore(d.messages.length >= PAGE); return all;
    } catch { setMore(false); return null; } finally { setBusy(false); }
  };
  useEffect(() => { const t = setTimeout(() => void run(q), 300); return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- searched as the words settle
  }, [q]);
  useEffect(() => () => onWords("", null), [onWords]);
  const n = hits?.length ?? 0;
  const move = (by: 1 | -1) => {
    if (!hits?.length) return;
    if (by === 1 && at === n - 1 && more) { void next().then((all) => { if (all && all.length > n) void step(all, n); }); return; }
    void step(hits, (at + by + n) % n);
  };
  return <form className={css.inChat} role="search" data-find-bar="" onSubmit={(e) => { e.preventDefault(); move(1); }}>
    <input ref={input} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${channel.kind === "direct" ? "this chat" : channel.name}`} aria-label="Search this chat" enterKeyHint="search"
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } else if (e.key === "ArrowUp") { e.preventDefault(); move(1); } else if (e.key === "ArrowDown" || (e.key === "Enter" && e.shiftKey)) { e.preventDefault(); move(-1); } }} />
    {q.trim().length > 1 ? <button type="button" className={v5.findCount} onClick={() => setList(!list)} aria-expanded={list} aria-label={busy ? "Searching" : n ? `Match ${at + 1} of ${n}: show the list` : "No matches"} data-find-count="">{busy ? "…" : n ? `${at + 1} of ${n}${more ? "+" : ""}` : "0"}</button> : null}
    <button type="button" className={css.iconBtn} onClick={() => move(1)} disabled={!n} aria-label="Older match"><ChevronUp size={16} aria-hidden="true" /></button>
    <button type="button" className={css.iconBtn} onClick={() => move(-1)} disabled={!n} aria-label="Newer match"><ChevronDown size={16} aria-hidden="true" /></button>
    <button type="button" className={css.iconBtn} onClick={onClose} aria-label="Close search"><X size={16} aria-hidden="true" /></button>
    {list && hits ? <div className={css.inChatHits} role="listbox" aria-label="Messages found">{hits.length ? hits.map((m, i) => <button key={m.id} type="button" role="option" aria-selected={i === at} onClick={() => { setList(false); void step(hits, i); }}>
      <b>{m.name}</b><span>{m.body.slice(0, 140)}</span><time dateTime={m.createdAt}>{dayChip(m.createdAt)}</time></button>) : <p>No message here matches “{q.trim()}”.</p>}
      {more && hits.length ? <button type="button" onClick={() => void next()} data-find-more="">Older matches…</button> : null}</div> : null}
    {miss ? <span className={v5.findMiss} role="status">{miss}</span> : null}
  </form>;
}

/** Upload with progress (a chat file as base64 JSON, as before); resolves with the stored file. */
export function uploadWithProgress<T>(path: string, body: unknown, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(); x.open("POST", `/api/v0/${path}`); x.setRequestHeader("content-type", "application/json"); x.timeout = 120000;
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.min(0.99, e.loaded / e.total)); };
    x.onload = () => { let d: { error?: string } = {}; try { d = JSON.parse(x.responseText); } catch { /* not JSON */ } if (x.status >= 200 && x.status < 300) { onProgress(1); resolve(d as T); } else reject(new Error(d.error ?? "The upload did not go through. Try again.")); };
    x.onerror = () => reject(new Error("The upload stopped: check your connection and try again."));
    x.ontimeout = () => reject(new Error("The upload took too long. Try again."));
    x.send(JSON.stringify(body));
  });
}
