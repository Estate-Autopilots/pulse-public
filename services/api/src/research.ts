import { ORG_TZ } from "./org-time.js";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail, leadership, work, type Tx, type Viewer } from "./routes.js";
import { growthDelta, shrunkCpl, shrunkRate } from "./research-model.js";
import { researchVersion, type ResponseCache } from "./response-cache.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ident = (x: unknown) =>
  UUID.test(String(x)) ? String(x) : fail(400, "Choose a valid record");
const rows = async (c: PoolClient, sql: string, params: unknown[] = []) =>
  (await c.query(sql, params)).rows;
async function provenance(c: PoolClient) {
  return rows(
    c,
    `select dataset,row_count n,source_as_of::text "asOf",imported_at::text "importedAt" from pulse.research_import order by dataset`,
  );
}
async function moneyAccess(c: PoolClient) {
  const p = (
    await c.query(
      "select pulse.money_can('money.read') and pulse.money_can('money.amount.read') ok,pulse.money_can('money.plan.write') write",
    )
  ).rows[0];
  if (!p.ok) fail(403, "Ad spend requires finance amount permission");
  return p;
}
const joins =
  "from pulse.lead l join pulse.lead_answer a on a.lead_id=l.id join pulse.lead_touch t on t.lead_id=l.id";
const final = "('visit_done','booked')",
  planned = "('visit_planned','visit_done','booked')";
