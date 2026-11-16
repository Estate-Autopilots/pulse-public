-- migrate:up
-- KAZUK (28 Oct 2026), Kazuk's screen 3 and the meeting's client timeline link:
--  * After the doer takes a task given in a chat, Pulse asks there "When will you start and finish?" (Start today, Pick
--    dates, Can't by then). The answer is kept (pulse.task_commit): the start becomes the task's work day, a finish later
--    than the due day and a "can't" tell whoever gave it.
--  * A task finished after its due day asks its doer for one reason (footage late, client delay, revisions, other), kept
--    in pulse.task_late_reason and logged on the task.
--  * A project's client timeline: a signed, revocable link (only its hash is stored) to a read-only page with the
--    project's stages and planned steps, their dates and done / in progress / planned. No people, notes, money or
--    internal chats. Pulse never sends it: the lead copies it into the client group's description.
create table pulse.task_commit(
  org_id uuid not null references pulse.org(id),
  task_id uuid primary key references pulse.task(id),
  person_id uuid not null references pulse.person(id),
  state text not null check (state in ('committed','cant')),
  start_on date, finish_on date,
  note text check (length(note) <= 300),
  at timestamptz not null default now());
alter table pulse.task_commit enable row level security;
alter table pulse.task_commit force row level security;
create policy tenant on pulse.task_commit using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.task_commit to pulse_api;

create table pulse.task_late_reason(
  org_id uuid not null references pulse.org(id),
  task_id uuid primary key references pulse.task(id),
  reason text not null check (reason in ('footage_late','client_delay','revisions','other')),
  note text check (length(note) <= 300),
  person_id uuid not null references pulse.person(id),
  at timestamptz not null default now());
alter table pulse.task_late_reason enable row level security;
alter table pulse.task_late_reason force row level security;
create policy tenant on pulse.task_late_reason using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.task_late_reason to pulse_api;

create table pulse.project_share(
  org_id uuid not null references pulse.org(id),
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  project_id uuid not null references pulse.project(id),
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz);
create index project_share_project on pulse.project_share(org_id, project_id) where revoked_at is null;
alter table pulse.project_share enable row level security;
alter table pulse.project_share force row level security;
create policy tenant on pulse.project_share using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

create function pulse.task_commit_set(p_task uuid, p_start date, p_finish date, p_cant boolean, p_note text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); t pulse.task; tz text := pulse.org_time_zone(); due date; msg text; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into t from pulse.task where org_id = pulse.current_org() and id = p_task and deleted_at is null;
  if t.id is null then raise exception 'Task not found' using errcode = 'P0002'; end if;
  if me is null or me is distinct from coalesce(t.assignee_person_id, t.owner_id) then raise exception 'Only the person doing the task answers this' using errcode = '42501'; end if;
  if n is not null and length(n) > 300 then raise exception 'Keep the note under 300 letters' using errcode = '22023'; end if;
  due := (t.due_at at time zone tz)::date;
  if coalesce(p_cant, false) then
    if n is null then raise exception 'Say what you can do instead' using errcode = '22023'; end if;
    insert into pulse.task_commit(org_id, task_id, person_id, state, start_on, finish_on, note) values (pulse.current_org(), p_task, me, 'cant', p_start, p_finish, n)
      on conflict (task_id) do update set state = 'cant', start_on = excluded.start_on, finish_on = excluded.finish_on, note = excluded.note, person_id = excluded.person_id, at = now();
    msg := format('%s can''t finish “%s” by then: %s', pulse.work_first_name(me), left(t.title, 80), n);
  else
    if p_start is null then raise exception 'Choose the start day' using errcode = '22023'; end if;
    if p_finish is not null and p_finish < p_start then raise exception 'The finish must be on or after the start' using errcode = '22023'; end if;
    insert into pulse.task_commit(org_id, task_id, person_id, state, start_on, finish_on, note) values (pulse.current_org(), p_task, me, 'committed', p_start, coalesce(p_finish, due), n)
      on conflict (task_id) do update set state = 'committed', start_on = excluded.start_on, finish_on = excluded.finish_on, note = excluded.note, person_id = excluded.person_id, at = now();
    update pulse.task set work_on = p_start, updated_at = now(), edited_by = me where id = p_task;
    msg := case when p_finish is not null and due is not null and p_finish > due then format('%s will finish “%s” on %s, after its due day', pulse.work_first_name(me), left(t.title, 80), to_char(p_finish, 'DD Mon')) end;
  end if;
  insert into pulse.task_event(org_id, task_id, actor_id, kind, to_value, note)
    values (pulse.current_org(), p_task, me, 'step', case when coalesce(p_cant, false) then 'can''t by then' else format('start %s, finish %s', p_start, coalesce(p_finish, due)) end, n);
  if msg is not null then perform pulse.work_notify(t.created_by, 'task.update', 'task', p_task, 'commit:' || p_task || ':' || now()::text, msg, '/tasks/' || p_task, 'task'); end if;
  return jsonb_build_object('task', p_task, 'state', case when coalesce(p_cant, false) then 'cant' else 'committed' end);
end $$;

create function pulse.task_late_reason_set(p_task uuid, p_reason text, p_note text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); t pulse.task; tz text := pulse.org_time_zone(); n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into t from pulse.task where org_id = pulse.current_org() and id = p_task and deleted_at is null;
  if t.id is null then raise exception 'Task not found' using errcode = 'P0002'; end if;
  if me is null or me is distinct from coalesce(t.assignee_person_id, t.owner_id) then raise exception 'Only the person doing the task answers this' using errcode = '42501'; end if;
  if p_reason not in ('footage_late','client_delay','revisions','other') then raise exception 'Choose a reason' using errcode = '22023'; end if;
  if p_reason = 'other' and n is null then raise exception 'Say why' using errcode = '22023'; end if;
  if not (t.status in ('done','accepted','in_review') and t.done_at is not null and t.due_at is not null and (t.done_at at time zone tz)::date > (t.due_at at time zone tz)::date) then
    raise exception 'This task was not finished late' using errcode = '22023'; end if;
  insert into pulse.task_late_reason(org_id, task_id, reason, note, person_id) values (pulse.current_org(), p_task, p_reason, left(n, 300), me)
    on conflict (task_id) do update set reason = excluded.reason, note = excluded.note, person_id = excluded.person_id, at = now();
  insert into pulse.task_event(org_id, task_id, actor_id, kind, to_value, note) values (pulse.current_org(), p_task, me, 'edited', 'finished late', left(replace(p_reason, '_', ' ') || coalesce(': ' || n, ''), 1000));
  return jsonb_build_object('task', p_task, 'reason', p_reason);
end $$;

-- A new client timeline link replaces the project's earlier one; revoke ends it.
create function pulse.project_share_set(p_project uuid, p_hash text) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not pulse.project_can_run(p_project) then raise exception 'Only the project''s lead, its manager and leadership share its timeline' using errcode = '42501'; end if;
  update pulse.project_share set revoked_at = now() where org_id = pulse.current_org() and project_id = p_project and revoked_at is null;
  if p_hash is not null then
    insert into pulse.project_share(org_id, token_hash, project_id, created_by) values (pulse.current_org(), p_hash, p_project, pulse.current_viewer());
  end if;
  perform pulse.audit_write(case when p_hash is null then 'project_share_revoke' else 'project_share_create' end, 'project', p_project::text);
  return p_hash is not null;
end $$;

create function pulse.project_share_state(p_project uuid) returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('active', exists(select 1 from pulse.project_share s where s.org_id = pulse.current_org() and s.project_id = p_project and s.revoked_at is null),
    'createdAt', (select max(created_at) from pulse.project_share s where s.org_id = pulse.current_org() and s.project_id = p_project and s.revoked_at is null))
  where pulse.project_can_run(p_project)
$$;

-- What the client sees, signed out: the project's name, kick-off, stages and its planned steps (template titles) with
-- dates and done / in progress / planned. Nothing else.
create function pulse.project_share_open(p_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s pulse.project_share; p pulse.project; pl pulse.project_plan; def jsonb; tz text := pulse.org_time_zone();
begin
  select * into s from pulse.project_share where token_hash = p_hash and org_id = pulse.current_org();
  if s.token_hash is null or s.revoked_at is not null then return null; end if;
  select * into p from pulse.project where id = s.project_id and deleted_at is null;
  if p.id is null or p.status = 'cancelled' then return null; end if;
  select * into pl from pulse.project_plan where project_id = p.id;
  select definition into def from pulse.delivery_template where org_id = p.org_id and key = pl.template_key;
  return jsonb_build_object(
    'project', coalesce(p.title, p.name), 'company', (select name from pulse.org where id = p.org_id), 'kickoff', pl.kickoff, 'today', (now() at time zone tz)::date,
    'paused', p.status = 'paused',
    'stages', coalesce(def->'stages', '[]'::jsonb),
    'steps', coalesce((select jsonb_agg(jsonb_build_object('step', t.template_step, 'stage', t.phase_key,
        'title', coalesce((select x->>'title' from jsonb_array_elements(def->'steps') x where x->>'id' = t.template_step), t.template_step),
        'start', t.work_on, 'due', (t.due_at at time zone tz)::date, 'done', (coalesce(t.done_at, t.accepted_at) at time zone tz)::date,
        'state', case when t.status in ('done','accepted') then 'done' when t.status in ('in_progress','in_review') then 'doing' else 'planned' end)
        order by t.phase_key, t.due_at nulls last)
      from pulse.task t where t.project_id = p.id and t.deleted_at is null and t.status <> 'cancelled' and t.template_step is not null
        and coalesce((select x->>'kind' from jsonb_array_elements(def->'steps') x where x->>'id' = t.template_step), 'task') <> 'gate'), '[]'::jsonb));
end $$;

revoke all on function pulse.task_commit_set(uuid, date, date, boolean, text), pulse.task_late_reason_set(uuid, text, text), pulse.project_share_set(uuid, text),
  pulse.project_share_state(uuid), pulse.project_share_open(text) from public;
grant execute on function pulse.task_commit_set(uuid, date, date, boolean, text), pulse.task_late_reason_set(uuid, text, text), pulse.project_share_set(uuid, text),
  pulse.project_share_state(uuid), pulse.project_share_open(text) to pulse_api;

-- migrate:down
drop function pulse.project_share_open(text);
drop function pulse.project_share_state(uuid);
drop function pulse.project_share_set(uuid, text);
drop function pulse.task_late_reason_set(uuid, text, text);
drop function pulse.task_commit_set(uuid, date, date, boolean, text);
drop table pulse.project_share;
drop table pulse.task_late_reason;
drop table pulse.task_commit;
