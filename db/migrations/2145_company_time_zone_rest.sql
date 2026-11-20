-- migrate:up
-- LAND-CAPTAIN-12 (15 Nov 2026), hosted CI's test_org_time_zone (R51, 0390: "only pulse.org.time_zone may default to
-- India"). Eight functions and one column default added since 2 Nov still named India's zone by name. Each now counts in the
-- company's own zone (pulse.org_time_zone()), as 0299/0390 did for the rest. EA is in India, so EA's results do not
-- change; a company in another zone now gets its own days. One real fix with it: Calendar (2046) treated a task due at
-- 18:00 India time as "a date without a time", while a due date alone is kept at 18:00 in the company's own zone
-- (task_due_from since R51), so another zone's date-only tasks showed as 18:00 events.
-- Bodies are the current definitions (1462, 1892, 1894, 2046), changed only on the lines that named the zone.

alter table pulse.growth_event alter column day set default ((now() at time zone pulse.org_time_zone())::date);

CREATE OR REPLACE FUNCTION pulse.account_seat_looks()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare
  o text := coalesce(current_setting('pulse.org_id', true), '');
  vw text := coalesce(current_setting('pulse.viewer_id', true), '');
  s record; b record; roles text[]; title text; acc text; ca boolean; n_verify int; n_asked int; out jsonb := '[]'::jsonb;
  since date := (date_trunc('month', now() at time zone pulse.org_time_zone()) - interval '1 month')::date;
begin
  if current_viewer() is null then return out; end if;
  for s in select seat_org, seat_person, seat_kind from account_seats() limit 24 loop
    perform set_config('pulse.org_id', s.seat_org::text, true);
    perform set_config('pulse.viewer_id', '', true);
    select ob.version, ob.mark is not null has_mark, ob.accent into b from org_brand ob where ob.org_id = s.seat_org;
    select coalesce(array_agg(case when r.is_manager_of_unit then 'manager' else r.role_key end), '{}') into roles
      from role_assignment r where r.person_id = s.seat_person and current_date between r.valid_from and coalesce(r.valid_to, 'infinity');
    select pp.role into title from people_profile pp where pp.person_id = s.seat_person;
    select exists (select 1 from pulse_priv.accountant_access x where x.org_id = s.seat_org and x.person_id = s.seat_person and x.revoked_at is null) into ca;
    n_verify := null; n_asked := null;
    if ca then
      -- What waits for the CA: last month's and this month's bills, invoices and receipts not yet verified.
      select count(*) into n_verify from pulse_priv.finance_desk_record r
       where r.org_id = s.seat_org and not r.synthetic and r.kind in ('purchase','sales','reimbursement')
         and (case when r.body ->> 'date' ~ '^\d{4}-\d{2}-\d{2}' then substr(r.body ->> 'date', 1, 10)::date else r.created_at::date end) >= since
         and not exists (select 1 from pulse_priv.finance_doc_check k where k.org_id = r.org_id and not k.synthetic and k.doc_key = r.key and k.status = 'verified');
    elsif 'admin' = any(roles) or 'leadership' = any(roles) or 'finance' = any(roles) then
      select count(*) into n_asked from pulse_priv.finance_doc_check k where k.org_id = s.seat_org and not k.synthetic and k.status = 'asked';
    end if;
    perform set_config('pulse.org_id', o, true);
    perform set_config('pulse.viewer_id', vw, true);
    acc := case when s.seat_kind <> 'staff' then s.seat_kind when ca then 'accountant'
      when 'admin' = any(roles) then case when coalesce(title, '') ~* '^(owner|founder|co-founder)' then 'owner' else 'admin' end
      when 'leadership' = any(roles) then 'leadership' when 'hr' = any(roles) then 'hr' when 'finance' = any(roles) then 'finance'
      when 'manager' = any(roles) then 'manager' when roles && array['pgs', 'head_pgs'] then 'pgs' else 'member' end;
    out := out || jsonb_build_array(jsonb_build_object('id', s.seat_org, 'markVersion', case when b.has_mark then coalesce(b.version, 1) end,
      'accent', b.accent, 'access', acc, 'toVerify', n_verify, 'asked', nullif(n_asked, 0)));
  end loop;
  return out;
end $function$;

