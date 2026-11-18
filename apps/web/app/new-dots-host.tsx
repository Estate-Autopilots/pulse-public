"use client";
// NEW-DOTS (owner, 8 Nov 2026: "Wherever a new update comes, inside the app there should be a red, attention-grabbing
// indicator … You go and check what's there, and then it goes away."). Reads the person's unseen changes
// (GET /api/v0/whats-new/unseen: only pages they can open), tells the shell where to put red dots (NEW_DOTS_EVENT), and
// when they open one of those pages, records it on the server (POST …/seen, so every device forgets it too) and shows a
// one-line "New: …" pill near the top, once. The shell's dots then shrink away. The What's new page and the switch in
// Settings → Notifications send NEW_DOTS_REFRESH with the new list.
// NEW-DOTS-2 (owner, 10 Nov 2026: "alert me at the top level first, then take me deeper … take me straight to where I
// should click"): a change can name the very thing on its page (its `anchor`). Opening the page clears the dots on the
// way there; the page then shows the dots that lead on (new-trail.tsx) until the thing is reached. A click on an entry
// with a dot (or What's new's Show me) is "take me there": the page it opens starts the spotlight tour by itself. The pill
// offers Show me too.
import { NEW_DOTS_EVENT, visitClears } from "@pulse/ui-shell";
import { ArrowRight, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import registryJson from "./lib/new-anchors.json";
import { NEW_DOTS_REFRESH, type NewDotsItem, type NewDotsState } from "./lib/new-dots.mjs";
import { dotDestination, pathOf, shellDetail, shortOf, stepsOn, travelFrom, TRAVEL_KEY, type AnchorRegistry, type Step } from "./lib/new-trail.mjs";
import css from "./new-dots.module.css";
import { NEW_DOTS_SHOW, NewTrail } from "./new-trail";
import { NewPath } from "./new-path";

const registry = registryJson as AnchorRegistry;
const PILL_MS = 12_000;
/** A line that offers Show me stays until it is closed or the person moves on: it is the way to this page's new things. */
const PILL_SHOW_MS = 0;
const LEAVE_MS = 220;

function tellShell(s: NewDotsState) {
  const detail = shellDetail(s);
  (window as unknown as { __pulseNewDots?: unknown }).__pulseNewDots = detail;
  window.dispatchEvent(new CustomEvent(NEW_DOTS_EVENT, { detail }));
}

/** The pill sits in the top bar's row (chrome, so it covers none of the page): the middle of the bar on a wide window. */
function barPlace(): CSSProperties {
  const bar = document.querySelector("[data-shell-topbar]")?.getBoundingClientRect();
  return bar && bar.height > 0 ? { "--pill-x": `${Math.round(bar.left + bar.width / 2)}px`, "--pill-y": `${Math.round(bar.top + bar.height / 2)}px` } as CSSProperties : {};
}

const isState = (x: unknown): x is NewDotsState => !!x && typeof x === "object" && Array.isArray((x as NewDotsState).items) && typeof (x as NewDotsState).on === "boolean";

/** "Take me there": remembered for a short while in this tab, so the page it opens carries on to the thing. */
export function travelTo(route: string, anchor = "") {
  try { sessionStorage.setItem(TRAVEL_KEY, JSON.stringify({ route: pathOf(route), anchor, at: Date.now() })); } catch { /* private mode: no tour, the dots still lead */ }
}
function takeTravel(path: string) {
  try {
    const t = travelFrom(JSON.parse(sessionStorage.getItem(TRAVEL_KEY) ?? "null"));
    if (!t || t.route !== pathOf(path)) return null;
    sessionStorage.removeItem(TRAVEL_KEY);
    return t;
  } catch { return null; }
}

export function NewDotsHost() {
  const pathname = usePathname();
  const [state, setState] = useState<NewDotsState | null>(null);
  const [pill, setPill] = useState<{ items: NewDotsItem[]; path: string; place: CSSProperties; ms: number } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [auto, setAuto] = useState<{ anchor: string; n: number; path: string } | null>(null);
  const posting = useRef<string | null>(null);
  const apply = useCallback((s: NewDotsState) => { setState(s); tellShell(s); }, []);
  const read = useCallback(async () => {
    try { const r = await fetch("/api/v0/whats-new/unseen", { cache: "no-store" }); if (r.ok) { const s: unknown = await r.json(); if (isState(s)) apply(s); } } catch { /* offline: keep what we have */ }
  }, [apply]);

  useEffect(() => {
    const first = window.setTimeout(() => void read(), 0);
    const every = window.setInterval(() => void read(), 10 * 60_000);
    const back = () => { if (document.visibilityState === "visible") void read(); };
    const refresh = (event: Event) => { const d = (event as CustomEvent).detail; if (isState(d)) apply(d); else void read(); };
    document.addEventListener("visibilitychange", back);
    window.addEventListener(NEW_DOTS_REFRESH, refresh);
    return () => { window.clearTimeout(first); window.clearInterval(every); document.removeEventListener("visibilitychange", back); window.removeEventListener(NEW_DOTS_REFRESH, refresh); };
  }, [read, apply]);

  // A click on an entry with a red dot (the rail, the panel, the phone's tabs, the More sheet) is "take me there". An
  // entry lit only by a page inside it opens that page (HR-PEOPLE: Team's dot opened Team while the change was in
  // People & pay).
  const router = useRouter();
  const itemsNow = useRef<NewDotsItem[]>([]);
  useEffect(() => { itemsNow.current = state?.on ? state.items : []; }, [state]);
  useEffect(() => {
    const clicked = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      const href = a?.getAttribute("href");
      if (!href?.startsWith("/") || !a?.querySelector("[data-new-dot]:not([data-leaving])")) return;
      const there = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0 ? null : dotDestination(href, itemsNow.current);
      if (!there) { travelTo(href); return; }
      e.preventDefault(); e.stopPropagation();
      travelTo(there);
      router.push(there);
    };
    document.addEventListener("click", clicked, true);
    return () => document.removeEventListener("click", clicked, true);
  }, [router]);

  // Arriving through "take me there": the trail starts the tour on this page once its things are known.
  useEffect(() => {
    if (!pathname) return;
    const t = window.setTimeout(() => { const travel = takeTravel(pathname); if (travel) setAuto({ anchor: travel.anchor, n: travel.at, path: pathname }); }, 0);
    return () => window.clearTimeout(t);
  }, [pathname]);

  // Opening a changed page clears it (on the server); the first visit says what changed.
  useEffect(() => {
    if (!state || !pathname || posting.current === pathname) return;
    if (!state.items.some((i) => !i.opened && visitClears(pathname, i.route))) return;
    posting.current = pathname;
    void (async () => {
      try {
        const r = await fetch("/api/v0/whats-new/seen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: pathname }) });
        if (!r.ok) return;
        const s: unknown = await r.json();
        if (!isState(s)) return;
        apply(s);
        const cleared = (s as NewDotsState & { cleared?: NewDotsItem[] }).cleared ?? [];
        if (s.on && cleared.length) { setLeaving(false); setPill({ items: cleared, path: pathname, place: barPlace(), ms: stepsOn(s.items, pathname, registry).length ? PILL_SHOW_MS : PILL_MS }); }
      } catch { /* try again on the next visit */ } finally { posting.current = null; }
    })();
  }, [pathname, state, apply]);

  // Reaching a thing (the spotlight's Got it or Next, or using it) clears it on the server.
  const reach = useCallback((step: Step) => {
    void (async () => {
      try {
        const r = await fetch("/api/v0/whats-new/seen", { method: "POST", headers: { "content-type": "application/json" }, keepalive: true,
          body: JSON.stringify({ path: step.route, anchor: step.anchor }) });
        const s: unknown = r.ok ? await r.json() : null;
        if (isState(s)) apply(s); else void read();
      } catch { void read(); }
    })();
  }, [apply, read]);

  const close = useCallback(() => { setLeaving(true); window.setTimeout(() => { setPill(null); setLeaving(false); }, LEAVE_MS); }, []);
  // The pill goes when the person moves on (it belongs to the page it was shown on), closes it, or after a while; it
  // never comes back for that change.
  useEffect(() => { if (!pill || !pill.ms) return; const t = window.setTimeout(close, pill.ms); return () => window.clearTimeout(t); }, [pill, close]);

  const steps = state?.on ? stepsOn(state.items, pathname ?? "", registry) : [];
  const touring = !!auto && auto.path === pathname && steps.length > 0;
  // HR-PEOPLE (13 Nov) lit the page's title for a moment when a change named no thing on its page. NAV-CONNECT (owner,
  // 17 Nov 2026: "highlights the wrong thing, just one thing at the top"): no more. The "New: …" line says what changed,
  // and What's new's Show me leads the way step by step (new-path.tsx), ending on the page as a whole when that is all
  // the release says.
  const trail = state && pathname ? <><NewTrail items={state.items} path={pathname} on={state.on} autoStart={touring ? auto : null} onReach={reach} /><NewPath /></> : <NewPath />;
  // On a tour (arrived through a dot), the spotlight's card says it: no pill, then or after it. A thing already reached
  // (Got it, or used) leaves the pill too; a change to the page as a whole was seen on arriving, so it stays listed.
  const toured = touring;
  const still = (pill?.items ?? []).filter((i) => !i.anchor || (state?.items ?? []).some((x) => x.note === i.note && x.route === i.route && x.anchor === i.anchor));
  if (!pill || pill.path !== pathname || toured || !still.length) return trail;
  const [first, ...rest] = still;
  return <>
    {trail}
    <div className={css.pill} style={pill.place} role="status" aria-live="polite" data-leaving={leaving ? "" : undefined} data-new-pill="" data-show={steps.length ? "" : undefined}>
      <i className={css.dot} aria-hidden="true" />
      <span className={css.text} title={first.text}><b>New:</b> {first.text}</span>
      {/* A phone's top bar has room for a few words: the first new thing's name (and how many more), then Show me. */}
      {/* A phone: the change's short title (its first words, up to two lines), then the round Show me. */}
      {steps.length ? <span className={css.short}><b>New:</b> {shortOf(first.text)}</span> : null}
      {steps.length ? <button type="button" className={css.show} aria-label="Show me" onClick={() => { close(); window.dispatchEvent(new CustomEvent(NEW_DOTS_SHOW, { detail: { anchor: first.anchor } })); }}>
        <span className={css.showWord}>Show me{steps.length > 1 ? ` (${steps.length})` : ""}</span><ArrowRight size={15} aria-hidden="true" /></button>
        : rest.length ? <Link href="/whats-new" className={css.more}>+{rest.length} more</Link> : null}
      <button type="button" className={css.close} aria-label="Dismiss" onClick={close}><X size={14} aria-hidden="true" /></button>
    </div>
  </>;
}
