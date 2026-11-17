-- migrate:up
-- GROWTH-LOOP slice 1 (owner, 8 Nov 2026): the investor numbers. How the whole network grows, for the platform owner
-- only, inside Vitals HQ (/hq/investors). One definer function counts from the real tables of every active company and
-- returns totals and weekly series only: no company's name, id or own number ever leaves it.
--
-- Who: pulse.investor_viewer(): an admin seat, in the Vitals HQ organisation (its tenant modules document switches
-- pulse_hq on, 0944) or the install's own organisation, whose Pulse account is also a platform admin's account
-- (pulse_priv.platform_admin, 1140). Everyone else, the HQ's other admins included, is refused with 42501.
--
-- What is counted (each rule is shown on the page under "How we count"):
--   contracts signed      a contract (counted once, on its home company's copy) is active or ended and every side
--                         accepted; its week is the week the last side accepted.
--   companies via a deal  a company whose first admin was already on Vitals as another company's client, vendor or
--                         freelancer before the company was opened, or that is a side of another company's contract
--                         made before the company was opened. Also a company opened from the "What is Vitals?" card.
--   quotes and bills      quotations, invoices and proformas past draft; the week they were issued (or made).
--   chat users            people who sent a chat message (AI employees left out), client side apart; a person in
--                         two companies with one Pulse account counts once.
--   employees             active staff (AI employees left out), one per Pulse account.
--   AI agents             AI employees not switched off.
--   weekly active people  people who signed in, were active in the app or sent a chat message that week.
--   the funnel            visitors a week who saw or pressed "What is Vitals?" (totals add the weeks up), and companies
--                         opened from it.
-- Weeks start on Monday, India time. Rehearsal companies and personal workspaces are left out.

-- The "What is Vitals" funnel (slice 2 writes it through pulse.growth_track): what client-side people and guests did
-- with the card on another company's chat, quote or agreement page. org_id is that company (the one that brought them);
-- visitor is the SHA-256 of an anonymous browser id or of the person (never the person's id or address). One row per
-- event, source, visitor and day; org_created names the company they opened (once per company).
create table pulse.growth_event (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  event text not null check (event in ('viewed', 'clicked', 'dismissed', 'org_created')),
  source text not null check (source in ('chat', 'quote', 'contract', 'portal')),
  visitor text not null check (visitor ~ '^[0-9a-f]{64}$'),
  new_org uuid references pulse.org(id),
  day date not null default ((now() at time zone 'Asia/Kolkata')::date),
  created_at timestamptz not null default now(),
  check ((event = 'org_created') = (new_org is not null)),
  unique (org_id, event, source, visitor, day)
);
create unique index growth_event_new_org on pulse.growth_event(new_org) where new_org is not null;
create index growth_event_org_at on pulse.growth_event(org_id, created_at);
alter table pulse.growth_event enable row level security;
alter table pulse.growth_event force row level security;
create policy tenant_isolation on pulse.growth_event using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on pulse.growth_event from public;

create function pulse.investor_viewer() returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select current_org() is not null and current_viewer() is not null and viewer_is('admin')
     and coalesce(current_setting('pulse.platform_return', true), '') = ''
     and (current_org() = install_org()
          or exists (select 1 from tenant_config t
                      where t.org_id = current_org() and t.doc_kind = 'tenant' and t.doc_key = 'modules' and t.is_active
                        and coalesce(t.body -> 'on', '[]'::jsonb) ? 'pulse_hq'))
     and exists (select 1 from pulse_priv.account_member me
                   join pulse_priv.account_member pa on pa.account_id = me.account_id
                   join pulse_priv.platform_admin x on x.person_id = pa.person_id
                  where me.person_id = current_viewer() and me.member_org = current_org())
$$;
revoke all on function pulse.investor_viewer() from public;
grant execute on function pulse.investor_viewer() to pulse_api;

create function pulse.investor_metrics(p_weeks int) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare
  v_weeks int := least(greatest(coalesce(p_weeks, 12), 4), 52);
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_start date;
  v_ends date[];
  v_facts text[] := '{}';
  v_back_org text := coalesce(current_setting('pulse.org_id', true), '');
  v_back_viewer text := coalesce(current_setting('pulse.viewer_id', true), '');
  v_orgs uuid[];
  o uuid;
  v_out jsonb;
begin
  if not investor_viewer() then
    raise exception 'Only the platform owner sees the investor numbers' using errcode = '42501';
  end if;
  v_start := date_trunc('week', v_today)::date - 7 * (v_weeks - 1);
  v_ends := array(select v_start + 7 * (w + 1) from generate_series(0, v_weeks - 1) w);
  v_orgs := array(select g.id from org g where g.status = 'active' and g.kind = 'company' and not g.rehearsal);

  -- Each fact is "metric|week|key|side". week is the week index from v_start (negative = earlier, for the totals).
  foreach o in array v_orgs loop
    perform set_config('pulse.org_id', o::text, true);
    perform set_config('pulse.viewer_id', '', true);
    v_facts := v_facts
      || array(select 'contract|' || (((max(p.accepted_at) at time zone 'Asia/Kolkata')::date - v_start) / 7 - case when (max(p.accepted_at) at time zone 'Asia/Kolkata')::date < v_start then 1 else 0 end) || '|' || c.id || '|'
                 from contract c join contract_party p on p.contract_id = c.id and p.org_id = c.org_id
                where c.org_id = o and c.home_org = o and c.status in ('active', 'ended')
                group by c.id having bool_and(p.accepted_at is not null))
      || array(select 'party|' || extract(epoch from c.created_at) || '|' || p.party_org || '|'
                 from contract c join contract_party p on p.contract_id = c.id and p.org_id = c.org_id
                where c.org_id = o and c.home_org = o and p.party_org is not null and p.party_org <> o)
      || array(select case when d.doc_type = 'quotation' then 'quote|' else 'bill|' end
                      || (((coalesce(d.issued_at, d.created_at) at time zone 'Asia/Kolkata')::date - v_start) / 7
                          - case when (coalesce(d.issued_at, d.created_at) at time zone 'Asia/Kolkata')::date < v_start then 1 else 0 end) || '|' || d.id || '|'
                 from erp_document d
                where d.org_id = o and d.status <> 'draft' and d.doc_type in ('quotation', 'invoice', 'proforma'))
      -- people: one key per Pulse account (or the person, without one); AI employees and system people left out
      || array(select distinct 'chat|' || (((m.created_at at time zone 'Asia/Kolkata')::date - v_start) / 7) || '|'
                      || coalesce(am.account_id, p.id) || '|' || case when p.side in ('client', 'vendor', 'channel_partner') then 'c' else 's' end
                 from chat_message m join person p on p.id = m.author_id
                 left join pulse_priv.account_member am on am.person_id = p.id
                where m.org_id = o and m.created_at >= v_start and m.removed_at is null and p.side <> 'other'
                  and not exists (select 1 from agent_member a where a.person_id = p.id))
      || array(select distinct 'chatall|-1|' || coalesce(am.account_id, p.id) || '|' || case when p.side in ('client', 'vendor', 'channel_partner') then 'c' else 's' end
                 from (select distinct author_id from chat_message where org_id = o and removed_at is null) m
                 join person p on p.id = m.author_id
                 left join pulse_priv.account_member am on am.person_id = p.id
                where p.side <> 'other' and not exists (select 1 from agent_member a where a.person_id = p.id))
      || array(select distinct 'active|' || w || '|' || coalesce(am.account_id, p.id) || '|'
                 from (select s.person_id, ((s.created_at at time zone 'Asia/Kolkata')::date - v_start) / 7 w
                         from login_session s where s.org_id = o and s.created_at >= v_start
                       union
                       select s.person_id, ((s.last_active_at at time zone 'Asia/Kolkata')::date - v_start) / 7
                         from login_session s where s.org_id = o and s.last_active_at >= v_start
                       union
                       select m.author_id, ((m.created_at at time zone 'Asia/Kolkata')::date - v_start) / 7
                         from chat_message m where m.org_id = o and m.created_at >= v_start and m.removed_at is null) x
                 join person p on p.id = x.person_id
                 left join pulse_priv.account_member am on am.person_id = p.id
                where p.side <> 'other' and not exists (select 1 from agent_member a where a.person_id = p.id))
      || array(select distinct 'staff|' || (w - 1) || '|' || coalesce(am.account_id, p.id) || '|'
                 from person p
                 left join pulse_priv.account_member am on am.person_id = p.id
                 cross join generate_series(1, v_weeks) w
                where p.org_id = o and p.side = 'staff' and p.created_at < v_ends[w]
                  and (p.status = 'active' or (p.active_to is not null and p.active_to >= v_ends[w]))
                  and not exists (select 1 from agent_member a where a.person_id = p.id))
      || array(select 'agent|' || (w - 1) || '|' || a.person_id || '|'
                 from agent_member a cross join generate_series(1, v_weeks) w
                where a.org_id = o and a.created_at < v_ends[w] and (a.disabled_at is null or a.disabled_at >= v_ends[w]))
      -- the funnel: distinct visitors a week who saw or pressed the card; a company opened from it is a company via a deal
      || array(select distinct case e.event when 'viewed' then 'fview|' else 'fclick|' end
                      || (((e.created_at at time zone 'Asia/Kolkata')::date - v_start) / 7
                          - case when (e.created_at at time zone 'Asia/Kolkata')::date < v_start then 1 else 0 end) || '|' || e.visitor || '|'
                 from growth_event e where e.org_id = o and e.event in ('viewed', 'clicked'))
      || array(select 'fmade|' || (((e.created_at at time zone 'Asia/Kolkata')::date - v_start) / 7
                      - case when (e.created_at at time zone 'Asia/Kolkata')::date < v_start then 1 else 0 end) || '|' || e.new_org || '|'
                 from growth_event e where e.org_id = o and e.event = 'org_created' and e.new_org = any(v_orgs));
  end loop;
  perform set_config('pulse.org_id', v_back_org, true);
  perform set_config('pulse.viewer_id', v_back_viewer, true);

  -- Companies that joined through a deal (read across companies here, outside any one of them).
  v_facts := v_facts || array(
    select distinct 'deal|' || (((g.created_at at time zone 'Asia/Kolkata')::date - v_start) / 7
                    - case when (g.created_at at time zone 'Asia/Kolkata')::date < v_start then 1 else 0 end) || '|' || g.id || '|'
      from org g
     where g.id = any(v_orgs)
       and (exists (select 1 from pulse_priv.account_member founder
                      join pulse_priv.account_member before on before.account_id = founder.account_id
                     where founder.member_org = g.id and founder.kind = 'staff'
                       and founder.joined_at <= g.created_at + interval '1 day'
                       and before.member_org <> g.id and before.kind in ('client', 'freelancer')
                       and before.joined_at < g.created_at)
            or exists (select 1 from unnest(v_facts) f
                        where split_part(f, '|', 1) = 'fmade' and split_part(f, '|', 3) = g.id::text)
            or exists (select 1 from unnest(v_facts) f
                        where split_part(f, '|', 1) = 'party' and split_part(f, '|', 3) = g.id::text
                          and split_part(f, '|', 2)::numeric < extract(epoch from g.created_at))));
  v_facts := v_facts || array(
    select 'company|' || (w - 1) || '|' || g.id || '|' from org g cross join generate_series(1, v_weeks) w
     where g.id = any(v_orgs) and (g.created_at at time zone 'Asia/Kolkata')::date < v_ends[w]);

  with f as (
    select split_part(x, '|', 1) m, split_part(x, '|', 2) w, split_part(x, '|', 3) k, split_part(x, '|', 4) side
      from unnest(v_facts) x where split_part(x, '|', 1) <> 'party'),
  wk as (select w, v_start + 7 * w d from generate_series(0, v_weeks - 1) w),
  s as (select wk.w, wk.d,
          (select count(distinct k) from f where f.m = 'contract' and f.w = wk.w::text) contracts,
          (select count(distinct k) from f where f.m = 'deal' and f.w = wk.w::text) deals,
          (select count(distinct k) from f where f.m = 'quote' and f.w = wk.w::text) quotes,
          (select count(distinct k) from f where f.m = 'bill' and f.w = wk.w::text) bills,
          (select count(distinct k) from f where f.m = 'chat' and f.w = wk.w::text) chat,
          (select count(distinct k) from f where f.m = 'chat' and f.w = wk.w::text and f.side = 'c') chat_client,
          (select count(distinct k) from f where f.m = 'active' and f.w = wk.w::text) active,
          (select count(distinct k) from f where f.m = 'staff' and f.w = wk.w::text) staff,
          (select count(distinct k) from f where f.m = 'agent' and f.w = wk.w::text) agents,
          (select count(distinct k) from f where f.m = 'company' and f.w = wk.w::text) companies,
          (select count(distinct k) from f where f.m = 'fview' and f.w = wk.w::text) fview,
          (select count(distinct k) from f where f.m = 'fclick' and f.w = wk.w::text) fclick,
          (select count(distinct k) from f where f.m = 'fmade' and f.w = wk.w::text) fmade
        from wk)
  select jsonb_build_object(
      'asOf', now(),
      'weeks', (select jsonb_agg(to_char(d, 'YYYY-MM-DD') order by w) from s),
      'series', jsonb_build_object(
        'contractsSigned', (select jsonb_agg(contracts order by w) from s),
        'companiesViaDeal', (select jsonb_agg(deals order by w) from s),
        'quotes', (select jsonb_agg(quotes order by w) from s),
        'bills', (select jsonb_agg(bills order by w) from s),
        'chatUsers', (select jsonb_agg(chat order by w) from s),
        'chatUsersClient', (select jsonb_agg(chat_client order by w) from s),
        'activeUsers', (select jsonb_agg(active order by w) from s),
        'employees', (select jsonb_agg(staff order by w) from s),
        'aiAgents', (select jsonb_agg(agents order by w) from s),
        'companies', (select jsonb_agg(companies order by w) from s),
        'funnelViewed', (select jsonb_agg(fview order by w) from s),
        'funnelClicked', (select jsonb_agg(fclick order by w) from s),
        'funnelOrgCreated', (select jsonb_agg(fmade order by w) from s)),
      'totals', jsonb_build_object(
        'contractsSigned', (select count(distinct k) from f where m = 'contract'),
        'companiesViaDeal', (select count(distinct k) from f where m = 'deal'),
        'quotes', (select count(distinct k) from f where m = 'quote'),
        'bills', (select count(distinct k) from f where m = 'bill'),
        'chatUsers', (select count(distinct k) from f where m = 'chatall'),
        'chatUsersClient', (select count(distinct k) from f where m = 'chatall' and side = 'c'),
        'activeUsers', (select active from s where w = v_weeks - 1),
        'employees', (select staff from s where w = v_weeks - 1),
        'aiAgents', (select agents from s where w = v_weeks - 1),
        'companies', (select companies from s where w = v_weeks - 1),
        'funnelViewed', (select count(*) from (select distinct w, k from f where m = 'fview') x),
        'funnelClicked', (select count(*) from (select distinct w, k from f where m = 'fclick') x),
        'funnelOrgCreated', (select count(distinct k) from f where m = 'fmade')))
    into v_out;
  perform platform_log('investor.view', null, 'investor_metrics', null, 'Investor numbers', null, jsonb_build_object('weeks', v_weeks));
  return v_out;
end $$;
revoke all on function pulse.investor_metrics(int) from public;
grant execute on function pulse.investor_metrics(int) to pulse_api;

-- migrate:down
drop function if exists pulse.investor_metrics(int);
drop function if exists pulse.investor_viewer();
drop table if exists pulse.growth_event;
