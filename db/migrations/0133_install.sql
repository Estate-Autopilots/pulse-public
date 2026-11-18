-- migrate:up
-- An install has exactly one tenant. The small directory is global but its write grants stay owner-only.
create table pulse.install (
  id boolean primary key default true check (id),
  org_id uuid not null references pulse.org(id),
  initialised_at timestamptz not null default now(),
  initialised_by text not null
);
alter table pulse.install enable row level security;
alter table pulse.install force row level security;
create policy install_access on pulse.install using (
  org_id = pulse.current_org()
  or current_user = (select pg_get_userbyid(nspowner) from pg_namespace where nspname='pulse')
) with check (
  org_id = pulse.current_org()
  or current_user = (select pg_get_userbyid(nspowner) from pg_namespace where nspname='pulse')
);
revoke all on pulse.install from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy;
grant select on pulse.install to pulse_api, pulse_worker, pulse_ingest;

create function pulse.install_org() returns uuid
  language sql stable security definer set search_path=pulse,pg_temp as $$
    select org_id from pulse.install where id
  $$;
revoke all on function pulse.install_org() from public;
grant execute on function pulse.install_org() to pulse_api, pulse_worker, pulse_ingest;

-- Called only by the opt-in EA bootstrap. It creates both rows atomically on an empty install.
-- A null result means another company row already exists and no rows were written.
create function pulse.install_ea(p_org_id uuid) returns uuid
  language plpgsql security definer set search_path=pulse,pg_temp as $$
declare installed uuid;
begin
  select org_id into installed from pulse.install where id;
  if installed is not null then return installed; end if;
  if exists (select 1 from pulse.org) then return null; end if;
  perform set_config('pulse.org_id', p_org_id::text, true);
  insert into pulse.org(id,slug,name,code) values (p_org_id,'ea','Estate Autopilots','EA');
  insert into pulse.install(org_id,initialised_by) values (p_org_id,'pulse-ea-bootstrap');
  return p_org_id;
end $$;
revoke all on function pulse.install_ea(uuid) from public, pulse_api, pulse_ingest;
grant execute on function pulse.install_ea(uuid) to pulse_worker;

-- Legacy EA databases get a marker only; the migration never creates or changes a tenant row.
insert into pulse.install(org_id,initialised_by)
select id,'migration:ea' from pulse.org where code='EA'
on conflict (id) do nothing;

-- migrate:down
-- Forward-only: install ownership and bootstrap history must remain auditable.
