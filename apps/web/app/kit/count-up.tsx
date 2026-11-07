"use client";
// UX-POLISH-2 (owner, 6 Nov 2026: "fun, animated, top-notch"): a figure counts up to its value the first time it comes
// into view, once, in about 0.7 s. It takes the text the page already wrote ("18", "₹8,30,000", "92%", "4.5 h"), keeps
// everything around the number, and counts the number in the same grouping (Indian, as the page wrote it). The server
// renders the final text, so a page without script, a screen reader and a screenshot always read the real value; under
// prefers-reduced-motion nothing moves. Pattern after the number tickers of Magic UI and Aceternity (MIT); no code taken.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

const useLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;
const PARTS = /^([^\d-]*)(-?[\d,]*\d(?:\.\d+)?)([\s\S]*)$/;

/** The text split around its first number, or null when there is no number worth counting. */
export function numberParts(text: string): { before: string; value: number; decimals: number; grouped: boolean; after: string } | null {
  const m = PARTS.exec(text); if (!m) return null;
  const raw = m[2]; const value = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(value) || Math.abs(value) < 2) return null;
  return { before: m[1], value, decimals: raw.includes(".") ? raw.split(".")[1].length : 0, grouped: raw.includes(","), after: m[3] };
}
const shown = (n: number, p: NonNullable<ReturnType<typeof numberParts>>) =>
  `${p.before}${p.grouped ? n.toLocaleString("en-IN", { minimumFractionDigits: p.decimals, maximumFractionDigits: p.decimals }) : n.toFixed(p.decimals)}${p.after}`;

export function CountUp({ text, duration = 700 }: { text: string; duration?: number }) {
  const el = useRef<HTMLSpanElement>(null);
  // UX-POLISH-3: once it has counted, a new value (a live total while typing) rolls from the last one in 0.4 s.
  const last = useRef<number | null>(null);
  useLayout(() => {
    const node = el.current; const p = numberParts(text);
    if (!node || !p || typeof IntersectionObserver === "undefined" || matchMedia("(prefers-reduced-motion: reduce)").matches) { last.current = p?.value ?? null; return; }
    let frame = 0; let started = false;
    const from = last.current ?? 0, span = last.current === null ? duration : 400;
    node.textContent = shown(from, p);
    const run = () => {
      const t0 = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / span); const eased = 1 - Math.pow(1 - k, 3);
        node.textContent = k < 1 ? shown(Number((from + (p.value - from) * eased).toFixed(p.decimals)), p) : text;
        if (k < 1) frame = requestAnimationFrame(step); else last.current = p.value;
      };
      frame = requestAnimationFrame(step);
    };
    if (last.current !== null) { run(); return () => { cancelAnimationFrame(frame); node.textContent = text; last.current = p.value; }; }
    const seen = new IntersectionObserver((entries) => { if (!started && entries.some((e) => e.isIntersecting)) { started = true; seen.disconnect(); run(); } });
    seen.observe(node);
    return () => { seen.disconnect(); cancelAnimationFrame(frame); node.textContent = text; if (started) last.current = p.value; };
  }, [text, duration]);
  // The accessible name is always the final value; the counting text is decoration.
  return <span ref={el} aria-label={text} data-count-up="">{text}</span>;
}

/** A value as the page passed it: numbers and plain text count up, anything else shows as it is. */
export function Counted({ value }: { value: unknown }) {
  if (typeof value === "number") return <CountUp text={value.toLocaleString("en-IN")} />;
  if (typeof value === "string") return <CountUp text={value} />;
  return <>{value as ReactNode}</>;
}
