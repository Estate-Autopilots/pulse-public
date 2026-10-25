// Records Pulse owns: people, clients, contacts, projects, and username sign-in. Sources seed them; the app edits
// them. Every edit locks the field against the next sync and is written to pulse.record_change.
import { ORG_TZ } from "./org-time.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { admin, leadership, manager, fail, hr, sessionHash, work, type Open, type Tx, type Viewer } from "./routes.js";
import { attendanceEnabled } from "./attendance-policy.js";
import { moduleOff, readModules } from "./modules.js";
import { sniff as sniffImage } from "./presence-onboard.js";

type PeriodT = { from: string; to: string; today: string; start: Date; end: Date; prevStart: Date; prevEnd: Date };
type Deps = {
  tx: Tx; open: Open;
  period: (c: PoolClient, req: FastifyRequest) => Promise<PeriodT>;
  publicPeriod: (p: never) => unknown;
  summary: (c: PoolClient, v: Viewer, req: FastifyRequest, account?: string | null) => Promise<unknown>;
  syncStatus: (c: PoolClient) => Promise<unknown>;
};
type Body = Record<string, unknown>;
type Entity = "person" | "client" | "contact" | "project";
type Field = { table: string; col: string; pk: string; lockTable?: string; lockPk?: string; kind?: "text" | "date" | "uuid"; values?: readonly string[]; max?: number; required?: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const profile = { table: "pulse.people_profile", pk: "person_id" } as const;
const contact = { table: "pulse.contact_profile", pk: "person_id" } as const;
const client = { table: "pulse.client", pk: "id" } as const;
const project = { table: "pulse.project", pk: "id" } as const;
const FIELDS: Record<Entity, Record<string, Field>> = {
  person: {
    name: { table: "pulse.person", col: "display_name", pk: "id", lockTable: profile.table, lockPk: profile.pk, required: true, max: 80 },
    status: { table: "pulse.person", col: "status", pk: "id", lockTable: profile.table, lockPk: profile.pk, values: ["active", "inactive", "offboarded"], required: true },
    role: { ...profile, col: "role", required: true, max: 80 },
    pod: { ...profile, col: "pod", max: 40 },
    managerId: { ...profile, col: "manager_id", kind: "uuid" },
    joinedOn: { ...profile, col: "joined_on", kind: "date" },
    department: { ...profile, col: "department", max: 60 },
    employmentType: { ...profile, col: "employment_type", values: ["full_time", "part_time", "intern", "contract", "freelance"] },
    email: { ...profile, col: "email", max: 120 },
    phone: { ...profile, col: "phone", max: 24 },
    workLocation: { ...profile, col: "work_location", max: 60 },
    notes: { ...profile, col: "notes", max: 2000 },
  },
  client: {
    displayName: { ...client, col: "display_name", required: true, max: 120 },
    companyName: { ...client, col: "company_name", max: 160 },
    clientType: { ...client, col: "client_type", required: true, max: 40 },   // one of the organisation's types (0213)
    status: { ...client, col: "status", values: ["prospect", "active", "paused", "churned"] },
    website: { ...client, col: "website", max: 160 }, email: { ...client, col: "email", max: 120 },
    phone: { ...client, col: "phone", max: 24 }, city: { ...client, col: "city", max: 80 }, notes: { ...client, col: "notes", max: 2000 },
  },
  contact: {
    name: { table: "pulse.person", col: "display_name", pk: "id", lockTable: contact.table, lockPk: contact.pk, required: true, max: 80 },
    contactType: { ...contact, col: "contact_type", max: 40 },
    designation: { ...contact, col: "designation", max: 80 }, email: { ...contact, col: "email", max: 120 },
    phone: { ...contact, col: "phone", max: 24 }, city: { ...contact, col: "city", max: 80 }, notes: { ...contact, col: "notes", max: 2000 },
  },
  project: {
    title: { ...project, col: "title", required: true, max: 160 },
    deliverableType: { ...project, col: "deliverable_type", max: 120 },
    clientId: { ...project, col: "client_id", kind: "uuid" },
    pgsId: { ...project, col: "lead_person_id", kind: "uuid" },
    status: { ...project, col: "status", values: ["onboarding", "active", "paused", "done", "cancelled"], required: true },
    location: { ...project, col: "location", max: 80 }, segment: { ...project, col: "segment", max: 60 },
  },
};
const lockName = (f: Field) => f.col === "display_name" && f.table === "pulse.person" ? "name" : f.col;

function clean(key: string, f: Field, raw: unknown): string | null {
  const value = raw === null || raw === undefined ? "" : String(raw).replace(/\s+/g, f.col === "notes" ? " " : " ").trim();
  if (!value) { if (f.required) fail(400, `${key} is required`); return null; }
  if (f.values && !f.values.includes(value)) fail(400, `Unknown ${key}`);
  if (f.kind === "uuid" && !UUID.test(value)) fail(400, `Invalid ${key}`);
  if (f.kind === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)))) fail(400, `Use a date such as 2026-10-05 for ${key}`);
  if (value.length > (f.max ?? 200)) fail(400, `${key} is too long`);
  return value;
}

