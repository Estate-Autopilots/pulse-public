-- migrate:up
-- MAILBOX (1370): the company mailbox, its sign-in attempts and its blocked-mail count are one organisation's rows:
-- forced row security like every tenant table (acceptance isolation, as 1261 did for 1260). Every function in 1370
-- already reads and writes them only for pulse.current_org(), so the policy changes nothing they do.
do $$ declare t text; begin
 foreach t in array array['org_mailbox','org_mailbox_attempt','org_mail_blocked'] loop
  execute format('alter table pulse_priv.%I force row level security', t);
  execute format('create policy tenant on pulse_priv.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
 end loop;
end $$;

-- migrate:down
do $$ declare t text; begin
 foreach t in array array['org_mailbox','org_mailbox_attempt','org_mail_blocked'] loop
  execute format('drop policy if exists tenant on pulse_priv.%I', t);
  execute format('alter table pulse_priv.%I no force row level security', t);
 end loop;
end $$;
