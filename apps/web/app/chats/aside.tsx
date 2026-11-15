"use client";
// CHAT-V4 (24 Oct 2026): one right-hand column for the chat. The owner: "there is a header even when we open the right
// side bar and it's ugly". Every column that opens beside a conversation (group or contact info, a thread, media and
// files, the side panel's pages) is now the same thing: on a computer it runs the full height of the window with its own
// compact header, and Pulse's top bar (the conversation's header, the bell, the account) ends at its left edge, so no
// header sits over it. With room for the conversation beside it, it docks (the chat narrows); in a narrow window it lays
// over the chat as a drawer. Only the newest column shows; closing it brings back the one under it. On a phone each is a
// full-screen sheet with its own header (the side panel keeps its bottom sheet).
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

type Entry = { el: HTMLElement; dock: () => boolean };
const stack: Entry[] = [];
const DESK = "(min-width: 900px)";
/** The conversation keeps at least this much room beside a docked column; less, and the column lays over it. */
const MIN_CHAT = 520;
let observer: ResizeObserver | null = null;

function apply() {
  const root = document.documentElement;
  stack.forEach((e, i) => { if (i === stack.length - 1) delete e.el.dataset.asideBehind; else e.el.dataset.asideBehind = ""; });
  const top = stack[stack.length - 1];
  if (!top || !window.matchMedia(DESK).matches) { delete root.dataset.chatAside; root.style.removeProperty("--chat-aside-w"); return; }
  root.dataset.chatAside = top.dock() ? "dock" : "over";
  root.style.setProperty("--chat-aside-w", `${Math.round(top.el.getBoundingClientRect().width)}px`);
}

/** Room for the conversation beside a column this wide: the window less the rail, the chat list and the column. */
export function roomBeside(el: HTMLElement) {
  const left = document.getElementById("main-content")?.getBoundingClientRect().left ?? 0;
  const list = document.querySelector<HTMLElement>("[data-chat-list]");
  const listW = list && list.offsetParent ? list.getBoundingClientRect().width : 0;
  return window.innerWidth - left - listW - el.getBoundingClientRect().width >= MIN_CHAT;
}
const always = () => true;
/** Info's media strip asks the open conversation to show a picture ({ m, f }) or the whole gallery ({}). */
export const MEDIA_EVENT = "pulse:chat-media";

/** Registers `ref` as the chat's right-hand column while mounted (and `on`). */
export function useChatAside(ref: RefObject<HTMLElement | null>, { on = true, dock }: { on?: boolean; dock?: (el: HTMLElement) => boolean } = {}) {
  const decide = useRef(dock);
  useLayoutEffect(() => { decide.current = dock; });
  useLayoutEffect(() => {
    const el = ref.current; if (!el || !on) return;
    const entry: Entry = { el, dock: () => (decide.current ?? always)(el) };
    stack.push(entry); el.dataset.chatAsideEl = "";
    observer ??= new ResizeObserver(() => apply());
    observer.observe(el); window.addEventListener("resize", apply);
    apply();
    return () => {
      const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1);
      observer?.unobserve(el); window.removeEventListener("resize", apply);
      delete el.dataset.asideBehind; delete el.dataset.chatAsideEl;
      apply();
    };
  }, [ref, on]);
}

/** A column beside the conversation (info, a thread, media): docks when the conversation keeps its room. */
export function ChatAside({ className, label, children, ...rest }: { className?: string; label: string; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  const ref = useRef<HTMLElement>(null);
  useChatAside(ref, { dock: roomBeside });
  return <aside ref={ref} className={className} aria-label={label} {...rest}>{children}</aside>;
}
