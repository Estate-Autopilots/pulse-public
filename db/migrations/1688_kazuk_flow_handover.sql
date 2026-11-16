-- migrate:up
-- KAZUK-FLOW G11 (Kazuk, 6 Nov 2026: "when payment is done a notification goes to the Head Growth Strategist, who
-- decides which Growth Strategist takes it and the client's category"; owner, 7 Nov: the PGS is per project).
-- On the first payment 1471 starts exactly one client project (pulse.work_project.project_type 'client_delivery',
-- 1640's one category field) and tells the project heads. Here, as configuration of the sales flow's handover step:
--  1. The handover: one task on the project carrying everything the PGS needs: the client and company, contacts and
--     location, the accepted version (V#) with links to the quotation and the invoice, what was sold (lines, package
--     parts and deliverables), the payments with their references and proof links, the salesperson. Unassigned until a
--     PGS is chosen; then it is theirs and they are told.
--  2. The PGS per project: pulse.project_pgs_suggest suggests one from the client's history (who ran their earlier
--     project), else by the least load among growth strategists (healthy up to handover.pgsHealthy, at most
--     handover.pgsMax active projects: 7 and 8 by default, EA's own numbers); a person confirms in the assignment
--     (pulse.project_assign_pgs over 1471's project_assign): the PGS becomes the project's head and point of contact,
--     a member, and the project takes their pod when it has none.
--  3. Add-on invoices: an invoice paid for a client whose project is live adds its lines to that project as new scope
--     (tasks), links the invoice to it and tells its PGS "scope added"; never a second project.
--  4. Gap tasks: each commitment the handover step lists (EA's preset: the kickoff date, the signed targets, the
--     qualified-buyer minimum) that the deal does not record (quotation reference.commitments), and a side promise
--     noted on the quotation, become a named task for the salesperson in the project; they never block it.
--  5. Kazuk's open questions as settings: handover.startAt 'first_payment' (today's), payment.verify (a Finance check,
--     off in EA's preset), proforma hidden for the sales role in EA's preset.
--  Each part is the handover step's setting (brief, addOns, gaps): off with no preset, so every company keeps today's
--  behaviour until it chooses; on in EA's preset.
-- Synthetic data only in tests; nothing here reads or writes production data.

-- ------------------------------------------------------------------------------------------- the flow's settings
create or replace function pulse.erp_flow_defaults() returns jsonb language sql immutable as $$
 select jsonb_build_object(
  'quote',    jsonb_build_object('on', true, 'roles', '[]'::jsonb, 'locked', false),
  'send',     jsonb_build_object('on', true, 'roles', '[]'::jsonb, 'locked', false, 'required', '[]'::jsonb),
  'approve',  jsonb_build_object('roles', '["leadership","admin"]'::jsonb, 'locked', true,
                'why', 'A manager or the owner approves this before it is numbered and sent', 'unlock', '["leadership","admin"]'::jsonb),
  'price',    jsonb_build_object('on', true, 'roles', '["leadership"]'::jsonb, 'locked', true,
                'why', 'A price away from the catalogue on an AI-drafted quotation waits for the owner', 'unlock', '["leadership"]'::jsonb),
  'version',  jsonb_build_object('on', true, 'roles', '[]'::jsonb, 'locked', false),
  'accept',   jsonb_build_object('on', true, 'roles', '[]'::jsonb, 'locked', false),
  'lost',     jsonb_build_object('on', true, 'roles', '[]'::jsonb, 'locked', false),
  'proforma', jsonb_build_object('on', true, 'roles', '[]'::jsonb, 'locked', false, 'hiddenFor', '[]'::jsonb),
  'invoice',  jsonb_build_object('on', true, 'roles', '[]'::jsonb, 'locked', true, 'lockedFor', '["sales"]'::jsonb,
                'why', 'A salesperson makes the invoice from their accepted quotation', 'unlock', '["finance","leadership","admin"]'::jsonb),
  'payment',  jsonb_build_object('on', true, 'roles', '[]'::jsonb, 'locked', false, 'verify', false),
  'handover', jsonb_build_object('on', true, 'roles', '[]'::jsonb, 'locked', false, 'startAt', 'first_payment', 'pgsHealthy', 7, 'pgsMax', 8,
                'brief', false, 'addOns', false, 'gaps', '[]'::jsonb))
$$;
create or replace function pulse.erp_flow_preset(p_preset text) returns jsonb language sql immutable as $$
 select case p_preset
  when 'ea' then pulse.erp_flow_defaults() || jsonb_build_object(
    'price', pulse.erp_flow_defaults()->'price' || '{"on": false}'::jsonb,
    'send', pulse.erp_flow_defaults()->'send' || '{"required": ["name", "contactName", "phone", "email", "siteLocation"]}'::jsonb,
    'invoice', pulse.erp_flow_defaults()->'invoice' || '{"linesLocked": true}'::jsonb,
    'payment', pulse.erp_flow_defaults()->'payment' || '{"proofRequired": true, "verify": false}'::jsonb,
    'proforma', pulse.erp_flow_defaults()->'proforma' || '{"hiddenFor": ["sales"]}'::jsonb,
    'handover', pulse.erp_flow_defaults()->'handover' || jsonb_build_object('brief', true, 'addOns', true, 'gaps', jsonb_build_array(
      jsonb_build_object('key', 'kickoff', 'label', 'Confirm the kickoff date with the client'),
      jsonb_build_object('key', 'targets', 'label', 'Get the targets signed by the client'),
      jsonb_build_object('key', 'qb_minimum', 'label', 'Agree the qualified-buyer minimum with the client'))))
  when 'wl' then pulse.erp_flow_defaults()
  else pulse.erp_flow_defaults() end
$$;

-- ------------------------------------------------------------------------------------------------ the handover
-- Everything the PGS needs, as the handover task's text (links are Pulse paths).
create function pulse.erp_handover_text(p_invoice uuid) returns text language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare inv erp_document; q erp_document; cl client; t text := ''; r record; sp text;
begin
  select * into inv from erp_document where org_id = current_org() and id = p_invoice;
  select x.* into q from erp_document x where x.id = inv.source_id and x.doc_type = 'quotation';
  if q.id is null then select y.* into q from erp_document x join erp_document y on y.id = x.source_id where x.id = inv.source_id and y.doc_type = 'quotation'; end if;
  select * into cl from client where id = inv.client_id;
  sp := (select display_name from person where id = coalesce(q.salesperson_id, inv.salesperson_id, q.created_by));
  t := format(E'Client: %s%s\nLocation: %s\nContact: %s\n', coalesce(inv.buyer->>'name', cl.display_name, 'not named'),
    case when cl.company_name is not null and cl.company_name is distinct from inv.buyer->>'name' then ' (' || cl.company_name || ')' else '' end,
    coalesce(inv.site_location, q.site_location, 'not given'),
    concat_ws(' · ', inv.buyer->>'contactName', inv.buyer->>'phone', inv.buyer->>'email'));
  for r in select p.display_name, cp.phone, cp.email from client_contact cc join person p on p.id = cc.person_id left join contact_profile cp on cp.person_id = p.id
      where cc.client_id = inv.client_id order by cc.is_primary desc, p.display_name limit 8 loop
    t := t || format(E'Contact: %s\n', concat_ws(' · ', r.display_name, r.phone, r.email));
  end loop;
  if q.id is not null then t := t || format(E'Accepted version: %s V%s · /erp/documents/%s\n', q.number, coalesce(inv.source_revision, q.revision, 0) + 1, q.id); end if;
  t := t || format(E'Invoice: %s · ₹%s · /erp/documents/%s\n', coalesce(inv.number, 'draft'), to_char(inv.total / 100.0, 'FM99,99,99,99,990'), inv.id);
  for r in select p.id, p.received_on, p.amount, p.method, p.reference, exists(select 1 from erp_payment_file f where f.payment_id = p.id) proof
      from erp_payment p where p.document_id = inv.id and p.voided_at is null order by p.received_on, p.created_at loop
    t := t || format(E'Payment: ₹%s on %s by %s%s%s\n', to_char(r.amount / 100.0, 'FM99,99,99,99,990'), to_char(r.received_on, 'DD Mon YYYY'), upper(r.method),
      case when r.reference <> '' then ', ref ' || r.reference else '' end, case when r.proof then ' · proof /api/v0/erp/payments/' || r.id || '/proof' else '' end);
  end loop;
  t := t || E'\nSold (the scope):\n';
  for r in select l.description, l.qty, l.rate, l.unit, it.kind, it.id item_id from erp_line l left join erp_item it on it.id = l.item_id
      where l.document_id = coalesce(q.id, inv.id) and l.parent_position is null and not coalesce(l.not_needed, false) order by l.position loop
    t := t || format(E'- %s × %s%s\n', r.description, trim(to_char(r.qty, 'FM999990.###')), coalesce(' ' || r.unit, ''));
    if r.kind = 'package' then
      t := t || coalesce((select string_agg(format(E'    · %s%s', pp.label, case when cardinality(pp.deliverables) > 0 then ': ' || array_to_string(pp.deliverables, ', ') else '' end), E'\n' order by pp.position)
        from erp_package_part pp where pp.package_id = r.item_id), '') || E'\n';
    end if;
  end loop;
  return t || format(E'\nSold by: %s', coalesce(sp, 'not named'));
end $$;

-- Who should run the project: the client's earlier PGS, else the growth strategists with the least load.
create function pulse.project_pgs_suggest(p_project uuid) returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  with pr as (select * from project where org_id = current_org() and id = p_project),
  cfg as (select coalesce((erp_flow_step('handover')->>'pgsHealthy')::int, 7) healthy, coalesce((erp_flow_step('handover')->>'pgsMax')::int, 8) cap),
  load as (select x.lead_person_id id, count(*)::int n from project x where x.org_id = current_org() and x.kind = 'client_work' and x.status in ('onboarding', 'active')
    and x.deleted_at is null and x.lead_person_id is not null group by 1),
  roles as (select coalesce((select t.definition->'bandwidth'->>'role' from delivery_template t where t.org_id = current_org() order by t.key limit 1), 'pgs') r),
  history as (select distinct on (x.lead_person_id) x.lead_person_id id, coalesce(x.title, x.name) title, x.registry_no from project x, pr
    join person p on p.org_id = pr.org_id where x.org_id = current_org() and x.client_id = pr.client_id and x.id <> pr.id and x.lead_person_id = p.id
    and p.status = 'active' and p.side = 'staff' and x.deleted_at is null order by x.lead_person_id, x.registry_no desc),
  pool as (select p.id, p.display_name name, pp.pod, coalesce(l.n, 0) n, 1 rank, format('Ran %s for this client', h.title) why
      from history h join person p on p.id = h.id left join people_profile pp on pp.person_id = p.id left join load l on l.id = p.id
    union all
    select p.id, p.display_name, pp.pod, coalesce(l.n, 0), 2, format('%s active project%s (healthy up to %s, at most %s)', coalesce(l.n, 0), case when coalesce(l.n, 0) = 1 then '' else 's' end, cfg.healthy, cfg.cap)
      from person p cross join cfg cross join roles left join people_profile pp on pp.person_id = p.id left join load l on l.id = p.id
      where p.org_id = current_org() and p.side = 'staff' and p.status = 'active' and coalesce(l.n, 0) < cfg.cap
        and exists(select 1 from role_assignment ra where ra.org_id = p.org_id and ra.person_id = p.id and ra.role_key in (roles.r, 'pgs', 'head_pgs')
          and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity')))
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'pod', pod, 'load', n, 'why', why) order by rank, n, name), '[]'::jsonb)
  from (select distinct on (id) * from pool order by id, rank) s
$$;

-- A person confirms the PGS: 1471's assignment, then the PGS heads the project, joins it, the project takes their pod,
-- and the handover is theirs (they are told by 1471's notice).
create function pulse.project_assign_pgs(p_project uuid, p_pgs uuid, p_category text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r jsonb; pod text; u uuid;
begin
  r := project_assign(p_project, p_pgs, p_category);
  insert into project_member(org_id, project_id, person_id, role, added_by)
    select current_org(), p_project, p_pgs, 'member', current_viewer()
    where not exists(select 1 from project_member m where m.project_id = p_project and m.person_id = p_pgs and m.left_at is null);
  pod := (select pp.pod from people_profile pp where pp.person_id = p_pgs);
  u := (select x.id from unit x where x.org_id = current_org() and x.kind = 'pod' and x.name = pod and x.valid_to is null limit 1);
  if u is not null then update project set unit_id = u where id = p_project and unit_id is null; end if;
  update task set assignee_person_id = p_pgs, assigned_at = now(), updated_at = now()
    where org_id = current_org() and project_id = p_project and source = 'handover' and deleted_at is null and status = 'open';
  return r || jsonb_build_object('pod', pod);
end $$;
revoke all on function pulse.erp_handover_text(uuid), pulse.project_pgs_suggest(uuid), pulse.project_assign_pgs(uuid, uuid, text) from public;
grant execute on function pulse.project_pgs_suggest(uuid), pulse.project_assign_pgs(uuid, uuid, text) to pulse_api;

-- At the project's start (1471 logs 'project_started'): the handover task and the gap tasks. At a paid add-on for a
-- client whose project is live (1471 logs 'project_offered' with reason 'live'): its lines join that project.
create function pulse.erp_handover_follow() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
declare inv erp_document; q erp_document; pid uuid; st jsonb := erp_flow_step('handover'); g jsonb; sp uuid; nm text; n int := 0; ln record; lead uuid; tid uuid;
begin
  if new.kind not in ('project_started', 'project_offered') or new.subject_type <> 'document' then return null; end if;
  if new.kind = 'project_offered' and coalesce(new.detail->>'reason', '') <> 'live' then return null; end if;
  if not coalesce((st->>'on')::boolean, true) then return null; end if;
  select * into inv from erp_document where id = new.subject_id;
  pid := (new.detail->>'projectId')::uuid;
  if inv.id is null or pid is null then return null; end if;
  select x.* into q from erp_document x where x.id = inv.source_id and x.doc_type = 'quotation';
  nm := coalesce(inv.buyer->>'name', 'the client');
  if new.kind = 'project_offered' and not coalesce((st->>'addOns')::boolean, false) then return null; end if;
  if new.kind = 'project_started' then
    if coalesce((st->>'brief')::boolean, false) then
    insert into task(org_id, project_id, title, created_by, created_at, source, source_ref, source_key, notes, status)
      values (new.org_id, pid, left(format('Handover: %s%s', nm, case when q.id is not null then format(' · %s V%s', q.number, coalesce(inv.source_revision, q.revision, 0) + 1) else '' end), 300),
        new.actor, now(), 'handover', inv.id::text, 'handover:' || inv.id, left(erp_handover_text(inv.id), 20000), 'open')
      on conflict (org_id, source_key) do nothing;
    end if;
    -- The deal's missing commitments: a named task for the salesperson each, never a blocker.
    sp := coalesce(q.salesperson_id, inv.salesperson_id, q.created_by, inv.created_by);
    if sp is not null and jsonb_array_length(coalesce(st->'gaps', '[]'::jsonb)) > 0 then
      for g in select * from jsonb_array_elements(coalesce(st->'gaps', '[]'::jsonb)) loop
        continue when coalesce(q.reference, '{}'::jsonb)->'commitments' ? (g->>'key');
        insert into task(org_id, project_id, title, created_by, created_at, source, source_ref, source_key, assignee_person_id, assigned_at, status)
          values (new.org_id, pid, left(format('%s (%s)', g->>'label', nm), 300), new.actor, now(), 'gap', inv.id::text, format('gap:%s:%s', inv.id, g->>'key'), sp, now(), 'open')
          on conflict (org_id, source_key) do nothing returning id into tid;
        if tid is not null then n := n + 1; tid := null; end if;
      end loop;
      if coalesce(btrim(q.notes), '') <> '' then
        insert into task(org_id, project_id, title, created_by, created_at, source, source_ref, source_key, notes, assignee_person_id, assigned_at, status)
          values (new.org_id, pid, left(format('Confirm the promise noted on the deal (%s)', nm), 300), new.actor, now(), 'gap', inv.id::text, format('gap:%s:promise', inv.id),
            left(q.notes, 2000), sp, now(), 'open') on conflict (org_id, source_key) do nothing returning id into tid;
        if tid is not null then n := n + 1; end if;
      end if;
      if n > 0 then perform work_notify(sp, 'project.added', 'project', pid, 'project.gaps:' || pid || ':' || sp,
        left(format('%s to confirm for %s: the project started without them', n, nm), 160), '/tasks/projects/' || pid, 'task'); end if;
    end if;
    perform erp_log('document', inv.id, 'handover', jsonb_build_object('projectId', pid, 'gaps', n));
  else
    -- An add-on: its lines become the live project's new scope; one project per client, never a second.
    insert into project_quote(org_id, document_id, project_id, linked_by) values (new.org_id, inv.id, pid, new.actor) on conflict do nothing;
    for ln in select l.* from erp_line l where l.document_id = coalesce(q.id, inv.id) and l.parent_position is null and not coalesce(l.not_needed, false) order by l.position loop
      insert into task(org_id, project_id, title, created_by, created_at, source, source_ref, source_key, notes, status)
        values (new.org_id, pid, left(btrim(ln.description), 300), new.actor, now(), 'quote', ln.id::text, format('addon:%s', ln.id), nullif(left(coalesce(ln.details, ''), 20000), ''), 'open')
        on conflict (org_id, source_key) do nothing returning id into tid;
      if tid is not null then n := n + 1; tid := null; end if;
    end loop;
    lead := (select lead_person_id from project where id = pid);
    if lead is not null then
      perform work_notify(lead, 'project.added', 'project', pid, 'project.scope:' || pid || ':' || inv.id, left(format('Scope added to %s: %s line%s from %s', nm, n, case when n = 1 then '' else 's' end, coalesce(inv.number, 'an invoice')), 160),
        '/tasks/projects/' || pid, 'task');
    else
      perform work_notify(h, 'project.added', 'project', pid, 'project.scope:' || pid || ':' || inv.id || ':' || h, left(format('Scope added to %s: %s line%s from %s', nm, n, case when n = 1 then '' else 's' end, coalesce(inv.number, 'an invoice')), 160),
        '/tasks/projects/' || pid, 'task') from unnest(project_heads()) h;
    end if;
    perform erp_log('document', inv.id, 'project_scope_added', jsonb_build_object('projectId', pid, 'tasks', n));
  end if;
  return null;
end $$;
revoke all on function pulse.erp_handover_follow() from public;
create trigger erp_handover_follow after insert on pulse.erp_event for each row execute function pulse.erp_handover_follow();

-- The handover follows the money: each later payment and each proof (uploaded just after its payment) refreshes it.
create function pulse.erp_handover_refresh() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  update task set notes = left(erp_handover_text(new.document_id), 20000), updated_at = now()
    where org_id = new.org_id and source_key = 'handover:' || new.document_id and deleted_at is null;
  return null;
end $$;
revoke all on function pulse.erp_handover_refresh() from public;
create trigger erp_handover_refresh after insert on pulse.erp_payment for each row execute function pulse.erp_handover_refresh();
create trigger erp_handover_refresh after insert on pulse.erp_payment_file for each row execute function pulse.erp_handover_refresh();

-- migrate:down
-- Forward-only: the handover and gap tasks are the projects' own.
