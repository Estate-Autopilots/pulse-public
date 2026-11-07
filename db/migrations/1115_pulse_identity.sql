-- migrate:up
-- PULSE-ID (owner, 25 Oct 2026: "Login with Pulse … Sales X-Ray connecting to Pulse: employee details, profile picture
-- … personal mode … an org in Sales X-Ray can connect its org to Pulse … read/write access"). Pulse becomes an OpenID
-- Connect provider and a scoped data API for apps (docs/architecture/PULSE_IDENTITY_AND_DATA_API.md, which implements
-- AC's agreed pulse-identity-contract exactly).
--   pulse_priv.oidc_app      the apps registered on this install (one row per environment of an app): exact redirect
--                            URIs, the scopes it may ask for, the verified flag, the SHA-256 of its client secret
--   pulse_priv.oidc_subject  the `sub` each app sees for a human (pairwise per app, random): keyed by the Pulse account,
--                            or by the member while they have no account (it moves to the account later)
--   pulse_priv.oidc_code     one-time codes (60 s), bound to the client, redirect URI, PKCE challenge and nonce
--   pulse_priv.oidc_token    access (1 h) and refresh (60 days, rotated) tokens, by SHA-256 only
--   pulse.oidc_grant         a connection: personal (a member's sign-in) or org (an admin linked the organisation; it
--                            belongs to the organisation and survives that admin), with its scopes
--   pulse.connect_hook       an org link's webhook endpoints (secret sealed by the API's document keyring)
--   pulse.connect_change     what changed (members, photos, roles, clients) while an organisation has a live org link:
--                            the source of webhook events and of a member's updated_at
--   pulse.connect_event      webhook deliveries, retried for 24 hours
--   pulse.connect_signal     work signals an app sends (calls analysed, leads worked, follow-ups done, talk minutes)
--   pulse.connect_call       the data API's call log (operation, status, time; never content)
-- The install-level tables (apps, subjects, codes, tokens) carry no row security: they are global, owner-only (no grant
-- to any runtime role) and reached only through the SECURITY DEFINER functions below, like ORG's account tables
-- (allow-listed in tests/core/test_acceptance_isolation.py). The per-organisation tables are forced row security as
-- every company table; the functions set the organisation (from a token's or code's own row) before touching them.
-- Safe on a live install: additive; nothing is issued until the API is switched on (PULSE_OIDC=1) with a signing key.

-- ------------------------------------------------------------------------------------------------ install-level
create table pulse_priv.oidc_app (
  id                 uuid primary key default gen_random_uuid(),
  client_id          text not null unique check (client_id ~ '^papp_[a-z0-9]{20}$'),
  name               text not null check (length(btrim(name)) between 2 and 80),
  maker              text check (length(maker) <= 80),
  home_url           text check (home_url is null or (home_url ~ '^https://' and length(home_url) <= 300)),
  logo               bytea check (logo is null or length(logo) <= 262144),
  logo_mime          text check (logo_mime is null or logo_mime in ('image/png', 'image/jpeg', 'image/webp')),
  redirect_uris      text[] not null default '{}' check (cardinality(redirect_uris) <= 10),
  scopes             text[] not null default '{openid,profile,email}',
  development        boolean not null default false,
  verified           boolean not null default false,
  status             text not null default 'active' check (status in ('active', 'off')),
  secret_hash        text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  prev_secret_hash   text check (prev_secret_hash is null or prev_secret_hash ~ '^[0-9a-f]{64}$'),
  prev_secret_until  timestamptz,
  created_org        uuid references pulse.org(id),
  created_by         uuid references pulse.person(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  last_used_at       timestamptz
);
create table pulse_priv.oidc_subject (
  app_id      uuid not null references pulse_priv.oidc_app(id) on delete cascade,
  sub         text not null unique check (sub ~ '^[0-9a-f]{32}$'),
  account_id  uuid references pulse_priv.pulse_account(id) on delete cascade,
  person_id   uuid references pulse.person(id) on delete cascade,
  created_at  timestamptz not null default now(),
  check (account_id is not null or person_id is not null)
);
create unique index oidc_subject_account on pulse_priv.oidc_subject(app_id, account_id) where account_id is not null;
create unique index oidc_subject_person on pulse_priv.oidc_subject(app_id, person_id) where person_id is not null;

-- ------------------------------------------------------------------------------------------------ connections
create table pulse.oidc_grant (
  org_id         uuid not null references pulse.org(id),
  id             uuid primary key default gen_random_uuid(),
  app_id         uuid not null references pulse_priv.oidc_app(id) on delete cascade,
  kind           text not null check (kind in ('personal', 'org')),
  person_id      uuid references pulse.person(id) on delete cascade,  -- personal: the member
  scopes         text[] not null,                                      -- what it may do now
  asked          text[] not null,                                      -- what the app asked for (the admin's switches)
  granted_by     uuid references pulse.person(id) on delete set null,  -- who allowed it last
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  revoked_by     uuid references pulse.person(id) on delete set null,
  revoke_reason  text check (revoke_reason in ('person', 'admin', 'app', 'link', 'left')),
  check ((kind = 'personal') = (person_id is not null))
);
create unique index oidc_grant_org_live on pulse.oidc_grant(org_id, app_id) where kind = 'org' and revoked_at is null;
create unique index oidc_grant_personal_live on pulse.oidc_grant(org_id, app_id, person_id) where kind = 'personal' and revoked_at is null;

create table pulse_priv.oidc_code (
  hash          text primary key check (hash ~ '^[0-9a-f]{64}$'),
  org_id        uuid not null references pulse.org(id),
  grant_id      uuid not null references pulse.oidc_grant(id) on delete cascade,
  app_id        uuid not null references pulse_priv.oidc_app(id) on delete cascade,
  person_id     uuid not null references pulse.person(id) on delete cascade,  -- who allowed it (the ID token's person)
  redirect_uri  text not null,
  challenge     text not null check (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  nonce         text check (length(nonce) <= 255),
  scopes        text[] not null,
  auth_time     timestamptz not null,
  amr           text not null default 'pwd' check (amr in ('pwd', 'google', 'sso')),
  expires_at    timestamptz not null,
  used_at       timestamptz
);
create index oidc_code_expiry on pulse_priv.oidc_code(expires_at);
create table pulse_priv.oidc_token (
  hash        text primary key check (hash ~ '^[0-9a-f]{64}$'),
  kind        text not null check (kind in ('access', 'refresh')),
  org_id      uuid not null references pulse.org(id),
  grant_id    uuid not null references pulse.oidc_grant(id) on delete cascade,
  app_id      uuid not null references pulse_priv.oidc_app(id) on delete cascade,
  person_id   uuid references pulse.person(id) on delete cascade,  -- the member it speaks for (org links: who allowed it)
  scopes      text[] not null,
  family      uuid not null,                                        -- one consent's chain of tokens
  code_hash   text,                                                 -- the code it came from
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,                                          -- a refresh token: when it was swapped
  revoked_at  timestamptz
);
create index oidc_token_grant on pulse_priv.oidc_token(grant_id) where revoked_at is null;
create index oidc_token_family on pulse_priv.oidc_token(family);
create index oidc_token_code on pulse_priv.oidc_token(code_hash) where code_hash is not null;
create index oidc_token_expiry on pulse_priv.oidc_token(expires_at);
revoke all on pulse_priv.oidc_app, pulse_priv.oidc_subject, pulse_priv.oidc_code, pulse_priv.oidc_token from public;

create table pulse.connect_hook (
  org_id        uuid not null references pulse.org(id),
  id            uuid primary key default gen_random_uuid(),
  grant_id      uuid not null references pulse.oidc_grant(id) on delete cascade,
  url           text not null check (url ~ '^https://' and length(url) <= 500),
  events        text[] not null,
  secret        jsonb not null check (jsonb_typeof(secret) = 'object'),  -- {k,w,d}: sealed in the API
  status        text not null default 'active' check (status in ('active', 'ending', 'off', 'removed')),
  cursor_seq    bigint not null default 0,
  created_at    timestamptz not null default now(),
  last_ok_at    timestamptz,
  last_error    text check (length(last_error) <= 200),
  failing_since timestamptz
);
create table pulse.connect_change (
  org_id   uuid not null references pulse.org(id),
  seq      bigint generated always as identity primary key,
  entity   text not null check (entity in ('person', 'client', 'link')),
  ref      uuid not null,
  type     text not null,
  changed  text[] not null default '{}',
  at       timestamptz not null default now(),
  -- the endpoints that turned it into an event (a cursor would skip a change whose transaction commits late)
  seen_by  uuid[] not null default '{}'
);
create index connect_change_ref on pulse.connect_change(org_id, entity, ref, at desc);
create index connect_change_at on pulse.connect_change(at);
create table pulse.connect_event (
  org_id        uuid not null references pulse.org(id),
  id            uuid primary key default gen_random_uuid(),
  hook_id       uuid not null references pulse.connect_hook(id) on delete cascade,
  type          text not null,
  body          jsonb not null,
  occurred_at   timestamptz not null default now(),
  attempts      int not null default 0,
  next_at       timestamptz not null default now(),
  delivered_at  timestamptz,
  given_up_at   timestamptz,
  last_status   int
);
create index connect_event_due on pulse.connect_event(org_id, next_at) where delivered_at is null and given_up_at is null;
create table pulse.connect_signal (
  org_id      uuid not null references pulse.org(id),
  app_id      uuid not null references pulse_priv.oidc_app(id) on delete cascade,
  person_id   uuid not null references pulse.person(id) on delete cascade,
  kind        text not null check (kind in ('calls_analysed', 'leads_worked', 'follow_ups_done', 'talk_minutes')),
  day         date not null,
  value       int not null check (value between 0 and 1000000),
  updated_at  timestamptz not null default now(),
  primary key (org_id, app_id, person_id, kind, day)
);
create table pulse.connect_call (
  org_id     uuid not null references pulse.org(id),
  id         bigint generated always as identity primary key,
  grant_id   uuid not null references pulse.oidc_grant(id) on delete cascade,
  operation  text not null check (length(operation) <= 80),
  status     int not null,
  ms         int,
  at         timestamptz not null default now()
);
create index connect_call_grant on pulse.connect_call(org_id, grant_id, at desc);

do $$ declare t text; begin
  foreach t in array array['oidc_grant', 'connect_hook', 'connect_change', 'connect_event', 'connect_signal', 'connect_call'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  end loop;
end $$;
-- The API reads the signals it shows on a person's page; everything else goes through the functions below.
grant select on pulse.connect_signal to pulse_api;

-- ------------------------------------------------------------------------------------------------ helpers
-- The scopes Pulse knows. Org scopes make a request an org link (pulse.clients.read alone is personal).
create function pulse.oidc_known_scopes() returns text[] language sql immutable as $$
  select array['openid','profile','email','offline_access','pulse.orgs','pulse.org.read','pulse.org.webhooks','pulse.signals.write',
               'pulse.clients.read','pulse.leads.write','pulse.calls.write','pulse.money.read']
$$;
create function pulse.oidc_org_scopes() returns text[] language sql immutable as $$
  select array['pulse.org.read','pulse.org.webhooks','pulse.signals.write','pulse.leads.write','pulse.calls.write','pulse.money.read']
$$;
-- The events each scope lets an endpoint receive.
create function pulse.oidc_scope_events(p_scopes text[]) returns text[] language sql immutable as $$
  select array_remove(array[
    case when 'pulse.org.webhooks' = any(p_scopes) then 'person.updated' end,
    case when 'pulse.org.webhooks' = any(p_scopes) then 'person.photo_updated' end,
    case when 'pulse.org.webhooks' = any(p_scopes) then 'membership.added' end,
    case when 'pulse.org.webhooks' = any(p_scopes) then 'membership.removed' end,
    case when 'pulse.org.webhooks' = any(p_scopes) then 'membership.role_changed' end,
    case when 'pulse.org.webhooks' = any(p_scopes) then 'link.revoked' end,
    case when 'pulse.org.webhooks' = any(p_scopes) then 'link.changed' end,
    case when 'pulse.org.webhooks' = any(p_scopes) and 'pulse.clients.read' = any(p_scopes) then 'client.updated' end,
    case when 'pulse.org.webhooks' = any(p_scopes) and 'pulse.clients.read' = any(p_scopes) then 'client.removed' end], null)
$$;

-- A member's role in their organisation (the organisation must be set), in the contract's words.
create function pulse.oidc_member_role(p_person uuid) returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select case
    when p.side = 'client' then 'client'
    when p.side = 'freelancer' then 'freelancer'
    when r.roles && array['admin'] then 'admin'
    when r.roles && array['leadership'] then 'leadership'
    when r.roles && array['hr'] then 'hr'
    when r.roles && array['finance'] then 'finance'
    when r.roles && array['manager'] or r.managers then 'manager'
    else 'member' end
  from person p, lateral (select coalesce(array_agg(role_key), '{}') roles, coalesce(bool_or(is_manager_of_unit), false) managers
                            from role_assignment where org_id = p.org_id and person_id = p.id
                             and current_date between valid_from and coalesce(valid_to, 'infinity')) r
  where p.id = p_person and p.org_id = current_org()
$$;

-- The e-mail Pulse checked is theirs (the organisation must be set): their Google Workspace account (Access), a linked
-- Google account, or an address confirmed by link (Account → Security). Null when none.
create function pulse.oidc_checked_email(p_person uuid) returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(
    (select lower(a.handle) from account a where a.org_id = current_org() and a.holder_person_id = p_person and a.provider = 'google'
        and a.purpose like 'Workspace%' and not coalesce(a.is_shared, false) and a.handle like '%@%' order by a.handle limit 1),
    (select lower(g.email) from pulse_priv.google_identity g where g.org_id = current_org() and g.person_id = p_person),
    (select lower(x.delivery) from pulse_priv.auth_account x where x.org_id = current_org() and x.realm = 'staff' and x.actor = p_person and x.delivery is not null))
$$;

-- The `sub` an app sees for a member (the organisation must be set). Pairwise per app and random. A member with a Pulse
-- account shares the account's; one without gets their own, which the account adopts when they get one.
create function pulse.oidc_sub(p_app uuid, p_person uuid) returns text
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a uuid; s text;
begin
  select account_id into a from pulse_priv.account_member where person_id = p_person;
  if a is not null then
    select sub into s from pulse_priv.oidc_subject where app_id = p_app and account_id = a;
    if s is not null then return s; end if;
    update pulse_priv.oidc_subject set account_id = a where app_id = p_app and person_id = p_person and account_id is null returning sub into s;
    if s is not null then return s; end if;
    insert into pulse_priv.oidc_subject(app_id, sub, account_id, person_id)
    values (p_app, replace(gen_random_uuid()::text, '-', ''), a,
            case when exists (select 1 from pulse_priv.oidc_subject where app_id = p_app and person_id = p_person) then null else p_person end)
    on conflict do nothing returning sub into s;
    return coalesce(s, (select sub from pulse_priv.oidc_subject where app_id = p_app and account_id = a));
  end if;
  select sub into s from pulse_priv.oidc_subject where app_id = p_app and person_id = p_person;
  if s is not null then return s; end if;
  insert into pulse_priv.oidc_subject(app_id, sub, person_id) values (p_app, replace(gen_random_uuid()::text, '-', ''), p_person)
  on conflict do nothing returning sub into s;
  return coalesce(s, (select sub from pulse_priv.oidc_subject where app_id = p_app and person_id = p_person));
end $$;

-- The member of the current organisation a `sub` of this app names, or null.
create function pulse.oidc_sub_person(p_app uuid, p_sub text) returns uuid
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(
    (select m.person_id from pulse_priv.oidc_subject s join pulse_priv.account_member m on m.account_id = s.account_id
      where s.app_id = p_app and s.sub = p_sub and m.member_org = current_org()),
    (select s.person_id from pulse_priv.oidc_subject s join person p on p.id = s.person_id
      where s.app_id = p_app and s.sub = p_sub and p.org_id = current_org()))
$$;

-- The claims for a member and an app's scopes (the organisation must be set). The API turns `photo` into the signed
-- picture address and adds iss/aud/exp/nonce.
create function pulse.oidc_claims(p_app uuid, p_person uuid, p_scopes text[]) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r record; a pulse_priv.pulse_account%rowtype; c jsonb; checked text; back text := current_setting('pulse.org_id', true);
  v_orgs jsonb := '[]'; o record;
begin
  select p.id, p.display_name, p.status, pp.role title, pp.pod team, pp.username, lower(pp.email) work_email, pp.updated_at,
         ph.updated_at photo_at, (ph.person_id is not null) has_photo
    into r from person p left join people_profile pp on pp.person_id = p.id left join person_photo ph on ph.person_id = p.id
   where p.id = p_person and p.org_id = current_org();
  if not found then return null; end if;
  select x.* into a from pulse_priv.pulse_account x join pulse_priv.account_member m on m.account_id = x.id where m.person_id = p_person;
  c := jsonb_build_object('sub', oidc_sub(p_app, p_person));
  if 'profile' = any(p_scopes) then
    c := c || jsonb_strip_nulls(jsonb_build_object(
      'name', r.display_name,
      'given_name', split_part(btrim(r.display_name), ' ', 1),
      'family_name', nullif(btrim(substr(btrim(r.display_name), length(split_part(btrim(r.display_name), ' ', 1)) + 1)), ''),
      'preferred_username', coalesce(a.handle, nullif(r.username, '')),
      'updated_at', extract(epoch from greatest(r.updated_at, r.photo_at, a.updated_at))::bigint,
      'title', nullif(btrim(coalesce(r.title, '')), ''), 'team', nullif(btrim(coalesce(r.team, '')), ''),
      'photo', case when r.has_photo then jsonb_build_object('member', p_person, 'version', (extract(epoch from r.photo_at) * 1000)::bigint) end));
  end if;
  if 'email' = any(p_scopes) then
    checked := oidc_checked_email(p_person);
    c := c || jsonb_strip_nulls(jsonb_build_object('email', coalesce(checked, lower(a.email), r.work_email), 'email_verified', checked is not null));
    if c ? 'email' is false then c := c - 'email_verified'; end if;
  end if;
  if 'pulse.orgs' = any(p_scopes) then
    if a.id is null then
      v_orgs := jsonb_build_array(jsonb_build_object('id', current_org(), 'name', (select name from org where id = current_org()), 'role', oidc_member_role(p_person)));
    else
      for o in select m.member_org, m.person_id, g.name from pulse_priv.account_member m join org g on g.id = m.member_org
                where m.account_id = a.id and g.status = 'active' order by g.name loop
        perform set_config('pulse.org_id', o.member_org::text, true);
        if exists (select 1 from person where id = o.person_id and status = 'active') then
          v_orgs := v_orgs || jsonb_build_object('id', o.member_org, 'name', o.name, 'role', oidc_member_role(o.person_id));
        end if;
      end loop;
      perform set_config('pulse.org_id', coalesce(back, ''), true);
    end if;
    c := c || jsonb_build_object('pulse_orgs', v_orgs);
  end if;
  return c;
end $$;

-- An install admin: an admin of the install's own organisation (apps are registered for the whole install).
create function pulse.oidc_install_admin() returns void
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if current_org() is distinct from install_org() or not viewer_is('admin') then
    raise exception 'Only admins of this Pulse''s own organisation manage registered apps' using errcode = '42501';
  end if;
end $$;

-- A redirect URI an app may register: https (or http on localhost for a development app), no fragment, no credentials.
create function pulse.oidc_redirect_ok(p_uri text, p_dev boolean) returns boolean language sql immutable as $$
  select length(p_uri) <= 300 and p_uri !~ '#' and p_uri !~ '^[a-z]+://[^/]*@' and p_uri !~ '[[:space:]]'
     and (p_uri ~ '^https://[a-z0-9.-]+(:[0-9]{2,5})?/' or (p_dev and p_uri ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{2,5})?/'))
$$;

-- ------------------------------------------------------------------------------------------------ registered apps
create function pulse.oidc_app_manage(p_op text, p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v pulse_priv.oidc_app%rowtype; v_id uuid := nullif(p ->> 'id', '')::uuid; v_uris text[]; v_scopes text[]; u text;
begin
  perform oidc_install_admin();
  if p_op = 'list' then
    return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'clientId', client_id, 'name', name, 'maker', maker, 'homeUrl', home_url,
        'redirectUris', to_jsonb(redirect_uris), 'scopes', to_jsonb(scopes), 'development', development, 'verified', verified, 'status', status,
        'hasLogo', logo is not null, 'createdAt', created_at, 'updatedAt', updated_at, 'lastUsedAt', last_used_at,
        'secretRotating', prev_secret_until > now()) order by name) from pulse_priv.oidc_app), '[]'::jsonb);
  end if;
  if p_op = 'save' then
    select coalesce(array_agg(distinct btrim(x)) filter (where btrim(x) <> ''), '{}') into v_uris
      from jsonb_array_elements_text(case when jsonb_typeof(p -> 'redirectUris') = 'array' then p -> 'redirectUris' else '[]' end) x;
    foreach u in array v_uris loop
      if not oidc_redirect_ok(u, coalesce((p ->> 'development')::boolean, false)) then
        raise exception 'A return address must be a full https address (http only on localhost for a development app): %', left(u, 80) using errcode = '22023';
      end if;
    end loop;
    if cardinality(v_uris) = 0 then raise exception 'Give the app at least one return address' using errcode = '22023'; end if;
    select coalesce(array_agg(distinct x), '{}') into v_scopes
      from jsonb_array_elements_text(case when jsonb_typeof(p -> 'scopes') = 'array' then p -> 'scopes' else '[]' end) x where x = any(oidc_known_scopes());
    if not 'openid' = any(v_scopes) then v_scopes := array_prepend('openid', v_scopes); end if;
    if v_id is null then
      if coalesce(p ->> 'clientId', '') !~ '^papp_[a-z0-9]{20}$' or coalesce(p ->> 'secretHash', '') !~ '^[0-9a-f]{64}$' then
        raise exception 'A new app needs its client id and secret' using errcode = '22023'; end if;
      insert into pulse_priv.oidc_app(client_id, name, maker, home_url, redirect_uris, scopes, development, secret_hash, created_org, created_by)
      values (p ->> 'clientId', btrim(p ->> 'name'), nullif(btrim(coalesce(p ->> 'maker', '')), ''), nullif(btrim(coalesce(p ->> 'homeUrl', '')), ''),
              v_uris, v_scopes, coalesce((p ->> 'development')::boolean, false), p ->> 'secretHash', current_org(), current_viewer())
      returning * into v;
      perform audit_write('oidc_app_registered', 'oidc_app', v.id::text, array['name', 'redirect_uris', 'scopes']);
    else
      update pulse_priv.oidc_app set name = btrim(p ->> 'name'), maker = nullif(btrim(coalesce(p ->> 'maker', '')), ''),
             home_url = nullif(btrim(coalesce(p ->> 'homeUrl', '')), ''), redirect_uris = v_uris, scopes = v_scopes,
             development = coalesce((p ->> 'development')::boolean, false), updated_at = now()
       where id = v_id returning * into v;
      if not found then raise exception 'No such app' using errcode = 'P0002'; end if;
      perform audit_write('oidc_app_changed', 'oidc_app', v.id::text, array['name', 'redirect_uris', 'scopes']);
    end if;
    return jsonb_build_object('id', v.id, 'clientId', v.client_id);
  end if;
  select * into v from pulse_priv.oidc_app where id = v_id for update;
  if not found then raise exception 'No such app' using errcode = 'P0002'; end if;
  if p_op = 'secret' then
    if coalesce(p ->> 'secretHash', '') !~ '^[0-9a-f]{64}$' then raise exception 'A new secret is needed' using errcode = '22023'; end if;
    update pulse_priv.oidc_app set prev_secret_hash = secret_hash, prev_secret_until = now() + interval '24 hours', secret_hash = p ->> 'secretHash', updated_at = now() where id = v.id;
    perform audit_write('oidc_secret_rotated', 'oidc_app', v.id::text);
  elsif p_op = 'logo' then
    update pulse_priv.oidc_app set logo = decode(nullif(p ->> 'logo', ''), 'base64'), logo_mime = nullif(p ->> 'mime', ''), updated_at = now() where id = v.id;
    perform audit_write('oidc_app_changed', 'oidc_app', v.id::text, array['logo']);
  elsif p_op = 'status' then
    update pulse_priv.oidc_app set status = case when (p ->> 'on')::boolean then 'active' else 'off' end, updated_at = now() where id = v.id;
    perform audit_write('oidc_app_changed', 'oidc_app', v.id::text, array['status']);
  elsif p_op = 'verify' then
    update pulse_priv.oidc_app set verified = coalesce((p ->> 'verified')::boolean, false), updated_at = now() where id = v.id;
    perform audit_write('oidc_app_changed', 'oidc_app', v.id::text, array['verified']);
  else raise exception 'Unknown change' using errcode = '22023'; end if;
  return jsonb_build_object('id', v.id, 'clientId', v.client_id);
end $$;

-- What the authorize page and the token endpoint may know of an app, by client id (no secret). Null when unknown.
create function pulse.oidc_app_public(p_client text) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('id', id, 'clientId', client_id, 'name', name, 'maker', maker, 'homeUrl', home_url, 'verified', verified,
         'development', development, 'status', status, 'redirectUris', to_jsonb(redirect_uris), 'scopes', to_jsonb(scopes),
         'logo', case when logo is not null then extract(epoch from updated_at)::bigint end)
    from pulse_priv.oidc_app where client_id = p_client
$$;
create function pulse.oidc_app_logo(p_client text) returns table (logo bytea, mime text)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select logo, logo_mime from pulse_priv.oidc_app where client_id = p_client and logo is not null and status = 'active'
$$;

-- ------------------------------------------------------------------------------------------------ consent
-- What the consent screen shows the signed-in member for an app and the scopes it asks for.
create function pulse.oidc_consent_state(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_app pulse_priv.oidc_app%rowtype; v_scopes text[]; v_kind text; g record; a pulse_priv.pulse_account%rowtype; me record;
begin
  if current_viewer() is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  select * into v_app from pulse_priv.oidc_app where client_id = p ->> 'clientId' and status = 'active';
  if not found then return null; end if;
  select coalesce(array_agg(distinct x), '{}') into v_scopes from jsonb_array_elements_text(coalesce(p -> 'scopes', '[]')) x where x = any(v_app.scopes);
  v_kind := case when v_scopes && oidc_org_scopes() then 'org' else 'personal' end;
  select p2.display_name name, pp.username, (ph.person_id is not null) photo into me from person p2 left join people_profile pp on pp.person_id = p2.id
    left join person_photo ph on ph.person_id = p2.id where p2.id = current_viewer();
  select x.* into a from pulse_priv.pulse_account x join pulse_priv.account_member m on m.account_id = x.id where m.person_id = current_viewer();
  select id, scopes into g from oidc_grant where org_id = current_org() and app_id = v_app.id and kind = v_kind and revoked_at is null
     and (v_kind = 'org' or person_id = current_viewer());
  return jsonb_build_object('kind', v_kind, 'scopes', to_jsonb(v_scopes),
    'person', jsonb_build_object('id', current_viewer(), 'name', me.name, 'handle', coalesce(a.handle, nullif(me.username, '')), 'photo', coalesce(me.photo, false)),
    'org', (select jsonb_build_object('id', id, 'name', name, 'handle', handle) from org where id = current_org()),
    'admin', viewer_is('admin'), 'emailChecked', oidc_checked_email(current_viewer()) is not null,
    'grant', case when g.id is not null then jsonb_build_object('id', g.id, 'scopes', to_jsonb(g.scopes)) end,
    'orgs', case when a.id is null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'handle', o.handle, 'current', o.id = current_org()) order by o.name)
        from pulse_priv.account_member m join org o on o.id = m.member_org where m.account_id = a.id and o.status = 'active'), '[]'::jsonb) end);
end $$;

-- Allow: the signed-in member (an admin for an org link) makes or widens the connection and gets a one-time code.
-- The API has checked the app, the return address and PKCE's form; this checks them again.
create function pulse.oidc_authorize(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_app pulse_priv.oidc_app%rowtype; v_scopes text[]; v_off text[]; v_kind text; v_grant uuid; v_old text[];
begin
  if current_viewer() is null or not exists (select 1 from person where id = current_viewer() and status = 'active') then
    raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  select * into v_app from pulse_priv.oidc_app where client_id = p ->> 'clientId' and status = 'active';
  if not found or not (p ->> 'redirectUri') = any(v_app.redirect_uris) then raise exception 'This app is unknown here' using errcode = '22023'; end if;
  if coalesce(p ->> 'codeHash', '') !~ '^[0-9a-f]{64}$' or coalesce(p ->> 'challenge', '') !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'The sign-in request is incomplete' using errcode = '22023'; end if;
  select coalesce(array_agg(distinct x), '{}') into v_scopes from jsonb_array_elements_text(coalesce(p -> 'scopes', '[]')) x
   where x = any(v_app.scopes) and x = any(oidc_known_scopes());
  if not 'openid' = any(v_scopes) then raise exception 'The app must ask for openid' using errcode = '22023'; end if;
  v_kind := case when v_scopes && oidc_org_scopes() then 'org' else 'personal' end;
  perform account_ensure();
  if v_kind = 'org' then
    if not viewer_is('admin') then raise exception 'Only an admin of this organisation can link it to an app' using errcode = '42501'; end if;
    select coalesce(array_agg(x), '{}') into v_off from jsonb_array_elements_text(coalesce(p -> 'off', '[]')) x;
    select id into v_grant from oidc_grant where org_id = current_org() and app_id = v_app.id and kind = 'org' and revoked_at is null for update;
    if v_grant is null then
      insert into oidc_grant(org_id, app_id, kind, scopes, asked, granted_by)
      values (current_org(), v_app.id, 'org', array(select unnest(v_scopes) except select unnest(v_off)), v_scopes, current_viewer()) returning id into v_grant;
    else
      update oidc_grant set scopes = array(select unnest(v_scopes) except select unnest(v_off)),
             asked = array(select distinct x from unnest(asked || v_scopes) x), granted_by = current_viewer(), updated_at = now()
       where id = v_grant;
      insert into connect_change(org_id, entity, ref, type) values (current_org(), 'link', v_grant, 'link.changed');
    end if;
    v_scopes := array(select unnest(v_scopes) except select unnest(v_off));
  else
    select id, scopes into v_grant, v_old from oidc_grant where org_id = current_org() and app_id = v_app.id and kind = 'personal'
       and person_id = current_viewer() and revoked_at is null for update;
    if v_grant is null then
      insert into oidc_grant(org_id, app_id, kind, person_id, scopes, asked, granted_by)
      values (current_org(), v_app.id, 'personal', current_viewer(), v_scopes, v_scopes, current_viewer()) returning id into v_grant;
    else
      update oidc_grant set scopes = array(select distinct x from unnest(v_old || v_scopes) x), asked = array(select distinct x from unnest(asked || v_scopes) x),
             updated_at = now() where id = v_grant;
    end if;
  end if;
  perform audit_write('oidc_consent', 'oidc_grant', v_grant::text, v_scopes);
  insert into pulse_priv.oidc_code(hash, org_id, grant_id, app_id, person_id, redirect_uri, challenge, nonce, scopes, auth_time, amr, expires_at)
  values (p ->> 'codeHash', current_org(), v_grant, v_app.id, current_viewer(), p ->> 'redirectUri', p ->> 'challenge', nullif(p ->> 'nonce', ''),
          v_scopes, coalesce((p ->> 'authTime')::timestamptz, now()), coalesce(nullif(p ->> 'amr', ''), 'pwd'), now() + interval '60 seconds');
  return jsonb_build_object('grant', v_grant, 'kind', v_kind, 'scopes', to_jsonb(v_scopes));
end $$;

-- ------------------------------------------------------------------------------------------------ tokens
-- The app behind a client id and secret (current, or the previous one for 24 hours after a new one); null otherwise.
create function pulse.oidc_client(p_client text, p_secret_hash text) returns pulse_priv.oidc_app
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select * from pulse_priv.oidc_app where client_id = p_client and status = 'active'
     and (secret_hash = p_secret_hash or (prev_secret_hash = p_secret_hash and prev_secret_until > now()))
$$;

-- Whether a client id and secret belong together (the token endpoint charges an app's budget only after this).
create function pulse.oidc_client_ok(p_client text, p_secret_hash text) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select (oidc_client(p_client, p_secret_hash)).id is not null
$$;

create function pulse.oidc_issue(p_grant pulse.oidc_grant, p_app uuid, p_person uuid, p_scopes text[], p_family uuid, p_code text,
                                 p_access text, p_refresh text) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_refresh boolean := p_refresh is not null and (p_grant.kind = 'org' or 'offline_access' = any(p_scopes));
begin
  insert into pulse_priv.oidc_token(hash, kind, org_id, grant_id, app_id, person_id, scopes, family, code_hash, expires_at)
  values (p_access, 'access', p_grant.org_id, p_grant.id, p_app, p_person, p_scopes, p_family, p_code, now() + interval '1 hour');
  if v_refresh then
    insert into pulse_priv.oidc_token(hash, kind, org_id, grant_id, app_id, person_id, scopes, family, code_hash, expires_at)
    values (p_refresh, 'refresh', p_grant.org_id, p_grant.id, p_app, p_person, p_scopes, p_family, p_code, now() + interval '60 days');
  end if;
  update oidc_grant set last_used_at = now() where id = p_grant.id;
  update pulse_priv.oidc_app set last_used_at = now() where id = p_app and (last_used_at is null or last_used_at < now() - interval '1 minute');
  return v_refresh;
end $$;

-- authorization_code: the code is consumed before anything else, so a replay finds it used and ends what it issued.
create function pulse.oidc_token_code(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_app pulse_priv.oidc_app%rowtype; k pulse_priv.oidc_code%rowtype; g oidc_grant%rowtype; v_family uuid := gen_random_uuid(); v_refresh boolean;
begin
  v_app := oidc_client(p ->> 'clientId', p ->> 'secretHash');
  if v_app.id is null then return jsonb_build_object('error', 'invalid_client'); end if;
  select * into k from pulse_priv.oidc_code where hash = p ->> 'codeHash' for update;
  if not found or k.app_id <> v_app.id then return jsonb_build_object('error', 'invalid_grant'); end if;
  perform set_config('pulse.org_id', k.org_id::text, true);
  if k.used_at is not null then
    update pulse_priv.oidc_token set revoked_at = now() where revoked_at is null
       and family in (select family from pulse_priv.oidc_token where code_hash = k.hash);
    perform set_config('pulse.actor_account', 'App ' || v_app.name, true);
    perform audit_write('oidc_token_reuse', 'oidc_grant', k.grant_id::text, array['code']);
    return jsonb_build_object('error', 'invalid_grant');
  end if;
  update pulse_priv.oidc_code set used_at = now() where hash = k.hash;
  if k.expires_at < now() or k.redirect_uri <> coalesce(p ->> 'redirectUri', '') or k.challenge <> coalesce(p ->> 'verifierChallenge', '') then
    return jsonb_build_object('error', 'invalid_grant'); end if;
  select * into g from oidc_grant where id = k.grant_id and revoked_at is null;
  if not found or not exists (select 1 from person where id = k.person_id and status = 'active') then return jsonb_build_object('error', 'invalid_grant'); end if;
  v_refresh := oidc_issue(g, v_app.id, k.person_id, k.scopes, v_family, k.hash, p ->> 'accessHash', p ->> 'refreshHash');
  return jsonb_build_object('kind', g.kind, 'org', g.org_id, 'scopes', to_jsonb(k.scopes), 'refresh', v_refresh, 'appId', v_app.id,
    'nonce', k.nonce, 'authTime', extract(epoch from k.auth_time)::bigint, 'amr', k.amr,
    'claims', case when 'openid' = any(k.scopes) then oidc_claims(v_app.id, k.person_id, k.scopes) end);
end $$;

-- refresh_token: rotation. A refresh token seen again after it was swapped ends every token of its connection.
create function pulse.oidc_token_refresh(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_app pulse_priv.oidc_app%rowtype; t pulse_priv.oidc_token%rowtype; g oidc_grant%rowtype; v_scopes text[]; v_ask text[]; v_refresh boolean;
begin
  v_app := oidc_client(p ->> 'clientId', p ->> 'secretHash');
  if v_app.id is null then return jsonb_build_object('error', 'invalid_client'); end if;
  select * into t from pulse_priv.oidc_token where hash = p ->> 'refreshHash' and kind = 'refresh' for update;
  if not found or t.app_id <> v_app.id then return jsonb_build_object('error', 'invalid_grant'); end if;
  perform set_config('pulse.org_id', t.org_id::text, true);
  if t.used_at is not null then
    -- Reuse means the chain leaked: every token of it ends; a personal connection ends too (signing in again asks the
    -- person again). An org link keeps its other chains (other app servers); its admins see the audit line.
    update pulse_priv.oidc_token set revoked_at = now() where family = t.family and revoked_at is null;
    perform set_config('pulse.actor_account', 'App ' || v_app.name, true);
    perform audit_write('oidc_token_reuse', 'oidc_grant', t.grant_id::text, array['refresh']);
    if exists (select 1 from oidc_grant where id = t.grant_id and kind = 'personal' and revoked_at is null) then perform oidc_grant_end(t.grant_id, 'app'); end if;
    return jsonb_build_object('error', 'invalid_grant');
  end if;
  if t.revoked_at is not null or t.expires_at < now() then return jsonb_build_object('error', 'invalid_grant'); end if;
  select * into g from oidc_grant where id = t.grant_id and revoked_at is null;
  if not found or (g.kind = 'personal' and not exists (select 1 from person where id = g.person_id and status = 'active')) then
    return jsonb_build_object('error', 'invalid_grant'); end if;
  -- Never wider than the token, and never wider than the connection allows now (an admin may have narrowed it).
  select coalesce(array_agg(x), '{}') into v_ask from jsonb_array_elements_text(case when jsonb_typeof(p -> 'scopes') = 'array' then p -> 'scopes' else '[]' end) x;
  v_scopes := array(select x from unnest(case when g.kind = 'org' then array(select distinct y from unnest(g.scopes || array['openid']) y) else t.scopes end) x
                     where x = any(g.scopes || array['openid','offline_access']) and (cardinality(v_ask) = 0 or x = any(v_ask)));
  if cardinality(v_ask) > 0 and exists (select 1 from unnest(v_ask) x where not x = any(t.scopes || case when g.kind = 'org' then g.scopes else '{}' end)) then
    return jsonb_build_object('error', 'invalid_scope'); end if;
  update pulse_priv.oidc_token set used_at = now() where hash = t.hash;
  v_refresh := oidc_issue(g, v_app.id, t.person_id, v_scopes, t.family, null, p ->> 'accessHash', p ->> 'newRefreshHash');
  return jsonb_build_object('kind', g.kind, 'org', g.org_id, 'scopes', to_jsonb(v_scopes), 'refresh', v_refresh, 'appId', v_app.id,
    'claims', case when 'openid' = any(v_scopes) and t.person_id is not null and exists (select 1 from person where id = t.person_id and status = 'active')
                   then oidc_claims(v_app.id, t.person_id, v_scopes) end);
end $$;

-- RFC 7009: an access token ends itself; a live refresh token ends its chain, and a personal connection with it (the
-- person signed out of the app). An org link ends only with DELETE …/link or in Pulse, never by one session's sign-out.
-- Unknown, used or expired tokens are not an error and change nothing more.
create function pulse.oidc_token_revoke(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_app pulse_priv.oidc_app%rowtype; t pulse_priv.oidc_token%rowtype;
begin
  v_app := oidc_client(p ->> 'clientId', p ->> 'secretHash');
  if v_app.id is null then return jsonb_build_object('error', 'invalid_client'); end if;
  select * into t from pulse_priv.oidc_token where hash = p ->> 'tokenHash' and app_id = v_app.id;
  if not found then return jsonb_build_object('ok', true); end if;
  perform set_config('pulse.org_id', t.org_id::text, true);
  if t.kind = 'access' then
    update pulse_priv.oidc_token set revoked_at = coalesce(revoked_at, now()) where hash = t.hash;
  elsif t.used_at is null and t.revoked_at is null and t.expires_at > now() then
    update pulse_priv.oidc_token set revoked_at = now() where family = t.family and revoked_at is null;
    if exists (select 1 from oidc_grant where id = t.grant_id and kind = 'personal' and revoked_at is null) then
      perform set_config('pulse.actor_account', 'App ' || v_app.name, true);
      perform oidc_grant_end(t.grant_id, 'app');
    end if;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Ends a connection (the organisation must be set): every token, its webhook endpoints wind down after telling the app.
create function pulse.oidc_grant_end(p_grant uuid, p_reason text) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare g oidc_grant%rowtype;
begin
  update oidc_grant set revoked_at = now(), revoked_by = current_viewer(), revoke_reason = p_reason
   where id = p_grant and org_id = current_org() and revoked_at is null returning * into g;
  if not found then return false; end if;
  update pulse_priv.oidc_token set revoked_at = now() where grant_id = p_grant and revoked_at is null;
  insert into connect_change(org_id, entity, ref, type) values (current_org(), 'link', p_grant, 'link.revoked');
  update connect_hook set status = 'ending' where grant_id = p_grant and status = 'active';
  perform audit_write('oidc_grant_revoked', 'oidc_grant', p_grant::text, array[p_reason]);
  return true;
end $$;

-- The bearer of an access token, for one scope: sets the organisation, the connection and (personal) the member as the
-- viewer; for a write by an org link, the admin who allowed it (row security needs a person). Null: unknown, expired or
-- ended (401). {error:'insufficient_scope'} (403); {error:'no_admin'} (409) when nobody can stand behind a write.
create function pulse.oidc_principal(p_hash text, p_scope text, p_write boolean default false) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare t pulse_priv.oidc_token%rowtype; g oidc_grant%rowtype; v_app pulse_priv.oidc_app%rowtype; v_actor uuid; v_eff text[];
begin
  select * into t from pulse_priv.oidc_token where hash = p_hash and kind = 'access' and revoked_at is null and expires_at > now();
  if not found then return null; end if;
  select * into v_app from pulse_priv.oidc_app where id = t.app_id and status = 'active';
  if not found then return null; end if;
  perform set_config('pulse.org_id', t.org_id::text, true);
  select * into g from oidc_grant where id = t.grant_id and revoked_at is null;
  if not found or not exists (select 1 from org where id = t.org_id and status = 'active') then return null; end if;
  if g.kind = 'personal' and not exists (select 1 from person where id = g.person_id and status = 'active') then return null; end if;
  -- An org link does what its admins allow now (a scope switched on in Pulse works at once); a personal token what it
  -- was issued for, while the connection still allows it.
  v_eff := case when g.kind = 'org' then array(select distinct x from unnest(g.scopes || array['openid']) x)
                else array(select x from unnest(t.scopes) x where x = any(g.scopes) or x = 'openid') end;
  if p_scope is not null and not p_scope = any(v_eff) then
    return jsonb_build_object('error', 'insufficient_scope', 'kind', g.kind);
  end if;
  if g.kind = 'personal' then v_actor := g.person_id;
  elsif p_write then
    -- Client and lead rows are written by an admin under row security: the admin who allowed the link, while still one.
    perform set_config('pulse.viewer_id', coalesce(g.granted_by::text, ''), true);
    if g.granted_by is null or not viewer_is('admin') or not exists (select 1 from person where id = g.granted_by and status = 'active') then
      perform set_config('pulse.viewer_id', '', true);
      return jsonb_build_object('error', 'no_admin', 'kind', g.kind);
    end if;
    v_actor := g.granted_by;
  end if;
  perform set_config('pulse.viewer_id', coalesce(v_actor::text, ''), true);
  perform set_config('pulse.oidc_grant_id', g.id::text, true);
  perform set_config('pulse.actor_account', 'App ' || v_app.name, true);
  if g.last_used_at is null or g.last_used_at < now() - interval '1 minute' then update oidc_grant set last_used_at = now() where id = g.id; end if;
  return jsonb_build_object('grant', g.id, 'app', v_app.id, 'appName', v_app.name, 'clientId', v_app.client_id, 'kind', g.kind, 'org', g.org_id,
    'person', t.person_id, 'member', g.person_id, 'scopes', to_jsonb(v_eff));
end $$;

-- The connection oidc_principal chose for this transaction, holding a scope, or an error.
create function pulse.connect_grant(p_scope text, p_kind text default null) returns pulse.oidc_grant
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare g oidc_grant%rowtype;
begin
  select * into g from oidc_grant where id = nullif(current_setting('pulse.oidc_grant_id', true), '')::uuid and org_id = current_org() and revoked_at is null;
  if not found or not p_scope = any(g.scopes) or (p_kind is not null and g.kind <> p_kind) then
    raise exception 'This connection may not do that' using errcode = '42501'; end if;
  return g;
end $$;

-- ------------------------------------------------------------------------------------------------ data API
-- Members (pulse.org.read): staff and freelancers; who left within 90 days is listed as left.
create function pulse.connect_members(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare g oidc_grant%rowtype := connect_grant('pulse.org.read', 'org'); v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 50), 1), 100);
  v_since timestamptz := nullif(p ->> 'updatedSince', '')::timestamptz; v_after uuid := nullif(p ->> 'after', '')::uuid; v_one uuid; rows jsonb;
begin
  if nullif(p ->> 'sub', '') is not null then
    v_one := oidc_sub_person(g.app_id, p ->> 'sub');
    if v_one is null then return null; end if;
  end if;
  with m as (
    select p2.id, p2.display_name, p2.status, pp.role title, pp.pod team, lower(pp.email) work_email, pp.username,
           (ph.person_id is not null) has_photo, ph.updated_at photo_at,
           greatest(pp.updated_at, ph.updated_at, p2.created_at, (select max(c.at) from connect_change c where c.org_id = p2.org_id and c.entity = 'person' and c.ref = p2.id)) updated_at
      from person p2 left join people_profile pp on pp.person_id = p2.id left join person_photo ph on ph.person_id = p2.id
     where p2.org_id = current_org() and p2.side in ('staff', 'freelancer')
       and (p2.status = 'active' or p2.active_to >= current_date - 90 or exists (select 1 from connect_change c where c.org_id = p2.org_id and c.entity = 'person'
            and c.ref = p2.id and c.type = 'membership.removed' and c.at > now() - interval '90 days'))
       and (v_one is null or p2.id = v_one) and (v_after is null or p2.id > v_after)
  ), page as (
    select * from m where v_since is null or updated_at > v_since order by id limit v_limit + 1
  )
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'member', id, 'sub', oidc_sub(g.app_id, id), 'name', display_name,
      'email', coalesce(oidc_checked_email(id), work_email), 'email_verified', oidc_checked_email(id) is not null,
      'title', nullif(btrim(coalesce(title, '')), ''), 'team', nullif(btrim(coalesce(team, '')), ''),
      'photo', case when has_photo then jsonb_build_object('member', id, 'version', (extract(epoch from photo_at) * 1000)::bigint) end,
      'role', oidc_member_role(id), 'status', case when status = 'active' then 'active' else 'left' end,
      'handle', coalesce((select x.handle from pulse_priv.pulse_account x join pulse_priv.account_member am on am.account_id = x.id where am.person_id = page.id), nullif(username, '')),
      'updated_at', updated_at)) order by id), '[]'::jsonb) into rows from page;
  return jsonb_build_object('members', rows);
