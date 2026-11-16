-- migrate:up
-- KAZUK-V2 G13 (Kazuk's sales flow, 6 Nov 2026, R41–R45, R56, R60): one salesperson home.
--  * Incentive per deal (R44, R60): Not due until the deal is Paid, then Pending until the Sales Head, leadership or
--    Finance marks it Released (pulse.sales_incentive, one row per released deal; pulse.sales_incentive_set). A
--    salesperson reads only their own deals' incentives; the team readers (pulse.sales_sees_team, 1930) read all.
--  * Neeti / Sales X-Ray numbers (R45): leads, call attempts, first-call time, setting calls, strategy sessions,
--    proposals, closes and lost reasons from the synced Sales X-Ray leads and calls (1040), with the last good sync.
--    A number Sales X-Ray never sent is null, and the screen says "Not recorded" (pulse.sales_neeti).
--  * Projects I sold (R42), read only: the projects a deal of theirs started or joined (project_quote, 1471), with the
--    PGS, how far the work is, what is next and the renewal date; one project's status the same way
--    (pulse.sales_sold_projects). Nothing here changes a project.
--  * The client group (R41, R56): when a deal's invoice is Paid, its salesperson joins the client's group
--    conversations (typed Client in the groups hub, for that client or its project; never a pod or team chat), and a
--    group typed as the client's later takes them in then. They read delivery updates there and do not become the PGS.
--  * pulse.sales_workspace(person): the deals list of the one home (status, value, incentive, project, client group).
-- Synthetic data only in tests; nothing here reads or writes production data.

create table pulse.sales_incentive (
  org_id uuid not null references pulse.org(id),
  document_id uuid not null references pulse.erp_document(id),
  released_on date not null,
  note text check (length(note) <= 300),
  released_by uuid references pulse.person(id),
  released_at timestamptz not null default now(),
  primary key (document_id));
create index sales_incentive_org on pulse.sales_incentive(org_id);
alter table pulse.sales_incentive enable row level security;
alter table pulse.sales_incentive force row level security;
create policy tenant on pulse.sales_incentive using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy sales_own on pulse.sales_incentive as restrictive for select to pulse_api using ((select pulse.sales_sees_team()) or pulse.erp_doc_mine(document_id));
grant select on pulse.sales_incentive to pulse_api;
comment on table pulse.sales_incentive is 'KAZUK-V2 G13 (9 Nov 2026): a deal whose sales incentive was released (Pending until then once Paid; Not due before)';

-- A deal's incentive: not_due, pending or released.
create function pulse.sales_incentive_status(p_doc uuid) returns text language sql stable security definer set search_path = pulse, pg_temp as $$
  select case when exists(select 1 from sales_incentive i where i.org_id = current_org() and i.document_id = p_doc) then 'released'
    when erp_deal_status(p_doc) = 'paid' then 'pending' else 'not_due' end
$$;

-- The Sales Head, leadership or Finance releases (or takes back) a paid deal's incentive.
create function pulse.sales_incentive_set(p_doc uuid, p_released boolean, p_note text default null) returns text
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare d erp_document;
begin
  if not viewer_is('sales_head', 'leadership', 'admin', 'finance') then
    raise exception 'Only the Sales Head, leadership or Finance release an incentive' using errcode = '42501'; end if;
  select * into d from erp_document where org_id = current_org() and id = p_doc;
  if d.id is null or d.doc_type <> 'quotation' then raise exception 'Deal not found' using errcode = 'P0002'; end if;
  if p_released then
    if erp_deal_status(p_doc) <> 'paid' then raise exception 'An incentive is released once the deal is Paid' using errcode = '22023'; end if;
    insert into sales_incentive(org_id, document_id, released_on, note, released_by)
      values (current_org(), p_doc, (now() at time zone org_time_zone())::date, nullif(left(btrim(coalesce(p_note, '')), 300), ''), current_viewer())
      on conflict (document_id) do nothing;
  else
    delete from sales_incentive where org_id = current_org() and document_id = p_doc;
  end if;
  perform erp_log('document', p_doc, case when p_released then 'incentive_released' else 'incentive_pending' end, jsonb_build_object('note', nullif(left(btrim(coalesce(p_note, '')), 300), '')));
  return sales_incentive_status(p_doc);
end $$;

-- Who is asking about whose sales: the viewer's own, or anyone's for the team readers.
create function pulse.sales_who(p_person uuid) returns uuid language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer();
begin
  if me is null or not exists(select 1 from person where org_id = current_org() and id = me and side = 'staff') then
    raise exception 'This belongs to a staff person' using errcode = '42501'; end if;
  if p_person is not null and p_person <> me and not sales_sees_team() then
    raise exception 'Only the Sales Head, leadership and Finance see another salesperson''s sales' using errcode = '42501'; end if;
  if p_person is not null and not exists(select 1 from person where org_id = current_org() and id = p_person and side = 'staff') then
    raise exception 'Person not found' using errcode = 'P0002'; end if;
  return coalesce(p_person, me);
end $$;

-- The projects a person's deals started or joined.
create function pulse.sales_sold_project_ids(p_person uuid) returns setof uuid language sql stable security definer set search_path = pulse, pg_temp as $$
  select distinct pq.project_id from project_quote pq join erp_document d on d.org_id = pq.org_id and d.id = pq.document_id
  where pq.org_id = current_org() and d.status <> 'cancelled' and erp_salesperson(d) = p_person
$$;

-- Projects I sold, read only (one project, with what was done and what is next, when p_project is given).
create function pulse.sales_sold_projects(p_person uuid default null, p_project uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare who uuid := sales_who(p_person); tz text := org_time_zone(); today date := (now() at time zone org_time_zone())::date; result jsonb;
begin
  if p_project is not null and p_project not in (select sales_sold_project_ids(who)) then
    raise exception 'This project was not sold by %', case when who = current_viewer() then 'you' else 'this person' end using errcode = '42501'; end if;
  with p as (
    select pr.*, c.display_name client, c.renewal_on, lp.display_name pgs from project pr
    left join client c on c.org_id = pr.org_id and c.id = pr.client_id left join person lp on lp.org_id = pr.org_id and lp.id = pr.lead_person_id
    where pr.org_id = current_org() and pr.id in (select sales_sold_project_ids(who)) and (p_project is null or pr.id = p_project)
  ), t as (
    select t.project_id, t.id, t.title, t.status, t.done_at, coalesce(t.work_on, (t.due_at at time zone tz)::date) due_on from task t
    where t.org_id = current_org() and t.project_id in (select id from p) and t.deleted_at is null and t.status <> 'cancelled'
  )
  select jsonb_build_object('person', jsonb_build_object('id', who, 'self', who = current_viewer()), 'today', today::text,
    'projects', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(nullif(btrim(p.title), ''), p.name), 'client', p.client, 'clientId', p.client_id,
      'status', p.status, 'pgs', p.pgs, 'category', p.client_category, 'renewalOn', p.renewal_on::text,
      'tasks', (select jsonb_build_object('total', count(*), 'done', count(*) filter (where status = 'done'),
        'overdue', count(*) filter (where status <> 'done' and due_on < today)) from t where t.project_id = p.id),
      'next', (select jsonb_build_object('title', title, 'dueOn', due_on::text) from t where t.project_id = p.id and status <> 'done' order by due_on nulls last, title limit 1),
      'clientGroup', exists(select 1 from pulse_priv.sales_client_group g join chat_member m on m.channel_id = g.channel_id and m.person_id = who
        where g.org_id = current_org() and (g.client_id = p.client_id or g.project_id = p.id)),
      'recent', case when p_project is not null then (select coalesce(jsonb_agg(jsonb_build_object('title', title, 'at', done_at) order by done_at desc), '[]')
        from (select * from t where t.project_id = p.id and status = 'done' and done_at is not null order by done_at desc limit 6) x) end,
      'upcoming', case when p_project is not null then (select coalesce(jsonb_agg(jsonb_build_object('title', title, 'dueOn', due_on::text, 'late', due_on < today) order by due_on nulls last), '[]')
        from (select * from t where t.project_id = p.id and status <> 'done' order by due_on nulls last, title limit 6) x) end
    ) order by p.status = 'done', p.name), '[]') from p)
  ) into result;
  return result;
