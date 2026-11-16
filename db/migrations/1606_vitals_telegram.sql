-- migrate:up
-- ONBOARD-CHECKIN-TG (6 Nov 2026): the Vitals OS Telegram bot (services/workers/src/pulse_workers/vitals_bot.py).
-- * Each person links their own Telegram from Settings -> Notifications with a one-time code: the API makes the code and
--   stores only its sha256 here; the person sends /start <code> to the bot (a t.me deep link does it in one tap); the bot
--   redeems it inside the code's company. Before this, only an admin could connect a person by typing a chat ID (0018).
-- * A person can also attach Telegram to an AI employee: what they write to the bot goes into their own direct chat with
--   that AI employee, as them (chat_send), and the AI employee's replies in that chat come back to Telegram.
-- * The bot's buttons (Done, Approve, Snooze) act as the linked person through the same functions the app uses
--   (task_move, hr_flow_decide), so every rule of the app still applies; the chat must be the person's linked chat.
-- Nothing here sends anything: the bot runs only with VITALS_TELEGRAM_BOT_TOKEN set (docs/ops/TELEGRAM-BOT.md).

alter table pulse_priv.telegram_person
  add column if not exists via text not null default 'admin' check (via in ('admin','self')),
  add column if not exists username text check (username is null or username ~ '^[A-Za-z0-9_]{3,40}$');

create table pulse_priv.telegram_link_code (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  person_id uuid not null references pulse.person(id),
  agent_id uuid references pulse.person(id),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp() + interval '15 minutes',
  used_at timestamptz
);
create index telegram_link_code_person on pulse_priv.telegram_link_code(org_id, person_id, created_at);
alter table pulse_priv.telegram_link_code enable row level security;
alter table pulse_priv.telegram_link_code force row level security;
create policy tenant_isolation on pulse_priv.telegram_link_code using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

create table pulse_priv.telegram_agent_link (
  org_id uuid not null references pulse.org(id),
  person_id uuid not null references pulse.person(id),
  agent_id uuid not null references pulse.person(id),
  chat_id text not null check (chat_id ~ '^[1-9][0-9]{4,15}$'),
  channel_id uuid not null,
  linked_at timestamptz not null default clock_timestamp(),
  relayed_until timestamptz not null default clock_timestamp(),
  primary key (org_id, person_id, agent_id),
  -- One Telegram chat talks to one AI employee at a time in a company; linking another one moves the chat over.
  unique (org_id, chat_id)
);
alter table pulse_priv.telegram_agent_link enable row level security;
alter table pulse_priv.telegram_agent_link force row level security;
create policy tenant_isolation on pulse_priv.telegram_agent_link using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create trigger audit_mutation after insert or update or delete on pulse_priv.telegram_agent_link for each row execute function pulse.audit_mutation();

-- The viewer starts a link (for themself, or for one AI employee they can message). The API made the code and passes its
-- hash; at most 10 codes an hour per person; a new code ends the person's earlier open codes for the same target.
create function pulse.telegram_link_begin(p_hash text, p_agent uuid default null) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); exp timestamptz;
begin
  if me is null or not exists (select 1 from person where id = me and org_id = current_org() and status = 'active' and side = 'staff') then
    raise exception 'Use your own Vitals account' using errcode = '42501';
  end if;
  if p_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid code' using errcode = '22023'; end if;
  if p_agent is not null then
    if not exists (select 1 from agent_member m join person p on p.id = m.person_id
                   where m.org_id = current_org() and m.person_id = p_agent and m.disabled_at is null and p.status = 'active') then
      raise exception 'Choose an active AI employee' using errcode = '22023';
    end if;
    perform chat_direct(p_agent); -- the same check as opening a chat with it in the app
  end if;
  if (select count(*) from pulse_priv.telegram_link_code where org_id = current_org() and person_id = me and created_at > clock_timestamp() - interval '1 hour') >= 10 then
    raise exception 'Too many link codes. Try again in an hour.' using errcode = '54000';
  end if;
  update pulse_priv.telegram_link_code set used_at = clock_timestamp()
   where org_id = current_org() and person_id = me and agent_id is not distinct from p_agent and used_at is null;
  insert into pulse_priv.telegram_link_code (org_id, person_id, agent_id, code_hash) values (current_org(), me, p_agent, p_hash)
  returning expires_at into exp;
  return jsonb_build_object('expiresAt', exp);
end $$;

