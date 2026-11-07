-- migrate:up
-- AUTH-UNIFY (owner, 27 Oct 2026): one sign-in identity per human across every organisation on this Pulse, with Pulse as
-- the one place people sign in. Builds on ORG (0920: pulse_priv.pulse_account + account_member) and PULSE-ID (1115).
--
--  * A session belongs to the account and points at one active organisation. Switching organisation no longer mints a
--    second session: the same token moves (pulse.acct_move). The row in the organisation left behind is retired (kept,
--    revoked) and an identical row opens in the other one, so every request still runs inside exactly one organisation
--    under its row-level security. Membership is checked on the server, the person there must be active, and both
--    organisations get an audit row (org_switch / org_switch_in). The browser keeps the same cookie: no sign-in again.
--  * Signing in with a username, @handle or e-mail works at the shared address for every organisation a person belongs
--    to (pulse.account_sign_in, replaced): until the person sets one password for all their workspaces, any of their
--    organisations' own passwords opens the account. A password a company issued with "change at first sign-in" lands
--    in that company, where the change is asked first. Two-step verification is never skipped: an account with it goes
--    through its organisation's own sign-in. A sign-in lands in the workspace used last (pulse.account_land).
--  * "One password for all your workspaces" (pulse.account_password_unify): the account's password, copied to each of
--    the person's organisation credentials, after proving one current password.
--  * Backfill: every active staff person with an active password credential gets an account. Person rows in different
--    organisations are linked into one account ONLY on the same verified e-mail (Google-linked identity, a confirmed
--    account e-mail, or the organisation's own Google Workspace directory), never on a name or a username; every link is
--    an audit row in that organisation (account_link). Anything that only looks alike (same name, same username, same
--    unconfirmed e-mail) is listed for HR/admin in pulse_priv.account_link_review and is not linked.
-- Safe on a live install: additive. Credentials, passwords and existing sessions are not changed by the migration.

-- ------------------------------------------------------------------------------------------------ review list
create table pulse_priv.account_link_review (
  org_id        uuid not null references pulse.org(id),
  person_id     uuid not null references pulse.person(id) on delete cascade,
  other_org     uuid not null references pulse.org(id),
  other_person  uuid not null references pulse.person(id) on delete cascade,
  reason        text not null check (reason in ('same_name','same_username','same_email_unverified')),
  status        text not null default 'open' check (status in ('open','linked','different')),
  found_at      timestamptz not null default now(),
  primary key (person_id, other_person)
);
alter table pulse_priv.account_link_review enable row level security;
alter table pulse_priv.account_link_review force row level security;
create policy tenant on pulse_priv.account_link_review using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on pulse_priv.account_link_review from public;

-- ------------------------------------------------------------------------------------------------ moving a session
-- The live session p_hash of a person of account p_account in p_from opens p_to instead (same token). Null when it may not.
create function pulse.acct_move(p_account uuid, p_hash text, p_from uuid, p_to uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m record; o record; s login_session%rowtype; ok boolean;
begin
  select * into m from pulse_priv.account_member where account_id = p_account and member_org = p_to;
  if m.person_id is null then return null; end if;
  select id, name, handle, status into o from org where id = p_to;
  if o.status is distinct from 'active' then return null; end if;
  perform acct_enter(p_from, null);
  select * into s from login_session where token_hash = p_hash and org_id = p_from and revoked_at is null and expires_at > now() for update;
  perform acct_leave();
  if s.token_hash is null or s.native_device_id is not null then return null; end if;
  if not exists (select 1 from pulse_priv.account_member where account_id = p_account and member_org = p_from and person_id = s.person_id) then return null; end if;
  if p_from <> p_to then
    perform acct_enter(p_to, m.person_id);
    select exists (select 1 from person where id = m.person_id and status = 'active') into ok;
    perform acct_leave();
    if not ok then return null; end if;
    perform acct_enter(p_from, s.person_id);
    update login_session set token_hash = 'moved:' || replace(gen_random_uuid()::text, '-', ''), revoked_at = now() where token_hash = p_hash and org_id = p_from;
    perform audit_write('org_switch', 'organisation', p_to::text);
    perform acct_leave();
    perform acct_enter(p_to, m.person_id);
    insert into login_session(org_id, person_id, token_hash, expires_at, device, remembered, via, second_factor_verified)
    values (p_to, m.person_id, p_hash, s.expires_at, s.device, s.remembered, 'account', s.second_factor_verified);
    perform audit_write('org_switch_in', 'organisation', p_from::text);
    perform acct_leave();
  end if;
  update pulse_priv.account_member set last_used_at = now() where account_id = p_account and member_org = p_to;
  update pulse_priv.pulse_account set last_org = p_to, updated_at = now() where id = p_account;
  return jsonb_build_object('org', p_to, 'name', o.name, 'handle', o.handle, 'person', m.person_id, 'kind', m.kind,
    'install', p_to = install_org(), 'moved', true);
end $$;
revoke all on function pulse.acct_move(uuid, text, uuid, uuid) from public;

-- Switch organisation with the session the request came with (the API passes its hash): the same token, now there.
create function pulse.account_move(p_org uuid, p_current text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid; r jsonb;
begin
  if current_viewer() is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  v := coalesce(account_of_viewer(), account_ensure());
  if not exists (select 1 from pulse_priv.account_member where account_id = v and member_org = p_org) then
    raise exception 'You are not a member of that organisation' using errcode = '42501'; end if;
  r := acct_move(v, p_current, current_org(), p_org);
  if r is null then raise exception 'Your place in that organisation is not active' using errcode = '42501'; end if;
  return r;
end $$;

-- Right after a sign-in in this organisation (the API passes the new session's hash): into the workspace used last.
-- Null when it stays here.
create function pulse.account_land(p_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s record; a uuid; t uuid; r jsonb; here uuid := current_org();
begin
  select person_id into s from login_session where token_hash = p_hash and org_id = here and revoked_at is null and expires_at > now();
  if s.person_id is null then return null; end if;
  select account_id into a from pulse_priv.account_member where person_id = s.person_id and member_org = here;
  if a is null then return null; end if;
  for t in select m.member_org from pulse_priv.account_member m join org o on o.id = m.member_org and o.status = 'active'
      where m.account_id = a order by (m.member_org = (select last_org from pulse_priv.pulse_account where id = a)) desc, m.last_used_at desc nulls last loop
    if t = here then
      update pulse_priv.account_member set last_used_at = now() where account_id = a and member_org = here;
      update pulse_priv.pulse_account set last_org = here where id = a;
      return null;
    end if;
    r := acct_move(a, p_hash, here, t);
    if r is not null then return r; end if;
  end loop;
  return null;
end $$;
revoke all on function pulse.account_land(text) from public;
grant execute on function pulse.account_land(text) to pulse_api;

-- ------------------------------------------------------------------------------------------------ signing in
-- A person's credential in an organisation that a password opens (null when it does not); counts nothing on a miss.
create function pulse.acct_cred_match(p_org uuid, p_person uuid, p_password text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare c login_credential%rowtype; ok boolean := false;
begin
  perform acct_enter(p_org, p_person);
  select lc.* into c from login_credential lc join person p on p.id = lc.person_id
   where lc.org_id = p_org and lc.person_id = p_person and lc.status = 'active' and p.status = 'active' and p.side = 'staff'
     and (lc.locked_until is null or lc.locked_until <= now()) and not (lc.must_change and lc.issued_at < now() - interval '7 days')
     and google_password_allowed(p_person);
  if c.person_id is not null and c.password_hash = crypt(p_password, c.password_hash) then
    ok := true;
    update login_credential set failed_attempts = 0, locked_until = null, last_login_at = now() where org_id = p_org and person_id = p_person;
  end if;
  perform acct_leave();
  return case when ok then jsonb_build_object('org', p_org, 'mustChange', c.must_change) end;
end $$;
revoke all on function pulse.acct_cred_match(uuid, uuid, text) from public;

-- Whether any person of the account uses two-step verification in their organisation.
create function pulse.acct_two_step(p_account uuid) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m record; yes boolean := false;
begin
  for m in select member_org, person_id from pulse_priv.account_member where account_id = p_account loop
    perform acct_enter(m.member_org, null);
    select exists (select 1 from pulse_priv.auth_account where org_id = m.member_org and realm = 'staff' and actor = m.person_id and totp is not null) into yes;
    perform acct_leave();
    if yes then return true; end if;
  end loop;
  return false;
end $$;
revoke all on function pulse.acct_two_step(uuid) from public;

-- Sign in at the shared address with a username, @handle or e-mail, into the workspace used last. The account's own
-- password, or (until one is set) any password of the person's organisations.
create or replace function pulse.account_sign_in(p_login text, p_password text, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare l text := lower(btrim(coalesce(p_login, ''))); cand uuid[] := '{}'; x uuid[]; o record; a pulse_priv.pulse_account%rowtype;
  cid uuid; hit uuid; hits int := 0; locked boolean := false; matched jsonb; hit_match jsonb; m record; target uuid; r jsonb; members int;
begin
  if l = '' or coalesce(p_password, '') = '' or octet_length(p_password) > 72 then perform crypt('x', gen_salt('bf', 10)); return null; end if;
  select coalesce(array_agg(pa.id), '{}') into cand from pulse_priv.pulse_account pa where pa.handle = ltrim(l, '@') or pa.email = l;
  -- A member's username or e-mail in any organisation, each read under its own organisation's row security.
  for o in select org.id from org where org.status = 'active' loop
    perform acct_enter(o.id, null);
    select coalesce(array_agg(distinct am.account_id), '{}') into x from people_profile pp
      join pulse_priv.account_member am on am.person_id = pp.person_id and am.member_org = o.id
     where pp.org_id = o.id and (pp.username = l or lower(btrim(pp.email)) = l);
    perform acct_leave();
    cand := cand || x;
  end loop;
  select coalesce(array_agg(distinct u), '{}') into cand from unnest(cand) u;
  if cardinality(cand) = 0 then perform crypt('x', gen_salt('bf', 10)); return null; end if;
  foreach cid in array cand loop
    select * into a from pulse_priv.pulse_account where pulse_account.id = cid;
    if a.locked_until > now() then locked := true; continue; end if;
    matched := null;
    if a.password_hash is not null then
      if a.password_hash = crypt(p_password, a.password_hash) then matched := jsonb_build_object('account', true); end if;
    else
      for m in select am.member_org, am.person_id from pulse_priv.account_member am join org on org.id = am.member_org and org.status = 'active'
          where am.account_id = a.id order by (am.member_org = a.last_org) desc, am.last_used_at desc nulls last loop
        matched := acct_cred_match(m.member_org, m.person_id, p_password);
        exit when matched is not null;
      end loop;
    end if;
    if matched is not null then hits := hits + 1; hit := a.id; hit_match := matched; end if;
  end loop;
  if hits = 0 then
    if cardinality(cand) = 1 then
      update pulse_priv.pulse_account set failed = case when failed >= 4 then 0 else failed + 1 end,
        locked_until = case when failed >= 4 then now() + interval '15 minutes' end where pulse_account.id = cand[1] and password_hash is not null;
    end if;
    return jsonb_build_object('failed', true, 'locked', locked and cardinality(cand) = 1);
  end if;
  -- The same login and password open two different people: nobody is guessed, the organisation's own sign-in decides.
  if hits > 1 then return jsonb_build_object('failed', true, 'ambiguous', true); end if;
  if acct_two_step(hit) then return jsonb_build_object('failed', true, 'twoStep', true); end if;
  update pulse_priv.pulse_account set failed = 0, locked_until = null where pulse_account.id = hit;
  select * into a from pulse_priv.pulse_account where pulse_account.id = hit;
  select count(*) into members from pulse_priv.account_member where account_id = hit;
  -- A company-issued password to change first lands in that company, where the change is asked.
  if coalesce((hit_match ->> 'mustChange')::boolean, false) then
    r := acct_session(hit, (hit_match ->> 'org')::uuid, p_hash, p_device);
    return case when r is null then jsonb_build_object('failed', true, 'noOrg', true) else r || jsonb_build_object('mustChange', true) end;
  end if;
  for target in select am.member_org from pulse_priv.account_member am join org on org.id = am.member_org and org.status = 'active'
      where am.account_id = hit order by (am.member_org = a.last_org) desc, am.last_used_at desc nulls last loop
    -- Never land where a password still waits to be changed, unless that is the one typed.
    perform acct_enter(target, null);
    if exists (select 1 from login_credential lc join pulse_priv.account_member am on am.person_id = lc.person_id
                where am.account_id = hit and am.member_org = target and lc.org_id = target and lc.status = 'active' and lc.must_change)
       and target is distinct from (hit_match ->> 'org')::uuid then
      perform acct_leave(); continue;
    end if;
    perform acct_leave();
    r := acct_session(hit, target, p_hash, p_device);
    if r is not null then
      return r || jsonb_build_object('unify', a.password_hash is null and members > 1);
    end if;
  end loop;
  return jsonb_build_object('failed', true, 'noOrg', true);
end $$;

-- One password for all your workspaces: prove one current password (the account's or any organisation's), then the
-- new one is the account's and every organisation credential of this person's (no change at next sign-in).
create function pulse.account_password_unify(p_current text, p_next text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare v uuid := account_of_viewer(); a pulse_priv.pulse_account%rowtype; ok boolean := false; m record; h text; n int := 0; here uuid := current_org(); me uuid := current_viewer();
  c login_credential%rowtype;
begin
  if me is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  if v is null then v := account_ensure(); end if;
  select * into a from pulse_priv.pulse_account where id = v;
  if a.locked_until > now() then return jsonb_build_object('error', 'Too many attempts. Try again in 15 minutes.'); end if;
  if coalesce(p_current, '') = '' or octet_length(p_current) > 72 or coalesce(p_next, '') = '' or octet_length(p_next) > 72 then
    raise exception 'Type your current password and a new one' using errcode = '22023'; end if;
  if a.password_hash is not null then ok := a.password_hash = crypt(p_current, a.password_hash); end if;
  if not ok then
    for m in select member_org, person_id from pulse_priv.account_member where account_id = v loop
      perform acct_enter(m.member_org, m.person_id);
      select * into c from login_credential where org_id = m.member_org and person_id = m.person_id and status = 'active';
      ok := c.person_id is not null and c.password_hash = crypt(p_current, c.password_hash);
      perform acct_leave();
      exit when ok;
    end loop;
  end if;
  if not ok then
    -- An answer, not an exception, so the count of misses is kept.
    update pulse_priv.pulse_account set failed = case when failed >= 4 then 0 else failed + 1 end,
      locked_until = case when failed >= 4 then now() + interval '15 minutes' end where id = v;
    return jsonb_build_object('error', 'That is not one of your current passwords');
  end if;
  h := crypt(p_next, gen_salt('bf', 10));
  update pulse_priv.pulse_account set password_hash = h, failed = 0, locked_until = null, updated_at = now() where id = v;
  for m in select member_org, person_id from pulse_priv.account_member where account_id = v loop
    perform acct_enter(m.member_org, m.person_id);
    update login_credential set password_hash = h, must_change = false, failed_attempts = 0, locked_until = null
     where org_id = m.member_org and person_id = m.person_id and status = 'active';
    if found then n := n + 1; perform audit_write('password_unified', 'login_credential', m.person_id::text); end if;
    perform acct_leave();
  end loop;
  return jsonb_build_object('ok', true, 'workspaces', n) || jsonb_build_object('account', account_me());
end $$;

-- account_me (0920) with `unify`: a person in more than one workspace who has no one password yet is asked once.
create or replace function pulse.account_me() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); a record; r record; v_suggest text;
begin
  if current_viewer() is null then return null; end if;
  if v is null then
    select p.display_name, pp.username into r from person p left join people_profile pp on pp.person_id = p.id where p.id = current_viewer();
    v_suggest := handle_suggest(coalesce(nullif(replace(coalesce(r.username, ''), '.', ''), ''), r.display_name));
    return jsonb_build_object('account', null, 'suggestion', v_suggest,
      'orgs', jsonb_build_array((select jsonb_build_object('id', o.id, 'name', o.name, 'handle', o.handle, 'code', o.code, 'kind', 'staff', 'current', true) from org o where o.id = current_org())),
      'invites', '[]'::jsonb, 'unify', false);
  end if;
  select * into a from pulse_priv.pulse_account where id = v;
  return jsonb_build_object(
    'account', jsonb_build_object('id', a.id, 'handle', a.handle, 'name', a.display_name, 'email', a.email, 'hasPassword', a.password_hash is not null),
    'orgs', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'handle', o.handle, 'code', o.code, 'kind', m.kind,
        'current', o.id = current_org(), 'lastUsedAt', m.last_used_at, 'install', o.id = install_org()) order by (o.id = current_org()) desc, m.last_used_at desc nulls last, o.name)
      from pulse_priv.account_member m join org o on o.id = m.member_org where m.account_id = v and o.status = 'active'), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'org', o.name, 'orgHandle', o.handle, 'kind', i.kind, 'title', i.title, 'at', i.created_at) order by i.created_at desc)
      from pulse_priv.org_invite i join org o on o.id = i.org_id
      where i.to_handle = a.handle and i.status = 'open' and i.expires_at > now() and o.status = 'active'
        and not exists (select 1 from pulse_priv.account_member m where m.account_id = v and m.member_org = i.org_id)), '[]'::jsonb),
    'unify', a.password_hash is null and (select count(*) from pulse_priv.account_member m join org o on o.id = m.member_org and o.status = 'active' where m.account_id = v) > 1);
