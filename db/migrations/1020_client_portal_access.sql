-- migrate:up
-- CLIENT-PORTAL (owner, 25 Oct 2026): "Priority is client login. Clients are their own business on Pulse. Old clients get
-- an opt-in on their assigned client record, plus new accounts for the clients' points of contact. Onboarding a new
-- client must be easy-peasy." Built on ORG (0920) and CONNECT (0953, 0957, 0986): a client company is its own
-- organisation, its people are Pulse accounts with a seat (side client) in the organisation that serves them.
--
--  1. Access from a client record. An admin, HR or leadership presses Invite on one client or on many (nothing is sent
--     on its own): the request carries the client record (connect_request.client_id) and the contact it was made for;
--     accepting it links the new connection to that record (org_connection.client_id). One open link per client: a new
--     invitation replaces the old one. More people of the client join through a "colleague" link on the same
--     connection (connect_request.join_connection): each gets their own account and a seat.
--  2. Opt-in to past conversations: the client says yes on the invitation page or later in their space
--     (org_connection.history_opt_in_at). WA-IMPORT (1015) keeps imported WhatsApp history and an opt-in per
--     client-side person (pulse.client_contact_optin); its reader shows a chat's history to a client-side person who
--     is a member and opted in. Here: inviting a record's contact marks them invited; an account accepting a link made
--     for a contact who is a client-side person here BECOMES that person (their seat), so the history the import tied
--     to them is theirs; the company's yes marks every person of the connection opted in and adds them to the
--     record's imported chats (pulse.cp_history_apply); a no takes them out again.
--  3. The client's space (/client in the web app) is read through the client's seat in the serving organisation:
--     pulse.cp_home() returns their projects and deliveries, what waits on them, their chats, documents shared with
--     them, invoices, contracts, requests and a timeline — only rows of their own client record.
--  4. Quotations are shared into the space (pulse.client_share); the client accepts, asks for changes or declines
--     there. Accepting creates the project (status onboarding) and the client package with its instalments
--     (erp_engagement + erp_milestone, the invoice schedule), and a task for the point of contact.
--  5. Requests from the client become tasks for their point of contact, shared with them (pulse.client_request).
--  6. Onboarding steps a team ticks for a client (pulse.client_onboarding); the rest are read from what happened.
--  7. Calls: a connected organisation's contact rings and is rung in the groups shared with them (0896 widened by
--     one clause, like 0953 widened chats and tasks).
-- Global tables stay owner-only and are reached through SECURITY DEFINER functions that check the viewer's
-- organisation and seat. New tenant tables have the tenant policy, forced RLS and the audit trigger.

-- ------------------------------------------------------------------------------------------------ schema
alter table pulse_priv.connect_request
  add column client_id uuid references pulse.client(id),
  add column contact_person uuid references pulse.person(id),
  add column kind text not null default 'client',
  add column role text,
  add column join_connection uuid references pulse_priv.org_connection(id),
  add column join_home boolean not null default false,
  add column emailed_to text,
  add column emailed_at timestamptz,
  add column opened_at timestamptz;
alter table pulse_priv.connect_request
  add constraint connect_request_kind_check check (kind in ('client', 'vendor', 'partner')),
  add constraint connect_request_role_check check (role is null or length(role) <= 80);
create index connect_request_client on pulse_priv.connect_request(from_org, client_id) where client_id is not null;
create index connect_request_join on pulse_priv.connect_request(join_connection) where join_connection is not null;

alter table pulse_priv.org_connection drop constraint org_connection_kind_check;
alter table pulse_priv.org_connection add constraint org_connection_kind_check check (kind in ('client', 'vendor', 'partner'));
alter table pulse_priv.org_connection
  add column client_id uuid references pulse.client(id),
  add column role text check (role is null or length(role) <= 80),
  add column history_opt_in_at timestamptz,
  add column history_opt_in_by uuid references pulse_priv.pulse_account(id);
create index org_connection_client on pulse_priv.org_connection(a_org, client_id) where client_id is not null;

create table pulse.client_share (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references pulse.org(id),
  client_id      uuid not null references pulse.client(id),
  document_id    uuid not null references pulse.erp_document(id) on delete cascade,
  note           text check (note is null or length(note) <= 1000),
  shared_by      uuid references pulse.person(id),
  shared_at      timestamptz not null default now(),
  seen_at        timestamptz,
  decision       text check (decision in ('accepted', 'changes', 'declined')),
  decided_by     uuid references pulse.person(id),
  decided_name   text check (decided_name is null or length(decided_name) <= 120),
  decided_at     timestamptz,
  decision_note  text check (decision_note is null or length(decision_note) <= 2000),
  project_id     uuid references pulse.project(id),
  engagement_id  uuid references pulse.erp_engagement(id),
  withdrawn_at   timestamptz,
  unique (org_id, document_id)
);
create index client_share_client on pulse.client_share(org_id, client_id);

create table pulse.client_request (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references pulse.org(id),
  connection_id  uuid not null references pulse_priv.org_connection(id),
  client_id      uuid references pulse.client(id),
  task_id        uuid references pulse.task(id),
  kind           text not null check (kind in ('request', 'change', 'question', 'problem')),
  title          text not null check (length(btrim(title)) between 2 and 200),
  body           text check (body is null or length(body) <= 4000),
  created_by     uuid not null references pulse.person(id),
  created_at     timestamptz not null default now()
);
create index client_request_conn on pulse.client_request(org_id, connection_id, created_at desc);

create table pulse.client_onboarding (
  org_id     uuid not null references pulse.org(id),
  client_id  uuid not null references pulse.client(id),
  step       text not null check (step in ('welcome', 'team', 'kickoff', 'first_chat', 'first_call')),
  done_at    timestamptz not null default now(),
  done_by    uuid references pulse.person(id),
  primary key (org_id, client_id, step)
);

do $$ declare t text; begin
  foreach t in array array['client_share', 'client_request', 'client_onboarding'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('create trigger audit_mutation after insert or update or delete on pulse.%I for each row execute function pulse.audit_mutation()', t);
  end loop;
end $$;

-- ------------------------------------------------------------------------------------------------ helpers
-- Who may manage clients' access: the people who send client requests (0953).
create function pulse.cp_admin() returns void
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is null or not exists (select 1 from person where id = current_viewer() and org_id = current_org() and side = 'staff' and status = 'active')
     or not viewer_is('admin', 'leadership', 'hr') then
    raise exception 'Admins, HR and leadership manage client access' using errcode = '42501'; end if;
end $$;

-- The connection through which the viewer is a client of this organisation (their seat here), or null.
create function pulse.cp_viewer_conn() returns uuid
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select c.id from pulse_priv.connect_seat s join pulse_priv.org_connection c on c.id = s.connection_id and c.status = 'active'
   where s.seat_person = current_viewer() and s.seat_org = current_org() and s.removed_at is null
     and exists (select 1 from person where id = current_viewer() and org_id = current_org() and status = 'active')
     and ((c.kind in ('client', 'partner') and c.a_org = current_org()) or (c.kind = 'vendor' and c.b_org = current_org()))
   order by (c.client_id is not null) desc, c.created_at desc limit 1
$$;

-- When a client opted in to seeing past conversations (imported history) with this organisation, or null. For WA-IMPORT.
create function pulse.client_history_opt_in(p_client uuid) returns timestamptz
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select max(history_opt_in_at) from pulse_priv.org_connection where a_org = current_org() and client_id = p_client and status = 'active'
$$;

-- A client record's access to Pulse as the serving organisation sees it.
create function pulse.client_access_state(p_client uuid) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare c pulse_priv.org_connection%rowtype; q pulse_priv.connect_request%rowtype;
begin
  select * into c from pulse_priv.org_connection where a_org = current_org() and client_id = p_client and status = 'active' order by created_at desc limit 1;
  if c.id is not null then
    return jsonb_build_object('state', 'joined', 'connectionId', c.id, 'joinedAt', c.created_at, 'role', c.role, 'historyOptIn', c.history_opt_in_at,
      'org', (select jsonb_build_object('name', name, 'handle', handle) from org where id = c.b_org),
      'people', coalesce((select jsonb_agg(jsonb_build_object('seat', s.id, 'person', s.seat_person, 'name', p.display_name, 'handle', a.handle, 'email', a.email, 'since', s.created_at) order by s.created_at)
        from pulse_priv.connect_seat s join person p on p.id = s.seat_person join pulse_priv.pulse_account a on a.id = s.account_id
        where s.connection_id = c.id and s.seat_org = current_org() and s.removed_at is null), '[]'::jsonb),
      'team', coalesce((select jsonb_agg(jsonb_build_object('seat', s.id, 'person', s.home_person, 'name', p.display_name) order by s.created_at)
        from pulse_priv.connect_seat s join person p on p.id = s.home_person
        where s.connection_id = c.id and s.home_org = current_org() and s.removed_at is null), '[]'::jsonb),
      'waiting', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.contact_name, 'email', r.contact_email, 'at', r.created_at, 'emailedAt', r.emailed_at,
          'expired', r.expires_at <= now()) order by r.created_at desc)
        from pulse_priv.connect_request r where r.join_connection = c.id and r.status = 'open'), '[]'::jsonb));
  end if;
  select * into q from pulse_priv.connect_request where from_org = current_org() and client_id = p_client and join_connection is null order by created_at desc limit 1;
  if q.id is null then return jsonb_build_object('state', 'none'); end if;
  return jsonb_build_object('state', case when q.status = 'open' and q.expires_at > now() then 'invited' when q.status = 'open' then 'expired'
      when q.status = 'revoked' then 'withdrawn' else 'ended' end,
    'requestId', q.id, 'invitedAt', q.created_at, 'invitedBy', (select display_name from person where id = q.created_by), 'contact', q.contact_name,
    'email', q.contact_email, 'phone', q.contact_phone, 'emailedTo', q.emailed_to, 'emailedAt', q.emailed_at, 'openedAt', q.opened_at, 'expiresAt', q.expires_at,
    'poc', (select display_name from person where id = q.poc_person));
