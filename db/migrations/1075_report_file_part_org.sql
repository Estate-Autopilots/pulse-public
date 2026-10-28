-- migrate:up
-- SHIP-FIX (26 Oct 2026): pulse_priv.report_file_part (1074) carries its organisation like every other tenant table, so
-- the isolation acceptance test (every table outside the global allow-list has org_id) holds and its policy is the
-- plain tenant rule. The loader keeps inserting (edition_id, key, n, data): a trigger copies org_id from the file row.
-- Additive: one column (filled, then required), one trigger, the policy replaced.

alter table pulse_priv.report_file_part add column org_id uuid references pulse.org(id);
update pulse_priv.report_file_part p set org_id = f.org_id
  from pulse_priv.report_file f where f.edition_id = p.edition_id and f.key = p.key and p.org_id is null;
alter table pulse_priv.report_file_part alter column org_id set not null;

create function pulse_priv.report_file_part_org() returns trigger
language plpgsql set search_path = pulse_priv, pg_temp as $$
begin
  if new.org_id is null then
    select f.org_id into new.org_id from pulse_priv.report_file f where f.edition_id = new.edition_id and f.key = new.key;
  end if;
  return new;
end $$;
revoke all on function pulse_priv.report_file_part_org() from public;
create trigger report_file_part_org before insert on pulse_priv.report_file_part
  for each row execute function pulse_priv.report_file_part_org();

drop policy tenant on pulse_priv.report_file_part;
create policy tenant on pulse_priv.report_file_part using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

-- migrate:down
-- Additive; the column and trigger stay.
