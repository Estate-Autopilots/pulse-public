-- migrate:up
-- OFFICE-PRINT (owner at the Willow Lane office, 21 Nov 2026 ~14:20 IST: "this needs to be directly inside Vitals OS … the
-- server is always available, you just need to trigger it, and the Wi-Fi can use the printer"). Spec: the Mac's
-- ~/orch/office-setup/print-agent/QUEUE-API.md. A company's print queue: a person (or bhrātā, only when a person asks
-- in chat, as that person) queues a numbered billing document's filed PDF; the office print agent on the office Wi-Fi
-- calls out (never in) with its own per-company token, claims the oldest job, fetches the PDF, prints it over IPP and
-- says how it went; every 15 minutes it reports the printer (state, ink, pages) and low toner or no paper becomes a task
-- for the admin who connected the agent. Limits: 1–20 copies a job, 200 pages a day a company (the API asks a second
-- confirm above 20 pages). Every job is in the document's log. Nothing is ever deleted: a token is revoked, a job ends
-- done, failed or cancelled.

create table pulse.office_print_agent(
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org(id),
 name text not null check (length(btrim(name)) between 1 and 60),
 token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
 created_by uuid references pulse.person(id), created_at timestamptz not null default now(),
 revoked_at timestamptz, revoked_by uuid references pulse.person(id),
 last_seen_at timestamptz, last_host text check (length(last_host) <= 120));
comment on table pulse.office_print_agent is 'OFFICE-PRINT (2503): an office print agent''s token (only its sha-256), per company; revoked, never deleted';

create table pulse.office_print_job(
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org(id),
 document_id uuid not null references pulse.erp_document(id),
 title text not null check (length(title) between 1 and 200),
 copies int not null check (copies between 1 and 20),
 sides text not null default 'one-sided' check (sides in ('one-sided', 'two-sided-long-edge')),
 pages int not null check (pages between 1 and 500),
 requested_by uuid not null references pulse.person(id), via_ai uuid references pulse.person(id),
 status text not null default 'queued' check (status in ('queued', 'claimed', 'printing', 'done', 'failed', 'cancelled')),
 detail text check (length(detail) <= 300), printer_job text check (length(printer_job) <= 60),
 agent_id uuid references pulse.office_print_agent(id), agent_host text check (length(agent_host) <= 120), printer text check (length(printer) <= 300),
 created_at timestamptz not null default now(), claimed_at timestamptz, finished_at timestamptz, updated_at timestamptz not null default now(),
 check ((status in ('done', 'failed', 'cancelled')) = (finished_at is not null)),
 check (status = 'queued' or status = 'cancelled' or agent_id is not null));
create index office_print_job_next on pulse.office_print_job(org_id, created_at) where status = 'queued';
create index office_print_job_day on pulse.office_print_job(org_id, created_at);
comment on table pulse.office_print_job is 'OFFICE-PRINT (2503): one print of a numbered billing document: queued → claimed → printing → done | failed';

create table pulse.office_printer(
 org_id uuid not null references pulse.org(id), printer text not null check (length(printer) between 1 and 300),
 agent_id uuid references pulse.office_print_agent(id), agent_host text check (length(agent_host) <= 120),
 model text check (length(model) <= 200), state text check (length(state) <= 40),
 warnings jsonb not null default '[]', ink jsonb not null default '[]', pages bigint, accepts_pdf boolean,
 last_seen timestamptz not null default now(), alerted_at timestamptz, alert_task uuid references pulse.task(id) on delete set null,
 primary key (org_id, printer));
comment on table pulse.office_printer is 'OFFICE-PRINT (2503): what the office print agent last said about a printer (state, warnings, ink, pages)';

