-- migrate:up
-- AGENT-API (owner, 4 Nov 2026), slice 3: `pulse login` on a server or over SSH with the OAuth 2.0 device authorization
-- grant (RFC 8628). The CLI asks for a code, the person opens /oauth/device on any device signed in to Pulse, checks
-- the eight-letter code and the areas asked for, and approves; the CLI's next poll gets the same tokens as 1412's
-- authorization code grant (a connection in Settings → Connected apps). Device codes are stored as SHA-256 only, live
-- 10 minutes, work once, and a poll faster than every 5 seconds is told to slow down.

create table pulse_priv.oauth_device (
  org_id uuid not null references pulse.org(id),
  device_sha256 text primary key check (device_sha256 ~ '^[0-9a-f]{64}$'),
  user_code text not null check (user_code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{8}$'),
  client_id text not null references pulse_priv.oauth_client(client_id),
  scopes text[] not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  person_id uuid references pulse.person(id),
  decided_at timestamptz,
  approved boolean,
  polled_at timestamptz,
  used_at timestamptz
);
create unique index oauth_device_code on pulse_priv.oauth_device(org_id, user_code) where used_at is null;
alter table pulse_priv.oauth_device enable row level security;
alter table pulse_priv.oauth_device force row level security;
create policy tenant_isolation on pulse_priv.oauth_device using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

create function pulse.oauth_device_issue(p_device text, p_user_code text, p_client text, p_scopes text[]) returns boolean
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is not null then raise exception 'Devices ask without a sign-in' using errcode='42501'; end if;
 if not exists(select 1 from pulse_priv.oauth_client where org_id = current_org() and client_id = p_client and revoked_at is null) then return false; end if;
 if cardinality(p_scopes) = 0 or not (p_scopes <@ v1_scopes()) then raise exception 'Unknown permission' using errcode='22023'; end if;
 delete from pulse_priv.oauth_device where org_id = current_org() and expires_at < now() - interval '1 day';
 insert into pulse_priv.oauth_device(org_id, device_sha256, user_code, client_id, scopes) values (current_org(), p_device, p_user_code, p_client, p_scopes);
 return true;
end $$;

-- What the signed-in person checks before approving: the app, the areas, and that the code is still waiting.
create function pulse.oauth_device_peek(p_user_code text) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('app', c.name, 'scopes', to_jsonb(d.scopes), 'expiresAt', d.expires_at)
 from pulse_priv.oauth_device d join pulse_priv.oauth_client c on c.client_id = d.client_id
 where d.org_id = current_org() and d.user_code = upper(p_user_code) and d.used_at is null and d.decided_at is null and d.expires_at > now() and current_viewer() is not null
$$;

create function pulse.oauth_device_decide(p_user_code text, p_approve boolean) returns boolean
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or not exists(select 1 from person where org_id = current_org() and id = current_viewer() and status = 'active' and side = 'staff')
  then raise exception 'An active staff account approves apps' using errcode='42501'; end if;
 update pulse_priv.oauth_device set person_id = current_viewer(), decided_at = now(), approved = coalesce(p_approve, false)
  where org_id = current_org() and user_code = upper(p_user_code) and used_at is null and decided_at is null and expires_at > now();
 return found;
end $$;

-- The CLI's poll. Refusals return {error} per RFC 8628 §3.5 and never raise.
create function pulse.oauth_device_exchange(p_device text, p_client text, p_secret text, p_access text, p_refresh text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d pulse_priv.oauth_device; g uuid; fast boolean;
begin
 if not oauth_client_ok(p_client, p_secret) then return jsonb_build_object('error', 'invalid_client'); end if;
 select * into d from pulse_priv.oauth_device where org_id = current_org() and device_sha256 = p_device for update;
 if not found or d.client_id <> p_client or d.used_at is not null then return jsonb_build_object('error', 'invalid_grant'); end if;
 if d.expires_at < now() then return jsonb_build_object('error', 'expired_token'); end if;
 fast := d.polled_at is not null and d.polled_at > now() - interval '4 seconds';
 update pulse_priv.oauth_device set polled_at = now() where device_sha256 = p_device;
 if d.decided_at is null then return jsonb_build_object('error', case when fast then 'slow_down' else 'authorization_pending' end); end if;
 update pulse_priv.oauth_device set used_at = now() where device_sha256 = p_device;
 if not d.approved then return jsonb_build_object('error', 'access_denied'); end if;
 if not exists(select 1 from person where org_id = current_org() and id = d.person_id and status = 'active') then return jsonb_build_object('error', 'invalid_grant'); end if;
 insert into pulse_priv.oauth_grant(org_id, client_id, person_id, scopes) values (current_org(), d.client_id, d.person_id, d.scopes) returning id into g;
 perform oauth_tokens_make(g, p_access, p_refresh);
 return jsonb_build_object('scope', array_to_string(d.scopes, ' '), 'expiresIn', 3600);
end $$;

revoke all on function pulse.oauth_device_issue(text,text,text,text[]), pulse.oauth_device_peek(text), pulse.oauth_device_decide(text,boolean),
  pulse.oauth_device_exchange(text,text,text,text,text) from public;
grant execute on function pulse.oauth_device_issue(text,text,text,text[]), pulse.oauth_device_peek(text), pulse.oauth_device_decide(text,boolean),
  pulse.oauth_device_exchange(text,text,text,text,text) to pulse_api;

-- migrate:down
drop function pulse.oauth_device_exchange(text,text,text,text,text);
drop function pulse.oauth_device_decide(text,boolean);
drop function pulse.oauth_device_peek(text);
drop function pulse.oauth_device_issue(text,text,text,text[]);
drop table pulse_priv.oauth_device;
