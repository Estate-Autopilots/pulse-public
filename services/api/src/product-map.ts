// PRODUCT-MAP (owner, 25 Oct 2026): the Product map, for any organisation building software. A product (Product Story's
// story_product) is connected through sources (repo scan, live crawl, manifest, telemetry, push); Pulse keeps its
// screens, elements, links, features, user types, journeys, issues and ideas (migration 1010), proposes user types and
// journeys and finds issues (product-map-model.ts, pure), runs an AI pass through an AI employee's runtime within a
// budget, and gives the build team and AI agents the plan (Markdown and JSON) with a read token.
// Everyone in the organisation reads and edits; its leaders remove things and manage tokens; whoever added a journey
// or an idea may remove it too.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { type Agent, agentTxFor } from "./agents.js";
import { loadKeyring, open as unseal, seal, type Sealed } from "./document-keys.js";
import { fail, leadership, type Open, type Tx, type Viewer } from "./routes.js";
import { publicAddress } from "./safe-outbound.js";
import { scanRepo } from "./product-map-scan.js";
import {
  AI_INSTRUCTIONS, aiApply, aiBrief, analyse, autoFeatures, autoJourneys, autoPersonas, ELEMENT_KINDS, FREQUENCY, hash, ISSUE_KINDS, journeyFields, JOURNEY_STATUS, LIMITS, mineUsage,
  normalizeManifest, personaFields, planSpec, PRIORITY, routeKey, screenFor, slug, specMarkdown, stepsOf, type IdeaLite, type IssueLite, type Manifest, type MapData, type MJourney,
  type MPersona, type Role, type UseEvent,
} from "./product-map-model.js";

