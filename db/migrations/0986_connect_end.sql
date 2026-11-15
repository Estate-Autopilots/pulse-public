-- migrate:up
-- FEATURES-1024 / CONNECT 2 (owner: companies become each other's clients on Pulse; CONNECT report "End connection +
-- what happens to shared items"): admins, HR or leadership on either side end a connection. Every point of contact's
-- seat on both sides ends: they leave the groups shared through it (a line says so in each group), and their person
-- in the other organisation becomes inactive unless another active connection still needs them (as removing one
-- contact does, 0957). What was shared stays where it lives: groups keep their history, tasks stay with the
-- organisation that gave them, for it to reassign. The two can connect again with a new client request.
-- Only functions defined in this repository's migrations are called (0920, 0953, 0957).
create function pulse.connect_end(p_conn uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c pulse_priv.org_connection%rowtype; s pulse_priv.connect_seat%rowtype; x record; v_here text;
begin
  select * into c from pulse_priv.org_connection where id = p_conn and status = 'active' and current_org() in (a_org, b_org) for update;
  if not found then raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if not connect_can_manage(p_conn) then raise exception 'Admins, HR and leadership end a connection' using errcode = '42501'; end if;
  select name into v_here from org where id = current_org();
  update pulse_priv.org_connection set status = 'ended' where id = p_conn;
  for s in select * from pulse_priv.connect_seat where connection_id = p_conn and removed_at is null order by created_at loop
    update pulse_priv.connect_seat set removed_at = now() where id = s.id;
    perform acct_enter(s.seat_org, null);
    for x in select cm.channel_id from chat_member cm
              where cm.person_id = s.seat_person
                and cm.channel_id in (select ref from pulse_priv.connect_share where connection_id = p_conn and host_org = s.seat_org and kind = 'chat') loop
      perform chat_event_line(x.channel_id, s.seat_person, 'left: ' || coalesce(v_here, 'the other organisation') || ' ended the connection');
      delete from chat_member where channel_id = x.channel_id and person_id = s.seat_person;
    end loop;
    if not exists (select 1 from pulse_priv.connect_seat o join pulse_priv.org_connection oc on oc.id = o.connection_id and oc.status = 'active'
                   where o.seat_person = s.seat_person and o.removed_at is null) then
      update person set status = 'inactive' where id = s.seat_person and org_id = s.seat_org and side = 'client';
    end if;
    perform acct_leave();
  end loop;
  perform audit_write('update', 'org_connection', p_conn::text);
end $$;
revoke all on function pulse.connect_end(uuid) from public;
grant execute on function pulse.connect_end(uuid) to pulse_api;

-- migrate:down
-- Forward-only.
