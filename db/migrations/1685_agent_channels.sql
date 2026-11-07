-- migrate:up
-- AGENT-CHANNELS (6 Nov 2026): every AI employee reachable on more channels, and an always-on listening mode.
-- Builds on ONBOARD-CHECKIN-TG (1598: link codes, telegram_person, telegram_agent_link, the Vitals OS bot).
--
-- 1. Company settings (pulse.agent_channel_settings, one row per company, admins change it):
--    * Telegram: the shared Vitals OS bot, or the company's own bot (its token is a file on the server, never here).
--    * WhatsApp: the company's WhatsApp Business number on Meta's official Cloud API (credentials are server files).
--    * Listening: off until an admin opts the company in; how many days transcripts are kept (1 to 365).
--    * The bot workers say they are alive (telegram_seen_at / whatsapp_seen_at), so Pulse can show "waiting for the
--      token" until one runs, without the API ever holding the token.
-- 2. Telegram "/agent <name>": a linked chat switches which AI employee it talks to (as the person; chat_direct decides).
-- 3. WhatsApp: a person attaches their WhatsApp to an AI employee with a one-time code (the 1598 code table, channel
--    'whatsapp'); what they write goes into their direct chat with it (as them) and its replies go back through the
--    channel outbox, only inside WhatsApp's 24-hour reply window. Nothing is sent from the database.
-- 4. Listening: a person starts a session (consent confirmed, the company opted in), the browser sends short audio
--    pieces, the server's own Whisper (tools/listen-transcribe.py) writes the transcript, and the chosen AI employee gets
--    the new part in its direct chat with that person, so it reacts with its usual tools (draft a quotation, flag a
--    requirement, create a task). Audio is deleted once transcribed; transcripts go after the company's retention.
--    pulse.listen_event is the hook other flows connect to (listen.started / listen.window / listen.stopped, with a
--    NOTIFY on pulse_listen), e.g. Willow Lane's quotation flow for a session whose purpose is 'quotation'.

-- ------------------------------------------------------------------------------------------------------ settings
create table pulse.agent_channel_settings (
  org_id uuid primary key references pulse.org(id),
  telegram_bot text not null default 'shared' check (telegram_bot in ('shared', 'own')),
  telegram_own_username text check (telegram_own_username is null or telegram_own_username ~* '^[a-z][a-z0-9_]{3,31}bot$'),
  telegram_seen_at timestamptz,
  telegram_seen_bot text check (telegram_seen_bot is null or telegram_seen_bot ~* '^[a-z][a-z0-9_]{3,31}bot$'),
  whatsapp_on boolean not null default false,
  whatsapp_seen_at timestamptz,
  whatsapp_number text check (whatsapp_number is null or whatsapp_number ~ '^[1-9][0-9]{6,15}$'),
  listen_on boolean not null default false,
  listen_retention_days int not null default 30 check (listen_retention_days between 1 and 365),
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default clock_timestamp()
);
alter table pulse.agent_channel_settings enable row level security;
alter table pulse.agent_channel_settings force row level security;
create policy tenant_isolation on pulse.agent_channel_settings using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create trigger audit_mutation after insert or update or delete on pulse.agent_channel_settings for each row execute function pulse.audit_mutation();

create function pulse.agent_channels_settings() returns jsonb
language plpgsql security definer stable set search_path = pulse, pg_temp as $$
declare s agent_channel_settings; fresh interval := interval '10 minutes';
begin
  if current_viewer() is null then raise exception 'Use your own Vitals account' using errcode = '42501'; end if;
  select * into s from agent_channel_settings where org_id = current_org();
  return jsonb_build_object(
    'canEdit', coalesce(current_setting('pulse.agent_session', true), '') <> 'on' and viewer_is('admin'),
    'telegram', jsonb_build_object('bot', coalesce(s.telegram_bot, 'shared'), 'ownUsername', s.telegram_own_username,
      'running', coalesce(s.telegram_seen_at > clock_timestamp() - fresh, false), 'runningBot', s.telegram_seen_bot),
    'whatsapp', jsonb_build_object('on', coalesce(s.whatsapp_on, false),
      'running', coalesce(s.whatsapp_seen_at > clock_timestamp() - fresh, false), 'number', s.whatsapp_number),
    'listen', jsonb_build_object('on', coalesce(s.listen_on, false), 'retentionDays', coalesce(s.listen_retention_days, 30)));
end $$;

create function pulse.agent_channels_settings_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); days int;
begin
  if me is null or coalesce(current_setting('pulse.agent_session', true), '') = 'on' or not viewer_is('admin') then
    raise exception 'Admins set how AI employees are reached' using errcode = '42501';
  end if;
  if p ? 'listenRetentionDays' then
    days := (p->>'listenRetentionDays')::int;
    if days is null or days not between 1 and 365 then raise exception 'Keep transcripts between 1 and 365 days' using errcode = '22023'; end if;
  end if;
  if p ? 'telegramBot' and coalesce(p->>'telegramBot', '') not in ('shared', 'own') then raise exception 'Choose the shared bot or your own' using errcode = '22023'; end if;
  if nullif(p->>'telegramOwnUsername', '') is not null and (p->>'telegramOwnUsername') !~* '^@?[a-z][a-z0-9_]{3,31}bot$' then
    raise exception 'A Telegram bot username ends in "bot"' using errcode = '22023';
  end if;
  insert into agent_channel_settings (org_id) values (current_org()) on conflict (org_id) do nothing;
  update agent_channel_settings set
    telegram_bot = coalesce(p->>'telegramBot', telegram_bot),
    telegram_own_username = case when p ? 'telegramOwnUsername' then nullif(ltrim(p->>'telegramOwnUsername', '@'), '') else telegram_own_username end,
    whatsapp_on = coalesce((p->>'whatsappOn')::boolean, whatsapp_on),
    listen_on = coalesce((p->>'listenOn')::boolean, listen_on),
    listen_retention_days = coalesce(days, listen_retention_days),
    updated_by = me, updated_at = clock_timestamp()
  where org_id = current_org();
  -- A shorter retention applies to what is already kept.
  if days is not null then
    update listen_session set purge_after = least(purge_after, started_at + make_interval(days => days)) where org_id = current_org();
  end if;
  return agent_channels_settings();
