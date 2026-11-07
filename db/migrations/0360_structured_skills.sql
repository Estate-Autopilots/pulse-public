-- migrate:up
-- R48 (12 Oct 2026): structured skills and a resume-grade work profile (PLAN P21; owner voice 8 Oct §5 "Skills").
--  * A taxonomy comes only from an approved download (owner errand E16). skill_source records each imported version:
--    the file's SHA-256, the classification DATA licence and, separately, any API SOFTWARE licence (ESCO's API software
--    is EUPL; its data is not), the attribution the source requires, how Pulse adapted it, the approved slice and the
--    owner's approval reference. ESCO and O*NET only: Lightcast needs a contract and is refused; nothing is fetched.
--  * skill_concept keeps the source's own identifier (ESCO concept URI, O*NET element ID) under a stable Pulse id, so a
--    renamed term, a newer version or a concept the source deprecates never breaks a person's claim. skill_term holds
--    every label (preferred, alternative, hidden, and local names HR adds, which stay marked local and are never shown
--    as official translations); a label a newer version drops stays findable as a former name.
--  * HR's local skills (family 'local') cover what the taxonomy lacks. skill_rubric is the proficiency scale: Pulse's
--    starting four levels (skill_rubric_levels) until HR confirms its own (E16).
--  * person_skill is the person's own claim: level, since, last used, a note, and links to work they did (a task they
--    own, an RE project they are on, an experience entry). Only the person writes it (source 'self'); no job, activity,
--    app usage, chat or delivery count creates or changes one. Linked work shows whether it is approved (an accepted
--    task or work link, a confirmed experience entry) or still only claimed.
--  * skill_verification is a separate mark by the person's manager or pod head, or HR, on one version of a claim, with
--    the level they saw. Changing the claim leaves the mark on the old version ("verified earlier"); a claim never
--    becomes verified by itself and nobody verifies their own.
--  * person_experience: role, dates, responsibilities and outcomes, optionally on an RE project; confirmed the same way.
--  * pulse_priv.person_resume: the internal CV the person reviewed (a snapshot built from these records plus their own
--    headline and summary). Others read only a reviewed snapshot, never a draft, and each read by someone else is in
--    the access log the person sees.
-- Who reads a profile: the person, their manager or pod head (manages()), HR and admins; nothing crosses a company
-- (forced RLS on current_org()). Claims, verifications, experience and CVs have no runtime-role grants: reads and
-- writes go through the functions below. Taxonomy tables are readable reference data for the API.

create table pulse.skill_source (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 family text not null check (family in ('esco', 'onet')),
 version text not null check (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
 language text not null check (language ~ '^[a-z]{2,3}$'),
 file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
 file_name text not null check (length(file_name) between 1 and 200),
 data_licence text not null check (length(btrim(data_licence)) between 3 and 300),
 software_licence text check (length(btrim(software_licence)) between 3 and 300),   -- only when an API/software is used
 attribution text not null check (length(btrim(attribution)) between 10 and 600),
 adapted text not null check (length(btrim(adapted)) between 10 and 600),          -- how Pulse changed it (licence notice)
 source_url text check (source_url ~ '^https://\S+$' and length(source_url) <= 300),
 slice text not null check (length(btrim(slice)) between 3 and 300),
 approval_ref text not null check (length(btrim(approval_ref)) between 3 and 200),
 counts jsonb not null default '{}' check (jsonb_typeof(counts) = 'object'),
 imported_at timestamptz not null default now(),
 superseded_by uuid references pulse.skill_source(id), superseded_at timestamptz,
 unique (org_id, family, language, version),
 unique (org_id, family, language, file_sha256)
);
create unique index skill_source_current on pulse.skill_source(org_id, family, language) where superseded_at is null;

create table pulse.skill_concept (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 family text not null check (family in ('esco', 'onet', 'local')),
 code text not null check (code ~ '^\S+$' and length(code) between 3 and 300),                      -- the source's identifier; local:<uuid> for HR's
 kind text not null default 'skill' check (kind in ('skill', 'knowledge', 'ability', 'work_activity')),
 label text not null check (length(btrim(label)) between 1 and 300),    -- the current preferred label
 description text check (length(description) <= 2000),
 status text not null default 'active' check (status in ('active', 'deprecated', 'absent')),  -- absent: not in the current version or slice
 replaced_by uuid references pulse.skill_concept(id),
 first_source uuid references pulse.skill_source(id), last_source uuid references pulse.skill_source(id),
 deprecated_in uuid references pulse.skill_source(id),
 created_by uuid references pulse.person(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique (org_id, family, code),
 check ((family = 'local') = (last_source is null))
);

create table pulse.skill_term (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 concept_id uuid not null references pulse.skill_concept(id),
 kind text not null check (kind in ('preferred', 'alternative', 'hidden', 'local')),
 language text not null check (language ~ '^[a-z]{2,3}$'),
 label text not null check (length(btrim(label)) between 1 and 300),
 label_key text not null check (length(label_key) between 1 and 300),
 first_source uuid references pulse.skill_source(id), last_source uuid references pulse.skill_source(id),
 created_by uuid references pulse.person(id), created_at timestamptz not null default now(),
 withdrawn_by uuid references pulse.person(id), withdrawn_at timestamptz,          -- a local name HR took back
 unique (org_id, concept_id, kind, language, label_key),
 check (kind <> 'local' or (last_source is null and created_by is not null))
);
create index skill_term_concept on pulse.skill_term(org_id, concept_id);

create table pulse.skill_mapping (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 from_concept uuid not null references pulse.skill_concept(id), to_concept uuid not null references pulse.skill_concept(id),
 relation text not null check (relation in ('exact', 'close', 'broad', 'narrow', 'related')),
 source_id uuid not null references pulse.skill_source(id),
 unique (org_id, from_concept, to_concept, relation), check (from_concept <> to_concept)
);

create table pulse.skill_rubric (                                  -- only once HR confirms; until then Pulse's starting scale
 org_id uuid not null references pulse.org(id), level smallint not null check (level between 1 and 5),
 label text not null check (length(btrim(label)) between 2 and 40),
 description text not null check (length(btrim(description)) between 10 and 400),
 confirmed_by uuid not null references pulse.person(id), confirmed_at timestamptz not null default now(),
 primary key (org_id, level)
);

create table pulse.person_skill (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id),
 concept_id uuid not null references pulse.skill_concept(id),
 source text not null default 'self' check (source = 'self'),     -- a claim is only ever the person's own
 version int not null default 1 check (version >= 1),             -- +1 when level, since or last used change
 level smallint not null check (level between 1 and 5),
 since date check (since = date_trunc('month', since)::date),
 last_used date check (last_used = date_trunc('month', last_used)::date),   -- null: in use now
 note text check (length(note) <= 300),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), removed_at timestamptz,
 check (since is null or last_used is null or since <= last_used)
);
create unique index person_skill_live on pulse.person_skill(org_id, person_id, concept_id) where removed_at is null;

create table pulse.person_experience (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id),
 version int not null default 1 check (version >= 1),
 title text not null check (length(btrim(title)) between 2 and 120),
 project_id uuid references pulse.project(id),
 started date not null check (started = date_trunc('month', started)::date),
 ended date check (ended = date_trunc('month', ended)::date),     -- null: still doing it
 responsibilities text check (length(responsibilities) <= 1500),
 outcomes text check (length(outcomes) <= 1500),
 confirmed_version int, confirmed_by uuid references pulse.person(id), confirmed_at timestamptz,
 confirm_basis text check (confirm_basis in ('manager', 'hr')), confirm_note text check (length(confirm_note) <= 300),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), removed_at timestamptz,
 check (ended is null or started <= ended),
 check (confirmed_by is null or confirmed_by <> person_id),
 check ((confirmed_version is null) = (confirmed_by is null) and (confirmed_by is null) = (confirmed_at is null))
);