CREATE OR REPLACE FUNCTION pulse.acct_join(p_account uuid, p_invite uuid, p_hash text, p_device text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare i pulse_priv.org_invite%rowtype; a pulse_priv.pulse_account%rowtype; v_org uuid; v_person uuid; v_no int; v_user text; n int := 1;
  v_new boolean := false; v_linked boolean := false; v_side text; v_cands uuid[]; r jsonb; v_name text; v_mails text[];
begin
  select org_id into v_org from pulse_priv.org_invite where id = p_invite;
  if v_org is null then raise exception 'This invitation is no longer open' using errcode = '22023'; end if;
  perform acct_enter(v_org, null);
  select * into i from pulse_priv.org_invite where id = p_invite for update;
  if not found or i.status <> 'open' or i.expires_at <= now() then raise exception 'This invitation is no longer open' using errcode = '22023'; end if;
  select * into a from pulse_priv.pulse_account where id = p_account;
  if i.to_handle is not null and i.to_handle <> a.handle then raise exception 'This invitation is for someone else' using errcode = '42501'; end if;
  select person_id into v_person from pulse_priv.account_member where account_id = p_account and member_org = i.org_id;
  -- The invited address (proven by the mailed link), else the account's own address once it is verified.
  v_mails := array_remove(array[lower(btrim(i.to_email)),
    case when i.to_email is null and coalesce(a.email_verified_at, a.email_confirmed_at) is not null then lower(btrim(a.email)) end], null);
  if v_person is null and cardinality(v_mails) > 0 then
    select coalesce(array_agg(pp.person_id), '{}') into v_cands from people_profile pp
     where pp.org_id = i.org_id
       and (lower(btrim(pp.email)) = any(v_mails)
            or exists (select 1 from pulse_priv.hr_contact hc where hc.org_id = i.org_id and hc.person_id = pp.person_id and lower(btrim(hc.personal_email)) = any(v_mails)))
       and not exists (select 1 from pulse_priv.account_member am where am.person_id = pp.person_id);
    if cardinality(v_cands) = 1 then
      v_person := v_cands[1]; v_linked := true;
      select side into v_side from person where id = v_person;
      insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
      values (i.org_id, 'person', v_person, 'account', null, 'Linked to Pulse account @' || a.handle || case when i.to_email is not null
        then ' by an invitation to ' || i.to_email else ' by its verified e-mail ' || v_mails[1] end, null);
      perform audit_write('account_link', 'person', v_person::text, array[case when i.to_email is not null then 'invitation_email' else 'verified_email' end]);
    end if;
  end if;
  if v_person is null then
    v_new := true;
    insert into person(org_id, display_name, side, status, active_from) values (i.org_id, a.display_name, i.kind, 'active', current_date) returning id into v_person;
    select coalesce(max(user_no), 0) + 1 into v_no from people_profile where org_id = i.org_id;
    v_user := a.handle;
    while exists (select 1 from people_profile where org_id = i.org_id and username = v_user) loop n := n + 1; v_user := a.handle || '.' || n; end loop;
    insert into people_profile(org_id, person_id, role, email, username, user_no, evidence, field_sources)
    values (i.org_id, v_person, coalesce(i.title, case i.seat when 'accountant' then 'CA / accountant' when 'partner' then 'Partner' when 'vendor' then 'Vendor' end, initcap(i.kind)),
      coalesce(a.email, i.to_email), v_user, v_no, 'Joined with an invitation (@' || a.handle || ')', '{}');
    if i.seat in ('leadership', 'manager') then
      insert into role_assignment(org_id, person_id, role_key, valid_from) values (i.org_id, v_person, i.seat, current_date);
    elsif i.seat = 'partner' then
      insert into role_assignment(org_id, person_id, role_key, valid_from) values (i.org_id, v_person, 'leadership', current_date);
    end if;
  end if;
  -- CA-ACCESS: a CA's access, for a new or linked seat that holds no other role (an existing role is never overridden).
  if (v_new or v_linked) and i.seat = 'accountant' and (select side from person where id = v_person) = 'staff'
     and not exists (select 1 from role_assignment where org_id = i.org_id and person_id = v_person and current_date between valid_from and coalesce(valid_to, 'infinity')) then
    insert into pulse_priv.accountant_access(org_id, person_id, expires_on, revoked_at, granted_by, salaries)
    values (i.org_id, v_person, ((now() at time zone pulse.org_time_zone(i.org_id))::date + 365), null, i.invited_by, i.ca_salaries)
    on conflict (org_id, person_id) do update set expires_on = excluded.expires_on, revoked_at = null, granted_by = excluded.granted_by, salaries = excluded.salaries;
  end if;
  if (v_new or v_linked) and i.seat is not null then
    insert into onboarding_person(org_id, person_id, seat) values (i.org_id, v_person, i.seat) on conflict (person_id) do nothing;
  end if;
  update pulse_priv.org_invite set status = 'accepted', accepted_account = p_account, accepted_person = v_person, accepted_at = now() where id = i.id;
  perform acct_leave();
  if v_new or v_linked then
    insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (p_account, i.org_id, v_person, case when v_linked then acct_kind(v_side) else i.kind end);
  end if;
  if i.to_email is not null and i.to_email = a.email then
    update pulse_priv.pulse_account set email_verified_at = coalesce(email_verified_at, now()) where id = p_account;
  end if;
  r := acct_session(p_account, i.org_id, p_hash, p_device);
  if r is null then
    select name into v_name from org where id = i.org_id;
    return jsonb_build_object('waiting', true, 'org', i.org_id, 'name', v_name);
  end if;
  return r;
end $function$;

CREATE OR REPLACE FUNCTION pulse.calendar_items(p_days integer DEFAULT 60)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare me uuid := current_viewer(); tz text := org_time_zone(); now_ timestamptz := now(); till timestamptz;
begin
  if me is null then return '[]'::jsonb; end if;
  till := now_ + make_interval(days => least(greatest(coalesce(p_days, 60), 1), 120));
  return (select coalesce(jsonb_agg(x order by x ->> 'start'), '[]'::jsonb) from (
    select jsonb_build_object('source', 'task', 'id', t.id, 'title', t.title, 'start', t.due_at, 'minutes', coalesce(nullif(t.estimate_minutes, 0), 30),
      'status', t.status, 'project', coalesce(pr.title, pr.name), 'timeZone', tz) x
      from task t left join project pr on pr.org_id = t.org_id and pr.id = t.project_id
      where t.org_id = current_org() and coalesce(t.assignee_person_id, t.owner_id) = me and t.deleted_at is null and t.status in ('open', 'in_progress', 'blocked', 'unknown')
        and t.due_at >= date_trunc('day', now_ at time zone tz) at time zone tz and t.due_at < till
        -- A due date alone is kept as 18:00 India time (task_due_from, 0141): only a real due time goes on the calendar.
        and to_char(t.due_at at time zone tz, 'HH24:MI') <> '18:00'
    union all
    select jsonb_build_object('source', 'appointment', 'id', a.id, 'title', 'Meeting: ' || coalesce(c.display_name, 'client'), 'start', a.starts_at, 'minutes', a.minutes,
      'place', a.place, 'status', a.status, 'timeZone', tz)
      from client_appointment a left join client c on c.org_id = a.org_id and c.id = a.client_id
      where a.org_id = current_org() and a.created_by = me and a.status = 'booked' and a.starts_at >= now_ - interval '1 hour' and a.starts_at < till
    union all
    -- CALENDAR-HUB: the person's own timed events made in Pulse (Google's own events are never sent back to Google).
    select jsonb_build_object('source', 'event', 'id', e.id, 'title', e.title, 'start', e.starts_at,
      'minutes', least(600, greatest(5, (extract(epoch from e.ends_at - e.starts_at) / 60)::int)), 'place', e.place, 'note', e.note, 'timeZone', tz)
      from calendar_event e
      where e.org_id = current_org() and e.person_id = me and e.source = 'pulse' and not e.all_day
        and e.ends_at >= now_ - interval '1 hour' and e.starts_at < till
    order by 1 limit 400) s);