end $$;

-- Neeti / Sales X-Ray numbers for a person and a period; null where Sales X-Ray sent nothing ("Not recorded").
create function pulse.sales_neeti(p_person uuid default null, p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare who uuid := sales_who(p_person); org uuid := current_org(); nm text; s sales_xray_sync; result jsonb;
  f date := date_trunc('month', coalesce(p_from, (now() at time zone org_time_zone())::date))::date;
  t date := (date_trunc('month', coalesce(p_to, p_from, (now() at time zone org_time_zone())::date)) + interval '1 month -1 day')::date;
begin
  select display_name into nm from person where org_id = org and id = who;
  select * into s from sales_xray_sync where org_id = org;
  with l as (select * from sales_xray_lead where org_id = org and gone_at is null and lower(btrim(owner_name)) = lower(btrim(nm))),
  lp as (select * from l where coalesce(sx_created_at, seen_at) >= f and coalesce(sx_created_at, seen_at) < t + 1),
  c as (select * from sales_xray_call where org_id = org and (person_id = who or (person_id is null and linked_by = who))),
  cp as (select * from c where coalesce(call_at, linked_at) >= f and coalesce(call_at, linked_at) < t + 1),
  first_call as (select lp.sx_lead_id, min(c.call_at) - min(lp.sx_created_at) gap from lp join c on c.sx_lead_id = lp.sx_lead_id
    where lp.sx_created_at is not null and c.call_at >= lp.sx_created_at group by lp.sx_lead_id),
  st as (select lower(coalesce(stage, '')) || ' ' || lower(coalesce(stage_label, '')) words, stage, stage_label from lp)
  select jsonb_build_object('connected', coalesce(s.enabled, false) or exists(select 1 from sales_xray_lead where org_id = org),
    'lastSync', s.last_ok_at, 'lastError', case when s.last_run_at is distinct from s.last_ok_at then s.last_error end,
    'from', to_char(f, 'YYYY-MM'), 'to', to_char(t, 'YYYY-MM'),
    'leads', case when exists(select 1 from l) then (select count(*) from lp) end,
    'attempts', case when exists(select 1 from c) then (select count(*) from cp) end,
    'firstCallMinutes', (select round(extract(epoch from avg(gap)) / 60) from first_call where gap >= interval '0'),
    'settingCalls', case when exists(select 1 from st where words like '%setting%') then (select count(*) from st where words like '%setting%') end,
    'strategySessions', case when exists(select 1 from st where words like '%strategy%') then (select count(*) from st where words like '%strategy%') end,
    'proposals', case when exists(select 1 from l) then (select count(*) from st where words like '%proposal%') end,
    'closes', case when exists(select 1 from l) then (select count(*) from st where stage in ('won', 'closed_won', 'closed')) end,
    'lost', (select coalesce(jsonb_agg(jsonb_build_object('reason', r, 'count', n) order by n desc, r), '[]')
      from (select coalesce(nullif(btrim(stage_label), ''), 'Not said') r, count(*) n from st where stage in ('lost', 'closed_lost') group by 1) x)
  ) into result;
  return result;
end $$;

-- The one home's deals: every quotation of theirs that went out, newest activity first, with its incentive.
create function pulse.sales_workspace(p_person uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare who uuid := sales_who(p_person); org uuid := current_org(); result jsonb;
begin
  with q as (
    select d.id, d.number, d.taxable, d.client_id, d.revision, d.updated_at, erp_deal_status(d.id) deal, sales_incentive_status(d.id) incentive,
      coalesce(nullif(btrim(d.buyer ->> 'name'), ''), (select c.display_name from client c where c.org_id = org and c.id = d.client_id)) buyer,
      (select i.released_on from sales_incentive i where i.org_id = org and i.document_id = d.id) released_on,
      (select pq.project_id from project_quote pq where pq.org_id = org and pq.document_id in (d.id, (select x.id from erp_document x where x.org_id = org and x.source_id = d.id and x.doc_type = 'invoice' and x.status <> 'cancelled' order by x.created_at desc limit 1)) limit 1) project_id
    from erp_document d where d.org_id = org and d.doc_type = 'quotation' and d.status <> 'cancelled' and (d.status <> 'draft' or d.revision > 0) and erp_salesperson(d) = who
  )
  select jsonb_build_object('person', jsonb_build_object('id', who, 'name', (select display_name from person where org_id = org and id = who), 'self', who = current_viewer()),
    'canRelease', viewer_is('sales_head', 'leadership', 'admin', 'finance'),
    'approval', coalesce((erp_flow_step('approve') ->> 'on')::boolean, false),
    'incentives', jsonb_build_object('pending', (select count(*) from q where incentive = 'pending'), 'released', (select count(*) from q where incentive = 'released'),
      'notDue', (select count(*) from q where incentive = 'not_due' and deal <> 'lost')),
    'sold', (select count(*) from sales_sold_project_ids(who)),
    'stages', (select jsonb_agg(jsonb_build_object('key', k, 'count', (select count(*) from q where q.deal = any(st)), 'value', (select coalesce(sum(taxable), 0) from q where q.deal = any(st))) order by n)
      from (values (1, 'sent', array['to_send', 'sent', 'negotiating', 'draft']), (2, 'won', array['accepted']), (3, 'invoiced', array['invoiced', 'part_paid']), (4, 'paid', array['paid'])) s(n, k, st)),
    'deals', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'number', number, 'buyer', buyer, 'status', deal, 'value', taxable, 'version', revision + 1,
        'incentive', incentive, 'releasedOn', released_on::text, 'projectId', project_id) order by updated_at desc), '[]')
      from (select * from q where deal <> 'lost' or updated_at > now() - interval '60 days' order by updated_at desc limit 30) x)
  ) into result;
  return result;