end $$;

-- A client record's contacts as invitation choices: their e-mail and phone, WA-IMPORT's opt-in state, and whether
-- someone already signs in as them.
create function pulse.client_access_contacts(p_client uuid) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', pe.id, 'name', pe.display_name, 'email', cq.email, 'phone', cq.phone, 'primary', coalesce(cc.is_primary, false),
      'side', pe.side, 'optin', o.state, 'onPulse', exists (select 1 from pulse_priv.account_member m where m.member_org = current_org() and m.person_id = pe.id))
      order by cc.is_primary desc nulls last, pe.display_name), '[]'::jsonb)
  from client_contact cc join person pe on pe.id = cc.person_id and pe.org_id = current_org() left join contact_profile cq on cq.person_id = pe.id
  left join client_contact_optin o on o.org_id = current_org() and o.person_id = pe.id
  where cc.client_id = p_client and pe.status = 'active' and viewer_is('admin', 'leadership', 'hr')
$$;

-- Every client record with its access, for the "Pulse access" list (admins, HR, leadership).
create function pulse.client_access_list() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  perform cp_admin();
  return coalesce((select jsonb_agg(x order by lower(x ->> 'name')) from (
    select jsonb_build_object('id', c.id, 'name', c.display_name, 'company', c.company_name, 'type', c.client_type, 'status', c.status, 'city', c.city,
      'contact', case when pc.id is null then null else jsonb_build_object('id', pc.id, 'name', pc.display_name, 'email', cp.email, 'phone', cp.phone) end,
      'email', c.email, 'phone', c.phone,
      'contacts', client_access_contacts(c.id),
      'owner', (select jsonb_build_object('id', o.id, 'name', o.display_name) from person o where o.id = c.relationship_owner_id),
      'projects', (select count(*)::int from project p where p.client_id = c.id and p.deleted_at is null),
      'lastMonth', (select to_char(max(p.start_month), 'YYYY-MM') from project p where p.client_id = c.id and p.deleted_at is null),
      'access', client_access_state(c.id)) x
    from client c left join person pc on pc.id = c.primary_contact_id left join contact_profile cp on cp.person_id = pc.id
    where c.org_id = current_org()
      and not exists (select 1 from record_merge m where m.entity_type = 'client' and m.gone_id = c.id and m.undone_at is null)) s), '[]'::jsonb);
end $$;

