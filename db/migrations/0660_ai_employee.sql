-- migrate:up
-- Permanent, company-local AI employee identities on the existing co-worker model.
alter table pulse.agent_member
  add column employee_no int,
  add column employee_id text,
  add column lane text not null default 'quick' check (lane in ('quick','thinking'));

-- Visit every company as the owner under forced RLS, including suspended companies.
do $$
declare org record; previous_org text := current_setting('pulse.org_id', true);
begin
  for org in select id, code from pulse.org loop
    perform set_config('pulse.org_id', org.id::text, true);
    with numbered as (
      select person_id, row_number() over (order by created_at, person_id)::int n
      from pulse.agent_member where org_id = org.id
    )
    update pulse.agent_member m set employee_no = n.n,
      employee_id = org.code || '-AI-' || lpad(n.n::text, greatest(3, length(n.n::text)), '0'),
      owner_person_id = coalesce(m.owner_person_id, m.created_by, (
        select p.id from pulse.person p where p.org_id = org.id and p.side = 'staff' and p.status = 'active'
          and exists(select 1 from pulse.role_assignment r where r.org_id = org.id and r.person_id = p.id
            and r.role_key = 'admin' and current_date between r.valid_from and coalesce(r.valid_to, 'infinity'))
        order by p.created_at, p.id limit 1))
    from numbered n where m.person_id = n.person_id and m.org_id = org.id;
    if exists(select 1 from pulse.agent_member where org_id = org.id and owner_person_id is null) then
      raise exception 'AI employee owner backfill failed for org %: set an owner, creator or active admin', org.id;
    end if;
  end loop;
  perform set_config('pulse.org_id', coalesce(previous_org, ''), true);
end $$;
alter table pulse.agent_member
  alter column employee_no set not null, alter column employee_id set not null,
  alter column owner_person_id set not null,
  add unique (org_id, employee_no), add unique (org_id, employee_id);

create function pulse.agent_employee_fixed() returns trigger
language plpgsql set search_path=pulse,pg_temp as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'AI employee identities cannot be deleted or reused' using errcode='42501';
  end if;
  if (new.employee_no, new.employee_id, new.org_id) is distinct from (old.employee_no, old.employee_id, old.org_id) then
    raise exception 'AI employee number, ID and company are permanent' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function pulse.agent_employee_fixed() from public;
create trigger agent_employee_fixed before update or delete on pulse.agent_member
  for each row execute function pulse.agent_employee_fixed();

create or replace function pulse.agent_create_record(p jsonb) returns uuid
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pid uuid; org uuid := current_org(); v_owner uuid := nullif(p->>'ownerId', '')::uuid;
  v_name text := btrim(coalesce(p->>'name', '')); v_user text := lower(btrim(coalesce(p->>'username', '')));
  v_title text := btrim(coalesce(p->>'title', '')); v_lane text := p->>'lane'; n int; emp int; code text;
begin
  if length(v_name) not between 1 and 80 then raise exception 'Name the co-worker in up to 80 characters' using errcode='22023'; end if;
  if v_user !~ '^[a-z0-9][a-z0-9._-]{2,39}$' then raise exception 'Choose a username: 3 to 40 lower-case letters, digits, dots or dashes' using errcode='22023'; end if;
  if length(v_title) not between 1 and 120 then raise exception 'A title of 1 to 120 characters is required' using errcode='22023'; end if;
  if v_lane is null or v_lane not in ('quick','thinking') then raise exception 'A lane of quick or thinking is required' using errcode='22023'; end if;
  if v_owner is null or not exists(select 1 from person where id = v_owner and org_id = org and side = 'staff' and status = 'active') then
    raise exception 'An active staff owner in this company is required' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtext('ai-employee:' || org::text));
  if exists(select 1 from people_profile where org_id = org and username = v_user) then raise exception 'That username is taken' using errcode='23505'; end if;
  select coalesce(max(employee_no), 0) + 1 into emp from agent_member where org_id = org;
  select o.code into code from pulse.org o where o.id = org;
  insert into person(org_id, display_name, side, status) values (org, v_name, 'agent', 'active') returning id into pid;
  select coalesce(max(user_no), 0) + 1 into n from people_profile where org_id = org;
  insert into people_profile(org_id, person_id, role, evidence, user_no, username) values (org, pid, v_title, 'agent_create', n, v_user);
  insert into agent_member(org_id, person_id, employee_no, employee_id, title, owner_person_id, lane, runtime, run_reserve, daily_token_budget, created_by)
  values (org, pid, emp, code || '-AI-' || lpad(emp::text, greatest(3, length(emp::text)), '0'), v_title, v_owner, v_lane,
    left(coalesce(p->>'runtime', ''), 80), coalesce(nullif(p->>'runReserve', '')::int, 16000),
    coalesce(nullif(p->>'dailyTokenBudget', '')::int, 160000), current_viewer());
  return pid;
