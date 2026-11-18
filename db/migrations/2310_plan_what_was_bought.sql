-- migrate:up
-- PM-BUILD-2 (18 Nov 2026; KAZUK-PM-2 phase 2, "what was bought, by whom"). Widens the delivery template and plan of
-- 1385/1387/1471/2262 again; still no new module and no new table. Every word below is the template's; the code names
-- no company.
--  * A plan is built from WHAT WAS BOUGHT (Kazuk's fixed rule 1). A template step may name the catalogue codes it
--    delivers (`lines`, LIKE patterns such as 'EA-P2-MV-%'); a package names its own codes too. When the project's paid
--    documents carry coded lines, a step with codes is made only when a line with one of them was bought (quantity and
--    "removed from the package" included), and a step without codes follows the package as before. The step that is the
--    bought thing itself (`deliver`) takes the per-unit tasks the paid invoice made ("Model video #1, #2"), so nothing
--    is made twice. Documents with no codes (older quotes) keep the words of 1471/2262.
--  * pulse.project_bought_lines: the coded lines of a project's paid invoices (or of its quotation, when it was started
--    from one), with the day each was bought. An add-on paid later (1688's "scope added") adds its steps to the running
--    plan on the "bought" clock, counted from its own purchase day; no other date moves (project_plan_add_lines).
--  * WHO DOES WHAT on this project (project_plan.roles): a person per template role, or "nobody holds it here". A holder
--    takes the role's steps that have nobody yet and joins the project; "nobody" leaves those steps out ("no empty
--    cards"), listed as not made, and they come back if a holder is named later.
--  * CONDITIONS (project_plan.conditions): a step with `when` is made once the person running the project says its
--    condition holds ("real buyers exist").
--  * REPEATING steps with a `repeat` rule get one card per time, made a week ahead (pulse.project_plans_roll, run with
--    the late-work sync every 10 minutes).
--  * WHAT WE PROMISED (project_plan.promise): the template's sales-set fields. A salesperson's change is the promise;
--    anyone else's is a proposal that sales confirms (Kazuk: "nobody edits the promise alone"). The worked-out numbers
--    are never typed: the API works them out from the template's formulas.
--  * DATE MOVES follow the template: its own reasons, and who moves dates (EA: the project's lead; leadership can step
--    in, and it is logged). Moving the go-live step tells the project heads.
--  * PAUSE: restarting moves only what the pause stopped (open tasks; the campaign months and guarantee windows move by
--    the paused days through project_plan.live_paused).
--  * START: the company's "start the project when" setting (handover.startAt: first_payment, or paid_in_full).
--  * CHATS: the person running a project links its chat groups to it (pulse.project_chat_link; until now only group
--    admins could, through the groups hub), so a chat's /task and later its updates know their project.
--  * Estate Autopilots' template v4 = v3 plus its catalogue codes, roles, conditions, repeat rules, date-move reasons,
--    promise fields and formulas. Written only to that company; plans keep the version they were laid out from.

alter table pulse.project_plan
  add column lines jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array' and pg_column_size(lines) < 60000),
  add column roles jsonb not null default '{}'::jsonb check (jsonb_typeof(roles) = 'object' and pg_column_size(roles) < 30000),
  add column conditions jsonb not null default '{}'::jsonb check (jsonb_typeof(conditions) = 'object' and pg_column_size(conditions) < 4000),
  add column promise jsonb not null default '{}'::jsonb check (jsonb_typeof(promise) = 'object' and pg_column_size(promise) < 30000),
  add column live_paused int not null default 0 check (live_paused between 0 and 3650);
comment on column pulse.project_plan.lines is 'PM-BUILD-2 (2310): the catalogue codes bought for this project ({code, qty, on, doc, line}); steps with codes are made from them';
comment on column pulse.project_plan.roles is 'PM-BUILD-2 (2310): who does what on this project: template role -> {person} or {none: true, closed: [task ids]}';
comment on column pulse.project_plan.conditions is 'PM-BUILD-2 (2310): the template conditions that hold for this project ({realBuyers: true})';
comment on column pulse.project_plan.promise is 'PM-BUILD-2 (2310): what we promised: {values, confirmedBy, confirmedAt, setBy, setAt, pending: {values, by, at, note}}';
comment on column pulse.project_plan.live_paused is 'PM-BUILD-2 (2310): days the client clocks (campaign months, guarantee windows) stood still while paused';

-- A company's own reasons for moving a date (the template's list); Pulse's earlier list stays valid.
alter table pulse.project_date_change drop constraint project_date_change_reason_kind_check,
  add constraint project_date_change_reason_kind_check check (reason_kind ~ '^[a-z][a-z0-9_]{1,39}$');

-- Does a catalogue code match any of a step's patterns ('EA-P2-MV-%')?
create function pulse.plan_codes_match(p_patterns jsonb, p_code text) returns boolean
  language sql immutable set search_path = pulse, pg_temp as $$
  select coalesce(p_code is not null and jsonb_typeof(p_patterns) = 'array'
    and exists(select 1 from jsonb_array_elements_text(p_patterns) x where upper(p_code) like upper(x)), false)
$$;

-- What was bought for a project: the coded lines of its paid invoices (from the quotation each came from, as 1471 makes
-- the work), or of the quotation it was started from. A part removed from its package and a "to be quoted" line are not
-- bought; a package sold as one line counts its parts; a part line also counts its package's own code.
create function pulse.project_bought_lines(p_project uuid) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  with linked as (
    select d.id, d.doc_type, d.issue_date, d.created_at,
      case when d.doc_type = 'invoice' then coalesce(
        (select x.id from pulse.erp_document x where x.id = d.source_id and x.doc_type = 'quotation'),
        (select y.id from pulse.erp_document x join pulse.erp_document y on y.id = x.source_id where x.id = d.source_id and x.doc_type = 'proforma' and y.doc_type = 'quotation'),
        d.id) else d.id end src
    from pulse.project_quote pq join pulse.erp_document d on d.id = pq.document_id
    where pq.org_id = pulse.current_org() and pq.project_id = p_project and d.doc_type in ('invoice', 'quotation')
      and d.status not in ('draft', 'cancelled') and (d.doc_type = 'quotation' or d.status in ('part_paid', 'paid'))),
  docs as (
    select distinct on (src) src, id doc,
      coalesce((select min(p.received_on) from pulse.erp_payment p where p.document_id = linked.id and p.voided_at is null), issue_date,
        (select pl.kickoff from pulse.project_plan pl where pl.project_id = p_project)) on_day
    from linked order by src, (doc_type = 'invoice') desc, created_at),
  coded as (
    select dc.doc, dc.on_day, l.id line, it.code, coalesce(l.qty, 1) qty from docs dc join pulse.erp_line l on l.document_id = dc.src join pulse.erp_item it on it.id = l.item_id
      where l.parent_position is null and not coalesce(l.not_needed, false) and coalesce(l.line_role, '') <> 'to_quote' and it.code is not null
    union all
    select dc.doc, dc.on_day, l.id, pit.code, coalesce(pp.quantity, 1) * coalesce(l.qty, 1) from docs dc join pulse.erp_line l on l.document_id = dc.src
      join pulse.erp_item it on it.id = l.item_id and it.kind = 'package' join pulse.erp_package_part pp on pp.package_id = it.id join pulse.erp_item pit on pit.id = pp.item_id
      where l.parent_position is null and not coalesce(l.not_needed, false) and pit.code is not null
    union all
    select distinct dc.doc, dc.on_day, null::uuid, pk.code, 1 from docs dc join pulse.erp_line l on l.document_id = dc.src join pulse.erp_item pk on pk.id = l.package_id
      where pk.code is not null and not coalesce(l.not_needed, false))
  select coalesce(jsonb_agg(jsonb_build_object('code', code, 'qty', qty, 'on', on_day, 'doc', doc, 'line', line) order by on_day, code), '[]'::jsonb) from coded
$$;

-- The day a step's lines were first bought (its "bought" clock); null when none of them was.
create function pulse.plan_step_bought(p_lines jsonb, p_step jsonb) returns date
  language sql immutable set search_path = pulse, pg_temp as $$
  select min((x->>'on')::date) from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x where pulse.plan_codes_match(p_step->'lines', x->>'code')
$$;

-- Do the bought lines speak this template's codes? (Older quotes carry other codes, or none: then the package decides.)
create function pulse.plan_coded(p_def jsonb, p_lines jsonb) returns boolean
  language sql immutable set search_path = pulse, pg_temp as $$
  select exists(select 1 from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x
    where exists(select 1 from jsonb_array_elements(coalesce(p_def->'steps', '[]'::jsonb)) s where pulse.plan_codes_match(s->'lines', x->>'code')))
