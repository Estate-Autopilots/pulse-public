-- migrate:up
-- CHAT-V5 (owner, 24 Oct 2026: "chat mode needs a far greater upgrade"): later.
--   reminders  chat_reminder: "remind me about this message in 1 hour / tomorrow 9 am / at a time I pick". When it is due
--              the person gets a notification (bell and push) and the conversation is marked unread for them with a
--              reminder chip on its row (the chat nudge), until they open it. Mine alone: nobody else sees it.
--   scheduled  chat_scheduled: a message written now and sent at a chosen time, as its author (through chat_send, so the
--              author must still be in the conversation then). Until it goes, its author edits, sends now or cancels it.
-- chat_due() delivers what is due in the current company; the API calls it every few seconds for each active company.
-- Additive: two new tables with row security, new functions. Uses only objects defined in this repository.

create table pulse.chat_reminder (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references pulse.person(id),
  message_id uuid not null,
  channel_id uuid not null,
  due_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  fired_at timestamptz,
  seen_at timestamptz,
  cancelled_at timestamptz,
  foreign key (org_id, message_id) references pulse.chat_message(org_id, id) on delete cascade,
  foreign key (org_id, channel_id) references pulse.chat_channel(org_id, id) on delete cascade
);
create index chat_reminder_due on pulse.chat_reminder (org_id, due_at) where fired_at is null and cancelled_at is null;
create index chat_reminder_message on pulse.chat_reminder (org_id, message_id);
create index chat_reminder_person on pulse.chat_reminder (org_id, person_id, channel_id) where cancelled_at is null;
alter table pulse.chat_reminder enable row level security;
alter table pulse.chat_reminder force row level security;
create policy tenant_isolation on pulse.chat_reminder using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy own_rows on pulse.chat_reminder as restrictive for all to pulse_api using (person_id = pulse.current_viewer()) with check (person_id = pulse.current_viewer());
grant select on pulse.chat_reminder to pulse_api;

create table pulse.chat_scheduled (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null,
  author_id uuid not null references pulse.person(id),
  body text not null,
  attachments jsonb not null default '[]'::jsonb,
  quote_id uuid,
  parent_id uuid,
  client_id uuid not null default gen_random_uuid(),
  send_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  sent_at timestamptz,
  message_id uuid,
  cancelled_at timestamptz,
  failed_at timestamptz,
  error text,
  foreign key (org_id, channel_id) references pulse.chat_channel(org_id, id) on delete cascade
);
create index chat_scheduled_due on pulse.chat_scheduled (org_id, send_at) where sent_at is null and cancelled_at is null and failed_at is null;
create index chat_scheduled_mine on pulse.chat_scheduled (org_id, author_id, channel_id) where sent_at is null and cancelled_at is null;
alter table pulse.chat_scheduled enable row level security;
alter table pulse.chat_scheduled force row level security;
create policy tenant_isolation on pulse.chat_scheduled using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy own_rows on pulse.chat_scheduled as restrictive for all to pulse_api using (author_id = pulse.current_viewer()) with check (author_id = pulse.current_viewer());
grant select on pulse.chat_scheduled to pulse_api;

-- Mine: remind me about a message (one waiting reminder per message: a new time replaces the old one).
create function pulse.chat_remind(p_message uuid, p_at timestamptz) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare cid uuid; rid uuid;
begin
  cid := chat_member_message(p_message);
  if p_at is null or p_at < clock_timestamp() + interval '30 seconds' or p_at > clock_timestamp() + interval '366 days' then
    raise exception 'choose a time ahead, within a year' using errcode = '22023'; end if;
  update chat_reminder set cancelled_at = clock_timestamp()
  where org_id = current_org() and person_id = current_viewer() and message_id = p_message and fired_at is null and cancelled_at is null;
  if (select count(*) from chat_reminder where org_id = current_org() and person_id = current_viewer() and fired_at is null and cancelled_at is null) >= 200 then
    raise exception 'you have 200 reminders waiting; clear some first' using errcode = '22023'; end if;
  insert into chat_reminder(org_id, person_id, message_id, channel_id, due_at) values (current_org(), current_viewer(), p_message, cid, p_at) returning id into rid;
  return rid;
end $$;

