-- migrate:up
-- CONTRACTS-3 (owner, 9 Nov 2026; the 7 Nov meeting C #1, SESSION-ASKS): the agreement asks still open after CONTRACTS-2
-- (1850). Builds on 1583 and 1850.
--   * A point of contact on each party (name, phone, e-mail). When the agreement is made from a quotation or invoice,
--     the client's comes from the document's buyer, else from the client record's contact (billing profile, primary
--     contact, first linked contact). Phones and e-mails show only to who runs the agreement (as contract_party.email).
--   * Links both ways for whoever runs the agreement: the seller who owns it now sees and adds its project, tasks and
--     invoice too, and sees the agreement's own side (the quotation it came from) (1583 kept both to admins, leadership
--     and Finance).
--   * A proposed draft (contract_proposal): Claude or ChatGPT (API v1 / MCP) or a person proposes new words; nothing
--     changes for the client until a person uses it, which makes the new draft (contract_words_save, 1850). The log
--     says a draft was proposed.
--   * "Send it by e-mail by itself" (contract_settings.send_by_itself): the setting exists and is off. It waits on
--     Kazuk's yes because it writes to real clients (CONTRACTS-2 §6): until then the database refuses to turn it on.
-- New table: forced row security with a tenant policy; writes only through the functions below.

