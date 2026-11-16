// NEW-DOTS (owner, 8 Nov 2026): which changed pages of the latest releases a person still has to look at, and whether
// they can open each one. Pure and import-free, so the web's unit tests check it against the shell's own lists
// (apps/web/app/lib/new-dots.test.mjs): MODULE_PAGES must equal packages/ui-shell/src/modules.ts MODULE_PATHS, and
// every page the shell gives only to some roles (access "admin" or "hr" in shell.tsx) must have a rule in GATED.
// A page a person cannot open never reaches them as a dot: the API leaves it out of their list (new-dots.ts).
// NEW-DOTS-2 (owner, 10 Nov 2026: "highlight the specific place, or take me straight to where I should click"): a note's
// line may also name an `anchor`, the stable id of the very thing that changed on that page (a button, tab, section,
// field or menu item: data-new-anchor="…" in the web app, listed in apps/web/app/lib/new-anchors.json). Such a change has
// two steps: opening its page clears the dots on the way there (the rail, the panel: `opened`), and the change itself
// stays new until the person reaches it (the spotlight's Got it, or using it), so the dots on the page lead them on.

/** One changed page (and, when the note names one, the thing on it) of one release, for one person. `anchor` is "" for a
 *  change to the page as a whole; `opened` says the person has opened its page but not yet reached the thing. */
export type DotItem = { note: number; route: string; anchor: string; opened: boolean; text: string; headline: string; releasedAt: string };

/** A stable id of a thing on a page (data-new-anchor): lowercase words joined by dots or dashes ("work.new-task"). */
export const ANCHOR_RE = /^[a-z0-9][a-z0-9.-]{0,79}$/;
export const anchorOf = (x: unknown): string => (typeof x === "string" && ANCHOR_RE.test(x) ? x : "");

/** The key a seen row stands for: "<note> <route>" (the page was opened, or the whole page change was seen) or
 *  "<note> <route> <anchor>" (the thing itself was reached). */
export const seenKey = (note: number | string, route: string, anchor = "") => (anchor ? `${note} ${route} ${anchor}` : `${note} ${route}`);

/** What decides which pages a person can open (the same facts the web's rail uses: /me, lib/nav.ts, the shell). */
export type PageAccess = {
  role: string; side?: string; lead?: boolean;
  /** A sales or sales-head role: Billing is on their rail (their own deals). */ salesSeat?: boolean;
  /** Pulse's own platform admins (the admin console). */ platformAdmin?: boolean;
  /** Page bases hidden from this person's role (Settings → Modules → Screens and menu). */ hidden?: readonly string[];
  /** Modules switched off for the organisation (modules.ts keys). */ modulesOff?: readonly string[];
  /** The company's own switches (pulse.org_modules(): tasks, chats, finance set to false). */ company?: Record<string, unknown> | null;
  /** A person's own personal workspace rather than a company. */ personal?: boolean;
};

/** The pages each switchable module owns (a copy of packages/ui-shell/src/modules.ts MODULE_PATHS; a web test keeps
 *  them equal). */
export const MODULE_PAGES: Record<string, readonly string[]> = {
  designers: ["/designers"],
  map: ["/map"],
  acquisition: ["/acquisition", "/portal"],
  chats: ["/chats", "/communication", "/inbox", "/groups"],
  briefs: ["/briefs"],
  money: ["/finance", "/money", "/erp"],
  hr: ["/hr", "/hr-history", "/shifts", "/leave"],
  relationships: ["/relationships"],
  skills: ["/people/skills"],
  jobs: ["/people/jobs"],
  chat_import: ["/chats/import"],
  connectors: [],
  creative: ["/creative"],
  sales_xray: ["/apps/sales-xray"],
  pulse_hq: ["/hq", "/brand"],
  focus: ["/focus"],
  funding: ["/funding"],
  product_map: ["/product-map"],
  case_studies: ["/case-studies"],
};