end $$;

-- The bot workers: "this company's bot is running" (the shared bot for every company it serves; a company's own bot for
-- its company), and for WhatsApp the business number people write to (digits only, shown as a wa.me link).
create function pulse.agent_channel_heartbeat(p_kind text, p_name text) returns void
language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  insert into agent_channel_settings (org_id) values (current_org()) on conflict (org_id) do nothing;
  if p_kind = 'telegram' then
    update agent_channel_settings set telegram_seen_at = clock_timestamp(),
      telegram_seen_bot = case when p_name ~* '^[a-z][a-z0-9_]{3,31}bot$' then p_name else telegram_seen_bot end where org_id = current_org();
  elsif p_kind = 'whatsapp' then
    update agent_channel_settings set whatsapp_seen_at = clock_timestamp(),
      whatsapp_number = case when p_name ~ '^[1-9][0-9]{6,15}$' then p_name else whatsapp_number end where org_id = current_org();
  end if;
end $$;

-- Which companies the shared bot serves (not those with their own bot), and which company has its own bot.
create function pulse.agent_channel_telegram_mode() returns text
language sql security definer stable set search_path = pulse, pg_temp as $$
  select coalesce((select telegram_bot from agent_channel_settings where org_id = current_org()), 'shared')
$$;

-- A person's WhatsApp number attached to an AI employee (one AI employee at a time per number in a company).
alter table pulse_priv.telegram_link_code
  add column if not exists channel text not null default 'telegram' check (channel in ('telegram', 'whatsapp'));

create table pulse_priv.whatsapp_agent_link (
  org_id uuid not null references pulse.org(id),
  person_id uuid not null references pulse.person(id),
  agent_id uuid not null references pulse.person(id),
  wa_id text not null check (wa_id ~ '^[1-9][0-9]{6,15}$'),
  channel_id uuid not null,
  linked_at timestamptz not null default clock_timestamp(),
  relayed_until timestamptz not null default clock_timestamp(),
  last_inbound_at timestamptz not null default clock_timestamp(),
  primary key (org_id, wa_id)
);
create index whatsapp_agent_link_person on pulse_priv.whatsapp_agent_link(org_id, person_id);
alter table pulse_priv.whatsapp_agent_link enable row level security;
alter table pulse_priv.whatsapp_agent_link force row level security;
create policy tenant_isolation on pulse_priv.whatsapp_agent_link using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create trigger audit_mutation after insert or update or delete on pulse_priv.whatsapp_agent_link for each row execute function pulse.audit_mutation();

-- ------------------------------------------------------------------------------------------- Telegram: /agent switch
-- The AI employees a linked chat's person can message (a person linked with /start, or a chat attached to one already).
create function pulse.channel_person(p_channel text, p_ref text) returns uuid
language sql security definer stable set search_path = pulse, pg_temp as $$
  select coalesce(
    case when p_channel = 'telegram' then
      coalesce((select t.person_id from pulse_priv.telegram_person t where t.org_id = current_org() and t.chat_id = p_ref),
               (select l.person_id from pulse_priv.telegram_agent_link l where l.org_id = current_org() and l.chat_id = p_ref))
    else (select w.person_id from pulse_priv.whatsapp_agent_link w where w.org_id = current_org() and w.wa_id = p_ref) end,
    null::uuid)
$$;

create function pulse.channel_agent_choices(p_channel text, p_ref text) returns jsonb
language plpgsql security definer stable set search_path = pulse, pg_temp as $$
declare me uuid := channel_person(p_channel, p_ref); cur uuid;
begin
  if me is null or not exists (select 1 from person where id = me and status = 'active') then return null; end if;
  cur := case when p_channel = 'telegram' then (select agent_id from pulse_priv.telegram_agent_link where org_id = current_org() and chat_id = p_ref)
              else (select agent_id from pulse_priv.whatsapp_agent_link where org_id = current_org() and wa_id = p_ref) end;
  return jsonb_build_object('current', (select display_name from person where id = cur), 'agents', coalesce((
    select jsonb_agg(jsonb_build_object('name', p.display_name, 'username', pp.username) order by p.display_name)
      from agent_member m join person p on p.id = m.person_id left join people_profile pp on pp.person_id = p.id and pp.org_id = m.org_id
     where m.org_id = current_org() and m.disabled_at is null and p.status = 'active'), '[]'::jsonb));
end $$;

