-- migrate:up
-- TASKUX (owner, 2 Nov 2026): one person across several organisations ("Sakobe": his own company with freelance
-- clients and content channels, a sales job elsewhere, a freelancer seat in a third) opens Pulse and sees one day.
--
--  1. My day across organisations. pulse.account_seats() names the signed-in account's seats (an active organisation,
--     an active person there). The API reads each seat in its own read-only transaction, inside that organisation and
--     as that person (pulse.my_day_seat(): SECURITY INVOKER, so each organisation's row-level security decides what is
--     read). Nothing is copied between organisations and nothing here reads one organisation's rows from another.
--  2. One running clock per account: starting a clock in one organisation pauses the account's clock in every other
--     one (task_timer_open → task_timer_close_elsewhere). Time targets per person (a day and a week), set by the person.
--  3. Repeating work by a rule: every N days, weeks (on chosen weekdays) or months (on the same day of the month),
--     optionally skipping weekends, until a stop date. The next one is made when the current one is finished (as since
--     UX-5B) and, once its day comes, by the notification worker's minute tick (task_due_tick → task_repeat_tick) even
--     when the last one is still open. Each day of a series is made once (pulse.task_repeat_made), whoever gets there first.
--  4. A start date on tasks; three finer states inside the existing ones, so every report, board column and count keeps
--     working: Waiting for response and On hold are Blocked, Revision required is Doing (pulse.task.stage). A project's
--     workstream (the stakeholder its time rolls up to: a client, a channel, the day job).
-- Safe on a live install: additive columns, two new tables (forced row-level security), functions replaced with their
-- old behaviour kept (task_repeat_set and the finish-time repeat are unchanged for existing series).

-- ------------------------------------------------------------------------------------- 4. task fields and finer states
alter table pulse.task add column starts_on date;
alter table pulse.task add column stage text check (stage in ('waiting', 'revision', 'on_hold'));
alter table pulse.work_project add column workstream text check (workstream is null or length(btrim(workstream)) between 1 and 60);
select pulse.check_values_add('pulse.task_event'::regclass, 'task_event_kind_check', 'kind', array['stage', 'plan']);

-- A finer state lives only inside its own status: a task moved anywhere else drops it (Doing → Done ends "Revision required").
create function pulse.task_stage_follow() returns trigger language plpgsql set search_path = pulse, pg_temp as $$
begin
  if new.stage is not null and not ((new.stage in ('waiting', 'on_hold') and new.status = 'blocked') or (new.stage = 'revision' and new.status = 'in_progress')) then
    new.stage := null;
  end if;
  return new;
end $$;
create trigger task_stage_follow before insert or update of status, stage on pulse.task for each row execute function pulse.task_stage_follow();

-- Waiting for response / Revision required / On hold (null clears it). Moves the task into the status it lives in.
create function pulse.task_stage_set(p_task uuid, p_stage text, p_note text default null) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := task_require_viewer(); t task; target text;
begin
  t := task_for_edit(p_task);
  if p_stage is not null and p_stage not in ('waiting', 'revision', 'on_hold') then
    raise exception 'Choose Waiting for response, Revision required or On hold' using errcode = '22023'; end if;
  if p_stage is not distinct from t.stage then return jsonb_build_object('status', t.status, 'stage', t.stage); end if;
  if p_stage is not null then
    target := case p_stage when 'revision' then 'in_progress' else 'blocked' end;
    if t.status is distinct from target then perform task_move(p_task, target, p_note); end if;
  end if;
  update task set stage = p_stage, updated_at = now(), edited_by = me where id = p_task;
  perform task_event_add(p_task, 'stage', t.stage, p_stage, nullif(btrim(coalesce(p_note, '')), ''));
  return jsonb_build_object('status', (select status from task where id = p_task), 'stage', p_stage);
end $$;