create function pulse.chat_remind_cancel(p_id uuid) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  update chat_reminder set cancelled_at = clock_timestamp()
  where org_id = current_org() and id = p_id and person_id = current_viewer() and cancelled_at is null and (fired_at is null or seen_at is null);
  if not found then raise exception 'reminder unavailable' using errcode = '22023'; end if;
end $$;

-- Opening the conversation (or reading it) clears its reminder chips.
create function pulse.chat_reminders_seen(p_channel uuid) returns void language sql security definer set search_path = pulse, pg_temp as $$
  update chat_reminder set seen_at = clock_timestamp()
  where org_id = current_org() and person_id = current_viewer() and channel_id = p_channel and fired_at is not null and seen_at is null and cancelled_at is null
$$;

-- A message to send later, as me, in a conversation I am a member of.
create function pulse.chat_schedule_check(p_body text, p_attachments jsonb, p_at timestamptz) returns void language plpgsql immutable as $$
begin
  if p_body is null or p_attachments is null or length(trim(p_body)) > 12000 or jsonb_typeof(p_attachments) <> 'array' or jsonb_array_length(p_attachments) > 5
     or (trim(p_body) = '' and jsonb_array_length(p_attachments) = 0) then
    raise exception 'write a message or attach a file' using errcode = '22023'; end if;
  if p_at is null then raise exception 'choose when to send it' using errcode = '22023'; end if;
end $$;

create function pulse.chat_schedule(p_channel uuid, p_body text, p_attachments jsonb, p_quote uuid, p_parent uuid, p_at timestamptz) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare sid uuid;
begin
  if not chat_active() or not exists(select 1 from chat_member where org_id = current_org() and channel_id = p_channel and person_id = current_viewer()) then
    raise exception 'conversation unavailable' using errcode = '42501'; end if;
  perform chat_schedule_check(p_body, p_attachments, p_at);
  if p_at < clock_timestamp() + interval '30 seconds' or p_at > clock_timestamp() + interval '366 days' then
    raise exception 'choose a time ahead, within a year' using errcode = '22023'; end if;
  if (select count(*) from chat_scheduled where org_id = current_org() and author_id = current_viewer() and sent_at is null and cancelled_at is null and failed_at is null) >= 100 then
    raise exception 'you have 100 messages waiting to send; send or cancel some first' using errcode = '22023'; end if;
  insert into chat_scheduled(org_id, channel_id, author_id, body, attachments, quote_id, parent_id, send_at)
  values (current_org(), p_channel, current_viewer(), trim(p_body), p_attachments, p_quote, p_parent, p_at) returning id into sid;
  return sid;
end $$;

-- Change the words or the time of one still waiting (a failed one goes back to waiting with a new time).
create function pulse.chat_schedule_edit(p_id uuid, p_body text, p_at timestamptz) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s chat_scheduled%rowtype;
begin
  select * into s from chat_scheduled where org_id = current_org() and id = p_id and author_id = current_viewer() and sent_at is null and cancelled_at is null for update;
  if not found then raise exception 'that message has already gone or was cancelled' using errcode = '22023'; end if;
  perform chat_schedule_check(coalesce(p_body, s.body), s.attachments, coalesce(p_at, s.send_at));
  if p_at is not null and (p_at < clock_timestamp() + interval '30 seconds' or p_at > clock_timestamp() + interval '366 days') then
    raise exception 'choose a time ahead, within a year' using errcode = '22023'; end if;
  update chat_scheduled set body = trim(coalesce(p_body, body)), send_at = coalesce(p_at, send_at), updated_at = clock_timestamp(),
    failed_at = null, error = null, client_id = case when failed_at is null then client_id else gen_random_uuid() end
  where id = p_id;
end $$;

-- Cancel one still waiting, or send it now (the API then delivers what is due at once).
create function pulse.chat_schedule_cancel(p_id uuid, p_now boolean default false) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if p_now then
    update chat_scheduled set send_at = clock_timestamp(), failed_at = null, error = null, updated_at = clock_timestamp(),
      client_id = case when failed_at is null then client_id else gen_random_uuid() end
    where org_id = current_org() and id = p_id and author_id = current_viewer() and sent_at is null and cancelled_at is null;
  else
    update chat_scheduled set cancelled_at = clock_timestamp()
    where org_id = current_org() and id = p_id and author_id = current_viewer() and sent_at is null and cancelled_at is null;
  end if;
  if not found then raise exception 'that message has already gone or was cancelled' using errcode = '22023'; end if;
