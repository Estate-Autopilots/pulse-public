-- migrate:up
-- WA-INTEL: a contact suggestion may name someone Pulse lacks. The client's WhatsApp groups show a person by name (a
-- role, the one client they speak for) who has no Pulse record; an admin accepting the suggestion makes them that
-- client's point of contact exactly as the import does, then fills the role. Everything else is as in 1070.
create or replace function pulse.wa_contact_apply(p_item uuid) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r review_item; pr jsonb; n int := 0; k int; cp contact_profile; cl client; pid uuid; nm text; key text;
begin
 if not viewer_is('admin') then raise exception 'Admins manage this suggestion' using errcode = '42501'; end if;
 select * into r from review_item where org_id = current_org() and id = p_item and kind = 'wa_contact' and status = 'pending';
 if r.id is null then raise exception 'A suggestion has already been decided' using errcode = 'P0002'; end if;
 pr := coalesce(r.proposed, '{}');
 if r.entity_type = 'contact' then
  select * into cp from contact_profile where org_id = current_org() and person_id = r.entity_id;
  if cp.person_id is null then
   insert into contact_profile (org_id, person_id, source) values (current_org(), r.entity_id, 'whatsapp_import') returning * into cp;
  end if;
  if nullif(pr->>'designation', '') is not null and nullif(cp.designation, '') is null and not ('designation' = any(coalesce(cp.locked, '{}'))) then
   insert into record_change (org_id, entity_type, entity_id, field, old_value, new_value, changed_by) values (current_org(), 'contact', r.entity_id, 'designation', null, pr->>'designation', current_viewer());
   update contact_profile set designation = left(pr->>'designation', 120), updated_at = now() where org_id = current_org() and person_id = r.entity_id; n := n + 1;
  end if;
  if nullif(pr->>'email', '') is not null and nullif(cp.email, '') is null and not ('email' = any(coalesce(cp.locked, '{}'))) then
   insert into record_change (org_id, entity_type, entity_id, field, old_value, new_value, changed_by) values (current_org(), 'contact', r.entity_id, 'email', null, pr->>'email', current_viewer());
   update contact_profile set email = left(lower(pr->>'email'), 200), updated_at = now() where org_id = current_org() and person_id = r.entity_id; n := n + 1;
  end if;
  if (pr->>'contactType') in ('developer', 'channel_partner', 'talent', 'vendor', 'other') and coalesce(cp.type_status, '') <> 'confirmed' and not ('contact_type' = any(coalesce(cp.locked, '{}'))) then
   update contact_profile set contact_type = pr->>'contactType', updated_at = now() where org_id = current_org() and person_id = r.entity_id; n := n + 1;
  end if;
  if nullif(pr->>'clientId', '') is not null and exists (select 1 from client where org_id = current_org() and id = (pr->>'clientId')::uuid) then
   insert into client_contact (org_id, client_id, person_id, is_primary) values (current_org(), (pr->>'clientId')::uuid, r.entity_id, false) on conflict do nothing;
   get diagnostics k = row_count; n := n + k;
  end if;
 elsif r.entity_type = 'client' and nullif(pr->>'newContact', '') is not null then
  -- someone the client's groups show and Pulse lacks: made the client's point of contact the way the import makes one
  -- (wa_import_person: a contact profile, the client link, a pending opt-in, never an invitation), named as the chats
  -- name them; a sender known only by a number is not made into a person
  key := pr->>'newContact';
  select person_id into pid from pulse_priv.wa_identity where org_id = current_org() and source_key = key;
  if pid is null then
   select pa.label into nm from pulse_priv.wa_participant pa where pa.org_id = current_org() and pa.source_key = key and pa.person_id is null
     and pa.kind in ('client', 'contact', 'unknown') and pa.label ~ '[[:alpha:]]{2}' order by pa.last_at desc nulls last limit 1;
   if nm is null then raise exception 'The chats do not name this person; add them by hand' using errcode = '22023'; end if;
   pid := wa_import_person(jsonb_build_object('key', key, 'kind', 'contact', 'name', nm, 'clientId', r.entity_id, 'basis', 'chat analysis, accepted in Review data'));
   update pulse_priv.wa_participant set person_id = pid, kind = case when kind = 'unknown' then 'contact' else kind end
    where org_id = current_org() and source_key = key and person_id is null;
   insert into record_change (org_id, entity_type, entity_id, field, old_value, new_value, changed_by) values (current_org(), 'contact', pid, 'created', null, 'from the WhatsApp groups', current_viewer());
   n := n + 1;
  else
   insert into client_contact (org_id, client_id, person_id, is_primary) values (current_org(), r.entity_id, pid, false) on conflict do nothing;
   get diagnostics k = row_count; n := n + k;
  end if;
  select * into cp from contact_profile where org_id = current_org() and person_id = pid;
  if nullif(pr->>'designation', '') is not null and coalesce(nullif(cp.designation, ''), 'Point of contact') = 'Point of contact' and not ('designation' = any(coalesce(cp.locked, '{}'))) then
   insert into record_change (org_id, entity_type, entity_id, field, old_value, new_value, changed_by) values (current_org(), 'contact', pid, 'designation', cp.designation, pr->>'designation', current_viewer());
   update contact_profile set designation = left(pr->>'designation', 120), updated_at = now() where org_id = current_org() and person_id = pid; n := n + 1;
  end if;
  if (pr->>'contactType') in ('developer', 'channel_partner', 'talent', 'vendor', 'other') and coalesce(cp.type_status, '') <> 'confirmed' and not ('contact_type' = any(coalesce(cp.locked, '{}'))) then
   update contact_profile set contact_type = pr->>'contactType', updated_at = now() where org_id = current_org() and person_id = pid; n := n + 1;
  end if;
  return jsonb_build_object('ok', true, 'changed', n, 'personId', pid);
 elsif r.entity_type = 'client' then
  select * into cl from client where org_id = current_org() and id = r.entity_id;
  if nullif(pr->>'website', '') is not null and nullif(cl.website, '') is null and not ('website' = any(coalesce(cl.locked, '{}'))) then
   insert into record_change (org_id, entity_type, entity_id, field, old_value, new_value, changed_by) values (current_org(), 'client', r.entity_id, 'website', null, pr->>'website', current_viewer());
   update client set website = left(lower(pr->>'website'), 200), updated_at = now() where org_id = current_org() and id = r.entity_id; n := n + 1;
  end if;
 end if;
 return jsonb_build_object('ok', true, 'changed', n);
end $$;

-- migrate:down
-- Forward-only.
