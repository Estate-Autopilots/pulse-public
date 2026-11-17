import { ORG_TZ } from './org-time.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { admin, fail, manager, work, type Tx } from './routes.js';

type ClaimStatus = 'pending' | 'confirmed' | 'rejected';
const weekPattern = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/;
const deliveryId = (value: unknown) => {
  const id = String(value ?? '');
  if (!id || id.length > 512 || /[\u0000-\u001f]/.test(id)) fail(400, 'Choose a valid delivery');
  return id;
};
const person = (value: string | null) => {
  if (!value) fail(403, 'A personal account is required');
  return value;
};

async function weekBounds(c: PoolClient, week: unknown) {
  if (typeof week !== 'string' || !weekPattern.test(week)) fail(400, 'Use an ISO week such as 2026-W41');
  const result = (await c.query(`select to_char(to_date($1,'IYYY-"W"IW'),'IYYY-"W"IW')=$1 valid,
      to_date($1,'IYYY-"W"IW')::timestamp at time zone ${ORG_TZ} start,
      (to_date($1,'IYYY-"W"IW')+7)::timestamp at time zone ${ORG_TZ} "end"`, [week])).rows[0];
  if (!result?.valid) fail(400, 'Invalid ISO week');
  return { start: result.start as Date, end: result.end as Date };
}

function claimBody(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Choose a decision');
  const value = body as Record<string, unknown>;
  if (value.decision !== 'confirmed' && value.decision !== 'rejected') fail(400, 'Choose confirmed or rejected');
  let reason: string | null = null;
  if (value.reason !== undefined) {
    const candidate = value.reason;
    if (typeof candidate !== 'string') fail(400, 'Reason must be between 1 and 240 characters');
    const trimmed = (candidate as string).trim();
    if (trimmed.length < 1 || trimmed.length > 240)
      fail(400, 'Reason must be between 1 and 240 characters');
    reason = trimmed;
  }
  if (Object.keys(value).some(key => key !== 'decision' && key !== 'reason')) fail(400, 'Unknown decision field');
  return { decision: value.decision as Exclude<ClaimStatus, 'pending'>, reason };
}

