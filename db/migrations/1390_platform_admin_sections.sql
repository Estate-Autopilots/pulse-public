-- migrate:up
-- PULSE-ADMIN (owner, 27 Oct 2026): the Pulse admin site (apps/admin, pulse-admin.<domain>), a port of the Sales X-Ray
-- admin console. Its sections beyond 1140: releases (what each environment ran, recorded by the API itself at start),
-- bug reports (BUG-REPORT's pulse.reported_bug, 1201) and app feedback across organisations, product telemetry per
-- organisation (0983), AI spend by engine and model, and integrations (Sign in with Pulse apps, AI connections,
-- connectors). Every function checks pulse.platform_admin() itself (platform_guard) and reads each organisation from
-- inside it; nothing here writes into an organisation.

-- What each environment ran: the API records its own release when it starts (PULSE_RELEASE, PULSE_ENV).
create table pulse_priv.platform_release(
  env text not null check (env ~ '^[a-z][a-z0-9-]{0,19}$'),
  sha text not null check (sha ~ '^[0-9a-f]{7,40}$'),
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  starts int not null default 1,
  primary key (env, sha));
revoke all on pulse_priv.platform_release from public;

create function pulse.platform_release_seen(p_env text, p_sha text) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if p_env !~ '^[a-z][a-z0-9-]{0,19}$' or p_sha !~ '^[0-9a-f]{7,40}$' then return; end if;
  insert into pulse_priv.platform_release(env, sha) values (p_env, p_sha)
  on conflict (env, sha) do update set last_seen = now(), starts = pulse_priv.platform_release.starts + 1;
end $$;
revoke all on function pulse.platform_release_seen(text, text) from public;
grant execute on function pulse.platform_release_seen(text, text) to pulse_api;

create function pulse.platform_releases() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform platform_guard();
  return (select coalesce(jsonb_agg(jsonb_build_object('env', env, 'sha', sha, 'firstSeen', first_seen, 'lastSeen', last_seen, 'starts', starts)
    order by first_seen desc), '[]') from (select * from pulse_priv.platform_release order by first_seen desc limit 200) r);
end $$;
revoke all on function pulse.platform_releases() from public;
grant execute on function pulse.platform_releases() to pulse_api;

-- Bug reports from every organisation (newest first), with counts by status. Words are the reporter's own.
create function pulse.platform_bugs(p_status text, p_q text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o record; v_rows jsonb := '[]'; v_part jsonb; v_counts jsonb := '{}'; v_q text := nullif(lower(btrim(coalesce(p_q, ''))), '');
begin
  perform platform_guard();
  if to_regclass('pulse.reported_bug') is null then return jsonb_build_object('bugs', '[]'::jsonb, 'counts', '{}'::jsonb); end if;
  for o in select id, name from org order by name loop
    perform platform_enter(o.id);
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'number', b.number, 'orgId', $1, 'org', $2, 'words', left(b.words, 400),
          'status', b.status, 'severity', b.severity, 'blocksWork', b.blocks_work, 'route', b.route, 'platform', b.platform,
          'appVersion', b.app_version, 'reporter', coalesce(p.display_name, b.reporter_name), 'createdAt', b.created_at,
          'duplicate', b.duplicate_of is not null) order by b.created_at desc), '[]')
        from (select * from pulse.reported_bug where org_id = $1 and ($3::text is null or status = $3)
               and ($4::text is null or lower(coalesce(words, '')) like '%' || $4 || '%' or lower(coalesce(route, '')) like '%' || $4 || '%')
               order by created_at desc limit 200) b left join pulse.person p on p.id = b.person_id $q$
      into v_part using o.id, o.name, nullif(p_status, ''), v_q;
    v_rows := v_rows || v_part;
    execute $q$ select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from pulse.reported_bug where org_id = $1 group by status) s $q$
      into v_part using o.id;
    v_counts := (select coalesce(jsonb_object_agg(k, coalesce((v_counts ->> k)::int, 0) + coalesce((v_part ->> k)::int, 0)), '{}')
                   from (select jsonb_object_keys(v_counts) k union select jsonb_object_keys(v_part)) keys);
    perform platform_leave();
  end loop;
  return jsonb_build_object('bugs', (select coalesce(jsonb_agg(x order by (x ->> 'createdAt') desc), '[]') from (select x from jsonb_array_elements(v_rows) x limit 300) t), 'counts', v_counts);
