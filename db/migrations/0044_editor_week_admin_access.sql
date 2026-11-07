-- migrate:up
-- An Access admin may have no Pulse person row; retain the subject and purpose in the privacy log.
alter table privacy.access_log alter column viewer_id drop not null;

-- migrate:down
alter table privacy.access_log alter column viewer_id set not null;
