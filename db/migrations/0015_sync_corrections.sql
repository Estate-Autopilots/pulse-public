-- migrate:up
-- Source replay respects edited task fields. A source amount change invalidates the previous reconciliation.
create function pulse.task_manual_wins() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null then
  if 'title'=any(old.locked) then new.title:=old.title; end if;
  if 'status'=any(old.locked) then new.status:=old.status; end if;
  if 'owner_id'=any(old.locked) then new.owner_id:=old.owner_id; new.assignee_person_id:=old.assignee_person_id; end if;
  if 'project_id'=any(old.locked) then new.project_id:=old.project_id; end if;
 end if; return new;
end $$;
create trigger task_manual_wins before update on pulse.task for each row execute function pulse.task_manual_wins();
create function pulse.money_source_changed() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if old.payload is distinct from new.payload then new.approved:=false; new.approved_by:=null; end if; return new;
end $$;
create trigger money_source_changed before update on pulse_priv.money_observation for each row execute function pulse.money_source_changed();
revoke all on function pulse.task_manual_wins(),pulse.money_source_changed() from public;
-- migrate:down
