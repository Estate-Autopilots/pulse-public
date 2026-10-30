-- migrate:up
-- PORTAL-2 (owner, 25 Oct 2026: "finish the client portal so clients can really live in it"). On CLIENT-PORTAL's 1020
-- (client seats, client_share, cp_viewer_conn) and ORG's 0920 (Pulse accounts). Additive: new tables, new functions, one
-- new column, three new triggers; notification_recipient_allowed and notification_authorized get one clause each by a
-- checked text patch (as 0509 and 1026 do), and the notification check constraints are widened with check_values_add.
--
--  1. Sign-in without friction for accounts that are not staff (clients, freelancers): an e-mailed reset link (60 min)
--     and a one-time sign-in link (15 min). One use; a newer link of the same kind replaces older ones; at most three
--     such links an hour per account, and three address confirmations (the API also limits per address and per IP). Using a link confirms the address. An
--     account changes its address only through a confirmation link sent to the new one.
--  2. Deliverables for the client's approval: versions (a file kept here in 1 MiB parts, or an https link), comments
--     pinned to a point of a picture, a moment of a video or a page of a document, Approve / Ask for changes. The EA
--     owner of the deliverable is told; asking for changes gives them a task with the pinned comments.
--  3. Paying from the client space (off until Finance switches it on): bank and UPI details; "I've paid" with a proof
--     gives the Finance person a check task; Finance confirms (the payment is recorded on the invoice) or says it has
--     not arrived; the client is told either way.
--  4. A client's own preferences: the first-sign-in tour, and the daily e-mail digest (off unless they turn it on).
--  5. Notifications for clients: client.* events (a quotation or invoice for them, a deliverable to check, a payment
--     answered) and, for client seats, the chat notices they already get (messages, missed calls) now reach their bell.
-- Global tables stay owner-only; new tenant tables have the tenant policy, forced RLS and (pulse schema) the audit trigger.

-- ------------------------------------------------------------------------------------------------ 1. account links
alter table pulse_priv.pulse_account add column email_confirmed_at timestamptz;

