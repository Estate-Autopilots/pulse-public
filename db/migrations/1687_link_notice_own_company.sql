-- migrate:up
-- CI (6 Nov 2026, the two-company matrix, tests/core/test_tenant_isolation.py). Since SELFSERVE-P1 (1540) a set-password
-- or one-time sign-in link of another company is redeemed at the shared address inside its own organisation. The API
-- then sends the "Pulse password changed" / "New device" notice and records it with a fresh connection, which sits in
-- the address's organisation (the install's): pulse.auth_mail_event and pulse.auth_new_device wrote the other
-- company's person id into the install company's auth events, audit log and seen devices, and the install company's
-- GET /api/v0/audit showed it. Now, at the install's address only, an actor who is not a person of the install's
-- company is looked up in the other active organisations (each read under its own row security, as 1540's
-- auth_link_away) and the event is recorded there; nothing of theirs is written in the install's company. Elsewhere,
-- and for the install's own people, everything is 0104's.

-- The organisation of a staff actor who is not the install company's own, at the install's address (null otherwise).
-- Internal.
create function pulse.auth_actor_away(r text, a uuid) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare here uuid := current_org(); o uuid; hit uuid;
begin
  if r is distinct from 'staff' or a is null or here is null or here is distinct from install_org() then return null; end if;
  if exists (select 1 from person where org_id = here and id = a) then return null; end if;
  for o in select id from org where status = 'active' and id <> here loop
    perform set_config('pulse.org_id', o::text, true);
    if exists (select 1 from person where org_id = o and id = a) then hit := o; exit; end if;
  end loop;
  perform set_config('pulse.org_id', here::text, true);
  return hit;
end $$;
revoke all on function pulse.auth_actor_away(text, uuid) from public;

create or replace function pulse.auth_mail_event(r text,a uuid,ok boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare here uuid := current_org(); away uuid := auth_actor_away(r, a);
begin
 if away is not null then perform set_config('pulse.org_id', away::text, true); end if;
 perform auth_event_add(r,a,case when ok then 'security_email_sent' else 'security_email_failed' end);
 if away is not null then perform set_config('pulse.org_id', here::text, true); end if;
end $$;

create or replace function pulse.auth_new_device(r text,a uuid,d text,device_id text) returns boolean language plpgsql security definer set search_path=pulse,pg_temp as $$
declare here uuid := current_org(); away uuid := auth_actor_away(r, a); fresh boolean;
begin
 if away is not null then perform set_config('pulse.org_id', away::text, true); end if;
 insert into pulse_priv.auth_seen_device values(current_org(),r,a,d,device_id) on conflict do nothing; fresh := found;
 if away is not null then perform set_config('pulse.org_id', here::text, true); end if;
 return fresh;
end $$;

-- migrate:down
-- Forward-only: 0104's functions wrote another company's person id into the install company's audit.
