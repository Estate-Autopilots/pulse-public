-- migrate:up
-- Staff can request ownership of an unlinked uploader account; an authorized reviewer confirms it.
-- Claims are retained when rejected or reverted so account identity changes remain auditable.
create table pulse.account_claim (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references pulse.account(id),
  person_id uuid not null references pulse.person(id),
  status text not null default 'pending' check (status in ('pending','confirmed','rejected','reverted')),
  created_at timestamptz not null default now(),
  decided_by uuid references pulse.person(id),
  decided_at timestamptz,
  reason text check (reason is null or length(trim(reason)) between 1 and 240),
  check ((status='pending' and decided_by is null and decided_at is null)
      or (status<>'pending' and decided_by is not null and decided_at is not null))
);
create unique index account_claim_active on pulse.account_claim(org_id,account_id)
  where status in ('pending','confirmed');
create index account_claim_person_status on pulse.account_claim(org_id,person_id,status,created_at desc);

alter table pulse.account_claim enable row level security;
alter table pulse.account_claim force row level security;
create policy tenant_isolation on pulse.account_claim
  using (org_id=pulse.current_org()) with check (org_id=pulse.current_org());
create policy account_claim_visible on pulse.account_claim as restrictive for select to pulse_api
  using (person_id=pulse.current_viewer() or pulse.viewer_is('admin','hr') or pulse.manages(person_id));
create policy account_claim_self_insert on pulse.account_claim as restrictive for insert to pulse_api
  with check (person_id=pulse.current_viewer() and status='pending' and decided_by is null and decided_at is null
    and exists(select 1 from pulse.person p where p.org_id=account_claim.org_id and p.id=account_claim.person_id
      and p.side='staff' and p.status='active')
      and exists(select 1 from pulse.account a where a.org_id=account_claim.org_id and a.id=account_claim.account_id
        and a.provider='google' and not a.is_shared and a.holder_person_id is null
        and exists(select 1 from pulse.delivery d where d.org_id=a.org_id and d.uploader_account=a.handle
          and d.project_id=any(pulse.work_projects()))
        and lower(coalesce(a.purpose,'')) not like '%client%'
        and lower(coalesce(a.purpose,'')) not like 'workspace%'
        and not exists(select 1 from pulse.contact_profile cp
          where cp.org_id=a.org_id and lower(btrim(cp.email))=lower(btrim(a.handle)))
      and not exists(select 1 from pulse.client cl
        left join pulse.party_org po on po.org_id=cl.org_id and po.id=cl.party_org_id
        where cl.org_id=a.org_id and (
          lower(split_part(a.handle,'@',2))=any(
            select lower(trim(both '@' from btrim(domains.email_domain)))
            from unnest(cl.email_domains) as domains(email_domain))
          or lower(split_part(a.handle,'@',2))=lower(trim(both '@' from btrim(po.domain)))
        ))
      and not exists(select 1 from pulse.identity_link il
        left join pulse.person linked_person on il.entity_type='person' and linked_person.org_id=il.org_id and linked_person.id=il.entity_id
        where il.org_id=a.org_id and il.valid_to is null and (
          (il.entity_type='client'
            and (lower(coalesce(il.raw_value,''))=lower(a.handle)
              or lower(il.source_key) in (lower(a.handle),'google:'||lower(a.handle))))
          or (il.entity_type='person' and linked_person.side<>'staff'
            and (lower(coalesce(il.raw_value,''))=lower(a.handle)
              or lower(il.source_key) in (lower(a.handle),'google:'||lower(a.handle))))
          or (il.entity_type='account' and il.entity_id=a.id and il.source ilike '%client%')
        ))
      and not exists(select 1 from pulse.identity_link il
        where il.org_id=a.org_id and il.entity_type='person' and il.valid_to is null
          and il.entity_id<>account_claim.person_id
          and (lower(coalesce(il.raw_value,''))=lower(a.handle)
            or lower(il.source_key) in (lower(a.handle),'google:'||lower(a.handle))))
    ));
create policy account_claim_review on pulse.account_claim as restrictive for update to pulse_api
  using (person_id is distinct from pulse.current_viewer()
    and (pulse.viewer_is('admin','hr') or pulse.manages(person_id))
    and status in ('pending','confirmed'))
  with check (person_id is distinct from pulse.current_viewer()
    and (pulse.viewer_is('admin','hr') or pulse.manages(person_id))
    and status in ('confirmed','rejected','reverted')
    and decided_by=pulse.current_viewer() and decided_at is not null);
grant select,insert,update on pulse.account_claim to pulse_api;
grant update (holder_person_id) on pulse.account to pulse_api;

-- Existing account edits are admin-only. Permit the reviewer to apply only the account
-- ownership transition attached to the claim they just confirmed or reverted.
drop policy record_update on pulse.account;
create policy record_update on pulse.account as restrictive for update to pulse_api
  using (pulse.viewer_is('admin') or exists(
    select 1 from pulse.account_claim claim where claim.org_id=account.org_id and claim.account_id=account.id
      and claim.decided_by=pulse.current_viewer() and claim.status in ('confirmed','reverted')
  ))
  with check (pulse.viewer_is('admin') or exists(
    select 1 from pulse.account_claim claim where claim.org_id=account.org_id and claim.account_id=account.id
      and claim.decided_by=pulse.current_viewer()
      and ((claim.status='confirmed' and account.holder_person_id=claim.person_id)
        or (claim.status='reverted' and account.holder_person_id is null))
  ));

-- Account claims grant a reviewer only the holder transition; purpose remains admin-managed.
create function pulse.account_claim_purpose_guard() returns trigger language plpgsql as $$
begin
  if old.purpose is distinct from new.purpose and pulse.current_viewer() is not null
     and not pulse.viewer_is('admin') then
    raise exception 'Admin required to change account purpose' using errcode='42501';
  end if;
  return new;
end $$;
create trigger account_claim_purpose_guard before update of purpose on pulse.account
  for each row execute function pulse.account_claim_purpose_guard();

-- migrate:down
-- Forward-only: account claims and identity decisions are audit records.
