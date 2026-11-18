-- migrate:up
-- LOGIN-VITALS (owner, 13 Nov 2026: "prepare Microsoft and Apple sign-in the same way"): Continue with Microsoft and
-- Continue with Apple, beside Continue with Google. Off unless the server switches them on (PULSE_MICROSOFT_SIGN_IN=1,
-- PULSE_APPLE_SIGN_IN=1 with their clients: services/api/src/sign-in-providers.ts); this only adds what the database
-- needs, so nothing changes for anyone until then.
--  - A sign-in attempt names its provider, and a callback takes only its own provider's attempts (a Google attempt
--    never finishes at Microsoft's callback or the reverse).
--  - Sessions and 2-step challenges record the provider ('microsoft', 'apple'), like 'google': never 'password', so
--    the account's password-only actions stay password-only.
--  - pulse.oidc_sign_in_any signs in the one active staff person whose e-mail on record is the provider-verified
--    e-mail, exactly as Continue with Google does without a link (1450 google_sign_in_any): the e-mail on their
--    profile, their delivery e-mail, or the e-mail of the Pulse account that holds their seat. The API passes only an
--    e-mail the provider verified (Microsoft: a personal account, or a work account whose domain owner verified it,
--    `xms_edov`; Apple: email_verified). Never creates anyone; no match or several matches answer not_linked; Pulse
--    two-step still applies; every attempt is audited.
alter table pulse_priv.google_auth_attempt add column provider text not null default 'google' check (provider in ('google', 'microsoft', 'apple'));

alter table pulse.login_session drop constraint login_session_via_check;
alter table pulse.login_session add constraint login_session_via_check check (via = any (array['password', 'google', 'account', 'microsoft', 'apple']));
alter table pulse_priv.auth_challenge drop constraint auth_challenge_via_check;
alter table pulse_priv.auth_challenge add constraint auth_challenge_via_check check (via = any (array['password', 'google', 'microsoft', 'apple']));

create or replace function pulse.google_auth_attempt(op text, b jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a pulse_priv.google_auth_attempt%rowtype; p text := coalesce(nullif(b->>'provider', ''), 'google');
begin
 if op = 'begin' then
  delete from pulse_priv.google_auth_attempt where org_id = current_org() and expires_at <= now();
  insert into pulse_priv.google_auth_attempt(org_id, state_hash, cookie_hash, nonce, verifier, mode, next, ticket_hash, provider)
   values (current_org(), b->>'stateHash', b->>'cookieHash', b->>'nonce', b->>'verifier', b->>'mode', b->>'next', nullif(b->>'ticketHash', ''), p);
  return jsonb_build_object('ok', true);
 elsif op <> 'take' then raise exception 'Invalid sign-in action' using errcode = '22023'; end if;
 delete from pulse_priv.google_auth_attempt where org_id = current_org() and state_hash = b->>'stateHash' and cookie_hash = b->>'cookieHash'
   and provider = p and expires_at > clock_timestamp() returning * into a;
 if not found then return jsonb_build_object('error', 'state_invalid'); end if;
 return jsonb_build_object('nonce', a.nonce, 'verifier', a.verifier, 'mode', a.mode, 'next', a.next)
   || case when a.ticket_hash is null then '{}'::jsonb else jsonb_build_object('ticketHash', a.ticket_hash) end;
end $$;

create function pulse.oidc_sign_in_any(provider text, proof jsonb, challenge_hash text, session_hash text, d text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare e text := lower(btrim(coalesce(proof->>'email', ''))); a uuid; n int; result jsonb; pol pulse_priv.auth_policy%rowtype;
        issuer text := case provider when 'apple' then 'https://appleid.apple.com' when 'microsoft' then 'https://login.microsoftonline.com/' end;
begin
  if issuer is null or coalesce(proof->>'iss', '') not like issuer || '%' or coalesce((proof->>'email_verified')::boolean, false) is not true
     or e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return jsonb_build_object('error', 'provider_error');
  end if;
  select count(*), min(p.id::text)::uuid into n, a from person p join people_profile pp on pp.person_id = p.id and pp.org_id = p.org_id
    join login_credential lc on lc.org_id = p.org_id and lc.person_id = p.id
   where p.org_id = current_org() and p.status = 'active' and p.side = 'staff' and lc.status = 'active'
     and (lower(pp.email) = e or lower(auth_delivery('staff', p.id)) = e
          or exists (select 1 from pulse_priv.account_member m join pulse_priv.pulse_account pa on pa.id = m.account_id
                      where m.person_id = p.id and m.member_org = current_org() and lower(pa.email) = e));
  if n <> 1 then perform auth_event_add('staff', null, provider || '_sign_in_unmatched', d); return jsonb_build_object('error', 'not_linked'); end if;
  perform auth_lock('staff', a);
  perform auth_event_add('staff', a, provider || '_email_sign_in', d);
  if auth_second_factor('staff', a) then
    insert into pulse_priv.auth_challenge values (current_org(), 'staff', a, challenge_hash, now() + interval '5 minutes', false, left(coalesce(d, ''), 120), null, provider);
    perform auth_event_add('staff', a, 'two_step_challenge', d); return jsonb_build_object('twoStep', true);
  end if;
  result := auth_session('staff', a, session_hash, false, d);
  if result is null then return jsonb_build_object('error', 'account_disabled'); end if;
  update login_session set via = provider where org_id = current_org() and person_id = a and token_hash = session_hash;
  select * into pol from pulse_priv.auth_policy where org_id = current_org();
  if pol.required and a is distinct from pol.exempt_owner and exists (select 1 from role_assignment where org_id = current_org() and person_id = a
       and role_key in ('admin', 'hr', 'leadership') and current_date between valid_from and coalesce(valid_to, 'infinity')) then
    result := result || jsonb_build_object('enrollmentRequired', true, 'graceUntil', pol.grace_until);
  end if;
  return result || jsonb_build_object('actor', a, 'delivery', auth_delivery('staff', a));
end $$;
revoke all on function pulse.oidc_sign_in_any(text, jsonb, text, text, text) from public;
grant execute on function pulse.oidc_sign_in_any(text, jsonb, text, text, text) to pulse_api;

-- migrate:down
drop function if exists pulse.oidc_sign_in_any(text, jsonb, text, text, text);
delete from pulse_priv.google_auth_attempt where provider <> 'google';
alter table pulse_priv.google_auth_attempt drop column provider;
