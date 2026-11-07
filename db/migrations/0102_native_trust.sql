-- migrate:up
-- Extend the inspected native track: self-only receipts, bound device credentials and honest capture windows.
alter table pulse.native_device add column paused boolean not null default true;
alter table pulse.native_device add column health text not null default 'unknown';
alter table pulse.native_device add column app_version text not null default '';
alter table pulse.native_device add column last_seen timestamptz;
alter table pulse.native_device add column consent_epoch uuid not null default gen_random_uuid();
alter table pulse.native_event add column consent_receipt uuid;
alter table pulse.native_event add column source_session uuid;
alter table pulse.native_event add column source_sequence bigint;
alter table pulse.native_event add column interval_start timestamptz;
alter table pulse.native_event add column state text not null default 'personal';
alter table pulse.native_event add column correction text;
create unique index native_source_identity on pulse.native_event(device_id,source_session,source_sequence);
create table pulse.native_permission (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),person_id uuid not null references pulse.person(id),device_id uuid not null references pulse.native_device(id),
 notice_id uuid not null references pulse_priv.fair_notice(id),purpose text not null,epoch uuid not null,kind text not null check(kind in('grant','withdraw')),at timestamptz not null default now()
);
create table pulse.native_window (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),person_id uuid not null references pulse.person(id),device_id uuid not null references pulse.native_device(id),
 epoch uuid not null,starts_at timestamptz not null default now(),ends_at timestamptz not null,check(ends_at>starts_at and ends_at<=starts_at+interval '24 hours')
);
create table pulse.native_ack (
 org_id uuid not null references pulse.org(id),person_id uuid not null references pulse.person(id),device_id uuid not null references pulse.native_device(id),source_session uuid not null,source_sequence bigint not null,
 event_id uuid not null,canonical_id uuid not null,payload_hash text not null,primary key(device_id,source_session,source_sequence),unique(event_id)
);
create table pulse.native_batch (
 org_id uuid not null references pulse.org(id),person_id uuid not null references pulse.person(id),device_id uuid not null references pulse.native_device(id),id uuid primary key,payload_hash text not null,ack jsonb not null
);
-- Tokens never persist in plaintext. Access 15 min, refresh 30 days, each refresh rotated once.
create table pulse_priv.native_token (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),person_id uuid not null references pulse.person(id),device_id uuid not null references pulse.native_device(id),
 access_hash text not null unique,refresh_hash text not null unique,access_until timestamptz not null default now()+interval '15 minutes',refresh_until timestamptz not null default now()+interval '30 days',
 family uuid not null default gen_random_uuid(),used_at timestamptz,revoked_at timestamptz,at timestamptz not null default now()
);
alter table pulse_priv.native_token enable row level security;alter table pulse_priv.native_token force row level security;
create policy tenant on pulse_priv.native_token using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
do $$declare t text;begin foreach t in array array['native_permission','native_window','native_ack','native_batch'] loop
 execute format('alter table pulse.%I enable row level security',t);execute format('alter table pulse.%I force row level security',t);
 execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('create policy own on pulse.%I as restrictive to pulse_api using(person_id=pulse.current_viewer()) with check(person_id=pulse.current_viewer())',t);
 execute format('grant select,insert,update on pulse.%I to pulse_api',t);
 end loop;end $$;
