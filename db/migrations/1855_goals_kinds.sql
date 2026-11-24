-- migrate:up
-- GOALS-2 (owner, 8 Nov 2026: "adding goals is a very huge deal … if money is involved, show the numbers … everything
-- has to be visualised"). A goal now has:
--   * a kind that picks its picture: money (₹, pace line, monthly bars), clients (logos stacking up), count (a ring),
--     milestone (a checklist), custom. Null on goals made before this: the API infers it from what the goal counts;
--   * a start day, so its pace ("on track to hit ₹26 L by 31 Mar") is measured from when it began;
--   * a checklist (steps) for a milestone; its progress is the share of steps ticked;
--   * an auto-source that fills its number by itself: money received or invoiced (Billing), paying clients (Billing),
--     staff checking in (Attendance) or done tasks under it. Only someone who may read that data may pick it; everyone
--     who sees the goal then sees its total (the add-goal flow says so before it is saved);
--   * a history of its number (pulse.goal_value), written by a trigger whenever the number moves, for the pace line,
--     the monthly bars and the streak.

alter table pulse.goal add column kind text check (kind in ('money', 'clients', 'count', 'milestone', 'custom'));
alter table pulse.goal add column source text not null default 'manual'
  check (source in ('manual', 'billing_received', 'billing_invoiced', 'clients_paying', 'checkins', 'tasks_done'));
alter table pulse.goal add column starts_on date;
alter table pulse.goal add column steps jsonb not null default '[]'
  check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) <= 30 and pg_column_size(steps) < 8192);
alter table pulse.goal add constraint goal_source_needs_target check (source = 'manual' or target_value is not null);
grant update (kind, source, starts_on, steps) on pulse.goal to pulse_api;

-- ------------------------------------------------------------------------------------------------ who may pick a source
-- Billing totals for whoever reads Billing; check-in rates for admins, leadership and HR. Checked when the source is
-- set or changed, so a goal keeps showing its total to the people who can see the goal.
create function pulse.goal_source_guard() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if new.source <> 'manual' and (tg_op = 'INSERT' or new.source is distinct from old.source) then
  if new.source in ('billing_received', 'billing_invoiced', 'clients_paying') and not erp_can(false) then
   raise exception 'Only people who can see Billing can fill a goal from it' using errcode = '42501';
  end if;
  if new.source = 'checkins' and not viewer_is('admin', 'leadership', 'hr') then
   raise exception 'Only admins, leadership and HR can fill a goal from check-ins' using errcode = '42501';
  end if;
 end if;
 return new;
end $$;
create trigger goal_source_guard before insert or update of source on pulse.goal for each row execute function pulse.goal_source_guard();

-- ------------------------------------------------------------------------------------------------ the number's history
create table pulse.goal_value (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references pulse.goal(id),
  value numeric(16,2) not null,
  at timestamptz not null default now(),
  by_person_id uuid references pulse.person(id)
);
create index goal_value_goal on pulse.goal_value(org_id, goal_id, at);
alter table pulse.goal_value enable row level security;
alter table pulse.goal_value force row level security;
create policy tenant_isolation on pulse.goal_value using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- Seen with its goal; written only by the trigger below (no insert grant to the API).
create policy goal_value_see on pulse.goal_value as restrictive for select to pulse_api using (exists(select 1 from pulse.goal g where g.id = goal_id));
grant select on pulse.goal_value to pulse_api;

create function pulse.goal_value_log() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if new.current_value is not null and (tg_op = 'INSERT' or new.current_value is distinct from old.current_value) then
  insert into goal_value(org_id, goal_id, value, by_person_id) values (new.org_id, new.id, new.current_value, current_viewer());
 end if;
 return null;
end $$;
create trigger goal_value_log after insert or update of current_value on pulse.goal for each row execute function pulse.goal_value_log();

-- ------------------------------------------------------------------------------------------------ auto-sources
-- The goal's number from its source, for a viewer who can see the goal: { value, series: [{key, value}], items: [{id,
-- name, on}] }. Money in rupees (Billing keeps paise). The window is the goal's start day to its target day (or today).
create function pulse.goal_auto(p_goal uuid) returns jsonb
 language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare g goal; d0 date; d1 date; today date := (now() at time zone org_time_zone())::date; v numeric := 0; series jsonb := '[]'; items jsonb := '[]';
 staff int; day date;
