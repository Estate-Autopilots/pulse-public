-- migrate:up
-- SELFSERVE-P1 (real-phone QA, 5 Nov 2026): three P1s in companies started through self-serve sign-up on the shared
-- address (not the install's own company).
--
--  1. A set-password link ("Copy link", an invitation, a reset) or a one-time sign-in link of a self-started company
--     always said "This link is unavailable": the shared address opens the install's company, and auth_redeem /
--     auth_link_sign_in look only there. Now, at the shared address only, a link that is not the install company's is
--     looked up by its token (the token is the secret) in every active organisation, each read under its own row
--     security, and redeemed inside its own organisation exactly as before (auth_redeem / auth_link_sign_in unchanged).
--     The session it opens is an account session (via 'account'), the one kind that travels to the shared address
--     (pulse.session_org), and the person gets a Pulse account seat (account_ensure) so the shared sign-in finds them
--     later. A company's own address, the client portal and every other check are unchanged.
--  2. A person HR added who later joined with the invitation link became a second person of the same name, and the
--     pickers (pulse.work_people) kept the HR record without a sign-in, hiding the real account. Joining now also links
--     the company's earlier record by the account's verified e-mail (as well as the invited e-mail), matching the
--     record's work or personal e-mail; and work_people never hides anyone who signs in (a Pulse account seat, a
--     password or a linked account): only records without a sign-in collapse into a same-named person who has one.
--  3. The founder of a company started at sign-up (or from Start your own Pulse, or from a client invitation) was admin
--     only, so Finance and Billing (money_can: leadership, or admin with a money permission) refused them. A founder is
--     admin and leadership, as onboard_org (1462) already makes them; existing founders get leadership once.

