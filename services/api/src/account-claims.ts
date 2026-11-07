import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { admin, fail, manager, type Tx, type Viewer } from "./routes.js";

type ClaimStatus = "pending" | "confirmed" | "rejected" | "reverted";
const accountId = (value: unknown) => {
  const id = String(value ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    fail(400, "Choose a valid uploader account");
  return id;
};
const person = (value: string | null) => {
  if (!value) fail(403, "A personal account is required");
  return value as string;
};
const reviewer = (v: Viewer) => admin(v) || v.role === "hr";
const CLIENT_EVIDENCE = `(
  lower(coalesce(a.purpose,'')) like '%client%'
  or lower(coalesce(a.purpose,'')) like 'workspace%'
  or exists(select 1 from pulse.contact_profile cp
    where cp.org_id=a.org_id and lower(btrim(cp.email))=lower(btrim(a.handle)))
  or exists(select 1 from pulse.client cl
    left join pulse.party_org po on po.org_id=cl.org_id and po.id=cl.party_org_id
    where cl.org_id=a.org_id and (
      lower(split_part(a.handle,'@',2))=any(
        select lower(trim(both '@' from btrim(domains.email_domain)))
        from unnest(cl.email_domains) as domains(email_domain))
      or lower(split_part(a.handle,'@',2))=lower(trim(both '@' from btrim(po.domain)))
    ))
  or exists(select 1 from pulse.identity_link il
    left join pulse.person linked_person on il.entity_type='person'
      and linked_person.org_id=il.org_id and linked_person.id=il.entity_id
    where il.org_id=a.org_id and il.valid_to is null and (
      (il.entity_type='client' and (lower(coalesce(il.raw_value,''))=lower(a.handle)
        or lower(il.source_key) in (lower(a.handle),'google:'||lower(a.handle))))
      or (il.entity_type='person' and linked_person.side<>'staff'
        and (lower(coalesce(il.raw_value,''))=lower(a.handle)
          or lower(il.source_key) in (lower(a.handle),'google:'||lower(a.handle))))
      or (il.entity_type='account' and il.entity_id=a.id and il.source ilike '%client%')
    ))
)`;

function emptyBody(body: unknown) {
  if (body && (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length))
    fail(400, "This request does not accept fields");
}
function decisionBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "Choose confirmed or rejected");
  const value = body as Record<string, unknown>;
  if (value.decision !== "confirmed" && value.decision !== "rejected") fail(400, "Choose confirmed or rejected");
  let reason: string | null = null;
  if (value.reason !== undefined) {
    const candidate = value.reason;
    if (typeof candidate !== "string") fail(400, "Reason must be between 1 and 240 characters");
    reason = (candidate as string).trim();
    if (!reason || reason.length > 240) fail(400, "Reason must be between 1 and 240 characters");
  }
  if (Object.keys(value).some(key => key !== "decision" && key !== "reason")) fail(400, "Unknown decision field");
  return { decision: value.decision as "confirmed" | "rejected", reason };
}
async function access(c: PoolClient, org: string, viewer: string, subject: string | null, purpose: string) {
  await c.query(`insert into privacy.access_log(org_id,viewer_id,subject_person_id,resource,grain,purpose)
    values($1,$2,$3,'uploader.account_claim','account',$4)`, [org, viewer, subject, purpose]);
}
function accountClaimable(account: { isShared: boolean; holderPersonId: string | null; clientEvidence: boolean;
  hasDeliveries?: boolean; hasOtherPersonLink?: boolean }) {
  if (account.isShared) fail(409, "A shared account cannot be claimed");
  if (account.holderPersonId) fail(409, "This account is already linked to a person");
  if (account.clientEvidence) fail(409, "An account associated with a client cannot be claimed");
  if (account.hasOtherPersonLink) fail(409, "This account is linked to another person and needs review");
  if (account.hasDeliveries === false) fail(409, "This account has no deliveries in your work projects");
}

