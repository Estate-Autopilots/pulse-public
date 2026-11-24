-- migrate:up
-- NO-DATA-LOSS (owner RED ALERT, 20 Nov 2026): "No data should be deleted. Not the call logs, not the recordings,
-- nothing... they need it for comparing months and weeks." No sweep or TTL physically removes business history any
-- more. Each function below is its latest definition with only the time-based deletes taken out:
--   chat_prune      (1051): messages, their files and chat events older than 365 days were deleted; now only an upload
--                           that was never attached to any message (abandoned, older than a day) is cleared.
--   connect_due     (1115): the change feed and connected apps' call log (90 days) and delivered webhook events
--                           (30 days) were deleted every minute; now kept.
--   focus_ingest    (1845): AI account readings older than 35 days were deleted on every ingest; now kept.
--   chat_call_note  (1061): call quality notes older than 180 days were deleted; now kept.
--   listen_purge    (1685): listening sessions (transcript, events) and the transcript copies in the AI employee's chat
--                           went after the company's days (30 by default); now kept. Idle live sessions still stop.
-- Kept as they were (not business data): expiring sign-in codes, tokens, OAuth/OIDC attempts, passkey challenges,
-- caches, idempotency keys and the webhook outbox. A person's own delete (a message, a recording, a session) and a
-- privacy erasure request are unchanged. Daily privacy retention (privacy.redact_expired, drop_expired_ephemeral and
-- the raw_inbox purge) is no longer scheduled by the worker (services/workers scheduler.py).
-- Undo: re-apply the definitions from the migrations named above.

create or replace function pulse.chat_prune() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 -- An upload never attached to any message (abandoned in the composer) is temporary, not history.
 delete from pulse_priv.chat_file f where f.created_at<now()-interval '1 day' and not exists(select 1 from chat_message m where m.attachments @> jsonb_build_array(jsonb_build_object('id',f.id::text)));
 -- NO-DATA-LOSS: messages, their files and chat events are kept whatever their age.
 return 0;
end $$;

create or replace function pulse.connect_due(p_limit int default 50) returns jsonb
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
  -- NO-DATA-LOSS: the change feed, delivered events and the connected apps' call log are kept (they were deleted after
  -- 90, 30 and 90 days).
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

