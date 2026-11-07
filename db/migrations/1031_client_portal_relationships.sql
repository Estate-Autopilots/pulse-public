-- migrate:up
-- CLIENT-PORTAL 2 (owner, 25 Oct 2026: "connections between businesses: a client hires a marketing agency (that is EA),
-- EA hires a developer… who hires whom, what contract, which package"). A connection already has a kind (1020: client,
-- vendor, partner) and a role. Here: a request made on Connections says the kind and the role; the connection list says
-- who hires whom and carries the contract as the serving side keeps it (its client packages for the client record:
-- erp_engagement with instalments), read for either side through a SECURITY DEFINER function that checks the viewer is
-- in one of the two organisations. Everything else of 0953/0957 is unchanged.

-- The contract of a connection: the serving organisation's client packages for the linked client record.
create function pulse.connect_contract(p_conn uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k pulse_priv.org_connection%rowtype; v_provider uuid; r jsonb; v_here uuid := current_org(); v_viewer uuid := current_viewer();
begin
  select * into k from pulse_priv.org_connection where id = p_conn and current_org() in (a_org, b_org);
  if k.id is null or k.client_id is null then return null; end if;
  v_provider := case when k.kind = 'vendor' then k.b_org else k.a_org end;
  if v_provider <> v_here then perform acct_enter(v_provider, null); end if;
  select jsonb_build_object(
      'packages', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'name', coalesce((select name from erp_item where id = e.package_id), e.name), 'status', e.status,
          'startsOn', to_char(e.starts_on, 'YYYY-MM-DD'), 'price', e.price, 'gstRate', e.gst_rate,
          'instalments', (select count(*)::int from erp_milestone m where m.engagement_id = e.id),
          'paid', (select count(*)::int from erp_milestone m join erp_document d on d.id = m.document_id where m.engagement_id = e.id and d.status = 'paid'),
          'project', (select coalesce(title, name) from project where id = e.project_id)) order by e.created_at desc)
        from erp_engagement e where e.org_id = v_provider and e.client_id = k.client_id and e.status <> 'cancelled'), '[]'::jsonb),
      'waiting', (select count(*)::int from client_share s join erp_document d on d.id = s.document_id
        where s.org_id = v_provider and s.client_id = k.client_id and s.withdrawn_at is null and s.decision is null and d.status in ('issued', 'sent')),
      'projects', (select count(*)::int from project p where p.org_id = v_provider and p.client_id = k.client_id and p.deleted_at is null))
    into r;
  if v_provider <> v_here then perform acct_leave(); end if;
  perform set_config('pulse.org_id', v_here::text, true);
  perform set_config('pulse.viewer_id', coalesce(v_viewer::text, ''), true);
  return r;
end $$;
revoke all on function pulse.connect_contract(uuid) from public;

-- 0953's request, plus the kind (they are our client, our vendor, a partner) and the role ("Marketing agency", "Developer").
create or replace function pulse.connect_request_create(p jsonb, p_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_id uuid; v_poc uuid := coalesce(nullif(p ->> 'poc', '')::uuid, current_viewer()); e text := nullif(lower(btrim(coalesce(p ->> 'email', ''))), '');
  v_kind text := coalesce(nullif(p ->> 'kind', ''), 'client');
begin
  if not viewer_is('admin', 'leadership', 'hr') then raise exception 'Admins, HR and leadership send client requests' using errcode = '42501'; end if;
  if length(btrim(coalesce(p ->> 'company', ''))) not between 2 and 80 then raise exception 'Give the client''s company name' using errcode = '22023'; end if;
  if length(btrim(coalesce(p ->> 'contact', ''))) not between 2 and 120 then raise exception 'Give the client contact''s name' using errcode = '22023'; end if;
  if e is not null and e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Give a valid e-mail or leave it empty' using errcode = '22023'; end if;
  if v_kind not in ('client', 'vendor', 'partner') then raise exception 'Choose who they are to you: a client, a vendor or a partner' using errcode = '22023'; end if;
  if not exists (select 1 from person where id = v_poc and org_id = current_org() and side = 'staff' and status = 'active') then
    raise exception 'Choose a point of contact from your team' using errcode = '22023'; end if;
  insert into pulse_priv.connect_request(from_org, token_hash, company_name, contact_name, contact_email, contact_phone, project, summary, poc_person, created_by, kind, role)
  values (current_org(), p_hash, btrim(p ->> 'company'), btrim(p ->> 'contact'), e, nullif(left(btrim(coalesce(p ->> 'phone', '')), 40), ''),
          nullif(left(btrim(coalesce(p ->> 'project', '')), 160), ''), nullif(left(btrim(coalesce(p ->> 'summary', '')), 2000), ''), v_poc, current_viewer(),
          v_kind, nullif(left(btrim(coalesce(p ->> 'role', '')), 80), ''))
  returning id into v_id;
  perform audit_write('invite', 'connect_request', v_id::text);
  return jsonb_build_object('id', v_id, 'org', (select name from org where id = current_org()), 'poc', (select display_name from person where id = v_poc));
end $$;

create or replace function pulse.connect_request_list() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'company', q.company_name, 'contact', q.contact_name, 'email', q.contact_email, 'project', q.project,
    'status', case when q.status = 'open' and q.expires_at <= now() then 'expired' else q.status end, 'at', q.created_at, 'expiresAt', q.expires_at,
    'poc', (select display_name from person where id = q.poc_person), 'by', (select display_name from person where id = q.created_by),
    'joined', (select display_name from pulse_priv.pulse_account where id = q.accepted_account), 'connection', q.connection_id,
    'kind', q.kind, 'role', q.role, 'clientId', q.client_id, 'colleague', q.join_connection is not null) order by q.created_at desc), '[]'::jsonb)
  from pulse_priv.connect_request q where q.from_org = current_org() and viewer_is('admin', 'leadership', 'hr') and q.created_at > now() - interval '180 days'
