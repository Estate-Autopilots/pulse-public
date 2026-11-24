-- migrate:up
-- FIX-LIVE-2 (19 Nov 2026, BUG-CENSUS BC-137; also behind BC-138). The Pulse phone app could be registered by EA's
-- people only. The app is the web app in a shell on the shared address (app.vitalsos.ai). Its own requests carry no
-- company: asking for a pairing code, collecting its credential, refreshing it, and its background checks. So they ran
-- in the address's company, which is the install's own (EA). On 17 Nov 15:50Z a Willow Lane person signed in inside the
-- app. At 15:50:09.432 the app's code was filed under EA. At .742 the page approved it in Willow Lane, where the code
-- did not exist, and got "This code has expired. Start again in the app." (404). The same happens to anyone outside
-- EA, every time: no device, no call push, no background presence.
--
-- 1. native_shell_enroll: when the signed-in page registers its own phone app and the app's code is not in the
--    person's company, the code moves there from the install's company. It must still be pending, unexpired, and
--    from a phone (android/ios). Only the shell's own enrol does this: a code typed on the site is unchanged.
-- 2. native_credential_org and native_pair_org: which company a device credential (access or refresh), or a pairing
--    request (id plus poll secret), belongs to. The API then runs the app's own requests there, as session_org,
--    agent_key_org and v1_token_org do for theirs. They answer only to the holder of the secret, and they name only
--    the company. They look company by company under row security, as 2399's sign-in code does (no new policy), and
--    put the request's company back before returning. They are called only for a request with no company of its own.
create or replace function pulse.native_shell_enroll(c text,h text,replaces uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a uuid:=current_viewer(); here uuid:=current_org(); home uuid:=install_org(); p pulse_priv.native_pair%rowtype; d jsonb; dev uuid; old uuid;
begin
 if a is null then raise exception 'Sign in to Pulse on this phone first' using errcode='42501';end if;
 select native_device_id into old from login_session
  where org_id=here and token_hash=h and person_id=a and revoked_at is null and expires_at>now();
 if not found then raise exception 'Sign in to Pulse on this phone first' using errcode='42501';end if;
 select * into p from pulse_priv.native_pair where org_id=here and code=c and status='pending';
 -- FIX-LIVE-2: the app asked for its code on the shared address, which filed it under the install's company.
 if p.id is null and home is not null and home<>here
 and not exists(select 1 from pulse_priv.native_pair where org_id=here and code=c and status in ('awaiting_admin','approved')) then
  perform set_config('pulse.org_id',home::text,true);
  delete from pulse_priv.native_pair where org_id=home and code=c and status='pending' and expires_at>now() and platform in ('android','ios')
   returning * into p;
  perform set_config('pulse.org_id',here::text,true);
  if p.id is not null then p.org_id:=here; insert into pulse_priv.native_pair select (p).*; end if;
 end if;
 if p.id is not null and p.platform not in ('android','ios') then
  raise exception 'Only the Pulse phone app registers itself this way' using errcode='42501';end if;
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

create function pulse.native_credential_org(p_hash text) returns table(org_id uuid, status text, rehearsal boolean)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare was text:=current_setting('pulse.org_id',true); o uuid; hit uuid;
begin
 if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then return;end if;
 for o in select x.id from org x where x.status='active' order by x.id is distinct from install_org(), x.id loop
  perform set_config('pulse.org_id',o::text,true);
  if exists(select 1 from pulse_priv.native_token t where t.org_id=o and (t.access_hash=p_hash or t.refresh_hash=p_hash)) then hit:=o;exit;end if;
 end loop;
 perform set_config('pulse.org_id',coalesce(was,''),true);
 return query select x.id,x.status,x.rehearsal from org x where x.id=hit;
end $$;

create function pulse.native_pair_org(p_id uuid, p_poll text) returns table(org_id uuid, status text, rehearsal boolean)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare was text:=current_setting('pulse.org_id',true); o uuid; hit uuid;
begin
 if p_id is null or p_poll is null or p_poll !~ '^[0-9a-f]{64}$' then return;end if;
 for o in select x.id from org x where x.status='active' order by x.id is distinct from install_org(), x.id loop
  perform set_config('pulse.org_id',o::text,true);
  if exists(select 1 from pulse_priv.native_pair n where n.org_id=o and n.id=p_id and n.poll_hash=p_poll) then hit:=o;exit;end if;
 end loop;
 perform set_config('pulse.org_id',coalesce(was,''),true);
 return query select x.id,x.status,x.rehearsal from org x where x.id=hit;
end $$;
revoke all on function pulse.native_credential_org(text), pulse.native_pair_org(uuid,text) from public;
grant execute on function pulse.native_credential_org(text), pulse.native_pair_org(uuid,text) to pulse_api;

-- migrate:down
-- Forward-only.