end $$;

-- A member's photo for a signed picture address (the API checked the signature): only while the app keeps a live
-- connection to that organisation.
create function pulse.connect_photo(p_app text, p_org uuid, p_member uuid) returns table (bytes bytea, mime text, version bigint)
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_app uuid;
begin
  select id into v_app from pulse_priv.oidc_app where client_id = p_app and status = 'active';
  if v_app is null then return; end if;
  perform set_config('pulse.org_id', p_org::text, true);
  if not exists (select 1 from oidc_grant where org_id = p_org and app_id = v_app and revoked_at is null) then return; end if;
  return query select ph.bytes, ph.mime, (extract(epoch from ph.updated_at) * 1000)::bigint from person_photo ph
    join person p on p.id = ph.person_id where ph.person_id = p_member and ph.org_id = p_org and p.side in ('staff', 'freelancer', 'client');
end $$;

-- Clients (pulse.clients.read): an org link sees them all; a personal connection what the member sees in Pulse (staff
-- who work on clients; HR-only accounts and client seats see none, as on the screens).
create function pulse.connect_clients(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare g oidc_grant%rowtype := connect_grant('pulse.clients.read'); v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 50), 1), 100);
  v_since timestamptz := nullif(p ->> 'updatedSince', '')::timestamptz; v_after uuid := nullif(p ->> 'after', '')::uuid; v_one uuid := nullif(p ->> 'id', '')::uuid;
  v_q text := nullif(btrim(coalesce(p ->> 'q', '')), ''); rows jsonb;