async function leadData(c: PoolClient, keys: string[] | null) {
  const filter =
    "where l.kind='buyer' and ($1::text[] is null or a.project_key=any($1))";
  const summary = (
    await rows(
      c,
      `select count(*)::int leads,count(*) filter(where l.created_at is not null)::int dated,
  count(*) filter(where t.outcome is not null)::int noted,count(*) filter(where t.outcome='interested')::int interested,
  count(*) filter(where t.outcome in ${planned})::int "plannedPlus",count(*) filter(where t.outcome in ${final})::int visited,
  count(*) filter(where t.outcome='booked')::int booked,count(*) filter(where t.outcome='unreachable')::int unreachable,
  count(*) filter(where a.project_key is not null)::int mapped,min(l.created_at)::text first,max(l.created_at)::text last,
  count(*) filter(where l.created_at>=now()-interval '7 days')::int "last7",count(*) filter(where l.created_at at time zone ${ORG_TZ}>=date_trunc('day',now() at time zone ${ORG_TZ}))::int today
  ${joins} ${filter}`,
      [keys],
    )
  )[0];
  const daily = await rows(
    c,
    `select (l.created_at at time zone ${ORG_TZ})::date::text as day,count(*)::int n ${joins} ${filter} and l.created_at is not null group by 1 order by 1 desc limit 60`,
    [keys],
  );
  const creative = await rows(
    c,
    `select a.creative_type key,count(*)::int n,count(*) filter(where t.outcome is not null)::int noted,
  count(*) filter(where t.outcome in ${planned})::int visits ${joins} ${filter} group by 1 order by n desc`,
    [keys],
  );
  const prior = summary.noted ? summary.plannedPlus / summary.noted : 0;
  const hooks = await rows(
    c,
    `select coalesce(a.creative_no,'Unknown') key,count(*)::int n ${joins} ${filter} and a.creative_type='hook' group by 1 order by n desc limit 10`,
    [keys],
  );
  const languages = await rows(
    c,
    `select coalesce(a.language,'Not tagged') key,count(*)::int n ${joins} ${filter} group by 1 order by n desc`,
    [keys],
  );
  const platforms = await rows(
    c,
    `select coalesce(a.platform,'Not recorded') key,count(*)::int n ${joins} ${filter} group by 1 order by n desc`,
    [keys],
  );
  const intent = await rows(
    c,
    `select coalesce(a.visit_intent,'Not recorded') key,count(*)::int n ${joins} ${filter} group by 1 order by n desc`,
    [keys],
  );
  const touches = await rows(
    c,
    `select least(t.touches,5)::text key,count(*)::int n,count(*) filter(where t.outcome in ${planned})::int visits ${joins} ${filter} and t.outcome is not null group by 1 order by 1`,
    [keys],
  );
  const hours = await rows(
    c,
    `select extract(isodow from l.created_at at time zone ${ORG_TZ})::int dow,extract(hour from l.created_at at time zone ${ORG_TZ})::int as hour,count(*)::int n ${joins} ${filter} and l.created_at is not null group by 1,2`,
    [keys],
  );
  const budget = await rows(
    c,
    `select case when a.budget_lakh<25 then 'Below 25L' when a.budget_lakh<50 then '25–50L' when a.budget_lakh<100 then '50L–1Cr' else '1Cr or more' end key,count(*)::int n ${joins} ${filter} and a.budget_lakh is not null group by 1 order by 1`,
    [keys],
  );
  const queues = (
    await rows(
      c,
      `select count(*) filter(where t.touches=0)::int untouched,count(*) filter(where t.touches=1)::int "oneTouch",count(*) filter(where a.visit_intent='this_weekend')::int weekend,
  count(*) filter(where extract(hour from l.created_at at time zone ${ORG_TZ})>=22 or extract(hour from l.created_at at time zone ${ORG_TZ})<6)::int night
  ${joins} ${filter} and coalesce(t.outcome,'') not in ('visit_done','booked','invalid','not_interested','already_bought','broker')`,
      [keys],
    )
  )[0];
  return {
    summary,
    daily: daily.reverse(),
    creative: creative.map((x) => ({
      ...x,
      rate: shrunkRate(x.visits, x.noted, prior),
    })),
    hooks,
    languages,
    platforms,
    intent,
    touches,
    hours,
    budget,
    queues,
  };
}
export function registerResearchRoutes(
  app: FastifyInstance,
  { tx, cache }: { tx: Tx; cache: ResponseCache },
) {
  // Research figures come from imported datasets: once computed for a viewer they are reused until the next import
  // (or, as a backstop, for ten minutes, since "recent" counts are relative to today). Every read is still audited.
  const RESEARCH_TTL = 10 * 60_000;
  app.get("/api/v0/research", (req) =>
    tx(req, async (c, v) => {
      work(v);
      await c.query(
        "select pulse.audit_write('restricted_read','research.summary')",
      );
      return cache.through(v, req.url, await researchVersion(c), RESEARCH_TTL, async () => {
      const notices = await rows(
        c,
        `select kind,sum(occurrences)::int total,sum(occurrences) filter(where day>=current_date-7)::int recent,max(day)::text last from pulse.research_notice group by 1 order by total desc`,
      );
      const imports = await provenance(c);
      const coverage = (
        await rows(
          c,
          `select count(*)::int engagements,count(*) filter(where project_id is not null)::int linked from pulse.research_engagement`,
        )
      )[0];
      return {
        imports,
        notices,
        coverage,
        ...(await leadData(c, null)),
        generatedAt: new Date(),
        freshness:
          "Historical cleaned observations; no Meta API or CRM connection. Recent counts use today, not the source cutoff.",
      };
      });
    }),
  );
  app.get("/api/v0/projects/:id/research", (req) =>
    tx(req, async (c, v) => {
      work(v);
      const id = ident((req.params as { id: string }).id);
      const keys = (
        await rows(
          c,
          "select distinct project_key from pulse.research_engagement where project_id=$1",
          [id],
        )
      ).map((x) => x.project_key);
      if (
        !(await rows(c, "select id from pulse.project where id=$1", [id]))
          .length
      )
        fail(404, "Project not found");
      await c.query(
        "select pulse.audit_write('restricted_read','research.project',$1)",
        [id],
      );
      const canWrite = await canTouch(c, v, id);
      return {
        imports: await provenance(c),
        keys,
        canWrite,
        scope:
          "Development-wide: all engagement months with this cleaned project key. Sources do not identify an engagement for each lead.",
        ...(await leadData(c, keys)),
      };
    }),
  );
  app.get("/api/v0/projects/:id/calls", (req) =>
    tx(req, async (c, v) => {
      work(v);
      const id = ident((req.params as { id: string }).id);
      const canWrite = await canTouch(c, v, id);
      // Individual de-identified observations are limited to the responsible team; everyone can read aggregates.
      if (!canWrite)
        fail(403, "Call rows are for the assigned project team and leadership");
      const q = req.query as { queue?: string; page?: string };
      const queue = q.queue ?? "untouched";
      const condition: Record<string, string> = {
        untouched: "t.touches=0",
        oneTouch: "t.touches=1",
        weekend: "a.visit_intent='this_weekend'",
        night:
          `(extract(hour from l.created_at at time zone ${ORG_TZ})>=22 or extract(hour from l.created_at at time zone ${ORG_TZ})<6)`,
      };
      if (!condition[queue]) fail(400, "Choose a follow-up queue");
      const page = Math.max(0, Math.min(10000, Number(q.page) || 0));
      const keys = (
        await rows(
          c,
          "select distinct project_key from pulse.research_engagement where project_id=$1",
          [id],
        )
      ).map((x) => x.project_key);
      const where = `where l.kind='buyer' and a.project_key=any($1) and ${condition[queue]} and coalesce(t.outcome,'') not in ('visit_done','booked','invalid','not_interested','already_bought','broker')`;
      await c.query(
        "select pulse.audit_write('restricted_read','research.calls',$1)",
        [id],
      );
      const total = (
        await rows(c, `select count(*)::int n ${joins} ${where}`, [keys])
      )[0].n;
      const items = await rows(
        c,
        `select l.id,l.created_at::text created,t.touches,t.outcome,a.visit_intent intent,a.platform,a.sheet_ref "sheetRef",t.manual ${joins} ${where} order by l.created_at desc nulls last,l.id limit 50 offset $2`,
        [keys, page * 50],
      );
      return { rows: items, total, page, queue, canWrite };
    }),
  );
  app.post<{ Body: { projectId: string; touches: number; outcome: string } }>(
    "/api/v0/research/leads/:id/touch",
    (req) =>
      tx(req, async (c, v) => {
        work(v);
        if (!leadership(v) && !["pgs", "manager"].includes(v.role))
          fail(403, "Only the assigned project team can log calls");
        const id = ident((req.params as { id: string }).id),
          p = ident(req.body.projectId),
          b = req.body;
        if (!(await canTouch(c, v, p)))
          fail(403, "Only the assigned project team can log calls");
        const belongs = await rows(
          c,
          `select l.id from pulse.lead l join pulse.lead_answer a on a.lead_id=l.id where l.id=$1 and a.project_key in (select project_key from pulse.research_engagement where project_id=$2)`,
          [id, p],
        );
        if (!belongs.length) fail(404, "Lead is not in this development");
        if (
          !Number.isInteger(b.touches) ||
          b.touches < 0 ||
          b.touches > 1000 ||
          ![
            "booked",
            "visit_done",
            "visit_planned",
            "interested",
            "location_mismatch",
            "budget_mismatch",
            "not_interested",
            "already_bought",
            "broker",
            "invalid",
            "unreachable",
          ].includes(b.outcome)
        )
          fail(400, "Choose an outcome and a whole call count");
        // RLS checks the explicit linked engagement. A development-key-only observation is writable only by leadership.
        const updated = await rows(
          c,
          `update pulse.lead_touch set touches=$2,outcome=$3,manual=true,source='pulse',changed_by=$4,changed_at=now() where lead_id=$1 returning lead_id`,
          [id, b.touches, b.outcome, v.person],
        );
        if (!updated.length)
          fail(
            403,
            "This lead has no confirmed engagement assignment; leadership can correct it",
          );
        return { ok: true };
      }),
  );
  app.get("/api/v0/research/growth", (req) =>
    tx(req, async (c, v) => {
      if (!leadership(v)) fail(403, "Company growth is for leadership");
      const finance = (
        await rows(
          c,
          "select pulse.money_can('money.read') and pulse.money_can('money.amount.read') ok",
        )
      )[0].ok;
      await c.query(
        "select pulse.audit_write('restricted_read','research.growth')",
      );
      return cache.through(v, req.url, await researchVersion(c), RESEARCH_TTL, async () => {
      const growth = await rows(
        c,
        `with months as(select generate_series(date_trunc('month',now())-interval '13 months',date_trunc('month',now())-interval '1 month','1 month')::date as month),
   engagements as(select e.*,coalesce(p.start_month,e.month) effective_month,coalesce(p.client_id::text,e.client_key) client from pulse.research_engagement e left join pulse.project p on p.id=e.project_id),
   firsts as(select client,min(effective_month) first from engagements where client is not null group by 1)
   select m.month::text as month,(select count(*)::int from engagements e where e.effective_month=m.month) engagements,
   (select count(*)::int from firsts f where f.first=m.month) "newClients",
   (select count(distinct e.client)::int from engagements e where e.effective_month between m.month-interval '2 months' and m.month) "activeClients",
   (select count(*)::int from pulse.lead l where l.kind='buyer' and date_trunc('month',l.created_at at time zone ${ORG_TZ})=m.month) leads,
   (select coalesce(sum(n),0)::int from pulse.research_month r where r.month=m.month and r.kind='invoices') invoices,
   (select count(*)::int from pulse.lead l where l.kind='ea_own_funnel' and date_trunc('month',l.created_at at time zone ${ORG_TZ})=m.month) "ownLeads",
   (select coalesce(sum(n),0)::int from pulse.research_month r where r.month=m.month and r.kind='outbound_case_study_mails') outbound,
   (select coalesce(sum(n),0)::int from pulse.research_month r where r.month=m.month and r.kind='sales_replies_received') replies
   from months m order by m.month`,
      );
      if (finance) {
        const spend = await rows(
          c,
          "select date_trunc('month',day)::date::text as month,sum(amount)::float spend from pulse_priv.ad_funding where currency='INR' group by 1",
        );
        for (const g of growth)
          g.spend = spend.find((x) => x.month === g.month)?.spend ?? 0;
      }
      const deltas = Object.fromEntries(
        [
          "engagements",
          "newClients",
          "activeClients",
          "leads",
          "invoices",
          ...(finance ? ["spend"] : []),
        ].map((k) => [k, growthDelta(growth.map((g) => Number(g[k])))]),
      );
      const pipelineDeltas = Object.fromEntries(
        ["ownLeads", "outbound", "replies", "newClients", "invoices"].map(
          (k) => [k, growthDelta(growth.map((g) => Number(g[k])))],
        ),
      );
      return {
        imports: await provenance(c),
        growth,
        deltas,
        pipelineDeltas,
        alarm:
          Object.values(deltas).filter((x) => x !== null && x < -25).length >=
          3,
        finance,
        generatedAt: new Date(),
        window:
          "13 complete calendar months; last 3 vs previous 3. Missing source records count as zero observations, not zero business activity.",
      };
      });
    }),
  );
  app.get("/api/v0/money/ad-spend", (req) =>
    tx(req, async (c) => {
      const permissions = await moneyAccess(c);
      await c.query(
        "select pulse.audit_write('restricted_read','money.ad_spend')",
      );
      const totals = await rows(
        c,
        "select currency,count(*)::int n,sum(amount)::float amount,min(day)::text first,max(day)::text last from pulse_priv.ad_funding group by currency order by currency",
      );
      const months = await rows(
        c,
        "select date_trunc('month',day)::date::text as month,kind,currency,sum(amount)::float amount,count(*)::int n from pulse_priv.ad_funding group by 1,2,3 order by 1",
      );
      const accounts = await rows(
        c,
        `select a.account_id "accountId",a.name,a.project_key "projectKey",a.project_id "projectId",a.client_id "clientId",p.title "projectName",cl.display_name "clientName",a.manual,
   count(f.txn_key)::int receipts,count(distinct date_trunc('month',f.day))::int months,max(f.day)::text last,
   count(f.txn_key) filter(where f.currency='INR')::int "inrReceipts",coalesce(sum(f.amount) filter(where f.currency='INR'),0)::float amount,
   (select count(*)::int from pulse.research_notice n where n.account_ref=a.account_id and n.kind in ('ads_paused','low_funds','payment_declined')) alerts
   from pulse_priv.ad_account a left join pulse_priv.ad_funding f using(org_id,account_id) left join pulse.project p on p.id=a.project_id left join pulse.client cl on cl.id=a.client_id
   group by a.org_id,a.account_id,p.title,cl.display_name order by (a.project_key is null and a.client_id is null) desc,amount desc`,
      );
      const cpl = await rows(
        c,
        `with spend as(select a.project_key,sum(f.amount)::float spend,array_agg(distinct to_char(f.day,'YYYY-MM')) months from pulse_priv.ad_account a join pulse_priv.ad_funding f using(org_id,account_id) where f.currency='INR' and a.project_key is not null group by 1),
   lead as(select s.project_key,s.spend,count(*)::int leads,count(*) filter(where t.outcome is not null)::int noted,count(*) filter(where t.outcome in ${final})::int visits,count(*) filter(where t.outcome in ${planned})::int planned
    from spend s join pulse.lead_answer a on a.project_key=s.project_key join pulse.lead l on l.id=a.lead_id join pulse.lead_touch t on t.lead_id=l.id
    where l.kind='buyer' and to_char(l.created_at at time zone ${ORG_TZ},'YYYY-MM')=any(s.months) group by 1,2)
   select l.*,l.spend/l.leads cpl,(select coalesce(p.segment,e.segment) from pulse.research_engagement e left join pulse.project p on p.id=e.project_id where e.project_key=l.project_key order by e.month desc limit 1) segment,
    (select project_id from pulse.research_engagement e where e.project_key=l.project_key and project_id is not null order by month desc limit 1) "projectId"
    from lead l where spend>=5000 and leads>=50 order by cpl`,
      );
      const benchmark =
        cpl.reduce((n, x) => n + x.spend, 0) /
        Math.max(
          1,
          cpl.reduce((n, x) => n + x.leads, 0),
        );
      const prior =
        cpl.reduce((n, x) => n + x.planned, 0) /
        Math.max(
          1,
          cpl.reduce((n, x) => n + x.noted, 0),
        );
      const segments = Object.values(
        cpl.reduce<
          Record<
            string,
            { key: string; spend: number; leads: number; n: number }
          >
        >((a, x) => {
          const s = (a[x.segment] ??= {
            key: x.segment,
            spend: 0,
            leads: 0,
            n: 0,
          });
          s.spend += x.spend;
          s.leads += x.leads;
          s.n++;
          return a;
        }, {}),
      ).map((s) => ({ ...s, cpl: s.spend / s.leads }));
      const projects = await rows(
        c,
        "select id,title name from pulse.project order by title",
      );
      const clients = await rows(
        c,
        "select id,display_name name from pulse.client order by display_name",
      );
      return {
        permissions,
        imports: await provenance(c),
        totals,
        months,
        accounts,
        projects,
        clients,
        segments,
        benchmark,
        cpl: cpl.map((x) => ({
          ...x,
          estimate: shrunkCpl(x.spend, x.leads, benchmark),
          rate: shrunkRate(x.planned, x.noted, prior),
          visitCost: x.visits ? x.spend / x.visits : null,
        })),
        disclaimer:
          "Receipt-derived ad payments, not platform delivery spend or reconciled bank outflows. INR and QAR stay separate. Account balances and daily delivery spend are unknown; runway is not estimated.",
      };
    }),
  );
  app.post<{
    Body: { accountId: string; projectId?: string; clientId?: string };
  }>("/api/v0/money/ad-account", (req) =>
    tx(req, async (c, v) => {
      const p = await moneyAccess(c);
      if (!p.write) fail(403, "Finance edit permission is required");
      const b = req.body;
      if (typeof b.accountId !== "string" || b.accountId.length > 80)
        fail(400, "Choose an account");
      const pid = b.projectId ? ident(b.projectId) : null,
        cid = b.clientId ? ident(b.clientId) : null;
      const project = pid
        ? (
            await rows(
              c,
              `select p.client_id,(select e.project_key from pulse.research_engagement e where e.project_id=p.id limit 1) key from pulse.project p where p.id=$1`,
              [pid],
            )
          )[0]
        : null;
      if (pid && !project) fail(404, "Project unavailable");
      if (
        cid &&
        !(await rows(c, "select id from pulse.client where id=$1", [cid]))
          .length
      )
        fail(404, "Client unavailable");
      if (pid && cid && project.client_id && project.client_id !== cid)
        fail(400, "Selected client differs from the project client");
      const result = await rows(
        c,
        `update pulse_priv.ad_account set project_id=$2,client_id=$3,project_key=$4,manual=true,mapped_by=$5,mapped_at=now(),match_method='manual',confidence=1 where account_id=$1 returning account_id`,
        [
          b.accountId,
          pid,
          cid ?? project?.client_id ?? null,
          project?.key ?? null,
          v.person,
        ],
      );
      if (!result.length) fail(404, "Account unavailable");
      return { ok: true };
    }),
  );
  app.get("/api/v0/research/clients", (req) =>
    tx(req, async (c, v) => {
      work(v);
      const items = await rows(
        c,
        `select c.id,c.display_name name,c.client_type type,count(p.id)::int engagements,max(p.start_month)::text last,
   extract(year from age(current_date,max(p.start_month)))*12+extract(month from age(current_date,max(p.start_month)))::int gap
   from pulse.client c join pulse.project p on p.client_id=c.id group by c.id order by max(p.start_month) desc`,
      );
      return {
        items: items.map((x) => ({
          ...x,
          health:
            x.gap < 2
              ? "active"
              : x.engagements > 1 && x.gap < 3
                ? "due"
                : x.gap < 6
                  ? "at risk"
                  : "lapsed",
        })),
        rule: "Observed engagement recency: active <2 months; repeat clients due at 2 months; at risk at 3–5 months; lapsed at 6+. No fitted churn probability or revenue ranking.",
      };
    }),
  );
}
async function canTouch(c: PoolClient, v: Viewer, id: string) {
  return (
    leadership(v) ||
    (["pgs", "manager"].includes(v.role) &&
      (await rows(c, "select $1::uuid=any(pulse.work_projects()) ok", [id]))[0]
        .ok)
  );
}