end $$;

-- Preserve the existing dispatch/access/budget behaviour; fail if an upstream body changed.
do $$
declare d text; c text;
begin
  d := pg_get_functiondef('pulse.agent_events_claim(int)'::regprocedure);
  c := replace(d, $x$'leaseToken', lease_token$x$,
    $x$'lane', (select lane from agent_member where person_id = me), 'leaseToken', lease_token$x$);
  if c = d then raise exception 'agent_events_claim changed shape (AI employee)'; end if;
  execute c;
  d := pg_get_functiondef('pulse.agent_dispatch(uuid,uuid,text,text)'::regprocedure);
  c := replace(d, $x$left(coalesce(p_lane, ''), 40)$x$, $x$left(coalesce(nullif(p_lane, ''), m.lane), 40)$x$);
  if c = d then raise exception 'agent_dispatch changed shape (AI employee)'; end if;
  execute c;
  d := pg_get_functiondef('pulse.operator_agent_chat(text,text,text,text[])'::regprocedure);
  c := replace(d, $x$'ownerId',members[1]$x$, $x$'ownerId',members[1],'title','Posts updates','lane','quick'$x$);
  if c = d then raise exception 'operator_agent_chat changed shape (AI employee)'; end if;
  execute c;
  d := pg_get_functiondef('pulse.agent_list()'::regprocedure);
  c := replace(d, $x$'id', m.person_id$x$,
    $x$'employeeId', m.employee_id, 'lane', m.lane, 'ownerId', m.owner_person_id,
    'ownerName', (select display_name from person where id = m.owner_person_id), 'id', m.person_id$x$);
  if c = d then raise exception 'agent_list changed shape (AI employee)'; end if;
  execute c;
end $$;

create function pulse.agent_profile(p_agent uuid) returns jsonb
language sql stable security definer set search_path=pulse,pg_temp as $$
  select jsonb_build_object('id', m.person_id, 'employeeId', m.employee_id, 'name', p.display_name,
    'orgName', o.name, 'orgCode', o.code, 'owner', jsonb_build_object('id', owner.id, 'name', owner.display_name),
    'title', m.title, 'lane', m.lane, 'model', m.runtime,
    'status', case when p.status <> 'active' then 'off' when m.paused_reason is not null then 'paused' when m.disabled_at is not null then 'off' else 'on' end,
    'pausedReason', m.paused_reason, 'dailyBudget', m.daily_token_budget,
    'usedToday', (select coalesce(sum(case when r.state in ('done','error') then coalesce(r.tokens, r.reserved) else r.reserved end), 0)
      from agent_run r where r.org_id = m.org_id and r.agent_id = m.person_id
        and (r.started_at at time zone org_time_zone())::date = (now() at time zone org_time_zone())::date))
  from agent_member m join person p on p.id = m.person_id and p.org_id = m.org_id
  join pulse.org o on o.id = m.org_id join person owner on owner.id = m.owner_person_id and owner.org_id = m.org_id
  where m.org_id = current_org() and m.person_id = p_agent and agent_session() is null and (agent_leader(current_viewer()) or exists(
    select 1 from chat_member a join chat_member v on v.org_id = a.org_id and v.channel_id = a.channel_id
      where a.org_id = m.org_id and a.person_id = m.person_id and v.person_id = current_viewer()))
$$;
create function pulse.agent_count() returns int
language sql stable security definer set search_path=pulse,pg_temp as $$
  select count(*)::int from agent_member m join person p on p.id = m.person_id and p.org_id = m.org_id
  where m.org_id = current_org() and m.disabled_at is null and p.side = 'agent' and p.status = 'active'
$$;
revoke all on function pulse.agent_profile(uuid), pulse.agent_count() from public;
grant execute on function pulse.agent_profile(uuid), pulse.agent_count() to pulse_api;

-- migrate:down
-- Forward-only: employee IDs and audit history are permanent; switch an employee off instead.
