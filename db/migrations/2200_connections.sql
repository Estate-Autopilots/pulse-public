-- migrate:up
-- CONNECTIONS part B (owner, 16-17 Nov 2026: "Multi-organisation: we need to see what is happening where"; "I assign
-- [Sakobe] tasks from here but there is no place for it. No contract"; "from my Savuzo identity I should see which
-- documents are shared, with whom, the client, all of it"). The spec is CONNECT-MAP §3 (reports/CONNECT-MAP.md).
--
-- A connection is a working relationship between two parties: who (two people, two companies, or one of each), what one
-- is to the other (client, freelancer, co-founder ...), where it lives (side A's company or personal space), on what
-- terms (its agreement), what they share (the ledger) and where it stands (suggested, invited, active, paused, ended).
-- No parallel system: 0953/1020's pulse_priv.org_connection becomes the connection and pulse_priv.connect_share its
-- ledger (production has 0 rows in both, so widening costs nothing).
--
-- Rules (CONNECT-MAP §3.1):
--  1. Work lives with the doer. connection_task_give makes the task in the doer's own space (their personal space, or
--     the company where they hold a staff seat), as theirs, with the giver as its reviewer through the giver's seat
--     there (a guest seat, connect_seat, when the giver has none). When the doer has no space yet, it waits in the
--     giver's space on the doer's guest seat (0953's behaviour), and moves nowhere later.
--  2. Docs live with the author. connection_doc_share gives the other side's guest seat in the author's space a doc_share
--     row (read, comment or edit). Nothing is copied. A guest seat sees a doc only through such a row.
--  3. The connection holds the pointers (connect_share): docs, tasks, chats, its governing agreement. Ending it closes
--     every pointer and its grant, ends the guest seats and keeps the history.
-- Agreement state is derived, never stored: signed / waiting / draft / none / ended (connection_agreement).
-- connection_agreement_draft makes one draft contract in the space the connection lives in (provider or employer side);
-- nothing is ever sent, signed or accepted by Pulse or an AI helper (contract_no_ai_send).
-- AI helpers read connections only as the person they work for (connection_here reads as that person); every change
-- (make, confirm, share, give, draft, end) refuses an AI session.
-- Seat ties (people in the same company) are derived per seat by connection_here, never stored.
-- Every change writes an audit_event (resource 'connection', the connection id, the note) in the spaces it touches.

-- ------------------------------------------------------------------------------------------------ the connection
alter table pulse_priv.org_connection drop constraint org_connection_kind_check;
alter table pulse_priv.org_connection add constraint org_connection_kind_check
  check (kind in ('client', 'vendor', 'partner', 'freelancer', 'employee', 'cofounder', 'advisor', 'investor', 'accountant'));
alter table pulse_priv.org_connection drop constraint org_connection_status_check;
alter table pulse_priv.org_connection add constraint org_connection_status_check check (status in ('suggested', 'invited', 'active', 'paused', 'ended'));
alter table pulse_priv.org_connection
  add column a_account uuid references pulse_priv.pulse_account(id),
  add column a_role text check (a_role is null or length(a_role) <= 80),
  add column source text not null default 'invite' check (source in ('invite', 'backfill', 'seat', 'contract', 'quote', 'directory', 'manual')),
  add column a_company_id uuid,          -- COMPANIES-MODEL's pulse.company row of A for B (no reference: that table lands apart)
  add column b_company_id uuid,
  add column a_contact uuid,             -- A's contact (person) row for B when B is a person
  add column b_contact uuid,
  add column grants jsonb not null default '{}' check (jsonb_typeof(grants) = 'object'),
  add column started_on date,
  add column ended_on date,
  add column end_reason text check (end_reason is null or length(end_reason) <= 400),
  add column note text check (note is null or length(note) <= 400),
  add column created_by_account uuid references pulse_priv.pulse_account(id),
  add column updated_at timestamptz not null default now();
-- One live connection of a kind between the same two parties.
create unique index org_connection_live on pulse_priv.org_connection(a_org, coalesce(a_account, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(b_org, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(b_account, '00000000-0000-0000-0000-000000000000'::uuid), kind) where status <> 'ended';
create index org_connection_b_org on pulse_priv.org_connection(b_org) where b_org is not null;
create index org_connection_accounts on pulse_priv.org_connection(a_account, b_account);

-- ------------------------------------------------------------------------------------------------ the shares ledger
alter table pulse_priv.connect_share drop constraint connect_share_kind_check;
alter table pulse_priv.connect_share add constraint connect_share_kind_check
  check (kind in ('chat', 'task', 'doc', 'folder', 'project', 'contract', 'quote', 'invoice', 'deliverable', 'file', 'event'));
alter table pulse_priv.connect_share
  add column access text not null default 'read' check (access in ('read', 'comment', 'edit', 'do')),
  add column governs boolean not null default false,
  add column revoked_at timestamptz,
  add column revoked_by uuid;
-- A doc may be shared with two connections: one row per connection.
alter table pulse_priv.connect_share drop constraint connect_share_host_org_kind_ref_key;
create unique index connect_share_one on pulse_priv.connect_share(connection_id, host_org, kind, ref);
create index connect_share_ref on pulse_priv.connect_share(host_org, kind, ref);

-- ------------------------------------------------------------------------------------------------ helpers
-- Step into another space for a few reads or writes (its own row security), and back. Returns where we were.
create function pulse_priv.conn_enter(p_org uuid, p_viewer uuid) returns text
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare was text := coalesce(current_setting('pulse.org_id', true), '') || '|' || coalesce(current_setting('pulse.viewer_id', true), '');
begin
  perform set_config('pulse.org_id', p_org::text, true);
  perform set_config('pulse.viewer_id', coalesce(p_viewer::text, ''), true);
  return was;
end $$;
create function pulse_priv.conn_leave(p_was text) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare b text[] := string_to_array(coalesce(p_was, '|'), '|');
begin
  perform set_config('pulse.org_id', coalesce(b[1], ''), true);
  perform set_config('pulse.viewer_id', coalesce(b[2], ''), true);
end $$;
revoke all on function pulse_priv.conn_enter(uuid, uuid), pulse_priv.conn_leave(text) from public;

-- No change through a connection is made by an AI helper (it reads as its person; a person does the rest).
create function pulse.connection_no_ai() returns void
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if agent_session() is not null then
    raise exception 'An AI helper reads connections for its person; a person makes, shares, gives and ends them' using errcode = '42501';
  end if;
end $$;

-- One side, as the page shows it.
create function pulse.connection_side(p_org uuid, p_account uuid) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('org', o.id, 'orgName', o.name, 'orgHandle', o.handle, 'orgKind', o.kind, 'personal', o.kind = 'personal',
    'account', a.id, 'name', coalesce(a.display_name, o.name), 'handle', a.handle)
  from (select 1) x left join org o on o.id = p_org left join pulse_priv.pulse_account a on a.id = coalesce(p_account, o.personal_account)
$$;

-- Who may see a connection from the current seat: a side's own account, its maker, the admins, leadership and HR of a side's
-- company (from inside it), the owner of a side's personal space, and the connection's contacts (guest seats).
create function pulse.connection_may_see(p_conn uuid) returns boolean
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare c pulse_priv.org_connection; acct uuid := account_of_viewer(); me uuid := current_viewer();
begin
  if me is null then return false; end if;
  select * into c from pulse_priv.org_connection where id = p_conn;
  if not found then return false; end if;
  if acct is not null and acct in (c.a_account, c.b_account, c.created_by_account) then return true; end if;
  if current_org() in (c.a_org, c.b_org) then
    if viewer_is('admin', 'leadership', 'hr') then return true; end if;
    if exists (select 1 from org o where o.id = current_org() and o.kind = 'personal' and o.personal_account = acct) then return true; end if;
  end if;
  return exists (select 1 from pulse_priv.connect_seat s where s.connection_id = p_conn and s.removed_at is null and (s.home_person = me or s.seat_person = me));
end $$;

-- May the viewer act for side A or B (from inside that side's space, or as that side's own account when it has none)?
create function pulse.connection_my_side(p_conn uuid) returns text
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare c pulse_priv.org_connection; acct uuid := account_of_viewer(); lead boolean;
begin
  select * into c from pulse_priv.org_connection where id = p_conn;
  if not found or current_viewer() is null then return null; end if;
  lead := viewer_is('admin', 'leadership', 'hr') or exists (select 1 from org o where o.id = current_org() and o.kind = 'personal' and o.personal_account = acct);
  -- A side acts from inside its own space; a person side with no space yet (b_org empty) from any of their seats.
  if current_org() = c.a_org and (lead or acct = c.a_account) then return 'a'; end if;
  if c.b_org is not null and current_org() = c.b_org and (lead or acct = c.b_account) then return 'b'; end if;
  if c.b_org is null and acct is not null and acct = c.b_account then return 'b'; end if;
  return null;
end $$;

create function pulse_priv.conn_audit(p_org uuid, p_conn uuid, p_action text, p_changes jsonb) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare was text;
begin
  if p_org is null then return; end if;
  if p_org is distinct from current_org() then was := pulse_priv.conn_enter(p_org, null); end if;
  insert into audit_event(org_id, actor_id, actor_account, action, resource, resource_id, source, changes)
  values (p_org, case when p_org = current_org() or was is null then current_viewer() end, nullif(current_setting('pulse.actor_account', true), ''),
          'connection.' || p_action, 'connection', p_conn::text, 'pulse', coalesce(p_changes, '{}'::jsonb));
  if was is not null then perform pulse_priv.conn_leave(was); end if;
end $$;
revoke all on function pulse_priv.conn_audit(uuid, uuid, text, jsonb) from public;

-- ------------------------------------------------------------------------------------------------ agreement (derived)
-- The governing agreement (a ledger row that governs), else the newest contract in the space it lives in whose
-- parties are exactly the two sides. Read inside that space.
create function pulse.connection_agreement(p_conn uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c pulse_priv.org_connection; was text; k record; host uuid; cid uuid; n_open int; who text;
begin
  select * into c from pulse_priv.org_connection where id = p_conn;
  if not found then return null; end if;
  select s.host_org, s.ref into host, cid from pulse_priv.connect_share s
   where s.connection_id = p_conn and s.kind = 'contract' and s.governs and s.revoked_at is null order by s.created_at desc limit 1;
  host := coalesce(host, c.a_org);
  was := pulse_priv.conn_enter(host, null);
  if cid is null then
    select t.id into cid from contract t where t.org_id = host and t.status <> 'cancelled'
       and exists (select 1 from contract_party p where p.contract_id = t.id and ((c.a_account is not null and p.party_account = c.a_account) or (c.a_account is null and p.party_org = c.a_org)))
       and exists (select 1 from contract_party p where p.contract_id = t.id and ((c.b_org is not null and p.party_org = c.b_org) or (c.b_account is not null and p.party_account = c.b_account)))
     order by t.updated_at desc limit 1;
  end if;
  select t.id, t.title, t.status, t.version into k from contract t where t.id = cid and t.org_id = host;
  if k.id is not null then
    select count(*) filter (where p.accepted_version is distinct from k.version), min(p.name) filter (where p.accepted_version is distinct from k.version)
      into n_open, who from contract_party p where p.contract_id = k.id;
  end if;
  perform pulse_priv.conn_leave(was);
  if k.id is null then return jsonb_build_object('state', case when c.status = 'ended' then 'ended' else 'none' end); end if;
  return jsonb_build_object('contract', k.id, 'title', k.title, 'status', k.status, 'host', host,
    'state', case when k.status in ('ended', 'cancelled') or c.status = 'ended' then 'ended' when k.status = 'draft' then 'draft'
                  when k.status = 'active' and coalesce(n_open, 0) = 0 then 'signed' else 'waiting' end,
    'waitingFor', case when k.status not in ('draft', 'ended', 'cancelled') and coalesce(n_open, 0) > 0 then who end);
end $$;

-- ------------------------------------------------------------------------------------------------ reading
-- One connection as a list row, from where the viewer stands.
create function pulse.connection_row(p_conn uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c pulse_priv.org_connection;
begin
  select * into c from pulse_priv.org_connection where id = p_conn;
  if not found then return null; end if;
  return jsonb_build_object('id', c.id, 'kind', c.kind, 'status', c.status, 'source', c.source, 'aRole', c.a_role, 'bRole', c.role, 'note', c.note,
    'since', c.created_at, 'startedOn', c.started_on, 'mySide', connection_my_side(c.id),
    'a', connection_side(c.a_org, c.a_account), 'b', connection_side(c.b_org, c.b_account),
    'agreement', connection_agreement(c.id),
    'counts', (select jsonb_build_object('docs', count(*) filter (where s.kind in ('doc', 'folder')), 'tasks', count(*) filter (where s.kind = 'task'),
        'chats', count(*) filter (where s.kind = 'chat'))
      from pulse_priv.connect_share s where s.connection_id = c.id and s.revoked_at is null),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('account', s.account_id, 'name', a.display_name, 'handle', a.handle, 'in', s.seat_org) order by s.created_at)
      from pulse_priv.connect_seat s join pulse_priv.pulse_account a on a.id = s.account_id where s.connection_id = c.id and s.removed_at is null), '[]'::jsonb));
end $$;

-- Everything about connections seen from the current seat (read per seat by GET /api/v0/connections/mine, merged there):
-- the direct connections this seat may see, and the seat ties of this company (people with an account who hold a seat
-- here), for its admins, leadership and HR. An AI helper reads as the person it works for.
create function pulse.connection_here() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); owner_person uuid; was text; out jsonb; acct uuid; lead boolean; personal boolean;
begin
  if me is null then return null; end if;
  if agent_session() is not null then
    select m.owner_person_id into owner_person from agent_member m where m.person_id = agent_session();
    if owner_person is null then return null; end if;
    was := pulse_priv.conn_enter(current_org(), owner_person);
    out := connection_here();
    perform pulse_priv.conn_leave(was);
    return out;
  end if;
  acct := account_of_viewer();
  personal := exists (select 1 from org o where o.id = current_org() and o.kind = 'personal');
  lead := viewer_is('admin', 'leadership', 'hr') or exists (select 1 from org o where o.id = current_org() and o.kind = 'personal' and o.personal_account = acct);
  return jsonb_build_object(
    'org', (select jsonb_build_object('id', o.id, 'name', o.name, 'kind', o.kind, 'purpose', o.purpose) from org o where o.id = current_org()),
    'lead', lead,
    'direct', coalesce((select jsonb_agg(connection_row(c.id) order by c.created_at desc) from pulse_priv.org_connection c
       where (c.a_org = current_org() or c.b_org = current_org() or (acct is not null and acct in (c.a_account, c.b_account)))
         and connection_may_see(c.id)), '[]'::jsonb),
    -- Seat ties: everyone else with a Pulse account and a seat here, with what names them in an agreement here.
    'seats', case when lead and not personal then coalesce((select jsonb_agg(jsonb_build_object('person', p.id, 'name', p.display_name, 'account', m.account_id,
        'handle', a.handle, 'seat', m.kind, 'side', p.side, 'role', nullif(btrim(pp.role), ''),
        'agreement', case
          when exists (select 1 from contract_party cp join contract t on t.id = cp.contract_id where (cp.party_person_id = p.id or cp.party_account = m.account_id)
                       and t.status = 'active' and cp.accepted_version = t.version) then 'signed'
          when exists (select 1 from contract_party cp join contract t on t.id = cp.contract_id where (cp.party_person_id = p.id or cp.party_account = m.account_id)
                       and t.status = 'proposed') then 'waiting'
          when exists (select 1 from contract_party cp join contract t on t.id = cp.contract_id where (cp.party_person_id = p.id or cp.party_account = m.account_id)
                       and t.status = 'draft') then 'draft'
          else 'none' end) order by p.display_name)
      from pulse_priv.account_member m join person p on p.id = m.person_id and p.org_id = current_org()
      join pulse_priv.pulse_account a on a.id = m.account_id left join people_profile pp on pp.person_id = p.id
      where m.member_org = current_org() and m.kind in ('staff', 'freelancer') and p.status = 'active' and p.id <> me
        and (acct is null or m.account_id <> acct)), '[]'::jsonb) else '[]'::jsonb end);
end $$;

-- One connection in full, from the current seat: its row, the ledger with each item's title read in its own space, the
-- money of a client connection (for whoever may read Billing here) and the activity of both sides.
create function pulse.connection_get(p_conn uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c pulse_priv.org_connection; items jsonb := '[]'; s record; was text; it jsonb; money jsonb := null; act jsonb := '[]'; o uuid; me uuid := current_viewer(); owner_person uuid; by_name text;
begin
  if me is null then return null; end if;
  if agent_session() is not null then
    select m.owner_person_id into owner_person from agent_member m where m.person_id = agent_session();
    if owner_person is null then return null; end if;
    was := pulse_priv.conn_enter(current_org(), owner_person);
    it := connection_get(p_conn);
    perform pulse_priv.conn_leave(was);
    return it;
  end if;
  if not connection_may_see(p_conn) then return null; end if;
  select * into c from pulse_priv.org_connection where id = p_conn;
  for s in select * from pulse_priv.connect_share where connection_id = p_conn order by created_at desc limit 200 loop
    was := pulse_priv.conn_enter(s.host_org, null);
    it := case s.kind
      when 'task' then (select jsonb_build_object('title', t.title, 'status', t.status, 'dueOn', (t.due_at at time zone org_time_zone())::date,
          'doer', (select display_name from person where id = t.assignee_person_id), 'doerAccount', (select account_id from pulse_priv.account_member where person_id = t.assignee_person_id))
        from task t where t.id = s.ref and t.deleted_at is null)
      when 'doc' then (select jsonb_build_object('title', d.title, 'updatedAt', d.updated_at, 'author', (select display_name from person where id = d.created_by)) from doc d where d.id = s.ref)
      when 'contract' then (select jsonb_build_object('title', t.title, 'status', t.status) from contract t where t.id = s.ref)
      when 'chat' then (select jsonb_build_object('title', ch.name) from chat_channel ch where ch.id = s.ref)
      else jsonb_build_object('title', s.kind) end;
    select display_name into by_name from person where id = s.created_by;
    perform pulse_priv.conn_leave(was);
    if it is not null then
      items := items || jsonb_build_array(it || jsonb_build_object('id', s.id, 'kind', s.kind, 'ref', s.ref, 'host', s.host_org, 'hostName', (select name from org where id = s.host_org),
        'access', s.access, 'governs', s.governs, 'at', s.created_at, 'revokedAt', s.revoked_at,
        'by', by_name, 'byAccount', (select account_id from pulse_priv.account_member where person_id = s.created_by),
        'mine', s.host_org = current_org()));
    end if;
  end loop;
  -- Money: quotes and invoices of A's client record of B, for whoever may read Billing in A.
  if c.client_id is not null and current_org() = c.a_org and erp_can(false) then
    money := coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'type', d.doc_type, 'number', d.number, 'status', d.status, 'total', d.total,
        'issued', d.issue_date, 'due', d.due_date) order by d.issue_date desc) from erp_document d where d.client_id = c.client_id and d.status <> 'draft'), '[]'::jsonb);
  end if;
  foreach o in array array_remove(array[c.a_org, c.b_org], null) loop
    was := pulse_priv.conn_enter(o, null);
    act := act || coalesce((select jsonb_agg(jsonb_build_object('at', e.at, 'action', e.action, 'who', coalesce((select display_name from person where id = e.actor_id), e.actor_account),
        'note', e.changes ->> 'note', 'where', (select name from org where id = o)) order by e.at desc)
      from (select * from audit_event where org_id = o and resource = 'connection' and resource_id = p_conn::text order by at desc limit 40) e), '[]'::jsonb);
    perform pulse_priv.conn_leave(was);
  end loop;
  return connection_row(p_conn) || jsonb_build_object('items', items, 'money', money, 'activity', act, 'clientId', c.client_id,
    'grants', c.grants, 'endedOn', c.ended_on, 'endReason', c.end_reason);
