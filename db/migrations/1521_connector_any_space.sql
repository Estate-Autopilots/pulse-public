-- migrate:up
-- SELF-SERVE (owner, 4 Nov 2026: "account creation from ChatGPT/Claude: sign-up must work inside the OAuth authorize
-- flow; a new person can create an account while connecting the Pulse connector"). EST-2811's connector (1412) knew
-- only the organisation of the address it was reached on: a client registered there, codes, connections and tokens were
-- looked up in that organisation. On Pulse's shared address (pulse.<install>, the one ChatGPT and Claude are given) a
-- person who signed up just now works in their own space, so the consent screen said "This app is not registered here".
-- Now, on the shared address only (the API says so: pulse.shared_address = '1', set around each oauth call and the API v1
-- token lookups only, and cleared straight after; review, 5 Nov 2026):
--   * an app registered once is known in every space (client ids are random and registration was already open to
--     anyone; its secret, return addresses and PKCE still bind every code);
--   * the code, the connection and its tokens live in the space where the person approved (as before: their session's
--     organisation), and the token endpoint and API v1 / MCP find them there by the token's hash, then act inside that
--     space only (the request's organisation becomes the token's; nothing else of the shared address is reachable).
-- On a company's own address nothing changes: its own codes and tokens only.

create function pulse.oauth_reach(p_org uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select p_org = current_org() or coalesce(current_setting('pulse.shared_address', true), '') = '1'
$$;
revoke all on function pulse.oauth_reach(uuid) from public;

-- The four tables keep their organisation policy; on the shared address the connector's own functions (the schema
-- owner; no service role reads these tables) may also find and update a row of another space by its hash or id.
create policy shared_address_reach on pulse_priv.oauth_client for select using (coalesce(current_setting('pulse.shared_address', true), '') = '1');
create policy shared_address_reach on pulse_priv.oauth_code for select using (coalesce(current_setting('pulse.shared_address', true), '') = '1');
create policy shared_address_update on pulse_priv.oauth_code for update using (coalesce(current_setting('pulse.shared_address', true), '') = '1');
create policy shared_address_reach on pulse_priv.oauth_token for select using (coalesce(current_setting('pulse.shared_address', true), '') = '1');
create policy shared_address_update on pulse_priv.oauth_token for update using (coalesce(current_setting('pulse.shared_address', true), '') = '1');
create policy shared_address_reach on pulse_priv.oauth_grant for select using (coalesce(current_setting('pulse.shared_address', true), '') = '1');
create policy shared_address_update on pulse_priv.oauth_grant for update using (coalesce(current_setting('pulse.shared_address', true), '') = '1');

create or replace function pulse.oauth_client_peek(p_client text) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('name', name, 'redirectUris', to_jsonb(redirect_uris), 'confidential', secret_sha256 is not null)
 from pulse_priv.oauth_client where client_id = p_client and revoked_at is null and oauth_reach(org_id)
$$;

create or replace function pulse.oauth_code_issue(p_code text, p_client text, p_scopes text[], p_redirect text, p_challenge text) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or not exists(select 1 from person where org_id = current_org() and id = current_viewer() and status = 'active' and side = 'staff')
  then raise exception 'An active staff account approves apps' using errcode='42501'; end if;
 if not exists(select 1 from pulse_priv.oauth_client where client_id = p_client and revoked_at is null and p_redirect = any(redirect_uris) and oauth_reach(org_id))
  then raise exception 'Unknown app or return address' using errcode='22023'; end if;
 if cardinality(p_scopes) = 0 or not (p_scopes <@ v1_scopes()) then raise exception 'Unknown permission' using errcode='22023'; end if;
 insert into pulse_priv.oauth_code(org_id, code_sha256, client_id, person_id, scopes, redirect_uri, code_challenge)
 values (current_org(), p_code, p_client, current_viewer(), p_scopes, p_redirect, p_challenge);
end $$;

create or replace function pulse.oauth_client_ok(p_client text, p_secret text) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from pulse_priv.oauth_client where client_id = p_client and revoked_at is null and oauth_reach(org_id)
  and secret_sha256 is not distinct from p_secret)
$$;

