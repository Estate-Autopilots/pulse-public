-- migrate:up
-- ORG-SWITCHER-UX (6 Nov 2026). The organisation switcher showed the current organisation's logo only: every other
-- company in the list was a grey initials tile, and its line read "Team · 2" (the seat's kind and a shortcut number).
-- pulse.account_seat_looks() gives, for each of the signed-in account's seats (pulse.account_seats, 1460), what the
-- switcher shows: whether the company has a square logo and its version (the browser loads it from the seat's own
-- mark address, read inside that organisation), its brand colour, and the person's access there (owner, admin,
-- leadership, hr, finance, manager, pgs, accountant or member). Each organisation is read under its own row security,
-- as account_seats reads it: pulse.org_id is set to the seat's organisation (no viewer) and put back afterwards.
create function pulse.account_seat_looks() returns jsonb
  language plpgsql security definer set search_path to 'pulse', 'pg_temp' as $function$
declare
  o text := coalesce(current_setting('pulse.org_id', true), '');
  vw text := coalesce(current_setting('pulse.viewer_id', true), '');
  s record; b record; roles text[]; title text; acc text; out jsonb := '[]'::jsonb;
begin
  if current_viewer() is null then return out; end if;
  for s in select seat_org, seat_person, seat_kind from account_seats() limit 24 loop
    perform set_config('pulse.org_id', s.seat_org::text, true);
    perform set_config('pulse.viewer_id', '', true);
    select ob.version, ob.mark is not null has_mark, ob.accent into b from org_brand ob where ob.org_id = s.seat_org;
    select coalesce(array_agg(case when r.is_manager_of_unit then 'manager' else r.role_key end), '{}') into roles
      from role_assignment r where r.person_id = s.seat_person and current_date between r.valid_from and coalesce(r.valid_to, 'infinity');
    select pp.role into title from people_profile pp where pp.person_id = s.seat_person;
    perform set_config('pulse.org_id', o, true);
    perform set_config('pulse.viewer_id', vw, true);
    acc := case when s.seat_kind <> 'staff' then s.seat_kind
      when 'admin' = any(roles) then case when coalesce(title, '') ~* '^(owner|founder|co-founder)' then 'owner' else 'admin' end
      when 'leadership' = any(roles) then 'leadership' when 'hr' = any(roles) then 'hr' when 'finance' = any(roles) then 'finance'
      when 'manager' = any(roles) then 'manager' when roles && array['pgs', 'head_pgs'] then 'pgs' else 'member' end;
    out := out || jsonb_build_array(jsonb_build_object('id', s.seat_org, 'markVersion', case when b.has_mark then coalesce(b.version, 1) end,
      'accent', b.accent, 'access', acc));
  end loop;
  return out;
end $function$;
revoke all on function pulse.account_seat_looks() from public;
grant execute on function pulse.account_seat_looks() to pulse_api;

-- migrate:down
drop function if exists pulse.account_seat_looks();
