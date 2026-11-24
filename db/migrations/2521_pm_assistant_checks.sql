-- migrate:up
-- PM-BUILD-4 (KAZUK-PM-2 phase 4, "the assistant"): each person's assistant asks about their own steps, by rules (SQL),
-- with a budget, and never marks anything done itself. The question is a step card (2520) on My day, with one notice.
--  * End of day, once (from 17:00 in the company's time zone): the person's open plan steps they worked on today (their
--    own status change, draft round, proof or timer on it today), and
--    the ones past their due day with no update for 2 days; at most 3, worst first: "Is “Model video” done? Done / Not
--    yet". One batched check a day (pulse.assistant_check counts what was asked and answered).
--  * Someone downstream is blocked: a person's step is past due and another person's open step waits on it (the
--    template's "after"): one card at once, "Rifob is waiting on this for “Edit the reel”", once a day per step. It
--    is not part of the budget, and "Stop checking on me" does not stop it (someone else is waiting).
--  * "Stop checking on me": no end-of-day checks until one of the person's steps is more than 3 working days late (their
--    steps going stale ends the quiet; pulse.assistant_pref).
--  * Only the person answers (2520's pm_step_card_answer: only a person; Done goes through task_move and its guards).
--    The rules never touch a clock, a gate, a milestone, an ongoing or a client's step.
-- Additive: two tables, a column on step_card, functions; pulse.pm_checkins_run() runs every 10 minutes with the late-work
-- questions (services/api/src/project-stages.ts runDelays), one company at a time.

select pulse.check_values_add('pulse.step_card'::regclass, 'step_card_kind_check', 'kind', array['checkin']);
alter table pulse.step_card add column on_day date;
create unique index step_card_checkin on pulse.step_card (org_id, person_id, source_task, on_day) where kind = 'checkin';

create table pulse.assistant_check (
  org_id uuid not null references pulse.org(id),
  person_id uuid not null references pulse.person(id),
  day date not null,
  asked int not null default 0 check (asked >= 0),
  answered int not null default 0 check (answered >= 0),
  primary key (org_id, person_id, day)
);
alter table pulse.assistant_check enable row level security;
alter table pulse.assistant_check force row level security;
create policy tenant on pulse.assistant_check using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy mine on pulse.assistant_check as restrictive for select to pulse_api using (person_id = pulse.current_viewer());
grant select on pulse.assistant_check to pulse_api;

create table pulse.assistant_pref (
  org_id uuid not null references pulse.org(id),
  person_id uuid not null references pulse.person(id),
  quiet boolean not null default false,
  quiet_since timestamptz,
  ended_at timestamptz,
  ended_why text check (length(ended_why) <= 200),
  primary key (org_id, person_id)
);
alter table pulse.assistant_pref enable row level security;
alter table pulse.assistant_pref force row level security;
create policy tenant on pulse.assistant_pref using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy mine on pulse.assistant_pref as restrictive for select to pulse_api using (person_id = pulse.current_viewer());
grant select on pulse.assistant_pref to pulse_api;

-- "Stop checking on me" (on) or "Check on me again" (off): the person's own, and only a person.
create function pulse.assistant_quiet_set(p_on boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer();
begin
  if not plan_by_person() then raise exception 'Only a person changes their own check-ins' using errcode = '42501'; end if;
  insert into assistant_pref (org_id, person_id, quiet, quiet_since) values (current_org(), me, coalesce(p_on, true), case when coalesce(p_on, true) then now() end)
    on conflict (org_id, person_id) do update set quiet = excluded.quiet, quiet_since = excluded.quiet_since, ended_at = case when excluded.quiet then null else now() end,
      ended_why = case when excluded.quiet then null else 'turned on again' end;
  if coalesce(p_on, true) then
    update step_card set state = 'expired' where org_id = current_org() and person_id = me and kind = 'checkin' and state = 'open' and quote not like 'Waiting on you:%';
  end if;
  return jsonb_build_object('quiet', coalesce(p_on, true));
end $$;

-- Working days (Sundays off) after p_from up to p_to.
create function pulse.pm_work_days(p_from date, p_to date) returns int
  language sql immutable set search_path = pulse, pg_temp as $$
  select count(*)::int from generate_series(p_from + 1, p_to, interval '1 day') d where extract(dow from d) <> 0
$$;

-- One company's check-ins (pulse.org_id set by the caller), at p_at (default now; tests pass a time). Returns how many cards it made.
create function pulse.pm_checkins_run(p_at timestamptz default null) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare tz text := org_time_zone(); now_local timestamp := coalesce(p_at, now()) at time zone org_time_zone(); today date := (coalesce(p_at, now()) at time zone org_time_zone())::date;
  r record; made int := 0; n int; who text;
begin
  -- Interrupts: a late step that someone else's open step waits on. The late steps first (few), then each of their
  -- plans' templates read once (pulse.plan_steps_of), then who waits on them.
  for r in
    with late as materialized (
      select t.id, t.title, t.template_step code, t.project_id, coalesce(t.assignee_person_id, t.owner_id) person
        from task t
       where t.org_id = current_org() and t.deleted_at is null and t.parent_id is null and t.template_step is not null and t.status in ('open', 'in_progress')
         and t.due_at is not null and (t.due_at at time zone tz)::date < today and coalesce(t.assignee_person_id, t.owner_id) is not null
         and exists (select 1 from project_plan pl where pl.org_id = t.org_id and pl.project_id = t.project_id)),
    ps as materialized (select x.project_id, s.* from (select distinct project_id from late) x, lateral plan_steps_of(x.project_id) s),
    waits as (
      select distinct on (l.id) l.*, d.title dtitle, d.template_step dcode, dp.display_name dname
        from late l
        join ps lt on lt.project_id = l.project_id and lt.code = l.code and lt.typ not in ('gate', 'milestone', 'auto', 'ongoing', 'repeating') and not lt.client
        join ps dw on dw.project_id = l.project_id and dw.after ? l.code
        join task d on d.org_id = current_org() and d.project_id = l.project_id and d.template_step = dw.code and d.deleted_at is null and d.status in ('open', 'blocked')
          and coalesce(d.assignee_person_id, d.owner_id) is not null and coalesce(d.assignee_person_id, d.owner_id) <> l.person
        join person dp on dp.id = coalesce(d.assignee_person_id, d.owner_id)
       where exists (select 1 from person p where p.id = l.person and p.side in ('staff', 'freelancer') and p.status = 'active'
                       and not exists (select 1 from agent_member am where am.person_id = p.id))
       order by l.id, d.due_at nulls last)
    select * from waits
  loop
    insert into step_card (org_id, person_id, project_id, kind, source_task, on_day, what, quote, candidates)
      values (current_org(), r.person, r.project_id, 'checkin', r.id, today, 'done', left(format('Waiting on you: %s needs it for “%s”', split_part(r.dname, ' ', 1), regexp_replace(r.dtitle, '^\s*' || r.dcode || '\s+', '', 'i')), 300),
              jsonb_build_array(jsonb_build_object('id', r.id, 'code', r.code, 'title', left(regexp_replace(r.title, '^\s*' || r.code || '\s+', '', 'i'), 120), 'status', 'open')))
      on conflict do nothing;
    if found then made := made + 1;
      perform notification_emit(r.person, 'task.due_soon', 'task', r.id, left(format('checkin:wait:%s:%s', r.id, today), 200),
        left(format('%s is waiting on “%s”. Is it done?', split_part(r.dname, ' ', 1), regexp_replace(r.title, '^\s*' || r.code || '\s+', '', 'i')), 160), '/my-day', 'task');
    end if;
  end loop;

  -- Stale steps end a person's quiet: any of their steps more than 3 working days late.
  update assistant_pref ap set quiet = false, ended_at = now(), ended_why = 'a step went more than 3 working days late'
   where ap.org_id = current_org() and ap.quiet and exists (
     select 1 from task t where t.org_id = ap.org_id and coalesce(t.assignee_person_id, t.owner_id) = ap.person_id and t.deleted_at is null and t.template_step is not null
       and t.status in ('open', 'in_progress', 'blocked') and t.due_at is not null and (t.due_at at time zone tz)::date < today - 3
       and pm_work_days((t.due_at at time zone tz)::date, today) > 3
       and exists (select 1 from plan_steps_of(t.project_id) s where s.code = t.template_step and s.typ not in ('gate', 'milestone', 'auto', 'ongoing', 'repeating')));

  -- The end-of-day check, once a day per person, from 17:00.
  if now_local::time < time '17:00' then return made; end if;
  for r in
    with cand0 as materialized (
      select t.id, t.title, t.template_step code, t.project_id, coalesce(t.assignee_person_id, t.owner_id) person,
             exists (select 1 from task_event e where e.task_id = t.id and e.actor_id = coalesce(t.assignee_person_id, t.owner_id) and e.kind in ('status', 'step', 'proof', 'timer') and (e.at at time zone tz)::date = today) touched,
             case when t.due_at is not null and (t.due_at at time zone tz)::date < today then pm_work_days((t.due_at at time zone tz)::date, today) else 0 end late,
             (t.due_at at time zone tz)::date due, coalesce(t.updated_at, t.created_at) < now() - interval '2 days' quiet
        from task t join project_plan pl on pl.org_id = t.org_id and pl.project_id = t.project_id
       where t.org_id = current_org() and t.deleted_at is null and t.parent_id is null and t.template_step is not null and t.status in ('open', 'in_progress')
         and coalesce(t.assignee_person_id, t.owner_id) is not null
         and not exists (select 1 from assistant_pref ap where ap.org_id = current_org() and ap.person_id = coalesce(t.assignee_person_id, t.owner_id) and ap.quiet)
         and not exists (select 1 from assistant_check ac where ac.org_id = current_org() and ac.person_id = coalesce(t.assignee_person_id, t.owner_id) and ac.day = today)),
    cand1 as materialized (select * from cand0 where touched or (late > 0 and quiet)),
    ps as materialized (select x.project_id, s.* from (select distinct project_id from cand1) x, lateral plan_steps_of(x.project_id) s),
    cand as (
      select c.id, c.title, c.code, c.project_id, c.person, c.touched, c.late, c.due from cand1 c
        join ps on ps.project_id = c.project_id and ps.code = c.code and ps.typ not in ('gate', 'milestone', 'auto', 'ongoing', 'repeating') and not ps.client),
    ranked as (
      select c.*, row_number() over (partition by c.person order by c.late desc, c.touched desc, c.due nulls last, c.code) rn from cand c
       where exists (select 1 from person p where p.id = c.person and p.side in ('staff', 'freelancer') and p.status = 'active'
                       and not exists (select 1 from agent_member am where am.person_id = p.id))
         and not exists (select 1 from step_card s where s.org_id = current_org() and s.person_id = c.person and s.kind = 'checkin' and s.source_task = c.id and s.state = 'open'))
    select * from ranked where rn <= 3 order by person, rn
  loop
    insert into step_card (org_id, person_id, project_id, kind, source_task, on_day, what, quote, candidates)
      values (current_org(), r.person, r.project_id, 'checkin', r.id, today, 'done',
              case when r.late > 0 then format('Due %s, %s working %s ago', to_char(r.due, 'DD Mon'), r.late, case when r.late = 1 then 'day' else 'days' end) else 'You worked on it today' end,
              jsonb_build_array(jsonb_build_object('id', r.id, 'code', r.code, 'title', left(regexp_replace(r.title, '^\s*' || r.code || '\s+', '', 'i'), 120), 'status', 'open')))
      on conflict do nothing;
    if found then
      made := made + 1;
      insert into assistant_check (org_id, person_id, day, asked) values (current_org(), r.person, today, 1)
        on conflict (org_id, person_id, day) do update set asked = assistant_check.asked + 1;
    end if;
  end loop;
  -- One notice per person checked today.
  for r in select ac.person_id, ac.asked, (select s.source_task from step_card s where s.org_id = ac.org_id and s.person_id = ac.person_id and s.kind = 'checkin' and s.on_day = today
                                               and s.quote not like 'Waiting on you:%' order by s.created_at limit 1) first
             from assistant_check ac where ac.org_id = current_org() and ac.day = today and ac.asked > 0 loop
    perform notification_emit(r.person_id, 'task.due_soon', 'task', r.first, left(format('checkin:day:%s:%s', r.person_id, today), 200),
      format('Quick check for today: %s %s', r.asked, case when r.asked = 1 then 'step' else 'steps' end), '/my-day', 'task');
  end loop;
  return made;
end $$;

-- An answered check-in counts on the day's row (the 2520 answer function stays the one way to answer).
create function pulse.assistant_check_answered() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  update assistant_check set answered = answered + 1 where org_id = new.org_id and person_id = new.person_id and day = new.on_day;
  return null;
end $$;
create trigger assistant_check_answered after update of state on pulse.step_card for each row
  when (new.kind = 'checkin' and old.state = 'open' and new.state in ('yes', 'no'))
  execute function pulse.assistant_check_answered();

-- The person's own check-in state for My day.
create function pulse.assistant_state() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('quiet', coalesce((select quiet from assistant_pref where org_id = current_org() and person_id = current_viewer()), false),
    'endedWhy', (select ended_why from assistant_pref where org_id = current_org() and person_id = current_viewer() and not quiet and ended_at > now() - interval '3 days'),
    'today', (select jsonb_build_object('asked', asked, 'answered', answered) from assistant_check where org_id = current_org() and person_id = current_viewer()
               and day = (now() at time zone org_time_zone())::date))
$$;

revoke all on function pulse.assistant_quiet_set(boolean), pulse.pm_work_days(date, date), pulse.pm_checkins_run(timestamptz), pulse.assistant_check_answered(), pulse.assistant_state() from public;
grant execute on function pulse.assistant_quiet_set(boolean), pulse.pm_work_days(date, date), pulse.pm_checkins_run(timestamptz), pulse.assistant_state() to pulse_api;

-- migrate:down
drop trigger if exists assistant_check_answered on pulse.step_card;
drop function if exists pulse.assistant_state();
drop function if exists pulse.assistant_check_answered();
drop function if exists pulse.pm_checkins_run(timestamptz);
drop function if exists pulse.pm_work_days(date, date);
drop function if exists pulse.assistant_quiet_set(boolean);
drop table if exists pulse.assistant_pref;
drop table if exists pulse.assistant_check;
drop index if exists pulse.step_card_checkin;
alter table pulse.step_card drop column if exists on_day;
