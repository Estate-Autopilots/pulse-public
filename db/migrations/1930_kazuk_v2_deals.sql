-- migrate:up
-- KAZUK-V2 G12 (Kazuk's sales flow, 6 Nov 2026, R31: "how the first quotation was, the second, the final: how one
-- particular salesperson negotiates"). Negotiation numbers, read only, from the versions Billing already files
-- (erp_document_revision, 1471/1672) and the deal status (1672):
--   * the first price (V1) against the latest one, and the discount between them;
--   * versions per deal, and why each new version was made (price, scope, timeline, other);
--   * days from V1 to the client's yes, and from the invoice to the last payment;
--   * the services cut or lowered most (the lines of V1 against the latest version's);
--   * deals lost, by reason.
-- pulse.sales_deals(person, from, to, all): one salesperson's deals (their own, by erp_salesperson), or, for the Sales
-- Head, leadership, admins, Finance and the money readers (pulse.sales_sees_team), everyone's with a row per salesperson.
-- A salesperson asking for everyone's gets their own. Nothing here writes.
--
-- R47 (a salesperson never sees another salesperson's deals): 1670 put the sales roles in erp_can(), and My sales'
-- three reads (sales_numbers 1480, sales_desk 1711, sales_pipeline 1853) let anyone with erp_can(false) pick another
-- person. They now ask pulse.sales_sees_team() instead; a salesperson still opens Billing (canOpenErp is unchanged).
-- Synthetic data only in tests; nothing here reads or writes production data.

create function pulse.sales_sees_team() returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select current_viewer() is not null and (viewer_is('leadership', 'admin', 'finance', 'sales_head')
    or (money_can('money.read') and money_can('money.amount.read')))
$$;
comment on function pulse.sales_sees_team() is 'KAZUK-V2 (9 Nov 2026): who sees every salesperson''s deals and numbers: the Sales Head, leadership, admins, Finance and money readers (never a sales seat)';

-- The three My sales reads: the same text, with the team check in place of Billing access.
do $$
declare f text; old text; new text;
begin
  foreach f in array array['pulse.sales_numbers(uuid,date,date)', 'pulse.sales_desk(uuid)', 'pulse.sales_pipeline(uuid)'] loop
    old := pg_get_functiondef(f::regprocedure);
    new := replace(replace(replace(old, 'if who<>me and not reader then', 'if who<>me and not sales_sees_team() then'),
      'if who <> me and not erp_can(false) then', 'if who <> me and not sales_sees_team() then'),
      '''team'',case when reader then', '''team'',case when sales_sees_team() then');
    if new = old then raise exception 'KAZUK-V2: % did not have the team check this migration replaces', f; end if;
    execute new;
  end loop;
end $$;

create function pulse.sales_deals(p_person uuid default null, p_from date default null, p_to date default null, p_all boolean default false) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); org uuid := current_org(); tz text := org_time_zone(); today date := (now() at time zone org_time_zone())::date;
  team boolean := sales_sees_team(); everyone boolean; who uuid; nm text; result jsonb;
  f date := date_trunc('month', coalesce(p_from, (now() at time zone org_time_zone())::date))::date;
  t date := (date_trunc('month', coalesce(p_to, p_from, (now() at time zone org_time_zone())::date)) + interval '1 month -1 day')::date;
begin
  if me is null or not exists(select 1 from person where org_id = org and id = me and side = 'staff') then
    raise exception 'Deals belong to a staff person' using errcode = '42501'; end if;
  if p_person is not null and p_person <> me and not team then
    raise exception 'Only the Sales Head, leadership and Finance see another salesperson''s deals' using errcode = '42501'; end if;
  if t < f or t - f > 800 then raise exception 'Choose a period of up to two years' using errcode = '22023'; end if;
  everyone := coalesce(p_all, false) and team and p_person is null;
  who := case when everyone then null else coalesce(p_person, me) end;
  if who is not null then
    select display_name into nm from person where org_id = org and id = who and side = 'staff';
    if nm is null then raise exception 'Person not found' using errcode = 'P0002'; end if;
  end if;
  with q as (
    -- Every quotation that went out at least once (a draft that was never sent is not a deal yet).
    select d.*, erp_salesperson(d) sp from erp_document d
    where d.org_id = org and d.doc_type = 'quotation' and d.status <> 'cancelled' and (d.status <> 'draft' or d.revision > 0)
      and (everyone or erp_salesperson(d) = who)
  ), v as (
    select q.id, q.number, q.sp, q.status, q.revision, q.taxable final, q.lost_reason, q.client_id, q.decision,
      coalesce(nullif(btrim(q.buyer ->> 'name'), ''), (select c.display_name from client c where c.org_id = org and c.id = q.client_id)) buyer,
      coalesce((r0.snapshot ->> 'taxable')::bigint, q.taxable) v1,
      coalesce(case when r0.snapshot ->> 'sent_at' is not null then ((r0.snapshot ->> 'sent_at')::timestamptz at time zone tz)::date end,
        (r0.snapshot ->> 'issue_date')::date, (q.sent_at at time zone tz)::date, q.issue_date) v1_on,
      r0.lines v1_lines, erp_deal_status(q.id) deal,
      i.id inv, i.issue_date inv_on, i.status inv_status, i.created_at inv_made
    from q
    left join erp_document_revision r0 on r0.org_id = org and r0.document_id = q.id and r0.revision = 0
    left join lateral (select x.id, x.issue_date, x.status, x.created_at from erp_document x where x.org_id = org and x.source_id = q.id and x.doc_type = 'invoice'
      and x.status <> 'cancelled' order by x.created_at desc limit 1) i on true
  ), deals as (
    select v.*,
      case when v.deal in ('accepted', 'invoiced', 'part_paid', 'paid') then
        coalesce(case when v.decision ->> 'at' ~ '^\d{4}-\d{2}-\d{2}' then ((v.decision ->> 'at')::timestamptz at time zone tz)::date end, (v.inv_made at time zone tz)::date) end yes_on,
      case when v.inv_status = 'paid' then (select max(p.received_on) from erp_payment p where p.org_id = org and p.document_id = v.inv and p.voided_at is null) end paid_on
    from v where v.v1_on between f and t
  ), won as (select * from deals where deal in ('accepted', 'invoiced', 'part_paid', 'paid')
  ), cut as (
    -- V1's lines against the latest version's, matched by catalogue item, else by the line's words.
    select a.name, a.k, a.deal_id, a.v1, coalesce(b.taxable, 0) now_, b.k is null removed
    from (select x.id deal_id, coalesce(l ->> 'item_id', lower(btrim(l ->> 'description'))) k, min(l ->> 'description') name, sum((l ->> 'taxable')::bigint) v1
          from deals x cross join jsonb_array_elements(x.v1_lines) l where x.revision > 0 group by 1, 2) a
    left join (select l.document_id, coalesce(l.item_id::text, lower(btrim(l.description))) k, sum(l.taxable) taxable
          from erp_line l join deals x on x.id = l.document_id and x.revision > 0 where l.org_id = org group by 1, 2) b
      on b.document_id = a.deal_id and b.k = a.k
    where b.k is null or b.taxable < a.v1
  ), people as (
    select sp, count(*) deals, count(*) filter (where deal in ('accepted', 'invoiced', 'part_paid', 'paid')) won, count(*) filter (where deal = 'lost') lost,
      coalesce(sum(v1) filter (where deal in ('accepted', 'invoiced', 'part_paid', 'paid')), 0) v1_won,
      coalesce(sum(final) filter (where deal in ('accepted', 'invoiced', 'part_paid', 'paid')), 0) final_won,
      round(avg(revision + 1), 1) versions, round(avg(yes_on - v1_on)) days_yes, round(avg(paid_on - inv_on) filter (where paid_on is not null)) days_paid
    from deals group by sp
  )
  select jsonb_build_object(
    'person', case when who is null then null else jsonb_build_object('id', who, 'name', nm, 'self', who = me) end,
    'everyone', everyone, 'canSeeTeam', team, 'canOpenErp', erp_can(false), 'ownOnly', erp_own_only(),
    'team', case when team then (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name) order by p.display_name), '[]') from person p
      where p.org_id = org and p.side = 'staff' and exists(select 1 from erp_document x where x.org_id = org and x.doc_type = 'quotation' and x.status <> 'cancelled' and erp_salesperson(x) = p.id)) end,
    'from', to_char(f, 'YYYY-MM'), 'to', to_char(t, 'YYYY-MM'), 'today', today::text,
    'summary', jsonb_build_object(
      'deals', (select count(*) from deals), 'won', (select count(*) from won), 'lost', (select count(*) from deals where deal = 'lost'),
      'open', (select count(*) from deals where deal in ('to_send', 'sent', 'negotiating', 'draft')),
      'v1Won', (select coalesce(sum(v1), 0) from won), 'finalWon', (select coalesce(sum(final), 0) from won),
      'versions', (select round(avg(revision + 1), 1) from deals), 'revised', (select count(*) from deals where revision > 0),
      'daysToYes', (select round(avg(yes_on - v1_on)) from won where yes_on is not null),
      'daysToPaid', (select round(avg(paid_on - inv_on)) from deals where paid_on is not null), 'paid', (select count(*) from deals where paid_on is not null)),
    'people', case when everyone then (select coalesce(jsonb_agg(jsonb_build_object('id', p.sp, 'name', coalesce(pp.display_name, 'No salesperson'),
        'deals', p.deals, 'won', p.won, 'lost', p.lost, 'v1Won', p.v1_won, 'finalWon', p.final_won, 'versions', p.versions,
        'daysToYes', p.days_yes, 'daysToPaid', p.days_paid) order by p.won desc, p.deals desc, pp.display_name), '[]')
      from people p left join person pp on pp.org_id = org and pp.id = p.sp) end,
    'cuts', (select coalesce(jsonb_agg(x order by (x ->> 'deals')::int desc, (x ->> 'amount')::bigint desc), '[]') from (
      select jsonb_build_object('name', min(name), 'deals', count(distinct deal_id), 'removed', count(*) filter (where removed),
        'lowered', count(*) filter (where not removed), 'amount', sum(v1 - now_)) x
      from cut group by k order by count(distinct deal_id) desc, sum(v1 - now_) desc limit 6) y),
    'lostBy', (select coalesce(jsonb_agg(jsonb_build_object('reason', coalesce(lost_reason, 'not_said'), 'count', n, 'value', val) order by n desc, lost_reason), '[]')
      from (select lost_reason, count(*) n, sum(final) val from deals where deal = 'lost' group by 1) l),
    'versionWhy', (select coalesce(jsonb_agg(jsonb_build_object('reason', coalesce(r.reason_kind, 'not_said'), 'count', r.n) order by r.n desc, r.reason_kind), '[]')
      from (select rv.reason_kind, count(*) n from erp_document_revision rv join deals x on x.id = rv.document_id where rv.org_id = org group by 1) r),
    'deals', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'number', x.number, 'buyer', x.buyer, 'status', x.deal,
        'salesperson', case when everyone then (select pp.display_name from person pp where pp.org_id = org and pp.id = x.sp) end,
        'versions', x.revision + 1, 'v1', x.v1, 'final', x.final, 'sentOn', x.v1_on::text, 'yesOn', x.yes_on::text,
        'daysToYes', x.yes_on - x.v1_on, 'invoicedOn', case when x.inv_status in ('issued', 'sent', 'part_paid', 'paid') then x.inv_on::text end,
        'paidOn', x.paid_on::text, 'daysToPaid', x.paid_on - x.inv_on, 'lostReason', x.lost_reason) order by x.v1_on desc, x.number desc), '[]')
      from (select * from deals order by v1_on desc, number desc limit 60) x)
  ) into result;
  return result;
end $$;
comment on function pulse.sales_deals(uuid, date, date, boolean) is 'KAZUK-V2 G12 (9 Nov 2026): negotiation numbers from the filed versions and the deal status, one salesperson''s or (the Sales Head, leadership, Finance) everyone''s; read only';

revoke all on function pulse.sales_sees_team(), pulse.sales_deals(uuid, date, date, boolean) from public;
grant execute on function pulse.sales_sees_team(), pulse.sales_deals(uuid, date, date, boolean) to pulse_api;

-- migrate:down
-- Forward-only: the functions only read. (The three My sales reads keep the team check.)
