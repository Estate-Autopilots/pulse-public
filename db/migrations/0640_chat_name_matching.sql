-- migrate:up
-- EST-1542 (owner decision 19 Oct: "a small private matching screen in Pulse for leadership and HR"): before WhatsApp group
-- history is imported (R47, 0350), someone who knows the groups decides once who each WhatsApp sender name is: a
-- colleague (which person), not staff (a client, partner or former staff; the name stays as written), or skip (a
-- bot or group notice). The names arrive from a recorded list (an admin loads them; counts only, never message text)
-- and live in pulse_priv like the imported history: no table grant to any service role, reads and writes only through
-- the functions below, which leadership and HR may call. A person's decision is never overwritten by a reload, and
-- every change is audited. Company-neutral: a list belongs to one organisation and one named source.

create table pulse_priv.chat_name (
  org_id      uuid not null references pulse.org(id),
  id          uuid primary key default gen_random_uuid(),
  source      text not null check (source ~ '^[a-z0-9][a-z0-9_-]{0,59}$'),
  label       text not null check (length(label) between 1 and 80),
  label_key   text not null check (label_key ~ '^[a-z0-9 ]{0,80}$'),
  messages    int not null default 0 check (messages >= 0),
  groups      int not null default 0 check (groups >= 0),
  suggestions uuid[] not null default '{}',
  decision    text check (decision in ('colleague', 'not_staff', 'skip')),
  person_id   uuid references pulse.person(id),
  decided_by  uuid references pulse.person(id),
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  check ((decision = 'colleague') = (person_id is not null)),
  unique (org_id, source, label)
);
alter table pulse_priv.chat_name enable row level security;
alter table pulse_priv.chat_name force row level security;
create policy tenant on pulse_priv.chat_name using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on pulse_priv.chat_name from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy;
create trigger audit_mutation after insert or update or delete on pulse_priv.chat_name for each row execute function pulse.audit_mutation();

create function pulse.chat_names_allowed() returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select current_viewer() is not null and viewer_is('leadership', 'hr')
$$;

-- The list, most-used names first, with the colleagues each could be and whoever decided.
create function pulse.chat_names_read(p_source text) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pulse_priv, pg_temp as $$
begin
  if not chat_names_allowed() then
    raise exception 'Leadership and HR match WhatsApp names' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'label', n.label, 'messages', n.messages, 'groups', n.groups,
      'suggestions', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name) order by p.display_name)
        from person p where p.id = any(n.suggestions) and p.status = 'active'), '[]'),
      'decision', n.decision, 'person', case when n.person_id is null then null else
        (select jsonb_build_object('id', p.id, 'name', p.display_name) from person p where p.id = n.person_id) end,
      'decidedBy', (select p.display_name from person p where p.id = n.decided_by), 'decidedAt', n.decided_at)
    order by n.messages desc, n.label)
    from pulse_priv.chat_name n where n.org_id = current_org() and n.source = p_source), '[]');
end $$;

-- One answer. The newest answer wins; it is in the audit trail with who gave it.
create function pulse.chat_name_decide(p_id uuid, p_decision text, p_person uuid) returns void
  language plpgsql security definer set search_path = pulse, pulse_priv, pg_temp as $$
begin
  if not chat_names_allowed() then
    raise exception 'Leadership and HR match WhatsApp names' using errcode = '42501';
  end if;
  if p_decision is not null and p_decision not in ('colleague', 'not_staff', 'skip') then
    raise exception 'Choose a colleague, not staff or skip' using errcode = '22023';
  end if;
  if (p_decision = 'colleague') <> (p_person is not null) and p_decision is not null then
    raise exception 'Choose which colleague' using errcode = '22023';
  end if;
  if p_person is not null and not exists (select 1 from person where id = p_person and org_id = current_org() and side = 'staff') then
    raise exception 'Choose a colleague from this organisation' using errcode = '22023';
  end if;
  update pulse_priv.chat_name set decision = p_decision, person_id = case when p_decision = 'colleague' then p_person end,
    decided_by = case when p_decision is null then null else current_viewer() end, decided_at = case when p_decision is null then null else now() end
  where id = p_id and org_id = current_org();
  if not found then raise exception 'Name not found' using errcode = 'P0002'; end if;
end $$;

-- An admin loads a recorded list ({label, messages, groups} each); counts and suggestions are refreshed, decisions kept.
-- Suggestions: active colleagues whose first name is the name's first word.
create function pulse.chat_names_load(p_source text, p_names jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pulse_priv, pg_temp as $$
declare v_added int := 0; v_updated int := 0; r jsonb; v_key text; v_label text; v_new boolean;
begin
  if not viewer_is('admin') or current_viewer() is null then
    raise exception 'An organisation admin loads the WhatsApp names' using errcode = '42501';
  end if;
  if p_source !~ '^[a-z0-9][a-z0-9_-]{0,59}$' or jsonb_typeof(p_names) <> 'array' or jsonb_array_length(p_names) > 2000 then
    raise exception 'Send a source and up to 2000 names' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_names) loop
    v_label := left(btrim(r ->> 'label'), 80);
    if v_label is null or v_label = '' then continue; end if;
    v_key := btrim(regexp_replace(regexp_replace(lower(v_label), '[^a-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g'));
    insert into pulse_priv.chat_name(org_id, source, label, label_key, messages, groups, suggestions)
    values (current_org(), p_source, v_label, v_key, greatest(coalesce((r ->> 'messages')::int, 0), 0), greatest(coalesce((r ->> 'groups')::int, 0), 0),
      coalesce((select array_agg(p.id order by p.display_name) from person p where p.org_id = current_org() and p.side = 'staff' and p.status = 'active'
        and v_key <> '' and lower(split_part(btrim(p.display_name), ' ', 1)) = split_part(v_key, ' ', 1)), '{}'))
    on conflict (org_id, source, label) do update set messages = excluded.messages, groups = excluded.groups, suggestions = excluded.suggestions
    returning (xmax = 0) into v_new;
    if v_new then v_added := v_added + 1; else v_updated := v_updated + 1; end if;
  end loop;
  return jsonb_build_object('added', v_added, 'updated', v_updated);
end $$;

revoke all on function pulse.chat_names_allowed(), pulse.chat_names_read(text), pulse.chat_name_decide(uuid, text, uuid),
  pulse.chat_names_load(text, jsonb) from public;
grant execute on function pulse.chat_names_allowed(), pulse.chat_names_read(text), pulse.chat_name_decide(uuid, text, uuid),
  pulse.chat_names_load(text, jsonb) to pulse_api;

-- migrate:down
-- Forward-only.