export function registerDeliveryClaimRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Querystring: { week?: string } }>('/v1/deliveries/claimable', req => tx(req, async (c, v) => {
    work(v);
    const viewer = person(v.person);
    const { start, end } = await weekBounds(c, req.query.week);
    const deliveries = (await c.query(`select d.file_id id,coalesce(p.title,p.name) "projectName",f.name "fileName",
        d.kind,d.delivered_at "deliveredAt"
      from pulse.delivery d join pulse.index_file f using(org_id,file_id)
      join pulse.project p on p.org_id=d.org_id and p.id=d.project_id
      join pulse.account a on a.org_id=d.org_id and a.provider='google' and a.handle=d.uploader_account and a.is_shared
      where d.org_id=$1 and d.delivered_at >= $2 and d.delivered_at < $3 and d.kind in ('draft','final')
        and d.project_id=any(pulse.work_projects())
        and coalesce((
          select not (attribution.method in ('evidence','declared','individual_account','device','manual')
            and attribution.person_id is not null)
          from pulse.file source_file
          join pulse.version version on version.file_id=source_file.id
          join pulse.attribution attribution on attribution.version_id=version.id
            and attribution.resolver_version='delivery-attribution/v1'
          where source_file.org_id=d.org_id and source_file.store='gdrive' and source_file.store_id=d.file_id
          order by attribution.event_time desc,attribution.event_seq desc limit 1
        ),true)
        and not pulse.delivery_claim_taken(d.file_id)
      order by d.delivered_at desc,d.file_id`, [v.org, start, end])).rows;
    await c.query(`insert into privacy.access_log(org_id,viewer_id,subject_person_id,resource,grain,purpose)
      values ($1,$2,$2,'editor.delivery_claimable','week','editor_delivery_claim')`, [v.org, viewer]);
    return { week: req.query.week, deliveries };
  }));

  app.get<{ Querystring: { week?: string; status?: string } }>('/v1/deliveries/claims', req => tx(req, async (c, v) => {
    work(v);
    if (!admin(v) && !manager(v)) fail(403, 'Only admins or managers can review delivery claims');
    const { start, end } = await weekBounds(c, req.query.week);
    const status = req.query.status ?? 'pending';
    if (status !== 'pending' && status !== 'confirmed' && status !== 'rejected') fail(400, 'Unknown claim status');
    const claims = (await c.query(`select claim.id,claim.file_id "deliveryId",claim.person_id "personId",
        person.display_name "personName",coalesce(project.title,project.name) "projectName",file.name "fileName",
        delivery.kind,delivery.delivered_at "deliveredAt",claim.status,claim.credited_via "creditedVia",
        claim.created_at "createdAt"
      from pulse.delivery_claim claim join pulse.delivery delivery
        on delivery.org_id=claim.org_id and delivery.file_id=claim.file_id
      join pulse.index_file file on file.org_id=delivery.org_id and file.file_id=delivery.file_id
      join pulse.project project on project.org_id=delivery.org_id and project.id=delivery.project_id
      join pulse.person person on person.org_id=claim.org_id and person.id=claim.person_id
      where claim.org_id=$1 and claim.claim_scope='delivery' and claim.status=$2
        and delivery.delivered_at >= $3 and delivery.delivered_at < $4
      order by claim.created_at,claim.id`, [v.org, status, start, end])).rows;
    for (const claim of claims as Array<{ personId: string }>) {
      await c.query(`insert into privacy.access_log(org_id,viewer_id,subject_person_id,resource,grain,purpose)
        values ($1,$2,$3,'editor.delivery_claims','week','editor_delivery_claim_review')`, [v.org, v.person, claim.personId]);
    }
    return { week: req.query.week, claims };
  }));

  app.post<{ Params: { id: string }; Body: Record<string, never> }>('/v1/deliveries/:id/claim',
    { schema: { body: { type: 'object', additionalProperties: false } } }, req => tx(req, async (c, v) => {
      work(v);
      const viewer = person(v.person);
      if (req.body && Object.keys(req.body).length) fail(400, 'A claim does not accept person or decision fields');
      const id = deliveryId(req.params.id);
      const result = (await c.query(`insert into pulse.delivery_claim(org_id,file_id,person_id)
        select $1,d.file_id,$3 from pulse.delivery d join pulse.account a
          on a.org_id=d.org_id and a.provider='google' and a.handle=d.uploader_account and a.is_shared
        where d.org_id=$1 and d.file_id=$2 and d.kind in ('draft','final')
          and d.project_id=any(pulse.work_projects())
          and coalesce((
            select not (attribution.method in ('evidence','declared','individual_account','device','manual')
              and attribution.person_id is not null)
            from pulse.file source_file
            join pulse.version version on version.file_id=source_file.id
            join pulse.attribution attribution on attribution.version_id=version.id
              and attribution.resolver_version='delivery-attribution/v1'
            where source_file.org_id=d.org_id and source_file.store='gdrive' and source_file.store_id=d.file_id
            order by attribution.event_time desc,attribution.event_seq desc limit 1
          ),true)
        on conflict (org_id,file_id) where status in ('pending','confirmed') do nothing
        returning id,file_id "deliveryId",person_id "personId",status,credited_via "creditedVia",created_at "createdAt"`,
      [v.org, id, viewer])).rows[0];
      if (!result) fail(409, 'This shared-login delivery is unavailable to claim');
      return result;
    }));

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/v1/deliveries/:id/claim/decide',
    { schema: { body: { type: 'object', additionalProperties: false, properties: {
      decision: { type: 'string', enum: ['confirmed','rejected'] }, reason: { type: 'string', minLength: 1, maxLength: 240 },
    } } } }, req => tx(req, async (c, v) => {
      work(v);
      if (!admin(v) && !manager(v)) fail(403, 'Only admins or managers can decide delivery claims');
      const { decision, reason } = claimBody(req.body);
      const actor = admin(v) ? v.person : person(v.person);
      const id = deliveryId(req.params.id);
      const claim = (await c.query(`select id "id",person_id "personId" from pulse.delivery_claim
        where org_id=$1 and file_id=$2 and status='pending' for update`, [v.org, id])).rows[0];
      if (!claim) fail(404, 'Pending claim was not found');
      if (claim.personId === v.person) fail(403, 'You cannot decide your own claim');
      if (!admin(v) && !((await c.query('select pulse.manages($1) ok', [claim.personId])).rows[0]?.ok))
        fail(403, 'Only the editor’s manager can decide this claim');
      const result = (await c.query(`update pulse.delivery_claim set status=$3,decided_by=$4,decided_at=now(),reason=$5
        where org_id=$1 and id=$2 and status='pending'
        returning id,file_id "deliveryId",person_id "personId",status,credited_via "creditedVia",
          created_at "createdAt",decided_by "decidedBy",decided_at "decidedAt"`,
      [v.org, claim.id, decision, actor, reason])).rows[0];
      if (!result) fail(409, 'This claim has already been decided');
      await c.query("select pulse.audit_write($1,'delivery_claim',$2,$3)",
        [`delivery_claim.${decision}`, result.id, decision === 'confirmed' ? ['status','credited_via'] : ['status']]);
      return result;
    }));
}