-- Switch the chat to another AI employee, chosen by its username or the start of its name (as the person: chat_direct
-- refuses an AI employee they may not message).
create function pulse.channel_agent_switch(p_channel text, p_ref text, p_name text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := channel_person(p_channel, p_ref); want text := lower(btrim(coalesce(p_name, ''), ' @')); a uuid; aname text; ch uuid; n int;
begin
  if me is null or not exists (select 1 from person where id = me and status = 'active') then return jsonb_build_object('error', 'not_linked'); end if;
  if want = '' then return jsonb_build_object('error', 'no_name'); end if;
  select count(*), min(p.id::text)::uuid into n, a
    from agent_member m join person p on p.id = m.person_id left join people_profile pp on pp.person_id = p.id and pp.org_id = m.org_id
   where m.org_id = current_org() and m.disabled_at is null and p.status = 'active'
     and (lower(pp.username) = want or lower(p.display_name) = want);
  if n = 0 then
    select count(*), min(p.id::text)::uuid into n, a
      from agent_member m join person p on p.id = m.person_id
     where m.org_id = current_org() and m.disabled_at is null and p.status = 'active' and lower(p.display_name) like want || '%';
  end if;
  if n = 0 then return jsonb_build_object('error', 'unknown'); end if;
  if n > 1 then return jsonb_build_object('error', 'ambiguous'); end if;
  perform set_config('pulse.viewer_id', me::text, true);
  begin
    ch := chat_direct(a);
  exception when others then
    return jsonb_build_object('error', 'not_allowed');
  end;
  select display_name into aname from person where id = a;
  if p_channel = 'telegram' then
    delete from pulse_priv.telegram_agent_link where org_id = current_org() and chat_id = p_ref;
    insert into pulse_priv.telegram_agent_link (org_id, person_id, agent_id, chat_id, channel_id) values (current_org(), me, a, p_ref, ch)
    on conflict (org_id, person_id, agent_id) do update set chat_id = excluded.chat_id, channel_id = excluded.channel_id,
      linked_at = clock_timestamp(), relayed_until = clock_timestamp();
  else
    update pulse_priv.whatsapp_agent_link set agent_id = a, channel_id = ch, linked_at = clock_timestamp(), relayed_until = clock_timestamp()
     where org_id = current_org() and wa_id = p_ref;
  end if;
  return jsonb_build_object('agent', aname);
end $$;

-- ------------------------------------------------------------------------------------------------------- WhatsApp
-- What goes out on a channel: written by the database, sent only by the channel worker (which alone holds the token).
create table pulse_priv.channel_outbox (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('whatsapp')),
  ref text not null check (ref ~ '^[1-9][0-9]{6,15}$'),
  body text not null check (length(body) between 1 and 4096),
  created_at timestamptz not null default clock_timestamp(),
  attempts int not null default 0,
  sent_at timestamptz,
  given_up_at timestamptz
);
create index channel_outbox_due on pulse_priv.channel_outbox(org_id, created_at) where sent_at is null and given_up_at is null;
alter table pulse_priv.channel_outbox enable row level security;
alter table pulse_priv.channel_outbox force row level security;
create policy tenant_isolation on pulse_priv.channel_outbox using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

create function pulse.whatsapp_link_begin(p_hash text, p_agent uuid) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); exp timestamptz;
begin
  if me is null or coalesce(current_setting('pulse.agent_session', true), '') = 'on'
     or not exists (select 1 from person where id = me and org_id = current_org() and status = 'active' and side = 'staff') then
    raise exception 'Use your own Vitals account' using errcode = '42501';
  end if;
  if p_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid code' using errcode = '22023'; end if;
  if not coalesce((select whatsapp_on from agent_channel_settings where org_id = current_org()), false) then
    raise exception 'WhatsApp is not connected for this company yet' using errcode = '54000';
  end if;
  if p_agent is null or not exists (select 1 from agent_member m join person p on p.id = m.person_id
                 where m.org_id = current_org() and m.person_id = p_agent and m.disabled_at is null and p.status = 'active') then
    raise exception 'Choose an active AI employee' using errcode = '22023';
  end if;
  perform chat_direct(p_agent);
  if (select count(*) from pulse_priv.telegram_link_code where org_id = current_org() and person_id = me and created_at > clock_timestamp() - interval '1 hour') >= 10 then
    raise exception 'Too many link codes. Try again in an hour.' using errcode = '54000';
  end if;
  update pulse_priv.telegram_link_code set used_at = clock_timestamp()
   where org_id = current_org() and person_id = me and channel = 'whatsapp' and agent_id = p_agent and used_at is null;
  insert into pulse_priv.telegram_link_code (org_id, person_id, agent_id, code_hash, channel) values (current_org(), me, p_agent, p_hash, 'whatsapp')
  returning expires_at into exp;
  return jsonb_build_object('expiresAt', exp);
end $$;

create function pulse.whatsapp_link_status() returns jsonb
language sql security definer stable set search_path = pulse, pg_temp as $$
  select jsonb_build_object('agents', coalesce((select jsonb_agg(jsonb_build_object('agentId', w.agent_id, 'name', p.display_name, 'at', w.linked_at,
      'number', '…' || right(w.wa_id, 4)) order by w.linked_at)
    from pulse_priv.whatsapp_agent_link w join person p on p.id = w.agent_id where w.org_id = current_org() and w.person_id = current_viewer()), '[]'::jsonb))
$$;

create function pulse.whatsapp_unlink(p_agent uuid default null) returns void
language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is null then raise exception 'Use your own Vitals account' using errcode = '42501'; end if;
  delete from pulse_priv.whatsapp_agent_link where org_id = current_org() and person_id = current_viewer() and (p_agent is null or agent_id = p_agent);
end $$;