create function pulse.native_token_issue(dev uuid,ah text,rh text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare nid uuid;begin
 if current_viewer() is null or not exists(select 1 from native_device where org_id=current_org() and id=dev and person_id=current_viewer() and revoked_at is null)
 or exists(select 1 from login_credential where person_id=current_viewer() and (must_change or status<>'active')) then raise exception 'Individual active account and password change required' using errcode='42501';end if;
 insert into pulse_priv.native_token(org_id,person_id,device_id,access_hash,refresh_hash) values(current_org(),current_viewer(),dev,ah,rh) returning id into nid;return nid;end $$;
create function pulse.native_token_resolve(ah text) returns table(person_id uuid,device_id uuid) language sql security definer set search_path=pulse,pg_temp as $$
 select t.person_id,t.device_id from pulse_priv.native_token t join native_device d on d.id=t.device_id and d.org_id=t.org_id join person p on p.id=t.person_id and p.org_id=t.org_id
 where t.org_id=current_org() and t.access_hash=ah and t.access_until>now() and t.revoked_at is null and t.used_at is null and d.revoked_at is null and p.status='active'
 and not exists(select 1 from login_credential l where l.person_id=t.person_id and (l.must_change or l.status<>'active'))
$$;
create function pulse.native_token_rotate(rh text,ah text,nrh text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t pulse_priv.native_token%rowtype;begin
 select * into t from pulse_priv.native_token where org_id=current_org() and refresh_hash=rh for update;
 if t.id is null then return null;end if;
 if t.used_at is not null then update pulse_priv.native_token set revoked_at=now() where org_id=current_org() and family=t.family;return null;end if;
 if t.revoked_at is not null or t.refresh_until<=now() or not exists(select 1 from native_device where org_id=current_org() and id=t.device_id and revoked_at is null) or not exists(select 1 from person where org_id=current_org() and id=t.person_id and status='active') or exists(select 1 from login_credential where person_id=t.person_id and (must_change or status<>'active')) then return null;end if;
 update pulse_priv.native_token set used_at=now() where id=t.id;
 insert into pulse_priv.native_token(org_id,person_id,device_id,access_hash,refresh_hash,refresh_until,family) values(t.org_id,t.person_id,t.device_id,ah,nrh,t.refresh_until,t.family);
 return jsonb_build_object('personId',t.person_id,'deviceId',t.device_id);end $$;
create function pulse.native_token_revoke(dev uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin if not exists(select 1 from native_device where org_id=current_org() and id=dev and person_id=current_viewer()) then raise exception 'Your device required' using errcode='42501';end if;update pulse_priv.native_token set revoked_at=now() where org_id=current_org() and device_id=dev;end $$;
revoke all on function pulse.native_token_issue(uuid,text,text),pulse.native_token_resolve(text),pulse.native_token_rotate(text,text,text),pulse.native_token_revoke(uuid) from public;
grant execute on function pulse.native_token_issue(uuid,text,text),pulse.native_token_resolve(text),pulse.native_token_rotate(text,text,text),pulse.native_token_revoke(uuid) to pulse_api;
-- Attendance controls also stop optional sources; clients observe paused state at their next handshake.
create function pulse.native_attendance_stop() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare stop_capture boolean:=false;
begin
 if TG_TABLE_NAME='attendance_break' then stop_capture:=true;elsif new.checked_out_at is not null then stop_capture:=true;end if;
 if stop_capture then
 update native_device set paused=true,consent_epoch=gen_random_uuid() where org_id=new.org_id and person_id=new.person_id;
 update native_window set ends_at=greatest(starts_at+interval '1 microsecond',least(ends_at,now())) where org_id=new.org_id and person_id=new.person_id and ends_at>now();
 end if;return new;end $$;
create trigger native_break_stop after insert on pulse.attendance_break for each row execute function pulse.native_attendance_stop();
create trigger native_checkout_stop after update of checked_out_at on pulse.attendance_entry for each row execute function pulse.native_attendance_stop();
revoke all on function pulse.native_attendance_stop() from public;
-- Raw activity is personal first, including on the reused native count seam.
create or replace function pulse.native_counts(who uuid) returns jsonb language sql security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('events',count(*),'exports',count(*) filter(where kind='render'),'workLogs',0)
 from native_event e where e.org_id=current_org() and e.person_id=who and e.at>=now()-interval '7 days' and who=current_viewer()
$$;
create or replace function pulse.fair_notice_approve(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare nid uuid;begin perform fair_self();if not viewer_is('admin') then raise exception 'EA policy authority required' using errcode='42501';end if;
 if p->>'purpose' is distinct from 'optional_work_context' or length(trim(coalesce(p->>'version','')))<3 or jsonb_typeof(p->'dataItems') is distinct from 'array' or jsonb_array_length(p->'dataItems')=0 or exists(select 1 from jsonb_array_elements_text(p->'dataItems') i where i not in('work_app_category','focus_idle_aggregate','render_export_metadata','structural_edit_delta','authorized_project_id','explicit_shoot_wrap','shoot_presence_match','work_command_categories')) or jsonb_typeof(p->'apps') is distinct from 'array' or jsonb_typeof(p->'domains') is distinct from 'array' or jsonb_typeof(p->'workWindow') is distinct from 'object' or length(trim(coalesce(p->>'audience','')))<3 or length(trim(coalesce(p->>'rightsContact','')))<3 or length(trim(coalesce(p->>'withdrawalFlow','')))<3 or (p->>'rawDays')::int not between 1 and 60 or (p->>'derivedDays')::int not between 1 and 180 or p->>'rawDays' is null or p->>'derivedDays' is null or p->>'deletionTest' is distinct from 'passed' then raise exception 'Purpose notice allowlists retention rights withdrawal and deletion evidence required' using errcode='22023';end if;
 insert into pulse_priv.fair_notice(org_id,version,purpose,body,authority) values(current_org(),p->>'version',p->>'purpose',p,current_viewer()) returning id into nid;return nid;end $$;
create function pulse.native_password_stop() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin if (new.password_hash,new.status,new.must_change) is distinct from (old.password_hash,old.status,old.must_change) then
 update pulse_priv.native_token set revoked_at=now() where org_id=new.org_id and person_id=new.person_id;
 update native_device set paused=true,consent_epoch=gen_random_uuid() where org_id=new.org_id and person_id=new.person_id;
 end if;return new;end $$;
create trigger native_password_stop after update on pulse.login_credential for each row execute function pulse.native_password_stop();
revoke all on function pulse.native_password_stop() from public;
-- migrate:down
