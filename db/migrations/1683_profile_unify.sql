-- migrate:up
-- PROFILE-UNIFY (owner, 6 Nov 2026): "one person, one profile across every company". A person's own details (photo,
-- name, pronouns, headline, bio, personal contact, location, languages, skills with levels, links, education and
-- certifications) live ONCE on their Pulse account (pulse_priv.account_profile, 0920) and every company seat inherits
-- them: the account's values are written into each seat's people_profile and person_photo, so every list, avatar and
-- profile in every company shows the same photo and details. Editing them once (on the account profile, or on your own
-- profile in any company) updates every seat. The company keeps only its own work record (role, team, reports to,
-- employment, pay, attendance, HR, documents): nothing of it is copied anywhere.
--  * Personal contact travels only to the companies the person ticks (account_share.contact, off by default).
--  * "My career" (pulse.account_career): roles and dates per company, work counts, highlights, badges and contracts,
--    assembled from every seat, current and former. Only the person reads it. A company sees roles and dates only, and
--    only when the person publishes them to it (account_share.career, off by default). Pay is never in either.
--  * Resume: the sections the person picks; a public link (off by default; Pulse keeps only its hash).
--  * Moving company: an admin who is also an admin elsewhere invites the person there as a move (org_invite.transfer_from);
--    accepting gives the new company a fresh work record with the account profile already on it, and the old seat
--    becomes alumni (pulse.account_alumni keeps it; the old company keeps its records).