-- The WhatsApp webhook (the API, after checking Meta's signature): one incoming text from a WhatsApp user. A link code
-- ("link ABCD234567") attaches the number; "/agent <name>" switches; anything else goes into the direct chat as the person.
-- Returns what to answer (queued in the outbox) or null.
create function pulse.whatsapp_inbound(p_wa text, p_text text, p_code_hash text default null) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k pulse_priv.telegram_link_code; l pulse_priv.whatsapp_agent_link; ch uuid; aname text; reply text; r jsonb; t text := btrim(coalesce(p_text, ''));
begin
  if p_wa !~ '^[1-9][0-9]{6,15}$' or t = '' then return null; end if;
  if not coalesce((select whatsapp_on from agent_channel_settings where org_id = current_org()), false) then return null; end if;
  if p_code_hash ~ '^[0-9a-f]{64}$' then
    select * into k from pulse_priv.telegram_link_code where org_id = current_org() and code_hash = p_code_hash and channel = 'whatsapp' for update;
    if found then
      if k.used_at is not null or k.expires_at <= clock_timestamp() then
        reply := 'That code has expired. Make a new one on the AI employee''s page in Vitals.';
      elsif not exists (select 1 from person where id = k.person_id and status = 'active') then
        reply := 'That code can''t be used.';
      else
        update pulse_priv.telegram_link_code set used_at = clock_timestamp() where id = k.id;
        perform set_config('pulse.viewer_id', k.person_id::text, true);
        ch := chat_direct(k.agent_id);
        select display_name into aname from person where id = k.agent_id;
        delete from pulse_priv.whatsapp_agent_link where org_id = current_org() and wa_id = p_wa;
        insert into pulse_priv.whatsapp_agent_link (org_id, person_id, agent_id, wa_id, channel_id) values (current_org(), k.person_id, k.agent_id, p_wa, ch);
        reply := 'Linked. Write here to talk to ' || aname || '; its replies come back here. Send /agent to see or switch AI employees.';
      end if;
      insert into pulse_priv.channel_outbox (org_id, channel, ref, body) values (current_org(), 'whatsapp', p_wa, reply);
      return jsonb_build_object('kind', 'link', 'ok', reply like 'Linked%');
    end if;
  end if;
  select * into l from pulse_priv.whatsapp_agent_link where org_id = current_org() and wa_id = p_wa;
  if not found then
    -- An unknown number gets nothing back (a business number must not answer strangers on an AI employee's behalf).
    return jsonb_build_object('kind', 'unknown');
  end if;
  update pulse_priv.whatsapp_agent_link set last_inbound_at = clock_timestamp() where org_id = current_org() and wa_id = p_wa;
  if lower(t) ~ '^/agents?(\s|$)' then
    if btrim(substr(t, length(split_part(t, ' ', 1)) + 1)) = '' then
      r := channel_agent_choices('whatsapp', p_wa);
      reply := 'You are talking to ' || coalesce(r->>'current', 'nobody yet') || '. Switch with /agent <name>: '
        || coalesce((select string_agg(x->>'name', ', ') from jsonb_array_elements(r->'agents') x), 'no AI employees');
    else
      r := channel_agent_switch('whatsapp', p_wa, substr(t, length(split_part(t, ' ', 1)) + 1));
      reply := case when r ? 'agent' then 'Now talking to ' || (r->>'agent') || '.'
                    when r->>'error' = 'ambiguous' then 'More than one AI employee matches. Use its username.'
                    when r->>'error' = 'not_allowed' then 'You can''t message that AI employee.'
                    else 'No AI employee by that name. Send /agent to see the list.' end;
    end if;
    insert into pulse_priv.channel_outbox (org_id, channel, ref, body) values (current_org(), 'whatsapp', p_wa, left(reply, 4000));
    return jsonb_build_object('kind', 'command');
  end if;
  if not exists (select 1 from person where id = l.person_id and status = 'active') then return null; end if;
  perform set_config('pulse.viewer_id', l.person_id::text, true);
  perform chat_send(l.channel_id, left(t, 4000), null, '[]'::jsonb, gen_random_uuid());
  update pulse_priv.whatsapp_agent_link set relayed_until = greatest(relayed_until, clock_timestamp()) where org_id = current_org() and wa_id = p_wa;
  return jsonb_build_object('kind', 'message');
end $$;

-- The worker: AI employees' new replies for WhatsApp chats go into the outbox (only within 24 hours of the person's
-- last message: WhatsApp's reply window; later replies stay in Vitals), then the due outbox rows are handed out.
create function pulse.whatsapp_outbound_claim(p_limit int default 20) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare l pulse_priv.whatsapp_agent_link; last timestamptz; out jsonb;
begin
  for l in select * from pulse_priv.whatsapp_agent_link where org_id = current_org() for update loop
    insert into pulse_priv.channel_outbox (org_id, channel, ref, body)
    select current_org(), 'whatsapp', l.wa_id, left(p.display_name || ': ' || m.body, 4000)
      from (select * from chat_message where org_id = current_org() and channel_id = l.channel_id and author_id = l.agent_id
              and created_at > l.relayed_until and removed_at is null and coalesce(btrim(body), '') <> '' order by created_at limit 10) m
      join person p on p.id = l.agent_id
     where l.last_inbound_at > clock_timestamp() - interval '24 hours';
    select max(created_at) into last from chat_message where org_id = current_org() and channel_id = l.channel_id and author_id = l.agent_id and created_at > l.relayed_until;
    if last is not null then update pulse_priv.whatsapp_agent_link set relayed_until = last where org_id = l.org_id and wa_id = l.wa_id; end if;
  end loop;
  with due as (
    select id from pulse_priv.channel_outbox where org_id = current_org() and sent_at is null and given_up_at is null
     order by created_at limit greatest(1, least(coalesce(p_limit, 20), 50)) for update skip locked),
  took as (update pulse_priv.channel_outbox o set attempts = o.attempts + 1 from due where o.id = due.id returning o.id, o.ref, o.body, o.created_at)
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'to', ref, 'body', body) order by created_at), '[]'::jsonb) into out from took;
  return out;
end $$;

create function pulse.channel_outbox_done(p_id uuid, p_ok boolean) returns void
language sql security definer set search_path = pulse, pg_temp as $$
  update pulse_priv.channel_outbox set sent_at = case when p_ok then clock_timestamp() end,
    given_up_at = case when not p_ok and attempts >= 3 then clock_timestamp() end
   where org_id = current_org() and id = p_id and sent_at is null
