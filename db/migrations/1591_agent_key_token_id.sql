-- migrate:up
-- AI-AGENT-KEY-FIX (6 Nov 2026, hotfix for 1590). On production the AI employee runtime's own key got 403 on
-- /api/v1/mcp ("This key has no API v1 area grants here"): 1590 let pulse.v1_agent_principal admit a runtime key (no
-- areas of its own) in every area its managers left it, but resolve() then asks pulse.v1_agent_token_id (0695) for the
-- key's id under that scope, and that still required the scope in the key's own list, so it answered null and every
-- area was refused. Same rule as the principal now: a key with areas of its own stays within them; a key with none
-- reaches the AI employee's areas (all unless narrowed); a paused company gets nothing.
create or replace function pulse.v1_agent_token_id(p_prefix text, p_scope text) returns uuid
  language plpgsql security definer set search_path to 'pulse', 'pg_temp' as $function$
declare token uuid;
begin
 if agent_paused() then return null; end if;
 select k.id into token from pulse_priv.agent_key k join agent_member a on a.person_id=k.person_id join person p on p.id=a.person_id
  where k.org_id=current_org() and k.person_id=current_viewer() and k.prefix=p_prefix
   and (p_scope=any(k.scopes) or not (k.scopes && v1_scopes()))
   and p_scope=any(coalesce(a.v1_areas, v1_scopes()))
   and k.revoked_at is null and k.expires_at>clock_timestamp() and a.org_id=k.org_id and a.disabled_at is null
   and p.org_id=k.org_id and p.status='active' and p.side='agent' for share of k,a,p;
 return token;
end $function$;

-- migrate:down
-- Forward-only (0695's definition refuses every runtime key; restore it only together with 1590's principal).
