-- migrate:up
-- Schema visibility alone grants no table access. Only the new ad tables have RLS-guarded SELECT grants.
grant usage on schema pulse_priv to pulse_api;
-- migrate:down
