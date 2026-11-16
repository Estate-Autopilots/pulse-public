-- migrate:up
-- AC-PLAN-TOOLS (owner, 13 Nov 2026; the AC handoff of 13 Nov, gaps 4, 5, 6, 8 and 12, and the owner's T7.2): what an
-- agent needs to put a whole plan into Pulse in one call and read it back, and to learn from each workflow it runs.
--   external_key   one stable outside key per goal, project, task, doc, folder or decision, unique per company and kind,
--                  so an agent upserts by key instead of keeping markers in task notes (re-running a plan changes, never
--                  duplicates). Only someone who may change the record gives it a key; a key is seen only with its record.
--   plan_item      decisions (D1 …) and open questions (O1 …) as first-class items: who said it, when, the quote, its
--                  status, the source doc (e.g. a meeting's notes) and the goal or project it belongs to. Seen by whoever
--                  sees its source doc, goal and project; written by the source doc's editors or the work's editors.
--   plan_item_link the tasks (projects, goals) a decision drives.
--   workflow_log_run   one row per big workflow an agent (or a person) ran: start, end, duration, steps, failures, why, and
--                  the lesson; the daily review reads them and proposes playbook changes.
--   task_notify    honours the transaction's pulse.notify_mode for "task.assigned": digest or none skips each single
--                  notice (the plan import then sends one digest per person); everything else is unchanged.

-- ------------------------------------------------------------------------------------------------ decisions, questions
create table pulse.plan_item (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('decision', 'question')),
  ref text check (ref ~ '^[A-Za-z][A-Za-z0-9.-]{0,19}$'),
  text text not null check (length(btrim(text)) between 1 and 2000),
  said_by text check (length(said_by) <= 200),
  said_on date,
  quote text check (length(quote) <= 2000),
  owner_person_id uuid references pulse.person(id),
  status text not null check (status in ('made', 'changed', 'dropped', 'open', 'settled')),
  answer text check (length(answer) <= 2000),
  doc_id uuid references pulse.doc(id),
  goal_id uuid references pulse.goal(id),
  project_id uuid references pulse.project(id),
  created_by uuid not null references pulse.person(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plan_item_status check ((kind = 'decision' and status in ('made', 'changed', 'dropped'))
    or (kind = 'question' and status in ('open', 'settled', 'dropped')))
);
create index plan_item_doc on pulse.plan_item(org_id, doc_id) where doc_id is not null;
create index plan_item_goal on pulse.plan_item(org_id, goal_id) where goal_id is not null;
create index plan_item_project on pulse.plan_item(org_id, project_id) where project_id is not null;

create table pulse.plan_item_link (
  org_id uuid not null references pulse.org(id),
  item_id uuid not null references pulse.plan_item(id),
  kind text not null check (kind in ('task', 'project', 'goal')),
  ref_id uuid not null,
  added_by uuid not null references pulse.person(id),
  added_at timestamptz not null default now(),
  primary key (item_id, kind, ref_id)
);
create index plan_item_link_ref on pulse.plan_item_link(org_id, kind, ref_id);

-- A decision is seen by whoever sees the doc it came from and the work it belongs to (invoker: their read rules).
create function pulse.plan_item_visible(p_doc uuid, p_goal uuid, p_project uuid) returns boolean
 language sql stable security invoker set search_path=pulse,pg_temp as $$
 select exists(select 1 from person p where p.id = current_viewer() and p.side in ('staff', 'agent'))
   and (p_doc is null or exists(select 1 from doc d where d.id = p_doc))
   and (p_goal is null or exists(select 1 from goal g where g.id = p_goal))
   and (p_project is null or exists(select 1 from project x where x.id = p_project))
$$;

alter table pulse.plan_item enable row level security;
alter table pulse.plan_item force row level security;
create policy tenant_isolation on pulse.plan_item using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy plan_item_see on pulse.plan_item as restrictive for select to pulse_api using (pulse.plan_item_visible(doc_id, goal_id, project_id));
grant select on pulse.plan_item to pulse_api;
alter table pulse.plan_item_link enable row level security;
alter table pulse.plan_item_link force row level security;
create policy tenant_isolation on pulse.plan_item_link using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy plan_item_link_see on pulse.plan_item_link as restrictive for select to pulse_api
  using (exists(select 1 from pulse.plan_item i where i.id = item_id) and pulse.work_item_visible(kind, ref_id));
grant select on pulse.plan_item_link to pulse_api;

-- Make (p_id null) or change a decision or question. Only the keys present in p change. The writer must see it all
-- and may change its source doc, or (with no doc) its goal or project; admins and leadership may always.
create function pulse.plan_item_save(p_id uuid, p jsonb) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); r plan_item; v_kind text; v_doc uuid; v_goal uuid; v_project uuid; v_owner uuid; v_status text; nid uuid;
begin
 if me is null or viewer_outside_seat() or not exists(select 1 from person where org_id = current_org() and id = me and side in ('staff', 'agent') and status = 'active')
 then raise exception 'Decisions are for the company''s staff and AI employees' using errcode = '42501'; end if;
 if jsonb_typeof(p) <> 'object' then raise exception 'Describe the decision or question' using errcode = '22023'; end if;
 if p_id is not null then
  select * into r from plan_item where org_id = current_org() and id = p_id for update;
  if not found then raise exception 'That decision is gone' using errcode = 'P0002'; end if;
 end if;
 v_kind := coalesce(r.kind, p->>'kind');
 if v_kind not in ('decision', 'question') then raise exception 'Say decision or question' using errcode = '22023'; end if;
 v_doc := case when p ? 'docId' then nullif(p->>'docId', '')::uuid else r.doc_id end;
 v_goal := case when p ? 'goalId' then nullif(p->>'goalId', '')::uuid else r.goal_id end;
 v_project := case when p ? 'projectId' then nullif(p->>'projectId', '')::uuid else r.project_id end;
 v_owner := case when p ? 'ownerId' then nullif(p->>'ownerId', '')::uuid else r.owner_person_id end;
 v_status := coalesce(nullif(p->>'status', ''), r.status, case v_kind when 'decision' then 'made' else 'open' end);
 if v_owner is not null and not exists(select 1 from person where org_id = current_org() and id = v_owner and side in ('staff', 'agent'))
 then raise exception 'Choose a team member as its owner' using errcode = '22023'; end if;
 if not (viewer_is('admin', 'leadership')
   or (v_doc is not null and exists(select 1 from doc d where d.org_id = current_org() and d.id = v_doc and doc_can_edit(d.id, d.access, d.created_by, d.company_edits)))
   or (v_doc is null and v_goal is not null and goal_id_can_edit(v_goal))
   or (v_doc is null and v_goal is null and v_project is not null and work_item_can_edit('project', v_project))
   or (v_doc is null and v_goal is null and v_project is null and p_id is not null and r.created_by = me))
 then raise exception 'Only someone who may change its doc, goal or project records this' using errcode = '42501'; end if;
 if v_doc is not null and not exists(select 1 from doc where org_id = current_org() and id = v_doc) then raise exception 'Choose a doc' using errcode = '22023'; end if;
 if v_goal is not null and not exists(select 1 from goal where org_id = current_org() and id = v_goal) then raise exception 'Choose a goal' using errcode = '22023'; end if;
 if v_project is not null and not exists(select 1 from project where org_id = current_org() and id = v_project) then raise exception 'Choose a project' using errcode = '22023'; end if;
 if p_id is null then
  insert into plan_item(org_id, kind, ref, text, said_by, said_on, quote, owner_person_id, status, answer, doc_id, goal_id, project_id, created_by)
  values (current_org(), v_kind, nullif(btrim(p->>'ref'), ''), btrim(p->>'text'), nullif(btrim(p->>'saidBy'), ''), nullif(p->>'saidOn', '')::date,
    nullif(btrim(p->>'quote'), ''), v_owner, v_status, nullif(btrim(p->>'answer'), ''), v_doc, v_goal, v_project, me)
  returning id into nid;
  return nid;
 end if;
 update plan_item set
   ref = case when p ? 'ref' then nullif(btrim(p->>'ref'), '') else ref end,
   text = case when p ? 'text' then btrim(p->>'text') else text end,
   said_by = case when p ? 'saidBy' then nullif(btrim(p->>'saidBy'), '') else said_by end,
   said_on = case when p ? 'saidOn' then nullif(p->>'saidOn', '')::date else said_on end,
   quote = case when p ? 'quote' then nullif(btrim(p->>'quote'), '') else quote end,
   answer = case when p ? 'answer' then nullif(btrim(p->>'answer'), '') else answer end,
   owner_person_id = v_owner, status = v_status, doc_id = v_doc, goal_id = v_goal, project_id = v_project, updated_at = now()
 where id = p_id;
 return p_id;
end $$;

-- A decision drives a task (project, goal): the writer may change the decision and sees the work.
create function pulse.plan_item_link_add(p_item uuid, p_kind text, p_ref uuid) returns boolean
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); r plan_item;
begin
 select * into r from plan_item where org_id = current_org() and id = p_item;
 if not found then raise exception 'That decision is gone' using errcode = 'P0002'; end if;
 if not (viewer_is('admin', 'leadership') or r.created_by = me
   or (r.doc_id is not null and exists(select 1 from doc d where d.id = r.doc_id and doc_can_edit(d.id, d.access, d.created_by, d.company_edits))))
 then raise exception 'Only someone who may change the decision links it' using errcode = '42501'; end if;
 if p_kind not in ('task', 'project', 'goal') or not (case p_kind
     when 'task' then exists(select 1 from task where org_id = current_org() and id = p_ref)
     when 'project' then exists(select 1 from project where org_id = current_org() and id = p_ref)
     else exists(select 1 from goal where org_id = current_org() and id = p_ref) end)
 then raise exception 'Choose work from this company' using errcode = '22023'; end if;
 insert into plan_item_link(org_id, item_id, kind, ref_id, added_by) values (current_org(), p_item, p_kind, p_ref, me) on conflict do nothing;
 return true;