end $$;

-- R41/R56: at Paid the salesperson joins the client's group conversations (never a pod or team chat).
-- Which conversation is a client's group lives in chat_group_info, whose row security shows a group only to those who may
-- read it (GROUP-ACCESS, 1098), the database's own functions included. So Billing keeps its own private list of the
-- client groups (pulse_priv.sales_client_group), written by a trigger on chat_group_info as the groups hub types each
-- group (a trigger sees the row it writes). Groups typed before this migration join the list the next time the hub saves
-- them (its health and classification passes write every group).
create table pulse_priv.sales_client_group (
  org_id uuid not null references pulse.org(id),
  channel_id uuid primary key,
  client_id uuid,
  project_id uuid);
create index sales_client_group_client on pulse_priv.sales_client_group(org_id, client_id);
alter table pulse_priv.sales_client_group enable row level security;
alter table pulse_priv.sales_client_group force row level security;
create policy tenant on pulse_priv.sales_client_group using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

-- Adds one person to one client group, once, with a line saying so.
create function pulse.sales_group_add(p_channel uuid, p_person uuid) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if p_person is null or not exists(select 1 from person where org_id = current_org() and id = p_person and side = 'staff' and status = 'active') then return; end if;
  if exists(select 1 from chat_member m where m.channel_id = p_channel and m.person_id = p_person) then return; end if;
  insert into chat_member(org_id, channel_id, person_id, read_through) values (current_org(), p_channel, p_person, clock_timestamp()) on conflict do nothing;
  perform chat_event_line(p_channel, p_person, 'joined as the salesperson');
