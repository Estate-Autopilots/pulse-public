// EST-1419 (hand-off #3 item 8, and the same simpler-menu ask from a second organisation): an organisation hides
// single screens and their menu entries per role. A hidden screen leaves the rail, the phone tabs and the palettes, and
// a direct link shows "Hidden by your admin"; data and permissions never change, so every route answers as before.
// SCREENS is the server's registry: one stable key per rail entry with the page bases it covers (the shell's href and
// `also`, packages/ui-shell/src/shell.tsx). Choices are saved by key (migration 0610), so renamed labels and later
// updates keep them; a key an update adds is hidden for every role while the organisation's "New screens start hidden"
// is on, until an admin shows it. Dashboard, Chats, My desk and the HR desk always stay visible (owner, 18 Oct), and
// Settings is not in the list, so an admin can always undo. EST-1240/1241: the same choice also names each role's home
// (the usual Dashboard, or the sales home); a role nobody chose for keeps the Dashboard.
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { admin, fail, type Tx, type Viewer } from "./routes.js";

export const SCREENS = [
  { key: "dashboard", paths: ["/dashboard"], fixed: true },
  { key: "work", paths: ["/tasks", "/my-week", "/delivery", "/portal"] },
  { key: "chats", paths: ["/chats", "/communication", "/inbox", "/groups"], fixed: true },
  { key: "clients", paths: ["/clients", "/projects", "/stewardship/client", "/stewardship/project", "/deliveries"] },
  { key: "acquisition", paths: ["/acquisition"] },
  { key: "contacts", paths: ["/contacts", "/stewardship/contact", "/relationships"] },
  { key: "map", paths: ["/map"] },
  { key: "sops", paths: ["/sops", "/processes", "/runs"] },
  { key: "network", paths: ["/network"] },
  { key: "team", paths: ["/people", "/activity", "/stewardship/person", "/designers"] },
  { key: "me", paths: ["/me", "/attendance", "/leave", "/notifications", "/welcome"], fixed: true },
  { key: "hr", paths: ["/hr", "/hr-history", "/shifts"], fixed: true },
  { key: "leadership", paths: ["/leadership", "/pod", "/pods"] },
  { key: "finance", paths: ["/finance"] },
  { key: "erp", paths: ["/erp"] },
  { key: "review", paths: ["/review-data", "/opshub"] },
  { key: "audit", paths: ["/audit"] },
] as const satisfies readonly { key: string; paths: readonly string[]; fixed?: boolean }[];
export type ScreenKey = typeof SCREENS[number]["key"];
const KEYS: readonly ScreenKey[] = SCREENS.map((s) => s.key);
const FIXED = new Set<string>(SCREENS.filter((s) => "fixed" in s && s.fixed).map((s) => s.key));

/** The viewer roles a choice is made for (routes.ts's Viewer.role); the Accountant keeps its own two pages. */
export const SCREEN_ROLES = ["admin", "leadership", "finance", "hr", "manager", "pgs", "person"] as const;
type ScreenRole = typeof SCREEN_ROLES[number];

/** The homes a role can land on. An HR-only account has no work screens, so it always keeps its own home. */
export const HOME_KEYS = ["dashboard", "sales"] as const;
export type HomeKey = typeof HOME_KEYS[number];
export const HOME_ROLES = SCREEN_ROLES.filter((r) => r !== "hr");

export type ScreenView = { newScreensHidden: boolean; known: string[]; hidden: Partial<Record<ScreenRole, string[]>>; home: Partial<Record<ScreenRole, HomeKey>> };

const keyList = { type: "array", uniqueItems: true, maxItems: SCREENS.length, items: { enum: [...KEYS] } } as const;
/** What an admin saves: the switch, every role's complete hide list and, optionally, each role's home (a save without
 *  `home` keeps the homes already chosen). */
export const SCREEN_CHOICE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["newScreensHidden", "hidden"],
  properties: {
    newScreensHidden: { type: "boolean" },
    hidden: { type: "object", additionalProperties: false, properties: Object.fromEntries(SCREEN_ROLES.map((r) => [r, keyList])) },
    home: { type: "object", additionalProperties: false, properties: Object.fromEntries(HOME_ROLES.map((r) => [r, { enum: [...HOME_KEYS] }])) },
  },
} as const;
const FIXED_TEXT = "Dashboard, Chats, My desk and the HR desk always stay visible";
const validator = new Ajv2020({ allErrors: true, strict: false }).compile(SCREEN_CHOICE_SCHEMA);

