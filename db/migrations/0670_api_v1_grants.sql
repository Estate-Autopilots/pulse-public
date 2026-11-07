-- migrate:up
-- EST-1788 (CTO ruling on EST-1611, 19 Oct 2026): API v1 area grants and one database-checked principal. Twenty
-- explicit `<area>.read|write` scopes, granted per key and none by default. A legacy scope never stands for a v1 one
-- (`chats.post` is not `chats.write`), so existing keys gain nothing. A v1 request gets its identity only from the two
-- functions below: the key's AI member becomes the viewer with agent_session on (never a staff viewer), so row
-- security and the chat checks decide what it reaches. The same list is V1_SCOPES in services/api/src/service-key.ts.
create function pulse.v1_scopes() returns text[] language sql immutable as $$
  select array['tasks.read','tasks.write','projects.read','projects.write','people.read','people.write','chats.read','chats.write',
   'docs.read','docs.write','billing.read','billing.write','workflows.read','workflows.write','companies.read','companies.write',
   'search.read','search.write','events.read','events.write']
$$;

-- psvc_ (connected app): legacy or v1 scopes; chats.post or any v1 scope needs the bound AI member.
alter table pulse_priv.service_key drop constraint service_key_scopes_check, drop constraint service_key_agent_check;
alter table pulse_priv.service_key add constraint service_key_scopes_check check(cardinality(scopes)>0 and array_position(scopes,null) is null
 and scopes <@ (array['catalog.read','clients.read','leads.read','quotes.draft.create','notify.quote_ready','chats.post']||pulse.v1_scopes())),
 add constraint service_key_agent_check check((agent_id is not null)=('chats.post'=any(scopes) or scopes && pulse.v1_scopes()));

-- pak_ (AI employee): v1 scopes only; existing keys keep none, and /api/v0/agent/* never reads the column.
alter table pulse_priv.agent_key add column scopes text[] not null default '{}'
 check(array_position(scopes,null) is null and scopes <@ pulse.v1_scopes());

drop function pulse.agent_key_issue(uuid,text,int);
create function pulse.agent_key_issue(p_agent uuid, p_label text, p_days int default 90, p_scopes text[] default '{}') returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_prefix text; v_secret text;
begin
  if agent_session() is not null or not viewer_is('admin') then raise exception 'Admins issue co-worker keys' using errcode='42501'; end if;
  if not exists(select 1 from agent_member where person_id = p_agent and org_id = current_org() and disabled_at is null) then
    raise exception 'Choose an active co-worker' using errcode='22023'; end if;
  if p_days is null or p_days not between 1 and 365 then raise exception 'A key lasts 1 to 365 days' using errcode='22023'; end if;
  loop
    v_prefix := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
    exit when not exists(select 1 from pulse_priv.agent_key where prefix = v_prefix);
  end loop;
  v_secret := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into pulse_priv.agent_key(org_id, person_id, prefix, secret_hash, label, created_by, expires_at, scopes)
  values (current_org(), p_agent, v_prefix, encode(sha256(convert_to(v_secret, 'UTF8')), 'hex'), left(coalesce(p_label, ''), 80), current_viewer(),
          now() + make_interval(days => p_days), p_scopes);
  perform audit_write('agent_key_issued', 'agent_key', v_prefix, p_scopes);
  return 'pak_' || v_prefix || '_' || v_secret;
end $$;

-- Both principals run on the request's own transaction (tenant already set, no viewer) and return the AI member the
-- viewer now is, or null with no viewer set. The final agent_session() check is the guarantee: an active AI member of
-- this company, never staff.
create function pulse.v1_service_principal(p_id uuid, p_hash text, p_scope text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare agent uuid;
begin
  -- Install-local, like every psvc_ route: refused on another company's address before the key is touched.
  if current_viewer() is not null or current_org() is distinct from install_org() or p_scope is null or not(p_scope = any(v1_scopes()))
     or not service_key_auth(p_id, p_hash, p_scope) then return null; end if;
  -- The bound member, checked the way service_chat_post checks it.
  select k.agent_id into agent from pulse_priv.service_key k join agent_member a on a.person_id = k.agent_id join person p on p.id = a.person_id
   where k.id = p_id and k.org_id = install_org() and k.org_id = current_org() and k.revoked_at is null and p_scope = any(k.scopes)
     and a.org_id = k.org_id and a.disabled_at is null and p.org_id = k.org_id and p.side = 'agent' and p.status = 'active' for share of k, a, p;
  if agent is not null then
    perform set_config('pulse.viewer_id', agent::text, true);
    perform set_config('pulse.agent_session', 'on', true);
    if agent_session() = agent then return agent; end if;
  end if;
  perform set_config('pulse.viewer_id', '', true);
  perform set_config('pulse.agent_session', '', true);
  perform set_config('pulse.actor_account', '', true);
  return null;
end $$;

create function pulse.v1_agent_principal(p_key text, p_scope text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare agent uuid;
begin
  if current_viewer() is not null or p_scope is null or not(p_scope = any(v1_scopes())) then return null; end if;
  agent := agent_key_resolve(p_key);
  if agent is null or not exists(select 1 from pulse_priv.agent_key where prefix = substr(p_key, 5, 8) and org_id = current_org()
     and person_id = agent and revoked_at is null and expires_at > now() and p_scope = any(scopes)) then return null; end if;
  perform set_config('pulse.viewer_id', agent::text, true);
  perform set_config('pulse.agent_session', 'on', true);
  if agent_session() is distinct from agent then
    perform set_config('pulse.viewer_id', '', true);
    perform set_config('pulse.agent_session', '', true);
    return null;
  end if;
  -- The EST-1733 audit contract, as agentTx sets it: actor_id is the AI's person, actor_account names it.
  perform set_config('pulse.actor_account', 'agent:' || coalesce((select username from people_profile where person_id = agent), agent::text), true);
  return agent;
end $$;

revoke all on function pulse.v1_scopes(), pulse.agent_key_issue(uuid,text,int,text[]), pulse.v1_service_principal(uuid,text,text),
  pulse.v1_agent_principal(text,text) from public;
grant execute on function pulse.v1_scopes(), pulse.agent_key_issue(uuid,text,int,text[]), pulse.v1_service_principal(uuid,text,text),
  pulse.v1_agent_principal(text,text) to pulse_api;
-- migrate:down
-- Forward-only; revoke keys or issue them without v1 scopes to remove v1 access.