type Body = Record<string, unknown>;
const body = { type: "object", maxProperties: 40 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SOURCE_KINDS = ["repo", "crawl", "manifest", "telemetry", "push"] as const;
export const TOKEN = /^pmap_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
const AI_DAILY_JOBS = 12;
const AI_MAX_OUT = 6000;

const str = (x: unknown, max: number) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const text = (x: unknown, max: number) => String(x ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
const has = (b: Body, k: string) => Object.prototype.hasOwnProperty.call(b, k);
const id = (x: unknown, what = "Not found") => UUID.test(String(x)) ? String(x) : fail(404, what);
const pick = <T extends string>(x: unknown, list: readonly T[], fallback: T): T => (list as readonly string[]).includes(String(x)) ? String(x) as T : fallback;
const strings = (x: unknown, max: number, each: number) => Array.isArray(x) ? [...new Set(x.map((s) => str(s, each)).filter(Boolean))].slice(0, max) : [];
const person = (v: Viewer) => { if (!v.person) fail(403, "The Product map belongs to the people of an organisation."); return v.person; };
const lead = (v: Viewer) => { if (!leadership(v)) fail(403, "Only the organisation’s leaders remove this."); };
const j = (x: unknown) => JSON.stringify(x ?? null);

// ------------------------------------------------------------------------------------------------ server settings
/** The checkouts this server may scan, by key: PULSE_PRODUCT_MAP_REPOS="pulse=/srv/pulse,shop=/srv/shop". Pulse's own
 *  checkout is "pulse" when the API runs from one. A person names a key, never a path. */
export function repoRoots(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(env.PULSE_PRODUCT_MAP_REPOS ?? "").split(",")) {
    const [k, ...rest] = part.split("="); const key = slug(k, 40), dir = rest.join("=").trim();
    if (key && dir.startsWith("/") && existsSync(dir)) out[key] = resolve(dir);
  }
  if (!out.pulse) for (const d of [cwd, resolve(cwd, "../..")]) if (existsSync(join(d, "apps/web/app")) && existsSync(join(d, "services/api"))) { out.pulse = d; break; }
  return out;
}
const here = dirname(fileURLToPath(import.meta.url));
/** Playwright for the live crawl: PULSE_PLAYWRIGHT names its module, else the repository's e2e copy when present. */
export function playwrightModule(env: NodeJS.ProcessEnv = process.env) {
  const c = [env.PULSE_PLAYWRIGHT, resolve(here, "../../../tests/e2e/node_modules/@playwright/test/index.mjs")].filter((x): x is string => !!x);
  return c.find((p) => existsSync(p)) ?? null;
}

/** Queries one after another on the transaction's one client (pg queues overlapping queries now and refuses them in pg 9). */
async function inOrder<T extends readonly (() => Promise<unknown>)[]>(fns: T): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const out: unknown[] = []; for (const f of fns) out.push(await f()); return out as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

// ---------------------------------------------------------------------------------------------------- reading a map
type Loaded = { data: MapData; ids: { screens: Map<string, string> }; sources: Record<string, unknown>[] };
const PRODUCTS = `select p.id, p.name, p.blurb, p.repo_url "repoUrl",
  (select count(*)::int from pulse.product_map_screen s where s.product_id = p.id and s.status <> 'removed') screens,
  (select count(*)::int from pulse.product_map_journey x where x.product_id = p.id) journeys,
  (select count(*)::int from pulse.product_map_persona x where x.product_id = p.id) personas,
  (select count(*)::int from pulse.product_map_issue x where x.product_id = p.id and x.status = 'open') issues,
  (select count(*)::int from pulse.product_map_idea x where x.product_id = p.id and x.status not in ('shipped','parked')) ideas,
  (select coalesce(array_agg(distinct x.kind), '{}') from pulse.product_map_source x where x.product_id = p.id) "sourceKinds",
  (select max(x.last_run_at) from pulse.product_map_source x where x.product_id = p.id) "lastRunAt"
  from pulse.story_product p order by p.sort, lower(p.name)`;

async function product(c: PoolClient, pid: string) {
  const r = (await c.query("select id, name, blurb, repo_url \"repoUrl\" from pulse.story_product where id = $1", [id(pid, "Product not found")])).rows[0];
  return r ?? fail(404, "Product not found");
}
async function sourceRows(c: PoolClient, pid: string) {
  return (await c.query(`select id, kind, label, config, status, last_run_at "lastRunAt", last_result "lastResult", secret is not null "hasSecret", created_at "createdAt"
    from pulse.product_map_source where product_id = $1 order by created_at`, [pid])).rows as Record<string, unknown>[];
}
/** The whole map of a product as the pure model reads it, with the rows' ids. */
async function loadMap(c: PoolClient, pid: string): Promise<Loaded> {
  const p = await product(c, pid);
  const [screens, elements, edges, features, personas, journeys, sources] = await inOrder([
    () => c.query(`select id, key, route, title, purpose, area, access, proposed, status, sources, meta from pulse.product_map_screen where product_id = $1 order by key`, [pid]),
    () => c.query(`select e.screen_id, s.key screen, e.kind, e.label, e.target, e.destructive, e.proposed, e.meta from pulse.product_map_element e join pulse.product_map_screen s on s.id = e.screen_id where e.product_id = $1`, [pid]),
    () => c.query(`select from_key "from", to_key "to", kind, label, count, median_ms "medianMs" from pulse.product_map_edge where product_id = $1`, [pid]),
    () => c.query(`select key, name, description, screens, proposed, origin from pulse.product_map_feature where product_id = $1 order by sort, name`, [pid]),
    () => c.query(`select key, name, role, description, goals, age_group "ageGroup", skill_level "skillLevel", tech_comfort "techComfort", frequency, device, permissions, features, evidence, confidence, origin
      from pulse.product_map_persona where product_id = $1 order by sort, name`, [pid]),
    () => c.query(`select key, persona_key "personaKey", title, goal, status, steps, evidence, confidence, usage, origin, priority, acceptance from pulse.product_map_journey where product_id = $1 order by created_at`, [pid]),
    () => sourceRows(c, pid)] as const);
  const roles = new Map<string, Role>(); const entries = new Set<string>();
  for (const s of sources) { const r = (s.lastResult ?? {}) as { roles?: Role[]; entries?: string[] }; for (const x of r.roles ?? []) if (!roles.has(x.key)) roles.set(x.key, x); for (const e of r.entries ?? []) entries.add(e); }
  const data: MapData = {
    name: p.name, roles: [...roles.values()], entries: [...entries],
    screens: screens.rows.map((s) => ({ key: s.key, route: s.route, title: s.title, purpose: s.purpose, area: s.area, access: s.access, proposed: s.proposed, status: s.status })),
    elements: elements.rows.map((e) => ({ screen: e.screen, kind: e.kind, label: e.label, target: e.target, destructive: e.destructive, proposed: e.proposed, handler: e.meta?.handler === false ? false : undefined })),
    edges: edges.rows, features: features.rows, personas: personas.rows as MPersona[], journeys: journeys.rows as MJourney[],
  };
  return { data, ids: { screens: new Map(screens.rows.map((s) => [s.key as string, s.id as string])) }, sources };
}

// ---------------------------------------------------------------------------------------------- merging a manifest
const elementKey = (e: { kind: string; label: string; target: string }) => `${e.kind}|${e.label}|${e.target}`.toLowerCase().slice(0, 300);
/** Writes a manifest from one source into the map. What people edited by hand stays (meta.edited); screens the source no
 *  longer has lose it, and a screen no source has any more is marked removed. A proposed screen the code now has is
 *  built: it becomes live. */
async function applyManifest(c: PoolClient, pid: string, tag: string, m: Manifest) {
  const screens = m.screens.map((s) => ({ key: s.key, route: s.route || (s.key.startsWith("/") ? s.key : ""), title: s.title, purpose: s.purpose, area: s.area, access: s.access, meta: s.meta }));
  await c.query(`insert into pulse.product_map_screen (org_id, product_id, key, route, title, purpose, area, access, sources, meta)
    select pulse.current_org(), $1, x.key, x.route, x.title, x.purpose, x.area, x.access, array[$2], coalesce(x.meta, '{}')
      from jsonb_to_recordset($3::jsonb) x(key text, route text, title text, purpose text, area text, access text[], meta jsonb)
    on conflict (org_id, product_id, key) do update set
      route = excluded.route,
      title = case when pulse.product_map_screen.meta->'edited' ? 'title' or excluded.title = '' then pulse.product_map_screen.title else excluded.title end,
      purpose = case when pulse.product_map_screen.meta->'edited' ? 'purpose' or excluded.purpose = '' then pulse.product_map_screen.purpose else excluded.purpose end,
      area = case when pulse.product_map_screen.meta->'edited' ? 'area' or excluded.area = '' then pulse.product_map_screen.area else excluded.area end,
      access = case when pulse.product_map_screen.meta->'edited' ? 'access' or cardinality(excluded.access) = 0 then pulse.product_map_screen.access else excluded.access end,
      sources = array(select distinct unnest(pulse.product_map_screen.sources || excluded.sources)),
      meta = pulse.product_map_screen.meta || excluded.meta,
      proposed = false, status = 'live', last_seen = now(), updated_at = now()`, [pid, tag, j(screens)]);
  const keys = screens.map((s) => s.key);
  await c.query(`update pulse.product_map_screen set sources = array_remove(sources, $2), updated_at = now() where product_id = $1 and $2 = any(sources) and not (key = any($3))`, [pid, tag, keys]);
  await c.query(`update pulse.product_map_screen set status = 'removed', updated_at = now() where product_id = $1 and cardinality(sources) = 0 and not proposed and status = 'live'`, [pid]);
  // Elements and links: this source's are replaced as a whole.
  await c.query(`update pulse.product_map_element set sources = array_remove(sources, $2) where product_id = $1 and $2 = any(sources)`, [pid, tag]);
  const seenEl = new Set<string>();
  const els = m.screens.flatMap((s) => s.elements.map((e) => ({ screen: s.key, key: elementKey(e), kind: e.kind, label: e.label, target: e.target, destructive: e.destructive, meta: e.handler === false ? { handler: false } : {} })))
    .filter((e) => { const k = `${e.screen}
${e.key}`; if (seenEl.has(k)) return false; seenEl.add(k); return true; });
  const seenEdge = new Set<string>();
  const edges = m.edges.filter((e) => { const k = `${e.from}
${e.to}
${e.kind}`; if (seenEdge.has(k)) return false; seenEdge.add(k); return true; });
  for (let i = 0; i < els.length; i += 2000) {
    await c.query(`insert into pulse.product_map_element (org_id, product_id, screen_id, key, kind, label, target, destructive, sources, meta)
      select pulse.current_org(), $1, s.id, x.key, x.kind, x.label, x.target, x.destructive, array[$2], x.meta
        from jsonb_to_recordset($3::jsonb) x(screen text, key text, kind text, label text, target text, destructive boolean, meta jsonb)
        join pulse.product_map_screen s on s.product_id = $1 and s.key = x.screen
      on conflict (org_id, screen_id, key) do update set kind = excluded.kind, label = excluded.label, target = excluded.target, destructive = excluded.destructive,
        sources = array(select distinct unnest(pulse.product_map_element.sources || excluded.sources)), meta = pulse.product_map_element.meta || excluded.meta, proposed = false, updated_at = now()`,
    [pid, tag, j(els.slice(i, i + 2000))]);
  }
  await c.query(`delete from pulse.product_map_element where product_id = $1 and cardinality(sources) = 0 and not proposed`, [pid]);
  await c.query(`update pulse.product_map_edge set sources = array_remove(sources, $2) where product_id = $1 and $2 = any(sources) and kind <> 'usage'`, [pid, tag]);
  await c.query(`insert into pulse.product_map_edge (org_id, product_id, from_key, to_key, kind, label, sources)
    select pulse.current_org(), $1, x."from", x."to", x.kind, x.label, array[$2] from jsonb_to_recordset($3::jsonb) x("from" text, "to" text, kind text, label text)
    on conflict (org_id, product_id, from_key, to_key, kind) do update set label = case when excluded.label <> '' then excluded.label else pulse.product_map_edge.label end,
      sources = array(select distinct unnest(pulse.product_map_edge.sources || excluded.sources)), updated_at = now()`, [pid, tag, j(edges)]);
  await c.query(`delete from pulse.product_map_edge where product_id = $1 and cardinality(sources) = 0 and kind not in ('usage','proposed')`, [pid]);
  if (m.features.length) await c.query(`insert into pulse.product_map_feature (org_id, product_id, key, name, description, screens, origin, sort)
    select pulse.current_org(), $1, x.key, x.name, x.description, x.screens, 'scan', x.n from jsonb_to_recordset($2::jsonb) x(key text, name text, description text, screens text[], n int)
    on conflict (org_id, product_id, key) do update set name = excluded.name, description = excluded.description, screens = excluded.screens, updated_at = now()
      where pulse.product_map_feature.origin in ('scan','auto')`, [pid, j(m.features.map((f, n) => ({ ...f, n })))]);
  for (const p of m.personas) await upsertPersona(c, pid, { ...personaFields(p), origin: "scan" }, ["scan", "auto"]);
  for (const x of m.journeys) await upsertJourney(c, pid, { ...(x as MJourney), origin: "scan", status: x.status ?? "drafted", evidence: [], confidence: null, usage: {}, priority: x.priority ?? "", acceptance: x.acceptance ?? [] }, ["scan"]);
}

async function upsertPersona(c: PoolClient, pid: string, p: MPersona, replaceOrigins: string[]) {
  await c.query(`insert into pulse.product_map_persona (org_id, product_id, key, name, role, description, goals, age_group, skill_level, tech_comfort, frequency, device, permissions, features, evidence, confidence, origin)
    values (pulse.current_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    on conflict (org_id, product_id, key) do update set name = case when pulse.product_map_persona.origin = 'ai' and excluded.origin <> 'ai' then pulse.product_map_persona.name else excluded.name end,
      origin = case when excluded.origin = 'ai' then 'ai' else pulse.product_map_persona.origin end, role = excluded.role, description = case when excluded.description <> '' then excluded.description else pulse.product_map_persona.description end,
      goals = case when cardinality(excluded.goals) > 0 then excluded.goals else pulse.product_map_persona.goals end,
      age_group = case when excluded.age_group <> '' then excluded.age_group else pulse.product_map_persona.age_group end,
      skill_level = case when excluded.skill_level <> '' then excluded.skill_level else pulse.product_map_persona.skill_level end,
      tech_comfort = case when excluded.tech_comfort <> '' then excluded.tech_comfort else pulse.product_map_persona.tech_comfort end,
      frequency = case when excluded.frequency <> '' then excluded.frequency else pulse.product_map_persona.frequency end,
      device = case when excluded.device <> '' then excluded.device else pulse.product_map_persona.device end,
      permissions = excluded.permissions, features = excluded.features, evidence = excluded.evidence, confidence = excluded.confidence, updated_at = now()
      where pulse.product_map_persona.origin = any($17)`,
  [pid, p.key, p.name, p.role, p.description, p.goals, p.ageGroup, p.skillLevel, p.techComfort, p.frequency, p.device, p.permissions.slice(0, 300), p.features.slice(0, 100), j(p.evidence), p.confidence, p.origin, replaceOrigins]);
}
async function upsertJourney(c: PoolClient, pid: string, x: MJourney, replaceOrigins: string[]) {
  await c.query(`insert into pulse.product_map_journey (org_id, product_id, key, persona_key, title, goal, status, steps, evidence, confidence, usage, origin, priority, acceptance)
    values (pulse.current_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    on conflict (org_id, product_id, key) do update set persona_key = excluded.persona_key, title = excluded.title, goal = excluded.goal, steps = excluded.steps, evidence = excluded.evidence,
      confidence = excluded.confidence, usage = excluded.usage, updated_at = now()
      where pulse.product_map_journey.origin = any($14) and pulse.product_map_journey.status in ('discovered','auto','drafted')`,
  [pid, x.key.slice(0, 120), x.personaKey, x.title.slice(0, 160), x.goal, x.status, j(x.steps), j(x.evidence), x.confidence, j(x.usage ?? {}), x.origin, x.priority ?? "", x.acceptance ?? [], replaceOrigins]);
}

// --------------------------------------------------------------------------------------------------- extractors
async function telemetryEvents(c: PoolClient): Promise<UseEvent[]> {
  const r = await c.query(`select session_id, person_id, role, device, (extract(epoch from at) * 1000)::float8 at, kind, page, duration_ms, status from pulse.telemetry_event
    where source = 'client' and at > now() - interval '30 days' and page is not null and (kind in ('nav.load','nav.route','api') or kind like 'error.%') order by at limit 300000`);
  return r.rows.map((e) => ({ session: e.session_id, person: e.person_id, role: e.role, device: e.device, at: Number(e.at), kind: e.kind, page: e.page, ms: e.duration_ms, status: e.status }));
}
/** Telemetry as a source: screens people really open (added when no other source has them), how often people move
 *  from one to another (usage links with counts) and each screen's use (views, people, load time, errors). */
async function runTelemetry(c: PoolClient, pid: string) {
  const events = await telemetryEvents(c);
  const known = (await c.query("select key from pulse.product_map_screen where product_id = $1 and status <> 'removed'", [pid])).rows.map((r) => r.key as string);
  const pages = [...new Set(events.filter((e) => e.kind === "nav.load" || e.kind === "nav.route").map((e) => routeKey(e.page)))].filter((k) => k && !screenFor(k, known));
  const fresh = pages.slice(0, 300).map((k) => ({ key: k, route: k, title: k.split("/").filter((x) => x && !x.startsWith(":")).at(-1)?.replace(/[-_]/g, " ").replace(/\b\w/g, (x) => x.toUpperCase()) ?? "Home" }));
  if (fresh.length) await c.query(`insert into pulse.product_map_screen (org_id, product_id, key, route, title, sources)
    select pulse.current_org(), $1, x.key, x.route, x.title, array['telemetry'] from jsonb_to_recordset($2::jsonb) x(key text, route text, title text) on conflict do nothing`, [pid, j(fresh)]);
  const keys = [...known, ...fresh.map((f) => f.key)];
  const u = mineUsage(events, keys, { minSessions: 3, days: 30 });
  await c.query("delete from pulse.product_map_edge where product_id = $1 and kind = 'usage'", [pid]);
  const moves = u.transitions.filter((t) => t.count >= 2).slice(0, 1500);
  if (moves.length) await c.query(`insert into pulse.product_map_edge (org_id, product_id, from_key, to_key, kind, count, median_ms, sources)
    select pulse.current_org(), $1, x."from", x."to", 'usage', x.count, x.ms, array['telemetry'] from jsonb_to_recordset($2::jsonb) x("from" text, "to" text, count int, ms int) on conflict do nothing`,
  [pid, j(moves.map((t) => ({ from: t.from, to: t.to, count: t.count, ms: t.medianMs })))]);
  await c.query(`update pulse.product_map_screen s set meta = s.meta || jsonb_build_object('use', x.use), sources = array(select distinct unnest(s.sources || array['telemetry']))
    from jsonb_to_recordset($2::jsonb) x(key text, use jsonb) where s.product_id = $1 and s.key = x.key`, [pid, j(Object.entries(u.screens).map(([key, use]) => ({ key, use })))]);
  const roles = Object.keys(u.roles).map((k) => ({ key: k, name: k.replace(/[-_]/g, " ").replace(/\b\w/g, (x) => x.toUpperCase()), description: "" }));
  return { usage: u, result: { sessions: u.sessions, days: u.days, screensSeen: Object.keys(u.screens).length, newScreens: fresh.length, moves: moves.length, paths: u.paths.length, roles: roles.slice(0, 20) } };
}

/** GET a manifest over HTTPS from a public address only (no redirects, 2 MB at most, 8 s). */
export async function fetchManifest(raw: string, resolveHost = lookup): Promise<unknown> {
  let url: URL; try { url = new URL(raw); } catch { fail(400, "Give the manifest’s https address"); }
  if (url!.protocol !== "https:" || url!.username || url!.password || (url!.port && url!.port !== "443")) fail(400, "The manifest must be on an https address");
  const host = url!.hostname.replace(/^\[|\]$/g, "");
  const addrs = await resolveHost(host, { all: true, verbatim: true }).catch(() => fail(400, "That address does not resolve"));
  if (!addrs.length || addrs.some((a) => !publicAddress(a.address))) fail(400, "That address is not on the public internet");
  const pinned = addrs[0];
  return new Promise((accept, reject) => {
    const req = httpsRequest(url!, { method: "GET", agent: false, timeout: 8000, headers: { accept: "application/json", "user-agent": "Pulse-Product-Map/1" },
      lookup: (_h: string, _o: unknown, done: (e: Error | null, a: string, f: number) => void) => done(null, pinned.address, pinned.family) } as never, (res) => {
      if ((res.statusCode ?? 0) !== 200) { res.destroy(); reject(Object.assign(new Error(`The manifest answered ${res.statusCode}`), { statusCode: 400, expose: true })); return; }
      const parts: Buffer[] = []; let n = 0;
      res.on("data", (d: Buffer) => { n += d.length; if (n > 2_000_000) { res.destroy(); reject(Object.assign(new Error("The manifest is larger than 2 MB"), { statusCode: 400, expose: true })); } else parts.push(d); });
      res.on("end", () => { try { accept(JSON.parse(Buffer.concat(parts).toString("utf8"))); } catch { reject(Object.assign(new Error("The manifest is not JSON"), { statusCode: 400, expose: true })); } });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("The manifest did not answer in time"), { statusCode: 400, expose: true })));
    req.on("error", (e) => reject((e as { statusCode?: number }).statusCode ? e : Object.assign(new Error("The manifest could not be read"), { statusCode: 400, expose: true })));
    req.end();
  });
}

