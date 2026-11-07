"use client";
// CHAT-V6: a long conversation draws only what is near the screen. Every message keeps a measured height (a guess until
// it has been drawn once); spacers above and below stand in for the rest, so the scroll bar is the whole conversation
// and a conversation of 5,000 messages draws a few dozen bubbles. Scrolling keeps its place itself (the browser's own
// scroll anchoring is off: Safari has none, and it fought the spacers): the message at the top of the screen stays
// where it is when pages load above it, pictures load, or guesses become measurements. At the bottom it stays at the
// bottom. Short conversations (up to 80 messages) are drawn whole, as before; the same place-keeping applies.
// The measuring lives in a small object outside React's state (it changes on every scroll frame); React is asked to
// draw again only when the drawn range or the spacers change.
import { useLayoutEffect, useReducer, useState, type RefObject } from "react";

const ALL_UP_TO = 80, ESTIMATE = 72, OVERSCAN = 1000;
type Block = "start" | "center" | "end";
/** Where a drawn element sits in the list's content (not on screen: scrolling does not change it). */
const pos = (box: HTMLElement, el: HTMLElement) => el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
const slots = (box: HTMLElement) => box.querySelectorAll<HTMLElement>(":scope > [data-vk]");
/** The message itself inside its slot (a day chip or the unread line above it can come and go). */
const mark = (s: HTMLElement) => s.querySelector<HTMLElement>("[id^='m-']") ?? s;
const slot = (box: HTMLElement, key: string) => box.querySelector<HTMLElement>(`:scope > [data-vk="${CSS.escape(key)}"]`);

export type VirtualLog = { start: number; end: number; padTop: number; padBottom: number; virtual: boolean;
  /** Bring the message with this key into view (drawn first if it is far away). */ scrollTo: (key: string, block?: Block, offset?: number) => void;
  /** Call from the list's scroll handler (once per frame). */ onScroll: () => void };

