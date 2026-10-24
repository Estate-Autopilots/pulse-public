import { ORG_TZ } from "./org-time.js";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { admin, fail, manager, type Tx, type Viewer } from "./routes.js";
import { classifyDesignType, isDesignExport, loadDesignerTargets } from "./editor-targets.js";

type ClaimStatus = "pending" | "confirmed" | "rejected";
const weekPattern = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/;
const fileId = (value: unknown) => {
  const id = String(value ?? "");
  if (!id || id.length > 512 || /[\u0000-\u001f]/.test(id)) fail(400, "Choose a valid design export");
  return id;
};
const person = (value: string | null) => {
  if (!value) fail(403, "A personal account is required");
  return value;
};

async function weekBounds(c: PoolClient, week: unknown) {
  if (typeof week !== "string" || !weekPattern.test(week)) fail(400, "Use an ISO week such as 2026-W41");
  const result = (await c.query(`select to_char(to_date($1,'IYYY-\"W\"IW'),'IYYY-\"W\"IW')=$1 valid,
      to_date($1,'IYYY-\"W\"IW')::timestamp at time zone ${ORG_TZ} start,
      (to_date($1,'IYYY-\"W\"IW')+7)::timestamp at time zone ${ORG_TZ} "end"`, [week])).rows[0];
  if (!result?.valid) fail(400, "Invalid ISO week");
  return { start: result.start as Date, end: result.end as Date };
}

async function designerTargets(c: PoolClient, org: string) {
  const body = (await c.query(`select body from pulse.tenant_config
    where org_id=$1 and doc_kind='targets' and doc_key='designers' and is_active`, [org])).rows[0]?.body ?? {};
  return loadDesignerTargets(body);
}

async function requireDesigner(c: PoolClient, v: Viewer) {
  const viewer = person(v.person);
  const targets = await designerTargets(c, v.org);
  const active = (await c.query(`select 1 from pulse.person p
    join pulse.people_profile profile on profile.org_id=p.org_id and profile.person_id=p.id
    where p.org_id=$1 and p.id=$2 and p.side='staff' and p.status='active'
      and lower(trim(profile.role))=any($3::text[])`, [v.org, viewer, targets.roles])).rows[0];
  if (!active) fail(403, "Only active designers can claim design exports");
  return viewer;
}

async function folderRules(c: PoolClient, org: string) {
  return (await c.query(`select body from pulse.tenant_config
    where org_id=$1 and doc_kind='folder_rules' and is_active
      and (body ? 'design_type_rules' or (body->'folder_rules') ? 'design_type_rules')
    order by version desc,doc_key limit 1`, [org])).rows[0]?.body ?? {};
}

async function logRead(c: PoolClient, org: string, viewer: string | null, subject: string | null,
  resource: string, purpose: string) {
  await c.query(`insert into privacy.access_log(org_id,viewer_id,subject_person_id,resource,grain,purpose)
    values ($1,$2,$3,$4,'week',$5)`, [org, viewer, subject, resource, purpose]);
}

