-- migrate:up
-- CA-ACCESS (owner, 8 Nov 2026: "There is no such thing as 'invite CA'. All this access is a problem. Onboarding has
-- to be simpler. For each case there is onboarding, with things written in it.")
--  1. One way in: Add people -> pick what they are. The seats gain accountant ("CA / accountant": Finance read, verify
--     and ask), partner (runs the company with you: leadership) and vendor (sends you bills: sees only what is shared
--     with them, as a client does). An invitation goes by e-mail (the API mails it) or as a private link the inviter
--     sends from their own phone by SMS or WhatsApp (nothing leaves the server; no phone number is stored). Joining as
--     accountant writes pulse_priv.accountant_access, with salaries only when the owner ticked that box.
--  2. The CA's checks: each bill, invoice or receipt is Verified or Asked about (finance_doc_check), with a comment
--     thread (finance_doc_note); the month-close list (GSTR-1, GSTR-3B, TDS, bank) is ticked as it is done
--     (finance_close_tick). Only the CA verifies or asks; founders and Finance answer in the thread.
--  3. Two-step for the CA: any finished second step on the live session counts (authenticator, passkey or e-mailed
--     code, as everywhere since 1447), so a CA who joins with their own Pulse account opens every company they serve.
--     The rest of the rule is unchanged: access unrevoked and unexpired, the person active, the session live.
--  4. Salaries: an accountant without the owner's tick gets payroll as monthly totals only ("All staff (monthly total)"),
--     never a person's line; with the tick, the per-person payroll rows too. HR records stay closed either way (the API).
--  5. The switcher (account_seat_looks, 1601) names the accountant seat and counts, per company, the documents waiting
--     for the CA (toVerify) or, for the owner, the CA's open questions (asked).
--  6. Start here for every company: pulse.onboarding_guide() is the self-started guide (onboarding_state), else the
--     person's own role steps, in their first 30 days or after joining by invitation.
-- Additive: three new tables (forced row security, tenant policy), new columns with defaults, functions replaced with
-- their old behaviour kept for the old seats.

-- ------------------------------------------------------------------------------------------------ 1. seats
alter table pulse.onboarding_person drop constraint onboarding_person_seat_check;
alter table pulse.onboarding_person add constraint onboarding_person_seat_check
  check (seat in ('leadership','manager','staff','sales','freelancer','client','accountant','partner','vendor'));
alter table pulse_priv.org_invite drop constraint org_invite_seat_check;
alter table pulse_priv.org_invite add constraint org_invite_seat_check
  check (seat is null or seat in ('leadership','manager','staff','sales','freelancer','client','accountant','partner','vendor'));
alter table pulse_priv.org_invite
  add column channel text check (channel is null or channel in ('email','sms','whatsapp','link')),
  add column to_name text check (to_name is null or length(btrim(to_name)) between 1 and 120),
  add column ca_salaries boolean not null default false;
alter table pulse_priv.accountant_access add column salaries boolean not null default false;

-- ------------------------------------------------------------------------------------------------ 2. the CA's checks
create table pulse_priv.finance_doc_check (
  org_id     uuid not null references pulse.org(id),
  synthetic  boolean not null,
  doc_key    text not null check (length(doc_key) between 1 and 200),
  status     text not null check (status in ('verified','asked')),
  by_person  uuid not null references pulse.person(id),
  at         timestamptz not null default now(),
  primary key (org_id, synthetic, doc_key)
);
create table pulse_priv.finance_doc_note (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references pulse.org(id),
  synthetic  boolean not null,
  doc_key    text not null check (length(doc_key) between 1 and 200),
  author     uuid not null references pulse.person(id),
  body       text not null check (length(btrim(body)) between 1 and 2000),
  at         timestamptz not null default now()
);
create index finance_doc_note_doc on pulse_priv.finance_doc_note (org_id, synthetic, doc_key, at);
create table pulse_priv.finance_close_tick (
  org_id     uuid not null references pulse.org(id),
  synthetic  boolean not null,
  month      date not null check (extract(day from month) = 1),
  item       text not null check (item in ('gstr1','gstr3b','tds','bank')),
  done_by    uuid not null references pulse.person(id),
  at         timestamptz not null default now(),
  primary key (org_id, synthetic, month, item)
);
do $$ declare t text; begin
  foreach t in array array['finance_doc_check','finance_doc_note','finance_close_tick'] loop
    execute format('alter table pulse_priv.%I enable row level security', t);
    execute format('alter table pulse_priv.%I force row level security', t);
    execute format('create policy tenant on pulse_priv.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('create trigger audit_mutation after insert or update or delete on pulse_priv.%I for each row execute function pulse.audit_mutation()', t);
  end loop;
end $$;

-- ------------------------------------------------------------------------------------------------ 3. two-step for the CA
-- A valid accountant now: access unrevoked and unexpired, the person active, and this request's session live and past
-- its second step (any factor). The session flag is only ever set by the sign-in functions (pulse_api cannot write it).
create function pulse.finance_ca_valid() returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select current_viewer() is not null and exists (
    select 1 from pulse_priv.accountant_access a
      join person p on p.org_id = a.org_id and p.id = a.person_id
      join login_session s on s.org_id = a.org_id and s.person_id = a.person_id
     where a.org_id = current_org() and a.person_id = current_viewer() and p.status = 'active' and a.revoked_at is null
       and a.expires_on >= (now() at time zone 'Asia/Kolkata')::date
       and s.second_factor_verified and s.revoked_at is null and s.expires_at > now()
       and s.token_hash = current_setting('pulse.session_hash', true))
$$;

create or replace function pulse.finance_desk_authorize(w boolean default false) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if is_accountant(current_viewer()) then
    if w or not finance_ca_valid() then
      raise exception 'Accountant access requires unexpired membership and a two-step session' using errcode = '42501';
    end if;
  else perform finance_authorize(w); end if;
end $$;

create or replace function pulse.erp_accountant_reads() returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$ select finance_ca_valid() $$;

-- Whether the signed-in accountant may see salaries (the owner's tick); everyone else who reads the desk: true.
create function pulse.finance_ca_salaries() returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select case when is_accountant(current_viewer()) then coalesce((select salaries from pulse_priv.accountant_access
    where org_id = current_org() and person_id = current_viewer()), false) else true end
$$;

-- ------------------------------------------------------------------------------------------------ 4. the desk's state
create or replace function pulse.finance_desk_state(synthetic_mode boolean default false) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare result jsonb; payroll jsonb; acct boolean := is_accountant(current_viewer()); pay boolean;
begin
  perform finance_desk_authorize(); perform audit_write('restricted_read', 'finance.desk');
  pay := finance_ca_salaries();
  result := jsonb_build_object('records', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'key', key, 'body', body, 'at', created_at) order by created_at, key)
      from pulse_priv.finance_desk_record where org_id = current_org() and synthetic = synthetic_mode
       and (not acct or kind in ('purchase','sales','payroll','reimbursement','vendor','close','exception'))
       and (pay or kind <> 'payroll' or body ->> 'name' = 'All staff (monthly total)')), '[]'),
    'files', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'name', name, 'mime', mime)) from pulse_priv.finance_desk_file
      where org_id = current_org() and synthetic = synthetic_mode), '[]'),
    'sends', coalesce((select jsonb_agg(jsonb_build_object('key', close_key, 'status', status)) from pulse_priv.finance_desk_send
      where org_id = current_org() and synthetic = synthetic_mode), '[]'),
    -- CA-ACCESS: what the CA verified or asked, the threads, the month-close ticks and whether salaries are shown.
    'checks', coalesce((select jsonb_agg(jsonb_build_object('key', k.doc_key, 'status', k.status, 'by', pe.display_name, 'at', k.at))
      from pulse_priv.finance_doc_check k left join person pe on pe.id = k.by_person where k.org_id = current_org() and k.synthetic = synthetic_mode), '[]'),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'key', n.doc_key, 'by', pe.display_name, 'mine', n.author = current_viewer(),
        'ca', is_accountant(n.author), 'body', n.body, 'at', n.at) order by n.at)
      from pulse_priv.finance_doc_note n left join person pe on pe.id = n.author where n.org_id = current_org() and n.synthetic = synthetic_mode), '[]'),
    'ticks', coalesce((select jsonb_agg(jsonb_build_object('month', to_char(t.month, 'YYYY-MM'), 'item', t.item, 'by', pe.display_name, 'at', t.at))
      from pulse_priv.finance_close_tick t left join person pe on pe.id = t.done_by where t.org_id = current_org() and t.synthetic = synthetic_mode), '[]'),
    'salaries', pay,
    'org', (select name from org where id = current_org()));
  -- Accountant gets financial payroll fields only, and per person only with the owner's tick (totals always).
  if not synthetic_mode then
    payroll := (select coalesce(jsonb_agg(e), '[]') from jsonb_array_elements(finance_desk_payroll_rows()) e
      where pay or e -> 'body' ->> 'name' = 'All staff (monthly total)');
    result := jsonb_set(result, '{records}', (result -> 'records') || payroll);
  end if;
  return result;