create table pulse.person_skill_evidence (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 skill_id uuid not null references pulse.person_skill(id),
 kind text not null check (kind in ('task', 'project', 'experience')),
 task_id uuid references pulse.task(id), project_id uuid references pulse.project(id),
 experience_id uuid references pulse.person_experience(id),
 added_at timestamptz not null default now(), removed_at timestamptz,
 check ((kind = 'task') = (task_id is not null) and (kind = 'project') = (project_id is not null)
   and (kind = 'experience') = (experience_id is not null))
);
create unique index person_skill_evidence_live on pulse.person_skill_evidence(org_id, skill_id, kind, coalesce(task_id, project_id, experience_id))
 where removed_at is null;

create table pulse.skill_verification (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 skill_id uuid not null references pulse.person_skill(id),
 claim_version int not null check (claim_version >= 1),
 level smallint not null check (level between 1 and 5),           -- the level the verifier saw, not the claim's
 verifier_id uuid not null references pulse.person(id),
 basis text not null check (basis in ('manager', 'hr')),
 note text check (length(note) <= 300),
 at timestamptz not null default now(),
 withdrawn_by uuid references pulse.person(id), withdrawn_at timestamptz
);
create index skill_verification_skill on pulse.skill_verification(org_id, skill_id, at desc);

create table pulse_priv.person_resume (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id),
 version int not null check (version >= 1),
 headline text check (length(headline) <= 120),
 summary text check (length(summary) <= 1200),
 skills uuid[] not null default '{}', experience uuid[] not null default '{}',   -- what the person chose to include
 body jsonb not null check (jsonb_typeof(body) = 'object' and pg_column_size(body) < 262144),
 body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
 reviewed_by uuid not null references pulse.person(id), reviewed_at timestamptz not null default now(),
 check (reviewed_by = person_id),
 unique (org_id, person_id, version)
);

do $$ declare t text; begin
 foreach t in array array['pulse.skill_source', 'pulse.skill_concept', 'pulse.skill_term', 'pulse.skill_mapping', 'pulse.skill_rubric',
   'pulse.person_skill', 'pulse.person_experience', 'pulse.person_skill_evidence', 'pulse.skill_verification', 'pulse_priv.person_resume'] loop
  execute format('alter table %s enable row level security', t);
  execute format('alter table %s force row level security', t);
  execute format('create policy tenant on %s using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  execute format('revoke all on %s from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy', t);
 end loop;
 -- Imported concepts, terms and mappings are audited once per import (skill_taxonomy_import), local names per change.
 foreach t in array array['pulse.skill_source', 'pulse.skill_rubric', 'pulse.person_skill', 'pulse.person_experience',
   'pulse.person_skill_evidence', 'pulse.skill_verification', 'pulse_priv.person_resume'] loop
  execute format('create trigger audit_mutation after insert or update on %s for each row execute function pulse.audit_mutation()', t);
 end loop;
end $$;
grant select on pulse.skill_source, pulse.skill_concept, pulse.skill_term, pulse.skill_mapping, pulse.skill_rubric to pulse_api;

-- Nobody verifies their own claim, whichever path writes the row.
create function pulse.skill_verification_guard() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if exists (select 1 from person_skill s where s.id = new.skill_id and s.person_id = new.verifier_id) then
  raise exception 'Nobody verifies their own skill' using errcode = '42501';
 end if;
 return new;
end $$;
create trigger skill_verification_guard before insert or update on pulse.skill_verification for each row execute function pulse.skill_verification_guard();

-- ------------------------------------------------------------------------------------------------------- helpers
create function pulse.skill_key(p text) returns text language sql immutable as $$
 select lower(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')))
$$;
create function pulse.skill_month(p text) returns date language plpgsql immutable as $$
begin
 if p is null or btrim(p) = '' then return null; end if;
 if p !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception 'Use a month like 2026-10' using errcode = '22023'; end if;
 return (p || '-01')::date;
end $$;

-- Who reads a person's skills, experience and reviewed CV: the person, their manager or pod head, HR and admins.
create function pulse.skill_profile_access(p_person uuid) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
 select current_viewer() is not null and exists (select 1 from person where org_id = current_org() and id = p_person and side = 'staff')
  and (p_person = current_viewer() or manages(p_person) or viewer_is('hr', 'admin'))
$$;
-- Who verifies (and on what basis): the person's manager or pod head, or HR; never the person themself.
create function pulse.skill_verifier_basis(p_person uuid) returns text language sql stable security definer set search_path = pulse, pg_temp as $$
 select case when current_viewer() is null or p_person = current_viewer()
   or not exists (select 1 from person where org_id = current_org() and id = p_person and side = 'staff') then null
  when manages(p_person) then 'manager' when viewer_is('hr') then 'hr' end
$$;

-- The proficiency scale: HR's confirmed one, or Pulse's starting four levels (marked unconfirmed) until then.
create function pulse.skill_rubric_levels() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce(
  (select jsonb_build_object('confirmed', true, 'confirmedAt', max(confirmed_at),
     'levels', jsonb_agg(jsonb_build_object('level', level, 'label', label, 'description', description) order by level))
    from skill_rubric where org_id = current_org() having count(*) > 0),
  jsonb_build_object('confirmed', false, 'levels', '[
   {"level":1,"label":"Learning","description":"Has done it with help and is still learning the basics."},
   {"level":2,"label":"Working","description":"Does routine work on their own, to the expected standard."},
   {"level":3,"label":"Strong","description":"Handles difficult cases on their own; colleagues ask them for help."},
   {"level":4,"label":"Expert","description":"Sets the standard: teaches, reviews and improves how the team does it."}]'::jsonb))
$$;
create function pulse.skill_level_label(p_level int) returns text language sql stable security definer set search_path = pulse, pg_temp as $$
 select l->>'label' from jsonb_array_elements(skill_rubric_levels()->'levels') l where (l->>'level')::int = p_level
$$;

-- The current imported versions with their licences and attribution (shown wherever their skills appear).
create function pulse.skill_sources() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', id, 'family', family, 'version', version, 'language', language,
   'dataLicence', data_licence, 'softwareLicence', software_licence, 'attribution', attribution, 'adapted', adapted,
   'sourceUrl', source_url, 'slice', slice, 'importedAt', imported_at, 'counts', counts) order by family, language), '[]')
 from skill_source where org_id = current_org() and superseded_at is null
$$;

