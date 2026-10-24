"use client";
// TASKS-4A kit: Popover (a floating panel anchored to a control), Tooltip (a short label on hover, keyboard focus or a
// long press), HelpHint (the small "?" that explains something on tap instead of a paragraph on the page) and Keycap
// (a key drawn as a key: "Enter", "C", "⌘ K"). All of them sit on the floating layer (layer.tsx).
import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject } from "react";
import { CornerDownLeft } from "lucide-react";
import { Layer, useFloating, useFocusInside, useOutside, usePresence, type Placement } from "./layer";
import css from "./kit.module.css";

export type PopoverProps = {
  open: boolean; onClose: () => void; anchor: RefObject<HTMLElement | null>; children: ReactNode;
  /** The accessible name of the panel. */ label: string;
  role?: "dialog" | "listbox" | "menu" | "none"; placement?: Placement; matchWidth?: boolean; offset?: number; minRoom?: number;
  /** Where focus goes on open: the first control (default for dialogs), nothing (a listbox driven from its input), or a ref. */
  focus?: "first" | "none" | RefObject<HTMLElement | null>;
  id?: string; className?: string; style?: CSSProperties; tone?: "panel" | "bare";
  /** On phones (below 600 px), a sheet along the bottom with the page dimmed behind it. */ sheet?: boolean;
};

/** A panel under (or, without room, above) its anchor. Escape, a press outside, or Tab leaving it closes it. */
export function Popover({ open, onClose, anchor, children, label, role = "dialog", placement = "bottom-start", matchWidth, offset, minRoom, focus, id, className, style, tone = "panel", sheet }: PopoverProps) {
  const { mounted, closing } = usePresence(open);
  const box = useRef<HTMLDivElement>(null);
  useFloating(mounted, anchor, box, { placement, offset, matchWidth, minRoom, sheet });
  useOutside(open, [box, anchor], onClose);
  useFocusInside(open, box, focus ?? (role === "dialog" ? "first" : "none"));
  if (!mounted) return null;
  const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); anchor.current?.focus({ preventScroll: true }); } };
  const onBlur = (e: React.FocusEvent) => { const to = e.relatedTarget as Node | null; if (to && !box.current?.contains(to) && !anchor.current?.contains(to)) onClose(); };
  return <Layer ref={box} id={id} role={role === "none" ? undefined : role} aria-label={role === "none" ? undefined : label} aria-modal={role === "dialog" ? false : undefined}
    closing={closing} tone={tone} className={className} style={style} onKeyDown={onKeyDown} onBlur={onBlur}>{children}</Layer>;
}

/** Opening state for a popover with its anchor: `const p = usePopoverState(); <button ref={p.anchor} {...p.trigger} />`. */
export function usePopoverState(initial = false) {
  const [open, setOpen] = useState(initial);
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  return { open, setOpen, anchor, id, close: () => setOpen(false), toggle: () => setOpen((o) => !o),
    trigger: { "aria-expanded": open, "aria-controls": open ? id : undefined, onClick: () => setOpen((o) => !o) } };
}

