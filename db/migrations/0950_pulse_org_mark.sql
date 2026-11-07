-- migrate:up
-- PULSE-HQ (owner, 23 Oct 2026): the Pulse organisation's own mark, the Pulse "Ripple" (packages/design-system/src/brand.js
-- MARK) on an iris tile, so its tile in the switcher and the sidebar shows Pulse instead of an empty picture. Only where
-- the Pulse organisation exists and has no mark yet. Safe on a live install: one row.
do $$
declare v_org uuid;
begin
  select id into v_org from pulse.org where handle = 'pulsehq';
  if v_org is null then return; end if;
  perform set_config('pulse.org_id', v_org::text, true);
  insert into pulse.org_brand(org_id, mark, mark_mime, version)
  values (v_org, convert_to('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#5b45d6"/><path d="M8.9 13.2A9.9 9.9 0 0 1 18.8 23.1M8.9 6.2A16.9 16.9 0 0 1 25.8 23.1" fill="none" stroke="#ffffff" stroke-width="3.6" stroke-linecap="round"/><circle cx="8.9" cy="23.1" r="4.4" fill="#ffffff"/></svg>', 'UTF8'), 'image/svg+xml', 1)
  on conflict (org_id) do update set mark = excluded.mark, mark_mime = excluded.mark_mime, version = pulse.org_brand.version + 1, updated_at = now()
    where pulse.org_brand.mark is null;
  perform set_config('pulse.org_id', '', true);
end $$;

-- migrate:down
-- The mark stays with the organisation's brand (changed from Settings → Organisation like any logo).
