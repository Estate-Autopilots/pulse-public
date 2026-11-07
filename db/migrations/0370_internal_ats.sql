-- migrate:up
-- R49 (12 Oct 2026): explainable internal job matching (PLAN P22; owner voice 8 Oct §5 "internal ATS"), on R48's skills.
--  * A job (ats_job) lists skill requirements (ats_requirement): required or preferred, an optional minimum level on the
--    scale and an optional "used within N months", and other skills the job accepts as the same (the author's choice).
--  * Matching is deterministic and published: ats_weights holds HR's versions of the weights (version 0 is Pulse's
--    starting set, ats_default_weights). Each requirement is matched, unknown or missing for a person:
--      matched  the person has the skill (or one the job accepts, an approved exact/close mapping, or one the source
--               replaced by it) at the level asked on the record: a current verification's level, else their own;
--      unknown  nothing on record: no evidence is not inability; it scores nothing, never a minus, and "up to" shows
--               what checking could add;
--      missing  the record shows a lower level than the job asks (correctable: the person changes it or is verified).
--    A match is worth the requirement's weight × how it is known (verified, self-assessed with approved work, or
--    self-assessed) × close mapping × not used recently. Several skills that satisfy one requirement count once (the
--    strongest); every skill considered is listed with why it counted or not.
--  * Inputs are only: the job, its requirements, the weights, the skill list (concepts, approved mappings), the person's
--    claims, their current verifications and whether their linked work is approved (R48). Never attendance, presence,
--    leave, pay, chats, app activity, credit, contact or private profile fields (pronouns, languages, joining date,
--    location …); tests/core/test_internal_ats.py changes those and checks that no score moves, and reads the
--    evaluator's source for any other table.
--  * HR and admins see the ranked internal candidates (active staff of this company; no external applicants: owner
--    errand E16) with every contribution. Nobody is filtered out or rejected by Pulse: a reviewer picks (ats_pick, with
--    a reason and the explanation as it stood) and only once HR has accepted the current weights (ats_acceptance, E16).
--  * Correction: a reviewer asks the person to check what Pulse read for one requirement (ats_check); the person sees
--    the question and that reading (not the job or anyone else), corrects their skills or answers, and HR closes it.
-- Nothing crosses a company (forced RLS on current_org()); runtime roles reach the tables only through these functions.

create table pulse.ats_weights (
 org_id uuid not null references pulse.org(id),
 version int not null check (version >= 1),
 weights jsonb not null check (jsonb_typeof(weights) = 'object'),
 reason text not null check (length(btrim(reason)) between 3 and 300),
 set_by uuid not null references pulse.person(id), set_at timestamptz not null default now(),
 primary key (org_id, version)
);