alter table pulse.office_print_agent enable row level security; alter table pulse.office_print_agent force row level security;
alter table pulse.office_print_job enable row level security; alter table pulse.office_print_job force row level security;
alter table pulse.office_printer enable row level security; alter table pulse.office_printer force row level security;
create policy tenant on pulse.office_print_agent using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy tenant on pulse.office_print_job using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy tenant on pulse.office_printer using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- Read and written only through the functions below.
revoke all on pulse.office_print_agent, pulse.office_print_job, pulse.office_printer from public, pulse_api, pulse_worker;

-- ---------------------------------------------------------------- people in Vitals
-- Queue a print of a numbered document (the API counted its pages and checked the person sees it and asked twice above
-- 20 pages). p_for: the person who asked bhrātā in chat (the job is theirs; p_via is the AI member that queued it).
create function pulse.office_print_queue(p_doc uuid, p_copies int, p_sides text, p_pages int, p_for uuid default null) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); who uuid; via uuid; d erp_document; used int; t text; jid uuid; day0 timestamptz;
begin
 if me is null or current_org() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
 if not erp_can(false) then raise exception 'Printing is for people who use Billing' using errcode = '42501'; end if;
 if p_for is not null then
  if (select side from person where id = me) <> 'agent' then raise exception 'Only an AI employee prints for someone else' using errcode = '42501'; end if;
  if not exists (select 1 from person where id = p_for and org_id = current_org() and side = 'staff' and status = 'active') then
   raise exception 'Print only for a person of this company who asked' using errcode = '22023'; end if;
  who := p_for; via := me;
 else who := me; end if;
 select * into d from erp_document where id = p_doc and org_id = current_org();
 if d.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
 if d.status in ('draft', 'cancelled') then raise exception 'Only a numbered document is printed; a draft or a cancelled one is not' using errcode = '22023'; end if;
 if not exists (select 1 from erp_document_file where document_id = d.id and kind = 'pdf') then raise exception 'This document has no filed copy to print yet' using errcode = '22023'; end if;
 if not exists (select 1 from office_print_agent where org_id = current_org() and revoked_at is null) then
  raise exception 'No office printer is connected to Vitals yet: an admin connects the print agent in Billing → Office printer' using errcode = '22023'; end if;
 if p_copies is null or p_copies not between 1 and 20 then raise exception 'Print 1 to 20 copies' using errcode = '22023'; end if;
 if p_pages is null or p_pages not between 1 and 500 then raise exception 'The document''s pages could not be counted' using errcode = '22023'; end if;
 if coalesce(p_sides, 'one-sided') not in ('one-sided', 'two-sided-long-edge') then raise exception 'One-sided or two-sided' using errcode = '22023'; end if;
 day0 := ((now() at time zone org_time_zone())::date)::timestamp at time zone org_time_zone();
 select coalesce(sum(pages * copies), 0)::int into used from office_print_job
  where org_id = current_org() and created_at >= day0 and status not in ('failed', 'cancelled');
 if used + p_pages * p_copies > 200 then
  raise exception 'Today''s print limit is 200 pages for the company: % used, this needs % more', used, p_pages * p_copies using errcode = '22023'; end if;
 t := left(case d.doc_type when 'quotation' then 'Quotation' when 'proforma' then 'Proforma' when 'invoice' then 'Tax invoice' when 'credit_note' then 'Credit note' else 'Document' end
  || ' ' || coalesce(d.number, '') || coalesce(' · ' || nullif(btrim(d.buyer->>'name'), ''), ''), 200);
 insert into office_print_job(org_id, document_id, title, copies, sides, pages, requested_by, via_ai)
  values (current_org(), d.id, t, p_copies, coalesce(p_sides, 'one-sided'), p_pages, who, via) returning id into jid;
 perform erp_log('document', d.id, 'print_queued', jsonb_build_object('job', jid, 'copies', p_copies, 'pages', p_pages, 'for', who, 'ai', via));
 return jsonb_build_object('id', jid, 'title', t, 'copies', p_copies, 'pages', p_pages, 'sides', coalesce(p_sides, 'one-sided'), 'usedToday', used + p_pages * p_copies, 'limit', 200);
end $$;

