-- migrate:up
-- WA-NATIVE (owner, 25 Oct 2026: "what did you find out after analysing the data — patterns, workflows, SOPs? … it
-- doesn't feel intelligent"): what the imported WhatsApp groups say about how the company runs a client, as one read
-- for leadership and admins (Insights → Client operations), and per client on the client's page.
--  * pulse.wa_company_insights(): the service path and its timings, who waits for whom (working-hours answer times,
--    when clients write), what clients ask (intents and topics of their messages; their first week), where it goes
--    wrong (signals by kind and the groups they are in, the team's funds requests, the clients at churn risk with their
--    reasons) and the onboarding SOP against what the chats show. Built from 1015/1016 (wa_message, wa_message_signal,
--    wa_response, wa_signal, wa_chat_stage, wa_insight) and kept for six hours (pulse_priv.wa_insights_cache): counts,
--    medians and client names only, never message text.
--  * pulse.wa_client_health(client): the client's health, churn risk and why, groups waiting on us (a client-side
--    person wrote last, nobody from the team since), the latest sentiment and recent signals: leadership and admins.
--  * pulse.wa_insight_action: what a leader did with a recommendation (a task made, an SOP change proposed), so the page
--    shows it done and links to it. Written through wa_insight_action_add (leadership and admins).
-- Additive: new tables and functions only. Nothing names a company or a zone (the company's own zone is used).

create table pulse_priv.wa_insights_cache (
 org_id uuid primary key references pulse.org(id),
 computed_at timestamptz not null default now(),
 data jsonb not null check (jsonb_typeof(data) = 'object')
);
alter table pulse_priv.wa_insights_cache enable row level security;
alter table pulse_priv.wa_insights_cache force row level security;
create policy tenant on pulse_priv.wa_insights_cache using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on pulse_priv.wa_insights_cache from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy;

create table pulse.wa_insight_action (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 rec text not null check (rec ~ '^[a-z0-9_-]{2,40}$'),      -- which recommendation
 kind text not null check (kind in ('task', 'sop')),
 ref uuid not null,                                          -- the task or the SOP made
 created_by uuid references pulse.person(id),
 created_at timestamptz not null default now(),
 unique (org_id, rec, kind)
);
alter table pulse.wa_insight_action enable row level security;
alter table pulse.wa_insight_action force row level security;
create policy tenant_isolation on pulse.wa_insight_action using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy leaders_read on pulse.wa_insight_action as restrictive for select to pulse_api using (pulse.viewer_is('admin', 'leadership'));
grant select on pulse.wa_insight_action to pulse_api;
create trigger audit_mutation after insert or update or delete on pulse.wa_insight_action for each row execute function pulse.audit_mutation();

-- The company read (computed at most every six hours; p_fresh recomputes now).
create function pulse.wa_company_insights(p_fresh boolean default false) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare d jsonb; c pulse_priv.wa_insights_cache%rowtype; tz text := org_time_zone();
begin
 if not viewer_is('admin', 'leadership') then return null; end if;
 select * into c from pulse_priv.wa_insights_cache where org_id = current_org();
 if found and not p_fresh and c.computed_at > now() - interval '6 hours'
    and c.computed_at >= coalesce((select max(as_of) from pulse_priv.wa_insight where org_id = current_org()), '-infinity') then
  return c.data || jsonb_build_object('actions', wa_insight_actions());
 end if;
 with chats as (select * from pulse_priv.wa_chat where org_id = current_org()),
 side as (select pa.id, case when pa.kind = 'colleague' then 'team' when pa.kind in ('client', 'contact', 'number') then 'client' else 'unknown' end side
            from pulse_priv.wa_participant pa where pa.org_id = current_org()),
 msgs as (select m.id, m.chat_id, m.sent_at, m.local_time, m.kind, m.media_type, s.side
            from pulse_priv.wa_message m join side s on s.id = m.participant_id where m.org_id = current_org()),
 chatm as (select i.subject_id chat_id, i.metrics from pulse_priv.wa_insight i where i.org_id = current_org() and i.subject = 'chat'),
 med as (select percentile_cont(0.5) within group (order by (metrics->>'days_start_to_live')::numeric) filter (where metrics->>'days_start_to_live' is not null) start_live,
                percentile_cont(0.5) within group (order by (metrics->>'days_brief_to_creative')::numeric) filter (where metrics->>'days_brief_to_creative' is not null) brief_creative,
                percentile_cont(0.5) within group (order by (metrics->>'days_creative_to_approval')::numeric) filter (where metrics->>'days_creative_to_approval' is not null) creative_approval,
                percentile_cont(0.5) within group (order by (metrics->>'days_approval_to_live')::numeric) filter (where metrics->>'days_approval_to_live' is not null) approval_live,
                percentile_cont(0.5) within group (order by (metrics->>'days_live_to_payment')::numeric) filter (where metrics->>'days_live_to_payment' is not null) live_payment,
                percentile_cont(0.5) within group (order by (metrics->>'revisions')::numeric) filter (where metrics->>'revisions' is not null) revisions,
                percentile_cont(0.5) within group (order by (metrics->>'messages')::numeric) filter (where metrics->>'messages' is not null) messages
           from chatm)
 select jsonb_build_object(
  'computedAt', now(),
  'groups', (select count(*) from chats), 'messages', (select coalesce(sum(messages), 0) from chats),
  'clients', (select count(distinct client_id) from chats where client_id is not null),
  'from', (select min(first_at) from chats), 'to', (select max(last_at) from chats),
  'native', (select count(*) from pulse_priv.wa_native where org_id = current_org()),
  'path', jsonb_build_object(
    'top', (select i.metrics->'top_sequences' from pulse_priv.wa_insight i where i.org_id = current_org() and i.subject = 'company' limit 1),
    'stages', (select coalesce(jsonb_agg(jsonb_build_object('stage', x.stage, 'groups', x.n, 'day', round(x.d::numeric, 1)) order by x.d), '[]') from (
        select s.stage, count(*) n, percentile_cont(0.5) within group (order by extract(epoch from s.first_at - ch.first_at) / 86400) d
          from pulse_priv.wa_chat_stage s join chats ch on ch.id = s.chat_id where s.org_id = current_org() and s.stage <> 'quiet' group by 1) x),
    'days', (select jsonb_build_object('startToLive', round(start_live::numeric, 1), 'briefToCreative', round(brief_creative::numeric, 1),
        'creativeToApproval', round(creative_approval::numeric, 1), 'approvalToLive', round(approval_live::numeric, 1), 'liveToPayment', round(live_payment::numeric, 1),
        'revisions', round(revisions::numeric), 'messages', round(messages::numeric)) from med)),
  'waits', jsonb_build_object(
    'sides', (select coalesce(jsonb_object_agg(r.responder_side, jsonb_build_object('answers', r.n, 'medianMinutes', round(r.med::numeric, 1), 'p90Hours', round(r.p90::numeric, 1),
        'wallMinutes', round(r.wall::numeric))), '{}') from (
        select responder_side, count(*) n, percentile_cont(0.5) within group (order by working_s) / 60 med, percentile_cont(0.9) within group (order by working_s) / 3600 p90,
               percentile_cont(0.5) within group (order by waited_s) / 60 wall
          from pulse_priv.wa_response where org_id = current_org() group by 1) r),
    'teamAfterHours', (select round(avg(case when substr(local_time, 12, 2)::int < 10 or substr(local_time, 12, 2)::int >= 19
          or extract(isodow from left(local_time, 10)::date) = 7 then 1 else 0 end)::numeric, 3) from msgs where side = 'team'),
    'clientByHour', (select jsonb_agg(coalesce(h.n, 0) order by g.h) from generate_series(0, 23) g(h)
        left join (select substr(local_time, 12, 2)::int hr, count(*) n from msgs where side = 'client' group by 1) h on h.hr = g.h),
    'clientByWeekday', (select jsonb_agg(coalesce(w.n, 0) order by g.d) from generate_series(1, 7) g(d)
        left join (select extract(isodow from left(local_time, 10)::date)::int dw, count(*) n from msgs where side = 'client' group by 1) w on w.dw = g.d),
    'voiceShare', (select jsonb_object_agg(side, round(v::numeric, 3)) from (select side, avg(case when media_type in ('voice', 'audio') then 1 else 0 end) v
        from msgs where side in ('team', 'client') group by 1) x)),
  'asks', jsonb_build_object(
    'intents', (select coalesce(jsonb_agg(jsonb_build_object('intent', x.intent, 'n', x.n) order by x.n desc), '[]') from (
        select s.intent, count(*) n from pulse_priv.wa_message_signal s join msgs m on m.id = s.message_id where s.org_id = current_org() and m.side = 'client'
         and s.intent not in ('other', 'greeting') group by 1) x),
    'topics', (select coalesce(jsonb_agg(jsonb_build_object('topic', x.t, 'n', x.n) order by x.n desc), '[]') from (
        select t, count(*) n from pulse_priv.wa_message_signal s join msgs m on m.id = s.message_id cross join unnest(s.topics) t
         where s.org_id = current_org() and m.side = 'client' group by 1) x),
    'firstWeek', (select coalesce(jsonb_agg(jsonb_build_object('topic', x.t, 'n', x.n) order by x.n desc), '[]') from (
        select t, count(*) n from pulse_priv.wa_message_signal s join msgs m on m.id = s.message_id join chats ch on ch.id = m.chat_id cross join unnest(s.topics) t
         where s.org_id = current_org() and m.side = 'client' and m.sent_at < ch.first_at + interval '7 days' group by 1) x)),
  'wrong', jsonb_build_object(
    'signals', (select coalesce(jsonb_agg(jsonb_build_object('kind', x.kind, 'n', x.n, 'groups', x.g) order by x.n desc), '[]') from (
        select kind, count(*) n, count(distinct chat_id) g from pulse_priv.wa_signal where org_id = current_org() group by 1) x),
    'funds', (select jsonb_build_object('asks', count(*), 'groups', count(distinct m.chat_id)) from pulse_priv.wa_message m join side s on s.id = m.participant_id
        where m.org_id = current_org() and s.side = 'team' and m.kind in ('text', 'media') and m.body ~* '\m(add|top.?up|recharge|load)\M.{0,40}\m(fund|funds|balance|budget)\M'),
    'churn', (select coalesce(jsonb_agg(x.j order by x.risk desc), '[]') from (
        select (i.metrics->>'churn_risk')::numeric risk, jsonb_build_object('clientId', i.subject_id, 'client', cl.display_name, 'risk', i.metrics->'churn_risk',
          'negativeShare', i.metrics->'negative_share', 'complaints', coalesce((i.metrics->'signals'->>'complaint')::int, 0),
          'leadQuality', coalesce((i.metrics->'signals'->>'lead_quality')::int, 0), 'stopAsks', coalesce((i.metrics->'signals'->>'churn_risk')::int, 0),
          'quietDays', i.metrics->'quiet_days_at_end', 'lastActivity', i.metrics->'last_activity', 'groups', i.metrics->'groups',
          'teamMinutes', i.metrics->'team_median_answer_working_min') j
          from pulse_priv.wa_insight i join client cl on cl.id = i.subject_id
         where i.org_id = current_org() and i.subject = 'client' and (i.metrics->>'churn_risk')::numeric >= 0.35
         order by (i.metrics->>'churn_risk')::numeric desc limit 60) x),
    'atRisk', (select count(*) from pulse_priv.wa_insight i where i.org_id = current_org() and i.subject = 'client' and (i.metrics->>'churn_risk')::numeric >= 0.5)),
  'sop', jsonb_build_object('steps', (select i.metrics->'sop' from pulse_priv.wa_insight i where i.org_id = current_org() and i.subject = 'company' limit 1),
    -- the active SOP the chats were measured against: the one whose steps the measurement names
    'sopId', (select s.id from sop s where s.org_id = current_org() and s.status = 'active'
        and exists (select 1 from jsonb_array_elements(s.doc->'steps') st where lower(st->>'title') in (select lower(x->>'step') from pulse_priv.wa_insight i,
          jsonb_array_elements(coalesce(i.metrics->'sop', '[]')) x where i.org_id = current_org() and i.subject = 'company'))
       order by (select count(*) from jsonb_array_elements(s.doc->'steps') st where lower(st->>'title') in (select lower(x->>'step') from pulse_priv.wa_insight i,
          jsonb_array_elements(coalesce(i.metrics->'sop', '[]')) x where i.org_id = current_org() and i.subject = 'company')) desc, s.updated_at desc limit 1),
    'observedId', (select s.id from sop s where s.org_id = current_org() and 'whatsapp_import' = any(s.tags) and 'observed' = any(s.tags) and s.status <> 'archived' order by s.created_at limit 1),
    'proposedId', (select s.id from sop s where s.org_id = current_org() and 'whatsapp_import' = any(s.tags) and 'proposed' = any(s.tags) and s.status <> 'archived' order by s.created_at limit 1)))
 into d;
 insert into pulse_priv.wa_insights_cache (org_id, computed_at, data) values (current_org(), now(), d)
 on conflict (org_id) do update set computed_at = now(), data = excluded.data;
 return d || jsonb_build_object('actions', wa_insight_actions());
end $$;

-- What leaders did with the recommendations (the task or SOP each made).
create function pulse.wa_insight_actions() returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('rec', a.rec, 'kind', a.kind, 'ref', a.ref, 'at', a.created_at, 'by', p.display_name,
   'title', case a.kind when 'task' then (select t.title from task t where t.id = a.ref) else (select s.title from sop s where s.id = a.ref) end,
   'status', case a.kind when 'task' then (select t.status from task t where t.id = a.ref) else (select s.status from sop s where s.id = a.ref) end) order by a.created_at), '[]')
 from wa_insight_action a left join person p on p.id = a.created_by where a.org_id = current_org() and viewer_is('admin', 'leadership')