-- Whether a person may link this work, and how sure it is: 'approved' (an accepted task, an accepted work link, a
-- confirmed experience entry), 'claimed' (theirs, not yet approved) or null (not their work: refused).
create function pulse.skill_evidence_state(p_person uuid, p_kind text, p_ref uuid) returns text language sql stable security definer set search_path = pulse, pg_temp as $$
 select case p_kind
  when 'task' then (select case when count(*) = 0 then null when bool_or(ok) then 'approved' else 'claimed' end from (
     select t.status = 'accepted' ok from task t where t.org_id = current_org() and t.id = p_ref and t.deleted_at is null
      and (t.owner_id = p_person or t.assignee_person_id = p_person)
     union all select l.status = 'accepted' and t.status = 'accepted' from people_work_link l join task t on t.id = l.task_id and t.deleted_at is null
      where l.org_id = current_org() and l.person_id = p_person and l.kind = 'task' and l.task_id = p_ref and l.status in ('accepted', 'suggested') and l.retired_at is null) x)
  when 'project' then (select case when count(*) = 0 then null when bool_or(ok) then 'approved' else 'claimed' end from (
     select l.status = 'accepted' ok from people_work_link l where l.org_id = current_org() and l.person_id = p_person and l.kind = 'project'
      and l.project_id = p_ref and l.status in ('accepted', 'suggested') and l.retired_at is null
     union all select t.status = 'accepted' from task t where t.org_id = current_org() and t.project_id = p_ref and t.deleted_at is null
      and (t.owner_id = p_person or t.assignee_person_id = p_person) and t.status <> 'cancelled') x)
  when 'experience' then (select case when e.confirmed_version = e.version then 'approved' else 'claimed' end from person_experience e
     where e.org_id = current_org() and e.id = p_ref and e.person_id = p_person and e.removed_at is null)
 end
$$;
create function pulse.skill_evidence_title(p_kind text, p_ref uuid) returns text language sql stable security definer set search_path = pulse, pg_temp as $$
 select case p_kind
  when 'task' then (select title from task where org_id = current_org() and id = p_ref)
  when 'project' then (select coalesce(title, name) from project where org_id = current_org() and id = p_ref)
  when 'experience' then (select title from person_experience where org_id = current_org() and id = p_ref) end
$$;

-- ------------------------------------------------------------------------------------------------------ taxonomy
-- One approved download (owner errand E16), read by the operator's importer (pulse_workers.skill_taxonomy) from a local
-- file: manifest {family, version, language, fileName, fileSha256, dataLicence, softwareLicence?, attribution,
-- sourceUrl?, slice, approvalRef}; concepts [{code, label, kind?, description?, alternative[], hidden[], status?,
-- replacedBy?}]; mappings [{fromFamily, fromCode, toFamily, toCode, relation}]. Ids stay stable across versions; a
-- concept missing from the new version is 'absent', one the source marks obsolete is 'deprecated'; nothing is deleted.
create function pulse.skill_taxonomy_import(p_manifest jsonb, p_concepts jsonb, p_mappings jsonb default '[]') returns jsonb
 language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m jsonb := coalesce(p_manifest, '{}'); fam text := lower(coalesce(m->>'family', '')); lang text := coalesce(nullif(m->>'language', ''), 'en');
 src uuid; prev uuid; c jsonb; cid uuid; a_id uuid; b_id uuid; fresh boolean; v_code text; lbl text; st text; t jsonb; tk text; tl text;
 added int := 0; updated int := 0; deprecated int := 0; absent int := 0; terms int := 0; mapped int := 0; unresolved int := 0;
 att constant text := 'This service uses the ESCO classification of the European Commission.'; total int;
