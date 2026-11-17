-- migrate:up
-- NEW-DOTS-2 (owner, 10 Nov 2026: "When a deep sub-feature, a small feature, or something deep inside a page or section
-- is updated, alert me at the top level first, then take me deeper. It should highlight the specific place, or take me
-- straight to where I should click."). A release note's line may now name an `anchor` as well as its page: the stable id
-- of the very thing that changed (a button, tab, section, field or menu item; data-new-anchor="…" in the web app). What a
-- person has seen is then kept per thing, not only per page:
--   anchor ''       they opened the page (or saw a change to the page as a whole): the dots on the way there go;
--   anchor 'x.y'    they reached the thing itself (the spotlight's Got it or Next, or using it): its own dot goes.
-- Existing rows are page rows (''), as before. Same table, same row security (each person's own rows), same grants.
alter table pulse.release_seen add column anchor text not null default ''
  check (anchor = '' or anchor ~ '^[a-z0-9][a-z0-9.-]{0,79}$');
alter table pulse.release_seen drop constraint release_seen_pkey;
alter table pulse.release_seen add primary key (org_id, person_id, note_id, route, anchor);

-- migrate:down
delete from pulse.release_seen where anchor <> '';
alter table pulse.release_seen drop constraint release_seen_pkey;
alter table pulse.release_seen add primary key (org_id, person_id, note_id, route);
alter table pulse.release_seen drop column anchor;
