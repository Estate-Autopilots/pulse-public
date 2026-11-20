-- migrate:up
-- SIGNIN-CODE (19 Nov 2026; QA-1B's one-time sign-in link cannot sign in an iPhone's installed home-screen app: on iOS a
-- link opens in Safari, whose storage is not the app's). A one-time staff sign-in link (PEOPLE-CONTACTS: HR's "Send
-- one-time sign-in link", or tools/admin/qa-org.py signin-link) now also has a short code: 8 characters a person types
-- on the sign-in page ("Have a sign-in code?") with their username. The code stands for that link only: same 15
-- minutes, once (using the code uses the link up, and the link the code), two-step still asked, a newer link replaces
-- both. Stored as a bcrypt hash bound to the link's token; five wrong tries for the person end the code (the link still
-- works). Every answer that does not sign in is the same null (no telling which usernames exist or have a code). Each
-- code issued, accepted, wrong or ended is in the account history and the company's Audit (auth_event_add).
create table pulse_priv.auth_link_code (
  org_id uuid not null references pulse.org(id), actor uuid not null,
  token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'), code_hash text not null,
  tries int not null default 0, created_at timestamptz not null default now(),
  primary key (org_id, actor));
alter table pulse_priv.auth_link_code enable row level security;
alter table pulse_priv.auth_link_code force row level security;
create policy tenant on pulse_priv.auth_link_code using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

-- The code for a sign-in link just made (h: its token's hash), or null when there is no such open link in this
-- organisation. 8 of 23456789ABCDEFGHJKMNPQRSTVWXYZ (no 0/O, 1/I/L or U to misread): 30^8, about 39 bits.
create function pulse.auth_link_code_make(h text) returns text
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare a uuid; b bytea; code text := ''; abc constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
begin
  if coalesce(h, '') !~ '^[a-f0-9]{64}$' then return null; end if;
  select actor into a from pulse_priv.auth_link where org_id = current_org() and realm = 'staff' and kind = 'signin'
     and token_hash = h and used_at is null and expires_at > now();
  if a is null then return null; end if;
  while length(code) < 8 loop
    b := gen_random_bytes(16);
    for i in 0..15 loop
      -- 240 = 8 x 30: bytes from 240 up are skipped, so every character is equally likely.
      if length(code) < 8 and get_byte(b, i) < 240 then code := code || substr(abc, get_byte(b, i) % 30 + 1, 1); end if;
    end loop;
  end loop;
  insert into pulse_priv.auth_link_code(org_id, actor, token_hash, code_hash) values (current_org(), a, h, crypt(code, gen_salt('bf', 8)))
  on conflict (org_id, actor) do update set token_hash = excluded.token_hash, code_hash = excluded.code_hash, tries = 0, created_at = now();
  perform auth_event_add('staff', a, 'signin_link_code_issued');
  return code;
end $$;

-- Signing in with the code: exactly auth_link_sign_in_any with the link the code stands for (the session, { twoStep }
-- while an authenticator code is still needed, or null). input is the username (or @handle, or the e-mail on record,
-- as the e-mailed code takes it); code is case-blind, spaces and dashes ignored. On a company's own address the person
-- is one of its staff; on the shared address (the install's own organisation) a person of any active company, as a
-- sign-in link opened there finds its company (auth_link_away).
create function pulse.auth_link_code_sign_in(input text, code text, otp text, session_hash text, d text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare here uuid := current_org(); orgs uuid[]; o uuid; a uuid; k pulse_priv.auth_link_code%rowtype; hit text; tried boolean := false;
  c text := upper(regexp_replace(coalesce(code, ''), '[\s-]', '', 'g'));
begin
  if here is null or c !~ '^[2-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$' or coalesce(session_hash, '') !~ '^[a-f0-9]{64}$' or btrim(coalesce(input, '')) = '' then
    return null;
  end if;
  orgs := array[here] || case when here = install_org() then array(select id from org where status = 'active' and id <> here order by id) else '{}'::uuid[] end;
  foreach o in array orgs loop
    perform set_config('pulse.org_id', o::text, true);
    a := auth_signin_code_actor('staff', input);
    continue when a is null;
    select x.* into k from pulse_priv.auth_link_code x join pulse_priv.auth_link l on l.org_id = x.org_id and l.token_hash = x.token_hash
     where x.org_id = o and x.actor = a and l.realm = 'staff' and l.kind = 'signin' and l.actor = a and l.used_at is null and l.expires_at > now()
       for update of x;
    continue when not found;
    tried := true;
    if crypt(c, k.code_hash) = k.code_hash then
      hit := k.token_hash; perform auth_event_add('staff', a, 'signin_link_code_accepted', d); exit;
    end if;
    -- The fifth wrong try ends the code (HR or the tool makes a new link and code); the link itself still works.
    if k.tries + 1 >= 5 then
      delete from pulse_priv.auth_link_code where org_id = o and actor = a;
      perform auth_event_add('staff', a, 'signin_link_code_ended', d);
    else
      update pulse_priv.auth_link_code set tries = tries + 1 where org_id = o and actor = a;
      perform auth_event_add('staff', a, 'signin_link_code_failed', d);
    end if;
  end loop;
  perform set_config('pulse.org_id', here::text, true);
  if hit is null then
    -- Nobody with an open code: the same bcrypt work as a wrong code, so the time taken does not tell either.
    if not tried then perform crypt(c, gen_salt('bf', 8)); perform auth_event_add('staff', null, 'signin_link_code_failed', d); end if;
    return null;
  end if;
  return auth_link_sign_in_any('staff', hit, otp, session_hash, d);
end $$;

revoke all on function pulse.auth_link_code_make(text), pulse.auth_link_code_sign_in(text, text, text, text, text) from public;
grant execute on function pulse.auth_link_code_make(text), pulse.auth_link_code_sign_in(text, text, text, text, text) to pulse_api;

-- migrate:down
drop function if exists pulse.auth_link_code_sign_in(text, text, text, text, text);
drop function if exists pulse.auth_link_code_make(text);
drop table if exists pulse_priv.auth_link_code;