end $$;

-- The people with CA access here (for the owner's Access card): name, until, salaries, revoked.
create function pulse.finance_ca_people() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.person_id, 'name', p.display_name, 'until', a.expires_on, 'salaries', a.salaries,
      'active', a.revoked_at is null and a.expires_on >= (now() at time zone 'Asia/Kolkata')::date and p.status = 'active') order by p.display_name), '[]')
    from pulse_priv.accountant_access a join person p on p.id = a.person_id
   where a.org_id = current_org() and viewer_is('admin')
$$;

-- The owner changes a CA's salaries tick, or ends their access (the CA is signed out either way, as accountant_grant does).
create function pulse.finance_ca_set(p_person uuid, p_salaries boolean, p_end boolean default false) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is null or not viewer_is('admin') then raise exception 'Only an admin changes what the CA sees' using errcode = '42501'; end if;
  if not exists (select 1 from pulse_priv.accountant_access where org_id = current_org() and person_id = p_person) then
    raise exception 'This person is not your CA' using errcode = 'P0002'; end if;
  update pulse_priv.accountant_access set salaries = coalesce(p_salaries, salaries), revoked_at = case when p_end then now() else revoked_at end
   where org_id = current_org() and person_id = p_person;
  perform auth_end_sessions('staff', p_person);
  perform audit_write(case when p_end then 'accountant_revoked' else 'accountant_access' end, 'finance.accountant', p_person::text);
  return finance_ca_people();