-- The queue and history (an admin, leadership or Finance sees the company's; anyone else their own), the printers, and
-- for admins and leadership the connected agents (never a token).
create function pulse.office_print_overview() returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); boss boolean; all_jobs boolean;
begin
 if me is null or current_org() is null or not erp_can(false) then return null; end if;
 boss := viewer_is('admin', 'leadership');
 all_jobs := boss or viewer_is('finance');
 return jsonb_build_object(
  'canManage', boss,
  'jobs', coalesce((select jsonb_agg(jsonb_build_object('id', j.id, 'documentId', j.document_id, 'title', j.title, 'copies', j.copies, 'sides', j.sides, 'pages', j.pages,
     'status', j.status, 'detail', j.detail, 'by', p.display_name, 'viaAi', a.display_name, 'agentHost', j.agent_host, 'createdAt', j.created_at, 'finishedAt', j.finished_at) order by j.created_at desc)
    from (select * from office_print_job x where x.org_id = current_org() and (all_jobs or x.requested_by = me) order by x.created_at desc limit 50) j
    left join person p on p.id = j.requested_by left join person a on a.id = j.via_ai), '[]'::jsonb),
  'printers', coalesce((select jsonb_agg(jsonb_build_object('printer', r.printer, 'model', r.model, 'state', r.state, 'warnings', r.warnings, 'ink', r.ink, 'pages', r.pages,
     'acceptsPdf', r.accepts_pdf, 'agentHost', r.agent_host, 'lastSeen', r.last_seen) order by r.last_seen desc) from office_printer r where r.org_id = current_org()), '[]'::jsonb),
  'agents', case when boss then coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'createdAt', g.created_at, 'by', p.display_name,
     'lastSeenAt', g.last_seen_at, 'lastHost', g.last_host, 'revokedAt', g.revoked_at) order by g.created_at desc)
    from office_print_agent g left join person p on p.id = g.created_by where g.org_id = current_org()), '[]'::jsonb) else '[]'::jsonb end,
  'today', (select coalesce(sum(pages * copies), 0)::int from office_print_job where org_id = current_org() and status not in ('failed', 'cancelled')
    and created_at >= ((now() at time zone org_time_zone())::date)::timestamp at time zone org_time_zone()), 'limit', 200);
end $$;

-- An admin or leadership connects an agent: the API makes the token, shows it once and keeps only its hash here.
create function pulse.office_print_agent_create(p_name text, p_hash text) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare id uuid;
begin
 if current_viewer() is null or current_org() is null or not viewer_is('admin', 'leadership') then raise exception 'Company admins connect the office printer' using errcode = '42501'; end if;
 insert into office_print_agent(org_id, name, token_hash, created_by) values (current_org(), left(btrim(p_name), 60), p_hash, current_viewer()) returning office_print_agent.id into id;
 return id;
end $$;
create function pulse.office_print_agent_revoke(p_id uuid) returns boolean language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if current_viewer() is null or current_org() is null or not viewer_is('admin', 'leadership') then raise exception 'Company admins disconnect the office printer' using errcode = '42501'; end if;
 update office_print_agent set revoked_at = now(), revoked_by = current_viewer() where id = p_id and org_id = current_org() and revoked_at is null;
 return found;
end $$;

-- ---------------------------------------------------------------- the office print agent (its token, no person)
create function pulse.office_print_agent_by(p_hash text) returns pulse.office_print_agent language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a office_print_agent;
begin
 select * into a from office_print_agent where token_hash = p_hash and revoked_at is null;
 if a.id is not null then perform set_config('pulse.org_id', a.org_id::text, true); end if;
 return a;
end $$;

-- Whether a token is a live agent's (the API answers 401 otherwise).
create function pulse.office_print_known(p_hash text) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
 select exists (select 1 from office_print_agent where token_hash = p_hash and revoked_at is null)
$$;