create or replace function pulse.oauth_exchange(p_code text, p_client text, p_secret text, p_redirect text, p_verifier_challenge text, p_access text, p_refresh text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare x pulse_priv.oauth_code; g uuid; moved boolean := false; r jsonb;
begin
 if not oauth_client_ok(p_client, p_secret) then return jsonb_build_object('error', 'invalid_client'); end if;
 select * into x from pulse_priv.oauth_code where code_sha256 = p_code for update;
 if not found or not oauth_reach(x.org_id) or x.client_id <> p_client then return jsonb_build_object('error', 'invalid_grant'); end if;
 -- The code's space: the connection and its tokens are made there.
 if x.org_id <> current_org() then perform acct_enter(x.org_id, null); moved := true; end if;
 if x.used_at is not null then
  -- A replayed code ends what it started (RFC 6749 §4.1.2).
  update pulse_priv.oauth_grant set revoked_at = now(), revoked_reason = 'security:code_replay'
   where org_id = current_org() and client_id = x.client_id and person_id = x.person_id and revoked_at is null;
  r := jsonb_build_object('error', 'invalid_grant');
 else
  update pulse_priv.oauth_code set used_at = now() where code_sha256 = p_code;
  if x.expires_at < now() or x.redirect_uri <> p_redirect or x.code_challenge <> p_verifier_challenge
     or not exists(select 1 from person where org_id = current_org() and id = x.person_id and status = 'active') then
   r := jsonb_build_object('error', 'invalid_grant');
  else
   insert into pulse_priv.oauth_grant(org_id, client_id, person_id, scopes) values (current_org(), x.client_id, x.person_id, x.scopes) returning id into g;
   perform oauth_tokens_make(g, p_access, p_refresh);
   r := jsonb_build_object('scope', array_to_string(x.scopes, ' '), 'expiresIn', 3600);
  end if;
 end if;
 if moved then perform acct_leave(); end if;
 return r;
end $$;

create or replace function pulse.oauth_refresh(p_refresh text, p_client text, p_secret text, p_access text, p_new_refresh text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t pulse_priv.oauth_token; g pulse_priv.oauth_grant; fresh uuid; moved boolean := false; r jsonb;
begin
 if not oauth_client_ok(p_client, p_secret) then return jsonb_build_object('error', 'invalid_client'); end if;
 select * into t from pulse_priv.oauth_token where token_sha256 = p_refresh and kind = 'refresh' for update;
 if not found or not oauth_reach(t.org_id) then return jsonb_build_object('error', 'invalid_grant'); end if;
 select * into g from pulse_priv.oauth_grant where id = t.grant_id for update;
 if g.client_id <> p_client then return jsonb_build_object('error', 'invalid_grant'); end if;
 if t.org_id <> current_org() then perform acct_enter(t.org_id, null); moved := true; end if;
 if t.replaced_by is not null then
  update pulse_priv.oauth_grant set revoked_at = coalesce(revoked_at, now()), revoked_reason = coalesce(revoked_reason, 'security:refresh_reuse') where id = g.id;
  r := jsonb_build_object('error', 'invalid_grant');
 elsif g.revoked_at is not null or t.revoked_at is not null or t.expires_at < now()
    or not exists(select 1 from person where org_id = current_org() and id = g.person_id and status = 'active') then
  r := jsonb_build_object('error', 'invalid_grant');
 else
  fresh := oauth_tokens_make(g.id, p_access, p_new_refresh);
  update pulse_priv.oauth_token set revoked_at = now(), replaced_by = fresh where id = t.id;
  r := jsonb_build_object('scope', array_to_string(g.scopes, ' '), 'expiresIn', 3600);
 end if;
 if moved then perform acct_leave(); end if;
 return r;
end $$;

create or replace function pulse.oauth_revoke(p_token text, p_client text, p_secret text) returns boolean
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t pulse_priv.oauth_token;
begin
 if not oauth_client_ok(p_client, p_secret) then return false; end if;
 select tk.* into t from pulse_priv.oauth_token tk join pulse_priv.oauth_grant g on g.id = tk.grant_id
  where tk.token_sha256 = p_token and g.client_id = p_client and oauth_reach(tk.org_id);
 if found then
  if t.kind = 'refresh' then update pulse_priv.oauth_grant set revoked_at = coalesce(revoked_at, now()), revoked_reason = coalesce(revoked_reason, 'client_revoked') where id = t.grant_id;
  else update pulse_priv.oauth_token set revoked_at = coalesce(revoked_at, now()) where id = t.id; end if;
 end if;
 return true;
end $$;

-- API v1 / MCP: the token's space becomes the request's organisation (shared address only), then as before.
create or replace function pulse.v1_person_principal(p_token text, p_scope text) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t pulse_priv.oauth_token; g pulse_priv.oauth_grant; app text; moved boolean := false;
begin
 if current_viewer() is not null or p_scope is null or not (p_scope = any(v1_scopes())) then return null; end if;
 select * into t from pulse_priv.oauth_token where token_sha256 = p_token and kind = 'access' and revoked_at is null and expires_at > now();
 if not found or not oauth_reach(t.org_id) then return null; end if;
 select * into g from pulse_priv.oauth_grant where id = t.grant_id and revoked_at is null and p_scope = any(scopes);
 if not found then return null; end if;
 -- Into the token's space first: its people are read (and the request then runs) there; back if it is refused.
 if t.org_id <> current_org() then perform acct_enter(t.org_id, null); moved := true; end if;
 if not exists(select 1 from person where org_id = t.org_id and id = g.person_id and status = 'active' and side = 'staff') then
  if moved then perform acct_leave(); end if;
  return null;
 end if;
 select name into app from pulse_priv.oauth_client where client_id = g.client_id;
 perform set_config('pulse.viewer_id', g.person_id::text, true);
 -- The credential row is visible to its own person only, so it is read once the viewer is set.
 if exists(select 1 from login_credential where person_id = g.person_id and status = 'disabled') then
  perform set_config('pulse.viewer_id', '', true);
  return null;
 end if;
 perform set_config('pulse.actor_account', 'app:' || app || ':' || coalesce((select username from people_profile where person_id = g.person_id), g.person_id::text), true);
 perform set_config('pulse.app_label', app, true);
 perform set_config('pulse.app_grant', g.id::text, true);
 update pulse_priv.oauth_grant set last_used_at = now() where id = g.id and (last_used_at is null or last_used_at < now() - interval '1 minute');
 return t.id;
end $$;
create or replace function pulse.v1_person_token_live(p_token text) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from pulse_priv.oauth_token t join pulse_priv.oauth_grant g on g.id = t.grant_id
  where t.token_sha256 = p_token and oauth_reach(t.org_id) and t.kind = 'access' and t.revoked_at is null and t.expires_at > now() and g.revoked_at is null)
$$;

-- migrate:down
-- Forward-only: connections made in a person's own space stay theirs.
