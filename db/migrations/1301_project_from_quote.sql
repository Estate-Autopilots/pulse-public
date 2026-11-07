-- migrate:up
-- KAZUK (28 Oct 2026): Kazuk's screen 0, "Quote signed → the project builds itself". From an accepted quotation in
-- Billing (pulse.erp_document, the one quotation and invoice builder; no second invoice system), Pulse makes the client
-- project (or uses the one the quotation names), gives it a lead (PGS) and a kick-off day, and turns every line that was
-- sold into work: a line with a quantity of N countable things (videos, image sets) becomes N tasks (#1 … #N), a monthly
-- or milestone line one task. Each task remembers its line (task.source 'quote', source_ref = the erp_line id), so the
-- project shows sold against delivered, and work outside the quote can be raised as an add-on quotation. Running it
-- again adds only what is missing (task.source_key 'quote:<line>:<n>' is unique per company).
-- An issued quotation is never edited (erp_document_guard), so the project it started is kept beside it.
create table pulse.project_quote(
  org_id uuid not null references pulse.org(id),
  document_id uuid not null references pulse.erp_document(id),
  project_id uuid not null references pulse.project(id),
  linked_by uuid references pulse.person(id),
  linked_at timestamptz not null default now(),
  primary key (org_id, document_id));
create index project_quote_project on pulse.project_quote(org_id, project_id);
alter table pulse.project_quote enable row level security;
alter table pulse.project_quote force row level security;
create policy tenant on pulse.project_quote using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.project_quote to pulse_api;

create function pulse.project_from_quote(p_doc uuid, p_lead uuid, p_starts date) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); d pulse.erp_document; pid uuid; made int := 0; reg int; tz text := pulse.org_time_zone();
  ln record; n int; i int; tid uuid; title text; created boolean := false; nm text;
begin
  if me is null or not pulse.erp_can(true) then
    raise exception 'Starting a project from a quotation is for leadership and the Finance role' using errcode = '42501'; end if;
  select * into d from pulse.erp_document where org_id = pulse.current_org() and id = p_doc;
  if d.id is null or d.doc_type <> 'quotation' then raise exception 'Quotation not found' using errcode = 'P0002'; end if;
  if d.status <> 'accepted' then raise exception 'Mark the quotation accepted (signed) first' using errcode = '22023'; end if;
  if p_lead is not null and not exists(select 1 from pulse.person where org_id = pulse.current_org() and id = p_lead and side = 'staff' and status = 'active') then
    raise exception 'Choose an active member of staff as the lead' using errcode = '22023'; end if;
  pid := coalesce(d.project_id, (select q.project_id from pulse.project_quote q where q.org_id = pulse.current_org() and q.document_id = d.id));
  if pid is null then
    nm := left(btrim(coalesce(nullif(d.reference->>'project', ''), d.buyer->>'name', 'Project from ' || coalesce(d.number, 'a quotation'))), 160);
    perform pg_advisory_xact_lock(hashtext('project-register:' || pulse.current_org()::text));
    select coalesce(max(registry_no), 0) + 1 into reg from pulse.project where org_id = pulse.current_org();
    insert into pulse.project(org_id, registry_no, name, title, client_id, kind, status, starts_on, lead_person_id, locked)
      values (pulse.current_org(), reg, nm, nm, d.client_id, 'client_work', 'active', coalesce(p_starts, (now() at time zone tz)::date), p_lead, '{title,client_id}')
      returning id into pid;
    created := true;
  elsif p_lead is not null then
    update pulse.project set lead_person_id = coalesce(lead_person_id, p_lead), starts_on = coalesce(starts_on, p_starts), updated_at = now() where id = pid;
  end if;
  insert into pulse.project_quote(org_id, document_id, project_id, linked_by) values (pulse.current_org(), d.id, pid, me) on conflict do nothing;
  insert into pulse.work_project(org_id, project_id, kind, owner_id, starts_on, status, summary, created_by, updated_by)
    values (pulse.current_org(), pid, 'fulfilment', coalesce(p_lead, (select lead_person_id from pulse.project where id = pid)), coalesce(p_starts, (now() at time zone tz)::date), 'active',
      left(format('From quotation %s', coalesce(d.number, '')), 1000), me, me)
    on conflict do nothing;
  for ln in select l.* from pulse.erp_line l where l.document_id = d.id and l.parent_position is null and not coalesce(l.not_needed, false) order by l.position loop
    n := case when lower(coalesce(ln.unit, '')) ~ '(month|milestone|lump|job|package|service)' or ln.qty is null or ln.qty <> trunc(ln.qty) or ln.qty < 2 then 1 else least(ln.qty::int, 24) end;
    for i in 1 .. n loop
      title := left(btrim(ln.description) || case when n > 1 then format(' #%s', i) else '' end, 300);
      insert into pulse.task(org_id, project_id, title, assignee_person_id, created_by, created_at, assigned_at, source, source_ref, source_key, notes, status)
        values (pulse.current_org(), pid, title, coalesce(p_lead, (select lead_person_id from pulse.project where id = pid)), me, now(), now(), 'quote', ln.id::text,
          format('quote:%s:%s', ln.id, i), nullif(left(coalesce(ln.details, ''), 20000), ''), 'open')
        on conflict (org_id, source_key) do nothing returning id into tid;
      if tid is not null then
        insert into pulse.task_event(org_id, task_id, actor_id, kind, to_value, note) values (pulse.current_org(), tid, me, 'created', title, left(format('From quotation %s', coalesce(d.number, '')), 1000));
        made := made + 1; tid := null;
      end if;
    end loop;
  end loop;
  perform pulse.audit_write('project_from_quote', 'project', pid::text);
  return jsonb_build_object('projectId', pid, 'created', created, 'tasks', made);