-- Claims the oldest queued job of the token's company (null: none, or not a live token: see `known`).
create function pulse.office_print_next(p_hash text, p_host text, p_printer text) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a office_print_agent := office_print_agent_by(p_hash); j office_print_job;
begin
 if a.id is null then return jsonb_build_object('known', false); end if;
 update office_print_agent set last_seen_at = now(), last_host = left(p_host, 120) where id = a.id;
 select * into j from office_print_job where org_id = a.org_id and status = 'queued' order by created_at for update skip locked limit 1;
 if j.id is null then return jsonb_build_object('known', true, 'job', null); end if;
 update office_print_job set status = 'claimed', agent_id = a.id, agent_host = left(p_host, 120), printer = left(p_printer, 300), claimed_at = now(), updated_at = now() where id = j.id;
 return jsonb_build_object('known', true, 'job', jsonb_build_object('id', j.id, 'title', j.title, 'copies', j.copies, 'sides', j.sides, 'pages', j.pages,
  'requested_by', left(coalesce((select display_name from person where id = j.requested_by), 'Vitals OS')
   || case when j.via_ai is not null then ' (via ' || coalesce((select display_name from person where id = j.via_ai), 'AI') || ')' else '' end, 100)));
end $$;

-- The PDF of a job this agent claimed (null: not its job, or not claimed or printing).
create function pulse.office_print_file(p_hash text, p_job uuid) returns bytea language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a office_print_agent := office_print_agent_by(p_hash);
begin
 if a.id is null then return null; end if;
 return (select f.bytes from office_print_job j join erp_document_file f on f.document_id = j.document_id and f.kind = 'pdf'
  where j.id = p_job and j.org_id = a.org_id and j.agent_id = a.id and j.status in ('claimed', 'printing'));
end $$;

-- How the job went: claimed → printing → done | failed (failed straight from claimed too). The document's log says it.
create function pulse.office_print_update(p_hash text, p_job uuid, p_status text, p_detail text, p_printer_job text) returns text
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a office_print_agent := office_print_agent_by(p_hash); j office_print_job;
begin
 if a.id is null then return null; end if;
 select * into j from office_print_job where id = p_job and org_id = a.org_id and agent_id = a.id for update;
 if j.id is null then raise exception 'Not a job this agent claimed' using errcode = 'P0002'; end if;
 if not ((j.status = 'claimed' and p_status in ('printing', 'done', 'failed')) or (j.status = 'printing' and p_status in ('done', 'failed'))) then
  raise exception 'A % job does not become %', j.status, p_status using errcode = '22023'; end if;
 update office_print_job set status = p_status, detail = left(nullif(btrim(coalesce(p_detail, '')), ''), 300), printer_job = left(nullif(btrim(coalesce(p_printer_job, '')), ''), 60),
  finished_at = case when p_status in ('done', 'failed') then now() end, updated_at = now() where id = j.id;
 if p_status in ('done', 'failed') then
  perform erp_log('document', j.document_id, case when p_status = 'done' then 'printed' else 'print_failed' end,
   jsonb_build_object('job', j.id, 'copies', j.copies, 'detail', left(coalesce(p_detail, ''), 300), 'host', j.agent_host));
 end if;
 return p_status;
end $$;

