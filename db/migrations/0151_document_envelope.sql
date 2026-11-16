-- migrate:up
-- PRESENCE-2 (owner, 10 Oct 2026): the document encryption key leaves the database before real staff are onboarded.
-- Government ID files and bank details are sealed by the API with envelope encryption
-- (services/api/src/document-keys.ts): a fresh data key per file, wrapped by a master key from a root-installed keyring
-- file that PostgreSQL never sees. Stored here: the sealed bytes, the wrapped data key and the master key's ID. The
-- plaintext and the keys never pass through the database, so they cannot reach its logs either.
-- Access is unchanged: these functions still decide who may add or open a document and write privacy.access_log in the
-- same transaction; the API opens a file only after the read function has allowed and logged it.
-- 0152 removes pulse_priv.identity_key once services/api/dist/document-rekey.js has re-sealed what 0149 encrypted with it.

alter table pulse_priv.identity_document
 add column key_id text check (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
 add column file_key bytea check (octet_length(file_key) between 29 and 256);
alter table pulse_priv.person_onboarding
 add column bank_key_id text check (bank_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
 add column bank_key bytea check (octet_length(bank_key) between 29 and 256);

-- An ID document: masked number (never the full one) and/or a file the API has already sealed.
drop function pulse.identity_document_add(uuid,text,text,text,text,bytea);
create function pulse.identity_document_add(p_person uuid, p_kind text, p_masked text, p_mime text, p_name text, p_size int,
 p_key_id text, p_file_key bytea, p_file bytea) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k onboarding_document_kind; nid uuid;
begin
 if not onboarding_can_edit(p_person) then raise exception 'Your own documents, or HR' using errcode='42501'; end if;
 perform onboarding_defaults();
 select * into k from onboarding_document_kind where org_id=current_org() and kind=p_kind and active;
 if not found then raise exception 'HR has not asked for that document' using errcode='22023'; end if;
 if p_masked is not null and (k.id_number is null or k.id_number='aadhaar' and p_masked !~ '^XXXX XXXX [0-9]{4}$' or k.id_number='pan' and p_masked !~ '^XXXXXX[0-9]{3}[A-Z]$') then
  raise exception 'Only a masked number can be kept' using errcode='22023'; end if;
 if p_file is null and p_masked is null then raise exception 'Add the document or its number' using errcode='22023'; end if;
 if p_file is not null and (p_size is null or p_size not between 1 and 5242880 or p_mime is null or p_mime not in ('application/pdf','image/jpeg','image/png','image/webp')) then
  raise exception 'A PDF or photo up to 5 MB' using errcode='22023'; end if;
 -- Sealed format 1 adds a version byte, a 12-byte IV and a 16-byte tag to the file.
 if p_file is not null and (p_key_id is null or p_file_key is null or octet_length(p_file)<>p_size+29) then
  raise exception 'The file must be sealed by the API' using errcode='22023'; end if;
 -- A new upload replaces the current one; the replaced file and its key are cleared, not kept.
 update pulse_priv.identity_document set status='removed',file=null,file_key=null,key_id=null,checked_by=null
  where org_id=current_org() and person_id=p_person and kind=p_kind and status in ('on_file','verified','rejected');
 insert into pulse_priv.identity_document(org_id,person_id,kind,number_masked,file,file_key,key_id,mime,size,file_name,source,added_by)
 values(current_org(),p_person,p_kind,p_masked,p_file,case when p_file is not null then p_file_key end,case when p_file is not null then p_key_id end,
  case when p_file is not null then p_mime end,case when p_file is not null then p_size end,left(p_name,120),case when p_person=current_viewer() then 'self' else 'hr' end,current_viewer())
 returning id into nid;
 perform hr_log(p_person,'identity.'||p_kind,'upload');
 update pulse_priv.person_onboarding set completed_at=case when cardinality(onboarding_missing(p_person))=0 then coalesce(completed_at,now()) end where person_id=p_person;
 return nid;
end $$;

-- The sealed file for someone allowed to open it, logged. Whose and what it is come back too: the API binds the seal
-- to them, so a sealed file moved onto another record does not open.
drop function pulse.identity_document_read(uuid);
create function pulse.identity_document_read(p_id uuid) returns table(name text, mime text, person_id uuid, kind text, key_id text, data_key bytea, sealed bytea)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d pulse_priv.identity_document;
begin
 select * into d from pulse_priv.identity_document x where x.org_id=current_org() and x.id=p_id and x.status in ('on_file','verified','rejected') and x.file is not null;
 if not found or not onboarding_can_see_ids(d.person_id) then raise exception 'Document unavailable' using errcode='42501'; end if;
 perform hr_log(d.person_id,'identity.'||d.kind||'.file',case when d.person_id=current_viewer() then 'self' else 'hr_document_view' end);
 return query select coalesce(d.file_name,d.kind), d.mime, d.person_id, d.kind, d.key_id, d.file_key, d.file;
end $$;

create or replace function pulse.identity_document_remove(p_id uuid) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d pulse_priv.identity_document;
begin
 select * into d from pulse_priv.identity_document where org_id=current_org() and id=p_id and status<>'removed' for update;
 if not found then raise exception 'Document unavailable' using errcode='22023'; end if;
 if not (d.person_id=current_viewer() and d.status<>'verified' or identity_hr()) then raise exception 'Ask HR to remove a checked document' using errcode='42501'; end if;
 update pulse_priv.identity_document set status='removed',file=null,file_key=null,key_id=null where id=p_id;
 perform hr_log(d.person_id,'identity.'||d.kind,'remove');
 update pulse_priv.person_onboarding set completed_at=null where person_id=d.person_id and cardinality(onboarding_missing(d.person_id))>0;
end $$;

-- Bank details arrive sealed by the API (base64 in the section's data), with the master key's ID.
do $$
declare definition text; changed text;
begin
 definition := pg_get_functiondef('pulse.onboarding_save(uuid,text,jsonb)'::regprocedure);
 changed := replace(definition, 'jsonb_typeof(p_data->''account'') is distinct from ''object''',
  'coalesce(p_data->>''sealed'','''')='''' or coalesce(p_data->>''dataKey'','''')='''' or coalesce(p_data->>''keyId'','''') !~ ''^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$''');
 changed := replace(changed, E'  key_hex:=identity_key_hex();\n  update pulse_priv.person_onboarding set bank=public.pgp_sym_encrypt_bytea(convert_to((p_data->''account'')::text,''UTF8''),key_hex,''cipher-algo=aes256''),',
  E'  update pulse_priv.person_onboarding set bank=decode(p_data->>''sealed'',''base64''),bank_key=decode(p_data->>''dataKey'',''base64''),bank_key_id=p_data->>''keyId'',');
 if changed = definition or changed like '%identity_key_hex%' or changed like '%p_data->''account''%' then raise exception 'onboarding_save changed shape'; end if;
 execute changed;
end $$;

revoke all on function pulse.identity_document_add(uuid,text,text,text,text,int,text,bytea,bytea),pulse.identity_document_read(uuid) from public;
grant execute on function pulse.identity_document_add(uuid,text,text,text,text,int,text,bytea,bytea),pulse.identity_document_read(uuid) to pulse_api;

-- migrate:down
-- Forward-only.