end $$;

-- ------------------------------------------------------------------------------------------------ making
-- Make a connection from the current space (side A): p = {kind, orgHandle | orgId | accountHandle, aRole, bRole,
-- asPerson (A is me, inside this company), status ('suggested' | 'active'), source, note}. Admins, leadership and HR of a
-- company; the owner of a personal space. The same live connection made twice is found, not made again.
create function pulse.connection_make(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare acct uuid := account_of_viewer(); o org; k text := coalesce(nullif(p ->> 'kind', ''), 'client'); v_borg uuid; v_bacct uuid; v_aacct uuid; v_id uuid; st text;
  src text := coalesce(nullif(p ->> 'source', ''), 'manual'); n text := nullif(btrim(coalesce(p ->> 'note', '')), ''); bh text; ah text;
begin
  perform connection_no_ai();
  if current_viewer() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select * into o from org where id = current_org();
  if not (viewer_is('admin', 'leadership', 'hr') or (o.kind = 'personal' and o.personal_account = acct)) then
    raise exception 'Admins, leadership and HR make connections for a company; you make your own in your personal space' using errcode = '42501'; end if;
  if k not in ('client', 'vendor', 'partner', 'freelancer', 'employee', 'cofounder', 'advisor', 'investor', 'accountant') then
    raise exception 'Choose what they are to you' using errcode = '22023'; end if;
  st := coalesce(nullif(p ->> 'status', ''), case when src = 'backfill' then 'suggested' else 'active' end);
  if st not in ('suggested', 'active') then raise exception 'A new connection is suggested or active' using errcode = '22023'; end if;
  if n is not null and length(n) > 400 then raise exception 'Keep the note under 400 letters' using errcode = '22023'; end if;
  v_aacct := case when o.kind = 'personal' or coalesce((p ->> 'asPerson')::boolean, false) then acct end;
  bh := lower(ltrim(btrim(coalesce(p ->> 'orgHandle', '')), '@')); ah := lower(ltrim(btrim(coalesce(p ->> 'accountHandle', '')), '@'));
  if nullif(p ->> 'orgId', '') is not null then
    select g.id into v_borg from org g where g.id = (p ->> 'orgId')::uuid and g.status = 'active';
  elsif bh <> '' then
    select g.id into v_borg from org g where g.handle = bh and g.status = 'active';
  end if;
  if (nullif(p ->> 'orgId', '') is not null or bh <> '') and v_borg is null then raise exception 'That company is not on Pulse' using errcode = 'P0002'; end if;
  if ah <> '' then
    select a.id into v_bacct from pulse_priv.pulse_account a where a.handle = ah;
    if v_bacct is null then select h.ref into v_bacct from pulse_priv.handle_name h where h.handle = ah and h.kind = 'person'; end if;
    if v_bacct is null then raise exception 'Nobody on Pulse has that handle' using errcode = 'P0002'; end if;
    -- A person with their own personal space: the connection reaches it, where their work lives.
    if v_borg is null then select g.id into v_borg from org g where g.personal_account = v_bacct and g.status = 'active'; end if;
  end if;
  if v_borg is null and v_bacct is null then raise exception 'Choose the person or company' using errcode = '22023'; end if;
  if v_borg = current_org() and v_bacct is null then raise exception 'That is this company itself' using errcode = '22023'; end if;
  if v_borg = current_org() then v_borg := null; end if;       -- a person inside this same company (co-founders): their account
  if v_bacct is not null and v_bacct = acct and v_borg is null then raise exception 'That is you' using errcode = '22023'; end if;
  select c.id into v_id from pulse_priv.org_connection c where c.a_org = current_org() and c.a_account is not distinct from v_aacct
     and c.b_org is not distinct from v_borg and c.b_account is not distinct from v_bacct and c.kind = k and c.status <> 'ended';
  if v_id is not null then return jsonb_build_object('id', v_id, 'existed', true); end if;
  insert into pulse_priv.org_connection(a_org, a_account, b_org, b_account, kind, role, a_role, status, source, note, created_by_account, started_on, grants)
  values (current_org(), v_aacct, v_borg, v_bacct, k, nullif(left(btrim(coalesce(p ->> 'bRole', '')), 80), ''), nullif(left(btrim(coalesce(p ->> 'aRole', '')), 80), ''),
          st, src, n, acct, case when st = 'active' then (now() at time zone org_time_zone())::date end,
          jsonb_build_object('give_tasks', true, 'docs', 'shared', 'ai', 'read'))
  returning org_connection.id into v_id;
  perform pulse_priv.conn_audit(current_org(), v_id, 'made', jsonb_build_object('kind', k, 'status', st, 'source', src, 'note', n,
    'other', coalesce((select g.name from org g where g.id = v_borg), (select a.display_name from pulse_priv.pulse_account a where a.id = v_bacct))));
  if v_borg is not null then perform pulse_priv.conn_audit(v_borg, v_id, 'made', jsonb_build_object('kind', k, 'status', st, 'by', o.name, 'note', n)); end if;
  return jsonb_build_object('id', v_id, 'existed', false);
end $$;

-- A suggested connection is confirmed by its side A (it is real); with no agreement, a draft is made at once.
create function pulse.connection_confirm(p_conn uuid, p_note text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c pulse_priv.org_connection; d jsonb := null;
begin
  perform connection_no_ai();
  select * into c from pulse_priv.org_connection where id = p_conn for update;
  if not found or connection_my_side(p_conn) is distinct from 'a' or current_org() <> c.a_org then
    raise exception 'Only the side it lives with confirms a connection, from there' using errcode = '42501'; end if;
  if c.status not in ('suggested', 'invited', 'paused') then return jsonb_build_object('status', c.status, 'draft', null); end if;
  update pulse_priv.org_connection set status = 'active', started_on = coalesce(started_on, (now() at time zone org_time_zone())::date), updated_at = now() where id = p_conn;
  perform pulse_priv.conn_audit(c.a_org, p_conn, 'confirmed', jsonb_build_object('note', nullif(btrim(coalesce(p_note, '')), '')));
  if (connection_agreement(p_conn) ->> 'state') = 'none' and c.kind <> 'investor' and contract_manager() then d := connection_agreement_draft(p_conn); end if;
  return jsonb_build_object('status', 'active', 'draft', d);
end $$;

-- ------------------------------------------------------------------------------------------------ agreements
-- One draft agreement for a connection that has none, in the space it lives in (side A), by kind; the parties are each
-- side's registered name (org_legal_name) or the person. Never sent: a person reviews it and presses Send.
create function pulse.connection_agreement_draft(p_conn uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c pulse_priv.org_connection; ag jsonb; ck text; ra text; rb text; pa jsonb; pb jsonb; cid uuid; t record; nm text; title text; other text;
begin
  perform connection_no_ai();
  select * into c from pulse_priv.org_connection where id = p_conn;
  if not found or current_org() <> c.a_org or not connection_may_see(p_conn) then raise exception 'Draft it from the space the connection lives in' using errcode = '42501'; end if;
  if not contract_manager() then raise exception 'Admins, leadership and Finance make agreements' using errcode = '42501'; end if;
  if c.status = 'ended' then raise exception 'This connection has ended' using errcode = '22023'; end if;
  ag := connection_agreement(p_conn);
  if ag ->> 'state' in ('draft', 'waiting', 'signed') then return ag || jsonb_build_object('made', false); end if;
  if c.kind = 'investor' then raise exception 'Add the investment papers yourself: Pulse does not draft them' using errcode = '22023'; end if;
  ck := case c.kind when 'partner' then 'revenue_share' when 'cofounder' then 'equity' when 'employee' then 'employment' else 'services' end;
  -- Who provides and who is served (CONNECT-MAP §3.8).
  select case c.kind when 'client' then 'provider' when 'employee' then 'employer' when 'partner' then 'partner' when 'cofounder' then 'partner' else 'client' end,
         case c.kind when 'client' then 'client' when 'employee' then 'employee' when 'partner' then 'partner' when 'cofounder' then 'partner' else 'provider' end into ra, rb;
  -- Side A is this space: its company, or (a person side) the person's own seat here, so the contract has "us" on it.
  pa := case when c.a_account is not null then jsonb_build_object('kind', 'person', 'role', ra,
               'personId', (select m.person_id from pulse_priv.account_member m where m.account_id = c.a_account and m.member_org = c.a_org))
             else jsonb_build_object('kind', 'company', 'role', ra, 'orgId', c.a_org) end;
  pb := case when c.b_org is not null and exists (select 1 from org where id = c.b_org and kind = 'company') then jsonb_build_object('kind', 'company', 'role', rb, 'orgId', c.b_org)
             when c.b_account is not null then jsonb_build_object('kind', 'person', 'role', rb, 'accountId', c.b_account)
             else jsonb_build_object('kind', 'company', 'role', rb, 'name', coalesce((select name from org where id = c.b_org), 'The other side')) end;
  other := coalesce((select name from org where id = c.b_org and kind = 'company'), (select display_name from pulse_priv.pulse_account where id = c.b_account), 'connection');
  title := left(case c.kind when 'client' then 'Service agreement' when 'vendor' then 'Vendor agreement' when 'freelancer' then 'Freelance agreement'
    when 'partner' then 'Partnership agreement' when 'cofounder' then 'Founders'' agreement' when 'advisor' then 'Advisor agreement'
    when 'employee' then 'Appointment letter' when 'accountant' then 'Engagement letter' else 'Agreement' end || ' · ' || other, 160);
  cid := contract_save(null, jsonb_build_object('kind', ck, 'title', title, 'parties', jsonb_build_array(pa, pb)));
  -- The company's own template of this kind when it has one, filled with the parties' names.
  select * into t from contract_template where org_id = current_org() and archived_at is null and kind = ck and client_id is null order by is_default desc, updated_at desc limit 1;
  if t.id is not null then
    nm := coalesce((select name from contract_party where contract_id = cid and position = 2), other);
    update contract set body = contract_fill(t.body, jsonb_build_object('client_name', nm, 'client_contact', nm, 'our_name', org_legal_name(), 'our_legal_name', org_legal_name(),
      'today', to_char((now() at time zone org_time_zone())::date, 'FMDD Mon YYYY'))) where id = cid and org_id = current_org();
    update contract_side set template_id = t.id where contract_id = cid;
  end if;
  update contract_side set notes = left('Pulse drafted this for your connection with ' || other || '. Nothing is sent until a person presses Send. auto-draft:' || p_conn, 5000)
   where contract_id = cid;
  insert into pulse_priv.connect_share(connection_id, host_org, kind, ref, created_by, access, governs) values (p_conn, current_org(), 'contract', cid, current_viewer(), 'read', true)
    on conflict (connection_id, host_org, kind, ref) do update set governs = true, revoked_at = null;
  perform pulse_priv.conn_audit(current_org(), p_conn, 'agreement_drafted', jsonb_build_object('contract', cid, 'title', title));
  return connection_agreement(p_conn) || jsonb_build_object('made', true);
end $$;

-- An agreement that already exists (a founders' draft, a retainer) becomes the connection's own.
create function pulse.connection_agreement_link(p_conn uuid, p_contract uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c pulse_priv.org_connection;
begin
  perform connection_no_ai();
  select * into c from pulse_priv.org_connection where id = p_conn;
  if not found or current_org() <> c.a_org or not connection_may_see(p_conn) then raise exception 'Link it from the space the connection lives in' using errcode = '42501'; end if;
  if not contract_manager() then raise exception 'Admins, leadership and Finance link agreements' using errcode = '42501'; end if;
  if not exists (select 1 from contract where id = p_contract and org_id = current_org()) then raise exception 'That agreement is not in this space' using errcode = 'P0002'; end if;
  update pulse_priv.connect_share set governs = false where connection_id = p_conn and kind = 'contract' and ref <> p_contract;
  insert into pulse_priv.connect_share(connection_id, host_org, kind, ref, created_by, access, governs) values (p_conn, current_org(), 'contract', p_contract, current_viewer(), 'read', true)
    on conflict (connection_id, host_org, kind, ref) do update set governs = true, revoked_at = null;
  perform pulse_priv.conn_audit(current_org(), p_conn, 'agreement_linked', jsonb_build_object('contract', p_contract, 'title', (select title from contract where id = p_contract)));
  return connection_agreement(p_conn);
end $$;

-- ------------------------------------------------------------------------------------------------ shared work
-- The other side's account a share or a task goes to: their own account (a person side), else the contact named (a
-- handle), else the connection's one contact on that side.
create function pulse_priv.conn_other_account(p_conn uuid, p_side text, p_handle text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c pulse_priv.org_connection; v uuid; h text := lower(ltrim(btrim(coalesce(p_handle, '')), '@')); o uuid;
begin
  select * into c from pulse_priv.org_connection where id = p_conn;
  o := case p_side when 'a' then c.b_org else c.a_org end;
  if h <> '' then
    select a.id into v from pulse_priv.pulse_account a where a.handle = h;
    if v is null then raise exception 'Nobody on Pulse has that handle' using errcode = 'P0002'; end if;
    if v is distinct from (case p_side when 'a' then c.b_account else c.a_account end)
       and not exists (select 1 from pulse_priv.account_member m where m.account_id = v and m.member_org = o and m.kind = 'staff')
       and not exists (select 1 from pulse_priv.connect_seat s where s.connection_id = p_conn and s.account_id = v and s.removed_at is null) then
      raise exception 'Choose someone on the other side of this connection' using errcode = '22023'; end if;
    return v;
  end if;
  v := case p_side when 'a' then c.b_account else c.a_account end;
  if v is not null then return v; end if;
  if o is not null and exists (select 1 from org where id = o and kind = 'personal') then return (select personal_account from org where id = o); end if;
  select s.account_id into v from pulse_priv.connect_seat s where s.connection_id = p_conn and s.home_org = o and s.removed_at is null order by s.created_at limit 1;
  if v is null then raise exception 'Name their contact first (their Pulse @handle)' using errcode = '22023'; end if;
  return v;
end $$;

-- The seat an account has in a space for this connection: its own staff seat there, else a guest seat (made once).
create function pulse_priv.conn_seat_in(p_conn uuid, p_account uuid, p_space uuid, p_home_org uuid, p_title text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid; home uuid; was text;
begin
  select m.person_id into v from pulse_priv.account_member m where m.account_id = p_account and m.member_org = p_space;
  if v is not null then
    -- Their person there, read inside that space (forced row security): an inactive one is not a seat.
    was := pulse_priv.conn_enter(p_space, null);
    if not exists (select 1 from person p where p.id = v and p.status = 'active') then v := null; end if;
    perform pulse_priv.conn_leave(was);
  end if;
  if v is not null then
    insert into pulse_priv.connect_seat(connection_id, account_id, home_org, home_person, seat_org, seat_person)
    values (p_conn, p_account, p_home_org, (select person_id from pulse_priv.account_member where account_id = p_account and member_org = p_home_org), p_space, v)
    on conflict (connection_id, account_id) do nothing;
    return v;
  end if;
  home := (select person_id from pulse_priv.account_member where account_id = p_account and member_org = p_home_org);
  return connect_seat_make(p_conn, p_account, p_home_org, home, p_space, 'client', p_title);
end $$;
revoke all on function pulse_priv.conn_other_account(uuid, text, text), pulse_priv.conn_seat_in(uuid, uuid, uuid, uuid, text) from public;

-- Give a task across a connection (CONNECT-MAP §3.6): it is made in the doer's own space as their task, with the giver as
-- its reviewer; when the doer has no space of their own yet, it waits here on their guest seat.
create function pulse.connection_task_give(p_conn uuid, p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c pulse_priv.org_connection; side text; doer_acct uuid; giver_acct uuid := account_of_viewer(); me uuid := current_viewer(); target uuid; doer uuid; giver_seat uuid;
  was text; tid uuid; giver_name text; title text := btrim(coalesce(p ->> 'title', '')); landed text;
begin
  perform connection_no_ai();
  select * into c from pulse_priv.org_connection where id = p_conn;
  side := connection_my_side(p_conn);
  if not found or side is null or not connection_may_see(p_conn) then raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if c.status <> 'active' then raise exception 'Confirm the connection first' using errcode = '22023'; end if;
  if coalesce((c.grants ->> 'give_tasks')::boolean, true) is false then raise exception 'Tasks are not given through this connection' using errcode = '42501'; end if;
  if length(title) < 2 or length(title) > 300 then raise exception 'Give the task a short title' using errcode = '22023'; end if;
  if giver_acct is null then raise exception 'Sign in with your own account to give work across' using errcode = '42501'; end if;
  doer_acct := pulse_priv.conn_other_account(p_conn, side, p ->> 'toHandle');
  select display_name into giver_name from person where id = me;
  -- The doer's own space: a personal space of theirs on the other side, else the other side's company where they are staff.
  target := case side when 'a' then c.b_org else c.a_org end;
  if target is not null then
    select m.person_id into doer from pulse_priv.account_member m where m.account_id = doer_acct and m.member_org = target and m.kind = 'staff';
    if doer is not null then
      -- Their person is read inside their space (forced row security).
      was := pulse_priv.conn_enter(target, null);
      if not exists (select 1 from person pr where pr.id = doer and pr.status = 'active') then doer := null; end if;
      perform pulse_priv.conn_leave(was);
    end if;
  end if;
  if doer is null then
    -- Not in a space of their own yet: the task waits here, on their guest seat.
    target := current_org(); landed := 'here';
    doer := pulse_priv.conn_seat_in(p_conn, doer_acct, current_org(), case side when 'a' then c.b_org else c.a_org end, coalesce(case side when 'a' then c.role else c.a_role end, 'Connection'));
    tid := task_save(null, jsonb_build_object('title', title, 'notes', coalesce(p ->> 'notes', ''), 'dueOn', nullif(p ->> 'dueOn', ''), 'assigneeId', me, 'reviewerId', null));
    update task set assignee_person_id = doer, owner_id = doer, review_owner_id = me, assigned_at = now() where id = tid;
    giver_seat := me;
  else
    landed := 'theirs';
    giver_seat := pulse_priv.conn_seat_in(p_conn, giver_acct, target, current_org(), 'Gives work through a connection');
    was := pulse_priv.conn_enter(target, doer);
    tid := task_save(null, jsonb_build_object('title', title, 'notes', coalesce(p ->> 'notes', ''), 'dueOn', nullif(p ->> 'dueOn', ''), 'assigneeId', doer, 'reviewerId', null));
    update task set review_owner_id = giver_seat, created_by = giver_seat where id = tid and org_id = target;
    perform task_event_add(tid, 'assigned', null, 'Given by ' || coalesce(giver_name, 'a connection') || ' through your connection');
    perform pulse_priv.conn_leave(was);
  end if;
  insert into pulse_priv.connect_share(connection_id, host_org, kind, ref, created_by, access) values (p_conn, target, 'task', tid, giver_seat, 'do');
  perform pulse_priv.conn_audit(current_org(), p_conn, 'task_given', jsonb_build_object('task', tid, 'title', title, 'in', (select name from org where id = target)));
  if target <> current_org() then perform pulse_priv.conn_audit(target, p_conn, 'task_given', jsonb_build_object('task', tid, 'title', title, 'by', giver_name)); end if;
  return jsonb_build_object('task', tid, 'org', target, 'orgName', (select name from org where id = target), 'landed', landed);
end $$;

-- Share a doc of this space with the other side of a connection (read, comment or edit), through their guest seat here.
create function pulse.connection_doc_share(p_conn uuid, p_doc uuid, p_access text, p_handle text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c pulse_priv.org_connection; side text; acct uuid; seat uuid; me uuid := current_viewer(); d record;
begin
  perform connection_no_ai();
  select * into c from pulse_priv.org_connection where id = p_conn;
  side := connection_my_side(p_conn);
  if not found or side is null or not connection_may_see(p_conn) then raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if c.status <> 'active' then raise exception 'Confirm the connection first' using errcode = '22023'; end if;
  if coalesce(c.grants ->> 'docs', 'shared') = 'none' then raise exception 'Docs are not shared through this connection' using errcode = '42501'; end if;
  if p_access is null or p_access not in ('read', 'comment', 'edit') then raise exception 'Choose read, comment or edit' using errcode = '22023'; end if;
  select id, title, access into d from doc where id = p_doc and org_id = current_org();
  if d.id is null or not doc_id_can_share(p_doc) then raise exception 'You can share only docs of this space that you may share' using errcode = '42501'; end if;
  acct := pulse_priv.conn_other_account(p_conn, side, p_handle);
  seat := pulse_priv.conn_seat_in(p_conn, acct, current_org(), case side when 'a' then c.b_org else c.a_org end, 'Shares docs through a connection');
  if d.access = 'private' then update doc set access = 'people' where id = p_doc and org_id = current_org(); end if;
  insert into doc_share(org_id, doc_id, person_id, can_edit, can_comment, added_by) values (current_org(), p_doc, seat, p_access = 'edit', p_access in ('comment', 'edit'), me)
    on conflict (doc_id, person_id) do update set can_edit = excluded.can_edit, can_comment = excluded.can_comment;
  insert into pulse_priv.connect_share(connection_id, host_org, kind, ref, created_by, access) values (p_conn, current_org(), 'doc', p_doc, me, p_access)
    on conflict (connection_id, host_org, kind, ref) do update set access = excluded.access, revoked_at = null, revoked_by = null;
  perform pulse_priv.conn_audit(current_org(), p_conn, 'doc_shared', jsonb_build_object('doc', p_doc, 'title', d.title, 'access', p_access,
    'with', (select display_name from pulse_priv.pulse_account where id = acct)));
  return jsonb_build_object('doc', p_doc, 'access', p_access, 'seat', seat);
end $$;

create function pulse.connection_doc_unshare(p_conn uuid, p_doc uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer();
begin
  perform connection_no_ai();
  if connection_my_side(p_conn) is null or not exists (select 1 from doc where id = p_doc and org_id = current_org()) or not doc_id_can_share(p_doc) then
    raise exception 'You can stop sharing only docs of this space that you may share' using errcode = '42501'; end if;
  delete from doc_share s where s.org_id = current_org() and s.doc_id = p_doc
     and s.person_id in (select seat_person from pulse_priv.connect_seat where connection_id = p_conn and seat_org = current_org())
     and not exists (select 1 from person p where p.id = s.person_id and p.side = 'staff');
  update pulse_priv.connect_share set revoked_at = now(), revoked_by = me where connection_id = p_conn and host_org = current_org() and kind = 'doc' and ref = p_doc and revoked_at is null;
  perform pulse_priv.conn_audit(current_org(), p_conn, 'doc_unshared', jsonb_build_object('doc', p_doc, 'title', (select title from doc where id = p_doc)));
end $$;

-- End a connection (either side): every doc share closes, guest seats end, the history stays.
create function pulse.connection_end(p_conn uuid, p_reason text) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c pulse_priv.org_connection; s record; was text;
begin
  perform connection_no_ai();
  select * into c from pulse_priv.org_connection where id = p_conn for update;
  if not found or connection_my_side(p_conn) is null then raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if c.status = 'ended' then return; end if;
  for s in select * from pulse_priv.connect_share where connection_id = p_conn and kind = 'doc' and revoked_at is null loop
    was := pulse_priv.conn_enter(s.host_org, null);
    delete from doc_share d where d.org_id = s.host_org and d.doc_id = s.ref
       and d.person_id in (select seat_person from pulse_priv.connect_seat where connection_id = p_conn and seat_org = s.host_org)
       and not exists (select 1 from person p where p.id = d.person_id and p.side = 'staff');
    perform pulse_priv.conn_leave(was);
  end loop;
  update pulse_priv.connect_share set revoked_at = now(), revoked_by = current_viewer() where connection_id = p_conn and revoked_at is null and kind <> 'task';
  update pulse_priv.connect_seat set removed_at = now() where connection_id = p_conn and removed_at is null;
  update pulse_priv.org_connection set status = 'ended', ended_on = (now() at time zone org_time_zone())::date,
    end_reason = nullif(left(btrim(coalesce(p_reason, '')), 400), ''), updated_at = now() where id = p_conn;
  perform pulse_priv.conn_audit(c.a_org, p_conn, 'ended', jsonb_build_object('note', nullif(btrim(coalesce(p_reason, '')), '')));
  if c.b_org is not null then perform pulse_priv.conn_audit(c.b_org, p_conn, 'ended', jsonb_build_object('note', nullif(btrim(coalesce(p_reason, '')), ''))); end if;
end $$;

-- ------------------------------------------------------------------------------------------------ docs for guest seats
-- A connection's guest seat (a client or partner person with a connect_seat) sees, and with an edit share edits, only the
-- docs shared with it (doc_share); staff and AI helpers keep 1716's rules.
create function pulse.doc_guest_share(p_doc uuid) returns pulse.doc_share
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select s.* from doc_share s join person p on p.id = s.person_id
   where s.org_id = current_org() and s.doc_id = p_doc and s.person_id = current_viewer() and p.side in ('client', 'partner') and p.status = 'active'
     and exists (select 1 from pulse_priv.connect_seat cs where cs.seat_person = s.person_id and cs.removed_at is null)
$$;
create or replace function pulse.doc_can_see(p_doc uuid, p_access text, p_owner uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select (doc_member_ok() and (p_owner = current_viewer() or ((p_access = 'company'
   or (p_access = 'people' and exists(select 1 from doc_share s where s.org_id = current_org() and s.doc_id = p_doc and s.person_id = current_viewer())))
   and doc_folder_can_see((select d.folder_id from doc d where d.org_id = current_org() and d.id = p_doc)))))
   or (current_viewer() is not null and (doc_guest_share(p_doc)).doc_id is not null)
$$;
create or replace function pulse.doc_can_edit(p_doc uuid, p_access text, p_owner uuid, p_company_edits boolean) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select (doc_member_ok() and (p_owner = current_viewer() or (((p_access = 'company' and (p_company_edits or viewer_is('admin')))
   or (p_access = 'people' and exists(select 1 from doc_share s where s.org_id = current_org() and s.doc_id = p_doc and s.person_id = current_viewer() and s.can_edit)))
   and doc_folder_can_see((select d.folder_id from doc d where d.org_id = current_org() and d.id = p_doc)))))
   or (current_viewer() is not null and coalesce((doc_guest_share(p_doc)).can_edit, false))
$$;

-- ------------------------------------------------------------------------------------------------ never sent by AI
-- CONNECT-MAP §3.8: Pulse and AI helpers never send, sign or accept an agreement; a person does.
create function pulse.contract_no_ai_send() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if agent_session() is null then return new; end if;
  -- Nested: each table's own fields are read only for that table.
  if tg_table_name = 'contract' then
    if old.status = 'draft' and new.status <> 'draft' then
      raise exception 'An AI helper does not send agreements: a person presses Send' using errcode = '42501'; end if;
  elsif tg_table_name = 'contract_party' then
    if new.accepted_at is not null and old.accepted_at is null then
      raise exception 'An AI helper does not sign or accept agreements' using errcode = '42501'; end if;
  end if;
  return new;
end $$;
create trigger contract_no_ai_send before update on pulse.contract for each row execute function pulse.contract_no_ai_send();
create trigger contract_party_no_ai_sign before update on pulse.contract_party for each row execute function pulse.contract_no_ai_send();

revoke all on function pulse.connection_no_ai(), pulse.connection_side(uuid, uuid), pulse.connection_may_see(uuid), pulse.connection_my_side(uuid),
  pulse.connection_agreement(uuid), pulse.connection_row(uuid), pulse.connection_here(), pulse.connection_get(uuid), pulse.connection_make(jsonb),
  pulse.connection_confirm(uuid, text), pulse.connection_agreement_draft(uuid), pulse.connection_agreement_link(uuid, uuid), pulse.connection_task_give(uuid, jsonb),
  pulse.connection_doc_share(uuid, uuid, text, text), pulse.connection_doc_unshare(uuid, uuid), pulse.connection_end(uuid, text), pulse.doc_guest_share(uuid) from public;
grant execute on function pulse.connection_here(), pulse.connection_get(uuid), pulse.connection_make(jsonb), pulse.connection_confirm(uuid, text),
  pulse.connection_agreement_draft(uuid), pulse.connection_agreement_link(uuid, uuid), pulse.connection_task_give(uuid, jsonb),
  pulse.connection_doc_share(uuid, uuid, text, text), pulse.connection_doc_unshare(uuid, uuid), pulse.connection_end(uuid, text), pulse.doc_guest_share(uuid),
  pulse.connection_agreement(uuid), pulse.connection_may_see(uuid), pulse.connection_my_side(uuid) to pulse_api;

-- migrate:down
drop trigger if exists contract_party_no_ai_sign on pulse.contract_party;
drop trigger if exists contract_no_ai_send on pulse.contract;
drop function if exists pulse.contract_no_ai_send();
-- pulse.doc_can_see / doc_can_edit: their previous bodies are 1716_docs_organize.sql.
drop function if exists pulse.connection_end(uuid, text), pulse.connection_doc_unshare(uuid, uuid), pulse.connection_doc_share(uuid, uuid, text, text),
  pulse.connection_task_give(uuid, jsonb), pulse_priv.conn_seat_in(uuid, uuid, uuid, uuid, text), pulse_priv.conn_other_account(uuid, text, text),
  pulse.connection_agreement_link(uuid, uuid), pulse.connection_agreement_draft(uuid), pulse.connection_confirm(uuid, text), pulse.connection_make(jsonb),
  pulse.connection_get(uuid), pulse.connection_here(), pulse.connection_row(uuid), pulse.connection_agreement(uuid), pulse_priv.conn_audit(uuid, uuid, text, jsonb),
  pulse.connection_my_side(uuid), pulse.connection_may_see(uuid), pulse.connection_side(uuid, uuid), pulse.connection_no_ai(),
  pulse_priv.conn_leave(text), pulse_priv.conn_enter(uuid, uuid);
