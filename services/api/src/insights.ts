import { ORG_TZ } from "./org-time.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { leadership, fail, work, type Tx, type Viewer } from "./routes.js";
import { syncVersion, type ResponseCache } from "./response-cache.js";
import { attendanceEnabled } from "./attendance-policy.js";

type Period = { from: string; to: string; today: string; start: Date; end: Date };
type Deps = { tx: Tx; period: (c: PoolClient, req: FastifyRequest) => Promise<Period & Record<string, unknown>>; publicPeriod: (p: never) => unknown; cache: ResponseCache };

// What a delivery is, read from its file name. EA names files by the hook or shot they carry; nothing else records it.
const CREATIVE = `case
  when f.mime like 'image/%' then 'Static'
  when f.name ~* 'no[ _-]*hook' then 'Main film'
  when f.name ~* 'hook' then 'Hook variation'
  when f.name ~* 'drone' then 'Drone'
  when f.name ~* 'sample[ _-]*flat|walk[ _-]*through|flat[ _-]*tour' then 'Sample flat'
  when f.name ~* 'testimonial' then 'Testimonial'
  when f.name ~* 'reel|short' then 'Reel'
  else 'Other video' end`;

/** Company-wide figures behind the dashboard and the leadership page. Counts only; never salary or contact data. */
export function registerInsightRoutes(app: FastifyInstance, { tx, period, publicPeriod, cache }: Deps) {
  // Company-wide figures are reused for a minute per viewer unless the index ran or something was written in between.
  app.get("/api/v0/insights", req => tx(req, async (c, v: Viewer) => {
    work(v); if (!leadership(v)) fail(403, "This view is for organisation admins");
    const enabled = await attendanceEnabled(c);
    return cache.through(v, req.url, `${await syncVersion(c)}|attendance:${enabled}`, 60_000, async () => {
    const p = await period(c, req);
    const anchor = new Date(Math.min(Date.now(), p.end.getTime()));
    const anchorDay = p.from > p.today ? p.today : p.to < p.today ? p.to : p.today;
    const rows = async <T>(sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows as T[];

    // Each delivery is placed in its company-time week once, then the twelve weeks are joined on that key: the planner sees a
    // small equality join instead of a range join it estimates at 169,000 rows (which also used to trigger JIT).
    const weeks = await rows(`with placed as (
        select date_trunc('week',d.delivered_at at time zone ${ORG_TZ}) w,d.file_id,d.kind,d.project_id,p.client_id,f.mime,
          (select count(*) from pulse.index_version iv where iv.org_id=d.org_id and iv.file_id=d.file_id) > 1 revised
        from pulse.delivery d left join pulse.index_file f on f.org_id=d.org_id and f.file_id=d.file_id left join pulse.project p on p.id=d.project_id
        where d.delivered_at >= (date_trunc('week',$1::date::timestamp) - interval '77 days') at time zone ${ORG_TZ}
          and d.delivered_at < (date_trunc('week',$1::date::timestamp) + interval '7 days') at time zone ${ORG_TZ})
      select to_char(wk.w,'IYYY-"W"IW') week,wk.w::date::text "start",count(d.file_id)::int deliveries,
      count(*) filter(where d.kind='final')::int finals,count(*) filter(where d.kind='draft')::int drafts,
      count(distinct d.project_id)::int projects,count(distinct d.client_id)::int clients,
      count(*) filter(where d.mime like 'video/%')::int videos,count(*) filter(where d.mime like 'image/%')::int images,
      count(*) filter(where d.revised)::int revised
      from generate_series(date_trunc('week',$1::date::timestamp) - interval '77 days',date_trunc('week',$1::date::timestamp),interval '7 days') wk(w)
      left join placed d on d.w=wk.w
      group by wk.w order by wk.w`, [anchorDay]);

    // The eight weeks up to the end of the period: one week is too few files to read a mix from.
    const recent = `d.delivered_at >= $1::timestamptz - interval '56 days' and d.delivered_at < $1`;
    const mix = await rows(`select ${CREATIVE} "type",count(*)::int count,
      count(*) filter(where d.delivered_at >= $2 and d.delivered_at < $3)::int "inPeriod"
      from pulse.delivery d join pulse.index_file f using(org_id,file_id) where ${recent} group by 1 order by 2 desc`, [anchor, p.start, p.end]);
    const segments = await rows(`select coalesce(nullif(btrim(p.segment),''),'Not set') segment,count(*)::int count,count(distinct p.id)::int projects
      from pulse.delivery d join pulse.project p on p.id=d.project_id where ${recent} group by 1 order by 2 desc limit 7`, [anchor]);
    const clients = await rows(`select cl.id "clientId",coalesce(cl.display_name,'No client set') name,cl.client_type "type",count(*)::int count,
      count(*) filter(where d.delivered_at >= $2 and d.delivered_at < $3)::int "inPeriod",
      count(distinct d.project_id)::int projects,max(d.delivered_at) "lastDeliveredAt"
      from pulse.delivery d join pulse.project p on p.id=d.project_id left join pulse.client cl on cl.id=p.client_id
      where ${recent} group by cl.id order by 4 desc,7 desc`, [anchor, p.start, p.end]);
    const locations = await rows(`select coalesce(nullif(btrim(p.location),''),'Not set') location,count(*)::int count,count(distinct p.id)::int projects
      from pulse.delivery d join pulse.project p on p.id=d.project_id where ${recent} group by 1 order by 2 desc limit 7`, [anchor]);
    const portfolio = (await rows<Record<string, number>>(`select count(*)::int clients,
      count(*) filter(where client_type='developer')::int developers,count(*) filter(where client_type='channel_partner')::int partners,
      count(*) filter(where client_type not in ('developer','channel_partner'))::int untyped,
      (select count(*)::int from pulse.project) projects,(select count(*)::int from pulse.project where client_id is null and kind='client_work') "projectsNoClient",
      (select count(distinct p.client_id)::int from pulse.delivery d join pulse.project p on p.id=d.project_id where ${recent}) "activeClients",
      (select count(distinct p.client_id)::int from pulse.delivery d join pulse.project p on p.id=d.project_id
        where d.delivered_at >= $1::timestamptz - interval '112 days' and d.delivered_at < $1::timestamptz - interval '56 days') "activeClientsBefore"
      from pulse.client`, [anchor]))[0];
    // Where every project stands today, by its last delivery: one pass over deliveries grouped by project, instead of
    // one scan of all deliveries per project (and the planner ran that scan four times, once per count).
    const stages = (await rows<Record<string, number>>(`select
      count(*) filter(where last >= $1::timestamptz - interval '14 days')::int delivering,
      count(*) filter(where last < $1::timestamptz - interval '14 days' and last >= $1::timestamptz - interval '56 days')::int quiet,
      count(*) filter(where last < $1::timestamptz - interval '56 days')::int dormant,
      count(*) filter(where last is null)::int "noDeliveries"
      from pulse.project p left join (select project_id,max(delivered_at) last from pulse.delivery where delivered_at < $1 group by project_id) l on l.project_id=p.id`, [anchor]))[0];
    const quiet = await rows<Record<string, unknown>>(`select p.id "projectId",p.name "projectName",coalesce(p.title,p.name) title,cl.display_name "clientName",max(d.delivered_at) "lastDeliveredAt",
      count(*) filter(where d.delivered_at >= $1::timestamptz - interval '56 days')::int recent,count(*) over()::int total
      from pulse.delivery d join pulse.project p on p.id=d.project_id left join pulse.client cl on cl.id=p.client_id
      where d.delivered_at < $1 group by p.id,cl.display_name
      having max(d.delivered_at) < $1::timestamptz - interval '14 days' and max(d.delivered_at) >= $1::timestamptz - interval '56 days'
      order by recent desc,max(d.delivered_at) desc limit 12`, [anchor]);

    // People: who is on the team, who can sign in, and how much of the work can be credited to a person.
    const staff = `pulse.person pe left join pulse.people_profile pp on pp.person_id=pe.id where pe.status='active' and pe.side='staff'`;
    const signIn = `(exists(select 1 from pulse.account a where a.holder_person_id=pe.id and a.provider='google' and a.purpose like 'Workspace%')
      or exists(select 1 from pulse.login_credential lc where lc.person_id=pe.id and lc.status='active'))`;
    const today = `exists(select 1 from pulse.attendance_entry e where e.person_id=pe.id and e.work_date=$1::date)`;
    const away = `exists(select 1 from pulse.leave_request l where l.person_id=pe.id and l.status='approved' and $1::date between l.from_date and l.to_date)`;
    const pods = await rows(`select coalesce(pp.pod,'No pod') pod,count(*)::int people,case when $3::boolean then count(*) filter(where ${today})::int end "inToday",
      count(*) filter(where ${away})::int "onLeave",count(*) filter(where ${signIn})::int "canSignIn",
      (select count(*)::int from pulse.project pr join pulse.unit u on u.id=pr.unit_id where u.name=pp.pod) projects,
      (select count(*)::int from pulse.delivery d join pulse.project pr on pr.id=d.project_id join pulse.unit u on u.id=pr.unit_id
        where u.name=pp.pod and d.delivered_at >= $2::timestamptz - interval '56 days' and d.delivered_at < $2) deliveries,
      array_agg(distinct pp.department) filter(where pp.department is not null) teams
      from ${staff} group by pp.pod order by pp.pod nulls last`, [p.today, anchor, enabled]);
    const teams = await rows(`select coalesce(pp.department,'No team') team,count(*)::int people,case when $2::boolean then count(*) filter(where ${today})::int end "inToday",
      count(*) filter(where ${away})::int "onLeave",array_agg(distinct pp.pod) filter(where pp.pod is not null) pods
      from ${staff} group by pp.department order by 2 desc,1`, [p.today, enabled]);
    const people = (await rows<Record<string, number>>(`select count(*)::int headcount,count(*) filter(where ${signIn})::int "canSignIn",
      count(*) filter(where pp.manager_id is not null)::int "withManager",count(*) filter(where pp.pod is null)::int "noPod",
      count(*) filter(where pp.department is null)::int "noTeam",case when $2::boolean then count(*) filter(where ${today})::int end "inToday",count(*) filter(where ${away})::int "onLeave",
      count(*) filter(where exists(select 1 from pulse.account a where a.holder_person_id=pe.id and not a.is_shared
        and a.handle in (select uploader_account from pulse.delivery)))::int credited
      from ${staff}`, [p.today, enabled]))[0];
    people.ai = (await rows<Record<string, number>>("select pulse.agent_count() ai"))[0].ai;
    const attendance = enabled ? await rows(`select g::date::text "day",extract(isodow from g)::int dow,
      count(distinct e.person_id)::int "in",count(distinct e.person_id) filter(where e.mode='wfh')::int home,
      count(distinct e.person_id) filter(where e.late_minutes > 0)::int late,
      (select count(distinct l.person_id)::int from pulse.leave_request l where l.status='approved' and g::date between l.from_date and l.to_date) leave,
      exists(select 1 from pulse.holiday h where h.day=g::date) holiday
      from generate_series($1::date::timestamp - interval '13 days',$1::date::timestamp,interval '1 day') g
      left join pulse.attendance_entry e on e.work_date=g::date group by g order by g`, [p.today]).catch(() => []) : [];
    const hrQueue = (await rows<Record<string, number>>(`select
      (select count(*)::int from pulse.leave_request where status='pending') leave,
      case when $1::boolean then (select count(*)::int from pulse.attendance_regularisation where status='pending') end corrections`, [enabled]))[0];

    // How deliveries reach Pulse: through which login, and whether that login is one person.
    const accounts = await rows(`select coalesce(d.uploader_account,'unknown') account,coalesce(a.is_shared,false) shared,a.purpose,
      pe.id "personId",pe.display_name person,count(*)::int total,count(*) filter(where ${recent})::int recent,
      count(*) filter(where d.delivered_at >= $2 and d.delivered_at < $3)::int "inPeriod",max(d.delivered_at) "lastDelivery"
      from pulse.delivery d left join pulse.account a on a.provider='google' and a.handle=d.uploader_account
      left join pulse.person pe on pe.id=a.holder_person_id
      group by d.uploader_account,a.is_shared,a.purpose,pe.id order by recent desc,total desc`, [anchor, p.start, p.end]) as
      { account: string; shared: boolean; personId: string | null; total: number; recent: number }[];
    const sum = (list: typeof accounts, key: "recent" | "total") => list.reduce((n, a) => n + a[key], 0);
    const identity = { recent: sum(accounts, "recent"), total: sum(accounts, "total"),
      shared: sum(accounts.filter(a => a.shared), "recent"), sharedTotal: sum(accounts.filter(a => a.shared), "total"),
      credited: sum(accounts.filter(a => !a.shared && a.personId), "recent"),
      unlinked: sum(accounts.filter(a => !a.shared && !a.personId), "recent"),
      sharedLogins: accounts.filter(a => a.shared).length, unlinkedAccounts: accounts.filter(a => !a.shared && !a.personId).length };

    return { attendanceEnabled: enabled, period: publicPeriod(p as never), generatedAt: new Date(), weeks, mix, segments, clients: clients.slice(0, 10),
      clientCount: clients.length, locations, portfolio, stages, quiet: quiet.map(({ total: _t, ...q }) => q),
      quietTotal: Number(quiet[0]?.total ?? 0), pods, teams, people, attendance, hrQueue, accounts, identity };
    });
  }));
}
