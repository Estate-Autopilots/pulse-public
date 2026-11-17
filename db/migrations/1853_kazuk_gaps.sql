-- migrate:up
-- KAZUK-GAPS (6 Nov 2026): the gaps promised to Kazuk (Replit screen 4, meeting backlog A12 and A19).
--  1. pulse.form_draft: a person's unfinished form (a quotation's unsaved changes, a new project), kept on the server so
--     "Resume where you left off" works on any device. Each person sees and writes only their own rows.
--  2. pulse.money_at_risk(): the CEO screen's money at risk: overdue invoices, work that is due or accepted but not
--     billed, and quotations above a threshold with no answer for some days, each with its amount and age.
--     Billing readers only (erp_can); anyone else gets null and the screen says so.
--  3. pulse.cs_alerts_today(): client-service issues raised today (a client's request, change, question or problem from
--     the client space, and blocks opened today on a client's project), for leadership and HR.
--  4. pulse.sales_pipeline(): a salesperson's dashboard: their quotations by stage, follow-ups due, won and lost this
--     month and the value still waiting for an answer. Another person's is for leadership and Finance (as sales_numbers).

create table pulse.form_draft (
  org_id      uuid not null references pulse.org(id),
  person_id   uuid not null references pulse.person(id) on delete cascade,
  key         text not null check (key ~ '^[a-z][a-z0-9-]{1,80}$'),
  title       text not null check (length(btrim(title)) between 1 and 160 and title !~ '[[:cntrl:]]'),
  href        text not null check (href ~ '^/[A-Za-z0-9/_?=&%.:-]*$' and length(href) <= 301 and href !~ '^//'),
  data        jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 65536),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (org_id, person_id, key)
);
create index form_draft_recent on pulse.form_draft(org_id, person_id, updated_at desc);
alter table pulse.form_draft enable row level security;
alter table pulse.form_draft force row level security;
create policy tenant on pulse.form_draft using (org_id = pulse.current_org() and person_id = pulse.current_viewer())
  with check (org_id = pulse.current_org() and person_id = pulse.current_viewer());
-- The screens keep, read, replace and forget a draft (kazuk-gaps.ts); row security above keeps each to its own person.
grant select, insert, update, delete on pulse.form_draft to pulse_api;

create function pulse.money_at_risk(p_stall_days int default 7, p_min bigint default 2500000) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare org uuid := current_org(); today date := (now() at time zone org_time_zone())::date; result jsonb;
begin
  if current_viewer() is null or not erp_can(false) then return null; end if;
  if p_stall_days is null or p_stall_days not between 1 and 90 or p_min is null or p_min not between 0 and 100000000000 then
    raise exception 'Choose 1 to 90 days and an amount from zero' using errcode = '22023'; end if;
  with overdue as (
    select d.id, d.number, coalesce(nullif(btrim(d.buyer ->> 'name'), ''), c.display_name) buyer, (u.base_due + u.gst_due) amount, today - d.due_date age
    from finance_invoice_due() u join erp_document d on d.id = u.document_id left join client c on c.org_id = d.org_id and c.id = d.client_id
    where d.org_id = org and u.base_due + u.gst_due > 0 and d.due_date < today
  ), billed as (   -- an invoice or proforma made from a document (not a draft, not cancelled)
    select x.source_id id from erp_document x where x.org_id = org and x.doc_type in ('invoice', 'proforma') and x.status not in ('draft', 'cancelled') and x.source_id is not null
  ), unbilled as (
    select m.id, null::text number, coalesce(p.title, p.name, e.name) || ' · ' || m.label buyer, m.amount, today - m.due_on age, 'milestone' why, e.project_id project
    from erp_milestone m join erp_engagement e on e.id = m.engagement_id and e.org_id = org and e.status = 'active'
      left join project p on p.id = e.project_id left join erp_document md on md.id = m.document_id
    where m.org_id = org and m.due_on <= today and m.amount > 0 and (m.document_id is null or md.status in ('draft', 'cancelled'))
    union all
    select d.id, d.number, coalesce(nullif(btrim(d.buyer ->> 'name'), ''), c.display_name), d.total, today - (d.updated_at at time zone org_time_zone())::date, 'accepted', d.project_id
    from erp_document d left join client c on c.org_id = d.org_id and c.id = d.client_id
    where d.org_id = org and d.doc_type = 'quotation' and d.status = 'accepted' and d.total > 0 and d.id not in (select id from billed)
  ), stalled as (
    select d.id, d.number, coalesce(nullif(btrim(d.buyer ->> 'name'), ''), c.display_name) buyer, d.total amount,
      today - (greatest(d.issued_at, d.sent_at, d.updated_at) at time zone org_time_zone())::date age
    from erp_document d left join client c on c.org_id = d.org_id and c.id = d.client_id
    where d.org_id = org and d.doc_type = 'quotation' and d.status in ('issued', 'sent') and d.total >= p_min
      and today - (greatest(d.issued_at, d.sent_at, d.updated_at) at time zone org_time_zone())::date >= p_stall_days
  )
  select jsonb_build_object('today', today::text, 'stallDays', p_stall_days, 'atLeast', p_min,
    'overdue', jsonb_build_object('count', (select count(*) from overdue), 'amount', (select coalesce(sum(amount), 0) from overdue),
      'items', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'number', number, 'buyer', buyer, 'amount', amount, 'age', age) order by amount desc, age desc), '[]')
        from (select * from overdue order by amount desc, age desc limit 5) x)),
    'unbilled', jsonb_build_object('count', (select count(*) from unbilled), 'amount', (select coalesce(sum(amount), 0) from unbilled),
      'items', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'number', number, 'buyer', buyer, 'amount', amount, 'age', age, 'why', why, 'projectId', project) order by amount desc, age desc), '[]')
        from (select * from unbilled order by amount desc, age desc limit 5) x)),
    'stalled', jsonb_build_object('count', (select count(*) from stalled), 'amount', (select coalesce(sum(amount), 0) from stalled),
      'items', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'number', number, 'buyer', buyer, 'amount', amount, 'age', age) order by amount desc, age desc), '[]')
        from (select * from stalled order by amount desc, age desc limit 5) x))
  ) into result;
  return result;
