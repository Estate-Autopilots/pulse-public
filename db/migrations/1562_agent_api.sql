-- migrate:up
-- AGENT-API (owner, 4 Nov 2026: "the major thing Pulse needs now is the strongest possible API, MCP and CLI"), slice 1:
-- the work and money operations of API v1 (v1-work.ts, v1-money.ts), personal access tokens and organisation bot keys.
--
--  * Personal access tokens (ppt_…): a person makes one in Settings → API keys for a script or the CLI, with the area
--    scopes it needs and an expiry (1 to 365 days); it acts as that person exactly as their OAuth connections do.
--  * Bot keys (pbk_…): an admin makes one for an AI member (Willow Lane's Bhrata), so the bot acts as that member with
--    its roles, never as a person, in this organisation only. Both are stored as SHA-256 only, rotate (a new secret, the
--    old one ends at once) and revoke; each use is the token's own audited principal (pulse.v1_call_audit).
--  * Writes made through the new operations land in pulse_priv.app_change and most are undone for 7 days by the
--    existing undo_change: a task made, given, changed or completed, a comment, a project, a chat message, a client
--    added (while nothing is billed to it), a catalogue item, a stock movement, a quotation drafted, revised or sent for
--    approval, an invoice drafted and a payment recorded. Approving, issuing and sending are logged and never undone
--    (numbers stay audit-safe; a quotation is revised instead).
--  * AI members get a Billing tool (drafting only; approving and issuing stay a person's).
--  * pulse.v1_client_create: find_or_create_client adds a client for admins, leadership and the Finance role (billing
--    books clients for them already, 1470).

alter table pulse_priv.app_change drop constraint app_change_action_check;
alter table pulse_priv.app_change add constraint app_change_action_check check (action in (
  'profile.correct', 'password.issue', 'invite.send', 'chat.group.create', 'chat.members', 'feedback.status',
  'task.create', 'task.assign', 'task.update', 'task.complete', 'comment.add', 'project.create', 'stage.owner', 'stage.task',
  'chat.message', 'client.create', 'catalog.item.create', 'stock.move', 'quotation.create', 'quotation.revise', 'quotation.submit',
  'quotation.approve', 'quotation.send', 'invoice.create', 'invoice.issue', 'payment.record'));

-- ------------------------------------------------------------------------------------------------ tokens
create table pulse_priv.api_token (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('personal', 'bot')),
  person_id uuid not null references pulse.person(id),
  name text not null check (length(btrim(name)) between 1 and 60 and name !~ '[[:cntrl:]]'),
  scopes text[] not null check (cardinality(scopes) between 1 and 40),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  days int not null check (days between 1 and 365),
  created_by uuid not null references pulse.person(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  rotated_from uuid references pulse_priv.api_token(id)
);
create index api_token_person on pulse_priv.api_token(org_id, person_id) where revoked_at is null;
-- Row security keeps the API role to its organisation; the definer functions below are the only way in and check the
-- organisation themselves (not forced, so the shared address can find a token's organisation, like agent_key_org).
alter table pulse_priv.api_token enable row level security;
create policy tenant_isolation on pulse_priv.api_token using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

create function pulse.api_token_issue(p_kind text, p_name text, p_scopes text[], p_days int, p_agent uuid, p_hash text) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); who uuid; tid uuid;
begin
 if me is null or coalesce(current_setting('pulse.agent_session', true), '') = 'on' or coalesce(current_setting('pulse.v1_token_id', true), '') <> ''
   or not exists(select 1 from person where org_id = current_org() and id = me and side = 'staff' and status = 'active')
  then raise exception 'Sign in to Pulse as staff to make a token' using errcode = '42501'; end if;
 if p_kind not in ('personal', 'bot') or p_name is null or length(btrim(p_name)) not between 1 and 60 or p_days is null or p_days not between 1 and 365
   or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' or p_scopes is null or cardinality(p_scopes) = 0 or array_position(p_scopes, null) is not null
   or not (p_scopes <@ v1_scopes()) or cardinality(p_scopes) <> (select count(distinct s) from unnest(p_scopes) s)
  then raise exception 'Choose a name, the areas it may use and an expiry from 1 to 365 days' using errcode = '22023'; end if;
 if p_kind = 'personal' then
  if p_agent is not null then raise exception 'A personal token acts as you' using errcode = '22023'; end if;
  who := me;
 else
  if not viewer_is('admin') then raise exception 'Company admins make bot keys' using errcode = '42501'; end if;
  if p_agent is null or not exists(select 1 from agent_member a join person p on p.id = a.person_id where a.org_id = current_org() and a.person_id = p_agent
    and a.disabled_at is null and p.side = 'agent' and p.status = 'active') then raise exception 'Choose an active AI member of this company' using errcode = '22023'; end if;
  who := p_agent;
 end if;
 if (select count(*) from pulse_priv.api_token where org_id = current_org() and person_id = who and revoked_at is null and expires_at > now()) >= 20
  then raise exception 'At most 20 live tokens each; revoke one first' using errcode = '23514'; end if;
 insert into pulse_priv.api_token(org_id, kind, person_id, name, scopes, token_sha256, days, created_by, expires_at)
 values (current_org(), p_kind, who, btrim(p_name), p_scopes, p_hash, p_days, me, now() + make_interval(days => p_days)) returning id into tid;
 perform audit_write('api_token_issued', 'api_token', tid::text, p_scopes);
 return tid;
end $$;

-- Your own tokens, and for admins every bot key and everyone's personal tokens (to revoke a leaver's).
create function pulse.api_token_list() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'name', t.name, 'scopes', to_jsonb(t.scopes), 'personId', t.person_id,
   'person', p.display_name, 'mine', t.person_id = current_viewer() or (t.kind = 'bot' and t.created_by = current_viewer()), 'createdAt', t.created_at,
   'createdBy', (select display_name from person where id = t.created_by), 'expiresAt', t.expires_at, 'lastUsedAt', t.last_used_at, 'days', t.days,
   'expired', t.expires_at <= now(), 'canRotate', (t.kind = 'personal' and t.person_id = current_viewer()) or (t.kind = 'bot' and viewer_is('admin')))
   order by t.kind, t.created_at desc), '[]')
 from pulse_priv.api_token t join person p on p.id = t.person_id
 where t.org_id = current_org() and t.revoked_at is null and t.expires_at > now() - interval '30 days'
   and (t.person_id = current_viewer() or viewer_is('admin'))