-- ------------------------------------------------------------------------------------------------ 1. links of other companies
-- The organisation a staff link token belongs to, when it is not the shared address's own (null otherwise). Internal.
create function pulse.auth_link_away(r text, h text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare here uuid := current_org(); o uuid; hit uuid;
begin
  if r is distinct from 'staff' or here is null or here is distinct from install_org() or coalesce(h, '') !~ '^[a-f0-9]{64}$' then return null; end if;
  if exists (select 1 from pulse_priv.auth_link where org_id = here and token_hash = h)
     or exists (select 1 from pulse_priv.staff_invitation where org_id = here and token_hash = h) then return null; end if;
  for o in select id from org where status = 'active' and id <> here loop
    perform set_config('pulse.org_id', o::text, true);
    if exists (select 1 from pulse_priv.auth_link where org_id = o and realm = 'staff' and token_hash = h)
       or exists (select 1 from pulse_priv.staff_invitation where org_id = o and token_hash = h) then hit := o; exit; end if;
  end loop;
  perform set_config('pulse.org_id', here::text, true);
  return hit;
end $$;

-- After a link opened a session in another organisation: it travels to the shared address, with an account seat.
create function pulse.auth_link_travel(p_hash text, p_person uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid;
begin
  update login_session set via = 'account' where org_id = current_org() and token_hash = p_hash and person_id = p_person and revoked_at is null;
  if not found then return; end if;
  perform set_config('pulse.viewer_id', p_person::text, true);
  v := account_ensure();
  update pulse_priv.account_member set last_used_at = now() where account_id = v and member_org = current_org();
  update pulse_priv.pulse_account set last_org = current_org(), updated_at = now() where id = v;
end $$;

create function pulse.auth_redeem_link(r text, h text, password text, code text, session_hash text, d text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare away uuid := auth_link_away(r, h); result jsonb;
begin
  if away is not null then perform set_config('pulse.org_id', away::text, true); perform set_config('pulse.viewer_id', '', true); end if;
  result := auth_redeem(r, h, password, code, session_hash, d);
  if away is not null and result ? 'expiresAt' then
    perform auth_link_travel(session_hash, (result ->> 'actor')::uuid);
    result := result || jsonb_build_object('org', away);
  end if;
  return result;
end $$;

create function pulse.auth_link_sign_in_any(r text, h text, code text, session_hash text, d text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare away uuid := auth_link_away(r, h); result jsonb;
begin
  if away is not null then perform set_config('pulse.org_id', away::text, true); perform set_config('pulse.viewer_id', '', true); end if;
  result := auth_link_sign_in(r, h, code, session_hash, d);
  if away is not null and result ? 'expiresAt' then
    perform auth_link_travel(session_hash, (result ->> 'actor')::uuid);
    result := result || jsonb_build_object('org', away);
  end if;
  return result;
end $$;
revoke all on function pulse.auth_link_away(text, text), pulse.auth_link_travel(text, uuid),
  pulse.auth_redeem_link(text, text, text, text, text, text), pulse.auth_link_sign_in_any(text, text, text, text, text) from public;
grant execute on function pulse.auth_redeem_link(text, text, text, text, text, text), pulse.auth_link_sign_in_any(text, text, text, text, text) to pulse_api;

-- ------------------------------------------------------------------------------------------------ 2. one person, the real account
-- Pickers: everyone who signs in, plus records without a sign-in that no same-named person who signs in stands for
-- (those collapse to one, as 0182: roles, then work, then the oldest).
create or replace function pulse.work_people() returns table(id uuid) language sql stable security definer set search_path=pulse,pg_temp as $$
 with c as (
  select p.id, lower(regexp_replace(btrim(p.display_name),'\s+',' ','g')) k, p.created_at,
   (exists(select 1 from account a where a.org_id=p.org_id and a.holder_person_id=p.id)
    or exists(select 1 from login_credential l where l.org_id=p.org_id and l.person_id=p.id and l.status='active')
    or exists(select 1 from pulse_priv.account_member m where m.member_org=p.org_id and m.person_id=p.id)) signs_in
  from person p where p.org_id=current_org() and p.side='staff' and p.status='active')
 select c.id from c where c.signs_in
 union all
 select x.id from (
  select distinct on (c.k) c.id from c
   where not c.signs_in and not exists(select 1 from c s where s.k=c.k and s.signs_in)
   order by c.k,
    exists(select 1 from role_assignment r where r.org_id=current_org() and r.person_id=c.id and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) desc,
    (select count(*) from task t where t.org_id=current_org() and coalesce(t.assignee_person_id,t.owner_id)=c.id) desc, c.created_at, c.id) x
$$;

-- Joining (1463) links the company's earlier record by the invited e-mail or, without one (a shared invitation link),
-- by the joining account's verified e-mail; the record's work e-mail or the personal e-mail HR keeps both count. Exactly
-- one record, not yet on any account; otherwise a new person as before. Body otherwise 1463's.
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
    values (i.org_id, v_person, coalesce(i.title, initcap(i.kind)), coalesce(a.email, i.to_email), v_user, v_no, 'Joined with an invitation (@' || a.handle || ')', '{}');
    if i.seat in ('leadership', 'manager') then
      insert into role_assignment(org_id, person_id, role_key, valid_from) values (i.org_id, v_person, i.seat, current_date);
    end if;
  end if;
  if (v_new or v_linked) and i.seat is not null and exists (select 1 from org_onboarding where org_id = i.org_id) then
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

-- ------------------------------------------------------------------------------------------------ 3. founders run Finance
-- The three ways an organisation is started from a Pulse account make its founder admin and leadership (bodies otherwise
-- 1115's, 1462's and 0953's).
create or replace function pulse.account_signup(p jsonb, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare v uuid; h text := lower(ltrim(btrim(coalesce(p ->> 'handle', '')), '@')); e text := nullif(lower(btrim(coalesce(p ->> 'email', ''))), '');
  n text := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'); o text := regexp_replace(btrim(coalesce(p ->> 'orgName', '')), '\s+', ' ', 'g');
  oh text; v_org uuid := gen_random_uuid(); v_person uuid; v_code text; v_letters text; k int := 0; v_slug text;
begin
  if length(n) not between 2 and 120 then raise exception 'Give your name' using errcode = '22023'; end if;
  if h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then raise exception 'A handle is 3 to 30 lower-case letters, digits, dots or underscores' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h) then raise exception 'Someone already has @%', h using errcode = '23505'; end if;
  if e is null or e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Give your e-mail address' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.pulse_account where email = e) then raise exception 'That e-mail already has a Pulse account: sign in instead' using errcode = '23505'; end if;
  if length(o) not between 2 and 80 then raise exception 'Give your organisation a name of 2 to 80 characters' using errcode = '22023'; end if;
  insert into pulse_priv.pulse_account(handle, display_name, email, password_hash) values (h, n, e, crypt(p ->> 'password', gen_salt('bf', 10))) returning id into v;
  insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', v);
  oh := handle_suggest(o);
  -- The code (2 to 4 capitals, unique): the name's initials, then more of its letters (as account_start_org).
  v_letters := upper(regexp_replace(o, '[^A-Za-z]', '', 'g')) || 'PULSEXYZ';
  v_code := left(upper(regexp_replace(initcap(o), '[^A-Z]', '', 'g')) || substr(v_letters, 2), 3);
  if length(v_code) < 2 then v_code := left(v_letters, 3); end if;
  while exists (select 1 from org where code = v_code) loop
    k := k + 1; v_code := left(v_code, 2) || chr(65 + ((k - 1) % 26)) || case when k > 26 then chr(65 + ((k - 1) / 26 - 1) % 26) else '' end;
    if k > 700 then raise exception 'Could not find a free organisation code' using errcode = '54000'; end if;
  end loop;
  v_slug := oh; while exists (select 1 from org where slug = v_slug) loop v_slug := v_slug || 'x'; end loop;
  perform acct_enter(v_org, null);
  perform set_config('pulse.actor_account', 'Pulse account @' || h, true);
  insert into org(id, slug, name, code, handle) values (v_org, v_slug, o, v_code, oh);
  insert into hr_policy(org_id, attendance_enabled) values (v_org, false) on conflict (org_id) do nothing;
  insert into org_module(org_id, module, enabled) values (v_org, 'tasks', true), (v_org, 'chats', true), (v_org, 'finance', true);
  insert into person(org_id, display_name, side, status, active_from) values (v_org, n, 'staff', 'active', current_date) returning id into v_person;
  insert into people_profile(org_id, person_id, role, email, username, user_no, evidence, field_sources)
  values (v_org, v_person, 'Owner', e, h, 1, 'Started this organisation (@' || h || ')', '{}');
  insert into role_assignment(org_id, person_id, role_key, valid_from) values (v_org, v_person, 'admin', current_date), (v_org, v_person, 'leadership', current_date);
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (v_org, 'person', v_person, 'created', null, 'Signed up to Pulse and started the organisation', null);
  perform acct_leave();
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (v, v_org, v_person, 'staff');
  return acct_session(v, v_org, p_hash, p_device) || jsonb_build_object('code', v_code);
end $$;

create or replace function pulse.account_start_org(p jsonb, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure(); a pulse_priv.pulse_account%rowtype; v_org uuid := gen_random_uuid(); v_person uuid;
  n text := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'); h text := lower(ltrim(btrim(coalesce(p ->> 'handle', '')), '@'));
  v_code text; v_letters text; k int := 0; v_pack jsonb := p -> 'pack'; v_slug text;
begin
  if not account_email_ok(v) then raise exception 'Confirm your e-mail first: Pulse sends a 6-digit code to it' using errcode = '42501'; end if;
  if length(n) not between 2 and 80 then raise exception 'Give your organisation a name of 2 to 80 characters' using errcode = '22023'; end if;
  if h = '' then h := handle_suggest(n); end if;
  if h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then raise exception 'A handle is 3 to 30 lower-case letters, digits, dots or underscores' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h) then raise exception 'Someone already has @%', h using errcode = '23505'; end if;
  if (select count(*) from pulse_priv.handle_name hn join pulse_priv.account_member m on m.member_org = hn.ref where hn.kind = 'org' and m.account_id = v
        and hn.created_at > now() - interval '1 day') >= 3 then
    raise exception 'You started three organisations today; try again tomorrow' using errcode = '54000'; end if;
  select * into a from pulse_priv.pulse_account where id = v;
  v_letters := upper(regexp_replace(n, '[^A-Za-z]', '', 'g')) || 'PULSEXYZ';
  v_code := left(upper(regexp_replace(initcap(n), '[^A-Z]', '', 'g')) || substr(v_letters, 2), 3);
  if length(v_code) < 2 then v_code := left(v_letters, 3); end if;
  while exists (select 1 from org where code = v_code) loop
    k := k + 1; v_code := left(v_code, 2) || chr(65 + ((k - 1) % 26)) || case when k > 26 then chr(65 + ((k - 1) / 26 - 1) % 26) else '' end;
    if k > 700 then raise exception 'Could not find a free organisation code' using errcode = '54000'; end if;
  end loop;
  v_slug := h; while exists (select 1 from org where slug = v_slug) loop v_slug := v_slug || 'x'; end loop;
  perform acct_enter(v_org, null);
  perform set_config('pulse.actor_account', 'Pulse account @' || a.handle, true);
  insert into org(id, slug, name, code, handle) values (v_org, v_slug, n, v_code, h);
  insert into hr_policy(org_id, attendance_enabled) values (v_org, false) on conflict (org_id) do nothing;
  insert into org_module(org_id, module, enabled) values (v_org, 'tasks', true), (v_org, 'chats', true), (v_org, 'finance', true);
  insert into person(org_id, display_name, side, status, active_from) values (v_org, a.display_name, 'staff', 'active', current_date) returning id into v_person;
  insert into people_profile(org_id, person_id, role, email, username, user_no, evidence, field_sources)
  values (v_org, v_person, 'Owner', a.email, a.handle, 1, 'Started this organisation (@' || a.handle || ')', '{}');
  insert into role_assignment(org_id, person_id, role_key, valid_from) values (v_org, v_person, 'admin', current_date), (v_org, v_person, 'leadership', current_date);
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (v_org, 'person', v_person, 'created', null, 'Started the organisation from a Pulse account', null);
  if v_pack is not null and jsonb_typeof(v_pack) = 'object' then
    perform set_config('pulse.viewer_id', v_person::text, true);
    perform flow_pack_write(v_pack, true);
  end if;
  perform acct_leave();
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (v, v_org, v_person, 'staff');
  return acct_session(v, v_org, p_hash, p_device) || jsonb_build_object('code', v_code);
end $$;

create or replace function pulse.connect_org_create(p_account uuid, p_name text, p_handle text, p_pack jsonb) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a pulse_priv.pulse_account%rowtype; v_org uuid := gen_random_uuid(); v_person uuid;
  n text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); h text := lower(ltrim(btrim(coalesce(p_handle, '')), '@'));
  v_code text; v_letters text; k int := 0; v_slug text;
begin
  if length(n) not between 2 and 80 then raise exception 'Give your organisation a name of 2 to 80 characters' using errcode = '22023'; end if;
  if h = '' then h := handle_suggest(n); end if;
  if h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then raise exception 'An organisation handle is 3 to 30 lower-case letters, digits, dots or underscores' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h) then raise exception 'Someone already has @%: choose another handle for your organisation', h using errcode = '23505'; end if;
  select * into a from pulse_priv.pulse_account where id = p_account;
  v_letters := upper(regexp_replace(n, '[^A-Za-z]', '', 'g')) || 'PULSEXYZ';
  v_code := left(upper(regexp_replace(initcap(n), '[^A-Z]', '', 'g')) || substr(v_letters, 2), 3);
  if length(v_code) < 2 then v_code := left(v_letters, 3); end if;
  while exists (select 1 from org where code = v_code) loop
    k := k + 1; v_code := left(v_code, 2) || chr(65 + ((k - 1) % 26)) || case when k > 26 then chr(65 + ((k - 1) / 26 - 1) % 26) else '' end;
    if k > 700 then raise exception 'Could not find a free organisation code' using errcode = '54000'; end if;
  end loop;
  v_slug := h; while exists (select 1 from org where slug = v_slug) loop v_slug := v_slug || 'x'; end loop;
  perform acct_enter(v_org, null);
  perform set_config('pulse.actor_account', 'Pulse account @' || a.handle, true);
  insert into org(id, slug, name, code, handle) values (v_org, v_slug, n, v_code, h);
  insert into hr_policy(org_id, attendance_enabled) values (v_org, false) on conflict (org_id) do nothing;
  insert into org_module(org_id, module, enabled) values (v_org, 'tasks', true), (v_org, 'chats', true), (v_org, 'finance', true);
  insert into person(org_id, display_name, side, status, active_from) values (v_org, a.display_name, 'staff', 'active', current_date) returning id into v_person;
  insert into people_profile(org_id, person_id, role, email, username, user_no, evidence, field_sources)
  values (v_org, v_person, 'Owner', a.email, a.handle, 1, 'Started this organisation from a client invitation (@' || a.handle || ')', '{}');
  insert into role_assignment(org_id, person_id, role_key, valid_from) values (v_org, v_person, 'admin', current_date), (v_org, v_person, 'leadership', current_date);
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (v_org, 'person', v_person, 'created', null, 'Started the organisation from a client invitation', null);
  if p_pack is not null and jsonb_typeof(p_pack) = 'object' then
    perform set_config('pulse.viewer_id', v_person::text, true);
    perform flow_pack_write(p_pack, true);
  end if;
  perform acct_leave();
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (p_account, v_org, v_person, 'staff');
  return v_org;
end $$;

-- Founders already running a company that was started this way: leadership too, once (the agency is left as it is).
do $$ declare o uuid; begin
  perform set_config('pulse.actor_account', 'migration:1540 SELFSERVE-P1', true);
  for o in select id from pulse.org where id is distinct from pulse.install_org() loop
    perform set_config('pulse.org_id', o::text, true);
    insert into pulse.role_assignment(org_id, person_id, role_key, valid_from)
    select o, pp.person_id, 'leadership', current_date from pulse.people_profile pp join pulse.person p on p.id = pp.person_id and p.status = 'active'
     where pp.org_id = o and pp.user_no = 1 and pp.evidence like 'Started this organisation%'
       and exists (select 1 from pulse.role_assignment r where r.org_id = o and r.person_id = pp.person_id and r.role_key = 'admin'
                    and current_date between r.valid_from and coalesce(r.valid_to, 'infinity'))
       and not exists (select 1 from pulse.role_assignment r where r.org_id = o and r.person_id = pp.person_id and r.role_key = 'leadership'
                    and current_date between r.valid_from and coalesce(r.valid_to, 'infinity'));
  end loop;
  perform set_config('pulse.org_id', '', true);
end $$;

-- migrate:down
-- Forward-only.