create table pulse.ats_job (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 title text not null check (length(btrim(title)) between 2 and 120),
 purpose text check (length(purpose) <= 1500),
 status text not null default 'draft' check (status in ('draft', 'open', 'closed')),
 created_by uuid not null references pulse.person(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table pulse.ats_requirement (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 job_id uuid not null references pulse.ats_job(id),
 concept_id uuid not null references pulse.skill_concept(id),
 importance text not null check (importance in ('required', 'preferred')),
 min_level smallint check (min_level between 1 and 5),
 recent_months smallint check (recent_months between 1 and 240),
 also uuid[] not null default '{}' check (cardinality(also) <= 10),
 note text check (length(note) <= 300),
 position int not null default 0,
 version int not null default 1 check (version >= 1),
 created_by uuid not null references pulse.person(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 removed_at timestamptz
);
create unique index ats_requirement_live on pulse.ats_requirement(org_id, job_id, concept_id) where removed_at is null;

create table pulse.ats_pick (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 job_id uuid not null references pulse.ats_job(id), person_id uuid not null references pulse.person(id),
 note text not null check (length(btrim(note)) between 3 and 300),
 match jsonb not null check (jsonb_typeof(match) = 'object'),     -- the explanation as the reviewer saw it
 weights_version int not null check (weights_version >= 0),
 picked_by uuid not null references pulse.person(id), picked_at timestamptz not null default now(),
 withdrawn_by uuid references pulse.person(id), withdrawn_at timestamptz, withdraw_note text check (length(withdraw_note) <= 300),
 check (picked_by <> person_id)
);
create unique index ats_pick_live on pulse.ats_pick(org_id, job_id, person_id) where withdrawn_at is null;

create table pulse.ats_check (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 job_id uuid not null references pulse.ats_job(id), person_id uuid not null references pulse.person(id),
 requirement_id uuid not null references pulse.ats_requirement(id),
 question text not null check (length(btrim(question)) between 3 and 500),
 before jsonb not null check (jsonb_typeof(before) = 'object'),   -- what Pulse read when HR asked
 asked_by uuid not null references pulse.person(id), asked_at timestamptz not null default now(),
 answer text check (length(answer) <= 500), after jsonb, answered_at timestamptz,
 closed_by uuid references pulse.person(id), closed_at timestamptz, close_note text check (length(close_note) <= 300),
 check (asked_by <> person_id), check ((answered_at is null) = (after is null))
);
create unique index ats_check_open on pulse.ats_check(org_id, job_id, person_id, requirement_id) where closed_at is null;
create index ats_check_person on pulse.ats_check(org_id, person_id, asked_at desc);

create table pulse.ats_acceptance (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 weights_version int not null check (weights_version >= 0),
 accepted_by uuid not null references pulse.person(id),
 note text not null check (length(btrim(note)) between 10 and 600),
 at timestamptz not null default now()
);

do $$ declare t text; begin
 foreach t in array array['pulse.ats_weights', 'pulse.ats_job', 'pulse.ats_requirement', 'pulse.ats_pick', 'pulse.ats_check', 'pulse.ats_acceptance'] loop
  execute format('alter table %s enable row level security', t);
  execute format('alter table %s force row level security', t);
  execute format('create policy tenant on %s using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  execute format('revoke all on %s from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy', t);
  execute format('create trigger audit_mutation after insert or update on %s for each row execute function pulse.audit_mutation()', t);
 end loop;
end $$;

-- ------------------------------------------------------------------------------------------------------- helpers
-- Pulse's published starting weights (version 0) until HR sets its own.
create function pulse.ats_default_weights() returns jsonb language sql immutable as $$
 select '{"required": 3, "preferred": 1, "verified": 1, "approvedWork": 0.8, "self": 0.6, "close": 0.75, "notRecent": 0.5}'::jsonb
$$;

-- Who reviews matches: HR and admins, the people who already read every skill profile (R48).
create function pulse.ats_reviewer() returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
 select current_viewer() is not null and viewer_is('hr', 'admin')
$$;

-- The weights in force, with HR's acceptance of that version (null until HR accepts it).
create function pulse.ats_weights_current() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
 with cur as (
  select coalesce((select jsonb_build_object('version', w.version, 'weights', w.weights, 'reason', w.reason, 'setBy', p.display_name, 'setAt', w.set_at, 'default', false)
    from ats_weights w left join person p on p.id = w.set_by where w.org_id = current_org() order by w.version desc limit 1),
   jsonb_build_object('version', 0, 'weights', ats_default_weights(), 'reason', 'Pulse''s published starting weights', 'setBy', null, 'setAt', null, 'default', true)) j)
 select cur.j || jsonb_build_object('accepted', (select jsonb_build_object('by', p.display_name, 'at', a.at, 'note', a.note)
   from ats_acceptance a left join person p on p.id = a.accepted_by
   where a.org_id = current_org() and a.weights_version = (cur.j->>'version')::int order by a.at desc limit 1))
 from cur
$$;

create function pulse.ats_person_name(p_person uuid) returns text language sql stable security definer set search_path = pulse, pg_temp as $$
 select display_name from person where org_id = current_org() and id = p_person
$$;

-- ---------------------------------------------------------------------------------------------------- the method
-- One requirement for one person. Reads only: the requirement, the skill list and its approved mappings, the person's
-- claims, their current verifications and whether their linked work is approved. w: the weights in force.
create function pulse.ats_requirement_eval(p_req uuid, p_person uuid, w jsonb) returns jsonb
 language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare r ats_requirement%rowtype; c record; v_weight numeric; v_cutoff date; v_level int; v_basis text; v_recent boolean; v_meets boolean;
 v_factor numeric; v_item jsonb; v_best jsonb; v_best_factor numeric := -1; v_items jsonb := '[]'; v_outcome text; v_points numeric := 0; v_related jsonb;
begin
 select * into r from ats_requirement where org_id = current_org() and id = p_req;
 if not found then return null; end if;
 v_weight := (w->>r.importance)::numeric;
 v_cutoff := case when r.recent_months is not null then (date_trunc('month', current_date) - make_interval(months => r.recent_months))::date end;
 for c in
  with acc as (
   select r.concept_id cid, 'same'::text via, 1::numeric f
   union all select a, 'alternative', 1 from unnest(r.also) a
   union all select case when m.from_concept = r.concept_id then m.to_concept else m.from_concept end, m.relation,
     case when m.relation = 'exact' then 1 else (w->>'close')::numeric end
    from skill_mapping m where m.org_id = current_org() and m.relation in ('exact', 'close') and r.concept_id in (m.from_concept, m.to_concept)
   union all select k.id, 'replaced', 1 from skill_concept k where k.org_id = current_org() and k.replaced_by = r.concept_id
  ), via as (
   select distinct on (cid) cid, via, f from acc
   order by cid, f desc, array_position(array['same', 'alternative', 'replaced', 'exact', 'close'], via)
  )
  select s.id, s.version, s.level, s.last_used, k.label, k.family, via.via, via.f,
   (select jsonb_build_object('level', v.level, 'by', ats_person_name(v.verifier_id), 'basis', v.basis, 'at', v.at::date)
     from skill_verification v where v.org_id = current_org() and v.skill_id = s.id and v.claim_version = s.version and v.withdrawn_at is null
     order by v.at desc limit 1) ver,
   exists (select 1 from skill_verification v where v.org_id = current_org() and v.skill_id = s.id and v.claim_version < s.version and v.withdrawn_at is null) earlier,
   (select count(*) from person_skill_evidence e where e.org_id = current_org() and e.skill_id = s.id and e.removed_at is null
     and skill_evidence_state(p_person, e.kind, coalesce(e.task_id, e.project_id, e.experience_id)) = 'approved') approved
  from via join person_skill s on s.org_id = current_org() and s.concept_id = via.cid and s.person_id = p_person and s.removed_at is null
  join skill_concept k on k.id = s.concept_id
  order by array_position(array['same', 'alternative', 'replaced', 'exact', 'close'], via.via), k.label
 loop
  v_level := coalesce((c.ver->>'level')::int, c.level);
  v_basis := case when c.ver is not null then 'verified' when c.approved > 0 then 'approvedWork' else 'self' end;
  v_meets := r.min_level is null or v_level >= r.min_level;
  v_recent := v_cutoff is null or c.last_used is null or c.last_used >= v_cutoff;
  v_factor := round((w->>v_basis)::numeric * c.f * case when v_recent then 1 else (w->>'notRecent')::numeric end, 4);
  v_item := jsonb_build_object('skillId', c.id, 'label', c.label, 'family', c.family, 'via', c.via, 'viaFactor', c.f,
   'selfLevel', c.level, 'verified', c.ver, 'verifiedEarlier', c.ver is null and c.earlier, 'approvedWork', c.approved,
   'level', v_level, 'basis', v_basis, 'basisFactor', (w->>v_basis)::numeric, 'lastUsed', to_char(c.last_used, 'YYYY-MM'),
   'recent', v_recent, 'meetsLevel', v_meets, 'factor', case when v_meets then v_factor else 0 end);
  v_items := v_items || jsonb_build_array(v_item);
  if v_meets and v_factor > v_best_factor then v_best := v_item; v_best_factor := v_factor; end if;
 end loop;
 if jsonb_array_length(v_items) = 0 then
  v_outcome := 'unknown';
  -- Broader, narrower or related skills on record are a hint for the reviewer; they never count.
  select jsonb_agg(distinct k.label) into v_related from skill_mapping m
   join person_skill s on s.org_id = current_org() and s.person_id = p_person and s.removed_at is null
    and s.concept_id = case when m.from_concept = r.concept_id then m.to_concept else m.from_concept end
   join skill_concept k on k.id = s.concept_id
   where m.org_id = current_org() and m.relation in ('broad', 'narrow', 'related') and r.concept_id in (m.from_concept, m.to_concept);
 elsif v_best is null then v_outcome := 'missing';
 else v_outcome := 'matched'; v_points := round(v_weight * v_best_factor, 2);
 end if;
 return jsonb_build_object('requirementId', r.id, 'conceptId', r.concept_id, 'label', (select label from skill_concept where id = r.concept_id),
  'importance', r.importance, 'minLevel', r.min_level, 'recentMonths', r.recent_months, 'weight', v_weight,
  'outcome', v_outcome, 'points', v_points, 'counted', v_best->'skillId',
  'considered', (select coalesce(jsonb_agg(i || jsonb_build_object('counted', coalesce(i->'skillId' = v_best->'skillId', false))), '[]') from jsonb_array_elements(v_items) i),
  'related', coalesce(v_related, '[]'));
end $$;

-- A whole job for one person: every requirement, points, the most it could be, and what checking unknowns could add.
create function pulse.ats_match_eval(p_job uuid, p_person uuid, w jsonb) returns jsonb
 language sql stable security definer set search_path = pulse, pg_temp as $$
 with e as (
  select ats_requirement_eval(r.id, p_person, w) j, r.position, r.created_at from ats_requirement r
  where r.org_id = current_org() and r.job_id = p_job and r.removed_at is null
 )
 select jsonb_build_object(
  'requirements', coalesce(jsonb_agg(j order by (j->>'importance') = 'preferred', position, created_at), '[]'),
  'points', coalesce(sum((j->>'points')::numeric), 0),
  'max', coalesce(sum((j->>'weight')::numeric), 0),
  'upTo', coalesce(sum((j->>'points')::numeric), 0) + coalesce(sum((j->>'weight')::numeric) filter (where j->>'outcome' = 'unknown'), 0),
  'matched', count(*) filter (where j->>'outcome' = 'matched'), 'unknown', count(*) filter (where j->>'outcome' = 'unknown'),
  'missing', count(*) filter (where j->>'outcome' = 'missing'),
  'requiredUnknown', count(*) filter (where j->>'outcome' = 'unknown' and j->>'importance' = 'required'),
  'requiredMissing', count(*) filter (where j->>'outcome' = 'missing' and j->>'importance' = 'required'))
 from e
$$;

-- ---------------------------------------------------------------------------------------------------- weights
-- Published to everyone signed in: the weights in force, earlier versions and HR's acceptances.
create function pulse.ats_method() returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
 if current_viewer() is null then raise exception 'Sign in to read how matching works' using errcode = '42501'; end if;
 return jsonb_build_object('current', ats_weights_current(), 'defaults', ats_default_weights(),
  'versions', coalesce((select jsonb_agg(jsonb_build_object('version', w.version, 'weights', w.weights, 'reason', w.reason, 'setBy', ats_person_name(w.set_by), 'setAt', w.set_at)
    order by w.version desc) from ats_weights w where w.org_id = current_org()), '[]'),
  'acceptances', coalesce((select jsonb_agg(jsonb_build_object('version', a.weights_version, 'by', ats_person_name(a.accepted_by), 'at', a.at, 'note', a.note) order by a.at desc)
    from ats_acceptance a where a.org_id = current_org()), '[]'),
  'can', jsonb_build_object('review', ats_reviewer(), 'accept', viewer_is('hr')));
end $$;

-- HR and admins publish a new version of the weights. Required counts at least as much as preferred; verified evidence
-- at least as much as self-assessed with approved work, which counts at least as much as self-assessed alone.
create function pulse.ats_weights_set(p jsonb, p_reason text) returns int language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k text; v jsonb := '{}'; n numeric; ver int;
begin
 if not ats_reviewer() then raise exception 'HR and admins set the matching weights' using errcode = '42501'; end if;
 if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Say why the weights change' using errcode = '22023'; end if;
 foreach k in array array['required', 'preferred', 'verified', 'approvedWork', 'self', 'close', 'notRecent'] loop
  if jsonb_typeof(p->k) is distinct from 'number' then raise exception 'Give a number for "%"', k using errcode = '22023'; end if;
  n := round((p->>k)::numeric, 2);
  if k in ('required', 'preferred') and n not between 0 and 10 then raise exception 'Points per requirement are 0 to 10' using errcode = '22023'; end if;
  if k not in ('required', 'preferred') and n not between 0 and 1 then raise exception '"%" is a share between 0 and 1', k using errcode = '22023'; end if;
  v := v || jsonb_build_object(k, n);
 end loop;
 if (v->>'required')::numeric < 1 then raise exception 'A required skill is worth at least 1 point' using errcode = '22023'; end if;
 if (v->>'preferred')::numeric > (v->>'required')::numeric then raise exception 'A preferred skill cannot count more than a required one' using errcode = '22023'; end if;
 if not ((v->>'verified')::numeric >= (v->>'approvedWork')::numeric and (v->>'approvedWork')::numeric >= (v->>'self')::numeric and (v->>'verified')::numeric > 0) then
  raise exception 'Verified counts at least as much as approved work, which counts at least as much as self-assessed' using errcode = '22023';
 end if;
 select coalesce(max(version), 0) + 1 into ver from ats_weights where org_id = current_org();
 insert into ats_weights(org_id, version, weights, reason, set_by) values (current_org(), ver, v, left(btrim(p_reason), 300), current_viewer());
 return ver;
end $$;

-- HR (the HR role, not an admin alone) accepts the weights in force after reading example explanations (E16). Until
-- then the ranking is for trying out only and nobody can be picked.
create function pulse.ats_accept(p_version int, p_note text) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare aid uuid;
begin
 if current_viewer() is null or not viewer_is('hr') then raise exception 'HR accepts the matching method' using errcode = '42501'; end if;
 if p_version is distinct from (ats_weights_current()->>'version')::int then raise exception 'The weights changed since you read them: look again' using errcode = '40001'; end if;
 if length(btrim(coalesce(p_note, ''))) < 10 then raise exception 'Say which example explanations you checked' using errcode = '22023'; end if;
 insert into ats_acceptance(org_id, weights_version, accepted_by, note) values (current_org(), p_version, current_viewer(), left(btrim(p_note), 600)) returning id into aid;
 return aid;
end $$;

-- ---------------------------------------------------------------------------------------------------------- jobs
create function pulse.ats_job_save(p_id uuid, p jsonb) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_title text := btrim(regexp_replace(coalesce(p->>'title', ''), '\s+', ' ', 'g')); v_status text := coalesce(nullif(p->>'status', ''), 'draft');
 v_purpose text := nullif(left(btrim(coalesce(p->>'purpose', '')), 1500), ''); jid uuid;
begin
 if not ats_reviewer() then raise exception 'HR and admins describe internal jobs' using errcode = '42501'; end if;
 if length(v_title) not between 2 and 120 then raise exception 'Name the job in 2 to 120 characters' using errcode = '22023'; end if;
 if v_status not in ('draft', 'open', 'closed') then raise exception 'Draft, open or closed' using errcode = '22023'; end if;
 if p_id is null then
  insert into ats_job(org_id, title, purpose, status, created_by) values (current_org(), v_title, v_purpose, v_status, current_viewer()) returning id into jid;
  return jid;
 end if;
 update ats_job set title = v_title, purpose = v_purpose, status = v_status, updated_at = now() where org_id = current_org() and id = p_id returning id into jid;
 if jid is null then raise exception 'Job not found' using errcode = 'P0002'; end if;
 return jid;
end $$;

-- p: conceptId, importance (required|preferred), minLevel?, recentMonths?, also [conceptId…], note?
create function pulse.ats_requirement_save(p_job uuid, p_id uuid, p jsonb) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare j ats_job%rowtype; r ats_requirement%rowtype; v_concept uuid; v_imp text := p->>'importance'; v_min int; v_recent int; v_also uuid[]; v_note text; rid uuid;
 uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
 if not ats_reviewer() then raise exception 'HR and admins set job requirements' using errcode = '42501'; end if;
 select * into j from ats_job where org_id = current_org() and id = p_job for update;
 if not found then raise exception 'Job not found' using errcode = 'P0002'; end if;
 if j.status = 'closed' then raise exception 'The job is closed: reopen it to change its requirements' using errcode = '22023'; end if;
 if coalesce(p->>'conceptId', '') !~ uuid_re then raise exception 'Choose a skill from the list' using errcode = '22023'; end if;
 v_concept := (p->>'conceptId')::uuid;
 if v_imp is null or v_imp not in ('required', 'preferred') then raise exception 'Required or preferred?' using errcode = '22023'; end if;
 v_min := case when coalesce(p->>'minLevel', '') ~ '^[0-9]$' then (p->>'minLevel')::int when coalesce(p->>'minLevel', '') = '' then null else -1 end;
 if v_min is not null and (v_min < 1 or v_min > jsonb_array_length(skill_rubric_levels()->'levels')) then raise exception 'Choose a level from the scale' using errcode = '22023'; end if;
 v_recent := case when coalesce(p->>'recentMonths', '') ~ '^[0-9]{1,3}$' then (p->>'recentMonths')::int when coalesce(p->>'recentMonths', '') = '' then null else -1 end;
 if v_recent is not null and v_recent not between 1 and 240 then raise exception 'Used within 1 to 240 months' using errcode = '22023'; end if;
 if jsonb_typeof(coalesce(p->'also', '[]')) <> 'array' or jsonb_array_length(coalesce(p->'also', '[]')) > 10
   or exists (select 1 from jsonb_array_elements_text(coalesce(p->'also', '[]')) a where a !~ uuid_re) then
  raise exception 'Up to 10 skills the job accepts as the same' using errcode = '22023';
 end if;
 v_also := array(select distinct a::uuid from jsonb_array_elements_text(coalesce(p->'also', '[]')) a where a::uuid <> v_concept order by 1);
 if (select count(*) from skill_concept where org_id = current_org() and id = any(v_also || v_concept)) <> cardinality(v_also) + 1 then
  raise exception 'Choose skills from the list' using errcode = 'P0002';
 end if;
 v_note := nullif(left(btrim(coalesce(p->>'note', '')), 300), '');
 if p_id is null then
  if (select status from skill_concept where id = v_concept) <> 'active' then raise exception 'That skill is no longer offered: choose its replacement' using errcode = '22023'; end if;
  if exists (select 1 from ats_requirement where org_id = current_org() and job_id = p_job and concept_id = v_concept and removed_at is null) then
   raise exception 'The job already asks for this skill' using errcode = '23505';
  end if;
  insert into ats_requirement(org_id, job_id, concept_id, importance, min_level, recent_months, also, note, position, created_by)
  values (current_org(), p_job, v_concept, v_imp, v_min, v_recent, v_also, v_note,
   (select coalesce(max(position), 0) + 1 from ats_requirement where org_id = current_org() and job_id = p_job), current_viewer())
  returning id into rid;
 else
  select * into r from ats_requirement where org_id = current_org() and id = p_id and job_id = p_job and removed_at is null for update;
  if not found then raise exception 'Requirement not found' using errcode = 'P0002'; end if;
  if r.concept_id <> v_concept then raise exception 'Remove the requirement and add the other skill instead' using errcode = '22023'; end if;
  if (r.importance, r.min_level, r.recent_months, r.also, r.note) is distinct from (v_imp, v_min::smallint, v_recent::smallint, v_also, v_note) then
   update ats_requirement set importance = v_imp, min_level = v_min, recent_months = v_recent, also = v_also, note = v_note,
    version = version + 1, updated_at = now() where id = r.id;
  end if;
  rid := r.id;
 end if;
 update ats_job set updated_at = now() where id = p_job;
 return rid;
end $$;

create function pulse.ats_requirement_remove(p_id uuid) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if not ats_reviewer() then raise exception 'HR and admins set job requirements' using errcode = '42501'; end if;
 update ats_requirement set removed_at = now(), updated_at = now() where org_id = current_org() and id = p_id and removed_at is null;
 if not found then raise exception 'Requirement not found' using errcode = 'P0002'; end if;
end $$;

create function pulse.ats_jobs() returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
 if not ats_reviewer() then raise exception 'Internal jobs are for HR and admins' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', j.id, 'title', j.title, 'status', j.status, 'updatedAt', j.updated_at,
   'required', (select count(*) from ats_requirement r where r.org_id = current_org() and r.job_id = j.id and r.removed_at is null and r.importance = 'required'),
   'preferred', (select count(*) from ats_requirement r where r.org_id = current_org() and r.job_id = j.id and r.removed_at is null and r.importance = 'preferred'),
   'picked', (select count(*) from ats_pick k where k.org_id = current_org() and k.job_id = j.id and k.withdrawn_at is null),
   'openChecks', (select count(*) from ats_check c where c.org_id = current_org() and c.job_id = j.id and c.closed_at is null))
  order by j.status = 'closed', j.updated_at desc) from ats_job j where j.org_id = current_org()), '[]');
