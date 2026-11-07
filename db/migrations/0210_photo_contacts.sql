-- migrate:up
-- PEOPLE-CONTACTS part 1 (owner, 11 Oct 2026: "add an image, with a high-precision, smooth crop, for people and
-- contacts"). Photos stay in pulse.person_photo (contacts are pulse.person rows too); the cropper saves a square WebP or
-- JPEG under the existing 400 KB limit. Who may change a photo is decided here, for every write:
--  * your own photo: always;
--  * a member of staff's photo: organisation admins, HR and leadership (as before);
--  * a contact's photo (anyone who is not staff): organisation admins, who are the ones who edit contacts.
-- Before this, HR and leadership could also change any contact's photo.
create function pulse.photo_can(p_person uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (p_person=current_viewer() or viewer_is('admin')
  or viewer_is('hr','leadership') and exists(select 1 from person where org_id=current_org() and id=p_person and side='staff'))
$$;
revoke all on function pulse.photo_can(uuid) from public;
grant execute on function pulse.photo_can(uuid) to pulse_api;

drop policy photo_insert on pulse.person_photo;
drop policy photo_update on pulse.person_photo;
drop policy photo_delete on pulse.person_photo;
create policy photo_insert on pulse.person_photo as restrictive for insert to pulse_api with check (pulse.photo_can(person_id));
create policy photo_update on pulse.person_photo as restrictive for update to pulse_api using (pulse.photo_can(person_id)) with check (pulse.photo_can(person_id));
create policy photo_delete on pulse.person_photo as restrictive for delete to pulse_api using (pulse.photo_can(person_id));

-- migrate:down
-- Forward-only.
