"use client";
// CHAT-V4 (24 Oct 2026): a conversation's quick actions from the list, without opening it: right-click a row on a
// computer, press and hold it on a phone (or Shift+F10 / the context-menu key). Pin, mark read or unread, mute and
// archive, as in WhatsApp; each is my own setting.
import { useEffect, useRef } from "react";
import { Archive, ArchiveRestore, Bell, BellOff, MailCheck, MailWarning, Pin, PinOff } from "lucide-react";
import { send } from "./net";
import { mutedNow } from "./v3";
import type { Channel } from "./types";
import css from "./chats.module.css";

export type RowMenuAt = { channel: Channel; x: number; y: number };

export function RowMenu({ at, onClose, onPin, onChanged, onError }: { at: RowMenuAt; onClose: () => void; onPin: (c: Channel) => void; onChanged: () => Promise<void> | void; onError: (e: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  // CHAT-V5 (touch test): lifting the finger after press and hold is not a tap on the item that opened under it.
  const born = useRef(0);
  useEffect(() => { born.current = Date.now(); }, []);
  const c = at.channel, muted = mutedNow(c.mutedUntil), unread = c.unread > 0 || !!c.markedUnread;
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); const items = [...(box.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])]; const i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }
    };
    document.addEventListener("pointerdown", away, true); document.addEventListener("keydown", key); window.addEventListener("resize", onClose);
    return () => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", key); window.removeEventListener("resize", onClose); };
  }, [onClose]);
  const run = async (path: string, body: unknown) => { onClose(); try { await send(path, body); await onChanged(); } catch (e) { onError((e as Error).message); } };
  const markRead = () => c.lastAt ? run(`chats/${c.id}/read`, { through: c.lastAt }) : run(`chats/${c.id}/unread`, { on: false });
  // Kept inside the window: the menu opens at the pointer, flipped up or left near an edge.
  const w = 232, h = 220, x = Math.max(8, Math.min(at.x, window.innerWidth - w - 8)), y = at.y + h > window.innerHeight - 8 ? Math.max(8, at.y - h) : at.y;
  return <div ref={box} className={`${css.menu} ${css.rowMenu}`} role="menu" aria-label={`${c.name}: actions`} style={{ left: x, top: y }} data-row-menu=""
    onClickCapture={(e) => { if (Date.now() - born.current < 450) { e.preventDefault(); e.stopPropagation(); } }}>
    <button type="button" role="menuitem" onClick={() => { onClose(); onPin(c); }}>{c.pinnedAt ? <PinOff size={16} aria-hidden="true" /> : <Pin size={16} aria-hidden="true" />}{c.pinnedAt ? "Unpin chat" : "Pin chat"}</button>
    {unread ? <button type="button" role="menuitem" onClick={() => void markRead()}><MailCheck size={16} aria-hidden="true" />Mark as read</button>
      : <button type="button" role="menuitem" onClick={() => void run(`chats/${c.id}/unread`, { on: true })}><MailWarning size={16} aria-hidden="true" />Mark as unread</button>}
    {muted ? <button type="button" role="menuitem" onClick={() => void run(`chats/${c.id}/mute`, { until: null })}><Bell size={16} aria-hidden="true" />Unmute</button>
      : <button type="button" role="menuitem" onClick={() => void run(`chats/${c.id}/mute`, { until: new Date(Date.now() + 8 * 3600000).toISOString() })}><BellOff size={16} aria-hidden="true" />Mute for 8 hours</button>}
    <button type="button" role="menuitem" onClick={() => void run(`chats/${c.id}/archive`, { on: !c.archivedAt })}>{c.archivedAt ? <ArchiveRestore size={16} aria-hidden="true" /> : <Archive size={16} aria-hidden="true" />}{c.archivedAt ? "Unarchive chat" : "Archive chat"}</button>
  </div>;
}