begin
 select * into g from goal where org_id = current_org() and id = p_goal;
 if not found or g.source = 'manual' or not goal_can_see(g.level, g.owner_person_id, g.created_by) then return null; end if;
 d0 := coalesce(g.starts_on, (g.created_at at time zone org_time_zone())::date);
 d1 := least(coalesce(g.target_on, today), today);
 if g.source = 'billing_received' then
  select coalesce(sum(p.amount), 0) / 100.0 into v from erp_payment p
   where p.org_id = g.org_id and p.voided_at is null and p.received_on between d0 and d1;
  select coalesce(jsonb_agg(jsonb_build_object('key', m, 'value', s) order by m), '[]') into series from (
   select to_char(p.received_on, 'YYYY-MM') m, sum(p.amount) / 100.0 s from erp_payment p
    where p.org_id = g.org_id and p.voided_at is null and p.received_on between d0 and d1 group by 1) x;
 elsif g.source = 'billing_invoiced' then
  select coalesce(sum(d.total), 0) / 100.0 into v from erp_document d
   where d.org_id = g.org_id and d.doc_type = 'invoice' and d.status not in ('draft', 'cancelled') and d.issue_date between d0 and d1;
  select coalesce(jsonb_agg(jsonb_build_object('key', m, 'value', s) order by m), '[]') into series from (
   select to_char(d.issue_date, 'YYYY-MM') m, sum(d.total) / 100.0 s from erp_document d
    where d.org_id = g.org_id and d.doc_type = 'invoice' and d.status not in ('draft', 'cancelled') and d.issue_date between d0 and d1 group by 1) x;
 elsif g.source = 'clients_paying' then
  select count(*), coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'on', x.first_on) order by x.first_on) filter (where x.n <= 24), '[]')
   into v, items from (
   select c.id, c.display_name name, min(p.received_on)::text first_on, row_number() over (order by min(p.received_on)) n
    from erp_payment p join erp_document d on d.id = p.document_id and d.org_id = p.org_id join client c on c.id = d.client_id
    where p.org_id = g.org_id and p.voided_at is null and p.received_on between d0 and d1 group by c.id, c.display_name) x;
 elsif g.source = 'checkins' then
  select count(*) into staff from person where org_id = g.org_id and side = 'staff' and status = 'active';
  -- The last day anyone checked in (this week), as a share of active staff; the series is the last 14 such days.
  select max((e.checked_in_at at time zone org_time_zone())::date) into day from attendance_entry e
   where e.org_id = g.org_id and e.checked_in_at >= now() - interval '7 days';
  if staff > 0 and day is not null then
   select round(100.0 * count(distinct e.person_id) / staff) into v from attendance_entry e
    where e.org_id = g.org_id and (e.checked_in_at at time zone org_time_zone())::date = day;
   select coalesce(jsonb_agg(jsonb_build_object('key', k, 'value', s) order by k), '[]') into series from (
    select (e.checked_in_at at time zone org_time_zone())::date::text k, round(100.0 * count(distinct e.person_id) / staff) s from attendance_entry e
     where e.org_id = g.org_id and e.checked_in_at >= now() - interval '20 days' group by 1 order by 1 desc limit 14) x;
  end if;
 elsif g.source = 'tasks_done' then
  select count(*) into v from task t where t.org_id = g.org_id and t.status in ('done', 'accepted') and t.id in (
   select l.task_id from goal_link l where l.goal_id = g.id and l.task_id is not null
   union select t2.id from task t2 join goal_link l on l.project_id = t2.project_id where l.goal_id = g.id);
 end if;
 return jsonb_build_object('value', coalesce(v, 0), 'series', series, 'items', items, 'from', d0::text, 'to', d1::text);
end $$;
grant execute on function pulse.goal_auto(uuid) to pulse_api;

-- ------------------------------------------------------------------------------------------------ roll-up
-- As 1570, plus: an auto-source's number counts as the value now, and a milestone's checklist (when it has no number to
-- reach) is its progress. 'current' is the value now, 'steps' / 'stepsDone' the checklist.
create or replace function pulse.goal_progress(p_goal uuid, p_depth int default 0) returns jsonb
 language plpgsql stable security invoker set search_path=pulse,pg_temp as $$
declare g goal; total int := 0; done int := 0; projects int := 0; kids int := 0; kid_sum numeric := 0; measure numeric; work numeric; p numeric;
 k record; today date := (now() at time zone org_time_zone())::date; cur numeric; steps int := 0; steps_done int := 0;
begin
 select * into g from goal where id = p_goal;
 if not found then return null; end if;
 select count(*) filter (where project_id is not null) into projects from goal_link where goal_id = p_goal;
 select count(*), count(*) filter (where t.status in ('done', 'accepted')) into total, done
   from task t where t.status <> 'cancelled' and t.id in (
     select l.task_id from goal_link l where l.goal_id = p_goal and l.task_id is not null
     union select t2.id from task t2 join goal_link l on l.project_id = t2.project_id where l.goal_id = p_goal);
 if p_depth < 8 then
  for k in select c.id from goal c where c.parent_id = p_goal and c.status <> 'dropped' loop
   kids := kids + 1; kid_sum := kid_sum + coalesce((goal_progress(k.id, p_depth + 1) ->> 'progress')::numeric, 0);
  end loop;
 end if;
 steps := jsonb_array_length(g.steps);
 select count(*) into steps_done from jsonb_array_elements(g.steps) e where (e ->> 'done')::boolean is true;
 cur := coalesce(g.current_value, g.start_value, 0);
 if g.source <> 'manual' then cur := coalesce((goal_auto(p_goal) ->> 'value')::numeric, cur); end if;
 if g.target_value is not null then
  measure := greatest(0, least(1, (cur - coalesce(g.start_value, 0)) / (g.target_value - coalesce(g.start_value, 0))));
 elsif steps > 0 then
  measure := steps_done::numeric / steps;
 end if;
 if total + kids > 0 then work := (done + kid_sum) / (total + kids); end if;
 p := case when g.status = 'done' then 1 else coalesce(measure, work, 0) end;
 return jsonb_build_object('progress', round(p, 4), 'measure', round(measure, 4), 'work', round(work, 4), 'tasks', total, 'tasksDone', done,
   'projects', projects, 'subGoals', kids, 'late', g.status = 'active' and g.target_on is not null and g.target_on < today and p < 1,
   'current', case when g.target_value is null then null else cur end, 'steps', steps, 'stepsDone', steps_done,
   'basis', case when g.status = 'done' then 'done' when g.target_value is not null then 'measure' when steps > 0 then 'steps'
     when work is not null then 'work' else 'none' end);
end $$;

-- migrate:down
-- Forward-only.
