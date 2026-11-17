-- migrate:up
-- PEOPLE-LIVE: an automatic decision whose evidence no longer meets the rule goes back to review. The importer finds
-- them (a task's owner came from a sheet title, not an exact roster name on the row); this undoes the effect through
-- the same path as a person's undo (receipt, audit event, owner or pod restored) and makes the link a suggestion
-- again. A decision anyone took by hand is never touched.
create function pulse.people_work_auto_revert(p_ids uuid[]) returns int
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k uuid; receipt uuid; n int:=0;
begin
 if current_viewer() is not null then raise exception 'Only the importer revisits automatic decisions' using errcode='42501';end if;
 foreach k in array coalesce(p_ids,'{}') loop
  if not exists(select 1 from people_work_link where org_id=current_org() and id=k and status='accepted' and auto_accepted) then continue;end if;
  begin
   receipt:=people_work_apply(k,'undo',null,false);
   update people_work_receipt set after_state=after_state||jsonb_build_object('status','suggested',
    'note','The evidence no longer meets the automatic rule; back to review') where org_id=current_org() and id=receipt;
   update people_work_link set status='suggested',auto_accepted=false,decided_by=null,decided_at=null,retired_at=null
    where org_id=current_org() and id=k;
   n:=n+1;
  -- Someone changed the pod or task since: their change stands and the link stays as it is.
  exception when sqlstate '40001' or sqlstate 'P0002' then null;
  end;
 end loop;
 return n;
end $$;
revoke all on function pulse.people_work_auto_revert(uuid[]) from public;
grant execute on function pulse.people_work_auto_revert(uuid[]) to pulse_worker;
-- migrate:down
