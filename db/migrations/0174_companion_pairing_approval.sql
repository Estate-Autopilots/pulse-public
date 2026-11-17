-- migrate:up
-- EST-658: companion pairing per company. A company may require an admin to approve every new device. The setting is
-- the active tenant_config document (doc_kind 'tenant', doc_key 'companion') with body {"pairing_approval":"admin"};
-- without it, or with "self", the person's own approval on /connect is enough (as before).
-- In admin mode the person's approval moves the request to awaiting_admin for 24 h; the device and its tokens exist
-- only after an admin of the same organisation approves too. An admin's deny ends the request.
alter table pulse_priv.native_pair drop constraint native_pair_status_check,
 add constraint native_pair_status_check check (status in ('pending','awaiting_admin','approved','denied','redeemed')),
 add column admin_id uuid references pulse.person(id);
drop index pulse_priv.native_pair_code;
create unique index native_pair_code on pulse_priv.native_pair (org_id, code) where status in ('pending','awaiting_admin','approved');

create function pulse.companion_pairing_approval() returns text language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select body->>'pairing_approval' from tenant_config where org_id=current_org() and doc_kind='tenant'
  and doc_key='companion' and is_active and body->>'pairing_approval' in ('self','admin')),'self')
$$;

-- Rows are kept a day past their expiry (a request awaiting an admin expires 24 h after the person's approval).
create or replace function pulse.native_pair_start(c text, ph text, plat text, nm text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare nid uuid;begin
 delete from pulse_priv.native_pair where org_id=current_org() and expires_at<now()-interval '1 day';
 if (select count(*) from pulse_priv.native_pair where org_id=current_org() and status='pending' and expires_at>now())>=200 then
  raise exception 'Too many sign-ins are waiting. Try again in a few minutes.' using errcode='54000';end if;
 insert into pulse_priv.native_pair(org_id,code,poll_hash,platform,name) values(current_org(),c,ph,plat,nm) returning id into nid;return nid;end $$;

-- The device for the request's person; the 10-minute collection window starts at this approval.
create function pulse.native_pair_issue(pid uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare p pulse_priv.native_pair%rowtype;dev uuid;begin
 select * into p from pulse_priv.native_pair where org_id=current_org() and id=pid;
 insert into native_device(org_id,person_id,name,platform) values(current_org(),p.person_id,p.name,p.platform) returning id into dev;
 update pulse_priv.native_pair set status='approved',decided_at=now(),device_id=dev where id=p.id;
 perform auth_event_add('staff',p.person_id,'native_paired',p.platform||' · '||p.name);
 return jsonb_build_object('status','approved','deviceId',dev,'platform',p.platform,'name',p.name);end $$;

create or replace function pulse.native_pair_decide(c text, approve boolean) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare p pulse_priv.native_pair%rowtype;begin
 if current_viewer() is null or not native_is_staff()
 or exists(select 1 from login_credential where person_id=current_viewer() and (must_change or status<>'active')) then
  raise exception 'Sign in with your own active Pulse account to connect an app' using errcode='42501';end if;
 select * into p from pulse_priv.native_pair where org_id=current_org() and code=c and status='pending' for update;
 if p.id is null or p.expires_at<=now() then raise exception 'This code has expired. Start again in the app.' using errcode='P0002';end if;
 if not approve then update pulse_priv.native_pair set status='denied',decided_at=now(),person_id=current_viewer() where id=p.id;return jsonb_build_object('status','denied');end if;
 if companion_pairing_approval()='admin' then
  update pulse_priv.native_pair set status='awaiting_admin',decided_at=now(),expires_at=now()+interval '24 hours',person_id=current_viewer() where id=p.id;
  perform auth_event_add('staff',current_viewer(),'native_pair_awaiting_admin',p.platform||' · '||p.name);
  return jsonb_build_object('status','awaiting_admin','platform',p.platform,'name',p.name);end if;
 update pulse_priv.native_pair set person_id=current_viewer() where id=p.id;
 return native_pair_issue(p.id);end $$;

create function pulse.native_pair_awaiting() returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or not viewer_is('admin') then raise exception 'New devices are approved by organisation admins' using errcode='42501';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('code',a.code,'platform',a.platform,'name',a.name,
   'person',jsonb_build_object('id',a.person_id,'name',p.display_name),'requestedAt',a.created_at) order by a.created_at)
  from pulse_priv.native_pair a join person p on p.org_id=a.org_id and p.id=a.person_id
  where a.org_id=current_org() and a.status='awaiting_admin' and a.expires_at>now()),'[]'::jsonb);end $$;