end $$;

-- A finance document the CA can check: a purchase bill, a sales invoice or a reimbursement receipt in the register.
create function pulse.finance_doc_exists(p_key text, p_synthetic boolean) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (select 1 from pulse_priv.finance_desk_record where org_id = current_org() and synthetic = p_synthetic and key = p_key
    and kind in ('purchase','sales','reimbursement'))
$$;

create function pulse.finance_doc_thread(p_key text, p_synthetic boolean) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('key', p_key,
    'check', (select jsonb_build_object('key', k.doc_key, 'status', k.status, 'by', pe.display_name, 'at', k.at) from pulse_priv.finance_doc_check k
      left join person pe on pe.id = k.by_person where k.org_id = current_org() and k.synthetic = p_synthetic and k.doc_key = p_key),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'key', n.doc_key, 'by', pe.display_name, 'mine', n.author = current_viewer(),
        'ca', is_accountant(n.author), 'body', n.body, 'at', n.at) order by n.at)
      from pulse_priv.finance_doc_note n left join person pe on pe.id = n.author
     where n.org_id = current_org() and n.synthetic = p_synthetic and n.doc_key = p_key), '[]'))
$$;

-- The CA marks a document Verified, Asks about it (a question is required), or reopens it (null).
create function pulse.finance_doc_mark(p_key text, p_status text, p_note text default null, p_synthetic boolean default false) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); q text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if me is null or not is_accountant(me) then raise exception 'Only your CA marks a bill verified or asks about it' using errcode = '42501'; end if;
  if not finance_ca_valid() then raise exception 'Accountant access requires unexpired membership and a two-step session' using errcode = '42501'; end if;
  if p_status is not null and p_status not in ('verified','asked') then raise exception 'Choose Verified or Ask' using errcode = '22023'; end if;
  if not finance_doc_exists(p_key, p_synthetic) then raise exception 'This bill or invoice is not in the books' using errcode = 'P0002'; end if;
  if p_status = 'asked' and q is null then raise exception 'Write your question' using errcode = '22023'; end if;
  if q is not null and length(q) > 2000 then raise exception 'Keep it under 2,000 characters' using errcode = '22023'; end if;
  if p_status is null then
    delete from pulse_priv.finance_doc_check where org_id = current_org() and synthetic = p_synthetic and doc_key = p_key;
  else
    insert into pulse_priv.finance_doc_check(org_id, synthetic, doc_key, status, by_person) values (current_org(), p_synthetic, p_key, p_status, me)
    on conflict (org_id, synthetic, doc_key) do update set status = excluded.status, by_person = excluded.by_person, at = now();
  end if;
  if q is not null then
    insert into pulse_priv.finance_doc_note(org_id, synthetic, doc_key, author, body) values (current_org(), p_synthetic, p_key, me, q);
  end if;
  perform audit_write('finance_doc_' || coalesce(p_status, 'reopened'), 'finance.doc', p_key);
  return finance_doc_thread(p_key, p_synthetic);
