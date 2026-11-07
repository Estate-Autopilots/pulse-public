-- migrate:up
-- SHIP-2: no time zone is written into the database (R51; tests/core/test_org_time_zone.py, red in pulse-ci db-09).
-- CLIENT-PORTAL's 1020 counted "today" in India in the client space's home (cp_home) and when a client accepts a
-- quotation (cp_decide: the engagement's start day). Both now take the serving company's own day
-- (pulse.org_time_zone(), as 0179 did for every earlier function). Same signatures and bodies otherwise; no data changes.
do $$
declare f text; definition text; changed text;
begin
 foreach f in array array['pulse.cp_home()', 'pulse.cp_decide(uuid,text,text,text)'] loop
  definition := pg_get_functiondef(f::regprocedure);
  changed := replace(definition, '(now() at time zone ''Asia/Kolkata'')::date', '(now() at time zone org_time_zone())::date');
  if changed = definition then raise exception 'migration 1041: % changed shape', f; end if;
  execute changed;
 end loop;
end $$;

-- migrate:down
do $$
declare f text; definition text; changed text;
begin
 foreach f in array array['pulse.cp_home()', 'pulse.cp_decide(uuid,text,text,text)'] loop
  definition := pg_get_functiondef(f::regprocedure);
  changed := replace(definition, '(now() at time zone org_time_zone())::date', '(now() at time zone ''Asia/Kolkata'')::date');
  if changed = definition then raise exception 'migration 1041: % changed shape', f; end if;
  execute changed;
 end loop;
end $$;
