// EST-1407 (hand-off #3, contract 1.0.0-rc.1 §1): Settings → Site visit. An organisation's visit types, the
// fields a visit asks a photo for, and which items the photo banner carries, kept as numbered versions: every save adds
// version+1 and nothing is overwritten, so a visit keeps the field set it started with (EST-1408). A key is fixed at
// creation and never removed or reused: removing means archiving (a save that leaves a key out is refused with 422), and
// a save made from an older version is refused with 409. Example images arrive with the upload route (EST-1409); until
// then exampleImageId stays null. Only an admin saves; everyone who works with customers reads.
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { admin, fail, work, type Tx } from "./routes.js";

const KEY = { type: "string", pattern: "^[a-z0-9_]{1,40}$" } as const;
export const SITE_VISIT_SETTINGS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["fieldSetVersion", "visitTypes", "fields", "banner"],
  properties: {
    fieldSetVersion: { type: "integer", minimum: 1 },
    visitTypes: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: false, required: ["key", "label", "state", "position"],
      properties: { key: KEY, label: { type: "string", minLength: 1, maxLength: 60 }, state: { enum: ["active", "archived"] }, position: { type: "integer", minimum: 0, maximum: 999 } } } },
    fields: { type: "array", maxItems: 60, items: { type: "object", additionalProperties: false,
      required: ["key", "label", "hint", "exampleImageId", "required", "maxPhotos", "position", "state", "appliesTo"],
      properties: { key: KEY, label: { type: "string", minLength: 1, maxLength: 80 }, hint: { type: ["string", "null"], maxLength: 300 },
        exampleImageId: { type: "null" }, required: { type: "boolean" }, maxPhotos: { type: "integer", minimum: 1, maximum: 20 },
        position: { type: "integer", minimum: 0, maximum: 999 }, state: { enum: ["active", "hidden", "archived"] },
        appliesTo: { type: ["array", "null"], uniqueItems: true, maxItems: 20, items: KEY } } } },
    banner: { type: "object", additionalProperties: false, required: ["logo", "coordinates", "siteAddress", "dateTime", "fieldLabel", "customer", "employee"],
      properties: Object.fromEntries(["logo", "coordinates", "siteAddress", "dateTime", "fieldLabel", "customer", "employee"].map((k) => [k, { type: "boolean" }])) },
  },
} as const;
const validator = new Ajv2020({ allErrors: true, strict: false }).compile(SITE_VISIT_SETTINGS_SCHEMA);

type VisitType = { key: string; label: string; state: "active" | "archived"; position: number };
type Field = { key: string; label: string; hint: string | null; exampleImageId: null; required: boolean; maxPhotos: number; position: number;
  state: "active" | "hidden" | "archived"; appliesTo: string[] | null };
export type SiteVisitSettings = { fieldSetVersion: number; visitTypes: VisitType[]; fields: Field[];
  banner: Record<"logo" | "coordinates" | "siteAddress" | "dateTime" | "fieldLabel" | "customer" | "employee", boolean> };

/** Version 1 of every organisation: the three visit types the contract seeds, no fields yet, every banner item on. */
export const SITE_VISIT_DEFAULTS: SiteVisitSettings = {
  fieldSetVersion: 1,
  visitTypes: [{ key: "survey", label: "Site survey", state: "active", position: 0 }, { key: "installation", label: "Installation", state: "active", position: 1 },
    { key: "service", label: "Service", state: "active", position: 2 }],
  fields: [],
  banner: { logo: true, coordinates: true, siteAddress: true, dateTime: true, fieldLabel: true, customer: true, employee: true },
};

/** What is wrong with a save made on top of `current`: the shape (400), a stale version (409) or keys left out (422). */
export function checkSave(current: SiteVisitSettings, next: unknown): { status: 400 | 409 | 422; error: string; keys?: string[] } | null {
  if (validator(next) !== true) return { status: 400, error: `Not saved: ${(validator.errors ?? []).slice(0, 1).map((e) => `${e.instancePath || "/"} ${e.message}`).join("")}` };
  const n = next as SiteVisitSettings;
  const dup = (keys: string[]) => keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dup(n.visitTypes.map((t) => t.key)).length || dup(n.fields.map((f) => f.key)).length) return { status: 400, error: "Each key may appear once" };
  if (!n.visitTypes.some((t) => t.state === "active")) return { status: 400, error: "Keep at least one visit type active" };
  const types = new Set(n.visitTypes.map((t) => t.key));
  if (n.fields.some((f) => f.appliesTo?.some((k) => !types.has(k)))) return { status: 400, error: "A field can apply only to this organisation's visit types" };
  if (n.fieldSetVersion !== current.fieldSetVersion) return { status: 409, error: "Someone saved these settings since you opened them: reload and try again" };
  const missing = [...current.visitTypes.map((t) => t.key).filter((k) => !types.has(k)), ...current.fields.map((f) => f.key).filter((k) => !n.fields.some((f) => f.key === k))];
  if (missing.length) return { status: 422, error: "Keys are never removed: archive a field or visit type instead", keys: missing };
  return null;
}

export async function readSiteVisitSettings(c: PoolClient): Promise<SiteVisitSettings> {
  const row = (await c.query("select version,body from pulse.site_visit_field_set where org_id=pulse.current_org() order by version desc limit 1")).rows[0];
  return row ? { ...row.body, fieldSetVersion: row.version } : SITE_VISIT_DEFAULTS;
}

export function registerSiteVisitSettings(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get("/api/v0/settings/site-visit", (req) => tx(req, async (c, v) => { work(v); return { ...(await readSiteVisitSettings(c)), canEdit: admin(v) && !!v.person }; }));
  app.put("/api/v0/settings/site-visit", (req, reply) => tx(req, async (c, v) => {
    if (!admin(v) || !v.person) fail(403, "An organisation admin changes the site-visit settings");
    const current = await readSiteVisitSettings(c), problem = checkSave(current, req.body);
    if (problem?.status === 422) return reply.code(422).send({ error: "keys_removed", message: problem.error, keys: problem.keys });
    if (problem?.status === 409) fail(409, "Someone saved these settings since you opened them: reload and try again");
    if (problem) fail(400, problem.error);
    const { fieldSetVersion, ...body } = req.body as SiteVisitSettings;
    const version = (await c.query("select pulse.site_visit_settings_save($1,$2::jsonb) v", [fieldSetVersion, JSON.stringify(body)])).rows[0].v as number;
    return { ...body, fieldSetVersion: version, canEdit: true };
  }));
}
