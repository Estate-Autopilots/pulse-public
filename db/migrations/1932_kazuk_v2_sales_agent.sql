-- migrate:up
-- KAZUK-V2 G14 (Kazuk's sales flow, 6 Nov 2026, R48–R55, R57, R58): the Sales Agent. "It prepares and drafts; the human
-- decides and sends. Its pricing advice never blocks a quote."
--  * A template: one AI employee per salesperson (pulse.sales_agent_create, by an admin, leadership or the Sales Head).
--    It is an ordinary AI member (agent_create_record, 0660) owned by the salesperson, with the chats, memory, projects
--    and billing tools (no tasks tool: it never changes a task), its standing rules written as behaviour rules (agent_rule, 1840), and a row in
--    pulse.sales_agent with its two settings: days before a no-reply reminder (3) and before a renewal (30).
--  * Draft only, enforced: on top of 1562's draft-only guard (an AI member never issues, records payments or changes an
--    issued document), a Sales Agent never moves a document's status at all, so it cannot send (T08).
--  * Decisions are typed rules here, not a model's guess (DECISION-MODELS: deterministic, testable):
--      no reply      a quotation Sent (no reply logged, no new version) for at least no_reply_days;
--      overdue       an invoice of theirs with money due past its due date;
--      renewal       a client they sold to whose renewal date (client.renewal_on, the signed term's end) is within
--                    renewal_days;
--      discount      the order to offer before a discount: better payment terms, then a bonus, then one package down
--                    (pulse.sales_discount_advice); it never blocks;
--      proof         another client's result is named only when that client may be named (client.may_be_named);
--      change order  a change after the sale is a new draft quotation on the same project (pulse.sales_change_order).
--    Each reminder carries a drafted message in plain words; nothing is sent by the agent.
--  * Read-only answers for the agent and the home: "how did I do this month" (deal value, invoiced and collected kept
--    apart), "what is happening with my client's project" (1931's sales_sold_projects), call prep from Neeti.
-- Synthetic data only in tests; nothing here sends to anyone.

create table pulse.sales_agent (
  org_id uuid not null references pulse.org(id),
  agent_id uuid primary key references pulse.agent_member(person_id),
  salesperson_id uuid not null references pulse.person(id),
  no_reply_days int not null default 3 check (no_reply_days between 1 and 30),
  renewal_days int not null default 30 check (renewal_days between 7 and 120),
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  unique (org_id, salesperson_id));
alter table pulse.sales_agent enable row level security;
alter table pulse.sales_agent force row level security;
create policy tenant on pulse.sales_agent using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy sales_own on pulse.sales_agent as restrictive for select to pulse_api
  using ((select pulse.sales_sees_team()) or salesperson_id = pulse.current_viewer() or agent_id = pulse.agent_session());
grant select on pulse.sales_agent to pulse_api;
comment on table pulse.sales_agent is 'KAZUK-V2 G14 (9 Nov 2026): a salesperson''s Sales Agent (an AI member, draft only) and its reminder settings';

-- R51: whether another client may be named in a pitch (off unless someone says so).
alter table pulse.client add column may_be_named boolean not null default false;
comment on column pulse.client.may_be_named is 'KAZUK-V2 G14 (9 Nov 2026): this client agreed to be named when their results are shown to a prospect';

-- ₹1,23,456 from paise (Indian grouping), for drafted messages.
create function pulse.sales_inr(p bigint) returns text language sql immutable set search_path = pulse, pg_temp as $$
  select '₹' || case when r < 1000 then r::text
    else regexp_replace(left(r::text, length(r::text) - 3), '(\d)(?=(\d\d)+$)', '\1,', 'g') || ',' || right(r::text, 3) end
  from (select round(abs(coalesce(p, 0)) / 100.0)::bigint r) x
$$;

-- Whose sales a request is about (1931's sales_who): in a Sales Agent's session, always its own salesperson; another AI
-- member reads nobody's. Otherwise as before: the viewer's own, or anyone's for the Sales Head, leadership and Finance.
create or replace function pulse.sales_who(p_person uuid) returns uuid language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); a uuid := agent_session(); sp uuid;
begin
  if a is not null then
    select s.salesperson_id into sp from sales_agent s where s.org_id = current_org() and s.agent_id = a;
    if sp is null then raise exception 'Only a Sales Agent reads a salesperson''s sales' using errcode = '42501'; end if;
    return sp;
  end if;
  if me is null or not exists(select 1 from person where org_id = current_org() and id = me and side = 'staff') then
    raise exception 'This belongs to a staff person' using errcode = '42501'; end if;
  if p_person is not null and p_person <> me and not sales_sees_team() then
    raise exception 'Only the Sales Head, leadership and Finance see another salesperson''s sales' using errcode = '42501'; end if;
  if p_person is not null and not exists(select 1 from person where org_id = current_org() and id = p_person and side = 'staff') then
    raise exception 'Person not found' using errcode = 'P0002'; end if;
  return coalesce(p_person, me);
end $$;

-- The template: one Sales Agent per salesperson.
create function pulse.sales_agent_create(p_salesperson uuid) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare org uuid := current_org(); me uuid := current_viewer(); nm text; pid uuid;
begin
  if not viewer_is('admin', 'leadership', 'sales_head') then
    raise exception 'An admin, leadership or the Sales Head makes a Sales Agent' using errcode = '42501'; end if;
  select display_name into nm from person where org_id = org and id = p_salesperson and side = 'staff' and status = 'active';
  if nm is null then raise exception 'Choose an active salesperson' using errcode = '22023'; end if;
  select agent_id into pid from sales_agent where org_id = org and salesperson_id = p_salesperson;
  if pid is not null then return pid; end if;
  pid := agent_create_record(jsonb_build_object('name', 'Sales Agent · ' || split_part(btrim(nm), ' ', 1), 'title', 'Sales Agent', 'lane', 'quick',
    'ownerId', p_salesperson, 'username', 'sales-agent-' || left(replace(p_salesperson::text, '-', ''), 10)));
  update agent_member set tools = array['chats', 'memory', 'projects', 'billing'] where org_id = org and person_id = pid;
  insert into agent_rule(org_id, agent_id, body, scope, set_by, source) values
    (org, pid, 'I prepare and draft; ' || nm || ' decides and sends. I never send, issue, record a payment or change a price myself.', 'all', me, 'profile'),
    (org, pid, 'When a discount is typed, I suggest the order first: better payment terms, then a bonus, then one package down. My advice never blocks the quotation.', 'quotation', me, 'profile'),
    (org, pid, 'A change the client asks for after the sale is a new quotation on the same project. The scope changes only once it is accepted and invoiced.', 'quotation', me, 'profile'),
    (org, pid, 'I name another client''s results only if that client agreed to be named; otherwise I describe them by city, segment and package.', 'chat', me, 'profile'),
    (org, pid, 'Project status is read only: I say what is done and what is next, and never change a task.', 'task', me, 'profile');
  insert into sales_agent(org_id, agent_id, salesperson_id, created_by) values (org, pid, p_salesperson, me);
  return pid;
end $$;

-- Its two settings (the salesperson, their Sales Head, leadership or an admin).
create function pulse.sales_agent_settings(p_salesperson uuid, p_no_reply int, p_renewal int) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s sales_agent;
begin
  if p_salesperson is distinct from current_viewer() and not viewer_is('admin', 'leadership', 'sales_head') then
    raise exception 'The salesperson or the Sales Head changes these' using errcode = '42501'; end if;
  update sales_agent set no_reply_days = coalesce(p_no_reply, no_reply_days), renewal_days = coalesce(p_renewal, renewal_days)
    where org_id = current_org() and salesperson_id = p_salesperson returning * into s;
  if s.agent_id is null then raise exception 'No Sales Agent for this person yet' using errcode = 'P0002'; end if;
  return jsonb_build_object('noReplyDays', s.no_reply_days, 'renewalDays', s.renewal_days);
end $$;

-- T08: a Sales Agent never moves a document's status (it cannot send, issue, accept or mark lost).
create function pulse.sales_agent_send_guard() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if new.status is distinct from old.status and exists(select 1 from sales_agent s where s.agent_id = agent_session()) then
    raise exception 'A Sales Agent drafts; the salesperson sends' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function pulse.sales_agent_send_guard() from public;
create trigger sales_agent_send_guard before update of status on pulse.erp_document for each row execute function pulse.sales_agent_send_guard();

-- The reminders (typed rules), each with a drafted message. p_at stands in for "now" (tests move the clock).
create function pulse.sales_agent_nudges(p_person uuid default null, p_at timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare org uuid := current_org(); who uuid := sales_who(p_person); v_now timestamptz := coalesce(p_at, now()); tz text := org_time_zone();
  today date := (coalesce(p_at, now()) at time zone org_time_zone())::date; s sales_agent; nm text; result jsonb;
begin
  select * into s from sales_agent where org_id = org and salesperson_id = who;
  select split_part(btrim(display_name), ' ', 1) into nm from person where org_id = org and id = who;
  with q as (
    select d.*, coalesce(nullif(btrim(d.buyer ->> 'name'), ''), c.display_name) client, coalesce(nullif(btrim(d.buyer ->> 'contactName'), ''), nullif(btrim(c.display_name), '')) hello,
      coalesce(nullif(btrim(d.buyer ->> 'phone'), ''), c.phone) phone
    from erp_document d left join client c on c.org_id = d.org_id and c.id = d.client_id
    where d.org_id = org and erp_salesperson(d) = who and d.status <> 'cancelled'
  ), no_reply as (
    select q.*, today - (q.sent_at at time zone tz)::date days from q
    where q.doc_type = 'quotation' and q.status = 'sent' and q.negotiating_at is null and q.decision is null and q.sent_at <= v_now - make_interval(days => coalesce(s.no_reply_days, 3))
  ), late as (
    select q.*, u.base_due + u.gst_due due, today - q.due_date days from q join finance_invoice_due() u on u.document_id = q.id
    where q.doc_type = 'invoice' and q.status in ('issued', 'sent', 'part_paid') and q.due_date < today and u.base_due + u.gst_due > 0
  ), renew as (
    select c.id, c.display_name client, c.phone, c.renewal_on, c.renewal_on - today days from client c
    where c.org_id = org and c.renewal_on between today and today + coalesce(s.renewal_days, 30)
      and exists(select 1 from q where q.client_id = c.id and q.doc_type = 'invoice' and q.status in ('part_paid', 'paid'))
  ), items as (
    select 1 rank, jsonb_build_object('kind', 'no_reply', 'key', 'no_reply:' || id || ':' || revision, 'docId', id, 'days', days, 'amount', taxable, 'phone', phone,
      'title', 'No reply on ' || coalesce(number, 'a quotation') || ' V' || (revision + 1) || ' for ' || days || ' day' || case when days = 1 then '' else 's' end,
      'sub', coalesce(client, 'Client') || ' · a follow-up is drafted', 'href', '/erp/documents/' || id,
      'draft', 'Hi ' || coalesce(hello, 'there') || ', just checking that you got our quotation ' || coalesce(number, '') || ' for ' || sales_inr(total)
        || '. Happy to walk you through it or change anything that does not fit. When is a good time for a quick call? – ' || coalesce(nm, '')) j, taxable amt from no_reply
    union all
    select 0, jsonb_build_object('kind', 'overdue', 'key', 'overdue:' || id || ':' || due_date, 'docId', id, 'days', days, 'amount', due, 'phone', phone,
      'title', coalesce(number, 'An invoice') || ' is ' || days || ' day' || case when days = 1 then '' else 's' end || ' late',
      'sub', coalesce(client, 'Client') || ' · ' || sales_inr(due) || ' due · a payment reminder is drafted', 'href', '/erp/documents/' || id,
      'draft', 'Hi ' || coalesce(hello, 'there') || ', a gentle reminder that invoice ' || coalesce(number, '') || ' for ' || sales_inr(due) || ' was due on '
        || to_char(due_date, 'FMDD Mon') || '. You can pay by UPI or bank transfer; please share the UTR once it is done. Thank you! – ' || coalesce(nm, '')), due from late
    union all
    select 2, jsonb_build_object('kind', 'renewal', 'key', 'renewal:' || id || ':' || renewal_on, 'clientId', id, 'days', days, 'phone', phone,
      'title', 'Renewal: ' || client || case when days = 0 then ' ends today' else ' ends in ' || days || ' day' || case when days = 1 then '' else 's' end end,
      'sub', 'Signed term ends ' || to_char(renewal_on, 'FMDD Mon') || ' · a message is drafted', 'href', '/clients/' || id,
      'draft', 'Hi ' || client || ', your current plan with us runs till ' || to_char(renewal_on, 'FMDD Mon') || '. Shall we set up a short call this week to look at the results and plan the next term? – ' || coalesce(nm, '')), 0 from renew
  )
  select jsonb_build_object('person', jsonb_build_object('id', who, 'self', who = current_viewer()), 'agent', s.agent_id is not null,
    'canMakeAgent', agent_session() is null and viewer_is('admin', 'leadership', 'sales_head'),
    'settings', jsonb_build_object('noReplyDays', coalesce(s.no_reply_days, 3), 'renewalDays', coalesce(s.renewal_days, 30)), 'today', today::text,
    'items', (select coalesce(jsonb_agg(j order by rank, amt desc), '[]') from items)) into result;
  return result;
end $$;

-- R48: what to offer before a discount. Typed: the order never changes and it never blocks; the bonus and the smaller
-- package come from the catalogue. p_pct: the discount being given; p_amount: what it takes off (paise); p_package:
-- the package on the quotation, if any.
create function pulse.sales_discount_advice(p_pct numeric, p_amount bigint default null, p_package uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare org uuid := current_org(); pkg erp_item; below erp_item; bonus erp_item; lvl text;
begin
  if p_pct is null or p_pct < 0 or p_pct > 100 then raise exception 'Give the discount as 0 to 100 percent' using errcode = '22023'; end if;
  lvl := case when p_pct = 0 then 'none' when p_pct < 5 then 'small' else 'big' end;
  if p_package is not null then
    select * into pkg from erp_item where org_id = org and id = p_package and kind = 'package';
    select * into below from erp_item where org_id = org and kind = 'package' and status = 'active' and pkg.id is not null and price < pkg.price and id <> pkg.id
      order by price desc, name limit 1;
  end if;
  select * into bonus from erp_item where org_id = org and kind = 'service' and status = 'active' and price > 0 and price <= coalesce(nullif(p_amount, 0), 0)
    order by price desc, name limit 1;
  return jsonb_build_object('blocks', false, 'pct', p_pct, 'level', lvl,
    'say', case lvl when 'none' then 'No discount: nothing to suggest.'
      when 'small' then 'A small discount is fine. If they ask for more, try these first, in this order.'
      else 'Before giving ' || rtrim(to_char(p_pct, 'FM990.99'), '.') || '% off, try these first, in this order.' end,
    'steps', case when lvl = 'none' then '[]'::jsonb else jsonb_build_array(
      jsonb_build_object('key', 'terms', 'title', 'Better payment terms', 'detail', 'Keep the price and make paying easier: for example half now and half in 30 days, instead of all up front.'),
      jsonb_build_object('key', 'bonus', 'title', 'Add a bonus', 'detail', case when bonus.id is not null
        then 'Keep the price and add ' || bonus.name || ' (worth ' || sales_inr(bonus.price) || ') at no charge.'
        else 'Keep the price and add something small at no charge, worth less than the discount.' end, 'itemId', bonus.id),
      jsonb_build_object('key', 'package', 'title', 'One package down', 'detail', case when below.id is not null
        then 'Offer ' || below.name || ' at ' || sales_inr(below.price) || ' instead of ' || pkg.name || ' at ' || sales_inr(pkg.price) || '.'
        when pkg.id is not null then pkg.name || ' is already the smallest package.'
        else 'Offer the next smaller package, with less in it, at its own price.' end, 'itemId', below.id)) end,
    'note', 'This is advice only. The price is yours to decide.');
end $$;

-- R54: "How did I do this month?" Deal value, invoiced and collected kept apart (1480's sales_numbers, for the person).
create function pulse.sales_how_did_i_do(p_person uuid default null, p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare who uuid := sales_who(p_person); f date := date_trunc('month', coalesce(p_from, (now() at time zone org_time_zone())::date))::date;
  t date := (date_trunc('month', coalesce(p_to, p_from, (now() at time zone org_time_zone())::date)) + interval '1 month -1 day')::date; d jsonb; deals int; won int; won_value bigint;
begin
  select count(*), count(*) filter (where erp_deal_status(x.id) in ('accepted', 'invoiced', 'part_paid', 'paid')),
    coalesce(sum(x.taxable) filter (where erp_deal_status(x.id) in ('accepted', 'invoiced', 'part_paid', 'paid')), 0)
    into deals, won, won_value
    from erp_document x where x.org_id = current_org() and x.doc_type = 'quotation' and x.status not in ('cancelled', 'draft') and erp_salesperson(x) = who
      and x.issue_date between f and t;
  select jsonb_build_object('invoiced', coalesce(sum(i.total), 0), 'invoices', count(*)) into d
    from erp_document i where i.org_id = current_org() and i.doc_type = 'invoice' and i.status not in ('cancelled', 'draft') and erp_salesperson(i) = who and i.issue_date between f and t;
  return jsonb_build_object('from', f::text, 'to', t::text, 'quotations', deals, 'won', won, 'dealValue', won_value, 'invoiced', d -> 'invoiced', 'invoices', d -> 'invoices',
    'collected', (select coalesce(sum(p.amount), 0) from erp_payment p join erp_document i on i.id = p.document_id
      where p.org_id = current_org() and p.voided_at is null and p.received_on between f and t and erp_salesperson(i) = who),
    'words', 'Deal value is what clients agreed to (net of GST); invoiced is what was billed; collected is the money that came in. They are kept apart.');
end $$;

-- R51: results to show a prospect, by city, segment or package. A client is named only when they may be named.
create function pulse.sales_proof(p_city text default null, p_package text default null) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare who uuid := sales_who(null); result jsonb;
begin
  with p as (
    select pr.id, pr.name, pr.status, pr.location, c.display_name client, c.city, c.may_be_named, pr.start_month,
      (select string_agg(distinct coalesce(l.description, ''), ', ') from project_quote pq join erp_line l on l.document_id = pq.document_id where pq.project_id = pr.id) sold,
      (select count(*) from task t where t.project_id = pr.id and t.status = 'done' and t.deleted_at is null) done
    from project pr join client c on c.org_id = pr.org_id and c.id = pr.client_id
    where pr.org_id = current_org() and pr.status in ('onboarding', 'active', 'done') and exists(select 1 from project_quote pq where pq.project_id = pr.id)
  )
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('project', case when may_be_named then name end,
      'client', case when may_be_named then client else 'A client' || coalesce(' in ' || nullif(btrim(coalesce(city, location)), ''), '') end,
      'mayBeNamed', may_be_named, 'city', coalesce(city, location), 'sold', sold, 'tasksDone', done, 'since', to_char(start_month, 'Mon YYYY'))
      order by may_be_named desc, done desc), '[]'),
    'rule', 'Clients are named only when they agreed to be named; the others are described by city and what was sold.') into result
  from (select * from p where (p_city is null or coalesce(city, location, '') ilike '%' || p_city || '%') and (p_package is null or coalesce(sold, '') ilike '%' || p_package || '%') limit 8) x;
  return result;
end $$;

-- R52: call prep from Neeti for one lead: who they are, the package that fits, what they objected to before, a talk track.
create function pulse.sales_call_prep(p_lead uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare who uuid := sales_who(null); nm text; l sales_xray_lead; fit erp_item; objections jsonb;
begin
  select display_name into nm from person where org_id = current_org() and id = who;
  select * into l from sales_xray_lead where org_id = current_org() and sx_lead_id = p_lead and lower(btrim(owner_name)) = lower(btrim(nm));
  if l.sx_lead_id is null then raise exception 'This lead is not yours' using errcode = '42501'; end if;
  select * into fit from erp_item where org_id = current_org() and kind = 'package' and status = 'active'
    order by (coalesce(l.interest, '') <> '' and (name ilike '%' || l.interest || '%' or coalesce(description, '') ilike '%' || l.interest || '%')) desc, price limit 1;
  select coalesce(jsonb_agg(distinct o), '[]') into objections from sales_xray_call c cross join lateral jsonb_array_elements_text(coalesce(c.summary -> 'objections', '[]')) o
    where c.org_id = current_org() and c.sx_lead_id = p_lead;
  return jsonb_build_object('lead', jsonb_build_object('name', l.name, 'company', l.company, 'city', l.city, 'interest', l.interest, 'stage', coalesce(l.stage_label, l.stage), 'source', l.source_label),
    'package', case when fit.id is not null then jsonb_build_object('name', fit.name, 'price', fit.price) end, 'objections', objections,
    'talkTrack', jsonb_build_array('Open with what they asked about' || coalesce(': ' || nullif(l.interest, ''), '') || '.',
      'Ask what a good month looks like for them, in numbers.', coalesce('Show ' || fit.name || ' and what is in it.', 'Show the package that fits their size.'),
      'Answer the objections they raised before, if any.', 'Agree the next step and a day for it.'));
end $$;

-- R58: a change after the sale is a new draft quotation on the same project, for the same client (the agent drafts it;
-- the salesperson sends it; the scope changes only once it is accepted and invoiced, 1688's add-on).
create function pulse.sales_change_order(p_project uuid, p_note text default null) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare who uuid := sales_who(null); src erp_document; did uuid;
begin
  if p_project not in (select sales_sold_project_ids(who)) then raise exception 'This project was not sold by this salesperson' using errcode = '42501'; end if;
  select d.* into src from project_quote pq join erp_document d on d.id = pq.document_id
    where pq.org_id = current_org() and pq.project_id = p_project and d.doc_type = 'quotation' order by d.created_at desc limit 1;
  if src.id is null then raise exception 'No quotation started this project' using errcode = 'P0002'; end if;
  insert into erp_document(org_id, doc_type, issue_date, seller, buyer, place_of_supply, tax_mode, taxable, cgst, sgst, igst, total, client_id, project_id, salesperson_id, notes, created_by)
    values (current_org(), 'quotation', (now() at time zone org_time_zone())::date, src.seller, src.buyer, src.place_of_supply, src.tax_mode, 0, 0, 0, 0, 0, src.client_id, p_project, who,
      left(coalesce('Change order: ' || nullif(btrim(p_note), ''), 'Change order'), 500), current_viewer())
    returning id into did;
  return did;
end $$;

revoke all on function pulse.sales_inr(bigint), pulse.sales_agent_create(uuid), pulse.sales_agent_settings(uuid, int, int),
  pulse.sales_agent_nudges(uuid, timestamptz), pulse.sales_discount_advice(numeric, bigint, uuid), pulse.sales_how_did_i_do(uuid, date, date),
  pulse.sales_proof(text, text), pulse.sales_call_prep(uuid), pulse.sales_change_order(uuid, text) from public;
grant execute on function pulse.sales_inr(bigint), pulse.sales_agent_create(uuid), pulse.sales_agent_settings(uuid, int, int), pulse.sales_agent_nudges(uuid, timestamptz),
  pulse.sales_discount_advice(numeric, bigint, uuid), pulse.sales_how_did_i_do(uuid, date, date), pulse.sales_proof(text, text), pulse.sales_call_prep(uuid),
  pulse.sales_change_order(uuid, text) to pulse_api;

-- migrate:down
-- Forward-only: Sales Agents are AI members with their own history; the functions only read or draft.