-- ------------------------------------------------------------------------------------------------ inviting
-- Invite a client record to Pulse: a client request pre-filled from the record (company, contact, e-mail, phone, the
-- latest project) with its point of contact (given, else the relationship owner, else the inviter). Replaces an open
-- invitation of the same client. The caller makes the token, shows the link and, only when asked, e-mails it.
create function pulse.client_invite(p_client uuid, p jsonb, p_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c client%rowtype; v_contact uuid; v_name text; v_email text; v_phone text; v_poc uuid; v_id uuid; v_project text; v_company text;
  mail constant text := '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';
begin
  perform cp_admin();
  select * into c from client where id = p_client and org_id = current_org();
  if not found then raise exception 'Client not found' using errcode = 'P0002'; end if;
  if exists (select 1 from pulse_priv.org_connection where a_org = current_org() and client_id = p_client and status = 'active') then
    raise exception '% is already on Pulse: add a person to their access instead', c.display_name using errcode = '23505'; end if;
  v_contact := coalesce(nullif(p ->> 'contactId', '')::uuid, c.primary_contact_id);
  if v_contact is not null and v_contact is distinct from c.primary_contact_id
     and not exists (select 1 from client_contact where client_id = p_client and person_id = v_contact) then
    raise exception 'Choose one of this client''s contacts' using errcode = '22023'; end if;
  select pe.display_name, lower(nullif(btrim(cp.email), '')), nullif(btrim(cp.phone), '') into v_name, v_email, v_phone
    from person pe left join contact_profile cp on cp.person_id = pe.id where pe.id = v_contact and pe.org_id = current_org();
  v_name := left(coalesce(nullif(btrim(p ->> 'contact'), ''), v_name, c.display_name), 120);
  v_email := coalesce(nullif(lower(btrim(p ->> 'email')), ''), v_email, lower(nullif(btrim(c.email), '')));
  if v_email is not null and v_email !~ mail then
    if nullif(btrim(p ->> 'email'), '') is not null then raise exception 'Give a valid e-mail or leave it empty' using errcode = '22023'; end if;
    v_email := null;
  end if;
  v_phone := left(coalesce(nullif(btrim(p ->> 'phone'), ''), v_phone, nullif(btrim(c.phone), '')), 40);
  v_poc := coalesce(nullif(p ->> 'poc', '')::uuid,
    (select id from person where id = c.relationship_owner_id and org_id = current_org() and side = 'staff' and status = 'active'), current_viewer());
  if not exists (select 1 from person where id = v_poc and org_id = current_org() and side = 'staff' and status = 'active') then
    raise exception 'Choose a point of contact from your team' using errcode = '22023'; end if;
  v_company := left(btrim(coalesce(nullif(btrim(c.company_name), ''), c.display_name)), 80);
  if length(v_company) < 2 then v_company := rpad(v_company, 2, '.'); end if;
  if length(btrim(v_name)) < 2 then v_name := v_company; end if;
  select coalesce(title, name) into v_project from project where client_id = p_client and org_id = current_org() and deleted_at is null
   order by coalesce(starts_on, start_month) desc nulls last limit 1;
  update pulse_priv.connect_request set status = 'revoked'
   where from_org = current_org() and client_id = p_client and status = 'open' and join_connection is null;
  insert into pulse_priv.connect_request(from_org, token_hash, company_name, contact_name, contact_email, contact_phone, project, summary, poc_person, created_by,
    client_id, contact_person, kind, role)
  values (current_org(), p_hash, v_company, v_name, v_email, v_phone, left(coalesce(nullif(btrim(p ->> 'project'), ''), v_project), 160),
    nullif(left(btrim(coalesce(p ->> 'message', '')), 2000), ''), v_poc, current_viewer(), p_client, v_contact, 'client',
    nullif(left(btrim(coalesce(p ->> 'role', '')), 80), ''))
  returning id into v_id;
  perform audit_write('invite', 'connect_request', v_id::text);
  -- WA-IMPORT's opt-in record of this contact (when the import made one): invited now.
  update client_contact_optin set state = 'invited', invited_at = now(), updated_at = now()
   where org_id = current_org() and person_id = v_contact and state in ('pending', 'declined', 'revoked');
  return jsonb_build_object('id', v_id, 'clientId', p_client, 'client', c.display_name, 'company', v_company, 'contact', v_name, 'email', v_email, 'phone', v_phone,
    'org', (select name from org where id = current_org()), 'poc', (select display_name from person where id = v_poc));
end $$;

-- One more person at a client that is already on Pulse: their own link on the same connection. From the serving
-- organisation (admins, HR, leadership) the person gets a seat here; from the client's space (p_from_space) the
-- client's own admins also make them a member of the client's organisation.
create function pulse.client_person_invite(p_conn uuid, p jsonb, p_hash text, p_from_space boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k pulse_priv.org_connection%rowtype; v_id uuid; v_name text := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g');
  v_email text := nullif(lower(btrim(coalesce(p ->> 'email', ''))), ''); v_client_org uuid; v_home boolean := false; v_acct uuid; v_company text; v_poc uuid; v_contact uuid;
begin
  select * into k from pulse_priv.org_connection where id = p_conn and status = 'active';
  if not found then raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if p_from_space then
    if cp_viewer_conn() is distinct from p_conn then raise exception 'Only your own space' using errcode = '42501'; end if;
  else
    perform cp_admin();
    if current_org() is distinct from (case when k.kind = 'vendor' then k.b_org else k.a_org end) then raise exception 'Connection not found' using errcode = 'P0002'; end if;
  end if;
  if length(v_name) not between 2 and 120 then raise exception 'Give the person''s name' using errcode = '22023'; end if;
  if v_email is not null and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Give a valid e-mail or leave it empty' using errcode = '22023'; end if;
  v_client_org := case when k.kind = 'vendor' then k.a_org else k.b_org end;
  if p_from_space and v_client_org is not null then
    v_acct := account_of_viewer();
    select exists (select 1 from pulse_priv.account_member m where m.account_id = v_acct and m.member_org = v_client_org and m.kind = 'staff') into v_home;
    if v_home then
      perform acct_enter(v_client_org, (select person_id from pulse_priv.account_member where account_id = v_acct and member_org = v_client_org));
      v_home := viewer_is('admin', 'leadership');
      perform acct_leave();
    end if;
  end if;
  v_company := left(coalesce((select name from org where id = v_client_org), (select display_name from client where id = k.client_id), 'Client'), 80);
  if length(v_company) < 2 then v_company := rpad(v_company, 2, '.'); end if;
  v_poc := coalesce((select s.home_person from pulse_priv.connect_seat s where s.connection_id = k.id and s.home_org = current_org() and s.removed_at is null order by s.created_at limit 1),
    (select poc_person from pulse_priv.connect_request where id = k.request_id));
  if v_poc is null then raise exception 'This connection has no point of contact here' using errcode = '22023'; end if;
  v_contact := nullif(p ->> 'contactId', '')::uuid;
  if v_contact is not null and (p_from_space or k.client_id is null
     or not exists (select 1 from client_contact cc join person pe on pe.id = cc.person_id where cc.client_id = k.client_id and cc.person_id = v_contact and pe.org_id = current_org())) then
    raise exception 'Choose one of this client''s contacts' using errcode = '22023'; end if;
  insert into pulse_priv.connect_request(from_org, token_hash, company_name, contact_name, contact_email, contact_phone, project, summary, poc_person, created_by,
    client_id, kind, role, join_connection, join_home, contact_person)
  values (current_org(), p_hash, v_company, v_name, v_email, nullif(left(btrim(coalesce(p ->> 'phone', '')), 40), ''), null,
    nullif(left(btrim(coalesce(p ->> 'message', '')), 2000), ''), v_poc, current_viewer(), k.client_id, k.kind, k.role, k.id, v_home, v_contact)
  returning id into v_id;
  perform audit_write('invite', 'connect_request', v_id::text);
  update client_contact_optin set state = 'invited', invited_at = now(), updated_at = now()
   where org_id = current_org() and person_id = v_contact and state in ('pending', 'declined', 'revoked');
  return jsonb_build_object('id', v_id, 'company', v_company, 'contact', v_name, 'email', v_email, 'org', (select name from org where id = current_org()),
    'poc', (select display_name from person where id = v_poc), 'joinsOrg', v_home);
end $$;

-- The link was e-mailed (by the API, after a person asked for it).
create function pulse.client_invite_emailed(p_request uuid, p_to text) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  update pulse_priv.connect_request set emailed_to = left(lower(p_to), 254), emailed_at = now()
   where id = p_request and (from_org = current_org()) and status = 'open';
end $$;

-- Withdraw a client's open invitation or colleague link.
create function pulse.client_invite_revoke(p_request uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if cp_viewer_conn() is not null then
    update pulse_priv.connect_request set status = 'revoked' where id = p_request and from_org = current_org() and created_by = current_viewer() and status = 'open';
    return;
  end if;
  perform cp_admin();
  update pulse_priv.connect_request set status = 'revoked' where id = p_request and from_org = current_org() and status = 'open';
end $$;

-- An account takes the place of a client-side person the serving organisation already has (made from a contact or by
-- the WhatsApp import): it becomes that person's account there, so the seat reuses the person and what is tied to them.
-- Only a side 'client' person nobody has claimed; anyone else gets a new seat person as before.
create function pulse.cp_bind_contact(p_account uuid, p_org uuid, p_person uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a pulse_priv.pulse_account%rowtype; v_no int; v_user text; n int := 1;
begin
  if p_person is null or p_account is null then return; end if;
  if exists (select 1 from pulse_priv.account_member where account_id = p_account and member_org = p_org)
     or exists (select 1 from pulse_priv.account_member where member_org = p_org and person_id = p_person) then return; end if;
  perform acct_enter(p_org, null);
  if not exists (select 1 from person where id = p_person and org_id = p_org and side = 'client') then perform acct_leave(); return; end if;
  select * into a from pulse_priv.pulse_account where id = p_account;
  if not exists (select 1 from people_profile where person_id = p_person) then
    select coalesce(max(user_no), 0) + 1 into v_no from people_profile where org_id = p_org;
    v_user := a.handle;
    while exists (select 1 from people_profile where org_id = p_org and username = v_user) loop n := n + 1; v_user := a.handle || '.' || n; end loop;
    insert into people_profile(org_id, person_id, role, email, username, user_no, evidence, field_sources)
    values (p_org, p_person, 'Client contact', a.email, v_user, v_no, 'Client contact who joined Pulse (@' || a.handle || ')', '{}');
  end if;
  update person set status = 'active' where id = p_person and org_id = p_org and status <> 'active';
  perform acct_leave();
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (p_account, p_org, p_person, 'client');
end $$;

-- The connection's answer about past conversations, applied to each of its people at the serving organisation:
-- opted in (WA-IMPORT's record) and members of the client record's imported chats, or revoked and out of them.
create function pulse.cp_history_apply(p_conn uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k pulse_priv.org_connection%rowtype; v_provider uuid; s record; v_on boolean;
begin
  select * into k from pulse_priv.org_connection where id = p_conn;
  if k.id is null or k.client_id is null then return; end if;
  v_provider := case when k.kind = 'vendor' then k.b_org else k.a_org end;
  v_on := k.history_opt_in_at is not null and k.status = 'active';
  perform acct_enter(v_provider, null);
  for s in select seat_person, removed_at from pulse_priv.connect_seat where connection_id = k.id and seat_org = v_provider loop
    if v_on and s.removed_at is null then
      insert into client_contact_optin(org_id, person_id, client_id, state, scope, source, invited_at, answered_at)
      values (v_provider, s.seat_person, k.client_id, 'opted_in', '{chat_history,portal}', 'client_portal', now(), now())
      on conflict (org_id, person_id) do update set state = 'opted_in', scope = '{chat_history,portal}', answered_at = now(), updated_at = now(),
        client_id = coalesce(client_contact_optin.client_id, excluded.client_id);
      insert into chat_member(org_id, channel_id, person_id)
      select v_provider, w.channel_id, s.seat_person from pulse_priv.wa_chat w
       where w.org_id = v_provider and (w.client_id = k.client_id
         or exists (select 1 from pulse_priv.wa_participant pa where pa.org_id = w.org_id and pa.chat_id = w.id and pa.person_id = s.seat_person))
      on conflict do nothing;
    else
      update client_contact_optin set state = 'revoked', answered_at = now(), updated_at = now()
       where org_id = v_provider and person_id = s.seat_person and state = 'opted_in';
      delete from chat_member where org_id = v_provider and person_id = s.seat_person
        and channel_id in (select w.channel_id from pulse_priv.wa_chat w where w.org_id = v_provider);
    end if;
  end loop;
  perform acct_leave();
end $$;

-- ------------------------------------------------------------------------------------------------ the invitation page
-- 0953's peek, plus what this invitation is (a client record's access, a colleague link), the past-conversations offer,
-- and the first time it was opened (shown to the inviter).
create or replace function pulse.connect_peek(p_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare q pulse_priv.connect_request%rowtype; o org%rowtype; k pulse_priv.org_connection%rowtype;
begin
  select * into q from pulse_priv.connect_request where token_hash = p_hash and status = 'open' and expires_at > now();
  if not found then return null; end if;
  select * into o from org where id = q.from_org and status = 'active';
  if not found then return null; end if;
  if q.opened_at is null then update pulse_priv.connect_request set opened_at = now() where id = q.id; end if;
  if q.join_connection is not null then select * into k from pulse_priv.org_connection where id = q.join_connection and status = 'active';
    if k.id is null then return null; end if; end if;
  return jsonb_build_object('from', o.name, 'fromHandle', o.handle, 'company', q.company_name, 'contact', q.contact_name, 'email', q.contact_email,
    'phone', q.contact_phone, 'project', q.project, 'summary', q.summary, 'poc', (select display_name from person where id = q.poc_person),
    'handleSuggestion', handle_suggest(q.company_name), 'kind', q.kind, 'role', q.role, 'client', q.client_id is not null,
    'colleague', q.join_connection is not null,
    'joinsOrg', case when q.join_connection is not null and q.join_home then (select name from org where id = case when k.kind = 'vendor' then k.a_org else k.b_org end) end,
    'historyOffer', q.client_id is not null and (k.id is null or k.history_opt_in_at is null));
end $$;

-- 0953's accept, plus: a colleague link adds the person to the existing connection; a client record's request links
-- the connection to the record (kind, role, record, opt-in); a client lands in their space at the serving organisation.
create or replace function pulse.connect_accept_core(p_account uuid, p_request uuid, p jsonb, p_new_account boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare q pulse_priv.connect_request%rowtype; v_mode text := coalesce(p ->> 'mode', 'new'); v_org uuid; v_conn uuid; v_new_org boolean := false;
  v_poc uuid; v_home uuid; v_from_name text; v_client_name text; ok boolean; k pulse_priv.org_connection%rowtype; v_provider uuid; v_client_org uuid;
  a pulse_priv.pulse_account%rowtype; v_no int; v_user text; n int := 1; v_opt boolean := coalesce(p ->> 'history', '') = 'yes'; v_land uuid; v_home_path text;
begin
  select * into q from pulse_priv.connect_request where id = p_request for update;
  if not found or q.status <> 'open' or q.expires_at <= now() then raise exception 'This client link is no longer open. Ask for a new one.' using errcode = '22023'; end if;

  if q.join_connection is not null then
    select * into k from pulse_priv.org_connection where id = q.join_connection and status = 'active' for update;
    if not found then raise exception 'This connection has ended. Ask for a new link.' using errcode = '22023'; end if;
    v_provider := case when k.kind = 'vendor' then k.b_org else k.a_org end;
    v_client_org := case when k.kind = 'vendor' then k.a_org else k.b_org end;
    if exists (select 1 from pulse_priv.account_member where account_id = p_account and member_org = v_provider and kind not in ('client', 'partner')) then
      raise exception 'You are on the team of %: send this link to the person it is for', (select name from org where id = v_provider) using errcode = '42501'; end if;
    if not exists (select 1 from pulse_priv.connect_seat where connection_id = k.id and account_id = p_account and removed_at is null) then
      if v_client_org is not null then
        select person_id into v_home from pulse_priv.account_member where account_id = p_account and member_org = v_client_org;
        if v_home is null and q.join_home then
          select * into a from pulse_priv.pulse_account where id = p_account;
          perform acct_enter(v_client_org, null);
          insert into person(org_id, display_name, side, status, active_from) values (v_client_org, a.display_name, 'staff', 'active', current_date) returning id into v_home;
          select coalesce(max(user_no), 0) + 1 into v_no from people_profile where org_id = v_client_org;
          v_user := a.handle;
          while exists (select 1 from people_profile where org_id = v_client_org and username = v_user) loop n := n + 1; v_user := a.handle || '.' || n; end loop;
          insert into people_profile(org_id, person_id, role, email, username, user_no, evidence, field_sources)
          values (v_client_org, v_home, 'Member', a.email, v_user, v_no, 'Joined from a colleague invitation (@' || a.handle || ')', '{}');
          perform acct_leave();
          insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (p_account, v_client_org, v_home, 'staff');
        end if;
      end if;
      perform cp_bind_contact(p_account, v_provider, q.contact_person);
      perform connect_seat_make(k.id, p_account, case when v_home is null then null else v_client_org end, v_home, v_provider, 'client',
        'Client · ' || coalesce((select name from org where id = v_client_org), q.company_name));
    end if;
    update pulse_priv.connect_request set status = 'accepted', accepted_account = p_account, accepted_at = now(), connection_id = k.id where id = q.id;
    if v_opt and k.history_opt_in_at is null and q.client_id is not null then
      update pulse_priv.org_connection set history_opt_in_at = now(), history_opt_in_by = p_account where id = k.id; end if;
    perform cp_history_apply(k.id);
    return jsonb_build_object('connection', k.id, 'org', v_provider, 'newOrg', false, 'home', '/client');
  end if;

  if exists (select 1 from pulse_priv.account_member where account_id = p_account and member_org = q.from_org and kind not in ('client', 'partner')) then
    raise exception 'You are on the team of the organisation that sent this link: send it to the client instead' using errcode = '42501'; end if;
  if q.client_id is not null and exists (select 1 from pulse_priv.org_connection where a_org = q.from_org and client_id = q.client_id and status = 'active') then
    raise exception 'Your company is already connected: ask your contact for a colleague link' using errcode = '23505'; end if;
  select name into v_from_name from org where id = q.from_org;
  if v_mode = 'new' then
    v_org := connect_org_create(p_account, coalesce(nullif(btrim(p ->> 'orgName'), ''), q.company_name), p ->> 'orgHandle', p -> 'pack');
    v_new_org := true;
  elsif v_mode = 'existing' then
    v_org := nullif(p ->> 'org', '')::uuid;
    select m.person_id into v_home from pulse_priv.account_member m where m.account_id = p_account and m.member_org = v_org and m.kind = 'staff';
    if v_home is null then raise exception 'Choose one of your organisations' using errcode = '42501'; end if;
    if v_org = q.from_org then raise exception 'That is the organisation that invited you' using errcode = '22023'; end if;
    perform acct_enter(v_org, v_home);
    ok := viewer_is('admin', 'leadership');
    perform acct_leave();
    if not ok then raise exception 'Only an admin or leader of that organisation connects it' using errcode = '42501'; end if;
    if exists (select 1 from pulse_priv.org_connection where a_org = q.from_org and b_org = v_org and status = 'active') then
      raise exception 'Your organisation is already connected with %', v_from_name using errcode = '23505'; end if;
  elsif v_mode = 'individual' then v_org := null;
  else raise exception 'Choose how you join' using errcode = '22023'; end if;
  select name into v_client_name from org where id = v_org;
  insert into pulse_priv.org_connection(a_org, b_org, b_account, request_id, kind, role, client_id, history_opt_in_at, history_opt_in_by)
  values (q.from_org, v_org, case when v_org is null then p_account end, q.id, q.kind, q.role, q.client_id,
    case when v_opt and q.client_id is not null then now() end, case when v_opt and q.client_id is not null then p_account end)
  returning id into v_conn;
  v_home := (select person_id from pulse_priv.account_member where account_id = p_account and member_org = v_org);
  -- The invited side's seat in the inviting organisation (the record's contact person there, when it is unclaimed).
  perform cp_bind_contact(p_account, q.from_org, q.contact_person);
  perform connect_seat_make(v_conn, p_account, v_org, v_home, q.from_org, 'client',
    case q.kind when 'vendor' then 'Vendor · ' when 'partner' then 'Partner · ' else 'Client · ' end || coalesce(v_client_name, q.company_name));
  -- The inviting organisation's point of contact's seat in the invited organisation.
  if v_org is not null then
    v_poc := connect_account_of(q.from_org, q.poc_person);
    if v_poc = p_account then raise exception 'You are this link''s point of contact: send it to the client instead' using errcode = '42501'; end if;
    perform connect_seat_make(v_conn, v_poc, q.from_org, q.poc_person, v_org, 'partner',
      v_from_name || case q.kind when 'vendor' then ' · client contact' else ' · point of contact' end);
  end if;
  update pulse_priv.connect_request set status = 'accepted', accepted_account = p_account, accepted_at = now(), connection_id = v_conn where id = q.id;
  insert into pulse_priv.org_referral(referrer_org, referred_org, referred_account, request_id, new_org, new_account)
  values (q.from_org, v_org, p_account, q.id, v_new_org, p_new_account);
  perform cp_history_apply(v_conn);
  -- A client opens their space at the organisation that serves them; others their own organisation's connections.
  if q.kind = 'client' then v_land := q.from_org; v_home_path := '/client';
  else v_land := coalesce(v_org, q.from_org); v_home_path := '/connections'; end if;
  return jsonb_build_object('connection', v_conn, 'org', v_land, 'newOrg', v_new_org, 'home', v_home_path, 'ownOrg', v_org);
end $$;

-- 0953's accept and join, answering also where the person lands (their space for a client).
create or replace function pulse.connect_accept(p_link text, p jsonb, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure(); q uuid; r jsonb;
begin
  select id into q from pulse_priv.connect_request where token_hash = p_link;
  if q is null then raise exception 'This client link is no longer open. Ask for a new one.' using errcode = '22023'; end if;
  r := connect_accept_core(v, q, p, false);
  return acct_session(v, (r ->> 'org')::uuid, p_hash, p_device) || jsonb_build_object('connection', r -> 'connection', 'newOrg', r -> 'newOrg', 'home', r -> 'home');
end $$;

create or replace function pulse.connect_join(p_link text, p jsonb, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare q uuid; v uuid; h text := lower(ltrim(btrim(coalesce(p ->> 'handle', '')), '@')); e text := nullif(lower(btrim(coalesce(p ->> 'email', ''))), '');
  n text := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'); r jsonb;
begin
  select id into q from pulse_priv.connect_request where token_hash = p_link and status = 'open' and expires_at > now();
  if q is null then raise exception 'This client link is no longer open. Ask for a new one.' using errcode = '22023'; end if;
  if length(n) not between 2 and 120 then raise exception 'Give your name' using errcode = '22023'; end if;
  if h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then raise exception 'Your handle is 3 to 30 lower-case letters, digits, dots or underscores' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h) then raise exception 'Someone already has @%', h using errcode = '23505'; end if;
  if e is not null and e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Give a valid e-mail or leave it empty' using errcode = '22023'; end if;
  if e is not null and exists (select 1 from pulse_priv.pulse_account where email = e) then raise exception 'That e-mail already has a Pulse account: sign in instead' using errcode = '23505'; end if;
  insert into pulse_priv.pulse_account(handle, display_name, email, password_hash) values (h, n, e, crypt(p ->> 'password', gen_salt('bf', 10))) returning id into v;
  insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', v);
  r := connect_accept_core(v, q, p, true);
  return acct_session(v, (r ->> 'org')::uuid, p_hash, p_device) || jsonb_build_object('connection', r -> 'connection', 'newOrg', r -> 'newOrg', 'home', r -> 'home');
end $$;

-- The client says yes to past conversations from their space.
create function pulse.cp_history_opt_in(p_yes boolean) returns timestamptz
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := cp_viewer_conn(); r timestamptz;
begin
  if v is null then raise exception 'This is for clients of this organisation' using errcode = '42501'; end if;
  update pulse_priv.org_connection set history_opt_in_at = case when p_yes then coalesce(history_opt_in_at, now()) end,
    history_opt_in_by = case when p_yes then coalesce(history_opt_in_by, account_of_viewer()) end
   where id = v returning history_opt_in_at into r;
  perform cp_history_apply(v);
  perform audit_write('update', 'org_connection.history', v::text);
  return r;
end $$;

-- ------------------------------------------------------------------------------------------------ the client's space
-- Everything a client sees of this organisation, in one read. Only their own client record's rows; their chats and
-- tasks follow the usual membership rules.
create function pulse.cp_home() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k pulse_priv.org_connection%rowtype; me uuid := current_viewer(); v_client uuid; v_client_org uuid; v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select * into k from pulse_priv.org_connection where id = cp_viewer_conn();
  if k.id is null then raise exception 'This space is for clients of this organisation' using errcode = '42501'; end if;
  v_client := k.client_id;
  v_client_org := case when k.kind = 'vendor' then k.a_org else k.b_org end;
  return jsonb_build_object(
    'provider', (select jsonb_build_object('name', o.name, 'handle', o.handle, 'code', o.code) from org o where o.id = current_org()),
    'role', k.role, 'kind', k.kind, 'connection', k.id, 'since', k.created_at,
    'client', jsonb_build_object('name', coalesce((select name from org where id = v_client_org), (select display_name from client where id = v_client)), 'org', v_client_org, 'record', v_client is not null),
    'me', jsonb_build_object('id', me, 'name', (select display_name from person where id = me)),
    'historyOffer', v_client is not null, 'historyOptIn', k.history_opt_in_at,
    'team', coalesce((select jsonb_agg(jsonb_build_object('person', s.home_person, 'name', p.display_name, 'role', nullif(pp.role, '')) order by s.created_at)
      from pulse_priv.connect_seat s join person p on p.id = s.home_person left join people_profile pp on pp.person_id = p.id
      where s.connection_id = k.id and s.home_org = current_org() and s.removed_at is null), '[]'::jsonb),
    'colleagues', coalesce((select jsonb_agg(jsonb_build_object('person', s.seat_person, 'name', p.display_name, 'me', s.seat_person = me) order by s.created_at)
      from pulse_priv.connect_seat s join person p on p.id = s.seat_person
      where s.connection_id = k.id and s.seat_org = current_org() and s.removed_at is null), '[]'::jsonb),
    'invited', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.contact_name, 'at', r.created_at) order by r.created_at desc)
      from pulse_priv.connect_request r where r.join_connection = k.id and r.status = 'open' and r.expires_at > now()), '[]'::jsonb),
    'chats', coalesce((select jsonb_agg(x order by x ->> 'lastAt' desc nulls last) from (
      select jsonb_build_object('id', ch.id, 'name', ch.name, 'kind', ch.kind,
        'lastAt', (select max(m.created_at) from chat_message m where m.channel_id = ch.id and m.removed_at is null),
        'last', (select left(m.body, 140) from chat_message m where m.channel_id = ch.id and m.removed_at is null and m.kind = 'text' order by m.created_at desc limit 1),
        'lastBy', (select p.display_name from chat_message m join person p on p.id = m.author_id where m.channel_id = ch.id and m.removed_at is null and m.kind = 'text' order by m.created_at desc limit 1),
        'unread', (select count(*)::int from chat_message m where m.channel_id = ch.id and m.removed_at is null and m.created_at > cm.read_through and m.author_id is distinct from me)) x
      from chat_member cm join chat_channel ch on ch.id = cm.channel_id and ch.org_id = cm.org_id
      where cm.person_id = me and cm.org_id = current_org() and cm.archived_at is null) s), '[]'::jsonb),
    'projects', case when v_client is null then '[]'::jsonb else coalesce((select jsonb_agg(x) from (
      select jsonb_build_object('id', p.id, 'title', coalesce(p.title, p.name), 'status', p.status, 'location', p.location,
        'startsOn', to_char(coalesce(p.starts_on, p.start_month), 'YYYY-MM-DD'), 'endsOn', to_char(p.ends_on, 'YYYY-MM-DD'),
        'deliveries', (select count(*)::int from delivery d where d.project_id = p.id and d.org_id = current_org()),
        'lastDeliveredAt', (select max(d.delivered_at) from delivery d where d.project_id = p.id and d.org_id = current_org()),
        'latest', coalesce((select jsonb_agg(jsonb_build_object('name', y.name, 'kind', y.kind, 'at', y.delivered_at, 'mime', y.mime)) from (
          select coalesce(f.display_name, f.name) name, d.kind, d.delivered_at, f.mime from delivery d join index_file f on f.org_id = d.org_id and f.file_id = d.file_id
           where d.project_id = p.id and d.org_id = current_org() order by d.delivered_at desc limit 3) y), '[]'::jsonb)) x
      from project p where p.client_id = v_client and p.org_id = current_org() and p.deleted_at is null and p.kind = 'client_work'
      order by coalesce(p.starts_on, p.start_month) desc nulls last, p.registry_no desc limit 12) s), '[]'::jsonb) end,
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status, 'dueAt', t.due_at,
        'by', (select display_name from person where id = coalesce(t.review_owner_id, t.created_by))) order by t.due_at nulls last, t.created_at)
      from task t where t.org_id = current_org() and t.assignee_person_id = me and t.deleted_at is null and t.status not in ('done', 'accepted', 'cancelled', 'in_review')), '[]'::jsonb),
    'documents', case when v_client is null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'documentId', d.id, 'docType', d.doc_type,
        'number', d.number, 'status', d.status, 'issueDate', to_char(d.issue_date, 'YYYY-MM-DD'), 'validUntil', to_char(d.valid_until, 'YYYY-MM-DD'),
        'taxable', d.taxable, 'tax', d.cgst + d.sgst + d.igst, 'total', d.total, 'note', s.note, 'sharedAt', s.shared_at,
        'decision', s.decision, 'decidedAt', s.decided_at, 'decidedName', s.decided_name, 'decisionNote', s.decision_note,
        'canDecide', s.decision is null and d.doc_type in ('quotation', 'proforma') and d.status in ('issued', 'sent') and (d.valid_until is null or d.valid_until >= v_today),
        'expired', d.valid_until is not null and d.valid_until < v_today,
        'lines', coalesce((select jsonb_agg(jsonb_build_object('name', l.description, 'details', l.details, 'qty', l.qty, 'rate', l.rate, 'gstRate', l.gst_rate, 'total', l.total) order by l.position)
          from erp_line l where l.document_id = d.id and l.org_id = current_org() and not l.not_needed), '[]'::jsonb),
        'hasPdf', exists (select 1 from erp_document_file f where f.document_id = d.id and f.kind = 'pdf')) order by s.shared_at desc)
      from client_share s join erp_document d on d.id = s.document_id and d.org_id = s.org_id
      where s.org_id = current_org() and s.client_id = v_client and s.withdrawn_at is null and d.status <> 'cancelled'), '[]'::jsonb) end,
    'invoices', case when v_client is null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'number', d.number, 'status', d.status,
        'issueDate', to_char(d.issue_date, 'YYYY-MM-DD'), 'dueDate', to_char(d.due_date, 'YYYY-MM-DD'), 'total', d.total, 'paid', d.paid,
        'balance', greatest(d.total - d.paid - d.credited, 0), 'overdue', d.due_date < v_today and d.total - d.paid - d.credited > 0,
        'hasPdf', exists (select 1 from erp_document_file f where f.document_id = d.id and f.kind = 'pdf')) order by d.issue_date desc, d.number desc)
      from erp_document d where d.org_id = current_org() and d.client_id = v_client and d.doc_type = 'invoice' and d.status in ('issued', 'sent', 'part_paid', 'paid')), '[]'::jsonb) end,
    'contracts', case when v_client is null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'status', e.status,
        'startsOn', to_char(e.starts_on, 'YYYY-MM-DD'), 'price', e.price, 'gstRate', e.gst_rate,
        'project', (select coalesce(title, name) from project where id = e.project_id),
        'package', (select name from erp_item where id = e.package_id),
        'instalments', coalesce((select jsonb_agg(jsonb_build_object('label', m.label, 'amount', m.amount, 'dueOn', to_char(m.due_on, 'YYYY-MM-DD'),
            'invoiced', d.status is not null and d.status not in ('draft', 'cancelled'), 'paid', d.status = 'paid', 'number', case when d.status not in ('draft', 'cancelled') then d.number end) order by m.position)
          from erp_milestone m left join erp_document d on d.id = m.document_id where m.engagement_id = e.id), '[]'::jsonb)) order by e.created_at desc)
      from erp_engagement e where e.org_id = current_org() and e.client_id = v_client and e.status <> 'cancelled'), '[]'::jsonb) end,
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'title', r.title, 'at', r.created_at,
        'by', (select display_name from person where id = r.created_by), 'status', t.status, 'taskId', t.id,
        'assignee', (select display_name from person where id = t.assignee_person_id)) order by r.created_at desc)
      from client_request r left join task t on t.id = r.task_id where r.org_id = current_org() and r.connection_id = k.id), '[]'::jsonb),
    'timeline', cp_timeline(k.id, v_client),
    'onboarding', case when v_client is null then null else client_onboarding_state(v_client) end);
