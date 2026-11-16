-- migrate:up
-- MAIL-IDENTITY (owner, 4 Nov 2026): who an e-mail is from is chosen per kind of mail and per company
-- (services/api/src/mail-identity.ts, services/workers/src/pulse_workers/notifications.py). Both need the same few facts
-- about the company the mail is for, read in one call inside that company:
--   name     the company's name (the From name and the heading of its own mail)
--   install  whether it is this server's own company (which keeps its configured sender, PULSE_MAIL_FROM)
--   mailbox  the address of the mailbox its admin connected in Settings -> Mail (its own sender), or null
--   replyTo  where answers to mail sent for it from the platform's address go: its mailbox, else the work e-mail of its
--            longest-serving active admin; null when it has neither
--   logoPng  its e-mail logo (Settings -> Organisation, pulse.org_brand.logo_png) as base64, or null
-- Read-only, the current company only; nothing new is stored. The API and the notification worker may call it.
create function pulse.org_mail_identity() returns jsonb
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object(
   'org', o.id,
   'name', o.name,
   'install', o.id is not distinct from pulse.install_org(),
   'mailbox', (select m.address from pulse_priv.org_mailbox m where m.org_id = o.id),
   'replyTo', coalesce((select m.address from pulse_priv.org_mailbox m where m.org_id = o.id),
     (select lower(pp.email) from pulse.role_assignment ra
        join pulse.person p on p.id = ra.person_id and p.org_id = ra.org_id and p.status = 'active'
        join pulse.people_profile pp on pp.person_id = ra.person_id and pp.org_id = ra.org_id
       where ra.org_id = o.id and ra.role_key = 'admin' and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity')
         and pp.email ~ '^[^[:space:]@<>",;]+@[^[:space:]@<>",;]+\.[^[:space:]@<>",;]+$'
       order by ra.valid_from, lower(pp.email) limit 1)),
   'logoPng', (select replace(encode(b.logo_png, 'base64'), E'\n', '') from pulse.org_brand b where b.org_id = o.id and b.logo_png is not null))
 from pulse.org o where o.id = pulse.current_org()
$$;
revoke all on function pulse.org_mail_identity() from public;
grant execute on function pulse.org_mail_identity() to pulse_api, pulse_worker;

-- migrate:down
drop function pulse.org_mail_identity();
