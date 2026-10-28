// R46: the relationship graph (0330). RE projects and their engagement records, developers, channel partners and
// clients, employees and contacts, joined by typed relationships that carry their source, dates and status. Imported
// links are proposals; a reviewer an admin named for that kind confirms, rejects or corrects them (the database decides
// who, against the version they saw). Model links stay out of every view until the owner's definition is recorded.
// Everyone who works on projects reads the graph and may suggest an addition or correction; HR-only accounts may not.
// No contact detail (e-mail, phone) is read here.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { admin, fail, work, type Tx, type Viewer } from "./routes.js";
import { effective, groupEdges, KIND_LABEL, KINDS, type EdgeRow, type Kind } from "./relationships-model.js";

type Deps = { tx: Tx };
type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (x: unknown, what = "record") => typeof x === "string" && UUID.test(x) ? x : fail(400, `Choose a valid ${what}`);
const str = (x: unknown, max = 200) => typeof x === "string" ? x.trim().slice(0, max) : "";
const kindOf = (x: unknown): Kind => KINDS.includes(x as Kind) ? x as Kind : fail(400, "Choose a kind of relationship");
const body = { type: "object" } as const;
const LIMIT = 300;

/** The other side a person chose, as the database functions take it: a record id or an RE project key. */
function pick(b: Body) {
  const p: Record<string, string> = {};
  if (typeof b.id === "string" && b.id) p.id = id(b.id);
  if (typeof b.key === "string" && b.key.trim()) p.key = str(b.key, 300);
  if (typeof b.role === "string" && b.role.trim()) p.role = str(b.role, 80);
  for (const k of ["validFrom", "validTo"]) if (k in b) p[k] = b[k] === null || b[k] === "" ? "" : /^\d{4}-\d{2}-\d{2}$/.test(String(b[k])) ? String(b[k]) : fail(400, "Choose a valid date");
  return p;
}

const modelOn = async (c: PoolClient) => (await c.query("select pulse.relation_model_on() v")).rows[0].v as boolean;
const myKinds = async (c: PoolClient) => (await c.query("select pulse.relation_my_kinds() k")).rows[0].k as Kind[];

// Every current relationship with the version that stands (a correction waiting keeps the confirmed one standing),
// both ends named from their records, its development and whether reviewers disagreed. Row security applies.
const HEADS = `
 select h.thread,h.id,h.version,h.kind,h.role,h.status,h.action,h.actor,h.note,h.created_at "at",h.standing,
   h.subject_type "subjectType",h.subject_id "subjectId",h.object_type "objectType",h.object_id "objectId",h.object_key "objectKey",h.object_label "objectLabel",
   to_char(h.valid_from,'YYYY-MM-DD') "validFrom",to_char(h.valid_to,'YYYY-MM-DD') "validTo",
   h.source_family "sourceFamily",h.evidence,h.confidence::float confidence,h.observed_at "observedAt",
   a.display_name "actorName",
   s.id "sId",s.status "sStatus",s.role "sRole",s.object_type "sObjectType",s.object_id "sObjectId",s.object_key "sObjectKey",s.object_label "sObjectLabel",
   to_char(s.valid_from,'YYYY-MM-DD') "sValidFrom",to_char(s.valid_to,'YYYY-MM-DD') "sValidTo",s.actor "sActor",sa.display_name "sActorName",s.created_at "sAt",s.note "sNote",
   s.source_family "sSourceFamily",s.evidence "sEvidence",
   coalesce(pr.title,pr.name,cl.display_name) "subjectLabel",pr.registry_no "registryNo",pr.project_key "projectKey",
   coalesce(o.display_name,op.display_name) "objectName",o.client_type "objectClientType",
   (select count(distinct (d.status,d.object_id,d.object_key))>1 and count(distinct d.actor)>1 from pulse.relation_edge d
     where d.thread=h.thread and d.undone_at is null and d.action in ('confirm','reject','correct')) disputed,
   case when h.object_type='client' then (select count(*)::int from pulse.client x where x.id<>h.object_id and lower(x.display_name)=lower(o.display_name))
        when h.object_id is not null then (select count(*)::int from pulse.person x where x.id<>h.object_id and lower(x.display_name)=lower(op.display_name))
        else (select count(*)::int from pulse.person x where x.side='staff' and h.object_type='employee' and lower(x.display_name)=lower(h.object_label)) end "sameName"
 from pulse.relation_head h
 left join pulse.relation_edge s on s.id=h.standing
 left join pulse.person a on a.id=h.actor left join pulse.person sa on sa.id=s.actor
 left join pulse.project pr on h.subject_type='engagement' and pr.id=h.subject_id
 left join pulse.client cl on h.subject_type='client' and cl.id=h.subject_id
 left join pulse.client o on h.object_type='client' and o.id=h.object_id
 left join pulse.person op on h.object_type in ('employee','contact','model') and op.id=h.object_id`;

