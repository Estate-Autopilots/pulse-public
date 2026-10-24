-- migrate:up
-- AI-EMPLOYEES v2 (fix): an SOP link's length is checked on its own (a regular expression counts at most 255 repeats).
create or replace function pulse.agent_ai_save(p_agent uuid, p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k text; v text; a uuid; l text;
begin
  if not agent_manage_ok(p_agent) then raise exception 'Admins, HR, leadership or its manager change an AI employee' using errcode='42501'; end if;
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Send the settings' using errcode='22023'; end if;
  perform agent_lock(p_agent);
  if p ? 'listensTo' then
    if p->>'listensTo' not in ('leaders','everyone') then raise exception 'Choose leaders or everyone' using errcode='22023'; end if;
    update agent_member set listens_to = p->>'listensTo' where person_id = p_agent;
  end if;
  if p ? 'autonomy' then
    if jsonb_typeof(p->'autonomy') is distinct from 'object' then raise exception 'Choose how it acts' using errcode='22023'; end if;
    for k, v in select key, value from jsonb_each_text(p->'autonomy') loop
      if k not in ('direct','mention','group') or v not in ('own','approve','off') then raise exception 'Choose on its own, ask first or stay out' using errcode='22023'; end if;
    end loop;
    update agent_member set autonomy = autonomy || (p->'autonomy') where person_id = p_agent;
  end if;
  if p ? 'approverId' then
    a := nullif(p->>'approverId', '')::uuid;
    if a is not null and not exists(select 1 from person where id = a and org_id = current_org() and side = 'staff' and status = 'active') then
      raise exception 'Its approver is an active person in this company' using errcode='22023'; end if;
    update agent_member set approver_person_id = a where person_id = p_agent;
  end if;
  if p ? 'instructions' then
    if length(coalesce(p->>'instructions', '')) > 8000 then raise exception 'Instructions of up to 8,000 characters' using errcode='22023'; end if;
    update agent_member set instructions = btrim(coalesce(p->>'instructions', '')) where person_id = p_agent;
  end if;
  if p ? 'sopLinks' then
    if jsonb_typeof(p->'sopLinks') is distinct from 'array' or jsonb_array_length(p->'sopLinks') > 20 then raise exception 'Up to 20 SOP links' using errcode='22023'; end if;
    for l in select jsonb_array_elements_text(p->'sopLinks') loop
      if length(l) > 1000 or l !~ '^(https?://[^[:space:]]+|/[^[:space:]]+)$' then raise exception 'An SOP link is a web address or a Pulse page' using errcode='22023'; end if;
    end loop;
    update agent_member set sop_links = array(select distinct x from jsonb_array_elements_text(p->'sopLinks') x) where person_id = p_agent;
  end if;
  if p ? 'mcpServers' then
    if jsonb_typeof(p->'mcpServers') is distinct from 'array' or jsonb_array_length(p->'mcpServers') > 20 then raise exception 'Up to 20 MCP servers' using errcode='22023'; end if;
    for l in select jsonb_array_elements_text(p->'mcpServers') loop
      if l !~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,60}$' then raise exception 'Name each MCP server in letters, digits, dots and dashes' using errcode='22023'; end if;
    end loop;
    update agent_member set mcp_servers = array(select distinct btrim(x) from jsonb_array_elements_text(p->'mcpServers') x) where person_id = p_agent;
  end if;
end $$;

-- migrate:down
-- Forward-only.
