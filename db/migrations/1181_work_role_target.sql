-- migrate:up
-- WORK-TAB (27 Oct 2026): a weekly target per role, so Work → People reads "4 of 6 this week" against the role's
-- target (Kazuk's CEO screen: output vs the role's target), not only against the person's own usual week. Leadership
-- and admins set them; every staff member reads them (they are the team's own standards, not ratings).
create table pulse_priv.work_role_target(
  org_id uuid not null references pulse.org(id),
  role text not null check (length(btrim(role)) between 1 and 80),
  per_week int not null check (per_week between 1 and 500),
  unit text check (unit is null or length(btrim(unit)) between 1 and 40),
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default now(),
  primary key (org_id, role));
alter table pulse_priv.work_role_target enable row level security;
alter table pulse_priv.work_role_target force row level security;
create policy tenant on pulse_priv.work_role_target using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

create function pulse.work_role_targets() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('role', t.role, 'perWeek', t.per_week, 'unit', t.unit) order by t.role), '[]'::jsonb)
  from pulse_priv.work_role_target t where t.org_id = pulse.current_org() and pulse.current_viewer() is not null
$$;

create function pulse.work_role_target_set(p_role text, p_per_week int, p_unit text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r text := btrim(regexp_replace(coalesce(p_role, ''), '\s+', ' ', 'g')); u text := nullif(btrim(coalesce(p_unit, '')), '');
begin
  if pulse.current_viewer() is null or not pulse.viewer_is('admin', 'leadership') then
    raise exception 'Leadership and admins set role targets' using errcode = '42501'; end if;
  if length(r) not between 1 and 80 then raise exception 'Choose a role' using errcode = '22023'; end if;
  if u is not null and length(u) > 40 then raise exception 'Name what is counted in up to 40 letters' using errcode = '22023'; end if;
  if p_per_week is null then
    delete from pulse_priv.work_role_target where org_id = pulse.current_org() and lower(role) = lower(r);
  else
    if p_per_week not between 1 and 500 then raise exception 'Enter a weekly target from 1 to 500' using errcode = '22023'; end if;
    delete from pulse_priv.work_role_target where org_id = pulse.current_org() and lower(role) = lower(r) and role <> r;
    insert into pulse_priv.work_role_target(org_id, role, per_week, unit, updated_by) values (pulse.current_org(), r, p_per_week, u, pulse.current_viewer())
    on conflict (org_id, role) do update set per_week = excluded.per_week, unit = excluded.unit, updated_by = excluded.updated_by, updated_at = now();
  end if;
  perform pulse.audit_write('work_role_target_set', 'org', pulse.current_org()::text);
  return pulse.work_role_targets();
end $$;
revoke all on function pulse.work_role_targets(), pulse.work_role_target_set(text, int, text) from public;
grant execute on function pulse.work_role_targets(), pulse.work_role_target_set(text, int, text) to pulse_api;

-- migrate:down
drop function pulse.work_role_target_set(text, int, text);
drop function pulse.work_role_targets();
drop table pulse_priv.work_role_target;
