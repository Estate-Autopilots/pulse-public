-- migrate:up
-- KAZUK-REST (6 Nov 2026; Kazuk, 3 Nov meeting, backlog A19: "a salesperson dashboard with leads and calls"). My sales
-- already shows the person's quotations, invoices and collections (FINANCE-TRUTH). pulse.sales_desk() adds what a
-- salesperson works from each day, for one person:
--   leads     their leads from Pulse (enquiries they own) and from Sales X-Ray (XRAY-LINK's mirror, leads whose Sales X-Ray
--             owner is this person), counted by stage (the lead pipeline) with the newest few;
--   calls     their calls of the last 14 days from Sales X-Ray (title, length, score and the outcome its analysis gave),
--             and the call tasks they finished in that time;
--   today     follow-ups due today or missed (a quotation's or an enquiry's call task, as the sales home knows them);
--   approval  their quotations waiting for approval (sent to an approver, or a price the owner approves), and the drafts
--             others sent this person to approve. Only when the company's sales flow (pulse.erp_flow, 1671) has an
--             approval at all (the approve or the price step on): with none (the EA preset) approval.on is false and both
--             lists are empty, and My sales shows no approval panel.
-- Another person's desk is for leadership and Finance (erp_can), as sales_numbers. Reads only; no new table.

create function pulse.sales_desk(p_person uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); org uuid := current_org(); tz text := org_time_zone(); today date := (now() at time zone org_time_zone())::date;
  who uuid := coalesce(p_person, current_viewer()); nm text; result jsonb;
  appr boolean := coalesce((erp_flow_step('approve') ->> 'on')::boolean, false) or coalesce((erp_flow_step('price') ->> 'on')::boolean, true);