class Log {
  heights = new Map<string, number>(); keys: string[] = []; index = new Map<string, number>(); offsets = new Float64Array(1);
  view = { top: 0, height: 800 }; base = 0; anchor: { key: string; top: number } | null = null;
  target: { key: string; block: Block; offset: number; tries: number } | null = null; loops = 0;
  range = { start: 0, end: 0 };
  constructor(public box: RefObject<HTMLDivElement | null>, public stick: RefObject<boolean>, public redraw: () => void) {}
  get virtual() { return this.keys.length > ALL_UP_TO; }
  setKeys(keys: string[]) {
    if (keys === this.keys) return;
    // Messages went in above (an earlier page) or below: the view moves with the message it was holding, so that
    // message is drawn again and the place can be kept exactly after drawing.
    const a = this.anchor, was = a ? this.index.get(a.key) : undefined, wasAt = was !== undefined ? this.offsets[was] : 0;
    this.keys = keys; this.index = new Map(keys.map((k, i) => [k, i])); this.sums();
    const now = a ? this.index.get(a.key) : undefined;
    if (was !== undefined && now !== undefined) this.view = { ...this.view, top: this.view.top + this.offsets[now] - wasAt };
    this.pick();
  }
  sums() { const n = this.keys.length, o = new Float64Array(n + 1); for (let i = 0; i < n; i++) o[i + 1] = o[i] + (this.heights.get(this.keys[i]) ?? ESTIMATE); this.offsets = o; }
  at(y: number) { const o = this.offsets, n = this.keys.length; let lo = 0, hi = n; while (lo < hi) { const mid = (lo + hi) >> 1; if (o[mid + 1] <= y) lo = mid + 1; else hi = mid; } return Math.min(lo, Math.max(0, n - 1)); }
  /** The range to draw for where the list is (or is going). Returns whether it changed. */
  pick() {
    const n = this.keys.length, o = this.offsets, h = this.view.height; let start = 0, end = n;
    if (this.virtual) {
      const want = this.target ? this.index.get(this.target.key) : undefined;
      if (want !== undefined) { start = this.at(o[want] - OVERSCAN - h); end = Math.min(n, this.at(o[want] + OVERSCAN + h) + 1); }
      else if (this.stick.current) start = this.at(o[n] - h - OVERSCAN);
      else { const top = this.view.top - this.base; start = this.at(top - OVERSCAN); end = Math.min(n, this.at(top + h + OVERSCAN) + 1); }
    }
    const changed = start !== this.range.start || end !== this.range.end; this.range = { start, end }; return changed;
  }
  snapshot() { const { start, end } = this.range, o = this.offsets, n = this.keys.length; return { start, end, padTop: o[start] ?? 0, padBottom: (o[n] ?? 0) - (o[end] ?? 0), virtual: this.virtual }; }
  capture() {
    const el = this.box.current; if (!el) return; const top = el.getBoundingClientRect().top;
    for (const s of slots(el)) { if (s.getBoundingClientRect().bottom > top + 1) { this.anchor = { key: s.dataset.vk!, top: pos(el, mark(s)) }; return; } }
    this.anchor = null;
  }
  measure() {
    const el = this.box.current; if (!el) return false; let changed = false;
    for (const s of slots(el)) { const h = s.offsetHeight, k = s.dataset.vk!; if (h > 0 && Math.abs((this.heights.get(k) ?? -1) - h) >= 1) { this.heights.set(k, h); changed = true; } }
    const spacer = el.querySelector<HTMLElement>(":scope > [data-vtop]"); this.base = spacer ? pos(el, spacer) : 0;
    if (changed) this.sums();
    return changed;
  }
  /** Keep the place: go to the target, stay at the bottom, or hold the message that was at the top of the screen. */
  place() {
    const el = this.box.current; if (!el) return;
    const t = this.target;
    if (t) {
      const s = slot(el, t.key);
      if (s) {
        const y = pos(el, s), h = s.offsetHeight;
        el.scrollTop = t.block === "start" ? y + t.offset : t.block === "end" ? y + h - el.clientHeight + t.offset : y + h / 2 - el.clientHeight / 2 + t.offset;
        if (++t.tries >= 3) this.target = null;
      } else { const i = this.index.get(t.key); if (i === undefined) this.target = null; else el.scrollTop = this.base + this.offsets[i] - el.clientHeight / 2; }
      return;
    }
    if (this.stick.current) { el.scrollTop = el.scrollHeight; return; }
    const a = this.anchor, s = a && slot(el, a.key);
    if (a && s) { const now = pos(el, mark(s)), d = now - a.top; if (Math.abs(d) >= 1) { el.scrollTop += d; a.top = now; } }
  }
  /** After React drew: measure, keep the place, and draw again when the spacers or the range moved. */
  settle() {
    const el = this.box.current; if (!el) return;
    const changed = this.measure(); this.place(); this.capture();
    this.view = { top: el.scrollTop, height: el.clientHeight || this.view.height };
    const moved = this.pick();
    if ((changed || moved || this.target) && this.loops < 6) { this.loops++; this.redraw(); } else this.loops = 0;
  }
  scroll() {
    const el = this.box.current; if (!el) return;
    this.view = { top: el.scrollTop, height: el.clientHeight }; this.capture();
    if (this.virtual && this.pick()) this.redraw();
  }
  go(key: string, block: Block, offset: number) { this.target = { key, block, offset, tries: 0 }; this.stick.current = false; this.loops = 0; this.pick(); this.redraw(); }
}

export function useVirtualLog(box: RefObject<HTMLDivElement | null>, keys: string[], stick: RefObject<boolean>): VirtualLog {
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  const [log] = useState(() => new Log(box, stick, redraw));
  log.setKeys(keys);
  // After every drawing: measure what is drawn and keep the place.
  useLayoutEffect(() => { log.settle(); });
  // A drawn message that changes size later (a picture loading, a link card, a poll's bars).
  useLayoutEffect(() => {
    const el = box.current; if (!el || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const ro = new ResizeObserver(() => { log.place(); if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (log.measure()) { log.pick(); redraw(); } log.capture(); }); });
    for (const s of slots(el)) ro.observe(s);
    return () => { ro.disconnect(); cancelAnimationFrame(frame); };
  });
  const [api] = useState(() => ({ scrollTo: (key: string, block: Block = "center", offset = 0) => log.go(key, block, offset), onScroll: () => log.scroll() }));
  return { ...log.snapshot(), ...api };
}