-- The start date (null clears it): not after the due day.
create function pulse.task_plan_set(p_task uuid, p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := task_require_viewer(); t task; v date;
begin
  t := task_for_edit(p_task);
  if not (p ? 'startsOn') then return jsonb_build_object('startsOn', t.starts_on); end if;
  begin v := nullif(btrim(coalesce(p ->> 'startsOn', '')), '')::date;
  exception when others then raise exception 'Choose a valid start date' using errcode = '22023'; end;
  if v is not null and t.due_at is not null and v > (t.due_at at time zone org_time_zone())::date then
    raise exception 'The start date is after the due date' using errcode = '22023'; end if;
  if v is distinct from t.starts_on then
    update task set starts_on = v, updated_at = now(), edited_by = me where id = p_task;
    perform task_event_add(p_task, 'plan', t.starts_on::text, v::text, case when v is null then 'Start date cleared' else 'Starts ' || to_char(v, 'DD Mon') end);
  end if;
  return jsonb_build_object('startsOn', v);
end $$;

-- A project's workstream joins its category, colour and icon (same people may change it).
create or replace function pulse.work_project_style(p_project uuid, p jsonb) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 perform task_require_viewer();
 if not exists(select 1 from work_project where org_id=current_org() and project_id=p_project) then raise exception 'Project not found' using errcode='P0002';end if;
 if not work_project_can_manage(p_project) then raise exception 'Only the project owner, the head of its pod or leadership can change it' using errcode='42501';end if;
 perform project_category_ensure();
 if p ? 'category' and nullif(p->>'category','') is not null and not exists(select 1 from project_category where org_id=current_org() and key=p->>'category' and retired_at is null) then
  raise exception 'Choose one of the company''s project categories' using errcode='22023';end if;
 if p ? 'workstream' and length(btrim(coalesce(p->>'workstream',''))) > 60 then raise exception 'Name the workstream in up to 60 characters' using errcode='22023';end if;
 update work_project set project_category=case when p ? 'category' then nullif(p->>'category','') else project_category end,
  color=case when p ? 'color' then nullif(p->>'color','') else color end,icon=case when p ? 'icon' then nullif(p->>'icon','') else icon end,
  workstream=case when p ? 'workstream' then nullif(btrim(regexp_replace(coalesce(p->>'workstream',''),'\s+',' ','g')),'') else workstream end,
  updated_by=current_viewer(),updated_at=now() where org_id=current_org() and project_id=p_project;
end $$;

-- ------------------------------------------------------------------------------------------------- 2. time targets
create table pulse.person_time_target (
  org_id          uuid not null references pulse.org(id),
  person_id       uuid not null references pulse.person(id) on delete cascade,
  daily_minutes   int check (daily_minutes between 15 and 1440),
  weekly_minutes  int check (weekly_minutes between 30 and 10080),
  updated_at      timestamptz not null default now(),
  primary key (org_id, person_id)
);
alter table pulse.person_time_target enable row level security;
alter table pulse.person_time_target force row level security;
create policy tenant on pulse.person_time_target using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- As private as time itself: the person, their managers, HR and leadership.
create policy visible on pulse.person_time_target as restrictive for select to pulse_api
  using (person_id = pulse.current_viewer() or pulse.viewer_is('admin', 'leadership', 'hr') or pulse.manages(person_id));
grant select on pulse.person_time_target to pulse_api;

-- The person's own targets in this organisation (minutes; null clears one).
create function pulse.time_target_set(p jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := task_require_viewer(); d int; w int;
begin
  begin
    d := nullif(btrim(coalesce(p ->> 'dailyMinutes', '')), '')::int; w := nullif(btrim(coalesce(p ->> 'weeklyMinutes', '')), '')::int;
  exception when others then raise exception 'Enter the targets in minutes' using errcode = '22023'; end;
  if d is not null and d not between 15 and 1440 then raise exception 'A day''s target is between 15 minutes and 24 hours' using errcode = '22023'; end if;
  if w is not null and w not between 30 and 10080 then raise exception 'A week''s target is between 30 minutes and 168 hours' using errcode = '22023'; end if;
  if d is null and w is null then delete from person_time_target where org_id = current_org() and person_id = me;
  else
    insert into person_time_target(org_id, person_id, daily_minutes, weekly_minutes) values (current_org(), me, d, w)
    on conflict (org_id, person_id) do update set daily_minutes = excluded.daily_minutes, weekly_minutes = excluded.weekly_minutes, updated_at = now();
  end if;
  return jsonb_build_object('dailyMinutes', d, 'weeklyMinutes', w);
end $$;

-- --------------------------------------------------------------------------------------------- 3. repeating by rule
alter table pulse.task_repeat
  add column every_n smallint not null default 1 check (every_n between 1 and 12),
  add column weekdays smallint[] check (weekdays is null or weekdays <@ array[1,2,3,4,5,6,7]::smallint[]),
  add column skip_weekends boolean not null default false,
  add column until date,
  add column month_day smallint check (month_day between 1 and 31),
  add column last_on date,
  add column next_on date;
create index task_repeat_due on pulse.task_repeat(org_id, next_on) where next_on is not null;

-- Each day of a series is made once: the finish-time trigger and the minute tick never both make it.
create table pulse.task_repeat_made (
  org_id     uuid not null references pulse.org(id),
  repeat_id  uuid not null references pulse.task_repeat(id) on delete cascade,
  occurs_on  date not null,
  task_id    uuid references pulse.task(id) on delete set null,
  made_at    timestamptz not null default now(),
  primary key (repeat_id, occurs_on)
);
alter table pulse.task_repeat_made enable row level security;
alter table pulse.task_repeat_made force row level security;
create policy tenant on pulse.task_repeat_made using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.task_repeat_made to pulse_worker;

-- The day after p_from that a rule falls on. Weekly with chosen weekdays: the next chosen day this week, else the first
-- chosen day N weeks on (chosen days are kept, weekends too). Monthly: the rule's day of the month (31 → the month's
-- last day). Skipping weekends moves a Saturday or Sunday to the Monday after.
create function pulse.task_repeat_after(p_every text, p_n int, p_weekdays smallint[], p_skip boolean, p_month_day int, p_from date) returns date
  language plpgsql immutable set search_path = pulse, pg_temp as $$
declare x date; n int := greatest(coalesce(p_n, 1), 1); wk date; i int; last_day int;
begin
  if p_from is null then return null; end if;
  if p_every = 'day' then x := p_from + n;
  elsif p_every = 'week' then
    if coalesce(cardinality(p_weekdays), 0) = 0 then x := p_from + 7 * n;
    else
      for i in 1 .. (7 - extract(isodow from p_from)::int) loop
        if extract(isodow from p_from + i)::smallint = any(p_weekdays) then x := p_from + i; exit; end if;
      end loop;
      if x is null then
        wk := p_from - (extract(isodow from p_from)::int - 1) + 7 * n;
        for i in 0 .. 6 loop
          if extract(isodow from wk + i)::smallint = any(p_weekdays) then x := wk + i; exit; end if;
        end loop;
      end if;
      return x;
    end if;
  elsif p_every = 'month' then
    x := (date_trunc('month', p_from) + make_interval(months => n))::date;
    last_day := extract(day from (x + interval '1 month' - interval '1 day'))::int;
    x := x + (least(coalesce(p_month_day, extract(day from p_from)::int), last_day) - 1);
  else
    raise exception 'Repeat every day, week or month' using errcode = '22023';
  end if;
  if p_skip then
    while extract(isodow from x) >= 6 loop x := x + 1; end loop;
  end if;
  return x;
end $$;

-- Make the series' task for one day, from the series' current task (title, notes, people, project, kind, value,
-- estimate, place in Pulse, confirmed signals). Null when that day was already made. The series moves to the new task.
create function pulse.task_repeat_make(p_repeat uuid, p_on date) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r task_repeat; src task; tz text; due timestamptz; nid uuid; c task_companion; parent uuid; v_every text;
begin
  select * into r from task_repeat where id = p_repeat for update;
  if not found then return null; end if;
  insert into task_repeat_made(org_id, repeat_id, occurs_on) values (r.org_id, r.id, p_on) on conflict do nothing;
  if not found then return null; end if;
  select * into src from task where id = r.task_id;
  tz := org_time_zone(r.org_id);
  due := case when src.due_at is not null then (p_on + (src.due_at at time zone tz)::time) at time zone tz end;
  -- A finished parent takes no new subtasks: the next one stands on its own then.
  parent := case when src.parent_id is not null and exists(select 1 from task p where p.id = src.parent_id and p.status in ('open','in_progress','blocked','unknown') and p.deleted_at is null) then src.parent_id end;
  insert into task(org_id,project_id,title,assignee_person_id,owner_id,review_owner_id,priority,notes,category,tags,estimate_minutes,value_points,value_source,value_by,value_at,
    ai_suggestion,due_at,starts_on,parent_id,created_by,created_at,status,source,assigned_at)
  values(src.org_id,src.project_id,src.title,src.assignee_person_id,src.owner_id,src.review_owner_id,src.priority,src.notes,src.category,src.tags,src.estimate_minutes,src.value_points,
    src.value_source,src.value_by,src.value_at,src.ai_suggestion,due,p_on,parent,src.created_by,now(),'open','pulse',now())
  returning id into nid;
  update task_repeat_made set task_id = nid where repeat_id = r.id and occurs_on = p_on;
  update task_repeat set task_id = nid, made = made + 1, last_on = p_on,
    next_on = case when until is null or task_repeat_after(every, every_n, weekdays, skip_weekends, month_day, p_on) <= until
      then task_repeat_after(every, every_n, weekdays, skip_weekends, month_day, p_on) end
  where id = r.id;
  v_every := case r.every when 'day' then case when r.every_n > 1 then r.every_n || ' days' else 'day' end
    when 'week' then case when r.every_n > 1 then r.every_n || ' weeks' else 'week' end else case when r.every_n > 1 then r.every_n || ' months' else 'month' end end;
  insert into task_event(org_id,task_id,actor_id,kind,from_value,to_value,note) values(src.org_id,nid,null,'repeat',null,r.every,
    'Made by itself: it repeats every '||v_every||' (for '||to_char(p_on,'Dy DD Mon')||')');
  -- The place in Pulse and the confirmed signals carry over, counting from the new task.
  select * into c from task_companion where task_id = src.id;
  if found then
    insert into task_companion(org_id,task_id,target,target_events,target_by,auto_done,confirmed_by,confirmed_at)
    values(src.org_id,nid,c.target,c.target_events,c.target_by,c.auto_done,c.confirmed_by,case when c.confirmed_at is not null then now() end);
    insert into task_signal(org_id,task_id,position,event,label,cond,need,distinct_subject,since,created_by)
    select org_id,nid,position,event,label,cond,need,distinct_subject,now(),created_by from task_signal where task_id = src.id;
  end if;
  perform task_notify(coalesce(src.assignee_person_id,src.owner_id),'task.assigned',nid,nid||':repeat',left('Next one ready: '||src.title||' · '||to_char(coalesce(due at time zone tz, p_on::timestamp),'Dy DD Mon'),160));
  return nid;
end $$;

-- When the series' current task is finished, the next day of the rule (today or later, and not already past its time)
-- is made at once. A series whose stop date has passed ends.
create or replace function pulse.task_repeat_next() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r task_repeat; tz text := org_time_zone(new.org_id); today date; d date; guard int := 0;
begin
  select * into r from task_repeat where task_id = new.id;
  if not found or new.deleted_at is not null then return null; end if;
  today := (now() at time zone tz)::date;
  d := coalesce(r.last_on, (new.due_at at time zone tz)::date, today);
  loop
    d := task_repeat_after(r.every, r.every_n, r.weekdays, r.skip_weekends, r.month_day, d);
    guard := guard + 1;
    exit when guard > 2000 or (d >= today and (new.due_at is null or ((d + (new.due_at at time zone tz)::time) at time zone tz) >= now()));
  end loop;
  if r.until is not null and d > r.until then
    delete from task_repeat where id = r.id;
    insert into task_event(org_id,task_id,actor_id,kind,from_value,to_value,note) values(new.org_id,new.id,null,'repeat',r.every,null,
      'Stopped repeating: its last day ('||to_char(r.until,'DD Mon YYYY')||') has passed');
    return null;
  end if;
  perform task_repeat_make(r.id, d);
  return null;
end $$;

-- The schedule (the notification worker, every minute in each organisation): when a series' next day has come, its task
-- for the latest day due is made, even if the last one is still open (that one stays, overdue). Days missed while
-- nothing ran are not made one by one: only the latest.
create function pulse.task_repeat_tick() returns int language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r record; today date := (now() at time zone org_time_zone())::date; d date; nx date; n int := 0; g int;
begin
  for r in select rp.*, t.deleted_at t_deleted from task_repeat rp join task t on t.id = rp.task_id
      where rp.org_id = current_org() and rp.next_on is not null and rp.next_on <= today order by rp.next_on limit 500 loop
    if r.t_deleted is not null then delete from task_repeat where id = r.id; continue; end if;
    d := r.next_on; g := 0;
    loop
      nx := task_repeat_after(r.every, r.every_n, r.weekdays, r.skip_weekends, r.month_day, d);
      exit when nx is null or nx > today or g > 2000;
      d := nx; g := g + 1;
    end loop;
    if r.until is not null and d > r.until then
      update task_repeat set next_on = null where id = r.id;
      continue;
    end if;
    if task_repeat_make(r.id, d) is not null then n := n + 1;
    else
      update task_repeat set next_on = case when until is null or task_repeat_after(every, every_n, weekdays, skip_weekends, month_day, d) <= until
        then task_repeat_after(every, every_n, weekdays, skip_weekends, month_day, d) end where id = r.id;
    end if;
  end loop;
  return n;
end $$;

create or replace function pulse.task_due_tick() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t record;n int:=0;
begin
 for t in select id,title,coalesce(owner_id,assignee_person_id) who,due_at from task where org_id=current_org() and coalesce(owner_id,assignee_person_id) is not null
  and status in ('open','in_progress','blocked') and due_at between now() and now()+interval '24 hours' and source='pulse' and deleted_at is null loop
  if notification_emit(t.who,'task.due_soon','task',t.id,t.id||':due:'||t.due_at::text,'Due soon: '||left(t.title,120),'/tasks/'||t.id,'task') is not null then n:=n+1;end if;
 end loop;
 perform task_review_tick();
 perform task_timer_tick();
 perform task_waiting_tick();
 -- TASKUX: repeating work whose day has come.
 begin perform task_repeat_tick(); exception when others then raise warning 'task repeat: %', sqlerrm; end;
 return n;
end $$;

-- A rule: {"every": "day|week|month"|null, "interval": 1-12, "weekdays": [1..7] (week), "skipWeekends": bool,
-- "until": "YYYY-MM-DD"|null}. The task's own day (its due day, else its start, else today) is the series' first.
create function pulse.task_repeat_rule_set(p_task uuid, p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := task_require_viewer(); k task; v_every text := nullif(btrim(coalesce(p ->> 'every', '')), ''); v_n int; v_days smallint[];
  v_skip boolean; v_until date; tz text := org_time_zone(); today date := (now() at time zone org_time_zone())::date; anchor date; rid uuid; nx date;
begin
  k := task_for_edit(p_task);
  if v_every is null then
    delete from task_repeat where task_id = p_task;
    perform task_event_add(p_task, 'repeat', null, null, 'Stopped repeating');
    return task_repeat_get(p_task);
  end if;
  if v_every not in ('day', 'week', 'month') then raise exception 'Repeat every day, week or month' using errcode = '22023'; end if;
  begin
    v_n := coalesce(nullif(p ->> 'interval', '')::int, 1);
    v_days := case when v_every = 'week' and jsonb_typeof(p -> 'weekdays') = 'array'
      then (select array_agg(distinct x::smallint order by x::smallint) from jsonb_array_elements_text(p -> 'weekdays') x) end;
    v_skip := coalesce((p ->> 'skipWeekends')::boolean, false);
    v_until := nullif(btrim(coalesce(p ->> 'until', '')), '')::date;
  exception when others then raise exception 'Check the repeat: every, how often, the days and the stop date' using errcode = '22023'; end;
  if v_n not between 1 and 12 then raise exception 'Repeat every 1 to 12' using errcode = '22023'; end if;
  if v_days is not null and not (v_days <@ array[1,2,3,4,5,6,7]::smallint[]) then raise exception 'Choose weekdays Monday to Sunday' using errcode = '22023'; end if;
  if v_until is not null and v_until < today then raise exception 'The stop date has passed' using errcode = '22023'; end if;
  anchor := coalesce((k.due_at at time zone tz)::date, k.starts_on, today);
  nx := task_repeat_after(v_every, v_n, v_days, v_skip, case when v_every = 'month' then extract(day from anchor)::int end, anchor);
  insert into task_repeat(org_id, task_id, every, every_n, weekdays, skip_weekends, until, month_day, last_on, next_on, created_by)
  values (current_org(), p_task, v_every, v_n, v_days, v_skip, v_until, case when v_every = 'month' then extract(day from anchor)::int end, anchor,
    case when v_until is null or nx <= v_until then nx end, me)
  on conflict (task_id) do update set every = excluded.every, every_n = excluded.every_n, weekdays = excluded.weekdays, skip_weekends = excluded.skip_weekends,
    until = excluded.until, month_day = excluded.month_day, last_on = excluded.last_on, next_on = excluded.next_on
  returning id into rid;
  insert into task_repeat_made(org_id, repeat_id, occurs_on, task_id) values (current_org(), rid, anchor, p_task) on conflict do nothing;
  perform task_event_add(p_task, 'repeat', null, v_every, 'Repeats every ' || case when v_n > 1 then v_n || ' ' || v_every || 's' else v_every end
    || coalesce(' until ' || to_char(v_until, 'DD Mon YYYY'), ''));
  return task_repeat_get(p_task);
end $$;

-- The series a task leads (for its page): the rule and the next day.
create function pulse.task_repeat_get(p_task uuid) returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select jsonb_build_object('every', r.every, 'interval', r.every_n, 'weekdays', coalesce(to_jsonb(r.weekdays), '[]'::jsonb), 'skipWeekends', r.skip_weekends,
      'until', r.until, 'nextOn', r.next_on, 'lastOn', r.last_on, 'made', r.made)
    from task_repeat r where r.task_id = p_task and task_visible(p_task)), jsonb_build_object('every', null))
