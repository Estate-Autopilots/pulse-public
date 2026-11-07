-- migrate:up
-- ACCOUNT-SEATS (owner, 2 Nov 2026): a person's Pulse account is separate from any company. It joins companies by
-- invitation (the company's own earlier record of the invited e-mail is linked, never duplicated; reactivating that record
-- stays the company's HR decision) and leaves a company without losing the account or its other companies (the company
-- keeps its records, as with any leaver). Signing up and signing in with an e-mailed code are lane/account-code's.
--  * Codes (1462) last 10 minutes.
--  * A proven e-mail is email_verified_at (1462) or email_confirmed_at (1066's confirm link): either counts.

create or replace function pulse.email_code_issue(p_email text, p_purpose text, p_account uuid, p_hash text) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r pulse_priv.email_code%rowtype; e text := lower(btrim(coalesce(p_email, '')));
begin
  if e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(e) > 254 then raise exception 'Give a valid e-mail address' using errcode = '22023'; end if;
  select * into r from pulse_priv.email_code where email = e for update;
  if found then
    if r.sent_at > now() - interval '1 minute' then return false; end if;
    if r.window_from > now() - interval '1 hour' and r.sends >= 5 then return false; end if;
    update pulse_priv.email_code set purpose = p_purpose, account_id = p_account, code_hash = p_hash, sent_at = now(),
      expires_at = now() + interval '10 minutes', tries = 0,
      sends = case when window_from > now() - interval '1 hour' then sends + 1 else 1 end,
      window_from = case when window_from > now() - interval '1 hour' then window_from else now() end
     where email = e;
  else
    insert into pulse_priv.email_code(email, purpose, account_id, code_hash, expires_at) values (e, p_purpose, p_account, p_hash, now() + interval '10 minutes');
  end if;
  return true;
end $$;

create or replace function pulse.account_email_ok(p_account uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select email is not null and coalesce(email_verified_at, email_confirmed_at) is not null from pulse_priv.pulse_account where id = p_account), false)
$$;
-- 1066's confirm link proves the address too: it counts wherever a proven e-mail is asked (onboard_org reads the column).
update pulse_priv.pulse_account set email_verified_at = email_confirmed_at where email_verified_at is null and email_confirmed_at is not null and email is not null;
create function pulse.account_email_confirmed_proves() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if new.email_confirmed_at is not null and new.email_verified_at is null and new.email is not null then new.email_verified_at := new.email_confirmed_at; end if;
  if new.email is distinct from old.email and new.email_confirmed_at is not distinct from old.email_confirmed_at
     and new.email_verified_at is not distinct from old.email_verified_at then new.email_verified_at := null; end if;
  return new;
end $$;
create trigger account_email_confirmed_proves before update on pulse_priv.pulse_account for each row execute function pulse.account_email_confirmed_proves();
revoke all on function pulse.account_email_confirmed_proves() from public;

