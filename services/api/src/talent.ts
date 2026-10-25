// R55 part 1: models and talent. The talent index (pulse_workers.talent_index) as a ranked board and a profile per
// model inside Contacts. Everyone who works on projects may see shoots, projects, clients and videos; what a model
// costs is decided by the database (leadership with finance grants) and every read of it is audited.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail, work, type Tx, type Viewer } from "./routes.js";
import { ORG_TZ } from "./org-time.js";
import { rankModels, TALENT_METHOD, type AdFact, type FeeFact } from "./talent-model.js";

type Deps = { tx: Tx };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Today on the company's calendar (its time zone; India for EA). */
const today = async (c: PoolClient) => (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d`)).rows[0].d as string;

async function facts(c: PoolClient) {
  const people = (await c.query(`select p.id,p.display_name name,
      coalesce((select array_agg(distinct a.alias order by a.alias) from pulse.talent_alias a where a.person_id=p.id and a.status<>'rejected'),'{}') aliases,
      (select count(*)::int from pulse.talent_media m where m.person_id=p.id and m.basis='portfolio_folder') portfolio
    from pulse.contact_profile cp join pulse.person p on p.id=cp.person_id
    where cp.contact_type='talent' and p.status<>'offboarded'
      and (exists(select 1 from pulse.talent_shoot s where s.person_id=p.id) or exists(select 1 from pulse.talent_media m where m.person_id=p.id))`)).rows;
  const shoots = (await c.query(`select s.person_id "personId",to_char(s.shoot_on,'YYYY-MM-DD') "shootOn",to_char(s.month,'YYYY-MM-DD') "month",s.project_id "projectId",
      p.client_id "clientId",s.client_label "clientLabel",s.language,s.segment,s.deliverable,s.status,s.scripts::float scripts,s.source_key "sourceKey"
    from pulse.talent_shoot s left join pulse.project p on p.id=s.project_id where s.person_id is not null`)).rows;
  const engagements = (await c.query(`select client_id "clientId",to_char(start_month,'YYYY-MM-DD') "month" from pulse.project where client_id is not null and start_month is not null and kind='client_work'`)).rows;
  const media = (await c.query(`select m.person_id "personId",m.kind,m.basis,count(*)::int files,count(d.file_id)::int delivered
    from pulse.talent_media m left join (select distinct file_id from pulse.delivery) d on d.file_id=m.file_id group by 1,2,3`)).rows;
  const ads: AdFact[] = (await c.query(`select a.name,coalesce(sum(m.spend),0)::float spend,coalesce(sum(m.leads),0)::int leads,coalesce(sum(m.impressions),0)::float impressions,
    coalesce(sum(m.link_clicks),0)::float clicks from pulse.ad a join pulse.ad_metric_day m on m.ad_id=a.id group by a.id,a.name`)).rows;
  const costVisible = (await c.query("select pulse.talent_cost_visible() v")).rows[0].v as boolean;
  const fees: FeeFact[] | undefined = costVisible ? ((await c.query("select pulse.talent_fees() f")).rows[0].f as FeeFact[]).map((f) => ({ ...f, total: num(f.total), charges: num(f.charges), travel: num(f.travel), extra: num(f.extra) })) : undefined;
  return { people, shoots, engagements, media, ads, fees, costVisible };
}
const num = (x: unknown) => x === null || x === undefined ? null : Number(x);

async function lastRun(c: PoolClient) {
  return (await c.query(`select finished_at "finishedAt",ok,counts,sources from pulse.talent_run where finished_at is not null order by finished_at desc limit 1`)).rows[0] ?? null;
}

export function registerTalentRoutes(app: FastifyInstance, { tx }: Deps) {
  app.get("/api/v0/talent", (req) => tx(req, async (c, v: Viewer) => {
    work(v);
    const f = await facts(c);
    const ranked = rankModels({ people: f.people, shoots: f.shoots, engagements: f.engagements, media: f.media, fees: f.fees, ads: f.ads, today: await today(c) });
    const review = (await c.query(`select count(*)::int n from pulse.review_item where kind='talent' and status='pending'`)).rows[0].n;
    const unresolved = (await c.query(`select count(*)::int n from pulse.talent_shoot where person_id is null`)).rows[0].n;
    const linked = (await c.query(`select count(*)::int shoots,count(project_id)::int linked,count(lat)::int placed from pulse.talent_shoot`)).rows[0];
    return { ...ranked, method: TALENT_METHOD, run: await lastRun(c), review, unresolved, coverage: linked,
      adsConnected: f.ads.length > 0, canReview: v.role === "admin" && !!v.person, generatedAt: new Date() };
  }));

  app.get<{ Params: { id: string } }>("/api/v0/talent/:id", (req) => tx(req, async (c, v: Viewer) => {
    work(v);
    if (!UUID.test(req.params.id)) fail(404, "Model not found");
    const person = (await c.query(`select p.id,p.display_name name,cp.source,cp.city,cp.notes from pulse.person p join pulse.contact_profile cp on cp.person_id=p.id
      where p.id=$1 and cp.contact_type='talent'`, [req.params.id])).rows[0];
    if (!person) fail(404, "Model not found");
    const f = await facts(c);
    const ranked = rankModels({ people: f.people, shoots: f.shoots, engagements: f.engagements, media: f.media, fees: f.fees, ads: f.ads, today: await today(c) });
    const row = ranked.models.find((m) => m.id === person.id) ?? null;
    const aliases = (await c.query(`select alias,alias_key "key",basis,status,confidence::float confidence,seen from pulse.talent_alias where person_id=$1 order by seen desc`, [person.id])).rows;
    const shoots = (await c.query(`select s.source_key "key",to_char(s.shoot_on,'YYYY-MM-DD') "shootOn",to_char(s.month,'YYYY-MM') "month",s.client_label "clientLabel",
      s.project_id "projectId",coalesce(p.title,p.name) "projectName",s.project_basis "projectBasis",s.project_confidence::float "projectConfidence",
      cl.id "clientId",cl.display_name "clientName",s.place,l.name "locality",s.place_basis "placeBasis",s.deliverable,s.segment,s.language,s.scripts::float scripts,s.crew,s.status,s.sources,s.source
      from pulse.talent_shoot s left join pulse.project p on p.id=s.project_id left join pulse.client cl on cl.id=p.client_id left join pulse.locality l on l.id=s.locality_id
      where s.person_id=$1 order by s.shoot_on desc nulls last,s.source_key`, [person.id])).rows;
    const media = (await c.query(`select m.file_id "fileId",m.name,m.mime,m.kind,m.basis,m.link,to_char(m.created_at,'YYYY-MM-DD') "createdOn",m.project_id "projectId",coalesce(p.title,p.name) "projectName",
      exists(select 1 from pulse.delivery d where d.file_id=m.file_id) delivered
      from pulse.talent_media m left join pulse.project p on p.id=m.project_id where m.person_id=$1 order by m.created_at desc nulls last limit 120`, [person.id])).rows;
    const projects = (await c.query(`select p.id,coalesce(p.title,p.name) title,p.location,to_char(p.start_month,'YYYY-MM') "month",cl.id "clientId",cl.display_name "clientName",
      count(*)::int shoots,max(s.shoot_on)::text "lastShoot",(select count(*)::int from pulse.talent_media m where m.person_id=$1 and m.project_id=p.id) videos
      from pulse.talent_shoot s join pulse.project p on p.id=s.project_id left join pulse.client cl on cl.id=p.client_id where s.person_id=$1
      group by p.id,cl.id order by max(s.shoot_on) desc nulls last`, [person.id])).rows;
    const fees = f.costVisible ? ((await c.query("select pulse.talent_fees($1) f", [person.id])).rows[0].f as unknown[]) : undefined;
    return { ...person, row, aliases, shoots, media, projects, fees, costVisible: f.costVisible, baseline: ranked.baseline, method: TALENT_METHOD,
      adsConnected: f.ads.length > 0, review: (await c.query(`select id,title,proposed,confidence::float confidence from pulse.review_item where kind='talent' and status='pending'
        and (proposed->>'personId'=$1 or exists(select 1 from jsonb_array_elements(coalesce(proposed->'options','[]')) o where o->>'id'=$1)) order by confidence desc limit 20`, [person.id])).rows };
  }));
}
