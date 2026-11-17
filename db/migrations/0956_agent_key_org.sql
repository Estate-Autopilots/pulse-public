-- migrate:up
-- E2E-4P (23 Oct 2026): an AI employee of any organisation on the shared install can run. The co-worker front door
-- picked the install's own organisation, so agent_key_resolve (which looks only in the current organisation) refused
-- the key of an AI employee of another organisation (e.g. a client's own Pulse, or EA Production Test on dev). Like
-- session_org for a switched person's session: the API asks which organisation a valid, live key belongs to and runs
-- the request there. Answers nothing for an unknown, wrong, revoked or expired key; never shows the key or its hash.
-- The schema owner (SECURITY DEFINER functions) may find which organisation a key belongs to (as 0920 did for
-- login_session and org_invite); pulse_api still sees only its own organisation's keys.
create policy directory on pulse_priv.agent_key for select
  using (current_user = (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'pulse'));
create function pulse.agent_key_org(p_key text) returns table(org_id uuid, status text, rehearsal boolean)
language sql stable security definer set search_path = pulse, pg_temp as $$
  select k.org_id, o.status, o.rehearsal from pulse_priv.agent_key k join org o on o.id = k.org_id
   where p_key ~ '^pak_[0-9a-f]{8}_[0-9a-f]{64}$' and k.prefix = substr(p_key, 5, 8)
     and k.secret_hash = encode(sha256(convert_to(substr(p_key, 14), 'UTF8')), 'hex')
     and k.revoked_at is null and k.expires_at > now()
$$;
revoke all on function pulse.agent_key_org(text) from public;
grant execute on function pulse.agent_key_org(text) to pulse_api;

-- migrate:down
drop function if exists pulse.agent_key_org(text);
drop policy if exists directory on pulse_priv.agent_key;
