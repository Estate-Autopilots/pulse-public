-- migrate:up
-- SWITCH-SMOOTH (owner, 16 Nov 2026): "When I change company it asks me for the company login. That should not be
-- asked if I am already in. Once you are in the Pulse account, switching between companies should be easy, easy, cheesy ...
-- I don't even know what my password is. Asking again and again is a hazard."
--
-- Why it asked: ACCOUNT-META (2125) marks a session personal only when its own sign-in proved the person, and every
-- session from before 2125 (and every later company sign-in) is personal = false, so each browser was asked once by
-- 2142's "Confirm it's you", with the Pulse password as the only answer.
--
-- The owner's security rule stays exactly as it is: a shared or company mailbox (admin@ ...) never reaches the person's
-- account or their other companies, and a company's own sign-in on a browser that never proved the person stays in its
-- company. What changes:
--   1. A trusted device. Once a person proves themselves on a browser (their own password, a code to their own e-mail,
--      Google / Microsoft / Apple with their own address, "Confirm it's you"), that browser is theirs for 180 days
--      (pulse_priv.account_device, keyed by the hash of the web's httpOnly pulse_device_key cookie; revocable in
--      Settings -> Account access). The API's front door lifts any session of that account on it to personal
--      (acct_device_seen), so every company on that browser opens in one tap and nothing else about the rule changes:
--      acct_may_cross, account_tab_session and account_move read personal as before.
--   2. Google, Microsoft and Apple with an address that is one of the account's own personal sign-in e-mails (a gmail.com
--      address on the account, say) prove the person, like a code to that address does.
--   3. Sessions from before 2125 on a browser that proved the person are lifted silently by (1) at their next request;
--      a browser that never did is asked once (4).
--   4. When a proof is needed, one tap: "Email me a code" to the account's own e-mail (account_prove_code_*), the password
--      last (2142's account_prove).
--   5. The switcher knows before it starts which companies need a proof (account_crossing).
-- A company's own sign-in on a browser that never proved the person (company password, staff code, company Google,
-- Access) is unchanged.

-- ------------------------------------------------------------------------------------------------ 1. trusted devices
create table pulse_priv.account_device (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references pulse_priv.pulse_account(id) on delete cascade,
  device_hash   text not null check (length(device_hash) between 16 and 128),
  label         text not null default 'Browser' check (length(label) <= 120),
  proof         text not null check (proof in ('session', 'password', 'code', 'google', 'microsoft', 'apple', 'passkey')),
  created_at    timestamptz not null default now(),
  proved_at     timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  unique (account_id, device_hash)
);
revoke all on pulse_priv.account_device from public;
comment on table pulse_priv.account_device is 'SWITCH-SMOOTH: browsers a person proved themselves on (180 days; Settings -> Account access forgets one).';

-- The browser a session was last seen on (the hash of its device key), so forgetting a device ends its sessions' proof.
alter table pulse.login_session add column device_hash text check (device_hash is null or length(device_hash) between 16 and 128);

create function pulse.acct_device_stamp(p_org uuid, p_session text, p_device text) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform acct_enter(p_org, null);
  update login_session x set device_hash = p_device where x.org_id = p_org and x.token_hash = p_session and x.device_hash is distinct from p_device;
  perform acct_leave();
end $$;
revoke all on function pulse.acct_device_stamp(uuid, text, text) from public, pulse_api;

