// XRAY-LINK (owner, 25 Oct 2026): "send calls from Pulse to be analysed in Sales X-Ray, and connect it for lead
// management and data sync". Built on the Sales X-Ray app (sales-xray.ts, EST-1363); records in 1040.
//
// Lead sync. A company turns it on from the Sales X-Ray app's Sync tab; a Pulse admin who is an owner or admin of the
// Sales X-Ray organisation, connected in Pulse, lends their connection (their token sees the team's leads). Every ten minutes, and
// on "Sync now", Pulse reads every lead (newest change first), keeps a copy (sales_xray_lead) and:
//  * links a lead to a Pulse client: the same e-mail, the same phone (last 10 digits) or the same company name, when
//    exactly one client matches; otherwise it makes a client: when the lead is won ("won", the default) or for every
//    open lead as a Prospect ("all");
//  * fills a linked client's empty fields (company, e-mail, phone, city) from the lead. A field a person set in Pulse
//    (client.locked) is never overwritten; a different value on both sides is logged as a conflict and Pulse's stays;
//  * a won lead turns its Prospect client Active. Nothing else changes a client's status;
//  * a lead that is gone from Sales X-Ray is marked gone; its client stays.
// Pulse to Sales X-Ray: "Send to Sales X-Ray" on a client (and, with "Send new prospects" on, each Prospect client made
// in Pulse) adds a lead through Sales X-Ray's API with external_id pulse-client:<id>, so sending twice adds nothing.
// Sales X-Ray's API has no lead update yet, so later Pulse edits stay in Pulse (asked of AC: PATCH /v1/api/leads/{id}).
// Each run writes what it did to sales_xray_sync_log, shown on the Sync tab.
//
// Calls. A Sales X-Ray call can be linked to a client, a person (by default the person whose call it is) and a Pulse
// call; its analysis (summary, score, objections, promises) is kept short in sales_xray_call and shown on the client,
// the person and the call. "Analyse a recording" sends a file to Sales X-Ray (POST /v1/api/calls, calls:write: the
// contract Pulse proposes in docs/architecture/SALES_XRAY_APP.md; until Sales X-Ray has it, Pulse says so and keeps
// nothing). The file goes up in parts to this server's temporary folder and is deleted once sent or after an hour.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { moduleOff, readModules } from "./modules.js";
import { fail, leadership, type Tx, type Viewer } from "./routes.js";
import { accessToken, call, callAnalysis, db, read, salesXrayBase, SalesXrayError, staffPerson, type Link, type SalesXrayFetch } from "./sales-xray.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = (x: unknown, what: string) => (typeof x === "string" && UUID.test(x) ? x : fail(400, `Choose a valid ${what}`));
const optUuid = (x: unknown, what: string) => (x === undefined || x === null || x === "" ? null : uuid(x, what));

// ----- shapes ------------------------------------------------------------------------------------------------------
export type SxLeadRow = { lead_id: string; revision?: number | null; name?: string | null; company?: string | null; city?: string | null; interest?: string | null;
  stage?: string | null; stage_label?: string | null; owner_name?: string | null; source_label?: string | null; created_at?: string | null };
export type SxLeadDetail = { lead?: SxLeadRow | null; phone?: string | null; email?: string | null };
export type Mirror = { sxLeadId: string; revision: number; name: string; company: string | null; city: string | null; phone: string | null; email: string | null;
  interest: string | null; stage: string; stageLabel: string | null; ownerName: string | null; sourceLabel: string | null; sxCreatedAt: string | null;
  clientId: string | null; origin: "sales_xray" | "pulse"; goneAt: string | null };
export type ClientRow = { id: string; name: string; company: string | null; email: string | null; phone: string | null; city: string | null; status: string | null; locked: string[]; source: string | null };
export type Settings = { enabled: boolean; runnerPersonId: string | null; runnerName?: string | null; workspace: string; makeClients: "won" | "all"; pushClients: boolean;
  lastRunAt: string | null; lastOkAt: string | null; lastError: string | null; lastCounts: Record<string, number> };
export type Counts = Record<"read" | "created" | "updated" | "unchanged" | "clientsMade" | "clientsLinked" | "filled" | "conflicts" | "gone" | "sent" | "failed", number>;
export const emptyCounts = (): Counts => ({ read: 0, created: 0, updated: 0, unchanged: 0, clientsMade: 0, clientsLinked: 0, filled: 0, conflicts: 0, gone: 0, sent: 0, failed: 0 });

// ----- the rules (pure; test/sales-xray-sync.test.mjs) -------------------------------------------------------------
const clean = (x: unknown, max: number) => (typeof x === "string" && x.trim() ? x.replace(/\s+/g, " ").trim().slice(0, max) : null);
const digits = (x: string | null | undefined) => (x ?? "").replace(/\D/g, "");
/** Two values for the same field mean the same thing: phones by their last 10 digits, e-mail without case, the rest
 *  without case and extra spaces. */
