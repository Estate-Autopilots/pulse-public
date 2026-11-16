-- migrate:up
-- A person can claim a delivery observed through a shared account. The claim remains separate from
-- uploader-account attribution and is counted only after an authorized decision.
create table pulse.delivery_claim (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  file_id text not null,
  person_id uuid not null references pulse.person(id),
  status text not null default 'pending' check (status in ('pending','confirmed','rejected')),
  credited_via text not null default 'claim' check (credited_via = 'claim'),
  created_at timestamptz not null default now(),
  decided_by uuid references pulse.person(id),
  decided_at timestamptz,
  reason text check (reason is null or length(trim(reason)) between 1 and 240),
  foreign key (org_id,file_id) references pulse.delivery(org_id,file_id),
  check ((status = 'pending' and decided_by is null and decided_at is null)
      or (status in ('confirmed','rejected') and decided_at is not null))
);
create unique index delivery_claim_active_file on pulse.delivery_claim(org_id,file_id)
  where status in ('pending','confirmed');
create index delivery_claim_person_status on pulse.delivery_claim(org_id,person_id,status,created_at desc);

-- Claimable delivery lists need to hide a delivery claimed by any editor without disclosing who claimed it.
create function pulse.delivery_claim_taken(p_file text) returns boolean
  language sql stable security definer set search_path=pulse,pg_temp as $$
    select exists (
      select 1 from pulse.delivery_claim claim
      where claim.org_id=pulse.current_org() and claim.file_id=p_file
        and claim.status in ('pending','confirmed')
    )
  $$;
revoke all on function pulse.delivery_claim_taken(text) from public;
grant execute on function pulse.delivery_claim_taken(text) to pulse_api;

alter table pulse.delivery_claim enable row level security;
alter table pulse.delivery_claim force row level security;
create policy tenant_isolation on pulse.delivery_claim
  using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy delivery_claim_visible on pulse.delivery_claim as restrictive for select to pulse_api
  using (person_id = pulse.current_viewer() or pulse.manages(person_id) or pulse.viewer_is('admin'));
create policy delivery_claim_insert_own on pulse.delivery_claim as restrictive for insert to pulse_api
  with check (
    person_id = pulse.current_viewer() and status = 'pending' and credited_via = 'claim'
    and decided_by is null and decided_at is null
    and exists (
      select 1 from pulse.delivery d join pulse.account a
        on a.org_id=d.org_id and a.provider='google' and a.handle=d.uploader_account and a.is_shared
      where d.org_id=delivery_claim.org_id and d.file_id=delivery_claim.file_id
        and d.project_id=any(pulse.work_projects())
        and coalesce((
          select not (attribution.method in ('evidence','declared','individual_account','device','manual')
            and attribution.person_id is not null)
          from pulse.file source_file
          join pulse.version version on version.file_id=source_file.id
          join pulse.attribution attribution on attribution.version_id=version.id
            and attribution.resolver_version='delivery-attribution/v1'
          where source_file.org_id=d.org_id and source_file.store='gdrive' and source_file.store_id=d.file_id
          order by attribution.event_time desc,attribution.event_seq desc limit 1
        ),true)
    )
  );
create policy delivery_claim_decide_report on pulse.delivery_claim as restrictive for update to pulse_api
  using (status = 'pending' and person_id is distinct from pulse.current_viewer()
    and (pulse.viewer_is('admin') or pulse.manages(person_id)))
  with check (status in ('confirmed','rejected') and credited_via = 'claim'
    and decided_at is not null and decided_by is not distinct from pulse.current_viewer()
    and person_id is distinct from pulse.current_viewer()
    and (pulse.viewer_is('admin') or pulse.manages(person_id)));
grant select on pulse.delivery_claim to pulse_api;
grant insert (org_id,file_id,person_id) on pulse.delivery_claim to pulse_api;
grant update (status,decided_by,decided_at,reason) on pulse.delivery_claim to pulse_api;

-- migrate:down
-- Forward-only; claims are attribution records and must remain auditable.