begin
  if g.kind = 'personal' and (exists (select 1 from person where id = g.person_id and side <> 'staff')
       or (viewer_is('hr') and not viewer_is('admin', 'leadership', 'manager', 'finance', 'pgs', 'head_pgs'))) then
    raise exception 'This account does not work on clients' using errcode = '42501'; end if;
  with c as (
    select c.*, greatest(c.updated_at, (select max(x.at) from connect_change x where x.org_id = c.org_id and x.entity = 'client' and x.ref = c.id)) touched
      from client c
     where c.org_id = current_org() and not exists (select 1 from record_merge m where m.entity_type = 'client' and m.gone_id = c.id and m.undone_at is null)
       and (v_one is null or c.id = v_one) and (v_after is null or c.id > v_after)
       and (v_q is null or c.display_name ilike '%' || v_q || '%' or c.company_name ilike '%' || v_q || '%' or c.email ilike '%' || v_q || '%')
  ), page as (select * from c where v_since is null or touched > v_since order by id limit v_limit + 1)
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', id, 'name', display_name, 'company', company_name, 'type', client_type,
      'status', status, 'email', email, 'phone', phone, 'city', city, 'website', website, 'source', source,
      'owner', case when relationship_owner_id is not null then jsonb_build_object('sub', oidc_sub(g.app_id, relationship_owner_id),
               'name', (select display_name from person where id = relationship_owner_id)) end,
      'contacts', case when v_one is not null then coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', cp.id, 'name', cp.display_name,
               'designation', pr.designation, 'email', pr.email, 'phone', pr.phone, 'primary', coalesce(cc.is_primary, false))) order by cc.is_primary desc nulls last, cp.display_name)
             from client_contact cc join person cp on cp.id = cc.person_id left join contact_profile pr on pr.person_id = cc.person_id where cc.client_id = page.id), '[]'::jsonb) end,
      'updated_at', touched)) order by id), '[]'::jsonb) into rows from page;
  return jsonb_build_object('clients', rows);
