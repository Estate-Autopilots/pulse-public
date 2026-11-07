import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { packModulesOf } from "./flow/pack-modules.js";

/** Modules an organisation can switch off. Everything else (Dashboard, Tasks, Projects, …) is always on. */
export const MODULE_KEYS = ["designers", "map", "acquisition", "chats", "briefs", "money", "hr", "relationships", "skills", "jobs", "chat_import", "connectors", "creative", "sales_xray", "pulse_hq"] as const;
export type ModuleKey = typeof MODULE_KEYS[number];
export type Modules = { off: ModuleKey[] };

/** RELEASE-5: modules that ship switched off until the server turns them on, because each waits for an owner errand
 *  (lane C's roadmap rounds): R46's relationship graph (E14: what "models" are, the accepted sources, the reviewers),
 *  R48's skills and CV (E16: an approved taxonomy), R49's internal jobs (E16: sample jobs, consent, HR's acceptance) and
 *  R47's WhatsApp history import (E08/E15). Off, a module is off exactly as a company's switch makes it (no navigation,
 *  no command palette entry, the neutral page, its API 404); R46's hourly refresh does not run either. The variable's
 *  value "1" turns a module on; PULSE_CHAT_IMPORT=preview shows the import's preview while real imports stay refused
 *  (chat-import.ts).
 *  RELEASE-6: R52's company connectors join them (E13/E18/E08 open). PULSE_CONNECTORS=1 reads (connectors.ts), "setup"
 *  shows Settings → Connected sources → Connectors and its API without reading anything; unset, nothing of it shows.
 *  EST-1474: the Creative Strategy app (T1) joins them: PULSE_CREATIVE=1 shows it where it is wanted, nowhere else.
 *  EST-1363: the Sales X-Ray app too: PULSE_SALES_XRAY=1 (with PULSE_SALES_XRAY_URL, sales-xray.ts). */
export const SERVER_SWITCHED = { relationships: "PULSE_RELATIONSHIPS", skills: "PULSE_SKILLS", jobs: "PULSE_JOBS", chat_import: "PULSE_CHAT_IMPORT",
  connectors: "PULSE_CONNECTORS", creative: "PULSE_CREATIVE", sales_xray: "PULSE_SALES_XRAY" } as const satisfies Partial<Record<ModuleKey, string>>;
export const serverOn = (key: keyof typeof SERVER_SWITCHED, env: NodeJS.ProcessEnv = process.env) =>
  env[SERVER_SWITCHED[key]] === "1" || (key === "chat_import" && env[SERVER_SWITCHED[key]] === "preview")
  || (key === "connectors" && env[SERVER_SWITCHED[key]] === "setup");
/** PULSE-HQ (owner, 23 Oct 2026): modules that belong to one organisation. Each stays off unless the organisation's own
 *  document names it in `on` (the Pulse organisation, 0944, for Pulse HQ), so no other company ever sees it. */
export const ORG_ONLY = ["pulse_hq"] as const satisfies readonly ModuleKey[];
/** DE-EA (owner, 28 Oct 2026: modules switch per company and per plan, not per server): tenant-facing modules a company
 *  chooses. The server's variable (SERVER_SWITCHED) now says only that this install can offer one (its infrastructure is
 *  set up); each company has it when its own document names it in `on` or its industry pack brings it (flow/packs.ts
 *  `modules`), and its plan allows it (PLAN_MODULES). One company's need never switches a module on for every other.
 *  A company with no modules document at all (one set up before DE-EA and never configured) keeps the install's offer. */
export const ORG_CHOSEN = ["chat_import", "connectors", "creative", "sales_xray"] as const satisfies readonly (keyof typeof SERVER_SWITCHED)[];
type Chosen = typeof ORG_CHOSEN[number];
/** What each plan may switch on (pulse_priv.platform_plan; a company without a plan row, such as the install's own, may
 *  have all). Trial and Starter keep to the work tools; Growth and up add connectors, history import and Sales X-Ray. */
export const PLAN_MODULES: Record<string, readonly Chosen[]> = {
  trial: ["creative"], starter: ["creative"], growth: ORG_CHOSEN, scale: ORG_CHOSEN, internal: ORG_CHOSEN, custom: ORG_CHOSEN,
};
export const planAllows = (plan: string | null | undefined, key: Chosen) => !plan || (PLAN_MODULES[plan] ?? ORG_CHOSEN).includes(key);
const switchedOn = (body: unknown): string[] => {
  const on: unknown = typeof body === "object" && body !== null ? (body as { on?: unknown }).on : undefined;
  return Array.isArray(on) ? on.filter((x): x is string => typeof x === "string") : [];
};
const serverOff = (env: NodeJS.ProcessEnv = process.env) => (Object.keys(SERVER_SWITCHED) as (keyof typeof SERVER_SWITCHED)[]).filter(key => !serverOn(key, env));
/** The chosen modules a company does not have: not offered by this install, not named by it or its pack, or not in its plan. */
export const chosenOff = (on: readonly string[], packModules: readonly string[], plan: string | null | undefined, env: NodeJS.ProcessEnv = process.env): Chosen[] =>
  ORG_CHOSEN.filter((key) => !serverOn(key, env) || !(on.includes(key) || packModules.includes(key)) || !planAllows(plan, key));

const repositoryRoot = process.env.PULSE_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../");
export const modulesSchema = JSON.parse(readFileSync(resolve(repositoryRoot, "packages/schemas/config/modules.json"), "utf8"));
const validator = new Ajv2020({ allErrors: true, strict: false }).compile(modulesSchema);

