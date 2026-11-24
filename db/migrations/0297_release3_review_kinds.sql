-- migrate:up
-- RELEASE-3: main's 0171 (EST-656) added the onboard_project_fill review kind; dev/live's 0180 and 0181 (R55), which
-- run after it in every order, rewrote the kind list without it, so onboarding-fill suggestions would be refused. The
-- constraint keeps every kind it allows now and gains the three both sides added (additive, so a database with more
-- kinds keeps them).
do $$
declare
  current_def text := pg_get_constraintdef((select oid from pg_constraint
    where conname = 'review_item_kind_check' and conrelid = 'pulse.review_item'::regclass));
  kinds text[];
begin
  select array_agg(m[1]) into kinds from regexp_matches(current_def, '''([^'']+)''', 'g') m;
  kinds := array(select distinct k from unnest(kinds || array['onboard_project_fill', 'talent', 'geocode']) k order by k);
  alter table pulse.review_item drop constraint review_item_kind_check;
  execute format('alter table pulse.review_item add constraint review_item_kind_check check (kind = any (%L::text[]))', kinds);
end $$;

-- migrate:down
-- Forward-only.