create table pulse_priv.account_link (
  org_id      uuid not null references pulse.org(id),          -- the organisation whose address the link was asked on
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references pulse_priv.pulse_account(id) on delete cascade,
  kind        text not null check (kind in ('reset', 'signin', 'confirm')),
  token_hash  text not null unique,
  sent_to     text not null check (sent_to ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  replaced_at timestamptz
);
create index account_link_live on pulse_priv.account_link(account_id, kind) where used_at is null and replaced_at is null;
alter table pulse_priv.account_link enable row level security;
alter table pulse_priv.account_link force row level security;
create policy tenant on pulse_priv.account_link using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on pulse_priv.account_link from public;

-- An account that may use e-mailed links: not someone of this installation's own company or with an organisation login
-- of their own (their organisation's recovery covers them, with its two-step rules), nor an AI employee; an active place
-- somewhere. A client is the owner (staff) of their own small company organisation (CLIENT-PORTAL): that does not count.
create function pulse.acct_link_ok(p_account uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select not exists (select 1 from pulse_priv.account_member m where m.account_id = p_account
       and (m.kind = 'agent' or (m.kind = 'staff' and m.member_org = install_org())
            or exists (select 1 from login_credential lc where lc.person_id = m.person_id and lc.org_id = m.member_org)))
     and exists (select 1 from pulse_priv.account_member m join org o on o.id = m.member_org and o.status = 'active'
                  where m.account_id = p_account)
$$;
revoke all on function pulse.acct_link_ok(uuid) from public;

-- Who answers a client's mail: the work address of their first contact at this organisation.
create function pulse.acct_reply_to(p_account uuid) returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select pp.email from pulse_priv.account_member m
    join pulse_priv.connect_seat s on s.seat_person = m.person_id and s.seat_org = current_org() and s.removed_at is null
    join person p on p.id = s.home_person and p.status = 'active' and p.side = 'staff'
    join people_profile pp on pp.person_id = p.id
   where m.account_id = p_account and m.member_org = current_org() and pp.email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
   order by s.created_at limit 1
$$;
revoke all on function pulse.acct_reply_to(uuid) from public;

-- Make a reset or sign-in link for the account behind a handle or address (the caller hashes the token and e-mails
-- it). Null when nothing may be sent: the API answers the same either way.
create function pulse.acct_link_issue(p_login text, p_kind text, p_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a pulse_priv.pulse_account%rowtype; l text := lower(btrim(coalesce(p_login, ''))); v_ttl interval;
begin
  if p_kind not in ('reset', 'signin') then raise exception 'Choose a link' using errcode = '22023'; end if;
  if l = '' or length(l) > 254 then return null; end if;
  select * into a from pulse_priv.pulse_account where handle = ltrim(l, '@') or email = l limit 1;
  if not found or a.email is null or not acct_link_ok(a.id) then return null; end if;
  if (select count(*) from pulse_priv.account_link where account_id = a.id and kind in ('reset', 'signin') and created_at > now() - interval '1 hour') >= 3 then return null; end if;
  update pulse_priv.account_link set replaced_at = now() where account_id = a.id and kind = p_kind and used_at is null and replaced_at is null;
  v_ttl := case p_kind when 'reset' then interval '60 minutes' else interval '15 minutes' end;
  insert into pulse_priv.account_link(org_id, account_id, kind, token_hash, sent_to, expires_at)
  values (current_org(), a.id, p_kind, p_hash, a.email, now() + v_ttl);
  return jsonb_build_object('to', a.email, 'name', a.display_name, 'handle', a.handle, 'minutes', (extract(epoch from v_ttl) / 60)::int,
    'org', (select name from org where id = current_org()), 'replyTo', acct_reply_to(a.id));
end $$;

-- The signed-in person asks to use a new address: a confirmation link goes there; the address changes when it is used.
create function pulse.acct_email_change(p_email text, p_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); e text := lower(btrim(coalesce(p_email, ''))); a pulse_priv.pulse_account%rowtype;
begin
  if v is null then raise exception 'Your Pulse account is not set up here' using errcode = '42501'; end if;
  if e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(e) > 254 then raise exception 'Type a valid e-mail address' using errcode = '22023'; end if;
  select * into a from pulse_priv.pulse_account where id = v;
  if a.email = e and a.email_confirmed_at is not null then raise exception 'That is already your confirmed address' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.pulse_account where email = e and id <> v) then raise exception 'Another Pulse account uses that address' using errcode = '23505'; end if;
  if (select count(*) from pulse_priv.account_link where account_id = v and kind = 'confirm' and created_at > now() - interval '1 hour') >= 3 then
    raise exception 'Too many e-mails this hour. Try again later.' using errcode = '54000'; end if;
  update pulse_priv.account_link set replaced_at = now() where account_id = v and kind = 'confirm' and used_at is null and replaced_at is null;
  insert into pulse_priv.account_link(org_id, account_id, kind, token_hash, sent_to, expires_at) values (current_org(), v, 'confirm', p_hash, e, now() + interval '24 hours');
  return jsonb_build_object('to', e, 'name', a.display_name, 'org', (select name from org where id = current_org()), 'replyTo', acct_reply_to(v));
end $$;

-- Use a link: confirm an address, or (reset: with the new password) sign in to the organisation used last. Null when the
-- link was used, replaced, expired or is unknown.
create function pulse.acct_link_redeem(p_hash text, p_kind text, p_password text, p_session text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare l pulse_priv.account_link%rowtype; a pulse_priv.pulse_account%rowtype; m record; target uuid; r jsonb;
begin
  if p_kind not in ('reset', 'signin', 'confirm') then return null; end if;
  select * into l from pulse_priv.account_link where token_hash = p_hash and kind = p_kind for update;
  if not found or l.used_at is not null or l.replaced_at is not null or l.expires_at <= now() then return null; end if;
  select * into a from pulse_priv.pulse_account where id = l.account_id for update;
  update pulse_priv.account_link set used_at = now() where id = l.id;
  if p_kind = 'confirm' then
    if exists (select 1 from pulse_priv.pulse_account where email = l.sent_to and id <> a.id) then
      raise exception 'Another Pulse account uses that address' using errcode = '23505'; end if;
    update pulse_priv.pulse_account set email = l.sent_to, email_confirmed_at = now(), updated_at = now() where id = a.id;
    return jsonb_build_object('confirmed', true, 'email', l.sent_to);
  end if;
  -- A link goes to the address it was sent to; once the address changed, older links stop.
  if a.email is distinct from l.sent_to or not acct_link_ok(a.id) then return null; end if;
  if p_kind = 'reset' then
    if coalesce(p_password, '') = '' then return null; end if;
    update pulse_priv.pulse_account set password_hash = crypt(p_password, gen_salt('bf', 10)), failed = 0, locked_until = null,
      email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() where id = a.id;
    -- A new password ends every session the account opened.
    for m in select member_org, person_id from pulse_priv.account_member where account_id = a.id loop
      perform acct_enter(m.member_org, null);
      update login_session set revoked_at = now() where org_id = m.member_org and person_id = m.person_id and via = 'account' and revoked_at is null;
      perform acct_leave();
    end loop;
  else
    update pulse_priv.pulse_account set failed = 0, locked_until = null, email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() where id = a.id;
  end if;
  update pulse_priv.account_link set replaced_at = now() where account_id = a.id and kind in ('reset', 'signin') and used_at is null and replaced_at is null;
  for target in select m2.member_org from pulse_priv.account_member m2 join org o on o.id = m2.member_org and o.status = 'active'
      where m2.account_id = a.id order by (m2.member_org = a.last_org) desc, m2.last_used_at desc nulls last loop
    r := acct_session(a.id, target, p_session, p_device);
    if r is not null then return r || jsonb_build_object('reset', p_kind = 'reset'); end if;
  end loop;
  return jsonb_build_object('failed', true, 'noOrg', true);
end $$;
revoke all on function pulse.acct_link_issue(text, text, text), pulse.acct_link_redeem(text, text, text, text, text) from public;
grant execute on function pulse.acct_link_issue(text, text, text), pulse.acct_link_redeem(text, text, text, text, text) to pulse_api;

-- The signed-in person's account address, for their space.
create function pulse.cp_account() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('handle', a.handle, 'email', a.email, 'confirmed', a.email_confirmed_at is not null,
    'pending', (select l.sent_to from pulse_priv.account_link l where l.account_id = a.id and l.kind = 'confirm' and l.used_at is null
                 and l.replaced_at is null and l.expires_at > now() order by l.created_at desc limit 1),
    'links', acct_link_ok(a.id))
  from pulse_priv.pulse_account a where a.id = account_of_viewer()
$$;

-- ------------------------------------------------------------------------------------------------ helpers
-- The active seats of a client record's people here (connections of kind client or partner made from that record).
create function pulse.cp_seats(p_client uuid) returns setof uuid
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select distinct s.seat_person from pulse_priv.connect_seat s
    join pulse_priv.org_connection c on c.id = s.connection_id and c.status = 'active' and c.a_org = current_org() and c.kind in ('client', 'partner')
    join person p on p.id = s.seat_person and p.status = 'active'
   where c.client_id = p_client and s.seat_org = current_org() and s.removed_at is null
$$;
create function pulse.cp_seat_for(p_person uuid, p_client uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select p_client is not null and p_person in (select cp_seats(p_client))
$$;

-- The viewer as an active member of the team here.
create function pulse.cp_staff() returns uuid
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is null or not exists (select 1 from person where id = current_viewer() and org_id = current_org() and side = 'staff' and status = 'active') then
    raise exception 'This is for the team' using errcode = '42501'; end if;
  return current_viewer();
end $$;

-- ₹ in Indian grouping, from paise (₹1,50,000).
create function pulse.cp_inr(p bigint) returns text language sql immutable set search_path = pulse, pg_temp as $$
  select '₹' || case when length(r) > 3 then regexp_replace(left(r, length(r) - 3), '(\d)(?=(\d\d)+$)', '\1,', 'g') || ',' || right(r, 3) else r end
  from (select round(coalesce(p, 0) / 100.0)::bigint::text r) x
$$;

-- A notice never stops the work it is about (a check constraint another migration narrowed, a person who left).
create function pulse.cp_emit(p_person uuid, p_type text, p_subject text, p_id uuid, p_key text, p_title text, p_href text) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if p_person is null then return; end if;
  perform notification_emit(p_person, p_type, p_subject, p_id, left(p_key, 200), left(p_title, 160), p_href, 'update');
exception when check_violation or invalid_parameter_value or foreign_key_violation then null;
end $$;
create function pulse.cp_emit_client(p_client uuid, p_type text, p_subject text, p_id uuid, p_key text, p_title text, p_href text) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s uuid;
begin
  for s in select cp_seats(p_client) loop perform cp_emit(s, p_type, p_subject, p_id, p_key, p_title, p_href); end loop;
end $$;

-- The client's shared group with the team, if one was made (1020 cp_group), for a line about what happened.
create function pulse.cp_client_group(p_client uuid) returns uuid
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select sh.ref from pulse_priv.connect_share sh join pulse_priv.org_connection c on c.id = sh.connection_id and c.status = 'active'
   where c.a_org = current_org() and c.client_id = p_client and sh.host_org = current_org() and sh.kind = 'chat'
     and exists (select 1 from chat_channel ch where ch.id = sh.ref and ch.org_id = current_org())
   order by sh.created_at limit 1
$$;

-- Who checks money a client says they paid: the Finance role, else leadership, else an admin.
create function pulse.cp_finance_person() returns uuid
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select p.id from person p join role_assignment r on r.org_id = p.org_id and r.person_id = p.id
     and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')
   where p.org_id = current_org() and p.side = 'staff' and p.status = 'active' and r.role_key in ('finance', 'leadership', 'admin')
   order by case r.role_key when 'finance' then 0 when 'leadership' then 1 else 2 end, p.display_name limit 1
$$;

-- The first point of contact of a client at this organisation (the team side of its connection), else its owner.
create function pulse.cp_poc(p_client uuid) returns uuid
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(
    (select s.home_person from pulse_priv.connect_seat s join pulse_priv.org_connection c on c.id = s.connection_id and c.status = 'active'
       join person p on p.id = s.home_person and p.status = 'active' and p.side = 'staff'
      where c.a_org = current_org() and c.client_id = p_client and s.home_org = current_org() and s.removed_at is null order by s.created_at limit 1),
    (select cl.relationship_owner_id from client cl join person p on p.id = cl.relationship_owner_id and p.status = 'active' and p.side = 'staff'
      where cl.id = p_client and cl.org_id = current_org()))
$$;

-- ------------------------------------------------------------------------------------------------ 2. files
-- Files shared with a client (deliverables) or sent by them (a payment proof), kept in 1 MiB parts so a video
-- streams with range requests. Read only through cp_file_open / cp_file_parts, which check who may see the file.
create table pulse_priv.cp_file (
  org_id       uuid not null references pulse.org(id),
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references pulse.client(id),
  purpose      text not null check (purpose in ('deliverable', 'proof')),
  name         text not null check (length(name) between 1 and 200),
  mime         text not null check (mime ~ '^[a-z]+/[a-z0-9.+-]{1,100}$'),
  size         bigint not null check (size between 1 and 314572800),
  parts        int not null check (parts between 1 and 300),
  created_by   uuid not null references pulse.person(id),
  created_at   timestamptz not null default now(),
  complete_at  timestamptz
);
create index cp_file_open on pulse_priv.cp_file(org_id, created_by, created_at) where complete_at is null;
create table pulse_priv.cp_file_part (
  org_id   uuid not null references pulse.org(id),
  file_id  uuid not null references pulse_priv.cp_file(id) on delete cascade,
  part     int not null check (part between 0 and 299),
  data     bytea not null check (length(data) between 1 and 1048576),
  primary key (file_id, part)
);
do $$ declare t text; begin
  foreach t in array array['cp_file', 'cp_file_part'] loop
    execute format('alter table pulse_priv.%I enable row level security', t);
    execute format('alter table pulse_priv.%I force row level security', t);
    execute format('create policy tenant on pulse_priv.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('revoke all on pulse_priv.%I from public', t);
  end loop;
end $$;

-- Start a file: the team for a deliverable of a client, a client's seat for a proof of payment (their own client).
create function pulse.cp_file_start(p_client uuid, p_purpose text, p_name text, p_mime text, p_size bigint) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); v_client uuid := p_client; v_mime text := lower(btrim(coalesce(p_mime, ''))); v_id uuid;
  v_name text := left(regexp_replace(btrim(coalesce(p_name, '')), '[[:cntrl:]/\\]+', ' ', 'g'), 200);
begin
  if p_purpose = 'deliverable' then
    perform cp_staff();
    if not exists (select 1 from client where id = v_client and org_id = current_org()) then raise exception 'Client not found' using errcode = 'P0002'; end if;
    if v_mime !~ '^(image/(jpeg|png|webp|gif)|video/(mp4|webm|quicktime)|audio/(mpeg|mp4|aac|ogg|wav|webm)|application/(pdf|zip|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation|spreadsheetml\.sheet)))$' then
      raise exception 'Share pictures, videos, audio, PDF, Word, PowerPoint, Excel or ZIP files' using errcode = '22023'; end if;
    if p_size > 314572800 then raise exception 'A file can be up to 300 MB: share a Drive link for bigger ones' using errcode = '22023'; end if;
  elsif p_purpose = 'proof' then
    select c.client_id into v_client from pulse_priv.org_connection c where c.id = cp_viewer_conn();
    if v_client is null then raise exception 'This is for clients of this organisation' using errcode = '42501'; end if;
    if v_mime !~ '^(image/(jpeg|png|webp)|application/pdf)$' then raise exception 'Attach a photo, screenshot or PDF of the payment' using errcode = '22023'; end if;
    if p_size > 10485760 then raise exception 'A proof can be up to 10 MB' using errcode = '22023'; end if;
  else raise exception 'Choose what the file is for' using errcode = '22023'; end if;
  if coalesce(p_size, 0) < 1 then raise exception 'The file is empty' using errcode = '22023'; end if;
  if length(v_name) < 1 then v_name := 'file'; end if;
  if (select count(*) from pulse_priv.cp_file where org_id = current_org() and created_by = me and created_at > now() - interval '1 day') >= 200 then
    raise exception 'Too many files today. Try again tomorrow.' using errcode = '54000'; end if;
  insert into pulse_priv.cp_file(org_id, client_id, purpose, name, mime, size, parts, created_by)
  values (current_org(), v_client, p_purpose, v_name, v_mime, p_size, ceil(p_size / 1048576.0)::int, me) returning id into v_id;
  return v_id;
end $$;

-- One part of a file being sent (again, on a retry); the last part ends it once every part has arrived.
create function pulse.cp_file_put(p_file uuid, p_part int, p_data bytea) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare f pulse_priv.cp_file%rowtype; want bigint; n int; total bigint;
begin
  select * into f from pulse_priv.cp_file where id = p_file and org_id = current_org() and created_by = current_viewer() for update;
  if f.id is null then raise exception 'File not found' using errcode = 'P0002'; end if;
  if f.complete_at is not null then return jsonb_build_object('complete', true, 'received', f.parts); end if;
  if p_part is null or p_part < 0 or p_part >= f.parts then raise exception 'That part is not in this file' using errcode = '22023'; end if;
  want := case when p_part < f.parts - 1 then 1048576 else f.size - 1048576::bigint * (f.parts - 1) end;
  if length(p_data) <> want then raise exception 'Part % should have % bytes', p_part, want using errcode = '22023'; end if;
  insert into pulse_priv.cp_file_part(org_id, file_id, part, data) values (current_org(), f.id, p_part, p_data)
  on conflict (file_id, part) do update set data = excluded.data;
  select count(*), coalesce(sum(length(data)), 0) into n, total from pulse_priv.cp_file_part where file_id = f.id;
  if n = f.parts and total = f.size then update pulse_priv.cp_file set complete_at = now() where id = f.id; end if;
  return jsonb_build_object('complete', n = f.parts and total = f.size, 'received', n);
end $$;

-- ------------------------------------------------------------------------------------------------ 3. deliverables
create table pulse.client_deliverable (
  org_id         uuid not null references pulse.org(id),
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references pulse.client(id),
  project_id     uuid references pulse.project(id),
  title          text not null check (length(btrim(title)) between 2 and 160),
  kind           text not null default 'image' check (kind in ('image', 'video', 'audio', 'document', 'link', 'other')),
  note           text check (note is null or length(note) <= 2000),
  owner_id       uuid not null references pulse.person(id),        -- who at the company hears the answer
  shared_by      uuid references pulse.person(id),
  shared_at      timestamptz not null default now(),
  answer_by      date,
  version        int not null default 1 check (version between 1 and 99),
  state          text not null default 'waiting' check (state in ('waiting', 'approved', 'changes', 'withdrawn')),
  seen_at        timestamptz,
  decided_at     timestamptz,
  decided_by     uuid references pulse.person(id),
  decided_name   text check (decided_name is null or length(decided_name) <= 120),
  decision_note  text check (decision_note is null or length(decision_note) <= 2000),
  task_id        uuid references pulse.task(id),
  updated_at     timestamptz not null default now()
);
create index client_deliverable_client on pulse.client_deliverable(org_id, client_id, shared_at desc);
create table pulse.client_deliverable_version (
  org_id          uuid not null references pulse.org(id),
  id              uuid primary key default gen_random_uuid(),
  deliverable_id  uuid not null references pulse.client_deliverable(id) on delete cascade,
  version         int not null check (version between 1 and 99),
  file_id         uuid references pulse_priv.cp_file(id),
  url             text check (url is null or (url ~ '^https://[^[:space:]]+$' and length(url) <= 2000)),
  name            text not null check (length(name) between 1 and 200),
  mime            text,
  size            bigint,
  note            text check (note is null or length(note) <= 2000),
  created_by      uuid references pulse.person(id),
  created_at      timestamptz not null default now(),
  decision        text check (decision in ('approved', 'changes')),
  decided_at      timestamptz,
  unique (deliverable_id, version),
  check (file_id is not null or url is not null)
);
create table pulse.client_deliverable_comment (
  org_id          uuid not null references pulse.org(id),
  id              uuid primary key default gen_random_uuid(),
  deliverable_id  uuid not null references pulse.client_deliverable(id) on delete cascade,
  version         int not null,
  author_id       uuid not null references pulse.person(id),
  side            text not null check (side in ('client', 'team')),
  body            text not null check (length(btrim(body)) between 1 and 2000),
  x               real check (x between 0 and 1),
  y               real check (y between 0 and 1),
  at_seconds      real check (at_seconds >= 0 and at_seconds < 86400),
  page            int check (page between 1 and 9999),
  resolved_at     timestamptz,
  resolved_by     uuid references pulse.person(id),
  created_at      timestamptz not null default now(),
  check ((x is null) = (y is null))
);
create index client_deliverable_comment_of on pulse.client_deliverable_comment(org_id, deliverable_id, created_at);

-- ------------------------------------------------------------------------------------------------ 4. payments
create table pulse.client_pay_settings (
  org_id      uuid primary key references pulse.org(id),
  enabled     boolean not null default false,
  gateway     text not null default 'none' check (gateway in ('none', 'razorpay')),
  payee       text check (payee is null or length(payee) <= 120),
  upi         text check (upi is null or upi ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.-]{1,64}$'),
  bank        jsonb not null default '{}' check (jsonb_typeof(bank) = 'object'),
  note        text check (note is null or length(note) <= 1000),
  updated_by  uuid references pulse.person(id),
  updated_at  timestamptz not null default now()
);
create table pulse.client_payment_claim (
  org_id        uuid not null references pulse.org(id),
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references pulse.client(id),
  document_id   uuid references pulse.erp_document(id),
  milestone_id  uuid references pulse.erp_milestone(id),
  amount        bigint not null check (amount > 0),
  paid_on       date not null,
  method        text not null check (method in ('upi', 'bank', 'cheque', 'cash', 'other')),
  reference     text check (reference is null or length(reference) <= 120),
  note          text check (note is null or length(note) <= 1000),
  proof_file    uuid references pulse_priv.cp_file(id),
  created_by    uuid not null references pulse.person(id),
  created_at    timestamptz not null default now(),
  state         text not null default 'waiting' check (state in ('waiting', 'confirmed', 'not_received')),
  checker_id    uuid references pulse.person(id),
  task_id       uuid references pulse.task(id),
  decided_by    uuid references pulse.person(id),
  decided_at    timestamptz,
  decided_note  text check (decided_note is null or length(decided_note) <= 1000),
  payment_id    uuid references pulse.erp_payment(id),
  check (document_id is not null or milestone_id is not null)
);
create index client_payment_claim_client on pulse.client_payment_claim(org_id, client_id, created_at desc);
create index client_payment_claim_doc on pulse.client_payment_claim(org_id, document_id) where document_id is not null;

-- ------------------------------------------------------------------------------------------------ 5. preferences
create table pulse.client_portal_pref (
  org_id          uuid not null references pulse.org(id),
  person_id       uuid primary key references pulse.person(id) on delete cascade,
  tour_done_at    timestamptz,
  digest          boolean not null default false,
  digest_on_at    timestamptz,
  digest_last_at  timestamptz,
  updated_at      timestamptz not null default now()
);

do $$ declare t text; begin
  foreach t in array array['client_deliverable', 'client_deliverable_version', 'client_deliverable_comment', 'client_pay_settings', 'client_payment_claim', 'client_portal_pref'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('create trigger audit_mutation after insert or update or delete on pulse.%I for each row execute function pulse.audit_mutation()', t);
  end loop;
end $$;

-- ------------------------------------------------------------------------------------------------ file reads
-- What a viewer may open: the team a deliverable's file (a proof: Finance or the person checking it); the client's own
-- people a file shared with them (not withdrawn), or one they sent.
create function pulse.cp_file_can(p_file uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select f.complete_at is not null and (
      (exists (select 1 from person where id = current_viewer() and org_id = current_org() and side = 'staff' and status = 'active')
        and (f.purpose = 'deliverable' or erp_can(false)
             or exists (select 1 from client_payment_claim k where k.org_id = current_org() and k.proof_file = f.id and k.checker_id = current_viewer())))
      or (cp_seat_for(current_viewer(), f.client_id) and (f.created_by = current_viewer()
        or exists (select 1 from client_deliverable_version v join client_deliverable x on x.id = v.deliverable_id
                    where v.org_id = current_org() and v.file_id = f.id and x.state <> 'withdrawn')
        or exists (select 1 from client_payment_claim k where k.org_id = current_org() and k.proof_file = f.id))))
    from pulse_priv.cp_file f where f.id = p_file and f.org_id = current_org()), false)
$$;
create function pulse.cp_file_open(p_file uuid) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('name', f.name, 'mime', f.mime, 'size', f.size, 'parts', f.parts)
  from pulse_priv.cp_file f where f.id = p_file and f.org_id = current_org() and cp_file_can(p_file)
$$;
create function pulse.cp_file_parts(p_file uuid, p_from int, p_to int) returns table(part int, data bytea)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select p.part, p.data from pulse_priv.cp_file_part p
   where p.file_id = p_file and p.org_id = current_org() and p.part between p_from and least(p_to, p_from + 63) and cp_file_can(p_file)
   order by p.part
$$;

-- ------------------------------------------------------------------------------------------------ deliverables: the team
create function pulse.cp_kind(p_mime text, p_url text) returns text language sql immutable set search_path = pulse, pg_temp as $$
  select case when p_mime like 'image/%' then 'image' when p_mime like 'video/%' then 'video' when p_mime like 'audio/%' then 'audio'
    when p_mime in ('application/pdf') or p_mime like 'application/vnd.openxmlformats-officedocument.%' then 'document'
    when p_mime is null and p_url is not null then 'link' else 'other' end
$$;

-- A version's content: a finished file uploaded for this client by the team, or an https link.
create function pulse.cp_version_insert(p_deliverable uuid, p_client uuid, p_version int, p jsonb) returns text
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare f pulse_priv.cp_file%rowtype; v_url text := nullif(btrim(coalesce(p ->> 'url', '')), ''); v_name text := nullif(left(btrim(coalesce(p ->> 'name', '')), 200), '');
begin
  if p ? 'fileId' and nullif(p ->> 'fileId', '') is not null then
    select * into f from pulse_priv.cp_file where id = (p ->> 'fileId')::uuid and org_id = current_org() and client_id = p_client and purpose = 'deliverable';
    if f.id is null then raise exception 'Upload the file again' using errcode = '22023'; end if;
    if f.complete_at is null then raise exception 'The file has not finished uploading' using errcode = '22023'; end if;
    insert into client_deliverable_version(org_id, deliverable_id, version, file_id, name, mime, size, note, created_by)
    values (current_org(), p_deliverable, p_version, f.id, coalesce(v_name, f.name), f.mime, f.size, nullif(left(btrim(coalesce(p ->> 'versionNote', '')), 2000), ''), current_viewer());
    return cp_kind(f.mime, null);
  end if;
  if v_url is null or v_url !~ '^https://[^[:space:]]+$' or length(v_url) > 2000 then raise exception 'Add a file, or a link that starts with https://' using errcode = '22023'; end if;
  insert into client_deliverable_version(org_id, deliverable_id, version, url, name, note, created_by)
  values (current_org(), p_deliverable, p_version, v_url, coalesce(v_name, left(regexp_replace(v_url, '^https://', ''), 200)),
    nullif(left(btrim(coalesce(p ->> 'versionNote', '')), 2000), ''), current_viewer());
  return 'link';
end $$;

-- Tell the client's people (and their shared group) that something waits for their eyes.
create function pulse.cp_deliverable_tell(p_id uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare x client_deliverable%rowtype; g uuid; v_org text := (select name from org where id = current_org());
begin
  select * into x from client_deliverable where id = p_id and org_id = current_org();
  perform cp_emit_client(x.client_id, 'client.delivery', 'client_deliverable', x.id, 'delivery:' || x.id || ':v' || x.version,
    case when x.version = 1 then v_org || ' shared “' || x.title || '” for your approval' else 'Version ' || x.version || ' of “' || x.title || '” to check' end,
    '/client/review/' || x.id);
  g := cp_client_group(x.client_id);
  if g is not null then
    perform chat_event_line(g, current_viewer(), case when x.version = 1 then 'shared “' || x.title || '” for approval in the client space' else 'shared version ' || x.version || ' of “' || x.title || '” for approval' end);
  end if;
end $$;

create function pulse.client_deliverable_share(p_client uuid, p jsonb) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := cp_staff(); v_id uuid; v_owner uuid; v_project uuid; v_kind text; v_answer date;
  v_title text := regexp_replace(btrim(coalesce(p ->> 'title', '')), '\s+', ' ', 'g');
begin
  if not exists (select 1 from client where id = p_client and org_id = current_org()) then raise exception 'Client not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from cp_seats(p_client)) then raise exception 'Nobody of this client is on Pulse yet: invite them first (Pulse access)' using errcode = '22023'; end if;
  if length(v_title) not between 2 and 160 then raise exception 'Name what you are sharing' using errcode = '22023'; end if;
  v_project := nullif(p ->> 'projectId', '')::uuid;
  if v_project is not null and not exists (select 1 from project where id = v_project and org_id = current_org() and client_id = p_client and deleted_at is null) then
    raise exception 'Choose one of this client''s projects' using errcode = '22023'; end if;
  v_owner := coalesce(nullif(p ->> 'ownerId', '')::uuid, me);
  if not exists (select 1 from person where id = v_owner and org_id = current_org() and side = 'staff' and status = 'active') then
    raise exception 'Choose an active colleague to hear the answer' using errcode = '22023'; end if;
  v_answer := nullif(p ->> 'answerBy', '')::date;
  if v_answer is not null and v_answer < (now() at time zone org_time_zone())::date then raise exception 'Choose a day from today on' using errcode = '22023'; end if;
  insert into client_deliverable(org_id, client_id, project_id, title, note, owner_id, shared_by, answer_by)
  values (current_org(), p_client, v_project, v_title, nullif(left(btrim(coalesce(p ->> 'note', '')), 2000), ''), v_owner, me, v_answer) returning id into v_id;
  v_kind := cp_version_insert(v_id, p_client, 1, p);
  update client_deliverable set kind = v_kind where id = v_id;
  perform cp_deliverable_tell(v_id);
  return v_id;
end $$;

create function pulse.client_deliverable_version_add(p_id uuid, p jsonb) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := cp_staff(); x client_deliverable%rowtype; v_kind text;
begin
  select * into x from client_deliverable where id = p_id and org_id = current_org() for update;
  if x.id is null or x.state = 'withdrawn' then raise exception 'Deliverable not found' using errcode = 'P0002'; end if;
  if x.version >= 99 then raise exception 'Share it as a new deliverable' using errcode = '22023'; end if;
  v_kind := cp_version_insert(x.id, x.client_id, x.version + 1, p);
  update client_deliverable set version = x.version + 1, kind = v_kind, state = 'waiting', seen_at = null, decided_at = null, decided_by = null,
    decided_name = null, decision_note = null, updated_at = now() where id = x.id;
  perform cp_deliverable_tell(x.id);
  return x.version + 1;
end $$;

create function pulse.client_deliverable_withdraw(p_id uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := cp_staff();
begin
  update client_deliverable set state = 'withdrawn', updated_at = now() where id = p_id and org_id = current_org() and state <> 'withdrawn';
  if not found then raise exception 'Deliverable not found' using errcode = 'P0002'; end if;
end $$;

-- One deliverable as JSON: for the team (owner, task) or the client.
create function pulse.cp_deliverable_json(p_id uuid, p_team boolean) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('id', x.id, 'title', x.title, 'kind', x.kind, 'note', x.note, 'state', x.state, 'version', x.version,
    'sharedAt', x.shared_at, 'sharedBy', (select display_name from person where id = x.shared_by), 'answerBy', to_char(x.answer_by, 'YYYY-MM-DD'),
    'project', (select jsonb_build_object('id', pr.id, 'title', coalesce(pr.title, pr.name)) from project pr where pr.id = x.project_id),
    'owner', (select jsonb_build_object('id', p.id, 'name', p.display_name) from person p where p.id = x.owner_id),
    'decidedAt', x.decided_at, 'decidedName', x.decided_name, 'decisionNote', x.decision_note, 'updatedAt', x.updated_at,
    'seenAt', case when p_team then x.seen_at end, 'taskId', case when p_team then x.task_id end,
    'client', case when p_team then (select jsonb_build_object('id', c.id, 'name', c.display_name) from client c where c.id = x.client_id) end,
    'versions', coalesce((select jsonb_agg(jsonb_build_object('version', v.version, 'name', v.name, 'mime', v.mime, 'size', v.size, 'url', v.url,
        'fileId', v.file_id, 'note', v.note, 'at', v.created_at, 'by', (select display_name from person where id = v.created_by),
        'decision', v.decision, 'decidedAt', v.decided_at) order by v.version desc)
      from client_deliverable_version v where v.deliverable_id = x.id and v.org_id = current_org()), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'version', m.version, 'body', m.body, 'x', m.x, 'y', m.y, 'at', m.at_seconds,
        'page', m.page, 'side', m.side, 'by', (select display_name from person where id = m.author_id), 'mine', m.author_id = current_viewer(),
        'resolvedAt', m.resolved_at, 'createdAt', m.created_at) order by m.created_at)
      from client_deliverable_comment m where m.deliverable_id = x.id and m.org_id = current_org()), '[]'::jsonb))
  from client_deliverable x where x.id = p_id and x.org_id = current_org()
$$;

-- The team's list for one client (the client page's Approvals tab).
create function pulse.client_deliverables(p_client uuid) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  perform cp_staff();
  if not exists (select 1 from client where id = p_client and org_id = current_org()) then raise exception 'Client not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('onPulse', exists (select 1 from cp_seats(p_client)),
    'items', coalesce((select jsonb_agg(cp_deliverable_json(x.id, true) order by (x.state = 'waiting') desc, x.updated_at desc)
      from client_deliverable x where x.org_id = current_org() and x.client_id = p_client and x.state <> 'withdrawn'), '[]'::jsonb),
    'projects', coalesce((select jsonb_agg(jsonb_build_object('id', pr.id, 'title', coalesce(pr.title, pr.name)) order by coalesce(pr.starts_on, pr.start_month) desc nulls last)
      from project pr where pr.org_id = current_org() and pr.client_id = p_client and pr.deleted_at is null), '[]'::jsonb),
    'owner', cp_poc(p_client), 'me', current_viewer(),
    'team', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name) order by p.display_name) from person p
      where p.org_id = current_org() and p.side = 'staff' and p.status = 'active' and p.id in (select id from work_people())), '[]'::jsonb));
