-- migrate:up
-- IDENTITY-UNIFY (owner, 7 Nov 2026): his profile showed a different handle in every company (four variants of
-- his name, with and without digits and a dot): "we were to consolidate all IDs together. It's not happening". The merge
-- (1535) made one Pulse account, but every company seat kept its own username (pulse.people_profile.username, unique
-- per company), and the app shows that username everywhere: People, chats, mentions, tasks, search.
--
-- Now the username is the account's: one @handle per person, the same in every company.
--  * Every seat of a Pulse account takes the account's handle as its username (pulse.account_username_sync): now for
--    everyone (the backfill at the end), and from then on when the handle changes (Change your @handle, a merge's
--    rename), when a seat joins or moves to an account (a new company, a merge, an unmerge) and when a seat's profile
--    row is made for a person who already has an account.
--  * The old username is kept as an alias in that company (pulse.person_username_alias, forced row security, tenant
--    policy), so it still signs the person in there (auth_login_name; auth_old_name for the e-mailed staff code and
--    Forgot your password), at the shared address (login_alias, called by the API before account_sign_in and the
--    e-mailed account code; an old handle too), and still marks old @mentions in chats (mentions are stored as person
--    ids, so they reach the person anyway). "@name" keeps meaning the Pulse account, as before.
--  * When someone else in a company already has that username, the seat keeps its own (nobody is renamed for another
--    person); the person's profile page says where (account_names). An AI employee's seat is never renamed.
--  * Every rename is in that company's record history (record_change: username, old, new). Nothing is sent to anyone.
--  * account_card: the person always sees their whole shared profile, career and contact included, in every company
--    (others still see career and contact only where the person ticked them).
-- Safe on a live install: one transaction; no account, seat or person is made, linked, merged or removed.