$$;

-- ------------------------------------------------------------------------------- 2. one running clock per account
-- Close the clocks of the same account's people in every other organisation (each closed inside its own organisation).
create function pulse.task_timer_close_elsewhere(p_org uuid, p_person uuid) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s record; o text := coalesce(current_setting('pulse.org_id', true), ''); vw text := coalesce(current_setting('pulse.viewer_id', true), ''); n int := 0; running boolean;
begin
  for s in select m2.member_org, m2.person_id from pulse_priv.account_member m1
      join pulse_priv.account_member m2 on m2.account_id = m1.account_id and m2.member_org <> m1.member_org
      where m1.person_id = p_person and m1.member_org = p_org loop
    perform set_config('pulse.org_id', s.member_org::text, true);
    perform set_config('pulse.viewer_id', s.person_id::text, true);
    select exists(select 1 from task_timer where org_id = s.member_org and person_id = s.person_id and ended_at is null) into running;
    if running then perform task_timer_close(s.member_org, s.person_id, 'switched'); n := n + 1; end if;
  end loop;
  perform set_config('pulse.org_id', o, true);
  perform set_config('pulse.viewer_id', vw, true);
  return n;
end $$;

/** Start a person's clock on a task (pausing any other first, in every organisation of their account). Only the person
 *  doing the task, on work in Doing. */