end $$;

-- The list follows the hub; a group typed as a client's after the sale takes in the salespeople of that client's paid deals.
create function pulse.sales_client_group_sync() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
declare sp uuid;
begin
  if tg_op = 'DELETE' or new.kind is distinct from 'client' then
    delete from pulse_priv.sales_client_group where channel_id = case when tg_op = 'DELETE' then old.channel_id else new.channel_id end;
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  insert into pulse_priv.sales_client_group(org_id, channel_id, client_id, project_id) values (new.org_id, new.channel_id, new.client_id, new.project_id)
    on conflict (channel_id) do update set client_id = excluded.client_id, project_id = excluded.project_id;
  if tg_op = 'INSERT' or old.kind is distinct from 'client' or old.client_id is distinct from new.client_id or old.project_id is distinct from new.project_id then
    for sp in select distinct erp_salesperson(d) from erp_document d where d.org_id = new.org_id and d.doc_type = 'invoice' and d.status = 'paid'
      and ((new.client_id is not null and d.client_id = new.client_id) or d.id in (select pq.document_id from project_quote pq where pq.project_id = new.project_id))
    loop perform sales_group_add(new.channel_id, sp); end loop;
  end if;
  return new;
end $$;
revoke all on function pulse.sales_group_add(uuid, uuid), pulse.sales_client_group_sync() from public;
create trigger sales_client_group_sync after insert or update or delete on pulse.chat_group_info for each row execute function pulse.sales_client_group_sync();

create function pulse.sales_join_client_group() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
declare sp uuid := erp_salesperson(new); cl uuid; ch uuid;
begin
  if sp is null then return new; end if;
  cl := coalesce(new.client_id, (select q.client_id from erp_document q where q.org_id = new.org_id and q.id = new.source_id));
  for ch in select g.channel_id from pulse_priv.sales_client_group g
    where g.org_id = new.org_id and ((cl is not null and g.client_id = cl)
      or g.project_id in (select pq.project_id from project_quote pq where pq.org_id = new.org_id and pq.document_id in (new.id, new.source_id)))
  loop perform sales_group_add(ch, sp); end loop;
  return new;
end $$;
revoke all on function pulse.sales_join_client_group() from public;
create trigger sales_join_client_group after update of status on pulse.erp_document for each row
  when (new.doc_type = 'invoice' and new.status = 'paid' and old.status is distinct from 'paid') execute function pulse.sales_join_client_group();

revoke all on function pulse.sales_incentive_status(uuid), pulse.sales_incentive_set(uuid, boolean, text), pulse.sales_who(uuid), pulse.sales_sold_project_ids(uuid),
  pulse.sales_sold_projects(uuid, uuid), pulse.sales_neeti(uuid, date, date), pulse.sales_workspace(uuid) from public;
grant execute on function pulse.sales_incentive_set(uuid, boolean, text), pulse.sales_sold_projects(uuid, uuid), pulse.sales_neeti(uuid, date, date), pulse.sales_workspace(uuid) to pulse_api;

-- migrate:down
-- Forward-only: released incentives are records; the functions only read, and the trigger only adds a member.