begin
  if me is null or not exists(select 1 from person where org_id = org and id = me and side = 'staff') then
    raise exception 'A sales desk belongs to a staff person' using errcode = '42501'; end if;
  if who <> me and not erp_can(false) then raise exception 'Only leadership and Finance see another person''s sales' using errcode = '42501'; end if;
  select display_name into nm from person where org_id = org and id = who and side = 'staff';
  if nm is null then raise exception 'Person not found' using errcode = 'P0002'; end if;
  with lead_rows as (
    select l.sx_lead_id::text id, l.name, l.company, lower(coalesce(nullif(btrim(l.stage), ''), 'new')) stage, l.stage_label label, 'xray' source,
      coalesce(l.sx_created_at, l.seen_at) at, l.client_id
    from sales_xray_lead l where l.org_id = org and l.gone_at is null and lower(btrim(l.owner_name)) = lower(btrim(nm))
    union all
    select e.id::text, coalesce(nullif(btrim(e.body ->> 'name'), ''), nullif(btrim(e.body ->> 'fullName'), ''), 'Enquiry'), nullif(btrim(e.body ->> 'company'), ''),
      lower(coalesce((select s.stage from pulse_priv.acq_stage s where s.org_id = org and s.enquiry_id = e.id order by s.effective desc, s.recorded desc limit 1), 'new')), null, 'pulse',
      e.occurred, null::uuid
    from pulse_priv.acq_enquiry e where e.org_id = org and e.owner_id = who and not e.withdrawn
  ), stage_order(stage, n) as (values ('new', 1), ('contacted', 2), ('qualified', 3), ('proposal', 4), ('negotiation', 5), ('won', 6), ('lost', 7))
  , calls as (
    select x.id, x.title, x.call_at, x.duration_seconds, x.status, x.client_id, x.summary
    from sales_xray_call x where x.org_id = org and (x.person_id = who or (x.person_id is null and x.linked_by = who)) and coalesce(x.call_at, x.linked_at) >= now() - interval '14 days'
  ), tasks as (
    select t.id, t.title, t.status, coalesce(t.work_on, (t.due_at at time zone tz)::date) due_on, t.updated_at,
      case when t.source = 'quote_followup' then 'quotation' when exists(select 1 from pulse_priv.acq_enquiry e where e.org_id = org and e.body ->> 'taskId' = t.id::text) then 'enquiry' end call
    from task t where t.org_id = org and t.assignee_person_id = who and t.deleted_at is null
  ), q as (
    select d.id, d.number, coalesce(nullif(btrim(d.buyer ->> 'name'), ''), c.display_name) buyer, d.taxable, d.approval_to, d.approval_asked_by, d.approval_asked_at, d.owner_approval,
      erp_salesperson(d) sp, d.updated_at
    from erp_document d left join client c on c.org_id = d.org_id and c.id = d.client_id
    where d.org_id = org and d.doc_type = 'quotation' and d.status = 'draft'
  )
  select jsonb_build_object('person', jsonb_build_object('id', who, 'name', nm, 'self', who = me), 'asOf', today::text,
    'leads', jsonb_build_object('count', (select count(*) from lead_rows),
      'stages', (select coalesce(jsonb_agg(jsonb_build_object('stage', s.stage, 'label', s.label, 'count', s.n) order by coalesce(o.n, 50), s.stage), '[]')
        from (select stage, max(label) label, count(*) n from lead_rows group by stage) s left join stage_order o on o.stage = s.stage),
      'xray', (select count(*) from lead_rows where source = 'xray'), 'pulse', (select count(*) from lead_rows where source = 'pulse'),
      'items', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'company', company, 'stage', stage, 'label', label, 'source', source, 'at', at, 'clientId', client_id)
        order by at desc nulls last), '[]') from (select * from lead_rows where stage not in ('won', 'lost') order by at desc nulls last limit 8) x)),
    'calls', jsonb_build_object('count', (select count(*) from calls), 'minutes', (select coalesce(sum(duration_seconds), 0) / 60 from calls),
      'tasksDone', (select count(*) from tasks where call is not null and status = 'done' and updated_at >= now() - interval '14 days'),
      'items', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', coalesce(title, 'Call'), 'at', call_at, 'seconds', duration_seconds, 'status', status, 'clientId', client_id,
          'score', case when summary ->> 'score' ~ '^\d+(\.\d+)?$' then (summary ->> 'score')::numeric end,
          'outcome', left(coalesce(nullif(btrim(summary ->> 'outcome'), ''), nullif(btrim(summary ->> 'summary'), '')), 160)) order by call_at desc nulls last), '[]')
        from (select * from calls order by call_at desc nulls last limit 6) x)),
    'today', jsonb_build_object('due', (select count(*) from tasks where call is not null and status in ('open', 'in_progress', 'blocked') and due_on <= today),
      'items', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'dueOn', due_on::text, 'overdue', due_on < today, 'kind', call) order by due_on, title), '[]')
        from (select * from tasks where call is not null and status in ('open', 'in_progress', 'blocked') and due_on <= today order by due_on, title limit 8) x)),
    'approval', jsonb_build_object('on', appr,
      'waiting', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'number', number, 'buyer', buyer, 'taxable', taxable, 'at', coalesce(approval_asked_at, updated_at),
          'to', (select display_name from person where id = approval_to), 'owner', owner_approval = 'needed') order by coalesce(approval_asked_at, updated_at) desc), '[]')
        from (select * from q where appr and (approval_asked_by = who or (approval_asked_by is null and sp = who)) and (approval_to is not null or owner_approval = 'needed') limit 8) x),
      'forMe', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'number', number, 'buyer', buyer, 'taxable', taxable, 'at', approval_asked_at,
          'by', (select display_name from person where id = approval_asked_by)) order by approval_asked_at desc), '[]')
        from (select * from q where appr and approval_to = who limit 8) x))
  ) into result;
  return result;
end $$;
revoke all on function pulse.sales_desk(uuid) from public;
grant execute on function pulse.sales_desk(uuid) to pulse_api;

-- migrate:down
-- Forward-only: the function only reads.
