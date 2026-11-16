-- migrate:up
-- ONBOARD (owner, 26 Oct 2026): one rule, the company Google account is the Pulse login. An invitation (HR's e-mail or
-- private link) to an address on one of the organisation's allowed Workspace domains offers Continue with Google: a
-- verified Google proof whose e-mail is exactly the invited address links that Google account and signs the person in,
-- with no Pulse password. The set-password path stays for everyone else (personal e-mail, or by choice).
--
-- The invitation token never travels in a URL: the set-password page posts it once (google_invite_peek), which hands
-- back a 15-minute ticket for this one Google attempt. Only the hashes of the ticket and the token are stored.
create table pulse_priv.google_invite_ticket(
 org_id uuid not null references pulse.org(id),
 ticket_hash text primary key check(ticket_hash~'^[a-f0-9]{64}$'),
 invite_hash text not null check(invite_hash~'^[a-f0-9]{64}$'),
 person_id uuid not null references pulse.person(id),
 email text not null check(length(email) between 3 and 254),
 expires_at timestamptz not null default now()+interval '15 minutes');
alter table pulse_priv.google_invite_ticket enable row level security;
alter table pulse_priv.google_invite_ticket force row level security;
create policy tenant on pulse_priv.google_invite_ticket using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create index google_invite_ticket_person on pulse_priv.google_invite_ticket(org_id,person_id);

-- A Google attempt started from an invitation carries its ticket (hash) from start to callback.
alter table pulse_priv.google_auth_attempt add column ticket_hash text check(ticket_hash~'^[a-f0-9]{64}$');
alter table pulse_priv.google_auth_attempt drop constraint google_auth_attempt_mode_check;
alter table pulse_priv.google_auth_attempt add constraint google_auth_attempt_mode_check check(mode in('signin','silent','invite') and (mode='invite')=(ticket_hash is not null));

create or replace function pulse.google_auth_attempt(op text,b jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a pulse_priv.google_auth_attempt%rowtype;
begin
 if op='begin' then
  delete from pulse_priv.google_auth_attempt where org_id=current_org() and expires_at<=now();
  insert into pulse_priv.google_auth_attempt(org_id,state_hash,cookie_hash,nonce,verifier,mode,next,ticket_hash) values(current_org(),b->>'stateHash',b->>'cookieHash',b->>'nonce',b->>'verifier',b->>'mode',b->>'next',nullif(b->>'ticketHash',''));
  return jsonb_build_object('ok',true);
 elsif op<>'take' then raise exception 'Invalid sign-in action' using errcode='22023';end if;
 delete from pulse_priv.google_auth_attempt where org_id=current_org() and state_hash=b->>'stateHash' and cookie_hash=b->>'cookieHash' and expires_at>clock_timestamp() returning * into a;
 if not found then return jsonb_build_object('error','state_invalid');end if;
 return jsonb_build_object('nonce',a.nonce,'verifier',a.verifier,'mode',a.mode,'next',a.next)||case when a.ticket_hash is null then '{}'::jsonb else jsonb_build_object('ticketHash',a.ticket_hash) end;
end $$;

-- The open invitation behind a token: HR's per-person invite link (auth_link kind 'invite', sent to the person's
-- delivery address) or the Onboard team batch (staff_invitation, its recipient), with that address. Nothing for a
-- used, expired or replaced link.
create function pulse.google_invite_open(h text) returns table(person_id uuid,email text) language sql stable security definer set search_path=pulse,pg_temp as $$
 select x.person_id,lower(trim(x.email)) from (
  select l.actor person_id,coalesce(nullif(l.delivery,''),auth_delivery('staff',l.actor)) email from pulse_priv.auth_link l where l.org_id=current_org() and l.realm='staff' and l.token_hash=h and l.kind='invite' and l.used_at is null and l.expires_at>now()
  union all
  select i.person_id,i.recipient from pulse_priv.staff_invitation i where i.org_id=current_org() and i.token_hash=h and i.status in('prepared','sent') and i.used_at is null and i.expires_at>now()) x
 join person p on p.id=x.person_id and p.org_id=current_org() and p.status='active' and p.side='staff'
 where coalesce(x.email,'')<>'' and not exists(select 1 from login_credential c where c.org_id=current_org() and c.person_id=x.person_id and c.status='disabled')
 limit 1
$$;

