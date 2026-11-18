-- migrate:up
-- BUG-SWEEP-2 (EA #29, 15 Nov 2026): "I am not able to switch from EA to Vitals OS." A member of two companies pressed the
-- other company in the switcher three times; each POST /api/v0/account/switch answered 403.
--
-- Why: ACCOUNT-META (2125) lets a session open the account's other companies only when the sign-in proved the person
-- (login_session.personal): the account's own password, or a code to a personal e-mail. A company's own sign-in (its
-- password, its e-mailed staff code to the work address, its Google, Access) opens that company only. The rule is right,
-- but two doors never recorded the proof the person did give:
--   1. The sign-in page tries the company's password first (POST /auth/sign-in -> pulse.auth_login). After "one password
--      for all" (AUTH-UNIFY, 1291) that password IS the account's own password, yet the session stayed company-only:
--      only /auth/account-sign-in compared the account's password. So typing your own Pulse password was not enough.
--   2. A company-only session had no way to prove the person where they stood: the only way through was to sign out and
--      sign in again elsewhere, and the switcher said nothing (the refusal landed in a closed menu).
-- The fix keeps the owner's rule (a company's sign-in alone still never crosses) and records the proof:
--   1. pulse.acct_session_prove: right after a company password sign-in, the same typed password is compared with the
--      account's own password; when it matches, that session is personal (as /auth/account-sign-in would have made it).
--   2. pulse.account_prove: "Confirm it's you" in the switcher. The signed-in person types their Pulse password once; the
--      current session becomes personal and the switch goes through. Wrong passwords count toward the account's lock
--      (five, then 15 minutes), as at the account's own sign-in.
-- Both only ever set personal = true on the caller's own live browser session; nothing else about sessions changes.

-- 1. A company password that is also the account's own password proves the person.
create function pulse.acct_session_prove(p_hash text, p_password text) returns boolean
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare s record; a pulse_priv.pulse_account%rowtype;
begin
  if p_hash is null or coalesce(p_password, '') = '' or octet_length(p_password) > 72 then return false; end if;
  select ls.org_id, ls.person_id, ls.personal into s from login_session ls
   where ls.org_id = current_org() and ls.token_hash = p_hash and ls.revoked_at is null and ls.expires_at > now()
     and ls.native_device_id is null;
  if s.person_id is null then return false; end if;
  if s.personal then return true; end if;
  select pa.* into a from pulse_priv.pulse_account pa
    join pulse_priv.account_member am on am.account_id = pa.id
   where am.person_id = s.person_id and am.member_org = s.org_id;
  -- No account password, or the account is locked: the company's sign-in stays company-only (nothing is counted here:
  -- the person signed in correctly with the company's password).
  if a.id is null or a.password_hash is null or a.locked_until > now() then return false; end if;
  if a.password_hash is distinct from crypt(p_password, a.password_hash) then return false; end if;
  update login_session set personal = true
   where org_id = s.org_id and token_hash = p_hash and person_id = s.person_id and revoked_at is null;
  return true;
end $$;
revoke all on function pulse.acct_session_prove(text, text) from public;
grant execute on function pulse.acct_session_prove(text, text) to pulse_api;

