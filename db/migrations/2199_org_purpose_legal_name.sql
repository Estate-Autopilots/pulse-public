-- migrate:up
-- CONNECTIONS part A (owner, 16 Nov 2026: the home said "9 companies" and he is not in nine; "Vitals' legal name: the MCA
-- name is approved").
--
--  * pulse.org.purpose: what a company is for: 'work' (a real company), 'test' or 'demo'. A test or demo company still
--    opens from the switcher, under its own heading, and is never counted as one of "your companies" (switcher, My day,
--    All my companies, the home). Rehearsal companies (they never send e-mail) are test companies from the start.
--    Only a Pulse platform admin marks one, through pulse.platform_org_purpose (audit: the platform log and the
--    company's own Audit, with the reason).
--  * pulse.account_me() lists each organisation's purpose; pulse.account_seat_purposes() gives My day and All my
--    companies the same for every seat of the signed-in account.
--  * pulse.org_legal_name(org): the registered name a document prints. For this company: Billing's company profile
--    (Billing → Settings, the name quotes and invoices print), else the directory card's legal name, else the company's
--    name. For another company: the legal name its directory card shows, else its name.
--  * pulse.org_legal_name_save(name, note): Settings → Organisation → Registered name. An admin sets it once; it is
--    written to Billing's company profile (made with Billing's own defaults when Billing was never opened) and to the
--    directory card, with an audit note.
--  * A contract party that is a company on Pulse and was given no name of its own prints that company's registered name
--    (contract_party_legal_name trigger), so new agreements, quotes and invoices all read the name from settings.

alter table pulse.org add column purpose text not null default 'work';
alter table pulse.org add constraint org_purpose_check check (purpose in ('work', 'test', 'demo'));
update pulse.org set purpose = 'test' where rehearsal and purpose = 'work';

-- The platform's own mark: a real company, a test company or a demo company (a Pulse platform admin, with a reason).
create function pulse.platform_org_purpose(p_org uuid, p_purpose text, p_reason text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o org; v_reason text := platform_reason(p_reason);
begin
  perform platform_guard();
  if p_purpose is null or p_purpose not in ('work', 'test', 'demo') then raise exception 'Choose work, test or demo' using errcode = '22023'; end if;
  select * into o from org where id = p_org;
  if not found then raise exception 'Organisation not found' using errcode = 'P0002'; end if;
  if o.kind = 'personal' then raise exception 'A personal space is not a company' using errcode = '22023'; end if;
  if p_org = install_org() and p_purpose <> 'work' then raise exception 'The install''s own organisation is a real company' using errcode = '22023'; end if;
  if o.purpose = p_purpose then return jsonb_build_object('purpose', jsonb_build_array(o.purpose, p_purpose), 'changed', false); end if;
  -- pulse.org's forced row security lets an organisation change only itself: the update runs inside the target.
  perform platform_enter(p_org);
  update org set purpose = p_purpose where id = p_org;
  perform platform_leave();
  perform platform_log('org.purpose', p_org, 'org', p_org::text, o.name, v_reason, jsonb_build_object('purpose', jsonb_build_array(o.purpose, p_purpose)));
  return jsonb_build_object('purpose', jsonb_build_array(o.purpose, p_purpose), 'changed', true);
end $$;
revoke all on function pulse.platform_org_purpose(uuid, text, text) from public;
grant execute on function pulse.platform_org_purpose(uuid, text, text) to pulse_api;

-- PERSONAL-WORKSPACE (1640) as it was, plus each organisation's purpose; the one-password prompt counts real companies.
create or replace function pulse.account_me() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); a record; r record; v_suggest text;
begin
  if current_viewer() is null then return null; end if;
  if v is null then
    select p.display_name, pp.username into r from person p left join people_profile pp on pp.person_id = p.id where p.id = current_viewer();
    v_suggest := handle_suggest(coalesce(nullif(replace(coalesce(r.username, ''), '.', ''), ''), r.display_name));
    return jsonb_build_object('account', null, 'suggestion', v_suggest,
      'orgs', jsonb_build_array((select jsonb_build_object('id', o.id, 'name', o.name, 'handle', o.handle, 'code', o.code, 'kind', 'staff', 'current', true,
        'orgKind', o.kind, 'mine', false, 'purpose', o.purpose) from org o where o.id = current_org())),
      'invites', '[]'::jsonb, 'unify', false, 'personal', null);
  end if;
  select * into a from pulse_priv.pulse_account where id = v;
  return jsonb_build_object(
    'account', jsonb_build_object('id', a.id, 'handle', a.handle, 'name', a.display_name, 'email', a.email, 'hasPassword', a.password_hash is not null),
    -- PERSONAL-WORKSPACE: the account's own personal workspace first, then the current one, then the most used.
    'orgs', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'handle', o.handle, 'code', o.code, 'kind', m.kind,
        'current', o.id = current_org(), 'lastUsedAt', m.last_used_at, 'install', o.id = install_org(), 'orgKind', o.kind, 'mine', o.personal_account = v,
        'purpose', o.purpose)
        order by (o.personal_account is not distinct from v) desc, (o.id = current_org()) desc, m.last_used_at desc nulls last, o.name)
      from pulse_priv.account_member m join org o on o.id = m.member_org where m.account_id = v and o.status = 'active'), '[]'::jsonb),
    'personal', (select o.id from org o where o.personal_account = v and o.status = 'active'),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'org', o.name, 'orgHandle', o.handle, 'kind', i.kind, 'title', i.title, 'at', i.created_at) order by i.created_at desc)
      from pulse_priv.org_invite i join org o on o.id = i.org_id
      where i.to_handle = a.handle and i.status = 'open' and i.expires_at > now() and o.status = 'active'
        and not exists (select 1 from pulse_priv.account_member m where m.account_id = v and m.member_org = i.org_id)), '[]'::jsonb),
    -- The one-password prompt counts companies: the person's own workspace is not another place to sign in to.
    'unify', a.password_hash is null and (select count(*) from pulse_priv.account_member m join org o on o.id = m.member_org and o.status = 'active'
      where m.account_id = v and o.personal_account is distinct from v) > 1);