end $$;

create function pulse.cs_alerts_today() returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare org uuid := current_org(); tz text := org_time_zone(); today date := (now() at time zone org_time_zone())::date;
begin
  if current_viewer() is null or coalesce(work_role(), '') not in ('leadership', 'hr') then
    raise exception 'Client-service alerts are for leadership' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(x order by x ->> 'at' desc), '[]') from (
    select jsonb_build_object('id', r.id, 'kind', r.kind, 'title', r.title, 'client', c.display_name, 'clientId', r.client_id, 'taskId', r.task_id,
      'projectId', t.project_id, 'at', r.created_at) x
    from client_request r left join client c on c.org_id = r.org_id and c.id = r.client_id left join task t on t.org_id = r.org_id and t.id = r.task_id
    where r.org_id = org and (r.created_at at time zone tz)::date = today
    union all
    select jsonb_build_object('id', b.id, 'kind', 'blocked', 'title', coalesce(t.title, b.blocker_key), 'client', c.display_name, 'clientId', p.client_id, 'taskId', b.task_id,
      'projectId', b.project_id, 'at', b.opened_at)
    from blocker b join project p on p.org_id = b.org_id and p.id = b.project_id and p.client_id is not null and p.deleted_at is null
      left join client c on c.org_id = p.org_id and c.id = p.client_id left join task t on t.org_id = b.org_id and t.id = b.task_id
    where b.org_id = org and b.closed_at is null and (b.opened_at at time zone tz)::date = today
    order by 1 limit 40) s);
end $$;

create function pulse.sales_pipeline(p_person uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); org uuid := current_org(); tz text := org_time_zone(); today date := (now() at time zone org_time_zone())::date;
  who uuid := coalesce(p_person, current_viewer()); month0 date := date_trunc('month', (now() at time zone org_time_zone()))::date; nm text; result jsonb;
begin
  if me is null or not exists(select 1 from person where org_id = org and id = me and side = 'staff') then
    raise exception 'A sales dashboard belongs to a staff person' using errcode = '42501'; end if;
  if who <> me and not erp_can(false) then raise exception 'Only leadership and Finance see another person''s sales' using errcode = '42501'; end if;
  select display_name into nm from person where org_id = org and id = who and side = 'staff';
  if nm is null then raise exception 'Person not found' using errcode = 'P0002'; end if;
  with q as (
    select d.*, case when d.status = 'draft' and d.owner_approval = 'needed' then 'approval' when d.status = 'draft' then 'draft'
        when d.status in ('issued', 'sent') then 'sent' when d.status = 'accepted' then 'won' when d.status = 'converted' then 'invoiced' else d.status end stage,
      case when d.decision ->> 'at' ~ '^\d{4}-\d{2}-\d{2}' then left(d.decision ->> 'at', 10)::date else (d.updated_at at time zone tz)::date end decided
    from erp_document d where d.org_id = org and d.doc_type = 'quotation' and d.status <> 'cancelled' and erp_salesperson(d) = who
  ), f as (
    select t.id, t.title, coalesce(t.work_on, (t.due_at at time zone tz)::date) due_on
    from task t where t.org_id = org and t.assignee_person_id = who and t.deleted_at is null and t.source = 'quote_followup' and t.status in ('open', 'in_progress', 'blocked')
  )
  select jsonb_build_object('person', jsonb_build_object('id', who, 'name', nm, 'self', who = me), 'today', today::text, 'month', to_char(month0, 'YYYY-MM'),
    'stages', (select jsonb_agg(jsonb_build_object('key', s, 'count', (select count(*) from q where stage = s), 'value', (select coalesce(sum(taxable), 0) from q where stage = s)) order by n)
      from unnest(array['draft', 'approval', 'sent', 'won']) with ordinality u(s, n)),
    'pipeline', jsonb_build_object('count', (select count(*) from q where stage = 'sent'), 'value', (select coalesce(sum(taxable), 0) from q where stage = 'sent'),
      'oldest', (select max(today - coalesce(issue_date, today)) from q where stage = 'sent')),
    'won', jsonb_build_object('count', (select count(*) from q where stage in ('won', 'invoiced') and decided >= month0), 'value', (select coalesce(sum(taxable), 0) from q where stage in ('won', 'invoiced') and decided >= month0)),
    'lost', jsonb_build_object('count', (select count(*) from q where status = 'declined' and decided >= month0), 'value', (select coalesce(sum(taxable), 0) from q where status = 'declined' and decided >= month0)),
    'followUps', jsonb_build_object('due', (select count(*) from f where due_on <= today), 'week', (select count(*) from f where due_on > today and due_on <= today + 7),
      'items', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'dueOn', due_on::text, 'overdue', due_on < today) order by due_on nulls last, title), '[]')
        from (select * from f where due_on <= today + 7 or due_on is null order by due_on nulls last, title limit 8) x))
  ) into result;
  return result;
end $$;

revoke all on function pulse.money_at_risk(int, bigint), pulse.cs_alerts_today(), pulse.sales_pipeline(uuid) from public;
grant execute on function pulse.money_at_risk(int, bigint), pulse.cs_alerts_today(), pulse.sales_pipeline(uuid) to pulse_api;

-- migrate:down
-- Forward-only: drafts people saved are kept; the three functions only read.