end $$;

-- Money per client (pulse.money.read, org link): issued invoices less credit notes, payments received, what is owed.
create function pulse.connect_money_clients(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare g oidc_grant%rowtype := connect_grant('pulse.money.read', 'org'); v_limit int := least(greatest(coalesce((p ->> 'limit')::int, 50), 1), 100);
  v_after uuid := nullif(p ->> 'after', '')::uuid; rows jsonb;
begin
  -- One row per client (documents are INR only: erp_document's currency check), so the cursor never splits a client.
  with d as (
    select d.client_id, min(d.currency) currency,
           sum(case when d.doc_type = 'invoice' then d.total when d.doc_type = 'credit_note' then -d.total else 0 end) invoiced,
           max(d.issue_date) filter (where d.doc_type = 'invoice') last_invoice_on
      from erp_document d
     where d.org_id = current_org() and d.client_id is not null and d.doc_type in ('invoice', 'credit_note')
       and d.status in ('issued', 'sent', 'part_paid', 'paid') and (v_after is null or d.client_id > v_after)
     group by d.client_id
  ), pay as (
    select d.client_id, sum(pm.amount + coalesce(pm.tds, 0)) received, max(pm.received_on) last_payment_on
      from erp_payment pm join erp_document d on d.id = pm.document_id
     where pm.org_id = current_org() and pm.voided_at is null and d.client_id is not null and (v_after is null or d.client_id > v_after)
     group by d.client_id
  ), page as (
    select d.*, coalesce(pay.received, 0) received, pay.last_payment_on, c.display_name from d left join pay using (client_id)
      join client c on c.id = d.client_id order by d.client_id limit v_limit + 1
  )
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('client_id', client_id, 'name', display_name, 'currency', coalesce(currency, 'INR'),
      'invoiced', round(invoiced, 2)::text, 'received', round(received, 2)::text, 'outstanding', round(invoiced - received, 2)::text,
      'last_invoice_on', last_invoice_on, 'last_payment_on', last_payment_on)) order by client_id), '[]'::jsonb) into rows from page;
  return jsonb_build_object('clients', rows);