begin
 if current_org() is null then raise exception 'No company selected' using errcode = '42501'; end if;
 if fam = 'lightcast' then
  raise exception 'Lightcast needs a commercial contract (owner errand E16); Pulse imports approved downloads only and never scrapes it' using errcode = '42501';
 end if;
 if fam not in ('esco', 'onet') then raise exception 'Import an approved ESCO or O*NET download' using errcode = '22023'; end if;
 if coalesce(m->>'version', '') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$' then raise exception 'Name the version of the download' using errcode = '22023'; end if;
 if lang !~ '^[a-z]{2,3}$' then raise exception 'Name the language of the labels (en, hi, mr …)' using errcode = '22023'; end if;
 if coalesce(m->>'fileSha256', '') !~ '^[0-9a-f]{64}$' then raise exception 'The file''s SHA-256 is missing' using errcode = '22023'; end if;
 if length(btrim(coalesce(m->>'approvalRef', ''))) < 3 then raise exception 'Record the owner''s approval of the licence and download (E16)' using errcode = '22023'; end if;
 if length(btrim(coalesce(m->>'dataLicence', ''))) < 3 then raise exception 'State the licence of the classification data, as the download states it' using errcode = '22023'; end if;
 if fam = 'esco' and m->>'dataLicence' ~* 'EUPL' then
  raise exception 'The EUPL covers ESCO''s API software, not its classification data: state the download''s data licence' using errcode = '22023';
 end if;
 if length(btrim(coalesce(m->>'attribution', ''))) < 10 then raise exception 'State the attribution the source requires' using errcode = '22023'; end if;
 if fam = 'esco' and position(att in m->>'attribution') = 0 then
  raise exception 'ESCO''s attribution must include: "%"', att using errcode = '22023';
 end if;
 if length(btrim(coalesce(m->>'slice', ''))) < 3 then raise exception 'Describe the approved slice' using errcode = '22023'; end if;
 if jsonb_typeof(p_concepts) is distinct from 'array' or jsonb_array_length(p_concepts) not between 1 and 5000 then
  raise exception 'A narrow slice: 1 to 5,000 concepts' using errcode = '22023';
 end if;
 if exists (select 1 from skill_source where org_id = current_org() and family = fam and language = lang
   and (version = m->>'version' or file_sha256 = m->>'fileSha256')) then
  raise exception 'This version or file is already imported' using errcode = '23505';
 end if;
 select id into prev from skill_source where org_id = current_org() and family = fam and language = lang and superseded_at is null for update;
 if prev is not null then update skill_source set superseded_at = now() where id = prev; end if;
 insert into skill_source(org_id, family, version, language, file_sha256, file_name, data_licence, software_licence, attribution, adapted,
   source_url, slice, approval_ref)
 values (current_org(), fam, m->>'version', lang, m->>'fileSha256', left(coalesce(nullif(btrim(m->>'fileName'), ''), 'download'), 200),
   left(btrim(m->>'dataLicence'), 300), nullif(left(btrim(coalesce(m->>'softwareLicence', '')), 300), ''), left(btrim(m->>'attribution'), 600),
   left(format('Pulse keeps an approved slice (%s concepts) of this download, without changing its labels, and adds local names marked as local.',
     jsonb_array_length(p_concepts)), 600),
   nullif(m->>'sourceUrl', ''), left(btrim(m->>'slice'), 300), left(btrim(m->>'approvalRef'), 200))
 returning id into src;
 if prev is not null then update skill_source set superseded_by = src where id = prev; end if;

 for c in select * from jsonb_array_elements(p_concepts) loop
  v_code := btrim(coalesce(c->>'code', '')); lbl := btrim(regexp_replace(coalesce(c->>'label', ''), '\s+', ' ', 'g'));
  if v_code !~ '^\S+$' or length(v_code) not between 3 and 300 or v_code like 'local:%' then raise exception 'A concept without a valid identifier: %', left(v_code, 80) using errcode = '22023'; end if;
  if length(lbl) not between 1 and 300 then raise exception 'Concept % has no label', left(v_code, 80) using errcode = '22023'; end if;
  st := case when lower(coalesce(c->>'status', 'released')) in ('obsolete', 'deprecated') then 'deprecated' else 'active' end;
  insert into skill_concept(org_id, family, code, kind, label, description, status, first_source, last_source, deprecated_in)
  values (current_org(), fam, v_code, coalesce(nullif(c->>'kind', ''), 'skill'), lbl, nullif(left(c->>'description', 2000), ''), st, src, src,
    case when st = 'deprecated' then src end)
  on conflict (org_id, family, code) do update set label = excluded.label, kind = excluded.kind, description = excluded.description,
   status = excluded.status, last_source = src, updated_at = now(),
   deprecated_in = case when excluded.status = 'deprecated' then coalesce(skill_concept.deprecated_in, src) end
  returning id, (xmax = 0) into cid, fresh;
  if fresh then added := added + 1; else updated := updated + 1; end if;
  if st = 'deprecated' then deprecated := deprecated + 1; end if;
  for tk, t in select 'preferred', to_jsonb(lbl)
    union all select 'alternative', a from jsonb_array_elements(case when jsonb_typeof(c->'alternative') = 'array' then c->'alternative' else '[]' end) a
    union all select 'hidden', h from jsonb_array_elements(case when jsonb_typeof(c->'hidden') = 'array' then c->'hidden' else '[]' end) h loop
   tl := btrim(regexp_replace(coalesce(t #>> '{}', ''), '\s+', ' ', 'g'));
   continue when length(tl) not between 1 and 300;
   insert into skill_term(org_id, concept_id, kind, language, label, label_key, first_source, last_source)
   values (current_org(), cid, tk, lang, tl, skill_key(tl), src, src)
   on conflict (org_id, concept_id, kind, language, label_key) do update set last_source = src, label = excluded.label;
   terms := terms + 1;
  end loop;
 end loop;
 -- Replacements name another concept of the same family by its identifier.
 update skill_concept c set replaced_by = r.id from jsonb_array_elements(p_concepts) x, skill_concept r
  where c.org_id = current_org() and c.family = fam and c.code = btrim(x->>'code') and nullif(btrim(x->>'replacedBy'), '') is not null
   and r.org_id = current_org() and r.family = fam and r.code = btrim(x->>'replacedBy') and r.id <> c.id;
 -- Concepts of the earlier version that this one does not carry stay (claims keep them) but are no longer offered.
 update skill_concept c set status = 'absent', updated_at = now() from skill_source s
  where c.org_id = current_org() and c.family = fam and c.status = 'active' and c.last_source = s.id and s.language = lang and c.last_source <> src;
 get diagnostics absent = row_count;
 if jsonb_typeof(p_mappings) = 'array' then
  for c in select * from jsonb_array_elements(p_mappings) loop
   -- Both ends must already be in Pulse (an earlier or this import); otherwise the mapping is counted, not guessed.
   select id into a_id from skill_concept where org_id = current_org() and family = lower(c->>'fromFamily') and code = btrim(c->>'fromCode');
   select id into b_id from skill_concept where org_id = current_org() and family = lower(c->>'toFamily') and code = btrim(c->>'toCode');
   if a_id is null or b_id is null or a_id = b_id then unresolved := unresolved + 1; continue; end if;
   insert into skill_mapping(org_id, from_concept, to_concept, relation, source_id)
   values (current_org(), a_id, b_id, coalesce(nullif(c->>'relation', ''), 'related'), src) on conflict do nothing;
   mapped := mapped + 1;
  end loop;
 end if;
 select count(*) into total from skill_concept where org_id = current_org() and family = fam and last_source = src;
 update skill_source set counts = jsonb_build_object('concepts', total, 'added', added, 'updated', updated, 'deprecated', deprecated,
   'absent', absent, 'terms', terms, 'mapped', mapped, 'unresolvedMappings', unresolved) where id = src;
 perform audit_write('skill_taxonomy_import', 'pulse.skill_source', src::text, array[fam, m->>'version']);
 return (select counts || jsonb_build_object('sourceId', id, 'superseded', prev) from skill_source where id = src);
end $$;

-- Search the list for the picker: preferred, alternative and local names, and former names (a renamed term still
-- finds its concept). Hidden labels match but are never shown. Concepts no longer offered come last, marked.
create function pulse.skill_catalog(p_q text, p_limit int default 20) returns jsonb
 language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare q text := skill_key(p_q); items jsonb;
begin
 if current_viewer() is null then raise exception 'Sign in to search skills' using errcode = '42501'; end if;
 q := replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_');
 select coalesce(jsonb_agg(y.j order by y.n), '[]') into items from (
  select x.j, row_number() over (order by x.ord, x.rank, length(x.label), x.label) n from (
   select distinct on (c.id) c.label, (c.status <> 'active')::int ord,
    case when t.label_key = q then 0 when t.label_key like q || '%' escape '\' then 1 else 2 end rank,
    jsonb_build_object('id', c.id, 'family', c.family, 'code', c.code, 'label', c.label, 'kind', c.kind, 'status', c.status,
     'local', c.family = 'local', 'description', left(c.description, 240),
     'replacedBy', (select jsonb_build_object('id', r.id, 'label', r.label) from skill_concept r where r.id = c.replaced_by),
     'matched', case when t.kind = 'hidden' or (t.kind = 'preferred' and t.last_source is not distinct from c.last_source) then null
       else jsonb_build_object('label', t.label, 'kind', t.kind, 'language', t.language, 'local', t.kind = 'local',
        'former', t.kind <> 'local' and t.last_source is distinct from c.last_source) end) j
   from skill_concept c join skill_term t on t.org_id = c.org_id and t.concept_id = c.id and t.withdrawn_at is null
   where c.org_id = current_org() and length(q) >= 2 and t.label_key like '%' || q || '%' escape '\'
   order by c.id, case when t.label_key = q then 0 when t.label_key like q || '%' escape '\' then 1 else 2 end,
    (t.kind = 'preferred' and t.last_source is not distinct from c.last_source) desc, (t.kind = 'hidden')
  ) x order by n limit greatest(1, least(coalesce(p_limit, 20), 50))) y;
 return jsonb_build_object('items', items, 'sources', skill_sources());
end $$;

-- HR and admins add a local skill (what the taxonomy lacks) or a local name for any skill (marked local, never an
-- official translation), and take a local name back.
create function pulse.skill_local_add(p_label text, p_description text default null) returns uuid
 language plpgsql security definer set search_path = pulse, pg_temp as $$
declare lbl text := btrim(regexp_replace(coalesce(p_label, ''), '\s+', ' ', 'g')); hit text; cid uuid := gen_random_uuid();
begin
 if current_viewer() is null or not viewer_is('hr', 'admin') then raise exception 'HR and admins add local skills' using errcode = '42501'; end if;
 if length(lbl) not between 2 and 80 then raise exception 'Name the skill in 2 to 80 characters' using errcode = '22023'; end if;
 select c.label into hit from skill_term t join skill_concept c on c.id = t.concept_id
  where t.org_id = current_org() and t.label_key = skill_key(lbl) and t.kind in ('preferred', 'alternative', 'local') and t.withdrawn_at is null
   and c.status = 'active' limit 1;
 if hit is not null then raise exception '"%" is already in the list: add a local name to it instead', hit using errcode = '23505'; end if;
 insert into skill_concept(org_id, id, family, code, label, description, created_by)
 values (current_org(), cid, 'local', 'local:' || cid, lbl, nullif(left(btrim(coalesce(p_description, '')), 400), ''), current_viewer());
 insert into skill_term(org_id, concept_id, kind, language, label, label_key, created_by)
 values (current_org(), cid, 'preferred', 'en', lbl, skill_key(lbl), current_viewer());
 perform audit_write('skill_local_add', 'pulse.skill_concept', cid::text, array['label']);
 return cid;
end $$;
create function pulse.skill_alias_add(p_concept uuid, p_label text, p_language text default 'en') returns uuid
 language plpgsql security definer set search_path = pulse, pg_temp as $$
declare lbl text := btrim(regexp_replace(coalesce(p_label, ''), '\s+', ' ', 'g')); tid uuid;
begin
 if current_viewer() is null or not viewer_is('hr', 'admin') then raise exception 'HR and admins add local names' using errcode = '42501'; end if;
 if not exists (select 1 from skill_concept where org_id = current_org() and id = p_concept) then raise exception 'Choose a skill' using errcode = 'P0002'; end if;
 if length(lbl) not between 2 and 80 then raise exception 'Write the name in 2 to 80 characters' using errcode = '22023'; end if;
 if coalesce(p_language, '') !~ '^[a-z]{2,3}$' then raise exception 'Choose the language of the name' using errcode = '22023'; end if;
 if exists (select 1 from skill_term where org_id = current_org() and concept_id = p_concept and label_key = skill_key(lbl) and withdrawn_at is null) then
  raise exception 'This skill already has that name' using errcode = '23505';
 end if;
 insert into skill_term(org_id, concept_id, kind, language, label, label_key, created_by)
 values (current_org(), p_concept, 'local', p_language, lbl, skill_key(lbl), current_viewer())
 on conflict (org_id, concept_id, kind, language, label_key) do update set withdrawn_at = null, withdrawn_by = null, label = excluded.label
 returning id into tid;
 perform audit_write('skill_alias_add', 'pulse.skill_term', tid::text, array['label', 'language']);
 return tid;
end $$;
create function pulse.skill_alias_withdraw(p_term uuid) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if current_viewer() is null or not viewer_is('hr', 'admin') then raise exception 'HR and admins manage local names' using errcode = '42501'; end if;
 update skill_term set withdrawn_at = now(), withdrawn_by = current_viewer()
  where org_id = current_org() and id = p_term and kind = 'local' and withdrawn_at is null;
 if not found then raise exception 'Only a local name can be taken back' using errcode = 'P0002'; end if;
 perform audit_write('skill_alias_withdraw', 'pulse.skill_term', p_term::text, array['withdrawn_at']);
end $$;

-- HR confirms the proficiency scale (3 to 5 levels, in order). Levels can be renamed or added, never removed, so no
-- claim or verification is left on a level that no longer exists.
create function pulse.skill_rubric_set(p_levels jsonb) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare n int := case when jsonb_typeof(p_levels) = 'array' then jsonb_array_length(p_levels) else 0 end; l jsonb; i int := 0; have int;
begin
 if current_viewer() is null or not viewer_is('hr', 'admin') then raise exception 'HR confirms the proficiency scale' using errcode = '42501'; end if;
 if n not between 3 and 5 then raise exception 'A scale has 3 to 5 levels' using errcode = '22023'; end if;
 select count(*) into have from skill_rubric where org_id = current_org();
 if n < greatest(have, (select coalesce(max(level), 0) from person_skill where org_id = current_org() and removed_at is null),
   (select coalesce(max(level), 0) from skill_verification where org_id = current_org() and withdrawn_at is null)) then
  raise exception 'Levels can be renamed or added, not removed: claims use them' using errcode = '22023';
 end if;
 for l in select * from jsonb_array_elements(p_levels) loop
  i := i + 1;
  if length(btrim(coalesce(l->>'label', ''))) not between 2 and 40 or length(btrim(coalesce(l->>'description', ''))) not between 10 and 400 then
   raise exception 'Level %: a name (2 to 40 characters) and a description (a sentence)', i using errcode = '22023';
  end if;
  insert into skill_rubric(org_id, level, label, description, confirmed_by) values (current_org(), i, btrim(l->>'label'), btrim(l->>'description'), current_viewer())
  on conflict (org_id, level) do update set label = excluded.label, description = excluded.description, confirmed_by = excluded.confirmed_by, confirmed_at = now();
 end loop;
end $$;

-- ------------------------------------------------------------------------------------------------------- claims
-- The person adds or changes one of their own skills. p: level, since and lastUsed ('YYYY-MM'; lastUsed empty = in use
-- now), note, and (when given) evidence [{kind: task|project|experience, id}], which replaces the linked work.
create function pulse.skill_claim_save(p_person uuid, p_concept uuid, p jsonb) returns uuid
 language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s person_skill%rowtype; c skill_concept%rowtype; v_level int; v_since date; v_last date; v_note text; e jsonb; k text; ref uuid;
 keep uuid[] := '{}'; eid uuid; top date := date_trunc('month', current_date)::date;
begin
 if current_viewer() is null or p_person is distinct from current_viewer() then
  raise exception 'Only the person adds or changes their own skills' using errcode = '42501';
 end if;
 if not exists (select 1 from person where org_id = current_org() and id = p_person and side = 'staff') then raise exception 'No staff record' using errcode = 'P0002'; end if;
 select * into c from skill_concept where org_id = current_org() and id = p_concept;
 if not found then raise exception 'Choose a skill from the list' using errcode = 'P0002'; end if;
 select * into s from person_skill where org_id = current_org() and person_id = p_person and concept_id = p_concept and removed_at is null for update;
 if c.status <> 'active' and s.id is null then
  raise exception '"%" is no longer offered%', c.label, coalesce(': choose "' || (select label from skill_concept where id = c.replaced_by) || '" instead', '') using errcode = '22023';
 end if;
 v_level := case when coalesce(p->>'level', '') ~ '^[0-9]$' then (p->>'level')::int end;
 if v_level is null or v_level < 1 or v_level > jsonb_array_length(skill_rubric_levels()->'levels') then
  raise exception 'Choose a level from the scale' using errcode = '22023';
 end if;
 v_since := skill_month(p->>'since'); v_last := skill_month(p->>'lastUsed');
 if v_since > top or v_last > top then raise exception 'A month in the future' using errcode = '22023'; end if;
 if v_since > v_last then raise exception '"Since" comes before "last used"' using errcode = '22023'; end if;
 v_note := nullif(left(btrim(coalesce(p->>'note', '')), 300), '');
 if s.id is null then
  insert into person_skill(org_id, person_id, concept_id, level, since, last_used, note)
  values (current_org(), p_person, p_concept, v_level, v_since, v_last, v_note) returning * into s;
 elsif (s.level, s.since, s.last_used) is distinct from (v_level, v_since, v_last) then
  -- A new version: a verification of the old one stays on it ("verified earlier") and never moves to this one.
  update person_skill set version = version + 1, level = v_level, since = v_since, last_used = v_last, note = v_note, updated_at = now() where id = s.id;
 elsif s.note is distinct from v_note then
  update person_skill set note = v_note, updated_at = now() where id = s.id;
 end if;
 if p ? 'evidence' then
  if jsonb_typeof(p->'evidence') is distinct from 'array' or jsonb_array_length(p->'evidence') > 12 then
   raise exception 'Link up to 12 pieces of work' using errcode = '22023';
  end if;
  for e in select * from jsonb_array_elements(p->'evidence') loop
   k := e->>'kind';
   if k is null or k not in ('task', 'project', 'experience') or coalesce(e->>'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Link a task, an RE project or an experience entry' using errcode = '22023';
   end if;
   ref := (e->>'id')::uuid;
   if skill_evidence_state(p_person, k, ref) is null then raise exception 'Link only work you did' using errcode = '42501'; end if;
   select id into eid from person_skill_evidence where org_id = current_org() and skill_id = s.id and kind = k
    and coalesce(task_id, project_id, experience_id) = ref and removed_at is null;
   if eid is null then
    insert into person_skill_evidence(org_id, skill_id, kind, task_id, project_id, experience_id)
    values (current_org(), s.id, k, case when k = 'task' then ref end, case when k = 'project' then ref end, case when k = 'experience' then ref end)
    returning id into eid;
   end if;
   keep := keep || eid;
  end loop;
  update person_skill_evidence set removed_at = now() where org_id = current_org() and skill_id = s.id and removed_at is null and not (id = any(keep));
 end if;
 return s.id;
end $$;

create function pulse.skill_claim_remove(p_skill uuid) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 update person_skill set removed_at = now(), updated_at = now()
  where org_id = current_org() and id = p_skill and removed_at is null and person_id = current_viewer();
 if not found then raise exception 'Only the person removes their own skill' using errcode = '42501'; end if;
 update person_skill_evidence set removed_at = now() where org_id = current_org() and skill_id = p_skill and removed_at is null;
end $$;

-- A manager, pod head or HR marks the version they saw, at the level they saw. p_version must be the current one.
create function pulse.skill_verify(p_skill uuid, p_version int, p_level int, p_note text default null) returns uuid
 language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s person_skill%rowtype; b text; vid uuid;
begin
 select * into s from person_skill where org_id = current_org() and id = p_skill and removed_at is null for update;
 if not found then raise exception 'This skill is no longer on the profile' using errcode = 'P0002'; end if;
 b := skill_verifier_basis(s.person_id);
 if b is null then raise exception 'A manager, pod head or HR verifies a skill; never the person' using errcode = '42501'; end if;
 if p_version is distinct from s.version then raise exception 'The skill changed since you opened it: look again' using errcode = '40001'; end if;
 if p_level is null or p_level < 1 or p_level > jsonb_array_length(skill_rubric_levels()->'levels') then
  raise exception 'Choose the level you saw' using errcode = '22023';
 end if;
 insert into skill_verification(org_id, skill_id, claim_version, level, verifier_id, basis, note)
 values (current_org(), s.id, s.version, p_level, current_viewer(), b, nullif(left(btrim(coalesce(p_note, '')), 300), '')) returning id into vid;
 return vid;
end $$;
create function pulse.skill_verify_withdraw(p_verification uuid) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 update skill_verification set withdrawn_at = now(), withdrawn_by = current_viewer()
  where org_id = current_org() and id = p_verification and withdrawn_at is null and current_viewer() is not null
   and (verifier_id = current_viewer() or viewer_is('hr'));
 if not found then raise exception 'Only the verifier or HR takes a verification back' using errcode = '42501'; end if;
end $$;

-- ----------------------------------------------------------------------------------------------------- experience
-- The person records what they did here: p {title, projectId?, started, ended?, responsibilities?, outcomes?}.
create function pulse.experience_save(p_person uuid, p_id uuid, p jsonb) returns uuid
 language plpgsql security definer set search_path = pulse, pg_temp as $$
declare e person_experience%rowtype; v_title text := btrim(regexp_replace(coalesce(p->>'title', ''), '\s+', ' ', 'g'));
 v_project uuid; v_start date; v_end date; v_resp text; v_out text; top date := date_trunc('month', current_date)::date; eid uuid;
begin
 if current_viewer() is null or p_person is distinct from current_viewer() then raise exception 'Only the person records their own experience' using errcode = '42501'; end if;
 if not exists (select 1 from person where org_id = current_org() and id = p_person and side = 'staff') then raise exception 'No staff record' using errcode = 'P0002'; end if;
 if length(v_title) not between 2 and 120 then raise exception 'Name the role or piece of work' using errcode = '22023'; end if;
 if coalesce(p->>'projectId', '') <> '' then
  if p->>'projectId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Choose an RE project' using errcode = '22023'; end if;
  v_project := (p->>'projectId')::uuid;
  if skill_evidence_state(p_person, 'project', v_project) is null then raise exception 'Choose an RE project you worked on' using errcode = '42501'; end if;
 end if;
 v_start := skill_month(p->>'started'); v_end := skill_month(p->>'ended');
 if v_start is null then raise exception 'When did it start?' using errcode = '22023'; end if;
 if v_start > top or v_end > top then raise exception 'A month in the future' using errcode = '22023'; end if;
 if v_start > v_end then raise exception 'It ends after it starts' using errcode = '22023'; end if;
 v_resp := nullif(left(btrim(coalesce(p->>'responsibilities', '')), 1500), ''); v_out := nullif(left(btrim(coalesce(p->>'outcomes', '')), 1500), '');
 if p_id is null then
  insert into person_experience(org_id, person_id, title, project_id, started, ended, responsibilities, outcomes)
  values (current_org(), p_person, v_title, v_project, v_start, v_end, v_resp, v_out) returning id into eid;
  return eid;
 end if;
 select * into e from person_experience where org_id = current_org() and id = p_id and person_id = p_person and removed_at is null for update;
 if not found then raise exception 'This entry is no longer on the profile' using errcode = 'P0002'; end if;
 if (e.title, e.project_id, e.started, e.ended, e.responsibilities, e.outcomes) is distinct from (v_title, v_project, v_start, v_end, v_resp, v_out) then
  update person_experience set version = version + 1, title = v_title, project_id = v_project, started = v_start, ended = v_end,
   responsibilities = v_resp, outcomes = v_out, updated_at = now() where id = e.id;
 end if;
 return e.id;
end $$;
create function pulse.experience_remove(p_id uuid) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 update person_experience set removed_at = now(), updated_at = now()
  where org_id = current_org() and id = p_id and removed_at is null and person_id = current_viewer();
 if not found then raise exception 'Only the person removes their own entry' using errcode = '42501'; end if;
 update person_skill_evidence set removed_at = now() where org_id = current_org() and experience_id = p_id and removed_at is null;
end $$;
create function pulse.experience_confirm(p_id uuid, p_version int, p_note text default null) returns void
 language plpgsql security definer set search_path = pulse, pg_temp as $$
declare e person_experience%rowtype; b text;
begin
 select * into e from person_experience where org_id = current_org() and id = p_id and removed_at is null for update;
 if not found then raise exception 'This entry is no longer on the profile' using errcode = 'P0002'; end if;
 b := skill_verifier_basis(e.person_id);
 if b is null then raise exception 'A manager, pod head or HR confirms experience; never the person' using errcode = '42501'; end if;
 if p_version is distinct from e.version then raise exception 'The entry changed since you opened it: look again' using errcode = '40001'; end if;
 update person_experience set confirmed_version = e.version, confirmed_by = current_viewer(), confirmed_at = now(), confirm_basis = b,
  confirm_note = nullif(left(btrim(coalesce(p_note, '')), 300), '') where id = e.id;
end $$;

-- --------------------------------------------------------------------------------------------------------- reads
create function pulse.skill_profile(p_person uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
 if not skill_profile_access(p_person) then
  raise exception 'Skills and CV are for the person, their manager, HR and admins' using errcode = '42501';
 end if;
 return jsonb_build_object(
  'skills', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'conceptId', c.id, 'family', c.family, 'code', c.code, 'label', c.label,
     'kind', c.kind, 'status', c.status, 'local', c.family = 'local',
     'replacedBy', (select jsonb_build_object('id', r.id, 'label', r.label) from skill_concept r where r.id = c.replaced_by),
     'version', s.version, 'level', s.level, 'since', to_char(s.since, 'YYYY-MM'), 'lastUsed', to_char(s.last_used, 'YYYY-MM'),
     'note', s.note, 'updatedAt', s.updated_at,
     'verification', (select jsonb_build_object('id', v.id, 'level', v.level, 'basis', v.basis, 'by', pv.display_name, 'byId', v.verifier_id,
        'at', v.at, 'note', v.note, 'version', v.claim_version, 'current', v.claim_version = s.version)
       from skill_verification v join person pv on pv.id = v.verifier_id
       where v.org_id = current_org() and v.skill_id = s.id and v.withdrawn_at is null order by (v.claim_version = s.version) desc, v.at desc limit 1),
     'evidence', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'ref', coalesce(e.task_id, e.project_id, e.experience_id),
        'title', skill_evidence_title(e.kind, coalesce(e.task_id, e.project_id, e.experience_id)),
        'state', coalesce(skill_evidence_state(s.person_id, e.kind, coalesce(e.task_id, e.project_id, e.experience_id)), 'unavailable')) order by e.added_at)
       from person_skill_evidence e where e.org_id = current_org() and e.skill_id = s.id and e.removed_at is null), '[]'))
    order by s.level desc, c.label)
   from person_skill s join skill_concept c on c.id = s.concept_id
   where s.org_id = current_org() and s.person_id = p_person and s.removed_at is null), '[]'),
  'experience', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'version', e.version, 'title', e.title, 'projectId', e.project_id,
     'project', (select coalesce(pr.title, pr.name) from project pr where pr.id = e.project_id),
     'started', to_char(e.started, 'YYYY-MM'), 'ended', to_char(e.ended, 'YYYY-MM'), 'responsibilities', e.responsibilities, 'outcomes', e.outcomes,
     'confirmed', case when e.confirmed_by is null then null else jsonb_build_object('by', (select display_name from person where id = e.confirmed_by),
        'basis', e.confirm_basis, 'at', e.confirmed_at, 'note', e.confirm_note, 'version', e.confirmed_version, 'current', e.confirmed_version = e.version) end)
    order by e.ended desc nulls first, e.started desc)
   from person_experience e where e.org_id = current_org() and e.person_id = p_person and e.removed_at is null), '[]'),
  'rubric', skill_rubric_levels(), 'sources', skill_sources(),
  'can', jsonb_build_object('edit', p_person = current_viewer(), 'verify', skill_verifier_basis(p_person) is not null,
    'curate', viewer_is('hr', 'admin')));