$$;

create function pulse.api_token_end(p_id uuid, p_reason text) returns pulse_priv.api_token
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t pulse_priv.api_token;
begin
 select * into t from pulse_priv.api_token where org_id = current_org() and id = p_id and revoked_at is null for update;
 if not found or not ((t.kind = 'personal' and t.person_id = current_viewer()) or viewer_is('admin')) or coalesce(current_setting('pulse.v1_token_id', true), '') <> ''
  then raise exception 'No such token of yours' using errcode = 'P0002'; end if;
 update pulse_priv.api_token set revoked_at = now(), revoked_reason = p_reason where id = t.id;
 perform audit_write('api_token_' || p_reason, 'api_token', t.id::text, t.scopes);
 return t;
end $$;
create function pulse.api_token_revoke(p_id uuid) returns boolean language plpgsql security definer set search_path=pulse,pg_temp as $$
begin perform api_token_end(p_id, 'revoked'); return true; end $$;
-- Rotate: a new secret with the same name, scopes and length; the old one stops at once. The new secret is shown to
-- whoever rotates, so a personal token is rotated only by its own person (an admin may still revoke a leaver's): an
-- admin who could rotate it would hold a secret acting as that person, with their roles (review, 5 Nov 2026).
-- Bot keys stay with admins.
create function pulse.api_token_rotate(p_id uuid, p_hash text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t pulse_priv.api_token; tid uuid;
begin
 if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then raise exception 'Bad token digest' using errcode = '22023'; end if;
 select * into t from pulse_priv.api_token where org_id = current_org() and id = p_id and revoked_at is null;
 if not found or (t.kind = 'personal' and t.person_id is distinct from current_viewer()) or (t.kind = 'bot' and not viewer_is('admin'))
  then raise exception 'No such token of yours' using errcode = 'P0002'; end if;
 t := api_token_end(p_id, 'rotated');
 insert into pulse_priv.api_token(org_id, kind, person_id, name, scopes, token_sha256, days, created_by, expires_at, rotated_from)
 values (current_org(), t.kind, t.person_id, t.name, t.scopes, p_hash, t.days, current_viewer(), now() + make_interval(days => t.days), t.id) returning id into tid;
 return tid;
end $$;

-- API v1's personal resolver (EST-1617): a live token holding the scope makes its person (or AI member) the viewer.
-- Returns the token row id, or null with nothing set.
create function pulse.v1_token_principal(p_hash text, p_scope text) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t pulse_priv.api_token;
begin
 if current_viewer() is not null or p_scope is null or not (p_scope = any(v1_scopes())) then return null; end if;
 select * into t from pulse_priv.api_token where org_id = current_org() and token_sha256 = p_hash and revoked_at is null and expires_at > now() and p_scope = any(scopes);
 if not found then return null; end if;
 perform set_config('pulse.viewer_id', t.person_id::text, true);
 if t.kind = 'bot' then
  perform set_config('pulse.agent_session', 'on', true);
  if agent_session() is distinct from t.person_id then
   perform set_config('pulse.viewer_id', '', true); perform set_config('pulse.agent_session', '', true); return null;
  end if;
 elsif not exists(select 1 from person where org_id = current_org() and id = t.person_id and status = 'active' and side = 'staff')
   or exists(select 1 from login_credential where person_id = t.person_id and status = 'disabled') then
  perform set_config('pulse.viewer_id', '', true); return null;
 end if;
 perform set_config('pulse.actor_account', 'token:' || t.id || ':' || coalesce((select username from people_profile where person_id = t.person_id), t.person_id::text), true);
 perform set_config('pulse.app_label', left(t.name || case when t.kind = 'bot' then ' (bot key)' else ' (personal token)' end, 80), true);
 update pulse_priv.api_token set last_used_at = now() where id = t.id and (last_used_at is null or last_used_at < now() - interval '1 minute');
 return t.id;
end $$;
create function pulse.v1_token_live(p_hash text) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from pulse_priv.api_token where org_id = current_org() and token_sha256 = p_hash and revoked_at is null and expires_at > now())
$$;
-- The shared address: a token runs in the organisation it was made in (as agent_key_org does for pak_ keys).
create function pulse.v1_token_org(p_hash text) returns table(org_id uuid, status text, rehearsal boolean)
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select t.org_id, o.status, o.rehearsal from pulse_priv.api_token t join org o on o.id = t.org_id
 where p_hash ~ '^[0-9a-f]{64}$' and t.token_sha256 = p_hash and t.revoked_at is null and t.expires_at > now()
$$;

-- ------------------------------------------------------------------------------------------------ clients
create function pulse.v1_client_create(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); nm text := left(btrim(regexp_replace(coalesce(p->>'name', ''), '\s+', ' ', 'g')), 200); cid uuid;
 em text := lower(nullif(btrim(coalesce(p->>'email', '')), '')); ph text := left(nullif(btrim(coalesce(p->>'phone', '')), ''), 40);
begin
 if me is null or not (viewer_is('admin') or erp_can(true)) then raise exception 'Clients are added by admins, leadership and the Finance role' using errcode = '42501'; end if;
 if nm = '' then raise exception 'Name the client' using errcode = '22023'; end if;
 if em is not null and em !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'That e-mail is not valid' using errcode = '22023'; end if;
 insert into client(org_id, display_name, company_name, email, phone, city, client_type, type_basis, status, source, locked)
 values (current_org(), nm, left(nullif(btrim(coalesce(p->>'company', '')), ''), 200), em, ph, left(nullif(btrim(coalesce(p->>'city', '')), ''), 80),
   coalesce(left(nullif(btrim(coalesce(p->>'type', '')), ''), 48), 'other'), 'manual', 'active', 'api', '{display_name}') returning id into cid;
 insert into record_change(org_id, entity_type, entity_id, field, new_value, changed_by, via)
 values (current_org(), 'client', cid, 'created', nm, me, nullif(current_setting('pulse.app_label', true), ''));
 return cid;
end $$;

-- ------------------------------------------------------------------------------------------------ AI members in Billing
-- An AI member holds no role (0906), so Billing gets its own tool switch: an admin turns on "Billing" for an AI member
-- (Bhrata) and it may read Billing and draft there, as the Finance role does. Approving a quotation or issuing a
-- document stays a person's decision: the guard below refuses it in an AI member's session, whatever the caller.
-- Drafting only (review, 5 Nov 2026). The meeting agreed Bhrata finds or adds the client, drafts the quotation from
-- the catalogue, sends it for approval and, once a person approved it, dispatches it; and adds a missing catalogue item
-- when the person says yes. Never that a bot moves money or stock. So in an AI member's session the database itself
-- refuses: any change to a document once it left draft (cancel, credit, revise, mark paid), except marking an approved
-- quotation sent; every payment and stock move; changing or archiving a catalogue item or its price (a new item may be
-- added); and the series, templates, settings and logo. Drafts and their lines, clients and acceptance links are written.
alter table pulse.agent_member drop constraint agent_member_tools_check;
alter table pulse.agent_member add constraint agent_member_tools_check check (tools <@ array['chats','tasks','memory','board','drive','web','server','mcp','projects','billing']::text[]);
create or replace function pulse.erp_can(p_write boolean default false) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (viewer_is('finance')
  or (money_can('money.read') and money_can('money.amount.read') and (not p_write or money_can('money.plan.write')))
  or (not p_write and is_accountant(current_viewer()) and erp_accountant_reads())
  or exists(select 1 from agent_member m where m.org_id = current_org() and m.person_id = agent_session() and m.disabled_at is null and 'billing' = any(m.tools)))
$$;
create function pulse.erp_agent_issue_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if old.status = 'draft' and new.status <> 'draft' and new.status <> 'cancelled' and agent_session() is not null then
  raise exception 'A person approves quotations and issues documents; an AI member drafts them' using errcode = '42501';
 end if;
 return new;
end $$;
create trigger erp_agent_issue_guard before update of status on pulse.erp_document for each row execute function pulse.erp_agent_issue_guard();
-- One function for several tables: columns of other tables are read through jsonb (j), since PL/pgSQL resolves a
-- record field when it first reaches it, whatever table fired.
create function pulse.erp_agent_draft_only() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j jsonb;
begin
 if agent_session() is null then return coalesce(new, old); end if;
 j := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
 if tg_table_name = 'erp_document' then
  if tg_op = 'INSERT' and new.status = 'draft' then return new; end if;
  if tg_op <> 'INSERT' and old.status = 'draft' then return coalesce(new, old); end if;
  -- Dispatching an approved quotation (erp_document_mark 'sent'): only the status moves, never its figures or buyer.
  if tg_op = 'UPDATE' and old.doc_type = 'quotation' and old.status = 'issued' and new.status = 'sent'
     and (new.number, new.total, new.client_id, new.doc_type, new.issue_date) is not distinct from (old.number, old.total, old.client_id, old.doc_type, old.issue_date)
   then return new; end if;
  raise exception 'An AI member drafts quotations and invoices; a person changes them once they are approved or issued' using errcode = '42501';
 end if;
 if tg_table_name = 'erp_line' then
  if exists(select 1 from erp_document d where d.id = (j->>'document_id')::uuid and d.status <> 'draft')
     or (tg_op = 'UPDATE' and exists(select 1 from erp_document d where d.id = (to_jsonb(old)->>'document_id')::uuid and d.status <> 'draft')) then
   raise exception 'An AI member drafts quotations and invoices; a person changes them once they are approved or issued' using errcode = '42501';
  end if;
  return coalesce(new, old);
 end if;
 if tg_table_name = 'erp_accept_link' and tg_op = 'INSERT' then return new; end if;
 if tg_table_name = 'erp_item' and tg_op = 'INSERT' then return new; end if;
 if tg_table_name = 'erp_item_version' and tg_op = 'INSERT' and not exists(select 1 from erp_item_version v where v.item_id = (j->>'item_id')::uuid) then return new; end if;
 if tg_table_name in ('erp_item_addon', 'erp_package_part') and tg_op = 'INSERT'
    and not exists(select 1 from erp_item_version v where v.item_id = coalesce(j->>'package_id', j->>'item_id')::uuid and v.version > 1) then return new; end if;
 raise exception 'An AI member drafts quotations and adds catalogue items when asked: payments, stock, prices, archiving and Billing settings are a person''s' using errcode = '42501';
end $$;
do $$ declare t text; begin
 foreach t in array array['erp_document','erp_line','erp_payment','erp_stock_move','erp_item','erp_item_version','erp_item_addon','erp_package_part',
   'erp_settings','erp_series','erp_template','erp_template_default','erp_accept_link','erp_asset'] loop
  if to_regclass('pulse.' || t) is not null then
   execute format('create trigger erp_agent_draft_only before insert or update or delete on pulse.%I for each row execute function pulse.erp_agent_draft_only()', t);
  end if;
 end loop;
end $$;

-- ------------------------------------------------------------------------------------------------ undo
-- 1412's undo, with the work and money kinds. A later change by anyone wins: nothing is undone if it moved since.
create or replace function pulse.app_change_undo(p_id uuid) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare x pulse_priv.app_change; cur text; t record; k text; fields jsonb := '{}'; why text;
begin
 select * into x from pulse_priv.app_change where org_id = current_org() and id = p_id for update;
 if not found or not (x.actor_id = current_viewer() or viewer_is('admin')) then raise exception 'No such change of yours' using errcode='P0002'; end if;
 if x.undone_at is not null then return jsonb_build_object('changeId', x.id, 'status', 'undone', 'replayed', true); end if;
 if x.created_at < now() - interval '7 days' then raise exception 'Changes can be undone for 7 days' using errcode='23514'; end if;
 why := 'Undo of change ' || x.id || ' (' || x.app || ')';
 if x.action = 'profile.correct' then
  if not viewer_is('admin', 'hr') then raise exception 'HR or admin required' using errcode='42501'; end if;
  execute format('select %I::text from people_profile where org_id = current_org() and person_id = $1',
   case x.detail->>'field' when 'joinedOn' then 'joined_on' when 'managerId' then 'manager_id' when 'workEmail' then 'email' when 'employmentType' then 'employment_type'
    when 'workLocation' then 'work_location' else x.detail->>'field' end) into cur using x.subject_id;
  if cur is distinct from x.detail->>'to' then raise exception 'Someone changed this since; nothing was undone' using errcode='23514'; end if;
  perform hr_profile_set(x.subject_id, x.detail->>'field', x.detail->>'from', 'Undo of change ' || x.id);
 elsif x.action = 'chat.members' then
  perform chat_group_members((x.detail->>'groupId')::uuid, array(select jsonb_array_elements_text(x.detail->'removed'))::uuid[],
   array(select jsonb_array_elements_text(x.detail->'added'))::uuid[]);
 elsif x.action = 'feedback.status' then
  update app_feedback set status = x.detail->>'from', handled_by = current_viewer(), handled_at = now()
   where org_id = current_org() and id = x.subject_id and status = x.detail->>'to';
  if not found then raise exception 'Someone changed this since; nothing was undone' using errcode='23514'; end if;
 -- AGENT-API: work. The task functions check the undoer's own rights.
 elsif x.action = 'task.create' then
  perform task_delete(x.subject_id, why);
 elsif x.action = 'task.assign' then
  select coalesce(assignee_person_id, owner_id)::text into cur from task where org_id = current_org() and id = x.subject_id and deleted_at is null;
  if cur is distinct from x.detail->>'to' then raise exception 'Someone changed this since; nothing was undone' using errcode='23514'; end if;
  perform task_save(x.subject_id, jsonb_build_object('assigneeId', x.detail->'from'));
 elsif x.action = 'task.update' then
  select title, priority, notes, status, to_char(due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') "dueAt" into t from task where org_id = current_org() and id = x.subject_id and deleted_at is null;
  if not found then raise exception 'That task is gone' using errcode='P0002'; end if;
  foreach k in array array(select jsonb_array_elements_text(x.detail->'changed')) loop
   if (to_jsonb(t)->>k) is distinct from (x.detail->'after'->>k) then raise exception 'Someone changed this since; nothing was undone' using errcode='23514'; end if;
   if k in ('title', 'priority', 'notes') then fields := fields || jsonb_build_object(k, x.detail->'before'->k);
   elsif k = 'dueAt' then fields := fields || case when x.detail->'before'->>'dueAt' is null then jsonb_build_object('dueOn', null) else jsonb_build_object('dueAt', x.detail->'before'->'dueAt') end;
   end if;
  end loop;
  if fields <> '{}' then perform task_save(x.subject_id, fields); end if;
  if x.detail->'changed' ? 'status' then perform task_move(x.subject_id, x.detail->'before'->>'status', why); end if;
 elsif x.action = 'task.complete' then
  select status into cur from task where org_id = current_org() and id = x.subject_id and deleted_at is null;
  if cur is distinct from x.detail->>'to' then raise exception 'Someone changed this since; nothing was undone' using errcode='23514'; end if;
  perform task_move(x.subject_id, case when x.detail->>'from' in ('open','in_progress','blocked','cancelled') then x.detail->>'from' else 'open' end, why);
 elsif x.action = 'comment.add' then
  perform work_comment_remove(x.subject_id);
 elsif x.action = 'project.create' then
  perform project_delete(x.subject_id, why);
 elsif x.action = 'chat.message' then
  perform chat_remove(x.subject_id, why);
 -- AGENT-API: money. Definer code passes Billing's restrictive policies, so the right is checked here.
 elsif x.action in ('client.create', 'catalog.item.create', 'stock.move', 'quotation.create', 'quotation.revise', 'quotation.submit', 'invoice.create', 'payment.record') then
  if x.action = 'client.create' then
   if not (viewer_is('admin') or erp_can(true)) then raise exception 'Clients are changed by admins, leadership and the Finance role' using errcode='42501'; end if;
   if exists(select 1 from erp_document where org_id = current_org() and client_id = x.subject_id) or exists(select 1 from project where org_id = current_org() and client_id = x.subject_id)
     or exists(select 1 from client_contact where org_id = current_org() and client_id = x.subject_id) or exists(select 1 from erp_party where org_id = current_org() and client_id = x.subject_id)
    then raise exception 'This client is in use now (billed, a project or a contact); nothing was undone' using errcode='23514'; end if;
   delete from client where org_id = current_org() and id = x.subject_id;
  else
   if not erp_can(true) then raise exception 'Invoicing is for leadership and the Finance role' using errcode='42501'; end if;
   if x.action = 'catalog.item.create' then
    update erp_item set status = 'archived', updated_by = current_viewer() where org_id = current_org() and id = x.subject_id and status <> 'archived';
    perform erp_log('item', x.subject_id, 'archived', jsonb_build_object('undo', x.id));
   elsif x.action = 'stock.move' then
    insert into erp_stock_move(org_id, item_id, kind, qty, note, on_date, created_by)
    select current_org(), m.item_id, 'adjust', -m.qty * case when m.kind = 'out' then -1 else 1 end, left(why, 500), (now() at time zone org_time_zone())::date, current_viewer()
    from erp_stock_move m where m.org_id = current_org() and m.id = x.subject_id;
    if not found then raise exception 'That stock movement is gone' using errcode='P0002'; end if;
    perform erp_log('stock', (x.detail->>'itemId')::uuid, 'adjust', jsonb_build_object('undo', x.id));
   elsif x.action in ('quotation.create', 'invoice.create') then
    select status, task_id::text into t from erp_document where org_id = current_org() and id = x.subject_id;
    if not found then raise exception 'That document is gone' using errcode='P0002'; end if;
    if t.status <> 'draft' then raise exception 'It is approved or issued now; revise or cancel it in Billing' using errcode='23514'; end if;
    if t.task_id is not null then raise exception 'It is waiting for approval; undo that first' using errcode='23514'; end if;
    delete from erp_document where org_id = current_org() and id = x.subject_id;
    perform erp_log('document', x.subject_id, 'deleted', jsonb_build_object('undo', x.id));
   elsif x.action = 'quotation.revise' then
    if (x.detail->>'revised')::boolean then perform erp_quote_revise_undo(x.subject_id);
    else raise exception 'A draft edit is changed again, not undone; edit the draft' using errcode='23514'; end if;
   elsif x.action = 'quotation.submit' then
    select status, task_id into t from erp_document where org_id = current_org() and id = x.subject_id;
    if t.status <> 'draft' or t.task_id is distinct from (x.detail->>'taskId')::uuid then raise exception 'It was approved or changed since; nothing was undone' using errcode='23514'; end if;
    -- LAND-Q2: the request went through erp_approval_ask (1561), so withdrawing it clears Billing's approver too.
    update erp_document set task_id = null, approval_to = null, approval_asked_by = null, approval_asked_at = null, approval_note = null
     where org_id = current_org() and id = x.subject_id;
    perform task_delete((x.detail->>'taskId')::uuid, why);
   elsif x.action = 'payment.record' then
    perform erp_payment_void(x.subject_id, left(why, 300));
   end if;
  end if;
 else raise exception 'This change cannot be undone (%)', x.action using errcode='23514';
 end if;
 update pulse_priv.app_change set undone_at = now(), undone_by = current_viewer() where id = x.id;
 return jsonb_build_object('changeId', x.id, 'status', 'undone', 'replayed', false);
end $$;

create or replace function pulse.app_change_list(p_days int default 30) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('changeId', x.id, 'app', x.app, 'action', x.action, 'subjectId', x.subject_id,
   'subjectName', coalesce((select display_name from person where id = x.subject_id), (select title from task where id = x.subject_id),
     (select coalesce(title, name) from project where id = x.subject_id), (select display_name from client where id = x.subject_id),
     (select name from erp_item where id = x.subject_id), (select coalesce(number, buyer->>'name') from erp_document where id = x.subject_id)), 'detail', x.detail, 'at', x.created_at,
   'undoUntil', case when x.action in ('profile.correct','chat.members','feedback.status','task.create','task.assign','task.update','task.complete','comment.add',
     'project.create','chat.message','client.create','catalog.item.create','stock.move','quotation.create','quotation.revise','quotation.submit','invoice.create','payment.record')
     then x.created_at + interval '7 days' end,
   'status', case when x.undone_at is not null then 'undone' else 'applied' end) order by x.created_at desc), '[]')
 from pulse_priv.app_change x where x.org_id = current_org() and x.actor_id = current_viewer() and x.created_at > now() - make_interval(days => least(greatest(p_days, 1), 90))
$$;

revoke all on function pulse.api_token_issue(text,text,text[],int,uuid,text), pulse.api_token_list(), pulse.api_token_end(uuid,text), pulse.api_token_revoke(uuid),
  pulse.api_token_rotate(uuid,text), pulse.v1_token_principal(text,text), pulse.v1_token_live(text), pulse.v1_token_org(text), pulse.v1_client_create(jsonb) from public;
grant execute on function pulse.api_token_issue(text,text,text[],int,uuid,text), pulse.api_token_list(), pulse.api_token_revoke(uuid),
  pulse.api_token_rotate(uuid,text), pulse.v1_token_principal(text,text), pulse.v1_token_live(text), pulse.v1_client_create(jsonb) to pulse_api;
-- Read before any company is chosen (app.ts), as session_org and agent_key_org are.
grant execute on function pulse.v1_token_org(text) to pulse_api;

-- migrate:down
-- Forward-only: revoke tokens to remove access. The undo kinds stay readable in the ledger.