end $$;

-- The job with its requirements, the reviewers' picks and the checks they asked for.
create function pulse.ats_job_read(p_job uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare j ats_job%rowtype;
begin
 if not ats_reviewer() then raise exception 'Internal jobs are for HR and admins' using errcode = '42501'; end if;
 select * into j from ats_job where org_id = current_org() and id = p_job;
 if not found then raise exception 'Job not found' using errcode = 'P0002'; end if;
 return jsonb_build_object('id', j.id, 'title', j.title, 'purpose', j.purpose, 'status', j.status, 'createdBy', ats_person_name(j.created_by),
  'createdAt', j.created_at, 'updatedAt', j.updated_at,
  'requirements', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'conceptId', r.concept_id, 'label', k.label, 'family', k.family, 'status', k.status,
     'importance', r.importance, 'minLevel', r.min_level, 'recentMonths', r.recent_months, 'note', r.note, 'version', r.version,
     'also', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'label', a.label, 'family', a.family) order by a.label) from skill_concept a where a.id = any(r.also)), '[]'),
     'mapped', coalesce((select jsonb_agg(jsonb_build_object('label', o.label, 'family', o.family, 'relation', m.relation) order by m.relation, o.label)
       from skill_mapping m join skill_concept o on o.id = case when m.from_concept = r.concept_id then m.to_concept else m.from_concept end
       where m.org_id = current_org() and r.concept_id in (m.from_concept, m.to_concept)), '[]'))
    order by r.importance = 'preferred', r.position, r.created_at)
   from ats_requirement r join skill_concept k on k.id = r.concept_id where r.org_id = current_org() and r.job_id = j.id and r.removed_at is null), '[]'),
  'picks', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'personId', k.person_id, 'person', ats_person_name(k.person_id), 'note', k.note,
     'by', ats_person_name(k.picked_by), 'at', k.picked_at, 'weightsVersion', k.weights_version, 'points', k.match->'points', 'max', k.match->'max',
     'withdrawn', case when k.withdrawn_at is null then null else jsonb_build_object('by', ats_person_name(k.withdrawn_by), 'at', k.withdrawn_at, 'note', k.withdraw_note) end)
    order by k.withdrawn_at is not null, k.picked_at desc) from ats_pick k where k.org_id = current_org() and k.job_id = j.id), '[]'),
  'checks', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'personId', c.person_id, 'person', ats_person_name(c.person_id), 'requirementId', c.requirement_id,
     'skill', c.before->>'label', 'question', c.question, 'by', ats_person_name(c.asked_by), 'at', c.asked_at,
     'before', c.before->>'outcome', 'after', c.after->>'outcome', 'answer', c.answer, 'answeredAt', c.answered_at,
     'closed', case when c.closed_at is null then null else jsonb_build_object('by', ats_person_name(c.closed_by), 'at', c.closed_at, 'note', c.close_note) end)
    order by c.closed_at is not null, c.asked_at desc) from ats_check c where c.org_id = current_org() and c.job_id = j.id), '[]'),
  'weights', ats_weights_current());