$$;

-- ------------------------------------------------------------------------------------------------------ listening
create table pulse.listen_session (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references pulse.person(id),
  agent_id uuid references pulse.person(id),
  channel_id uuid,
  title text not null check (length(btrim(title)) between 1 and 120 and title !~ '[[:cntrl:]]'),
  purpose text not null default 'general' check (purpose in ('general', 'quotation', 'requirements', 'meeting')),
  consent_at timestamptz not null,
  started_at timestamptz not null default clock_timestamp(),
  stopped_at timestamptz,
  forwarded_seq int not null default -1,
  forwarded_at timestamptz,
  final_at timestamptz,
  purge_after timestamptz not null,
  unique (org_id, id)
);
create index listen_session_person on pulse.listen_session(org_id, person_id, started_at desc);
create index listen_session_purge on pulse.listen_session(purge_after);
alter table pulse.listen_session enable row level security;
alter table pulse.listen_session force row level security;
create policy tenant_isolation on pulse.listen_session using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

create table pulse_priv.listen_chunk (
  org_id uuid not null references pulse.org(id),
  session_id uuid not null references pulse.listen_session(id) on delete cascade,
  seq int not null check (seq between 0 and 100000),
  mime text not null check (mime ~ '^audio/(webm|ogg|mp4|wav|x-wav|mpeg)(;.*)?$'),
  ms int not null check (ms between 0 and 120000),
  bytes bytea check (bytes is null or octet_length(bytes) <= 4194304),
  state text not null default 'queued' check (state in ('queued', 'working', 'done', 'failed')),
  attempts int not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  primary key (session_id, seq)
);
create index listen_chunk_due on pulse_priv.listen_chunk(org_id, created_at) where state = 'queued';
alter table pulse_priv.listen_chunk enable row level security;
alter table pulse_priv.listen_chunk force row level security;
create policy tenant_isolation on pulse_priv.listen_chunk using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

create table pulse.listen_segment (
  org_id uuid not null references pulse.org(id),
  session_id uuid not null references pulse.listen_session(id) on delete cascade,
  seq int not null,
  part int not null,
  start_ms int not null,
  end_ms int not null,
  text text not null check (length(text) <= 4000),
  created_at timestamptz not null default clock_timestamp(),
  primary key (session_id, seq, part)
);
alter table pulse.listen_segment enable row level security;
alter table pulse.listen_segment force row level security;
create policy tenant_isolation on pulse.listen_segment using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

create table pulse.listen_event (
  org_id uuid not null references pulse.org(id),
  seq bigint generated always as identity primary key,
  session_id uuid not null references pulse.listen_session(id) on delete cascade,
  type text not null check (type in ('listen.started', 'listen.window', 'listen.stopped')),
  data jsonb not null default '{}',
  at timestamptz not null default clock_timestamp()
);
create index listen_event_org on pulse.listen_event(org_id, seq);
alter table pulse.listen_event enable row level security;
alter table pulse.listen_event force row level security;
create policy tenant_isolation on pulse.listen_event using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

-- The hook: every listening event is announced on pulse_listen (payload: org, seq, type, session) for a worker that
-- LISTENs; the rows themselves are read with listen_events(after) inside the company.
create function pulse.listen_event_notify() returns trigger language plpgsql as $$
begin
  perform pg_notify('pulse_listen', json_build_object('org', new.org_id, 'seq', new.seq, 'type', new.type, 'session', new.session_id)::text);
  return new;
end $$;
create trigger listen_event_notify after insert on pulse.listen_event for each row execute function pulse.listen_event_notify();

create function pulse.listen_can_see(s pulse.listen_session) returns boolean
language sql stable security definer set search_path = pulse, pg_temp as $$
  select current_viewer() is not null and (s.person_id = current_viewer() or (coalesce(current_setting('pulse.agent_session', true), '') <> 'on' and viewer_is('admin')))
$$;

create function pulse.listen_start(p_agent uuid, p_title text, p_purpose text, p_consent boolean) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); s agent_channel_settings; ch uuid; sid uuid;
begin
  if me is null or coalesce(current_setting('pulse.agent_session', true), '') = 'on'
     or not exists (select 1 from person where id = me and org_id = current_org() and status = 'active' and side = 'staff') then
    raise exception 'Use your own Vitals account' using errcode = '42501';
  end if;
  select * into s from agent_channel_settings where org_id = current_org();
  if not coalesce(s.listen_on, false) then raise exception 'Listening is off for this company. An admin can switch it on.' using errcode = '54000'; end if;
  if p_consent is not true then raise exception 'Tell everyone on the call that it is being recorded, then confirm' using errcode = '22023'; end if;
  if coalesce(p_purpose, 'general') not in ('general', 'quotation', 'requirements', 'meeting') then raise exception 'Choose what the call is for' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_title, ''))) not between 1 and 120 then raise exception 'Give the session a short name' using errcode = '22023'; end if;
  if p_agent is not null then
    if not exists (select 1 from agent_member m join person p on p.id = m.person_id
                   where m.org_id = current_org() and m.person_id = p_agent and m.disabled_at is null and p.status = 'active') then
      raise exception 'Choose an active AI employee' using errcode = '22023';
    end if;
    ch := chat_direct(p_agent);
  end if;
  -- One live session per person: starting another stops the earlier one.
  update listen_session set stopped_at = clock_timestamp() where org_id = current_org() and person_id = me and stopped_at is null;
  insert into listen_session (org_id, person_id, agent_id, channel_id, title, purpose, consent_at, purge_after)
  values (current_org(), me, p_agent, ch, btrim(regexp_replace(p_title, '[[:cntrl:]]', ' ', 'g')), coalesce(p_purpose, 'general'), clock_timestamp(),
          clock_timestamp() + make_interval(days => coalesce(s.listen_retention_days, 30)))
  returning id into sid;
  insert into listen_event (org_id, session_id, type, data) values (current_org(), sid, 'listen.started',
    jsonb_build_object('sessionId', sid, 'personId', me, 'agentId', p_agent, 'purpose', coalesce(p_purpose, 'general')));
  return jsonb_build_object('id', sid, 'retentionDays', coalesce(s.listen_retention_days, 30));
