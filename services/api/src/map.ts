// Pulse Map: every development as a point, with how precisely Pulse knows where it is and where that came from.
// A location is one real development; its engagements are the project folders linked to it. Pins are corrected in
// the app by an organisation admin and every move is written to pulse.project_location_change.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { admin, fail, work, type Tx, type Viewer } from "./routes.js";

type Deps = { tx: Tx };
type Body = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Same reading of Drive as the Projects page: a recorded status wins, otherwise the last delivery decides.
const STAGE = `case when p.status in ('paused','done','cancelled') then p.status
  when d.last >= now() - interval '14 days' then 'delivering'
  when d.last >= now() - interval '56 days' then 'quiet'
  when d.last is null and p.start_month >= (now() - interval '60 days')::date then 'new'
  else 'dormant' end`;
const DELIVERIES = `(select project_id,count(*)::int n,max(delivered_at) last from pulse.delivery group by 1)`;
const ENGAGEMENT = `jsonb_build_object('projectId',p.id,'title',coalesce(p.title,p.name),'month',to_char(p.start_month,'YYYY-MM'),
  'clientId',p.client_id,'clientName',cl.display_name,'clientType',cl.client_type,'pod',u.name,'segment',nullif(btrim(p.segment),''),
  'stage',${STAGE},'deliveries',coalesce(d.n,0),'lastDeliveredAt',d.last)`;
// R55: money is on the map for leadership with finance grants (the database decides, as for every finance view).
const MONEY_OFF = { connected: false, detail: "Money on the map is for leadership with finance access: invoices, collections and the pipeline by place." };
/** "nominatim:https://… ; query=…" → the kind of source, for a badge; the full text stays on the detail. */
const SOURCE_KIND = `case when l.pinned_at is not null then 'pulse' when l.source like 'drive_%' then 'document'
  when l.source like 'nominatim:%' then 'osm' when l.source is null then null else 'other' end`;

const mustId = (id: string) => { if (!UUID.test(id)) fail(404, "Location not found"); };
const canPin = (v: Viewer) => { if (!admin(v)) fail(403, "Only an organisation admin can move a pin"); if (!v.person) fail(403, "A shared login cannot move a pin"); };