-- The printer as the agent sees it, every 15 minutes. Toner under 15 % or an empty tray or toner becomes one task a day
-- for the admin who connected the agent ("Order toner for …" / "Add paper to …").
create function pulse.office_print_status(p_hash text, p jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a office_print_agent := office_print_agent_by(p_hash); r office_printer; prn text; low text[]; nopaper boolean; t text; tid uuid; who uuid;
begin
 if a.id is null then return jsonb_build_object('known', false); end if;
 prn := left(coalesce(nullif(btrim(p->>'printer'), ''), 'printer'), 300);
 update office_print_agent set last_seen_at = now(), last_host = left(p->>'agent', 120) where id = a.id;
 insert into office_printer(org_id, printer, agent_id, agent_host, model, state, warnings, ink, pages, accepts_pdf, last_seen)
  values (a.org_id, prn, a.id, left(p->>'agent', 120), left(p->>'model', 200), left(p->>'state', 40),
   case when jsonb_typeof(p->'warnings') = 'array' then p->'warnings' else '[]' end, case when jsonb_typeof(p->'ink') = 'array' then p->'ink' else '[]' end,
   case when jsonb_typeof(p->'pages') = 'number' then (p->>'pages')::bigint end, case when jsonb_typeof(p->'accepts_pdf') = 'boolean' then (p->>'accepts_pdf')::boolean end, now())
  on conflict (org_id, printer) do update set agent_id = excluded.agent_id, agent_host = excluded.agent_host, model = coalesce(excluded.model, office_printer.model),
   state = excluded.state, warnings = excluded.warnings, ink = excluded.ink, pages = coalesce(excluded.pages, office_printer.pages),
   accepts_pdf = coalesce(excluded.accepts_pdf, office_printer.accepts_pdf), last_seen = now()
  returning * into r;
 select array_agg(coalesce(i->>'name', 'toner') || ' ' || (i->>'percent') || '%') into low from jsonb_array_elements(r.ink) i
  where jsonb_typeof(i->'percent') = 'number' and (i->>'percent')::numeric < 15;
 nopaper := exists (select 1 from jsonb_array_elements_text(r.warnings) w where w like 'media-empty%');
 if (low is not null or nopaper or exists (select 1 from jsonb_array_elements_text(r.warnings) w where w like 'toner-empty%' or w like 'marker-supply-empty%'))
    and (r.alerted_at is null or r.alerted_at < now() - interval '20 hours') then
  who := coalesce((select g.created_by from office_print_agent g join person x on x.id = g.created_by and x.status = 'active' where g.id = a.id),
                  (select id from person where org_id = a.org_id and side = 'staff' and status = 'active' and id in (select person_id from people_profile where role = 'admin') limit 1));
  if who is not null then
   t := left(case when nopaper and low is null then 'Add paper to ' else 'Order toner for ' end || coalesce(nullif(r.model, ''), 'the office printer'), 300);
   insert into task(org_id, title, status, source, source_ref, created_by, created_at, edited_by, updated_at, priority, due_at, locked, notes, owner_id, assignee_person_id, assigned_at)
    values (a.org_id, t, 'open', 'office_print', r.printer, who, now(), who, now(), 'normal', now() + interval '1 day', '{title,owner_id}',
     'The office printer said: ' || coalesce(array_to_string(low, ', '), 'no toner') || case when nopaper then '; out of paper' else '' end
      || '. Seen by the print agent on ' || coalesce(r.agent_host, 'the office computer') || '.', who, who, now()) returning id into tid;
   update office_printer set alerted_at = now(), alert_task = tid where org_id = r.org_id and printer = r.printer;
  end if;
 end if;
 return jsonb_build_object('known', true, 'alert', tid is not null);
end $$;

revoke all on function pulse.office_print_queue(uuid, int, text, int, uuid), pulse.office_print_overview(), pulse.office_print_agent_create(text, text),
 pulse.office_print_agent_revoke(uuid), pulse.office_print_agent_by(text), pulse.office_print_known(text), pulse.office_print_next(text, text, text), pulse.office_print_file(text, uuid),
 pulse.office_print_update(text, uuid, text, text, text), pulse.office_print_status(text, jsonb) from public;
grant execute on function pulse.office_print_queue(uuid, int, text, int, uuid), pulse.office_print_overview(), pulse.office_print_agent_create(text, text),
 pulse.office_print_agent_revoke(uuid), pulse.office_print_known(text), pulse.office_print_next(text, text, text), pulse.office_print_file(text, uuid),
 pulse.office_print_update(text, uuid, text, text, text), pulse.office_print_status(text, jsonb) to pulse_api;

-- migrate:down
-- Forward-only: print jobs, printers and agent tokens (revoked, never deleted) are kept.