end $$;

-- Work the person may link: their tasks and RE projects (most recent first), with whether each is approved yet.
create function pulse.skill_work_options(p_q text default null) returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
 with me as (select current_viewer() id), q as (select '%' || replace(replace(replace(skill_key(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%' pat)
 select jsonb_build_object(
  'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'state', skill_evidence_state(me.id, 'task', x.id)) order by x.at desc nulls last)
    from (select t.id, t.title, coalesce(t.accepted_at, t.done_at, t.created_at) at from task t, me, q
      where t.org_id = current_org() and t.deleted_at is null and t.status <> 'cancelled' and (t.owner_id = me.id or t.assignee_person_id = me.id)
       and lower(t.title) like q.pat escape '\' order by coalesce(t.accepted_at, t.done_at, t.created_at) desc nulls last limit 30) x, me), '[]'),
  'projects', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'state', skill_evidence_state(me.id, 'project', x.id)) order by x.title)
    from (select distinct pr.id, coalesce(pr.title, pr.name) title from project pr, me, q
      where pr.org_id = current_org() and skill_evidence_state(me.id, 'project', pr.id) is not null
       and lower(coalesce(pr.title, pr.name)) like q.pat escape '\' limit 30) x, me), '[]'))
 from me where me.id is not null
$$;

-- --------------------------------------------------------------------------------------------------------- CV
-- The CV built from the records: the chosen skills (self level, the current verification or "self-assessed", approved
-- work by title, claimed work counted) and experience (confirmed or self-reported), the person's own headline and
-- summary, the scale used and each taxonomy's attribution. No pay, attendance, activity, chat or contact detail.
create function pulse.resume_build(p_person uuid, p_headline text, p_summary text, p_skills uuid[], p_experience uuid[]) returns jsonb
 language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object(
  'person', (select jsonb_build_object('name', p.display_name, 'role', pp.role, 'team', pp.department, 'pod', pp.pod, 'joined', pp.joined_on)
    from person p left join people_profile pp on pp.person_id = p.id where p.org_id = current_org() and p.id = p_person),
  'headline', nullif(left(btrim(coalesce(p_headline, '')), 120), ''), 'summary', nullif(left(btrim(coalesce(p_summary, '')), 1200), ''),
  'skills', coalesce((select jsonb_agg(jsonb_build_object('label', c.label, 'family', c.family, 'code', c.code, 'local', c.family = 'local',
     'level', s.level, 'levelLabel', skill_level_label(s.level), 'since', to_char(s.since, 'YYYY-MM'), 'lastUsed', to_char(s.last_used, 'YYYY-MM'),
     'verified', (select jsonb_build_object('level', v.level, 'levelLabel', skill_level_label(v.level), 'by', pv.display_name, 'basis', v.basis, 'at', v.at::date)
       from skill_verification v join person pv on pv.id = v.verifier_id
       where v.org_id = current_org() and v.skill_id = s.id and v.claim_version = s.version and v.withdrawn_at is null order by v.at desc limit 1),
     'approvedWork', coalesce((select jsonb_agg(skill_evidence_title(e.kind, coalesce(e.task_id, e.project_id, e.experience_id)) order by e.added_at)
       from person_skill_evidence e where e.org_id = current_org() and e.skill_id = s.id and e.removed_at is null
        and skill_evidence_state(p_person, e.kind, coalesce(e.task_id, e.project_id, e.experience_id)) = 'approved'), '[]'),
     'claimedWork', (select count(*) from person_skill_evidence e where e.org_id = current_org() and e.skill_id = s.id and e.removed_at is null
        and skill_evidence_state(p_person, e.kind, coalesce(e.task_id, e.project_id, e.experience_id)) = 'claimed'))
    order by s.level desc, c.label)
   from person_skill s join skill_concept c on c.id = s.concept_id
   where s.org_id = current_org() and s.person_id = p_person and s.removed_at is null and s.id = any(p_skills)), '[]'),
  'experience', coalesce((select jsonb_agg(jsonb_build_object('title', e.title, 'project', (select coalesce(pr.title, pr.name) from project pr where pr.id = e.project_id),
     'started', to_char(e.started, 'YYYY-MM'), 'ended', to_char(e.ended, 'YYYY-MM'), 'responsibilities', e.responsibilities, 'outcomes', e.outcomes,
     'confirmed', case when e.confirmed_version = e.version then jsonb_build_object('by', (select display_name from person where id = e.confirmed_by), 'basis', e.confirm_basis) end)
    order by e.ended desc nulls first, e.started desc)
   from person_experience e where e.org_id = current_org() and e.person_id = p_person and e.removed_at is null and e.id = any(p_experience)), '[]'),
  'scale', skill_rubric_levels(),
  'attribution', coalesce((select jsonb_agg(distinct src.attribution) from person_skill s join skill_concept c on c.id = s.concept_id
    join skill_source src on src.id = c.last_source
    where s.org_id = current_org() and s.person_id = p_person and s.removed_at is null and s.id = any(p_skills)), '[]'))
$$;

-- What the CV would say now (the person only): their last choice, or everything on the profile.
create function pulse.resume_draft(p_person uuid, p jsonb default null) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare r pulse_priv.person_resume%rowtype; sk uuid[]; ex uuid[]; h text; su text; b jsonb;
begin
 if current_viewer() is null or p_person is distinct from current_viewer() then raise exception 'Only the person sees their CV draft' using errcode = '42501'; end if;
 select * into r from pulse_priv.person_resume where org_id = current_org() and person_id = p_person order by version desc limit 1;
 sk := case when p ? 'skills' then array(select x::uuid from jsonb_array_elements_text(p->'skills') x)
  when r.id is not null then r.skills else array(select id from person_skill where org_id = current_org() and person_id = p_person and removed_at is null) end;
 ex := case when p ? 'experience' then array(select x::uuid from jsonb_array_elements_text(p->'experience') x)
  when r.id is not null then r.experience else array(select id from person_experience where org_id = current_org() and person_id = p_person and removed_at is null) end;
 h := case when p ? 'headline' then p->>'headline' else r.headline end; su := case when p ? 'summary' then p->>'summary' else r.summary end;
 b := resume_build(p_person, h, su, sk, ex);
 -- The person reviews exactly this text: resume_review keeps it only if the records still build the same CV.
 return jsonb_build_object('body', b, 'sha256', encode(sha256(convert_to(b::text, 'UTF8')), 'hex'), 'skills', to_jsonb(sk),
  'experience', to_jsonb(ex), 'headline', h, 'summary', su, 'reviewedVersion', r.version);
end $$;

-- The person reviews the CV and keeps it as the version others may read.
create function pulse.resume_review(p_person uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare d jsonb; b jsonb; n int; rid uuid; sha text;
begin
 if current_viewer() is null or p_person is distinct from current_viewer() then raise exception 'Only the person reviews their own CV' using errcode = '42501'; end if;
 if not (p ? 'skills' and p ? 'experience') then raise exception 'Choose what the CV includes' using errcode = '22023'; end if;
 d := resume_draft(p_person, p); b := d->'body';
 if jsonb_array_length(b->'skills') = 0 and jsonb_array_length(b->'experience') = 0 then
  raise exception 'Add a skill or an experience entry first' using errcode = '22023';
 end if;
 if coalesce(p->>'sha256', '') <> encode(sha256(convert_to(b::text, 'UTF8')), 'hex') then
  raise exception 'The CV changed since you read it: look again' using errcode = '40001';
 end if;
 select coalesce(max(version), 0) + 1 into n from pulse_priv.person_resume where org_id = current_org() and person_id = p_person;
 sha := encode(sha256(convert_to(b::text, 'UTF8')), 'hex');
 insert into pulse_priv.person_resume(org_id, person_id, version, headline, summary, skills, experience, body, body_sha256, reviewed_by)
 values (current_org(), p_person, n, b->>'headline', b->>'summary', array(select x::uuid from jsonb_array_elements_text(d->'skills') x),
   array(select x::uuid from jsonb_array_elements_text(d->'experience') x), b, sha, current_viewer()) returning id into rid;
 return jsonb_build_object('id', rid, 'version', n, 'sha256', sha);
end $$;

-- The reviewed CV (never a draft) for the person, their manager or pod head, HR and admins. A read by anyone but the
-- person is logged (view or export); the person sees whether the records changed since and who opened it.
create function pulse.resume_read(p_person uuid, p_purpose text default 'view') returns jsonb
 language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r pulse_priv.person_resume%rowtype; self boolean := p_person = current_viewer(); now_body jsonb;
begin
 if not skill_profile_access(p_person) then raise exception 'A CV is for the person, their manager, HR and admins' using errcode = '42501'; end if;
 if p_purpose not in ('view', 'export') then raise exception 'View or export' using errcode = '22023'; end if;
 select * into r from pulse_priv.person_resume where org_id = current_org() and person_id = p_person order by version desc limit 1;
 if r.id is null then return jsonb_build_object('reviewed', null, 'self', self); end if;
 if not self then
  insert into privacy.access_log(org_id, viewer_id, subject_person_id, resource, grain, purpose)
  values (current_org(), current_viewer(), p_person, 'people.resume', 'person', 'resume_' || p_purpose);
 end if;
 if self then now_body := resume_build(p_person, r.headline, r.summary, r.skills, r.experience); end if;
 return jsonb_build_object('self', self, 'reviewed', jsonb_build_object('id', r.id, 'version', r.version, 'reviewedAt', r.reviewed_at,
   'sha256', r.body_sha256, 'body', r.body),
  'changedSince', case when self then encode(sha256(convert_to(now_body::text, 'UTF8')), 'hex') <> r.body_sha256 end,
  'openedBy', case when self then coalesce((select jsonb_agg(jsonb_build_object('by', pv.display_name, 'purpose', a.purpose, 'at', a.at) order by a.at desc)
    from (select * from privacy.access_log where org_id = current_org() and subject_person_id = p_person and resource = 'people.resume'
      order by at desc limit 10) a left join person pv on pv.id = a.viewer_id), '[]') end);
end $$;

revoke all on function pulse.skill_verification_guard(), pulse.skill_key(text), pulse.skill_month(text), pulse.skill_profile_access(uuid),
 pulse.skill_verifier_basis(uuid), pulse.skill_rubric_levels(), pulse.skill_level_label(int), pulse.skill_sources(),
 pulse.skill_evidence_state(uuid, text, uuid), pulse.skill_evidence_title(text, uuid), pulse.skill_taxonomy_import(jsonb, jsonb, jsonb),
 pulse.skill_catalog(text, int), pulse.skill_local_add(text, text), pulse.skill_alias_add(uuid, text, text), pulse.skill_alias_withdraw(uuid),
 pulse.skill_rubric_set(jsonb), pulse.skill_claim_save(uuid, uuid, jsonb), pulse.skill_claim_remove(uuid), pulse.skill_verify(uuid, int, int, text),
 pulse.skill_verify_withdraw(uuid), pulse.experience_save(uuid, uuid, jsonb), pulse.experience_remove(uuid), pulse.experience_confirm(uuid, int, text),
 pulse.skill_profile(uuid), pulse.skill_work_options(text), pulse.resume_build(uuid, text, text, uuid[], uuid[]), pulse.resume_draft(uuid, jsonb),
 pulse.resume_review(uuid, jsonb), pulse.resume_read(uuid, text) from public;
grant execute on function pulse.skill_key(text), pulse.skill_profile_access(uuid), pulse.skill_verifier_basis(uuid), pulse.skill_rubric_levels(),
 pulse.skill_sources(), pulse.skill_catalog(text, int), pulse.skill_local_add(text, text), pulse.skill_alias_add(uuid, text, text),
 pulse.skill_alias_withdraw(uuid), pulse.skill_rubric_set(jsonb), pulse.skill_claim_save(uuid, uuid, jsonb), pulse.skill_claim_remove(uuid),
 pulse.skill_verify(uuid, int, int, text), pulse.skill_verify_withdraw(uuid), pulse.experience_save(uuid, uuid, jsonb), pulse.experience_remove(uuid),
 pulse.experience_confirm(uuid, int, text), pulse.skill_profile(uuid), pulse.skill_work_options(text), pulse.resume_draft(uuid, jsonb),
 pulse.resume_review(uuid, jsonb), pulse.resume_read(uuid, text) to pulse_api;
-- The operator's importer runs on the worker connection; the worker reaches nothing else here (no claims, no CVs).
grant execute on function pulse.skill_taxonomy_import(jsonb, jsonb, jsonb) to pulse_worker;

-- migrate:down
-- Forward-only: taxonomy versions, claims, verifications, experience and reviewed CVs are retained.
