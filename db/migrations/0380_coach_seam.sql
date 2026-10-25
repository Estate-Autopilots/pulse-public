-- migrate:up
-- R50 (12 Oct 2026): a disabled, versioned seam for a later HR coach (PLAN P23; owner voice 8 Oct §5 "later an AI
-- coach-level HR intelligence engine plugs in via API"). Nothing here buys, calls or sends anything.
--  * Contract coach.v1: Pulse hands a coach one narrow evidence packet built from R49's explanation of one current staff
--    member against one internal job: per requirement the skill from the company's list, required or preferred, the
--    level and recency asked, the outcome (matched / unknown / missing), points, and the one skill on record that
--    counted (or came closest): its level, how it is known and when it was last used. No name, no person or job id
--    (the subject is "subject"), no job title or notes, no verifier, no attendance, leave, pay, chats, app activity,
--    contact or private profile fields; coach_evidence_ok() refuses any other key, an id or an e-mail address.
--  * The coach answers with suggestions, each citing evidence items (e1, e2 …) of that packet; a suggestion is only ever
--    a next step for a person to take (ask them to check, ask for a verification, record work, a learning step), never
--    a decision. A reviewer accepts or rejects each one with a reason; accepting changes nothing else in Pulse.
--  * Per company (coach_config, versioned): disabled until an admin turns it on, and the only provider is Pulse's
--    deterministic stub; a real provider needs a later migration, ADR and owner errands E08/E16. The API also needs
--    PULSE_COACH=1 on the server. Every request is kept (coach_request): who asked about whom, the exact packet and its
--    hash, the provider, the timeout and how it ended (answered, timed out, failed: the reviewer then gets R49's
--    explanation without suggestions).
-- HR and admins (ats_reviewer) only; nothing crosses a company (forced RLS on current_org()); nothing is deleted.

create table pulse.coach_config (
 org_id uuid not null references pulse.org(id),
 version int not null check (version >= 1),
 state text not null check (state in ('disabled', 'enabled')),
 provider text not null check (provider in ('stub')),          -- a real provider needs a later migration (docs/ops/COACH.md)
 timeout_ms int not null check (timeout_ms between 100 and 20000),
 max_suggestions int not null check (max_suggestions between 1 and 10),
 reason text not null check (length(btrim(reason)) between 10 and 300),
 set_by uuid not null references pulse.person(id), set_at timestamptz not null default now(),
 primary key (org_id, version)
);

-- The packet a coach may receive, and nothing else: these keys only, no identifiers, no e-mail addresses.
create function pulse.coach_evidence_ok(p jsonb) returns boolean language plpgsql immutable set search_path = pulse, pg_temp as $$
declare e jsonb; t text;
begin
 if jsonb_typeof(p) is distinct from 'object' then return false; end if;
 if exists (select 1 from jsonb_object_keys(p) k where k not in ('contract', 'purpose', 'subject', 'method', 'scale', 'evidence'))
   or not p ?& array['contract', 'purpose', 'subject', 'method', 'scale', 'evidence'] then return false; end if;
 if p->>'contract' is distinct from 'coach.v1' or p->>'purpose' is distinct from 'internal_job_fit' or p->>'subject' is distinct from 'subject' then return false; end if;
 if jsonb_typeof(p->'method') <> 'object' or exists (select 1 from jsonb_object_keys(p->'method') k where k not in ('weightsVersion', 'accepted'))
   or jsonb_typeof(p->'method'->'weightsVersion') is distinct from 'number' or jsonb_typeof(p->'method'->'accepted') is distinct from 'boolean' then return false; end if;
 if jsonb_typeof(p->'scale') <> 'array' or jsonb_array_length(p->'scale') > 10
   or exists (select 1 from jsonb_array_elements(p->'scale') s where jsonb_typeof(s) <> 'string' or length(s#>>'{}') > 60) then return false; end if;
 if jsonb_typeof(p->'evidence') <> 'array' or jsonb_array_length(p->'evidence') > 50 then return false; end if;
 for e in select x from jsonb_array_elements(p->'evidence') x loop
  if jsonb_typeof(e) <> 'object' or exists (select 1 from jsonb_object_keys(e) k where k not in ('id', 'requirement', 'outcome', 'points', 'weight', 'record'))
    or coalesce(e->>'id', '') !~ '^e[0-9]{1,2}$' or coalesce(e->>'outcome', '') not in ('matched', 'unknown', 'missing')
    or jsonb_typeof(e->'points') is distinct from 'number' or jsonb_typeof(e->'weight') is distinct from 'number' then return false; end if;
  if jsonb_typeof(e->'requirement') is distinct from 'object'
    or exists (select 1 from jsonb_object_keys(e->'requirement') k where k not in ('skill', 'importance', 'minLevel', 'recentMonths'))
    or jsonb_typeof(e->'requirement'->'skill') is distinct from 'string' or length(e->'requirement'->>'skill') > 200
    or coalesce(e->'requirement'->>'importance', '') not in ('required', 'preferred') then return false; end if;
  t := jsonb_typeof(e->'record');
  if t is null or (t <> 'null' and (t <> 'object'
    or exists (select 1 from jsonb_object_keys(e->'record') k where k not in ('skill', 'via', 'level', 'basis', 'recent', 'lastUsed'))
    or jsonb_typeof(e->'record'->'skill') is distinct from 'string' or length(e->'record'->>'skill') > 200
    or coalesce(e->'record'->>'basis', '') not in ('verified', 'approvedWork', 'self'))) then return false; end if;
 end loop;
 return p::text !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' and p::text !~* '[^\s@"]+@[^\s@"]+\.[a-z]{2,}';
end $$;

create table pulse.coach_request (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 contract text not null default 'coach.v1' check (contract = 'coach.v1'),
 purpose text not null default 'internal_job_fit' check (purpose = 'internal_job_fit'),
 job_id uuid not null references pulse.ats_job(id), subject_id uuid not null references pulse.person(id),
 evidence jsonb not null check (pulse.coach_evidence_ok(evidence)),
 evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
 provider text not null check (provider in ('stub')), provider_version text check (length(provider_version) <= 40),
 config_version int not null check (config_version >= 1),
 timeout_ms int not null check (timeout_ms between 100 and 20000),
 status text not null default 'pending' check (status in ('pending', 'answered', 'timed_out', 'failed')),
 failure text check (failure in ('schema', 'citation', 'too_many', 'identifier', 'error', 'refused')),
 latency_ms int check (latency_ms >= 0),
 requested_by uuid not null references pulse.person(id), requested_at timestamptz not null default now(), finished_at timestamptz,
 check (requested_by <> subject_id), check ((status = 'pending') = (finished_at is null)), check ((status = 'failed') = (failure is not null))
);
create index coach_request_job on pulse.coach_request(org_id, job_id, requested_at desc);

create table pulse.coach_suggestion (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 request_id uuid not null references pulse.coach_request(id),
 position smallint not null check (position between 1 and 10),
 kind text not null check (kind in ('ask_check', 'verify', 'record_work', 'learn')),
 text text not null check (length(btrim(text)) between 3 and 300),
 cites text[] not null check (cardinality(cites) between 1 and 10),
 decision text check (decision in ('accepted', 'rejected')),
 decided_by uuid references pulse.person(id), decided_at timestamptz, decision_note text check (length(decision_note) <= 300),
 check ((decision is null) = (decided_at is null) and (decision is null) = (decided_by is null)),
 unique (request_id, position)
);

do $$ declare t text; begin
 foreach t in array array['pulse.coach_config', 'pulse.coach_request', 'pulse.coach_suggestion'] loop
  execute format('alter table %s enable row level security', t);
  execute format('alter table %s force row level security', t);
  execute format('create policy tenant on %s using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  execute format('revoke all on %s from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy', t);
  execute format('create trigger audit_mutation after insert or update on %s for each row execute function pulse.audit_mutation()', t);
 end loop;
end $$;

-- ------------------------------------------------------------------------------------------------- configuration
-- The company's configuration in force: version 0 (disabled, stub, 3 s, 5 suggestions) until an admin sets one.
create function pulse.coach_config_current() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce((select jsonb_build_object('version', c.version, 'state', c.state, 'provider', c.provider, 'timeoutMs', c.timeout_ms,
   'maxSuggestions', c.max_suggestions, 'reason', c.reason, 'setBy', ats_person_name(c.set_by), 'setAt', c.set_at)
   from coach_config c where c.org_id = current_org() order by c.version desc limit 1),
  jsonb_build_object('version', 0, 'state', 'disabled', 'provider', 'stub', 'timeoutMs', 3000, 'maxSuggestions', 5,
   'reason', 'Off until the owner approves a coach (E08, E16)', 'setBy', null, 'setAt', null))
$$;

-- Published to everyone signed in: whether this company's coach is on, its versions, and who may do what.
create function pulse.coach_status() returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
 if current_viewer() is null then raise exception 'Sign in' using errcode = '42501'; end if;
 return jsonb_build_object('contract', 'coach.v1', 'tenant', coach_config_current(),
  'versions', coalesce((select jsonb_agg(jsonb_build_object('version', c.version, 'state', c.state, 'provider', c.provider, 'timeoutMs', c.timeout_ms,
    'maxSuggestions', c.max_suggestions, 'reason', c.reason, 'setBy', ats_person_name(c.set_by), 'setAt', c.set_at) order by c.version desc)
    from coach_config c where c.org_id = current_org()), '[]'),
  'can', jsonb_build_object('configure', viewer_is('admin'), 'request', ats_reviewer()));
end $$;

-- Admins set the company's configuration as a new version with a reason. The only provider is the stub.
create function pulse.coach_configure(p jsonb, p_reason text) returns int language plpgsql security definer set search_path = pulse, pg_temp as $$
declare ver int; v_state text := p->>'state'; v_provider text := coalesce(p->>'provider', 'stub'); v_timeout int; v_max int;
begin
 if current_viewer() is null or not viewer_is('admin') then raise exception 'Admins configure the coach' using errcode = '42501'; end if;
 if v_state is null or v_state not in ('disabled', 'enabled') then raise exception 'Disabled or enabled?' using errcode = '22023'; end if;
 if v_provider <> 'stub' then raise exception 'Only Pulse''s deterministic stub exists: a real provider waits for the owner''s approval (E08, E16)' using errcode = '22023'; end if;
 if jsonb_typeof(p->'timeoutMs') is distinct from 'number' or (p->>'timeoutMs')::numeric not between 100 and 20000 then
  raise exception 'Wait 100 to 20000 ms for an answer' using errcode = '22023';
 end if;
 if jsonb_typeof(p->'maxSuggestions') is distinct from 'number' or (p->>'maxSuggestions')::numeric not between 1 and 10 then
  raise exception 'Keep 1 to 10 suggestions' using errcode = '22023';
 end if;
 v_timeout := round((p->>'timeoutMs')::numeric); v_max := round((p->>'maxSuggestions')::numeric);
 if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'Say why the coach changes' using errcode = '22023'; end if;
 select coalesce(max(version), 0) + 1 into ver from coach_config where org_id = current_org();
 insert into coach_config(org_id, version, state, provider, timeout_ms, max_suggestions, reason, set_by)
 values (current_org(), ver, v_state, v_provider, v_timeout, v_max, left(btrim(p_reason), 300), current_viewer());
 return ver;
end $$;

-- --------------------------------------------------------------------------------------------------- the packet
-- coach.v1 evidence for one current staff member against one internal job, from R49's explanation only. Reviewers can
-- preview it (also while the coach is off) to see exactly what a coach would receive.
create function pulse.coach_evidence(p_job uuid, p_subject uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare w jsonb := ats_weights_current(); m jsonb; r jsonb; rec jsonb; ev jsonb := '[]'; i int := 0;
begin
 if not ats_reviewer() then raise exception 'The coach is for HR and admins' using errcode = '42501'; end if;
 if not exists (select 1 from ats_job where org_id = current_org() and id = p_job) then raise exception 'Job not found' using errcode = 'P0002'; end if;
 if not exists (select 1 from person where org_id = current_org() and id = p_subject and side = 'staff' and status = 'active') then
  raise exception 'Only current staff' using errcode = 'P0002';
 end if;
 m := ats_match_eval(p_job, p_subject, w->'weights');
 for r in select x from jsonb_array_elements(m->'requirements') x loop
  i := i + 1;
  -- The skill that counted; for a missing requirement the closest one on record; none when unknown.
  select c into rec from jsonb_array_elements(r->'considered') c order by (c->>'counted')::boolean desc, (c->>'level')::int desc, c->>'label' limit 1;
  ev := ev || jsonb_build_array(jsonb_build_object('id', 'e' || i,
   'requirement', jsonb_build_object('skill', r->>'label', 'importance', r->>'importance', 'minLevel', r->'minLevel', 'recentMonths', r->'recentMonths'),
   'outcome', r->>'outcome', 'points', r->'points', 'weight', r->'weight',
   'record', case when rec is null then null else jsonb_build_object('skill', rec->>'label', 'via', rec->>'via', 'level', rec->'level',
     'basis', rec->>'basis', 'recent', rec->'recent', 'lastUsed', rec->'lastUsed') end));
 end loop;
 return jsonb_build_object('contract', 'coach.v1', 'purpose', 'internal_job_fit', 'subject', 'subject',
  'method', jsonb_build_object('weightsVersion', (w->>'version')::int, 'accepted', jsonb_typeof(w->'accepted') = 'object'),
  'scale', coalesce((select jsonb_agg(l->>'label' order by (l->>'level')::int) from jsonb_array_elements(skill_rubric_levels()->'levels') l), '[]'),
  'evidence', ev);
end $$;

-- ---------------------------------------------------------------------------------------------------- requests
-- A reviewer asks the company's coach about one current staff member (not themself) for one internal job. The packet is
-- kept with its hash before anything is asked; the API then asks the provider and finishes the request.
create function pulse.coach_request_open(p_job uuid, p_subject uuid) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare cfg jsonb := coach_config_current(); ev jsonb; rid uuid;
begin
 if not ats_reviewer() then raise exception 'The coach is for HR and admins' using errcode = '42501'; end if;
 if cfg->>'state' <> 'enabled' then raise exception 'The coach is off for this company' using errcode = '55000'; end if;
 if p_subject = current_viewer() then raise exception 'Someone else reviews you' using errcode = '42501'; end if;
 ev := coach_evidence(p_job, p_subject);
 if not coach_evidence_ok(ev) then raise exception 'The evidence is outside the coach contract' using errcode = '22023'; end if;
 insert into coach_request(org_id, job_id, subject_id, evidence, evidence_hash, provider, config_version, timeout_ms, requested_by)
 values (current_org(), p_job, p_subject, ev, encode(sha256(convert_to(ev::text, 'UTF8')), 'hex'), cfg->>'provider', (cfg->>'version')::int,
  (cfg->>'timeoutMs')::int, current_viewer())
 returning id into rid;
 return jsonb_build_object('id', rid, 'evidence', ev, 'provider', cfg->>'provider', 'timeoutMs', (cfg->>'timeoutMs')::int, 'maxSuggestions', (cfg->>'maxSuggestions')::int);
end $$;

-- The requester records how the provider answered. Suggestions are checked again here: these keys, the four kinds, at
-- most the configured number, and every citation an evidence item of this request's packet.
create function pulse.coach_request_finish(p_id uuid, p_status text, p_version text, p_latency int, p_failure text, p_suggestions jsonb)
 returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare q coach_request%rowtype; s jsonb; n int := 0; ids text[]; v_cites text[];
begin
 if not ats_reviewer() then raise exception 'The coach is for HR and admins' using errcode = '42501'; end if;
 select * into q from coach_request where org_id = current_org() and id = p_id for update;
 if not found then raise exception 'Request not found' using errcode = 'P0002'; end if;
 if q.requested_by <> current_viewer() then raise exception 'Only who asked records the answer' using errcode = '42501'; end if;
 if q.status <> 'pending' then raise exception 'Already finished' using errcode = '23505'; end if;
 if p_status not in ('answered', 'timed_out', 'failed') then raise exception 'Answered, timed out or failed' using errcode = '22023'; end if;
 if p_status <> 'answered' and p_suggestions is not null and p_suggestions <> '[]' then raise exception 'Only an answer has suggestions' using errcode = '22023'; end if;
 if p_status = 'answered' then
  if jsonb_typeof(p_suggestions) is distinct from 'array' or jsonb_array_length(p_suggestions) > (select max_suggestions from coach_config where org_id = current_org() and version = q.config_version) then
   raise exception 'Too many suggestions' using errcode = '22023';
  end if;
  ids := array(select e->>'id' from jsonb_array_elements(q.evidence->'evidence') e);
  for s in select x from jsonb_array_elements(p_suggestions) x loop
   n := n + 1;
   if jsonb_typeof(s) <> 'object' or exists (select 1 from jsonb_object_keys(s) k where k not in ('kind', 'text', 'cites'))
     or coalesce(s->>'kind', '') not in ('ask_check', 'verify', 'record_work', 'learn') or jsonb_typeof(s->'text') is distinct from 'string'
     or jsonb_typeof(s->'cites') is distinct from 'array' then
    raise exception 'A suggestion is a kind, a text and its citations' using errcode = '22023';
   end if;
   v_cites := array(select jsonb_array_elements_text(s->'cites'));
   if cardinality(v_cites) = 0 or not v_cites <@ ids then raise exception 'Every suggestion cites evidence of this request' using errcode = '22023'; end if;
   insert into coach_suggestion(org_id, request_id, position, kind, text, cites) values (current_org(), q.id, n, s->>'kind', btrim(s->>'text'), v_cites);
  end loop;
 end if;
 update coach_request set status = p_status, provider_version = left(p_version, 40), latency_ms = greatest(p_latency, 0),
  failure = case when p_status = 'failed' then coalesce(p_failure, 'error') end, finished_at = now() where id = q.id;
end $$;

-- Requests are read as they ended; one still pending after its timeout (and a minute's grace) reads as timed out.
create function pulse.coach_effective_status(q pulse.coach_request) returns text language sql stable set search_path = pulse, pg_temp as $$
 select case when q.status = 'pending' and q.requested_at + make_interval(secs => q.timeout_ms / 1000.0 + 60) < now() then 'timed_out' else q.status end
$$;

create function pulse.coach_requests(p_job uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
 if not ats_reviewer() then raise exception 'The coach is for HR and admins' using errcode = '42501'; end if;
 if p_job is not null and not exists (select 1 from ats_job where org_id = current_org() and id = p_job) then raise exception 'Job not found' using errcode = 'P0002'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'jobId', q.job_id, 'subjectId', q.subject_id, 'subject', ats_person_name(q.subject_id),
   'by', ats_person_name(q.requested_by), 'at', q.requested_at, 'status', coach_effective_status(q), 'provider', q.provider,
   'suggestions', (select count(*) from coach_suggestion s where s.org_id = current_org() and s.request_id = q.id),
   'accepted', (select count(*) from coach_suggestion s where s.org_id = current_org() and s.request_id = q.id and s.decision = 'accepted'),
   'rejected', (select count(*) from coach_suggestion s where s.org_id = current_org() and s.request_id = q.id and s.decision = 'rejected'))
  order by q.requested_at desc) from coach_request q where q.org_id = current_org() and (p_job is null or q.job_id = p_job)), '[]');
end $$;

-- One request: the packet as sent, how it ended, the suggestions with the evidence each cites and the decisions. When
-- the coach did not answer, the reviewer reads R49's explanation (the packet's evidence) without suggestions.
create function pulse.coach_request_read(p_id uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare q coach_request%rowtype; v_status text;
begin
 if not ats_reviewer() then raise exception 'The coach is for HR and admins' using errcode = '42501'; end if;
 select * into q from coach_request where org_id = current_org() and id = p_id;
 if not found then raise exception 'Request not found' using errcode = 'P0002'; end if;
 v_status := coach_effective_status(q);
 return jsonb_build_object('id', q.id, 'contract', q.contract, 'purpose', q.purpose, 'jobId', q.job_id,
  'job', (select title from ats_job where org_id = current_org() and id = q.job_id), 'subjectId', q.subject_id, 'subject', ats_person_name(q.subject_id),
  'by', ats_person_name(q.requested_by), 'at', q.requested_at, 'finishedAt', q.finished_at, 'status', v_status, 'failure', q.failure,
  'provider', q.provider, 'providerVersion', q.provider_version, 'configVersion', q.config_version, 'timeoutMs', q.timeout_ms, 'latencyMs', q.latency_ms,
  'automated', true, 'fallback', case when v_status = 'answered' then null else 'explanation' end,
  'evidence', q.evidence, 'evidenceHash', q.evidence_hash,
  'suggestions', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'position', s.position, 'kind', s.kind, 'text', s.text, 'cites', to_jsonb(s.cites),
     'cited', (select coalesce(jsonb_agg(e order by e->>'id'), '[]') from jsonb_array_elements(q.evidence->'evidence') e where e->>'id' = any(s.cites)),
     'decision', case when s.decision is null then null else jsonb_build_object('decision', s.decision, 'by', ats_person_name(s.decided_by), 'at', s.decided_at, 'note', s.decision_note) end)
    order by s.position) from coach_suggestion s where s.org_id = current_org() and s.request_id = q.id), '[]'));