$$;

-- The lines a plan is built from: what was bought, when it speaks the template's codes; else none (the package decides).
create function pulse.plan_lines_used(p_def jsonb, p_lines jsonb) returns jsonb
  language sql immutable set search_path = pulse, pg_temp as $$
  select case when pulse.plan_coded(p_def, p_lines) then p_lines else '[]'::jsonb end
$$;

-- Whether a template step is made for this plan, else why not (in the plan's own words). p_lines: plan_lines_used.
--   not_sold   the package does not include it (or only as an option, and nothing named it bought);
--   not_bought its catalogue codes were not bought;
--   auto       the system does it ("the paid invoice creates the project");
--   condition  its condition does not hold yet;
--   role       nobody holds its role on this project.
create function pulse.plan_step_why_not(p_def jsonb, p_step jsonb, p_package text, p_lines jsonb, p_conditions jsonb, p_roles jsonb) returns text
  language plpgsql immutable set search_path = pulse, pg_temp as $$
declare flag text := coalesce(p_step->'packages'->>p_package, 'no'); coded boolean; rl text := coalesce(nullif(p_step->>'role', ''), pulse.plan_step_role(p_step));
begin
  if pulse.plan_step_type(p_step) = 'auto' then return 'auto'; end if;
  coded := exists(select 1 from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x where nullif(x->>'code', '') is not null);
  if coded and jsonb_typeof(p_step->'lines') = 'array' and jsonb_array_length(p_step->'lines') > 0 then
    if pulse.plan_step_bought(p_lines, p_step) is null then return 'not_bought'; end if;
  elsif flag <> 'yes' then return 'not_sold';
  end if;
  if p_step ? 'when' and not coalesce((p_conditions->>(p_step->>'when'))::boolean, false) then return 'condition'; end if;
  if rl is not null and coalesce((p_roles->rl->>'none')::boolean, false) then return 'role'; end if;
  return null;
end $$;

-- 2262's due day, with the "bought" clock (an add-on counts from its own purchase day) and a repeating step's first time.
create or replace function pulse.plan_step_due(p_plan pulse.project_plan, p_step jsonb, p_package text, out due timestamptz, out work_on date)
  language plpgsql stable set search_path = pulse, pg_temp as $$
declare base date; bp jsonb := p_step->'byPackage'->p_package; s int; e int;
begin
  base := case when coalesce(p_step->>'from', 'start') = 'bought' then coalesce(pulse.plan_step_bought(p_plan.lines, p_step), p_plan.kickoff)
    else pulse.plan_clock_on(p_plan, p_step->>'from') end;
  if base is null then return; end if;
  s := coalesce((bp->>'start')::int, (p_step->>'start')::int, 0);
  e := case when bp is not null then (bp->>'end')::int else (p_step->>'end')::int end;
  if e is null and jsonb_typeof(p_step->'repeat') = 'object' then e := s; end if;
  due := case when e is null then null else ((base + e) + time '18:00') at time zone pulse.org_time_zone() end;
  work_on := base + greatest(0, s);
end $$;

-- Make the plan's missing steps, as the plan stands (its template version, what was bought, its conditions and roles).
-- A bought thing's units (the paid invoice's tasks, one per unit) take the step that delivers them; a quotation line
-- without codes still takes a step by its words (2262). Returns what was made.
create function pulse.project_plan_fill(p_project uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); pl pulse.project_plan; def jsonb; st jsonb; made int := 0; matched int := 0; tid uuid; dd record; ttl text; kw text; i int;
  rl text; hrs jsonb; lead uuid; holder uuid; why text; coded boolean; leadrole text; isbought boolean; used jsonb;
begin
  select * into pl from pulse.project_plan where org_id = pulse.current_org() and project_id = p_project for update;
  if pl.project_id is null then return jsonb_build_object('tasks', 0, 'matched', 0); end if;
  def := pulse.plan_definition(p_project);
  lead := (select lead_person_id from pulse.project where id = p_project);
  leadrole := def->'bandwidth'->>'role';
  used := pulse.plan_lines_used(def, pl.lines);
  coded := jsonb_array_length(used) > 0;
  for st in select x from jsonb_array_elements(coalesce(def->'steps', '[]'::jsonb)) x loop
    why := pulse.plan_step_why_not(def, st, pl.package, used, pl.conditions, pl.roles);
    isbought := coded and jsonb_typeof(st->'lines') = 'array' and jsonb_array_length(st->'lines') > 0;
    -- An option of the package that a quotation line names by its words is still made (2262), when nothing is coded.
    continue when why is not null and not (why = 'not_sold' and not coded and coalesce(st->'packages'->>pl.package, 'no') = 'optional');
    continue when exists(select 1 from pulse.task t where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.template_step = st->>'id');
    select * into dd from pulse.plan_step_due(pl, st, pl.package);
    rl := coalesce(nullif(st->>'role', ''), pulse.plan_step_role(st));
    holder := case when rl is not null and pl.roles->rl ? 'person' then (pl.roles->rl->>'person')::uuid when rl = leadrole or st->>'owner' = leadrole then lead end;
    i := 0;
    if isbought and coalesce((st->>'deliver')::boolean, false) then
      -- The bought units (tasks the paid invoice made from its coded lines) take the step that delivers them.
      with hit as (update pulse.task t set template_step = st->>'id', phase_key = 's' || (st->>'stage'), due_at = coalesce(t.due_at, dd.due), work_on = coalesce(t.work_on, dd.work_on),
          role_key = coalesce(t.role_key, rl), assignee_person_id = coalesce(t.assignee_person_id, holder), updated_at = now(), edited_by = me
        where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.source = 'quote' and t.template_step is null
          and exists(select 1 from pulse.erp_line l left join pulse.erp_item it on it.id = l.item_id
            left join pulse.erp_package_part pp on pp.package_id = l.item_id and t.source_key like format('quote:%s:%s:%%', l.id, pp.position)
            left join pulse.erp_item pit on pit.id = pp.item_id
            where l.id::text = t.source_ref and pulse.plan_codes_match(st->'lines', coalesce(pit.code, it.code)))
        returning t.id)
      select count(*) into i from hit;
    elsif not coded then
      for kw in select jsonb_array_elements_text(coalesce(st->'match', '[]'::jsonb)) loop
        with hit as (update pulse.task t set template_step = st->>'id', phase_key = 's' || (st->>'stage'), due_at = coalesce(t.due_at, dd.due),
            work_on = coalesce(t.work_on, dd.work_on), role_key = coalesce(t.role_key, rl), updated_at = now(), edited_by = me
          where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.source = 'quote' and t.template_step is null
            and lower(t.title) like '%' || lower(kw) || '%' returning t.id)
        select count(*) into i from hit;
        exit when i > 0;
      end loop;
    end if;
    matched := matched + i;
    continue when i > 0 or why is not null;
    ttl := left(format('%s %s', st->>'id', st->>'title'), 300);
    hrs := st->'hours';
    insert into pulse.task(org_id, project_id, title, assignee_person_id, role_key, created_by, created_at, assigned_at, due_at, work_on,
        source, source_key, template_step, phase_key, notes, status, estimate_minutes)
      values (pulse.current_org(), p_project, ttl, holder, rl, me, now(), now(), dd.due, dd.work_on,
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
  return jsonb_build_object('tasks', made, 'matched', matched);
end $$;

-- 2262's lay-out, from what was bought. The plan keeps its template version when it is laid out again (it used to move
-- to the newest); a new plan takes the newest. The package is the one chosen, else the one whose codes were bought.
create or replace function pulse.project_plan_lay(p_project uuid, p_template text, p_package text, p_category text, p_kickoff date, p_lead uuid)
  returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); def jsonb; pr pulse.project; ver int; r jsonb; skipped int; pl pulse.project_plan; bought jsonb; codepkg text;
