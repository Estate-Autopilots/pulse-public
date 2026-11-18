-- migrate:up
-- EST-1397 / frozen rc.1 §3: sign-in and quiet attempts have no session yet. State and browser cookie are hashed, used
-- once and live 10 minutes; the nonce and PKCE verifier stay server-side.
create table pulse_priv.google_auth_attempt(org_id uuid not null references pulse.org(id),state_hash text primary key check(state_hash~'^[a-f0-9]{64}$'),
 cookie_hash text not null check(cookie_hash~'^[a-f0-9]{64}$'),nonce text not null,verifier text not null,mode text not null check(mode in('signin','silent')),
 next text not null check(next~'^/' and length(next)<=2000),expires_at timestamptz not null default now()+interval '10 minutes');
alter table pulse_priv.google_auth_attempt enable row level security;
alter table pulse_priv.google_auth_attempt force row level security;
create policy tenant on pulse_priv.google_auth_attempt using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
alter table pulse_priv.auth_challenge add column via text not null default 'password' check(via in('password','google'));
create function pulse.google_auth_attempt(op text,b jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a pulse_priv.google_auth_attempt%rowtype;
begin
 if op='begin' then
  delete from pulse_priv.google_auth_attempt where org_id=current_org() and expires_at<=now();
  insert into pulse_priv.google_auth_attempt(org_id,state_hash,cookie_hash,nonce,verifier,mode,next) values(current_org(),b->>'stateHash',b->>'cookieHash',b->>'nonce',b->>'verifier',b->>'mode',b->>'next');
  return jsonb_build_object('ok',true);
 elsif op<>'take' then raise exception 'Invalid sign-in action' using errcode='22023';end if;
 delete from pulse_priv.google_auth_attempt where org_id=current_org() and state_hash=b->>'stateHash' and cookie_hash=b->>'cookieHash' and expires_at>clock_timestamp() returning * into a;
 if not found then return jsonb_build_object('error','state_invalid');end if;
 return jsonb_build_object('nonce',a.nonce,'verifier',a.verifier,'mode',a.mode,'next',a.next);
end $$;
-- After the verifier: the password path's 12 h session (or its 2-step challenge) for a linked active person, as Google.
-- Trust Google 2-step ships off (owner, EST-1787): Pulse 2-step applies whatever google_settings says.
create function pulse.google_sign_in(iss text,sub text,challenge_hash text,session_hash text,d text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r jsonb:=google_identity_resolve(iss,sub);a uuid:=(r->>'personId')::uuid;result jsonb;pol pulse_priv.auth_policy%rowtype;
begin
 if a is null then return r;end if;
 perform auth_lock('staff',a);r:=google_identity_resolve(iss,sub,true);
 if r ? 'error' then return r;end if;
 if exists(select 1 from pulse_priv.auth_account where org_id=current_org() and realm='staff' and actor=a and totp is not null) then
  insert into pulse_priv.auth_challenge values(current_org(),'staff',a,challenge_hash,now()+interval '5 minutes',false,left(d,120),null,'google');
  perform auth_event_add('staff',a,'two_step_challenge',d);return jsonb_build_object('twoStep',true);
 end if;
 result:=auth_session('staff',a,session_hash,false,d);
 if result is null then return jsonb_build_object('error','account_disabled');end if;
 update login_session set via='google' where org_id=current_org() and person_id=a and token_hash=session_hash;
 select * into pol from pulse_priv.auth_policy where org_id=current_org();
 if pol.required and a is distinct from pol.exempt_owner and exists(select 1 from role_assignment where org_id=current_org() and person_id=a and role_key in('admin','hr','leadership') and current_date between valid_from and coalesce(valid_to,'infinity')) then
  result:=result||jsonb_build_object('enrollmentRequired',true,'graceUntil',pol.grace_until);
 end if;
 return result||jsonb_build_object('actor',a,'delivery',auth_delivery('staff',a));
end $$;
-- 0137's finish, plus: a session finished from a Google challenge is recorded as Google.
create or replace function pulse.auth_challenge_finish(r text,h text,code text,session_hash text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare ch pulse_priv.auth_challenge%rowtype; result jsonb;
begin
 select actor into ch.actor from pulse_priv.auth_challenge where org_id=current_org() and realm=r and hash=h;
 if ch.actor is not null then perform auth_lock(r,ch.actor);end if;
 select * into ch from pulse_priv.auth_challenge where org_id=current_org() and realm=r and hash=h and expires_at>now() and used_at is null for update;
 if not found then return null;end if;
 -- Unlink and policy changes must also invalidate a Google challenge that has not issued a session yet.
 if ch.via='google' and not exists(select 1 from pulse_priv.google_identity i join pulse_priv.google_settings s using(org_id)
  where i.org_id=current_org() and i.person_id=ch.actor and s.enabled and i.domain=any(s.allowed_domains)) then return null;end if;
 if not auth_allow('otp:'||r||':'||ch.actor,5) or not auth_otp(r,ch.actor,code) then perform auth_event_add(r,ch.actor,'two_step_failed');return null;end if;
 update pulse_priv.auth_challenge set used_at=now() where hash=h;
 result:=auth_session(r,ch.actor,session_hash,ch.remember,ch.device);
 if r='staff' and result is not null then
 update login_session set second_factor_verified=true,via=ch.via where org_id=current_org() and person_id=ch.actor and token_hash=session_hash;
 end if;
 return result||jsonb_build_object('actor',ch.actor,'delivery',auth_delivery(r,ch.actor));
end $$;
revoke all on function pulse.google_auth_attempt(text,jsonb),pulse.google_sign_in(text,text,text,text,text) from public;
grant execute on function pulse.google_auth_attempt(text,jsonb),pulse.google_sign_in(text,text,text,text,text) to pulse_api;
-- migrate:down
create or replace function pulse.auth_challenge_finish(r text,h text,code text,session_hash text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare ch pulse_priv.auth_challenge%rowtype; result jsonb;
begin
 select actor into ch.actor from pulse_priv.auth_challenge where org_id=current_org() and realm=r and hash=h;
 if ch.actor is not null then perform auth_lock(r,ch.actor);end if;
 select * into ch from pulse_priv.auth_challenge where org_id=current_org() and realm=r and hash=h and expires_at>now() and used_at is null for update;
 if not found then return null;end if;
 if not auth_allow('otp:'||r||':'||ch.actor,5) or not auth_otp(r,ch.actor,code) then perform auth_event_add(r,ch.actor,'two_step_failed');return null;end if;
 update pulse_priv.auth_challenge set used_at=now() where hash=h;
 result:=auth_session(r,ch.actor,session_hash,ch.remember,ch.device);
 if r='staff' and result is not null then
 update login_session set second_factor_verified=true where org_id=current_org() and person_id=ch.actor and token_hash=session_hash;
 end if;
 return result||jsonb_build_object('actor',ch.actor,'delivery',auth_delivery(r,ch.actor));
end $$;
drop function pulse.google_sign_in(text,text,text,text,text),pulse.google_auth_attempt(text,jsonb);
alter table pulse_priv.auth_challenge drop column via;
drop table pulse_priv.google_auth_attempt;
