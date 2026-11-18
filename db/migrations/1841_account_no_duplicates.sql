-- migrate:up
-- IDENTITY-SIGNIN (owner, 7 Nov 2026: "Datup and Azavez each ended up with two Pulse accounts"). Each duplicate had no
-- e-mail and was made on 28 Oct at 03:06: 1291's backfill step 2 gave every account-less staff record with a password
-- its own account, and its e-mail only when no other account had it. The same rule still runs live wherever a company's
-- record of a person gets an account on first use: pulse.account_ensure (0920; profile, switcher, invitations, the
-- shared-address link travel of 1540) and the account-less sign-in of account_sign_in (1569/1585). A person a second
-- company added by an e-mail that already belongs to an account therefore got a second, e-mail-less account.
--
-- Now a company's record of a person is first matched to the existing account its e-mail names (the record's work or
-- personal e-mail, or the e-mail of its linked Google sign-in, against an account's e-mail or a linked sign-in e-mail,
-- pulse_priv.account_login_email):
--  * Linked at once only on a proven match, the rule 1291 used: the account's address is verified (or a linked sign-in
--    e-mail) and the record's own Google sign-in is that same address. Never on a name, a username or a typed e-mail.
--  * Any other match (the address typed by HR, an unverified account address, more than one account, or an account that
--    already has a seat there) makes no account and links nothing: the record stays unlinked. When the account's address
--    is verified, the company's invitation to that account (@handle, to that e-mail) is opened, and accepting it from the
--    signed-in account links this record (1463/1540 acct_join): the account's own proof, never HR's typing.
--  * A new account is made only when no account matches, as before.
-- HR adding or editing a person with such an e-mail opens the same invitation (pulse.people_account_offer) and is told so.
-- Safe on a live install: functions only; nothing is linked, merged or made by the migration.

-- ------------------------------------------------------------------------------------------------ matching
-- The existing account a company's record of a person names by e-mail. Runs in that company (current_org). Internal.
-- {account, handle, email, verified, seated, proven} or {ambiguous}; null when no account matches.
create function pulse.acct_seat_match(p_org uuid, p_person uuid) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare mails text[]; google text; accts uuid[]; a pulse_priv.pulse_account%rowtype; mail text; good text;
begin
  if p_org is distinct from current_org() then raise exception 'A record is matched inside its own organisation' using errcode = '42501'; end if;
  select array_remove(array[lower(nullif(btrim(pp.email), '')), lower(nullif(btrim(hc.personal_email), ''))], null) into mails
    from person per left join people_profile pp on pp.person_id = per.id and pp.org_id = per.org_id
    left join pulse_priv.hr_contact hc on hc.org_id = per.org_id and hc.person_id = per.id
   where per.id = p_person and per.org_id = p_org;
  select lower(btrim(g.email)) into google from pulse_priv.google_identity g where g.org_id = p_org and g.person_id = p_person limit 1;
  mails := array_remove(coalesce(mails, '{}') || google, null);
  if cardinality(mails) = 0 then return null; end if;
  select coalesce(array_agg(distinct x.id), '{}') into accts from (
    select pa.id from pulse_priv.pulse_account pa where lower(btrim(pa.email)) = any(mails)
    union select le.account_id from pulse_priv.account_login_email le where le.email = any(mails)) x;
  if cardinality(accts) = 0 then return null; end if;
  if cardinality(accts) > 1 then return jsonb_build_object('ambiguous', true); end if;
  select * into a from pulse_priv.pulse_account where id = accts[1];
  -- The address that names the account; "verified" when the account proved it (a code, a link) or it is a sign-in e-mail.
  foreach mail in array mails loop
    if (mail = lower(btrim(a.email)) and coalesce(a.email_verified_at, a.email_confirmed_at) is not null)
       or exists (select 1 from pulse_priv.account_login_email le where le.account_id = a.id and le.email = mail) then good := mail; exit; end if;
  end loop;
  return jsonb_build_object('account', a.id, 'handle', a.handle, 'email', coalesce(good, lower(btrim(a.email))), 'verified', good is not null,
    'seated', exists (select 1 from pulse_priv.account_member am where am.account_id = a.id and am.member_org = p_org),
    'proven', good is not null and google is not null and google = good);
end $$;
revoke all on function pulse.acct_seat_match(uuid, uuid) from public;

