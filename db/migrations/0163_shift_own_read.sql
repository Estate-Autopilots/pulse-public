-- migrate:up
-- POLISH-1: everyone reads their own shift. Since 0011 the restrictive admin_write policy on shift and person_shift
-- covered reads too, so a person who is not admin or HR read no shift at all and their daily brief ignored it.
-- Writes stay with admins and HR. A person reads only their own assignments and the shifts those assignments name;
-- admins and HR read every one.
do $$ declare t text; begin
 foreach t in array array['shift','person_shift'] loop
  execute format('drop policy admin_write on pulse.%I',t);
  execute format('create policy admin_insert on pulse.%I as restrictive for insert to pulse_api with check(pulse.viewer_is(''admin'',''hr''))',t);
  execute format('create policy admin_update on pulse.%I as restrictive for update to pulse_api using(pulse.viewer_is(''admin'',''hr'')) with check(pulse.viewer_is(''admin'',''hr''))',t);
  execute format('create policy admin_delete on pulse.%I as restrictive for delete to pulse_api using(pulse.viewer_is(''admin'',''hr''))',t);
 end loop;
end $$;
create policy own_read on pulse.person_shift as restrictive for select to pulse_api
 using(pulse.viewer_is('admin','hr') or person_id=pulse.current_viewer());
create policy own_read on pulse.shift as restrictive for select to pulse_api
 using(pulse.viewer_is('admin','hr') or exists(select 1 from pulse.person_shift a where a.shift_id=shift.id and a.person_id=pulse.current_viewer()));

-- migrate:down
-- Forward-only.