end $$;

create function pulse.client_deliverable_get(p_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare r jsonb;
begin
  perform cp_staff();
  r := cp_deliverable_json(p_id, true);
  if r is null then raise exception 'Deliverable not found' using errcode = 'P0002'; end if;
  return r;
end $$;

-- ------------------------------------------------------------------------------------------------ deliverables: both sides
-- A comment, pinned to a point (x, y of a picture, 0..1), a moment (seconds of a video) or a page, or on the whole.
create function pulse.cp_deliverable_comment(p_id uuid, p jsonb) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); x client_deliverable%rowtype; v_side text; v_id uuid; v_version int;
  v_body text := btrim(coalesce(p ->> 'body', ''));
begin
  select * into x from client_deliverable where id = p_id and org_id = current_org() and state <> 'withdrawn';
  if x.id is null then raise exception 'Deliverable not found' using errcode = 'P0002'; end if;
  if exists (select 1 from person where id = me and org_id = current_org() and side = 'staff' and status = 'active') then v_side := 'team';
  elsif cp_seat_for(me, x.client_id) then v_side := 'client';
  else raise exception 'Deliverable not found' using errcode = 'P0002'; end if;
  v_version := coalesce(nullif(p ->> 'version', '')::int, x.version);
  if not exists (select 1 from client_deliverable_version where deliverable_id = x.id and version = v_version) then raise exception 'Choose a version' using errcode = '22023'; end if;
  if length(v_body) not between 1 and 2000 then raise exception 'Write your comment (up to 2,000 characters)' using errcode = '22023'; end if;
  insert into client_deliverable_comment(org_id, deliverable_id, version, author_id, side, body, x, y, at_seconds, page)
  values (current_org(), x.id, v_version, me, v_side, v_body, (p ->> 'x')::real, (p ->> 'y')::real, (p ->> 'at')::real, (p ->> 'page')::int) returning id into v_id;
  if v_side = 'client' then
    perform cp_emit(x.owner_id, 'client.comment', 'client_deliverable', x.id, 'comment:' || v_id,
      coalesce((select display_name from person where id = me), 'The client') || ' commented on “' || x.title || '”', '/clients/' || x.client_id || '?tab=approvals&d=' || x.id);
  end if;
  update client_deliverable set updated_at = now() where id = x.id;
  return v_id;
