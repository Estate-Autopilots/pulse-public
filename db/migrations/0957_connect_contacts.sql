-- migrate:up
-- CONNECT 2 / E2E fix 5 (23 Oct 2026): more than one point of contact per side of a connection, so a client's colleague
-- can join the shared group. Each side's admins, HR and leadership (who manage connections today) add people of their
-- own team as contacts: each gets a seat in the other organisation, exactly like the points of contact at accept
-- (connect_seat_make, 0953). Removing a contact ends the seat (removed_at): they leave the groups shared through the
-- connection and their person there becomes inactive, unless the same account still has another active seat there.
-- The last contact of a side cannot be removed. Every function called here is defined in the repo's migrations
-- (0004 viewer_is, 0011 audit_write, 0148 chat_event_line, 0920 acct_enter/acct_leave/account_of_viewer, 0953 connect_*).

alter table pulse_priv.connect_seat add column id uuid not null default gen_random_uuid();
alter table pulse_priv.connect_seat add column removed_at timestamptz;
create unique index connect_seat_id on pulse_priv.connect_seat(id);

-- A seat counts only while it is not removed.
create or replace function pulse.connect_is_seat(p_person uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (select 1 from pulse_priv.connect_seat s join pulse_priv.org_connection c on c.id = s.connection_id and c.status = 'active'
                 where s.seat_person = p_person and s.seat_org = current_org() and s.removed_at is null)
    and exists (select 1 from person where id = p_person and org_id = current_org() and status = 'active')
$$;

-- 0953's seat maker, now also bringing a removed seat back (its person there active again, the seat row reopened).
create or replace function pulse.connect_seat_make(p_conn uuid, p_account uuid, p_home_org uuid, p_home_person uuid, p_seat_org uuid, p_kind text, p_title text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_person uuid; a pulse_priv.pulse_account%rowtype; v_no int; v_user text; n int := 1; v_kind text;
begin
  select person_id, kind into v_person, v_kind from pulse_priv.account_member where account_id = p_account and member_org = p_seat_org;
  if v_person is not null and v_kind not in ('client', 'partner') then
    raise exception 'This account is already on the team of the other organisation' using errcode = '23505'; end if;
  if v_person is null then
    select * into a from pulse_priv.pulse_account where id = p_account;
    perform acct_enter(p_seat_org, null);
    insert into person(org_id, display_name, side, status, active_from) values (p_seat_org, a.display_name, 'client', 'active', current_date) returning id into v_person;
    select coalesce(max(user_no), 0) + 1 into v_no from people_profile where org_id = p_seat_org;
    v_user := a.handle;
    while exists (select 1 from people_profile where org_id = p_seat_org and username = v_user) loop n := n + 1; v_user := a.handle || '.' || n; end loop;
    insert into people_profile(org_id, person_id, role, email, username, user_no, evidence, field_sources)
    values (p_seat_org, v_person, left(p_title, 80), a.email, v_user, v_no, 'Connected organisation contact (@' || a.handle || ')', '{}');
    perform acct_leave();
    insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (p_account, p_seat_org, v_person, p_kind);
  else
    perform acct_enter(p_seat_org, null);
    update person set status = 'active' where id = v_person and org_id = p_seat_org and side = 'client' and status <> 'active';
    perform acct_leave();
  end if;
  insert into pulse_priv.connect_seat(connection_id, account_id, home_org, home_person, seat_org, seat_person)
  values (p_conn, p_account, p_home_org, p_home_person, p_seat_org, v_person)
  on conflict (connection_id, account_id) do update set removed_at = null, home_org = excluded.home_org, home_person = excluded.home_person, seat_person = excluded.seat_person;
  return v_person;
end $$;

-- May the viewer choose this organisation's points of contact on a connection? (The same people who manage connections.)
create function pulse.connect_can_manage(p_conn uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (select 1 from pulse_priv.org_connection c where c.id = p_conn and c.status = 'active' and current_org() in (c.a_org, c.b_org))
    and exists (select 1 from person where id = current_viewer() and org_id = current_org() and side = 'staff' and status = 'active')
    and viewer_is('admin', 'leadership', 'hr')
$$;

-- Add someone of our team as a point of contact: a seat for them in the other organisation. Returns the seat id.
create function pulse.connect_contact_add(p_conn uuid, p_person uuid) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c pulse_priv.org_connection%rowtype; v_other uuid; v_acct uuid; v_name text; v_org_name text; v_seat uuid;
begin
  select * into c from pulse_priv.org_connection where id = p_conn and status = 'active' and current_org() in (a_org, b_org);
  if not found then raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if not connect_can_manage(p_conn) then raise exception 'Admins, HR and leadership choose the points of contact' using errcode = '42501'; end if;
  v_other := case when c.a_org = current_org() then c.b_org else c.a_org end;
  if v_other is null then raise exception 'An individual client has no organisation to add contacts to' using errcode = '22023'; end if;
  select display_name into v_name from person where id = p_person and org_id = current_org() and side = 'staff' and status = 'active';
  if v_name is null then raise exception 'Choose someone from your team' using errcode = '22023'; end if;
  v_acct := connect_account_of(current_org(), p_person);
  if exists (select 1 from pulse_priv.connect_seat where connection_id = p_conn and account_id = v_acct and removed_at is null) then
    raise exception '% is already a contact', v_name using errcode = '23505'; end if;
  select name into v_org_name from org where id = current_org();
  if c.a_org = current_org() then
    perform connect_seat_make(p_conn, v_acct, current_org(), p_person, v_other, 'partner', v_org_name || ' · point of contact');
  else
    perform connect_seat_make(p_conn, v_acct, current_org(), p_person, v_other, 'client', 'Client · ' || v_org_name);
  end if;
  select id into v_seat from pulse_priv.connect_seat where connection_id = p_conn and account_id = v_acct;
  perform audit_write('create', 'connect_seat', v_seat::text);
  return v_seat;
end $$;

-- Remove one of our points of contact: the seat ends, they leave the connection's shared groups, and their person there
-- becomes inactive (unless another active seat of theirs is there). A side always keeps at least one contact.
create function pulse.connect_contact_remove(p_conn uuid, p_seat uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s pulse_priv.connect_seat%rowtype; v_name text; v_org_name text; x record;
begin
  if not exists (select 1 from pulse_priv.org_connection where id = p_conn and status = 'active' and current_org() in (a_org, b_org)) then
    raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if not connect_can_manage(p_conn) then raise exception 'Admins, HR and leadership choose the points of contact' using errcode = '42501'; end if;
  select * into s from pulse_priv.connect_seat where id = p_seat and connection_id = p_conn and home_org = current_org() and removed_at is null for update;
  if not found then raise exception 'That contact is not on this connection' using errcode = 'P0002'; end if;
  select display_name into v_name from person where id = s.home_person;
  if (select count(*) from pulse_priv.connect_seat where connection_id = p_conn and home_org = current_org() and removed_at is null) <= 1 then
    raise exception 'Keep at least one contact: add someone else before removing %', coalesce(v_name, 'them') using errcode = '22023'; end if;
  update pulse_priv.connect_seat set removed_at = now() where id = s.id;
  select name into v_org_name from org where id = current_org();
  perform acct_enter(s.seat_org, null);
  for x in select cm.channel_id from chat_member cm
            where cm.person_id = s.seat_person
              and cm.channel_id in (select ref from pulse_priv.connect_share where connection_id = p_conn and host_org = s.seat_org and kind = 'chat') loop
    perform chat_event_line(x.channel_id, s.seat_person, 'is no longer a contact of ' || v_org_name);
    delete from chat_member where channel_id = x.channel_id and person_id = s.seat_person;
  end loop;
  if not exists (select 1 from pulse_priv.connect_seat o join pulse_priv.org_connection oc on oc.id = o.connection_id and oc.status = 'active'
                 where o.seat_person = s.seat_person and o.removed_at is null) then
    update person set status = 'inactive' where id = s.seat_person and org_id = s.seat_org and side = 'client';
  end if;
  perform acct_leave();
  perform audit_write('delete', 'connect_seat', s.id::text);
end $$;

-- 0953's connection list, with seat ids, removed seats left out and whether the viewer may choose our contacts.
create or replace function pulse.connect_list() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare out jsonb := '[]'; c record; v_acct uuid := account_of_viewer(); v_seat uuid; v_items jsonb; x record; card jsonb;
begin
  if current_viewer() is null then return out; end if;
  for c in select * from pulse_priv.org_connection where status = 'active' and (a_org = current_org() or b_org = current_org()) order by created_at desc loop
    v_items := '[]';
    for x in select id, host_org from pulse_priv.connect_share where connection_id = c.id order by created_at desc loop
      v_seat := null;
      if x.host_org <> current_org() then
        select seat_person into v_seat from pulse_priv.connect_seat where connection_id = c.id and account_id = v_acct and seat_org = x.host_org and removed_at is null;
        if v_seat is null then continue; end if;
        card := connect_share_card(x.id, v_seat);
      else
        card := connect_share_card(x.id, current_viewer());
      end if;
      if card is not null then v_items := v_items || jsonb_build_array(card || jsonb_build_object('here', x.host_org = current_org())); end if;
    end loop;
    out := out || jsonb_build_array(jsonb_build_object(
      'id', c.id, 'since', c.created_at, 'kind', c.kind, 'weInvited', c.a_org = current_org(),
      'other', jsonb_build_object('org', case when c.a_org = current_org() then c.b_org else c.a_org end, 'name', connect_other_name(c.id),
        'handle', (select handle from org where id = case when c.a_org = current_org() then c.b_org else c.a_org end), 'individual', c.b_org is null),
      'project', (select project from pulse_priv.connect_request where id = c.request_id),
      'summary', (select summary from pulse_priv.connect_request where id = c.request_id),
      'canManage', connect_can_manage(c.id) and c.b_org is not null,
      -- Our people with a seat there (their names as we know them), and their people with a seat here (assignable here).
      'ours', coalesce((select jsonb_agg(jsonb_build_object('seat', s.id, 'person', s.home_person, 'name', (select display_name from person where id = s.home_person), 'me', s.home_person = current_viewer()) order by s.created_at)
        from pulse_priv.connect_seat s where s.connection_id = c.id and s.home_org = current_org() and s.removed_at is null), '[]'::jsonb),
      'theirs', coalesce((select jsonb_agg(jsonb_build_object('seat', s.id, 'person', s.seat_person, 'name', p.display_name, 'role', pp.role) order by s.created_at)
        from pulse_priv.connect_seat s join person p on p.id = s.seat_person left join people_profile pp on pp.person_id = p.id
        where s.connection_id = c.id and s.seat_org = current_org() and s.removed_at is null), '[]'::jsonb),
      'mySeat', exists (select 1 from pulse_priv.connect_seat s where s.connection_id = c.id and s.account_id = v_acct and s.seat_org <> current_org() and s.removed_at is null),
      'shared', v_items));
  end loop;
  return out;
end $$;

create or replace function pulse.connect_shared_chats() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare out jsonb := '[]'; v_acct uuid := account_of_viewer(); x record; card jsonb;
begin
  if v_acct is null then return out; end if;
  for x in select sh.id, s.seat_person from pulse_priv.connect_seat s join pulse_priv.org_connection c on c.id = s.connection_id and c.status = 'active'
            join pulse_priv.connect_share sh on sh.connection_id = s.connection_id and sh.host_org = s.seat_org and sh.kind = 'chat'
            where s.account_id = v_acct and s.seat_org <> current_org() and s.home_org is not distinct from current_org() and s.removed_at is null loop
    card := connect_share_card(x.id, x.seat_person);
    if card is not null then out := out || jsonb_build_array(card); end if;
  end loop;
  return out;
end $$;

create or replace function pulse.connect_group_create(p_conn uuid, p_name text, p_members uuid[]) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare cid uuid; n text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); theirs int;
begin
  if not exists (select 1 from pulse_priv.org_connection where id = p_conn and status = 'active' and current_org() in (a_org, b_org)) then
    raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from person where id = current_viewer() and side = 'staff' and status = 'active') then
    raise exception 'Groups for a connection are made by the team' using errcode = '42501'; end if;
  if length(n) not between 2 and 60 then raise exception 'Name the group (2 to 60 characters)' using errcode = '22023'; end if;
  if coalesce(cardinality(p_members), 0) = 0 or cardinality(p_members) > 256 then raise exception 'Add between 1 and 256 people' using errcode = '22023'; end if;
  select count(*) into theirs from pulse_priv.connect_seat s where s.connection_id = p_conn and s.seat_org = current_org() and s.removed_at is null and s.seat_person = any(p_members);
  if theirs = 0 then raise exception 'Add at least one person from %', connect_other_name(p_conn) using errcode = '22023'; end if;
  insert into chat_channel(org_id, key, name, kind, description, created_by)
  values (current_org(), 'custom:' || gen_random_uuid(), n, 'custom', 'Shared with ' || connect_other_name(p_conn), current_viewer()) returning id into cid;
  insert into chat_member(org_id, channel_id, person_id, role) values (current_org(), cid, current_viewer(), 'admin');
  insert into chat_member(org_id, channel_id, person_id) select current_org(), cid, p.id from person p
  where p.org_id = current_org() and p.id = any(p_members) and p.id <> current_viewer() and p.status = 'active'
    and (p.side = 'staff' or exists (select 1 from pulse_priv.connect_seat s where s.connection_id = p_conn and s.seat_person = p.id and s.seat_org = current_org() and s.removed_at is null))
  on conflict do nothing;
  insert into pulse_priv.connect_share(connection_id, host_org, kind, ref, created_by) values (p_conn, current_org(), 'chat', cid, current_viewer());
  perform chat_event_line(cid, current_viewer(), 'created the group “' || n || '” with ' || connect_other_name(p_conn));
  perform audit_write('create', 'connect_share', cid::text);
  return cid;
end $$;

create or replace function pulse.connect_task_give(p_conn uuid, p jsonb) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_to uuid := nullif(p ->> 'assigneeId', '')::uuid; tid uuid; me uuid := current_viewer();
begin
  if not exists (select 1 from pulse_priv.org_connection where id = p_conn and status = 'active' and current_org() in (a_org, b_org)) then
    raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from person where id = me and side = 'staff' and status = 'active') then
    raise exception 'Tasks for a connection are given by the team' using errcode = '42501'; end if;
  if not exists (select 1 from pulse_priv.connect_seat s where s.connection_id = p_conn and s.seat_org = current_org() and s.seat_person = v_to and s.removed_at is null) then
    raise exception 'Choose a contact of %', connect_other_name(p_conn) using errcode = '22023'; end if;
  tid := task_save(null, jsonb_build_object('title', p ->> 'title', 'notes', coalesce(p ->> 'notes', ''), 'dueOn', nullif(p ->> 'dueOn', ''), 'assigneeId', me, 'reviewerId', null));
  update task set assignee_person_id = v_to, owner_id = v_to, review_owner_id = me, assigned_at = now() where id = tid;
  perform task_event_add(tid, 'assigned', null, (select display_name from person where id = v_to) || ' (' || connect_other_name(p_conn) || ')');
  insert into pulse_priv.connect_share(connection_id, host_org, kind, ref, created_by) values (p_conn, current_org(), 'task', tid, me);
  return tid;
end $$;

-- Chats (0148): a group admin may also add the contacts of a connection that shares this group (their seats here), so a
-- new contact can join an existing shared group. Everyone else still has to be on the team.
create or replace function pulse.chat_group_members(p_channel uuid,p_add uuid[],p_remove uuid[]) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare who record;
begin
 if not chat_group_admin(p_channel) then raise exception 'only a group admin can change members' using errcode='42501'; end if;
 for who in insert into chat_member(org_id,channel_id,person_id) select current_org(),p_channel,p.id from person p
 where p.org_id=current_org() and p.id=any(coalesce(p_add,'{}')) and p.status='active'
  and (p.side='staff' or exists(select 1 from pulse_priv.connect_share sh join pulse_priv.org_connection oc on oc.id=sh.connection_id and oc.status='active'
   join pulse_priv.connect_seat s on s.connection_id=sh.connection_id and s.seat_org=sh.host_org and s.removed_at is null
   where sh.host_org=current_org() and sh.kind='chat' and sh.ref=p_channel and s.seat_person=p.id))
 on conflict do nothing returning person_id loop
 perform chat_event_line(p_channel,current_viewer(),'added '||(select display_name from person where id=who.person_id));
 end loop;
 for who in delete from chat_member where org_id=current_org() and channel_id=p_channel and person_id=any(coalesce(p_remove,'{}')) and person_id<>current_viewer() returning person_id loop
 perform chat_event_line(p_channel,current_viewer(),'removed '||(select display_name from person where id=who.person_id));
 end loop;
end $$;

revoke all on function pulse.connect_can_manage(uuid), pulse.connect_contact_add(uuid, uuid), pulse.connect_contact_remove(uuid, uuid) from public;
grant execute on function pulse.connect_contact_add(uuid, uuid), pulse.connect_contact_remove(uuid, uuid) to pulse_api;

-- migrate:down
