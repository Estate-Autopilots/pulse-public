-- migrate:up
-- PM-BUILD-3 (22 Nov 2026): the Mac's project-management design (SPEC v1.1, 21 Nov) on the existing delivery plan
-- (1385/1387/2262/2310). No new module and no new table: two columns and three functions.
--  * Clocks have a planned day as well as the day they happened (SPEC 0.5.1). project_plan.clock_plan keeps a planned
--    day a person set for a clock that has not happened yet ({"day0": "2026-11-24"}). Without one, the planned day is
--    the clock's own step's date (Estate Autopilots: O14 "Inputs complete", 7 days after the invoice is paid), else the
--    template's day count from the clock before it (J3 "Ads live", Day 0 + 21). pulse.plan_clock_day gives a clock's day:
--    the day it happened, else its planned day. Steps on a clock that has not happened keep no stored date (PM-BUILD-1);
--    the screens show their planned dates, worked out the same way.
--  * Every plan step keeps the first due date it was given (task.baseline_due_at, SPEC 0.5.1), so a slip is computable.
--  * pulse.project_clock_move moves a clock: its planned day, or the day it happened when a person recorded the wrong
--    day. It shows what moves first (p_apply false: nothing is written), then moves it: the clock's open steps that no
--    person moved one by one, and the clocks after it while they have not happened. A reason from the plan's own list
--    is required; only who may move the plan's dates moves it (the template's moveDates: Estate Autopilots' PGS, with
--    leadership stepping in, logged); never an AI employee, a connected AI app or an automation. Logged on
--    project_date_change (the clock's own step) and the steps' history; each owner of a moved step is told once.

alter table pulse.project_plan add column clock_plan jsonb not null default '{}'::jsonb,
  add constraint project_plan_clock_plan check (jsonb_typeof(clock_plan) = 'object' and pg_column_size(clock_plan) < 4000);
comment on column pulse.project_plan.clock_plan is 'PM-BUILD-3 (2510): planned days a person set for clocks that have not happened yet, {"day0": "2026-11-24", "live": "2027-01-08"}';

alter table pulse.task add column baseline_due_at timestamptz;
comment on column pulse.task.baseline_due_at is 'PM-BUILD-3 (2510): a plan step''s first due date (SPEC 0.5.1); a step has slipped when its due date is later';

create function pulse.task_baseline_due() returns trigger
  language plpgsql set search_path = pulse, pg_temp as $$
begin
  new.baseline_due_at := new.due_at;
  return new;
end $$;
create trigger task_baseline_due before insert or update of due_at on pulse.task for each row
  when (new.template_step is not null and new.baseline_due_at is null and new.due_at is not null) execute function pulse.task_baseline_due();
-- Plan steps already dated keep that date as their baseline (production: one plan).
update pulse.task set baseline_due_at = due_at where template_step is not null and due_at is not null and baseline_due_at is null and deleted_at is null;

-- A clock's day: the day it happened, else its planned day (a person's, else its step's date, else the template's count
-- from the clock it counts from). Null when it can't be worked out yet.
create function pulse.plan_clock_day(p_project uuid, p_clock text) returns date
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare pl pulse.project_plan; def jsonb; c jsonb; st jsonb; b int; base date; due date; depth int := 0;
begin
  select * into pl from pulse.project_plan where org_id = pulse.current_org() and project_id = p_project;
  if pl.project_id is null then return null; end if;
  if p_clock = 'start' then return pl.kickoff; end if;
  if p_clock = 'day0' and pl.day0_on is not null then return pl.day0_on; end if;
  if p_clock = 'live' and pl.live_on is not null then return pl.live_on; end if;
  if pl.clock_plan ? p_clock and pl.clock_plan->>p_clock ~ '^\d{4}-\d{2}-\d{2}$' then return (pl.clock_plan->>p_clock)::date; end if;
  def := pulse.plan_definition(p_project);
  select x into c from jsonb_array_elements(coalesce(def->'clocks', '[]'::jsonb)) x where x->>'key' = p_clock limit 1;
  if c is null or nullif(c->>'step', '') is null then return null; end if;
  -- The clock's own step, when it has a date (a person may have moved it).
  select (t.due_at at time zone pulse.org_time_zone())::date into due from pulse.task t
   where t.org_id = pulse.current_org() and t.project_id = p_project and t.template_step = c->>'step' and t.deleted_at is null
     and t.status not in ('cancelled', 'not_applicable', 'merged') and t.due_at is not null order by t.created_at limit 1;
  if due is not null then return due; end if;
  select x into st from jsonb_array_elements(coalesce(def->'steps', '[]'::jsonb)) x where x->>'id' = c->>'step' limit 1;
  if st is null then return null; end if;
  b := coalesce(case when pl.package is not null and st->'byPackage'->pl.package ? 'end' then (st->'byPackage'->pl.package->>'end')::int end,
    (st->>'end')::int, (st->>'start')::int);
  base := case coalesce(st->>'from', 'start')
    when 'start' then pl.kickoff
    when 'day0' then case when p_clock <> 'day0' then pulse.plan_clock_day(p_project, 'day0') end
    else null end;
  return case when base is null or b is null then null else base + b end;
