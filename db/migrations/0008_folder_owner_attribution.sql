-- migrate:up
alter table pulse.folder
  add column owner_account_id uuid references pulse.account(id);

-- migrate:down
alter table pulse.folder drop column owner_account_id;