-- ------------------------------------------------------------------------------------------------ the account's own fields
alter table pulse_priv.account_profile
  add column pronouns text check (length(pronouns) <= 30),
  add column location text check (length(location) <= 120),
  add column languages text[] not null default '{}' check (cardinality(languages) <= 8),
  add column skill_levels jsonb not null default '{}' check (jsonb_typeof(skill_levels) = 'object'),
  add column education jsonb not null default '[]' check (jsonb_typeof(education) = 'array' and jsonb_array_length(education) <= 12),
  add column certifications jsonb not null default '[]' check (jsonb_typeof(certifications) = 'array' and jsonb_array_length(certifications) <= 20),
  add column contact_email text check (contact_email is null or contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  add column contact_phone text check (contact_phone is null or contact_phone ~ '^\+?[0-9 ()-]{6,24}$'),
  add column photo_mime text check (photo_mime in ('image/jpeg', 'image/png', 'image/webp')),
  add column photo_bytes bytea check (octet_length(photo_bytes) <= 400000),
  add column photo_at timestamptz,
  add column photo_from uuid references pulse.org(id),
  add column resume_sections jsonb not null default '["about","experience","skills","education","certifications","highlights"]'
    check (jsonb_typeof(resume_sections) = 'array' and jsonb_array_length(resume_sections) <= 12),
  add column resume_share_hash text unique,
  add column resume_share_on boolean not null default false,
  add column resume_shared_at timestamptz,
  add constraint account_profile_photo_whole check ((photo_bytes is null) = (photo_mime is null));
alter table pulse_priv.account_share
  add column contact boolean not null default false,
  add column career boolean not null default false;
alter table pulse_priv.org_invite add column transfer_from uuid references pulse.org(id);

-- A company's record that one of its people left it with their Pulse account (left, or moved to another company):
-- the company's own row (forced row security, tenant policy). The account reads its own rows across companies through
-- the definer functions below (the schema owner's directory policy, as login_session and org_invite have).
create table pulse.account_alumni (
  org_id      uuid not null references pulse.org(id),
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references pulse_priv.pulse_account(id) on delete cascade,
  person_id   uuid not null references pulse.person(id) on delete cascade,
  kind        text not null,
  joined_at   timestamptz not null,
  left_at     timestamptz not null default now(),
  how         text not null check (how in ('left', 'moved')),
  moved_to    uuid references pulse.org(id),
  unique (org_id, person_id)
);
create index account_alumni_account on pulse.account_alumni(account_id);
alter table pulse.account_alumni enable row level security;
alter table pulse.account_alumni force row level security;
create policy tenant_isolation on pulse.account_alumni using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy directory on pulse.account_alumni for select
  using (current_user = (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'pulse'));
revoke all on pulse.account_alumni from public;
grant select on pulse.account_alumni to pulse_api;
create policy alumni_see on pulse.account_alumni as restrictive for select to pulse_api using (pulse.viewer_is('admin', 'hr', 'leadership'));

-- ------------------------------------------------------------------------------------------------ inheritance
-- Write the account's values into one seat. Only values the account has overwrite the seat (an empty account field
-- leaves the company's value alone); the name only when the person changes it on their account.
create function pulse.account_seat_fill(p_account uuid, p_org uuid, p_person uuid, p_name boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o text := coalesce(current_setting('pulse.org_id', true), ''); vw text := coalesce(current_setting('pulse.viewer_id', true), '');
  sy text := coalesce(current_setting('pulse.profile_sync', true), ''); ap pulse_priv.account_profile%rowtype; a pulse_priv.pulse_account%rowtype;
  n_photo int := 0; n_fields int := 0; n_name int := 0;
begin
  select * into ap from pulse_priv.account_profile where account_id = p_account;
  select * into a from pulse_priv.pulse_account where id = p_account;
  perform set_config('pulse.org_id', p_org::text, true);
  perform set_config('pulse.viewer_id', '', true);
  perform set_config('pulse.profile_sync', '1', true);
  if ap.photo_bytes is not null then
    insert into person_photo(org_id, person_id, mime, bytes, updated_by) values (p_org, p_person, ap.photo_mime, ap.photo_bytes, p_person)
    on conflict (person_id) do update set mime = excluded.mime, bytes = excluded.bytes, updated_by = excluded.updated_by, updated_at = now()
      where person_photo.bytes is distinct from excluded.bytes;
    get diagnostics n_photo = row_count;
  end if;
  if ap.account_id is not null then
    update people_profile set pronouns = coalesce(ap.pronouns, pronouns), about = coalesce(left(ap.about, 400), about),
        languages = case when cardinality(ap.languages) > 0 then ap.languages[1:8] else languages end,
        skills = case when cardinality(ap.skills) > 0 then ap.skills else skills end, updated_at = now()
      where person_id = p_person and org_id = p_org
        and (pronouns, about, languages, skills) is distinct from (coalesce(ap.pronouns, pronouns), coalesce(left(ap.about, 400), about),
          case when cardinality(ap.languages) > 0 then ap.languages[1:8] else languages end, case when cardinality(ap.skills) > 0 then ap.skills else skills end);
    get diagnostics n_fields = row_count;
  end if;
  if p_name then
    update person set display_name = a.display_name where id = p_person and org_id = p_org and display_name is distinct from a.display_name;
    get diagnostics n_name = row_count;
  end if;
  perform set_config('pulse.org_id', o, true);
  perform set_config('pulse.viewer_id', vw, true);
  perform set_config('pulse.profile_sync', sy, true);
  return jsonb_build_object('photo', n_photo > 0, 'fields', n_fields > 0, 'name', n_name > 0);
end $$;

-- Every current seat of the account; the answer counts what changed, per company handle.
create function pulse.account_profile_push(p_account uuid, p_name boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m record; r jsonb; out jsonb := '{}'::jsonb;
begin
  for m in select am.member_org, am.person_id, coalesce(g.handle, g.slug) h from pulse_priv.account_member am join org g on g.id = am.member_org and g.status = 'active'
      where am.account_id = p_account loop
    r := account_seat_fill(p_account, m.member_org, m.person_id, p_name);
    out := out || jsonb_build_object(m.h, r);
  end loop;
  return out;
end $$;

-- Remove the photo from every seat (the person removed it from their own profile).
create function pulse.account_photo_clear(p_account uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o text := coalesce(current_setting('pulse.org_id', true), ''); vw text := coalesce(current_setting('pulse.viewer_id', true), '');
  sy text := coalesce(current_setting('pulse.profile_sync', true), ''); m record;
begin
  update pulse_priv.account_profile set photo_mime = null, photo_bytes = null, photo_at = now(), photo_from = null where account_id = p_account;
  perform set_config('pulse.profile_sync', '1', true);
  for m in select member_org, person_id from pulse_priv.account_member where account_id = p_account loop
    perform set_config('pulse.org_id', m.member_org::text, true);
    perform set_config('pulse.viewer_id', '', true);
    delete from person_photo where person_id = m.person_id and org_id = m.member_org;
  end loop;
  perform set_config('pulse.org_id', o, true);
  perform set_config('pulse.viewer_id', vw, true);
  perform set_config('pulse.profile_sync', sy, true);
end $$;

-- The person changes their own photo in any company: it becomes the account's photo and every seat's. A photo HR or an
-- admin sets for someone stays that company's own.
create function pulse.person_photo_carry() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare p uuid := case when tg_op = 'DELETE' then old.person_id else new.person_id end; v uuid;
begin
  if coalesce(current_setting('pulse.profile_sync', true), '') = '1' or current_viewer() is distinct from p then return null; end if;
  select account_id into v from pulse_priv.account_member where person_id = p;
  if v is null then return null; end if;
  if tg_op = 'DELETE' then perform account_photo_clear(v); return null; end if;
  insert into pulse_priv.account_profile(account_id, photo_mime, photo_bytes, photo_at, photo_from) values (v, new.mime, new.bytes, now(), new.org_id)
  on conflict (account_id) do update set photo_mime = excluded.photo_mime, photo_bytes = excluded.photo_bytes, photo_at = now(), photo_from = excluded.photo_from;
  perform account_profile_push(v, false);
  return null;
end $$;
create trigger person_photo_carry after insert or update or delete on pulse.person_photo for each row execute function pulse.person_photo_carry();

-- The person edits their own pronouns, about, languages or skills in any company: the account takes them, every seat too.
create function pulse.people_profile_carry() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid;
begin
  if coalesce(current_setting('pulse.profile_sync', true), '') = '1' or current_viewer() is distinct from new.person_id then return null; end if;
  select account_id into v from pulse_priv.account_member where person_id = new.person_id;
  if v is null then return null; end if;
  insert into pulse_priv.account_profile(account_id) values (v) on conflict (account_id) do nothing;
  update pulse_priv.account_profile set
      pronouns = case when new.pronouns is distinct from old.pronouns then new.pronouns else pronouns end,
      about = case when new.about is distinct from old.about then new.about else about end,
      languages = case when new.languages is distinct from old.languages then new.languages else languages end,
      skills = case when new.skills is distinct from old.skills then (select coalesce(array_agg(distinct left(btrim(x), 60)) filter (where btrim(x) <> ''), '{}') from unnest(new.skills[1:40]) x) else skills end,
      updated_at = now()
    where account_id = v;
  perform account_profile_push(v, false);
  return null;
end $$;
create trigger people_profile_carry after update of pronouns, about, languages, skills on pulse.people_profile for each row execute function pulse.people_profile_carry();

-- A new seat (joining, a move, a link, starting a company) gets the account's profile at once.
create function pulse.account_member_carry() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if exists (select 1 from pulse_priv.account_profile where account_id = new.account_id) then
    perform account_seat_fill(new.account_id, new.member_org, new.person_id, false);
  end if;
  return null;
end $$;
create trigger account_member_carry after insert on pulse_priv.account_member for each row execute function pulse.account_member_carry();

-- ------------------------------------------------------------------------------------------------ the profile page
create or replace function pulse.account_profile_get() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); a pulse_priv.pulse_account%rowtype; ap pulse_priv.account_profile%rowtype;
begin
  if v is null then return null; end if;
  select * into a from pulse_priv.pulse_account where id = v;
  select * into ap from pulse_priv.account_profile where account_id = v;
  return jsonb_build_object(
    'name', a.display_name, 'handle', a.handle, 'me', current_viewer(), 'photoAt', ap.photo_at, 'hasPhoto', ap.photo_bytes is not null,
    'profile', jsonb_build_object('headline', ap.headline, 'about', ap.about, 'skills', to_jsonb(coalesce(ap.skills, '{}')), 'links', coalesce(ap.links, '[]'::jsonb),
      'pronouns', ap.pronouns, 'location', ap.location, 'languages', to_jsonb(coalesce(ap.languages, '{}')), 'skillLevels', coalesce(ap.skill_levels, '{}'::jsonb),
      'education', coalesce(ap.education, '[]'::jsonb), 'certifications', coalesce(ap.certifications, '[]'::jsonb),
      'contactEmail', ap.contact_email, 'contactPhone', ap.contact_phone),
    'orgSkills', coalesce((select to_jsonb(skills) from people_profile where person_id = current_viewer()), '[]'::jsonb),
    'badges', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'note', note, 'from', from_org_name, 'by', given_by_name, 'on', earned_on, 'carried', carried, 'here', from_org = current_org()) order by earned_on desc) from pulse_priv.account_badge where account_id = v), '[]'::jsonb),
    'highlights', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'detail', detail, 'from', from_org_name, 'on', on_date) order by coalesce(on_date, created_at::date) desc) from pulse_priv.account_highlight where account_id = v), '[]'::jsonb),
    'shares', coalesce((select jsonb_agg(jsonb_build_object('org', o.id, 'name', o.name, 'current', o.id = current_org(),
        'profile', coalesce(s.profile, true), 'skills', coalesce(s.skills, true), 'badges', coalesce(s.badges, true), 'highlights', coalesce(s.highlights, true),
        'contact', coalesce(s.contact, false), 'career', coalesce(s.career, false)) order by o.name)
      from pulse_priv.account_member m join org o on o.id = m.member_org left join pulse_priv.account_share s on s.account_id = v and s.member_org = m.member_org where m.account_id = v), '[]'::jsonb));