end $$;

-- ------------------------------------------------------------------------------------------------ external keys
create table pulse.external_key (
  org_id uuid not null references pulse.org(id),
  kind text not null check (kind in ('goal', 'project', 'task', 'doc', 'folder', 'decision')),
  key text not null check (length(key) between 1 and 200 and key !~ '[[:cntrl:]]'),
  ref_id uuid not null,
  created_by uuid not null references pulse.person(id),
  created_at timestamptz not null default now(),
  primary key (org_id, kind, key),
  unique (org_id, kind, ref_id)
);

-- Whether the viewer sees the record behind a key (security invoker: the records' own read rules decide).
create function pulse.external_key_visible(p_kind text, p_id uuid) returns boolean
 language sql stable security invoker set search_path=pulse,pg_temp as $$
 select case p_kind
   when 'task' then exists(select 1 from task t where t.id = p_id and t.deleted_at is null)
   when 'project' then exists(select 1 from project p where p.id = p_id)
   when 'goal' then exists(select 1 from goal g where g.id = p_id)
   when 'doc' then exists(select 1 from doc d where d.id = p_id)
   when 'folder' then exists(select 1 from doc_folder f where f.id = p_id)
   when 'decision' then exists(select 1 from plan_item i where i.id = p_id)
   else false end
$$;

-- Whether the viewer may give the record a key: whoever may change it (looked up past the viewer's own read rules).
create function pulse.external_key_can_set(p_kind text, p_id uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and not viewer_outside_seat() and case p_kind
   when 'task' then coalesce(task_can_edit(p_id), false)
   when 'project' then exists(select 1 from project p where p.org_id = current_org() and p.id = p_id)
     and (viewer_is('admin', 'leadership') or coalesce(work_project_can_manage(p_id), false))
   when 'goal' then goal_id_can_edit(p_id)
   when 'doc' then exists(select 1 from doc d where d.org_id = current_org() and d.id = p_id
     and doc_can_edit(d.id, d.access, d.created_by, d.company_edits))
   when 'folder' then exists(select 1 from doc_folder f where f.org_id = current_org() and f.id = p_id
     and (f.created_by = current_viewer() or viewer_is('admin', 'leadership')))
   when 'decision' then exists(select 1 from plan_item i where i.org_id = current_org() and i.id = p_id
     and (i.created_by = current_viewer() or viewer_is('admin', 'leadership')))
   else false end
$$;

alter table pulse.external_key enable row level security;
alter table pulse.external_key force row level security;
create policy tenant_isolation on pulse.external_key using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy external_key_see on pulse.external_key as restrictive for select to pulse_api using (pulse.external_key_visible(kind, ref_id));
create policy external_key_add on pulse.external_key as restrictive for insert to pulse_api
  with check (created_by = pulse.current_viewer() and pulse.external_key_can_set(kind, ref_id));
grant select, insert on pulse.external_key to pulse_api;

-- Whether a key is already held in this company, by any record (also one the viewer cannot see): the caller reads its
-- own visible keys first and refuses a taken key it cannot see, so nobody writes over what they cannot read.
create function pulse.external_key_taken(p_kind text, p_key text) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and exists(select 1 from external_key where org_id = current_org() and kind = p_kind and key = p_key)
$$;

-- ------------------------------------------------------------------------------------------------ workflow runs
create table pulse.workflow_log_run (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  lane text not null check (length(btrim(lane)) between 1 and 80 and lane !~ '[[:cntrl:]]'),
  workflow text not null check (length(btrim(workflow)) between 1 and 160 and workflow !~ '[[:cntrl:]]'),
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_s integer generated always as (case when ended_at is null then null else greatest(0, extract(epoch from ended_at - started_at))::integer end) stored,
  outcome text not null check (outcome in ('ok', 'partial', 'failed', 'blocked')),
  steps jsonb not null default '[]' check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) <= 100 and length(steps::text) <= 40000),
  failures jsonb not null default '[]' check (jsonb_typeof(failures) = 'array' and jsonb_array_length(failures) <= 50 and length(failures::text) <= 20000),
  why text check (length(why) <= 4000),
  lesson text check (length(lesson) <= 4000),
  playbook text check (length(playbook) <= 2000),
  run_key text check (length(run_key) between 1 and 200 and run_key !~ '[[:cntrl:]]'),
  task_id uuid references pulse.task(id),
  created_by uuid not null references pulse.person(id),
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);
create unique index workflow_log_run_key on pulse.workflow_log_run(org_id, run_key) where run_key is not null;
create index workflow_log_run_when on pulse.workflow_log_run(org_id, started_at desc);
alter table pulse.workflow_log_run enable row level security;
alter table pulse.workflow_log_run force row level security;
create policy tenant_isolation on pulse.workflow_log_run using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- The company's staff and AI employees read the log and add to it (each run as its writer); nobody changes a past run.
create policy workflow_log_run_see on pulse.workflow_log_run as restrictive for select to pulse_api
  using (exists(select 1 from pulse.person p where p.id = pulse.current_viewer() and p.side in ('staff', 'agent')));
create policy workflow_log_run_add on pulse.workflow_log_run as restrictive for insert to pulse_api
  with check (created_by = pulse.current_viewer() and exists(select 1 from pulse.person p where p.id = pulse.current_viewer() and p.side in ('staff', 'agent') and p.status = 'active'));
grant select, insert on pulse.workflow_log_run to pulse_api;

-- ------------------------------------------------------------------------------------------------ notify digest | none
create or replace function pulse.task_notify(p_person uuid,p_type text,p_task uuid,p_key text,p_title text) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if p_person is null or p_person=current_viewer() then return null;end if;
 -- AC-PLAN-TOOLS: a bulk import (plan apply) asks for one digest per person, or none, instead of one notice per task.
 if p_type='task.assigned' and coalesce(current_setting('pulse.notify_mode',true),'') in ('digest','none') then return null;end if;
 return notification_emit(p_person,p_type,'task',p_task,p_key,left(p_title,160),'/tasks/'||p_task,'task');
end $$;

-- The assignment trigger emits directly, so it must honour the same bulk mode.
create or replace function pulse.companion_work_update() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare target uuid;recipient uuid;
begin
 if current_viewer() is null then return null;end if;
 if TG_TABLE_NAME='task' then
  if coalesce(current_setting('pulse.notify_mode',true),'') in ('digest','none') then return null;end if;
  target:=coalesce(new.owner_id,new.assignee_person_id);
  if target is null or target=current_viewer() or TG_OP='UPDATE' and target is not distinct from coalesce(old.owner_id,old.assignee_person_id) then return null;end if;
  perform notification_emit(target,'task.assigned','task',new.id,new.id||':'||new.notification_revision,'A task was assigned to you','/tasks/'||new.id,'task');
 elsif TG_TABLE_NAME='policy_document' then
  if new.status<>'published' or TG_OP='UPDATE' and old.status='published' then return null;end if;
  for recipient in select id from person where org_id=new.org_id and side='staff' and status='active' loop
   perform notification_emit(recipient,'policy.published','policy',new.id,new.id::text,'A policy update is ready','/me?tab=policies&kind='||new.kind,'policy');
  end loop;
 elsif TG_TABLE_NAME='holiday' then
  if TG_OP='UPDATE' and (new.name,new.optional,new.day) is not distinct from (old.name,old.optional,old.day) then return null;end if;
  for recipient in select id from person where org_id=new.org_id and side='staff' and status='active' loop
   perform notification_emit(recipient,'holiday.announced','holiday',new.id,new.id||':'||new.notification_revision,'The holiday list was updated','/me?tab=leave','holiday');
  end loop;
 end if;return null;
end $$;

-- One "N new tasks for you" notice per person, after a bulk import in digest mode. Only for tasks the viewer gave that
-- person in this very transaction (created_at = now()), so it never announces anything else.
create function pulse.plan_notify_digest(p_person uuid, p_title text, p_href text, p_key text) returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); n int; first uuid;
begin
 if me is null or p_person is null or p_person = me then return 0; end if;
 select count(*)::int, (array_agg(id order by created_at, id))[1] into n, first from task
  where org_id = current_org() and created_by = me and assignee_person_id = p_person and created_at = now() and deleted_at is null;
 if n = 0 then return 0; end if;
 perform notification_emit(p_person, 'task.assigned', 'task', first, left('plan:' || coalesce(p_key, '') || ':' || p_person, 200),
   left(format('%s new %s for you: %s', n, case when n = 1 then 'task' else 'tasks' end, coalesce(nullif(btrim(p_title), ''), 'a plan')), 160),
   coalesce(nullif(p_href, ''), '/tasks/' || first), 'task');
 return n;
