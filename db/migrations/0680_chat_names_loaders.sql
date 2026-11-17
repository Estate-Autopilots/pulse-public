-- migrate:up
-- EST-1542 (B, Pulse CEO on EST-1520, 19 Oct): the people who match the WhatsApp names (leadership and HR) also load
-- them, from the exports on their own computer: the screen reads the files there and sends only each sender's name and
-- counts. Admins still may. The Pulse CEO's conditions (EST-1520 27e32ea8): the server checks too, so each entry is
-- exactly a name with its message and group counts (anything else is refused) and a name with 7 or more digits (a phone
-- number) is refused, counting every Unicode decimal digit (category Nd, as Node 24 knows it: Unicode 17), not only 0-9
-- (EST-1913); each load is recorded with who ran it and the counts (record_change), besides the table's audit
-- trigger on every row. The load still never changes an answer.
create function pulse.chat_names_can_load() returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select current_viewer() is not null and (viewer_is('admin') or viewer_is('leadership', 'hr'))
$$;

-- How many decimal digits a name holds, in any script. The class is generated from Node's \p{Nd} by
-- tools/gen-nd-ranges.mjs; services/api/test/chat-names.test.mjs fails if it and Node disagree on any code point.
create function pulse.chat_names_digits(p text) returns int
  language sql immutable set search_path = pulse, pg_temp as $$
  select length(regexp_replace(coalesce(p, ''), '[^0-9٠-٩۰-۹߀-߉०-९০-৯੦-੯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯෦-෯๐-๙໐-໙༠-༩၀-၉႐-႙០-៩᠐-᠙᥆-᥏᧐-᧙᪀-᪉᪐-᪙᭐-᭙᮰-᮹᱀-᱉᱐-᱙꘠-꘩꣐-꣙꤀-꤉꧐-꧙꧰-꧹꩐-꩙꯰-꯹０-９𐒠-𐒩𐴰-𐴹𐵀-𐵉𑁦-𑁯𑃰-𑃹𑄶-𑄿𑇐-𑇙𑋰-𑋹𑑐-𑑙𑓐-𑓙𑙐-𑙙𑛀-𑛉𑛐-𑛣𑜰-𑜹𑣠-𑣩𑥐-𑥙𑯰-𑯹𑱐-𑱙𑵐-𑵙𑶠-𑶩𑷠-𑷩𑽐-𑽙𖄰-𖄹𖩠-𖩩𖫀-𖫉𖭐-𖭙𖵰-𖵹𜳰-𜳹𝟎-𝟿𞅀-𞅉𞋰-𞋹𞓰-𞓹𞗱-𞗺𞥐-𞥙🯰-🯹]', '', 'g'))
$$;

create or replace function pulse.chat_names_load(p_source text, p_names jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pulse_priv, pg_temp as $$
declare v_added int := 0; v_updated int := 0; r jsonb; v_key text; v_label text; v_new boolean;
begin
  if not chat_names_can_load() then
    raise exception 'Leadership, HR or an admin loads the WhatsApp names' using errcode = '42501';
  end if;
  if p_source is null or p_names is null or p_source !~ '^[a-z0-9][a-z0-9_-]{0,59}$' or jsonb_typeof(p_names) <> 'array'
     or jsonb_array_length(p_names) > 2000 then
    raise exception 'Send a source and up to 2000 names' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_names) loop
    if jsonb_typeof(r) <> 'object' or jsonb_typeof(r -> 'label') is distinct from 'string'
       or exists (select 1 from jsonb_object_keys(r) k where k not in ('label', 'messages', 'groups'))
       or (r ? 'messages' and (jsonb_typeof(r -> 'messages') <> 'number' or (r ->> 'messages') !~ '^[0-9]{1,9}$'))
       or (r ? 'groups' and (jsonb_typeof(r -> 'groups') <> 'number' or (r ->> 'groups') !~ '^[0-9]{1,9}$')) then
      raise exception 'Send only each name with its message and group counts' using errcode = '22023';
    end if;
    v_label := btrim(r ->> 'label');
    if v_label = '' or length(v_label) > 80 then
      raise exception 'Each name is 1 to 80 characters' using errcode = '22023';
    end if;
    if chat_names_digits(v_label) >= 7 then
      raise exception 'Phone numbers are never loaded' using errcode = '22023';
    end if;
    v_key := btrim(regexp_replace(regexp_replace(lower(v_label), '[^a-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g'));
    insert into pulse_priv.chat_name(org_id, source, label, label_key, messages, groups, suggestions)
    values (current_org(), p_source, v_label, v_key, greatest(coalesce((r ->> 'messages')::int, 0), 0), greatest(coalesce((r ->> 'groups')::int, 0), 0),
      coalesce((select array_agg(p.id order by p.display_name) from person p where p.org_id = current_org() and p.side = 'staff' and p.status = 'active'
        and v_key <> '' and lower(split_part(btrim(p.display_name), ' ', 1)) = split_part(v_key, ' ', 1)), '{}'))
    on conflict (org_id, source, label) do update set messages = excluded.messages, groups = excluded.groups, suggestions = excluded.suggestions
    returning (xmax = 0) into v_new;
    if v_new then v_added := v_added + 1; else v_updated := v_updated + 1; end if;
  end loop;
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (current_org(), 'org', current_org(), 'chat_names_load', null,
    jsonb_build_object('source', p_source, 'names', jsonb_array_length(p_names), 'added', v_added, 'updated', v_updated)::text, current_viewer());
  return jsonb_build_object('added', v_added, 'updated', v_updated);
end $$;

revoke all on function pulse.chat_names_can_load(), pulse.chat_names_digits(text) from public;
grant execute on function pulse.chat_names_can_load() to pulse_api;

-- migrate:down
-- Forward-only. Restoring 0640's admin-only check is a new migration.
