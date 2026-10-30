-- migrate:up
-- KAZUK (28 Oct 2026), Kazuk's Projects tab, round 3:
--  * Dependencies: each step of a delivery template names the steps it waits for ("Depends on" in the Delivery
--    Timeline sheet). Laying out a plan links the tasks (pulse.task_link: the task waits on its blocker), so the timeline
--    shows what a task waits for and "Also move what waits for it" moves them (1300's cascade).
--  * Creatives: a creative card's state (the template's columns, e.g. Rough cut and 2 PM session) is kept per task in
--    pulse.creative_state; without one the board reads it from the task's status.
--  * Handover targets: the template lists them; a project keeps its values in project_plan.targets.
--  * Quote → project runs by itself when the invoice made from an accepted quotation is issued, and tells the people who
--    hold the template's head role (in-app only) that a project waits for its lead.
-- The template update is Estate Autopilots' own, written only to that company.
create table pulse.creative_state(
  org_id uuid not null references pulse.org(id),
  task_id uuid primary key references pulse.task(id),
  state text not null check (length(btrim(state)) between 1 and 40),
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default now());
alter table pulse.creative_state enable row level security;
alter table pulse.creative_state force row level security;
create policy tenant on pulse.creative_state using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.creative_state to pulse_api;

alter table pulse.project_plan add column targets jsonb not null default '{}'::jsonb check (jsonb_typeof(targets) = 'object' and pg_column_size(targets) < 4000);

-- Link a planned project's tasks by the template's "after" lists (each pair once; done work is linked too, for history).
create function pulse.project_plan_links(p_project uuid) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); n int := 0; pl pulse.project_plan;
begin
  select * into pl from pulse.project_plan where org_id = pulse.current_org() and project_id = p_project;
  if pl.project_id is null then return 0; end if;
  insert into pulse.task_link(org_id, task_id, blocker_id, note, created_by)
    select distinct pulse.current_org(), w.id, b.id, left('Plan: ' || (st->>'id') || ' waits for ' || a.dep, 300), me
    from pulse.delivery_template d cross join lateral jsonb_array_elements(d.definition->'steps') st
    cross join lateral jsonb_array_elements_text(coalesce(st->'after', '[]'::jsonb)) a(dep)
    join pulse.task w on w.org_id = pulse.current_org() and w.project_id = p_project and w.template_step = st->>'id' and w.deleted_at is null
    join pulse.task b on b.org_id = pulse.current_org() and b.project_id = p_project and b.template_step = a.dep and b.deleted_at is null
    where d.org_id = pulse.current_org() and d.key = pl.template_key and w.id <> b.id
      and not exists(select 1 from pulse.task_link l where l.org_id = pulse.current_org() and l.task_id = w.id and l.blocker_id = b.id and l.cleared_at is null);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function pulse.project_plan_set(p_project uuid, p_template text, p_package text, p_category text, p_kickoff date, p_lead uuid)
  returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); tz text := pulse.org_time_zone(); def jsonb; st jsonb; pr pulse.project; lead uuid;
  made int := 0; matched int := 0; tid uuid; flag text; due timestamptz; won date; ttl text; kw text; i int;
