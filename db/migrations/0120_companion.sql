-- migrate:up
-- Pulse Companion: office presence (HR-set office locations, radius and Wi-Fi), the client that recorded each
-- attendance action, and browser pairing for the desktop, phone and Chrome apps.
-- Location is never stored for a person: an action records which office or site and which signal, not coordinates.

-- Offices HR registers for geofence and Wi-Fi suggestions. Everyone in the organisation reads them; HR sets them.
create table pulse.presence_office (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 name text not null check (length(btrim(name)) between 1 and 80),
 lat double precision not null check (lat between -90 and 90), lng double precision not null check (lng between -180 and 180),
 radius_m int not null default 150 check (radius_m between 50 and 1000),
 wifi jsonb not null default '[]' check (jsonb_typeof(wifi) = 'array' and jsonb_array_length(wifi) <= 10),
 active boolean not null default true,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), updated_by uuid references pulse.person(id)
);
create index presence_office_org on pulse.presence_office (org_id) where active;
alter table pulse.presence_office enable row level security;
alter table pulse.presence_office force row level security;
create policy tenant_isolation on pulse.presence_office using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy hr_insert on pulse.presence_office as restrictive for insert to pulse_api with check (pulse.viewer_is('admin','hr'));
create policy hr_update on pulse.presence_office as restrictive for update to pulse_api using (pulse.viewer_is('admin','hr')) with check (pulse.viewer_is('admin','hr'));
create policy hr_delete on pulse.presence_office as restrictive for delete to pulse_api using (pulse.viewer_is('admin','hr'));
grant select, insert, update, delete on pulse.presence_office to pulse_api;
grant select on pulse.presence_office to pulse_worker;

-- HR's presence rules: automatic check-in stays off until HR turns it on (and each person still opts in on the phone).
alter table pulse.hr_policy
 add column presence_auto_checkin boolean not null default false,
 add column presence_sites boolean not null default true;
alter table pulse.record_change drop constraint if exists record_change_entity_type_check;
alter table pulse.record_change add constraint record_change_entity_type_check
 check (entity_type in ('person','client','contact','project','org','pod','role','hr_policy','leave_type','holiday','permission','presence_office'));

-- Which client recorded an action and why: { via, trigger, place: { kind, id, signal }, queueId, queued, recordedAt }.
alter table pulse.attendance_entry
 add column client jsonb check (client is null or (jsonb_typeof(client) = 'object' and pg_column_size(client) < 2048)),
 add column out_client jsonb check (out_client is null or (jsonb_typeof(out_client) = 'object' and pg_column_size(out_client) < 2048));
alter table pulse.attendance_break
 add column client jsonb check (client is null or (jsonb_typeof(client) = 'object' and pg_column_size(client) < 2048)),
 add column end_client jsonb check (end_client is null or (jsonb_typeof(end_client) = 'object' and pg_column_size(end_client) < 2048));

-- Browser pairing ("Sign in with your Pulse account"): the app shows a short code, the person approves it on the
-- Pulse site where they are already signed in, the app collects its device tokens once. Secrets are hashed.
create table pulse_priv.native_pair (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 code text not null check (code ~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'), poll_hash text not null check (length(poll_hash) = 64),
 platform text not null check (platform in ('ios','android','windows','macos','chrome')), name text not null check (length(name) between 1 and 80),
 status text not null default 'pending' check (status in ('pending','approved','denied','redeemed')),
 person_id uuid references pulse.person(id), device_id uuid references pulse.native_device(id),
 created_at timestamptz not null default now(), expires_at timestamptz not null default now() + interval '10 minutes',
 decided_at timestamptz, redeemed_at timestamptz
);
create unique index native_pair_code on pulse_priv.native_pair (org_id, code) where status in ('pending','approved');
alter table pulse_priv.native_pair enable row level security;
alter table pulse_priv.native_pair force row level security;
create policy tenant on pulse_priv.native_pair using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

create function pulse.native_pair_start(c text, ph text, plat text, nm text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare nid uuid;begin
 delete from pulse_priv.native_pair where org_id=current_org() and created_at<now()-interval '1 day';
 if (select count(*) from pulse_priv.native_pair where org_id=current_org() and status='pending' and expires_at>now())>=200 then
  raise exception 'Too many sign-ins are waiting. Try again in a few minutes.' using errcode='54000';end if;
 insert into pulse_priv.native_pair(org_id,code,poll_hash,platform,name) values(current_org(),c,ph,plat,nm) returning id into nid;return nid;end $$;

create function pulse.native_pair_peek(c text) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('platform',platform,'name',name,'createdAt',created_at,'expiresAt',expires_at) from pulse_priv.native_pair
 where org_id=current_org() and code=c and status='pending' and expires_at>now() and current_viewer() is not null
$$;

create function pulse.native_pair_decide(c text, approve boolean) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare p pulse_priv.native_pair%rowtype;dev uuid;begin
 if current_viewer() is null or not native_is_staff()
 or exists(select 1 from login_credential where person_id=current_viewer() and (must_change or status<>'active')) then
  raise exception 'Sign in with your own active Pulse account to connect an app' using errcode='42501';end if;
 select * into p from pulse_priv.native_pair where org_id=current_org() and code=c and status='pending' for update;
 if p.id is null or p.expires_at<=now() then raise exception 'This code has expired. Start again in the app.' using errcode='P0002';end if;
 if not approve then update pulse_priv.native_pair set status='denied',decided_at=now(),person_id=current_viewer() where id=p.id;return jsonb_build_object('status','denied');end if;
 insert into native_device(org_id,person_id,name,platform) values(current_org(),current_viewer(),p.name,p.platform) returning id into dev;
 update pulse_priv.native_pair set status='approved',decided_at=now(),person_id=current_viewer(),device_id=dev where id=p.id;
 perform auth_event_add('staff',current_viewer(),'native_paired',p.platform||' · '||p.name);
 return jsonb_build_object('status','approved','deviceId',dev,'platform',p.platform,'name',p.name);end $$;

create function pulse.native_pair_redeem(pid uuid, ph text, ah text, rh text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare p pulse_priv.native_pair%rowtype;who text;begin
 select * into p from pulse_priv.native_pair where org_id=current_org() and id=pid for update;
 if p.id is null or p.poll_hash<>ph then return jsonb_build_object('status','unknown');end if;
 if p.status='pending' and p.expires_at<=now() then return jsonb_build_object('status','expired');end if;
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

revoke all on function pulse.native_pair_start(text,text,text,text), pulse.native_pair_peek(text), pulse.native_pair_decide(text,boolean), pulse.native_pair_redeem(uuid,text,text,text) from public;
grant execute on function pulse.native_pair_start(text,text,text,text), pulse.native_pair_peek(text), pulse.native_pair_decide(text,boolean), pulse.native_pair_redeem(uuid,text,text,text) to pulse_api;

-- migrate:down
drop function if exists pulse.native_pair_redeem(uuid,text,text,text), pulse.native_pair_decide(text,boolean), pulse.native_pair_peek(text), pulse.native_pair_start(text,text,text,text);
drop table if exists pulse_priv.native_pair;
alter table pulse.attendance_break drop column if exists end_client, drop column if exists client;
alter table pulse.attendance_entry drop column if exists out_client, drop column if exists client;
alter table pulse.hr_policy drop column if exists presence_sites, drop column if exists presence_auto_checkin;
drop table if exists pulse.presence_office;