end $$;

-- Work signals (pulse.signals.write): counts per member per day; the latest value wins. A `sub` that names nobody here,
-- a day outside the last 400 days or tomorrow, or an unknown kind is ignored.
create function pulse.connect_signals(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare g oidc_grant%rowtype := connect_grant('pulse.signals.write', 'org'); i jsonb; v_person uuid; v_day date; ok int := 0; bad int := 0;
begin
  if jsonb_typeof(p -> 'items') <> 'array' or jsonb_array_length(p -> 'items') > 500 then raise exception 'Send 1 to 500 items' using errcode = '22023'; end if;
  for i in select * from jsonb_array_elements(p -> 'items') loop
    v_person := case when jsonb_typeof(i -> 'sub') = 'string' then oidc_sub_person(g.app_id, i ->> 'sub') end;
    v_day := case when coalesce(i ->> 'day', '') ~ '^\d{4}-\d{2}-\d{2}$' then (i ->> 'day')::date end;
    if v_person is null or v_day is null or v_day > current_date + 1 or v_day < current_date - 400
       or not coalesce(i ->> 'kind', '') = any(array['calls_analysed', 'leads_worked', 'follow_ups_done', 'talk_minutes'])
       or jsonb_typeof(i -> 'value') <> 'number' or (i ->> 'value')::numeric not between 0 and 1000000 then
      bad := bad + 1; continue;
    end if;
    insert into connect_signal(org_id, app_id, person_id, kind, day, value) values (current_org(), g.app_id, v_person, i ->> 'kind', v_day, round((i ->> 'value')::numeric))
    on conflict (org_id, app_id, person_id, kind, day) do update set value = excluded.value, updated_at = now();
    ok := ok + 1;
  end loop;
  return jsonb_build_object('accepted', ok, 'ignored', bad);
end $$;

-- Webhook endpoints of the current org link (pulse.org.webhooks).
create function pulse.connect_hooks(p_op text, p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare g oidc_grant%rowtype := connect_grant('pulse.org.webhooks', 'org'); v_events text[]; v_id uuid;
begin
  if p_op = 'add' then
    if (select count(*) from connect_hook where grant_id = g.id and status in ('active', 'off')) >= 5 then
      raise exception 'A link has at most 5 webhook endpoints' using errcode = '54000'; end if;
    select coalesce(array_agg(distinct x), '{}') into v_events from jsonb_array_elements_text(coalesce(p -> 'events', '[]')) x;
    if cardinality(v_events) = 0 then v_events := oidc_scope_events(g.scopes); end if;
    if exists (select 1 from unnest(v_events) x where not x = any(oidc_scope_events(g.scopes))) then
      raise exception 'This link may not receive one of those events' using errcode = '22023'; end if;
    insert into connect_hook(org_id, grant_id, url, events, secret, cursor_seq)
    values (current_org(), g.id, p ->> 'url', v_events, p -> 'secret', coalesce((select max(seq) from connect_change where org_id = current_org()), 0))
    returning id into v_id;
    perform audit_write('connect_webhook_added', 'oidc_grant', g.id::text, v_events);
    return jsonb_build_object('id', v_id, 'events', to_jsonb(v_events));
  elsif p_op = 'remove' then
    update connect_hook set status = 'removed' where id = nullif(p ->> 'id', '')::uuid and grant_id = g.id and status <> 'removed' returning id into v_id;
    if v_id is null then return null; end if;
    perform audit_write('connect_webhook_removed', 'oidc_grant', g.id::text);
    return jsonb_build_object('id', v_id);
  end if;
  return jsonb_build_object('webhooks', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'url', url, 'events', to_jsonb(events), 'status', status,
      'last_ok_at', last_ok_at, 'last_error', last_error) order by created_at) from connect_hook where grant_id = g.id and status <> 'removed'), '[]'::jsonb));