const isLead = (a: PageAccess) => a.role === "admin" || a.role === "leadership" || !!a.lead;
/** Pages only some roles open (the shell's access "admin" and "hr" pages, lib/nav.ts and the API's own refusals). */
export const GATED: readonly { bases: readonly string[]; open: (a: PageAccess) => boolean }[] = [
  { bases: ["/admin"], open: (a) => a.role === "admin" && !!a.platformAdmin },
  { bases: ["/audit", "/telemetry"], open: (a) => a.role === "admin" },
  { bases: ["/review-data", "/opshub"], open: (a) => a.role === "admin" || a.role === "hr" },
  { bases: ["/hr", "/hr-history", "/shifts"], open: (a) => isLead(a) || a.role === "hr" },
  { bases: ["/leadership", "/pod", "/pods", "/insights", "/network"], open: isLead },
  { bases: ["/finance"], open: isLead },
  { bases: ["/contracts"], open: (a) => isLead(a) || a.role === "finance" },
  { bases: ["/erp"], open: (a) => isLead(a) || a.role === "finance" || !!a.salesSeat },
  // FOCUS (1845): the board is the workspace owner's (focus.ts owner(): admins), the funding list leaders' (lead()).
  { bases: ["/focus"], open: (a) => a.role === "admin" },
  // GAP-FOUNDER-VIEW: "All my companies", in the person's own workspace, where they are its admin.
  { bases: ["/founder"], open: (a) => a.role === "admin" },
  { bases: ["/funding"], open: isLead },
  // CASE-STUDIES (1966): leaders and admins (row security and case-studies.ts lead()).
  { bases: ["/case-studies"], open: isLead },
  // IA-NAV (10 Nov 2026): PR Studio (pulse.pr_can(): admins and leadership; anyone in a personal workspace), the AI
  // workload (leaders) and a salesperson's own home are on the menu only for them (apps/web/app/lib/nav.ts).
  { bases: ["/pr"], open: (a) => isLead(a) || !!a.personal },
  { bases: ["/people/ai"], open: isLead },
  { bases: ["/sales"], open: (a) => !!a.salesSeat },
  // The rail's Product map is leaders'; everyone else reaches it by name (the shell's ELSEWHERE list), so it stays open.
  { bases: ["/product-map"], open: () => true },
];

/** A client, partner, guest or freelancer seat: their space, their shared work and chats, their own account. */
const OUTSIDE = new Set(["client", "channel_partner", "guest", "freelancer"]);
const OUTSIDE_OPEN = ["/client", "/tasks", "/chats", "/settings", "/account", "/notifications", "/learn"];
/** The Accountant's seat: the Finance desk and Billing (read only), and their account. */
const ACCOUNTANT_OPEN = ["/finance/desk", "/erp", "/account"];
/** An HR-only seat: the HR rail (shell.tsx HR_PAGES and their sub-pages), never clients, money or admin. */
const HR_OPEN = ["/dashboard", "/tasks", "/my-day", "/my-week", "/me", "/attendance", "/leave", "/notifications", "/chats", "/hr", "/hr-history",
  "/shifts", "/people", "/review-data", "/opshub", "/updates", "/settings", "/account", "/learn", "/features", "/bug-reports"];
/** A personal workspace has no company screens (lib/nav.ts kindOff). */
const PERSONAL_OFF = ["/people", "/hr", "/leadership", "/insights", "/acquisition", "/contacts", "/map", "/processes", "/runs", "/review-data", "/clients", "/updates", "/sales"];
/** Never a dot: the app's root, the What's new page itself (it lists them), and pages outside the signed-in app. */
const NEVER = ["/whats-new", "/login", "/signup", "/start", "/join", "/invited", "/accept", "/offer", "/portal/login", "/oauth", "/developers", "/hidden", "/welcome"];

export const under = (route: string, bases: readonly string[]) => bases.some((b) => route === b || route.startsWith(b + "/"));

/** A note's link as a page address ("/erp/documents"), or null: the address alone (no query or fragment), inside the
 *  app, plain characters only. */