async function change(c: PoolClient, v: Viewer, id: string, action: "pin" | "reset", next: { lat: number | null; lng: number | null; precision: string | null; source: string | null }, note: string | null) {
  const old = (await c.query("select lat,lng,precision,source from pulse.project_location where id=$1 for update", [id])).rows[0];
  if (!old) fail(404, "Location not found");
  await c.query(`update pulse.project_location set lat=$1,lng=$2,precision=$3,source=$4,pinned_by=$5,pinned_at=$6,updated_at=now() where id=$7`,
    [next.lat, next.lng, next.precision, next.source, action === "pin" ? v.person : null, action === "pin" ? new Date() : null, id]);
  await c.query(`insert into pulse.project_location_change(org_id,location_id,action,old_lat,old_lng,old_precision,old_source,new_lat,new_lng,new_precision,new_source,note,changed_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
  [v.org, id, action, old.lat, old.lng, old.precision, old.source, next.lat, next.lng, next.precision, next.source, note, v.person]);
}

export function registerMapRoutes(app: FastifyInstance, { tx }: Deps) {
  const body = { type: "object" } as const;

  app.get("/api/v0/map", req => tx(req, async (c, v) => {
    work(v);
    const locations = (await c.query(`select l.id,l.geo_key "key",l.name,l.client_label "clientLabel",l.locality,l.city,l.lat,l.lng,l.precision,
      ${SOURCE_KIND} "sourceKind",(l.pinned_at is not null) pinned,l.review_flags flags,cardinality(l.rera_numbers) rera,
      cardinality(l.maps_links) "mapsLinks",coalesce(e.list,'[]') engagements
      from pulse.project_location l left join lateral (
        select jsonb_agg(${ENGAGEMENT} order by p.start_month nulls last,p.registry_no) list
        from pulse.project_location_member m join pulse.project p on p.id=m.project_id
        left join pulse.client cl on cl.id=p.client_id left join pulse.unit u on u.id=p.unit_id
        left join ${DELIVERIES} d on d.project_id=p.id where m.location_id=l.id) e on true
      order by l.city nulls last,l.locality nulls last,l.name nulls last,l.geo_key`)).rows;
    const localities = (await c.query(`select id,name,city,lat,lng,precision,source,aliases from pulse.locality order by city,name`)).rows;
    // A repeat client is one with more than one engagement anywhere in Pulse, on the map or not.
    const clients = (await c.query(`select cl.id,cl.display_name name,cl.client_type "type",count(p.id)::int engagements
      from pulse.client cl join pulse.project p on p.client_id=cl.id group by cl.id`)).rows;
    const pods = (await c.query(`select name from pulse.unit where kind='pod' and valid_to is null order by name`)).rows.map(r => r.name);
    const provenance = (await c.query(`select file_name "fileName",sha256,row_count "rows",built_at "builtAt",imported_at "importedAt",note
      from pulse.geo_import order by imported_at desc`)).rows;
    const pins = (await c.query(`select count(*)::int moved,max(changed_at) "lastAt" from pulse.project_location_change where action='pin'`)).rows[0];
    // R55 layers everyone who works on projects may see: shoots (with their model and place), prices written in a
    // project's own documents, clients and developers, the office (travel times start there).
    const shoots = (await c.query(`select s.lat,s.lng,to_char(s.shoot_on,'YYYY-MM-DD') "day",to_char(s.month,'YYYY-MM') "month",pe.display_name model,s.person_id "personId",
      s.project_id "projectId",m.location_id "locationId",coalesce(s.place,l.name) place,s.place_basis "placeBasis",s.status,s.client_label "clientLabel",s.deliverable
      from pulse.talent_shoot s left join pulse.person pe on pe.id=s.person_id left join pulse.locality l on l.id=s.locality_id
      left join pulse.project_location_member m on m.project_id=s.project_id order by s.shoot_on desc nulls last`)).rows;
    const prices = (await c.query(`select m.location_id "locationId",mp.project_id "projectId",mp.price::float price,mp.kind,mp.file_name "fileName",mp.quote,to_char(mp.observed_on,'YYYY-MM-DD') "observedOn"
      from pulse.market_price mp left join pulse.project_location_member m on m.project_id=mp.project_id order by mp.observed_on desc nulls last`)).rows;
    const office = (await c.query(`select name,lat,lng from pulse.presence_office where active order by created_at limit 3`)).rows;
    const review = admin(v) ? (await c.query(`select count(*)::int n from pulse.review_item where kind='geocode' and status='pending'`)).rows[0].n : null;
    const finance = (await c.query("select pulse.talent_cost_visible() v")).rows[0].v as boolean;
    const money = finance ? { connected: true, ...(await c.query("select pulse.money_map() m")).rows[0].m } : admin(v) ? MONEY_OFF : undefined;
    const sourceEngagements = provenance.find(p => p.fileName === "project_engagements.csv")?.rows ?? null;
    const linkedEngagements = locations.reduce((n, l) => n + l.engagements.length, 0);
    const joins = { sourceEngagements, linkedEngagements, unmatchedEngagements: sourceEngagements === null ? null : sourceEngagements - linkedEngagements };
    return { locations, localities, clients, pods, provenance, pins, joins, canEdit: admin(v) && !!v.person, leadership: admin(v) || finance,
      money, shoots, prices, office, review, generatedAt: new Date() };
  }));

  app.get<{ Params: { id: string } }>("/api/v0/map/locations/:id", req => tx(req, async (c, v) => {
    work(v); mustId(req.params.id);
    const row = (await c.query(`select l.id,l.geo_key "key",l.name,l.client_label "clientLabel",l.locality,l.city,l.lat,l.lng,l.precision,l.source,
      ${SOURCE_KIND} "sourceKind",l.rera_numbers "reraNumbers",l.maps_links "mapsLinks",l.review_flags flags,
      l.seed_lat "seedLat",l.seed_lng "seedLng",l.seed_precision "seedPrecision",l.seed_source "seedSource",
      l.pinned_at "pinnedAt",pb.display_name "pinnedBy",i.file_name "importFile",i.built_at "importBuiltAt",i.imported_at "importedAt",left(i.sha256,12) "importSha"
      from pulse.project_location l left join pulse.person pb on pb.id=l.pinned_by left join pulse.geo_import i on i.id=l.import_id
      where l.id=$1`, [req.params.id])).rows[0];
    if (!row) fail(404, "Location not found");
    const manualLinks=(await c.query(`select l.kind,l.label,l.value,by.display_name "editedBy" from pulse.record_link l left join pulse.person by on by.id=l.edited_by
      where (l.entity_type='project' and l.entity_id in(select project_id from pulse.project_location_member where location_id=$1))
      or (l.entity_type='client' and l.entity_id in(select p.client_id from pulse.project p join pulse.project_location_member m on m.project_id=p.id where m.location_id=$1))`,[row.id])).rows;
    row.mapsLinks=[...new Set([...row.mapsLinks,...manualLinks.filter(l=>l.kind==='maps').map(l=>l.value)])];
    row.reraNumbers=[...new Set([...row.reraNumbers,...manualLinks.filter(l=>l.kind==='rera').map(l=>l.value)])];
    const addresses=(await c.query(`select a.address,p.display_name "editedBy" from pulse.record_annotation a left join pulse.person p on p.id=a.edited_by where a.address is not null and
      ((a.entity_type='project' and a.entity_id in(select project_id from pulse.project_location_member where location_id=$1)) or
       (a.entity_type='client' and a.entity_id in(select p.client_id from pulse.project p join pulse.project_location_member m on m.project_id=p.id where m.location_id=$1)))`,[row.id])).rows;
    const engagements = (await c.query(`select ${ENGAGEMENT} e from pulse.project_location_member m join pulse.project p on p.id=m.project_id
      left join pulse.client cl on cl.id=p.client_id left join pulse.unit u on u.id=p.unit_id left join ${DELIVERIES} d on d.project_id=p.id
      where m.location_id=$1 order by p.start_month desc nulls last,p.registry_no desc`, [row.id])).rows.map(r => r.e);
    const projects = `(select project_id from pulse.project_location_member where location_id=$1)`;
    const clients = (await c.query(`select cl.id,cl.display_name name,cl.company_name "companyName",cl.client_type "type",
      (select count(*)::int from pulse.project x where x.client_id=cl.id) engagements,
      (select count(distinct m.location_id)::int from pulse.project x join pulse.project_location_member m on m.project_id=x.id where x.client_id=cl.id) locations
      from pulse.client cl where cl.id in (select client_id from pulse.project where id in ${projects}) order by cl.display_name`, [row.id])).rows;
    const contacts = (await c.query(`select distinct on (pe.id) pe.id,pe.display_name name,cp.contact_type "type",cp.designation,cp.email,cp.phone,x.via
      from (select cc.person_id,case when cc.is_primary then 'Primary contact' else 'Client contact' end via,cc.is_primary::int rank
              from pulse.client_contact cc where cc.client_id in (select client_id from pulse.project where id in ${projects})
            union all select pc.person_id,pc.role,0 from pulse.project_contact pc where pc.project_id in ${projects}) x
      join pulse.person pe on pe.id=x.person_id left join pulse.contact_profile cp on cp.person_id=pe.id
      order by pe.id,x.rank desc`, [row.id])).rows;
    const counts = (await c.query(`select count(*)::int total,count(*) filter(where kind='final')::int finals,count(*) filter(where kind='draft')::int drafts,
      min(delivered_at) "first",max(delivered_at) "last" from pulse.delivery where project_id in ${projects}`, [row.id])).rows[0];
    const latest = (await c.query(`select d.file_id "fileId",coalesce(f.display_name,f.name) "fileName",
      (select pe.display_name from pulse.delivery_actor oa join pulse.person pe on pe.id=oa.actor_id where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorName",
      (select oa.actor_account from pulse.delivery_actor oa where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorAccount",
      (select oa.basis from pulse.delivery_actor oa where oa.org_id=d.org_id and oa.file_id=d.file_id) "actorBasis",
      (select pe.display_name from pulse.file_correction fc join pulse.person pe on pe.id=fc.edited_by where fc.org_id=d.org_id and fc.file_id=d.file_id) "editedBy",f.mime,d.kind,d.delivered_at "deliveredAt",coalesce(p.title,p.name) "projectName"
      from pulse.delivery d join pulse.index_file f using(org_id,file_id) join pulse.project p on p.id=d.project_id
      where d.project_id in ${projects} order by d.delivered_at desc,d.file_id limit 8`, [row.id])).rows;
    const campaigns = (await c.query(`select g.id,g.name,g.platform,g.objective from pulse.campaign g where g.project_id in ${projects} order by g.name limit 30`, [row.id])).rows;
    const history = (await c.query(`select h.action,h.old_lat "oldLat",h.old_lng "oldLng",h.old_precision "oldPrecision",h.new_lat "newLat",h.new_lng "newLng",
      h.new_precision "newPrecision",h.note,h.changed_at "at",pe.display_name "by" from pulse.project_location_change h
      left join pulse.person pe on pe.id=h.changed_by where h.location_id=$1 order by h.changed_at desc limit 20`, [row.id])).rows;
    // The project's invoices are in the map's money (one read for the whole map); here only whether money is connected.
    const finance = (await c.query("select pulse.talent_cost_visible() v")).rows[0].v as boolean;
    return { ...row, manualLinks, addresses, engagements, clients, contacts, deliveries: { ...counts, latest }, campaigns, history,
      campaignsDetail: "Campaigns appear once the ads account is connected to this project.",
      money: finance ? { connected: true, detail: "This project's invoices, collections and pipeline are in the map's Money tab." } : admin(v) ? MONEY_OFF : undefined,
      canEdit: admin(v) && !!v.person };
  }));

  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/map/locations/:id/pin", { schema: { body } }, req => tx(req, async (c, v) => {
    mustId(req.params.id); canPin(v);
    const numeric = (x: unknown) => typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x;
    const lat = numeric(req.body.lat), lng = numeric(req.body.lng);
    if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail(400, "Give a latitude and longitude such as 18.5204, 73.8567");
    const note = String(req.body.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || null;
    const round = (n: number) => Math.round(n * 1e7) / 1e7;
    await change(c, v, req.params.id, "pin", { lat: round(lat as number), lng: round(lng as number), precision: "exact", source: `pulse_pin:placed in Pulse by ${v.name}` }, note);
    return { ok: true };
  }));

  // R55: the geocode review queue (Review data kind 'geocode'), for the map's Pins tab. Admins decide; HR and leadership read.
  app.get("/api/v0/map/review", req => tx(req, async (c, v) => {
    work(v); if (!admin(v)) fail(403, "Organisation admins check the map's places");
    const items = (await c.query(`select r.id,r.title,r.entity_type "entityType",r.entity_id "entityId",r.proposed,r.confidence::float confidence,r.evidence
      from pulse.review_item r where r.kind='geocode' and r.status='pending'
      order by coalesce((r.proposed->>'projects')::int,1) desc,r.confidence desc,r.title limit 200`)).rows;
    return { items, canEdit: admin(v) && !!v.person };
  }));
  app.post("/api/v0/map/review/check", req => tx(req, async (c, v) => {
    canPin(v); return { open: (await c.query("select pulse.geo_review_scan() n")).rows[0].n };
  }));
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/map/review/:id", { schema: { body } }, req => tx(req, async (c, v) => {
    mustId(req.params.id); canPin(v);
    const action = String(req.body.action ?? "");
    if (!["accept", "keep"].includes(action)) fail(400, "Choose accept or keep");
    const lat = req.body.lat === undefined || req.body.lat === null ? null : Number(req.body.lat), lng = req.body.lng === undefined || req.body.lng === null ? null : Number(req.body.lng);
    if ((lat === null) !== (lng === null) || (lat !== null && (!Number.isFinite(lat) || !Number.isFinite(lng!) || Math.abs(lat) > 90 || Math.abs(lng!) > 180))) fail(400, "Give a latitude and longitude such as 18.5204, 73.8567");
    return { moved: (await c.query("select pulse.geo_review_decide($1,$2,$3,$4) n", [req.params.id, action === "accept", lat, lng])).rows[0].n };
  }));
  // R55: which client an invoice party is (leadership with finance grants; the database checks and audits).
  app.post<{ Body: Body }>("/api/v0/map/money/party", { schema: { body } }, req => tx(req, async (c, v) => {
    work(v); if (!v.person) fail(403, "Use your own sign-in");
    if (!(await c.query("select pulse.talent_cost_visible() v")).rows[0].v) fail(403, "Money on the map is for leadership with finance access");
    const key = String(req.body.key ?? "").slice(0, 200); if (!key) fail(400, "Choose an invoice party");
    const client = req.body.clientId ? String(req.body.clientId) : null, project = req.body.projectId ? String(req.body.projectId) : null;
    if ((client && !UUID.test(client)) || (project && !UUID.test(project))) fail(400, "Choose a client or a project");
    await c.query("select pulse.money_party_decide($1,$2,$3)", [key, client, project]);
    return { ok: true };
  }));
  app.post("/api/v0/map/money/check", req => tx(req, async (c, v) => {
    work(v); if (!(await c.query("select pulse.talent_cost_visible() v")).rows[0].v) fail(403, "Money on the map is for leadership with finance access");
    return { parties: (await c.query("select pulse.money_party_refresh() n")).rows[0].n };
  }));

  // Back to what the import said. The move stays in the history.
  app.post<{ Params: { id: string }; Body: Body }>("/api/v0/map/locations/:id/reset", { schema: { body } }, req => tx(req, async (c, v) => {
    mustId(req.params.id); canPin(v);
    const seed = (await c.query(`select seed_lat lat,seed_lng lng,seed_precision "precision",seed_source source,pinned_at from pulse.project_location where id=$1`, [req.params.id])).rows[0];
    if (!seed) fail(404, "Location not found");
    if (!seed.pinned_at) fail(409, "This pin is already at its source position");
    await change(c, v, req.params.id, "reset", { lat: seed.lat, lng: seed.lng, precision: seed.precision, source: seed.source }, null);
    return { ok: true };
  }));
}