/** The product's one push source (a pasted or pushed manifest) records the last push: its roles and entries count. */
async function notePush(c: PoolClient, pid: string, label: string, m: { manifest: Manifest; warnings: string[] }) {
  const result = j({ screens: m.manifest.screens.length, roles: m.manifest.roles, entries: m.manifest.entries, warnings: m.warnings.slice(0, 10) });
  const src = (await c.query("select id from pulse.product_map_source where product_id = $1 and kind = 'push' order by created_at limit 1", [pid])).rows[0];
  if (src) await c.query("update pulse.product_map_source set status = 'ok', label = $3, last_run_at = now(), last_result = $2, updated_at = now() where id = $1", [src.id, result, label]);
  else await c.query("insert into pulse.product_map_source (org_id, product_id, kind, label, status, last_run_at, last_result) values (pulse.current_org(), $1, 'push', $3, 'ok', now(), $2)", [pid, result, label]);
}

/** The map with its real use when a telemetry source is connected (the AI pass's brief reads both). */
async function loadWithUse(c: PoolClient, pid: string): Promise<Loaded> {
  const l = await loadMap(c, pid);
  if (l.sources.some((x) => x.kind === "telemetry")) l.data.usage = mineUsage(await telemetryEvents(c), l.data.screens.filter((x) => x.status !== "removed").map((x) => x.key));
  return l;
}

// --------------------------------------------------------------------------------------------------- the analysis
/** Proposes features (when none), user types and journeys, and finds issues; what people made or edited stays. */
async function analyseProduct(c: PoolClient, pid: string, usage?: MapData["usage"]) {
  let { data, sources } = await loadMap(c, pid);
  if (usage === undefined && sources.some((s) => s.kind === "telemetry")) {
    const keys = data.screens.filter((s) => s.status !== "removed").map((s) => s.key);
    usage = mineUsage(await telemetryEvents(c), keys);
  }
  data = { ...data, usage: usage ?? null };
  if (!data.features.length) {
    const feats = autoFeatures(data);
    if (feats.length) await c.query(`insert into pulse.product_map_feature (org_id, product_id, key, name, description, screens, origin, sort)
      select pulse.current_org(), $1, x.key, x.name, '', x.screens, 'auto', x.n from jsonb_to_recordset($2::jsonb) x(key text, name text, screens text[], n int) on conflict do nothing`,
    [pid, j(feats.map((f, n) => ({ ...f, n })))]);
    data.features = feats;
  }
  const personas = autoPersonas(data);
  for (const p of personas) await upsertPersona(c, pid, p, ["auto", "ai"]);
  const people = (await c.query(`select key, name, role, description, goals, age_group "ageGroup", skill_level "skillLevel", tech_comfort "techComfort", frequency, device, permissions, features, evidence, confidence, origin
    from pulse.product_map_persona where product_id = $1`, [pid])).rows as MPersona[];
  data.personas = people;
  const journeys = autoJourneys(data, people.filter((p) => p.origin !== "ai" || data.roles.some((r) => r.key === p.role)));
  for (const x of journeys) await upsertJourney(c, pid, x, ["auto", "telemetry"]);
  await c.query(`delete from pulse.product_map_journey where product_id = $1 and origin in ('auto','telemetry') and status in ('auto','discovered') and not (key = any($2))`, [pid, journeys.map((x) => x.key)]);
  data.journeys = (await c.query(`select key, persona_key "personaKey", title, goal, status, steps, evidence, confidence, usage, origin, priority, acceptance from pulse.product_map_journey where product_id = $1`, [pid])).rows as MJourney[];
  const issues = analyse(data);
  await c.query(`insert into pulse.product_map_issue (org_id, product_id, fingerprint, kind, severity, title, detail, screen_key, journey_key, evidence, confidence, origin)
    select pulse.current_org(), $1, x.fingerprint, x.kind, x.severity, x.title, x.detail, x."screenKey", x."journeyKey", x.evidence, x.confidence, 'auto'
      from jsonb_to_recordset($2::jsonb) x(fingerprint text, kind text, severity text, title text, detail text, "screenKey" text, "journeyKey" text, evidence jsonb, confidence real)
    on conflict (org_id, product_id, fingerprint) do update set severity = excluded.severity, title = excluded.title, detail = excluded.detail, evidence = excluded.evidence,
      confidence = excluded.confidence, seen_at = now(), updated_at = now(), status = case when pulse.product_map_issue.status = 'fixed' then 'open' else pulse.product_map_issue.status end`,
  [pid, j(issues)]);
  // Found before and not now: fixed (a person's own issues and the AI's stay as they are).
  const fixed = await c.query(`update pulse.product_map_issue set status = 'fixed', updated_at = now() where product_id = $1 and origin = 'auto' and status in ('open','accepted') and not (fingerprint = any($2))`,
    [pid, issues.map((i) => i.fingerprint)]);
  return { personas: personas.length, journeys: journeys.length, issues: issues.length, fixed: fixed.rowCount ?? 0, features: data.features.length, usage: usage ? { sessions: usage.sessions, paths: usage.paths.length } : null };
}

/** Runs one source now (the crawl is started and reports later); then the analysis. */
async function runSource(c: PoolClient, v: Viewer | null, pid: string, sid: string, deps: { crawl: (org: string, pid: string, sid: string) => Promise<void> }) {
  const s = (await c.query("select id, kind, config, secret from pulse.product_map_source where id = $1 and product_id = $2 for update", [sid, pid])).rows[0] ?? fail(404, "Source not found");
  const started = Date.now();
  await c.query("savepoint product_map_run");
  try {
    let result: Record<string, unknown> = {}; let usage: MapData["usage"] | undefined;
    if (s.kind === "repo") {
      const roots = repoRoots(); const root = roots[String(s.config?.repo ?? "")];
      if (!root) fail(400, `This server has no checkout named “${str(s.config?.repo, 40)}”. Run the scanner where the code is and push its manifest, or ask the server admin to add it (PULSE_PRODUCT_MAP_REPOS).`);
      const scan = scanRepo(root, str(s.config?.path, 200).replace(/\.\./g, ""));
      const { manifest, warnings } = normalizeManifest(scan);
      await applyManifest(c, pid, `repo:${sid.slice(0, 8)}`, manifest);
      result = { ...scan.stats, framework: scan.framework, roles: manifest.roles, entries: manifest.entries, warnings: warnings.slice(0, 10) };
    } else if (s.kind === "manifest") {
      const raw = await fetchManifest(str(s.config?.url, 300));
      const { manifest, warnings } = normalizeManifest(raw);
      await applyManifest(c, pid, `manifest:${sid.slice(0, 8)}`, manifest);
      result = { screens: manifest.screens.length, edges: manifest.edges.length, roles: manifest.roles, entries: manifest.entries, warnings: warnings.slice(0, 10) };
    } else if (s.kind === "telemetry") {
      const t = await runTelemetry(c, pid); usage = t.usage; result = t.result;
    } else if (s.kind === "crawl") {
      if (!playwrightModule()) fail(400, "Live crawl is not set up on this server (no browser). Use a repo scan or a manifest, or ask the server admin.");
      await c.query("update pulse.product_map_source set status = 'queued', updated_at = now() where id = $1", [sid]);
      await deps.crawl(String((await c.query("select pulse.current_org() o")).rows[0].o), pid, sid);
      return { status: "queued" };
    } else return { status: "ok", note: "A push source changes when its token pushes a manifest." };
    const analysis = await analyseProduct(c, pid, usage);
    await c.query(`update pulse.product_map_source set status = 'ok', last_run_at = now(), last_result = $2, updated_at = now() where id = $1`, [sid, j({ ...result, analysis, ms: Date.now() - started, by: v?.name ?? null })]);
    return { status: "ok", result, analysis };
  } catch (e) {
    // What the source did is undone; the failure itself is kept and said (a 4xx is said as it is, anything else briefly).
    await c.query("rollback to savepoint product_map_run");
    const said = (e as { statusCode?: number }).statusCode && (e as { statusCode: number }).statusCode < 500;
    const msg = said && e instanceof Error ? e.message : `The ${s.kind === "repo" ? "scan" : "run"} failed: ${(e as { code?: string }).code ?? (e instanceof Error ? e.message.slice(0, 120) : "error")}`;
    await c.query(`update pulse.product_map_source set status = 'failed', last_run_at = now(), last_result = $2, updated_at = now() where id = $1`, [sid, j({ error: msg.slice(0, 300) })]);
    return { status: "failed", error: msg };
  }
}