end $$;

-- What happened lately, newest first, in the client's words.
create function pulse.cp_timeline(p_conn uuid, p_client uuid) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(e order by e ->> 'at' desc), '[]'::jsonb) from (
    select jsonb_build_object('at', x.at, 'kind', x.kind, 'text', x.text) e from (
      select s.shared_at at, 'document' kind, initcap(replace(d.doc_type, '_', ' ')) || coalesce(' ' || d.number, '') || ' shared with you' text
        from client_share s join erp_document d on d.id = s.document_id where s.org_id = current_org() and s.client_id = p_client and s.withdrawn_at is null
      union all
      select s.decided_at, 'decision', coalesce(s.decided_name, 'You') || case s.decision when 'accepted' then ' accepted ' when 'declined' then ' declined ' else ' asked for changes to ' end
          || replace(d.doc_type, '_', ' ') || coalesce(' ' || d.number, '')
        from client_share s join erp_document d on d.id = s.document_id where s.org_id = current_org() and s.client_id = p_client and s.decided_at is not null
      union all
      select d.issued_at, 'invoice', 'Invoice ' || coalesce(d.number, '') || ' issued'
        from erp_document d where d.org_id = current_org() and d.client_id = p_client and d.doc_type = 'invoice' and d.status in ('issued', 'sent', 'part_paid', 'paid') and d.issued_at is not null
      union all
      select pm.created_at, 'payment', 'Payment received for invoice ' || coalesce(d.number, '')
        from erp_payment pm join erp_document d on d.id = pm.document_id where d.org_id = current_org() and d.client_id = p_client and pm.voided_at is null
      union all
      select y.delivered_at, 'delivery', 'Delivered: ' || y.name || ' (' || y.project || ')' from (
        select d.delivered_at, coalesce(f.display_name, f.name) name, coalesce(p.title, p.name) project from delivery d join index_file f on f.org_id = d.org_id and f.file_id = d.file_id
          join project p on p.id = d.project_id where p.client_id = p_client and d.org_id = current_org() order by d.delivered_at desc limit 10) y
      union all
      select r.created_at, 'request', coalesce((select display_name from person where id = r.created_by), 'Someone') || ' asked: ' || r.title
        from client_request r where r.org_id = current_org() and r.connection_id = p_conn
      union all
      select t.done_at, 'task', 'Done: ' || t.title from task t
        where t.org_id = current_org() and t.done_at is not null and t.id in (select ref from pulse_priv.connect_share where connection_id = p_conn and host_org = current_org() and kind = 'task')
      union all
      select k.created_at, 'joined', 'Your space with ' || (select name from org where id = current_org()) || ' opened'
        from pulse_priv.org_connection k where k.id = p_conn
    ) x where x.at is not null and x.at > now() - interval '180 days' order by x.at desc limit 25) z