-- The set-password page asks once: is this an invitation, and may it use Google? Google is offered only while sign-in
-- with Google is on and the invited address is on an allowed domain; then a fresh ticket (hash) is kept for 15 minutes.
-- Unknown, used or expired tokens answer null (the page says the link is unavailable), with no detail.
create function pulse.google_invite_peek(h text,ticket text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare inv record;s pulse_priv.google_settings%rowtype;
begin
 if coalesce(h,'')!~'^[a-f0-9]{64}$' or coalesce(ticket,'')!~'^[a-f0-9]{64}$' then return null;end if;
 select * into inv from google_invite_open(h);
 if inv.person_id is null then return null;end if;
 select * into s from pulse_priv.google_settings where org_id=current_org();
 if s.enabled is distinct from true or not split_part(inv.email,'@',2)=any(s.allowed_domains) then return jsonb_build_object('google',false);end if;
 delete from pulse_priv.google_invite_ticket where org_id=current_org() and (expires_at<=now() or invite_hash=h);
 insert into pulse_priv.google_invite_ticket(org_id,ticket_hash,invite_hash,person_id,email) values(current_org(),ticket,h,inv.person_id,inv.email);
 return jsonb_build_object('google',true,'email',inv.email);
end $$;

-- The address Google's account chooser should pick (login_hint), while the ticket is live.
create function pulse.google_invite_hint(ticket text) returns text language sql stable security definer set search_path=pulse,pg_temp as $$
 select email from pulse_priv.google_invite_ticket where org_id=current_org() and ticket_hash=ticket and expires_at>now()
$$;

-- After the verifier (google-sign-in-flow.ts): the ticket is used up first, then the invitation must still be open and
-- the verified Google e-mail must be exactly the invited address on an allowed domain. Then Google is linked, the
-- invitation is used, an HR-issued temporary password stops working (a password the person chose stays), and the person
-- is signed in exactly as Continue with Google signs in a linked person (google_sign_in: Pulse 2-step still applies).
create function pulse.google_invite_accept(ticket text,proof jsonb,challenge_hash text,session_hash text,d text) returns jsonb language plpgsql security definer set search_path=pulse,public,pg_temp as $$
declare t pulse_priv.google_invite_ticket%rowtype;s pulse_priv.google_settings%rowtype;inv record;a uuid;
begin
 delete from pulse_priv.google_invite_ticket where org_id=current_org() and ticket_hash=ticket and expires_at>clock_timestamp() returning * into t;
 if not found then return jsonb_build_object('error','state_invalid');end if;
 a:=t.person_id;
 perform auth_lock('staff',a);
 select * into s from pulse_priv.google_settings where org_id=current_org();
 if s.enabled is distinct from true or proof->>'iss' is distinct from 'https://accounts.google.com' or proof->'email_verified' is distinct from 'true'::jsonb
  or coalesce(length(proof->>'sub'),0) not between 1 and 255 or coalesce(proof->>'email','')='' then return jsonb_build_object('error','provider_error');end if;
 if not coalesce(proof->>'hd'=any(s.allowed_domains),false) then return jsonb_build_object('error','domain_not_allowed');end if;
 select * into inv from google_invite_open(t.invite_hash);
 if inv.person_id is distinct from a then return jsonb_build_object('error','invite_used');end if;
 if lower(trim(proof->>'email')) is distinct from inv.email then perform auth_event_add('staff',a,'google_invite_other_account');return jsonb_build_object('error','invite_email_mismatch');end if;
 if exists(select 1 from pulse_priv.google_identity where org_id=current_org() and ((issuer=proof->>'iss' and subject=proof->>'sub' and person_id<>a) or (person_id=a and subject<>proof->>'sub'))) then
  return jsonb_build_object('error','already_linked');end if;
 perform set_config('pulse.viewer_id',a::text,true);
 insert into login_credential(org_id,person_id,password_hash,must_change,status,issued_at)
 values(current_org(),a,crypt(encode(gen_random_bytes(32),'base64'),gen_salt('bf',10)),false,'active',now())
 on conflict(person_id) do update set password_hash=case when login_credential.must_change then excluded.password_hash else login_credential.password_hash end,
  must_change=false,failed_attempts=0,locked_until=null;
 insert into pulse_priv.google_identity(org_id,person_id,issuer,subject,email,domain) values(current_org(),a,proof->>'iss',proof->>'sub',lower(trim(proof->>'email')),proof->>'hd') on conflict do nothing;
 update pulse_priv.staff_invitation set status='used',used_at=now(),token_hash=null where org_id=current_org() and person_id=a and status in('prepared','sent','sending');
 update pulse_priv.auth_link set used_at=now() where org_id=current_org() and realm='staff' and actor=a and kind in('reset','invite') and used_at is null;
 update password_reset_request set status='resolved',resolved_at=now() where org_id=current_org() and person_id=a and status='pending';
 delete from pulse_priv.google_invite_ticket where org_id=current_org() and person_id=a;
 perform auth_event_add('staff',a,'google_linked',d);
 perform audit_write('google_accept','staff_invitation',a::text);
 return google_sign_in(proof->>'iss',proof->>'sub',challenge_hash,session_hash,d);
end $$;

revoke all on function pulse.google_invite_open(text),pulse.google_invite_peek(text,text),pulse.google_invite_hint(text),pulse.google_invite_accept(text,jsonb,text,text,text) from public;
grant execute on function pulse.google_invite_peek(text,text),pulse.google_invite_hint(text),pulse.google_invite_accept(text,jsonb,text,text,text) to pulse_api;

-- migrate:down
revoke all on function pulse.google_invite_peek(text,text),pulse.google_invite_hint(text),pulse.google_invite_accept(text,jsonb,text,text,text) from pulse_api;
drop function pulse.google_invite_accept(text,jsonb,text,text,text);
drop function pulse.google_invite_hint(text);
drop function pulse.google_invite_peek(text,text);
drop function pulse.google_invite_open(text);
create or replace function pulse.google_auth_attempt(op text,b jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
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
delete from pulse_priv.google_auth_attempt where mode='invite';
alter table pulse_priv.google_auth_attempt drop constraint google_auth_attempt_mode_check;
alter table pulse_priv.google_auth_attempt add constraint google_auth_attempt_mode_check check(mode in('signin','silent'));
alter table pulse_priv.google_auth_attempt drop column ticket_hash;
drop table pulse_priv.google_invite_ticket;