// ------------------------------------------------------------------------------------------------- plan and export
async function planFor(c: PoolClient, pid: string, q: { journeys?: string; version?: string }) {
  const { data } = await loadMap(c, pid);
  const version = q.version && UUID.test(q.version) ? (await c.query("select id, label, title from pulse.story_version where id = $1 and product_id = $2", [q.version, pid])).rows[0] ?? null : null;
  const all = (await c.query(`select key, persona_key "personaKey", title, goal, status, steps, evidence, confidence, usage, origin, priority, acceptance, target_version_id "targetVersionId" from pulse.product_map_journey where product_id = $1`, [pid])).rows as (MJourney & { targetVersionId: string | null })[];
  const wanted = q.journeys ? q.journeys.split(",").map((k) => k.trim()).filter(Boolean) : null;
  let chosen = wanted ? all.filter((x) => wanted.includes(x.key)) : version ? all.filter((x) => x.targetVersionId === version.id) : all.filter((x) => x.status === "planned");
  if (!wanted && !version && !chosen.length) chosen = all.filter((x) => x.status === "drafted");
  const ideasRows = (await c.query(`select i.title, i.body, i.kind, i.priority, i.status, i.screens, i.journey_key "journeyKey", i.target_version_id "targetVersionId",
      (select count(*)::int from pulse.product_map_idea_vote v where v.idea_id = i.id) votes from pulse.product_map_idea i where i.product_id = $1 and i.status in ('new','planned','building')`, [pid])).rows as IdeaLite[];
  const ideas = version ? ideasRows.filter((i) => i.targetVersionId === version.id) : ideasRows.filter((i) => i.status === "planned" || chosen.some((x) => x.key === i.journeyKey));
  const issues = (await c.query(`select kind, severity, title, detail, screen_key "screenKey", journey_key "journeyKey", status from pulse.product_map_issue where product_id = $1`, [pid])).rows as IssueLite[];
  return planSpec(data, { journeys: chosen, ideas, issues, version: version ? { label: version.label, title: version.title } : null });
}

/** What an agent sees of the map: no ids, no secrets, nothing about people. */
async function publicMap(c: PoolClient, pid: string) {
  const { data, sources } = await loadMap(c, pid);
  const issues = (await c.query(`select kind, severity, title, detail, screen_key "screenKey", journey_key "journeyKey", status, origin, confidence, evidence from pulse.product_map_issue where product_id = $1 and status in ('open','accepted')`, [pid])).rows;
  const ideas = (await c.query(`select i.title, i.body, i.kind, i.priority, i.status, i.screens, i.persona_key "personaKey", i.journey_key "journeyKey", v.label "targetVersion",
      (select count(*)::int from pulse.product_map_idea_vote x where x.idea_id = i.id) votes from pulse.product_map_idea i left join pulse.story_version v on v.id = i.target_version_id where i.product_id = $1`, [pid])).rows;
  return { schema: "pulse-product-map/1", product: data.name, roles: data.roles, entries: data.entries, sources: sources.map((s) => ({ kind: s.kind, label: s.label, lastRunAt: s.lastRunAt })),
    screens: data.screens.filter((s) => s.status !== "removed").map((s) => ({ ...s, elements: data.elements.filter((e) => e.screen === s.key).map((e) => ({ kind: e.kind, label: e.label, target: e.target, destructive: e.destructive, proposed: e.proposed })) })),
    edges: data.edges, features: data.features, personas: data.personas, journeys: data.journeys, issues, ideas };
}

export const AGENT_TOOLS = [
  { name: "product_map_get", description: "The whole product map: screens with their elements, links, features, user types, journeys, open issues and ideas.", method: "GET", path: "/api/v0/product-map/feed/map", input: {} },
  { name: "product_plan_get", description: "The plan to build: planned journeys (or those for a version) with steps, the screens they touch, proposed screens and elements, acceptance criteria, ideas and open issues.", method: "GET", path: "/api/v0/product-map/feed/plan", input: { format: "json | md", version: "Product Story version id (optional)", journeys: "comma-separated journey keys (optional)" } },
  { name: "product_map_push", description: "Push a manifest (schema pulse-product-map/1) from a build: screens, elements, links, roles. Needs a token that may push.", method: "POST", path: "/api/v0/product-map/feed/manifest", input: { manifest: "pulse-product-map/1 object" } },
  { name: "product_idea_add", description: "Add an idea or a found problem for the team to consider. Needs a token that may push.", method: "POST", path: "/api/v0/product-map/feed/ideas", input: { title: "string", body: "string", kind: "screen | feature | journey | change | fix", screens: "screen keys" } },
] as const;

// ------------------------------------------------------------------------------------------------------ the routes
const PERSONA_COLS: [string, string, (x: unknown) => unknown][] = [
  ["name", "name", (x) => { const s = str(x, 120); return s || fail(400, "Name the user type"); }], ["role", "role", (x) => str(x, 80)], ["description", "description", (x) => text(x, 1000)],
  ["goals", "goals", (x) => strings(x, 12, 200)], ["ageGroup", "age_group", (x) => str(x, 40)], ["skillLevel", "skill_level", (x) => pick(x, ["", "beginner", "intermediate", "expert"] as const, "")],
  ["techComfort", "tech_comfort", (x) => pick(x, ["", "low", "medium", "high"] as const, "")], ["frequency", "frequency", (x) => pick(x, FREQUENCY, "")],
  ["device", "device", (x) => pick(x, ["", "phone", "desktop", "both"] as const, "")], ["permissions", "permissions", (x) => strings(x, 300, 200)], ["features", "features", (x) => strings(x, 100, 80)],
];
const cols = (b: Body, spec: [string, string, (x: unknown) => unknown][]) => spec.filter(([k]) => has(b, k)).map(([k, col, f]) => [col, f(b[k])] as [string, unknown]);
async function update(c: PoolClient, table: string, rowId: string, pid: string, set: [string, unknown][], what: string) {
  if (!set.length) return;
  const r = await c.query(`update pulse.${table} set ${set.map(([col], i) => `${col} = $${i + 3}`).join(", ")}, updated_at = now() where id = $1 and product_id = $2`, [rowId, pid, ...set.map(([, x]) => x)]);
  if (!r.rowCount) fail(404, what);
}
const sendImage = (reply: FastifyReply, row: { mime: string; bytes: Buffer }) => reply.header("content-type", row.mime).header("cache-control", "private, max-age=300").header("x-content-type-options", "nosniff").send(row.bytes);