end $$;

-- A comment on a document: the CA, or anyone who reads Finance here (founders, Finance) answering.
create function pulse.finance_doc_note_add(p_key text, p_body text, p_synthetic boolean default false) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); b text := btrim(coalesce(p_body, ''));
begin
  if me is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  perform finance_desk_authorize(false);
  if length(b) not between 1 and 2000 then raise exception 'Write a comment of up to 2,000 characters' using errcode = '22023'; end if;
  if not finance_doc_exists(p_key, p_synthetic) then raise exception 'This bill or invoice is not in the books' using errcode = 'P0002'; end if;
  insert into pulse_priv.finance_doc_note(org_id, synthetic, doc_key, author, body) values (current_org(), p_synthetic, p_key, me, b);
  perform audit_write('finance_doc_note', 'finance.doc', p_key);
  return finance_doc_thread(p_key, p_synthetic);
end $$;

-- A month-close step done (or undone): the CA, or a founder / Finance writer who files it themselves.
create function pulse.finance_close_mark(p_month date, p_item text, p_done boolean, p_synthetic boolean default false) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); m date := date_trunc('month', p_month)::date;
begin
  if me is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  if is_accountant(me) then
    if not finance_ca_valid() then raise exception 'Accountant access requires unexpired membership and a two-step session' using errcode = '42501'; end if;
  else perform finance_authorize(true); end if;
  if p_item not in ('gstr1','gstr3b','tds','bank') then raise exception 'Choose GSTR-1, GSTR-3B, TDS or the bank' using errcode = '22023'; end if;
  if m is null or m > date_trunc('month', now() at time zone 'Asia/Kolkata')::date or m < date '2017-07-01' then
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
end $$;