begin
  select * into pr from pulse.project where org_id = pulse.current_org() and id = p_project and deleted_at is null;
  if pr.id is null then raise exception 'Project not found' using errcode = 'P0002'; end if;
  select definition into def from pulse.delivery_template where org_id = pulse.current_org() and key = p_template;
  if def is null then raise exception 'Choose a delivery template' using errcode = '22023'; end if;
  bought := pulse.project_bought_lines(p_project);
  -- What was bought names its package (a package's own codes); that wins over a guess from the words of the lines.
  select x->>'key' into codepkg from jsonb_array_elements(def->'packages') with ordinality t(x, o)
    where exists(select 1 from jsonb_array_elements(bought) b where pulse.plan_codes_match(x->'lines', b->>'code')) order by o limit 1;
  p_package := coalesce(codepkg, p_package);
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
  update pulse.project set starts_on = coalesce(starts_on, p_kickoff), updated_at = now() where id = p_project;
  select max(version) into ver from pulse.delivery_template_version where org_id = pulse.current_org() and key = p_template;
  insert into pulse.project_plan(org_id, project_id, template_key, package, category, kickoff, created_by, template_version, lines)
    values (pulse.current_org(), p_project, p_template, p_package, p_category, p_kickoff, me, ver, bought)
    on conflict (project_id) do update set template_key = excluded.template_key, package = excluded.package, category = excluded.category, kickoff = excluded.kickoff,
      template_version = case when pulse.project_plan.template_key = excluded.template_key then coalesce(pulse.project_plan.template_version, excluded.template_version) else excluded.template_version end,
      lines = excluded.lines, updated_at = now()
    returning * into pl;
  r := pulse.project_plan_fill(p_project);
  def := pulse.plan_definition(p_project);
  select count(*) into skipped from jsonb_array_elements(coalesce(def->'steps', '[]'::jsonb)) x
    where pulse.plan_step_why_not(def, x, pl.package, pulse.plan_lines_used(def, pl.lines), pl.conditions, pl.roles) in ('auto', 'condition', 'role', 'not_bought');
  perform pulse.audit_write('project_plan_set', 'project', p_project::text);
  return jsonb_build_object('projectId', p_project, 'tasks', (r->>'tasks')::int, 'matched', (r->>'matched')::int, 'notMade', skipped, 'version', pl.template_version, 'package', pl.package);
end $$;

-- An add-on bought later: its steps join the running plan on their own purchase day; no other date moves.
create function pulse.project_plan_add_lines(p_project uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r jsonb;
begin
  if not exists(select 1 from pulse.project_plan where org_id = pulse.current_org() and project_id = p_project) then return jsonb_build_object('tasks', 0); end if;
  update pulse.project_plan set lines = pulse.project_bought_lines(p_project), updated_at = now() where org_id = pulse.current_org() and project_id = p_project;
  r := pulse.project_plan_fill(p_project);
  perform pulse.audit_write('project_plan_add_lines', 'project', p_project::text);
  return r;
end $$;

create function pulse.project_plan_on_scope() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if new.kind <> 'project_scope_added' or nullif(new.detail->>'projectId', '') is null then return null; end if;
  begin
    perform pulse.project_plan_add_lines((new.detail->>'projectId')::uuid);
  exception when others then
    perform pulse.erp_log('document', new.subject_id, 'project_plan_failed', jsonb_build_object('error', left(sqlerrm, 300)));
  end;
  return null;
end $$;
create trigger project_plan_on_scope after insert on pulse.erp_event for each row when (new.kind = 'project_scope_added') execute function pulse.project_plan_on_scope();

-- Who does what on this project. p_roles: {"Video Editor": "<person id>" | "none" | null}. A holder takes the role's
-- steps that have nobody yet and joins the project; "none" leaves the role's untouched steps out (cancelled with the
-- note "Not made: nobody holds …", their ids kept to bring them back); null forgets the choice. The project's lead, its manager, the heads and leadership decide it.
create function pulse.project_plan_roles_set(p_project uuid, p_roles jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); pl pulse.project_plan; k text; v jsonb; who uuid; cur jsonb; assigned int := 0; closed int := 0; reopened int := 0; ids uuid[]; n int;
  nm text := (select coalesce(title, name) from pulse.project where id = p_project);
begin
  if not pulse.plan_by_person() then raise exception 'Only a person decides who does what on a project' using errcode = '42501'; end if;
  if not pulse.project_can_run(p_project) then raise exception 'Only the project''s lead, its manager and leadership decide who does what' using errcode = '42501'; end if;
  select * into pl from pulse.project_plan where org_id = pulse.current_org() and project_id = p_project for update;
  if pl.project_id is null then raise exception 'This project has no delivery plan' using errcode = 'P0002'; end if;
  if jsonb_typeof(p_roles) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_roles)) > 40 then raise exception 'Choose who does each role' using errcode = '22023'; end if;
  cur := pl.roles;
  for k, v in select * from jsonb_each(p_roles) loop
    if length(k) not between 1 and 60 then raise exception 'Choose a role of the plan' using errcode = '22023'; end if;
    -- Bring back what "nobody" left out, before anything else changes.
    if coalesce((cur->k->>'none')::boolean, false) and not (jsonb_typeof(v) = 'string' and v #>> '{}' = 'none') then
      ids := array(select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(cur->k->'closed', '[]'::jsonb)) x);
      with back as (update pulse.task t set status = 'open', updated_at = now(), edited_by = me where t.id = any(ids) and t.org_id = pulse.current_org() and t.status = 'cancelled' and t.deleted_at is null returning t.id)
      insert into pulse.task_event(org_id, task_id, actor_id, kind, from_value, to_value, note) select pulse.current_org(), id, me, 'status', 'cancelled', 'open', left(format('%s is staffed on this project again', k), 1000) from back;
      get diagnostics n = row_count; reopened := reopened + n;
    end if;
    if jsonb_typeof(v) = 'null' then cur := cur - k;
    elsif v #>> '{}' = 'none' then
      ids := array(select t.id from pulse.task t where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.template_step is not null
        and t.role_key = k and t.status = 'open' and t.assignee_person_id is null and t.started_at is null);
      update pulse.task set status = 'cancelled', updated_at = now(), edited_by = me where id = any(ids);
      insert into pulse.task_event(org_id, task_id, actor_id, kind, from_value, to_value, note) select pulse.current_org(), x, me, 'status', 'open', 'cancelled', left(format('Not made: nobody holds %s on this project', k), 1000) from unnest(ids) x;
      closed := closed + cardinality(ids);
      cur := jsonb_set(cur, array[k], jsonb_build_object('none', true, 'closed', to_jsonb(ids), 'by', me, 'at', now()));
    else
      who := case when v #>> '{}' ~ '^[0-9a-f-]{36}$' then (v #>> '{}')::uuid end;
      if who is null or not exists(select 1 from pulse.person where org_id = pulse.current_org() and id = who and side = 'staff' and status = 'active') then
        raise exception 'Choose an active member of staff for %', k using errcode = '22023'; end if;
      cur := jsonb_set(cur, array[k], jsonb_build_object('person', who, 'by', me, 'at', now()));
      insert into pulse.project_member(org_id, project_id, person_id, role, added_by)
        select pulse.current_org(), p_project, who, 'member', me where not exists(select 1 from pulse.project_member m where m.project_id = p_project and m.person_id = who and m.left_at is null);
      with mine as (update pulse.task t set assignee_person_id = who, assigned_at = now(), updated_at = now(), edited_by = me
          where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.template_step is not null and t.role_key = k
            and t.assignee_person_id is null and t.status in ('open', 'in_progress', 'blocked', 'unknown') returning t.id)
      select count(*) into n from mine;
      assigned := assigned + n;
      if n > 0 and who is distinct from me then
        perform pulse.work_notify(who, 'project.added', 'project', p_project, left(format('plan.role:%s:%s:%s', p_project, md5(k), who), 200),
          left(format('%s %s on %s %s yours (%s)', n, case when n = 1 then 'step' else 'steps' end, nm, case when n = 1 then 'is' else 'are' end, k), 160), '/tasks/projects/' || p_project, 'task');
      end if;
    end if;
  end loop;
  update pulse.project_plan set roles = cur, updated_at = now() where project_id = p_project;
  -- A role now held may have steps that were never made (they were left out when the plan was laid out).
  perform pulse.project_plan_fill(p_project);
  perform pulse.audit_write('project_plan_roles_set', 'project', p_project::text);
  return jsonb_build_object('assigned', assigned, 'notMade', closed, 'back', reopened);
end $$;

