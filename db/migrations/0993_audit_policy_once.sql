-- migrate:up
-- MODULES-1024: Audit's admin-only read policy (0011) called pulse.viewer_is('admin') once per row. audit_event holds
-- ~550k rows on pulse-dev, so a leader without admin waited 8-10 s for an empty page and an admin's actor filter took
-- ~5 s. As a scalar subquery the check runs once per query (an init plan); who may read is unchanged.
alter policy audit_admin on pulse.audit_event using ((select pulse.viewer_is('admin')));

-- migrate:down
alter policy audit_admin on pulse.audit_event using (pulse.viewer_is('admin'));
