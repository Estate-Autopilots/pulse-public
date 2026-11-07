-- migrate:up
-- SIGNIN-OFFICE (owner, 28 Oct 2026): EA staff typed their (often new Gmail) address where Pulse asked for its username:
-- 22 of 29 failed staff sign-ins in three days named no account. Sign-in now takes the work e-mail on file too, matched
-- exactly as Forgot your password matches it (auth_recover): one active person whose delivery address it is. Anything
-- else (a username, an unknown or shared address) comes back as typed, so sign-in fails as before and says nothing more.
create function pulse.auth_login_name(r text, input text) returns text
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare v text := lower(btrim(coalesce(input, ''))); n int; u text;
begin
  if position('@' in v) = 0 then return v; end if;
  if r = 'staff' then
    select count(*), min(pp.username) into n, u from person p join people_profile pp on pp.person_id = p.id
     where p.org_id = current_org() and p.status = 'active' and p.side = 'staff' and lower(auth_delivery(r, p.id)) = v;
  else
    select count(*), min(pr.username) into n, u from pulse_priv.portal_principal pr
     where pr.org_id = current_org() and pr.active and lower(auth_delivery(r, pr.id)) = v;
  end if;
  return case when n = 1 and u is not null then u else v end;
end $$;
revoke all on function pulse.auth_login_name(text, text) from public;
grant execute on function pulse.auth_login_name(text, text) to pulse_api;

-- migrate:down
drop function if exists pulse.auth_login_name(text, text);
