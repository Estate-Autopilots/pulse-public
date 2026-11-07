-- migrate:up
-- SIGNIN-OFFICE (owner, 30 Oct 2026: "am not able to login to AC's Pulse"). Signed out at an organisation's own
-- address (an org_domain row: the sign-in runs in that organisation), the Pulse-account sign-in opens that
-- organisation when the account belongs to it, as the staff sign-in there already does; at the shared address it
-- still opens the workspace used last. The same order picks whose password is checked first. Body otherwise 1291's.
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

-- migrate:down
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
