-- migrate:up
-- MAILBOX (owner, 28 Oct 2026): "every company on the platform sends its own HR and notification e-mail". Until now only
-- the install's company (pulse.install_org()) sent mail, through the server's Google mailbox; another company's mail was
-- marked 'disabled' and never sent (ADR-0032, "until it connects its own", R52). A company's admin now connects the
-- company's own Google Workspace mailbox (Settings → Mail → Connect: Google sign-in as the sending account, scope
-- gmail.send only). Its refresh token is sealed by the API with the document keyring (document-keys.ts, bound to the
-- company) before it reaches this table: PostgreSQL keeps only the sealed bytes, the wrapped data key and the key's id.
--  * One mailbox per company (pulse_priv.org_mailbox). Admins connect, test and disconnect; nobody reads the token back.
--  * Mail for a company with no mailbox waits ('waiting_mailbox') instead of being disabled, and goes out once the company
--    connects one (while the notification is still current). Rows already 'disabled' stay as they are: they are never
--    re-sent for another company (the install's own company keeps today's behaviour).
--  * A sign-in, invitation or reset e-mail carries a one-time link and is never queued (nothing holding a capability is
--    stored); one that could not go out because no mailbox is connected is counted, so the admin sees it.
create table pulse_priv.org_mailbox(
 org_id uuid primary key references pulse.org(id),
 provider text not null default 'google' check (provider='google'),
 address text not null check (length(address)<=254 and address ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
 -- Which OAuth client issued the token: the platform's, or the company's own (its folder of the secret store).
 client text not null check (client in ('platform','company')),
 key_id text not null check (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
 token_wrapped bytea not null,
 token_sealed bytea not null,
 connected_by uuid references pulse.person(id),
 connected_at timestamptz not null default clock_timestamp(),
 last_sent_at timestamptz,
 last_error text check (length(last_error)<=300),
 last_error_at timestamptz);
-- One Google sign-in in flight per admin: the state's hash, the admin's session and the PKCE verifier, ten minutes.
create table pulse_priv.org_mailbox_attempt(
 state_hash text primary key check (state_hash ~ '^[a-f0-9]{64}$'),
 org_id uuid not null references pulse.org(id),
 person_id uuid not null references pulse.person(id),
 session_hash text not null check (session_hash ~ '^[a-f0-9]{64}$'),
 verifier text not null check (length(verifier) between 43 and 128),
 created_at timestamptz not null default clock_timestamp());
-- Sign-in, invitation and reset e-mails that could not go out because the company has no mailbox (since it last connected).
create table pulse_priv.org_mail_blocked(
 org_id uuid primary key references pulse.org(id),
 blocked int not null default 0 check (blocked>=0),
 last_at timestamptz);
do $$ declare t text; begin
 foreach t in array array['org_mailbox','org_mailbox_attempt','org_mail_blocked'] loop
  execute format('alter table pulse_priv.%I enable row level security', t);
  execute format('revoke all on table pulse_priv.%I from public', t);
 end loop;
end $$;

alter table pulse.hr_mail_outbox drop constraint hr_mail_outbox_status_check;
alter table pulse.hr_mail_outbox add constraint hr_mail_outbox_status_check
 check (status in ('queued','sent','disabled','failed','sink','waiting_mailbox'));
create index hr_mail_outbox_waiting on pulse.hr_mail_outbox(org_id) where status in ('queued','waiting_mailbox');

-- Only an individual admin of the company, in their own session (never an AI employee's).
create function pulse.org_mailbox_admin() returns void language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or agent_session() is not null or not viewer_is('admin') then
  raise exception 'Only an organisation admin connects the company mailbox' using errcode='42501';
 end if;
end $$;

-- What Settings → Mail shows: never the token.
create function pulse.org_mailbox_state() returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare m pulse_priv.org_mailbox; waiting int; blocked int;
begin
 perform org_mailbox_admin();
 select * into m from pulse_priv.org_mailbox where org_id=current_org();
 select count(*)::int into waiting from hr_mail_outbox o join notification n on n.id=o.notification_id and n.org_id=o.org_id
  where o.org_id=current_org() and o.status in ('queued','waiting_mailbox') and n.expires_at>clock_timestamp();
 select coalesce((select b.blocked from pulse_priv.org_mail_blocked b where b.org_id=current_org()),0) into blocked;
 return jsonb_build_object('install',coalesce(install_org()=current_org(),false),'connected',m.org_id is not null,
  'address',m.address,'client',m.client,'connectedAt',m.connected_at,
  'connectedBy',(select display_name from person where org_id=current_org() and id=m.connected_by),
  'lastSentAt',m.last_sent_at,'lastError',m.last_error,'lastErrorAt',m.last_error_at,'waiting',waiting,'blocked',blocked);
end $$;

-- Whether the company has a mailbox (signed-out recovery asks this before it promises an e-mail).
create function pulse.org_mailbox_ready() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from pulse_priv.org_mailbox where org_id=current_org())
$$;

create function pulse.org_mailbox_begin(p_state text,p_session text,p_verifier text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform org_mailbox_admin();
 delete from pulse_priv.org_mailbox_attempt where org_id=current_org() and (person_id=current_viewer() or created_at<clock_timestamp()-interval '10 minutes');
 insert into pulse_priv.org_mailbox_attempt(state_hash,org_id,person_id,session_hash,verifier) values(p_state,current_org(),current_viewer(),p_session,p_verifier);
end $$;

-- The callback: the attempt is used up before the code is exchanged, so a replayed state finds nothing. Only the admin
-- who started it, in the same session, within ten minutes.
create function pulse.org_mailbox_take(p_state text,p_session text) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v text;
begin
 perform org_mailbox_admin();
 delete from pulse_priv.org_mailbox_attempt where org_id=current_org() and state_hash=p_state returning
  case when person_id=current_viewer() and session_hash=p_session and created_at>clock_timestamp()-interval '10 minutes' then verifier end into v;
 return v;
end $$;

create function pulse.org_mailbox_save(p_address text,p_client text,p_key_id text,p_wrapped bytea,p_sealed bytea) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform org_mailbox_admin();
 insert into pulse_priv.org_mailbox(org_id,address,client,key_id,token_wrapped,token_sealed,connected_by)
 values(current_org(),lower(p_address),p_client,p_key_id,p_wrapped,p_sealed,current_viewer())
 on conflict(org_id) do update set address=excluded.address,client=excluded.client,key_id=excluded.key_id,token_wrapped=excluded.token_wrapped,
  token_sealed=excluded.token_sealed,connected_by=excluded.connected_by,connected_at=clock_timestamp(),last_error=null,last_error_at=null;
 delete from pulse_priv.org_mail_blocked where org_id=current_org();
 -- What waited for the mailbox goes out now (only what is still current: the outbox expires older notices).
 update hr_mail_outbox set status='queued' where org_id=current_org() and status='waiting_mailbox';
 perform audit_write('mailbox.connect','org_mailbox',null,array[p_client]);
 return org_mailbox_state();
end $$;

create function pulse.org_mailbox_disconnect() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform org_mailbox_admin();
 delete from pulse_priv.org_mailbox where org_id=current_org();
 perform audit_write('mailbox.disconnect','org_mailbox');
 return org_mailbox_state();
end $$;

-- For the API's sender and the worker only (the bytes are useless without the keyring, which PostgreSQL never sees).
create function pulse.org_mailbox_sealed() returns table(address text,client text,key_id text,token_wrapped bytea,token_sealed bytea)
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select address,client,key_id,token_wrapped,token_sealed from pulse_priv.org_mailbox where org_id=current_org()
$$;

-- After a send: when it last worked, or what went wrong (a short, secret-free reason).
create function pulse.org_mailbox_report(p_ok boolean,p_error text default null) returns void language sql security definer set search_path=pulse,pg_temp as $$
 update pulse_priv.org_mailbox set last_sent_at=case when p_ok then clock_timestamp() else last_sent_at end,
  last_error=case when p_ok then null else left(coalesce(p_error,'Sending failed'),300) end,
  last_error_at=case when p_ok then null else clock_timestamp() end
 where org_id=current_org()
$$;

create function pulse.org_mail_blocked_note() returns void language sql security definer set search_path=pulse,pg_temp as $$
 insert into pulse_priv.org_mail_blocked(org_id,blocked,last_at) values(current_org(),1,clock_timestamp())
 on conflict(org_id) do update set blocked=pulse_priv.org_mail_blocked.blocked+1,last_at=clock_timestamp()
$$;

revoke all on function pulse.org_mailbox_admin(),pulse.org_mailbox_state(),pulse.org_mailbox_ready(),pulse.org_mailbox_begin(text,text,text),
 pulse.org_mailbox_take(text,text),pulse.org_mailbox_save(text,text,text,bytea,bytea),pulse.org_mailbox_disconnect(),pulse.org_mailbox_sealed(),
 pulse.org_mailbox_report(boolean,text),pulse.org_mail_blocked_note() from public;
grant execute on function pulse.org_mailbox_state(),pulse.org_mailbox_ready(),pulse.org_mailbox_begin(text,text,text),pulse.org_mailbox_take(text,text),
 pulse.org_mailbox_save(text,text,text,bytea,bytea),pulse.org_mailbox_disconnect(),pulse.org_mailbox_sealed(),pulse.org_mailbox_report(boolean,text),
 pulse.org_mail_blocked_note() to pulse_api;
grant execute on function pulse.org_mailbox_sealed(),pulse.org_mailbox_report(boolean,text) to pulse_worker;

-- The e-mail copies the outbox picks up: queued, and what waited for the company mailbox. A row already disabled is
-- picked up again only for the install company (as before); another company never re-sends its disabled history.
create or replace function pulse.notification_outbox_seed(p_channel text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 -- Only an undispatched lease can safely be retried. A crashed dispatch is ambiguous, never replayed.
 update notification_delivery set status=case when status='dispatching' then 'uncertain' else 'queued' end,lease_token=null,lease_until=null
 where org_id=current_org() and channel=p_channel and status in ('leased','dispatching') and lease_until<clock_timestamp();
 update notification_delivery q set status='expired' from notification n where q.org_id=current_org() and n.id=q.notification_id
 and q.status in ('queued','leased') and (n.expires_at<=clock_timestamp() or q.attempts>=5);
 update notification_delivery q set status='suppressed' where q.org_id=current_org() and q.channel=p_channel and q.status='queued'
 and (p_channel='web' and exists(select 1 from web_push_delivery old where old.org_id=q.org_id and old.notification_id=q.notification_id and old.subscription_id=q.destination_id and old.status in ('accepted','expired','suppressed'))
 or p_channel='native' and exists(select 1 from native_push_delivery old where old.org_id=q.org_id and old.notification_id=q.notification_id and old.device_id=q.destination_id and old.sent_at is not null)
 -- ATT: a quiet notification never pushes (it waits in the bell); HR copies by Telegram or email are the person's
 -- own opt-in and go unless they muted that kind or it is over its daily limit.
 or exists(select 1 from notification n where n.id=q.notification_id and (q.channel in ('web','native') and n.quiet or n.quiet_reason in ('muted','limit'))));
 if p_channel='web' then
  insert into notification_delivery(org_id,notification_id,channel,destination_id,destination_version)
  select n.org_id,n.id,'web',s.id,s.created_at::text from notification n join web_push_subscription s using(org_id,person_id)
  where n.org_id=current_org() and n.created_at>=s.created_at and s.disabled_at is null and n.expires_at>clock_timestamp() and not n.quiet
  and (n.read_at is null or n.message_id is not null and exists(select 1 from web_push_delivery old
   where old.org_id=n.org_id and old.notification_id=n.id and old.subscription_id=s.id and old.status='queued'))
  and n.event_type<>'update.self'
  and not exists(select 1 from web_push_delivery old where old.org_id=n.org_id and old.notification_id=n.id and old.subscription_id=s.id and old.status in ('accepted','expired','suppressed')) on conflict do nothing;
 elsif p_channel='native' then
  insert into notification_delivery(org_id,notification_id,channel,destination_id,destination_version)
  select n.org_id,n.id,'native',d.id,d.consent_epoch::text from notification n join native_device d using(org_id,person_id)
  where n.org_id=current_org() and n.created_at>=d.created_at and d.revoked_at is null and d.push_token is not null
  and d.platform in ('ios','android') and n.expires_at>clock_timestamp() and n.read_at is null and n.event_type<>'update.self' and not n.quiet
  and not exists(select 1 from native_push_delivery old where old.org_id=n.org_id and old.notification_id=n.id and old.device_id=d.id and old.sent_at is not null) on conflict do nothing;
 elsif p_channel='telegram' then
  insert into notification_delivery(org_id,notification_id,channel,destination_id,destination_version)
  select n.org_id,n.id,'telegram',n.person_id,t.verified_at::text from notification n join pulse_priv.telegram_person t using(org_id,person_id)
  where n.org_id=current_org() and n.telegram_status='queued' and n.expires_at>clock_timestamp() and coalesce(n.quiet_reason,'') not in ('muted','limit')
  and n.event_type in ('leave.decision','request.decision','request.updated','approval.waiting','approval.reminder','approval.digest') on conflict do nothing;
 elsif p_channel='email' then
  insert into notification_delivery(org_id,notification_id,channel,destination_id,destination_version)
  select n.org_id,n.id,'email',n.person_id,'hr-copy' from notification n join hr_mail_outbox m on m.notification_id=n.id and m.org_id=n.org_id and m.person_id=n.person_id
  where n.org_id=current_org() and (m.status in ('queued','waiting_mailbox') or m.status='disabled' and current_org()=install_org()) and n.expires_at>clock_timestamp() and coalesce(n.quiet_reason,'') not in ('muted','limit')
  and n.event_type in ('leave.decision','request.decision','request.updated','approval.waiting','approval.reminder','approval.digest') on conflict do nothing;
 end if;
end $$;

-- migrate:down
-- Forward-only.
