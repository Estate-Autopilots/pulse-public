-- migrate:up
-- ACCOUNT-META (owner, 15 Nov 2026): a person is a personal entity and signs in only with the e-mail they name as their
-- own; "admin@ addresses that I and others control cannot be able to log in — it is a security issue." and "A company admin can remove
-- a person from the company but can never sign in as them or change their personal sign-in e-mails."
--
-- Until now a Pulse account (one per human) could be reached through things a company controls:
--  - a seat's profile e-mail in any company named the account for the e-mailed code and for the password (1585, 1841);
--  - the company's own staff code went to the work e-mail on record (a shared admin@ mailbox too), and right after it
--    account_land moved that session into the account's last company (1291), so whoever reads admin@ reached every
--    company of the account, the person's own space included;
--  - Continue with Google / Microsoft / Apple matched a shared mailbox like any other address;
--  - a company password (which the company's admin can issue) opened the whole account when it had no password of its own,
--    and "One password for all" / account_claim then let that session set the account's own password.
-- Now:
--  1. Shared mailboxes (admin@, info@, billing@, ... and any exact address put on the list) never sign anyone in: not by
--     code, link, reset, Google/Microsoft/Apple, or as an account's e-mail. They are taken off every account (kept in
--     account_login_email_removed, one login_email_removed event per account).
--  2. An account's sign-in e-mails are exactly its own e-mail and its linked sign-in e-mails (acct_signin_emails), shown
--     in Settings -> Account access. A seat's profile e-mail is the company's record, not a way into the account.
--     Linked e-mails now work with the password too (they were codes-only), so "the e-mails that sign you in" is one list.
--  3. A session is personal when it proved the person, not a company: the account's own password, or a code to one of the
--     account's personal e-mails (a mailbox no company runs, like Gmail, or one the person proved with a code and confirmed
--     "only I read this"). Everything else (a company password, the staff code, company Google, Access) is company-only.
--  4. A company-only session stays in its company: it cannot switch or land in another company or the personal space,
--     and cannot change the account's sign-in (password, handle, e-mails) - once the account has a personal sign-in.
--     Accounts with no personal sign-in yet (a company made them and nobody has claimed them) keep switching between
--     their companies as before, never into a personal space; adding a personal e-mail protects them.
--  5. Settings -> Account access: list, add (code + "only I read this mailbox"), remove, make primary; sessions; the rule.
-- The owner's rule replaces the brief's "link every work e-mail": no work e-mail is linked to anyone by this migration.

-- ------------------------------------------------------------------------------------------------ 1. shared mailboxes
create table pulse_priv.shared_mailbox (
  pattern   text primary key check (pattern ~ '^[a-z0-9._+-]+(@[a-z0-9.-]+\.[a-z]{2,})?$' and length(pattern) <= 254),
  note      text check (length(note) <= 200),
  added_at  timestamptz not null default now()
);
revoke all on pulse_priv.shared_mailbox from public;
-- A name before the @ (any domain), or one exact address. Owner's list first, then the usual role mailboxes.
insert into pulse_priv.shared_mailbox(pattern, note)
select x, 'role mailbox (ACCOUNT-META)' from unnest(array[
  'admin', 'administrator', 'admins', 'info', 'information', 'billing', 'bills', 'marketing', 'hr', 'humanresources',
  'accounts', 'account', 'accounting', 'accountant', 'finance', 'payments', 'payment', 'payroll', 'invoice', 'invoices',
  'sales', 'support', 'help', 'helpdesk', 'service', 'services', 'customercare', 'care', 'contact', 'contactus', 'hello',
  'team', 'office', 'ops', 'operations', 'legal', 'compliance', 'privacy', 'security', 'abuse', 'postmaster',
  'webmaster', 'hostmaster', 'noreply', 'no-reply', 'no.reply', 'donotreply', 'do-not-reply', 'mail', 'mailer',
  'newsletter', 'press', 'media', 'pr', 'social', 'partners', 'partnership', 'partnerships', 'enquiry', 'enquiries',
  'inquiry', 'inquiries', 'orders', 'purchase', 'procurement', 'vendors', 'careers', 'jobs', 'hiring', 'recruitment',
  'recruiting', 'talent', 'people', 'reception', 'frontdesk', 'management', 'founders', 'directors', 'board', 'all',
  'everyone', 'staff', 'employees', 'alerts', 'notifications', 'events', 'feedback', 'leads', 'root', 'system', 'it'
]) x;

-- Whether an address is a shared or role mailbox (its name before the @, without a +tag, or the exact address is listed).
create function pulse.mailbox_shared(p_email text) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(position('@' in lower(btrim(p_email))) > 1, false) and exists (
    select 1 from pulse_priv.shared_mailbox s
     where s.pattern = lower(btrim(p_email))
        or s.pattern = regexp_replace(split_part(lower(btrim(p_email)), '@', 1), '\+.*$', ''))
$$;

-- Mail services anyone signs up to: no company reads or resets these mailboxes.
create function pulse.mailbox_consumer(p_email text) returns boolean
  language sql immutable set search_path = pulse, pg_temp as $$
  select coalesce(split_part(lower(btrim(p_email)), '@', 2) = any (array['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com',
    'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'ymail.com', 'rocketmail.com', 'icloud.com', 'me.com', 'mac.com',
    'proton.me', 'protonmail.com', 'pm.me', 'aol.com', 'gmx.com', 'gmx.net', 'yandex.com', 'rediffmail.com', 'zohomail.com',
    'zohomail.in', 'mail.com', 'tutanota.com', 'tuta.io', 'hey.com', 'fastmail.com']), false)
$$;

-- The company's delivery address for its own codes, links, resets and second steps (0104), never a shared mailbox: the
-- next address on record is used instead, or none (then no code or link goes out: "Ask your admin"). Clients keep theirs.
create or replace function pulse.auth_delivery(r text, a uuid) returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(
    (select case when mailbox_shared(delivery) then null else delivery end from pulse_priv.auth_account where org_id = current_org() and realm = r and actor = a),
    case when r = 'staff' then
      (select coalesce(case when mailbox_shared(pp.email) then null else nullif(pp.email, '') end,
                       case when mailbox_shared(hc.personal_email) then null else nullif(hc.personal_email, '') end)
         from people_profile pp left join pulse_priv.hr_contact hc on hc.person_id = pp.person_id where pp.org_id = current_org() and pp.person_id = a)
    else (select delivery_email from pulse_priv.portal_principal where org_id = current_org() and id = a) end)
$$;

-- ------------------------------------------------------------------------------------------------ 2. sign-in e-mails
-- What was taken off an account, kept (never the only copy deleted): the report for the owner and a way back.
create table pulse_priv.account_login_email_removed (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null,
  email       text not null check (length(email) <= 254),
  was         text not null check (was in ('account', 'merge', 'restore', 'self')),
  reason      text not null check (reason in ('shared_mailbox', 'removed_by_person', 'made_primary_elsewhere')),
  removed_at  timestamptz not null default now()
);
create index account_login_email_removed_account on pulse_priv.account_login_email_removed(account_id, removed_at desc);
revoke all on pulse_priv.account_login_email_removed from public;

alter table pulse_priv.account_login_email
  add column kind text not null default 'personal' check (kind in ('personal', 'work')),
  add column own_confirmed_at timestamptz;
alter table pulse_priv.account_login_email drop constraint account_login_email_source_check;
alter table pulse_priv.account_login_email add constraint account_login_email_source_check check (source in ('merge', 'restore', 'self'));
alter table pulse_priv.pulse_account add column email_own_confirmed_at timestamptz;

-- Shared mailboxes off every account now (the owner's admin@ addresses among them), recorded first.
insert into pulse_priv.account_login_email_removed(account_id, email, was, reason)
  select id, lower(btrim(email)), 'account', 'shared_mailbox' from pulse_priv.pulse_account where email is not null and pulse.mailbox_shared(email);
insert into pulse_priv.account_login_email_removed(account_id, email, was, reason)
  select account_id, email, source, 'shared_mailbox' from pulse_priv.account_login_email where pulse.mailbox_shared(email);
insert into pulse_priv.account_auth_event(account_id, action)
  select distinct account_id, 'login_email_removed' from pulse_priv.account_login_email_removed where reason = 'shared_mailbox';
update pulse_priv.pulse_account set email = null, email_verified_at = null, email_confirmed_at = null, updated_at = now()
 where email is not null and pulse.mailbox_shared(email);
delete from pulse_priv.account_login_email where pulse.mailbox_shared(email);

-- From now on a shared mailbox never becomes an account's e-mail (a first sign-in copying a seat's admin@ makes an account
-- without one) nor a linked sign-in e-mail (refused with the reason).
create function pulse.acct_shared_mailbox_guard() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if new.email is not null and mailbox_shared(new.email) then
    if tg_table_name = 'account_login_email' then
      raise exception 'That looks like a shared mailbox (admin@, info@, billing@ ...). Only an e-mail that you alone read can sign you in.' using errcode = '22023';
    end if;
    insert into pulse_priv.account_login_email_removed(account_id, email, was, reason) values (new.id, lower(btrim(new.email)), 'account', 'shared_mailbox');
    new.email := null; new.email_verified_at := null; new.email_confirmed_at := null; new.email_own_confirmed_at := null;
  elsif tg_table_name = 'pulse_account' and new.email is not null then
    -- An address the person typed and proved in the same step (sign-up, "use a new address") is theirs: they named it.
    -- One copied from a company's record arrives unproved and stays a work e-mail until they confirm it.
    if tg_op = 'INSERT' then
      new.email_own_confirmed_at := case when coalesce(new.email_verified_at, new.email_confirmed_at) is not null then coalesce(new.email_own_confirmed_at, now()) end;
    elsif old.email is distinct from new.email then
      new.email_own_confirmed_at := case when coalesce(new.email_verified_at, new.email_confirmed_at) is not null then coalesce(new.email_own_confirmed_at, now()) end;
    end if;
  end if;
  return new;