end $$;

-- A reviewer (not the person it is about) accepts or rejects one suggestion with a reason. Nothing else happens:
-- the reviewer then acts, or not, through Pulse's ordinary screens.
create function pulse.coach_decide(p_suggestion uuid, p_decision text, p_note text) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s coach_suggestion%rowtype; v_subject uuid;
begin
 if not ats_reviewer() then raise exception 'HR and admins decide about suggestions' using errcode = '42501'; end if;
 select * into s from coach_suggestion where org_id = current_org() and id = p_suggestion for update;
 if not found then raise exception 'Suggestion not found' using errcode = 'P0002'; end if;
 select subject_id into v_subject from coach_request where org_id = current_org() and id = s.request_id;
 if v_subject = current_viewer() then raise exception 'Someone else decides about you' using errcode = '42501'; end if;
 if p_decision is null or p_decision not in ('accepted', 'rejected') then raise exception 'Accept or reject' using errcode = '22023'; end if;
 if length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'Say why' using errcode = '22023'; end if;
 if s.decision is not null then raise exception 'Already decided' using errcode = '23505'; end if;
 update coach_suggestion set decision = p_decision, decided_by = current_viewer(), decided_at = now(), decision_note = left(btrim(p_note), 300) where id = s.id;
end $$;

revoke all on function pulse.coach_evidence_ok(jsonb), pulse.coach_config_current(), pulse.coach_status(), pulse.coach_configure(jsonb, text),
 pulse.coach_evidence(uuid, uuid), pulse.coach_request_open(uuid, uuid), pulse.coach_request_finish(uuid, text, text, int, text, jsonb),
 pulse.coach_effective_status(pulse.coach_request), pulse.coach_requests(uuid), pulse.coach_request_read(uuid), pulse.coach_decide(uuid, text, text) from public;
grant execute on function pulse.coach_status(), pulse.coach_configure(jsonb, text), pulse.coach_evidence(uuid, uuid), pulse.coach_request_open(uuid, uuid),
 pulse.coach_request_finish(uuid, text, text, int, text, jsonb), pulse.coach_requests(uuid), pulse.coach_request_read(uuid),
 pulse.coach_decide(uuid, text, text) to pulse_api;

-- migrate:down
-- Forward-only: configuration versions, requests, packets, suggestions and decisions are retained.