$$;

create function pulse.wa_insight_action_add(p_rec text, p_kind text, p_ref uuid) returns void
language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if not viewer_is('admin', 'leadership') then raise exception 'Insights are for leadership and admins' using errcode = '42501'; end if;
 if p_kind = 'task' and not exists (select 1 from task where org_id = current_org() and id = p_ref) then raise exception 'task unavailable' using errcode = '22023'; end if;
 if p_kind = 'sop' and not exists (select 1 from sop where org_id = current_org() and id = p_ref) then raise exception 'SOP unavailable' using errcode = '22023'; end if;
 insert into wa_insight_action (org_id, rec, kind, ref, created_by) values (current_org(), p_rec, p_kind, p_ref, current_viewer())
 on conflict (org_id, rec, kind) do update set ref = excluded.ref, created_by = excluded.created_by, created_at = now();
end $$;

-- One client: health, churn risk and why, groups waiting on us, the latest sentiment and recent signals.
create function pulse.wa_client_health(p_client uuid) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 with chans as (select w.id chat_id, w.channel_id, ch.name from pulse_priv.wa_chat w join chat_channel ch on ch.id = w.channel_id
                 where w.org_id = current_org() and w.client_id = p_client
                union
                select null, g.channel_id, ch.name from chat_group_info g join chat_channel ch on ch.id = g.channel_id where g.org_id = current_org() and g.client_id = p_client),
 last_msg as (select c.channel_id, c.name, l.at, l.side, l.who from chans c
   cross join lateral (select m.created_at at, case when m.guest_id is not null or p.side not in ('staff', 'agent') then 'client' else 'team' end side,
                              coalesce((select g.label from chat_guest g where g.id = m.guest_id), p.display_name) who
                         from chat_message m join person p on p.id = m.author_id
                        where m.org_id = current_org() and m.channel_id = c.channel_id and m.kind = 'text' and m.removed_at is null order by m.created_at desc limit 1) l),
 waiting as (select l.channel_id, l.name, l.who,
               (select min(m.created_at) from chat_message m join person p on p.id = m.author_id
                 where m.org_id = current_org() and m.channel_id = l.channel_id and m.kind = 'text' and m.removed_at is null
                   and (m.guest_id is not null or p.side not in ('staff', 'agent'))
                   and m.created_at > coalesce((select max(t.created_at) from chat_message t join person tp on tp.id = t.author_id
                         where t.org_id = current_org() and t.channel_id = l.channel_id and t.kind = 'text' and t.guest_id is null and tp.side in ('staff', 'agent')), '-infinity')) since
             from last_msg l where l.side = 'client')
 select case when viewer_is('admin', 'leadership') then jsonb_build_object(
  'clientId', p_client,
  'metrics', (select i.metrics from pulse_priv.wa_insight i where i.org_id = current_org() and i.subject = 'client' and i.subject_id = p_client),
  'health', (select g.health from chat_group_info g where g.org_id = current_org() and g.client_id = p_client and g.health is not null
              order by case g.health when 'at_risk' then 0 when 'watch' then 1 else 2 end limit 1),
  'groups', (select count(*) from chans),
  'lastAt', (select max(at) from last_msg),
  'waiting', coalesce((select jsonb_agg(jsonb_build_object('channelId', w.channel_id, 'name', w.name, 'who', w.who, 'since', w.since) order by w.since)
      from waiting w where w.since is not null), '[]'),
  'sentiment', (select jsonb_build_object('at', m.sent_at, 'sentiment', s.sentiment, 'intent', s.intent)
      from pulse_priv.wa_message_signal s join pulse_priv.wa_message m on m.org_id = s.org_id and m.id = s.message_id
      join pulse_priv.wa_chat w on w.org_id = m.org_id and w.id = m.chat_id join pulse_priv.wa_participant pa on pa.org_id = m.org_id and pa.id = m.participant_id
     where s.org_id = current_org() and w.client_id = p_client and pa.kind in ('client', 'contact', 'number') and s.intent not in ('ack', 'greeting')
     order by m.sent_at desc limit 1),
  'months', (select coalesce(jsonb_agg(jsonb_build_object('month', x.mon, 'positive', x.pos, 'negative', x.neg, 'messages', x.n) order by x.mon), '[]') from (
      select to_char(m.sent_at at time zone org_time_zone(), 'YYYY-MM') mon, count(*) filter (where s.sentiment > 0) pos, count(*) filter (where s.sentiment < 0) neg, count(*) n
        from pulse_priv.wa_message_signal s join pulse_priv.wa_message m on m.org_id = s.org_id and m.id = s.message_id
        join pulse_priv.wa_chat w on w.org_id = m.org_id and w.id = m.chat_id join pulse_priv.wa_participant pa on pa.org_id = m.org_id and pa.id = m.participant_id
       where s.org_id = current_org() and w.client_id = p_client and pa.kind in ('client', 'contact', 'number') group by 1 order by 1 desc limit 6) x),
  'signals', (select coalesce(jsonb_agg(jsonb_build_object('kind', g.kind, 'at', g.at, 'channelId', w.channel_id, 'chat', w.title,
        'messageId', (select x.id from chat_message x where x.org_id = g.org_id and x.import_ref = g.message_id)) order by g.at desc), '[]')
      from (select * from pulse_priv.wa_signal g where g.org_id = current_org() and g.client_id = p_client and g.kind in ('complaint', 'churn_risk', 'delay', 'lead_quality', 'upsell')
             order by g.at desc limit 6) g join pulse_priv.wa_chat w on w.org_id = g.org_id and w.id = g.chat_id)) end
$$;

revoke all on function pulse.wa_company_insights(boolean), pulse.wa_insight_actions(), pulse.wa_insight_action_add(text, text, uuid), pulse.wa_client_health(uuid) from public;
grant execute on function pulse.wa_company_insights(boolean), pulse.wa_insight_actions(), pulse.wa_insight_action_add(text, text, uuid), pulse.wa_client_health(uuid) to pulse_api;

-- migrate:down
-- Forward-only.