end $$;

-- What is due in this company: reminders ring (a notification, the conversation marked unread with a chip), messages
-- go out as their authors. Safe to call from several processes (rows are claimed with skip locked). Returns how many.
create function pulse.chat_due() returns integer language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r record; n integer := 0; mid uuid;
  was_viewer text := coalesce(current_setting('pulse.viewer_id', true), '');
  was_actor text := coalesce(current_setting('pulse.actor_account', true), '');
begin
  if current_org() is null then return 0; end if;
  for r in select * from chat_reminder where org_id = current_org() and fired_at is null and cancelled_at is null and due_at <= clock_timestamp()
           order by due_at limit 200 for update skip locked loop
    if exists(select 1 from chat_member cm join person p on p.id = cm.person_id where cm.channel_id = r.channel_id and cm.person_id = r.person_id and p.status = 'active')
       and exists(select 1 from chat_message m where m.id = r.message_id and m.removed_at is null) then
      insert into notification(org_id, person_id, title, href, kind, channel_id, event_type, subject_type, subject_id, event_key)
      select r.org_id, r.person_id, 'Reminder: ' || coalesce(nullif(left(regexp_replace(m.body, '\s+', ' ', 'g'), 120), ''), 'a message in Chats'),
        '/chats?channel=' || r.channel_id || '&message=' || r.message_id || case when m.parent_id is null then '' else '&thread=' || m.parent_id end,
        'reminder', r.channel_id, 'chat.mention', 'message', r.message_id, 'reminder:' || r.id
      from chat_message m where m.id = r.message_id
      on conflict do nothing;
      update chat_member set marked_unread_at = clock_timestamp() where org_id = current_org() and channel_id = r.channel_id and person_id = r.person_id;
      insert into chat_event(org_id, channel_id) values (current_org(), r.channel_id);
    end if;
    update chat_reminder set fired_at = clock_timestamp() where id = r.id;
    n := n + 1;
  end loop;
  for r in select * from chat_scheduled where org_id = current_org() and sent_at is null and cancelled_at is null and failed_at is null and send_at <= clock_timestamp()
           order by send_at limit 100 for update skip locked loop
    begin
      perform set_config('pulse.viewer_id', r.author_id::text, true);
      perform set_config('pulse.actor_account', '', true);
      mid := chat_send(r.channel_id, r.body, r.parent_id, r.attachments, r.client_id, r.quote_id);
      update chat_scheduled set sent_at = clock_timestamp(), message_id = mid where id = r.id;
    exception when others then
      update chat_scheduled set failed_at = clock_timestamp(), error = left(sqlerrm, 300) where id = r.id;
    end;
    perform set_config('pulse.viewer_id', was_viewer, true);
    perform set_config('pulse.actor_account', was_actor, true);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function pulse.chat_remind(uuid, timestamptz), pulse.chat_remind_cancel(uuid), pulse.chat_reminders_seen(uuid),
  pulse.chat_schedule_check(text, jsonb, timestamptz), pulse.chat_schedule(uuid, text, jsonb, uuid, uuid, timestamptz),
  pulse.chat_schedule_edit(uuid, text, timestamptz), pulse.chat_schedule_cancel(uuid, boolean), pulse.chat_due() from public;
grant execute on function pulse.chat_remind(uuid, timestamptz), pulse.chat_remind_cancel(uuid), pulse.chat_reminders_seen(uuid),
  pulse.chat_schedule(uuid, text, jsonb, uuid, uuid, timestamptz), pulse.chat_schedule_edit(uuid, text, timestamptz),
  pulse.chat_schedule_cancel(uuid, boolean), pulse.chat_due() to pulse_api;

-- migrate:down
drop function if exists pulse.chat_due(), pulse.chat_schedule_cancel(uuid, boolean), pulse.chat_schedule_edit(uuid, text, timestamptz),
  pulse.chat_schedule(uuid, text, jsonb, uuid, uuid, timestamptz), pulse.chat_schedule_check(text, jsonb, timestamptz),
  pulse.chat_reminders_seen(uuid), pulse.chat_remind_cancel(uuid), pulse.chat_remind(uuid, timestamptz);
drop table if exists pulse.chat_scheduled;
drop table if exists pulse.chat_reminder;