const HIDE_MODELS = `h.kind<>'model' and h.object_type<>'model' and coalesce(s.object_type,'')<>'model'`;

async function summary(c: PoolClient, models: boolean) {
  const counts = (await c.query(`select h.kind,
      case when h.status in ('proposed','withdrawn') and s.id is not null then 'confirmed' else h.status end eff,
      (h.status='proposed' and s.id is not null) corr,(h.object_id is null and h.object_key is null) unresolved,
      (${HIDE_MODELS}) shown,count(*)::int n
    from pulse.relation_head h left join pulse.relation_edge s on s.id=h.standing group by 1,2,3,4,5`)).rows as { kind: Kind; eff: string; corr: boolean; unresolved: boolean; shown: boolean; n: number }[];
  const visible = counts.filter((r) => models || r.shown);
  const sum = (f: (r: typeof counts[number]) => boolean) => visible.filter(f).reduce((n, r) => n + r.n, 0);
  const byKind = KINDS.filter((k) => models || k !== "model").map((k) => ({ kind: k, label: KIND_LABEL[k],
    confirmed: sum((r) => r.kind === k && r.eff === "confirmed"), proposed: sum((r) => r.kind === k && r.eff === "proposed"),
    rejected: sum((r) => r.kind === k && r.eff === "rejected"), corrections: sum((r) => r.kind === k && r.corr) }));
  const dev = (await c.query(`with e as (select project_key from pulse.project where kind='client_work' and status<>'cancelled'),
      k as (select project_key,count(*) n from e where project_key is not null group by 1)
    select (select count(*)::int from e) engagements,(select count(*)::int from e where project_key is not null) keyed,(select count(*)::int from k) developments,
      (select count(*)::int from k where n>1) shared,(select coalesce(sum(n),0)::int from k where n>1) "inShared"`)).rows[0];
  return {
    counts: { confirmed: sum((r) => r.eff === "confirmed"), proposed: sum((r) => r.eff === "proposed"), rejected: sum((r) => r.eff === "rejected"),
      withdrawn: sum((r) => r.eff === "withdrawn"), unresolved: sum((r) => r.eff === "proposed" && r.unresolved), corrections: sum((r) => r.corr) },
    byKind, developments: dev, hiddenModels: models ? 0 : counts.filter((r) => !r.shown).reduce((n, r) => n + r.n, 0),
  };
}