end $$;
create trigger pulse_account_shared_mailbox before insert or update of email on pulse_priv.pulse_account
  for each row execute function pulse.acct_shared_mailbox_guard();
create trigger account_login_email_shared_mailbox before insert or update of email on pulse_priv.account_login_email
  for each row execute function pulse.acct_shared_mailbox_guard();

-- 1585's merge and restore: the merged account's own e-mail keeps what it was. Theirs alone (proved in one step, or
-- confirmed) stays a personal sign-in e-mail of the kept account; a company's address stays a work one. A shared mailbox
-- is never linked (it was taken off above, and the trigger refuses it).
create or replace function pulse.account_merge(p_keep uuid, p_drop uuid, p_handle text, p_actor text, p_same_org text default 'refuse')
  returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare d pulse_priv.pulse_account%rowtype; k pulse_priv.pulse_account%rowtype; rec jsonb; e text; linked text := null;
begin
  select * into d from pulse_priv.pulse_account where id = p_drop;
  select * into k from pulse_priv.pulse_account where id = p_keep;
  rec := acct_merge_core(p_keep, p_drop, p_handle, p_actor, p_same_org);
  e := lower(btrim(coalesce(d.email, '')));
  if e <> '' and not mailbox_shared(e) and coalesce(d.email_verified_at, d.email_confirmed_at) is not null and not coalesce((rec ->> 'email_moved')::boolean, false)
     and e is distinct from lower(btrim(coalesce(k.email, ''))) then
    insert into pulse_priv.account_login_email(email, account_id, verified_at, source, kind, own_confirmed_at)
    values (e, p_keep, coalesce(d.email_verified_at, d.email_confirmed_at), 'merge',
            case when d.email_own_confirmed_at is not null or mailbox_consumer(e) then 'personal' else 'work' end, d.email_own_confirmed_at)
    on conflict (email) do nothing;
    if found then linked := e; end if;
  end if;
  return rec || jsonb_build_object('login_email', linked);
end $$;