-- ------------------------------------------------------------------------------------------------ point of contact
alter table pulse.contract_party add column poc_name text check (poc_name is null or (length(btrim(poc_name)) between 1 and 160 and poc_name !~ '[[:cntrl:]]'));
alter table pulse.contract_party add column poc_phone text check (poc_phone is null or poc_phone ~ '^\+?[0-9][0-9 ()-]{5,30}$');
alter table pulse.contract_party add column poc_email text check (poc_email is null or (length(poc_email) <= 254 and poc_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'));

-- A phone or e-mail as the columns take it, or null (a document's buyer may hold anything).
create function pulse.contract_clean_phone(p text) returns text language sql immutable as $$
 select case when x ~ '^\+?[0-9][0-9 ()-]{5,30}$' then x end from (select btrim(regexp_replace(coalesce(p, ''), '[^0-9+ ()-]', '', 'g')) x) y
$$;
create function pulse.contract_clean_email(p text) returns text language sql immutable as $$
 select case when length(x) <= 254 and x ~ '^[^@[:space:]]+@[^@[:space:]]+$' then x end from (select btrim(coalesce(p, '')) x) y
$$;

-- The client's point of contact on an agreement made from a document or for a client record (our own copy only).
create function pulse.contract_party_poc() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s contract_side; b jsonb; nm text; ph text; em text; pc uuid;
begin
 if new.poc_name is not null or new.poc_phone is not null or new.poc_email is not null then return new; end if;
 if new.party_org is not null or new.party_person_id is not null or new.party_account is not null then return new; end if;
 select * into s from contract_side where org_id = new.org_id and contract_id = new.contract_id;
 if not found then return new; end if;
 if s.source_document_id is not null then
  select d.buyer into b from erp_document d where d.org_id = new.org_id and d.id = s.source_document_id;
  nm := nullif(btrim(b->>'contactName'), ''); ph := b->>'phone'; em := b->>'email';
 end if;
 if nm is null and s.client_id is not null then
  select coalesce((select ep.contact_person_id from erp_party ep where ep.org_id = new.org_id and ep.client_id = s.client_id), cl.primary_contact_id,
     (select cc.person_id from client_contact cc where cc.org_id = new.org_id and cc.client_id = s.client_id order by cc.is_primary desc limit 1))
   into pc from client cl where cl.org_id = new.org_id and cl.id = s.client_id;
  if pc is not null then
   select p.display_name, coalesce(contract_clean_phone(ph), cp.phone), coalesce(contract_clean_email(em), cp.email) into nm, ph, em
    from person p left join contact_profile cp on cp.person_id = p.id and cp.org_id = p.org_id where p.org_id = new.org_id and p.id = pc;
  end if;
 end if;
 new.poc_name := nullif(left(regexp_replace(btrim(coalesce(nm, '')), '[[:cntrl:]]', ' ', 'g'), 160), '');
 new.poc_phone := contract_clean_phone(ph);
 new.poc_email := contract_clean_email(em);
 if new.signer_name is null then new.signer_name := new.poc_name; end if;
 if new.email is null then new.email := new.poc_email; end if;
 return new;
end $$;
create trigger contract_party_poc before insert on pulse.contract_party for each row execute function pulse.contract_party_poc();

-- Set a party's point of contact (who runs the agreement; any time before it ends). Empty text clears a field.
create function pulse.contract_party_contact(p_id uuid, p_party uuid, p jsonb) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c contract;
begin
 if not contract_runner(p_id) then raise exception 'Admins, leadership, Finance and the agreement''s owner change this' using errcode = '42501'; end if;
 select * into c from contract where org_id = current_org() and id = p_id;
 if not found then raise exception 'No such agreement in this company' using errcode = 'P0002'; end if;
 if c.status in ('ended', 'cancelled') then raise exception 'This agreement has ended' using errcode = '22023'; end if;
 if p ? 'phone' and nullif(btrim(p->>'phone'), '') is not null and contract_clean_phone(p->>'phone') is null then
  raise exception 'Check the phone number' using errcode = '22023'; end if;
 if p ? 'email' and nullif(btrim(p->>'email'), '') is not null and contract_clean_email(p->>'email') is null then
  raise exception 'Check the e-mail address' using errcode = '22023'; end if;
 update contract_party set
   poc_name = case when p ? 'name' then nullif(left(regexp_replace(btrim(coalesce(p->>'name', '')), '[[:cntrl:]]', ' ', 'g'), 160), '') else poc_name end,
   poc_phone = case when p ? 'phone' then contract_clean_phone(p->>'phone') else poc_phone end,
   poc_email = case when p ? 'email' then contract_clean_email(p->>'email') else poc_email end
  where org_id = current_org() and contract_id = p_id and party_key = p_party;
 if not found then raise exception 'Choose a side of this agreement' using errcode = '22023'; end if;
end $$;

-- ------------------------------------------------------------------------------------------------ links both ways
-- The seller who runs an agreement sees and adds its project, tasks and invoice (only work they can see themselves).
drop policy contract_link_see on pulse.contract_link;
drop policy contract_link_insert on pulse.contract_link;
drop policy contract_link_delete on pulse.contract_link;
create policy contract_link_see on pulse.contract_link as restrictive for select to pulse_api using (pulse.contract_runner(contract_id));
create policy contract_link_insert on pulse.contract_link as restrictive for insert to pulse_api
  with check (pulse.contract_runner(contract_id) and added_by = pulse.current_viewer()
    and exists(select 1 from pulse.contract c where c.id = contract_id)
    and (project_id is null or exists(select 1 from pulse.project p where p.id = project_id))
    and (task_id is null or exists(select 1 from pulse.task t where t.id = task_id))
    and (erp_document_id is null or exists(select 1 from pulse.erp_document d where d.id = erp_document_id))
    and (goal_id is null or exists(select 1 from pulse.goal g where g.id = goal_id)));
create policy contract_link_delete on pulse.contract_link as restrictive for delete to pulse_api using (pulse.contract_runner(contract_id));
-- The same seller sees the agreement's own side too (which quotation it came from, its template), so the page can show who
-- pays what and when; 1583 kept it to managers. The API still shows the internal notes to managers only.
drop policy contract_side_see on pulse.contract_side;
create policy contract_side_see on pulse.contract_side as restrictive for select to pulse_api using (pulse.contract_runner(contract_id));
create index contract_link_project on pulse.contract_link(org_id, project_id) where project_id is not null;
create index contract_link_task on pulse.contract_link(org_id, task_id) where task_id is not null;

-- ------------------------------------------------------------------------------------------------ proposed drafts
create table pulse.contract_proposal (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references pulse.contract(id),
  base_version int not null,
  title text check (title is null or (length(btrim(title)) between 1 and 160 and title !~ '[[:cntrl:]]')),
  body text not null check (length(btrim(body)) between 20 and 100000),
  note text check (length(note) <= 1000),
  via text not null default 'app' check (via in ('app', 'api', 'mcp')),
  proposed_by uuid references pulse.person(id),
  proposed_by_name text check (length(proposed_by_name) <= 160),
  created_at timestamptz not null default now(),
  decision text check (decision in ('used', 'dropped')),
  decided_by uuid references pulse.person(id),
  decided_at timestamptz
);
create index contract_proposal_open on pulse.contract_proposal(org_id, contract_id, created_at) where decision is null;
alter table pulse.contract_proposal enable row level security;
alter table pulse.contract_proposal force row level security;
create policy tenant_isolation on pulse.contract_proposal using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy contract_proposal_see on pulse.contract_proposal as restrictive for select to pulse_api using (pulse.contract_runner(contract_id));
grant select on pulse.contract_proposal to pulse_api;

alter table pulse.contract_event drop constraint contract_event_kind_check;
alter table pulse.contract_event add constraint contract_event_kind_check check (kind in ('made', 'prepared', 'sent', 'opened', 'viewed', 'signed', 'declined',
  'commented', 'change_asked', 'new_draft', 'link_stopped', 'resolved', 'draft_proposed'));

-- Propose new words (who runs the agreement, from the screen, the API or MCP). The client sees nothing until a person
-- uses it. A newer proposal from the same way replaces the older open one.
create function pulse.contract_propose(p_id uuid, p_title text, p_body text, p_note text, p_via text) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c contract; pid uuid; v_via text := case when p_via in ('app', 'api', 'mcp') then p_via else 'app' end;
begin
 if not contract_runner(p_id) then raise exception 'Admins, leadership, Finance and the agreement''s owner propose a new draft' using errcode = '42501'; end if;
 select * into c from contract where org_id = current_org() and id = p_id;
 if not found then raise exception 'No such agreement in this company' using errcode = 'P0002'; end if;
 if c.status in ('active', 'ended', 'cancelled') then raise exception 'Everyone signed this one, or it ended. Make a new agreement to change it' using errcode = '22023'; end if;
 if length(btrim(coalesce(p_body, ''))) < 20 then raise exception 'Write the new words (at least a sentence)' using errcode = '22023'; end if;
 if length(p_body) > 100000 then raise exception 'The agreement is too long' using errcode = '22023'; end if;
 if p_body = c.body and (p_title is null or btrim(p_title) = c.title) then raise exception 'These are the same words as now' using errcode = '22023'; end if;
 update contract_proposal set decision = 'dropped', decided_by = current_viewer(), decided_at = now()
  where org_id = current_org() and contract_id = p_id and decision is null and contract_proposal.via = v_via;
 insert into contract_proposal(org_id, contract_id, base_version, title, body, note, via, proposed_by, proposed_by_name)
 values (current_org(), p_id, c.version, nullif(left(btrim(coalesce(p_title, '')), 160), ''), p_body, nullif(left(btrim(coalesce(p_note, '')), 1000), ''), v_via,
   current_viewer(), left(contract_actor_name(), 160))
 returning id into pid;
 perform contract_log(p_id, 'draft_proposed', null, null,
   coalesce(nullif(left(btrim(coalesce(p_note, '')), 300), ''), case v_via when 'mcp' then 'Through an AI assistant' when 'api' then 'Through the API' else null end), 'app', null, null, null);
 return pid;
end $$;

-- Use a proposed draft (it becomes the agreement's words; after sending, that is a new draft everyone signs) or drop it.
create function pulse.contract_proposal_decide(p_id uuid, p_proposal uuid, p_use boolean) returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare x contract_proposal; v int;
begin
 if not contract_runner(p_id) then raise exception 'Admins, leadership, Finance and the agreement''s owner decide this' using errcode = '42501'; end if;
 select * into x from contract_proposal where org_id = current_org() and contract_id = p_id and id = p_proposal for update;
 if not found then raise exception 'No such proposed draft on this agreement' using errcode = 'P0002'; end if;
 if x.decision is not null then raise exception 'Someone already decided this one' using errcode = '22023'; end if;
 if p_use then v := contract_words_save(p_id, x.title, x.body); end if;
 update contract_proposal set decision = case when p_use then 'used' else 'dropped' end, decided_by = current_viewer(), decided_at = now()
  where org_id = current_org() and id = p_proposal;
 return coalesce(v, (select version from contract where org_id = current_org() and id = p_id));
end $$;

-- ------------------------------------------------------------------------------------------------ sending by itself
-- Built and off. It e-mails real clients, so it waits on Kazuk's yes (CONTRACTS-2 §6). Dropping this check (and building
-- the sender) is the change that switches it on; today the person sends the link from their own phone.
alter table pulse.contract_settings add column send_by_itself boolean not null default false;
alter table pulse.contract_settings add constraint contract_settings_send_waits check (send_by_itself = false);

-- ------------------------------------------------------------------------------------------------ grants
revoke all on function pulse.contract_party_poc(), pulse.contract_clean_phone(text), pulse.contract_clean_email(text) from public;
revoke all on function pulse.contract_party_contact(uuid, uuid, jsonb), pulse.contract_propose(uuid, text, text, text, text),
  pulse.contract_proposal_decide(uuid, uuid, boolean) from public;
grant execute on function pulse.contract_party_contact(uuid, uuid, jsonb), pulse.contract_propose(uuid, text, text, text, text),
  pulse.contract_proposal_decide(uuid, uuid, boolean) to pulse_api;

-- migrate:down
-- Forward-only, like 1850: the points of contact and the proposed drafts are kept.