create or replace function pulse.task_timer_open(p_org uuid,p_task uuid,p_person uuid,p_reason text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare nid uuid;
begin
 if not exists(select 1 from task where org_id=p_org and id=p_task and status='in_progress' and deleted_at is null and coalesce(assignee_person_id,owner_id)=p_person) then return null;end if;
 if exists(select 1 from task_timer where org_id=p_org and person_id=p_person and task_id=p_task and ended_at is null) then
  return (select id from task_timer where org_id=p_org and person_id=p_person and ended_at is null);end if;
 perform task_timer_close(p_org,p_person,'switched');
 perform task_timer_close_elsewhere(p_org,p_person);
 insert into task_timer(org_id,task_id,person_id,start_reason) values(p_org,p_task,p_person,p_reason) returning id into nid;
 return nid;
end $$;

-- ------------------------------------------------------------------------------------------- 1. My day across seats
-- The signed-in account's seats: each active organisation it is in with an active person there (the current one
-- first). Without an account: this organisation only. The person ids are this account's own.
create function pulse.account_seats() returns table(seat_org uuid, seat_person uuid, org_name text, org_handle text, seat_kind text, is_current boolean)
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a uuid := account_of_viewer(); m record; o text := coalesce(current_setting('pulse.org_id', true), ''); vw text := coalesce(current_setting('pulse.viewer_id', true), ''); ok boolean;
begin
  if current_viewer() is null then return; end if;
  if a is null then
    return query select g.id, current_viewer(), g.name, g.handle, 'staff'::text, true from org g where g.id = current_org();
    return;
  end if;
  for m in select am.member_org, am.person_id, am.kind, g.name, g.handle from pulse_priv.account_member am join org g on g.id = am.member_org and g.status = 'active'
      where am.account_id = a order by (am.member_org::text = o) desc, am.last_used_at desc nulls last, g.name loop
    perform set_config('pulse.org_id', m.member_org::text, true);
    perform set_config('pulse.viewer_id', '', true);
    select exists(select 1 from person p where p.id = m.person_id and p.status = 'active') into ok;
    perform set_config('pulse.org_id', o, true);
    perform set_config('pulse.viewer_id', vw, true);
    if ok then
      seat_org := m.member_org; seat_person := m.person_id; org_name := m.name; org_handle := m.handle; seat_kind := m.kind; is_current := m.member_org::text = o;
      return next;
    end if;
  end loop;