end $$;

-- Move a clock (day0 or live). p_apply false: only says what would move. Returns the clock, its old and new day, the
-- shift in days, the steps that move (id, code, title, from, to; planned dates when the clock has not happened) and
-- the later clocks that move with it.
create function pulse.project_clock_move(p_project uuid, p_clock text, p_on date, p_reason text, p_note text, p_apply boolean)
  returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); pl pulse.project_plan; pr pulse.project; def jsonb; c jsonb; lbl text; rlbl text; reasons jsonb;
  note text := nullif(btrim(coalesce(p_note, '')), ''); old date; shift int; happened boolean; stepped boolean := false; tz text := pulse.org_time_zone();
  clocks text[]; base date; moves jsonb := '[]'::jsonb; later jsonb := '[]'::jsonb; ids uuid[] := '{}'; k text; anchor uuid; r record; owners uuid[]; o uuid; n int; first uuid;
begin
  if not pulse.plan_by_person() then raise exception 'Only a person moves the dates of a delivery plan' using errcode = '42501'; end if;
  select * into pl from pulse.project_plan where org_id = pulse.current_org() and project_id = p_project for update;
  if pl.project_id is null then raise exception 'This project has no delivery plan' using errcode = 'P0002'; end if;
  select * into pr from pulse.project where id = p_project and deleted_at is null;
  def := pulse.plan_definition(p_project);
  select x into c from jsonb_array_elements(coalesce(def->'clocks', '[]'::jsonb)) x where x->>'key' = p_clock limit 1;
  if c is null or p_clock not in ('day0', 'live') then raise exception 'Choose a clock this plan has (Day 0 or going live)' using errcode = '22023'; end if;
  lbl := coalesce(nullif(c->>'label', ''), p_clock);
  -- Who moves the plan's dates (as project_reschedule): the template's rule, else the project's runners.
  if def->>'moveDates' = 'lead' then
    if me is distinct from pr.lead_person_id then
      if pulse.viewer_is('admin', 'leadership') then stepped := true;
      else raise exception 'Only the project''s lead moves the dates of this plan' using errcode = '42501'; end if;
    end if;
  elsif not pulse.project_can_run(p_project) then
    raise exception 'Only the project''s lead, its manager and leadership move its dates' using errcode = '42501';
  end if;
  if p_on is null then raise exception 'Choose the new day for %', lbl using errcode = '22023'; end if;
  happened := (p_clock = 'day0' and pl.day0_on is not null) or (p_clock = 'live' and pl.live_on is not null);
  old := pulse.plan_clock_day(p_project, p_clock);
  if old is null then raise exception '% has no day yet to move', lbl using errcode = '22023'; end if;
  shift := p_on - old;
  if p_on < pl.kickoff then raise exception '% can''t be before the plan started (%)', lbl, to_char(pl.kickoff, 'DD Mon YYYY') using errcode = '22023'; end if;
  if p_clock = 'live' and p_on < coalesce(pulse.plan_clock_day(p_project, 'day0'), pl.kickoff) then
    raise exception '% can''t be before %', lbl, to_char(pulse.plan_clock_day(p_project, 'day0'), 'DD Mon YYYY') using errcode = '22023'; end if;
  if happened and p_on > (now() at time zone tz)::date then raise exception '% happened already: its day can''t be in the future', lbl using errcode = '22023'; end if;
  if p_clock = 'day0' and pl.live_on is not null and p_on > pl.live_on then
    raise exception '% can''t be after the day it went live (%)', lbl, to_char(pl.live_on, 'DD Mon YYYY') using errcode = '22023'; end if;
  -- The clocks that move: this one, and the live clock after Day 0 while it has not happened.
  clocks := array[p_clock] || case when p_clock = 'day0' and pl.live_on is null then array['live'] else '{}'::text[] end;
  -- The steps that move: open steps on those clocks that no person moved one by one. A clock that happened moves the
  -- stored dates; one that has not happened moves the planned dates (worked out, not stored).
  for r in select t.id, t.template_step code, t.title, (t.due_at at time zone tz)::date due, coalesce(t.assignee_person_id, t.owner_id) who,
        coalesce(s.st->>'from', 'start') clk, coalesce(case when pl.package is not null and s.st->'byPackage'->pl.package ? 'end' then (s.st->'byPackage'->pl.package->>'end')::int end,
          (s.st->>'end')::int) off
      from pulse.task t join lateral (select x st from jsonb_array_elements(coalesce(def->'steps', '[]'::jsonb)) x where x->>'id' = t.template_step limit 1) s on true
     where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.parent_id is null
       and t.status in ('open', 'in_progress', 'blocked', 'in_review', 'unknown') and coalesce(s.st->>'from', 'start') = any(clocks)
     order by 7 nulls last, 2 loop
    continue when r.off is null;
    base := case when r.clk = p_clock then old else pulse.plan_clock_day(p_project, r.clk) end;
    continue when base is null;
    -- A clock that happened moves the stored dates no person changed (still its day + the step's days); one that has
    -- not happened moves planned dates, and a date stored there is a person's own, which stays.
    if r.clk = p_clock and happened then continue when r.due is distinct from base + r.off;
    else continue when r.due is not null; end if;
    moves := moves || jsonb_build_object('id', r.id, 'code', r.code, 'title', r.title, 'clock', r.clk, 'from', base + r.off, 'to', base + r.off + shift, 'stored', r.due is not null);
    ids := ids || r.id;
    if r.who is not null and r.who is distinct from me and not r.who = any(coalesce(owners, '{}')) then owners := coalesce(owners, '{}') || r.who; end if;
  end loop;
  select coalesce(jsonb_agg(m order by m->>'from', m->>'code'), '[]'::jsonb) into moves from jsonb_array_elements(moves) m;
  if p_clock = 'day0' and pl.live_on is null then
    later := jsonb_build_array(jsonb_build_object('clock', 'live', 'label', coalesce((select x->>'label' from jsonb_array_elements(def->'clocks') x where x->>'key' = 'live'), 'live'),
      'from', pulse.plan_clock_day(p_project, 'live'), 'to', pulse.plan_clock_day(p_project, 'live') + shift));
  end if;
  if not coalesce(p_apply, false) or shift = 0 then
    return jsonb_build_object('clock', p_clock, 'label', lbl, 'from', old, 'to', p_on, 'days', shift, 'happened', happened, 'steps', jsonb_array_length(moves),
      'moves', moves, 'later', later, 'applied', false, 'steppedIn', stepped);
  end if;
  -- The reason, from the plan's own list (Kazuk's seven at Estate Autopilots), else Pulse's.
  reasons := case when jsonb_typeof(def->'reasons') = 'array' and jsonb_array_length(def->'reasons') > 0 then def->'reasons' end;
  if reasons is not null then
    select x->>'label' into rlbl from jsonb_array_elements(reasons) x where x->>'key' = p_reason;
  elsif p_reason in ('client_delay', 'our_delay', 'client_paused', 'ea_hold', 'scope_change', 'other') then rlbl := replace(p_reason, '_', ' ');
  end if;
  if rlbl is null then raise exception 'Choose why the dates change' using errcode = '22023'; end if;
  if p_reason = 'other' and note is null then raise exception 'Say why the dates change' using errcode = '22023'; end if;
  if note is not null and length(note) > 250 then raise exception 'Keep the note under 250 letters' using errcode = '22023'; end if;
  -- Write: the clock's day, the stored dates of a clock that happened, the steps' history, the log, one notice each.
  if happened then
    if p_clock = 'day0' then update pulse.project_plan set day0_on = p_on, updated_at = now() where org_id = pulse.current_org() and project_id = p_project;
    else update pulse.project_plan set live_on = p_on, updated_at = now() where org_id = pulse.current_org() and project_id = p_project; end if;
  else
    update pulse.project_plan set clock_plan = clock_plan || jsonb_build_object(p_clock, p_on::text), updated_at = now() where org_id = pulse.current_org() and project_id = p_project;
  end if;
  -- A later clock a person had planned moves by the same days.
  if p_clock = 'day0' and pl.live_on is null and pl.clock_plan ? 'live' and pl.clock_plan->>'live' ~ '^\d{4}-\d{2}-\d{2}$' then
    update pulse.project_plan set clock_plan = clock_plan || jsonb_build_object('live', ((pl.clock_plan->>'live')::date + shift)::text) where org_id = pulse.current_org() and project_id = p_project;
  end if;
  update pulse.task t set due_at = t.due_at + make_interval(days => shift), work_on = t.work_on + shift, updated_at = now(), edited_by = me
   where t.org_id = pulse.current_org() and t.id = any(ids) and t.due_at is not null;
  -- The clock's own step, while open and dated, moves with its planned day.
  if not happened then
    select t.id into anchor from pulse.task t where t.org_id = pulse.current_org() and t.project_id = p_project and t.template_step = c->>'step' and t.deleted_at is null
      and t.due_at is not null and t.status in ('open', 'in_progress', 'blocked', 'unknown') and not t.id = any(ids) order by t.created_at limit 1;
    if anchor is not null then
      update pulse.task t set due_at = ((p_on + coalesce((t.due_at at time zone tz)::time, time '18:00')) at time zone tz), updated_at = now(), edited_by = me where t.id = anchor;
    end if;
  end if;
  insert into pulse.task_event(org_id, task_id, actor_id, kind, from_value, to_value, note)
    select pulse.current_org(), x, me, 'edited', 'due', format('%s%s days', case when shift > 0 then '+' else '' end, shift),
      left(format('%s moved %s → %s: %s%s', lbl, to_char(old, 'DD Mon'), to_char(p_on, 'DD Mon'), rlbl, coalesce(': ' || note, '')), 1000)
      from unnest(ids || case when anchor is not null then array[anchor] else '{}'::uuid[] end) x;
  anchor := coalesce(anchor, (select t.id from pulse.task t where t.org_id = pulse.current_org() and t.project_id = p_project and t.template_step = c->>'step'
    and t.deleted_at is null order by t.created_at limit 1));
  if anchor is not null then
    insert into pulse.project_date_change(org_id, project_id, task_id, from_start, from_due, to_start, to_due, reason_kind, note, moved, changed_by)
      values (pulse.current_org(), p_project, anchor, null, old, null, p_on, p_reason,
        left(format('%s moved%s', lbl, coalesce(': ' || note, '')) || case when stepped then ' (leadership stepped in)' else '' end, 300), ids, me);
  end if;
  -- One notice per owner, on their first moved step (they can open it; the notice names how many of theirs moved).
  foreach o in array coalesce(owners, '{}') loop
    select count(*), (array_agg(t.id order by t.due_at nulls last, t.template_step))[1] into n, first from jsonb_array_elements(moves) m
      join pulse.task t on t.id = (m->>'id')::uuid where coalesce(t.assignee_person_id, t.owner_id) = o;
    perform pulse.work_notify(o, 'task.due_soon', 'task', first, left(format('clock.move:%s:%s:%s:%s', p_project, p_clock, p_on, o), 200),
      left(format('%s moved to %s on %s: %s of your steps %s %s days (%s)', lbl, to_char(p_on, 'DD Mon'), coalesce(pr.title, pr.name), n,
        case when n = 1 then 'moves' else 'move' end, case when shift > 0 then '+' || shift else shift::text end, rlbl), 160), '/tasks/projects/' || p_project, 'task');
  end loop;
  perform pulse.audit_write('project_clock_move', 'project', p_project::text);
  return jsonb_build_object('clock', p_clock, 'label', lbl, 'from', old, 'to', p_on, 'days', shift, 'happened', happened, 'steps', jsonb_array_length(moves),
    'moves', moves, 'later', later, 'applied', true, 'steppedIn', stepped, 'told', cardinality(coalesce(owners, '{}')));
