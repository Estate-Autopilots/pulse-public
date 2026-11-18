-- migrate:up
-- LAND-CAPTAIN-6 (9 Nov 2026): funding_program.url's check was `url ~ '^https://[^\s]{3,300}$'`. Postgres allows no
-- repetition count above 255, so every row with a link failed ("invalid repetition count(s)") - the seed in 1845 on
-- production, and any funding entry with a link anywhere. 1845 now creates the valid check; this replaces the broken one
-- where 1845 already ran. Same limit: 3 to 300 characters after https://, no spaces.
alter table pulse.funding_program drop constraint if exists funding_program_url_check;
alter table pulse.funding_program add constraint funding_program_url_check
  check (url ~ '^https://[^\s]+$' and length(url) between 11 and 308);

-- migrate:down
-- Forward-only: the old check could not be evaluated.
