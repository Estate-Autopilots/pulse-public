-- migrate:up
-- PRESENCE-2, step two: the in-database document key goes. 0151 moved sealing into the API, and
-- services/api/dist/document-rekey.js re-sealed whatever 0149 had encrypted with pulse_priv.identity_key. This refuses
-- to run while any file or bank detail still depends on that key, so nothing becomes unreadable; from here on every
-- sealed value must carry its wrapped data key and master key ID.
-- The checks read every organisation's rows as the table owner (the policies bind to one organisation).
alter table pulse_priv.identity_document no force row level security;
alter table pulse_priv.person_onboarding no force row level security;
do $$
begin
 if exists(select 1 from pulse_priv.identity_document where file is not null and (key_id is null or file_key is null))
  or exists(select 1 from pulse_priv.person_onboarding where bank is not null and (bank_key_id is null or bank_key is null)) then
  raise exception 'ID files or bank details are still sealed with the in-database key: run services/api/dist/document-rekey.js first (docs/ops/DOCUMENT-KEYS.md)';
 end if;
 if exists(select 1 from pg_proc where pronamespace in ('pulse'::regnamespace,'pulse_priv'::regnamespace) and proname<>'identity_key_hex' and prosrc like '%identity\_key%') then
  raise exception 'A function still reads the in-database document key';
 end if;
end $$;
alter table pulse_priv.identity_document add constraint identity_document_sealed
 check ((file is null) = (file_key is null) and (file is null) = (key_id is null));
alter table pulse_priv.person_onboarding add constraint person_onboarding_bank_sealed
 check ((bank is null) = (bank_key is null) and (bank is null) = (bank_key_id is null));
alter table pulse_priv.person_onboarding force row level security;
alter table pulse_priv.identity_document force row level security;

drop function pulse.identity_key_hex();
drop table pulse_priv.identity_key;

-- migrate:down
-- Forward-only.
