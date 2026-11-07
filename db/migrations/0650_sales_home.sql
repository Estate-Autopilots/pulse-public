-- migrate:up
-- EST-1240: the sales home's summary, for the signed-in person only. One security-definer read, so a salesperson needs
-- no ERP grant and no finance-wide query runs:
--   * urgent: their own open tasks that need attention now (overdue, due today, or marked high/urgent), calls left out;
--   * calls: their own call tasks due by the end of today. A call is known by its record, never by its title: the
--     quotation follow-up task (task.source = 'quote_followup', 0520) or an enquiry's follow-up task (the enquiry's
--     body.taskId, 0059);
--   * quotes: the five quotations they most recently changed hands on, where they are the salesperson as
--     erp_followup_person decides it (the quotation's salesperson, else who sent it, else who made it).
-- The organisation and the person come from the session, never from the caller. Days and the greeting follow the
-- company's own time zone. Read only; nothing is stored.
create function pulse.sales_home_summary(p_section text default 'all') returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare
  me uuid := current_viewer();
  org uuid := current_org();
  tz text := org_time_zone();
  local_now timestamp := now() at time zone org_time_zone();
  today date := (now() at time zone org_time_zone())::date;
  result jsonb;
begin
  if me is null or org is null then
    raise exception 'A sales home belongs to a staff person' using errcode = '42501';
  end if;
  if p_section is null or p_section not in ('all', 'urgent', 'calls', 'quotes') then
    raise exception 'Choose urgent, calls or quotes' using errcode = '22023';
  end if;
  result := jsonb_build_object('today', today::text,
    'greeting', case when extract(hour from local_now) < 12 then 'morning' when extract(hour from local_now) < 17 then 'afternoon' else 'evening' end);

  if p_section in ('all', 'urgent', 'calls') then
    with enquiry_task as (
      select e.body ->> 'taskId' task_id from pulse_priv.acq_enquiry e where e.org_id = org and e.body ? 'taskId'
    ), mine as (
      select t.id, t.title, t.status, t.due_at,
        case when t.priority = 'urgent' then 'urgent' when t.priority = 'high' or t.urgency = 'high' then 'high' else 'normal' end priority,
        coalesce(t.work_on, (t.due_at at time zone tz)::date,
          case when t.due_label ~ '^\d{4}-\d{2}-\d{2}$' then t.due_label::date end) due_on,
        case when t.source = 'quote_followup' then 'quotation'
             when exists (select 1 from enquiry_task q where q.task_id = t.id::text) then 'enquiry' end call
      from task t
      where t.org_id = org and t.assignee_person_id = me and t.deleted_at is null and t.status in ('open', 'in_progress', 'blocked')
    ), urgent as (
      select * from mine where call is null and (due_on <= today or priority <> 'normal')
    ), calls as (
      select * from mine where call is not null and due_on <= today
    )
    select result
      || case when p_section in ('all', 'urgent') then jsonb_build_object('urgent', jsonb_build_object(
           'total', (select count(*) from urgent),
           'items', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'title', u.title, 'status', u.status, 'priority', u.priority,
               'dueOn', u.due_on::text, 'overdue', coalesce(u.due_on < today, false)) order by u.ord)
             from (select x.*, row_number() over (order by x.due_on nulls last,
                     case x.priority when 'urgent' then 0 when 'high' then 1 else 2 end, x.title, x.id) ord from urgent x) u where u.ord <= 10), '[]'::jsonb)))
         else '{}'::jsonb end
      || case when p_section in ('all', 'calls') then jsonb_build_object('calls', jsonb_build_object(
           'total', (select count(*) from calls),
           'items', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'title', k.title, 'kind', k.call, 'status', k.status,
               'dueOn', k.due_on::text, 'at', case when k.due_on = today then k.due_at end, 'overdue', k.due_on < today) order by k.ord)
             from (select x.*, row_number() over (order by x.due_on, x.due_at nulls last, x.title, x.id) ord from calls x) k where k.ord <= 10), '[]'::jsonb)))
         else '{}'::jsonb end
      into result;
  end if;

  if p_section in ('all', 'quotes') then
    select result || jsonb_build_object('quotes', jsonb_build_object('canOpenErp', erp_can(false),
      'items', coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'number', q.number, 'status', q.status, 'total', q.total::float8,
        'buyer', q.buyer, 'updatedAt', q.updated_at, 'ownerApprovalNeeded', coalesce(q.owner_approval = 'needed', false)) order by q.updated_at desc, q.id), '[]'::jsonb)))
      into result
    from (
      select d.id, d.number, d.status, d.total, d.updated_at, d.owner_approval,
        coalesce(nullif(btrim(d.buyer ->> 'name'), ''), c.display_name) buyer
      from erp_document d left join client c on c.org_id = d.org_id and c.id = d.client_id
      where d.org_id = org and d.doc_type = 'quotation' and d.status <> 'cancelled'
        and me in (d.salesperson_id, d.sent_by, d.created_by) and erp_followup_person(d) = me
      order by d.updated_at desc, d.id
      limit 5
    ) q;
  end if;
  return result;
end $$;
revoke all on function pulse.sales_home_summary(text) from public;
grant execute on function pulse.sales_home_summary(text) to pulse_api;

-- migrate:down
-- Forward-only. Nothing is stored; dropping the function removes the summary.