end $$;

create function pulse.listen_chunk_add(p_session uuid, p_seq int, p_mime text, p_ms int, p_bytes bytea) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s listen_session;
begin
  select * into s from listen_session where org_id = current_org() and id = p_session;
  if not found or s.person_id is distinct from current_viewer() then raise exception 'Listening session not found' using errcode = 'P0002'; end if;
  if s.stopped_at is not null then raise exception 'This session has stopped' using errcode = '54000'; end if;
  if s.started_at < clock_timestamp() - interval '6 hours' then
    update listen_session set stopped_at = clock_timestamp() where id = s.id;
    raise exception 'A session lasts at most 6 hours. Start a new one.' using errcode = '54000';
  end if;
  if octet_length(coalesce(p_bytes, ''::bytea)) = 0 then return jsonb_build_object('ok', true, 'empty', true); end if;
  insert into pulse_priv.listen_chunk (org_id, session_id, seq, mime, ms, bytes) values (current_org(), s.id, p_seq, p_mime, greatest(0, least(coalesce(p_ms, 0), 120000)), p_bytes)
  on conflict (session_id, seq) do nothing;
  return jsonb_build_object('ok', true);
end $$;

create function pulse.listen_stop(p_session uuid) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s listen_session;
begin
  select * into s from listen_session where org_id = current_org() and id = p_session;
  if not found or s.person_id is distinct from current_viewer() then raise exception 'Listening session not found' using errcode = 'P0002'; end if;
  update listen_session set stopped_at = coalesce(stopped_at, clock_timestamp()) where id = s.id;
  return jsonb_build_object('ok', true);
end $$;

-- The live view: what was heard after a part, the AI employee's replies since the session began, and what is still waiting.
create function pulse.listen_view(p_session uuid, p_after int default -1) returns jsonb
language plpgsql security definer stable set search_path = pulse, pg_temp as $$
declare s listen_session;
begin
  select * into s from listen_session where org_id = current_org() and id = p_session;
  if not found or not listen_can_see(s) then raise exception 'Listening session not found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'id', s.id, 'title', s.title, 'purpose', s.purpose, 'startedAt', s.started_at, 'stoppedAt', s.stopped_at, 'purgeAfter', s.purge_after,
    'live', s.stopped_at is null, 'agentId', s.agent_id, 'agent', (select display_name from person where id = s.agent_id),
    'waiting', (select count(*) from pulse_priv.listen_chunk where session_id = s.id and state in ('queued', 'working')),
    'segments', coalesce((select jsonb_agg(jsonb_build_object('seq', g.seq, 'part', g.part, 'startMs', g.start_ms, 'endMs', g.end_ms, 'text', g.text) order by g.seq, g.part)
       from listen_segment g where g.session_id = s.id and g.seq > coalesce(p_after, -1)), '[]'::jsonb),
    'replies', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'at', m.created_at, 'body', left(m.body, 4000)) order by m.created_at)
       from (select * from chat_message where org_id = current_org() and channel_id = s.channel_id and author_id = s.agent_id
               and created_at >= s.started_at and removed_at is null order by created_at desc limit 20) m), '[]'::jsonb));
end $$;

create function pulse.listen_sessions() returns jsonb
language sql security definer stable set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'purpose', s.purpose, 'startedAt', s.started_at, 'stoppedAt', s.stopped_at,
      'agent', (select display_name from person where id = s.agent_id), 'by', (select display_name from person where id = s.person_id),
      'segments', (select count(*) from listen_segment g where g.session_id = s.id), 'purgeAfter', s.purge_after) order by s.started_at desc), '[]'::jsonb)
  from (select * from listen_session s where s.org_id = current_org() and listen_can_see(s) order by started_at desc limit 30) s
$$;

-- The AI employees a session can be given to (opening the chat with one checks the viewer may message it).
create function pulse.listen_agents() returns jsonb
language sql security definer stable set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name) order by p.display_name), '[]'::jsonb)
    from agent_member m join person p on p.id = m.person_id
   where m.org_id = current_org() and m.disabled_at is null and p.status = 'active' and current_viewer() is not null
$$;

create function pulse.listen_delete(p_session uuid) returns void
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s listen_session;
begin
  select * into s from listen_session where org_id = current_org() and id = p_session;
  if not found or not listen_can_see(s) then raise exception 'Listening session not found' using errcode = 'P0002'; end if;
  delete from listen_session where id = s.id;
end $$;

-- The hook's reader (admins in the app; a worker inside the company).
create function pulse.listen_events(p_after bigint default 0, p_limit int default 100) returns jsonb
language plpgsql security definer stable set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is not null and (coalesce(current_setting('pulse.agent_session', true), '') = 'on' or not viewer_is('admin')) then
    raise exception 'Admins read the listening hook' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('seq', e.seq, 'type', e.type, 'sessionId', e.session_id, 'at', e.at, 'data', e.data) order by e.seq)
    from (select * from listen_event where org_id = current_org() and seq > coalesce(p_after, 0) order by seq limit greatest(1, least(coalesce(p_limit, 100), 500))) e), '[]'::jsonb);