export function registerDesignClaimRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Querystring: { week?: string } }>("/v1/designs/claimable", req => tx(req, async (c, v) => {
    const viewer = await requireDesigner(c, v);
    const { start, end } = await weekBounds(c, req.query.week);
    const config = await folderRules(c, v.org);
    const files = (await c.query(`select f.file_id id,coalesce(project.title,project.name,'Unassigned project') "projectName",
        f.name "fileName",f.path,f.mime,coalesce(f.modified_at,f.created_at) "uploadedAt",
        case when exists(select 1 from pulse.delivery_claim own_claim where own_claim.org_id=f.org_id
          and own_claim.file_id=f.file_id and own_claim.claim_scope='design'
          and own_claim.person_id=pulse.current_viewer() and own_claim.status='pending')
          then 'pending' else 'claimable' end status,
        exists(select 1 from pulse.delivery d where d.org_id=f.org_id and d.file_id=f.file_id) "hasDelivery"
      from pulse.index_file f
      join pulse.account account on account.org_id=f.org_id and account.provider='google'
        and account.handle=f.uploader_account and account.is_shared
      left join pulse.project project on project.org_id=f.org_id and project.id=f.project_id
      where f.org_id=$1 and f.account_basis='last modifying account'
        and coalesce(f.modified_at,f.created_at)>=$2 and coalesce(f.modified_at,f.created_at)<$3
        and coalesce(f.modified_at,f.created_at)<now()
        and (lower(f.mime) like 'image/%' or lower(f.mime)='application/pdf'
          or lower(f.name) like any(array['%.ai','%.bmp','%.gif','%.jpeg','%.jpg','%.pdf','%.png','%.psd','%.svg','%.tif','%.tiff','%.webp']))
        and coalesce((select not (attribution.method in ('evidence','declared','individual_account','device','manual')
          and attribution.person_id is not null)
          from pulse.file source_file join pulse.version version
            on version.org_id=source_file.org_id and version.file_id=source_file.id
          join pulse.attribution attribution on attribution.org_id=version.org_id
            and attribution.version_id=version.id and attribution.resolver_version='delivery-attribution/v1'
          where source_file.org_id=f.org_id and source_file.store='gdrive' and source_file.store_id=f.file_id
          order by attribution.event_time desc,attribution.event_seq desc limit 1),true)
        and (not pulse.delivery_claim_taken(f.file_id) or exists(select 1 from pulse.delivery_claim own_claim
          where own_claim.org_id=f.org_id and own_claim.file_id=f.file_id and own_claim.claim_scope='design'
            and own_claim.person_id=pulse.current_viewer() and own_claim.status='pending'))
      order by coalesce(f.modified_at,f.created_at) desc,f.file_id`, [v.org, start, end])).rows as Array<{
        id: string; projectName: string; fileName: string; path: string; mime: string | null;
        uploadedAt: Date | string; status: "claimable" | "pending"; hasDelivery: boolean;
      }>;
    const designs = files.filter(file => isDesignExport(file.mime, file.fileName))
      .map(file => ({ ...file, type: classifyDesignType(file.path, file.fileName, config) }))
      .filter(file => file.type !== "other" || file.hasDelivery)
      .map(({ id, projectName, fileName, type, uploadedAt, status }) => ({ id, projectName, fileName, type, uploadedAt, status }));
    await logRead(c, v.org, viewer, viewer, "designs.claimable", "design_delivery_claim");
    return { week: req.query.week, designs };
  }));

  app.post<{ Params: { id: string }; Body: Record<string, never> }>("/v1/designs/:id/claim",
    { schema: { body: { type: "object", additionalProperties: false } } }, req => tx(req, async (c, v) => {
      const viewer = await requireDesigner(c, v);
      if (req.body && Object.keys(req.body).length) fail(400, "A claim does not accept person or decision fields");
      const id = fileId(req.params.id);
      const config = await folderRules(c, v.org);
      const file = (await c.query(`select f.name "fileName",f.path,f.mime,
          exists(select 1 from pulse.delivery d where d.org_id=f.org_id and d.file_id=f.file_id) "hasDelivery"
        from pulse.index_file f
        where f.org_id=$1 and f.file_id=$2 and pulse.design_claim_allowed(f.file_id)`, [v.org, id])).rows[0] as {
          fileName: string; path: string; mime: string | null; hasDelivery: boolean;
        } | undefined;
      if (!file || !isDesignExport(file.mime, file.fileName)
        || (classifyDesignType(file.path, file.fileName, config) === "other" && !file.hasDelivery)) {
        fail(409, "This design export is unavailable to claim");
      }
      const result = (await c.query(`insert into pulse.delivery_claim(org_id,file_id,person_id,claim_scope)
        select $1,f.file_id,$3,'design' from pulse.index_file f
        where f.org_id=$1 and f.file_id=$2 and pulse.design_claim_allowed(f.file_id)
        on conflict (org_id,file_id) where status in ('pending','confirmed') do nothing
        returning id,file_id "designId",person_id "personId",status,credited_via "creditedVia",created_at "createdAt"`,
      [v.org, id, viewer])).rows[0];
      if (!result) fail(409, "This design export is unavailable to claim");
      return result;
    }));

  app.get<{ Querystring: { week?: string; status?: ClaimStatus } }>("/v1/designs/claims", req => tx(req, async (c, v) => {
    if (!admin(v) && !manager(v)) fail(403, "Only admins or managers can review design claims");
    const { start, end } = await weekBounds(c, req.query.week);
    const status = req.query.status ?? "pending";
    if (!["pending", "confirmed", "rejected"].includes(status)) fail(400, "Unknown claim status");
    const claims = (await c.query(`select claim.id,claim.file_id "designId",claim.person_id "personId",
        claimant.display_name "personName",coalesce(project.title,project.name,'Unassigned project') "projectName",file.name "fileName",
        file.path,file.mime,coalesce(file.modified_at,file.created_at) "uploadedAt",claim.status,
        claim.credited_via "creditedVia",claim.created_at "createdAt",
        exists(select 1 from pulse.delivery d where d.org_id=file.org_id and d.file_id=file.file_id) "hasDelivery"
      from pulse.delivery_claim claim join pulse.index_file file
        on file.org_id=claim.org_id and file.file_id=claim.file_id
      left join pulse.project project on project.org_id=file.org_id and project.id=file.project_id
      join pulse.person claimant on claimant.org_id=claim.org_id and claimant.id=claim.person_id
      join pulse.account account on account.org_id=file.org_id and account.provider='google'
        and account.handle=file.uploader_account and account.is_shared
      where claim.org_id=$1 and claim.claim_scope='design' and claim.status=$2
        and coalesce(file.modified_at,file.created_at)>=$3 and coalesce(file.modified_at,file.created_at)<$4
      order by claim.created_at,claim.id`, [v.org, status, start, end])).rows as Array<{
        id: string; designId: string; personId: string; personName: string; projectName: string; fileName: string;
        path: string; mime: string | null; uploadedAt: Date | string; status: ClaimStatus; creditedVia: "claim";
        createdAt: Date | string; hasDelivery: boolean;
      }>;
    const config = await folderRules(c, v.org);
    const visibleClaims = claims.filter(claim => isDesignExport(claim.mime, claim.fileName)
      && (classifyDesignType(claim.path, claim.fileName, config) !== "other" || claim.hasDelivery))
      .map(({ path, mime, hasDelivery: _hasDelivery, ...claim }) => ({
        ...claim, type: classifyDesignType(path, claim.fileName, config),
      }));
    const viewer = v.person;
    const subjects = [...new Set(visibleClaims.map(claim => claim.personId))];
    for (const subject of subjects) await logRead(c, v.org, viewer, subject, "designs.claims", "design_delivery_claim_review");
    return { week: req.query.week, claims: visibleClaims };
  }));
}
