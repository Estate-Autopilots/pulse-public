-- migrate:up
-- ORG-PER-TAB (owner, 14 Nov 2026: "In one Chrome tab Vitals Technology is open, and in another tab on the same Chrome
-- profile I should be able to use another company"). Until now one browser sign-in was one company: a switch moved the
-- session (1291 acct_move) and every tab moved with it.
--
-- Now each tab says which company it is in (the web sends it), and the browser's one sign-in (its session, the
-- "parent") opens a session per company for it. The API derives that company's token from the parent token (an HMAC
-- in services/api/src/tab-session.ts; never stored, never sent to the browser) and this function keeps that company's
-- session: an ordinary login_session of that company, so row security is exactly as before. It is made only for a
-- member of the account (the same rule as a switch), with the parent's expiry, device and second step, and it works only
-- while the parent is live (the API checks the parent on every request; a child presented on its own is refused).
-- Signing out ends the parent and every child; "sign out of this company" ends one child and keeps it closed.

alter table pulse.login_session add column parent_hash text check (parent_hash is null or length(parent_hash) between 16 and 128);
create index login_session_parent on pulse.login_session(parent_hash) where parent_hash is not null;

-- A child session never picks the company on its own (only through its live parent, account_tab_session below).
create or replace function pulse.session_org(p_hash text) returns table(org_id uuid, status text, rehearsal boolean)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select s.org_id, o.status, o.rehearsal from login_session s join org o on o.id = s.org_id
   where s.token_hash = p_hash and s.via = 'account' and s.revoked_at is null and s.expires_at > now() and s.parent_hash is null
$$;

-- The company p_org for the live parent session p_parent (hashes). One row: the company and how it opens
-- ('parent': the parent's own company, use the parent; 'open': the child p_child is live; 'closed': that company was
-- signed out in this browser). No row: the account is not in that company (the API answers "not found").
create function pulse.account_tab_session(p_parent text, p_child text, p_org uuid, p_reopen boolean default false)
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
  select * into c from login_session x where x.token_hash = p_child;
  if c.token_hash is not null then
    -- Never someone else's session, and never one of another company.
    if c.org_id <> p_org or c.person_id <> m.person_id or c.parent_hash is distinct from p_parent then return; end if;
    if c.revoked_at is null and c.expires_at > now() then return query select o.id, o.status, o.rehearsal, 'open'::text; return; end if;
    if c.revoked_at is not null and not p_reopen then return query select o.id, o.status, o.rehearsal, 'closed'::text; return; end if;
    perform acct_enter(p_org, null);
    update login_session x set token_hash = 'tab:' || replace(gen_random_uuid()::text, '-', ''), revoked_at = coalesce(x.revoked_at, now())
     where x.token_hash = p_child and x.org_id = p_org;
    perform acct_leave();
  end if;
  perform acct_enter(p_org, m.person_id);
  select exists (select 1 from person p where p.id = m.person_id and p.status = 'active') into ok;
  if ok then
    insert into login_session(org_id, person_id, token_hash, expires_at, device, remembered, via, second_factor_verified, parent_hash)
    values (p_org, m.person_id, p_child, s.expires_at, s.device, s.remembered, 'account', s.second_factor_verified, p_parent);
    perform audit_write('org_tab_open', 'organisation', s.org_id::text);
  end if;
  perform acct_leave();
  if not ok then return; end if;
  update pulse_priv.account_member am set last_used_at = now() where am.account_id = a and am.member_org = p_org;
  return query select o.id, o.status, o.rehearsal, 'open'::text;
end $$;