end $$;

-- DELETE …/link: the app ends its org link.
create function pulse.connect_link_end() returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare g oidc_grant%rowtype;
begin
  select * into g from oidc_grant where id = nullif(current_setting('pulse.oidc_grant_id', true), '')::uuid and org_id = current_org() and revoked_at is null and kind = 'org';
  if not found then raise exception 'This connection is not an organisation link' using errcode = '42501'; end if;
  return oidc_grant_end(g.id, 'link');
end $$;

-- ------------------------------------------------------------------------------------------------ in Pulse
-- Settings → Connected apps (admins: the organisation's links and members' personal connections) and Account →
-- Connected apps (mine). Admins switch an org link's scopes within what the app asked for, and end any connection
-- here; a member ends their own.
create function pulse.oidc_connections(p_op text, p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_admin boolean := viewer_is('admin'); g oidc_grant%rowtype; v_scopes text[];
begin
  if current_viewer() is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  if p_op in ('scopes', 'end') then
    select * into g from oidc_grant where id = nullif(p ->> 'id', '')::uuid and org_id = current_org() and revoked_at is null for update;
    if not found or not (v_admin or (g.kind = 'personal' and g.person_id = current_viewer() and p_op = 'end')) then
      raise exception 'Not a connection you can change' using errcode = '42501'; end if;
    if p_op = 'end' then
      perform oidc_grant_end(g.id, case when g.person_id = current_viewer() then 'person' else 'admin' end);
    else
      select coalesce(array_agg(distinct x), '{}') into v_scopes from jsonb_array_elements_text(coalesce(p -> 'scopes', '[]')) x where x = any(g.asked);
      if not 'openid' = any(v_scopes) and 'openid' = any(g.asked) then v_scopes := array_prepend('openid', v_scopes); end if;
      update oidc_grant set scopes = v_scopes, updated_at = now() where id = g.id;
      insert into connect_change(org_id, entity, ref, type) values (current_org(), 'link', g.id, 'link.changed');
      perform audit_write('oidc_grant_changed', 'oidc_grant', g.id::text, v_scopes);
    end if;
  end if;
  return jsonb_build_object('admin', v_admin, 'connections', coalesce((select jsonb_agg(jsonb_build_object(
      'id', x.id, 'kind', x.kind, 'scopes', to_jsonb(x.scopes), 'asked', to_jsonb(x.asked), 'createdAt', x.created_at, 'updatedAt', x.updated_at,
      'lastUsedAt', x.last_used_at, 'mine', x.person_id = current_viewer(),
      'person', case when x.person_id is not null then jsonb_build_object('id', x.person_id, 'name', (select display_name from person where id = x.person_id)) end,
      'grantedBy', (select jsonb_build_object('id', id, 'name', display_name, 'active', status = 'active') from person where id = x.granted_by),
      'app', (select jsonb_build_object('clientId', a.client_id, 'name', a.name, 'maker', a.maker, 'verified', a.verified, 'homeUrl', a.home_url,
               'logo', case when a.logo is not null then extract(epoch from a.updated_at)::bigint end, 'status', a.status) from pulse_priv.oidc_app a where a.id = x.app_id),
      'webhooks', (select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'url', h.url, 'events', to_jsonb(h.events), 'status', h.status, 'lastOkAt', h.last_ok_at,
               'lastError', h.last_error, 'failingSince', h.failing_since) order by h.created_at), '[]'::jsonb) from connect_hook h where h.grant_id = x.id and h.status <> 'removed'),
      'calls', (select count(*) from connect_call k where k.grant_id = x.id and k.at > now() - interval '7 days'))
      order by x.kind desc, x.created_at desc)
    from oidc_grant x where x.org_id = current_org() and x.revoked_at is null and (v_admin or x.person_id = current_viewer())), '[]'::jsonb));