end $$;

-- ------------------------------------------------------------------------------------------------ backfill
do $$
declare o record; p record; e record; h text; v uuid; accts uuid[]; n_acct int := 0; n_link int := 0; n_review int := 0; k text;
begin
  perform set_config('pulse.actor_account', 'migration:1291 AUTH-UNIFY', true);
  create temp table au_people(org uuid, person uuid, name text, username text, email text, verified text[], has_cred boolean, account uuid) on commit drop;
  for o in select id from pulse.org where status = 'active' loop
    perform pulse.acct_enter(o.id, null);
    insert into au_people
    select o.id, per.id, per.display_name, lower(nullif(btrim(pp.username), '')), lower(nullif(btrim(pp.email), '')),
      array_remove(array[
        (select lower(g.email) from pulse_priv.google_identity g where g.org_id = o.id and g.person_id = per.id),
        (select lower(w.email) from pulse_priv.workspace_account w where w.org_id = o.id and lower(w.email) = lower(btrim(pp.email)) and not w.suspended),
        (select lower(pa.email) from pulse_priv.account_member am join pulse_priv.pulse_account pa on pa.id = am.account_id
          where am.person_id = per.id and pa.email_confirmed_at is not null)], null),
      exists (select 1 from pulse.login_credential lc where lc.org_id = o.id and lc.person_id = per.id and lc.status = 'active'),
      (select am.account_id from pulse_priv.account_member am where am.person_id = per.id)
    from pulse.person per left join pulse.people_profile pp on pp.person_id = per.id and pp.org_id = per.org_id
    where per.org_id = o.id and per.status = 'active' and per.side = 'staff';
    perform pulse.acct_leave();
  end loop;

  -- 1. The same verified e-mail in more than one organisation, held by exactly one person in each: one human.
  for e in select ve, array_agg(distinct org) orgs from au_people, unnest(verified) ve group by ve
      having count(distinct org) > 1 and count(*) = count(distinct org) loop
    select coalesce(array_agg(distinct account), '{}') into accts from au_people where e.ve = any(verified) and account is not null;
    if cardinality(accts) > 1 then continue; end if;                       -- two accounts already: HR decides
    v := accts[1];
    if v is null then
      select * into p from au_people where e.ve = any(verified) order by has_cred desc, org limit 1;
      h := pulse.handle_suggest(coalesce(nullif(split_part(coalesce(p.username, ''), '.', 1) || split_part(coalesce(p.username, ''), '.', 2), ''), p.name));
      insert into pulse_priv.pulse_account(handle, display_name, email, last_org)
      values (h, p.name, case when not exists (select 1 from pulse_priv.pulse_account x where x.email = e.ve) then e.ve end, p.org) returning id into v;
      insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', v);
      n_acct := n_acct + 1;
    end if;
    for p in select * from au_people where e.ve = any(verified) and account is null loop
      if exists (select 1 from pulse_priv.account_member where account_id = v and member_org = p.org) then continue; end if;
      insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (v, p.org, p.person, 'staff');
      update au_people set account = v where person = p.person;
      perform pulse.acct_enter(p.org, null);
      perform pulse.audit_write('account_link', 'person', p.person::text, array['verified_email']);
      perform pulse.acct_leave();
      n_link := n_link + 1;
    end loop;
  end loop;

  -- 2. Everyone else who signs in with a password gets their own account (one organisation).
  for p in select * from au_people where has_cred and account is null order by org, name loop
    h := pulse.handle_suggest(coalesce(nullif(split_part(coalesce(p.username, ''), '.', 1) || split_part(coalesce(p.username, ''), '.', 2), ''), p.name));
    insert into pulse_priv.pulse_account(handle, display_name, email, last_org)
    values (h, p.name, case when p.email is not null and p.email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      and not exists (select 1 from pulse_priv.pulse_account x where x.email = p.email)
      and (select count(*) from au_people y where y.email = p.email) = 1 then p.email end, p.org) returning id into v;
    insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', v);
    insert into pulse_priv.account_member(account_id, member_org, person_id, kind, last_used_at) values (v, p.org, p.person, 'staff', null);
    update au_people set account = v where person = p.person;
    n_acct := n_acct + 1;
  end loop;

  -- 3. Look-alikes across organisations that are not one account: listed for HR/admin, never linked.
  for p in select a.org, a.person, b.org other_org, b.person other_person,
        case when a.email is not null and a.email = b.email then 'same_email_unverified'
             when a.username is not null and a.username = b.username then 'same_username' else 'same_name' end reason
      from au_people a join au_people b on a.org <> b.org and a.person <> b.person
     where (a.account is null or b.account is null or a.account <> b.account)
       and (lower(btrim(a.name)) = lower(btrim(b.name)) or (a.username is not null and a.username = b.username) or (a.email is not null and a.email = b.email)) loop
    perform pulse.acct_enter(p.org, null);
    insert into pulse_priv.account_link_review(org_id, person_id, other_org, other_person, reason)
    values (p.org, p.person, p.other_org, p.other_person, p.reason) on conflict do nothing;
    perform pulse.acct_leave();
    n_review := n_review + 1;
  end loop;
  raise notice 'AUTH-UNIFY backfill: % accounts made, % person rows linked by verified e-mail, % look-alike rows for review', n_acct, n_link, n_review;
end $$;

-- migrate:down
drop function if exists pulse.account_password_unify(text, text);
drop function if exists pulse.account_land(text);
drop function if exists pulse.account_move(uuid, text);
drop function if exists pulse.acct_move(uuid, text, uuid, uuid);
drop function if exists pulse.acct_cred_match(uuid, uuid, text);
drop function if exists pulse.acct_two_step(uuid);
drop table if exists pulse_priv.account_link_review;
-- account_sign_in and account_me keep their 1291 bodies (a superset of 0920's answers).