export function registerProductMapRoutes(app: FastifyInstance, { tx, open, pool }: { tx: Tx; open: Open; pool: Pool }) {
  const agentTx = agentTxFor(open);
  /** A transaction in a known organisation, outside a request (the crawl writes its result when it finishes). */
  const inOrg = async <T>(org: string, run: (c: PoolClient) => Promise<T>) => {
    const c = await pool.connect();
    try { await c.query("begin"); await c.query("select set_config('pulse.org_id', $1, true)", [org]); const r = await run(c); await c.query("commit"); return r; }
    catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
  };
  let crawling = false;
  const crawl = async (org: string, pid: string, sid: string) => {
    if (crawling) { await inOrg(org, (c) => c.query(`update pulse.product_map_source set status = 'failed', last_result = $2 where id = $1`, [sid, j({ error: "Another crawl is running on this server; try again in a few minutes." })])); return; }
    crawling = true;
    try {
      const job = await inOrg(org, async (c) => (await c.query("select config, secret from pulse.product_map_source where id = $1", [sid])).rows[0]);
      let account: Record<string, string> | null = null;
      if (job?.secret) { const ring = await loadKeyring(); if (!ring.ok) throw new Error("This server’s encryption key is not installed"); const b = job.secret as { k: string; w: string; d: string };
        account = JSON.parse(unseal(ring.ring, { keyId: b.k, dataKey: Buffer.from(b.w, "base64"), data: Buffer.from(b.d, "base64") } as Sealed, `${org}/product-map/${sid}`).toString()); }
      const out = await runCrawler({ config: job?.config ?? {}, account });
      await inOrg(org, async (c) => {
        const { manifest, warnings } = normalizeManifest(out.manifest);
        await applyManifest(c, pid, `crawl:${sid.slice(0, 8)}`, manifest);
        for (const s of out.shots ?? []) await c.query(`insert into pulse.product_map_shot (screen_id, org_id, mime, bytes, width, height)
          select id, org_id, 'image/jpeg', decode($3, 'base64'), $4, $5 from pulse.product_map_screen where product_id = $1 and key = $2
          on conflict (screen_id) do update set bytes = excluded.bytes, width = excluded.width, height = excluded.height, captured_at = now()`, [pid, s.key, s.jpeg, s.width, s.height]);
        const analysis = await analyseProduct(c, pid);
        await c.query(`update pulse.product_map_source set status = 'ok', last_run_at = now(), last_result = $2, updated_at = now() where id = $1`, [sid, j({ ...out.stats, warnings: warnings.slice(0, 10), analysis })]);
      });
    } catch (e) {
      await inOrg(org, (c) => c.query(`update pulse.product_map_source set status = 'failed', last_run_at = now(), last_result = $2, updated_at = now() where id = $1`, [sid, j({ error: (e instanceof Error ? e.message : "failed").slice(0, 300) })])).catch(() => {});
    } finally { crawling = false; }
  };
  const deps = { crawl: (org: string, pid: string, sid: string) => { void crawl(org, pid, sid); return Promise.resolve(); } };

  app.get("/api/v0/product-map", (req) => tx(req, async (c, v) => {
    person(v);
    return { canRemove: leadership(v), products: (await c.query(PRODUCTS)).rows, repos: Object.keys(repoRoots()), crawl: !!playwrightModule() };
  }));
  app.post<{ Body: Body }>("/api/v0/product-map/products", { schema: { body } }, (req) => tx(req, async (c, v) => {
    const me = person(v); const name = str(req.body.name, 80); if (name.length < 2) fail(400, "Name the app or product");
    try {
      const r = await c.query(`insert into pulse.story_product(org_id, name, blurb, repo_url, sort, created_by)
        values (pulse.current_org(), $1, $2, $3, coalesce((select max(sort) + 1 from pulse.story_product), 0), $4) returning id`, [name, text(req.body.blurb, 600), null, me]);
      return { id: r.rows[0].id };
    } catch (e) { if ((e as { code?: string }).code === "23505") fail(409, "A product with that name is already here"); throw e; }
  }));
  app.get<{ Params: { id: string } }>("/api/v0/product-map/products/:id", (req) => tx(req, async (c, v) => {
    person(v); const pid = id(req.params.id, "Product not found"); const p = await product(c, pid);
    const [screens, elements, edges, features, personas, journeys, issues, ideas, comments, sources, tokens, jobs, versions] = await inOrder([
      () => c.query(`select s.id, s.key, s.route, s.title, s.purpose, s.area, s.access, s.proposed, s.status, s.sources, s.meta->'use' use, s.meta->>'file' file,
        exists (select 1 from pulse.product_map_shot x where x.screen_id = s.id) shot from pulse.product_map_screen s where s.product_id = $1 order by s.key`, [pid]),
      () => c.query(`select id, screen_id "screenId", kind, label, target, destructive, proposed, (meta->>'handler') = 'false' "noHandler" from pulse.product_map_element where product_id = $1 order by kind, label`, [pid]),
      () => c.query(`select from_key "from", to_key "to", kind, label, count, median_ms "medianMs" from pulse.product_map_edge where product_id = $1`, [pid]),
      () => c.query(`select id, key, name, description, screens, proposed, origin from pulse.product_map_feature where product_id = $1 order by sort, name`, [pid]),
      () => c.query(`select id, key, name, role, description, goals, age_group "ageGroup", skill_level "skillLevel", tech_comfort "techComfort", frequency, device, permissions, features, evidence, confidence, origin
        from pulse.product_map_persona where product_id = $1 order by sort, name`, [pid]),
      () => c.query(`select j.id, j.key, j.persona_key "personaKey", j.title, j.goal, j.status, j.steps, j.evidence, j.confidence, j.usage, j.origin, j.priority, j.acceptance,
        j.target_version_id "targetVersionId", j.created_by "byId", p.display_name "by", j.updated_at "updatedAt" from pulse.product_map_journey j left join pulse.person p on p.id = j.created_by where j.product_id = $1
        order by case j.status when 'planned' then 0 when 'drafted' then 1 when 'shipped' then 2 when 'discovered' then 3 else 4 end, j.created_at`, [pid]),
      () => c.query(`select id, kind, severity, title, detail, screen_key "screenKey", journey_key "journeyKey", evidence, confidence, origin, status, seen_at "seenAt" from pulse.product_map_issue where product_id = $1
        order by case status when 'open' then 0 when 'accepted' then 1 else 2 end, case severity when 'high' then 0 when 'medium' then 1 else 2 end, created_at`, [pid]),
      () => c.query(`select i.id, i.title, i.body, i.kind, i.screens, i.persona_key "personaKey", i.journey_key "journeyKey", i.issue_id "issueId", i.priority, i.status, i.target_version_id "targetVersionId", i.origin,
        i.created_at "createdAt", i.created_by "byId", p.display_name "by", (select count(*)::int from pulse.product_map_idea_vote x where x.idea_id = i.id) votes,
        exists (select 1 from pulse.product_map_idea_vote x where x.idea_id = i.id and x.person_id = $2) voted
        from pulse.product_map_idea i left join pulse.person p on p.id = i.created_by where i.product_id = $1 order by i.created_at desc`, [pid, v.person]),
      () => c.query(`select m.id, m.idea_id "ideaId", m.body, m.created_at "createdAt", p.display_name "by" from pulse.product_map_comment m join pulse.product_map_idea i on i.id = m.idea_id
        left join pulse.person p on p.id = m.created_by where i.product_id = $1 order by m.created_at`, [pid]),
      () => sourceRows(c, pid),
      () => leadership(v) ? c.query(`select id, name, can_push "canPush", created_at "createdAt", expires_at "expiresAt", last_used_at "lastUsedAt", revoked_at "revokedAt" from pulse.product_map_token where product_id = $1 order by created_at desc`, [pid]) : Promise.resolve({ rows: [] }),
      () => c.query(`select id, status, engine, tokens_in "tokensIn", tokens_out "tokensOut", error, created_at "createdAt", finished_at "finishedAt", result->'counts' counts from pulse.product_map_ai_job where product_id = $1 order by created_at desc limit 5`, [pid]),
      () => c.query(`select id, label, title, stage, released_on::text "releasedOn" from pulse.story_version where product_id = $1 order by released_on desc nulls first, created_at desc`, [pid])] as const);
    return { canRemove: leadership(v), me: v.person, product: p, screens: screens.rows, elements: elements.rows, edges: edges.rows, features: features.rows, personas: personas.rows, journeys: journeys.rows,
      issues: issues.rows, ideas: ideas.rows, comments: comments.rows, sources: sources.map(({ config, ...s }) => ({ ...s, config: { ...(config as Body), signIn: undefined } })),
      tokens: tokens.rows, aiJobs: jobs.rows, versions: versions.rows, repos: Object.keys(repoRoots()), crawl: !!playwrightModule() };
  }));

  // Sources
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/product-map/products/:id/sources", { schema: { body } }, (req) => tx(req, async (c, v) => {
    const me = person(v); const pid = id(req.params.id, "Product not found"); await product(c, pid); const b = req.body;
    const kind = pick(b.kind, SOURCE_KINDS, "repo"); let config: Body = {}; let secret: unknown = null;
    if (kind === "repo") { const repo = slug(b.repo, 40); if (!repoRoots()[repo]) fail(400, "Choose a checkout this server can read"); config = { repo, path: str(b.path, 200).replace(/\.\./g, "") }; }
    if (kind === "manifest") { const url = str(b.url, 300); if (!/^https:\/\/\S{4,}$/.test(url)) fail(400, "Give the manifest’s https address"); config = { url }; }
    if (kind === "telemetry") config = { org: "self" };
    if (kind === "crawl") {
      const baseUrl = str(b.baseUrl, 300); if (!/^https:\/\/[^/\s]+/.test(baseUrl)) fail(400, "Give the app’s https address");
      config = { baseUrl: new URL(baseUrl).origin, startPaths: strings(b.startPaths, 10, 200).filter((p) => p.startsWith("/")), pageBudget: Math.max(3, Math.min(80, Math.round(Number(b.pageBudget) || 30))),
        signIn: b.signInUrl ? { url: str(b.signInUrl, 300), userField: str(b.userField, 120), passField: str(b.passField, 120) } : null };
      if (b.username || b.password) {
        const ring = await loadKeyring(); if (!ring.ok) fail(503, "This server cannot keep a test account yet (its encryption key is not installed)");
        secret = { pending: true, user: str(b.username, 200), pass: String(b.password ?? "").slice(0, 200) };
      }
    }
    const r = await c.query(`insert into pulse.product_map_source (org_id, product_id, kind, label, config, created_by) values (pulse.current_org(), $1, $2, $3, $4, $5) returning id`,
      [pid, kind, str(b.label, 120), j(config), me]);
    const sid = r.rows[0].id as string;
    if (secret) { const ring = await loadKeyring(); if (ring.ok) { const s = seal(ring.ring, Buffer.from(JSON.stringify({ user: (secret as Body).user, pass: (secret as Body).pass })), `${v.org}/product-map/${sid}`);
      await c.query("update pulse.product_map_source set secret = $2 where id = $1", [sid, j({ k: s.keyId, w: s.dataKey.toString("base64"), d: s.data.toString("base64") })]); } }
    return { id: sid };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/product-map/sources/:id/run", (req) => tx(req, async (c, v) => {
    person(v); const sid = id(req.params.id, "Source not found");
    const s = (await c.query("select product_id from pulse.product_map_source where id = $1", [sid])).rows[0] ?? fail(404, "Source not found");
    return runSource(c, v, s.product_id, sid, deps);
  }));
  app.post<{ Params: { id: string } }>("/api/v0/product-map/sources/:id/remove", (req) => tx(req, async (c, v) => {
    lead(v); const r = await c.query("delete from pulse.product_map_source where id = $1", [id(req.params.id, "Source not found")]); if (!r.rowCount) fail(404, "Source not found"); return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/product-map/products/:id/import", { schema: { body: { type: "object" } }, bodyLimit: 4_000_000 }, (req) => tx(req, async (c, v) => {
    person(v); const pid = id(req.params.id, "Product not found"); await product(c, pid);
    let m; try { m = normalizeManifest(req.body.manifest ?? req.body); } catch (e) { fail(400, e instanceof Error ? e.message : "That is not a manifest"); }
    await applyManifest(c, pid, "push", m!.manifest);
    await notePush(c, pid, "Pasted manifest", m!);
    return { ok: true, warnings: m!.warnings, analysis: await analyseProduct(c, pid) };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/product-map/products/:id/analyse", (req) => tx(req, async (c, v) => {
    person(v); const pid = id(req.params.id, "Product not found"); await product(c, pid); return analyseProduct(c, pid);
  }));

  // Screens and elements (proposed ones are ideas the team can plan with)
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/product-map/products/:id/screens", { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); const pid = id(req.params.id, "Product not found"); await product(c, pid);
    const title = str(req.body.title, 160); if (title.length < 2) fail(400, "Name the screen");
    const route = routeKey(req.body.route) || ""; const key = route || `proposed:${slug(title, 60)}`;
    try {
      const r = await c.query(`insert into pulse.product_map_screen (org_id, product_id, key, route, title, purpose, area, proposed, status, sources, meta)
        values (pulse.current_org(), $1, $2, $3, $4, $5, $6, true, 'proposed', array['manual'], '{"manual":true}') returning id, key`, [pid, key, route, title, text(req.body.purpose, 1000), str(req.body.area, 80)]);
      return r.rows[0];
    } catch (e) { if ((e as { code?: string }).code === "23505") fail(409, "A screen with that address is already in the map"); throw e; }
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/product-map/screens/:id", { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); const sid = id(req.params.id, "Screen not found"); const b = req.body;
    const s = (await c.query("select product_id, meta from pulse.product_map_screen where id = $1", [sid])).rows[0] ?? fail(404, "Screen not found");
    const set: [string, unknown][] = []; const edited: string[] = [];
    if (has(b, "title")) { const t = str(b.title, 160); if (t.length < 1) fail(400, "Name the screen"); set.push(["title", t]); edited.push("title"); }
    if (has(b, "purpose")) { set.push(["purpose", text(b.purpose, 1000)]); edited.push("purpose"); }
    if (has(b, "area")) { set.push(["area", str(b.area, 80)]); edited.push("area"); }
    if (has(b, "access")) { set.push(["access", strings(b.access, 30, 80)]); edited.push("access"); }
    if (has(b, "status")) set.push(["status", pick(b.status, ["live", "proposed", "removed"] as const, "live")]);
    const prev = Array.isArray(s.meta?.edited) ? s.meta.edited as string[] : [];
    set.push(["meta", j({ ...(s.meta ?? {}), edited: [...new Set([...prev, ...edited])] })]);
    await update(c, "product_map_screen", sid, s.product_id, set, "Screen not found"); return { ok: true };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/product-map/screens/:id/remove", (req) => tx(req, async (c, v) => {
    person(v); const sid = id(req.params.id, "Screen not found");
    const s = (await c.query("select proposed, created_at from pulse.product_map_screen where id = $1", [sid])).rows[0] ?? fail(404, "Screen not found");
    if (!s.proposed) lead(v);
    await c.query("delete from pulse.product_map_screen where id = $1", [sid]); return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/product-map/screens/:id/elements", { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); const sid = id(req.params.id, "Screen not found");
    const s = (await c.query("select product_id from pulse.product_map_screen where id = $1", [sid])).rows[0] ?? fail(404, "Screen not found");
    const e = { kind: pick(req.body.kind, ELEMENT_KINDS, "button"), label: str(req.body.label, 160), target: str(req.body.target, 200) };
    if (!e.label) fail(400, "Give the element a label");
    const r = await c.query(`insert into pulse.product_map_element (org_id, product_id, screen_id, key, kind, label, target, proposed, sources) values (pulse.current_org(), $1, $2, $3, $4, $5, $6, true, array['manual'])
      on conflict (org_id, screen_id, key) do nothing returning id`, [s.product_id, sid, elementKey(e), e.kind, e.label, e.target]);
    return { id: r.rows[0]?.id ?? null };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/product-map/elements/:id/remove", (req) => tx(req, async (c, v) => {
    person(v); const r = await c.query("delete from pulse.product_map_element where id = $1 and proposed", [id(req.params.id, "Element not found")]);
    if (!r.rowCount) fail(404, "Only proposed elements are removed here"); return { ok: true };
  }));

  // Features
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/product-map/products/:id/features", { schema: { body } }, (req) => tx(req, async (c, v) => {
    const me = person(v); const pid = id(req.params.id, "Product not found"); await product(c, pid);
    const name = str(req.body.name, 120); if (!name) fail(400, "Name the feature");
    try {
      const r = await c.query(`insert into pulse.product_map_feature (org_id, product_id, key, name, description, screens, proposed, origin, created_by) values (pulse.current_org(), $1, $2, $3, $4, $5, $6, 'manual', $7) returning id`,
        [pid, slug(req.body.key ?? name) || `f-${Date.now().toString(36)}`, name, text(req.body.description, 1000), strings(req.body.screens, 200, 200), req.body.proposed === true, me]);
      return { id: r.rows[0].id };
    } catch (e) { if ((e as { code?: string }).code === "23505") fail(409, "A feature with that name is already here"); throw e; }
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/product-map/features/:id", { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); const fid = id(req.params.id, "Feature not found"); const b = req.body;
    const f = (await c.query("select product_id from pulse.product_map_feature where id = $1", [fid])).rows[0] ?? fail(404, "Feature not found");
    const set: [string, unknown][] = [["origin", "manual"]];
    if (has(b, "name")) set.push(["name", str(b.name, 120) || fail(400, "Name the feature")]);
    if (has(b, "description")) set.push(["description", text(b.description, 1000)]);
    if (has(b, "screens")) set.push(["screens", strings(b.screens, 200, 200)]);
    if (has(b, "proposed")) set.push(["proposed", b.proposed === true]);
    await update(c, "product_map_feature", fid, f.product_id, set, "Feature not found"); return { ok: true };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/product-map/features/:id/remove", (req) => tx(req, async (c, v) => {
    lead(v); const r = await c.query("delete from pulse.product_map_feature where id = $1", [id(req.params.id, "Feature not found")]); if (!r.rowCount) fail(404, "Feature not found"); return { ok: true };
  }));

  // User types
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/product-map/products/:id/personas", { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); const pid = id(req.params.id, "Product not found"); await product(c, pid);
    const p = { ...personaFields(req.body), origin: "manual" }; if (!p.name) fail(400, "Name the user type");
    p.key = p.key || `user-${Date.now().toString(36)}`;
    try { await c.query(`insert into pulse.product_map_persona (org_id, product_id, key, name, role, description, goals, age_group, skill_level, tech_comfort, frequency, device, permissions, features, evidence, origin)
      values (pulse.current_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, '[]', 'manual')`, [pid, p.key, p.name, p.role, p.description, p.goals, p.ageGroup, p.skillLevel, p.techComfort, p.frequency, p.device, p.permissions, p.features]); }
    catch (e) { if ((e as { code?: string }).code === "23505") fail(409, "A user type with that name is already here"); throw e; }
    return { key: p.key };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/product-map/personas/:id", { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); const xid = id(req.params.id, "User type not found");
    const p = (await c.query("select product_id from pulse.product_map_persona where id = $1", [xid])).rows[0] ?? fail(404, "User type not found");
    // Edited by a person: theirs from now on (the next analysis leaves it alone).
    await update(c, "product_map_persona", xid, p.product_id, [...cols(req.body, PERSONA_COLS), ["origin", "manual"]], "User type not found"); return { ok: true };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/product-map/personas/:id/remove", (req) => tx(req, async (c, v) => {
    lead(v); const r = await c.query("delete from pulse.product_map_persona where id = $1", [id(req.params.id, "User type not found")]); if (!r.rowCount) fail(404, "User type not found"); return { ok: true };
  }));

  // Journeys: drafted and planned by people, proposed by Pulse, discovered from real use
  const journeyCols = async (c: PoolClient, pid: string, b: Body) => {
    const keys = (await c.query("select key from pulse.product_map_screen where product_id = $1", [pid])).rows.map((r) => r.key as string);
    const set: [string, unknown][] = [];
    if (has(b, "title")) set.push(["title", str(b.title, 160) || fail(400, "Name the journey")]);
    if (has(b, "personaKey")) set.push(["persona_key", slug(b.personaKey, 80)]);
    if (has(b, "goal")) set.push(["goal", text(b.goal, 1000)]);
    if (has(b, "status")) set.push(["status", pick(b.status, JOURNEY_STATUS, "drafted")]);
    if (has(b, "steps")) { const steps = stepsOf(b.steps, keys); if (steps.length > LIMITS.steps) fail(400, "A journey has at most 40 steps"); set.push(["steps", j(steps)]); }
    if (has(b, "priority")) set.push(["priority", pick(b.priority, PRIORITY, "")]);
    if (has(b, "acceptance")) set.push(["acceptance", strings(b.acceptance, 30, 300)]);
    if (has(b, "targetVersionId")) { const t = b.targetVersionId ? id(b.targetVersionId, "Version not found") : null;
      if (t && !(await c.query("select 1 from pulse.story_version where id = $1 and product_id = $2", [t, pid])).rowCount) fail(404, "Version not found"); set.push(["target_version_id", t]); }
    return set;
  };
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/product-map/products/:id/journeys", { schema: { body } }, (req) => tx(req, async (c, v) => {
    const me = person(v); const pid = id(req.params.id, "Product not found"); await product(c, pid);
    const f = journeyFields(req.body); if (!f.title) fail(400, "Name the journey");
    const key = `${slug(f.title, 90) || "journey"}-${randomBytes(3).toString("hex")}`;
    const r = await c.query(`insert into pulse.product_map_journey (org_id, product_id, key, title, origin, created_by) values (pulse.current_org(), $1, $2, $3, 'manual', $4) returning id`, [pid, key, f.title, me]);
    const set = await journeyCols(c, pid, { status: "drafted", ...req.body });
    await update(c, "product_map_journey", r.rows[0].id, pid, set, "Journey not found");
    return { id: r.rows[0].id, key };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/product-map/journeys/:id", { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); const jid = id(req.params.id, "Journey not found");
    const x = (await c.query("select product_id from pulse.product_map_journey where id = $1", [jid])).rows[0] ?? fail(404, "Journey not found");
    await update(c, "product_map_journey", jid, x.product_id, [...await journeyCols(c, x.product_id, req.body), ["origin", "manual"]], "Journey not found"); return { ok: true };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/product-map/journeys/:id/remove", (req) => tx(req, async (c, v) => {
    person(v); const jid = id(req.params.id, "Journey not found");
    const x = (await c.query("select created_by from pulse.product_map_journey where id = $1", [jid])).rows[0] ?? fail(404, "Journey not found");
    if (x.created_by !== v.person) lead(v);
    await c.query("delete from pulse.product_map_journey where id = $1", [jid]); return { ok: true };
  }));

  // Issues
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/product-map/products/:id/issues", { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); const pid = id(req.params.id, "Product not found"); await product(c, pid);
    const title = str(req.body.title, 200); if (title.length < 3) fail(400, "Say what the issue is");
    const r = await c.query(`insert into pulse.product_map_issue (org_id, product_id, fingerprint, kind, severity, title, detail, screen_key, origin) values (pulse.current_org(), $1, $2, $3, $4, $5, $6, $7, 'manual') returning id`,
      [pid, `manual:${randomBytes(8).toString("hex")}`, pick(req.body.kind, ISSUE_KINDS, "other"), pick(req.body.severity, ["high", "medium", "low"] as const, "medium"), title, text(req.body.detail, 2000), str(req.body.screenKey, 200)]);
    return { id: r.rows[0].id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/product-map/issues/:id", { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); const iid = id(req.params.id, "Issue not found");
    const x = (await c.query("select product_id from pulse.product_map_issue where id = $1", [iid])).rows[0] ?? fail(404, "Issue not found");
    const set: [string, unknown][] = [];
    if (has(req.body, "status")) set.push(["status", pick(req.body.status, ["open", "accepted", "fixed", "dismissed"] as const, "open")]);
    if (has(req.body, "severity")) set.push(["severity", pick(req.body.severity, ["high", "medium", "low"] as const, "medium")]);
    await update(c, "product_map_issue", iid, x.product_id, set, "Issue not found"); return { ok: true };
  }));

  // Ideas, votes and comments
  const ideaCols = async (c: PoolClient, pid: string, b: Body) => {
    const set: [string, unknown][] = [];
    if (has(b, "title")) { const t = str(b.title, 200); if (t.length < 2) fail(400, "Give the idea a title"); set.push(["title", t]); }
    if (has(b, "body")) set.push(["body", text(b.body, 4000)]);
    if (has(b, "kind")) set.push(["kind", pick(b.kind, ["screen", "feature", "journey", "change", "fix"] as const, "change")]);
    if (has(b, "screens")) set.push(["screens", strings(b.screens, 50, 200)]);
    if (has(b, "personaKey")) set.push(["persona_key", slug(b.personaKey, 80)]);
    if (has(b, "journeyKey")) set.push(["journey_key", str(b.journeyKey, 120)]);
    if (has(b, "priority")) set.push(["priority", pick(b.priority, ["now", "next", "later"] as const, "next")]);
    if (has(b, "status")) set.push(["status", pick(b.status, ["new", "planned", "building", "shipped", "parked"] as const, "new")]);
    if (has(b, "issueId")) set.push(["issue_id", b.issueId ? id(b.issueId, "Issue not found") : null]);
    if (has(b, "targetVersionId")) { const t = b.targetVersionId ? id(b.targetVersionId, "Version not found") : null;
      if (t && !(await c.query("select 1 from pulse.story_version where id = $1 and product_id = $2", [t, pid])).rowCount) fail(404, "Version not found"); set.push(["target_version_id", t]); }
    return set;
  };
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/product-map/products/:id/ideas", { schema: { body } }, (req) => tx(req, async (c, v) => {
    const me = person(v); const pid = id(req.params.id, "Product not found"); await product(c, pid);
    const title = str(req.body.title, 200); if (title.length < 2) fail(400, "Give the idea a title");
    const r = await c.query(`insert into pulse.product_map_idea (org_id, product_id, title, created_by) values (pulse.current_org(), $1, $2, $3) returning id`, [pid, title, me]);
    await update(c, "product_map_idea", r.rows[0].id, pid, await ideaCols(c, pid, req.body), "Idea not found");
    return { id: r.rows[0].id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/product-map/ideas/:id", { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); const iid = id(req.params.id, "Idea not found");
    const x = (await c.query("select product_id from pulse.product_map_idea where id = $1", [iid])).rows[0] ?? fail(404, "Idea not found");
    await update(c, "product_map_idea", iid, x.product_id, await ideaCols(c, x.product_id, req.body), "Idea not found"); return { ok: true };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/product-map/ideas/:id/vote", (req) => tx(req, async (c, v) => {
    const me = person(v); const iid = id(req.params.id, "Idea not found");
    if (!(await c.query("select 1 from pulse.product_map_idea where id = $1", [iid])).rowCount) fail(404, "Idea not found");
    const del = await c.query("delete from pulse.product_map_idea_vote where idea_id = $1 and person_id = $2", [iid, me]);
    if (!del.rowCount) await c.query("insert into pulse.product_map_idea_vote (org_id, idea_id, person_id) values (pulse.current_org(), $1, $2)", [iid, me]);
    return { voted: !del.rowCount };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/product-map/ideas/:id/comments", { schema: { body } }, (req) => tx(req, async (c, v) => {
    const me = person(v); const iid = id(req.params.id, "Idea not found"); const t = text(req.body.body, 2000); if (!t) fail(400, "Write the comment");
    if (!(await c.query("select 1 from pulse.product_map_idea where id = $1", [iid])).rowCount) fail(404, "Idea not found");
    const r = await c.query("insert into pulse.product_map_comment (org_id, idea_id, body, created_by) values (pulse.current_org(), $1, $2, $3) returning id", [iid, t, me]); return { id: r.rows[0].id };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/product-map/ideas/:id/remove", (req) => tx(req, async (c, v) => {
    person(v); const iid = id(req.params.id, "Idea not found");
    const x = (await c.query("select created_by from pulse.product_map_idea where id = $1", [iid])).rows[0] ?? fail(404, "Idea not found");
    if (x.created_by !== v.person) lead(v);
    await c.query("delete from pulse.product_map_idea where id = $1", [iid]); return { ok: true };
  }));

  // The plan, tasks for the build team, and tokens for their tools and AI agents
  app.get<{ Params: { id: string }; Querystring: { format?: string; journeys?: string; version?: string } }>("/api/v0/product-map/products/:id/plan", async (req, reply) => {
    const spec = await tx(req, async (c, v) => { person(v); const pid = id(req.params.id, "Product not found"); await product(c, pid); return planFor(c, pid, req.query); });
    if (req.query.format === "md") return reply.header("content-type", "text/markdown; charset=utf-8").send(specMarkdown(spec));
    return spec;
  });
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/product-map/journeys/:id/tasks", { schema: { body } }, (req) => tx(req, async (c, v) => {
    person(v); const jid = id(req.params.id, "Journey not found");
    const x = (await c.query("select product_id, key, title from pulse.product_map_journey where id = $1", [jid])).rows[0] ?? fail(404, "Journey not found");
    const spec = await planFor(c, x.product_id, { journeys: x.key });
    const notes = `${specMarkdown(spec)}`.slice(0, 3900);
    const fields: Body = { title: `Build: ${x.title}`.slice(0, 200), notes };
    if (req.body.assigneeId) fields.assigneeId = id(req.body.assigneeId, "Person not found");
    const t = (await c.query("select pulse.task_save(null,$1) id", [j(fields)])).rows[0];
    return { taskId: t.id, href: `/tasks?task=${t.id}` };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/product-map/products/:id/tokens", { schema: { body } }, (req) => tx(req, async (c, v) => {
    lead(v); const me = person(v); const pid = id(req.params.id, "Product not found"); await product(c, pid);
    const name = str(req.body.name, 80); if (name.length < 2) fail(400, "Name the token (who or what uses it)");
    const days = Math.max(1, Math.min(365, Math.round(Number(req.body.days) || 90)));
    const secret = randomBytes(32).toString("base64url"); const r = await c.query(`insert into pulse.product_map_token (org_id, product_id, name, hash, can_push, created_by, expires_at)
      values (pulse.current_org(), $1, $2, $3, $4, $5, now() + make_interval(days => $6)) returning id`, [pid, name, "0".repeat(64), req.body.canPush === true, me, days]);
    const tid = r.rows[0].id as string; const token = `pmap_${tid.slice(0, 8)}_${secret}`;
    await c.query("update pulse.product_map_token set hash = $2 where id = $1", [tid, createHash("sha256").update(token).digest("hex")]);
    return { id: tid, token, note: "Shown once. Send it as Authorization: Bearer <token>." };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/product-map/tokens/:id/revoke", (req) => tx(req, async (c, v) => {
    lead(v); const r = await c.query("update pulse.product_map_token set revoked_at = now() where id = $1 and revoked_at is null", [id(req.params.id, "Token not found")]);
    if (!r.rowCount) fail(404, "Token not found"); return { ok: true };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/product-map/shots/:id", async (req, reply) => {
    const row = await tx(req, async (c, v) => { person(v); return (await c.query("select mime, bytes from pulse.product_map_shot where screen_id = $1", [id(req.params.id, "Screenshot not found")])).rows[0]; });
    if (!row) fail(404, "Screenshot not found");
    return sendImage(reply, row);
  });

  // The AI pass: queued here, done by an AI employee's runtime (services/coworker) within a budget.
  app.post<{ Params: { id: string } }>("/api/v0/product-map/products/:id/ai", (req) => tx(req, async (c, v) => {
    const me = person(v); const pid = id(req.params.id, "Product not found"); await product(c, pid);
    const { data } = await loadWithUse(c, pid);
    if (!data.screens.some((s) => s.status !== "removed")) fail(400, "Connect the app first: the AI pass reads its map");
    const brief = aiBrief(data); const inputHash = hash(brief);
    const cached = (await c.query("select id, finished_at from pulse.product_map_ai_job where product_id = $1 and input_hash = $2 and status = 'done' and finished_at > now() - interval '7 days' and coalesce(engine, '') !~* '(stub|test)' order by finished_at desc limit 1", [pid, inputHash])).rows[0];
    if (cached) return { id: cached.id, status: "done", cached: true, note: "Nothing changed since the last AI pass; its results are already in the map." };
    const busy = (await c.query("select id, status from pulse.product_map_ai_job where product_id = $1 and status in ('queued','running') limit 1", [pid])).rows[0];
    if (busy) return { id: busy.id, status: busy.status };
    const today = (await c.query("select count(*)::int n from pulse.product_map_ai_job where created_at > now() - interval '1 day'")).rows[0].n;
    if (today >= AI_DAILY_JOBS) fail(429, `The organisation ran ${AI_DAILY_JOBS} AI passes in the last day; try again tomorrow.`);
    const estimate = Math.ceil((brief.length + AI_INSTRUCTIONS.length) / 4);
    const r = await c.query(`insert into pulse.product_map_ai_job (org_id, product_id, input_hash, estimate, max_out, requested_by) values (pulse.current_org(), $1, $2, $3, $4, $5) returning id`, [pid, inputHash, estimate, AI_MAX_OUT, me]);
    return { id: r.rows[0].id, status: "queued", estimate };
  }));
  app.post<{ Body: Body }>("/api/v0/agent/product-map/claim", { schema: { body } }, (req) => agentTx(req, async (c, a: Agent) => {
    await c.query("update pulse.product_map_ai_job set status = 'queued', agent_id = null, lease_until = null where status = 'running' and lease_until < now()");
    const m = (await c.query(`select daily_token_budget budget, (select coalesce(sum(coalesce(r.tokens, r.reserved)), 0)::int from pulse.agent_run r where r.agent_id = $1 and r.started_at > now() - interval '1 day') used,
      (select coalesce(sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)), 0)::int from pulse.product_map_ai_job x where x.agent_id = $1 and x.finished_at > now() - interval '1 day') mapped
      from pulse.agent_member where person_id = $1`, [a.id])).rows[0];
    const job = (await c.query(`select id, product_id, estimate, max_out from pulse.product_map_ai_job where status = 'queued' order by created_at limit 1 for update skip locked`)).rows[0];
    if (!job) return { job: null };
    if (m?.budget && Number(m.used) + Number(m.mapped) + job.estimate + job.max_out > Number(m.budget)) return { job: null, reason: "budget" };
    const { data } = await loadWithUse(c, job.product_id);
    await c.query("update pulse.product_map_ai_job set status = 'running', agent_id = $2, started_at = now(), lease_until = now() + interval '15 minutes' where id = $1", [job.id, a.id]);
    return { job: { id: job.id, prompt: `${AI_INSTRUCTIONS}\n\n${aiBrief(data)}`, maxOut: job.max_out, budgetIn: job.estimate + 2000, tier: "strong" } };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/agent/product-map/jobs/:id", { schema: { body: { type: "object", maxProperties: 12 } }, bodyLimit: 400_000 }, (req) => agentTx(req, async (c, a: Agent) => {
    const jid = id(req.params.id, "Job not found");
    const job = (await c.query("select id, product_id, status, agent_id from pulse.product_map_ai_job where id = $1 for update", [jid])).rows[0] ?? fail(404, "Job not found");
    if (job.agent_id !== a.id || job.status !== "running") fail(409, "This job is not yours to finish");
    const n = (x: unknown) => Number.isInteger(x) && (x as number) >= 0 ? Math.min(x as number, 10_000_000) : null;
    if (req.body.state !== "done") {
      await c.query(`update pulse.product_map_ai_job set status = 'failed', error = $2, engine = $3, tokens_in = $4, tokens_out = $5, finished_at = now() where id = $1`,
        [jid, str(req.body.error, 500) || "failed", str(req.body.engine, 120) || null, n(req.body.tokensIn), n(req.body.tokensOut)]);
      return { ok: true };
    }
    const { data } = await loadMap(c, job.product_id);
    const parsed = answerObject(String(req.body.text ?? "").slice(0, 300_000));
    if (!parsed) { await c.query(`update pulse.product_map_ai_job set status = 'failed', error = 'The answer was not JSON', engine = $2, tokens_in = $3, tokens_out = $4, finished_at = now() where id = $1`, [jid, str(req.body.engine, 120) || null, n(req.body.tokensIn), n(req.body.tokensOut)]); return { ok: false }; }
    const r = aiApply(parsed, data); const pid = job.product_id;
    // A role the AI reads as one kind of user enriches the user type Pulse already has for it (age group, skill, goals,
    // evidence); a role it splits into several becomes several user types. What a person edited stays theirs.
    const rename = new Map<string, string>();
    for (const p of r.personas) {
      const same = r.personas.filter((x) => x.role && x.role === p.role);
      const known = same.length === 1 ? data.personas.find((x) => x.role === p.role && x.origin !== "manual") : undefined;
      if (known) { rename.set(p.key, known.key); p.key = known.key; p.evidence = [...p.evidence, ...known.evidence.filter((e) => e.kind !== "note")].slice(0, 20); p.features = p.features.length ? p.features : known.features; p.permissions = known.permissions; }
      await upsertPersona(c, pid, p, ["ai", "auto", "scan"]);
    }
    for (const x of r.journeys) { x.personaKey = rename.get(x.personaKey) ?? x.personaKey; await upsertJourney(c, pid, x, ["ai"]); }
    if (r.issues.length) await c.query(`insert into pulse.product_map_issue (org_id, product_id, fingerprint, kind, severity, title, detail, screen_key, evidence, confidence, origin)
      select pulse.current_org(), $1, x.fingerprint, x.kind, x.severity, x.title, x.detail, x."screenKey", x.evidence, x.confidence, 'ai' from jsonb_to_recordset($2::jsonb) x(fingerprint text, kind text, severity text, title text, detail text, "screenKey" text, evidence jsonb, confidence real)
      on conflict (org_id, product_id, fingerprint) do update set seen_at = now()`, [pid, j(r.issues)]);
    for (const i of r.ideas) await c.query(`insert into pulse.product_map_idea (org_id, product_id, title, body, kind, screens, persona_key, priority, origin)
      select pulse.current_org(), $1, $2, $3, $4, $5, $6, $7, 'ai' where not exists (select 1 from pulse.product_map_idea where product_id = $1 and lower(title) = lower($2))`, [pid, i.title, i.body, i.kind, i.screens, i.personaKey, i.priority]);
    const counts = { personas: r.personas.length, journeys: r.journeys.length, issues: r.issues.length, ideas: r.ideas.length, dropped: r.dropped };
    await c.query(`update pulse.product_map_ai_job set status = 'done', result = $2, engine = $3, tokens_in = $4, tokens_out = $5, finished_at = now() where id = $1`,
      [jid, j({ counts }), str(req.body.engine, 120) || null, n(req.body.tokensIn), n(req.body.tokensOut)]);
    return { ok: true, counts };
  }));

  // The token API for the build team's tools and AI agents (MCP-friendly: see AGENT_TOOLS and GET feed/tools).
  const tokenTx = async <T>(req: FastifyRequest, push: boolean, run: (c: PoolClient, pid: string) => Promise<T>): Promise<T> => {
    const m = String(req.headers.authorization ?? "").match(/^Bearer (pmap_[0-9a-f]{8}_[A-Za-z0-9_-]{43})$/);
    if (!m || !TOKEN.test(m[1])) fail(401, "Send a Product map token in the Authorization header");
    if (["cookie", "x-pulse-session", "cf-access-authenticated-user-email", "x-pulse-agent-key"].some((h) => req.headers[h] !== undefined)) fail(401, "Send the Product map token alone, with no person’s sign-in");
    return open(async (c) => {
      const t = (await c.query("select id, product_id, can_push from pulse.product_map_token where hash = $1 and revoked_at is null and expires_at > now()", [createHash("sha256").update(m![1]).digest("hex")])).rows[0];
      if (!t) fail(401, "This token is unknown here, revoked or expired");
      if (push && !t.can_push) fail(403, "This token may read only");
      await c.query("update pulse.product_map_token set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')", [t.id]);
      return run(c, t.product_id);
    });
  };
  app.get("/api/v0/product-map/feed/tools", (req) => tokenTx(req, false, async () => ({ tools: AGENT_TOOLS, auth: "Authorization: Bearer <Product map token>" })));
  app.get("/api/v0/product-map/feed/map", (req) => tokenTx(req, false, (c, pid) => publicMap(c, pid)));
  app.get<{ Querystring: { format?: string; journeys?: string; version?: string } }>("/api/v0/product-map/feed/plan", async (req, reply) => {
    const spec = await tokenTx(req, false, (c, pid) => planFor(c, pid, req.query));
    if (req.query.format === "md") return reply.header("content-type", "text/markdown; charset=utf-8").send(specMarkdown(spec));
    return spec;
  });
  app.post<{ Body: Body }>("/api/v0/product-map/feed/manifest", { schema: { body: { type: "object" } }, bodyLimit: 4_000_000 }, (req) => tokenTx(req, true, async (c, pid) => {
    let m; try { m = normalizeManifest(req.body.manifest ?? req.body); } catch (e) { fail(400, e instanceof Error ? e.message : "That is not a manifest"); }
    await applyManifest(c, pid, "push", m!.manifest);
    await notePush(c, pid, "Pushed by token", m!);
    return { ok: true, warnings: m!.warnings, analysis: await analyseProduct(c, pid) };
  }));
  app.post<{ Body: Body }>("/api/v0/product-map/feed/ideas", { schema: { body } }, (req) => tokenTx(req, true, async (c, pid) => {
    const title = str(req.body.title, 200); if (title.length < 2) fail(400, "Give the idea a title");
    const r = await c.query(`insert into pulse.product_map_idea (org_id, product_id, title, body, kind, screens, origin) values (pulse.current_org(), $1, $2, $3, $4, $5, 'ai') returning id`,
      [pid, title, text(req.body.body, 4000), pick(req.body.kind, ["screen", "feature", "journey", "change", "fix"] as const, "change"), strings(req.body.screens, 50, 200)]);
    return { id: r.rows[0].id };
  }));
}