end $$;

create function pulse.cp_deliverable_comment_resolve(p_comment uuid, p_done boolean) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m client_deliverable_comment%rowtype; x client_deliverable%rowtype; me uuid := current_viewer();
begin
  select * into m from client_deliverable_comment where id = p_comment and org_id = current_org();
  select * into x from client_deliverable where id = m.deliverable_id and org_id = current_org();
  if m.id is null or x.state = 'withdrawn' or not (m.author_id = me or exists (select 1 from person where id = me and org_id = current_org() and side = 'staff' and status = 'active')
     or cp_seat_for(me, x.client_id)) then raise exception 'Comment not found' using errcode = 'P0002'; end if;
  update client_deliverable_comment set resolved_at = case when p_done then now() end, resolved_by = case when p_done then me end where id = m.id;
end $$;

-- ------------------------------------------------------------------------------------------------ deliverables: the client
create function pulse.cp_my_client() returns uuid
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select c.client_id from pulse_priv.org_connection c where c.id = cp_viewer_conn()
$$;

create function pulse.cp_deliverables() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(cp_deliverable_json(x.id, false) order by (x.state = 'waiting') desc, x.updated_at desc), '[]'::jsonb)
  from client_deliverable x where x.org_id = current_org() and x.client_id = cp_my_client() and x.state <> 'withdrawn'