export function validateScreenChoice(body: unknown): { valid: boolean; errors: string[] } {
  const valid = validator(body) === true;
  const errors = valid ? [] : (validator.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
  const fixed = valid ? Object.values((body as ScreenView).hidden).flat().filter((key) => FIXED.has(key!)) : [];
  return fixed.length ? { valid: false, errors: [FIXED_TEXT] } : { valid, errors };
}

/** A stored row, read leniently: unknown roles and keys are dropped, so one bad entry never hides anything else. */
export function viewFrom(body: unknown): ScreenView {
  const b = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const list = (x: unknown) => Array.isArray(x) ? KEYS.filter((key) => x.includes(key)) as string[] : [];
  const hidden = typeof b.hidden === "object" && b.hidden !== null ? b.hidden as Record<string, unknown> : {};
  const home = typeof b.home === "object" && b.home !== null ? b.home as Record<string, unknown> : {};
  return { newScreensHidden: b.newScreensHidden === true, known: list(b.known),
    hidden: Object.fromEntries(SCREEN_ROLES.filter((r) => r in hidden).map((r) => [r, list(hidden[r])])),
    home: Object.fromEntries(HOME_ROLES.filter((r) => (HOME_KEYS as readonly unknown[]).includes(home[r])).map((r) => [r, home[r] as HomeKey])) };
}

/** The home a role lands on: the organisation's choice for it, else the Dashboard. */
export function homeFor(view: ScreenView, role: string): HomeKey {
  return (HOME_ROLES as readonly string[]).includes(role) ? view.home[role as ScreenRole] ?? "dashboard" : "dashboard";
}

/** The keys a role does not see: its saved list, plus every screen added since the last save while new screens start
 *  hidden. The fixed screens never. */
export function hiddenFor(view: ScreenView, role: string): ScreenKey[] {
  if (!(SCREEN_ROLES as readonly string[]).includes(role)) return [];
  const saved = new Set(view.hidden[role as ScreenRole] ?? []);
  return KEYS.filter((key) => !FIXED.has(key) && (saved.has(key) || (view.newScreensHidden && !view.known.includes(key))));
}

const readView = async (c: PoolClient) => viewFrom((await c.query("select pulse.org_screen_view_get() v")).rows[0].v);

/** For /me: the viewer's hidden screens and the page bases they cover (the web hides their entries and redirects a
 *  direct link to /hidden). */
export async function viewerHiddenScreens(c: PoolClient, role: string, shown: readonly string[] = []) {
  // FLOW-E: a screen one of the person's work roles uses shows for them (Settings → Industry & roles).
  const keys = hiddenFor(await readView(c), role).filter((key) => !shown.includes(key));
  return { keys, paths: SCREENS.filter((s) => (keys as string[]).includes(s.key)).flatMap((s) => [...s.paths]) };
}

/** For /me and the sales home: the home this person's role lands on. */
export async function viewerHome(c: PoolClient, role: string): Promise<HomeKey> {
  return homeFor(await readView(c), role);
}

export function registerScreenRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  const shape = (view: ScreenView, v: Viewer) => ({
    screens: SCREENS.map((s) => ({ key: s.key, href: s.paths[0], fixed: FIXED.has(s.key) })),
    roles: SCREEN_ROLES, newScreensHidden: view.newScreensHidden,
    hidden: Object.fromEntries(SCREEN_ROLES.map((r) => [r, hiddenFor(view, r)])),
    homes: HOME_KEYS, home: Object.fromEntries(HOME_ROLES.map((r) => [r, homeFor(view, r)])),
    canEdit: admin(v) && !!v.person,
  });
  app.get("/api/v0/settings/screens", (req) => tx(req, async (c, v) => {
    if (!admin(v)) fail(403, "Organisation admins choose the screens each role sees");
    return shape(await readView(c), v);
  }));
  app.post<{ Body: Record<string, unknown> }>("/api/v0/settings/screens", { schema: { body: { type: "object" } } }, (req) => tx(req, async (c, v) => {
    if (!admin(v) || !v.person) fail(403, "An organisation admin chooses the screens each role sees");
    const check = validateScreenChoice(req.body);
    if (!check.valid && check.errors[0] === FIXED_TEXT) fail(400, "Dashboard, Chats, My desk and the HR desk always stay visible");
    if (!check.valid) fail(400, "Choose screens and roles from the list");
    // Today's registry becomes "known": a screen a later update adds starts hidden only if the switch is on then.
    const home = req.body.home === undefined ? (await readView(c)).home : viewFrom({ home: req.body.home }).home;
    const body: ScreenView = { newScreensHidden: req.body.newScreensHidden === true, known: [...KEYS], hidden: req.body.hidden as ScreenView["hidden"], home };
    await c.query("select pulse.org_screen_view_set($1::jsonb)", [JSON.stringify(body)]);
    return shape(body, v);
  }));
}