export function sameValue(field: string, a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return !a && !b;
  if (field === "phone") { const x = digits(a), y = digits(b); return x.length >= 10 && y.length >= 10 ? x.slice(-10) === y.slice(-10) : x === y; }
  return a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The copy Pulse keeps of one lead, from the list row and (when read) its detail. */
export function mirrorFrom(row: SxLeadRow, detail: SxLeadDetail | null, prev: Mirror | null): Mirror {
  return {
    sxLeadId: row.lead_id, revision: Number(row.revision) || 0, name: clean(row.name, 200) ?? prev?.name ?? "",
    company: clean(row.company, 200), city: clean(row.city, 120), interest: clean(row.interest, 200),
    // the list carries only the last four digits; the detail carries the phone and e-mail
    phone: detail ? clean(detail.phone, 40) : prev?.phone ?? null, email: detail ? clean(detail.email, 320) : prev?.email ?? null,
    stage: clean(row.stage, 40) ?? "new", stageLabel: clean(row.stage_label, 80), ownerName: clean(row.owner_name, 200), sourceLabel: clean(row.source_label, 200),
    sxCreatedAt: clean(row.created_at, 40), clientId: prev?.clientId ?? null, origin: prev?.origin ?? "sales_xray", goneAt: null,
  };
}
/** True when the list row says something changed since Pulse's copy (or Pulse has none). */
export const changed = (row: SxLeadRow, prev: Mirror | null) => !prev || !!prev.goneAt || (Number(row.revision) || 0) !== prev.revision || (row.stage ?? "new") !== prev.stage
  || (clean(row.owner_name, 200) ?? null) !== prev.ownerName;

/** Does this lead get a Pulse client? "won": once won. "all": every lead that isn't lost. */
export const wantsClient = (mode: "won" | "all", lead: Mirror) => (mode === "all" ? lead.stage !== "lost" : lead.stage === "won");

/** The one client this lead is, by e-mail, phone or company name; null when none or more than one match. */
export function matchClient(clients: ClientRow[], lead: Mirror): ClientRow | null {
  const tries: ((c: ClientRow) => boolean)[] = [];
  if (lead.email) tries.push((c) => !!c.email && sameValue("email", c.email, lead.email));
  if (digits(lead.phone).length >= 10) tries.push((c) => !!c.phone && sameValue("phone", c.phone, lead.phone));
  if (lead.company) tries.push((c) => sameValue("company", c.company ?? c.name, lead.company) || sameValue("company", c.name, lead.company));
  for (const t of tries) { const hit = clients.filter(t); if (hit.length === 1) return hit[0]; if (hit.length > 1) return null; }
  return null;
}

/** Client column -> lead field that may fill it. The client's own name is set once, when the client is made. */
export const FILLS = [["company_name", "company", "company"], ["email", "email", "email"], ["phone", "phone", "phone"], ["city", "city", "city"]] as const;
export type Plan = { fill: Record<string, string>; conflicts: { field: string; pulse: string; salesXray: string }[]; status: string | null };
/** What a lead changes on its linked client: empty, unkept fields are filled; a different value is a conflict and
 *  Pulse's stays; a won lead turns a Prospect (or a client without a status) Active. */
export function clientPlan(client: ClientRow, lead: Mirror): Plan {
  const plan: Plan = { fill: {}, conflicts: [], status: null };
  for (const [col, key, field] of FILLS) {
    const sx = lead[key], pulse = client[key === "company" ? "company" : key];
    if (!sx) continue;
    if (!pulse && !client.locked.includes(col)) plan.fill[col] = sx;
    else if (pulse && !sameValue(field, pulse, sx)) plan.conflicts.push({ field, pulse, salesXray: sx });
  }
  if (lead.stage === "won" && (!client.status || client.status === "prospect")) plan.status = "active";
  return plan;
}
/** A new client for a lead: named after the company (or the person), Prospect until won. */
export const newClient = (lead: Mirror) => ({ name: (lead.company ?? lead.name ?? "").slice(0, 120) || "Sales X-Ray lead", company: lead.company, email: lead.email, phone: lead.phone, city: lead.city,
  status: lead.stage === "won" ? "active" : "prospect" });
/** Sales X-Ray's new-lead body for a Pulse client; the external id makes a second send change nothing. */
export const leadBody = (c: ClientRow, contact?: string | null) => Object.fromEntries(Object.entries({
  name: (contact ?? c.name).slice(0, 200), phone: c.phone, email: c.email, company: (c.company ?? c.name).slice(0, 200), city: c.city, external_id: `pulse-client:${c.id}`,
}).filter(([, x]) => !!x));

// ----- records -----------------------------------------------------------------------------------------------------
const SETTINGS = `s.enabled,s.runner_person_id "runnerPersonId",(select display_name from pulse.person where id=s.runner_person_id) "runnerName",s.workspace,s.make_clients "makeClients",
  s.push_clients "pushClients",s.last_run_at "lastRunAt",s.last_ok_at "lastOkAt",s.last_error "lastError",s.last_counts "lastCounts"`;
const OFF: Settings = { enabled: false, runnerPersonId: null, runnerName: null, workspace: "", makeClients: "won", pushClients: false, lastRunAt: null, lastOkAt: null, lastError: null, lastCounts: {} };
const MIRROR = `sx_lead_id "sxLeadId",revision,name,company,city,phone,email,interest,stage,stage_label "stageLabel",owner_name "ownerName",source_label "sourceLabel",
  sx_created_at "sxCreatedAt",client_id "clientId",origin,gone_at "goneAt"`;
const CLIENT = `c.id,c.display_name name,c.company_name company,c.email,c.phone,c.city,c.status,coalesce(c.locked,'{}') locked,c.source`;
const LIVE_CLIENT = `not exists(select 1 from pulse.record_merge m where m.entity_type='client' and m.gone_id=c.id and m.undone_at is null)`;

export async function settings(c: PoolClient): Promise<Settings> {
  const r = (await c.query(`select ${SETTINGS} from pulse.sales_xray_sync s where s.org_id=pulse.current_org()`)).rows[0];
  return r ? { ...r, lastCounts: r.lastCounts ?? {} } : { ...OFF };
}
async function log(c: PoolClient, run: string, direction: "in" | "out" | "run", action: string, detail = "", sxLeadId: string | null = null, clientId: string | null = null) {
  await c.query(`insert into pulse.sales_xray_sync_log(org_id,run_id,direction,action,sx_lead_id,client_id,detail) values (pulse.current_org(),$1,$2,$3,$4,$5,$6)`,
    [run, direction, action, sxLeadId, clientId, detail.slice(0, 500)]);
}
async function saveMirror(c: PoolClient, m: Mirror) {
  await c.query(`insert into pulse.sales_xray_lead(org_id,sx_lead_id,revision,name,company,city,phone,email,interest,stage,stage_label,owner_name,source_label,sx_created_at,client_id,origin,gone_at,seen_at,updated_at)
    values (pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,null,now(),now())
    on conflict (org_id,sx_lead_id) do update set revision=excluded.revision,name=excluded.name,company=excluded.company,city=excluded.city,phone=excluded.phone,email=excluded.email,
      interest=excluded.interest,stage=excluded.stage,stage_label=excluded.stage_label,owner_name=excluded.owner_name,source_label=excluded.source_label,sx_created_at=excluded.sx_created_at,
      client_id=coalesce(excluded.client_id,pulse.sales_xray_lead.client_id),gone_at=null,seen_at=now(),updated_at=now()`,
    [m.sxLeadId, m.revision, m.name, m.company, m.city, m.phone, m.email, m.interest, m.stage, m.stageLabel, m.ownerName, m.sourceLabel, m.sxCreatedAt, m.clientId, m.origin]);
}
async function clients(c: PoolClient): Promise<ClientRow[]> {
  return (await c.query(`select ${CLIENT} from pulse.client c where ${LIVE_CLIENT} order by c.created_at limit 20000`)).rows;
}
async function makeClient(c: PoolClient, v: Viewer, lead: Mirror): Promise<string> {
  const n = newClient(lead);
  const id = (await c.query(`insert into pulse.client(org_id,display_name,client_type,type_basis,source,locked,company_name,email,phone,city,status)
    values (pulse.current_org(),$1,'other','inferred','sales_xray','{}',$2,$3,$4,$5,$6) returning id`, [n.name, n.company, n.email, n.phone, n.city, n.status])).rows[0].id as string;
  await c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,new_value,changed_by) values (pulse.current_org(),'client',$1,'created',$2,$3)`, [id, `${n.name} (from Sales X-Ray)`, v.person]);
  return id;
}
/** Fill and status changes go through like the source sync's: written to the client's history, never locking a field. */
async function applyPlan(c: PoolClient, v: Viewer, client: ClientRow, plan: Plan) {
  const sets = { ...plan.fill, ...(plan.status ? { status: plan.status } : {}) };
  for (const [col, value] of Object.entries(sets)) {
    if (!["company_name", "email", "phone", "city", "status"].includes(col)) continue;
    await c.query(`update pulse.client set ${col}=$1,updated_at=now() where id=$2`, [value, client.id]);
    const old = col === "company_name" ? client.company : col === "status" ? client.status : client[col as "email" | "phone" | "city"];
    await c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values (pulse.current_org(),'client',$1,$2,$3,$4,$5)`,
      [client.id, col === "company_name" ? "companyName" : col, old, `${value} (from Sales X-Ray)`, v.person]);
  }
}