export function registerAccountClaimRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get("/v1/accounts/claimable", req => tx(req, async (c, v) => {
    const viewer = person(v.person);
    if (!(await c.query("select 1 from pulse.person where org_id=$1 and id=$2 and side='staff' and status='active'",
      [v.org, viewer])).rows[0]) fail(403, "Only active staff can view claimable uploader accounts");
    const accounts = (await c.query(`select a.id,a.handle,count(d.file_id)::int "deliveryCount",
        max(d.delivered_at) "lastDelivery"
      from pulse.account a join pulse.delivery d on d.org_id=a.org_id and d.uploader_account=a.handle
      where a.org_id=$1 and a.provider='google' and not a.is_shared and a.holder_person_id is null
        and d.project_id=any(pulse.work_projects())
        and not (${CLIENT_EVIDENCE})
        and not exists(select 1 from pulse.identity_link il where il.org_id=a.org_id
          and il.entity_type='person' and il.valid_to is null and il.entity_id<>$2
          and (lower(coalesce(il.raw_value,''))=lower(a.handle)
            or lower(il.source_key) in (lower(a.handle),'google:'||lower(a.handle))))
        and not exists(select 1 from pulse.account_claim claim where claim.org_id=a.org_id
          and claim.account_id=a.id and claim.status in ('pending','confirmed'))
      group by a.id,a.handle order by max(d.delivered_at) desc,a.handle limit 500`, [v.org, viewer])).rows;
    await access(c, v.org, viewer, null, "uploader_account_claimable_list");
    return { accounts };
  }));

  app.get<{ Querystring: { status?: ClaimStatus } }>("/v1/accounts/claims", req => tx(req, async (c, v) => {
    const viewer = person(v.person);
    const status = req.query.status;
    if (status && !["pending", "confirmed", "rejected", "reverted"].includes(status))
      fail(400, "Unknown claim status");
    const claims = (await c.query(`select claim.id,claim.account_id "accountId",account.handle,
        claim.person_id "personId",claim.status,claim.created_at "createdAt",
        claim.decided_by "decidedBy",claim.decided_at "decidedAt",claim.reason,
        claimant.display_name "personName"
      from pulse.account_claim claim
      join pulse.account account on account.org_id=claim.org_id and account.id=claim.account_id
      join pulse.person claimant on claimant.org_id=claim.org_id and claimant.id=claim.person_id
      where claim.org_id=$1 and (claim.person_id=$2
        or ($3::boolean and (pulse.viewer_is('admin','hr') or pulse.manages(claim.person_id))))
        and ($4::text is null or claim.status=$4)
      order by claim.created_at desc,claim.id limit 500`,
    [v.org, viewer, admin(v) || v.role === "hr" || manager(v), status ?? null])).rows;
    await access(c, v.org, viewer, viewer, "uploader_account_claim_read");
    for (const claim of claims as Array<{ personId: string }>) {
      if (claim.personId !== viewer)
        await access(c, v.org, viewer, claim.personId, "uploader_account_claim_review");
    }
    return { claims };
  }));

  app.post<{ Params: { id: string }; Body: Record<string, never> }>("/v1/accounts/:id/claim",
    { schema: { body: { type: "object", additionalProperties: false } } }, req => tx(req, async (c, v) => {
      const viewer = person(v.person);
      emptyBody(req.body);
      if (!(await c.query("select 1 from pulse.person where org_id=$1 and id=$2 and side='staff' and status='active'",
        [v.org, viewer])).rows[0]) fail(403, "Only active staff can claim an uploader account");
      const id = accountId(req.params.id);
      const account = (await c.query(`select a.id,a.handle,a.is_shared "isShared",a.holder_person_id "holderPersonId",
          exists(select 1 from pulse.delivery d where d.org_id=a.org_id and d.uploader_account=a.handle
            and d.project_id=any(pulse.work_projects())) "hasDeliveries",${CLIENT_EVIDENCE} "clientEvidence",
          exists(select 1 from pulse.identity_link il where il.org_id=a.org_id and il.entity_type='person'
            and il.valid_to is null and il.entity_id<>$3
            and (lower(coalesce(il.raw_value,''))=lower(a.handle)
              or lower(il.source_key) in (lower(a.handle),'google:'||lower(a.handle)))) "hasOtherPersonLink"
        from pulse.account a where a.org_id=$1 and a.id=$2 and a.provider='google'`,
      [v.org, id, viewer])).rows[0];
      if (!account) fail(404, "Uploader account not found");
      accountClaimable(account);
      const claim = (await c.query(`insert into pulse.account_claim(org_id,account_id,person_id)
        values($1,$2,$3) on conflict do nothing
        returning id,account_id "accountId",person_id "personId",status,created_at "createdAt",
          decided_by "decidedBy",decided_at "decidedAt"`, [v.org, id, viewer])).rows[0];
      if (!claim) fail(409, "This account already has an active claim");
      await c.query("select pulse.audit_write('account_claim.pending','uploader.account_claim',$1,array['status'])", [claim.id]);
      await access(c, v.org, viewer, viewer, "uploader_account_claim");
      return { ...claim, handle: account.handle };
    }));

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/v1/accounts/:id/claim/decide",
    { schema: { body: { type: "object", additionalProperties: false, properties: {
      decision: { type: "string", enum: ["confirmed", "rejected"] }, reason: { type: "string", minLength: 1, maxLength: 240 },
    } } } }, req => tx(req, async (c, v) => {
      const actor = person(v.person);
      const id = accountId(req.params.id);
      const visibleClaim = (await c.query(`select person_id "personId" from pulse.account_claim
        where org_id=$1 and account_id=$2 and status='pending'`, [v.org, id])).rows[0];
      if (!visibleClaim) fail(404, "Pending account claim was not found");
      if (visibleClaim.personId === actor) fail(403, "You cannot decide your own account claim");
      const claim = (await c.query(`select claim.id,claim.person_id "personId",a.handle,
          a.is_shared "isShared",a.holder_person_id "holderPersonId",
          exists(select 1 from pulse.delivery d where d.org_id=a.org_id and d.uploader_account=a.handle
            and d.project_id=any(pulse.work_projects())) "hasDeliveries",${CLIENT_EVIDENCE} "clientEvidence",
          exists(select 1 from pulse.identity_link il where il.org_id=a.org_id and il.entity_type='person'
            and il.valid_to is null and il.entity_id<>claim.person_id
            and (lower(coalesce(il.raw_value,''))=lower(a.handle)
              or lower(il.source_key) in (lower(a.handle),'google:'||lower(a.handle)))) "hasOtherPersonLink"
        from pulse.account_claim claim join pulse.account a
          on a.org_id=claim.org_id and a.id=claim.account_id
        where claim.org_id=$1 and a.id=$2 and claim.status='pending'
        for update of claim`, [v.org, id])).rows[0];
      if (!claim) fail(404, "Pending account claim was not found");
      if (claim.personId === actor) fail(403, "You cannot decide your own account claim");
      if (!reviewer(v) && !((await c.query("select pulse.manages($1) ok", [claim.personId])).rows[0]?.ok))
        fail(403, "Only an admin, HR, or the claimant's manager can decide this claim");
      const { decision, reason } = decisionBody(req.body);
      if (decision === "confirmed") accountClaimable(claim);
      const result = (await c.query(`update pulse.account_claim set status=$3,decided_by=$4,decided_at=now(),reason=$5
        where org_id=$1 and id=$2 and status='pending'
        returning id,account_id "accountId",person_id "personId",status,created_at "createdAt",
          decided_by "decidedBy",decided_at "decidedAt",reason`,
      [v.org, claim.id, decision, actor, reason])).rows[0];
      if (!result) fail(409, "This claim has already been decided");
      if (decision === "confirmed") {
        const key = `google:${claim.handle}`;
        await c.query(`insert into pulse.identity_link(org_id,entity_type,entity_id,source,source_key,raw_value,
            method,confidence,valid_from,evidence,confirmed_by,confirmed_at)
          values($1,'person',$2,'account_claim',$3,$4,'manual',1,now(),'{}',$5,now())`,
        [v.org, claim.personId, key, claim.handle, actor]);
        const linked = await c.query(`update pulse.account set holder_person_id=$1
          where org_id=$2 and id=$3 and holder_person_id is null and not is_shared returning id`,
          [claim.personId, v.org, id]);
        if (!linked.rows[0]) fail(409, "The account changed before it could be linked");
      }
      await c.query("select pulse.audit_write($1,'uploader.account_claim',$2,array['status'])",
        [`account_claim.${decision}`, result.id]);
      await access(c, v.org, actor, claim.personId, "uploader_account_claim_review");
      return result;
    }));

  app.post<{ Params: { id: string }; Body: Record<string, never> }>("/v1/accounts/:id/claim/revert",
    { schema: { body: { type: "object", additionalProperties: false } } }, req => tx(req, async (c, v) => {
      const actor = person(v.person);
      emptyBody(req.body);
      const id = accountId(req.params.id);
      const claim = (await c.query(`select claim.id,claim.person_id "personId",account.handle,
          account.holder_person_id "holderPersonId",account.is_shared "isShared"
        from pulse.account_claim claim join pulse.account account
          on account.org_id=claim.org_id and account.id=claim.account_id
        where claim.org_id=$1 and account.id=$2 and claim.status='confirmed'
        for update of claim`, [v.org, id])).rows[0];
      if (!claim) fail(404, "Confirmed account claim was not found");
      if (claim.personId === actor) fail(403, "You cannot reverse your own account claim");
      if (!reviewer(v) && !((await c.query("select pulse.manages($1) ok", [claim.personId])).rows[0]?.ok))
        fail(403, "Only an admin, HR, or the claimant's manager can reverse this claim");
      if (claim.isShared || claim.holderPersonId !== claim.personId)
        fail(409, "The account no longer matches this claim");
      const result = (await c.query(`update pulse.account_claim set status='reverted',decided_by=$3,decided_at=now()
        where org_id=$1 and id=$2 and status='confirmed'
        returning id,account_id "accountId",person_id "personId",status,created_at "createdAt",
          decided_by "decidedBy",decided_at "decidedAt",reason`, [v.org, claim.id, actor])).rows[0];
      if (!result) fail(409, "This claim has already changed");
      const key = `google:${claim.handle}`;
      await c.query(`update pulse.identity_link set valid_to=now()
        where org_id=$1 and entity_type='person' and source='account_claim' and source_key=$2
          and entity_id=$3 and valid_to is null`, [v.org, key, claim.personId]);
      const unlinked = await c.query(`update pulse.account set holder_person_id=null
        where org_id=$1 and id=$2 and holder_person_id=$3 returning id`, [v.org, id, claim.personId]);
      if (!unlinked.rows[0]) fail(409, "The account changed before it could be reverted");
      await c.query("select pulse.audit_write('account_claim.reverted','uploader.account_claim',$1,array['status'])",
        [result.id]);
      await access(c, v.org, actor, claim.personId, "uploader_account_claim_review");
      return result;
    }));
}