end $$;

-- ------------------------------------------------------------------------------------------------------ candidates
-- Every active staff member of this company, ranked by points (ties share a rank; names only order the tie), with every
-- requirement's outcome and contributions. Nobody is left out; picking is a reviewer's decision.
create function pulse.ats_candidates(p_job uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare w jsonb := ats_weights_current();
begin
 if not ats_reviewer() then raise exception 'Internal job matches are for HR and admins' using errcode = '42501'; end if;
 if not exists (select 1 from ats_job where org_id = current_org() and id = p_job) then raise exception 'Job not found' using errcode = 'P0002'; end if;
 return jsonb_build_object('weights', w, 'candidates', coalesce((
  select jsonb_agg(x.m || jsonb_build_object('personId', x.id, 'name', x.display_name, 'self', x.id = current_viewer(),
    'rank', x.rk, 'picked', exists (select 1 from ats_pick k where k.org_id = current_org() and k.job_id = p_job and k.person_id = x.id and k.withdrawn_at is null),
    'openCheck', exists (select 1 from ats_check c where c.org_id = current_org() and c.job_id = p_job and c.person_id = x.id and c.closed_at is null))
   order by x.rk, x.display_name, x.id)
  from (select p.id, p.display_name, m.m, rank() over (order by (m.m->>'points')::numeric desc, (m.m->>'upTo')::numeric desc) rk
    from person p cross join lateral (select ats_match_eval(p_job, p.id, w->'weights') m) m
    where p.org_id = current_org() and p.side = 'staff' and p.status = 'active') x), '[]'));
end $$;

-- ----------------------------------------------------------------------------------------------- picks and checks
-- A reviewer picks a person for the shortlist, with a reason; the explanation as it stood is kept with the pick.
create function pulse.ats_pick_add(p_job uuid, p_person uuid, p_note text) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare j ats_job%rowtype; w jsonb := ats_weights_current(); kid uuid;
begin
 if not ats_reviewer() then raise exception 'HR and admins pick for the shortlist' using errcode = '42501'; end if;
 select * into j from ats_job where org_id = current_org() and id = p_job for update;
 if not found then raise exception 'Job not found' using errcode = 'P0002'; end if;
 if j.status <> 'open' then raise exception 'Open the job before picking anyone' using errcode = '22023'; end if;
 if w->'accepted' = 'null'::jsonb or w->'accepted' is null then
  raise exception 'HR has not accepted the matching method yet (E16): the ranking is for trying out only' using errcode = '42501';
 end if;
 if p_person = current_viewer() then raise exception 'Someone else decides about you' using errcode = '42501'; end if;
 if not exists (select 1 from person where org_id = current_org() and id = p_person and side = 'staff' and status = 'active') then
  raise exception 'Only current staff can be picked' using errcode = 'P0002';
 end if;
 if length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'Say why you pick them' using errcode = '22023'; end if;
 if exists (select 1 from ats_pick where org_id = current_org() and job_id = p_job and person_id = p_person and withdrawn_at is null) then
  raise exception 'Already on the shortlist' using errcode = '23505';
 end if;
 insert into ats_pick(org_id, job_id, person_id, note, match, weights_version, picked_by)
 values (current_org(), p_job, p_person, left(btrim(p_note), 300), ats_match_eval(p_job, p_person, w->'weights'), (w->>'version')::int, current_viewer())
 returning id into kid;
 return kid;
end $$;

create function pulse.ats_pick_withdraw(p_pick uuid, p_note text) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if not ats_reviewer() then raise exception 'HR and admins change the shortlist' using errcode = '42501'; end if;
 update ats_pick set withdrawn_at = now(), withdrawn_by = current_viewer(), withdraw_note = nullif(left(btrim(coalesce(p_note, '')), 300), '')
  where org_id = current_org() and id = p_pick and withdrawn_at is null;
 if not found then raise exception 'Not on the shortlist' using errcode = 'P0002'; end if;
end $$;

-- A reviewer asks the person to check what Pulse read for one requirement.
create function pulse.ats_check_ask(p_job uuid, p_person uuid, p_requirement uuid, p_question text) returns uuid
 language plpgsql security definer set search_path = pulse, pg_temp as $$
declare cid uuid;
begin
 if not ats_reviewer() then raise exception 'HR and admins ask people to check their record' using errcode = '42501'; end if;
 if p_person = current_viewer() then raise exception 'Check your own record on your profile' using errcode = '22023'; end if;
 if not exists (select 1 from ats_requirement where org_id = current_org() and id = p_requirement and job_id = p_job and removed_at is null) then
  raise exception 'Requirement not found' using errcode = 'P0002';
 end if;
 if not exists (select 1 from person where org_id = current_org() and id = p_person and side = 'staff' and status = 'active') then
  raise exception 'Only current staff' using errcode = 'P0002';
 end if;
 if length(btrim(coalesce(p_question, ''))) < 3 then raise exception 'Write the question for them' using errcode = '22023'; end if;
 if exists (select 1 from ats_check where org_id = current_org() and job_id = p_job and person_id = p_person and requirement_id = p_requirement and closed_at is null) then
  raise exception 'A check on this is already open' using errcode = '23505';
 end if;
 insert into ats_check(org_id, job_id, person_id, requirement_id, question, before, asked_by)
 values (current_org(), p_job, p_person, p_requirement, left(btrim(p_question), 500),
  ats_requirement_eval(p_requirement, p_person, ats_weights_current()->'weights'), current_viewer())
 returning id into cid;
 return cid;
end $$;

-- The person's checks: the question, what Pulse read then and reads now about them for that one skill. Not the job's
-- title, other requirements or anyone else.
create function pulse.ats_my_checks() returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare w jsonb := ats_weights_current()->'weights';
begin
 if current_viewer() is null then raise exception 'Sign in' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'question', c.question, 'by', ats_person_name(c.asked_by), 'at', c.asked_at,
   'skill', c.before->>'label', 'importance', c.before->>'importance', 'minLevel', c.before->'minLevel', 'recentMonths', c.before->'recentMonths',
   'before', c.before - 'requirementId' - 'conceptId',
   'now', case when c.closed_at is null then ats_requirement_eval(c.requirement_id, c.person_id, w) - 'requirementId' - 'conceptId' end,
   'answer', c.answer, 'answeredAt', c.answered_at, 'closedAt', c.closed_at, 'closeNote', c.close_note)
  order by c.closed_at is not null, c.asked_at desc)
  from ats_check c where c.org_id = current_org() and c.person_id = current_viewer()), '[]');
