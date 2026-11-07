-- migrate:up
-- CONNECTORS-CONTRACTS (owner, 6 Nov 2026): contracts between two parties, where a party is a company or a person
-- (docs/spec/CONTRACTS.md; FOUNDATIONS.md §5 designed the company-to-company case). Vitals OS never lets one company read
-- another's rows, so a contract is one copy per company that is a party, joined by contract_key, and the functions below
-- keep the shared part (terms, parties and their acceptance, versions, transactions) the same in every copy by
-- switching the company inside the function (as 1115 lists an account's companies). Each company's own side (notes,
-- who answers for it, links to its projects, tasks and invoices, which ledger entry a transaction is tied to) never
-- leaves its copy. Inside a company, contract managers (admins, leadership, Finance) see and change its contracts; a
-- person who is a party sees the shared part and accepts their own side. pulse.my_contracts() lists an account's
-- contracts in every company. All tables: forced row security with a tenant policy; writes only through the functions.
-- Also: two API v1 areas, contracts and connectors (1584 builds the connectors).

create table pulse.contract (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  contract_key uuid not null default gen_random_uuid(),
  home_org uuid not null references pulse.org(id),
  version int not null default 1 check (version between 1 and 10000),
  status text not null default 'draft' check (status in ('draft', 'proposed', 'active', 'ended', 'cancelled')),
  kind text not null check (kind in ('employment', 'retainer', 'services', 'revenue_share', 'equity')),
  title text not null check (length(btrim(title)) between 1 and 160 and title !~ '[[:cntrl:]]'),
  scope text not null default '' check (length(scope) <= 20000),
  deliverables jsonb not null default '[]' check (jsonb_typeof(deliverables) = 'array' and jsonb_array_length(deliverables) <= 100),
  rates jsonb not null default '[]' check (jsonb_typeof(rates) = 'array' and jsonb_array_length(rates) <= 50),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  schedule text not null default 'monthly' check (schedule in ('monthly', 'quarterly', 'milestones', 'on_delivery', 'one_off')),
  starts_on date,
  ends_on date,
  notice_days int check (notice_days between 0 and 3650),
  template text check (template in ('retainer', 'services', 'employment', 'revenue_share')),
  ended_on date,
  end_reason text check (length(end_reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, contract_key),
  constraint contract_dates check (ends_on is null or starts_on is null or ends_on >= starts_on)
);
create index contract_org_status on pulse.contract(org_id, status, updated_at desc);

-- Own side: only this company's managers read it.
create table pulse.contract_side (
  org_id uuid not null references pulse.org(id),
  contract_id uuid primary key references pulse.contract(id),
  notes text check (length(notes) <= 5000),
  owner_person_id uuid references pulse.person(id),
  -- FOUNDATIONS §5's counterparty_client_id: the other side as our client (we provide) or vendor (we are served) record.
  client_id uuid references pulse.client(id),
  created_by uuid references pulse.person(id),
  updated_at timestamptz not null default now()
);

create table pulse.contract_party (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references pulse.contract(id),
  party_key uuid not null default gen_random_uuid(),
  position int not null default 0 check (position between 0 and 20),
  kind text not null check (kind in ('company', 'person')),
  role text not null check (role in ('provider', 'client', 'employer', 'employee', 'partner')),
  party_org uuid references pulse.org(id),          -- a company on Vitals OS (this one included)
  party_person_id uuid references pulse.person(id), -- a person of THIS copy's company
  party_account uuid,                               -- a person anywhere, by their account (pulse_priv.pulse_account)
  name text not null check (length(btrim(name)) between 1 and 160 and name !~ '[[:cntrl:]]'),
  accepted_at timestamptz,
  accepted_version int,
  accepted_by_name text check (length(accepted_by_name) <= 160),
  accepted_note text check (length(accepted_note) <= 300),
  unique (contract_id, party_key),
  constraint contract_party_shape check ((kind = 'company' and party_person_id is null and party_account is null)
    or (kind = 'person' and party_org is null))
);
create index contract_party_person on pulse.contract_party(org_id, party_person_id) where party_person_id is not null;
create index contract_party_account on pulse.contract_party(org_id, party_account) where party_account is not null;
create index contract_party_org on pulse.contract_party(org_id, party_org) where party_org is not null;

create table pulse.contract_version (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references pulse.contract(id),
  version int not null,
  terms jsonb not null check (jsonb_typeof(terms) = 'object'),
  changed_by_name text,
  changed_at timestamptz not null default now(),
  unique (contract_id, version)
);

create table pulse.contract_link (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references pulse.contract(id),
  project_id uuid references pulse.project(id),
  task_id uuid references pulse.task(id),
  erp_document_id uuid references pulse.erp_document(id),
  goal_id uuid references pulse.goal(id),
  added_by uuid references pulse.person(id),
  added_at timestamptz not null default now(),
  constraint contract_link_one check (num_nonnulls(project_id, task_id, erp_document_id, goal_id) = 1)
);
create unique index contract_link_unique on pulse.contract_link(contract_id, coalesce(project_id, task_id, erp_document_id, goal_id));

create table pulse.contract_txn (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references pulse.contract(id),
  txn_key uuid not null default gen_random_uuid(),
  kind text not null check (kind in ('invoice', 'retainer', 'payout', 'payment')),
  payer_key uuid not null,
  payee_key uuid not null,
  label text not null check (length(btrim(label)) between 1 and 160 and label !~ '[[:cntrl:]]'),
  amount_minor bigint not null check (amount_minor between 1 and 9000000000000),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'billed' check (status in ('billed', 'paid', 'void')),
  due_on date,
  paid_on date,
  -- own side: this company's own money record for it
  erp_document_id uuid references pulse.erp_document(id),
  fin_entry_id uuid references pulse.fin_entry(id),
  created_by_name text,
  created_at timestamptz not null default now(),
  unique (contract_id, txn_key),
  constraint contract_txn_sides check (payer_key <> payee_key)
);

-- ------------------------------------------------------------------------------------------------ who may
create function pulse.contract_manager() returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and agent_session() is null and not viewer_outside_seat()
   and exists(select 1 from person p where p.org_id = current_org() and p.id = current_viewer() and p.side = 'staff' and p.status = 'active')
   and viewer_is('admin', 'leadership', 'finance')
$$;

-- The viewer is a party of this copy: as its person here, or by their account.
create function pulse.contract_is_party(p_contract uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and exists(select 1 from contract_party p where p.org_id = current_org() and p.contract_id = p_contract
   and (p.party_person_id = current_viewer() or (p.party_account is not null and p.party_account = account_of_viewer())))
$$;

create function pulse.contract_can_see(p_contract uuid, p_status text) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select contract_manager() or (p_status <> 'draft' and contract_is_party(p_contract))
$$;

-- ------------------------------------------------------------------------------------------------ row security
alter table pulse.contract enable row level security;
alter table pulse.contract force row level security;
create policy tenant_isolation on pulse.contract using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy contract_see on pulse.contract as restrictive for select to pulse_api using (pulse.contract_can_see(id, status));

alter table pulse.contract_side enable row level security;
alter table pulse.contract_side force row level security;
create policy tenant_isolation on pulse.contract_side using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy contract_side_see on pulse.contract_side as restrictive for select to pulse_api using (pulse.contract_manager());

alter table pulse.contract_link enable row level security;
alter table pulse.contract_link force row level security;
create policy tenant_isolation on pulse.contract_link using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy contract_link_see on pulse.contract_link as restrictive for select to pulse_api using (pulse.contract_manager());
create policy contract_link_insert on pulse.contract_link as restrictive for insert to pulse_api
  with check (pulse.contract_manager() and added_by = pulse.current_viewer()
    and exists(select 1 from pulse.contract c where c.id = contract_id)
    and (project_id is null or exists(select 1 from pulse.project p where p.id = project_id))
    and (task_id is null or exists(select 1 from pulse.task t where t.id = task_id))
    and (erp_document_id is null or exists(select 1 from pulse.erp_document d where d.id = erp_document_id))
    and (goal_id is null or exists(select 1 from pulse.goal g where g.id = goal_id)));
create policy contract_link_delete on pulse.contract_link as restrictive for delete to pulse_api using (pulse.contract_manager());

do $$ declare t text; begin
 foreach t in array array['contract_party', 'contract_version', 'contract_txn'] loop
  execute format('alter table pulse.%I enable row level security', t);
  execute format('alter table pulse.%I force row level security', t);
  execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  execute format('create policy %I on pulse.%I as restrictive for select to pulse_api using (exists(select 1 from pulse.contract c where c.id = contract_id))', t || '_see', t);
 end loop;
end $$;

grant select on pulse.contract, pulse.contract_side, pulse.contract_party, pulse.contract_version, pulse.contract_txn to pulse_api;
grant select, insert, delete on pulse.contract_link to pulse_api;

-- ------------------------------------------------------------------------------------------------ keeping copies in step
-- The shared part of a contract as one object (what every copy holds the same).
create function pulse.contract_terms(c pulse.contract) returns jsonb language sql stable as $$
 select jsonb_build_object('kind', c.kind, 'title', c.title, 'scope', c.scope, 'deliverables', c.deliverables, 'rates', c.rates,
   'currency', c.currency, 'schedule', c.schedule, 'startsOn', c.starts_on, 'endsOn', c.ends_on, 'noticeDays', c.notice_days)
$$;

-- Push this copy's shared part to every other company that is a party (making its copy on first send).
create function pulse.contract_push(p_contract uuid) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c contract; src uuid := current_org(); t uuid; tid uuid; parties jsonb; versions jsonb; txns jsonb; x jsonb;
begin
 select * into c from contract where org_id = src and id = p_contract;
 if not found or c.status = 'draft' then return; end if;
 select coalesce(jsonb_agg(jsonb_build_object('party_key', p.party_key, 'position', p.position, 'kind', p.kind, 'role', p.role, 'party_org', p.party_org,
   'party_account', coalesce(p.party_account, (select m.account_id from pulse_priv.account_member m where m.person_id = p.party_person_id)),
   'name', p.name, 'accepted_at', p.accepted_at, 'accepted_version', p.accepted_version, 'accepted_by_name', p.accepted_by_name,
   'accepted_note', p.accepted_note)), '[]') into parties from contract_party p where p.org_id = src and p.contract_id = c.id;
 select coalesce(jsonb_agg(jsonb_build_object('version', v.version, 'terms', v.terms, 'changed_by_name', v.changed_by_name, 'changed_at', v.changed_at)), '[]')
   into versions from contract_version v where v.org_id = src and v.contract_id = c.id;
 select coalesce(jsonb_agg(jsonb_build_object('txn_key', tx.txn_key, 'kind', tx.kind, 'payer_key', tx.payer_key, 'payee_key', tx.payee_key, 'label', tx.label,
   'amount_minor', tx.amount_minor, 'currency', tx.currency, 'status', tx.status, 'due_on', tx.due_on, 'paid_on', tx.paid_on,
   'created_by_name', tx.created_by_name, 'created_at', tx.created_at)), '[]') into txns from contract_txn tx where tx.org_id = src and tx.contract_id = c.id;
 for t in select distinct p.party_org from contract_party p where p.org_id = src and p.contract_id = c.id and p.party_org is not null and p.party_org <> src loop
  if not exists(select 1 from org where id = t and status = 'active') then continue; end if;
  perform set_config('pulse.org_id', t::text, true);
  select id into tid from contract where org_id = t and contract_key = c.contract_key;
  if tid is null then
   insert into contract(org_id, contract_key, home_org, version, status, kind, title, scope, deliverables, rates, currency, schedule, starts_on, ends_on,
     notice_days, template, ended_on, end_reason)
   values (t, c.contract_key, c.home_org, c.version, c.status, c.kind, c.title, c.scope, c.deliverables, c.rates, c.currency, c.schedule, c.starts_on,
     c.ends_on, c.notice_days, c.template, c.ended_on, c.end_reason) returning id into tid;
  else
   update contract set version = c.version, status = c.status, kind = c.kind, title = c.title, scope = c.scope, deliverables = c.deliverables,
     rates = c.rates, currency = c.currency, schedule = c.schedule, starts_on = c.starts_on, ends_on = c.ends_on, notice_days = c.notice_days,
     template = c.template, ended_on = c.ended_on, end_reason = c.end_reason, updated_at = now()
    where org_id = t and id = tid;
  end if;
  for x in select * from jsonb_array_elements(parties) loop
   insert into contract_party(org_id, contract_id, party_key, position, kind, role, party_org, party_account, name, accepted_at, accepted_version, accepted_by_name, accepted_note)
   values (t, tid, (x->>'party_key')::uuid, (x->>'position')::int, x->>'kind', x->>'role', (x->>'party_org')::uuid, (x->>'party_account')::uuid, x->>'name',
     (x->>'accepted_at')::timestamptz, (x->>'accepted_version')::int, x->>'accepted_by_name', x->>'accepted_note')
   on conflict (contract_id, party_key) do update set name = excluded.name, role = excluded.role, accepted_at = excluded.accepted_at,
     accepted_version = excluded.accepted_version, accepted_by_name = excluded.accepted_by_name, accepted_note = excluded.accepted_note;
  end loop;
  for x in select * from jsonb_array_elements(versions) loop
   insert into contract_version(org_id, contract_id, version, terms, changed_by_name, changed_at)
   values (t, tid, (x->>'version')::int, x->'terms', x->>'changed_by_name', (x->>'changed_at')::timestamptz) on conflict (contract_id, version) do nothing;
  end loop;
  for x in select * from jsonb_array_elements(txns) loop
   insert into contract_txn(org_id, contract_id, txn_key, kind, payer_key, payee_key, label, amount_minor, currency, status, due_on, paid_on, created_by_name, created_at)
   values (t, tid, (x->>'txn_key')::uuid, x->>'kind', (x->>'payer_key')::uuid, (x->>'payee_key')::uuid, x->>'label', (x->>'amount_minor')::bigint,
     x->>'currency', x->>'status', (x->>'due_on')::date, (x->>'paid_on')::date, x->>'created_by_name', (x->>'created_at')::timestamptz)
   on conflict (contract_id, txn_key) do update set status = excluded.status, paid_on = excluded.paid_on, due_on = excluded.due_on, label = excluded.label;
  end loop;
  tid := null;
 end loop;
 perform set_config('pulse.org_id', src::text, true);
end $$;

-- Who is changing it, by name (for versions and acceptances).
create function pulse.contract_actor_name() returns text language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select display_name from person where org_id = current_org() and id = current_viewer()), 'Someone')
$$;

-- Active when every party accepted the current version; back to proposed when one has not.
create function pulse.contract_settle(p_contract uuid) returns text
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c contract; open int;
begin
 select * into c from contract where org_id = current_org() and id = p_contract;
 if c.status not in ('proposed', 'active') then return c.status; end if;
 select count(*) into open from contract_party where org_id = current_org() and contract_id = p_contract and (accepted_version is distinct from c.version);
 update contract set status = case when open = 0 then 'active' else 'proposed' end, updated_at = now() where org_id = current_org() and id = p_contract;
 return case when open = 0 then 'active' else 'proposed' end;
end $$;

-- ------------------------------------------------------------------------------------------------ writes
-- Make (p_id null) or change a contract. p: kind, title, scope, deliverables, rates, currency, schedule, startsOn, endsOn,
-- noticeDays, template; parties (only while a draft): [{kind, role, name, orgId, personId, accountId}]; own side: notes, ownerId.
create function pulse.contract_save(p_id uuid, p jsonb) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c contract; cid uuid := p_id; old jsonb; fresh jsonb; x jsonb; n int := 0; mine boolean := false; acct uuid; pname text;
begin
 if not contract_manager() then raise exception 'Admins, leadership and Finance make and change contracts' using errcode = '42501'; end if;
 if cid is null then
  insert into contract(org_id, home_org, kind, title) values (current_org(), current_org(), coalesce(p->>'kind', 'services'), coalesce(nullif(btrim(p->>'title'), ''), 'Untitled contract'))
   returning id into cid;
  insert into contract_side(org_id, contract_id, created_by) values (current_org(), cid, current_viewer());
 end if;
 select * into c from contract where org_id = current_org() and id = cid for update;
 if not found then raise exception 'No such contract in this company' using errcode = 'P0002'; end if;
 if c.status in ('ended', 'cancelled') then raise exception 'This contract has ended; make a new one' using errcode = '22023'; end if;
 old := contract_terms(c);
 update contract set
   kind = coalesce(p->>'kind', kind), title = coalesce(nullif(btrim(p->>'title'), ''), title), scope = coalesce(p->>'scope', scope),
   deliverables = coalesce(p->'deliverables', deliverables), rates = coalesce(p->'rates', rates), currency = coalesce(p->>'currency', currency),
   schedule = coalesce(p->>'schedule', schedule),
   starts_on = case when p ? 'startsOn' then (p->>'startsOn')::date else starts_on end,
   ends_on = case when p ? 'endsOn' then (p->>'endsOn')::date else ends_on end,
   notice_days = case when p ? 'noticeDays' then (p->>'noticeDays')::int else notice_days end,
   template = case when p ? 'template' then p->>'template' else template end, updated_at = now()
  where org_id = current_org() and id = cid returning * into c;
 fresh := contract_terms(c);
 -- A change to the terms after a draft is a new version: the old terms are kept and every acceptance is cleared.
 if p_id is not null and fresh is distinct from old and c.status <> 'draft' then
  insert into contract_version(org_id, contract_id, version, terms, changed_by_name) values (current_org(), cid, c.version, old, contract_actor_name());
  update contract set version = version + 1, status = 'proposed' where org_id = current_org() and id = cid;
  update contract_party set accepted_at = null, accepted_version = null, accepted_by_name = null, accepted_note = null where org_id = current_org() and contract_id = cid;
 end if;
 if p ? 'parties' then
  if c.status <> 'draft' then raise exception 'The parties are fixed once a contract is sent' using errcode = '22023'; end if;
  delete from contract_party where org_id = current_org() and contract_id = cid;
  for x in select * from jsonb_array_elements(p->'parties') loop
   n := n + 1;
   if x->>'kind' = 'company' and nullif(x->>'orgId', '') is not null then
    if not exists(select 1 from org where id = (x->>'orgId')::uuid and status = 'active') then raise exception 'That company is not on Vitals OS' using errcode = '22023'; end if;
    pname := coalesce(nullif(btrim(x->>'name'), ''), (select name from org where id = (x->>'orgId')::uuid));
    if (x->>'orgId')::uuid = current_org() then mine := true; end if;
    insert into contract_party(org_id, contract_id, position, kind, role, party_org, name) values (current_org(), cid, n, 'company', x->>'role', (x->>'orgId')::uuid, pname);
   elsif x->>'kind' = 'person' and nullif(x->>'personId', '') is not null then
    select display_name into pname from person where org_id = current_org() and id = (x->>'personId')::uuid and side in ('staff', 'freelancer', 'client');
    if pname is null then raise exception 'That person is not in this company' using errcode = '22023'; end if;
    mine := true;
    insert into contract_party(org_id, contract_id, position, kind, role, party_person_id, party_account, name)
    values (current_org(), cid, n, 'person', x->>'role', (x->>'personId')::uuid, (select m.account_id from pulse_priv.account_member m where m.person_id = (x->>'personId')::uuid),
      coalesce(nullif(btrim(x->>'name'), ''), pname));
   elsif x->>'kind' = 'person' and nullif(x->>'accountId', '') is not null then
    select display_name into pname from pulse_priv.pulse_account where id = (x->>'accountId')::uuid;
    if pname is null then raise exception 'No Vitals OS account has that handle or e-mail' using errcode = '22023'; end if;
    insert into contract_party(org_id, contract_id, position, kind, role, party_account, name) values (current_org(), cid, n, 'person', x->>'role', (x->>'accountId')::uuid,
      coalesce(nullif(btrim(x->>'name'), ''), pname));
   else
    -- A company or a person off Vitals OS, by name only.
    insert into contract_party(org_id, contract_id, position, kind, role, name) values (current_org(), cid, n, coalesce(x->>'kind', 'company'), x->>'role', x->>'name');
   end if;
  end loop;
  if n < 2 then raise exception 'A contract has at least two parties' using errcode = '22023'; end if;
  if not mine then raise exception 'This company, or one of its people, must be a party' using errcode = '22023'; end if;
 end if;
 if p ? 'notes' or p ? 'ownerId' or p ? 'clientId' then
  insert into contract_side(org_id, contract_id) values (current_org(), cid) on conflict (contract_id) do nothing;
  update contract_side set notes = case when p ? 'notes' then nullif(btrim(p->>'notes'), '') else notes end,
    owner_person_id = case when p ? 'ownerId' then nullif(p->>'ownerId', '')::uuid else owner_person_id end,
    client_id = case when p ? 'clientId' then nullif(p->>'clientId', '')::uuid else client_id end, updated_at = now()
   where org_id = current_org() and contract_id = cid;
 end if;
 perform contract_settle(cid);
 perform contract_push(cid);
 return cid;
end $$;

-- Send a draft: proposed, and a copy appears in every other company that is a party.
create function pulse.contract_send(p_id uuid) returns text
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c contract;
begin
 if not contract_manager() then raise exception 'Admins, leadership and Finance send contracts' using errcode = '42501'; end if;
 select * into c from contract where org_id = current_org() and id = p_id for update;
 if not found then raise exception 'No such contract in this company' using errcode = 'P0002'; end if;
 if c.status <> 'draft' then raise exception 'This contract was already sent' using errcode = '22023'; end if;
 if (select count(*) from contract_party where org_id = current_org() and contract_id = p_id) < 2 then
  raise exception 'Name both parties before sending' using errcode = '22023'; end if;
 update contract set status = 'proposed', updated_at = now() where org_id = current_org() and id = p_id;
 perform contract_settle(p_id);
 perform contract_push(p_id);
 return 'proposed';
end $$;

-- Accept the current version for one party of this copy: this company (a manager), a company off Vitals OS (a manager,
-- with a note of how it was given), or the viewer themselves (their person here, or their account).
create function pulse.contract_accept(p_id uuid, p_party uuid, p_note text) returns text
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c contract; pt contract_party; mgr boolean := contract_manager();
begin
 select * into c from contract where org_id = current_org() and id = p_id for update;
 if not found or not contract_can_see(c.id, c.status) then raise exception 'No such contract in this company' using errcode = 'P0002'; end if;
 if c.status not in ('proposed', 'active') then raise exception 'Only a sent contract is accepted' using errcode = '22023'; end if;
 select * into pt from contract_party p where p.org_id = current_org() and p.contract_id = p_id and (p_party is null or p.id = p_party)
   and ((p.kind = 'person' and (p.party_person_id = current_viewer() or (p.party_account is not null and p.party_account = account_of_viewer())))
     or (mgr and p.kind = 'company' and p.party_org = current_org())
     or (mgr and p.party_org is null and p.party_person_id is null and p.party_account is null and p_party is not null))
   order by p.accepted_version is not distinct from c.version, p.position limit 1;
 if not found then raise exception 'You may not accept for that party' using errcode = '42501'; end if;
 if pt.party_org is null and pt.party_person_id is null and pt.party_account is null and length(btrim(coalesce(p_note, ''))) < 3 then
  raise exception 'Say how the other side accepted (for example: signed PDF, 4 Nov)' using errcode = '22023'; end if;
 update contract_party set accepted_at = now(), accepted_version = c.version, accepted_by_name = contract_actor_name(), accepted_note = nullif(btrim(p_note), '')
  where org_id = current_org() and id = pt.id;
 perform contract_settle(p_id);
 perform contract_push(p_id);
 return (select status from contract where org_id = current_org() and id = p_id);
end $$;

-- Accept as an account for a contract held by a company the person is not a member of (Your contracts).
create function pulse.contract_accept_account(p_key uuid) returns text
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare acct uuid := account_of_viewer(); back text := current_setting('pulse.org_id', true); who text := contract_actor_name();
  o uuid; cid uuid; c contract; res text;
begin
 if acct is null then raise exception 'Sign in with your own account to accept' using errcode = '42501'; end if;
 for o in select g.id from org g where g.status = 'active' loop
  perform set_config('pulse.org_id', o::text, true);
  select ct.id into cid from contract ct join contract_party p on p.contract_id = ct.id and p.org_id = ct.org_id
   where ct.org_id = o and ct.contract_key = p_key and ct.status in ('proposed', 'active') and p.party_account = acct limit 1;
  if cid is not null then
   select * into c from contract where org_id = o and id = cid for update;
   update contract_party set accepted_at = now(), accepted_version = c.version, accepted_by_name = who, accepted_note = null
    where org_id = o and contract_id = cid and party_account = acct;
   res := contract_settle(cid);
   perform contract_push(cid);
   perform set_config('pulse.org_id', coalesce(back, ''), true);
   return res;
  end if;
 end loop;
 perform set_config('pulse.org_id', coalesce(back, ''), true);
 raise exception 'No contract names you as a party' using errcode = 'P0002';
end $$;

-- A transaction under the contract (shared), recorded by a manager of a company party. p: kind, payerKey, payeeKey,
-- label, amountMinor, currency, dueOn, status, paidOn; own side: erpDocumentId, finEntryId.
create function pulse.contract_txn_add(p_id uuid, p jsonb) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c contract; tid uuid;
begin
 if not contract_manager() then raise exception 'Admins, leadership and Finance record money under a contract' using errcode = '42501'; end if;
 select * into c from contract where org_id = current_org() and id = p_id for update;
 if not found then raise exception 'No such contract in this company' using errcode = 'P0002'; end if;
 if c.status not in ('proposed', 'active', 'ended') then raise exception 'Send the contract before recording money under it' using errcode = '22023'; end if;
 if not exists(select 1 from contract_party where org_id = current_org() and contract_id = p_id and party_key = (p->>'payerKey')::uuid)
   or not exists(select 1 from contract_party where org_id = current_org() and contract_id = p_id and party_key = (p->>'payeeKey')::uuid) then
  raise exception 'Choose who pays and who is paid from the contract''s parties' using errcode = '22023'; end if;
 if nullif(p->>'erpDocumentId', '') is not null and not exists(select 1 from erp_document where org_id = current_org() and id = (p->>'erpDocumentId')::uuid) then
  raise exception 'That invoice is not in this company' using errcode = '22023'; end if;
 if nullif(p->>'finEntryId', '') is not null and not exists(select 1 from fin_entry where org_id = current_org() and id = (p->>'finEntryId')::uuid) then
  raise exception 'That ledger entry is not in this company' using errcode = '22023'; end if;
 insert into contract_txn(org_id, contract_id, kind, payer_key, payee_key, label, amount_minor, currency, status, due_on, paid_on, erp_document_id, fin_entry_id, created_by_name)
 values (current_org(), p_id, p->>'kind', (p->>'payerKey')::uuid, (p->>'payeeKey')::uuid, p->>'label', (p->>'amountMinor')::bigint, coalesce(p->>'currency', c.currency),
   coalesce(p->>'status', 'billed'), (p->>'dueOn')::date, case when p->>'status' = 'paid' then coalesce((p->>'paidOn')::date, (now() at time zone org_time_zone())::date) end,
   nullif(p->>'erpDocumentId', '')::uuid, nullif(p->>'finEntryId', '')::uuid, contract_actor_name())
 returning id into tid;
 perform contract_push(p_id);
 return tid;
end $$;

-- Mark a transaction paid or void (shared), or tie it to this company's own invoice or ledger entry (own side).
create function pulse.contract_txn_set(p_id uuid, p_txn uuid, p jsonb) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not contract_manager() then raise exception 'Admins, leadership and Finance record money under a contract' using errcode = '42501'; end if;
 if nullif(p->>'erpDocumentId', '') is not null and not exists(select 1 from erp_document where org_id = current_org() and id = (p->>'erpDocumentId')::uuid) then
  raise exception 'That invoice is not in this company' using errcode = '22023'; end if;
 if nullif(p->>'finEntryId', '') is not null and not exists(select 1 from fin_entry where org_id = current_org() and id = (p->>'finEntryId')::uuid) then
  raise exception 'That ledger entry is not in this company' using errcode = '22023'; end if;
 update contract_txn set status = coalesce(p->>'status', status),
   paid_on = case when p->>'status' = 'paid' then coalesce((p->>'paidOn')::date, (now() at time zone org_time_zone())::date) when p->>'status' is not null then null else paid_on end,
   erp_document_id = case when p ? 'erpDocumentId' then nullif(p->>'erpDocumentId', '')::uuid else erp_document_id end,
   fin_entry_id = case when p ? 'finEntryId' then nullif(p->>'finEntryId', '')::uuid else fin_entry_id end
  where org_id = current_org() and contract_id = p_id and id = p_txn;
 if not found then raise exception 'No such transaction on this contract' using errcode = 'P0002'; end if;
 perform contract_push(p_id);
end $$;

-- End (with the date it ends) or cancel one that never became active.
create function pulse.contract_end(p_id uuid, p_on date, p_reason text) returns text
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c contract; s text;
begin
 if not contract_manager() then raise exception 'Admins, leadership and Finance end contracts' using errcode = '42501'; end if;
 select * into c from contract where org_id = current_org() and id = p_id for update;
 if not found then raise exception 'No such contract in this company' using errcode = 'P0002'; end if;
 if c.status in ('ended', 'cancelled') then return c.status; end if;
 s := case when c.status = 'active' then 'ended' else 'cancelled' end;
 update contract set status = s, ended_on = coalesce(p_on, (now() at time zone org_time_zone())::date), end_reason = nullif(btrim(p_reason), ''), updated_at = now()
  where org_id = current_org() and id = p_id;
 perform contract_push(p_id);
 return s;
end $$;

-- Find an account to name as a party, by its exact handle or e-mail (no partial matches).
create function pulse.contract_find_account(p_who text) returns jsonb
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select case when contract_manager() then (select jsonb_build_object('id', a.id, 'name', a.display_name, 'handle', a.handle)
   from pulse_priv.pulse_account a where a.handle = lower(btrim(p_who)) or lower(a.email) = lower(btrim(p_who)) limit 1) end
$$;

-- Find a company on Vitals OS by its exact handle or slug.
create function pulse.contract_find_org(p_who text) returns jsonb
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select case when contract_manager() then (select jsonb_build_object('id', g.id, 'name', g.name)
   from org g where g.status = 'active' and (g.handle = lower(btrim(p_who)) or g.slug = lower(btrim(p_who))) limit 1) end
$$;

-- Your contracts, in every company: the shared part only (terms, parties, acceptance, transactions), never a company's
-- own side. A person sees a contract where they are a party by their person in that company or by their account.
create function pulse.my_contracts() returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare acct uuid := account_of_viewer(); me uuid := current_viewer(); back text := current_setting('pulse.org_id', true);
  here uuid := current_org(); o record; r record; res jsonb := '[]'; seen uuid[] := '{}'; mine uuid;
begin
 if me is null then return '[]'; end if;
 for o in select g.id, g.name from org g where g.status = 'active' and (g.id = here or acct is not null) order by g.id = here desc, g.name loop
  perform set_config('pulse.org_id', o.id::text, true);
  mine := case when o.id = here then me else (select m.person_id from pulse_priv.account_member m where m.account_id = acct and m.member_org = o.id) end;
  for r in select c.*, p.party_key my_party, p.role my_role from contract c join contract_party p on p.org_id = c.org_id and p.contract_id = c.id
    where c.org_id = o.id and c.status <> 'draft' and ((mine is not null and p.party_person_id = mine) or (acct is not null and p.party_account = acct))
    order by c.updated_at desc loop
   if r.contract_key = any(seen) then continue; end if;
   seen := seen || r.contract_key;
   res := res || jsonb_build_array(jsonb_build_object('id', case when o.id = here then r.id end, 'key', r.contract_key, 'heldBy', o.name, 'here', o.id = here,
     'status', r.status, 'version', r.version, 'kind', r.kind, 'title', r.title, 'scope', r.scope, 'deliverables', r.deliverables, 'rates', r.rates,
     'currency', r.currency, 'schedule', r.schedule, 'startsOn', r.starts_on, 'endsOn', r.ends_on, 'noticeDays', r.notice_days, 'updatedAt', r.updated_at,
     'myParty', r.my_party, 'myRole', r.my_role,
     'parties', (select coalesce(jsonb_agg(jsonb_build_object('key', p.party_key, 'kind', p.kind, 'role', p.role, 'name', p.name,
        'acceptedAt', p.accepted_at, 'acceptedVersion', p.accepted_version, 'acceptedBy', p.accepted_by_name) order by p.position), '[]')
        from contract_party p where p.org_id = o.id and p.contract_id = r.id),
     'transactions', (select coalesce(jsonb_agg(jsonb_build_object('key', x.txn_key, 'kind', x.kind, 'payer', x.payer_key, 'payee', x.payee_key, 'label', x.label,
        'amountMinor', x.amount_minor, 'currency', x.currency, 'status', x.status, 'dueOn', x.due_on, 'paidOn', x.paid_on) order by x.created_at), '[]')
        from contract_txn x where x.org_id = o.id and x.contract_id = r.id)));
   if jsonb_array_length(res) >= 200 then exit; end if;
  end loop;
 end loop;
 perform set_config('pulse.org_id', coalesce(back, ''), true);
 return res;
end $$;

revoke all on function pulse.contract_push(uuid), pulse.contract_settle(uuid) from public;
grant execute on function pulse.contract_manager(), pulse.contract_is_party(uuid), pulse.contract_can_see(uuid, text), pulse.contract_terms(pulse.contract),
  pulse.contract_actor_name(), pulse.contract_save(uuid, jsonb), pulse.contract_send(uuid), pulse.contract_accept(uuid, uuid, text),
  pulse.contract_accept_account(uuid), pulse.contract_txn_add(uuid, jsonb), pulse.contract_txn_set(uuid, uuid, jsonb), pulse.contract_end(uuid, date, text),
  pulse.contract_find_account(text), pulse.contract_find_org(text), pulse.my_contracts() to pulse_api;

-- ------------------------------------------------------------------------------------------------ API v1 areas
-- contracts (this migration) and connectors (1584). Business and enterprise hold every area (api_tier_scopes' else);
-- no existing key gains an area.
create or replace function pulse.v1_scopes() returns text[] language sql immutable as $$
  select array['tasks.read','tasks.write','projects.read','projects.write','people.read','people.write','chats.read','chats.write',
   'docs.read','docs.write','billing.read','billing.write','workflows.read','workflows.write','companies.read','companies.write',
   'search.read','search.write','events.read','events.write','finance.read','finance.write','hr.read','hr.write',
   'contracts.read','contracts.write','connectors.read','connectors.write']
$$;

-- Writes through API v1 land in the app ledger's list (logged; a contract is changed back by a new version).
alter table pulse_priv.app_change drop constraint app_change_action_check;
alter table pulse_priv.app_change add constraint app_change_action_check check (action in (
  'profile.correct', 'password.issue', 'invite.send', 'chat.group.create', 'chat.members', 'feedback.status',
  'task.create', 'task.assign', 'task.update', 'task.complete', 'comment.add', 'project.create', 'stage.owner', 'stage.task',
  'chat.message', 'client.create', 'catalog.item.create', 'stock.move', 'quotation.create', 'quotation.revise', 'quotation.submit',
  'quotation.approve', 'quotation.send', 'invoice.create', 'invoice.issue', 'payment.record',
  'project.update', 'project.delete', 'expense.create', 'leave.request',
  'goal.create', 'goal.update', 'goal.link', 'goal.unlink',
  'contract.create', 'contract.update', 'contract.send', 'contract.accept', 'contract.txn', 'contract.link', 'contract.end',
  'connector.tool'));

-- migrate:down
-- Forward-only.