/** The `modules` object in API responses. */
export const MODULES_RESPONSE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["off"],
  properties: { off: { type: "array", items: { type: "string", enum: [...MODULE_KEYS] } } },
} as const;

/** Checks a `tenant/modules` document before it is written. */
export function validateModules(body: unknown): { valid: boolean; errors: string[] } {
  const valid = validator(body) === true;
  return { valid, errors: valid ? [] : (validator.errors ?? []).map(e => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`) };
}

/** A document that fails the schema keeps its known keys: one bad entry neither breaks sign-in nor switches the
 *  other modules back on. */
export function modulesFrom(body: unknown): Modules {
  const off: unknown = typeof body === "object" && body !== null ? (body as { off?: unknown }).off : undefined;
  return { off: Array.isArray(off) ? MODULE_KEYS.filter(key => off.includes(key)) : [] };
}

/** The organisation's switches, with the modules the server has not switched on and the organisation-only modules it
 *  has not switched on; no active document means every other module is on. */
export async function readModules(c: PoolClient, org: string): Promise<Modules> {
  const row = (await c.query(`select (select body from pulse.tenant_config
    where org_id=$1 and doc_kind='tenant' and doc_key='modules' and is_active) body,
    (select pack_key from pulse.org_pack where org_id=$1) pack, pulse.org_plan() plan`, [org])).rows[0];
  const body = row?.body;
  const on = switchedOn(body);
  const packModules = packModulesOf(row?.pack);
  const chosen = body === undefined || body === null ? [...ORG_CHOSEN] : on;
  const off = new Set<ModuleKey>([...modulesFrom(body).off, ...serverOff(), ...chosenOff(chosen, packModules, row?.plan),
    ...ORG_ONLY.filter((key) => !on.includes(key))]);
  return { off: MODULE_KEYS.filter(key => off.has(key)) };
}

export const moduleOff = (modules: Modules, key: ModuleKey) => modules.off.includes(key);

/** The API each module owns, as route prefixes (a prefix covers itself and every route below it; `:id` stands for
 *  one path segment). An off module's routes answer 404 like a route that does not exist. Every other route is
 *  always on. */
export const MODULE_API = {
  designers: ["/v1/designs", "/api/v0/designers", "/api/v0/design-deliveries"],
  map: ["/api/v0/map"],
  // Acquisition, the client portal and its delivery side (portal-routes.ts), including the lead webhook ingress.
  acquisition: ["/api/v0/acquisition", "/api/v0/portal", "/api/v0/delivery/client-access", "/api/v0/delivery/commerce",
    "/api/v0/delivery/demo-media", "/api/v0/delivery/media", "/api/v0/delivery/policy", "/api/v0/delivery/publication",
    "/api/v0/delivery/release", "/api/v0/delivery/support"],
  chats: ["/api/v0/chats", "/api/v0/groups", "/api/v0/inbox", "/api/v0/communication"],
  briefs: ["/api/v0/briefs"],
  // ERP-INVOICE (RELEASE-3): invoices, the catalogue and their exports are part of Money.
  money: ["/api/v0/finance", "/api/v0/money", "/api/v0/erp", "/api/v0/quotes"],
  hr: ["/api/v0/hr", "/api/v0/leave", "/api/v0/attendance", "/api/v0/shifts", "/api/v0/me/hr", "/api/v0/people/:id/hr",
    "/api/v0/people/:id/hr-contact", "/api/v0/people/:id/salary", "/api/v0/companion/wallet", "/api/v0/companion/late-dispute",
    // Office presence feeds attendance; the presence tick also checks the switch (migration 0153) for the worker.
    "/api/v0/companion/presence"],
  relationships: ["/api/v0/relationships"],
  skills: ["/api/v0/skills", "/api/v0/people/:id/skills", "/api/v0/people/:id/cv", "/api/v0/people/:id/experience"],
  jobs: ["/api/v0/ats"],
  // The preview and the import; a conversation's imported history stays readable by its members (none without imports).
  chat_import: ["/api/v0/chats/imports"],
  // R52: install, grant, health and revoke of a company's own connectors (the ingest route has its own switch).
  connectors: ["/api/v0/connectors"],
  // EST-1474: creative sprints and CS Home.
  creative: ["/api/v0/creative"],
  // EST-1363: each person's own Sales X-Ray connection, its reads, the MCP gateway and Ask.
  sales_xray: ["/api/v0/sales-xray"],
  // PULSE-HQ: the business of Pulse (catalogue, ideas, Offer Studio, brand); the Pulse organisation only.
  pulse_hq: ["/api/v0/hq"],
} as const satisfies Record<ModuleKey, readonly string[]>;

const segments = (path: string) => path.split("/").map(part => part.startsWith(":") ? ":" : part);
// The longest prefix decides (/api/v0/chats/imports is chat_import's, the rest of /api/v0/chats is chats').
const MODULE_PREFIXES = MODULE_KEYS.flatMap(key => MODULE_API[key].map(prefix => ({ key, parts: segments(prefix) })))
  .sort((a, b) => b.parts.length - a.parts.length);

/** The module that owns a registered route (its pattern, such as `/api/v0/hr/tickets/:id`), or null when the route is
 *  always on. */
export function moduleForRoute(route: string | undefined): ModuleKey | null {
  if (!route) return null;
  const parts = segments(route);
  return MODULE_PREFIXES.find(prefix => prefix.parts.length <= parts.length
    && prefix.parts.every((part, i) => part === parts[i]))?.key ?? null;
}
