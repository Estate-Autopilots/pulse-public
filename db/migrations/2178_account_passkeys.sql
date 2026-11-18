-- migrate:up
-- SWITCH-SMOOTH, part 2 (owner, 16 Nov 2026: "If anything, passkey or a PIN"): a passkey of the person's own Pulse
-- account proves the person in one tap (Windows Hello, a fingerprint, a phone), the first way "Confirm it's you" offers;
-- the e-mailed code (2165) and the password (2142) stay behind it.
--
-- Why not 1447's passkeys: those belong to one company's seat (the second step of that company's sign-in) and are added
-- with that seat's password, so a company's own sign-in, or whoever reads a shared mailbox, could add one. These belong to
-- the account and are added only by a sign-in that already proved the person (viewer_personal: their own password, a code
-- to their own e-mail, their own Google, a trusted device), so the owner's rule holds: a company's sign-in alone never
-- reaches the person's other companies. The API checks the WebAuthn answers (@simplewebauthn/server, webauthn.ts); only
-- the public key is kept.

create table pulse_priv.account_passkey (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references pulse_priv.pulse_account(id) on delete cascade,
  credential_id  text not null unique check (length(credential_id) between 16 and 1024),
  public_key     bytea not null,
  sign_count     bigint not null default 0,
  transports     text[] not null default '{}',
  name           text not null default 'Passkey' check (length(name) <= 60),
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);
create index account_passkey_account on pulse_priv.account_passkey (account_id);
revoke all on pulse_priv.account_passkey from public;

-- One WebAuthn ceremony: adding a passkey, or proving the person with one; five minutes, for one browser sign-in.
create table pulse_priv.account_webauthn (
  challenge     text primary key check (length(challenge) between 16 and 128),
  account_id    uuid not null references pulse_priv.pulse_account(id) on delete cascade,
  purpose       text not null check (purpose in ('register', 'prove')),
  session_hash  text not null check (length(session_hash) between 16 and 128),
  expires_at    timestamptz not null default now() + interval '5 minutes'
);
revoke all on pulse_priv.account_webauthn from public;

-- A ceremony starts: the account's handle and name (the passkey's label in the browser's sheet) and its passkeys (to
-- leave out when adding, to offer when proving). Adding needs a sign-in that proved the person; proving needs a passkey.
create function pulse.account_passkey_begin(p_purpose text, p_challenge text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare h text := acct_prove_session(); v uuid := account_of_viewer(); acc pulse_priv.pulse_account%rowtype;
begin
  if v is null or p_purpose not in ('register', 'prove') or p_challenge is null or length(p_challenge) not between 16 and 128 then return null; end if;
  if p_purpose = 'register' and not viewer_personal() then
    raise exception 'Confirm it''s you first, then add a passkey.' using errcode = '42501', hint = 'personal_sign_in';
  end if;
  if p_purpose = 'prove' and not exists (select 1 from pulse_priv.account_passkey where account_id = v) then return null; end if;
  delete from pulse_priv.account_webauthn where expires_at < now();
  insert into pulse_priv.account_webauthn(challenge, account_id, purpose, session_hash) values (p_challenge, v, p_purpose, h);
  select * into acc from pulse_priv.pulse_account where id = v;
  return jsonb_build_object('account', v, 'name', coalesce(acc.handle, 'pulse'), 'display', coalesce(nullif(acc.display_name, ''), acc.handle, 'Pulse'),
    'credentials', coalesce((select jsonb_agg(jsonb_build_object('id', credential_id, 'transports', to_jsonb(transports)) order by created_at)
                               from pulse_priv.account_passkey where account_id = v), '[]'::jsonb));
end $$;
revoke all on function pulse.account_passkey_begin(text, text) from public;
grant execute on function pulse.account_passkey_begin(text, text) to pulse_api;

-- The ceremony of this browser sign-in and this account, used once (null when gone, expired or someone else's).
create function pulse.acct_webauthn_take(p_challenge text, p_purpose text) returns pulse_priv.account_webauthn
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare w pulse_priv.account_webauthn%rowtype; h text := acct_prove_session();
begin
  select * into w from pulse_priv.account_webauthn x where x.challenge = p_challenge and x.purpose = p_purpose for update;
  if not found then return null; end if;
  delete from pulse_priv.account_webauthn x where x.challenge = p_challenge;
  if w.expires_at < now() or w.account_id is distinct from account_of_viewer() or w.session_hash is distinct from h then return null; end if;
  return w;
end $$;
revoke all on function pulse.acct_webauthn_take(text, text) from public, pulse_api;

-- A checked new passkey for the signed-in person's account (the API verified the answer against this challenge).
create function pulse.account_passkey_add(p_challenge text, cred jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare w pulse_priv.account_webauthn%rowtype;
begin
  w := acct_webauthn_take(p_challenge, 'register');
  if w.account_id is null then return jsonb_build_object('error', 'This passkey request ran out. Try again.'); end if;
  if not viewer_personal() then return jsonb_build_object('error', 'Confirm it''s you first, then add a passkey.'); end if;
  if coalesce(cred ->> 'id', '') = '' or coalesce(cred ->> 'publicKey', '') = '' then return jsonb_build_object('error', 'This passkey could not be checked. Try again.'); end if;
  if exists (select 1 from pulse_priv.account_passkey where credential_id = cred ->> 'id') then return jsonb_build_object('error', 'This passkey is already added.'); end if;
  insert into pulse_priv.account_passkey(account_id, credential_id, public_key, sign_count, transports, name)
  values (w.account_id, cred ->> 'id', decode(cred ->> 'publicKey', 'base64'), coalesce((cred ->> 'counter')::bigint, 0),
          coalesce(array(select jsonb_array_elements_text(coalesce(cred -> 'transports', '[]'::jsonb))), '{}'),
          left(coalesce(nullif(btrim(cred ->> 'name'), ''), 'Passkey'), 60));
  perform acct_event(w.account_id, 'passkey_added');
  perform audit_write('account_passkey_added', 'account', null, array['passkey']);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function pulse.account_passkey_add(text, jsonb) from public;
grant execute on function pulse.account_passkey_add(text, jsonb) to pulse_api;

-- The stored key the answer must match: only this account's passkey, for a proving ceremony of this browser sign-in
-- (read only: the ceremony is used by account_passkey_prove).
create function pulse.account_passkey_for(p_challenge text, p_credential text) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare h text := acct_prove_session(); w pulse_priv.account_webauthn%rowtype; k pulse_priv.account_passkey%rowtype;
begin
  select * into w from pulse_priv.account_webauthn x where x.challenge = p_challenge and x.purpose = 'prove' and x.expires_at > now()
     and x.account_id = account_of_viewer() and x.session_hash = h;
  if not found then return null; end if;
  select * into k from pulse_priv.account_passkey where account_id = w.account_id and credential_id = p_credential;
  if not found then return null; end if;
  return jsonb_build_object('publicKey', encode(k.public_key, 'base64'), 'counter', k.sign_count, 'transports', to_jsonb(k.transports));
end $$;
revoke all on function pulse.account_passkey_for(text, text) from public;
grant execute on function pulse.account_passkey_for(text, text) to pulse_api;

-- A verified passkey answer: the caller's browser session is the person's ({personal: true}). A signature count that
-- did not move forward (a copied passkey) proves nothing ({wrong: true}); the ceremony is used either way.
create function pulse.account_passkey_prove(p_challenge text, p_credential text, p_count bigint) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare h text := acct_prove_session(); w pulse_priv.account_webauthn%rowtype; k pulse_priv.account_passkey%rowtype;
begin
  w := acct_webauthn_take(p_challenge, 'prove');
  if w.account_id is null then return jsonb_build_object('wrong', true, 'expired', true); end if;
  select * into k from pulse_priv.account_passkey where account_id = w.account_id and credential_id = p_credential for update;
  if not found then return jsonb_build_object('wrong', true); end if;
  if coalesce(p_count, 0) > 0 and k.sign_count > 0 and p_count <= k.sign_count then
    perform acct_event(w.account_id, 'passkey_count_refused');
    return jsonb_build_object('wrong', true);
  end if;
  update pulse_priv.account_passkey set sign_count = greatest(sign_count, coalesce(p_count, 0)), last_used_at = now() where id = k.id;
  update login_session set personal = true
   where org_id = current_org() and token_hash = h and person_id = current_viewer() and revoked_at is null;
  perform acct_event(w.account_id, 'prove_passkey_used');
  perform audit_write('account_prove', 'login_session', null, array['personal', 'passkey']);
  return jsonb_build_object('personal', true);
end $$;
revoke all on function pulse.account_passkey_prove(text, text, bigint) from public;
grant execute on function pulse.account_passkey_prove(text, text, bigint) to pulse_api;

-- Settings -> Account access: the account's passkeys; removing one is a change of the sign-in (the person's own only).
create function pulse.account_passkeys() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer();
begin
  if current_viewer() is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  return jsonb_build_object('personal', viewer_personal(), 'passkeys', coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'addedAt', created_at, 'lastUsed', last_used_at) order by created_at)
      from pulse_priv.account_passkey where account_id = v), '[]'::jsonb));