-- Sign out of one company in this browser (p_child: the hash of that company's derived token). The other companies
-- stay open. When it is the parent's own company, the parent's token moves to another open company (its child row
-- takes the token) and this company keeps a closed marker; with no other company open it is a full sign-out.
create function pulse.account_tab_close(p_parent text, p_org uuid, p_child text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s login_session%rowtype; c login_session%rowtype;
begin
  select * into s from login_session x where x.token_hash = p_parent and x.revoked_at is null and x.expires_at > now();
  if s.token_hash is null or s.parent_hash is not null then return jsonb_build_object('signedOut', true); end if;
  if s.org_id <> p_org then
    perform acct_enter(p_org, null);
    update login_session x set revoked_at = now() where x.token_hash = p_child and x.parent_hash = p_parent and x.org_id = p_org and x.revoked_at is null;
    perform audit_write('org_tab_close', 'organisation', p_org::text);
    perform acct_leave();
    return jsonb_build_object('closed', p_org, 'signedOut', false);
  end if;
  select * into c from login_session x where x.parent_hash = p_parent and x.revoked_at is null and x.expires_at > now()
   order by x.last_active_at desc nulls last, x.created_at desc limit 1;
  perform acct_enter(s.org_id, null);
  if c.token_hash is null then
    update login_session x set revoked_at = now() where x.token_hash = p_parent and x.org_id = s.org_id;
    perform acct_leave();
    return jsonb_build_object('closed', p_org, 'signedOut', true);
  end if;
  -- This company keeps a closed marker under its derived token, so a tab still in it is told it was signed out.
  delete from login_session x where x.token_hash = p_child and x.org_id = s.org_id;
  update login_session x set token_hash = p_child, revoked_at = now(), parent_hash = p_parent where x.token_hash = p_parent and x.org_id = s.org_id;
  perform audit_write('org_tab_close', 'organisation', p_org::text);
  perform acct_leave();
  perform acct_enter(c.org_id, null);
  update login_session x set token_hash = p_parent, parent_hash = null where x.token_hash = c.token_hash and x.org_id = c.org_id;
  perform acct_leave();
  return jsonb_build_object('closed', p_org, 'signedOut', false, 'now', c.org_id);
end $$;

-- Sign out of every company in this browser: the parent and all its children, in each company.
create function pulse.account_tab_sign_out_all(p_parent text) returns integer
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r record; n integer := 0;
begin
  for r in select x.org_id, x.token_hash from login_session x where (x.token_hash = p_parent or x.parent_hash = p_parent) and x.revoked_at is null loop
    perform acct_enter(r.org_id, null);
    update login_session x set revoked_at = now() where x.token_hash = r.token_hash and x.org_id = r.org_id;
    perform acct_leave();
    n := n + 1;
  end loop;
  return n;
end $$;

-- A link to a record (a doc, task or project) of another company: which of the signed-in person's other companies has
-- it and lets them see it there (row security as that person in that company). Only the account's own companies are
-- ever looked in: for any other company the answer is the same null as for a record that does not exist.
create function pulse.account_record_home(p_kind text, p_id uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); here uuid := current_org(); m record; found_it boolean;
begin
  if v is null or p_id is null or p_kind not in ('doc', 'task', 'project') then return null; end if;
  for m in select am.member_org, am.person_id, o.name, o.handle from pulse_priv.account_member am join org o on o.id = am.member_org and o.status = 'active'
      where am.account_id = v and am.member_org <> here order by am.last_used_at desc nulls last loop
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

revoke all on function pulse.account_tab_session(text, text, uuid, boolean), pulse.account_tab_close(text, uuid, text),
  pulse.account_tab_sign_out_all(text), pulse.account_record_home(text, uuid) from public;
grant execute on function pulse.account_tab_session(text, text, uuid, boolean), pulse.account_tab_close(text, uuid, text),
  pulse.account_tab_sign_out_all(text), pulse.account_record_home(text, uuid) to pulse_api;

-- migrate:down
drop function if exists pulse.account_record_home(text, uuid);
drop function if exists pulse.account_tab_sign_out_all(text);
drop function if exists pulse.account_tab_close(text, uuid, text);
drop function if exists pulse.account_tab_session(text, text, uuid, boolean);
create or replace function pulse.session_org(p_hash text) returns table(org_id uuid, status text, rehearsal boolean)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select s.org_id, o.status, o.rehearsal from login_session s join org o on o.id = s.org_id
   where s.token_hash = p_hash and s.via = 'account' and s.revoked_at is null and s.expires_at > now()
$$;
drop index if exists pulse.login_session_parent;
alter table pulse.login_session drop column if exists parent_hash;