-- ------------------------------------------------------------------------------------------------ 5. invitations
-- Rows [{ seat, channel, email?, name?, hash, title?, caSalaries? }]: channel email (mailed by the API) or sms /
-- whatsapp / link (the private link is shown once to the inviter, who sends it from their own phone). A CA is added by
-- an admin only (as accountant_grant always required); partners by admins and leadership.
create or replace function pulse.onboard_invites(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare x jsonb; e text; s text; ch text; nm text; v_out jsonb := '[]'::jsonb; v_id uuid; v_today int; v_n int := jsonb_array_length(coalesce(p -> 'rows', '[]'::jsonb));
begin
  if current_viewer() is null or not viewer_is('admin', 'leadership', 'hr') then
    raise exception 'Admins, HR and leadership invite people into the organisation' using errcode = '42501'; end if;
  if v_n = 0 then raise exception 'Add at least one e-mail address' using errcode = '22023'; end if;
  if v_n > 50 then raise exception 'Invite up to 50 people at a time' using errcode = '22023'; end if;
  select count(*) into v_today from pulse_priv.org_invite where org_id = current_org() and created_at > now() - interval '1 day';
  if v_today + v_n > 200 then raise exception 'Up to 200 invitations a day; send the rest tomorrow' using errcode = '54000'; end if;
  for x in select * from jsonb_array_elements(p -> 'rows') loop
    s := coalesce(nullif(x ->> 'seat', ''), 'staff'); ch := coalesce(nullif(x ->> 'channel', ''), 'email');
    e := lower(btrim(coalesce(x ->> 'email', ''))); nm := nullif(left(regexp_replace(btrim(coalesce(x ->> 'name', '')), '\s+', ' ', 'g'), 120), '');
    if s not in ('leadership','manager','staff','sales','freelancer','client','accountant','partner','vendor') then
      raise exception 'Choose what they are for %', coalesce(nullif(e, ''), nm, 'this person') using errcode = '22023'; end if;
    if ch not in ('email','sms','whatsapp','link') then raise exception 'Send the link by e-mail, SMS or WhatsApp' using errcode = '22023'; end if;
    if s = 'accountant' and not viewer_is('admin') then raise exception 'Only an admin adds a CA or accountant' using errcode = '42501'; end if;
    if s in ('leadership','partner') and not viewer_is('admin', 'leadership') then raise exception 'Only an admin or leadership adds a partner' using errcode = '42501'; end if;
    if coalesce(x ->> 'hash', '') !~ '^[0-9a-f]{64}$' then
      v_out := v_out || jsonb_build_object('email', e, 'name', nm, 'seat', s, 'channel', ch, 'status', 'invalid'); continue; end if;
    if ch = 'email' then
      if e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(e) > 254 then
        v_out := v_out || jsonb_build_object('email', e, 'seat', s, 'channel', ch, 'status', 'invalid'); continue; end if;
      if exists (select 1 from people_profile pp join person pe on pe.id = pp.person_id where pp.org_id = current_org() and lower(pp.email) = e and pe.status = 'active')
         or exists (select 1 from pulse_priv.account_member m join pulse_priv.pulse_account a on a.id = m.account_id where m.member_org = current_org() and a.email = e) then
        v_out := v_out || jsonb_build_object('email', e, 'seat', s, 'channel', ch, 'status', 'member'); continue; end if;
      update pulse_priv.org_invite set status = 'revoked' where org_id = current_org() and to_email = e and status = 'open';
    else e := null; end if;
    insert into pulse_priv.org_invite(org_id, kind, title, to_email, seat, token_hash, invited_by, channel, to_name, ca_salaries)
    values (current_org(), case s when 'freelancer' then 'freelancer' when 'client' then 'client' when 'vendor' then 'client' else 'staff' end,
      nullif(left(btrim(coalesce(x ->> 'title', '')), 80), ''), e, s, x ->> 'hash', current_viewer(), ch, nm,
      s = 'accountant' and coalesce((x ->> 'caSalaries')::boolean, false))
    returning id into v_id;
    perform audit_write('invite', 'org_invite', v_id::text);
    v_out := v_out || jsonb_build_object('id', v_id, 'email', e, 'name', nm, 'seat', s, 'channel', ch, 'status', 'created',
      'hasAccount', e is not null and exists (select 1 from pulse_priv.pulse_account where email = e));
  end loop;
  return v_out;
end $$;

create or replace function pulse.org_invite_list() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'title', i.title, 'toHandle', i.to_handle, 'link', i.token_hash is not null,
    'email', i.to_email, 'seat', i.seat, 'mailed', i.mailed_at is not null, 'channel', i.channel, 'name', i.to_name, 'caSalaries', i.ca_salaries,
    'status', case when i.status = 'open' and i.expires_at <= now() then 'expired' else i.status end, 'at', i.created_at, 'expiresAt', i.expires_at,
    'by', (select display_name from person where id = i.invited_by), 'who', (select display_name from person where id = i.accepted_person)) order by i.created_at desc), '[]'::jsonb)
  from pulse_priv.org_invite i where i.org_id = current_org() and viewer_is('admin', 'leadership', 'hr') and i.created_at > now() - interval '90 days'
$$;

-- What an invitation link is for: now with the seat for every link (the join page says what they will see and do).
create or replace function pulse.org_invite_peek(p_hash text) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('org', o.name, 'orgHandle', o.handle, 'kind', i.kind, 'title', i.title)
    || case when i.seat is null then '{}'::jsonb else jsonb_build_object('seat', i.seat, 'caSalaries', i.ca_salaries) end
    || case when i.to_email is null then '{}'::jsonb else jsonb_build_object('email', i.to_email,
      'hasAccount', exists (select 1 from pulse_priv.pulse_account a where a.email = i.to_email)) end
  from pulse_priv.org_invite i join org o on o.id = i.org_id
  where i.token_hash = p_hash and i.status = 'open' and i.expires_at > now() and o.status = 'active'
$$;

-- Joining (1540's, unchanged for the old seats): a partner is leadership; a CA gets accountant access (a year, renewed
-- by the owner; salaries as ticked) when they hold no other role; a vendor joins on the client side (kind client).
-- The seat is now recorded in every company, for the start-here steps.
create or replace function pulse.acct_join(p_account uuid, p_invite uuid, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
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
    values (i.org_id, v_person, ((now() at time zone 'Asia/Kolkata')::date + 365), null, i.invited_by, i.ca_salaries)
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
end $$;

-- ------------------------------------------------------------------------------------------------ 6. the switcher
create or replace function pulse.account_seat_looks() returns jsonb
  language plpgsql security definer set search_path to 'pulse', 'pg_temp' as $function$
declare
  o text := coalesce(current_setting('pulse.org_id', true), '');
  vw text := coalesce(current_setting('pulse.viewer_id', true), '');
  s record; b record; roles text[]; title text; acc text; ca boolean; n_verify int; n_asked int; out jsonb := '[]'::jsonb;
  since date := (date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '1 month')::date;
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

-- ------------------------------------------------------------------------------------------------ 7. start here
create or replace function pulse.onboarding_seat(p_person uuid) returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select seat from onboarding_person where org_id = current_org() and person_id = p_person),
    case when is_accountant(p_person) then 'accountant'
         when viewer_is('admin', 'leadership') then 'leadership'
         when (select side from person where id = p_person) in ('freelancer', 'client') then (select side from person where id = p_person)
         when viewer_is('manager') then 'manager' else 'staff' end)