$$;

-- 0957's list, plus kind, role, who hires whom, the linked client record and the contract.
create or replace function pulse.connect_list() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare out jsonb := '[]'; c record; v_acct uuid := account_of_viewer(); v_seat uuid; v_items jsonb; x record; card jsonb; v_we_serve boolean;
begin
  if current_viewer() is null then return out; end if;
  for c in select * from pulse_priv.org_connection where status = 'active' and (a_org = current_org() or b_org = current_org()) order by created_at desc loop
    v_items := '[]';
    for x in select id, host_org from pulse_priv.connect_share where connection_id = c.id order by created_at desc loop
      v_seat := null;
      if x.host_org <> current_org() then
        select seat_person into v_seat from pulse_priv.connect_seat where connection_id = c.id and account_id = v_acct and seat_org = x.host_org and removed_at is null;
        if v_seat is null then continue; end if;
        card := connect_share_card(x.id, v_seat);
      else
        card := connect_share_card(x.id, current_viewer());
      end if;
      if card is not null then v_items := v_items || jsonb_build_array(card || jsonb_build_object('here', x.host_org = current_org())); end if;
    end loop;
    -- Who serves whom: a client connection's inviter serves the client; a vendor connection's invitee serves the inviter.
    v_we_serve := (c.kind in ('client', 'partner') and c.a_org = current_org()) or (c.kind = 'vendor' and c.b_org = current_org());
    out := out || jsonb_build_array(jsonb_build_object(
      'id', c.id, 'since', c.created_at, 'kind', c.kind, 'role', c.role, 'weInvited', c.a_org = current_org(), 'weServe', v_we_serve,
      'clientId', case when c.a_org = current_org() then c.client_id end,
      'other', jsonb_build_object('org', case when c.a_org = current_org() then c.b_org else c.a_org end, 'name', connect_other_name(c.id),
        'handle', (select handle from org where id = case when c.a_org = current_org() then c.b_org else c.a_org end), 'individual', c.b_org is null),
      'project', (select project from pulse_priv.connect_request where id = c.request_id),
      'summary', (select summary from pulse_priv.connect_request where id = c.request_id),
      'canManage', connect_can_manage(c.id) and c.b_org is not null,
      'ours', coalesce((select jsonb_agg(jsonb_build_object('seat', s.id, 'person', s.home_person, 'name', (select display_name from person where id = s.home_person), 'me', s.home_person = current_viewer()) order by s.created_at)
        from pulse_priv.connect_seat s where s.connection_id = c.id and s.home_org = current_org() and s.removed_at is null), '[]'::jsonb),
      'theirs', coalesce((select jsonb_agg(jsonb_build_object('seat', s.id, 'person', s.seat_person, 'name', p.display_name, 'role', pp.role) order by s.created_at)
        from pulse_priv.connect_seat s join person p on p.id = s.seat_person left join people_profile pp on pp.person_id = p.id
        where s.connection_id = c.id and s.seat_org = current_org() and s.removed_at is null), '[]'::jsonb),
      'mySeat', exists (select 1 from pulse_priv.connect_seat s where s.connection_id = c.id and s.account_id = v_acct and s.seat_org <> current_org() and s.removed_at is null),
      'contract', connect_contract(c.id),
      'shared', v_items));
  end loop;
  return out;
end $$;

-- migrate:down
-- Forward-only.