end $$;

-- ---- the transcription worker (tools/listen-transcribe.py)
create function pulse.listen_chunk_claim() returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k pulse_priv.listen_chunk; prev text;
begin
  -- A piece stuck "working" for two minutes (a worker that died) is queued again.
  update pulse_priv.listen_chunk set state = 'queued' where org_id = current_org() and state = 'working' and created_at < clock_timestamp() - interval '2 minutes' and attempts < 3;
  select * into k from pulse_priv.listen_chunk where org_id = current_org() and state = 'queued' order by created_at, seq limit 1 for update skip locked;
  if not found then return null; end if;
  update pulse_priv.listen_chunk set state = 'working', attempts = attempts + 1 where session_id = k.session_id and seq = k.seq;
  select string_agg(text, ' ' order by seq desc, part desc) into prev from (select * from listen_segment where session_id = k.session_id order by seq desc, part desc limit 3) x;
  return jsonb_build_object('sessionId', k.session_id, 'seq', k.seq, 'mime', k.mime, 'ms', k.ms, 'audio', encode(k.bytes, 'base64'), 'before', right(coalesce(prev, ''), 400));
end $$;

create function pulse.listen_chunk_done(p_session uuid, p_seq int, p_segments jsonb, p_error text default null) returns void
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k pulse_priv.listen_chunk; base int; x jsonb; i int := 0;
begin
  select * into k from pulse_priv.listen_chunk where org_id = current_org() and session_id = p_session and seq = p_seq for update;
  if not found then return; end if;
  if p_error is not null then
    update pulse_priv.listen_chunk set state = case when attempts >= 3 then 'failed' else 'queued' end,
      bytes = case when attempts >= 3 then null else bytes end where session_id = k.session_id and seq = k.seq;
    return;
  end if;
  select coalesce(sum(ms), 0) into base from pulse_priv.listen_chunk where session_id = k.session_id and seq < k.seq;
  for x in select * from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) loop
    if coalesce(btrim(x->>'t'), '') <> '' then
      insert into listen_segment (org_id, session_id, seq, part, start_ms, end_ms, text)
      values (current_org(), k.session_id, k.seq, i, base + round(coalesce((x->>'s')::numeric, 0) * 1000)::int, base + round(coalesce((x->>'e')::numeric, 0) * 1000)::int, left(btrim(x->>'t'), 4000))
      on conflict (session_id, seq, part) do nothing;
      i := i + 1;
    end if;
  end loop;
  -- Audio is not kept once it is text.
  update pulse_priv.listen_chunk set state = 'done', bytes = null where session_id = k.session_id and seq = k.seq;
end $$;

-- Hand the new part of each session to its AI employee: at most every 45 seconds while live (once 30 seconds of speech
-- or more is new), and the rest once it stops and every piece is transcribed. Posted in the person's direct chat with
-- the AI employee, as the person, so the AI employee answers with its usual tools and rules. Returns how many were posted.
create function pulse.listen_forward() returns int
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s listen_session; body text; upto int; n int := 0; msg uuid; waiting int; span int; ask text;
begin
  for s in select * from listen_session where org_id = current_org() and final_at is null
             and (stopped_at is null or stopped_at > clock_timestamp() - interval '1 day') order by started_at for update skip locked loop
    select count(*) into waiting from pulse_priv.listen_chunk where session_id = s.id and state in ('queued', 'working');
    select max(seq), coalesce(max(end_ms) - min(start_ms), 0) into upto, span from listen_segment where session_id = s.id and seq > s.forwarded_seq;
    if s.stopped_at is null and (upto is null or span < 30000 or coalesce(s.forwarded_at, s.started_at) > clock_timestamp() - interval '45 seconds') then
      continue;
    end if;
    if s.stopped_at is not null and waiting > 0 and s.stopped_at > clock_timestamp() - interval '10 minutes' then continue; end if;
    if upto is not null and s.channel_id is not null and s.agent_id is not null then
      select string_agg(text, ' ' order by seq, part) into body from listen_segment where session_id = s.id and seq > s.forwarded_seq and seq <= upto;
      ask := case s.purpose
        when 'quotation' then 'This is a client call about a quotation. Draft or update the quotation from what was asked (items, quantities, sizes, budget, dates), list anything still unclear, and create a task for anything promised.'
        when 'requirements' then 'Flag each requirement you hear (what, for whom, by when) and anything that is unclear.'
        when 'meeting' then 'Keep the decisions and action items; create tasks for clear action items with an owner.'
        else 'React only if something needs doing: a task, a reminder, a requirement to flag or a quick answer.' end;
      perform set_config('pulse.viewer_id', s.person_id::text, true);
      msg := chat_send(s.channel_id, left('🎙 Live transcript · ' || s.title || case when s.stopped_at is not null then ' (call ended)' else '' end
        || E'\n\n' || body || E'\n\n' || ask, 11000), null, '[]'::jsonb, gen_random_uuid());
      n := n + 1;
    end if;
    insert into listen_event (org_id, session_id, type, data)
    select current_org(), s.id, 'listen.window', jsonb_build_object('sessionId', s.id, 'agentId', s.agent_id, 'purpose', s.purpose, 'upToSeq', upto, 'messageId', msg)
     where upto is not null;
    update listen_session set forwarded_seq = coalesce(upto, forwarded_seq), forwarded_at = clock_timestamp(),
      final_at = case when stopped_at is not null then clock_timestamp() end where id = s.id;
    if s.stopped_at is not null then
      insert into listen_event (org_id, session_id, type, data) values (current_org(), s.id, 'listen.stopped', jsonb_build_object('sessionId', s.id,
        'personId', s.person_id, 'agentId', s.agent_id, 'purpose', s.purpose, 'title', s.title,
        'segments', (select count(*) from listen_segment where session_id = s.id), 'seconds', (select coalesce(sum(ms), 0) / 1000 from pulse_priv.listen_chunk where session_id = s.id)));
    end if;
    msg := null;
  end loop;
  return n;