/** The JSON object a model answered with (it may wrap it in a fence or a sentence). */
export function answerObject(t: string): unknown {
  const s = t.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(s); } catch { /* look inside */ }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; } }
  return null;
}

// ------------------------------------------------------------------------------------------------------- the crawl
type CrawlOut = { manifest: unknown; shots: { key: string; jpeg: string; width: number; height: number }[]; stats: Record<string, unknown> };
/** Runs the crawler (product-map-crawl.js) in its own low-priority process: the test account goes in on stdin, never in
 *  arguments, the environment or a log; the result comes back on stdout. */
function runCrawler(input: { config: Record<string, unknown>; account: Record<string, string> | null }): Promise<CrawlOut> {
  const script = resolve(here, "product-map-crawl.js"); const pw = playwrightModule();
  if (!pw) return Promise.reject(new Error("Live crawl is not set up on this server"));
  return new Promise((accept, reject) => {
    const child = spawn("nice", ["-n", "19", process.execPath, script], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", PULSE_PLAYWRIGHT: pw } });
    let out = "", err = ""; const timer = setTimeout(() => child.kill("SIGKILL"), 12 * 60_000);
    child.stdout.on("data", (d) => { out += d; if (out.length > 60_000_000) child.kill("SIGKILL"); });
    child.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); if (code !== 0) return reject(new Error(`The crawl stopped: ${err.split("\n").filter(Boolean).at(-1)?.slice(0, 200) ?? `exit ${code}`}`));
      try { accept(JSON.parse(out) as CrawlOut); } catch { reject(new Error("The crawl’s result could not be read")); } });
    child.stdin.end(JSON.stringify(input));
  });
}
