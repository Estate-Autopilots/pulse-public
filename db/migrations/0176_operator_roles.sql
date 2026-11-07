-- migrate:up
-- Break-glass roles for the person who runs the install (ADR-0031 §3): pulse-admin grant|revoke|roles and
-- /api/v1/operator/roles. A role is a pulse.role_assignment row, written and ended exactly as Settings → Roles does,
-- with the same pulse.record_change line, and audited as the operator. The install's last admin cannot be revoked.
create function pulse.operator_role_set(p_email text, p_role text, p_grant boolean, p_actor text)
  returns table(person_id uuid, name text)
  language plpgsql security definer set search_path=pulse,pg_temp as $$
declare
  v_org uuid;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_actor text := btrim(coalesce(p_actor, ''));
  v_people uuid[];
  v_person uuid;
  v_name text;
  v_status text;
  v_held uuid[];
begin
  select i.org_id into v_org from install i where i.id;
  if v_org is null then raise exception 'Pulse is not initialised' using errcode = 'P0002'; end if;
  if coalesce(p_role, '') not in ('admin', 'hr', 'leadership', 'privacy') then
    raise exception 'Role must be admin, hr, leadership or privacy' using errcode = '22023';
  end if;
  if p_grant is null then raise exception 'Choose grant or revoke' using errcode = '22023'; end if;
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(v_email) > 120 then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;
  if length(v_actor) not between 1 and 60 then raise exception 'Actor is required' using errcode = '22023'; end if;
  perform set_config('pulse.org_id', v_org::text, true);
  perform set_config('pulse.actor_account', v_actor, true);
  perform set_config('pulse.viewer_id', '', true);

  -- The staff member whose work email, or one of whose own Google accounts, is this address.
  select array_agg(distinct p.id) into v_people from person p left join people_profile pp on pp.person_id = p.id
   where p.org_id = v_org and p.side = 'staff' and (lower(pp.email) = v_email or exists (
     select 1 from account a where a.org_id = v_org and a.provider = 'google' and a.handle = v_email
        and a.holder_person_id = p.id and not a.is_shared));
  if v_people is null then raise exception 'No staff member has this email' using errcode = 'P0002'; end if;
  if cardinality(v_people) > 1 then
    raise exception 'More than one staff member has this email; fix their emails in Pulse first' using errcode = '23505';
  end if;
  v_person := v_people[1];
  select p.display_name, p.status into v_name, v_status from person p where p.id = v_person;

  select array_agg(r.id) into v_held from role_assignment r
   where r.org_id = v_org and r.person_id = v_person and r.role_key = p_role
     and current_date between r.valid_from and coalesce(r.valid_to, 'infinity');
  if p_grant then
    if v_held is not null then raise exception 'This person already has this role' using errcode = '23505'; end if;
    if v_status <> 'active' then raise exception 'This person is not active' using errcode = '22023'; end if;
    insert into role_assignment(org_id, person_id, role_key, valid_from) values (v_org, v_person, p_role, current_date);
  else
    if v_held is null then raise exception 'This person does not have this role' using errcode = '23505'; end if;
    if p_role = 'admin' then
      -- Lock the open admin rows first, so two revokes at once cannot each leave the other as the last admin.
      perform 1 from role_assignment r where r.org_id = v_org and r.role_key = 'admin'
         and current_date between r.valid_from and coalesce(r.valid_to, 'infinity') for update;
      if not exists (select 1 from role_assignment r join person p on p.id = r.person_id
                      where r.org_id = v_org and r.role_key = 'admin' and r.person_id <> v_person and p.status = 'active'
                        and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')) then
        raise exception 'This is the last admin; grant admin to someone else first' using errcode = '23505';
      end if;
    end if;
    update role_assignment set valid_to = current_date - 1 where id = any(v_held);
  end if;
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value)
  values (v_org, 'role', v_person, p_role, case when p_grant then null else 'held' end,
          case when p_grant then 'granted' end);
  perform audit_write(case when p_grant then 'operator_role_grant' else 'operator_role_revoke' end, 'role',
                      v_person::text, array[p_role]);
  return query select v_person, v_name;
end $$;
revoke all on function pulse.operator_role_set(text, text, boolean, text) from public;
grant execute on function pulse.operator_role_set(text, text, boolean, text) to pulse_api;

-- Who holds admin, hr, leadership and privacy today, for the operator.
create function pulse.operator_roles(p_actor text)
  returns table(role text, email text, name text, active boolean, since date)
  language plpgsql security definer set search_path=pulse,pg_temp as $$
declare
  v_org uuid;
  v_actor text := btrim(coalesce(p_actor, ''));
begin
  select i.org_id into v_org from install i where i.id;
  if v_org is null then raise exception 'Pulse is not initialised' using errcode = 'P0002'; end if;
  if length(v_actor) not between 1 and 60 then raise exception 'Actor is required' using errcode = '22023'; end if;
  perform set_config('pulse.org_id', v_org::text, true);
  perform set_config('pulse.actor_account', v_actor, true);
  perform set_config('pulse.viewer_id', '', true);
  perform audit_write('operator_roles', 'role', null);
  return query
    select r.role_key, coalesce(pp.email, pp.accounts[1]), p.display_name, p.status = 'active', min(r.valid_from)
      from role_assignment r join person p on p.id = r.person_id left join people_profile pp on pp.person_id = p.id
     where r.org_id = v_org and r.role_key in ('admin', 'hr', 'leadership', 'privacy')
       and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')
     group by r.role_key, p.id, pp.email, pp.accounts
     order by array_position(array['admin', 'hr', 'leadership', 'privacy'], r.role_key), p.display_name;
end $$;
revoke all on function pulse.operator_roles(text) from public;
grant execute on function pulse.operator_roles(text) to pulse_api;

-- migrate:down
-- Forward-only: role changes and their audit trail must remain.