$$;

create function pulse.cp_deliverable(p_id uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_client uuid := cp_my_client(); r jsonb;
begin
  if v_client is null or not exists (select 1 from client_deliverable where id = p_id and org_id = current_org() and client_id = v_client and state <> 'withdrawn') then
    raise exception 'Not found' using errcode = 'P0002'; end if;
  update client_deliverable set seen_at = coalesce(seen_at, now()) where id = p_id and seen_at is null;
  r := cp_deliverable_json(p_id, false);
  return r || jsonb_build_object('provider', (select name from org where id = current_org()), 'me', (select display_name from person where id = current_viewer()));
end $$;

-- The client answers the current version: approved, or changes (what to change, or the comments they pinned).
create function pulse.cp_deliverable_decide(p_id uuid, p_version int, p_decision text, p_name text, p_note text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); v_client uuid := cp_my_client(); x client_deliverable%rowtype; v_note text := nullif(left(btrim(coalesce(p_note, '')), 2000), '');
  v_name text; v_owner uuid; v_client_name text; v_list text; n int; tid uuid; g uuid;
begin
  select * into x from client_deliverable where id = p_id and org_id = current_org() and client_id = v_client and state <> 'withdrawn' for update;
  if x.id is null then raise exception 'Not found' using errcode = 'P0002'; end if;
  if p_decision not in ('approved', 'changes') then raise exception 'Approve, or ask for changes' using errcode = '22023'; end if;
  if p_version is distinct from x.version then raise exception 'A newer version arrived: look at version % first', x.version using errcode = '22023'; end if;
  if x.state <> 'waiting' then raise exception 'This version was already answered' using errcode = '22023'; end if;
  select count(*) into n from client_deliverable_comment where deliverable_id = x.id and version = x.version and side = 'client' and resolved_at is null;
  if p_decision = 'changes' and v_note is null and n = 0 then raise exception 'Say what should change, or pin a comment on the file' using errcode = '22023'; end if;
  v_name := left(coalesce(nullif(btrim(coalesce(p_name, '')), ''), (select display_name from person where id = me)), 120);
  update client_deliverable set state = p_decision, decided_at = now(), decided_by = me, decided_name = v_name, decision_note = v_note,
    seen_at = coalesce(seen_at, now()), updated_at = now() where id = x.id;
  update client_deliverable_version set decision = p_decision, decided_at = now() where deliverable_id = x.id and version = x.version;
  v_client_name := coalesce((select display_name from client where id = x.client_id), 'The client');
  v_owner := case when exists (select 1 from person where id = x.owner_id and side = 'staff' and status = 'active') then x.owner_id else coalesce(cp_poc(x.client_id), x.shared_by) end;
  if p_decision = 'changes' and v_owner is not null then
    select string_agg(rn || '. ' || m.body || case when m.at_seconds is not null then ' (at ' || floor(m.at_seconds / 60)::int || ':' || lpad((floor(m.at_seconds)::int % 60)::text, 2, '0') || ')'
        when m.page is not null then ' (page ' || m.page || ')' when m.x is not null then ' (pinned on the picture)' else '' end, E'\n' order by m.created_at)
      into v_list from (select m.*, row_number() over (order by m.created_at) rn from client_deliverable_comment m
                         where m.deliverable_id = x.id and m.version = x.version and m.side = 'client' and m.resolved_at is null) m;
    perform acct_enter(current_org(), v_owner);
    tid := task_save(null, jsonb_build_object('title', left(v_client_name || ' asked for changes: ' || x.title || ' (v' || x.version || ')', 300),
      'notes', left(concat_ws(E'\n\n', v_note, case when v_list is not null then 'Pinned comments:' || E'\n' || v_list end,
        'See the file and every comment: /clients/' || x.client_id || '?tab=approvals&d=' || x.id), 4000),
      'assigneeId', v_owner, 'reviewerId', null, 'urgency', 'high') || case when x.project_id is not null then jsonb_build_object('projectId', x.project_id) else '{}'::jsonb end);
    perform acct_leave();
    update client_deliverable set task_id = tid where id = x.id;
  end if;
  perform cp_emit(v_owner, case p_decision when 'approved' then 'client.approved' else 'client.changes' end, 'client_deliverable', x.id,
    p_decision || ':' || x.id || ':v' || x.version,
    v_client_name || case p_decision when 'approved' then ' approved “' else ' asked for changes to “' end || x.title || '” (v' || x.version || ')',
    case when tid is not null then '/tasks/' || tid else '/clients/' || x.client_id || '?tab=approvals&d=' || x.id end);
  g := cp_client_group(x.client_id);
  if g is not null then
    perform chat_event_line(g, me, case p_decision when 'approved' then 'approved “' || x.title || '” (v' || x.version || ')' else 'asked for changes to “' || x.title || '” (v' || x.version || ')' end);
  end if;
  return jsonb_build_object('decision', p_decision, 'version', x.version, 'taskId', tid);
end $$;

-- ------------------------------------------------------------------------------------------------ payments
-- Bank details as the invoice template prints them (ERP templates' design.bank), for defaults.
create function pulse.cp_template_bank() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select t.design -> 'bank' from erp_template_default d join erp_template t on t.id = d.template_id
     where d.org_id = current_org() and d.doc_type = 'invoice' and jsonb_typeof(t.design -> 'bank') = 'object'),
    (select t.design -> 'bank' from erp_template t where t.org_id = current_org() and not t.archived and 'invoice' = any(t.doc_types)
      and jsonb_typeof(t.design -> 'bank') = 'object' order by t.updated_at desc limit 1), '{}'::jsonb)
