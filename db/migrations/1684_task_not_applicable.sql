-- migrate:up
-- UX-DELIGHT (6 Nov 2026, from a staff member's week with Work): "Not applicable" is its own way to close a task.
-- It counts as closed (nothing waits on it, it leaves every open list) and is NOT counted as done: progress, scores and
-- "done this week" leave it out exactly as they leave out Cancelled. It is kept as status 'cancelled' plus
-- closed_as='not_applicable', so every rule that already treats Cancelled as closed (blockers, notifications, flows,
-- the AI employee, progress totals) treats Not applicable the same without being rewritten; the API, MCP and CLI read
-- and write it as the status "not_applicable".
alter table pulse.task add column if not exists closed_as text check (closed_as in ('not_applicable'));
comment on column pulse.task.closed_as is 'Why a cancelled task was closed: not_applicable (the task did not apply). Cleared whenever the status leaves cancelled.';

-- Whatever moves a task out of Cancelled (reopen, a tracker sync, the AI employee) drops the reason with it.
create or replace function pulse.task_closed_as_clear() returns trigger language plpgsql set search_path=pulse,pg_temp as $$
begin
 if new.status<>'cancelled' then new.closed_as:=null; end if;
 return new;
end $$;
drop trigger if exists task_closed_as_clear on pulse.task;
create trigger task_closed_as_clear before update of status on pulse.task for each row
 when (new.status is distinct from old.status) execute function pulse.task_closed_as_clear();

-- task_move (0141) also takes 'not_applicable'. Moving between Cancelled and Not applicable only changes the reason.
create or replace function pulse.task_move(p_id uuid,p_status text,p_note text default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;released int:=0;was text;
 s text:=case when p_status='not_applicable' then 'cancelled' else p_status end;
 why text:=case when p_status='not_applicable' then 'not_applicable' end;
begin
 t:=task_for_edit(p_id);
 if p_status not in ('open','in_progress','blocked','done','cancelled','not_applicable') then raise exception 'Choose To do, Doing, Blocked, Done, Not applicable or Cancelled; the reviewer accepts' using errcode='22023';end if;
 if t.status='accepted' and not (viewer_is('admin','leadership') or me=t.review_owner_id) then raise exception 'An accepted task can be reopened by its reviewer or leadership' using errcode='42501';end if;
 was:=case when t.status='cancelled' and t.closed_as='not_applicable' then 'not_applicable' else t.status end;
 if p_status=was then return jsonb_build_object('status',was);end if;
 if s=t.status then
  update task set closed_as=why,updated_at=now(),edited_by=me where id=p_id;
  perform task_event_add(p_id,'status',was,p_status,nullif(btrim(coalesce(p_note,'')),''));
  return jsonb_build_object('status',p_status,'released',0);
 end if;
 -- Leaving Blocked by hand clears its blockers: that is the Unblock action.
 if t.status='blocked' and s<>'blocked' then
  update task_link set cleared_at=now(),cleared_by=me where org_id=current_org() and task_id=p_id and cleared_at is null;
 end if;
 update task set status=s,closed_as=why,updated_at=now(),edited_by=me,locked=array(select distinct unnest(locked||'{status}'::text[])),
  started_at=case when s='in_progress' and started_at is null then now() else started_at end,
  done_at=case when s='done' then now() when s in ('open','in_progress','blocked') then null else done_at end,
  accepted_at=case when s<>'accepted' then null else accepted_at end,accepted_by=case when s<>'accepted' then null else accepted_by end
 where id=p_id;
 perform task_event_add(p_id,'status',was,p_status,nullif(btrim(coalesce(p_note,'')),''));
 if s in ('done','cancelled') then released:=task_release_waiting(p_id);end if;
 if s='done' then perform task_notify(t.review_owner_id,'task.done',p_id,p_id||':done:'||now()::text,'Ready to accept: '||t.title);end if;
 return jsonb_build_object('status',p_status,'released',released);
end $$;

-- migrate:down
-- Forward-only: tasks closed as Not applicable keep closed_as; put back by hand only with the code that reads it.
