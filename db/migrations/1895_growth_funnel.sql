-- migrate:up
-- GROWTH-LOOP slice 2 (owner, 8 Nov 2026): the "What is Vitals?" funnel. A client-side person or a guest who meets
-- Vitals through another company (its chat, its quotation link, its agreement link) sees "Powered by <company> ·
-- Vitals" and a small card with a 60-second explainer and "Start free for your business". What they do with the card
-- is written to pulse.growth_event (1894) under the company that brought them: viewed, clicked, dismissed, and the
-- company they opened (org_created). The investor numbers (1894) count it; nothing about the person is stored: the
-- visitor is the SHA-256 of an anonymous browser id (signed out) or of their Pulse account (signed in).

-- Internal: one row, under the company that brought them (once per event, source, visitor and day).
create function pulse.growth_record(p_org uuid, p_event text, p_source text, p_visitor text, p_new_org uuid) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_back text := coalesce(current_setting('pulse.org_id', true), ''); v_n int;
begin
  if p_org is null or p_event not in ('viewed', 'clicked', 'dismissed', 'org_created') or p_source not in ('chat', 'quote', 'contract', 'portal')
     or p_visitor is null or p_visitor !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  perform set_config('pulse.org_id', p_org::text, true);
  insert into growth_event(org_id, event, source, visitor, new_org) values (p_org, p_event, p_source, p_visitor, p_new_org) on conflict do nothing;
  get diagnostics v_n = row_count;
  perform set_config('pulse.org_id', v_back, true);
  return v_n > 0;
end $$;
revoke all on function pulse.growth_record(uuid, text, text, text, uuid) from public;

-- A signed-in person's own visitor key: their Pulse account (or the person, without one), hashed.
create function pulse.growth_visitor() returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select encode(sha256(convert_to('growth:' || coalesce((select am.account_id::text from pulse_priv.account_member am where am.person_id = current_viewer()),
                                                         current_viewer()::text), 'UTF8')), 'hex')
$$;
revoke all on function pulse.growth_visitor() from public;

-- Signed out, on a quotation link: the link names its company (erp_accept_bind, as the page itself does). Answers the
-- company's @handle too, for "Start free for your business" (null for an unknown, stopped or other company's link).
create function pulse.growth_seen_link(p_hash text, p_event text, p_visitor text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_handle text;
begin
  if p_event is null or p_event not in ('viewed', 'clicked', 'dismissed') then
    raise exception 'Say viewed, clicked or dismissed' using errcode = '22023';
  end if;
  if not erp_accept_bind(p_hash) then return null; end if;
  if not exists (select 1 from erp_accept_link k where k.token_hash = p_hash and k.org_id = current_org() and k.revoked_at is null) then return null; end if;
  select g.handle into v_handle from org g where g.id = current_org();
  return jsonb_build_object('recorded', growth_record(current_org(), p_event, 'quote', p_visitor, null), 'via', v_handle);
end $$;
revoke all on function pulse.growth_seen_link(text, text, text) from public;
grant execute on function pulse.growth_seen_link(text, text, text) to pulse_api;

-- Signed in, inside a company (its chat or client portal): only a client-side person is counted (client, vendor,
-- partner); for staff it records nothing. Answers the company's @handle for the card's button.
create function pulse.growth_seen(p_event text, p_source text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_side text; v_handle text;
begin
  if p_event is null or p_event not in ('viewed', 'clicked', 'dismissed') or p_source is null or p_source not in ('chat', 'quote', 'contract', 'portal') then
    raise exception 'Say what happened with the card, and where' using errcode = '22023';
  end if;
  select g.handle into v_handle from org g where g.id = current_org();
  select p.side into v_side from person p where p.id = current_viewer() and p.org_id = current_org() and p.status = 'active';
  if v_side is null or v_side not in ('client', 'vendor', 'channel_partner') then
    return jsonb_build_object('recorded', false, 'via', v_handle);
  end if;
  return jsonb_build_object('recorded', growth_record(current_org(), p_event, p_source, growth_visitor(), null), 'via', v_handle);
end $$;
revoke all on function pulse.growth_seen(text, text) from public;
grant execute on function pulse.growth_seen(text, text) to pulse_api;

-- After "Start free for your business": the company just opened from the card. Only its founder (an admin of a company
-- opened in the last hour), once per company, and only for another, active company named by its @handle.
create function pulse.growth_started(p_via text, p_source text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_org uuid := current_org(); v_via uuid;
begin
  if p_source is null or p_source not in ('chat', 'quote', 'contract', 'portal') then
    raise exception 'Say where they met Vitals' using errcode = '22023';
  end if;
  if v_org is null or current_viewer() is null or not viewer_is('admin') then return jsonb_build_object('recorded', false); end if;
  if not exists (select 1 from org g where g.id = v_org and g.kind = 'company' and g.created_at > now() - interval '1 hour') then
    return jsonb_build_object('recorded', false);
  end if;
  select g.id into v_via from org g where g.handle is not null and lower(g.handle) = lower(ltrim(btrim(coalesce(p_via, '')), '@')) and g.status = 'active';
  if v_via is null or v_via = v_org then return jsonb_build_object('recorded', false); end if;
  return jsonb_build_object('recorded', growth_record(v_via, 'org_created', p_source, growth_visitor(), v_org));
end $$;
revoke all on function pulse.growth_started(text, text) from public;
grant execute on function pulse.growth_started(text, text) to pulse_api;

-- migrate:down
drop function if exists pulse.growth_started(text, text);
drop function if exists pulse.growth_seen(text, text);
drop function if exists pulse.growth_seen_link(text, text, text);
drop function if exists pulse.growth_visitor();
drop function if exists pulse.growth_record(uuid, text, text, text, uuid);