begin
  select * into pr from pulse.project where org_id = pulse.current_org() and id = p_project and deleted_at is null;
  if pr.id is null then raise exception 'Project not found' using errcode = 'P0002'; end if;
  if not pulse.project_can_run(p_project) then raise exception 'Only the project''s lead, its manager and leadership plan it' using errcode = '42501'; end if;
  select definition into def from pulse.delivery_template where org_id = pulse.current_org() and key = p_template;
  if def is null then raise exception 'Choose a delivery template' using errcode = '22023'; end if;
  if p_package is null or not exists(select 1 from jsonb_array_elements(def->'packages') x where x->>'key' = p_package) then
    raise exception 'Choose the package that was sold' using errcode = '22023'; end if;
  if p_category is not null and not exists(select 1 from jsonb_array_elements(def->'categories') x where x->>'key' = p_category) then
    raise exception 'Choose the project category' using errcode = '22023'; end if;
  if p_kickoff is null then raise exception 'Choose the kick-off day' using errcode = '22023'; end if;
  if p_lead is not null and not exists(select 1 from pulse.person where org_id = pulse.current_org() and id = p_lead and side = 'staff' and status = 'active') then
    raise exception 'Choose an active member of staff as the lead' using errcode = '22023'; end if;
  if p_lead is not null then
    update pulse.project set lead_person_id = p_lead, updated_at = now() where id = p_project;
    update pulse.work_project set owner_id = p_lead, updated_at = now(), updated_by = me where project_id = p_project;
  end if;
  lead := coalesce(p_lead, pr.lead_person_id);
  update pulse.project set starts_on = coalesce(starts_on, p_kickoff), updated_at = now() where id = p_project;
  insert into pulse.project_plan(org_id, project_id, template_key, package, category, kickoff, created_by)
    values (pulse.current_org(), p_project, p_template, p_package, p_category, p_kickoff, me)
    on conflict (project_id) do update set template_key = excluded.template_key, package = excluded.package, category = excluded.category,
      kickoff = excluded.kickoff, updated_at = now();
  for st in select x from jsonb_array_elements(def->'steps') x loop
    flag := coalesce(st->'packages'->>p_package, 'no');
    continue when flag = 'no';
    continue when exists(select 1 from pulse.task t where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.template_step = st->>'id');
    due := case when st->>'end' is null then null else ((p_kickoff + (st->>'end')::int) + time '18:00') at time zone tz end;
    won := p_kickoff + greatest(0, (st->>'start')::int);
    -- A quotation line made into tasks takes the step (every matching unit: Model video #1 and #2).
    i := 0;
    for kw in select jsonb_array_elements_text(coalesce(st->'match', '[]'::jsonb)) loop
      with hit as (update pulse.task t set template_step = st->>'id', phase_key = 's' || (st->>'stage'), due_at = coalesce(t.due_at, due),
          work_on = coalesce(t.work_on, won), role_key = coalesce(t.role_key, left(st->>'owner', 60)), updated_at = now(), edited_by = me
        where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.source = 'quote' and t.template_step is null
          and lower(t.title) like '%' || lower(kw) || '%' returning t.id)
      select count(*) into i from hit;
      matched := matched + i;
      exit when i > 0;
    end loop;
    continue when i > 0 or flag = 'optional';
    ttl := left(format('%s %s', st->>'id', st->>'title'), 300);
    insert into pulse.task(org_id, project_id, title, assignee_person_id, role_key, created_by, created_at, assigned_at, due_at, work_on,
        source, source_key, template_step, phase_key, notes, status)
      values (pulse.current_org(), p_project, ttl, case when st->>'owner' = def->'bandwidth'->>'role' then lead end, left(st->>'owner', 60), me, now(), now(), due, won,
        'template', format('plan:%s:%s', p_project, st->>'id'), st->>'id', 's' || (st->>'stage'),
        nullif(concat_ws(chr(10), case when (st->>'clientInput')::boolean then 'Needs the client''s input.' end,
          (select string_agg(format('%s. %s', n, c), chr(10) order by n) from jsonb_array_elements_text(coalesce(st->'checks', '[]'::jsonb)) with ordinality as x(c, n))), ''), 'open')
      on conflict (org_id, source_key) do nothing returning id into tid;
    if tid is not null then
      insert into pulse.task_event(org_id, task_id, actor_id, kind, to_value, note) values (pulse.current_org(), tid, me, 'created', ttl, 'From the delivery plan');
      made := made + 1; tid := null;
    end if;
  end loop;
  perform pulse.project_plan_links(p_project);
  perform pulse.audit_write('project_plan_set', 'project', p_project::text);
  return jsonb_build_object('projectId', p_project, 'tasks', made, 'matched', matched);
end $$;

-- A creative's state on the board (its lead, the project's people who run it, or the task's own people).
create function pulse.creative_move(p_task uuid, p_state text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); t pulse.task; cols jsonb;
begin
  select * into t from pulse.task where org_id = pulse.current_org() and id = p_task and deleted_at is null;
  if t.id is null or t.project_id is null then raise exception 'Task not found' using errcode = 'P0002'; end if;
  if not (pulse.project_can_run(t.project_id) or me in (t.created_by, t.assignee_person_id, t.owner_id, t.review_owner_id)) then
    raise exception 'Only the creative''s people and the project''s lead move it' using errcode = '42501'; end if;
  select d.definition->'creativeColumns' into cols from pulse.project_plan pl join pulse.delivery_template d on d.org_id = pl.org_id and d.key = pl.template_key where pl.project_id = t.project_id;
  if cols is null or not (cols ? p_state) then raise exception 'Choose one of the board''s columns' using errcode = '22023'; end if;
  insert into pulse.creative_state(org_id, task_id, state, updated_by) values (pulse.current_org(), p_task, p_state, me)
    on conflict (task_id) do update set state = excluded.state, updated_by = excluded.updated_by, updated_at = now();
  insert into pulse.task_event(org_id, task_id, actor_id, kind, to_value, note) values (pulse.current_org(), p_task, me, 'step', left(p_state, 100), 'Creative moved on the board');
  return jsonb_build_object('task', p_task, 'state', p_state);
end $$;

-- Handover targets (the template's list; values are short text such as "6", "12-30", "₹450").
create function pulse.project_targets_set(p_project uuid, p_targets jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare pl pulse.project_plan; keys jsonb; k text; out jsonb := '{}'::jsonb;
begin
  select * into pl from pulse.project_plan where org_id = pulse.current_org() and project_id = p_project;
  if pl.project_id is null then raise exception 'This project has no delivery plan' using errcode = 'P0002'; end if;
  if not pulse.project_can_run(p_project) then raise exception 'Only the project''s lead, its manager and leadership set its targets' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(x->'key'), '[]'::jsonb) into keys from pulse.delivery_template d, jsonb_array_elements(coalesce(d.definition->'targets', '[]'::jsonb)) x
    where d.org_id = pulse.current_org() and d.key = pl.template_key;
  for k in select jsonb_object_keys(coalesce(p_targets, '{}'::jsonb)) loop
    continue when not (keys ? k);
    continue when nullif(btrim(p_targets->>k), '') is null;
    out := out || jsonb_build_object(k, left(btrim(p_targets->>k), 40));
  end loop;
  update pulse.project_plan set targets = out, updated_at = now() where project_id = p_project;
  perform pulse.audit_write('project_targets_set', 'project', p_project::text);
  return out;
end $$;

-- When an invoice is issued from an accepted quotation (directly, or through its proforma), the project builds itself
-- and the template's head role hears that it waits for a lead. Never blocks issuing the invoice.
create function pulse.project_from_invoice() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare q uuid; r jsonb; head record; roles text[]; ttl text;
begin
  if new.doc_type <> 'invoice' or new.status is not distinct from old.status or old.status <> 'draft' or new.status = 'cancelled' then return null; end if;
  select coalesce((select d.id from pulse.erp_document d where d.id = new.source_id and d.doc_type = 'quotation'),
                  (select d2.id from pulse.erp_document d join pulse.erp_document d2 on d2.id = d.source_id where d.id = new.source_id and d.doc_type = 'proforma' and d2.doc_type = 'quotation')) into q;
  if q is null or not exists(select 1 from pulse.erp_document where id = q and status = 'accepted') then return null; end if;
  if exists(select 1 from pulse.project_quote where org_id = new.org_id and document_id = q) then return null; end if;
  begin
    r := pulse.project_from_quote(q, null, null);
  exception when others then
    return null;
  end;
  select array(select jsonb_array_elements_text(coalesce(d.definition->'headRoles', '[]'::jsonb))) into roles from pulse.delivery_template d where d.org_id = new.org_id order by d.key limit 1;
  ttl := 'New project to assign: ' || coalesce((select coalesce(title, name) from pulse.project where id = (r->>'projectId')::uuid), 'from an invoice');
  for head in select distinct ra.person_id from pulse.role_assignment ra where ra.org_id = new.org_id and ra.role_key = any(coalesce(roles, '{}'))
      and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity') loop
    perform pulse.work_notify(head.person_id, 'project.added', 'project', (r->>'projectId')::uuid, 'project.new:' || (r->>'projectId') || ':' || head.person_id, ttl, '/tasks/projects/' || (r->>'projectId'), 'task');
  end loop;
  return null;
end $$;
create trigger project_from_invoice after update of status on pulse.erp_document for each row execute function pulse.project_from_invoice();

revoke all on function pulse.project_plan_links(uuid), pulse.creative_move(uuid, text), pulse.project_targets_set(uuid, jsonb) from public;
grant execute on function pulse.project_plan_links(uuid), pulse.creative_move(uuid, text), pulse.project_targets_set(uuid, jsonb) to pulse_api;

select set_config('pulse.org_id', o.id::text, true) from pulse.org o where o.id = '6f1a455d-ced2-504d-b8d5-5ae0efbe7c75';
update pulse.delivery_template set definition = '{"version": 2, "source": "Delivery Timeline v1 (draft for review) and the Projects tab screens", "stages": [{"n": 0, "key": "s0", "label": "Handover"}, {"n": 1, "key": "s1", "label": "Onboarding"}, {"n": 2, "key": "s2", "label": "Blueprint"}, {"n": 3, "key": "s3", "label": "First creatives"}, {"n": 4, "key": "s4", "label": "Trust assets"}, {"n": 5, "key": "s5", "label": "Go-live gate"}, {"n": 6, "key": "s6", "label": "Run journey"}, {"n": 7, "key": "s7", "label": "Weekly review"}, {"n": 8, "key": "s8", "label": "New creatives"}], "packages": [{"key": "sell_out", "label": "Sell-Out"}, {"key": "growth", "label": "Growth"}, {"key": "starter", "label": "Starter"}], "categories": [{"key": "sell_out", "label": "Sell-Out", "units": 1}, {"key": "competitive", "label": "Competitive", "units": 0.6}, {"key": "normal", "label": "Normal", "units": 0.4}], "bandwidth": {"role": "Growth Strategist", "short": "GS", "healthy": [6, 7], "max": 8, "note": "Above the maximum the team needs a new hire"}, "milestones": {"adsLive": "C5", "foundation": "G2", "resultCheck": ["G3", "G5"], "campaignMonths": "C5", "script": "C1"}, "creativeColumns": ["Script", "Client confirmed", "Shoot / design", "Rough cut", "2 PM session", "Campaign ready", "Live"], "labels": {"hold": "Our hold", "teamChat": "team chat", "clientGroup": "client group", "adsLive": "Ads live", "foundation": "Foundation", "resultCheck": "Result check", "headLead": "Head Growth Strategist"}, "steps": [{"id": "B1", "stage": 0, "title": "Project Sell-Out Strategy Session", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": -7, "end": 0, "owner": "Sales team", "clientInput": true, "kind": "task", "match": ["strategy session"], "after": []}, {"id": "GT1", "stage": 0, "title": "G1 Handover: sales hands the project to the Growth Strategist", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 0, "end": 0, "owner": "Growth Strategist", "clientInput": false, "kind": "gate", "match": [], "after": []}, {"id": "O1", "stage": 1, "title": "Kick-off call and resource collection (brochure, 3D, price sheet, inventory)", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 0, "end": 2, "owner": "Growth Strategist", "clientInput": true, "kind": "task", "match": ["kick-off", "kickoff"], "after": ["GT1"]}, {"id": "GT2", "stage": 1, "title": "G2 Registration number received", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 0, "end": 3, "owner": "Growth Strategist", "clientInput": true, "kind": "gate", "match": [], "after": ["GT1"]}, {"id": "GT3", "stage": 1, "title": "G3 Access: ad account, page and site access received", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 0, "end": 5, "owner": "Growth Strategist", "clientInput": true, "kind": "gate", "match": [], "after": ["GT1"]}, {"id": "O2", "stage": 1, "title": "Neeti account setup: users, lead routing, alerts", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 2, "end": 10, "owner": "Neeti team", "clientInput": true, "kind": "task", "match": ["neeti"], "after": ["O1"]}, {"id": "N1", "stage": 1, "title": "Neeti onboarding for owner, sales head and sales team", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 10, "end": 15, "owner": "Neeti team", "clientInput": true, "kind": "task", "match": [], "after": ["O2"]}, {"id": "GT4", "stage": 1, "title": "G4 CRM connected: test leads reach the sales team", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 8, "end": 10, "owner": "Neeti team", "clientInput": false, "kind": "gate", "match": [], "after": ["O2"]}, {"id": "P1", "stage": 2, "title": "Deep Market Research (incl. competition scan)", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 1, "end": 4, "owner": "Creative Strategist", "clientInput": false, "kind": "task", "match": ["market research", "research"], "after": ["O1"]}, {"id": "P2", "stage": 2, "title": "Buyer Persona Strategy", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 3, "end": 6, "owner": "Creative Strategist", "clientInput": false, "kind": "task", "match": ["persona"], "after": ["P1"]}, {"id": "P3", "stage": 2, "title": "Project Positioning + Word Library", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 5, "end": 9, "owner": "Creative Strategist", "clientInput": false, "kind": "task", "match": ["positioning"], "after": ["P2"]}, {"id": "P4", "stage": 2, "title": "Project Brand Blueprint delivered and signed", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 7, "end": 12, "owner": "Creative Strategist", "clientInput": true, "kind": "milestone", "match": ["blueprint"], "after": ["P3"]}, {"id": "P5", "stage": 2, "title": "Brand Identity: project name, tagline, logo, colour palette, typography", "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "start": 7, "end": 20, "owner": "Design team", "clientInput": true, "kind": "task", "match": ["brand identity", "logo"], "after": ["P3"]}, {"id": "P6", "stage": 2, "title": "Brand collateral design: brochure, pitch deck, billboard and offline design", "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "start": 15, "end": 30, "owner": "Design team", "clientInput": true, "kind": "task", "match": ["brochure", "collateral"], "after": ["P5"]}, {"id": "P7", "stage": 2, "title": "Social Media Optimization", "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "start": 10, "end": 20, "owner": "Social team", "clientInput": true, "kind": "task", "match": ["social media optimi"], "after": ["P3"]}, {"id": "A1", "stage": 2, "title": "Sales Alignment Module 1: Project Brainstorm & Alignment", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 12, "end": 15, "owner": "Creative Strategist", "clientInput": true, "kind": "task", "match": ["alignment module", "module 1"], "after": ["P4"]}, {"id": "C1", "stage": 3, "title": "Hooks and scripts: model-led video, VOV, image ad copy", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 7, "end": 10, "owner": "Creative Strategist", "clientInput": true, "kind": "task", "match": ["script"], "after": ["P3"]}, {"asset": "MV", "id": "C2", "stage": 3, "title": "Model-Led Video Ad: shoot and edit", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 8, "end": 14, "owner": "Video team", "clientInput": true, "kind": "task", "match": ["model-led video", "model led video", "mmv", "model video"], "after": ["C1"]}, {"asset": "IMG", "id": "C3", "stage": 3, "title": "Single Image Curiosity Ads (set of 4)", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 8, "end": 12, "owner": "Design team", "clientInput": false, "kind": "task", "match": ["image"], "after": ["C1"]}, {"asset": "VOV", "id": "C4", "stage": 3, "title": "High-Conversion VOV Ad", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 8, "end": 14, "owner": "Video team", "clientInput": false, "kind": "task", "match": ["vov", "voice over"], "after": ["C1"]}, {"asset": "LP", "id": "T1", "stage": 4, "title": "AI-Powered Premium Landing Page", "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "start": 10, "end": 18, "owner": "Web team", "clientInput": false, "kind": "task", "match": ["landing page"], "after": ["P3", "C1"]}, {"id": "T2", "stage": 4, "title": "Project website + SEO + third-party listings", "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "start": 15, "end": 40, "owner": "Web team", "clientInput": true, "kind": "task", "match": ["website", "seo", "portal"], "after": ["P5", "T1"]}, {"asset": "WT", "id": "T3", "stage": 4, "title": "Walkthrough Video", "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "start": 15, "end": 30, "owner": "Video team", "clientInput": true, "kind": "task", "match": ["walkthrough"], "after": ["P4"]}, {"asset": "FV", "id": "T4", "stage": 4, "title": "Founder Authority Video", "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "start": 15, "end": 30, "owner": "Video team", "clientInput": true, "kind": "task", "match": ["founder"], "after": ["P4"]}, {"asset": "TST", "id": "T5", "stage": 4, "title": "Client Video Testimonials (where feasible)", "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "start": 20, "end": 45, "owner": "Video team", "clientInput": true, "kind": "task", "match": ["testimonial"], "after": ["T4"]}, {"asset": "BF", "id": "T6", "stage": 4, "title": "Brand Film", "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "start": 30, "end": 60, "owner": "Video team", "clientInput": true, "kind": "task", "match": ["brand film"], "after": ["P5"]}, {"id": "GT5", "stage": 5, "title": "G5 Go-live: every go-live check done", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 12, "end": 15, "owner": "Growth Strategist", "clientInput": false, "kind": "gate", "match": [], "checks": ["Blueprint signed", "Scripts approved by the client", "Model-led video approved", "Image ad set approved", "VOV approved", "Landing page live", "Ad account and page access", "Ad budget confirmed by the client", "Test leads reach the sales team", "Tracking and lead form checked"], "after": ["C2", "C3", "C4", "GT3", "GT4"]}, {"id": "C5", "stage": 5, "title": "First Curiosity campaign live (package months start here)", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 12, "end": 15, "owner": "Performance team", "clientInput": false, "kind": "milestone", "match": [], "after": ["GT5", "O2"]}, {"id": "J1", "stage": 5, "title": "Meta ads + WhatsApp and retargeting nurturing live", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 12, "end": 15, "owner": "Performance team", "clientInput": true, "kind": "milestone", "match": ["meta"], "after": ["C5"]}, {"id": "J2", "stage": 6, "title": "Google Search ads live", "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "start": 18, "end": 20, "owner": "Performance team", "clientInput": true, "kind": "task", "match": ["google search", "google ads"], "after": ["T1"]}, {"id": "J3", "stage": 6, "title": "YouTube ads live", "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "start": 15, "end": 20, "owner": "Performance team", "clientInput": true, "kind": "task", "match": ["youtube"], "after": ["C2", "C4"]}, {"id": "J4", "stage": 6, "title": "ChatGPT ads live", "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "start": 20, "end": 30, "owner": "Performance team", "clientInput": true, "kind": "task", "match": ["chatgpt"], "after": ["C5"]}, {"id": "J5", "stage": 6, "title": "Email nurturing and email marketing live", "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "start": 15, "end": 20, "owner": "Performance team", "clientInput": false, "kind": "task", "match": ["email"], "after": ["C5", "O2"]}, {"id": "N2", "stage": 6, "title": "Neeti reporting live: CPL, cost per site visit, cost per booking", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 15, "end": null, "owner": "Neeti team", "clientInput": true, "kind": "ongoing", "match": [], "after": ["C5"]}, {"id": "A2", "stage": 6, "title": "Sales Alignment Module 2: first-call rapport and qualification", "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "start": 15, "end": 28, "owner": "Sales trainer", "clientInput": true, "kind": "task", "match": ["module 2"], "after": ["C5"]}, {"id": "A3", "stage": 6, "title": "Sales Alignment Module 3: objection handling and negotiation", "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "start": 22, "end": 42, "owner": "Sales trainer", "clientInput": true, "kind": "task", "match": ["module 3"], "after": ["A2"]}, {"id": "A4", "stage": 6, "title": "Sales Alignment Module 4: site-visit presence", "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "start": 20, "end": 30, "owner": "Sales trainer", "clientInput": true, "kind": "task", "match": ["module 4"], "after": ["A2"]}, {"asset": "CP", "id": "B4", "stage": 6, "title": "CP Activation Kit + CP Alignment videos", "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "start": 20, "end": 35, "owner": "Video team", "clientInput": false, "kind": "task", "match": ["cp activation", "cp alignment", "channel partner"], "after": ["C2"]}, {"id": "B5", "stage": 6, "title": "Site Visit Experience Checklist", "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "start": 15, "end": 20, "owner": "Creative Strategist", "clientInput": false, "kind": "task", "match": ["site visit"], "after": ["P4"]}, {"id": "G1", "stage": 6, "title": "Priority Trust Assets delivered (Walkthrough + Founder)", "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "start": 30, "end": 30, "owner": "Growth Strategist", "clientInput": false, "kind": "milestone", "match": [], "after": ["T3", "T4"]}, {"id": "G2", "stage": 6, "title": "Foundation complete: 30-Day Foundation Guarantee check", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 30, "end": 30, "owner": "Growth Strategist", "clientInput": true, "kind": "milestone", "match": [], "after": ["C5"]}, {"id": "J6", "stage": 7, "title": "Campaign optimisation + weekly client review", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 15, "end": null, "owner": "Performance team", "clientInput": true, "kind": "ongoing", "match": [], "after": ["C5"]}, {"id": "T7", "stage": 7, "title": "Social Media Management: 20 posts a month", "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "start": 15, "end": null, "owner": "Social team", "clientInput": true, "kind": "ongoing", "match": ["social media management"], "after": ["P7"]}, {"id": "B2", "stage": 7, "title": "Live group sales training", "packages": {"sell_out": "yes", "growth": "yes", "starter": "yes"}, "start": 30, "end": null, "owner": "Sales trainer", "clientInput": true, "kind": "ongoing", "match": ["group sales training", "group training"], "after": ["C5"]}, {"id": "B3", "stage": 7, "title": "One-on-one sales coaching", "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "start": 30, "end": null, "owner": "Sales trainer", "clientInput": true, "kind": "ongoing", "match": ["one-on-one", "coaching"], "after": ["N2"]}, {"id": "G3", "stage": 7, "title": "Refund evaluation (30 days after ads go live)", "packages": {"sell_out": "no", "growth": "yes", "starter": "yes"}, "start": 42, "end": 45, "owner": "Growth Strategist", "clientInput": true, "kind": "milestone", "match": [], "after": ["C5"]}, {"id": "G4", "stage": 7, "title": "Sales incentive release", "packages": {"sell_out": "no", "growth": "yes", "starter": "yes"}, "start": 50, "end": 50, "owner": "Finance", "clientInput": false, "kind": "milestone", "match": [], "after": ["G3"]}, {"id": "G5", "stage": 7, "title": "60-Day Performance Assurance evaluation", "packages": {"sell_out": "yes", "growth": "no", "starter": "no"}, "start": 72, "end": 75, "owner": "Growth Strategist", "clientInput": true, "kind": "milestone", "match": [], "after": ["C5"]}, {"asset": "RMX", "id": "C6", "stage": 8, "title": "Creative Remix & Hybrid Ads (from the first 30 days of ad data)", "packages": {"sell_out": "yes", "growth": "yes", "starter": "no"}, "start": 45, "end": 60, "owner": "Video team", "clientInput": false, "kind": "task", "match": ["remix", "hybrid"], "after": ["C5"]}, {"id": "C7", "stage": 8, "title": "Extra Curiosity Asset quantities", "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "start": 30, "end": 45, "owner": "Video team", "clientInput": false, "kind": "task", "match": [], "after": ["C5"]}, {"id": "G6", "stage": 8, "title": "Curiosity Refresh (add-on), months 4-6 of campaigns", "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "start": 105, "end": 195, "owner": "Video team", "clientInput": false, "kind": "task", "match": ["refresh"], "after": ["C5"]}, {"id": "A5", "stage": 8, "title": "Ongoing sales team support (monthly)", "packages": {"sell_out": "optional", "growth": "optional", "starter": "optional"}, "start": 45, "end": null, "owner": "Sales trainer", "clientInput": false, "kind": "ongoing", "match": ["sales team support"], "after": ["A4"]}], "targets": [{"key": "sellout_months", "label": "Sell-out timeline", "unit": "months"}, {"key": "enquiries_day", "label": "Enquiries a day", "unit": "a day"}, {"key": "cpl", "label": "CPL benchmark", "unit": "₹", "dueStep": "P1"}, {"key": "qualified_pct", "label": "Qualified buyers", "unit": "%"}], "headRoles": ["head_pgs"]}'::jsonb, updated_at = now()
  where org_id = '6f1a455d-ced2-504d-b8d5-5ae0efbe7c75' and key = 'agency-creative';
select pulse.project_plan_links(pl.project_id) from pulse.project_plan pl where pl.org_id = '6f1a455d-ced2-504d-b8d5-5ae0efbe7c75';
select set_config('pulse.org_id', '', true);

-- migrate:down
drop trigger project_from_invoice on pulse.erp_document;
drop function pulse.project_from_invoice();
drop function pulse.project_targets_set(uuid, jsonb);
drop function pulse.project_plan_links(uuid);
drop function pulse.creative_move(uuid, text);
alter table pulse.project_plan drop column targets;
drop table pulse.creative_state;
