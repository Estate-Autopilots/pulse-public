-- migrate:up
-- INSIGHTS-2 (coordinator, 26 Oct 2026: "a colleague's own answer-time charts on their page"): pulse.insight_person(p)
-- reads one colleague's numbers from the imported WhatsApp groups for their page: how fast they answer clients (a
-- histogram in working minutes, p50 / p90, against the whole team's p50), when they write (hour x weekday), how the
-- median moved month by month (the last 12 months of the record), after-hours share, groups and messages. Admins and
-- leadership read anyone's; a colleague reads only their own; anyone else gets null. Counts and percentiles only.
-- Additive: one function, nothing names a company.

create function pulse.insight_person(p_person uuid) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 with ok as (select viewer_is('admin', 'leadership') or (current_viewer() is not null and current_viewer() = p_person) yes),
 me as (select pa.id from pulse_priv.wa_participant pa where pa.org_id = current_org() and pa.person_id = p_person and pa.kind = 'colleague'),
 msgs as (select m.chat_id, m.sent_at, substr(m.local_time, 12, 2)::int hr, extract(isodow from left(m.local_time, 10)::date)::int dw
            from pulse_priv.wa_message m where m.org_id = current_org() and m.participant_id in (select id from me) and m.local_time ~ '^\d{4}-\d\d-\d\d.\d\d'),
 mine as (select r.working_s / 60.0 wm, m.sent_at from pulse_priv.wa_response r join pulse_priv.wa_message m on m.org_id = r.org_id and m.id = r.message_id
           where r.org_id = current_org() and r.responder_side = 'team' and r.responder_participant in (select id from me)),
 edge as (select max(sent_at) t from mine)
 select case when (select yes from ok) and exists (select 1 from me) then jsonb_build_object(
  'personId', p_person,
  'groups', (select count(distinct chat_id) from msgs), 'messages', (select count(*) from msgs),
  'answers', (select count(*) from mine),
  'p50', (select round(percentile_cont(0.5) within group (order by wm)::numeric, 1) from mine),
  'p90', (select round(percentile_cont(0.9) within group (order by wm)::numeric, 1) from mine),
  'teamP50', (select round(percentile_cont(0.5) within group (order by r.working_s / 60.0)::numeric, 1) from pulse_priv.wa_response r
               where r.org_id = current_org() and r.responder_side = 'team'),
  'afterHours', (select round(avg(case when hr < 10 or hr >= 19 or dw = 7 then 1 else 0 end)::numeric, 3) from msgs),
  'hist', (select coalesce(jsonb_agg(jsonb_build_object('lo', b.lo, 'hi', b.hi,
      'n', (select count(*) from mine where wm >= b.lo and (b.hi is null or wm < b.hi)),
      'team', (select count(*) from pulse_priv.wa_response r where r.org_id = current_org() and r.responder_side = 'team'
                and r.working_s / 60.0 >= b.lo and (b.hi is null or r.working_s / 60.0 < b.hi))) order by b.lo), '[]')
      from (values (0, 5), (5, 15), (15, 30), (30, 60), (60, 120), (120, 240), (240, 540), (540, 1620), (1620, null)) b(lo, hi)),
  'heat', (select coalesce(jsonb_agg(jsonb_build_object('dow', dw, 'hour', hr, 'n', n) order by dw, hr), '[]') from (
      select dw, hr, count(*) n from msgs group by 1, 2) x),
  'months', (select coalesce(jsonb_agg(jsonb_build_object('month', mon, 'n', n, 'p50', round(p50::numeric, 1)) order by mon), '[]') from (
      select to_char(sent_at at time zone org_time_zone(), 'YYYY-MM') mon, count(*) n, percentile_cont(0.5) within group (order by wm) p50
        from mine where sent_at >= (select t from edge) - interval '12 months' group by 1) x)) end
$$;

revoke all on function pulse.insight_person(uuid) from public;
grant execute on function pulse.insight_person(uuid) to pulse_api;

-- migrate:down
-- Forward-only.
