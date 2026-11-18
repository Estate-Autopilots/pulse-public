-- migrate:up
-- Fill proposals use a fixed placeholder confidence until those rules are calibrated.
-- Keep every fill-derived suggestion in Review for an individual decision.
update pulse.review_rule set enabled=false where kind='onboard_project_fill' and enabled;
-- migrate:down
-- Forward-only: fill-derived proposals must remain individually reviewable.