end $$;

-- ------------------------------------------------------------------------------------------------ sign-up
-- "New to Pulse? Create your account" (from an app's sign-in): a new Pulse account and the organisation it starts, as
-- its admin, with a session there. The organisation is made the way "Start your own Pulse" makes one (0920
-- account_start_org, without an industry pack: Settings has it afterwards); keep the two in step.
create function pulse.account_signup(p jsonb, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare v uuid; h text := lower(ltrim(btrim(coalesce(p ->> 'handle', '')), '@')); e text := nullif(lower(btrim(coalesce(p ->> 'email', ''))), '');
  n text := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'); o text := regexp_replace(btrim(coalesce(p ->> 'orgName', '')), '\s+', ' ', 'g');
  oh text; v_org uuid := gen_random_uuid(); v_person uuid; v_code text; v_letters text; k int := 0; v_slug text;
begin
  if length(n) not between 2 and 120 then raise exception 'Give your name' using errcode = '22023'; end if;
  if h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then raise exception 'A handle is 3 to 30 lower-case letters, digits, dots or underscores' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h) then raise exception 'Someone already has @%', h using errcode = '23505'; end if;
  if e is null or e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Give your e-mail address' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.pulse_account where email = e) then raise exception 'That e-mail already has a Pulse account: sign in instead' using errcode = '23505'; end if;
  if length(o) not between 2 and 80 then raise exception 'Give your organisation a name of 2 to 80 characters' using errcode = '22023'; end if;
  insert into pulse_priv.pulse_account(handle, display_name, email, password_hash) values (h, n, e, crypt(p ->> 'password', gen_salt('bf', 10))) returning id into v;
  insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', v);
  oh := handle_suggest(o);
  -- The code (2 to 4 capitals, unique): the name's initials, then more of its letters (as account_start_org).
  v_letters := upper(regexp_replace(o, '[^A-Za-z]', '', 'g')) || 'PULSEXYZ';
  v_code := left(upper(regexp_replace(initcap(o), '[^A-Z]', '', 'g')) || substr(v_letters, 2), 3);
  if length(v_code) < 2 then v_code := left(v_letters, 3); end if;
  while exists (select 1 from org where code = v_code) loop
    k := k + 1; v_code := left(v_code, 2) || chr(65 + ((k - 1) % 26)) || case when k > 26 then chr(65 + ((k - 1) / 26 - 1) % 26) else '' end;
    if k > 700 then raise exception 'Could not find a free organisation code' using errcode = '54000'; end if;
  end loop;
  v_slug := oh; while exists (select 1 from org where slug = v_slug) loop v_slug := v_slug || 'x'; end loop;
  perform acct_enter(v_org, null);
  perform set_config('pulse.actor_account', 'Pulse account @' || h, true);
  insert into org(id, slug, name, code, handle) values (v_org, v_slug, o, v_code, oh);
  insert into hr_policy(org_id, attendance_enabled) values (v_org, false) on conflict (org_id) do nothing;
  insert into org_module(org_id, module, enabled) values (v_org, 'tasks', true), (v_org, 'chats', true), (v_org, 'finance', true);
  insert into person(org_id, display_name, side, status, active_from) values (v_org, n, 'staff', 'active', current_date) returning id into v_person;
  insert into people_profile(org_id, person_id, role, email, username, user_no, evidence, field_sources)
  values (v_org, v_person, 'Owner', e, h, 1, 'Started this organisation (@' || h || ')', '{}');
  insert into role_assignment(org_id, person_id, role_key, valid_from) values (v_org, v_person, 'admin', current_date);
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (v_org, 'person', v_person, 'created', null, 'Signed up to Pulse and started the organisation', null);
  perform acct_leave();
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (v, v_org, v_person, 'staff');
  return acct_session(v, v_org, p_hash, p_device) || jsonb_build_object('code', v_code);
end $$;

-- ------------------------------------------------------------------------------------------------ changes and webhooks
-- What changed, kept while the organisation has a live org link (it feeds webhooks and members' updated_at). Never
-- stops the write it observes: any problem here is swallowed.
create function pulse.connect_note() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r record; v_org uuid; v_ref uuid; v_entity text := 'person'; v_type text; v_changed text[] := '{}'; back text := current_setting('pulse.org_id', true);
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  v_org := r.org_id;
  -- Most organisations have no app linked: answered before the (subtransaction) block below.
  perform set_config('pulse.org_id', v_org::text, true);
  if not exists (select 1 from oidc_grant where org_id = v_org and kind = 'org' and revoked_at is null) then
    perform set_config('pulse.org_id', coalesce(back, ''), true);
    return null;
  end if;
  begin
    if tg_table_name = 'person' then
      v_ref := r.id;
      if tg_op = 'INSERT' then v_type := case when new.status = 'active' then 'membership.added' end;
      elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
        v_type := case when new.status = 'active' then 'membership.added' when old.status = 'active' then 'membership.removed' end;
      elsif tg_op = 'UPDATE' and new.display_name is distinct from old.display_name then v_type := 'person.updated'; v_changed := array['name'];
      end if;
      if v_type is not null and r.side not in ('staff', 'freelancer') then v_type := null; end if;
    elsif tg_table_name = 'people_profile' then
      v_ref := r.person_id; v_type := 'person.updated';
      if tg_op = 'UPDATE' then
        v_changed := array_remove(array[case when new.role is distinct from old.role then 'title' end, case when new.pod is distinct from old.pod then 'team' end,
          case when new.email is distinct from old.email then 'email' end, case when new.username is distinct from old.username then 'handle' end], null);
        if cardinality(v_changed) = 0 then v_type := null; end if;
      else v_changed := array['title', 'team', 'email'];
      end if;
    elsif tg_table_name = 'person_photo' then
      v_ref := r.person_id; v_type := 'person.photo_updated'; v_changed := array['picture'];
    elsif tg_table_name = 'role_assignment' then
      v_ref := r.person_id; v_type := 'membership.role_changed'; v_changed := array['role'];
    elsif tg_table_name = 'client' then
      v_entity := 'client'; v_ref := r.id; v_type := case when tg_op = 'DELETE' then 'client.removed' else 'client.updated' end;
    end if;
    if v_type is not null then
      insert into connect_change(org_id, entity, ref, type, changed) values (v_org, v_entity, v_ref, v_type, v_changed);
    end if;
    perform set_config('pulse.org_id', coalesce(back, ''), true);
  exception when others then
    perform set_config('pulse.org_id', coalesce(back, ''), true);
  end;
  return null;
end $$;
create trigger connect_note after insert or update of status, display_name on pulse.person for each row execute function pulse.connect_note();
create trigger connect_note after insert or update of role, pod, email, username on pulse.people_profile for each row execute function pulse.connect_note();
create trigger connect_note after insert or update or delete on pulse.person_photo for each row execute function pulse.connect_note();
create trigger connect_note after insert or update or delete on pulse.role_assignment for each row execute function pulse.connect_note();
create trigger connect_note after insert or update or delete on pulse.client for each row execute function pulse.connect_note();

-- The delivery tick, per organisation (the API sets it): turns changes into events for each endpoint (one pending event
-- per endpoint, type and member at a time, its fields merged), and hands back what is due with the sealed secrets.
create function pulse.connect_due(p_limit int default 50) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare h record; c record; v_sub text; v_body jsonb; v_pending uuid; v_max bigint; v_due uuid[];
begin
  for h in select k.*, g.app_id, g.id gid, g.scopes from connect_hook k join oidc_grant g on g.id = k.grant_id
            where k.org_id = current_org() and k.status in ('active', 'ending') loop
    v_max := 0;
    -- Changes since the endpoint was registered that it has not seen yet (one committing late is still found). What
    -- happens to the link itself (ended, scopes changed) reaches every endpoint of that link, listed or not.
    for c in select * from connect_change where org_id = current_org() and seq > h.cursor_seq and not (h.id = any(seen_by))
               and (type = any(h.events) or (entity = 'link' and ref = h.gid)) and (entity <> 'link' or ref = h.gid) order by seq limit 500 loop
      v_max := v_max + 1;
      update connect_change set seen_by = seen_by || h.id where seq = c.seq;
      if c.entity = 'person' then
        if not exists (select 1 from person where id = c.ref and side in ('staff', 'freelancer')) then continue; end if;
        v_sub := oidc_sub(h.app_id, c.ref);
        v_body := jsonb_build_object('type', c.type, 'org_id', current_org(), 'sub', v_sub, 'occurred_at', c.at, 'changed', to_jsonb(c.changed));
      elsif c.entity = 'client' then
        v_body := jsonb_build_object('type', c.type, 'org_id', current_org(), 'client_id', c.ref, 'occurred_at', c.at, 'changed', to_jsonb(c.changed));
      else
        v_body := jsonb_build_object('type', c.type, 'org_id', current_org(), 'occurred_at', c.at, 'changed', '[]'::jsonb);
      end if;
      select id into v_pending from connect_event where hook_id = h.id and type = c.type and delivered_at is null and given_up_at is null and attempts = 0
         and next_at <= now()  -- never one being delivered right now
         and body -> 'sub' is not distinct from v_body -> 'sub' and body -> 'client_id' is not distinct from v_body -> 'client_id' limit 1;
      if v_pending is not null then
        update connect_event set body = body || jsonb_build_object('occurred_at', c.at,
          'changed', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from (select jsonb_array_elements_text(body -> 'changed') x union select unnest(c.changed)) u))
         where id = v_pending;
      else
        insert into connect_event(org_id, hook_id, type, body, occurred_at) values (current_org(), h.id, c.type, v_body, c.at);
      end if;
    end loop;
    -- An ended link stops once its last events (link.revoked among them) are out.
    if h.status = 'ending' and v_max = 0 and not exists (select 1 from connect_event where hook_id = h.id and delivered_at is null and given_up_at is null) then
      update connect_hook set status = 'removed' where id = h.id;
    end if;
  end loop;
  delete from connect_change where org_id = current_org() and at < now() - interval '90 days';
  delete from connect_event where org_id = current_org() and coalesce(delivered_at, given_up_at) < now() - interval '30 days';
  delete from connect_call where org_id = current_org() and at < now() - interval '90 days';
  -- What is handed out is leased for two minutes, so a second API process's tick does not send it again meanwhile.
  select coalesce(array_agg(id), '{}') into v_due from (
    select e.id from connect_event e join connect_hook k on k.id = e.hook_id and k.status in ('active', 'ending')
     where e.org_id = current_org() and e.delivered_at is null and e.given_up_at is null and e.next_at <= now()
     order by e.next_at limit p_limit for update of e skip locked) d;
  update connect_event set next_at = now() + interval '2 minutes' where id = any(v_due);
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'hook', e.hook_id, 'url', k.url, 'secret', k.secret, 'type', e.type,
      'body', jsonb_build_object('event_id', e.id) || e.body, 'attempts', e.attempts) order by e.occurred_at)
    from connect_event e join connect_hook k on k.id = e.hook_id where e.id = any(v_due)), '[]'::jsonb);