end $$;
revoke all on function pulse.project_clock_move(uuid, text, date, text, text, boolean) from public;
grant execute on function pulse.project_clock_move(uuid, text, date, text, text, boolean) to pulse_api;
revoke all on function pulse.plan_clock_day(uuid, text) from public;
grant execute on function pulse.plan_clock_day(uuid, text) to pulse_api;

-- Approvals (the Mac's screen 05): what the viewer's projects shared for a client's OK and still wait on. The viewer's =
-- they own it, shared it, or lead its project; leadership and admins see every one. Client deliverables stay readable only
-- through functions (1066).
create function pulse.pm_client_waiting() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(x order by x->>'sharedOn'), '[]'::jsonb) from (
    select jsonb_build_object('id', d.id, 'title', d.title, 'kind', d.kind, 'version', d.version,
      'sharedOn', (d.shared_at at time zone pulse.org_time_zone())::date, 'answerBy', d.answer_by, 'clientId', d.client_id, 'client', cl.display_name,
      'projectId', d.project_id, 'project', coalesce(p.title, p.name), 'color', wp.color, 'icon', wp.icon,
      'sharedBy', (select display_name from pulse.person where id = d.shared_by), 'owner', (select display_name from pulse.person where id = d.owner_id), 'seen', d.seen_at is not null) x
    from pulse.client_deliverable d left join pulse.client cl on cl.id = d.client_id left join pulse.project p on p.id = d.project_id
      left join pulse.work_project wp on wp.project_id = d.project_id and wp.deleted_at is null
    where d.org_id = pulse.current_org() and d.state = 'waiting' and pulse.current_viewer() is not null
      and (d.owner_id = pulse.current_viewer() or d.shared_by = pulse.current_viewer() or p.lead_person_id = pulse.current_viewer() or wp.owner_id = pulse.current_viewer()
        or pulse.viewer_is('admin', 'leadership'))
    order by d.shared_at limit 200) q
$$;
revoke all on function pulse.pm_client_waiting() from public;
grant execute on function pulse.pm_client_waiting() to pulse_api;

-- migrate:down
drop function if exists pulse.pm_client_waiting();
drop function if exists pulse.project_clock_move(uuid, text, date, text, text, boolean);
drop function if exists pulse.plan_clock_day(uuid, text);
drop trigger if exists task_baseline_due on pulse.task;
drop function if exists pulse.task_baseline_due();
alter table pulse.task drop column if exists baseline_due_at;
alter table pulse.project_plan drop column if exists clock_plan;