end $function$;

CREATE OR REPLACE FUNCTION pulse.finance_ca_people()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.person_id, 'name', p.display_name, 'until', a.expires_on, 'salaries', a.salaries,
      'active', a.revoked_at is null and a.expires_on >= (now() at time zone pulse.org_time_zone(a.org_id))::date and p.status = 'active') order by p.display_name), '[]')
    from pulse_priv.accountant_access a join person p on p.id = a.person_id
   where a.org_id = current_org() and viewer_is('admin')
$function$;

CREATE OR REPLACE FUNCTION pulse.finance_ca_valid()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
  select current_viewer() is not null and exists (
    select 1 from pulse_priv.accountant_access a
      join person p on p.org_id = a.org_id and p.id = a.person_id
      join login_session s on s.org_id = a.org_id and s.person_id = a.person_id
     where a.org_id = current_org() and a.person_id = current_viewer() and p.status = 'active' and a.revoked_at is null
       and a.expires_on >= (now() at time zone pulse.org_time_zone(a.org_id))::date
       and s.second_factor_verified and s.revoked_at is null and s.expires_at > now()
       and s.token_hash = current_setting('pulse.session_hash', true))
$function$;

CREATE OR REPLACE FUNCTION pulse.finance_close_mark(p_month date, p_item text, p_done boolean, p_synthetic boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare me uuid := current_viewer(); m date := date_trunc('month', p_month)::date;
begin
  if me is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  if is_accountant(me) then
    if not finance_ca_valid() then raise exception 'Accountant access requires unexpired membership and a two-step session' using errcode = '42501'; end if;
  else perform finance_authorize(true); end if;
  if p_item not in ('gstr1','gstr3b','tds','bank') then raise exception 'Choose GSTR-1, GSTR-3B, TDS or the bank' using errcode = '22023'; end if;
  if m is null or m > date_trunc('month', now() at time zone pulse.org_time_zone())::date or m < date '2017-07-01' then
    raise exception 'Choose a month that has started' using errcode = '22023'; end if;
  if p_done then
    insert into pulse_priv.finance_close_tick(org_id, synthetic, month, item, done_by) values (current_org(), p_synthetic, m, p_item, me)
    on conflict (org_id, synthetic, month, item) do update set done_by = excluded.done_by, at = now();
  else
    delete from pulse_priv.finance_close_tick where org_id = current_org() and synthetic = p_synthetic and month = m and item = p_item;
  end if;
  perform audit_write('finance_close_' || case when p_done then 'done' else 'undone' end, 'finance.close', to_char(m, 'YYYY-MM') || ':' || p_item);
  return coalesce((select jsonb_agg(jsonb_build_object('month', to_char(t.month, 'YYYY-MM'), 'item', t.item, 'by', pe.display_name, 'at', t.at))
    from pulse_priv.finance_close_tick t left join person pe on pe.id = t.done_by
   where t.org_id = current_org() and t.synthetic = p_synthetic and t.month = m), '[]');
end $function$;

CREATE OR REPLACE FUNCTION pulse.investor_metrics(p_weeks integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare
  v_weeks int := least(greatest(coalesce(p_weeks, 12), 4), 52);
  v_zone text := pulse.org_time_zone();
  v_today date := (now() at time zone v_zone)::date;
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
      || array(select 'contract|' || (((max(p.accepted_at) at time zone v_zone)::date - v_start) / 7 - case when (max(p.accepted_at) at time zone v_zone)::date < v_start then 1 else 0 end) || '|' || c.id || '|'
                 from contract c join contract_party p on p.contract_id = c.id and p.org_id = c.org_id
                where c.org_id = o and c.home_org = o and c.status in ('active', 'ended')
                group by c.id having bool_and(p.accepted_at is not null))
      || array(select 'party|' || extract(epoch from c.created_at) || '|' || p.party_org || '|'
                 from contract c join contract_party p on p.contract_id = c.id and p.org_id = c.org_id
                where c.org_id = o and c.home_org = o and p.party_org is not null and p.party_org <> o)
      || array(select case when d.doc_type = 'quotation' then 'quote|' else 'bill|' end
                      || (((coalesce(d.issued_at, d.created_at) at time zone v_zone)::date - v_start) / 7
                          - case when (coalesce(d.issued_at, d.created_at) at time zone v_zone)::date < v_start then 1 else 0 end) || '|' || d.id || '|'
                 from erp_document d
                where d.org_id = o and d.status <> 'draft' and d.doc_type in ('quotation', 'invoice', 'proforma'))
      -- people: one key per Pulse account (or the person, without one); AI employees and system people left out
      || array(select distinct 'chat|' || (((m.created_at at time zone v_zone)::date - v_start) / 7) || '|'
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
                 from (select s.person_id, ((s.created_at at time zone v_zone)::date - v_start) / 7 w
                         from login_session s where s.org_id = o and s.created_at >= v_start
                       union
                       select s.person_id, ((s.last_active_at at time zone v_zone)::date - v_start) / 7
                         from login_session s where s.org_id = o and s.last_active_at >= v_start
                       union
                       select m.author_id, ((m.created_at at time zone v_zone)::date - v_start) / 7
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
                      || (((e.created_at at time zone v_zone)::date - v_start) / 7
                          - case when (e.created_at at time zone v_zone)::date < v_start then 1 else 0 end) || '|' || e.visitor || '|'
                 from growth_event e where e.org_id = o and e.event in ('viewed', 'clicked'))
      || array(select 'fmade|' || (((e.created_at at time zone v_zone)::date - v_start) / 7
                      - case when (e.created_at at time zone v_zone)::date < v_start then 1 else 0 end) || '|' || e.new_org || '|'
                 from growth_event e where e.org_id = o and e.event = 'org_created' and e.new_org = any(v_orgs));
  end loop;
  perform set_config('pulse.org_id', v_back_org, true);
  perform set_config('pulse.viewer_id', v_back_viewer, true);

  -- Companies that joined through a deal (read across companies here, outside any one of them).
  v_facts := v_facts || array(
    select distinct 'deal|' || (((g.created_at at time zone v_zone)::date - v_start) / 7
                    - case when (g.created_at at time zone v_zone)::date < v_start then 1 else 0 end) || '|' || g.id || '|'
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
     where g.id = any(v_orgs) and (g.created_at at time zone v_zone)::date < v_ends[w]);

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
end $function$;

CREATE OR REPLACE FUNCTION pulse.onboard_org(p_account uuid, p jsonb, p_hash text, p_device text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare a pulse_priv.pulse_account%rowtype; v_org uuid := gen_random_uuid(); v_person uuid; v_pid uuid; v_tid uuid;
  n text := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'); h text := lower(ltrim(btrim(coalesce(p ->> 'handle', '')), '@'));
  v_code text; v_letters text; k int := 0; v_slug text; v_pack jsonb := p -> 'pack'; v_tz text := nullif(p ->> 'timeZone', '');
  v_days int[]; v_start time; v_end time; x jsonb; s text; i int; v_templates text[];
begin
  select * into a from pulse_priv.pulse_account where id = p_account;
  if not found then raise exception 'Sign in first' using errcode = '42501'; end if;
  if a.email is null or a.email_verified_at is null then raise exception 'Confirm your e-mail first: Pulse sends a 6-digit code to it' using errcode = '42501'; end if;
  if length(n) not between 2 and 80 then raise exception 'Give your company a name of 2 to 80 characters' using errcode = '22023'; end if;
  if h = '' then h := handle_suggest(n); end if;
  if h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then raise exception 'A handle is 3 to 30 lower-case letters, digits, dots or underscores' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h) then raise exception 'Someone already has @%', h using errcode = '23505'; end if;
  -- Abuse limits: three a day and five a month per account (as Start your own Pulse), and a calm ceiling for the install.
  if (select count(*) from pulse_priv.handle_name hn join pulse_priv.account_member m on m.member_org = hn.ref where hn.kind = 'org' and m.account_id = p_account
        and hn.created_at > now() - interval '1 day') >= 3
     or (select count(*) from org_onboarding where started_by_account = p_account and created_at > now() - interval '1 day') >= 3 then
    raise exception 'You started three companies today; try again tomorrow' using errcode = '54000'; end if;
  if (select count(*) from org_onboarding where started_by_account = p_account and created_at > now() - interval '30 days') >= 5 then
    raise exception 'You started five companies this month. Write to Pulse support to start another' using errcode = '54000'; end if;
  if (select count(*) from org_onboarding where created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Pulse is starting many companies right now; try again in an hour' using errcode = '54000'; end if;
  if v_tz is not null and not exists (select 1 from pg_timezone_names where name = v_tz) then raise exception 'Choose a time zone' using errcode = '22023'; end if;
  begin
    v_days := array(select distinct d::int from jsonb_array_elements_text(coalesce(p -> 'workDays', '[1,2,3,4,5]'::jsonb)) d order by 1);
    v_start := coalesce(nullif(p ->> 'dayStart', ''), '09:30')::time; v_end := coalesce(nullif(p ->> 'dayEnd', ''), '18:30')::time;
  exception when others then raise exception 'Choose working days and hours' using errcode = '22023'; end;
  if cardinality(v_days) = 0 or exists (select 1 from unnest(v_days) d where d not between 1 and 7) then raise exception 'Choose at least one working day' using errcode = '22023'; end if;
  if v_end <= v_start then raise exception 'The working day ends after it starts' using errcode = '22023'; end if;
  v_templates := array(select left(t, 40) from jsonb_array_elements_text(coalesce(p -> 'templates', '[]'::jsonb)) t limit 5);

  -- The code (2 to 4 capitals, unique): the name's initials, then more of its letters (as account_start_org).
  v_letters := upper(regexp_replace(n, '[^A-Za-z]', '', 'g')) || 'PULSEXYZ';
  v_code := left(upper(regexp_replace(initcap(n), '[^A-Z]', '', 'g')) || substr(v_letters, 2), 3);
  if length(v_code) < 2 then v_code := left(v_letters, 3); end if;
  while exists (select 1 from org where code = v_code) loop
    k := k + 1; v_code := left(v_code, 2) || chr(65 + ((k - 1) % 26)) || case when k > 26 then chr(65 + ((k - 1) / 26 - 1) % 26) else '' end;
    if k > 700 then raise exception 'Could not find a free company code' using errcode = '54000'; end if;
  end loop;
  v_slug := h; while exists (select 1 from org where slug = v_slug) loop v_slug := v_slug || 'x'; end loop;

  perform acct_enter(v_org, null);
  perform set_config('pulse.actor_account', 'Pulse account @' || a.handle, true);
  if v_tz is null then
    insert into org(id, slug, name, code, handle, status) values (v_org, v_slug, n, v_code, h, 'active');
  else
    insert into org(id, slug, name, code, handle, time_zone, status) values (v_org, v_slug, n, v_code, h, v_tz, 'active');
  end if;
  insert into hr_policy(org_id, attendance_enabled, work_days, shift_start, shift_end) values (v_org, false, v_days, v_start, v_end)
    on conflict (org_id) do update set work_days = excluded.work_days, shift_start = excluded.shift_start, shift_end = excluded.shift_end;
  insert into org_module(org_id, module, enabled) values (v_org, 'tasks', true),
    (v_org, 'chats', coalesce((p -> 'companyModules' ->> 'chats')::boolean, true)), (v_org, 'finance', coalesce((p -> 'companyModules' ->> 'finance')::boolean, true));
  if jsonb_typeof(p -> 'modulesDoc') = 'object' then
    insert into tenant_config(org_id, doc_kind, doc_key, version, body, is_active) values (v_org, 'tenant', 'modules', 1, p -> 'modulesDoc', true);
  end if;
  insert into person(org_id, display_name, side, status, active_from) values (v_org, a.display_name, 'staff', 'active', current_date) returning id into v_person;
  insert into people_profile(org_id, person_id, role, email, username, user_no, evidence, field_sources)
  values (v_org, v_person, 'Owner', a.email, a.handle, 1, 'Started this company on Pulse (@' || a.handle || ')', '{}');
  insert into role_assignment(org_id, person_id, role_key, valid_from) values (v_org, v_person, 'admin', current_date), (v_org, v_person, 'leadership', current_date);
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (v_org, 'person', v_person, 'created', null, 'Started the company from a Pulse account', null);
  perform set_config('pulse.viewer_id', v_person::text, true);
  if v_pack is not null and jsonb_typeof(v_pack) = 'object' then perform flow_pack_write(v_pack, true); end if;
  -- Starter projects from the chosen templates: an internal project each, owned by the founder, with its first steps.
  for x in select e from jsonb_array_elements(coalesce(p -> 'starters', '[]'::jsonb)) e limit 5 loop
    v_pid := (work_project_save(null, jsonb_build_object('type', 'internal', 'name', left(btrim(coalesce(x ->> 'name', 'Getting started')), 200),
      'summary', left(coalesce(x ->> 'summary', ''), 1000), 'ownerId', v_person, 'startsOn', current_date::text)) ->> 'id')::uuid;
    update work_project set template_key = left('starter:' || coalesce(nullif(x ->> 'key', ''), 'team'), 40) where org_id = v_org and project_id = v_pid;
    i := 0;
    for s in select left(btrim(t), 200) from jsonb_array_elements_text(coalesce(x -> 'steps', '[]'::jsonb)) t where length(btrim(t)) >= 2 limit 12 loop
      i := i + 1;
      insert into task(org_id, title, status, project_id, source, created_by, created_at, edited_by, updated_at, priority, position, locked)
      values (v_org, s, 'open', v_pid, 'pulse', v_person, now(), v_person, now(), 'normal', i, '{title,status,owner_id,project_id,due_label}') returning id into v_tid;
      perform task_event_add(v_tid, 'created', null, s, 'A starter step of ' || left(coalesce(x ->> 'name', 'the project'), 80));
    end loop;
  end loop;
  insert into org_onboarding(org_id, started_by_account, started_by, templates) values (v_org, p_account, v_person, v_templates);
  insert into onboarding_person(org_id, person_id, seat) values (v_org, v_person, 'leadership');
  perform audit_write('org_onboard', 'org', v_org::text);
  perform acct_leave();
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (p_account, v_org, v_person, 'staff');
  return acct_session(p_account, v_org, p_hash, p_device) || jsonb_build_object('code', v_code);
end $function$;

-- migrate:down
-- Forward-only.
