-- migrate:up
-- Design exports use the same auditable claim record as deliveries, but remain
-- distinguishable so delivery-only queues do not surface design claims.
alter table pulse.delivery_claim
  drop constraint delivery_claim_org_id_file_id_fkey;
alter table pulse.delivery_claim
  add constraint delivery_claim_org_id_file_id_fkey
  foreign key (org_id,file_id) references pulse.index_file(org_id,file_id)
  deferrable initially immediate;
alter table pulse.delivery_claim
  add column claim_scope text not null default 'delivery'
    check (claim_scope in ('delivery','design'));

create function pulse.design_claim_allowed(p_file text) returns boolean
  language sql stable security definer set search_path=pulse,pg_temp as $$
    select exists (
      select 1
      from pulse.index_file f
      join pulse.account a on a.org_id=f.org_id and a.provider='google'
        and a.handle=f.uploader_account and a.is_shared
      where f.org_id=pulse.current_org() and f.file_id=p_file
        and f.account_basis='last modifying account'
        and (lower(f.mime) like 'image/%' or lower(f.mime)='application/pdf'
          or lower(f.name) like any(array['%.ai','%.bmp','%.gif','%.jpeg','%.jpg','%.pdf','%.png','%.psd','%.svg','%.tif','%.tiff','%.webp']))
        and coalesce((
          select not (attribution.method in ('evidence','declared','individual_account','device','manual')
            and attribution.person_id is not null)
          from pulse.file source_file
          join pulse.version version on version.org_id=source_file.org_id and version.file_id=source_file.id
          join pulse.attribution attribution on attribution.org_id=version.org_id
            and attribution.version_id=version.id and attribution.resolver_version='delivery-attribution/v1'
          where source_file.org_id=f.org_id and source_file.store='gdrive' and source_file.store_id=f.file_id
          order by attribution.event_time desc,attribution.event_seq desc limit 1
        ),true)
        and not pulse.delivery_claim_taken(p_file)
    )
  $$;
revoke all on function pulse.design_claim_allowed(text) from public;
grant execute on function pulse.design_claim_allowed(text) to pulse_api;

drop policy delivery_claim_insert_own on pulse.delivery_claim;
create policy delivery_claim_insert_own on pulse.delivery_claim as restrictive for insert to pulse_api
  with check (
    person_id=pulse.current_viewer() and status='pending' and credited_via='claim'
    and decided_by is null and decided_at is null
    and (
      (claim_scope='delivery' and exists (
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
      )) or (claim_scope='design' and pulse.design_claim_allowed(file_id))
    )
  );
grant insert (org_id,file_id,person_id,claim_scope) on pulse.delivery_claim to pulse_api;

-- migrate:down
-- Forward-only: claim records are attribution evidence and remain auditable.