$$;

create function pulse.client_pay_settings_get() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare s client_pay_settings%rowtype;
begin
  if not erp_can(false) then raise exception 'ERP is for leadership, Finance and the Accountant' using errcode = '42501'; end if;
  select * into s from client_pay_settings where org_id = current_org();
  return jsonb_build_object('enabled', coalesce(s.enabled, false), 'gateway', coalesce(s.gateway, 'none'), 'payee', coalesce(s.payee, (select name from org where id = current_org())),
    'upi', s.upi, 'bank', case when s.org_id is null or s.bank = '{}'::jsonb then cp_template_bank() else s.bank end, 'note', s.note,
    'templateBank', cp_template_bank(), 'updatedAt', s.updated_at, 'updatedBy', (select display_name from person where id = s.updated_by), 'canEdit', erp_can(true));
end $$;

create function pulse.client_pay_settings_save(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := erp_require(true); v_bank jsonb := '{}'; k text; v_upi text := nullif(btrim(coalesce(p ->> 'upi', '')), '');
begin
  if coalesce(p ->> 'gateway', 'none') <> 'none' then raise exception 'No payment gateway is connected yet: use bank transfer and UPI' using errcode = '22023'; end if;
  if v_upi is not null and v_upi !~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.-]{1,64}$' then raise exception 'Type the UPI ID as name@bank' using errcode = '22023'; end if;
  foreach k in array array['accountName', 'bankName', 'branch', 'accountNumber', 'ifsc'] loop
    if nullif(btrim(coalesce(p -> 'bank' ->> k, '')), '') is not null then v_bank := v_bank || jsonb_build_object(k, left(btrim(p -> 'bank' ->> k), 120)); end if;
  end loop;
  if v_bank ? 'ifsc' and upper(v_bank ->> 'ifsc') !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then raise exception 'The IFSC is 11 characters, like HDFC0001234' using errcode = '22023'; end if;
  if (p ->> 'enabled')::boolean and v_upi is null and not (v_bank ? 'accountNumber' and v_bank ? 'ifsc') then
    raise exception 'Add a UPI ID or the bank account and IFSC before switching it on' using errcode = '22023'; end if;
  insert into client_pay_settings(org_id, enabled, gateway, payee, upi, bank, note, updated_by, updated_at)
  values (current_org(), coalesce((p ->> 'enabled')::boolean, false), 'none', nullif(left(btrim(coalesce(p ->> 'payee', '')), 120), ''), v_upi, v_bank,
    nullif(left(btrim(coalesce(p ->> 'note', '')), 1000), ''), me, now())
  on conflict (org_id) do update set enabled = excluded.enabled, gateway = excluded.gateway, payee = excluded.payee, upi = excluded.upi, bank = excluded.bank,
    note = excluded.note, updated_by = me, updated_at = now();
  return client_pay_settings_get();
end $$;

-- What a client sees to pay (nothing while it is off).
create function pulse.cp_pay_info() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select case when s.enabled and cp_my_client() is not null then jsonb_build_object('payee', coalesce(s.payee, (select name from org where id = current_org())),
    'upi', s.upi, 'bank', case when s.bank = '{}'::jsonb then cp_template_bank() else s.bank end, 'note', s.note, 'gateway', s.gateway) end
  from client_pay_settings s where s.org_id = current_org()
$$;

create function pulse.cp_claim_json(p_id uuid) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('id', k.id, 'documentId', k.document_id, 'milestoneId', k.milestone_id, 'amount', k.amount, 'paidOn', to_char(k.paid_on, 'YYYY-MM-DD'),
    'method', k.method, 'reference', k.reference, 'note', k.note, 'proofFileId', k.proof_file, 'state', k.state, 'at', k.created_at,
    'by', (select display_name from person where id = k.created_by), 'decidedAt', k.decided_at, 'decidedNote', k.decided_note,
    'decidedBy', (select display_name from person where id = k.decided_by),
    'what', coalesce((select 'Invoice ' || coalesce(d.number, '') from erp_document d where d.id = k.document_id),
      (select 'Instalment: ' || m.label from erp_milestone m where m.id = k.milestone_id)))
  from client_payment_claim k where k.id = p_id and k.org_id = current_org()
$$;

-- The client says they paid an invoice or an instalment: Finance gets a task to check it.
create function pulse.cp_pay_claim(p jsonb) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); v_client uuid := cp_my_client(); d erp_document%rowtype; m erp_milestone%rowtype; v_due bigint; v_doc uuid; v_ms uuid;
  v_amount bigint; v_on date; v_today date := (now() at time zone org_time_zone())::date; v_method text := coalesce(nullif(p ->> 'method', ''), 'upi');
  v_proof uuid; v_checker uuid; v_id uuid; tid uuid; v_what text; v_client_name text; v_ref text := nullif(left(btrim(coalesce(p ->> 'reference', '')), 120), '');
begin
  if v_client is null then raise exception 'This is for clients of this organisation' using errcode = '42501'; end if;
  if not coalesce((select enabled from client_pay_settings where org_id = current_org()), false) then
    raise exception 'Paying here is not switched on: ask your team how to pay' using errcode = '22023'; end if;
  if nullif(p ->> 'documentId', '') is not null then
    select * into d from erp_document where id = (p ->> 'documentId')::uuid and org_id = current_org() and client_id = v_client and doc_type = 'invoice' and status in ('issued', 'sent', 'part_paid');
    if d.id is null then raise exception 'Invoice not found' using errcode = 'P0002'; end if;
    v_doc := d.id; v_due := d.total - d.paid - d.credited; v_what := 'invoice ' || coalesce(d.number, '');
  elsif nullif(p ->> 'milestoneId', '') is not null then
    select mm.* into m from erp_milestone mm join erp_engagement e on e.id = mm.engagement_id and e.org_id = current_org() and e.client_id = v_client and e.status <> 'cancelled'
     where mm.id = (p ->> 'milestoneId')::uuid;
    if m.id is null then raise exception 'Instalment not found' using errcode = 'P0002'; end if;
    select * into d from erp_document where id = m.document_id and org_id = current_org() and status not in ('draft', 'cancelled');
    if d.id is not null then
      if d.status = 'paid' then raise exception 'This instalment is already paid' using errcode = '22023'; end if;
      v_doc := d.id; v_due := d.total - d.paid - d.credited;
    else v_due := m.amount; end if;
    v_ms := m.id; v_what := 'instalment “' || m.label || '”';
  else raise exception 'Choose the invoice or instalment you paid' using errcode = '22023'; end if;
  v_amount := (p ->> 'amount')::bigint;
  if v_amount is null or v_amount <= 0 then raise exception 'Type the amount you paid' using errcode = '22023'; end if;
  if v_amount > v_due then raise exception 'That is more than the % due', cp_inr(v_due) using errcode = '22023'; end if;
  v_on := (p ->> 'paidOn')::date;
  if v_on is null or v_on > v_today or v_on < v_today - 180 then raise exception 'Choose the day you paid' using errcode = '22023'; end if;
  if v_method not in ('upi', 'bank', 'cheque', 'cash', 'other') then raise exception 'Choose how you paid' using errcode = '22023'; end if;
  if exists (select 1 from client_payment_claim where org_id = current_org() and client_id = v_client and state = 'waiting'
             and (document_id = v_doc or milestone_id = v_ms)) then
    raise exception 'You already told us about a payment for this: Finance is checking it' using errcode = '23505'; end if;
  if nullif(p ->> 'proofFileId', '') is not null then
    select id into v_proof from pulse_priv.cp_file where id = (p ->> 'proofFileId')::uuid and org_id = current_org() and created_by = me and purpose = 'proof' and complete_at is not null;
    if v_proof is null then raise exception 'Attach the proof again' using errcode = '22023'; end if;
  end if;
  v_checker := coalesce(cp_finance_person(), cp_poc(v_client));
  insert into client_payment_claim(org_id, client_id, document_id, milestone_id, amount, paid_on, method, reference, note, proof_file, created_by, checker_id)
  values (current_org(), v_client, v_doc, v_ms, v_amount, v_on, v_method, v_ref, nullif(left(btrim(coalesce(p ->> 'note', '')), 1000), ''), v_proof, me, v_checker)
  returning id into v_id;
  v_client_name := coalesce((select display_name from client where id = v_client), 'A client');
  if v_checker is not null then
    perform acct_enter(current_org(), v_checker);
    tid := task_save(null, jsonb_build_object('title', left('Check payment: ' || v_client_name || ' paid ' || cp_inr(v_amount) || ' for ' || v_what, 300),
      'notes', left(concat_ws(E'\n', (select display_name from person where id = me) || ' says they paid on ' || to_char(v_on, 'FMDD Mon YYYY') || ' by '
          || case v_method when 'upi' then 'UPI' when 'bank' then 'bank transfer' else v_method end || coalesce(', reference ' || v_ref, '') || '.',
        nullif(left(btrim(coalesce(p ->> 'note', '')), 1000), ''), case when v_proof is not null then 'They attached a proof.' end,
        case when v_doc is not null then 'Check the bank, then confirm it on the invoice in Billing: /erp/documents/' || v_doc
          else 'Raise the invoice for this instalment in Billing, then confirm the payment on it.' end), 4000),
      'assigneeId', v_checker, 'reviewerId', null, 'urgency', 'high'));
    perform acct_leave();
    update client_payment_claim set task_id = tid where id = v_id;
    perform cp_emit(v_checker, 'client.paid', 'client_payment', v_id, 'paid:' || v_id, v_client_name || ' says they paid ' || cp_inr(v_amount) || ' for ' || v_what,
      case when v_doc is not null then '/erp/documents/' || v_doc else '/tasks/' || tid end);
  end if;
  return v_id;
