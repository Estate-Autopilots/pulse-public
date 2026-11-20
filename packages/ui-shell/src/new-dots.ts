// NEW-DOTS (owner, 8 Nov 2026): the red "new" dots on the rail, the panel, the phone's tabs and the account menu, for
// the pages the latest releases changed until the person has looked. The app reads each person's unseen pages from the
// API (/api/v0/whats-new/unseen, only pages they can open) and tells the shell with a window event; the shell puts a dot
// on every entry that holds one. Plain data, no React: the web's unit tests import it (apps/web/app/lib/new-dots.test.mjs).

// NEW-DOTS-2 (owner, 10 Nov 2026: "alert me at the top level first, then take me deeper"): each entry also says how many
// new things wait below it (`counts`, per changed page); the app's host takes the person on from the page to the thing.

/** window event: detail { on, routes, count, counts } (the app's new-dots host sends it whenever the list changes).
 *  `routes`: the changed pages whose way in is still lit (not opened yet); `counts`: for each, how many new things. */
export const NEW_DOTS_EVENT = "pulse:new-dots";
/** HR-PEOPLE (owner, 13 Nov 2026: "When I hover on the red dot, let's say People and pay, it says nothing"): `notes`
 *  holds, for each lit page, the lines that say what is new there, so every dot says on hover what waits behind it. */
export type NewDots = Readonly<{ on: boolean; routes: readonly string[]; count: number; counts?: Readonly<Record<string, number>>; notes?: Readonly<Record<string, readonly string[]>> }>;
export const NO_DOTS: NewDots = { on: false, routes: [], count: 0 };

/** The address part of an entry's href ("/tasks?view=projects" → "/tasks"). */
const pathOf = (href: string) => href.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
const holds = (base: string, route: string) => base !== "/" && (route === base || route.startsWith(base + "/"));

/** Whether a rail or menu entry leads to a changed page: one of its addresses (its href and the pages it also covers)
 *  is the changed page or holds it. "/" never matches (it would light everything). */
export function entryIsNew(dots: NewDots, hrefs: readonly (string | undefined)[]): boolean {
  if (!dots.on || !dots.routes.length) return false;
  const bases = hrefs.filter((h): h is string => typeof h === "string" && h.startsWith("/")).map(pathOf);
  return dots.routes.some((route) => bases.some((base) => holds(base, route)));
}

/** How many new things wait under a rail or menu entry (0 when it has no dot): the sum over the changed pages it leads
 *  to. A page the event gives no number for counts one. */
export function entryCount(dots: NewDots, hrefs: readonly (string | undefined)[]): number {
  if (!dots.on || !dots.routes.length) return 0;
  const bases = hrefs.filter((h): h is string => typeof h === "string" && h.startsWith("/")).map(pathOf);
  return dots.routes.filter((route) => bases.some((base) => holds(base, route))).reduce((n, route) => n + Math.max(1, Math.floor(dots.counts?.[route] ?? 1)), 0);
}

/** A sub-place under a page (Billing → Documents) lights only for its own page, and never when it is a tab of its
 *  page (an address with ?tab=…): a release names pages, not tabs, so every tab would light at once. */
export function subIsNew(dots: NewDots, href: string): boolean {
  return !href.includes("?") && entryIsNew(dots, [href]);
}

/** The count on "What's new": up to 9, then "9+". */
export const countText = (n: number) => (n > 9 ? "9+" : String(Math.max(0, Math.floor(n))));

/** The words a screen reader adds to an entry with a dot. */
export const NEW_LABEL = "New";

/** Reads an event's detail leniently: anything malformed is no dots. */
export function dotsFrom(detail: unknown): NewDots {
  const d = detail && typeof detail === "object" ? detail as Record<string, unknown> : {};
  const routes = Array.isArray(d.routes) ? d.routes.filter((r): r is string => typeof r === "string" && r.startsWith("/")).slice(0, 200) : [];
  const count = typeof d.count === "number" && Number.isFinite(d.count) ? Math.max(0, Math.floor(d.count)) : routes.length;
  const raw = d.counts && typeof d.counts === "object" ? d.counts as Record<string, unknown> : {};
  const counts: Record<string, number> = {};
  for (const r of routes) { const n = raw[r]; if (typeof n === "number" && Number.isFinite(n) && n > 0) counts[r] = Math.min(99, Math.floor(n)); }
  const rawNotes = d.notes && typeof d.notes === "object" ? d.notes as Record<string, unknown> : {};
  const notes: Record<string, string[]> = {};
  for (const r of routes) {
    const list = rawNotes[r];
    if (Array.isArray(list)) notes[r] = list.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim().slice(0, 140)).slice(0, 5);
  }
  return d.on === true ? { on: true, routes, count, counts, notes } : NO_DOTS;
}

/** The lines that say what is new under a rail or menu entry (its pages' notes, in order, each once). */
export function entryNotes(dots: NewDots, hrefs: readonly (string | undefined)[]): string[] {
  if (!dots.on || !dots.routes.length) return [];
  const bases = hrefs.filter((h): h is string => typeof h === "string" && h.startsWith("/")).map(pathOf);
  const out: string[] = [];
  for (const route of dots.routes) {
    if (!bases.some((base) => holds(base, route))) continue;
    for (const t of dots.notes?.[route] ?? []) if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** What a dot says on hover: how many new things wait under the entry and what the first one is, in one short line.
 *  DOREVE-FIX (owner, 17 Nov 2026): the hover used to list up to three notes (each up to 140 characters) and "and N more",
 *  a box of 10+ lines that covered the menu every time the pointer crossed the rail ("text sits over the whole screen").
 *  Now at most TIP_MAX characters ("New in People & pay: Pay policy is now five questions +1 more"); What's new has the rest. */
export const TIP_MAX = 72;
const clip = (text: string, room: number) => {
  const t = text.replace(/\s+/g, " ").trim().replace(/\.+$/, "");
  if (t.length <= room) return t;
  const cut = t.slice(0, Math.max(1, room - 1)), space = cut.lastIndexOf(" ");
  return `${(space > room * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, "")}…`;
};
export function dotTip(label: string, count: number, notes: readonly string[]): string {
  if (notes.length) {
    const total = Math.max(notes.length, Math.floor(count || 0));
    const more = total > 1 ? ` +${total - 1} more` : "";
    const head = `New in ${label}: `;
    return `${head}${clip(notes[0], Math.max(12, TIP_MAX - head.length - more.length))}${more}`;
  }
  const n = Math.max(1, Math.floor(count || 0));
  return `${label} · ${n} new. Click to see ${n === 1 ? "it" : "them"}.`;
}

/** Whether opening `path` clears a change to `route`: the page itself, or a page inside it (one document of a list). The
 *  API decides the same way (services/api/src/new-dots-access.ts clearedBy) and is the one that stores it. */
export function visitClears(path: string, route: string): boolean {
  const p = pathOf(path);
  return holds(route, p);
}
