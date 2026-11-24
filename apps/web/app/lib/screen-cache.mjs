// REPLAY-FIXES #1 (owner 20 Nov 2026, "make the flow work"; REPLAY-INSIGHTS top stuck point: 9 people, 15 times, a
// main screen took 3-10 s to change, median 5.8 s; Savuzo tapped Home and nothing moved for 3 s). Next shows a page it
// saw only for 30 s (staleTimes.dynamic) and every router.refresh() (each save, the data-changed poll) drops all of
// them, so most taps waited for the server with the old screen still up. The screen cache keeps, in this tab's memory
// only, what each screen last showed. A tap on a link to a screen seen before shows that copy at once, marked
// "Updating…"; the real page (always fetched fresh by Next, nothing about its data changes) replaces it in place as
// soon as it has drawn. A tap on the copy is not lost: a link opens at once, a button is kept and pressed on the real
// page once it is there (REPLAY-FIXES #2). The pure parts are here (screen-cache.test.mjs); the DOM side is
// app/screen-cache.tsx.

/** How many screens are kept, and for how long a copy may stand in for a screen (older copies are not shown). */
export const SCREEN_MAX = 8;
export const SCREEN_MAX_AGE_MS = 20 * 60_000;
/** A copy with more elements than this is not kept (copying it would itself slow the tap down). */
export const SCREEN_MAX_NODES = 9000;
/** The copy gives way after this long even if the real page never says it is ready (a failed or cancelled move). */
export const SCREEN_GIVE_UP_MS = 15_000;
/** Once the address is the tapped one, the copy stays at most this long, even if the real page is still loading a large
 *  part (a chart, a long list): the real page is fresher. */
export const SCREEN_ARRIVED_MS = 2500;
/** A queued tap is pressed only if the real page arrives within this time of the tap. */
export const TAP_KEEP_MS = 20_000;

// Addresses that are never a screen of the app: its API, Next's files, sign-in and set-up pages, downloads.
const NOT_A_SCREEN = /^\/(?:api|_next|login|logout|oauth|signup|start|join|team-setup|invited|welcome|accept|offer|portal|photo|files|download)(?:\/|$)|\.[a-z0-9]{2,5}$/i;
// Query keys that do not change what the screen shows (Next's own, tracking, scroll targets).
const VOLATILE = new Set(["_rsc", "t", "ts", "utm_source", "utm_medium", "utm_campaign", "ref", "from"]);

/** The cache key of an address: path and query (volatile keys dropped, the rest sorted), no hash. Null for anything
 *  that is not a screen of this app (another site, the API, a file, a sign-in page). */
export function screenKey(href, base = "http://pulse.invalid/") {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (u.origin !== new URL(base).origin || NOT_A_SCREEN.test(u.pathname)) return null;
  const pairs = [...u.searchParams.entries()].filter(([k]) => !VOLATILE.has(k)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
  return pairs.length ? `${path}?${new URLSearchParams(pairs).toString()}` : path;
}

/** The screen a tap on a link would open, or null when the tap is not a move to another screen of this app: another
 *  site, a new tab or window, a download, a modified or non-primary click, the same screen, or a hash on this page. */
/** VITALS-SWEEP (production 22-23 Nov 2026: a Work tab, the reviews chip and a project's view links were dead clicks):
 *  what a move Next starts is. "screen": another page (its copy, or the thin bar). "view": the same page with another
 *  query, pushed by a link or a tab (the thin bar until it shows; no copy, the page itself stays). null: nothing to show
 *  (the same address, or a page replacing its own query while someone types).
 *  @param {{ target: string | null; current: string | null; type?: string }} m @returns {"screen" | "view" | null} */
export function moveKind({ target, current, type }) {
  if (!target || target === current) return null;
  const path = (/** @type {string | null} */ k) => (k ?? "").split("?")[0];
  if (path(target) !== path(current)) return "screen";
  return type === "push" ? "view" : null;
}

export function linkTarget(link, location) {
  if (!link || link.button !== 0 || link.mods || link.download || (link.target && link.target !== "_self")) return null;
  const to = screenKey(link.href, location.href), here = screenKey(location.href, location.href);
  return to && to !== here ? to : null;
}

/** A small store of screen copies, newest last; a copy older than maxAgeMs is not returned. */
export function createScreenCache({ max = SCREEN_MAX, maxAgeMs = SCREEN_MAX_AGE_MS } = {}) {
  const map = new Map();
  return {
    put(key, value, now = Date.now()) {
      if (!key) return;
      map.delete(key); map.set(key, { value, at: now });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get(key, now = Date.now()) {
      const hit = key ? map.get(key) : undefined;
      if (!hit) return null;
      if (now - hit.at > maxAgeMs) { map.delete(key); return null; }
      return hit;
    },
    drop(key) { map.delete(key); },
    clear() { map.clear(); },
    keys() { return [...map.keys()]; },
    get size() { return map.size; },
  };
}

/** Whether the real page has taken over from the copy: the address is the one tapped, and no loading screen covers it.
 *  Every route loading screen says aria-busy (page-outline.tsx and the pages' own); a small busy panel inside a drawn
 *  page (a chart still loading) does not hold the copy up, so only a busy area of at least half the visible main area
 *  counts. `busy` is the busy areas' heights, `visible` the visible height of main. */
/** @param {{ here: string | null, target: string | null, busy?: number[], visible?: number }} p */
export function pageReady({ here, target, busy = [], visible = 0 }) {
  if (!target || here !== target) return false;
  const tall = Math.max(120, visible * 0.5);
  return !busy.some((h) => h >= tall);
}

const clip = (s, n = 80) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** @typedef {{ tag: string, role: string, testid: string, nav: string, href: string, label: string, nth: number }} Tap */
/** @typedef {{ tag?: string, role?: string, testid?: string, nav?: string, href?: string, label?: string | null, nth?: number }} Control */

/** What a tap on the copy was on, so the same control can be found on the real page: tag, role, test id, the rail's
 *  nav id, its link and its words (aria-label, else its text). `nth` is its place among the copy's controls that look
 *  the same. Kept in memory only; never sent anywhere. Nothing given: an empty one (never matched).
 *  @param {Control | null | undefined} el @returns {Tap} */
export function tapOf(el) {
  const e = el ?? {};
  return { tag: e.tag ?? "", role: e.role ?? "", testid: e.testid ?? "", nav: e.nav ?? "", href: e.href ?? "", label: clip(e.label), nth: e.nth ?? 0 };
}

/** @param {Tap} a @param {Tap} b */
const same = (a, b) => a.tag === b.tag && a.role === b.role && a.testid === b.testid && a.nav === b.nav && a.href === b.href && a.label === b.label;

/** The real page's control matching a tap on the copy, by index into `candidates` (descriptors of the real page's
 *  controls in document order), or -1. A control with a test id or nav id must match it; otherwise tag, role, link
 *  and words must all match. When several match, the tap's place among them is used only if the count is the same as
 *  on the copy (`count`); a list that changed is ambiguous, so nothing is pressed rather than the wrong thing. A control
 *  without words, test id, nav id or link is never matched. */
/** @param {Tap | null} tap @param {Array<Control | null>} candidates @param {number} [count] */
export function matchTap(tap, candidates, count = 1) {
  if (!tap || (!tap.label && !tap.testid && !tap.nav && !tap.href)) return -1;
  const hits = [];
  candidates.forEach((c, i) => { if (c && same(tapOf(c), tap)) hits.push(i); });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1 && hits.length === count && tap.nth < hits.length) return hits[tap.nth];
  return -1;
}