-- The bot redeems a code (inside the company it belongs to: the worker tries each company in turn).
create function pulse.telegram_link_redeem(p_hash text, p_chat text, p_username text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k pulse_priv.telegram_link_code; who person; ch uuid; agent_name text;
begin
  if p_hash !~ '^[0-9a-f]{64}$' or p_chat !~ '^[1-9][0-9]{4,15}$' then return null; end if;
  select * into k from pulse_priv.telegram_link_code where org_id = current_org() and code_hash = p_hash for update;
  if not found then return null; end if;
  if k.used_at is not null or k.expires_at <= clock_timestamp() then return jsonb_build_object('error', 'expired'); end if;
  update pulse_priv.telegram_link_code set used_at = clock_timestamp() where id = k.id;
  select * into who from person where id = k.person_id and org_id = current_org() and status = 'active';
  if not found then return jsonb_build_object('error', 'inactive'); end if;
  if k.agent_id is null then
    if exists (select 1 from pulse_priv.telegram_person where org_id = current_org() and chat_id = p_chat and person_id <> k.person_id) then
      return jsonb_build_object('error', 'chat_taken');
    end if;
    insert into pulse_priv.telegram_person (org_id, person_id, chat_id, verified_by, verified_at, via, username)
    values (current_org(), k.person_id, p_chat, k.person_id, clock_timestamp(), 'self', nullif(substr(coalesce(p_username, ''), 1, 40), ''))
    on conflict (org_id, person_id) do update set chat_id = excluded.chat_id, verified_by = excluded.verified_by,
      verified_at = excluded.verified_at, via = 'self', username = excluded.username;
    update notification set telegram_status = 'queued' where person_id = k.person_id and telegram_status = 'recipient_not_connected'
      and created_at > clock_timestamp() - interval '1 day';
    return jsonb_build_object('kind', 'person', 'name', split_part(who.display_name, ' ', 1));
  end if;
  -- As the person: their direct chat with the AI employee (chat_direct checks they may open it).
  perform set_config('pulse.viewer_id', k.person_id::text, true);
  ch := chat_direct(k.agent_id);
  select display_name into agent_name from person where id = k.agent_id;
  delete from pulse_priv.telegram_agent_link where org_id = current_org() and chat_id = p_chat;
  insert into pulse_priv.telegram_agent_link (org_id, person_id, agent_id, chat_id, channel_id)
  values (current_org(), k.person_id, k.agent_id, p_chat, ch)
  on conflict (org_id, person_id, agent_id) do update set chat_id = excluded.chat_id, channel_id = excluded.channel_id,
    linked_at = clock_timestamp(), relayed_until = clock_timestamp();
  return jsonb_build_object('kind', 'agent', 'name', split_part(who.display_name, ' ', 1), 'agent', agent_name);
end $$;

-- What the viewer has linked (Settings -> Notifications, the AI employee's page).
create function pulse.telegram_link_status() returns jsonb
language plpgsql security definer stable set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer();
begin
  return jsonb_build_object(
    'linked', exists (select 1 from pulse_priv.telegram_person where org_id = current_org() and person_id = me),
    'username', (select username from pulse_priv.telegram_person where org_id = current_org() and person_id = me),
    'at', (select verified_at from pulse_priv.telegram_person where org_id = current_org() and person_id = me),
    'via', (select via from pulse_priv.telegram_person where org_id = current_org() and person_id = me),
    'agents', coalesce((select jsonb_agg(jsonb_build_object('agentId', l.agent_id, 'name', p.display_name, 'at', l.linked_at) order by l.linked_at)
       from pulse_priv.telegram_agent_link l join person p on p.id = l.agent_id where l.org_id = current_org() and l.person_id = me), '[]'::jsonb));
end $$;

create function pulse.telegram_unlink(p_agent uuid default null) returns void
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer();
begin
  if me is null then raise exception 'Use your own Vitals account' using errcode = '42501'; end if;
  if p_agent is null then
    delete from pulse_priv.telegram_person where org_id = current_org() and person_id = me;
    update notification set telegram_status = 'recipient_not_connected' where person_id = me and telegram_status in ('queued', 'failed');
    delete from pulse_priv.telegram_agent_link where org_id = current_org() and person_id = me;
  else
    delete from pulse_priv.telegram_agent_link where org_id = current_org() and person_id = me and agent_id = p_agent;
  end if;
end $$;

-- The bot: who a private chat belongs to in this company (null: nobody).
create function pulse.telegram_chat_person(p_chat text) returns uuid
language sql security definer stable set search_path = pulse, pg_temp as $$
  select person_id from pulse_priv.telegram_person t join person p on p.id = t.person_id and p.status = 'active'
   where t.org_id = current_org() and t.chat_id = p_chat
$$;

-- The bot's buttons, as the chat's own person: done (a task), approve (an HR request waiting for them), snooze (an hour),
-- read. Each checks the notification is theirs; the app's own functions decide whether the action is allowed.
create function pulse.telegram_act(p_chat text, p_notification uuid, p_verb text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := telegram_chat_person(p_chat); n notification;
begin
  if me is null then return jsonb_build_object('ok', false, 'message', 'This Telegram is not linked. Link it in Settings → Notifications.'); end if;
  select * into n from notification where org_id = current_org() and id = p_notification and person_id = me;
  if not found then return jsonb_build_object('ok', false, 'message', 'That update is no longer here.'); end if;
  perform set_config('pulse.viewer_id', me::text, true);
  if p_verb = 'snooze' then
    update notification set snoozed_until = clock_timestamp() + interval '1 hour' where id = n.id;
    return jsonb_build_object('ok', true, 'message', 'Snoozed for an hour.');
  elsif p_verb = 'read' then
    update notification set read_at = coalesce(read_at, clock_timestamp()) where id = n.id;
    return jsonb_build_object('ok', true, 'message', 'Marked as read.');
  elsif p_verb = 'done' and n.subject_type = 'task' and n.subject_id is not null then
    perform task_move(n.subject_id, 'done', 'Marked done from Telegram');
    update notification set read_at = coalesce(read_at, clock_timestamp()) where id = n.id;
    return jsonb_build_object('ok', true, 'message', 'Marked done.');
  elsif p_verb = 'approve' and n.subject_type = 'hr_flow' and n.subject_id is not null and n.event_type in ('approval.waiting', 'approval.reminder') then
    perform hr_flow_decide(n.subject_id, 'approve', 'Approved from Telegram');
    update notification set read_at = coalesce(read_at, clock_timestamp()) where id = n.id;
    return jsonb_build_object('ok', true, 'message', 'Approved.');
  end if;
  return jsonb_build_object('ok', false, 'message', 'Open it in Vitals to do that.');
exception when others then
  return jsonb_build_object('ok', false, 'message', 'Vitals could not do that here. Open it in Vitals.');
end $$;

-- True when an urgent update waits for Telegram (the bot sends those at once; the rest go in the next digest).
create function pulse.telegram_urgent_waiting() returns boolean
language sql security definer stable set search_path = pulse, pg_temp as $$
  select exists (select 1 from notification_delivery d join notification n on n.id = d.notification_id
    where d.org_id = current_org() and d.channel = 'telegram' and d.status = 'queued' and n.priority = 'urgent')
$$;

-- A message from a chat attached to an AI employee: into the person's direct chat with it, as them.
create function pulse.telegram_agent_inbound(p_chat text, p_text text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare l pulse_priv.telegram_agent_link; agent_name text;
begin
  select * into l from pulse_priv.telegram_agent_link where org_id = current_org() and chat_id = p_chat;
  if not found or coalesce(btrim(p_text), '') = '' then return null; end if;
  if not exists (select 1 from person where id = l.person_id and status = 'active') then return null; end if;
  perform set_config('pulse.viewer_id', l.person_id::text, true);
  perform chat_send(l.channel_id, left(p_text, 4000), null, '[]'::jsonb, gen_random_uuid());
  update pulse_priv.telegram_agent_link set relayed_until = greatest(relayed_until, clock_timestamp()) where org_id = l.org_id and person_id = l.person_id and agent_id = l.agent_id;
  select display_name into agent_name from person where id = l.agent_id;
  return jsonb_build_object('agent', agent_name);
end $$;

-- The AI employees' new replies for their Telegram chats (and the cursor moves past them).
create function pulse.telegram_agent_outbound() returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare out jsonb := '[]'::jsonb; l pulse_priv.telegram_agent_link; rows jsonb; last timestamptz;
begin
  for l in select * from pulse_priv.telegram_agent_link where org_id = current_org() loop
    select jsonb_agg(jsonb_build_object('chatId', l.chat_id, 'agent', p.display_name, 'body', left(m.body, 3500)) order by m.created_at), max(m.created_at)
      into rows, last
      from (select * from chat_message where org_id = current_org() and channel_id = l.channel_id and author_id = l.agent_id
              and created_at > l.relayed_until and removed_at is null and coalesce(btrim(body), '') <> '' order by created_at limit 10) m
      join person p on p.id = l.agent_id;
    if rows is not null then
      out := out || rows;
      update pulse_priv.telegram_agent_link set relayed_until = last where org_id = l.org_id and person_id = l.person_id and agent_id = l.agent_id;
    end if;
  end loop;
  return out;
end $$;

revoke all on function pulse.telegram_link_begin(text, uuid), pulse.telegram_link_status(), pulse.telegram_unlink(uuid),
  pulse.telegram_link_redeem(text, text, text), pulse.telegram_chat_person(text), pulse.telegram_act(text, uuid, text),
  pulse.telegram_urgent_waiting(), pulse.telegram_agent_inbound(text, text), pulse.telegram_agent_outbound() from public;
grant execute on function pulse.telegram_link_begin(text, uuid), pulse.telegram_link_status(), pulse.telegram_unlink(uuid) to pulse_api;
grant execute on function pulse.telegram_link_redeem(text, text, text), pulse.telegram_chat_person(text), pulse.telegram_act(text, uuid, text),
  pulse.telegram_urgent_waiting(), pulse.telegram_agent_inbound(text, text), pulse.telegram_agent_outbound() to pulse_worker;

-- migrate:down
drop function if exists pulse.telegram_agent_outbound(), pulse.telegram_agent_inbound(text, text), pulse.telegram_urgent_waiting(),
  pulse.telegram_act(text, uuid, text), pulse.telegram_chat_person(text), pulse.telegram_unlink(uuid), pulse.telegram_link_status(),
  pulse.telegram_link_redeem(text, text, text), pulse.telegram_link_begin(text, uuid);
drop table if exists pulse_priv.telegram_agent_link;
drop table if exists pulse_priv.telegram_link_code;
alter table pulse_priv.telegram_person drop column if exists username, drop column if exists via;