end $$;

-- A save changes only the keys it sends (the older form sends headline, about, skills and links only).
create or replace function pulse.account_profile_save(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure(); v_skills text[]; v_langs text[]; n text; renamed boolean := false;
  arr jsonb; lv jsonb := '{}'::jsonb; k text; x jsonb;
begin
  insert into pulse_priv.account_profile(account_id) values (v) on conflict (account_id) do nothing;
  if p ? 'skills' then
    select coalesce(array_agg(distinct left(btrim(s), 60)) filter (where btrim(s) <> ''), '{}') into v_skills
      from (select jsonb_array_elements_text(case when jsonb_typeof(p -> 'skills') = 'array' then p -> 'skills' else '[]' end) s limit 40) q;
    update pulse_priv.account_profile set skills = v_skills where account_id = v;
  end if;
  if p ? 'skillLevels' and jsonb_typeof(p -> 'skillLevels') = 'object' then
    for k, x in select * from jsonb_each(p -> 'skillLevels') loop
      if length(k) between 1 and 60 and jsonb_typeof(x) = 'number' and (x #>> '{}')::numeric between 1 and 4 then lv := lv || jsonb_build_object(k, (x #>> '{}')::int); end if;
    end loop;
    update pulse_priv.account_profile set skill_levels = lv where account_id = v;
  end if;
  if p ? 'languages' then
    select coalesce(array_agg(distinct left(btrim(s), 40)) filter (where btrim(s) <> ''), '{}') into v_langs
      from (select jsonb_array_elements_text(case when jsonb_typeof(p -> 'languages') = 'array' then p -> 'languages' else '[]' end) s limit 8) q;
    update pulse_priv.account_profile set languages = v_langs where account_id = v;
  end if;
  update pulse_priv.account_profile set
      headline = case when p ? 'headline' then nullif(left(btrim(coalesce(p ->> 'headline', '')), 120), '') else headline end,
      about = case when p ? 'about' then nullif(left(btrim(coalesce(p ->> 'about', '')), 2000), '') else about end,
      pronouns = case when p ? 'pronouns' then nullif(left(btrim(coalesce(p ->> 'pronouns', '')), 30), '') else pronouns end,
      location = case when p ? 'location' then nullif(left(btrim(coalesce(p ->> 'location', '')), 120), '') else location end,
      contact_email = case when p ? 'contactEmail' then nullif(lower(btrim(coalesce(p ->> 'contactEmail', ''))), '') else contact_email end,
      contact_phone = case when p ? 'contactPhone' then nullif(btrim(coalesce(p ->> 'contactPhone', '')), '') else contact_phone end,
      links = case when p ? 'links' then (case when jsonb_typeof(p -> 'links') = 'array' then (select coalesce(jsonb_agg(jsonb_build_object('label', left(coalesce(l ->> 'label', ''), 60), 'url', left(l ->> 'url', 300))), '[]')
          from (select l from jsonb_array_elements(p -> 'links') l where l ->> 'url' ~ '^https://[^[:space:]]+$' limit 8) q) else '[]' end) else links end,
      education = case when p ? 'education' then (case when jsonb_typeof(p -> 'education') = 'array' then (select coalesce(jsonb_agg(jsonb_build_object(
            'school', left(btrim(e ->> 'school'), 120), 'degree', nullif(left(btrim(coalesce(e ->> 'degree', '')), 120), ''),
            'from', nullif(left(coalesce(e ->> 'from', ''), 10), ''), 'to', nullif(left(coalesce(e ->> 'to', ''), 10), ''))), '[]')
          from (select e from jsonb_array_elements(p -> 'education') e where jsonb_typeof(e) = 'object' and length(btrim(coalesce(e ->> 'school', ''))) >= 2 limit 12) q) else '[]' end) else education end,
      certifications = case when p ? 'certifications' then (case when jsonb_typeof(p -> 'certifications') = 'array' then (select coalesce(jsonb_agg(jsonb_build_object(
            'name', left(btrim(c ->> 'name'), 120), 'issuer', nullif(left(btrim(coalesce(c ->> 'issuer', '')), 120), ''),
            'on', nullif(left(coalesce(c ->> 'on', ''), 10), ''), 'url', case when c ->> 'url' ~ '^https://[^[:space:]]+$' then left(c ->> 'url', 300) end)), '[]')
          from (select c from jsonb_array_elements(p -> 'certifications') c where jsonb_typeof(c) = 'object' and length(btrim(coalesce(c ->> 'name', ''))) >= 2 limit 20) q) else '[]' end) else certifications end,
      updated_at = now()
    where account_id = v;
  if p ? 'name' then
    n := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g');
    if length(n) not between 2 and 120 then raise exception 'Give your name (2 to 120 characters)' using errcode = '22023'; end if;
    update pulse_priv.pulse_account set display_name = n, updated_at = now() where id = v and display_name is distinct from n;
    renamed := found;
  end if;
  perform account_profile_push(v, renamed);
  return account_profile_get();
end $$;

create or replace function pulse.account_share_save(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure(); o uuid := coalesce(nullif(p ->> 'org', '')::uuid, current_org());
begin
  if not exists (select 1 from pulse_priv.account_member where account_id = v and member_org = o) then raise exception 'Not one of your organisations' using errcode = '42501'; end if;
  insert into pulse_priv.account_share(account_id, member_org) values (v, o) on conflict (account_id, member_org) do nothing;
  update pulse_priv.account_share set
      profile = case when p ? 'profile' then coalesce((p ->> 'profile')::boolean, true) else profile end,
      skills = case when p ? 'skills' then coalesce((p ->> 'skills')::boolean, true) else skills end,
      badges = case when p ? 'badges' then coalesce((p ->> 'badges')::boolean, true) else badges end,
      highlights = case when p ? 'highlights' then coalesce((p ->> 'highlights')::boolean, true) else highlights end,
      contact = case when p ? 'contact' then coalesce((p ->> 'contact')::boolean, false) else contact end,
      career = case when p ? 'career' then coalesce((p ->> 'career')::boolean, false) else career end
    where account_id = v and member_org = o;
  return account_profile_get();
end $$;

-- ------------------------------------------------------------------------------------------------ my career
-- Every seat of an account, current and former, with what that company holds about the person's work: role and dates,
-- counts of finished tasks, projects and deliveries, the highlights and badges from there, and the contracts the person is
-- a party to (the shared part only). p_public: roles and dates only (what a company or a resume link may see).
create function pulse.account_career_of(p_account uuid, p_public boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o text := coalesce(current_setting('pulse.org_id', true), ''); vw text := coalesce(current_setting('pulse.viewer_id', true), '');
  s record; r record; out jsonb := '[]'::jsonb; item jsonb; seen uuid[] := '{}';
begin
  for s in
    select am.member_org org, am.person_id person, am.kind, am.joined_at, null::timestamptz left_at, null::text how, null::uuid moved_to, true current
      from pulse_priv.account_member am where am.account_id = p_account
    union all
    select al.org_id, al.person_id, al.kind, al.joined_at, al.left_at, al.how, al.moved_to, false
      from pulse.account_alumni al where al.account_id = p_account
    limit 40
  loop
    if s.person = any(seen) then continue; end if;
    seen := seen || s.person;
    perform set_config('pulse.org_id', s.org::text, true);
    perform set_config('pulse.viewer_id', '', true);
    select g.name, coalesce(g.handle, g.slug) handle, p.status, p.active_from, p.active_to, pp.role, pp.department, pp.joined_on, pp.employment_type
      into r from org g join person p on p.id = s.person left join people_profile pp on pp.person_id = p.id where g.id = s.org;
    item := jsonb_build_object('org', s.org, 'company', r.name, 'handle', r.handle, 'kind', s.kind, 'role', r.role,
      'from', coalesce(r.joined_on, r.active_from, s.joined_at::date),
      'to', case when s.current and r.status = 'active' then null else coalesce(r.active_to, s.left_at::date) end,
      'current', s.current and r.status = 'active', 'how', s.how,
      'movedTo', (select name from org where id = s.moved_to));
    if not p_public then
      item := item || jsonb_build_object('team', r.department, 'employment', r.employment_type,
        'tasksDone', (select count(*) from task t where t.org_id = s.org and t.assignee_person_id = s.person and t.status in ('done', 'accepted') and t.deleted_at is null),
        'projects', (select count(distinct t.project_id) from task t where t.org_id = s.org and t.assignee_person_id = s.person and t.project_id is not null and t.deleted_at is null),
        'deliveries', (select count(*) from delivery d where d.org_id = s.org and d.uploader_account in (select ac.handle from account ac where ac.org_id = s.org and ac.holder_person_id = s.person)),
        'highlights', coalesce((select jsonb_agg(jsonb_build_object('title', h.title, 'detail', h.detail, 'on', h.on_date) order by coalesce(h.on_date, h.created_at::date) desc)
          from pulse_priv.account_highlight h where h.account_id = p_account and h.from_org = s.org), '[]'::jsonb),
        'badges', coalesce((select jsonb_agg(jsonb_build_object('title', b.title, 'note', b.note, 'by', b.given_by_name, 'on', b.earned_on) order by b.earned_on desc)
          from pulse_priv.account_badge b where b.account_id = p_account and b.from_org = s.org), '[]'::jsonb),
        'contracts', coalesce((select jsonb_agg(jsonb_build_object('key', c.contract_key, 'title', c.title, 'kind', c.kind, 'status', c.status, 'role', cp.role,
            'startsOn', c.starts_on, 'endsOn', coalesce(c.ended_on, c.ends_on)) order by c.updated_at desc)
          from contract c join contract_party cp on cp.org_id = c.org_id and cp.contract_id = c.id
          where c.org_id = s.org and c.status <> 'draft' and (cp.party_person_id = s.person or cp.party_account = p_account)), '[]'::jsonb));
    end if;
    out := out || jsonb_build_array(item);
  end loop;
  perform set_config('pulse.org_id', o, true);
  perform set_config('pulse.viewer_id', vw, true);
  return (select coalesce(jsonb_agg(x order by (x ->> 'current')::boolean desc, x ->> 'from' desc nulls last), '[]'::jsonb) from jsonb_array_elements(out) x);
end $$;
revoke all on function pulse.account_career_of(uuid, boolean) from public;

-- Only the person reads their own full career.
create function pulse.account_career() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer();
begin
  if current_viewer() is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  if v is null then v := account_ensure(); end if;
  return jsonb_build_object('career', account_career_of(v, false),
    'moves', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'org', o.name, 'from', f.name, 'title', i.title, 'at', i.created_at) order by i.created_at desc)
      from pulse_priv.org_invite i join org o on o.id = i.org_id join org f on f.id = i.transfer_from join pulse_priv.pulse_account a on a.id = v
      where i.to_handle = a.handle and i.status = 'open' and i.expires_at > now() and o.status = 'active'), '[]'::jsonb));