end $$;

-- Sold against delivered: each accepted quotation line of the project with its tasks made and finished.
create function pulse.project_scope(p_project uuid) returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object(
    'quotes', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'number', d.number, 'status', d.status, 'issueDate', d.issue_date) order by d.issue_date)
       from pulse.erp_document d where d.org_id = pulse.current_org() and (d.project_id = p_project or exists(select 1 from pulse.project_quote q where q.org_id = d.org_id and q.document_id = d.id and q.project_id = p_project)) and d.doc_type = 'quotation' and d.status in ('accepted','sent','issued')), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'description', l.description, 'qty', l.qty, 'unit', l.unit, 'quote', d.number, 'accepted', d.status = 'accepted',
         'tasks', (select count(*) from pulse.task t where t.org_id = pulse.current_org() and t.source = 'quote' and t.source_ref = l.id::text and t.deleted_at is null and t.status <> 'cancelled'),
         'done', (select count(*) from pulse.task t where t.org_id = pulse.current_org() and t.source = 'quote' and t.source_ref = l.id::text and t.deleted_at is null and t.status in ('done','accepted')),
         'doing', (select count(*) from pulse.task t where t.org_id = pulse.current_org() and t.source = 'quote' and t.source_ref = l.id::text and t.deleted_at is null and t.status in ('in_progress','in_review')))
       order by d.issue_date, l.position)
       from pulse.erp_document d join pulse.erp_line l on l.document_id = d.id
       where d.org_id = pulse.current_org() and (d.project_id = p_project or exists(select 1 from pulse.project_quote q where q.org_id = d.org_id and q.document_id = d.id and q.project_id = p_project)) and d.doc_type = 'quotation' and d.status = 'accepted' and l.parent_position is null and not coalesce(l.not_needed, false)), '[]'::jsonb),
    'outside', (select count(*) from pulse.task t where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.parent_id is null
       and t.status in ('open','in_progress','blocked','in_review') and t.source = 'pulse'
       and exists(select 1 from pulse.erp_document d where d.org_id = pulse.current_org() and (d.project_id = p_project or exists(select 1 from pulse.project_quote q where q.org_id = d.org_id and q.document_id = d.id and q.project_id = p_project)) and d.doc_type = 'quotation' and d.status = 'accepted')))
  where pulse.current_viewer() is not null
$$;
revoke all on function pulse.project_from_quote(uuid, uuid, date), pulse.project_scope(uuid) from public;
grant execute on function pulse.project_from_quote(uuid, uuid, date), pulse.project_scope(uuid) to pulse_api;

-- migrate:down
drop function pulse.project_scope(uuid);
drop function pulse.project_from_quote(uuid, uuid, date);
drop table pulse.project_quote;
