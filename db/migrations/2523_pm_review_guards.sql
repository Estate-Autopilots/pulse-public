-- migrate:up
-- PM-BUILD-4 (lane C's urgent finds, T4/T11, SPEC 0.5.8): three holes in live rules, closed without loosening anything.
--  * Accepting work (pulse.task_review_check) and returning it (pulse.task_return) with NO named reviewer: the check
--    `me = t.review_owner_id` is NULL then, so `not (NULL or false)` was NULL and the refusal never fired: any team
--    member could accept or return a plan step (plan steps are made without a reviewer). Now a missing reviewer is
--    "not the reviewer", and the rule the code meant applies: then only leadership, an admin or the doer's manager.
--  * A person's connected AI app (pulse.actor_account 'app:…', 'service:…', an automation) accepted and returned work;
--    only an AI employee's own session was refused. Now any AI or automation session is refused ("a person reviews
--    work").
--  * Sharing with a client (pulse.client_deliverable rows, from client_deliverable_share or anything else) through a
--    connected AI app or an automation: refused; only a person sends to a client. (An AI employee was already refused:
--    cp_staff needs a staff person.)
-- The functions are 1064's, unchanged but for these lines.

create or replace function pulse.task_review_check(t pulse.task, me uuid) returns void language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 -- AI-TASKS: accepting, rating and acknowledging work is a person's (task_review, task_accept, task_acknowledge).
 -- PM-BUILD-4: a connected AI app or an automation is not a person either.
 if agent_session() is not null or task_auto_source() is not null then raise exception 'A person reviews work, never an AI employee' using errcode='42501';end if;
 if me=coalesce(t.assignee_person_id,t.owner_id) then raise exception 'Someone else accepts your work' using errcode='42501';end if;
 -- PM-BUILD-4: no named reviewer is "not the reviewer" (NULL used to let anyone through).
 if not (coalesce(me=t.review_owner_id,false) or (t.review_owner_id is null and (viewer_is('admin','leadership') or coalesce(manages(t.assignee_person_id),false)))
  or (coalesce(task_is_leader(coalesce(t.assignee_person_id,t.owner_id)),false) and viewer_is('admin','leadership'))) then
  raise exception 'Only the reviewer accepts this task' using errcode='42501';end if;
 if t.status not in ('done','in_review') then raise exception 'Mark the task Done before accepting it' using errcode='22023';end if;
 if exists(select 1 from project where id=t.project_id and requires_proof) and not exists(select 1 from task_proof where task_id=t.id and removed_at is null) then
  raise exception 'This project needs proof before acceptance: attach a file or link' using errcode='22023';end if;
end $$;

create or replace function pulse.task_return(p_id uuid, p_note text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;
begin
 -- AI-TASKS: returning work is a person's too. PM-BUILD-4: a connected AI app or an automation is not a person either.
 if agent_session() is not null or task_auto_source() is not null then raise exception 'A person reviews work, never an AI employee' using errcode='42501';end if;
 select * into t from task where org_id=current_org() and id=p_id for update;
 if not found or not task_visible(p_id) then raise exception 'Task not found' using errcode='P0002';end if;
 -- PM-BUILD-4: no named reviewer is "not the reviewer"; then whoever may accept it may return it (leadership, the doer's manager).
 if not (coalesce(me=t.review_owner_id,false) or viewer_is('admin','leadership') or (t.review_owner_id is null and coalesce(manages(t.assignee_person_id),false)))
   or coalesce(me=t.assignee_person_id,false) then raise exception 'Only the reviewer returns this task' using errcode='42501';end if;
 if t.status not in ('done','in_review','accepted') then raise exception 'Only finished work can be returned' using errcode='22023';end if;
 if length(btrim(coalesce(p_note,'')))<3 then raise exception 'Say what still needs doing' using errcode='22023';end if;
 update task set status='in_progress',done_at=null,accepted_at=null,accepted_by=null,updated_at=now(),edited_by=me where id=p_id;
 perform task_event_add(p_id,'returned',t.status,'in_progress',btrim(p_note));
 perform task_notify(coalesce(t.owner_id,t.assignee_person_id),'task.assigned',p_id,p_id||':returned:'||now()::text,'Returned with a note: '||t.title);
end $$;

-- Only a person sends to a client: a share made through a connected AI app or an automation is refused, whatever path
-- writes it. (A row a migration or the worker writes, with no viewer, is not a share by a session and is left alone.)
create function pulse.client_deliverable_person_only() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is not null and (agent_session() is not null or task_auto_source() is not null) then
    raise exception 'Only a person shares with a client, never an AI app' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger client_deliverable_person_only before insert on pulse.client_deliverable for each row execute function pulse.client_deliverable_person_only();
revoke all on function pulse.client_deliverable_person_only() from public;

-- migrate:down
drop trigger if exists client_deliverable_person_only on pulse.client_deliverable;
drop function if exists pulse.client_deliverable_person_only();
-- task_review_check and task_return: restore 1064's definitions to undo (forward-only otherwise).