create or replace function pulse.account_login_email_restore(p_records jsonb, p_actor text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r jsonb; list jsonb; e text; v timestamptz; own timestamptz; keep uuid; done jsonb := '[]'; skipped jsonb := '[]';
begin
  if coalesce(btrim(p_actor), '') = '' then raise exception 'account_login_email_restore: say who runs it (actor)' using errcode = '22023'; end if;
  list := case when jsonb_typeof(p_records) = 'array' then p_records when p_records ? 'records' then p_records -> 'records' else jsonb_build_array(p_records) end;
  for r in select * from jsonb_array_elements(list) loop
    if r ->> 'contract' is distinct from 'pulse-account-merge.v1' then continue; end if;
    keep := (r ->> 'keep')::uuid;
    e := lower(btrim(coalesce(r #>> '{drop_account,email}', '')));
    v := coalesce((r #>> '{drop_account,email_verified_at}')::timestamptz, (r #>> '{drop_account,email_confirmed_at}')::timestamptz);
    own := (r #>> '{drop_account,email_own_confirmed_at}')::timestamptz;  -- records from before 2125 have none: a work e-mail until confirmed
    if e = '' or v is null or coalesce((r ->> 'email_moved')::boolean, false) then skipped := skipped || to_jsonb(coalesce(nullif(e, ''), '(none)') || ': not verified, none or moved'); continue; end if;
    if mailbox_shared(e) then skipped := skipped || to_jsonb(e || ': a shared mailbox'); continue; end if;
    if not exists (select 1 from pulse_priv.pulse_account where id = keep) then skipped := skipped || to_jsonb(e || ': kept account gone'); continue; end if;
    if exists (select 1 from pulse_priv.pulse_account where lower(btrim(email)) = e) then skipped := skipped || to_jsonb(e || ': an account has it'); continue; end if;
    insert into pulse_priv.account_login_email(email, account_id, verified_at, source, kind, own_confirmed_at)
    values (e, keep, v, 'restore', case when own is not null or mailbox_consumer(e) then 'personal' else 'work' end, own) on conflict (email) do nothing;
    if found then
      done := done || to_jsonb(e);
      perform acct_event(keep, 'login_email_linked');
    else
      skipped := skipped || to_jsonb(e || ': already linked');
    end if;
  end loop;
  return jsonb_build_object('linked', done, 'skipped', skipped, 'actor', left(p_actor, 300));
end $$;

-- The e-mails that sign this account in, and which of them prove the person (personal) rather than a company.
create function pulse.acct_signin_emails(p_account uuid)
  returns table(email text, personal boolean, is_primary boolean, verified boolean, kind text, source text)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  -- The account's own e-mail is personal once proved: a consumer mailbox a code reached, or one the person confirmed is
  -- theirs alone (a company typed it onto a record otherwise).
  select lower(btrim(pa.email)),
         pa.email_own_confirmed_at is not null or (mailbox_consumer(pa.email) and coalesce(pa.email_verified_at, pa.email_confirmed_at) is not null), true,
         coalesce(pa.email_verified_at, pa.email_confirmed_at) is not null,
         case when pa.email_own_confirmed_at is not null or (mailbox_consumer(pa.email) and coalesce(pa.email_verified_at, pa.email_confirmed_at) is not null)
              then 'personal' else 'work' end, 'account'
    from pulse_priv.pulse_account pa where pa.id = p_account and pa.email is not null and not mailbox_shared(pa.email)
  union all
  select le.email, mailbox_consumer(le.email) or le.own_confirmed_at is not null, false, true,
         case when mailbox_consumer(le.email) then 'personal' else le.kind end, le.source
    from pulse_priv.account_login_email le
   where le.account_id = p_account and not mailbox_shared(le.email)
     and le.email is distinct from (select lower(btrim(x.email)) from pulse_priv.pulse_account x where x.id = p_account)
$$;

create function pulse.acct_email_personal(p_account uuid, p_email text) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select p_account is not null and p_email is not null
     and exists (select 1 from acct_signin_emails(p_account) e where e.email = lower(btrim(p_email)) and e.personal)
$$;

-- The account has an e-mail of the person's own (owner's rule: then only such e-mails sign it in).
create function pulse.acct_has_personal_email(p_account uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (select 1 from acct_signin_emails(p_account) e where e.personal)
$$;

-- The account has a sign-in of its own that no company controls: its own password, or a personal e-mail.
create function pulse.acct_has_personal(p_account uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (select 1 from pulse_priv.pulse_account where id = p_account and password_hash is not null)
      or acct_has_personal_email(p_account)
$$;

-- Accounts that only ever lived in their own space (no company seat) proved their e-mail themselves: it is theirs.
update pulse_priv.pulse_account pa set email_own_confirmed_at = coalesce(pa.email_verified_at, pa.email_confirmed_at)
 where pa.email is not null and coalesce(pa.email_verified_at, pa.email_confirmed_at) is not null
   and not exists (select 1 from pulse_priv.account_member am join pulse.org o on o.id = am.member_org
                    where am.account_id = pa.id and o.personal_account is null);

-- The one account an e-mail signs in to (its own e-mail or a linked sign-in e-mail), or null. Owner's rule: once an
-- account has a personal sign-in, only its personal e-mails sign it in (a work e-mail a company runs no longer does).
create function pulse.acct_by_signin_email(p_email text) returns uuid
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select case when count(distinct a) = 1 then min(a::text)::uuid end from (
    select id a from pulse_priv.pulse_account where lower(btrim(email)) = lower(btrim(p_email)) and not mailbox_shared(email)
    union all
    select account_id from pulse_priv.account_login_email where email = lower(btrim(p_email)) and not mailbox_shared(email)) x
   where acct_email_personal(x.a, p_email) or not acct_has_personal_email(x.a)
$$;

-- ------------------------------------------------------------------------------------------------ 3. personal sessions
alter table pulse.login_session add column personal boolean not null default false;
alter table pulse_priv.account_challenge add column personal boolean not null default false;

create function pulse.acct_mark_personal(p_org uuid, p_hash text) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform acct_enter(p_org, null);
  update login_session set personal = true where org_id = p_org and token_hash = p_hash and revoked_at is null;
  perform acct_leave();
end $$;

-- The request's own session (the API sets pulse.viewer_session to its hash) proved the person.
create function pulse.viewer_personal() returns boolean
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare h text := nullif(current_setting('pulse.viewer_session', true), '');
begin
  if h is null or current_viewer() is null then return false; end if;
  return exists (select 1 from login_session where org_id = current_org() and token_hash = h and person_id = current_viewer()
                  and revoked_at is null and expires_at > now() and personal);
end $$;

-- A personal space (1640's personal_account, or ACCOUNT-META's kind) belongs to one person only.
create function pulse.org_is_personal(p_org uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (select 1 from org where id = p_org and personal_account is not null)
$$;

-- Whether a session may open another of the account's companies.
create function pulse.acct_may_cross(p_account uuid, p_personal boolean, p_to uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(p_personal, false) or (not org_is_personal(p_to) and not acct_has_personal(p_account))
$$;

create function pulse.acct_personal_needed() returns text
  language sql immutable as $$
  select 'To open your other companies, sign in as yourself: with your own e-mail or your Pulse password. A company''s sign-in opens that company only.'::text
$$;

-- The account's sign-in may be changed only by a personal session once it has a personal sign-in.
create function pulse.acct_change_allowed(p_account uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select p_account is null or not acct_has_personal(p_account) or viewer_personal()
$$;

create function pulse.acct_require_change(v uuid) returns void
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if not acct_change_allowed(v) then
    raise exception 'Sign in as yourself to change your sign-in: with your own e-mail or your Pulse password.' using errcode = '42501', hint = 'personal_sign_in';
  end if;
end $$;

-- 0920's session for an account in one of its companies. A session the signed-in person makes for themselves (start a
-- company, accept an invitation, leave one for another) carries their own session's proof; a sign-in marks its own.
create or replace function pulse.acct_session(p_account uuid, p_org uuid, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m record; o record; ok boolean; per boolean := viewer_personal();
begin
  select * into m from pulse_priv.account_member where account_id = p_account and member_org = p_org;
  if not found then return null; end if;
  select id, name, handle, status, activation into o from org where id = p_org;
  if o.status <> 'active' then return null; end if;
  perform acct_enter(p_org, null);
  select exists (select 1 from person where id = m.person_id and status = 'active') into ok;
  if ok then
    insert into login_session(org_id, person_id, token_hash, expires_at, device, remembered, via, personal)
    values (p_org, m.person_id, p_hash, now() + interval '30 days', left(coalesce(p_device, 'Browser'), 120), true, 'account', per);
  end if;
  perform acct_leave();
  if not ok then return null; end if;
  update pulse_priv.account_member set last_used_at = now() where account_id = p_account and member_org = p_org;
  update pulse_priv.pulse_account set last_org = p_org, updated_at = now() where id = p_account;
  return jsonb_build_object('org', p_org, 'name', o.name, 'handle', o.handle, 'person', m.person_id, 'kind', m.kind, 'install', p_org = install_org());
end $$;

-- The person just gave an account that had no sign-in of its own its first one (a password, an e-mail only they read):
-- the company had it until now, so this session is theirs from here on.
create function pulse.acct_upgrade_viewer_session(p_before boolean) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); h text := nullif(current_setting('pulse.viewer_session', true), '');
begin
  if p_before or v is null or h is null or not acct_has_personal(v) then return; end if;
  update login_session set personal = true where org_id = current_org() and token_hash = h and person_id = current_viewer() and revoked_at is null;
end $$;

-- Any change that gives the signed-in person's account its first sign-in of its own (a password: claim, one password for
-- all; an e-mail they proved: "verify my e-mail", "use a new address") makes their current session theirs.
create function pulse.acct_first_own_sign_in() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare before boolean;
begin
  if account_of_viewer() is distinct from new.id then return null; end if;
  before := old.password_hash is not null
    or (old.email is not null and not mailbox_shared(old.email)
        and (old.email_own_confirmed_at is not null or (mailbox_consumer(old.email) and coalesce(old.email_verified_at, old.email_confirmed_at) is not null)))
    or exists (select 1 from pulse_priv.account_login_email le where le.account_id = new.id and not mailbox_shared(le.email)
                and (mailbox_consumer(le.email) or le.own_confirmed_at is not null));
  perform acct_upgrade_viewer_session(before);
  return null;
end $$;
create trigger pulse_account_first_own_sign_in after update of password_hash, email, email_verified_at, email_confirmed_at, email_own_confirmed_at
  on pulse_priv.pulse_account for each row execute function pulse.acct_first_own_sign_in();

-- A new account the person makes themselves (an invitation link with their own password, sign-up with a code to their
-- own e-mail, sign-up through an app): its first session is theirs.
alter function pulse.account_join(text, jsonb, text, text) rename to acct_join_core;
revoke all on function pulse.acct_join_core(text, jsonb, text, text) from public, pulse_api;
create function pulse.account_join(p_link text, p jsonb, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare r jsonb := acct_join_core(p_link, p, p_hash, p_device);
begin
  if r ? 'org' and not coalesce((r ->> 'waiting')::boolean, false) then perform acct_mark_personal((r ->> 'org')::uuid, p_hash); end if;
  return r;
end $$;
alter function pulse.account_signup_confirm(jsonb, text, text, text) rename to acct_signup_confirm_core;
revoke all on function pulse.acct_signup_confirm_core(jsonb, text, text, text) from public, pulse_api;
create function pulse.account_signup_confirm(p jsonb, p_code text, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare r jsonb := acct_signup_confirm_core(p, p_code, p_hash, p_device);
begin
  if r ? 'org' then perform acct_mark_personal((r ->> 'org')::uuid, p_hash); end if;
  return r;
end $$;
alter function pulse.account_signup(jsonb, text, text) rename to acct_signup_core;
revoke all on function pulse.acct_signup_core(jsonb, text, text) from public, pulse_api;
create function pulse.account_signup(p jsonb, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare r jsonb := acct_signup_core(p, p_hash, p_device);
begin
  if r ? 'org' then perform acct_mark_personal((r ->> 'org')::uuid, p_hash); end if;
  return r;
end $$;
revoke all on function pulse.account_join(text, jsonb, text, text), pulse.account_signup_confirm(jsonb, text, text, text), pulse.account_signup(jsonb, text, text) from public;
grant execute on function pulse.account_join(text, jsonb, text, text), pulse.account_signup_confirm(jsonb, text, text, text), pulse.account_signup(jsonb, text, text) to pulse_api;

-- 1291's move, which a company-only session may no longer make across companies (and which keeps the session's proof).
create or replace function pulse.acct_move(p_account uuid, p_hash text, p_from uuid, p_to uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m record; o record; s login_session%rowtype; ok boolean;
begin
  select * into m from pulse_priv.account_member where account_id = p_account and member_org = p_to;
  if m.person_id is null then return null; end if;
  select id, name, handle, status into o from org where id = p_to;
  if o.status is distinct from 'active' then return null; end if;
  perform acct_enter(p_from, null);
  select * into s from login_session where token_hash = p_hash and org_id = p_from and revoked_at is null and expires_at > now() for update;
  perform acct_leave();
  if s.token_hash is null or s.native_device_id is not null then return null; end if;
  if not exists (select 1 from pulse_priv.account_member where account_id = p_account and member_org = p_from and person_id = s.person_id) then return null; end if;
  if p_from <> p_to then
    if not acct_may_cross(p_account, s.personal, p_to) then return null; end if;
    perform acct_enter(p_to, m.person_id);
    select exists (select 1 from person where id = m.person_id and status = 'active') into ok;
    perform acct_leave();
    if not ok then return null; end if;
    perform acct_enter(p_from, s.person_id);
    update login_session set token_hash = 'moved:' || replace(gen_random_uuid()::text, '-', ''), revoked_at = now() where token_hash = p_hash and org_id = p_from;
    perform audit_write('org_switch', 'organisation', p_to::text);
    perform acct_leave();
    perform acct_enter(p_to, m.person_id);
    insert into login_session(org_id, person_id, token_hash, expires_at, device, remembered, via, second_factor_verified, personal)
    values (p_to, m.person_id, p_hash, s.expires_at, s.device, s.remembered, 'account', s.second_factor_verified, s.personal);
    perform audit_write('org_switch_in', 'organisation', p_from::text);
    perform acct_leave();
  end if;
  update pulse_priv.account_member set last_used_at = now() where account_id = p_account and member_org = p_to;
  update pulse_priv.pulse_account set last_org = p_to, updated_at = now() where id = p_account;
  return jsonb_build_object('org', p_to, 'name', o.name, 'handle', o.handle, 'person', m.person_id, 'kind', m.kind,
    'install', p_to = install_org(), 'moved', true);
end $$;

-- The switcher's move: says why when it is the company-only rule.
create or replace function pulse.account_move(p_org uuid, p_current text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid; r jsonb;
begin
  if current_viewer() is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  v := coalesce(account_of_viewer(), account_ensure());
  if not exists (select 1 from pulse_priv.account_member where account_id = v and member_org = p_org) then
    raise exception 'You are not a member of that organisation' using errcode = '42501'; end if;
  if p_org is distinct from current_org() and not acct_may_cross(v, viewer_personal(), p_org) then
    raise exception '%', acct_personal_needed() using errcode = '42501', hint = 'personal_sign_in';
  end if;
  r := acct_move(v, p_current, current_org(), p_org);
  if r is null then raise exception 'Your place in that organisation is not active' using errcode = '42501'; end if;
  return r;
end $$;

-- 0920's switch for an identity without a session (Access): company-level, so the same rule.
alter function pulse.account_switch(uuid, text, text) rename to acct_switch_core;
revoke all on function pulse.acct_switch_core(uuid, text, text) from public, pulse_api;
create function pulse.account_switch(p_org uuid, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer();
begin
  if v is not null and p_org is distinct from current_org() and not acct_may_cross(v, viewer_personal(), p_org) then
    raise exception '%', acct_personal_needed() using errcode = '42501', hint = 'personal_sign_in';
  end if;
  return acct_switch_core(p_org, p_hash, p_device);
end $$;
revoke all on function pulse.account_switch(uuid, text, text) from public;
grant execute on function pulse.account_switch(uuid, text, text) to pulse_api;

-- The account password and handle: only a personal session changes them once the account has a personal sign-in.
alter function pulse.account_claim(text, text) rename to acct_claim_core;
revoke all on function pulse.acct_claim_core(text, text) from public, pulse_api;
create function pulse.account_claim(p_handle text, p_password text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare v uuid := account_of_viewer(); cur text;
begin
  select handle into cur from pulse_priv.pulse_account where id = v;
  if (coalesce(p_password, '') <> '' or (coalesce(btrim(p_handle), '') <> '' and lower(ltrim(btrim(p_handle), '@')) is distinct from cur))
     and not acct_change_allowed(v) then
    raise exception 'Sign in as yourself to change your sign-in: with your own e-mail or your Pulse password.' using errcode = '42501', hint = 'personal_sign_in';
  end if;
  if v is null or not acct_has_personal(v) then
    declare r jsonb; begin r := acct_claim_core(p_handle, p_password); perform acct_upgrade_viewer_session(false); return r; end;
  end if;
  return acct_claim_core(p_handle, p_password);
end $$;
revoke all on function pulse.account_claim(text, text) from public;
grant execute on function pulse.account_claim(text, text) to pulse_api;

alter function pulse.account_password_unify(text, text) rename to acct_password_unify_core;
revoke all on function pulse.acct_password_unify_core(text, text) from public, pulse_api;
create function pulse.account_password_unify(p_current text, p_next text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
begin
  if not acct_change_allowed(account_of_viewer()) then
    raise exception 'Sign in as yourself to change your sign-in: with your own e-mail or your Pulse password.' using errcode = '42501', hint = 'personal_sign_in';
  end if;
  if not acct_has_personal(account_of_viewer()) then
    declare r jsonb; begin r := acct_password_unify_core(p_current, p_next); perform acct_upgrade_viewer_session(false); return r; end;
  end if;
  return acct_password_unify_core(p_current, p_next);
end $$;
revoke all on function pulse.account_password_unify(text, text) from public;
grant execute on function pulse.account_password_unify(text, text) to pulse_api;

-- ------------------------------------------------------------------------------------------------ 4. the e-mailed code
-- 1585's target: the account's handle or old handle, one of its sign-in e-mails, or a member's username. A seat's profile
-- e-mail no longer names the account (it is the company's record). Null: nobody, several, or this company's own staff.
create or replace function pulse.acct_code_target(p_login text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare l text := lower(btrim(coalesce(p_login, ''))); cand uuid[] := '{}'; x uuid[]; o record; e uuid;
begin
  if l = '' or length(l) > 254 or mailbox_shared(l) then return null; end if;
  if auth_signin_code_actor('staff', l) is not null then return null; end if;
  if position('@' in l) > 1 then return acct_by_signin_email(l); end if;
  select coalesce(array_agg(pa.id), '{}') into cand from pulse_priv.pulse_account pa where pa.handle = ltrim(l, '@');
  cand := cand || coalesce((select array_agg(h.ref) from pulse_priv.handle_name h join pulse_priv.pulse_account pa on pa.id = h.ref
                             where h.handle = ltrim(l, '@') and h.kind = 'person'), '{}');
  for o in select org.id from org where org.status = 'active' loop
    perform acct_enter(o.id, null);
    select coalesce(array_agg(distinct am.account_id), '{}') into x from people_profile pp
      join pulse_priv.account_member am on am.person_id = pp.person_id and am.member_org = o.id
     where pp.org_id = o.id and pp.username = l;
    perform acct_leave();
    cand := cand || x;
  end loop;
  select coalesce(array_agg(distinct u), '{}') into cand from unnest(cand) u;
  return case when cardinality(cand) = 1 then cand[1] end;
end $$;

-- 1585's delivery: the sign-in e-mail typed, else the account's own e-mail (never a shared mailbox). An account with a
-- personal e-mail gets codes only at a personal e-mail: the one typed, or (for a username) its main personal one. (Without
-- one, a code to a company's mailbox opens only that company: account_code_finish.)
create or replace function pulse.acct_code_delivery(p_account uuid, p_login text) returns text
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare l text := lower(btrim(coalesce(p_login, ''))); acc pulse_priv.pulse_account%rowtype; e text; m record; credentialed boolean := false; work_match boolean := false; c boolean; w text;
  typed_mail boolean := position('@' in l) > 1;
begin
  if mailbox_shared(l) then return null; end if;
  if acct_has_personal_email(p_account) then
    return (select x.email from acct_signin_emails(p_account) x where x.personal and (not typed_mail or x.email = l)
             order by x.is_primary desc, x.email limit 1);
  end if;
  if exists (select 1 from pulse_priv.account_login_email where email = l and account_id = p_account) then return l; end if;
  select * into acc from pulse_priv.pulse_account where id = p_account;
  e := lower(btrim(coalesce(acc.email, '')));
  if e = '' or mailbox_shared(e) then return null; end if;
  if coalesce(acc.email_verified_at, acc.email_confirmed_at) is not null then return e; end if;
  for m in select member_org, person_id from pulse_priv.account_member where account_id = p_account loop
    perform acct_enter(m.member_org, null);
    select exists (select 1 from login_credential lc where lc.org_id = m.member_org and lc.person_id = m.person_id and lc.status = 'active') into c;
    w := case when c then lower(btrim(coalesce(auth_delivery('staff', m.person_id), ''))) end;
    perform acct_leave();
    if c then credentialed := true; if w = e then work_match := true; end if; end if;
  end loop;
  return case when not credentialed or work_match then e end;
end $$;

-- 1585's finish. A code that went to a personal e-mail opens a personal session (anywhere the account is). One that went
-- to a company's mailbox proves that company's seat only: never a personal space, and, once the account has a sign-in
-- of its own, only the company whose record has that address. Otherwise 1585's body.
create or replace function pulse.account_code_finish(p_login text, p_code text, p_hash text, p_device text, p_own uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare a uuid := acct_code_target(p_login); s pulse_priv.account_signin_code%rowtype; acc pulse_priv.pulse_account%rowtype; target uuid; r jsonb; own_mail boolean;
  mine boolean; prot boolean; went text; w text;
begin
  if a is null then perform acct_event(null, 'account_code_failed', p_device); return null; end if;
  select * into s from pulse_priv.account_signin_code where account_id = a for update;
  if not found or s.code_hash is null or s.expires_at < now() or s.tries >= 5 then perform acct_event(a, 'account_code_failed', p_device); return null; end if;
  if encode(digest(regexp_replace(coalesce(p_code, ''), '\D', '', 'g') || ':' || a, 'sha256'), 'hex') <> s.code_hash then
    update pulse_priv.account_signin_code set tries = tries + 1, code_hash = case when tries + 1 >= 5 then null else code_hash end where account_id = a;
    perform acct_event(a, 'account_code_failed', p_device); return null;
  end if;
  update pulse_priv.account_signin_code set code_hash = null, expires_at = null, tries = 0 where account_id = a;
  if not acct_code_ok(a) or (s.sent_to is not null and acct_code_delivery(a, s.sent_to) is distinct from s.sent_to) then
    perform acct_event(a, 'account_code_failed', p_device); return null;
  end if;
  select * into acc from pulse_priv.pulse_account where id = a;
  own_mail := s.sent_to is null or s.sent_to = lower(btrim(coalesce(acc.email, '')));
  update pulse_priv.pulse_account set failed = 0, locked_until = null,
         email_confirmed_at = case when own_mail then coalesce(email_confirmed_at, now()) else email_confirmed_at end,
         email_verified_at = case when own_mail then coalesce(email_verified_at, now()) else email_verified_at end, updated_at = now() where id = a;
  perform acct_event(a, 'account_code_used', p_device);
  if acct_two_step(a) then return jsonb_build_object('failed', true, 'twoStep', true); end if;
  select * into acc from pulse_priv.pulse_account where id = a;
  went := lower(btrim(coalesce(s.sent_to, acc.email, '')));
  mine := acct_email_personal(a, went);
  prot := acct_has_personal(a);
  for target in select am.member_org from pulse_priv.account_member am join org on org.id = am.member_org and org.status = 'active'
      where am.account_id = a order by coalesce(am.member_org = p_own, false) desc, (am.member_org = acc.last_org) desc, am.last_used_at desc nulls last loop
    if not mine then
      if org_is_personal(target) then continue; end if;
      if prot then
        perform acct_enter(target, null);
        select lower(btrim(coalesce(auth_delivery('staff', am.person_id), ''))) into w from pulse_priv.account_member am where am.account_id = a and am.member_org = target;
        perform acct_leave();
        if w is distinct from went then continue; end if;
      end if;
    end if;
    r := acct_session(a, target, p_hash, p_device);
    if r is not null then
      if mine then perform acct_mark_personal(target, p_hash); end if;
      perform acct_enter(target, (r ->> 'person')::uuid);
      perform audit_write('account_code_sign_in', 'person', r ->> 'person');
      perform acct_leave();
      return r;
    end if;
  end loop;
  return jsonb_build_object('failed', true, 'noOrg', true);
end $$;

create or replace function pulse.account_code_finish(p_login text, p_code text, p_hash text, p_device text, p_own uuid, p_challenge text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare r jsonb; a uuid; sent text;
begin
  a := acct_code_target(p_login);
  if a is not null then select sent_to into sent from pulse_priv.account_signin_code where account_id = a; end if;
  r := account_code_finish(p_login, p_code, p_hash, p_device, p_own);
  if r is not null and coalesce((r ->> 'twoStep')::boolean, false) then
    if a is not null and acct_challenge_begin(a, p_challenge, p_device, p_own) then
      update pulse_priv.account_challenge set personal = acct_email_personal(a, sent) where hash = p_challenge;
      return jsonb_build_object('twoStep', true, 'challenge', true);
    end if;
  end if;
  return r;
end $$;

alter function pulse.account_two_step_finish(text, text, text, text) rename to acct_two_step_finish_core;
revoke all on function pulse.acct_two_step_finish_core(text, text, text, text) from public, pulse_api;
create function pulse.account_two_step_finish(p_challenge text, p_code text, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare per boolean; r jsonb;
begin
  select personal into per from pulse_priv.account_challenge where hash = p_challenge;
  r := acct_two_step_finish_core(p_challenge, p_code, p_hash, p_device);
  if r is not null and r ? 'org' and coalesce(per, false) then perform acct_mark_personal((r ->> 'org')::uuid, p_hash); end if;
  return r;
end $$;
revoke all on function pulse.account_code_finish(text, text, text, text, uuid), pulse.account_code_finish(text, text, text, text, uuid, text),
  pulse.account_two_step_finish(text, text, text, text) from public;
grant execute on function pulse.account_code_finish(text, text, text, text, uuid), pulse.account_code_finish(text, text, text, text, uuid, text),
  pulse.account_two_step_finish(text, text, text, text) to pulse_api;

-- ------------------------------------------------------------------------------------------------ 5. the password
-- 1841's account_sign_in. Changes: the account's sign-in e-mails (own and linked, never a shared mailbox) and members'
-- usernames name it, not a seat's profile e-mail; the account's own password opens a personal session; a company password
-- opens that company only once the account has a personal sign-in. Otherwise 1841's body.
create or replace function pulse.account_sign_in(p_login text, p_password text, p_hash text, p_device text, p_challenge text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pulse', 'public', 'pg_temp'
as $function$
declare own uuid := (select d.org_id from org_domain d where d.org_id = nullif(current_setting('pulse.org_id', true), '')::uuid limit 1);
  l text := lower(btrim(coalesce(p_login, ''))); cand uuid[] := '{}'; x uuid[]; o record; a pulse_priv.pulse_account%rowtype;
  cid uuid; hit uuid; hits int := 0; locked boolean := false; matched jsonb; hit_match jsonb; m record; target uuid; r jsonb; members int;
  lone_org uuid[] := '{}'; lone_person uuid[] := '{}'; y uuid[]; pid uuid; i int; new_org uuid; new_person uuid;
  nu_username text; nu_email text; nu_name text; h text; nu_match jsonb; mine boolean; e uuid;
begin
  if l = '' or coalesce(p_password, '') = '' or octet_length(p_password) > 72 or mailbox_shared(l) then perform crypt('x', gen_salt('bf', 10)); return null; end if;
  select coalesce(array_agg(pa.id), '{}') into cand from pulse_priv.pulse_account pa where pa.handle = ltrim(l, '@');
  if position('@' in l) > 1 then e := acct_by_signin_email(l); if e is not null then cand := cand || e; end if; end if;
  -- A member's username in any organisation (WL-MOVE: and the account-less staff a company password is for), each read
  -- under its own organisation's row security.
  for o in select org.id from org where org.status = 'active' loop
    perform acct_enter(o.id, null);
    select coalesce(array_agg(distinct am.account_id), '{}') into x from people_profile pp
      join pulse_priv.account_member am on am.person_id = pp.person_id and am.member_org = o.id
     where pp.org_id = o.id and pp.username = l;
    select coalesce(array_agg(distinct pp.person_id), '{}') into y from people_profile pp
      join person p on p.id = pp.person_id and p.org_id = o.id and p.status = 'active' and p.side = 'staff'
     where pp.org_id = o.id and (pp.username = l or lower(btrim(pp.email)) = l)
       and exists (select 1 from login_credential lc where lc.org_id = o.id and lc.person_id = pp.person_id and lc.status = 'active')
       and not exists (select 1 from pulse_priv.account_member am where am.person_id = pp.person_id and am.member_org = o.id);
    perform acct_leave();
    cand := cand || x;
    foreach pid in array y loop lone_org := lone_org || o.id; lone_person := lone_person || pid; end loop;
  end loop;
  select coalesce(array_agg(distinct u), '{}') into cand from unnest(cand) u;
  if cardinality(cand) = 0 and cardinality(lone_person) = 0 then perform crypt('x', gen_salt('bf', 10)); return null; end if;
  foreach cid in array cand loop
    select * into a from pulse_priv.pulse_account where pulse_account.id = cid;
    if a.locked_until > now() then locked := true; continue; end if;
    matched := null;
    if a.password_hash is not null then
      if a.password_hash = crypt(p_password, a.password_hash) then matched := jsonb_build_object('account', true); end if;
    else
      for m in select am.member_org, am.person_id from pulse_priv.account_member am join org on org.id = am.member_org and org.status = 'active'
          where am.account_id = a.id order by coalesce(am.member_org = own, false) desc, (am.member_org = a.last_org) desc, am.last_used_at desc nulls last loop
        matched := acct_cred_match(m.member_org, m.person_id, p_password);
        exit when matched is not null;
      end loop;
    end if;
    if matched is not null then hits := hits + 1; hit := a.id; hit_match := matched; end if;
  end loop;
  for i in 1 .. cardinality(lone_person) loop
    matched := acct_cred_match(lone_org[i], lone_person[i], p_password);
    if matched is not null then hits := hits + 1; hit := null; hit_match := matched; new_org := lone_org[i]; new_person := lone_person[i]; end if;
  end loop;
  if hits = 0 then
    if cardinality(cand) = 1 then
      update pulse_priv.pulse_account set failed = case when failed >= 4 then 0 else failed + 1 end,
        locked_until = case when failed >= 4 then now() + interval '15 minutes' end where pulse_account.id = cand[1] and password_hash is not null;
    end if;
    return jsonb_build_object('failed', true, 'locked', locked and cardinality(cand) = 1);
  end if;
  if hits > 1 then return jsonb_build_object('failed', true, 'ambiguous', true); end if;
  if hit is null then
    perform acct_enter(new_org, null);
    hit := acct_seat_attach(new_person);
    if hit is null then
      nu_match := acct_seat_match(new_org, new_person);
      if nu_match is not null then perform acct_seat_offer(new_person, null); end if;
    end if;
    select lower(nullif(btrim(pp.username), '')), lower(nullif(btrim(pp.email), '')), per.display_name into nu_username, nu_email, nu_name
      from person per left join people_profile pp on pp.person_id = per.id and pp.org_id = per.org_id
     where per.id = new_person and per.org_id = new_org;
    perform acct_leave();
    if hit is null and nu_match is not null then return jsonb_build_object('failed', true, 'linkPending', true); end if;
  end if;
  if hit is null then
    h := handle_suggest(coalesce(nullif(split_part(coalesce(nu_username, ''), '.', 1) || split_part(coalesce(nu_username, ''), '.', 2), ''), nu_name));
    insert into pulse_priv.pulse_account(handle, display_name, email, last_org)
    values (h, nu_name, case when nu_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      and not exists (select 1 from pulse_priv.pulse_account x2 where lower(x2.email) = nu_email) then nu_email end, new_org) returning id into hit;
    insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', hit);
    insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (hit, new_org, new_person, 'staff');
    perform acct_enter(new_org, null);
    perform audit_write('account_link', 'person', new_person::text, array['first_sign_in']);
    perform acct_leave();
  end if;
  -- ACCOUNT-META: the account's own password proves the person; a company password proves that company's seat.
  mine := coalesce((hit_match ->> 'account')::boolean, false);
  if acct_two_step(hit) then
    if acct_challenge_begin(hit, p_challenge, p_device, own) then
      update pulse_priv.account_challenge set personal = mine where hash = p_challenge;
      return jsonb_build_object('twoStep', true, 'challenge', true);
    end if;
    return jsonb_build_object('failed', true, 'twoStep', true);
  end if;
  update pulse_priv.pulse_account set failed = 0, locked_until = null where pulse_account.id = hit;
  select * into a from pulse_priv.pulse_account where pulse_account.id = hit;
  select count(*) into members from pulse_priv.account_member where account_id = hit;
  if coalesce((hit_match ->> 'mustChange')::boolean, false) then
    r := acct_session(hit, (hit_match ->> 'org')::uuid, p_hash, p_device);
    return case when r is null then jsonb_build_object('failed', true, 'noOrg', true) else r || jsonb_build_object('mustChange', true) end;
  end if;
  -- ACCOUNT-META: a company's password opens that company only, once the account has a sign-in of its own.
  if not mine and acct_has_personal(hit) then
    r := acct_session(hit, (hit_match ->> 'org')::uuid, p_hash, p_device);
    return case when r is null then jsonb_build_object('failed', true, 'noOrg', true) else r || jsonb_build_object('companyOnly', true) end;
  end if;
  for target in select am.member_org from pulse_priv.account_member am join org on org.id = am.member_org and org.status = 'active'
      where am.account_id = hit order by coalesce(am.member_org = own, false) desc, (am.member_org = a.last_org) desc, am.last_used_at desc nulls last loop
    perform acct_enter(target, null);
    if exists (select 1 from login_credential lc join pulse_priv.account_member am on am.person_id = lc.person_id
                where am.account_id = hit and am.member_org = target and lc.org_id = target and lc.status = 'active' and lc.must_change)
       and target is distinct from (hit_match ->> 'org')::uuid then
      perform acct_leave(); continue;
    end if;
    perform acct_leave();
    -- A company-only sign-in never lands in a personal space.
    if not mine and org_is_personal(target) then continue; end if;
    r := acct_session(hit, target, p_hash, p_device);
    if r is not null then
      if mine then perform acct_mark_personal(target, p_hash); end if;
      return r || jsonb_build_object('unify', a.password_hash is null and members > 1);
    end if;
  end loop;
  return jsonb_build_object('failed', true, 'noOrg', true);
end $function$;

-- ------------------------------------------------------------------------------------------------ 6. Google, Microsoft, Apple
-- A shared mailbox never signs anyone in with a provider either (a company's Google admin@ account included).
alter function pulse.google_sign_in_any(jsonb, text, text, text) rename to acct_google_any_core;
revoke all on function pulse.acct_google_any_core(jsonb, text, text, text) from public, pulse_api;
create function pulse.google_sign_in_any(proof jsonb, challenge_hash text, session_hash text, d text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  -- Google switched off here, or a proof it would refuse: the core's own answer comes first (provider_error).
  if mailbox_shared(proof ->> 'email') and exists (select 1 from pulse_priv.google_settings where org_id = current_org() and enabled)
     and proof ->> 'iss' = 'https://accounts.google.com' and coalesce((proof ->> 'email_verified')::boolean, false) then
    perform auth_event_add('staff', null, 'shared_mailbox_refused', d); return jsonb_build_object('error', 'not_linked');
  end if;
  if mailbox_shared(proof ->> 'email') then return jsonb_build_object('error', 'provider_error'); end if;
  return acct_google_any_core(proof, challenge_hash, session_hash, d);
end $$;
revoke all on function pulse.google_sign_in_any(jsonb, text, text, text) from public;
grant execute on function pulse.google_sign_in_any(jsonb, text, text, text) to pulse_api;

alter function pulse.oidc_sign_in_any(text, jsonb, text, text, text) rename to acct_oidc_any_core;
revoke all on function pulse.acct_oidc_any_core(text, jsonb, text, text, text) from public, pulse_api;
create function pulse.oidc_sign_in_any(provider text, proof jsonb, challenge_hash text, session_hash text, d text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare issuer text := case provider when 'apple' then 'https://appleid.apple.com' when 'microsoft' then 'https://login.microsoftonline.com/' end;
begin
  if mailbox_shared(proof ->> 'email') then
    -- A proof the core would refuse keeps the core's answer (provider_error); a good one with a shared mailbox: nobody.
    if issuer is null or coalesce(proof ->> 'iss', '') not like issuer || '%' or coalesce((proof ->> 'email_verified')::boolean, false) is not true then
      return jsonb_build_object('error', 'provider_error');
    end if;
    perform auth_event_add('staff', null, 'shared_mailbox_refused', d); return jsonb_build_object('error', 'not_linked');
  end if;
  return acct_oidc_any_core(provider, proof, challenge_hash, session_hash, d);
end $$;
revoke all on function pulse.oidc_sign_in_any(text, jsonb, text, text, text) from public;
grant execute on function pulse.oidc_sign_in_any(text, jsonb, text, text, text) to pulse_api;

-- The e-mailed reset / sign-in link (1066) goes to the account's own e-mail only when that e-mail may sign it in, and
-- changing that e-mail (1066) is a change of the account's sign-in.
alter function pulse.acct_link_issue(text, text, text) rename to acct_link_issue_core;
revoke all on function pulse.acct_link_issue_core(text, text, text) from public, pulse_api;
create function pulse.acct_link_issue(p_login text, p_kind text, p_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare l text := lower(btrim(coalesce(p_login, ''))); a uuid; e text;
begin
  if mailbox_shared(l) then return null; end if;
  select id, lower(btrim(email)) into a, e from pulse_priv.pulse_account where handle = ltrim(l, '@') or email = l limit 1;
  if a is not null and acct_has_personal(a) and not acct_email_personal(a, e) then perform acct_event(a, 'account_link_refused'); return null; end if;
  return acct_link_issue_core(p_login, p_kind, p_hash);
end $$;
revoke all on function pulse.acct_link_issue(text, text, text) from public;
grant execute on function pulse.acct_link_issue(text, text, text) to pulse_api;

alter function pulse.acct_email_change(text, text) rename to acct_email_change_core;
revoke all on function pulse.acct_email_change_core(text, text) from public, pulse_api;
create function pulse.acct_email_change(p_email text, p_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform acct_require_change(account_of_viewer());
  if mailbox_shared(p_email) then raise exception 'That looks like a shared mailbox (admin@, info@, billing@ ...). Only an e-mail that you alone read can sign you in.' using errcode = '22023'; end if;
  return acct_email_change_core(p_email, p_hash);
end $$;
revoke all on function pulse.acct_email_change(text, text) from public;
grant execute on function pulse.acct_email_change(text, text) to pulse_api;

-- ------------------------------------------------------------------------------------------------ 7. Account access
-- Adding a sign-in e-mail: a code to it (10 minutes, five tries, one a minute, five an hour per account).
create table pulse_priv.account_email_claim (
  account_id  uuid primary key references pulse_priv.pulse_account(id) on delete cascade,
  email       text not null check (length(email) <= 254),
  code_hash   text,
  expires_at  timestamptz,
  tries       int not null default 0,
  last_sent   timestamptz,
  hour_start  timestamptz,
  hour_sent   int not null default 0
);
revoke all on pulse_priv.account_email_claim from public;

create function pulse.acct_mask_email(p_email text) returns text
  language sql immutable as $$
  select case when position('@' in coalesce(p_email, '')) > 1
    then left(split_part(p_email, '@', 1), 1) || '••••@' || split_part(p_email, '@', 2) end
$$;

-- What the signed-in person's account signs in with, its sessions in every company, and the rule (Settings).
create function pulse.account_access() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); acc pulse_priv.pulse_account%rowtype; m record; here uuid := current_org(); me uuid := current_viewer();
  sess jsonb := '[]'; mine text := nullif(current_setting('pulse.viewer_session', true), ''); x jsonb;
begin
  if me is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  if v is null then v := account_ensure(); end if;
  select * into acc from pulse_priv.pulse_account where id = v;
  for m in select am.member_org, am.person_id, o.name from pulse_priv.account_member am join org o on o.id = am.member_org where am.account_id = v loop
    perform acct_enter(m.member_org, null);
    select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'company', m.name, 'device', s.device, 'since', s.created_at, 'until', s.expires_at,
             'via', s.via, 'personal', s.personal, 'current', s.token_hash = mine and m.member_org = here) order by s.created_at desc), '[]')
      into x from login_session s where s.org_id = m.member_org and s.person_id = m.person_id and s.revoked_at is null and s.expires_at > now();
    perform acct_leave();
    sess := sess || x;
  end loop;
  return jsonb_build_object(
    'handle', acc.handle,
    'password', acc.password_hash is not null,
    'protected', acct_has_personal(v),
    'personalSession', viewer_personal(),
    'emails', coalesce((select jsonb_agg(jsonb_build_object('email', e.email, 'personal', e.personal, 'primary', e.is_primary, 'verified', e.verified,
                 'kind', e.kind) order by e.is_primary desc, e.email) from acct_signin_emails(v) e), '[]'),
    'removed', coalesce((select jsonb_agg(jsonb_build_object('email', r.email, 'reason', r.reason, 'at', r.removed_at) order by r.removed_at desc)
                 from pulse_priv.account_login_email_removed r where r.account_id = v and r.reason = 'shared_mailbox'), '[]'),
    'sessions', sess);
end $$;


-- Step 1: a code to the new e-mail. Answers {code, delivery} for the API to send, or null when rationed.
create function pulse.account_email_start(p_email text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare v uuid := account_of_viewer(); e text := lower(btrim(coalesce(p_email, ''))); s pulse_priv.account_email_claim%rowtype; code text;
begin
  if current_viewer() is null or v is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  perform acct_require_change(v);
  if e !~ '^[^[:space:]@A-Z]+@[^[:space:]@A-Z]+\.[^[:space:]@A-Z]+$' or length(e) > 254 then raise exception 'Type a whole e-mail address, like name@example.com.' using errcode = '22023'; end if;
  if mailbox_shared(e) then raise exception 'That looks like a shared mailbox (admin@, info@, billing@ ...). Only an e-mail that you alone read can sign you in.' using errcode = '22023'; end if;
  if exists (select 1 from acct_signin_emails(v) x where x.email = e) then raise exception 'That e-mail already signs you in.' using errcode = '23505'; end if;
  insert into pulse_priv.account_email_claim(account_id, email) values (v, e) on conflict (account_id) do nothing;
  select * into s from pulse_priv.account_email_claim where account_id = v for update;
  if s.last_sent > now() - interval '1 minute' or (s.hour_start > now() - interval '1 hour' and s.hour_sent >= 5) then
    raise exception 'A code was sent a moment ago. Wait a minute, then ask again.' using errcode = '54000';
  end if;
  code := acct_code_make();
  update pulse_priv.account_email_claim set email = e, code_hash = encode(digest(code || ':' || v || ':' || e, 'sha256'), 'hex'),
         expires_at = now() + interval '10 minutes', tries = 0, last_sent = now(),
         hour_sent = case when hour_start > now() - interval '1 hour' then hour_sent + 1 else 1 end,
         hour_start = case when hour_start > now() - interval '1 hour' then hour_start else now() end
   where account_id = v;
  perform acct_event(v, 'login_email_code_sent');
  return jsonb_build_object('code', code, 'delivery', e, 'handle', (select handle from pulse_priv.pulse_account where id = v), 'masked', acct_mask_email(e));
end $$;

-- Step 2: the code, and "only I read this mailbox". Then it signs this account in, as a personal e-mail.
create function pulse.account_email_finish(p_email text, p_code text, p_own boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare v uuid := account_of_viewer(); e text := lower(btrim(coalesce(p_email, ''))); s pulse_priv.account_email_claim%rowtype; before boolean;
begin
  if current_viewer() is null or v is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  perform acct_require_change(v);
  before := acct_has_personal(v);
  if p_own is not true then raise exception 'Tick "Only I can read this mailbox". A mailbox others can read must not sign you in.' using errcode = '22023'; end if;
  select * into s from pulse_priv.account_email_claim where account_id = v for update;
  if not found or s.email <> e or s.code_hash is null or s.expires_at < now() or s.tries >= 5 then
    raise exception 'That code isn''t right or has expired. Ask for a new one.' using errcode = '22023'; end if;
  if encode(digest(regexp_replace(coalesce(p_code, ''), '\D', '', 'g') || ':' || v || ':' || e, 'sha256'), 'hex') <> s.code_hash then
    update pulse_priv.account_email_claim set tries = tries + 1, code_hash = case when tries + 1 >= 5 then null else code_hash end where account_id = v;
    perform acct_event(v, 'login_email_code_failed');
    raise exception 'That code isn''t right or has expired. Ask for a new one.' using errcode = '22023';
  end if;
  update pulse_priv.account_email_claim set code_hash = null, expires_at = null, tries = 0 where account_id = v;
  -- The mailbox is proved: say plainly when it already signs in to another account (the person reads it, so nothing leaks).
  if exists (select 1 from pulse_priv.pulse_account where lower(btrim(email)) = e and id <> v)
     or exists (select 1 from pulse_priv.account_login_email where email = e and account_id <> v) then
    raise exception 'That e-mail already signs in to another Pulse account. Sign in with it and remove it there first.' using errcode = '23505';
  end if;
  if exists (select 1 from pulse_priv.pulse_account where id = v and lower(btrim(email)) = e) then
    update pulse_priv.pulse_account set email_own_confirmed_at = now(), email_verified_at = coalesce(email_verified_at, now()), updated_at = now() where id = v;
  else
    insert into pulse_priv.account_login_email(email, account_id, verified_at, source, kind, own_confirmed_at)
    values (e, v, now(), 'self', case when mailbox_consumer(e) then 'personal' else 'work' end, now());
  end if;
  perform acct_event(v, 'login_email_added');
  perform acct_upgrade_viewer_session(before);
  return account_access();
end $$;

-- Remove a sign-in e-mail (never the last personal sign-in: then nobody could prove it is you).
create function pulse.account_email_remove(p_email text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare v uuid := account_of_viewer(); e text := lower(btrim(coalesce(p_email, ''))); was_personal boolean; is_own boolean;
begin
  if current_viewer() is null or v is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  perform acct_require_change(v);
  if not exists (select 1 from acct_signin_emails(v) x where x.email = e) then raise exception 'That e-mail does not sign you in.' using errcode = '22023'; end if;
  was_personal := acct_has_personal(v);
  is_own := exists (select 1 from pulse_priv.pulse_account where id = v and lower(btrim(email)) = e);
  if is_own then
    insert into pulse_priv.account_login_email_removed(account_id, email, was, reason) values (v, e, 'account', 'removed_by_person');
    update pulse_priv.pulse_account set email = null, email_verified_at = null, email_confirmed_at = null, email_own_confirmed_at = null, updated_at = now() where id = v;
  else
    insert into pulse_priv.account_login_email_removed(account_id, email, was, reason)
      select v, email, source, 'removed_by_person' from pulse_priv.account_login_email where email = e and account_id = v;
    delete from pulse_priv.account_login_email where email = e and account_id = v;
  end if;
  if was_personal and not acct_has_personal(v) then
    raise exception 'Keep one e-mail that only you read, or set a Pulse password first. Otherwise nobody could prove it is you.' using errcode = '22023';
  end if;
  perform acct_event(v, 'login_email_removed');
  return account_access();
end $$;

-- Make a linked sign-in e-mail the account's main one (codes for a username go there); the old one stays a sign-in e-mail.
create function pulse.account_email_primary(p_email text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare v uuid := account_of_viewer(); e text := lower(btrim(coalesce(p_email, ''))); le pulse_priv.account_login_email%rowtype; acc pulse_priv.pulse_account%rowtype;
begin
  if current_viewer() is null or v is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  perform acct_require_change(v);
  select * into le from pulse_priv.account_login_email where email = e and account_id = v;
  if not found then raise exception 'Add that e-mail first, then make it your main one.' using errcode = '22023'; end if;
  select * into acc from pulse_priv.pulse_account where id = v;
  delete from pulse_priv.account_login_email where email = e and account_id = v;
  if acc.email is not null and not mailbox_shared(acc.email) then
    insert into pulse_priv.account_login_email(email, account_id, verified_at, source, kind, own_confirmed_at)
    values (lower(btrim(acc.email)), v, coalesce(acc.email_verified_at, acc.email_confirmed_at, now()), 'self',
            case when mailbox_consumer(acc.email) or acc.email_own_confirmed_at is not null then 'personal' else 'work' end, acc.email_own_confirmed_at)
    on conflict (email) do nothing;
  end if;
  update pulse_priv.pulse_account set email = e, email_verified_at = le.verified_at, email_confirmed_at = coalesce(email_confirmed_at, le.verified_at),
         email_own_confirmed_at = le.own_confirmed_at, updated_at = now() where id = v;
  perform acct_event(v, 'login_email_primary');
  return account_access();
end $$;

-- Monitoring (owner: "codes arrive within seconds ... add monitoring"): the API records whether each code e-mail went out.
create function pulse.account_mail_result(p_account uuid, p_kind text, p_ok boolean) returns void
  language sql security definer set search_path = pulse, pg_temp as $$
  insert into pulse_priv.account_auth_event(account_id, action)
  select p_account, left(p_kind, 20) || case when p_ok then '_mail_ok' else '_mail_failed' end
   where p_kind in ('account_code', 'login_email', 'staff_code')
$$;

-- Counts for the platform's checks (no addresses): code e-mails sent and failed in the last hour and day.
create function pulse.account_mail_health() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object(
    'hour', jsonb_build_object('ok', count(*) filter (where action like '%\_mail\_ok' and at > now() - interval '1 hour'),
                               'failed', count(*) filter (where action like '%\_mail\_failed' and at > now() - interval '1 hour')),
    'day', jsonb_build_object('ok', count(*) filter (where action like '%\_mail\_ok'), 'failed', count(*) filter (where action like '%\_mail\_failed')))
  from pulse_priv.account_auth_event where at > now() - interval '1 day' and action like '%\_mail\_%'
$$;

-- The owner's report (root runs it on production after the release): every address taken off an account, by handle.
create function pulse.account_meta_report() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('removed', coalesce(jsonb_agg(jsonb_build_object('handle', pa.handle, 'email', r.email, 'was', r.was, 'reason', r.reason,
           'at', r.removed_at) order by pa.handle, r.email), '[]'))
    from pulse_priv.account_login_email_removed r left join pulse_priv.pulse_account pa on pa.id = r.account_id
$$;

-- ------------------------------------------------------------------------------------------------ 8. one photo, every company
-- Owner: his profile photo showed in one company and not in another. PROFILE-UNIFY (1683) carries
-- a photo the person sets to every seat from then on, but its backfill never ran where the photo came first. Now, once:
-- an account without a photo of its own takes the newest photo the person put on one of their seats themselves (a photo
-- HR or an admin set stays that company's own, as 1683 says), and every seat without a photo gets the account's.
create function pulse.account_photo_backfill() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o text := coalesce(current_setting('pulse.org_id', true), ''); sy text := coalesce(current_setting('pulse.profile_sync', true), '');
  a uuid; m record; ph record; b_mime text; b_bytes bytea; b_at timestamptz; b_org uuid; n_acc int := 0; n_seat int := 0; k int;
begin
  perform set_config('pulse.profile_sync', '1', true);
  for a in select pa.id from pulse_priv.pulse_account pa
            where not exists (select 1 from pulse_priv.account_profile ap where ap.account_id = pa.id and ap.photo_bytes is not null) loop
    b_bytes := null; b_at := null;
    for m in select am.member_org, am.person_id from pulse_priv.account_member am join pulse.org g on g.id = am.member_org and g.status = 'active'
              where am.account_id = a and am.kind <> 'agent' loop
      perform set_config('pulse.org_id', m.member_org::text, true);
      select x.mime, x.bytes, x.updated_at into ph from pulse.person_photo x where x.person_id = m.person_id and x.updated_by = m.person_id;
      if found and ph.bytes is not null and (b_at is null or ph.updated_at > b_at) then b_mime := ph.mime; b_bytes := ph.bytes; b_at := ph.updated_at; b_org := m.member_org; end if;
    end loop;
    if b_bytes is not null and octet_length(b_bytes) <= 400000 then
      insert into pulse_priv.account_profile(account_id, photo_mime, photo_bytes, photo_at, photo_from) values (a, b_mime, b_bytes, b_at, b_org)
      on conflict (account_id) do update set photo_mime = excluded.photo_mime, photo_bytes = excluded.photo_bytes, photo_at = excluded.photo_at, photo_from = excluded.photo_from;
      n_acc := n_acc + 1;
    end if;
  end loop;
  for m in select am.member_org, am.person_id, ap.photo_mime, ap.photo_bytes from pulse_priv.account_member am
            join pulse_priv.account_profile ap on ap.account_id = am.account_id and ap.photo_bytes is not null
            join pulse.org g on g.id = am.member_org and g.status = 'active' where am.kind <> 'agent' loop
    perform set_config('pulse.org_id', m.member_org::text, true);
    insert into pulse.person_photo(org_id, person_id, mime, bytes, updated_by) values (m.member_org, m.person_id, m.photo_mime, m.photo_bytes, m.person_id)
    on conflict (person_id) do nothing;
    get diagnostics k = row_count; n_seat := n_seat + k;
  end loop;
  perform set_config('pulse.profile_sync', sy, true);
  perform set_config('pulse.org_id', o, true);
  return jsonb_build_object('accounts', n_acc, 'seats', n_seat);
end $$;
revoke all on function pulse.account_photo_backfill() from public;
do $$ declare r jsonb := pulse.account_photo_backfill(); begin raise notice 'ACCOUNT-META photos: %', r; end $$;

-- Owner, 15 Nov 2026: "His title shows 'Head of Technology, AI & Data (proposed)': remove (proposed)." Only that title.
do $$
declare o text := coalesce(current_setting('pulse.org_id', true), ''); g record; k int; n int := 0;
begin
  for g in select id from pulse.org loop
    perform set_config('pulse.org_id', g.id::text, true);
    update pulse.person_work_terms set role_title = regexp_replace(role_title, '\s*\(proposed\)\s*$', '')
     where org_id = g.id and role_title ~* '^Head of Technology, AI (&|and) Data \(proposed\)\s*$';
    get diagnostics k = row_count; n := n + k;
  end loop;
  perform set_config('pulse.org_id', o, true);
  raise notice 'ACCOUNT-META titles: % "(proposed)" removed', n;
end $$;

revoke all on function pulse.mailbox_shared(text), pulse.mailbox_consumer(text), pulse.acct_shared_mailbox_guard(), pulse.acct_signin_emails(uuid),
  pulse.acct_email_personal(uuid, text), pulse.acct_has_personal(uuid), pulse.acct_has_personal_email(uuid), pulse.acct_by_signin_email(text), pulse.acct_mark_personal(uuid, text),
  pulse.viewer_personal(), pulse.acct_upgrade_viewer_session(boolean), pulse.org_is_personal(uuid), pulse.acct_may_cross(uuid, boolean, uuid), pulse.acct_personal_needed(),
  pulse.acct_change_allowed(uuid), pulse.acct_mask_email(text), pulse.account_access(), pulse.acct_require_change(uuid),
  pulse.account_email_start(text), pulse.account_email_finish(text, text, boolean), pulse.account_email_remove(text),
  pulse.account_email_primary(text), pulse.account_mail_result(uuid, text, boolean), pulse.account_mail_health(), pulse.account_meta_report() from public;
grant execute on function pulse.mailbox_shared(text), pulse.account_access(), pulse.account_email_start(text), pulse.account_email_finish(text, text, boolean),
  pulse.account_email_remove(text), pulse.account_email_primary(text), pulse.account_mail_result(uuid, text, boolean), pulse.account_mail_health(),
  pulse.acct_mask_email(text) to pulse_api;

-- migrate:down
-- Forward-only for the data: shared mailboxes stay off accounts (account_login_email_removed keeps what was there). The
-- functions go back to their earlier bodies by the earlier migrations' own definitions; the renamed cores take their names back.
drop function if exists pulse.acct_upgrade_viewer_session(boolean), pulse.account_photo_backfill(), pulse.account_meta_report(), pulse.account_mail_health(), pulse.account_mail_result(uuid, text, boolean),
  pulse.account_email_primary(text), pulse.account_email_remove(text), pulse.account_email_finish(text, text, boolean), pulse.account_email_start(text),
  pulse.acct_require_change(uuid), pulse.account_access(), pulse.acct_mask_email(text);
drop table if exists pulse_priv.account_email_claim;
drop function if exists pulse.oidc_sign_in_any(text, jsonb, text, text, text);
alter function pulse.acct_oidc_any_core(text, jsonb, text, text, text) rename to oidc_sign_in_any;
drop function if exists pulse.google_sign_in_any(jsonb, text, text, text);
alter function pulse.acct_google_any_core(jsonb, text, text, text) rename to google_sign_in_any;
drop function if exists pulse.account_two_step_finish(text, text, text, text);
alter function pulse.acct_two_step_finish_core(text, text, text, text) rename to account_two_step_finish;
drop trigger if exists pulse_account_first_own_sign_in on pulse_priv.pulse_account;
drop function if exists pulse.account_join(text, jsonb, text, text), pulse.account_signup_confirm(jsonb, text, text, text), pulse.account_signup(jsonb, text, text);
alter function pulse.acct_join_core(text, jsonb, text, text) rename to account_join;
alter function pulse.acct_signup_confirm_core(jsonb, text, text, text) rename to account_signup_confirm;
alter function pulse.acct_signup_core(jsonb, text, text) rename to account_signup;
grant execute on function pulse.account_join(text, jsonb, text, text), pulse.account_signup_confirm(jsonb, text, text, text), pulse.account_signup(jsonb, text, text) to pulse_api;
drop function if exists pulse.acct_email_change(text, text);
alter function pulse.acct_email_change_core(text, text) rename to acct_email_change;
drop function if exists pulse.acct_link_issue(text, text, text);
alter function pulse.acct_link_issue_core(text, text, text) rename to acct_link_issue;
drop function if exists pulse.account_password_unify(text, text);
alter function pulse.acct_password_unify_core(text, text) rename to account_password_unify;
drop function if exists pulse.account_claim(text, text);
alter function pulse.acct_claim_core(text, text) rename to account_claim;
drop function if exists pulse.account_switch(uuid, text, text);
alter function pulse.acct_switch_core(uuid, text, text) rename to account_switch;
grant execute on function pulse.oidc_sign_in_any(text, jsonb, text, text, text), pulse.google_sign_in_any(jsonb, text, text, text),
  pulse.account_two_step_finish(text, text, text, text), pulse.acct_link_issue(text, text, text), pulse.acct_email_change(text, text),
  pulse.account_password_unify(text, text), pulse.account_claim(text, text), pulse.account_switch(uuid, text, text) to pulse_api;
drop trigger if exists account_login_email_shared_mailbox on pulse_priv.account_login_email;
drop trigger if exists pulse_account_shared_mailbox on pulse_priv.pulse_account;
alter table pulse_priv.account_challenge drop column if exists personal;
alter table pulse.login_session drop column if exists personal;