-- ------------------------------------------------------------------------------------------------ old usernames
create table pulse.person_username_alias (
  org_id      uuid not null references pulse.org(id),
  username    text not null check (username ~ '^[a-z0-9][a-z0-9._-]{2,39}$'),
  person_id   uuid not null references pulse.person(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (org_id, username)
);
create index person_username_alias_person on pulse.person_username_alias(person_id);
alter table pulse.person_username_alias enable row level security;
alter table pulse.person_username_alias force row level security;
create policy tenant_isolation on pulse.person_username_alias using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- The shared address finds an old username before it knows the company (definer functions, as account_alumni).
create policy directory on pulse.person_username_alias for select
  using (current_user = (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'pulse'));
revoke all on pulse.person_username_alias from public;
grant select on pulse.person_username_alias to pulse_api;

-- ------------------------------------------------------------------------------------------------ one username
-- Every seat of the account (or only p_person's) takes the account's handle as its username in that company. The old
-- one becomes an alias there. A seat keeps its own when another person there has the handle as username.
-- {handle, changed, kept: [{org, company, username}]}. Internal.
create function pulse.account_username_sync(p_account uuid, p_person uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o text := coalesce(current_setting('pulse.org_id', true), ''); vw text := coalesce(current_setting('pulse.viewer_id', true), '');
  h text; m record; cur text; other uuid; n int := 0; kept jsonb := '[]'::jsonb;
begin
  select handle into h from pulse_priv.pulse_account where id = p_account;
  if h is null then return null; end if;
  for m in select am.member_org, am.person_id, g.name from pulse_priv.account_member am join org g on g.id = am.member_org
      where am.account_id = p_account and (p_person is null or am.person_id = p_person) order by am.joined_at loop
    perform set_config('pulse.org_id', m.member_org::text, true);
    perform set_config('pulse.viewer_id', '', true);
    cur := null; other := null;
    select pp.username into cur from people_profile pp join person p on p.id = pp.person_id and p.side <> 'agent'
     where pp.person_id = m.person_id and pp.org_id = m.member_org;
    if found and cur is distinct from h then
      select pp.person_id into other from people_profile pp where pp.org_id = m.member_org and pp.username = h and pp.person_id <> m.person_id;
      if other is not null then
        kept := kept || jsonb_build_array(jsonb_build_object('org', m.member_org, 'company', m.name, 'username', cur));
      else
        if cur is not null then
          insert into person_username_alias(org_id, username, person_id) values (m.member_org, cur, m.person_id)
          on conflict (org_id, username) do update set person_id = excluded.person_id, created_at = now();
        end if;
        -- The handle is a real username here now: an older alias of the same name (anyone's) gives way to it.
        delete from person_username_alias where org_id = m.member_org and username = h;
        update people_profile set username = h, updated_at = now() where person_id = m.person_id and org_id = m.member_org;
        insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
        values (m.member_org, 'person', m.person_id, 'username', cur, h, null);
        n := n + 1;
      end if;
    end if;
  end loop;
  perform set_config('pulse.org_id', o, true);
  perform set_config('pulse.viewer_id', vw, true);
  return jsonb_build_object('handle', h, 'changed', n, 'kept', kept);
end $$;

-- The handle changed, or a seat joined or moved to an account: its seats follow.
create function pulse.account_username_follow() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if tg_table_name = 'pulse_account' then
    perform account_username_sync(new.id, null);
  else
    perform account_username_sync(new.account_id, new.person_id);
  end if;
  return null;
end $$;
create trigger account_handle_follow after update of handle on pulse_priv.pulse_account
  for each row when (new.handle is distinct from old.handle) execute function pulse.account_username_follow();
create trigger account_member_username after insert or update of account_id on pulse_priv.account_member
  for each row execute function pulse.account_username_follow();

-- A profile row made for a person who already has an account: the account's handle from the start (nothing to alias).
create function pulse.people_profile_handle() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o text := coalesce(current_setting('pulse.org_id', true), ''); h text; taken boolean := true;
begin
  select a.handle into h from pulse_priv.account_member am join pulse_priv.pulse_account a on a.id = am.account_id where am.person_id = new.person_id;
  if h is null or new.username is not distinct from h then return new; end if;
  perform set_config('pulse.org_id', new.org_id::text, true);
  if exists (select 1 from person where id = new.person_id and org_id = new.org_id and side <> 'agent') then
    taken := exists (select 1 from people_profile where org_id = new.org_id and username = h);
  end if;
  perform set_config('pulse.org_id', o, true);
  if not taken then new.username := h; end if;
  return new;
end $$;
create trigger people_profile_handle before insert on pulse.people_profile for each row execute function pulse.people_profile_handle();

-- ------------------------------------------------------------------------------------------------ old names still sign in
-- A company's own sign-in (SIGNIN-OFFICE, 1441), plus an old username of a person here (kept when their username became
-- their Pulse handle). A name someone has today wins. "@handle" stays the Pulse account's (the account sign-in reads it).
create or replace function pulse.auth_login_name(r text, input text) returns text
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare v text := lower(btrim(coalesce(input, ''))); n int; u text;
begin
  if position('@' in v) = 0 then
    if r <> 'staff' or v = '' or exists (select 1 from people_profile where org_id = current_org() and username = v) then return v; end if;
    select pp.username into u from person_username_alias al join people_profile pp on pp.person_id = al.person_id and pp.org_id = al.org_id
     where al.org_id = current_org() and al.username = v;
    return coalesce(u, v);
  end if;
  if r = 'staff' then
    select count(*), min(pp.username) into n, u from person p join people_profile pp on pp.person_id = p.id
     where p.org_id = current_org() and p.status = 'active' and p.side = 'staff' and lower(auth_delivery(r, p.id)) = v;
  else
    select count(*), min(pr.username) into n, u from pulse_priv.portal_principal pr
     where pr.org_id = current_org() and pr.active and lower(auth_delivery(r, pr.id)) = v;
  end if;
  return case when n = 1 and u is not null then u else v end;
end $$;

-- The shared address (account_sign_in, the e-mailed account code): the account's handle (with the @ when one was typed)
-- when what was typed is an old username or an old handle of exactly one account and nobody has it as their username
-- today. Anything else (an e-mail, a handle, a username in use, an unknown name) comes back exactly as typed.
create function pulse.login_alias(p_login text) returns text
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o text := coalesce(current_setting('pulse.org_id', true), ''); vw text := coalesce(current_setting('pulse.viewer_id', true), '');
  l text := lower(btrim(coalesce(p_login, ''))); at text := ''; g record; used boolean := false; h text; n int;
begin
  if l ~ '^@[a-z0-9][a-z0-9._-]*$' then l := substr(l, 2); at := '@'; end if;
  if l = '' or position('@' in l) > 0 or exists (select 1 from pulse_priv.pulse_account where handle = l) then return p_login; end if;
  for g in select id from org where status = 'active' loop
    perform set_config('pulse.org_id', g.id::text, true);
    perform set_config('pulse.viewer_id', '', true);
    used := exists (select 1 from people_profile where org_id = g.id and username = l);
    exit when used;
  end loop;
  perform set_config('pulse.org_id', o, true);
  perform set_config('pulse.viewer_id', vw, true);
  if used then return p_login; end if;
  select count(distinct am.account_id), min(a.handle) into n, h from person_username_alias al
    join pulse_priv.account_member am on am.person_id = al.person_id join pulse_priv.pulse_account a on a.id = am.account_id
   where al.username = l;
  if n = 1 then return at || h; end if;
  if n > 1 then return p_login; end if;
  select a.handle into h from pulse_priv.handle_name hn join pulse_priv.pulse_account a on a.id = hn.ref where hn.kind = 'person' and hn.handle = l;
  return coalesce(at || h, p_login);
end $$;

-- The company's other doors that take a username or an e-mail (the e-mailed staff code, Forgot your password /
-- username): a plain name as auth_login_name reads it, and an old name from another company (login_alias) as this
-- person's username here when they have a seat here. Anything with an @ is left exactly as typed.
create function pulse.auth_old_name(r text, input text) returns text
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v text := lower(btrim(coalesce(input, ''))); u text; h text;
begin
  if position('@' in v) > 0 or v = '' then return input; end if;
  u := auth_login_name(r, input);
  if r <> 'staff' or u is distinct from v or exists (select 1 from people_profile where org_id = current_org() and username = v) then return u; end if;
  h := login_alias(v);
  if h is distinct from v and exists (select 1 from people_profile where org_id = current_org() and username = h) then return h; end if;
  return u;
end $$;

-- The e-mailed account code (1465/1585): what was typed when it already names one account (acct_code_target: a handle,
-- an old handle, an e-mail, a username in use), else login_alias's reading of it (an old username). The same both when
-- the code is asked for and when it is typed, so its tries and its limit stay the account's.
create function pulse.account_code_login(p_login text) returns text
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if acct_code_target(p_login) is not null then return p_login; end if;
  return login_alias(p_login);
end $$;

-- ------------------------------------------------------------------------------------------------ the profile page
-- The signed-in person's one @handle, the old names that still find them, and the companies where their seat kept its
-- own username because someone else there has the handle. Null without an account.
create function pulse.account_names() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o text := coalesce(current_setting('pulse.org_id', true), ''); vw text := coalesce(current_setting('pulse.viewer_id', true), '');
  v uuid := account_of_viewer(); h text; m record; u text; kept jsonb := '[]'::jsonb; old text[];
begin
  if current_viewer() is null or v is null then return null; end if;
  select handle into h from pulse_priv.pulse_account where id = v;
  select coalesce(array_agg(distinct x order by x), '{}') into old from (
    select hn.handle x from pulse_priv.handle_name hn where hn.kind = 'person' and hn.ref = v and hn.handle <> h
    union
    select al.username from person_username_alias al join pulse_priv.account_member am on am.person_id = al.person_id
     where am.account_id = v and al.username <> h) q;
  for m in select am.member_org, am.person_id, g.name from pulse_priv.account_member am join org g on g.id = am.member_org and g.status = 'active'
      where am.account_id = v order by g.name loop
    perform set_config('pulse.org_id', m.member_org::text, true);
    perform set_config('pulse.viewer_id', '', true);
    select pp.username into u from people_profile pp where pp.person_id = m.person_id and pp.org_id = m.member_org;
    if found and u is not null and u <> h then kept := kept || jsonb_build_array(jsonb_build_object('company', m.name, 'username', u)); end if;
  end loop;
  perform set_config('pulse.org_id', o, true);
  perform set_config('pulse.viewer_id', vw, true);
  return jsonb_build_object('handle', h, 'old', to_jsonb(old), 'kept', kept);
end $$;

-- 1683's card, and the person always sees their own career and contact in every company (it is their own data);
-- everyone else sees them only where the person ticked them.
create or replace function pulse.account_card(p_person uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid; s record; a record; ap pulse_priv.account_profile%rowtype; me boolean;
begin
  if current_viewer() is null or not exists (select 1 from person where id = p_person and org_id = current_org()) then return null; end if;
  select account_id into v from pulse_priv.account_member where member_org = current_org() and person_id = p_person;
  if v is null then return null; end if;
  me := p_person = current_viewer();
  select (coalesce(sh.profile, true) or me) as profile, (coalesce(sh.skills, true) or me) as skills, (coalesce(sh.badges, true) or me) as badges,
         (coalesce(sh.highlights, true) or me) as highlights, (coalesce(sh.contact, false) or me) as contact, (coalesce(sh.career, false) or me) as career
    into s from (select 1) one left join pulse_priv.account_share sh on sh.account_id = v and sh.member_org = current_org();
  select handle into a from pulse_priv.pulse_account where id = v;
  select * into ap from pulse_priv.account_profile where account_id = v;
  return jsonb_build_object('handle', a.handle, 'self', me,
    'headline', case when s.profile then ap.headline end,
    'about', case when s.profile then ap.about end,
    'links', case when s.profile then ap.links end,
    'pronouns', case when s.profile then ap.pronouns end,
    'location', case when s.profile then ap.location end,
    'languages', case when s.profile then to_jsonb(coalesce(ap.languages, '{}')) end,
    'education', case when s.profile then coalesce(ap.education, '[]'::jsonb) end,
    'certifications', case when s.profile then coalesce(ap.certifications, '[]'::jsonb) end,
    'skills', case when s.skills then to_jsonb(ap.skills) end,
    'skillLevels', case when s.skills then coalesce(ap.skill_levels, '{}'::jsonb) end,
    'contact', case when s.contact and (ap.contact_email is not null or ap.contact_phone is not null) then jsonb_build_object('email', ap.contact_email, 'phone', ap.contact_phone) end,
    'career', case when s.career then account_career_of(v, true) end,
    'badges', coalesce((select jsonb_agg(jsonb_build_object('title', title, 'note', note, 'from', from_org_name, 'by', given_by_name, 'on', earned_on, 'here', from_org = current_org()) order by earned_on desc)
      from pulse_priv.account_badge where account_id = v and (from_org = current_org() or (s.badges and carried))), '[]'::jsonb),
    'highlights', case when s.highlights then coalesce((select jsonb_agg(jsonb_build_object('title', title, 'detail', detail, 'from', from_org_name, 'on', on_date) order by coalesce(on_date, created_at::date) desc)
      from pulse_priv.account_highlight where account_id = v), '[]'::jsonb) else '[]'::jsonb end);
end $$;

revoke all on function pulse.account_username_sync(uuid, uuid), pulse.account_username_follow(), pulse.people_profile_handle(),
  pulse.login_alias(text), pulse.auth_old_name(text, text), pulse.account_code_login(text), pulse.account_names() from public;
grant execute on function pulse.login_alias(text), pulse.auth_old_name(text, text), pulse.account_code_login(text), pulse.account_names() to pulse_api;

-- ------------------------------------------------------------------------------------------------ backfill
-- Every account's seats take its handle now (the same function the triggers use).
do $$
declare a record; r jsonb; n_acct int := 0; n_changed int := 0; n_kept int := 0;
begin
  for a in select id from pulse_priv.pulse_account order by created_at, id loop
    r := pulse.account_username_sync(a.id, null);
    n_acct := n_acct + 1;
    n_changed := n_changed + coalesce((r ->> 'changed')::int, 0);
    n_kept := n_kept + coalesce(jsonb_array_length(r -> 'kept'), 0);
  end loop;
  raise notice 'IDENTITY-UNIFY: % accounts; % company usernames now follow their Pulse handle (old ones kept as aliases); % kept their own (someone else there has the handle)',
    n_acct, n_changed, n_kept;
end $$;

-- migrate:down
-- Forward-only: the usernames stay the account's; the old ones stay in pulse.person_username_alias.