$$;

-- ------------------------------------------------------------------------------------------------ onboarding
-- The steps of a client's start, from what happened and what the team ticked.
create function pulse.client_onboarding_state(p_client uuid) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare k pulse_priv.org_connection%rowtype; q timestamptz; ticked jsonb; v_quote timestamptz; v_people int := 0; v_chat timestamptz; v_call timestamptz; v_kick int; v_kick_open int;
begin
  select * into k from pulse_priv.org_connection where a_org = current_org() and client_id = p_client and status = 'active' order by created_at desc limit 1;
  select max(created_at) into q from pulse_priv.connect_request where from_org = current_org() and client_id = p_client and join_connection is null;
  select max(decided_at) into v_quote from client_share where org_id = current_org() and client_id = p_client and decision = 'accepted';
  select coalesce(jsonb_object_agg(step, done_at), '{}'::jsonb) into ticked from client_onboarding where org_id = current_org() and client_id = p_client;
  if k.id is not null then
    select count(*) into v_people from pulse_priv.connect_seat where connection_id = k.id and seat_org = current_org() and removed_at is null;
    select min(m.created_at) into v_chat from chat_message m join pulse_priv.connect_share sh on sh.ref = m.channel_id and sh.kind = 'chat' and sh.connection_id = k.id
      where m.org_id = current_org() and m.kind = 'text' and m.removed_at is null;
    select min(c.created_at) into v_call from chat_call c join pulse_priv.connect_share sh on sh.ref = c.channel_id and sh.kind = 'chat' and sh.connection_id = k.id
      where c.org_id = current_org();
    select count(*), count(*) filter (where t.status not in ('done', 'accepted', 'in_review')) into v_kick, v_kick_open from task t
      join pulse_priv.connect_share sh on sh.ref = t.id and sh.kind = 'task' and sh.connection_id = k.id
      where t.org_id = current_org() and t.deleted_at is null and t.source = 'client_kickoff';
  end if;
  return jsonb_build_array(
    jsonb_build_object('key', 'quote', 'label', 'Quotation accepted', 'done', v_quote is not null or ticked ? 'welcome', 'at', v_quote),
    jsonb_build_object('key', 'invite', 'label', 'Invited to Pulse', 'done', q is not null or k.id is not null, 'at', q),
    jsonb_build_object('key', 'joined', 'label', 'Client signed in', 'done', k.id is not null, 'at', k.created_at),
    jsonb_build_object('key', 'team', 'label', 'Their people added', 'done', v_people > 1 or ticked ? 'team', 'at', ticked ->> 'team', 'count', v_people, 'manual', true),
    jsonb_build_object('key', 'kickoff', 'label', 'Kickoff checklist', 'done', (coalesce(v_kick, 0) > 0 and v_kick_open = 0) or ticked ? 'kickoff', 'at', ticked ->> 'kickoff',
      'sent', coalesce(v_kick, 0) > 0, 'open', coalesce(v_kick_open, 0), 'manual', true),
    jsonb_build_object('key', 'first_chat', 'label', 'First message', 'done', v_chat is not null or ticked ? 'first_chat', 'at', coalesce(v_chat::text, ticked ->> 'first_chat')),
    jsonb_build_object('key', 'first_call', 'label', 'Kickoff call', 'done', v_call is not null or ticked ? 'first_call', 'at', coalesce(v_call::text, ticked ->> 'first_call'), 'manual', true));