-- The API's front door, for the browser's own sign-in (never a tab's child session or a desktop device) and the browser's
-- device key hash. Answers what it did:
--   'lifted'   a session of an account that proved itself on this browser before: now personal (one write, audited);
--   'trusted'  a personal session on a browser with no record for the account yet: the browser is trusted from now
--              (the person proved themselves here: that is the only way a session is personal);
--   'personal' already personal; 'company' a company's own sign-in on a browser that never proved the person;
--   'none'     no live browser session of an account.
-- Never renews a trust: a lifted session is personal because of the trust, so only a new proof (acct_device_trust)
-- moves its 180 days, and a forgotten browser stays forgotten until the person proves themselves there again.
create function pulse.acct_device_seen(p_session text, p_device text) returns text
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s login_session%rowtype; a uuid; t pulse_priv.account_device%rowtype;
begin
  if p_session is null or p_device is null or length(p_device) not between 16 and 128 then return 'none'; end if;
  select * into s from login_session x where x.token_hash = p_session and x.revoked_at is null and x.expires_at > now();
  if s.token_hash is null or s.native_device_id is not null or s.parent_hash is not null then return 'none'; end if;
  select am.account_id into a from pulse_priv.account_member am where am.person_id = s.person_id and am.member_org = s.org_id;
  if a is null then return 'none'; end if;
  select * into t from pulse_priv.account_device d where d.account_id = a and d.device_hash = p_device;
  if s.personal then
    if t.id is null then
      insert into pulse_priv.account_device(account_id, device_hash, label, proof, expires_at)
      values (a, p_device, left(coalesce(nullif(s.device, ''), 'Browser'), 120), 'session', now() + interval '180 days')
      on conflict (account_id, device_hash) do nothing;
      perform acct_device_stamp(s.org_id, p_session, p_device);
      perform acct_event(a, 'device_trusted', s.device);
      return 'trusted';
    end if;
    if t.revoked_at is null and t.expires_at > now() then
      update pulse_priv.account_device d set last_seen_at = now() where d.id = t.id and d.last_seen_at < now() - interval '10 minutes';
      if s.device_hash is distinct from p_device then perform acct_device_stamp(s.org_id, p_session, p_device); end if;
    end if;
    return 'personal';
  end if;
  if t.id is null or t.revoked_at is not null or t.expires_at <= now() then return 'company'; end if;
  perform acct_enter(s.org_id, null);
  update login_session x set personal = true, device_hash = p_device
   where x.org_id = s.org_id and x.token_hash = p_session and x.person_id = s.person_id and x.revoked_at is null;
  perform acct_leave();
  perform acct_enter(s.org_id, s.person_id);
  perform audit_write('device_trusted_sign_in', 'login_session', s.id::text, array['personal']);
  perform acct_leave();
  update pulse_priv.account_device d set last_seen_at = now() where d.id = t.id;
  return 'lifted';
end $$;
revoke all on function pulse.acct_device_seen(text, text) from public;
grant execute on function pulse.acct_device_seen(text, text) to pulse_api;

-- Right after a proof on this browser (the API calls it from the sign-in and "Confirm it's you" routes): a personal browser
-- session makes its browser trusted for 180 days from now (again, if it was forgotten or ran out). Anything else: no.
create function pulse.acct_device_trust(p_session text, p_device text, p_proof text) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s login_session%rowtype; a uuid; k text := case when p_proof in ('password', 'code', 'google', 'microsoft', 'apple', 'passkey') then p_proof else 'session' end;
begin
  if p_session is null or p_device is null or length(p_device) not between 16 and 128 then return false; end if;
  select * into s from login_session x where x.token_hash = p_session and x.revoked_at is null and x.expires_at > now();
  if s.token_hash is null or not s.personal or s.native_device_id is not null or s.parent_hash is not null then return false; end if;
  select am.account_id into a from pulse_priv.account_member am where am.person_id = s.person_id and am.member_org = s.org_id;
  if a is null then return false; end if;
  insert into pulse_priv.account_device(account_id, device_hash, label, proof, expires_at)
  values (a, p_device, left(coalesce(nullif(s.device, ''), 'Browser'), 120), k, now() + interval '180 days')
  on conflict (account_id, device_hash) do update
    set proof = excluded.proof, label = excluded.label, proved_at = now(), last_seen_at = now(), expires_at = excluded.expires_at, revoked_at = null;
  perform acct_device_stamp(s.org_id, p_session, p_device);
  perform acct_event(a, 'device_trusted', s.device);
  return true;
end $$;
revoke all on function pulse.acct_device_trust(text, text, text) from public;
grant execute on function pulse.acct_device_trust(text, text, text) to pulse_api;

-- Settings -> Account access: the browsers this account is trusted on (p_device: the asking browser's, to mark it).
create function pulse.account_devices(p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer();
begin
  if current_viewer() is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  if v is null then return jsonb_build_object('devices', '[]'::jsonb, 'personal', viewer_personal()); end if;
  return jsonb_build_object('personal', viewer_personal(), 'devices', coalesce((
    select jsonb_agg(jsonb_build_object('id', d.id, 'label', d.label, 'proof', d.proof, 'provedAt', d.proved_at, 'lastSeen', d.last_seen_at,
             'expiresAt', d.expires_at, 'thisDevice', d.device_hash = p_device) order by (d.device_hash = p_device) desc, d.last_seen_at desc)
      from pulse_priv.account_device d where d.account_id = v and d.revoked_at is null and d.expires_at > now()), '[]'::jsonb));
end $$;
revoke all on function pulse.account_devices(text) from public;
grant execute on function pulse.account_devices(text) to pulse_api;

-- Forget one browser (p_id), or every one (null): Pulse asks there again, and that browser's sessions are no longer
-- personal (they stay signed in, in their own company). Only the person's own sign-in may do it (as any sign-in change).
create function pulse.account_device_forget(p_id uuid, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); gone text[]; m record; n int;
begin
  if current_viewer() is null or v is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  perform acct_require_change(v);
  with x as (update pulse_priv.account_device d set revoked_at = now()
              where d.account_id = v and d.revoked_at is null and (p_id is null or d.id = p_id) returning d.device_hash)
  select coalesce(array_agg(device_hash), '{}') into gone from x;
  n := cardinality(gone);
  if n > 0 then
    for m in select am.member_org, am.person_id from pulse_priv.account_member am where am.account_id = v loop
      perform acct_enter(m.member_org, null);
      update login_session x set personal = false
       where x.org_id = m.member_org and x.person_id = m.person_id and x.revoked_at is null and x.device_hash = any(gone);
      perform acct_leave();
    end loop;
    perform acct_event(v, 'device_forgotten');
    perform audit_write('device_forgotten', 'account', null, array[case when p_id is null then 'all' else 'one' end]);
  end if;
  return account_devices(p_device) || jsonb_build_object('forgotten', n);
end $$;
revoke all on function pulse.account_device_forget(uuid, text) from public;
grant execute on function pulse.account_device_forget(uuid, text) to pulse_api;

-- ------------------------------------------------------------------------------------------------ 2. Google, Microsoft, Apple
-- A provider sign-in proves the person when the address it verified is one of the account's own personal sign-in e-mails
-- (acct_signin_emails: never a shared mailbox, never a company's record).
create function pulse.acct_provider_personal(r jsonb, proof jsonb, p_session text) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare e text := lower(btrim(coalesce(proof ->> 'email', ''))); p uuid; a uuid;
begin
  if r is null or r ? 'error' or coalesce((r ->> 'twoStep')::boolean, false) or p_session is null then return; end if;
  if coalesce((proof ->> 'email_verified')::boolean, false) is not true or e = '' or mailbox_shared(e) then return; end if;
  select x.person_id into p from login_session x where x.org_id = current_org() and x.token_hash = p_session and x.revoked_at is null;
  if p is null then return; end if;
  select am.account_id into a from pulse_priv.account_member am where am.person_id = p and am.member_org = current_org();
  if a is not null and acct_email_personal(a, e) then perform acct_mark_personal(current_org(), p_session); end if;
end $$;
revoke all on function pulse.acct_provider_personal(jsonb, jsonb, text) from public, pulse_api;

-- 2125's wrappers, unchanged, then the proof above.
create or replace function pulse.google_sign_in_any(proof jsonb, challenge_hash text, session_hash text, d text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r jsonb;
begin
  -- Google switched off here, or a proof it would refuse: the core's own answer comes first (provider_error).
  if mailbox_shared(proof ->> 'email') and exists (select 1 from pulse_priv.google_settings where org_id = current_org() and enabled)
     and proof ->> 'iss' = 'https://accounts.google.com' and coalesce((proof ->> 'email_verified')::boolean, false) then
    perform auth_event_add('staff', null, 'shared_mailbox_refused', d); return jsonb_build_object('error', 'not_linked');
  end if;
  if mailbox_shared(proof ->> 'email') then return jsonb_build_object('error', 'provider_error'); end if;
  r := acct_google_any_core(proof, challenge_hash, session_hash, d);
  perform acct_provider_personal(r, proof, session_hash);
  return r;
end $$;
revoke all on function pulse.google_sign_in_any(jsonb, text, text, text) from public;
grant execute on function pulse.google_sign_in_any(jsonb, text, text, text) to pulse_api;

create or replace function pulse.oidc_sign_in_any(provider text, proof jsonb, challenge_hash text, session_hash text, d text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare issuer text := case provider when 'apple' then 'https://appleid.apple.com' when 'microsoft' then 'https://login.microsoftonline.com/' end; r jsonb;
begin
  if mailbox_shared(proof ->> 'email') then
    -- A proof the core would refuse keeps the core's answer (provider_error); a good one with a shared mailbox: nobody.
    if issuer is null or coalesce(proof ->> 'iss', '') not like issuer || '%' or coalesce((proof ->> 'email_verified')::boolean, false) is not true then
      return jsonb_build_object('error', 'provider_error');
    end if;
    perform auth_event_add('staff', null, 'shared_mailbox_refused', d); return jsonb_build_object('error', 'not_linked');
  end if;
  r := acct_oidc_any_core(provider, proof, challenge_hash, session_hash, d);
  perform acct_provider_personal(r, proof, session_hash);
  return r;
end $$;
revoke all on function pulse.oidc_sign_in_any(text, jsonb, text, text, text) from public;
grant execute on function pulse.oidc_sign_in_any(text, jsonb, text, text, text) to pulse_api;

-- ------------------------------------------------------------------------------------------------ 4. "Email me a code"
-- Confirm it's you without a password: a 6-digit code to the account's own e-mail (its main personal sign-in e-mail;
-- never a shared mailbox, never a company's record). 10 minutes, five tries, one a minute, five an hour.
create table pulse_priv.account_prove_code (
  account_id  uuid primary key references pulse_priv.pulse_account(id) on delete cascade,
  sent_to     text not null check (length(sent_to) <= 254),
  code_hash   text,
  expires_at  timestamptz,
  tries       int not null default 0,
  last_sent   timestamptz,
  hour_start  timestamptz,
  hour_sent   int not null default 0
);
revoke all on pulse_priv.account_prove_code from public;

-- The e-mail a proof code goes to: the account's main personal sign-in e-mail, or null.
create function pulse.acct_prove_email(p_account uuid) returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select e.email from acct_signin_emails(p_account) e where e.personal and not mailbox_shared(e.email) order by e.is_primary desc, e.email limit 1
$$;
revoke all on function pulse.acct_prove_email(uuid) from public, pulse_api;

-- The caller's own live browser session (as 2142's account_prove asks), or an error.
create function pulse.acct_prove_session() returns text
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare h text := nullif(current_setting('pulse.viewer_session', true), '');
begin
  if current_viewer() is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  if h is null or not exists (select 1 from login_session where org_id = current_org() and token_hash = h
      and person_id = current_viewer() and revoked_at is null and expires_at > now() and native_device_id is null) then
    raise exception 'Confirm it is you from the browser you signed in on' using errcode = '42501';
  end if;
  return h;
end $$;
revoke all on function pulse.acct_prove_session() from public, pulse_api;

create function pulse.account_prove_code_start() returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare h text := acct_prove_session(); v uuid := account_of_viewer(); e text; s pulse_priv.account_prove_code%rowtype; code text;
begin
  if viewer_personal() then return jsonb_build_object('personal', true); end if;
  e := case when v is not null then acct_prove_email(v) end;
  if e is null then return jsonb_build_object('noEmail', true); end if;
  insert into pulse_priv.account_prove_code(account_id, sent_to) values (v, e) on conflict (account_id) do nothing;
  select * into s from pulse_priv.account_prove_code where account_id = v for update;
  if s.last_sent > now() - interval '1 minute' or (s.hour_start > now() - interval '1 hour' and s.hour_sent >= 5) then
    raise exception 'A code was sent a moment ago. Check your e-mail, or ask again in a minute.' using errcode = '54000';
  end if;
  code := acct_code_make();
  update pulse_priv.account_prove_code set sent_to = e, code_hash = encode(digest(code || ':' || v || ':' || e, 'sha256'), 'hex'),
         expires_at = now() + interval '10 minutes', tries = 0, last_sent = now(),
         hour_sent = case when hour_start > now() - interval '1 hour' then hour_sent + 1 else 1 end,
         hour_start = case when hour_start > now() - interval '1 hour' then hour_start else now() end
   where account_id = v;
  perform acct_event(v, 'prove_code_sent');
  return jsonb_build_object('code', code, 'delivery', e, 'masked', acct_mask_email(e));
end $$;
revoke all on function pulse.account_prove_code_start() from public;
grant execute on function pulse.account_prove_code_start() to pulse_api;

-- The code: right -> the caller's session is personal ({personal: true}); wrong -> {wrong: true} (counted; never raises,
-- so the count is kept); none waiting or run out -> {wrong: true, expired: true}.
create function pulse.account_prove_code_finish(p_code text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare h text := acct_prove_session(); v uuid := account_of_viewer(); s pulse_priv.account_prove_code%rowtype;
begin
  if viewer_personal() then return jsonb_build_object('personal', true); end if;
  if v is null then return jsonb_build_object('wrong', true, 'expired', true); end if;
  select * into s from pulse_priv.account_prove_code where account_id = v for update;
  if not found or s.code_hash is null or s.expires_at < now() or s.tries >= 5 then
    return jsonb_build_object('wrong', true, 'expired', true);
  end if;
  if encode(digest(regexp_replace(coalesce(p_code, ''), '\D', '', 'g') || ':' || v || ':' || s.sent_to, 'sha256'), 'hex') <> s.code_hash then
    update pulse_priv.account_prove_code set tries = tries + 1, code_hash = case when tries + 1 >= 5 then null else code_hash end where account_id = v;
    perform acct_event(v, 'prove_code_failed');
    return jsonb_build_object('wrong', true, 'expired', s.tries + 1 >= 5);
  end if;
  update pulse_priv.account_prove_code set code_hash = null, expires_at = null, tries = 0 where account_id = v;
  -- The address must still be the person's own (it could have been removed since the code went out).
  if not acct_email_personal(v, s.sent_to) then return jsonb_build_object('wrong', true, 'expired', true); end if;
  update login_session set personal = true
   where org_id = current_org() and token_hash = h and person_id = current_viewer() and revoked_at is null;
  perform acct_event(v, 'prove_code_used');
  perform audit_write('account_prove', 'login_session', null, array['personal', 'code']);
  return jsonb_build_object('personal', true);
end $$;
revoke all on function pulse.account_prove_code_finish(text) from public;
grant execute on function pulse.account_prove_code_finish(text) to pulse_api;

-- ------------------------------------------------------------------------------------------------ 5. the switcher
-- Before a switch starts: which of the account's other companies this sign-in may not open yet, why, and the ways it can
-- prove the person (the masked own e-mail for a code, whether there is a Pulse password).
create function pulse.account_crossing() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); per boolean := viewer_personal(); e text;
begin
  if current_viewer() is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  if v is null then return jsonb_build_object('personal', per, 'locked', '[]'::jsonb); end if;
  e := acct_prove_email(v);
  return jsonb_build_object('personal', per,
    'locked', coalesce((select jsonb_agg(am.member_org order by am.member_org) from pulse_priv.account_member am join org o on o.id = am.member_org and o.status = 'active'
                         where am.account_id = v and am.member_org is distinct from current_org() and not acct_may_cross(v, per, am.member_org)), '[]'::jsonb),
    'ways', jsonb_build_object('code', case when e is not null then acct_mask_email(e) end,
                               'password', exists (select 1 from pulse_priv.pulse_account pa where pa.id = v and pa.password_hash is not null)));
end $$;
revoke all on function pulse.account_crossing() from public;
grant execute on function pulse.account_crossing() to pulse_api;

-- migrate:down
drop function if exists pulse.account_crossing();
drop function if exists pulse.account_prove_code_finish(text);
drop function if exists pulse.account_prove_code_start();
drop function if exists pulse.acct_prove_session();
drop function if exists pulse.acct_prove_email(uuid);
drop table if exists pulse_priv.account_prove_code;
drop function if exists pulse.account_device_forget(uuid, text);
drop function if exists pulse.account_devices(text);
drop function if exists pulse.acct_device_trust(text, text, text);
drop function if exists pulse.acct_device_seen(text, text);
drop function if exists pulse.acct_device_stamp(uuid, text, text);
alter table pulse.login_session drop column if exists device_hash;
drop table if exists pulse_priv.account_device;
-- google_sign_in_any / oidc_sign_in_any keep this version (2125's body plus the proof); acct_provider_personal stays with them.