$$;

-- The first-run guide for the signed-in person: a self-started company's (onboarding_state), else their own role's
-- steps in any company, in their first 30 days or after joining by an invitation (until they put it away); p_any:
-- always (the Start here page).
create function pulse.onboarding_guide(p_any boolean default false) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); g jsonb; r onboarding_person%rowtype; since date;
begin
  if me is null then return null; end if;
  g := onboarding_state();
  if g is not null then return g; end if;
  select * into r from onboarding_person where org_id = current_org() and person_id = me;
  select active_from into since from person where id = me;
  if not p_any and r.person_id is null and coalesce(since, date '2000-01-01') < current_date - 30 then return null; end if;
  return jsonb_build_object('org', (select name from org where id = current_org()), 'seat', onboarding_seat(me), 'lead', false, 'roleSteps', true,
    'dismissed', r.dismissed_at is not null, 'templates', '[]'::jsonb, 'startedAt', null, 'items', '[]'::jsonb);
end $$;

-- Tick an item (self-started companies) or put the guide away (any company).
create or replace function pulse.onboarding_mark(p_item text, p_done boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer();
begin
  if me is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  if p_item <> 'dismissed' and not exists (select 1 from org_onboarding where org_id = current_org()) then
    raise exception 'This company has no getting-started guide' using errcode = 'P0002'; end if;
  if p_item not in ('invite', 'project', 'targets', 'app', 'dismissed', 'client', 'appointment', 'invoice', 'todo', 'words') then raise exception 'Choose an item' using errcode = '22023'; end if;
  insert into onboarding_person(org_id, person_id, seat) values (current_org(), me, onboarding_seat(me)) on conflict (person_id) do nothing;
  if p_item = 'dismissed' then
    update onboarding_person set dismissed_at = case when p_done then now() end where org_id = current_org() and person_id = me;
  else
    update onboarding_person set done = case when p_done then array(select distinct x from unnest(done || p_item) x) else array_remove(done, p_item) end
     where org_id = current_org() and person_id = me;
  end if;
  return onboarding_guide();
end $$;

revoke all on function pulse.finance_ca_valid(), pulse.finance_ca_salaries(), pulse.finance_ca_people(), pulse.finance_ca_set(uuid, boolean, boolean),
  pulse.finance_doc_exists(text, boolean), pulse.finance_doc_thread(text, boolean), pulse.finance_doc_mark(text, text, text, boolean),
  pulse.finance_doc_note_add(text, text, boolean), pulse.finance_close_mark(date, text, boolean, boolean), pulse.onboarding_guide(boolean) from public;
grant execute on function pulse.finance_ca_valid(), pulse.finance_ca_salaries(), pulse.finance_ca_people(), pulse.finance_ca_set(uuid, boolean, boolean),
  pulse.finance_doc_mark(text, text, text, boolean), pulse.finance_doc_note_add(text, text, boolean), pulse.finance_close_mark(date, text, boolean, boolean),
  pulse.onboarding_guide(boolean) to pulse_api;

-- migrate:down
drop function if exists pulse.onboarding_guide(boolean);
drop function if exists pulse.finance_close_mark(date, text, boolean, boolean);
drop function if exists pulse.finance_doc_note_add(text, text, boolean);
drop function if exists pulse.finance_doc_mark(text, text, text, boolean);
drop function if exists pulse.finance_doc_thread(text, boolean);
drop function if exists pulse.finance_doc_exists(text, boolean);
drop function if exists pulse.finance_ca_set(uuid, boolean, boolean);
drop function if exists pulse.finance_ca_people();
drop function if exists pulse.finance_ca_salaries();
drop table if exists pulse_priv.finance_close_tick;
drop table if exists pulse_priv.finance_doc_note;
drop table if exists pulse_priv.finance_doc_check;