-- 2. "Confirm it's you": the signed-in person's own Pulse password makes their current browser session personal.
-- Answers {personal: true} or {wrong: true} (a wrong password is counted, so it must not roll back by raising).
create function pulse.account_prove(p_password text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare h text := nullif(current_setting('pulse.viewer_session', true), ''); v uuid; a pulse_priv.pulse_account%rowtype;
begin
  if current_viewer() is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  if h is null or not exists (select 1 from login_session where org_id = current_org() and token_hash = h
      and person_id = current_viewer() and revoked_at is null and expires_at > now() and native_device_id is null) then
    raise exception 'Confirm it is you from the browser you signed in on' using errcode = '42501';
  end if;
  if viewer_personal() then return jsonb_build_object('personal', true); end if;
  v := account_of_viewer();
  select * into a from pulse_priv.pulse_account where id = v;
  -- No Pulse password of their own: only signing in with their own e-mail proves them (ACCOUNT-META).
  if a.id is null or a.password_hash is null then
    raise exception '%', acct_personal_needed() using errcode = '42501', hint = 'personal_sign_in';
  end if;
  if a.locked_until > now() then
    raise exception 'Too many wrong passwords. Wait 15 minutes, or sign in again as yourself.' using errcode = '54000';
  end if;
  if coalesce(p_password, '') = '' or octet_length(p_password) > 72 or a.password_hash is distinct from crypt(p_password, a.password_hash) then
    update pulse_priv.pulse_account set failed = case when failed >= 4 then 0 else failed + 1 end,
      locked_until = case when failed >= 4 then now() + interval '15 minutes' end where id = a.id;
    return jsonb_build_object('personal', false, 'wrong', true);
  end if;
  update pulse_priv.pulse_account set failed = 0, locked_until = null where id = a.id and (failed <> 0 or locked_until is not null);
  update login_session set personal = true
   where org_id = current_org() and token_hash = h and person_id = current_viewer() and revoked_at is null;
  perform audit_write('account_prove', 'login_session', null, array['personal']);
  return jsonb_build_object('personal', true);
end $$;
revoke all on function pulse.account_prove(text) from public;
grant execute on function pulse.account_prove(text) to pulse_api;

-- 3. ORG-PER-TAB (2141, landed by the train at 15604cff5 from lane/org-per-tab 84ca8f568) opened a company in a tab with
-- no regard for ACCOUNT-META's rule: account_tab_session neither asked acct_may_cross nor copied personal, and the
-- per-request path makes a child on demand, so a company's own sign-in reached every company of the account by naming it
-- as the tab's company. These are ORG-PER-TAB's own later versions (lane/org-per-tab 6ac98cad7, f491e5018), unchanged:
-- a tab of another company opens only when the sign-in may cross (state 'personal' otherwise: the API refuses it with
-- the switch's sentence and code), a tab's session carries the sign-in's proof, and a record link finds only companies
-- this sign-in may open.
create or replace function pulse.account_tab_session(p_parent text, p_child text, p_org uuid, p_reopen boolean default false)
  returns table(org_id uuid, status text, rehearsal boolean, state text)
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s login_session%rowtype; c login_session%rowtype; a uuid; m record; o record; ok boolean;
begin
  if p_parent is null or p_child is null or p_org is null or p_parent = p_child then return; end if;
  select * into s from login_session x where x.token_hash = p_parent and x.revoked_at is null and x.expires_at > now();
  if s.token_hash is null or s.native_device_id is not null or s.parent_hash is not null then return; end if;
  select o2.id, o2.status, o2.rehearsal into o from org o2 where o2.id = p_org;
  if o.id is null or o.status <> 'active' then return; end if;
  if p_org = s.org_id then return query select o.id, o.status, o.rehearsal, 'parent'::text; return; end if;
  select am.account_id into a from pulse_priv.account_member am where am.person_id = s.person_id and am.member_org = s.org_id;
  if a is null then return; end if;
  select * into m from pulse_priv.account_member am where am.account_id = a and am.member_org = p_org;
  if m.person_id is null then return; end if;
  if not acct_may_cross(a, s.personal, p_org) then return query select o.id, o.status, o.rehearsal, 'personal'::text; return; end if;
  select * into c from login_session x where x.token_hash = p_child;
  if c.token_hash is not null then
    -- Never someone else's session, and never one of another company.
    if c.org_id <> p_org or c.person_id <> m.person_id or c.parent_hash is distinct from p_parent then return; end if;
    if c.revoked_at is null and c.expires_at > now() then
      -- The person proved it is them on the browser's sign-in after this company opened (e.g. "Confirm it's you"):
      -- the company's session of it is personal from now on too.
      if s.personal and not c.personal then
        perform acct_enter(p_org, null);
        update login_session x set personal = true where x.token_hash = p_child and x.org_id = p_org and x.revoked_at is null;
        perform acct_leave();
      end if;
      return query select o.id, o.status, o.rehearsal, 'open'::text; return;
    end if;
    if c.revoked_at is not null and not p_reopen then return query select o.id, o.status, o.rehearsal, 'closed'::text; return; end if;
    perform acct_enter(p_org, null);
    update login_session x set token_hash = 'tab:' || replace(gen_random_uuid()::text, '-', ''), revoked_at = coalesce(x.revoked_at, now())
     where x.token_hash = p_child and x.org_id = p_org;
    perform acct_leave();
  end if;
  perform acct_enter(p_org, m.person_id);
  select exists (select 1 from person p where p.id = m.person_id and p.status = 'active') into ok;
  if ok then
    insert into login_session(org_id, person_id, token_hash, expires_at, device, remembered, via, second_factor_verified, parent_hash, personal)
    values (p_org, m.person_id, p_child, s.expires_at, s.device, s.remembered, 'account', s.second_factor_verified, p_parent, s.personal);
    perform audit_write('org_tab_open', 'organisation', s.org_id::text);
  end if;
  perform acct_leave();
  if not ok then return; end if;
  update pulse_priv.account_member am set last_used_at = now() where am.account_id = a and am.member_org = p_org;
  return query select o.id, o.status, o.rehearsal, 'open'::text;
end $$;

create or replace function pulse.account_record_home(p_kind text, p_id uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); here uuid := current_org(); m record; found_it boolean;
begin
  if v is null or p_id is null or p_kind not in ('doc', 'task', 'project') then return null; end if;
  for m in select am.member_org, am.person_id, o.name, o.handle from pulse_priv.account_member am join org o on o.id = am.member_org and o.status = 'active'
      where am.account_id = v and am.member_org <> here and acct_may_cross(v, viewer_personal(), am.member_org)
      order by am.last_used_at desc nulls last loop
    perform acct_enter(m.member_org, m.person_id);
    found_it := exists (select 1 from person p where p.id = m.person_id and p.status = 'active') and case p_kind
      when 'doc' then exists (select 1 from doc d where d.id = p_id and d.archived_at is null)
      when 'task' then exists (select 1 from task t where t.id = p_id)
      else exists (select 1 from project pr where pr.id = p_id) end;
    perform acct_leave();
    if found_it then return jsonb_build_object('org', m.member_org, 'name', m.name, 'handle', m.handle); end if;
  end loop;
  return null;
end $$;
revoke all on function pulse.account_tab_session(text, text, uuid, boolean), pulse.account_record_home(text, uuid) from public;
grant execute on function pulse.account_tab_session(text, text, uuid, boolean), pulse.account_record_home(text, uuid) to pulse_api;

-- migrate:down
drop function if exists pulse.account_prove(text);
drop function if exists pulse.acct_session_prove(text, text);