-- A condition of the template holds (or no longer does) for this project. When it holds, its steps are made; when it
-- no longer does, its steps that nobody has started are left out again.
create function pulse.project_plan_condition_set(p_project uuid, p_key text, p_on boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); pl pulse.project_plan; def jsonb; r jsonb; n int := 0; lbl text;
begin
  if not pulse.plan_by_person() then raise exception 'Only a person says what holds for a project' using errcode = '42501'; end if;
  if not pulse.project_can_run(p_project) then raise exception 'Only the project''s lead, its manager and leadership change the plan' using errcode = '42501'; end if;
  select * into pl from pulse.project_plan where org_id = pulse.current_org() and project_id = p_project for update;
  if pl.project_id is null then raise exception 'This project has no delivery plan' using errcode = 'P0002'; end if;
  def := pulse.plan_definition(p_project);
  select x->>'label' into lbl from jsonb_array_elements(coalesce(def->'conditions', '[]'::jsonb)) x where x->>'key' = p_key;
  if lbl is null then raise exception 'This plan has no such condition' using errcode = '22023'; end if;
  update pulse.project_plan set conditions = conditions || jsonb_build_object(p_key, coalesce(p_on, false)), updated_at = now() where project_id = p_project;
  if coalesce(p_on, false) then
    -- Steps left out when it last did not hold come back; the rest are made.
    with back as (update pulse.task t set status = 'open', updated_at = now(), edited_by = me
      where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.status = 'cancelled'
        and pulse.plan_step(p_project, t.template_step)->>'when' = p_key
        and (select e.note from pulse.task_event e where e.task_id = t.id and e.kind = 'status' order by e.at desc limit 1) like 'Not made:%' returning t.id)
    insert into pulse.task_event(org_id, task_id, actor_id, kind, from_value, to_value, note) select pulse.current_org(), id, me, 'status', 'cancelled', 'open', left(lbl || ' holds', 1000) from back;
    get diagnostics n = row_count;
    r := pulse.project_plan_fill(p_project);
    r := jsonb_build_object('tasks', coalesce((r->>'tasks')::int, 0) + n); n := 0;
  else
    with gone as (update pulse.task t set status = 'cancelled', updated_at = now(), edited_by = me
      where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.status = 'open' and t.started_at is null
        and pulse.plan_step(p_project, t.template_step)->>'when' = p_key returning t.id)
    insert into pulse.task_event(org_id, task_id, actor_id, kind, from_value, to_value, note) select pulse.current_org(), id, me, 'status', 'open', 'cancelled', left('Not made: ' || lower(lbl) || ' does not hold', 1000) from gone;
    get diagnostics n = row_count;
  end if;
  perform pulse.audit_write('project_plan_condition_set', 'project', p_project::text);
  return jsonb_build_object('key', p_key, 'on', coalesce(p_on, false), 'tasks', coalesce((r->>'tasks')::int, 0), 'notMade', n);
end $$;

-- Repeating steps: one card per time, made a week ahead, from the step's first time on its clock (a "repeat" rule of
-- every N days, other days per package). Run for the whole company by the late-work sync; nothing runs before the
-- step's clock is recorded, and a project that is not active makes none.
create function pulse.project_plans_roll() returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare pl pulse.project_plan; st jsonb; every int; base date; s int; k int; d date; made int := 0; tid uuid; first pulse.task; ttl text;
  today date := (now() at time zone pulse.org_time_zone())::date; rp jsonb;
begin
  if pulse.current_org() is null then return 0; end if;
  for pl in select x.* from pulse.project_plan x join pulse.project p on p.id = x.project_id and p.deleted_at is null and p.status = 'active' where x.org_id = pulse.current_org() loop
    for st in select x from jsonb_array_elements(coalesce(pulse.plan_definition(pl.project_id)->'steps', '[]'::jsonb)) x where jsonb_typeof(x->'repeat') = 'object' loop
      rp := coalesce(st->'repeat'->'byPackage'->pl.package, st->'repeat');
      every := nullif((rp->>'every')::int, 0);
      continue when every is null or every < 1;
      base := pulse.plan_clock_on(pl, st->>'from');
      continue when base is null;
      select * into first from pulse.task t where t.org_id = pulse.current_org() and t.project_id = pl.project_id and t.source_key = format('plan:%s:%s', pl.project_id, st->>'id') and t.deleted_at is null;
      continue when first.id is null or first.status in ('cancelled', 'not_applicable', 'merged');
      s := coalesce((st->'byPackage'->pl.package->>'start')::int, (st->>'start')::int, 0);
      for k in 2 .. least(60, coalesce((rp->>'times')::int, 60)) loop
        d := base + s + every * (k - 1);
        exit when d > today + 7;
        ttl := left(format('%s %s · %s', st->>'id', st->>'title', to_char(d, 'DD Mon')), 300);
        insert into pulse.task(org_id, project_id, title, assignee_person_id, role_key, created_by, created_at, assigned_at, due_at, work_on, source, source_key, template_step, phase_key, status)
          values (pulse.current_org(), pl.project_id, ttl, first.assignee_person_id, first.role_key, null, now(), now(), (d + time '18:00') at time zone pulse.org_time_zone(), d,
            'template', format('plan:%s:%s:%s', pl.project_id, st->>'id', k), st->>'id', first.phase_key, 'open')
          on conflict (org_id, source_key) do nothing returning id into tid;
        if tid is not null then
          insert into pulse.task_event(org_id, task_id, actor_id, kind, to_value, note) values (pulse.current_org(), tid, null, 'created', ttl, 'From the delivery plan: it repeats');
          made := made + 1; tid := null;
        end if;
      end loop;
    end loop;
  end loop;
  return made;
end $$;