end $$;

create function pulse.client_onboarding_tick(p_client uuid, p_step text, p_done boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform cp_admin();
  if not exists (select 1 from client where id = p_client and org_id = current_org()) then raise exception 'Client not found' using errcode = 'P0002'; end if;
  if p_step not in ('welcome', 'team', 'kickoff', 'first_chat', 'first_call') then raise exception 'Choose a step' using errcode = '22023'; end if;
  if p_done then insert into client_onboarding(org_id, client_id, step, done_by) values (current_org(), p_client, p_step, current_viewer()) on conflict do nothing;
  else delete from client_onboarding where org_id = current_org() and client_id = p_client and step = p_step; end if;
  return client_onboarding_state(p_client);
end $$;

-- The kickoff checklist: tasks for the client's first contact, shared through the connection, given by the point of
-- contact who sends it. p_items: [{title, notes}]; the API offers a default list.
create function pulse.client_kickoff_send(p_client uuid, p_items jsonb) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k pulse_priv.org_connection%rowtype; v_to uuid; x jsonb; tid uuid; n int := 0; me uuid := current_viewer();
begin
  perform cp_admin();
  select * into k from pulse_priv.org_connection where a_org = current_org() and client_id = p_client and status = 'active' order by created_at desc limit 1;
  if k.id is null then raise exception 'Invite the client first: the checklist goes to their space' using errcode = '22023'; end if;
  select seat_person into v_to from pulse_priv.connect_seat where connection_id = k.id and seat_org = current_org() and removed_at is null order by created_at limit 1;
  if v_to is null then raise exception 'Nobody of the client is on Pulse yet' using errcode = '22023'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 20 then raise exception 'Choose up to 20 checklist items' using errcode = '22023'; end if;
  for x in select * from jsonb_array_elements(p_items) loop
    if length(btrim(coalesce(x ->> 'title', ''))) < 2 then continue; end if;
    tid := task_save(null, jsonb_build_object('title', left(btrim(x ->> 'title'), 300), 'notes', left(coalesce(x ->> 'notes', ''), 4000), 'assigneeId', me, 'reviewerId', null));
    update task set assignee_person_id = v_to, owner_id = v_to, review_owner_id = me, assigned_at = now(), source = 'client_kickoff' where id = tid;
    perform task_event_add(tid, 'assigned', null, (select display_name from person where id = v_to) || ' (' || connect_other_name(k.id) || ')');
    insert into pulse_priv.connect_share(connection_id, host_org, kind, ref, created_by) values (k.id, current_org(), 'task', tid, me);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ------------------------------------------------------------------------------------------------ shared documents
-- Share an issued quotation, proforma or invoice with the client's space (Finance writers: erp_require(true)).
create function pulse.client_share_document(p_doc uuid, p_note text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := erp_require(true); d erp_document%rowtype; v uuid;
begin
  select * into d from erp_document where id = p_doc and org_id = current_org();
  if d.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  if d.client_id is null then raise exception 'Choose the client on this document first' using errcode = '22023'; end if;
  if d.status not in ('issued', 'sent', 'part_paid', 'paid', 'accepted') then raise exception 'Issue the document before sharing it' using errcode = '22023'; end if;
  insert into client_share(org_id, client_id, document_id, note, shared_by) values (current_org(), d.client_id, d.id, nullif(left(btrim(coalesce(p_note, '')), 1000), ''), me)
  on conflict (org_id, document_id) do update set withdrawn_at = null, note = coalesce(excluded.note, client_share.note), shared_by = excluded.shared_by, shared_at = now()
  returning id into v;
  if d.status = 'issued' then update erp_document set status = 'sent', sent_at = coalesce(sent_at, now()), sent_by = coalesce(sent_by, me), updated_by = me where id = d.id; end if;
  perform erp_log('document', d.id, 'shared_in_portal', jsonb_build_object('client', d.client_id));
  return v;
end $$;

create function pulse.client_share_withdraw(p_doc uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := erp_require(true);
begin
  update client_share set withdrawn_at = now() where org_id = current_org() and document_id = p_doc and withdrawn_at is null;
  perform erp_log('document', p_doc, 'withdrawn_from_portal', '{}'::jsonb);
end $$;

-- What the serving organisation's people see about a document's sharing (document page).
create function pulse.client_share_state(p_doc uuid) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('shared', s.id is not null and s.withdrawn_at is null, 'sharedAt', s.shared_at, 'seenAt', s.seen_at, 'decision', s.decision, 'decidedAt', s.decided_at,
    'decidedName', s.decided_name, 'decisionNote', s.decision_note, 'projectId', s.project_id, 'engagementId', s.engagement_id,
    'clientOnPulse', exists (select 1 from pulse_priv.org_connection k where k.a_org = current_org() and k.client_id = d.client_id and k.status = 'active'))
  from erp_document d left join client_share s on s.document_id = d.id and s.org_id = d.org_id where d.id = p_doc and d.org_id = current_org() and erp_can(false)
$$;

-- The PDF of a document shown in the viewer's space (issued copy as filed).
create function pulse.cp_document_file(p_doc uuid) returns bytea
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k pulse_priv.org_connection%rowtype; b bytea;
begin
  select * into k from pulse_priv.org_connection where id = cp_viewer_conn();
  if k.id is null or k.client_id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  select f.bytes into b from erp_document d join erp_document_file f on f.document_id = d.id and f.kind = 'pdf'
   where d.id = p_doc and d.org_id = current_org() and d.client_id = k.client_id and d.status <> 'cancelled'
     and (exists (select 1 from client_share s where s.document_id = d.id and s.org_id = current_org() and s.withdrawn_at is null)
          or (d.doc_type = 'invoice' and d.status in ('issued', 'sent', 'part_paid', 'paid')));
  if b is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  update client_share set seen_at = coalesce(seen_at, now()) where document_id = p_doc and org_id = current_org();
  return b;
end $$;

-- The client answers a shared quotation or proforma: accepted, changes (with what to change) or declined. Accepting a
-- quotation starts the work: a project (onboarding) unless the document names one, the client package with its
-- instalments from the package on the quotation (else one instalment), and a task for the point of contact.
create function pulse.cp_decide(p_share uuid, p_decision text, p_name text, p_note text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k pulse_priv.org_connection%rowtype; s client_share%rowtype; d erp_document%rowtype; me uuid := current_viewer(); v_name text := btrim(coalesce(p_name, ''));
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 2000), ''); v_project uuid; v_eng uuid; pkg erp_item%rowtype; v_start date := (now() at time zone 'Asia/Kolkata')::date;
  v_poc uuid; v_price bigint; v_gst numeric; x jsonb; i int := 0; v_left bigint; v_amt bigint; n int; registry int; tid uuid; v_title text; v_client_name text;
begin
  select * into k from pulse_priv.org_connection where id = cp_viewer_conn();
  if k.id is null or k.client_id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  select * into s from client_share where id = p_share and org_id = current_org() and client_id = k.client_id and withdrawn_at is null for update;
  if s.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  if s.decision is not null then raise exception 'This was already answered' using errcode = '22023'; end if;
  if p_decision not in ('accepted', 'changes', 'declined') then raise exception 'Accept, ask for changes or decline' using errcode = '22023'; end if;
  if p_decision = 'accepted' and length(v_name) not between 2 and 120 then raise exception 'Type your full name to accept' using errcode = '22023'; end if;
  if p_decision = 'changes' and v_note is null then raise exception 'Say what you would like changed' using errcode = '22023'; end if;
  select * into d from erp_document where id = s.document_id and org_id = current_org() for update;
  if d.doc_type not in ('quotation', 'proforma') or d.status not in ('issued', 'sent') then raise exception 'This document can no longer be answered' using errcode = '22023'; end if;
  if d.valid_until is not null and d.valid_until < v_start and p_decision = 'accepted' then raise exception 'This quotation has expired: ask for a new one' using errcode = '22023'; end if;
  v_client_name := coalesce((select display_name from client where id = k.client_id), 'The client');
  v_poc := coalesce((select s2.home_person from pulse_priv.connect_seat s2 join person pe on pe.id = s2.home_person and pe.status = 'active'
                      where s2.connection_id = k.id and s2.home_org = current_org() and s2.removed_at is null order by s2.created_at limit 1),
                    d.salesperson_id, s.shared_by);
  if p_decision in ('accepted', 'declined') then
    update erp_document set status = p_decision, decision = jsonb_build_object('decision', p_decision, 'name', coalesce(nullif(v_name, ''), (select display_name from person where id = me)),
      'at', now(), 'via', 'portal', 'note', v_note) where id = d.id;
  end if;
  insert into erp_event(org_id, subject_type, subject_id, kind, detail) values (current_org(), 'document', d.id, 'client_' || p_decision,
    jsonb_build_object('name', coalesce(nullif(v_name, ''), (select display_name from person where id = me)), 'via', 'portal'));
  update client_share set decision = p_decision, decided_by = me, decided_name = coalesce(nullif(v_name, ''), (select display_name from person where id = me)),
    decided_at = now(), decision_note = v_note, seen_at = coalesce(seen_at, now()) where id = s.id;

  if p_decision = 'accepted' and d.doc_type = 'quotation' then
    v_project := d.project_id;
    v_title := v_client_name || coalesce(' · ' || (select l.description from erp_line l where l.document_id = d.id and not l.not_needed order by l.position limit 1), '');
    if v_project is null then
      perform pg_advisory_xact_lock(hashtext('project-register:' || current_org()::text));
      select coalesce(max(registry_no), 0) + 1 into registry from project where org_id = current_org();
      insert into project(org_id, registry_no, name, title, client_id, status, kind, starts_on, scope, locked)
      values (current_org(), registry, left(v_title, 200), left(v_title, 200), k.client_id, 'onboarding', 'client_work', v_start,
        left('From quotation ' || coalesce(d.number, ''), 2000), '{title,client_id}') returning id into v_project;
    end if;
    select i2.* into pkg from erp_line l join erp_item i2 on i2.id = l.item_id and i2.kind = 'package' where l.document_id = d.id and not l.not_needed order by l.position limit 1;
    v_price := d.taxable;
    v_gst := coalesce(pkg.gst_rate, (select max(gst_rate) from erp_line where document_id = d.id and not not_needed), 18);
    insert into erp_engagement(org_id, project_id, client_id, package_id, package_version, name, price, gst_rate, starts_on, created_by)
    values (current_org(), v_project, k.client_id, pkg.id, pkg.version, left(coalesce(pkg.name, v_title), 200), v_price, v_gst, v_start, v_poc) returning id into v_eng;
    -- Instalments: the package's plan (label, percent, offsetDays), the last one taking what rounding left; else one.
    n := coalesce(jsonb_array_length(case when jsonb_typeof(pkg.milestones) = 'array' then pkg.milestones end), 0);
    v_left := v_price;
    if n = 0 then
      insert into erp_milestone(org_id, engagement_id, position, label, amount, due_on) values (current_org(), v_eng, 0, 'On acceptance', v_price, v_start);
    else
      for x in select * from jsonb_array_elements(pkg.milestones) loop
        v_amt := case when i = n - 1 then v_left else round(v_price * coalesce((x ->> 'percent')::numeric, 0) / 100)::bigint end;
        v_left := v_left - v_amt;
        insert into erp_milestone(org_id, engagement_id, position, label, amount, due_on)
        values (current_org(), v_eng, i, left(coalesce(x ->> 'label', 'Instalment ' || (i + 1)), 160), v_amt, v_start + coalesce((x ->> 'offsetDays')::int, 0));
        i := i + 1;
      end loop;
    end if;
    update client_share set project_id = v_project, engagement_id = v_eng where id = s.id;
    insert into client_onboarding(org_id, client_id, step, done_by) values (current_org(), k.client_id, 'welcome', null) on conflict do nothing;
  end if;

  -- The point of contact's own task (made as them, so it stays internal).
  if v_poc is not null and exists (select 1 from person where id = v_poc and org_id = current_org() and side = 'staff' and status = 'active') then
    perform acct_enter(current_org(), v_poc);
    tid := task_save(null, jsonb_build_object('title', left(case p_decision when 'accepted' then v_client_name || ' accepted quotation ' || coalesce(d.number, '') || ': start onboarding'
        when 'declined' then v_client_name || ' declined quotation ' || coalesce(d.number, '') else v_client_name || ' asked for changes to quotation ' || coalesce(d.number, '') end, 300),
      'notes', coalesce(v_note, ''), 'assigneeId', v_poc, 'reviewerId', null, 'urgency', case when p_decision = 'declined' then 'normal' else 'high' end) ||
      case when v_project is not null then jsonb_build_object('projectId', v_project) else '{}'::jsonb end);
    perform acct_leave();
  end if;
  return jsonb_build_object('decision', p_decision, 'number', d.number, 'projectId', v_project, 'engagementId', v_eng);
end $$;

-- ------------------------------------------------------------------------------------------------ requests and talk
-- The client asks for something: a task for their point of contact, given by the client and shared with them.
create function pulse.cp_request(p jsonb) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k pulse_priv.org_connection%rowtype; me uuid := current_viewer(); v_poc uuid; tid uuid; v_id uuid; v_kind text := coalesce(p ->> 'kind', 'request');
  v_title text := regexp_replace(btrim(coalesce(p ->> 'title', '')), '\s+', ' ', 'g');
begin
  select * into k from pulse_priv.org_connection where id = cp_viewer_conn();
  if k.id is null then raise exception 'This is for clients of this organisation' using errcode = '42501'; end if;
  if v_kind not in ('request', 'change', 'question', 'problem') then raise exception 'Choose what kind of request this is' using errcode = '22023'; end if;
  if length(v_title) not between 2 and 200 then raise exception 'Say in a few words what you need' using errcode = '22023'; end if;
  select s.home_person into v_poc from pulse_priv.connect_seat s join person pe on pe.id = s.home_person and pe.status = 'active' and pe.side = 'staff'
   where s.connection_id = k.id and s.home_org = current_org() and s.removed_at is null order by s.created_at limit 1;
  if v_poc is null then raise exception 'Your contact is not set up yet: write in your chat instead' using errcode = '22023'; end if;
  tid := task_save(null, jsonb_build_object('title', left(v_title, 300), 'notes', left(coalesce(p ->> 'body', ''), 4000), 'assigneeId', me, 'reviewerId', null,
    'urgency', case when v_kind = 'problem' then 'high' else 'normal' end));
  update task set assignee_person_id = v_poc, owner_id = v_poc, review_owner_id = me, assigned_at = now(), source = 'client_request' where id = tid;
  perform task_event_add(tid, 'assigned', null, (select display_name from person where id = v_poc));
  insert into pulse_priv.connect_share(connection_id, host_org, kind, ref, created_by) values (k.id, current_org(), 'task', tid, me);
  insert into client_request(org_id, connection_id, client_id, task_id, kind, title, body, created_by)
  values (current_org(), k.id, k.client_id, tid, v_kind, left(v_title, 200), nullif(left(btrim(coalesce(p ->> 'body', '')), 4000), ''), me) returning id into v_id;
  return v_id;
end $$;

-- The client's group with their team: the shared group of the connection they are in, made on first use with every
-- point of contact on both sides (the serving side's first point of contact is its admin).
create function pulse.cp_group() returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k pulse_priv.org_connection%rowtype; me uuid := current_viewer(); cid uuid; v_admin uuid; v_name text;
begin
  select * into k from pulse_priv.org_connection where id = cp_viewer_conn();
  if k.id is null then raise exception 'This is for clients of this organisation' using errcode = '42501'; end if;
  select sh.ref into cid from pulse_priv.connect_share sh join chat_member cm on cm.channel_id = sh.ref and cm.person_id = me
   where sh.connection_id = k.id and sh.host_org = current_org() and sh.kind = 'chat' order by sh.created_at limit 1;
  if cid is not null then return cid; end if;
  select s.home_person into v_admin from pulse_priv.connect_seat s join person pe on pe.id = s.home_person and pe.status = 'active' and pe.side = 'staff'
   where s.connection_id = k.id and s.home_org = current_org() and s.removed_at is null order by s.created_at limit 1;
  if v_admin is null then raise exception 'Your contact is not set up yet' using errcode = '22023'; end if;
  v_name := left(coalesce((select name from org where id = case when k.kind = 'vendor' then k.a_org else k.b_org end), (select display_name from client where id = k.client_id), 'Client')
    || ' × ' || (select coalesce(nullif(code, ''), name) from org where id = current_org()), 60);
  insert into chat_channel(org_id, key, name, kind, description, created_by)
  values (current_org(), 'custom:' || gen_random_uuid(), v_name, 'custom', 'Shared with ' || connect_other_name(k.id), v_admin) returning id into cid;
  insert into chat_member(org_id, channel_id, person_id, role) values (current_org(), cid, v_admin, 'admin');
  insert into chat_member(org_id, channel_id, person_id)
  select current_org(), cid, x.p from (
    select s.home_person p from pulse_priv.connect_seat s where s.connection_id = k.id and s.home_org = current_org() and s.removed_at is null
    union select s.seat_person from pulse_priv.connect_seat s where s.connection_id = k.id and s.seat_org = current_org() and s.removed_at is null) x
  join person pe on pe.id = x.p and pe.status = 'active' where x.p <> v_admin
  on conflict do nothing;
  insert into pulse_priv.connect_share(connection_id, host_org, kind, ref, created_by) values (k.id, current_org(), 'chat', cid, me);
  perform chat_event_line(cid, me, 'opened this group with ' || (select name from org where id = current_org()));
  perform audit_write('create', 'connect_share', cid::text);
  return cid;
end $$;

-- ------------------------------------------------------------------------------------------------ calls (0896)
-- A connected organisation's contact rings and is rung in the conversations they are in (they were left out by
-- side = 'staff'); everything else as 0896.
create or replace function pulse.chat_call_start(p_channel uuid,p_video boolean,p_invite uuid[] default null) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cid uuid; others uuid[]; existing uuid; mid uuid; p uuid; label text:=case when coalesce(p_video,false) then 'Video call' else 'Voice call' end;
begin
 if not chat_has(p_channel) or not exists(select 1 from chat_member where org_id=current_org() and channel_id=p_channel and person_id=current_viewer()) then
  raise exception 'conversation unavailable' using errcode='42501'; end if;
 perform chat_call_expire();
 select id into existing from chat_call where org_id=current_org() and channel_id=p_channel and state<>'ended';
 if existing is not null then perform chat_call_answer(existing); return existing; end if;
 if exists(select 1 from chat_call_party pa join chat_call c on c.id=pa.call_id where pa.org_id=current_org() and pa.person_id=current_viewer() and pa.state='joined' and c.state<>'ended') then
  raise exception 'You are already in a call. Hang up first.' using errcode='22023'; end if;
 select coalesce(array_agg(cm.person_id order by pe.display_name),'{}') into others from chat_member cm join person pe on pe.id=cm.person_id
 where cm.org_id=current_org() and cm.channel_id=p_channel and cm.person_id<>current_viewer() and pe.status='active' and (pe.side='staff' or connect_is_seat(pe.id))
  and (p_invite is null or cm.person_id=any(p_invite)) and notification_chat_member_current(p_channel,cm.person_id);
 if cardinality(others)=0 then raise exception 'There is nobody here to call' using errcode='22023'; end if;
 if cardinality(others)>7 then raise exception 'A call can ring up to 7 people. Choose who to call.' using errcode='22023'; end if;
 insert into chat_call(org_id,channel_id,started_by,video) values(current_org(),p_channel,current_viewer(),coalesce(p_video,false)) returning id into cid;
 insert into chat_call_party(org_id,call_id,person_id,state,joined_at,video) values(current_org(),cid,current_viewer(),'joined',clock_timestamp(),coalesce(p_video,false));
 insert into chat_call_party(org_id,call_id,person_id,state,invited_by)
 select current_org(),cid,o,case when exists(select 1 from chat_call_party b join chat_call bc on bc.id=b.call_id where b.org_id=current_org() and b.person_id=o and b.state='joined' and bc.state<>'ended' and b.seen_at>clock_timestamp()-interval '30 seconds') then 'busy' else 'ringing' end,current_viewer()
 from unnest(others) o;
 mid:=chat_event_line(p_channel,current_viewer(),label,jsonb_build_array(jsonb_build_object('call',cid,'name',label,'video',coalesce(p_video,false),'state','ringing','seconds',null)));
 update chat_call set message_id=mid where id=cid;
 for p in select person_id from chat_call_party where call_id=cid and state='ringing' loop perform chat_call_ring(cid,p); end loop;
 perform chat_call_settle(cid);
 perform chat_call_touch(cid);
 return cid;
end $$;

create or replace function pulse.chat_call_invite(p_call uuid,p_people uuid[]) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c chat_call; kind text; p uuid;
begin
 select * into c from chat_call where org_id=current_org() and id=p_call;
 if not found or c.state='ended' or not exists(select 1 from chat_call_party where call_id=p_call and person_id=current_viewer() and state='joined') then
  raise exception 'call unavailable' using errcode='42501'; end if;
 select ch.kind into kind from chat_channel ch where ch.id=c.channel_id;
 for p in select distinct x from unnest(coalesce(p_people,'{}')) x loop
  if p=current_viewer() or not exists(select 1 from person where org_id=current_org() and id=p and status='active' and (side='staff' or connect_is_seat(id))) then continue; end if;
  if kind<>'direct' and not notification_chat_member_current(c.channel_id,p) then continue; end if;
  -- CLIENT-PORTAL: a client's seat rings only people already in the conversation (in a 1:1 too).
  if connect_is_seat(current_viewer()) and not exists(select 1 from chat_member where channel_id=c.channel_id and person_id=p) then continue; end if;
  if exists(select 1 from chat_call_party where call_id=p_call and person_id=p and state in ('ringing','joined')) then continue; end if;
  if (select count(*) from chat_call_party where call_id=p_call and state in ('ringing','joined'))>=8 then raise exception 'A call has 8 people at most' using errcode='22023'; end if;
  insert into chat_call_party(org_id,call_id,person_id,state,invited_by,invited_at) values(current_org(),p_call,p,'ringing',current_viewer(),clock_timestamp())
  on conflict(call_id,person_id) do update set state='ringing',invited_by=current_viewer(),invited_at=clock_timestamp(),left_at=null;
  perform chat_call_ring(p_call,p);
 end loop;
 perform chat_call_touch(p_call);
end $$;

-- ------------------------------------------------------------------------------------------------ grants
revoke all on function pulse.cp_bind_contact(uuid, uuid, uuid), pulse.cp_history_apply(uuid) from public;
revoke all on function pulse.cp_admin(), pulse.cp_viewer_conn(), pulse.client_history_opt_in(uuid), pulse.client_access_state(uuid), pulse.client_access_list(),
  pulse.client_invite(uuid, jsonb, text), pulse.client_person_invite(uuid, jsonb, text, boolean), pulse.client_invite_emailed(uuid, text), pulse.client_invite_revoke(uuid),
  pulse.cp_history_opt_in(boolean), pulse.cp_home(), pulse.cp_timeline(uuid, uuid), pulse.client_onboarding_state(uuid), pulse.client_onboarding_tick(uuid, text, boolean),
  pulse.client_kickoff_send(uuid, jsonb), pulse.client_share_document(uuid, text), pulse.client_share_withdraw(uuid), pulse.client_share_state(uuid),
  pulse.cp_document_file(uuid), pulse.cp_decide(uuid, text, text, text), pulse.cp_request(jsonb), pulse.cp_group() from public;
revoke all on function pulse.client_access_contacts(uuid) from public;
grant execute on function pulse.client_access_contacts(uuid), pulse.cp_admin() to pulse_api;
grant execute on function pulse.client_history_opt_in(uuid), pulse.client_access_state(uuid), pulse.client_access_list(),
  pulse.client_invite(uuid, jsonb, text), pulse.client_person_invite(uuid, jsonb, text, boolean), pulse.client_invite_emailed(uuid, text), pulse.client_invite_revoke(uuid),
  pulse.cp_viewer_conn(), pulse.cp_history_opt_in(boolean), pulse.cp_home(), pulse.client_onboarding_state(uuid), pulse.client_onboarding_tick(uuid, text, boolean),
  pulse.client_kickoff_send(uuid, jsonb), pulse.client_share_document(uuid, text), pulse.client_share_withdraw(uuid), pulse.client_share_state(uuid),
  pulse.cp_document_file(uuid), pulse.cp_decide(uuid, text, text, text), pulse.cp_request(jsonb), pulse.cp_group() to pulse_api;

-- migrate:down
-- Forward-only.