end $$;

-- Finance's view of what clients said they paid on one document.
create function pulse.client_payment_claims(p_doc uuid) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if not erp_can(false) then raise exception 'ERP is for leadership, Finance and the Accountant' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(cp_claim_json(k.id) || jsonb_build_object('taskId', k.task_id) order by k.created_at desc)
    from client_payment_claim k where k.org_id = current_org() and (k.document_id = p_doc
      or k.milestone_id in (select id from erp_milestone where document_id = p_doc))), '[]'::jsonb);
end $$;

-- Finance answers: confirmed (the payment is recorded on the invoice) or not received (with a word for the client).
create function pulse.client_payment_decide(p_claim uuid, p_decision text, p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := erp_require(true); k client_payment_claim%rowtype; v_doc uuid; v_pay uuid; v_note text := nullif(left(btrim(coalesce(p ->> 'note', '')), 1000), '');
  v_what text;
begin
  select * into k from client_payment_claim where id = p_claim and org_id = current_org() for update;
  if k.id is null then raise exception 'Not found' using errcode = 'P0002'; end if;
  if k.state <> 'waiting' then raise exception 'This was already answered' using errcode = '22023'; end if;
  v_what := cp_claim_json(k.id) ->> 'what';
  if p_decision = 'confirmed' then
    v_doc := coalesce(k.document_id, (select document_id from erp_milestone where id = k.milestone_id));
    if v_doc is null then raise exception 'Raise the invoice for this instalment in Billing first, then confirm the payment' using errcode = '22023'; end if;
    v_pay := erp_payment_add(v_doc, jsonb_build_object('amount', coalesce(nullif(p ->> 'amount', '')::bigint, k.amount), 'receivedOn', coalesce(nullif(p ->> 'receivedOn', ''), k.paid_on::text),
      'method', case when k.method in ('bank', 'upi', 'cheque', 'cash') then k.method else 'other' end, 'reference', coalesce(k.reference, ''),
      'note', left(concat_ws(' · ', 'Client told us in Pulse', v_note), 500)));
    update client_payment_claim set state = 'confirmed', payment_id = v_pay, document_id = coalesce(document_id, v_doc), decided_by = me, decided_at = now(), decided_note = v_note where id = k.id;
    perform cp_emit_client(k.client_id, 'client.payment', 'client_payment', k.id, 'payment:' || k.id, 'Payment received: ' || cp_inr(k.amount) || ' for ' || lower(v_what) || '. Thank you.', '/client#money');
  elsif p_decision = 'not_received' then
    if v_note is null then raise exception 'Tell the client what you see (for example: not in the bank yet)' using errcode = '22023'; end if;
    update client_payment_claim set state = 'not_received', decided_by = me, decided_at = now(), decided_note = v_note where id = k.id;
    perform cp_emit_client(k.client_id, 'client.payment', 'client_payment', k.id, 'payment:' || k.id, 'We could not find your payment of ' || cp_inr(k.amount) || ' yet: ' || v_note, '/client#money');
  else raise exception 'Confirm it, or say it has not arrived' using errcode = '22023'; end if;
  if k.task_id is not null then
    begin perform task_move(k.task_id, 'done', case when p_decision = 'confirmed' then 'Payment confirmed' else 'Not received: ' || v_note end);
    exception when others then null; end;
  end if;
  return cp_claim_json(k.id);
end $$;

-- ------------------------------------------------------------------------------------------------ the client's space, more
-- What PORTAL-2 adds to the client's home (cp_home stays as 1020 made it): deliverables, paying, their claims, their
-- preferences and sign-in address, and timeline lines for these.
create function pulse.cp_more() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_client uuid := cp_my_client(); me uuid := current_viewer(); pr client_portal_pref%rowtype;
begin
  if cp_viewer_conn() is null then raise exception 'This space is for clients of this organisation' using errcode = '42501'; end if;
  select * into pr from client_portal_pref where person_id = me and org_id = current_org();
  return jsonb_build_object(
    'deliverables', cp_deliverables(),
    'pay', cp_pay_info(),
    'claims', coalesce((select jsonb_agg(cp_claim_json(k.id) order by k.created_at desc) from client_payment_claim k
       where k.org_id = current_org() and k.client_id = v_client and k.created_at > now() - interval '180 days'), '[]'::jsonb),
    -- Each package's instalments in cp_home's order, with what paying one needs (its invoice, what is left to pay).
    'instalments', coalesce((select jsonb_object_agg(e.id, coalesce((select jsonb_agg(jsonb_build_object('id', m.id,
        'documentId', case when d.status in ('issued', 'sent', 'part_paid', 'paid') then d.id end,
        'balance', case when d.status in ('issued', 'sent', 'part_paid') then d.total - d.paid - d.credited when d.status = 'paid' then 0 else m.amount end) order by m.position)
        from erp_milestone m left join erp_document d on d.id = m.document_id where m.engagement_id = e.id), '[]'::jsonb))
      from erp_engagement e where e.org_id = current_org() and e.client_id = v_client and e.status <> 'cancelled'), '{}'::jsonb),
    'prefs', jsonb_build_object('tourDone', pr.tour_done_at is not null, 'digest', coalesce(pr.digest, false)),
    'account', cp_account(),
    'unread', (select count(*)::int from notification n where n.org_id = current_org() and n.person_id = me and n.read_at is null and n.dismissed_at is null
       and n.expires_at > now() and notification_authorized(n.id, me)),
    'moreTimeline', coalesce((select jsonb_agg(e) from (
      select jsonb_build_object('at', x.shared_at, 'kind', 'delivery', 'text', 'Shared for your approval: ' || x.title) e from client_deliverable x
        where x.org_id = current_org() and x.client_id = v_client and x.state <> 'withdrawn' and x.shared_at > now() - interval '180 days'
      union all
      select jsonb_build_object('at', x.decided_at, 'kind', 'decision', 'text', coalesce(x.decided_name, 'You') || case x.state when 'approved' then ' approved ' else ' asked for changes to ' end || x.title)
        from client_deliverable x where x.org_id = current_org() and x.client_id = v_client and x.decided_at is not null and x.state in ('approved', 'changes')
      union all
      select jsonb_build_object('at', k.created_at, 'kind', 'payment', 'text', 'You told us you paid ' || cp_inr(k.amount)) from client_payment_claim k
        where k.org_id = current_org() and k.client_id = v_client) z), '[]'::jsonb));
end $$;

create function pulse.cp_pref_set(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); a jsonb;
begin
  if cp_viewer_conn() is null then raise exception 'This space is for clients of this organisation' using errcode = '42501'; end if;
  if (p ->> 'digest')::boolean then
    a := cp_account();
    if a is null or a ->> 'email' is null then raise exception 'Add your e-mail address first' using errcode = '22023'; end if;
  end if;
  insert into client_portal_pref(org_id, person_id) values (current_org(), me) on conflict (person_id) do nothing;
  update client_portal_pref set
    tour_done_at = case when p ? 'tourDone' then case when (p ->> 'tourDone')::boolean then coalesce(tour_done_at, now()) end else tour_done_at end,
    digest = coalesce((p ->> 'digest')::boolean, digest),
    digest_on_at = case when (p ->> 'digest')::boolean and not digest then now() else digest_on_at end,
    updated_at = now()
  where person_id = me and org_id = current_org();
  return (select jsonb_build_object('tourDone', tour_done_at is not null, 'digest', digest) from client_portal_pref where person_id = me and org_id = current_org());
end $$;

-- The daily digest: every client person of this installation's own organisation who turned it on, once a day after
-- 09:00 in the company's time, when something new arrived for them since the last one. Claims them (the caller sends).
create function pulse.cp_digest_due(p_limit int) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o uuid := install_org(); r record; v_out jsonb := '[]'; items jsonb; v_since timestamptz; v_n int := 0;
begin
  if o is null then return v_out; end if;
  perform set_config('pulse.org_id', o::text, true);
  if extract(hour from now() at time zone org_time_zone(o)) < 9 then perform set_config('pulse.org_id', '', true); return v_out; end if;
  for r in select pr.person_id, pr.digest_last_at, pr.digest_on_at, a.id account_id, a.email, p.display_name
      from client_portal_pref pr join person p on p.id = pr.person_id and p.status = 'active'
      join pulse_priv.account_member m on m.person_id = pr.person_id and m.member_org = o
      join pulse_priv.pulse_account a on a.id = m.account_id and a.email is not null
     where pr.org_id = o and pr.digest and (pr.digest_last_at is null or pr.digest_last_at < now() - interval '20 hours')
     order by pr.digest_last_at nulls first loop
    exit when v_n >= greatest(coalesce(p_limit, 20), 1);
    v_since := greatest(coalesce(r.digest_last_at, r.digest_on_at, now() - interval '1 day'), now() - interval '7 days');
    select jsonb_agg(jsonb_build_object('title', n2.title, 'href', n2.href, 'at', n2.created_at) order by n2.created_at desc) into items
      from (select * from notification n1 where n1.org_id = o and n1.person_id = r.person_id and n1.created_at > v_since and n1.read_at is null
             and n1.dismissed_at is null and (n1.event_type like 'client.%' or n1.event_type like 'chat.%') order by n1.created_at desc limit 30) n2
     where notification_authorized(n2.id, r.person_id);
    update client_portal_pref set digest_last_at = now() where person_id = r.person_id;
    if items is null then continue; end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('person', r.person_id, 'to', r.email, 'name', r.display_name, 'org', (select name from org where id = o),
      'replyTo', acct_reply_to(r.account_id), 'items', items));
    v_n := v_n + 1;
  end loop;
  perform set_config('pulse.org_id', '', true);
  return v_out;