end $$;

-- What each delivery did: 2xx delivered; otherwise retried after 1, 5, 15, 60 minutes, then hourly for 24 hours; an
-- endpoint failing for 3 days is switched off.
create function pulse.connect_delivered(p jsonb) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r jsonb; e connect_event%rowtype; ok boolean;
begin
  for r in select * from jsonb_array_elements(p) loop
    select * into e from connect_event where id = (r ->> 'id')::uuid and org_id = current_org();
    if not found then continue; end if;
    ok := coalesce((r ->> 'status')::int, 0) between 200 and 299;
    update connect_event set attempts = attempts + 1, last_status = nullif((r ->> 'status')::int, 0),
           delivered_at = case when ok then now() end,
           given_up_at = case when not ok and e.occurred_at < now() - interval '24 hours' then now() end,
           next_at = now() + case e.attempts when 0 then interval '1 minute' when 1 then interval '5 minutes' when 2 then interval '15 minutes' else interval '60 minutes' end
     where id = e.id;
    update connect_hook set last_ok_at = case when ok then now() else last_ok_at end, failing_since = case when ok then null else coalesce(failing_since, now()) end,
           last_error = case when ok then null else left(coalesce(r ->> 'error', 'HTTP ' || coalesce(r ->> 'status', '?')), 200) end,
           status = case when not ok and status = 'active' and coalesce(failing_since, now()) < now() - interval '3 days' then 'off' else status end
     where id = e.hook_id;
  end loop;
end $$;

-- The data API's call log (no content).
create function pulse.connect_log(p_grant uuid, p_operation text, p_status int, p_ms int) returns void
  language sql security definer set search_path = pulse, pg_temp as $$
  insert into connect_call(org_id, grant_id, operation, status, ms) select current_org(), p_grant, left(p_operation, 80), p_status, p_ms
   where exists (select 1 from oidc_grant where id = p_grant and org_id = current_org())
$$;

-- Codes and tokens past their time are deleted by the tick (any organisation).
create function pulse.oidc_sweep() returns int
  language sql security definer set search_path = pulse, pg_temp as $$
  with a as (delete from pulse_priv.oidc_code where expires_at < now() - interval '1 day' returning 1),
       b as (delete from pulse_priv.oidc_token where expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days' returning 1)
  select ((select count(*) from a) + (select count(*) from b))::int
$$;

-- The organisations with webhook work to do (the tick visits only these).
create function pulse.connect_hook_orgs() returns setof uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o uuid; back text := current_setting('pulse.org_id', true);
begin
  for o in select id from org where status = 'active' loop
    perform set_config('pulse.org_id', o::text, true);
    if exists (select 1 from connect_hook where org_id = o and status in ('active', 'ending')) then return next o; end if;
  end loop;
  perform set_config('pulse.org_id', coalesce(back, ''), true);
end $$;

do $$ declare f text; begin
  foreach f in array array['pulse.oidc_known_scopes()', 'pulse.oidc_org_scopes()', 'pulse.oidc_scope_events(text[])', 'pulse.oidc_member_role(uuid)',
      'pulse.oidc_checked_email(uuid)', 'pulse.oidc_sub(uuid,uuid)', 'pulse.oidc_sub_person(uuid,text)', 'pulse.oidc_claims(uuid,uuid,text[])',
      'pulse.oidc_install_admin()', 'pulse.oidc_redirect_ok(text,boolean)', 'pulse.oidc_app_manage(text,jsonb)', 'pulse.oidc_app_public(text)',
      'pulse.oidc_app_logo(text)', 'pulse.oidc_consent_state(jsonb)', 'pulse.oidc_authorize(jsonb)', 'pulse.oidc_client(text,text)',
      'pulse.oidc_issue(pulse.oidc_grant,uuid,uuid,text[],uuid,text,text,text)', 'pulse.oidc_token_code(jsonb)', 'pulse.oidc_token_refresh(jsonb)',
      'pulse.oidc_token_revoke(jsonb)', 'pulse.oidc_grant_end(uuid,text)', 'pulse.oidc_principal(text,text,boolean)', 'pulse.connect_grant(text,text)',
      'pulse.connect_members(jsonb)', 'pulse.connect_photo(text,uuid,uuid)', 'pulse.connect_clients(jsonb)', 'pulse.connect_money_clients(jsonb)',
      'pulse.connect_signals(jsonb)', 'pulse.connect_hooks(text,jsonb)', 'pulse.connect_link_end()', 'pulse.oidc_connections(text,jsonb)',
      'pulse.connect_note()', 'pulse.connect_due(int)', 'pulse.connect_delivered(jsonb)', 'pulse.connect_log(uuid,text,int,int)', 'pulse.oidc_sweep()',
      'pulse.connect_hook_orgs()', 'pulse.account_signup(jsonb,text,text)', 'pulse.oidc_client_ok(text,text)'] loop
    execute format('revoke all on function %s from public', f);
  end loop;
  -- What the API calls; the helpers stay owner-only (the functions above call them as the owner).
  foreach f in array array['pulse.oidc_app_manage(text,jsonb)', 'pulse.oidc_app_public(text)', 'pulse.oidc_app_logo(text)', 'pulse.oidc_consent_state(jsonb)',
      'pulse.oidc_authorize(jsonb)', 'pulse.oidc_token_code(jsonb)', 'pulse.oidc_token_refresh(jsonb)', 'pulse.oidc_token_revoke(jsonb)',
      'pulse.oidc_principal(text,text,boolean)', 'pulse.oidc_claims(uuid,uuid,text[])', 'pulse.connect_members(jsonb)', 'pulse.connect_photo(text,uuid,uuid)',
      'pulse.connect_clients(jsonb)', 'pulse.connect_money_clients(jsonb)', 'pulse.connect_signals(jsonb)', 'pulse.connect_hooks(text,jsonb)',
      'pulse.connect_link_end()', 'pulse.oidc_connections(text,jsonb)', 'pulse.connect_due(int)', 'pulse.connect_delivered(jsonb)',
      'pulse.connect_log(uuid,text,int,int)', 'pulse.oidc_sweep()', 'pulse.connect_hook_orgs()', 'pulse.oidc_known_scopes()',
      'pulse.account_signup(jsonb,text,text)', 'pulse.oidc_sub(uuid,uuid)', 'pulse.oidc_sub_person(uuid,text)',
      'pulse.oidc_install_admin()', 'pulse.oidc_client_ok(text,text)'] loop
    execute format('grant execute on function %s to pulse_api', f);
  end loop;
end $$;

-- migrate:down
drop trigger connect_note on pulse.person;
drop trigger connect_note on pulse.people_profile;
drop trigger connect_note on pulse.person_photo;
drop trigger connect_note on pulse.role_assignment;
drop trigger connect_note on pulse.client;
drop function pulse.account_signup(jsonb,text,text), pulse.connect_hook_orgs(), pulse.oidc_sweep(), pulse.connect_log(uuid,text,int,int), pulse.connect_delivered(jsonb), pulse.connect_due(int),
  pulse.connect_note(), pulse.oidc_connections(text,jsonb), pulse.connect_link_end(), pulse.connect_hooks(text,jsonb), pulse.connect_signals(jsonb),
  pulse.connect_money_clients(jsonb), pulse.connect_clients(jsonb), pulse.connect_photo(text,uuid,uuid), pulse.connect_members(jsonb),
  pulse.connect_grant(text,text), pulse.oidc_principal(text,text,boolean), pulse.oidc_grant_end(uuid,text), pulse.oidc_token_revoke(jsonb),
  pulse.oidc_token_refresh(jsonb), pulse.oidc_token_code(jsonb), pulse.oidc_issue(pulse.oidc_grant,uuid,uuid,text[],uuid,text,text,text),
  pulse.oidc_client_ok(text,text), pulse.oidc_client(text,text), pulse.oidc_authorize(jsonb), pulse.oidc_consent_state(jsonb), pulse.oidc_app_logo(text), pulse.oidc_app_public(text),
  pulse.oidc_app_manage(text,jsonb), pulse.oidc_redirect_ok(text,boolean), pulse.oidc_install_admin(), pulse.oidc_claims(uuid,uuid,text[]),
  pulse.oidc_sub_person(uuid,text), pulse.oidc_sub(uuid,uuid), pulse.oidc_checked_email(uuid), pulse.oidc_member_role(uuid),
  pulse.oidc_scope_events(text[]), pulse.oidc_org_scopes(), pulse.oidc_known_scopes();
drop table pulse.connect_call, pulse.connect_signal, pulse.connect_event, pulse.connect_change, pulse.connect_hook,
  pulse_priv.oidc_token, pulse_priv.oidc_code, pulse.oidc_grant, pulse_priv.oidc_subject, pulse_priv.oidc_app;