export function registerRelationshipRoutes(app: FastifyInstance, { tx }: Deps) {
  app.get<{ Querystring: Record<string, string | undefined> }>("/api/v0/relationships", (req) => tx(req, async (c, v: Viewer) => {
    work(v);
    const q = req.query, models = await modelOn(c), kinds = await myKinds(c);
    const where: string[] = [], params: unknown[] = [];
    const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replaceAll("$?", `$${params.length}`)); };
    if (!models) where.push(HIDE_MODELS);
    const view = q.view === "review" ? "review" : "graph";
    if (view === "review") { where.push("h.status='proposed'"); if (kinds.length) add("h.kind=any($?::text[])", kinds); }
    if (q.kind) add("h.kind=$?", kindOf(q.kind));
    const status = q.status ?? "";
    if (status === "confirmed") where.push("(h.status='confirmed' or s.id is not null and h.status in ('proposed','withdrawn'))");
    else if (status === "proposed") where.push("h.status='proposed'");
    else if (status === "rejected") where.push("h.status='rejected'");
    else if (status === "withdrawn") where.push("h.status='withdrawn' and s.id is null");
    else if (status === "unresolved") where.push("h.status='proposed' and h.object_id is null and h.object_key is null");
    else if (status === "corrections") where.push("h.status='proposed' and s.id is not null");
    else if (view === "graph") where.push("not (h.status='withdrawn' and s.id is null)");
    if (q.subject) add("h.subject_id=$?", id(q.subject));
    if (q.dev) add("(h.object_key=$? or pr.project_key=$?)", str(q.dev, 300));
    if (q.q && q.q.trim()) add("(coalesce(pr.title,pr.name,cl.display_name) ilike $? or h.object_label ilike $? or coalesce(s.object_label,'') ilike $?)",
      `%${str(q.q, 80).replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
    const rows = (await c.query(`${HEADS} where ${where.length ? where.join(" and ") : "true"}
      order by coalesce(pr.project_key,cl.display_name,pr.title,pr.name),h.subject_id,array_position(array['development','client','team','model','account_owner','contact'],h.kind),h.created_at
      limit ${LIMIT + 1}`, params)).rows as EdgeRow[];
    const edges = rows.slice(0, LIMIT).map((r) => effective(r, { kinds, me: v.person, admin: admin(v) }));
    const last = (await c.query(`select at,counts from pulse.relation_run order by at desc limit 1`)).rows[0] ?? null;
    return { view, ...(await summary(c, models)), groups: groupEdges(edges), shown: edges.length, more: rows.length > LIMIT,
      me: { reviewer: kinds.length > 0, kinds, admin: admin(v) }, models: { defined: models }, lastRun: last };
  }));

  app.get<{ Params: { id: string } }>("/api/v0/relationships/history/:id", (req) => tx(req, async (c, v) => {
    work(v);
    const models = await modelOn(c);
    const versions = (await c.query(`select e.id,e.version,e.status,e.action,e.role,e.object_type "objectType",e.object_id "objectId",e.object_key "objectKey",e.object_label "objectLabel",
        to_char(e.valid_from,'YYYY-MM-DD') "validFrom",to_char(e.valid_to,'YYYY-MM-DD') "validTo",e.source_family "sourceFamily",e.evidence,e.confidence::float confidence,
        e.note,e.created_at "at",a.display_name "by",e.undone_at "undoneAt",u.display_name "undoneBy",e.standing,e.kind
      from pulse.relation_edge e left join pulse.person a on a.id=e.actor left join pulse.person u on u.id=e.undone_by
      where e.thread=$1 order by e.version`, [id(req.params.id)])).rows;
    if (!versions.length || (!models && versions.some((x) => x.kind === "model" || x.objectType === "model"))) fail(404, "Relationship not found");
    return { thread: req.params.id, versions };
  }));

  // Records a person may choose for the other side: never a guess, always an explicit pick (same names listed apart).
  app.get<{ Querystring: Record<string, string | undefined> }>("/api/v0/relationships/options", (req) => tx(req, async (c, v) => {
    work(v);
    const kind = kindOf(req.query.kind), q = `%${str(req.query.q, 80).replace(/[%_\\]/g, (m) => `\\${m}`)}%`, models = await modelOn(c);
    if (kind === "development") return { options: (await c.query(`select project_key "key",left(mode() within group (order by coalesce(nullif(btrim(title),''),name))
        || coalesce(' · '||initcap(nullif(split_part(project_key,'@',2),'')),''),300) label,count(*)::int || case when count(*)=1 then ' engagement record' else ' engagement records' end sub
      from pulse.project where kind='client_work' and status<>'cancelled' and project_key is not null and (project_key ilike $1 or coalesce(title,name) ilike $1)
      group by project_key order by 2 limit 20`, [q])).rows };
    if (kind === "client") return { options: (await c.query(`select c.id,c.display_name label,
        concat_ws(' · ',case c.client_type when 'developer' then 'Developer' when 'channel_partner' then 'Channel partner' else 'Client' end,
          (select count(*)::int || ' engagements' from pulse.project p where p.client_id=c.id),'#'||left(c.id::text,4)) sub
      from pulse.client c where c.display_name ilike $1 and coalesce(c.status,'active')<>'churned' order by c.display_name,c.id limit 20`, [q])).rows };
    if (kind === "team" || kind === "account_owner") return { options: (await c.query(`select p.id,p.display_name label,concat_ws(' · ',pp.role,pp.pod) sub
      from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.side='staff' and p.status='active' and p.display_name ilike $1
      order by p.display_name limit 20`, [q])).rows };
    if (kind === "model" && !models) return { options: [] };
    return { options: (await c.query(`select p.id,p.display_name label,concat_ws(' · ',case cp.contact_type when 'developer' then 'Developer' when 'channel_partner' then 'Channel partner'
        when 'talent' then 'Model' when 'vendor' then 'Vendor' else 'Contact' end,'#'||left(p.id::text,4)) sub
      from pulse.person p left join pulse.contact_profile cp on cp.person_id=p.id
      where p.side<>'staff' and p.status<>'offboarded' and p.display_name ilike $1 and ($2::boolean or cp.contact_type is distinct from 'talent') and ($3::boolean is false or cp.contact_type='talent')
      order by p.display_name,p.id limit 20`, [q, models, kind === "model"])).rows };
  }));

  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/relationships/history/:id/decide", { schema: { body } }, (req) => tx(req, async (c, v) => {
    work(v);
    const action = ["confirm", "reject", "correct"].includes(String(req.body.action)) ? String(req.body.action) : fail(400, "Choose confirm, reject or correct");
    const r = await c.query("select pulse.relation_decide($1,$2,$3,$4,$5) id", [id(req.params.id), id(req.body.expected, "version"), action, pick(req.body), str(req.body.note, 500) || null]);
    return { id: r.rows[0].id };
  }));

  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/relationships/history/:id/undo", { schema: { body } }, (req) => tx(req, async (c, v) => {
    work(v);
    await c.query("select pulse.relation_undo($1,$2)", [id(req.params.id), id(req.body.expected, "version")]);
    return { ok: true };
  }));

  app.post<{ Body: Body }>("/api/v0/relationships/suggest", { schema: { body } }, (req) => tx(req, async (c, v) => {
    work(v);
    const kind = kindOf(req.body.kind), p = pick(req.body);
    if (!p.id && !p.key) fail(400, "Choose the record from the list");
    const r = await c.query("select pulse.relation_suggest($1,$2,$3,$4) id", [kind, id(req.body.subject), p, str(req.body.note, 500) || null]);
    return { id: r.rows[0].id };
  }));

  // Admins: who reviews which kinds (owner errand E14), the owner's definition of models, and reading the sources.
  app.get("/api/v0/relationships/setup", (req) => tx(req, async (c, v) => {
    if (!admin(v)) fail(403, "Only admins set up relationship reviews");
    const reviewers = (await c.query(`select r.person_id "personId",p.display_name name,r.kinds,r.note,g.display_name "grantedBy",r.granted_at "grantedAt",
        (select count(*)::int from pulse.relation_head h where h.status='proposed' and h.kind=any(r.kinds)) waiting
      from pulse.relation_reviewer r join pulse.person p on p.id=r.person_id left join pulse.person g on g.id=r.granted_by where r.revoked_at is null order by p.display_name`)).rows;
    const staff = (await c.query(`select p.id,p.display_name name,pp.pod from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id
      where p.side='staff' and p.status='active' order by p.display_name`)).rows;
    const model = (await c.query(`select t.definition,t.source_ref "source",p.display_name "by",t.configured_at "at" from pulse.relation_node_type t left join pulse.person p on p.id=t.configured_by
      where t.node_type='model' and t.withdrawn_at is null`)).rows[0] ?? null;
    const hidden = (await c.query(`select count(*)::int n from pulse.relation_head h where h.kind='model' or h.object_type='model'`)).rows[0].n;
    const runs = (await c.query(`select r.at,r.counts,p.display_name "by" from pulse.relation_run r left join pulse.person p on p.id=r.by order by r.at desc limit 5`)).rows;
    return { reviewers, staff, model, hiddenModels: hidden, runs, kinds: KINDS.map((k) => ({ kind: k, label: KIND_LABEL[k] })) };
  }));

  app.post<{ Body: Body }>("/api/v0/relationships/reviewers", { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!admin(v)) fail(403, "Only admins name relationship reviewers");
    const kinds = Array.isArray(req.body.kinds) ? [...new Set(req.body.kinds.map(kindOf))] : fail(400, "Choose the kinds this person reviews");
    await c.query("select pulse.relation_reviewer_set($1,$2,$3)", [id(req.body.personId, "colleague"), kinds, str(req.body.note, 300) || null]);
    return { ok: true };
  }));

  app.post<{ Body: Body }>("/api/v0/relationships/models", { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!admin(v)) fail(403, "Only admins record the owner's definition");
    await c.query("select pulse.relation_node_type_set('model',$1,$2)", [str(req.body.definition, 1000) || null, str(req.body.source, 300) || null]);
    return { ok: true };
  }));

  app.post("/api/v0/relationships/refresh", { schema: { body } }, (req) => tx(req, async (c, v) => {
    if (!admin(v)) fail(403, "Only admins read the sources again");
    return (await c.query("select pulse.relation_refresh() r")).rows[0].r as Record<string, number>;
  }));
}