end $$;
revoke all on function pulse.cp_digest_due(int) from public;
grant execute on function pulse.cp_digest_due(int) to pulse_api;

-- ------------------------------------------------------------------------------------------------ notifications
select pulse.check_values_add('pulse.notification'::regclass, 'notification_event_type_check', 'event_type',
  array['client.quotation', 'client.invoice', 'client.delivery', 'client.payment', 'client.approved', 'client.changes', 'client.comment', 'client.paid']);
select pulse.check_values_add('pulse.notification'::regclass, 'notification_subject_type_check', 'subject_type', array['client_deliverable', 'client_payment', 'erp_document', 'message']);

-- Who may receive a client.* notice, and a client seat's chat notices (their own conversations only).
create function pulse.cp_notice_allowed(p_person uuid, p_type text, p_subject text, p_id uuid) returns boolean
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if not exists (select 1 from person where org_id = current_org() and id = p_person and status = 'active') then return false; end if;
  if p_type like 'chat.%' then
    return connect_is_seat(p_person) and p_subject = 'message' and exists (select 1 from chat_message m join chat_member cm on cm.channel_id = m.channel_id and cm.org_id = m.org_id
      where m.org_id = current_org() and m.id = p_id and m.removed_at is null and cm.person_id = p_person and m.author_id is distinct from p_person
        and (p_type <> 'chat.mention' or p_person = any(m.mentions)));
  elsif p_type in ('client.quotation', 'client.invoice') then
    return p_subject = 'erp_document' and exists (select 1 from erp_document d where d.org_id = current_org() and d.id = p_id and d.status <> 'cancelled'
      and cp_seat_for(p_person, d.client_id)
      and (exists (select 1 from client_share s where s.org_id = current_org() and s.document_id = d.id and s.withdrawn_at is null)
           or (d.doc_type = 'invoice' and d.status in ('issued', 'sent', 'part_paid', 'paid'))));
  elsif p_type = 'client.delivery' then
    return p_subject = 'client_deliverable' and exists (select 1 from client_deliverable x where x.org_id = current_org() and x.id = p_id and x.state <> 'withdrawn' and cp_seat_for(p_person, x.client_id));
  elsif p_type in ('client.approved', 'client.changes', 'client.comment') then
    return p_subject = 'client_deliverable' and exists (select 1 from client_deliverable x join person p on p.id = p_person and p.side = 'staff'
      where x.org_id = current_org() and x.id = p_id and (x.owner_id = p_person or (p_type <> 'client.comment' and p_person = cp_poc(x.client_id))));
  elsif p_type = 'client.payment' then
    return p_subject = 'client_payment' and exists (select 1 from client_payment_claim k where k.org_id = current_org() and k.id = p_id and cp_seat_for(p_person, k.client_id));
  elsif p_type = 'client.paid' then
    return p_subject = 'client_payment' and exists (select 1 from client_payment_claim k join person p on p.id = p_person and p.side = 'staff'
      where k.org_id = current_org() and k.id = p_id and k.checker_id = p_person and k.state = 'waiting');
  end if;
  return false;
end $$;

-- Preserve every existing branch: the client clause goes in front of the staff-only check (0509's anchor).
do $$
declare definition text; anchor text;
begin
 definition := pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
 anchor := $r$ if not exists(select 1 from person where org_id=current_org() and id=p_person and side='staff' and status='active') then return false;end if;$r$;
 if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
  raise exception 'migration 1066: notification_recipient_allowed changed shape'; end if;
 execute replace(definition, anchor, $r$ -- PORTAL-2 (1066): the client space's notices; a client seat's chats and missed calls.
 if p_type like 'client.%' or (p_type like 'chat.%' and connect_is_seat(p_person)) then return cp_notice_allowed(p_person,p_type,p_subject,p_id);end if;
$r$ || anchor);
end $$;

-- A client seat's chat notice shows in their bell (notification_chat_member_current reads staff memberships only).
do $$
declare definition text; anchor text;
begin
 definition := pg_get_functiondef('pulse.notification_authorized(uuid,uuid)'::regprocedure);
 anchor := '(n.channel_id is null or notification_chat_member_current(n.channel_id,p_person))';
 if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
  raise exception 'migration 1066: notification_authorized changed shape'; end if;
 execute replace(definition, anchor, '(n.channel_id is null or notification_chat_member_current(n.channel_id,p_person) or (connect_is_seat(p_person) and exists(select 1 from chat_member cm where cm.org_id=current_org() and cm.channel_id=n.channel_id and cm.person_id=p_person)))');
end $$;

-- For a client, what arrives in their space needs them: a message from the team in their group, a quotation, an
-- invoice, a deliverable to check (after the policy trigger, which counts group messages as for information).
create function pulse.notification_client_seat() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if new.event_type in ('client.quotation', 'client.invoice', 'client.delivery', 'client.changes', 'client.paid')
     or (new.event_type = 'chat.message' and connect_is_seat(new.person_id)) then
    new.priority := 'needs_you';
    if new.quiet_reason = 'fyi' then new.quiet := false; new.quiet_reason := null; end if;
  end if;
  return new;
end $$;
create trigger notification_zzz_client_seat before insert on pulse.notification for each row execute function pulse.notification_client_seat();

-- A quotation or invoice shared into a client's space, and an invoice issued for a client on Pulse, tell their people.
create function pulse.cp_share_notify() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare d erp_document%rowtype;
begin
  if new.withdrawn_at is not null or (tg_op = 'UPDATE' and old.withdrawn_at is null and old.shared_at = new.shared_at) then return null; end if;
  select * into d from erp_document where id = new.document_id;
  perform cp_emit_client(new.client_id, case when d.doc_type = 'invoice' then 'client.invoice' else 'client.quotation' end, 'erp_document', d.id,
    case when d.doc_type = 'invoice' then 'invoice:' || d.id else 'doc:' || d.id || ':' || extract(epoch from new.shared_at)::bigint end,
    case d.doc_type when 'invoice' then 'Invoice ' || coalesce(d.number, '') || ' for you: ' || cp_inr(d.total)
      when 'proforma' then 'Proforma invoice ' || coalesce(d.number, '') || ' to look at' else 'Quotation ' || coalesce(d.number, '') || ' to look at: ' || cp_inr(d.total) end,
    case when d.doc_type in ('quotation', 'proforma') then '/client#todo' else '/client#money' end);
  return null;
end $$;
create trigger cp_share_notify after insert or update on pulse.client_share for each row execute function pulse.cp_share_notify();

create function pulse.cp_invoice_notify() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if new.doc_type <> 'invoice' or new.client_id is null or new.status not in ('issued', 'sent') or old.status in ('issued', 'sent', 'part_paid', 'paid') then return null; end if;
  perform cp_emit_client(new.client_id, 'client.invoice', 'erp_document', new.id, 'invoice:' || new.id,
    'Invoice ' || coalesce(new.number, '') || ' for you: ' || cp_inr(new.total) || coalesce(', due ' || to_char(new.due_date, 'FMDD Mon'), ''), '/client#money');
  return null;
end $$;
create trigger cp_invoice_notify after update of status on pulse.erp_document for each row execute function pulse.cp_invoice_notify();

-- migrate:down
drop trigger if exists cp_invoice_notify on pulse.erp_document;
drop trigger if exists cp_share_notify on pulse.client_share;
drop trigger if exists notification_zzz_client_seat on pulse.notification;
drop function if exists pulse.cp_invoice_notify(), pulse.cp_share_notify(), pulse.notification_client_seat();
drop table if exists pulse.client_portal_pref, pulse.client_payment_claim, pulse.client_pay_settings, pulse.client_deliverable_comment,
  pulse.client_deliverable_version, pulse.client_deliverable, pulse_priv.cp_file_part, pulse_priv.cp_file, pulse_priv.account_link cascade;
alter table pulse_priv.pulse_account drop column if exists email_confirmed_at;