end $$;

revoke all on function pulse.external_key_can_set(text, uuid) from public;
revoke all on function pulse.external_key_taken(text, text) from public;
revoke all on function pulse.plan_item_save(uuid, jsonb) from public;
revoke all on function pulse.plan_item_link_add(uuid, text, uuid) from public;
revoke all on function pulse.plan_notify_digest(uuid, text, text, text) from public;
grant execute on function pulse.external_key_visible(text, uuid), pulse.external_key_can_set(text, uuid), pulse.external_key_taken(text, text),
  pulse.plan_item_visible(uuid, uuid, uuid), pulse.plan_item_save(uuid, jsonb), pulse.plan_item_link_add(uuid, text, uuid),
  pulse.plan_notify_digest(uuid, text, text, text) to pulse_api;

-- The new agent writes use the same audited change ledger as other API writes.
alter table pulse_priv.app_change drop constraint app_change_action_check;
alter table pulse_priv.app_change add constraint app_change_action_check check (action in (
  'profile.correct', 'password.issue', 'invite.send', 'chat.group.create', 'chat.members', 'feedback.status',
  'task.create', 'task.assign', 'task.update', 'task.complete', 'comment.add', 'project.create', 'stage.owner', 'stage.task',
  'chat.message', 'client.create', 'catalog.item.create', 'stock.move', 'quotation.create', 'quotation.revise', 'quotation.submit',
  'quotation.approve', 'quotation.send', 'invoice.create', 'invoice.issue', 'payment.record',
  'project.update', 'project.delete', 'expense.create', 'leave.request',
  'ai_employee.create', 'ai_employee.update', 'ai_employee.cap', 'ai_employee.key.create', 'ai_employee.key.revoke',
  'server.job',
  'connector.tool',
  'contract.create', 'contract.update', 'contract.send', 'contract.accept', 'contract.end', 'contract.txn', 'contract.link',
  'goal.create', 'goal.update', 'goal.link', 'goal.unlink', 'plan.apply', 'task.block', 'task.unblock'));

-- migrate:down
-- Forward-only: plans, keys, decisions and the workflow log are company data. task_notify keeps working without a mode.