end $$;

create function pulse.ats_check_answer(p_check uuid, p_answer text) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c ats_check%rowtype;
begin
 select * into c from ats_check where org_id = current_org() and id = p_check for update;
 if not found or c.person_id is distinct from current_viewer() then raise exception 'Only the person answers their check' using errcode = '42501'; end if;
 if c.closed_at is not null then raise exception 'HR closed this check' using errcode = '22023'; end if;
 update ats_check set answer = nullif(left(btrim(coalesce(p_answer, '')), 500), ''), answered_at = now(),
  after = ats_requirement_eval(c.requirement_id, c.person_id, ats_weights_current()->'weights') where id = c.id;
end $$;

create function pulse.ats_check_close(p_check uuid, p_note text) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if not ats_reviewer() then raise exception 'HR and admins close checks' using errcode = '42501'; end if;
 update ats_check set closed_at = now(), closed_by = current_viewer(), close_note = nullif(left(btrim(coalesce(p_note, '')), 300), '')
  where org_id = current_org() and id = p_check and closed_at is null and person_id <> current_viewer();
 if not found then raise exception 'No open check' using errcode = 'P0002'; end if;
end $$;

revoke all on function pulse.ats_default_weights(), pulse.ats_reviewer(), pulse.ats_weights_current(), pulse.ats_person_name(uuid),
 pulse.ats_requirement_eval(uuid, uuid, jsonb), pulse.ats_match_eval(uuid, uuid, jsonb), pulse.ats_method(), pulse.ats_weights_set(jsonb, text),
 pulse.ats_accept(int, text), pulse.ats_job_save(uuid, jsonb), pulse.ats_requirement_save(uuid, uuid, jsonb), pulse.ats_requirement_remove(uuid),
 pulse.ats_jobs(), pulse.ats_job_read(uuid), pulse.ats_candidates(uuid), pulse.ats_pick_add(uuid, uuid, text), pulse.ats_pick_withdraw(uuid, text),
 pulse.ats_check_ask(uuid, uuid, uuid, text), pulse.ats_my_checks(), pulse.ats_check_answer(uuid, text), pulse.ats_check_close(uuid, text) from public;
grant execute on function pulse.ats_method(), pulse.ats_weights_set(jsonb, text), pulse.ats_accept(int, text), pulse.ats_job_save(uuid, jsonb),
 pulse.ats_requirement_save(uuid, uuid, jsonb), pulse.ats_requirement_remove(uuid), pulse.ats_jobs(), pulse.ats_job_read(uuid), pulse.ats_candidates(uuid),
 pulse.ats_pick_add(uuid, uuid, text), pulse.ats_pick_withdraw(uuid, text), pulse.ats_check_ask(uuid, uuid, uuid, text), pulse.ats_my_checks(),
 pulse.ats_check_answer(uuid, text), pulse.ats_check_close(uuid, text) to pulse_api;

-- migrate:down
-- Forward-only: jobs, requirements, weights versions, acceptances, picks and checks are retained.