end $$;
revoke all on function pulse.account_passkeys() from public;
grant execute on function pulse.account_passkeys() to pulse_api;

create function pulse.account_passkey_remove(p_id uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer();
begin
  if current_viewer() is null or v is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  perform acct_require_change(v);
  delete from pulse_priv.account_passkey where account_id = v and id = p_id;
  if found then perform acct_event(v, 'passkey_removed'); perform audit_write('account_passkey_removed', 'account', null, array['passkey']); end if;
  return account_passkeys();
end $$;
revoke all on function pulse.account_passkey_remove(uuid) from public;
grant execute on function pulse.account_passkey_remove(uuid) to pulse_api;

-- 2165's switcher answer, now also saying whether the account has a passkey (the first way to prove the person).
create or replace function pulse.account_crossing() returns jsonb
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
                               'password', exists (select 1 from pulse_priv.pulse_account pa where pa.id = v and pa.password_hash is not null),
                               'passkey', exists (select 1 from pulse_priv.account_passkey k where k.account_id = v)));
end $$;
revoke all on function pulse.account_crossing() from public;
grant execute on function pulse.account_crossing() to pulse_api;

-- migrate:down
drop function if exists pulse.account_passkey_remove(uuid);
drop function if exists pulse.account_passkeys();
drop function if exists pulse.account_passkey_prove(text, text, bigint);
drop function if exists pulse.account_passkey_for(text, text);
drop function if exists pulse.account_passkey_add(text, jsonb);
drop function if exists pulse.acct_webauthn_take(text, text);
drop function if exists pulse.account_passkey_begin(text, text);
drop table if exists pulse_priv.account_webauthn;
drop table if exists pulse_priv.account_passkey;
-- account_crossing keeps this version (2165's answer plus ways.passkey).