create function pulse.native_pair_admin_decide(c text, approve boolean) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare p pulse_priv.native_pair%rowtype;begin
 if current_viewer() is null or not viewer_is('admin') or not native_is_staff() then
  raise exception 'New devices are approved by organisation admins' using errcode='42501';end if;
 select * into p from pulse_priv.native_pair where org_id=current_org() and code=c and status='awaiting_admin' for update;
 if p.id is null or p.expires_at<=now() then raise exception 'No device is waiting for approval with this code' using errcode='P0002';end if;
 update pulse_priv.native_pair set admin_id=current_viewer() where id=p.id;
 if not approve then update pulse_priv.native_pair set status='denied',decided_at=now() where id=p.id;return jsonb_build_object('status','denied');end if;
 return native_pair_issue(p.id);end $$;

create or replace function pulse.native_pair_redeem(pid uuid, ph text, ah text, rh text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare p pulse_priv.native_pair%rowtype;who text;begin
 select * into p from pulse_priv.native_pair where org_id=current_org() and id=pid for update;
 if p.id is null or p.poll_hash<>ph then return jsonb_build_object('status','unknown');end if;
 if p.status in ('pending','awaiting_admin') and p.expires_at<=now() then return jsonb_build_object('status','expired');end if;
 if p.status<>'approved' then return jsonb_build_object('status',case when p.status='redeemed' then 'expired' else p.status end);end if;
 if p.decided_at<now()-interval '10 minutes' then update pulse_priv.native_pair set status='denied' where id=p.id;return jsonb_build_object('status','expired');end if;
 perform auth_lock('staff',p.person_id);
 if not exists(select 1 from native_device where org_id=current_org() and id=p.device_id and person_id=p.person_id and revoked_at is null)
 or not exists(select 1 from person where org_id=current_org() and id=p.person_id and status='active' and side='staff')
 or exists(select 1 from login_credential where person_id=p.person_id and (must_change or status<>'active')) then
  update pulse_priv.native_pair set status='denied' where id=p.id;return jsonb_build_object('status','denied');end if;
 insert into pulse_priv.native_token(org_id,person_id,device_id,access_hash,refresh_hash) values(current_org(),p.person_id,p.device_id,ah,rh);
 update pulse_priv.native_pair set status='redeemed',redeemed_at=now() where id=p.id;
 select display_name into who from person where org_id=current_org() and id=p.person_id;
 return jsonb_build_object('status','approved','deviceId',p.device_id,'personId',p.person_id,'name',who);end $$;

-- The phone shell (0136) approves its own request; in admin mode it waits for the admin like any other device and is
-- not bound to the web session (that binding needs the device, which exists only after the admin's approval).
create or replace function pulse.native_shell_enroll(c text,h text,replaces uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a uuid:=current_viewer(); p pulse_priv.native_pair%rowtype; d jsonb; dev uuid; old uuid;
begin
 if a is null then raise exception 'Sign in to Pulse on this phone first' using errcode='42501';end if;
 select * into p from pulse_priv.native_pair where org_id=current_org() and code=c and status='pending';
 if p.id is not null and p.platform not in ('android','ios') then
  raise exception 'Only the Pulse phone app registers itself this way' using errcode='42501';end if;
 select native_device_id into old from login_session
  where org_id=current_org() and token_hash=h and person_id=a and revoked_at is null and expires_at>now();
 if not found then raise exception 'Sign in to Pulse on this phone first' using errcode='42501';end if;
 -- The same checks and audit event as approving a code on the Pulse site (expiry, own active account, staff only).
 d:=native_pair_decide(c,true);
 if d->>'status'<>'approved' then return d;end if;
 dev:=(d->>'deviceId')::uuid;
 update native_device set shell=true where org_id=current_org() and id=dev;
 -- One device per signed-in phone app: registering again (a new install, cleared data) replaces the earlier entry.
 for old in select x from unnest(array[old,replaces]) x where x is not null and x<>dev loop
  if exists(select 1 from native_device where org_id=current_org() and id=old and person_id=a and shell and revoked_at is null) then
   update pulse_priv.native_token set revoked_at=now() where org_id=current_org() and device_id=old and revoked_at is null;
   update native_device set revoked_at=now(),paused=true,purposes='{}',push_token=null,consent_epoch=gen_random_uuid() where org_id=current_org() and id=old;
  end if;
 end loop;
 update login_session set native_device_id=dev where org_id=current_org() and token_hash=h;
 return d;
end $$;

revoke all on function pulse.companion_pairing_approval(), pulse.native_pair_issue(uuid), pulse.native_pair_awaiting(),
 pulse.native_pair_admin_decide(text,boolean) from public;
grant execute on function pulse.companion_pairing_approval(), pulse.native_pair_awaiting(), pulse.native_pair_admin_decide(text,boolean) to pulse_api;

-- migrate:down
-- Forward-only.