export function routeOf(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const path = href.split(/[?#]/)[0].replace(/\/+$/, "");
  if (!/^\/[A-Za-z0-9/_-]{1,200}$/.test(path) || path.includes("//")) return null;
  return under(path, NEVER) ? null : path;
}

/** Whether this person can open the page (the same answer their rail gives). */
export function pageOpen(route: string, a: PageAccess): boolean {
  if (a.side && OUTSIDE.has(a.side)) return under(route, OUTSIDE_OPEN) && !under(route, a.hidden ?? []);
  if (a.role === "accountant") return under(route, ACCOUNTANT_OPEN);
  if (a.role === "hr" && !a.lead && !under(route, HR_OPEN)) return false;
  if (under(route, a.hidden ?? [])) return false;
  for (const key of a.modulesOff ?? []) if (under(route, MODULE_PAGES[key] ?? [])) return false;
  const company = a.company ?? {};
  if (company.tasks === false && under(route, ["/tasks", "/my-day", "/my-week"])) return false;
  if (company.chats === false && under(route, MODULE_PAGES.chats)) return false;
  if (company.finance === false && under(route, ["/finance", "/erp"])) return false;
  if (a.personal && under(route, PERSONAL_OFF)) return false;
  return GATED.every((g) => !under(route, g.bases) || g.open(a));
}

type NoteLike = { id: number; headline?: unknown; releasedAt?: unknown; items?: unknown; pleaseCheck?: unknown };
const textOf = (x: unknown) => (typeof x === "string" ? x : "").replace(/\s+/g, " ").trim().slice(0, 240);

/** Every changed page of these notes (the person's audiences' items, then what to check), one per note, page and
 *  anchor, in the notes' order (newest first). The first line naming a page (or a thing on it) is the one shown. */
export function itemsOf(notes: readonly NoteLike[]): DotItem[] {
  const out: DotItem[] = [];
  const seen = new Set<string>();
  for (const n of notes) {
    if (!Number.isSafeInteger(n.id)) continue;
    const lines: unknown[] = [];
    if (n.items && typeof n.items === "object") for (const list of Object.values(n.items as Record<string, unknown>)) if (Array.isArray(list)) lines.push(...list);
    if (Array.isArray(n.pleaseCheck)) lines.push(...n.pleaseCheck);
    for (const line of lines) {
      if (!line || typeof line !== "object") continue;
      const { text, href, anchor: named } = line as { text?: unknown; href?: unknown; anchor?: unknown };
      const route = routeOf(href), words = textOf(text), anchor = anchorOf(named);
      const key = seenKey(n.id, route ?? "", anchor);
      if (!route || !words || seen.has(key)) continue;
      seen.add(key);
      out.push({ note: n.id, route, anchor, opened: false, text: words, headline: textOf(n.headline), releasedAt: typeof n.releasedAt === "string" ? n.releasedAt : "" });
    }
  }
  return out;
}

/** The release window: notes older than this never light a dot (a person away for a month is not greeted by dozens). */
export const WINDOW_DAYS = 30;

/** What this person has still to look at: changes on pages they can open, of releases in the window, not yet seen
 *  (`seen` holds seenKey()s). A change to a thing on a page stays until the thing is reached; it is `opened` once its
 *  page has been opened (the dots on the way there are gone, the ones on the page stay). */
export function unseenOf(items: readonly DotItem[], seen: ReadonlySet<string>, a: PageAccess, now = Date.now()): DotItem[] {
  const from = now - WINDOW_DAYS * 86_400_000;
  return items.filter((i) => !seen.has(seenKey(i.note, i.route, i.anchor)) && pageOpen(i.route, a) && !(Date.parse(i.releasedAt) < from))
    .map((i) => ({ ...i, opened: !!i.anchor && seen.has(seenKey(i.note, i.route)) }));
}

/** The items a visit to `path` clears: a change to that page or to a page that holds it (opening one document,
 *  /erp/documents/12, counts as opening /erp/documents; opening /erp does not clear a change to /erp/documents). */
export const clearedBy = (items: readonly DotItem[], path: string) => items.filter((i) => path === i.route || path.startsWith(i.route + "/"));

/** The changes a person reaches on `path` when they get to the thing named `anchor` (the spotlight's Got it or Next, or
 *  using it): that thing's change on that page (or on a page that holds it). */
export const reachedBy = (items: readonly DotItem[], path: string, anchor: string) =>
  anchor ? clearedBy(items, path).filter((i) => i.anchor === anchor) : [];

/** How many places have something new (one per page, however many releases changed it). */
export const placeCount = (items: readonly DotItem[]) => new Set(items.map((i) => i.route)).size;

/** How many new things there are (a page change, or one thing on a page; however many releases changed it). */
export const thingCount = (items: readonly DotItem[]) => new Set(items.map((i) => `${i.route} ${i.anchor}`)).size;
