// NAV-CONNECT (owner, 17 Nov 2026: "The new-update pop-up highlights the wrong thing, just one thing at the top, and
// doesn't take you to the specific item arrow by arrow"). What's new's Show me is a path, step by step, each with an
// arrow: the rail's group → the page in its list → the page → the thing that changed. Plain data and no React (the web's
// unit tests import it: lib/new-path.test.mjs); new-path.tsx draws it.
//
// The release notes name a thing on a page by its anchor (lib/new-anchors.json) only rarely: the last 20 releases had
// 115 lines and none named one. So a line without an anchor is read against the registry's things on its page (their
// name and listed words); exactly one match is the thing, anything else ends the path at the page, which the card then
// says plainly ("This change is on this page as a whole"). The path never points at a guess.
import { anchorEntry, pathOf } from "./new-trail.mjs";

export const PATH_KEY = "pulse.new-path";
/** A path waits this long for its next page to open (a slow first load), then it is forgotten. */
export const PATH_MS = 120_000;

/** Lower-case words with single spaces, padded, so " word " matches whole words only. @param {unknown} s */
const words = (s) => ` ${String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/** The thing a change line names on its page: its own anchor when the registry knows it; else the one registry thing on
 *  that page whose name, or one of its words, the line says (3 letters at least); else "" (the page itself).
 *  @param {{ route: string; anchor?: string; text?: string } | null | undefined} item @param {import("./new-trail.mjs").AnchorRegistry} registry */
export function inferAnchor(item, registry) {
  if (!item || typeof item.route !== "string") return "";
  if (item.anchor) return anchorEntry(registry, item.anchor) ? item.anchor : "";
  const here = pathOf(item.route), text = words(item.text), hits = [];
  for (const [id, e] of Object.entries(registry?.anchors ?? {})) {
    if (!e || typeof e.route !== "string" || pathOf(e.route) !== here) continue;
    const names = [e.label, ...(Array.isArray(e.words) ? e.words : [])].map(words).filter((w) => w.trim().length >= 3);
    if (names.some((n) => text.includes(n))) hits.push(id);
  }
  return hits.length === 1 ? hits[0] : "";
}

/** The steps from where the person is to a change. `spot`: where the shell says the page sits (its rail group and its
 *  entry; null when none holds it). `rail`: the rail and its lists show (a computer with a mouse). Already on the page
 *  (or a change to the whole app, route "/"): just the thing or the page.
 *  @param {{ route: string; anchor?: string; here: string; spot: { group: string; groupLabel: string; href: string; label: string } | null; rail: boolean }} p */
export function pathPlan({ route, anchor = "", here, spot, rail }) {
  const to = pathOf(route), everywhere = to === "/";
  const steps = [];
  if (!everywhere && pathOf(here) !== to && spot && rail) {
    steps.push({ kind: "rail", group: spot.group, label: spot.groupLabel });
    // A change to a page as a whole has no one thing to point at: the path ends on the page's own entry ("Open My day"),
    // and the page, once open, says what changed in its "New: …" line. A change that names its thing goes on to it.
    if (!anchor) { steps.push({ kind: "menu", group: spot.group, href: spot.href, label: spot.label }, { kind: "note", label: spot.label }); return steps; }
    steps.push({ kind: "menu", group: spot.group, href: spot.href, label: spot.label });
  }
  steps.push(anchor ? { kind: "thing", anchor } : { kind: "page", label: everywhere ? "Everywhere in Pulse" : spot?.label ?? "This page" });
  return steps;
}

/** A page opened by the path lands (its server's redirect answered) within this long; later, the person went on. */
export const LAND_MS = 10_000;
const ON_PAGE = new Set(["thing", "page", "note"]);

/** PROJECTS-FLICKER (owner, 22 Nov 2026, P0: "the project page … is flickering like crazy, it does not open"): what the
 *  path does about the address while its step is on the change's page. It opens that page ONCE per step (`opened`: which
 *  step it opened, from where, when, and whether its address showed). A page that sends the person on lands at another
 *  address (an agency's /projects is Work → Projects, /tasks?view=projects): the change is shown there, so the path
 *  carries on there ("here"). Before, it opened /projects again after every landing, ~8 times a second on production:
 *  the page was drawn again and again, Work's live check asked again each time, and Back went nowhere. Elsewhere long
 *  after the opening, the person went on by themselves: the path ends ("end"), it never pulls them back (the card's own
 *  taps, Escape and Back end it sooner). "there": the change's address showed (the caller marks it). Pure; new-path.tsx
 *  follows the answer.
 *  @param {{ path: { route: string; href: string; steps: { kind: string }[]; i: number; at: number } | null; here: string;
 *    opened: { step: string; from: string; at: number; there: boolean } | null; now?: number }} p */
export function pathGo({ path, here, opened, now = Date.now() }) {
  const step = path?.steps?.[path.i];
  if (!path || !step || !ON_PAGE.has(step.kind)) return null;
  const at = pathOf(here), id = `${path.at}:${path.i}`, mine = opened?.step === id ? opened : null;
  if (path.route === "/" || at === path.route) return mine && !mine.there ? { go: "there" } : null;
  if (!mine) return { go: "open", href: path.href, opened: { step: id, from: at, at: now, there: false } };
  // Still on the page it was opened from, before the change's address showed: the page is on its way.
  if (!mine.there && at === mine.from && now - mine.at <= LAND_MS) return null;
  return now - mine.at <= LAND_MS ? { go: "here", route: at } : { go: "end" };
}

/** VITALS-SWEEP (owner, EA, 23 Nov 2026: Show me "did nothing" for seconds, then opened in a new tab): true when the path's
 *  first step is on the change's page and the person is elsewhere, so pressing Show me starts by opening that page. The
 *  link says "Opening…" at once then (show-me.tsx); a rail or list step shows its card straight away instead.
 *  @param {{ route: string; here: string; steps: { kind: string }[] }} p */
export function opensFirst({ route, here, steps }) {
  const to = pathOf(route);
  return to !== "/" && pathOf(here) !== to && ON_PAGE.has(steps?.[0]?.kind ?? "");
}

/** "Step 2 of 3". @param {number} i @param {number} n */
export const stepWords = (i, n) => (n > 1 ? `Step ${i + 1} of ${n}` : "");

/** A stored path, checked: a same-site route, the steps, which one is next, not too old. @param {unknown} x @param {number} [now] */
export function pathFrom(x, now = Date.now()) {
  if (!x || typeof x !== "object") return null;
  const p = /** @type {Record<string, unknown>} */ (x);
  const ok = typeof p.route === "string" && p.route.startsWith("/") && !p.route.startsWith("//") && typeof p.href === "string" && p.href.startsWith("/") && !p.href.startsWith("//")
    && typeof p.text === "string" && Array.isArray(p.steps) && p.steps.length > 0 && p.steps.length <= 4 && Number.isInteger(p.i) && /** @type {number} */ (p.i) >= 0
    && /** @type {number} */ (p.i) < p.steps.length && typeof p.at === "number" && now - p.at <= PATH_MS && p.at <= now + 1000;
  if (!ok) return null;
  const kinds = new Set(["rail", "menu", "thing", "page", "note"]);
  if (!p.steps.every((s) => s && typeof s === "object" && kinds.has(s.kind))) return null;
  return /** @type {{ route: string; href: string; text: string; anchor: string; inferred: boolean; steps: object[]; i: number; at: number }} */ ({
    route: pathOf(p.route), href: p.href, text: p.text.slice(0, 400), anchor: typeof p.anchor === "string" ? p.anchor : "", inferred: p.inferred === true, steps: p.steps, i: p.i, at: p.at });
}