-- Someone told about a project (a salesperson asked to confirm, a head told of a go-live move) joins it as a member, so
-- the notice reaches them (a project's notices go to its members) and the link opens; as 1471 makes the heads members.
create function pulse.project_watch(p_project uuid, p_person uuid) returns void
  language sql security definer set search_path = pulse, pg_temp as $$
  insert into pulse.project_member(org_id, project_id, person_id, role, added_by)
    select pulse.current_org(), p_project, p_person, 'member', pulse.current_viewer()
    where p_person is not null and not exists(select 1 from pulse.project_member m where m.project_id = p_project and m.person_id = p_person and m.left_at is null)
      and exists(select 1 from pulse.person x where x.org_id = pulse.current_org() and x.id = p_person and x.side = 'staff' and x.status = 'active')
$$;

-- What we promised. Is the viewer sales for this project (the deal's salesperson, or a sales seat)?
create function pulse.project_is_sales(p_project uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select pulse.current_viewer() is not null and (pulse.viewer_is('sales', 'sales_head')
    or exists(select 1 from pulse.project_quote pq join pulse.erp_document d on d.id = pq.document_id
      where pq.org_id = pulse.current_org() and pq.project_id = p_project and d.salesperson_id = pulse.current_viewer()))
$$;

-- Who confirms a promise for a project: the deal's salesperson, else the head of sales, else the sales seats, else leadership.
create function pulse.project_promise_confirmers(p_project uuid) returns uuid[]
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(
    nullif(array(select distinct d.salesperson_id from pulse.project_quote pq join pulse.erp_document d on d.id = pq.document_id join pulse.person p on p.id = d.salesperson_id
      where pq.org_id = pulse.current_org() and pq.project_id = p_project and p.status = 'active'), '{}'),
    nullif(array(select distinct ra.person_id from pulse.role_assignment ra join pulse.person p on p.id = ra.person_id where ra.org_id = pulse.current_org() and ra.role_key = 'sales_head'
      and p.side = 'staff' and p.status = 'active' and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity')), '{}'),
    nullif(array(select distinct ra.person_id from pulse.role_assignment ra join pulse.person p on p.id = ra.person_id where ra.org_id = pulse.current_org() and ra.role_key = 'sales'
      and p.side = 'staff' and p.status = 'active' and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity')), '{}'),
    nullif(array(select distinct ra.person_id from pulse.role_assignment ra join pulse.person p on p.id = ra.person_id where ra.org_id = pulse.current_org() and ra.role_key = 'leadership'
      and p.side = 'staff' and p.status = 'active' and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity')), '{}'),
    '{}')
$$;

-- Check promise values against the template's fields: numbers for number fields, short text for text fields.
create function pulse.project_promise_clean(p_def jsonb, p_values jsonb) returns jsonb
  language plpgsql immutable set search_path = pulse, pg_temp as $$
declare f jsonb; out jsonb := '{}'; v jsonb; n numeric;
begin
  if jsonb_typeof(p_values) is distinct from 'object' then raise exception 'Give the promised numbers' using errcode = '22023'; end if;
  for f in select x from jsonb_array_elements(coalesce(p_def->'promise'->'inputs', '[]'::jsonb)) x loop
    continue when not p_values ? (f->>'key');
    v := p_values->(f->>'key');
    if jsonb_typeof(v) = 'null' or v #>> '{}' = '' then continue; end if;
    if coalesce(f->>'kind', 'number') = 'text' then
      if length(v #>> '{}') > 400 then raise exception '% is too long (400 letters at most)', f->>'label' using errcode = '22023'; end if;
      out := out || jsonb_build_object(f->>'key', btrim(v #>> '{}'));
    else
      begin n := (v #>> '{}')::numeric; exception when others then raise exception '% must be a number', f->>'label' using errcode = '22023'; end;
      if n < 0 or n > 10000000 or (f->>'kind' = 'percent' and n > 100) then raise exception '% is out of range', f->>'label' using errcode = '22023'; end if;
      out := out || jsonb_build_object(f->>'key', n);
    end if;
  end loop;
  return out;
end $$;

-- Set or propose what was promised. A salesperson's change is the promise; anyone else's waits for sales to confirm.
-- Everyone else involved is told.
create function pulse.project_promise_propose(p_project uuid, p_values jsonb, p_note text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); pl pulse.project_plan; def jsonb; vals jsonb; sales boolean; pr pulse.project; h uuid; tell uuid[]; nm text; myname text;
  note text := left(nullif(btrim(coalesce(p_note, '')), ''), 300);
begin
  if not pulse.plan_by_person() then raise exception 'Only a person changes what was promised' using errcode = '42501'; end if;
  select * into pr from pulse.project where org_id = pulse.current_org() and id = p_project and deleted_at is null;
  if pr.id is null then raise exception 'Project not found' using errcode = 'P0002'; end if;
  sales := pulse.project_is_sales(p_project);
  if not (sales or pulse.project_can_run(p_project)) then raise exception 'Only sales, the project''s lead and leadership change what was promised' using errcode = '42501'; end if;
  select * into pl from pulse.project_plan where org_id = pulse.current_org() and project_id = p_project for update;
  if pl.project_id is null then raise exception 'This project has no delivery plan' using errcode = 'P0002'; end if;
  def := pulse.plan_definition(p_project);
  if jsonb_array_length(coalesce(def->'promise'->'inputs', '[]'::jsonb)) = 0 then raise exception 'This plan has no promise fields' using errcode = '22023'; end if;
  vals := coalesce(pl.promise->'values', '{}'::jsonb) || pulse.project_promise_clean(def, p_values);
  nm := coalesce(pr.title, pr.name); myname := (select display_name from pulse.person where id = me);
  if sales then
    update pulse.project_plan set promise = jsonb_build_object('values', vals, 'confirmedBy', me, 'confirmedAt', now(), 'setBy', me, 'setAt', now(), 'note', note), updated_at = now() where project_id = p_project;
    tell := array(select distinct x from unnest(array[pr.lead_person_id] || pulse.project_heads()) x where x is not null and x <> me);
    foreach h in array tell loop
      perform pulse.project_watch(p_project, h);
      perform pulse.work_notify(h, 'project.added', 'project', p_project, left(format('promise:%s:%s:%s', p_project, h, extract(epoch from now())::bigint), 200),
        left(format('What we promised on %s was updated by %s (sales)', nm, myname), 160), '/tasks/projects/' || p_project, 'task');
    end loop;
  else
    update pulse.project_plan set promise = promise || jsonb_build_object('pending', jsonb_build_object('values', vals, 'by', me, 'at', now(), 'note', note)), updated_at = now() where project_id = p_project;
    tell := array(select distinct x from unnest(pulse.project_promise_confirmers(p_project) || array[pr.lead_person_id] || pulse.project_heads()) x where x is not null and x <> me);
    foreach h in array tell loop
      perform pulse.project_watch(p_project, h);
      perform pulse.work_notify(h, 'project.added', 'project', p_project, left(format('promise.ask:%s:%s:%s', p_project, h, extract(epoch from now())::bigint), 200),
        left(case when h = any(pulse.project_promise_confirmers(p_project)) then format('%s proposed a change to what we promised on %s. Confirm it?', myname, nm)
          else format('%s proposed a change to what we promised on %s; sales confirms it', myname, nm) end, 160), '/tasks/projects/' || p_project, 'task');
    end loop;
  end if;
  perform pulse.audit_write('project_promise_propose', 'project', p_project::text);
  return jsonb_build_object('confirmed', sales, 'values', vals);
end $$;

-- Sales confirms (or turns down) a proposed change. Nobody confirms their own proposal.
create function pulse.project_promise_answer(p_project uuid, p_accept boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); pl pulse.project_plan; pend jsonb; nm text; asker uuid;
begin
  if not pulse.plan_by_person() then raise exception 'Only a person confirms what was promised' using errcode = '42501'; end if;
  select * into pl from pulse.project_plan where org_id = pulse.current_org() and project_id = p_project for update;
  if pl.project_id is null then raise exception 'This project has no delivery plan' using errcode = 'P0002'; end if;
  pend := pl.promise->'pending';
  if pend is null then raise exception 'Nothing is waiting to be confirmed' using errcode = '22023'; end if;
  if not (pulse.project_is_sales(p_project) or me = any(pulse.project_promise_confirmers(p_project))) then
    raise exception 'Sales confirms what was promised' using errcode = '42501'; end if;
  asker := (pend->>'by')::uuid;
  if asker = me then raise exception 'Someone else confirms your own change' using errcode = '42501'; end if;
  if coalesce(p_accept, false) then
    update pulse.project_plan set promise = jsonb_build_object('values', pend->'values', 'confirmedBy', me, 'confirmedAt', now(), 'setBy', asker, 'setAt', pend->'at', 'note', pend->'note'), updated_at = now() where project_id = p_project;
  else
    update pulse.project_plan set promise = promise - 'pending', updated_at = now() where project_id = p_project;
  end if;
  nm := (select coalesce(title, name) from pulse.project where id = p_project);
  perform pulse.project_watch(p_project, asker);
  if asker is not null then perform pulse.work_notify(asker, 'project.added', 'project', p_project, left(format('promise.answer:%s:%s', p_project, extract(epoch from now())::bigint), 200),
    left(format('%s %s your change to what we promised on %s', (select display_name from pulse.person where id = me), case when p_accept then 'confirmed' else 'turned down' end, nm), 160), '/tasks/projects/' || p_project, 'task'); end if;
  perform pulse.audit_write('project_promise_answer', 'project', p_project::text);
  return jsonb_build_object('confirmed', coalesce(p_accept, false));
end $$;

-- 1300's date move, by the template: its reasons, and who moves dates (moveDates "lead": the project's lead, and
-- leadership stepping in, which is logged). Moving the go-live step tells the project heads.
create or replace function pulse.project_reschedule(p_task uuid, p_start date, p_due date, p_reason text, p_note text, p_cascade boolean)
 returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); t pulse.task; tz text := pulse.org_time_zone(); old_start date; old_due date; shift int; moved uuid[] := '{}';
  note text := nullif(btrim(coalesce(p_note, '')), ''); clock time; def jsonb; reasons jsonb; lbl text; pr pulse.project; live text; h uuid; stepped boolean := false;
begin
  select * into t from pulse.task where org_id = pulse.current_org() and id = p_task and deleted_at is null;
  if t.id is null or t.project_id is null then raise exception 'Task not found' using errcode = 'P0002'; end if;
  select * into pr from pulse.project where id = t.project_id;
  def := case when exists(select 1 from pulse.project_plan where org_id = pulse.current_org() and project_id = t.project_id) then pulse.plan_definition(t.project_id) end;
  reasons := case when jsonb_typeof(def->'reasons') = 'array' and jsonb_array_length(def->'reasons') > 0 then def->'reasons' end;
  if def->>'moveDates' = 'lead' then
    -- Only the project's lead moves its dates; leadership may step in (logged), the heads see a go-live move.
    if me is distinct from pr.lead_person_id then
      if pulse.viewer_is('admin', 'leadership') then stepped := true;
      else raise exception 'Only the project''s lead moves the dates of this plan' using errcode = '42501'; end if;
    end if;
  elsif not (pulse.project_can_run(t.project_id) or me in (t.created_by, t.review_owner_id)) then
    raise exception 'Only the project''s lead, its manager and leadership change its dates' using errcode = '42501';
  end if;
  if reasons is not null then
    select x->>'label' into lbl from jsonb_array_elements(reasons) x where x->>'key' = p_reason;
    if lbl is null then raise exception 'Choose why the dates change' using errcode = '22023'; end if;
  else
    if p_reason not in ('client_delay','our_delay','client_paused','ea_hold','scope_change','other') then raise exception 'Choose why the dates change' using errcode = '22023'; end if;
    lbl := replace(p_reason, '_', ' ');
  end if;
  if p_reason = 'other' and note is null then raise exception 'Say why the dates change' using errcode = '22023'; end if;
  if note is not null and length(note) > 300 then raise exception 'Keep the note under 300 letters' using errcode = '22023'; end if;
  if p_due is null then raise exception 'Choose the new end date' using errcode = '22023'; end if;
  if p_start is not null and p_start > p_due then raise exception 'The start must be on or before the end' using errcode = '22023'; end if;
  old_start := coalesce(t.work_on, (t.started_at at time zone tz)::date);
  old_due := (t.due_at at time zone tz)::date;
  clock := coalesce((t.due_at at time zone tz)::time, time '18:00');
  update pulse.task set due_at = (p_due + clock) at time zone tz, work_on = coalesce(p_start, work_on), updated_at = now(), edited_by = me where id = p_task;
  insert into pulse.task_event(org_id, task_id, actor_id, kind, from_value, to_value, note)
    values (pulse.current_org(), p_task, me, 'edited', format('dates %s → %s', coalesce(old_start::text, '?'), coalesce(old_due::text, 'none')),
      format('dates %s → %s', coalesce(p_start::text, coalesce(old_start::text, '?')), p_due), left(lbl || coalesce(': ' || note, '') || case when stepped then ' (leadership stepped in)' else '' end, 1000));
  shift := case when old_due is null then 0 else p_due - old_due end;
  if coalesce(p_cascade, false) and shift > 0 then
    with recursive waits(id) as (
        select l.task_id from pulse.task_link l where l.org_id = pulse.current_org() and l.blocker_id = p_task and l.cleared_at is null
        union select l.task_id from pulse.task_link l join waits w on l.blocker_id = w.id where l.org_id = pulse.current_org() and l.cleared_at is null),
      up as (update pulse.task x set due_at = x.due_at + make_interval(days => shift), work_on = x.work_on + shift, updated_at = now(), edited_by = me
        from waits w where x.id = w.id and x.deleted_at is null and x.status in ('open','in_progress','blocked') and x.due_at is not null and x.id <> p_task returning x.id)
    select coalesce(array_agg(id), '{}') into moved from up;
    insert into pulse.task_event(org_id, task_id, actor_id, kind, from_value, to_value, note)
      select pulse.current_org(), m, me, 'edited', 'due', format('+%s days', shift), left('Moved with the task it waits for: ' || lbl, 1000) from unnest(moved) m;
  end if;
  insert into pulse.project_date_change(org_id, project_id, task_id, from_start, from_due, to_start, to_due, reason_kind, note, moved, changed_by)
    values (pulse.current_org(), t.project_id, p_task, old_start, old_due, coalesce(p_start, old_start), p_due, p_reason,
      case when stepped then left(coalesce(note || ' ', '') || '(leadership stepped in)', 300) else note end, moved, me);
  -- Moving the go-live step is seen by the heads (to see, not to approve).
  live := coalesce((select x->>'step' from jsonb_array_elements(coalesce(def->'clocks', '[]'::jsonb)) x where x->>'key' = 'live' limit 1), def->'milestones'->>'adsLive');
  if live is not null and t.template_step = live and old_due is distinct from p_due then
    foreach h in array pulse.project_heads() loop
      continue when h = me;
      perform pulse.project_watch(t.project_id, h);
      perform pulse.work_notify(h, 'project.added', 'project', t.project_id, left(format('golive.move:%s:%s:%s', p_task, p_due, h), 200),
        left(format('Go-live moved on %s: %s → %s (%s)', coalesce(pr.title, pr.name), coalesce(to_char(old_due, 'DD Mon'), 'no date'), to_char(p_due, 'DD Mon'), lbl), 160), '/tasks/' || p_task, 'task');
    end loop;
  end if;
  perform pulse.audit_write('project_reschedule', 'task', p_task::text);
  return jsonb_build_object('task', p_task, 'due', p_due, 'moved', cardinality(moved), 'steppedIn', stepped);
end $$;

-- 1300's status change: a restart moves only what the pause stopped. Open tasks move when the pause stopped them (and
-- the restart asks to); the campaign months and guarantee windows move by the paused days (project_plan.live_paused).
create or replace function pulse.project_set_status(p_project uuid, p_status text, p_reason text, p_from date, p_restart date, p_stops jsonb, p_shift boolean)
 returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); pr pulse.project; cur text; last pulse.project_status_change; days int := null; n int := 0;
  r text := btrim(coalesce(p_reason, '')); lead uuid; tz text := pulse.org_time_zone(); clocks boolean;
begin
  select * into pr from pulse.project where org_id = pulse.current_org() and id = p_project and deleted_at is null;
  if pr.id is null then raise exception 'Project not found' using errcode = 'P0002'; end if;
  if not pulse.project_can_run(p_project) then raise exception 'Only the project''s lead, its manager and leadership change its status' using errcode = '42501'; end if;
  if p_status not in ('active','paused','on_hold','discontinued') then raise exception 'Choose Active, Paused, On hold or Discontinued' using errcode = '22023'; end if;
  if length(r) not between 3 and 500 then raise exception 'Give the reason in a few words' using errcode = '22023'; end if;
  select * into last from pulse.project_status_change where org_id = pulse.current_org() and project_id = p_project order by changed_at desc limit 1;
  cur := case when pr.status = 'cancelled' then 'discontinued' when pr.status = 'paused' then coalesce(case when last.to_status in ('paused','on_hold') then last.to_status end, 'paused') else 'active' end;
  if cur = p_status then raise exception 'The project is already %', replace(p_status, '_', ' ') using errcode = '22023'; end if;
  lead := coalesce(pr.lead_person_id, (select owner_id from pulse.work_project where project_id = p_project), me);
  if p_status in ('paused','on_hold') then
    update pulse.project set status = 'paused', updated_at = now() where id = p_project;
    update pulse.work_project set status = 'paused', updated_at = now(), updated_by = me where project_id = p_project and status <> 'paused';
  elsif p_status = 'active' then
    if cur in ('paused','on_hold') then
      days := greatest(0, (now() at time zone tz)::date - coalesce(last.starts_on, (last.changed_at at time zone tz)::date));
      -- An older pause recorded nothing about tasks: its open tasks stopped (as 1300 assumed).
      if days > 0 and coalesce(p_shift, false) and coalesce((last.stops->>'tasks')::boolean, true) then
        with moved as (update pulse.task t set due_at = t.due_at + make_interval(days => days), work_on = t.work_on + days, updated_at = now(), edited_by = me
          where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.status in ('open','in_progress','blocked') and t.due_at is not null returning t.id)
        insert into pulse.task_event(org_id, task_id, actor_id, kind, from_value, to_value, note)
          select pulse.current_org(), id, me, 'edited', 'due', format('+%s days', days), left('Project restarted after a pause: ' || r, 1000) from moved;
        get diagnostics n = row_count;
      end if;
      clocks := coalesce((last.stops->>'months')::boolean, false) or coalesce((last.stops->>'guarantee')::boolean, false);
      if days > 0 and clocks then
        update pulse.project_plan set live_paused = least(3650, live_paused + days), updated_at = now() where org_id = pulse.current_org() and project_id = p_project and live_on is not null;
      end if;
    end if;
    update pulse.project set status = 'active', updated_at = now() where id = p_project;
    update pulse.work_project set status = 'active', updated_at = now(), updated_by = me where project_id = p_project;
  else
    with gone as (update pulse.task t set status = 'cancelled', updated_at = now(), edited_by = me
      where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.status in ('open','in_progress','blocked','in_review') returning t.id)
    insert into pulse.task_event(org_id, task_id, actor_id, kind, from_value, to_value, note)
      select pulse.current_org(), id, me, 'status', 'open', 'cancelled', left('Project discontinued: ' || r, 1000) from gone;
    get diagnostics n = row_count;
    update pulse.project set status = 'cancelled', updated_at = now(), ends_on = coalesce(p_from, ends_on) where id = p_project;
    update pulse.work_project set status = 'cancelled', updated_at = now(), updated_by = me where project_id = p_project;
    with made as (insert into pulse.task(org_id, project_id, title, assignee_person_id, created_by, created_at, assigned_at, due_at, priority, notes)
      select pulse.current_org(), p_project, x.title, lead, me, now(), now(), ((now() at time zone tz)::date + 3 + time '18:00') at time zone tz, 'high', x.notes
      from (values (format('Final numbers report: %s', coalesce(pr.title, pr.name)), format('The project was discontinued: %s. Share the final numbers with the client and leadership.', r)),
                   (format('Assets and access handover: %s', coalesce(pr.title, pr.name)), 'Hand the client''s files, ad accounts and logins back, and remove access that is no longer needed. Ask Accounts to check any refund or settlement.')) x(title, notes)
      returning id, title)
    insert into pulse.task_event(org_id, task_id, actor_id, kind, to_value) select pulse.current_org(), id, me, 'created', title from made;
  end if;
  insert into pulse.project_status_change(org_id, project_id, from_status, to_status, reason, starts_on, restart_on, stops, shifted_days, changed_by)
    values (pulse.current_org(), p_project, cur, p_status, r, coalesce(p_from, (now() at time zone tz)::date), p_restart, coalesce(p_stops, '{}'::jsonb), days, me);
  perform pulse.audit_write('project_set_status', 'project', p_project::text);
  return jsonb_build_object('status', p_status, 'from', cur, 'tasks', n, 'shiftedDays', days);
end $$;

-- 1471's start, by the company's setting (the sales flow's handover step, startAt): first_payment (the default: the
-- first payment on the invoice) or paid_in_full.
create or replace function pulse.project_from_invoice() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare at text := coalesce(nullif(pulse.erp_flow_step('handover')->>'startAt', ''), 'first_payment');
begin
  if new.doc_type <> 'invoice' or new.status is not distinct from old.status then return null; end if;
  if at = 'paid_in_full' then
    if new.status <> 'paid' or old.status not in ('issued', 'sent', 'part_paid') then return null; end if;
  elsif new.status not in ('part_paid', 'paid') or old.status not in ('issued', 'sent') then return null;
  end if;
  begin
    perform pulse.erp_project_on_payment(new.id, true);
  exception when others then
    perform pulse.erp_log('document', new.id, 'project_failed', jsonb_build_object('error', left(sqlerrm, 300)));
  end;
  return null;
end $$;

-- A project's chat groups: the person running it links (or unlinks) a group it may see. The group takes the project's
-- client too, and the link is kept as set by hand (the name reader never undoes it).
create function pulse.project_chat_link(p_project uuid, p_channel uuid, p_on boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare pr pulse.project; other uuid;
begin
  if not pulse.plan_by_person() then raise exception 'Only a person links chats to a project' using errcode = '42501'; end if;
  select * into pr from pulse.project where org_id = pulse.current_org() and id = p_project and deleted_at is null;
  if pr.id is null then raise exception 'Project not found' using errcode = 'P0002'; end if;
  if not pulse.project_can_run(p_project) then raise exception 'Only the project''s lead, its manager and leadership link its chats' using errcode = '42501'; end if;
  if not pulse.chat_group_sees(p_channel) then raise exception 'Choose a group chat you are in' using errcode = '42501'; end if;
  insert into pulse.chat_group_info(org_id, channel_id) values (pulse.current_org(), p_channel) on conflict (channel_id) do nothing;
  if coalesce(p_on, true) then
    select project_id into other from pulse.chat_group_info where channel_id = p_channel;
    update pulse.chat_group_info g set project_id = p_project, client_id = coalesce(pr.client_id, g.client_id), kind = coalesce(g.kind, case when pr.client_id is not null then 'client' end),
        manual = (select coalesce(array_agg(distinct f), '{}') from unnest(g.manual || array['project'] || case when pr.client_id is not null then array['client'] else '{}'::text[] end) f),
        updated_by = pulse.current_viewer(), updated_at = now()
      where g.channel_id = p_channel;
  else
    update pulse.chat_group_info g set project_id = null, manual = (select coalesce(array_agg(distinct f), '{}') from unnest(g.manual || array['project']) f), updated_by = pulse.current_viewer(), updated_at = now()
      where g.channel_id = p_channel and g.project_id = p_project;
  end if;
  perform pulse.audit_write('project_chat_link', 'project', p_project::text);
  return jsonb_build_object('channel', p_channel, 'linked', coalesce(p_on, true), 'movedFrom', case when other is distinct from p_project then other end);
end $$;

revoke all on function pulse.plan_coded(jsonb, jsonb), pulse.plan_lines_used(jsonb, jsonb), pulse.plan_codes_match(jsonb, text), pulse.project_bought_lines(uuid), pulse.plan_step_bought(jsonb, jsonb), pulse.plan_step_why_not(jsonb, jsonb, text, jsonb, jsonb, jsonb),
  pulse.project_plan_fill(uuid), pulse.project_plan_add_lines(uuid), pulse.project_plan_on_scope(), pulse.project_plan_roles_set(uuid, jsonb), pulse.project_plan_condition_set(uuid, text, boolean),
  pulse.project_plans_roll(), pulse.project_watch(uuid, uuid), pulse.project_is_sales(uuid), pulse.project_promise_confirmers(uuid), pulse.project_promise_clean(jsonb, jsonb), pulse.project_promise_propose(uuid, jsonb, text),
  pulse.project_promise_answer(uuid, boolean), pulse.project_chat_link(uuid, uuid, boolean) from public;
grant execute on function pulse.plan_coded(jsonb, jsonb), pulse.plan_lines_used(jsonb, jsonb), pulse.plan_codes_match(jsonb, text), pulse.project_bought_lines(uuid), pulse.plan_step_bought(jsonb, jsonb), pulse.plan_step_why_not(jsonb, jsonb, text, jsonb, jsonb, jsonb),
  pulse.project_plan_roles_set(uuid, jsonb), pulse.project_plan_condition_set(uuid, text, boolean), pulse.project_plans_roll(), pulse.project_is_sales(uuid), pulse.project_promise_confirmers(uuid),
  pulse.project_promise_propose(uuid, jsonb, text), pulse.project_promise_answer(uuid, boolean), pulse.project_chat_link(uuid, uuid, boolean) to pulse_api;

-- Estate Autopilots' template, version 4: version 3 (Kazuk's Delivery Timeline v2) with what phase 2 reads. Written as
-- that company, only where it exists and only over version 3. The catalogue codes are its own (EA-P1-…, EA-ADD-…).
do $$
declare ea uuid := '6f1a455d-ced2-504d-b8d5-5ae0efbe7c75'; def jsonb; patch jsonb;
begin
  if not exists(select 1 from pulse.org where id = ea) then return; end if;
  perform set_config('pulse.org_id', ea::text, true);
  select definition into def from pulse.delivery_template where org_id = ea and key = 'agency-creative';
  if def is null or coalesce(def->>'version', '') <> '3' or coalesce(def->>'format', '') <> '3' then perform set_config('pulse.org_id', '', true); return; end if;
  patch := '{
    "P1": {"lines": ["EA-P1-DMR"], "deliver": true}, "P2": {"lines": ["EA-P1-PERSONA"], "deliver": true}, "P3": {"lines": ["EA-P1-POSITIONING"], "deliver": true},
    "P6": {"lines": ["EA-P1-SMO"], "deliver": true}, "P7": {"lines": ["EA-P1-SALIGN"], "deliver": true},
    "C1": {"lines": ["EA-P2-IMAGES"]}, "C11": {"lines": ["EA-P2-IMAGES"]}, "C12": {"lines": ["EA-P2-IMAGES"], "deliver": true}, "C13": {"lines": ["EA-P2-IMAGES"]},
    "C2": {"lines": ["EA-P2-MV-%"]}, "C20": {"lines": ["EA-P2-MV-%"]}, "C21": {"lines": ["EA-P2-MV-%"]}, "C22": {"lines": ["EA-P2-MV-%"], "deliver": true},
    "C3": {"lines": ["EA-P2-VOV"]}, "C16": {"lines": ["EA-P2-VOV"]}, "C17": {"lines": ["EA-P2-VOV"]}, "C18": {"lines": ["EA-P2-VOV"]}, "C19": {"lines": ["EA-P2-VOV"], "deliver": true},
    "C4": {"lines": ["EA-P2-SAMPLEFLAT"]}, "C14": {"lines": ["EA-P2-SAMPLEFLAT"]}, "C15": {"lines": ["EA-P2-SAMPLEFLAT"], "deliver": true}, "J11": {"lines": ["EA-P2-SAMPLEFLAT"]},
    "C8": {"lines": ["EA-P2-SHOOT"]}, "C9": {"lines": ["EA-P2-SHOOT"], "deliver": true}, "C10": {"lines": ["EA-P2-SHOOT"]},
    "C24": {"lines": ["EA-P2-REMIX"], "deliver": true},
    "W1": {"lines": ["EA-P2-WALKTHROUGH"]}, "W2": {"lines": ["EA-P2-WALKTHROUGH"]}, "W3": {"lines": ["EA-P2-WALKTHROUGH"]}, "W4": {"lines": ["EA-P2-WALKTHROUGH"]}, "W5": {"lines": ["EA-P2-WALKTHROUGH"]},
    "W6": {"lines": ["EA-P2-WALKTHROUGH"]}, "W7": {"lines": ["EA-P2-WALKTHROUGH"]}, "W8": {"lines": ["EA-P2-WALKTHROUGH"]}, "W9": {"lines": ["EA-P2-WALKTHROUGH"]}, "W10": {"lines": ["EA-P2-WALKTHROUGH"], "deliver": true},
    "L1": {"lines": ["EA-P2-LP-%"]}, "L2": {"lines": ["EA-P2-LP-%"], "deliver": true}, "L3": {"lines": ["EA-P2-LP-%"]}, "L4": {"lines": ["EA-P2-LP-%"]},
    "LG1": {"lines": ["EA-P2-LEGACY"]}, "LG2": {"lines": ["EA-P2-LEGACY"]}, "LG3": {"lines": ["EA-P2-LEGACY"]}, "LG4": {"lines": ["EA-P2-LEGACY"]}, "LG5": {"lines": ["EA-P2-LEGACY"], "deliver": true},
    "F1": {"lines": ["EA-P2-FOUNDER"]}, "F2": {"lines": ["EA-P2-FOUNDER"]}, "F3": {"lines": ["EA-P2-FOUNDER"]}, "F4": {"lines": ["EA-P2-FOUNDER"]}, "F5": {"lines": ["EA-P2-FOUNDER"]},
    "F6": {"lines": ["EA-P2-FOUNDER"]}, "F7": {"lines": ["EA-P2-FOUNDER"]}, "F8": {"lines": ["EA-P2-FOUNDER"]}, "F9": {"lines": ["EA-P2-FOUNDER"], "deliver": true},
    "V1": {"lines": ["EA-P2-TESTIMONIALS"]}, "V2": {"lines": ["EA-P2-TESTIMONIALS"]}, "V3": {"lines": ["EA-P2-TESTIMONIALS"]}, "V4": {"lines": ["EA-P2-TESTIMONIALS"]}, "V5": {"lines": ["EA-P2-TESTIMONIALS"]},
    "V6": {"lines": ["EA-P2-TESTIMONIALS"]}, "V7": {"lines": ["EA-P2-TESTIMONIALS"], "deliver": true},
    "J1": {"lines": ["EA-P3-META-%"], "deliver": true}, "J2": {"lines": ["EA-P3-META-%"]},
    "J7": {"lines": ["EA-P3-GOOGLE-%"], "deliver": true}, "J8": {"lines": ["EA-P3-GOOGLE-%"]}, "J9": {"lines": ["EA-P3-YT-%"], "deliver": true}, "J10": {"lines": ["EA-P3-YT-%"]},
    "N1": {"lines": ["EA-P4-NEETI-%"], "deliver": true}, "N2": {"lines": ["EA-P4-NEETI-%"]}, "N3": {"lines": ["EA-P4-NEETI-%"]},
    "K1": {"lines": ["EA-ADD-CP-%"]}, "K2": {"lines": ["EA-ADD-CP-%"]}, "K3": {"lines": ["EA-ADD-CP-%"]}, "K4": {"lines": ["EA-ADD-CP-%"], "deliver": true}, "K5": {"lines": ["EA-ADD-CP-%"]},
    "X5": {"lines": ["EA-ADD-REFRESH"], "deliver": true, "role": "Video Editor"}, "X6": {"role": "Shoot Coordinator"},
    "R1": {"lines": ["EA-ADD-BRANDFILM"]}, "R2": {"lines": ["EA-ADD-BRANDFILM"]}, "R3": {"lines": ["EA-ADD-BRANDFILM"]}, "R4": {"lines": ["EA-ADD-BRANDFILM"]}, "R5": {"lines": ["EA-ADD-BRANDFILM"]},
    "R6": {"lines": ["EA-ADD-BRANDFILM"]}, "R7": {"lines": ["EA-ADD-BRANDFILM"]}, "R8": {"lines": ["EA-ADD-BRANDFILM"]}, "R9": {"lines": ["EA-ADD-BRANDFILM"]}, "R10": {"lines": ["EA-ADD-BRANDFILM"], "deliver": true},
    "J15": {"repeat": {"every": 30, "byPackage": {"starter": {"every": 0}}}},
    "J16": {"repeat": {"every": 7, "byPackage": {"starter": {"every": 30}}}},
    "J17": {"repeat": {"every": 30}}
  }'::jsonb;
  def := jsonb_set(def, '{steps}', (select jsonb_agg(case when patch ? (x->>'id') then x || (patch->(x->>'id')) else x end order by o) from jsonb_array_elements(def->'steps') with ordinality s(x, o)));
  def := jsonb_set(def, '{packages}', '[{"key": "sell_out", "label": "Sell-Out", "lines": ["EA-SO-%", "EA-PKG-SELLOUT"]}, {"key": "growth", "label": "Growth", "lines": ["EA-GR-%", "EA-PKG-GROWTH"]},
    {"key": "starter", "label": "Starter", "lines": ["EA-ST-%", "EA-PKG-STARTER"]}]'::jsonb);
  def := def || '{
    "conditions": [{"key": "realBuyers", "label": "Real buyers exist", "question": "Does the project have real buyers yet?", "hint": "testimonials need buyers who can speak on camera"}],
    "moveDates": "lead",
    "reasons": [{"key": "client_delay", "label": "Client delay", "side": "client"}, {"key": "client_paused", "label": "Client pause", "side": "client"},
      {"key": "client_discontinued", "label": "Client discontinued", "side": "client"}, {"key": "ea_hold", "label": "Our hold", "side": "us"},
      {"key": "capacity", "label": "Resource or capacity", "side": "us"}, {"key": "approval_pending", "label": "Approval pending", "side": "client"},
      {"key": "shoot_rescheduled", "label": "Shoot rescheduled", "side": "us"}],
    "roles": [{"label": "PGS", "lead": true}, {"label": "Creative Strategist"}, {"label": "Video Editor"}, {"label": "Graphic Designer"}, {"label": "Shoot Coordinator"},
      {"label": "Access Coordinator"}, {"label": "Trainer"}, {"label": "SME"}, {"label": "Head PGS"}, {"label": "Brand identity agency", "outside": true},
      {"label": "Client", "client": true}, {"label": "Vitals OS", "system": true}],
    "promise": {
      "title": "What we promised",
      "inputs": [
        {"key": "goal", "label": "The client''s goal, in their words", "kind": "text"},
        {"key": "selloutMonths", "label": "Sell-out timeline", "kind": "number", "unit": "months"},
        {"key": "bookingsMonth", "label": "Bookings a month", "kind": "number"},
        {"key": "qualityRatio", "label": "Quality ratio", "kind": "percent", "unit": "%", "hint": "Of the leads, the share that are genuine buyers who visit"},
        {"key": "leadsDay", "label": "Leads a day", "kind": "number"}],
      "constants": {"visitsPerBooking": 10},
      "outputs": [
        {"key": "visitsMonth", "label": "Site visits a month", "formula": "bookingsMonth * visitsPerBooking"},
        {"key": "visitsWeek", "label": "Site visits a week", "formula": "visitsMonth * 7 / 30"},
        {"key": "leadsMonth", "label": "Leads a month", "formula": "visitsMonth / (qualityRatio / 100)"},
        {"key": "leadsWeek", "label": "Leads a week", "formula": "leadsMonth * 7 / 30"},
        {"key": "leadsDayNeeded", "label": "Leads a day needed", "formula": "leadsMonth / 30", "compare": "leadsDay"}],
      "note": "Kazuk to confirm (question K6): the formulas, and 10 site visits for each booking"
    }
  }'::jsonb;
  perform pulse.delivery_template_file('agency-creative', null, def,
    'Phase 2: catalogue codes, roles, conditions, repeats, date-move reasons, what we promised (PM-BUILD-2, 18 Nov 2026)');
  perform set_config('pulse.org_id', '', true);
end $$;

-- migrate:down
drop trigger project_plan_on_scope on pulse.erp_event;
drop function pulse.project_plan_on_scope();
drop function pulse.project_chat_link(uuid, uuid, boolean);
drop function pulse.project_promise_answer(uuid, boolean);
drop function pulse.project_promise_propose(uuid, jsonb, text);
drop function pulse.project_promise_clean(jsonb, jsonb);
drop function pulse.project_promise_confirmers(uuid);
drop function pulse.project_is_sales(uuid);
drop function pulse.project_watch(uuid, uuid);
drop function pulse.project_plans_roll();
drop function pulse.project_plan_condition_set(uuid, text, boolean);
drop function pulse.project_plan_roles_set(uuid, jsonb);
drop function pulse.project_plan_add_lines(uuid);
drop function pulse.project_plan_fill(uuid);
drop function pulse.plan_step_why_not(jsonb, jsonb, text, jsonb, jsonb, jsonb);
drop function pulse.plan_lines_used(jsonb, jsonb);
drop function pulse.plan_coded(jsonb, jsonb);
drop function pulse.plan_step_bought(jsonb, jsonb);
drop function pulse.project_bought_lines(uuid);
drop function pulse.plan_codes_match(jsonb, text);
alter table pulse.project_date_change drop constraint project_date_change_reason_kind_check,
  add constraint project_date_change_reason_kind_check check (reason_kind = any (array['client_delay','our_delay','client_paused','ea_hold','scope_change','other']));
alter table pulse.project_plan drop column live_paused, drop column promise, drop column conditions, drop column roles, drop column lines;