end $$;
revoke all on function pulse.platform_bugs(text, text) from public;
grant execute on function pulse.platform_bugs(text, text) to pulse_api;

-- What people said in the apps (Settings → Send feedback), every organisation; screenshots stay in the organisation.
create function pulse.platform_feedback() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o record; v_rows jsonb := '[]'; v_part jsonb;
begin
  perform platform_guard();
  for o in select id, name from org order by name loop
    perform platform_enter(o.id);
    select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'orgId', o.id, 'org', o.name, 'body', left(f.body, 600), 'page', f.page,
        'platform', f.platform, 'appVersion', f.app_version, 'status', f.status, 'person', p.display_name, 'screenshot', f.screenshot is not null,
        'createdAt', f.created_at) order by f.created_at desc), '[]')
      into v_part from (select * from app_feedback where org_id = o.id order by created_at desc limit 100) f left join person p on p.id = f.person_id;
    perform platform_leave();
    v_rows := v_rows || v_part;
  end loop;
  return (select coalesce(jsonb_agg(x order by (x ->> 'createdAt') desc), '[]') from (select x from jsonb_array_elements(v_rows) x) t);
end $$;
revoke all on function pulse.platform_feedback() from public;
grant execute on function pulse.platform_feedback() to pulse_api;

-- Product telemetry (0983's daily rollup) per organisation, and the slowest and most failing places across Pulse.
create function pulse.platform_telemetry(p_days int) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o record; v_days int := least(greatest(coalesce(p_days, 7), 1), 90); v_since date; v_orgs jsonb := '[]'; v_places jsonb := '[]'; v_part jsonb;
begin
  perform platform_guard();
  v_since := current_date - v_days;
  for o in select id, name from org where status = 'active' order by name loop
    perform platform_enter(o.id);
    select jsonb_build_object('id', o.id, 'name', o.name, 'events', coalesce(sum(events), 0), 'errors', coalesce(sum(errors), 0),
        'people', coalesce(max(people), 0), 'sessions', coalesce(sum(sessions), 0),
        'pageP75', (select round(avg(p75_ms)::numeric) from telemetry_daily t2 where t2.org_id = o.id and t2.day >= v_since and t2.kind = 'page'),
        'platforms', (select coalesce(jsonb_agg(distinct platform), '[]') from telemetry_daily t3 where t3.org_id = o.id and t3.day >= v_since and platform is not null))
      into v_part from telemetry_daily where org_id = o.id and day >= v_since;
    if (v_part ->> 'events')::bigint > 0 then v_orgs := v_orgs || jsonb_build_array(v_part); end if;
    select coalesce(jsonb_agg(jsonb_build_object('org', o.name, 'kind', kind, 'name', name, 'events', events, 'errors', errors, 'p75', p75)), '[]')
      into v_part from (select kind, name, sum(events) events, sum(errors) errors, round(avg(p75_ms)::numeric) p75
                          from telemetry_daily where org_id = o.id and day >= v_since group by kind, name
                          order by sum(errors) desc, avg(p75_ms) desc nulls last limit 15) x;
    v_places := v_places || v_part;
    perform platform_leave();
  end loop;
  return jsonb_build_object('days', v_days, 'orgs', v_orgs,
    'slowest', (select coalesce(jsonb_agg(x order by (x ->> 'p75')::numeric desc nulls last), '[]') from (select x from jsonb_array_elements(v_places) x where x ->> 'p75' is not null order by (x ->> 'p75')::numeric desc limit 15) s),
    'failing', (select coalesce(jsonb_agg(x order by (x ->> 'errors')::numeric desc), '[]') from (select x from jsonb_array_elements(v_places) x where (x ->> 'errors')::numeric > 0 order by (x ->> 'errors')::numeric desc limit 15) s));
end $$;
revoke all on function pulse.platform_telemetry(int) from public;
grant execute on function pulse.platform_telemetry(int) to pulse_api;

-- AI spend: tokens by organisation and by engine/model, from AI employee runs, group summaries and product map reads.
create function pulse.platform_ai_spend(p_days int) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o record; v_days int := least(greatest(coalesce(p_days, 30), 1), 365); v_since timestamptz; v_rows jsonb := '[]'; v_part jsonb;
begin
  perform platform_guard();
  v_since := now() - make_interval(days => v_days);
  for o in select id, name from org order by name loop
    perform platform_enter(o.id);
    select coalesce(jsonb_agg(jsonb_build_object('orgId', o.id, 'org', o.name, 'source', source, 'engine', engine, 'runs', runs, 'tokensIn', tin, 'tokensOut', tout, 'failed', failed)), '[]')
      into v_part from (
        select 'AI employees' source, coalesce(engine, model, 'unknown') engine, count(*) runs, sum(coalesce(tokens_in, 0)) tin,
               sum(coalesce(tokens_out, 0) + case when coalesce(tokens_in, 0) + coalesce(tokens_out, 0) = 0 then coalesce(tokens, 0) else 0 end) tout,
               count(*) filter (where state = 'error') failed
          from agent_run where org_id = o.id and started_at >= v_since group by 2
        union all
        select 'Group summaries', coalesce(engine, 'unknown'), count(*), sum(coalesce(tokens_in, 0)), sum(coalesce(tokens_out, 0)), count(*) filter (where status in ('error', 'failed'))
          from chat_group_ai_job where org_id = o.id and created_at >= v_since group by 2
        union all
        select 'Product map', coalesce(engine, 'unknown'), count(*), sum(coalesce(tokens_in, 0)), sum(coalesce(tokens_out, 0)), count(*) filter (where status in ('error', 'failed'))
          from product_map_ai_job where org_id = o.id and created_at >= v_since group by 2) s;
    perform platform_leave();
    v_rows := v_rows || v_part;
  end loop;
  return jsonb_build_object('days', v_days, 'rows', v_rows);
end $$;
revoke all on function pulse.platform_ai_spend(int) from public;
grant execute on function pulse.platform_ai_spend(int) to pulse_api;

-- Integrations: Sign in with Pulse apps (install-level; never their secrets), and per organisation its AI connections
-- and company connectors.
create function pulse.platform_integrations() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o record; v_orgs jsonb := '[]'; v_part jsonb;
begin
  perform platform_guard();
  for o in select id, name from org order by name loop
    perform platform_enter(o.id);
    select jsonb_build_object('id', o.id, 'name', o.name,
        'ai', (select coalesce(jsonb_agg(jsonb_build_object('name', c.name, 'provider', c.provider, 'kind', c.kind, 'state', c.state, 'cap', c.monthly_token_cap, 'checkedAt', c.checked_at) order by c.created_at), '[]')
                 from ai_connection c where c.org_id = o.id and c.removed_at is null),
        'connectors', (select coalesce(jsonb_agg(jsonb_build_object('label', i.label, 'key', i.connector_key, 'status', i.status, 'lastBatchAt', i.last_batch_at) order by i.created_at), '[]')
                 from connector_install i where i.org_id = o.id and i.revoked_at is null))
      into v_part;
    perform platform_leave();
    if jsonb_array_length(v_part -> 'ai') + jsonb_array_length(v_part -> 'connectors') > 0 then v_orgs := v_orgs || jsonb_build_array(v_part); end if;
  end loop;
  return jsonb_build_object('orgs', v_orgs,
    'apps', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'clientId', a.client_id, 'name', a.name, 'maker', a.maker, 'homeUrl', a.home_url,
        'scopes', a.scopes, 'development', a.development, 'verified', a.verified, 'status', a.status, 'org', g.name, 'createdAt', a.created_at,
        'lastUsedAt', a.last_used_at, 'redirects', coalesce(array_length(a.redirect_uris, 1), 0)) order by a.created_at desc), '[]')
      from pulse_priv.oidc_app a left join org g on g.id = a.created_org));
end $$;
revoke all on function pulse.platform_integrations() from public;
grant execute on function pulse.platform_integrations() to pulse_api;

-- migrate:down
drop function pulse.platform_integrations();
drop function pulse.platform_ai_spend(int);
drop function pulse.platform_telemetry(int);
drop function pulse.platform_feedback();
drop function pulse.platform_bugs(text, text);
drop function pulse.platform_releases();
drop function pulse.platform_release_seen(text, text);
drop table pulse_priv.platform_release;
