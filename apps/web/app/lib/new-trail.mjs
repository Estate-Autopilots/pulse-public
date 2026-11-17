// NEW-DOTS-2 (owner, 10 Nov 2026: "When a deep sub-feature, a small feature, or something deep inside a page or section is
// updated, alert me at the top level first, then take me deeper. It should highlight the specific place, or take me
// straight to where I should click."). The dot trail's rules, plain data and no React (the web's unit tests import them:
// lib/new-trail.test.mjs). The API says what is new for this person and whether its page was opened
// (services/api/src/new-dots.ts); lib/new-anchors.json says where each thing is on its page and what opens on the way.
//
//   rail section → panel page → (the page) a menu or tab on the way → the thing itself
//
// A level's own dot goes when it is opened (the page: when it is visited; a menu or tab: while it is open), and the dots
// below it stay until the person reaches the thing (the spotlight's Got it or Next, or using it).

/** At most this many dots on one page at once (the games' rule: a screen full of red is a screen nobody reads). */
export const PAGE_CAP = 5;

/** The address part of a link ("/tasks?view=all" → "/tasks"). @param {string} href */
export const pathOf = (href) => (typeof href === "string" ? href.split(/[?#]/)[0].replace(/\/+$/, "") || "/" : "/");

/** What the shell needs (its NEW_DOTS_EVENT detail): the changed pages whose way in is still lit (not opened yet), with
 *  how many new things each holds, and the count for What's new (every new thing, opened or not). HR-PEOPLE: `notes`
 *  says, per lit page, what is new there (the release lines, each once), so every dot can say it on hover.
 *  @param {{ on: boolean; count: number; items: { route: string; anchor?: string; opened?: boolean; text?: string }[] }} s */
export function shellDetail(s) {
  // One per thing on a page, however many releases changed it.
  const lit = new Map(), things = new Set(), notes = new Map();
  for (const i of Array.isArray(s?.items) ? s.items : []) {
    things.add(`${i.route} ${i.anchor ?? ""}`);
    if (i.opened) continue;
    lit.set(i.route, (lit.get(i.route) ?? new Set()).add(i.anchor ?? ""));
    const text = typeof i.text === "string" ? i.text.trim() : "";
    const list = notes.get(i.route) ?? [];
    if (text && !list.includes(text) && list.length < 5) list.push(text);
    notes.set(i.route, list);
  }
  const counts = Object.fromEntries([...lit].map(([route, set]) => [route, set.size]));
  return { on: !!s?.on, count: typeof s?.count === "number" ? s.count : things.size, routes: [...lit.keys()], counts, notes: Object.fromEntries(notes) };
}

/** HR-PEOPLE (owner, 13 Nov 2026: "When I click on the red dot … it redirects me to the people, and there is no way to
 *  truly find" it): where a click on a dotted entry goes. An entry lit only by a page inside it (Team, lit by People &
 *  pay) opens that page, where the new thing is; an entry whose own page changed opens as usual (null).
 *  @param {string} href @param {{ route: string; opened?: boolean }[]} items */
export function dotDestination(href, items) {
  const base = pathOf(href);
  const lit = (Array.isArray(items) ? items : []).filter((i) => i && !i.opened && typeof i.route === "string").map((i) => pathOf(i.route));
  if (base === "/" || lit.includes(base)) return null;
  return lit.find((route) => route.startsWith(base + "/")) ?? null;
}

/** One registry entry, or null. @param {{ anchors?: Record<string, unknown> }} registry @param {string} id */
export function anchorEntry(registry, id) {
  const e = id && registry?.anchors && Object.prototype.hasOwnProperty.call(registry.anchors, id) ? registry.anchors[id] : null;
  if (!e || typeof e !== "object" || typeof e.route !== "string" || typeof e.label !== "string") return null;
  const via = Array.isArray(e.via) ? e.via.filter((v) => typeof v === "string" && v !== id) : [];
  return { id, route: e.route, href: typeof e.href === "string" ? e.href : e.route, label: e.label, via };
}

/** The tour on this page: each new thing on it (newest release first, one per thing) that the registry knows, with the
 *  way to it. A thing the registry does not know is left to the page's "New: …" line.
 *  @param {{ note: number; route: string; anchor?: string; text: string }[]} items @param {string} path @param {object} registry */
export function stepsOn(items, path, registry) {
  const here = pathOf(path), out = [], seen = new Set();
  for (const i of Array.isArray(items) ? items : []) {
    if (!i?.anchor || i.route !== here || seen.has(i.anchor)) continue;
    const e = anchorEntry(registry, i.anchor);
    if (!e || e.route !== here) continue;
    seen.add(i.anchor);
    out.push({ anchor: i.anchor, route: i.route, href: e.href, label: e.label, via: e.via, text: i.text, note: i.note });
  }
  return out;
}

/** The dots on this page: for each thing on the way (a menu, a tab) and each thing itself, how many new things wait at
 *  or below it. A menu or tab that is open has no dot of its own (`isOpen`); the things below keep theirs. At most
 *  PAGE_CAP, the nearest first (the ways in before what they hold).
 *  @param {{ anchor: string; via: string[] }[]} steps @param {(id: string) => boolean} [isOpen] */
export function pageDots(steps, isOpen = () => false) {
  const n = new Map();
  for (const s of steps) {
    for (const v of s.via) if (!isOpen(v)) n.set(v, (n.get(v) ?? 0) + 1);
    n.set(s.anchor, (n.get(s.anchor) ?? 0) + 1);
  }
  return [...n.entries()].map(([anchor, count]) => ({ anchor, count, way: steps.some((s) => s.via.includes(anchor)) }))
    .sort((a, b) => Number(b.way) - Number(a.way)).slice(0, PAGE_CAP);
}

/** The trail in words for What's new: "Work › More in Work › The pool". @param {object} registry @param {string} anchor
 *  @param {string} [page] the page's own name */
export function trailWords(registry, anchor, page) {
  const e = anchorEntry(registry, anchor);
  if (!e) return page ? [page] : [];
  return [...(page ? [page] : []), ...e.via.map((v) => anchorEntry(registry, v)?.label).filter(Boolean), e.label];
}

/** "1 of 3". @param {number} i @param {number} n */
export const stepOf = (i, n) => `${i + 1} of ${n}`;

/** The travel a click asked for ("take me there"): kept for a short while in this tab, so the page it opens can carry on.
 *  @param {unknown} x @param {number} [now] */
export function travelFrom(x, now = Date.now()) {
  if (!x || typeof x !== "object") return null;
  const t = /** @type {{ route?: unknown; anchor?: unknown; at?: unknown }} */ (x);
  if (typeof t.route !== "string" || !t.route.startsWith("/") || typeof t.at !== "number" || now - t.at > TRAVEL_MS || t.at > now + 1000) return null;
  return { route: pathOf(t.route), anchor: typeof t.anchor === "string" && t.anchor ? t.anchor : "", at: t.at };
}
/** How long a "take me there" waits for its page to open. */
export const TRAVEL_MS = 120_000;
export const TRAVEL_KEY = "pulse.new-dots.travel";

/** A change's short title for a small space (a phone's top bar): its words up to the first ": " or ". " when that leaves
 *  3 to 60 characters, else the first 40 characters and "…". "Start a task from a template: tap New, then pick one" →
 *  "Start a task from a template". @param {string} text */
export function shortOf(text) {
  const t = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  const cut = t.search(/: |\. /);
  if (cut >= 3 && cut <= 60) return t.slice(0, cut);
  return t.length > 40 ? `${t.slice(0, 40).trimEnd()}…` : t.replace(/\.$/, "");
}
