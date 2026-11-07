// DROPDOWNS (4 Nov 2026): one behaviour for every hand-made dropdown menu in Pulse (the account menu, the organisation
// switcher, Pip's menu, page menus: a button with aria-haspopup="menu" or aria-expanded and a role="menu" box), without each one
// carrying its own code. Installed once by the shell; it only acts where the menu itself did not handle the key.
//  - Keyboard: ↓ or ↑ on the closed button opens the menu at its first or last item; inside it ↓ ↑ move (wrapping),
//    Home and End reach the ends, a letter jumps to the next item starting with it, Escape closes it and gives focus
//    back to the button, Tab closes it.
//  - Size: an open menu never runs past the window; it gets a max-height and scrolls inside.
//  - Scrolling: a wheel or a finger over the menu scrolls the menu only, never the page behind it.
// The kit's own Menu, Select and Combobox (apps/web/app/kit) handle their keys themselves (this then sees them handled)
// and size and scroll their floating layer (data-layer), which this never resizes.

const ITEMS = '[role^="menuitem"]:not([aria-disabled="true"]):not(:disabled), [role="menu"] a[href]:not([role]), [role="menu"] button:not([role]):not(:disabled)';
const TRIGGER = 'button[aria-haspopup="menu"], [role="button"][aria-haspopup="menu"]';
/** Also the plain buttons with aria-expanded that open a role="menu" next to them (Escape, Tab, size, scrolling). */
const ANY_TRIGGER = `${TRIGGER}, button[aria-expanded]`;

const shown = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
const own = (el: Element) => !el.closest("[data-layer]");

/** The open menu a trigger controls: by aria-controls, else the first visible menu next to it. */
function menuOf(trigger: Element): HTMLElement | null {
  const id = trigger.getAttribute("aria-controls");
  const byId = id ? document.getElementById(id) : null;
  if (byId) return byId.matches('[role="menu"]') ? byId : byId.querySelector<HTMLElement>('[role="menu"]') ?? byId;
  for (let n: Element | null = trigger.parentElement, depth = 0; n && depth < 3; n = n.parentElement, depth++) {
    const m = [...n.querySelectorAll<HTMLElement>('[role="menu"]')].find((x) => shown(x) && !x.contains(trigger));
    if (m) return m;
  }
  return null;
}
function triggerOf(menu: Element): HTMLElement | null {
  if (menu.id) { const t = document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`); if (t) return t; }
  for (let n: Element | null = menu.parentElement, depth = 0; n && depth < 3; n = n.parentElement, depth++) {
    const t = [...n.querySelectorAll<HTMLElement>(ANY_TRIGGER)].find((x) => x.getAttribute("aria-expanded") === "true" && !menu.contains(x));
    if (t) return t;
  }
  return null;
}
const items = (menu: Element) => [...menu.querySelectorAll<HTMLElement>(ITEMS)].filter((x) => shown(x) && x.closest('[role="menu"]') === menu.closest('[role="menu"]'));
const label = (el: HTMLElement) => (el.dataset.text ?? el.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Gives an open menu a height that fits the window and keeps wheel and touch scrolling inside it. */
export function fitMenu(menu: HTMLElement) {
  const box = menu.matches('[role="menu"]') ? menu : menu.querySelector<HTMLElement>('[role="menu"]') ?? menu;
  const r = box.getBoundingClientRect(), vh = window.visualViewport?.height ?? innerHeight, pad = 8;
  if (r.bottom > vh - pad || r.top < pad) {
    const room = Math.max(120, r.bottom > vh - pad ? vh - pad - Math.max(pad, r.top) : r.bottom - pad);
    if (box.scrollHeight > room) { box.style.maxHeight = `${Math.floor(room)}px`; box.style.overflowY = "auto"; }
  }
  if (box.dataset.contained) return;
  box.dataset.contained = "";
  box.style.overscrollBehavior = "contain";
  const scroller = (from: EventTarget | null) => {
    for (let n = from instanceof Element ? from : null; n && box.contains(n); n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1) return n as HTMLElement;
      if (n === box) break;
    }
    return null;
  };
  const blocked = (target: EventTarget | null, dy: number) => {
    if (!dy) return false;
    const s = scroller(target); if (!s) return true;
    return dy < 0 ? s.scrollTop <= 0 : s.scrollTop + s.clientHeight >= s.scrollHeight - 1;
  };
  box.addEventListener("wheel", (e) => { if (!e.ctrlKey && Math.abs(e.deltaY) >= Math.abs(e.deltaX) && blocked(e.target, e.deltaY)) e.preventDefault(); }, { passive: false });
  let y = 0;
  box.addEventListener("touchstart", (e) => { y = e.touches[0]?.clientY ?? 0; }, { passive: true });
  box.addEventListener("touchmove", (e) => { const now = e.touches[0]?.clientY ?? y, dy = y - now; y = now; if (e.cancelable && blocked(e.target, dy)) e.preventDefault(); }, { passive: false });
}

/** Installs the behaviour on the document; returns the uninstall. */
export function installMenuKeys() {
  const afterOpen = (trigger: HTMLElement, then?: (menu: HTMLElement) => void) => {
    let tries = 0;
    const look = () => {
      const m = trigger.getAttribute("aria-expanded") === "true" ? menuOf(trigger) : null;
      if (m) { if (own(m)) fitMenu(m); then?.(m); return; }
      if (++tries < 6) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  };
  const keydown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const at = document.activeElement as HTMLElement | null; if (!at) return;
    const trigger = at.closest<HTMLElement>(TRIGGER);
    if (trigger && own(trigger) && !trigger.closest('[role="menu"]')) {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const open = trigger.getAttribute("aria-expanded") === "true";
      e.preventDefault();
      const focusEnd = (m: HTMLElement) => { const list = items(m); (e.key === "ArrowDown" ? list[0] : list.at(-1))?.focus(); };
      if (!open) { trigger.click(); afterOpen(trigger, focusEnd); }
      else { const m = menuOf(trigger); if (m) focusEnd(m); }
      return;
    }
    const menu = at.closest<HTMLElement>('[role="menu"]');
    if (!menu) return;
    const list = items(menu); if (!list.length) return;
    const i = list.indexOf(at.closest<HTMLElement>(ITEMS) ?? at);
    const go = (k: number) => { e.preventDefault(); list[(k + list.length) % list.length]?.focus(); };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? -1 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else if (e.key === "Escape" || e.key === "Tab") {
      // Closed through its own button, a frame later, only if the menu's own code did not close it already.
      const t = triggerOf(menu); if (!t) return;
      if (e.key === "Escape") e.preventDefault();
      requestAnimationFrame(() => { if (t.getAttribute("aria-expanded") === "true") t.click(); if (e.key === "Escape") t.focus({ preventScroll: true }); });
    } else if (e.key.length === 1 && /\S/.test(e.key) && !(at instanceof HTMLInputElement || at instanceof HTMLTextAreaElement)) {
      const k = e.key.toLowerCase(), order = [...list.slice(i + 1), ...list.slice(0, i + 1)];
      const next = order.find((x) => label(x).startsWith(k)); if (next) { e.preventDefault(); next.focus(); }
    }
  };
  // A menu opened with the pointer is fitted to the window and keeps its scrolling to itself too.
  const click = (e: MouseEvent) => {
    const t = (e.target as Element | null)?.closest?.<HTMLElement>(ANY_TRIGGER);
    if (t && own(t)) afterOpen(t);
  };
  document.addEventListener("keydown", keydown);
  document.addEventListener("click", click);
  return () => { document.removeEventListener("keydown", keydown); document.removeEventListener("click", click); };
}