// ------------------------------------------------------------------------------------------------------------ keycap
const mac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const noop = () => () => undefined;
/** True on Apple devices (⌘), false elsewhere (Ctrl); false while rendering on the server. */
export function useIsMac() { return useSyncExternalStore(noop, mac, () => false); }
const GLYPH: Record<string, string> = { Shift: "⇧", Alt: "⌥", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc", Backspace: "⌫", Tab: "Tab", Space: "Space" };
/** Keys drawn as keys. "Mod" is ⌘ on a Mac and Ctrl elsewhere; "Enter" carries the return arrow. Hidden on touch screens
 *  with `hideOnTouch`. */
export function Keycap({ keys, hideOnTouch, className }: { keys: string | string[]; hideOnTouch?: boolean; className?: string }) {
  const isMac = useIsMac();
  const list = (Array.isArray(keys) ? keys : [keys]).map((k) => k === "Mod" ? (isMac ? "⌘" : "Ctrl") : k);
  const spoken = list.map((k) => k === "⌘" ? "Command" : k).join(" ");
  return <kbd className={`${css.keycap}${className ? ` ${className}` : ""}`} data-hide-touch={hideOnTouch ? "" : undefined} aria-label={spoken}>
    {list.map((k, i) => <kbd key={`${k}${i}`} className={css.keycapKey} aria-hidden="true">{k === "Enter" ? <><CornerDownLeft size={11} strokeWidth={2.4} />Enter</> : GLYPH[k] ?? k}</kbd>)}
  </kbd>;
}
/** EST-1205: words that depend on the device: the keyboard's on a computer, a touch screen's on a phone or tablet
 *  (only one is shown, and read, at a time). */
export function ByDevice({ keys, touch }: { keys: ReactNode; touch: ReactNode }) {
  return <><span className={css.onKeys}>{keys}</span><span className={css.onTouch}>{touch}</span></>;
}
/** "↵ Enter to create": a keycap with what it does; hidden on touch screens, where there is no keyboard. */
export function KeyHint({ keys, children }: { keys: string | string[]; children: ReactNode }) {
  return <span className={css.keyHint}><Keycap keys={keys} />{children}</span>;
}

// ------------------------------------------------------------------------------------------------------------ tooltip
const tips = { hiddenAt: 0 };
type TipChild = ReactElement<Record<string, unknown>>;
/** A short label for the control it wraps. Shows after a short pause on hover (at once while another tip was just
 *  open), at once on keyboard focus and on a long press; hides on leave, blur, Escape or the next press. The text is
 *  also the control's description for screen readers (aria-describedby), whether shown or not. The listeners sit on a
 *  `display: contents` wrapper, so the control keeps its own props and layout. */
export function Tooltip({ content, shortcut, side = "top", delay = 450, children, disabled }: { content: ReactNode; shortcut?: string | string[]; side?: Placement; delay?: number; children: TipChild; disabled?: boolean }) {
  const id = useId(), tipId = `${id}-tip`;
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), pressed = useRef(false);
  const anchor = useCallback(() => typeof document === "undefined" ? null : document.querySelector<HTMLElement>(`[data-tip="${CSS.escape(id)}"]`), [id]);
  const { mounted, closing } = usePresence(open, 90);
  const box = useRef<HTMLDivElement>(null);
  useFloating(mounted, anchor, box, { placement: side, offset: 8, minRoom: 40 });
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const off = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const press = () => { if (pressed.current) { pressed.current = false; return; } setOpen(false); };
    document.addEventListener("keydown", off); document.addEventListener("pointerdown", press, true);
    return () => { document.removeEventListener("keydown", off); document.removeEventListener("pointerdown", press, true); tips.hiddenAt = Date.now(); };
  }, [open]);
  if (!isValidElement(children)) return children;
  const described = [(children.props as { "aria-describedby"?: string })["aria-describedby"], tipId].filter(Boolean).join(" ");
  return <>
    <span className={css.tipAnchor}
      onPointerEnter={(e) => { if (e.pointerType !== "mouse" || disabled) return; clearTimeout(timer.current); if (Date.now() - tips.hiddenAt < 600) setOpen(true); else timer.current = setTimeout(() => setOpen(true), delay); }}
      onPointerLeave={(e) => { if (e.pointerType === "mouse") { clearTimeout(timer.current); setOpen(false); } }}
      onPointerDown={(e) => { clearTimeout(timer.current); if (e.pointerType === "mouse") setOpen(false); else if (!disabled) timer.current = setTimeout(() => { pressed.current = true; setOpen(true); }, 480); }}
      onPointerUp={() => { if (!pressed.current) clearTimeout(timer.current); }} onPointerCancel={() => clearTimeout(timer.current)}
      onFocus={(e) => { if (!disabled && (e.target as HTMLElement).matches?.(":focus-visible")) { clearTimeout(timer.current); setOpen(true); } }}
      onBlur={() => { clearTimeout(timer.current); setOpen(false); }}>
      {cloneElement(children, { "data-tip": id, "aria-describedby": described })}
    </span>
    <span id={tipId} hidden>{typeof content === "string" ? content : null}{shortcut ? ` (${Array.isArray(shortcut) ? shortcut.join(" ") : shortcut})` : ""}</span>
    {mounted ? <Layer ref={box} tone="tip" closing={closing} aria-hidden="true">{shortcut ? <span className={css.tipRow}>{content}<Keycap keys={shortcut} /></span> : content}</Layer> : null}
  </>;
}

/** "?": what something means, on tap, click, hover or focus, instead of a paragraph on the page. */
export function HelpHint({ label, title, children, side = "top" }: { label: string; title?: string; children: ReactNode; side?: Placement }) {
  const [open, setOpen] = useState(false), [hover, setHover] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  const shown = open || hover;
  return <>
    <button ref={anchor} type="button" className={css.help} aria-label={label} aria-expanded={shown} aria-describedby={shown ? id : undefined}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); setHover(false); }}
      onPointerEnter={(e) => { if (e.pointerType === "mouse") setHover(true); }} onPointerLeave={(e) => { if (e.pointerType === "mouse") setHover(false); }}
      onBlur={() => { setOpen(false); setHover(false); }}>?</button>
    <Popover open={shown} onClose={() => { setOpen(false); setHover(false); }} anchor={anchor} label={label} role="none" placement={side} focus="none" minRoom={60}>
      <div id={id} className={css.helpBubble}>{title ? <b>{title}</b> : null}{children}</div>
    </Popover>
  </>;
}