-- A proven match links the record to its account now (1291's rule); the account, or null. Runs in the record's company.
create function pulse.acct_seat_attach(p_person uuid) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m jsonb := acct_seat_match(current_org(), p_person); v uuid; v_side text;
begin
  if m is null or coalesce((m ->> 'proven')::boolean, false) is not true or coalesce((m ->> 'seated')::boolean, true) then return null; end if;
  if exists (select 1 from pulse_priv.account_member where person_id = p_person) then return null; end if;
  v := (m ->> 'account')::uuid;
  select side into v_side from person where id = p_person and org_id = current_org();
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind, last_used_at) values (v, current_org(), p_person, acct_kind(v_side), now());
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (current_org(), 'person', p_person, 'account', null, 'Linked to Pulse account @' || (m ->> 'handle') || ' by its verified e-mail ' || (m ->> 'email'), null);
  perform audit_write('account_link', 'person', p_person::text, array['verified_email']);
  return v;
end $$;
revoke all on function pulse.acct_seat_attach(uuid) from public;

-- The company's invitation to the account a record names by its verified e-mail (one open invitation per account), so
-- that accepting it from that account links this record. {handle, offered} or the match without an offer; null when
-- nothing matches. Runs in the record's company. Internal (people_account_offer is HR's door).
create function pulse.acct_seat_offer(p_person uuid, p_by uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m jsonb := acct_seat_match(current_org(), p_person); p record; v_kind text; v_id uuid;
begin
  if m is null then return null; end if;
  if coalesce((m ->> 'ambiguous')::boolean, false) then return jsonb_build_object('ambiguous', true, 'offered', false); end if;
  if exists (select 1 from pulse_priv.account_member where person_id = p_person) then return null; end if;
  select per.side, per.status, left(nullif(btrim(pp.role), ''), 80) title into p from person per
    left join people_profile pp on pp.person_id = per.id and pp.org_id = per.org_id where per.id = p_person and per.org_id = current_org();
  v_kind := acct_kind(p.side);
  -- An unverified address never tells HR whose account it is.
  if not (m ->> 'verified')::boolean then return jsonb_build_object('offered', false); end if;
  if (m ->> 'seated')::boolean or p.status is distinct from 'active' or v_kind not in ('staff', 'freelancer', 'client') then
    return jsonb_build_object('handle', m ->> 'handle', 'offered', false, 'seated', (m ->> 'seated')::boolean);
  end if;
  select id into v_id from pulse_priv.org_invite where org_id = current_org() and to_handle = m ->> 'handle' and status = 'open' and expires_at > now() limit 1;
  if v_id is null then
    insert into pulse_priv.org_invite(org_id, kind, title, to_handle, to_email, invited_by, expires_at)
    values (current_org(), v_kind, p.title, m ->> 'handle', m ->> 'email', p_by, now() + interval '30 days') returning id into v_id;
    perform audit_write('account_offer', 'person', p_person::text, array['verified_email']);
  end if;
  return jsonb_build_object('handle', m ->> 'handle', 'offered', true, 'invite', v_id);
end $$;
revoke all on function pulse.acct_seat_offer(uuid, uuid) from public;

-- HR or an admin added or changed a person: when the e-mail belongs to an existing account, that account is invited
-- (no second account is ever made for them). {handle, offered}, {offered: false} (an address the account has not
-- proved: nothing is linked or offered, and no second account is made later either), or null (no account matches).
create function pulse.people_account_offer(p_person uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  -- Nobody else learns whose account an address is (the API asks only after HR's own add or edit went through).
  if current_viewer() is null or not (viewer_is('admin') or viewer_is('hr') or viewer_is('leadership')) then return null; end if;
  return acct_seat_offer(p_person, current_viewer());
end $$;
revoke all on function pulse.people_account_offer(uuid) from public;
grant execute on function pulse.people_account_offer(uuid) to pulse_api;

-- ------------------------------------------------------------------------------------------------ first use
-- 0920's account on first use, which no longer makes a second account for a person whose e-mail already has one.
create or replace function pulse.account_ensure() returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); r record; h text; m jsonb;
begin
  if v is not null then return v; end if;
  if current_viewer() is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  v := acct_seat_attach(current_viewer());
  if v is not null then return v; end if;
  m := acct_seat_match(current_org(), current_viewer());
  if m is not null then
    if coalesce((m ->> 'ambiguous')::boolean, false) then
      raise exception 'Your e-mail on this company''s record belongs to more than one account. Ask this company''s HR to check the e-mail on your record.' using errcode = '42501'; end if;
    raise exception 'This company has you as %, the e-mail of an existing account. Sign in to that account and accept this company''s invitation: the company is then added to it.', m ->> 'email' using errcode = '42501';
  end if;
  select p.display_name, p.side, pp.username, lower(pp.email) email into r from person p left join people_profile pp on pp.person_id = p.id where p.id = current_viewer();
  h := handle_suggest(coalesce(nullif(split_part(coalesce(r.username, ''), '.', 1) || split_part(coalesce(r.username, ''), '.', 2), ''), r.display_name));
  insert into pulse_priv.pulse_account(handle, display_name, email, last_org)
  values (h, r.display_name, case when r.email is not null and not exists (select 1 from pulse_priv.pulse_account a where a.email = r.email) then r.email end, current_org())
  returning id into v;
  insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', v);
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind, last_used_at) values (v, current_org(), current_viewer(), acct_kind(r.side), now());
  return v;
end $$;

-- The same, where a sign-in must go on without an account: null (and the invitation opened) instead of a refusal.
create function pulse.acct_ensure_soft() returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer();
begin
  if v is not null or current_viewer() is null then return v; end if;
  v := acct_seat_attach(current_viewer());
  if v is not null then return v; end if;
  if acct_seat_match(current_org(), current_viewer()) is not null then perform acct_seat_offer(current_viewer(), null); return null; end if;
  return account_ensure();
end $$;
revoke all on function pulse.acct_ensure_soft() from public;

-- 1540's link travel: the session still travels to the shared address; the account seat only when it is not a duplicate.
create or replace function pulse.auth_link_travel(p_hash text, p_person uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid;
begin
  update login_session set via = 'account' where org_id = current_org() and token_hash = p_hash and person_id = p_person and revoked_at is null;
  if not found then return; end if;
  perform set_config('pulse.viewer_id', p_person::text, true);
  v := acct_ensure_soft();
  if v is null then return; end if;
  update pulse_priv.account_member set last_used_at = now() where account_id = v and member_org = current_org();
  update pulse_priv.pulse_account set last_org = current_org(), updated_at = now() where id = v;
end $$;

-- ------------------------------------------------------------------------------------------------ the shared sign-in
-- 1585's account_sign_in. The one account-less record whose password this is (WL-MOVE) gets an account only when its
-- e-mail names none: a proven match is linked to that account, any other match answers {failed, linkPending} (the
-- account is invited; accepting from it links the record). Body otherwise 1585's.
create or replace function pulse.account_sign_in(p_login text, p_password text, p_hash text, p_device text, p_challenge text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pulse', 'public', 'pg_temp'
as $function$
declare own uuid := (select d.org_id from org_domain d where d.org_id = nullif(current_setting('pulse.org_id', true), '')::uuid limit 1);
  l text := lower(btrim(coalesce(p_login, ''))); cand uuid[] := '{}'; x uuid[]; o record; a pulse_priv.pulse_account%rowtype;
  cid uuid; hit uuid; hits int := 0; locked boolean := false; matched jsonb; hit_match jsonb; m record; target uuid; r jsonb; members int;
  lone_org uuid[] := '{}'; lone_person uuid[] := '{}'; y uuid[]; pid uuid; i int; new_org uuid; new_person uuid;
  nu_username text; nu_email text; nu_name text; h text; nu_match jsonb;
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
  -- IDENTITY-SIGNIN: unless their e-mail already names an account: linked on a proven match, otherwise left unlinked
  -- with that account invited (never a second account).
  if hit is null then
    perform acct_enter(new_org, null);
    hit := acct_seat_attach(new_person);
    if hit is null then
      nu_match := acct_seat_match(new_org, new_person);
      if nu_match is not null then perform acct_seat_offer(new_person, null); end if;
    end if;
    select lower(nullif(btrim(pp.username), '')), lower(nullif(btrim(pp.email), '')), per.display_name into nu_username, nu_email, nu_name
      from person per left join people_profile pp on pp.person_id = per.id and pp.org_id = per.org_id
     where per.id = new_person and per.org_id = new_org;
    perform acct_leave();
    if hit is null and nu_match is not null then return jsonb_build_object('failed', true, 'linkPending', true); end if;
  end if;
  if hit is null then
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
  if acct_two_step(hit) then
    if acct_challenge_begin(hit, p_challenge, p_device, own) then return jsonb_build_object('twoStep', true, 'challenge', true); end if;
    return jsonb_build_object('failed', true, 'twoStep', true);
  end if;
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
end $function$;

-- 1569's 4-argument form (no account challenge) answers as the 5-argument form without one: one body, one rule.
create or replace function pulse.account_sign_in(p_login text, p_password text, p_hash text, p_device text) returns jsonb
  language sql security definer set search_path = pulse, public, pg_temp as $$
  select pulse.account_sign_in(p_login, p_password, p_hash, p_device, null::text)
$$;

-- migrate:down
-- Forward-only: account_ensure, auth_link_travel and account_sign_in keep these bodies (they only refuse to make a
-- duplicate); the helpers stay.
