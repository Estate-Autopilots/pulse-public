-- migrate:up
-- GOOGLE-ONE-CLICK (owner, 2 Nov 2026: "make Google sign-in one click for everyone"): Continue with Google signs in a
-- person whose Google-verified e-mail is on record for them here, without linking first: the e-mail on their profile
-- (work or personal), their delivery e-mail, or the e-mail of the Pulse account that holds their seat (HR's private
-- contact card is not readable signed out, by its own row security, so it is not matched). A gmail.com address
-- works, not only the company's Workspace domain. A linked Google account (on an allowed domain) signs in as before.
-- Never creates anyone: no match, several matches, or an inactive, offboarded or disabled person answer not_linked
-- ("we couldn't find you"). Only Google-verified e-mails; Pulse two-step still applies; every attempt is audited.
create function pulse.google_sign_in_any(proof jsonb, challenge_hash text, session_hash text, d text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s pulse_priv.google_settings%rowtype; e text := lower(btrim(coalesce(proof->>'email', ''))); r jsonb; a uuid; n int;
        result jsonb; pol pulse_priv.auth_policy%rowtype;
begin
  select * into s from pulse_priv.google_settings where org_id = current_org();
  if s.enabled is distinct from true or proof->>'iss' <> 'https://accounts.google.com' or coalesce((proof->>'email_verified')::boolean, false) is not true
     or e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return jsonb_build_object('error', 'provider_error');
  end if;
  -- A Google account linked to someone here, from an allowed company domain: as before.
  if coalesce(proof->>'hd', '') = any(s.allowed_domains) then
    r := google_sign_in(proof->>'iss', proof->>'sub', challenge_hash, session_hash, d);
    if r->>'error' is distinct from 'not_linked' then return r; end if;
  end if;
  -- Otherwise the verified e-mail, matched against what is on record for exactly one active staff person.
  select count(*), min(p.id::text)::uuid into n, a from person p join people_profile pp on pp.person_id = p.id and pp.org_id = p.org_id
    join login_credential lc on lc.org_id = p.org_id and lc.person_id = p.id
   where p.org_id = current_org() and p.status = 'active' and p.side = 'staff' and lc.status = 'active'
     and (lower(pp.email) = e or lower(auth_delivery('staff', p.id)) = e
          or exists (select 1 from pulse_priv.account_member m join pulse_priv.pulse_account pa on pa.id = m.account_id
                      where m.person_id = p.id and m.member_org = current_org() and lower(pa.email) = e));
  if n <> 1 then perform auth_event_add('staff', null, 'google_sign_in_unmatched', d); return jsonb_build_object('error', 'not_linked'); end if;
  perform auth_lock('staff', a);
  perform auth_event_add('staff', a, 'google_email_sign_in', d);
  if auth_second_factor('staff', a) then
    insert into pulse_priv.auth_challenge values (current_org(), 'staff', a, challenge_hash, now() + interval '5 minutes', false, left(coalesce(d, ''), 120), null, 'google');
    perform auth_event_add('staff', a, 'two_step_challenge', d); return jsonb_build_object('twoStep', true);
  end if;
  result := auth_session('staff', a, session_hash, false, d);
  if result is null then return jsonb_build_object('error', 'account_disabled'); end if;
  update login_session set via = 'google' where org_id = current_org() and person_id = a and token_hash = session_hash;
  select * into pol from pulse_priv.auth_policy where org_id = current_org();
  if pol.required and a is distinct from pol.exempt_owner and exists (select 1 from role_assignment where org_id = current_org() and person_id = a
       and role_key in ('admin', 'hr', 'leadership') and current_date between valid_from and coalesce(valid_to, 'infinity')) then
    result := result || jsonb_build_object('enrollmentRequired', true, 'graceUntil', pol.grace_until);
  end if;
  return result || jsonb_build_object('actor', a, 'delivery', auth_delivery('staff', a));
end $$;
revoke all on function pulse.google_sign_in_any(jsonb, text, text, text) from public;
grant execute on function pulse.google_sign_in_any(jsonb, text, text, text) to pulse_api;

-- migrate:down
drop function if exists pulse.google_sign_in_any(jsonb, text, text, text);
