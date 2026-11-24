-- migrate:up
-- OFFICE-PRINT fix (21 Nov 2026, first live token): the office print agent calls app.vitalsos.ai, whose request company
-- is not the token's company, and office_print_agent's row security (org_id = current_org()) hid the token's row from
-- the lookup, so every real agent got 401. The token alone now finds its own row (only while the lookup runs, by its
-- exact sha-256); then the company is the token's, as before. Nothing else about who sees what changes.
alter policy tenant on pulse.office_print_agent
  using (org_id = pulse.current_org() or token_hash = nullif(current_setting('pulse.print_token', true), ''))
  with check (org_id = pulse.current_org());

create or replace function pulse.office_print_agent_by(p_hash text) returns pulse.office_print_agent language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a office_print_agent;
begin
 perform set_config('pulse.print_token', coalesce(p_hash, ''), true);
 select * into a from office_print_agent where token_hash = p_hash and revoked_at is null;
 perform set_config('pulse.print_token', '', true);
 if a.id is not null then perform set_config('pulse.org_id', a.org_id::text, true); end if;
 return a;
end $$;

create or replace function pulse.office_print_known(p_hash text) returns boolean language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 return (office_print_agent_by(p_hash)).id is not null;
end $$;

-- migrate:down
alter policy tenant on pulse.office_print_agent using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create or replace function pulse.office_print_agent_by(p_hash text) returns pulse.office_print_agent language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a office_print_agent;
begin
 select * into a from office_print_agent where token_hash = p_hash and revoked_at is null;
 if a.id is not null then perform set_config('pulse.org_id', a.org_id::text, true); end if;
 return a;
end $$;
create or replace function pulse.office_print_known(p_hash text) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
 select exists (select 1 from office_print_agent where token_hash = p_hash and revoked_at is null)
$$;