end $$;

-- What a person of this organisation shares with it from their account: never another organisation's records, only what
-- they wrote or chose, and only what they allow here (contact and career are off until they tick them).
create or replace function pulse.account_card(p_person uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid; s record; a record; ap pulse_priv.account_profile%rowtype;
begin
  if current_viewer() is null or not exists (select 1 from person where id = p_person and org_id = current_org()) then return null; end if;
  select account_id into v from pulse_priv.account_member where member_org = current_org() and person_id = p_person;
  if v is null then return null; end if;
  select coalesce(sh.profile, true) profile, coalesce(sh.skills, true) skills, coalesce(sh.badges, true) badges, coalesce(sh.highlights, true) highlights,
         coalesce(sh.contact, false) contact, coalesce(sh.career, false) career
    into s from (select 1) one left join pulse_priv.account_share sh on sh.account_id = v and sh.member_org = current_org();
  select handle into a from pulse_priv.pulse_account where id = v;
  select * into ap from pulse_priv.account_profile where account_id = v;
  return jsonb_build_object('handle', a.handle, 'self', p_person = current_viewer(),
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

-- ------------------------------------------------------------------------------------------------ resume
create function pulse.account_resume_get() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); ap pulse_priv.account_profile%rowtype;
begin
  if v is null then v := account_ensure(); end if;
  select * into ap from pulse_priv.account_profile where account_id = v;
  return jsonb_build_object('sections', coalesce(ap.resume_sections, '["about","experience","skills","education","certifications","highlights"]'::jsonb),
    'shareOn', coalesce(ap.resume_share_on, false), 'hasLink', ap.resume_share_hash is not null, 'sharedAt', ap.resume_shared_at);
end $$;

-- p: {sections?, share?: 'on'|'off'|'new'}; p_hash: the new link's hash (the API makes the token and shows it once).
create function pulse.account_resume_save(p jsonb, p_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure(); secs jsonb;
begin
  insert into pulse_priv.account_profile(account_id) values (v) on conflict (account_id) do nothing;
  if jsonb_typeof(p -> 'sections') = 'array' then
    select coalesce(jsonb_agg(x), '[]'::jsonb) into secs from (select distinct x from jsonb_array_elements_text(p -> 'sections') x
      where x in ('photo', 'about', 'contact', 'experience', 'work', 'skills', 'education', 'certifications', 'highlights', 'badges', 'links')) q;
    update pulse_priv.account_profile set resume_sections = secs where account_id = v;
  end if;
  if p ->> 'share' = 'new' then
    if coalesce(p_hash, '') !~ '^[A-Za-z0-9_-]{40,64}$' then raise exception 'Could not make the link' using errcode = '22023'; end if;
    update pulse_priv.account_profile set resume_share_hash = p_hash, resume_share_on = true, resume_shared_at = now() where account_id = v;
  elsif p ->> 'share' = 'off' then
    update pulse_priv.account_profile set resume_share_on = false, resume_share_hash = null where account_id = v;
  end if;
  return account_resume_get();
end $$;

-- Signed out, through the person's link: only the sections they chose; roles and dates only, never pay, contracts, HR
-- or a company's tasks (the "work" section, when chosen, is counts only).
create function pulse.resume_public(p_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare ap pulse_priv.account_profile%rowtype; a pulse_priv.pulse_account%rowtype; secs jsonb; out jsonb; c jsonb;
begin
  if coalesce(p_hash, '') = '' then return null; end if;
  select * into ap from pulse_priv.account_profile where resume_share_hash = p_hash and resume_share_on;
  if not found then return null; end if;
  select * into a from pulse_priv.pulse_account where id = ap.account_id;
  secs := ap.resume_sections;
  out := jsonb_build_object('name', a.display_name, 'handle', a.handle, 'headline', ap.headline, 'pronouns', ap.pronouns, 'location', ap.location, 'sections', secs);
  if secs ? 'photo' and ap.photo_bytes is not null then out := out || jsonb_build_object('photo', 'data:' || ap.photo_mime || ';base64,' || replace(encode(ap.photo_bytes, 'base64'), E'\n', '')); end if;
  if secs ? 'about' then out := out || jsonb_build_object('about', ap.about, 'languages', to_jsonb(ap.languages)); end if;
  if secs ? 'contact' then out := out || jsonb_build_object('contact', jsonb_build_object('email', ap.contact_email, 'phone', ap.contact_phone)); end if;
  if secs ? 'skills' then out := out || jsonb_build_object('skills', to_jsonb(ap.skills), 'skillLevels', ap.skill_levels); end if;
  if secs ? 'education' then out := out || jsonb_build_object('education', ap.education); end if;
  if secs ? 'certifications' then out := out || jsonb_build_object('certifications', ap.certifications); end if;
  if secs ? 'links' then out := out || jsonb_build_object('links', ap.links); end if;
  if secs ? 'experience' or secs ? 'work' then
    c := account_career_of(ap.account_id, not (secs ? 'work'));
    out := out || jsonb_build_object('experience', (select coalesce(jsonb_agg(jsonb_build_object('company', x ->> 'company', 'role', x -> 'role', 'from', x -> 'from', 'to', x -> 'to', 'current', x -> 'current')
      || case when secs ? 'work' then jsonb_build_object('tasksDone', x -> 'tasksDone', 'projects', x -> 'projects', 'deliveries', x -> 'deliveries') else '{}'::jsonb end), '[]'::jsonb)
      from jsonb_array_elements(c) x where x ->> 'kind' in ('staff', 'freelancer', 'partner')));
  end if;
  if secs ? 'highlights' then out := out || jsonb_build_object('highlights', coalesce((select jsonb_agg(jsonb_build_object('title', title, 'from', from_org_name, 'on', on_date) order by coalesce(on_date, created_at::date) desc)
      from pulse_priv.account_highlight where account_id = ap.account_id), '[]'::jsonb)); end if;
  if secs ? 'badges' then out := out || jsonb_build_object('badges', coalesce((select jsonb_agg(jsonb_build_object('title', title, 'from', from_org_name, 'on', earned_on) order by earned_on desc)
      from pulse_priv.account_badge where account_id = ap.account_id and carried), '[]'::jsonb)); end if;
  return out;
end $$;

-- ------------------------------------------------------------------------------------------------ leaving and moving
-- End a seat: the person there becomes a leaver (alumni: kept, with the company's records), sessions there end, the seat
-- leaves the account and the company keeps an alumni row. The last admin cannot leave.
create function pulse.account_seat_end(p_account uuid, p_org uuid, p_how text, p_to uuid) returns text
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m pulse_priv.account_member%rowtype; a pulse_priv.pulse_account%rowtype; n text; o text := coalesce(current_setting('pulse.org_id', true), '');
  vw text := coalesce(current_setting('pulse.viewer_id', true), ''); target text;
begin
  select * into m from pulse_priv.account_member where account_id = p_account and member_org = p_org for update;
  if not found then raise exception 'You are not a member of that company' using errcode = 'P0002'; end if;
  select * into a from pulse_priv.pulse_account where id = p_account;
  select name into n from org where id = p_org;
  select name into target from org where id = p_to;
  perform set_config('pulse.org_id', p_org::text, true);
  perform set_config('pulse.viewer_id', '', true);
  perform set_config('pulse.actor_account', 'Pulse account @' || a.handle, true);
  if exists (select 1 from role_assignment ra where ra.org_id = p_org and ra.person_id = m.person_id and ra.role_key = 'admin' and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity'))
     and not exists (select 1 from role_assignment ra join person pe on pe.id = ra.person_id and pe.status = 'active'
       where ra.org_id = p_org and ra.person_id <> m.person_id and ra.role_key = 'admin' and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity')) then
    perform set_config('pulse.org_id', o, true); perform set_config('pulse.viewer_id', vw, true);
    raise exception 'You are the last admin of %: make someone else an admin first', n using errcode = '22023';
  end if;
  update person set status = case when p_how = 'moved' then 'offboarded' else 'inactive' end, active_to = coalesce(active_to, current_date) where id = m.person_id and status = 'active';
  update login_session set revoked_at = now() where org_id = p_org and person_id = m.person_id and revoked_at is null;
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (p_org, 'person', m.person_id, 'status', 'active', case when p_how = 'moved' then 'Moved to ' || coalesce(target, 'another company') || ' with their Pulse account (@' || a.handle || ')'
    else 'Left the company from their Pulse account (@' || a.handle || ')' end, null);
  insert into account_alumni(org_id, account_id, person_id, kind, joined_at, how, moved_to) values (p_org, p_account, m.person_id, m.kind, m.joined_at, p_how, p_to)
  on conflict (org_id, person_id) do update set left_at = now(), how = excluded.how, moved_to = excluded.moved_to, account_id = excluded.account_id;
  perform audit_write(case when p_how = 'moved' then 'account_move' else 'account_leave' end, 'person', m.person_id::text);
  perform set_config('pulse.org_id', o, true);
  perform set_config('pulse.viewer_id', vw, true);
  delete from pulse_priv.account_member where account_id = p_account and member_org = p_org;
  update pulse_priv.pulse_account set last_org = null where id = p_account and last_org = p_org;
  return n;
end $$;
revoke all on function pulse.account_seat_end(uuid, uuid, text, uuid) from public;

-- ACCOUNT-SEATS' leave (1463), now keeping the alumni row.
create or replace function pulse.account_leave(p_org uuid, p_new text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); here uuid := current_org(); me uuid := current_viewer(); n text; target uuid; r jsonb;
begin
  if me is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  if v is null then v := account_ensure(); end if;
  n := account_seat_end(v, p_org, 'left', null);
  if p_org = here then
    for target in select am.member_org from pulse_priv.account_member am join org o on o.id = am.member_org and o.status = 'active'
        where am.account_id = v order by am.last_used_at desc nulls last loop
      r := acct_session(v, target, p_new, p_device);
      exit when r is not null;
    end loop;
  end if;
  return jsonb_build_object('left', p_org, 'name', n, 'moved', r);
end $$;

-- The companies the viewer may invite this person into: their own other companies where they are an admin, HR or
-- leadership, and where the person has no seat yet.
create function pulse.account_invite_targets(p_person uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare mine uuid := account_of_viewer(); theirs uuid; o text := coalesce(current_setting('pulse.org_id', true), ''); vw text := coalesce(current_setting('pulse.viewer_id', true), '');
  m record; ok boolean; out jsonb := '[]'::jsonb;
begin
  if mine is null or not viewer_is('admin', 'hr', 'leadership') or p_person = current_viewer() then return jsonb_build_object('targets', out, 'hasAccount', false); end if;
  select account_id into theirs from pulse_priv.account_member where member_org = current_org() and person_id = p_person;
  for m in select am.member_org, am.person_id, g.name from pulse_priv.account_member am join org g on g.id = am.member_org and g.status = 'active'
      where am.account_id = mine and am.member_org <> current_org()
        and (theirs is null or not exists (select 1 from pulse_priv.account_member x where x.account_id = theirs and x.member_org = am.member_org)) order by g.name loop
    perform set_config('pulse.org_id', m.member_org::text, true);
    perform set_config('pulse.viewer_id', '', true);
    select exists (select 1 from role_assignment ra join person pe on pe.id = ra.person_id and pe.status = 'active' where ra.person_id = m.person_id
      and ra.role_key in ('admin', 'hr', 'leadership') and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity')) into ok;
    perform set_config('pulse.org_id', o, true);
    perform set_config('pulse.viewer_id', vw, true);
    if ok then out := out || jsonb_build_array(jsonb_build_object('id', m.member_org, 'name', m.name)); end if;
  end loop;
  return jsonb_build_object('targets', out, 'hasAccount', theirs is not null);
end $$;

-- Invite this person (by their account) into another of my companies; p_move: as a move (accepting ends their seat here).
create function pulse.account_invite_elsewhere(p_person uuid, p_org uuid, p_title text, p_move boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare here uuid := current_org(); theirs uuid; h text; t jsonb; inviter uuid; v_id uuid;
  o text := coalesce(current_setting('pulse.org_id', true), ''); vw text := coalesce(current_setting('pulse.viewer_id', true), '');
begin
  t := account_invite_targets(p_person);
  if not coalesce((t -> 'targets') @> jsonb_build_array(jsonb_build_object('id', p_org)), false) then
    raise exception 'You can invite people only into a company where you are an admin, HR or leadership' using errcode = '42501'; end if;
  select account_id into theirs from pulse_priv.account_member where member_org = here and person_id = p_person;
  if theirs is null then raise exception 'This person has no Pulse account yet: ask them to claim their @handle first' using errcode = 'P0002'; end if;
  select handle into h from pulse_priv.pulse_account where id = theirs;
  select person_id into inviter from pulse_priv.account_member where account_id = account_of_viewer() and member_org = p_org;
  perform set_config('pulse.org_id', p_org::text, true);
  perform set_config('pulse.viewer_id', inviter::text, true);
  update pulse_priv.org_invite set status = 'revoked' where org_id = p_org and to_handle = h and status = 'open';
  insert into pulse_priv.org_invite(org_id, kind, title, to_handle, invited_by, transfer_from)
  values (p_org, 'staff', nullif(left(btrim(coalesce(p_title, '')), 80), ''), h, inviter, case when p_move then here end) returning id into v_id;
  perform audit_write('invite', 'org_invite', v_id::text);
  perform set_config('pulse.org_id', o, true);
  perform set_config('pulse.viewer_id', vw, true);
  return jsonb_build_object('id', v_id, 'toHandle', h, 'move', p_move);
end $$;

-- Accepting an invitation; a move also ends the seat it moves from (alumni there), in the same transaction.
create or replace function pulse.org_invite_accept(p_id uuid, p_link text, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure(); i uuid; v_org uuid; v_from uuid; r jsonb;
begin
  if p_id is not null then select id, org_id, transfer_from into i, v_org, v_from from pulse_priv.org_invite where id = p_id and to_handle = (select handle from pulse_priv.pulse_account where id = v);
  else select id, org_id, transfer_from into i, v_org, v_from from pulse_priv.org_invite where token_hash = p_link; end if;
  if i is null then raise exception 'This invitation is no longer open' using errcode = '22023'; end if;
  r := acct_join(v, i, p_hash, p_device);
  if v_from is not null and r is not null and not (r ? 'waiting') and v_from <> v_org
     and exists (select 1 from pulse_priv.account_member where account_id = v and member_org = v_from) then
    perform account_seat_end(v, v_from, 'moved', v_org);
    r := r || jsonb_build_object('movedFrom', (select name from org where id = v_from));
  end if;
  return r;
end $$;

-- ------------------------------------------------------------------------------------------------ backfill (operators)
-- For one account: the best existing photo and fields from any of its seats (the most recent photo; the most complete,
-- then most recently updated record for pronouns and about; skills and languages from all seats) become the account's
-- where the account has none, then every seat gets them. Run by tools/admin/profile-unify-backfill.py only.
create function pulse.account_profile_backfill(p_account uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o text := coalesce(current_setting('pulse.org_id', true), ''); vw text := coalesce(current_setting('pulse.viewer_id', true), '');
  m record; ph_mime text; ph_bytes bytea; ph_at timestamptz; bp_mime text; bp_bytes bytea; bp_at timestamptz; bp_org uuid;
  pp_pronouns text; pp_about text; pp_langs text[]; pp_skills text[]; pp_at timestamptz; hit boolean;
  b_pronouns text; b_about text; b_at timestamptz; best_score int := -1; sc int;
  v_skills text[] := '{}'; v_langs text[] := '{}'; ap pulse_priv.account_profile%rowtype; took jsonb := '[]'::jsonb;
begin
  for m in select am.member_org, am.person_id from pulse_priv.account_member am join org g on g.id = am.member_org and g.status = 'active' where am.account_id = p_account loop
    perform set_config('pulse.org_id', m.member_org::text, true);
    perform set_config('pulse.viewer_id', '', true);
    ph_bytes := null;
    select x.mime, x.bytes, x.updated_at into ph_mime, ph_bytes, ph_at from person_photo x where x.person_id = m.person_id;
    if ph_bytes is not null and (bp_at is null or ph_at > bp_at) then bp_mime := ph_mime; bp_bytes := ph_bytes; bp_at := ph_at; bp_org := m.member_org; end if;
    select x.pronouns, x.about, x.languages, x.skills, x.updated_at, true into pp_pronouns, pp_about, pp_langs, pp_skills, pp_at, hit from people_profile x where x.person_id = m.person_id;
    if found then
      sc := (pp_pronouns is not null)::int + (pp_about is not null)::int + (cardinality(pp_langs) > 0)::int + (cardinality(pp_skills) > 0)::int;
      if sc > best_score or (sc = best_score and pp_at > b_at) then b_pronouns := pp_pronouns; b_about := pp_about; b_at := pp_at; best_score := sc; end if;
      v_skills := v_skills || coalesce(pp_skills, '{}'); v_langs := v_langs || coalesce(pp_langs, '{}');
    end if;
  end loop;
  perform set_config('pulse.org_id', o, true);
  perform set_config('pulse.viewer_id', vw, true);
  insert into pulse_priv.account_profile(account_id) values (p_account) on conflict (account_id) do nothing;
  select * into ap from pulse_priv.account_profile where account_id = p_account;
  if ap.photo_bytes is null and bp_bytes is not null then
    update pulse_priv.account_profile set photo_mime = bp_mime, photo_bytes = bp_bytes, photo_at = bp_at, photo_from = bp_org where account_id = p_account;
    took := took || '["photo"]'::jsonb;
  end if;
  if ap.pronouns is null and b_pronouns is not null then update pulse_priv.account_profile set pronouns = b_pronouns where account_id = p_account; took := took || '["pronouns"]'::jsonb; end if;
  if ap.about is null and b_about is not null then update pulse_priv.account_profile set about = b_about where account_id = p_account; took := took || '["about"]'::jsonb; end if;
  if cardinality(ap.skills) = 0 and cardinality(v_skills) > 0 then
    update pulse_priv.account_profile set skills = (select coalesce(array_agg(s), '{}') from (select distinct left(btrim(s), 60) s from unnest(v_skills) s where btrim(s) <> '' limit 40) q) where account_id = p_account;
    took := took || '["skills"]'::jsonb;
  end if;
  if cardinality(ap.languages) = 0 and cardinality(v_langs) > 0 then
    update pulse_priv.account_profile set languages = (select coalesce(array_agg(s), '{}') from (select distinct left(btrim(s), 40) s from unnest(v_langs) s where btrim(s) <> '' limit 8) q) where account_id = p_account;
    took := took || '["languages"]'::jsonb;
  end if;
  return jsonb_build_object('took', took, 'seats', account_profile_push(p_account, false));
end $$;
revoke all on function pulse.account_profile_backfill(uuid) from public;

revoke all on function pulse.account_seat_fill(uuid, uuid, uuid, boolean), pulse.account_profile_push(uuid, boolean), pulse.account_photo_clear(uuid),
  pulse.person_photo_carry(), pulse.people_profile_carry(), pulse.account_member_carry(), pulse.account_career(), pulse.account_resume_get(),
  pulse.account_resume_save(jsonb, text), pulse.resume_public(text), pulse.account_invite_targets(uuid), pulse.account_invite_elsewhere(uuid, uuid, text, boolean) from public;
grant execute on function pulse.account_career(), pulse.account_resume_get(), pulse.account_resume_save(jsonb, text), pulse.resume_public(text),
  pulse.account_invite_targets(uuid), pulse.account_invite_elsewhere(uuid, uuid, text, boolean) to pulse_api;
grant execute on function pulse.account_leave(uuid, text, text), pulse.org_invite_accept(uuid, text, text, text), pulse.account_profile_get(),
  pulse.account_profile_save(jsonb), pulse.account_share_save(jsonb), pulse.account_card(uuid) to pulse_api;

-- migrate:down
-- Forward-only: the account profiles, alumni rows and resume settings are kept.