/** Apply the changed fields of one record, lock them against the sync and log each change. */
async function edit(c: PoolClient, v: Viewer, entity: Entity, id: string, body: Body) {
  let changed = 0;
  if (entity === "person" && body.pod && !(await c.query("select 1 from pulse.unit where kind='pod' and valid_to is null and name=$1", [String(body.pod).trim()])).rows[0]) fail(400, "Unknown pod");
  for (const [key, f] of Object.entries(FIELDS[entity])) {
    if (!(key in body)) continue;
    const next = clean(key, f, body[key]);
    const row = (await c.query(`select ${f.col}::text v from ${f.table} where ${f.pk}=$1`, [id])).rows[0];
    if (!row) fail(404, "Record not found");
    if ((row.v ?? null) === next) continue;
    await c.query(`update ${f.table} set ${f.col}=$1 where ${f.pk}=$2`, [next, id]);
    await c.query(`update ${f.lockTable ?? f.table} set locked=array(select distinct unnest(locked || $1::text)),updated_at=now() where ${f.lockPk ?? f.pk}=$2`, [lockName(f), id]);
    await c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values ($1,$2,$3,$4,$5,$6,$7)`,
      [v.org, entity, id, key, row.v, next, v.person]);
    changed += 1;
  }
  return changed;
}
// A manager is stored by id; the history shows the name.
const NAMED = (col: string) => `case when h.field in ('managerId','pgsId') then coalesce((select n.display_name from pulse.person n where n.id::text=h.${col}),h.${col}) else h.${col} end`;
const history = async (c: PoolClient, entity: Entity, id: string) => (await c.query(`select h.field,${NAMED("old_value")} "from",${NAMED("new_value")} "to",
  h.changed_at "at",p.display_name "by" from pulse.record_change h left join pulse.person p on p.id=h.changed_by
  where h.entity_type=$1 and h.entity_id=$2 order by h.changed_at desc limit 30`, [entity, id])).rows;
/** A manager must be a staff member, not the person themself, and not someone who already reports up to that person. */
async function checkManager(c: PoolClient, person: string, manager: string) {
  if (!UUID.test(manager)) fail(400, "Invalid managerId");
  if (manager === person) fail(400, "A person cannot be their own manager");
  const who = (await c.query(`select p.display_name name,p.status from pulse.person p join pulse.people_profile pp on pp.person_id=p.id
    where p.id=$1 and p.side='staff'`, [manager])).rows[0];
  if (!who) fail(400, "Choose a manager from the staff list");
  if (who.status !== "active") fail(400, `${who.name} is not a current member of staff`);
  const loop = (await c.query(`with recursive up as (
      select pp.manager_id id,1 depth from pulse.people_profile pp where pp.person_id=$1
      union all select pp.manager_id,up.depth+1 from up join pulse.people_profile pp on pp.person_id=up.id where up.id is not null and up.depth < 50)
    select exists(select 1 from up where id=$2) found`, [manager, person])).rows[0].found;
  if (loop) fail(400, `${who.name} already reports, directly or through others, to this person. Change that first.`);
}
const mustId = (id: string, what: string) => { if (!UUID.test(id)) fail(404, `${what} not found`); };
const canEditRecords = (v: Viewer) => { if (!admin(v)) fail(403, "Only an organisation admin can edit this record"); if (!v.person) fail(403, "A shared login cannot edit records"); };

/** A new staff identity's username, first.last then first.last2…, under the company's staff-identity lock (held to the
 *  end of the transaction) so a person and an AI employee added at once never get the same one (EST-1733). */
export async function staffUsername(c: PoolClient, org: string, name: string) {
  await c.query("select pg_advisory_xact_lock(hashtext($1))",["staff-identity:"+org]);
  const base = (name.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim().split(/\s+/).filter((_,i,a)=>i===0||i===a.length-1).join(".") || "user").padEnd(3, "x").slice(0, 36);
  const taken = new Set((await c.query("select username from pulse.people_profile where username like $1", [`${base}%`])).rows.map(r => r.username));
  let username = base; for (let n = 2; taken.has(username); n += 1) username = `${base}${n}`;
  return username;
}

// PEOPLE-CONTACTS part 4: an organisation's own contact and client types (migration 0213) and each type's own fields.
type TypeField = { key: string; label: string; type: "text" | "number" | "date" | "url" | "tel" | "email" | "choice"; options?: string[] };
export const recordTypes = async (c: PoolClient, entity?: "contact" | "client") => (await c.query("select pulse.record_types($1) t", [entity ?? null])).rows[0].t as
  { entity: string; key: string; label: string; plural: string; color: string; hint: string | null; fields: TypeField[]; archived: boolean; system: boolean; count: number }[];
/** One custom value, checked against its field: text (200 characters), a number, a date, a link, a phone, an e-mail or one of the choices. */
function customValue(f: TypeField, raw: unknown): string | number | null {
  const v = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!v) return null;
  if (f.type === "number") { const n = Number(v.replace(/,/g, "")); if (!Number.isFinite(n)) fail(400, `${f.label} is a number`); return n; }
  if (f.type === "date" && !(/^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)))) fail(400, `${f.label} is a date such as 2026-10-11`);
  if (f.type === "url" && !/^(https?:\/\/)?[^\s/$.?#][^\s]*\.[^\s]{2,}$/i.test(v)) fail(400, `${f.label} is a web address`);
  if (f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) fail(400, `${f.label} is an e-mail address`);
  if (f.type === "tel" && !/^\+?[0-9][0-9 -]{5,20}$/.test(v)) fail(400, `${f.label} is a phone number`);
  if (f.type === "choice" && !(f.options ?? []).includes(v)) fail(400, `Choose one of the options for ${f.label}`);
  if (v.length > 200) fail(400, `${f.label} is too long`);
  return f.type === "url" && !/^https?:\/\//i.test(v) ? `https://${v}` : v;
}
/** Save "custom.<field>" values for the record's current type; each change is in the record's history. */
async function saveCustom(c: PoolClient, v: Viewer, entity: "contact" | "client", id: string, body: Body) {
  const entries = Object.entries(body).filter(([k]) => k.startsWith("custom."));
  if (!entries.length) return 0;
  const [table, pk, col] = entity === "contact" ? ["pulse.contact_profile", "person_id", "contact_type"] : ["pulse.client", "id", "client_type"];
  const row = (await c.query(`select ${col} t,custom from ${table} where ${pk}=$1`, [id])).rows[0];
  if (!row) fail(404, "Record not found");
  const fields = new Map<string, TypeField>(((await c.query("select fields from pulse.record_type where entity=$1 and key=$2", [entity, row.t])).rows[0]?.fields ?? []).map((f: TypeField) => [f.key, f]));
  const next: Record<string, unknown> = { ...row.custom }; let changed = 0;
  for (const [k, raw] of entries) {
    const key = k.slice(7), f = fields.get(key);
    if (!f) fail(400, `This type has no field ${key}`);
    const value = customValue(f!, raw);
    if ((next[key] ?? null) === value) continue;
    await c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values ($1,$2,$3,$4,$5,$6,$7)`,
      [v.org, entity, id, `custom.${key}`, next[key] === undefined ? null : String(next[key]), value === null ? null : String(value), v.person]);
    if (value === null) delete next[key]; else next[key] = value;
    changed += 1;
  }
  if (changed) await c.query(`update ${table} set custom=$1,updated_at=now() where ${pk}=$2`, [next, id]);
  return changed;
}

// A stage says what Drive shows right now; the recorded status (paused, done, cancelled) wins when someone set it.
const STAGE = `case when p.status in ('paused','done','cancelled') then p.status
  when d.last >= now() - interval '14 days' then 'delivering'
  when d.last >= now() - interval '56 days' then 'quiet'
  when d.last is null and p.start_month >= (now() - interval '60 days')::date then 'new'
  else 'dormant' end`;
const DELIVERIES = (account = "$1") => `(select project_id,count(*)::int n,max(delivered_at) last,min(delivered_at) first
  from pulse.delivery where pulse.delivery_matches(file_id,${account}) group by 1)`;
const PROJECT_COLS = `p.id "projectId",coalesce(p.title,p.name) title,p.name "folderName",p.status,p.kind,p.location,p.segment,p.deliverable_type "deliverableType",
  p.start_month::text "startMonth",p.project_key "projectKey",p.registry_no "registryNo",u.name pod,
  p.client_id "clientId",cl.display_name "clientName",coalesce(d.n,0) total,d.last "lastDeliveredAt",${STAGE} stage`;
const PROJECT_FROM = (account?: string) => `pulse.project p left join pulse.unit u on u.id=p.unit_id left join pulse.client cl on cl.id=p.client_id
  left join ${DELIVERIES(account)} d on d.project_id=p.id`;


export function registerRecordRoutes(app: FastifyInstance, { tx, period, publicPeriod, summary, syncStatus }: Deps) {
  const body = { type: "object" } as const;
  const visible = (v: Viewer) => leadership(v) ? null : manager(v) ? `team:${v.person}` : v.person ? `person:${v.person}` : v.email;

  // ---------------------------------------------------------------------------------------------------- people
  const PERSON = `p.id,p.display_name name,(select pe.display_name from pulse.record_change rc join pulse.person pe on pe.id=rc.changed_by where rc.entity_type='person' and rc.entity_id=p.id order by rc.changed_at desc limit 1) "editedBy",p.status,pp.user_no "userNo",pp.pulse_id "pulseId",pp.username,pp.role,pp.pod,pp.department,pp.accounts,
    pp.joined_on::text "joinedOn",pp.manager_id "managerId",m.display_name "managerName",ph.updated_at "photoAt",
    pp.skills,pp.work_location "workLocation",pp.about,pp.pronouns,pp.languages`;
  const PERSON_FROM = `pulse.person p join pulse.people_profile pp on pp.person_id=p.id left join pulse.person m on m.id=pp.manager_id
    left join pulse.person_photo ph on ph.person_id=p.id`;
  app.get("/api/v0/people", req => tx(req, async (c, v) => {
    // `lite=1` (LAYOUT-SWEEP): names, status, team and pods only, for pickers such as a person's edit form; the full
    // directory adds per-person counts that take a second to work out.
    if ((req.query as { lite?: string }).lite === "1") {
      const people = (await c.query(`select p.id,p.display_name name,p.status,pp.department,pp.pod from pulse.person p join pulse.people_profile pp on pp.person_id=p.id
        where p.side='staff' order by p.display_name`)).rows;
      const pods = (await c.query(`select name from pulse.unit where kind='pod' and valid_to is null
        order by array_position(array['Leadership','Pod 1','Pod 2','Shared'],name) nulls last,name`)).rows.map(r => r.name);
      return { people, pods };
    }
    const enabled = await attendanceEnabled(c);
    // FEATURES-1024 (telemetry: this read took ~1.2 s, nearly all database): delivery_actor is a view that groups every
    // upload and create observation; asked once per person it ran 56 times (19 ms each). Each person's deliveries in the
    // last 8 weeks are now counted once for everyone (d8) and joined; the same count (each delivery once per actor).
    const people = (await c.query(`with d8 as (select oa.actor_id, count(*)::int n from pulse.delivery d
        join (select distinct file_id, actor_id from pulse.delivery_actor) oa on oa.file_id=d.file_id
        where d.delivered_at >= now() - interval '56 days' group by oa.actor_id)
      select ${PERSON},case when $1 then pp.evidence else 'Company team lists' end evidence,case when $1 then pp.email end email,
      (case when pulse.person_work_access(p.id) or $1 then coalesce(d8.n,0) else 0 end) "deliveries8w",
      case when $2::boolean then exists(select 1 from pulse.attendance_effective e where e.person_id=p.id and e.checked_out_at is null) else false end "checkedIn",
      (select count(*)::int from pulse.person_source s where s.person_id=p.id) sources,
      (select coalesce(array_agg(f.field order by f.field),'{}') from pulse.person_flag f where f.person_id=p.id and f.status='open') flags,
      case when $1 or p.id=$3 then pulse.lifecycle_stage(p.id) when p.status='active' then 'active' else 'left' end stage,
      case when $1 then (select left_on from pulse.person_lifecycle l where l.person_id=p.id) end "leftOn",
      pulse.viewer_is('admin','hr') and pulse.lifecycle_possibly_left(p.id) "possiblyLeft"
      from ${PERSON_FROM} left join d8 on d8.actor_id=p.id where p.side='staff'
      order by array_position(array['Leadership','Pod 1','Pod 2','Shared'],pp.pod) nulls last,p.display_name`, [hr(v), enabled, v.person])).rows;
    const pods = (await c.query(`select name from pulse.unit where kind='pod' and valid_to is null
      order by array_position(array['Leadership','Pod 1','Pod 2','Shared'],name) nulls last,name`)).rows.map(r => r.name);
    return { attendanceEnabled: enabled, people, pods, canEdit: hr(v) && !!v.person, viewer: v.person };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/people/:id", req => tx(req, async (c, v) => {
    const enabled = await attendanceEnabled(c);
    mustId(req.params.id, "Person");
    // `for=<tab>` (LAYOUT-SWEEP): the person page asks only for what the open tab shows. The week's activity is read for
    // Work and the credited deliveries for Deliveries; without `for` everything is returned, as before.
    const part = String((req.query as { for?: string }).for ?? "");
    const wants = (tab: string) => !part || part === tab;
    const self = v.person === req.params.id, staff = hr(v);
    const p = (await c.query(`select ${PERSON},case when $3 then pp.evidence else 'Company team lists' end evidence,pp.locked,p.created_at "createdAt",
      case when $2 then pp.employment_type end "employmentType",
      case when $3 then pp.field_sources else '{}' end "fieldSources",case when $2 then pp.email end email,
      case when $2 then pp.phone end phone,case when $2 then pp.notes end notes,
      p.side='agent' agent,(select am.employee_id from pulse.agent_member am where am.person_id=p.id) "employeeId"
      from ${PERSON_FROM} where p.id=$1 and (p.side='staff' or p.side='agent' and pulse.agent_profile(p.id) is not null)`, [req.params.id, staff || self, staff])).rows[0];
    if (!p) fail(404, "Person not found");
    // AI-EMPLOYEES v2: an AI employee has this same profile (shown where agent_profile shows it); its record is changed
    // in its AI section (agent_settings_save), not with a person's edit form, and it has no sign-in or HR record.
    const ai = p.agent === true;
    // Who it reports to is kept on the AI employee (agent_member.owner_person_id) when the profile has no manager.
    if (ai && !p.managerId) {
      const o = (await c.query('select o.id,o.display_name name from pulse.agent_member m join pulse.person o on o.id=m.owner_person_id where m.person_id=$1', [p.id])).rows[0];
      if (o) { p.managerId = o.id; p.managerName = o.name; }
    }
    const accounts = (await c.query(`select a.handle,a.purpose,a.is_shared "shared",
      (case when pulse.person_work_access($1) then (select count(*)::int from pulse.delivery d where d.uploader_account=a.handle) else 0 end) deliveries
      from pulse.account a where a.holder_person_id=$1 and a.provider='google' order by a.handle`, [p.id])).rows;
    const reports = (await c.query(`select r.id,r.display_name name,rp.role,rp.user_no "userNo",rph.updated_at "photoAt"
      from pulse.people_profile rp join pulse.person r on r.id=rp.person_id left join pulse.person_photo rph on rph.person_id=r.id
      where rp.manager_id=$1 and r.status='active' order by r.display_name`, [p.id])).rows;
    // The reporting line above this person, nearest manager first. The depth limit also stops a loop in old data.
    const managers = (await c.query(`with recursive up as (
        select coalesce(pp.manager_id,(select am.owner_person_id from pulse.agent_member am where am.person_id=pp.person_id)) id,1 depth from pulse.people_profile pp where pp.person_id=$1 and coalesce(pp.manager_id,(select am.owner_person_id from pulse.agent_member am where am.person_id=pp.person_id)) is not null
        union all select pp.manager_id,up.depth+1 from up join pulse.people_profile pp on pp.person_id=up.id where pp.manager_id is not null and up.depth < 8)
      select m.id,m.display_name name,mp.role,mp.user_no "userNo",mph.updated_at "photoAt" from up join pulse.person m on m.id=up.id
      left join pulse.people_profile mp on mp.person_id=m.id left join pulse.person_photo mph on mph.person_id=m.id order by up.depth`, [p.id])).rows;
    // Work is visible to the person and to admins; HR sees the record, attendance and leave, not delivery data.
    const seeWork = (await c.query("select pulse.person_work_access($1) ok",[p.id])).rows[0].ok;
    const attributionHow = seeWork ? (await c.query(`select distinct item->>'how' how from pulse.attribution a,
      jsonb_array_elements(a.evidence) item where a.person_id=$1 and a.method<>'unresolved'
      and a.resolver_version='delivery-attribution/v1' and a.event_time>=now()-interval '30 days'
      and item ? 'how' order by how`, [p.id])).rows
      .map(row => row.how as string) : [];
    if (attributionHow.length) p.evidence = `${p.evidence} Delivery credit uses ${attributionHow.join(", ")}.`;
    const activity = seeWork && wants("work") ? await summary(c, v, req, `person:${p.id}`) : null;
    const projects = seeWork && wants("work") ? (await c.query(`select pr.id "projectId",coalesce(pr.title,pr.name) title,cl.display_name "clientName",
      count(*)::int deliveries,max(d.delivered_at) "lastDeliveredAt" from pulse.delivery d join pulse.project pr on pr.id=d.project_id
      left join pulse.client cl on cl.id=pr.client_id where pulse.delivery_matches(d.file_id,$1) group by pr.id,cl.display_name
      order by max(d.delivered_at) desc limit 50`, [`person:${p.id}`])).rows : [];
    const deliveries = seeWork && wants("deliveries") ? (await c.query(`select d.file_id "fileId",coalesce(f.display_name,f.name) "fileName",
      (select pe.display_name from pulse.delivery_actor oa join pulse.person pe on pe.id=oa.actor_id where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorName",
      (select oa.actor_account from pulse.delivery_actor oa where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorAccount",
      (select oa.basis from pulse.delivery_actor oa where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorBasis",
      (select pe.display_name from pulse.file_correction fc join pulse.person pe on pe.id=fc.edited_by where fc.org_id=d.org_id and fc.file_id=d.file_id) "editedBy",f.mime,pr.id "projectId",coalesce(pr.title,pr.name) "projectName",
      d.uploader_account "uploaderAccount",d.kind "deliverableType",d.delivered_at "deliveredAt",d.rule_detail "ruleDetail",f.path,false "sharedLogin",true "identityVerified"
      from pulse.delivery d join pulse.index_file f using(org_id,file_id) join pulse.project pr on pr.id=d.project_id
      where pulse.delivery_matches(d.file_id,$1) order by d.delivered_at desc limit 40`, [`person:${p.id}`])).rows : [];
    const seeHr = staff || self || (await c.query("select pulse.manages($1) ok",[p.id])).rows[0].ok;
    const attendance = seeHr && enabled ? (await c.query(`select id,checked_in_at "checkedInAt",checked_out_at "checkedOutAt" from pulse.attendance_entry
      where person_id=$1 order by checked_in_at desc limit 30`, [p.id])).rows : [];
    const leave = seeHr ? (await c.query(`select id,from_date::text "fromDate",to_date::text "toDate",leave_kind kind,status from pulse.leave_request
      where person_id=$1 order by from_date desc limit 30`, [p.id])).rows : [];
    const login = hr(v) || self ? (await c.query(`select status,must_change "mustChange",issued_at "issuedAt",last_login_at "lastLoginAt"
      from pulse.login_credential where person_id=$1`, [p.id])).rows[0] ?? null : undefined;
    // Where the record comes from. Row-level security hides HR-document sources from everyone but HR and admins.
    const sources = (await c.query(`select source,label,written_name "writtenName",role,grp "group",last_seen::text "lastSeen",restricted
      from pulse.person_source where person_id=$1 order by restricted,source,label`, [p.id])).rows;
    const flags = (await c.query(`select f.id,f.field,f.summary,f.options,f.status,f.resolution,f.resolved_at "resolvedAt",r.display_name "resolvedBy"
      from pulse.person_flag f left join pulse.person r on r.id=f.resolved_by where f.person_id=$1 and ($2 or f.field in ('pod','role'))
      order by (f.status='open') desc,f.field`, [p.id, staff])).rows;
    const restricted = staff && !!v.person && (await c.query(`select pulse.hr_can('hr.salary.read') salary,pulse.hr_can('hr.contact.read') contact,
      pulse.hr_can('hr.contact.write') "contactWrite",pulse.hr_can('hr.documents.read') documents`)).rows[0];
    // RT1 work terms (mode, role status, rhythm). Row-level security shows them to the person, their manager, HR and leadership.
    const workTerms = (await c.query(`select work_mode "workMode",role_title "roleTitle",role_status "roleStatus",weekly_hours_min "hoursMin",weekly_hours_max "hoursMax",
      office_days_min "officeMin",office_days_max "officeMax",other_roles "otherRoles",note from pulse.person_work_terms where person_id=$1`, [p.id])).rows[0] ?? null;
    return { ...p, attendanceEnabled: enabled, accounts, reports, managers, activity, projects, deliveries, attendance, leave, login, sources, flags, workTerms,
      history: staff ? await history(c, "person", p.id) : [],
      can: { edit: staff && !!v.person && !ai, photo: !!v.person && (await c.query("select pulse.photo_can($1) ok", [p.id])).rows[0].ok, self: (staff || self) && !!v.person && !ai, me: self, login: ["admin","hr"].includes(v.role) && !ai, link: admin(v) && !ai, work: seeWork, hr: seeHr && !ai,
        record: staff && !ai, salary: !!restricted && restricted.salary, contact: !!restricted && restricted.contact,
        contactWrite: !!restricted && restricted.contactWrite, documents: !!restricted && restricted.documents, workMode: ["admin","hr"].includes(v.role) && !!v.person && !ai,
        // R48: structured skills and the reviewed CV: the person, their manager or pod head, HR and admins (when the
        // skills module is on: RELEASE-5 ships it off until E16).
        skills: !!v.person && !moduleOff(await readModules(c, v.org), "skills") && (await c.query("select pulse.skill_profile_access($1) ok", [p.id])).rows[0].ok },
      workDetail: !p.accounts.length ? "No individual account is linked to this person yet. Deliveries from shared logins are listed under Editors and are not credited to anyone."
        : seeWork ? "Delivery files with qualified uploader evidence for this person; shared logins and unknown actors are uncredited." : "Work is visible to the person, their manager/PGS and leadership." };
  }));
  app.post<{ Body: Body }>("/api/v0/people", { schema: { body } }, req => tx(req, async (c, v) => {
    if (!hr(v) || !v.person) fail(403, "Only HR or an organisation admin can add people");
    const name = clean("name", FIELDS.person.name, req.body.name)!, role = clean("role", FIELDS.person.role, req.body.role)!;
    const pod = clean("pod", FIELDS.person.pod, req.body.pod);
    if (pod && !(await c.query("select 1 from pulse.unit where kind='pod' and valid_to is null and name=$1", [pod])).rows[0]) fail(400, "Unknown pod");
    const username = await staffUsername(c, v.org, name);
    const id = (await c.query("insert into pulse.person(org_id,display_name,side) values ($1,$2,'staff') returning id", [v.org, name])).rows[0].id;
    await c.query(`insert into pulse.people_profile(org_id,person_id,role,pod,evidence,user_no,username,locked)
      values ($1,$2,$3,$4,$5,(select coalesce(max(user_no),0)+1 from pulse.people_profile),$6,'{name,role,pod,status}')`,
    [v.org, id, role, pod, `Added in Pulse by ${v.name}.`, username]);
    await c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,new_value,changed_by) values ($1,'person',$2,'created',$3,$4)`, [v.org, id, name, v.person]);
    if (req.body.managerId) await checkManager(c, id, String(req.body.managerId));
    await edit(c, v, "person", id, Object.fromEntries(Object.entries(req.body).filter(([k]) => !["name", "role", "pod"].includes(k))));
    return { id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/people/:id", { schema: { body } }, req => tx(req, async (c, v) => {
    mustId(req.params.id, "Person");
    if (!hr(v) || !v.person) fail(403, "Only HR or an organisation admin can edit people");
    if (req.body.managerId) await checkManager(c, req.params.id, String(req.body.managerId));
    if (req.body.status && req.body.status !== "active" && req.params.id === v.person) fail(400, "You cannot deactivate your own record");
    return { changed: await edit(c, v, "person", req.params.id, req.body) };
  }));
  // Restricted HR data: personal contact, salary history and document names. The database functions check the HR or
  // admin role and the named permission, and log every read; nothing here is cached or written to the request log.
  app.get<{ Params: { id: string } }>("/api/v0/people/:id/hr", req => tx(req, async (c, v) => {
    mustId(req.params.id, "Person");
    if (!hr(v) || !v.person) fail(403, "HR records are visible to HR and leadership only");
    const can = (await c.query(`select pulse.hr_can('hr.salary.read') salary,pulse.hr_can('hr.contact.read') contact,
      pulse.hr_can('hr.documents.read') documents`)).rows[0];
    if (!can.salary && !can.contact && !can.documents) fail(403, "Your account does not have permission to read restricted HR records");
    const id = req.params.id;
    return {
      contact: can.contact ? (await c.query(`select personal_email "personalEmail",personal_phone "personalPhone",emergency,source,updated_at "updatedAt"
        from pulse.hr_contact_read($1)`, [id])).rows[0] ?? null : undefined,
      compensation: can.salary ? (await c.query('select pulse.hr_salary_components_read($1) data', [id])).rows[0].data : undefined,
      documents: can.documents ? (await c.query(`select doc_type "type",file_id "fileId",file_name "fileName",location from pulse.hr_documents_read($1)`, [id])).rows : undefined,
      accessLog: can.salary ? (await c.query(`select at,viewer,resource,purpose from pulse.hr_access_log($1,12)`, [id])).rows : [],
    };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/people/:id/hr-contact", { schema: { body } }, req => tx(req, async (c, v) => {
    mustId(req.params.id, "Person");
    if (!hr(v) || !v.person) fail(403, "Only HR or leadership can edit personal contact details");
    // Only the fields sent are changed; the rest keep their stored value.
    const now = (await c.query(`select personal_email "personalEmail",personal_phone "personalPhone",emergency from pulse.hr_contact_read($1)`, [req.params.id])).rows[0] ?? {};
    const text = (key: string, max: number) => { const value = key in req.body ? String(req.body[key] ?? "").trim() : String(now[key] ?? ""); if (value.length > max) fail(400, `${key} is too long`); return value; };
    await c.query("select pulse.hr_contact_write($1,$2,$3,$4)", [req.params.id, text("personalEmail", 120), text("personalPhone", 24), text("emergency", 160)]);
    return { ok: true };
  }));
  // Settle a "needs confirmation" question: the chosen value becomes the record's value and is locked against the sync.
  const FLAG_FIELD: Record<string, string> = { pod: "pod", role: "role", status: "status", joined_on: "joinedOn", identity: "name" };
  app.post<{ Params: { id: string; flag: string }; Body: Body }>("/api/v0/people/:id/flags/:flag", { schema: { body } }, req => tx(req, async (c, v) => {
    mustId(req.params.id, "Person"); mustId(req.params.flag, "Question");
    if (!hr(v) || !v.person) fail(403, "Only HR or an organisation admin can confirm this");
    const flag = (await c.query("select field,options from pulse.person_flag where id=$1 and person_id=$2 and status='open' for update", [req.params.flag, req.params.id])).rows[0];
    if (!flag) fail(409, "This question is already settled");
    const value = String(req.body.value ?? "").trim();
    if (!value) fail(400, "Choose a value");
    await edit(c, v, "person", req.params.id, { [FLAG_FIELD[flag.field]]: value });
    // The chosen value is locked even when it equals the current one, so the next sync keeps it.
    const f = FIELDS.person[FLAG_FIELD[flag.field]];
    await c.query(`update pulse.people_profile set locked=array(select distinct unnest(locked || $1::text)) where person_id=$2`, [lockName(f), req.params.id]);
    await c.query("update pulse.person_flag set status='resolved',resolution=$1,resolved_by=$2,resolved_at=now() where id=$3", [value, v.person, req.params.flag]);
    return { ok: true };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/people/:id/photo", req => tx(req, async (c) => {
    mustId(req.params.id, "Photo");
    const row = (await c.query("select mime,encode(bytes,'base64') data,updated_at \"updatedAt\" from pulse.person_photo where person_id=$1", [req.params.id])).rows[0];
    if (!row) fail(404, "No photo"); return row;
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/people/:id/photo", { schema: { body } }, req => tx(req, async (c, v) => {
    mustId(req.params.id, "Person");
    // PEOPLE-CONTACTS: the database decides (pulse.photo_can, migration 0210): yourself; staff photos HR, leadership and
    // admins; contacts' photos admins. The same route serves people and contacts (both are pulse.person rows).
    if (!(await c.query("select 1 from pulse.person where id=$1", [req.params.id])).rows[0]) fail(404, "Person not found");
    if (!(await c.query("select pulse.photo_can($1) ok", [req.params.id])).rows[0].ok) fail(403, "You can change your own photo; HR and admins change colleagues' photos, and admins contacts' photos");
    if (req.body.remove) { await c.query("delete from pulse.person_photo where person_id=$1", [req.params.id]); return { photoAt: null }; }
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.dataUrl ?? ""));
    if (!m) fail(400, "Upload a JPEG, PNG or WebP image");
    const bytes = Buffer.from(m![2], "base64");
    if (bytes.length > 400000) fail(400, "The image is too large");
    if (!sniffImage(bytes, m![1])) fail(400, "That file is not the picture it says it is");
    return (await c.query(`insert into pulse.person_photo(org_id,person_id,mime,bytes,updated_by) values ($1,$2,$3,$4,$5)
      on conflict(person_id) do update set mime=excluded.mime,bytes=excluded.bytes,updated_by=excluded.updated_by,updated_at=now()
      returning updated_at "photoAt"`, [v.org, req.params.id, m![1], bytes, v.person])).rows[0];
  }));
  // Linking an uploader account to a person is what lets Pulse credit deliveries to them. Shared logins never link.
  app.get("/api/v0/accounts", req => tx(req, async (c, v) => {
    if (!admin(v)) fail(403, "Only an organisation admin can link accounts");
    return { accounts: (await c.query(`select a.handle,a.purpose,count(d.file_id)::int deliveries,max(d.delivered_at) "lastDelivery"
      from pulse.account a left join pulse.delivery d on d.uploader_account=a.handle
      where a.provider='google' and not a.is_shared and a.holder_person_id is null
      group by a.handle,a.purpose order by count(d.file_id) desc,a.handle limit 400`)).rows };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/people/:id/accounts", { schema: { body } }, req => tx(req, async (c, v) => {
    mustId(req.params.id, "Person"); canEditRecords(v);
    const handle = String(req.body.handle ?? "").trim().toLowerCase(), unlink = req.body.action === "unlink";
    const a = (await c.query("select is_shared,holder_person_id,purpose from pulse.account where provider='google' and handle=$1 for update", [handle])).rows[0];
    if (!a) fail(404, "Account not found");
    if (a.is_shared) fail(400, "A shared login cannot be linked to one person");
    if (unlink ? a.holder_person_id !== req.params.id : a.holder_person_id) fail(409, unlink ? "This account is not linked to this person" : "This account is already linked to a person");
    if (unlink && String(a.purpose).startsWith("Workspace")) fail(400, "Workspace accounts follow the Google directory");
    await c.query("update pulse.account set holder_person_id=$1,purpose=$2 where provider='google' and handle=$3",
      [unlink ? null : req.params.id, unlink ? "Uploader identity unverified" : `Linked in Pulse by ${v.name}`, handle]);
    await c.query(`update pulse.people_profile pp set accounts=coalesce((select array_agg(a.handle order by (a.handle=pp.email) desc,a.handle)
      from pulse.account a where a.holder_person_id=pp.person_id and a.provider='google'),'{}') where pp.person_id=$1`, [req.params.id]);
    await c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values ($1,'person',$2,'account',$3,$4,$5)`,
      [v.org, req.params.id, unlink ? handle : null, unlink ? null : handle, v.person]);
    return { ok: true };
  }));

  // ------------------------------------------------------------------------------------ username + password
  app.post("/api/v0/auth/sign-out", req => tx(req, async (c) => {
    const token = req.headers["x-pulse-session"];
    await c.query("select pulse.audit_write('sign_out','username')");
    if (typeof token === "string") await c.query("select pulse.auth_logout('staff',$1)", [sessionHash(token)]);
    return { ok: true };
  }));
  app.post("/api/v0/admin/invite-current", req => tx(req, async (_c,v) => {if(!["admin","hr"].includes(v.role))fail(403,"HR or admin required");fail(410, "Use Preview team invitations or Resend invitation");}));
  app.get("/api/v0/admin/access", req => tx(req, async (c, v) => {
    if (!["admin","hr"].includes(v.role)) fail(403,"HR or admin manages employee sign-in");
    const people = (await c.query(`select p.id,p.display_name name,pp.user_no "userNo",pp.pulse_id "pulseId",pp.username,pp.role,pp.pod,pp.accounts,ph.updated_at "photoAt",
      lc.status "loginStatus",lc.must_change "mustChange",lc.issued_at "issuedAt",lc.last_login_at "lastLoginAt",lc.locked_until > now() locked
      from pulse.person p join pulse.people_profile pp on pp.person_id=p.id left join pulse.login_credential lc on lc.person_id=p.id
      left join pulse.person_photo ph on ph.person_id=p.id where p.side='staff' order by pp.user_no`)).rows;
    const requests = (await c.query(`select r.id,r.username,r.person_id "personId",p.display_name name,r.status,r.requested_at "requestedAt",
      r.resolved_at "resolvedAt",rb.display_name "resolvedBy" from pulse.password_reset_request r left join pulse.person p on p.id=r.person_id
      left join pulse.person rb on rb.id=r.resolved_by order by (r.status='pending') desc,r.requested_at desc limit 50`)).rows;
    const runs = (await c.query(`select id,source,started_at "startedAt",finished_at "finishedAt",ok,error,upstream_at "upstreamAt",stats
      from pulse.sync_run order by started_at desc limit 12`)).rows;
    const security=(await c.query("select pulse.auth_admin_state('staff') d")).rows[0].d;
    return { people:people.map(p=>({...p,...security.find((s:{id:string})=>s.id===p.id)})), requests, runs, sync: await syncStatus(c) };
  }));
  // --------------------------------------------------------------------------------------------------- clients
  const CLIENT = `c.id,c.display_name name,c.company_name "companyName",c.client_type "clientType",c.type_basis "typeBasis",c.status,c.city,c.source,
    pc.id "contactId",pc.display_name "contactName"`;
  app.get("/api/v0/clients", req => tx(req, async (c, v) => {
    work(v);
    const clients = (await c.query(`select ${CLIENT},count(p.id)::int engagements,
      count(distinct coalesce(p.project_key,p.id::text))::int projects,min(p.start_month)::text "firstMonth",max(p.start_month)::text "lastMonth",
      coalesce(sum(d.n),0)::int deliveries,max(d.last) "lastDeliveredAt",
      (array_agg(distinct p.location) filter(where p.location is not null))[1:3] locations
      from pulse.client c left join pulse.person pc on pc.id=c.primary_contact_id
      left join pulse.project p on p.client_id=c.id left join ${DELIVERIES("$1")} d on d.project_id=p.id
      where not exists(select 1 from pulse.record_merge m where m.entity_type='client' and m.gone_id=c.id and m.undone_at is null) group by c.id,pc.id order by count(p.id) desc,c.display_name`,[visible(v)])).rows;
    const unassigned = (await c.query("select count(*)::int n from pulse.project where kind='client_work' and client_id is null")).rows[0].n;
    return { clients, unassigned, types: await recordTypes(c, "client"), canEdit: admin(v) && !!v.person };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/clients/:id", req => tx(req, async (c, v) => {
    work(v); mustId(req.params.id, "Client");
    const row = (await c.query(`select ${CLIENT},(select pe.display_name from pulse.record_change rc join pulse.person pe on pe.id=rc.changed_by where rc.entity_type='client' and rc.entity_id=c.id order by rc.changed_at desc limit 1) "editedBy",c.website,c.email,c.phone,c.notes,c.locked,c.created_at "createdAt",c.custom
      from pulse.client c left join pulse.person pc on pc.id=c.primary_contact_id where c.id=$1`, [req.params.id])).rows[0];
    if (!row) fail(404, "Client not found");
    const contacts = (await c.query(`select p.id,p.display_name name,cp.contact_type "contactType",cp.designation,cp.email,cp.phone,cc.is_primary "primary"
      from pulse.client_contact cc join pulse.person p on p.id=cc.person_id left join pulse.contact_profile cp on cp.person_id=p.id
      where cc.client_id=$1 order by cc.is_primary desc,p.display_name`, [row.id])).rows;
    const projects = (await c.query(`select ${PROJECT_COLS} from ${PROJECT_FROM("$2")} where p.client_id=$1
      order by p.start_month desc nulls last,p.registry_no desc`, [row.id,visible(v)])).rows;
    const latest = (await c.query(`select d.file_id "fileId",coalesce(f.display_name,f.name) "fileName",
      (select pe.display_name from pulse.delivery_actor oa join pulse.person pe on pe.id=oa.actor_id where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorName",
      (select oa.actor_account from pulse.delivery_actor oa where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorAccount",
      (select oa.basis from pulse.delivery_actor oa where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorBasis",
      (select pe.display_name from pulse.file_correction fc join pulse.person pe on pe.id=fc.edited_by where fc.org_id=d.org_id and fc.file_id=d.file_id) "editedBy",f.mime,p.id "projectId",coalesce(p.title,p.name) "projectName",
      d.uploader_account "uploaderAccount",d.kind "deliverableType",d.delivered_at "deliveredAt",d.rule_detail "ruleDetail",f.path,
      coalesce(a.is_shared,false) "sharedLogin",(a.holder_person_id is not null) "identityVerified"
      from pulse.delivery d join pulse.index_file f using(org_id,file_id) join pulse.project p on p.id=d.project_id
      left join pulse.account a on a.handle=d.uploader_account and a.provider='google'
      where p.client_id=$1 and pulse.delivery_matches(d.file_id,$2) order by d.delivered_at desc limit 8`, [row.id,visible(v)])).rows;
    const campaigns = (await c.query(`select g.id,g.name,g.platform,g.objective,coalesce(p.title,p.name) "projectName" from pulse.campaign g
      join pulse.project p on p.id=g.project_id where p.client_id=$1 order by g.name limit 50`, [row.id])).rows;
    const aliases = (await c.query(`select raw_value "raw",method,confidence::float from pulse.identity_link
      where entity_type='client' and entity_id=$1 order by confidence desc,source_key`, [row.id])).rows;
    const byYear = (await c.query(`select extract(year from p.start_month)::int "year",count(*)::int engagements,coalesce(sum(d.n),0)::int deliveries
      from pulse.project p left join ${DELIVERIES("$2")} d on d.project_id=p.id where p.client_id=$1 and p.start_month is not null group by 1 order by 1`, [row.id,visible(v)])).rows;
    return { ...row, contacts, projects, latest, campaigns, aliases, byYear, history: await history(c, "client", row.id), types: await recordTypes(c), canEdit: admin(v) && !!v.person };
  }));
  app.post<{ Body: Body }>("/api/v0/clients", { schema: { body } }, req => tx(req, async (c, v) => {
    canEditRecords(v);
    const name = clean("displayName", FIELDS.client.displayName, req.body.displayName)!;
    const type = clean("clientType", FIELDS.client.clientType, req.body.clientType ?? "other")!;
    const { id, customer_code: customerCode } = (await c.query(`insert into pulse.client(org_id,display_name,client_type,type_basis,source,locked)
      values ($1,$2,$3,'manual','manual','{display_name,client_type}') returning id,customer_code`, [v.org, name, type])).rows[0];
    await c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,new_value,changed_by) values ($1,'client',$2,'created',$3,$4)`, [v.org, id, name, v.person]);
    await edit(c, v, "client", id, Object.fromEntries(Object.entries(req.body).filter(([k]) => !["displayName", "clientType"].includes(k))));
    await saveCustom(c, v, "client", id, req.body);
    return { id, customerCode };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/clients/:id", { schema: { body } }, req => tx(req, async (c, v) => {
    mustId(req.params.id, "Client"); canEditRecords(v);
    const changed = await edit(c, v, "client", req.params.id, req.body);
    if ("clientType" in req.body) await c.query("update pulse.client set type_basis='manual' where id=$1", [req.params.id]);
    return { changed: changed + await saveCustom(c, v, "client", req.params.id, req.body) };
  }));

  // ----------------------------------------------------------------------------------------------------- types
  app.get("/api/v0/types", req => tx(req, async (c, v) => {
    const all = await recordTypes(c);
    return { contact: all.filter((t) => t.entity === "contact"), client: all.filter((t) => t.entity === "client"), canEdit: admin(v) && !!v.person };
  }));
  /** Add or change one contact or client type (organisation admins; the database decides and logs). */
  app.post<{ Body: Body }>("/api/v0/settings/types", { schema: { body } }, req => tx(req, async (c, v) => {
    canEditRecords(v);
    const entity = String(req.body.entity ?? "");
    if (!["contact", "client"].includes(entity)) fail(400, "Choose contact or client types");
    const data: Body = {};
    for (const k of ["label", "plural", "color", "hint"]) if (k in req.body) data[k] = String(req.body[k] ?? "").replace(/\s+/g, " ").trim().slice(0, k === "hint" ? 160 : 48);
    if ("sort" in req.body) data.sort = Math.max(0, Math.min(9999, Math.round(Number(req.body.sort) || 0)));
    if ("archived" in req.body) data.archived = req.body.archived === true;
    if ("fields" in req.body) {
      if (!Array.isArray(req.body.fields)) fail(400, "Fields are a list");
      data.fields = (req.body.fields as Body[]).slice(0, 12).map((f) => {
        const label = String(f.label ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
        const key = String(f.key ?? "").trim() || label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
        const type = String(f.type ?? "text");
        const options = type === "choice" ? [...new Set((Array.isArray(f.options) ? f.options : String(f.options ?? "").split(",")).map((o) => String(o).trim().slice(0, 40)).filter(Boolean))].slice(0, 20) : undefined;
        return { key: /^[a-z]/.test(key) ? key : `f_${key}`, label, type, ...(options ? { options } : {}) };
      });
    }
    try { return (await c.query("select pulse.record_type_save($1,$2,$3) t", [entity, String(req.body.key ?? ""), data])).rows[0].t; }
    catch (e) { const err = e as { code?: string; message?: string }; if (err.code === "22023") fail(400, err.message ?? "Check the type"); throw e; }
  }));

  // -------------------------------------------------------------------------------------------------- contacts
  app.get("/api/v0/contacts", req => tx(req, async (c, v) => {
    work(v);
    const contacts = (await c.query(`select p.id,p.display_name name,cp.contact_type "contactType",cp.designation,cp.city,cp.source,
      (select ph.updated_at from pulse.person_photo ph where ph.person_id=p.id) "photoAt",
      cl.id "clientId",cl.display_name "clientName",cl.company_name "companyName",
      (select count(*)::int from pulse.project pr where pr.client_id=cl.id) + (select count(*)::int from pulse.project_contact x where x.person_id=p.id)
        + (select count(distinct s.project_id)::int from pulse.talent_shoot s where s.person_id=p.id and s.project_id is not null
           and not exists(select 1 from pulse.project_contact x where x.person_id=p.id and x.project_id=s.project_id)) projects,
      (select max(pr.start_month)::text from pulse.project pr where pr.client_id=cl.id) "lastMonth"
      from pulse.contact_profile cp join pulse.person p on p.id=cp.person_id
      left join lateral (select c2.* from pulse.client_contact cc join pulse.client c2 on c2.id=cc.client_id where cc.person_id=p.id
        order by cc.is_primary desc limit 1) cl on true
      where p.status<>'offboarded' order by projects desc,p.display_name`)).rows;
    return { contacts, types: await recordTypes(c, "contact"), canEdit: admin(v) && !!v.person };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/contacts/:id", req => tx(req, async (c, v) => {
    work(v); mustId(req.params.id, "Contact");
    const row = (await c.query(`select p.id,p.display_name name,p.created_at "createdAt",cp.contact_type "contactType",cp.designation,cp.email,cp.phone,
      (select pe.display_name from pulse.record_change rc join pulse.person pe on pe.id=rc.changed_by where rc.entity_type='contact' and rc.entity_id=p.id order by rc.changed_at desc limit 1) "editedBy",cp.city,cp.notes,cp.source,cp.locked,cp.confidence::float confidence,cp.type_status "typeStatus",cp.custom,
      (select ph.updated_at from pulse.person_photo ph where ph.person_id=p.id) "photoAt",pulse.photo_can(p.id) "canPhoto"
      from pulse.contact_profile cp join pulse.person p on p.id=cp.person_id where p.id=$1`, [req.params.id])).rows[0];
    if (!row) fail(404, "Contact not found");
    const clients = (await c.query(`select c.id,c.display_name name,c.company_name "companyName",c.client_type "clientType",cc.is_primary "primary"
      from pulse.client_contact cc join pulse.client c on c.id=cc.client_id where cc.person_id=$1 order by c.display_name`, [row.id])).rows;
    // R55: a model's projects are also the ones the shoot sheets link them to.
    const projects = (await c.query(`select ${PROJECT_COLS},coalesce(x.role,case when exists(select 1 from pulse.talent_shoot s where s.person_id=$1 and s.project_id=p.id) then 'model' end) "contactRole" from ${PROJECT_FROM("$2")}
      left join pulse.project_contact x on x.project_id=p.id and x.person_id=$1
      where x.person_id is not null or p.client_id in (select client_id from pulse.client_contact where person_id=$1)
        or p.id in (select project_id from pulse.talent_shoot where person_id=$1 and project_id is not null)
      order by p.start_month desc nulls last,p.registry_no desc`, [row.id,visible(v)])).rows;
    const campaigns = (await c.query(`select g.id,g.name,g.platform,coalesce(p.title,p.name) "projectName" from pulse.campaign g join pulse.project p on p.id=g.project_id
      where p.client_id in (select client_id from pulse.client_contact where person_id=$1) order by g.name limit 50`, [row.id])).rows;
    return { ...row, clients, projects, campaigns, history: await history(c, "contact", row.id), types: await recordTypes(c), canEdit: admin(v) && !!v.person };
  }));
  // PEOPLE-CONTACTS part 5: the rest of a contact's profile, one part per tab (?part=), each read only when its tab
  // opens. Projects are the contact's own and their clients'; deliveries and files follow what the viewer may see.
  const contactProjects = async (c: PoolClient, id: string) => (await c.query(`select p.id from pulse.project p
    where p.id in (select project_id from pulse.project_contact where person_id=$1) or p.client_id in (select client_id from pulse.client_contact where person_id=$1)
      or p.id in (select project_id from pulse.talent_shoot where person_id=$1 and project_id is not null)`, [id])).rows.map((r) => r.id as string);
  app.get<{ Params: { id: string }; Querystring: { part?: string } }>("/api/v0/contacts/:id/more", req => tx(req, async (c, v) => {
    work(v); mustId(req.params.id, "Contact");
    const row = (await c.query("select p.id,p.display_name name,cp.email from pulse.contact_profile cp join pulse.person p on p.id=cp.person_id where p.id=$1", [req.params.id])).rows[0];
    if (!row) fail(404, "Contact not found");
    const part = String(req.query.part ?? "");
    const projects = await contactProjects(c, row.id);
    if (part === "deliveries") return { deliveries: (await c.query(`select d.file_id "fileId",coalesce(f.display_name,f.name) "fileName",f.mime,p.id "projectId",coalesce(p.title,p.name) "projectName",
        d.uploader_account "uploaderAccount",d.kind "deliverableType",d.delivered_at "deliveredAt",d.rule_detail "ruleDetail",f.path,coalesce(a.is_shared,false) "sharedLogin",(a.holder_person_id is not null) "identityVerified",
        (select pe.display_name from pulse.delivery_actor oa join pulse.person pe on pe.id=oa.actor_id where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorName"
        from pulse.delivery d join pulse.index_file f using(org_id,file_id) join pulse.project p on p.id=d.project_id left join pulse.account a on a.handle=d.uploader_account and a.provider='google'
        where d.project_id=any($1::uuid[]) and pulse.delivery_matches(d.file_id,$2) order by d.delivered_at desc limit 60`, [projects, visible(v)])).rows,
      byMonth: (await c.query(`select to_char(date_trunc('month',d.delivered_at at time zone ${ORG_TZ}),'YYYY-MM') "month",count(*)::int n from pulse.delivery d
        where d.project_id=any($1::uuid[]) and pulse.delivery_matches(d.file_id,$2) and d.delivered_at>=now()-interval '12 months' group by 1 order by 1`, [projects, visible(v)])).rows };
    if (part === "files") {
      // Their projects' documents (not the delivered videos), and any Drive file that names them in full.
      const named = row.name.replace(/^(mr|mrs|ms|dr)\.?\s+/i, "").trim();
      return { files: (await c.query(`select f.file_id "fileId",coalesce(f.display_name,f.name) name,f.mime,f.path,f.modified_at "modifiedAt",p.id "projectId",coalesce(p.title,p.name) "projectName",
          ($2::text<>'' and f.name ilike '%'||$2||'%') "namesThem"
        from pulse.index_file f left join pulse.project p on p.id=f.project_id
        where f.mime not like 'video/%' and f.mime not like 'image/%' and f.mime<>'application/vnd.google-apps.folder' and f.name !~* '\\.(mp4|mov|mkv|avi|jpe?g|png|heic|webp)$'
          and (f.project_id=any($1::uuid[]) or ($2::text<>'' and position(' ' in $2)>0 and f.name ilike '%'||$2||'%'))
        order by f.modified_at desc nulls last limit 50`, [projects, named.length >= 6 ? named : ""])).rows };
    }
    if (part === "chats") {
      // Team chats the viewer is in that mention the contact by name (row security: only the viewer's own channels).
      const name = row.name.replace(/^(mr|mrs|ms|dr)\.?\s+/i, "").trim();
      return { messages: name.length < 4 ? [] : (await c.query(`select m.id,m.channel_id "channelId",ch.name channel,ch.kind,left(m.body,240) body,m.created_at "at",a.display_name author
        from pulse.chat_message m join pulse.chat_channel ch on ch.id=m.channel_id left join pulse.person a on a.id=m.author_id
        where m.removed_at is null and m.body ilike '%'||$1||'%' order by m.created_at desc limit 30`, [name])).rows, query: name, email: row.email };
    }
    if (part === "money") return { money: (await c.query("select pulse.contact_money($1) m", [row.id])).rows[0].m };
    if (part === "suggestions") return { suggestions: (await c.query("select pulse.contact_link_suggestions($1) s", [row.id])).rows[0].s, canLink: admin(v) && !!v.person };
    if (part === "timeline") {
      const notes = (await c.query(`select n.id,n.body,n.created_at "at",a.display_name author,n.author_id "authorId" from pulse.contact_note n left join pulse.person a on a.id=n.author_id
        where n.person_id=$1 order by n.created_at desc limit 100`, [row.id])).rows;
      const events = (await c.query(`select * from (
          select 'project' kind,coalesce(p.title,p.name) title,p.start_month::timestamptz "at",p.id "ref" from pulse.project p where p.id=any($1::uuid[]) and p.start_month is not null
          union all select 'delivery',count(*)||' deliver'||case when count(*)=1 then 'y' else 'ies' end||' · '||min(coalesce(p.title,p.name)),max(d.delivered_at),min(p.id::text)::uuid
            from pulse.delivery d join pulse.project p on p.id=d.project_id where d.project_id=any($1::uuid[]) and pulse.delivery_matches(d.file_id,$3)
            group by date_trunc('week',d.delivered_at at time zone ${ORG_TZ}),d.project_id
          union all select 'change',case when h.field='created' then 'Added to Pulse' else h.field||': '||coalesce(h.new_value,'removed') end,h.changed_at,null from pulse.record_change h where h.entity_type='contact' and h.entity_id=$2
        ) t order by "at" desc limit 120`, [projects, row.id, visible(v)])).rows;
      return { notes, events, viewer: v.person, canRemoveAny: admin(v) };
    }
    fail(400, "Choose a part of the profile");
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/contacts/:id/notes", { schema: { body } }, req => tx(req, async (c, v) => {
    work(v); mustId(req.params.id, "Contact");
    const text = String(req.body.body ?? "").trim();
    if (!text || text.length > 2000) fail(400, "A note is 1 to 2000 characters");
    try { return { id: (await c.query("select pulse.contact_note_add($1,$2) id", [req.params.id, text])).rows[0].id }; }
    catch (e) { const err = e as { code?: string; message?: string }; if (err.code === "22023") fail(400, err.message ?? "Check the note"); throw e; }
  }));
  app.post<{ Params: { id: string } }>("/api/v0/contacts/notes/:id/remove", req => tx(req, async (c, v) => {
    work(v); mustId(req.params.id, "Note");
    try { await c.query("select pulse.contact_note_remove($1)", [req.params.id]); return { ok: true }; }
    catch (e) { const err = e as { code?: string; message?: string }; if (err.code === "42501") fail(403, err.message ?? "Not allowed"); throw e; }
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/contacts/:id/links", { schema: { body } }, req => tx(req, async (c, v) => {
    mustId(req.params.id, "Contact"); canEditRecords(v);
    const kind = String(req.body.kind ?? ""), target = String(req.body.targetId ?? "");
    if (!["project", "client"].includes(kind) || !UUID.test(target)) fail(400, "Link a project or a client");
    try { await c.query("select pulse.contact_link($1,$2,$3)", [req.params.id, kind, target]); return { ok: true }; }
    catch (e) { const err = e as { code?: string; message?: string }; if (err.code === "22023") fail(400, err.message ?? "Check the link"); throw e; }
  }));
  const SIDE: Record<string, string> = { developer: "client", channel_partner: "channel_partner", talent: "talent", other: "other" };
  app.post<{ Body: Body }>("/api/v0/contacts", { schema: { body } }, req => tx(req, async (c, v) => {
    canEditRecords(v);
    const name = clean("name", FIELDS.contact.name, req.body.name)!, type = clean("contactType", FIELDS.contact.contactType, req.body.contactType);
    const clientId = req.body.clientId ? String(req.body.clientId) : null;
    if (clientId && !(UUID.test(clientId) && (await c.query("select 1 from pulse.client where id=$1", [clientId])).rows[0])) fail(400, "Unknown client");
    const id = (await c.query("insert into pulse.person(org_id,display_name,side) values ($1,$2,$3) returning id", [v.org, name, SIDE[type ?? "other"] ?? "other"])).rows[0].id;
    await c.query(`insert into pulse.contact_profile(org_id,person_id,contact_type,source,locked) values ($1,$2,$3,'manual','{name,contact_type}')`, [v.org, id, type]);
    if (clientId) await c.query(`insert into pulse.client_contact(org_id,client_id,person_id,is_primary)
      values ($1,$2,$3,not exists(select 1 from pulse.client_contact where client_id=$2 and is_primary))`, [v.org, clientId, id]);
    await c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,new_value,changed_by) values ($1,'contact',$2,'created',$3,$4)`, [v.org, id, name, v.person]);
    await edit(c, v, "contact", id, Object.fromEntries(Object.entries(req.body).filter(([k]) => !["name", "contactType", "clientId"].includes(k))));
    await saveCustom(c, v, "contact", id, req.body);
    return { id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/contacts/:id", { schema: { body } }, req => tx(req, async (c, v) => {
    mustId(req.params.id, "Contact"); canEditRecords(v);
    if (!(await c.query("select 1 from pulse.contact_profile where person_id=$1", [req.params.id])).rows[0]) fail(404, "Contact not found");
    const changed = await edit(c, v, "contact", req.params.id, req.body);
    if (typeof req.body.contactType === "string" && req.body.contactType) await c.query("update pulse.person set side=$1 where id=$2", [SIDE[req.body.contactType] ?? "other", req.params.id]);
    return { changed: changed + await saveCustom(c, v, "contact", req.params.id, req.body) };
  }));

  // -------------------------------------------------------------------------------------------------- projects
  app.get("/api/v0/projects", req => tx(req, async (c, v) => {
    work(v); const p = await period(c, req); const account = visible(v);
    // Everyone can find any project (to open it, correct it or upload to it); delivery counts and stages stay scoped to the viewer.
    const all = !!account && (req.query as { scope?: string }).scope === "all";
    const projects = (await c.query(`select ${PROJECT_COLS},coalesce(w.n,0) count,($1::text is null or d.n > 0 or $1 like 'team:%' and p.id = any(pulse.work_projects())) mine,
      coalesce(d.last < now() - interval '14 days' and d.last >= now() - interval '56 days',false) quiet,
      coalesce(k.videos,0) videos,coalesce(k.images,0) images,coalesce(k.latest,'[]') latest
      from ${PROJECT_FROM("$1")}
      left join (select project_id,count(*)::int n from pulse.delivery where delivered_at >= $2 and delivered_at < $3
        and pulse.delivery_matches(file_id,$1) group by 1) w on w.project_id=p.id
      left join lateral (select count(*) filter(where f.mime like 'video/%')::int videos,count(*) filter(where f.mime like 'image/%')::int images,
          (select jsonb_agg(jsonb_build_object('fileId',x.file_id,'fileName',x.name,'mime',x.mime,'kind',x.kind) order by x.delivered_at desc)
             from (select dd.file_id,coalesce(ff.display_name,ff.name) name,ff.mime,dd.kind,dd.delivered_at from pulse.delivery dd join pulse.index_file ff using(org_id,file_id)
                    where dd.project_id=p.id and pulse.delivery_matches(dd.file_id,$1) order by dd.delivered_at desc limit 4) x) latest
        from pulse.delivery dl join pulse.index_file f using(org_id,file_id)
        where dl.project_id=p.id and pulse.delivery_matches(dl.file_id,$1)) k on d.n > 0
      where ($1::text is null or $4::boolean or d.n > 0 or $1 like 'team:%' and p.id = any(pulse.work_projects())) and not exists(select 1 from pulse.record_merge r where r.entity_type='project' and r.gone_id=p.id and r.undone_at is null)
      order by coalesce(w.n,0) desc,d.last desc nulls last,p.start_month desc nulls last,p.registry_no desc`, [account, p.start, p.end, all])).rows;
    return { period: publicPeriod(p as never), scope: leadership(v) ? "All work" : all ? "All projects" : manager(v) ? "Your pod" : "Your qualified work", projects, canEdit: admin(v) && !!v.person };
  }));
  app.get<{ Params: { id: string } }>("/api/v0/projects/:id", req => tx(req, async (c, v) => {
    work(v); mustId(req.params.id, "Project");
    const p = await period(c, req); const account = visible(v);
    const row = (await c.query(`select ${PROJECT_COLS},(select pe.display_name from pulse.record_change rc join pulse.person pe on pe.id=rc.changed_by where rc.entity_type='project' and rc.entity_id=p.id order by rc.changed_at desc limit 1) "editedBy",p.storage_root "storageRoot",p.locked,p.lead_person_id "pgsId",(select pe.display_name from pulse.person pe where pe.id=p.lead_person_id) "pgsName",d.first "firstDeliveredAt"
      from ${PROJECT_FROM("$2")} where p.id=$1`, [req.params.id, account])).rows[0];
    // A project outside the viewer's own work still opens (to correct it or upload to it); its counts below stay scoped.
    if (!row) fail(404, "Project not found");
    const counts = (await c.query(`select count(*) filter(where d.kind='draft')::int drafts,count(*) filter(where d.kind='final')::int finals,
      count(*) filter(where d.delivered_at >= $1 and d.delivered_at < $2)::int count,
      count(*) filter(where d.delivered_at >= $4 and d.delivered_at < $5)::int prev
      from pulse.delivery d where d.project_id=$6 and pulse.delivery_matches(d.file_id,$3)`, [p.start, p.end, account, p.prevStart, p.prevEnd, row.projectId])).rows[0];
    const files = (await c.query(`select count(*)::int files,max(modified_at) "lastFileAt" from pulse.index_file where project_id=$1`, [row.projectId])).rows[0];
    const anchorDay = p.from > p.today ? p.today : p.to < p.today ? p.to : p.today;
    const trend = (await c.query(`select to_char(w,'IYYY-"W"IW') week,w::date::text "start",count(d.file_id)::int deliveries
      from generate_series(date_trunc('week',$1::date::timestamp) - interval '77 days',date_trunc('week',$1::date::timestamp),interval '7 days') w
      left join pulse.delivery d on d.project_id=$2 and d.delivered_at >= (w at time zone ${ORG_TZ})
        and d.delivered_at < ((w + interval '7 days') at time zone ${ORG_TZ}) and pulse.delivery_matches(d.file_id,$3)
      group by w order by w`, [anchorDay, row.projectId, account])).rows;
    const select = `select d.file_id "fileId",coalesce(f.display_name,f.name) "fileName",
      (select pe.display_name from pulse.delivery_actor oa join pulse.person pe on pe.id=oa.actor_id where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorName",
      (select oa.actor_account from pulse.delivery_actor oa where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorAccount",
      (select oa.basis from pulse.delivery_actor oa where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorBasis",
      (select pe.display_name from pulse.file_correction fc join pulse.person pe on pe.id=fc.edited_by where fc.org_id=d.org_id and fc.file_id=d.file_id) "editedBy",f.mime,d.uploader_account "uploaderAccount",d.kind "deliverableType",
      d.delivered_at "deliveredAt",d.rule_detail "ruleDetail",f.path,coalesce(a.is_shared,false) "sharedLogin",
      (a.holder_person_id is not null) "identityVerified" from pulse.delivery d join pulse.index_file f using(org_id,file_id)
      left join pulse.account a on a.handle=d.uploader_account and a.provider='google' where d.project_id=$1 and pulse.delivery_matches(d.file_id,$2)`;
    const inPeriod = (await c.query(`${select} and d.delivered_at >= $3 and d.delivered_at < $4 order by d.delivered_at desc,d.file_id limit 100`,
      [row.projectId, account, p.start, p.end])).rows;
    const latest = (await c.query(`${select} order by d.delivered_at desc,d.file_id limit 24`, [row.projectId, account])).rows;
    const related = row.projectKey ? (await c.query(`select ${PROJECT_COLS} from ${PROJECT_FROM("$3")}
      where p.project_key=$1 and pulse.work_project(p.id) and p.id<>$2 order by p.start_month desc nulls last`, [row.projectKey, row.projectId,account])).rows : [];
    const people = (await c.query(`select pe.id,pe.display_name name,x.role from pulse.project_contact x join pulse.person pe on pe.id=x.person_id
      where x.project_id=$1 order by pe.display_name`, [row.projectId])).rows;
    const clients = admin(v) ? (await c.query("select id,display_name name from pulse.client order by display_name")).rows : [];
    const staff = admin(v) ? (await c.query("select id,display_name name from pulse.person where side='staff' and status='active' order by display_name")).rows : [];
    return { ...row, ...counts, ...files, period: publicPeriod(p as never), trend, deliveries: inPeriod, latest, related, people, clients, staff,
      history: await history(c, "project", row.projectId), canEdit: admin(v) && !!v.person };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/projects/:id", { schema: { body } }, req => tx(req, async (c, v) => {
    mustId(req.params.id, "Project"); canEditRecords(v);
    if(req.body.pgsId && !(await c.query("select 1 from pulse.person where id=$1 and side='staff' and status='active'",[clean('pgsId',FIELDS.project.pgsId,req.body.pgsId)])).rows[0]) fail(400,'Choose an active member of staff as PGS');
    const changed = await edit(c, v, "project", req.params.id, req.body);
    if ("pod" in req.body) {
      const pod = req.body.pod ? String(req.body.pod) : null;
      const unit = pod ? (await c.query("select id from pulse.unit where kind='pod' and name=$1", [pod])).rows[0]?.id : null;
      if (pod && !unit) fail(400, "Unknown pod");
      const before = (await c.query("select u.name from pulse.project p left join pulse.unit u on u.id=p.unit_id where p.id=$1", [req.params.id])).rows[0]?.name ?? null;
      if (before !== pod) {
        await c.query("update pulse.project set unit_id=$1,locked=array(select distinct unnest(locked||'unit_id'::text)),updated_at=now() where id=$2", [unit, req.params.id]);
        await c.query(`insert into pulse.record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values ($1,'project',$2,'pod',$3,$4,$5)`,
          [v.org, req.params.id, before, pod, v.person]);
      }
    }
    return { changed };
  }));
}
