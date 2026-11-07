-- migrate:up
-- R15d, Pulse app 1.0 (9 Oct 2026).

-- 1. The Pulse window: a paired computer's device credential becomes a Pulse web session for that window only.
-- The session is tied to its device, so revoking the device (Settings → Devices, sign-out) also ends the window's
-- session. One live window session per device; issuing a new one ends the previous one.
alter table pulse.login_session add column native_device_id uuid references pulse.native_device(id) on delete set null;
create index login_session_native_device on pulse.login_session(native_device_id) where native_device_id is not null and revoked_at is null;
create function pulse.native_web_session(dev uuid,h text,d text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a uuid:=current_viewer(); result jsonb;
begin
 if a is null or not exists(select 1 from native_device where org_id=current_org() and id=dev and person_id=a and revoked_at is null and platform in ('windows','macos')) then
  raise exception 'This computer cannot open a Pulse window' using errcode='42501';
 end if;
 perform auth_lock('staff',a);
 update login_session set revoked_at=now() where org_id=current_org() and person_id=a and native_device_id=dev and revoked_at is null;
 result:=auth_session('staff',a,h,true,d);
 if result is null then return null;end if;
 update login_session set native_device_id=dev where org_id=current_org() and token_hash=h;
 return result;
end $$;
revoke all on function pulse.native_web_session(uuid,text,text) from public;
grant execute on function pulse.native_web_session(uuid,text,text) to pulse_api;
create or replace function pulse.native_token_revoke(dev uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin if not exists(select 1 from native_device where org_id=current_org() and id=dev and person_id=current_viewer()) then raise exception 'Your device required' using errcode='42501';end if;
 update pulse_priv.native_token set revoked_at=now() where org_id=current_org() and device_id=dev;
 update login_session set revoked_at=now() where org_id=current_org() and native_device_id=dev and revoked_at is null;
end $$;

-- 2. Feedback from the apps (text and an optional screenshot) lands in Pulse for the team.
create table pulse.app_feedback (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id), device_id uuid references pulse.native_device(id) on delete set null,
 platform text not null check(platform in ('windows','macos','android','ios','chrome','web')),
 app_version text not null default '' check(length(app_version)<=40), page text not null default '' check(length(page)<=80),
 body text not null check(length(btrim(body)) between 1 and 4000),
 screenshot bytea check(screenshot is null or length(screenshot)<=4194304),
 screenshot_type text check(screenshot_type in ('image/png','image/jpeg','image/webp')),
 status text not null default 'new' check(status in ('new','seen','done')),
 handled_by uuid references pulse.person(id), handled_at timestamptz,
 created_at timestamptz not null default now()
);
create index app_feedback_recent on pulse.app_feedback(org_id,created_at desc);
alter table pulse.app_feedback enable row level security;
alter table pulse.app_feedback force row level security;
create policy tenant_isolation on pulse.app_feedback using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
-- People see and send their own feedback; the app team (admin, leadership) reads and triages all of it.
create policy own_or_team on pulse.app_feedback as restrictive to pulse_api using(person_id=pulse.current_viewer() or pulse.viewer_is('admin','leadership'))
 with check(person_id=pulse.current_viewer() or pulse.viewer_is('admin','leadership'));
grant select,insert on pulse.app_feedback to pulse_api;
grant update(status,handled_by,handled_at) on pulse.app_feedback to pulse_api;
create function pulse.app_feedback_announce() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 insert into notification(org_id,person_id,title,href)
 select distinct new.org_id,r.person_id,'New Pulse app feedback ('||new.platform||')','/settings?tab=testers'
 from role_assignment r join person p on p.id=r.person_id and p.status='active'
 where r.org_id=new.org_id and r.role_key in ('admin','leadership') and current_date between r.valid_from and coalesce(r.valid_to,'infinity') and r.person_id<>new.person_id;
 return null;
end $$;
revoke all on function pulse.app_feedback_announce() from public;
create trigger app_feedback_announce after insert on pulse.app_feedback for each row execute function pulse.app_feedback_announce();

-- 3. Testers before the stores: who was invited to try which apps.
create table pulse.app_tester (
 org_id uuid not null references pulse.org(id), person_id uuid not null references pulse.person(id),
 platforms text[] not null default '{}' check(platforms <@ array['windows','macos','android','ios','chrome']::text[]),
 note text not null default '' check(length(note)<=200),
 invited_by uuid references pulse.person(id), invited_at timestamptz not null default now(),
 primary key(org_id,person_id)
);
alter table pulse.app_tester enable row level security;
alter table pulse.app_tester force row level security;
create policy tenant_isolation on pulse.app_tester using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy own_or_team on pulse.app_tester as restrictive to pulse_api using(person_id=pulse.current_viewer() or pulse.viewer_is('admin','leadership'))
 with check(pulse.viewer_is('admin','leadership'));
grant select,insert,update,delete on pulse.app_tester to pulse_api;

-- 4. Devices & tracking health for admin and leadership: which apps each person has connected, whether attendance
-- from the app works, whether optional work-activity collection is on and why not, and the last event time.
-- Counts and times only; never activity contents, locations or messages.
create function pulse.device_health() returns table(person_id uuid,person_name text,device_id uuid,device_name text,platform text,app_version text,
 last_seen timestamptz,health text,capabilities jsonb,created_at timestamptz,last_attendance timestamptz,purposes text[],paused boolean,
 notice_published boolean,last_event timestamptz,events_7d int,presence_consent boolean,presence_auto boolean,push_ready boolean)
language plpgsql stable security definer set search_path=pulse,pg_temp as $$
#variable_conflict use_column
begin
 if not viewer_is('admin','leadership') then raise exception 'Devices & tracking health is for admin and leadership' using errcode='42501';end if;
 return query
 select d.person_id,p.display_name,d.id,d.name,d.platform,d.app_version,d.last_seen,d.health,coalesce(d.capabilities,'{}'::jsonb),d.created_at,
  (select max(greatest(e.checked_in_at,coalesce(e.checked_out_at,e.checked_in_at))) from attendance_entry e where e.org_id=d.org_id and e.person_id=d.person_id and (e.client->>'device'=d.id::text or e.out_client->>'device'=d.id::text)),
  d.purposes,d.paused,
  exists(select 1 from jsonb_array_elements(coalesce((fair_collection())->'notices','[]'::jsonb))),
  (select max(x.received_at) from native_event x where x.device_id=d.id),
  (select count(*)::int from native_event x where x.device_id=d.id and x.received_at>now()-interval '7 days'),
  coalesce((select s.consent from companion_presence s where s.device_id=d.id),false),
  coalesce((select s.auto_consent from companion_presence s where s.device_id=d.id),false),
  d.push_token is not null or d.platform in ('windows','macos','chrome')
 from native_device d join person p on p.id=d.person_id and p.org_id=d.org_id
 where d.org_id=current_org() and d.revoked_at is null
 order by p.display_name,d.last_seen desc nulls last;
end $$;
revoke all on function pulse.device_health() from public;
grant execute on function pulse.device_health() to pulse_api;

-- 5. Test offices: an office with a named audience applies only to those people (for example the owner's test
-- office), so presence can be tried on real laptops and phones without affecting anyone else.
alter table pulse.presence_office add column audience uuid[];
-- Laptops report office Wi-Fi too; their automatic check-ins say so. The released presence engine is patched in
-- place (as 0129/0130 do), so earlier fixes are kept; each patch must apply or the migration stops.
do $$ declare s text; before text;
begin
 s:=pg_get_functiondef('pulse.companion_presence_tick(uuid)'::regprocedure);
 before:=s;
 s:=replace(s,'if r.office_id is null or not exists(select 1 from presence_office where id=r.office_id and active) then continue;end if;',
  'if r.office_id is null or not exists(select 1 from presence_office where id=r.office_id and active and (audience is null or r.person_id=any(audience))) then continue;end if;');
 if s=before then raise exception 'presence tick: test office audience patch did not apply';end if;
 before:=s;
 s:=replace(s,'if e.id is null and pol.presence_auto_checkin and r.auto_consent and score>=65',
  'if e.id is null and (pol.presence_auto_checkin or exists(select 1 from presence_office where id=r.office_id and audience is not null)) and r.auto_consent and score>=65');
 if s=before then raise exception 'presence tick: test office auto check-in patch did not apply';end if;
 before:=s;
 s:=replace(s,'jsonb_build_object(''via'',''mobile'',''trigger'',''auto''',
  'jsonb_build_object(''via'',(select case when platform in (''windows'',''macos'') then ''desktop'' when platform=''chrome'' then ''chrome'' else ''mobile'' end from native_device where id=r.device_id),''trigger'',''auto''');
 if s=before then raise exception 'presence tick: device kind patch did not apply';end if;
 before:=s;
 s:=replace(s,'values(r.org_id,r.person_id,''You’re checked in · office presence confirmed'',''/me'');',
  'values(r.org_id,r.person_id,case when (select platform from native_device where id=r.device_id) in (''windows'',''macos'') then ''You’re checked in · your laptop is at the office'' else ''You’re checked in · office presence confirmed'' end,''/me'');');
 if s=before then raise exception 'presence tick: laptop check-in message patch did not apply';end if;
 execute s;
end $$;

-- migrate:down
-- Retain feedback, testers and session links if the application rolls back.
