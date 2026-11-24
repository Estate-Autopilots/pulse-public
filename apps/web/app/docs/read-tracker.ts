"use client";
// DOCS-INTERACTIVE: reading receipts. While someone reads a doc that was sent to them, this measures how the doc was
// actually read, never what was typed or clicked:
//   * active time only: the tab is visible and there was a scroll, key, touch or pointer move in the last 30 s (the same
//     "active" rule as Pulse's telemetry, lib/telemetry.mjs nav.leave x.act);
//   * the doc is split at its headings; each second of active time goes to the section under the reading line (40 % down
//     the screen) and to any short section fully on screen;
//   * a section's views count each time it comes back on screen after 5 s away (re-reads);
//   * depth: the furthest point of the doc that reached the bottom of the screen.
// It reuses the telemetry pipeline's session id helper and its keepalive-then-beacon sending, but stores rows in its own
// table (doc_read) so only the reader, the doc's owner and the sender see them, never leadership's usage dashboards.
// The API turns the numbers into "Read 92 %, 6 min, skipped §4" (services/api/src/doc-interactive.ts).
import { useEffect } from "react";
import { randomId } from "../lib/telemetry.mjs";

const ACTIVE_MS = 30_000, TICK_MS = 1000, FLUSH_MS = 15_000, AWAY_MS = 5000;
type Section = { id: string; title: string; words: number; els: HTMLElement[]; i: number };
type Tally = { ms: number; n: number; seenAt: number; inView: boolean };

const words = (s: string) => (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);

/** The doc's sections: one per heading (h1–h3), plus the words before the first heading. */
export function sectionsOf(root: HTMLElement): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const el of Array.from(root.children) as HTMLElement[]) {
    if (/^H[1-3]$/.test(el.tagName)) {
      const title = (el.textContent ?? "").trim().slice(0, 80) || "Section";
      cur = { id: `s${out.length}-${slug(title)}`, title, words: 0, els: [el], i: out.length };
      out.push(cur);
    } else {
      if (!cur) { cur = { id: "s0-start", title: "Start", words: 0, els: [], i: 0 }; out.push(cur); }
      cur.els.push(el);
    }
    cur.words += words(el.textContent ?? "") + (el.getAttribute("data-type") === "pulse-block" ? 15 : 0);
  }
  return out.filter((s) => s.words > 0 || s.els.length > 1);
}

/** Measure reading of `docId` inside the element `rootOf()` returns, while `on`. */
export function useReadTracking(docId: string, rootOf: () => HTMLElement | null, on: boolean, version: number) {
  useEffect(() => {
    if (!on) return;
    const session = `dr-${randomId(12)}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
    let lastInput = Date.now(), lastTick = Date.now(), activeMs = 0, depth = 0, dirty = false;
    let sections: Section[] = [];
    const tally = new Map<string, Tally>();
    const refresh = () => {
      const pm = rootOf()?.querySelector<HTMLElement>(".ProseMirror") ?? rootOf();
      if (pm) sections = sectionsOf(pm);
    };
    refresh();
    const touched = () => { lastInput = Date.now(); };
    const opts = { passive: true, capture: true } as const;
    const kinds = ["scroll", "wheel", "keydown", "pointermove", "pointerdown", "touchstart"] as const;
    kinds.forEach((k) => window.addEventListener(k, touched, opts));

    const tick = () => {
      const now = Date.now(), dt = Math.min(2 * TICK_MS, now - lastTick);
      lastTick = now;
      const visible = document.visibilityState === "visible";
      const active = visible && now - lastInput < ACTIVE_MS;
      const root = rootOf();
      if (!root || !visible) { sections.forEach((s) => { const t = tally.get(s.id); if (t) t.inView = false; }); return; }
      const vh = window.innerHeight, line = vh * 0.4;
      const box = root.getBoundingClientRect();
      if (active) depth = Math.max(depth, Math.min(1, Math.max(0, (vh - box.top) / Math.max(1, box.height))));
      sections.forEach((s, i) => {
        if (!s.els.length) return;
        const top = s.els[0].getBoundingClientRect().top;
        const next = sections[i + 1]?.els[0];
        const bottom = next ? next.getBoundingClientRect().top : s.els[s.els.length - 1].getBoundingClientRect().bottom;
        const onScreen = bottom > vh * 0.1 && top < vh * 0.9;
        const t = tally.get(s.id) ?? { ms: 0, n: 0, seenAt: 0, inView: false };
        if (onScreen && active) {
          if (!t.inView && now - t.seenAt > AWAY_MS) t.n += 1;
          if ((top <= line && bottom > line) || (top >= 0 && bottom <= vh)) { t.ms += dt; dirty = true; }
          t.seenAt = now;
        }
        t.inView = onScreen;
        tally.set(s.id, t);
      });
      if (active) { activeMs += dt; dirty = true; }
    };
    const payload = () => JSON.stringify({ session, version, activeMs, depth: Math.round(depth * 1000) / 1000,
      sections: Object.fromEntries(sections.map((s) => { const t = tally.get(s.id); return [s.id, { t: s.title, w: s.words, ms: t?.ms ?? 0, n: t?.n ?? 0, i: s.i }]; })) });
    const url = `/api/v0/docs/${docId}/reads`;
    const flush = (final = false) => {
      if (!dirty) return;
      dirty = false;
      const body = payload();
      try {
        void fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true, cache: "no-store" }).catch(() => {
          if (final && navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
        });
      } catch { if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: "application/json" })); }
    };
    const t1 = window.setInterval(tick, TICK_MS), t2 = window.setInterval(() => flush(), FLUSH_MS), t3 = window.setInterval(refresh, 5000);
    const hide = () => { if (document.visibilityState === "hidden") flush(true); };
    const leave = () => flush(true);
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", leave);
    return () => {
      window.clearInterval(t1); window.clearInterval(t2); window.clearInterval(t3);
      kinds.forEach((k) => window.removeEventListener(k, touched, opts));
      document.removeEventListener("visibilitychange", hide); window.removeEventListener("pagehide", leave);
      flush(true);
    };
  }, [docId, rootOf, on, version]);
}