-- ------------------------------------------------------------------------------------------------ joining links old records
-- Joining (1462) also finds the company's own earlier record of the invited e-mail (exactly one, not yet on any account)
-- and links it instead of making a second person. Its status stays as the company left it: an inactive record waits for
-- HR's decision: the answer is {waiting} and no session opens there until HR makes the record active.
create or replace function pulse.acct_join(p_account uuid, p_invite uuid, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare i pulse_priv.org_invite%rowtype; a pulse_priv.pulse_account%rowtype; v_org uuid; v_person uuid; v_no int; v_user text; n int := 1;
  v_new boolean := false; v_linked boolean := false; v_side text; v_cands uuid[]; r jsonb; v_name text;
begin
  select org_id into v_org from pulse_priv.org_invite where id = p_invite;
  if v_org is null then raise exception 'This invitation is no longer open' using errcode = '22023'; end if;
  perform acct_enter(v_org, null);
  select * into i from pulse_priv.org_invite where id = p_invite for update;
  if not found or i.status <> 'open' or i.expires_at <= now() then raise exception 'This invitation is no longer open' using errcode = '22023'; end if;
  select * into a from pulse_priv.pulse_account where id = p_account;
  if i.to_handle is not null and i.to_handle <> a.handle then raise exception 'This invitation is for someone else' using errcode = '42501'; end if;
  select person_id into v_person from pulse_priv.account_member where account_id = p_account and member_org = i.org_id;
  if v_person is null and i.to_email is not null then
    select coalesce(array_agg(pp.person_id), '{}') into v_cands from people_profile pp
     where pp.org_id = i.org_id and lower(btrim(pp.email)) = i.to_email
       and not exists (select 1 from pulse_priv.account_member am where am.person_id = pp.person_id);
    if cardinality(v_cands) = 1 then
      v_person := v_cands[1]; v_linked := true;
      select side into v_side from person where id = v_person;
      insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
      values (i.org_id, 'person', v_person, 'account', null, 'Linked to Pulse account @' || a.handle || ' by an invitation to ' || i.to_email, null);
      perform audit_write('account_link', 'person', v_person::text, array['invitation_email']);
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


-- ------------------------------------------------------------------------------------------------ leaving a company
-- Leave a company from my account: the seat ends (the person there becomes a leaver: inactive from today, sessions there
-- ended, unlinked from the account); the account and its other companies stay; the company keeps its records. The last
-- admin cannot leave. When I leave the company I am in, a session opens in another of my companies (p_new), if any.
create function pulse.account_leave(p_org uuid, p_new text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); here uuid := current_org(); me uuid := current_viewer(); m pulse_priv.account_member%rowtype;
  a pulse_priv.pulse_account%rowtype; n text; target uuid; r jsonb;
begin
  if me is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  if v is null then v := account_ensure(); end if;
  select * into m from pulse_priv.account_member where account_id = v and member_org = p_org for update;
  if not found then raise exception 'You are not a member of that company' using errcode = 'P0002'; end if;
  select * into a from pulse_priv.pulse_account where id = v;
  select name into n from org where id = p_org;
  perform acct_enter(p_org, null);
  perform set_config('pulse.actor_account', 'Pulse account @' || a.handle, true);
  if exists (select 1 from role_assignment ra where ra.org_id = p_org and ra.person_id = m.person_id and ra.role_key = 'admin' and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity'))
     and not exists (select 1 from role_assignment ra join person pe on pe.id = ra.person_id and pe.status = 'active'
       where ra.org_id = p_org and ra.person_id <> m.person_id and ra.role_key = 'admin' and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity')) then
    perform acct_leave();
    raise exception 'You are the last admin of %: make someone else an admin first', n using errcode = '22023';
  end if;
  update person set status = 'inactive', active_to = coalesce(active_to, current_date) where id = m.person_id and status = 'active';
  update login_session set revoked_at = now() where org_id = p_org and person_id = m.person_id and revoked_at is null;
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (p_org, 'person', m.person_id, 'status', 'active', 'Left the company from their Pulse account (@' || a.handle || ')', null);
  perform audit_write('account_leave', 'person', m.person_id::text);
  perform acct_leave();
  delete from pulse_priv.account_member where account_id = v and member_org = p_org;
  update pulse_priv.pulse_account set last_org = null where id = v and last_org = p_org;
  if p_org = here then
    for target in select am.member_org from pulse_priv.account_member am join org o on o.id = am.member_org and o.status = 'active'
        where am.account_id = v order by am.last_used_at desc nulls last loop
      r := acct_session(v, target, p_new, p_device);
      exit when r is not null;
    end loop;
  end if;
  return jsonb_build_object('left', p_org, 'name', n, 'moved', r);
end $$;
revoke all on function pulse.account_leave(uuid, text, text) from public;
grant execute on function pulse.account_leave(uuid, text, text) to pulse_api;

-- migrate:down
-- Forward-only: the seats people left and the records linked to accounts are kept.