/** The person whose connection runs the sync, as a viewer (the background run has no request). */
export const runnerViewer = (org: string, person: string, name = "Lead sync"): Viewer => ({ email: "", org, person, role: "admin", name, pod: null, via: "access", username: null, mustChange: false });

// ----- one run -----------------------------------------------------------------------------------------------------
export type RunResult = { ran: boolean; busy?: boolean; counts: Counts; complete: boolean; error: string | null; runId: string | null };
/** One sync for the viewer's company, as the viewer (the runner). Partial work is kept when Sales X-Ray stops answering. */
export async function runSync(c: PoolClient, f: SalesXrayFetch, v: Viewer, opts: { maxPages?: number; maxDetails?: number; maxPush?: number } = {}): Promise<RunResult> {
  const counts = emptyCounts(), s = await settings(c);
  if (!s.enabled) return { ran: false, counts, complete: false, error: "Lead sync is off", runId: null };
  if (!(await c.query(`select pg_try_advisory_xact_lock(hashtext('sales-xray-sync:'||pulse.current_org()::text)) got`)).rows[0].got) return { ran: false, busy: true, counts, complete: false, error: null, runId: null };
  const run = randomUUID(), maxPages = opts.maxPages ?? 20, maxDetails = opts.maxDetails ?? 40;
  await log(c, run, "run", "started", `As ${v.name || "the runner"}`);
  let complete = false, error: string | null = null, details = 0;
  // A database refusal part-way rolls back to here, so the run's log and its error are still kept.
  await c.query("savepoint sales_xray_run");
  try {
    const mirrors = new Map(((await c.query(`select ${MIRROR} from pulse.sales_xray_lead where org_id=pulse.current_org()`)).rows as Mirror[]).map((m) => [m.sxLeadId, m]));
    let all: ClientRow[] | null = null;
    const seen = new Set<string>();
    for (let page = 0, offset = 0; page < maxPages; page++) {
      const body = (await read(c, f, v, `/leads${offset ? `?offset=${offset}` : ""}`)) as { leads?: SxLeadRow[]; next_offset?: number | null };
      for (const row of body.leads ?? []) {
        if (!row || typeof row.lead_id !== "string" || !UUID.test(row.lead_id)) continue;
        counts.read += 1; seen.add(row.lead_id);
        const prev = mirrors.get(row.lead_id) ?? null;
        let m = prev;
        if (changed(row, prev)) {
          // The detail has the phone and e-mail; when this run has read enough, the copy waits for the next run.
          let detail: SxLeadDetail | null = null;
          if (details < maxDetails) { details += 1; detail = (await read(c, f, v, `/leads/${row.lead_id}`)) as SxLeadDetail; }
          else if (!prev) continue;
          m = mirrorFrom(row, detail, prev);
          if (!detail && prev) m.revision = prev.revision; // read again next time
          await saveMirror(c, m);
          counts[prev ? "updated" : "created"] += 1;
          await log(c, run, "in", prev ? "updated" : "created", `${m.name}${m.company ? `, ${m.company}` : ""}: ${m.stageLabel ?? m.stage}`, m.sxLeadId, m.clientId);
          mirrors.set(m.sxLeadId, m);
        } else counts.unchanged += 1;
        if (!m) continue;
        // The client side: link or make one when the rule says so, then fill and move it.
        if (!m.clientId && wantsClient(s.makeClients, m)) {
          all ??= await clients(c);
          const hit = matchClient(all, m);
          m.clientId = hit ? hit.id : await makeClient(c, v, m);
          await c.query(`update pulse.sales_xray_lead set client_id=$2 where org_id=pulse.current_org() and sx_lead_id=$1`, [m.sxLeadId, m.clientId]);
          if (hit) { counts.clientsLinked += 1; await log(c, run, "in", "linked", `Linked to the client ${hit.name}`, m.sxLeadId, hit.id); }
          else { counts.clientsMade += 1; await log(c, run, "in", "created", `Made the client ${newClient(m).name}`, m.sxLeadId, m.clientId); all = null; }
          if (!hit) continue; // a client made from the lead already has its fields
        }
        if (m.clientId && (changed(row, prev) || m.clientId !== prev?.clientId)) {
          const cl = (await c.query(`select ${CLIENT} from pulse.client c where c.id=$1`, [m.clientId])).rows[0] as ClientRow | undefined;
          if (!cl) continue;
          const plan = clientPlan(cl, m);
          if (Object.keys(plan.fill).length || plan.status) {
            await applyPlan(c, v, cl, plan); counts.filled += 1;
            await log(c, run, "in", "updated", [...Object.keys(plan.fill).map((k) => k.replace("_name", "")), ...(plan.status ? [`status ${plan.status}`] : [])].join(", ").replace(/^/, `${cl.name}: `), m.sxLeadId, cl.id);
          }
          for (const x of plan.conflicts) {
            counts.conflicts += 1;
            await log(c, run, "in", "conflict", `${cl.name}: ${x.field} is “${x.pulse}” in Pulse and “${x.salesXray}” in Sales X-Ray. Pulse keeps its value.`, m.sxLeadId, cl.id);
          }
        }
      }
      if (body.next_offset === null || body.next_offset === undefined || !(body.leads ?? []).length) { complete = true; break; }
      offset = Number(body.next_offset) || offset + 50;
    }
    // A full read: leads Sales X-Ray no longer shows are marked gone (their clients stay).
    if (complete) for (const m of mirrors.values()) if (!seen.has(m.sxLeadId) && !m.goneAt) {
      await c.query(`update pulse.sales_xray_lead set gone_at=now() where org_id=pulse.current_org() and sx_lead_id=$1`, [m.sxLeadId]);
      counts.gone += 1; await log(c, run, "in", "gone", `${m.name} is no longer in Sales X-Ray`, m.sxLeadId, m.clientId);
    }
    if (s.pushClients) {
      const fresh = (await c.query(`select ${CLIENT} from pulse.client c where ${LIVE_CLIENT} and c.status='prospect' and coalesce(c.source,'')<>'sales_xray'
        and not exists(select 1 from pulse.sales_xray_lead l where l.org_id=c.org_id and l.client_id=c.id) order by c.created_at desc limit $1`, [opts.maxPush ?? 20])).rows as ClientRow[];
      for (const cl of fresh) {
        const r = await pushClient(c, f, v, cl, run);
        counts[r.ok ? "sent" : "failed"] += 1;
      }
    }
  } catch (e) {
    const pg = (e as { code?: unknown }).code;
    if (typeof pg === "string" && /^[0-9A-Z]{5}$/.test(pg)) {
      await c.query("rollback to savepoint sales_xray_run");
      error = `Pulse couldn't save this run (database ${pg}). Nothing from it was kept; the next run tries again.`;
      process.emitWarning(`Sales X-Ray lead sync: ${(e as Error).message?.slice(0, 200)}`);
    } else error = e instanceof SalesXrayError ? e.message : "Sales X-Ray isn't answering. The next run tries again.";
    await log(c, run, "run", "failed", error);
  }
  await c.query(`update pulse.sales_xray_sync set last_run_at=now(),last_ok_at=case when $1::text is null then now() else last_ok_at end,last_error=$1,last_counts=$2 where org_id=pulse.current_org()`,
    [error, JSON.stringify(counts)]);
  await log(c, run, "run", "finished", Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ") || "Nothing changed");
  return { ran: true, counts, complete, error, runId: run };
}

/** One Pulse client to Sales X-Ray as a lead (POST /v1/api/leads, leads:write). Kept as a lead copy linked to the client. */
export async function pushClient(c: PoolClient, f: SalesXrayFetch, v: Viewer, cl: ClientRow, run: string | null = null): Promise<{ ok: boolean; id?: string; outcome?: string; words: string }> {
  const contact = (await c.query(`select p.display_name name from pulse.client_contact cc join pulse.person p on p.id=cc.person_id where cc.client_id=$1 order by cc.is_primary desc nulls last limit 1`, [cl.id]).catch(() => ({ rows: [] }))).rows[0]?.name as string | undefined;
  const body = leadBody(cl, contact);
  if (!body.phone && !body.email && !body.name) return { ok: false, words: "Add a name, phone or e-mail to the client first." };
  const { base, token } = await accessToken(c, f, v);
  const r = await call(f, `${base}/v1/api/leads`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  const out = (r.body ?? {}) as { id?: unknown; outcome?: unknown; error?: { message?: unknown } };
  if ((r.status === 200 || r.status === 201) && typeof out.id === "string" && UUID.test(out.id)) {
    await c.query(`insert into pulse.sales_xray_lead(org_id,sx_lead_id,name,company,city,phone,email,stage,client_id,origin) values (pulse.current_org(),$1,$2,$3,$4,$5,$6,'new',$7,'pulse')
      on conflict (org_id,sx_lead_id) do update set client_id=excluded.client_id`, [out.id, String(body.name ?? cl.name), cl.company ?? cl.name, cl.city, cl.phone, cl.email, cl.id]);
    if (run) await log(c, run, "out", "sent", `${cl.name} → Sales X-Ray (${String(out.outcome ?? "created")})`, out.id, cl.id);
    return { ok: true, id: out.id, outcome: String(out.outcome ?? "created"), words: out.outcome === "created" ? `${cl.name} is now a lead in Sales X-Ray.` : `${cl.name} was already a lead in Sales X-Ray; nothing changed.` };
  }
  if (r.status === 401) { await db(c, "drop"); throw new SalesXrayError(409, "Your Sales X-Ray connection ended. Connect it again.", "ended"); }
  const words = r.status === 403 ? "Your Sales X-Ray connection can't add leads. Connect again in an organisation where you may add leads."
    : typeof out.error?.message === "string" ? out.error.message : "Sales X-Ray didn't take the lead. Try again later.";
  if (run) await log(c, run, "out", "failed", `${cl.name}: ${words}`, null, cl.id);
  return { ok: false, words };
}

// ----- calls linked to clients, people and Pulse calls ------------------------------------------------------------
const LINKED = `x.id,x.sx_call_id "sxCallId",x.title,x.call_at "callAt",x.duration_seconds "durationSeconds",x.status,x.summary,x.open_url "openUrl",x.client_id "clientId",
  (select display_name from pulse.client where id=x.client_id) "clientName",x.person_id "personId",(select display_name from pulse.person where id=x.person_id) "personName",
  x.pulse_call_id "pulseCallId",x.sx_lead_id "sxLeadId",x.linked_at "linkedAt",x.checked_at "checkedAt",(select display_name from pulse.person where id=x.linked_by) "linkedBy"`;
type Linked = { id: string; sxCallId: string; status: string; checkedAt: string | null; summary: Record<string, unknown> };
/** Read one call from Sales X-Ray as the viewer and keep its analysis short on the link row. */
async function refreshCall(c: PoolClient, f: SalesXrayFetch, v: Viewer, sxCallId: string) {
  const d = (await read(c, f, v, `/calls/${sxCallId}`)) as { title?: string | null; created_at?: string | null; duration_seconds?: number | null; has_report?: boolean; open_url?: string | null };
  const summary = d.has_report ? await callAnalysis(c, v, sxCallId, f) : null;
  await c.query(`update pulse.sales_xray_call set title=coalesce($2,title),call_at=coalesce($3::timestamptz,call_at),duration_seconds=coalesce($4,duration_seconds),
    status=case when $5 then 'ready' when status in ('sent','waiting') then status else 'analysing' end,summary=coalesce($6::jsonb,summary),open_url=coalesce($7,open_url),checked_at=now()
    where org_id=pulse.current_org() and sx_call_id=$1`,
    [sxCallId, clean(d.title, 200), clean(d.created_at, 40), Number.isFinite(d.duration_seconds) ? Math.round(Number(d.duration_seconds)) : null, !!d.has_report,
      summary ? JSON.stringify({ ...summary, summary: String(summary.summary ?? "").slice(0, 3000) }).slice(0, 11000) : null, clean(d.open_url, 400)]);
}

// ----- recordings (A2): parts to a temporary folder, then one upload to Sales X-Ray -------------------------------
export const MAX_RECORDING = 100 * 1024 * 1024, PART = 3 * 1024 * 1024;
export const RECORDING_TYPES = /^(audio\/(mpeg|mp3|mp4|m4a|x-m4a|aac|wav|x-wav|wave|ogg|opus|webm|amr|3gpp|flac)|video\/(mp4|webm|quicktime|3gpp))$/;
const holding = () => join(process.env.PULSE_SALES_XRAY_UPLOADS ?? join(tmpdir(), "pulse-sales-xray-uploads"));
type Upload = { org: string; person: string; name: string; mime: string; size: number; title: string | null; callAt: string | null; clientId: string | null;
  personId: string | null; pulseCallId: string | null; sxLeadId: string | null; consent: true; parts: number; at: number };
async function sweep() {
  const root = holding();
  for (const d of await readdir(root).catch(() => [] as string[])) {
    const s = await stat(join(root, d)).catch(() => null);
    if (s && Date.now() - s.mtimeMs > 3_600_000) await rm(join(root, d), { recursive: true, force: true }).catch(() => {});
  }
}
async function upload(id: string, v: Viewer): Promise<{ dir: string; meta: Upload }> {
  if (!UUID.test(id)) fail(404, "This upload has ended. Choose the file again.");
  const dir = join(holding(), id);
  const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8").catch(() => "null")) as Upload | null;
  if (!meta || meta.org !== v.org || meta.person !== v.person) fail(404, "This upload has ended. Choose the file again.");
  return { dir, meta: meta! };
}

// ----- routes ------------------------------------------------------------------------------------------------------
export function registerSalesXraySyncRoutes(app: FastifyInstance, { tx, pool, f }: { tx: Tx; pool?: Pool; f: SalesXrayFetch }) {
  // Every minute: each active company whose lead sync is on and due (10 minutes since its last run) runs once, as its runner.
  let busy = false;
  const due = async () => {
    if (busy || !pool || !salesXrayBase()) return;
    busy = true;
    try {
      const orgs = (await pool.query("select pulse.list_active_orgs() org")).rows.map((r) => r.org as string);
      for (const org of orgs) {
        const c = await pool.connect();
        try {
          await c.query("begin");
          await c.query("select set_config('pulse.org_id',$1,true)", [org]);
          const s = (await c.query(`select runner_person_id p,(select display_name from pulse.person where id=runner_person_id) n from pulse.sales_xray_sync
            where org_id=$1 and enabled and runner_person_id is not null and (last_run_at is null or last_run_at<now()-interval '10 minutes')`, [org])).rows[0];
          if (s && !moduleOff(await readModules(c, org), "sales_xray")) {
            await c.query("select set_config('pulse.viewer_id',$1,true)", [s.p]);
            const r = await runSync(c, f, runnerViewer(org, s.p, s.n ?? "Lead sync"));
            app.log.info({ org, ran: r.ran, error: r.error, ...r.counts }, "Sales X-Ray lead sync");
          }
          await c.query("commit");
        } catch (e) {
          await c.query("rollback").catch(() => {});
          app.log.warn({ org, reason: (e as { reason?: string }).reason ?? (e as Error).message?.slice(0, 120) }, "Sales X-Ray lead sync failed");
        } finally { c.release(); }
      }
    } finally { busy = false; }
  };
  const loopOn = !!pool && process.env.PULSE_SALES_XRAY_SYNC !== "0";
  const tick = loopOn ? setInterval(() => void due().catch(() => {}), 60_000) : null;
  const sweeper = setInterval(() => void sweep(), 600_000);
  tick?.unref(); sweeper.unref();
  app.addHook("onClose", async () => { if (tick) clearInterval(tick); clearInterval(sweeper); });

  // The Sync tab: settings, the last run, the copy's stages and the latest log. Leadership and admins change it.
  app.get("/api/v0/sales-xray/sync", (req) => tx(req, async (c, v) => {
    staffPerson(v);
    const s = await settings(c);
    const link = (await db(c, "link")) as Link | null;
    const role = typeof link?.account?.role === "string" ? link.account.role : null, org = link?.account?.kind === "organisation";
    const stages = (await c.query(`select stage,count(*)::int n,count(client_id)::int linked from pulse.sales_xray_lead where org_id=pulse.current_org() and gone_at is null group by 1 order by 2 desc`)).rows;
    const entries = (await c.query(`select l.at,l.direction,l.action,l.detail,l.sx_lead_id "sxLeadId",l.client_id "clientId",l.run_id "runId" from pulse.sales_xray_sync_log l
      where l.org_id=pulse.current_org() order by l.at desc,l.id desc limit 80`)).rows;
    return { ...s, stages, log: entries, canManage: leadership(v), mine: s.runnerPersonId === v.person,
      canRun: v.role === "admin" && !!link && org && (role === "owner" || role === "admin") && link.scopes.includes("leads:read"),
      connection: link ? { workspace: link.account?.workspace ?? null, kind: org ? "organisation" : "personal", role } : null };
  }));
  app.post<{ Body: { enabled?: unknown; makeClients?: unknown; pushClients?: unknown } | null }>("/api/v0/sales-xray/sync", { bodyLimit: 2048 }, (req) => tx(req, async (c, v) => {
    staffPerson(v);
    if (!leadership(v)) fail(403, "Leadership and admins set up lead sync");
    const b = req.body ?? {}, s = await settings(c);
    const enabled = typeof b.enabled === "boolean" ? b.enabled : s.enabled;
    const makeClients = b.makeClients === "all" || b.makeClients === "won" ? b.makeClients : s.makeClients;
    const pushClients = typeof b.pushClients === "boolean" ? b.pushClients : s.pushClients;
    let runner = s.runnerPersonId, workspace = s.workspace;
    if (enabled && (!s.enabled || !runner || b.enabled === true)) {
      // Client records are admins' to make and change (the client table's row policy), so the runner is a Pulse admin.
      if (v.role !== "admin") fail(403, "Lead sync makes and fills client records, so a Pulse admin turns it on");
      // Turning it on lends this person's connection: an owner or admin of a Sales X-Ray organisation.
      const link = (await db(c, "link")) as Link | null;
      if (!link) fail(409, "Connect your Sales X-Ray account first.");
      if (link!.account?.kind !== "organisation") fail(409, "Your Sales X-Ray workspace is Personal. Connect again and choose your organisation.");
      if (!["owner", "admin"].includes(String(link!.account?.role ?? ""))) fail(409, "Lead sync needs an owner or admin of the Sales X-Ray organisation. Ask one of them to turn it on.");
      runner = v.person; workspace = String(link!.account?.workspace ?? "").slice(0, 200);
    }
    await c.query(`insert into pulse.sales_xray_sync(org_id,enabled,runner_person_id,workspace,make_clients,push_clients,updated_by,updated_at) values (pulse.current_org(),$1,$2,$3,$4,$5,$6,now())
      on conflict (org_id) do update set enabled=excluded.enabled,runner_person_id=excluded.runner_person_id,workspace=excluded.workspace,make_clients=excluded.make_clients,
        push_clients=excluded.push_clients,updated_by=excluded.updated_by,updated_at=now()`, [enabled, runner, workspace, makeClients, pushClients, v.person]);
    await c.query("select pulse.audit_write($1,'sales_xray_sync',$2)", [enabled ? "sales_xray_sync_on" : "sales_xray_sync_off", JSON.stringify({ makeClients, pushClients })]).catch(() => {});
    return settings(c);
  }));
  // Sync now: runs as the runner (their connection), whoever presses it among leadership and admins.
  app.post("/api/v0/sales-xray/sync/run", (req) => tx(req, async (c, v) => {
    staffPerson(v);
    if (!leadership(v)) fail(403, "Leadership and admins run lead sync");
    const s = await settings(c);
    if (!s.enabled || !s.runnerPersonId) fail(409, "Turn lead sync on first.");
    let as = v;
    if (s.runnerPersonId !== v.person) { await c.query("select set_config('pulse.viewer_id',$1,true)", [s.runnerPersonId]); as = runnerViewer(v.org, s.runnerPersonId!, s.runnerName ?? "Lead sync"); }
    const r = await runSync(c, f, as);
    if (as !== v) await c.query("select set_config('pulse.viewer_id',$1,true)", [v.person]);
    return r;
  }));
  // The company's copy of its leads, with the client each is linked to (anyone in the company's staff may read it).
  app.get<{ Querystring: { stage?: string; q?: string; offset?: string } }>("/api/v0/sales-xray/synced-leads", (req) => tx(req, async (c, v) => {
    staffPerson(v);
    const stage = typeof req.query.stage === "string" && /^[a-z_]{1,40}$/.test(req.query.stage) ? req.query.stage : null;
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
    const offset = Math.min(100_000, Math.max(0, Number(req.query.offset) || 0));
    const rows = (await c.query(`select ${MIRROR},(select display_name from pulse.client where id=l.client_id) "clientName",l.updated_at "updatedAt" from pulse.sales_xray_lead l
      where l.org_id=pulse.current_org() and ($1::text is null or l.stage=$1) and ($2='' or l.name ilike '%'||$2||'%' or l.company ilike '%'||$2||'%' or l.city ilike '%'||$2||'%')
      order by l.gone_at nulls first,l.updated_at desc limit 51 offset $3`, [stage, q, offset])).rows;
    return { leads: rows.slice(0, 50), nextOffset: rows.length > 50 ? offset + 50 : null };
  }));
  // Link one lead copy to a client, or make a client for it (admins: client records are theirs to change).
  app.post<{ Params: { id: string }; Body: { clientId?: unknown; create?: unknown } | null }>("/api/v0/sales-xray/synced-leads/:id/client", { bodyLimit: 1024 }, (req) => tx(req, async (c, v) => {
    staffPerson(v);
    if (v.role !== "admin" && !leadership(v)) fail(403, "Admins and leadership link leads to clients");
    const id = uuid(req.params.id, "lead");
    const m = (await c.query(`select ${MIRROR} from pulse.sales_xray_lead where org_id=pulse.current_org() and sx_lead_id=$1`, [id])).rows[0] as Mirror | undefined;
    if (!m) fail(404, "Lead not found. Run lead sync first.");
    let client = optUuid(req.body?.clientId, "client");
    if (client && !(await c.query("select 1 from pulse.client where id=$1", [client])).rows[0]) fail(404, "Client not found");
    if (!client && req.body?.create === true) { if (v.role !== "admin") fail(403, "Admins make client records"); client = await makeClient(c, v, m!); }
    await c.query(`update pulse.sales_xray_lead set client_id=$2,updated_at=now() where org_id=pulse.current_org() and sx_lead_id=$1`, [id, client]);
    await log(c, randomUUID(), "in", client ? "linked" : "updated", client ? `${m!.name} linked to a client by ${v.name}` : `${m!.name} unlinked by ${v.name}`, id, client);
    return { ok: true, clientId: client };
  }));
  // A client as a Sales X-Ray lead ("Send to Sales X-Ray" on the client), with the viewer's own connection.
  app.post<{ Params: { id: string } }>("/api/v0/sales-xray/clients/:id/send", (req) => tx(req, async (c, v) => {
    staffPerson(v);
    const cl = (await c.query(`select ${CLIENT} from pulse.client c where c.id=$1`, [uuid(req.params.id, "client")])).rows[0] as ClientRow | undefined;
    if (!cl) fail(404, "Client not found");
    const linked = (await c.query(`select sx_lead_id from pulse.sales_xray_lead where org_id=pulse.current_org() and client_id=$1 and gone_at is null limit 1`, [cl!.id])).rows[0];
    if (linked) return { ok: true, id: linked.sx_lead_id, outcome: "linked", words: `${cl!.name} is already linked to a Sales X-Ray lead.` };
    return pushClient(c, f, v, cl!, randomUUID());
  }));
  // Clients to choose from when linking (names only).
  app.get("/api/v0/sales-xray/client-options", (req) => tx(req, async (c, v) => {
    staffPerson(v);
    return { clients: (await c.query(`select c.id,c.display_name name,c.city from pulse.client c where ${LIVE_CLIENT} order by c.display_name limit 3000`)).rows };
  }));
  // Everything Sales X-Ray about one client: its lead copy and linked calls (the client page's Sales X-Ray tab).
  app.get<{ Params: { id: string } }>("/api/v0/sales-xray/clients/:id", (req) => tx(req, async (c, v) => {
    staffPerson(v);
    const id = uuid(req.params.id, "client");
    const leads = (await c.query(`select ${MIRROR} from pulse.sales_xray_lead where org_id=pulse.current_org() and client_id=$1 order by gone_at nulls first,updated_at desc limit 5`, [id])).rows;
    const calls = (await c.query(`select ${LINKED} from pulse.sales_xray_call x where x.org_id=pulse.current_org() and x.client_id=$1 order by coalesce(x.call_at,x.linked_at) desc limit 30`, [id])).rows;
    const status = (await db(c, "status")) as { connected?: boolean };
    return { configured: !!salesXrayBase(), connected: !!status?.connected, sync: (await settings(c)).enabled, leads, calls, base: salesXrayBase() };
  }));
  app.get<{ Querystring: { client?: string; person?: string; call?: string } }>("/api/v0/sales-xray/linked", (req) => tx(req, async (c, v) => {
    staffPerson(v);
    const [col, id] = req.query.client ? ["client_id", req.query.client] : req.query.person ? ["person_id", req.query.person] : req.query.call ? ["pulse_call_id", req.query.call] : [null, null];
    if (!col) fail(400, "Choose a client, a person or a call");
    const rows = (await c.query(`select ${LINKED} from pulse.sales_xray_call x where x.org_id=pulse.current_org() and x.${col}=$1 order by coalesce(x.call_at,x.linked_at) desc limit 50`, [uuid(id, "record")])).rows as Linked[];
    // Calls still being analysed are read again (at most every 2 minutes) when the viewer is connected.
    const stale = rows.filter((r) => r.status !== "ready" && r.status !== "failed" && (!r.checkedAt || Date.now() - Date.parse(r.checkedAt) > 120_000)).slice(0, 5);
    if (stale.length && ((await db(c, "status")) as { connected?: boolean })?.connected) {
      for (const r of stale) await refreshCall(c, f, v, r.sxCallId).catch(() => {});
      return { calls: (await c.query(`select ${LINKED} from pulse.sales_xray_call x where x.org_id=pulse.current_org() and x.${col}=$1 order by coalesce(x.call_at,x.linked_at) desc limit 50`, [id])).rows };
    }
    return { calls: rows };
  }));
  // Link a Sales X-Ray call (one the viewer can read) to a client, a person and/or a Pulse call; reads its analysis now.
  app.post<{ Params: { id: string }; Body: { clientId?: unknown; personId?: unknown; pulseCallId?: unknown } | null }>("/api/v0/sales-xray/calls/:id/link", { bodyLimit: 1024 }, (req) => tx(req, async (c, v) => {
    const me = staffPerson(v), sx = uuid(req.params.id, "call");
    const client = optUuid(req.body?.clientId, "client"), person = optUuid(req.body?.personId, "person") ?? me, pulseCall = optUuid(req.body?.pulseCallId, "call");
    if (client && !(await c.query("select 1 from pulse.client where id=$1", [client])).rows[0]) fail(404, "Client not found");
    if (!(await c.query("select 1 from pulse.person where id=$1", [person])).rows[0]) fail(404, "Person not found");
    await read(c, f, v, `/calls/${sx}`); // the viewer must be able to read it in Sales X-Ray
    await c.query(`insert into pulse.sales_xray_call(org_id,sx_call_id,client_id,person_id,pulse_call_id,status,linked_by) values (pulse.current_org(),$1,$2,$3,$4,'analysing',$5)
      on conflict (org_id,sx_call_id) do update set client_id=coalesce(excluded.client_id,pulse.sales_xray_call.client_id),person_id=excluded.person_id,
        pulse_call_id=coalesce(excluded.pulse_call_id,pulse.sales_xray_call.pulse_call_id),linked_by=excluded.linked_by,linked_at=now()`, [sx, client, person, pulseCall, me]);
    await refreshCall(c, f, v, sx);
    return (await c.query(`select ${LINKED} from pulse.sales_xray_call x where x.org_id=pulse.current_org() and x.sx_call_id=$1`, [sx])).rows[0];
  }));
  app.post<{ Params: { id: string } }>("/api/v0/sales-xray/linked/:id/unlink", (req) => tx(req, async (c, v) => {
    staffPerson(v);
    const gone = (await c.query(`delete from pulse.sales_xray_call where org_id=pulse.current_org() and id=$1 and (linked_by=$2 or $3) returning id`, [uuid(req.params.id, "link"), v.person, leadership(v)])).rows[0];
    if (!gone) fail(404, "Only the person who linked this call, leadership or admins remove the link");
    return { ok: true };
  }));

  // Analyse a recording: start, send the parts, then send it to Sales X-Ray.
  app.post<{ Body: Record<string, unknown> | null }>("/api/v0/sales-xray/recordings", { bodyLimit: 4096 }, (req) => tx(req, async (c, v) => {
    const me = staffPerson(v), b = req.body ?? {};
    const size = Number(b.size), mime = String(b.mime ?? "").toLowerCase();
    if (!Number.isInteger(size) || size < 1 || size > MAX_RECORDING) fail(400, "Choose an audio or video file up to 100 MB");
    if (!RECORDING_TYPES.test(mime)) fail(400, "Choose an audio or video recording (MP3, M4A, WAV, OGG, MP4 …)");
    if (b.consent !== true) fail(400, "Confirm that the people on the call know it was recorded and agree to its analysis");
    const base = salesXrayBase(); if (!base) fail(409, "Sales X-Ray isn't set up on this Pulse server yet.");
    if (!(await db(c, "link"))) fail(409, "Connect your Sales X-Ray account first.");
    const meta: Upload = { org: v.org, person: me, name: String(b.name ?? "recording").replace(/[\x00-\x1f/\\]/g, "_").slice(0, 120), mime, size,
      title: clean(b.title, 120), callAt: clean(b.callAt, 40), clientId: optUuid(b.clientId, "client"), personId: optUuid(b.personId, "person") ?? me,
      pulseCallId: optUuid(b.pulseCallId, "call"), sxLeadId: optUuid(b.sxLeadId, "lead"), consent: true, parts: Math.ceil(size / PART), at: Date.now() };
    const id = randomUUID(), dir = join(holding(), id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "meta.json"), JSON.stringify(meta), { mode: 0o600 });
    return { uploadId: id, partSize: PART, parts: meta.parts };
  }));
  app.post<{ Params: { id: string }; Body: { index?: unknown; bytes?: unknown } | null }>("/api/v0/sales-xray/recordings/:id/parts", { bodyLimit: 4_300_000 }, (req) => tx(req, async (_c, v) => {
    staffPerson(v);
    const { dir, meta } = await upload(req.params.id, v);
    const index = Number(req.body?.index), bytes = String(req.body?.bytes ?? "");
    if (!Number.isInteger(index) || index < 0 || index >= meta.parts) fail(400, "Send the parts in order");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(bytes) || bytes.length > Math.ceil(PART / 3) * 4) fail(400, "A part is up to 3 MB");
    const have = (await stat(join(dir, "data")).catch(() => null))?.size ?? 0;
    if (have !== index * PART) fail(409, "Send the parts in order");
    await appendFile(join(dir, "data"), Buffer.from(bytes, "base64"), { mode: 0o600 });
    return { received: index + 1, of: meta.parts };
  }));
  app.post<{ Params: { id: string } }>("/api/v0/sales-xray/recordings/:id/send", (req) => tx(req, async (c, v) => {
    staffPerson(v);
    const { dir, meta } = await upload(req.params.id, v);
    try {
      const bytes = await readFile(join(dir, "data")).catch(() => Buffer.alloc(0));
      if (bytes.length !== meta.size) fail(409, "The file didn't arrive whole. Choose it again.");
      const { base, token } = await accessToken(c, f, v);
      const sha = createHash("sha256").update(bytes).digest("hex");
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", accept: "application/json",
        "x-source-sha256": sha, "x-recording-consent": "participants-informed", "x-external-id": `pulse-recording:${req.params.id}`, "x-file-name": encodeURIComponent(meta.name),
        "x-media-type": meta.mime, ...(meta.title ? { "x-call-title": encodeURIComponent(meta.title) } : {}), ...(meta.callAt ? { "x-call-at": meta.callAt } : {}), ...(meta.sxLeadId ? { "x-lead-id": meta.sxLeadId } : {}) };
      const r = await call(f, `${base}/v1/api/calls`, { method: "POST", headers, body: bytes }, 300_000);
      const out = (r.body ?? {}) as { id?: unknown; state?: unknown; open_url?: unknown; error?: { message?: unknown; code?: unknown } };
      if ([404, 405].includes(r.status)) return { sent: false, reason: "upload_unsupported", words: "Sales X-Ray can't take recordings from Pulse yet. Upload this one in Sales X-Ray itself, then link the call here." };
      if (r.status === 401) { await db(c, "drop"); fail(409, "Your Sales X-Ray connection ended. Connect it again."); }
      if (r.status === 403) return { sent: false, reason: "scope", words: "Connect Sales X-Ray again and allow Pulse to send calls." };
      if (![200, 201, 202].includes(r.status) || typeof out.id !== "string" || !UUID.test(out.id))
        return { sent: false, reason: "refused", words: typeof out.error?.message === "string" ? out.error.message : "Sales X-Ray didn't take the recording. Try again later." };
      const status = out.state === "analysing" ? "analysing" : out.state === "ready" ? "ready" : "waiting";
      await c.query(`insert into pulse.sales_xray_call(org_id,sx_call_id,title,call_at,client_id,person_id,pulse_call_id,sx_lead_id,status,open_url,linked_by) values (pulse.current_org(),$1,$2,$3::timestamptz,$4,$5,$6,$7,$8,$9,$10)
        on conflict (org_id,sx_call_id) do update set status=excluded.status,client_id=coalesce(excluded.client_id,pulse.sales_xray_call.client_id)`,
        [out.id, meta.title, meta.callAt, meta.clientId, meta.personId, meta.pulseCallId, meta.sxLeadId, status, clean(out.open_url, 400), meta.person]);
      return { sent: true, id: out.id, status, words: status === "waiting" ? "Sent. Sales X-Ray asks you to start the analysis there; the report shows here when it's ready." : "Sent. The report shows here when Sales X-Ray finishes." };
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }));
}
