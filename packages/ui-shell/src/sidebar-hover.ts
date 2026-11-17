// SIDEBAR-HOVER (owner, 17 Nov 2026: "When we hover on the side ribbon (sales, money, HR, people), the sidebar should
// react in an animated way and open up what's listed under it"). Resting the pointer on a group (its rail icon or its
// head in the sidebar) opens it; leaving closes it again, unless a click pinned it. Plain functions and timers, no React:
// the web's unit tests drive it with fake timers (apps/web/app/lib/sidebar-hover.test.mjs).

/** The pointer rests this long on a group before it opens (a pass over it opens nothing). */
export const HOVER_OPEN_MS = 120;
/** A group opened by the pointer closes this long after the pointer leaves the menu (a pass over a gap keeps it). */
export const HOVER_CLOSE_MS = 250;
/** The fold's own animation (height and opacity, ease-out); none when the person asks for less motion. */
export const FOLD_MS = 200;
/** Only a mouse or a pen that can hover opens groups; on touch a tap opens a group as before. */
export const HOVER_MEDIA = "(hover: hover) and (pointer: fine)";
export const REDUCED_MEDIA = "(prefers-reduced-motion: reduce)";

export type HoverFrom = "rail" | "panel";
type Timers = Readonly<{ set: (run: () => void, ms: number) => unknown; clear: (id: unknown) => void }>;
const realTimers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };

/** Whether a pointer event may open groups: a hover-capable fine pointer (the media query) and a mouse or pen event. */
export const hoverCapable = (pointerType: string | undefined, matches: boolean) => matches && (pointerType === "mouse" || pointerType === "pen");
/** How long a fold animates: none when the person asks for less motion (it opens and closes at once). */
export const foldMs = (reduced: boolean) => reduced ? 0 : FOLD_MS;

export type HoverIntent<K extends string> = {
  /** The groups the pointer opened, in the menu's order. */
  readonly open: readonly K[];
  /** The group the pointer is resting on, not open yet. */
  readonly pending: K | null;
  /** The pointer came onto a group (its rail icon, or its head and pages in the sidebar). */
  enter(key: K, from: HoverFrom): void;
  /** The pointer is on the open group's own flyout: nothing closes, nothing else opens. */
  stay(): void;
  /** The pointer left a group, an icon or the flyout. */
  leave(): void;
  /** Opens a group at once, alone (the keyboard opening a rail icon's flyout). */
  show(key: K): void;
  /** Focus is inside this group (null: focus left): it stays open while the pointer is away. */
  hold(key: K | null): void;
  /** A click pinned or folded this group: the pointer's opening of it is over. */
  drop(key: K): void;
  /** Closes everything at once (a page opened, the rail folded, Edit menu). */
  clear(): void;
  dispose(): void;
};

/** `rank` is a group's place in the menu (top first). A group opened from the rail (or by the keyboard on a rail icon) is
 *  the only one open, even over one that focus held: the pointer is on the rail, so the list may move, and a folded
 *  rail shows one group at a time. In the sidebar a newly opened group closes those below it, never those above it
 *  (nor the one focus is in): closing a group above the pointer would pull the list up under it, onto another group,
 *  which then opens in turn. */
export function hoverIntent<K extends string>(options: Readonly<{ rank: (key: K) => number; onChange: (open: readonly K[]) => void; openMs?: number; closeMs?: number; timers?: Timers }>): HoverIntent<K> {
  const { rank, onChange, openMs = HOVER_OPEN_MS, closeMs = HOVER_CLOSE_MS, timers = realTimers } = options;
  let open: readonly K[] = [];
  let pending: K | null = null;
  let held: K | null = null;
  let inside = false;
  let opening: unknown = null;
  let closing: unknown = null;
  const sorted = (list: readonly K[]) => [...new Set(list)].sort((a, b) => rank(a) - rank(b));
  const keepHeld = (list: readonly K[]) => held && open.includes(held) && !list.includes(held) ? [...list, held] : list;
  const set = (next: readonly K[]) => {
    const list = sorted(next);
    if (list.length === open.length && list.every((k, i) => k === open[i])) return;
    open = list;
    onChange(open);
  };
  const stopOpening = () => { if (opening !== null) timers.clear(opening); opening = null; pending = null; };
  const stopClosing = () => { if (closing !== null) timers.clear(closing); closing = null; };
  const closeSoon = () => {
    stopClosing();
    closing = timers.set(() => { closing = null; set(held && open.includes(held) ? [held] : []); }, closeMs);
  };
  return {
    get open() { return open; },
    get pending() { return pending; },
    enter(key, from) {
      inside = true;
      stopClosing();
      const already = from === "rail" ? open.length === 1 && open[0] === key : open.includes(key);
      if (already) { stopOpening(); return; }
      if (pending === key) return;
      stopOpening();
      pending = key;
      opening = timers.set(() => {
        opening = null; pending = null;
        if (from === "rail") { held = null; set([key]); } else set(keepHeld([...open.filter((k) => rank(k) < rank(key)), key]));
      }, openMs);
    },
    stay() { inside = true; stopClosing(); stopOpening(); },
    leave() { inside = false; stopOpening(); closeSoon(); },
    show(key) { stopOpening(); stopClosing(); held = null; set([key]); },
    hold(key) {
      held = key;
      if (key === null && !inside && open.length) closeSoon();
    },
    drop(key) {
      if (pending === key) stopOpening();
      if (held === key) held = null;
      set(open.filter((k) => k !== key));
    },
    clear() { stopOpening(); stopClosing(); held = null; set([]); },
    dispose() { stopOpening(); stopClosing(); },
  };
}

/** Whether a click on a group's head leaves it open. A mouse click on a group the pointer opened pins it (it stays when
 *  the pointer leaves); any other click (a tap, Enter or Space, a mouse on a pinned or folded group) turns it over, as
 *  before hover existed. `byPointer`: the click came from a pointer (event.detail > 0), not the keyboard. */
export const clickOpens = (isOpen: boolean, peeked: boolean, byPointer: boolean) => peeked && byPointer ? true : !isOpen;

/** A group's head: Enter and Space are its own click (open or fold). → and ↓ open a folded group, and move into an
 *  open one (its first page); ← folds an open one. */
export function headKey(key: string, open: boolean): "open" | "first" | "close" | null {
  if (key === "ArrowRight" || key === "ArrowDown") return open ? "first" : "open";
  if (key === "ArrowLeft") return open ? "close" : null;
  return null;
}
/** A page inside a group or a flyout: ↓ ↑ move between its pages, ← goes back to its head (the rail icon for a
 *  flyout), Escape closes a flyout. */
export function itemKey(key: string, inFlyout: boolean): "next" | "prev" | "head" | null {
  if (key === "ArrowDown") return "next";
  if (key === "ArrowUp") return "prev";
  if (key === "ArrowLeft" || (inFlyout && key === "Escape")) return "head";
  return null;
}
/** A rail icon while the sidebar is folded: Enter opens its page as before; →, ↓ or Space shows its group's pages
 *  beside it, focus on the first. */
export const railKey = (key: string) => key === "ArrowRight" || key === "ArrowDown" || key === " " ? "open" as const : null;
