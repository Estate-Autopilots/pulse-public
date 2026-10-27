"use client";
// Pieces the list, the conversation and the panels share.
import { useEffect, type CSSProperties, type RefObject } from "react";
import { AtSign, Building2, MessageCircle, Users } from "lucide-react";
import { Avatar } from "../ui";
import { cachedThread, mergeLatest, saveThread } from "./store";
import { get } from "./net";
import type { Channel, ChatMessage, Member, Reader, Receipts, FormerMember } from "./types";
import css from "./chats.module.css";

type ThreadPage = { messages: ChatMessage[]; hasMore: boolean; members: Member[]; formerMembers?: FormerMember[]; receipts: Receipts; readers?: Reader[]; pinned?: ChatMessage[] };
/** Fetch the newest page of a conversation and merge it into the cache. CHAT-V3: the conversation shows its messages and
 *  each thread's first message (with "N replies"); a thread's replies open beside it (thread.tsx). */
export async function syncThread(id: string) {
  const d = await get<ThreadPage>(`chats/${id}/messages`);
  const old = cachedThread(id);
  saveThread(id, { messages: mergeLatest(old?.messages ?? [], d.messages, d.hasMore), hasMore: (old?.hasMore ?? false) || d.hasMore, members: d.members, formerMembers: d.formerMembers ?? [], receipts: d.receipts, readers: d.readers ?? [], pinned: d.pinned ?? [], at: Date.now() });
  return d;
}
/** Change the address without a server round trip (Next keeps useSearchParams in step with history). */
export function go(query: string, push = true) { const url = `/chats${query ? `?${query}` : ""}`; if (push) window.history.pushState(null, "", url); else window.history.replaceState(null, "", url); }

export function GroupAvatar({ channel, size = 48 }: { channel: Pick<Channel, "id" | "name" | "kind" | "photoAt" | "peerId" | "peerPhotoAt" | "peerAgent">; size?: number }) {
  if (channel.kind === "direct") return <Avatar ai={channel.peerAgent} name={channel.name} id={channel.peerId ?? undefined} photoAt={channel.peerPhotoAt} size={size} status={!!channel.peerId} />;
  const Icon = channel.kind === "pod" ? Users : channel.kind === "team" ? Building2 : channel.kind === "group" ? AtSign : MessageCircle;
  return <span className={css.groupAvatar} style={{ "--size": `${size}px` } as CSSProperties} data-kind={channel.kind}>
    {/* eslint-disable-next-line @next/next/no-img-element -- the group photo is served by the API, already small */}
    {channel.photoAt ? <img src={`/api/v0/chats/${channel.id}/photo?v=${Date.parse(channel.photoAt)}`} alt="" width={size} height={size} /> : <Avatar name={channel.name} size={size} />}
    <i aria-hidden="true"><Icon size={Math.max(10, Math.round(size * 0.24))} strokeWidth={2.4} /></i>
  </span>;
}


/** Below desktop size the page scrolls, so the chat sizes itself: the window under its top edge, above the phone's
 *  bottom navigation and the on-screen keyboard (visualViewport). */
export function useFitHeight(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const fit = () => {
      const el = ref.current; if (!el) return;
      const nav = [...document.querySelectorAll<HTMLElement>('nav[class*="bottomNav"]')].find((n) => n.offsetHeight > 0);
      const view = window.visualViewport?.height ?? window.innerHeight;
      // An open chat on a phone (LAYOUT-SWEEP chat mode) runs to the bottom edge: no tabs below it, no gap.
      const full = document.documentElement.dataset.chatView === "chat";
      // E2E-4P: with the keyboard up the room can be far under 380 px; the composer must still end above the keyboard.
      const keyboard = document.documentElement.dataset.keyboard === "open";
      el.style.setProperty("--chat-h", `${Math.max(keyboard ? 120 : 380, view - el.getBoundingClientRect().top - (nav?.offsetHeight ?? 0) - (full || keyboard ? 0 : 12))}px`);
    };
    fit(); window.addEventListener("resize", fit); window.visualViewport?.addEventListener("resize", fit);
    const modes = new MutationObserver(() => requestAnimationFrame(fit)); modes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-chat-view", "data-keyboard"] });
    // E2E-4P: the shell's top bar settles after the first fit (on the phone the chat then ran 15 px under the screen's
    // edge until the next resize): fit again when anything above it changes size, and once the page has settled.
    const above = new ResizeObserver(() => requestAnimationFrame(fit)); const bar = document.querySelector("[data-shell-topbar]"); if (bar) above.observe(bar);
    if (ref.current?.parentElement) above.observe(ref.current.parentElement);
    const settle = [250, 1000, 2500].map((ms) => window.setTimeout(fit, ms));
    return () => { window.removeEventListener("resize", fit); window.visualViewport?.removeEventListener("resize", fit); modes.disconnect(); above.disconnect(); settle.forEach((t) => window.clearTimeout(t)); };
  }, [ref]);
}
