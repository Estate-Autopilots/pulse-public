-- migrate:up
-- PM-BUILD-1 (17 Nov 2026; KAZUK-PM-2 phase 1, "the plan on the right clocks"). Kazuk's Delivery Timeline v2 (9 Nov) and
-- build notes (10 Nov) say four things are fixed: a project is built from what was bought; going live starts every
-- client clock; day numbers are offsets and dates are worked out; and no step is ever marked done by the tool. This
-- widens the delivery template and the plan (1385/1387/1471); there is no new module.
--  * pulse.delivery_template_version: every saved version of a company's template. A plan keeps the version it was laid
--    out from (project_plan.template_version), so changing the template never moves a running project's steps.
--    pulse.delivery_template_save (admins and leadership, a person) checks a template and saves it as the next version.
--  * Clocks (template format 3): each step names the clock it counts from: start (the plan's start, e.g. the invoice
--    paid), day0 (every input is in, recorded by its gate step), live (going live, recorded by its milestone step) or
--    bought (an add-on's purchase; phase 2). A step on a clock not yet recorded has no date ("Ads live + 9 days"); when
--    the clock is recorded, pulse.project_plan_reclock dates its steps and keeps any date a person set or moved.
--  * pulse.project_day0_declare and pulse.project_live_record: the project's lead, its manager, the project heads or
--    leadership record the clock. Each refuses while its step's inputs are open and names them. An ongoing input (a
--    campaign set up and running) counts once it is In progress: it never reaches Done by design.
--  * Ticking the recording step done (O14, J3 in Estate Autopilots' template) records the clock the same way; a gate or
--    milestone can't be done while its inputs are open; a step with a "hold until" day can't be done before it.
--  * Only a person marks a plan step done: an AI employee, a connected AI app, a service key or an automation can move
--    it to In progress and no further (task_plan_guard), and Pulse's own "it happened, so it is done" leaves plan steps
--    alone (task_auto_blocker: plan_step).
--  * Running steps (ongoing or repeating work that has started) are never late: task_delays_sync does not ask about them.
--  * Estate Autopilots' template: its current copy is kept as version 2, and Kazuk's Delivery Timeline v2 (135 steps in
--    9 phases, read from the Google Doc by tools/timeline-to-template.mjs) becomes version 3. A plan laid out before
--    versions were kept stays on the copy it was laid out from (production has no plan yet), so nothing moves. Written
--    only to that company.

create table pulse.delivery_template_version(
  org_id uuid not null references pulse.org(id),
  key text not null,
  version int not null check (version between 1 and 100000),
  name text not null check (length(btrim(name)) between 1 and 120),
  definition jsonb not null check (jsonb_typeof(definition) = 'object' and pg_column_size(definition) < 400000),
  note text check (note is null or length(note) <= 500),
  saved_by uuid references pulse.person(id),
  saved_at timestamptz not null default now(),
  primary key (org_id, key, version),
  foreign key (org_id, key) references pulse.delivery_template(org_id, key));
alter table pulse.delivery_template_version enable row level security;
alter table pulse.delivery_template_version force row level security;
create policy tenant on pulse.delivery_template_version using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.delivery_template_version to pulse_api;
comment on table pulse.delivery_template_version is 'PM-BUILD-1 (2262): every saved version of a delivery template; a plan keeps the version it was laid out from';

alter table pulse.project_plan
  add column template_version int,
  add column day0_on date, add column day0_by uuid references pulse.person(id), add column day0_at timestamptz,
  add column live_on date, add column live_by uuid references pulse.person(id), add column live_at timestamptz,
  add constraint project_plan_clocks check (day0_on is null or day0_on >= kickoff),
  add constraint project_plan_live check (live_on is null or live_on >= coalesce(day0_on, kickoff));
comment on column pulse.project_plan.template_version is 'PM-BUILD-1 (2262): the template version the plan was laid out from (null: the template''s current copy)';
comment on column pulse.project_plan.day0_on is 'PM-BUILD-1 (2262): the day every input was in (Day 0), as declared; day0_by/day0_at say who declared it and when';
comment on column pulse.project_plan.live_on is 'PM-BUILD-1 (2262): the day the project went live; every live-clock step counts from it';

-- The definition a plan runs on: the version it was laid out from, else the template's current copy.
create function pulse.plan_definition(p_project uuid) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(v.definition, d.definition) from pulse.project_plan pl
    join pulse.delivery_template d on d.org_id = pl.org_id and d.key = pl.template_key
    left join pulse.delivery_template_version v on v.org_id = pl.org_id and v.key = pl.template_key and v.version = pl.template_version
   where pl.org_id = pulse.current_org() and pl.project_id = p_project
$$;

create function pulse.plan_step(p_project uuid, p_step text) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select x from jsonb_array_elements(coalesce(pulse.plan_definition(p_project)->'steps', '[]'::jsonb)) x where x->>'id' = p_step limit 1
$$;

-- A step's type (format 3), else its kind (formats 1 and 2).
create function pulse.plan_step_type(p_step jsonb) returns text
  language sql immutable set search_path = pulse, pg_temp as $$
  select coalesce(nullif(p_step->>'type', ''), nullif(p_step->>'kind', ''), 'task')
$$;

-- Running: an ongoing or repeating step that has started. Its setup is done and it runs while the work runs, so it is
-- never late and never counted as open work (Kazuk: "a setup card never reaches Done").
create function pulse.plan_step_running(p_project uuid, p_step text, p_status text) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(p_status = 'in_progress' and p_step is not null and p_project is not null
    and pulse.plan_step_type(pulse.plan_step(p_project, p_step)) in ('ongoing', 'repeating'), false)
$$;

-- The day a clock was recorded on (start is the plan's start; bought is per purchase, phase 2).
create function pulse.plan_clock_on(p_plan pulse.project_plan, p_clock text) returns date
  language sql immutable set search_path = pulse, pg_temp as $$
  select case coalesce(p_clock, 'start') when 'start' then p_plan.kickoff when 'day0' then p_plan.day0_on when 'live' then p_plan.live_on end
$$;

-- A step's due time and start day, worked out from its clock (other days per package when the step has them); nothing
-- while its clock is not recorded.
create function pulse.plan_step_due(p_plan pulse.project_plan, p_step jsonb, p_package text, out due timestamptz, out work_on date)
  language plpgsql stable set search_path = pulse, pg_temp as $$
declare base date := pulse.plan_clock_on(p_plan, p_step->>'from'); bp jsonb := p_step->'byPackage'->p_package; s int; e int;
begin
  if base is null then return; end if;
  s := coalesce((bp->>'start')::int, (p_step->>'start')::int, 0);
  e := case when bp is not null then (bp->>'end')::int else (p_step->>'end')::int end;
  due := case when e is null then null else ((base + e) + time '18:00') at time zone pulse.org_time_zone() end;
  work_on := base + greatest(0, s);
end $$;

-- Who records a clock or finishes a plan step: a person in their own session, not an AI employee, a connected AI app,
-- a service key, a route or a background job.
create function pulse.plan_by_person() returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select pulse.current_viewer() is not null and pulse.agent_session() is null and pulse.task_auto_source() is null
    and coalesce((select p.side <> 'agent' from pulse.person p where p.id = pulse.current_viewer()), false)
$$;

-- The first role named in a step's owner ("PGS + Creative Strategist" -> "PGS").
create function pulse.plan_step_role(p_step jsonb) returns text
  language sql immutable set search_path = pulse, pg_temp as $$
  select nullif(left(btrim(regexp_replace(coalesce(p_step->>'owner', ''), '\s*(\+|,| with ).*$', '')), 60), '')
$$;

-- The inputs of a gate or milestone step that are still open: a step with live work that is not finished (an ongoing or
-- repeating input counts once it runs). A step that was not made, or was cancelled, does not hold anything up.
create function pulse.plan_open_inputs(p_project uuid, p_step text) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  with st as (select pulse.plan_step(p_project, p_step) s),
  ins as (select i.v id, i.o from st cross join lateral jsonb_array_elements_text(coalesce(st.s->'gateInputs', st.s->'after', '[]'::jsonb)) with ordinality i(v, o))
  select coalesce(jsonb_agg(jsonb_build_object('id', ins.id, 'title', coalesce(pulse.plan_step(p_project, ins.id)->>'title', ins.id)) order by ins.o), '[]'::jsonb)
  from ins
  where exists(select 1 from pulse.task t where t.org_id = pulse.current_org() and t.project_id = p_project and t.template_step = ins.id and t.deleted_at is null
    and t.status not in ('done', 'accepted', 'in_review', 'cancelled', 'not_applicable', 'merged')
    and not (t.status = 'in_progress' and pulse.plan_step_type(pulse.plan_step(p_project, ins.id)) in ('ongoing', 'repeating')))
$$;

-- Check a template's definition; null when it is fine, else what is wrong in plain words.
create function pulse.delivery_template_check(p_def jsonb) returns text
  language plpgsql immutable set search_path = pulse, pg_temp as $$
declare ids text[]; s jsonb; a text;
begin
  if jsonb_typeof(p_def) <> 'object' or jsonb_typeof(p_def->'steps') is distinct from 'array' or jsonb_array_length(p_def->'steps') = 0 then return 'it has no steps'; end if;
  if jsonb_typeof(p_def->'stages') is distinct from 'array' or jsonb_typeof(p_def->'packages') is distinct from 'array' then return 'it needs its phases and packages'; end if;
  select array_agg(x->>'id') into ids from jsonb_array_elements(p_def->'steps') x;
  if exists(select 1 from unnest(ids) v where v is null or v !~ '^[A-Za-z0-9_-]{1,20}$') then return 'every step needs a short id'; end if;
  if (select count(distinct v) from unnest(ids) v) <> array_length(ids, 1) then return 'two steps have the same id'; end if;
  for s in select x from jsonb_array_elements(p_def->'steps') x loop
    if pulse.plan_step_type(s) not in ('task', 'approval', 'gate', 'milestone', 'ongoing', 'repeating', 'auto') then return format('step %s has a type Pulse does not know', s->>'id'); end if;
    if coalesce(s->>'from', 'start') not in ('start', 'day0', 'live', 'bought') then return format('step %s counts from a clock Pulse does not know', s->>'id'); end if;
    if not exists(select 1 from jsonb_array_elements(p_def->'stages') g where g->>'n' = s->>'stage') then return format('step %s is in a phase the template does not have', s->>'id'); end if;
    if nullif(btrim(s->>'title'), '') is null then return format('step %s has no title', s->>'id'); end if;
    for a in select jsonb_array_elements_text(coalesce(s->'after', '[]'::jsonb) || coalesce(s->'gateInputs', '[]'::jsonb)) loop
      if not a = any(ids) then return format('step %s waits on %s, which is not a step', s->>'id', a); end if;
    end loop;
  end loop;
  return null;
end $$;

-- Save a template as its next version (internal: the public save checks who asks). The copy in use before the first
-- save is kept as a version of its own, so nothing is lost.
create function pulse.delivery_template_file(p_key text, p_name text, p_def jsonb, p_note text) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); cur pulse.delivery_template; v int; bad text := pulse.delivery_template_check(p_def); nm text;
begin
  if bad is not null then raise exception 'The template can''t be saved: %', bad using errcode = '22023'; end if;
  select * into cur from pulse.delivery_template where org_id = pulse.current_org() and key = p_key for update;
  if cur.key is null then raise exception 'Template not found' using errcode = 'P0002'; end if;
  if not exists(select 1 from pulse.delivery_template_version where org_id = pulse.current_org() and key = p_key) then
    v := greatest(1, coalesce((case when cur.definition->>'version' ~ '^\d{1,5}$' then (cur.definition->>'version')::int end), 1));
    insert into pulse.delivery_template_version(org_id, key, version, name, definition, note, saved_by, saved_at)
      values (pulse.current_org(), p_key, v, cur.name, cur.definition, 'The copy in use before versions were kept', cur.updated_by, cur.updated_at);
    -- Plans laid out before versions were kept stay on the copy they were laid out from.
    update pulse.project_plan set template_version = v where org_id = pulse.current_org() and template_key = p_key and template_version is null;
  end if;
  select max(version) + 1 into v from pulse.delivery_template_version where org_id = pulse.current_org() and key = p_key;
  nm := coalesce(nullif(btrim(p_name), ''), cur.name);
  insert into pulse.delivery_template_version(org_id, key, version, name, definition, note, saved_by)
    values (pulse.current_org(), p_key, v, nm, p_def || jsonb_build_object('version', v), left(nullif(btrim(p_note), ''), 500), me);
  update pulse.delivery_template set name = nm, definition = p_def || jsonb_build_object('version', v), updated_by = me, updated_at = now()
    where org_id = pulse.current_org() and key = p_key;
  perform pulse.audit_write('delivery_template_save', 'delivery_template', p_key);
  return v;
end $$;

create function pulse.delivery_template_save(p_key text, p_name text, p_definition jsonb, p_note text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not pulse.plan_by_person() or not pulse.viewer_is('admin', 'leadership') then
    raise exception 'Only leadership saves how the company delivers projects' using errcode = '42501'; end if;
  return jsonb_build_object('key', p_key, 'version', pulse.delivery_template_file(p_key, p_name, p_definition, p_note));
end $$;

-- Laying out a plan (1471's project_plan_lay), on clocks: a step counts from its clock and has no date until that clock
-- is recorded; the system's own steps (type auto: "the paid invoice creates the project") are not cards; a step with a
-- condition ("where real buyers exist") is not made until its condition can be checked (phase 2); the first role named
-- in a step's owner is its role, and the project's lead takes the steps of the template's lead role; a step's work
-- hours become the task's estimate. The plan keeps the template version it was laid out from.
create or replace function pulse.project_plan_lay(p_project uuid, p_template text, p_package text, p_category text, p_kickoff date, p_lead uuid)
  returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); def jsonb; st jsonb; pr pulse.project; lead uuid; pl pulse.project_plan; ver int;
  made int := 0; matched int := 0; skipped int := 0; tid uuid; flag text; dd record; ttl text; kw text; i int; typ text; rl text; hrs jsonb;
begin
  select * into pr from pulse.project where org_id = pulse.current_org() and id = p_project and deleted_at is null;
  if pr.id is null then raise exception 'Project not found' using errcode = 'P0002'; end if;
  select definition into def from pulse.delivery_template where org_id = pulse.current_org() and key = p_template;
  if def is null then raise exception 'Choose a delivery template' using errcode = '22023'; end if;
  if p_package is null or not exists(select 1 from jsonb_array_elements(def->'packages') x where x->>'key' = p_package) then
    raise exception 'Choose the package that was sold' using errcode = '22023'; end if;
  if p_category is not null and not exists(select 1 from jsonb_array_elements(def->'categories') x where x->>'key' = p_category) then
    raise exception 'Choose the project category' using errcode = '22023'; end if;
  if p_kickoff is null then raise exception 'Choose the kick-off day' using errcode = '22023'; end if;
  if p_lead is not null and not exists(select 1 from pulse.person where org_id = pulse.current_org() and id = p_lead and side = 'staff' and status = 'active') then
    raise exception 'Choose an active member of staff as the lead' using errcode = '22023'; end if;
  if p_lead is not null then
    update pulse.project set lead_person_id = p_lead, updated_at = now() where id = p_project;
    update pulse.work_project set owner_id = p_lead, updated_at = now(), updated_by = me where project_id = p_project;
  end if;
  lead := coalesce(p_lead, pr.lead_person_id);
  update pulse.project set starts_on = coalesce(starts_on, p_kickoff), updated_at = now() where id = p_project;
  select max(version) into ver from pulse.delivery_template_version where org_id = pulse.current_org() and key = p_template;
  insert into pulse.project_plan(org_id, project_id, template_key, package, category, kickoff, created_by, template_version)
    values (pulse.current_org(), p_project, p_template, p_package, p_category, p_kickoff, me, ver)
    on conflict (project_id) do update set template_key = excluded.template_key, package = excluded.package, category = excluded.category,
      kickoff = excluded.kickoff, template_version = excluded.template_version, updated_at = now()
    returning * into pl;
  for st in select x from jsonb_array_elements(def->'steps') x loop
    flag := coalesce(st->'packages'->>p_package, 'no');
    continue when flag = 'no';
    typ := pulse.plan_step_type(st);
    if typ = 'auto' or st ? 'when' then skipped := skipped + 1; continue; end if;
    continue when exists(select 1 from pulse.task t where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.template_step = st->>'id');
    select * into dd from pulse.plan_step_due(pl, st, p_package);
    rl := pulse.plan_step_role(st);
    -- A quotation line made into tasks takes the step (every matching unit: Model video #1 and #2).
    i := 0;
    for kw in select jsonb_array_elements_text(coalesce(st->'match', '[]'::jsonb)) loop
      with hit as (update pulse.task t set template_step = st->>'id', phase_key = 's' || (st->>'stage'), due_at = coalesce(t.due_at, dd.due),
          work_on = coalesce(t.work_on, dd.work_on), role_key = coalesce(t.role_key, rl), updated_at = now(), edited_by = me
        where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.source = 'quote' and t.template_step is null
          and lower(t.title) like '%' || lower(kw) || '%' returning t.id)
      select count(*) into i from hit;
      matched := matched + i;
      exit when i > 0;
    end loop;
    continue when i > 0 or flag = 'optional';
    ttl := left(format('%s %s', st->>'id', st->>'title'), 300);
    hrs := st->'hours';
    insert into pulse.task(org_id, project_id, title, assignee_person_id, role_key, created_by, created_at, assigned_at, due_at, work_on,
        source, source_key, template_step, phase_key, notes, status, estimate_minutes)
      values (pulse.current_org(), p_project, ttl, case when rl = def->'bandwidth'->>'role' or st->>'owner' = def->'bandwidth'->>'role' then lead end, rl, me, now(), now(), dd.due, dd.work_on,
        'template', format('plan:%s:%s', p_project, st->>'id'), st->>'id', 's' || (st->>'stage'),
        nullif(concat_ws(chr(10), case when (st->>'clientInput')::boolean then 'Needs the client''s input.' end,
          case when st->>'owner' is distinct from rl then 'Owner: ' || (st->>'owner') end, st->>'note',
          (select string_agg(format('%s. %s', n, c), chr(10) order by n) from jsonb_array_elements_text(coalesce(st->'checks', '[]'::jsonb)) with ordinality as x(c, n))), ''), 'open',
        case when jsonb_typeof(hrs) = 'array' and jsonb_array_length(hrs) = 2 then least(6000, round(((hrs->>0)::numeric + (hrs->>1)::numeric) * 30))::int end)
      on conflict (org_id, source_key) do nothing returning id into tid;
    if tid is not null then
      insert into pulse.task_event(org_id, task_id, actor_id, kind, to_value, note) values (pulse.current_org(), tid, me, 'created', ttl, 'From the delivery plan');
      made := made + 1; tid := null;
    end if;
  end loop;
  perform pulse.project_plan_links(p_project);
  perform pulse.audit_write('project_plan_set', 'project', p_project::text);
  return jsonb_build_object('projectId', p_project, 'tasks', made, 'matched', matched, 'notMade', skipped, 'version', ver);
end $$;

-- Date the steps on a clock once it is recorded. A step a person dated or moved keeps its dates: only a step with neither
-- a due day nor a start day gets them, and a step with a date change on record is left alone.
create function pulse.project_plan_reclock(p_project uuid, p_clock text) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare pl pulse.project_plan; st jsonb; dd record; n int := 0; k int;
begin
  select * into pl from pulse.project_plan where org_id = pulse.current_org() and project_id = p_project;
  if pl.project_id is null then return 0; end if;
  for st in select x from jsonb_array_elements(coalesce(pulse.plan_definition(p_project)->'steps', '[]'::jsonb)) x where coalesce(x->>'from', 'start') = p_clock loop
    select * into dd from pulse.plan_step_due(pl, st, pl.package);
    continue when dd.due is null and dd.work_on is null;
    update pulse.task t set due_at = dd.due, work_on = dd.work_on, updated_at = now()
      where t.org_id = pulse.current_org() and t.project_id = p_project and t.template_step = st->>'id' and t.deleted_at is null
        and t.status not in ('cancelled', 'not_applicable', 'merged') and t.due_at is null and t.work_on is null
        and not exists(select 1 from pulse.project_date_change c where c.org_id = t.org_id and c.project_id = p_project and (c.task_id = t.id or t.id = any(c.moved)));
    get diagnostics k = row_count; n := n + k;
  end loop;
  return n;
end $$;

-- Record a clock (day0 or live) for a project: refused while the recording step's inputs are open (named), never in the
-- future or before the plan started; its steps are dated and the recording step is done by the person who recorded it.
create function pulse.project_clock_record(p_project uuid, p_clock text, p_on date) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); pl pulse.project_plan; c jsonb; stp text; open jsonb; lbl text; n int; r record;
  today date := (now() at time zone pulse.org_time_zone())::date;
begin
  select * into pl from pulse.project_plan where org_id = pulse.current_org() and project_id = p_project for update;
  if pl.project_id is null then raise exception 'This project has no delivery plan' using errcode = 'P0002'; end if;
  select x into c from jsonb_array_elements(coalesce(pulse.plan_definition(p_project)->'clocks', '[]'::jsonb)) x where x->>'key' = p_clock limit 1;
  if c is null or p_clock not in ('day0', 'live') then raise exception 'This plan has no such clock' using errcode = '22023'; end if;
  lbl := coalesce(nullif(c->>'label', ''), p_clock);
  if (p_clock = 'day0' and pl.day0_on is not null) or (p_clock = 'live' and pl.live_on is not null) then
    raise exception '% was already recorded for %', lbl, to_char(case when p_clock = 'day0' then pl.day0_on else pl.live_on end, 'DD Mon YYYY') using errcode = '22023'; end if;
  p_on := coalesce(p_on, today);
  if p_on > today then raise exception '% can''t be a day in the future', lbl using errcode = '22023'; end if;
  if p_on < pl.kickoff then raise exception '% can''t be before the plan started (%)', lbl, to_char(pl.kickoff, 'DD Mon YYYY') using errcode = '22023'; end if;
  if p_clock = 'live' and pl.day0_on is not null and p_on < pl.day0_on then
    raise exception '% can''t be before %', lbl, to_char(pl.day0_on, 'DD Mon YYYY') using errcode = '22023'; end if;
  if p_clock = 'day0' and pl.live_on is not null and p_on > pl.live_on then
    raise exception '% can''t be after the day it went live (%)', lbl, to_char(pl.live_on, 'DD Mon YYYY') using errcode = '22023'; end if;
  stp := nullif(c->>'step', '');
  if stp is not null then
    open := pulse.plan_open_inputs(p_project, stp);
    if jsonb_array_length(open) > 0 then
      raise exception '% can''t be recorded yet. Still open: %', lbl, (select string_agg(format('%s %s', x->>'id', x->>'title'), '; ') from jsonb_array_elements(open) x)
        using errcode = '23514', hint = 'Finish these first. A step that runs on (a campaign set up) counts once it is In progress.';
    end if;
  end if;
  if p_clock = 'day0' then update pulse.project_plan set day0_on = p_on, day0_by = me, day0_at = now(), updated_at = now() where project_id = p_project;
  else update pulse.project_plan set live_on = p_on, live_by = me, live_at = now(), updated_at = now() where project_id = p_project; end if;
  n := pulse.project_plan_reclock(p_project, p_clock);
  if stp is not null then
    for r in select t.id, t.status from pulse.task t where t.org_id = pulse.current_org() and t.project_id = p_project and t.template_step = stp and t.deleted_at is null
        and t.status in ('open', 'in_progress', 'blocked', 'unknown') loop
      update pulse.task set status = 'done', done_at = now(), started_at = coalesce(started_at, now()), updated_at = now(), edited_by = me where id = r.id;
      perform pulse.task_event_add(r.id, 'status', r.status, 'done', left(format('%s recorded for %s', lbl, to_char(p_on, 'DD Mon YYYY')), 300));
      perform pulse.task_release_waiting(r.id);
    end loop;
  end if;
  perform pulse.audit_write(case when p_clock = 'day0' then 'project_day0_declare' else 'project_live_record' end, 'project', p_project::text);
  return jsonb_build_object('clock', p_clock, 'on', p_on, 'dated', n);
end $$;

create function pulse.project_day0_declare(p_project uuid, p_on date) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not pulse.plan_by_person() then raise exception 'Only a person declares that every input is in' using errcode = '42501'; end if;
  if not pulse.project_can_run(p_project) then raise exception 'Only the project''s lead, its manager and leadership declare that every input is in' using errcode = '42501'; end if;
  return pulse.project_clock_record(p_project, 'day0', p_on);
end $$;

create function pulse.project_live_record(p_project uuid, p_on date) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not pulse.plan_by_person() then raise exception 'Only a person records the day the project went live' using errcode = '42501'; end if;
  if not pulse.project_can_run(p_project) then raise exception 'Only the project''s lead, its manager and leadership record the day it went live' using errcode = '42501'; end if;
  return pulse.project_clock_record(p_project, 'live', p_on);
end $$;

-- A plan step reaching done (or review, or accepted): only from a person; a gate or milestone only once its inputs are
-- done; a step with a hold-until day only from that day.
create function pulse.task_plan_guard() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare pl pulse.project_plan; st jsonb; open jsonb; base date;
begin
  select * into pl from pulse.project_plan where org_id = new.org_id and project_id = new.project_id;
  if pl.project_id is null then return new; end if;
  if not pulse.plan_by_person() then
    raise exception 'Only a person marks a step of the delivery plan done' using errcode = '42501',
      hint = 'AI employees and automations may move a step to In progress; the person who did it marks it done.';
  end if;
  st := pulse.plan_step(new.project_id, new.template_step);
  if st is null then return new; end if;
  if pulse.plan_step_type(st) in ('gate', 'milestone') then
    open := pulse.plan_open_inputs(new.project_id, new.template_step);
    if jsonb_array_length(open) > 0 then
      raise exception '“%” can''t be done yet. Still open: %', st->>'title', (select string_agg(format('%s %s', x->>'id', x->>'title'), '; ') from jsonb_array_elements(open) x)
        using errcode = '23514', hint = 'Finish these first. A step that runs on (a campaign set up) counts once it is In progress.';
    end if;
  end if;
  if jsonb_typeof(st->'holdUntil') = 'object' then
    base := pulse.plan_clock_on(pl, st->'holdUntil'->>'from');
    if base is null or base + coalesce((st->'holdUntil'->>'day')::int, 0) > (now() at time zone pulse.org_time_zone())::date then
      raise exception '“%” can''t be finished before %', st->>'title',
        case when base is null then 'its clock starts' else to_char(base + coalesce((st->'holdUntil'->>'day')::int, 0), 'DD Mon YYYY') end using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger task_plan_guard before update of status on pulse.task for each row
  when (new.status in ('done', 'accepted', 'in_review') and old.status not in ('done', 'accepted', 'in_review') and new.template_step is not null
    and new.project_id is not null and new.deleted_at is null)
  execute function pulse.task_plan_guard();

-- Ticking the recording step done records its clock (when nobody recorded it yet), for today, and dates its steps.
create function pulse.task_plan_clock() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare pl pulse.project_plan; c jsonb; day date := (now() at time zone pulse.org_time_zone())::date;
begin
  select * into pl from pulse.project_plan where org_id = new.org_id and project_id = new.project_id;
  if pl.project_id is null then return null; end if;
  select x into c from jsonb_array_elements(coalesce(pulse.plan_definition(new.project_id)->'clocks', '[]'::jsonb)) x
    where x->>'step' = new.template_step and x->>'key' in ('day0', 'live') limit 1;
  if c is null then return null; end if;
  if c->>'key' = 'day0' and pl.day0_on is null then
    update pulse.project_plan set day0_on = least(greatest(day, pl.kickoff), coalesce(pl.live_on, 'infinity'::date)), day0_by = pulse.current_viewer(), day0_at = now(), updated_at = now() where project_id = new.project_id;
    perform pulse.project_plan_reclock(new.project_id, 'day0');
  elsif c->>'key' = 'live' and pl.live_on is null then
    update pulse.project_plan set live_on = greatest(day, coalesce(pl.day0_on, pl.kickoff)), live_by = pulse.current_viewer(), live_at = now(), updated_at = now() where project_id = new.project_id;
    perform pulse.project_plan_reclock(new.project_id, 'live');
  end if;
  return null;
end $$;
create trigger task_plan_clock after update of status on pulse.task for each row
  when (new.status in ('done', 'accepted', 'in_review') and old.status not in ('done', 'accepted', 'in_review') and new.template_step is not null
    and new.project_id is not null and new.deleted_at is null)
  execute function pulse.task_plan_clock();

-- 1386's step pick, on clocks: a task placed on a step takes the step's dates when its clock is recorded.
create or replace function pulse.project_task_step(p_task uuid, p_step text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); t pulse.task; pl pulse.project_plan; st jsonb; dd record;
begin
  select * into t from pulse.task where org_id = pulse.current_org() and id = p_task and deleted_at is null;
  if t.id is null or t.project_id is null then raise exception 'Task not found' using errcode = 'P0002'; end if;
  if not (pulse.project_can_run(t.project_id) or me in (t.created_by, t.assignee_person_id, t.owner_id)) then
    raise exception 'Only the task''s people and the project''s lead place it on a step' using errcode = '42501'; end if;
  select * into pl from pulse.project_plan where org_id = pulse.current_org() and project_id = t.project_id;
  if pl.project_id is null then raise exception 'This project has no delivery plan' using errcode = '22023'; end if;
  st := pulse.plan_step(t.project_id, p_step);
  if st is null then raise exception 'Choose a step of the plan' using errcode = '22023'; end if;
  select * into dd from pulse.plan_step_due(pl, st, pl.package);
  update pulse.task set template_step = p_step, phase_key = 's' || (st->>'stage'), role_key = coalesce(role_key, pulse.plan_step_role(st)),
      due_at = coalesce(due_at, dd.due), updated_at = now(), edited_by = me
    where id = p_task;
  insert into pulse.task_event(org_id, task_id, actor_id, kind, to_value, note) values (pulse.current_org(), p_task, me, 'step', p_step, left(st->>'title', 1000));
  return jsonb_build_object('task', p_task, 'step', p_step);
end $$;


-- Pulse's own "it happened, so it is done" (0420) leaves plan steps to a person.
CREATE OR REPLACE FUNCTION pulse.task_auto_blocker(p_task uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare k task; c task_companion;
begin
 select * into k from task where org_id=current_org() and id=p_task;
 -- PM-BUILD-1 (2262): a step of a delivery plan is finished by a person, never by what Pulse saw happen.
 if k.template_step is not null and exists(select 1 from project_plan where org_id=current_org() and project_id=k.project_id) then return 'plan_step'; end if;
 select * into c from task_companion where task_id=p_task;
 if not found or c.confirmed_at is null then return 'unconfirmed'; end if;
 if not exists(select 1 from task_signal where task_id=p_task) then return 'no_signals'; end if;
 if exists(select 1 from task_signal where task_id=p_task and met_at is null) then return 'waiting'; end if;
 if k.deleted_at is not null or k.status not in ('open','in_progress') then return 'status'; end if;
 if coalesce(k.assignee_person_id,k.owner_id) is null then return 'no_doer'; end if;
 if not c.auto_done then return 'task_asks'; end if;
 if coalesce((select auto_done from work_settings where org_id=current_org()),'on')<>'on' then return 'company_asks'; end if;
 if exists(select 1 from task_link l join task b on b.id=l.blocker_id where l.org_id=current_org() and l.task_id=p_task and l.cleared_at is null
  and b.deleted_at is null and b.status not in ('done','in_review','accepted','cancelled')) then return 'waits_on'; end if;
 if task_open_children(p_task)>0 then return 'subtasks'; end if;
 if coalesce((select requires_proof from project where id=k.project_id),false) and not exists(select 1 from task_proof where task_id=p_task and removed_at is null) then return 'proof'; end if;
 return null;
end $function$;

-- 1485's late question, without running steps (ongoing or repeating work that has started is never late).
CREATE OR REPLACE FUNCTION pulse.task_delays_sync(p_task uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare tz text := pulse.org_time_zone(); today date := (now() at time zone tz)::date; n int := 0; r record;
begin
  if pulse.current_org() is null then return 0; end if;
  update pulse.task_delay d set closed_at = now()
    from pulse.task t where d.org_id = pulse.current_org() and t.id = d.task_id and d.closed_at is null and (p_task is null or d.task_id = p_task)
      and (t.deleted_at is not null or t.project_id is distinct from d.project_id or t.status not in ('open','in_progress','blocked') or t.due_at is null
        or (t.status = 'in_progress' and t.template_step is not null and pulse.plan_step_running(t.project_id, t.template_step, t.status))
        or (t.due_at at time zone tz)::date <> d.due_on);
  for r in select t.id, t.project_id, t.title, coalesce(t.assignee_person_id, t.owner_id) who, (t.due_at at time zone tz)::date due
      from pulse.task t join pulse.project p on p.id = t.project_id and p.deleted_at is null and coalesce(p.status, 'active') not in ('paused','done','cancelled')
      join pulse.person pe on pe.id = coalesce(t.assignee_person_id, t.owner_id) and pe.side = 'staff' and pe.status = 'active'
      where t.org_id = pulse.current_org() and t.deleted_at is null and t.status in ('open','in_progress','blocked') and t.due_at is not null
        and t.due_at >= ((today - 7) + time '00:00') at time zone tz and (t.due_at at time zone tz)::date < today and (p_task is null or t.id = p_task)
        and not (t.status = 'in_progress' and t.template_step is not null and pulse.plan_step_running(t.project_id, t.template_step, t.status))
        and not exists(select 1 from pulse.task_delay d where d.org_id = t.org_id and d.task_id = t.id and d.due_on = (t.due_at at time zone tz)::date)
      order by t.due_at limit 200 loop
    insert into pulse.task_delay(org_id, task_id, project_id, due_on, person_id) values (pulse.current_org(), r.id, r.project_id, r.due, r.who) on conflict do nothing;
    if p_task is null then perform pulse.notification_emit(r.who, 'task.late', 'task', r.id, left(format('delay:%s:%s', r.id, r.due), 200),
      left(format('Late since %s: “%s”. Say why, and when it can be done', to_char(r.due, 'DD Mon'), r.title), 160), '/tasks/' || r.id, 'task'); end if;
    n := n + 1;
  end loop;
  return n;
end $function$;

revoke all on function pulse.plan_definition(uuid), pulse.plan_step(uuid, text), pulse.plan_step_running(uuid, text, text), pulse.plan_by_person(),
  pulse.plan_open_inputs(uuid, text), pulse.delivery_template_file(text, text, jsonb, text), pulse.delivery_template_save(text, text, jsonb, text),
  pulse.project_plan_reclock(uuid, text), pulse.project_clock_record(uuid, text, date), pulse.project_day0_declare(uuid, date), pulse.project_live_record(uuid, date),
  pulse.task_plan_guard(), pulse.task_plan_clock(), pulse.plan_step_due(pulse.project_plan, jsonb, text) from public;
grant execute on function pulse.plan_definition(uuid), pulse.plan_step(uuid, text), pulse.plan_step_running(uuid, text, text), pulse.plan_by_person(),
  pulse.plan_open_inputs(uuid, text), pulse.delivery_template_save(text, text, jsonb, text), pulse.project_day0_declare(uuid, date), pulse.project_live_record(uuid, date),
  pulse.plan_step_type(jsonb), pulse.plan_step_role(jsonb), pulse.plan_clock_on(pulse.project_plan, text), pulse.delivery_template_check(jsonb) to pulse_api;

-- Estate Autopilots' template: the copy in use is kept as version 2 (any plan laid out from it stays on it; production
-- has none), and Kazuk's Delivery Timeline v2 becomes version 3. Written as that company, only where it exists.
select set_config('pulse.org_id', o.id::text, true) from pulse.org o where o.id = '6f1a455d-ced2-504d-b8d5-5ae0efbe7c75';
select pulse.delivery_template_file('agency-creative', 'Agency delivery plan', '{"packages": [{"key": "sell_out", "label": "Sell-Out"}, {"key": "growth", "label": "Growth"}, {"key": "starter", "label": "Starter"}], "categories": [{"key": "sell_out", "label": "Sell-Out", "units": 1}, {"key": "competitive", "label": "Competitive", "units": 0.6}, {"key": "normal", "label": "Normal", "units": 0.4}], "creativeColumns": ["Script", "Client confirmed", "Shoot / design", "Rough cut", "2 PM session", "Campaign ready", "Live"], "targets": [{"key": "sellout_months", "label": "Sell-out timeline", "unit": "months"}, {"key": "enquiries_day", "label": "Enquiries a day", "unit": "a day"}, {"key": "cpl", "label": "CPL benchmark", "unit": "₹", "dueStep": "P1"}, {"key": "qualified_pct", "label": "Qualified buyers", "unit": "%"}], "headRoles": ["head_pgs"], "bandwidth": {"role": "PGS", "short": "PGS", "healthy": [6, 7], "max": 8, "note": "Review above 8 units"}, "labels": {"hold": "Our hold", "teamChat": "team chat", "clientGroup": "client group", "adsLive": "Ads live", "foundation": "Foundation", "resultCheck": "Result check", "headLead": "Head PGS", "gate": "Before ads can go live", "dayZero": "Inputs complete", "start": "Invoice paid"}, "milestones": {"adsLive": "J3", "script": "C2"}, "windows": [{"key": "refund", "label": "Refund claim window", "from": "live", "start": 30, "end": 45}], "source": "EA Delivery Timeline v2, step-level sequence (9 Nov 2026), read from its Google Doc on 17 Nov 2026", "version": 3, "format": 3, "stages": [{"n": 0, "key": "s0", "label": "Stage 0 · Onboarding and research"}, {"n": 1, "key": "s1", "label": "Phase 1 · Project Brand Blueprint™"}, {"n": 2, "key": "s2", "label": "Brand Identity · outsourced"}, {"n": 3, "key": "s3", "label": "Phase 2 · Creative Assets™"}, {"n": 4, "key": "s4", "label": "Phase 2 · Trust Assets"}, {"n": 5, "key": "s5", "label": "Phase 3 · Buyer Journey Engine™"}, {"n": 6, "key": "s6", "label": "Phase 4 · Sales Intelligence System™"}, {"n": 7, "key": "s7", "label": "Training"}, {"n": 8, "key": "s8", "label": "Paid add-ons and bonuses"}], "clocks": [{"key": "start", "label": "Invoice paid", "day": -7}, {"key": "day0", "label": "Inputs complete", "step": "O14"}, {"key": "live", "label": "Ads live", "step": "J3", "inputs": ["C13", "L4", "N1", "O13", "J1"]}, {"key": "bought", "label": "Bought on"}], "steps": [{"id": "O1", "stage": 0, "title": "Paid invoice creates the project", "owner": "Vitals OS", "type": "auto", "kind": "auto", "from": "start", "start": 0, "end": 0, "after": [], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "O2", "stage": 0, "title": "Head PGS assigns the PGS", "owner": "Head PGS", "type": "task", "kind": "task", "from": "start", "start": 0, "end": 0, "after": ["O1"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "O3", "stage": 0, "title": "Drive folder created and linked to the project", "owner": "Access Coordinator", "type": "task", "kind": "task", "from": "start", "start": 0, "end": 1, "after": ["O1"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "O4", "stage": 0, "title": "Client group opened; client, sales head, PGS and CS added", "owner": "Access Coordinator", "type": "task", "kind": "task", "from": "start", "start": 0, "end": 1, "after": ["O2"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "O5", "stage": 0, "title": "Introductory call: PGS introduces himself, explains what the combined meet covers, question list sent ahead", "owner": "PGS", "type": "task", "kind": "task", "from": "start", "start": 1, "end": 1, "after": ["O4"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": ["kick-off", "kickoff"]}, {"id": "O6", "stage": 0, "title": "Nine working conditions signed, and the agreed lead number, CPL and ad budget confirmed in the agreement", "owner": "PGS", "type": "task", "kind": "task", "from": "start", "start": 1, "end": 3, "after": ["O5"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": true, "match": []}, {"id": "O7", "stage": 0, "title": "Resources collected: brochure, 3D, price sheet, layouts, inventory, past-buyer list", "owner": "Access Coordinator", "type": "task", "kind": "task", "from": "start", "start": 1, "end": 4, "after": ["O5"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": true, "match": []}, {"id": "O8", "stage": 0, "title": "Project Blueprint doc created in the client folder", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "start", "start": 1, "end": 2, "after": ["O3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "O9", "stage": 0, "title": "Initial study: Initial Observations in the Deep Research tab, plus the extra questions for the meet", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "start", "start": 2, "end": 4, "after": ["O7", "O8"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "O10", "stage": 0, "title": "Onboarding and research meet held as one call, recorded", "owner": "PGS + CS with the client team", "type": "task", "kind": "task", "from": "start", "start": 4, "end": 5, "after": ["O9"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": true, "match": []}, {"id": "O11", "stage": 0, "title": "Transcript uploaded as Client Research Meet Details in Research and Scripting", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "start", "start": 5, "end": 5, "after": ["O10"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "O12", "stage": 0, "title": "Meeting scored: information quality and client behaviour", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "start", "start": 5, "end": 5, "after": ["O10"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "O13", "stage": 0, "title": "Ad account, page and domain access granted; MahaRERA number and QR asset on file", "owner": "Access Coordinator", "type": "task", "kind": "task", "from": "start", "start": 1, "end": 6, "after": ["O5"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": true, "match": []}, {"id": "O14", "stage": 0, "title": "Input-complete declared — Day 0. Every input held, clock starts", "owner": "PGS", "type": "gate", "kind": "gate", "from": "start", "start": 7, "end": 7, "after": ["O6", "O7", "O10", "O13"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "O15", "stage": 0, "title": "Commitment numbers taken from sales, confirmed, and restated to the client on the research call", "owner": "PGS", "type": "gate", "kind": "gate", "from": "day0", "start": 2, "end": 4, "after": ["O5"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "P1", "stage": 1, "title": "Deep market research and competition scan", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "day0", "start": 1, "end": 3, "after": ["O14"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": ["market research", "research"]}, {"id": "P2", "stage": 1, "title": "Buyer persona strategy", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "day0", "start": 2, "end": 4, "after": ["P1"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": ["persona"]}, {"id": "P3", "stage": 1, "title": "Positioning and Word Library", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "day0", "start": 3, "end": 5, "after": ["P2"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": ["positioning"]}, {"id": "P4", "stage": 1, "title": "Blueprint deck assembled", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "day0", "start": 4, "end": 5, "after": ["P3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": ["blueprint"]}, {"id": "P5", "stage": 1, "title": "Blueprint presented to the client", "owner": "PGS + Creative Strategist", "type": "task", "kind": "task", "from": "day0", "start": 5, "end": 6, "after": ["P4"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "P6", "stage": 1, "title": "Social Media Optimization: profile setup and optimisation only", "owner": "SME", "type": "task", "kind": "task", "from": "day0", "start": 6, "end": 10, "after": ["P4"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "clientInput": false, "match": ["social media optimi"]}, {"id": "P7", "stage": 1, "title": "Sales Alignment Session", "owner": "Trainer", "type": "task", "kind": "task", "from": "day0", "start": 6, "end": 10, "after": ["P5"], "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "clientInput": true, "match": []}, {"id": "B1", "stage": 2, "title": "Name and tagline routes presented", "owner": "Brand identity agency", "type": "task", "kind": "task", "from": "day0", "start": 10, "end": 14, "after": ["P5"], "packages": {"sell_out": "yes", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": []}, {"id": "B2", "stage": 2, "title": "Name and tagline approved", "owner": "Client", "type": "approval", "kind": "approval", "from": "day0", "start": 14, "end": 16, "after": ["B1"], "packages": {"sell_out": "yes", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": []}, {"id": "B3", "stage": 2, "title": "Primary logo and logo lockup delivered", "owner": "Brand identity agency", "type": "task", "kind": "task", "from": "day0", "start": 16, "end": 22, "after": ["B2"], "packages": {"sell_out": "yes", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": []}, {"id": "B4", "stage": 2, "title": "Full identity system: palette, typography, secondary marks, usage guide", "owner": "Brand identity agency", "type": "task", "kind": "task", "from": "day0", "start": 22, "end": 32, "after": ["B3"], "packages": {"sell_out": "yes", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": ["brand identity", "logo"]}, {"id": "B5", "stage": 2, "title": "Identity signed off", "owner": "Client", "type": "approval", "kind": "approval", "from": "day0", "start": 32, "end": 35, "after": ["B4"], "packages": {"sell_out": "yes", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": []}, {"id": "B6", "stage": 2, "title": "Brand collateral: brochure, pitch deck, billboard, offline set", "owner": "Brand identity agency", "type": "task", "kind": "task", "from": "day0", "start": 35, "end": 50, "after": ["B5"], "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "clientInput": false, "match": ["brochure", "collateral"]}, {"id": "C1", "stage": 3, "title": "Image ad copy, first set of 4", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "day0", "start": 5, "end": 9, "after": ["P3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "C2", "stage": 3, "title": "Model-led video script, first", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "day0", "start": 5, "end": 9, "after": ["P3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": ["script"]}, {"id": "C3", "stage": 3, "title": "VOV script, first", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "day0", "start": 6, "end": 11, "after": ["P3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "C4", "stage": 3, "title": "Sample Flat Tour structure, first", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "day0", "start": 8, "end": 11, "after": ["P3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "C5", "stage": 3, "title": "First-line test openings prepared, 2–3 per film", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "day0", "start": 9, "end": 12, "after": ["C2", "C3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "C6", "stage": 3, "title": "Model options sent to the client", "owner": "Shoot Coordinator", "type": "task", "kind": "task", "from": "day0", "start": 3, "end": 6, "after": ["P3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "C7", "stage": 3, "title": "Model and outfit finalised, matched to the sample flat and the CS''s input", "owner": "Shoot Coordinator", "type": "task", "kind": "task", "from": "day0", "start": 6, "end": 9, "after": ["C6"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": true, "match": []}, {"id": "C8", "stage": 3, "title": "Shoot day scheduled and confirmed", "owner": "Shoot Coordinator", "type": "task", "kind": "task", "from": "day0", "start": 6, "end": 9, "after": ["C7"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "C9", "stage": 3, "title": "Day 12 shoot: drone, project B-roll, walkthrough footage, sample flat coverage, model shoot", "owner": "Shoot Coordinator + Videographer", "type": "task", "kind": "task", "from": "day0", "start": 12, "end": 12, "after": ["C2", "C8"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "C10", "stage": 3, "title": "Raw footage uploaded and the PGS tagged", "owner": "Shoot Coordinator", "type": "task", "kind": "task", "from": "day0", "start": 12, "end": 13, "after": ["C9"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "C11", "stage": 3, "title": "Image ad set assigned to the graphic designer", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 9, "end": 9, "after": ["C1"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "C12", "stage": 3, "title": "Image ad set designed", "owner": "Graphic Designer", "type": "task", "kind": "task", "from": "day0", "start": 9, "end": 12, "after": ["C11"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": ["image"], "note": "Waits on: C11 accepted"}, {"id": "C13", "stage": 3, "title": "Design confirmed by the Creative Strategist", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "day0", "start": 12, "end": 12, "after": ["C12"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "C14", "stage": 3, "title": "Sample Flat Tour Video assigned", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 13, "end": 13, "after": ["C10", "C4"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "C15", "stage": 3, "title": "Sample Flat Tour Video edited and delivered", "owner": "Video Editor", "type": "task", "kind": "task", "from": "day0", "start": 13, "end": 18, "after": ["C14"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": [], "note": "Waits on: C14 accepted"}, {"id": "C16", "stage": 3, "title": "VOV ad assigned", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 20, "end": 20, "after": ["C10", "C3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "C17", "stage": 3, "title": "VOV ad drafted", "owner": "Video Editor", "type": "task", "kind": "task", "from": "day0", "start": 20, "end": 27, "after": ["C16"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": [], "hours": [4, 5], "note": "Waits on: C16 accepted"}, {"id": "C18", "stage": 3, "title": "Brainstorming session: VOV", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 27, "end": 28, "after": ["C17"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": [], "note": "Waits on: C17 first draft"}, {"id": "C19", "stage": 3, "title": "VOV ad delivered", "owner": "Video Editor", "type": "task", "kind": "task", "from": "day0", "start": 28, "end": 30, "after": ["C18"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": ["vov", "voice over"]}, {"id": "C20", "stage": 3, "title": "Model-led video drafted", "owner": "Video Editor", "type": "task", "kind": "task", "from": "day0", "start": 13, "end": 20, "after": ["C10", "C2"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": [], "hours": [8, 10]}, {"id": "C21", "stage": 3, "title": "Brainstorming session: model video", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 20, "end": 22, "after": ["C20"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": [], "note": "Waits on: C20 first draft"}, {"id": "C22", "stage": 3, "title": "Model-led video delivered", "owner": "Video Editor", "type": "task", "kind": "task", "from": "day0", "start": 22, "end": 25, "after": ["C21"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": ["model-led video", "model led video", "mmv", "model video"]}, {"id": "C23", "stage": 3, "title": "Further sets on PGS request: model video, VOV, image ads", "owner": "Video Editor", "type": "task", "kind": "task", "from": "day0", "start": 28, "end": 45, "after": ["C19"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "clientInput": false, "match": [], "hours": [4, 5]}, {"id": "C24", "stage": 3, "title": "Creative remix from campaign data", "owner": "Video + Design", "type": "task", "kind": "task", "from": "live", "start": 30, "end": 45, "after": ["J3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "clientInput": false, "match": ["remix", "hybrid"], "note": "Waits on: J3 plus 30 days"}, {"id": "W1", "stage": 4, "title": "PGS raises the walkthrough request in the group", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 13, "end": 13, "after": ["P5"], "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "clientInput": false, "match": []}, {"id": "W2", "stage": 4, "title": "CS accepts; card moves to In progress", "owner": "Creative Strategist", "type": "auto", "kind": "auto", "from": "day0", "start": 13, "end": 13, "after": ["W1"], "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "clientInput": false, "match": []}, {"id": "W3", "stage": 4, "title": "Shoot structure and direction finalised: coverage points and their order, not a script", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "day0", "start": 13, "end": 17, "after": ["W2"], "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "clientInput": false, "match": []}, {"id": "W4", "stage": 4, "title": "Model, outfit and shoot day aligned, client confirmation taken", "owner": "Shoot Coordinator", "type": "task", "kind": "task", "from": "day0", "start": 13, "end": 18, "after": ["W1"], "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "clientInput": true, "match": []}, {"id": "W5", "stage": 4, "title": "Walkthrough shot", "owner": "Shoot Coordinator + Videographer", "type": "task", "kind": "task", "from": "day0", "start": 18, "end": 20, "after": ["W3", "W4"], "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "clientInput": false, "match": []}, {"id": "W6", "stage": 4, "title": "Raw footage uploaded and the PGS tagged", "owner": "Shoot Coordinator", "type": "task", "kind": "task", "from": "day0", "start": 20, "end": 20, "after": ["W5"], "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "clientInput": false, "match": []}, {"id": "W7", "stage": 4, "title": "Editor assigned", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 20, "end": 21, "after": ["W6"], "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "clientInput": false, "match": []}, {"id": "W8", "stage": 4, "title": "Drafts; first draft sent to the client", "owner": "Video Editor", "type": "task", "kind": "task", "from": "day0", "start": 21, "end": 26, "after": ["W7"], "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "clientInput": false, "match": [], "note": "Waits on: W7 accepted"}, {"id": "W9", "stage": 4, "title": "Brainstorming session", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 26, "end": 28, "after": ["W8"], "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "clientInput": false, "match": []}, {"id": "W10", "stage": 4, "title": "Final version delivered", "owner": "Video Editor", "type": "task", "kind": "task", "from": "day0", "start": 28, "end": 30, "after": ["W9"], "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "clientInput": false, "match": ["walkthrough"]}, {"id": "L1", "stage": 4, "title": "Landing page copy written", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 8, "end": 12, "after": ["P3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "L2", "stage": 4, "title": "Landing page built — Standard on Starter, Premium on Growth and Sell-Out", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 12, "end": 15, "after": ["L1"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": ["landing page"]}, {"id": "L3", "stage": 4, "title": "Tracking and forms wired to the CRM and tested", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 15, "end": 15, "after": ["L2", "N1"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "L4", "stage": 4, "title": "Landing page live", "owner": "PGS", "type": "gate", "kind": "gate", "from": "day0", "start": 15, "end": 15, "after": ["L3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "LG1", "stage": 4, "title": "PGS raises the Legacy Video request", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 25, "end": 25, "after": ["P5"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "clientInput": false, "match": []}, {"id": "LG2", "stage": 4, "title": "Script and structure", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "day0", "start": 25, "end": 30, "after": ["LG1"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "clientInput": false, "match": []}, {"id": "LG3", "stage": 4, "title": "Editor assigned", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 30, "end": 31, "after": ["LG2"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "clientInput": false, "match": []}, {"id": "LG4", "stage": 4, "title": "Edited from existing footage — horizontal and vertical, horizontal primary", "owner": "Video Editor", "type": "task", "kind": "task", "from": "day0", "start": 31, "end": 40, "after": ["LG3", "C10"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "clientInput": false, "match": [], "note": "Waits on: LG3 accepted, C10"}, {"id": "LG5", "stage": 4, "title": "Delivered", "owner": "Video Editor", "type": "task", "kind": "task", "from": "day0", "start": 40, "end": 45, "after": ["LG4"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "clientInput": false, "match": []}, {"id": "F1", "stage": 4, "title": "PGS raises the founder video request", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 30, "end": 30, "after": ["P5"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "F2", "stage": 4, "title": "Founder questions prepared", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "day0", "start": 30, "end": 34, "after": ["F1"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "F3", "stage": 4, "title": "Founder timing, outfit and approach aligned with the client", "owner": "Shoot Coordinator", "type": "task", "kind": "task", "from": "day0", "start": 30, "end": 38, "after": ["F1"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": true, "match": []}, {"id": "F4", "stage": 4, "title": "Founder interview shot", "owner": "Shoot Coordinator + Videographer", "type": "task", "kind": "task", "from": "day0", "start": 38, "end": 42, "after": ["F2", "F3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "F5", "stage": 4, "title": "Raw footage uploaded and the PGS tagged", "owner": "Shoot Coordinator", "type": "task", "kind": "task", "from": "day0", "start": 42, "end": 42, "after": ["F4"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "F6", "stage": 4, "title": "Editor assigned", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 42, "end": 43, "after": ["F5"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "F7", "stage": 4, "title": "Drafts; first draft sent to the client", "owner": "Video Editor", "type": "task", "kind": "task", "from": "day0", "start": 43, "end": 52, "after": ["F6"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": [], "note": "Waits on: F6 accepted"}, {"id": "F8", "stage": 4, "title": "Brainstorming session", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 52, "end": 54, "after": ["F7"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "F9", "stage": 4, "title": "Final version delivered", "owner": "Video Editor", "type": "task", "kind": "task", "from": "day0", "start": 54, "end": 60, "after": ["F8"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": ["founder"]}, {"id": "V1", "stage": 4, "title": "PGS raises the testimonial request", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 30, "end": 30, "after": ["P5"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": [], "when": "realBuyers"}, {"id": "V2", "stage": 4, "title": "Testimonial questions prepared", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "day0", "start": 30, "end": 34, "after": ["V1"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": [], "when": "realBuyers"}, {"id": "V3", "stage": 4, "title": "Buyers, timing and location arranged with the client", "owner": "Shoot Coordinator", "type": "task", "kind": "task", "from": "day0", "start": 30, "end": 40, "after": ["V1"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": true, "match": [], "when": "realBuyers"}, {"id": "V4", "stage": 4, "title": "Testimonials shot", "owner": "Shoot Coordinator + Videographer", "type": "task", "kind": "task", "from": "day0", "start": 40, "end": 45, "after": ["V2", "V3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": [], "when": "realBuyers"}, {"id": "V5", "stage": 4, "title": "Raw footage uploaded and the PGS tagged", "owner": "Shoot Coordinator", "type": "task", "kind": "task", "from": "day0", "start": 45, "end": 45, "after": ["V4"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": [], "when": "realBuyers"}, {"id": "V6", "stage": 4, "title": "Editor assigned", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 45, "end": 46, "after": ["V5"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": [], "when": "realBuyers"}, {"id": "V7", "stage": 4, "title": "Drafts and final versions delivered", "owner": "Video Editor", "type": "task", "kind": "task", "from": "day0", "start": 46, "end": 60, "after": ["V6"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": ["testimonial"], "when": "realBuyers", "note": "Waits on: V6 accepted"}, {"id": "J1", "stage": 5, "title": "Meta campaign set up and scheduled: targeting, primary text, headline, lead form, budget", "owner": "PGS", "type": "ongoing", "kind": "ongoing", "from": "day0", "start": 12, "end": 15, "after": ["C13"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": ["meta"]}, {"id": "J2", "stage": 5, "title": "Client informed: area targeting, lead form questions, budget", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 15, "end": 15, "after": ["J1"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "J3", "stage": 5, "title": "Campaigns live; Ads Live Date recorded", "owner": "PGS", "type": "milestone", "kind": "milestone", "from": "day0", "start": 15, "end": 21, "after": ["J1", "L4", "N1", "O13"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": [], "gateInputs": ["C13", "L4", "N1", "O13", "J1"]}, {"id": "J4", "stage": 5, "title": "Refund claim window dates written onto the project: opens live +30, closes live +45", "owner": "PGS", "type": "task", "kind": "task", "from": "live", "start": 0, "end": 0, "after": ["J3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "J5", "stage": 5, "title": "WhatsApp nurturing sequence written, sent to the client and loaded into the CRM", "owner": "PGS", "type": "task", "kind": "task", "from": "live", "start": 0, "end": 6, "after": ["J3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "J6", "stage": 5, "title": "Email nurturing sequence written, sent and loaded", "owner": "PGS", "type": "task", "kind": "task", "from": "live", "start": 0, "end": 9, "after": ["J3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "clientInput": false, "match": ["email"]}, {"id": "J7", "stage": 5, "title": "Google Search campaign set up and scheduled", "owner": "PGS", "type": "ongoing", "kind": "ongoing", "from": "day0", "start": 21, "end": 24, "after": ["L4"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "clientInput": false, "match": ["google search", "google ads"]}, {"id": "J8", "stage": 5, "title": "Client informed: Google Search", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 24, "end": 24, "after": ["J7"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "clientInput": false, "match": []}, {"id": "J9", "stage": 5, "title": "YouTube campaign set up and scheduled", "owner": "PGS", "type": "ongoing", "kind": "ongoing", "from": "day0", "start": 22, "end": 25, "after": ["C15"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "clientInput": false, "match": ["youtube"]}, {"id": "J10", "stage": 5, "title": "Client informed: YouTube", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 25, "end": 25, "after": ["J9"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "clientInput": false, "match": []}, {"id": "J11", "stage": 5, "title": "Sample Flat Tour Video added to the live campaign", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 18, "end": 21, "after": ["C15"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "J12", "stage": 5, "title": "Follow-up message created and loaded as each trust asset lands: legacy video, founder video, testimonials", "owner": "PGS", "type": "ongoing", "kind": "ongoing", "from": "day0", "start": 45, "end": null, "after": ["F9", "V7"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "J13", "stage": 5, "title": "Retargeting campaigns set up: sample flat tour, VOVs, founder video, testimonials", "owner": "PGS", "type": "ongoing", "kind": "ongoing", "from": "day0", "start": 45, "end": null, "after": ["F9", "V7"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "J14", "stage": 5, "title": "Client informed: retargeting", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 47, "end": null, "after": ["J13"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "J15", "stage": 5, "title": "Call-review report sent and actions tracked", "owner": "PGS", "type": "repeating", "kind": "repeating", "from": "live", "start": 9, "end": null, "after": ["J3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": [], "note": "Packages: Monthly on Growth and Sell-Out; once inside the claim window on Starter · Repeats monthly"}, {"id": "J16", "stage": 5, "title": "Performance review call with the client", "owner": "PGS", "type": "repeating", "kind": "repeating", "from": "live", "start": 7, "end": null, "after": ["J3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": [], "note": "Packages: Weekly on Growth and Sell-Out; monthly on Starter"}, {"id": "J17", "stage": 5, "title": "Monthly strategy meeting with the client''s full team, targets set", "owner": "PGS", "type": "repeating", "kind": "repeating", "from": "live", "start": 30, "end": null, "after": ["J3"], "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "clientInput": false, "match": []}, {"id": "J18", "stage": 5, "title": "Continuation review: results against plan, next term''s quote", "owner": "PGS", "type": "milestone", "kind": "milestone", "from": "live", "start": 30, "end": 60, "after": ["J3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": [], "note": "Days: Month 2 on Starter; month 4 on Growth and Sell-Out", "byPackage": {"starter": {"start": 30, "end": 60}, "sell_out": {"start": 90, "end": 120}, "growth": {"start": 90, "end": 120}}}, {"id": "N1", "stage": 6, "title": "Lead capture set up: CRM tier per package, users, routing, alerts", "owner": "PGS", "type": "task", "kind": "task", "from": "start", "start": 3, "end": 19, "after": ["O7"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": ["neeti"]}, {"id": "N2", "stage": 6, "title": "Verified: ads running, leads arriving, setup correct, follow-up messages going out", "owner": "PGS", "type": "task", "kind": "task", "from": "live", "start": 0, "end": 3, "after": ["J3", "J5"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "N3", "stage": 6, "title": "Client''s sales team is actually working leads in the CRM", "owner": "PGS", "type": "ongoing", "kind": "ongoing", "from": "live", "start": 3, "end": null, "after": ["N2"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": []}, {"id": "A1", "stage": 7, "title": "Module 1: Project Brainstorm and Alignment", "owner": "Trainer", "type": "task", "kind": "task", "from": "day0", "start": 13, "end": 18, "after": ["P5"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": true, "match": ["alignment module", "module 1"]}, {"id": "A2", "stage": 7, "title": "Module 2: First-call rapport and qualification", "owner": "Trainer", "type": "task", "kind": "task", "from": "live", "start": 0, "end": 13, "after": ["J3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "clientInput": true, "match": ["module 2"]}, {"id": "A3", "stage": 7, "title": "Module 3: Objection handling and negotiation", "owner": "Trainer", "type": "task", "kind": "task", "from": "live", "start": 7, "end": 27, "after": ["A2"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "clientInput": true, "match": ["module 3"]}, {"id": "A4", "stage": 7, "title": "Module 4: Site-visit presence", "owner": "Trainer", "type": "task", "kind": "task", "from": "live", "start": 5, "end": 15, "after": ["A2"], "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "clientInput": true, "match": ["module 4"]}, {"id": "A5", "stage": 7, "title": "Ongoing sales team support, monthly", "owner": "Trainer", "type": "ongoing", "kind": "ongoing", "from": "live", "start": 29, "end": null, "after": ["A4"], "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": ["sales team support"]}, {"id": "A6", "stage": 7, "title": "Live group sales training, one session a month", "owner": "Trainer", "type": "ongoing", "kind": "ongoing", "from": "live", "start": 15, "end": null, "after": ["J3"], "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "clientInput": false, "match": ["group sales training", "group training"]}, {"id": "A7", "stage": 7, "title": "One-on-one coaching from AI Call Coach data", "owner": "Trainer", "type": "ongoing", "kind": "ongoing", "from": "live", "start": 15, "end": null, "after": ["N3"], "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "clientInput": false, "match": ["one-on-one", "coaching"]}, {"id": "K1", "stage": 8, "title": "PGS raises the CP kit and alignment video request", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 26, "end": 26, "after": ["P5"], "packages": {"sell_out": "yes", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": [], "note": "Packages: Bonus on Sell-Out; paid on request in Growth and Starter"}, {"id": "K2", "stage": 8, "title": "CP alignment video script", "owner": "Creative Strategist", "type": "task", "kind": "task", "from": "day0", "start": 26, "end": 30, "after": ["K1"], "packages": {"sell_out": "yes", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": []}, {"id": "K3", "stage": 8, "title": "Shoot, where the format needs one", "owner": "Shoot Coordinator + Videographer", "type": "task", "kind": "task", "from": "day0", "start": 30, "end": 34, "after": ["K2"], "packages": {"sell_out": "yes", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": []}, {"id": "K4", "stage": 8, "title": "Video edited", "owner": "Video Editor", "type": "task", "kind": "task", "from": "day0", "start": 34, "end": 39, "after": ["K3"], "packages": {"sell_out": "yes", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": [], "note": "Waits on: K3, or K2 where no shoot is needed"}, {"id": "K5", "stage": 8, "title": "Client confirmation taken, kit and video sent", "owner": "PGS", "type": "task", "kind": "task", "from": "day0", "start": 39, "end": 41, "after": ["K4"], "packages": {"sell_out": "yes", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": ["cp activation", "cp alignment", "channel partner"]}, {"id": "X2", "stage": 8, "title": "Brand Film — request, director engaged, script, shoot, edit, final", "owner": "PGS, CS, Cine Director, Shoot Coordinator, Video Editor", "type": "task", "kind": "task", "from": "bought", "start": 0, "end": 40, "after": [], "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": []}, {"id": "X5", "stage": 8, "title": "Extra model-led videos, extra hooks, extra creative volume", "owner": "Video + Design", "type": "task", "kind": "task", "from": "bought", "start": 0, "end": 25, "after": [], "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": []}, {"id": "X6", "stage": 8, "title": "Testimonial shoots beyond the package", "owner": "Shoot + Video Editor", "type": "task", "kind": "task", "from": "bought", "start": 0, "end": 25, "after": [], "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": []}, {"id": "X7", "stage": 8, "title": "Outside-city shoot coordination", "owner": "Shoot Coordinator", "type": "task", "kind": "task", "from": "bought", "start": 0, "end": null, "after": [], "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": [], "note": "Days: With the shoot"}, {"id": "X8", "stage": 8, "title": "Extra channel", "owner": "PGS", "type": "task", "kind": "task", "from": "bought", "start": 0, "end": 10, "after": [], "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": []}, {"id": "R1", "stage": 8, "title": "PGS raises the brand film request", "owner": "PGS", "type": "task", "kind": "task", "from": "bought", "start": 0, "end": 0, "after": [], "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": []}, {"id": "R2", "stage": 8, "title": "Cine director engaged as a freelancer", "owner": "Access Coordinator", "type": "task", "kind": "task", "from": "bought", "start": 0, "end": 5, "after": ["R1"], "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": []}, {"id": "R3", "stage": 8, "title": "Script written and finalised", "owner": "Creative Strategist with the director", "type": "task", "kind": "task", "from": "bought", "start": 5, "end": 15, "after": ["R2"], "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": []}, {"id": "R4", "stage": 8, "title": "Shoot notes, videographer notes and schedule finalised; client briefed on when and how", "owner": "Shoot Coordinator", "type": "task", "kind": "task", "from": "bought", "start": 15, "end": 20, "after": ["R3"], "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "clientInput": true, "match": []}, {"id": "R5", "stage": 8, "title": "Brand film shot, director present the whole day", "owner": "Shoot Coordinator + Director + Videographer", "type": "task", "kind": "task", "from": "bought", "start": 20, "end": 25, "after": ["R4"], "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": []}, {"id": "R6", "stage": 8, "title": "Raw footage uploaded and the PGS tagged", "owner": "Shoot Coordinator", "type": "task", "kind": "task", "from": "bought", "start": 25, "end": 25, "after": ["R5"], "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": []}, {"id": "R7", "stage": 8, "title": "Editor assigned, director stays involved through editing", "owner": "PGS", "type": "task", "kind": "task", "from": "bought", "start": 25, "end": 26, "after": ["R6"], "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": []}, {"id": "R8", "stage": 8, "title": "Brand film drafts", "owner": "Video Editor with the director", "type": "task", "kind": "task", "from": "bought", "start": 26, "end": 33, "after": ["R7"], "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": [], "note": "Waits on: R7 accepted"}, {"id": "R9", "stage": 8, "title": "Final brainstorming: CS, director, PGS, video editor", "owner": "PGS", "type": "task", "kind": "task", "from": "bought", "start": 33, "end": 36, "after": ["R8"], "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": []}, {"id": "R10", "stage": 8, "title": "Final brand film released", "owner": "Video Editor", "type": "task", "kind": "task", "from": "bought", "start": 36, "end": 40, "after": ["R9"], "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "clientInput": false, "match": ["brand film"], "note": "Waits on: R9, director and client confirmation"}]}'::jsonb,
  'Delivery Timeline v2 (Kazuk, 9 Nov 2026): 135 steps in 9 phases on three clocks (invoice paid, inputs complete, ads live)')
  from pulse.delivery_template d where d.org_id = '6f1a455d-ced2-504d-b8d5-5ae0efbe7c75' and d.key = 'agency-creative';
select set_config('pulse.org_id', '', true);

-- migrate:down
drop trigger task_plan_clock on pulse.task;
drop trigger task_plan_guard on pulse.task;
drop function pulse.task_plan_clock();
drop function pulse.task_plan_guard();
drop function pulse.project_live_record(uuid, date);
drop function pulse.project_day0_declare(uuid, date);
drop function pulse.project_clock_record(uuid, text, date);
drop function pulse.project_plan_reclock(uuid, text);
drop function pulse.delivery_template_save(text, text, jsonb, text);
drop function pulse.delivery_template_file(text, text, jsonb, text);
drop function pulse.delivery_template_check(jsonb);
drop function pulse.plan_open_inputs(uuid, text);
drop function pulse.plan_step_role(jsonb);
drop function pulse.plan_by_person();
drop function pulse.plan_step_due(pulse.project_plan, jsonb, text);
drop function pulse.plan_clock_on(pulse.project_plan, text);
drop function pulse.plan_step_running(uuid, text, text);
drop function pulse.plan_step_type(jsonb);
drop function pulse.plan_step(uuid, text);
drop function pulse.plan_definition(uuid);
alter table pulse.project_plan drop constraint project_plan_live, drop constraint project_plan_clocks, drop column live_at, drop column live_by, drop column live_on,
  drop column day0_at, drop column day0_by, drop column day0_on, drop column template_version;
drop table pulse.delivery_template_version;