end $$;

-- What each of the signed-in account's organisations is ({org id: {purpose, kind}}: kind company or personal), for My
-- day, All my companies and the home.
create function pulse.account_seat_purposes() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_object_agg(o.id, jsonb_build_object('purpose', o.purpose, 'kind', o.kind)), '{}'::jsonb)
    from pulse_priv.account_member m join org o on o.id = m.member_org
   where m.account_id = account_of_viewer() and current_viewer() is not null
$$;

-- The registered name a document prints for a company (see the header).
-- Another company's card is read inside that company (forced row security), as pulse.account_seats reads a seat.
create function pulse.org_legal_name(p_org uuid default null) returns text
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare here text := coalesce(current_setting('pulse.org_id', true), ''); t uuid := coalesce(p_org, current_org()); v text;
begin
  if t is null then return null; end if;
  if t = current_org() then
    select nullif(btrim(s.company ->> 'legalName'), '') into v from erp_settings s where s.org_id = t;
    if v is null then select nullif(btrim(k.legal_name), '') into v from org_public_card k where k.org_id = t; end if;
  else
    perform set_config('pulse.org_id', t::text, true);
    select nullif(btrim(k.legal_name), '') into v from org_public_card k where k.org_id = t and k.show_legal_name;
    perform set_config('pulse.org_id', here, true);
  end if;
  return coalesce(v, (select o.name from org o where o.id = t));
end $$;

-- Settings → Organisation → Registered name: an admin of this company, with a note for the audit.
create function pulse.org_legal_name_save(p_name text, p_note text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); n text := nullif(btrim(coalesce(p_note, '')), '');
  before text := org_legal_name(); had_billing boolean; org_name text;
begin
  if current_viewer() is null or not viewer_is('admin') then raise exception 'Only an admin of this company sets its registered name' using errcode = '42501'; end if;
  if length(v) < 2 or length(v) > 160 then raise exception 'Write the registered name in 2 to 160 letters' using errcode = '22023'; end if;
  if n is not null and length(n) > 400 then raise exception 'Keep the note under 400 letters' using errcode = '22023'; end if;
  select name into org_name from org where id = current_org();
  select exists(select 1 from erp_settings where org_id = current_org()) into had_billing;
  if not had_billing then
    -- Billing's own first-run defaults (erp_bootstrap), with the registered name instead of the company's name.
    insert into erp_settings(org_id, company) values (current_org(), jsonb_build_object('legalName', v, 'stateCode', '27', 'address', '[]'::jsonb))
      on conflict (org_id) do nothing;
    if not exists (select 1 from erp_template where org_id = current_org()) then
      insert into erp_template(org_id, name, design) values (current_org(), 'Classic', jsonb_build_object('style', 'line', 'accent', '#5b45d6',
        'terms', 'Payment is due within 15 days of the invoice date.' || chr(10) || 'Please quote the invoice number with your payment.',
        'footer', 'This is a computer-generated document.'));
    end if;
  end if;
  update erp_settings set company = company || jsonb_build_object('legalName', v), updated_by = current_viewer(), updated_at = now()
   where org_id = current_org() and company ->> 'legalName' is distinct from v;
  insert into org_public_card(org_id, legal_name) values (current_org(), v)
    on conflict (org_id) do update set legal_name = excluded.legal_name where org_public_card.legal_name is distinct from excluded.legal_name;
  insert into audit_event(org_id, actor_id, actor_account, action, resource, resource_id, fields, source, changes)
  values (current_org(), current_viewer(), nullif(current_setting('pulse.actor_account', true), ''), 'org.legal_name', 'org', current_org()::text,
          array['legalName'], 'pulse', jsonb_build_object('from', before, 'to', v, 'note', n, 'name', org_name, 'billingMade', not had_billing));
  return jsonb_build_object('legalName', v, 'before', before, 'name', org_name, 'changed', before is distinct from v);
end $$;

-- A party that is a company on Pulse, given no name of its own (the company's display name), prints its registered name.
create function pulse.contract_party_legal_name() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if new.kind = 'company' and new.party_org is not null
     and btrim(coalesce(new.name, '')) in ('', coalesce((select o.name from org o where o.id = new.party_org), '')) then
    new.name := left(coalesce(org_legal_name(new.party_org), new.name), 160);
  end if;
  return new;
end $$;
create trigger contract_party_legal_name before insert on pulse.contract_party for each row execute function pulse.contract_party_legal_name();

-- migrate:down
drop trigger if exists contract_party_legal_name on pulse.contract_party;
drop function if exists pulse.contract_party_legal_name();
drop function if exists pulse.org_legal_name_save(text, text);
drop function if exists pulse.org_legal_name(uuid);
drop function if exists pulse.account_seat_purposes();
drop function if exists pulse.platform_org_purpose(uuid, text, text);
-- pulse.account_me(): its previous body is 1640_personal_workspace.sql (it only adds 'purpose' to each organisation).
alter table pulse.org drop constraint if exists org_purpose_check;
alter table pulse.org drop column if exists purpose;
