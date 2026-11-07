-- migrate:up
-- KAZUK-FLOW config (owner, 7 Nov 2026: "nothing is hard-coded: Kazuk's flow is one configuration of a general sales
-- and billing workflow; EA and Willow Lane are two presets of one engine"). Each company's Billing flow is a list of
-- steps, each with:
--   on      the step is part of the company's flow (an off step never stops anyone);
--   roles   who may do it (empty: every Billing writer);
--   locked  whether it stops for the people in lockedFor, with a plain reason (why) and who unlocks it (unlock).
-- The steps: quote, send, approve, price, version, accept, lost, invoice, payment, handover. With no row for a company
-- every step is what Pulse did before this migration, so every company keeps its behaviour until it chooses a preset:
--   approve  BILLING-WL's approval (1561): on while erp_settings.quote_approval is on (that switch stays its one source);
--            who approves (roles) is configurable, leadership and admins by default, plus the person it was sent to.
--   price    0506's owner approval of a changed price on a service key's (AI-drafted) quotation: on by default, the
--            owner (leadership) approves.
--   invoice  the lock "a salesperson makes the invoice from their accepted quotation" (1670): on for the sales role by
--            default; Finance and leadership unlock it (they make any invoice).
--   payment, send, version, accept, lost, handover: who may (all Billing writers by default); checked by the API.
--   send.required: what a quotation must carry before it is numbered and sent (none by default; EA's preset: Kazuk's
--            five, company name, client name, contact number, mail ID and project location; a draft saves half-filled).
-- Presets: 'ea' (no approval anywhere, no price gate, the salesperson prices; cost for the owner only) and 'wl' (approval
-- by leadership or an admin, the owner's price gate; cost for everyone in Billing: today's Willow Lane). Leadership or an
-- admin chooses a preset or changes a step (pulse.erp_flow_save); every change is logged.
-- Synthetic data only in tests; nothing here reads or writes production data.

create table pulse.erp_flow (
  org_id uuid primary key references pulse.org(id),
  preset text not null default 'custom' check (preset in ('ea', 'wl', 'custom')),
  steps jsonb not null default '{}' check (jsonb_typeof(steps) = 'object'),
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default now()
);
alter table pulse.erp_flow enable row level security;
alter table pulse.erp_flow force row level security;
create policy tenant on pulse.erp_flow using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy erp_read on pulse.erp_flow as restrictive for select to pulse_api using ((select pulse.erp_can(false)));
grant select on pulse.erp_flow to pulse_api, pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse.erp_flow for each row execute function pulse.audit_mutation();

-- The steps as Pulse ran them before (no preset chosen).
create function pulse.erp_flow_defaults() returns jsonb language sql immutable as $$
 select jsonb_build_object(
  'quote',    jsonb_build_object('on', true, 'roles', '[]'::jsonb, 'locked', false),
  'send',     jsonb_build_object('on', true, 'roles', '[]'::jsonb, 'locked', false, 'required', '[]'::jsonb),
  'approve',  jsonb_build_object('roles', '["leadership","admin"]'::jsonb, 'locked', true,
                'why', 'A manager or the owner approves this before it is numbered and sent', 'unlock', '["leadership","admin"]'::jsonb),
  'price',    jsonb_build_object('on', true, 'roles', '["leadership"]'::jsonb, 'locked', true,
                'why', 'A price away from the catalogue on an AI-drafted quotation waits for the owner', 'unlock', '["leadership"]'::jsonb),
  'version',  jsonb_build_object('on', true, 'roles', '[]'::jsonb, 'locked', false),
  'accept',   jsonb_build_object('on', true, 'roles', '[]'::jsonb, 'locked', false),
  'lost',     jsonb_build_object('on', true, 'roles', '[]'::jsonb, 'locked', false),
  'invoice',  jsonb_build_object('on', true, 'roles', '[]'::jsonb, 'locked', true, 'lockedFor', '["sales"]'::jsonb,
                'why', 'A salesperson makes the invoice from their accepted quotation', 'unlock', '["finance","leadership","admin"]'::jsonb),
  'payment',  jsonb_build_object('on', true, 'roles', '[]'::jsonb, 'locked', false),
  'handover', jsonb_build_object('on', true, 'roles', '[]'::jsonb, 'locked', false))
$$;
create function pulse.erp_flow_preset(p_preset text) returns jsonb language sql immutable as $$
 select case p_preset
  when 'ea' then pulse.erp_flow_defaults() || jsonb_build_object(
    'price', pulse.erp_flow_defaults()->'price' || '{"on": false}'::jsonb,
    -- G3 (Kazuk's five fields): a quotation goes out with the company, the client's name, phone, e-mail and project location.
    'send', pulse.erp_flow_defaults()->'send' || '{"required": ["name", "contactName", "phone", "email", "siteLocation"]}'::jsonb)
  when 'wl' then pulse.erp_flow_defaults()
  else pulse.erp_flow_defaults() end
$$;
-- One step of this company's flow: the defaults, the company's own changes over them, and approve.on from its switch
-- (erp_settings.quote_approval stays the one source of whether approval is on; a stored approve.on is not read).
create function pulse.erp_flow_step(p_step text) returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
 select (erp_flow_defaults()->p_step) || coalesce((select f.steps->p_step from erp_flow f where f.org_id = current_org()), '{}'::jsonb)
   || case when p_step = 'approve' then jsonb_build_object('on', coalesce((select s.quote_approval from erp_settings s where s.org_id = current_org()), false)) else '{}'::jsonb end
$$;
-- Whether the viewer holds any of the roles in a step's list (an empty list: every Billing writer).
create function pulse.erp_flow_holds(p_roles jsonb) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce(jsonb_array_length(p_roles), 0) = 0 or viewer_is(variadic array(select jsonb_array_elements_text(p_roles)))
$$;
-- What stops this viewer at a step, or null: {step, why, unlock (role keys), unlockBy (names of people who can)}.
create function pulse.erp_flow_block(p_step text) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare st jsonb := erp_flow_step(p_step); who jsonb;
begin
 if st is null or not coalesce((st->>'on')::boolean, true) then return null; end if;
 if p_step in ('approve', 'price') then
  -- An approval stops whoever is not among its approvers.
  if erp_flow_holds(st->'roles') then return null; end if;
 elsif coalesce((st->>'locked')::boolean, false) and st ? 'lockedFor' then
  if not viewer_is(variadic array(select jsonb_array_elements_text(st->'lockedFor'))) or erp_flow_holds(coalesce(st->'unlock', '[]'::jsonb)) and coalesce(jsonb_array_length(st->'unlock'), 0) > 0 then
   return null; end if;
 elsif erp_flow_holds(st->'roles') then return null;
 end if;
 who := coalesce((select jsonb_agg(distinct p.display_name) from person p join role_assignment r on r.person_id = p.id and r.org_id = p.org_id
   where p.org_id = current_org() and p.status = 'active' and p.side = 'staff' and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')
   and r.role_key in (select jsonb_array_elements_text(coalesce(st->'unlock', st->'roles', '[]'::jsonb)))), '[]'::jsonb);
 return jsonb_build_object('step', p_step, 'why', coalesce(st->>'why', 'This step is for ' || array_to_string(array(select jsonb_array_elements_text(st->'roles')), ', ')),
   'unlock', coalesce(st->'unlock', st->'roles', '[]'::jsonb), 'unlockBy', who);
end $$;
revoke all on function pulse.erp_flow_step(text), pulse.erp_flow_holds(jsonb), pulse.erp_flow_block(text) from public;
grant execute on function pulse.erp_flow_step(text), pulse.erp_flow_holds(jsonb), pulse.erp_flow_block(text), pulse.erp_flow_defaults(), pulse.erp_flow_preset(text) to pulse_api, pulse_worker;

-- Leadership or an admin chooses a preset ({"preset":"ea"|"wl"}) or changes steps ({"steps":{...}}); the approval switch
-- and who sees cost follow a preset. Logged.
create function pulse.erp_flow_save(p jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := erp_require(true); preset text := nullif(p->>'preset', ''); steps jsonb; k text;
begin
 if not viewer_is('leadership', 'admin') then raise exception 'Leadership or an admin sets the sales flow' using errcode = '42501'; end if;
 if preset is not null and preset not in ('ea', 'wl') then raise exception 'Choose the EA or the Willow Lane preset' using errcode = '22023'; end if;
 if preset is not null then steps := erp_flow_preset(preset);
 else
  -- A change merges into each step it names (switching a step off keeps who does it).
  steps := coalesce((select f.steps from erp_flow f where f.org_id = current_org()), '{}'::jsonb);
  for k in select jsonb_object_keys(coalesce(p->'steps', '{}'::jsonb)) loop
   if jsonb_typeof(p->'steps'->k) <> 'object' then raise exception 'Each step is a set of its settings' using errcode = '22023'; end if;
   steps := jsonb_set(steps, array[k], coalesce(steps->k, '{}'::jsonb) || (p->'steps'->k));
  end loop;
 end if;
 for k in select jsonb_object_keys(steps) loop
  if not (erp_flow_defaults() ? k) then raise exception 'There is no step called %', k using errcode = '22023'; end if;
  if jsonb_typeof(steps->k) <> 'object' then raise exception 'Each step is a set of its settings' using errcode = '22023'; end if;
 end loop;
 insert into erp_flow(org_id, preset, steps, updated_by) values (current_org(), coalesce(preset, 'custom'), steps, me)
 on conflict (org_id) do update set preset = excluded.preset, steps = excluded.steps, updated_by = me, updated_at = now();
 if preset is not null then
  update erp_settings set quote_approval = (preset = 'wl'), cost_visibility = case preset when 'ea' then 'owner' else 'everyone' end where org_id = current_org();
 elsif p->'steps'->'approve' ? 'on' then
  update erp_settings set quote_approval = (p->'steps'->'approve'->>'on')::boolean where org_id = current_org();
 end if;
 perform erp_log('settings', null, 'flow_saved', jsonb_build_object('preset', coalesce(preset, 'custom')));
 return jsonb_build_object('preset', coalesce(preset, 'custom'));
end $$;
revoke all on function pulse.erp_flow_save(jsonb) from public;
grant execute on function pulse.erp_flow_save(jsonb) to pulse_api;

-- --------------------------------------------------------------------------- the gates read the company's flow
-- 1561's approval gate: on with the approve step, its approvers from the step (plus the person it was sent to).
create or replace function pulse.erp_approval_gate() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
declare st jsonb;
begin
  if old.status <> 'draft' and new.status = 'draft' then
    new.approval_to := null; new.approval_asked_by := null; new.approval_asked_at := null; new.approval_note := null;
    return new;
  end if;
  if old.status = 'draft' and new.status = 'issued' and pulse.current_viewer() is not null
    and (new.doc_type = 'quotation' or (new.doc_type in ('proforma', 'invoice') and new.source_id is null)) then
    st := pulse.erp_flow_step('approve');
    if coalesce((st->>'on')::boolean, false) and not pulse.erp_flow_holds(st->'roles') and new.approval_to is distinct from pulse.current_viewer() then
      raise exception 'A manager or the owner approves this %: send it for approval', case new.doc_type when 'quotation' then 'quotation' when 'proforma' then 'proforma' else 'invoice' end
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- 0506's price flag and its owner approval: on with the price step, its approvers from the step.
create or replace function pulse.erp_quote_flag(p_doc uuid) returns text language sql stable security definer set search_path=pulse,pg_temp as $$
 select case when coalesce((erp_flow_step('price')->>'on')::boolean, true)
  and exists(select 1 from erp_line l left join erp_item i on i.org_id=l.org_id and i.id=l.item_id
  where l.org_id=current_org() and l.document_id=p_doc and (l.item_id is null or l.rate is distinct from coalesce(l.catalogue_rate,i.price))) then 'needed' end
$$;
create or replace function pulse.erp_quote_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if tg_op='INSERT' then
  if (new.service_key_id is null and (new.request_key is not null or new.request_hash is not null or new.request_result is not null))
   or (new.service_key_id is not null and current_setting('pulse.actor_account',true) is distinct from 'service:'||new.service_key_id::text) then
   raise exception 'Service provenance is recorded only by its service key' using errcode='42501'; end if;
  new.owner_approval:=null;
  return new;
 end if;
 if (new.service_key_id,new.request_key,new.request_hash,new.lead_id) is distinct from (old.service_key_id,old.request_key,old.request_hash,old.lead_id)
  or (old.service_key_id is not null and new.doc_type<>old.doc_type) or (old.request_result is not null and new.request_result is distinct from old.request_result) then
  raise exception 'Service quotation provenance is fixed' using errcode='22023'; end if;
 if old.service_key_id is null or old.doc_type<>'quotation' or old.status<>'draft' then new.owner_approval:=old.owner_approval; return new; end if;
 new.owner_approval:=erp_quote_flag(old.id);
 if new.status not in ('draft','cancelled') and new.owner_approval='needed' then
  if not erp_flow_holds(erp_flow_step('price')->'roles') then raise exception 'Owner approval needed: a price differs from the catalogue' using errcode='42501'; end if;
  new.owner_approval:='approved';
  perform erp_log('document',old.id,'owner_approved');
 end if;
 return new;
end $$;

-- 1670's new-document rule: the invoice step's lock (by default the sales role makes invoices from a quotation only).
create or replace function pulse.erp_sales_seat_insert() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare b jsonb;
begin
 if new.source_id is not null and new.salesperson_id is null then
  new.salesperson_id := (select d.salesperson_id from erp_document d where d.id = new.source_id);
 end if;
 if new.salesperson_id is null and new.service_key_id is null and pulse.current_viewer() is not null and pulse.viewer_is('sales','sales_head')
    and new.created_by is not distinct from pulse.current_viewer() then
  new.salesperson_id := pulse.current_viewer();
 end if;
 if new.doc_type <> 'quotation' and new.source_id is null and pulse.current_viewer() is not null then
  b := pulse.erp_flow_block('invoice');
  if b is not null then raise exception '%: open the quotation and choose Create invoice', b->>'why' using errcode = '42501'; end if;
 end if;
 return new;
end $$;

-- migrate:down
-- Forward-only: with the table gone the gates would read nothing; restore 1561's, 0506's and 1670's definitions by hand.