end $$;

-- Retention: sessions (their transcript, events and any audio left) go after the company's days; the transcript copies
-- posted to the AI employee's chat are removed with them.
create function pulse.listen_purge() returns int
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare n int;
begin
  update chat_message m set removed_at = clock_timestamp(), removal_reason = 'Listening retention'
    from listen_event e join listen_session s on s.id = e.session_id
   where e.org_id = current_org() and s.purge_after <= clock_timestamp() and e.type = 'listen.window' and (e.data->>'messageId') is not null
     and m.org_id = current_org() and m.id = (e.data->>'messageId')::uuid and m.removed_at is null;
  delete from listen_session where org_id = current_org() and purge_after <= clock_timestamp();
  get diagnostics n = row_count;
  -- A session left live with nothing coming for an hour is stopped.
  update listen_session s set stopped_at = clock_timestamp() where org_id = current_org() and stopped_at is null
     and started_at < clock_timestamp() - interval '1 hour'
     and not exists (select 1 from pulse_priv.listen_chunk k where k.session_id = s.id and k.created_at > clock_timestamp() - interval '1 hour');
  return n;
end $$;

revoke all on function pulse.agent_channels_settings(), pulse.agent_channels_settings_set(jsonb), pulse.agent_channel_heartbeat(text, text),
  pulse.agent_channel_telegram_mode(), pulse.channel_person(text, text), pulse.channel_agent_choices(text, text), pulse.channel_agent_switch(text, text, text),
  pulse.whatsapp_link_begin(text, uuid), pulse.whatsapp_link_status(), pulse.whatsapp_unlink(uuid), pulse.whatsapp_inbound(text, text, text),
  pulse.whatsapp_outbound_claim(int), pulse.channel_outbox_done(uuid, boolean), pulse.listen_can_see(pulse.listen_session),
  pulse.listen_start(uuid, text, text, boolean), pulse.listen_chunk_add(uuid, int, text, int, bytea), pulse.listen_stop(uuid), pulse.listen_view(uuid, int),
  pulse.listen_sessions(), pulse.listen_agents(), pulse.listen_delete(uuid), pulse.listen_events(bigint, int), pulse.listen_chunk_claim(), pulse.listen_chunk_done(uuid, int, jsonb, text),
  pulse.listen_forward(), pulse.listen_purge() from public;
grant execute on function pulse.agent_channels_settings(), pulse.agent_channels_settings_set(jsonb), pulse.whatsapp_link_begin(text, uuid),
  pulse.whatsapp_link_status(), pulse.whatsapp_unlink(uuid), pulse.listen_can_see(pulse.listen_session), pulse.listen_start(uuid, text, text, boolean),
  pulse.listen_chunk_add(uuid, int, text, int, bytea), pulse.listen_stop(uuid), pulse.listen_view(uuid, int), pulse.listen_sessions(),
  pulse.listen_agents(), pulse.listen_delete(uuid), pulse.listen_events(bigint, int), pulse.agent_channel_telegram_mode() to pulse_api;
-- The WhatsApp webhook runs in the API (after Meta's signature check), inside the company the number belongs to.
grant execute on function pulse.whatsapp_inbound(text, text, text) to pulse_api, pulse_worker;
grant execute on function pulse.agent_channel_heartbeat(text, text), pulse.agent_channel_telegram_mode(), pulse.channel_person(text, text),
  pulse.channel_agent_choices(text, text), pulse.channel_agent_switch(text, text, text), pulse.whatsapp_outbound_claim(int),
  pulse.channel_outbox_done(uuid, boolean), pulse.listen_can_see(pulse.listen_session), pulse.listen_events(bigint, int), pulse.listen_chunk_claim(),
  pulse.listen_chunk_done(uuid, int, jsonb, text), pulse.listen_forward(), pulse.listen_purge() to pulse_worker;

-- migrate:down
drop function if exists pulse.listen_agents(), pulse.listen_purge(), pulse.listen_forward(), pulse.listen_chunk_done(uuid, int, jsonb, text), pulse.listen_chunk_claim(),
  pulse.listen_events(bigint, int), pulse.listen_delete(uuid), pulse.listen_sessions(), pulse.listen_view(uuid, int), pulse.listen_stop(uuid),
  pulse.listen_chunk_add(uuid, int, text, int, bytea), pulse.listen_start(uuid, text, text, boolean), pulse.listen_can_see(pulse.listen_session),
  pulse.channel_outbox_done(uuid, boolean), pulse.whatsapp_outbound_claim(int), pulse.whatsapp_inbound(text, text, text), pulse.whatsapp_unlink(uuid),
  pulse.whatsapp_link_status(), pulse.whatsapp_link_begin(text, uuid), pulse.channel_agent_switch(text, text, text), pulse.channel_agent_choices(text, text),
  pulse.channel_person(text, text), pulse.agent_channel_telegram_mode(), pulse.agent_channel_heartbeat(text, text), pulse.agent_channels_settings_set(jsonb),
  pulse.agent_channels_settings();
drop trigger if exists listen_event_notify on pulse.listen_event;
drop function if exists pulse.listen_event_notify();
drop table if exists pulse.listen_event, pulse.listen_segment, pulse_priv.listen_chunk, pulse.listen_session, pulse_priv.channel_outbox,
  pulse_priv.whatsapp_agent_link, pulse.agent_channel_settings;
alter table pulse_priv.telegram_link_code drop column if exists channel;