create or replace function pulse.focus_ingest(p_hash text, p jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_org uuid; a jsonb; s jsonb; l jsonb; v_acc uuid; n int := 0; m int := 0; v_plan_due boolean;
begin
  select org_id into v_org from pulse_priv.focus_ingest_key where hash = p_hash;
  if v_org is null then raise exception 'Unknown ingest key' using errcode = '28000'; end if;
  perform set_config('pulse.org_id', v_org::text, true);
  update focus_settings set ingest_at = now() where org_id = v_org;
  for s in select * from jsonb_array_elements(coalesce(p->'samples', '[]'::jsonb)) limit 500 loop
    select id into v_acc from focus_account where org_id = v_org and key = s->>'account';
    if v_acc is null then continue; end if;
    insert into focus_sample(org_id, account_id, at, win, used_pct, resets_at, amount, currency, company, source)
    values (v_org, v_acc, coalesce(nullif(s->>'at', '')::timestamptz, now()), s->>'window',
      least(100, greatest(0, nullif(s->>'usedPct', '')::numeric)), nullif(s->>'resetsAt', '')::timestamptz,
      nullif(s->>'amount', '')::numeric, nullif(s->>'currency', ''), nullif(s->>'company', ''), left(coalesce(s->>'source', 'collector'), 40));
    if s->>'status' in ('ok', 'limited') then update focus_account set status = s->>'status' where id = v_acc and status <> 'off'; end if;
    n := n + 1;
  end loop;
  for l in select * from jsonb_array_elements(coalesce(p->'lanes', '[]'::jsonb)) limit 100 loop
    insert into focus_lane(org_id, key, title, company, status, account, blocked_by, updated_at)
    values (v_org, l->>'key', left(coalesce(nullif(l->>'title', ''), l->>'key'), 160), coalesce(nullif(l->>'company', ''), 'vitals'),
      coalesce(nullif(l->>'status', ''), 'running'), nullif(l->>'account', ''), nullif(left(l->>'blockedBy', 160), ''), now())
    on conflict (org_id, key) do update set status = excluded.status, account = coalesce(excluded.account, focus_lane.account),
      blocked_by = excluded.blocked_by, updated_at = now();
    m := m + 1;
  end loop;
  -- NO-DATA-LOSS: readings are kept whatever their age (they were dropped after 35 days; the burn graph reads 7).
  -- the company's own clock (pulse.org_time_zone, 0179): 08:30 there, once a day there
  v_plan_due := (now() at time zone pulse.org_time_zone(v_org))::time >= time '08:30'
    and not exists (select 1 from focus_plan where org_id = v_org and day = (now() at time zone pulse.org_time_zone(v_org))::date);
  return jsonb_build_object('org', v_org, 'samples', n, 'lanes', m, 'planDue', v_plan_due);
end $$;

create or replace function pulse.chat_call_note(p_call uuid,p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k text:=p->>'kind'; n int; c chat_call;
 int_of constant text:='^[0-9]{1,9}$';
begin
 if current_viewer() is null or jsonb_typeof(p) is distinct from 'object' or k is null or k not in ('setup','end','failure','reconnect') then raise exception 'invalid note' using errcode='22023'; end if;
 if p_call is not null then
  select * into c from chat_call where org_id=current_org() and id=p_call;
  if not found or not exists(select 1 from chat_call_party where call_id=p_call and person_id=current_viewer()) then raise exception 'call unavailable' using errcode='42501'; end if;
  select count(*) into n from chat_call_quality where org_id=current_org() and call_id=p_call and person_id=current_viewer();
 else
  if k<>'failure' then raise exception 'invalid note' using errcode='22023'; end if;
  select count(*) into n from chat_call_quality where org_id=current_org() and call_id is null and person_id=current_viewer() and at>clock_timestamp()-interval '1 hour';
 end if;
 if n>=40 then return; end if;
 insert into chat_call_quality(org_id,call_id,person_id,kind,role,video,setup_ms,media_ms,path,rtt_ms,jitter_ms,loss_pct,reconnects,restarts,seconds,peers,reason,network,platform,device,relay_offered,relay_gathered)
 values(current_org(),p_call,current_viewer(),k,
  case when p->>'role' in ('caller','callee','joiner') then p->>'role' end,
  case when jsonb_typeof(p->'video')='boolean' then (p->>'video')::boolean end,
  case when p->>'setupMs' ~ int_of then least((p->>'setupMs')::int,600000) end,
  case when p->>'mediaMs' ~ int_of then least((p->>'mediaMs')::int,600000) end,
  case when p->>'path' in ('host','srflx','prflx','relay-udp','relay-tcp','relay-tls','unknown') then p->>'path' end,
  case when p->>'rttMs' ~ int_of then least((p->>'rttMs')::int,60000) end,
  case when p->>'jitterMs' ~ int_of then least((p->>'jitterMs')::int,60000) end,
  case when jsonb_typeof(p->'lossPct')='number' then least(100,greatest(0,round((p->>'lossPct')::numeric,2))) end,
  case when p->>'reconnects' ~ int_of then least((p->>'reconnects')::int,1000) end,
  case when p->>'restarts' ~ int_of then least((p->>'restarts')::int,1000) end,
  case when p->>'seconds' ~ int_of then least((p->>'seconds')::int,86400) end,
  case when p->>'peers' ~ '^[0-8]$' then (p->>'peers')::smallint end,
  case when p->>'reason' ~ '^[a-z][a-z-]{1,30}$' then p->>'reason' end,
  case when p->>'network' ~ '^[a-z0-9-]{1,20}$' then p->>'network' end,
  case when p->>'platform' in ('web','android','ios','desktop') then p->>'platform' end,
  case when p->>'device' in ('phone','tablet','desktop') then p->>'device' end,
  case when jsonb_typeof(p->'relayOffered')='boolean' then (p->>'relayOffered')::boolean end,
  case when jsonb_typeof(p->'relayGathered')='boolean' then (p->>'relayGathered')::boolean end);
 -- A one-to-one call whose media never connected says so in the chat (the note may come before or after the hang-up).
 if k='failure' and p->>'reason'='no-connect' and c.id is not null and c.state='ended' and c.end_reason='completed' then
  perform chat_call_line(c.id); perform chat_call_touch(c.id);
 end if;
 -- NO-DATA-LOSS: notes are kept whatever their age (they were deleted after 180 days).
end $$;

create or replace function pulse.listen_purge() returns int
language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  -- NO-DATA-LOSS: sessions, their transcripts and the copies in the AI employee's chat are kept (they went after the
  -- company's listening days). A person's own delete (pulse.listen_delete) is unchanged.
  -- A session left live with nothing coming for an hour is stopped.
  update listen_session s set stopped_at = clock_timestamp() where org_id = current_org() and stopped_at is null
     and started_at < clock_timestamp() - interval '1 hour'
     and not exists (select 1 from pulse_priv.listen_chunk k where k.session_id = s.id and k.created_at > clock_timestamp() - interval '1 hour');
  return 0;
end $$;

-- migrate:down
-- Forward-only: nothing is removed by retention any more.
