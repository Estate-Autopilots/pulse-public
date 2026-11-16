"use client";
// BUGKIT-TELEMETRY (owner, 6 Nov 2026): "an element picker: hover to highlight, click to select, Shift-click selects
// multiple". A step of the reporter: the reporter steps aside, the page stays as it was (nothing on it reacts to the
// clicks), the element under the pointer is outlined, a click picks it (Shift-click adds or removes more; on a touch
// screen every tap adds or removes) and Done goes back to the report with each picked element's selector, component,
// box and label (lib/friction.mjs describeElement: never a typed value). Escape cancels, Enter is Done.
import { Check, Crosshair, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { describeElement, type PickedElement } from "../lib/friction.mjs";
import styles from "./picker.module.css";

type Picked = { el: Element | null; info: PickedElement };
const PICKER = "data-bug-picker";
const BLOCKED = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "touchstart", "touchend"] as const;

const ownUi = (t: EventTarget | null) => t instanceof Element && !!t.closest(`[${PICKER}]`);
const rectOf = (el: Element | null, info?: PickedElement) => {
  if (el?.isConnected) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
  return info ? { x: info.box.x, y: info.box.y - (window.scrollY - info.sy), w: info.box.w, h: info.box.h } : null;
};

export function ElementPicker({ initial, onDone, onCancel }: { initial: readonly PickedElement[]; onDone: (picked: PickedElement[]) => void; onCancel: () => void }) {
  const [picked, setPicked] = useState<Picked[]>(() => initial.map((info) => {
    let el: Element | null = null;
    try { el = info.sel ? document.querySelector(info.sel) : null; } catch { el = null; }
    return { el, info };
  }));
  const [hover, setHover] = useState<Element | null>(null);
  const [, redraw] = useState(0);
  const latest = useRef(picked);
  useLayoutEffect(() => { latest.current = picked; }, [picked]);
  const coarse = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

  useEffect(() => {
    const at = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y);
      return el && !ownUi(el) && el !== document.documentElement && el !== document.body ? el : null;
    };
    const move = (e: PointerEvent) => { if (!ownUi(e.target)) setHover(at(e.clientX, e.clientY)); };
    const block = (e: Event) => {
      if (ownUi(e.target)) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (e.type !== "click") return;
      const m = e as MouseEvent;
      const el = at(m.clientX, m.clientY);
      if (!el) return;
      const info = describeElement(el, window);
      const has = latest.current.findIndex((p) => p.el === el);
      if (m.shiftKey || m.metaKey || m.ctrlKey || coarse) {
        setPicked((list) => (has >= 0 ? list.filter((_, i) => i !== has) : [...list, { el, info }].slice(0, 12)));
      } else setPicked(has >= 0 && latest.current.length === 1 ? [] : [{ el, info }]);
    };
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); }
      else if (e.key === "Enter" && !ownUi(e.target)) { e.preventDefault(); e.stopPropagation(); onDone(latest.current.map((p) => p.info)); }
    };
    const tick = () => redraw((n) => n + 1);
    window.addEventListener("pointermove", move, true);
    for (const t of BLOCKED) window.addEventListener(t, block, { capture: true, passive: false });
    window.addEventListener("keydown", keys, true);
    window.addEventListener("scroll", tick, true);
    window.addEventListener("resize", tick);
    document.documentElement.dataset.picking = "";
    return () => {
      window.removeEventListener("pointermove", move, true);
      for (const t of BLOCKED) window.removeEventListener(t, block, { capture: true });
      window.removeEventListener("keydown", keys, true);
      window.removeEventListener("scroll", tick, true);
      window.removeEventListener("resize", tick);
      delete document.documentElement.dataset.picking;
    };
  }, [coarse, onCancel, onDone]);

  const hoverBox = hover && !picked.some((p) => p.el === hover) ? rectOf(hover) : null;
  const hoverLabel = hover ? describeElement(hover, window) : null;
  return createPortal(<div {...{ [PICKER]: "" }} data-capture-skip="" className={styles.layer}>
    {hoverBox ? <div className={styles.hover} style={{ left: hoverBox.x, top: hoverBox.y, width: hoverBox.w, height: hoverBox.h }}>
      <span className={styles.tag}>{hoverLabel?.component ? `${hoverLabel.component} · ` : ""}{hoverLabel?.label}</span></div> : null}
    {picked.map((p, i) => { const r = rectOf(p.el, p.info); return r ? <div key={i} className={styles.picked} style={{ left: r.x, top: r.y, width: r.w, height: r.h }} data-testid="picked-element">
      <span className={styles.badge}>{i + 1}</span></div> : null; })}
    <div className={styles.bar} role="toolbar" aria-label="Pick what is wrong">
      <Crosshair size={16} aria-hidden="true" />
      <span className={styles.hint}>{coarse ? "Tap what’s wrong. Tap more to add them." : "Click what’s wrong. Shift-click to pick more."} <b>{picked.length ? `${picked.length} picked` : "None picked yet"}</b></span>
      <button type="button" className={styles.cancel} onClick={onCancel}><X size={14} aria-hidden="true" />Cancel</button>
      <button type="button" className={styles.done} onClick={() => onDone(picked.map((p) => p.info))}><Check size={14} aria-hidden="true" />Done</button>
    </div>
  </div>, document.body);
}
