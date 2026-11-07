-- migrate:up
-- WL-MOVE (owner, 6 Nov 2026: Willow Lane's people sign in at app.vitalsos.ai with their username or e-mail and password,
-- exactly as before). A staff person whose password credential was set after 1291's AUTH-UNIFY backfill (an invitation
-- or set-password link, a password HR issued) has no Pulse account, so at the shared address pulse.account_sign_in found
-- no candidate and refused them, although their own organisation's sign-in accepts the same username and password.
-- Now the same login also finds such account-less staff (active person, active credential, no account seat in that
-- organisation), each read under its own organisation's row security. Their organisation's credential is checked by
-- acct_cred_match, exactly as for an account without its own password (bcrypt, lock, issued-password age, Google-only
-- policy). Hits are counted across accounts and these people together: none fails as before, two or more is
-- ambiguous (nothing is made). Exactly one account-less person makes their account first, as 1291's backfill step 2
-- would have (handle from the username or name, the work e-mail only when no account has it, a seat in that
-- organisation, an account_link audit row there), and the sign-in then goes on unchanged: two-step is never skipped,
-- an issued password to change lands where it is changed. Nothing is made on a wrong password. Body otherwise 1442's.
create or replace function pulse.account_sign_in(p_login text, p_password text, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare own uuid := (select d.org_id from org_domain d where d.org_id = nullif(current_setting('pulse.org_id', true), '')::uuid limit 1);
  l text := lower(btrim(coalesce(p_login, ''))); cand uuid[] := '{}'; x uuid[]; o record; a pulse_priv.pulse_account%rowtype;
  cid uuid; hit uuid; hits int := 0; locked boolean := false; matched jsonb; hit_match jsonb; m record; target uuid; r jsonb; members int;
  lone_org uuid[] := '{}'; lone_person uuid[] := '{}'; y uuid[]; pid uuid; i int; new_org uuid; new_person uuid;
  nu_username text; nu_email text; nu_name text; h text;
begin
  if l = '' or coalesce(p_password, '') = '' or octet_length(p_password) > 72 then perform crypt('x', gen_salt('bf', 10)); return null; end if;
  select coalesce(array_agg(pa.id), '{}') into cand from pulse_priv.pulse_account pa where pa.handle = ltrim(l, '@') or pa.email = l;
  -- A member's username or e-mail in any organisation, each read under its own organisation's row security.
  for o in select org.id from org where org.status = 'active' loop
    perform acct_enter(o.id, null);
    select coalesce(array_agg(distinct am.account_id), '{}') into x from people_profile pp
      join pulse_priv.account_member am on am.person_id = pp.person_id and am.member_org = o.id
     where pp.org_id = o.id and (pp.username = l or lower(btrim(pp.email)) = l);
    -- WL-MOVE: staff with an active password here and no Pulse account yet.
    select coalesce(array_agg(distinct pp.person_id), '{}') into y from people_profile pp
      join person p on p.id = pp.person_id and p.org_id = o.id and p.status = 'active' and p.side = 'staff'
     where pp.org_id = o.id and (pp.username = l or lower(btrim(pp.email)) = l)
       and exists (select 1 from login_credential lc where lc.org_id = o.id and lc.person_id = pp.person_id and lc.status = 'active')
       and not exists (select 1 from pulse_priv.account_member am where am.person_id = pp.person_id and am.member_org = o.id);
    perform acct_leave();
    cand := cand || x;
    foreach pid in array y loop lone_org := lone_org || o.id; lone_person := lone_person || pid; end loop;
  end loop;
  select coalesce(array_agg(distinct u), '{}') into cand from unnest(cand) u;
  if cardinality(cand) = 0 and cardinality(lone_person) = 0 then perform crypt('x', gen_salt('bf', 10)); return null; end if;
  foreach cid in array cand loop
    select * into a from pulse_priv.pulse_account where pulse_account.id = cid;
    if a.locked_until > now() then locked := true; continue; end if;
    matched := null;
    if a.password_hash is not null then
      if a.password_hash = crypt(p_password, a.password_hash) then matched := jsonb_build_object('account', true); end if;
    else
      for m in select am.member_org, am.person_id from pulse_priv.account_member am join org on org.id = am.member_org and org.status = 'active'
          where am.account_id = a.id order by coalesce(am.member_org = own, false) desc, (am.member_org = a.last_org) desc, am.last_used_at desc nulls last loop
        matched := acct_cred_match(m.member_org, m.person_id, p_password);
        exit when matched is not null;
      end loop;
    end if;
    if matched is not null then hits := hits + 1; hit := a.id; hit_match := matched; end if;
  end loop;
  -- WL-MOVE: each account-less person's own organisation credential, the same check.
  for i in 1 .. cardinality(lone_person) loop
    matched := acct_cred_match(lone_org[i], lone_person[i], p_password);
    if matched is not null then hits := hits + 1; hit := null; hit_match := matched; new_org := lone_org[i]; new_person := lone_person[i]; end if;
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
  -- WL-MOVE: the one account-less person whose password this is gets their Pulse account now (1291's backfill, step 2).
  if hit is null then
    perform acct_enter(new_org, null);
    select lower(nullif(btrim(pp.username), '')), lower(nullif(btrim(pp.email), '')), per.display_name into nu_username, nu_email, nu_name
      from person per left join people_profile pp on pp.person_id = per.id and pp.org_id = per.org_id
     where per.id = new_person and per.org_id = new_org;
    perform acct_leave();
    h := handle_suggest(coalesce(nullif(split_part(coalesce(nu_username, ''), '.', 1) || split_part(coalesce(nu_username, ''), '.', 2), ''), nu_name));
    insert into pulse_priv.pulse_account(handle, display_name, email, last_org)
    values (h, nu_name, case when nu_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      and not exists (select 1 from pulse_priv.pulse_account x2 where lower(x2.email) = nu_email) then nu_email end, new_org) returning id into hit;
    insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', hit);
    insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (hit, new_org, new_person, 'staff');
    perform acct_enter(new_org, null);
    perform audit_write('account_link', 'person', new_person::text, array['first_sign_in']);
    perform acct_leave();
  end if;
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
      where am.account_id = hit order by coalesce(am.member_org = own, false) desc, (am.member_org = a.last_org) desc, am.last_used_at desc nulls last loop
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

-- migrate:down
-- 1442's body.
create or replace function pulse.account_sign_in(p_login text, p_password text, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare own uuid := (select d.org_id from org_domain d where d.org_id = nullif(current_setting('pulse.org_id', true), '')::uuid limit 1);
  l text := lower(btrim(coalesce(p_login, ''))); cand uuid[] := '{}'; x uuid[]; o record; a pulse_priv.pulse_account%rowtype;
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
          where am.account_id = a.id order by coalesce(am.member_org = own, false) desc, (am.member_org = a.last_org) desc, am.last_used_at desc nulls last loop
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
      where am.account_id = hit order by coalesce(am.member_org = own, false) desc, (am.member_org = a.last_org) desc, am.last_used_at desc nulls last loop
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
