-- migrate:up
-- RELEASE-5: undoing Pulse's own finish also settles what led to it. The events that met the task's signals stay as
-- they are (the trail), but the person who pressed Undo has seen them: the companion no longer asks "Everything it needs
-- has happened. Mark … done?" about the same events a moment after they said it was not done yet. It asks again at the
-- next event, as UX-5B intends ("it asks next time": auto_done is off for the task).
create or replace function pulse.task_auto_done_undo(p_task uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k task; a task_auto_done; me uuid:=task_require_viewer();
begin
 k:=task_for_edit(p_task);
 select * into a from task_auto_done where org_id=current_org() and task_id=p_task and undone_at is null order by done_at desc limit 1;
 if not found then raise exception 'Pulse did not finish this task by itself' using errcode='P0002'; end if;
 if k.status not in ('done','in_review') then raise exception 'It has been % since; change it on the task', case k.status when 'accepted' then 'accepted' else 'changed' end using errcode='22023'; end if;
 update task set status=a.prior_status,done_at=null,updated_at=now(),edited_by=me where id=p_task;
 update task_auto_done set undone_at=clock_timestamp(),undone_by=me,told_at=coalesce(told_at,clock_timestamp()) where id=a.id;
 update task_companion set auto_done=false,updated_at=now() where task_id=p_task;
 update task_signal_hit set seen_by=array_append(seen_by,me) where task_id=p_task and not me=any(seen_by);
 perform task_event_add(p_task,'status','done',a.prior_status,'Undo: it was not done yet (Pulse had marked it done)');
 return jsonb_build_object('status',a.prior_status);
end $$;

-- migrate:down
-- Forward-only.
