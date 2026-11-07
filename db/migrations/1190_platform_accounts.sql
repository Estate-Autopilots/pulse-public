-- migrate:up
-- PULSE-ADMIN (owner, 27 Oct 2026): People → Pulse accounts. One account per human across organisations (ORG 0920;
-- AUTH-UNIFY owns the account and credential schema): the console lists accounts with the organisations each one is a
-- member of, read-only, for its platform admins. Every organisation (EA and Atlas Crest too) is a tenant of the
-- platform company here. Each search is written to the platform audit log.
create function pulse.platform_accounts(p_q text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_q text := lower(btrim(coalesce(p_q, ''))); v jsonb;
begin
  perform platform_guard();
  if length(v_q) < 2 then raise exception 'Type at least two letters' using errcode = '22023'; end if;
  v_q := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'handle', a.handle, 'name', a.display_name, 'email', a.email,
      'confirmed', a.email_confirmed_at is not null, 'locked', a.locked_until > now(), 'created', a.created_at,
      'lastOrg', (select name from org where id = a.last_org),
      'orgs', (select coalesce(jsonb_agg(jsonb_build_object('orgId', m.member_org, 'org', g.name, 'orgStatus', g.status, 'kind', m.kind,
                 'personId', m.person_id, 'lastUsed', m.last_used_at) order by m.last_used_at desc nulls last, g.name), '[]')
                 from pulse_priv.account_member m join org g on g.id = m.member_org where m.account_id = a.id)) order by a.display_name), '[]')
    into v
    from (select * from pulse_priv.pulse_account
           where lower(display_name) like v_q or lower(handle) like v_q or lower(coalesce(email, '')) like v_q
           order by display_name limit 100) a;
  perform platform_log('accounts.search', null, 'search', null, left(p_q, 60), null, jsonb_build_object('found', jsonb_array_length(v)));
  return v;
end $$;
revoke all on function pulse.platform_accounts(text) from public;
grant execute on function pulse.platform_accounts(text) to pulse_api;

-- migrate:down
drop function pulse.platform_accounts(text);