end $$;

-- One seat's day, read as the viewer inside the organisation now open (SECURITY INVOKER: that organisation's row-level
-- security decides every row). Tasks of the viewer that are open and dated up to the end of this week (overdue too),
-- in Doing, starting by then or high priority; finished today; the running clock; time today and this week by project
-- and workstream; the targets.
create function pulse.my_day_seat() returns jsonb language plpgsql stable set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); tz text := org_time_zone(); today date := (now() at time zone org_time_zone())::date;
  wk date; wk_end date; day_start timestamptz; wk_end_ts timestamptz; accent text; trole text; tasks jsonb; timer jsonb; time_today jsonb; time_week jsonb;
  targets jsonb; counts jsonb; undated int;
begin
  if me is null then return null; end if;
  wk := date_trunc('week', today)::date; wk_end := wk + 6;
  day_start := today::timestamp at time zone tz; wk_end_ts := (wk_end + 1)::timestamp at time zone tz;
  begin select b.accent into accent from org_brand b where b.org_id = current_org() limit 1; exception when others then accent := null; end;
  select coalesce(jsonb_agg(x order by x."dueAt" nulls last, x.title), '[]'::jsonb) into tasks from (
    select t.id, t.title, t.status, t.stage, t.priority, t.due_at "dueAt", (t.due_at at time zone tz)::date::text "dueOn",
      to_char(t.due_at at time zone tz, 'HH24:MI') "dueTime", t.work_on::text "workOn", t.starts_on::text "startsOn", t.estimate_minutes "estimateMinutes",
      t.project_id "projectId", coalesce(pr.title, pr.name) "projectName", wp.color "projectColor", wp.workstream, t.parent_id "parentId",
      (select r.every from task_repeat r where r.task_id = t.id) "repeats", t.done_at "doneAt",
      coalesce((select sum(e.minutes) from time_entry e where e.task_id = t.id and e.person_id = me and e.retired_at is null and e.status <> 'dismissed' and e.work_date = today), 0)::int "minutesToday"
    from task t left join project pr on pr.id = t.project_id left join work_project wp on wp.project_id = t.project_id
    where coalesce(t.assignee_person_id, t.owner_id) = me and t.deleted_at is null
      and ((t.status in ('open', 'in_progress', 'blocked', 'unknown') and (t.due_at < wk_end_ts or t.status = 'in_progress' or t.work_on <= wk_end or t.starts_on <= wk_end or t.priority in ('high', 'urgent')))
        or (t.status in ('done', 'in_review', 'accepted') and t.done_at >= day_start))
    order by t.due_at nulls last limit 200) x;
  select count(*)::int into undated from task t where coalesce(t.assignee_person_id, t.owner_id) = me and t.deleted_at is null and t.status in ('open', 'unknown')
    and t.due_at is null and t.work_on is null and t.starts_on is null and t.priority in ('low', 'normal');
  select jsonb_build_object('taskId', tt.task_id, 'title', t.title, 'startedAt', tt.started_at, 'projectId', t.project_id, 'workstream', wp.workstream) into timer
    from task_timer tt join task t on t.id = tt.task_id left join work_project wp on wp.project_id = t.project_id
    where tt.person_id = me and tt.ended_at is null limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('projectId', g.project_id, 'projectName', g.name, 'workstream', g.workstream, 'color', g.color, 'minutes', g.minutes) order by g.minutes desc), '[]'::jsonb) into time_today
    from (select e.project_id, coalesce(pr.title, pr.name) name, wp.workstream, wp.color, sum(e.minutes)::int minutes from time_entry e
      left join project pr on pr.id = e.project_id left join work_project wp on wp.project_id = e.project_id
      where e.person_id = me and e.retired_at is null and e.status <> 'dismissed' and e.work_date = today group by 1, 2, 3, 4) g;
  select coalesce(jsonb_agg(jsonb_build_object('workstream', g.workstream, 'minutes', g.minutes) order by g.minutes desc), '[]'::jsonb) into time_week
    from (select wp.workstream, sum(e.minutes)::int minutes from time_entry e left join work_project wp on wp.project_id = e.project_id
      where e.person_id = me and e.retired_at is null and e.status <> 'dismissed' and e.work_date between wk and today group by 1) g;
  select pp.role into trole from people_profile pp where pp.person_id = me limit 1;
  select jsonb_build_object(
      'dailyMinutes', coalesce(tt.daily_minutes, case when wt.weekly_hours_min is not null then round(wt.weekly_hours_min * 60 / 5.0)::int end),
      'weeklyMinutes', coalesce(tt.weekly_minutes, case when wt.weekly_hours_min is not null then round(wt.weekly_hours_min * 60)::int end),
      'own', tt.person_id is not null,
      'tasksPerWeek', (select (x ->> 'perWeek')::int from jsonb_array_elements(work_role_targets()) x where trole is not null and lower(x ->> 'role') = lower(trole) limit 1),
      'unit', (select x ->> 'unit' from jsonb_array_elements(work_role_targets()) x where trole is not null and lower(x ->> 'role') = lower(trole) limit 1)) into targets
    from (select 1) one left join person_time_target tt on tt.person_id = me left join person_work_terms wt on wt.person_id = me;
  select jsonb_build_object(
      'minutesWeek', coalesce((select sum(e.minutes) from time_entry e where e.person_id = me and e.retired_at is null and e.status <> 'dismissed' and e.work_date between wk and today), 0)::int,
      'doneToday', (select count(*) from task t where coalesce(t.assignee_person_id, t.owner_id) = me and t.deleted_at is null and t.status in ('done', 'in_review', 'accepted') and t.done_at >= day_start)::int,
      'doneWeek', (select count(*) from task t where coalesce(t.assignee_person_id, t.owner_id) = me and t.deleted_at is null and t.status in ('done', 'in_review', 'accepted') and t.done_at >= wk::timestamp at time zone tz)::int,
      'undated', undated) into counts;
  return jsonb_build_object('today', today, 'weekStart', wk, 'timeZone', tz, 'accent', accent, 'tasks', tasks, 'timer', timer,
    'timeToday', time_today, 'timeWeek', time_week, 'targets', targets, 'counts', counts);
end $$;

revoke all on function pulse.task_stage_follow(), pulse.task_stage_set(uuid, text, text), pulse.task_plan_set(uuid, jsonb), pulse.time_target_set(jsonb),
  pulse.task_repeat_make(uuid, date), pulse.task_repeat_tick(), pulse.task_repeat_rule_set(uuid, jsonb), pulse.task_repeat_get(uuid),
  pulse.task_timer_close_elsewhere(uuid, uuid), pulse.account_seats(), pulse.my_day_seat() from public;
grant execute on function pulse.task_stage_set(uuid, text, text), pulse.task_plan_set(uuid, jsonb), pulse.time_target_set(jsonb),
  pulse.task_repeat_rule_set(uuid, jsonb), pulse.task_repeat_get(uuid), pulse.account_seats(), pulse.my_day_seat() to pulse_api;
grant execute on function pulse.task_repeat_tick() to pulse_worker;

-- migrate:down
-- Forward-only.
